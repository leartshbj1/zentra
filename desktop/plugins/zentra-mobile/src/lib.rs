use std::sync::OnceLock;
use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, AppHandle, Manager, Wry};
use serde_json::{json, Value};

static APP: OnceLock<AppHandle> = OnceLock::new();
struct Mobile(PluginHandle<Wry>);
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_zentra_mobile);

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("zentra-mobile").setup(|app, api| {
        #[cfg(target_os = "android")]
        let handle = api.register_android_plugin("ch.zentra.mobile", "ZentraMobilePlugin")?;
        #[cfg(target_os = "ios")]
        let handle = api.register_ios_plugin(init_plugin_zentra_mobile)?;
        app.manage(Mobile(handle));
        let _ = APP.set(app.clone());
        Ok(())
    }).build()
}

/// Only the Rust application calls these APIs after checking the selected local path or URL.
/// Do not invoke from the UI thread: callers dispatch through spawn_blocking.
pub fn share_file(path: &std::path::Path) -> Result<(), String> {
    let app = APP.get().ok_or("Partage mobile indisponible")?;
    app.state::<Mobile>().0.run_mobile_plugin::<Value>("shareFile", json!({"path":path.to_string_lossy()})).map(|_| ()).map_err(|error| error.to_string())
}

pub fn open_url(url: &str) -> Result<(), String> {
    let app = APP.get().ok_or("Navigateur mobile indisponible")?;
    app.state::<Mobile>().0.run_mobile_plugin::<Value>("openUrl", json!({"url":url})).map(|_| ()).map_err(|error| error.to_string())
}

pub fn file_name(url: &str) -> Result<String, String> {
    let app = APP.get().ok_or("Fichiers mobiles indisponibles")?;
    let result: Value = app.state::<Mobile>().0.run_mobile_plugin("fileName", json!({"url":url})).map_err(|error| error.to_string())?;
    result["name"].as_str().map(str::to_owned).ok_or("Nom du document indisponible".into())
}
