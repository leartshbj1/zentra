//! Cash received against a supplier credit, separate from the credit document.
use chrono::NaiveDate;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    accounting::{ensure_accounting_date_open, post_entry, EntryLine},
    audit::append_audit,
    database::{now_iso, query_record_tx, LocalStore},
    error::{AppError, AppResult},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupplierCreditRefundInput {
    pub request_id: String,
    pub supplier_credit_note_id: String,
    pub date: String,
    pub amount_cents: i64,
    pub reference: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReverseSupplierCreditRefundInput {
    pub request_id: String,
    pub refund_id: String,
    pub date: String,
    pub reason: String,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
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

fn request_id(value: &str) -> AppResult<String> {
    Uuid::parse_str(value.trim())
        .map(|id| id.to_string())
        .map_err(|_| invalid("L’identifiant de demande du remboursement est invalide."))
}

fn date(value: &str) -> AppResult<String> {
    let value = value.trim();
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| invalid("La date de remboursement est invalide."))?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err(invalid("Utilisez une date au format AAAA-MM-JJ."));
    }
    Ok(value.into())
}

fn result(tx: &Transaction<'_>, id: &str, idempotent: bool) -> AppResult<Value> {
    let refund = query_record_tx(tx, "supplier_credit_refunds", id)?;
    let credit = refund["supplier_credit_note_id"]
        .as_str()
        .unwrap_or_default();
    let balance: (i64, i64, i64) = tx.query_row(
        "SELECT allocated_cents,refunded_cents,remaining_cents FROM supplier_credit_balances WHERE supplier_credit_note_id=?",
        params![credit], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    )?;
    Ok(
        json!({"refund":refund,"balance":{"allocated_cents":balance.0,"refunded_cents":balance.1,"remaining_cents":balance.2},"idempotent":idempotent}),
    )
}

fn replay(tx: &Transaction<'_>, id: &str, payload: &str) -> AppResult<Option<Value>> {
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT id,request_json FROM supplier_credit_refunds WHERE request_id=?",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match existing {
        Some((id, saved)) if saved == payload => Ok(Some(result(tx,&id,true)?)),
        Some(_) => Err(invalid("Cette demande de remboursement existe avec un contenu différent ; aucune seconde écriture n’a été créée.")),
        None => Ok(None),
    }
}

impl LocalStore {
    pub fn record_supplier_credit_refund(
        &self,
        input: SupplierCreditRefundInput,
    ) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = record_in_transaction(&tx, input)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn reverse_supplier_credit_refund(
        &self,
        input: ReverseSupplierCreditRefundInput,
    ) -> AppResult<Value> {
        let input = ReverseSupplierCreditRefundInput {
            request_id: request_id(&input.request_id)?,
            refund_id: text(&input.refund_id, "Le remboursement", 1, 255)?,
            date: date(&input.date)?,
            reason: text(&input.reason, "Le motif", 5, 1000)?,
        };
        let payload = serde_json::to_string(&json!({"operation":"reverse","input":input}))?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(result) = replay(&tx, &input.request_id, &payload)? {
            return Ok(result);
        }
        let original = query_record_tx(&tx, "supplier_credit_refunds", &input.refund_id)?;
        if original["event_type"] != "refund" {
            return Err(invalid("Seul un remboursement reçu peut être corrigé."));
        }
        if input.date.as_str() < original["date"].as_str().unwrap_or_default() {
            return Err(invalid(
                "La correction ne peut pas précéder le remboursement d’origine.",
            ));
        }
        let request = SupplierCreditRefundInput {
            request_id: input.request_id,
            supplier_credit_note_id: original["supplier_credit_note_id"]
                .as_str()
                .unwrap_or_default()
                .into(),
            date: input.date,
            amount_cents: original["amount_cents"].as_i64().unwrap_or_default(),
            reference: original["reference"].as_str().unwrap_or_default().into(),
            reason: input.reason,
        };
        let result = post_refund(&tx, &request, &payload, Some(&original))?;
        tx.commit()?;
        Ok(result)
    }
}

pub(crate) fn record_in_transaction(
    tx: &Transaction<'_>,
    input: SupplierCreditRefundInput,
) -> AppResult<Value> {
    let input = SupplierCreditRefundInput {
        request_id: request_id(&input.request_id)?,
        supplier_credit_note_id: text(&input.supplier_credit_note_id, "L’avoir", 1, 255)?,
        date: date(&input.date)?,
        amount_cents: input.amount_cents,
        reference: text(&input.reference, "La référence du remboursement", 1, 255)?,
        reason: text(&input.reason, "Le motif", 5, 1000)?,
    };
    if !(1..=9_000_000_000_000_000).contains(&input.amount_cents) {
        return Err(invalid(
            "Le montant reçu doit être positif et inférieur à la limite autorisée.",
        ));
    }
    let payload = serde_json::to_string(&json!({"operation":"refund","input":input}))?;
    if let Some(result) = replay(tx, &input.request_id, &payload)? {
        return Ok(result);
    }
    post_refund(tx, &input, &payload, None)
}

