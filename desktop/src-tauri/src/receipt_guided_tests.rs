use crate::{database::LocalStore, models::*};
use serde_json::json;

fn order(store: &LocalStore) -> (String, String, String) {
    let supplier = value_id(
        &store
            .create_record("suppliers", json!({"name":"Fournisseur guidé"}))
            .unwrap(),
    );
    let product = tracked_product(store, "Peinture", 0);
    let id = uuid::Uuid::new_v4().to_string();
    let saved=store.save_supplier_order_draft(serde_json::from_value(json!({"order":{"id":id,"supplier_id":supplier,"title":"Peinture livrée","order_date":"2026-01-01","currency":"CHF"},"lines":[{"catalog_item_id":product,"position":0,"description":"Peinture","quantity_milli":10000,"unit":"litre","unit_price_cents":500,"discount_bp":0,"vat_bp":0,"category":"Marchandises","fulfillment_mode":"stocked_receipt"}]})).unwrap()).unwrap();
    store
        .confirm_supplier_order(ConfirmSupplierOrderInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_order_id: id.clone(),
        })
        .unwrap();
    (
        id,
        saved["lines"][0]["id"].as_str().unwrap().into(),
        product,
    )
}
fn draft(order: &str, line: &str, quantity: i64) -> SaveSupplierReceiptDraftInput {
    serde_json::from_value(json!({"receipt":{"id":uuid::Uuid::new_v4().to_string(),"supplier_order_id":order,"receipt_date":"2026-09-02","reference":"BL-01","notes":"Premier colis\nContrôle effectué"},"lines":[{"supplier_order_line_id":line,"quantity_milli":quantity}]})).unwrap()
}
#[test]
fn receipt_guided_invalid_dates_and_versions_leave_the_draft_and_stock_unchanged() {
    let (_temp, store) = initialized_store();
    let (order, line, _) = order(&store);
    let original = draft(&order, &line, 2125);
    for date in [
        "2026-02-30".to_string(),
        "2026-1-2".to_string(),
        "2025-12-31".to_string(),
        (chrono::Local::now().date_naive() + chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string(),
    ] {
        let mut bad = original.clone();
        bad.receipt.receipt_date = date;
        assert!(store
            .save_supplier_receipt_draft_checked(bad, None)
            .is_err());
    }
    assert!(store.get_workspace().unwrap()["supplier_receipts"]
        .as_array()
        .unwrap()
        .is_empty());
    let saved = store
        .save_supplier_receipt_draft_checked(original.clone(), None)
        .unwrap();
    let before = store.get_workspace().unwrap();
    for version in ["", "old"] {
        assert!(store
            .save_supplier_receipt_draft_checked(original.clone(), Some(version))
            .is_err());
    }
    let after = store.get_workspace().unwrap();
    for key in [
        "supplier_receipts",
        "supplier_receipt_lines",
        "stock_movements",
    ] {
        assert_eq!(before[key], after[key]);
    }
    let version = saved["receipt"]["updated_at"].as_str().unwrap();
    let (mut left, mut right) = (original.clone(), original.clone());
    left.receipt.notes = Some("Version A".into());
    right.receipt.notes = Some("Version B".into());
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| store.save_supplier_receipt_draft_checked(left, Some(version)));
        let b = scope.spawn(|| store.save_supplier_receipt_draft_checked(right, Some(version)));
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(a
        .err()
        .or_else(|| b.err())
        .unwrap()
        .to_string()
        .contains("a changé"));
    assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
}
#[test]
fn receipt_guided_issuance_checks_preview_version_but_replay_keeps_one_stock_entry() {
    let (_temp, store) = initialized_store();
    let (order, line, _) = order(&store);
    let mut input = draft(&order, &line, 2000);
    let old = store
        .save_supplier_receipt_draft_checked(input.clone(), None)
        .unwrap();
    let old_version = old["receipt"]["updated_at"].as_str().unwrap();
    input.lines[0].quantity_milli = 3125;
    let current = store
        .save_supplier_receipt_draft_checked(input.clone(), Some(old_version))
        .unwrap();
    let issue = IssueSupplierReceiptInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        supplier_receipt_id: input.receipt.id.clone().unwrap(),
    };
    assert!(store
        .issue_supplier_receipt_checked(issue.clone(), Some(old_version))
        .unwrap_err()
        .to_string()
        .contains("a changé"));
    assert!(store.get_workspace().unwrap()["stock_movements"]
        .as_array()
        .unwrap()
        .is_empty());
    store
        .issue_supplier_receipt_checked(issue.clone(), current["receipt"]["updated_at"].as_str())
        .unwrap();
    assert_eq!(
        store
            .issue_supplier_receipt_checked(issue, Some(old_version))
            .unwrap()["idempotent"],
        true
    );
    let result = store.get_workspace().unwrap();
    assert_eq!(result["stock_movements"].as_array().unwrap().len(), 1);
    assert_eq!(result["catalog_items"][0]["stock_quantity_milli"], 3125);
}
#[test]
fn receipt_guided_competing_drafts_cannot_overreceive_and_reversal_reopens_quantity() {
    let (_temp, store) = initialized_store();
    let (order, line, _) = order(&store);
    let first = draft(&order, &line, 6000);
    let second = draft(&order, &line, 6000);
    let a = store
        .save_supplier_receipt_draft_checked(first.clone(), None)
        .unwrap();
    let b = store
        .save_supplier_receipt_draft_checked(second.clone(), None)
        .unwrap();
    let issue = |id: String| IssueSupplierReceiptInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        supplier_receipt_id: id,
    };
    store
        .issue_supplier_receipt_checked(
            issue(first.receipt.id.clone().unwrap()),
            a["receipt"]["updated_at"].as_str(),
        )
        .unwrap();
    let before = store.get_workspace().unwrap();
    assert!(store
        .issue_supplier_receipt_checked(
            issue(second.receipt.id.clone().unwrap()),
            b["receipt"]["updated_at"].as_str()
        )
        .is_err());
    let after = store.get_workspace().unwrap();
    for key in ["supplier_receipts", "stock_movements", "catalog_items"] {
        assert_eq!(before[key], after[key]);
    }
    let reverse = ReverseSupplierReceiptInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        supplier_receipt_id: first.receipt.id.unwrap(),
        reason: "Retour".into(),
    };
    store.reverse_supplier_receipt(reverse.clone()).unwrap();
    assert_eq!(
        store.reverse_supplier_receipt(reverse).unwrap()["idempotent"],
        true
    );
    store
        .issue_supplier_receipt_checked(
            issue(second.receipt.id.unwrap()),
            b["receipt"]["updated_at"].as_str(),
        )
        .unwrap();
    let final_state = store.get_workspace().unwrap();
    assert_eq!(
        final_state["catalog_items"][0]["stock_quantity_milli"],
        6000
    );
    assert_eq!(final_state["stock_movements"].as_array().unwrap().len(), 3);
    assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
}
