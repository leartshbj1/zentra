//! Real payment-form IPCs in temporary stores with a signed synthetic licence.
//! Include as commands::payment_forms_scope_tests; no network or transfer of funds.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use crate::customer_credit_settlements::{
    CustomerCreditSettlementInput, CustomerSettlementReview, ReverseCustomerCreditSettlementInput,
};
use crate::expense_refunds::ExpenseRefundInput;
use serde_json::json;
use tauri::Manager;

struct Inputs {
    expense: ExpenseRefundInput,
    customer: CustomerCreditSettlementInput,
    reverse: ReverseCustomerCreditSettlementInput,
    review: CustomerSettlementReview,
    original_settlement: Value,
}

#[derive(Clone, Copy, Debug)]
enum Operation { Expense, Customer, Reverse }

fn run(state: State<'_,LocalStore>,operation:Operation,inputs:&Inputs,expected:Option<String>) -> Result<Value,String> {
    match operation {
        Operation::Expense => record_expense_refund(state,inputs.expense.clone(),None,expected),
        Operation::Customer => record_customer_credit_settlement(state,inputs.customer.clone(),Some(inputs.review.clone()),expected),
        Operation::Reverse => reverse_customer_credit_settlement(state,inputs.reverse.clone(),Some(inputs.review.clone()),expected),
    }
}

fn document(store: &LocalStore, client: &str, original: Option<&str>, amount: i64) -> String {
    let invoice = store.create_record("invoices", json!({
        "client_id":client,"title":"Synthetic scope receipt",
        "type":if original.is_some(){"credit_note"}else{"standard"},
        "original_invoice_id":original,
        "service_date_from":"2026-02-01","service_date_to":"2026-02-01"
    })).unwrap()["id"].as_str().unwrap().to_owned();
    store.create_record("invoice_items", json!({
        "invoice_id":invoice,"description":"Synthetic service","quantity":1,
        "unit":"forfait","unit_price_cents":amount,"vat_bp":0
    })).unwrap();
    invoice
}

fn seed(store: &LocalStore) -> Inputs {
    let accounts = crate::tests::enable_accounting(store);
    let expense = store.create_record("expenses", json!({
        "date":"2026-02-10","paid_at":"2026-02-10","payment_status":"paid",
        "supplier":"Synthetic supplier","reference":"SYN-EXP","net_cents":10000,"vat_cents":0
    })).unwrap()["id"].as_str().unwrap().to_owned();
    let client = store.create_record("clients", json!({
        "name":"Synthetic client","address_line1":"Rue synthétique","address_line2":"1",
        "postal_code":"1000","city":"Lausanne","country":"CH"
    })).unwrap()["id"].as_str().unwrap().to_owned();
    let sale = document(store, &client, None, 10000);
    store.issue_invoice(&sale, Some("2026-02-01".into()), None).unwrap();
    store.record_payment(crate::models::RecordPaymentInput {
        request_id:uuid::Uuid::new_v4().to_string(),invoice_id:sale.clone(),amount_cents:10000,
        date:Some("2026-02-15".into()),method:Some("bank".into()),reference:None,notes:None
    }).unwrap();
    let credit = document(store, &client, Some(&sale), 5000);
    store.issue_invoice(&credit, Some("2026-03-01".into()), None).unwrap();
    let customer = CustomerCreditSettlementInput {
        request_id:uuid::Uuid::new_v4().to_string(),credit_note_id:credit,event_type:"refund".into(),
        invoice_id:None,date:"2026-04-01".into(),amount_cents:1000,
        bank_account_id:Some(accounts["bank"].clone()),reference:"SYN-NEW-REFUND".into(),
        reason:"Synthetic recorded bank refund".into()
    };
    let mut original = customer.clone();
    original.request_id = uuid::Uuid::new_v4().to_string();
    original.reference = "SYN-ORIGINAL-REFUND".into();
    let original_settlement = store.record_customer_credit_settlement(original).unwrap()["settlement"].clone();
    Inputs {
        expense:ExpenseRefundInput {
            request_id:uuid::Uuid::new_v4().to_string(),expense_id:expense,
            credit_date:"2026-04-20".into(),payment_date:"2026-07-05".into(),
            reference:"SYN-SUPPLIER-CREDIT".into(),reason:"Synthetic return of purchased goods".into(),
            net_cents:5000,vat_cents:0,reverses_id:None
        },
        reverse:ReverseCustomerCreditSettlementInput {
            request_id:uuid::Uuid::new_v4().to_string(),
            settlement_id:original_settlement["id"].as_str().unwrap().into(),
            date:"2026-04-02".into(),reason:"Synthetic correction of recorded refund".into()
        },
        review:CustomerSettlementReview {
            credit_available_cents:4000,invoice_balance_cents:None,
            bank_account_id:customer.bank_account_id.clone(),accounting_enabled:true
        },
        customer,original_settlement
    }
}

