use serde_json::json;
use crate::models::StockEntryInput;

#[test]
fn catalog_form_update_preserves_stock_and_refuses_stale_or_invalid_edits() {
    let (_temporary, store) = initialized_store();
    let id = tracked_product(&store, "Peinture du catalogue", 0);
    let initial = store.get_workspace().unwrap()["catalog_items"][0].clone();
    store.record_stock_entry(StockEntryInput { request_id: uuid::Uuid::new_v4().to_string(), catalog_item_id: id.clone(), quantity_milli: 8125, reason: "Stock de départ".into(), reference: None, date: None }).unwrap();
    let before = store.get_workspace().unwrap();
    let version = before["catalog_items"][0]["updated_at"].as_str().unwrap();
    assert!(store.update_catalog_item(&id, json!({"name":"Ancienne version"}), initial["updated_at"].as_str().unwrap()).unwrap_err().to_string().contains("a changé"));
    assert!(store.update_catalog_item(&id, json!({"name":"Sans version"}), "").is_err());
    assert!(store.update_catalog_item(&id, json!({"name":"Prix invalide","sales_price_cents":-1}), version).is_err());
    assert!(store.update_catalog_item(&id, json!({"kind":"service","track_stock":false}), version).is_err());
    let unchanged = store.get_workspace().unwrap();
    assert_eq!(unchanged["catalog_items"], before["catalog_items"]);
    assert_eq!(unchanged["stock_movements"], before["stock_movements"]);
    let saved = store.update_catalog_item(&id, json!({"name":"Peinture blanche","sales_price_cents":8550,"purchase_cost_cents":0,"reorder_level_milli":2000,"description":"Première ligne\nDeuxième ligne"}), version).unwrap();
    assert_eq!(saved["stock_quantity_milli"], 8125);
    assert_eq!(saved["sales_price_cents"], 8550);
    assert_eq!(saved["description"], "Première ligne\nDeuxième ligne");
    assert_eq!(store.get_workspace().unwrap()["stock_movements"], before["stock_movements"]);
    assert!(store.update_catalog_item(&id, json!({"sales_price_cents":5000}), version).is_err());
    assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
}

#[test]
fn catalog_form_only_one_concurrent_editor_can_replace_a_version() {
    let (_temporary, store) = initialized_store();
    let id = tracked_product(&store, "Catalogue simultané", 0);
    let before = store.get_workspace().unwrap();
    let version = before["catalog_items"][0]["updated_at"].as_str().unwrap();
    let (left, right) = std::thread::scope(|scope| {
        let left = scope.spawn(|| store.update_catalog_item(&id, json!({"name":"Version A"}), version));
        let right = scope.spawn(|| store.update_catalog_item(&id, json!({"name":"Version B"}), version));
        (left.join().unwrap(), right.join().unwrap())
    });
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    assert!(left.err().or_else(||right.err()).unwrap().to_string().contains("a changé"));
    assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
}

#[test]
fn catalog_form_service_can_become_an_empty_tracked_product_and_keep_generic_updates() {
    let (_temporary, store) = initialized_store();
    let item = store.create_record("catalog_items", json!({"kind":"service","name":"Nouvelle référence","unit":"heure","sales_price_cents":0})).unwrap();
    let id = value_id(&item);
    let changed = store.update_catalog_item(&id, json!({"kind":"product","track_stock":true,"unit":"pièce","reorder_level_milli":0}), item["updated_at"].as_str().unwrap()).unwrap();
    assert_eq!(changed["stock_quantity_milli"], 0);
    let archived = store.update_record("catalog_items", &id, json!({"archived_at":"2026-09-13T12:00:00Z"})).unwrap();
    assert!(store.update_catalog_item(&id, json!({"name":"Ancien nom"}), changed["updated_at"].as_str().unwrap()).is_err());
    let saved = store.update_catalog_item(&id, json!({"name":"Fiche historique"}), archived["updated_at"].as_str().unwrap()).unwrap();
    assert_eq!(saved["archived_at"], "2026-09-13T12:00:00Z");
    assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
}
