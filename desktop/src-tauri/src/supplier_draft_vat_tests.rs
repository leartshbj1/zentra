

#[test]
fn draft_and_all_vat_choices_roll_back_together_and_retry_without_duplicates() {
    let (_dir, store) = initialized_store();
    let supplier = value_id(&store.create_record("suppliers", json!({"name":"Fournisseur recette"})).unwrap());
    let id = "c6a567d1-8b80-48e4-8ac5-e98ff7335b11";
    let second = "1b343274-0c27-4abd-a269-26bad7a7ae38";
    let mut input: SaveSupplierInvoiceDraftInput = serde_json::from_value(json!({
        "id": id, "supplier_id": supplier, "date":"2026-09-01", "due_date":"2026-09-30", "reference":"RECETTE-ATOMIC", "note":"Avant correction",
        "items":[
            {"id":"0cc092c7-50a9-4cd2-b8b1-033406311c4a", "description":"Fournitures", "quantity_milli":1000, "unit_price_cents":10000, "vat_bp":0, "category":"Matériaux"},
            {"id":second, "description":"Livraison", "quantity_milli":1000, "unit_price_cents":5000, "vat_bp":0, "category":"Matériaux"}
        ]
    })).unwrap();
    let snapshot = || {
        let db = store.connect().unwrap();
        db.query_row("SELECT (SELECT COUNT(*) FROM supplier_invoices),(SELECT COUNT(*) FROM supplier_invoice_items),(SELECT COUNT(*) FROM vat_source_classifications),(SELECT COUNT(*) FROM audit_log)", [], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))).unwrap()
    };
    let before = snapshot();
    store.connect().unwrap().execute_batch(&format!("CREATE TRIGGER qa_reject_second_vat BEFORE INSERT ON vat_source_classifications WHEN NEW.source_id='{second}' BEGIN SELECT RAISE(ABORT,'Second classement refusé'); END;")).unwrap();
    assert!(store.save_supplier_invoice_draft_with_vat(input.clone(), Some("non_deductible".into())).unwrap_err().to_string().contains("Second classement refusé"));
    std::assert_eq!(snapshot(), before, "draft, both lines, first classification and audit must all roll back");
    store.connect().unwrap().execute_batch("DROP TRIGGER qa_reject_second_vat;").unwrap();
    store.save_supplier_invoice_draft_with_vat(input.clone(), Some("non_deductible".into())).unwrap();
    let saved = snapshot();
    std::assert_eq!((saved.0, saved.1, saved.2), (1, 2, 2));
    store.save_supplier_invoice_draft_with_vat(input.clone(), Some("non_deductible".into())).unwrap();
    std::assert_eq!(snapshot(), saved, "identical retry must not duplicate lines or audit events");

    input.note = Some("Correction à conserver seulement en cas de réussite".into());
    input.items[0].unit_price_cents = 12000;
    assert!(store.save_supplier_invoice_draft_with_vat(input.clone(), Some("invalid-treatment".into())).is_err());
    std::assert_eq!(snapshot(), saved);
    let db = store.connect().unwrap();
    let unchanged: (String, i64) = db.query_row("SELECT note,total_cents FROM supplier_invoices WHERE id=?", [id], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    std::assert_eq!(unchanged, ("Avant correction".into(), 15000));
    drop(db);
    store.save_supplier_invoice_draft_with_vat(input, None).unwrap();
    let db = store.connect().unwrap();
    std::assert_eq!(db.query_row("SELECT total_cents FROM supplier_invoices WHERE id=?", [id], |row| row.get::<_, i64>(0)).unwrap(), 17000);
    std::assert_eq!(db.query_row("SELECT COUNT(*) FROM vat_source_classifications WHERE treatment='non_deductible'", [], |row| row.get::<_, i64>(0)).unwrap(), 2, "keeping classifications must preserve the explicit choices");
}

#[test]
fn guided_supplier_decimals_round_on_each_line_and_survive_reopening() {
    let (_dir, store) = initialized_store();
    let supplier = value_id(&store.create_record("suppliers", json!({"name":"Fournisseur décimales"})).unwrap());
    let id = "4853a87a-05bb-4788-8216-e519cba82b73";
    let input: SaveSupplierInvoiceDraftInput = serde_json::from_value(json!({
        "id": id, "supplier_id": supplier, "date":"2026-09-05", "due_date":"2026-10-15", "reference":"ARRONDIS-RECUS", "note":"Première ligne\nSeconde ligne",
        "items":[
            {"id":"2c45ef35-733e-419f-b8f2-e7f2d984b67a", "description":"2,5 unités à 100,10 avec 10 % de remise", "quantity_milli":2500, "unit":"pièce", "unit_price_cents":10010, "discount_bp":1000, "vat_bp":810, "category":"Fournitures"},
            {"id":"f9dd2416-13c7-4d0a-a06c-181cfb1a47a1", "description":"1,5 unité à 10,05 avec 2,5 % de remise", "quantity_milli":1500, "unit":"pièce", "unit_price_cents":1005, "discount_bp":250, "vat_bp":810, "category":"Fournitures"}
        ]
    })).unwrap();
    store.save_supplier_invoice_draft(input.clone()).unwrap();
    store.save_supplier_invoice_draft(input).unwrap();
    let db = store.connect().unwrap();
    let mut query = db.prepare("SELECT quantity_milli,unit_price_cents,discount_bp,line_net_cents,line_vat_cents,line_total_cents FROM supplier_invoice_items WHERE supplier_invoice_id=? ORDER BY position").unwrap();
    let lines: Vec<(i64,i64,i64,i64,i64,i64)> = query.query_map([id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).unwrap().collect::<Result<_,_>>().unwrap();
    std::assert_eq!(lines, vec![(2500,10010,1000,22522,1824,24346),(1500,1005,250,1470,119,1589)]);
    let saved: (String,String,String,i64,i64,i64) = db.query_row("SELECT document_date,due_date,note,net_cents,vat_cents,total_cents FROM supplier_invoices WHERE id=?", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).unwrap();
    std::assert_eq!(saved, ("2026-09-05".into(),"2026-10-15".into(),"Première ligne\nSeconde ligne".into(),23992,1943,25935));
    std::assert_eq!(db.query_row("SELECT COUNT(*) FROM journal_entries WHERE source_type='supplier_invoice' AND source_id=?", [id], |row| row.get::<_,i64>(0)).unwrap(), 0, "saving a draft must not post accounting entries");
}
