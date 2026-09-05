use crate::models::UnreconcileBankExpenseInput;

fn financial_snapshot(store: &LocalStore) -> Value {
    let conn = store.connect().unwrap();
    json!({"expenses":query_all(&conn,"SELECT * FROM expenses ORDER BY id",[]).unwrap(),"entries":query_all(&conn,"SELECT * FROM journal_entries ORDER BY id",[]).unwrap(),"lines":query_all(&conn,"SELECT * FROM journal_lines ORDER BY id",[]).unwrap(),"classifications":query_all(&conn,"SELECT * FROM vat_source_classifications ORDER BY id",[]).unwrap()})
}
fn correction(id: &str) -> UnreconcileBankExpenseInput {
    UnreconcileBankExpenseInput {
        request_id: Uuid::new_v4().to_string(),
        reconciliation_id: id.into(),
        reason: "Le débit correspond à une autre pièce ; le paiement enregistré est conservé."
            .into(),
    }
}
fn explicit_match(movement: &str, expense: &str) -> ConfirmExpenseBankReconciliationInput {
    ConfirmExpenseBankReconciliationInput {
        request_id: Some(Uuid::new_v4().to_string()),
        movement_id: movement.into(),
        expense_id: expense.into(),
        date_difference_reason: None,
    }
}

#[test]
fn bank_unlink_preserves_all_financial_data_receipt_and_vat_for_three_payment_origins() {
    for origin in ["pending", "paid", "created"] {
        let (dir, store) = ready();
        let movement = debit(&store, dir.path(), origin, None);
        let create = creation(&movement);
        let (expense_id, link, old_match) = if origin == "created" {
            let result = store.create_bank_expense(create.clone()).unwrap();
            (
                value_id(&result["expense"]),
                result["reconciliation"].clone(),
                None,
            )
        } else {
            let expense_id = expense(&store, origin == "paid", "2026-08-31");
            let input = explicit_match(&movement, &expense_id);
            let result = store
                .confirm_expense_bank_reconciliation(input.clone())
                .unwrap();
            store
                .set_vat_source_classification(VatSourceClassificationInput {
                    source_type: "expense".into(),
                    source_id: expense_id.clone(),
                    treatment: "input_materials".into(),
                    note: None,
                })
                .unwrap();
            (expense_id, result["reconciliation"].clone(), Some(input))
        };
        let period = store
            .upsert_accounting_period(AccountingPeriodInput {
                id: None,
                name: "Août".into(),
                date_from: "2026-08-01".into(),
                date_to: "2026-08-31".into(),
            })
            .unwrap();
        store.close_accounting_period(&value_id(&period)).unwrap();
        let account = AssociateBankAccountInput {
            account_id: STATEMENT_IBAN.into(),
            currency: "CHF".into(),
        };
        store.dissociate_bank_account(account.clone()).unwrap();
        let financial = financial_snapshot(&store);
        let vat = preview(&store);
        let input = correction(&value_id(&link));
        let first = store.unreconcile_bank_expense(input.clone()).unwrap();
        assert_eq!(
            first["history"]["journal_entry_id"],
            link["journal_entry_id"]
        );
        assert_eq!(
            first["history"]["date_difference_reason"],
            link["date_difference_reason"]
        );
        assert_eq!(financial_snapshot(&store), financial);
        assert_eq!(preview(&store).source_sha256, vat.source_sha256);
        assert_eq!(preview(&store).payable_tax_cents, -810);
        let snapshot = store.get_bank_workspace().unwrap();
        assert!(snapshot["movements"][0]["expense_reconciliation"].is_null());
        assert_eq!(
            snapshot["movements"][0]["expense_history"][0]["id"],
            link["id"]
        );
        assert_eq!(snapshot["summary"]["unreconciled_supplier_count"], 1);
        let audited = counts(&store);
        assert_eq!(
            store.unreconcile_bank_expense(input.clone()).unwrap()["already_recorded"],
            true
        );
        assert_eq!(counts(&store), audited);
        if let Some(old) = old_match {
            assert!(store.confirm_expense_bank_reconciliation(old).is_err());
        }
        if origin == "created" {
            assert!(store
                .create_bank_expense(create)
                .unwrap_err()
                .to_string()
                .contains("association bancaire a été retirée"));
            let attachments = store.get_workspace().unwrap()["attachments"].clone();
            assert!(store
                .verified_attachment_path(attachments[0]["id"].as_str().unwrap())
                .unwrap()
                .is_file());
        }
        store.associate_bank_account(account).unwrap();
        let new_match = store
            .confirm_expense_bank_reconciliation(explicit_match(&movement, &expense_id))
            .unwrap();
        assert_ne!(new_match["reconciliation"]["id"], link["id"]);
        assert_eq!(financial_snapshot(&store), financial);
        // A late response retry must not remove the NEW association.
        store.unreconcile_bank_expense(input).unwrap();
        assert_eq!(
            store.get_bank_workspace().unwrap()["movements"][0]["expense_reconciliation"]["id"],
            new_match["reconciliation"]["id"]
        );
        assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
    }
}

