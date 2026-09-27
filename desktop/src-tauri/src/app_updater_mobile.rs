use serde_json::{json, Value};
use tauri::{ipc::Channel, Runtime};

pub fn ensure_rustls_crypto_provider() -> Result<(), String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        Err("Initialisation TLS impossible.".into())
    } else {
        Ok(())
    }
}

pub fn initialize<R: Runtime>(_app: &mut tauri::App<R>) -> tauri::Result<()> {
    ensure_rustls_crypto_provider().map_err(|error| tauri::Error::Io(std::io::Error::other(error)))
}

#[tauri::command]
pub fn get_secure_update_policy() -> Value {
    json!({"enabled":false,"currentVersion":env!("CARGO_PKG_VERSION"),"channel":"store","endpointHost":null,"signatureRequired":true,"transport":"store","automaticInstall":false,"reason":"Les mises à jour mobiles ne s’installent pas depuis cet écran. Utilisez la boutique ou l’outil avec lequel vous avez installé Zentra."})
}

#[tauri::command]
pub fn check_secure_update() -> Result<Option<Value>, String> {
    Err("Utilisez la boutique ou l’outil avec lequel vous avez installé Zentra.".into())
}

#[tauri::command]
pub fn install_secure_update(_on_event: Channel<Value>) -> Result<(), String> {
    Err("Les mises à jour mobiles ne s’installent pas depuis cet écran.".into())
}
