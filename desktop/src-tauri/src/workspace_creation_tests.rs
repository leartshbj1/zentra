use super::*;
use pretty_assertions::assert_eq;

#[test]
fn supplied_creation_ids_are_unique_without_overwriting_records_or_audit() {
    let (_temporary, store) = initialized_store();
    for entity in ["clients", "suppliers", "employees", "catalog_items"] {
        let id = uuid::Uuid::new_v4().to_string();
        let mut input = json!({"id":id,"name":"Saisie initiale"});
        if entity == "catalog_items" { input["kind"] = json!("product"); }
        let created = store.create_record(entity, input.clone()).unwrap();
        assert_eq!(created["id"], id);
        assert!(store.create_record(entity, input.clone()).is_err());
        input["name"] = json!("Autre saisie");
        assert!(store.create_record(entity, input).is_err());
        let workspace = store.get_workspace().unwrap();
        let rows: Vec<_> = workspace[entity].as_array().unwrap().iter().filter(|row| row["id"] == id).collect();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "Saisie initiale");
        let connection = store.connect().unwrap();
        let creates: i64 = connection.query_row("SELECT COUNT(*) FROM audit_log WHERE action='create' AND entity_type=?1 AND entity_id=?2", rusqlite::params![entity, id], |row| row.get(0)).unwrap();
        assert_eq!(creates, 1);
    }
}

#[test]
fn supplied_expense_id_preserves_one_payment_and_rejected_creation_is_absent() {
    let (_temporary, store) = initialized_store();
    let accounts = enable_accounting(&store);
    let id = uuid::Uuid::new_v4().to_string();
    let input = json!({"id":id,"date":"2026-10-01","supplier":"Fournisseur de recette","net_cents":10000,"vat_cents":810,"payment_status":"paid","paid_at":"2026-10-01"});
    store.create_record("expenses", input.clone()).unwrap();
    assert!(store.create_record("expenses", input).is_err());
    let connection = store.connect().unwrap();
    let (rows, entries, bank_credit, creates): (i64,i64,i64,i64) = connection.query_row(
        "SELECT (SELECT COUNT(*) FROM expenses WHERE id=?1),
        (SELECT COUNT(*) FROM journal_entries WHERE source_type='expense' AND source_id=?1),
        (SELECT COALESCE(SUM(jl.credit_cents),0) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE je.source_type='expense' AND je.source_id=?1 AND jl.account_id=?2),
        (SELECT COUNT(*) FROM audit_log WHERE action='create' AND entity_type='expenses' AND entity_id=?1)",
        rusqlite::params![id,accounts["bank"]], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
    assert_eq!((rows,entries,bank_credit,creates), (1,1,10810,1));
    drop(connection);
    let rejected_id = uuid::Uuid::new_v4().to_string();
    assert!(store.create_record("expenses", json!({"id":rejected_id,"date":"2026-10-01","net_cents":-1,"vat_cents":0})).is_err());
    assert!(!store.get_workspace().unwrap()["expenses"].as_array().unwrap().iter().any(|row| row["id"] == rejected_id));
}
