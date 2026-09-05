//! Link a bank debit to an expense without creating a second purchase or payment.
use super::*;
use crate::{
    accounting::{ensure_accounting_date_open, post_expense_if_enabled, validate_date},
    models::ConfirmExpenseBankReconciliationInput,
};
use rusqlite::Connection;

#[path = "bank_expense_corrections.rs"]
mod corrections;
#[path = "bank_expense_creation.rs"]
mod creation;

pub(super) fn correction_history(connection: &Connection, movement: &str) -> AppResult<Vec<Value>> {
    query_all(connection,"SELECT h.*,e.reference,e.supplier FROM bank_expense_unreconciliations h JOIN expenses e ON e.id=h.expense_id WHERE h.movement_id=? ORDER BY h.unlinked_at DESC,h.id",params![movement])
}

fn reject(message: &str) -> AppError {
    AppError::Validation(message.into())
}

pub(super) fn existing(connection: &Connection, movement: &str) -> AppResult<Option<Value>> {
    Ok(query_all(
        connection,
        "SELECT r.*,e.reference,e.supplier FROM bank_expense_reconciliations r JOIN expenses e ON e.id=r.expense_id WHERE r.movement_id=?",
        params![movement],
    )?
    .into_iter()
    .next())
}

pub(super) fn reject_linked(connection: &Connection, movement: &str) -> AppResult<()> {
    super::refunds::reject_linked(connection, movement)?;
    if existing(connection, movement)?.is_some() {
        return Err(reject("Ce mouvement est déjà rapproché avec une dépense."));
    }
    Ok(())
}

