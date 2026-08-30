use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::{
    database::LocalStore,
    error::command_error,
    models::{AppStateInfo, DeleteResult, OnboardingInput, RecordPaymentInput, TimerInput},
};

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn get_app_state(state: State<'_, LocalStore>, app: AppHandle) -> Result<AppStateInfo, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.app_state(&app_version(&app)).map_err(command_error)
}

#[tauri::command]
pub fn complete_onboarding(
    state: State<'_, LocalStore>,
    app: AppHandle,
    input: OnboardingInput,
) -> Result<AppStateInfo, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .complete_onboarding(input, &app_version(&app))
        .map_err(command_error)
}

#[tauri::command]
pub fn get_workspace(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_workspace().map_err(command_error)
}

#[tauri::command]
pub fn create_record(
    state: State<'_, LocalStore>,
    entity: String,
    data: Value,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.create_record(&entity, data).map_err(command_error)
}

#[tauri::command]
pub fn update_record(
    state: State<'_, LocalStore>,
    entity: String,
    id: String,
    data: Value,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .update_record(&entity, &id, data)
        .map_err(command_error)
}

#[tauri::command]
pub fn delete_record(
    state: State<'_, LocalStore>,
    entity: String,
    id: String,
) -> Result<DeleteResult, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.delete_record(&entity, &id).map_err(command_error)
}

#[tauri::command]
pub fn update_settings(state: State<'_, LocalStore>, data: Value) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.update_settings(data).map_err(command_error)
}

#[tauri::command]
pub fn issue_quote(
    state: State<'_, LocalStore>,
    id: String,
    issue_date: Option<String>,
    valid_until: Option<String>,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .issue_quote(&id, issue_date, valid_until)
        .map_err(command_error)
}

#[tauri::command]
pub fn issue_invoice(
    state: State<'_, LocalStore>,
    id: String,
    issue_date: Option<String>,
    due_date: Option<String>,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .issue_invoice(&id, issue_date, due_date)
        .map_err(command_error)
}

#[tauri::command]
pub fn record_payment(
    state: State<'_, LocalStore>,
    input: RecordPaymentInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.record_payment(input).map_err(command_error)
}

#[tauri::command]
pub fn start_timer(state: State<'_, LocalStore>, input: TimerInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.start_timer(input).map_err(command_error)
}

#[tauri::command]
pub fn stop_timer(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.stop_timer().map_err(command_error)
}

#[tauri::command]
pub fn cancel_timer(state: State<'_, LocalStore>) -> Result<DeleteResult, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.cancel_timer().map_err(command_error)
}

#[tauri::command]
pub fn get_active_timer(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_active_timer().map_err(command_error)
}

#[tauri::command]
pub fn create_backup(
    state: State<'_, LocalStore>,
    app: AppHandle,
    destination: Option<String>,
) -> Result<String, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .create_backup(destination, &app_version(&app))
        .map_err(command_error)
}

#[tauri::command]
pub fn restore_backup(
    state: State<'_, LocalStore>,
    app: AppHandle,
    source: String,
) -> Result<AppStateInfo, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .restore_backup(&source, &app_version(&app))
        .map_err(command_error)?;
    state.app_state(&app_version(&app)).map_err(command_error)
}

#[tauri::command]
pub fn export_json(
    state: State<'_, LocalStore>,
    app: AppHandle,
    destination: Option<String>,
) -> Result<String, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .export_json(destination, &app_version(&app))
        .map_err(command_error)
}

#[tauri::command]
pub fn add_attachment(state: State<'_, LocalStore>, input: Value) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.add_attachment(input).map_err(command_error)
}

#[tauri::command]
pub fn open_attachment(state: State<'_, LocalStore>, id: String) -> Result<String, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.open_attachment(&id).map_err(command_error)
}

#[tauri::command]
pub fn open_data_folder(state: State<'_, LocalStore>) -> Result<String, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.open_data_folder().map_err(command_error)
}

pub fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(configured) = std::env::var_os("HELVICHANTIER_DATA_DIR") {
        let path = PathBuf::from(configured);
        if !path.is_absolute() {
            return Err("HELVICHANTIER_DATA_DIR doit être un chemin absolu".into());
        }
        return Ok(path);
    }
    use tauri::Manager;
    Ok(app.path().app_local_data_dir()?)
}
