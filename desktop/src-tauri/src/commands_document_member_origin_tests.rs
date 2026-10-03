//! Atomic sales document context candidate. Actual Tauri handlers and LocalStore
//! mutex/checked .zentra restores, using only the existing signed test authority.
//! No licence guard exemption, production hook, replay or document UUID change.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use futures_util::future::join;
use serde_json::json;
use std::{future::Future, sync::mpsc, thread, time::Duration};
use tauri::Manager;

fn nonce(store: &LocalStore) -> String {
    crate::member_context::read(&store.connect().unwrap()).unwrap()
}
fn identity(store: &LocalStore, user: &str, role: &str) {
    crate::company_collaboration::set_identity(
        store, "synthetic-document-org", user, "Synthetic document member", role,
    ).unwrap();
}
fn client(store: &LocalStore, id: &str, name: &str) {
    store.create_record("clients", json!({"id":id,"name":name})).unwrap();
}
fn input(entity: &str, id: Option<String>, client_id: &str, line_id: &str, price: i64) -> SaveDocumentWithItemsInput {
    let mut data = json!({"client_id":client_id,"title":"Synthetic guarded document","status":"brouillon","currency":"CHF","issue_date":"2026-09-01","notes":"Synthetic first line\nSynthetic second line"});
    if entity == "quotes" { data["valid_until"] = json!("2026-10-01"); }
    else {
        data["type"] = json!("standard"); data["due_date"] = json!("2026-10-01");
        data["service_date_from"] = json!("2026-09-01"); data["service_date_to"] = json!("2026-09-01");
    }
    SaveDocumentWithItemsInput {
        entity:entity.into(), id, data,
        items:vec![json!({"id":line_id,"description":"Synthetic existing line","quantity":2,"unit":"heure","unit_price_cents":price,"discount_bp":0,"vat_bp":0})],
    }
}
fn snapshot(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();
    let mut rows = serde_json::Map::new();
    for table in ["settings","clients","quotes","quote_items","invoices","invoice_items","document_creators","audit_log","journal_entries","journal_lines","company_local_clock"] {
        rows.insert(table.into(), json!(crate::database::query_all(
            &connection, &format!("SELECT * FROM {table} ORDER BY rowid"), [],
        ).unwrap()));
    }
    Value::Object(rows)
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
    let (result, ()) = tauri::async_runtime::block_on(join(command, async move { let _ = release_tx.send(()); }));
    assert!(holder.join().unwrap(), "actual document handler must yield while waiting for the local mutex");
    result
}

#[test]
fn actual_document_handler_yields_and_preserves_current_and_legacy_create_update_receipts() {
    for entity in ["quotes", "invoices"] {
        for legacy in [false, true] {
            let (_directory, store) = fixture();
            let user = uuid::Uuid::new_v4().to_string(); identity(&store, &user, "owner");
            let client_id = uuid::Uuid::new_v4().to_string(); client(&store, &client_id, "Synthetic document A client");
            let line_id = uuid::Uuid::new_v4().to_string();
            let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
            let expected_scope = if legacy { None } else { Some(scope(&store)) };
            let expected_nonce = if legacy { None } else { Some(nonce(&store)) };
            let before_journals: i64 = store.connect().unwrap().query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0)).unwrap();
            store.require_write_access().unwrap();
            let saved = responsive(&store, save_document_with_items(app.state(), input(entity, None, &client_id, &line_id, 12_345), expected_scope.clone(), expected_nonce.clone())).unwrap();
            let id = saved["document"]["id"].as_str().unwrap().to_owned();
            assert_eq!(saved["document"]["client_id"], client_id); assert_eq!(saved["document"]["status"], "brouillon");
            assert_eq!(saved["document"]["subtotal_cents"], 24_690); assert_eq!(saved["document"]["total_cents"], 24_690);
            assert_eq!(saved["document"]["vat_cents"], 0); assert_eq!(saved["items"][0]["id"], line_id);
            assert_eq!(saved["document"]["notes"], "Synthetic first line\nSynthetic second line");
            let updated = responsive(&store, save_document_with_items(app.state(), input(entity, Some(id.clone()), &client_id, &line_id, 13_456), expected_scope, expected_nonce)).unwrap();
            assert_eq!(updated["document"]["id"], id); assert_eq!(updated["document"]["total_cents"], 26_912);
            assert_eq!(updated["items"].as_array().unwrap().len(), 1); assert_eq!(updated["items"][0]["id"], line_id);
            let connection = store.connect().unwrap();
            assert_eq!(connection.query_row::<i64, _, _>("SELECT COUNT(*) FROM audit_log WHERE entity_type='document_atomic' AND entity_id=?", [&id], |row| row.get(0)).unwrap(), 2);
            assert_eq!(connection.query_row::<String, _, _>("SELECT user_id FROM document_creators WHERE entity=? AND document_id=?", [entity, &id], |row| row.get(0)).unwrap(), user);
            assert_eq!(connection.query_row::<i64, _, _>("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0)).unwrap(), before_journals);
            assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
        }
    }
}