fn eligible_movement(connection: &Connection, movement: &Value) -> AppResult<String> {
    if movement_field(movement, "status") != Some("BOOK")
        || booked_message_type(connection, movement)?.as_deref() != Some("camt.053")
    {
        return Err(reject(
            "Importez le relevé camt.053 définitif avant de rapprocher cette dépense.",
        ));
    }
    if movement_field(movement, "credit_debit") != Some("DBIT")
        || movement["reversal"].as_bool() == Some(true)
        || movement["reversal"].as_i64() == Some(1)
    {
        return Err(reject(
            "Seul un débit bancaire sans extourne peut régler une dépense.",
        ));
    }
    if movement_tx_detail_count(movement) != 1
        || !movement_field(movement, "strong_key").is_some_and(|key| !key.is_empty())
    {
        return Err(reject(
            "Le mouvement doit identifier un règlement unique avec une référence bancaire stable.",
        ));
    }
    let account = movement_field(movement, "account_id").unwrap_or_default();
    if movement_field(movement, "currency") != Some("CHF")
        || movement_field(movement, "account_currency") != Some("CHF")
    {
        return Err(reject(
            "Le mouvement et la dépense doivent être en CHF, sans conversion de devise.",
        ));
    }
    if account_link_source(connection, account, "CHF")? == "unlinked" {
        return Err(reject(
            "Associez d’abord ce compte bancaire à votre entreprise.",
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
    validate_date(date, "date bancaire")?;
    if date > chrono::Local::now().format("%Y-%m-%d").to_string().as_str() {
        return Err(reject("La date bancaire ne peut pas être future."));
    }
    Ok(date.into())
}

fn expense_state(
    connection: &Connection,
    expense: &Value,
    amount: i64,
    date: &str,
    date_difference_justified: bool,
) -> AppResult<()> {
    let id = movement_field(expense, "id").unwrap_or_default();
    let other: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE expense_id=?)",
        params![id],
        |row| row.get(0),
    )?;
    if other {
        return Err(reject(
            "Cette dépense est déjà reliée à un autre mouvement bancaire.",
        ));
    }
    if amount <= 0
        || expense["total_cents"].as_i64() != Some(amount)
        || movement_field(expense, "currency") != Some("CHF")
    {
        return Err(reject(
            "Le montant TTC et la devise doivent correspondre exactement à la dépense.",
        ));
    }
    let expense_date = movement_field(expense, "date").unwrap_or_default();
    validate_date(expense_date, "date de la dépense")?;
    if date < expense_date {
        return Err(reject("La date bancaire précède la dépense."));
    }
    match movement_field(expense, "payment_status") {
        Some("pending") => {
            ensure_accounting_date_open(connection, date)?;
        }
        Some("paid") => {
            let paid_date = movement_field(expense, "paid_at").unwrap_or(expense_date);
            if paid_date != date && !date_difference_justified {
                return Err(reject("La date du paiement comptabilisé diffère de la date bancaire. Documentez cet écart (5 à 500 caractères) avant de rapprocher les deux pièces sans modifier la comptabilité."));
            }
            paid_journal(connection, id, amount, paid_date)?;
        }
        _ => return Err(reject("L’état du paiement de la dépense est invalide.")),
    }
    Ok(())
}

fn paid_journal(
    connection: &Connection,
    expense: &str,
    amount: i64,
    date: &str,
) -> AppResult<String> {
    let journal: Option<String>=connection.query_row(
        "SELECT j.id FROM journal_entries j WHERE j.source_type='expense' AND j.source_id=?1 AND j.source_event='create' AND j.entry_date=?2 AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reversal_of=j.id) AND (SELECT COALESCE(SUM(l.credit_cents-l.debit_cents),0) FROM journal_lines l JOIN accounting_settings s ON s.bank_account_id=l.account_id AND s.id=1 AND s.enabled=1 WHERE l.journal_entry_id=j.id AND l.currency='CHF')=?3 AND NOT EXISTS(SELECT 1 FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.currency<>'CHF')",
        params![expense,date,amount],|row|row.get(0)).optional()?;
    journal.ok_or_else(||reject("La dépense ne possède pas de paiement comptabilisé actif correspondant au compte bancaire, à la date et au montant."))
}

pub(super) fn suggestion(connection: &Connection, movement: &Value) -> AppResult<Value> {
    let id = movement_field(movement, "id").unwrap_or_default();
    let linked: bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM bank_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_supplier_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE movement_id=?1)",params![id],|row|row.get(0))?;
    if linked {
        return Ok(json!({"reason":"Ce mouvement est déjà rapproché.","candidates":[]}));
    }
    let date = match eligible_movement(connection, movement) {
        Ok(date) => date,
        Err(AppError::Validation(reason)) => return Ok(json!({"reason":reason,"candidates":[]})),
        Err(error) => return Err(error),
    };
    let amount = movement["amount_cents"].as_i64().unwrap_or(0);
    let mut candidates = Vec::new();
    for expense in query_all(connection,"SELECT * FROM expenses e WHERE total_cents=? AND currency='CHF' AND NOT EXISTS(SELECT 1 FROM bank_expense_reconciliations r WHERE r.expense_id=e.id) ORDER BY date DESC,created_at DESC,id",params![amount])? {
        let problem=match expense_state(connection,&expense,amount,&date,true) {
            Ok(())=>None,
            Err(AppError::Validation(reason))=>Some(reason),
            Err(error)=>return Err(error),
        };
        let paid_date=movement_field(&expense,"paid_at").or_else(||movement_field(&expense,"date")).unwrap_or_default();
        let requires_reason=expense["payment_status"]=="paid" && paid_date!=date;
        candidates.push(json!({"expense_id":expense["id"],"supplier":expense["supplier"],"reference":expense["reference"],"category":expense["category"],"date":expense["date"],"paid_at":paid_date,"requires_date_reason":requires_reason,"payment_status":expense["payment_status"],"total_cents":amount,"confirmable":problem.is_none(),"reason":problem.unwrap_or_else(||if requires_reason {"Les dates du journal et du relevé diffèrent : un motif est requis.".into()} else if expense["payment_status"]=="paid" {"Paiement déjà comptabilisé : aucune nouvelle écriture.".into()} else {"Le relevé réglera cette dépense à la date bancaire.".into()})}));
    }
    Ok(
        json!({"reason":"Choisissez une dépense du même montant ; vérifiez sa pièce justificative avant de confirmer.","can_create":ensure_accounting_date_open(connection,&date).is_ok() && amount>0,"candidates":candidates}),
    )
}

