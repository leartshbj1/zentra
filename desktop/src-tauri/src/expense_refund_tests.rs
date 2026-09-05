use super::*;
use crate::expense_refunds::ExpenseRefundInput;

fn purchase(store: &LocalStore, classified: bool) -> String {
    let row=store.create_record("expenses",json!({"date":"2026-02-10","paid_at":"2026-02-10","payment_status":"paid","supplier":"Fournisseur retours","reference":"EXP-001","net_cents":10000,"vat_cents":810})).unwrap();
    let id = row["id"].as_str().unwrap().to_owned();
    if classified {
        classify(store, "expense", &id, "input_materials");
    }
    id
}

fn input(expense: &str) -> ExpenseRefundInput {
    ExpenseRefundInput {
        request_id: Uuid::new_v4().to_string(),
        expense_id: expense.into(),
        credit_date: "2026-04-20".into(),
        payment_date: "2026-07-05".into(),
        reference: "AV-001".into(),
        reason: "Retour de la moitié des marchandises".into(),
        net_cents: 5000,
        vat_cents: 405,
        reverses_id: None,
    }
}

#[test]
fn expense_refund_posts_two_dates_and_adjusts_the_correct_vat_period_for_both_bases() {
    for received in [false, true] {
        let (_dir, store, accounts) = fixture();
        let mut vat = profile(false);
        if received {
            vat.form_of_reporting = "received".into();
            vat.afc_authorization_confirmed = true;
        }
        store.create_vat_profile(vat).unwrap();
        let expense = purchase(&store, true);
        let before = period_preview(&store, "2026-01-01", "2026-03-31");
        let request = input(&expense);
        let result = store.record_expense_refund(request.clone()).unwrap();
        let refund = &result["refund"];
        assert_eq!(refund["cost_cents"], 5000);
        assert_eq!(balance(&store, &accounts["expense"], "2026-04-30"), 5000);
        assert_eq!(
            balance(&store, &accounts["vat_receivable"], "2026-04-30"),
            405
        );
        assert_eq!(balance(&store, &accounts["bank"], "2026-04-30"), -10810);
        assert_eq!(balance(&store, &accounts["bank"], "2026-07-31"), -5405);
        let year = crate::models::PeriodFilter {
            date_from: Some("2026-01-01".into()),
            date_to: Some("2026-12-31".into()),
        };
        let income = store.get_income_statement(year.clone()).unwrap();
        assert_eq!(income["expense_cents"], 5000);
        assert_eq!(income["profit_cents"], -5000);
        let statement = store.get_balance_sheet(year).unwrap();
        assert_eq!(statement["assets_cents"], -5000);
        assert_eq!(statement["liabilities_cents"], 0);
        assert_eq!(statement["current_result_cents"], -5000);
        assert_eq!(statement["balanced"], true);
        assert_eq!(
            store.get_accounting_continuity().unwrap()["semantic_posting_mismatches"],
            0
        );
        let q1 = period_preview(&store, "2026-01-01", "2026-03-31");
        assert_eq!(q1.source_sha256, before.source_sha256);
        let q2 = period_preview(&store, "2026-04-01", "2026-06-30");
        let q3 = period_preview(&store, "2026-07-01", "2026-09-30");
        assert!(q2.exportable, "{:?}", q2.blocking_issues);
        assert!(q3.exportable, "{:?}", q3.blocking_issues);
        assert_eq!(q2.payable_tax_cents, if received { 0 } else { 405 });
        assert_eq!(q3.payable_tax_cents, if received { 405 } else { 0 });
        let journals = journal_count(&store);
        assert_eq!(
            store.record_expense_refund(request.clone()).unwrap()["already_recorded"],
            true
        );
        assert_eq!(journal_count(&store), journals);
        let mut changed = request;
        changed.reason = "Autre motif après réponse perdue".into();
        assert!(store.record_expense_refund(changed).is_err());
        for field in ["credit_journal_id", "payment_journal_id"] {
            assert!(store
                .reverse_journal_entry(refund[field].as_str().unwrap(), "2026-08-01", None)
                .unwrap_err()
                .to_string()
                .contains("depuis la dépense"));
        }
        assert_eq!(
            store.get_workspace().unwrap()["expenses"][0]["total_cents"],
            10810
        );
    }
}