#[test]
fn actual_document_handler_rejects_captured_actor_a_to_b_and_aba_without_business_writes() {
    for entity in ["quotes", "invoices"] {
        for editing in [false, true] {
            for return_to_a in [false, true] {
                let (_directory, store) = fixture(); let alice = uuid::Uuid::new_v4().to_string(); identity(&store, &alice, "owner");
                let client_id = uuid::Uuid::new_v4().to_string(); client(&store, &client_id, "Synthetic retained client");
                let line_id = uuid::Uuid::new_v4().to_string();
                let existing = if editing { Some(store.save_document_with_items(input(entity, None, &client_id, &line_id, 10_000)).unwrap()["document"]["id"].as_str().unwrap().to_owned()) } else { None };
                let expected_scope = scope(&store); let expected_nonce = nonce(&store);
                let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
                // This is a captured/not-yet-polled real handler, not an acquired-worker race witness.
                let pending = save_document_with_items(app.state(), input(entity, existing, &client_id, &line_id, 90_000), Some(expected_scope.clone()), Some(expected_nonce.clone()));
                identity(&store, &uuid::Uuid::new_v4().to_string(), "owner"); if return_to_a { identity(&store, &alice, "owner"); }
                assert_eq!(scope(&store), expected_scope); assert_ne!(nonce(&store), expected_nonce); store.require_write_access().unwrap();
                let before = snapshot(&store); assert!(responsive(&store, pending).unwrap_err().contains("Le compte connecté a changé"));
                assert_eq!(snapshot(&store), before);
            }
        }
    }
}

