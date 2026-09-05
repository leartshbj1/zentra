use super::*;
use crate::models::SupplierCreditAllocationInput;
use pretty_assertions::assert_eq;

fn fixture() -> (
    tempfile::TempDir,
    LocalStore,
    String,
    SaveSupplierCreditNoteDraftInput,
) {
    let (temporary, store) = initialized_store();
    enable_accounting(&store);
    let supplier = value_id(
        &store
            .create_record("suppliers", json!({"name":"Compensations datées SA"}))
            .unwrap(),
    );
    let invoice = uuid::Uuid::new_v4().to_string();
    let item = json!({"description":"Marchandises", "quantity_milli":1000, "unit_price_cents":10000, "vat_bp":0, "category":"Marchandises"});
    store.save_supplier_invoice_draft(serde_json::from_value(json!({"id":invoice,"supplier_id":supplier,"date":"2026-05-01","due_date":"2026-05-31","reference":"FA-DATES","items":[item]})).unwrap()).unwrap();
    store.validate_supplier_invoice(&invoice).unwrap();
    let mut credit_item = item;
    credit_item["unit_price_cents"] = json!(2000);
    let draft: SaveSupplierCreditNoteDraftInput = serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"supplier_id":supplier,"document_date":"2026-05-10","reference":"AV-DATES","items":[credit_item],"allocations":[]})).unwrap();
    (temporary, store, invoice, draft)
}

fn validate(store: &LocalStore, draft: &SaveSupplierCreditNoteDraftInput) {
    store
        .save_supplier_credit_note_draft(draft.clone())
        .unwrap();
    store
        .validate_supplier_credit_note(ValidateSupplierCreditNoteInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_credit_note_id: draft.id.clone().unwrap(),
        })
        .unwrap();
}