impl LocalStore {
    pub fn confirm_expense_bank_reconciliation(
        &self,
        input: ConfirmExpenseBankReconciliationInput,
    ) -> AppResult<Value> {
        let movement_id = Uuid::parse_str(input.movement_id.trim())
            .map_err(|_| reject("L’identifiant bancaire est invalide."))?
            .to_string();
        let expense_id = input.expense_id.trim();
        let reason = input
            .date_difference_reason
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if reason.is_some_and(|value| value.chars().count() > 500) {
            return Err(reject("Le motif doit contenir au plus 500 caractères."));
        }
        if expense_id.is_empty() {
            return Err(reject("Choisissez explicitement une dépense."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let request_id = input
            .request_id
            .as_deref()
            .map(|value| {
                Uuid::parse_str(value.trim())
                    .map(|id| id.to_string())
                    .map_err(|_| reject("Identifiant de tentative invalide."))
            })
            .transpose()?;
        if let Some(id) = &request_id {
            let previous: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM bank_expense_reconciliation_registry WHERE id=?)",
                params![id],
                |r| r.get(0),
            )?;
            if previous && !tx.query_row("SELECT EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE id=?1 AND movement_id=?2 AND expense_id=?3 AND date_difference_reason IS ?4)",params![id,movement_id,expense_id,reason],|r|r.get::<_,bool>(0))? {
                return Err(reject("Cette tentative a déjà été utilisée ou son rapprochement a été dissocié. Actualisez les mouvements avant un nouveau choix."));
            }
        } else if !correction_history(&tx, &movement_id)?.is_empty() {
            return Err(reject(
                "Ce mouvement a déjà été corrigé. Une nouvelle tentative explicite est requise.",
            ));
        }
        let expense = query_record_tx(&tx, "expenses", expense_id)?;
        // Replay is read-only and remains possible after closing or unlinking the bank account.
        if let Some(link) = existing(&tx, &movement_id)? {
            if request_id.as_deref().is_some_and(|id| link["id"] != id) {
                return Err(reject("Ce mouvement a déjà été rapproché par une autre tentative. Actualisez les données."));
            }
            if link["expense_id"] != expense_id {
                return Err(reject(
                    "Ce mouvement est déjà rapproché avec une autre dépense.",
                ));
            }
            if link["date_difference_reason"].as_str() != reason {
                return Err(reject(
                    "Ce rapprochement a déjà été enregistré avec un autre motif.",
                ));
            }
            let date = movement_field(&expense, "paid_at")
                .or_else(|| movement_field(&expense, "date"))
                .unwrap_or_default();
            let journal = paid_journal(
                &tx,
                expense_id,
                link["amount_cents"].as_i64().unwrap_or(0),
                date,
            )?;
            if link["journal_entry_id"] != journal {
                return Err(reject("La preuve comptable du rapprochement a changé."));
            }
            return Ok(json!({"reconciliation":link,"expense":expense,"already_recorded":true}));
        }
        let linked:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM bank_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_supplier_reconciliations WHERE movement_id=?1)",params![movement_id],|row|row.get(0))?;
        if linked {
            return Err(reject("Ce mouvement est déjà rapproché avec une facture."));
        }
        let movement = query_record_tx(&tx, "bank_movements", &movement_id)?;
        let date = eligible_movement(&tx, &movement)?;
        let amount = movement["amount_cents"].as_i64().unwrap_or(0);
        expense_state(
            &tx,
            &expense,
            amount,
            &date,
            reason.is_some_and(|value| value.chars().count() >= 5),
        )?;
        let now = now_iso();
        let was_paid = expense["payment_status"] == "paid";
        if !was_paid {
            tx.execute("UPDATE expenses SET payment_status='paid',paid_at=?,updated_at=? WHERE id=? AND payment_status='pending'",params![date,now,expense_id])?;
            post_expense_if_enabled(&tx,expense_id)?.ok_or_else(||reject("Activez la comptabilité et ses comptes de liaison avant de régler une dépense."))?;
            append_audit(
                &tx,
                "pay_from_bank",
                "expenses",
                expense_id,
                &json!({"before":expense,"after":query_record_tx(&tx,"expenses",expense_id)?,"movement_id":movement_id}),
            )?;
        }
        let accounting_date = if was_paid {
            movement_field(&expense, "paid_at")
                .or_else(|| movement_field(&expense, "date"))
                .unwrap_or_default()
        } else {
            &date
        };
        let journal = paid_journal(&tx, expense_id, amount, accounting_date)?;
        let id = request_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        tx.execute("INSERT INTO bank_expense_reconciliations(id,movement_id,expense_id,journal_entry_id,amount_cents,date_difference_reason,confirmed_at) VALUES(?,?,?,?,?,?,?)",params![id,movement_id,expense_id,journal,amount,reason,now])?;
        let link = existing(&tx, &movement_id)?
            .ok_or_else(|| reject("La preuve du rapprochement est manquante."))?;
        append_audit(&tx, "confirm", "bank_expense_reconciliation", &id, &link)?;
        let result = json!({"reconciliation":link,"expense":query_record_tx(&tx,"expenses",expense_id)?,"already_paid":was_paid});
        tx.commit()?;
        Ok(result)
    }
}