#[test]
fn queued_actual_document_handler_rejects_same_uuid_physical_restore_for_create_and_edit() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for entity in ["quotes", "invoices"] {
        for editing in [false, true] {
            let (_directory, store) = fixture(); let (_other_directory, other) = fixture();
            let client_id = uuid::Uuid::new_v4().to_string(); client(&store, &client_id, "Synthetic A client"); client(&other, &client_id, "Synthetic B client");
            let line_id = uuid::Uuid::new_v4().to_string();
            let a = store.save_document_with_items(input(entity, None, &client_id, &line_id, 10_000)).unwrap(); let id = a["document"]["id"].as_str().unwrap().to_owned();
            // Source fixtures intentionally share document/client/line UUIDs. The
            // ordinary engine edits supplied document IDs, so seed B's row first.
            let mut destination_data = input(entity, None, &client_id, &line_id, 20_000).data;
            destination_data["id"] = json!(id); destination_data["title"] = json!("Synthetic B document");
            other.create_record(entity, destination_data).unwrap();
            other.save_document_with_items(input(entity, Some(id.clone()), &client_id, &line_id, 20_000)).unwrap();
            let backup = other.create_backup(None, "document-origin-test").unwrap(); let old_scope = scope(&store); let old_nonce = nonce(&store);
            let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
            let replacing = store.clone(); let (ready_tx, ready_rx) = mpsc::channel(); let (replace_tx, replace_rx) = mpsc::channel();
            let holder = thread::spawn(move || {
                let _guard = replacing.lock().unwrap();
                let license_before: (String, String) = replacing.connect().unwrap().query_row("SELECT token_sha256,license_id FROM license_state WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
                ready_tx.send(()).unwrap(); let released = replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
                replacing.require_backup_restore_access().unwrap(); replacing.restore_backup(&backup, "document-origin-test").unwrap();
                let license_after: (String, String) = replacing.connect().unwrap().query_row("SELECT token_sha256,license_id FROM license_state WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
                assert_eq!(license_before, license_after); replacing.require_write_access().unwrap(); // Never reinstall a licence under this mutex.
                (released, snapshot(&replacing))
            });
            ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let command = save_document_with_items(app.state(), input(entity, if editing { Some(id) } else { None }, &client_id, &line_id, 90_000), Some(old_scope.clone()), Some(old_nonce));
            let (result, ()) = tauri::async_runtime::block_on(join(command, async move { let _ = replace_tx.send(()); }));
            let (released, destination) = holder.join().unwrap(); assert!(released, "actual document handler must yield while the real physical restore owns the mutex");
            assert_ne!(scope(&store), old_scope); assert!(result.unwrap_err().contains("L’entreprise ouverte a changé")); assert_eq!(snapshot(&store), destination);
        }
    }
}

#[test]
fn actual_document_handler_rolls_back_header_lines_audit_and_clock_on_business_failure() {
    for entity in ["quotes", "invoices"] {
        for editing in [false, true] {
            let (_directory, store) = fixture(); identity(&store, &uuid::Uuid::new_v4().to_string(), "owner");
            let client_id = uuid::Uuid::new_v4().to_string(); client(&store, &client_id, "Synthetic rollback client"); let line_id = uuid::Uuid::new_v4().to_string();
            let existing = if editing { Some(store.save_document_with_items(input(entity, None, &client_id, &line_id, 10_000)).unwrap()["document"]["id"].as_str().unwrap().to_owned()) } else { None };
            let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
            let mut bad = input(entity, existing, &client_id, &line_id, 20_000); bad.data["title"] = json!("MUST ROLL BACK THIS HEADER");
            bad.items.push(json!({"description":"Invalid second line after header/delete/first line","quantity":1,"unit":"heure","unit_price_cents":1000,"discount_bp":0,"vat_bp":10_001}));
            let before = snapshot(&store); let error = responsive(&store, save_document_with_items(app.state(), bad, Some(scope(&store)), Some(nonce(&store)))).unwrap_err();
            assert!(error.contains("discount_bp et vat_bp"), "the existing item validation must reject inside the transaction: {error}"); assert_eq!(snapshot(&store), before);
        }
    }
}

#[test]
fn actual_document_handler_preserves_signed_read_only_authority_for_current_and_legacy_context() {
    for entity in ["quotes", "invoices"] {
        for editing in [false, true] {
            let (_directory, store) = fixture(); identity(&store, &uuid::Uuid::new_v4().to_string(), "owner");
            let client_id = uuid::Uuid::new_v4().to_string(); client(&store, &client_id, "Synthetic read-only client"); let line_id = uuid::Uuid::new_v4().to_string();
            let existing = if editing { Some(store.save_document_with_items(input(entity, None, &client_id, &line_id, 10_000)).unwrap()["document"]["id"].as_str().unwrap().to_owned()) } else { None };
            identity(&store, &uuid::Uuid::new_v4().to_string(), "read_only"); store.install_server_issued_license(&signed_fixture_token(&store, "read_only")).unwrap();
            let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap(); let before = snapshot(&store);
            for legacy in [false, true] {
                let error = responsive(&store, save_document_with_items(app.state(), input(entity, existing.clone(), &client_id, &line_id, 20_000), if legacy { None } else { Some(scope(&store)) }, if legacy { None } else { Some(nonce(&store)) })).unwrap_err();
                assert!(error.contains("limité à la lecture"));
            }
            assert_eq!(snapshot(&store), before);
        }
    }
}

#[test]
fn actual_document_handler_checks_stale_member_before_missing_licence_or_business_input() {
    let (_directory, store) = unlicensed_fixture(); identity(&store, &uuid::Uuid::new_v4().to_string(), "owner"); let old_nonce = nonce(&store);
    identity(&store, &uuid::Uuid::new_v4().to_string(), "owner");
    let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap(); let before = snapshot(&store);
    let invalid = || SaveDocumentWithItemsInput { entity:"invalid-entity".into(), id:None, data:json!({}), items:Vec::new() };
    let error = responsive(&store, save_document_with_items(app.state(), invalid(), Some(scope(&store)), Some(old_nonce))).unwrap_err(); assert!(error.contains("Le compte connecté a changé"));
    for legacy in [false, true] {
        let error = responsive(&store, save_document_with_items(app.state(), invalid(), if legacy { None } else { Some(scope(&store)) }, if legacy { None } else { Some(nonce(&store)) })).unwrap_err(); assert!(error.contains("lecture seule"));
    }
    assert_eq!(snapshot(&store), before);
}
