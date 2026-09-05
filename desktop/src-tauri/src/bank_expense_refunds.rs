//! Bank evidence for existing refunds and refunds created atomically from a credit.
use super::*;
use rusqlite::{Connection, Transaction};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct MatchExpenseRefundInput {
    pub request_id: String,
    pub movement_id: String,
    pub refund_id: String,
    pub date_difference_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UnmatchExpenseRefundInput {
    pub request_id: String,
    pub match_id: String,
    pub reason: String,
}

fn reject(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn id(value: &str) -> AppResult<String> {
    Uuid::parse_str(value.trim())
        .map(|id| id.to_string())
        .map_err(|_| reject("Identifiant de rapprochement invalide."))
}
fn reason(value: &str) -> AppResult<String> {
    let value = value.trim();
    if !(5..=500).contains(&value.chars().count()) || value.contains('\0') {
        return Err(reject("Le motif doit contenir de 5 à 500 caractères."));
    }
    Ok(value.into())
}

pub(super) fn existing(connection: &Connection, movement: &str) -> AppResult<Option<Value>> {
    Ok(query_all(connection,"SELECT m.*,r.expense_id,r.reference,r.total_cents AS amount_cents,r.payment_date,r.payment_journal_id,e.supplier FROM active_bank_expense_refund_matches m JOIN expense_refunds r ON r.id=m.refund_id JOIN expenses e ON e.id=r.expense_id WHERE m.movement_id=?",params![movement])?.into_iter().next())
}
pub(super) fn history(connection: &Connection, movement: &str) -> AppResult<Vec<Value>> {
    query_all(connection,"SELECT m.*,u.reason,u.unlinked_at,r.expense_id,r.reference,r.total_cents AS amount_cents,r.payment_date,r.payment_journal_id,e.supplier FROM bank_expense_refund_matches m JOIN bank_expense_refund_unlinks u ON u.match_id=m.id JOIN expense_refunds r ON r.id=m.refund_id JOIN expenses e ON e.id=r.expense_id WHERE m.movement_id=? ORDER BY u.unlinked_at DESC,u.rowid DESC",params![movement])
}
pub(super) fn reject_linked(connection: &Connection, movement: &str) -> AppResult<()> {
    if existing(connection, movement)?.is_some() {
        return Err(reject(
            "Ce mouvement est déjà rapproché avec un remboursement de dépense.",
        ));
    }
    Ok(())
}
fn movement_date(connection: &Connection, movement: &Value) -> AppResult<String> {
    if movement["amount_cents"].as_i64().unwrap_or_default() <= 0 {
        return Err(reject("Le crédit bancaire doit avoir un montant positif."));
    }
    if movement["status"] != "BOOK"
        || booked_message_type(connection, movement)?.as_deref() != Some("camt.053")
    {
        return Err(reject(
            "Importez le relevé camt.053 définitif avant de rapprocher le remboursement.",
        ));
    }
    if movement["credit_debit"] != "CRDT"
        || movement["reversal"] == true
        || movement["reversal"] == 1
    {
        return Err(reject(
            "Seul un crédit bancaire sans extourne peut correspondre à un remboursement reçu.",
        ));
    }
    if movement_tx_detail_count(movement) != 1
        || !movement_field(movement, "strong_key").is_some_and(|key| !key.is_empty())
    {
        return Err(reject(
            "Le crédit doit identifier un règlement unique avec une référence bancaire stable.",
        ));
    }
    if movement["currency"] != "CHF" || movement["account_currency"] != "CHF" {
        return Err(reject(
            "Le remboursement et le compte bancaire doivent être en CHF.",
        ));
    }
    if account_link_source(
        connection,
        movement_field(movement, "account_id").unwrap_or_default(),
        "CHF",
    )? == "unlinked"
    {
        return Err(reject(
            "Associez d’abord le compte bancaire à votre entreprise.",
        ));
    }
    match movement_field(movement, "reference_type").unwrap_or("NON") {
        "NON" => (),
        "QRR" if validate_qrr(movement_field(movement, "reference").unwrap_or_default()) => (),
        "SCOR" if validate_scor(movement_field(movement, "reference").unwrap_or_default()) => (),
        _ => {
            return Err(reject(
                "La référence structurée bancaire est invalide ou contradictoire.",
            ))
        }
    }
    let date = movement_field(movement, "booking_date")
        .or_else(|| movement_field(movement, "value_date"))
        .ok_or_else(|| reject("La date bancaire est manquante."))?;
    crate::accounting::validate_date(date, "date bancaire")?;
    if date > chrono::Local::now().format("%Y-%m-%d").to_string().as_str() {
        return Err(reject("La date bancaire ne peut pas être future."));
    }
    Ok(date.into())
}
pub(crate) fn validate_creation(connection: &Transaction<'_>, movement_id: &str, amount: i64, payment_date: &str) -> AppResult<()> {
    let movement = query_record_tx(connection, "bank_movements", movement_id)?;
    let date = movement_date(connection, &movement)?;
    let linked: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM bank_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_supplier_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE movement_id=?1)", params![movement_id], |row| row.get(0))?;
    if linked { return Err(reject("Ce crédit est déjà rapproché. Actualisez les mouvements.")); }
    if date != payment_date || movement["amount_cents"].as_i64() != Some(amount) {
        return Err(reject("Le montant et la date du remboursement doivent reprendre exactement le crédit bancaire."));
    }
    Ok(())
}
pub(crate) fn insert_created_match(connection: &Transaction<'_>, request: &str, movement_id: &str, refund: &Value) -> AppResult<()> {
    let movement = query_record_tx(connection, "bank_movements", movement_id)?;
    let date = movement_date(connection, &movement)?;
    refund_state(connection, refund, movement["amount_cents"].as_i64().unwrap_or_default(), &date, false)?;
    connection.execute("INSERT INTO bank_expense_refund_matches(id,movement_id,refund_id,date_difference_reason,confirmed_at) VALUES(?,?,?,NULL,?)", params![request,movement_id,refund["id"].as_str(),now_iso()])?;
    let proof = query_record_tx(connection, "bank_expense_refund_matches", request)?;
    append_audit(connection, "create_from_bank", "bank_expense_refund_match", request, &proof)?;
    Ok(())
}
pub(crate) fn verify_created_match(connection: &Transaction<'_>, request: &str, movement: &str, refund: &str) -> AppResult<()> {
    let matched = existing(connection, movement)?.ok_or_else(|| reject("Ce remboursement a été enregistré, puis dissocié du relevé. Actualisez et rapprochez la pièce existante."))?;
    if matched["id"] != request || matched["refund_id"] != refund {
        return Err(reject("L’association bancaire a changé. Actualisez les données avant de poursuivre."));
    }
    Ok(())
}
fn refund_state(
    connection: &Connection,
    refund: &Value,
    amount: i64,
    date: &str,
    justified: bool,
) -> AppResult<()> {
    let refund_id = movement_field(refund, "id").unwrap_or_default();
    if refund["event_type"]!="refund" || connection.query_row("SELECT EXISTS(SELECT 1 FROM expense_refunds WHERE reverses_id=?1) OR EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE refund_id=?1)",params![refund_id],|row|row.get::<_,bool>(0))? {
        return Err(reject("Ce remboursement a été corrigé ou est déjà associé à un relevé."));
    }
    if amount <= 0 || refund["total_cents"].as_i64() != Some(amount) {
        return Err(reject(
            "Le crédit bancaire doit correspondre exactement au montant remboursé.",
        ));
    }
    if date < movement_field(refund, "credit_date").unwrap_or_default() {
        return Err(reject("La date bancaire ne peut pas précéder l’avoir."));
    }
    if date != movement_field(refund, "payment_date").unwrap_or_default() && !justified {
        return Err(reject("Les dates du remboursement et du relevé diffèrent. Documentez cet écart pour conserver les dates comptabilisées."));
    }
    for field in ["credit_journal_id", "payment_journal_id"] {
        if !crate::expense_journal::state(
            connection,
            movement_field(refund, field).unwrap_or_default(),
            "9999-12-31",
        )?
        .active
        {
            return Err(reject(
                "Le journal du remboursement est incohérent. Contrôlez-le dans Comptabilité.",
            ));
        }
    }
    let valid: bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM journal_entries j JOIN accounting_settings s ON s.id=1 AND s.enabled=1 AND s.bank_account_id=?2 JOIN accounts a ON a.id=s.bank_account_id AND a.active=1 AND a.account_type='asset' WHERE j.id=?1 AND j.source_type='expense_refund' AND j.source_id=?3 AND j.source_event='payment' AND j.entry_date=?4 AND (SELECT COALESCE(SUM(l.debit_cents-l.credit_cents),0) FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.account_id=?2 AND l.currency='CHF')=?5 AND NOT EXISTS(SELECT 1 FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.currency<>'CHF'))",params![refund["payment_journal_id"].as_str(),refund["bank_account_id"].as_str(),refund_id,refund["payment_date"].as_str(),amount],|row|row.get(0))?;
    if !valid {
        return Err(reject("Le compte bancaire, le montant ou la date du journal ne correspondent pas au remboursement. Vérifiez les liaisons comptables."));
    }
    Ok(())
}
pub(super) fn suggestion(connection: &Connection, movement: &Value) -> AppResult<Value> {
    let movement_id = movement_field(movement, "id").unwrap_or_default();
    let linked:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM bank_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_supplier_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE movement_id=?1)",params![movement_id],|r|r.get(0))?;
    if linked {
        return Ok(json!({"reason":"Ce mouvement est déjà rapproché.","candidates":[]}));
    }
    let date = match movement_date(connection, movement) {
        Ok(date) => date,
        Err(AppError::Validation(reason)) => return Ok(json!({"reason":reason,"candidates":[]})),
        Err(error) => return Err(error),
    };
    let amount = movement["amount_cents"].as_i64().unwrap_or_default();
    let mut candidates = Vec::new();
    for refund in query_all(connection,"SELECT r.*,e.supplier,e.reference AS expense_reference FROM expense_refunds r JOIN expenses e ON e.id=r.expense_id WHERE r.event_type='refund' AND r.total_cents=? AND NOT EXISTS(SELECT 1 FROM expense_refunds x WHERE x.reverses_id=r.id) AND NOT EXISTS(SELECT 1 FROM active_bank_expense_refund_matches m WHERE m.refund_id=r.id) ORDER BY r.payment_date DESC,r.created_at DESC,r.id",params![amount])? {
        let problem=match refund_state(connection,&refund,amount,&date,true) {Ok(())=>None,Err(AppError::Validation(reason))=>Some(reason),Err(error)=>return Err(error)};
        let differs=refund["payment_date"]!=date;
        candidates.push(json!({"refund_id":refund["id"],"expense_id":refund["expense_id"],"reference":refund["reference"],"expense_reference":refund["expense_reference"],"supplier":refund["supplier"],"payment_date":refund["payment_date"],"total_cents":amount,"requires_date_reason":differs,"confirmable":problem.is_none(),"reason":problem.unwrap_or_else(||if differs {"Écart de dates à justifier ; la TVA et les écritures restent inchangées.".into()} else {"Remboursement déjà comptabilisé ; aucune nouvelle écriture.".into()})}));
    }
    Ok(
        json!({"reason":"Choisissez le remboursement reçu correspondant à ce crédit, après vérification de la référence et du fournisseur.","candidates":candidates,"can_create":true}),
    )
}

