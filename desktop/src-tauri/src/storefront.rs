//! Page du commerce sur <adresse>.zentraapp.ch : lecture, vérification de
//! l'adresse, enregistrement et demandes reçues. Le serveur décide seul de
//! l'unicité de l'adresse ; l'app ne fait que relayer des corps bornés.
use reqwest::Method;
use serde_json::{json, Value};
use tauri::State;

use crate::{
    database::LocalStore,
    error::{command_error, AppError},
    public_api::{checked_reply, post_json, session_for},
};

pub(crate) const PATH: &str = "/api/account/storefront";
pub(crate) const CHECK_PATH: &str = "/api/account/storefront/check";
pub(crate) const REQUESTS_PATH: &str = "/api/account/storefront/requests";
const MAX_BODY_BYTES: usize = 32 * 1024;

fn invalid(message: &str) -> String {
    message.to_string()
}

fn text(value: &Value, max_chars: usize) -> Option<String> {
    value.as_str().filter(|s| s.chars().count() <= max_chars).map(str::to_string)
}

fn cursor(value: &Value) -> Option<Option<String>> {
    match value {
        Value::Null => Some(None),
        Value::String(s) if s.len() <= 15 && s.starts_with("sr1_") && s[4..].chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()) => Some(Some(s.clone())),
        _ => None,
    }
}

/// Une seule commande, quatre actions : `read`, `check`, `save`, `requests`.
#[tauri::command]
pub async fn storefront_request(state: State<'_, LocalStore>, input: Value) -> Result<Value, String> {
    let store = state.inner().clone();
    let action = input["action"].as_str().unwrap_or_default();
    match action {
        "read" => {
            let session = session_for(&store, false).await.map_err(command_error)?;
            let (_, bytes) = session.request(Method::GET, PATH, &[], &[], None, false).await.map_err(command_error)?;
            checked_reply(&bytes, &session.organization_id).map_err(command_error)
        }
        "check" => {
            let slug = text(&input["slug"], 120).ok_or_else(|| invalid("Adresse illisible."))?;
            let locality = text(&input["locality"], 80).unwrap_or_default();
            let canton = text(&input["canton"], 40).unwrap_or_default();
            let session = session_for(&store, true).await.map_err(command_error)?;
            post_json(&session, CHECK_PATH, &json!({ "schemaVersion": 1, "slug": slug, "locality": locality, "canton": canton }))
                .await
                .map_err(command_error)
        }
        "save" => {
            let slug = text(&input["slug"], 40).ok_or_else(|| invalid("Adresse illisible."))?;
            let published = input["published"].as_bool().ok_or_else(|| invalid("Réglage illisible."))?;
            if !input["profile"].is_object() {
                return Err(invalid("Informations de la page illisibles."));
            }
            let body = json!({ "schemaVersion": 1, "slug": slug, "published": published, "profile": input["profile"] });
            if serde_json::to_vec(&body).map(|v| v.len()).unwrap_or(usize::MAX) > MAX_BODY_BYTES {
                return Err(invalid("Les informations de la page sont trop longues."));
            }
            let session = session_for(&store, true).await.map_err(command_error)?;
            post_json(&session, PATH, &body).await.map_err(command_error)
        }
        "requests" => {
            let after = cursor(&input["cursor"]).ok_or_else(|| invalid("Position illisible."))?;
            let limit = input["limit"].as_u64().filter(|n| (1..=100).contains(n)).unwrap_or(50).to_string();
            let session = session_for(&store, false).await.map_err(command_error)?;
            let mut query: Vec<(&str, &str)> = vec![("limit", limit.as_str())];
            if let Some(value) = after.as_deref() {
                query.push(("cursor", value));
            }
            let (_, bytes) = session.request(Method::GET, REQUESTS_PATH, &query, &[], None, false).await.map_err(command_error)?;
            checked_reply(&bytes, &session.organization_id).map_err(command_error)
        }
        _ => Err(command_error(AppError::Validation("Action inconnue.".into()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_request_cursors() {
        assert_eq!(cursor(&Value::Null), Some(None));
        assert_eq!(cursor(&json!("sr1_2s")), Some(Some("sr1_2s".into())));
        assert_eq!(cursor(&json!("pb1_2s")), None);
        assert_eq!(cursor(&json!("sr1_A")), None);
        assert_eq!(cursor(&json!("sr1_&limit=1")), None);
        assert_eq!(cursor(&json!(12)), None);
    }

    #[test]
    fn bounds_texts_in_characters() {
        assert_eq!(text(&json!("é".repeat(40)), 40).map(|s| s.chars().count()), Some(40));
        assert_eq!(text(&json!("é".repeat(41)), 40), None);
        assert_eq!(text(&json!(3), 40), None);
    }
}
