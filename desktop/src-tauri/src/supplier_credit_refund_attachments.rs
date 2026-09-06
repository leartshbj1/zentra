use crate::{
    database::LocalStore,
    error::{AppError, AppResult},
    expense_refund_attachments::RefundAttachmentInput,
};
use rusqlite::TransactionBehavior;
use serde_json::Value;
use uuid::Uuid;

impl LocalStore {
    pub fn add_supplier_credit_refund_attachment(
        &self,
        refund_id: &str,
        input: RefundAttachmentInput,
    ) -> AppResult<Value> {
        let refund_id = Uuid::parse_str(refund_id.trim())
            .map_err(|_| AppError::Validation("Remboursement invalide.".into()))?
            .to_string();
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let bytes = input.decode()?;
        let mut prepared =
            self.prepare_supplier_invoice_attachment_bytes(&input.original_name, &bytes)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted =
            self.insert_prepared_supplier_credit_refund_attachment(&tx, &refund_id, &prepared)?;
        if inserted.created {
            prepared.install()?;
        }
        tx.commit()?;
        if inserted.created {
            prepared.retain();
        }
        Ok(inserted.record)
    }
}