#[test]
fn bank_unlink_refusal_and_failed_commit_keep_the_active_match_and_do_not_consume_request() {
    let (dir, store) = ready();
    let movement = debit(&store, dir.path(), "ROLLBACK", None);
    let expense_id = expense(&store, false, "2026-08-31");
    let link = store
        .confirm_expense_bank_reconciliation(explicit_match(&movement, &expense_id))
        .unwrap()["reconciliation"]
        .clone();
    let before = financial_snapshot(&store);
    let input = correction(&value_id(&link));
    let mut invalid = input.clone();
    invalid.reason = "Non".into();
    assert!(store.unreconcile_bank_expense(invalid).is_err());
    let mut invalid = input.clone();
    invalid.reconciliation_id = Uuid::new_v4().to_string();
    assert!(store.unreconcile_bank_expense(invalid).is_err());
    store.connect().unwrap().execute_batch("CREATE TRIGGER fail_unlink AFTER DELETE ON bank_expense_reconciliations BEGIN SELECT RAISE(ABORT,'simulated unlink failure'); END;").unwrap();
    assert!(store.unreconcile_bank_expense(input.clone()).is_err());
    let bank = store.get_bank_workspace().unwrap();
    assert_eq!(
        bank["movements"][0]["expense_reconciliation"]["id"],
        link["id"]
    );
    assert!(bank["movements"][0]["expense_history"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(financial_snapshot(&store), before);
    store
        .connect()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_unlink;")
        .unwrap();
    store.unreconcile_bank_expense(input.clone()).unwrap();
    let mut invalid = input;
    invalid.reason = "Autre contenu pour le même essai".into();
    assert!(store.unreconcile_bank_expense(invalid).is_err());
    let conn = store.connect().unwrap();
    assert!(conn
        .execute(
            "UPDATE bank_expense_unreconciliations SET reason='Changé'",
            []
        )
        .is_err());
    assert!(conn
        .execute("DELETE FROM bank_expense_unreconciliations", [])
        .is_err());
    assert!(conn
        .execute("DELETE FROM bank_expense_reconciliation_registry", [])
        .is_err());
    assert_eq!(financial_snapshot(&store), before);
}

#[test]
fn bank_unlink_concurrency_late_confirmation_and_csv_history_are_safe() {
    let (dir, store) = ready();
    let movement = debit(&store, dir.path(), "CONCURRENT", None);
    let expense_id = expense(&store, true, "2026-08-31");
    let confirm = explicit_match(&movement, &expense_id);
    let link = store
        .confirm_expense_bank_reconciliation(confirm.clone())
        .unwrap()["reconciliation"]
        .clone();
    let input = correction(&value_id(&link));
    std::thread::scope(|scope| {
        let one = scope.spawn(|| store.unreconcile_bank_expense(input.clone()).unwrap());
        let two = scope.spawn(|| store.unreconcile_bank_expense(input.clone()).unwrap());
        assert_eq!(
            one.join().unwrap()["history"],
            two.join().unwrap()["history"]
        );
    });
    assert!(store.confirm_expense_bank_reconciliation(confirm).is_err());
    let conn = store.connect().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM bank_expense_unreconciliations",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM journal_entries", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let path = store
        .export_csv_archive(
            Some(
                dir.path()
                    .join("corrections.zip")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let mut text = String::new();
    std::io::Read::read_to_string(
        &mut archive
            .by_name("06_banque/corrections_rapprochements_depenses.csv")
            .unwrap(),
        &mut text,
    )
    .unwrap();
    assert!(
        text.contains(&input.request_id)
            && text.contains(&movement)
            && text.contains(&input.reason)
    );
    // Re-import must retain the historic movement even while it is no longer matched.
    let mut richer = debit_fixture("108.10", "CONCURRENT", None);
    richer = richer.replace("<Nm>Matériaux Léman SA</Nm>", "<Nm>Autre libellé</Nm>");
    store
        .import_camt_file(&write_xml(dir.path(), "richer.xml", &richer))
        .unwrap();
    assert_eq!(
        store.get_bank_workspace().unwrap()["movements"][0]["expense_history"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.get_bank_workspace().unwrap()["movements"][0]["counterparty_name"],
        "Matériaux Léman SA"
    );
    assert!(store
        .reverse_journal_entry(
            link["journal_entry_id"].as_str().unwrap(),
            "2026-09-05",
            Some("Correction isolée".into())
        )
        .is_err());
}

#[test]
fn bank_unlink_releases_movement_for_the_correct_supplier_invoice_without_erasing_old_payment() {
    let (dir, store) = ready();
    let movement = debit(&store, dir.path(), "CORRECT-SUPPLIER", None);
    let expense_id = expense(&store, true, "2026-08-31");
    let link = store
        .confirm_expense_bank_reconciliation(explicit_match(&movement, &expense_id))
        .unwrap()["reconciliation"]
        .clone();
    let supplier_invoice_id = create_supplier_invoice(&store, 10810, "SUPPLIER-CORRECT");
    let confirm = ConfirmSupplierBankReconciliationInput {
        movement_id: movement.clone(),
        supplier_invoice_id,
    };
    assert!(store
        .confirm_supplier_bank_reconciliation(confirm.clone())
        .is_err());
    store
        .unreconcile_bank_expense(correction(&value_id(&link)))
        .unwrap();
    store.confirm_supplier_bank_reconciliation(confirm).unwrap();
    assert_eq!(
        store.get_workspace().unwrap()["expenses"][0]["payment_status"],
        "paid"
    );
    let bank = store.get_bank_workspace().unwrap();
    assert!(!bank["movements"][0]["supplier_reconciliation"].is_null());
    assert!(bank["movements"][0]["expense_reconciliation"].is_null());
    assert_eq!(
        bank["movements"][0]["expense_history"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn bank_unlink_migration_v45_preserves_created_purchase_receipt_and_request_foreign_keys() {
    let (dir, store) = ready();
    let movement = debit(&store, dir.path(), "MIGRATE-45", None);
    let input = creation(&movement);
    let created = store.create_bank_expense(input.clone()).unwrap();
    let before = financial_snapshot(&store);
    {
        let conn = store.connect().unwrap();
        conn.execute_batch("DROP TRIGGER bank_expense_creation_immutable_update; DROP TRIGGER bank_expense_creation_immutable_delete; DROP TRIGGER bank_expense_attachment_immutable_update; DROP TRIGGER bank_expense_register; DROP TRIGGER bank_movements_expense_frozen; DROP TRIGGER bank_expense_journal_no_isolated_reversal; DROP TRIGGER bank_expense_reconciliations_no_delete; CREATE TEMP TABLE preserved_creation_requests AS SELECT * FROM bank_expense_creation_requests; DROP TABLE bank_expense_creation_requests; DROP TABLE bank_expense_unreconciliations; DROP TABLE bank_expense_reconciliation_registry;").unwrap();
        conn.execute_batch(crate::schema::MIGRATION_V44_SQL)
            .unwrap();
        conn.execute_batch(crate::schema::MIGRATION_V45_SQL)
            .unwrap();
        conn.execute_batch("INSERT INTO bank_expense_creation_requests SELECT * FROM preserved_creation_requests; DROP TABLE preserved_creation_requests;").unwrap();
        let target:String=conn.query_row("SELECT [table] FROM pragma_foreign_key_list('bank_expense_creation_requests') WHERE [from]='reconciliation_id'",[],|r|r.get(0)).unwrap();
        assert_eq!(target, "bank_expense_reconciliations");
    }
    // A conflicting view fails AFTER the creation-receipt table has been rebuilt.
    // The transaction must restore the original v45 table and its original FK.
    store
        .connect()
        .unwrap()
        .execute_batch("CREATE VIEW bank_expense_unreconciliations AS SELECT 'conflict' AS id;")
        .unwrap();
    let Err(failure) = LocalStore::initialize(dir.path().join("profile")) else {
        panic!("migration must fail on the conflicting view");
    };
    assert!(
        failure.to_string().contains("views may not be indexed"),
        "{failure}"
    );
    let connection = store.connect().unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        45
    );
    assert_eq!(connection.query_row("SELECT [table] FROM pragma_foreign_key_list('bank_expense_creation_requests') WHERE [from]='reconciliation_id'",[],|r|r.get::<_,String>(0)).unwrap(),"bank_expense_reconciliations");
    assert_eq!(financial_snapshot(&store), before);
    connection
        .execute_batch("DROP VIEW bank_expense_unreconciliations;")
        .unwrap();
    drop(connection);
    drop(store);
    let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
    assert_eq!(financial_snapshot(&store), before);
    assert_eq!(
        store.create_bank_expense(input).unwrap()["reconciliation"],
        created["reconciliation"]
    );
    let connection = store.connect().unwrap();
    let target:String=connection.query_row("SELECT [table] FROM pragma_foreign_key_list('bank_expense_creation_requests') WHERE [from]='reconciliation_id'",[],|r|r.get(0)).unwrap();
    assert_eq!(target, "bank_expense_reconciliation_registry");
    store
        .unreconcile_bank_expense(correction(&value_id(&created["reconciliation"])))
        .unwrap();
    assert_eq!(financial_snapshot(&store), before);
    assert!(store
        .verified_attachment_path(created["attachment_id"].as_str().unwrap())
        .unwrap()
        .is_file());
    assert!(query_all(&connection, "PRAGMA foreign_key_check", [])
        .unwrap()
        .is_empty());
    assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
}
