//! Real payroll IPC handlers, licensed temporary stores and managed image bytes.
//! Prepared for native CI; no local native execution is claimed.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use crate::models::PayrollImportDraft;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::future::join;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{future::Future, path::{Path, PathBuf}, sync::mpsc, thread, time::Duration};
use tauri::Manager;

const ATTESTATION: &str = "zentra.payroll-import.human-review.v1";

#[derive(Clone, Copy, Debug)]
enum Operation { Stage, List, Preview, Update, Confirm, Reject }
const ALL: [Operation; 6] = [Operation::Stage, Operation::List, Operation::Preview,
    Operation::Update, Operation::Confirm, Operation::Reject];
const WRITES: [Operation; 4] = [Operation::Stage, Operation::Update,
    Operation::Confirm, Operation::Reject];

fn source_file(temporary: &tempfile::TempDir, name: &str, shade: u8) -> PathBuf {
    let path = temporary.path().join(name);
    image::RgbaImage::from_pixel(2, 2, image::Rgba([shade, 60, 90, 255]))
        .save(&path).unwrap();
    path
}

fn stage(store: &LocalStore, path: &Path) -> String {
    store.stage_payroll_documents(StagePayrollDocumentsInput {
        paths: vec![path.to_string_lossy().into_owned()],
    }).unwrap()["imports"][0]["id"].as_str().unwrap().to_owned()
}

fn draft() -> PayrollImportDraft {
    serde_json::from_value(json!({
        "employee":{"name":"Synthetic payroll employee","employee_number":"SYNTH-42"},
        "period":"2026-09","payment_date":"2026-09-30",
        "gross_cents":125000,"net_cents":120000,
        "lines":[
            {"id":"earning-1","label":"Synthetic salary","kind":"earning","amount_cents":125000,"recurring":false},
            {"id":"deduction-1","label":"Synthetic deduction","kind":"deduction","amount_cents":5000}
        ]
    })).unwrap()
}

fn update(id: &str) -> UpdatePayrollImportDraftInput {
    serde_json::from_value(json!({
        "id":id,"draft":draft(),"extraction_engine":"manual-synthetic-review",
        "confidence_bp":7777
    })).unwrap()
}

fn confirmation(id: &str) -> ConfirmPayrollImportInput {
    serde_json::from_value(json!({
        "id":id,"draft":draft(),"human_review_attested":true,
        "human_review_attestation_version":ATTESTATION
    })).unwrap()
}

async fn run(state: State<'_, LocalStore>, operation: Operation, source: &Path,
    id: &str, expected: Option<String>) -> Result<Value, String> {
    match operation {
        Operation::Stage => stage_payroll_documents(state, StagePayrollDocumentsInput {
            paths: vec![source.to_string_lossy().into_owned()],
        }, expected).await,
        Operation::List => list_payroll_document_imports(state, expected).await,
        Operation::Preview => get_payroll_document_preview(state, id.into(), expected).await,
        Operation::Update => update_payroll_import_draft(state, update(id), expected).await,
        Operation::Confirm => confirm_payroll_document_import(state, confirmation(id), expected).await,
        Operation::Reject => reject_payroll_document_import(state, id.into(), expected).await,
    }
}

fn responsive<T>(store: &LocalStore, command: impl Future<Output=Result<T,String>>) -> Result<T,String> {
    let holding = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = holding.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(command, async move {
        let _ = release_tx.send(());
    }));
    assert!(holder.join().unwrap(), "handler blocked the executor while waiting for LocalStore");
    result
}

fn snapshot(store: &LocalStore) -> Value {
    let db = store.connect().unwrap();
    let mut result = serde_json::Map::new();
    for table in ["payroll_document_imports", "employees", "payslips", "payslip_items",
        "employee_payroll_templates", "audit_log", "company_local_clock"] {
        result.insert(table.into(), json!(crate::database::query_all(&db,
            &format!("SELECT * FROM {table} ORDER BY rowid"), []).unwrap()));
    }
    let directory = store.attachments_dir.join("payroll-imports");
    let mut files: Vec<(String,String)> = if directory.exists() {
        std::fs::read_dir(directory).unwrap().map(|entry| {
            let entry = entry.unwrap();
            (entry.file_name().to_string_lossy().into_owned(),
                format!("{:x}",Sha256::digest(std::fs::read(entry.path()).unwrap())))
        }).collect()
    } else { vec![] };
    files.sort();
    result.insert("managed_file_hashes".into(),json!(files));
    Value::Object(result)
}

