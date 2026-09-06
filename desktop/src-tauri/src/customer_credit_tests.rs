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
fn customer_credit_received_vat_waits_for_settlement_after_full_payment() {
    let (_temporary, store, client) = fixture();
    store
        .create_vat_profile(crate::vat_reporting::VatProfileInput {
            id: None,
            effective_from: "2026-01-01".into(),
            effective_to: None,
            reporting_method: "effective".into(),
            form_of_reporting: "received".into(),
            periodicity: "quarterly".into(),
            gross_or_net: "net".into(),
            tdfn_activity_id: None,
            tdfn_rate_bp: None,
            afc_authorization_confirmed: true,
            notes: None,
            close_previous_open_profile: false,
        })
        .unwrap();
    let original = document(&store, &client, None, &[(10_000, 810)]);
    issue(&store, &original, "2026-02-01").unwrap();
    store
        .record_payment(crate::models::RecordPaymentInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            invoice_id: original.clone(),
            amount_cents: 10_810,
            date: Some("2026-02-15".into()),
            method: Some("bank".into()),
            reference: None,
            notes: None,
        })
        .unwrap();
    let credit = document(&store, &client, Some(&original), &[(5_000, 810)]);
    issue(&store, &credit, "2026-03-01").unwrap();
    let connection = store.connect().unwrap();
    let due: i64=connection.query_row(
        "SELECT COALESCE(SUM(l.credit_cents-l.debit_cents),0) FROM journal_lines l JOIN accounting_settings s ON s.vat_payable_account_id=l.account_id",
        [],|row|row.get(0),
    ).unwrap();
    assert_eq!(due,810,"an issued credit without a dated settlement must not reduce the VAT already due on the fully paid sale");
    drop(connection);
    let first = refund_input(&store, &credit, 2_703, "2026-04-01");
    let recorded = store
        .record_customer_credit_settlement(first.clone())
        .unwrap();
    assert_eq!(recorded["balance"]["remaining_cents"], 2_702);
    assert_eq!(cash_vat_due(&store, "2026-03-31"), 810);
    assert_eq!(cash_vat_due(&store, "2026-04-01"), 607);
    assert_eq!(
        store.record_customer_credit_settlement(first).unwrap()["idempotent"],
        true
    );
    assert_eq!(cash_vat_due(&store, "2026-04-01"), 607);
    let reversal = crate::customer_credit_settlements::ReverseCustomerCreditSettlementInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        settlement_id: recorded["settlement"]["id"].as_str().unwrap().into(),
        date: "2026-04-02".into(),
        reason: "Virement retourné par la banque".into(),
    };
    store
        .reverse_customer_credit_settlement(reversal.clone())
        .unwrap();
    assert_eq!(cash_vat_due(&store, "2026-04-02"), 810);
    assert_eq!(
        store.reverse_customer_credit_settlement(reversal).unwrap()["idempotent"],
        true
    );
    let final_refund = store
        .record_customer_credit_settlement(refund_input(&store, &credit, 5_405, "2026-05-01"))
        .unwrap();
    assert_eq!(final_refund["balance"]["remaining_cents"], 0);
    assert_eq!(cash_vat_due(&store, "2026-05-01"), 405);
    assert_eq!(
        cash_vat_due(&store, "2026-03-31"),
        810,
        "later refunds must never rewrite the first quarter"
    );
}

fn received(store: &LocalStore) {
    store
        .create_vat_profile(crate::vat_reporting::VatProfileInput {
            id: None,
            effective_from: "2026-01-01".into(),
            effective_to: None,
            reporting_method: "effective".into(),
            form_of_reporting: "received".into(),
            periodicity: "quarterly".into(),
            gross_or_net: "net".into(),
            tdfn_activity_id: None,
            tdfn_rate_bp: None,
            afc_authorization_confirmed: true,
            notes: None,
            close_previous_open_profile: false,
        })
        .unwrap();
}

fn customer_vat_preview(
    store: &LocalStore,
    from: &str,
    to: &str,
) -> crate::vat_reporting::VatReturnPreview {
    store
        .preview_vat_return(crate::vat_reporting::VatReturnPreviewInput {
            date_from: from.into(),
            date_to: to.into(),
            submission_type: "initial".into(),
            profile_id: None,
        })
        .unwrap()
}

