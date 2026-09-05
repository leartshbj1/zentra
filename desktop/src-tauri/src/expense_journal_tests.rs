use super::*;
use crate::models::PeriodFilter;

fn purchase(store: &LocalStore) -> (String, String) {
    let expense = store.create_record("expenses", json!({"date":"2026-02-10","paid_at":"2026-02-10","payment_status":"paid","supplier":"Test extourne","reference":"EXP-REV","net_cents":10000,"vat_cents":810})).unwrap();
    let id = expense["id"].as_str().unwrap().to_string();
    classify(store, "expense", &id, "input_materials");
    let journal = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT id FROM journal_entries WHERE source_type='expense' AND source_id=?",
            params![id],
            |r| r.get(0),
        )
        .unwrap();
    (id, journal)
}

/// Reproduce a journal produced by the old public command, now rejected.
fn legacy_reverse(store: &LocalStore, parent: &str, date: &str, malformed: bool) -> String {
    let id = Uuid::new_v4().to_string();
    let mut connection = store.connect().unwrap();
    let tx = connection.transaction().unwrap();
    tx.execute("INSERT INTO journal_entries(id,number,entry_date,description,source_type,source_id,source_event,reversal_of,created_at) VALUES(?1,?1,?2,'Ancienne extourne isolée','journal_reversal',?3,'reverse',?3,?2)",params![id,date,parent]).unwrap();
    tx.execute("INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_cents,credit_cents,currency,memo,project_id,client_id,employee_id,created_at) SELECT ?1||id,?1,account_id,credit_cents, debit_cents,currency,'Extourne historique',project_id,client_id,employee_id,created_at FROM journal_lines WHERE journal_entry_id=?2",params![id,parent]).unwrap();
    if malformed {
        // An extra balanced pair on different accounts defeats parity-only checks.
        let lines = crate::database::query_all(
            &tx,
            "SELECT * FROM journal_lines WHERE journal_entry_id=? ORDER BY account_id",
            params![id],
        )
        .unwrap();
        for (index, row) in lines.iter().take(2).enumerate() {
            tx.execute("INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_cents,credit_cents,currency,created_at) VALUES(?,?,?, ?,?,'CHF','2026-04-10')",params![Uuid::new_v4().to_string(),id,row["account_id"].as_str(),if index==0{1}else{0},if index==1{1}else{0}]).unwrap();
        }
    }
    tx.commit().unwrap();
    id
}

#[test]
fn expense_journal_blocks_isolated_cancellation_and_repairs_legacy_for_both_vat_bases() {
    for received in [false, true] {
        let (_dir, store, accounts) = fixture();
        let mut vat_profile = profile(false);
        if received {
            vat_profile.form_of_reporting = "received".into();
            vat_profile.afc_authorization_confirmed = true;
        }
        store.create_vat_profile(vat_profile).unwrap();
        let (expense, root) = purchase(&store);
        let q1 = period_preview(&store, "2026-01-01", "2026-03-31");
        assert!(q1.exportable);
        assert_eq!(q1.payable_tax_cents, -810);
        let before = journal_count(&store);
        assert!(store
            .reverse_journal_entry(&root, "2026-04-10", None)
            .unwrap_err()
            .to_string()
            .contains("corrigés ensemble"));
        assert_eq!(journal_count(&store), before);
        let tip = legacy_reverse(&store, &root, "2026-04-10", false);
        assert_eq!(
            balance(&store, &accounts["vat_receivable"], "2026-06-30"),
            0
        );
        let before_q1 = period_preview(&store, "2026-01-01", "2026-03-31");
        assert!(before_q1.exportable);
        assert_eq!(before_q1.source_sha256, q1.source_sha256);
        let bad = period_preview(&store, "2026-04-01", "2026-06-30");
        assert!(!bad.exportable);
        assert!(store
            .export_vat_return_xml(crate::vat_reporting::ExportVatReturnInput {
                date_from: "2026-04-01".into(),
                date_to: "2026-06-30".into(),
                submission_type: "initial".into(),
                profile_id: None,
                business_reference_id: "EXPENSE-REPAIR-Q2".into(),
                file_name: None
            })
            .is_err());
        assert!(bad
            .blocking_issues
            .iter()
            .any(|i| i.code == "expense_journal_inactive" && i.source_id.as_deref() == Some(&tip)));
        let report = store.get_journal(PeriodFilter::default()).unwrap();
        assert_eq!(
            report["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["id"] == tip)
                .unwrap()["reversal_action"],
            "restore_expense"
        );
        assert!(store
            .reverse_journal_entry(&tip, "2026-04-09", None)
            .is_err());
        let repair = store
            .reverse_journal_entry(
                &tip,
                "2026-05-10",
                Some("Rétablissement de la dépense payée".into()),
            )
            .unwrap();
        let count = journal_count(&store);
        store
            .reverse_journal_entry(
                &tip,
                "2026-05-10",
                Some("Rétablissement de la dépense payée".into()),
            )
            .unwrap();
        assert_eq!(journal_count(&store), count);
        assert!(store
            .reverse_journal_entry(repair["entry"]["id"].as_str().unwrap(), "2026-05-11", None)
            .is_err());
        classify(&store, "expense", &expense, "input_materials");
        assert_eq!(
            balance(&store, &accounts["vat_receivable"], "2026-06-30"),
            810
        );
        assert_eq!(balance(&store, &accounts["expense"], "2026-06-30"), 10000);
        let q2 = period_preview(&store, "2026-04-01", "2026-06-30");
        assert!(q2.exportable, "{:?}", q2.blocking_issues);
        assert_eq!(q2.payable_tax_cents, 0);
        store
            .export_vat_return_xml(crate::vat_reporting::ExportVatReturnInput {
                date_from: "2026-04-01".into(),
                date_to: "2026-06-30".into(),
                submission_type: "initial".into(),
                profile_id: None,
                business_reference_id: "EXPENSE-REPAIRED-Q2".into(),
                file_name: None,
            })
            .unwrap();
        assert_eq!(
            period_preview(&store, "2026-01-01", "2026-03-31").source_sha256,
            q1.source_sha256
        );
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT payment_status FROM expenses WHERE id=?",
                    params![expense],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "paid"
        );
    }
}

