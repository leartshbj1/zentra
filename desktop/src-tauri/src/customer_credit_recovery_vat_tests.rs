use super::*;
use crate::customer_credit_recovery_vat;

fn received_legacy(fully_paid: bool) -> (tempfile::TempDir, LocalStore, String, Vec<String>) {
    let (dir, store, client) = fixture();
    received(&store);
    let invoice = document(&store, &client, None, &[(10_000, 810)]);
    issue(&store, &invoice, "2026-02-01").unwrap();
    if fully_paid {
        pay(&store, &invoice, 10_810, "2026-02-15");
    }
    // Build an old-version fixture: only the credit lacks its journal before
    // legacy synchronization. This is deliberately not a production command.
    store
        .connect()
        .unwrap()
        .execute("UPDATE accounting_settings SET enabled=0 WHERE id=1", [])
        .unwrap();
    let credit = document(&store, &client, Some(&invoice), &[(5_000, 810)]);
    issue(&store, &credit, "2026-03-01").unwrap();
    let c = store.connect().unwrap();
    crate::schema::remove_v52_for_legacy_fixture(&c);
    c.execute_batch(crate::schema::MIGRATION_V52_SQL).unwrap();
    drop(c);
    drop(store);
    let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
    let mut settings = store.get_accounting_settings().unwrap();
    settings["enabled"] = json!(true);
    store
        .configure_accounting(serde_json::from_value(settings).unwrap())
        .unwrap();
    if !fully_paid {
        pay(&store, &invoice, 3_000, "2026-04-01");
    }
    (dir, store, invoice, vec![credit])
}

#[test]
fn received_recovery_preserves_originals_and_reprojects_an_application_before_payment() {
    let (_dir, store, invoice, credits) = received_legacy(false);
    let mut request = input(&store, &invoice, &credits);
    let before = financial_snapshot(&store);
    let preview = store
        .preview_customer_credit_recovery(request.clone())
        .unwrap();
    assert_eq!(before, financial_snapshot(&store));
    assert_eq!(preview["received_vat"], true);
    assert!(store
        .adopt_customer_credit_recovery(request.clone())
        .unwrap_err()
        .to_string()
        .contains("confirmez"));
    request.confirm_vat_reconciliation = true;
    store
        .adopt_customer_credit_recovery(request.clone())
        .unwrap();
    assert_eq!(
        store.adopt_customer_credit_recovery(request).unwrap()["idempotent"],
        true
    );
    let c = store.connect().unwrap();
    assert!(customer_credit_recovery_vat::proof_valid(&c, &invoice).unwrap());
    assert!(crate::accounting::cash_vat_invoice_is_consistent(&c, &invoice).unwrap());
    for table in ["journal_entries", "journal_lines", "payments"] {
        let actual = query_all(&c, &format!("SELECT * FROM {table}"), []).unwrap();
        for row in before[table].as_array().unwrap() {
            assert!(actual.contains(row), "original {table} was changed");
        }
    }
    assert_eq!(
        crate::customer_credit_math::project(&c, &invoice, "9999-12-31")
            .unwrap()
            .remaining()
            .unwrap(),
        5_107
    );
    assert_eq!(
        store.get_accounting_continuity().unwrap()["semantic_posting_mismatches"],
        0
    );
    pay(&store, &invoice, 5_107, "2026-05-01");
    assert!(crate::accounting::cash_vat_invoice_is_consistent(&c, &invoice).unwrap());
    classify_customer_lines(&store);
    let report = customer_vat_preview(&store, "2026-04-01", "2026-06-30");
    assert!(
        report.blocking_issues.is_empty(),
        "{:?}",
        report.blocking_issues
    );
}

