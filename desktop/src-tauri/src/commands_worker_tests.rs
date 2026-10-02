use super::*;
use crate::error::AppError;
use futures_util::future::join;
use rusqlite::params;
use serde_json::json;
use std::{sync::mpsc, thread, time::Duration};

fn fixture() -> (tempfile::TempDir, LocalStore) {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store
        .connect()
        .unwrap()
        .execute(
            "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at)
         VALUES(1,1,'Worker fixture','2026-10-02T00:00:00Z','2026-10-02T00:00:00Z')",
            [],
        )
        .unwrap();
    (temporary, store)
}

#[test]
fn blocking_local_work_does_not_stop_the_waiting_executor() {
    let (_temporary, store) = fixture();
    let invoking_thread = thread::current().id();
    let (continue_tx, continue_rx) = mpsc::channel();
    let (result, ()) = tauri::async_runtime::block_on(join(
        run_locked_local_operation(store.clone(), move |store| {
            assert_ne!(thread::current().id(), invoking_thread);
            // An inline/blocking command would prevent the joined future from
            // supplying this signal and fail instead of creating the backup.
            continue_rx
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| {
                    AppError::Validation("The waiting executor did not continue.".into())
                })?;
            store.create_backup(None, "worker-test")
        }),
        async move {
            continue_tx.send(()).unwrap();
        },
    ));
    let path = result.unwrap();
    assert!(std::path::Path::new(&path).is_file());
    let archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    assert!(archive.file_names().any(|name| name == "database.sqlite3"));
}

#[test]
fn local_worker_preserves_operation_errors_and_export_data() {
    let (temporary, store) = fixture();
    let error = tauri::async_runtime::block_on(run_locked_local_operation(store.clone(), |_| {
        Err::<(), _>(AppError::Validation("Export deliberately rejected.".into()))
    }))
    .unwrap_err();
    assert_eq!(
        error,
        command_error(AppError::Validation("Export deliberately rejected.".into()))
    );
    let before = store.get_workspace().unwrap();
    let destination = temporary
        .path()
        .join("worker.json")
        .to_string_lossy()
        .into_owned();
    let exported =
        tauri::async_runtime::block_on(run_locked_local_operation(store.clone(), move |store| {
            store.export_json(Some(destination), "worker-test")
        }))
        .unwrap();
    let envelope: Value = serde_json::from_slice(&std::fs::read(exported).unwrap()).unwrap();
    assert_eq!(envelope["data"], before);
    assert_eq!(store.get_workspace().unwrap(), before);
}

#[test]
fn manual_restore_refuses_in_flight_transfers_before_replacing_company_data() {
    let _test_guard = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let (_temporary, store) = fixture();
    let original = store
        .create_record("clients", json!({"name":"Saved client"}))
        .unwrap();
    let backup = store.create_backup(None, "worker-test").unwrap();
    let current = store
        .create_record("clients", json!({"name":"Unsaved client"}))
        .unwrap();
    let before = store.get_workspace().unwrap();

    {
        // This is the guard kept by company/cloud uploads throughout network I/O.
        let _transfer = crate::cloud_backup::TransferGuard::take().unwrap();
        let error = tauri::async_runtime::block_on(restore_local_backup(
            store.clone(),
            backup.clone(),
            "worker-test".into(),
        ))
        .err()
        .unwrap();
        assert!(error.contains("Une opération de sauvegarde est déjà en cours."));
        assert_eq!(store.get_workspace().unwrap(), before);
        assert!(store
            .account_protected_cache
            .operation_lock
            .try_lock()
            .is_some());
    }
    {
        // sync_project_documents holds this same guard while its GET is pending.
        let _sync = crate::project_sync::pause_for_workspace_change().unwrap();
        let error = tauri::async_runtime::block_on(restore_local_backup(
            store.clone(),
            backup.clone(),
            "worker-test".into(),
        ))
        .err()
        .unwrap();
        assert!(error.contains("Les documents se synchronisent."));
        assert_eq!(store.get_workspace().unwrap(), before);
        assert!(store
            .account_protected_cache
            .operation_lock
            .try_lock()
            .is_some());
        // Failure after taking the transfer gate must release it for the retry.
        let _released_transfer = crate::cloud_backup::TransferGuard::take().unwrap();
    }

    let state = tauri::async_runtime::block_on(restore_local_backup(
        store.clone(),
        backup,
        "worker-test".into(),
    ))
    .unwrap();
    assert!(state.onboarding_completed);
    let connection = store.connect().unwrap();
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM clients WHERE id=?",
            params![original["id"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM clients WHERE id=?",
            params![current["id"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert!(store
        .account_protected_cache
        .operation_lock
        .try_lock()
        .is_some());
    let _released_transfer = crate::cloud_backup::TransferGuard::take().unwrap();
    let _released_sync = crate::project_sync::pause_for_workspace_change().unwrap();
}