fn assert_confirmed(store: &LocalStore, receipt: &Value, id: &str, source: &Path) {
    assert_eq!(receipt["import_id"],id);
    assert_eq!(receipt["status"],"confirmed");
    assert_eq!(receipt["human_review_attestation_version"],ATTESTATION);
    chrono::DateTime::parse_from_rfc3339(receipt["human_review_attested_at"].as_str().unwrap()).unwrap();
    let state = snapshot(store);
    assert_eq!(state["employees"].as_array().unwrap().len(),1);
    assert_eq!(state["employees"][0]["monthly_salary_cents"],0,
        "a historical non-recurring salary must not become a contract salary");
    assert!(state["employee_payroll_templates"].as_array().unwrap().is_empty());
    assert_eq!(state["payslips"].as_array().unwrap().len(),1);
    assert_eq!(state["payslips"][0]["status"],"a_controler");
    assert_eq!(state["payslips"][0]["gross_cents"],125000);
    assert_eq!(state["payslips"][0]["deductions_cents"],5000);
    assert_eq!(state["payslips"][0]["net_cents"],120000);
    assert_eq!(state["payslip_items"].as_array().unwrap().len(),2);
    let import = state["payroll_document_imports"].as_array().unwrap().iter()
        .find(|row| row["id"]==id).unwrap();
    assert_eq!(import["status"],"confirmed");
    assert_eq!(import["file_sha256"],format!("{:x}",Sha256::digest(std::fs::read(source).unwrap())));
    assert_eq!(import["confirmation_evidence_sha256"],receipt["source_import_evidence_sha256"]);
    assert!(crate::audit::verify_audit_chain(&store.connect().unwrap()).unwrap()["valid"].as_bool().unwrap());
}

#[test]
fn all_six_payroll_handlers_yield_to_the_executor_while_the_real_store_lock_is_held() {
    let (temporary, store)=fixture();
    let source=source_file(&temporary,"main.png",20);
    let rejected_source=source_file(&temporary,"reject.png",40);
    let id=stage(&store,&source);
    let reject_id=stage(&store,&rejected_source);
    let app=tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let expected=Some(scope(&store));
    for operation in [Operation::Stage,Operation::List,Operation::Preview,Operation::Update,Operation::Reject,Operation::Confirm] {
        let target=if matches!(operation,Operation::Reject) { &reject_id } else { &id };
        let result=responsive(&store,run(app.state(),operation,&source,target,expected.clone())).unwrap();
        match operation {
            Operation::Stage => assert_eq!(result["imports"][0]["id"],id),
            Operation::List => assert_eq!(result["imports"].as_array().unwrap().len(),2),
            Operation::Preview => assert_eq!(result,json!({"mime_type":"image/png","data_base64":STANDARD.encode(std::fs::read(&source).unwrap())})),
            Operation::Update => {assert_eq!(result["id"],id);assert_eq!(result["confidence_bp"],7777);},
            Operation::Reject => assert_eq!(result,json!({"id":reject_id,"status":"rejected"})),
            Operation::Confirm => assert_confirmed(&store,&result,&id,&source),
        }
    }
}

