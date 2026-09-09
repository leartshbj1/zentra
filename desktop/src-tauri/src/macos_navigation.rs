//! AppKit navigation above the web content. NSGlassEffectView is resolved at
//! runtime, so pre-Tahoe installations keep the complete HTML navigation.
use serde_json::{json, Value};

#[tauri::command]
pub async fn configure_macos_navigation(
    window: tauri::WebviewWindow,
    selected: String,
    visible: bool,
    on_navigate: tauri::ipc::Channel<Value>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Ok(json!({"available": false}));
    }
    if !["dashboard", "projects", "quotes", "menu"].contains(&selected.as_str()) {
        return Err("Navigation inconnue".into());
    }
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            app.run_on_main_thread(move || {
                let result = (|| {
                    let pointer = window.ns_window().map_err(|error| error.to_string())?;
                    // Tauri owns this NSWindow and dispatches this closure on its UI thread.
                    let Some(native_window) =
                        (unsafe { pointer.cast::<objc2_app_kit::NSWindow>().as_ref() })
                    else {
                        return Ok(json!({"available": false}));
                    };
                    let available = native::configure(
                        native_window,
                        &selected,
                        visible,
                        Box::new(move |id| on_navigate.send(json!({"id": id})).is_ok()),
                    )?;
                    Ok(json!({"available": available}))
                })();
                let _ = sender.send(result);
            })
            .map_err(|error| error.to_string())?;
            receiver.recv().map_err(|error| error.to_string())?
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, selected, visible, on_navigate);
        Ok(json!({"available": false}))
    }
}

#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
pub fn hide_on_reload() {
    native::hide();
}

#[cfg(target_os = "macos")]
mod native;
