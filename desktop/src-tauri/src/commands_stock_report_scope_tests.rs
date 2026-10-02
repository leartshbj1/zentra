//! Actual stock/report handlers with held store locks and synthetic profiles.
//! Fixtures use temporary stores and their per-store synthetic signing authority.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use crate::models::StockCountInput;
use futures_util::future::join;
use serde_json::json;
use std::{future::Future, path::Path, sync::mpsc, thread, time::Duration};
use tauri::Manager;

#[derive(Clone, Copy, Debug)]
enum Operation { Entry, Exit, Correction, Count }
const OPERATIONS: [Operation; 4] = [Operation::Entry, Operation::Exit,
    Operation::Correction, Operation::Count];

fn tracked_item(store: &LocalStore) -> String {
    let item = store.create_record("catalog_items", json!({
        "sku":"SYNTHETIC-SCOPE-ITEM", "name":"Synthetic scoped stock",
        "unit":"piece", "kind":"product", "track_stock":true,
        "purchase_cost_cents":100, "sales_price_cents":200, "vat_bp":0
    })).unwrap();
    let id = item["id"].as_str().unwrap().to_owned();
    store.record_stock_entry(StockEntryInput {
        request_id:uuid::Uuid::new_v4().to_string(), catalog_item_id:id.clone(),
        quantity_milli:10_000, reason:"Synthetic opening stock".into(),
        reference:None, date:Some("2026-09-01".into()),
    }).unwrap();
    id
}

async fn run_stock(state: State<'_, LocalStore>, operation: Operation, id: &str,
    request: &str, expected: Option<String>) -> Result<Value, String> {
    let reason = "Synthetic scoped movement".to_owned();
    let date = Some("2026-09-02".to_owned());
    match operation {
        Operation::Entry => record_stock_entry(state, StockEntryInput {
            request_id:request.into(), catalog_item_id:id.into(), quantity_milli:1_000,
            reason, reference:None, date,
        }, expected).await,
        Operation::Exit => record_stock_exit(state, StockExitInput {
            request_id:request.into(), catalog_item_id:id.into(), quantity_milli:1_000,
            reason, reference:None, date,
        }, expected).await,
        Operation::Correction => record_stock_correction(state, StockCorrectionInput {
            request_id:request.into(), catalog_item_id:id.into(), delta_quantity_milli:-500,
            reason, reference:None, date,
        }, expected).await,
        Operation::Count => record_stock_count(state, StockCountInput {
            request_id:request.into(), catalog_item_id:id.into(), expected_quantity_milli:10_000,
            counted_quantity_milli:9_000, reason, reference:None, date,
        }, expected).await,
    }
}

fn snapshot(store: &LocalStore) -> Value {
    let db = store.connect().unwrap();
    let mut result = serde_json::Map::new();
    for table in ["settings", "catalog_items", "stock_movements", "stock_reservation_events", "audit_log"] {
        result.insert(table.into(), Value::Array(crate::database::query_all(
            &db, &format!("SELECT * FROM {table} ORDER BY rowid"), [],
        ).unwrap()));
    }
    Value::Object(result)
}

fn responsive<T>(store: &LocalStore, command: impl Future<Output=Result<T,String>>) -> Result<T,String> {
    let locked = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = locked.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(command, async move {
        let _ = release_tx.send(());
    }));
    assert!(holder.join().unwrap(), "actual handler blocked the waiting executor");
    result
}

fn after_queued_restore<T>(store: &LocalStore, backup: String,
    command: impl Future<Output=Result<T,String>>) -> (Result<T,String>, Value) {
    let replacing = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (replace_tx, replace_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = replacing.lock().unwrap();
        ready_tx.send(()).unwrap();
        let released = replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        replacing.restore_backup(&backup, "stock-report-worker-test").unwrap();
        (released, snapshot(&replacing))
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(command, async move {
        let _ = replace_tx.send(());
    }));
    let (released, restored) = holder.join().unwrap();
    assert!(released, "restore future could not run while command queued on LocalStore");
    (result, restored)
}

fn report() -> crate::project_report::ProjectReport {
    serde_json::from_value(json!({
        "language":"fr", "title":"SCOPED SYNTHETIC REPORT", "subtitle":"Synthetic data only",
        "sections":[{"title":"Facts", "headers":["Reference"], "rows":[["SYNTHETIC REPORT CONTENT"]]}]
    })).unwrap()
}

fn pdf_text(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));
    let document = lopdf::Document::load_mem(&bytes).unwrap();
    let pages = document.get_pages().keys().copied().collect::<Vec<_>>();
    assert!(!pages.is_empty());
    document.extract_text(&pages).unwrap()
}

