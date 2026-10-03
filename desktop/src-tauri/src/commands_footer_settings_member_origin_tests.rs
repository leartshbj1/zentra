//! Prepared real IPC handlers; no native execution occurred in this candidate.
//! Context checks precede the real signed licence guard and unchanged settings engine.
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
    crate::company_collaboration::set_identity(store, "synthetic-footer-org", user, "Synthetic footer member", role).unwrap();
}
fn patch(label: &str) -> Value {
    json!({"company_name":label,"extra_settings_json":json!({"billing":{"footerTemplates":[{"id":"33333333-3333-4333-8333-333333333333","name":"Synthetic template","text":label}]}}).to_string()})
}
fn snapshot(store: &LocalStore) -> Value {
    let connection=store.connect().unwrap();let mut rows=serde_json::Map::new();
    for table in ["settings","clients","suppliers","projects","quotes","quote_items","invoices","invoice_items","document_creators","audit_log","journal_entries","journal_lines","company_local_clock"] {
        rows.insert(table.into(),json!(crate::database::query_all(&connection,&format!("SELECT * FROM {table} ORDER BY rowid"),[]).unwrap()));
    }
    Value::Object(rows)
}
fn responsive<T>(store: &LocalStore, command: impl Future<Output=Result<T,String>>) -> Result<T,String> {
    let held=store.clone();let (ready_tx,ready_rx)=mpsc::channel();let (release_tx,release_rx)=mpsc::channel();
    let holder=thread::spawn(move||{let _guard=held.lock().unwrap();ready_tx.send(()).unwrap();release_rx.recv_timeout(Duration::from_secs(5)).is_ok()});
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result,())=tauri::async_runtime::block_on(join(command,async move{let _=release_tx.send(());}));
    assert!(holder.join().unwrap(),"real update_settings must yield while waiting for the shared local mutex");result
}

#[test]
fn actual_footer_settings_current_member_and_legacy_none_yield_and_save_unchanged_engine_payload() {
    for legacy in [false,true] {
        let (_directory,store)=fixture();identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");store.require_write_access().unwrap();
        let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let before:i64=store.connect().unwrap().query_row("SELECT COUNT(*) FROM audit_log",[],|row|row.get(0)).unwrap();
        let saved=responsive(&store,update_settings(app.state(),patch("Synthetic saved footer"),if legacy{None}else{Some(scope(&store))},if legacy{None}else{Some(nonce(&store))})).unwrap();
        assert_eq!(saved["company_name"],"Synthetic saved footer");let extra:Value=serde_json::from_str(saved["extra_settings_json"].as_str().unwrap()).unwrap();
        assert_eq!(extra.pointer("/billing/footerTemplates/0/text"),Some(&json!("Synthetic saved footer")));
        let connection=store.connect().unwrap();assert_eq!(connection.query_row::<String,_,_>("SELECT company_name FROM settings WHERE id=1",[],|row|row.get(0)).unwrap(),"Synthetic saved footer");
        assert_eq!(connection.query_row::<i64,_,_>("SELECT COUNT(*) FROM audit_log",[],|row|row.get(0)).unwrap(),before+1);
    }
}

#[test]
fn actual_footer_settings_refuse_captured_a_to_b_and_aba_with_same_physical_scope() {
    for aba in [false,true] {
        let (_directory,store)=fixture();let alice=uuid::Uuid::new_v4().to_string();identity(&store,&alice,"owner");let old_scope=scope(&store);let old_nonce=nonce(&store);
        let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        // Handler future captured under A, before polling; the real serialized
        // setter runs outside the held mutex. This is not an acquired-worker hook.
        let command=update_settings(app.state(),patch("Synthetic stale A footer"),Some(old_scope.clone()),Some(old_nonce.clone()));
        identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");if aba{identity(&store,&alice,"owner");}
        assert_eq!(scope(&store),old_scope);assert_ne!(nonce(&store),old_nonce);store.require_write_access().unwrap();let before=snapshot(&store);
        assert!(responsive(&store,command).unwrap_err().contains("Le compte connecté a changé"));assert_eq!(snapshot(&store),before);
    }
}

