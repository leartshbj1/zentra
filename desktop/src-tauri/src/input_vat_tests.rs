use std::collections::HashMap;

use rusqlite::params;
use serde_json::json;
use uuid::Uuid;

use crate::{
    database::LocalStore,
    models::{
        ReclassifySupplierInvoiceExpenseInput, SaveSupplierInvoiceDraftInput,
        SupplierExpenseReclassificationLineInput, SupplierInvoiceLineInput,
    },
    vat_reporting::{VatProfileInput, VatReturnPreviewInput, VatSourceClassificationInput},
};

fn fixture() -> (tempfile::TempDir, LocalStore, HashMap<&'static str, String>) {
    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temp.path().join("profile")).unwrap();
    let mut settings = crate::tests::test_onboarding();
    settings.vat_registered = true;
    settings.vat_number = Some("CHE-123.456.789 TVA".into());
    settings.default_vat_bp = Some(810);
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
    assert!(preview.classified_sources.iter().any(|source| source.source.source_id == lines[0] && source.treatment == "non_deductible" && source.currency == "CHF"));
    // Archived export payloads from 1.27 did not contain the review list.
    let mut legacy = serde_json::to_value(&preview).unwrap();
    legacy.as_object_mut().unwrap().remove("classified_sources");
    let old: crate::vat_reporting::VatReturnPreview = serde_json::from_value(legacy).unwrap();
    assert!(old.classified_sources.is_empty());
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
