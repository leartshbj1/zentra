use crate::{
    account_cloud::project_sync_session, database::LocalStore, error::command_error,
    models::SaveAgendaEventInput,
};
use reqwest::Method;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use tauri::State;
pub(crate) const PATH: &str = "/api/appointments";
#[tauri::command]
pub async fn appointment_inbox_request(
    state: State<'_, LocalStore>,
    data: Option<Value>,
) -> Result<Value, String> {
    let store = state.inner().clone();
    let _account = store.account_protected_cache.operation_lock.lock().await;
    let session = project_sync_session(&store)
        .await
        .map_err(command_error)?
        .ok_or("Connectez votre compte dans les paramètres.")?;
    crate::automation::bound(&store, &session.organization_id).map_err(command_error)?;
    let data = data.unwrap_or(Value::Null);
    if data.is_null() {
        let (_, bytes) = session
            .request(Method::GET, PATH, &[], &[], None, false)
            .await
            .map_err(command_error)?;
        return serde_json::from_slice(&bytes).map_err(|_| "La réception est indisponible.".into());
    }
    if session.role == "read_only" {
        return Err("Votre rôle permet la consultation uniquement.".into());
    }
    let id = data["id"]
        .as_str()
        .filter(|v| uuid::Uuid::parse_str(v).is_ok())
        .ok_or("Choisissez un rendez-vous.")?;
    let action = data["action"].as_str().unwrap_or("");
    if action == "ignore" {
        let (_, bytes) = session
            .request(
                Method::POST,
                PATH,
                &[],
                &[("Content-Type", "application/json".into())],
                Some(serde_json::to_vec(&data).unwrap()),
                false,
            )
            .await
            .map_err(command_error)?;
        return serde_json::from_slice(&bytes).map_err(|_| "Réponse invalide.".into());
    }
    if action != "import" {
        return Err("Action inconnue.".into());
    }
    let automatic = data["automatic"] == true;
    let (_, bytes) = session
        .request(
            Method::POST,
            PATH,
            &[],
            &[("Content-Type", "application/json".into())],
            Some(
                serde_json::to_vec(&json!({"action":"claim","id":id,"automatic":automatic}))
                    .unwrap(),
            ),
            false,
        )
        .await
        .map_err(command_error)?;
    let claim: Value = serde_json::from_slice(&bytes).map_err(|_| "Réponse invalide.")?;
    if claim["item"]["organizationId"] != session.organization_id || claim["item"]["id"] != id {
        return Err("Le rendez-vous appartient à une autre entreprise.".into());
    }
    if claim["alreadyImported"] == true {
        return Ok(json!({"id":id,"alreadyImported":true}));
    }
    let result = (|| -> Result<Value, String> {
        let _guard = store.lock().map_err(command_error)?;
        store.require_write_access().map_err(command_error)?;
        crate::automation::bound(&store, &session.organization_id).map_err(command_error)?;
        apply_import(&store, id, automatic, &claim, &data)
    })();
    match result {
        Ok(result) => {
            let _=session.request(Method::POST,PATH,&[],&[("Content-Type","application/json".into())],Some(serde_json::to_vec(&json!({"action":"finish","id":id,"claimToken":claim["claimToken"],"automatic":automatic})).unwrap()),false).await;
            Ok(result)
        }
        Err(reason) => {
            let _=session.request(Method::POST,PATH,&[],&[("Content-Type","application/json".into())],Some(serde_json::to_vec(&json!({"action":"release","id":id,"claimToken":claim["claimToken"],"reason":reason})).unwrap()),false).await;
            Err(reason)
        }
    }
}

