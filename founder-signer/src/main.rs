#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod access;
mod crypto;
mod vault;

use chrono::Utc;
use crypto::{Payload, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};
use tauri::Manager;
use vault::Vault;

struct AppState {
    vault: Mutex<Vault>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    key_ready: bool,
    key_message: String,
    devices: Vec<vault::Device>,
    unreadable: usize,
}

#[tauri::command]
fn status(state: tauri::State<AppState>) -> Result<Status> {
    let vault = state.vault.lock().map_err(|_| "Coffre occupé.")?;
    let key = vault.key();
    let (devices, unreadable) = vault.devices()?;
    Ok(Status {
        key_ready: key.is_ok(),
        key_message: key
            .err()
            .unwrap_or_else(|| "Clé Zentra vérifiée · protégée par Windows".into()),
        devices,
        unreadable,
    })
}

#[tauri::command]
fn load_token(reference: String, state: tauri::State<AppState>) -> Result<String> {
    state
        .vault
        .lock()
        .map_err(|_| "Coffre occupé.")?
        .token(&reference)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    payload: Payload,
    known_device: bool,
    source_kind: String,
}

fn prepare(source: &str, vault: &Vault) -> Result<Preview> {
    let source = source.trim();
    let parsed = crypto::parse_source(source)?;
    let (devices, _) = vault.devices()?;
    let (payload, source_kind) = if let Some(p) = parsed {
        (
            p,
            if source.contains('.') && !source.starts_with('{') {
                "signed"
            } else {
                "payload"
            },
        )
    } else {
        let matches: Vec<_> = devices
            .iter()
            .filter(|d| d.payload.installation_id.eq_ignore_ascii_case(source))
            .collect();
        if matches.len() > 1 {
            return Err("Plusieurs licences existent pour cet appareil. Choisissez le jeton précis dans Appareils et jetons.".into());
        }
        (
            matches
                .first()
                .map(|d| d.payload.clone())
                .unwrap_or_else(|| crypto::owner_payload(&source.to_ascii_lowercase())),
            "installation",
        )
    };
    let known_device = devices.iter().any(|d| {
        d.payload.installation_id == payload.installation_id
            && d.payload.license_id == payload.license_id
    });
    Ok(Preview {
        payload,
        known_device,
        source_kind: source_kind.into(),
    })
}

