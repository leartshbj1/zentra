//! Synthetic accounting-closing worker and origin-scope regressions.
//! Prepare/finalize call the Tauri handlers via real State.
//! Export is explicitly limited to the exact worker + LocalStore business body:
//! the unchanged AppHandle<Wry> cannot be supplied by mock_builder<MockRuntime>.
//! No fake AppHandle, production licence bypass, network, or user profile.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use futures_util::future::join;
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, future::Future, io::Read, path::Path,
    sync::mpsc, thread, time::Duration};
use tauri::Manager;

fn filter() -> PeriodFilter {
    PeriodFilter { date_from:Some("2026-01-01".into()), date_to:Some("2026-12-31".into()) }
}

// Reuses the existing fiduciary_closing synthetic ledger shape; seed only.
fn seed(store:&LocalStore) -> String {
    let db=store.connect().unwrap();
    let now=crate::database::now_iso();
    let period=uuid::Uuid::new_v4().to_string();
    db.execute("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES(?,'Synthetic closure','2026-01-01','2026-12-31','open',?,?)",params![period,now,now]).unwrap();
    let mut ids=Vec::new();
    for (code,name,kind,normal,section) in [
        ("1020","Synthetic bank","asset","debit","current_assets"),
        ("3200","Synthetic revenue","revenue","credit","net_revenue"),
    ] {
        let existing:Option<(String,String)>=db.query_row("SELECT id,account_type FROM accounts WHERE code=?",[code],|r|Ok((r.get(0)?,r.get(1)?))).optional().unwrap();
        let id=if let Some((id,actual))=existing {assert_eq!(actual,kind);id} else {
            let id=uuid::Uuid::new_v4().to_string();
            db.execute("INSERT INTO accounts(id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)",params![id,code,name,kind,normal,section,now,now]).unwrap();id
        };
        ids.push(id);
    }
    let entry=uuid::Uuid::new_v4().to_string();
    db.execute("INSERT INTO journal_entries(id,number,entry_date,description,source_type,source_id,source_event,status,created_at) VALUES(?,'J-2026-000001','2026-06-15','Synthetic balanced sale','manual',?,'post','posted',?)",params![entry,uuid::Uuid::new_v4().to_string(),now]).unwrap();
    db.execute("INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_cents,credit_cents,currency,memo,created_at) VALUES(?,?,?,100000,0,'CHF','Synthetic bank',?)",params![uuid::Uuid::new_v4().to_string(),entry,ids[0],now]).unwrap();
    db.execute("INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_cents,credit_cents,currency,memo,created_at) VALUES(?,?,?,0,100000,'CHF','Synthetic revenue',?)",params![uuid::Uuid::new_v4().to_string(),entry,ids[1],now]).unwrap();
    drop(db);
    assert_eq!(store.get_accounting_continuity().unwrap()["total_anomalies"],0);
    period
}

fn snapshot(store:&LocalStore)->Value {
    let db=store.connect().unwrap();
    let mut map=serde_json::Map::new();
    for table in ["settings","accounts","accounting_periods","closing_reviews",
        "closing_package_exports","journal_entries","journal_lines","audit_log","company_local_clock"] {
        map.insert(table.into(),json!(crate::database::query_all(&db,
            &format!("SELECT * FROM {table} ORDER BY rowid"),[]).unwrap()));
    }
    Value::Object(map)
}

fn files(store:&LocalStore)->BTreeMap<String,String> {
    std::fs::read_dir(&store.exports_dir).unwrap().map(|entry| {
        let entry=entry.unwrap();assert!(entry.file_type().unwrap().is_file());
        (entry.file_name().to_string_lossy().into_owned(),format!("{:x}",Sha256::digest(std::fs::read(entry.path()).unwrap())))
    }).collect()
}

fn responsive<T>(store:&LocalStore,command:impl Future<Output=Result<T,String>>)->Result<T,String> {
    let locked=store.clone();
    let(ready_tx,ready_rx)=mpsc::channel();let(release_tx,release_rx)=mpsc::channel();
    let holder=thread::spawn(move||{let _guard=locked.lock().unwrap();ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()});
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let(result,())=tauri::async_runtime::block_on(join(command,async move{let _=release_tx.send(());}));
    assert!(holder.join().unwrap(),"actual command future blocked the releasing executor");result
}

fn prepared(store:&LocalStore)->String {
    let _guard=store.lock().unwrap();
    let review=store.prepare_fiduciary_pre_closing(filter()).unwrap();
    assert_eq!(review["checks"]["ready_for_final"],true);
    review["review_id"].as_str().unwrap().to_owned()
}

