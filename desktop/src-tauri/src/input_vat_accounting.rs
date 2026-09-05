//! Accounting counterpart of purchase VAT classifications. Original postings stay immutable.
use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::json;
use uuid::Uuid;

use crate::{
    accounting::{post_entry, EntryLine},
    audit::append_audit,
    database::now_iso,
    error::{AppError, AppResult},
};

const SOURCE: &str = "vat_input_reclassification";

/// Dated profiles preserve a past registration after the current company setting changes.
pub(crate) fn registered_for_purchase_date(connection: &Connection, date: &str) -> AppResult<bool> {
    connection.query_row(
        "SELECT vat_registered OR EXISTS(SELECT 1 FROM vat_profiles WHERE effective_from<=?1 AND COALESCE(effective_to,'9999-12-31')>=?1) FROM settings WHERE id=1",
        params![date], |row| row.get(0),
    ).map_err(Into::into)
}

/// A later change to the current setting cannot override a recorded historical decision.
/// Correcting that decision requires a registration profile covering the purchase date.
pub(crate) fn purchase_input_deduction_permitted(
    connection: &Connection,
    source_type: &str,
    source_id: &str,
    date: &str,
) -> AppResult<bool> {
    if !registered_for_purchase_date(connection, date)? {
        return Ok(false);
    }
    connection.query_row(
        "SELECT NOT EXISTS(SELECT 1 FROM audit_log WHERE action='classify_non_registered_purchase' AND entity_type=?1 AND entity_id=?2) OR EXISTS(SELECT 1 FROM vat_profiles WHERE effective_from<=?3 AND COALESCE(effective_to,'9999-12-31')>=?3)",
        params![source_type, source_id, date], |row| row.get(0),
    ).map_err(Into::into)
}

/// Record the non-recoverable treatment with the original posting, in the same transaction.
/// Keeping this decision avoids changing old costs merely by enabling VAT registration later.
pub(crate) fn classify_non_registered_at_posting(
    tx: &Transaction<'_>,
    source_type: &str,
    source_id: &str,
    date: &str,
) -> AppResult<()> {
    if registered_for_purchase_date(tx, date)? {
        return Ok(());
    }
    let previous: Option<String> = tx
        .query_row(
            "SELECT treatment FROM vat_source_classifications WHERE source_type=? AND source_id=?",
            params![source_type, source_id],
            |row| row.get(0),
        )
        .optional()?;
    let now = now_iso();
    let note = "TVA fournisseur comprise dans le coût : entreprise non assujettie lors de la comptabilisation, sans profil TVA couvrant cette date.";
    if previous.as_deref() != Some("non_deductible") {
        tx.execute(
        "INSERT INTO vat_source_classifications(id,source_type,source_id,treatment,note,created_at,updated_at) VALUES(?,?,?,'non_deductible',?,?,?) ON CONFLICT(source_type,source_id) DO UPDATE SET treatment='non_deductible',note=excluded.note,updated_at=excluded.updated_at",
        params![Uuid::new_v4().to_string(),source_type,source_id,note,now,now],
    )?;
    }
    append_audit(
        tx,
        "classify_non_registered_purchase",
        source_type,
        source_id,
        &json!({"treatment":"non_deductible","previous_treatment":previous,"date":date,"note":note}),
    )?;
    Ok(())
}

struct PurchasePosting {
    journal_id: String,
    date: String,
    currency: String,
    vat_cents: i64,
    document_vat_cents: i64,
    expense_account: String,
    project_id: Option<String>,
}

