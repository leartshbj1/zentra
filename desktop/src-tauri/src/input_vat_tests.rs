use std::collections::HashMap;

use rusqlite::params;
use serde_json::json;
use uuid::Uuid;

#[path = "vat_received_credit_tests.rs"]
mod received_credit_tests;

use crate::{
    database::LocalStore,
    models::{
        ReclassifySupplierInvoiceExpenseInput, SaveSupplierInvoiceDraftInput,
        SupplierExpenseReclassificationLineInput, SupplierInvoiceLineInput,
    },
    vat_reporting::{VatProfileInput, VatReturnPreviewInput, VatSourceClassificationInput},
};

fn fixture() -> (tempfile::TempDir, LocalStore, HashMap<&'static str, String>) {
    fixture_with_registration(true)
}

fn fixture_with_registration(registered: bool) -> (tempfile::TempDir, LocalStore, HashMap<&'static str, String>) {
    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temp.path().join("profile")).unwrap();
    let mut settings = crate::tests::test_onboarding();
    settings.vat_registered = registered;
    settings.vat_number = registered.then(|| "CHE-123.456.789 TVA".into());
    settings.default_vat_bp = Some(if registered { 810 } else { 0 });
    store.complete_onboarding(settings, "1.27.0").unwrap();
    let accounts = crate::tests::enable_accounting(&store);
    (temp, store, accounts)
}

fn profile(simple: bool) -> VatProfileInput {
    VatProfileInput {
        id: Some(Uuid::new_v4().to_string()),
        effective_from: "2026-01-01".into(),
        effective_to: None,
        reporting_method: if simple {
            "simple_tax_rate"
        } else {
            "effective"
        }
        .into(),
        form_of_reporting: "agreed".into(),
        periodicity: "quarterly".into(),
        gross_or_net: if simple { "gross" } else { "net" }.into(),
        tdfn_activity_id: simple.then(|| "00001".into()),
        tdfn_rate_bp: simple.then_some(620),
        afc_authorization_confirmed: simple,
        notes: None,
        close_previous_open_profile: false,
    }
}

fn draft(store: &LocalStore) -> (String, Vec<String>) {
    let supplier = store
        .create_record("suppliers", json!({"name":"Fournisseur test TVA"}))
        .unwrap();
    let id = Uuid::new_v4().to_string();
    let lines = vec![Uuid::new_v4().to_string(), Uuid::new_v4().to_string()];
    store
        .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
            id: Some(id.clone()),
            supplier_id: supplier["id"].as_str().unwrap().into(),
            project_id: None,
            date: "2026-02-10".into(),
            due_date: "2026-03-10".into(),
            reference: Some(id.clone()),
            note: None,
            items: lines
                .iter()
                .map(|line| SupplierInvoiceLineInput {
                    id: Some(line.clone()),
                    description: "Marchandise".into(),
                    quantity_milli: 1000,
                    unit: Some("pièce".into()),
                    unit_price_cents: 10000,
                    discount_bp: 0,
                    vat_bp: 810,
                    category: "Marchandises".into(),
                    expense_account_id: None,
                    project_id: None,
                })
                .collect(),
        })
        .unwrap();
    (id, lines)
}

fn classify(store: &LocalStore, kind: &str, id: &str, treatment: &str) {
    store
        .set_vat_source_classification(VatSourceClassificationInput {
            source_type: kind.into(),
            source_id: id.into(),
            treatment: treatment.into(),
            note: None,
        })
        .unwrap();
}

fn balance(store: &LocalStore, account: &str, date: &str) -> i64 {
    store.connect().unwrap().query_row("SELECT COALESCE(SUM(line.debit_cents-line.credit_cents),0) FROM journal_lines line JOIN journal_entries entry ON entry.id=line.journal_entry_id WHERE line.account_id=? AND entry.entry_date<=?", params![account,date], |row| row.get(0)).unwrap()
}

fn journal_count(store: &LocalStore) -> i64 {
    store
        .connect()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0))
        .unwrap()
}