#[test]
fn queued_handlers_reject_old_scope_after_a_real_restore_preserving_import_uuids_and_files() {
    let _transfer_test=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (temporary,store)=fixture();
    let source=source_file(&temporary,"same-id.png",30);
    let id=stage(&store,&source);
    let backup=store.create_backup(None,"payroll-scope-worker-test").unwrap();
    let app=tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    for operation in ALL {
        let origin=scope(&store);
        let replacing=store.clone();
        let backup=backup.clone();
        let (ready_tx,ready_rx)=mpsc::channel();
        let (replace_tx,replace_rx)=mpsc::channel();
        let holder=thread::spawn(move || {
            let _guard=replacing.lock().unwrap();
            ready_tx.send(()).unwrap();
            let responsive=replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
            replacing.restore_backup(&backup,"payroll-scope-worker-test").unwrap();
            (responsive,snapshot(&replacing))
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (result,())=tauri::async_runtime::block_on(join(
            run(app.state(),operation,&source,&id,Some(origin.clone())),
            async move {let _=replace_tx.send(());}
        ));
        let (responsive,restored)=holder.join().unwrap();
        assert!(responsive,"{operation:?} blocked the waiting executor");
        assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"),"{operation:?}");
        assert_ne!(scope(&store),origin);
        assert_eq!(snapshot(&store),restored,"{operation:?} changed restored data or files");
        assert_eq!(restored["payroll_document_imports"][0]["id"],id);
        let preview=store.payroll_document_preview(&id).unwrap();
        assert_eq!(preview["data_base64"],STANDARD.encode(std::fs::read(&source).unwrap()));
    }
}

#[test]
fn legacy_none_keeps_stage_deduplication_preview_draft_reject_and_confirmation_contracts() {
    let (temporary,store)=fixture();
    let source=source_file(&temporary,"legacy.png",50);
    let rejected_source=source_file(&temporary,"legacy-rejected.png",60);
    let app=tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let first=tauri::async_runtime::block_on(run(app.state(),Operation::Stage,&source,"",None)).unwrap();
    let id=first["imports"][0]["id"].as_str().unwrap().to_owned();
    let repeated=tauri::async_runtime::block_on(run(app.state(),Operation::Stage,&source,"",None)).unwrap();
    assert_eq!(first["imports"][0]["id"],repeated["imports"][0]["id"]);
    let reject_id=stage(&store,&rejected_source);
    let listed=tauri::async_runtime::block_on(run(app.state(),Operation::List,&source,&id,None)).unwrap();
    assert_eq!(listed["imports"].as_array().unwrap().len(),2);
    let preview=tauri::async_runtime::block_on(run(app.state(),Operation::Preview,&source,&id,None)).unwrap();
    assert_eq!(preview,json!({"mime_type":"image/png","data_base64":STANDARD.encode(std::fs::read(&source).unwrap())}));
    let updated=tauri::async_runtime::block_on(run(app.state(),Operation::Update,&source,&id,None)).unwrap();
    assert_eq!(updated["id"],id);
    assert_eq!(updated["confidence_bp"],7777);
    assert_eq!(serde_json::from_str::<Value>(updated["draft_json"].as_str().unwrap()).unwrap()["gross_cents"],125000);
    assert_eq!(tauri::async_runtime::block_on(run(app.state(),Operation::Reject,&source,&reject_id,None)).unwrap(),json!({"id":reject_id,"status":"rejected"}));
    let receipt=tauri::async_runtime::block_on(run(app.state(),Operation::Confirm,&source,&id,None)).unwrap();
    assert_confirmed(&store,&receipt,&id,&source);
}

#[test]
fn all_writes_keep_real_license_guards_and_reads_remain_available_in_read_only() {
    let (temporary,store)=unlicensed_fixture();
    let source=source_file(&temporary,"licensed-read.png",70);
    let id=stage(&store,&source);
    let app=tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    for read_only in [false,true] {
        if read_only {
            let license=store.install_server_issued_license(&signed_fixture_token(&store,"read_only")).unwrap();
            assert_eq!(license["read_only"],true);
        }
        let before=snapshot(&store);
        for expected in [Some(scope(&store)),None] {
            for operation in WRITES {
                let error=tauri::async_runtime::block_on(run(app.state(),operation,&source,&id,expected.clone())).unwrap_err();
                assert!(error.contains("lecture"),"{read_only}/{operation:?}: {error}");
            }
            let listed=tauri::async_runtime::block_on(run(app.state(),Operation::List,&source,&id,expected.clone())).unwrap();
            assert_eq!(listed["imports"].as_array().unwrap().len(),1);
            let preview=tauri::async_runtime::block_on(run(app.state(),Operation::Preview,&source,&id,expected)).unwrap();
            assert_eq!(preview["data_base64"],STANDARD.encode(std::fs::read(&source).unwrap()));
        }
        assert_eq!(snapshot(&store),before);
    }
}

#[test]
fn old_scope_is_refused_before_missing_file_unknown_import_attestation_or_license_checks() {
    let (temporary,store)=unlicensed_fixture();
    let missing=temporary.path().join("must-not-open.png");
    let app=tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let before=snapshot(&store);
    for operation in ALL {
        let error=tauri::async_runtime::block_on(run(app.state(),operation,&missing,"unknown-import",
            Some("previous-workspace".into()))).unwrap_err();
        assert!(error.contains("L’entreprise ouverte a changé"),"{operation:?}: {error}");
    }
    let legacy:ConfirmPayrollImportInput=serde_json::from_value(json!({"id":"unknown-import","draft":{}})).unwrap();
    assert!(tauri::async_runtime::block_on(confirm_payroll_document_import(app.state(),legacy,
        Some("previous-workspace".into()))).unwrap_err().contains("L’entreprise ouverte a changé"));
    assert_eq!(snapshot(&store),before);
    assert!(!missing.exists());
}

#[test]
fn confirmation_requires_human_review_and_refuses_replay_and_duplicate_period_without_mutation() {
    let (temporary,store)=fixture();
    let source=source_file(&temporary,"reviewed.png",80);
    let id=stage(&store,&source);
    let app=tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let current=Some(scope(&store));
    let before=snapshot(&store);
    let legacy:ConfirmPayrollImportInput=serde_json::from_value(json!({"id":id,"draft":draft()})).unwrap();
    assert!(!legacy.human_review_attested);
    assert!(legacy.human_review_attestation_version.is_empty());
    assert!(tauri::async_runtime::block_on(confirm_payroll_document_import(app.state(),legacy,None))
        .unwrap_err().contains("Confirmez explicitement"));
    assert_eq!(snapshot(&store),before);
    for expected in [current.clone(),None] {
        for (attested,version,message) in [(false,ATTESTATION,"Confirmez explicitement"),(true,"obsolete-v0","version")] {
            let mut input=confirmation(&id);
            input.human_review_attested=attested;
            input.human_review_attestation_version=version.into();
            let error=tauri::async_runtime::block_on(confirm_payroll_document_import(app.state(),input,expected.clone())).unwrap_err();
            assert!(error.contains(message),"{error}");
            assert_eq!(snapshot(&store),before);
        }
    }
    let receipt=tauri::async_runtime::block_on(run(app.state(),Operation::Confirm,&source,&id,current.clone())).unwrap();
    assert_confirmed(&store,&receipt,&id,&source);
    let confirmed=snapshot(&store);
    for expected in [current.clone(),None] {
        let error=tauri::async_runtime::block_on(run(app.state(),Operation::Confirm,&source,&id,expected.clone())).unwrap_err();
        assert!(error.contains("déjà été confirmée"));
        assert!(tauri::async_runtime::block_on(run(app.state(),Operation::Update,&source,&id,expected.clone())).unwrap_err().contains("déjà confirmé"));
        assert!(tauri::async_runtime::block_on(run(app.state(),Operation::Reject,&source,&id,expected)).is_err());
        assert_eq!(snapshot(&store),confirmed);
    }
    let duplicate_source=source_file(&temporary,"same-period.png",81);
    let duplicate=stage(&store,&duplicate_source);
    let before_duplicate=snapshot(&store);
    let mut duplicate_input=confirmation(&duplicate);
    duplicate_input.employee_id=Some(receipt["employee_id"].as_str().unwrap().into());
    let error=tauri::async_runtime::block_on(confirm_payroll_document_import(app.state(),duplicate_input,current)).unwrap_err();
    assert!(error.contains("Une fiche existe déjà"));
    assert_eq!(snapshot(&store),before_duplicate);
}

#[test]
fn confirmation_rechecks_managed_bytes_without_creating_an_employee_or_payslip_on_refusal() {
    let (temporary,store)=fixture();
    let source=source_file(&temporary,"immutable.png",90);
    let id=stage(&store,&source);
    let path:String=store.connect().unwrap().query_row(
        "SELECT stored_path FROM payroll_document_imports WHERE id=?",[&id],|row|row.get(0)).unwrap();
    let replacement=source_file(&temporary,"changed.png",91);
    std::fs::write(&path,std::fs::read(replacement).unwrap()).unwrap();
    let before=snapshot(&store);
    let app=tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    for expected in [Some(scope(&store)),None] {
        let error=tauri::async_runtime::block_on(run(app.state(),Operation::Confirm,&source,&id,expected)).unwrap_err();
        assert!(error.contains("a changé depuis son import"));
        assert_eq!(snapshot(&store),before);
    }
    assert_eq!(before["payroll_document_imports"][0]["status"],"needs_review");
    assert!(before["employees"].as_array().unwrap().is_empty());
    assert!(before["payslips"].as_array().unwrap().is_empty());
}

#[test]
fn confirmation_audit_failure_rolls_back_all_rows_and_clock_then_explicit_retry_commits_once() {
    let (temporary,store)=fixture();
    let source=source_file(&temporary,"atomic-confirmation.png",100);
    let id=stage(&store,&source);
    let before=snapshot(&store);
    store.connect().unwrap().execute_batch(
        "CREATE TRIGGER refuse_worker_payroll_confirmation BEFORE INSERT ON audit_log WHEN NEW.action='confirm' AND NEW.entity_type='payroll_document_import' BEGIN SELECT RAISE(FAIL,'Synthetic payroll confirmation refusal'); END;"
    ).unwrap();
    let app=tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let expected=Some(scope(&store));
    let error=tauri::async_runtime::block_on(run(app.state(),Operation::Confirm,&source,&id,expected.clone())).unwrap_err();
    assert!(error.contains("Synthetic payroll confirmation refusal"));
    assert_eq!(snapshot(&store),before);
    store.connect().unwrap().execute_batch("DROP TRIGGER refuse_worker_payroll_confirmation").unwrap();
    let receipt=tauri::async_runtime::block_on(run(app.state(),Operation::Confirm,&source,&id,expected)).unwrap();
    assert_confirmed(&store,&receipt,&id,&source);
    let after=snapshot(&store);
    assert_eq!(after["audit_log"].as_array().unwrap().len(),before["audit_log"].as_array().unwrap().len()+1);
}
