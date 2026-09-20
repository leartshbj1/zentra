use crate::{
    crypto::Result,
    vault::{self, Vault},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path, time::Duration};
use zeroize::Zeroizing;

pub const ENDPOINT: &str = "https://www.zentraapp.ch/api/founder/access";
const DOMAIN: &str = "zentra-founder-access-v1\n";
const KEY_FILE: &str = "founder-admin-key.dpapi";
const PENDING_FILE: &str = "founder-pending-access.dpapi";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Action {
    fn validate(&self) -> Result<()> {
        if self.product.as_deref().is_some_and(|v| !["support", "automation"].contains(&v)) {
            return Err("Produit inconnu.".into());
        }
        if self.organization_id.as_ref().is_some_and(|v| self.product.as_deref() != Some("automation") || self.operation != "grant" || v.is_empty() || v.len() > 255 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')) {
            return Err("Entreprise invalide.".into());
        }
        let support_grant = self.product.as_deref() == Some("support") && self.operation == "grant";
        if (self.plan.is_some() && !support_grant)
            || (support_grant && !self.plan.as_deref().is_some_and(|p| ["starter", "team", "business"].contains(&p)))
        {
            return Err("Choisissez une formule Zentra Support.".into());
        }
        if !["list", "lookup", "grant", "revoke"].contains(&self.operation.as_str()) {
            return Err("Commande d’accès inconnue.".into());
        }
        if self.operation != "list"
            && !self.email.as_ref().is_some_and(|e| {
                e.len() <= 254 && e.contains('@') && !e.chars().any(char::is_whitespace)
            })
        {
            return Err("Saisissez une adresse e-mail complète.".into());
        }
        if self.writes()
            && (self.expected_revision.is_none()
                || !self
                    .operation_id
                    .as_ref()
                    .is_some_and(|id| crate::crypto::valid_uuid(id)))
        {
            return Err("Vérifiez le compte avant de modifier son accès.".into());
        }
        if self
            .note
            .as_ref()
            .is_some_and(|n| n.chars().count() > 300 || n.chars().any(char::is_control))
        {
            return Err("La note est trop longue ou invalide.".into());
        }
        Ok(())
    }
    fn writes(&self) -> bool {
        self.operation == "grant" || self.operation == "revoke"
    }
}

