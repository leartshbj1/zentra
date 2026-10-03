use crate::{database::LocalStore, error::{command_error, AppError, AppResult}};
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub fn get_reset_recovery(state: State<'_, LocalStore>) -> Result<Value,String> {
    let path=state.data_dir.join("app-reset-recovery.json");
    if !path.is_file() { return Ok(json!({"available":false})); }
    let marker: Value=serde_json::from_slice(&std::fs::read(&path).map_err(|e|command_error(e.into()))?).map_err(|e|command_error(e.into()))?;
    let file=recovery_path(&state,&marker).map_err(command_error)?;
    Ok(json!({"available":file.is_file(),"createdAt":marker["createdAt"]}))
}

fn recovery_path(store:&LocalStore,marker:&Value)->AppResult<std::path::PathBuf> {
    let name=marker["file"].as_str().unwrap_or_default();
    if !name.starts_with("avant-reinitialisation-") || !name.ends_with(".zentra") || name.contains(['/', '\\', ':']) {
        return Err(AppError::Validation("La sauvegarde de sécurité doit être vérifiée.".into()));
    }
    Ok(store.backups_dir.join(name))
}

#[tauri::command]
pub async fn restore_reset_recovery(state:State<'_,LocalStore>)->Result<(),String> {
    let store=state.inner().clone();
    let _account=store.account_protected_cache.operation_lock.lock().await;
    let _backup=crate::cloud_backup::TransferGuard::take().map_err(command_error)?;
    let _sync=crate::project_sync::pause_for_workspace_change().map_err(command_error)?;
    let owned=store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _local=owned.lock()?;
        crate::cloud_backup::require_empty_company(&owned)?;
        let marker:Value=serde_json::from_slice(&std::fs::read(owned.data_dir.join("app-reset-recovery.json"))?)?;
        let path=recovery_path(&owned,&marker)?;
        crate::account_cloud::forget_local_account(&owned)?;
        owned.restore_backup(&path.to_string_lossy(),env!("CARGO_PKG_VERSION"))?;
        Ok::<_,AppError>(())
    }).await.map_err(|_|"La récupération a été interrompue.".to_owned())?.map_err(command_error)
}

/// Reset only this installation. No remote delete and no invitation/member revocation.
#[tauri::command]
pub async fn reset_local_app(state: State<'_, LocalStore>, confirmation: String) -> Result<Value, String> {
    if confirmation != "REINITIALISER" {
        return Err("Pour confirmer, écrivez REINITIALISER dans le champ prévu.".into());
    }
    let store = state.inner().clone();
    let _account = store.account_protected_cache.operation_lock.lock().await;
    let _backup = crate::cloud_backup::TransferGuard::take().map_err(command_error)?;
    let _sync = crate::project_sync::pause_for_workspace_change().map_err(command_error)?;
    let owned = store.clone();
    tauri::async_runtime::spawn_blocking(move || owned.reset_local_workspace())
        .await.map_err(|_| "La remise à zéro a été interrompue. Relancez Zentra.".to_owned())?
        .map_err(command_error)
}

