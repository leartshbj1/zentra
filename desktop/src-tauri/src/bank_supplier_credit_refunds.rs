//! Bank evidence links a cash refund to its supplier credit without paying it twice.
pub use super::refunds::{
    MatchExpenseRefundInput as MatchInput, UnmatchExpenseRefundInput as UnmatchInput,
};
use super::*;
use crate::expense_refund_attachments::RefundAttachmentInput;
use crate::supplier_credit_refunds::SupplierCreditRefundInput;
use rusqlite::{Connection, Transaction};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct CreateInput {
    pub request_id: String,
    pub movement_id: String,
    pub supplier_credit_note_id: String,
    pub reference: String,
    pub reason: String,
    pub attachment: RefundAttachmentInput,
}
fn reject(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn id(value: &str) -> AppResult<String> {
    Uuid::parse_str(value.trim())
        .map(|id| id.to_string())
        .map_err(|_| reject("Identifiant bancaire invalide."))
}
fn text(value: &str, min: usize, max: usize) -> AppResult<String> {
    let value = value.trim();
    if !(min..=max).contains(&value.chars().count()) || value.contains('\0') {
        return Err(reject(
            "La référence ou le motif est vide, trop court ou trop long.",
        ));
    }
    Ok(value.into())
}
pub(super) fn existing(connection: &Connection, movement: &str) -> AppResult<Option<Value>> {
    Ok(query_all(connection,"SELECT m.*,r.supplier_credit_note_id,r.reference,r.amount_cents,r.date AS payment_date,r.journal_entry_id AS payment_journal_id,c.supplier_name AS supplier FROM active_bank_supplier_credit_refund_matches m JOIN supplier_credit_refunds r ON r.id=m.refund_id JOIN supplier_credit_notes c ON c.id=r.supplier_credit_note_id WHERE m.movement_id=?",params![movement])?.into_iter().next())
}
pub(super) fn history(connection: &Connection, movement: &str) -> AppResult<Vec<Value>> {
    query_all(connection,"SELECT m.*,u.reason,u.unlinked_at,r.supplier_credit_note_id,r.reference,r.amount_cents,r.date AS payment_date,r.journal_entry_id AS payment_journal_id,c.supplier_name AS supplier FROM bank_supplier_credit_refund_matches m JOIN bank_supplier_credit_refund_unlinks u ON u.match_id=m.id JOIN supplier_credit_refunds r ON r.id=m.refund_id JOIN supplier_credit_notes c ON c.id=r.supplier_credit_note_id WHERE m.movement_id=? ORDER BY u.unlinked_at DESC,u.rowid DESC",params![movement])
}
fn linked(connection: &Connection, movement: &str) -> AppResult<bool> {
    Ok(connection.query_row("SELECT EXISTS(SELECT 1 FROM bank_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_supplier_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches WHERE movement_id=?1)",params![movement],|r|r.get(0))?)
}
fn refund_state(
    connection: &Connection,
    refund: &Value,
    amount: i64,
    date: &str,
    justified: bool,
) -> AppResult<()> {
    let refund_id = refund["id"].as_str().unwrap_or_default();
    let invalid:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM supplier_credit_refunds WHERE reverses_id=?1) OR EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches WHERE refund_id=?1)",params![refund_id],|r|r.get(0))?;
    if refund["event_type"] != "refund" || invalid {
        return Err(reject("Ce remboursement est corrigé ou déjà rapproché."));
    }
    if amount <= 0 || refund["amount_cents"].as_i64() != Some(amount) {
        return Err(reject(
            "Le montant du virement doit correspondre exactement au remboursement.",
        ));
    }
    let credit_date: String = connection.query_row(
        "SELECT document_date FROM supplier_credit_notes WHERE id=?",
        params![refund["supplier_credit_note_id"].as_str()],
        |r| r.get(0),
    )?;
    if date < credit_date.as_str() {
        return Err(reject("Le relevé bancaire ne peut pas précéder l’avoir."));
    }
    if date != refund["date"].as_str().unwrap_or_default() && !justified {
        return Err(reject("Documentez l’écart entre les dates du relevé et du remboursement ; les dates comptabilisées seront conservées."));
    }
    let valid:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM journal_entries j JOIN accounting_settings s ON s.id=1 AND s.enabled=1 AND s.bank_account_id=?2 JOIN accounts a ON a.id=?2 AND a.active=1 AND a.account_type='asset' WHERE j.id=?1 AND j.source_type='supplier_credit_refund' AND j.source_id=?3 AND j.source_event='refund' AND j.entry_date=?4 AND NOT EXISTS(SELECT 1 FROM journal_entries x WHERE x.reversal_of=j.id) AND (SELECT COUNT(*) FROM journal_lines WHERE journal_entry_id=j.id)=2 AND (SELECT COALESCE(SUM(debit_cents-credit_cents),0) FROM journal_lines WHERE journal_entry_id=j.id AND account_id=?2 AND currency='CHF')=?5)",params![refund["journal_entry_id"].as_str(),refund["bank_account_id"].as_str(),refund_id,refund["date"].as_str(),amount],|r|r.get(0))?;
    if !valid {
        return Err(reject(
            "Le journal du remboursement ou le compte bancaire de liaison doit être vérifié.",
        ));
    }
    Ok(())
}
pub(super) fn suggestion(connection: &Connection, movement: &Value) -> AppResult<Vec<Value>> {
    if linked(connection, movement["id"].as_str().unwrap_or_default())? {
        return Ok(vec![]);
    }
    let date = match super::refunds::movement_date(connection, movement) {
        Ok(date) => date,
        Err(AppError::Validation(_)) => return Ok(vec![]),
        Err(error) => return Err(error),
    };
    let amount = movement["amount_cents"].as_i64().unwrap_or_default();
    let rows=query_all(connection,"SELECT r.*,c.supplier_name,c.number AS credit_number,c.reference AS credit_reference FROM supplier_credit_refunds r JOIN supplier_credit_notes c ON c.id=r.supplier_credit_note_id WHERE r.event_type='refund' AND r.amount_cents=? AND NOT EXISTS(SELECT 1 FROM supplier_credit_refunds x WHERE x.reverses_id=r.id) AND NOT EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches m WHERE m.refund_id=r.id) ORDER BY r.date DESC,r.sequence DESC",params![amount])?;
    let mut candidates = vec![];
    for row in rows {
        let problem = match refund_state(connection, &row, amount, &date, true) {
            Ok(()) => None,
            Err(AppError::Validation(message)) => Some(message),
            Err(error) => return Err(error),
        };
        let differs = row["date"] != date;
        candidates.push(json!({"refund_id":row["id"],"supplier_credit_note_id":row["supplier_credit_note_id"],"reference":row["reference"],"expense_reference":row["credit_number"].as_str().filter(|v|!v.is_empty()).or_else(||row["credit_reference"].as_str()),"supplier":row["supplier_name"],"payment_date":row["date"],"total_cents":amount,"requires_date_reason":differs,"confirmable":problem.is_none(),"reason":problem.unwrap_or_else(||if differs{"Écart de dates à justifier ; les écritures et la TVA restent inchangées.".into()}else{"Remboursement de l’avoir déjà comptabilisé ; aucune seconde écriture.".into()})}));
    }
    Ok(candidates)
}
fn insert_match(
    tx: &Transaction<'_>,
    request: &str,
    movement: &str,
    refund: &str,
    note: Option<&str>,
) -> AppResult<Value> {
    tx.execute("INSERT INTO bank_supplier_credit_refund_matches(id,movement_id,refund_id,date_difference_reason,confirmed_at) VALUES(?,?,?,?,?)",params![request,movement,refund,note,now_iso()])?;
    let proof = query_record_tx(tx, "bank_supplier_credit_refund_matches", request)?;
    append_audit(
        tx,
        "confirm",
        "bank_supplier_credit_refund_match",
        request,
        &proof,
    )?;
    Ok(proof)
}
impl LocalStore {
    pub fn match_bank_supplier_credit_refund(&self, input: MatchInput) -> AppResult<Value> {
        let request = id(&input.request_id)?;
        let movement = id(&input.movement_id)?;
        let refund = id(&input.refund_id)?;
        let note = input
            .date_difference_reason
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| text(v, 5, 500))
            .transpose()?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(previous)=query_all(&tx,"SELECT m.*,EXISTS(SELECT 1 FROM bank_supplier_credit_refund_unlinks WHERE match_id=m.id) AS unlinked FROM bank_supplier_credit_refund_matches m WHERE id=?",params![request])?.into_iter().next() {
            if previous["movement_id"]!=movement || previous["refund_id"]!=refund || previous["date_difference_reason"].as_str()!=note.as_deref() {return Err(reject("Cette demande a été enregistrée avec un autre choix ou motif."));}
            if previous["unlinked"]==1 {return Err(reject("Ce rapprochement a été dissocié. Actualisez le relevé avant une nouvelle association."));}
            return Ok(json!({"match":previous,"already_recorded":true}));
        }
        if linked(&tx, &movement)? {
            return Err(reject("Ce mouvement bancaire est déjà rapproché."));
        }
        let row = query_record_tx(&tx, "bank_movements", &movement)?;
        let date = super::refunds::movement_date(&tx, &row)?;
        let source = query_record_tx(&tx, "supplier_credit_refunds", &refund)?;
        refund_state(
            &tx,
            &source,
            row["amount_cents"].as_i64().unwrap_or_default(),
            &date,
            note.is_some(),
        )?;
        let proof = insert_match(&tx, &request, &movement, &refund, note.as_deref())?;
        tx.commit()?;
        Ok(json!({"match":proof,"already_recorded":false}))
    }
    pub fn unmatch_bank_supplier_credit_refund(&self, input: UnmatchInput) -> AppResult<Value> {
        let request = id(&input.request_id)?;
        let matched = id(&input.match_id)?;
        let note = text(&input.reason, 5, 500)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(previous) = query_all(
            &tx,
            "SELECT * FROM bank_supplier_credit_refund_unlinks WHERE id=?",
            params![request],
        )?
        .into_iter()
        .next()
        {
            if previous["match_id"] != matched || previous["reason"] != note {
                return Err(reject(
                    "Cette demande de dissociation a déjà un autre contenu.",
                ));
            }
            return Ok(json!({"unlink":previous,"already_recorded":true}));
        }
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches WHERE id=?)",
            params![matched],
            |r| r.get(0),
        )?;
        if !active {
            return Err(reject(
                "Ce rapprochement n’existe plus ou a déjà été dissocié.",
            ));
        }
        tx.execute("INSERT INTO bank_supplier_credit_refund_unlinks(id,match_id,reason,unlinked_at) VALUES(?,?,?,?)",params![request,matched,note,now_iso()])?;
        let proof = query_record_tx(&tx, "bank_supplier_credit_refund_unlinks", &request)?;
        append_audit(
            &tx,
            "unlink",
            "bank_supplier_credit_refund_match",
            &matched,
            &proof,
        )?;
        tx.commit()?;
        Ok(json!({"unlink":proof,"already_recorded":false}))
    }
    pub fn create_bank_supplier_credit_refund(&self, input: CreateInput) -> AppResult<Value> {
        let request = id(&input.request_id)?;
        let movement = id(&input.movement_id)?;
        let credit = id(&input.supplier_credit_note_id)?;
        let reference = text(&input.reference, 1, 255)?;
        let reason = text(&input.reason, 5, 1000)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let bytes = input.attachment.decode()?;
        let mut prepared = self
            .prepare_supplier_invoice_attachment_bytes(&input.attachment.original_name, &bytes)?;
        let payload = serde_json::to_string(
            &json!({"movement_id":movement,"supplier_credit_note_id":credit,"reference":reference,"reason":reason,"attachment":prepared.source_proof()}),
        )?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(previous) = query_all(
            &tx,
            "SELECT * FROM bank_supplier_credit_refund_requests WHERE id=?",
            params![request],
        )?
        .into_iter()
        .next()
        {
            if previous["request_json"] != payload {
                return Err(reject(
                    "Cette création a déjà été enregistrée avec un autre contenu ou justificatif.",
                ));
            }
            let matched=existing(&tx,&movement)?.ok_or_else(||reject("Ce remboursement a été créé puis dissocié. Rapprochez la pièce existante depuis le relevé."))?;
            if matched["id"] != previous["match_id"]
                || matched["refund_id"] != previous["refund_id"]
            {
                return Err(reject(
                    "L’association bancaire a changé depuis cette création.",
                ));
            }
            return Ok(json!({"match":matched,"already_recorded":true}));
        }
        if linked(&tx, &movement)? {
            return Err(reject("Ce mouvement est déjà rapproché."));
        }
        let row = query_record_tx(&tx, "bank_movements", &movement)?;
        let date = super::refunds::movement_date(&tx, &row)?;
        let amount = row["amount_cents"].as_i64().unwrap_or_default();
        let recorded = crate::supplier_credit_refunds::record_in_transaction(
            &tx,
            SupplierCreditRefundInput {
                request_id: request.clone(),
                supplier_credit_note_id: credit,
                date: date.clone(),
                amount_cents: amount,
                reference,
                reason,
            },
        )?;
        if recorded["idempotent"] == true {
            return Err(reject(
                "Cette demande appartient déjà à un autre enregistrement de remboursement.",
            ));
        }
        let refund = &recorded["refund"];
        let refund_id = refund["id"].as_str().unwrap_or_default();
        refund_state(&tx, refund, amount, &date, false)?;
        let proof = insert_match(&tx, &request, &movement, refund_id, None)?;
        let attachment =
            self.insert_prepared_supplier_credit_refund_attachment(&tx, refund_id, &prepared)?;
        tx.execute("INSERT INTO bank_supplier_credit_refund_requests(id,request_json,refund_id,match_id,attachment_id,created_at) VALUES(?,?,?,?,?,?)",params![request,payload,refund_id,request,attachment.record["id"].as_str(),now_iso()])?;
        if attachment.created {
            prepared.install()?;
        }
        tx.commit()?;
        if attachment.created {
            prepared.retain();
        }
        Ok(
            json!({"match":proof,"refund":refund,"attachment":attachment.record,"already_recorded":false}),
        )
    }
}
