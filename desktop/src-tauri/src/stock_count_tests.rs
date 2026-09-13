use crate::{database::LocalStore,models::{StockCountInput,StockEntryInput,StockExitInput,ConfirmSalesOrderInput}};
use serde_json::json;

fn count_input(id: &str, expected: i64, counted: i64) -> StockCountInput {
    StockCountInput { request_id:uuid::Uuid::new_v4().to_string(), catalog_item_id:id.into(), expected_quantity_milli:expected, counted_quantity_milli:counted, reason:"Inventaire contrôlé".into(), reference:Some("INV-2026".into()), date:Some("2026-09-13".into()) }
}
fn opening(store: &LocalStore, id: &str, quantity: i64) {
    store.record_stock_entry(StockEntryInput {request_id:uuid::Uuid::new_v4().to_string(),catalog_item_id:id.into(),quantity_milli:quantity,reason:"Stock initial".into(),reference:None,date:Some("2026-09-01".into())}).unwrap();
}

#[test]
fn stock_count_exact_quantity_replays_after_restart_without_another_write() {
    let (temporary, store)=initialized_store();
    let item=tracked_product(&store,"Produit compté",0); opening(&store,&item,10_000);
    let input=count_input(&item,10_000,8_125);
    let first=store.record_stock_count(input.clone()).unwrap();
    assert_eq!(first["movement"]["quantity_delta_milli"],-1_875);
    assert_eq!(first["catalog_item"]["stock_quantity_milli"],8_125);
    let payload:serde_json::Value=serde_json::from_str(first["movement"]["request_json"].as_str().unwrap()).unwrap();
    assert_eq!(payload["expected_quantity_milli"],10_000);
    assert_eq!(payload["counted_quantity_milli"],8_125);
    opening(&store,&item,1_000);
    let restarted=LocalStore::initialize(temporary.path().join("profile")).unwrap();
    let before=restarted.get_workspace().unwrap();
    let replay=restarted.record_stock_count(input.clone()).unwrap();
    assert_eq!(replay["idempotent"],true);
    assert_eq!(replay["movement"]["id"],first["movement"]["id"]);
    assert_eq!(replay["catalog_item"]["stock_quantity_milli"],9_125);
    let mut changed=input; changed.counted_quantity_milli=8_126;
    assert!(restarted.record_stock_count(changed).unwrap_err().to_string().contains("déjà été utilisé"));
    assert_eq!(restarted.get_workspace().unwrap()["stock_movements"],before["stock_movements"]);
    assert_eq!(restarted.verify_audit_log().unwrap()["valid"],true);
}

#[test]
fn stock_count_stale_balance_and_invalid_values_leave_no_partial_write() {
    let (_temporary,store)=initialized_store(); let item=tracked_product(&store,"Inventaire refusé",0); opening(&store,&item,10_000);
    let before=store.get_workspace().unwrap();
    assert!(store.record_stock_count(count_input(&item,9_000,8_000)).unwrap_err().to_string().contains("stock a changé"));
    for (expected,counted) in [(10_000,10_000),(10_000,-1),(-1,0),(10_000,9_000_000_000_000_001)] {
        assert!(store.record_stock_count(count_input(&item,expected,counted)).is_err());
    }
    let mut invalid=count_input(&item,10_000,9_000);invalid.reason=" ".into();assert!(store.record_stock_count(invalid).is_err());
    let mut invalid=count_input(&item,10_000,9_000);invalid.date=Some("2026-02-30".into());assert!(store.record_stock_count(invalid).is_err());
    let after=store.get_workspace().unwrap();assert_eq!(before["stock_movements"],after["stock_movements"]);assert_eq!(before["catalog_items"],after["catalog_items"]);
    assert_eq!(store.record_stock_count(count_input(&item,10_000,0)).unwrap()["catalog_item"]["stock_quantity_milli"],0);
    assert_eq!(store.verify_audit_log().unwrap()["valid"],true);
}

#[test]
fn stock_count_only_one_concurrent_count_can_use_the_same_balance() {
    let (_temporary,store)=initialized_store();let item=tracked_product(&store,"Comptage simultané",0);opening(&store,&item,10_000);
    let a=count_input(&item,10_000,8_000); let b=count_input(&item,10_000,9_000);
    let (left,right)=std::thread::scope(|scope| {
        let left=scope.spawn(||store.record_stock_count(a));let right=scope.spawn(||store.record_stock_count(b));
        (left.join().unwrap(),right.join().unwrap())
    });
    assert_eq!(usize::from(left.is_ok())+usize::from(right.is_ok()),1);
    let refusal=left.err().or_else(||right.err()).unwrap();assert!(refusal.to_string().contains("stock a changé"));
    assert_eq!(store.get_workspace().unwrap()["stock_movements"].as_array().unwrap().len(),2);
    assert_eq!(store.verify_audit_log().unwrap()["valid"],true);
}

#[test]
fn stock_count_and_manual_exits_respect_current_reservations() {
    let (_temporary,store)=initialized_store();let item=tracked_product(&store,"Produit promis",0);opening(&store,&item,10_000);
    let client=value_id(&store.create_record("clients",json!({"name":"Client stock","address_line1":"Rue du Lac 1","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap());
    let order=store.save_sales_order_draft(serde_json::from_value(json!({"order":{"client_id":client,"title":"Matériel réservé","order_date":"2026-09-13","currency":"CHF"},"lines":[{"catalog_item_id":item,"position":0,"description":"Produit promis","quantity_milli":6_000,"unit":"pièce","unit_price_cents":1000,"fulfillment_mode":"stocked_delivery"}]})).unwrap()).unwrap();
    store.confirm_sales_order(ConfirmSalesOrderInput{request_id:uuid::Uuid::new_v4().to_string(),sales_order_id:order["order"]["id"].as_str().unwrap().into()}).unwrap();
    let before=store.get_workspace().unwrap();
    assert!(store.record_stock_count(count_input(&item,10_000,5_000)).unwrap_err().to_string().contains("réservée"));
    assert!(store.record_stock_exit(StockExitInput{request_id:uuid::Uuid::new_v4().to_string(),catalog_item_id:item.clone(),quantity_milli:5_000,reason:"Sortie refusée".into(),reference:None,date:None}).unwrap_err().to_string().contains("réservée"));
    assert_eq!(store.get_workspace().unwrap()["stock_movements"],before["stock_movements"]);
    assert_eq!(store.record_stock_count(count_input(&item,10_000,6_000)).unwrap()["catalog_item"]["stock_quantity_milli"],6_000);
    assert_eq!(store.verify_audit_log().unwrap()["valid"],true);
}

#[test]
fn stock_count_archived_product_refuses_new_movements_but_keeps_prior_receipt() {
    let (_temporary,store)=initialized_store();let item=tracked_product(&store,"Produit archivé",0);opening(&store,&item,10_000);
    let input=count_input(&item,10_000,8_000);store.record_stock_count(input.clone()).unwrap();
    store.connect().unwrap().execute("UPDATE catalog_items SET archived_at='2026-09-13T12:00:00Z' WHERE id=?",rusqlite::params![item]).unwrap();
    assert!(store.record_stock_count(count_input(&item,8_000,7_000)).unwrap_err().to_string().contains("archivé"));
    assert_eq!(store.record_stock_count(input).unwrap()["idempotent"],true);
    assert_eq!(store.get_workspace().unwrap()["stock_movements"].as_array().unwrap().len(),2);
}