impl LocalStore {
    pub fn match_bank_expense_refund(&self, input: MatchExpenseRefundInput) -> AppResult<Value> {
        let request = id(&input.request_id)?;
        let movement = id(&input.movement_id)?;
        let refund = id(&input.refund_id)?;
        let note = input
            .date_difference_reason
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(reason)
            .transpose()?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(previous)=query_all(&tx,"SELECT m.*,EXISTS(SELECT 1 FROM bank_expense_refund_unlinks WHERE match_id=m.id) AS unlinked FROM bank_expense_refund_matches m WHERE id=?",params![request])?.into_iter().next() {
            if previous["movement_id"]!=movement || previous["refund_id"]!=refund || previous["date_difference_reason"].as_str()!=note.as_deref() {return Err(reject("Cette tentative a déjà été enregistrée avec un autre choix ou motif."));}
            if previous["unlinked"]==1 {return Err(reject("Cette tentative a été dissociée. Actualisez le relevé avant une nouvelle association."));}
            return Ok(json!({"match":previous,"already_recorded":true}));
        }
        let row = query_record_tx(&tx, "bank_movements", &movement)?;
        let date = movement_date(&tx, &row)?;
        let source = query_record_tx(&tx, "expense_refunds", &refund)?;
        refund_state(
            &tx,
            &source,
            row["amount_cents"].as_i64().unwrap_or_default(),
            &date,
            note.is_some(),
        )?;
        tx.execute("INSERT INTO bank_expense_refund_matches(id,movement_id,refund_id,date_difference_reason,confirmed_at) VALUES(?,?,?,?,?)",params![request,movement,refund,note,now_iso()])?;
        let proof = query_record_tx(&tx, "bank_expense_refund_matches", &request)?;
        append_audit(
            &tx,
            "confirm",
            "bank_expense_refund_match",
            &request,
            &proof,
        )?;
        tx.commit()?;
        Ok(json!({"match":proof,"already_recorded":false}))
    }
    pub fn unmatch_bank_expense_refund(
        &self,
        input: UnmatchExpenseRefundInput,
    ) -> AppResult<Value> {
        let request = id(&input.request_id)?;
        let matched = id(&input.match_id)?;
        let note = reason(&input.reason)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(previous) = query_all(
            &tx,
            "SELECT * FROM bank_expense_refund_unlinks WHERE id=?",
            params![request],
        )?
        .into_iter()
        .next()
        {
            if previous["match_id"] != matched || previous["reason"] != note {
                return Err(reject("Cette tentative de dissociation a déjà été utilisée avec un autre motif ou rapprochement."));
            }
            return Ok(json!({"unlink":previous,"already_recorded":true}));
        }
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE id=?)",
            params![matched],
            |r| r.get(0),
        )?;
        if !active {
            return Err(reject(
                "Ce rapprochement a déjà été dissocié ou n’existe plus. Actualisez le relevé.",
            ));
        }
        tx.execute("INSERT INTO bank_expense_refund_unlinks(id,match_id,reason,unlinked_at) VALUES(?,?,?,?)",params![request,matched,note,now_iso()])?;
        let proof = query_record_tx(&tx, "bank_expense_refund_unlinks", &request)?;
        append_audit(&tx, "unlink", "bank_expense_refund_match", &matched, &proof)?;
        tx.commit()?;
        Ok(json!({"unlink":proof,"already_recorded":false}))
    }
}