fn post_refund(
    tx: &Transaction<'_>,
    input: &SupplierCreditRefundInput,
    payload: &str,
    original: Option<&Value>,
) -> AppResult<Value> {
    let credit = query_record_tx(tx, "supplier_credit_notes", &input.supplier_credit_note_id)?;
    if credit["status"] != "validated" || credit["currency"] != "CHF" {
        return Err(invalid(
            "Validez un avoir fournisseur en CHF avant d’enregistrer son remboursement.",
        ));
    }
    if input.date.as_str() < credit["document_date"].as_str().unwrap_or_default()
        || input.date > chrono::Local::now().format("%Y-%m-%d").to_string()
    {
        return Err(invalid(
            "La date effective doit suivre l’avoir et ne peut pas être future.",
        ));
    }
    ensure_accounting_date_open(tx, &input.date)?;
    let (bank, payable) = if let Some(original) = original {
        (
            original["bank_account_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            original["payable_account_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        )
    } else {
        let remaining: i64 = tx.query_row(
            "SELECT remaining_cents FROM supplier_credit_balances WHERE supplier_credit_note_id=?",
            params![input.supplier_credit_note_id],
            |r| r.get(0),
        )?;
        if input.amount_cents > remaining {
            return Err(invalid("Le montant reçu dépasse le solde de l’avoir après compensations et remboursements."));
        }
        let bank: Option<String> = tx
            .query_row(
                "SELECT bank_account_id FROM accounting_settings WHERE id=1 AND enabled=1",
                [],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let bank = bank.ok_or_else(|| {
            invalid("Configurez le compte bancaire de liaison dans la comptabilité.")
        })?;
        let accounts: Vec<String> = tx.prepare("SELECT DISTINCT l.account_id FROM journal_lines l JOIN accounts a ON a.id=l.account_id JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.id=? AND j.source_type='supplier_credit_note' AND j.source_id=? AND l.debit_cents=? AND l.credit_cents=0 AND a.account_type='liability' AND NOT EXISTS(SELECT 1 FROM journal_entries x WHERE x.reversal_of=j.id)")?
            .query_map(params![credit["validation_journal_entry_id"].as_str(),input.supplier_credit_note_id,credit["total_cents"].as_i64()],|r|r.get(0))?.collect::<Result<_,_>>()?;
        let payable = match accounts.as_slice() { [one] => one.clone(), _ => return Err(invalid("Le compte fournisseur de l’écriture d’origine doit être identifiable sans ambiguïté.")) };
        (bank, payable)
    };
    for (account, kind) in [(&bank, "asset"), (&payable, "liability")] {
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=? AND active=1 AND account_type=?)",
            params![account, kind],
            |r| r.get(0),
        )?;
        if !active {
            return Err(invalid(
                "Le compte bancaire ou fournisseur figé doit être actif et du type attendu.",
            ));
        }
    }
    let id = Uuid::new_v4().to_string();
    let reverse = original.is_some();
    let event = if reverse { "reverse" } else { "refund" };
    let description = format!(
        "{} fournisseur · {}",
        if reverse {
            "Correction du remboursement"
        } else {
            "Remboursement reçu"
        },
        input.reference
    );
    let lines = [(&bank, !reverse), (&payable, reverse)]
        .into_iter()
        .map(|(account, debit)| EntryLine {
            account_id: account.clone(),
            debit_cents: if debit { input.amount_cents } else { 0 },
            credit_cents: if debit { 0 } else { input.amount_cents },
            currency: "CHF".into(),
            memo: Some(input.reason.clone()),
            project_id: None,
            client_id: None,
            employee_id: None,
        })
        .collect();
    let journal = post_entry(
        tx,
        &input.date,
        &description,
        "supplier_credit_refund",
        &id,
        event,
        lines,
    )?;
    tx.execute("INSERT INTO supplier_credit_refunds(id,request_id,request_json,supplier_credit_note_id,event_type,reverses_id,date,amount_cents,reference,reason,bank_account_id,payable_account_id,journal_entry_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![id,input.request_id,payload,input.supplier_credit_note_id,event,original.and_then(|r|r["id"].as_str()),input.date,input.amount_cents,input.reference,input.reason,bank,payable,journal["entry"]["id"].as_str().or_else(||journal["id"].as_str()),now_iso()])?;
    crate::vat_reporting::validate_supplier_settlement_chronology(
        tx,
        true,
        &input.supplier_credit_note_id,
    )?;
    let result = result(tx, &id, false)?;
    append_audit(tx, event, "supplier_credit_refund", &id, &result)?;
    Ok(result)
}