fn classify_customer_lines(store: &LocalStore) {
    let connection = store.connect().unwrap();
    let mut statement = connection
        .prepare("SELECT id FROM invoice_items ORDER BY id")
        .unwrap();
    let ids = statement
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for id in ids {
        store
            .set_vat_source_classification(crate::vat_reporting::VatSourceClassificationInput {
                source_type: "invoice_item".into(),
                source_id: id,
                treatment: "taxable".into(),
                note: None,
            })
            .unwrap();
    }
}

#[test]
fn customer_credit_received_reports_follow_refunds_and_exact_reversals() {
    let (_temp, store, client) = fixture();
    received(&store);
    let invoice = document(&store, &client, None, &[(10_000, 810), (10_000, 260)]);
    issue(&store, &invoice, "2026-02-01").unwrap();
    pay(&store, &invoice, 21_070, "2026-02-15");
    let credit = document(
        &store,
        &client,
        Some(&invoice),
        &[(5_000, 810), (5_000, 260)],
    );
    issue(&store, &credit, "2026-03-01").unwrap();
    classify_customer_lines(&store);
    let q1 = customer_vat_preview(&store, "2026-01-01", "2026-03-31");
    assert!(q1.exportable, "{:?}", q1.blocking_issues);
    assert_eq!(q1.payable_tax_cents, 1_070);
    let recorded = store
        .record_customer_credit_settlement(refund_input(&store, &credit, 5_001, "2026-04-01"))
        .unwrap();
    let q2 = customer_vat_preview(&store, "2026-04-01", "2026-06-30");
    assert!(q2.exportable, "{:?}", q2.blocking_issues);
    assert_eq!(
        q2.received_allocations
            .iter()
            .map(|r| r.payment.gross_cents)
            .sum::<i64>(),
        -5_001
    );
    assert_eq!(
        q2.payable_tax_cents,
        cash_vat_due(&store, "2026-06-30") - 1_070
    );
    store
        .reverse_customer_credit_settlement(
            crate::customer_credit_settlements::ReverseCustomerCreditSettlementInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                settlement_id: recorded["settlement"]["id"].as_str().unwrap().into(),
                date: "2026-07-01".into(),
                reason: "Retour bancaire du remboursement".into(),
            },
        )
        .unwrap();
    let q3 = customer_vat_preview(&store, "2026-07-01", "2026-09-30");
    assert!(q3.exportable, "{:?}", q3.blocking_issues);
    assert_eq!(q3.payable_tax_cents, -q2.payable_tax_cents);
    for original in &q2.received_allocations {
        let reversed = q3
            .received_allocations
            .iter()
            .find(|r| r.source_id == original.source_id)
            .unwrap();
        assert_eq!(reversed.payment.gross_cents, -original.payment.gross_cents);
        assert_eq!(reversed.payment.vat_cents, -original.payment.vat_cents);
        assert_eq!(
            reversed
                .payment
                .settlement
                .as_ref()
                .unwrap()
                .reverses_allocation_id
                .as_deref(),
            Some(recorded["settlement"]["id"].as_str().unwrap())
        );
    }
    assert_eq!(
        customer_vat_preview(&store, "2026-01-01", "2026-03-31").source_sha256,
        q1.source_sha256
    );
    assert_eq!(
        customer_vat_preview(&store, "2026-04-01", "2026-06-30").source_sha256,
        q2.source_sha256
    );
}

