//! SMS par le compte de l'entreprise (ASPSMS, Swisscom Enterprise SMS ou un
//! service compatible). Éteint tant que l'entreprise n'a pas enregistré son
//! propre compte : l'envoi est facturé par le fournisseur à l'entreprise.
//! Chaque envoi vient d'un brouillon validé ou d'une règle explicite, et il
//! est noté dans sms_messages, réussi ou non. La clé reste chiffrée sur cet
//! appareil, jamais envoyée à Zentra.

use std::{path::PathBuf, time::Duration};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
};

const SECRET_FILE: &str = "sms-provider.key";
const ASPSMS_URL: &str = "https://json.aspsms.com/SendSimpleTextSMS";
const SWISSCOM_URL: &str = "https://api.swisscom.com/messaging/sms";

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmsSettingsInput {
    pub enabled: bool,
    pub provider: String,
    pub sender: String,
    pub account: String,
    pub endpoint: Option<String>,
    pub appointment_reminders_auto: bool,
    /// None : garder la clé enregistrée ; "" : l'effacer.
    pub secret: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendSmsInput {
    pub recipient: String,
    pub body: String,
    pub purpose: String,
    pub origin: String,
    pub related_type: Option<String>,
    pub related_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct Settings {
    enabled: bool,
    provider: String,
    sender: String,
    account: String,
    endpoint: Option<String>,
}

/// Numéro au format international : « 079 123 45 67 » → « +41791234567 ».
pub(crate) fn normalized_phone(value: &str) -> Option<String> {
    let compact: String = value.chars().filter(|c| !matches!(c, ' ' | '.' | '-' | '/' | '(' | ')' | '\u{a0}')).collect();
    let international = if let Some(rest) = compact.strip_prefix("00") {
        format!("+{rest}")
    } else if let Some(rest) = compact.strip_prefix('0') {
        format!("+41{rest}")
    } else {
        compact
    };
    let digits = international.strip_prefix('+')?;
    (digits.len() >= 8 && digits.len() <= 15 && digits.chars().all(|c| c.is_ascii_digit()) && !digits.starts_with('0')).then(|| international.clone())
}

/// Nom d'expéditeur : 11 lettres ou chiffres au plus, ou un numéro international.
pub(crate) fn valid_sender(value: &str) -> bool {
    let value = value.trim();
    (value.starts_with('+') && normalized_phone(value).is_some())
        || (!value.is_empty() && value.chars().count() <= 11 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '.'))
}

/// Requête du fournisseur : adresse, en-têtes et corps JSON. Sans réseau, pour les tests.
pub(crate) fn provider_request(settings: &Settings, secret: &str, recipient: &str, body: &str) -> AppResult<(String, Vec<(&'static str, String)>, Value)> {
    match settings.provider.as_str() {
        "aspsms" => Ok((ASPSMS_URL.into(), Vec::new(), json!({ "UserName": settings.account, "Password": secret, "Originator": settings.sender, "Recipients": [recipient], "MessageText": body }))),
        "swisscom" => Ok((SWISSCOM_URL.into(), vec![("client_id", secret.to_owned()), ("SCS-Version", "2".into())], json!({ "from": settings.sender, "to": recipient, "text": body }))),
        "generic" => {
            let endpoint = settings.endpoint.clone().ok_or_else(|| invalid("Indiquez l’adresse https du service SMS."))?;
            Ok((endpoint, vec![("Authorization", format!("Bearer {secret}"))], json!({ "from": settings.sender, "to": recipient, "text": body })))
        }
        _ => Err(invalid("Fournisseur SMS inconnu.")),
    }
}

/// Réponse du fournisseur : référence du message si l'envoi est accepté.
pub(crate) fn provider_outcome(provider: &str, status: u16, body: &Value) -> Result<Option<String>, String> {
    match provider {
        // ASPSMS répond toujours 200 ; StatusCode « 1 » signifie accepté.
        "aspsms" if body.get("StatusCode").and_then(Value::as_str) == Some("1") => Ok(None),
        "aspsms" => Err(body.get("StatusInfo").and_then(Value::as_str).unwrap_or("Refusé par ASPSMS").chars().take(200).collect()),
        _ if (200..300).contains(&status) => Ok(body.get("id").or_else(|| body.get("messageId")).and_then(|value| value.as_str().map(str::to_owned).or_else(|| value.as_i64().map(|n| n.to_string())))),
        _ => Err(format!("Le fournisseur SMS a refusé l’envoi (HTTP {status}).")),
    }
}

fn secret_path(store: &LocalStore) -> PathBuf {
    store.data_dir.join(SECRET_FILE)
}

fn read_secret(store: &LocalStore) -> AppResult<Option<String>> {
    let path = secret_path(store);
    if !path.exists() {
        return Ok(None);
    }
    let reference = crate::installation::read_protected_reference(&path)?;
    let clear = crate::installation::unprotect_protected_reference(&reference)?;
    Ok(String::from_utf8(clear).ok().filter(|value| !value.is_empty()))
}

fn settings_row(connection: &Connection) -> AppResult<Option<(Settings, bool)>> {
    Ok(connection
        .query_row("SELECT enabled,provider,sender,account,endpoint,appointment_reminders_auto FROM sms_settings WHERE id=1", [], |row| {
            Ok((Settings { enabled: row.get(0)?, provider: row.get(1)?, sender: row.get(2)?, account: row.get(3)?, endpoint: row.get(4)? }, row.get(5)?))
        })
        .optional()?)
}

fn http_client() -> AppResult<reqwest::Client> {
    crate::app_updater::ensure_rustls_crypto_provider().map_err(AppError::Validation)?;
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent(format!("Zentra/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| invalid("La connexion sécurisée au fournisseur SMS est indisponible."))
}

impl LocalStore {
    pub fn get_sms_settings(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let row = settings_row(&connection)?;
        let secret_present = secret_path(self).exists();
        Ok(match row {
            Some((settings, auto)) => json!({ "enabled": settings.enabled, "provider": settings.provider, "sender": settings.sender, "account": settings.account,
                "endpoint": settings.endpoint, "appointment_reminders_auto": auto, "secret_present": secret_present }),
            None => json!({ "enabled": false, "provider": "aspsms", "sender": "", "account": "", "endpoint": null, "appointment_reminders_auto": false, "secret_present": secret_present }),
        })
    }

    fn write_sms_settings(&self, input: &SmsSettingsInput, sender: &str, endpoint: Option<&str>) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO sms_settings(id,enabled,provider,sender,account,endpoint,appointment_reminders_auto,updated_at) VALUES(1,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,provider=excluded.provider,sender=excluded.sender,account=excluded.account,
               endpoint=excluded.endpoint,appointment_reminders_auto=excluded.appointment_reminders_auto,updated_at=excluded.updated_at",
            params![input.enabled, input.provider, sender, input.account.trim(), endpoint, input.appointment_reminders_auto, now_iso()],
        )?;
        append_audit(&tx, "configure", "sms_settings", "1", &json!({ "enabled": input.enabled, "provider": input.provider, "appointment_reminders_auto": input.appointment_reminders_auto }))?;
        tx.commit()?;
        drop(connection);
        self.get_sms_settings()
    }

    pub fn save_sms_settings(&self, input: SmsSettingsInput) -> AppResult<Value> {
        if !matches!(input.provider.as_str(), "aspsms" | "swisscom" | "generic") {
            return Err(invalid("Choisissez ASPSMS, Swisscom ou un service compatible."));
        }
        let sender = input.sender.trim().to_owned();
        if !valid_sender(&sender) {
            return Err(invalid("L’expéditeur : 11 lettres ou chiffres au plus, ou votre numéro au format +41…"));
        }
        if input.account.chars().count() > 200 {
            return Err(invalid("Identifiant du compte trop long."));
        }
        let endpoint = input.endpoint.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned);
        if endpoint.as_deref().is_some_and(|value| !url::Url::parse(value).is_ok_and(|url| url.scheme() == "https" && url.username().is_empty()) || value.len() > 300) {
            return Err(invalid("L’adresse du service SMS doit commencer par https://."));
        }
        match input.secret.as_deref().map(str::trim) {
            Some("") => crate::installation::remove_protected(&secret_path(self))?,
            Some(secret) if secret.len() > 300 || secret.chars().any(char::is_control) => return Err(invalid("La clé du fournisseur SMS est illisible.")),
            Some(secret) => crate::installation::write_protected_atomically_with_reference(&secret_path(self), secret.as_bytes()).map(|_| ())?,
            None => {}
        }
        if input.enabled {
            if read_secret(self)?.is_none() {
                return Err(invalid("Indiquez la clé ou le mot de passe API de votre compte SMS."));
            }
            if input.provider == "aspsms" && input.account.trim().is_empty() {
                return Err(invalid("Indiquez votre UserKey ASPSMS."));
            }
            if input.provider == "generic" && endpoint.is_none() {
                return Err(invalid("Indiquez l’adresse https du service SMS."));
            }
        }
        self.write_sms_settings(&input, &sender, endpoint.as_deref())
    }

    /// Vérifie l'envoi demandé et prépare la requête ; aucune écriture, aucun réseau.
    fn prepare_sms(&self, input: &SendSmsInput) -> AppResult<(Settings, String, String, String)> {
        if !matches!(input.purpose.as_str(), "appointment_reminder" | "payment_reminder" | "review_request" | "booking" | "other") || !matches!(input.origin.as_str(), "validated" | "rule") {
            return Err(invalid("Envoi SMS inconnu."));
        }
        let body = input.body.trim().to_owned();
        if body.is_empty() || body.chars().count() > 640 {
            return Err(invalid("Le SMS est vide ou trop long (640 caractères au plus)."));
        }
        let recipient = normalized_phone(&input.recipient).ok_or_else(|| invalid("Ce numéro de téléphone n’est pas valable pour un SMS."))?;
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let Some((settings, _)) = settings_row(&connection)? else { return Err(invalid("Les SMS sont éteints : configurez d’abord le compte SMS de l’entreprise.")) };
        if !settings.enabled {
            return Err(invalid("Les SMS sont éteints : configurez d’abord le compte SMS de l’entreprise."));
        }
        if let (Some(kind), Some(id)) = (input.related_type.as_deref(), input.related_id.as_deref()) {
            let sent: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sms_messages WHERE related_type=? AND related_id=? AND purpose=? AND status='sent')",
                params![kind, id, input.purpose],
                |row| row.get(0),
            )?;
            if sent {
                return Err(invalid("Ce SMS a déjà été envoyé."));
            }
        }
        let secret = read_secret(self)?.ok_or_else(|| invalid("La clé du compte SMS manque sur cet appareil."))?;
        Ok((settings, secret, recipient, body))
    }

    fn log_sms(&self, input: &SendSmsInput, provider: &str, recipient: &str, body: &str, outcome: &Result<Option<String>, String>) -> AppResult<Value> {
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = Uuid::new_v4().to_string();
        let (status, reference, error) = match outcome {
            Ok(reference) => ("sent", reference.clone(), None),
            Err(message) => ("failed", None, Some(message.clone())),
        };
        let now = now_iso();
        tx.execute(
            "INSERT INTO sms_messages(id,purpose,origin,recipient,body,provider,status,provider_reference,error,related_type,related_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            params![id, input.purpose, input.origin, recipient, body, provider, status, reference, error, input.related_type, input.related_id, now],
        )?;
        append_audit(&tx, "send", "sms_message", &id, &json!({ "purpose": input.purpose, "origin": input.origin, "status": status, "related_id": input.related_id }))?;
        tx.commit()?;
        Ok(json!({ "id": id, "status": status, "error": error, "created_at": now }))
    }
}

