mod expense_tests {
    include!("bank_expense_creation_tests.rs");
    use super::*;
    use crate::models::ConfirmExpenseBankReconciliationInput;
    use crate::vat_reporting::{
        VatProfileInput, VatReturnPreviewInput, VatSourceClassificationInput,
    };
    use pretty_assertions::assert_eq;

    fn ready() -> (tempfile::TempDir, LocalStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
        let mut input = onboarding();
        input.vat_registered = true;
        input.vat_number = Some("CHE-123.456.789 TVA".into());
        input.default_vat_bp = Some(810);
        store.complete_onboarding(input, "test").unwrap();
        enable_accounting(&store);
        store
            .associate_bank_account(AssociateBankAccountInput {
                account_id: STATEMENT_IBAN.into(),
                currency: "CHF".into(),
            })
            .unwrap();
        store
            .create_vat_profile(VatProfileInput {
                id: Some(Uuid::new_v4().to_string()),
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
        (dir, store)
    }
    fn expense(store: &LocalStore, paid: bool, date: &str) -> String {
        value_id(&store.create_record("expenses",json!({"date":"2026-08-20","due_date":"2026-08-31","supplier":"Matériaux Léman SA","reference":"RECU-810","category":"Marchandises","net_cents":10000,"vat_cents":810,"payment_status":if paid{"paid"}else{"pending"},"paid_at":if paid{json!(date)}else{Value::Null}})).unwrap())
    }
    fn debit(store: &LocalStore, dir: &Path, key: &str, xml: Option<String>) -> String {
        let imported = store
            .import_camt_file(&write_xml(
                dir,
                &format!("{key}.xml"),
                &xml.unwrap_or_else(|| debit_fixture("108.10", key, None)),
            ))
            .unwrap();
        store.get_bank_workspace().unwrap()["movements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["end_to_end_id"] == format!("E2E-{key}"))
            .unwrap_or_else(|| panic!("missing movement {key}: {imported}"))["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn counts(store: &LocalStore) -> (i64, i64, i64) {
        store.connect().unwrap().query_row("SELECT (SELECT COUNT(*) FROM journal_entries),(SELECT COUNT(*) FROM bank_expense_reconciliations),(SELECT COUNT(*) FROM audit_log)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
    }
    fn preview(store: &LocalStore) -> crate::vat_reporting::VatReturnPreview {
        store
            .preview_vat_return(VatReturnPreviewInput {
                date_from: "2026-07-01".into(),
                date_to: "2026-09-30".into(),
                submission_type: "initial".into(),
                profile_id: None,
            })
            .unwrap()
    }
    #[test]
    fn bank_expense_pending_and_already_paid_keep_one_purchase_and_one_vat_deduction() {
        for paid in [false, true] {
            let (dir, store) = ready();
            let expense_id = expense(&store, paid, "2026-08-31");
            let movement_id = debit(&store, dir.path(), "EXPENSE", None);
            let before = counts(&store);
            let candidates = store.get_bank_workspace().unwrap()["movements"][0]
                ["expense_suggestion"]["candidates"]
                .clone();
            assert_eq!(candidates[0]["confirmable"], true);
            let input = ConfirmExpenseBankReconciliationInput {
                date_difference_reason: None,
                movement_id: movement_id.clone(),
                expense_id: expense_id.clone(),
            };
            let first = store
                .confirm_expense_bank_reconciliation(input.clone())
                .unwrap();
            assert_eq!(first["expense"]["payment_status"], "paid");
            assert_eq!(first["expense"]["paid_at"], "2026-08-31");
            let after = counts(&store);
            assert_eq!(after.0, before.0 + if paid { 0 } else { 1 });
            assert_eq!(after.1, 1);
            let replay = store
                .confirm_expense_bank_reconciliation(input.clone())
                .unwrap();
            assert_eq!(replay["reconciliation"], first["reconciliation"]);
            assert_eq!(counts(&store), after);
            store
                .set_vat_source_classification(VatSourceClassificationInput {
                    source_type: "expense".into(),
                    source_id: expense_id.clone(),
                    treatment: "input_materials".into(),
                    note: None,
                })
                .unwrap();
            let vat = preview(&store);
            assert!(vat.exportable, "{:?}", vat.blocking_issues);
            assert_eq!(vat.payable_tax_cents, -810);
            let snapshot = store.get_bank_workspace().unwrap();
            assert_eq!(snapshot["summary"]["unreconciled_supplier_count"], 0);
            assert_eq!(snapshot["movements"][0]["suggestion"]["confirmable"], false);
            assert!(snapshot["movements"][0]["expense_suggestion"]["candidates"]
                .as_array()
                .unwrap()
                .is_empty());
            let connection = store.connect().unwrap();
            let sum: (i64, i64) = connection
                .query_row(
                    "SELECT SUM(debit_cents),SUM(credit_cents) FROM journal_lines",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(sum, (10810, 10810));
            assert!(connection
                .execute(
                    "UPDATE bank_movements SET unstructured='changed' WHERE id=?",
                    params![movement_id]
                )
                .is_err());
            assert!(connection
                .execute("DELETE FROM bank_expense_reconciliations", [])
                .is_err());
            drop(connection);
            let journal = first["reconciliation"]["journal_entry_id"]
                .as_str()
                .unwrap();
            assert!(store
                .reverse_journal_entry(journal, "2026-09-01", Some("Erreur".into()))
                .is_err());
            let closed = store
                .upsert_accounting_period(AccountingPeriodInput {
                    id: None,
                    name: "Août".into(),
                    date_from: "2026-08-01".into(),
                    date_to: "2026-08-31".into(),
                })
                .unwrap();
            store.close_accounting_period(&value_id(&closed)).unwrap();
            let stable = counts(&store);
            store.confirm_expense_bank_reconciliation(input).unwrap();
            assert_eq!(counts(&store), stable);
            assert_eq!(preview(&store).source_sha256, vat.source_sha256);
            assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
        }
    }
    #[test]
    fn bank_expense_refusals_do_not_pay_or_post_and_replay_cannot_select_another_expense() {
        let (dir, store) = ready();
        let expense_id = expense(&store, false, "2026-08-31");
        for (key, xml) in [
            ("AMOUNT", debit_fixture("108.09", "AMOUNT", None)),
            (
                "NOTICE",
                debit_fixture("108.10", "NOTICE", None)
                    .replace("camt.053", "camt.054")
                    .replace("BkToCstmrStmt", "BkToCstmrDbtCdtNtfctn")
                    .replace("<Stmt>", "<Ntfctn>")
                    .replace("</Stmt>", "</Ntfctn>"),
            ),
            (
                "PENDING",
                fixture(
                    "054",
                    "08",
                    "PDNG",
                    "108.10",
                    "PENDING",
                    Some("D-PENDING"),
                    None,
                    None,
                    false,
                    true,
                )
                .replace("<CdtDbtInd>CRDT</CdtDbtInd>", "<CdtDbtInd>DBIT</CdtDbtInd>"),
            ),
            (
                "REVERSAL",
                debit_fixture("108.10", "REVERSAL", None)
                    .replace("<RvslInd>false</RvslInd>", "<RvslInd>true</RvslInd>"),
            ),
            (
                "EARLY",
                debit_fixture("108.10", "EARLY", None).replace("2026-08-31", "2026-08-19"),
            ),
        ] {
            let movement_id = debit(&store, dir.path(), key, Some(xml));
            let before = counts(&store);
            assert!(
                store
                    .confirm_expense_bank_reconciliation(ConfirmExpenseBankReconciliationInput {
                        date_difference_reason: None,
                        movement_id,
                        expense_id: expense_id.clone()
                    })
                    .is_err(),
                "{key}"
            );
            assert_eq!(counts(&store), before);
        }
        let movement_id = debit(&store, dir.path(), "VALID", None);
        store
            .confirm_expense_bank_reconciliation(ConfirmExpenseBankReconciliationInput {
                date_difference_reason: None,
                movement_id: movement_id.clone(),
                expense_id: expense_id.clone(),
            })
            .unwrap();
        let other_expense = expense(&store, false, "2026-08-31");
        let other_movement = debit(&store, dir.path(), "OTHER", None);
        let before = counts(&store);
        for (movement, expense) in [(movement_id, other_expense), (other_movement, expense_id)] {
            assert!(store
                .confirm_expense_bank_reconciliation(ConfirmExpenseBankReconciliationInput {
                    date_difference_reason: None,
                    movement_id: movement,
                    expense_id: expense
                })
                .is_err());
        }
        assert_eq!(counts(&store), before);
    }
    #[test]
    fn bank_expense_documented_date_difference_preserves_the_original_tax_period() {
        let (dir, store) = ready();
        let expense_id=value_id(&store.create_record("expenses",json!({"date":"2026-06-20","supplier":"Fournisseur","reference":"RECU-ANCIEN","net_cents":10000,"vat_cents":810,"payment_status":"paid","paid_at":"2026-06-30"})).unwrap());
        store
            .set_vat_source_classification(VatSourceClassificationInput {
                source_type: "expense".into(),
                source_id: expense_id.clone(),
                treatment: "input_materials".into(),
                note: None,
            })
            .unwrap();
        let quarter = VatReturnPreviewInput {
            date_from: "2026-04-01".into(),
            date_to: "2026-06-30".into(),
            submission_type: "initial".into(),
            profile_id: None,
        };
        let before_vat = store.preview_vat_return(quarter.clone()).unwrap();
        assert_eq!(before_vat.payable_tax_cents, -810);
        let movement_id = debit(&store, dir.path(), "DIFFERENT-DATE", None);
        let input = ConfirmExpenseBankReconciliationInput {
            movement_id,
            expense_id: expense_id.clone(),
            date_difference_reason: Some(
                "Le relevé récapitule un règlement antérieur, pièce vérifiée.".into(),
            ),
        };
        let before = counts(&store);
        assert!(store
            .confirm_expense_bank_reconciliation(ConfirmExpenseBankReconciliationInput {
                date_difference_reason: Some("ok".into()),
                ..input.clone()
            })
            .is_err());
        assert_eq!(counts(&store), before);
        let result = store
            .confirm_expense_bank_reconciliation(input.clone())
            .unwrap();
        assert_eq!(counts(&store).0, before.0);
        assert_eq!(result["expense"]["paid_at"], "2026-06-30");
        assert_eq!(
            result["reconciliation"]["date_difference_reason"],
            input.date_difference_reason.clone().unwrap()
        );
        let after = counts(&store);
        store
            .confirm_expense_bank_reconciliation(input.clone())
            .unwrap();
        assert_eq!(counts(&store), after);
        assert!(store
            .confirm_expense_bank_reconciliation(ConfirmExpenseBankReconciliationInput {
                date_difference_reason: Some("Autre motif changé".into()),
                ..input
            })
            .is_err());
        assert_eq!(counts(&store), after);
        assert_eq!(
            store.preview_vat_return(quarter).unwrap().source_sha256,
            before_vat.source_sha256
        );
        assert_eq!(preview(&store).payable_tax_cents, 0);
    }
    #[test]
    fn bank_expense_link_freezes_import_and_excludes_customer_and_supplier_payments() {
        let (dir, store) = ready();
        let expense_id = expense(&store, false, "2026-08-31");
        let movement_id = debit(&store, dir.path(), "FROZEN", None);
        store
            .confirm_expense_bank_reconciliation(ConfirmExpenseBankReconciliationInput {
                date_difference_reason: None,
                movement_id: movement_id.clone(),
                expense_id,
            })
            .unwrap();
        let invoice = create_supplier_invoice(&store, 10810, "SUPPLIER-OTHER");
        let before = counts(&store);
        assert!(store
            .confirm_supplier_bank_reconciliation(ConfirmSupplierBankReconciliationInput {
                movement_id: movement_id.clone(),
                supplier_invoice_id: invoice
            })
            .unwrap_err()
            .to_string()
            .contains("dépense"));
        assert!(store
            .confirm_bank_reconciliation(ConfirmBankReconciliationInput {
                movement_id: movement_id.clone(),
                invoice_id: "other".into()
            })
            .unwrap_err()
            .to_string()
            .contains("dépense"));
        assert_eq!(counts(&store), before);
        let connection = store.connect().unwrap();
        let error=connection.execute("INSERT INTO bank_reconciliations(id,movement_id,invoice_id,payment_id,amount_cents,confirmed_at,created_at) VALUES('fake',?,'fake','fake',10810,'now','now')",params![movement_id]).unwrap_err();
        assert!(error
            .to_string()
            .contains("already reconciled to an expense"));
        let original = store.get_bank_workspace().unwrap()["movements"][0].clone();
        let enriched = debit_fixture("108.10", "FROZEN", None)
            .replace("Paiement sans référence", "Communication enrichie");
        let imported = store
            .import_camt_file(&write_xml(dir.path(), "enriched.xml", &enriched))
            .unwrap();
        assert_eq!(imported["skipped_duplicate_count"], 1);
        assert!(imported["warnings"].to_string().contains("figé"));
        assert_eq!(
            store.get_bank_workspace().unwrap()["movements"][0],
            original
        );
        assert_eq!((counts(&store).0, counts(&store).1), (before.0, before.1));
        assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
    }
    #[test]
    fn bank_expense_migration_keeps_existing_expense_and_movement_without_guessing_a_link() {
        let (dir, store) = ready();
        let expense_id = expense(&store, false, "2026-08-31");
        let movement_id = debit(&store, dir.path(), "MIGRATE", None);
        let original = store.get_bank_workspace().unwrap()["movements"][0].clone();
        {
            let connection = store.connect().unwrap();
            connection.execute_batch("DROP TRIGGER bank_movements_expense_frozen; DROP TRIGGER bank_expense_journal_no_isolated_reversal; DROP TRIGGER bank_reconciliations_exclusive_expense; DROP TRIGGER bank_supplier_reconciliations_exclusive_expense; DROP TABLE bank_expense_reconciliations; DROP INDEX idx_expenses_bank_amount; PRAGMA user_version=43;").unwrap();
        }
        drop(store);
        let reopened = LocalStore::initialize(dir.path().join("profile")).unwrap();
        assert_eq!(
            reopened
                .connect()
                .unwrap()
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            reopened.get_bank_workspace().unwrap()["movements"][0],
            original
        );
        assert_eq!(counts(&reopened).1, 0);
        reopened
            .confirm_expense_bank_reconciliation(ConfirmExpenseBankReconciliationInput {
                date_difference_reason: None,
                movement_id,
                expense_id,
            })
            .unwrap();
        assert_eq!(counts(&reopened).1, 1);
    }
    #[test]
    fn bank_expense_closed_period_and_paid_date_mismatch_are_refused_without_rewriting() {
        let (dir, store) = ready();
        let pending = expense(&store, false, "2026-08-31");
        let paid = expense(&store, true, "2026-08-30");
        let movement = debit(&store, dir.path(), "CLOSED", None);
        let before = counts(&store);
        assert!(store
            .confirm_expense_bank_reconciliation(ConfirmExpenseBankReconciliationInput {
                date_difference_reason: None,
                movement_id: movement.clone(),
                expense_id: paid
            })
            .unwrap_err()
            .to_string()
            .contains("date"));
        assert_eq!(counts(&store), before);
        let period = store
            .upsert_accounting_period(AccountingPeriodInput {
                id: None,
                name: "Clôture".into(),
                date_from: "2026-08-31".into(),
                date_to: "2026-08-31".into(),
            })
            .unwrap();
        // Classify the already-paid expense before closing.
        for row in store.get_workspace().unwrap()["expenses"]
            .as_array()
            .unwrap()
        {
            store
                .set_vat_source_classification(VatSourceClassificationInput {
                    source_type: "expense".into(),
                    source_id: value_id(row),
                    treatment: "input_materials".into(),
                    note: None,
                })
                .unwrap();
        }
        store.close_accounting_period(&value_id(&period)).unwrap();
        let before = counts(&store);
        assert!(store
            .confirm_expense_bank_reconciliation(ConfirmExpenseBankReconciliationInput {
                date_difference_reason: None,
                movement_id: movement,
                expense_id: pending.clone()
            })
            .is_err());
        assert_eq!(counts(&store), before);
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT payment_status FROM expenses WHERE id=?",
                    params![pending],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "pending"
        );
    }
}
