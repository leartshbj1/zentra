//! Real synthetic stores, Tauri State and actual match/unlink command guards.
//! Prepared for native CI; not compiled, parsed or executed in this local audit.
use super::*;
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use crate::bank_import::customer_refunds::{MatchInput, UnmatchInput};
use serde_json::json;
use std::{sync::mpsc, thread, time::Duration};
use tauri::Manager;

#[derive(Clone, Copy, Debug)]
enum Operation { Match, Unlink }
#[derive(Clone)]
struct Inputs { matched: MatchInput, unlinked: UnmatchInput }
fn run(state: State<'_, LocalStore>, operation: Operation, inputs: &Inputs, expected: Option<String>) -> Result<Value, String> {
    match operation {
        Operation::Match => match_bank_customer_credit_refund(state, inputs.matched.clone(), expected),
        Operation::Unlink => unmatch_bank_customer_credit_refund(state, inputs.unlinked.clone(), expected),
    }
}
// Exact historical business bodies (only fixture names differ). No guard bypass
// is used by the candidate commands; these establish the old-contract witness.
fn before_match(state:State<'_,LocalStore>,input:crate::bank_import::customer_refunds::MatchInput)->Result<Value,String> {
    let _guard=state.lock().map_err(command_error)?;require_write(&state)?;
    state.match_bank_customer_credit_refund(input).map_err(command_error)
}
fn before_unlink(state:State<'_,LocalStore>,input:crate::bank_import::customer_refunds::UnmatchInput)->Result<Value,String> {
    let _guard=state.lock().map_err(command_error)?;require_write(&state)?;
    state.unmatch_bank_customer_credit_refund(input).map_err(command_error)
}
fn before(state: State<'_, LocalStore>, operation: Operation, inputs: &Inputs) -> Result<Value, String> {
    match operation { Operation::Match => before_match(state, inputs.matched.clone()), Operation::Unlink => before_unlink(state, inputs.unlinked.clone()) }
}
fn id(row: &Value) -> String { row["id"].as_str().unwrap().to_owned() }
fn document(store: &LocalStore, client: &str, original: Option<&str>, amount: i64) -> String {
    let invoice=id(&store.create_record("invoices",json!({"client_id":client,"title":"Synthetic bank pending scope","type":if original.is_some(){"credit_note"}else{"standard"},"original_invoice_id":original,"service_date_from":"2026-08-01","service_date_to":"2026-08-01"})).unwrap());
    store.create_record("invoice_items",json!({"invoice_id":invoice,"description":"Synthetic service","quantity":1,"unit":"forfait","unit_price_cents":amount,"vat_bp":0})).unwrap();
    invoice
}
fn financial_fixture(operation: Operation) -> (tempfile::TempDir, LocalStore, Inputs) {
    let (temporary, store)=fixture();crate::tests::enable_accounting(&store);
    let client=id(&store.create_record("clients",json!({"name":"Synthetic customer","address_line1":"Synthetic street","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap());
    let original=document(&store,&client,None,10_000);store.issue_invoice(&original,Some("2026-08-01".into()),None).unwrap();
    store.record_payment(crate::models::RecordPaymentInput{request_id:uuid::Uuid::new_v4().to_string(),invoice_id:original.clone(),amount_cents:10_000,date:Some("2026-08-02".into()),method:Some("bank".into()),reference:None,notes:None}).unwrap();
    let credit=document(&store,&client,Some(&original),5000);store.issue_invoice(&credit,Some("2026-08-15".into()),None).unwrap();
    let bank:String=store.connect().unwrap().query_row("SELECT bank_account_id FROM accounting_settings WHERE id=1",[],|row|row.get(0)).unwrap();
    let refund=id(&store.record_customer_credit_settlement(crate::customer_credit_settlements::CustomerCreditSettlementInput{request_id:uuid::Uuid::new_v4().to_string(),credit_note_id:credit,event_type:"refund".into(),invoice_id:None,date:"2026-08-20".into(),amount_cents:1000,bank_account_id:Some(bank),reference:"SYN-REFUND".into(),reason:"Synthetic refund already transferred".into()}).unwrap()["settlement"]);
    let file=temporary.path().join("synthetic-bank-pending.xml");
    std::fs::write(&file,r#"<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>SYN-PENDING</MsgId></GrpHdr><Stmt><Acct><Id><IBAN>CH4431999123000889012</IBAN></Id><Ccy>CHF</Ccy></Acct><Ntry><Amt Ccy="CHF">10.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-08-20</Dt></BookgDt><AcctSvcrRef>SYN-PENDING</AcctSvcrRef><NtryDtls><TxDtls><Refs><AcctSvcrRef>SYN-PENDING-TX</AcctSvcrRef></Refs><RmtInf><Ustrd>Synthetic pending refund</Ustrd></RmtInf><RltdPties><Cdtr><Nm>Synthetic customer</Nm></Cdtr></RltdPties></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>"#).unwrap();
    store.import_camt_file(&file.to_string_lossy()).unwrap();
    let movement=id(&store.get_bank_workspace().unwrap()["movements"][0]);
    let matched=MatchInput{request_id:uuid::Uuid::new_v4().to_string(),movement_id:movement,refund_id:refund,date_difference_reason:None};
    let unlinked=UnmatchInput{request_id:uuid::Uuid::new_v4().to_string(),match_id:matched.request_id.clone(),reason:"Synthetic documented unlink".into()};
    if matches!(operation,Operation::Unlink){store.match_bank_customer_credit_refund(matched.clone()).unwrap();}
    (temporary,store,Inputs{matched,unlinked})
}
fn snapshot(store:&LocalStore)->Value {
    let connection=store.connect().unwrap();let mut state=serde_json::Map::new();
    for table in ["bank_movements","bank_customer_credit_refund_matches","bank_customer_credit_refund_unlinks","bank_customer_credit_refund_requests","customer_credit_settlements","payments","journal_entries","journal_lines","attachments","audit_log","company_local_clock"] {
        state.insert(table.into(),json!(crate::database::query_all(&connection,&format!("SELECT * FROM {table} ORDER BY rowid"),[]).unwrap()));
    }
    json!(state)
}
fn unchanged_money(store:&LocalStore)->Value {
    let connection=store.connect().unwrap();json!({"settlements":crate::database::query_all(&connection,"SELECT * FROM customer_credit_settlements ORDER BY rowid",[]).unwrap(),"entries":crate::database::query_all(&connection,"SELECT * FROM journal_entries ORDER BY rowid",[]).unwrap(),"lines":crate::database::query_all(&connection,"SELECT * FROM journal_lines ORDER BY rowid",[]).unwrap()})
}
fn mismatch(operation:Operation) {
    let (_temporary,store,inputs)=financial_fixture(operation);let before=snapshot(&store);
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let error=run(app.state(),operation,&inputs,Some(format!("{}-old",scope(&store)))).unwrap_err();assert!(error.contains("L’entreprise ouverte a changé"),"{operation:?}: {error}");assert_eq!(snapshot(&store),before);
}
fn current_and_none(operation:Operation) {
    let (_temporary,store,inputs)=financial_fixture(operation);let money=unchanged_money(&store);
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let first=run(app.state(),operation,&inputs,Some(scope(&store))).unwrap();assert_eq!(first["already_recorded"],false);let confirmed=snapshot(&store);
    let replay=run(app.state(),operation,&inputs,None).unwrap();assert_eq!(replay["already_recorded"],true);assert_eq!(snapshot(&store),confirmed);assert_eq!(unchanged_money(&store),money);
}
fn queued_restore(operation:Operation) {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_temporary,store,inputs)=financial_fixture(operation);let origin=scope(&store);let backup=store.create_backup(None,"bank-pending-scope-test").unwrap();
    let cloned=store.clone();let copied=inputs.clone();let expected=Some(origin.clone());
    let (ready_tx,ready_rx)=mpsc::channel();let (complete_tx,complete_rx)=mpsc::channel();
    let guard=store.lock().unwrap();
    let caller=thread::spawn(move||{let app=tauri::test::mock_builder().manage(cloned).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();ready_tx.send(()).unwrap();let result=run(app.state(),operation,&copied,expected);complete_tx.send(result).unwrap();});
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();assert!(matches!(complete_rx.recv_timeout(Duration::from_millis(50)),Err(mpsc::RecvTimeoutError::Timeout)),"command must wait for the actual store lock");
    store.restore_backup(&backup,"bank-pending-scope-test").unwrap();let restored=snapshot(&store);assert_ne!(scope(&store),origin);
    assert_eq!(restored["bank_movements"][0]["id"],inputs.matched.movement_id);assert_eq!(restored["customer_credit_settlements"][0]["id"],inputs.matched.refund_id);
    if matches!(operation,Operation::Unlink){assert_eq!(restored["bank_customer_credit_refund_matches"][0]["id"],inputs.unlinked.match_id);}
    drop(guard);let error=complete_rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap_err();caller.join().unwrap();assert!(error.contains("L’entreprise ouverte a changé"),"{operation:?}: {error}");assert_eq!(snapshot(&store),restored);
    // Prepared baseline witness: the old wrapper accepts the unchanged UUIDs in
    // the restored database, while the scoped candidate refused before writing.
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();assert_eq!(before(app.state(),operation,&inputs).unwrap()["already_recorded"],false);
}
#[test]fn match_mismatch_refuses_before_financial_or_audit_writes(){mismatch(Operation::Match);}
#[test]fn unlink_mismatch_refuses_before_financial_or_audit_writes(){mismatch(Operation::Unlink);}
#[test]fn match_current_and_none_keep_receipt_replay_and_money(){current_and_none(Operation::Match);}
#[test]fn unlink_current_and_none_keep_receipt_replay_and_money(){current_and_none(Operation::Unlink);}
#[test]fn match_queued_behind_a_real_restore_refuses_old_origin_with_same_uuids(){queued_restore(Operation::Match);}
#[test]fn unlink_queued_behind_a_real_restore_refuses_old_origin_with_same_uuids(){queued_restore(Operation::Unlink);}
#[test]fn both_commands_keep_missing_and_read_only_license_rejections(){
    let (_temporary,store)=unlicensed_fixture();let inputs=Inputs{matched:MatchInput{request_id:uuid::Uuid::new_v4().to_string(),movement_id:uuid::Uuid::new_v4().to_string(),refund_id:uuid::Uuid::new_v4().to_string(),date_difference_reason:None},unlinked:UnmatchInput{request_id:uuid::Uuid::new_v4().to_string(),match_id:uuid::Uuid::new_v4().to_string(),reason:"Synthetic documented unlink".into()}};
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    for read_only in [false,true]{if read_only{store.install_server_issued_license(&signed_fixture_token(&store,"read_only")).unwrap();}let before=snapshot(&store);for operation in [Operation::Match,Operation::Unlink]{for expected in [None,Some(scope(&store))]{let error=run(app.state(),operation,&inputs,expected).unwrap_err();assert!(error.contains("lecture"),"{operation:?}: {error}");}}assert_eq!(snapshot(&store),before);}
}
#[test]fn old_origin_is_checked_before_uuid_validation_and_missing_license(){
    let (_temporary,store)=unlicensed_fixture();let inputs=Inputs{matched:MatchInput{request_id:"invalid".into(),movement_id:"invalid".into(),refund_id:"invalid".into(),date_difference_reason:None},unlinked:UnmatchInput{request_id:"invalid".into(),match_id:"invalid".into(),reason:String::new()}};
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();let before=snapshot(&store);
    for operation in [Operation::Match,Operation::Unlink]{let error=run(app.state(),operation,&inputs,Some("synthetic-old-origin".into())).unwrap_err();assert!(error.contains("L’entreprise ouverte a changé"),"{operation:?}: {error}");}assert_eq!(snapshot(&store),before);
}