fn posting(
    tx: &Transaction<'_>,
    source_type: &str,
    source_id: &str,
) -> AppResult<Option<PurchasePosting>> {
    let sql = match source_type {
        "supplier_invoice_item" => "SELECT entry.id,entry.entry_date,invoice.currency,line.line_vat_cents,invoice.vat_cents,line.posted_expense_account_id,COALESCE(line.project_id,invoice.project_id)
            FROM supplier_invoice_items line JOIN supplier_invoices invoice ON invoice.id=line.supplier_invoice_id
            JOIN journal_entries entry ON entry.id=invoice.validation_journal_entry_id
            WHERE line.id=? AND invoice.status='validated'",
        "expense" => "SELECT entry.id,entry.entry_date,expense.currency,expense.vat_cents,expense.vat_cents,
            (SELECT line.account_id FROM journal_lines line WHERE line.journal_entry_id=entry.id AND line.memo='Charge' AND line.debit_cents=expense.net_cents AND line.credit_cents=0),expense.project_id
            FROM expenses expense JOIN journal_entries entry ON entry.source_type='expense' AND entry.source_id=expense.id AND entry.source_event='create'
            WHERE expense.id=? AND expense.payment_status='paid'",
        "supplier_credit_note_item" => "SELECT entry.id,entry.entry_date,credit.currency,-line.line_vat_cents,-credit.vat_cents,
            COALESCE(line.posted_expense_account_id,(SELECT CASE WHEN COUNT(DISTINCT posted.account_id)=1 THEN MIN(posted.account_id) END FROM journal_lines posted JOIN accounts account ON account.id=posted.account_id WHERE posted.journal_entry_id=entry.id AND posted.memo=line.description AND posted.credit_cents=line.line_net_cents AND posted.debit_cents=0 AND account.account_type='expense')),line.project_id
            FROM supplier_credit_note_items line JOIN supplier_credit_notes credit ON credit.id=line.supplier_credit_note_id
            JOIN journal_entries entry ON entry.id=credit.validation_journal_entry_id
            WHERE line.id=? AND credit.status='validated'",
        _ => return Ok(None),
    };
    tx.query_row(sql, params![source_id], |row| {
        Ok(PurchasePosting {
            journal_id: row.get(0)?,
            date: row.get(1)?,
            currency: row.get(2)?,
            vat_cents: row.get(3)?,
            document_vat_cents: row.get(4)?,
            expense_account: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            project_id: row.get(6)?,
        })
    })
    .optional()
    .map_err(Into::into)
}

fn add(
    balance: &mut BTreeMap<(String, String), i64>,
    date: &str,
    account: &str,
    amount: i64,
) -> AppResult<()> {
    let value = balance
        .entry((date.to_owned(), account.to_owned()))
        .or_default();
    *value = value.checked_add(amount).ok_or_else(|| {
        AppError::Validation("La correction de TVA dépasse la capacité monétaire.".into())
    })?;
    Ok(())
}