fn credit_draft(store: &LocalStore, date: &str) -> (String, String) {
    let supplier = store
        .create_record("suppliers", json!({"name":"Fournisseur avoir TVA"}))
        .unwrap();
    let id = Uuid::new_v4().to_string();
    let line = Uuid::new_v4().to_string();
    store
        .save_supplier_credit_note_draft(crate::models::SaveSupplierCreditNoteDraftInput {
            id: Some(id.clone()),
            supplier_id: supplier["id"].as_str().unwrap().into(),
            document_date: date.into(),
            reference: Some(id.clone()),
            note: None,
            items: vec![SupplierInvoiceLineInput {
                id: Some(line.clone()),
                description: "Retour marchandises".into(),
                quantity_milli: 1000,
                unit: Some("pièce".into()),
                unit_price_cents: 5000,
                discount_bp: 0,
                vat_bp: 810,
                category: "Marchandises".into(),
                expense_account_id: None,
                project_id: None,
            }],
            allocations: vec![],
        })
        .unwrap();
    (id, line)
}

fn validate_credit(store: &LocalStore, id: &str) -> serde_json::Value {
    store
        .validate_supplier_credit_note(crate::models::ValidateSupplierCreditNoteInput {
            request_id: Uuid::new_v4().to_string(),
            supplier_credit_note_id: id.into(),
        })
        .unwrap()
}

fn period_preview(
    store: &LocalStore,
    from: &str,
    to: &str,
) -> crate::vat_reporting::VatReturnPreview {
    store
        .preview_vat_return(VatReturnPreviewInput {
            date_from: from.into(),
            date_to: to.into(),
            submission_type: "initial".into(),
            profile_id: None,
        })
        .unwrap()
}

#[test]
fn received_unpaid_purchases_can_be_classified_before_their_period_is_frozen() {
    let (_temp, store, accounts) = fixture();
    let mut received = profile(false);
    received.form_of_reporting = "received".into();
    received.afc_authorization_confirmed = true;
    store.create_vat_profile(received).unwrap();
    let (invoice, lines) = draft(&store);
    store.validate_supplier_invoice(&invoice).unwrap();
    let before = period_preview(&store, "2026-01-01", "2026-03-31");
    assert!(
        before.exportable,
        "unpaid amounts are not due in this received return"
    );
    assert_eq!(before.payable_tax_cents, 0);
    assert_eq!(before.pre_closing_sources.len(), 2);
    assert!(before.unclassified_sources.is_empty());
    assert!(crate::vat_reporting::ensure_vat_sources_classified_through(
        &store.connect().unwrap(),
        "2026-03-31"
    )
    .unwrap_err()
    .to_string()
    .contains("2 source(s)"));
    classify(&store, "supplier_invoice_item", &lines[0], "non_deductible");
    classify(
        &store,
        "supplier_invoice_item",
        &lines[1],
        "input_materials",
    );
    let after = period_preview(&store, "2026-01-01", "2026-03-31");
    assert!(after.pre_closing_sources.is_empty());
    assert_eq!(
        after.source_sha256, before.source_sha256,
        "pre-closing decisions do not change the tax bases of an unpaid period"
    );
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-03-31"),
        810
    );
    crate::vat_reporting::ensure_vat_sources_classified_through(
        &store.connect().unwrap(),
        "2026-03-31",
    )
    .unwrap();
    store
        .record_supplier_payment(crate::models::RecordSupplierPaymentInput {
            request_id: Uuid::new_v4().to_string(),
            supplier_invoice_id: invoice,
            amount_cents: 21620,
            date: "2026-04-01".into(),
            method: None,
            reference: None,
            notes: None,
        })
        .unwrap();
    let q2 = period_preview(&store, "2026-04-01", "2026-06-30");
    assert!(q2.exportable);
    assert_eq!(q2.payable_tax_cents, -810);
}