// NOT the AppHandle Tauri command: test-only exact worker/body witness.
async fn export_worker_body(store:LocalStore,review:String,expected:Option<String>)->Result<Value,String> {
    run_scoped_local_operation(store,expected,move|store|store.export_fiduciary_closing_zip(&review,"1.0.0-proposal").map_err(command_error)).await
}

fn verify_zip(path:&Path,receipt:&Value) {
    let mut zip=zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    assert_eq!(Some(zip.len() as i64),receipt["file_count"].as_i64());
    let mut sums=String::new();zip.by_name("SHA256SUMS").unwrap().read_to_string(&mut sums).unwrap();
    assert_eq!(sums.lines().count()+1,zip.len());
    for line in sums.lines() {
        let(expected,name)=line.split_once("  ").unwrap();let mut bytes=Vec::new();
        zip.by_name(name).unwrap().read_to_end(&mut bytes).unwrap();
        assert_eq!(expected,format!("{:x}",Sha256::digest(&bytes)));
        if name=="manifest.json" {
            assert_eq!(receipt["manifest_sha256"],expected);
            let manifest:Value=serde_json::from_slice(&bytes).unwrap();
            assert_eq!(manifest["review_id"],receipt["review_id"]);
            assert_eq!(manifest["package_status"],receipt["package_status"]);
        }
    }
}

#[test]
fn actual_prepare_yields_while_mutex_held_and_commits_one_review_and_audit() {
    let(_tmp,store)=fixture();let _period=seed(&store);let before=snapshot(&store);
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let receipt=responsive(&store,prepare_fiduciary_pre_closing(app.state(),filter(),Some(scope(&store)))).unwrap();
    assert_eq!(receipt["schema"],"elyko.fiduciary-pre-closing.v1");
    assert_eq!(receipt["checks"]["ready_for_final"],true);
    assert_eq!(receipt["package_status_if_exported"],"DRAFT");
    let after=snapshot(&store);
    assert_eq!(after["closing_reviews"].as_array().unwrap().len(),before["closing_reviews"].as_array().unwrap().len()+1);
    assert_eq!(after["audit_log"].as_array().unwrap().len(),before["audit_log"].as_array().unwrap().len()+1);
    assert_eq!(after["journal_lines"],before["journal_lines"]);
    assert_eq!(store.verify_audit_log().unwrap()["valid"],true);
}

#[test]
fn actual_finalization_yields_and_repeated_closed_confirmation_does_not_write_again() {
    let(_tmp,store)=fixture();let period=seed(&store);let review=prepared(&store);let before=snapshot(&store);
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let receipt=responsive(&store,finalize_accounting_period_with_review(app.state(),period.clone(),review.clone(),Some(scope(&store)))).unwrap();
    assert_eq!(receipt["schema"],"elyko.fiduciary-period-finalization.v1");
    assert_eq!(receipt["period"]["status"],"closed");
    let committed=snapshot(&store);
    assert_eq!(committed["closing_reviews"][0]["status"],"prepared");
    assert_eq!(committed["audit_log"].as_array().unwrap().len(),before["audit_log"].as_array().unwrap().len()+1);
    let again=tauri::async_runtime::block_on(finalize_accounting_period_with_review(app.state(),period,review,None)).unwrap();
    assert_eq!(again,receipt);assert_eq!(snapshot(&store),committed);
    let review=receipt["review_id"].as_str().unwrap().to_owned();
    let exported=responsive(&store,export_worker_body(store.clone(),review.clone(),Some(scope(&store)))).unwrap();
    assert_eq!(exported["package_status"],"FINAL");
    assert_eq!(exported["source_sha256"],receipt["source_sha256"]);
    verify_zip(Path::new(exported["path"].as_str().unwrap()),&exported);
    let registered=snapshot(&store);let registered_files=files(&store);
    assert!(tauri::async_runtime::block_on(export_worker_body(store.clone(),review,None)).unwrap_err().contains("consommée"));
    assert_eq!(snapshot(&store),registered);assert_eq!(files(&store),registered_files);
}

