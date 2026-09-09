//! Original capture order for stock side effects and native FK cascades.
use super::accounting_transitions::source_rows;
use super::*;

fn input<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}
fn tracked_item(store: &LocalStore) -> String {
    let item = store.create_record("catalog_items", json!({"kind":"product","name":"Materiel fictif","unit":"piece","sales_price_cents":1000,"track_stock":true})).unwrap();
    let id = item["id"].as_str().unwrap().to_string();
    store.record_stock_entry(input(json!({"request_id":Uuid::new_v4().to_string(),"catalog_item_id":id,"quantity_milli":10000,"reason":"Stock initial fictif","date":"2026-09-01"}))).unwrap();
    id
}
fn receipt_draft(store: &LocalStore, item: &str) -> String {
    let supplier = store
        .create_record("suppliers", json!({"name":"Fournisseur fictif"}))
        .unwrap();
    let order = store.save_supplier_order_draft(input(json!({"order":{"supplier_id":supplier["id"],"title":"Commande fictive","order_date":"2026-09-01","currency":"CHF"},"lines":[{"catalog_item_id":item,"position":0,"description":"Materiel","quantity_milli":5000,"unit":"piece","unit_price_cents":1000,"vat_bp":0,"category":"Marchandises","fulfillment_mode":"stocked_receipt"}]}))).unwrap();
    store.confirm_supplier_order(input(json!({"request_id":Uuid::new_v4().to_string(),"supplier_order_id":order["order"]["id"]}))).unwrap();
    let receipt = store.save_supplier_receipt_draft(input(json!({"receipt":{"supplier_order_id":order["order"]["id"],"receipt_date":"2026-09-08","reference":"RECETTE-RECEPTION"},"lines":[{"supplier_order_line_id":order["lines"][0]["id"],"quantity_milli":2500}]}))).unwrap();
    receipt["receipt"]["id"].as_str().unwrap().to_string()
}
fn delivery_draft(store: &LocalStore, item: &str) -> String {
    let client = store.create_record("clients",json!({"name":"Client fictif","address_line1":"Route du Client 2","postal_code":"1200","city":"Geneve","country":"CH"})).unwrap();
    let order = store.save_sales_order_draft(input(json!({"order":{"client_id":client["id"],"title":"Vente fictive","order_date":"2026-09-01","currency":"CHF"},"lines":[{"catalog_item_id":item,"position":0,"description":"Materiel","quantity_milli":5000,"unit":"piece","unit_price_cents":1000,"vat_bp":0,"fulfillment_mode":"stocked_delivery"}]}))).unwrap();
    store
        .confirm_sales_order(input(
            json!({"request_id":Uuid::new_v4().to_string(),"sales_order_id":order["order"]["id"]}),
        ))
        .unwrap();
    let delivery = store.save_delivery_note_draft(input(json!({"delivery_note":{"sales_order_id":order["order"]["id"],"delivery_date":"2026-09-08","reference":"RECETTE-LIVRAISON"},"lines":[{"sales_order_line_id":order["lines"][0]["id"],"quantity_milli":2500}]}))).unwrap();
    delivery["delivery_note"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn stock_receipts_deliveries_and_quote_cascades_preserve_native_order() {
    let output = std::env::var("ZENTRA_OPERATIONAL_TRANSITION_OUTPUT")
        .ok()
        .map(PathBuf::from);
    if let Some(folder) = &output {
        fs::create_dir(folder).unwrap();
    }
    for scenario in [
        "stock-entry",
        "stock-exit",
        "stock-correction",
        "supplier-receipt",
        "supplier-receipt-reversal",
        "delivery",
        "delivery-reversal",
        "quote-delete",
    ] {
        let (_directory, store) = setup();
        store.install_swiss_accounting_starter().unwrap();
        let mut document = String::new();
        let item = if scenario == "quote-delete" {
            String::new()
        } else {
            tracked_item(&store)
        };
        if scenario.starts_with("supplier-receipt") {
            document = receipt_draft(&store, &item);
            if scenario.ends_with("reversal") {
                store.issue_supplier_receipt(input(json!({"request_id":Uuid::new_v4().to_string(),"supplier_receipt_id":document}))).unwrap();
            }
        } else if scenario.starts_with("delivery") {
            document = delivery_draft(&store, &item);
            if scenario.ends_with("reversal") {
                store.issue_delivery_note(input(json!({"request_id":Uuid::new_v4().to_string(),"delivery_note_id":document}))).unwrap();
            }
        } else if scenario == "quote-delete" {
            let client = store
                .create_record("clients", json!({"name":"Client fictif"}))
                .unwrap();
            let quote = store
                .create_record(
                    "quotes",
                    json!({"client_id":client["id"],"title":"Devis brouillon fictif"}),
                )
                .unwrap();
            document = quote["id"].as_str().unwrap().to_string();
            for description in ["Prestation une", "Prestation deux"] {
                store.create_record("quote_items", json!({"quote_id":document,"description":description,"quantity":1,"unit_price_cents":1000,"vat_bp":0})).unwrap();
            }
        }
        let source = source_rows(&store);
        bind(&store);
        let request = Uuid::new_v4().to_string();
        match scenario {
            "stock-entry" => {
                store.record_stock_entry(input(json!({"request_id":request,"catalog_item_id":item,"quantity_milli":2500,"reason":"Entree fictive","date":"2026-09-08"}))).unwrap();
            }
            "stock-exit" => {
                store.record_stock_exit(input(json!({"request_id":request,"catalog_item_id":item,"quantity_milli":2500,"reason":"Sortie fictive","date":"2026-09-08"}))).unwrap();
            }
            "stock-correction" => {
                store.record_stock_correction(input(json!({"request_id":request,"catalog_item_id":item,"delta_quantity_milli":-500,"reason":"Correction fictive","date":"2026-09-08"}))).unwrap();
            }
            "supplier-receipt" => {
                store
                    .issue_supplier_receipt(input(
                        json!({"request_id":request,"supplier_receipt_id":document}),
                    ))
                    .unwrap();
            }
            "supplier-receipt-reversal" => {
                store.reverse_supplier_receipt(input(json!({"request_id":request,"supplier_receipt_id":document,"reason":"Retour fictif des marchandises"}))).unwrap();
            }
            "delivery" => {
                store
                    .issue_delivery_note(input(
                        json!({"request_id":request,"delivery_note_id":document}),
                    ))
                    .unwrap();
            }
            "delivery-reversal" => {
                store.reverse_delivery_note(input(json!({"request_id":request,"delivery_note_id":document,"reason":"Retour fictif des marchandises"}))).unwrap();
            }
            "quote-delete" => {
                store.delete_record("quotes", &document).unwrap();
            }
            _ => unreachable!(),
        }
        let prepared = next(&store);
        let changes = all(&prepared);
        assert!(prepared.manifest.files.is_empty(), "{scenario}");
        if scenario == "quote-delete" {
            let parent = changes
                .iter()
                .position(|c| c["table"] == "quotes" && c["operation"] == "delete")
                .unwrap();
            let children: Vec<_> = changes
                .iter()
                .enumerate()
                .filter(|(_, c)| c["table"] == "quote_items" && c["operation"] == "delete")
                .map(|(i, _)| i)
                .collect();
            assert_eq!(children.len(), 2);
            assert!(children.iter().all(|i| *i < parent));
        } else {
            let movement = changes
                .iter()
                .position(|c| c["table"] == "stock_movements" && c["operation"] == "insert")
                .unwrap();
            let balance = changes
                .iter()
                .position(|c| c["table"] == "catalog_items" && c["operation"] == "update")
                .unwrap();
            assert!(
                movement < balance,
                "{scenario}: movement must be captured before its AFTER balance write"
            );
            let after: Value =
                serde_json::from_str(changes[balance]["after_json"].as_str().unwrap()).unwrap();
            let current: i64 = store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT stock_quantity_milli FROM catalog_items WHERE id=?",
                    [&item],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(after["stock_quantity_milli"], current);
        }
        if let Some(folder) = &output {
            let directory = folder.join(scenario);
            fs::create_dir(&directory).unwrap();
            fs::write(
                directory.join("source.json"),
                serde_json::to_vec(&source).unwrap(),
            )
            .unwrap();
            fs::write(
                directory.join("final.json"),
                serde_json::to_vec(&source_rows(&store)).unwrap(),
            )
            .unwrap();
            fs::write(
                directory.join("manifest.json"),
                serde_json::to_vec(&prepared.manifest).unwrap(),
            )
            .unwrap();
            for (i, _) in prepared.manifest.chunks.iter().enumerate() {
                fs::copy(
                    prepared.folder.join(format!("{i:04}.json")),
                    directory.join(format!("{i:04}.json")),
                )
                .unwrap();
            }
        }
        println!(
            "QA_OPERATIONAL_TRANSITION scenario={scenario} changes={}",
            changes.len()
        );
    }
}