#[tauri::command]
fn inspect(source: String, state: tauri::State<AppState>) -> Result<Preview> {
    prepare(&source, &*state.vault.lock().map_err(|_| "Coffre occupé.")?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignRequest {
    source: String,
    expected_payload: Payload,
    customer_name: String,
    valid_until: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Signed {
    token: String,
    payload: Payload,
    binding: String,
    fingerprint: String,
}

impl Signed {
    fn new(token: String, payload: Payload) -> Self {
        Self {
            binding: crypto::binding(&payload),
            fingerprint: crypto::fingerprint(&token),
            token,
            payload,
        }
    }
}

fn issue(request: SignRequest, vault: &Vault) -> Result<Signed> {
    let preview = prepare(&request.source, vault)?;
    // A newly pasted UUID has no persisted license ID yet. Use the exact ID
    // shown in the preview. Every other source must still match the preview.
    let mut payload = if preview.source_kind == "installation" && !preview.known_device {
        let expected = request.expected_payload;
        crypto::validate(&expected)?;
        let mut canonical = preview.payload;
        canonical.license_id = expected.license_id.clone();
        canonical.jti = expected.jti.clone();
        canonical.issued_at = expected.issued_at.clone();
        if canonical != expected {
            return Err("Le contenu a changé depuis l’aperçu. Relisez-le avant de signer.".into());
        }
        expected
    } else {
        if preview.payload != request.expected_payload {
            return Err("Le jeton a changé depuis l’aperçu. Relisez-le avant de signer.".into());
        }
        preview.payload
    };
    let until = crypto::date(&request.valid_until)?;
    if until < Utc::now().date_naive() || until > crypto::date("2099-12-31")? {
        return Err("Choisissez une échéance entre aujourd’hui et le 31 décembre 2099.".into());
    }
    payload.customer_name = Some(request.customer_name.trim().to_owned());
    payload.valid_until = request.valid_until;
    payload.valid_from = (Utc::now().date_naive() - chrono::Duration::days(1)).to_string();
    payload.issued_at = Utc::now().to_rfc3339();
    payload.jti = uuid::Uuid::new_v4().to_string();
    let token = crypto::sign_with(&payload, &vault.key()?)?;
    // Do not report success until recovery after closing the app is possible.
    vault.save(&token, &payload)?;
    Ok(Signed::new(token, payload))
}

#[tauri::command]
fn sign_token(request: SignRequest, state: tauri::State<AppState>) -> Result<Signed> {
    issue(request, &*state.vault.lock().map_err(|_| "Coffre occupé.")?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Checked {
    accepted: bool,
    status: String,
    message: String,
    signed: Option<Signed>,
}

async fn check_remote(token: &str) -> Result<Checked> {
    let candidate = crypto::verify_with(token, &crypto::public_key()?)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Connexion HTTPS indisponible.")?;
    let response = client
        .post(crypto::ENDPOINT)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(serde_json::json!({"token": token}).to_string())
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(_) => return Ok(Checked { accepted: false, status: "offline".into(), message: "Serveur injoignable. Le jeton est signé, mais son activation n’a pas été vérifiée. Réessayez avec Internet.".into(), signed: None }),
    };
    if response.status().as_u16() != 200 {
        let (status, message) = match response.status().as_u16() {
            403 => ("unrecognized", "Le serveur refuse cette activation. Pour une nouvelle licence propriétaire, ajoutez l’empreinte ci-dessous à la liste des installations autorisées sur le serveur. Pour un abonnement client, vérifiez son autorisation dans le compte Zentra."),
            402 => ("inactive", "L’abonnement associé est inactif. Le jeton signé ne modifie pas son état."),
            429 => ("retry", "Trop de vérifications rapprochées. Patientez avant de réessayer."),
            _ => ("unavailable", "Le serveur ne peut pas valider ce jeton actuellement. Réessayez plus tard."),
        };
        return Ok(Checked {
            accepted: false,
            status: status.into(),
            message: message.into(),
            signed: None,
        });
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "La réponse du serveur est incomplète.")?;
        if bytes.len() + chunk.len() > 16384 {
            return Err("Réponse du serveur trop volumineuse.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    #[derive(Deserialize)]
    struct Reply {
        token: String,
    }
    let reply: Reply =
        serde_json::from_slice(&bytes).map_err(|_| "Réponse du serveur invalide.")?;
    let payload = crypto::validate_reply(&candidate, &reply.token)?;
    Ok(Checked { accepted: true, status: "accepted".into(), message: "Le serveur Zentra accepte ce jeton pour cet appareil. Copiez le jeton vérifié dans Zentra pour l’activer.".into(), signed: Some(Signed::new(reply.token, payload)) })
}

#[tauri::command]
async fn verify_activation(token: String, state: tauri::State<'_, AppState>) -> Result<Checked> {
    let checked = check_remote(&token).await?;
    if let Some(signed) = &checked.signed {
        state
            .vault
            .lock()
            .map_err(|_| "Coffre occupé.")?
            .save(&signed.token, &signed.payload)?;
    }
    Ok(checked)
}

#[tauri::command]
fn copy_text(text: String, window: tauri::WebviewWindow) -> Result<()> {
    // This command only writes explicitly requested output; it never reads the clipboard.
    use windows_sys::Win32::{
        Foundation::GlobalFree,
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        },
    };
    if text.len() > 16384 || text.contains('\0') {
        return Err("Texte à copier invalide.".into());
    }
    let owner = window
        .hwnd()
        .map_err(|_| "Fenêtre de copie indisponible.")?
        .0;
    let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let mem = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2);
        if mem.is_null() {
            return Err("Presse-papiers indisponible.".into());
        }
        let pointer = GlobalLock(mem);
        if pointer.is_null() {
            GlobalFree(mem);
            return Err("Presse-papiers indisponible.".into());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), pointer.cast::<u16>(), wide.len());
        GlobalUnlock(mem);
        if OpenClipboard(owner) == 0 {
            GlobalFree(mem);
            return Err("Le presse-papiers est occupé. Réessayez.".into());
        }
        let ok = EmptyClipboard() != 0 && !SetClipboardData(13, mem).is_null();
        CloseClipboard();
        if !ok {
            GlobalFree(mem);
            return Err("Impossible de copier le texte.".into());
        }
    }
    Ok(())
}

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // Read-only local verification used by the installer and release recipe.
    // It writes only non-secret metadata to a caller-selected report file.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--prepare-access-key") {
        use base64::Engine;
        let outcome = Vault::default_root()
            .and_then(|root| access::admin_key(&Vault { root }, true))
            .map(|key| {
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(key.verifying_key().to_bytes())
            });
        if let (Ok(public), Some(path)) = (&outcome, args.get(2)) {
            if std::fs::write(path, public).is_err() {
                std::process::exit(1);
            }
        } else {
            std::process::exit(1);
        }
        std::process::exit(0);
    }
    if args.get(1).map(String::as_str) == Some("--check-installation") {
        let outcome = Vault::default_root().and_then(|root| {
            let vault = Vault { root }; vault.key()?;
            let (devices, unreadable) = vault.devices()?;
            Ok(serde_json::json!({"keyMatchesZentra": true, "devices": devices.len(), "unreadable": unreadable}))
        });
        let report = match &outcome {
            Ok(report) => report.clone(),
            Err(message) => serde_json::json!({"keyMatchesZentra":false,"error":message}),
        };
        if let Some(path) = args.get(2) {
            let _ = std::fs::write(path, report.to_string());
        }
        std::process::exit(if outcome.is_ok() { 0 } else { 1 });
    }
    let root = Vault::default_root().expect("Profil Windows requis");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(AppState {
            vault: Mutex::new(Vault { root }),
        })
        .invoke_handler(tauri::generate_handler![
            access::founder_status,
            access::founder_request,
            status,
            load_token,
            inspect,
            sign_token,
            verify_activation,
            copy_text
        ])
        .run(tauri::generate_context!())
        .expect("Impossible d’ouvrir Zentra Fondateur");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_uuid_preview_is_not_an_authorization_claim() {
        let temp = tempfile::tempdir().unwrap();
        let vault = Vault {
            root: temp.path().to_owned(),
        };
        let preview = prepare("67977efd-492e-4e01-b719-5fe42b7c3d2d", &vault).unwrap();
        assert!(!preview.known_device);
        assert_eq!(preview.source_kind, "installation");
        assert!(vault.devices().unwrap().0.is_empty());
    }
    #[test]
    fn stale_preview_and_invalid_expiry_fail_before_key_access() {
        let temp = tempfile::tempdir().unwrap();
        let vault = Vault {
            root: temp.path().to_owned(),
        };
        let p = crypto::owner_payload("67977efd-492e-4e01-b719-5fe42b7c3d2d");
        let source = serde_json::to_string(&p).unwrap();
        let mut changed = p.clone();
        changed.plan = "zentra-pro-monthly-89-chf".into();
        let error = issue(
            SignRequest {
                source: source.clone(),
                expected_payload: changed,
                customer_name: "Test".into(),
                valid_until: "2036-12-31".into(),
            },
            &vault,
        )
        .err()
        .unwrap();
        assert!(error.contains("changé"));
        let error = issue(
            SignRequest {
                source,
                expected_payload: p,
                customer_name: "Test".into(),
                valid_until: "2020-01-01".into(),
            },
            &vault,
        )
        .err()
        .unwrap();
        assert!(error.contains("échéance"));
    }
    #[test]
    #[ignore = "Read-only access to the real Windows vault and Zentra HTTPS service"]
    fn live_owner_signing_and_server_acceptance() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let vault = Vault {
            root: Vault::default_root().unwrap(),
        };
        let token = vault.token("owner-license-token-iphone.dpapi").unwrap();
        let mut payload = crypto::verify_with(&token, &crypto::public_key().unwrap()).unwrap();
        payload.issued_at = Utc::now().to_rfc3339();
        payload.jti = uuid::Uuid::new_v4().to_string();
        let signed = crypto::sign_with(&payload, &vault.key().unwrap()).unwrap();
        let checked = tauri::async_runtime::block_on(check_remote(&signed)).unwrap();
        assert!(checked.accepted, "{}", checked.message);
        let result = checked.signed.unwrap();
        assert_eq!(result.payload.installation_id, payload.installation_id);
        assert_eq!(result.payload.license_id, payload.license_id);
    }
}
