//! Generic CRUD IPC origin and worker regressions with synthetic companies only.
//! Actual handlers are called with real Tauri State. Replacement uses a checked
//! .zentra restore and a same-UUID client in both companies, never a scope-only mock.
//! One acquired-worker ordering witness calls the shared helper/business body;
//! it is explicitly not a paused Tauri handler or a production testing hook.
use super::import_worker_tests::{fixture, scope, unlicensed_fixture};
use super::*;
use futures_util::future::join;
use serde_json::json;
use std::{future::Future, sync::mpsc, thread, time::Duration};
use tauri::Manager;

#[derive(Clone, Copy, Debug)]
enum Operation {
    Create,
    Update,
    Delete,
}

async fn call_handler(
    operation: Operation,
    state: State<'_, LocalStore>,
    id: String,
    name: &str,
    expected: Option<String>,
) -> Result<Value, String> {
    match operation {
        Operation::Create => create_record(
            state, "clients".into(), json!({"id":id,"name":name}), expected, None,
        ).await,
        Operation::Update => update_record(
            state, "clients".into(), id, json!({"name":name}), expected, None,
        ).await,
        Operation::Delete => delete_record(state, "clients".into(), id, expected, None)
            .await.map(|result| json!({"deleted":result.deleted,"id":result.id})),
    }
}

fn snapshot(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();
    let mut rows = serde_json::Map::new();
    for table in ["clients", "catalog_items", "stock_movements", "audit_log", "journal_entries", "journal_lines", "company_local_clock"] {
        rows.insert(table.into(), json!(crate::database::query_all(
            &connection, &format!("SELECT * FROM {table} ORDER BY rowid"), [],
        ).unwrap()));
    }
    Value::Object(rows)
}

fn client_name(store: &LocalStore, id: &str) -> String {
    store.connect().unwrap().query_row(
        "SELECT name FROM clients WHERE id=?", [id], |row| row.get(0),
    ).unwrap()
}

fn audit_count(store: &LocalStore, id: &str) -> i64 {
    store.connect().unwrap().query_row(
        "SELECT COUNT(*) FROM audit_log WHERE entity_type='clients' AND entity_id=?", [id], |row| row.get(0),
    ).unwrap()
}

