// Synthetic LocalStore regressions for invoice metadata customization.
// Intended as a child module of lib.rs::tests, using its existing fixtures.
use super::{create_billable_time, initialized_store, time_billing_fixture, time_billing_input};
use crate::database::{query_all, LocalStore};
use crate::models::SaveDocumentWithItemsInput;
use serde_json::{json, Value};

fn prepared_time_invoice() -> (tempfile::TempDir, LocalStore, String, String, String, String, Value) {
    let (temporary, store) = initialized_store();
    let (_client, project, employee) = time_billing_fixture(&store);
    let entry = create_billable_time(&store, &project, &employee, "2026-09-01", 61, 10_001);
    let request = uuid::Uuid::new_v4().to_string();
    let created = store.create_invoice_from_time_entries(time_billing_input(&request, &project, vec![entry.clone()])).unwrap();
    let invoice = created["invoice"]["id"].as_str().unwrap().to_owned();
    (temporary, store, project, entry, request, invoice, created)
}

fn reserved_snapshot(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();
    let mut snapshot = serde_json::Map::new();
    for table in ["invoice_items", "time_entries", "time_billing_batches", "time_billing_entries"] {
        snapshot.insert(table.into(), json!(query_all(&connection, &format!("SELECT * FROM {table} ORDER BY rowid"), []).unwrap()));
    }
    Value::Object(snapshot)
}

fn invoice(store: &LocalStore, id: &str) -> Value {
    query_all(&store.connect().unwrap(), "SELECT * FROM invoices WHERE id=?", rusqlite::params![id]).unwrap().into_iter().next().unwrap()
}

fn audits(store: &LocalStore) -> Value {
    json!(query_all(&store.connect().unwrap(), "SELECT * FROM audit_log ORDER BY rowid", []).unwrap())
}

fn items_for_full_save(created: &Value) -> Vec<Value> {
    created["items"].as_array().unwrap().iter().map(|item| json!({
        "id": item["id"], "catalog_item_id": item["catalog_item_id"],
        "description": item["description"], "quantity": item["quantity"], "unit": item["unit"],
        "unit_price_cents": item["unit_price_cents"], "discount_bp": item["discount_bp"], "vat_bp": item["vat_bp"]
    })).collect()
}

#[test]
fn full_save_of_unchanged_time_lines_refuses_and_rolls_back_personalization() {
    let (_temporary, store, _project, _entry, _request, id, created) = prepared_time_invoice();
    let before_header = invoice(&store, &id);
    let before_reserved = reserved_snapshot(&store);
    let before_audit = audits(&store);
    let reason = store.save_document_with_items(SaveDocumentWithItemsInput {
        entity: "invoices".into(), id: Some(id.clone()),
        data: json!({"title":"Titre personnalisé", "notes":"Notes personnalisées", "terms":"Conditions personnalisées"}),
        items: items_for_full_save(&created),
    }).unwrap_err();
    assert!(reason.to_string().contains("time billing invoice lines are immutable"));
    assert_eq!(invoice(&store, &id), before_header);
    assert_eq!(reserved_snapshot(&store), before_reserved);
    assert_eq!(audits(&store), before_audit);
}

#[test]
fn metadata_patch_preserves_time_reservations_amounts_and_exact_request_replay() {
    let (_temporary, store, project, entry, request, id, _created) = prepared_time_invoice();
    let before = invoice(&store, &id);
    let reserved = reserved_snapshot(&store);
    let audit_before = audits(&store).as_array().unwrap().len();
    let updated = store.update_record("invoices", &id, json!({
        "title":"Titre personnalisé", "notes":"Notes personnalisées\nDeuxième paragraphe",
        "terms":"Conditions personnalisées", "issue_date":"2026-09-05", "due_date":"2026-10-05"
    })).unwrap();
    assert_eq!(updated["title"], "Titre personnalisé");
    assert_eq!(updated["notes"], "Notes personnalisées\nDeuxième paragraphe");
    assert_eq!(updated["terms"], "Conditions personnalisées");
    assert_eq!(updated["issue_date"], "2026-09-05");
    assert_eq!(updated["due_date"], "2026-10-05");
    for field in ["client_id", "project_id", "quote_id", "original_invoice_id", "type", "currency", "service_date_from", "service_date_to", "subtotal_cents", "discount_cents", "vat_cents", "total_cents", "paid_cents", "number", "status"] {
        assert_eq!(updated[field], before[field], "reserved invoice field {field}");
    }
    assert_eq!(reserved_snapshot(&store), reserved);
    assert_eq!(audits(&store).as_array().unwrap().len(), audit_before + 1);
    let audit_after = audits(&store);
    let replay = store.create_invoice_from_time_entries(time_billing_input(&request, &project, vec![entry])).unwrap();
    assert_eq!(replay["idempotent"], true);
    assert_eq!(replay["invoice"]["id"], id);
    assert_eq!(replay["invoice"]["title"], "Titre personnalisé");
    assert_eq!(reserved_snapshot(&store), reserved);
    assert_eq!(audits(&store), audit_after);
}

