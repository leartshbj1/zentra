use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::TransactionBehavior;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{database::LocalStore, error::{AppError, AppResult}};

#[derive(Debug, Clone, Deserialize)]
pub struct RefundAttachmentInput {
    pub original_name: String,
    pub content_base64: String,
}

impl RefundAttachmentInput {
    pub(crate) fn decode(&self) -> AppResult<Vec<u8>> {
        const MAX_BYTES: usize = 25 * 1024 * 1024;
        if self.content_base64.len() > MAX_BYTES.div_ceil(3) * 4 {
            return Err(AppError::Validation("Le justificatif dépasse 25 Mo.".into()));
        }
        let bytes = STANDARD.decode(&self.content_base64)
            .map_err(|_| AppError::Validation("Le justificatif est illisible.".into()))?;
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err(AppError::Validation("Joignez un justificatif de 1 octet à 25 Mo.".into()));
        }
        Ok(bytes)
    }
}

impl LocalStore {
    pub fn add_expense_refund_attachment(&self, refund_id: &str, input: RefundAttachmentInput) -> AppResult<Value> {
        let refund_id = Uuid::parse_str(refund_id.trim())
            .map_err(|_| AppError::Validation("Remboursement invalide.".into()))?.to_string();
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let bytes = input.decode()?;
        let mut prepared = self.prepare_supplier_invoice_attachment_bytes(&input.original_name, &bytes)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = self.insert_prepared_expense_refund_attachment(&tx, &refund_id, &prepared)?;
        if inserted.created { prepared.install()?; }
        tx.commit()?;
        if inserted.created { prepared.retain(); }
        Ok(inserted.record)
    }
}