impl LocalStore {
    pub(crate) fn reset_local_workspace(&self) -> AppResult<Value> {
        let _local = self.lock()?;
        // Validate cleanup targets before changing anything. Never follow a link out of the profile.
        for name in ["exports", "cloud-backups", "company-sync"] {
            let path = self.data_dir.join(name);
            if let Ok(meta) = std::fs::symlink_metadata(&path) {
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    return Err(AppError::Validation("Le dossier local doit être vérifié avant la remise à zéro.".into()));
                }
            }
        }
        let fresh_dir = tempfile::Builder::new().prefix("reset-empty-").tempdir_in(&self.data_dir)?;
        let fresh = LocalStore::initialize(fresh_dir.path().to_path_buf())?;
        let archive = fresh.create_backup(None, env!("CARGO_PKG_VERSION"))?;
        // Native cleanup can fail after the empty database was installed (for example an
        // export still open in another app). Retrying must keep the original recovery copy.
        let previous_recovery = std::fs::read(self.data_dir.join("app-reset-recovery.json"))
            .ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|marker| recovery_path(self, &marker).ok()).filter(|path| path.is_file());
        if previous_recovery.is_none() || crate::cloud_backup::require_empty_company(self).is_err() {
            let recovery_name=format!("avant-reinitialisation-{}.zentra",uuid::Uuid::new_v4());
            self.create_backup_at(&self.backups_dir.join(&recovery_name),env!("CARGO_PKG_VERSION"))?;
            let marker=json!({"file":recovery_name,"createdAt":crate::database::now_iso()});
            let mut marker_file=tempfile::NamedTempFile::new_in(&self.data_dir)?;
            serde_json::to_writer(marker_file.as_file_mut(),&marker)?;
            marker_file.as_file().sync_all()?;
            marker_file.persist(self.data_dir.join("app-reset-recovery.json")).map_err(|e|AppError::Io(e.error))?;
        }
        // Disconnect locally even offline, before replacing the workspace. Existing identity/license
        // files remain bound to this device; account secrets never enter the safety backup.
        crate::account_cloud::forget_local_account(self)?;
        crate::outgoing_mail::clear_local_connections(self)?;
        self.restore_backup(&archive, env!("CARGO_PKG_VERSION"))?;
        for name in ["cloud-backup-state.json", "backup-status.json", "joined-company-copy.json", "company-collaboration.json", "company-sync-baseline.json", "company-sync-reference.zentra"] {
            let path = self.data_dir.join(name);
            if path.exists() { std::fs::remove_file(path)?; }
        }
        for name in ["exports", "cloud-backups", "company-sync"] {
            let path = self.data_dir.join(name);
            if path.exists() { std::fs::remove_dir_all(&path)?; }
        }
        std::fs::create_dir_all(&self.exports_dir)?;
        Ok(json!({"reset":true,"safetyBackupsPreserved":true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager;

    #[test]
    fn actual_failed_reset_recovery_forgets_old_member_context_without_nested_lock_or_company_replacement() {
        let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().into()).unwrap();
        // Private identity is permitted in an otherwise empty company. The
        // real command must reach account removal, then fail on the archive.
        crate::company_collaboration::set_identity(&store, "synthetic-org", &uuid::Uuid::new_v4().to_string(), "Alice", "owner").unwrap();
        let original_nonce = crate::member_context::read(&store.connect().unwrap()).unwrap();
        let original_scope = crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();
        // get_workspace requires onboarding, while this recovery command requires
        // an empty unconfigured company. Read the real domain tables instead;
        // private identity/nonce are intentionally allowed to change below.
        crate::cloud_backup::require_empty_company(&store).unwrap();
        assert!(!store.app_state(env!("CARGO_PKG_VERSION")).unwrap().onboarding_completed);
        let company_snapshot = || {
            let connection = store.connect().unwrap();
            let mut rows = serde_json::Map::new();
            for table in [
                "settings", "clients", "projects", "quotes", "quote_items",
                "invoices", "invoice_items", "employees", "expenses",
                "journal_entries", "journal_lines", "attachments", "audit_log",
                "document_creators", "work_notes", "company_local_clock",
            ] {
                rows.insert(table.into(), json!(crate::database::query_all(
                    &connection, &format!("SELECT * FROM {table} ORDER BY rowid"), [],
                ).unwrap()));
            }
            Value::Object(rows)
        };
        let original_company = company_snapshot();
        let recovery_name = "avant-reinitialisation-synthetic-invalid.zentra";
        std::fs::write(store.backups_dir.join(recovery_name), b"synthetic invalid archive").unwrap();
        std::fs::write(store.data_dir.join("app-reset-recovery.json"), serde_json::to_vec(&json!({"file":recovery_name,"createdAt":"2026-10-03T00:00:00Z"})).unwrap()).unwrap();
        // Synthetic references are never decrypted: forget removes them before
        // archive validation, as the production command does after logout.
        for name in ["cloud-account-session.protected", "cloud-account-link.protected", "cloud-account-exchange.protected"] {
            std::fs::write(store.data_dir.join(name), b"synthetic protected reference").unwrap();
        }
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let error = tauri::async_runtime::block_on(restore_reset_recovery(app.state())).unwrap_err();
        assert!(error.contains("Archive Zentra invalide"), "the failure must happen after account removal, during archive validation: {error}");
        assert!(crate::member_context::require_unchanged(&store.connect().unwrap(), Some(&original_nonce)).is_err());
        assert_eq!(store.connect().unwrap().query_row::<i64, _, _>("SELECT COUNT(*) FROM company_local_identity", [], |row| row.get(0)).unwrap(), 0);
        assert_eq!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(), original_scope, "the failed restore does not replace the company");
        assert_eq!(company_snapshot(), original_company, "failed archive recovery preserves the real unconfigured company rows");
        crate::cloud_backup::require_empty_company(&store).unwrap();
        for name in ["cloud-account-session.protected", "cloud-account-link.protected", "cloud-account-exchange.protected"] {
            assert!(!store.data_dir.join(name).exists());
        }
        assert!(store.backups_dir.join(recovery_name).is_file());
    }

    #[test]
    fn reset_removes_local_company_files_and_preferences_but_preserves_device_and_backups() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().to_path_buf()).unwrap();
        store.connect().unwrap().execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('reset-client','Client local','2026-09-14','2026-09-14')", []).unwrap();
        std::fs::write(store.attachments_dir.join("test.txt"), b"confidential").unwrap();
        std::fs::write(store.exports_dir.join("test.txt"), b"export").unwrap();
        std::fs::write(store.data_dir.join("cloud-backup-state.json"), b"{}").unwrap();
        let identity = store.installation_id.clone();
        store.reset_local_workspace().unwrap();
        let reopened = LocalStore::initialize(dir.path().to_path_buf()).unwrap();
        assert_eq!(reopened.installation_id, identity);
        assert!(!reopened.app_state(env!("CARGO_PKG_VERSION")).unwrap().onboarding_completed);
        assert_eq!(reopened.connect().unwrap().query_row("SELECT COUNT(*) FROM clients", [], |r| r.get::<_,i64>(0)).unwrap(),0);
        assert!(!reopened.attachments_dir.join("test.txt").exists());
        assert!(!reopened.exports_dir.join("test.txt").exists());
        assert!(!reopened.data_dir.join("cloud-backup-state.json").exists());
        let marker: Value=serde_json::from_slice(&std::fs::read(reopened.data_dir.join("app-reset-recovery.json")).unwrap()).unwrap();
        let safety=recovery_path(&reopened,&marker).unwrap();
        // A retry after native cleanup failed must still offer the original company.
        reopened.reset_local_workspace().unwrap();
        let retry_marker: Value=serde_json::from_slice(&std::fs::read(reopened.data_dir.join("app-reset-recovery.json")).unwrap()).unwrap();
        assert_eq!(retry_marker, marker);
        reopened.restore_backup(safety.to_str().unwrap(),env!("CARGO_PKG_VERSION")).unwrap();
        assert_eq!(reopened.connect().unwrap().query_row("SELECT name FROM clients WHERE id='reset-client'", [], |r| r.get::<_,String>(0)).unwrap(),"Client local");
        assert_eq!(std::fs::read(reopened.attachments_dir.join("test.txt")).unwrap(),b"confidential");
    }
    #[test]
    fn recovery_marker_never_accepts_an_external_path() {
        let dir=tempfile::tempdir().unwrap();let store=LocalStore::initialize(dir.path().into()).unwrap();
        for file in ["../secret.zentra","avant-reinitialisation-../secret.zentra","avant-reinitialisation-C:\\secret.zentra"] {
            assert!(recovery_path(&store,&json!({"file":file})).is_err());
        }
    }
}