fn snapshot(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();
    let mut state = serde_json::Map::new();
    // Ordinary tables have rowid; views below deliberately use their public keys.
    for table in ["expenses","expense_refunds","invoices","invoice_items","payments",
        "customer_credit_documents","customer_credit_settlements","customer_credit_settlement_lines",
        "customer_credit_settlement_postings","journal_entries","journal_lines","audit_log",
        "attachments","company_local_clock"] {
        state.insert(table.into(), json!(crate::database::query_all(
            &connection,&format!("SELECT * FROM {table} ORDER BY rowid"),[]
        ).unwrap()));
    }
    state.insert("customer_credit_balances".into(),json!(crate::database::query_all(
        &connection,"SELECT * FROM customer_credit_balances ORDER BY credit_note_id",[]
    ).unwrap()));
    state.insert("workspace".into(),store.get_workspace().unwrap());
    json!(state)
}

fn receipt_id(receipt: &Value, field: &str) -> String {
    receipt[field]["id"].as_str().unwrap().into()
}

#[test]
fn current_and_legacy_expense_commands_keep_exact_replay_and_reverse_receipts() {
    for legacy in [false,true] {
    let (_temporary, store) = fixture();
    let input = seed(&store).expense;
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let expected = if legacy {None} else {Some(scope(&store))};
    let first = record_expense_refund(app.state(),input.clone(),None,expected).unwrap();
    assert_eq!(first["already_recorded"],false);
    assert_eq!(first["refund"]["total_cents"],5000);
    let after = snapshot(&store);
    let replay = record_expense_refund(app.state(),input.clone(),None,None).unwrap();
    assert_eq!(replay["refund"],first["refund"]);
    assert_eq!(replay["already_recorded"],true);
    assert_eq!(snapshot(&store),after);
    let mut changed = input.clone();
    changed.reason = "Synthetic changed request content".into();
    assert!(record_expense_refund(app.state(),changed,None,Some(scope(&store))).is_err());
    assert_eq!(snapshot(&store),after);
    let mut reversal = input;
    reversal.request_id = uuid::Uuid::new_v4().to_string();
    reversal.reverses_id = Some(receipt_id(&first,"refund"));
    reversal.credit_date = "2026-08-01".into();
    reversal.payment_date = "2026-08-01".into();
    reversal.reason = "Synthetic correction of supplier refund".into();
    let reversed = record_expense_refund(app.state(),reversal.clone(),None,None).unwrap();
    assert_eq!(reversed["refund"]["event_type"],"reverse");
    let after_reverse = snapshot(&store);
    assert_eq!(record_expense_refund(app.state(),reversal,None,Some(scope(&store))).unwrap()["refund"],reversed["refund"]);
    assert_eq!(snapshot(&store),after_reverse);
    assert_eq!(store.verify_audit_log().unwrap()["valid"],true);
    }
}