#[tauri::command]
pub fn get_sms_settings(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_sms_settings().map_err(command_error)
}

#[tauri::command]
pub fn save_sms_settings(state: tauri::State<'_, LocalStore>, input: SmsSettingsInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_sms_settings(input).map_err(command_error)
}

#[tauri::command]
pub async fn send_sms(state: tauri::State<'_, LocalStore>, input: SendSmsInput) -> Result<Value, String> {
    let store = state.inner().clone();
    let (settings, secret, recipient, body) = {
        let _guard = store.lock().map_err(command_error)?;
        store.require_write_access().map_err(command_error)?;
        store.prepare_sms(&input).map_err(command_error)?
    };
    let (url, headers, payload) = provider_request(&settings, &secret, &recipient, &body).map_err(command_error)?;
    let outcome = async {
        let client = http_client().map_err(|error| error.to_string())?;
        let mut request = client.post(&url).json(&payload);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|_| "Le fournisseur SMS ne répond pas. Vérifiez la connexion.".to_owned())?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(|_| "Réponse du fournisseur SMS incomplète.".to_owned())?;
        let body: Value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes[..bytes.len().min(65_536)]).unwrap_or(Value::Null) };
        provider_outcome(&settings.provider, status, &body)
    }
    .await;
    let _guard = store.lock().map_err(command_error)?;
    let logged = store.log_sms(&input, &settings.provider, &recipient, &body, &outcome).map_err(command_error)?;
    match outcome {
        Ok(_) => Ok(logged),
        Err(message) => Err(command_error(invalid(message))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "sms-test").unwrap();
        (temporary, store)
    }

    fn settings(provider: &str) -> Settings {
        Settings { enabled: true, provider: provider.into(), sender: "Atelier".into(), account: "USERKEY".into(), endpoint: Some("https://sms.example.ch/send".into()) }
    }

    #[test]
    fn swiss_numbers_become_international() {
        assert_eq!(normalized_phone("079 123 45 67").as_deref(), Some("+41791234567"));
        assert_eq!(normalized_phone("0041 79 123 45 67").as_deref(), Some("+41791234567"));
        assert_eq!(normalized_phone("+33 6 12 34 56 78").as_deref(), Some("+33612345678"));
        assert_eq!(normalized_phone("12"), None);
        assert_eq!(normalized_phone("+41 79 abc"), None);
        assert!(valid_sender("Atelier") && valid_sender("+41791234567") && !valid_sender("Atelier du Léman SA"));
    }

    #[test]
    fn each_provider_gets_its_own_request() {
        let (url, headers, body) = provider_request(&settings("aspsms"), "secret", "+41791234567", "Bonjour").unwrap();
        assert_eq!(url, ASPSMS_URL);
        assert!(headers.is_empty());
        assert_eq!(body["Recipients"][0], "+41791234567");
        let (url, headers, body) = provider_request(&settings("swisscom"), "key", "+41791234567", "Bonjour").unwrap();
        assert_eq!((url.as_str(), headers[0].0), (SWISSCOM_URL, "client_id"));
        assert_eq!(body["to"], "+41791234567");
        let (url, headers, _) = provider_request(&settings("generic"), "token", "+41791234567", "Bonjour").unwrap();
        assert_eq!((url.as_str(), headers[0].1.as_str()), ("https://sms.example.ch/send", "Bearer token"));
        assert_eq!(provider_outcome("aspsms", 200, &json!({ "StatusCode": "1", "StatusInfo": "OK" })), Ok(None));
        assert!(provider_outcome("aspsms", 200, &json!({ "StatusCode": "3", "StatusInfo": "Authorization failed" })).is_err());
        assert_eq!(provider_outcome("swisscom", 201, &json!({ "id": "m-1" })), Ok(Some("m-1".into())));
        assert!(provider_outcome("generic", 401, &Value::Null).is_err());
    }

    #[test]
    fn sms_stay_off_until_the_company_account_is_set() {
        let (_temporary, store) = store();
        let send = SendSmsInput { recipient: "079 123 45 67".into(), body: "Rappel".into(), purpose: "appointment_reminder".into(), origin: "validated".into(),
            related_type: Some("agenda_event".into()), related_id: Some("e1".into()) };
        assert!(store.prepare_sms(&send).unwrap_err().to_string().contains("éteints"));
        let input = |enabled: bool, secret: Option<&str>| SmsSettingsInput { enabled, provider: "aspsms".into(), sender: "Atelier".into(), account: "USERKEY".into(), endpoint: None,
            appointment_reminders_auto: false, secret: secret.map(str::to_owned) };
        assert!(store.save_sms_settings(input(true, None)).unwrap_err().to_string().contains("clé"));
        store.save_sms_settings(input(true, Some("api-password"))).unwrap();
        let (_, secret, recipient, _) = store.prepare_sms(&send).unwrap();
        assert_eq!((secret.as_str(), recipient.as_str()), ("api-password", "+41791234567"));
        store.log_sms(&send, "aspsms", &recipient, "Rappel", &Ok(None)).unwrap();
        assert!(store.prepare_sms(&send).unwrap_err().to_string().contains("déjà été envoyé"));
        store.log_sms(&SendSmsInput { related_id: Some("e2".into()), ..send }, "aspsms", &recipient, "Rappel", &Err("Refusé".into())).unwrap();
        let rows: i64 = store.connect().unwrap().query_row("SELECT COUNT(*) FROM sms_messages", [], |row| row.get(0)).unwrap();
        assert_eq!(rows, 2);
        assert_eq!(store.get_sms_settings().unwrap()["secret_present"], true);
    }
}
