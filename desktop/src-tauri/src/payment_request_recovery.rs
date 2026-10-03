//! Read-only proof of a durable customer-payment request and its proposed variants.
//! An absence is a snapshot observation, never permission to abandon the UUID.
use std::time::Duration;

use chrono::NaiveDate;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::verify_audit_chain,
    database::{payment_record_with_journal, LocalStore},
    error::{AppError, AppResult},
    models::RecordPaymentInput,
};

const MAX_VARIANTS: usize = 12;

#[derive(Debug, PartialEq, Eq)]
struct Payload {
    invoice_id: String,
    amount_cents: i64,
    date: String,
    method: Option<String>,
    reference: Option<String>,
    notes: Option<String>,
}

struct Variant {
    request_id: String,
    payload: Payload,
}

// Keep these rules identical to record_payment_in_transaction_checked:
// date trim/parse/canonicalization, Rust Unicode trim, empty -> NULL and a
// Unicode-scalar limit. Probe tests compare normalization with real writes.
fn optional_text(value: Option<String>, max: usize) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(max).collect())
        }
    })
}

fn normalize(input: RecordPaymentInput) -> AppResult<Variant> {
    if input.amount_cents <= 0 {
        return Err(AppError::Validation(
            "Le montant du paiement doit être supérieur à zéro.".into(),
        ));
    }
    let raw_date = input.date.as_deref().filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Validation("La date réelle de l’encaissement est obligatoire.".into()))?;
    let date = NaiveDate::parse_from_str(raw_date.trim(), "%Y-%m-%d")
        .map(|date| date.format("%Y-%m-%d").to_string())
        .map_err(|_| AppError::Validation("date doit être au format AAAA-MM-JJ.".into()))?;
    let request_id = Uuid::parse_str(input.request_id.trim())
        .map(|id| id.to_string())
        .map_err(|_| AppError::Validation("request_id doit être un UUID valide.".into()))?;
    Ok(Variant {
        request_id,
        payload: Payload {
            invoice_id: input.invoice_id,
            amount_cents: input.amount_cents,
            date,
            method: optional_text(input.method, 80),
            reference: optional_text(input.reference, 160),
            notes: optional_text(input.notes, 5000),
        },
    })
}

fn conflict(request_id: &str, workspace_scope: &str) -> Value {
    json!({"status":"conflict", "originalRequestId":request_id, "workspaceScope":workspace_scope})
}

pub(crate) fn read(
    store: &LocalStore,
    inputs: Vec<RecordPaymentInput>,
    expected_workspace_scope: &str,
) -> AppResult<Value> {
    // A cloned LocalStore shares this lock. Restore/join can replace the file
    // at its database_path: take the lock before opening or checking anything.
    let _guard = store.lock()?;
    let mut connection = Connection::open_with_flags(
        &store.database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
    // This first SELECT pins the same snapshot as aliases, payload and proof.
    // Missing scope is a read error; never generate a replacement scope here.
    let workspace_scope = crate::work_notes::workspace_scope(&transaction)?;
    if expected_workspace_scope.is_empty() || workspace_scope != expected_workspace_scope {
        return Err(AppError::Validation(
            "L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.".into(),
        ));
    }
    if inputs.is_empty() || inputs.len() > MAX_VARIANTS {
        return Err(AppError::Validation("La reprise doit contenir entre 1 et 12 variantes.".into()));
    }
    let variants = inputs.into_iter().map(normalize).collect::<AppResult<Vec<_>>>()?;
    let original = &variants[0].request_id;
    let invoice = &variants[0].payload.invoice_id;
    if variants.iter().any(|variant| &variant.request_id != original || &variant.payload.invoice_id != invoice) {
        return Err(AppError::Validation(
            "Toutes les variantes doivent conserver le même UUID et la même facture.".into(),
        ));
    }
    // payment_request ignores malformed JSON. Checking the existing chain also
    // prevents a damaged alias event from being mistaken for a safe absence.
    match verify_audit_chain(&transaction) {
        Ok(_) => {}
        Err(AppError::Validation(_)) => return Ok(conflict(original, &workspace_scope)),
        Err(error) => return Err(error),
    }
    let (canonical, was_aliased) = match crate::company_merge::payment_request(&transaction, original) {
        Ok(resolved) => resolved,
        Err(AppError::Validation(_)) => return Ok(conflict(original, &workspace_scope)),
        Err(error) => return Err(error),
    };
    if was_aliased {
        // The resolver already proved a single bounded, acyclic chain. A
        // legitimate merge removes every superseded payment identity, including
        // intermediate IDs in A -> B -> C; never hide a residual second receipt.
        let superseded_payment_present: bool = transaction.query_row(
            "WITH RECURSIVE aliases(id) AS (
               SELECT ?1
               UNION
               SELECT json_extract(event.payload_json,'$.confirmed_duplicate_receipt.remoteId')
               FROM aliases previous JOIN audit_log event
                 ON json_extract(event.payload_json,'$.confirmed_duplicate_receipt.localId')=previous.id
               WHERE event.action='company.merge_branch' AND json_valid(event.payload_json)=1
             )
             SELECT EXISTS(SELECT 1 FROM payments payment JOIN aliases alias ON alias.id=payment.id
                           WHERE payment.id<>?2)",
            params![original, canonical],
            |row| row.get(0),
        )?;
        if superseded_payment_present {
            return Ok(conflict(original, &workspace_scope));
        }
    }
    let existing = transaction.query_row(
        "SELECT invoice_id,amount_cents,date,method,reference,notes FROM payments WHERE id=?",
        params![canonical],
        |row| Ok(Payload {
            invoice_id: row.get(0)?,
            amount_cents: row.get(1)?,
            date: row.get(2)?,
            method: row.get(3)?,
            reference: row.get(4)?,
            notes: row.get(5)?,
        }),
    ).optional()?;
    let Some(existing) = existing else {
        if was_aliased {
            return Ok(conflict(original, &workspace_scope));
        }
        transaction.commit()?;
        return Ok(json!({"status":"absent", "originalRequestId":original, "workspaceScope":workspace_scope}));
    };
    // Review guards are not part of a payment's identity. Several stored
    // proposals can have the same native payload and different expectedReview;
    // report the first matching original index without treating them as conflict.
    let Some(variant_index) = variants.iter().position(|variant| variant.payload == existing) else {
        return Ok(conflict(original, &workspace_scope));
    };
    let record = match payment_record_with_journal(&transaction, &canonical) {
        Ok(record) => record,
        Err(AppError::Validation(_) | AppError::NotFound(_)) => {
            return Ok(conflict(original, &workspace_scope));
        }
        Err(error) => return Err(error),
    };
    let Some(journal_id) = record["journal_entry_id"].as_str() else {
        return Ok(conflict(original, &workspace_scope));
    };
    let result = json!({
        "status":"recorded", "originalRequestId":original,
        "canonicalPaymentId":canonical, "wasAliased":was_aliased,
        "workspaceScope":workspace_scope, "variantIndex":variant_index,
        "journalEntryId":journal_id,
    });
    transaction.commit()?;
    Ok(result)
}