#[test]
fn customer_credit_received_application_is_reported_on_both_documents() {
    let (_temp, store, client) = fixture();
    received(&store);
    let invoice = document(&store, &client, None, &[(10_000, 810)]);
    issue(&store, &invoice, "2026-02-01").unwrap();
    pay(&store, &invoice, 5_405, "2026-02-15");
    let credit = document(&store, &client, Some(&invoice), &[(7_500, 810)]);
    issue(&store, &credit, "2026-03-01").unwrap();
    classify_customer_lines(&store);
    let q1 = customer_vat_preview(&store, "2026-01-01", "2026-03-31");
    assert!(q1.exportable, "{:?}", q1.blocking_issues);
    assert_eq!(q1.payable_tax_cents, 405);
    let applied: Vec<_> = q1
        .received_allocations
        .iter()
        .filter(|r| r.payment.settlement.is_some())
        .collect();
    assert_eq!(applied.len(), 2);
    assert_eq!(
        applied.iter().map(|r| r.payment.gross_cents).sum::<i64>(),
        0
    );
    assert_eq!(applied.iter().map(|r| r.payment.vat_cents).sum::<i64>(), 0);
    store
        .record_customer_credit_settlement(refund_input(&store, &credit, 2_703, "2026-04-01"))
        .unwrap();
    let q2 = customer_vat_preview(&store, "2026-04-01", "2026-06-30");
    assert!(q2.exportable, "{:?}", q2.blocking_issues);
    assert_eq!(q2.payable_tax_cents, -203);
    assert_eq!(
        customer_vat_preview(&store, "2026-01-01", "2026-03-31").source_sha256,
        q1.source_sha256
    );
}

#[test]
fn customer_credit_settlements_backfill_original_dates_after_accounting_activation() {
    let (_temp, store, client) = fixture();
    received(&store);
    let mut configuration = store.get_accounting_settings().unwrap();
    configuration["enabled"] = json!(false);
    store
        .configure_accounting(serde_json::from_value(configuration.clone()).unwrap())
        .unwrap();
    let invoice = document(&store, &client, None, &[(10_000, 810)]);
    issue(&store, &invoice, "2026-02-01").unwrap();
    let credit = document(&store, &client, Some(&invoice), &[(5_000, 810)]);
    issue(&store, &credit, "2026-03-01").unwrap();
    let application: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT id FROM customer_credit_settlements WHERE credit_note_id=?",
            [&credit],
            |row| row.get(0),
        )
        .unwrap();
    store
        .reverse_customer_credit_settlement(
            crate::customer_credit_settlements::ReverseCustomerCreditSettlementInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                settlement_id: application,
                date: "2026-03-02".into(),
                reason: "Annulation de la compensation client".into(),
            },
        )
        .unwrap();
    let refund = store
        .record_customer_credit_settlement(refund_input(&store, &credit, 2_703, "2026-04-01"))
        .unwrap();
    store
        .reverse_customer_credit_settlement(
            crate::customer_credit_settlements::ReverseCustomerCreditSettlementInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                settlement_id: refund["settlement"]["id"].as_str().unwrap().into(),
                date: "2026-04-02".into(),
                reason: "Retour bancaire avant activation".into(),
            },
        )
        .unwrap();
    assert_eq!(
        store.get_accounting_continuity().unwrap()["missing_customer_credit_settlements"],
        4
    );
    configuration["enabled"] = json!(true);
    store
        .configure_accounting(serde_json::from_value(configuration.clone()).unwrap())
        .unwrap();
    let continuity = store.get_accounting_continuity().unwrap();
    assert_eq!(continuity["total_missing"], 0, "{continuity}");
    assert_eq!(continuity["semantic_posting_mismatches"], 0, "{continuity}");
    assert_eq!(cash_vat_due(&store, "2026-03-31"), 0);
    assert_eq!(cash_vat_due(&store, "2026-04-01"), -203);
    assert_eq!(cash_vat_due(&store, "2026-04-02"), 0);
    let entries = continuity["journal_entry_count"].clone();
    store
        .configure_accounting(serde_json::from_value(configuration).unwrap())
        .unwrap();
    assert_eq!(
        store.get_accounting_continuity().unwrap()["journal_entry_count"],
        entries
    );
}
fn pay(store: &LocalStore, invoice: &str, amount: i64, date: &str) {
    store
        .record_payment(crate::models::RecordPaymentInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            invoice_id: invoice.into(),
            amount_cents: amount,
            date: Some(date.into()),
            method: Some("bank".into()),
            reference: None,
            notes: None,
        })
        .unwrap();
}

