//! Correct the bank association without changing the underlying purchase or payment.
use super::*;
use crate::models::UnreconcileBankExpenseInput;

impl LocalStore {
    pub fn unreconcile_bank_expense(&self, input: UnreconcileBankExpenseInput) -> AppResult<Value> {
        let request_id = Uuid::parse_str(input.request_id.trim())
            .map_err(|_| reject("Identifiant de tentative invalide."))?
            .to_string();
        let reconciliation_id = Uuid::parse_str(input.reconciliation_id.trim())
            .map_err(|_| reject("Rapprochement invalide."))?
            .to_string();
        let reason = input.reason.trim();
        if !(5..=500).contains(&reason.chars().count()) || reason.contains('\0') {
            return Err(reject(
                "Documentez la correction avec un motif de 5 à 500 caractères.",
            ));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(history) = query_all(
            &tx,
            "SELECT * FROM bank_expense_unreconciliations WHERE request_id=?",
            params![request_id],
        )?
        .into_iter()
        .next()
        {
            if history["id"] != reconciliation_id || history["reason"] != reason {
                return Err(reject(
                    "Cette tentative de correction a déjà été enregistrée avec d’autres données.",
                ));
            }
            return Ok(json!({"history":history,"already_recorded":true}));
        }
        let original=query_all(&tx,"SELECT * FROM bank_expense_reconciliations WHERE id=?",params![reconciliation_id])?.into_iter().next().ok_or_else(||reject("Ce rapprochement n’est plus actif. Actualisez les données avant de corriger une autre association."))?;
        // The correction is administrative. It remains possible after closing or bank
        // dissociation; the immutable original journal, amount and VAT remain unchanged.
        let payment_valid: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM expenses e JOIN journal_entries j ON j.id=?2 WHERE e.id=?1 AND e.payment_status='paid' AND e.total_cents=?3 AND e.currency='CHF' AND j.source_type='expense' AND j.source_id=e.id AND j.entry_date=COALESCE(e.paid_at,e.date) AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reversal_of=j.id))",params![original["expense_id"].as_str(),original["journal_entry_id"].as_str(),original["amount_cents"].as_i64()],|r|r.get(0))?;
        if !payment_valid {
            return Err(reject("La preuve du paiement a changé. Contrôlez le journal avant de modifier l’association bancaire."));
        }
        tx.execute("INSERT INTO bank_expense_unreconciliations(id,request_id,movement_id,expense_id,journal_entry_id,amount_cents,date_difference_reason,confirmed_at,reason,unlinked_at) SELECT id,?,movement_id,expense_id,journal_entry_id,amount_cents,date_difference_reason,confirmed_at,?,? FROM bank_expense_reconciliations WHERE id=?",params![request_id,reason,now_iso(),reconciliation_id])?;
        if tx.execute(
            "DELETE FROM bank_expense_reconciliations WHERE id=?",
            params![reconciliation_id],
        )? != 1
        {
            return Err(reject("Le rapprochement a changé pendant la correction."));
        }
        let history = query_record_tx(&tx, "bank_expense_unreconciliations", &reconciliation_id)?;
        append_audit(
            &tx,
            "unreconcile_preserving_payment",
            "bank_expense_reconciliation",
            &reconciliation_id,
            &json!({"original":original,"correction":history,"payment_preserved":true}),
        )?;
        tx.commit()?;
        Ok(json!({"history":history,"already_recorded":false}))
    }
}
