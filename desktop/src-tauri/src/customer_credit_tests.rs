use crate::{
    database::LocalStore,
    tests::{enable_accounting, test_onboarding},
};
use serde_json::{json, Value};

fn fixture() -> (tempfile::TempDir, LocalStore, String) {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    let mut settings = test_onboarding();
    settings.vat_registered = true;
    settings.vat_number = Some("CHE-123.456.789 TVA".into());
    settings.default_vat_bp = Some(810);
    store.complete_onboarding(settings, "1.37.0").unwrap();
    enable_accounting(&store);
    let client = store
        .create_record(
            "clients",
            json!({
                "name":"Client avoirs", "address_line1":"Rue du Client", "address_line2":"7",
                "postal_code":"1000", "city":"Lausanne", "country":"CH"
            }),
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (temporary, store, client)
}

fn document(
    store: &LocalStore,
    client: &str,
    original: Option<&str>,
    lines: &[(i64, i64)],
) -> String {
    let invoice = store
        .create_record(
            "invoices",
            json!({
                "client_id":client, "title":"Document de contrôle des avoirs",
                "type":if original.is_some() { "credit_note" } else { "standard" },
                "original_invoice_id":original,
                "service_date_from":"2026-02-01", "service_date_to":"2026-02-01"
            }),
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for &(net, rate) in lines {
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":invoice, "description":format!("Prestation {rate}"),
                    "quantity":1, "unit":"forfait", "unit_price_cents":net, "vat_bp":rate
                }),
            )
            .unwrap();
    }
    invoice
}

fn issue(store: &LocalStore, id: &str, date: &str) -> crate::error::AppResult<Value> {
    store.issue_invoice(id, Some(date.into()), None)
}

fn assert_draft_without_posting(store: &LocalStore, id: &str) {
    let connection = store.connect().unwrap();
    let state: (Option<String>, String, i64) = connection.query_row(
        "SELECT number,status,(SELECT COUNT(*) FROM journal_entries WHERE source_type='invoice' AND source_id=invoices.id) FROM invoices WHERE id=?",
        [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ).unwrap();
    assert_eq!(
        state,
        (None, "brouillon".into(), 0),
        "a rejected issue must roll back numbering, signs and posting"
    );
    let negative: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id=? AND unit_price_cents<0)",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        !negative,
        "a rejected issue must also restore draft line signs"
    );
}

#[test]
fn customer_credit_rejects_a_rate_absent_from_the_original_invoice() {
    let (_temporary, store, client) = fixture();
    let original = document(&store, &client, None, &[(10_000, 260)]);
    issue(&store, &original, "2026-02-01").unwrap();
    // 54.05 CHF is below the 102.60 CHF invoice, but its 4.05 CHF VAT is not a
    // reversal of any original 8.1% taxable sale.
    let credit = document(&store, &client, Some(&original), &[(5_000, 810)]);
    let error = issue(&store, &credit, "2026-03-01")
        .unwrap_err()
        .to_string();
    assert!(error.contains("taux"), "{error}");
    assert_draft_without_posting(&store, &credit);
}

#[test]
fn customer_credit_enforces_each_tax_bucket_across_issued_credits() {
    let (_temporary, store, client) = fixture();
    let original = document(&store, &client, None, &[(10_000, 810), (30_000, 260)]);
    issue(&store, &original, "2026-02-01").unwrap();
    let first = document(&store, &client, Some(&original), &[(7_000, 810)]);
    issue(&store, &first, "2026-03-01").unwrap();
    let second = document(&store, &client, Some(&original), &[(4_000, 810)]);
    // The combined gross credit remains below the complete invoice, but the
    // original standard-rate sale would be over-credited by 10 CHF before VAT.
    let error = issue(&store, &second, "2026-03-02")
        .unwrap_err()
        .to_string();
    assert!(error.contains("taux"), "{error}");
    assert_draft_without_posting(&store, &second);
}

#[test]
fn customer_credit_cannot_precede_its_original_invoice() {
    let (_temporary, store, client) = fixture();
    let original = document(&store, &client, None, &[(10_000, 810)]);
    issue(&store, &original, "2026-02-15").unwrap();
    let credit = document(&store, &client, Some(&original), &[(5_000, 810)]);
    let error = issue(&store, &credit, "2026-02-01")
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("date") || error.contains("précéder"),
        "{error}"
    );
    assert_draft_without_posting(&store, &credit);
}

