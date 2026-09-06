//! A booked debit proves a customer cash refund; matching never pays it twice.
pub use super::refunds::{
    MatchExpenseRefundInput as MatchInput, UnmatchExpenseRefundInput as UnmatchInput,
};
use super::*;
use crate::{
    customer_credit_settlements as settlements, expense_refund_attachments::RefundAttachmentInput,
};
use rusqlite::{Connection, Transaction};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct CreateInput {
    pub request_id: String,
    pub movement_id: String,
    pub customer_credit_note_id: String,
    pub expected_amount_cents: i64,
    pub expected_date: String,
    pub reference: String,
    pub reason: String,
    pub attachment: Option<RefundAttachmentInput>,
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
fn record(c: &Connection, table: &str, id: &str) -> AppResult<Value> {
    query_all(c, &format!("SELECT * FROM {table} WHERE id=?"), [id])?
        .into_iter()
        .next()
        .ok_or_else(|| reject("La pièce bancaire ou le remboursement est introuvable."))
}
fn source_proof(c: &Connection, movement: &str, refund: &str) -> AppResult<Value> {
    let refund = record(c, "customer_credit_settlements", refund)?;
    let posting = query_all(
        c,
        "SELECT * FROM customer_credit_settlement_postings WHERE settlement_id=?",
        [refund["id"].as_str().unwrap_or_default()],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| reject("Le journal du remboursement est absent."))?;
    let journal =
        settlements::journal_snapshot(c, posting["journal_entry_id"].as_str().unwrap_or_default())?;
    Ok(
        json!({"movement":record(c,"bank_movements",movement)?,"refund":refund,"posting":posting,"journal":journal}),
    )
}
pub(crate) fn proof_valid(c: &Connection, matched: &Value) -> AppResult<bool> {
    let saved = serde_json::from_str::<Value>(matched["source_json"].as_str().unwrap_or_default());
    let current = source_proof(
        c,
        matched["movement_id"].as_str().unwrap_or_default(),
        matched["refund_id"].as_str().unwrap_or_default(),
    );
    match (saved, current) {
        (Ok(saved), Ok(current)) => Ok(saved == current),
        (_, Err(AppError::Validation(_))) | (Err(_), _) => Ok(false),
        (_, Err(error)) => Err(error),
    }
}
pub(crate) fn accounting_issues(c: &Connection, from: &str, to: &str) -> AppResult<Vec<Value>> {
    let rows=query_all(c,"SELECT m.*,e.id AS settlement_id,e.credit_note_id,c.number AS credit_note_number,e.date,e.reference,p.journal_entry_id,EXISTS(SELECT 1 FROM journal_entries j WHERE j.id=p.journal_entry_id) AS journal_available,EXISTS(SELECT 1 FROM accounting_periods a WHERE a.status='closed' AND e.date<=a.date_to) AS closed_period FROM bank_customer_credit_refund_matches m JOIN customer_credit_settlements e ON e.id=m.refund_id JOIN invoices c ON c.id=e.credit_note_id LEFT JOIN customer_credit_settlement_postings p ON p.settlement_id=e.id WHERE e.date BETWEEN ? AND ? ORDER BY e.date DESC,m.confirmed_at DESC",params![from,to])?;
    let mut issues = Vec::new();
    for mut row in rows {
        if !proof_valid(c, &row)? {
            row["kind"] = json!("bank_refund_proof");
            row["reason"]=json!("La preuve bancaire du remboursement client est absente ou ne concorde plus avec le relevé et l’écriture conservés. Vérifiez le rapprochement dans Banque.");
            issues.push(row);
        }
    }
    Ok(issues)
}
const MATCH_SELECT: &str = "SELECT m.*,r.credit_note_id AS customer_credit_note_id,r.reference,r.amount_cents,r.date AS payment_date,p.journal_entry_id AS payment_journal_id,c.number AS credit_number,COALESCE(NULLIF(cl.company,''),cl.name,'Client') AS customer_name FROM active_bank_customer_credit_refund_matches m JOIN customer_credit_settlements r ON r.id=m.refund_id JOIN invoices c ON c.id=r.credit_note_id LEFT JOIN clients cl ON cl.id=c.client_id LEFT JOIN customer_credit_settlement_postings p ON p.settlement_id=r.id";
pub(super) fn existing(c: &Connection, movement: &str) -> AppResult<Option<Value>> {
    let mut row = query_all(
        c,
        &format!("{MATCH_SELECT} WHERE m.movement_id=?"),
        [movement],
    )?
    .into_iter()
    .next();
    if let Some(row) = row.as_mut() {
        if !proof_valid(c, row)? {
            row["integrity_issue"]=json!("La preuve de ce rapprochement client ne concorde plus avec ses pièces. Vérifiez-la avant de clôturer.");
        }
    }
    Ok(row)
}
pub(super) fn history(c: &Connection, movement: &str) -> AppResult<Vec<Value>> {
    query_all(c,"SELECT m.*,u.reason,u.unlinked_at,r.credit_note_id AS customer_credit_note_id,r.reference,r.amount_cents,r.date AS payment_date,p.journal_entry_id AS payment_journal_id,c.number AS credit_number,COALESCE(NULLIF(cl.company,''),cl.name,'Client') AS customer_name FROM bank_customer_credit_refund_matches m JOIN bank_customer_credit_refund_unlinks u ON u.match_id=m.id JOIN customer_credit_settlements r ON r.id=m.refund_id JOIN invoices c ON c.id=r.credit_note_id LEFT JOIN clients cl ON cl.id=c.client_id LEFT JOIN customer_credit_settlement_postings p ON p.settlement_id=r.id WHERE m.movement_id=? ORDER BY u.unlinked_at DESC,u.rowid DESC",[movement])
}
fn linked(c: &Connection, movement: &str) -> AppResult<bool> {
    Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM bank_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_supplier_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM active_bank_customer_credit_refund_matches WHERE movement_id=?1)",[movement],|r|r.get(0))?)
}
fn creation_problem(c: &Connection, movement: &str, date: &str) -> AppResult<Option<&'static str>> {
    let previous:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM bank_customer_credit_refund_matches m JOIN customer_credit_settlements r ON r.id=m.refund_id WHERE m.movement_id=? AND NOT EXISTS(SELECT 1 FROM customer_credit_settlements x WHERE x.reverses_id=r.id))",[movement],|r|r.get(0))?;
    if previous {
        return Ok(Some("Un remboursement conservé a déjà été relié à ce débit. Rapprochez ce remboursement existant ; la dissociation ne l’a pas annulé."));
    }
    let closed: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM accounting_periods WHERE status='closed' AND ?<=date_to)",
        [date],
        |r| r.get(0),
    )?;
    if closed {
        return Ok(Some("La date du débit appartient à une période clôturée. Vous pouvez relier un remboursement déjà comptabilisé, mais pas en créer un à cette date."));
    }
    Ok(None)
}
fn refund_state(
    c: &Connection,
    refund: &Value,
    amount: i64,
    date: &str,
    justified: bool,
) -> AppResult<()> {
    let refund_id = refund["id"].as_str().unwrap_or_default();
    let unavailable: bool=c.query_row("SELECT EXISTS(SELECT 1 FROM customer_credit_settlements WHERE reverses_id=?1) OR EXISTS(SELECT 1 FROM active_bank_customer_credit_refund_matches WHERE refund_id=?1)",[refund_id],|r|r.get(0))?;
    if refund["event_type"] != "refund" || unavailable {
        return Err(reject("Ce remboursement est corrigé ou déjà rapproché."));
    }
    if amount <= 0 || refund["amount_cents"].as_i64() != Some(amount) {
        return Err(reject(
            "Le débit doit correspondre exactement au montant du remboursement.",
        ));
    }
    let credit_id = refund["credit_note_id"].as_str().unwrap_or_default();
    let credit = record(c, "invoices", credit_id)?;
    if credit["currency"] != "CHF" {
        return Err(reject(
            "Le relevé et l’avoir doivent être en CHF pour ce rapprochement.",
        ));
    }
    if date < credit["issue_date"].as_str().unwrap_or_default() {
        return Err(reject("Le débit bancaire ne peut pas précéder l’avoir."));
    }
    if refund["date"] != date && !justified {
        return Err(reject("Documentez l’écart entre les dates du relevé et du remboursement. Les dates comptabilisées seront conservées."));
    }
    let bank_ok:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM accounting_settings s JOIN accounts a ON a.id=s.bank_account_id AND a.active=1 AND a.account_type='asset' WHERE s.id=1 AND s.enabled=1 AND s.bank_account_id=?)",[refund["bank_account_id"].as_str()],|r|r.get(0))?;
    if !bank_ok || !settlements::journal_proof_valid(c, refund_id)? {
        return Err(reject(
            "Le journal du remboursement ou le compte bancaire de liaison doit être vérifié.",
        ));
    }
    crate::customer_credit_recovery_vat::ensure_proof(c, credit_id)?;
    crate::customer_credit_math::project(c, credit_id, "9999-12-31")?;
    Ok(())
}
pub(super) fn suggestion(c: &Connection, movement: &Value) -> AppResult<Value> {
    if linked(c, movement["id"].as_str().unwrap_or_default())? {
        return Ok(
            json!({"candidates":[],"can_create":false,"reason":"Ce mouvement est déjà rapproché."}),
        );
    }
    let date = match super::refunds::movement_date_for(c, movement, "DBIT") {
        Ok(date) => date,
        Err(AppError::Validation(message)) => {
            return Ok(json!({"candidates":[],"can_create":false,"reason":message}))
        }
        Err(error) => return Err(error),
    };
    let amount = movement["amount_cents"].as_i64().unwrap_or_default();
    let rows=query_all(c,"SELECT r.*,c.number AS credit_number,COALESCE(NULLIF(cl.company,''),cl.name,'Client') AS customer_name FROM customer_credit_settlements r JOIN invoices c ON c.id=r.credit_note_id LEFT JOIN clients cl ON cl.id=c.client_id WHERE r.event_type='refund' AND r.amount_cents=? AND c.currency='CHF' AND NOT EXISTS(SELECT 1 FROM customer_credit_settlements x WHERE x.reverses_id=r.id) AND NOT EXISTS(SELECT 1 FROM active_bank_customer_credit_refund_matches m WHERE m.refund_id=r.id) ORDER BY r.date DESC,r.sequence DESC",[amount])?;
    let mut candidates = Vec::new();
    for row in rows {
        let problem = match refund_state(c, &row, amount, &date, true) {
            Ok(()) => None,
            Err(AppError::Validation(message)) => Some(message),
            Err(error) => return Err(error),
        };
        let differs = row["date"] != date;
        candidates.push(json!({"refund_id":row["id"],"customer_credit_note_id":row["credit_note_id"],"customer_name":row["customer_name"],"reference":row["reference"],"expense_reference":row["credit_number"],"payment_date":row["date"],"total_cents":amount,"requires_date_reason":differs,"confirmable":problem.is_none(),"reason":problem.unwrap_or_else(||if differs {"Écart de dates à justifier ; les dates, l’écriture et la TVA restent inchangées.".into()}else{"Remboursement client déjà comptabilisé ; aucune seconde écriture.".into()})}));
    }
    let problem = creation_problem(c, movement["id"].as_str().unwrap_or_default(), &date)?;
    Ok(
        json!({"candidates":candidates,"can_create":problem.is_none(),"reason":problem.unwrap_or("Reliez le débit à un remboursement client déjà enregistré, ou enregistrez le remboursement réel d’un avoir disponible.")}),
    )
}
fn insert_match(
    tx: &Transaction<'_>,
    request: &str,
    movement: &str,
    refund: &str,
    note: Option<&str>,
) -> AppResult<Value> {
    let source = serde_json::to_string(&source_proof(tx, movement, refund)?)?;
    tx.execute("INSERT INTO bank_customer_credit_refund_matches(id,movement_id,refund_id,date_difference_reason,source_json,confirmed_at) VALUES(?,?,?,?,?,?)",params![request,movement,refund,note,source,now_iso()])?;
    let proof = query_record_tx(tx, "bank_customer_credit_refund_matches", request)?;
    append_audit(
        tx,
        "confirm",
        "bank_customer_credit_refund_match",
        request,
        &proof,
    )?;
    Ok(proof)
}
impl LocalStore {
    pub fn match_bank_customer_credit_refund(&self, input: MatchInput) -> AppResult<Value> {
        let request = id(&input.request_id)?;
        let movement = id(&input.movement_id)?;
        let refund = id(&input.refund_id)?;
        let note = input
            .date_difference_reason
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| text(s, 5, 500))
            .transpose()?;
        let mut c = self.connect()?;
        self.require_onboarding(&c)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(previous)=query_all(&tx,"SELECT m.*,EXISTS(SELECT 1 FROM bank_customer_credit_refund_unlinks WHERE match_id=m.id) AS unlinked FROM bank_customer_credit_refund_matches m WHERE id=?",[&request])?.into_iter().next() {
            if previous["movement_id"]!=movement || previous["refund_id"]!=refund || previous["date_difference_reason"].as_str()!=note.as_deref() { return Err(reject("Cette demande a été enregistrée avec un autre choix ou motif.")); }
            if previous["unlinked"]==1 { return Err(reject("Ce rapprochement a été dissocié. Actualisez le relevé avant une nouvelle association.")); }
            if !proof_valid(&tx,&previous)? {return Err(reject("La preuve du rapprochement client ne concorde plus avec ses pièces."));}
            return Ok(json!({"match":previous,"already_recorded":true}));
        }
        if linked(&tx, &movement)? {
            return Err(reject("Ce mouvement bancaire est déjà rapproché."));
        }
        let row = query_record_tx(&tx, "bank_movements", &movement)?;
        let date = super::refunds::movement_date_for(&tx, &row, "DBIT")?;
        let refund_row = query_record_tx(&tx, "customer_credit_settlements", &refund)?;
        refund_state(
            &tx,
            &refund_row,
            row["amount_cents"].as_i64().unwrap_or_default(),
            &date,
            note.is_some(),
        )?;
        let proof = insert_match(&tx, &request, &movement, &refund, note.as_deref())?;
        tx.commit()?;
        Ok(json!({"match":proof,"already_recorded":false}))
    }
    pub fn unmatch_bank_customer_credit_refund(&self, input: UnmatchInput) -> AppResult<Value> {
        let request = id(&input.request_id)?;
        let matched = id(&input.match_id)?;
        let reason = text(&input.reason, 5, 500)?;
        let mut c = self.connect()?;
        self.require_onboarding(&c)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(previous) = query_all(
            &tx,
            "SELECT * FROM bank_customer_credit_refund_unlinks WHERE id=?",
            [&request],
        )?
        .into_iter()
        .next()
        {
            if previous["match_id"] != matched || previous["reason"] != reason {
                return Err(reject(
                    "Cette dissociation a déjà été enregistrée avec un autre contenu.",
                ));
            }
            return Ok(json!({"unlink":previous,"already_recorded":true}));
        }
        if !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM active_bank_customer_credit_refund_matches WHERE id=?)",
            [&matched],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(reject(
                "Ce rapprochement a déjà été dissocié. Actualisez le relevé.",
            ));
        }
        tx.execute("INSERT INTO bank_customer_credit_refund_unlinks(id,match_id,reason,unlinked_at) VALUES(?,?,?,?)",params![request,matched,reason,now_iso()])?;
        let proof = query_record_tx(&tx, "bank_customer_credit_refund_unlinks", &request)?;
        append_audit(
            &tx,
            "unlink",
            "bank_customer_credit_refund_match",
            &matched,
            &proof,
        )?;
        tx.commit()?;
        Ok(json!({"unlink":proof,"already_recorded":false}))
    }
    pub fn create_bank_customer_credit_refund(&self, input: CreateInput) -> AppResult<Value> {
        let request = id(&input.request_id)?;
        let movement = id(&input.movement_id)?;
        let credit = id(&input.customer_credit_note_id)?;
        let reference = text(&input.reference, 1, 255)?;
        let reason = text(&input.reason, 5, 1000)?;
        let mut c = self.connect()?;
        self.require_onboarding(&c)?;
        let mut prepared = input
            .attachment
            .as_ref()
            .map(|a| self.prepare_supplier_invoice_attachment_bytes(&a.original_name, &a.decode()?))
            .transpose()?;
        let payload = serde_json::to_string(
            &json!({"movement_id":movement,"customer_credit_note_id":credit,"expected_amount_cents":input.expected_amount_cents,"expected_date":input.expected_date,"reference":reference,"reason":reason,"attachment":prepared.as_ref().map(|p|p.source_proof())}),
        )?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(previous) = query_all(
            &tx,
            "SELECT * FROM bank_customer_credit_refund_requests WHERE id=?",
            [&request],
        )?
        .into_iter()
        .next()
        {
            if previous["request_json"] != payload {
                return Err(reject(
                    "Cette création a déjà été enregistrée avec un autre contenu ou justificatif.",
                ));
            }
            let matched=existing(&tx,&movement)?.ok_or_else(||reject("Le remboursement a été créé puis dissocié. Rapprochez la pièce existante depuis le relevé."))?;
            if matched["id"] != previous["match_id"]
                || matched["refund_id"] != previous["refund_id"]
                || !proof_valid(&tx, &matched)?
            {
                return Err(reject(
                    "L’association bancaire ou sa preuve a changé depuis cette création.",
                ));
            }
            if let Some(attachment) = previous["attachment_id"].as_str() {
                self.verified_attachment_path(attachment)?;
            }
            return Ok(json!({"match":matched,"already_recorded":true}));
        }
        if linked(&tx, &movement)? {
            return Err(reject("Ce mouvement bancaire est déjà rapproché."));
        }
        let row = query_record_tx(&tx, "bank_movements", &movement)?;
        let date = super::refunds::movement_date_for(&tx, &row, "DBIT")?;
        let amount = row["amount_cents"].as_i64().unwrap_or_default();
        if amount != input.expected_amount_cents || date != input.expected_date {
            return Err(reject("Le montant ou la date du débit ont changé depuis votre vérification. Actualisez le relevé avant de continuer."));
        }
        if let Some(problem) = creation_problem(&tx, &movement, &date)? {
            return Err(reject(problem));
        }
        let bank: String = tx
            .query_row(
                "SELECT bank_account_id FROM accounting_settings WHERE id=1 AND enabled=1",
                [],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| reject("Activez la comptabilité et configurez le compte bancaire."))?;
        let recorded = settlements::record(
            &tx,
            settlements::CustomerCreditSettlementInput {
                request_id: request.clone(),
                credit_note_id: credit,
                event_type: "refund".into(),
                invoice_id: None,
                date: date.clone(),
                amount_cents: amount,
                bank_account_id: Some(bank),
                reference,
                reason,
            },
            None,
            None,
        )?;
        if recorded["idempotent"] == true {
            return Err(reject(
                "Cette demande appartient déjà à un autre enregistrement de remboursement.",
            ));
        }
        let refund = &recorded["settlement"];
        let refund_id = refund["id"].as_str().unwrap_or_default();
        refund_state(&tx, refund, amount, &date, false)?;
        let proof = insert_match(&tx, &request, &movement, refund_id, None)?;
        let attachment = prepared
            .as_ref()
            .map(|p| self.insert_prepared_customer_credit_attachment(&tx, refund_id, p))
            .transpose()?;
        tx.execute("INSERT INTO bank_customer_credit_refund_requests(id,request_json,refund_id,match_id,attachment_id,created_at) VALUES(?,?,?,?,?,?)",params![request,payload,refund_id,request,attachment.as_ref().and_then(|a|a.record["id"].as_str()),now_iso()])?;
        if attachment.as_ref().is_some_and(|a| a.created) {
            if let Some(p) = prepared.as_mut() {
                p.install()?;
            }
        }
        tx.commit()?;
        if attachment.as_ref().is_some_and(|a| a.created) {
            if let Some(p) = prepared.as_mut() {
                p.retain();
            }
        }
        Ok(
            json!({"match":proof,"refund":refund,"attachment":attachment.map(|a|a.record),"already_recorded":false}),
        )
    }
}