#[test]
fn expense_refund_reversal_restores_cost_vat_cash_without_erasing_history() {
    let (_dir, store, accounts) = fixture();
    store.create_vat_profile(profile(false)).unwrap();
    let expense = purchase(&store, true);
    let refund = store.record_expense_refund(input(&expense)).unwrap()["refund"].clone();
    let mut correction = input(&expense);
    correction.reverses_id = Some(refund["id"].as_str().unwrap().into());
    correction.credit_date = "2026-08-01".into();
    correction.payment_date = "2026-08-01".into();
    correction.reason = "Saisie d’un remboursement erroné".into();
    let before_q2 = period_preview(&store, "2026-04-01", "2026-06-30");
    store.record_expense_refund(correction.clone()).unwrap();
    assert_eq!(balance(&store, &accounts["expense"], "2026-08-31"), 10000);
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-08-31"),
        810
    );
    assert_eq!(balance(&store, &accounts["bank"], "2026-08-31"), -10810);
    let year = crate::models::PeriodFilter {
        date_from: Some("2026-01-01".into()),
        date_to: Some("2026-12-31".into()),
    };
    assert_eq!(
        store.get_income_statement(year.clone()).unwrap()["profit_cents"],
        -10000
    );
    let statement = store.get_balance_sheet(year).unwrap();
    assert_eq!(statement["assets_cents"], -10000);
    assert_eq!(statement["balanced"], true);
    assert_eq!(
        period_preview(&store, "2026-04-01", "2026-06-30").source_sha256,
        before_q2.source_sha256
    );
    assert_eq!(
        period_preview(&store, "2026-07-01", "2026-09-30").payable_tax_cents,
        -405
    );
    let count = journal_count(&store);
    store.record_expense_refund(correction.clone()).unwrap();
    assert_eq!(journal_count(&store), count);
    correction.request_id = Uuid::new_v4().to_string();
    assert!(store.record_expense_refund(correction).is_err());
    let connection = store.connect().unwrap();
    assert!(connection
        .execute(
            "UPDATE expense_refunds SET net_cents=1 WHERE id=?",
            params![refund["id"].as_str()]
        )
        .is_err());
    assert!(connection
        .execute("DELETE FROM expense_refunds", [])
        .is_err());
    assert!(store
        .set_vat_source_classification(VatSourceClassificationInput {
            source_type: "expense".into(),
            source_id: expense.clone(),
            treatment: "non_deductible".into(),
            note: None
        })
        .is_err());
    assert!(connection
        .execute(
            "DELETE FROM vat_source_classifications WHERE source_type='expense' AND source_id=?",
            params![expense]
        )
        .is_err());
    let mut replacement = input(&expense);
    replacement.net_cents = 10000;
    replacement.vat_cents = 810;
    replacement.credit_date = "2026-08-01".into();
    replacement.payment_date = "2026-08-01".into();
    store.record_expense_refund(replacement).unwrap();
    assert_eq!(balance(&store, &accounts["bank"], "2026-08-31"), 0);
}

#[test]
fn expense_refund_backdating_cannot_spend_a_later_correction_in_either_timeline() {
    let (_dir, store, _) = fixture();
    store.create_vat_profile(profile(false)).unwrap();
    let expense = purchase(&store, true);
    let mut full = input(&expense);
    full.net_cents = 10000;
    full.vat_cents = 810;
    let refund = store.record_expense_refund(full.clone()).unwrap()["refund"].clone();
    let mut correction = full.clone();
    correction.request_id = Uuid::new_v4().to_string();
    correction.reverses_id = Some(refund["id"].as_str().unwrap().into());
    correction.credit_date = "2026-08-01".into();
    correction.payment_date = "2026-08-10".into();
    store.record_expense_refund(correction).unwrap();
    let count = journal_count(&store);
    let before_q2 = period_preview(&store, "2026-04-01", "2026-06-30");
    let mut replacement = full;
    replacement.request_id = Uuid::new_v4().to_string();
    replacement.reference = "AV-002".into();
    replacement.payment_date = "2026-08-10".into();
    assert!(
        store.record_expense_refund(replacement.clone()).is_err(),
        "The later correction cannot fund an earlier credit"
    );
    replacement.credit_date = "2026-08-01".into();
    replacement.payment_date = "2026-08-05".into();
    assert!(
        store.record_expense_refund(replacement.clone()).is_err(),
        "The later bank correction cannot fund an earlier receipt"
    );
    assert_eq!(journal_count(&store), count);
    assert_eq!(
        period_preview(&store, "2026-04-01", "2026-06-30").source_sha256,
        before_q2.source_sha256
    );
    replacement.payment_date = "2026-08-10".into();
    store.record_expense_refund(replacement).unwrap();
    assert_eq!(journal_count(&store), count + 2);
}

#[test]
fn expense_refund_non_registered_and_simple_rate_purchases_restore_gross_cost() {
    for simple in [false, true] {
        let (_dir, store, accounts) = fixture_with_registration(simple);
        if simple {
            store.create_vat_profile(profile(true)).unwrap();
        }
        let expense = purchase(&store, false);
        let result = store.record_expense_refund(input(&expense)).unwrap();
        assert_eq!(result["refund"]["cost_cents"], 5405);
        assert_eq!(result["refund"]["treatment"], "non_deductible");
        assert_eq!(balance(&store, &accounts["expense"], "2026-08-31"), 5405);
        assert_eq!(
            balance(&store, &accounts["vat_receivable"], "2026-08-31"),
            0
        );
    }
}