#[test]
fn export_worker_body_yields_and_preserves_read_admission_and_consumption_contract() {
    for access in ["owner","missing","read_only"] {
        let(_tmp,store)=unlicensed_fixture();let _period=seed(&store);
        if access!="missing" {store.install_server_issued_license(&signed_fixture_token(&store,access)).unwrap();}
        if access=="owner" {store.require_write_access().unwrap();}
        else {assert!(store.require_write_access().unwrap_err().to_string().contains("lecture"));}
        let review=prepared(&store);let before=snapshot(&store);
        let receipt=responsive(&store,export_worker_body(store.clone(),review.clone(),Some(scope(&store)))).unwrap();
        assert_eq!(receipt["package_status"],"DRAFT");assert_eq!(receipt["schema"],"elyko.fiduciary-package-export.v1");
        verify_zip(Path::new(receipt["path"].as_str().unwrap()),&receipt);
        let committed=snapshot(&store);let exported=files(&store);
        assert_eq!(committed["closing_reviews"][0]["status"],"consumed");
        assert_eq!(committed["closing_package_exports"].as_array().unwrap().len(),1);
        assert_eq!(committed["audit_log"].as_array().unwrap().len(),before["audit_log"].as_array().unwrap().len()+1);
        assert!(tauri::async_runtime::block_on(export_worker_body(store.clone(),review,Some(scope(&store)))).unwrap_err().contains("consommée"));
        assert_eq!(snapshot(&store),committed);assert_eq!(files(&store),exported);
    }
}

#[test]
fn actual_mutating_commands_keep_missing_and_read_only_guard_before_any_business_write() {
    for access in ["missing","read_only"] {
        let(_tmp,store)=unlicensed_fixture();let period=seed(&store);let review=prepared(&store);
        if access=="read_only" {store.install_server_issued_license(&signed_fixture_token(&store,access)).unwrap();}
        let expected=store.require_write_access().unwrap_err().to_string();let before=snapshot(&store);let original_files=files(&store);
        let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        assert_eq!(responsive(&store,prepare_fiduciary_pre_closing(app.state(),filter(),Some(scope(&store)))).unwrap_err(),expected);
        assert_eq!(snapshot(&store),before);
        assert_eq!(responsive(&store,finalize_accounting_period_with_review(app.state(),period,review,Some(scope(&store)))).unwrap_err(),expected);
        assert_eq!(snapshot(&store),before);assert_eq!(files(&store),original_files);
    }
}

#[test]
fn actual_prepare_audit_failure_rolls_back_review_then_explicit_retry_commits_once() {
    let(_tmp,store)=fixture();let _period=seed(&store);let db=store.connect().unwrap();
    db.execute_batch("CREATE TRIGGER synthetic_closure_prepare_audit BEFORE INSERT ON audit_log WHEN NEW.action='prepare' AND NEW.entity_type='closing_review' BEGIN SELECT RAISE(ABORT,'SYNTHETIC PREPARE AUDIT FAILURE'); END;").unwrap();
    let before=snapshot(&store);let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    assert!(responsive(&store,prepare_fiduciary_pre_closing(app.state(),filter(),Some(scope(&store)))).unwrap_err().contains("SYNTHETIC PREPARE AUDIT FAILURE"));
    assert_eq!(snapshot(&store),before);
    db.execute_batch("DROP TRIGGER synthetic_closure_prepare_audit;").unwrap();
    let receipt=tauri::async_runtime::block_on(prepare_fiduciary_pre_closing(app.state(),filter(),None)).unwrap();
    assert_eq!(receipt["checks"]["ready_for_final"],true);
    assert_eq!(snapshot(&store)["closing_reviews"].as_array().unwrap().len(),1);
}

#[test]
fn actual_finalization_audit_failure_keeps_open_period_and_review_for_explicit_retry() {
    let(_tmp,store)=fixture();let period=seed(&store);let review=prepared(&store);let db=store.connect().unwrap();
    db.execute_batch("CREATE TRIGGER synthetic_closure_close_audit BEFORE INSERT ON audit_log WHEN NEW.action='close' AND NEW.entity_type='accounting_period' BEGIN SELECT RAISE(ABORT,'SYNTHETIC CLOSE AUDIT FAILURE'); END;").unwrap();
    let before=snapshot(&store);let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    assert!(responsive(&store,finalize_accounting_period_with_review(app.state(),period.clone(),review.clone(),Some(scope(&store)))).unwrap_err().contains("SYNTHETIC CLOSE AUDIT FAILURE"));
    assert_eq!(snapshot(&store),before);
    db.execute_batch("DROP TRIGGER synthetic_closure_close_audit;").unwrap();
    let receipt=tauri::async_runtime::block_on(finalize_accounting_period_with_review(app.state(),period.clone(),review.clone(),None)).unwrap();
    assert_eq!(receipt["period"]["status"],"closed");let committed=snapshot(&store);
    tauri::async_runtime::block_on(finalize_accounting_period_with_review(app.state(),period,review,Some(scope(&store)))).unwrap();assert_eq!(snapshot(&store),committed);
}

