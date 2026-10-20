//! Opportunités de vente : de la première demande au devis. L'interface en
//! déduit le pipeline et la prévision pondérée ; quand un devis est lié, son
//! état (émis, accepté, refusé) fait foi.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpportunityInput {
    pub id: Option<String>,
    pub client_id: Option<String>,
    pub prospect_name: String,
    pub title: String,
    pub stage: String,
    pub amount_cents: i64,
    pub expected_close_date: Option<String>,
    pub quote_id: Option<String>,
    pub notes: String,
    pub lost_reason: String,
}

impl LocalStore {
    pub fn save_opportunity(&self, input: OpportunityInput) -> AppResult<Value> {
        let title = input.title.trim().to_owned();
        let prospect = input.prospect_name.trim().to_owned();
        if title.is_empty() || title.chars().count() > 200 {
            return Err(invalid("Décrivez l’opportunité en une phrase (200 caractères au plus)."));
        }
        if input.client_id.is_none() && prospect.is_empty() {
            return Err(invalid("Choisissez un client ou indiquez le nom du prospect."));
        }
        if !matches!(input.stage.as_str(), "lead" | "contact" | "quote" | "won" | "lost") {
            return Err(invalid("Étape inconnue."));
        }
        if !(0..=100_000_000_000).contains(&input.amount_cents) || prospect.chars().count() > 200 || input.notes.chars().count() > 4_000 || input.lost_reason.chars().count() > 500 {
            return Err(invalid("Vérifiez le montant et la longueur des textes."));
        }
        if let Some(date) = input.expected_close_date.as_deref() {
            crate::accounting::validate_date(date, "expected_close_date")?;
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(client) = input.client_id.as_deref() {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM clients WHERE id=?)", [client], |row| row.get(0))?;
            if !exists {
                return Err(invalid("Client introuvable."));
            }
        }
        let now = now_iso();
        let id = match input.id {
            Some(id) => {
                let previous: Option<String> = tx.query_row("SELECT stage FROM opportunities WHERE id=?", [&id], |row| row.get(0)).optional()?;
                let Some(previous) = previous else { return Err(invalid("Opportunité introuvable.")) };
                tx.execute(
                    "UPDATE opportunities SET client_id=?,prospect_name=?,title=?,stage=?,amount_cents=?,expected_close_date=?,quote_id=?,notes=?,lost_reason=?,
                       stage_changed_at=CASE WHEN ?<>? THEN ? ELSE stage_changed_at END,updated_at=? WHERE id=?",
                    params![input.client_id, prospect, title, input.stage, input.amount_cents, input.expected_close_date, input.quote_id, input.notes, input.lost_reason,
                        previous, input.stage, now, now, id],
                )?;
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO opportunities(id,client_id,prospect_name,title,stage,amount_cents,expected_close_date,quote_id,notes,lost_reason,stage_changed_at,created_at,updated_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    params![id, input.client_id, prospect, title, input.stage, input.amount_cents, input.expected_close_date, input.quote_id, input.notes, input.lost_reason, now, now, now],
                )?;
                id
            }
        };
        append_audit(&tx, "save", "opportunities", &id, &json!({ "stage": input.stage, "amount_cents": input.amount_cents, "quote_id": input.quote_id }))?;
        tx.commit()?;
        Ok(json!({ "id": id }))
    }
}

#[tauri::command]
pub fn save_opportunity(state: tauri::State<'_, LocalStore>, input: OpportunityInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_opportunity(input).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: Option<String>, stage: &str) -> OpportunityInput {
        OpportunityInput { id, client_id: None, prospect_name: "Boulangerie Favre".into(), title: "Rénovation du laboratoire".into(), stage: stage.into(), amount_cents: 1_800_000,
            expected_close_date: Some("2026-11-30".into()), quote_id: None, notes: String::new(), lost_reason: String::new() }
    }

    #[test]
    fn stages_are_saved_and_dated() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "opportunities-test").unwrap();
        let id = store.save_opportunity(input(None, "lead")).unwrap()["id"].as_str().unwrap().to_owned();
        assert!(store.save_opportunity(OpportunityInput { prospect_name: String::new(), ..input(None, "lead") }).is_err());
        assert!(store.save_opportunity(input(None, "maybe")).is_err());
        assert!(store.save_opportunity(OpportunityInput { expected_close_date: Some("2026-02-30".into()), ..input(None, "lead") }).is_err());
        assert!(store.save_opportunity(OpportunityInput { client_id: Some("missing".into()), ..input(None, "lead") }).is_err());
        let changed_at = |store: &LocalStore| -> String { store.connect().unwrap().query_row("SELECT stage_changed_at FROM opportunities WHERE id=?", [&id], |row| row.get(0)).unwrap() };
        let first = changed_at(&store);
        std::thread::sleep(std::time::Duration::from_millis(5));
        store.save_opportunity(OpportunityInput { notes: "Rappeler lundi".into(), ..input(Some(id.clone()), "lead") }).unwrap();
        assert_eq!(changed_at(&store), first);
        store.save_opportunity(input(Some(id.clone()), "contact")).unwrap();
        assert_ne!(changed_at(&store), first);
        assert_eq!(store.get_workspace().unwrap()["opportunities"][0]["stage"], "contact");
    }
}