fn write_protected(path: &Path, clear: &[u8]) -> Result<()> {
    let protected = vault::protect(clear)?;
    let parent = path.parent().ok_or("Dossier du coffre invalide.")?;
    fs::create_dir_all(parent).map_err(|_| "Impossible de préparer le coffre.")?;
    let tmp = parent.join(format!("access-write-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|_| "Impossible d’enregistrer la demande.")?;
        file.write_all(&protected)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Impossible d’enregistrer la demande.")?;
        drop(file);
        fs::rename(&tmp, path).map_err(|_| "Impossible de finaliser la demande.".into())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

pub fn admin_key(vault: &Vault, create: bool) -> Result<SigningKey> {
    let path = vault.root.join(KEY_FILE);
    if !path.is_file() {
        if !create {
            return Err("La clé de gestion des accès n’est pas installée sur ce PC.".into());
        }
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        let mut seed = Zeroizing::new([0u8; 32]);
        let result = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                seed.as_mut_ptr(),
                32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if result != 0 {
            return Err("Windows n’a pas pu créer la clé personnelle.".into());
        }
        write_protected(&path, seed.as_slice())?;
    }
    let protected = fs::read(path).map_err(|_| "Clé personnelle illisible.")?;
    let clear = vault::unprotect(&protected)?;
    let seed: &[u8; 32] = clear
        .as_slice()
        .try_into()
        .map_err(|_| "Clé personnelle invalide.")?;
    Ok(SigningKey::from_bytes(seed))
}

pub fn pending(vault: &Vault) -> Result<Option<Action>> {
    let path = vault.root.join(PENDING_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|_| "La demande en attente est illisible.")?;
    let clear = vault::unprotect(&bytes)?;
    let action: Action =
        serde_json::from_slice(&clear).map_err(|_| "La demande en attente est invalide.")?;
    action.validate()?;
    if !action.writes() {
        return Err("La demande en attente est invalide.".into());
    }
    Ok(Some(action))
}

fn prepare_pending(vault: &Vault, action: &Action) -> Result<()> {
    if !action.writes() {
        return Ok(());
    }
    if let Some(previous) = pending(vault)? {
        if previous != *action {
            return Err("Une demande attend sa confirmation. Réessayez cette demande avant d’en créer une autre.".into());
        }
    }
    let bytes = Zeroizing::new(serde_json::to_vec(action).map_err(|_| "Demande invalide.")?);
    write_protected(&vault.root.join(PENDING_FILE), &bytes)
}

fn clear_pending(vault: &Vault, action: &Action) -> Result<()> {
    if action.writes() && pending(vault)?.as_ref() == Some(action) {
        fs::remove_file(vault.root.join(PENDING_FILE)).map_err(|_|"L’accès est enregistré, mais la demande locale reste à confirmer. Réessayez pour la clôturer.")?;
    }
    Ok(())
}

pub fn envelope(action: &Action, key: &SigningKey) -> Result<serde_json::Value> {
    action.validate()?;
    let request = serde_json::json!({"version":1,"timestamp":chrono::Utc::now().timestamp(),"nonce":uuid::Uuid::new_v4().to_string(),"action":action});
    let encoded =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&request).map_err(|_| "Demande invalide.")?);
    let signature = key.sign(format!("{DOMAIN}{encoded}").as_bytes());
    Ok(
        serde_json::json!({"payload":encoded,"signature":URL_SAFE_NO_PAD.encode(signature.to_bytes())}),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub ready: bool,
    pub message: String,
    pub pending: Option<Action>,
}

#[tauri::command]
pub fn founder_status(state: tauri::State<crate::AppState>) -> Result<Status> {
    let vault = state.vault.lock().map_err(|_| "Coffre occupé.")?;
    let key = admin_key(&vault, false);
    Ok(Status {
        ready: key.is_ok(),
        message: key
            .err()
            .unwrap_or_else(|| "Clé personnelle protégée par Windows".into()),
        pending: pending(&vault)?,
    })
}

#[tauri::command]
pub async fn founder_request(
    action: Action,
    state: tauri::State<'_, crate::AppState>,
) -> Result<serde_json::Value> {
    let request = {
        let vault = state.vault.lock().map_err(|_| "Coffre occupé.")?;
        let request = envelope(&action, &admin_key(&vault, false)?)?;
        prepare_pending(&vault, &action)?;
        request
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(35))
        .build()
        .map_err(|_| "Connexion HTTPS indisponible.")?;
    let response=client.post(ENDPOINT).header("Content-Type","application/json").header("Accept","application/json")
        .body(request.to_string()).send().await.map_err(|_|"Le serveur est injoignable. Si une modification était en cours, réessayez la demande en attente pour connaître son résultat.")?;
    let status = response.status();
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|_| "La réponse est incomplète. Réessayez la demande en attente.")?;
        if bytes.len() + chunk.len() > 262144 {
            return Err("La réponse du service est trop volumineuse.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
        "Le serveur a renvoyé une réponse illisible. Réessayez pour connaître le résultat."
    })?;
    if status.as_u16() == 200 || [400, 401, 403, 404, 409, 422].contains(&status.as_u16()) {
        clear_pending(&*state.vault.lock().map_err(|_| "Coffre occupé.")?, &action)?;
    }
    if status.as_u16() != 200 {
        let message = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Le service ne peut pas traiter la demande actuellement.");
        return Err(message.chars().take(500).collect());
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn action() -> Action {
        Action {
            product: None,
            plan: None,
            organization_id: None,
            operation: "grant".into(),
            email: Some("test@example.invalid".into()),
            duration: Some("14_days".into()),
            custom_date: Some("".into()),
            operation_id: Some(uuid::Uuid::new_v4().to_string()),
            expected_revision: Some(0),
            note: Some("Test".into()),
        }
    }
    #[test]
    fn key_stays_stable_and_pending_survives_restart() {
        let folder = tempfile::tempdir().unwrap();
        let vault = Vault {
            root: folder.path().into(),
        };
        assert!(admin_key(&vault, false).is_err());
        let first = admin_key(&vault, true).unwrap().verifying_key();
        assert_eq!(admin_key(&vault, false).unwrap().verifying_key(), first);
        let a = action();
        prepare_pending(&vault, &a).unwrap();
        prepare_pending(&vault, &a).unwrap();
        let restarted = Vault {
            root: folder.path().into(),
        };
        assert_eq!(pending(&restarted).unwrap(), Some(a.clone()));
        assert!(prepare_pending(&restarted, &action()).is_err());
        clear_pending(&restarted, &a).unwrap();
        assert!(pending(&restarted).unwrap().is_none());
    }
    #[test]
    fn signature_is_scoped_to_founder_protocol() {
        let key = SigningKey::from_bytes(&[42; 32]);
        let body = envelope(&action(), &key).unwrap();
        let encoded = body["payload"].as_str().unwrap();
        let sig = ed25519_dalek::Signature::from_slice(
            &URL_SAFE_NO_PAD
                .decode(body["signature"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert!(key
            .verifying_key()
            .verify_strict(format!("{DOMAIN}{encoded}").as_bytes(), &sig)
            .is_ok());
        assert!(key
            .verifying_key()
            .verify_strict(encoded.as_bytes(), &sig)
            .is_err());
    }
}
