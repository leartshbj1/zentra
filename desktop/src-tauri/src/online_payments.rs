//! Lien de paiement en ligne (TWINT, Visa, Mastercard) par le compte
//! Payrexx de l'entreprise. Désactivé par défaut : il faut l'instance et la
//! clé API de ce compte, vérifiées auprès de Payrexx. L'argent va directement
//! à l'entreprise ; Zentra crée le lien, relit son état et propose
//! d'enregistrer l'encaissement, qui reste un clic de l'utilisateur.
//! Plus bas : validation des destinataires eBill (modèle de données seulement).

use std::{path::PathBuf, time::Duration};

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, record_payment_in_transaction, LocalStore},
    error::{command_error, AppError, AppResult},
    models::RecordPaymentInput,
};

const API: &str = "https://api.payrexx.com/v1.0";
const SECRET_FILE: &str = "online-payment-payrexx.key";
const REFRESH_LIMIT: usize = 25;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// HMAC-SHA256 (RFC 2104) sur SHA-256.
pub(crate) fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0_u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// Encodage `urlencode` de PHP : seuls les alphanumériques et `-_.` restent,
/// l'espace devient `+`. Payrexx signe la requête ainsi encodée.
pub(crate) fn php_urlencode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => out.push(byte as char),
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// `http_build_query` sur des paires déjà ordonnées.
pub(crate) fn build_query(pairs: &[(String, String)]) -> String {
    pairs.iter().map(|(key, value)| format!("{}={}", php_urlencode(key), php_urlencode(value))).collect::<Vec<_>>().join("&")
}

/// Signature Payrexx : HMAC-SHA256 de la requête encodée, en base64.
pub(crate) fn api_signature(query: &str, secret: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(hmac_sha256(secret.as_bytes(), query.as_bytes()))
}

fn valid_instance(instance: &str) -> bool {
    (1..=63).contains(&instance.len()) && instance.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Un lien de paiement n'est accepté que vers Payrexx, en HTTPS.
pub(crate) fn valid_link(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.port().is_none()
        && parsed.host_str().is_some_and(|host| host == "payrexx.com" || host.ends_with(".payrexx.com"))
        && url.len() <= 500
}

/// Paramètres d'une page de paiement (Gateway) pour le solde d'une facture.
pub(crate) fn gateway_pairs(amount_cents: i64, currency: &str, number: &str, company: &str) -> Vec<(String, String)> {
    let purpose = format!("Facture {number} · {company}").chars().take(200).collect::<String>();
    vec![
        ("amount".into(), amount_cents.to_string()),
        ("currency".into(), currency.into()),
        ("purpose".into(), purpose),
        ("referenceId".into(), number.into()),
        ("pm[0]".into(), "twint".into()),
        ("pm[1]".into(), "visa".into()),
        ("pm[2]".into(), "mastercard".into()),
    ]
}

/// Lit `data[0]` d'une réponse Payrexx : (identifiant, lien, état).
pub(crate) fn gateway_from_response(body: &Value) -> AppResult<(String, Option<String>, String)> {
    if body.get("status").and_then(Value::as_str) != Some("success") {
        let message = body.get("message").and_then(Value::as_str).unwrap_or("réponse inattendue");
        return Err(invalid(format!("Payrexx a refusé la demande : {}", message.chars().take(200).collect::<String>())));
    }
    let data = body.get("data").and_then(|data| data.get(0)).ok_or_else(|| invalid("Payrexx n'a renvoyé aucune page de paiement."))?;
    let id = match data.get("id") {
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) if !text.is_empty() && text.len() <= 64 => text.clone(),
        _ => return Err(invalid("Payrexx n'a renvoyé aucun identifiant de paiement.")),
    };
    let link = data.get("link").and_then(Value::as_str).map(str::to_owned);
    let status = data.get("status").and_then(Value::as_str).unwrap_or("waiting").to_owned();
    Ok((id, link, status))
}

