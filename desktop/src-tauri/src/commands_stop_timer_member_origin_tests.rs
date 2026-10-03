//! Actual guarded stop_timer IPC candidates. No change to the timer engine,
//! clock calculation, transaction, signed authority or legacy None contract.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use chrono::{Duration as ChronoDuration, Utc};
use futures_util::future::join;
use serde_json::json;
use std::{future::Future, sync::mpsc, thread, time::Duration};
use tauri::Manager;

fn nonce(store: &LocalStore) -> String {
    crate::member_context::read(&store.connect().unwrap()).unwrap()
}
fn identity(store: &LocalStore, user: &str, role: &str) {
    crate::company_collaboration::set_identity(store, "synthetic-stop-timer-org", user, "Synthetic timer member", role).unwrap();
}
fn start(store: &LocalStore, project_id: &str, note: &str) {
    store.create_record("projects", json!({"id":project_id,"name":note})).unwrap();
    store.start_timer(TimerInput {
        project_id:project_id.into(), task_id:None, employee_id:None,
        note:Some(note.into()), billable:true, billing_rate_cents:12_345, cost_rate_cents:6_789,
    }).unwrap();
    store.connect().unwrap().execute("UPDATE active_timers SET started_at=? WHERE id=1", [(Utc::now()-ChronoDuration::seconds(3_670)).to_rfc3339()]).unwrap();
}
fn snapshot(store: &LocalStore) -> Value {
    let connection=store.connect().unwrap(); let mut rows=serde_json::Map::new();
    for table in ["settings","projects","project_tasks","employees","active_timers","time_entries","quotes","quote_items","invoices","invoice_items","document_creators","audit_log","journal_entries","journal_lines","company_local_clock"] {
        rows.insert(table.into(),json!(crate::database::query_all(&connection,&format!("SELECT * FROM {table} ORDER BY rowid"),[]).unwrap()));
    }
    Value::Object(rows)
}
fn responsive<T>(store: &LocalStore, command: impl Future<Output=Result<T,String>>) -> Result<T,String> {
    let held=store.clone(); let (ready_tx,ready_rx)=mpsc::channel(); let (release_tx,release_rx)=mpsc::channel();
    let holder=thread::spawn(move||{let _guard=held.lock().unwrap();ready_tx.send(()).unwrap();release_rx.recv_timeout(Duration::from_secs(5)).is_ok()});
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result,())=tauri::async_runtime::block_on(join(command,async move{let _=release_tx.send(());}));
    assert!(holder.join().unwrap(),"actual stop_timer must yield while awaiting the LocalStore mutex"); result
}

#[test]
fn actual_stop_timer_yields_preserves_receipt_minutes_and_legacy_none_contract() {
    for legacy in [false,true] {
        let (_directory,store)=fixture(); identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");
        let project_id=uuid::Uuid::new_v4().to_string();start(&store,&project_id,"Synthetic retained timer note");
        let timer=store.get_active_timer().unwrap();let connection=store.connect().unwrap();
        let before_entries:i64=connection.query_row("SELECT COUNT(*) FROM time_entries",[],|row|row.get(0)).unwrap();
        let before_journals:i64=connection.query_row("SELECT COUNT(*) FROM journal_entries",[],|row|row.get(0)).unwrap();drop(connection);
        let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();store.require_write_access().unwrap();
        let entry=responsive(&store,stop_timer(app.state(),if legacy{None}else{Some(scope(&store))},if legacy{None}else{Some(nonce(&store))})).unwrap();
        assert_eq!(entry["project_id"],project_id);assert_eq!(entry["started_at"],timer["started_at"]);
        assert_eq!(entry["note"],"Synthetic retained timer note");assert_eq!(entry["billing_rate_cents"],12_345);assert_eq!(entry["cost_rate_cents"],6_789);assert_eq!(entry["status"],"approuve");
        // These are exactly the existing configured fixture rules (5 minute
        // pause and 15 minute upward rounding), not a replacement calculation.
        assert_eq!(entry["minutes"],60);assert_eq!(entry["break_minutes"],5);
        assert_eq!(store.get_active_timer().unwrap(),json!(null));let connection=store.connect().unwrap();
        assert_eq!(connection.query_row::<i64,_,_>("SELECT COUNT(*) FROM time_entries",[],|row|row.get(0)).unwrap(),before_entries+1);
        assert_eq!(connection.query_row::<i64,_,_>("SELECT COUNT(*) FROM journal_entries",[],|row|row.get(0)).unwrap(),before_journals);
        assert_eq!(connection.query_row::<String,_,_>("SELECT id FROM time_entries ORDER BY rowid DESC LIMIT 1",[],|row|row.get(0)).unwrap(),entry["id"].as_str().unwrap());drop(connection);
        let after=snapshot(&store);assert!(responsive(&store,stop_timer(app.state(),if legacy{None}else{Some(scope(&store))},if legacy{None}else{Some(nonce(&store))})).unwrap_err().contains("Aucun chronomètre actif"));assert_eq!(snapshot(&store),after);
    }
}