#[test]
fn export_worker_audit_failure_preserves_sentinel_and_review_then_retries_once() {
    let(_tmp,store)=fixture();let _period=seed(&store);let review=prepared(&store);
    let sentinel=store.exports_dir.join("synthetic-existing.zip");std::fs::write(&sentinel,b"SYNTHETIC EXISTING ARCHIVE").unwrap();
    let db=store.connect().unwrap();db.execute_batch("CREATE TRIGGER synthetic_closure_export_audit BEFORE INSERT ON audit_log WHEN NEW.action='export' AND NEW.entity_type='fiduciary_closing_package' BEGIN SELECT RAISE(ABORT,'SYNTHETIC EXPORT AUDIT FAILURE'); END;").unwrap();
    let before=snapshot(&store);let original_files=files(&store);
    assert!(responsive(&store,export_worker_body(store.clone(),review.clone(),Some(scope(&store)))).unwrap_err().contains("SYNTHETIC EXPORT AUDIT FAILURE"));
    assert_eq!(snapshot(&store),before);assert_eq!(files(&store),original_files);
    db.execute_batch("DROP TRIGGER synthetic_closure_export_audit;").unwrap();
    let receipt=tauri::async_runtime::block_on(export_worker_body(store.clone(),review.clone(),None)).unwrap();verify_zip(Path::new(receipt["path"].as_str().unwrap()),&receipt);
    assert_eq!(std::fs::read(sentinel).unwrap(),b"SYNTHETIC EXISTING ARCHIVE");
    assert_eq!(files(&store).len(),2);let committed=snapshot(&store);let exported=files(&store);
    assert!(tauri::async_runtime::block_on(export_worker_body(store.clone(),review,Some(scope(&store)))).unwrap_err().contains("consommée"));
    assert_eq!(snapshot(&store),committed);assert_eq!(files(&store),exported);
}

#[test]
fn source_change_still_refuses_finalize_and_export_without_creating_files_or_consuming_review() {
    let(_tmp,store)=fixture();let period=seed(&store);let review=prepared(&store);
    store.update_settings(json!({"company_name":"SYNTHETIC CHANGED SOURCE"})).unwrap();
    let before=snapshot(&store);let original_files=files(&store);
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    assert!(responsive(&store,finalize_accounting_period_with_review(app.state(),period,review.clone(),Some(scope(&store)))).unwrap_err().contains("changé depuis la pré-clôture"));
    assert_eq!(snapshot(&store),before);
    assert!(responsive(&store,export_worker_body(store.clone(),review,Some(scope(&store)))).unwrap_err().contains("changé depuis la pré-clôture"));
    assert_eq!(snapshot(&store),before);assert_eq!(files(&store),original_files);
}

#[derive(Clone, Copy, Debug)]
enum Operation { Prepare, Finalize, ExportBody }

// Only prepare/finalize dispatch the real proposed Tauri handler. The export
// witness deliberately exercises the identical scoped worker and store body,
// because AppHandle<Wry> cannot be produced by mock_builder<MockRuntime>.
async fn run(state:State<'_,LocalStore>,operation:Operation,period:String,review:String,
    expected:Option<String>)->Result<Value,String> {
    match operation {
        Operation::Prepare=>prepare_fiduciary_pre_closing(state,filter(),expected).await,
        Operation::Finalize=>finalize_accounting_period_with_review(state,period,review,expected).await,
        Operation::ExportBody=>export_worker_body(state.inner().clone(),review,expected).await,
    }
}