/// Return the number of newly posted journal entries. Repeated decisions produce no extra entries.
pub(crate) fn sync_source(
    tx: &Transaction<'_>,
    source_type: &str,
    source_id: &str,
) -> AppResult<usize> {
    let Some(source) = posting(tx, source_type, source_id)? else {
        return Ok(0);
    };
    if source.vat_cents == 0 {
        return Ok(0);
    }
    let treatment: Option<String> = tx
        .query_row(
            "SELECT treatment FROM vat_source_classifications WHERE source_type=? AND source_id=?",
            params![source_type, source_id],
            |row| row.get(0),
        )
        .optional()?;
    let simple_method: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM vat_profiles WHERE effective_from<=?1 AND COALESCE(effective_to,'9999-12-31')>=?1 AND reporting_method='simple_tax_rate')",
        params![source.date], |row| row.get(0),
    )?;
    let non_deductible = treatment.as_deref() == Some("non_deductible") || simple_method;
    let link = format!("{source_type}:{source_id}");
    let has_prior: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM journal_entries WHERE source_type=? AND source_id=?)",
        params![SOURCE, link],
        |row| row.get(0),
    )?;
    if !non_deductible && !has_prior {
        return Ok(0);
    }
    if (source.vat_cents < 0 && source_type != "supplier_credit_note_item")
        || source.expense_account.is_empty()
    {
        return Err(AppError::Validation("Le compte de charge ou le montant historique de cet achat n'est pas identifiable ; contrôlez sa comptabilisation avant de changer son traitement TVA.".into()));
    }
    let reversed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM journal_entries WHERE reversal_of=?)",
        params![source.journal_id],
        |row| row.get(0),
    )?;
    if reversed && !(source_type == "expense" && crate::expense_journal::state(tx,&source.journal_id,"9999-12-31")?.active) {
        return Err(AppError::Validation("L'écriture de cet achat a été extournée. Rétablissez un achat cohérent avant de modifier sa TVA.".into()));
    }
    let vat_memo = match source_type {
        "expense" => "TVA préalable",
        "supplier_credit_note_item" => "Correction TVA préalable fournisseur",
        _ => "TVA préalable fournisseur",
    };
    let vat_accounts = {
        let mut statement = tx.prepare("SELECT line.account_id FROM journal_lines line JOIN accounts account ON account.id=line.account_id WHERE line.journal_entry_id=? AND line.memo=? AND line.debit_cents-line.credit_cents=? AND account.account_type='asset'")?;
        let rows = statement
            .query_map(
                params![source.journal_id, vat_memo, source.document_vat_cents],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    if vat_accounts.len() != 1 {
        return Err(AppError::Validation("Le compte de TVA préalable historiquement comptabilisé est ambigu. La classification est conservée sans modification.".into()));
    }
    let mut delta = BTreeMap::new();
    if non_deductible {
        add(
            &mut delta,
            &source.date,
            &source.expense_account,
            source.vat_cents,
        )?;
        add(
            &mut delta,
            &source.date,
            &vat_accounts[0],
            -source.vat_cents,
        )?;
        if source_type == "supplier_invoice_item" {
            let mut statement = tx.prepare("SELECT header.effective_date,line.old_expense_account_id,line.new_expense_account_id FROM supplier_expense_reclassification_lines line JOIN supplier_expense_reclassifications header ON header.id=line.reclassification_id WHERE line.supplier_invoice_item_id=? ORDER BY header.rowid,line.rowid")?;
            let history = statement
                .query_map(params![source_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (date, old, new) in history {
                add(&mut delta, &date, &old, -source.vat_cents)?;
                add(&mut delta, &date, &new, source.vat_cents)?;
            }
        }
    }
    // Subtract every existing, protected correction, grouped by date and historical account.
    let mut statement = tx.prepare("SELECT entry.entry_date,line.account_id,line.debit_cents,line.credit_cents FROM journal_entries entry JOIN journal_lines line ON line.journal_entry_id=entry.id WHERE entry.source_type=? AND entry.source_id=?")?;
    let actual = statement
        .query_map(params![SOURCE, link], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (date, account, debit, credit) in actual {
        add(&mut delta, &date, &account, credit - debit)?;
    }
    let mut by_date: BTreeMap<String, Vec<EntryLine>> = BTreeMap::new();
    for ((date, account), amount) in delta {
        if amount == 0 {
            continue;
        }
        by_date.entry(date).or_default().push(EntryLine {
            account_id: account,
            debit_cents: amount.max(0),
            credit_cents: amount
                .checked_neg()
                .ok_or_else(|| AppError::Validation("Correction TVA hors capacité.".into()))?
                .max(0),
            currency: source.currency.clone(),
            memo: Some("Traitement de la TVA préalable de l'achat".into()),
            project_id: source.project_id.clone(),
            client_id: None,
            employee_id: None,
        });
    }
    let count = by_date.len();
    for (date, lines) in by_date {
        let journal = post_entry(
            tx,
            &date,
            if non_deductible {
                "TVA non déductible portée en charge"
            } else {
                "Rétablissement de la TVA préalable déductible"
            },
            SOURCE,
            &link,
            &Uuid::new_v4().to_string(),
            lines,
        )?;
        append_audit(
            tx,
            "classify_input_vat",
            source_type,
            source_id,
            &json!({"non_deductible":non_deductible,"simple_tax_rate":simple_method,"source_journal_id":source.journal_id,"journal":journal}),
        )?;
    }
    Ok(count)
}

pub(crate) fn sync_supplier_invoice(tx: &Transaction<'_>, invoice_id: &str) -> AppResult<usize> {
    let ids = {
        let mut statement = tx.prepare("SELECT id FROM supplier_invoice_items WHERE supplier_invoice_id=? ORDER BY position,rowid")?;
        let rows = statement
            .query_map(params![invoice_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    ids.iter().try_fold(0, |count, id| {
        Ok(count + sync_source(tx, "supplier_invoice_item", id)?)
    })
}

pub(crate) fn sync_period(
    tx: &Transaction<'_>,
    date_from: &str,
    date_to: &str,
) -> AppResult<usize> {
    let sources = {
        let mut statement = tx.prepare("SELECT 'supplier_invoice_item',line.id FROM supplier_invoice_items line JOIN supplier_invoices invoice ON invoice.id=line.supplier_invoice_id JOIN journal_entries entry ON entry.id=invoice.validation_journal_entry_id WHERE invoice.status='validated' AND entry.entry_date BETWEEN ?1 AND ?2 UNION ALL SELECT 'expense',expense.id FROM expenses expense JOIN journal_entries entry ON entry.source_type='expense' AND entry.source_id=expense.id AND entry.source_event='create' WHERE expense.payment_status='paid' AND entry.entry_date BETWEEN ?1 AND ?2 UNION ALL SELECT 'supplier_credit_note_item',line.id FROM supplier_credit_note_items line JOIN supplier_credit_notes credit ON credit.id=line.supplier_credit_note_id JOIN journal_entries entry ON entry.id=credit.validation_journal_entry_id WHERE credit.status='validated' AND entry.entry_date BETWEEN ?1 AND ?2")?;
        let rows = statement
            .query_map(params![date_from, date_to], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    sources.iter().try_fold(
        0,
        |count, (kind, id)| Ok(count + sync_source(tx, kind, id)?),
    )
}