#[test]
fn expense_refund_rejects_duplicate_over_refund_and_inconsistent_vat_without_partial_postings() {
    let (_dir, store, _accounts) = fixture();
    let expense = purchase(&store, false);
    assert!(store
        .record_expense_refund(input(&expense))
        .unwrap_err()
        .to_string()
        .contains("classification TVA"));
    classify(&store, "expense", &expense, "input_materials");
    store.record_expense_refund(input(&expense)).unwrap();
    let count = journal_count(&store);
    assert!(store
        .record_expense_refund(input(&expense))
        .unwrap_err()
        .to_string()
        .contains("identique"));
    let mut excess = input(&expense);
    excess.reference = "AV-002".into();
    excess.net_cents = 5001;
    assert!(store.record_expense_refund(excess).is_err());
    let mut tax = input(&expense);
    tax.reference = "AV-002".into();
    tax.vat_cents = 406;
    assert!(store.record_expense_refund(tax).is_err());
    let mut backwards = input(&expense);
    backwards.payment_date = "2026-04-01".into();
    assert!(store.record_expense_refund(backwards).is_err());
    assert_eq!(journal_count(&store), count);
    let mut rest = input(&expense);
    rest.reference = "AV-002".into();
    store.record_expense_refund(rest).unwrap();
    assert!(store.record_expense_refund(input(&expense)).is_err());
}

#[test]
fn expense_refund_closed_dates_and_failed_bank_posting_roll_back_every_write() {
    let (_dir, store, accounts) = fixture();
    let expense = purchase(&store, true);
    let count = journal_count(&store);
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE accounts SET active=0 WHERE id=?",
            params![accounts["bank"]],
        )
        .unwrap();
    assert!(store.record_expense_refund(input(&expense)).is_err());
    assert_eq!(
        journal_count(&store),
        count,
        "failure on the second journal rolls back the credit as well"
    );
    assert!(store.get_workspace().unwrap()["expense_refunds"]
        .as_array()
        .unwrap()
        .is_empty());
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE accounts SET active=1 WHERE id=?",
            params![accounts["bank"]],
        )
        .unwrap();
    let request = input(&expense);
    store.record_expense_refund(request.clone()).unwrap();
    store.connect().unwrap().execute("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES('closed','T2','2026-04-01','2026-06-30','closed','2026-07-01','2026-07-01')",[]).unwrap();
    assert_eq!(
        store.record_expense_refund(request).unwrap()["already_recorded"],
        true,
        "exact replay stays safe after closing"
    );
    let count = journal_count(&store);
    let mut closed = input(&expense);
    closed.reference = "AV-002".into();
    assert!(store
        .record_expense_refund(closed)
        .unwrap_err()
        .to_string()
        .contains("clôtur"));
    assert_eq!(journal_count(&store), count);
}

#[test]
fn expense_refund_v47_migration_preserves_the_existing_purchase_and_journal() {
    let (_dir, store, accounts) = fixture_with_registration(false);
    let expense = purchase(&store, false);
    let original = store.get_workspace().unwrap()["expenses"][0].clone();
    let journals = journal_count(&store);
    let connection = store.connect().unwrap();
    connection
        .execute_batch("DROP TABLE expense_refunds; PRAGMA user_version=46;")
        .unwrap();
    drop(connection);
    // Reopening the same isolated profile performs the real migration dispatch.
    let reopened = LocalStore::initialize(_dir.path().join("profile")).unwrap();
    assert_eq!(
        reopened
            .connect()
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        47
    );
    assert_eq!(reopened.get_workspace().unwrap()["expenses"][0], original);
    assert_eq!(journal_count(&reopened), journals);
    reopened.record_expense_refund(input(&expense)).unwrap();
    assert_eq!(balance(&reopened, &accounts["expense"], "2026-08-31"), 5405);
    let again = LocalStore::initialize(_dir.path().join("profile")).unwrap();
    assert_eq!(
        again.get_workspace().unwrap()["expense_refunds"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn expense_refund_exports_actual_negative_input_tax_and_preserves_both_dates() {
    for received in [false, true] {
        let (_dir, store, _accounts) = fixture();
        let mut vat = profile(false);
        if received {
            vat.form_of_reporting = "received".into();
            vat.afc_authorization_confirmed = true;
        }
        store.create_vat_profile(vat).unwrap();
        let expense = purchase(&store, true);
        store.record_expense_refund(input(&expense)).unwrap();
        let (from, to, label) = if received {
            ("2026-07-01", "2026-09-30", "received")
        } else {
            ("2026-04-01", "2026-06-30", "agreed")
        };
        let exported = store
            .export_vat_return_xml(crate::vat_reporting::ExportVatReturnInput {
                date_from: from.into(),
                date_to: to.into(),
                submission_type: "initial".into(),
                profile_id: None,
                business_reference_id: format!("QA-EXPENSE-REFUND-{label}"),
                file_name: None,
            })
            .unwrap();
        let xml = std::fs::read_to_string(exported.file_path).unwrap();
        assert!(xml.contains(
            "<eCH-0217:inputTaxMaterialAndServices>-4.05</eCH-0217:inputTaxMaterialAndServices>"
        ));
        if let Ok(directory) = std::env::var("ZENTRA_QA_EXPENSE_REFUND_XML_DIR") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                std::path::Path::new(&directory).join(format!("refund-{label}.xml")),
                xml,
            )
            .unwrap();
        }
    }
}