#[test]
fn customer_credit_preserves_valid_mixed_rates_and_ignores_other_drafts() {
    let (_temporary, store, client) = fixture();
    let original = document(
        &store,
        &client,
        None,
        &[(10_000, 810), (10_000, 260), (10_000, 0)],
    );
    issue(&store, &original, "2026-02-01").unwrap();
    let unused_draft = document(&store, &client, Some(&original), &[(10_000, 810)]);
    let first = document(
        &store,
        &client,
        Some(&original),
        &[(5_000, 810), (2_500, 260)],
    );
    issue(&store, &first, "2026-03-01").unwrap();
    let final_credit = document(
        &store,
        &client,
        Some(&original),
        &[(5_000, 810), (7_500, 260), (10_000, 0)],
    );
    let issued = issue(&store, &final_credit, "2026-03-02").unwrap();
    assert_eq!(issued["total_cents"], -23_100);
    assert_eq!(issue(&store, &final_credit, "2026-03-02").unwrap(), issued);
    assert_draft_without_posting(&store, &unused_draft);
    assert_eq!(
        store.get_accounting_continuity().unwrap()["semantic_posting_mismatches"],
        0
    );
}

#[test]
fn customer_credit_concurrent_issues_cannot_consume_the_same_tax_balance() {
    let (_temporary, store, client) = fixture();
    let original = document(&store, &client, None, &[(10_000, 810), (30_000, 260)]);
    issue(&store, &original, "2026-02-01").unwrap();
    let first = document(&store, &client, Some(&original), &[(6_000, 810)]);
    let second = document(&store, &client, Some(&original), &[(6_000, 810)]);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = [first.clone(), second.clone()]
        .into_iter()
        .map(|id| {
            let store = store.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                issue(&store, &id, "2026-03-01")
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(results
        .iter()
        .find_map(|result| result.as_ref().err())
        .unwrap()
        .to_string()
        .contains("taux"));
    let connection = store.connect().unwrap();
    let credited: (i64,i64,i64) = connection.query_row(
        "SELECT COUNT(*),SUM(-total_cents),SUM(-vat_cents) FROM invoices WHERE original_invoice_id=? AND number IS NOT NULL",
        [original], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ).unwrap();
    assert_eq!(credited, (1, 6_486, 486));
    assert!(store.verify_audit_log().unwrap()["valid"]
        .as_bool()
        .unwrap());
}

#[test]
fn customer_credit_preserves_the_tax_basis_after_settings_change() {
    let (_temporary, store, client) = fixture();
    let original = document(&store, &client, None, &[(10_000, 260)]);
    issue(&store, &original, "2026-02-01").unwrap();
    store
        .update_settings(json!({"default_vat_bp":810,"company_name":"Nouvelle raison sociale"}))
        .unwrap();
    let credit = document(&store, &client, Some(&original), &[(10_000, 260)]);
    assert_eq!(
        issue(&store, &credit, "2026-02-01").unwrap()["total_cents"],
        -10_260
    );
}

#[test]
fn customer_credit_cannot_reuse_the_deposit_deducted_from_a_balance_invoice() {
    let (_temporary, store, client) = fixture();
    let quote = store
        .create_record(
            "quotes",
            json!({"client_id":client,"title":"Dossier multi-taux"}),
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (net, rate) in [(10_000, 810), (30_000, 260)] {
        store.create_record("quote_items",json!({"quote_id":quote,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":net,"vat_bp":rate})).unwrap();
    }
    store
        .issue_quote(&quote, Some("2026-02-01".into()), Some("2026-03-01".into()))
        .unwrap();
    store.update_quote_status(&quote, "accepted").unwrap();
    let pair = store
        .convert_quote_to_invoice(crate::models::ConvertQuoteInput {
            quote_id: quote,
            title: None,
            deposit_percentage_bp: Some(5_000),
            issue_date: Some("2026-02-02".into()),
            due_date: Some("2026-03-01".into()),
            service_date_from: Some("2026-02-01".into()),
            service_date_to: Some("2026-02-01".into()),
        })
        .unwrap();
    let deposit = pair["invoice"]["id"].as_str().unwrap();
    let balance = pair["balance_invoice"]["id"].as_str().unwrap();
    store
        .update_record(
            "invoices",
            balance,
            json!({"service_date_from":"2026-02-01","service_date_to":"2026-02-01"}),
        )
        .unwrap();
    issue(&store, deposit, "2026-02-02").unwrap();
    issue(&store, balance, "2026-02-02").unwrap();
    let invalid = document(&store, &client, Some(balance), &[(6_000, 810)]);
    assert!(issue(&store, &invalid, "2026-03-01")
        .unwrap_err()
        .to_string()
        .contains("taux"));
    assert_draft_without_posting(&store, &invalid);
    let valid = document(
        &store,
        &client,
        Some(balance),
        &[(5_000, 810), (15_000, 260)],
    );
    assert_eq!(
        issue(&store, &valid, "2026-03-01").unwrap()["total_cents"],
        -20_795
    );
}