#[test]
fn reporting_transition_checks_supplier_balances_with_native_payments_and_keeps_journal_unchanged()
{
    let (_temp, store, _accounts) = fixture();
    store.create_vat_profile(profile(false)).unwrap();
    let (invoice, lines) = draft(&store);
    for line in &lines {
        classify(&store, "supplier_invoice_item", line, "input_materials");
    }
    store.validate_supplier_invoice(&invoice).unwrap();
    let pay = |date: &str| crate::models::RecordSupplierPaymentInput {
        request_id: Uuid::new_v4().to_string(),
        supplier_invoice_id: invoice.clone(),
        amount_cents: 10810,
        date: date.into(),
        method: Some("bank".into()),
        reference: None,
        notes: None,
    };
    store.record_supplier_payment(pay("2026-06-30")).unwrap();
    store.record_supplier_payment(pay("2026-07-01")).unwrap();
    let before_journal_count = journal_count(&store);
    let mut next = profile(false);
    next.form_of_reporting = "received".into();
    next.effective_from = "2026-07-01".into();
    next.close_previous_open_profile = true;
    let error = store.create_vat_profile(next.clone()).unwrap_err();
    assert!(error.to_string().contains("108.10 CHF"), "{error}");
    assert!(error.to_string().contains(&invoice), "{error}");
    assert_eq!(journal_count(&store), before_journal_count);
    assert_eq!(store.list_vat_profiles().unwrap().len(), 1);
    next.effective_from = "2026-07-02".into();
    store.create_vat_profile(next).unwrap();
    assert_eq!(journal_count(&store), before_journal_count);
}

#[test]
fn received_supplier_payments_split_rates_and_only_deduct_eligible_input_tax() {
    let (_temp, store, accounts) = fixture();
    let raw: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT extra_settings_json FROM settings WHERE id=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut extra: serde_json::Value = serde_json::from_str(&raw).unwrap();
    extra["billing"]["vatRatesBp"] = json!([810, 260, 380]);
    store
        .update_settings(json!({"extra_settings_json":extra}))
        .unwrap();
    let mut received = profile(false);
    received.form_of_reporting = "received".into();
    received.afc_authorization_confirmed = true;
    store.create_vat_profile(received).unwrap();
    let supplier = store
        .create_record("suppliers", json!({"name":"Achats multi-taux"}))
        .unwrap();
    let invoice = Uuid::new_v4().to_string();
    let lines: Vec<String> = (0..3).map(|_| Uuid::new_v4().to_string()).collect();
    store
        .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
            id: Some(invoice.clone()),
            supplier_id: supplier["id"].as_str().unwrap().into(),
            project_id: None,
            date: "2026-02-10".into(),
            due_date: "2026-04-30".into(),
            reference: Some("MULTI-2026".into()),
            note: None,
            items: lines
                .iter()
                .zip([810, 260, 380])
                .map(|(id, rate)| SupplierInvoiceLineInput {
                    id: Some(id.clone()),
                    description: format!("Achat au taux {rate}"),
                    quantity_milli: 1000,
                    unit: Some("pièce".into()),
                    unit_price_cents: 10000,
                    discount_bp: 0,
                    vat_bp: rate,
                    category: "Marchandises".into(),
                    expense_account_id: None,
                    project_id: None,
                })
                .collect(),
        })
        .unwrap();
    for (id, treatment) in
        lines
            .iter()
            .zip(["input_materials", "input_investments", "non_deductible"])
    {
        classify(&store, "supplier_invoice_item", id, treatment);
    }
    store.validate_supplier_invoice(&invoice).unwrap();
    let pay = |date: &str| crate::models::RecordSupplierPaymentInput {
        request_id: Uuid::new_v4().to_string(),
        supplier_invoice_id: invoice.clone(),
        amount_cents: 15725,
        date: date.into(),
        method: Some("bank".into()),
        reference: Some("MULTI-2026".into()),
        notes: None,
    };
    let first = pay("2026-03-31");
    store.record_supplier_payment(first.clone()).unwrap();
    store.record_supplier_payment(first).unwrap(); // a retried bank operation is not another receipt
    let q1 = period_preview(&store, "2026-01-01", "2026-03-31");
    assert!(q1.exportable, "{:?}", q1.blocking_issues);
    assert_eq!(q1.payable_tax_cents, -535);
    assert_eq!(q1.received_allocations.len(), 3);
    assert_eq!(
        q1.received_allocations
            .iter()
            .map(|row| row.payment.gross_cents)
            .sum::<i64>(),
        15725
    );
    let method = q1.effective_reporting_method.as_ref().unwrap();
    assert_eq!(method.input_tax_material_and_services_cents, 405);
    assert_eq!(method.input_tax_investments_cents, 130);
    store.record_supplier_payment(pay("2026-04-01")).unwrap();
    let q2 = period_preview(&store, "2026-04-01", "2026-06-30");
    assert!(q2.exportable, "{:?}", q2.blocking_issues);
    assert_eq!(q2.payable_tax_cents, -535);
    assert_eq!(
        period_preview(&store, "2026-01-01", "2026-03-31").source_sha256,
        q1.source_sha256
    );
    for (id, expected_vat) in lines.iter().zip([810, 260, 380]) {
        let allocations: Vec<_> = q1
            .received_allocations
            .iter()
            .chain(&q2.received_allocations)
            .filter(|row| &row.source_id == id)
            .collect();
        assert_eq!(
            allocations
                .iter()
                .map(|row| row.payment.net_cents)
                .sum::<i64>(),
            10000
        );
        assert_eq!(
            allocations
                .iter()
                .map(|row| row.payment.vat_cents)
                .sum::<i64>(),
            expected_vat
        );
        assert!(allocations
            .iter()
            .all(|row| row.payment.gross_cents == row.payment.net_cents + row.payment.vat_cents));
    }
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-06-30"),
        1070
    );
}