#[test]
fn customer_credit_refund_late_failure_rolls_back_money_and_identical_retry_posts_once() {
    let (_temp, store, client) = fixture();
    received(&store);
    let invoice = document(&store, &client, None, &[(10_000, 810)]);
    issue(&store, &invoice, "2026-02-01").unwrap();
    pay(&store, &invoice, 10_810, "2026-02-15");
    let credit = document(&store, &client, Some(&invoice), &[(5_000, 810)]);
    issue(&store, &credit, "2026-03-01").unwrap();
    let input = refund_input(&store, &credit, 2_703, "2026-04-01");
    let connection = store.connect().unwrap();
    let before: i64 = connection
        .query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0))
        .unwrap();
    connection.execute_batch("CREATE TRIGGER qa_customer_fail BEFORE INSERT ON customer_credit_settlement_lines BEGIN SELECT RAISE(ABORT,'forced late allocation failure'); END;").unwrap();
    assert!(store
        .record_customer_credit_settlement(input.clone())
        .is_err());
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM customer_credit_settlements",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM customer_credit_settlement_postings",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert_eq!(cash_vat_due(&store, "2026-04-01"), 810);
    connection
        .execute_batch("DROP TRIGGER qa_customer_fail;")
        .unwrap();
    let saved = store
        .record_customer_credit_settlement(input.clone())
        .unwrap();
    let replay = store
        .record_customer_credit_settlement(input.clone())
        .unwrap();
    assert_eq!(replay["idempotent"], true);
    assert_eq!(replay["settlement"]["id"], saved["settlement"]["id"]);
    let mut changed = input.clone();
    changed.amount_cents -= 1;
    assert!(store.record_customer_credit_settlement(changed).is_err());
    connection
        .execute_batch("DROP TRIGGER journal_lines_no_update;")
        .unwrap();
    connection.execute("UPDATE journal_lines SET memo='preuve modifiée' WHERE journal_entry_id=? AND memo='Remboursement au client'",[saved["settlement"]["journal_entry_id"].as_str().unwrap()]).unwrap();
    assert!(store.record_customer_credit_settlement(input).is_err());
    classify_customer_lines(&store);
    let report = customer_vat_preview(&store, "2026-04-01", "2026-06-30");
    assert!(!report.exportable);
    assert!(report
        .blocking_issues
        .iter()
        .any(|issue| issue.code == "customer_credit_settlement_posting_mismatch"));
}
fn cash_vat_due(store: &LocalStore, through: &str) -> i64 {
    store.connect().unwrap().query_row("SELECT COALESCE(SUM(l.credit_cents-l.debit_cents),0) FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id JOIN accounting_settings s ON s.vat_payable_account_id=l.account_id WHERE j.entry_date<=?",[through],|row|row.get(0)).unwrap()
}

