//! Prepared real Tauri-handler tests. Reuse the established per-store signed
//! fixture authority; no exemptions, local native execution or CI claim.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use futures_util::future::join;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{future::Future, sync::mpsc, thread, time::Duration};
use tauri::Manager;

fn nonce(store: &LocalStore) -> String {
    crate::member_context::read(&store.connect().unwrap()).unwrap()
}
fn identity(store: &LocalStore, user: &str, role: &str) {
    crate::company_collaboration::set_identity(store, "synthetic-creation-org", user, "Synthetic creation member", role).unwrap();
}
fn client(store: &LocalStore, id: &str) {
    store.create_record("clients", json!({"id":id,"name":"Synthetic receipt client"})).unwrap();
}
fn input(entity: &str, client_id: &str, price: i64) -> SaveDocumentWithItemsInput {
    let mut data = json!({"client_id":client_id,"title":"Frozen synthetic creation","status":"brouillon","currency":"CHF","issue_date":"2026-09-01","notes":"First line\nSecond line"});
    if entity == "quotes" { data["valid_until"] = json!("2026-10-01"); }
    else { data["type"] = json!("standard");data["due_date"] = json!("2026-10-01");data["service_date_from"] = json!("2026-09-01");data["service_date_to"] = json!("2026-09-01"); }
    SaveDocumentWithItemsInput { entity:entity.into(),id:None,data,items:vec![json!({"description":"Frozen line","quantity":2,"unit":"h","unit_price_cents":price,"discount_bp":0,"vat_bp":0})] }
}
fn snapshot(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();let mut rows = serde_json::Map::new();
    for table in ["settings","clients","quotes","quote_items","invoices","invoice_items","document_creators","audit_log","journal_entries","journal_lines","company_local_clock","license_state","company_local_member_context"] {
        rows.insert(table.into(), json!(crate::database::query_all(&connection, &format!("SELECT * FROM {table} ORDER BY rowid"), []).unwrap()));
    }
    Value::Object(rows)
}
fn clock_fingerprints(store: &LocalStore) -> Vec<(String, String)> {
    ["license-clock.dpapi", "license-clock.protected", "license-clock-pending.dpapi", "license-clock-pending.protected"]
        .into_iter().filter_map(|name| std::fs::read(store.data_dir.join(name)).ok()
            .map(|bytes| (name.to_owned(), format!("{:x}", Sha256::digest(bytes)))))
        .collect()
}
fn responsive<T>(store: &LocalStore, command: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    let held = store.clone();let (ready_tx, ready_rx) = mpsc::channel();let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || { let _guard = held.lock().unwrap();ready_tx.send(()).unwrap();release_rx.recv_timeout(Duration::from_secs(5)).is_ok() });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(command, async move { let _ = release_tx.send(()); }));
    assert!(holder.join().unwrap(), "actual receipt handler must yield while waiting for the real mutex");result
}

#[test]
fn actual_creation_and_pure_probe_yield_and_concurrent_same_attempt_has_one_document_and_one_receipt() {
    for entity in ["quotes", "invoices"] {
        let (_directory, store) = fixture();identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");let client_id = uuid::Uuid::new_v4().to_string();client(&store,&client_id);
        let request = uuid::Uuid::new_v4().to_string();let payload = input(entity,&client_id,12_345);
        let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let missing = responsive(&store, get_document_creation_receipt(app.state(),payload.clone(),request.clone(),scope(&store),nonce(&store))).unwrap();assert_eq!(missing["status"],"missing");
        let expected_scope = scope(&store);let expected_nonce = nonce(&store);
        let (left,right) = tauri::async_runtime::block_on(join(
            save_document_with_items(app.state(),payload.clone(),Some(expected_scope.clone()),Some(expected_nonce.clone()),Some(request.clone())),
            save_document_with_items(app.state(),payload.clone(),Some(expected_scope),Some(expected_nonce),Some(request.clone())),
        ));
        let original = left.unwrap();assert_eq!(right.unwrap(),original);assert_eq!(original["document"]["id"],request);assert_eq!(original["document"]["total_cents"],24_690);
        let before = snapshot(&store);let clock_before = clock_fingerprints(&store);assert!(!clock_before.is_empty());
        let confirmed = responsive(&store,get_document_creation_receipt(app.state(),payload,request.clone(),scope(&store),nonce(&store))).unwrap();
        assert_eq!(confirmed["status"],"confirmed");assert_eq!(confirmed["originalResponse"],original);assert_eq!(snapshot(&store),before);assert_eq!(clock_fingerprints(&store),clock_before);
        let connection = store.connect().unwrap();assert_eq!(connection.query_row::<i64,_,_>(&format!("SELECT COUNT(*) FROM {entity}"),[],|row|row.get(0)).unwrap(),1);
        assert_eq!(connection.query_row::<i64,_,_>("SELECT COUNT(*) FROM audit_log WHERE entity_type='document_creation_request' AND entity_id=? AND action='complete'",[&request],|row|row.get(0)).unwrap(),1);
        assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
    }
}