/// État Payrexx → état du lien dans Zentra. « confirmed » seul vaut encaissement.
pub(crate) fn link_status(provider_status: &str) -> &'static str {
    match provider_status {
        "confirmed" => "paid",
        "declined" | "error" => "failed",
        "cancelled" | "expired" | "refunded" | "partially-refunded" | "chargeback" => "cancelled",
        _ => "open",
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OnlinePaymentSettingsInput {
    pub enabled: bool,
    #[serde(default)]
    pub instance: Option<String>,
    /// None : conserver la clé enregistrée ; "" : l'effacer.
    #[serde(default)]
    pub api_secret: Option<String>,
}

#[derive(Debug)]
struct LinkRequest {
    invoice_id: String,
    instance: String,
    amount_cents: i64,
    currency: String,
    pairs: Vec<(String, String)>,
}

fn secret_path(store: &LocalStore) -> PathBuf {
    store.data_dir.join(SECRET_FILE)
}

pub(crate) fn read_secret(store: &LocalStore) -> AppResult<Option<String>> {
    let path = secret_path(store);
    if !path.exists() {
        return Ok(None);
    }
    let reference = crate::installation::read_protected_reference(&path)?;
    let clear = crate::installation::unprotect_protected_reference(&reference)?;
    Ok(String::from_utf8(clear).ok().filter(|value| !value.is_empty()))
}

pub(crate) fn settings_row(connection: &Connection) -> AppResult<(bool, Option<String>)> {
    Ok(connection
        .query_row("SELECT enabled,instance FROM online_payment_settings WHERE id=1", [], |row| Ok((row.get::<_, bool>(0)?, row.get(1)?)))
        .optional()?
        .unwrap_or((false, None)))
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
        .map_err(|_| invalid("La connexion sécurisée à Payrexx est indisponible."))
}

pub(crate) async fn payrexx(method: reqwest::Method, resource: &str, instance: &str, secret: &str, pairs: Vec<(String, String)>) -> AppResult<Value> {
    let body = build_query(&pairs);
    let signature = api_signature(&body, secret);
    let mut url = url::Url::parse(&format!("{API}/{resource}/")).map_err(|_| invalid("Adresse Payrexx invalide."))?;
    url.query_pairs_mut().append_pair("instance", instance);
    let client = http_client()?;
    let request = if method == reqwest::Method::GET {
        url.query_pairs_mut().append_pair("ApiSignature", &signature);
        client.get(url)
    } else {
        let mut signed = pairs;
        signed.push(("ApiSignature".into(), signature));
        client.request(method, url).header("Content-Type", "application/x-www-form-urlencoded").body(build_query(&signed))
    };
    let response = request.send().await.map_err(|_| invalid("Payrexx ne répond pas. Vérifiez la connexion et réessayez."))?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|_| invalid("La réponse de Payrexx est incomplète."))?;
    if bytes.len() > 262_144 {
        return Err(invalid("La réponse de Payrexx est trop volumineuse."));
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| invalid(format!("Payrexx a répondu de façon inattendue (HTTP {}).", status.as_u16())))?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(invalid("Payrexx refuse cette instance ou cette clé API. Vérifiez-les dans votre compte Payrexx."));
    }
    Ok(body)
}

impl LocalStore {
    pub fn get_online_payment_settings(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let (enabled, instance) = settings_row(&connection)?;
        Ok(json!({ "enabled": enabled, "provider": "payrexx", "instance": instance, "secret_present": secret_path(self).exists() }))
    }