#[test]
fn metadata_audit_failure_rolls_back_without_unlocking_reserved_time() {
    let (_temporary, store, _project, _entry, _request, id, _created) = prepared_time_invoice();
    let before = invoice(&store, &id);
    let reserved = reserved_snapshot(&store);
    let audit_before = audits(&store);
    store.connect().unwrap().execute_batch("CREATE TRIGGER synthetic_fail_metadata_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic metadata audit refusal'); END;").unwrap();
    let reason = store.update_record("invoices", &id, json!({"title":"Texte non confirmé", "notes":"Texte non confirmé", "terms":"Texte non confirmé", "issue_date":"2026-09-05", "due_date":"2026-10-05"})).unwrap_err();
    assert!(reason.to_string().contains("synthetic metadata audit refusal"));
    assert_eq!(invoice(&store, &id), before);
    assert_eq!(reserved_snapshot(&store), reserved);
    assert_eq!(audits(&store), audit_before);
    store.connect().unwrap().execute_batch("DROP TRIGGER synthetic_fail_metadata_audit").unwrap();
    store.update_record("invoices", &id, json!({"title":"Texte confirmé"})).unwrap();
    assert_eq!(invoice(&store, &id)["title"], "Texte confirmé");
    assert_eq!(reserved_snapshot(&store), reserved);
}

#[test]
fn issue_date_rules_and_issued_lock_stay_active_and_other_drafts_keep_full_save() {
    let (_temporary, store, _project, _entry, _request, id, created) = prepared_time_invoice();
    store.update_record("invoices", &id, json!({"title":"Titre avant émission", "notes":"Notes avant émission", "terms":"Pied avant émission", "issue_date":"2026-09-05", "due_date":"2026-10-05"})).unwrap();
    let before_invalid_issue = invoice(&store, &id);
    let before_audit = audits(&store);
    assert!(store.issue_invoice(&id, Some("2026-09-05".into()), Some("2026-09-04".into())).is_err());
    assert_eq!(invoice(&store, &id), before_invalid_issue);
    assert_eq!(audits(&store), before_audit);
    let issued = store.issue_invoice(&id, Some("2026-09-05".into()), Some("2026-10-05".into())).unwrap();
    assert_eq!(issued["status"], "emise");
    assert_eq!(issued["title"], "Titre avant émission");
    let after_issue = invoice(&store, &id);
    let reserved = reserved_snapshot(&store);
    let audit_after = audits(&store);
    assert!(store.update_record("invoices", &id, json!({"title":"Modification après émission"})).is_err());
    assert_eq!(invoice(&store, &id), after_issue);
    assert_eq!(reserved_snapshot(&store), reserved);
    assert_eq!(audits(&store), audit_after);

    let ordinary_items = items_for_full_save(&created).into_iter().map(|mut line| {
        line["id"] = json!(uuid::Uuid::new_v4().to_string()); line["quantity"] = json!(1); line
    }).collect();
    let ordinary = store.save_document_with_items(SaveDocumentWithItemsInput {
        entity: "invoices".into(), id: None,
        data: json!({"title":"Facture ordinaire", "client_id":created["invoice"]["client_id"], "project_id":created["invoice"]["project_id"], "type":"standard", "status":"brouillon", "currency":"CHF", "issue_date":"2026-09-05", "due_date":"2026-10-05", "service_date_from":"2026-09-01", "service_date_to":"2026-09-01"}),
        items: ordinary_items,
    }).unwrap();
    let ordinary_id = ordinary["document"]["id"].as_str().unwrap().to_owned();
    let mut replacement = ordinary["items"][0].clone();
    replacement.as_object_mut().unwrap().retain(|key, _| ["id", "catalog_item_id", "description", "quantity", "unit", "unit_price_cents", "discount_bp", "vat_bp"].contains(&key.as_str()));
    replacement["quantity"] = json!(2);
    let saved = store.save_document_with_items(SaveDocumentWithItemsInput {
        entity: "invoices".into(), id: Some(ordinary_id), data: json!({"title":"Facture ordinaire modifiée"}), items: vec![replacement],
    }).unwrap();
    assert_eq!(saved["document"]["title"], "Facture ordinaire modifiée");
    assert_eq!(saved["items"][0]["quantity"], 2.0);
}