#[test]
fn actual_pure_probe_allows_signed_read_only_evidence_without_clock_write_but_creation_remains_denied() {
    for entity in ["quotes", "invoices"] {
        let (_directory,store) = fixture();let client_id = uuid::Uuid::new_v4().to_string();client(&store,&client_id);let request = uuid::Uuid::new_v4().to_string();let payload = input(entity,&client_id,10_000);
        let original = store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();
        identity(&store,&uuid::Uuid::new_v4().to_string(),"read_only");store.install_server_issued_license(&signed_fixture_token(&store,"read_only")).unwrap();
        assert!(store.require_write_access().unwrap_err().to_string().contains("limité à la lecture"));
        let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();let before = snapshot(&store);let clock_before = clock_fingerprints(&store);assert!(!clock_before.is_empty());
        let confirmed = responsive(&store,get_document_creation_receipt(app.state(),payload.clone(),request.clone(),scope(&store),nonce(&store))).unwrap();assert_eq!(confirmed["originalResponse"],original);
        let denied = responsive(&store,save_document_with_items(app.state(),payload,Some(scope(&store)),Some(nonce(&store)),Some(request))).unwrap_err();assert!(denied.contains("limité à la lecture"));
        assert_eq!(snapshot(&store),before);assert_eq!(clock_fingerprints(&store),clock_before);
    }
}

#[test]
fn actual_pure_probe_needs_no_write_licence_and_new_creation_requires_both_origins_while_none_keeps_legacy() {
    for entity in ["quotes", "invoices"] {
        let (_directory,store) = unlicensed_fixture();let client_id = uuid::Uuid::new_v4().to_string();client(&store,&client_id);let request = uuid::Uuid::new_v4().to_string();let payload = input(entity,&client_id,10_000);
        // Direct LocalStore engine setup is not evidence of authorized IPC creation.
        let original = store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();
        let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();let before = snapshot(&store);
        assert_eq!(responsive(&store,get_document_creation_receipt(app.state(),payload.clone(),request.clone(),scope(&store),nonce(&store))).unwrap()["originalResponse"],original);
        for origins in [(None,None),(Some(scope(&store)),None),(None,Some(nonce(&store)))] {
            let error = responsive(&store,save_document_with_items(app.state(),payload.clone(),origins.0,origins.1,Some(request.clone()))).unwrap_err();assert!(error.contains("contexte local du compte doit être vérifié"));
        }
        assert!(responsive(&store,save_document_with_items(app.state(),payload,None,None,None)).unwrap_err().contains("lecture seule"));assert_eq!(snapshot(&store),before);
    }
}

#[test]
fn actual_creation_and_read_reject_actor_a_to_b_and_aba_before_receipt_read_or_business_writes() {
    for entity in ["quotes","invoices"] {
        for return_to_a in [false,true] {
            for reading in [false,true] {
                let (_directory,store) = fixture();let alice = uuid::Uuid::new_v4().to_string();identity(&store,&alice,"owner");let client_id = uuid::Uuid::new_v4().to_string();client(&store,&client_id);
                let request = uuid::Uuid::new_v4().to_string();let payload = input(entity,&client_id,10_000);store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();let old_scope = scope(&store);let old_nonce = nonce(&store);
                let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
                // Capture before changing identity; poll the real handler afterward.
                if reading {
                    let pending = get_document_creation_receipt(app.state(),payload,request,old_scope.clone(),old_nonce.clone());
                    identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");if return_to_a {identity(&store,&alice,"owner");}
                    assert_ne!(nonce(&store),old_nonce);let before = snapshot(&store);assert!(responsive(&store,pending).unwrap_err().contains("Le compte connecté a changé"));assert_eq!(snapshot(&store),before);
                } else {
                    let pending = save_document_with_items(app.state(),payload,Some(old_scope),Some(old_nonce.clone()),Some(request));
                    identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");if return_to_a {identity(&store,&alice,"owner");}
                    assert_ne!(nonce(&store),old_nonce);let before = snapshot(&store);assert!(responsive(&store,pending).unwrap_err().contains("Le compte connecté a changé"));assert_eq!(snapshot(&store),before);
                }
            }
        }
    }
}