#[test]
fn current_and_legacy_customer_commands_keep_exact_receipts_and_review_replays() {
    for legacy in [false,true] {
    let (_temporary, store) = fixture();
    let inputs = seed(&store);
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let expected = if legacy {None} else {Some(scope(&store))};
    let first = record_customer_credit_settlement(app.state(),inputs.customer.clone(),Some(inputs.review.clone()),expected).unwrap();
    assert_eq!(first["idempotent"],false);
    assert_eq!(first["balance"]["remaining_cents"],3000);
    let after = snapshot(&store);
    let replay = record_customer_credit_settlement(app.state(),inputs.customer.clone(),Some(inputs.review.clone()),None).unwrap();
    assert_eq!(replay["settlement"],first["settlement"]);
    assert_eq!(replay["idempotent"],true);
    assert_eq!(snapshot(&store),after);
    let mut changed = inputs.customer;
    changed.reason = "Synthetic changed request content".into();
    assert!(record_customer_credit_settlement(app.state(),changed,Some(inputs.review),Some(scope(&store))).is_err());
    assert_eq!(snapshot(&store),after);
    assert!(crate::customer_credit_settlements::journal_proof_valid(&store.connect().unwrap(),&receipt_id(&first,"settlement")).unwrap());
    assert_eq!(store.verify_audit_log().unwrap()["valid"],true);
    }
}

#[test]
fn current_and_legacy_customer_reversals_keep_original_context_and_exact_replay() {
    for legacy in [false,true] {
    let (_temporary, store) = fixture();
    let inputs = seed(&store);
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let expected = if legacy {None} else {Some(scope(&store))};
    let first = reverse_customer_credit_settlement(app.state(),inputs.reverse.clone(),Some(inputs.review.clone()),expected).unwrap();
    assert_eq!(first["settlement"]["event_type"],"reverse_refund");
    assert_eq!(first["settlement"]["reverses_id"],inputs.original_settlement["id"]);
    assert_eq!(first["settlement"]["bank_account_id"],inputs.original_settlement["bank_account_id"]);
    assert_eq!(first["settlement"]["amount_cents"],inputs.original_settlement["amount_cents"]);
    assert_eq!(first["balance"]["remaining_cents"],5000);
    let after = snapshot(&store);
    let replay = reverse_customer_credit_settlement(app.state(),inputs.reverse,Some(inputs.review),None).unwrap();
    assert_eq!(replay["settlement"],first["settlement"]);
    assert_eq!(replay["idempotent"],true);
    assert_eq!(snapshot(&store),after);
    let saved = crate::database::query_all(&store.connect().unwrap(),
        "SELECT * FROM customer_credit_settlements WHERE id=?",[inputs.original_settlement["id"].as_str().unwrap()]).unwrap();
    let mut original = inputs.original_settlement;
    // Receipts enrich the event with the journal ID; the base immutable row does not.
    original.as_object_mut().unwrap().remove("journal_entry_id");
    assert_eq!(saved,vec![original]);
    assert!(crate::customer_credit_settlements::journal_proof_valid(&store.connect().unwrap(),&receipt_id(&first,"settlement")).unwrap());
    }
}

#[test]
fn all_three_scoped_commands_refuse_a_real_restore_with_the_same_document_and_event_uuids() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_temporary, store) = fixture();
    let inputs = seed(&store);
    let origin = scope(&store);
    let backup = store.create_backup(None,"synthetic-payment-scope").unwrap();
    store.restore_backup(&backup,"synthetic-payment-scope").unwrap();
    assert_ne!(scope(&store),origin);
    let before = snapshot(&store);
    assert!(before["expenses"].as_array().unwrap().iter().any(|row|row["id"]==inputs.expense.expense_id));
    assert!(before["invoices"].as_array().unwrap().iter().any(|row|row["id"]==inputs.customer.credit_note_id));
    assert!(before["customer_credit_settlements"].as_array().unwrap().iter().any(|row|row["id"]==inputs.reverse.settlement_id));
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    for operation in [Operation::Expense,Operation::Customer,Operation::Reverse] {
        assert!(run(app.state(),operation,&inputs,Some(origin.clone())).unwrap_err().contains("L’entreprise ouverte a changé"),"{operation:?}");
        assert_eq!(snapshot(&store),before,"{operation:?}");
    }
    // Scoped identity is not an economic review: both legitimate requests still
    // reach their unchanged business contracts when the new identity is supplied.
    assert_eq!(record_expense_refund(app.state(),inputs.expense,None,Some(scope(&store))).unwrap()["already_recorded"],false);
    assert_eq!(reverse_customer_credit_settlement(app.state(),inputs.reverse,Some(inputs.review),Some(scope(&store))).unwrap()["balance"]["remaining_cents"],5000);
}

