use crate::{
    database::{query_all, LocalStore},
    error::{AppError, AppResult},
};
use serde_json::{json, Value};

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn bound(store: &LocalStore, org: &str) -> AppResult<()> {
    if crate::company_collaboration::status(store)?["organizationId"].as_str() != Some(org) {
        return Err(invalid("Connectez et partagez cette entreprise dans Paramètres → Compte et accès. Le travail manuel reste disponible."));
    }
    Ok(())
}
fn resources(store: &LocalStore, org: &str) -> AppResult<Value> {
    let _guard = store.lock()?;
    bound(store, org)?;
    let db = store.connect()?;
    let suppliers=query_all(&db,"SELECT id,substr(name,1,160) AS label FROM suppliers WHERE archived_at IS NULL ORDER BY name,id LIMIT 100",[])?;
    let projects=query_all(&db,"SELECT id,substr(name,1,160) AS label FROM projects WHERE status NOT IN ('closed','completed') ORDER BY name,id LIMIT 100",[])?;
    let extra: String = db.query_row(
        "SELECT COALESCE(extra_settings_json,'{}') FROM settings WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    let settings: Value = serde_json::from_str(&extra).unwrap_or(json!({}));
    let categories: Vec<Value> = settings["work"]["costCategories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .filter(|v| !v.trim().is_empty() && v.chars().count() <= 160)
        .take(100)
        .map(|v| json!({"id":v,"label":v}))
        .collect();
    Ok(
        json!({"organizationId":org,"suppliers":suppliers,"projects":projects,"expenseCategories":categories}),
    )
}
pub(crate) fn prepare_request(
    store: &LocalStore,
    org: &str,
    role: &str,
    mut value: Value,
) -> AppResult<Value> {
    if serde_json::to_vec(&value)?.len() > 12000 {
        return Err(invalid("Sélectionnez un extrait plus court."));
    }
    let object = value
        .as_object_mut()
        .ok_or_else(|| invalid("La demande est invalide."))?;
    object.remove("nativeResources");
    object.insert("organizationId".into(), json!(org));
    let action = object
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !["decide", "feedback", "settings"].contains(&action.as_str()) {
        return Err(invalid("Cette action n’est pas disponible."));
    }
    if action == "settings" && !["owner", "admin"].contains(&role) {
        return Err(invalid(
            "Seul le titulaire ou un administrateur peut changer les réglages.",
        ));
    }
    if action == "feedback" && role == "read_only" {
        return Err(invalid("Votre rôle permet la consultation uniquement."));
    }
    if action == "decide" || action == "feedback" {
        bound(store, org)?;
        // Never accept resource candidates or arbitrary backend functions from the WebView.
        if object.get("feature").and_then(Value::as_str) == Some("supplier_routing")
            || action == "feedback"
        {
            object.insert("nativeResources".into(), resources(store, org)?);
        }
    }
    Ok(value)
}
pub(crate) fn validate_response(store: &LocalStore, org: &str, value: &Value) -> AppResult<()> {
    if value.get("organizationId").is_some() && value["organizationId"].as_str() != Some(org) {
        return Err(invalid("La réponse ne correspond pas à votre entreprise."));
    }
    if let Some(ids) = value["resourceIds"].as_object() {
        if !ids.is_empty() {
            let available = resources(store, org)?;
            for (key, id) in ids {
                if id.is_null() {
                    continue;
                }
                let list = match key.as_str() {
                    "supplier" => "suppliers",
                    "project" => "projects",
                    "expense_category" => "expenseCategories",
                    _ => return Err(invalid("La suggestion contient une ressource inconnue.")),
                };
                if !available[list]
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| row["id"] == *id))
                {
                    return Err(invalid("Les données ont changé. Relancez la suggestion."));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, LocalStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().into()).unwrap();
        std::fs::write(
            dir.path().join("company-collaboration.json"),
            r#"{"organization_id":"org_a"}"#,
        )
        .unwrap();
        store.connect().unwrap().execute("INSERT OR IGNORE INTO settings(id,onboarding_completed,company_name,noga_section,noga_division,activity_description,created_at,updated_at) VALUES(1,1,'Test','F','43','Peinture','now','now')",[]).unwrap();
        (dir, store)
    }
    #[test]
    fn refuses_another_company() {
        let (_dir, store) = fixture();
        assert!(prepare_request(
            &store,
            "org_b",
            "owner",
            json!({"action":"decide","feature":"supplier_routing"})
        )
        .is_err());
    }
    #[test]
    fn ignores_webview_resources_and_reads_only_current_database() {
        let (_dir, store) = fixture();
        let db = store.connect().unwrap();
        db.execute("INSERT INTO suppliers(id,name,created_at,updated_at) VALUES('supplier_a','Matériel SA','now','now')",[]).unwrap();
        db.execute("INSERT INTO suppliers(id,name,archived_at,created_at,updated_at) VALUES('archived','Old','now','now','now')",[]).unwrap();
        drop(db);
        let value=prepare_request(&store,"org_a","owner",json!({"action":"decide","feature":"supplier_routing","organizationId":"org_b","nativeResources":{"suppliers":[{"id":"foreign","label":"Foreign"}]}})).unwrap();
        assert_eq!(value["organizationId"], "org_a");
        assert_eq!(
            value["nativeResources"]["suppliers"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(value["nativeResources"]["suppliers"][0]["id"], "supplier_a");
        assert!(!value.to_string().contains("foreign"));
    }
    #[test]
    fn rejects_unknown_actions_and_read_only_edits() {
        let (_dir, store) = fixture();
        for action in ["pay", "delete", "export", "execute"] {
            assert!(prepare_request(&store, "org_a", "owner", json!({"action":action})).is_err());
        }
        assert!(
            prepare_request(&store, "org_a", "read_only", json!({"action":"feedback"})).is_err()
        );
        assert!(prepare_request(&store, "org_a", "member", json!({"action":"settings"})).is_err());
    }
    #[test]
    fn rejects_ids_removed_since_the_request() {
        let (_dir, store) = fixture();
        assert!(validate_response(
            &store,
            "org_a",
            &json!({"resourceIds":{"supplier":"foreign"}})
        )
        .is_err());
        assert!(validate_response(
            &store,
            "org_a",
            &json!({"resourceIds":{"payment":"anything"}})
        )
        .is_err());
        assert!(validate_response(&store, "org_a", &json!({"organizationId":"org_b"})).is_err());
    }
}