#[test]
fn input_vat_credit_reduces_deduction_in_its_own_period_and_preserves_the_purchase() {
    let (_temp, store, accounts) = fixture();
    store.create_vat_profile(profile(false)).unwrap();
    let (invoice, lines) = draft(&store);
    for line in &lines {
        classify(&store, "supplier_invoice_item", line, "input_materials");
    }
    store.validate_supplier_invoice(&invoice).unwrap();
    let (credit, line) = credit_draft(&store, "2026-04-01");
    let result = validate_credit(&store, &credit);
    let journal = result["credit_note"]["validation_journal_entry_id"]
        .as_str()
        .unwrap();
    assert!(store
        .reverse_journal_entry(journal, "2026-04-02", None)
        .is_err());
    let before = period_preview(&store, "2026-04-01", "2026-06-30");
    assert!(!before.exportable);
    assert_eq!(
        before.unclassified_sources[0].source_type,
        "supplier_credit_note_item"
    );
    classify(
        &store,
        "supplier_credit_note_item",
        &line,
        "input_materials",
    );
    let q2 = period_preview(&store, "2026-04-01", "2026-06-30");
    assert!(q2.exportable, "{:?}", q2.blocking_issues);
    assert_eq!(q2.payable_tax_cents, 405);
    assert_eq!(
        q2.effective_reporting_method
            .unwrap()
            .input_tax_material_and_services_cents,
        -405
    );
    let export = store
        .export_vat_return_xml(crate::vat_reporting::ExportVatReturnInput {
            date_from: "2026-04-01".into(),
            date_to: "2026-06-30".into(),
            submission_type: "initial".into(),
            profile_id: None,
            business_reference_id: "Credit-T2".into(),
            file_name: None,
        })
        .unwrap();
    let xml = std::fs::read_to_string(export.file_path).unwrap();
    assert!(xml.contains(
        "<eCH-0217:inputTaxMaterialAndServices>-4.05</eCH-0217:inputTaxMaterialAndServices>"
    ));
    if let Ok(path) = std::env::var("ZENTRA_QA_VAT_XML_PATH") {
        std::fs::write(path, &xml).unwrap();
    }
    assert_eq!(
        period_preview(&store, "2026-01-01", "2026-03-31").payable_tax_cents,
        -1620
    );
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-06-30"),
        1215
    );
    let snapshot: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT snapshot_json FROM supplier_credit_notes WHERE id=?",
            params![credit],
            |row| row.get(0),
        )
        .unwrap();
    classify(&store, "supplier_credit_note_item", &line, "non_deductible");
    assert_eq!(
        period_preview(&store, "2026-04-01", "2026-06-30").payable_tax_cents,
        0
    );
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-06-30"),
        1620
    );
    assert_eq!(balance(&store, &accounts["expense"], "2026-06-30"), 14595);
    let count = journal_count(&store);
    classify(&store, "supplier_credit_note_item", &line, "non_deductible");
    assert_eq!(journal_count(&store), count);
    classify(
        &store,
        "supplier_credit_note_item",
        &line,
        "input_investments",
    );
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-06-30"),
        1215
    );
    let unchanged: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT snapshot_json FROM supplier_credit_notes WHERE id=?",
            params![credit],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unchanged, snapshot);
    let exports = store
        .list_vat_return_exports(crate::vat_reporting::ListVatReturnExportsInput::default())
        .unwrap();
    assert_eq!(
        exports[0].payload.payable_tax_cents, 405,
        "The earlier VAT export remains frozen after reclassification"
    );
}

