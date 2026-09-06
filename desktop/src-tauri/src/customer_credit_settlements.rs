//! Dated, replay-safe customer credit applications and cash refunds.
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    accounting::{ensure_accounting_date_open, post_entry, posted_invoice_account, EntryLine},
    audit::append_audit,
    customer_credit_math::{project, Part},
    database::{now_iso, query_all, query_record_tx, refresh_invoice_payment_state, LocalStore},
    error::{AppError, AppResult},
};

pub(crate) const PENDING_VAT: &str = "TVA de l’avoir en attente de règlement";
pub(crate) const CREDIT_VAT_RELEASE: &str = "Reprise TVA de l’avoir réglé";
pub(crate) const CREDIT_VAT_DUE: &str = "Réduction TVA due sur règlement de l’avoir";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerCreditSettlementInput {
    pub request_id: String,
    pub credit_note_id: String,
    pub event_type: String,
    pub invoice_id: Option<String>,
    pub date: String,
    pub amount_cents: i64,
    pub bank_account_id: Option<String>,
    pub reference: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReverseCustomerCreditSettlementInput {
    pub request_id: String,
    pub settlement_id: String,
    pub date: String,
    pub reason: String,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

pub(crate) fn journal_snapshot(connection: &Connection, id: &str) -> AppResult<Value> {
    let entry = query_all(connection, "SELECT * FROM journal_entries WHERE id=?", [id])?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("L’écriture du règlement client est absente."))?;
    let lines = query_all(
        connection,
        "SELECT * FROM journal_lines WHERE journal_entry_id=? ORDER BY rowid",
        [id],
    )?;
    Ok(json!({"entry":entry,"lines":lines}))
}

type SettlementJournalProof = (
    String,
    String,
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
);

pub(crate) fn journal_proof_valid(connection: &Connection, id: &str) -> AppResult<bool> {
    let proof:Option<SettlementJournalProof>=connection.query_row(
        "SELECT p.journal_entry_id,p.snapshot_json,e.event_type,e.date,e.amount_cents,e.bank_account_id,e.invoice_id FROM customer_credit_settlements e JOIN customer_credit_settlement_postings p ON p.settlement_id=e.id WHERE e.id=?",
        [id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)),
    ).optional()?;
    let Some((journal, snapshot, event, date, amount, bank, invoice)) = proof else {
        return Ok(false);
    };
    let Ok(snapshot) = serde_json::from_str::<Value>(&snapshot) else {
        return Ok(false);
    };
    let current = match journal_snapshot(connection, &journal) {
        Ok(current) => current,
        Err(AppError::Validation(_)) => return Ok(false),
        Err(error) => return Err(error),
    };
    if snapshot != current
        || current["entry"]["source_type"] != "customer_credit_settlement"
        || current["entry"]["source_id"] != id
        || current["entry"]["source_event"] != event
        || current["entry"]["entry_date"] != date
        || current["entry"]["status"] != "posted"
        || !current["entry"]["reversal_of"].is_null()
        || connection.query_row("SELECT EXISTS(SELECT 1 FROM journal_entries WHERE reversal_of=?)",[&journal],|row|row.get::<_,bool>(0))?
    {
        return Ok(false);
    }
    let signed = if event.starts_with("reverse_") {
        -i128::from(amount)
    } else {
        i128::from(amount)
    };
    let lines = current["lines"]
        .as_array()
        .ok_or_else(|| invalid("Les lignes comptables du règlement sont illisibles."))?;
    let delta = |memo: &str| {
        lines
            .iter()
            .filter(|line| line["memo"] == memo)
            .map(|line| {
                i128::from(line["debit_cents"].as_i64().unwrap_or_default())
                    - i128::from(line["credit_cents"].as_i64().unwrap_or_default())
            })
            .sum::<i128>()
    };
    let counterpart = if invoice.is_some() {
        "Imputation sur facture client"
    } else {
        "Remboursement au client"
    };
    if delta("Règlement de l’avoir client") != signed || delta(counterpart) != -signed {
        return Ok(false);
    }
    if let Some(bank) = bank {
        if !lines
            .iter()
            .any(|line| line["memo"] == counterpart && line["account_id"] == bank)
        {
            return Ok(false);
        }
    }
    for (side, release, due, deferred_memo, sign) in [
        (
            "credit",
            CREDIT_VAT_RELEASE,
            CREDIT_VAT_DUE,
            PENDING_VAT,
            -1,
        ),
        (
            "invoice",
            "Reclassement TVA à régulariser",
            "TVA due sur encaissement",
            "TVA à régulariser · contre-prestations reçues",
            1,
        ),
    ] {
        let tax:i64=connection.query_row("SELECT CASE WHEN EXISTS(SELECT 1 FROM customer_credit_settlements e JOIN journal_entries j ON j.source_type='invoice' AND j.source_id=CASE ?2 WHEN 'credit' THEN e.credit_note_id ELSE e.invoice_id END AND j.source_event='issue' JOIN journal_lines l ON l.journal_entry_id=j.id AND l.memo=?3 WHERE e.id=?1) THEN COALESCE((SELECT SUM(vat_cents) FROM customer_credit_settlement_lines WHERE settlement_id=?1 AND side=?2),0) ELSE 0 END",params![id,side,deferred_memo],|row|row.get(0))?;
        if delta(release) != i128::from(tax) * sign || delta(due) != -i128::from(tax) * sign {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Diagnose missing and damaged proofs without making the workspace unreadable.
/// A financial correction is a separate settlement, never a generic journal reversal.
pub(crate) fn accounting_issues(connection:&Connection,from:&str,to:&str)->AppResult<Vec<Value>> {
    let events=query_all(connection,"SELECT e.id AS settlement_id,e.credit_note_id,c.number AS credit_note_number,e.date,e.reference,p.journal_entry_id,EXISTS(SELECT 1 FROM journal_entries actual WHERE actual.id=p.journal_entry_id) AS journal_available,EXISTS(SELECT 1 FROM accounting_periods a WHERE a.status='closed' AND e.date<=a.date_to) AS closed_period FROM customer_credit_settlements e JOIN invoices c ON c.id=e.credit_note_id LEFT JOIN customer_credit_settlement_postings p ON p.settlement_id=e.id WHERE e.date BETWEEN ?1 AND ?2 OR EXISTS(SELECT 1 FROM journal_entries j WHERE j.id=p.journal_entry_id AND j.entry_date BETWEEN ?1 AND ?2) ORDER BY e.date DESC,e.sequence DESC",params![from,to])?;
    let mut issues=Vec::new();
    for mut event in events {
        let (kind,reason)=if event["journal_entry_id"].is_null() {
            ("missing_posting","Le règlement ne dispose pas encore d’une preuve de comptabilisation.")
        } else if !journal_proof_valid(connection,event["settlement_id"].as_str().unwrap_or_default())? {
            ("invalid_posting","L’écriture du règlement est absente, modifiée ou ne correspond plus à sa preuve conservée.")
        } else {continue;};
        event["kind"]=json!(kind);event["reason"]=json!(reason);issues.push(event);
    }
    let journals=query_all(connection,"SELECT j.id AS journal_entry_id,1 AS journal_available,j.number AS journal_number,j.entry_date AS date,j.description AS reference,e.id AS settlement_id,e.credit_note_id,c.number AS credit_note_number,EXISTS(SELECT 1 FROM accounting_periods a WHERE a.status='closed' AND j.entry_date<=a.date_to) AS closed_period FROM journal_entries j LEFT JOIN customer_credit_settlements e ON e.id=j.source_id LEFT JOIN invoices c ON c.id=e.credit_note_id WHERE j.source_type='customer_credit_settlement' AND j.entry_date BETWEEN ?1 AND ?2 AND NOT EXISTS(SELECT 1 FROM customer_credit_settlement_postings p JOIN customer_credit_settlements linked ON linked.id=p.settlement_id WHERE p.journal_entry_id=j.id AND linked.id=j.source_id) ORDER BY j.entry_date DESC,j.id",params![from,to])?;
    for mut journal in journals {
        journal["kind"]=json!("orphan_journal");journal["reason"]=json!("Cette écriture n’est reliée à aucune preuve de règlement client. Vérifiez son origine avant toute reprise.");issues.push(journal);
    }
    Ok(issues)
}

pub(crate) fn posting_mismatch_count(issues:&[Value])->i64 {
    issues.iter().filter(|issue|issue["kind"]!="missing_posting").count() as i64
}
fn text(value: &str, label: &str, min: usize, max: usize) -> AppResult<String> {
    let value = value.trim();
    if !(min..=max).contains(&value.chars().count()) || value.contains('\0') {
        return Err(invalid(&format!(
            "{label} doit contenir entre {min} et {max} caractères."
        )));
    }
    Ok(value.into())
}
fn date(value: &str) -> AppResult<String> {
    let value = value.trim();
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| invalid("La date du règlement est invalide."))?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err(invalid("Utilisez une date au format AAAA-MM-JJ."));
    }
    Ok(value.into())
}
fn request(value: &str) -> AppResult<String> {
    Uuid::parse_str(value.trim())
        .map(|value| value.to_string())
        .map_err(|_| invalid("L’identifiant de reprise du règlement est invalide."))
}

pub(crate) fn register_new_issue(tx: &Transaction<'_>, credit_id: &str) -> AppResult<()> {
    tx.execute("INSERT INTO customer_credit_documents(credit_note_id,model,created_at) VALUES(?,'dated_v1',?)",params![credit_id,now_iso()])?;
    Ok(())
}

pub(crate) fn automatic_application(tx: &Transaction<'_>, credit_id: &str) -> AppResult<()> {
    let (original, amount, date, number): (String, i64, String, String) = tx.query_row(
        "SELECT original_invoice_id,-total_cents,issue_date,number FROM invoices WHERE id=?",
        [credit_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let remaining: i64=tx.query_row("SELECT MAX(0,total_cents-COALESCE((SELECT SUM(amount_cents) FROM payments WHERE invoice_id=i.id),0)-COALESCE((SELECT SUM(amount_cents) FROM customer_invoice_credit_movements WHERE invoice_id=i.id),0)) FROM invoices i WHERE id=?",[&original],|r|r.get(0))?;
    if remaining > 0 {
        record(
            tx,
            CustomerCreditSettlementInput {
                request_id: Uuid::new_v4().to_string(),
                credit_note_id: credit_id.into(),
                event_type: "apply".into(),
                invoice_id: Some(original),
                date,
                amount_cents: amount.min(remaining),
                bank_account_id: None,
                reference: number,
                reason: "Déduction de l’avoir sur sa facture originale à l’émission".into(),
            },
            None,
            None,
        )?;
    }
    Ok(())
}

pub(crate) fn ensure_chronology(
    tx: &Transaction<'_>,
    document_id: &str,
    date: &str,
) -> AppResult<()> {
    let later: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM customer_credit_settlements WHERE (credit_note_id=?1 OR invoice_id=?1) AND date>?2) OR EXISTS(SELECT 1 FROM payments WHERE invoice_id=?1 AND date>?2)",params![document_id,date],|r|r.get(0))?;
    if later {
        return Err(invalid("Un règlement plus récent est déjà enregistré sur ce document. Cette date modifierait sa ventilation passée ; rétablissez la chronologie avant de continuer."));
    }
    Ok(())
}

fn result(tx: &Transaction<'_>, id: &str, replayed: bool) -> AppResult<Value> {
    let mut event = query_record_tx(tx, "customer_credit_settlements", id)?;
    let posted:Option<String>=tx.query_row("SELECT journal_entry_id FROM customer_credit_settlement_postings WHERE settlement_id=?",[id],|row|row.get(0)).optional()?;
    if posted.is_some() && !journal_proof_valid(tx, id)? {
        return Err(invalid(
            "La preuve comptable du règlement client ne concorde plus avec son journal.",
        ));
    }
    event["journal_entry_id"] = json!(posted);
    let credit = event["credit_note_id"].as_str().unwrap_or_default();
    // Verify exact stored distributions on retries as well as on new writes.
    let credit_state = project(tx, credit, "9999-12-31")?;
    if let Some(invoice) = event["invoice_id"].as_str() {
        project(tx, invoice, "9999-12-31")?;
    }
    let balance = query_all(
        tx,
        "SELECT * FROM customer_credit_balances WHERE credit_note_id=?",
        [credit],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| invalid("Le solde de l’avoir est introuvable."))?;
    if balance["remaining_cents"].as_i64() != Some(credit_state.remaining()?) {
        return Err(invalid(
            "Le solde de l’avoir ne correspond pas à sa ventilation.",
        ));
    }
    Ok(json!({"settlement":event,"balance":balance,"idempotent":replayed}))
}

impl LocalStore {
    pub fn record_customer_credit_settlement(
        &self,
        input: CustomerCreditSettlementInput,
    ) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = record(&tx, input, None, None)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn reverse_customer_credit_settlement(
        &self,
        input: ReverseCustomerCreditSettlementInput,
    ) -> AppResult<Value> {
        let input = ReverseCustomerCreditSettlementInput {
            request_id: request(&input.request_id)?,
            settlement_id: text(&input.settlement_id, "Le règlement", 1, 255)?,
            date: date(&input.date)?,
            reason: text(&input.reason, "Le motif", 5, 1000)?,
        };
        let payload = serde_json::to_string(&json!({"operation":"reverse","input":input}))?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(saved) = replay(&tx, &input.request_id, &payload)? {
            return Ok(saved);
        }
        let original = query_record_tx(&tx, "customer_credit_settlements", &input.settlement_id)?;
        let event = original["event_type"].as_str().unwrap_or_default();
        if !matches!(event, "apply" | "refund") {
            return Err(invalid("Seul le règlement d’origine peut être extourné."));
        }
        let result = record(
            &tx,
            CustomerCreditSettlementInput {
                request_id: input.request_id,
                credit_note_id: original["credit_note_id"]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                event_type: format!("reverse_{event}"),
                invoice_id: original["invoice_id"].as_str().map(str::to_owned),
                date: input.date,
                amount_cents: original["amount_cents"].as_i64().unwrap_or_default(),
                bank_account_id: original["bank_account_id"].as_str().map(str::to_owned),
                reference: original["reference"].as_str().unwrap_or_default().into(),
                reason: input.reason,
            },
            Some(&input.settlement_id),
            Some(payload),
        )?;
        tx.commit()?;
        Ok(result)
    }
}

fn replay(tx: &Transaction<'_>, request_id: &str, payload: &str) -> AppResult<Option<Value>> {
    let saved: Option<(String, String)> = tx
        .query_row(
            "SELECT id,request_json FROM customer_credit_settlements WHERE request_id=?",
            [request_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match saved {
        Some((id, saved)) if saved == payload => Ok(Some(result(tx, &id, true)?)),
        Some(_) => Err(invalid(
            "Cette demande existe avec un autre contenu ; aucun second règlement n’a été créé.",
        )),
        None => Ok(None),
    }
}

pub(crate) fn record(
    tx: &Transaction<'_>,
    input: CustomerCreditSettlementInput,
    reverses: Option<&str>,
    payload: Option<String>,
) -> AppResult<Value> {
    let input = CustomerCreditSettlementInput {
        request_id: request(&input.request_id)?,
        credit_note_id: text(&input.credit_note_id, "L’avoir", 1, 255)?,
        event_type: input.event_type,
        invoice_id: input
            .invoice_id
            .map(|value| text(&value, "La facture", 1, 255))
            .transpose()?,
        date: date(&input.date)?,
        amount_cents: input.amount_cents,
        bank_account_id: input
            .bank_account_id
            .map(|value| text(&value, "Le compte bancaire", 1, 255))
            .transpose()?,
        reference: text(&input.reference, "La référence", 1, 255)?,
        reason: text(&input.reason, "Le motif", 5, 1000)?,
    };
    let reversing = reverses.is_some();
    if (!reversing && !matches!(input.event_type.as_str(), "apply" | "refund"))
        || !(1..=9_000_000_000_000_000).contains(&input.amount_cents)
    {
        return Err(invalid(
            "Le type ou le montant du règlement client est invalide.",
        ));
    }
    let payload = payload.unwrap_or(serde_json::to_string(
        &json!({"operation":"record","input":input}),
    )?);
    if let Some(saved) = replay(tx, &input.request_id, &payload)? {
        return Ok(saved);
    }
    let registered: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM customer_credit_documents WHERE credit_note_id=?)",
        [&input.credit_note_id],
        |r| r.get(0),
    )?;
    if !registered {
        return Err(invalid("Cet avoir historique nécessite une reprise documentée avant d’enregistrer son règlement."));
    }
    ensure_accounting_date_open(tx, &input.date)?;
    ensure_chronology(tx, &input.credit_note_id, &input.date)?;
    if let Some(invoice) = input.invoice_id.as_deref() {
        ensure_chronology(tx, invoice, &input.date)?;
    }
    let credit = project(tx, &input.credit_note_id, "9999-12-31")?;
    let credit_parts = parts(&credit, input.amount_cents, reverses)?;
    let invoice_parts = if let Some(invoice) = input.invoice_id.as_deref() {
        Some(parts(
            &project(tx, invoice, "9999-12-31")?,
            input.amount_cents,
            reverses,
        )?)
    } else {
        None
    };
    let id = Uuid::new_v4().to_string();
    let journal = post_settlement(
        tx,
        &id,
        &input,
        &credit_parts,
        invoice_parts.as_deref(),
        reverses,
    )?;
    let journal_id = journal.as_ref().and_then(|value| value["id"].as_str());
    tx.execute("INSERT INTO customer_credit_settlements(id,request_id,request_json,credit_note_id,event_type,reverses_id,invoice_id,date,amount_cents,reference,reason,bank_account_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![id,input.request_id,payload,input.credit_note_id,input.event_type,reverses,input.invoice_id,input.date,input.amount_cents,input.reference,input.reason,input.bank_account_id,now_iso()])?;
    if let Some(journal) = journal_id {
        tx.execute("INSERT INTO customer_credit_settlement_postings(settlement_id,journal_entry_id,snapshot_json,created_at) VALUES(?,?,?,?)",params![id,journal,serde_json::to_string(&journal_snapshot(tx,journal)?)?,now_iso()])?;
    }
    for (side, parts) in [
        ("credit", Some(credit_parts.as_slice())),
        ("invoice", invoice_parts.as_deref()),
    ] {
        for part in parts.unwrap_or_default() {
            tx.execute("INSERT INTO customer_credit_settlement_lines(settlement_id,side,invoice_item_id,gross_cents,vat_cents) VALUES(?,?,?,?,?)",params![id,side,part.invoice_item_id,part.gross_cents,part.vat_cents])?;
        }
    }
    if let Some(invoice) = input.invoice_id.as_deref() {
        refresh_invoice_payment_state(tx, invoice)?;
        crate::reminders::cancel_settled_reminders(tx, invoice)?;
    }
    let value = result(tx, &id, false)?;
    append_audit(
        tx,
        &input.event_type,
        "customer_credit_settlement",
        &id,
        &json!({"input":input,"result":value,"journal":journal}),
    )?;
    Ok(value)
}

/// Add a journal to an existing event without changing its date or allocation.
pub(crate) fn post_existing(tx: &Transaction<'_>, id: &str) -> AppResult<Value> {
    let event = query_record_tx(tx, "customer_credit_settlements", id)?;
    let input: CustomerCreditSettlementInput = serde_json::from_value(event.clone())?;
    let projection = crate::customer_credit_math::project_until(
        tx,
        &input.credit_note_id,
        &input.date,
        Some(id),
    )?;
    let credit_parts = &projection.parts[id];
    let invoice_projection = input
        .invoice_id
        .as_deref()
        .map(|invoice| {
            crate::customer_credit_math::project_until(tx, invoice, &input.date, Some(id))
        })
        .transpose()?;
    let invoice_parts = invoice_projection
        .as_ref()
        .map(|projection| projection.parts[id].as_slice());
    let journal = post_settlement(
        tx,
        id,
        &input,
        credit_parts,
        invoice_parts,
        event["reverses_id"].as_str(),
    )?
    .ok_or_else(|| invalid("Activez la comptabilité avant de comptabiliser ce règlement."))?;
    let journal_id = journal["id"]
        .as_str()
        .ok_or_else(|| invalid("Le journal du règlement est absent."))?;
    tx.execute("INSERT INTO customer_credit_settlement_postings(settlement_id,journal_entry_id,snapshot_json,created_at) VALUES(?,?,?,?)",params![id,journal_id,serde_json::to_string(&journal_snapshot(tx,journal_id)?)?,now_iso()])?;
    if !journal_proof_valid(tx, id)? {
        return Err(invalid(
            "La reprise comptable du règlement ne concorde pas avec sa ventilation.",
        ));
    }
    Ok(journal)
}

fn parts(
    projection: &crate::customer_credit_math::Projection,
    amount: i64,
    reverses: Option<&str>,
) -> AppResult<Vec<Part>> {
    if let Some(original) = reverses {
        let original = projection
            .parts
            .get(original)
            .ok_or_else(|| invalid("La ventilation du règlement d’origine est absente."))?;
        Ok(original
            .iter()
            .map(|part| Part {
                invoice_item_id: part.invoice_item_id.clone(),
                gross_cents: -part.gross_cents,
                vat_cents: -part.vat_cents,
            })
            .collect())
    } else {
        projection.allocate(amount)
    }
}

fn post_settlement(
    tx: &Transaction<'_>,
    id: &str,
    input: &CustomerCreditSettlementInput,
    credit_parts: &[Part],
    invoice_parts: Option<&[Part]>,
    reverses: Option<&str>,
) -> AppResult<Option<Value>> {
    let enabled: bool = tx.query_row(
        "SELECT COALESCE((SELECT enabled FROM accounting_settings WHERE id=1),0)",
        [],
        |r| r.get(0),
    )?;
    if let Some(original) = reverses {
        let journal: Option<String> = tx.query_row(
            "SELECT journal_entry_id FROM customer_credit_settlement_postings WHERE settlement_id=?",
            [original],
            |row| row.get(0),
        ).optional()?.flatten();
        if let Some(journal) = journal {
            if !journal_proof_valid(tx, original)? {
                return Err(invalid("La preuve comptable du règlement d’origine est incohérente ; son extourne est bloquée."));
            }
            let mut statement=tx.prepare("SELECT account_id,credit_cents,debit_cents,currency,memo,project_id,client_id,employee_id FROM journal_lines WHERE journal_entry_id=? ORDER BY rowid")?;
            let lines = statement
                .query_map([journal], |row| {
                    Ok(EntryLine {
                        account_id: row.get(0)?,
                        debit_cents: row.get(1)?,
                        credit_cents: row.get(2)?,
                        currency: row.get(3)?,
                        memo: row.get(4)?,
                        project_id: row.get(5)?,
                        client_id: row.get(6)?,
                        employee_id: row.get(7)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Some(post_entry(
                tx,
                &input.date,
                &input.reason,
                "customer_credit_settlement",
                id,
                &input.event_type,
                lines,
            )?));
        }
        if enabled {
            return Err(invalid(
                "Comptabilisez le règlement d’origine avant son extourne.",
            ));
        }
    }
    if !enabled {
        return Ok(None);
    }
    let (currency, client, project_id): (String, Option<String>, Option<String>) = tx.query_row(
        "SELECT currency,client_id,project_id FROM invoices WHERE id=?",
        [&input.credit_note_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let credit_ar = posted_invoice_account(
        tx,
        &input.credit_note_id,
        "Réduction créance client",
        "asset",
    )?
    .ok_or_else(|| invalid("Comptabilisez l’avoir avant son règlement."))?;
    let (counterpart, counterpart_project) = if let Some(invoice) = input.invoice_id.as_deref() {
        let ar = posted_invoice_account(tx, invoice, "Créance client", "asset")?
            .ok_or_else(|| invalid("Comptabilisez la facture avant l’imputation."))?;
        let project: Option<String> = tx.query_row(
            "SELECT project_id FROM invoices WHERE id=?",
            [invoice],
            |r| r.get(0),
        )?;
        (ar, project)
    } else {
        let bank = input
            .bank_account_id
            .clone()
            .ok_or_else(|| invalid("Choisissez le compte du remboursement."))?;
        let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=? AND account_type='asset' AND active=1)",[&bank],|r|r.get(0))?;
        if !valid || bank == credit_ar {
            return Err(invalid("Le compte de remboursement doit être un compte de trésorerie actif, distinct du compte client."));
        }
        (bank, project_id.clone())
    };
    let reversing = input.event_type.starts_with("reverse_");
    let amount = if reversing {
        -input.amount_cents
    } else {
        input.amount_cents
    };
    let line = |account: String, amount: i64, memo: &str, project: Option<String>| EntryLine {
        account_id: account,
        debit_cents: amount.max(0),
        credit_cents: (-amount).max(0),
        currency: currency.clone(),
        memo: Some(memo.into()),
        project_id: project,
        client_id: client.clone(),
        employee_id: None,
    };
    let mut lines = vec![
        line(
            credit_ar,
            amount,
            "Règlement de l’avoir client",
            project_id.clone(),
        ),
        line(
            counterpart,
            -amount,
            if input.invoice_id.is_some() {
                "Imputation sur facture client"
            } else {
                "Remboursement au client"
            },
            counterpart_project.clone(),
        ),
    ];
    let due: Option<String> = tx.query_row(
        "SELECT vat_payable_account_id FROM accounting_settings WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    for (doc, memo, parts, invert, project) in [
        (
            Some(input.credit_note_id.as_str()),
            PENDING_VAT,
            Some(credit_parts),
            true,
            project_id,
        ),
        (
            input.invoice_id.as_deref(),
            "TVA à régulariser · contre-prestations reçues",
            invoice_parts,
            false,
            counterpart_project,
        ),
    ] {
        let (Some(doc), Some(parts)) = (doc, parts) else {
            continue;
        };
        if let Some(deferred) = posted_invoice_account(tx, doc, memo, "liability")? {
            let tax: i64 = parts.iter().map(|part| part.vat_cents).sum();
            if !invert {
                let stored: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM customer_credit_settlements WHERE id=?)",
                    [id],
                    |row| row.get(0),
                )?;
                let before = crate::customer_credit_math::project_until(
                    tx,
                    doc,
                    &input.date,
                    stored.then_some(id),
                )?;
                let expected = before.lines.iter().map(|line| line.released).sum::<i64>()
                    - if stored { tax } else { 0 };
                let actual:i64=tx.query_row("SELECT COALESCE(SUM(l.debit_cents-l.credit_cents),0) FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id AND l.memo='Reclassement TVA à régulariser' WHERE (j.source_type='vat_cash_reclassification' AND j.source_event='invoice:'||?1) OR (j.source_type='customer_credit_settlement' AND EXISTS(SELECT 1 FROM customer_credit_settlements e WHERE e.id=j.source_id AND e.invoice_id=?1))",[doc],|row|row.get(0))?;
                if actual != expected {
                    return Err(invalid("La TVA historique de la facture ne concorde pas avec sa ventilation par ligne. Rapprochez les écritures avant d’imputer cet avoir."));
                }
            }
            if tax == 0 {
                continue;
            }
            let due = due
                .clone()
                .ok_or_else(|| invalid("Configurez le compte de TVA due avant ce règlement."))?;
            if due == deferred {
                return Err(invalid(
                    "Les comptes de TVA due et différée doivent être distincts.",
                ));
            }
            if invert {
                lines.push(line(due, tax, CREDIT_VAT_DUE, project.clone()));
                lines.push(line(deferred, -tax, CREDIT_VAT_RELEASE, project));
            } else {
                lines.push(line(
                    deferred,
                    tax,
                    "Reclassement TVA à régulariser",
                    project.clone(),
                ));
                lines.push(line(due, -tax, "TVA due sur encaissement", project));
            }
        }
    }
    Ok(Some(post_entry(
        tx,
        &input.date,
        &input.reason,
        "customer_credit_settlement",
        id,
        &input.event_type,
        lines,
    )?))
}