fn after_queued_restore<T>(store:&LocalStore,backup:String,
    command:impl Future<Output=Result<T,String>>)->(Result<T,String>,Value,BTreeMap<String,String>) {
    let replacing=store.clone();
    let(ready_tx,ready_rx)=mpsc::channel();let(replace_tx,replace_rx)=mpsc::channel();
    let holder=thread::spawn(move|| {
        let _guard=replacing.lock().unwrap();
        ready_tx.send(()).unwrap();
        let released=replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        replacing.require_backup_restore_access().unwrap();
        replacing.restore_backup(&backup,"closure-scoped-worker-test").unwrap();
        (released,snapshot(&replacing),files(&replacing))
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let(result,())=tauri::async_runtime::block_on(join(command,async move {replace_tx.send(()).unwrap();}));
    let(released,restored,restored_files)=holder.join().unwrap();
    assert!(released,"queued closure blocked the executor before restore could proceed");
    (result,restored,restored_files)
}

#[test]
fn queued_closure_operations_reject_original_scope_after_real_restore_with_same_review_and_period_ids() {
    let _transfer_test=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for operation in [Operation::Prepare,Operation::Finalize,Operation::ExportBody] {
        let(_tmp,store)=fixture();let period=seed(&store);let review=prepared(&store);
        let original_scope=scope(&store);
        let sentinel=store.exports_dir.join("synthetic-existing.zip");
        std::fs::write(&sentinel,b"SYNTHETIC EXISTING ARCHIVE").unwrap();
        let original_files=files(&store);
        let backup=store.create_backup(None,"closure-scoped-worker-test").unwrap();
        let app=tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let(result,restored,restored_files)=after_queued_restore(&store,backup,
            run(app.state(),operation,period.clone(),review.clone(),Some(original_scope.clone())));
        assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"),"{operation:?}");
        assert_ne!(scope(&store),original_scope);
        assert_eq!(snapshot(&store),restored,"{operation:?} changed the restored destination");
        assert_eq!(restored["accounting_periods"][0]["id"],period);
        assert_eq!(restored["accounting_periods"][0]["status"],"open");
        assert_eq!(restored["closing_reviews"][0]["id"],review);
        assert_eq!(restored["closing_reviews"][0]["status"],"prepared");
        assert_eq!(files(&store),restored_files);
        assert_eq!(restored_files,original_files);
        assert_eq!(std::fs::read(&sentinel).unwrap(),b"SYNTHETIC EXISTING ARCHIVE");
        assert_eq!(store.verify_audit_log().unwrap()["valid"],true);
    }
}

#[test]
fn stale_scope_is_refused_before_business_validation_and_missing_write_licence() {
    for operation in [Operation::Prepare,Operation::Finalize,Operation::ExportBody] {
        let(_tmp,store)=unlicensed_fixture();let _period=seed(&store);
        let expected_write_error=store.require_write_access().unwrap_err().to_string();
        assert!(expected_write_error.contains("lecture seule"));
        let before=snapshot(&store);let original_files=files(&store);
        let app=tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let stale=Some(format!("{}-replaced",scope(&store)));
        let result=match operation {
            Operation::Prepare=>responsive(&store,prepare_fiduciary_pre_closing(app.state(),PeriodFilter::default(),stale)),
            _=>responsive(&store,run(app.state(),operation,String::new(),String::new(),stale)),
        };
        assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"),"{operation:?}");
        assert_eq!(snapshot(&store),before);
        assert_eq!(files(&store),original_files);
    }
}

#[test]
fn already_acquired_scoped_prepare_finishes_in_origin_before_real_restore_can_replace_it() {
    let _transfer_test=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let(_tmp,store)=fixture();let period=seed(&store);let original_scope=scope(&store);
    let backup=store.create_backup(None,"closure-scoped-worker-test").unwrap();
    let working=store.clone();let replacing=store.clone();
    let(acquired_tx,acquired_rx)=mpsc::channel();let(release_tx,release_rx)=mpsc::channel();
    // Helper/store witness, not a paused Tauri handler or a production test hook.
    let command=run_scoped_local_operation(working,Some(original_scope.clone()),move|store| {
        require_write(store)?;
        acquired_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).map_err(|_|"Synthetic release did not arrive".to_owned())?;
        store.prepare_fiduciary_pre_closing(filter()).map_err(command_error)
    });
    let(result,(restore,completed_rx))=tauri::async_runtime::block_on(join(command,async move {
        acquired_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let(completed_tx,completed_rx)=mpsc::channel();
        let restore=thread::spawn(move|| {
            let _guard=replacing.lock().unwrap();
            replacing.require_backup_restore_access().unwrap();
            replacing.restore_backup(&backup,"closure-scoped-worker-test").unwrap();
            completed_tx.send(()).unwrap();
            (scope(&replacing),snapshot(&replacing))
        });
        assert!(matches!(completed_rx.recv_timeout(Duration::from_millis(50)),Err(mpsc::RecvTimeoutError::Timeout)));
        release_tx.send(()).unwrap();
        // Retain receiver until the thread sends: no accidental SendError fixture.
        (restore,completed_rx)
    }));
    let receipt=result.unwrap();
    assert_eq!(receipt["period"]["id"],period);
    assert_eq!(receipt["checks"]["ready_for_final"],true);
    completed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let(restored_scope,restored)=restore.join().unwrap();
    assert_ne!(restored_scope,original_scope);
    assert_eq!(restored["accounting_periods"][0]["id"],period);
    assert!(restored["closing_reviews"].as_array().unwrap().is_empty());
    assert_eq!(snapshot(&store),restored);
}
