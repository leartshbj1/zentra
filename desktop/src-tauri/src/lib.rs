mod accounting;
mod audit;
mod backup;
mod commands;
mod database;
mod error;
mod installation;
mod license;
mod models;
mod noga;
mod payroll;
mod payroll_import;
mod payroll_pdf;
mod reminders;
mod schema;
mod swiss_qr;

use commands::*;
use database::LocalStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(not(test))]
    let builder = builder.plugin(tauri_plugin_dialog::init());

    builder
        .setup(|app| {
            use tauri::Manager;
            let data_dir = resolve_data_dir(app.handle())?;
            let store = LocalStore::initialize(data_dir)?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            get_noga_catalog,
            validate_onboarding,
            complete_onboarding,
            get_workspace,
            create_record,
            update_record,
            delete_record,
            update_settings,
            save_document_with_items,
            issue_quote,
            issue_invoice,
            update_quote_status,
            convert_quote_to_invoice,
            record_payment,
            list_accounts,
            upsert_account,
            delete_account,
            get_accounting_settings,
            configure_accounting,
            list_accounting_periods,
            upsert_accounting_period,
            close_accounting_period,
            post_manual_journal_entry,
            reverse_journal_entry,
            get_accounting_dashboard,
            get_journal,
            get_ledger,
            get_trial_balance,
            get_balance_sheet,
            get_income_statement,
            get_reminder_settings,
            update_reminder_settings,
            list_reminder_templates,
            upsert_reminder_template,
            delete_reminder_template,
            generate_due_reminders,
            list_reminders,
            get_reminder_history,
            mark_reminder,
            record_reminder_action,
            get_payroll_regulatory_profiles,
            list_payroll_contribution_definitions,
            get_payslip_contributions,
            upsert_payroll_contribution_definition,
            delete_payroll_contribution_definition,
            calculate_payroll_contributions,
            apply_payroll_contributions,
            save_payslip_with_contributions,
            post_payslip,
            generate_payslip_pdf,
            stage_payroll_documents,
            list_payroll_document_imports,
            get_payroll_document_preview,
            update_payroll_import_draft,
            confirm_payroll_document_import,
            reject_payroll_document_import,
            validate_swiss_qr_bill,
            generate_swiss_qr_payload,
            get_invoice_qr_bill,
            save_invoice_qr_bill,
            generate_qrr_reference,
            generate_scor_reference,
            list_audit_log,
            verify_audit_log,
            get_license_state,
            install_license_token,
            start_timer,
            stop_timer,
            cancel_timer,
            get_active_timer,
            create_backup,
            restore_backup,
            export_json,
            add_attachment,
            open_attachment,
            open_data_folder,
        ])
        .run(tauri::generate_context!())
        .expect("Elyko n'a pas pu démarrer");
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use pretty_assertions::assert_eq;
    use rusqlite::OptionalExtension;
    use serde_json::json;

    use crate::{
        database::LocalStore,
        models::{
            AccountInput, AccountingPeriodInput, AccountingSettingsInput, ApplyPayrollInput,
            CalculatePayrollInput, ContributionDefinitionInput, ContributionSelectionInput,
            ConvertQuoteInput, ManualJournalInput, ManualJournalLineInput, MarkReminderInput,
            OnboardingInput, PayslipManualLineInput, PeriodFilter, PostPayslipInput,
            RecordPaymentInput, ReminderSettingsInput, ReminderTemplateInput,
            SaveDocumentWithItemsInput, SaveInvoiceQrBillInput, SavePayslipWithContributionsInput,
            SwissQrBillInput, SwissQrParty,
        },
        schema::{BUSINESS_TABLES, SCHEMA_SQL},
    };

    fn test_onboarding() -> OnboardingInput {
        OnboardingInput {
            company_name: "Entreprise de test".into(),
            legal_form: Some("Sàrl".into()),
            owner_name: Some("Responsable test".into()),
            email: Some("test@example.invalid".into()),
            phone: None,
            address_line1: Some("Adresse de test".into()),
            address_line2: None,
            postal_code: Some("1000".into()),
            city: Some("Ville test".into()),
            canton: Some("VD".into()),
            country: Some("CH".into()),
            noga_section: "F".into(),
            noga_division: "43".into(),
            activity_description: "Travaux de construction spécialisés".into(),
            noga_detailed_code: Some("432100".into()),
            uid_number: None,
            vat_number: None,
            vat_registered: false,
            default_vat_bp: Some(0),
            iban: Some("CH44 3199 9123 0008 8901 2".into()),
            bank_name: None,
            currency: "CHF".into(),
            quote_prefix: "D".into(),
            invoice_prefix: "F".into(),
            credit_note_prefix: Some("A".into()),
            quote_start_number: Some(1),
            invoice_start_number: Some(1),
            credit_note_start_number: Some(1),
            payment_terms_days: 30,
            quote_validity_days: 30,
            default_hourly_rate_cents: 0,
            logo_path: Some("C:\\donnees-locales\\logo-test.png".into()),
            extra_settings_json: Some(json!({
                "organization": {"address": {"buildingNumber": "17B"}},
                "work": {"roundingMinutes": 15, "breakMinutes": 5},
                "payroll": {"enabled": false}
            })),
        }
    }

    fn value_id(value: &serde_json::Value) -> String {
        value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .expect("record id")
            .to_owned()
    }

    fn initialized_store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        store
            .complete_onboarding(test_onboarding(), "1.0.0")
            .expect("complete onboarding");
        (temporary, store)
    }

    fn test_invoice_qr_bill(invoice_id: &str, message: &str) -> SaveInvoiceQrBillInput {
        SaveInvoiceQrBillInput {
            invoice_id: invoice_id.to_owned(),
            bill: SwissQrBillInput {
                iban: "CH4431999123000889012".into(),
                creditor: SwissQrParty {
                    name: "Robert Schneider AG".into(),
                    street: "Rue du Lac".into(),
                    building_number: "1268".into(),
                    postal_code: "2501".into(),
                    city: "Biel".into(),
                    country: "CH".into(),
                },
                amount_cents: Some(194_900),
                currency: "CHF".into(),
                debtor: None,
                reference_type: "QRR".into(),
                reference: "210000000003139471430009017".into(),
                unstructured_message: message.into(),
                bill_information: String::new(),
                alternative_procedures: Vec::new(),
            },
        }
    }

    fn accounting_accounts(store: &LocalStore) -> HashMap<&'static str, String> {
        let specs = [
            (
                "ar",
                "1100",
                "Débiteurs",
                "asset",
                "debit",
                "current_assets",
            ),
            (
                "revenue",
                "3000",
                "Produits",
                "revenue",
                "credit",
                "net_revenue",
            ),
            (
                "vat_payable",
                "2200",
                "TVA due",
                "liability",
                "credit",
                "short_term_liabilities",
            ),
            ("bank", "1020", "Banque", "asset", "debit", "current_assets"),
            (
                "expense",
                "6000",
                "Charges",
                "expense",
                "debit",
                "other_operating_expense",
            ),
            (
                "vat_receivable",
                "1170",
                "TVA préalable",
                "asset",
                "debit",
                "current_assets",
            ),
            (
                "wages_expense",
                "5000",
                "Salaires",
                "expense",
                "debit",
                "personnel_expense",
            ),
            (
                "wages_payable",
                "2000",
                "Salaires dus",
                "liability",
                "credit",
                "short_term_liabilities",
            ),
            (
                "social_expense",
                "5700",
                "Charges sociales",
                "expense",
                "debit",
                "personnel_expense",
            ),
            (
                "social_payable",
                "2270",
                "Cotisations dues",
                "liability",
                "credit",
                "short_term_liabilities",
            ),
        ];
        let mut result = HashMap::new();
        for (key, code, name, account_type, normal_balance, report_section) in specs {
            let row = store
                .upsert_account(AccountInput {
                    id: None,
                    code: code.into(),
                    name: name.into(),
                    account_type: account_type.into(),
                    normal_balance: normal_balance.into(),
                    report_section: report_section.into(),
                    active: true,
                })
                .expect("upsert account");
            result.insert(key, value_id(&row));
        }
        result
    }

    fn enable_accounting(store: &LocalStore) -> HashMap<&'static str, String> {
        let a = accounting_accounts(store);
        store
            .configure_accounting(AccountingSettingsInput {
                enabled: true,
                ar_account_id: Some(a["ar"].clone()),
                revenue_account_id: Some(a["revenue"].clone()),
                vat_payable_account_id: Some(a["vat_payable"].clone()),
                bank_account_id: Some(a["bank"].clone()),
                expense_account_id: Some(a["expense"].clone()),
                vat_receivable_account_id: Some(a["vat_receivable"].clone()),
                wages_expense_account_id: Some(a["wages_expense"].clone()),
                wages_payable_account_id: Some(a["wages_payable"].clone()),
                social_expense_account_id: Some(a["social_expense"].clone()),
                social_payable_account_id: Some(a["social_payable"].clone()),
            })
            .expect("configure accounting");
        a
    }

    #[test]
    fn fresh_database_is_empty_and_requires_onboarding() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        let state = store.app_state("1.0.0").expect("application state");
        assert!(!state.onboarding_completed);
        assert!(state.activity_profile_required);

        let connection = store.connect().expect("database connection");
        let settings_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
            .expect("settings count");
        let sequence_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM number_sequences", [], |row| {
                row.get(0)
            })
            .expect("sequence count");
        assert_eq!(settings_count, 0);
        assert_eq!(sequence_count, 0);
        for (table, count) in store.business_row_counts().expect("business counts") {
            assert_eq!(count, 0, "fresh table {table} must be empty");
        }
    }

    #[test]
    fn onboarding_creates_only_real_settings_and_no_business_rows() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        let state = store
            .complete_onboarding(test_onboarding(), "1.0.0")
            .expect("complete onboarding");
        assert!(state.app_state.onboarding_completed);
        assert!(!state.app_state.activity_profile_required);
        assert_eq!(
            state.workspace["settings"]["company_name"],
            "Entreprise de test"
        );

        let connection = store.connect().expect("database connection");
        let company_name: Option<String> = connection
            .query_row(
                "SELECT company_name FROM settings WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("settings query");
        assert_eq!(company_name.as_deref(), Some("Entreprise de test"));
        let activity: (String, String, String, String) = connection
            .query_row(
                "SELECT noga_section,noga_division,activity_description,noga_detailed_code FROM settings WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("activity profile");
        assert_eq!(
            activity,
            (
                "F".into(),
                "43".into(),
                "Travaux de construction spécialisés".into(),
                "432100".into()
            )
        );
        for table in BUSINESS_TABLES {
            let count = store
                .business_row_counts()
                .expect("business counts")
                .get(*table)
                .copied()
                .expect("known table");
            assert_eq!(count, 0, "onboarding must not seed {table}");
        }
    }

    #[test]
    fn onboarding_preflight_is_read_only_and_matches_the_atomic_commit() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        let mut input = test_onboarding();
        input.extra_settings_json = Some(serde_json::Value::String(
            json!({
                "organization": {
                    "website": "https://example.invalid",
                    "address": {"buildingNumber": "17B"}
                },
                "billing": {
                    "accountHolder": "Entreprise de test",
                    "creditNotePrefix": "A",
                    "nextQuoteNumber": 1,
                    "nextInvoiceNumber": 1,
                    "nextCreditNoteNumber": 1,
                    "quoteValidityDays": 30,
                    "vatRatesBp": [],
                    "defaultFooter": ""
                },
                "work": {
                    "workWeekHours": 42,
                    "dailyHours": 8.4,
                    "roundingMinutes": 5,
                    "breakMinutes": 30,
                    "costCategories": ["Matériaux"]
                },
                "payroll": {
                    "enabled": false,
                    "fiduciaryValidated": false,
                    "avsFund": "",
                    "accidentInsurer": "",
                    "pensionFund": "",
                    "dailyAllowanceInsurer": "",
                    "familyAllowanceFund": "",
                    "payrollCanton": "",
                    "employeeRates": [],
                    "employerRates": []
                },
                "backup": {
                    "automatic": false,
                    "folder": "C:\\sauvegardes",
                    "frequency": "manual",
                    "retentionDaily": 0,
                    "retentionWeekly": 0,
                    "retentionMonthly": 0,
                    "recoveryConfirmed": true
                }
            })
            .to_string(),
        ));

        let validation = store.validate_onboarding(input.clone());
        assert!(
            validation.valid,
            "unexpected issues: {:?}",
            validation.issues
        );
        assert!(validation.issues.is_empty());
        let settings_before: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(settings_before, 0, "preflight must not write settings");

        let completed = store
            .complete_onboarding(input, "1.0.0")
            .expect("atomic onboarding commit");
        assert!(completed.app_state.onboarding_completed);
        assert!(!completed.app_state.activity_profile_required);
        assert_eq!(completed.app_state.app_version, "1.0.0");
        assert_eq!(
            completed.workspace["settings"]["company_name"],
            "Entreprise de test"
        );
        assert!(completed.workspace["clients"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(completed.workspace["projects"]
            .as_array()
            .unwrap()
            .is_empty());
        let serialized = serde_json::to_value(completed).expect("serializable completion result");
        assert_eq!(serialized["app_state"]["onboarding_completed"], true);
        assert_eq!(
            serialized["workspace"]["settings"]["company_name"],
            "Entreprise de test"
        );
    }

    #[test]
    fn onboarding_preflight_reports_the_observed_invalid_iban_without_writing() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        let mut input = test_onboarding();
        input.iban = Some("CH6534632536263W".into());

        let validation = store.validate_onboarding(input.clone());
        assert!(!validation.valid);
        let issue = validation
            .issues
            .iter()
            .find(|issue| issue.field == "billing.iban")
            .expect("structured IBAN issue");
        assert_eq!(issue.step, 2);
        assert_eq!(issue.label, "L’IBAN");
        assert!(issue.message.contains("IBAN CH ou LI"));

        let error = store
            .complete_onboarding(input, "1.0.0")
            .expect_err("the same validation must block the commit");
        assert!(error.to_string().contains("IBAN CH ou LI"));
        let settings_count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(settings_count, 0);
    }

    #[test]
    fn onboarding_preflight_collects_stale_vat_and_payroll_issues() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        let mut input = test_onboarding();
        input.vat_registered = false;
        input.default_vat_bp = Some(810);
        input.payment_terms_days = 0;
        input.quote_validity_days = 366;
        input.extra_settings_json = Some(json!({
            "payroll": {
                "enabled": false,
                "employeeRates": [{
                    "id": "",
                    "label": "",
                    "rateBp": 0,
                    "annualCeilingCents": 0,
                    "effectiveFrom": ""
                }, {
                    "id": "taux-duplique",
                    "label": "Taux valide",
                    "rateBp": 100,
                    "effectiveFrom": "2026-01-01"
                }, {
                    "id": "taux-duplique",
                    "label": "x".repeat(201),
                    "rateBp": 100,
                    "annualCeilingCents": -1,
                    "effectiveFrom": "2026-01-01"
                }],
                "employerRates": []
            }
        }));

        let validation = store.validate_onboarding(input.clone());
        assert!(!validation.valid);
        for field in [
            "billing.vatRatesBp",
            "billing.paymentTermsDays",
            "billing.quoteValidityDays",
            "payroll.employeeRates.0.id",
            "payroll.employeeRates.0.label",
            "payroll.employeeRates.0.rateBp",
            "payroll.employeeRates.0.annualCeilingCents",
            "payroll.employeeRates.0.effectiveFrom",
            "payroll.employeeRates.taux-duplique.id",
            "payroll.employeeRates.taux-duplique.label",
            "payroll.employeeRates.taux-duplique.annualCeilingCents",
        ] {
            assert!(
                validation.issues.iter().any(|issue| issue.field == field),
                "missing structured issue for {field}: {:?}",
                validation.issues
            );
        }
        assert!(validation
            .issues
            .iter()
            .all(|issue| !issue.label.is_empty() && !issue.message.is_empty()));

        assert!(store.complete_onboarding(input, "1.0.0").is_err());
        let empty_counts: (i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM settings),(SELECT COUNT(*) FROM payroll_contribution_definitions)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(empty_counts, (0, 0));
    }

    #[test]
    fn onboarding_rolls_back_when_the_completion_snapshot_cannot_be_built() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        store
            .connect()
            .unwrap()
            .execute("DROP TABLE clients", [])
            .expect("break the snapshot query after onboarding writes");

        assert!(store
            .complete_onboarding(test_onboarding(), "1.0.0")
            .is_err());
        let persisted_counts: (i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM settings),(SELECT COUNT(*) FROM number_sequences)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            persisted_counts,
            (0, 0),
            "settings and sequences must roll back if the returned workspace cannot be built"
        );
    }

    #[test]
    fn v2_migration_requires_only_activity_profile_and_preserves_real_data() {
        let temporary = tempfile::tempdir().unwrap();
        let data_dir = temporary.path().join("legacy-profile");
        std::fs::create_dir_all(&data_dir).unwrap();
        let database_path = data_dir.join("helvichantier.sqlite3");
        let legacy_schema = SCHEMA_SQL
            .replace("  noga_section TEXT,\n", "")
            .replace("  noga_division TEXT,\n", "")
            .replace("  activity_description TEXT,\n", "")
            .replace("  noga_detailed_code TEXT,\n", "")
            .replace("PRAGMA user_version = 5;", "PRAGMA user_version = 2;");
        let connection = rusqlite::Connection::open(&database_path).unwrap();
        connection.execute_batch(&legacy_schema).unwrap();
        connection.execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise historique','2025-01-01','2025-01-01')",[]).unwrap();
        connection.execute("INSERT INTO clients(id,name,country,created_at,updated_at) VALUES('client-historique','Client conservé','CH','2025-01-01','2025-01-01')",[]).unwrap();
        drop(connection);

        let store = LocalStore::initialize(data_dir).unwrap();
        let state = store.app_state("1.0.0").unwrap();
        assert!(state.onboarding_completed);
        assert!(state.activity_profile_required);
        let workspace = store.get_workspace().unwrap();
        assert_eq!(
            workspace["settings"]["company_name"],
            "Entreprise historique"
        );
        assert_eq!(
            workspace["settings"]["noga_section"],
            serde_json::Value::Null
        );
        assert_eq!(workspace["clients"][0]["name"], "Client conservé");

        store
            .update_settings(json!({
                "noga_section":"F",
                "noga_division":"43",
                "activity_description":"Rénovation de bâtiments",
                "noga_detailed_code":null,
                "iban":"CH4431999123000889012"
            }))
            .unwrap();
        let completed = store.app_state("1.0.0").unwrap();
        assert!(completed.onboarding_completed);
        assert!(!completed.activity_profile_required);
        assert_eq!(
            store.get_workspace().unwrap()["clients"][0]["name"],
            "Client conservé"
        );
    }

    #[test]
    fn v3_database_without_qr_table_is_repaired_without_losing_data() {
        let temporary = tempfile::tempdir().unwrap();
        let data_dir = temporary.path().join("pre-qr-v3-profile");
        std::fs::create_dir_all(&data_dir).unwrap();
        let database_path = data_dir.join("helvichantier.sqlite3");
        let connection = rusqlite::Connection::open(&database_path).unwrap();
        connection.execute_batch(SCHEMA_SQL).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER IF EXISTS invoice_qr_bills_frozen_no_update;
                 DROP TRIGGER IF EXISTS invoice_qr_bills_frozen_no_delete;
                 DROP INDEX IF EXISTS idx_invoice_qr_bills_frozen;
                 DROP TABLE invoice_qr_bills;
                 PRAGMA user_version=3;",
            )
            .unwrap();
        connection.execute("INSERT INTO settings(id,onboarding_completed,company_name,noga_section,noga_division,activity_description,created_at,updated_at) VALUES(1,1,'Entreprise v3','F','43','Entreprise historique','2026-01-01','2026-01-01')",[]).unwrap();
        connection.execute("INSERT INTO clients(id,name,country,created_at,updated_at) VALUES('client-v3','Client v3 conservé','CH','2026-01-01','2026-01-01')",[]).unwrap();
        drop(connection);

        let store = LocalStore::initialize(data_dir).unwrap();
        let connection = store.connect().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 5);
        let qr_table: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='invoice_qr_bills'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let qr_guards: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'invoice_qr_bills_frozen_no_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(qr_table, 1);
        assert_eq!(qr_guards, 2);
        assert_eq!(
            store.get_workspace().unwrap()["clients"][0]["name"],
            "Client v3 conservé"
        );
        assert!(store.get_workspace().unwrap()["invoice_qr_bills"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn noga_2025_profile_is_validated_and_updateable_without_defaults() {
        let catalog = crate::noga::catalog_json();
        assert_eq!(catalog["sections"].as_array().unwrap().len(), 22);
        let divisions = catalog["sections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|section| section["divisions"].as_array().unwrap().len())
            .sum::<usize>();
        assert_eq!(divisions, 87);

        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let mut incompatible = test_onboarding();
        incompatible.noga_section = "F".into();
        incompatible.noga_division = "62".into();
        assert!(store
            .complete_onboarding(incompatible, "1.0.0")
            .unwrap_err()
            .to_string()
            .contains("n'appartient pas"));
        store
            .complete_onboarding(test_onboarding(), "1.0.0")
            .unwrap();
        store
            .update_settings(json!({
                "noga_section":"N",
                "noga_division":"71",
                "activity_description":"Architecture et ingénierie",
                "noga_detailed_code":"7112"
            }))
            .unwrap();
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["settings"]["noga_section"], "N");
        assert_eq!(workspace["settings"]["noga_division"], "71");
        assert_eq!(
            workspace["settings"]["activity_description"],
            "Architecture et ingénierie"
        );
        assert_eq!(workspace["settings"]["noga_detailed_code"], "7112");
        let invalid_detail = store.update_settings(json!({"noga_detailed_code":"621000"}));
        assert!(invalid_detail
            .unwrap_err()
            .to_string()
            .contains("commencer par la division"));
    }

    #[test]
    fn vat_rate_is_explicit_for_registered_companies() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        let mut input = test_onboarding();
        input.vat_registered = true;
        input.default_vat_bp = None;
        let error = store
            .complete_onboarding(input, "1.0.0")
            .expect_err("missing explicit VAT rate must fail");
        assert!(error.to_string().contains("taux de TVA explicite"));
    }

    #[test]
    fn vat_registered_company_requires_an_uid_or_vat_identifier() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        let mut input = test_onboarding();
        input.vat_registered = true;
        input.default_vat_bp = Some(100);
        let error = store
            .complete_onboarding(input, "1.0.0")
            .expect_err("missing UID/VAT identifier must fail");
        assert!(error.to_string().contains("uid_number ou vat_number"));

        let mut valid = test_onboarding();
        valid.vat_registered = true;
        valid.default_vat_bp = Some(100);
        valid.uid_number = Some("CHE-000.000.000 TVA".into());
        store.complete_onboarding(valid, "1.0.0").unwrap();
        let clearing = store.update_settings(json!({"uid_number":"","vat_number":""}));
        assert!(clearing
            .unwrap_err()
            .to_string()
            .contains("uid_number ou vat_number"));
    }

    #[test]
    fn invalid_iban_is_rejected_before_settings_or_invoice_numbering() {
        let temporary = tempfile::tempdir().unwrap();
        let fresh = LocalStore::initialize(temporary.path().join("fresh")).unwrap();
        let mut invalid = test_onboarding();
        invalid.iban = Some("CH00 INVALID".into());
        assert!(fresh
            .complete_onboarding(invalid, "1.0.0")
            .unwrap_err()
            .to_string()
            .contains("IBAN CH ou LI"));
        let settings_count: i64 = fresh
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(settings_count, 0);

        let (_profile, store) = initialized_store();
        assert_eq!(
            store.get_workspace().unwrap()["settings"]["iban"],
            "CH4431999123000889012"
        );
        assert!(store
            .update_settings(json!({"iban":"CH00 INVALID"}))
            .unwrap_err()
            .to_string()
            .contains("IBAN CH ou LI"));
        let client_id = value_id(
            &store
                .create_record("clients", json!({"name":"Client IBAN"}))
                .unwrap(),
        );
        let invoice_id=value_id(&store.create_record("invoices",json!({"client_id":client_id,"title":"Facture bloquée","service_date_from":"2026-08-01","service_date_to":"2026-08-31"})).unwrap());
        store.create_record("invoice_items",json!({"invoice_id":invoice_id,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0})).unwrap();
        store
            .connect()
            .unwrap()
            .execute("UPDATE settings SET iban='CH00INVALID' WHERE id=1", [])
            .unwrap();
        assert!(store
            .issue_invoice(&invoice_id, Some("2026-09-01".into()), None)
            .unwrap_err()
            .to_string()
            .contains("IBAN CH ou LI"));
        let connection = store.connect().unwrap();
        let number: Option<String> = connection
            .query_row(
                "SELECT number FROM invoices WHERE id=?",
                rusqlite::params![invoice_id],
                |row| row.get(0),
            )
            .unwrap();
        let sequence_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM number_sequences WHERE document_type='invoice'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(number, None);
        assert_eq!(sequence_count, 0);
    }

    #[test]
    fn document_totals_and_numbers_are_computed_locally() {
        let (_temporary, store) = initialized_store();
        let client = store
            .create_record("clients", json!({"name": "Client vérifié"}))
            .expect("create client");
        let client_id = value_id(&client);
        let quote = store
            .create_record(
                "quotes",
                json!({
                    "client_id": client_id,
                    "title": "Travaux saisis",
                    "subtotal_cents": 999_999,
                    "vat_cents": 999_999,
                    "total_cents": 999_999
                }),
            )
            .expect("create quote");
        let quote_id = value_id(&quote);
        store
            .create_record(
                "quote_items",
                json!({
                    "quote_id": quote_id,
                    "position": 0,
                    "description": "Ligne explicitement saisie",
                    "quantity": 2.5,
                    "unit": "heure",
                    "unit_price_cents": 4_000,
                    "discount_bp": 0,
                    "vat_bp": 0,
                    "line_total_cents": 1
                }),
            )
            .expect("create quote item");
        let issued = store
            .issue_quote(
                &quote_id,
                Some("2026-08-30".into()),
                Some("2026-09-30".into()),
            )
            .expect("issue quote");
        assert_eq!(issued["number"], "D-2026-0001");
        assert_eq!(issued["subtotal_cents"], 10_000);
        assert_eq!(issued["total_cents"], 10_000);

        let issued_again = store
            .issue_quote(&quote_id, Some("2026-08-31".into()), None)
            .expect("reissue idempotently");
        assert_eq!(issued_again["number"], "D-2026-0001");

        let second_quote = store
            .create_record(
                "quotes",
                json!({"client_id": client_id, "title": "Deuxième brouillon"}),
            )
            .expect("create second quote");
        let second_quote_id = value_id(&second_quote);
        assert_eq!(second_quote["number"], json!(null));
        store.create_record("quote_items",json!({"quote_id":second_quote_id,"description":"Seconde ligne saisie","quantity":1,"unit":"forfait","unit_price_cents":100,"vat_bp":0})).expect("create second quote item");
        let second_issued = store
            .issue_quote(
                &second_quote_id,
                Some("2026-08-30".into()),
                Some("2026-09-30".into()),
            )
            .expect("issue second quote");
        assert_eq!(second_issued["number"], "D-2026-0002");
        let connection = store.connect().expect("database connection");
        let next_value: i64 = connection
            .query_row(
                "SELECT next_value FROM number_sequences WHERE document_type='quote' AND year=2026",
                [],
                |row| row.get(0),
            )
            .expect("number sequence");
        assert_eq!(next_value, 3);
    }

    #[test]
    fn document_and_all_lines_are_saved_in_one_transaction() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", json!({"name":"Client transaction"}))
                .unwrap(),
        );
        let saved = store
            .save_document_with_items(SaveDocumentWithItemsInput {
                entity: "quotes".into(),
                id: None,
                data: json!({"client_id":client_id,"title":"Titre initial","currency":"CHF"}),
                items: vec![json!({
                    "id":"ligne-stable",
                    "description":"Ligne initiale",
                    "quantity":2,
                    "unit":"heure",
                    "unit_price_cents":10_000,
                    "discount_bp":0,
                    "vat_bp":0
                })],
            })
            .unwrap();
        let document_id = saved["document"]["id"].as_str().unwrap().to_owned();
        assert_eq!(saved["document"]["total_cents"], 20_000);
        assert_eq!(saved["items"][0]["id"], "ligne-stable");

        let failed = store.save_document_with_items(SaveDocumentWithItemsInput {
            entity: "quotes".into(),
            id: Some(document_id.clone()),
            data: json!({"title":"Titre qui doit être annulé"}),
            items: vec![
                json!({"description":"Première nouvelle ligne","quantity":1,"unit":"heure","unit_price_cents":5_000,"discount_bp":0,"vat_bp":0}),
                json!({"description":"Ligne invalide","quantity":1,"unit":"heure","unit_price_cents":5_000,"discount_bp":0,"vat_bp":10_001}),
            ],
        });
        assert!(failed.is_err());
        let connection = store.connect().unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM quotes WHERE id=?",
                rusqlite::params![document_id],
                |row| row.get(0),
            )
            .unwrap();
        let remaining: (i64, String) = connection
            .query_row(
                "SELECT COUNT(*),MIN(description) FROM quote_items WHERE quote_id=?",
                rusqlite::params![document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Titre initial");
        assert_eq!(remaining, (1, "Ligne initiale".into()));
    }

    #[test]
    fn payroll_lines_recompute_the_payslip_without_hidden_rates() {
        let (_temporary, store) = initialized_store();
        let employee = store
            .create_record("employees", json!({"name": "Collaborateur saisi"}))
            .expect("create employee");
        let employee_id = value_id(&employee);
        let payslip = store
            .create_record(
                "payslips",
                json!({
                    "employee_id": employee_id,
                    "period": "2026-08",
                    "status": "a_controler",
                    "gross_cents": 999_999,
                    "deductions_cents": 999_999,
                    "net_cents": 999_999
                }),
            )
            .expect("create payslip");
        let payslip_id = value_id(&payslip);
        for (position, kind, amount) in [
            (0, "earning", 500_000),
            (1, "deduction", 75_000),
            (2, "employer", 35_000),
        ] {
            store
                .create_record(
                    "payslip_items",
                    json!({
                        "payslip_id": payslip_id,
                        "position": position,
                        "label": format!("Ligne {position}"),
                        "kind": kind,
                        "amount_cents": amount
                    }),
                )
                .expect("create payslip item");
        }
        let connection = store.connect().expect("database connection");
        let totals: (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT gross_cents,deductions_cents,net_cents,employer_costs_cents FROM payslips WHERE id=?",
                rusqlite::params![payslip_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("payslip totals");
        assert_eq!(totals, (500_000, 75_000, 425_000, 35_000));
        let not_validated = store
            .post_payslip(PostPayslipInput {
                payslip_id: payslip_id.clone(),
                entry_date: Some("2026-08-31".into()),
            })
            .unwrap_err();
        assert!(not_validated.to_string().contains("statut valide"));
        store
            .update_record("payslips", &payslip_id, json!({"status":"valide"}))
            .unwrap();
        let accounting_missing = store
            .post_payslip(PostPayslipInput {
                payslip_id,
                entry_date: Some("2026-08-31".into()),
            })
            .unwrap_err();
        assert!(accounting_missing.to_string().contains("comptabilité"));
    }

    #[test]
    fn backup_restore_round_trip_recovers_local_rows() {
        let (temporary, store) = initialized_store();
        let client = store
            .create_record("clients", json!({"name": "Client à sauvegarder"}))
            .expect("create client");
        let client_id = value_id(&client);
        let backup_path = temporary.path().join("recette.elyko");
        store
            .create_backup(Some(backup_path.to_string_lossy().into_owned()), "1.0.0")
            .expect("create backup");
        store
            .update_settings(json!({
                "noga_section":"F",
                "noga_division":"41",
                "activity_description":"Construction de bâtiments",
                "noga_detailed_code":"410000",
                "logo_path":"C:\\autre-logo.png",
                "extra_settings_json":{"organization":{"address":{"buildingNumber":"99"}}}
            }))
            .expect("mutate settings after backup");
        store
            .delete_record("clients", &client_id)
            .expect("delete client after backup");
        store
            .restore_backup(&backup_path.to_string_lossy(), "1.0.0")
            .expect("restore backup");
        let connection = store.connect().expect("database connection");
        let restored_name: String = connection
            .query_row(
                "SELECT name FROM clients WHERE id=?",
                rusqlite::params![client_id],
                |row| row.get(0),
            )
            .expect("restored client");
        assert_eq!(restored_name, "Client à sauvegarder");
        let restored_profile: (String, String, String, String, String) = connection
            .query_row(
                "SELECT noga_section,noga_division,activity_description,noga_detailed_code,logo_path FROM settings WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .expect("restored activity profile");
        assert_eq!(
            restored_profile,
            (
                "F".into(),
                "43".into(),
                "Travaux de construction spécialisés".into(),
                "432100".into(),
                "C:\\donnees-locales\\logo-test.png".into()
            )
        );
        let restored_extra: String = connection
            .query_row(
                "SELECT extra_settings_json FROM settings WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&restored_extra).unwrap()["organization"]
                ["address"]["buildingNumber"],
            "17B"
        );
    }

    #[test]
    fn issued_invoice_qr_bill_is_frozen_and_survives_backup_restore() {
        let (temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record(
                    "clients",
                    json!({
                        "name":"Client QR",
                        "address_line1":"Rue du Client",
                        "address_line2":"7",
                        "postal_code":"1000",
                        "city":"Lausanne",
                        "country":"CH"
                    }),
                )
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture avec QR figée",
                        "service_date_from":"2026-08-01",
                        "service_date_to":"2026-08-31"
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":invoice_id,
                    "description":"Prestation réelle",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":194_900,
                    "vat_bp":0
                }),
            )
            .unwrap();

        let draft = store
            .save_invoice_qr_bill(test_invoice_qr_bill(&invoice_id, "Version brouillon"))
            .unwrap();
        assert_eq!(draft["frozen"], false);
        let final_draft = store
            .save_invoice_qr_bill(test_invoice_qr_bill(&invoice_id, "Facture août 2026"))
            .unwrap();
        let expected_payload = final_draft["payload"].as_str().unwrap().to_owned();

        let issued = store
            .issue_invoice(
                &invoice_id,
                Some("2026-09-01".into()),
                Some("2026-09-30".into()),
            )
            .unwrap();
        let snapshot: serde_json::Value =
            serde_json::from_str(issued["snapshot_json"].as_str().unwrap()).unwrap();
        assert_eq!(snapshot["qr_bill"]["payload"], expected_payload);
        assert!(snapshot["qr_bill"]["frozen_at"].is_string());

        let frozen = store.get_invoice_qr_bill(&invoice_id).unwrap();
        assert_eq!(frozen["frozen"], true);
        assert_eq!(frozen["payload"], expected_payload);
        let idempotent = store
            .save_invoice_qr_bill(test_invoice_qr_bill(&invoice_id, "Facture août 2026"))
            .unwrap();
        assert_eq!(idempotent["payload"], expected_payload);
        let changed = store
            .save_invoice_qr_bill(test_invoice_qr_bill(&invoice_id, "Valeur modifiée"))
            .unwrap_err();
        assert!(changed.to_string().contains("immuable"));
        let trigger_rejects_update = store.connect().unwrap().execute(
            "UPDATE invoice_qr_bills SET payload='altéré' WHERE invoice_id=?",
            rusqlite::params![invoice_id],
        );
        assert!(trigger_rejects_update.is_err());

        let backup_path = temporary.path().join("qr-frozen.elyko");
        store
            .create_backup(Some(backup_path.to_string_lossy().into_owned()), "1.0.0")
            .unwrap();
        store
            .restore_backup(&backup_path.to_string_lossy(), "1.0.0")
            .unwrap();
        let restored = store.get_invoice_qr_bill(&invoice_id).unwrap();
        assert_eq!(restored["payload"], expected_payload);
        assert_eq!(restored["frozen"], true);
        assert_eq!(
            store.get_workspace().unwrap()["invoice_qr_bills"][0]["invoice_id"],
            invoice_id
        );
    }

    #[test]
    fn timer_creates_a_real_time_entry_and_clears_itself() {
        let (_temporary, store) = initialized_store();
        let client = store
            .create_record("clients", json!({"name": "Client chronomètre"}))
            .expect("create client");
        let project = store
            .create_record(
                "projects",
                json!({"client_id": value_id(&client), "name": "Chantier chronométré"}),
            )
            .expect("create project");
        store
            .start_timer(crate::models::TimerInput {
                project_id: value_id(&project),
                employee_id: None,
                note: Some("Temps réellement mesuré".into()),
                billable: true,
                billing_rate_cents: 0,
                cost_rate_cents: 0,
            })
            .expect("start timer");
        let simulated_start = (chrono::Utc::now() - chrono::Duration::seconds(3_670)).to_rfc3339();
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE active_timers SET started_at=? WHERE id=1",
                rusqlite::params![simulated_start],
            )
            .unwrap();
        let entry = store.stop_timer().expect("stop timer");
        assert_eq!(entry["minutes"], 60);
        assert_eq!(entry["break_minutes"], 5);
        assert_eq!(entry["note"], "Temps réellement mesuré");
        assert_eq!(store.get_active_timer().expect("active timer"), json!(null));
    }

    #[test]
    fn configured_sequences_credit_notes_and_document_immutability_are_enforced() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let mut onboarding = test_onboarding();
        onboarding.quote_start_number = Some(7);
        onboarding.invoice_start_number = Some(20);
        onboarding.credit_note_start_number = Some(30);
        onboarding.credit_note_prefix = Some("NC".into());
        store.complete_onboarding(onboarding, "1.0.0").unwrap();
        let client_id=value_id(&store.create_record("clients",json!({"name":"Client documents","address_line1":"Rue du Test","address_line2":"4","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap());
        let quote_id = value_id(
            &store
                .create_record(
                    "quotes",
                    json!({"client_id":client_id,"title":"Devis réel"}),
                )
                .unwrap(),
        );
        store.create_record("quote_items",json!({"quote_id":quote_id,"description":"Travaux","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0})).unwrap();
        let quote = store
            .issue_quote(
                &quote_id,
                Some("2026-03-01".into()),
                Some("2026-03-31".into()),
            )
            .unwrap();
        assert_eq!(quote["number"], "D-2026-0007");
        let invoice_id=value_id(&store.create_record("invoices",json!({"client_id":client_id,"title":"Facture originale","service_date_from":"2026-02-01","service_date_to":"2026-02-28"})).unwrap());
        store.create_record("invoice_items",json!({"invoice_id":invoice_id,"description":"Travaux","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0})).unwrap();
        let invoice = store
            .issue_invoice(
                &invoice_id,
                Some("2026-03-01".into()),
                Some("2026-03-31".into()),
            )
            .unwrap();
        assert_eq!(invoice["number"], "F-2026-0020");
        let snapshot = invoice["snapshot_json"].as_str().unwrap().to_owned();
        let parsed_snapshot: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        assert_eq!(parsed_snapshot["issuer"]["building_number"], "17B");
        assert_eq!(
            parsed_snapshot["issuer"]["logo_path"],
            "C:\\donnees-locales\\logo-test.png"
        );
        assert_eq!(parsed_snapshot["issuer"]["noga_section"], "F");
        assert_eq!(parsed_snapshot["issuer"]["noga_division"], "43");
        store
            .update_settings(json!({
                "company_name":"Nouvelle raison sociale",
                "logo_path":"C:\\logo-modifie.png",
                "extra_settings_json":{"organization":{"address":{"buildingNumber":"99"}}}
            }))
            .unwrap();
        let unchanged = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT snapshot_json FROM invoices WHERE id=?",
                rusqlite::params![invoice_id],
                |r| r.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(unchanged, snapshot);
        let frozen_snapshot: serde_json::Value = serde_json::from_str(&unchanged).unwrap();
        assert_eq!(frozen_snapshot["issuer"]["building_number"], "17B");
        assert_eq!(
            frozen_snapshot["issuer"]["logo_path"],
            "C:\\donnees-locales\\logo-test.png"
        );
        let credit_id=value_id(&store.create_record("invoices",json!({"client_id":client_id,"original_invoice_id":invoice_id,"title":"Correction","type":"credit_note","service_date_from":"2026-02-01","service_date_to":"2026-02-28"})).unwrap());
        store.create_record("invoice_items",json!({"invoice_id":credit_id,"description":"Correction","quantity":1,"unit":"forfait","unit_price_cents":2500,"vat_bp":0})).unwrap();
        let credit = store
            .issue_invoice(&credit_id, Some("2026-03-02".into()), None)
            .unwrap();
        assert_eq!(credit["number"], "NC-2026-0030");
        assert_eq!(credit["total_cents"], -2500);
        let original_status: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT status FROM invoices WHERE id=?",
                rusqlite::params![invoice_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(original_status, "emise");
        let excessive_payment = store.record_payment(RecordPaymentInput {
            invoice_id: invoice_id.clone(),
            amount_cents: 7501,
            date: Some("2026-03-03".into()),
            method: Some("bank".into()),
            reference: None,
            notes: None,
        });
        assert!(excessive_payment.unwrap_err().to_string().contains("solde"));
        store
            .record_payment(RecordPaymentInput {
                invoice_id: invoice_id.clone(),
                amount_cents: 7500,
                date: Some("2026-03-03".into()),
                method: Some("bank".into()),
                reference: None,
                notes: None,
            })
            .unwrap();
        let settled: (i64, String) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT paid_cents,status FROM invoices WHERE id=?",
                rusqlite::params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(settled, (7500, "payee".into()));
        let other_client_id = value_id(
            &store
                .create_record("clients", json!({"name":"Autre client"}))
                .unwrap(),
        );
        let wrong_client_credit=value_id(&store.create_record("invoices",json!({"client_id":other_client_id,"original_invoice_id":invoice_id,"title":"Avoir mauvais client","type":"credit_note","service_date_from":"2026-02-01","service_date_to":"2026-02-28"})).unwrap());
        store.create_record("invoice_items",json!({"invoice_id":wrong_client_credit,"description":"Correction","quantity":1,"unit":"forfait","unit_price_cents":1000,"vat_bp":0})).unwrap();
        assert!(store
            .issue_invoice(&wrong_client_credit, Some("2026-03-03".into()), None)
            .unwrap_err()
            .to_string()
            .contains("client"));
        let excessive_credit=value_id(&store.create_record("invoices",json!({"client_id":client_id,"original_invoice_id":invoice_id,"title":"Avoir excessif","type":"credit_note","service_date_from":"2026-02-01","service_date_to":"2026-02-28"})).unwrap());
        store.create_record("invoice_items",json!({"invoice_id":excessive_credit,"description":"Correction excessive","quantity":1,"unit":"forfait","unit_price_cents":8000,"vat_bp":0})).unwrap();
        assert!(store
            .issue_invoice(&excessive_credit, Some("2026-03-03".into()), None)
            .unwrap_err()
            .to_string()
            .contains("cumul"));
        assert!(store.delete_record("invoices", &invoice_id).is_err());
        let direct = store.connect().unwrap().execute(
            "DELETE FROM invoices WHERE id=?",
            rusqlite::params![invoice_id],
        );
        assert!(direct.is_err());
        assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
        let tamper = store
            .connect()
            .unwrap()
            .execute("UPDATE audit_log SET action='tampered'", []);
        assert!(tamper.is_err());
    }

    #[test]
    fn accepted_quote_conversion_is_atomic_and_unique() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", json!({"name":"Client conversion"}))
                .unwrap(),
        );
        let quote_id = value_id(
            &store
                .create_record(
                    "quotes",
                    json!({"client_id":client_id,"title":"Devis à convertir"}),
                )
                .unwrap(),
        );
        store.create_record("quote_items",json!({"quote_id":quote_id,"description":"Lot accepté","quantity":2,"unit":"heure","unit_price_cents":8000,"vat_bp":0})).unwrap();
        store
            .issue_quote(
                &quote_id,
                Some("2026-04-01".into()),
                Some("2026-04-30".into()),
            )
            .unwrap();
        let input = ConvertQuoteInput {
            quote_id: quote_id.clone(),
            title: None,
            issue_date: None,
            due_date: None,
            service_date_from: Some("2026-05-01".into()),
            service_date_to: Some("2026-05-31".into()),
        };
        assert!(store.convert_quote_to_invoice(input.clone()).is_err());
        let count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM invoices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        store.update_quote_status(&quote_id, "accepted").unwrap();
        let converted = store.convert_quote_to_invoice(input.clone()).unwrap();
        assert_eq!(converted["invoice"]["quote_id"], quote_id);
        assert_eq!(converted["invoice_items"].as_array().unwrap().len(), 1);
        assert!(store.convert_quote_to_invoice(input).is_err());
        let count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM invoices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn automatic_accounting_entries_are_balanced_and_reports_execute() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let client_id = value_id(
            &store
                .create_record("clients", json!({"name":"Client comptable"}))
                .unwrap(),
        );
        let invoice_id=value_id(&store.create_record("invoices",json!({"client_id":client_id,"title":"Facture comptable","service_date_from":"2026-06-01","service_date_to":"2026-06-30"})).unwrap());
        store.create_record("invoice_items",json!({"invoice_id":invoice_id,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0})).unwrap();
        store
            .issue_invoice(
                &invoice_id,
                Some("2026-07-01".into()),
                Some("2026-07-31".into()),
            )
            .unwrap();
        store
            .record_payment(RecordPaymentInput {
                invoice_id: invoice_id.clone(),
                amount_cents: 4000,
                date: Some("2026-07-05".into()),
                method: Some("bank".into()),
                reference: None,
                notes: None,
            })
            .unwrap();
        store.create_record("expenses",json!({"date":"2026-07-06","supplier":"Fournisseur","net_cents":1000,"vat_cents":0,"total_cents":1000})).unwrap();
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Employé comptable"}))
                .unwrap(),
        );
        let payslip_id = value_id(
            &store
                .create_record(
                    "payslips",
                    json!({"employee_id":employee_id,"period":"2026-07","status":"valide"}),
                )
                .unwrap(),
        );
        for (position, kind, amount) in [
            (0, "earning", 500000),
            (1, "deduction", 50000),
            (2, "employer", 30000),
        ] {
            store.create_record("payslip_items",json!({"payslip_id":payslip_id,"position":position,"label":format!("Ligne {position}"),"kind":kind,"amount_cents":amount})).unwrap();
        }
        let posted = store
            .post_payslip(PostPayslipInput {
                payslip_id,
                entry_date: Some("2026-07-31".into()),
            })
            .unwrap();
        assert!(posted["payslip"]["snapshot_json"].as_str().is_some());
        let payslip_snapshot: serde_json::Value =
            serde_json::from_str(posted["payslip"]["snapshot_json"].as_str().unwrap()).unwrap();
        assert_eq!(payslip_snapshot["issuer"]["building_number"], "17B");
        assert_eq!(
            payslip_snapshot["issuer"]["logo_path"],
            "C:\\donnees-locales\\logo-test.png"
        );
        assert_eq!(payslip_snapshot["issuer"]["noga_division"], "43");
        let connection = store.connect().unwrap();
        let unbalanced:i64=connection.query_row("SELECT COUNT(*) FROM (SELECT je.id FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id GROUP BY je.id HAVING SUM(jl.debit_cents)<>SUM(jl.credit_cents))",[],|r|r.get(0)).unwrap();
        assert_eq!(unbalanced, 0);
        let historical_reclassification = store.upsert_account(AccountInput {
            id: Some(accounts["revenue"].clone()),
            code: "3999".into(),
            name: "Produits renommés".into(),
            account_type: "revenue".into(),
            normal_balance: "credit".into(),
            report_section: "net_revenue".into(),
            active: true,
        });
        assert!(historical_reclassification
            .unwrap_err()
            .to_string()
            .contains("rapports historiques"));
        let entries: i64 = connection
            .query_row("SELECT COUNT(*) FROM journal_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(entries, 4);
        let expense_entry: String = connection
            .query_row(
                "SELECT id FROM journal_entries WHERE source_type='expense'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        drop(connection);
        let reversal = store
            .reverse_journal_entry(&expense_entry, "2026-07-07", None)
            .unwrap();
        assert_eq!(reversal["entry"]["reversal_of"], expense_entry);
        assert_eq!(
            store
                .get_trial_balance(PeriodFilter {
                    date_from: Some("2026-01-01".into()),
                    date_to: Some("2026-12-31".into())
                })
                .unwrap()["balanced"],
            true
        );
        let income = store
            .get_income_statement(PeriodFilter {
                date_from: Some("2026-01-01".into()),
                date_to: Some("2026-12-31".into()),
            })
            .unwrap();
        assert!(income["sections"].is_object());
        let balance = store.get_balance_sheet(Some("2026-12-31".into())).unwrap();
        assert!(balance["sections"].is_object());
    }

    #[test]
    fn closed_accounting_period_rejects_new_entries() {
        let (_temporary, store) = initialized_store();
        let accounts = accounting_accounts(&store);
        let period = store
            .upsert_accounting_period(AccountingPeriodInput {
                id: None,
                name: "Exercice 2026".into(),
                date_from: "2026-01-01".into(),
                date_to: "2026-12-31".into(),
            })
            .unwrap();
        store
            .close_accounting_period(period["id"].as_str().unwrap())
            .unwrap();
        let result = store.post_manual_journal_entry(ManualJournalInput {
            entry_date: "2026-08-01".into(),
            description: "Écriture tardive".into(),
            currency: "CHF".into(),
            lines: vec![
                ManualJournalLineInput {
                    account_id: accounts["bank"].clone(),
                    debit_cents: 100,
                    credit_cents: 0,
                    memo: None,
                    project_id: None,
                    client_id: None,
                    employee_id: None,
                },
                ManualJournalLineInput {
                    account_id: accounts["ar"].clone(),
                    debit_cents: 0,
                    credit_cents: 100,
                    memo: None,
                    project_id: None,
                    client_id: None,
                    employee_id: None,
                },
            ],
        });
        assert!(result.unwrap_err().to_string().contains("clôturée"));
    }

    #[test]
    fn reminders_are_local_idempotent_and_cancelled_when_settled() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", json!({"name":"Client relance"}))
                .unwrap(),
        );
        let invoice_id=value_id(&store.create_record("invoices",json!({"client_id":client_id,"title":"Facture échue","service_date_from":"2026-01-01","service_date_to":"2026-01-31"})).unwrap());
        store.create_record("invoice_items",json!({"invoice_id":invoice_id,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0})).unwrap();
        store
            .issue_invoice(
                &invoice_id,
                Some("2026-02-01".into()),
                Some("2026-02-28".into()),
            )
            .unwrap();
        store
            .update_reminder_settings(ReminderSettingsInput {
                enabled: true,
                sender_name: Some("Entreprise".into()),
            })
            .unwrap();
        store
            .upsert_reminder_template(ReminderTemplateInput {
                id: None,
                level: 1,
                name: "Premier rappel".into(),
                subject: "Facture {invoice_number}".into(),
                body: "Solde {balance_cents}".into(),
                days_after_due: 5,
                active: true,
            })
            .unwrap();
        store
            .upsert_reminder_template(ReminderTemplateInput {
                id: None,
                level: 2,
                name: "Deuxième rappel".into(),
                subject: "Deuxième rappel {invoice_number}".into(),
                body: "Solde inchangé {balance_cents}".into(),
                days_after_due: 10,
                active: true,
            })
            .unwrap();
        let first = store
            .generate_due_reminders(Some("2026-12-31".into()))
            .unwrap();
        assert_eq!(first["created"].as_array().unwrap().len(), 1);
        assert_eq!(first["created"][0]["level"], 1);
        assert_eq!(first["created"][0]["balance_cents"], 10000);
        let second = store
            .generate_due_reminders(Some("2026-12-31".into()))
            .unwrap();
        assert_eq!(second["created"].as_array().unwrap().len(), 0);
        store
            .mark_reminder(MarkReminderInput {
                id: first["created"][0]["id"].as_str().unwrap().into(),
                status: "completed".into(),
                note: Some("Premier niveau traité localement".into()),
            })
            .unwrap();
        let third = store
            .generate_due_reminders(Some("2026-12-31".into()))
            .unwrap();
        assert_eq!(third["created"].as_array().unwrap().len(), 1);
        assert_eq!(third["created"][0]["level"], 2);
        store
            .record_payment(RecordPaymentInput {
                invoice_id: invoice_id.clone(),
                amount_cents: 10000,
                date: Some("2027-01-01".into()),
                method: None,
                reference: None,
                notes: None,
            })
            .unwrap();
        let statuses: (i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT SUM(status='completed'),SUM(status='cancelled') FROM reminders WHERE invoice_id=?",
                rusqlite::params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(statuses, (1, 1));
    }

    #[test]
    fn payroll_rates_and_annual_ceiling_are_explicit() {
        let (_temporary, store) = initialized_store();
        assert_eq!(
            store
                .list_payroll_contribution_definitions(None)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let profiles = store.get_payroll_regulatory_profiles().unwrap();
        assert_eq!(profiles[0]["id"], "CH-2026");
        let definition = store
            .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                id: None,
                code: "AC_TEST".into(),
                label: "AC explicite".into(),
                category: "ac".into(),
                side: "employee".into(),
                calculation_kind: "rate".into(),
                rate_bp: Some(110),
                fixed_amount_cents: None,
                annual_ceiling_cents: Some(14_820_000),
                basis_kind: "ahv_salary".into(),
                source: "https://www.bsv.admin.ch/fr/cotisations-apercu".into(),
                effective_from: "2026-01-01".into(),
                effective_to: Some("2026-12-31".into()),
                active: true,
                liability_account_id: None,
                expense_account_id: None,
            })
            .unwrap();
        let definition_id = value_id(&definition);
        let missing = store.calculate_payroll_contributions(CalculatePayrollInput {
            period: "2026-08".into(),
            gross_cents: 500000,
            items: vec![ContributionSelectionInput {
                definition_id: definition_id.clone(),
                basis_cents: None,
                year_to_date_basis_cents: None,
            }],
        });
        assert!(missing.is_err());
        let selection = ContributionSelectionInput {
            definition_id: definition_id.clone(),
            basis_cents: Some(500000),
            year_to_date_basis_cents: Some(14_700_000),
        };
        let calculated = store
            .calculate_payroll_contributions(CalculatePayrollInput {
                period: "2026-08".into(),
                gross_cents: 500000,
                items: vec![selection.clone()],
            })
            .unwrap();
        assert_eq!(calculated["items"][0]["basis_cents"], 120000);
        assert_eq!(calculated["items"][0]["amount_cents"], 1320);
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Employé cotisations"}))
                .unwrap(),
        );
        let payslip_id = value_id(
            &store
                .create_record(
                    "payslips",
                    json!({"employee_id":employee_id,"period":"2026-08"}),
                )
                .unwrap(),
        );
        store.create_record("payslip_items",json!({"payslip_id":payslip_id,"position":0,"label":"Salaire brut","kind":"earning","amount_cents":500000})).unwrap();
        let applied = store
            .apply_payroll_contributions(ApplyPayrollInput {
                payslip_id: payslip_id.clone(),
                period: "2026-08".into(),
                items: vec![selection],
            })
            .unwrap();
        assert_eq!(applied["payslip"]["deductions_cents"], 1320);
        assert_eq!(applied["contributions"][0]["rate_bp"], 110);
        let frozen = store.get_payslip_contributions(&payslip_id).unwrap();
        assert_eq!(frozen[0]["basis_cents"], 120000);
        assert_eq!(frozen[0]["amount_cents"], 1320);
        assert_eq!(
            frozen[0]["source"],
            "https://www.bsv.admin.ch/fr/cotisations-apercu"
        );
    }

    #[test]
    fn gross_payroll_basis_always_tracks_current_gross() {
        let (_temporary, store) = initialized_store();
        let gross_definition = store
            .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                id: None,
                code: "GROSS_SYNC".into(),
                label: "Base brute synchronisée".into(),
                category: "other".into(),
                side: "employee".into(),
                calculation_kind: "rate".into(),
                rate_bp: Some(500),
                fixed_amount_cents: None,
                annual_ceiling_cents: None,
                basis_kind: "gross".into(),
                source: "Test local".into(),
                effective_from: "2026-01-01".into(),
                effective_to: None,
                active: true,
                liability_account_id: None,
                expense_account_id: None,
            })
            .unwrap();
        let custom_definition = store
            .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                id: None,
                code: "CUSTOM_BASE".into(),
                label: "Base personnalisée".into(),
                category: "other".into(),
                side: "employer".into(),
                calculation_kind: "rate".into(),
                rate_bp: Some(700),
                fixed_amount_cents: None,
                annual_ceiling_cents: None,
                basis_kind: "custom".into(),
                source: "Test local".into(),
                effective_from: "2026-01-01".into(),
                effective_to: None,
                active: true,
                liability_account_id: None,
                expense_account_id: None,
            })
            .unwrap();
        let gross_id = value_id(&gross_definition);
        let custom_id = value_id(&custom_definition);
        let selections = vec![
            ContributionSelectionInput {
                definition_id: gross_id,
                basis_cents: Some(400_000),
                year_to_date_basis_cents: None,
            },
            ContributionSelectionInput {
                definition_id: custom_id,
                basis_cents: Some(400_000),
                year_to_date_basis_cents: None,
            },
        ];
        let first = store
            .calculate_payroll_contributions(CalculatePayrollInput {
                period: "2026-08".into(),
                gross_cents: 500_000,
                items: selections.clone(),
            })
            .unwrap();
        assert_eq!(first["items"][0]["basis_cents"], 500_000);
        assert_eq!(first["items"][0]["amount_cents"], 25_000);
        assert_eq!(first["items"][1]["basis_cents"], 400_000);
        assert_eq!(first["items"][1]["amount_cents"], 28_000);
        let second = store
            .calculate_payroll_contributions(CalculatePayrollInput {
                period: "2026-08".into(),
                gross_cents: 700_000,
                items: selections,
            })
            .unwrap();
        assert_eq!(second["items"][0]["basis_cents"], 700_000);
        assert_eq!(second["items"][0]["amount_cents"], 35_000);
    }

    #[test]
    fn onboarding_payroll_rates_feed_the_engine_atomically_without_duplicates() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let mut invalid = test_onboarding();
        invalid.extra_settings_json = Some(json!({
            "payroll": {
                "enabled": true,
                "employeeRates": [{
                    "id":"retenue-client",
                    "label":"Retenue confirmée",
                    "rateBp":0,
                    "effectiveFrom":"2026-01-01"
                }],
                "employerRates": []
            }
        }));
        assert!(store.complete_onboarding(invalid, "1.0.0").is_err());
        let empty_counts: (i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM settings),(SELECT COUNT(*) FROM payroll_contribution_definitions)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(empty_counts, (0, 0));

        let payroll_settings = json!({
            "payroll": {
                "enabled": true,
                "employeeRates": [{
                    "id":"retenue-client",
                    "label":"Retenue confirmée",
                    "rateBp":500,
                    "effectiveFrom":"2026-01-01",
                    "sourceLabel":"Configuration validée par la fiduciaire du client"
                }],
                "employerRates": [{
                    "id":"charge-client",
                    "label":"Charge employeur confirmée",
                    "rateBp":700,
                    "effectiveFrom":"2026-01-01"
                }]
            }
        });
        let mut onboarding = test_onboarding();
        onboarding.extra_settings_json = Some(payroll_settings.clone());
        store.complete_onboarding(onboarding, "1.0.0").unwrap();
        let definitions = store.list_payroll_contribution_definitions(None).unwrap();
        assert_eq!(definitions.as_array().unwrap().len(), 2);
        let stored_extra: serde_json::Value = serde_json::from_str(
            store.get_workspace().unwrap()["settings"]["extra_settings_json"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(stored_extra["payroll"]["employeeRates"], json!([]));
        assert_eq!(stored_extra["payroll"]["employerRates"], json!([]));
        assert_eq!(stored_extra["payroll"]["ratesImported"], true);
        let employee_id = definitions
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["side"] == "employee")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let employee_code = definitions
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["side"] == "employee")
            .unwrap()["code"]
            .as_str()
            .unwrap()
            .to_owned();
        let employer_id = definitions
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["side"] == "employer")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let calculated = store
            .calculate_payroll_contributions(CalculatePayrollInput {
                period: "2026-08".into(),
                gross_cents: 500_000,
                items: vec![
                    ContributionSelectionInput {
                        definition_id: employee_id.clone(),
                        basis_cents: None,
                        year_to_date_basis_cents: None,
                    },
                    ContributionSelectionInput {
                        definition_id: employer_id.clone(),
                        basis_cents: None,
                        year_to_date_basis_cents: None,
                    },
                ],
            })
            .unwrap();
        assert_eq!(calculated["employee_deductions_cents"], 25_000);
        assert_eq!(calculated["employer_costs_cents"], 35_000);

        store
            .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                id: None,
                code: "CUSTOM_KEEP".into(),
                label: "Définition personnalisée conservée".into(),
                category: "other".into(),
                side: "employee".into(),
                calculation_kind: "rate".into(),
                rate_bp: Some(100),
                fixed_amount_cents: None,
                annual_ceiling_cents: None,
                basis_kind: "custom".into(),
                source: "Source saisie séparément".into(),
                effective_from: "2026-01-01".into(),
                effective_to: None,
                active: true,
                liability_account_id: None,
                expense_account_id: None,
            })
            .unwrap();
        let invalid_update = store.update_settings(json!({
            "company_name":"Nom qui doit être annulé",
            "extra_settings_json":{"payroll":{"enabled":true,"employeeRates":[{"id":"retenue-client","label":"Invalide","rateBp":-1,"effectiveFrom":"2026-01-01"}],"employerRates":[]}}
        }));
        assert!(invalid_update.is_err());
        assert_eq!(
            store.get_workspace().unwrap()["settings"]["company_name"],
            "Entreprise de test"
        );

        store
            .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                id: Some(employee_id.clone()),
                code: employee_code,
                label: "Retenue personnalisée par le client".into(),
                category: "other".into(),
                side: "employee".into(),
                calculation_kind: "rate".into(),
                rate_bp: Some(600),
                fixed_amount_cents: None,
                annual_ceiling_cents: None,
                basis_kind: "gross".into(),
                source: "Modification dans le moteur de paie".into(),
                effective_from: "2026-01-01".into(),
                effective_to: None,
                active: true,
                liability_account_id: None,
                expense_account_id: None,
            })
            .unwrap();
        store
            .delete_payroll_contribution_definition(&employer_id)
            .unwrap();
        store
            .update_settings(json!({
                "company_name":"Entreprise renommée",
                "extra_settings_json":stored_extra.clone()
            }))
            .unwrap();
        store
            .update_settings(json!({
                "phone":"021 000 00 00",
                "extra_settings_json":stored_extra
            }))
            .unwrap();
        let after = store.list_payroll_contribution_definitions(None).unwrap();
        assert_eq!(after.as_array().unwrap().len(), 2);
        assert!(
            after
                .as_array()
                .unwrap()
                .iter()
                .any(|row| { row["code"] == "CUSTOM_KEEP" && row["active"] == true }),
            "{after}"
        );
        assert!(!after
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == employer_id));
        let employee = after
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == employee_id)
            .unwrap();
        assert_eq!(employee["rate_bp"], 600);
        assert_eq!(employee["basis_kind"], "gross");
        assert_eq!(employee["label"], "Retenue personnalisée par le client");
        let recalculated = store
            .calculate_payroll_contributions(CalculatePayrollInput {
                period: "2026-08".into(),
                gross_cents: 500_000,
                items: vec![ContributionSelectionInput {
                    definition_id: employee_id,
                    basis_cents: None,
                    year_to_date_basis_cents: None,
                }],
            })
            .unwrap();
        assert_eq!(recalculated["employee_deductions_cents"], 30_000);
    }

    #[test]
    fn atomic_payslip_save_rolls_back_create_and_update_on_contribution_error() {
        let (_temporary, store) = initialized_store();
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Employé transactionnel"}))
                .unwrap(),
        );
        let line = PayslipManualLineInput {
            id: Some("ligne-salaire".into()),
            label: "Salaire initial".into(),
            kind: "earning".into(),
            amount_cents: 500_000,
        };
        let invalid_selection = ContributionSelectionInput {
            definition_id: "cotisation-inexistante".into(),
            basis_cents: None,
            year_to_date_basis_cents: None,
        };
        let audit_before_create: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM audit_log", [], |row| row.get(0))
            .unwrap();
        let failed_create =
            store.save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id: employee_id.clone(),
                period: "2026-09".into(),
                status: "a_controler".into(),
                payment_date: None,
                notes: Some("Ne doit pas persister".into()),
                lines: vec![line.clone()],
                contributions: vec![invalid_selection.clone()],
            });
        assert!(failed_create.is_err());
        let connection = store.connect().unwrap();
        let counts: (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM payslips),(SELECT COUNT(*) FROM payslip_items),(SELECT COUNT(*) FROM payslip_contributions),(SELECT COUNT(*) FROM audit_log)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(counts, (0, 0, 0, audit_before_create));
        drop(connection);

        let saved = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id: employee_id.clone(),
                period: "2026-09".into(),
                status: "a_controler".into(),
                payment_date: None,
                notes: Some("Version initiale".into()),
                lines: vec![line],
                contributions: Vec::new(),
            })
            .unwrap();
        let payslip_id = value_id(&saved["payslip"]);
        let audit_before_update: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM audit_log", [], |row| row.get(0))
            .unwrap();
        let failed_update =
            store.save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: Some(payslip_id.clone()),
                employee_id,
                period: "2026-09".into(),
                status: "valide".into(),
                payment_date: Some("2026-09-30".into()),
                notes: Some("Modification à annuler".into()),
                lines: vec![PayslipManualLineInput {
                    id: Some("ligne-remplacement".into()),
                    label: "Salaire modifié".into(),
                    kind: "earning".into(),
                    amount_cents: 700_000,
                }],
                contributions: vec![invalid_selection],
            });
        assert!(failed_update.is_err());
        let connection = store.connect().unwrap();
        let unchanged: (String, String, i64, String, i64) = connection
            .query_row(
                "SELECT p.status,p.notes,p.gross_cents,pi.label,(SELECT COUNT(*) FROM audit_log) FROM payslips p JOIN payslip_items pi ON pi.payslip_id=p.id WHERE p.id=?",
                rusqlite::params![payslip_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(
            unchanged,
            (
                "a_controler".into(),
                "Version initiale".into(),
                500_000,
                "Salaire initial".into(),
                audit_before_update
            )
        );
    }
}
