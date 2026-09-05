use crate::models::CreateBankExpenseInput;
use base64::{engine::general_purpose::STANDARD, Engine};

fn creation(movement_id: &str) -> CreateBankExpenseInput {
    CreateBankExpenseInput {
        request_id: Uuid::new_v4().to_string(),
        movement_id: movement_id.into(),
        date: "2026-08-20".into(),
        supplier: "Matériaux Léman SA".into(),
        reference: "TICKET-2026-81".into(),
        category: "Marchandises".into(),
        project_id: None,
        vat_cents: 810,
        vat_treatment: "input_materials".into(),
        note: "Achat comptant".into(),
        original_name: "ticket.pdf".into(),
        content_base64: STANDARD.encode(crate::attachments::test_pdf_bytes()),
    }
}

fn creation_counts(store: &LocalStore) -> (i64, i64, i64, i64) {
    store.connect().unwrap().query_row("SELECT (SELECT COUNT(*) FROM expenses),(SELECT COUNT(*) FROM attachments),(SELECT COUNT(*) FROM journal_entries),(SELECT COUNT(*) FROM bank_expense_creation_requests)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap()
}

#[test]
fn bank_creation_atomic_receipt_payment_vat_project_and_read_only_replay() {
    let (dir, store) = ready();
    let movement = debit(&store, dir.path(), "CREATE", None);
    let mut input = creation(&movement);
    let project = store
        .create_record("projects", json!({"name":"Projet justificatif"}))
        .unwrap();
    input.project_id = Some(value_id(&project));
    let result = store.create_bank_expense(input.clone()).unwrap();
    assert_eq!(result["expense"]["paid_at"], "2026-08-31");
    assert_eq!(result["expense"]["net_cents"], 10000);
    assert_eq!(creation_counts(&store), (1, 1, 1, 1));
    assert_eq!(preview(&store).payable_tax_cents, -810);
    assert!(preview(&store).exportable);
    let attachment = result["attachment_id"].as_str().unwrap();
    let path = store.verified_attachment_path(attachment).unwrap();
    assert_eq!(
        fs::read(path).unwrap(),
        STANDARD.decode(&input.content_base64).unwrap()
    );
    let files = store.get_workspace().unwrap()["attachments"].clone();
    assert_eq!(files[0]["project_id"], project["id"]);
    assert_eq!(files[0]["entity_type"], "expense");
    let csv = store
        .export_csv_archive(
            Some(
                dir.path()
                    .join("bank-expense.zip")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(csv).unwrap()).unwrap();
    for (name, expected) in [
        ("06_banque/rapprochements_depenses.csv", movement.as_str()),
        (
            "06_banque/creations_depenses.csv",
            input.request_id.as_str(),
        ),
        ("10_documents/index_pieces_jointes.csv", attachment),
    ] {
        let mut content = String::new();
        std::io::Read::read_to_string(&mut archive.by_name(name).unwrap(), &mut content).unwrap();
        assert!(content.contains(expected), "{name}: {content}");
    }
    let period = store
        .upsert_accounting_period(AccountingPeriodInput {
            id: None,
            name: "Août".into(),
            date_from: "2026-08-01".into(),
            date_to: "2026-08-31".into(),
        })
        .unwrap();
    store.close_accounting_period(&value_id(&period)).unwrap();
    let before = counts(&store);
    assert_eq!(
        store.create_bank_expense(input.clone()).unwrap()["already_recorded"],
        true
    );
    assert_eq!(counts(&store), before);
    input.note = "Essai différent".into();
    assert!(store.create_bank_expense(input).is_err());
    assert_eq!(creation_counts(&store), (1, 1, 1, 1));
    let conn = store.connect().unwrap();
    assert!(conn
        .execute(
            "UPDATE attachments SET sha256='changed' WHERE id=?",
            params![attachment]
        )
        .is_err());
    assert!(conn
        .execute("DELETE FROM attachments WHERE id=?", params![attachment])
        .is_err());
    assert!(conn
        .execute("DELETE FROM bank_expense_creation_requests", [])
        .is_err());
    assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
}

#[test]
fn bank_creation_refusals_rollback_expense_file_journal_and_request() {
    let (dir, store) = ready();
    let movement = debit(&store, dir.path(), "REFUSE-CREATE", None);
    let input = creation(&movement);
    let before = creation_counts(&store);
    let mut invalid = input.clone();
    invalid.content_base64 = STANDARD.encode(b"%PDF-1.7\ntruncated");
    assert!(store.create_bank_expense(invalid).is_err());
    let mut invalid = input.clone();
    invalid.date = "2026-09-01".into();
    assert!(store.create_bank_expense(invalid).is_err());
    let mut invalid = input.clone();
    invalid.vat_cents = 10810;
    assert!(store.create_bank_expense(invalid).is_err());
    let mut invalid = input.clone();
    invalid.project_id = Some(Uuid::new_v4().to_string());
    assert!(store.create_bank_expense(invalid).is_err());
    // Failure after file preparation and posting must still roll everything back.
    store.connect().unwrap().execute_batch("CREATE TRIGGER test_creation_failure BEFORE INSERT ON bank_expense_creation_requests BEGIN SELECT RAISE(ABORT,'simulated failure'); END;").unwrap();
    assert!(store.create_bank_expense(input.clone()).is_err());
    assert_eq!(creation_counts(&store), before);
    let attachment_dir = dir.path().join("profile").join("attachments");
    assert!(fs::read_dir(attachment_dir).unwrap().all(|entry| !entry
        .unwrap()
        .file_type()
        .unwrap()
        .is_file()));
    store
        .connect()
        .unwrap()
        .execute_batch("DROP TRIGGER test_creation_failure;")
        .unwrap();
    // A deferred foreign-key error happens only at commit, after the receipt was installed.
    store.connect().unwrap().execute_batch("CREATE TABLE test_deferred_missing(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER test_creation_failure AFTER INSERT ON bank_expense_creation_requests BEGIN INSERT INTO test_deferred_missing VALUES('failure','missing-project'); END;").unwrap();
    assert!(store.create_bank_expense(input.clone()).is_err());
    assert_eq!(creation_counts(&store), before);
    assert!(fs::read_dir(dir.path().join("profile").join("attachments"))
        .unwrap()
        .all(|entry| !entry.unwrap().file_type().unwrap().is_file()));
    store
        .connect()
        .unwrap()
        .execute_batch("DROP TRIGGER test_creation_failure; DROP TABLE test_deferred_missing;")
        .unwrap();
    assert!(store.create_bank_expense(input).is_ok());
}

#[test]
fn bank_creation_duplicate_receipt_reference_and_concurrent_retry_do_not_duplicate_purchase() {
    let (dir, store) = ready();
    let first = debit(&store, dir.path(), "FIRST-CREATE", None);
    let input = creation(&first);
    std::thread::scope(|scope| {
        let one = scope.spawn(|| store.create_bank_expense(input.clone()).unwrap());
        let two = scope.spawn(|| store.create_bank_expense(input.clone()).unwrap());
        assert_eq!(
            one.join().unwrap()["expense"]["id"],
            two.join().unwrap()["expense"]["id"]
        );
    });
    let second = debit(&store, dir.path(), "SECOND-CREATE", None);
    let mut duplicate = input.clone();
    duplicate.movement_id = second;
    duplicate.request_id = Uuid::new_v4().to_string();
    assert!(store
        .create_bank_expense(duplicate.clone())
        .unwrap_err()
        .to_string()
        .contains("existe déjà"));
    duplicate.reference = "DIFFERENT-REFERENCE".into();
    assert!(store
        .create_bank_expense(duplicate)
        .unwrap_err()
        .to_string()
        .contains("existe déjà"));
    let mut duplicate = input;
    duplicate.request_id = Uuid::new_v4().to_string();
    assert!(store.create_bank_expense(duplicate).is_err());
    assert_eq!(creation_counts(&store), (1, 1, 1, 1));
}

#[test]
fn bank_creation_non_registered_vat_stays_in_cost_and_invalid_deduction_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
    let mut info = onboarding();
    info.vat_registered = false;
    info.vat_number = None;
    info.default_vat_bp = Some(0);
    store.complete_onboarding(info, "test").unwrap();
    enable_accounting(&store);
    store
        .associate_bank_account(AssociateBankAccountInput {
            account_id: STATEMENT_IBAN.into(),
            currency: "CHF".into(),
        })
        .unwrap();
    let movement = debit(&store, dir.path(), "NO-DEDUCTION", None);
    let mut input = creation(&movement);
    assert!(store.create_bank_expense(input.clone()).is_err());
    assert_eq!(creation_counts(&store), (0, 0, 0, 0));
    input.vat_treatment = "non_deductible".into();
    store.create_bank_expense(input).unwrap();
    let conn = store.connect().unwrap();
    let amounts:(i64,i64)=conn.query_row("SELECT SUM(CASE WHEN a.account_type='expense' THEN l.debit_cents-l.credit_cents ELSE 0 END),SUM(CASE WHEN l.account_id=s.vat_receivable_account_id THEN l.debit_cents-l.credit_cents ELSE 0 END) FROM journal_lines l JOIN accounts a ON a.id=l.account_id CROSS JOIN accounting_settings s",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(amounts, (10810, 0));
}

#[test]
fn bank_creation_migration_from_v44_preserves_existing_match() {
    let (dir, store) = ready();
    let movement = debit(&store, dir.path(), "MIGRATE-44", None);
    let expense_id = expense(&store, false, "2026-08-31");
    store
        .confirm_expense_bank_reconciliation(ConfirmExpenseBankReconciliationInput {
            request_id: None,
            movement_id: movement,
            expense_id,
            date_difference_reason: None,
        })
        .unwrap();
    let before = counts(&store);
    store.connect().unwrap().execute_batch("DROP TRIGGER bank_expense_attachment_immutable_update; DROP TABLE bank_expense_creation_requests; PRAGMA user_version=44;").unwrap();
    drop(store);
    let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
    assert_eq!(counts(&store), before);
    assert_eq!(creation_counts(&store).3, 0);
    assert_eq!(
        store
            .connect()
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::schema::SCHEMA_VERSION
    );
}
