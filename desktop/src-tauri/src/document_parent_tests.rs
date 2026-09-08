//! Moving a row must respect the destination document's frozen state.
use crate::{database::LocalStore, models::SaveDocumentWithItemsInput};
use serde_json::{json, Value};

fn setup() -> (tempfile::TempDir, LocalStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    store.install_swiss_accounting_starter().unwrap();
    (directory, store)
}
fn document(store: &LocalStore, entity: &str, client: &Value, price: i64) -> String {
    let mut data =
        json!({"client_id":client["id"],"title":"Document fictif de recette","currency":"CHF"});
    if entity == "invoices" {
        data["service_date_from"] = json!("2026-09-08");
        data["service_date_to"] = json!("2026-09-08");
    }
    store.save_document_with_items(SaveDocumentWithItemsInput {entity:entity.into(),id:None,data,items:vec![json!({"description":"Prestation fictive","quantity":1,"unit":"forfait","unit_price_cents":price,"discount_bp":0,"vat_bp":0})]}).unwrap()["document"]["id"].as_str().unwrap().into()
}
#[test]
fn native_parent_guard_refuses_moving_a_zero_line_into_an_issued_document() {
    for (entity, items, parent) in [
        ("invoices", "invoice_items", "invoice_id"),
        ("quotes", "quote_items", "quote_id"),
    ] {
        let (_directory, store) = setup();
        let client=store.create_record("clients",json!({"name":"Client fictif","address_line1":"Rue du Client","address_line2":"7","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap();
        let draft = document(&store, entity, &client, 0);
        let issued = document(&store, entity, &client, 10000);
        // The same move remains allowed while both documents are drafts.
        let c = store.connect().unwrap();
        assert_eq!(
            c.execute(
                &format!("UPDATE {items} SET {parent}=?,position=99 WHERE {parent}=?"),
                [&issued, &draft]
            )
            .unwrap(),
            1
        );
        assert_eq!(
            c.execute(
                &format!("UPDATE {items} SET {parent}=? WHERE {parent}=? AND position=99"),
                [&draft, &issued]
            )
            .unwrap(),
            1
        );
        if entity == "invoices" {
            store
                .issue_invoice(&issued, Some("2026-09-08".into()), None)
                .unwrap();
        } else {
            store
                .issue_quote(
                    &issued,
                    Some("2026-09-08".into()),
                    Some("2026-10-08".into()),
                )
                .unwrap();
        }
        let c = store.connect().unwrap();
        let before =
            crate::database::query_all(&c, &format!("SELECT * FROM {items} ORDER BY id"), [])
                .unwrap();
        let result = c.execute(
            &format!("UPDATE {items} SET {parent}=?,position=99 WHERE {parent}=?"),
            [&issued, &draft],
        );
        assert!(
            result.is_err(),
            "{entity}: moving into an issued parent was accepted"
        );
        assert_eq!(
            before,
            crate::database::query_all(&c, &format!("SELECT * FROM {items} ORDER BY id"), [])
                .unwrap()
        );
        assert!(
            c.execute(
                &format!("UPDATE {items} SET {parent}=? WHERE {parent}=?"),
                [&draft, &issued]
            )
            .is_err(),
            "{entity}: moving out of an issued parent was accepted"
        );
    }
}

fn payslip(
    store: &LocalStore,
    employee: &str,
    period: &str,
    status: &str,
    contribution: &crate::models::ContributionSelectionInput,
) -> String {
    let saved = store.save_payslip_with_contributions(serde_json::from_value(json!({
        "id":null,"employee_id":employee,"period":period,"status":status,
        "payment_date":null,"notes":null,
        "lines":[
            {"id":null,"label":"Salaire fictif","kind":"earning","amount_cents":50000,"posting_account_id":null,"expense_account_id":null},
            {"id":null,"label":"Ligne fictive nulle","kind":"earning","amount_cents":0,"posting_account_id":null,"expense_account_id":null}
        ],"contributions":[contribution]
    })).unwrap()).unwrap();
    saved["payslip"]["id"].as_str().unwrap().into()
}

#[test]
fn native_parent_guard_refuses_moving_a_zero_line_into_a_posted_payslip() {
    let (_directory, store) = setup();
    let employee = store
        .create_record("employees", json!({"name":"Employé fictif"}))
        .unwrap();
    let employee = employee["id"].as_str().unwrap();
    let mut aap = crate::tests::configure_minor_test_payroll(&store, employee, 50000);
    let target = payslip(&store, employee, "2026-08", "valide", &aap);
    store
        .post_payslip(crate::models::PostPayslipInput {
            payslip_id: target.clone(),
            entry_date: Some("2026-08-31".into()),
        })
        .unwrap();
    aap.year_to_date_basis_cents = Some(50000);
    let source = payslip(&store, employee, "2026-09", "brouillon", &aap);
    let c = store.connect().unwrap();
    let before = business_rows(&c);
    let error=c.execute("UPDATE payslip_items SET payslip_id=? WHERE payslip_id=? AND amount_cents=0 AND kind='earning'",[&target,&source]).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("posted payslip lines are immutable"),
        "{error}"
    );
    assert_eq!(before, business_rows(&c));
}

#[test]
fn native_parent_guard_seals_destination_lines_and_contributions_after_a_later_period() {
    let (_directory, store) = setup();
    let employee = store
        .create_record("employees", json!({"name":"Employé fictif"}))
        .unwrap();
    let employee = employee["id"].as_str().unwrap();
    let mut aap = crate::tests::configure_minor_test_payroll(&store, employee, 50000);
    let target = payslip(&store, employee, "2026-07", "valide", &aap);
    aap.year_to_date_basis_cents = Some(50000);
    payslip(&store, employee, "2026-08", "valide", &aap);
    aap.year_to_date_basis_cents = Some(100000);
    let source = payslip(&store, employee, "2026-09", "brouillon", &aap);
    let c = store.connect().unwrap();
    let before = business_rows(&c);
    for (table, extra, message) in [
        (
            "payslip_items",
            " AND amount_cents=0 AND kind='earning'",
            "seals earlier validated payroll lines",
        ),
        (
            "payslip_contributions",
            "",
            "seals earlier payroll contributions",
        ),
    ] {
        let error = c
            .execute(
                &format!("UPDATE {table} SET payslip_id=? WHERE payslip_id=?{extra}"),
                [&target, &source],
            )
            .unwrap_err();
        assert!(error.to_string().contains(message), "{table}: {error}");
        assert_eq!(before, business_rows(&c));
    }
}

fn business_rows(c: &rusqlite::Connection) -> Value {
    let policy: Value = serde_json::from_str(include_str!("business_sync_tables.json")).unwrap();
    let mut result = serde_json::Map::new();
    for name in policy["tables"].as_object().unwrap().keys() {
        result.insert(
            name.clone(),
            json!(crate::database::query_all(
                c,
                &format!("SELECT * FROM \"{name}\" ORDER BY rowid"),
                []
            )
            .unwrap()),
        );
    }
    result.into()
}

fn guard_sql(c: &rusqlite::Connection) -> Vec<(String, String)> {
    c.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('invoice_items_issued_no_update','quote_items_issued_no_update','payslip_items_posted_no_update','payslip_items_later_posted_update_guard','payslip_contributions_later_posted_update_guard') ORDER BY name").unwrap()
        .query_map([],|row|Ok((row.get(0)?,row.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap()
}

pub(crate) fn restore_v60_guards(c: &rusqlite::Connection) {
    let guards = guard_sql(c);
    assert_eq!(guards.len(), 5);
    for (name, sql) in guards {
        let old = sql
            .replace("IN (OLD.invoice_id,NEW.invoice_id)", "=OLD.invoice_id")
            .replace("IN (OLD.quote_id,NEW.quote_id)", "=OLD.quote_id")
            .replace("IN (OLD.payslip_id,NEW.payslip_id)", "=OLD.payslip_id");
        assert_ne!(old, sql, "{name}");
        c.execute_batch(&format!("DROP TRIGGER {name}; {old};"))
            .unwrap();
    }
    c.pragma_update(None, "user_version", 60).unwrap();
}

#[test]
fn native_parent_guard_migration_preserves_documents_files_identity_and_restarts() {
    let (_directory, store) = setup();
    let client=store.create_record("clients",json!({"name":"Client fictif","address_line1":"Rue du Client","address_line2":"7","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap();
    let id = document(&store, "invoices", &client, 10000);
    store
        .issue_invoice(&id, Some("2026-09-08".into()), None)
        .unwrap();
    let c = store.connect().unwrap();
    let before = business_rows(&c);
    let expected_guards = guard_sql(&c);
    let attachment = store.attachments_dir.join("plan-fictif.txt");
    std::fs::write(&attachment, b"Piece de recette conservee").unwrap();
    restore_v60_guards(&c);
    let path = store.data_dir.clone();
    let installation = store.installation_id.clone();
    drop(c);
    drop(store);
    for _ in 0..2 {
        let reopened = LocalStore::initialize(path.clone()).unwrap();
        let c = reopened.connect().unwrap();
        assert_eq!(installation, reopened.installation_id);
        assert_eq!(before, business_rows(&c));
        assert_eq!(expected_guards, guard_sql(&c));
        assert_eq!(
            std::fs::read(&attachment).unwrap(),
            b"Piece de recette conservee"
        );
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            crate::schema::SCHEMA_VERSION
        );
        assert_eq!(
            c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }
}

#[test]
fn native_parent_guard_migration_rolls_back_all_guards_and_version() {
    let (_directory, store) = setup();
    let mut c = store.connect().unwrap();
    restore_v60_guards(&c);
    let before = business_rows(&c);
    let guards = guard_sql(&c);
    let transaction = c.transaction().unwrap();
    crate::document_parent_guards::migrate(&transaction).unwrap();
    assert_ne!(guard_sql(&transaction), guards);
    transaction.rollback().unwrap();
    assert_eq!(guard_sql(&c), guards);
    assert_eq!(business_rows(&c), before);
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        60
    );
}