fn restore_active_synthetic_company(store: &LocalStore, backup: &str, version: &str) {
    // The caller already holds LocalStore.lock. Manual restore preserves this
    // installation's protected licence; installing another token here would
    // reacquire the same non-reentrant mutex and deadlock the test itself.
    let original_license: (String, String) = store.connect().unwrap().query_row(
        "SELECT token_sha256,license_id FROM license_state WHERE id=1", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    store.require_backup_restore_access().unwrap();
    store.require_write_access().unwrap();
    store.restore_backup(backup, version).unwrap();
    let restored_license: (String, String) = store.connect().unwrap().query_row(
        "SELECT token_sha256,license_id FROM license_state WHERE id=1", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(restored_license, original_license, "manual restore must retain this installation's signed licence, not the source company's licence");
    // Keep the real release guard: without the origin guard, the queued CRUD
    // operation must truly be allowed to write into B, not fail on a licence.
    store.require_write_access().unwrap();
}

fn responsive<T>(store: &LocalStore, command: impl Future<Output=Result<T, String>>) -> Result<T, String> {
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
    assert!(holder.join().unwrap(), "actual CRUD handler blocked its waiting executor");
    result
}

#[test]
fn actual_create_update_delete_handlers_yield_while_mutex_held_and_commit_once() {
    let (_temporary, store) = fixture();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let expected = Some(scope(&store));
    let created = responsive(&store, call_handler(Operation::Create, app.state(), id.clone(), "Synthetic origin", expected.clone())).unwrap();
    assert_eq!(created["id"], id);
    assert_eq!(client_name(&store, &id), "Synthetic origin");
    assert_eq!(audit_count(&store, &id), 1);
    let updated = responsive(&store, call_handler(Operation::Update, app.state(), id.clone(), "Synthetic updated", expected.clone())).unwrap();
    assert_eq!(updated["name"], "Synthetic updated");
    assert_eq!(audit_count(&store, &id), 2);
    let deleted = responsive(&store, call_handler(Operation::Delete, app.state(), id.clone(), "", expected)).unwrap();
    assert_eq!(deleted, json!({"deleted":true,"id":id}));
    assert_eq!(audit_count(&store, &id), 3);
    assert_eq!(store.connect().unwrap().query_row::<i64,_,_>("SELECT COUNT(*) FROM clients WHERE id=?", [&id], |row| row.get(0)).unwrap(), 0);
    assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
}

#[test]
fn queued_real_handlers_refuse_the_original_scope_after_real_restore_even_with_the_same_record_uuid() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for operation in [Operation::Create, Operation::Update, Operation::Delete] {
        let (_temporary, store) = fixture();
        let (_other_temporary, other) = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        store.create_record("clients", json!({"id":id,"name":"Synthetic company A client"})).unwrap();
        other.create_record("clients", json!({"id":id,"name":"Synthetic company B client"})).unwrap();
        let backup = other.create_backup(None, "generic-crud-scope-test").unwrap();
        let original_scope = scope(&store);
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let replacing = store.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (replace_tx, replace_rx) = mpsc::channel();
        let holder = thread::spawn(move || {
            let _guard = replacing.lock().unwrap();
            ready_tx.send(()).unwrap();
            let continued = replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
            restore_active_synthetic_company(&replacing, &backup, "generic-crud-scope-test");
            (continued, scope(&replacing), snapshot(&replacing))
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (result, ()) = tauri::async_runtime::block_on(join(
            call_handler(operation, app.state(), id.clone(), "MUST NOT REPLACE COMPANY B", Some(original_scope.clone())),
            async move { let _ = replace_tx.send(()); },
        ));
        let (continued, restored_scope, destination) = holder.join().unwrap();
        assert!(continued, "restore release could not run beside the pending handler: {operation:?}");
        assert_ne!(restored_scope, original_scope);
        assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"), "{operation:?} must reject origin before a duplicate UUID or other business check");
        assert_eq!(client_name(&store, &id), "Synthetic company B client");
        assert_eq!(snapshot(&store), destination, "stale {operation:?} changed the restored company's records, journals, audit or sync clock");
        assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
    }
}

#[test]
fn queued_create_cannot_insert_a_new_origin_record_into_the_restored_company() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_temporary, store) = fixture();
    let (_other_temporary, other) = fixture();
    other.create_record("clients", json!({"name":"Synthetic destination sentinel"})).unwrap();
    let backup = other.create_backup(None, "generic-crud-new-id-test").unwrap();
    let original_scope = scope(&store);
    let id = uuid::Uuid::new_v4().to_string();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let replacing = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (replace_tx, replace_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = replacing.lock().unwrap();
        ready_tx.send(()).unwrap();
        let continued = replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        restore_active_synthetic_company(&replacing, &backup, "generic-crud-new-id-test");
        (continued, snapshot(&replacing))
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(
        create_record(app.state(), "clients".into(), json!({"id":id,"name":"MUST NOT ENTER COMPANY B"}), Some(original_scope), None),
        async move { let _ = replace_tx.send(()); },
    ));
    let (continued, destination) = holder.join().unwrap();
    assert!(continued);
    assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));
    assert_eq!(snapshot(&store), destination);
    assert_eq!(audit_count(&store, &id), 0);
    assert_eq!(store.connect().unwrap().query_row::<i64,_,_>("SELECT COUNT(*) FROM clients WHERE id=?", [&id], |row| row.get(0)).unwrap(), 0);
}

#[test]
fn stale_origin_is_refused_before_write_licence_and_invalid_business_inputs() {
    let (_temporary, store) = unlicensed_fixture();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let before = snapshot(&store);
    for operation in [Operation::Create, Operation::Update, Operation::Delete] {
        let result = responsive(&store, call_handler(operation, app.state(), "missing".into(), "", Some(format!("{}-stale", scope(&store)))));
        assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));
        assert_eq!(snapshot(&store), before);
    }
    // The same command in the actual company still enforces the real release guard.
    for operation in [Operation::Create, Operation::Update, Operation::Delete] {
        let result = responsive(&store, call_handler(operation, app.state(), "missing".into(), "", Some(scope(&store))));
        assert!(result.unwrap_err().contains("lecture seule"));
    }
    assert_eq!(snapshot(&store)["clients"], before["clients"]);
    assert_eq!(snapshot(&store)["audit_log"], before["audit_log"]);
}

#[test]
fn current_scope_and_legacy_omission_preserve_the_successful_crud_contract() {
    for legacy in [false, true] {
        let (_temporary, store) = fixture();
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let expected = if legacy { None } else { Some(scope(&store)) };
        let id = uuid::Uuid::new_v4().to_string();
        let created = tauri::async_runtime::block_on(call_handler(Operation::Create, app.state(), id.clone(), "Synthetic client", expected.clone())).unwrap();
        assert_eq!(created["id"], id);
        let updated = tauri::async_runtime::block_on(call_handler(Operation::Update, app.state(), id.clone(), "Synthetic new name", expected.clone())).unwrap();
        assert_eq!(updated["name"], "Synthetic new name");
        let deleted = tauri::async_runtime::block_on(call_handler(Operation::Delete, app.state(), id.clone(), "", expected)).unwrap();
        assert_eq!(deleted, json!({"deleted":true,"id":id}));
        assert_eq!(audit_count(&store, &id), 3);
        assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
    }
}