    fn write_online_payment_settings(&self, enabled: bool, instance: Option<&str>) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        tx.execute(
            "INSERT INTO online_payment_settings(id,enabled,provider,instance,created_at,updated_at) VALUES(1,?,'payrexx',?,?,?)
             ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,instance=excluded.instance,updated_at=excluded.updated_at",
            params![enabled, instance, now, now],
        )?;
        append_audit(&tx, "configure", "online_payment_settings", "1", &json!({"enabled": enabled, "provider": "payrexx", "instance": instance}))?;
        tx.commit()?;
        self.get_online_payment_settings()
    }

    /// Prépare le lien pour le solde ouvert de la facture.
    fn prepare_payment_link(&self, invoice_id: &str) -> AppResult<LinkRequest> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let (enabled, instance) = settings_row(&connection)?;
        let instance = instance.filter(|_| enabled).ok_or_else(|| invalid("Le paiement en ligne est désactivé. Activez-le dans Paramètres › Entreprise et facturation."))?;
        let invoice: Option<(Option<String>, String, String, i64, i64)> = connection
            .query_row(
                "SELECT number,type,status,total_cents,total_cents-paid_cents-COALESCE((SELECT SUM(c.amount_cents) FROM customer_invoice_credit_movements c WHERE c.invoice_id=invoices.id),0) FROM invoices WHERE id=?",
                [invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;
        let (number, kind, status, _total, open) = invoice.ok_or_else(|| invalid("Facture introuvable."))?;
        let number = number.filter(|value| !value.is_empty()).ok_or_else(|| invalid("Émettez d'abord la facture."))?;
        if kind == "avoir" || matches!(status.as_str(), "payee" | "annulee" | "brouillon") || open <= 0 {
            return Err(invalid("Cette facture n'a plus de solde à encaisser."));
        }
        let currency: String = connection.query_row("SELECT UPPER(currency) FROM invoices WHERE id=?", [invoice_id], |row| row.get(0))?;
        if !matches!(currency.as_str(), "CHF" | "EUR") {
            return Err(invalid("Le paiement en ligne accepte les factures en CHF ou en EUR."));
        }
        let company: String = connection.query_row("SELECT company_name FROM settings WHERE id=1", [], |row| row.get(0))?;
        Ok(LinkRequest { invoice_id: invoice_id.into(), instance, amount_cents: open, currency: currency.clone(), pairs: gateway_pairs(open, &currency, &number, &company) })
    }

    fn save_payment_link(&self, request: &LinkRequest, response: &Value) -> AppResult<Value> {
        let (reference, link, _status) = gateway_from_response(response)?;
        let link = link.filter(|link| valid_link(link)).ok_or_else(|| invalid("Payrexx a renvoyé un lien inattendu ; il n'a pas été utilisé."))?;
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = Uuid::new_v4().to_string();
        let now = now_iso();
        tx.execute(
            "INSERT INTO invoice_payment_links(id,invoice_id,provider,provider_reference,url,amount_cents,currency,status,created_at,updated_at) VALUES(?,?,'payrexx',?,?,?,?,'open',?,?)",
            params![id, request.invoice_id, reference, link, request.amount_cents, request.currency, now, now],
        )?;
        append_audit(&tx, "create", "invoice_payment_link", &id, &json!({"invoice_id": request.invoice_id, "provider": "payrexx", "provider_reference": reference, "amount_cents": request.amount_cents}))?;
        tx.commit()?;
        Ok(json!({ "id": id, "invoice_id": request.invoice_id, "url": link, "amount_cents": request.amount_cents, "currency": request.currency }))
    }

    fn open_payment_links(&self) -> AppResult<Vec<(String, String)>> {
        let connection = self.connect()?;
        let rows = query_all(
            &connection,
            "SELECT id,provider_reference FROM invoice_payment_links WHERE status='open' AND created_at>=? ORDER BY created_at DESC LIMIT ?",
            params![(chrono::Utc::now() - chrono::Duration::days(120)).to_rfc3339(), REFRESH_LIMIT as i64],
        )?;
        Ok(rows.into_iter().map(|row| (row["id"].as_str().unwrap_or_default().to_owned(), row["provider_reference"].as_str().unwrap_or_default().to_owned())).collect())
    }

    pub(crate) fn update_payment_link_status(&self, id: &str, provider_status: &str) -> AppResult<()> {
        let status = link_status(provider_status);
        if status == "open" {
            return Ok(());
        }
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        let changed = tx.execute(
            "UPDATE invoice_payment_links SET status=?,paid_at=CASE WHEN ?='paid' THEN ? ELSE paid_at END,updated_at=? WHERE id=? AND status='open'",
            params![status, status, now, now, id],
        )?;
        if changed == 1 {
            append_audit(&tx, "status", "invoice_payment_link", id, &json!({"status": status, "provider_status": provider_status}))?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Enregistre l'encaissement d'un lien payé, après le clic de l'utilisateur.
    pub fn record_payment_link(&self, link_id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let link: Option<(String, String, i64, String, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT invoice_id,provider_reference,amount_cents,status,paid_at,payment_id FROM invoice_payment_links WHERE id=?",
                [link_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .optional()?;
        let (invoice_id, reference, amount, status, paid_at, payment_id) = link.ok_or_else(|| invalid("Lien de paiement introuvable."))?;
        if let Some(payment_id) = payment_id {
            tx.commit()?;
            return Ok(json!({ "payment_id": payment_id, "already_recorded": true }));
        }
        if status != "paid" {
            return Err(invalid("Ce lien n'est pas encore payé."));
        }
        let date = paid_at.as_deref().map(|value| value.chars().take(10).collect::<String>()).unwrap_or_else(|| now_iso()[..10].to_owned());
        let payment = record_payment_in_transaction(
            &tx,
            RecordPaymentInput {
                // Le même lien ne peut produire qu'un seul encaissement.
                request_id: link_id.into(),
                invoice_id: invoice_id.clone(),
                amount_cents: amount,
                date: Some(date),
                method: Some("TWINT / carte (Payrexx)".into()),
                reference: Some(format!("Payrexx {reference}")),
                notes: Some("Paiement en ligne. Les frais Payrexx sont déduits du versement sur votre compte.".into()),
            },
        )?;
        let payment_id = payment["id"].as_str().ok_or_else(|| invalid("Le paiement n'a pas pu être enregistré."))?.to_owned();
        tx.execute("UPDATE invoice_payment_links SET payment_id=?,updated_at=? WHERE id=?", params![payment_id, now_iso(), link_id])?;
        append_audit(&tx, "record_payment", "invoice_payment_link", link_id, &json!({"payment_id": payment_id, "invoice_id": invoice_id}))?;
        tx.commit()?;
        Ok(json!({ "payment_id": payment_id, "already_recorded": false }))
    }
}

#[tauri::command]
pub fn get_online_payment_settings(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_online_payment_settings().map_err(command_error)
}

#[tauri::command]
pub async fn save_online_payment_settings(state: tauri::State<'_, LocalStore>, input: OnlinePaymentSettingsInput) -> Result<Value, String> {
    let store = state.inner().clone();
    let instance = input.instance.as_deref().map(|value| value.trim().to_lowercase()).filter(|value| !value.is_empty());
    if instance.as_deref().is_some_and(|value| !valid_instance(value)) {
        return Err(command_error(invalid("Le nom d'instance Payrexx ne contient que des lettres minuscules, des chiffres et des tirets.")));
    }
    {
        let _guard = store.lock().map_err(command_error)?;
        store.require_write_access().map_err(command_error)?;
        match input.api_secret.as_deref().map(str::trim) {
            Some("") => crate::installation::remove_protected(&secret_path(&store)).map_err(command_error)?,
            Some(secret) if secret.len() > 200 || secret.chars().any(char::is_control) => return Err(command_error(invalid("La clé API Payrexx est illisible."))),
            Some(secret) => crate::installation::write_protected_atomically_with_reference(&secret_path(&store), secret.as_bytes()).map(|_| ()).map_err(command_error)?,
            None => {}
        }
    }
    if input.enabled {
        let instance = instance.clone().ok_or_else(|| command_error(invalid("Indiquez l'instance de votre compte Payrexx.")))?;
        let secret = read_secret(&store).map_err(command_error)?.ok_or_else(|| command_error(invalid("Indiquez la clé API de votre compte Payrexx.")))?;
        // L'activation exige une vérification réussie auprès de Payrexx.
        let check = payrexx(reqwest::Method::GET, "SignatureCheck", &instance, &secret, Vec::new()).await.map_err(command_error)?;
        if check.get("status").and_then(Value::as_str) != Some("success") {
            return Err(command_error(invalid("Payrexx refuse cette instance ou cette clé API. Vérifiez-les dans votre compte Payrexx.")));
        }
    }
    let _guard = store.lock().map_err(command_error)?;
    store.write_online_payment_settings(input.enabled, instance.as_deref()).map_err(command_error)
}

#[tauri::command]
pub async fn create_invoice_payment_link(state: tauri::State<'_, LocalStore>, invoice_id: String) -> Result<Value, String> {
    let store = state.inner().clone();
    let (request, secret) = {
        let _guard = store.lock().map_err(command_error)?;
        store.require_write_access().map_err(command_error)?;
        let request = store.prepare_payment_link(&invoice_id).map_err(command_error)?;
        let secret = read_secret(&store).map_err(command_error)?.ok_or_else(|| command_error(invalid("La clé API Payrexx manque sur cet appareil. Saisissez-la dans Paramètres › Entreprise et facturation.")))?;
        (request, secret)
    };
    let response = payrexx(reqwest::Method::POST, "Gateway", &request.instance, &secret, request.pairs.clone()).await.map_err(command_error)?;
    let _guard = store.lock().map_err(command_error)?;
    store.save_payment_link(&request, &response).map_err(command_error)
}

/// Relit l'état des liens ouverts. Un lien payé devient une carte Autopilote.
#[tauri::command]
pub async fn refresh_invoice_payment_links(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    let (links, instance, secret) = {
        let _guard = store.lock().map_err(command_error)?;
        let connection = store.connect().map_err(command_error)?;
        let (enabled, instance) = settings_row(&connection).map_err(command_error)?;
        let secret = read_secret(&store).map_err(command_error)?;
        match (enabled, instance, secret) {
            (true, Some(instance), Some(secret)) => (store.open_payment_links().map_err(command_error)?, instance, secret),
            _ => return Ok(json!({ "checked": 0 })),
        }
    };
    let mut checked = 0;
    for (id, reference) in links {
        let Ok(body) = payrexx(reqwest::Method::GET, &format!("Gateway/{}", php_urlencode(&reference)), &instance, &secret, Vec::new()).await else { continue };
        let Ok((_, _, status)) = gateway_from_response(&body) else { continue };
        let _guard = store.lock().map_err(command_error)?;
        store.update_payment_link_status(&id, &status).map_err(command_error)?;
        checked += 1;
    }
    Ok(json!({ "checked": checked }))
}

#[tauri::command]
pub fn record_invoice_payment_link(state: tauri::State<'_, LocalStore>, link_id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.record_payment_link(&link_id).map_err(command_error)
}

/* ---------- eBill (modèle de données) ---------- */

/// Identifiant eBill d'une entreprise (17 chiffres) ou adresse e-mail eBill d'un particulier.
pub(crate) fn ebill_recipient_kind(value: &str) -> Option<&'static str> {
    let value = value.trim();
    if value.len() == 17 && value.bytes().all(|b| b.is_ascii_digit()) {
        return Some("business");
    }
    let (local, domain) = value.split_once('@')?;
    (!local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && value.len() <= 254 && !value.chars().any(char::is_whitespace))
        .then_some("private")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        // Cas 2 de la RFC 4231.
        assert_eq!(hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // Cas 6 : clé plus longue qu'un bloc.
        let key = [0xaa_u8; 131];
        assert_eq!(hex(&hmac_sha256(&key, b"Test Using Larger Than Block-Size Key - Hash Key First")), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }

    #[test]
    fn query_is_encoded_like_php() {
        assert_eq!(php_urlencode("Facture F-1 · Atelier"), "Facture+F-1+%C2%B7+Atelier");
        assert_eq!(php_urlencode("pm[0]"), "pm%5B0%5D");
        let pairs = gateway_pairs(12_550, "CHF", "F-2026-001", "Atelier du Léman");
        assert_eq!(
            build_query(&pairs),
            "amount=12550&currency=CHF&purpose=Facture+F-2026-001+%C2%B7+Atelier+du+L%C3%A9man&referenceId=F-2026-001&pm%5B0%5D=twint&pm%5B1%5D=visa&pm%5B2%5D=mastercard"
        );
        // Signature d'une requête vide (lecture d'un état) : HMAC de la chaîne vide.
        assert_eq!(api_signature("", "secret"), base64::engine::general_purpose::STANDARD.encode(hmac_sha256(b"secret", b"")));
    }

    #[test]
    fn only_payrexx_https_links_and_known_states() {
        assert!(valid_link("https://atelier.payrexx.com/pay?tid=abc"));
        assert!(!valid_link("http://atelier.payrexx.com/pay"));
        assert!(!valid_link("https://payrexx.com.example.net/pay"));
        assert!(!valid_link("https://user@atelier.payrexx.com/"));
        assert_eq!(link_status("confirmed"), "paid");
        assert_eq!(link_status("waiting"), "open");
        assert_eq!(link_status("authorized"), "open");
        assert_eq!(link_status("declined"), "failed");
        assert_eq!(link_status("expired"), "cancelled");
        let ok = json!({"status": "success", "data": [{"id": 4711, "link": "https://atelier.payrexx.com/?payment=1", "status": "waiting"}]});
        assert_eq!(gateway_from_response(&ok).unwrap(), ("4711".into(), Some("https://atelier.payrexx.com/?payment=1".into()), "waiting".into()));
        assert!(gateway_from_response(&json!({"status": "error", "message": "Invalid signature"})).unwrap_err().to_string().contains("Invalid signature"));
    }

    #[test]
    fn ebill_recipients() {
        assert_eq!(ebill_recipient_kind("41010560425610173"), Some("business"));
        assert_eq!(ebill_recipient_kind("marie.favre@example.ch"), Some("private"));
        assert_eq!(ebill_recipient_kind("4101056042561017"), None);
        assert_eq!(ebill_recipient_kind("marie@localhost"), None);
        assert_eq!(ebill_recipient_kind("marie favre@example.ch"), None);
    }

    fn store_with_invoice() -> (tempfile::TempDir, LocalStore, String) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "online-payments-test").unwrap();
        // Un encaissement client exige la comptabilité et ses comptes de liaison.
        crate::tests::enable_accounting(&store);
        store
            .connect()
            .unwrap()
            .execute("INSERT INTO clients(id,name,address_line1,postal_code,city,country,created_at,updated_at) VALUES('c1','Muster AG','Bahnhofstrasse 1','8001','Zürich','CH','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [])
            .unwrap();
        let receipt = store
            .import_opening_receivables(crate::opening_balances::OpeningReceivablesInput {
                rows: vec![crate::opening_balances::OpeningReceivableRow { line: 2, number: "RE-1".into(), client_id: "c1".into(), issue_date: "2026-01-10".into(), due_date: "2026-02-09".into(), open_cents: 25_000, total_cents: None, title: None }],
            })
            .unwrap();
        let id = receipt["rows"][0]["invoice_id"].as_str().unwrap().to_owned();
        (temporary, store, id)
    }

    #[test]
    fn a_paid_link_is_recorded_once_after_the_click() {
        let (_temporary, store, invoice_id) = store_with_invoice();
        // Désactivé par défaut : aucun lien possible.
        assert!(store.prepare_payment_link(&invoice_id).unwrap_err().to_string().contains("désactivé"));
        store.write_online_payment_settings(true, Some("atelier")).unwrap();
        let request = store.prepare_payment_link(&invoice_id).unwrap();
        assert_eq!(request.amount_cents, 25_000);
        assert_eq!(request.pairs[3], ("referenceId".to_owned(), "RE-1".to_owned()));
        // Un lien hors de Payrexx est refusé.
        let foreign = json!({"status": "success", "data": [{"id": 1, "link": "https://example.net/pay", "status": "waiting"}]});
        assert!(store.save_payment_link(&request, &foreign).is_err());
        let link = store.save_payment_link(&request, &json!({"status": "success", "data": [{"id": 77, "link": "https://atelier.payrexx.com/?payment=77", "status": "waiting"}]})).unwrap();
        let link_id = link["id"].as_str().unwrap().to_owned();
        assert!(store.record_payment_link(&link_id).is_err());
        assert_eq!(store.open_payment_links().unwrap(), vec![(link_id.clone(), "77".to_owned())]);
        store.update_payment_link_status(&link_id, "confirmed").unwrap();
        let first = store.record_payment_link(&link_id).unwrap();
        assert_eq!(first["already_recorded"], false);
        let second = store.record_payment_link(&link_id).unwrap();
        assert_eq!(second["already_recorded"], true);
        let connection = store.connect().unwrap();
        let (status, payments): (String, i64) = connection
            .query_row("SELECT status,(SELECT COUNT(*) FROM payments WHERE invoice_id=invoices.id) FROM invoices WHERE id=?", [&invoice_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert_eq!((status.as_str(), payments), ("payee", 1));
        drop(connection);
        assert!(store.prepare_payment_link(&invoice_id).unwrap_err().to_string().contains("plus de solde"));
    }
}
