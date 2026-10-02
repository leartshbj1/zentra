//! Actual project IPC handlers and real restores in temporary, licensed stores.
//! Native CI executes these tests; parsing and browser fixtures do not prove them.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::future::join;
use serde_json::json;
use std::{sync::mpsc, thread, time::Duration};
use tauri::Manager;

#[derive(Clone, Copy, Debug)]
enum Operation {
    Add,
    Read,
    Delete,
}

fn input(project: &str) -> crate::project_documents::AddProjectDocumentInput {
    crate::project_documents::AddProjectDocumentInput {
        project_id: project.into(),
        original_name: "synthetic-new.txt".into(),
        content_base64: STANDARD.encode(b"Synthetic new project document"),
    }
}

fn document(store: &LocalStore) -> (String, String, std::path::PathBuf) {
    let project = store
        .create_record("projects", json!({"name":"Synthetic scoped project"}))
        .unwrap();
    let project = project["id"].as_str().unwrap().to_owned();
    let row = store
        .add_project_document(crate::project_documents::AddProjectDocumentInput {
            project_id: project.clone(),
            original_name: "synthetic-original.txt".into(),
            content_base64: STANDARD.encode(b"Synthetic original project document"),
        })
        .unwrap();
    (
        project,
        row["id"].as_str().unwrap().into(),
        store
            .safe_attachment_path(row["stored_name"].as_str().unwrap())
            .unwrap(),
    )
}

async fn run(
    state: State<'_, LocalStore>,
    operation: Operation,
    project: &str,
    document: &str,
    expected: Option<String>,
) -> Result<Value, String> {
    match operation {
        Operation::Add => add_project_document(state, input(project), expected).await,
        Operation::Read => read_project_document(state, document.into(), expected)
            .await
            .map(|bytes| json!(bytes)),
        Operation::Delete => delete_project_document(state, document.into(), expected).await,
    }
}

#[test]
fn queued_project_handlers_reject_the_original_scope_after_a_real_restore_with_same_uuids() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let (_temporary, store) = fixture();
    let (project, document, path) = document(&store);
    let backup = store.create_backup(None, "project-scope-test").unwrap();
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    for operation in [Operation::Add, Operation::Read, Operation::Delete] {
        let origin = scope(&store);
        let replacing = store.clone();
        let backup = backup.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (replace_tx, replace_rx) = mpsc::channel();
        let holder = thread::spawn(move || {
            let _guard = replacing.lock().unwrap();
            ready_tx.send(()).unwrap();
            let released = replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
            replacing
                .restore_backup(&backup, "project-scope-test")
                .unwrap();
            // Compare after restoration: the guard must not change its destination.
            (released, replacing.get_workspace().unwrap())
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (result, ()) = tauri::async_runtime::block_on(join(
            run(
                app.state(),
                operation,
                &project,
                &document,
                Some(origin.clone()),
            ),
            async move {
                replace_tx.send(()).unwrap();
            },
        ));
        let (released, restored) = holder.join().unwrap();
        assert!(
            released,
            "{operation:?} blocked the executor waiting for the store lock"
        );
        assert!(
            result
                .unwrap_err()
                .contains("L’entreprise ouverte a changé"),
            "{operation:?}"
        );
        assert_ne!(scope(&store), origin);
        assert_eq!(store.get_workspace().unwrap(), restored);
        assert_eq!(restored["projects"][0]["id"], project);
        assert_eq!(restored["attachments"][0]["id"], document);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"Synthetic original project document"
        );
    }
}