#[test]
fn scope_refusal_precedes_invalid_input_and_receipt_decoding_without_file_or_sql_writes() {
    let (_temporary, store) = fixture();
    let inputs = seed(&store);
    let before = snapshot(&store);
    let files = std::fs::read_dir(&store.attachments_dir).unwrap().count();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let wrong = Some("synthetic-retired-workspace".into());
    let mut expense = inputs.expense;
    expense.request_id = "invalid".into();
    let attachment = crate::expense_refund_attachments::RefundAttachmentInput {
        original_name:"../invalid.pdf".into(),content_base64:"not-base64".into()
    };
    assert!(record_expense_refund(app.state(),expense,Some(attachment),wrong.clone()).unwrap_err().contains("L’entreprise ouverte a changé"));
    let mut customer = inputs.customer;
    customer.request_id = "invalid".into();
    assert!(record_customer_credit_settlement(app.state(),customer,None,wrong.clone()).unwrap_err().contains("L’entreprise ouverte a changé"));
    let mut reverse = inputs.reverse;
    reverse.request_id = "invalid".into();
    assert!(reverse_customer_credit_settlement(app.state(),reverse,None,wrong).unwrap_err().contains("L’entreprise ouverte a changé"));
    assert_eq!(snapshot(&store),before);
    assert_eq!(std::fs::read_dir(&store.attachments_dir).unwrap().count(),files);
}

#[test]
fn missing_and_read_only_licenses_still_refuse_all_three_current_and_legacy_commands() {
    let (_temporary, store) = unlicensed_fixture();
    let inputs = seed(&store);
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    for read_only in [false,true] {
        if read_only {store.install_server_issued_license(&signed_fixture_token(&store,"read_only")).unwrap();}
        let before = snapshot(&store);
        for expected in [Some(scope(&store)),None] {
            for operation in [Operation::Expense,Operation::Customer,Operation::Reverse] {
                assert!(run(app.state(),operation,&inputs,expected.clone()).unwrap_err().contains("lecture"),"{read_only}/{operation:?}");
                assert_eq!(snapshot(&store),before,"{read_only}/{operation:?}");
            }
        }
    }
}

#[test]
fn current_workspace_does_not_bypass_changed_customer_review_or_invalid_reversal_context() {
    let (_temporary, store) = fixture();
    let inputs = seed(&store);
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let before = snapshot(&store);
    let mut changed_review = inputs.review.clone();
    changed_review.credit_available_cents -= 1;
    for result in [
        record_customer_credit_settlement(app.state(),inputs.customer.clone(),Some(changed_review.clone()),Some(scope(&store))),
        reverse_customer_credit_settlement(app.state(),inputs.reverse.clone(),Some(changed_review),Some(scope(&store)))
    ] {
        assert!(result.unwrap_err().contains("changé depuis"));
        assert_eq!(snapshot(&store),before);
    }
    let mut invalid = inputs.reverse;
    invalid.settlement_id = uuid::Uuid::new_v4().to_string();
    assert!(reverse_customer_credit_settlement(app.state(),invalid,Some(inputs.review),Some(scope(&store))).is_err());
    assert_eq!(snapshot(&store),before);
}