#[test]
fn input_vat_credit_simple_method_and_legacy_migration_preserve_closed_classifications() {
    let (_temp, store, accounts) = fixture();
    let expense = store.create_record("expenses", json!({"date":"2026-01-10","due_date":"2026-01-31","supplier":"Test","currency":"CHF","net_cents":10000,"vat_cents":810,"payment_status":"pending"})).unwrap();
    let expense_id = expense["id"].as_str().unwrap();
    classify(&store, "expense", expense_id, "input_materials");
    let connection = store.connect().unwrap();
    // Restore precisely the v41 classification table constraint and absence of the new column.
    let old = crate::schema::MIGRATION_V22_SQL;
    let table_start = old
        .find("CREATE TABLE IF NOT EXISTS vat_source_classifications (")
        .unwrap();
    let table_end = old[table_start..]
        .find("CREATE TABLE IF NOT EXISTS vat_adjustments (")
        .unwrap()
        + table_start;
    connection.execute_batch("DROP TABLE vat_source_classifications; ALTER TABLE supplier_credit_note_items DROP COLUMN posted_expense_account_id;").unwrap();
    connection
        .execute_batch(&old[table_start..table_end])
        .unwrap();
    connection.execute("INSERT INTO vat_source_classifications VALUES('legacy','expense',?,'input_materials','Justificatif historique','2026-01-10','2026-01-10')", params![expense_id]).unwrap();
    connection.execute_batch("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES('closed','Janvier','2026-01-01','2026-01-31','closed','2026-02-01','2026-02-01'); PRAGMA user_version=41;").unwrap();
    drop(connection);
    store.migrate().unwrap();
    store.migrate().unwrap();
    let connection = store.connect().unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT note FROM vat_source_classifications WHERE id='legacy'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "Justificatif historique"
    );
    assert!(connection
        .execute(
            "UPDATE vat_source_classifications SET treatment='non_deductible' WHERE id='legacy'",
            []
        )
        .is_err());
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    let mut method = profile(true);
    method.effective_from = "2026-02-01".into();
    store.create_vat_profile(method).unwrap();
    let (credit, line) = credit_draft(&store, "2026-02-10");
    validate_credit(&store, &credit);
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-03-31"),
        0
    );
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), -5405);
    classify(&store, "supplier_credit_note_item", &line, "non_deductible");
    connection.execute_batch("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES('closed-feb','Février','2026-02-01','2026-02-28','closed','2026-03-01','2026-03-01');").unwrap();
    assert!(connection.execute("UPDATE vat_source_classifications SET treatment='input_materials' WHERE source_type='supplier_credit_note_item' AND source_id=?", params![line]).is_err());
}