#[test]
fn all_four_stock_handlers_yield_keep_receipts_and_replay_without_another_write() {
    for operation in OPERATIONS {
        let (_temporary, store) = fixture();
        let id = tracked_item(&store);
        let request = uuid::Uuid::new_v4().to_string();
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let before = snapshot(&store);
        let receipt = responsive(&store, run_stock(app.state(), operation, &id, &request,
            Some(scope(&store)))).unwrap();
        let expected = match operation { Operation::Entry => 11_000, Operation::Exit => 9_000,
            Operation::Correction => 9_500, Operation::Count => 9_000 };
        assert_eq!(receipt["catalog_item"]["id"], id);
        assert_eq!(receipt["catalog_item"]["stock_quantity_milli"], expected);
        assert_eq!(receipt["movement"]["request_id"], request);
        assert_eq!(receipt["idempotent"], false);
        let committed = snapshot(&store);
        assert_eq!(committed["stock_movements"].as_array().unwrap().len(),
            before["stock_movements"].as_array().unwrap().len() + 1);
        assert_eq!(committed["audit_log"].as_array().unwrap().len(),
            before["audit_log"].as_array().unwrap().len() + 1);
        let replay = tauri::async_runtime::block_on(run_stock(app.state(), operation, &id,
            &request, Some(scope(&store)))).unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(replay["movement"]["id"], receipt["movement"]["id"]);
        assert_eq!(snapshot(&store), committed);
        assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
    }
}

#[test]
fn queued_stock_handlers_refuse_old_scope_even_when_restore_preserves_item_and_request_ids() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for operation in OPERATIONS {
        let (_temporary, store) = fixture();
        let id = tracked_item(&store);
        let request = uuid::Uuid::new_v4().to_string();
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let first = tauri::async_runtime::block_on(run_stock(app.state(), operation, &id,
            &request, Some(scope(&store)))).unwrap();
        let backup = store.create_backup(None, "stock-report-worker-test").unwrap();
        let origin = scope(&store);
        let (result, restored) = after_queued_restore(&store, backup,
            run_stock(app.state(), operation, &id, &request, Some(origin.clone())));
        assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));
        assert_ne!(scope(&store), origin);
        assert_eq!(snapshot(&store), restored);
        assert!(restored["catalog_items"].as_array().unwrap().iter().any(|row| row["id"] == id));
        assert!(restored["stock_movements"].as_array().unwrap().iter()
            .any(|row| row["id"] == first["movement"]["id"] && row["request_id"] == request));
    }
}

#[test]
fn stock_current_scope_and_legacy_none_keep_success_after_physical_restore() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for operation in OPERATIONS {
        for scoped in [true, false] {
            let (_temporary, store) = fixture();
            let id = tracked_item(&store);
            let backup = store.create_backup(None, "stock-report-worker-test").unwrap();
            let origin = scope(&store);
            { let _guard = store.lock().unwrap(); store.restore_backup(&backup, "stock-report-worker-test").unwrap(); }
            assert_ne!(scope(&store), origin);
            let app = tauri::test::mock_builder().manage(store.clone())
                .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
            let expected = scoped.then(|| scope(&store));
            let receipt = responsive(&store, run_stock(app.state(), operation, &id,
                &uuid::Uuid::new_v4().to_string(), expected)).unwrap();
            assert_eq!(receipt["idempotent"], false);
            assert_eq!(receipt["catalog_item"]["id"], id);
        }
    }
}

#[test]
fn stock_missing_read_only_and_foreign_licences_keep_original_guard_errors_without_mutation() {
    for access in ["missing", "read_only", "foreign"] {
        let (_temporary, store) = unlicensed_fixture();
        let id = tracked_item(&store);
        if access == "read_only" {
            store.install_server_issued_license(&signed_fixture_token(&store, access)).unwrap();
        } else if access == "foreign" {
            let (_other_temporary, other) = fixture();
            assert!(store.install_server_issued_license(&signed_fixture_token(&other, "owner"))
                .unwrap_err().to_string().contains("installation"));
        }
        let original_error = store.require_write_access().unwrap_err().to_string();
        let before = snapshot(&store);
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        for operation in OPERATIONS {
            for expected in [Some(scope(&store)), None] {
                let error = tauri::async_runtime::block_on(run_stock(app.state(), operation,
                    &id, &uuid::Uuid::new_v4().to_string(), expected)).unwrap_err();
                assert_eq!(error, original_error, "{operation:?}/{access}");
                assert_eq!(snapshot(&store), before);
            }
        }
    }
}

#[test]
fn origin_guard_precedes_stock_validation_licence_and_report_destination_without_writes() {
    let (temporary, store) = unlicensed_fixture();
    let before = snapshot(&store);
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    for operation in OPERATIONS {
        let error = tauri::async_runtime::block_on(run_stock(app.state(), operation,
            "missing-item", "not-a-request-uuid", Some("synthetic-old-scope".into()))).unwrap_err();
        assert!(error.contains("L’entreprise ouverte a changé"));
        assert!(!error.contains("Licence requise"));
        assert_eq!(snapshot(&store), before);
    }
    let destination = temporary.path().join("sentinel.pdf");
    std::fs::write(&destination, b"SYNTHETIC SENTINEL").unwrap();
    let error = tauri::async_runtime::block_on(crate::project_report::export_project_report_pdf(
        app.state(), report(), "relative.invalid".into(), Some("synthetic-old-scope".into()),
    )).unwrap_err();
    assert!(error.contains("L’entreprise ouverte a changé"));
    let error = tauri::async_runtime::block_on(crate::project_report::export_project_report_pdf(
        app.state(), report(), destination.to_string_lossy().into_owned(),
        Some("synthetic-old-scope".into()),
    )).unwrap_err();
    assert!(error.contains("L’entreprise ouverte a changé"));
    assert_eq!(std::fs::read(&destination).unwrap(), b"SYNTHETIC SENTINEL");
    assert_eq!(snapshot(&store), before);
}