#[test]
fn customer_credit_migration_52_preserves_legacy_money_without_inventing_settlements() {
    let (temporary, store, client) = fixture();
    received(&store);
    let invoice = document(&store, &client, None, &[(10_000, 810)]);
    issue(&store, &invoice, "2026-02-01").unwrap();
    pay(&store, &invoice, 10_810, "2026-02-15");
    let credit = document(&store, &client, Some(&invoice), &[(5_000, 810)]);
    issue(&store, &credit, "2026-03-01").unwrap();
    classify_customer_lines(&store);
    let connection = store.connect().unwrap();
    // Reproduce the verified v52 journal: a fully paid sale's credit reduced due
    // VAT at issue. The additive migration must preserve that historical fact.
    connection
        .execute_batch("DROP TRIGGER journal_lines_no_update;")
        .unwrap();
    connection.execute("UPDATE journal_lines SET account_id=(SELECT vat_payable_account_id FROM accounting_settings WHERE id=1),memo='Extourne TVA due encaissée' WHERE journal_entry_id=(SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=? AND source_event='issue') AND memo=?",rusqlite::params![credit,crate::customer_credit_settlements::PENDING_VAT]).unwrap();
    connection.execute_batch("CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines BEGIN SELECT RAISE(ABORT,'posted journal lines are immutable'); END;").unwrap();
    let before =
        crate::database::query_all(&connection, "SELECT * FROM journal_lines ORDER BY id", [])
            .unwrap();
    crate::schema::remove_v52_for_legacy_fixture(&connection);
    // The helper also removes v52's bank-only tables: reinstall them for a true v52 layout.
    connection
        .execute_batch(crate::schema::MIGRATION_V52_SQL)
        .unwrap();
    drop(connection);
    drop(store);
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    let connection = store.connect().unwrap();
    assert_eq!(
        crate::database::query_all(&connection, "SELECT * FROM journal_lines ORDER BY id", [])
            .unwrap(),
        before
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM customer_credit_documents", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM customer_credit_settlements",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(cash_vat_due(&store, "2026-03-31"), 405);
    let report = customer_vat_preview(&store, "2026-01-01", "2026-03-31");
    assert!(!report.exportable);
    assert!(report
        .blocking_issues
        .iter()
        .any(|issue| issue.code == "received_credit_note_timing_unknown"));
    assert!(store
        .record_customer_credit_settlement(refund_input(&store, &credit, 5_405, "2026-04-01"))
        .unwrap_err()
        .to_string()
        .contains("reprise documentée"));
}
fn refund_input(
    store: &LocalStore,
    credit: &str,
    amount: i64,
    date: &str,
) -> crate::customer_credit_settlements::CustomerCreditSettlementInput {
    let bank: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT bank_account_id FROM accounting_settings WHERE id=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    crate::customer_credit_settlements::CustomerCreditSettlementInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        credit_note_id: credit.into(),
        event_type: "refund".into(),
        invoice_id: None,
        date: date.into(),
        amount_cents: amount,
        bank_account_id: Some(bank),
        reference: "Virement de remboursement".into(),
        reason: "Remboursement au client confirmé sur le relevé bancaire".into(),
    }
}

#[test]
fn customer_credit_partial_sale_splits_deduction_and_refund_without_fictitious_cash() {
    let (_temporary, store, client) = fixture();
    received(&store);
    let original = document(&store, &client, None, &[(10_000, 810)]);
    issue(&store, &original, "2026-02-01").unwrap();
    pay(&store, &original, 5_405, "2026-02-15");
    let credit = document(&store, &client, Some(&original), &[(7_500, 810)]);
    issue(&store, &credit, "2026-03-01").unwrap();
    let connection = store.connect().unwrap();
    let balance:(i64,i64,i64)=connection.query_row("SELECT allocated_cents,refunded_cents,remaining_cents FROM customer_credit_balances WHERE credit_note_id=?",[&credit],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(balance, (5_405, 0, 2_703));
    assert_eq!(cash_vat_due(&store, "2026-03-31"), 405);
    drop(connection);
    let result = store
        .record_customer_credit_settlement(refund_input(&store, &credit, 2_703, "2026-04-01"))
        .unwrap();
    assert_eq!(result["balance"]["remaining_cents"], 0);
    assert_eq!(cash_vat_due(&store, "2026-04-01"), 202);
    assert_eq!(
        store.get_accounting_continuity().unwrap()["semantic_posting_mismatches"],
        0
    );
}

#[test]
fn customer_credit_application_then_later_cash_payment_releases_each_remaining_tax_cent() {
    let (_temporary, store, client) = fixture();
    received(&store);
    let original = document(&store, &client, None, &[(10_000, 810)]);
    issue(&store, &original, "2026-02-01").unwrap();
    pay(&store, &original, 5_405, "2026-02-15");
    let credit = document(&store, &client, Some(&original), &[(2_000, 810)]);
    issue(&store, &credit, "2026-03-01").unwrap();
    assert_eq!(cash_vat_due(&store, "2026-03-31"), 405);
    pay(&store, &original, 3_243, "2026-04-01");
    assert_eq!(cash_vat_due(&store, "2026-04-01"), 648);
    let workspace = store.get_workspace().unwrap();
    let invoice = workspace["invoices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == original)
        .unwrap();
    assert_eq!(invoice["credited_cents"], 2_162);
    assert_eq!(invoice["paid_cents"], 8_648);
    assert_eq!(invoice["status"], "payee");
    assert_eq!(
        store.get_accounting_continuity().unwrap()["semantic_posting_mismatches"],
        0
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