// Caller holds the company/write guard; keep this operation independently testable.
fn apply_import(
    store: &LocalStore,
    id: &str,
    automatic: bool,
    claim: &Value,
    data: &Value,
) -> Result<Value, String> {
    let db = store.connect().map_err(command_error)?;
    let existing: Option<String> = db
        .query_row(
            "SELECT updated_at FROM agenda_events WHERE id=?",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if existing.is_some() && claim["item"]["importedAt"].is_null() {
        return Ok(json!({"id":id,"saved":true}));
    }
    let e = &claim["item"]["extraction"];
    let mut input: SaveAgendaEventInput = if automatic {
        if !e["issues"].as_array().is_some_and(|v| v.is_empty()) || e["status"] != "scheduled" {
            return Err("Vérifiez ce rendez-vous avant de l’ajouter.".into());
        }
        serde_json::from_value(json!({"id":id,"create_only":true,"title":e["title"],"start_date":e["startDate"],"end_date":e["endDate"],"start_time":e["startTime"],"end_time":e["endTime"],"all_day":e["allDay"],"location":e["location"],"notes":format!("Reçu depuis Zentra Support · {}\n{}",claim["item"]["sender"].as_str().unwrap_or(""),e["notes"].as_str().unwrap_or("")),"kind":"appointment","status":"scheduled"})).map_err(|_|"Informations incomplètes.")?
    } else {
        serde_json::from_value(data["event"].clone())
            .map_err(|_| "Complétez le rendez-vous avant de l’ajouter.")?
    };
    input.id = Some(id.into());
    input.create_only = existing.is_none();
    if existing.is_some() && (automatic || input.expected_updated_at.is_none()) {
        return Err("Ce rendez-vous existe déjà. Ouvrez-le pour confirmer sa modification.".into());
    }
    store.save_agenda_event(input).map_err(command_error)?;
    Ok(json!({"id":id,"saved":true}))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, LocalStore, String, Value) {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
        let now = crate::database::now_iso();
        store.connect().unwrap().execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Agenda test',?,?)",params![now,now]).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let claim = json!({"item":{"id":id,"importedAt":null,"sender":"client@example.test","extraction":{"title":"Visite confirmée","startDate":"2026-09-23","endDate":"2026-09-23","startTime":"09:00","endTime":"10:00","allDay":false,"location":"Genève","notes":"Prendre les plans","status":"scheduled","issues":[]}}});
        (dir, store, id, claim)
    }
    #[test]
    fn appointment_import_is_visible_to_shared_agenda_and_ack_retry_keeps_user_edits() {
        let (_d, store, id, claim) = fixture();
        apply_import(&store, &id, true, &claim, &Value::Null).unwrap();
        let w = store.get_workspace().unwrap();
        let e = &w["agenda_events"][0];
        assert_eq!(e["title"], "Visite confirmée");
        assert_eq!(e["start_time"], "09:00");
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE agenda_events SET title='Titre corrigé' WHERE id=?",
                params![id],
            )
            .unwrap();
        apply_import(&store, &id, false, &claim, &Value::Null).unwrap();
        let w = store.get_workspace().unwrap();
        assert_eq!(w["agenda_events"].as_array().unwrap().len(), 1);
        assert_eq!(w["agenda_events"][0]["title"], "Titre corrigé");
    }
    #[test]
    fn incomplete_event_leaves_no_agenda_entry_and_updates_require_confirmation() {
        let (_d, store, id, mut claim) = fixture();
        claim["item"]["extraction"]["endTime"] = json!("");
        assert!(apply_import(&store, &id, true, &claim, &Value::Null).is_err());
        assert!(store.get_workspace().unwrap()["agenda_events"]
            .as_array()
            .unwrap()
            .is_empty());
        claim["item"]["extraction"]["endTime"] = json!("10:00");
        apply_import(&store, &id, true, &claim, &Value::Null).unwrap();
        claim["item"]["importedAt"] = json!(123);
        claim["item"]["extraction"]["startTime"] = json!("09:30");
        assert!(apply_import(&store, &id, true, &claim, &Value::Null).is_err());
        assert_eq!(
            store.get_workspace().unwrap()["agenda_events"][0]["start_time"],
            "09:00"
        );
    }
}
