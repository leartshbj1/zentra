//! État du dossier pour la fiduciaire. L'app calcule elle-même un résumé de
//! santé (des nombres et des dates, jamais un montant, un nom ou une pièce) et
//! le publie quand l'entreprise active le partage. Le serveur le montre aux
//! membres de l'entreprise, par exemple à sa fiduciaire, dans /compte/fiduciaire.

use reqwest::Method;
use rusqlite::TransactionBehavior;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::{
    account_cloud::project_sync_session,
    audit::append_audit,
    database::LocalStore,
    error::{command_error, AppError, AppResult},
};

pub(crate) const PATH: &str = "/api/account/fiduciary/summary";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HealthSummary {
    pub version: u8,
    pub computed_at: String,
    pub missing_receipts: u32,
    pub unreconciled_bank: u32,
    pub vat_filed_through: Option<String>,
    pub closed_through: Option<String>,
    pub accounting_enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    saved: bool,
    received_at: Option<i64>,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

fn is_day(value: &str) -> bool {
    value.len() == 10 && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

impl HealthSummary {
    fn check(&self) -> AppResult<()> {
        let dates_ok = [&self.vat_filed_through, &self.closed_through].iter().all(|value| value.as_deref().is_none_or(is_day));
        if self.version != 1
            || self.computed_at.is_empty()
            || self.computed_at.len() > 40
            || chrono::DateTime::parse_from_rfc3339(&self.computed_at).is_err()
            || self.missing_receipts > 1_000_000
            || self.unreconciled_bank > 1_000_000
            || !dates_ok
        {
            return Err(invalid("Le résumé du dossier est invalide."));
        }
        Ok(())
    }
}

fn record(store: &LocalStore, action: &str, payload: &Value) -> AppResult<()> {
    let mut connection = store.connect()?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    append_audit(&tx, action, "fiduciary_summary", "company", payload)?;
    tx.commit()?;
    Ok(())
}

async fn send(store: &LocalStore, method: Method, summary: Option<&HealthSummary>) -> AppResult<Value> {
    let session = project_sync_session(store)
        .await?
        .ok_or_else(|| invalid("Connectez ce poste au compte Zentra de l’entreprise pour partager l’état du dossier."))?;
    if session.role == "read_only" {
        return Err(invalid("Votre rôle ne permet pas de partager l’état du dossier."));
    }
    let body = summary.map(serde_json::to_vec).transpose()?;
    let (_, bytes) = session
        .request(method, PATH, &[], &[("Content-Type", "application/json".into())], body, false)
        .await?;
    let reply: Reply = serde_json::from_slice(&bytes).map_err(|_| invalid("La réponse du compte Zentra est illisible."))?;
    Ok(json!({ "saved": reply.saved, "received_at": reply.received_at }))
}

#[tauri::command]
pub async fn publish_fiduciary_summary(state: State<'_, LocalStore>, summary: HealthSummary) -> Result<Value, String> {
    summary.check().map_err(command_error)?;
    let store = state.inner().clone();
    let result = send(&store, Method::POST, Some(&summary)).await.map_err(command_error)?;
    let audited = store.clone();
    let payload = json!({ "summary": summary, "received_at": result["received_at"] });
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = audited.lock()?;
        record(&audited, "publish", &payload)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(command_error)?;
    Ok(result)
}

#[tauri::command]
pub async fn stop_fiduciary_summary(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    let result = send(&store, Method::DELETE, None).await.map_err(command_error)?;
    let audited = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = audited.lock()?;
        record(&audited, "stop", &json!({}))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(command_error)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary() -> HealthSummary {
        HealthSummary {
            version: 1,
            computed_at: "2026-10-25T10:00:00.000Z".into(),
            missing_receipts: 3,
            unreconciled_bank: 7,
            vat_filed_through: Some("2026-06-30".into()),
            closed_through: None,
            accounting_enabled: true,
        }
    }

    #[test]
    fn the_summary_carries_counts_and_dates_only() {
        assert!(summary().check().is_ok());
        assert_eq!(
            serde_json::to_value(summary()).unwrap(),
            json!({"version":1,"computedAt":"2026-10-25T10:00:00.000Z","missingReceipts":3,"unreconciledBank":7,"vatFiledThrough":"2026-06-30","closedThrough":null,"accountingEnabled":true})
        );
        let mut late = summary();
        late.vat_filed_through = Some("30.06.2026".into());
        assert!(late.check().is_err());
        let mut odd = summary();
        odd.version = 2;
        assert!(odd.check().is_err());
        assert!(serde_json::from_value::<HealthSummary>(json!({"version":1,"computedAt":"2026-10-25T10:00:00Z","missingReceipts":0,"unreconciledBank":0,"vatFiledThrough":null,"closedThrough":null,"accountingEnabled":false,"clientName":"x"})).is_err());
    }

    #[test]
    fn the_server_reply_is_read_strictly() {
        assert!(serde_json::from_slice::<Reply>(br#"{"saved":true,"received_at":1761390000}"#).is_ok());
        assert!(serde_json::from_slice::<Reply>(br#"{"saved":false,"received_at":null}"#).is_ok());
        assert!(serde_json::from_slice::<Reply>(br#"{"saved":true,"received_at":1,"extra":1}"#).is_err());
    }
}