#[test]
fn input_vat_mixed_purchase_matches_return_ledger_and_immutable_snapshot() {
    let (temp, store, accounts) = fixture();
    store.create_vat_profile(profile(false)).unwrap();
    let (id, lines) = draft(&store);
    classify(&store, "supplier_invoice_item", &lines[0], "non_deductible");
    classify(
        &store,
        "supplier_invoice_item",
        &lines[1],
        "input_materials",
    );
    store.validate_supplier_invoice(&id).unwrap();
    let original_snapshot: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT snapshot_json FROM supplier_invoices WHERE id=?",
            params![id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-03-31"),
        810
    );
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 20810);
    let preview = store
        .preview_vat_return(VatReturnPreviewInput {
            date_from: "2026-01-01".into(),
            date_to: "2026-03-31".into(),
            submission_type: "initial".into(),
            profile_id: None,
        })
        .unwrap();
    assert!(preview.exportable, "{:?}", preview.blocking_issues);
    assert_eq!(preview.classified_sources.len(), 2);
    assert!(preview
        .classified_sources
        .iter()
        .any(|source| source.source.source_id == lines[0]
            && source.treatment == "non_deductible"
            && source.currency == "CHF"));
    // Archived export payloads from 1.27 did not contain the review list.
    let mut legacy = serde_json::to_value(&preview).unwrap();
    legacy.as_object_mut().unwrap().remove("classified_sources");
    legacy
        .as_object_mut()
        .unwrap()
        .remove("received_allocations");
    legacy
        .as_object_mut()
        .unwrap()
        .remove("pre_closing_sources");
    let old: crate::vat_reporting::VatReturnPreview = serde_json::from_value(legacy).unwrap();
    assert!(old.classified_sources.is_empty());
    assert!(old.received_allocations.is_empty());
    assert!(old.pre_closing_sources.is_empty());
    assert_eq!(old.payable_tax_cents, preview.payable_tax_cents);
    assert_eq!(
        preview
            .effective_reporting_method
            .unwrap()
            .input_tax_material_and_services_cents,
        810
    );
    let count = journal_count(&store);
    classify(&store, "supplier_invoice_item", &lines[0], "non_deductible");
    assert_eq!(journal_count(&store), count);
    classify(
        &store,
        "supplier_invoice_item",
        &lines[0],
        "input_investments",
    );
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-03-31"),
        1620
    );
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 20000);
    classify(&store, "supplier_invoice_item", &lines[0], "non_deductible");
    let snapshot: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT snapshot_json FROM supplier_invoices WHERE id=?",
            params![id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(snapshot, original_snapshot);
    let correction: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT id FROM journal_entries WHERE source_type='vat_input_reclassification' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(store
        .reverse_journal_entry(&correction, "2026-03-31", None)
        .unwrap_err()
        .to_string()
        .contains("classification"));
    let backup = store
        .create_backup(
            Some(
                temp.path()
                    .join("vat.zentra")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "1.27.0",
        )
        .unwrap();
    store.restore_backup(&backup, "1.27.0").unwrap();
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-03-31"),
        810
    );
}

#[test]
fn input_vat_expense_is_adjusted_only_when_paid_and_failures_are_atomic() {
    let (_temp, store, accounts) = fixture();
    let expense = store.create_record("expenses", json!({"date":"2026-02-01","due_date":"2026-02-28","supplier":"Test","currency":"CHF","net_cents":10000,"vat_cents":810,"payment_status":"pending"})).unwrap();
    let id = expense["id"].as_str().unwrap();
    classify(&store, "expense", id, "non_deductible");
    assert_eq!(journal_count(&store), 0);
    store
        .update_record(
            "expenses",
            id,
            json!({"payment_status":"paid","paid_at":"2026-02-20"}),
        )
        .unwrap();
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-03-31"),
        0
    );
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 10810);
    assert_eq!(balance(&store, &accounts["expense"], "2026-02-19"), 0);
    let original: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT id FROM journal_entries WHERE source_type='expense' AND source_id=?",
            params![id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(store
        .reverse_journal_entry(&original, "2026-03-31", None)
        .is_err());
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE accounts SET active=0 WHERE id=?",
            params![accounts["vat_receivable"]],
        )
        .unwrap();
    let count = journal_count(&store);
    assert!(store
        .set_vat_source_classification(VatSourceClassificationInput {
            source_type: "expense".into(),
            source_id: id.into(),
            treatment: "input_materials".into(),
            note: None
        })
        .is_err());
    assert_eq!(journal_count(&store), count);
    let treatment: String = store.connect().unwrap().query_row("SELECT treatment FROM vat_source_classifications WHERE source_type='expense' AND source_id=?", params![id], |row| row.get(0)).unwrap();
    assert_eq!(treatment, "non_deductible");
}

#[test]
fn input_vat_follows_dated_expense_reclassifications_without_rewriting_history() {
    let (_temp, store, accounts) = fixture();
    let (id, lines) = draft(&store);
    classify(&store, "supplier_invoice_item", &lines[0], "non_deductible");
    store.validate_supplier_invoice(&id).unwrap();
    let input = ReclassifySupplierInvoiceExpenseInput {
        request_id: Uuid::new_v4().to_string(),
        supplier_invoice_id: id,
        effective_date: "2026-04-01".into(),
        reason: "Imputation corrigée".into(),
        lines: vec![SupplierExpenseReclassificationLineInput {
            supplier_invoice_item_id: lines[0].clone(),
            new_expense_account_id: accounts["wages_expense"].clone(),
        }],
    };
    store
        .reclassify_supplier_invoice_expense(input.clone())
        .unwrap();
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 20810);
    assert_eq!(balance(&store, &accounts["expense"], "2026-04-30"), 10000);
    assert_eq!(
        balance(&store, &accounts["wages_expense"], "2026-04-30"),
        10810
    );
    let count = journal_count(&store);
    store.reclassify_supplier_invoice_expense(input).unwrap();
    assert_eq!(journal_count(&store), count);
    classify(
        &store,
        "supplier_invoice_item",
        &lines[0],
        "input_materials",
    );
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 20000);
    assert_eq!(
        balance(&store, &accounts["wages_expense"], "2026-04-30"),
        10000
    );
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-04-30"),
        1620
    );
}