#[test]
fn queued_actual_creation_and_probe_reject_same_deterministic_id_physical_restore_before_reading_other_receipt() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for entity in ["quotes","invoices"] {
        for reading in [false,true] {
            let (_directory,store) = fixture();let (_other_directory,other) = fixture();let client_id = uuid::Uuid::new_v4().to_string();client(&store,&client_id);client(&other,&client_id);
            let request = uuid::Uuid::new_v4().to_string();let payload = input(entity,&client_id,10_000);store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();other.save_document_with_items_once(input(entity,&client_id,20_000),Some(request.clone())).unwrap();
            let backup = other.create_backup(None,env!("CARGO_PKG_VERSION")).unwrap();let old_scope = scope(&store);let old_nonce = nonce(&store);
            let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();let replacing = store.clone();let (ready_tx,ready_rx) = mpsc::channel();let (replace_tx,replace_rx) = mpsc::channel();
            let holder = thread::spawn(move || {
                let _guard = replacing.lock().unwrap();let licence_before: (String,String) = replacing.connect().unwrap().query_row("SELECT token_sha256,license_id FROM license_state WHERE id=1",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();ready_tx.send(()).unwrap();
                let released = replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();replacing.require_backup_restore_access().unwrap();replacing.restore_backup(&backup,env!("CARGO_PKG_VERSION")).unwrap();
                let licence_after: (String,String) = replacing.connect().unwrap().query_row("SELECT token_sha256,license_id FROM license_state WHERE id=1",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();assert_eq!(licence_before,licence_after);replacing.require_write_access().unwrap();
                (released,snapshot(&replacing))
            });
            ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let result = if reading {
                tauri::async_runtime::block_on(join(get_document_creation_receipt(app.state(),payload,request,old_scope.clone(),old_nonce),async move {let _ = replace_tx.send(());})).0
            } else {
                tauri::async_runtime::block_on(join(save_document_with_items(app.state(),payload,Some(old_scope.clone()),Some(old_nonce),Some(request)),async move {let _ = replace_tx.send(());})).0
            };
            let (released,destination) = holder.join().unwrap();assert!(released,"actual receipt handler must yield to checked restoration");assert_ne!(scope(&store),old_scope);
            assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));assert_eq!(snapshot(&store),destination);
        }
    }
}

#[test]
fn actual_creation_business_failure_rolls_back_receipt_document_lines_and_company_clock_then_same_attempt_can_commit() {
    for entity in ["quotes","invoices"] {
        let (_directory,store) = fixture();let client_id = uuid::Uuid::new_v4().to_string();client(&store,&client_id);let request = uuid::Uuid::new_v4().to_string();let payload = input(entity,&client_id,10_000);
        let app = tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();let mut invalid = payload.clone();invalid.items.push(json!({"description":"Invalid after header/line insert","quantity":1,"unit":"h","unit_price_cents":1000,"discount_bp":0,"vat_bp":10_001}));let before = snapshot(&store);
        let error = responsive(&store,save_document_with_items(app.state(),invalid,Some(scope(&store)),Some(nonce(&store)),Some(request.clone()))).unwrap_err();assert!(error.contains("discount_bp et vat_bp"));assert_eq!(snapshot(&store),before);
        assert_eq!(responsive(&store,get_document_creation_receipt(app.state(),payload.clone(),request.clone(),scope(&store),nonce(&store))).unwrap()["status"],"missing");
        let saved = responsive(&store,save_document_with_items(app.state(),payload,Some(scope(&store)),Some(nonce(&store)),Some(request.clone()))).unwrap();assert_eq!(saved["document"]["id"],request);
    }
}