#[test]
fn queued_actual_footer_settings_refuse_checked_physical_restore_before_any_settings_write() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_directory,store)=fixture();let (_other_directory,other)=fixture();other.update_settings(patch("Synthetic destination footer")).unwrap();
    let old_scope=scope(&store);let old_nonce=nonce(&store);let backup=other.create_backup(None,"footer-origin-test").unwrap();
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let replacing=store.clone();let (ready_tx,ready_rx)=mpsc::channel();let (replace_tx,replace_rx)=mpsc::channel();
    let holder=thread::spawn(move||{
        let _guard=replacing.lock().unwrap();
        let licence_before:(String,String)=replacing.connect().unwrap().query_row("SELECT token_sha256,license_id FROM license_state WHERE id=1",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        ready_tx.send(()).unwrap();let released=replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        replacing.require_backup_restore_access().unwrap();replacing.restore_backup(&backup,"footer-origin-test").unwrap();
        let licence_after:(String,String)=replacing.connect().unwrap().query_row("SELECT token_sha256,license_id FROM license_state WHERE id=1",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(licence_before,licence_after);replacing.require_write_access().unwrap(); // no licence reinstall or identity setter under mutex
        (released,snapshot(&replacing))
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();let command=update_settings(app.state(),patch("Synthetic stale footer"),Some(old_scope.clone()),Some(old_nonce));
    let (result,())=tauri::async_runtime::block_on(join(command,async move{let _=replace_tx.send(());}));let (released,destination)=holder.join().unwrap();
    assert!(released);assert_ne!(scope(&store),old_scope);assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));assert_eq!(snapshot(&store),destination);
    assert_eq!(store.connect().unwrap().query_row::<String,_,_>("SELECT company_name FROM settings WHERE id=1",[],|row|row.get(0)).unwrap(),"Synthetic destination footer");
}

#[test]
fn actual_footer_settings_preserve_signed_read_only_authority_even_for_legacy_none() {
    let (_directory,store)=fixture();identity(&store,&uuid::Uuid::new_v4().to_string(),"read_only");store.install_server_issued_license(&signed_fixture_token(&store,"read_only")).unwrap();
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();let before=snapshot(&store);
    for legacy in [false,true] {assert!(responsive(&store,update_settings(app.state(),patch("Synthetic forbidden footer"),if legacy{None}else{Some(scope(&store))},if legacy{None}else{Some(nonce(&store))})).unwrap_err().contains("limité à la lecture"));}
    assert_eq!(snapshot(&store),before);
}

#[test]
fn actual_footer_settings_keep_business_validation_and_roll_back_real_update_on_audit_failure() {
    let (_directory,store)=fixture();identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let before=snapshot(&store);let mut bad=patch("Synthetic must not survive");bad["iban"]=json!("not-an-iban");
    assert!(responsive(&store,update_settings(app.state(),bad,Some(scope(&store)),Some(nonce(&store)))).unwrap_err().contains("IBAN"));assert_eq!(snapshot(&store),before);
    // Synthetic DB failure after the real UPDATE settings, at its real audit
    // append, proves atomic rollback without replacing the production engine.
    store.connect().unwrap().execute_batch("CREATE TRIGGER synthetic_footer_audit_failure BEFORE INSERT ON audit_log WHEN NEW.entity_type='settings' BEGIN SELECT RAISE(ABORT,'synthetic footer audit failure'); END;").unwrap();
    let before=snapshot(&store);assert!(responsive(&store,update_settings(app.state(),patch("Synthetic rolled back footer"),Some(scope(&store)),Some(nonce(&store)))).unwrap_err().contains("synthetic footer audit failure"));assert_eq!(snapshot(&store),before);
}

#[test]
fn actual_footer_settings_refuse_stale_nonce_before_missing_licence_and_keep_legacy_read_only_guard() {
    let (_directory,store)=unlicensed_fixture();identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");let old_nonce=nonce(&store);identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();let before=snapshot(&store);
    assert!(responsive(&store,update_settings(app.state(),patch("Synthetic stale unlicensed"),Some(scope(&store)),Some(old_nonce))).unwrap_err().contains("Le compte connecté a changé"));
    for legacy in [false,true] {assert!(responsive(&store,update_settings(app.state(),patch("Synthetic unlicensed"),if legacy{None}else{Some(scope(&store))},if legacy{None}else{Some(nonce(&store))})).unwrap_err().contains("lecture seule"));}
    assert_eq!(snapshot(&store),before);
}
