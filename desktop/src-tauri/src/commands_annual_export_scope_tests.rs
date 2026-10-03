//! Synthetic annual-account IPC worker and origin-scope regressions.
//! Every file, issuer and licence is synthetic; no external API or viewer runs.
use super::import_worker_tests::{scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use futures_util::future::join;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{future::Future, path::Path, sync::mpsc, thread, time::Duration};
use tauri::Manager;

const SENTINEL: &[u8] = b"SYNTHETIC EXISTING ANNUAL PDF";

fn filter() -> PeriodFilter {
    PeriodFilter {
        date_from: Some("2026-01-01".into()),
        date_to: Some("2026-12-31".into()),
    }
}

fn fixture() -> (tempfile::TempDir, LocalStore) {
    let (temporary, store) = unlicensed_fixture();
    crate::tests::enable_accounting(&store);
    store.update_settings(json!({"company_name":"SYNTHETIC ORIGIN ANNUAL ISSUER"})).unwrap();
    (temporary, store)
}

fn pdf_text(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));
    let document = lopdf::Document::load_mem(&bytes).unwrap();
    assert!(!document.get_pages().is_empty());
    document.extract_text(&document.get_pages().keys().copied().collect::<Vec<_>>()).unwrap()
}

fn responsive<T>(store: &LocalStore, command: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    let held = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = held.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(command, async move {
        let _ = release_tx.send(());
    }));
    assert!(holder.join().unwrap(), "the actual annual handler blocked the second executor future");
    result
}

fn replacing_backup(store: &LocalStore) -> (String, String) {
    let client = store.create_record("clients", json!({"name":"SYNTHETIC SHARED UUID CLIENT"})).unwrap();
    let client = client["id"].as_str().unwrap().to_owned();
    store.update_settings(json!({"company_name":"SYNTHETIC REPLACEMENT ANNUAL ISSUER"})).unwrap();
    let backup = store.create_backup(None, "annual-scope-test").unwrap();
    store.update_settings(json!({"company_name":"SYNTHETIC ORIGIN ANNUAL ISSUER"})).unwrap();
    (backup, client)
}

fn after_queued_restore<T>(store: &LocalStore, backup: String, command: impl Future<Output = Result<T, String>>) -> (Result<T, String>, Value) {
    let replacing = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (restore_tx, restore_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = replacing.lock().unwrap();
        ready_tx.send(()).unwrap();
        let released = restore_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        replacing.restore_backup(&backup, "annual-scope-test").unwrap();
        (released, replacing.get_workspace().unwrap())
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(command, async move {
        restore_tx.send(()).unwrap();
    }));
    let (released, restored) = holder.join().unwrap();
    assert!(released, "the actual annual command prevented the queued restore release");
    (result, restored)
}

// Exact baseline body/signature from source 3e77d0de, except this test-only name.
async fn baseline_export_annual_accounts_pdf(
    state: State<'_, LocalStore>,
    filter: PeriodFilter,
    destination_path: String,
) -> Result<Value, String> {
    run_locked_local_operation(state.inner().clone(), move |store| {
        store.export_annual_accounts_pdf(filter, &destination_path)
    }).await
}

#[test]
fn baseline_annual_worker_can_export_the_replacement_issuer_after_a_real_queued_restore() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (temporary, store) = fixture();
    let (backup, client) = replacing_backup(&store);
    let origin = scope(&store);
    let destination = temporary.path().join("baseline-annual.pdf");
    std::fs::write(&destination, SENTINEL).unwrap();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let (result, restored) = after_queued_restore(&store, backup, baseline_export_annual_accounts_pdf(
        app.state(), filter(), destination.to_string_lossy().into_owned(),
    ));
    assert_eq!(result.unwrap()["path"], destination.to_string_lossy().as_ref());
    assert_ne!(scope(&store), origin);
    assert_eq!(restored["clients"][0]["id"], client);
    assert!(pdf_text(&destination).contains("SYNTHETIC REPLACEMENT ANNUAL ISSUER"));
    assert!(!pdf_text(&destination).contains("SYNTHETIC ORIGIN ANNUAL ISSUER"));
    assert_eq!(store.get_workspace().unwrap(), restored);
}

