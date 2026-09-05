use crate::bank_import::refunds::{MatchExpenseRefundInput, UnmatchExpenseRefundInput};
use crate::expense_refunds::ExpenseRefundInput;

fn refund_purchase(store: &LocalStore) -> (String, ExpenseRefundInput, String) {
    let expense_id = expense(store, true, "2026-08-20");
    store
        .set_vat_source_classification(VatSourceClassificationInput {
            source_type: "expense".into(),
            source_id: expense_id.clone(),
            treatment: "input_materials".into(),
            note: None,
        })
        .unwrap();
    let input = ExpenseRefundInput {
        request_id: Uuid::new_v4().to_string(),
        expense_id: expense_id.clone(),
        credit_date: "2026-08-21".into(),
        payment_date: "2026-08-31".into(),
        reference: "AV-REFUND-54".into(),
        reason: "Retour partiel de marchandises".into(),
        net_cents: 5000,
        vat_cents: 405,
        reverses_id: None,
    };
    let result = store.record_expense_refund(input.clone()).unwrap();
    (expense_id, input, value_id(&result["refund"]))
}
fn refund_credit(amount: &str, key: &str) -> String {
    debit_fixture(amount, key, None)
        .replace("<CdtDbtInd>DBIT</CdtDbtInd>", "<CdtDbtInd>CRDT</CdtDbtInd>")
}
fn refund_match(movement: &str, refund: &str) -> MatchExpenseRefundInput {
    MatchExpenseRefundInput {
        request_id: Uuid::new_v4().to_string(),
        movement_id: movement.into(),
        refund_id: refund.into(),
        date_difference_reason: None,
    }
}
fn refund_unlink(matched: &str) -> UnmatchExpenseRefundInput {
    UnmatchExpenseRefundInput {
        request_id: Uuid::new_v4().to_string(),
        match_id: matched.into(),
        reason: "Ce crédit correspond à une autre pièce fournisseur".into(),
    }
}