#[test]
fn expense_journal_restoration_is_atomic_concurrent_and_preserves_closed_period_and_vat_cost() {
    for non_deductible in [false, true] {
        let (_dir, store, accounts) = fixture();
        store.create_vat_profile(profile(false)).unwrap();
        let (expense, root) = purchase(&store);
        if non_deductible {
            classify(&store, "expense", &expense, "non_deductible");
        }
        let q1 = period_preview(&store, "2026-01-01", "2026-03-31");
        let period = store
            .upsert_accounting_period(crate::models::AccountingPeriodInput {
                id: None,
                name: "Premier trimestre".into(),
                date_from: "2026-01-01".into(),
                date_to: "2026-03-31".into(),
            })
            .unwrap();
        store
            .close_accounting_period(period["id"].as_str().unwrap())
            .unwrap();
        let tip = legacy_reverse(&store, &root, "2026-04-10", false);
        let before = journal_count(&store);
        store.connect().unwrap().execute_batch("CREATE TRIGGER qa_expense_repair_failure AFTER INSERT ON journal_entries WHEN NEW.source_type='journal_reversal' BEGIN SELECT RAISE(ABORT,'simulated restore failure'); END;").unwrap();
        assert!(store
            .reverse_journal_entry(&tip, "2026-05-10", Some("Rétablissement contrôlé".into()))
            .is_err());
        assert_eq!(journal_count(&store), before);
        store
            .connect()
            .unwrap()
            .execute_batch("DROP TRIGGER qa_expense_repair_failure;")
            .unwrap();
        std::thread::scope(|scope| {
            let one = scope.spawn(|| {
                store
                    .reverse_journal_entry(
                        &tip,
                        "2026-05-10",
                        Some("Rétablissement contrôlé".into()),
                    )
                    .unwrap()
            });
            let two = scope.spawn(|| {
                store
                    .reverse_journal_entry(
                        &tip,
                        "2026-05-10",
                        Some("Rétablissement contrôlé".into()),
                    )
                    .unwrap()
            });
            assert_eq!(one.join().unwrap(), two.join().unwrap());
        });
        assert_eq!(journal_count(&store), before + 1);
        assert_eq!(
            balance(&store, &accounts["expense"], "2026-06-30"),
            if non_deductible { 10810 } else { 10000 }
        );
        assert_eq!(
            balance(&store, &accounts["vat_receivable"], "2026-06-30"),
            if non_deductible { 0 } else { 810 }
        );
        assert_eq!(
            period_preview(&store, "2026-01-01", "2026-03-31").source_sha256,
            q1.source_sha256
        );
        assert!(period_preview(&store, "2026-04-01", "2026-06-30").exportable);
    }
}

#[test]
fn expense_journal_repair_does_not_hide_an_inconsistent_earlier_period_or_invalid_lines() {
    for malformed in [false, true] {
        let (_dir, store, _) = fixture();
        store.create_vat_profile(profile(false)).unwrap();
        let (_, root) = purchase(&store);
        let tip = legacy_reverse(&store, &root, "2026-04-10", malformed);
        if malformed {
            assert!(store
                .reverse_journal_entry(&tip, "2026-05-10", None)
                .is_err());
        } else {
            store
                .reverse_journal_entry(&tip, "2026-07-10", None)
                .unwrap();
            assert!(period_preview(&store, "2026-07-01", "2026-09-30").exportable);
        }
        assert!(!period_preview(&store, "2026-04-01", "2026-06-30").exportable);
    }
}