#[test]
fn actual_annual_handler_refuses_old_scope_after_real_restore_before_creating_or_replacing_pdf() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for existing in [false, true] {
        let (temporary, store) = fixture();
        let (backup, client) = replacing_backup(&store);
        let origin = scope(&store);
        let destination = temporary.path().join("scoped-annual.pdf");
        if existing { std::fs::write(&destination, SENTINEL).unwrap(); }
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let (result, restored) = after_queued_restore(&store, backup, export_annual_accounts_pdf(
            app.state(), filter(), destination.to_string_lossy().into_owned(), Some(origin.clone()),
        ));
        assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));
        assert_ne!(scope(&store), origin);
        assert_eq!(restored["clients"][0]["id"], client);
        assert_eq!(restored["settings"][0]["company_name"], "SYNTHETIC REPLACEMENT ANNUAL ISSUER");
        if existing { assert_eq!(std::fs::read(&destination).unwrap(), SENTINEL); }
        else { assert!(!destination.exists()); }
        assert_eq!(store.get_workspace().unwrap(), restored);
    }
}

#[test]
fn annual_current_scope_and_legacy_none_keep_worker_receipts_and_read_only_export_policy() {
    for access in ["missing", "read_only", "owner"] {
        for scoped in [false, true] {
            let (temporary, store) = fixture();
            if access != "missing" { store.install_server_issued_license(&signed_fixture_token(&store, access)).unwrap(); }
            if access != "owner" { assert!(store.require_write_access().is_err()); }
            else { store.require_write_access().unwrap(); }
            let before = store.get_workspace().unwrap();
            let destination = temporary.path().join("current-annual.pdf");
            let app = tauri::test::mock_builder().manage(store.clone())
                .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
            let receipt = responsive(&store, export_annual_accounts_pdf(
                app.state(), filter(), destination.to_string_lossy().into_owned(), scoped.then(|| scope(&store)),
            )).unwrap();
            assert_eq!(receipt["path"], destination.to_string_lossy().as_ref());
            assert_eq!(receipt["closed"], false);
            assert_eq!(receipt["balanced"], true);
            let bytes = std::fs::read(&destination).unwrap();
            assert_eq!(receipt["sha256"], format!("{:x}", Sha256::digest(&bytes)));
            assert!(receipt["pages"].as_u64().unwrap() > 0);
            assert!(pdf_text(&destination).contains("SYNTHETIC ORIGIN ANNUAL ISSUER"));
            assert_eq!(store.get_workspace().unwrap(), before);
        }
    }
}

#[test]
fn annual_origin_guard_runs_before_destination_and_period_validation_without_write_admission() {
    let (_temporary, store) = fixture();
    assert!(store.require_write_access().is_err());
    let before = store.get_workspace().unwrap();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let error = tauri::async_runtime::block_on(export_annual_accounts_pdf(app.state(),
        PeriodFilter { date_from:Some("invalid".into()), date_to:Some("invalid".into()) },
        "not-an-absolute-pdf".into(), Some("synthetic-previous-scope".into()),
    )).unwrap_err();
    assert!(error.contains("L’entreprise ouverte a changé"));
    assert_eq!(store.get_workspace().unwrap(), before);
    let error = tauri::async_runtime::block_on(export_annual_accounts_pdf(app.state(),
        filter(), "not-an-absolute-pdf".into(), Some(scope(&store)),
    )).unwrap_err();
    assert!(error.contains("emplacement local absolu"));
    assert_eq!(store.get_workspace().unwrap(), before);
}

#[test]
fn annual_current_and_none_preserve_original_currency_error_and_existing_destination() {
    let (temporary, store) = fixture();
    let accounts = crate::tests::enable_accounting(&store);
    store.post_manual_journal_entry(crate::models::ManualJournalInput {
        entry_date: "2026-02-16".into(),
        description: "Synthetic foreign journal entry".into(),
        currency: "EUR".into(),
        lines: vec![
            crate::models::ManualJournalLineInput {
                account_id: accounts["bank"].clone(), debit_cents: 100, credit_cents: 0,
                memo: None, project_id: None, client_id: None, employee_id: None,
            },
            crate::models::ManualJournalLineInput {
                account_id: accounts["revenue"].clone(), debit_cents: 0, credit_cents: 100,
                memo: None, project_id: None, client_id: None, employee_id: None,
            },
        ],
    }).unwrap();
    let before = store.get_workspace().unwrap();
    let destination = temporary.path().join("currency-refusal.pdf");
    std::fs::write(&destination, SENTINEL).unwrap();
    let expected = command_error(store.export_annual_accounts_pdf(filter(), destination.to_str().unwrap()).unwrap_err());
    assert!(expected.contains("lignes en EUR"));
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    for scope in [None, Some(scope(&store))] {
        let error = responsive(&store, export_annual_accounts_pdf(app.state(), filter(),
            destination.to_string_lossy().into_owned(), scope,
        )).unwrap_err();
        assert_eq!(error, expected);
        assert_eq!(std::fs::read(&destination).unwrap(), SENTINEL);
        assert_eq!(store.get_workspace().unwrap(), before);
    }
}