#[test]
fn bank_refund_matching_preserves_journal_vat_cost_and_never_pays_a_customer_invoice() {
    let (dir, store) = ready();
    let (expense_id, _, refund) = refund_purchase(&store);
    let (_, _, other) = refund_purchase(&store);
    let movement = debit(
        &store,
        dir.path(),
        "REFUND",
        Some(refund_credit("54.05", "REFUND")),
    );
    let before = counts(&store).0;
    let tax = preview(&store);
    let bank = store.get_bank_workspace().unwrap();
    assert_eq!(
        bank["movements"][0]["refund_suggestion"]["candidates"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "Equal amounts must remain an explicit choice"
    );
    let input = refund_match(&movement, &refund);
    store.match_bank_expense_refund(input.clone()).unwrap();
    assert_eq!(
        store.match_bank_expense_refund(input.clone()).unwrap()["already_recorded"],
        true
    );
    let mut conflicting = input.clone();
    conflicting.refund_id = other;
    assert!(store.match_bank_expense_refund(conflicting).is_err());
    assert!(store
        .match_bank_expense_refund(refund_match(&movement, &refund))
        .is_err());
    let bank = store.get_bank_workspace().unwrap();
    assert_eq!(bank["summary"]["unreconciled_count"], 0);
    assert_eq!(bank["movements"][0]["refund_match"]["id"], input.request_id);
    assert_eq!(bank["movements"][0]["suggestion"]["confirmable"], false);
    assert_eq!(
        store.get_workspace().unwrap()["expense_refunds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == refund)
            .unwrap()["bank_match_id"],
        input.request_id
    );
    assert!(store
        .confirm_bank_reconciliation(ConfirmBankReconciliationInput {
            movement_id: movement.clone(),
            invoice_id: Uuid::new_v4().to_string()
        })
        .unwrap_err()
        .to_string()
        .contains("remboursement"));
    assert_eq!(counts(&store).0, before);
    assert_eq!(preview(&store).source_sha256, tax.source_sha256);
    let reimport = store
        .import_camt_with_reconciliation(&dir.path().join("REFUND.xml").to_string_lossy(), true)
        .unwrap();
    assert_eq!(reimport["automatic_reconciliation"]["failures"], json!([]));
    assert_eq!(reimport["automatic_reconciliation"]["review_count"], 0);
    assert_eq!(reimport["automatic_reconciliation"]["paid_count"], 0);
    assert_eq!(
        store.get_workspace().unwrap()["expenses"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == expense_id)
            .unwrap()["total_cents"],
        10810
    );
    store.connect().unwrap().execute("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES('closed','T3','2026-07-01','2026-09-30','closed','2026-09-05','2026-09-05')",[]).unwrap();
    assert_eq!(
        store.match_bank_expense_refund(input).unwrap()["already_recorded"],
        true
    );
}

#[test]
fn bank_refund_dates_require_a_reason_without_changing_accounted_dates_or_vat() {
    let (dir, store) = ready();
    let (_, _, refund) = refund_purchase(&store);
    let movement = debit(
        &store,
        dir.path(),
        "DATE",
        Some(refund_credit("54.05", "DATE").replace("2026-08-31", "2026-09-01")),
    );
    let before = counts(&store);
    let tax = preview(&store);
    let mut input = refund_match(&movement, &refund);
    assert!(store
        .match_bank_expense_refund(input.clone())
        .unwrap_err()
        .to_string()
        .contains("dates"));
    input.date_difference_reason = Some("x".into());
    assert!(store.match_bank_expense_refund(input.clone()).is_err());
    assert_eq!(counts(&store), before);
    input.date_difference_reason =
        Some("Date de valeur et date de comptabilisation bancaire différentes".into());
    store.match_bank_expense_refund(input).unwrap();
    assert_eq!(counts(&store).0, before.0);
    assert_eq!(preview(&store).source_sha256, tax.source_sha256);
    assert_eq!(
        store.get_workspace().unwrap()["expense_refunds"][0]["payment_date"],
        "2026-08-31"
    );
}

#[test]
fn bank_refund_unlink_is_replayable_preserves_history_and_unlocks_the_dated_correction() {
    let (dir, store) = ready();
    let (_, mut correction, refund) = refund_purchase(&store);
    let movement = debit(
        &store,
        dir.path(),
        "UNLINKREF",
        Some(refund_credit("54.05", "UNLINKREF")),
    );
    let input = refund_match(&movement, &refund);
    store.match_bank_expense_refund(input.clone()).unwrap();
    correction.request_id = Uuid::new_v4().to_string();
    correction.reverses_id = Some(refund.clone());
    correction.credit_date = "2026-09-01".into();
    correction.payment_date = "2026-09-01".into();
    let before = counts(&store).0;
    let tax = preview(&store);
    assert!(store
        .record_expense_refund(correction.clone())
        .unwrap_err()
        .to_string()
        .contains("Dissociez"));
    let unlink = refund_unlink(&input.request_id);
    std::thread::scope(|scope| {
        let one = scope.spawn(|| store.unmatch_bank_expense_refund(unlink.clone()).unwrap());
        let two = scope.spawn(|| store.unmatch_bank_expense_refund(unlink.clone()).unwrap());
        assert_eq!(one.join().unwrap()["unlink"], two.join().unwrap()["unlink"]);
    });
    assert!(store.match_bank_expense_refund(input.clone()).is_err());
    let bank = store.get_bank_workspace().unwrap();
    assert_eq!(bank["summary"]["unreconciled_count"], 1);
    assert!(bank["movements"][0]["refund_match"].is_null());
    assert_eq!(
        bank["movements"][0]["refund_history"][0]["id"],
        input.request_id
    );
    assert_eq!(counts(&store).0, before);
    assert_eq!(preview(&store).source_sha256, tax.source_sha256);
    let replacement = refund_match(&movement, &refund);
    store
        .match_bank_expense_refund(replacement.clone())
        .unwrap();
    assert_eq!(
        store.unmatch_bank_expense_refund(unlink).unwrap()["already_recorded"],
        true,
        "A delayed retry must not unlink the new association"
    );
    assert_eq!(
        store.get_bank_workspace().unwrap()["movements"][0]["refund_match"]["id"],
        replacement.request_id
    );
    store
        .unmatch_bank_expense_refund(refund_unlink(&replacement.request_id))
        .unwrap();
    store.record_expense_refund(correction).unwrap();
    assert!(store
        .match_bank_expense_refund(refund_match(&movement, &refund))
        .is_err());
}

#[test]
fn bank_refund_invalid_movements_and_failed_commit_leave_no_match_or_extra_journal() {
    let (dir, store) = ready();
    let (_, _, refund) = refund_purchase(&store);
    let cases = [
        refund_credit("54.06", "AMOUNT"),
        debit_fixture("54.05", "DEBIT", None),
        fixture(
            "054",
            "08",
            "PDNG",
            "54.05",
            "PENDING",
            Some("D-PENDING"),
            None,
            None,
            false,
            true,
        ),
        refund_credit("54.05", "EARLY").replace("2026-08-31", "2026-08-19"),
        refund_credit("54.05", "FUTURE").replace("2026-08-31", "2099-08-31"),
        fixture(
            "054",
            "08",
            "BOOK",
            "54.05",
            "NOTICE",
            Some("D-NOTICE"),
            None,
            None,
            false,
            true,
        ),
        refund_credit("54.05", "CURRENCY").replace("Ccy=\"CHF\"", "Ccy=\"EUR\""),
        fixture(
            "053",
            "08",
            "BOOK",
            "54.05",
            "REVERSE",
            Some("D-REVERSE"),
            None,
            None,
            true,
            true,
        ),
    ];
    for (index, xml) in cases.iter().enumerate() {
        let key = [
            "AMOUNT", "DEBIT", "PENDING", "EARLY", "FUTURE", "NOTICE", "CURRENCY", "REVERSE",
        ][index];
        let movement = debit(&store, dir.path(), key, Some(xml.clone()));
        let before = counts(&store);
        assert!(
            store
                .match_bank_expense_refund(refund_match(&movement, &refund))
                .is_err(),
            "case {index}"
        );
        assert_eq!(counts(&store), before);
    }
    let movement = debit(
        &store,
        dir.path(),
        "FAILREF",
        Some(refund_credit("54.05", "FAILREF")),
    );
    let before = counts(&store);
    store.connect().unwrap().execute_batch("CREATE TRIGGER fail_refund_match AFTER INSERT ON bank_expense_refund_matches BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;").unwrap();
    assert!(store
        .match_bank_expense_refund(refund_match(&movement, &refund))
        .is_err());
    assert_eq!(counts(&store), before);
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM bank_expense_refund_matches",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn bank_refund_concurrent_match_and_csv_export_preserve_financial_and_bank_evidence() {
    let (dir, store) = ready();
    let (_, _, refund) = refund_purchase(&store);
    let movement = debit(
        &store,
        dir.path(),
        "EXPORTREF",
        Some(refund_credit("54.05", "EXPORTREF")),
    );
    let input = refund_match(&movement, &refund);
    std::thread::scope(|scope| {
        let one = scope.spawn(|| store.match_bank_expense_refund(input.clone()).unwrap());
        let two = scope.spawn(|| store.match_bank_expense_refund(input.clone()).unwrap());
        assert_eq!(
            one.join().unwrap()["match"]["id"],
            two.join().unwrap()["match"]["id"]
        );
    });
    let unlink = refund_unlink(&input.request_id);
    store.unmatch_bank_expense_refund(unlink.clone()).unwrap();
    let conn = store.connect().unwrap();
    for table in ["bank_expense_refund_matches", "bank_expense_refund_unlinks"] {
        assert!(conn.execute(&format!("DELETE FROM {table}"), []).is_err());
        assert!(conn
            .execute(&format!("UPDATE {table} SET id=id"), [])
            .is_err());
    }
    assert!(conn
        .execute(
            "UPDATE bank_movements SET unstructured='rewritten' WHERE id=?",
            params![movement]
        )
        .is_err());
    let path = store
        .export_csv_archive(
            Some(
                dir.path()
                    .join("refunds.zip")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    for (path, expected) in [
        ("03_achats/remboursements_depenses.csv", refund),
        (
            "06_banque/rapprochements_remboursements.csv",
            input.request_id,
        ),
        ("06_banque/dissociations_remboursements.csv", unlink.reason),
    ] {
        let mut text = String::new();
        std::io::Read::read_to_string(&mut archive.by_name(path).unwrap(), &mut text).unwrap();
        assert!(text.contains(&expected));
    }
    let richer =
        refund_credit("54.05", "EXPORTREF").replace("Matériaux Léman SA", "Fournisseur révisé");
    store
        .import_camt_file(&write_xml(dir.path(), "richer-refund.xml", &richer))
        .unwrap();
    assert_eq!(
        store.get_bank_workspace().unwrap()["movements"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.get_bank_workspace().unwrap()["movements"][0]["refund_history"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.get_bank_workspace().unwrap()["movements"][0]["counterparty_name"],
        "Matériaux Léman SA"
    );
}

#[test]
fn bank_refund_v48_migration_preserves_existing_refund_and_journals() {
    let (dir, store) = ready();
    let (_, _, refund) = refund_purchase(&store);
    let before = counts(&store).0;
    let conn = store.connect().unwrap();
    drop_refund_bank_schema(&conn);
    conn.execute_batch("PRAGMA user_version=47;").unwrap();
    drop(conn);
    let reopened = LocalStore::initialize(dir.path().join("profile")).unwrap();
    assert_eq!(
        reopened.get_workspace().unwrap()["expense_refunds"][0]["id"],
        refund
    );
    assert_eq!(counts(&reopened).0, before);
    assert_eq!(
        reopened
            .connect()
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::schema::SCHEMA_VERSION
    );
    let movement = debit(
        &reopened,
        dir.path(),
        "MIGRATE48",
        Some(refund_credit("54.05", "MIGRATE48")),
    );
    reopened
        .match_bank_expense_refund(refund_match(&movement, &refund))
        .unwrap();
    let again = LocalStore::initialize(dir.path().join("profile")).unwrap();
    assert!(again.get_bank_workspace().unwrap()["movements"][0]["refund_match"].is_object());
}

// Historical migration fixtures remove newer dependent objects before rebuilding
// an older table shape. This runs only in isolated test databases.
pub(super) fn drop_refund_bank_schema(conn: &rusqlite::Connection) {
    let triggers: Vec<String> = conn.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'bank_refund_%' OR name IN ('bank_customer_exclusive_refund','bank_supplier_exclusive_refund','bank_expense_exclusive_refund','expense_refund_bank_correction_guard'))").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    for name in triggers {
        conn.execute_batch(&format!("DROP TRIGGER {name}")).unwrap();
    }
    conn.execute_batch("DROP VIEW active_bank_expense_refund_matches; DROP TABLE bank_expense_refund_unlinks; DROP TABLE bank_expense_refund_matches; DROP INDEX idx_expense_refund_bank_candidates;").unwrap();
}
