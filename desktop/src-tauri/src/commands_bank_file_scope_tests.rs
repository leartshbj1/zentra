//! Prepared native scope-entry tests only; not compiled or executed in this audit.
//! None/current intentionally reach the unchanged business refusal for a missing
//! movement. Existing bank transaction tests remain the economic/replay authority.
use super::*;
use super::import_worker_tests::{fixture,scope};
use base64::{engine::general_purpose::STANDARD,Engine};
use serde_json::json;
use std::path::Path;
use tauri::Manager;

#[derive(Clone,Copy,Debug)]
enum Operation { Expense,ExpenseRefund,SupplierCredit,CustomerCredit }

fn receipt()->crate::expense_refund_attachments::RefundAttachmentInput {
    crate::expense_refund_attachments::RefundAttachmentInput {
        original_name:"synthetic-bank-proof.pdf".into(),
        content_base64:STANDARD.encode(crate::attachments::test_pdf_bytes()),
    }
}
fn run(state:State<'_,LocalStore>,operation:Operation,expected:Option<String>)->Result<Value,String> {
    let request="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string();
    let movement="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string();
    let source="cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_string();
    match operation {
        Operation::Expense=>create_bank_expense(state,crate::models::CreateBankExpenseInput {
            request_id:request,movement_id:movement,date:"2026-09-01".into(),
            supplier:"Synthetic supplier".into(),reference:"SYN-BANK".into(),category:"Fournitures".into(),
            project_id:None,vat_cents:0,vat_treatment:"non_deductible".into(),note:String::new(),
            original_name:"synthetic-bank-proof.pdf".into(),content_base64:receipt().content_base64,
        },expected),
        Operation::ExpenseRefund=>create_bank_expense_refund(state,crate::expense_refunds::ExpenseRefundInput {
            request_id:request,expense_id:source,credit_date:"2026-09-01".into(),payment_date:"2026-09-02".into(),
            reference:"SYN-BANK".into(),reason:"Synthetic purchase return".into(),net_cents:1000,vat_cents:0,reverses_id:None,
        },movement,Some(receipt()),expected),
        Operation::SupplierCredit=>create_bank_supplier_credit_refund(state,crate::bank_import::credit_refunds::CreateInput {
            request_id:request,movement_id:movement,supplier_credit_note_id:source,reference:"SYN-BANK".into(),
            reason:"Synthetic supplier credit refund".into(),attachment:receipt(),
        },expected),
        Operation::CustomerCredit=>create_bank_customer_credit_refund(state,crate::bank_import::customer_refunds::CreateInput {
            request_id:request,movement_id:movement,customer_credit_note_id:source,expected_amount_cents:1000,
            expected_date:"2026-09-02".into(),reference:"SYN-BANK".into(),reason:"Synthetic customer credit refund".into(),attachment:Some(receipt()),
        },expected),
    }
}
fn snapshot(store:&LocalStore,attachments:&Path)->Value {
    let connection=store.connect().unwrap();let mut state=serde_json::Map::new();
    for table in ["bank_imports","bank_movements","bank_expense_reconciliations","bank_expense_refund_matches",
        "bank_supplier_credit_refund_matches","bank_customer_credit_refund_matches","expenses","expense_refunds",
        "supplier_credit_refunds","customer_credit_settlements","journal_entries","journal_lines","attachments","audit_log","company_local_clock"] {
        state.insert(table.into(),json!(crate::database::query_all(&connection,&format!("SELECT * FROM {table} ORDER BY rowid"),[]).unwrap()));
    }
    let mut files=if attachments.exists(){std::fs::read_dir(attachments).unwrap().map(|entry|{let entry=entry.unwrap();let path=entry.path();(entry.file_name().to_string_lossy().to_string(),if path.is_file(){std::fs::read(path).unwrap()}else{Vec::new()})}).collect::<Vec<_>>()}else{Vec::new()};
    files.sort_by(|a,b|a.0.cmp(&b.0));state.insert("attachment_files".into(),json!(files));json!(state)
}
fn mismatched(operation:Operation) {
    let (temporary,store)=fixture();let attachments=temporary.path().join("profile/attachments");
    let before=snapshot(&store,&attachments);let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let other=format!("{}-another-company",scope(&store));
    assert!(run(app.state(),operation,Some(other)).unwrap_err().contains("L’entreprise ouverte a changé"),"{operation:?}");
    assert_eq!(snapshot(&store,&attachments),before,"scope mismatch must stop before bank/business/file writes");
}
fn unchanged_legacy(operation:Operation) {
    let (temporary,store)=fixture();let attachments=temporary.path().join("profile/attachments");let before=snapshot(&store,&attachments);
    let app=tauri::test::mock_builder().manage(store.clone()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let legacy=run(app.state(),operation,None).unwrap_err();assert!(!legacy.contains("L’entreprise ouverte a changé"));
    let current=run(app.state(),operation,Some(scope(&store))).unwrap_err();assert_eq!(current,legacy,"scope must preserve the original missing-movement business refusal");
    assert_eq!(snapshot(&store,&attachments),before);
}
#[test]fn expense_origin_mismatch_stops_before_business_and_fs(){mismatched(Operation::Expense);}
#[test]fn expense_legacy_and_current_keep_business_contract(){unchanged_legacy(Operation::Expense);}
#[test]fn expense_refund_origin_mismatch_stops_before_business_and_fs(){mismatched(Operation::ExpenseRefund);}
#[test]fn expense_refund_legacy_and_current_keep_business_contract(){unchanged_legacy(Operation::ExpenseRefund);}
#[test]fn supplier_origin_mismatch_stops_before_business_and_fs(){mismatched(Operation::SupplierCredit);}
#[test]fn supplier_legacy_and_current_keep_business_contract(){unchanged_legacy(Operation::SupplierCredit);}
#[test]fn customer_origin_mismatch_stops_before_business_and_fs(){mismatched(Operation::CustomerCredit);}
#[test]fn customer_legacy_and_current_keep_business_contract(){unchanged_legacy(Operation::CustomerCredit);}