#[test]
fn current_scope_and_legacy_none_keep_exact_bytes_deduplication_and_delete_receipts() {
    let (_temporary, store) = fixture();
    let (project, document, original_path) = document(&store);
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let current = scope(&store);
    let first = tauri::async_runtime::block_on(run(
        app.state(),
        Operation::Add,
        &project,
        &document,
        Some(current.clone()),
    ))
    .unwrap();
    let duplicate =
        tauri::async_runtime::block_on(run(app.state(), Operation::Add, &project, &document, None))
            .unwrap();
    assert_eq!(first["id"], duplicate["id"]);
    assert_eq!(
        store.get_workspace().unwrap()["attachments"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    for expected in [Some(current.clone()), None] {
        let bytes = tauri::async_runtime::block_on(run(
            app.state(),
            Operation::Read,
            &project,
            &document,
            expected,
        ))
        .unwrap();
        assert_eq!(
            bytes,
            STANDARD.encode(b"Synthetic original project document")
        );
    }
    let receipt = tauri::async_runtime::block_on(run(
        app.state(),
        Operation::Delete,
        &project,
        &document,
        Some(current),
    ))
    .unwrap();
    assert_eq!(receipt, json!({"deleted":true}));
    assert!(!original_path.exists());
    let added = first["id"].as_str().unwrap();
    let receipt =
        tauri::async_runtime::block_on(run(app.state(), Operation::Delete, &project, added, None))
            .unwrap();
    assert_eq!(receipt, json!({"deleted":true}));
    assert!(store.get_workspace().unwrap()["attachments"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn scope_is_checked_before_decoding_or_opening_missing_project_files() {
    let (_temporary, store) = fixture();
    let (project, document, path) = document(&store);
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let before = store.get_workspace().unwrap();
    let bytes = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    let wrong = Some("synthetic-previous-workspace".into());
    let invalid = crate::project_documents::AddProjectDocumentInput {
        project_id: "invalid".into(),
        original_name: "../invalid".into(),
        content_base64: "invalid".into(),
    };
    let error =
        tauri::async_runtime::block_on(add_project_document(app.state(), invalid, wrong.clone()))
            .unwrap_err();
    assert!(error.contains("L’entreprise ouverte a changé"));
    for operation in [Operation::Read, Operation::Delete] {
        let error = tauri::async_runtime::block_on(run(
            app.state(),
            operation,
            &project,
            &document,
            wrong.clone(),
        ))
        .unwrap_err();
        assert!(
            error.contains("L’entreprise ouverte a changé"),
            "{operation:?}"
        );
    }
    // A current reader reaches the missing-file check; a stale reader did not.
    assert!(!tauri::async_runtime::block_on(run(
        app.state(),
        Operation::Read,
        &project,
        &document,
        None
    ))
    .unwrap_err()
    .contains("L’entreprise ouverte a changé"));
    assert_eq!(store.get_workspace().unwrap(), before);
    assert!(!path.exists());
    std::fs::write(&path, bytes).unwrap();
}

#[test]
fn project_write_handlers_still_refuse_missing_and_read_only_licenses() {
    let (_temporary, store) = unlicensed_fixture();
    let (project, document, path) = document(&store);
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    for read_only in [false, true] {
        if read_only {
            store
                .install_server_issued_license(&signed_fixture_token(&store, "read_only"))
                .unwrap();
        }
        let before = store.get_workspace().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        for expected in [Some(scope(&store)), None] {
            for operation in [Operation::Add, Operation::Delete] {
                let error = tauri::async_runtime::block_on(run(
                    app.state(),
                    operation,
                    &project,
                    &document,
                    expected.clone(),
                ))
                .unwrap_err();
                assert!(
                    error.contains("lecture"),
                    "{read_only}/{operation:?}: {error}"
                );
            }
            // File reading retains its existing contract, including read-only use.
            assert_eq!(
                tauri::async_runtime::block_on(run(
                    app.state(),
                    Operation::Read,
                    &project,
                    &document,
                    expected
                ))
                .unwrap(),
                STANDARD.encode(&bytes)
            );
        }
        assert_eq!(store.get_workspace().unwrap(), before);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

#[cfg(target_os = "windows")]
#[test]
fn a_locked_project_file_keeps_its_confirmed_delete_receipt_and_a_single_audit() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_temporary, store) = fixture();
    let (project, document, path) = document(&store);
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&path)
        .unwrap();
    // Real OS control: Windows denied unlink before the real handler ran.
    assert_eq!(
        std::fs::remove_file(&path).unwrap_err().raw_os_error(),
        Some(32)
    );
    let count = || {
        store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM audit_log WHERE action='attachment_delete'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    let before = count();
    let receipt = tauri::async_runtime::block_on(run(
        app.state(),
        Operation::Delete,
        &project,
        &document,
        Some(scope(&store)),
    ))
    .unwrap();
    assert_eq!(receipt, json!({"deleted":true}));
    assert_eq!(count(), before + 1);
    assert!(store.get_workspace().unwrap()["attachments"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(path.exists());
    assert_eq!(
        std::fs::remove_file(&path).unwrap_err().raw_os_error(),
        Some(32)
    );
    assert!(tauri::async_runtime::block_on(run(
        app.state(),
        Operation::Delete,
        &project,
        &document,
        Some(scope(&store))
    ))
    .is_err());
    assert_eq!(count(), before + 1);
    drop(locked);
    std::fs::remove_file(path).unwrap();
}
