//! Reporting-basis changes require a documented debtor/creditor correction (OTVA 106/107).
//! Until that correction has a dedicated ledger workflow, do not silently export ordinary
//! receipts after a switch. Inspect balances at the boundary, never today's paid flags.
use super::{map_profile, push_issue, VatBlockingIssue, VatProfile};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};

fn profiles(connection: &Connection) -> AppResult<Vec<VatProfile>> {
    let mut statement = connection.prepare(
        "SELECT id,effective_from,effective_to,reporting_method,form_of_reporting,periodicity,gross_or_net,tdfn_activity_id,tdfn_rate_bp,afc_authorization_confirmed,notes,created_at,updated_at FROM vat_profiles ORDER BY effective_from,id",
    )?;
    let rows = statement.query_map([], map_profile)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Called inside profile creation's transaction, so its rejection also restores the old end date.
pub(super) fn ensure_supported(connection: &Connection) -> AppResult<()> {
    let profiles = profiles(connection)?;
    let mut issues = Vec::new();
    for pair in profiles.windows(2) {
        inspect(connection, &pair[0], &pair[1], &mut issues)?;
    }
    if issues.is_empty() {
        return Ok(());
    }
    let details = issues
        .iter()
        .take(5)
        .map(|issue| issue.message.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let more = if issues.len() > 5 {
        format!("\nEt {} autre(s) pièce(s).", issues.len() - 5)
    } else {
        String::new()
    };
    Err(AppError::Validation(format!("Changement de mode TVA non enregistré : une reprise des soldes ouverts est nécessaire et n'est pas encore automatisée. Les profils précédents sont conservés.\n{details}{more}")))
}

/// Also covers profiles created by earlier app versions or restored from backups.
/// A later payment must never make an unresolved transition disappear from prior periods.
pub(super) fn append_period_issues(
    connection: &Connection,
    profile: &VatProfile,
    date_to: &str,
    issues: &mut Vec<VatBlockingIssue>,
) -> AppResult<()> {
    let profiles = profiles(connection)?;
    for pair in profiles.windows(2) {
        let previous = &pair[0];
        let next = &pair[1];
        // A simultaneous effective/TDFN switch requires corrections in the preceding period
        // (OTVA 79(4), 81(5)), unlike a reporting-basis-only switch (OTVA 106/107).
        let affects_preceding_period = previous.reporting_method != next.reporting_method
            && previous.id == profile.id
            && previous
                .effective_to
                .as_deref()
                .is_some_and(|end| end <= date_to);
        if next.effective_from.as_str() <= date_to || affects_preceding_period {
            inspect(connection, previous, next, issues)?;
        }
    }
    Ok(())
}

fn inspect(
    connection: &Connection,
    previous: &VatProfile,
    next: &VatProfile,
    issues: &mut Vec<VatBlockingIssue>,
) -> AppResult<()> {
    if previous.form_of_reporting == next.form_of_reporting {
        return Ok(());
    }
    let date = &next.effective_from;
    let article = if previous.reporting_method != next.reporting_method {
        if next.reporting_method == "simple_tax_rate" {
            "79 al. 4"
        } else {
            "81 al. 5"
        }
    } else if next.reporting_method == "effective" {
        "106"
    } else {
        "107"
    };
    let purchase_relevant =
        previous.reporting_method == "effective" || next.reporting_method == "effective";
    let mut queries = vec![("invoice_item", "facture client", "SELECT document.id,COALESCE(document.number,document.id),UPPER(TRIM(document.currency)),document.total_cents,
        (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE invoice_id=document.id AND date<?1),
        (SELECT COUNT(*) FROM invoices credit WHERE credit.original_invoice_id=document.id AND credit.type='avoir' AND credit.number IS NOT NULL AND credit.status<>'annulee' AND credit.issue_date<?1)
        FROM invoices document WHERE document.number IS NOT NULL AND document.type<>'avoir' AND document.status IN ('emise','partiellement_payee','payee') AND document.issue_date<?1 ORDER BY document.issue_date,document.id")];
    if purchase_relevant {
        queries.push(("supplier_invoice_item", "facture fournisseur", "SELECT document.id,COALESCE(NULLIF(document.reference,''),document.id),UPPER(TRIM(document.currency)),document.total_cents,
            (SELECT COALESCE(SUM(amount_cents),0) FROM supplier_payments WHERE supplier_invoice_id=document.id AND date<?1),
            (SELECT COUNT(*) FROM supplier_credit_allocations allocation JOIN supplier_credit_notes credit ON credit.id=allocation.supplier_credit_note_id WHERE allocation.supplier_invoice_id=document.id AND credit.status='validated' AND credit.document_date<?1)
            FROM supplier_invoices document WHERE document.status='validated' AND document.document_date<?1 ORDER BY document.document_date,document.id"));
        queries.push(("expense", "dépense", "SELECT id,COALESCE(NULLIF(reference,''),NULLIF(supplier,''),id),UPPER(TRIM(currency)),total_cents,0,0 FROM expenses
            WHERE date<?1 AND (payment_status<>'paid' OR COALESCE(NULLIF(paid_at,''),date)>=?1) ORDER BY date,id"));
    }
    for (source_type, label, sql) in queries {
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map(params![date], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?;
        for row in rows {
            let (id, reference, currency, total, paid, credits) = row?;
            let remaining = i128::from(total) - i128::from(paid);
            if remaining == 0 && credits == 0 {
                continue;
            }
            let detail = if credits != 0 {
                "avoir lié sans date d'imputation fiscale permettant de justifier le solde à cette date".to_owned()
            } else if remaining < 0 {
                "paiements antérieurs supérieurs au montant de la pièce".to_owned()
            } else {
                format!(
                    "solde avant changement : {}.{:02} {currency}",
                    remaining / 100,
                    remaining % 100
                )
            };
            push_issue(issues, "vat_reporting_transition_open_balance", format!("Au {date}, {label} {reference} : {detail}. La reprise TVA prévue à l'art. {article} OTVA doit être documentée avant l'export; elle n'est pas encore automatisée."), Some(source_type.into()), Some(id));
        }
    }
    Ok(())
}