#[test]
fn acquired_shared_worker_commits_in_origin_before_real_restore_can_replace_it() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_temporary, store) = fixture();
    let (_other_temporary, other) = fixture();
    let backup = other.create_backup(None, "generic-crud-order-test").unwrap();
    let origin = scope(&store);
    let id = uuid::Uuid::new_v4().to_string();
    let working = store.clone();
    let replacing = store.clone();
    let (acquired_tx, acquired_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (completed_tx, completed_rx) = mpsc::channel();
    let entered_id = id.clone();
    let expected_origin = origin.clone();
    let command = run_scoped_local_operation(working, Some(origin.clone()), move |store| {
        require_write(store)?;
        acquired_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Synthetic release did not arrive".to_owned())?;
        store.create_record("clients", json!({"id":entered_id,"name":"Origin operation"})).map_err(command_error)
    });
    let (result, (restore, completed_rx)) = tauri::async_runtime::block_on(join(command, async move {
        acquired_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let restore = thread::spawn(move || {
            attempt_tx.send(()).unwrap();
            let _guard = replacing.lock().unwrap();
            assert_eq!(scope(&replacing), expected_origin);
            assert_eq!(client_name(&replacing, &id), "Origin operation");
            assert_eq!(audit_count(&replacing, &id), 1);
            restore_active_synthetic_company(&replacing, &backup, "generic-crud-order-test");
            completed_tx.send(()).unwrap();
            snapshot(&replacing)
        });
        attempt_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(completed_rx.recv_timeout(Duration::from_millis(50)), Err(mpsc::RecvTimeoutError::Timeout)), "restore escaped the held shared operation lock");
        release_tx.send(()).unwrap();
        (restore, completed_rx)
    }));
    assert_eq!(result.unwrap()["name"], "Origin operation");
    completed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let destination = restore.join().unwrap();
    assert_ne!(scope(&store), origin);
    assert_eq!(snapshot(&store), destination);
    assert!(destination["clients"].as_array().unwrap().is_empty());
}

#[test]
fn queued_catalog_editor_refuses_restored_same_uuid_and_matching_revision_before_cas() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_temporary, store) = fixture();
    let (_other_temporary, other) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let original = store.create_record("catalog_items", json!({"id":id,"kind":"service","name":"Company A service","unit":"heure","sales_price_cents":10000})).unwrap();
    let revision = original["updated_at"].as_str().unwrap().to_owned();
    other.create_record("catalog_items", json!({"id":id,"kind":"service","name":"Company B service","unit":"heure","sales_price_cents":20000})).unwrap();
    // Synthetic seed: demonstrate that a matching optimistic revision does not
    // identify a private workspace. It does not modify or fake the origin guard.
    other.connect().unwrap().execute("UPDATE catalog_items SET updated_at=? WHERE id=?", rusqlite::params![revision,id]).unwrap();
    let backup = other.create_backup(None, "catalog-crud-scope-test").unwrap();
    let original_scope = scope(&store);
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let replacing = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (replace_tx, replace_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = replacing.lock().unwrap();
        ready_tx.send(()).unwrap();
        let continued = replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        restore_active_synthetic_company(&replacing, &backup, "catalog-crud-scope-test");
        (continued, snapshot(&replacing))
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(
        update_catalog_item(app.state(), id.clone(), json!({"name":"MUST NOT RENAME COMPANY B"}), revision.clone(), Some(original_scope), None),
        async move { let _ = replace_tx.send(()); },
    ));
    let (continued, destination) = holder.join().unwrap();
    assert!(continued, "catalog editor blocked the executor needed to release restore");
    assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));
    assert_eq!(destination["catalog_items"][0]["id"], id);
    assert_eq!(destination["catalog_items"][0]["updated_at"], revision);
    assert_eq!(destination["catalog_items"][0]["name"], "Company B service");
    assert_eq!(snapshot(&store), destination);
}

#[test]
fn actual_catalog_editor_yields_and_preserves_current_scope_legacy_and_cas_contracts() {
    for legacy in [false, true] {
        let (_temporary, store) = fixture();
        let initial = store.create_record("catalog_items", json!({"kind":"service","name":"Synthetic catalogue","unit":"heure","sales_price_cents":10000})).unwrap();
        let id = initial["id"].as_str().unwrap().to_owned();
        let initial_revision = initial["updated_at"].as_str().unwrap().to_owned();
        let expected = if legacy { None } else { Some(scope(&store)) };
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let saved = responsive(&store, update_catalog_item(app.state(), id.clone(), json!({"name":"Edited service"}), initial_revision, expected.clone(), None)).unwrap();
        assert_eq!(saved["name"], "Edited service");
        let before = snapshot(&store);
        // Deliberately unequal CAS value: no wall-clock assumption or timing sleep.
        let refused = responsive(&store, update_catalog_item(app.state(), id, json!({"name":"STALE MUST NOT SAVE"}), "synthetic-stale-revision".into(), expected, None));
        assert!(refused.unwrap_err().contains("a changé"));
        assert_eq!(snapshot(&store), before);
        assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
    }
}