#[test]
fn supplier_credit_settlement_dates_are_atomic_immutable_and_replayable_after_closing() {
    let (_temporary, store, invoice, draft) = fixture();
    validate(&store, &draft);
    let apply = ApplySupplierCreditInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        supplier_credit_note_id: draft.id.unwrap(),
        supplier_invoice_id: invoice.clone(),
        amount_cents: 1000,
        effective_date: "2026-05-15".into(),
    };
    for date in ["", "2026-02-30", "2026-5-15", "2026-05-09", "2099-01-01"] {
        let mut rejected = apply.clone();
        rejected.effective_date = date.into();
        assert!(store.apply_supplier_credit(rejected).is_err(), "{date}");
    }
    let before = store.get_workspace().unwrap();
    assert_eq!(before["supplier_invoices"][0]["credited_cents"], 0);
    assert_eq!(
        before["supplier_credit_allocations"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let result = store.apply_supplier_credit(apply.clone()).unwrap();
    let id = result["allocation"]["id"].as_str().unwrap().to_owned();
    assert_eq!(result["allocation"]["effective_date"], "2026-05-15");
    let mut changed = apply.clone();
    changed.effective_date = "2026-05-16".into();
    assert!(
        store.apply_supplier_credit(changed).is_err(),
        "the date is part of the idempotence proof"
    );
    let mut reversal = ReverseSupplierCreditAllocationInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        supplier_credit_allocation_id: id.clone(),
        reason: "Compensation annulée".into(),
        effective_date: "2026-05-14".into(),
    };
    assert!(store
        .reverse_supplier_credit_allocation(reversal.clone())
        .is_err());
    let connection = store.connect().unwrap();
    assert!(connection
        .execute(
            "UPDATE supplier_credit_allocations SET effective_date='2026-05-16' WHERE id=?",
            rusqlite::params![id]
        )
        .is_err());
    assert!(connection.execute("INSERT INTO supplier_credit_allocations(id,request_id,supplier_credit_note_id,supplier_invoice_id,amount_cents,created_at) VALUES(?1,?2,?3,?4,1,?5)", rusqlite::params![uuid::Uuid::new_v4().to_string(),uuid::Uuid::new_v4().to_string(),apply.supplier_credit_note_id,invoice,now_iso()]).is_err());
    drop(connection);
    let period = value_id(
        &store
            .upsert_accounting_period(AccountingPeriodInput {
                id: None,
                name: "Mai".into(),
                date_from: "2026-05-01".into(),
                date_to: "2026-05-31".into(),
            })
            .unwrap(),
    );
    store.close_accounting_period(&period).unwrap();
    assert_eq!(
        store.apply_supplier_credit(apply.clone()).unwrap()["idempotent"],
        true
    );
    reversal.effective_date = "2026-05-30".into();
    assert!(store
        .reverse_supplier_credit_allocation(reversal.clone())
        .is_err());
    let mut closed = apply;
    closed.request_id = uuid::Uuid::new_v4().to_string();
    closed.effective_date = "2026-05-30".into();
    assert!(store.apply_supplier_credit(closed).is_err());
    reversal.effective_date = "2026-06-01".into();
    let result = store
        .reverse_supplier_credit_allocation(reversal.clone())
        .unwrap();
    assert_eq!(result["allocation"]["effective_date"], "2026-06-01");
    assert_eq!(result["invoice"]["credited_cents"], 0);
    assert_eq!(
        store.reverse_supplier_credit_allocation(reversal).unwrap()["idempotent"],
        true
    );
    assert_eq!(
        store.get_workspace().unwrap()["supplier_credit_allocations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
}

#[test]
fn supplier_credit_draft_records_a_distinct_settlement_date_and_rechecks_it_at_validation() {
    let (_temporary, store, invoice, mut draft) = fixture();
    draft.allocations = vec![SupplierCreditAllocationInput {
        supplier_invoice_id: invoice,
        amount_cents: 1000,
        effective_date: "2026-05-09".into(),
    }];
    assert!(store
        .save_supplier_credit_note_draft(draft.clone())
        .is_err());
    draft.allocations[0].effective_date = "2026-05-15".into();
    validate(&store, &draft);
    let workspace = store.get_workspace().unwrap();
    assert_eq!(
        workspace["supplier_credit_allocations"][0]["effective_date"],
        "2026-05-15"
    );
    assert_eq!(
        workspace["supplier_credit_notes"][0]["document_date"],
        "2026-05-10"
    );
    let snapshot: serde_json::Value = serde_json::from_str(
        workspace["supplier_credit_notes"][0]["snapshot_json"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(snapshot["allocations"][0]["effective_date"], "2026-05-15");

    let (_temporary2, store2, invoice2, mut future) = fixture();
    future.allocations = vec![SupplierCreditAllocationInput {
        supplier_invoice_id: invoice2,
        amount_cents: 1000,
        effective_date: "2099-01-01".into(),
    }];
    store2
        .save_supplier_credit_note_draft(future.clone())
        .unwrap();
    assert!(store2
        .validate_supplier_credit_note(ValidateSupplierCreditNoteInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_credit_note_id: future.id.unwrap()
        })
        .is_err());
    let workspace = store2.get_workspace().unwrap();
    assert_eq!(workspace["supplier_credit_notes"][0]["status"], "draft");
    assert_eq!(workspace["supplier_invoices"][0]["credited_cents"], 0);
}

#[test]
fn supplier_credit_v42_migration_preserves_legacy_rows_without_inventing_settlement_dates() {
    let (_temporary, store, invoice, draft) = fixture();
    validate(&store, &draft);
    let legacy_id = uuid::Uuid::new_v4().to_string();
    let connection = store.connect().unwrap();
    connection.execute_batch("DROP TRIGGER supplier_credit_allocations_date_guard; DROP TRIGGER supplier_credit_validation_settlement_date_guard; DROP INDEX idx_supplier_credit_allocations_effective_date; ALTER TABLE supplier_credit_allocations DROP COLUMN effective_date; PRAGMA user_version=42;").unwrap();
    connection.execute("INSERT INTO supplier_credit_allocations(id,request_id,supplier_credit_note_id,supplier_invoice_id,amount_cents,created_at) VALUES(?1,?2,?3,?4,500,'2026-05-15T12:00:00Z')", rusqlite::params![legacy_id,uuid::Uuid::new_v4().to_string(),draft.id.unwrap(),invoice]).unwrap();
    drop(connection);
    store.migrate().unwrap();
    store.migrate().unwrap();
    let workspace = store.get_workspace().unwrap();
    assert_eq!(workspace["supplier_credit_allocations"][0]["id"], legacy_id);
    assert!(workspace["supplier_credit_allocations"][0]["effective_date"].is_null());
    assert_eq!(
        workspace["supplier_credit_allocations"][0]["created_at"],
        "2026-05-15T12:00:00Z"
    );
    assert_eq!(workspace["supplier_invoices"][0]["credited_cents"], 500);
    let connection = store.connect().unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        crate::schema::SCHEMA_VERSION
    );
    assert_eq!(
        connection
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert!(!connection
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
}