#[test]
fn input_vat_simple_method_posts_gross_costs_and_closed_history_stays_frozen() {
    let (_temp, store, accounts) = fixture();
    let (id, lines) = draft(&store);
    store.validate_supplier_invoice(&id).unwrap();
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-03-31"),
        1620
    );
    store.create_vat_profile(profile(true)).unwrap();
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-03-31"),
        0
    );
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 21620);
    classify(&store, "supplier_invoice_item", &lines[0], "non_deductible");
    let connection = store.connect().unwrap();
    connection.execute("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES('closed','T1','2026-01-01','2026-03-31','closed','2026-04-01','2026-04-01')", []).unwrap();
    let count = journal_count(&store);
    classify(&store, "supplier_invoice_item", &lines[0], "non_deductible");
    assert_eq!(journal_count(&store), count);
    assert!(store
        .set_vat_source_classification(VatSourceClassificationInput {
            source_type: "supplier_invoice_item".into(),
            source_id: lines[0].clone(),
            treatment: "input_materials".into(),
            note: None
        })
        .is_err());
    assert_eq!(journal_count(&store), count);
}

#[test]
fn non_registered_supplier_invoice_and_credit_keep_gross_cost_and_zero_input_vat() {
    let (_temp, store, accounts) = fixture_with_registration(false);
    let (invoice, lines) = draft(&store);
    assert!(store.set_vat_source_classification(VatSourceClassificationInput {
        source_type: "supplier_invoice_item".into(), source_id: lines[0].clone(),
        treatment: "input_materials".into(), note: None,
    }).unwrap_err().to_string().contains("L’assujettissement à la date de cet achat n’est pas établi"));
    store.validate_supplier_invoice(&invoice).unwrap();
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 21620);
    assert_eq!(balance(&store, &accounts["vat_receivable"], "2026-03-31"), 0);
    for line in &lines {
        let treatment: String = store.connect().unwrap().query_row(
            "SELECT treatment FROM vat_source_classifications WHERE source_type='supplier_invoice_item' AND source_id=?", params![line], |row| row.get(0),
        ).unwrap();
        assert_eq!(treatment, "non_deductible");
    }
    let count = journal_count(&store);
    assert!(store.validate_supplier_invoice(&invoice).is_err());
    assert_eq!(journal_count(&store), count, "rejected second validation must not duplicate corrections");
    let (credit, line) = credit_draft(&store, "2026-03-15");
    validate_credit(&store, &credit);
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 16215);
    assert_eq!(balance(&store, &accounts["vat_receivable"], "2026-03-31"), 0);
    classify(&store, "supplier_credit_note_item", &line, "non_deductible");
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 16215);
    let rows: i64 = store.connect().unwrap().query_row(
        "SELECT COUNT(*) FROM supplier_invoice_items WHERE supplier_invoice_id=? AND vat_bp=810 AND line_net_cents=10000 AND line_vat_cents=810 AND line_total_cents=10810", params![invoice], |row| row.get(0),
    ).unwrap();
    assert_eq!(rows, 2, "source HT/TVA/TTC amounts must stay intact");
    assert_eq!(store.get_accounting_continuity().unwrap()["semantic_posting_mismatches"], 0);
}