#[test]
fn actual_stop_timer_rejects_captured_member_a_to_b_and_aba_without_business_writes() {
    for aba in [false,true] {
        let (_directory,store)=fixture();let alice=uuid::Uuid::new_v4().to_string();identity(&store,&alice,"owner");
        start(&store,&uuid::Uuid::new_v4().to_string(),"Synthetic original active timer");let old_scope=scope(&store);let old_nonce=nonce(&store);
        let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        // Real handler captured before transition but not yet polled. Acquired
        // worker physical restore ordering has its own separate witness below.
        let command=stop_timer(app.state(),Some(old_scope.clone()),Some(old_nonce.clone()));
        identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");if aba{identity(&store,&alice,"owner");}
        assert_eq!(scope(&store),old_scope);assert_ne!(nonce(&store),old_nonce);store.require_write_access().unwrap();let before=snapshot(&store);
        assert!(responsive(&store,command).unwrap_err().contains("Le compte connecté a changé"));assert_eq!(snapshot(&store),before);
    }
}

#[test]
fn queued_actual_stop_timer_rejects_same_id_physical_restore_before_any_timer_write() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_directory,store)=fixture();let (_other_directory,other)=fixture();let shared_project=uuid::Uuid::new_v4().to_string();
    start(&store,&shared_project,"Synthetic A active timer");start(&other,&shared_project,"Synthetic B active timer");
    // Both files have the same active_timers primary key 1 and project UUID.
    assert_eq!(store.get_active_timer().unwrap()["id"],other.get_active_timer().unwrap()["id"]);
    let old_scope=scope(&store);let old_nonce=nonce(&store);let backup=other.create_backup(None,"stop-timer-origin-test").unwrap();
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let replacing=store.clone();let (ready_tx,ready_rx)=mpsc::channel();let (replace_tx,replace_rx)=mpsc::channel();
    let holder=thread::spawn(move||{
        let _guard=replacing.lock().unwrap();
        let licence_before:(String,String)=replacing.connect().unwrap().query_row("SELECT token_sha256,license_id FROM license_state WHERE id=1",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        ready_tx.send(()).unwrap();let released=replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        replacing.require_backup_restore_access().unwrap();replacing.restore_backup(&backup,"stop-timer-origin-test").unwrap();
        let licence_after:(String,String)=replacing.connect().unwrap().query_row("SELECT token_sha256,license_id FROM license_state WHERE id=1",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(licence_before,licence_after);replacing.require_write_access().unwrap(); // no setter or licence reinstall under the mutex
        (released,snapshot(&replacing))
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();let command=stop_timer(app.state(),Some(old_scope.clone()),Some(old_nonce));
    let (result,())=tauri::async_runtime::block_on(join(command,async move{let _=replace_tx.send(());}));let (released,destination)=holder.join().unwrap();
    assert!(released,"real queued handler must yield until checked restore completes");assert_ne!(scope(&store),old_scope);
    assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));assert_eq!(snapshot(&store),destination);assert_eq!(store.get_active_timer().unwrap()["note"],"Synthetic B active timer");
}

#[test]
fn actual_stop_timer_preserves_signed_read_only_authority_for_current_and_legacy_context() {
    let (_directory,store)=fixture();identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");start(&store,&uuid::Uuid::new_v4().to_string(),"Synthetic read-only timer");
    identity(&store,&uuid::Uuid::new_v4().to_string(),"read_only");store.install_server_issued_license(&signed_fixture_token(&store,"read_only")).unwrap();
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();let before=snapshot(&store);
    for legacy in [false,true] {let error=responsive(&store,stop_timer(app.state(),if legacy{None}else{Some(scope(&store))},if legacy{None}else{Some(nonce(&store))})).unwrap_err();assert!(error.contains("limité à la lecture"));}
    assert_eq!(snapshot(&store),before);
}

#[test]
fn actual_stop_timer_retains_active_timer_and_rolls_back_on_existing_timestamp_validation() {
    for legacy in [false,true] {
        let (_directory,store)=fixture();identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");start(&store,&uuid::Uuid::new_v4().to_string(),"Synthetic invalid timer timestamp");
        store.connect().unwrap().execute("UPDATE active_timers SET started_at='not-a-date' WHERE id=1",[]).unwrap();
        let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();let before=snapshot(&store);
        assert!(responsive(&store,stop_timer(app.state(),if legacy{None}else{Some(scope(&store))},if legacy{None}else{Some(nonce(&store))})).unwrap_err().contains("Horodatage du chronomètre invalide"));assert_eq!(snapshot(&store),before);
    }
}

#[test]
fn actual_stop_timer_checks_stale_member_before_missing_licence_or_timer() {
    let (_directory,store)=unlicensed_fixture();identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");let old_nonce=nonce(&store);identity(&store,&uuid::Uuid::new_v4().to_string(),"owner");
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();let before=snapshot(&store);
    assert!(responsive(&store,stop_timer(app.state(),Some(scope(&store)),Some(old_nonce))).unwrap_err().contains("Le compte connecté a changé"));
    for legacy in [false,true] {assert!(responsive(&store,stop_timer(app.state(),if legacy{None}else{Some(scope(&store))},if legacy{None}else{Some(nonce(&store))})).unwrap_err().contains("lecture seule"));}
    assert_eq!(snapshot(&store),before);
}
