#[tauri::command]
pub async fn set_app_appearance(app: tauri::AppHandle, appearance: String, dark: bool) -> Result<(), String> {
 let theme = match appearance.as_str() { "system" => None, "light" => Some(tauri::Theme::Light), "dark" => Some(tauri::Theme::Dark), _ => return Err("Apparence inconnue".into()) };
 #[cfg(not(any(target_os="ios",target_os="android")))] { let _=dark; app.set_theme(theme); }
 #[cfg(any(target_os="ios",target_os="android"))] { let _=(app,theme);tauri::async_runtime::spawn_blocking(move || tauri_plugin_zentra_mobile::configure_appearance(&appearance,dark)).await.map_err(|e|e.to_string())??; }
 Ok(())
}