#[test]
fn non_registered_expense_stays_gross_when_registration_is_enabled_later() {
    let (_temp, store, accounts) = fixture_with_registration(false);
    let expense = store.create_record("expenses", json!({"date":"2026-02-01","due_date":"2026-02-28","supplier":"Marchandises","currency":"CHF","net_cents":10000,"vat_cents":810,"payment_status":"pending"})).unwrap();
    let id = expense["id"].as_str().unwrap();
    assert_eq!(journal_count(&store), 0);
    classify(&store, "expense", id, "non_deductible");
    store.update_record("expenses", id, json!({"payment_status":"paid","paid_at":"2026-02-20"})).unwrap();
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 10810);
    assert_eq!(balance(&store, &accounts["vat_receivable"], "2026-03-31"), 0);
    assert_eq!(balance(&store, &accounts["bank"], "2026-03-31"), -10810);
    let count = journal_count(&store);
    store.connect().unwrap().execute("UPDATE settings SET vat_registered=1,vat_number='CHE-123.456.789 TVA' WHERE id=1", []).unwrap();
    let mut new_profile = profile(false);
    new_profile.effective_from = "2026-03-01".into();
    store.create_vat_profile(new_profile).unwrap();
    classify(&store, "expense", id, "non_deductible");
    let result = store.set_vat_source_classification(VatSourceClassificationInput {
        source_type: "expense".into(), source_id: id.into(),
        treatment: "input_materials".into(), note: None,
    });
    assert!(result.is_err(), "a later registration must not establish a past input deduction");
    let mut connection = store.connect().unwrap();
    let tx = connection.transaction().unwrap();
    crate::accounting::post_expense_if_enabled(&tx, id).unwrap();
    tx.commit().unwrap();
    assert_eq!(journal_count(&store), count);
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 10810);
    assert_eq!(balance(&store, &accounts["vat_receivable"], "2026-03-31"), 0);
}

#[test]
fn dated_vat_profile_preserves_registered_purchases_after_current_setting_is_disabled() {
    let (_temp, store, accounts) = fixture();
    let mut past = profile(false);
    past.effective_to = Some("2026-03-31".into());
    store.create_vat_profile(past).unwrap();
    store.connect().unwrap().execute("UPDATE settings SET vat_registered=0,vat_number=NULL WHERE id=1", []).unwrap();
    let (invoice, lines) = draft(&store);
    for line in &lines { classify(&store, "supplier_invoice_item", line, "input_materials"); }
    store.validate_supplier_invoice(&invoice).unwrap();
    assert_eq!(balance(&store, &accounts["expense"], "2026-03-31"), 20000);
    assert_eq!(balance(&store, &accounts["vat_receivable"], "2026-03-31"), 1620);
}


#[test]
fn supplier_rates_do_not_depend_on_the_buyers_registration_or_sales_rate_choices() {
    let (_temp, store, _accounts) = fixture_with_registration(false);
    let supplier = store.create_record("suppliers", json!({"name":"Fournisseur taxé"})).unwrap();
    let input: crate::models::SaveSupplierOrderDraftInput = serde_json::from_value(json!({
        "order":{"id":Uuid::new_v4().to_string(),"supplier_id":supplier["id"],"title":"Achats à plusieurs taux","order_date":"2026-02-01","currency":"CHF"},
        "lines":([260,380,810].iter().enumerate().map(|(index,rate)| json!({"id":Uuid::new_v4().to_string(),"position":index,"description":"Prestation fournisseur","quantity_milli":1000,"unit":"forfait","unit_price_cents":10000,"discount_bp":0,"vat_bp":rate,"category":"Achats","fulfillment_mode":"direct"})).collect::<Vec<_>>())
    })).unwrap();
    let order_id = input.order.id.clone().unwrap();
    store.save_supplier_order_draft(input.clone()).unwrap();
    let amounts: (i64,i64,i64) = store.connect().unwrap().query_row(
        "SELECT subtotal_cents,vat_cents,total_cents FROM supplier_orders WHERE id=?", params![order_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).unwrap();
    assert_eq!(amounts, (30000,1450,31450));
    assert_eq!(journal_count(&store), 0, "a purchase order has no accounting impact");
    let mut old_rate = input;
    old_rate.lines[0].vat_bp = 770;
    assert!(store.save_supplier_order_draft(old_rate.clone()).is_err(), "historical rates must be explicitly configured");
    store.connect().unwrap().execute("UPDATE settings SET extra_settings_json=json_set(extra_settings_json,'$.billing.vatRatesBp',json('[770]')) WHERE id=1", []).unwrap();
    store.save_supplier_order_draft(old_rate).unwrap();
}