#[test]
fn received_recovery_restores_due_vat_until_actual_refund_and_protects_its_journal() {
    let (_dir, store, invoice, credits) = received_legacy(true);
    let mut request = input(&store, &invoice, &credits);
    request.credits[0].applied_cents = 0;
    request.credits[0].application_date = None;
    let preview = store
        .preview_customer_credit_recovery(request.clone())
        .unwrap();
    assert_eq!(preview["vat_change_cents"], 405);
    request.confirm_vat_reconciliation = true;
    store.adopt_customer_credit_recovery(request).unwrap();
    assert_eq!(cash_vat_due(&store, "2026-03-31"), 810);
    let c = store.connect().unwrap();
    let jid:String=c.query_row("SELECT journal_entry_id FROM customer_credit_recovery_postings WHERE source_type='credit'",[],|r|r.get(0)).unwrap();
    assert!(store
        .reverse_journal_entry(&jid, "2026-04-01", None)
        .is_err());
    let original_credit: String = c
        .query_row(
            "SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=?",
            [&credits[0]],
            |r| r.get(0),
        )
        .unwrap();
    assert!(store
        .reverse_journal_entry(&original_credit, "2026-04-01", None)
        .unwrap_err()
        .to_string()
        .contains("reprise TVA"));
    let journal = store
        .get_journal(crate::models::PeriodFilter {
            date_from: Some("2026-03-01".into()),
            date_to: Some("2026-03-31".into()),
        })
        .unwrap();
    assert_eq!(
        journal["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == original_credit)
            .unwrap()["customer_recovery_protected"],
        true
    );
    store
        .record_customer_credit_settlement(refund_input(&store, &credits[0], 5_405, "2026-04-01"))
        .unwrap();
    assert_eq!(cash_vat_due(&store, "2026-04-30"), 405);
    classify_customer_lines(&store);
    let report = customer_vat_preview(&store, "2026-04-01", "2026-06-30");
    assert!(
        report.blocking_issues.is_empty(),
        "{:?}",
        report.blocking_issues
    );
}

#[test]
fn received_recovery_failure_rolls_back_corrections_and_preserves_retry() {
    let (_dir, store, invoice, credits) = received_legacy(false);
    let mut request = input(&store, &invoice, &credits);
    request.confirm_vat_reconciliation = true;
    let c = store.connect().unwrap();
    c.execute_batch("CREATE TRIGGER qa_fail_received BEFORE INSERT ON customer_credit_recoveries BEGIN SELECT RAISE(ABORT,'late received correction failure'); END;").unwrap();
    let before = financial_snapshot(&store);
    assert!(store
        .adopt_customer_credit_recovery(request.clone())
        .is_err());
    assert_eq!(before, financial_snapshot(&store));
    c.execute_batch("DROP TRIGGER qa_fail_received;").unwrap();
    store.adopt_customer_credit_recovery(request).unwrap();
    assert!(customer_credit_recovery_vat::proof_valid(&c, &invoice).unwrap());
    assert_eq!(c.query_row("SELECT due_change_cents FROM customer_credit_recovery_postings WHERE source_type='payment'",[],|r|r.get::<_,i64>(0)).unwrap(),-1,"a one-cent legacy rounding difference must be posted, never silently relabelled");
    let (_other_dir, other, original, notes) = received_legacy(false);
    other.connect().unwrap().execute_batch("DROP TRIGGER journal_lines_no_update; UPDATE journal_lines SET account_id=(SELECT vat_payable_account_id FROM accounting_settings WHERE id=1) WHERE memo='Encaissement';").unwrap();
    let invalid_request = input(&other, &original, &notes);
    let before = financial_snapshot(&other);
    assert!(other
        .preview_customer_credit_recovery(invalid_request)
        .is_err());
    assert_eq!(
        before,
        financial_snapshot(&other),
        "an old bank journal in a liability account must not be adopted"
    );
}

#[test]
fn received_recovery_corrupted_proof_blocks_money_reports_and_closing_without_hiding_workspace() {
    let (_dir, store, invoice, credits) = received_legacy(true);
    let mut request = input(&store, &invoice, &credits);
    request.confirm_vat_reconciliation = true;
    request.credits[0].applied_cents = 0;
    request.credits[0].application_date = None;
    store.adopt_customer_credit_recovery(request).unwrap();
    classify_customer_lines(&store);
    let c = store.connect().unwrap();
    c.execute_batch("DROP TRIGGER customer_recovery_posting_no_update; UPDATE customer_credit_recovery_postings SET snapshot_json='{}' WHERE source_type='credit';").unwrap();
    assert!(!customer_credit_recovery_vat::proof_valid(&c, &invoice).unwrap());
    let before = financial_snapshot(&store);
    assert!(store
        .record_customer_credit_settlement(refund_input(&store, &credits[0], 2_703, "2026-04-01"))
        .is_err());
    assert_eq!(before, financial_snapshot(&store));
    let continuity = store.get_accounting_continuity().unwrap();
    assert!(
        continuity["customer_credit_issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["kind"] == "invalid_posting"),
        "{continuity}"
    );
    let vat = customer_vat_preview(&store, "2026-01-01", "2026-03-31");
    assert!(!vat.exportable);
    let period = store
        .upsert_accounting_period(crate::models::AccountingPeriodInput {
            id: None,
            name: "Période contrôlée".into(),
            date_from: "2026-01-01".into(),
            date_to: "2026-03-31".into(),
        })
        .unwrap();
    assert!(store
        .close_accounting_period(period["id"].as_str().unwrap())
        .is_err());
}

#[test]
fn received_recovery_proofs_survive_real_exports_restore_and_later_credit_issues() {
    let (dir, store, invoice, credits) = received_legacy(false);
    let mut request = input(&store, &invoice, &credits);
    request.confirm_vat_reconciliation = true;
    store
        .adopt_customer_credit_recovery(request.clone())
        .unwrap();
    let c = store.connect().unwrap();
    let proofs = query_all(
        &c,
        "SELECT * FROM customer_credit_recovery_postings ORDER BY id",
        [],
    )
    .unwrap();
    let path = store
        .export_csv_archive(
            Some(
                dir.path()
                    .join("received.zip")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let mut csv = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut text = String::new();
    csv.by_name("02_ventes/corrections_reprise_tva_clients.csv")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert!(text.contains(proofs[0]["id"].as_str().unwrap()));
    assert!(text.contains("Rétablissement TVA historique"));
    store
        .upsert_accounting_period(crate::models::AccountingPeriodInput {
            id: None,
            name: "TVA reprise".into(),
            date_from: "2026-01-01".into(),
            date_to: "2026-06-30".into(),
        })
        .unwrap();
    let review = store
        .prepare_fiduciary_pre_closing(crate::models::PeriodFilter {
            date_from: Some("2026-01-01".into()),
            date_to: Some("2026-06-30".into()),
        })
        .unwrap();
    let closing = store
        .export_fiduciary_closing_zip(review["review_id"].as_str().unwrap(), "test")
        .unwrap();
    let mut zip =
        zip::ZipArchive::new(std::fs::File::open(closing["path"].as_str().unwrap()).unwrap())
            .unwrap();
    let mut text = String::new();
    zip.by_name("02_pieces/corrections_tva_avoirs_clients.csv")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert!(text.contains(proofs[0]["id"].as_str().unwrap()));
    let backup = store
        .create_backup(
            Some(
                dir.path()
                    .join("received.zentra")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let restored = LocalStore::initialize(dir.path().join("restored")).unwrap();
    restored.restore_backup(&backup, "test").unwrap();
    assert_eq!(
        proofs,
        query_all(
            &restored.connect().unwrap(),
            "SELECT * FROM customer_credit_recovery_postings ORDER BY id",
            []
        )
        .unwrap()
    );
    assert!(
        customer_credit_recovery_vat::proof_valid(&restored.connect().unwrap(), &invoice).unwrap()
    );
    assert_eq!(
        restored.adopt_customer_credit_recovery(request).unwrap()["idempotent"],
        true
    );
    let client: String = c
        .query_row(
            "SELECT client_id FROM invoices WHERE id=?",
            [&invoice],
            |r| r.get(0),
        )
        .unwrap();
    let later = document(&store, &client, Some(&invoice), &[(1_000, 810)]);
    issue(&store, &later, "2026-05-01").unwrap();
    assert_eq!(
        store.get_accounting_continuity().unwrap()["semantic_posting_mismatches"],
        0
    );
}

#[test]
fn received_recovery_available_credit_keeps_exact_payment_model_without_an_application() {
    let (_dir, store, invoice, credits) = received_legacy(false);
    let mut request = input(&store, &invoice, &credits);
    request.confirm_vat_reconciliation = true;
    request.credits[0].applied_cents = 0;
    request.credits[0].application_date = None;
    store.adopt_customer_credit_recovery(request).unwrap();
    pay(&store, &invoice, 7_810, "2026-05-01");
    assert!(
        crate::accounting::cash_vat_invoice_is_consistent(&store.connect().unwrap(), &invoice)
            .unwrap()
    );
    assert_eq!(cash_vat_due(&store, "2026-05-31"), 810);
    classify_customer_lines(&store);
    let vat = customer_vat_preview(&store, "2026-04-01", "2026-06-30");
    assert!(vat.exportable, "{:?}", vat.blocking_issues);
    assert_eq!(
        store.get_accounting_continuity().unwrap()["semantic_posting_mismatches"],
        0
    );
}
