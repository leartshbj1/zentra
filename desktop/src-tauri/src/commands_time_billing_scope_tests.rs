//! Synthetic regressions for the scoped time-billing command.
//! All records and licence authority are synthetic and scoped to temporary LocalStore.
use super::import_worker_tests::{fixture, scope};
use super::*;
use serde_json::json;
use tauri::Manager;

fn records(store: &LocalStore) -> (String, String) {
    let client=store.create_record("clients",json!({"name":"Synthetic time client","address_line1":"Synthetic road","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap();
    let project=store.create_record("projects",json!({"name":"Synthetic time project","client_id":client["id"]})).unwrap();
    let employee=store.create_record("employees",json!({"name":"Synthetic time employee","country":"CH"})).unwrap();
    let entry=store.create_record("time_entries",json!({"project_id":project["id"],"employee_id":employee["id"],"date":"2026-09-01","minutes":60,"billable":true,"billing_rate_cents":6000,"status":"approuve","note":"Synthetic work"})).unwrap();
    (project["id"].as_str().unwrap().into(),entry["id"].as_str().unwrap().into())
}
fn input(project: String,entry: String) -> CreateInvoiceFromTimeEntriesInput {
    CreateInvoiceFromTimeEntriesInput { request_id:uuid::Uuid::new_v4().to_string(),project_id:project,time_entry_ids:vec![entry],title:None,service_date_from:None,service_date_to:None,vat_bp:None,notes:None }
}


#[test]
fn scoped_handler_refuses_original_ids_after_real_restore_without_any_new_write() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_temporary,store)=fixture();
    let (project,entry)=records(&store);
    let origin=scope(&store);
    let backup=store.create_backup(None,"time-scope-test").unwrap();
    tauri::async_runtime::block_on(restore_local_backup(store.clone(),backup,"time-scope-test".into())).unwrap();
    assert_ne!(scope(&store),origin);
    let restored=store.get_workspace().unwrap();
    assert_eq!(restored["projects"][0]["id"],project);
    assert_eq!(restored["time_entries"][0]["id"],entry);
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let result=tauri::async_runtime::block_on(create_invoice_from_time_entries(app.state(),input(project,entry),Some(origin)));
    assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));
    assert_eq!(store.get_workspace().unwrap(),restored);
}

#[test]
fn queued_scoped_handler_checks_origin_only_after_real_restore_releases_shared_mutex() {
    use std::{sync::mpsc,thread,time::Duration};
    use futures_util::future::join;
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_temporary,store)=fixture();
    let (project,entry)=records(&store);
    let origin=scope(&store);
    let backup=store.create_backup(None,"time-scope-test").unwrap();
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let replacing=store.clone();
    let (ready_tx,ready_rx)=mpsc::channel();
    let (replace_tx,replace_rx)=mpsc::channel();
    let holder=thread::spawn(move || {
        let _guard=replacing.lock().unwrap();
        ready_tx.send(()).unwrap();
        let released=replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        replacing.restore_backup(&backup,"time-scope-test").unwrap();
        (released,replacing.get_workspace().unwrap())
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result,())=tauri::async_runtime::block_on(join(
        create_invoice_from_time_entries(app.state(),input(project.clone(),entry.clone()),Some(origin.clone())),
        async move {replace_tx.send(()).unwrap();},
    ));
    let (released,restored)=holder.join().unwrap();
    assert!(released,"waiting for the store mutex must not block the executor");
    assert_ne!(scope(&store),origin);
    assert_eq!(restored["projects"][0]["id"],project);
    assert_eq!(restored["time_entries"][0]["id"],entry);
    assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));
    assert_eq!(store.get_workspace().unwrap(),restored);
}

#[test]
fn current_scope_and_legacy_none_keep_the_original_financial_and_idempotence_contract() {
    for scoped in [true,false] {
        let (_temporary,store)=fixture();
        let (project,entry)=records(&store);
        let request_id=uuid::Uuid::new_v4().to_string();
        let expected=if scoped {Some(scope(&store))} else {None};
        let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let mut first=input(project.clone(),entry.clone());first.request_id=request_id.clone();
        let receipt=tauri::async_runtime::block_on(create_invoice_from_time_entries(app.state(),first,expected.clone())).unwrap();
        assert_eq!(receipt["idempotent"],false);
        assert_eq!(receipt["invoice"]["status"],"brouillon");
        assert_eq!(receipt["invoice"]["subtotal_cents"],6000);
        let recorded=store.get_workspace().unwrap();
        let mut retry=input(project,entry);retry.request_id=request_id;
        let replay=tauri::async_runtime::block_on(create_invoice_from_time_entries(app.state(),retry,expected)).unwrap();
        assert_eq!(replay["idempotent"],true);
        assert_eq!(replay["invoice"]["id"],receipt["invoice"]["id"]);
        assert_eq!(store.get_workspace().unwrap(),recorded);
    }
}
