//! Actual attachment IPCs and restores in temporary, signed synthetic stores.
//! These fixtures use neither a mailbox nor an external viewer.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use crate::customer_credit_settlements::CustomerCreditSettlementInput;
use crate::expense_refund_attachments::RefundAttachmentInput;
use crate::expense_refunds::ExpenseRefundInput;
use crate::supplier_credit_refunds::SupplierCreditRefundInput;
use serde_json::json;
use std::{sync::mpsc, thread, time::Duration};
use tauri::Manager;

#[derive(Clone, Copy, Debug)]
enum Kind { Expense, Customer, Supplier }
const KINDS: [Kind; 3] = [Kind::Expense, Kind::Customer, Kind::Supplier];

struct Events { expense: String, customer: String, supplier: String, project: String }
impl Events {
    fn id(&self, kind: Kind) -> &str {
        match kind { Kind::Expense => &self.expense, Kind::Customer => &self.customer, Kind::Supplier => &self.supplier }
    }
}
fn entity_type(kind: Kind) -> &'static str {
    match kind { Kind::Expense => "expense_refund", Kind::Customer => "customer_credit_settlement", Kind::Supplier => "supplier_credit_refund" }
}
fn run(state: State<'_, LocalStore>, kind: Kind, id: &str, input: RefundAttachmentInput, expected: Option<String>) -> Result<Value, String> {
    match kind {
        Kind::Expense => add_expense_refund_attachment(state, id.into(), input, expected),
        Kind::Customer => add_customer_credit_settlement_attachment(state, id.into(), input, expected),
        Kind::Supplier => add_supplier_credit_refund_attachment(state, id.into(), input, expected),
    }
}
fn receipt() -> RefundAttachmentInput {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(2, 2, image::Rgb([35, 96, 62]))
        .write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    RefundAttachmentInput { original_name: "synthetic-receipt.png".into(), content_base64: STANDARD.encode(bytes.into_inner()) }
}
fn invoice(store: &LocalStore, client: &str, project: &str, original: Option<&str>, amount: i64) -> String {
    let id = store.create_record("invoices", json!({
        "client_id":client,"project_id":project,"title":"Synthetic attachment receipt",
        "type":if original.is_some(){"credit_note"}else{"standard"},"original_invoice_id":original,
        "service_date_from":"2026-02-01","service_date_to":"2026-02-01"
    })).unwrap()["id"].as_str().unwrap().to_owned();
    store.create_record("invoice_items", json!({"invoice_id":id,"description":"Synthetic service",
        "quantity":1,"unit":"forfait","unit_price_cents":amount,"vat_bp":0})).unwrap();
    id
}
fn seed(store: &LocalStore) -> Events {
    let accounts = crate::tests::enable_accounting(store);
    let client = store.create_record("clients", json!({"name":"Synthetic client","address_line1":"Rue synthétique",
        "address_line2":"1","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap()["id"].as_str().unwrap().to_owned();
    let project = store.create_record("projects", json!({"name":"Synthetic evidence project","client_id":client})).unwrap()["id"].as_str().unwrap().to_owned();
    let expense = store.create_record("expenses", json!({"project_id":project,"date":"2026-02-10","paid_at":"2026-02-10",
        "payment_status":"paid","supplier":"Synthetic supplier","reference":"SYN-EXP","net_cents":10000,"vat_cents":0})).unwrap()["id"].as_str().unwrap().to_owned();
    let expense = store.record_expense_refund(ExpenseRefundInput {
        request_id:uuid::Uuid::new_v4().to_string(),expense_id:expense,credit_date:"2026-04-20".into(),
        payment_date:"2026-07-05".into(),reference:"SYN-EXP-REFUND".into(),reason:"Synthetic recorded return of purchased goods".into(),
        net_cents:5000,vat_cents:0,reverses_id:None
    }).unwrap()["refund"]["id"].as_str().unwrap().to_owned();
    let sale = invoice(store, &client, &project, None, 10000);
    store.issue_invoice(&sale, Some("2026-02-01".into()), None).unwrap();
    store.record_payment(crate::models::RecordPaymentInput {
        request_id:uuid::Uuid::new_v4().to_string(),invoice_id:sale.clone(),amount_cents:10000,
        date:Some("2026-02-15".into()),method:Some("bank".into()),reference:None,notes:None
    }).unwrap();
    let credit = invoice(store, &client, &project, Some(&sale), 5000);
    store.issue_invoice(&credit, Some("2026-03-01".into()), None).unwrap();
    let customer = store.record_customer_credit_settlement(CustomerCreditSettlementInput {
        request_id:uuid::Uuid::new_v4().to_string(),credit_note_id:credit,event_type:"refund".into(),invoice_id:None,
        date:"2026-04-01".into(),amount_cents:1000,bank_account_id:Some(accounts["bank"].clone()),
        reference:"SYN-CUSTOMER-REFUND".into(),reason:"Synthetic recorded bank refund".into()
    }).unwrap()["settlement"]["id"].as_str().unwrap().to_owned();
    let supplier = store.create_record("suppliers", json!({"name":"Synthetic supplier"})).unwrap()["id"].as_str().unwrap().to_owned();
    let credit = uuid::Uuid::new_v4().to_string();
    store.save_supplier_credit_note_draft(serde_json::from_value(json!({
        "id":credit,"supplier_id":supplier,"document_date":"2026-08-21","reference":"SYN-SUPPLIER-CREDIT",
        "items":[{"id":uuid::Uuid::new_v4().to_string(),"project_id":project,"description":"Synthetic returned goods",
            "quantity_milli":1000,"unit_price_cents":5000,"vat_bp":0,"category":"Marchandises"}],"allocations":[]
    })).unwrap()).unwrap();
    store.validate_supplier_credit_note(crate::models::ValidateSupplierCreditNoteInput {
        request_id:uuid::Uuid::new_v4().to_string(),supplier_credit_note_id:credit.clone()
    }).unwrap();
    let supplier = store.record_supplier_credit_refund(SupplierCreditRefundInput {
        request_id:uuid::Uuid::new_v4().to_string(),supplier_credit_note_id:credit,date:"2026-08-31".into(),
        amount_cents:5000,reference:"SYN-SUPPLIER-REFUND".into(),reason:"Synthetic returned goods received by supplier".into()
    }).unwrap()["refund"]["id"].as_str().unwrap().to_owned();
    Events { expense, customer, supplier, project }
}
fn finances(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();
    let mut data = serde_json::Map::new();
    for table in ["expenses","expense_refunds","invoices","invoice_items","payments",
        "supplier_credit_notes","supplier_credit_note_items","supplier_credit_allocations","supplier_credit_refunds","supplier_operation_requests",
        "customer_credit_documents","customer_credit_settlements","customer_credit_settlement_lines","customer_credit_settlement_postings",
        "journal_entries","journal_lines"] {
        data.insert(table.into(), json!(crate::database::query_all(&connection,&format!("SELECT * FROM {table} ORDER BY rowid"),[]).unwrap()));
    }
    for (view,key) in [("customer_credit_balances","credit_note_id"),("supplier_credit_balances","supplier_credit_note_id")] {
        data.insert(view.into(),json!(crate::database::query_all(&connection,&format!("SELECT * FROM {view} ORDER BY {key}"),[]).unwrap()));
    }
    json!(data)
}
fn snapshot(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();
    let mut data = json!({"finances":finances(store)});
    for table in ["attachments","audit_log","company_local_clock"] {
        data[table] = json!(crate::database::query_all(&connection,&format!("SELECT * FROM {table} ORDER BY rowid"),[]).unwrap());
    }
    let mut files = std::fs::read_dir(&store.attachments_dir).unwrap().map(|entry| {
        let entry=entry.unwrap();(entry.file_name().to_string_lossy().to_string(),std::fs::read(entry.path()).unwrap())
    }).collect::<Vec<_>>();
    files.sort_by(|left,right|left.0.cmp(&right.0));
    data["files"] = json!(files);
    data
}
fn assert_receipt(store: &LocalStore, row: &Value, kind: Kind, id: &str, project: &str) {
    assert_eq!(row["entity_type"],entity_type(kind));
    assert_eq!(row["entity_id"],id);
    assert_eq!(row["project_id"],project);
    assert_eq!(row["mime_type"],"image/png");
    assert_eq!(std::fs::read(store.verified_attachment_path(row["id"].as_str().unwrap()).unwrap()).unwrap(),STANDARD.decode(receipt().content_base64).unwrap());
}

#[test]
fn current_and_omitted_scope_keep_exact_receipts_deduplication_and_financial_rows() {
    for legacy in [false,true] {
        let (_temporary,store)=fixture();let events=seed(&store);
        let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let before=finances(&store);
        for kind in KINDS {
            let expected=if legacy {None} else {Some(scope(&store))};
            let first=run(app.state(),kind,events.id(kind),receipt(),expected).unwrap();
            assert_receipt(&store,&first,kind,events.id(kind),&events.project);
            assert_eq!(finances(&store),before);
            let after=snapshot(&store);
            assert_eq!(run(app.state(),kind,events.id(kind),receipt(),None).unwrap(),first);
            assert_eq!(snapshot(&store),after);
        }
        assert_eq!(store.verify_audit_log().unwrap()["valid"],true);
    }
}

#[test]
fn a_real_restore_keeps_event_uuids_but_refuses_retired_scope_even_for_existing_receipts() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_temporary,store)=fixture();let events=seed(&store);
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let mut saved=Vec::new();
    for kind in KINDS {saved.push(run(app.state(),kind,events.id(kind),receipt(),Some(scope(&store))).unwrap());}
    let origin=scope(&store);let backup=store.create_backup(None,"synthetic-attachment-scope").unwrap();
    store.restore_backup(&backup,"synthetic-attachment-scope").unwrap();assert_ne!(scope(&store),origin);
    let before=snapshot(&store);
    for (index,kind) in KINDS.into_iter().enumerate() {
        assert_receipt(&store,&saved[index],kind,events.id(kind),&events.project);
        assert!(run(app.state(),kind,events.id(kind),receipt(),Some(origin.clone())).unwrap_err().contains("L’entreprise ouverte a changé"));
        assert_eq!(snapshot(&store),before);
        assert_eq!(run(app.state(),kind,events.id(kind),receipt(),Some(scope(&store))).unwrap(),saved[index]);
        assert_eq!(run(app.state(),kind,events.id(kind),receipt(),None).unwrap(),saved[index]);
        assert_eq!(snapshot(&store),before);
    }
}

#[test]
fn commands_waiting_for_the_store_guard_validate_the_scope_after_real_restoration() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for kind in KINDS {
        let (_temporary,store)=fixture();let events=seed(&store);let id=events.id(kind).to_owned();
        let origin=scope(&store);let backup=store.create_backup(None,"synthetic-queued-attachment").unwrap();
        let restoring=store.clone();let (ready_tx,ready_rx)=mpsc::channel();let (replace_tx,replace_rx)=mpsc::channel();
        let holder=thread::spawn(move || {
            let _guard=restoring.lock().unwrap();ready_tx.send(()).unwrap();
            replace_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            restoring.restore_backup(&backup,"synthetic-queued-attachment").unwrap();
            snapshot(&restoring)
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let calling=store.clone();let captured=origin.clone();let (entered_tx,entered_rx)=mpsc::channel();let (done_tx,done_rx)=mpsc::channel();
        let command=thread::spawn(move || {
            let app=tauri::test::mock_builder().manage(calling).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
            entered_tx.send(()).unwrap();let result=run(app.state(),kind,&id,receipt(),Some(captured));done_tx.send(result).unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let waiting=matches!(done_rx.recv_timeout(Duration::from_millis(50)),Err(mpsc::RecvTimeoutError::Timeout));
        replace_tx.send(()).unwrap();let restored=holder.join().unwrap();
        let result=done_rx.recv_timeout(Duration::from_secs(5)).unwrap();command.join().unwrap();
        assert!(waiting,"the synchronous command must await the held store guard");
        assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"),"{kind:?}");
        assert_ne!(scope(&store),origin);assert_eq!(snapshot(&store),restored);
    }
}

#[test]
fn retired_scope_precedes_invalid_ids_decoding_and_license_checks_without_sql_or_files() {
    let (_temporary,store)=unlicensed_fixture();let events=seed(&store);
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let before=snapshot(&store);
    for kind in KINDS {
        let input=RefundAttachmentInput {original_name:"../invalid.png".into(),content_base64:"not-base64".into()};
        assert!(run(app.state(),kind,"invalid-id",input,Some("synthetic-retired-workspace".into())).unwrap_err().contains("L’entreprise ouverte a changé"));
        assert_eq!(snapshot(&store),before);
        assert!(run(app.state(),kind,events.id(kind),receipt(),Some(scope(&store))).unwrap_err().contains("lecture"));
        assert_eq!(snapshot(&store),before);
    }
}

#[test]
fn absent_and_read_only_licenses_still_refuse_current_and_legacy_attachment_commands() {
    let (_temporary,store)=unlicensed_fixture();let events=seed(&store);
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    for read_only in [false,true] {
        if read_only {store.install_server_issued_license(&signed_fixture_token(&store,"read_only")).unwrap();}
        let before=snapshot(&store);
        for expected in [Some(scope(&store)),None] {for kind in KINDS {
            assert!(run(app.state(),kind,events.id(kind),receipt(),expected.clone()).unwrap_err().contains("lecture"),"{read_only}/{kind:?}");
            assert_eq!(snapshot(&store),before);
        }}
    }
}

#[test]
fn late_audit_refusal_rolls_back_attachment_and_financial_state_then_retry_creates_one_file() {
    for kind in KINDS {
        let (_temporary,store)=fixture();let events=seed(&store);
        let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        store.connect().unwrap().execute_batch("CREATE TRIGGER synthetic_attachment_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='attachment_add' BEGIN SELECT RAISE(ABORT,'synthetic attachment audit refusal'); END;").unwrap();
        let before=snapshot(&store);
        assert!(run(app.state(),kind,events.id(kind),receipt(),Some(scope(&store))).unwrap_err().contains("synthetic attachment audit refusal"));
        assert_eq!(snapshot(&store),before);
        store.connect().unwrap().execute_batch("DROP TRIGGER synthetic_attachment_audit_failure;").unwrap();
        let finances_before=finances(&store);let first=run(app.state(),kind,events.id(kind),receipt(),Some(scope(&store))).unwrap();
        assert_receipt(&store,&first,kind,events.id(kind),&events.project);assert_eq!(finances(&store),finances_before);
        let after=snapshot(&store);assert_eq!(after["attachments"].as_array().unwrap().len(),1);assert_eq!(after["files"].as_array().unwrap().len(),1);
        assert_eq!(run(app.state(),kind,events.id(kind),receipt(),None).unwrap(),first);assert_eq!(snapshot(&store),after);
        assert_eq!(store.verify_audit_log().unwrap()["valid"],true);
    }
}

#[test]
fn invalid_bytes_and_missing_events_preserve_business_errors_with_no_copied_files_or_financial_writes() {
    let (_temporary,store)=fixture();let events=seed(&store);
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let before=snapshot(&store);
    for expected in [Some(scope(&store)),None] {for kind in KINDS {
        let invalid=RefundAttachmentInput {original_name:"synthetic.png".into(),content_base64:"not-base64".into()};
        assert!(run(app.state(),kind,events.id(kind),invalid,expected.clone()).unwrap_err().contains("illisible"));
        assert_eq!(snapshot(&store),before);
        assert!(run(app.state(),kind,&uuid::Uuid::new_v4().to_string(),receipt(),expected.clone()).unwrap_err().contains("introuvable"));
        assert_eq!(snapshot(&store),before);
    }}
}