#[test]
fn queued_report_rejects_old_scope_before_overwriting_pdf_or_using_replacement_issuer() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (temporary, store) = fixture();
    store.update_settings(json!({"company_name":"SYNTHETIC REPLACEMENT ISSUER"})).unwrap();
    let backup = store.create_backup(None, "stock-report-worker-test").unwrap();
    store.update_settings(json!({"company_name":"SYNTHETIC ORIGINAL ISSUER"})).unwrap();
    let origin = scope(&store);
    let destination = temporary.path().join("queued-report.pdf");
    std::fs::write(&destination, b"SYNTHETIC EXISTING PDF SENTINEL").unwrap();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let (result, restored) = after_queued_restore(&store, backup,
        crate::project_report::export_project_report_pdf(app.state(), report(),
            destination.to_string_lossy().into_owned(), Some(origin.clone())));
    assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));
    assert_ne!(scope(&store), origin);
    assert_eq!(restored["settings"][0]["company_name"], "SYNTHETIC REPLACEMENT ISSUER");
    assert_eq!(std::fs::read(destination).unwrap(), b"SYNTHETIC EXISTING PDF SENTINEL");
    assert_eq!(snapshot(&store), restored);
}

#[test]
fn report_current_scope_and_legacy_none_render_current_issuer_without_adding_write_admission() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for access in ["owner", "missing", "read_only"] {
        for scoped in [true, false] {
            let (temporary, store) = unlicensed_fixture();
            if access != "missing" {
                store.install_server_issued_license(&signed_fixture_token(&store, access)).unwrap();
            }
            store.update_settings(json!({"company_name":"SYNTHETIC CURRENT ISSUER"})).unwrap();
            let backup = store.create_backup(None, "stock-report-worker-test").unwrap();
            let origin = scope(&store);
            { let _guard = store.lock().unwrap(); store.restore_backup(&backup, "stock-report-worker-test").unwrap(); }
            assert_ne!(scope(&store), origin);
            let before = snapshot(&store);
            let destination = temporary.path().join("current-report.pdf");
            let app = tauri::test::mock_builder().manage(store.clone())
                .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
            let receipt = responsive(&store, crate::project_report::export_project_report_pdf(
                app.state(), report(), destination.to_string_lossy().into_owned(),
                scoped.then(|| scope(&store)),
            )).unwrap();
            assert_eq!(receipt["path"], destination.to_string_lossy().as_ref());
            assert!(receipt["pages"].as_u64().unwrap() > 0);
            let text = pdf_text(&destination);
            assert!(text.contains("SYNTHETIC CURRENT ISSUER"));
            assert!(text.contains("SYNTHETIC REPORT CONTENT"));
            assert_eq!(snapshot(&store), before);
        }
    }
}

#[test]
fn real_stock_audit_failure_rolls_back_and_explicit_retry_commits_once() {
    for operation in OPERATIONS {
        let (_temporary, store) = fixture();
        let id = tracked_item(&store);
        let request = uuid::Uuid::new_v4().to_string();
        let db = store.connect().unwrap();
        db.execute_batch("CREATE TRIGGER synthetic_stock_audit_failure BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'SYNTHETIC STOCK AUDIT FAILURE'); END;").unwrap();
        let before = snapshot(&store);
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let error = tauri::async_runtime::block_on(run_stock(app.state(), operation, &id,
            &request, Some(scope(&store)))).unwrap_err();
        assert!(error.contains("SYNTHETIC STOCK AUDIT FAILURE"));
        assert_eq!(snapshot(&store), before);
        db.execute_batch("DROP TRIGGER synthetic_stock_audit_failure;").unwrap();
        let receipt = tauri::async_runtime::block_on(run_stock(app.state(), operation, &id,
            &request, Some(scope(&store)))).unwrap();
        assert_eq!(receipt["idempotent"], false);
        assert_eq!(receipt["movement"]["request_id"], request);
        let committed = snapshot(&store);
        assert_eq!(committed["stock_movements"].as_array().unwrap().len(),
            before["stock_movements"].as_array().unwrap().len() + 1);
        assert_eq!(committed["audit_log"].as_array().unwrap().len(),
            before["audit_log"].as_array().unwrap().len() + 1);
        let replay = tauri::async_runtime::block_on(run_stock(app.state(), operation, &id,
            &request, Some(scope(&store)))).unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(replay["movement"]["id"], receipt["movement"]["id"]);
        assert_eq!(snapshot(&store), committed);
        assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
    }
}
