#![recursion_limit = "256"]

mod account_cloud;
mod accounting;
mod accounting_closure;
mod agenda;
mod app_updater;
mod attachments;
mod audit;
mod backup;
mod bank_import;
mod branding;
mod catalog_import;
mod commands;
mod database;
mod error;
mod fiduciary_closing;
mod installation;
mod license;
mod models;
mod noga;
mod payroll;
mod payroll_import;
mod payroll_pdf;
mod project_planning;
mod recurrence;
mod reminders;
mod sales_fulfillment;
mod sales_pdf;
mod schema;
mod stock;
mod supplier_email;
mod supplier_invoices;
mod supplier_procurement;
mod swiss_payroll_rules;
mod swiss_qr;
mod time_billing;
mod vat_reporting;

use commands::*;
use database::LocalStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Le cache macOS des secrets déverrouillés suppose une seule instance du
    // profil. Enregistrer ce garde avant tout autre plugin ferme la course
    // inter-processus avant même l'initialisation de LocalStore. Un second
    // lancement restaure et focalise la fenêtre existante afin que le garde ne
    // ressemble pas à un lancement sans effet.
    #[cfg(all(desktop, not(test)))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    #[cfg(not(test))]
    let builder = builder.plugin(tauri_plugin_dialog::init());

    builder
        .setup(|app| {
            use tauri::Manager;
            app_updater::initialize(app)?;
            let data_dir = resolve_data_dir(app.handle())?;
            let store = LocalStore::initialize(data_dir)?;
            // `HELVICHANTIER_DATA_DIR` peut déplacer le profil hors de
            // `$APPLOCALDATA`. On n'ouvre jamais ce profil entier au protocole
            // asset : seuls les logos immuables, directement dans ce dossier,
            // sont lisibles par la WebView (pas de sous-dossiers).
            app.asset_protocol_scope()
                .allow_directory(store.attachments_dir.join("branding"), false)?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            get_noga_catalog,
            validate_onboarding,
            complete_onboarding,
            get_workspace,
            import_camt_file,
            get_bank_workspace,
            associate_bank_account,
            dissociate_bank_account,
            confirm_bank_reconciliation,
            confirm_supplier_bank_reconciliation,
            create_record,
            update_record,
            delete_record,
            import_catalog_items,
            save_project_milestone,
            delete_project_milestone,
            save_project_task,
            set_project_task_status,
            delete_project_task,
            save_agenda_event,
            delete_agenda_event,
            record_stock_entry,
            record_stock_exit,
            record_stock_correction,
            save_supplier_invoice_draft,
            validate_supplier_invoice,
            record_supplier_payment,
            delete_supplier_invoice_draft,
            inspect_supplier_email_file,
            import_supplier_email_invoice_draft,
            save_supplier_order_draft,
            confirm_supplier_order,
            cancel_supplier_order_remainder,
            save_supplier_receipt_draft,
            issue_supplier_receipt,
            reverse_supplier_receipt,
            save_supplier_invoice_match,
            save_supplier_credit_note_draft,
            validate_supplier_credit_note,
            apply_supplier_credit,
            reverse_supplier_credit_allocation,
            delete_supplier_credit_note_draft,
            reclassify_supplier_invoice_expense,
            update_settings,
            stage_company_logo,
            save_document_with_items,
            issue_quote,
            issue_invoice,
            create_invoice_from_time_entries,
            update_quote_status,
            create_quote_revision,
            convert_quote_to_invoice,
            convert_quote_to_sales_order,
            save_sales_order_draft,
            confirm_sales_order,
            cancel_sales_order,
            cancel_sales_order_remainder,
            save_delivery_note_draft,
            issue_delivery_note,
            reverse_delivery_note,
            preview_sales_order_invoice,
            create_sales_order_invoice,
            cancel_sales_order_invoice_draft,
            create_recurrence_schedule,
            update_recurrence_schedule,
            generate_recurrence_occurrences,
            record_payment,
            list_accounts,
            upsert_account,
            delete_account,
            get_accounting_settings,
            get_accounting_continuity,
            install_swiss_accounting_starter,
            configure_accounting,
            list_accounting_periods,
            upsert_accounting_period,
            close_accounting_period,
            prepare_fiduciary_pre_closing,
            finalize_accounting_period_with_review,
            export_fiduciary_closing_zip,
            create_vat_profile,
            list_vat_profiles,
            set_vat_source_classification,
            list_vat_source_classifications,
            create_vat_adjustment,
            reverse_vat_adjustment,
            list_vat_adjustments,
            preview_vat_return,
            export_vat_return_xml,
            list_vat_return_exports,
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
            install_reminder_cycle,
            list_reminder_templates,
            upsert_reminder_template,
            delete_reminder_template,
            generate_due_reminders,
            scan_due_reminders,
            list_reminders,
            get_reminder_history,
            preview_reminder_delivery,
            mark_reminder,
            record_reminder_action,
            get_payroll_regulatory_profiles,
            list_payroll_contribution_definitions,
            get_payslip_contributions,
            upsert_payroll_contribution_definition,
            delete_payroll_contribution_definition,
            calculate_payroll_contributions,
            calculate_employee_payroll_contributions,
            apply_payroll_contributions,
            save_payslip_with_contributions,
            post_payslip,
            pay_payslip,
            generate_payslip_pdf,
            generate_sales_document_pdf,
            create_invoice_correction,
            abandon_invoice_correction,
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
            refresh_license,
            account_cloud::get_cloud_account_state,
            account_cloud::start_cloud_account_link,
            account_cloud::poll_cloud_account_link,
            account_cloud::open_cloud_account_link,
            account_cloud::open_cloud_account_portal,
            account_cloud::disconnect_cloud_account,
            account_cloud::archive_invoice_to_cloud,
            app_updater::get_secure_update_policy,
            app_updater::check_secure_update,
            app_updater::install_secure_update,
            start_timer,
            stop_timer,
            cancel_timer,
            get_active_timer,
            create_backup,
            restore_backup,
            export_json,
            export_csv_archive,
            add_supplier_invoice_attachment,
            delete_supplier_invoice_attachment,
            open_attachment,
            open_data_folder,
        ])
        .run(tauri::generate_context!())
        .expect("Zentra n'a pas pu démarrer");
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs};

    use chrono::{Days, Local};
    use pretty_assertions::assert_eq;
    use rusqlite::{OptionalExtension, TransactionBehavior};
    use serde_json::json;
    use sha2::{Digest, Sha256};

    use crate::{
        attachments::AddSupplierInvoiceAttachmentInput,
        catalog_import::{
            CatalogImportConflictPolicy, CatalogImportRowInput, ImportCatalogItemsInput,
        },
        database::{now_iso, require_setup_confirmed, LocalStore, OnboardingValidationScope},
        models::{
            AbandonInvoiceCorrectionInput, AccountInput, AccountingPeriodInput,
            AccountingSettingsInput, ApplyPayrollInput, ApplySupplierCreditInput,
            CalculateEmployeePayrollInput, CalculatePayrollInput,
            CancelSupplierOrderRemainderInput, CancelSupplierOrderRemainderLineInput,
            ConfirmSupplierOrderInput, ContributionDefinitionInput, ContributionSelectionInput,
            ConvertQuoteInput, CreateInvoiceCorrectionInput, CreateInvoiceFromTimeEntriesInput,
            GenerateSalesDocumentPdfInput, InstallReminderCycleInput, IssueSupplierReceiptInput,
            LedgerInput, ManualJournalInput, ManualJournalLineInput, MarkReminderInput,
            OnboardingInput, PayPayslipInput, PayslipManualLineInput, PeriodFilter,
            PostPayslipInput, ReclassifySupplierInvoiceExpenseInput, RecordPaymentInput,
            RecordSupplierPaymentInput, ReminderActionInput, ReminderPreviewInput,
            ReminderSettingsInput, ReminderTemplateInput, ReverseSupplierCreditAllocationInput,
            ReverseSupplierReceiptInput, SaveDocumentWithItemsInput, SaveInvoiceQrBillInput,
            SavePayslipWithContributionsInput, SaveSupplierCreditNoteDraftInput,
            SaveSupplierInvoiceDraftInput, SaveSupplierInvoiceMatchInput,
            SaveSupplierOrderDraftInput, SaveSupplierReceiptDraftInput, ScanRemindersInput,
            StockCorrectionInput, StockEntryInput, StockExitInput,
            SupplierExpenseReclassificationLineInput, SupplierInvoiceLineInput,
            SupplierInvoiceMatchAllocationInput, SupplierInvoiceOrderAllocationsInput,
            SupplierOrderDraftInput, SupplierOrderLineInput, SupplierReceiptDraftInput,
            SupplierReceiptLineInput, SwissQrBillInput, SwissQrParty,
            ValidateSupplierCreditNoteInput,
        },
        schema::{BUSINESS_TABLES, SCHEMA_SQL, SCHEMA_VERSION},
        vat_reporting::VatProfileInput,
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
            logo_path: None,
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

    fn test_client(name: &str) -> serde_json::Value {
        json!({
            "name": name,
            "address_line1": "Rue du Client",
            "address_line2": "7",
            "postal_code": "1000",
            "city": "Lausanne",
            "country": "CH"
        })
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

    fn time_billing_fixture(store: &LocalStore) -> (String, String, String) {
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client heures"))
                .unwrap(),
        );
        let project_id = value_id(
            &store
                .create_record(
                    "projects",
                    json!({"name":"Projet heures","client_id":client_id}),
                )
                .unwrap(),
        );
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Alice Exemple","country":"fr"}))
                .unwrap(),
        );
        (client_id, project_id, employee_id)
    }

    fn create_billable_time(
        store: &LocalStore,
        project_id: &str,
        employee_id: &str,
        date: &str,
        minutes: i64,
        rate_cents: i64,
    ) -> String {
        value_id(
            &store
                .create_record(
                    "time_entries",
                    json!({
                        "project_id":project_id,
                        "employee_id":employee_id,
                        "date":date,
                        "minutes":minutes,
                        "billable":true,
                        "billing_rate_cents":rate_cents,
                        "status":"approuve",
                        "note":"Intervention locale"
                    }),
                )
                .unwrap(),
        )
    }

    fn time_billing_input(
        request_id: &str,
        project_id: &str,
        time_entry_ids: Vec<String>,
    ) -> CreateInvoiceFromTimeEntriesInput {
        CreateInvoiceFromTimeEntriesInput {
            request_id: request_id.into(),
            project_id: project_id.into(),
            time_entry_ids,
            title: None,
            service_date_from: None,
            service_date_to: None,
            vat_bp: None,
            notes: None,
        }
    }

    /// Fixture réglementaire minimale pour les tests comptables qui ne portent
    /// pas sur les taux sociaux : collaborateur mineur, contrat < 8 h/semaine
    /// et police AAP de test à 1 %, avec le plafond LAA 2026 explicite.
    fn configure_minor_test_payroll(
        store: &LocalStore,
        employee_id: &str,
        laa_basis_cents: i64,
    ) -> ContributionSelectionInput {
        let workspace = store.get_workspace().unwrap();
        let mut extra: serde_json::Value = serde_json::from_str(
            workspace["settings"]["extra_settings_json"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        extra["payroll"] = json!({
            "enabled": true,
            "fiduciaryValidated": true,
            "avsFund": "Caisse AVS de test",
            "accidentInsurer": "Assureur LAA de test",
            "pensionFund": "",
            "dailyAllowanceInsurer": "",
            "familyAllowanceFund": ""
        });
        store
            .update_settings(json!({"extra_settings_json":extra}))
            .unwrap();
        store
            .update_record(
                "employees",
                employee_id,
                json!({
                    "birth_date":"2010-01-01",
                    "employment_start_date":"2026-01-01",
                    "contractual_weekly_minutes":420,
                    "laa_opening_year":2026,
                    "laa_opening_basis_cents":0
                }),
            )
            .unwrap();
        let (liability_account_id, expense_account_id): (Option<String>, Option<String>) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT social_payable_account_id,social_expense_account_id FROM accounting_settings WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .unwrap()
            .unwrap_or((None, None));
        let definition = store
            .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                id: None,
                code: "AAP_TEST_EXPLICIT".into(),
                label: "AAP confirmée pour le test".into(),
                category: "aap".into(),
                side: "employer".into(),
                calculation_kind: "rate".into(),
                rate_bp: Some(100),
                fixed_amount_cents: None,
                annual_ceiling_cents: Some(14_820_000),
                basis_kind: "ahv_salary".into(),
                lpp_component: None,
                lpp_employee_id: None,
                source: "Police LAA explicite de test".into(),
                effective_from: "2026-01-01".into(),
                effective_to: Some("2026-12-31".into()),
                active: true,
                liability_account_id,
                expense_account_id,
            })
            .unwrap();
        ContributionSelectionInput {
            definition_id: value_id(&definition),
            basis_cents: Some(laa_basis_cents),
            year_to_date_basis_cents: Some(0),
        }
    }

    /// Fixture adulte complète pour exercer la validation fédérale au moment
    /// de la comptabilisation. Elle installe explicitement le profil figé 2026,
    /// une police AAP et une retenue contractuelle dont la fenêtre se termine
    /// avec août 2026.
    fn configure_adult_test_payroll(
        store: &LocalStore,
        employee_id: &str,
    ) -> Vec<ContributionSelectionInput> {
        let workspace = store.get_workspace().unwrap();
        let mut extra: serde_json::Value = serde_json::from_str(
            workspace["settings"]["extra_settings_json"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        extra["payroll"] = json!({
            "enabled": true,
            "fiduciaryValidated": true,
            "avsFund": "Caisse AVS de test",
            "accidentInsurer": "Assureur LAA de test",
            "pensionFund": "",
            "dailyAllowanceInsurer": "",
            "familyAllowanceFund": ""
        });
        store
            .update_settings(json!({"extra_settings_json":extra}))
            .unwrap();
        store
            .update_record(
                "employees",
                employee_id,
                json!({
                    "birth_date":"1990-01-01",
                    "employment_start_date":"2026-01-01",
                    "contractual_weekly_minutes":420,
                    "ac_opening_year":2026,
                    "ac_opening_basis_cents":0,
                    "laa_opening_year":2026,
                    "laa_opening_basis_cents":0,
                    "small_salary_assessment_year":2026,
                    "small_salary_decision_date":"2026-01-01",
                    "small_salary_sector":"ordinary",
                    "small_salary_employee_requested_contributions":false,
                    "small_salary_opening_gross_cents":0,
                    "small_salary_opening_contributed_basis_cents":0,
                    "small_salary_evidence_reference":"Décision annuelle test 2026",
                    "lpp_assessment_year":2026,
                    "lpp_annual_salary_cents":0
                }),
            )
            .unwrap();

        let profile = store.get_payroll_regulatory_profiles().unwrap();
        let federal = profile[0]["definitions"].as_array().unwrap();
        let mut selections = Vec::with_capacity(federal.len() + 2);
        for row in federal {
            let definition = store
                .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                    id: None,
                    code: row["code"].as_str().unwrap().into(),
                    label: row["label"].as_str().unwrap().into(),
                    category: row["category"].as_str().unwrap().into(),
                    side: row["side"].as_str().unwrap().into(),
                    calculation_kind: row["calculation_kind"].as_str().unwrap().into(),
                    rate_bp: row["rate_bp"].as_i64(),
                    fixed_amount_cents: row["fixed_amount_cents"].as_i64(),
                    annual_ceiling_cents: row["annual_ceiling_cents"].as_i64(),
                    basis_kind: row["basis_kind"].as_str().unwrap().into(),
                    lpp_component: None,
                    lpp_employee_id: None,
                    source: row["source"].as_str().unwrap().into(),
                    effective_from: row["effective_from"].as_str().unwrap().into(),
                    effective_to: row["effective_to"].as_str().map(str::to_owned),
                    active: true,
                    liability_account_id: None,
                    expense_account_id: None,
                })
                .unwrap();
            selections.push(ContributionSelectionInput {
                definition_id: value_id(&definition),
                basis_cents: Some(500_000),
                year_to_date_basis_cents: (row["category"] == "ac").then_some(0),
            });
        }

        let (liability_account_id, expense_account_id): (Option<String>, Option<String>) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT social_payable_account_id,social_expense_account_id FROM accounting_settings WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .unwrap()
            .unwrap_or((None, None));
        for (code, label, category, side, effective_to, ceiling) in [
            (
                "AAP_ADULT_TEST",
                "AAP adulte confirmée",
                "aap",
                "employer",
                "2026-12-31",
                Some(14_820_000),
            ),
            (
                "RETENUE_AOUT_2026",
                "Retenue contractuelle août 2026",
                "other",
                "employee",
                "2026-08-31",
                None,
            ),
        ] {
            let definition = store
                .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                    id: None,
                    code: code.into(),
                    label: label.into(),
                    category: category.into(),
                    side: side.into(),
                    calculation_kind: "rate".into(),
                    rate_bp: Some(100),
                    fixed_amount_cents: None,
                    annual_ceiling_cents: ceiling,
                    basis_kind: if category == "aap" {
                        "ahv_salary".into()
                    } else {
                        "gross".into()
                    },
                    lpp_component: None,
                    lpp_employee_id: None,
                    source: "Police ou contrat explicite de test".into(),
                    effective_from: "2026-01-01".into(),
                    effective_to: Some(effective_to.into()),
                    active: true,
                    liability_account_id: liability_account_id.clone(),
                    expense_account_id: (side == "employer")
                        .then(|| expense_account_id.clone())
                        .flatten(),
                })
                .unwrap();
            selections.push(ContributionSelectionInput {
                definition_id: value_id(&definition),
                basis_cents: (category == "aap").then_some(500_000),
                year_to_date_basis_cents: ceiling.map(|_| 0),
            });
        }
        selections
    }

    const LPP_TEST_REGULATION: &str = "Règlement LPP TEST-2026, art. 12";

    fn set_lpp_plan_evidence(store: &LocalStore, evidence: Option<serde_json::Value>) {
        let workspace = store.get_workspace().unwrap();
        let mut extra: serde_json::Value = serde_json::from_str(
            workspace["settings"]["extra_settings_json"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let payroll = extra["payroll"].as_object_mut().unwrap();
        payroll.insert("pensionFund".into(), json!("Fondation LPP de test"));
        match evidence {
            Some(value) => {
                payroll.insert("lppPlanEvidence".into(), value);
            }
            None => {
                payroll.remove("lppPlanEvidence");
            }
        }
        store
            .update_settings(json!({"extra_settings_json":extra}))
            .unwrap();
    }

    fn valid_lpp_plan_evidence() -> serde_json::Value {
        json!({
            "contractNumber":"LPP-TEST-2026-001",
            "regulationReference":LPP_TEST_REGULATION,
            "effectiveFrom":"2026-01-01",
            "effectiveTo":"2026-12-31",
            "employerAggregateShareConfirmed":true
        })
    }

    fn make_employee_lpp_due(store: &LocalStore, employee_id: &str, birth_date: &str) {
        store
            .update_record(
                "employees",
                employee_id,
                json!({
                    "birth_date":birth_date,
                    "employment_start_date":"2020-01-01",
                    "employment_contract_kind":"indefinite",
                    "lpp_assessment_year":2026,
                    "lpp_annual_salary_cents":6_000_000,
                    "lpp_exception_code":null,
                    "lpp_exception_evidence_reference":null
                }),
            )
            .unwrap();
    }

    fn lpp_definition_input(
        employee_id: &str,
        code: &str,
        side: &str,
        component: &str,
        amount_cents: i64,
    ) -> ContributionDefinitionInput {
        ContributionDefinitionInput {
            id: None,
            code: code.into(),
            label: format!("LPP {component} {side}"),
            category: "lpp".into(),
            side: side.into(),
            calculation_kind: "fixed".into(),
            rate_bp: None,
            fixed_amount_cents: Some(amount_cents),
            annual_ceiling_cents: None,
            basis_kind: "coordinated".into(),
            lpp_component: Some(component.into()),
            lpp_employee_id: Some(employee_id.into()),
            source: LPP_TEST_REGULATION.into(),
            effective_from: "2026-01-01".into(),
            effective_to: Some("2026-12-31".into()),
            active: true,
            liability_account_id: None,
            expense_account_id: None,
        }
    }

    fn create_lpp_selection(
        store: &LocalStore,
        input: ContributionDefinitionInput,
    ) -> ContributionSelectionInput {
        let definition = store.upsert_payroll_contribution_definition(input).unwrap();
        ContributionSelectionInput {
            definition_id: value_id(&definition),
            basis_cents: Some(3_354_000),
            year_to_date_basis_cents: None,
        }
    }

    fn valid_salary_line() -> PayslipManualLineInput {
        PayslipManualLineInput {
            id: None,
            label: "Salaire brut".into(),
            kind: "earning".into(),
            amount_cents: 500_000,
            posting_account_id: None,
            expense_account_id: None,
        }
    }

    fn save_valid_test_payslip(
        store: &LocalStore,
        employee_id: &str,
        contributions: Vec<ContributionSelectionInput>,
    ) -> crate::error::AppResult<serde_json::Value> {
        store.save_payslip_with_contributions(SavePayslipWithContributionsInput {
            id: None,
            employee_id: employee_id.into(),
            period: "2026-06".into(),
            status: "valide".into(),
            payment_date: None,
            notes: None,
            lines: vec![valid_salary_line()],
            contributions,
        })
    }

    fn test_invoice_qr_bill(invoice_id: &str, message: &str) -> SaveInvoiceQrBillInput {
        SaveInvoiceQrBillInput {
            invoice_id: invoice_id.to_owned(),
            bill: SwissQrBillInput {
                iban: "CH4431999123000889012".into(),
                creditor: SwissQrParty {
                    name: "Entreprise de test".into(),
                    street: "Adresse de test".into(),
                    building_number: "17B".into(),
                    postal_code: "1000".into(),
                    city: "Ville test".into(),
                    country: "CH".into(),
                },
                amount_cents: Some(194_900),
                currency: "CHF".into(),
                debtor: Some(SwissQrParty {
                    name: "Client QR".into(),
                    street: "Rue du Client".into(),
                    building_number: "7".into(),
                    postal_code: "1000".into(),
                    city: "Lausanne".into(),
                    country: "CH".into(),
                }),
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
            (
                "vat_deferred_payable",
                "2201",
                "TVA à régulariser",
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
            (
                "supplier_payable",
                "2002",
                "Dettes fournisseurs",
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
                vat_deferred_payable_account_id: Some(a["vat_deferred_payable"].clone()),
                bank_account_id: Some(a["bank"].clone()),
                expense_account_id: Some(a["expense"].clone()),
                vat_receivable_account_id: Some(a["vat_receivable"].clone()),
                wages_expense_account_id: Some(a["wages_expense"].clone()),
                wages_payable_account_id: Some(a["wages_payable"].clone()),
                social_expense_account_id: Some(a["social_expense"].clone()),
                social_payable_account_id: Some(a["social_payable"].clone()),
                supplier_payable_account_id: Some(a["supplier_payable"].clone()),
            })
            .expect("configure accounting");
        a
    }

    fn post_manual_pair(
        store: &LocalStore,
        entry_date: &str,
        description: &str,
        debit_account_id: &str,
        credit_account_id: &str,
        amount_cents: i64,
        currency: &str,
    ) -> serde_json::Value {
        store
            .post_manual_journal_entry(ManualJournalInput {
                entry_date: entry_date.into(),
                description: description.into(),
                currency: currency.into(),
                lines: vec![
                    ManualJournalLineInput {
                        account_id: debit_account_id.into(),
                        debit_cents: amount_cents,
                        credit_cents: 0,
                        memo: None,
                        project_id: None,
                        client_id: None,
                        employee_id: None,
                    },
                    ManualJournalLineInput {
                        account_id: credit_account_id.into(),
                        debit_cents: 0,
                        credit_cents: amount_cents,
                        memo: None,
                        project_id: None,
                        client_id: None,
                        employee_id: None,
                    },
                ],
            })
            .expect("post balanced manual journal pair")
    }

    #[test]
    fn accounting_requires_seven_core_mappings_until_payroll_is_enabled() {
        let (_temporary, store) = initialized_store();
        let accounts = accounting_accounts(&store);
        let core_only = || AccountingSettingsInput {
            enabled: true,
            ar_account_id: Some(accounts["ar"].clone()),
            revenue_account_id: Some(accounts["revenue"].clone()),
            vat_payable_account_id: Some(accounts["vat_payable"].clone()),
            vat_deferred_payable_account_id: Some(accounts["vat_deferred_payable"].clone()),
            bank_account_id: Some(accounts["bank"].clone()),
            expense_account_id: Some(accounts["expense"].clone()),
            vat_receivable_account_id: Some(accounts["vat_receivable"].clone()),
            wages_expense_account_id: None,
            wages_payable_account_id: None,
            social_expense_account_id: None,
            social_payable_account_id: None,
            supplier_payable_account_id: Some(accounts["supplier_payable"].clone()),
        };

        store.configure_accounting(core_only()).unwrap();
        assert_eq!(
            store.get_accounting_continuity().unwrap()["mapping_ready"],
            true
        );
        let mut duplicated_asset_role = core_only();
        duplicated_asset_role.bank_account_id = duplicated_asset_role.ar_account_id.clone();
        let duplicate_error = store
            .configure_accounting(duplicated_asset_role)
            .unwrap_err();
        assert!(duplicate_error.to_string().contains("comptes distincts"));

        let connection = store.connect().unwrap();
        connection
            .execute(
                "UPDATE settings SET extra_settings_json=json_set(extra_settings_json,'$.payroll.enabled',1) WHERE id=1",
                [],
            )
            .unwrap();
        drop(connection);

        assert_eq!(
            store.get_accounting_continuity().unwrap()["mapping_ready"],
            false
        );
        let error = store.configure_accounting(core_only()).unwrap_err();
        assert!(error.to_string().contains("onze comptes"));
    }

    #[test]
    fn automatic_journal_refuses_the_same_account_on_both_sides() {
        let (_temporary, store) = initialized_store();
        let accounts = accounting_accounts(&store);
        let mut connection = store.connect().unwrap();
        let transaction = connection.transaction().unwrap();
        let common = crate::accounting::EntryLine {
            account_id: accounts["bank"].clone(),
            debit_cents: 10_000,
            credit_cents: 0,
            currency: "CHF".into(),
            memo: Some("Encaissement".into()),
            project_id: None,
            client_id: None,
            employee_id: None,
        };
        let error = crate::accounting::post_entry(
            &transaction,
            "2026-09-01",
            "Paiement invalide",
            "payment",
            "payment-same-account",
            "invoice:invoice-1",
            vec![
                common.clone(),
                crate::accounting::EntryLine {
                    debit_cents: 0,
                    credit_cents: 10_000,
                    ..common
                },
            ],
        )
        .unwrap_err();
        assert!(error.to_string().contains("même compte"));
    }

    #[test]
    fn payslip_posting_revalidates_stale_payroll_mapping_types() {
        let (_temporary, store) = initialized_store();
        let accounts = accounting_accounts(&store);
        store
            .configure_accounting(AccountingSettingsInput {
                enabled: true,
                ar_account_id: Some(accounts["ar"].clone()),
                revenue_account_id: Some(accounts["revenue"].clone()),
                vat_payable_account_id: Some(accounts["vat_payable"].clone()),
                vat_deferred_payable_account_id: Some(accounts["vat_deferred_payable"].clone()),
                bank_account_id: Some(accounts["bank"].clone()),
                expense_account_id: Some(accounts["expense"].clone()),
                vat_receivable_account_id: Some(accounts["vat_receivable"].clone()),
                wages_expense_account_id: Some(accounts["bank"].clone()),
                wages_payable_account_id: Some(accounts["bank"].clone()),
                social_expense_account_id: Some(accounts["bank"].clone()),
                social_payable_account_id: Some(accounts["bank"].clone()),
                supplier_payable_account_id: Some(accounts["supplier_payable"].clone()),
            })
            .unwrap();
        let employee_id = value_id(
            &store
                .create_record(
                    "employees",
                    json!({
                        "name":"Employé garde-fou",
                        // Né en 2009 : aucune trace AVS de petit salaire n'est
                        // requise pour la période 2026 de ce test comptable.
                        "birth_date":"2009-01-01"
                    }),
                )
                .unwrap(),
        );
        let mut connection = store.connect().unwrap();
        connection
            .execute(
                "UPDATE settings SET extra_settings_json=json_set(extra_settings_json,'$.payroll.enabled',1) WHERE id=1",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO payslips(id,employee_id,period,status,gross_cents,deductions_cents,net_cents,employer_costs_cents,created_at,updated_at) VALUES('payslip-stale-mapping',?,'2026-09','valide',10000,0,10000,0,'2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')",
                rusqlite::params![employee_id],
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        let error = crate::accounting::post_payslip_if_enabled(
            &transaction,
            "payslip-stale-mapping",
            "2026-09-30",
        )
        .unwrap_err();
        assert!(error.to_string().contains("charges salariales"));
        assert!(error.to_string().contains("type expense"));
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
        let progressive =
            store.validate_onboarding_scoped(input.clone(), OnboardingValidationScope::Essential);
        assert!(
            progressive
                .issues
                .iter()
                .any(|issue| issue.field == "billing.iban"),
            "an explicitly entered invalid IBAN must never be discarded silently"
        );

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
    fn onboarding_accepts_deferred_billing_without_inventing_an_iban() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        let mut input = test_onboarding();
        input.vat_registered = true;
        input.uid_number = Some("CHE-000.000.000 TVA".into());
        input.default_vat_bp = None;
        input.iban = None;
        input.bank_name = None;
        input.extra_settings_json = Some(json!({
            "billing": { "accountHolder": "" },
            "work": {
                "workWeekHours": 0,
                "dailyHours": 0,
                "roundingMinutes": 5,
                "breakMinutes": 0,
                "costCategories": []
            },
            "payroll": { "enabled": false },
            "backup": {
                "automatic": false,
                "folder": "",
                "frequency": "manual",
                "retentionDaily": 0,
                "retentionWeekly": 0,
                "retentionMonthly": 0,
                "recoveryConfirmed": false
            }
        }));

        let complete_validation = store.validate_onboarding(input.clone());
        assert!(!complete_validation.valid);
        assert!(complete_validation
            .issues
            .iter()
            .any(|issue| issue.field == "billing.iban"));
        assert!(complete_validation
            .issues
            .iter()
            .any(|issue| issue.field == "billing.vatRatesBp"));

        let validation =
            store.validate_onboarding_scoped(input.clone(), OnboardingValidationScope::Essential);
        assert!(
            validation.valid,
            "unexpected issues: {:?}",
            validation.issues
        );

        let completed = store
            .complete_onboarding_scoped(input, "1.0.0", OnboardingValidationScope::Essential)
            .expect("minimal onboarding must commit atomically");
        assert_eq!(completed.workspace["settings"]["iban"], "");
        assert_eq!(completed.workspace["settings"]["default_vat_bp"], 0);
        let extra: serde_json::Value = serde_json::from_str(
            completed.workspace["settings"]["extra_settings_json"]
                .as_str()
                .expect("extended settings JSON"),
        )
        .expect("valid extended settings");
        assert_eq!(
            extra["setupDeferred"],
            json!({ "billing": true, "work": true, "backup": true })
        );
        let mut connection = store.connect().expect("reopen settings");
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("read deferred state transactionally");
        assert!(require_setup_confirmed(&transaction, "billing")
            .expect_err("billing must remain gated")
            .to_string()
            .contains("Confirmez les réglages de facturation"));
        assert!(require_setup_confirmed(&transaction, "work")
            .expect_err("time rules must remain gated")
            .to_string()
            .contains("Confirmez les règles de temps et de coûts"));
        drop(transaction);

        let mut work_confirmed_extra = extra.clone();
        work_confirmed_extra["setupDeferred"]["work"] = json!(false);
        let updated = store
            .update_settings(json!({ "extra_settings_json": work_confirmed_extra }))
            .expect("work setup can be confirmed while billing remains deferred");
        let updated_extra: serde_json::Value = serde_json::from_str(
            updated["extra_settings_json"]
                .as_str()
                .expect("updated extended settings JSON"),
        )
        .expect("valid updated extended settings");
        assert_eq!(updated_extra["setupDeferred"]["work"], false);
        assert_eq!(updated_extra["setupDeferred"]["billing"], true);

        let mut falsely_confirmed_billing = updated_extra;
        falsely_confirmed_billing["setupDeferred"]["billing"] = json!(false);
        assert!(store
            .update_settings(json!({ "extra_settings_json": falsely_confirmed_billing }))
            .expect_err("billing cannot be confirmed without an explicit VAT rate")
            .to_string()
            .contains("Un taux de TVA explicite est obligatoire"));
        assert!(completed.workspace["clients"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(completed.workspace["projects"]
            .as_array()
            .unwrap()
            .is_empty());
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
            .replace("PRAGMA user_version = 19;", "PRAGMA user_version = 2;");
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
        assert_eq!(version, SCHEMA_VERSION);
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
    fn v13_migration_repairs_only_matching_legacy_payslip_payment_links() {
        let temporary = tempfile::tempdir().unwrap();
        let data_dir = temporary.path().join("pre-payment-link-v12-profile");
        std::fs::create_dir_all(&data_dir).unwrap();
        let database_path = data_dir.join("helvichantier.sqlite3");
        let connection = rusqlite::Connection::open(&database_path).unwrap();
        connection.execute_batch(SCHEMA_SQL).unwrap();
        connection.execute_batch(
            "DROP TRIGGER IF EXISTS payslips_small_salary_posted_trace_insert_guard;
             DROP TRIGGER IF EXISTS payslips_small_salary_posted_trace_update_guard;
             DROP TRIGGER IF EXISTS payslips_later_posted_insert_guard;
             DROP TRIGGER IF EXISTS payslips_later_posted_update_guard;
             DROP TRIGGER IF EXISTS payslips_later_posted_delete_guard;
             INSERT INTO employees(id,name,created_at,updated_at) VALUES('employee-v12','Employé v12','2026-01-01','2026-01-01');
             INSERT INTO journal_entries(id,number,entry_date,description,source_type,source_id,source_event,status,created_at)
               VALUES('journal-payment-a','J-2026-000001','2026-09-02','Paiement salaire','payslip','payslip-a','payment','posted','2026-09-02');
             INSERT INTO payslips(id,employee_id,period,status,gross_cents,deductions_cents,net_cents,employer_costs_cents,payment_date,payment_journal_entry_id,created_at,updated_at)
               VALUES('payslip-a','employee-v12','2026-08','paye',100000,10000,90000,0,NULL,'journal-payment-a','2026-08-31','2026-09-02');
             INSERT INTO payslips(id,employee_id,period,status,gross_cents,deductions_cents,net_cents,employer_costs_cents,payment_date,payment_journal_entry_id,created_at,updated_at)
               VALUES('payslip-b','employee-v12','2026-09','paye',100000,10000,90000,0,NULL,'journal-payment-a','2026-09-30','2026-10-02');
             PRAGMA user_version=12;",
        ).unwrap();
        drop(connection);

        let store = LocalStore::initialize(data_dir).unwrap();
        let connection = store.connect().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let repaired: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT payment_date,payment_journal_entry_id FROM payslips WHERE id='payslip-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            repaired,
            (Some("2026-09-02".into()), Some("journal-payment-a".into()))
        );
        let wrong_link_date: Option<String> = connection
            .query_row(
                "SELECT payment_date FROM payslips WHERE id='payslip-b'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            wrong_link_date, None,
            "a journal belonging to another payslip must never repair the date"
        );
        assert!(connection
            .execute(
                "UPDATE payslips SET payment_date='2026-09-03' WHERE id='payslip-a'",
                [],
            )
            .is_err());
    }

    #[test]
    fn v14_migration_adds_empty_supplier_ledger_to_a_real_v13_shape() {
        let temporary = tempfile::tempdir().unwrap();
        let data_dir = temporary.path().join("pre-supplier-ledger-v13-profile");
        std::fs::create_dir_all(&data_dir).unwrap();
        let database_path = data_dir.join("helvichantier.sqlite3");
        let connection = rusqlite::Connection::open(&database_path).unwrap();
        connection.execute_batch(SCHEMA_SQL).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER attachments_supplier_insert_guard;
                 DROP TRIGGER attachments_no_update;
                 DROP TRIGGER attachments_supplier_validated_no_delete;
                 DROP TABLE supplier_payments;
                 DROP TABLE supplier_invoice_items;
                 DROP TABLE supplier_invoices;
                 ALTER TABLE accounting_settings RENAME TO accounting_settings_v14;
                 CREATE TABLE accounting_settings (
                   id INTEGER PRIMARY KEY CHECK (id = 1),
                   enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
                   ar_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
                   revenue_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
                   vat_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
                   bank_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
                   expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
                   vat_receivable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
                   wages_expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
                   wages_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
                   social_expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
                   social_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 INSERT INTO accounting_settings(id,enabled,created_at,updated_at)
                   SELECT id,enabled,created_at,updated_at FROM accounting_settings_v14;
                 DROP TABLE accounting_settings_v14;
                 INSERT OR IGNORE INTO accounting_settings(id,enabled,created_at,updated_at)
                   VALUES(1,0,'2026-01-01','2026-01-01');
                 INSERT INTO settings(id,onboarding_completed,company_name,noga_section,noga_division,activity_description,created_at,updated_at)
                   VALUES(1,1,'Entreprise v13','F','43','Entreprise conservée','2026-01-01','2026-01-01');
                 INSERT INTO clients(id,name,country,created_at,updated_at)
                   VALUES('client-v13','Client v13 conservé','CH','2026-01-01','2026-01-01');
                 PRAGMA user_version=13;",
            )
            .unwrap();
        let old_columns: Vec<String> = connection
            .prepare("PRAGMA table_info(accounting_settings)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!old_columns
            .iter()
            .any(|name| name == "supplier_payable_account_id"));
        let old_supplier_tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN('supplier_invoices','supplier_invoice_items','supplier_payments')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_supplier_tables, 0);
        drop(connection);

        let store = LocalStore::initialize(data_dir).unwrap();
        let connection = store.connect().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let new_columns: Vec<String> = connection
            .prepare("PRAGMA table_info(accounting_settings)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(new_columns
            .iter()
            .any(|name| name == "supplier_payable_account_id"));
        let objects: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN('supplier_invoices','supplier_invoice_items','supplier_payments')),
                   (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN('idx_supplier_invoices_status_due','idx_supplier_invoices_reference_unique','idx_supplier_invoice_items_parent','idx_supplier_payments_parent')),
                   (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN(
                     'supplier_invoice_items_draft_insert','supplier_invoice_items_draft_update','supplier_invoice_items_draft_delete',
                     'supplier_invoices_validated_no_delete','supplier_invoices_validation_guard','supplier_invoices_validated_guard',
                     'supplier_payments_insert_guard','supplier_payments_update_invoice_total','supplier_payments_no_update','supplier_payments_no_delete'
                   ))",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(objects.0, 3);
        assert_eq!(objects.1, 4);
        assert_eq!(objects.2, 10);
        let supplier_payable: Option<String> = connection
            .query_row(
                "SELECT supplier_payable_account_id FROM accounting_settings WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(supplier_payable, None);
        assert_eq!(
            store.get_workspace().unwrap()["clients"][0]["name"],
            "Client v13 conservé"
        );
        assert!(store.get_workspace().unwrap()["supplier_invoices"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn v10_migration_adds_an_empty_catalog_and_preserves_legacy_lines() {
        let temporary = tempfile::tempdir().unwrap();
        let data_dir = temporary.path().join("pre-catalog-v9-profile");
        std::fs::create_dir_all(&data_dir).unwrap();
        let database_path = data_dir.join("helvichantier.sqlite3");
        let connection = rusqlite::Connection::open(&database_path).unwrap();
        connection.execute_batch(SCHEMA_SQL).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER stock_invoice_no_unsafe_cancel;
                 DROP TRIGGER stock_movements_no_delete;
                 DROP TRIGGER stock_movements_no_update;
                 DROP TRIGGER stock_movements_apply_balance;
                 DROP TRIGGER stock_movements_insert_guard;
                 DROP TRIGGER catalog_items_stock_history_no_delete;
                 DROP TRIGGER catalog_items_track_stock_enable_guard;
                 DROP TRIGGER catalog_items_track_stock_history_guard;
                 DROP TRIGGER catalog_items_stock_balance_guard;
                 DROP TRIGGER catalog_items_initial_stock_guard;
                 DROP TRIGGER catalog_items_stock_kind_update_guard;
                 DROP TRIGGER catalog_items_stock_kind_insert_guard;
                 DROP TABLE stock_movements;
                 DROP INDEX idx_quote_items_catalog;
                 DROP INDEX idx_invoice_items_catalog;
                 DROP INDEX idx_catalog_items_name;
                 DROP INDEX idx_catalog_items_sku;
                 DROP INDEX idx_catalog_items_archived;
                 ALTER TABLE quote_items DROP COLUMN catalog_item_id;
                 ALTER TABLE invoice_items DROP COLUMN catalog_item_id;
                 DROP TABLE catalog_items;
                 PRAGMA user_version=9;",
            )
            .unwrap();
        let pre_migration_catalog: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='catalog_items'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pre_migration_catalog, 0);
        connection.execute("INSERT INTO settings(id,onboarding_completed,company_name,noga_section,noga_division,activity_description,created_at,updated_at) VALUES(1,1,'Entreprise v9','F','43','Entreprise historique','2026-01-01','2026-01-01')",[]).unwrap();
        connection.execute("INSERT INTO quotes(id,title,status,currency,created_at,updated_at) VALUES('quote-v9','Devis conservé','brouillon','CHF','2026-01-01','2026-01-01')",[]).unwrap();
        connection.execute("INSERT INTO quote_items(id,quote_id,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at) VALUES('line-v9','quote-v9','Ligne historique',2,'heure',8000,1250,0,14000,0,14000,'2026-01-01','2026-01-01')",[]).unwrap();
        drop(connection);

        let store = LocalStore::initialize(data_dir).unwrap();
        let connection = store.connect().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        for table in ["quote_items", "invoice_items"] {
            let has_catalog_reference: bool = connection
                .query_row(
                    &format!(
                        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name='catalog_item_id')"
                    ),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(has_catalog_reference, "missing catalog_item_id on {table}");
        }
        let workspace = store.get_workspace().unwrap();
        assert!(workspace["catalog_items"].as_array().unwrap().is_empty());
        assert_eq!(
            workspace["quote_items"][0]["description"],
            "Ligne historique"
        );
        assert_eq!(workspace["quote_items"][0]["line_net_cents"], 14_000);
        assert_eq!(workspace["quote_items"][0]["catalog_item_id"], json!(null));
    }

    #[test]
    fn v11_migration_preserves_v10_expenses_as_paid_without_seeding_suppliers() {
        let temporary = tempfile::tempdir().unwrap();
        let data_dir = temporary.path().join("pre-suppliers-v10-profile");
        std::fs::create_dir_all(&data_dir).unwrap();
        let database_path = data_dir.join("helvichantier.sqlite3");
        let suppliers_table = r#"CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  uid_number TEXT,
  iban TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF' CHECK (currency = 'CHF'),
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  notes TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

"#;
        let current_expenses_table = r#"CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  supplier_id TEXT REFERENCES suppliers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  date TEXT NOT NULL,
  due_date TEXT,
  supplier TEXT,
  category TEXT,
  reference TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF' CHECK (currency = 'CHF'),
  net_cents INTEGER NOT NULL DEFAULT 0,
  vat_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('pending', 'paid')),
  paid_at TEXT,
  reimbursable INTEGER NOT NULL DEFAULT 0 CHECK (reimbursable IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (payment_status <> 'pending' OR (due_date IS NOT NULL AND due_date <> '' AND paid_at IS NULL))
);
"#;
        let legacy_expenses_table = r#"CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  date TEXT NOT NULL,
  supplier TEXT,
  category TEXT,
  reference TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF',
  net_cents INTEGER NOT NULL DEFAULT 0,
  vat_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  reimbursable INTEGER NOT NULL DEFAULT 0 CHECK (reimbursable IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;
        let payment_guards = r#"CREATE TRIGGER IF NOT EXISTS expenses_payment_state_insert_guard
BEFORE INSERT ON expenses
WHEN NEW.payment_status='pending' AND (NEW.due_date IS NULL OR TRIM(NEW.due_date)='' OR NEW.paid_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'pending expense requires a due date and no payment date'); END;
CREATE TRIGGER IF NOT EXISTS expenses_payment_state_update_guard
BEFORE UPDATE OF payment_status,paid_at,due_date ON expenses
WHEN NEW.payment_status='pending' AND (NEW.due_date IS NULL OR TRIM(NEW.due_date)='' OR NEW.paid_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'pending expense requires a due date and no payment date'); END;
"#;
        let legacy_schema = SCHEMA_SQL
            .replace(suppliers_table, "")
            .replace(current_expenses_table, legacy_expenses_table)
            .replace(payment_guards, "")
            .lines()
            .filter(|line| {
                !line.contains("idx_suppliers_")
                    && !line.contains("idx_expenses_supplier_date")
                    && !line.contains("idx_expenses_payment_due")
            })
            .collect::<Vec<_>>()
            .join("\n")
            .replace("PRAGMA user_version = 19;", "PRAGMA user_version = 10;");
        assert!(!legacy_schema.contains("CREATE TABLE IF NOT EXISTS suppliers"));
        assert!(!legacy_schema.contains(
            "supplier_id TEXT REFERENCES suppliers(id) ON UPDATE RESTRICT ON DELETE RESTRICT"
        ));
        assert!(!legacy_schema.contains("payment_status"));

        let connection = rusqlite::Connection::open(&database_path).unwrap();
        connection.execute_batch(&legacy_schema).unwrap();
        connection.execute("INSERT INTO settings(id,onboarding_completed,company_name,noga_section,noga_division,activity_description,created_at,updated_at) VALUES(1,1,'Entreprise v10','F','43','Entreprise historique','2026-01-01','2026-01-01')",[]).unwrap();
        connection.execute("INSERT INTO expenses(id,date,supplier,currency,net_cents,vat_cents,total_cents,reimbursable,note,created_at,updated_at) VALUES('expense-v10','2026-08-01','Fournisseur historique','CHF',10000,810,10810,0,'Dépense conservée','2026-08-01','2026-08-01')",[]).unwrap();
        drop(connection);

        let store = LocalStore::initialize(data_dir).unwrap();
        let connection = store.connect().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let workspace = store.get_workspace().unwrap();
        assert!(workspace["suppliers"].as_array().unwrap().is_empty());
        let expense = &workspace["expenses"][0];
        assert_eq!(expense["id"], "expense-v10");
        assert_eq!(expense["supplier"], "Fournisseur historique");
        assert_eq!(expense["total_cents"], 10_810);
        assert_eq!(expense["payment_status"], "paid");
        assert_eq!(expense["supplier_id"], json!(null));
        assert_eq!(expense["due_date"], json!(null));
        assert_eq!(expense["paid_at"], json!(null));
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
    fn legacy_missing_iban_does_not_block_an_unrelated_noga_update() {
        let (_temporary, store) = initialized_store();

        for legacy_iban in [None, Some("")] {
            store
                .connect()
                .unwrap()
                .execute(
                    "UPDATE settings SET iban=? WHERE id=1",
                    rusqlite::params![legacy_iban],
                )
                .unwrap();

            let updated = store
                .update_settings(json!({
                    "noga_section":"N",
                    "noga_division":"71",
                    "activity_description":"Architecture et ingénierie",
                    "noga_detailed_code":"7112",
                    "iban":legacy_iban
                }))
                .expect("a legacy missing IBAN in a full payload must not block a NOGA update");

            assert_eq!(updated["noga_section"], "N");
            assert_eq!(updated["noga_division"], "71");
            let stored_iban: Option<String> = store
                .connect()
                .unwrap()
                .query_row("SELECT iban FROM settings WHERE id=1", [], |row| row.get(0))
                .unwrap();
            assert_eq!(stored_iban, None);
        }

        assert!(store
            .update_settings(json!({"iban":"CH00 INVALID"}))
            .unwrap_err()
            .to_string()
            .contains("IBAN CH ou LI"));

        let client_id = value_id(
            &store
                .create_record("clients", json!({"name":"Client sans IBAN"}))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture sans IBAN",
                        "service_date_from":"2026-09-01",
                        "service_date_to":"2026-09-01"
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":invoice_id,
                    "description":"Prestation",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":194_900,
                    "vat_bp":0
                }),
            )
            .unwrap();

        assert!(store
            .issue_invoice(&invoice_id, Some("2026-09-01".into()), None)
            .unwrap_err()
            .to_string()
            .contains("IBAN CH ou LI"));
        let mut qr_bill = test_invoice_qr_bill(&invoice_id, "Facture sans IBAN");
        qr_bill.bill.iban.clear();
        assert!(store
            .save_invoice_qr_bill(qr_bill)
            .unwrap_err()
            .to_string()
            .contains("IBAN"));
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
            .create_record("clients", test_client("Client vérifié"))
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
    fn document_issue_rejects_dates_before_issue_without_consuming_numbers() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client dates document"))
                .expect("create client"),
        );
        let quote_id = value_id(
            &store
                .create_record(
                    "quotes",
                    json!({"client_id":client_id,"title":"Devis avec échéance"}),
                )
                .expect("create quote"),
        );
        store
            .create_record(
                "quote_items",
                json!({
                    "quote_id":quote_id,
                    "description":"Prestation",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":10_000,
                    "vat_bp":0
                }),
            )
            .expect("create quote item");

        let quote_error = store
            .issue_quote(
                &quote_id,
                Some("2026-09-10".into()),
                Some("2026-09-09".into()),
            )
            .expect_err("validity before issue date must fail");
        assert!(quote_error
            .to_string()
            .contains("date de validité du devis ne peut pas précéder"));

        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture avec échéance",
                        "service_date_from":"2026-09-01",
                        "service_date_to":"2026-09-01"
                    }),
                )
                .expect("create invoice"),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":invoice_id,
                    "description":"Prestation",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":10_000,
                    "vat_bp":0
                }),
            )
            .expect("create invoice item");

        let invoice_error = store
            .issue_invoice(
                &invoice_id,
                Some("2026-09-10".into()),
                Some("2026-09-09".into()),
            )
            .expect_err("due date before issue date must fail");
        assert!(invoice_error
            .to_string()
            .contains("date d'échéance de la facture ne peut pas précéder"));

        let connection = store.connect().expect("database connection");
        let quote_state: (Option<String>, String, Option<String>) = connection
            .query_row(
                "SELECT number,status,snapshot_json FROM quotes WHERE id=?",
                rusqlite::params![quote_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("quote state after rejected issue");
        let invoice_state: (Option<String>, String, Option<String>) = connection
            .query_row(
                "SELECT number,status,snapshot_json FROM invoices WHERE id=?",
                rusqlite::params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("invoice state after rejected issue");
        assert_eq!(quote_state, (None, "brouillon".into(), None));
        assert_eq!(invoice_state, (None, "brouillon".into(), None));
        drop(connection);

        let quote = store
            .issue_quote(
                &quote_id,
                Some("2026-09-10".into()),
                Some("2026-09-10".into()),
            )
            .expect("same-day quote validity remains valid");
        let invoice = store
            .issue_invoice(
                &invoice_id,
                Some("2026-09-10".into()),
                Some("2026-09-10".into()),
            )
            .expect("same-day invoice due date remains valid");
        assert_eq!(quote["number"], "D-2026-0001");
        assert_eq!(invoice["number"], "F-2026-0001");
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
    fn deposit_invoice_is_saved_issued_and_snapshotted_with_its_percentage() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client acompte"))
                .unwrap(),
        );

        let missing = store.save_document_with_items(SaveDocumentWithItemsInput {
            entity: "invoices".into(),
            id: None,
            data: json!({
                "client_id":client_id,
                "title":"Acompte sans pourcentage",
                "type":"acompte",
                "service_date_from":"2026-09-01",
                "service_date_to":"2026-09-01",
                "currency":"CHF"
            }),
            items: vec![json!({
                "description":"Acompte",
                "quantity":1,
                "unit":"forfait",
                "unit_price_cents":25_000,
                "discount_bp":0,
                "vat_bp":0
            })],
        });
        assert!(missing
            .unwrap_err()
            .to_string()
            .contains("deposit_percentage_bp"));

        let detailed_basis = json!([{
            "id":"base-line-1",
            "catalog_item_id":"catalog-reference-17",
            "description":"Mandat détaillé",
            "quantity":2.5,
            "unit":"heure",
            "unit_price_cents":40_000,
            "discount_bp":0,
            "vat_bp":810
        }]);
        let missing_basis = store.save_document_with_items(SaveDocumentWithItemsInput {
            entity: "invoices".into(),
            id: None,
            data: json!({
                "client_id":client_id,
                "title":"Nouvel acompte sans base détaillée",
                "type":"acompte",
                "deposit_percentage_bp":2_500,
                "service_date_from":"2026-09-01",
                "service_date_to":"2026-09-01",
                "currency":"CHF"
            }),
            items: vec![json!({
                "description":"Acompte 25 % sur mandat",
                "quantity":1,
                "unit":"acompte",
                "unit_price_cents":25_000,
                "discount_bp":0,
                "vat_bp":810
            })],
        });
        assert!(missing_basis
            .unwrap_err()
            .to_string()
            .contains("base détaillée"));

        let saved = store
            .save_document_with_items(SaveDocumentWithItemsInput {
                entity: "invoices".into(),
                id: None,
                data: json!({
                    "client_id":client_id,
                    "title":"Acompte 25 %",
                    "type":"deposit",
                    "deposit_percentage_bp":2_500,
                    "deposit_basis_json":detailed_basis,
                    "service_date_from":"2026-09-01",
                    "service_date_to":"2026-09-01",
                    "currency":"CHF"
                }),
                items: vec![json!({
                    "description":"Acompte 25 % sur mandat",
                    "quantity":1,
                    "unit":"acompte",
                    "unit_price_cents":25_000,
                    "discount_bp":0,
                    "vat_bp":810
                })],
            })
            .unwrap();
        let invoice_id = saved["document"]["id"].as_str().unwrap().to_owned();
        assert_eq!(saved["document"]["type"], "acompte");
        assert_eq!(saved["document"]["deposit_percentage_bp"], 2_500);
        let saved_basis: serde_json::Value =
            serde_json::from_str(saved["document"]["deposit_basis_json"].as_str().unwrap())
                .unwrap();
        assert_eq!(saved_basis, detailed_basis);

        let mismatched = store.save_document_with_items(SaveDocumentWithItemsInput {
            entity: "invoices".into(),
            id: Some(invoice_id.clone()),
            data: json!({"deposit_basis_json":detailed_basis}),
            items: vec![json!({
                "description":"Acompte 25 % sur mandat",
                "quantity":1,
                "unit":"acompte",
                "unit_price_cents":24_999,
                "discount_bp":0,
                "vat_bp":810
            })],
        });
        assert!(mismatched
            .unwrap_err()
            .to_string()
            .contains("base détaillée"));

        let issued = store
            .issue_invoice(&invoice_id, Some("2026-09-01".into()), None)
            .unwrap();
        assert_eq!(issued["deposit_percentage_bp"], 2_500);
        let snapshot: serde_json::Value =
            serde_json::from_str(issued["snapshot_json"].as_str().unwrap()).unwrap();
        assert_eq!(snapshot["document"]["deposit_percentage_bp"], 2_500);
        let snapshot_basis: serde_json::Value =
            serde_json::from_str(snapshot["document"]["deposit_basis_json"].as_str().unwrap())
                .unwrap();
        assert_eq!(snapshot_basis, detailed_basis);

        let correction = store
            .create_invoice_correction(CreateInvoiceCorrectionInput {
                original_invoice_id: invoice_id,
                reason: "Correction du montant de l'acompte".into(),
            })
            .unwrap();
        let connection = store.connect().unwrap();
        let credit_deposit: (Option<i64>, Option<String>) = connection
            .query_row(
                "SELECT deposit_percentage_bp,deposit_basis_json FROM invoices WHERE id=?",
                rusqlite::params![correction["credit_note_id"].as_str().unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let replacement_deposit: (Option<i64>, Option<String>) = connection
            .query_row(
                "SELECT deposit_percentage_bp,deposit_basis_json FROM invoices WHERE id=?",
                rusqlite::params![correction["replacement_invoice_id"].as_str().unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(credit_deposit, (None, None));
        assert_eq!(replacement_deposit.0, Some(2_500));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(replacement_deposit.1.as_deref().unwrap())
                .unwrap(),
            detailed_basis
        );
    }

    #[test]
    fn deposit_invoice_emission_rejects_a_legacy_missing_percentage() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client acompte historique"))
                .unwrap(),
        );
        let invoice_id = "legacy-deposit-without-percentage";
        let now = now_iso();
        let connection = store.connect().unwrap();
        connection
            .execute(
                "INSERT INTO invoices(
                   id,client_id,title,type,status,service_date_from,service_date_to,currency,
                   created_at,updated_at
                 ) VALUES(?,?,'Acompte historique','acompte','brouillon',
                          '2026-09-01','2026-09-01','CHF',?,?)",
                rusqlite::params![invoice_id, client_id, now, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO invoice_items(
                   id,invoice_id,position,description,quantity,unit,unit_price_cents,
                   discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,
                   created_at,updated_at
                 ) VALUES('legacy-deposit-line',?,0,'Acompte',1,'forfait',25000,
                          0,0,25000,0,25000,?,?)",
                rusqlite::params![invoice_id, now, now],
            )
            .unwrap();
        drop(connection);

        let error = store
            .issue_invoice(invoice_id, Some("2026-09-01".into()), None)
            .unwrap_err();
        assert!(error.to_string().contains("deposit_percentage_bp"));
        let connection = store.connect().unwrap();
        let number: Option<String> = connection
            .query_row(
                "SELECT number FROM invoices WHERE id=?",
                rusqlite::params![invoice_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(number, None, "l'émission invalide doit rester atomique");
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
        let bypass = store
            .update_record("payslips", &payslip_id, json!({"status":"valide"}))
            .unwrap_err()
            .to_string();
        assert!(bypass.contains("flux atomique"));
        let status: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT status FROM payslips WHERE id=?",
                rusqlite::params![payslip_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "a_controler");
    }

    #[test]
    fn backup_restore_round_trip_recovers_local_rows() {
        let (temporary, store) = initialized_store();
        let logo_source = temporary.path().join("logo-sauvegarde.png");
        image::DynamicImage::new_rgba8(96, 48)
            .save_with_format(&logo_source, image::ImageFormat::Png)
            .expect("write backup logo");
        let original_logo = store
            .stage_company_logo(logo_source.to_str().expect("logo path"))
            .expect("stage backup logo");
        store
            .update_settings(json!({ "logo_path": original_logo.clone() }))
            .expect("configure backup logo");
        let client = store
            .create_record("clients", json!({"name": "Client à sauvegarder"}))
            .expect("create client");
        let client_id = value_id(&client);
        let backup_path = temporary.path().join("recette.zentra");
        store
            .create_backup(Some(backup_path.to_string_lossy().into_owned()), "1.0.0")
            .expect("create backup");
        store
            .update_settings(json!({
                "noga_section":"F",
                "noga_division":"41",
                "activity_description":"Construction de bâtiments",
                "noga_detailed_code":"410000",
                "logo_path":null,
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
                original_logo
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
    fn successful_backup_persists_readiness_across_store_reload() {
        let (temporary, store) = initialized_store();
        let profile = store.data_dir.clone();
        let configured_folder = temporary.path().join("sauvegardes-configurees");
        std::fs::create_dir_all(&configured_folder).unwrap();

        let saved_path = store
            .create_backup(
                Some(configured_folder.to_string_lossy().into_owned()),
                "1.13.0",
            )
            .expect("create atomic backup and readiness proof");
        drop(store);

        let reloaded = LocalStore::initialize(profile).expect("reload local profile");
        let workspace = reloaded.get_workspace().expect("reload workspace");
        let status = &workspace["backup_status"];
        let recorded_at = status["last_success_at"]
            .as_str()
            .expect("RFC3339 backup timestamp");
        let recorded_path = status["last_path"].as_str().expect("persisted backup path");

        chrono::DateTime::parse_from_rfc3339(recorded_at).expect("valid RFC3339 timestamp");
        assert_eq!(recorded_path, saved_path);
        assert_eq!(
            std::path::Path::new(recorded_path).parent(),
            Some(configured_folder.as_path()),
            "the readiness proof must refer to the configured folder",
        );
        assert_eq!(status["next_scheduled_at"], serde_json::Value::Null);
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

        let backup_path = temporary.path().join("qr-frozen.zentra");
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
    fn post_issue_qr_supplement_matches_final_parties_iban_and_audit_on_every_path() {
        let (temporary, store) = initialized_store();
        store
            .connect()
            .unwrap()
            .execute("UPDATE settings SET logo_path=NULL WHERE id=1", [])
            .unwrap();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client QR"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id": client_id,
                        "title": "Facture supplément QR",
                        "service_date_from": "2026-08-01",
                        "service_date_to": "2026-08-31"
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id": invoice_id,
                    "description": "Prestation réelle",
                    "quantity": 1,
                    "unit": "forfait",
                    "unit_price_cents": 194_900,
                    "vat_bp": 0
                }),
            )
            .unwrap();
        store
            .issue_invoice(
                &invoice_id,
                Some("2026-09-01".into()),
                Some("2026-09-30".into()),
            )
            .unwrap();

        let mut wrong_iban = test_invoice_qr_bill(&invoice_id, "IBAN altéré");
        wrong_iban.bill.iban = "CH9300762011623852957".into();
        assert!(store
            .save_invoice_qr_bill(wrong_iban)
            .unwrap_err()
            .to_string()
            .contains("IBAN"));

        let mut wrong_creditor = test_invoice_qr_bill(&invoice_id, "Partie altérée");
        wrong_creditor.bill.creditor.name = "Autre titulaire".into();
        assert!(store
            .save_invoice_qr_bill(wrong_creditor)
            .unwrap_err()
            .to_string()
            .contains("créancier"));

        let mut leaked_address_line2 = test_invoice_qr_bill(&invoice_id, "Complément concaténé");
        leaked_address_line2.bill.creditor.street = "Adresse de test\nComplément interdit".into();
        let leaked_error = store
            .save_invoice_qr_bill(leaked_address_line2)
            .unwrap_err()
            .to_string();
        assert!(
            leaked_error.contains("créancier") || leaked_error.contains("caractère non admis"),
            "{leaked_error}"
        );

        let mut wrong_debtor = test_invoice_qr_bill(&invoice_id, "Débiteur altéré");
        wrong_debtor.bill.debtor.as_mut().unwrap().building_number = "99".into();
        assert!(store
            .save_invoice_qr_bill(wrong_debtor)
            .unwrap_err()
            .to_string()
            .contains("débiteur"));

        let saved = store
            .save_invoice_qr_bill(test_invoice_qr_bill(
                &invoice_id,
                "Supplément post-émission",
            ))
            .unwrap();
        assert_eq!(saved["frozen"], true);
        assert_eq!(
            store.get_invoice_qr_bill(&invoice_id).unwrap()["payload"],
            saved["payload"]
        );

        let pdf_path = temporary.path().join("supplement-qr-final.pdf");
        let export = store
            .generate_sales_document_pdf(GenerateSalesDocumentPdfInput {
                entity: "invoices".into(),
                document_id: invoice_id.clone(),
                destination_path: pdf_path.to_string_lossy().into_owned(),
            })
            .unwrap();
        assert_eq!(export["final_document"], true);
        assert_eq!(export["has_qr"], true);
        assert!(pdf_path.is_file());

        let mut corrupted = test_invoice_qr_bill(&invoice_id, "Corruption locale").bill;
        corrupted.creditor.name = "Créancier corrompu".into();
        let corrupted_json = serde_json::to_string(&corrupted).unwrap();
        let connection = store.connect().unwrap();
        connection
            .execute_batch("DROP TRIGGER invoice_qr_bills_frozen_no_update;")
            .unwrap();
        connection
            .execute(
                "UPDATE invoice_qr_bills SET input_json=? WHERE invoice_id=?",
                rusqlite::params![corrupted_json, invoice_id],
            )
            .unwrap();
        drop(connection);
        assert!(store
            .get_invoice_qr_bill(&invoice_id)
            .unwrap_err()
            .to_string()
            .contains("créancier"));
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
                task_id: None,
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
        let initial_logo_source = temporary.path().join("logo-initial.png");
        image::DynamicImage::new_rgba8(120, 60)
            .save_with_format(&initial_logo_source, image::ImageFormat::Png)
            .expect("write initial company logo");
        let mut onboarding = test_onboarding();
        onboarding.logo_path = Some(initial_logo_source.to_string_lossy().into_owned());
        onboarding.quote_start_number = Some(7);
        onboarding.invoice_start_number = Some(20);
        onboarding.credit_note_start_number = Some(30);
        onboarding.credit_note_prefix = Some("NC".into());
        store.complete_onboarding(onboarding, "1.0.0").unwrap();
        let initial_logo: String = store
            .connect()
            .unwrap()
            .query_row("SELECT logo_path FROM settings WHERE id=1", [], |row| {
                row.get(0)
            })
            .expect("read managed initial logo");
        assert!(initial_logo.contains("attachments"));
        assert!(initial_logo.contains("branding"));
        enable_accounting(&store);
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
        let quote_snapshot: serde_json::Value =
            serde_json::from_str(quote["snapshot_json"].as_str().unwrap()).unwrap();
        assert_eq!(
            fs::canonicalize(
                quote_snapshot["issuer"]["logo_path"]
                    .as_str()
                    .expect("quote logo path"),
            )
            .unwrap(),
            fs::canonicalize(&initial_logo).unwrap()
        );
        assert_eq!(quote_snapshot["document"]["number"], "D-2026-0007");
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
            fs::canonicalize(
                parsed_snapshot["issuer"]["logo_path"]
                    .as_str()
                    .expect("invoice logo path"),
            )
            .unwrap(),
            fs::canonicalize(&initial_logo).unwrap()
        );
        assert_eq!(parsed_snapshot["issuer"]["noga_section"], "F");
        assert_eq!(parsed_snapshot["issuer"]["noga_division"], "43");
        let modified_logo_source = temporary.path().join("logo-modifie.webp");
        image::DynamicImage::new_rgb8(160, 80)
            .save_with_format(&modified_logo_source, image::ImageFormat::WebP)
            .expect("write replacement company logo");
        let updated_settings = store
            .update_settings(json!({
                "company_name":"Nouvelle raison sociale",
                "logo_path":modified_logo_source.to_string_lossy(),
                "extra_settings_json":{"organization":{"address":{"buildingNumber":"99"}}}
            }))
            .unwrap();
        let modified_logo = updated_settings["logo_path"]
            .as_str()
            .expect("managed replacement logo")
            .to_owned();
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
            fs::canonicalize(
                frozen_snapshot["issuer"]["logo_path"]
                    .as_str()
                    .expect("frozen invoice logo path"),
            )
            .unwrap(),
            fs::canonicalize(&initial_logo).unwrap()
        );
        let credit_id=value_id(&store.create_record("invoices",json!({"client_id":client_id,"original_invoice_id":invoice_id,"title":"Correction","type":"credit_note","service_date_from":"2026-02-01","service_date_to":"2026-02-28"})).unwrap());
        store.create_record("invoice_items",json!({"invoice_id":credit_id,"description":"Correction","quantity":1,"unit":"forfait","unit_price_cents":2500,"vat_bp":0})).unwrap();
        let credit = store
            .issue_invoice(&credit_id, Some("2026-03-02".into()), None)
            .unwrap();
        assert_eq!(credit["number"], "NC-2026-0030");
        assert_eq!(credit["total_cents"], -2500);
        let credit_snapshot: serde_json::Value =
            serde_json::from_str(credit["snapshot_json"].as_str().unwrap()).unwrap();
        assert_eq!(
            fs::canonicalize(
                credit_snapshot["issuer"]["logo_path"]
                    .as_str()
                    .expect("credit note logo path"),
            )
            .unwrap(),
            fs::canonicalize(&modified_logo).unwrap()
        );
        assert_eq!(credit_snapshot["document"]["number"], "NC-2026-0030");
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
            request_id: uuid::Uuid::new_v4().to_string(),
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
                request_id: uuid::Uuid::new_v4().to_string(),
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
    fn catalog_import_is_atomic_case_insensitive_and_preserves_stock_state() {
        fn row(
            row_number: usize,
            sku: &str,
            name: &str,
            kind: &str,
            purchase_cost_cents: i64,
            sales_price_cents: i64,
        ) -> CatalogImportRowInput {
            CatalogImportRowInput {
                row_number,
                sku: sku.into(),
                name: name.into(),
                description: format!("Description {name}"),
                unit: "unité".into(),
                purchase_cost_cents,
                sales_price_cents,
                vat_bp: 810,
                kind: kind.into(),
            }
        }

        let (_temporary, store) = initialized_store();
        let existing_id = value_id(
            &store
                .create_record(
                    "catalog_items",
                    json!({
                        "kind":"product",
                        "sku":"AbC-42",
                        "name":"Ancienne désignation",
                        "description":"Ancienne description",
                        "unit":"pièce",
                        "sales_price_cents":12_000,
                        "purchase_cost_cents":5_000,
                        "vat_bp":0,
                        "track_stock":true,
                        "reorder_level_milli":2_000
                    }),
                )
                .unwrap(),
        );
        store
            .record_stock_entry(StockEntryInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                catalog_item_id: existing_id.clone(),
                quantity_milli: 7_500,
                reason: "Stock à préserver pendant l'import".into(),
                reference: Some("TEST-IMPORT".into()),
                date: Some("2026-09-01".into()),
            })
            .unwrap();
        let archived_at = "2026-09-02T09:00:00Z";
        store
            .update_record(
                "catalog_items",
                &existing_id,
                json!({"archived_at":archived_at}),
            )
            .unwrap();

        let result = store
            .import_catalog_items(ImportCatalogItemsInput {
                conflict_policy: CatalogImportConflictPolicy::Update,
                rows: vec![
                    row(
                        2,
                        "abc-42",
                        "Désignation fournisseur",
                        "product",
                        6_000,
                        14_900,
                    ),
                    row(3, "SVC-9", "Service fournisseur", "service", 0, 25_000),
                ],
            })
            .unwrap();
        assert_eq!(result["received_count"], 2);
        assert_eq!(result["created_count"], 1);
        assert_eq!(result["updated_count"], 1);
        assert_eq!(result["skipped_count"], 0);

        let connection = store.connect().unwrap();
        let updated: (String, String, i64, i64, i64, i64, i64, Option<String>) = connection
            .query_row(
                "SELECT sku,name,purchase_cost_cents,sales_price_cents,track_stock,
                        stock_quantity_milli,reorder_level_milli,archived_at
                   FROM catalog_items WHERE id=?",
                rusqlite::params![existing_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            updated,
            (
                "abc-42".into(),
                "Désignation fournisseur".into(),
                6_000,
                14_900,
                1,
                7_500,
                2_000,
                Some(archived_at.into())
            )
        );
        let created: (String, i64, i64, Option<String>) = connection
            .query_row(
                "SELECT kind,track_stock,stock_quantity_milli,archived_at
                   FROM catalog_items WHERE sku='SVC-9'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(created, ("service".into(), 0, 0, None));
        let audit_payload: String = connection
            .query_row(
                "SELECT payload_json FROM audit_log
                  WHERE action='import' AND entity_type='catalog' ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let audit: serde_json::Value = serde_json::from_str(&audit_payload).unwrap();
        assert_eq!(
            audit
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            [
                "conflict_policy".into(),
                "created_count".into(),
                "received_count".into(),
                "skipped_count".into(),
                "source".into(),
                "updated_count".into(),
            ]
            .into_iter()
            .collect(),
            "l'audit ne conserve ni références, ni noms, ni prix"
        );
        drop(connection);

        let skipped = store
            .import_catalog_items(ImportCatalogItemsInput {
                conflict_policy: CatalogImportConflictPolicy::Skip,
                rows: vec![row(2, "ABC-42", "Valeur à ignorer", "product", 1, 2)],
            })
            .unwrap();
        assert_eq!(skipped["created_count"], 0);
        assert_eq!(skipped["updated_count"], 0);
        assert_eq!(skipped["skipped_count"], 1);
        let unchanged_price: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT sales_price_cents FROM catalog_items WHERE id=?",
                rusqlite::params![existing_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unchanged_price, 14_900);

        for (sku, name) in [("AMB-1", "Doublon A"), ("amb-1", "Doublon B")] {
            store
                .create_record(
                    "catalog_items",
                    json!({"kind":"product","sku":sku,"name":name}),
                )
                .unwrap();
        }
        let ambiguous = store
            .import_catalog_items(ImportCatalogItemsInput {
                conflict_policy: CatalogImportConflictPolicy::Update,
                rows: vec![
                    row(2, "NEW-ATOMIC", "Ne doit pas être créée", "product", 10, 20),
                    row(3, "AmB-1", "Ambiguë", "product", 10, 20),
                ],
            })
            .unwrap_err()
            .to_string();
        assert!(ambiguous.contains("plusieurs fiches"));
        let missing_atomic_row: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM catalog_items WHERE sku='NEW-ATOMIC'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(missing_atomic_row, 0);

        let tracked_kind_change = store
            .import_catalog_items(ImportCatalogItemsInput {
                conflict_policy: CatalogImportConflictPolicy::Update,
                rows: vec![
                    row(
                        2,
                        "ANOTHER-ATOMIC",
                        "Ne doit pas être créée",
                        "product",
                        10,
                        20,
                    ),
                    row(3, "ABC-42", "Service interdit", "service", 10, 20),
                ],
            })
            .unwrap_err()
            .to_string();
        assert!(tracked_kind_change.contains("suivi en stock"));
        let missing_second_atomic_row: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM catalog_items WHERE sku='ANOTHER-ATOMIC'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(missing_second_atomic_row, 0);

        store
            .connect()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER catalog_import_test_failure
                   BEFORE INSERT ON catalog_items WHEN NEW.sku='TRIGGER-FAIL'
                   BEGIN SELECT RAISE(ABORT,'simulated catalog write failure'); END;",
            )
            .unwrap();
        let database_failure = store
            .import_catalog_items(ImportCatalogItemsInput {
                conflict_policy: CatalogImportConflictPolicy::Update,
                rows: vec![
                    row(2, "DB-ATOMIC-FIRST", "Première écriture", "product", 10, 20),
                    row(3, "TRIGGER-FAIL", "Échec simulé", "product", 10, 20),
                ],
            })
            .unwrap_err()
            .to_string();
        assert!(database_failure.contains("simulated catalog write failure"));
        let rolled_back_first_write: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM catalog_items WHERE sku='DB-ATOMIC-FIRST'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rolled_back_first_write, 0);
    }

    #[test]
    fn catalog_import_rejects_invalid_duplicate_and_oversized_payloads() {
        fn row(row_number: usize, sku: String) -> CatalogImportRowInput {
            CatalogImportRowInput {
                row_number,
                sku,
                name: "Article valide".into(),
                description: String::new(),
                unit: "unité".into(),
                purchase_cost_cents: 100,
                sales_price_cents: 200,
                vat_bp: 810,
                kind: "product".into(),
            }
        }

        let (_temporary, store) = initialized_store();
        let duplicate = store
            .import_catalog_items(ImportCatalogItemsInput {
                conflict_policy: CatalogImportConflictPolicy::Update,
                rows: vec![row(2, "Ref-X".into()), row(3, "ref-x".into())],
            })
            .unwrap_err()
            .to_string();
        assert!(duplicate.contains("plusieurs fois"));

        let invalid_money = store
            .import_catalog_items(ImportCatalogItemsInput {
                conflict_policy: CatalogImportConflictPolicy::Update,
                rows: vec![CatalogImportRowInput {
                    sales_price_cents: -1,
                    ..row(2, "INVALIDE".into())
                }],
            })
            .unwrap_err()
            .to_string();
        assert!(invalid_money.contains("plage monétaire sûre"));

        let oversized = store
            .import_catalog_items(ImportCatalogItemsInput {
                conflict_policy: CatalogImportConflictPolicy::Skip,
                rows: (1..=5_001)
                    .map(|index| row(index, format!("SKU-{index}")))
                    .collect(),
            })
            .unwrap_err()
            .to_string();
        assert!(oversized.contains("5000 lignes"));
        let count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM catalog_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn issued_quote_revision_preserves_history_and_returns_an_editable_draft() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client révision"))
                .unwrap(),
        );
        let quote_id = value_id(
            &store
                .create_record(
                    "quotes",
                    json!({
                        "client_id":client_id,
                        "title":"Devis accepté à réviser",
                        "notes":"Périmètre initial",
                        "terms":"Conditions initiales"
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "quote_items",
                json!({
                    "quote_id":quote_id,
                    "description":"Prestation initiale",
                    "quantity":2,
                    "unit":"heure",
                    "unit_price_cents":12_500,
                    "discount_bp":0,
                    "vat_bp":0
                }),
            )
            .unwrap();
        let issued = store
            .issue_quote(
                &quote_id,
                Some("2026-09-01".into()),
                Some("2026-09-30".into()),
            )
            .unwrap();
        store.update_quote_status(&quote_id, "accepted").unwrap();
        let original_number = issued["number"].as_str().unwrap().to_owned();
        let original_snapshot = issued["snapshot_json"].as_str().unwrap().to_owned();

        let request_id = uuid::Uuid::new_v4().to_string();
        let result = store
            .create_quote_revision_with_request_id(&request_id, &quote_id)
            .unwrap();
        let revision_id = result["revision"]["id"].as_str().unwrap().to_owned();
        assert_eq!(result["source"]["status"], "accepte");
        assert_eq!(result["revision"]["number"], json!(null));
        assert_eq!(result["revision"]["status"], "brouillon");
        let expected_issue_date = Local::now().date_naive();
        let expected_valid_until = expected_issue_date
            .checked_add_days(Days::new(30))
            .expect("validité du devis révisé");
        assert_eq!(
            result["revision"]["issue_date"],
            expected_issue_date.format("%Y-%m-%d").to_string()
        );
        assert_eq!(
            result["revision"]["valid_until"],
            expected_valid_until.format("%Y-%m-%d").to_string()
        );
        assert_eq!(result["revision"]["total_cents"], 25_000);
        assert_eq!(result["items"][0]["description"], "Prestation initiale");

        // Une réponse perdue ou un double clic rejoue exactement la réponse
        // validée, y compris l'état de la source avant son annulation.
        let replay = store
            .create_quote_revision_with_request_id(&request_id, &quote_id)
            .unwrap();
        assert_eq!(replay, result);
        let connection = store.connect().unwrap();
        let quote_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM quotes", [], |row| row.get(0))
            .unwrap();
        let request_audit_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE entity_type='quote_revision_request' AND entity_id=?",
                rusqlite::params![request_id],
                |row| row.get(0),
            )
            .unwrap();
        let revision_audit_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE action='create_revision' AND entity_id=?",
                rusqlite::params![revision_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(quote_count, 2);
        assert_eq!(request_audit_count, 1);
        assert_eq!(revision_audit_count, 1);
        drop(connection);

        let mismatched_source = store
            .create_quote_revision_with_request_id(&request_id, &uuid::Uuid::new_v4().to_string())
            .unwrap_err()
            .to_string();
        assert!(mismatched_source.contains("autre révision ou un autre devis"));

        let source_after: (String, String, String) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT number,status,snapshot_json FROM quotes WHERE id=?",
                rusqlite::params![quote_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            source_after,
            (original_number, "annulee".into(), original_snapshot)
        );
        assert_eq!(
            store.update_quote_status(&quote_id, "cancelled").unwrap()["status"],
            "annulee",
            "l'annulation est rejouable sans altérer l'historique"
        );

        let updated = store
            .save_document_with_items(SaveDocumentWithItemsInput {
                entity: "quotes".into(),
                id: Some(revision_id.clone()),
                data: json!({
                    "title":"Devis révisé",
                    "notes":"Périmètre confirmé",
                    "terms":"Conditions révisées"
                }),
                items: vec![json!({
                    "description":"Prestation révisée",
                    "quantity":3,
                    "unit":"heure",
                    "unit_price_cents":12_500,
                    "discount_bp":0,
                    "vat_bp":0
                })],
            })
            .unwrap();
        assert_eq!(updated["document"]["title"], "Devis révisé");
        assert_eq!(updated["document"]["total_cents"], 37_500);
        assert!(store
            .update_record("quotes", &quote_id, json!({"title":"Réécriture interdite"}))
            .is_err());
        assert!(store.delete_record("quotes", &revision_id).unwrap().deleted);
        assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
    }

    #[test]
    fn accepted_quote_cannot_be_cancelled_but_can_be_revised_after_conversion() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client conversion figée"))
                .unwrap(),
        );
        let quote_id = value_id(
            &store
                .create_record(
                    "quotes",
                    json!({"client_id":client_id,"title":"Devis matérialisé"}),
                )
                .unwrap(),
        );
        store
            .create_record(
                "quote_items",
                json!({
                    "quote_id":quote_id,
                    "description":"Service accepté",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":10_000,
                    "discount_bp":0,
                    "vat_bp":0
                }),
            )
            .unwrap();
        store
            .issue_quote(
                &quote_id,
                Some("2026-09-01".into()),
                Some("2026-09-30".into()),
            )
            .unwrap();
        store.update_quote_status(&quote_id, "accepted").unwrap();
        store
            .convert_quote_to_invoice(ConvertQuoteInput {
                quote_id: quote_id.clone(),
                title: None,
                issue_date: None,
                due_date: None,
                service_date_from: Some("2026-09-01".into()),
                service_date_to: Some("2026-09-30".into()),
            })
            .unwrap();

        let cancellation = store
            .update_quote_status(&quote_id, "cancelled")
            .unwrap_err()
            .to_string();
        assert!(cancellation.contains("facture"));
        let revision = store.create_quote_revision(&quote_id).unwrap();
        assert_eq!(revision["revision"]["status"], "brouillon");
        assert_eq!(revision["revision"]["number"], json!(null));
        let status: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT status FROM quotes WHERE id=?",
                rusqlite::params![quote_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "accepte");
    }

    #[test]
    fn accepted_quote_can_be_cancelled_before_any_conversion() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client annulation devis"))
                .unwrap(),
        );
        let quote_id = value_id(
            &store
                .create_record(
                    "quotes",
                    json!({"client_id":client_id,"title":"Devis accepté sans suite"}),
                )
                .unwrap(),
        );
        store
            .create_record(
                "quote_items",
                json!({
                    "quote_id":quote_id,
                    "description":"Prestation annulable",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":15_000,
                    "vat_bp":0
                }),
            )
            .unwrap();
        store
            .issue_quote(
                &quote_id,
                Some("2026-09-01".into()),
                Some("2026-10-01".into()),
            )
            .unwrap();
        assert_eq!(
            store.update_quote_status(&quote_id, "accepted").unwrap()["status"],
            "accepte"
        );
        assert_eq!(
            store.update_quote_status(&quote_id, "cancelled").unwrap()["status"],
            "annulee"
        );
        assert_eq!(
            store.update_quote_status(&quote_id, "cancelled").unwrap()["status"],
            "annulee",
            "une reprise après interruption reste idempotente"
        );
        assert!(store
            .update_quote_status(&quote_id, "accepted")
            .unwrap_err()
            .to_string()
            .contains("Transition de statut interdite"));
    }

    #[test]
    fn customer_documents_are_numbered_once_and_listed_newest_first() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client chronologie"))
                .unwrap(),
        );
        let first_invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture ancienne",
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
                    "invoice_id":first_invoice_id,
                    "description":"Prestation août",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":10_000,
                    "discount_bp":0,
                    "vat_bp":0
                }),
            )
            .unwrap();
        let first = store
            .issue_invoice(
                &first_invoice_id,
                Some("2026-09-01".into()),
                Some("2026-09-30".into()),
            )
            .unwrap();

        let second_invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture récente",
                        "service_date_from":"2026-09-01",
                        "service_date_to":"2026-09-30"
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":second_invoice_id,
                    "description":"Prestation septembre",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":20_000,
                    "discount_bp":0,
                    "vat_bp":0
                }),
            )
            .unwrap();
        let second = store
            .issue_invoice(
                &second_invoice_id,
                Some("2026-09-02".into()),
                Some("2026-10-02".into()),
            )
            .unwrap();
        assert_eq!(first["number"], "F-2026-0001");
        assert_eq!(second["number"], "F-2026-0002");
        assert_ne!(first["number"], second["number"]);
        assert_eq!(
            store
                .issue_invoice(
                    &first_invoice_id,
                    Some("2026-09-03".into()),
                    Some("2026-10-03".into()),
                )
                .unwrap()["number"],
            "F-2026-0001",
            "une nouvelle tentative d'émission conserve la référence attribuée"
        );

        let first_quote_id = value_id(
            &store
                .create_record(
                    "quotes",
                    json!({"client_id":client_id,"title":"Devis ancien"}),
                )
                .unwrap(),
        );
        store
            .create_record(
                "quote_items",
                json!({
                    "quote_id":first_quote_id,
                    "description":"Ancienne proposition",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":1_000,
                    "vat_bp":0
                }),
            )
            .unwrap();
        store
            .issue_quote(
                &first_quote_id,
                Some("2026-09-01".into()),
                Some("2026-10-01".into()),
            )
            .unwrap();
        let second_quote_id = value_id(
            &store
                .create_record(
                    "quotes",
                    json!({"client_id":client_id,"title":"Devis récent"}),
                )
                .unwrap(),
        );
        store
            .create_record(
                "quote_items",
                json!({
                    "quote_id":second_quote_id,
                    "description":"Nouvelle proposition",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":2_000,
                    "vat_bp":0
                }),
            )
            .unwrap();
        store
            .issue_quote(
                &second_quote_id,
                Some("2026-09-02".into()),
                Some("2026-10-02".into()),
            )
            .unwrap();

        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["invoices"][0]["id"], second_invoice_id);
        assert_eq!(workspace["invoices"][1]["id"], first_invoice_id);
        assert_eq!(workspace["quotes"][0]["id"], second_quote_id);
        assert_eq!(workspace["quotes"][1]["id"], first_quote_id);
        let connection = store.connect().unwrap();
        let unique_index: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_index_list('invoices') WHERE name='idx_invoices_number' AND \"unique\"=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unique_index, 1);
    }

    #[test]
    fn accepted_quote_conversion_is_atomic_and_unique() {
        let (_temporary, store) = initialized_store();
        let catalog_item = store
            .create_record(
                "catalog_items",
                json!({
                    "kind":"product",
                    "sku":"MAT-001",
                    "name":"Matériel catalogue",
                    "description":"Description d'origine",
                    "unit":"heure",
                    "sales_price_cents":8_000,
                    "purchase_cost_cents":3_500,
                    "vat_bp":0,
                    "track_stock":true,
                    "stock_quantity_milli":0,
                    "reorder_level_milli":2_000
                }),
            )
            .unwrap();
        let catalog_item_id = value_id(&catalog_item);
        assert_eq!(catalog_item["track_stock"], true);
        assert_eq!(catalog_item["stock_quantity_milli"], 0);
        let opening = store
            .record_stock_entry(StockEntryInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                catalog_item_id: catalog_item_id.clone(),
                quantity_milli: 12_500,
                reason: "Stock initial du test catalogue".into(),
                reference: Some("TEST-CATALOGUE".into()),
                date: Some("2026-01-01".into()),
            })
            .unwrap();
        assert_eq!(opening["catalog_item"]["stock_quantity_milli"], 12_500);
        assert!(store
            .create_record(
                "catalog_items",
                json!({"kind":"other","name":"Article invalide"}),
            )
            .unwrap_err()
            .to_string()
            .contains("product ou service"));
        assert!(store
            .create_record(
                "catalog_items",
                json!({"kind":"service","name":"Prix invalide","sales_price_cents":-1}),
            )
            .is_err());
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client conversion"))
                .unwrap(),
        );
        let conversion_item_id = value_id(
            &store
                .create_record(
                    "catalog_items",
                    json!({
                        "kind":"service",
                        "name":"Prestation conversion",
                        "unit":"heure",
                        "sales_price_cents":8_000,
                        "track_stock":false
                    }),
                )
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
        store.create_record("quote_items",json!({"quote_id":quote_id,"catalog_item_id":conversion_item_id,"description":"Lot accepté","quantity":2,"unit":"heure","unit_price_cents":8000,"discount_bp":1250,"vat_bp":0})).unwrap();
        let archived_at = "2026-03-15T12:30:00Z";
        let archived_catalog_item = store
            .update_record(
                "catalog_items",
                &catalog_item_id,
                json!({
                    "name":"Matériel catalogue renommé",
                    "sales_price_cents":9_500,
                    "archived_at":archived_at
                }),
            )
            .unwrap();
        assert_eq!(archived_catalog_item["archived_at"], archived_at);
        let workspace = store.get_workspace().unwrap();
        assert_eq!(
            workspace["catalog_items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == catalog_item_id)
                .unwrap()["name"],
            "Matériel catalogue renommé"
        );
        assert_eq!(
            workspace["quote_items"][0]["catalog_item_id"],
            conversion_item_id
        );
        assert_eq!(workspace["quote_items"][0]["description"], "Lot accepté");
        assert_eq!(workspace["quote_items"][0]["unit_price_cents"], 8_000);
        assert_eq!(workspace["quote_items"][0]["discount_bp"], 1_250);
        assert_eq!(workspace["quote_items"][0]["line_net_cents"], 14_000);
        assert!(
            store
                .delete_record("catalog_items", &catalog_item_id)
                .is_err(),
            "un article utilisé doit être archivé, jamais supprimé au détriment de ses références"
        );
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
        assert_eq!(
            converted["invoice_items"][0]["catalog_item_id"],
            conversion_item_id
        );
        assert_eq!(converted["invoice_items"][0]["description"], "Lot accepté");
        assert_eq!(converted["invoice_items"][0]["unit_price_cents"], 8_000);
        assert_eq!(converted["invoice_items"][0]["discount_bp"], 1_250);
        assert_eq!(converted["invoice_items"][0]["line_net_cents"], 14_000);
        assert!(store.convert_quote_to_invoice(input).is_err());
        let count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM invoices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn suppliers_and_pending_expenses_preserve_the_supplier_snapshot() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        assert!(store
            .create_record("suppliers", json!({"name":"  "}))
            .is_err());
        assert!(store
            .create_record(
                "suppliers",
                json!({"name":"Devise invalide","currency":"EUR"}),
            )
            .unwrap_err()
            .to_string()
            .contains("CHF"));
        assert!(store
            .create_record(
                "suppliers",
                json!({"name":"Délai invalide","payment_terms_days":-1}),
            )
            .is_err());
        assert!(store
            .create_record(
                "suppliers",
                json!({"name":"IBAN invalide","iban":"CH00 INVALID"}),
            )
            .unwrap_err()
            .to_string()
            .contains("IBAN CH ou LI"));

        let supplier = store
            .create_record(
                "suppliers",
                json!({
                    "name":"Matériaux Léman SA",
                    "contact_name":"Service achats",
                    "email":"achats@example.invalid",
                    "phone":"+41 21 000 00 00",
                    "address":"Rue du Test 4, 1000 Lausanne",
                    "uid_number":"CHE-000.000.000",
                    "iban":"CH44 3199 9123 0008 8901 2",
                    "currency":"chf",
                    "payment_terms_days":30,
                    "notes":"Fournisseur principal"
                }),
            )
            .unwrap();
        let supplier_id = value_id(&supplier);
        assert_eq!(supplier["currency"], "CHF");
        assert_eq!(supplier["iban"], "CH4431999123000889012");

        for invalid in [
            json!({
                "date":"2026-09-01",
                "supplier_id":supplier_id,
                "payment_status":"pending",
                "net_cents":100,
                "vat_cents":0
            }),
            json!({
                "date":"2026-09-01",
                "due_date":"2026-09-30",
                "supplier_id":supplier_id,
                "payment_status":"pending",
                "paid_at":"2026-09-10",
                "net_cents":100,
                "vat_cents":0
            }),
            json!({
                "date":"2026-09-01",
                "due_date":"2026-08-31",
                "supplier_id":supplier_id,
                "payment_status":"pending",
                "net_cents":100,
                "vat_cents":0
            }),
            json!({
                "date":"2026-09-01",
                "currency":"EUR",
                "net_cents":100,
                "vat_cents":0
            }),
        ] {
            assert!(store.create_record("expenses", invalid).is_err());
        }

        let expense = store
            .create_record(
                "expenses",
                json!({
                    "supplier_id":supplier_id,
                    "date":"2026-09-01",
                    "due_date":"2026-09-30",
                    "category":"Matériaux",
                    "reference":"ACH-2026-001",
                    "currency":"CHF",
                    "net_cents":10_000,
                    "vat_cents":810,
                    "payment_status":"pending"
                }),
            )
            .unwrap();
        let expense_id = value_id(&expense);
        assert_eq!(expense["project_id"], json!(null));
        assert_eq!(expense["supplier_id"], supplier_id);
        assert_eq!(expense["supplier"], "Matériaux Léman SA");
        assert_eq!(expense["total_cents"], 10_810);
        assert_eq!(expense["payment_status"], "pending");
        assert_eq!(expense["paid_at"], json!(null));

        let archived_at = "2026-09-05T08:30:00Z";
        store
            .update_record(
                "suppliers",
                &supplier_id,
                json!({
                    "name":"Matériaux Léman Romandie SA",
                    "archived_at":archived_at
                }),
            )
            .unwrap();
        let workspace = store.get_workspace().unwrap();
        assert_eq!(
            workspace["suppliers"][0]["name"],
            "Matériaux Léman Romandie SA"
        );
        assert_eq!(workspace["suppliers"][0]["archived_at"], archived_at);
        assert_eq!(workspace["expenses"][0]["supplier"], "Matériaux Léman SA");
        assert!(store.delete_record("suppliers", &supplier_id).is_err());

        let paid = store
            .update_record(
                "expenses",
                &expense_id,
                json!({"payment_status":"paid","paid_at":"2026-09-20"}),
            )
            .unwrap();
        assert_eq!(paid["payment_status"], "paid");
        assert_eq!(paid["paid_at"], "2026-09-20");
        assert_eq!(paid["supplier"], "Matériaux Léman SA");
    }

    #[test]
    fn supplier_invoice_lifecycle_is_atomic_immutable_and_idempotent() {
        let (temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let supplier_id = value_id(
            &store
                .create_record(
                    "suppliers",
                    json!({"name":"Fournisseur factures SA","payment_terms_days":30}),
                )
                .unwrap(),
        );
        let draft_id = "8d013d0a-0b24-4a70-a7a2-aec24e8e3101";
        let input = SaveSupplierInvoiceDraftInput {
            id: Some(draft_id.into()),
            supplier_id: supplier_id.clone(),
            project_id: None,
            date: "2026-09-01".into(),
            due_date: "2026-09-30".into(),
            reference: Some("FAC 2026-001".into()),
            note: Some("Commande réelle".into()),
            items: vec![SupplierInvoiceLineInput {
                id: Some("1d4e2139-f466-4303-8de8-6b285cc85303".into()),
                description: "Matériel".into(),
                quantity_milli: 2_000,
                unit: Some("pièce".into()),
                unit_price_cents: 5_000,
                discount_bp: 0,
                vat_bp: 0,
                category: "Matériaux".into(),
                expense_account_id: None,
                project_id: None,
            }],
        };
        let draft = store.save_supplier_invoice_draft(input.clone()).unwrap();
        assert_eq!(draft["invoice"]["status"], "draft");
        assert_eq!(draft["invoice"]["total_cents"], 10_000);
        assert_eq!(draft["items"].as_array().unwrap().len(), 1);

        let retried = store.save_supplier_invoice_draft(input.clone()).unwrap();
        assert_eq!(retried["invoice"]["id"], draft_id);
        let draft_count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM supplier_invoices WHERE id=?",
                rusqlite::params![draft_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(draft_count, 1);
        let draft_audit_count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE entity_type='supplier_invoice_draft' AND entity_id=?",
                rusqlite::params![draft_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            draft_audit_count, 1,
            "rejouer le même brouillon ne doit ni réécrire ni réauditer"
        );

        let mut duplicate_draft = input.clone();
        duplicate_draft.id = Some("c62fc9aa-30e4-42d7-b034-d57590df6d26".into());
        let duplicate_error = store
            .save_supplier_email_invoice_draft(duplicate_draft)
            .unwrap_err();
        assert!(duplicate_error
            .to_string()
            .contains("référence existe déjà"));

        let source_attachment = temporary.path().join("supplier-invoice.pdf");
        std::fs::write(&source_attachment, crate::attachments::test_pdf_bytes()).unwrap();
        let attachment = store
            .add_supplier_invoice_attachment(AddSupplierInvoiceAttachmentInput {
                supplier_invoice_id: draft_id.into(),
                source_path: source_attachment.to_string_lossy().into_owned(),
            })
            .unwrap();
        let attachment_id = value_id(&attachment);
        let attachment_stored_name = attachment["stored_name"].as_str().unwrap().to_owned();
        let attachment_path = store.attachments_dir.join(&attachment_stored_name);
        assert!(attachment_path.is_file());
        assert_eq!(attachment["mime_type"], "application/pdf");
        assert_eq!(attachment["sha256"].as_str().unwrap().len(), 64);

        let duplicate_attachment = store
            .add_supplier_invoice_attachment(AddSupplierInvoiceAttachmentInput {
                supplier_invoice_id: draft_id.into(),
                source_path: source_attachment.to_string_lossy().into_owned(),
            })
            .unwrap();
        assert_eq!(duplicate_attachment["id"], attachment_id);
        let attachment_count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=?",
                rusqlite::params![draft_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attachment_count, 1);

        let disposable_id = "2f424a0e-f6fd-479c-9948-3356e2427c5c";
        store
            .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
                id: Some(disposable_id.into()),
                reference: None,
                items: vec![SupplierInvoiceLineInput {
                    id: Some("9a6ad5db-6db5-440a-a703-b3fc5c49dfe3".into()),
                    ..input.items[0].clone()
                }],
                ..input.clone()
            })
            .unwrap();
        let disposable_source = temporary.path().join("disposable.pdf");
        std::fs::write(&disposable_source, crate::attachments::test_pdf_bytes()).unwrap();
        let disposable_attachment = store
            .add_supplier_invoice_attachment(AddSupplierInvoiceAttachmentInput {
                supplier_invoice_id: disposable_id.into(),
                source_path: disposable_source.to_string_lossy().into_owned(),
            })
            .unwrap();
        let disposable_attachment_path = store
            .attachments_dir
            .join(disposable_attachment["stored_name"].as_str().unwrap());
        assert!(disposable_attachment_path.is_file());
        store.delete_supplier_invoice_draft(disposable_id).unwrap();
        let disposable_rows: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM supplier_invoices WHERE id=?1) + (SELECT COUNT(*) FROM supplier_invoice_items WHERE supplier_invoice_id=?1) + (SELECT COUNT(*) FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=?1)",
                rusqlite::params![disposable_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(disposable_rows, 0);
        assert!(!disposable_attachment_path.exists());

        let validated = store.validate_supplier_invoice(draft_id).unwrap();
        assert_eq!(validated["invoice"]["status"], "validated");
        let connection = store.connect().unwrap();
        let snapshot_json: String = connection
            .query_row(
                "SELECT snapshot_json FROM supplier_invoices WHERE id=?",
                rusqlite::params![draft_id],
                |row| row.get(0),
            )
            .unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot_json).unwrap();
        assert_eq!(snapshot["attachments"][0]["id"], attachment_id);
        assert_eq!(
            snapshot["attachments"][0]["original_name"],
            "supplier-invoice.pdf"
        );
        assert!(snapshot["attachments"][0]["sha256"].is_string());
        assert!(snapshot["attachments"][0].get("stored_name").is_none());
        let postings: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM journal_entries WHERE source_type='supplier_invoice' AND source_id=?1 AND source_event='validate'),
                   (SELECT COALESCE(SUM(line.debit_cents),0) FROM journal_lines line JOIN journal_entries entry ON entry.id=line.journal_entry_id WHERE entry.source_type='supplier_invoice' AND entry.source_id=?1 AND line.account_id=?2),
                   (SELECT COALESCE(SUM(line.credit_cents),0) FROM journal_lines line JOIN journal_entries entry ON entry.id=line.journal_entry_id WHERE entry.source_type='supplier_invoice' AND entry.source_id=?1 AND line.account_id=?3)",
                rusqlite::params![draft_id, accounts["expense"], accounts["supplier_payable"]],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(postings, (1, 10_000, 10_000));
        assert!(connection
            .execute(
                "UPDATE attachments SET original_name='altéré.pdf' WHERE id=?",
                rusqlite::params![attachment_id],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM attachments WHERE id=?",
                rusqlite::params![attachment_id],
            )
            .is_err());
        drop(connection);
        assert!(store.save_supplier_invoice_draft(input.clone()).is_err());
        assert!(store.delete_supplier_invoice_draft(draft_id).is_err());
        assert!(store
            .delete_supplier_invoice_attachment(&attachment_id)
            .is_err());
        assert_eq!(
            store.verified_attachment_path(&attachment_id).unwrap(),
            attachment_path
        );
        std::fs::write(&attachment_path, b"%PDF-1.7\nfake payload").unwrap();
        assert!(store.verified_attachment_path(&attachment_id).is_err());

        let duplicate_id = "e9dc781b-edf4-4fd1-a19d-12ae3041e8f8";
        store
            .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
                id: Some(duplicate_id.into()),
                reference: Some("fac-2026/001".into()),
                items: vec![SupplierInvoiceLineInput {
                    id: Some("bdb10d14-a2c7-463d-8961-e89112f5de08".into()),
                    ..input.items[0].clone()
                }],
                ..input.clone()
            })
            .unwrap();
        assert!(store
            .validate_supplier_invoice(duplicate_id)
            .unwrap_err()
            .to_string()
            .contains("même référence"));

        let replacement_payable = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "2003".into(),
                    name: "Dettes fournisseurs futures".into(),
                    account_type: "liability".into(),
                    normal_balance: "credit".into(),
                    report_section: "short_term_liabilities".into(),
                    active: true,
                })
                .unwrap(),
        );
        store
            .configure_accounting(AccountingSettingsInput {
                enabled: true,
                ar_account_id: Some(accounts["ar"].clone()),
                revenue_account_id: Some(accounts["revenue"].clone()),
                vat_payable_account_id: Some(accounts["vat_payable"].clone()),
                vat_deferred_payable_account_id: Some(accounts["vat_deferred_payable"].clone()),
                bank_account_id: Some(accounts["bank"].clone()),
                expense_account_id: Some(accounts["expense"].clone()),
                vat_receivable_account_id: Some(accounts["vat_receivable"].clone()),
                wages_expense_account_id: Some(accounts["wages_expense"].clone()),
                wages_payable_account_id: Some(accounts["wages_payable"].clone()),
                social_expense_account_id: Some(accounts["social_expense"].clone()),
                social_payable_account_id: Some(accounts["social_payable"].clone()),
                supplier_payable_account_id: Some(replacement_payable),
            })
            .unwrap();

        let request_id = "81aff63d-9519-47f2-bfcc-861be2b87952";
        let partial_input = RecordSupplierPaymentInput {
            request_id: request_id.into(),
            supplier_invoice_id: draft_id.into(),
            amount_cents: 4_000,
            date: "2026-09-15".into(),
            method: Some("bank_transfer".into()),
            reference: Some("VIR-001".into()),
            notes: None,
        };
        let partial = store
            .record_supplier_payment(partial_input.clone())
            .unwrap();
        assert_eq!(partial["document"]["invoice"]["paid_cents"], 4_000);
        assert_eq!(partial["idempotent"], false);
        let retry = store.record_supplier_payment(partial_input).unwrap();
        assert_eq!(retry["idempotent"], true);
        let connection = store.connect().unwrap();
        let payment_posting: (i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM supplier_payments WHERE request_id=?1),
                   (SELECT COALESCE(SUM(line.debit_cents),0) FROM journal_lines line JOIN journal_entries entry ON entry.id=line.journal_entry_id WHERE entry.source_type='supplier_payment' AND line.account_id=?2)",
                rusqlite::params![request_id, accounts["supplier_payable"]],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(payment_posting, (1, 4_000));
        drop(connection);

        assert!(store
            .record_supplier_payment(RecordSupplierPaymentInput {
                request_id: "f50b948a-6d83-43ea-a453-50fdd6fce2df".into(),
                supplier_invoice_id: draft_id.into(),
                amount_cents: 6_001,
                date: "2026-09-20".into(),
                method: None,
                reference: None,
                notes: None,
            })
            .unwrap_err()
            .to_string()
            .contains("dépasse le solde"));
        assert!(store
            .record_supplier_payment(RecordSupplierPaymentInput {
                request_id: "5bb406df-0732-4e9e-84bd-79b97b5d1de6".into(),
                supplier_invoice_id: draft_id.into(),
                amount_cents: 1_000,
                date: "2026-08-31".into(),
                method: None,
                reference: None,
                notes: None,
            })
            .is_err());

        let paid = store
            .record_supplier_payment(RecordSupplierPaymentInput {
                request_id: "f91c807c-2e7a-46e7-82f1-469549084b2b".into(),
                supplier_invoice_id: draft_id.into(),
                amount_cents: 6_000,
                date: "2026-09-20".into(),
                method: Some("bank_transfer".into()),
                reference: Some("VIR-002".into()),
                notes: None,
            })
            .unwrap();
        assert_eq!(paid["document"]["invoice"]["paid_cents"], 10_000);
        let continuity = store.get_accounting_continuity().unwrap();
        assert_eq!(continuity["missing_supplier_invoices"], 0);
        assert_eq!(continuity["missing_supplier_payments"], 0);
        assert_eq!(continuity["semantic_posting_mismatches"], 0);
    }

    #[test]
    fn supplier_invoice_and_payment_respect_closed_periods() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let supplier_id = value_id(
            &store
                .create_record("suppliers", json!({"name":"Fournisseur clôture SA"}))
                .unwrap(),
        );
        let make_input = |id: &str, date: &str, reference: &str| SaveSupplierInvoiceDraftInput {
            id: Some(id.into()),
            supplier_id: supplier_id.clone(),
            project_id: None,
            date: date.into(),
            due_date: date.into(),
            reference: Some(reference.into()),
            note: None,
            items: vec![SupplierInvoiceLineInput {
                id: Some(uuid::Uuid::new_v4().to_string()),
                description: "Charge".into(),
                quantity_milli: 1_000,
                unit: Some("forfait".into()),
                unit_price_cents: 5_000,
                discount_bp: 0,
                vat_bp: 0,
                category: "Charges".into(),
                expense_account_id: None,
                project_id: None,
            }],
        };

        // Cette facture est validée avant la clôture afin de vérifier ensuite
        // qu'un paiement rétroactif est refusé sans rendre le document source
        // artificiellement impossible à valider sous la borne cumulative.
        let september_id = "2575f352-bfce-4c63-8745-995a4e0bd15a";
        store
            .save_supplier_invoice_draft(make_input(september_id, "2026-09-10", "SEP-1"))
            .unwrap();
        store.validate_supplier_invoice(september_id).unwrap();

        let october_id = "64bb3e84-fd2f-4d8b-843d-50ee8fd67791";
        store
            .save_supplier_invoice_draft(make_input(october_id, "2026-10-10", "OCT-1"))
            .unwrap();
        let october_period = value_id(
            &store
                .upsert_accounting_period(AccountingPeriodInput {
                    id: None,
                    name: "Octobre 2026".into(),
                    date_from: "2026-10-01".into(),
                    date_to: "2026-10-31".into(),
                })
                .unwrap(),
        );
        store.close_accounting_period(&october_period).unwrap();
        assert!(store.validate_supplier_invoice(october_id).is_err());
        let connection = store.connect().unwrap();
        let october_state: (String, i64) = connection
            .query_row(
                "SELECT status,(SELECT COUNT(*) FROM journal_entries WHERE source_type='supplier_invoice' AND source_id=?1) FROM supplier_invoices WHERE id=?1",
                rusqlite::params![october_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(october_state, ("draft".into(), 0));
        drop(connection);

        assert!(store
            .record_supplier_payment(RecordSupplierPaymentInput {
                request_id: "6264e3cc-5b95-4bd1-b50a-9552361a158f".into(),
                supplier_invoice_id: september_id.into(),
                amount_cents: 5_000,
                date: "2026-10-15".into(),
                method: Some("bank_transfer".into()),
                reference: None,
                notes: None,
            })
            .is_err());
        let connection = store.connect().unwrap();
        let payment_state: (i64, i64) = connection
            .query_row(
                "SELECT paid_cents,(SELECT COUNT(*) FROM supplier_payments WHERE supplier_invoice_id=?1) FROM supplier_invoices WHERE id=?1",
                rusqlite::params![september_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(payment_state, (0, 0));
    }

    #[test]
    fn pending_expense_posts_exactly_once_when_marked_paid() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let pending = store
            .create_record(
                "expenses",
                json!({
                    "date":"2026-10-01",
                    "due_date":"2026-10-31",
                    "supplier":"Fournisseur à payer",
                    "currency":"CHF",
                    "net_cents":10_000,
                    "vat_cents":810,
                    "payment_status":"pending"
                }),
            )
            .unwrap();
        let expense_id = value_id(&pending);
        let connection = store.connect().unwrap();
        let entries_before: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM journal_entries WHERE source_type='expense' AND source_id=?",
                rusqlite::params![expense_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(entries_before, 0);
        let bank_credit_before: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(jl.credit_cents),0) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE je.source_type='expense' AND je.source_id=? AND jl.account_id=?",
                rusqlite::params![expense_id, accounts["bank"]],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bank_credit_before, 0);
        drop(connection);

        store
            .update_record(
                "expenses",
                &expense_id,
                json!({"payment_status":"paid","paid_at":"2026-10-20"}),
            )
            .unwrap();
        let connection = store.connect().unwrap();
        let (entries_after, bank_credit_after, entry_date): (i64, i64, String) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM journal_entries WHERE source_type='expense' AND source_id=?1),
                   (SELECT COALESCE(SUM(jl.credit_cents),0) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE je.source_type='expense' AND je.source_id=?1 AND jl.account_id=?2),
                   (SELECT entry_date FROM journal_entries WHERE source_type='expense' AND source_id=?1)",
                rusqlite::params![expense_id, accounts["bank"]],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(entries_after, 1);
        assert_eq!(bank_credit_after, 10_810);
        assert_eq!(entry_date, "2026-10-20");
        drop(connection);
        assert!(store
            .update_record("expenses", &expense_id, json!({"note":"Tentative double"}))
            .is_err());
        let final_count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM journal_entries WHERE source_type='expense' AND source_id=?",
                rusqlite::params![expense_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(final_count, 1);
    }

    #[test]
    fn automatic_accounting_entries_are_balanced_and_reports_execute() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client comptable"))
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
        let payment_request = RecordPaymentInput {
            request_id: "f2f0cc34-f7b5-4a1f-943e-89149e59bd43".into(),
            invoice_id: invoice_id.clone(),
            amount_cents: 4000,
            date: Some("2026-07-05".into()),
            method: Some("bank".into()),
            reference: None,
            notes: None,
        };
        let payment = store.record_payment(payment_request.clone()).unwrap();
        let retried_payment = store.record_payment(payment_request.clone()).unwrap();
        assert_eq!(payment["id"], retried_payment["id"]);
        let mut conflicting_retry = payment_request;
        conflicting_retry.amount_cents = 3_999;
        assert!(store
            .record_payment(conflicting_retry)
            .unwrap_err()
            .to_string()
            .contains("identifiant de reprise"));
        store.create_record("expenses",json!({"date":"2026-07-06","supplier":"Fournisseur","net_cents":1000,"vat_cents":0,"total_cents":1000})).unwrap();
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Employé comptable"}))
                .unwrap(),
        );
        let aap_selection = configure_minor_test_payroll(&store, &employee_id, 500_000);
        let mut payroll_lines = Vec::new();
        for (position, kind, amount) in [
            (0, "earning", 500000),
            (1, "deduction", 50000),
            (2, "employer", 30000),
        ] {
            let (posting_account_id, expense_account_id) = match kind {
                "deduction" => (Some(accounts["social_payable"].clone()), None),
                "employer" => (
                    Some(accounts["social_payable"].clone()),
                    Some(accounts["social_expense"].clone()),
                ),
                _ => (None, None),
            };
            payroll_lines.push(PayslipManualLineInput {
                id: None,
                label: format!("Ligne {position}"),
                kind: kind.into(),
                amount_cents: amount,
                posting_account_id,
                expense_account_id,
            });
        }
        let saved = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id,
                period: "2026-07".into(),
                status: "valide".into(),
                payment_date: None,
                notes: None,
                lines: payroll_lines,
                contributions: vec![aap_selection],
            })
            .unwrap();
        let payslip_id = value_id(&saved["payslip"]);
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
        assert!(payslip_snapshot["issuer"]["logo_path"].is_null());
        assert_eq!(payslip_snapshot["issuer"]["noga_division"], "43");
        let connection = store.connect().unwrap();
        let payment_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM payments WHERE invoice_id=?",
                rusqlite::params![invoice_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment_count, 1);
        let payment_entry_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM journal_entries WHERE source_type='payment' AND source_id=?",
                rusqlite::params![payment["id"].as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment_entry_count, 1);
        let payment_lines: (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT SUM(CASE WHEN account_id=? THEN debit_cents ELSE 0 END),SUM(CASE WHEN account_id=? THEN credit_cents ELSE 0 END),SUM(debit_cents),SUM(credit_cents) FROM journal_lines WHERE journal_entry_id=(SELECT id FROM journal_entries WHERE source_type='payment' AND source_id=?)",
                rusqlite::params![accounts["bank"], accounts["ar"], payment["id"].as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(payment_lines, (4000, 4000, 4000, 4000));
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
        let reversal_retry = store
            .reverse_journal_entry(&expense_entry, "2026-07-07", None)
            .unwrap();
        assert_eq!(reversal_retry["id"], reversal["id"]);
        assert!(store
            .reverse_journal_entry(&expense_entry, "2026-07-08", None)
            .unwrap_err()
            .to_string()
            .contains("diffèrent"));
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
        let balance = store
            .get_balance_sheet(PeriodFilter {
                date_from: Some("2026-01-01".into()),
                date_to: Some("2026-12-31".into()),
            })
            .unwrap();
        assert!(balance["sections"].is_object());
    }

    #[test]
    fn received_vat_is_deferred_then_reclassified_on_each_payment_and_credit_note() {
        let (_temporary, store) = initialized_store();
        store
            .update_settings(json!({
                "vat_registered":true,
                "default_vat_bp":810,
                "uid_number":"CHE-123.456.789",
                "vat_number":"CHE-123.456.789 TVA"
            }))
            .unwrap();
        let accounts = enable_accounting(&store);
        store
            .create_vat_profile(VatProfileInput {
                id: Some("received-accounting-2026".into()),
                effective_from: "2026-01-01".into(),
                effective_to: None,
                reporting_method: "effective".into(),
                form_of_reporting: "received".into(),
                periodicity: "quarterly".into(),
                gross_or_net: "net".into(),
                tdfn_activity_id: None,
                tdfn_rate_bp: None,
                afc_authorization_confirmed: true,
                notes: Some("Autorisation AFC confirmée pour le test".into()),
                close_previous_open_profile: false,
            })
            .unwrap();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client TVA reçue"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture TVA sur encaissements",
                        "service_date_from":"2026-02-01",
                        "service_date_to":"2026-02-01"
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":invoice_id,
                    "description":"Prestation imposable",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":10_000,
                    "vat_bp":810
                }),
            )
            .unwrap();
        store
            .issue_invoice(&invoice_id, Some("2026-02-01".into()), None)
            .unwrap();

        let first_payment = RecordPaymentInput {
            request_id: "296f7196-3cd8-4d99-8a20-209578d49696".into(),
            invoice_id: invoice_id.clone(),
            amount_cents: 5_405,
            date: Some("2026-02-15".into()),
            method: Some("bank".into()),
            reference: None,
            notes: None,
        };
        store.record_payment(first_payment.clone()).unwrap();
        store
            .record_payment(RecordPaymentInput {
                request_id: "9d39d2de-b03f-4612-a75d-dda8d5eb76a6".into(),
                invoice_id: invoice_id.clone(),
                amount_cents: 5_405,
                date: Some("2026-04-15".into()),
                method: Some("bank".into()),
                reference: None,
                notes: None,
            })
            .unwrap();
        store.record_payment(first_payment.clone()).unwrap();

        let connection = store.connect().unwrap();
        let issue_vat: (i64, i64) = connection
            .query_row(
                "SELECT
                   COALESCE(SUM(CASE WHEN line.account_id=?2 THEN line.credit_cents ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN line.account_id=?3 THEN line.credit_cents ELSE 0 END),0)
                 FROM journal_entries entry JOIN journal_lines line ON line.journal_entry_id=entry.id
                 WHERE entry.source_type='invoice' AND entry.source_id=?1 AND entry.source_event='issue'",
                rusqlite::params![invoice_id, accounts["vat_deferred_payable"], accounts["vat_payable"]],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(issue_vat, (810, 0));
        let allocations = connection
            .prepare(
                "SELECT entry.entry_date,line.debit_cents
                   FROM journal_entries entry
                   JOIN journal_lines line ON line.journal_entry_id=entry.id AND line.memo='Reclassement TVA à régulariser'
                  WHERE entry.source_type='vat_cash_reclassification'
                  ORDER BY entry.entry_date,entry.created_at,entry.id",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            allocations,
            vec![("2026-02-15".into(), 405), ("2026-04-15".into(), 405)]
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM journal_entries WHERE source_type='vat_cash_reclassification'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2,
            "la reprise du premier paiement ne doit créer aucune reclassification supplémentaire"
        );
        drop(connection);

        let credit_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "original_invoice_id":invoice_id,
                        "title":"Avoir après encaissement",
                        "type":"credit_note",
                        "service_date_from":"2026-05-01",
                        "service_date_to":"2026-05-01"
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":credit_id,
                    "description":"Correction imposable",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":5_000,
                    "vat_bp":810
                }),
            )
            .unwrap();
        store
            .issue_invoice(&credit_id, Some("2026-05-01".into()), None)
            .unwrap();
        let connection = store.connect().unwrap();
        let vat_balances: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                   COALESCE(SUM(CASE WHEN line.account_id=?1 THEN line.credit_cents-line.debit_cents ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN line.account_id=?2 THEN line.credit_cents-line.debit_cents ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN entry.source_type='invoice' AND entry.source_id=?3 AND line.memo='Extourne TVA due encaissée' THEN line.debit_cents ELSE 0 END),0)
                 FROM journal_entries entry JOIN journal_lines line ON line.journal_entry_id=entry.id",
                rusqlite::params![accounts["vat_deferred_payable"], accounts["vat_payable"], credit_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(vat_balances, (0, 405, 405));
        drop(connection);
        let continuity = store.get_accounting_continuity().unwrap();
        assert_eq!(continuity["semantic_posting_mismatches"], 0);

        // Une preuve banque/débiteurs ne doit jamais rester affichée comme
        // conforme si la reclassification de TVA sur encaissement est
        // historiquement absente ou altérée.
        let connection = store.connect().unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER journal_lines_no_update;
                 UPDATE journal_lines
                    SET debit_cents=debit_cents-1
                  WHERE journal_entry_id=(
                    SELECT id FROM journal_entries
                    WHERE source_type='vat_cash_reclassification'
                      AND source_id='296f7196-3cd8-4d99-8a20-209578d49696'
                  ) AND memo='Reclassement TVA à régulariser';
                 CREATE TRIGGER journal_lines_no_update
                 BEFORE UPDATE ON journal_lines
                 BEGIN SELECT RAISE(ABORT,'posted journal lines are immutable'); END;",
            )
            .unwrap();
        drop(connection);
        let replay_error = store.record_payment(first_payment).unwrap_err().to_string();
        assert!(replay_error.contains("chaîne de TVA sur encaissements"));
        let workspace = store.get_workspace().unwrap();
        let payment = workspace["payments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|payment| payment["id"].as_str() == Some("296f7196-3cd8-4d99-8a20-209578d49696"))
            .unwrap();
        assert_eq!(payment["journal_entry_semantically_valid"], false);
    }

    #[test]
    fn ledger_and_trial_balance_include_opening_and_running_balances() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        post_manual_pair(
            &store,
            "2025-12-31",
            "Solde antérieur",
            &accounts["bank"],
            &accounts["ar"],
            10_000,
            "CHF",
        );
        post_manual_pair(
            &store,
            "2026-01-10",
            "Encaissement",
            &accounts["bank"],
            &accounts["ar"],
            2_500,
            "CHF",
        );
        post_manual_pair(
            &store,
            "2026-01-20",
            "Correction",
            &accounts["ar"],
            &accounts["bank"],
            400,
            "CHF",
        );

        let filter = PeriodFilter {
            date_from: Some("2026-01-01".into()),
            date_to: Some("2026-12-31".into()),
        };
        let ledger = store
            .get_ledger(LedgerInput {
                account_id: accounts["bank"].clone(),
                date_from: filter.date_from.clone(),
                date_to: filter.date_to.clone(),
            })
            .unwrap();
        assert_eq!(ledger["currency"]["base_currency"], "CHF");
        assert_eq!(ledger["opening_debit_cents"], 10_000);
        assert_eq!(ledger["opening_credit_cents"], 0);
        assert_eq!(ledger["opening_debit_balance_cents"], 10_000);
        assert_eq!(ledger["opening_credit_balance_cents"], 0);
        assert_eq!(ledger["debit_cents"], 2_500);
        assert_eq!(ledger["credit_cents"], 400);
        assert_eq!(ledger["movement_net_debit_cents"], 2_100);
        assert_eq!(ledger["net_debit_cents"], 12_100);
        assert_eq!(ledger["closing_debit_balance_cents"], 12_100);
        let ledger_lines = ledger["lines"].as_array().unwrap();
        assert_eq!(ledger_lines.len(), 2);
        assert_eq!(ledger_lines[0]["running_net_debit_cents"], 12_500);
        assert_eq!(ledger_lines[1]["running_net_debit_cents"], 12_100);

        let trial = store.get_trial_balance(filter).unwrap();
        assert_eq!(trial["currency"]["base_currency"], "CHF");
        assert_eq!(trial["opening_debit_balance_cents"], 10_000);
        assert_eq!(trial["opening_credit_balance_cents"], 10_000);
        assert_eq!(trial["debit_cents"], 2_900);
        assert_eq!(trial["credit_cents"], 2_900);
        assert_eq!(trial["closing_debit_balance_cents"], 12_100);
        assert_eq!(trial["closing_credit_balance_cents"], 12_100);
        assert_eq!(trial["balanced"], true);
        let bank_row = trial["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"].as_str() == Some(accounts["bank"].as_str()))
            .unwrap();
        assert_eq!(bank_row["opening_debit_balance_cents"], 10_000);
        assert_eq!(bank_row["debit_cents"], 2_500);
        assert_eq!(bank_row["credit_cents"], 400);
        assert_eq!(bank_row["debit_balance_cents"], 12_100);
        assert_eq!(bank_row["credit_balance_cents"], 0);
    }

    #[test]
    fn journal_ledger_and_trial_balance_fail_closed_on_unconverted_currency() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        post_manual_pair(
            &store,
            "2025-12-31",
            "Solde EUR non converti",
            &accounts["bank"],
            &accounts["ar"],
            10_000,
            "EUR",
        );
        post_manual_pair(
            &store,
            "2026-01-10",
            "Mouvement CHF",
            &accounts["bank"],
            &accounts["ar"],
            500,
            "CHF",
        );

        let historical = PeriodFilter {
            date_from: Some("2025-01-01".into()),
            date_to: Some("2025-12-31".into()),
        };
        let journal_error = store.get_journal(historical).unwrap_err().to_string();
        assert!(journal_error.contains("EUR"));

        let current = PeriodFilter {
            date_from: Some("2026-01-01".into()),
            date_to: Some("2026-12-31".into()),
        };
        assert_eq!(
            store.get_journal(current.clone()).unwrap()["lines"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let ledger_error = store
            .get_ledger(LedgerInput {
                account_id: accounts["bank"].clone(),
                date_from: current.date_from.clone(),
                date_to: current.date_to.clone(),
            })
            .unwrap_err()
            .to_string();
        assert!(ledger_error.contains("EUR"));
        let trial_error = store.get_trial_balance(current).unwrap_err().to_string();
        assert!(trial_error.contains("EUR"));
    }

    #[test]
    fn accounting_starter_backfills_history_and_financial_events_fail_closed() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client continuité"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({"client_id":client_id,"title":"Facture avant comptabilité","service_date_from":"2026-08-01","service_date_to":"2026-08-31"}),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({"invoice_id":invoice_id,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":25_000,"vat_bp":0}),
            )
            .unwrap();
        store
            .issue_invoice(
                &invoice_id,
                Some("2026-09-01".into()),
                Some("2026-09-30".into()),
            )
            .unwrap();

        let blocked = store
            .record_payment(RecordPaymentInput {
                request_id: "728e28c4-8525-49c2-9cca-c661e4c072ca".into(),
                invoice_id: invoice_id.clone(),
                amount_cents: 25_000,
                date: Some("2026-09-10".into()),
                method: Some("Banque".into()),
                reference: None,
                notes: None,
            })
            .unwrap_err();
        assert!(blocked.to_string().contains("Activez la comptabilité"));
        let connection = store.connect().unwrap();
        let untouched: (i64, String, i64) = connection
            .query_row(
                "SELECT i.paid_cents,i.status,(SELECT COUNT(*) FROM payments p WHERE p.invoice_id=i.id) FROM invoices i WHERE i.id=?",
                rusqlite::params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(untouched, (0, "emise".into(), 0));
        drop(connection);
        let before = store.get_accounting_continuity().unwrap();
        assert_eq!(before["missing_invoices"], 1);
        assert_eq!(before["total_missing"], 1);

        let installed = store.install_swiss_accounting_starter().unwrap();
        assert_eq!(installed["synchronization"]["created_invoices"], 1);
        assert_eq!(
            installed["synchronization"]["remaining"]["total_missing"],
            0
        );
        let paid = store
            .record_payment(RecordPaymentInput {
                request_id: "728e28c4-8525-49c2-9cca-c661e4c072ca".into(),
                invoice_id: invoice_id.clone(),
                amount_cents: 25_000,
                date: Some("2026-09-10".into()),
                method: Some("Banque".into()),
                reference: None,
                notes: None,
            })
            .unwrap();
        assert_eq!(paid["amount_cents"], 25_000);
        let continuity = store.get_accounting_continuity().unwrap();
        assert_eq!(continuity["total_missing"], 0);
        assert_eq!(continuity["journal_entry_count"], 2);
        assert_eq!(continuity["semantic_posting_mismatches"], 0);

        let period = store
            .upsert_accounting_period(AccountingPeriodInput {
                id: None,
                name: "Septembre 2026".into(),
                date_from: "2026-09-01".into(),
                date_to: "2026-09-30".into(),
            })
            .unwrap();
        let period_id = value_id(&period);
        let connection = store.connect().unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER journal_entries_no_update;
                 UPDATE journal_entries SET entry_date='2026-09-11' WHERE source_type='payment';
                 CREATE TRIGGER journal_entries_no_update BEFORE UPDATE ON journal_entries BEGIN SELECT RAISE(ABORT,'posted journal entries are immutable'); END;",
            )
            .unwrap();
        drop(connection);
        let corrupted = store.get_accounting_continuity().unwrap();
        assert_eq!(corrupted["semantic_posting_mismatches"], 1);
        assert!(store
            .close_accounting_period(&period_id)
            .unwrap_err()
            .to_string()
            .contains("ne correspondent pas exactement"));

        let settings = store.get_accounting_settings().unwrap();
        let disable = store.configure_accounting(AccountingSettingsInput {
            enabled: false,
            ar_account_id: settings["ar_account_id"].as_str().map(ToOwned::to_owned),
            revenue_account_id: settings["revenue_account_id"]
                .as_str()
                .map(ToOwned::to_owned),
            vat_payable_account_id: settings["vat_payable_account_id"]
                .as_str()
                .map(ToOwned::to_owned),
            vat_deferred_payable_account_id: settings["vat_deferred_payable_account_id"]
                .as_str()
                .map(ToOwned::to_owned),
            bank_account_id: settings["bank_account_id"].as_str().map(ToOwned::to_owned),
            expense_account_id: settings["expense_account_id"]
                .as_str()
                .map(ToOwned::to_owned),
            vat_receivable_account_id: settings["vat_receivable_account_id"]
                .as_str()
                .map(ToOwned::to_owned),
            wages_expense_account_id: settings["wages_expense_account_id"]
                .as_str()
                .map(ToOwned::to_owned),
            wages_payable_account_id: settings["wages_payable_account_id"]
                .as_str()
                .map(ToOwned::to_owned),
            social_expense_account_id: settings["social_expense_account_id"]
                .as_str()
                .map(ToOwned::to_owned),
            social_payable_account_id: settings["social_payable_account_id"]
                .as_str()
                .map(ToOwned::to_owned),
            supplier_payable_account_id: settings["supplier_payable_account_id"]
                .as_str()
                .map(ToOwned::to_owned),
        });
        assert!(disable
            .unwrap_err()
            .to_string()
            .contains("ne peut plus être désactivée"));
    }

    #[test]
    fn payroll_posting_uses_frozen_creditor_accounts_and_payment_is_idempotent() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let employee_liability = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "2261".into(),
                    name: "Caisse sociale employés".into(),
                    account_type: "liability".into(),
                    normal_balance: "credit".into(),
                    report_section: "short_term_liabilities".into(),
                    active: true,
                })
                .unwrap(),
        );
        let employer_liability = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "2271".into(),
                    name: "Assurance employeur".into(),
                    account_type: "liability".into(),
                    normal_balance: "credit".into(),
                    report_section: "short_term_liabilities".into(),
                    active: true,
                })
                .unwrap(),
        );
        let employer_expense = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "5721".into(),
                    name: "Prime employeur dédiée".into(),
                    account_type: "expense".into(),
                    normal_balance: "debit".into(),
                    report_section: "personnel_expense".into(),
                    active: true,
                })
                .unwrap(),
        );
        let employee_definition = ContributionDefinitionInput {
            id: None,
            code: "RETENUE_FIGEE".into(),
            label: "Retenue caisse dédiée".into(),
            category: "other".into(),
            side: "employee".into(),
            calculation_kind: "fixed".into(),
            rate_bp: None,
            fixed_amount_cents: Some(10_000),
            annual_ceiling_cents: None,
            basis_kind: "gross".into(),
            lpp_component: None,
            lpp_employee_id: None,
            source: "Contrat de test contrôlé".into(),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            active: true,
            liability_account_id: Some(employee_liability.clone()),
            expense_account_id: None,
        };
        let employee_definition_id = value_id(
            &store
                .upsert_payroll_contribution_definition(employee_definition.clone())
                .unwrap(),
        );
        let employer_definition_id = value_id(
            &store
                .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                    id: None,
                    code: "CHARGE_FIGEE".into(),
                    label: "Prime employeur dédiée".into(),
                    category: "other".into(),
                    side: "employer".into(),
                    calculation_kind: "fixed".into(),
                    rate_bp: None,
                    fixed_amount_cents: Some(15_000),
                    annual_ceiling_cents: None,
                    basis_kind: "gross".into(),
                    lpp_component: None,
                    lpp_employee_id: None,
                    source: "Contrat de test contrôlé".into(),
                    effective_from: "2026-01-01".into(),
                    effective_to: None,
                    active: true,
                    liability_account_id: Some(employer_liability.clone()),
                    expense_account_id: Some(employer_expense.clone()),
                })
                .unwrap(),
        );
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Employé ventilé"}))
                .unwrap(),
        );
        let aap_selection = configure_minor_test_payroll(&store, &employee_id, 500_000);
        let saved = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id: employee_id.clone(),
                period: "2026-08".into(),
                status: "valide".into(),
                payment_date: None,
                notes: None,
                lines: vec![
                    PayslipManualLineInput {
                        id: None,
                        label: "Salaire brut".into(),
                        kind: "earning".into(),
                        amount_cents: 500_000,
                        posting_account_id: None,
                        expense_account_id: None,
                    },
                    PayslipManualLineInput {
                        id: None,
                        label: "Retenue manuelle".into(),
                        kind: "deduction".into(),
                        amount_cents: 2_000,
                        posting_account_id: Some(accounts["social_payable"].clone()),
                        expense_account_id: None,
                    },
                    PayslipManualLineInput {
                        id: None,
                        label: "Charge manuelle".into(),
                        kind: "employer".into(),
                        amount_cents: 3_000,
                        posting_account_id: Some(accounts["social_payable"].clone()),
                        expense_account_id: Some(accounts["social_expense"].clone()),
                    },
                ],
                contributions: vec![
                    ContributionSelectionInput {
                        definition_id: employee_definition_id.clone(),
                        basis_cents: None,
                        year_to_date_basis_cents: None,
                    },
                    ContributionSelectionInput {
                        definition_id: employer_definition_id,
                        basis_cents: None,
                        year_to_date_basis_cents: None,
                    },
                    aap_selection,
                ],
            })
            .unwrap();
        let payslip_id = value_id(&saved["payslip"]);
        let frozen_accounts: (String, String) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT liability_account_id,expense_account_id FROM payslip_contributions WHERE payslip_id=? AND side='employer'",
                rusqlite::params![payslip_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            frozen_accounts,
            (employer_liability.clone(), employer_expense.clone())
        );

        let mut changed_employee_definition = employee_definition;
        changed_employee_definition.id = Some(employee_definition_id);
        changed_employee_definition.liability_account_id = Some(accounts["social_payable"].clone());
        store
            .upsert_payroll_contribution_definition(changed_employee_definition)
            .unwrap();

        let posted = store
            .post_payslip(PostPayslipInput {
                payslip_id: payslip_id.clone(),
                entry_date: Some("2026-08-31".into()),
            })
            .unwrap();
        assert_eq!(posted["payslip"]["status"], "comptabilise");
        assert_eq!(
            posted["journal"]["accounting_fallbacks"]
                .as_array()
                .unwrap()
                .len(),
            0,
            "all manual lines and contribution snapshots have explicit accounts"
        );
        let posting_id = posted["journal"]["id"].as_str().unwrap();
        let connection = store.connect().unwrap();
        let account_totals = |account_id: &str| -> (i64, i64) {
            connection
                .query_row(
                    "SELECT COALESCE(SUM(debit_cents),0),COALESCE(SUM(credit_cents),0) FROM journal_lines WHERE journal_entry_id=? AND account_id=?",
                    rusqlite::params![posting_id, account_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap()
        };
        assert_eq!(account_totals(&accounts["wages_expense"]), (500_000, 0));
        assert_eq!(account_totals(&accounts["wages_payable"]), (0, 488_000));
        assert_eq!(account_totals(&employee_liability), (0, 10_000));
        assert_eq!(account_totals(&employer_expense), (15_000, 0));
        assert_eq!(account_totals(&employer_liability), (0, 15_000));
        assert_eq!(account_totals(&accounts["social_expense"]), (8_000, 0));
        assert_eq!(account_totals(&accounts["social_payable"]), (0, 10_000));
        let posting_balance: (i64, i64) = connection
            .query_row(
                "SELECT SUM(debit_cents),SUM(credit_cents) FROM journal_lines WHERE journal_entry_id=?",
                rusqlite::params![posting_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(posting_balance, (523_000, 523_000));
        drop(connection);

        let replacement_wages_payable = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "2001".into(),
                    name: "Salaires dus - nouveau mapping".into(),
                    account_type: "liability".into(),
                    normal_balance: "credit".into(),
                    report_section: "short_term_liabilities".into(),
                    active: true,
                })
                .unwrap(),
        );
        store
            .configure_accounting(AccountingSettingsInput {
                enabled: true,
                ar_account_id: Some(accounts["ar"].clone()),
                revenue_account_id: Some(accounts["revenue"].clone()),
                vat_payable_account_id: Some(accounts["vat_payable"].clone()),
                vat_deferred_payable_account_id: Some(accounts["vat_deferred_payable"].clone()),
                bank_account_id: Some(accounts["bank"].clone()),
                expense_account_id: Some(accounts["expense"].clone()),
                vat_receivable_account_id: Some(accounts["vat_receivable"].clone()),
                wages_expense_account_id: Some(accounts["wages_expense"].clone()),
                wages_payable_account_id: Some(replacement_wages_payable.clone()),
                social_expense_account_id: Some(accounts["social_expense"].clone()),
                social_payable_account_id: Some(accounts["social_payable"].clone()),
                supplier_payable_account_id: None,
            })
            .unwrap();

        let payment_input = PayPayslipInput {
            payslip_id: payslip_id.clone(),
            payment_date: Some("2026-09-02".into()),
            reference: Some("PAY-2026-08-001".into()),
            regulatory_override_reason: None,
        };
        let paid = store.pay_payslip(payment_input.clone()).unwrap();
        assert_eq!(paid["payslip"]["status"], "paye");
        assert_eq!(paid["payslip"]["payment_date"], "2026-09-02");
        assert_eq!(paid["payslip"]["payment_reference"], "PAY-2026-08-001");
        let payment_id = paid["journal"]["id"].as_str().unwrap().to_owned();
        assert_eq!(paid["payslip"]["payment_journal_entry_id"], payment_id);
        let retry = store.pay_payslip(payment_input.clone()).unwrap();
        assert_eq!(retry["idempotent"], true);
        assert_eq!(retry["journal"]["id"], payment_id);
        let mut conflicting = payment_input;
        conflicting.reference = Some("AUTRE-REFERENCE".into());
        assert!(store
            .pay_payslip(conflicting)
            .unwrap_err()
            .to_string()
            .contains("déjà payée"));
        let connection = store.connect().unwrap();
        let payment_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM journal_entries WHERE source_type='payslip' AND source_id=? AND source_event='payment'",
                rusqlite::params![payslip_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment_count, 1);
        let payment_totals: (i64, i64, i64, i64, i64) = connection
            .query_row(
                "SELECT SUM(CASE WHEN account_id=? THEN debit_cents ELSE 0 END),SUM(CASE WHEN account_id=? THEN debit_cents ELSE 0 END),SUM(CASE WHEN account_id=? THEN credit_cents ELSE 0 END),SUM(debit_cents),SUM(credit_cents) FROM journal_lines WHERE journal_entry_id=?",
                rusqlite::params![accounts["wages_payable"], replacement_wages_payable, accounts["bank"], payment_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(
            payment_totals,
            (488_000, 0, 488_000, 488_000, 488_000),
            "the payment must clear the liability credited by the original posting, not the current mapping"
        );
    }

    #[test]
    fn payroll_contribution_accounts_must_have_the_expected_accounting_type() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let definition = |code: &str, liability: Option<String>, expense: Option<String>| {
            ContributionDefinitionInput {
                id: None,
                code: code.into(),
                label: code.into(),
                category: "other".into(),
                side: "employer".into(),
                calculation_kind: "fixed".into(),
                rate_bp: None,
                fixed_amount_cents: Some(1_000),
                annual_ceiling_cents: None,
                basis_kind: "gross".into(),
                lpp_component: None,
                lpp_employee_id: None,
                source: "Contrôle comptable Zentra".into(),
                effective_from: "2026-01-01".into(),
                effective_to: None,
                active: true,
                liability_account_id: liability,
                expense_account_id: expense,
            }
        };
        let liability_error = store
            .upsert_payroll_contribution_definition(definition(
                "INVALID_LIABILITY",
                Some(accounts["bank"].clone()),
                Some(accounts["social_expense"].clone()),
            ))
            .unwrap_err()
            .to_string();
        assert!(liability_error.contains("liability_account_id"));
        assert!(liability_error.contains("liability"));

        let expense_error = store
            .upsert_payroll_contribution_definition(definition(
                "INVALID_EXPENSE",
                Some(accounts["social_payable"].clone()),
                Some(accounts["revenue"].clone()),
            ))
            .unwrap_err()
            .to_string();
        assert!(expense_error.contains("expense_account_id"));
        assert!(expense_error.contains("expense"));

        let invalid_count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM payroll_contribution_definitions WHERE code LIKE 'INVALID_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(invalid_count, 0);
    }

    #[test]
    fn structurally_referenced_accounts_are_frozen_before_the_first_journal_entry() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let configured_error = store
            .upsert_account(AccountInput {
                id: Some(accounts["wages_payable"].clone()),
                code: "2000".into(),
                name: "Salaires dus reclassés".into(),
                account_type: "asset".into(),
                normal_balance: "debit".into(),
                report_section: "current_assets".into(),
                active: true,
            })
            .unwrap_err()
            .to_string();
        assert!(configured_error.contains("figés"));

        let reimbursement_account = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "5836".into(),
                    name: "Frais du personnel à rembourser".into(),
                    account_type: "expense".into(),
                    normal_balance: "debit".into(),
                    report_section: "personnel_expense".into(),
                    active: true,
                })
                .unwrap(),
        );
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Employé compte figé"}))
                .unwrap(),
        );
        let payslip_id = value_id(
            &store
                .create_record(
                    "payslips",
                    json!({"employee_id":employee_id,"period":"2026-12","status":"a_controler"}),
                )
                .unwrap(),
        );
        store
            .create_record(
                "payslip_items",
                json!({
                    "payslip_id":payslip_id,
                    "position":0,
                    "label":"Remboursement de frais",
                    "kind":"reimbursement",
                    "amount_cents":1_000,
                    "expense_account_id":reimbursement_account
                }),
            )
            .unwrap();
        let payroll_line_error = store
            .upsert_account(AccountInput {
                id: Some(reimbursement_account.clone()),
                code: "5836".into(),
                name: "Frais reclassés".into(),
                account_type: "asset".into(),
                normal_balance: "debit".into(),
                report_section: "current_assets".into(),
                active: true,
            })
            .unwrap_err()
            .to_string();
        assert!(payroll_line_error.contains("figés"));
        let stored_type: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT account_type FROM accounts WHERE id=?",
                rusqlite::params![reimbursement_account],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_type, "expense");
    }

    #[test]
    fn payroll_posting_revalidates_global_and_frozen_contribution_account_types() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let contribution_liability = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "2281".into(),
                    name: "Retenue à payer".into(),
                    account_type: "liability".into(),
                    normal_balance: "credit".into(),
                    report_section: "short_term_liabilities".into(),
                    active: true,
                })
                .unwrap(),
        );
        let definition_id = value_id(
            &store
                .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                    id: None,
                    code: "TYPE_RECHECK".into(),
                    label: "Retenue revalidation".into(),
                    category: "other".into(),
                    side: "employee".into(),
                    calculation_kind: "fixed".into(),
                    rate_bp: None,
                    fixed_amount_cents: Some(1_000),
                    annual_ceiling_cents: None,
                    basis_kind: "gross".into(),
                    lpp_component: None,
                    lpp_employee_id: None,
                    source: "Test de revalidation comptable".into(),
                    effective_from: "2026-01-01".into(),
                    effective_to: None,
                    active: true,
                    liability_account_id: Some(contribution_liability.clone()),
                    expense_account_id: None,
                })
                .unwrap(),
        );
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Employé revalidation"}))
                .unwrap(),
        );
        let aap_selection = configure_minor_test_payroll(&store, &employee_id, 100_000);
        let saved = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id,
                period: "2026-12".into(),
                status: "valide".into(),
                payment_date: None,
                notes: None,
                lines: vec![PayslipManualLineInput {
                    id: None,
                    label: "Salaire brut".into(),
                    kind: "earning".into(),
                    amount_cents: 100_000,
                    posting_account_id: None,
                    expense_account_id: None,
                }],
                contributions: vec![
                    ContributionSelectionInput {
                        definition_id,
                        basis_cents: None,
                        year_to_date_basis_cents: None,
                    },
                    aap_selection,
                ],
            })
            .unwrap();
        let payslip_id = value_id(&saved["payslip"]);

        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE accounts SET account_type='asset',normal_balance='debit',report_section='current_assets' WHERE id=?",
                rusqlite::params![accounts["wages_expense"]],
            )
            .unwrap();
        let global_error = store
            .post_payslip(PostPayslipInput {
                payslip_id: payslip_id.clone(),
                entry_date: Some("2026-12-31".into()),
            })
            .unwrap_err()
            .to_string();
        assert!(global_error.contains("charges salariales"));
        assert!(global_error.contains("expense"));

        let connection = store.connect().unwrap();
        connection
            .execute(
                "UPDATE accounts SET account_type='expense',normal_balance='debit',report_section='personnel_expense' WHERE id=?",
                rusqlite::params![accounts["wages_expense"]],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE accounts SET account_type='revenue',normal_balance='credit',report_section='net_revenue' WHERE id=?",
                rusqlite::params![contribution_liability],
            )
            .unwrap();
        drop(connection);

        let contribution_error = store
            .post_payslip(PostPayslipInput {
                payslip_id: payslip_id.clone(),
                entry_date: Some("2026-12-31".into()),
            })
            .unwrap_err()
            .to_string();
        assert!(contribution_error.contains("compte créancier"));
        assert!(contribution_error.contains("liability"));
        let unchanged: (String, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT status,(SELECT COUNT(*) FROM journal_entries WHERE source_type='payslip' AND source_id=p.id) FROM payslips p WHERE id=?",
                rusqlite::params![payslip_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(unchanged, ("valide".into(), 0));
    }

    #[test]
    fn manual_payroll_lines_use_explicit_typed_accounts_including_reimbursements() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let advance_account = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "1175".into(),
                    name: "Avances au personnel".into(),
                    account_type: "asset".into(),
                    normal_balance: "debit".into(),
                    report_section: "current_assets".into(),
                    active: true,
                })
                .unwrap(),
        );
        let source_tax_account = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "2275".into(),
                    name: "Impôt à la source dû".into(),
                    account_type: "liability".into(),
                    normal_balance: "credit".into(),
                    report_section: "short_term_liabilities".into(),
                    active: true,
                })
                .unwrap(),
        );
        let reimbursement_expense = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "5835".into(),
                    name: "Frais remboursés au personnel".into(),
                    account_type: "expense".into(),
                    normal_balance: "debit".into(),
                    report_section: "personnel_expense".into(),
                    active: true,
                })
                .unwrap(),
        );
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Employé avec frais"}))
                .unwrap(),
        );
        let aap_selection = configure_minor_test_payroll(&store, &employee_id, 500_000);
        let saved = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id: employee_id.clone(),
                period: "2026-10".into(),
                status: "valide".into(),
                payment_date: None,
                notes: None,
                lines: vec![
                    PayslipManualLineInput {
                        id: None,
                        label: "Salaire brut".into(),
                        kind: "earning".into(),
                        amount_cents: 500_000,
                        posting_account_id: None,
                        expense_account_id: None,
                    },
                    PayslipManualLineInput {
                        id: None,
                        label: "Récupération avance".into(),
                        kind: "deduction".into(),
                        amount_cents: 10_000,
                        posting_account_id: Some(advance_account.clone()),
                        expense_account_id: None,
                    },
                    PayslipManualLineInput {
                        id: None,
                        label: "Impôt à la source".into(),
                        kind: "deduction".into(),
                        amount_cents: 20_000,
                        posting_account_id: Some(source_tax_account.clone()),
                        expense_account_id: None,
                    },
                    PayslipManualLineInput {
                        id: None,
                        label: "Frais de déplacement".into(),
                        kind: "reimbursement".into(),
                        amount_cents: 5_000,
                        posting_account_id: None,
                        expense_account_id: Some(reimbursement_expense.clone()),
                    },
                ],
                contributions: vec![aap_selection.clone()],
            })
            .unwrap();
        assert_eq!(saved["payslip"]["gross_cents"], 500_000);
        assert_eq!(saved["payslip"]["deductions_cents"], 30_000);
        assert_eq!(saved["payslip"]["net_cents"], 475_000);
        let payslip_id = value_id(&saved["payslip"]);
        let posted = store
            .post_payslip(PostPayslipInput {
                payslip_id,
                entry_date: Some("2026-10-31".into()),
            })
            .unwrap();
        let journal_id = posted["journal"]["id"].as_str().unwrap();
        let connection = store.connect().unwrap();
        let totals = |account_id: &str| -> (i64, i64) {
            connection
                .query_row(
                    "SELECT COALESCE(SUM(debit_cents),0),COALESCE(SUM(credit_cents),0) FROM journal_lines WHERE journal_entry_id=? AND account_id=?",
                    rusqlite::params![journal_id, account_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap()
        };
        assert_eq!(totals(&accounts["wages_expense"]), (500_000, 0));
        assert_eq!(totals(&accounts["wages_payable"]), (0, 475_000));
        assert_eq!(totals(&advance_account), (0, 10_000));
        assert_eq!(totals(&source_tax_account), (0, 20_000));
        assert_eq!(totals(&reimbursement_expense), (5_000, 0));
        assert_eq!(totals(&accounts["social_expense"]), (5_000, 0));
        assert_eq!(totals(&accounts["social_payable"]), (0, 5_000));
        let balance: (i64, i64) = connection
            .query_row(
                "SELECT SUM(debit_cents),SUM(credit_cents) FROM journal_lines WHERE journal_entry_id=?",
                rusqlite::params![journal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(balance, (510_000, 510_000));

        let next_period_aap = ContributionSelectionInput {
            definition_id: aap_selection.definition_id,
            basis_cents: Some(100_000),
            // Le moteur reprend l'ouverture et les fiches antérieures; aucun
            // cumul transmis par l'interface ne doit pouvoir le remplacer.
            year_to_date_basis_cents: None,
        };
        let invalid = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id,
                period: "2026-11".into(),
                status: "valide".into(),
                payment_date: None,
                notes: None,
                lines: vec![
                    PayslipManualLineInput {
                        id: None,
                        label: "Salaire brut".into(),
                        kind: "earning".into(),
                        amount_cents: 100_000,
                        posting_account_id: None,
                        expense_account_id: None,
                    },
                    PayslipManualLineInput {
                        id: None,
                        label: "Retenue mal classée".into(),
                        kind: "deduction".into(),
                        amount_cents: 1_000,
                        posting_account_id: Some(accounts["revenue"].clone()),
                        expense_account_id: None,
                    },
                ],
                contributions: vec![next_period_aap],
            })
            .unwrap();
        let invalid_id = value_id(&invalid["payslip"]);
        let error = store
            .post_payslip(PostPayslipInput {
                payslip_id: invalid_id.clone(),
                entry_date: Some("2026-11-30".into()),
            })
            .unwrap_err()
            .to_string();
        assert!(error.contains("asset ou liability"));
        let persisted: (String, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT status,(SELECT COUNT(*) FROM journal_entries WHERE source_type='payslip' AND source_id=p.id) FROM payslips p WHERE id=?",
                rusqlite::params![invalid_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(persisted, ("valide".into(), 0));
    }

    #[test]
    fn adult_post_replays_frozen_date_and_payment_rejects_changed_regulatory_window() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Employé adulte daté"}))
                .unwrap(),
        );
        let contributions = configure_adult_test_payroll(&store, &employee_id);
        let saved = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id,
                period: "2026-08".into(),
                status: "valide".into(),
                payment_date: None,
                notes: None,
                lines: vec![PayslipManualLineInput {
                    id: None,
                    label: "Salaire brut".into(),
                    kind: "earning".into(),
                    amount_cents: 500_000,
                    posting_account_id: None,
                    expense_account_id: None,
                }],
                contributions,
            })
            .unwrap();
        assert_eq!(saved["calculation"]["contribution_date"], "2026-08-01");
        assert_eq!(saved["contributions"].as_array().unwrap().len(), 10);
        let payslip_id = value_id(&saved["payslip"]);

        let posted = store
            .post_payslip(PostPayslipInput {
                payslip_id: payslip_id.clone(),
                entry_date: Some("2026-08-31".into()),
            })
            .unwrap();
        assert_eq!(posted["payslip"]["status"], "comptabilise");
        let snapshot: serde_json::Value =
            serde_json::from_str(posted["payslip"]["snapshot_json"].as_str().unwrap()).unwrap();
        assert_eq!(snapshot["contribution_date"], "2026-08-01");
        assert_eq!(snapshot["contributions"].as_array().unwrap().len(), 10);

        store
            .connect()
            .unwrap()
            .execute(
                "DELETE FROM payslip_contributions WHERE payslip_id=?",
                rusqlite::params![payslip_id],
            )
            .unwrap();
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM payslip_contributions WHERE payslip_id=?",
                    rusqlite::params![payslip_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "le contrôle de paiement doit dépendre du snapshot immuable, pas de la table vivante"
        );

        let missing_date_error = store
            .pay_payslip(PayPayslipInput {
                payslip_id: payslip_id.clone(),
                payment_date: None,
                reference: Some("REF-SANS-DATE".into()),
                regulatory_override_reason: None,
            })
            .unwrap_err()
            .to_string();
        assert!(
            missing_date_error.contains("date réelle"),
            "{missing_date_error}"
        );
        let unchanged_without_date: (String, Option<String>, Option<String>, Option<String>, i64) =
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT status,payment_date,payment_reference,payment_journal_entry_id,(SELECT COUNT(*) FROM journal_entries WHERE source_type='payslip' AND source_id=p.id AND source_event='payment') FROM payslips p WHERE id=?",
                    rusqlite::params![payslip_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .unwrap();
        assert_eq!(
            unchanged_without_date,
            ("comptabilise".into(), None, None, None, 0)
        );

        for (payment_date, expected_error) in [
            ("2027-01-02", "millésime réglementaire"),
            ("2026-09-01", "fenêtre réglementaire"),
        ] {
            let error = store
                .pay_payslip(PayPayslipInput {
                    payslip_id: payslip_id.clone(),
                    payment_date: Some(payment_date.into()),
                    reference: Some(format!("REF-{payment_date}")),
                    regulatory_override_reason: None,
                })
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected_error), "{error}");
            assert!(error.contains("recalculez"), "{error}");
            let unchanged: (String, Option<String>, Option<String>, Option<String>, i64) = store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT status,payment_date,payment_reference,payment_journal_entry_id,(SELECT COUNT(*) FROM journal_entries WHERE source_type='payslip' AND source_id=p.id AND source_event='payment') FROM payslips p WHERE id=?",
                    rusqlite::params![payslip_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .unwrap();
            assert_eq!(unchanged, ("comptabilise".into(), None, None, None, 0));
        }

        let paid = store
            .pay_payslip(PayPayslipInput {
                payslip_id,
                payment_date: Some("2026-08-31".into()),
                reference: Some("REF-DANS-FENETRE".into()),
                regulatory_override_reason: None,
            })
            .unwrap();
        assert_eq!(paid["payslip"]["status"], "paye");
        assert_eq!(paid["payslip"]["payment_date"], "2026-08-31");
    }

    #[test]
    fn historical_paid_regularization_requires_an_audited_regulatory_override() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Paiement historique contrôlé"}))
                .unwrap(),
        );
        let contributions = configure_adult_test_payroll(&store, &employee_id);
        let saved = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id,
                period: "2026-08".into(),
                status: "valide".into(),
                payment_date: None,
                notes: None,
                lines: vec![valid_salary_line()],
                contributions,
            })
            .unwrap();
        let payslip_id = value_id(&saved["payslip"]);
        store
            .post_payslip(PostPayslipInput {
                payslip_id: payslip_id.clone(),
                entry_date: Some("2026-08-31".into()),
            })
            .unwrap();

        let connection = store.connect().unwrap();
        connection
            .execute_batch("DROP TRIGGER payslips_posted_no_update;")
            .unwrap();
        connection
            .execute(
                "UPDATE payslips SET status='paye',payment_date=NULL,payment_reference=NULL,payment_journal_entry_id=NULL WHERE id=?",
                rusqlite::params![payslip_id],
            )
            .unwrap();
        drop(connection);

        let blocked = store
            .pay_payslip(PayPayslipInput {
                payslip_id: payslip_id.clone(),
                payment_date: Some("2027-01-02".into()),
                reference: Some("HIST-2027".into()),
                regulatory_override_reason: None,
            })
            .unwrap_err()
            .to_string();
        assert!(blocked.contains("millésime réglementaire"), "{blocked}");
        assert!(blocked.contains("dérogation exceptionnelle"), "{blocked}");

        let repair_input = PayPayslipInput {
            payslip_id: payslip_id.clone(),
            payment_date: Some("2027-01-02".into()),
            reference: Some("HIST-2027".into()),
            regulatory_override_reason: Some(
                "Paiement bancaire réel vérifié sur le relevé du 2 janvier 2027.".into(),
            ),
        };
        let repaired = store.pay_payslip(repair_input.clone()).unwrap();
        assert_eq!(repaired["regularized"], true);
        assert_eq!(repaired["payslip"]["payment_date"], "2027-01-02");
        let retry = store.pay_payslip(repair_input).unwrap();
        assert_eq!(retry["idempotent"], true);

        let payload: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT payload_json FROM audit_log WHERE action='regularize_payment' AND entity_id=? ORDER BY rowid DESC LIMIT 1",
                rusqlite::params![payslip_id],
                |row| row.get(0),
            )
            .unwrap();
        let audit: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(audit["regulatory_override"]["confirmed"], true);
        assert_eq!(
            audit["regulatory_override"]["reason"],
            "Paiement bancaire réel vérifié sur le relevé du 2 janvier 2027."
        );
        assert!(audit["regulatory_override"]["blocked_check"]
            .as_str()
            .unwrap()
            .contains("millésime réglementaire"));
    }

    #[test]
    fn lpp_due_without_required_components_is_rejected() {
        let (_temporary, store) = initialized_store();
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"LPP due sans ligne"}))
                .unwrap(),
        );
        let contributions = configure_adult_test_payroll(&store, &employee_id);
        make_employee_lpp_due(&store, &employee_id, "1990-01-01");
        set_lpp_plan_evidence(&store, Some(valid_lpp_plan_evidence()));

        let error = save_valid_test_payslip(&store, &employee_id, contributions)
            .unwrap_err()
            .to_string();
        assert!(error.contains("combined"), "{error}");
        assert!(
            error.contains("risk") && error.contains("savings"),
            "{error}"
        );
        let count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM payslips", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "la sauvegarde valide doit rester atomique");
    }

    #[test]
    fn lpp_plan_and_definition_contract_fail_closed() {
        let (_temporary, store) = initialized_store();
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Contrat LPP contrôlé"}))
                .unwrap(),
        );
        configure_adult_test_payroll(&store, &employee_id);
        make_employee_lpp_due(&store, &employee_id, "1990-01-01");
        let valid =
            lpp_definition_input(&employee_id, "LPP_CONTRACT", "employee", "combined", 10_000);

        set_lpp_plan_evidence(&store, None);
        let absent = store
            .upsert_payroll_contribution_definition(valid.clone())
            .unwrap_err()
            .to_string();
        assert!(absent.contains("attestation structurée"), "{absent}");

        let mut unconfirmed = valid_lpp_plan_evidence();
        unconfirmed["employerAggregateShareConfirmed"] = json!(false);
        set_lpp_plan_evidence(&store, Some(unconfirmed));
        let parity = store
            .upsert_payroll_contribution_definition(valid.clone())
            .unwrap_err()
            .to_string();
        assert!(parity.contains("agrégée"), "{parity}");
        assert!(parity.contains("fiche par fiche"), "{parity}");

        let mut expired = valid_lpp_plan_evidence();
        expired["effectiveTo"] = json!("2026-05-31");
        set_lpp_plan_evidence(&store, Some(expired));
        let window = store
            .upsert_payroll_contribution_definition(valid.clone())
            .unwrap_err()
            .to_string();
        assert!(window.contains("sort de la fenêtre"), "{window}");

        let mut imprecise = valid_lpp_plan_evidence();
        imprecise["regulationReference"] = json!(format!(" {LPP_TEST_REGULATION}"));
        set_lpp_plan_evidence(&store, Some(imprecise));
        let exact_text = store
            .upsert_payroll_contribution_definition(valid.clone())
            .unwrap_err()
            .to_string();
        assert!(exact_text.contains("espaces périphériques"), "{exact_text}");

        set_lpp_plan_evidence(&store, Some(valid_lpp_plan_evidence()));
        for (label, invalid, expected) in [
            (
                "source",
                ContributionDefinitionInput {
                    source: "Référence différente".into(),
                    ..valid.clone()
                },
                "exactement",
            ),
            (
                "composante",
                ContributionDefinitionInput {
                    lpp_component: None,
                    ..valid.clone()
                },
                "lpp_component",
            ),
            (
                "mode",
                ContributionDefinitionInput {
                    calculation_kind: "rate".into(),
                    rate_bp: Some(100),
                    fixed_amount_cents: None,
                    ..valid.clone()
                },
                "montant fixe",
            ),
            (
                "montant nul",
                ContributionDefinitionInput {
                    fixed_amount_cents: Some(0),
                    ..valid.clone()
                },
                "strictement positif",
            ),
            (
                "base",
                ContributionDefinitionInput {
                    basis_kind: "gross".into(),
                    ..valid.clone()
                },
                "coordinated ou custom",
            ),
            (
                "salarié absent",
                ContributionDefinitionInput {
                    lpp_employee_id: Some("employee-inexistant".into()),
                    ..valid.clone()
                },
                "introuvable",
            ),
            (
                "métadonnées étrangères",
                ContributionDefinitionInput {
                    category: "other".into(),
                    ..valid.clone()
                },
                "doivent être null",
            ),
        ] {
            let error = store
                .upsert_payroll_contribution_definition(invalid)
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{label}: {error}");
        }

        let persisted = create_lpp_selection(&store, valid);
        let mut expired_after_creation = valid_lpp_plan_evidence();
        expired_after_creation["effectiveTo"] = json!("2026-05-31");
        set_lpp_plan_evidence(&store, Some(expired_after_creation));
        let revalidated = store
            .calculate_employee_payroll_contributions(CalculateEmployeePayrollInput {
                employee_id,
                period: "2026-06".into(),
                payment_date: None,
                gross_cents: 500_000,
                items: vec![persisted],
            })
            .unwrap_err()
            .to_string();
        assert!(revalidated.contains("sort de la fenêtre"), "{revalidated}");
    }

    #[test]
    fn lpp_is_scoped_to_one_employee_and_legacy_null_metadata_is_unusable() {
        let (_temporary, store) = initialized_store();
        let linked_employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Salarié lié au plan"}))
                .unwrap(),
        );
        let payslip_employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Salarié de la fiche"}))
                .unwrap(),
        );
        configure_adult_test_payroll(&store, &payslip_employee_id);
        make_employee_lpp_due(&store, &payslip_employee_id, "1990-01-01");
        set_lpp_plan_evidence(&store, Some(valid_lpp_plan_evidence()));
        let wrong_employee = create_lpp_selection(
            &store,
            lpp_definition_input(
                &linked_employee_id,
                "LPP_WRONG_EMPLOYEE",
                "employee",
                "combined",
                10_000,
            ),
        );
        let error = store
            .calculate_employee_payroll_contributions(CalculateEmployeePayrollInput {
                employee_id: payslip_employee_id.clone(),
                period: "2026-06".into(),
                payment_date: None,
                gross_cents: 500_000,
                items: vec![wrong_employee],
            })
            .unwrap_err()
            .to_string();
        assert!(error.contains("autre collaborateur"), "{error}");

        let legacy = store
            .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                id: None,
                code: "LEGACY_LPP_NULL".into(),
                label: "Ancienne définition incomplète".into(),
                category: "other".into(),
                side: "employee".into(),
                calculation_kind: "fixed".into(),
                rate_bp: None,
                fixed_amount_cents: Some(10_000),
                annual_ceiling_cents: None,
                basis_kind: "custom".into(),
                lpp_component: None,
                lpp_employee_id: None,
                source: LPP_TEST_REGULATION.into(),
                effective_from: "2026-01-01".into(),
                effective_to: Some("2026-12-31".into()),
                active: true,
                liability_account_id: None,
                expense_account_id: None,
            })
            .unwrap();
        let legacy_id = value_id(&legacy);
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE payroll_contribution_definitions SET category='lpp' WHERE id=?",
                rusqlite::params![legacy_id],
            )
            .unwrap();
        let legacy_error = store
            .calculate_employee_payroll_contributions(CalculateEmployeePayrollInput {
                employee_id: payslip_employee_id,
                period: "2026-06".into(),
                payment_date: None,
                gross_cents: 500_000,
                items: vec![ContributionSelectionInput {
                    definition_id: legacy_id,
                    basis_cents: Some(3_354_000),
                    year_to_date_basis_cents: None,
                }],
            })
            .unwrap_err()
            .to_string();
        assert!(legacy_error.contains("lpp_component"), "{legacy_error}");
    }

    #[test]
    fn lpp_minimum_components_and_more_favorable_plan_are_enforced() {
        let scenario = |birth_date: &str,
                        annual_salary_cents: i64,
                        components: &[&str]|
         -> crate::error::AppResult<serde_json::Value> {
            let (_temporary, store) = initialized_store();
            let employee_id = value_id(
                &store
                    .create_record("employees", json!({"name":"Scénario LPP"}))
                    .unwrap(),
            );
            let mut contributions = configure_adult_test_payroll(&store, &employee_id);
            make_employee_lpp_due(&store, &employee_id, birth_date);
            store
                .update_record(
                    "employees",
                    &employee_id,
                    json!({
                        "lpp_assessment_year":2026,
                        "lpp_annual_salary_cents":annual_salary_cents
                    }),
                )
                .unwrap();
            set_lpp_plan_evidence(&store, Some(valid_lpp_plan_evidence()));
            for (index, component) in components.iter().enumerate() {
                let mut definition = lpp_definition_input(
                    &employee_id,
                    &format!("LPP_SCENARIO_{index}_{component}"),
                    if index % 2 == 0 {
                        "employee"
                    } else {
                        "employer"
                    },
                    component,
                    10_000 + index as i64 * 1_000,
                );
                if annual_salary_cents <= 2_268_000 {
                    definition.basis_kind = "custom".into();
                }
                contributions.push(create_lpp_selection(&store, definition));
            }
            save_valid_test_payslip(&store, &employee_id, contributions)
        };

        let risk_only_error = scenario("2002-01-01", 6_000_000, &["savings"])
            .unwrap_err()
            .to_string();
        assert!(
            risk_only_error.contains("composante risque"),
            "{risk_only_error}"
        );
        scenario("2002-01-01", 6_000_000, &["risk"]).unwrap();

        let savings_error = scenario("1990-01-01", 6_000_000, &["risk"])
            .unwrap_err()
            .to_string();
        assert!(savings_error.contains("risk et savings"), "{savings_error}");
        scenario("1990-01-01", 6_000_000, &["risk", "savings"]).unwrap();
        scenario("1990-01-01", 6_000_000, &["combined"]).unwrap();

        // Le seuil légal n'interdit jamais une couverture plus favorable du
        // règlement réel.
        scenario("1990-01-01", 2_000_000, &["combined"]).unwrap();

        let (_temporary, exempt_store) = initialized_store();
        let exempt_employee_id = value_id(
            &exempt_store
                .create_record("employees", json!({"name":"Plan favorable exempté"}))
                .unwrap(),
        );
        let mut exempt_contributions =
            configure_adult_test_payroll(&exempt_store, &exempt_employee_id);
        make_employee_lpp_due(&exempt_store, &exempt_employee_id, "1990-01-01");
        exempt_store
            .update_record(
                "employees",
                &exempt_employee_id,
                json!({
                    "employment_start_date":"2026-04-01",
                    "employment_end_date":"2026-06-30",
                    "employment_contract_kind":"fixed",
                    "lpp_exception_code":"short_fixed_contract",
                    "lpp_exception_evidence_reference":"Contrat signé LPP-COURT-1"
                }),
            )
            .unwrap();
        set_lpp_plan_evidence(&exempt_store, Some(valid_lpp_plan_evidence()));
        let mut exempt_definition = lpp_definition_input(
            &exempt_employee_id,
            "LPP_EXEMPT_FAVORABLE",
            "employee",
            "combined",
            10_000,
        );
        exempt_definition.basis_kind = "custom".into();
        exempt_contributions.push(create_lpp_selection(&exempt_store, exempt_definition));
        save_valid_test_payslip(&exempt_store, &exempt_employee_id, exempt_contributions).unwrap();
    }

    #[test]
    fn lpp_coordinated_basis_must_match_the_legal_annual_basis() {
        let (_temporary, store) = initialized_store();
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Base LPP contrôlée"}))
                .unwrap(),
        );
        let mut contributions = configure_adult_test_payroll(&store, &employee_id);
        make_employee_lpp_due(&store, &employee_id, "1990-01-01");
        set_lpp_plan_evidence(&store, Some(valid_lpp_plan_evidence()));
        let mut invalid = create_lpp_selection(
            &store,
            lpp_definition_input(
                &employee_id,
                "LPP_WRONG_COORDINATED_BASIS",
                "employee",
                "combined",
                10_000,
            ),
        );
        invalid.basis_cents = Some(1);
        contributions.push(invalid);

        let error = save_valid_test_payslip(&store, &employee_id, contributions)
            .unwrap_err()
            .to_string();
        assert!(error.contains("3354000"), "{error}");
        assert!(error.contains("salaire coordonné annuel légal"), "{error}");
    }

    #[test]
    fn lpp_frozen_component_mutation_blocks_posting() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"LPP figée"}))
                .unwrap(),
        );
        let mut contributions = configure_adult_test_payroll(&store, &employee_id);
        make_employee_lpp_due(&store, &employee_id, "1990-01-01");
        set_lpp_plan_evidence(&store, Some(valid_lpp_plan_evidence()));
        contributions.push(create_lpp_selection(
            &store,
            lpp_definition_input(
                &employee_id,
                "LPP_FROZEN_COMBINED",
                "employee",
                "combined",
                10_000,
            ),
        ));
        let saved = save_valid_test_payslip(&store, &employee_id, contributions).unwrap();
        let payslip_id = value_id(&saved["payslip"]);
        let lpp_snapshot = saved["contributions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["category"] == "lpp")
            .unwrap();
        assert_eq!(lpp_snapshot["lpp_component"], "combined");
        assert_eq!(lpp_snapshot["lpp_employee_id"], employee_id);

        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE payslip_contributions SET lpp_component='risk' WHERE payslip_id=? AND category='lpp'",
                rusqlite::params![payslip_id],
            )
            .unwrap();
        let error = store
            .post_payslip(PostPayslipInput {
                payslip_id: payslip_id.clone(),
                entry_date: Some("2026-06-30".into()),
            })
            .unwrap_err()
            .to_string();
        assert!(error.contains("lpp_component"), "{error}");
        let unchanged: (String, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT status,(SELECT COUNT(*) FROM journal_entries WHERE source_type='payslip' AND source_id=p.id) FROM payslips p WHERE id=?",
                rusqlite::params![payslip_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(unchanged, ("valide".into(), 0));

        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE payslip_contributions SET lpp_component='combined' WHERE payslip_id=? AND category='lpp'",
                rusqlite::params![payslip_id],
            )
            .unwrap();
        let posted = store
            .post_payslip(PostPayslipInput {
                payslip_id,
                entry_date: Some("2026-06-30".into()),
            })
            .unwrap();
        let snapshot: serde_json::Value =
            serde_json::from_str(posted["payslip"]["snapshot_json"].as_str().unwrap()).unwrap();
        let frozen_lpp = snapshot["contributions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["category"] == "lpp")
            .unwrap();
        assert_eq!(frozen_lpp["lpp_component"], "combined");
        assert_eq!(frozen_lpp["lpp_employee_id"], employee_id);
    }

    #[test]
    fn payroll_payment_rolls_back_when_payment_period_is_closed() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Employé clôture"}))
                .unwrap(),
        );
        let aap_selection = configure_minor_test_payroll(&store, &employee_id, 100_000);
        let saved = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id,
                period: "2026-09".into(),
                status: "valide".into(),
                payment_date: None,
                notes: None,
                lines: vec![PayslipManualLineInput {
                    id: None,
                    label: "Salaire brut".into(),
                    kind: "earning".into(),
                    amount_cents: 100_000,
                    posting_account_id: None,
                    expense_account_id: None,
                }],
                contributions: vec![aap_selection],
            })
            .unwrap();
        let payslip_id = value_id(&saved["payslip"]);
        store
            .post_payslip(PostPayslipInput {
                payslip_id: payslip_id.clone(),
                entry_date: Some("2026-09-30".into()),
            })
            .unwrap();
        let period = store
            .upsert_accounting_period(AccountingPeriodInput {
                id: None,
                name: "Paiements octobre clôturés".into(),
                date_from: "2026-10-01".into(),
                date_to: "2026-10-31".into(),
            })
            .unwrap();
        store
            .close_accounting_period(period["id"].as_str().unwrap())
            .unwrap();
        let result = store.pay_payslip(PayPayslipInput {
            payslip_id: payslip_id.clone(),
            payment_date: Some("2026-10-02".into()),
            reference: Some("CLOSED-1".into()),
            regulatory_override_reason: None,
        });
        assert!(result.unwrap_err().to_string().contains("clôturée"));
        let persisted: (String, Option<String>, Option<String>, Option<String>, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT status,payment_date,payment_reference,payment_journal_entry_id,(SELECT COUNT(*) FROM journal_entries WHERE source_type='payslip' AND source_id=p.id AND source_event='payment') FROM payslips p WHERE id=?",
                rusqlite::params![payslip_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(persisted, ("comptabilise".into(), None, None, None, 0));
    }

    #[test]
    fn payment_and_automatic_journal_entry_roll_back_together() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client transactionnel"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({"client_id":client_id,"title":"Facture atomique","service_date_from":"2026-06-01","service_date_to":"2026-06-30"}),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({"invoice_id":invoice_id,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0}),
            )
            .unwrap();
        store
            .issue_invoice(
                &invoice_id,
                Some("2026-07-01".into()),
                Some("2026-07-31".into()),
            )
            .unwrap();
        let period = store
            .upsert_accounting_period(AccountingPeriodInput {
                id: None,
                name: "Journée clôturée".into(),
                date_from: "2026-07-05".into(),
                date_to: "2026-07-05".into(),
            })
            .unwrap();
        store
            .close_accounting_period(period["id"].as_str().unwrap())
            .unwrap();

        let result = store.record_payment(RecordPaymentInput {
            request_id: "d3f1d8d7-b113-4714-9660-b43799d8b9e2".into(),
            invoice_id: invoice_id.clone(),
            amount_cents: 10_000,
            date: Some("2026-07-05".into()),
            method: Some("Virement".into()),
            reference: Some("TX-1".into()),
            notes: None,
        });
        assert!(result.unwrap_err().to_string().contains("clôturée"));

        let connection = store.connect().unwrap();
        let payments: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM payments WHERE invoice_id=?",
                rusqlite::params![invoice_id],
                |row| row.get(0),
            )
            .unwrap();
        let payment_entries: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM journal_entries WHERE source_type='payment'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let invoice_state: (i64, String) = connection
            .query_row(
                "SELECT paid_cents,status FROM invoices WHERE id=?",
                rusqlite::params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(payments, 0);
        assert_eq!(payment_entries, 0);
        assert_eq!(invoice_state, (0, "emise".into()));
    }

    #[test]
    fn customer_payment_requires_an_explicit_date_and_an_active_invoice() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client date réelle"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture à encaisser explicitement",
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
                    "description":"Prestation",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":10_000,
                    "vat_bp":0
                }),
            )
            .unwrap();
        store
            .issue_invoice(&invoice_id, Some("2026-09-01".into()), None)
            .unwrap();

        let missing_date = store
            .record_payment(RecordPaymentInput {
                request_id: "b5d471c1-7c24-42bc-96ea-84edab6f6eab".into(),
                invoice_id: invoice_id.clone(),
                amount_cents: 10_000,
                date: None,
                method: Some("Virement".into()),
                reference: None,
                notes: None,
            })
            .unwrap_err()
            .to_string();
        assert!(missing_date.contains("date réelle"));

        // Simule une ligne héritée d'une version antérieure à la garde V30 :
        // le contrôle applicatif doit lui aussi refuser l'encaissement.
        let connection = store.connect().unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER invoices_issued_no_unsafe_cancel;
                 UPDATE invoices SET status='annulee' WHERE id=(SELECT id FROM invoices WHERE title='Facture à encaisser explicitement');",
            )
            .unwrap();
        drop(connection);
        let cancelled = store
            .record_payment(RecordPaymentInput {
                request_id: "542c6125-c0db-4d90-87c2-fdcfa70f349b".into(),
                invoice_id: invoice_id.clone(),
                amount_cents: 10_000,
                date: Some("2026-09-02".into()),
                method: Some("Virement".into()),
                reference: None,
                notes: None,
            })
            .unwrap_err()
            .to_string();
        assert!(cancelled.contains("facture émise et active"));
        let state: (i64, i64, String) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM payments WHERE invoice_id=?1),
                    (SELECT COUNT(*) FROM journal_entries WHERE source_type='payment'),
                    status
                 FROM invoices WHERE id=?1",
                rusqlite::params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, (0, 0, "annulee".into()));
    }

    #[test]
    fn fully_paid_invoice_is_posted_once_traceable_balanced_and_replay_safe() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client paiement final"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture entièrement réglée",
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
                    "description":"Prestation réglée",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":12_345,
                    "vat_bp":0
                }),
            )
            .unwrap();
        store
            .issue_invoice(
                &invoice_id,
                Some("2026-09-01".into()),
                Some("2026-09-30".into()),
            )
            .unwrap();
        let request = RecordPaymentInput {
            request_id: "08b98c9b-48d5-4756-8ef9-c6cae3f8db8c".into(),
            invoice_id: invoice_id.clone(),
            amount_cents: 12_345,
            date: Some("2026-09-02".into()),
            method: Some("Virement bancaire".into()),
            reference: Some("ENC-FINAL-1".into()),
            notes: Some("Règlement total".into()),
        };
        let first = store.record_payment(request.clone()).unwrap();
        let journal_id = first["journal_entry_id"].as_str().unwrap().to_owned();
        assert!(!journal_id.is_empty());
        assert!(first["journal_entry_number"]
            .as_str()
            .is_some_and(|number| number.starts_with("J-2026-")));
        assert_eq!(
            first["journal_source_event"],
            format!("invoice:{invoice_id}")
        );

        let connection = store.connect().unwrap();
        let invoice_state: (i64, String) = connection
            .query_row(
                "SELECT paid_cents,status FROM invoices WHERE id=?",
                rusqlite::params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(invoice_state, (12_345, "payee".into()));
        let proof: (i64, i64, i64, String, String, String) = connection
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(line.debit_cents),0),
                        COALESCE(SUM(line.credit_cents),0),
                        entry.source_type,entry.source_id,entry.source_event
                 FROM journal_entries entry
                 JOIN journal_lines line ON line.journal_entry_id=entry.id
                 WHERE entry.id=?
                 GROUP BY entry.id",
                rusqlite::params![journal_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            proof,
            (
                2,
                12_345,
                12_345,
                "payment".into(),
                first["id"].as_str().unwrap().into(),
                format!("invoice:{invoice_id}"),
            )
        );
        let account_lines: (i64, i64) = connection
            .query_row(
                "SELECT
                    COALESCE(SUM(CASE WHEN account_id=? THEN debit_cents ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN account_id=? THEN credit_cents ELSE 0 END),0)
                 FROM journal_lines WHERE journal_entry_id=?",
                rusqlite::params![accounts["bank"], accounts["ar"], journal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(account_lines, (12_345, 12_345));
        let audit_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE action='record' AND entity_type='payment' AND entity_id=?",
                rusqlite::params![first["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 1);
        drop(connection);

        let active_workspace = store.get_workspace().unwrap();
        let active_payment = active_workspace["payments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|payment| payment["id"] == first["id"])
            .unwrap();
        assert_eq!(active_payment["journal_entry_is_active"].as_i64(), Some(1));
        assert_eq!(active_payment["journal_reversal_depth"].as_i64(), Some(0));

        let reversal_error = store
            .reverse_journal_entry(&journal_id, "2026-09-03", None)
            .unwrap_err();
        assert!(reversal_error
            .to_string()
            .contains("encaissement client ne peut pas être extournée isolément"));
        let protected_workspace = store.get_workspace().unwrap();
        let protected_payment = protected_workspace["payments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|payment| payment["id"] == first["id"])
            .unwrap();
        assert_eq!(
            protected_payment["journal_entry_is_active"].as_i64(),
            Some(1)
        );
        assert_eq!(
            protected_payment["journal_reversal_depth"].as_i64(),
            Some(0)
        );
        let invoice_journal_id: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=? AND source_event='issue'",
                rusqlite::params![invoice_id],
                |row| row.get(0),
            )
            .unwrap();
        let invoice_reversal_error = store
            .reverse_journal_entry(&invoice_journal_id, "2026-09-03", None)
            .unwrap_err();
        assert!(invoice_reversal_error
            .to_string()
            .contains("facture encaissée ne peut pas être extournée isolément"));
        let protected_state: (i64, String, i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT invoice.paid_cents,invoice.status,
                        (SELECT COUNT(*) FROM payments WHERE id=?2),
                        (SELECT COUNT(*) FROM journal_entries WHERE reversal_of=?3)
                 FROM invoices invoice WHERE invoice.id=?1",
                rusqlite::params![invoice_id, first["id"].as_str().unwrap(), journal_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(protected_state, (12_345, "payee".into(), 1, 0));

        // Une version antérieure à la garde pouvait avoir laissé un paiement
        // métier inactif en extournant directement son écriture. Reproduire ce
        // seul état historique par SQL, puis vérifier que Zentra autorise
        // uniquement l'extourne de la compensation terminale pour le réparer.
        let legacy_reversal_id = uuid::Uuid::new_v4().to_string();
        {
            let mut connection = store.connect().unwrap();
            let tx = connection.transaction().unwrap();
            tx.execute(
                "INSERT INTO journal_entries(id,number,entry_date,description,source_type,source_id,source_event,status,reversal_of,created_at)
                 VALUES(?1,'J-2026-LEGACY','2026-09-03','Extourne historique','journal_reversal',?2,'reverse','posted',?2,'2026-09-03T12:00:00Z')",
                rusqlite::params![legacy_reversal_id, journal_id],
            )
            .unwrap();
            type OriginalJournalLine = (
                String,
                i64,
                i64,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
            );
            let original_lines: Vec<OriginalJournalLine> = {
                let mut statement = tx
                    .prepare(
                        "SELECT account_id,debit_cents,credit_cents,currency,memo,project_id,client_id,employee_id
                         FROM journal_lines WHERE journal_entry_id=? ORDER BY rowid",
                    )
                    .unwrap();
                statement
                    .query_map(rusqlite::params![journal_id], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                        ))
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap()
            };
            for (account_id, debit, credit, currency, memo, project, client, employee) in
                original_lines
            {
                tx.execute(
                    "INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_cents,credit_cents,currency,memo,project_id,client_id,employee_id,created_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    rusqlite::params![
                        uuid::Uuid::new_v4().to_string(),
                        legacy_reversal_id,
                        account_id,
                        credit,
                        debit,
                        currency,
                        memo,
                        project,
                        client,
                        employee,
                        "2026-09-03T12:00:00Z"
                    ],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        let legacy_workspace = store.get_workspace().unwrap();
        let inactive_payment = legacy_workspace["payments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|payment| payment["id"] == first["id"])
            .unwrap();
        assert_eq!(
            inactive_payment["journal_entry_is_active"].as_i64(),
            Some(0)
        );
        assert_eq!(inactive_payment["journal_reversal_depth"].as_i64(), Some(1));

        let repair = store
            .reverse_journal_entry(
                &legacy_reversal_id,
                "2026-09-04",
                Some("Rétablissement de l'encaissement historique".into()),
            )
            .unwrap();
        assert_eq!(repair["entry"]["reversal_of"], legacy_reversal_id);
        let repair_replay = store
            .reverse_journal_entry(
                &legacy_reversal_id,
                "2026-09-04",
                Some("Rétablissement de l'encaissement historique".into()),
            )
            .unwrap();
        assert_eq!(repair_replay["id"], repair["id"]);
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM journal_entries WHERE reversal_of=?",
                    rusqlite::params![legacy_reversal_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        let repaired_workspace = store.get_workspace().unwrap();
        let repaired_payment = repaired_workspace["payments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|payment| payment["id"] == first["id"])
            .unwrap();
        assert_eq!(
            repaired_payment["journal_entry_is_active"].as_i64(),
            Some(1)
        );
        assert_eq!(repaired_payment["journal_reversal_depth"].as_i64(), Some(2));
        let repaired_invoice_state: (i64, String) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT paid_cents,status FROM invoices WHERE id=?",
                rusqlite::params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(repaired_invoice_state, (12_345, "payee".into()));

        let period = store
            .upsert_accounting_period(AccountingPeriodInput {
                id: None,
                name: "Encaissement clôturé".into(),
                date_from: "2026-09-01".into(),
                date_to: "2026-09-02".into(),
            })
            .unwrap();
        store
            .close_accounting_period(period["id"].as_str().unwrap())
            .unwrap();

        let replay = store.record_payment(request).unwrap();
        assert_eq!(replay["id"], first["id"]);
        assert_eq!(replay["journal_entry_id"], journal_id);
        let workspace = store.get_workspace().unwrap();
        let payment = workspace["payments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|payment| payment["id"] == first["id"])
            .unwrap();
        assert_eq!(payment["journal_entry_id"], journal_id);
        assert_eq!(
            payment["journal_source_event"],
            format!("invoice:{invoice_id}")
        );
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM payments WHERE invoice_id=?",
                    rusqlite::params![invoice_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM journal_entries WHERE source_type='payment' AND source_id=?",
                    rusqlite::params![first["id"].as_str().unwrap()],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM audit_log WHERE action='record' AND entity_type='payment' AND entity_id=?",
                    rusqlite::params![first["id"].as_str().unwrap()],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
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
    fn close_period_refuses_historical_foreign_currency_used_by_cumulative_balance_sheet() {
        let (_temporary, store) = initialized_store();
        let accounts = accounting_accounts(&store);
        store
            .post_manual_journal_entry(ManualJournalInput {
                entry_date: "2025-12-31".into(),
                description: "Solde historique en devise étrangère".into(),
                currency: "EUR".into(),
                lines: vec![
                    ManualJournalLineInput {
                        account_id: accounts["bank"].clone(),
                        debit_cents: 10_000,
                        credit_cents: 0,
                        memo: None,
                        project_id: None,
                        client_id: None,
                        employee_id: None,
                    },
                    ManualJournalLineInput {
                        account_id: accounts["ar"].clone(),
                        debit_cents: 0,
                        credit_cents: 10_000,
                        memo: None,
                        project_id: None,
                        client_id: None,
                        employee_id: None,
                    },
                ],
            })
            .unwrap();
        let period = store
            .upsert_accounting_period(AccountingPeriodInput {
                id: None,
                name: "Exercice CHF 2026".into(),
                date_from: "2026-01-01".into(),
                date_to: "2026-12-31".into(),
            })
            .unwrap();
        let period_id = period["id"].as_str().unwrap();

        let error = store
            .close_accounting_period(period_id)
            .unwrap_err()
            .to_string();
        assert!(error.contains("EUR"));
        let status: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT status FROM accounting_periods WHERE id=?",
                rusqlite::params![period_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "open");
    }

    #[test]
    fn reminders_wait_between_levels_and_cancel_when_settled() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let today = chrono::Local::now().date_naive();
        let issue_date = today
            .checked_sub_days(chrono::Days::new(60))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let due_date = today
            .checked_sub_days(chrono::Days::new(30))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let as_of = today.format("%Y-%m-%d").to_string();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client relance"))
                .unwrap(),
        );
        let invoice_id=value_id(&store.create_record("invoices",json!({"client_id":client_id,"title":"Facture échue","service_date_from":"2026-01-01","service_date_to":"2026-01-31"})).unwrap());
        store.create_record("invoice_items",json!({"invoice_id":invoice_id,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0})).unwrap();
        store
            .issue_invoice(&invoice_id, Some(issue_date), Some(due_date))
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
                payment_deadline_days: 10,
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
                payment_deadline_days: 10,
                active: true,
            })
            .unwrap();
        let first = store.generate_due_reminders(Some(as_of.clone())).unwrap();
        assert_eq!(first["created"].as_array().unwrap().len(), 1);
        assert_eq!(first["created"][0]["level"], 1);
        assert_eq!(first["created"][0]["balance_cents"], 10000);
        let second = store.generate_due_reminders(Some(as_of.clone())).unwrap();
        assert_eq!(second["created"].as_array().unwrap().len(), 0);
        let first_reminder_id = first["created"][0]["id"].as_str().unwrap().to_owned();
        assert!(store
            .mark_reminder(MarkReminderInput {
                id: first_reminder_id.clone(),
                status: "completed".into(),
                note: Some("Tentative de clôture sans preuve d’envoi".into()),
            })
            .is_err());
        let preview = store
            .preview_reminder_delivery(ReminderPreviewInput {
                id: first_reminder_id.clone(),
                prepared_on: Some(as_of.clone()),
            })
            .unwrap();
        store
            .record_reminder_action(ReminderActionInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                id: first_reminder_id.clone(),
                action: "manual_sent".into(),
                prepared_on: Some(as_of.clone()),
                preview_sha256: preview["preview_sha256"].as_str().map(str::to_owned),
                note: Some("Premier niveau envoyé et confirmé".into()),
            })
            .unwrap();
        let third = store.generate_due_reminders(Some(as_of.clone())).unwrap();
        assert_eq!(third["created"].as_array().unwrap().len(), 0);
        {
            let connection = store.connect().unwrap();
            connection
                .execute(
                    "UPDATE reminders SET snapshot_json='{}' WHERE id=?",
                    rusqlite::params![first_reminder_id],
                )
                .unwrap();
            connection
                .execute("DELETE FROM reminder_templates WHERE level=1", [])
                .unwrap();
        }
        let legacy_without_delay = store.generate_due_reminders(Some(as_of.clone())).unwrap();
        assert_eq!(legacy_without_delay["created"].as_array().unwrap().len(), 0);
        assert!(legacy_without_delay["review"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["reason"] == "previous_delay_unknown"));

        let settled_invoice_id=value_id(&store.create_record("invoices",json!({"client_id":client_id,"title":"Facture réglée","service_date_from":"2026-01-01","service_date_to":"2026-01-31"})).unwrap());
        store.create_record("invoice_items",json!({"invoice_id":settled_invoice_id,"description":"Deuxième prestation","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0})).unwrap();
        store
            .issue_invoice(
                &settled_invoice_id,
                Some(
                    today
                        .checked_sub_days(chrono::Days::new(60))
                        .unwrap()
                        .format("%Y-%m-%d")
                        .to_string(),
                ),
                Some(
                    today
                        .checked_sub_days(chrono::Days::new(30))
                        .unwrap()
                        .format("%Y-%m-%d")
                        .to_string(),
                ),
            )
            .unwrap();
        let fourth = store.generate_due_reminders(Some(as_of.clone())).unwrap();
        assert_eq!(fourth["created"].as_array().unwrap().len(), 1);
        assert_eq!(fourth["created"][0]["invoice_id"], settled_invoice_id);
        store
            .record_payment(RecordPaymentInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                invoice_id: settled_invoice_id.clone(),
                amount_cents: 10000,
                date: Some(as_of),
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
                rusqlite::params![settled_invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(statuses, (0, 1));
    }

    #[test]
    fn reminder_cycle_is_explicit_idempotent_and_rejects_future_scans() {
        let (_temporary, store) = initialized_store();
        let before: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM reminder_templates", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(before, 0, "la migration ne doit pas semer de modèles");

        let request_id = uuid::Uuid::new_v4().to_string();
        let input = InstallReminderCycleInput {
            request_id: request_id.clone(),
            sender_name: Some("Entreprise de test".into()),
        };
        let installed = store.install_reminder_cycle(input.clone()).unwrap();
        assert_eq!(installed["idempotent"], false);
        assert_eq!(installed["created_levels"], json!([1, 2, 3]));
        assert_eq!(installed["templates"].as_array().unwrap().len(), 3);
        assert_eq!(installed["settings"]["enabled"], true);

        let replay = store.install_reminder_cycle(input).unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM reminder_templates", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        let conflict = store
            .install_reminder_cycle(InstallReminderCycleInput {
                request_id,
                sender_name: Some("Autre expéditeur".into()),
            })
            .unwrap_err()
            .to_string();
        assert!(conflict.contains("déjà été utilisé"));

        let tomorrow = chrono::Local::now()
            .date_naive()
            .checked_add_days(chrono::Days::new(1))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let future = store
            .scan_due_reminders(ScanRemindersInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                as_of: Some(tomorrow),
            })
            .unwrap_err()
            .to_string();
        assert!(future.contains("futur"));
    }

    #[test]
    fn reminder_cycle_installation_reactivates_defaults_and_rejects_global_conflicts() {
        let (_temporary, store) = initialized_store();
        for (level, days) in [(1, 7), (2, 21), (3, 35)] {
            store
                .upsert_reminder_template(ReminderTemplateInput {
                    id: None,
                    level,
                    name: format!("Niveau {level}"),
                    subject: "Facture {invoice_number}".into(),
                    body: "Solde {balance}".into(),
                    days_after_due: days,
                    payment_deadline_days: 10,
                    active: false,
                })
                .unwrap();
        }
        let installed = store
            .install_reminder_cycle(InstallReminderCycleInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                sender_name: Some("Entreprise de test".into()),
            })
            .unwrap();
        assert_eq!(installed["created_levels"], json!([]));
        assert_eq!(installed["reactivated_levels"], json!([1, 2, 3]));
        assert!(installed["templates"]
            .as_array()
            .unwrap()
            .iter()
            .all(|template| template["active"] == true));

        let (_conflict_temporary, conflict_store) = initialized_store();
        conflict_store
            .upsert_reminder_template(ReminderTemplateInput {
                id: None,
                level: 4,
                name: "Niveau conflictuel".into(),
                subject: "Facture {invoice_number}".into(),
                body: "Solde {balance}".into(),
                days_after_due: 30,
                payment_deadline_days: 10,
                active: true,
            })
            .unwrap();
        let error = conflict_store
            .install_reminder_cycle(InstallReminderCycleInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                sender_name: Some("Entreprise de test".into()),
            })
            .unwrap_err()
            .to_string();
        assert!(error.contains("strictement croissants"));
        let connection = conflict_store.connect().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM reminder_templates", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COALESCE(MAX(enabled),0) FROM reminder_settings",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn automatic_noop_reminder_scans_are_idempotent_and_bounded() {
        let (_temporary, store) = initialized_store();
        store
            .install_reminder_cycle(InstallReminderCycleInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                sender_name: Some("Entreprise de test".into()),
            })
            .unwrap();
        let today = chrono::Local::now()
            .date_naive()
            .format("%Y-%m-%d")
            .to_string();
        let connection = store.connect().unwrap();
        let operations_before: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM reminder_operation_requests",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);

        let first_input = ScanRemindersInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            as_of: Some(today.clone()),
        };
        let first = store.scan_due_reminders(first_input.clone()).unwrap();
        assert_eq!(first["idempotent"], false);
        let replay = store.scan_due_reminders(first_input).unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(replay["created"], first["created"]);
        assert_eq!(replay["cancelled"], first["cancelled"]);
        assert_eq!(replay["promoted"], first["promoted"]);

        // Plus de deux jours de contrôles automatiques toutes les cinq minutes.
        for _ in 0..600 {
            let response = store
                .scan_due_reminders(ScanRemindersInput {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    as_of: Some(today.clone()),
                })
                .unwrap();
            assert_eq!(response["idempotent"], false);
            assert!(response["created"].as_array().unwrap().is_empty());
            assert!(response["cancelled"].as_array().unwrap().is_empty());
            assert!(response["promoted"].as_array().unwrap().is_empty());
        }

        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM reminder_operation_requests",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .unwrap(),
            operations_before + crate::reminders::MAX_RETAINED_NOOP_SCAN_REQUESTS
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM reminder_operation_requests WHERE operation='scan'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            crate::reminders::MAX_RETAINED_NOOP_SCAN_REQUESTS
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM audit_log WHERE action='scan' AND entity_type='reminders'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT last_scan_at IS NOT NULL FROM reminder_settings WHERE id=1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn planned_reminder_becomes_due_only_during_its_local_scan() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let today = chrono::Local::now().date_naive();
        let today_text = today.format("%Y-%m-%d").to_string();
        let issue_date = today
            .checked_sub_days(chrono::Days::new(10))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let due_date = today
            .checked_sub_days(chrono::Days::new(7))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client planifié"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture planifiée",
                        "service_date_from":issue_date,
                        "service_date_to":issue_date
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({"invoice_id":invoice_id,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0}),
            )
            .unwrap();
        store
            .issue_invoice(&invoice_id, Some(issue_date), Some(due_date.clone()))
            .unwrap();
        store
            .install_reminder_cycle(InstallReminderCycleInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                sender_name: Some("Entreprise de test".into()),
            })
            .unwrap();
        let reminder_id = uuid::Uuid::new_v4().to_string();
        {
            let connection = store.connect().unwrap();
            let template_id: String = connection
                .query_row(
                    "SELECT id FROM reminder_templates WHERE level=1",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let (number, total_cents, currency): (String, i64, String) = connection
                .query_row(
                    "SELECT number,total_cents,currency FROM invoices WHERE id=?",
                    rusqlite::params![invoice_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO reminders(id,invoice_id,template_id,level,scheduled_date,status,subject,body,invoice_number,currency,invoice_total_cents,balance_cents,payment_deadline_days,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,'planned',?,?,?,?,?,?,?,?,?,?)",
                    rusqlite::params![reminder_id,invoice_id,template_id,1,today_text,"Facture planifiée","Solde ouvert",number,currency,total_cents,total_cents,10,json!({"days_after_due":7,"template_subject":"Facture {invoice_number}","template_body":"Solde {balance}"}).to_string(),now_iso(),now_iso()],
                )
                .unwrap();
        }
        let scan_input = ScanRemindersInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            as_of: Some(today_text),
        };
        let scan = store.scan_due_reminders(scan_input.clone()).unwrap();
        assert_eq!(scan["promoted"], json!([reminder_id]));
        let replay = store.scan_due_reminders(scan_input).unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(replay["promoted"], json!([reminder_id]));
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM reminders WHERE id=?",
                    rusqlite::params![reminder_id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "due"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM reminder_history WHERE reminder_id=? AND action='due'",
                    rusqlite::params![reminder_id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM reminder_operation_requests WHERE operation='scan'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM audit_log WHERE action='scan' AND entity_type='reminders'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn reminder_scan_blocks_a_next_level_with_a_shorter_historical_delay() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let today = chrono::Local::now().date_naive();
        let today_text = today.format("%Y-%m-%d").to_string();
        let issue_date = today
            .checked_sub_days(chrono::Days::new(70))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let due_date = today
            .checked_sub_days(chrono::Days::new(60))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client délai historique"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture délai historique",
                        "service_date_from":issue_date,
                        "service_date_to":issue_date
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({"invoice_id":invoice_id,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0}),
            )
            .unwrap();
        store
            .issue_invoice(&invoice_id, Some(issue_date), Some(due_date))
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
                level: 2,
                name: "Niveau raccourci".into(),
                subject: "Facture {invoice_number}".into(),
                body: "Solde {balance}".into(),
                days_after_due: 10,
                payment_deadline_days: 10,
                active: true,
            })
            .unwrap();
        let reminder_id = uuid::Uuid::new_v4().to_string();
        let occurred_at = format!("{today_text}T12:00:00+00:00");
        {
            let connection = store.connect().unwrap();
            let (number, total_cents, currency): (String, i64, String) = connection
                .query_row(
                    "SELECT number,total_cents,currency FROM invoices WHERE id=?",
                    rusqlite::params![invoice_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO reminders(id,invoice_id,template_id,level,scheduled_date,status,subject,body,invoice_number,currency,invoice_total_cents,balance_cents,payment_deadline_days,snapshot_json,created_at,updated_at) VALUES(?,?,NULL,1,?,'completed',?,?,?,?,?,?,10,?,?,?)",
                    rusqlite::params![reminder_id,invoice_id,today_text,"Ancien rappel","Solde",number,currency,total_cents,total_cents,json!({"days_after_due":30}).to_string(),now_iso(),now_iso()],
                )
                .unwrap();
            for action in ["sent_manually", "completed"] {
                connection
                    .execute(
                        "INSERT INTO reminder_history(id,reminder_id,action,occurred_at,note) VALUES(?,?,?,?,NULL)",
                        rusqlite::params![uuid::Uuid::new_v4().to_string(),reminder_id,action,occurred_at],
                    )
                    .unwrap();
            }
        }

        let scan = store
            .scan_due_reminders(ScanRemindersInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                as_of: Some(today_text),
            })
            .unwrap();
        assert!(scan["created"].as_array().unwrap().is_empty());
        assert!(scan["review"].as_array().unwrap().iter().any(|item| {
            item["invoice_id"] == invoice_id && item["reason"] == "non_increasing_historical_delay"
        }));
    }

    #[test]
    fn legacy_manual_send_date_delays_the_next_level_even_if_completed_was_earlier() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let today = chrono::Local::now().date_naive();
        let today_text = today.format("%Y-%m-%d").to_string();
        let issue_date = today
            .checked_sub_days(chrono::Days::new(50))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let due_date = today
            .checked_sub_days(chrono::Days::new(40))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let completed_at = format!(
            "{}T12:00:00+00:00",
            today
                .checked_sub_days(chrono::Days::new(12))
                .unwrap()
                .format("%Y-%m-%d")
        );
        let sent_at = format!(
            "{}T12:00:00+00:00",
            today
                .checked_sub_days(chrono::Days::new(4))
                .unwrap()
                .format("%Y-%m-%d")
        );
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client historique V23"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture historique V23",
                        "service_date_from":issue_date,
                        "service_date_to":issue_date
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({"invoice_id":invoice_id,"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0}),
            )
            .unwrap();
        store
            .issue_invoice(&invoice_id, Some(issue_date), Some(due_date))
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
                level: 2,
                name: "Niveau suivant".into(),
                subject: "Facture {invoice_number}".into(),
                body: "Solde {balance}".into(),
                days_after_due: 40,
                payment_deadline_days: 10,
                active: true,
            })
            .unwrap();
        let reminder_id = uuid::Uuid::new_v4().to_string();
        {
            let connection = store.connect().unwrap();
            let (number, total_cents, currency): (String, i64, String) = connection
                .query_row(
                    "SELECT number,total_cents,currency FROM invoices WHERE id=?",
                    rusqlite::params![invoice_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO reminders(id,invoice_id,template_id,level,scheduled_date,status,subject,body,invoice_number,currency,invoice_total_cents,balance_cents,payment_deadline_days,snapshot_json,created_at,updated_at) VALUES(?,?,NULL,1,?,'completed',?,?,?,?,?,?,10,?,?,?)",
                    rusqlite::params![reminder_id,invoice_id,today_text,"Ancien rappel","Solde",number,currency,total_cents,total_cents,json!({"days_after_due":30}).to_string(),now_iso(),now_iso()],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO reminder_history(id,reminder_id,action,occurred_at,note) VALUES(?,?,'sent_manually',?,NULL)",
                    rusqlite::params![uuid::Uuid::new_v4().to_string(),reminder_id,sent_at],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO reminder_history(id,reminder_id,action,occurred_at,note) VALUES(?,?,'completed',?,NULL)",
                    rusqlite::params![uuid::Uuid::new_v4().to_string(),reminder_id,completed_at],
                )
                .unwrap();
        }

        let scan = store
            .scan_due_reminders(ScanRemindersInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                as_of: Some(today_text),
            })
            .unwrap();
        assert!(scan["created"].as_array().unwrap().is_empty());
        assert!(scan["review"].as_array().unwrap().is_empty());
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM reminders WHERE invoice_id=? AND level=2",
                    rusqlite::params![invoice_id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn reminder_preview_revalidates_partial_payment_and_delivery_proof() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let today = chrono::Local::now().date_naive();
        let today_text = today.format("%Y-%m-%d").to_string();
        let client_id = value_id(
            &store
                .create_record(
                    "clients",
                    json!({
                        "name":"Client réel",
                        "company":"Client SA",
                        "email":"finance@example.invalid",
                        "phone":"+41791234567",
                        "address_line1":"Rue du Test 1",
                        "postal_code":"1000",
                        "city":"Lausanne"
                    }),
                )
                .unwrap(),
        );
        let invoice_id=value_id(&store.create_record("invoices",json!({"client_id":client_id,"title":"Facture avec acompte","service_date_from":"2026-01-01","service_date_to":"2026-01-31"})).unwrap());
        store.create_record("invoice_items",json!({"invoice_id":invoice_id,"description":"Prestation réelle","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0})).unwrap();
        store
            .issue_invoice(
                &invoice_id,
                Some(
                    today
                        .checked_sub_days(chrono::Days::new(60))
                        .unwrap()
                        .format("%Y-%m-%d")
                        .to_string(),
                ),
                Some(
                    today
                        .checked_sub_days(chrono::Days::new(30))
                        .unwrap()
                        .format("%Y-%m-%d")
                        .to_string(),
                ),
            )
            .unwrap();
        store
            .install_reminder_cycle(InstallReminderCycleInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                sender_name: Some("Entreprise de test".into()),
            })
            .unwrap();
        let scan_input = ScanRemindersInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            as_of: Some(today_text.clone()),
        };
        let scan = store.scan_due_reminders(scan_input.clone()).unwrap();
        assert_eq!(scan["created"].as_array().unwrap().len(), 1);
        let scan_replay = store.scan_due_reminders(scan_input).unwrap();
        assert_eq!(scan_replay["idempotent"], true);
        let reminder_id = scan["created"][0]["id"].as_str().unwrap().to_owned();
        let initial_preview = store
            .preview_reminder_delivery(ReminderPreviewInput {
                id: reminder_id.clone(),
                prepared_on: Some(today_text.clone()),
            })
            .unwrap();
        assert_eq!(initial_preview["current_balance_cents"], 10000);
        assert_eq!(initial_preview["recipient_phone"], "+41791234567");
        assert!(initial_preview["sms_body"]
            .as_str()
            .unwrap()
            .contains("facture"));
        let yesterday_text = today
            .checked_sub_days(chrono::Days::new(1))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let stale_day_error = store
            .record_reminder_action(ReminderActionInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                id: reminder_id.clone(),
                action: "mail_draft_created".into(),
                prepared_on: Some(yesterday_text),
                preview_sha256: initial_preview["preview_sha256"]
                    .as_str()
                    .map(str::to_owned),
                note: None,
            })
            .unwrap_err()
            .to_string();
        assert!(stale_day_error.contains("autre jour"));
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM reminder_deliveries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        store
            .update_record(
                "clients",
                &client_id,
                json!({"address_line1":"","postal_code":"","city":""}),
            )
            .unwrap();
        let cleared_address_preview = store
            .preview_reminder_delivery(ReminderPreviewInput {
                id: reminder_id.clone(),
                prepared_on: Some(today_text.clone()),
            })
            .unwrap();
        assert_eq!(cleared_address_preview["client"]["address_line1"], "");
        assert_eq!(cleared_address_preview["client"]["postal_code"], "");
        assert_eq!(cleared_address_preview["client"]["city"], "");

        store
            .record_payment(RecordPaymentInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                invoice_id: invoice_id.clone(),
                amount_cents: 2500,
                date: Some(today_text.clone()),
                method: Some("bank".into()),
                reference: Some("ACOMPTE".into()),
                notes: None,
            })
            .unwrap();
        let listed = store.list_reminders(Default::default()).unwrap();
        assert_eq!(listed[0]["live_balance_cents"], 7500);
        assert_eq!(listed[0]["snapshot_stale"], 1);

        let stale_error = store
            .record_reminder_action(ReminderActionInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                id: reminder_id.clone(),
                action: "mail_draft_created".into(),
                prepared_on: Some(today_text.clone()),
                preview_sha256: initial_preview["preview_sha256"]
                    .as_str()
                    .map(str::to_owned),
                note: None,
            })
            .unwrap_err()
            .to_string();
        assert!(stale_error.contains("Actualisez"));

        let refreshed = store
            .preview_reminder_delivery(ReminderPreviewInput {
                id: reminder_id.clone(),
                prepared_on: Some(today_text.clone()),
            })
            .unwrap();
        assert_eq!(refreshed["current_balance_cents"], 7500);
        assert_eq!(refreshed["snapshot_stale"], true);
        assert!(refreshed["body"].as_str().unwrap().contains("CHF 75.00"));

        let draft_action = ReminderActionInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            id: reminder_id.clone(),
            action: "mail_draft_created".into(),
            prepared_on: Some(today_text.clone()),
            preview_sha256: refreshed["preview_sha256"].as_str().map(str::to_owned),
            note: None,
        };
        let drafted = store.record_reminder_action(draft_action.clone()).unwrap();
        assert_eq!(drafted["blocked"], false);
        assert_eq!(drafted["reminder"]["status"], "due");
        let draft_replay = store.record_reminder_action(draft_action).unwrap();
        assert_eq!(draft_replay["idempotent"], true);
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM reminder_deliveries WHERE reminder_id=?",
                    rusqlite::params![reminder_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        let exported_workspace = store.get_workspace().unwrap();
        assert_eq!(
            exported_workspace["reminder_deliveries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            exported_workspace["reminder_deliveries"][0]["action"],
            "mail_draft_created"
        );
        assert_eq!(
            exported_workspace["reminder_deliveries"][0]["current_balance_cents"],
            7500
        );
        assert!(
            exported_workspace["reminder_deliveries"][0]["payload_sha256"]
                .as_str()
                .is_some_and(|value| value.len() == 64)
        );

        let sent = store
            .record_reminder_action(ReminderActionInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                id: reminder_id.clone(),
                action: "manual_sent".into(),
                prepared_on: Some(today_text),
                preview_sha256: refreshed["preview_sha256"].as_str().map(str::to_owned),
                note: Some("E-mail envoyé depuis Outlook".into()),
            })
            .unwrap();
        assert_eq!(sent["reminder"]["status"], "completed");
        assert!(store
            .mark_reminder(MarkReminderInput {
                id: reminder_id,
                status: "cancelled".into(),
                note: Some("Tentative de retour arrière".into()),
            })
            .is_err());
    }

    #[test]
    fn reminder_action_idempotent_replay_survives_a_stale_preparation_date() {
        let (_temporary, store) = initialized_store();
        let request_id = uuid::Uuid::new_v4().to_string();
        let yesterday = chrono::Local::now()
            .date_naive()
            .checked_sub_days(chrono::Days::new(1))
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let input = ReminderActionInput {
            request_id: request_id.clone(),
            id: uuid::Uuid::new_v4().to_string(),
            action: "manual_sent".into(),
            prepared_on: Some(yesterday),
            preview_sha256: Some("a".repeat(64)),
            note: Some("Envoi confirmé".into()),
        };
        let mut payload = serde_json::to_value(&input).unwrap();
        payload.as_object_mut().unwrap().remove("request_id");
        let payload_json = serde_json::to_string(&payload).unwrap();
        let payload_sha256 = format!("{:x}", Sha256::digest(payload_json.as_bytes()));
        let stored_response = json!({
            "blocked": false,
            "delivery": {"id": "preuve-déjà-enregistrée"},
            "reminder": null,
            "idempotent": false
        })
        .to_string();
        store
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO reminder_operation_requests(request_id,operation,payload_sha256,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?)",
                rusqlite::params![request_id,"record_action",payload_sha256,payload_json,stored_response,now_iso()],
            )
            .unwrap();

        let replay = store.record_reminder_action(input).unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(replay["delivery"]["id"], "preuve-déjà-enregistrée");
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
                lpp_component: None,
                lpp_employee_id: None,
                source: "https://www.bsv.admin.ch/fr/cotisations-apercu".into(),
                effective_from: "2026-01-01".into(),
                effective_to: Some("2026-12-31".into()),
                active: true,
                liability_account_id: None,
                expense_account_id: None,
            })
            .unwrap();
        let definition_id = value_id(&definition);
        let employee_id = value_id(
            &store
                .create_record(
                    "employees",
                    json!({
                        "name":"Employé cotisations",
                        "birth_date":"1990-05-01",
                        "employment_start_date":"2026-01-01",
                        "ac_opening_year":2026,
                        "ac_opening_basis_cents":14_700_000,
                        "small_salary_assessment_year":2026,
                        "small_salary_decision_date":"2026-01-01",
                        "small_salary_sector":"ordinary",
                        "small_salary_employee_requested_contributions":false,
                        "small_salary_opening_gross_cents":0,
                        "small_salary_opening_contributed_basis_cents":0,
                        "small_salary_evidence_reference":"Décision annuelle test 2026"
                    }),
                )
                .unwrap(),
        );
        let derived =
            store.calculate_employee_payroll_contributions(CalculateEmployeePayrollInput {
                employee_id: employee_id.clone(),
                period: "2026-12".into(),
                payment_date: None,
                gross_cents: 500000,
                items: vec![ContributionSelectionInput {
                    definition_id: definition_id.clone(),
                    basis_cents: Some(500_000),
                    year_to_date_basis_cents: None,
                }],
            });
        let derived = derived.unwrap();
        assert_eq!(derived["items"][0]["year_to_date_basis_cents"], 14_700_000);
        assert_eq!(derived["items"][0]["basis_cents"], 120_000);
        let selection = ContributionSelectionInput {
            definition_id: definition_id.clone(),
            basis_cents: Some(500000),
            year_to_date_basis_cents: Some(14_700_000),
        };
        let calculated = store
            .calculate_employee_payroll_contributions(CalculateEmployeePayrollInput {
                employee_id: employee_id.clone(),
                period: "2026-12".into(),
                payment_date: None,
                gross_cents: 500000,
                items: vec![selection.clone()],
            })
            .unwrap();
        assert_eq!(calculated["items"][0]["basis_cents"], 120000);
        assert_eq!(calculated["items"][0]["amount_cents"], 1320);
        let payslip_id = value_id(
            &store
                .create_record(
                    "payslips",
                    json!({"employee_id":employee_id,"period":"2026-12"}),
                )
                .unwrap(),
        );
        store.create_record("payslip_items",json!({"payslip_id":payslip_id,"position":0,"label":"Salaire brut","kind":"earning","amount_cents":500000})).unwrap();
        let applied = store
            .apply_payroll_contributions(ApplyPayrollInput {
                payslip_id: payslip_id.clone(),
                period: "2026-12".into(),
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
    fn ac_partial_year_preview_and_saved_payslip_share_the_same_30_360_ceiling() {
        let (_temporary, store) = initialized_store();
        let definition = store
            .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                id: None,
                code: "AC_PARTIAL_YEAR".into(),
                label: "AC année partielle".into(),
                category: "ac".into(),
                side: "employee".into(),
                calculation_kind: "rate".into(),
                rate_bp: Some(110),
                fixed_amount_cents: None,
                annual_ceiling_cents: Some(14_820_000),
                basis_kind: "ahv_salary".into(),
                lpp_component: None,
                lpp_employee_id: None,
                source: "https://www.ahv-iv.ch/p/2.08.f".into(),
                effective_from: "2026-01-01".into(),
                effective_to: Some("2026-12-31".into()),
                active: true,
                liability_account_id: None,
                expense_account_id: None,
            })
            .unwrap();
        let employee_id = value_id(
            &store
                .create_record(
                    "employees",
                    json!({
                        "name":"Employé année partielle",
                        "birth_date":"1990-01-01",
                        "employment_start_date":"2026-04-15",
                        "employment_end_date":"2026-12-29",
                        "ac_opening_year":2026,
                        "ac_opening_basis_cents":10_000_000,
                        "small_salary_assessment_year":2026,
                        "small_salary_decision_date":"2026-01-01",
                        "small_salary_sector":"ordinary",
                        "small_salary_employee_requested_contributions":false,
                        "small_salary_opening_gross_cents":0,
                        "small_salary_opening_contributed_basis_cents":0,
                        "small_salary_evidence_reference":"Décision annuelle test 2026"
                    }),
                )
                .unwrap(),
        );
        let selection = ContributionSelectionInput {
            definition_id: value_id(&definition),
            basis_cents: Some(20_000_000),
            year_to_date_basis_cents: Some(10_000_000),
        };
        let preview = store
            .calculate_employee_payroll_contributions(CalculateEmployeePayrollInput {
                employee_id: employee_id.clone(),
                period: "2026-12".into(),
                payment_date: None,
                gross_cents: 20_000_000,
                items: vec![selection.clone()],
            })
            .unwrap();
        assert_eq!(preview["items"][0]["ac_proration_days_30_360"], 255);
        assert_eq!(preview["items"][0]["annual_ceiling_cents"], 10_497_500);
        assert_eq!(preview["items"][0]["basis_cents"], 497_500);
        assert_eq!(preview["items"][0]["amount_cents"], 5_475);

        let saved = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id,
                period: "2026-12".into(),
                status: "a_controler".into(),
                payment_date: None,
                notes: None,
                lines: vec![PayslipManualLineInput {
                    id: None,
                    label: "Salaire brut".into(),
                    kind: "earning".into(),
                    amount_cents: 20_000_000,
                    posting_account_id: None,
                    expense_account_id: None,
                }],
                contributions: vec![selection],
            })
            .unwrap();
        assert_eq!(saved["calculation"]["items"][0]["basis_cents"], 497_500);
        assert_eq!(saved["contributions"][0]["basis_cents"], 497_500);
        assert_eq!(
            saved["contributions"][0]["annual_ceiling_cents"],
            10_497_500
        );
        assert_eq!(saved["contributions"][0]["amount_cents"], 5_475);
    }

    #[test]
    fn reference_age_choices_drive_avs_allowance_and_reject_ac() {
        let (_temporary, store) = initialized_store();
        let avs = store
            .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                id: None,
                code: "AVS_REFERENCE_AGE".into(),
                label: "AVS après âge de référence".into(),
                category: "avs_ai_apg".into(),
                side: "employee".into(),
                calculation_kind: "rate".into(),
                rate_bp: Some(435),
                fixed_amount_cents: None,
                annual_ceiling_cents: None,
                basis_kind: "ahv_salary".into(),
                lpp_component: None,
                lpp_employee_id: None,
                source: "Source officielle".into(),
                effective_from: "2026-01-01".into(),
                effective_to: Some("2026-12-31".into()),
                active: true,
                liability_account_id: None,
                expense_account_id: None,
            })
            .unwrap();
        let ac = store
            .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                id: None,
                code: "AC_REFERENCE_AGE".into(),
                label: "AC après âge de référence".into(),
                category: "ac".into(),
                side: "employee".into(),
                calculation_kind: "rate".into(),
                rate_bp: Some(110),
                fixed_amount_cents: None,
                annual_ceiling_cents: Some(14_820_000),
                basis_kind: "ahv_salary".into(),
                lpp_component: None,
                lpp_employee_id: None,
                source: "Source officielle".into(),
                effective_from: "2026-01-01".into(),
                effective_to: Some("2026-12-31".into()),
                active: true,
                liability_account_id: None,
                expense_account_id: None,
            })
            .unwrap();
        let employee_id = value_id(
            &store
                .create_record(
                    "employees",
                    json!({
                        "name":"Employé après référence",
                        "birth_date":"1950-01-01",
                        "employment_start_date":"2020-01-01",
                        "reference_age_date":"2015-01-01",
                        "avs_allowance_waived":false,
                        "small_salary_assessment_year":2026,
                        "small_salary_decision_date":"2026-01-01",
                        "small_salary_sector":"ordinary",
                        "small_salary_employee_requested_contributions":false,
                        "small_salary_opening_gross_cents":0,
                        "small_salary_opening_contributed_basis_cents":0,
                        "small_salary_evidence_reference":"Décision annuelle test 2026"
                    }),
                )
                .unwrap(),
        );
        let avs_input = |employee_id: &str| CalculateEmployeePayrollInput {
            employee_id: employee_id.into(),
            period: "2026-08".into(),
            payment_date: None,
            gross_cents: 500_000,
            items: vec![ContributionSelectionInput {
                definition_id: value_id(&avs),
                basis_cents: Some(500_000),
                year_to_date_basis_cents: None,
            }],
        };
        let allowance = store
            .calculate_employee_payroll_contributions(avs_input(&employee_id))
            .unwrap();
        assert_eq!(allowance["items"][0]["original_basis_cents"], 500_000);
        assert_eq!(allowance["items"][0]["basis_cents"], 360_000);
        assert_eq!(
            allowance["items"][0]["avs_allowance_applied_cents"],
            140_000
        );
        assert_eq!(allowance["items"][0]["amount_cents"], 15_660);

        store
            .update_record(
                "employees",
                &employee_id,
                json!({"avs_allowance_waived":true}),
            )
            .unwrap();
        let waived = store
            .calculate_employee_payroll_contributions(avs_input(&employee_id))
            .unwrap();
        assert_eq!(waived["items"][0]["basis_cents"], 500_000);
        assert_eq!(waived["items"][0]["amount_cents"], 21_750);

        store
            .update_record(
                "employees",
                &employee_id,
                json!({"avs_allowance_waived":null}),
            )
            .unwrap();
        assert!(store
            .calculate_employee_payroll_contributions(avs_input(&employee_id))
            .is_err());
        assert!(store
            .calculate_employee_payroll_contributions(CalculateEmployeePayrollInput {
                employee_id,
                period: "2026-08".into(),
                payment_date: None,
                gross_cents: 500_000,
                items: vec![ContributionSelectionInput {
                    definition_id: value_id(&ac),
                    basis_cents: Some(500_000),
                    year_to_date_basis_cents: Some(0),
                }],
            })
            .is_err());
    }

    #[test]
    fn statutory_groups_reject_divergent_avs_and_ac_bases_before_calculation() {
        let (_temporary, store) = initialized_store();
        let create_definition =
            |code: &str, category: &str, side: &str, rate_bp: i64, ceiling: Option<i64>| {
                value_id(
                    &store
                        .upsert_payroll_contribution_definition(ContributionDefinitionInput {
                            id: None,
                            code: code.into(),
                            label: code.into(),
                            category: category.into(),
                            side: side.into(),
                            calculation_kind: "rate".into(),
                            rate_bp: Some(rate_bp),
                            fixed_amount_cents: None,
                            annual_ceiling_cents: ceiling,
                            basis_kind: "ahv_salary".into(),
                            lpp_component: None,
                            lpp_employee_id: None,
                            source: "Source officielle".into(),
                            effective_from: "2026-01-01".into(),
                            effective_to: Some("2026-12-31".into()),
                            active: true,
                            liability_account_id: None,
                            expense_account_id: None,
                        })
                        .unwrap(),
                )
            };
        let avs_employee = create_definition("AVS_SHARED_E", "avs_ai_apg", "employee", 435, None);
        let avs_employer = create_definition("AVS_SHARED_R", "avs_ai_apg", "employer", 435, None);
        let ac_employee = create_definition("AC_SHARED_E", "ac", "employee", 110, Some(14_820_000));
        let ac_employer = create_definition("AC_SHARED_R", "ac", "employer", 110, Some(14_820_000));
        let employee_id = value_id(
            &store
                .create_record(
                    "employees",
                    json!({
                        "name":"Bases sociales partagées",
                        "birth_date":"1990-01-01",
                        "employment_start_date":"2026-01-01",
                        "ac_opening_year":2026,
                        "ac_opening_basis_cents":1_000_000,
                        "small_salary_assessment_year":2026,
                        "small_salary_decision_date":"2026-01-01",
                        "small_salary_sector":"ordinary",
                        "small_salary_employee_requested_contributions":false,
                        "small_salary_opening_gross_cents":0,
                        "small_salary_opening_contributed_basis_cents":0,
                        "small_salary_evidence_reference":"Décision annuelle test 2026"
                    }),
                )
                .unwrap(),
        );
        let calculate = |items| {
            store.calculate_employee_payroll_contributions(CalculateEmployeePayrollInput {
                employee_id: employee_id.clone(),
                period: "2026-12".into(),
                payment_date: None,
                gross_cents: 500_000,
                items,
            })
        };

        let avs_error = calculate(vec![
            ContributionSelectionInput {
                definition_id: avs_employee.clone(),
                basis_cents: Some(500_000),
                year_to_date_basis_cents: None,
            },
            ContributionSelectionInput {
                definition_id: avs_employer.clone(),
                basis_cents: Some(1),
                year_to_date_basis_cents: None,
            },
        ])
        .unwrap_err()
        .to_string();
        assert!(avs_error.contains("base AVS/AI/APG"), "{avs_error}");

        let ac_basis_error = calculate(vec![
            ContributionSelectionInput {
                definition_id: ac_employee.clone(),
                basis_cents: Some(500_000),
                year_to_date_basis_cents: Some(0),
            },
            ContributionSelectionInput {
                definition_id: ac_employer.clone(),
                basis_cents: Some(499_999),
                year_to_date_basis_cents: Some(0),
            },
        ])
        .unwrap_err()
        .to_string();
        assert!(ac_basis_error.contains("base AC"), "{ac_basis_error}");

        let ac_ytd_error = calculate(vec![
            ContributionSelectionInput {
                definition_id: ac_employee.clone(),
                basis_cents: Some(500_000),
                year_to_date_basis_cents: Some(1_000_000),
            },
            ContributionSelectionInput {
                definition_id: ac_employer.clone(),
                basis_cents: Some(500_000),
                year_to_date_basis_cents: Some(1_000_001),
            },
        ])
        .unwrap_err()
        .to_string();
        assert!(ac_ytd_error.contains("cumul annuel AC"), "{ac_ytd_error}");

        let consistent = calculate(vec![
            ContributionSelectionInput {
                definition_id: avs_employee,
                basis_cents: Some(500_000),
                year_to_date_basis_cents: None,
            },
            ContributionSelectionInput {
                definition_id: avs_employer,
                basis_cents: Some(500_000),
                year_to_date_basis_cents: None,
            },
            ContributionSelectionInput {
                definition_id: ac_employee,
                basis_cents: Some(500_000),
                year_to_date_basis_cents: Some(1_000_000),
            },
            ContributionSelectionInput {
                definition_id: ac_employer,
                basis_cents: Some(500_000),
                year_to_date_basis_cents: Some(1_000_000),
            },
        ])
        .unwrap();
        assert_eq!(consistent["items"][0]["original_basis_cents"], 500_000);
        assert_eq!(consistent["items"][1]["original_basis_cents"], 500_000);
        assert_eq!(
            consistent["items"][2]["basis_cents"],
            consistent["items"][3]["basis_cents"]
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
                lpp_component: None,
                lpp_employee_id: None,
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
                lpp_component: None,
                lpp_employee_id: None,
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
                payment_date: None,
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
                payment_date: None,
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
                payment_date: None,
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
                lpp_component: None,
                lpp_employee_id: None,
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
                lpp_component: None,
                lpp_employee_id: None,
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
                payment_date: None,
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
            posting_account_id: None,
            expense_account_id: None,
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
                    posting_account_id: None,
                    expense_account_id: None,
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

    #[test]
    fn reimbursement_increases_net_without_inflating_gross_or_employer_costs() {
        let (_temporary, store) = initialized_store();
        let employee_id = value_id(
            &store
                .create_record("employees", json!({"name":"Employé remboursé"}))
                .unwrap(),
        );
        let line = |label: &str, kind: &str, amount_cents: i64| PayslipManualLineInput {
            id: None,
            label: label.into(),
            kind: kind.into(),
            amount_cents,
            posting_account_id: None,
            expense_account_id: None,
        };
        let saved = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id,
                period: "2026-08".into(),
                status: "a_controler".into(),
                payment_date: None,
                notes: None,
                lines: vec![
                    line("Salaire", "earning", 500_000),
                    line("Retenue", "deduction", 50_000),
                    line("Frais remboursés", "reimbursement", 20_000),
                    line("Charge employeur", "employer", 30_000),
                ],
                contributions: Vec::new(),
            })
            .unwrap();
        assert_eq!(saved["payslip"]["gross_cents"], 500_000);
        assert_eq!(saved["payslip"]["deductions_cents"], 50_000);
        assert_eq!(saved["payslip"]["net_cents"], 470_000);
        assert_eq!(saved["payslip"]["employer_costs_cents"], 30_000);

        let low_gross = store
            .save_payslip_with_contributions(SavePayslipWithContributionsInput {
                id: None,
                employee_id: saved["payslip"]["employee_id"].as_str().unwrap().into(),
                period: "2026-09".into(),
                status: "a_controler".into(),
                payment_date: None,
                notes: None,
                lines: vec![
                    line("Gain", "earning", 100),
                    line("Retenue", "deduction", 150),
                    line("Frais", "reimbursement", 100),
                ],
                contributions: Vec::new(),
            })
            .unwrap();
        assert_eq!(low_gross["payslip"]["net_cents"], 50);
    }

    #[test]
    fn employee_country_round_trips_and_clients_can_be_archived() {
        let (_temporary, store) = initialized_store();
        let employee = store
            .create_record("employees", json!({"name":"Employé pays","country":"fr"}))
            .unwrap();
        assert_eq!(employee["country"], "FR");
        let employee = store
            .update_record(
                "employees",
                employee["id"].as_str().unwrap(),
                json!({"country":"de"}),
            )
            .unwrap();
        assert_eq!(employee["country"], "DE");

        let default_country = store
            .create_record("employees", json!({"name":"Employé suisse"}))
            .unwrap();
        assert_eq!(default_country["country"], "CH");

        let client = store
            .create_record("clients", json!({"name":"Client archivable"}))
            .unwrap();
        assert_eq!(client["archived_at"], serde_json::Value::Null);
        let client = store
            .update_record(
                "clients",
                client["id"].as_str().unwrap(),
                json!({"archived_at":"2026-09-01T10:00:00Z"}),
            )
            .unwrap();
        assert_eq!(client["archived_at"], "2026-09-01T10:00:00Z");
    }

    #[test]
    fn v17_migration_preserves_v16_people_and_adds_time_billing_invariants() {
        let temporary = tempfile::tempdir().unwrap();
        let data_dir = temporary.path().join("pre-time-billing-v16-profile");
        std::fs::create_dir_all(&data_dir).unwrap();
        let database_path = data_dir.join("helvichantier.sqlite3");
        let connection = rusqlite::Connection::open(&database_path).unwrap();
        connection.execute_batch(SCHEMA_SQL).unwrap();
        connection
            .execute_batch(
                "INSERT INTO clients(id,name,country,created_at,updated_at)
                   VALUES('client-v16','Client conservé','CH','2026-08-01','2026-08-01');
                 INSERT INTO employees(id,name,country,created_at,updated_at)
                   VALUES('employee-v16','Employé conservé','FR','2026-08-01','2026-08-01');
                 DROP TRIGGER IF EXISTS stock_invoice_no_unsafe_cancel;
                 DROP TRIGGER IF EXISTS stock_movements_no_delete;
                 DROP TRIGGER IF EXISTS stock_movements_no_update;
                 DROP TRIGGER IF EXISTS stock_movements_apply_balance;
                 DROP TRIGGER IF EXISTS stock_movements_insert_guard;
                 DROP TRIGGER IF EXISTS catalog_items_stock_history_no_delete;
                 DROP TRIGGER IF EXISTS catalog_items_track_stock_enable_guard;
                 DROP TRIGGER IF EXISTS catalog_items_track_stock_history_guard;
                 DROP TRIGGER IF EXISTS catalog_items_stock_balance_guard;
                 DROP TRIGGER IF EXISTS catalog_items_initial_stock_guard;
                 DROP TRIGGER IF EXISTS catalog_items_stock_kind_update_guard;
                 DROP TRIGGER IF EXISTS catalog_items_stock_kind_insert_guard;
                 DROP TABLE stock_movements;
                 DROP TRIGGER IF EXISTS time_billing_invoice_items_no_delete;
                 DROP TRIGGER IF EXISTS time_billing_invoice_items_no_update;
                 DROP TRIGGER IF EXISTS time_billing_invoice_items_no_insert;
                 DROP TRIGGER IF EXISTS time_billing_invoice_link_guard;
                 DROP TRIGGER IF EXISTS time_entries_billing_no_delete;
                 DROP TRIGGER IF EXISTS time_entries_billing_no_update;
                 DROP TRIGGER IF EXISTS time_billing_entries_no_update;
                 DROP TRIGGER IF EXISTS time_billing_entries_insert_guard;
                 DROP TRIGGER IF EXISTS time_billing_batches_no_update;
                 DROP TRIGGER IF EXISTS time_billing_batches_insert_guard;
                 DROP TABLE time_billing_entries;
                 DROP TABLE time_billing_batches;
                 ALTER TABLE employees DROP COLUMN country;
                 ALTER TABLE clients DROP COLUMN archived_at;
                 PRAGMA user_version=16;",
            )
            .unwrap();
        drop(connection);

        let store = LocalStore::initialize(data_dir).unwrap();
        let connection = store.connect().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let preserved: (String, String, String, Option<String>) = connection
            .query_row(
                "SELECT employee.name,employee.country,client.name,client.archived_at
                 FROM employees employee CROSS JOIN clients client
                 WHERE employee.id='employee-v16' AND client.id='client-v16'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            preserved,
            (
                "Employé conservé".into(),
                "CH".into(),
                "Client conservé".into(),
                None
            )
        );
        let v17_objects: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE (type='table' AND name IN ('time_billing_batches','time_billing_entries'))
                    OR (type='trigger' AND name IN ('time_entries_billing_no_update','time_entries_billing_no_delete'))",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(v17_objects, 4);
    }

    #[test]
    fn time_billing_is_atomic_idempotent_and_rounds_each_entry_to_the_minute() {
        let (_temporary, store) = initialized_store();
        store
            .update_settings(json!({
                "vat_registered":true,
                "default_vat_bp":810,
                "uid_number":"CHE-123.456.789"
            }))
            .unwrap();
        let (_client_id, project_id, employee_id) = time_billing_fixture(&store);
        let first = create_billable_time(&store, &project_id, &employee_id, "2026-08-31", 1, 30);
        let second =
            create_billable_time(&store, &project_id, &employee_id, "2026-09-01", 61, 10_001);
        let request_id = uuid::Uuid::new_v4().to_string();
        let created = store
            .create_invoice_from_time_entries(time_billing_input(
                &request_id,
                &project_id,
                vec![second.clone(), first.clone()],
            ))
            .unwrap();
        assert_eq!(created["idempotent"], false);
        assert_eq!(created["invoice"]["status"], "brouillon");
        assert_eq!(created["invoice"]["number"], serde_json::Value::Null);
        assert_eq!(created["invoice"]["service_date_from"], "2026-08-31");
        assert_eq!(created["invoice"]["service_date_to"], "2026-09-01");
        assert_eq!(created["invoice"]["subtotal_cents"], 10_169);
        assert_eq!(created["invoice"]["vat_cents"], 824);
        assert_eq!(created["invoice"]["total_cents"], 10_993);
        assert_eq!(created["batch"]["vat_bp"], 810);
        let amounts = created["time_billing_entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["amount_cents_snapshot"].as_i64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(amounts, vec![1, 10_168]);
        let invoice_id = created["invoice"]["id"].as_str().unwrap().to_owned();
        let batch_id = created["batch"]["id"].as_str().unwrap().to_owned();
        let audit_count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM audit_log", [], |row| row.get(0))
            .unwrap();

        let replay = store
            .create_invoice_from_time_entries(time_billing_input(
                &request_id,
                &project_id,
                vec![first, second],
            ))
            .unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(replay["invoice"]["id"], invoice_id);
        assert_eq!(replay["batch"]["id"], batch_id);
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM audit_log", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            audit_count,
            "une reprise idempotente ne doit pas créer un nouvel audit"
        );

        let mut changed = time_billing_input(&request_id, &project_id, vec![]);
        changed.time_entry_ids = replay["time_billing_entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["time_entry_id"].as_str().unwrap().to_owned())
            .collect();
        changed.title = Some("Autre facture".into());
        assert!(store.create_invoice_from_time_entries(changed).is_err());
        let counts: (i64, i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM invoices),
                        (SELECT COUNT(*) FROM time_billing_batches),
                        (SELECT COUNT(*) FROM time_billing_entries)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (1, 1, 2));

        let workspace = store.get_workspace().unwrap();
        assert!(workspace["time_entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["billing_status"] == "reserved"
                && entry["billing_invoice_id"] == invoice_id));
    }

    #[test]
    fn time_billing_refusals_leave_no_invoice_or_link() {
        let (_temporary, store) = initialized_store();
        let (_client_id, project_id, employee_id) = time_billing_fixture(&store);
        let valid =
            create_billable_time(&store, &project_id, &employee_id, "2026-09-01", 60, 10_000);
        let invalid = value_id(
            &store
                .create_record(
                    "time_entries",
                    json!({
                        "project_id":project_id,
                        "employee_id":employee_id,
                        "date":"2026-09-02",
                        "minutes":60,
                        "billable":false,
                        "billing_rate_cents":10_000,
                        "status":"approuve"
                    }),
                )
                .unwrap(),
        );
        assert!(store
            .create_invoice_from_time_entries(time_billing_input(
                &uuid::Uuid::new_v4().to_string(),
                &project_id,
                vec![valid.clone(), invalid],
            ))
            .is_err());

        let duplicate_error = store.create_invoice_from_time_entries(time_billing_input(
            &uuid::Uuid::new_v4().to_string(),
            &project_id,
            vec![valid.clone(), valid],
        ));
        assert!(duplicate_error.is_err());

        let project_without_client = value_id(
            &store
                .create_record("projects", json!({"name":"Projet sans client"}))
                .unwrap(),
        );
        let orphan_time = create_billable_time(
            &store,
            &project_without_client,
            &employee_id,
            "2026-09-03",
            60,
            10_000,
        );
        assert!(store
            .create_invoice_from_time_entries(time_billing_input(
                &uuid::Uuid::new_v4().to_string(),
                &project_without_client,
                vec![orphan_time],
            ))
            .is_err());

        let counts: (i64, i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM invoices),
                        (SELECT COUNT(*) FROM time_billing_batches),
                        (SELECT COUNT(*) FROM time_billing_entries)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (0, 0, 0));
    }

    #[test]
    fn time_billing_rolls_back_invoice_when_link_creation_fails() {
        let (_temporary, store) = initialized_store();
        let (_client_id, project_id, employee_id) = time_billing_fixture(&store);
        let time_entry_id =
            create_billable_time(&store, &project_id, &employee_id, "2026-09-01", 60, 10_000);
        store
            .connect()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER test_time_billing_link_failure
                 BEFORE INSERT ON time_billing_entries
                 BEGIN SELECT RAISE(ABORT,'simulated final link failure'); END;",
            )
            .unwrap();

        assert!(store
            .create_invoice_from_time_entries(time_billing_input(
                &uuid::Uuid::new_v4().to_string(),
                &project_id,
                vec![time_entry_id],
            ))
            .is_err());
        let counts: (i64, i64, i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM invoices),
                        (SELECT COUNT(*) FROM invoice_items),
                        (SELECT COUNT(*) FROM time_billing_batches),
                        (SELECT COUNT(*) FROM time_billing_entries)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(counts, (0, 0, 0, 0));
    }

    #[test]
    fn deleting_time_invoice_draft_releases_hours_but_issued_invoice_freezes_them() {
        let (_temporary, store) = initialized_store();
        let (_client_id, project_id, employee_id) = time_billing_fixture(&store);
        let time_entry_id =
            create_billable_time(&store, &project_id, &employee_id, "2026-09-01", 90, 12_000);
        let first_request_id = uuid::Uuid::new_v4().to_string();
        let created = store
            .create_invoice_from_time_entries(time_billing_input(
                &first_request_id,
                &project_id,
                vec![time_entry_id.clone()],
            ))
            .unwrap();
        let draft_invoice_id = created["invoice"]["id"].as_str().unwrap().to_owned();
        let draft_item_id = created["items"][0]["id"].as_str().unwrap().to_owned();
        let draft_batch_id = created["batch"]["id"].as_str().unwrap().to_owned();
        let draft_link_id = created["time_billing_entries"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(store
            .update_record("time_entries", &time_entry_id, json!({"minutes":120}),)
            .is_err());
        assert!(store.delete_record("time_entries", &time_entry_id).is_err());
        assert!(store
            .update_record(
                "invoice_items",
                &draft_item_id,
                json!({"description":"Mutation interdite"}),
            )
            .is_err());
        let connection = store.connect().unwrap();
        assert!(connection
            .execute(
                "DELETE FROM time_billing_batches WHERE id=?",
                rusqlite::params![draft_batch_id],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM time_billing_entries WHERE id=?",
                rusqlite::params![draft_link_id],
            )
            .is_err());
        drop(connection);

        store
            .delete_record("invoices", &draft_invoice_id)
            .expect("la suppression du brouillon doit libérer les temps");
        let workspace = store.get_workspace().unwrap();
        let released = workspace["time_entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == time_entry_id)
            .unwrap();
        assert_eq!(released["billing_status"], "unbilled");
        assert!(workspace["time_billing_batches"]
            .as_array()
            .unwrap()
            .is_empty());
        store
            .update_record("time_entries", &time_entry_id, json!({"minutes":120}))
            .unwrap();

        let second_request_id = uuid::Uuid::new_v4().to_string();
        let rebilled = store
            .create_invoice_from_time_entries(time_billing_input(
                &second_request_id,
                &project_id,
                vec![time_entry_id.clone()],
            ))
            .unwrap();
        let invoice_id = rebilled["invoice"]["id"].as_str().unwrap().to_owned();
        let issued = store
            .issue_invoice(
                &invoice_id,
                Some("2026-09-02".into()),
                Some("2026-10-02".into()),
            )
            .unwrap();
        assert_eq!(issued["status"], "emise");
        assert!(issued["number"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        assert!(store.delete_record("invoices", &invoice_id).is_err());
        assert!(store
            .update_record("time_entries", &time_entry_id, json!({"minutes":180}),)
            .is_err());
        let workspace = store.get_workspace().unwrap();
        let billed = workspace["time_entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == time_entry_id)
            .unwrap();
        assert_eq!(billed["billing_status"], "billed");
        assert_eq!(billed["billing_invoice_id"], invoice_id);

        let replay = store
            .create_invoice_from_time_entries(time_billing_input(
                &second_request_id,
                &project_id,
                vec![time_entry_id],
            ))
            .unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(replay["invoice"]["id"], invoice_id);
    }

    fn tracked_product(store: &LocalStore, name: &str, reorder_level_milli: i64) -> String {
        value_id(
            &store
                .create_record(
                    "catalog_items",
                    json!({
                        "kind":"product",
                        "name":name,
                        "unit":"unité",
                        "sales_price_cents":1_000,
                        "purchase_cost_cents":500,
                        "vat_bp":0,
                        "track_stock":true,
                        "stock_quantity_milli":0,
                        "reorder_level_milli":reorder_level_milli
                    }),
                )
                .unwrap(),
        )
    }

    #[test]
    fn supplier_procurement_receipts_matching_and_credit_events_are_atomic() {
        let (temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let supplier_id = value_id(
            &store
                .create_record("suppliers", json!({"name":"Approvisionnement réel SA"}))
                .unwrap(),
        );
        let product_id = tracked_product(&store, "Produit réceptionné", 0);
        let order = store
            .save_supplier_order_draft(SaveSupplierOrderDraftInput {
                order: SupplierOrderDraftInput {
                    id: Some("7bbf9a91-771d-4d80-9fac-bd2cc1506d75".into()),
                    supplier_id: supplier_id.clone(),
                    project_id: None,
                    title: "Commande matière".into(),
                    order_date: "2026-09-01".into(),
                    currency: "CHF".into(),
                    notes: None,
                    terms: None,
                },
                lines: vec![SupplierOrderLineInput {
                    id: Some("67d85c28-509b-4352-9187-f69213d3f42a".into()),
                    catalog_item_id: Some(product_id.clone()),
                    position: 0,
                    description: "Matière".into(),
                    quantity_milli: 2_000,
                    unit: "pièce".into(),
                    unit_price_cents: 500,
                    discount_bp: 0,
                    vat_bp: 0,
                    category: "Matériaux".into(),
                    expense_account_id: None,
                    project_id: None,
                    fulfillment_mode: "stocked_receipt".into(),
                }],
            })
            .unwrap();
        let order_id = order["order"]["id"].as_str().unwrap().to_owned();
        let order_line_id = order["lines"][0]["id"].as_str().unwrap().to_owned();
        let confirm_input = ConfirmSupplierOrderInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_order_id: order_id.clone(),
        };
        let confirmed = store.confirm_supplier_order(confirm_input.clone()).unwrap();
        assert_eq!(confirmed["order"]["status"], "confirmed");
        let supplier_order_snapshot: serde_json::Value =
            serde_json::from_str(confirmed["order"]["snapshot_json"].as_str().unwrap()).unwrap();
        assert!(supplier_order_snapshot["issuer"]["logo_path"].is_null());
        assert_eq!(supplier_order_snapshot["order"]["status"], "confirmed");
        assert_eq!(
            supplier_order_snapshot["order"]["number"],
            confirmed["order"]["number"]
        );
        assert!(supplier_order_snapshot["order"]
            .get("snapshot_json")
            .is_none());
        assert_eq!(
            store.confirm_supplier_order(confirm_input).unwrap()["idempotent"],
            true
        );

        let receipt = store
            .save_supplier_receipt_draft(SaveSupplierReceiptDraftInput {
                receipt: SupplierReceiptDraftInput {
                    id: Some("1103f834-46fc-4c44-834b-d44ed8884c56".into()),
                    supplier_order_id: order_id.clone(),
                    receipt_date: "2026-09-02".into(),
                    reference: Some("BL-F-1".into()),
                    notes: None,
                },
                lines: vec![SupplierReceiptLineInput {
                    supplier_order_line_id: order_line_id.clone(),
                    quantity_milli: 1_000,
                }],
            })
            .unwrap();
        let receipt_id = receipt["receipt"]["id"].as_str().unwrap().to_owned();
        let receipt_line_id = receipt["lines"][0]["id"].as_str().unwrap().to_owned();
        let issue_input = IssueSupplierReceiptInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_receipt_id: receipt_id.clone(),
        };
        store.issue_supplier_receipt(issue_input.clone()).unwrap();
        store.issue_supplier_receipt(issue_input).unwrap();
        let connection = store.connect().unwrap();
        let stock_state: (i64, i64) = connection
            .query_row(
                "SELECT stock_quantity_milli,(SELECT COUNT(*) FROM stock_movements WHERE supplier_receipt_id=?1) FROM catalog_items WHERE id=?2",
                rusqlite::params![receipt_id,product_id],
                |row| Ok((row.get(0)?,row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stock_state, (1_000, 1));
        drop(connection);

        let invoice_id = "d927d01e-54eb-4715-a359-979377677959";
        let invoice_item_id = "4f2fbacb-064c-4ca8-9450-01a52c8e5823";
        store
            .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
                id: Some(invoice_id.into()),
                supplier_id: supplier_id.clone(),
                project_id: None,
                date: "2026-09-02".into(),
                due_date: "2026-09-30".into(),
                reference: Some("FA-ACH-1".into()),
                note: None,
                items: vec![SupplierInvoiceLineInput {
                    id: Some(invoice_item_id.into()),
                    description: "Matière".into(),
                    quantity_milli: 1_000,
                    unit: Some("pièce".into()),
                    unit_price_cents: 500,
                    discount_bp: 0,
                    vat_bp: 0,
                    category: "Matériaux".into(),
                    expense_account_id: None,
                    project_id: None,
                }],
            })
            .unwrap();
        store
            .save_supplier_invoice_match(SaveSupplierInvoiceMatchInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_invoice_id: invoice_id.into(),
                supplier_order_id: order_id.clone(),
                allocations: vec![SupplierInvoiceMatchAllocationInput {
                    supplier_invoice_item_id: invoice_item_id.into(),
                    supplier_order_line_id: order_line_id.clone(),
                    supplier_receipt_line_id: Some(receipt_line_id),
                    quantity_milli: 1_000,
                }],
                order_allocations: vec![],
            })
            .unwrap();
        assert_eq!(
            store.get_workspace().unwrap()["supplier_orders"][0]["status"],
            "confirmed"
        );
        store.validate_supplier_invoice(invoice_id).unwrap();
        let connection = store.connect().unwrap();
        let movement_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM stock_movements WHERE supplier_receipt_id=?",
                rusqlite::params![receipt_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            movement_count, 1,
            "la facture ne crée jamais une seconde entrée de stock"
        );
        drop(connection);
        let reclassified_account = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "6010".into(),
                    name: "Achats de matières".into(),
                    account_type: "expense".into(),
                    normal_balance: "debit".into(),
                    report_section: "other_operating_expense".into(),
                    active: true,
                })
                .unwrap(),
        );
        let reclass_input = ReclassifySupplierInvoiceExpenseInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_invoice_id: invoice_id.into(),
            effective_date: "2026-09-03".into(),
            reason: "Classement analytique corrigé".into(),
            lines: vec![SupplierExpenseReclassificationLineInput {
                supplier_invoice_item_id: invoice_item_id.into(),
                new_expense_account_id: reclassified_account.clone(),
            }],
        };
        let reclass = store
            .reclassify_supplier_invoice_expense(reclass_input.clone())
            .unwrap();
        assert_eq!(
            reclass["lines"][0]["old_expense_account_id"],
            accounts["expense"]
        );
        assert_eq!(
            reclass["lines"][0]["new_expense_account_id"],
            reclassified_account
        );
        assert_eq!(
            store
                .reclassify_supplier_invoice_expense(reclass_input)
                .unwrap()["idempotent"],
            true
        );
        let reclass_journal_id = reclass["reclassification"]["journal_entry_id"]
            .as_str()
            .unwrap();
        let connection = store.connect().unwrap();
        let reclass_shape: (i64, i64, i64) = connection.query_row(
            "SELECT COUNT(*),COALESCE(SUM(debit_cents),0),COALESCE(SUM(credit_cents),0) FROM journal_lines WHERE journal_entry_id=?",
            rusqlite::params![reclass_journal_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert_eq!(reclass_shape, (2, 500, 500));
        drop(connection);

        let receipt_two = store
            .save_supplier_receipt_draft(SaveSupplierReceiptDraftInput {
                receipt: SupplierReceiptDraftInput {
                    id: Some("8435ceec-fda9-47d6-9404-80b944ab57ea".into()),
                    supplier_order_id: order_id.clone(),
                    receipt_date: "2026-09-03".into(),
                    reference: Some("BL-F-2".into()),
                    notes: None,
                },
                lines: vec![SupplierReceiptLineInput {
                    supplier_order_line_id: order_line_id.clone(),
                    quantity_milli: 1_000,
                }],
            })
            .unwrap();
        let receipt_two_id = receipt_two["receipt"]["id"].as_str().unwrap().to_owned();
        let receipt_two_line_id = receipt_two["lines"][0]["id"].as_str().unwrap().to_owned();
        store
            .issue_supplier_receipt(IssueSupplierReceiptInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_receipt_id: receipt_two_id,
            })
            .unwrap();
        let second_invoice_id = "2664b4bc-8ef2-4c23-a891-2564e3f8dcea";
        let second_item_id = "ed5eaaea-e599-48bd-8484-d3a1021889c0";
        let second_invoice_input = SaveSupplierInvoiceDraftInput {
            id: Some(second_invoice_id.into()),
            supplier_id: supplier_id.clone(),
            project_id: None,
            date: "2026-09-03".into(),
            due_date: "2026-09-30".into(),
            reference: Some("FA-ACH-2".into()),
            note: None,
            items: vec![SupplierInvoiceLineInput {
                id: Some(second_item_id.into()),
                description: "Matière solde".into(),
                quantity_milli: 1_000,
                unit: Some("pièce".into()),
                unit_price_cents: 500,
                discount_bp: 0,
                vat_bp: 0,
                category: "Matériaux".into(),
                expense_account_id: None,
                project_id: None,
            }],
        };
        let second_match = || SaveSupplierInvoiceMatchInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_invoice_id: second_invoice_id.into(),
            supplier_order_id: order_id.clone(),
            allocations: vec![SupplierInvoiceMatchAllocationInput {
                supplier_invoice_item_id: second_item_id.into(),
                supplier_order_line_id: order_line_id.clone(),
                supplier_receipt_line_id: Some(receipt_two_line_id.clone()),
                quantity_milli: 1_000,
            }],
            order_allocations: vec![],
        };
        store
            .save_supplier_invoice_draft(second_invoice_input.clone())
            .unwrap();
        store.save_supplier_invoice_match(second_match()).unwrap();
        store
            .delete_supplier_invoice_draft(second_invoice_id)
            .unwrap();
        let status_after_delete: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT status FROM supplier_orders WHERE id=?",
                rusqlite::params![order_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            status_after_delete, "confirmed",
            "un match brouillon supprimé ne clôture pas la commande"
        );
        store
            .save_supplier_invoice_draft(second_invoice_input)
            .unwrap();
        store.save_supplier_invoice_match(second_match()).unwrap();
        store.validate_supplier_invoice(second_invoice_id).unwrap();
        let closed_status: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT status FROM supplier_orders WHERE id=?",
                rusqlite::params![order_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            closed_status, "closed",
            "seuls les matches de factures validées clôturent la commande"
        );

        let credit = store
            .save_supplier_credit_note_draft(SaveSupplierCreditNoteDraftInput {
                id: Some("a9e7220a-9563-46b5-8f88-2af82c4c6791".into()),
                supplier_id: supplier_id.clone(),
                document_date: "2026-09-03".into(),
                reference: Some("AV-F-1".into()),
                note: None,
                items: vec![SupplierInvoiceLineInput {
                    id: Some("a83443fa-0029-47dc-b915-0f545308cdeb".into()),
                    description: "Retour".into(),
                    quantity_milli: 1_000,
                    unit: Some("pièce".into()),
                    unit_price_cents: 200,
                    discount_bp: 0,
                    vat_bp: 0,
                    category: "Matériaux".into(),
                    expense_account_id: None,
                    project_id: None,
                }],
                allocations: vec![],
            })
            .unwrap();
        let credit_id = credit["credit_note"]["id"].as_str().unwrap().to_owned();
        store
            .validate_supplier_credit_note(ValidateSupplierCreditNoteInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_credit_note_id: credit_id.clone(),
            })
            .unwrap();
        assert!(store.connect().unwrap().execute(
            "INSERT INTO supplier_credit_note_items(id,supplier_credit_note_id,position,description,quantity_milli,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,category,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(),credit_id,1,"ligne forgée",1_000,"pièce",1,0,0,1,0,1,"Matériaux","2026-09-03T00:00:00Z","2026-09-03T00:00:00Z"],
        ).is_err(), "une ligne ne peut pas être ajoutée à un avoir validé");
        let apply_input = ApplySupplierCreditInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_credit_note_id: credit_id.clone(),
            supplier_invoice_id: invoice_id.into(),
            amount_cents: 200,
        };
        let applied = store.apply_supplier_credit(apply_input.clone()).unwrap();
        let allocation_id = applied["allocation"]["id"].as_str().unwrap().to_owned();
        assert_eq!(applied["invoice"]["credited_cents"], 200);
        assert_eq!(
            store.apply_supplier_credit(apply_input.clone()).unwrap()["idempotent"],
            true
        );
        let mut conflicting_apply = apply_input;
        conflicting_apply.amount_cents = 199;
        assert!(
            store.apply_supplier_credit(conflicting_apply).is_err(),
            "un request_id ne peut pas être rejoué avec un autre montant"
        );
        let reversed = store
            .reverse_supplier_credit_allocation(ReverseSupplierCreditAllocationInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_credit_allocation_id: allocation_id.clone(),
                reason: "Imputation sélectionnée par erreur".into(),
            })
            .unwrap();
        assert_eq!(reversed["invoice"]["credited_cents"], 0);
        assert!(store
            .reverse_supplier_credit_allocation(ReverseSupplierCreditAllocationInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_credit_allocation_id: allocation_id,
                reason: "Deuxième extourne interdite".into(),
            })
            .is_err());
        assert!(
            store
                .apply_supplier_credit(ApplySupplierCreditInput {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    supplier_credit_note_id: credit_id,
                    supplier_invoice_id: invoice_id.into(),
                    amount_cents: 201,
                })
                .is_err(),
            "une imputation ne peut pas dépasser le solde de l’avoir"
        );
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM stock_movements", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(connection
            .execute(
                "UPDATE supplier_orders SET closed_at='2099-01-01T00:00:00Z' WHERE id=?",
                rusqlite::params![order_id]
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE supplier_orders SET title='altéré' WHERE id=?",
                rusqlite::params![order_id]
            )
            .is_err());
        assert!(connection.execute("UPDATE supplier_operation_requests SET operation='forged' WHERE result_entity_id=?", rusqlite::params![order_id]).is_err());
        assert!(connection
            .execute("DELETE FROM supplier_credit_allocations", [])
            .is_err());
        assert!(connection
            .execute(
                "UPDATE supplier_expense_reclassification_lines SET amount_cents=501",
                []
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE stock_movements SET reason='altéré' WHERE supplier_receipt_id IS NOT NULL",
                []
            )
            .is_err());
        drop(connection);
        let backup_path = temporary.path().join("supplier-procurement-v21.zentra");
        store
            .create_backup(Some(backup_path.to_string_lossy().into_owned()), "1.8.0")
            .unwrap();
        store
            .create_record("suppliers", json!({"name":"Mutation après sauvegarde"}))
            .unwrap();
        store
            .restore_backup(&backup_path.to_string_lossy(), "1.8.0")
            .unwrap();
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["supplier_orders"][0]["id"], order_id);
        assert_eq!(workspace["supplier_orders"][0]["status"], "closed");
        assert_eq!(workspace["supplier_receipts"].as_array().unwrap().len(), 2);
        assert_eq!(
            workspace["supplier_invoice_matches"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            workspace["supplier_credit_allocations"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(workspace["stock_movements"].as_array().unwrap().len(), 2);
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn supplier_procurement_closed_period_and_transition_guards_fail_closed() {
        let (_temporary, store) = initialized_store();
        let accounts = enable_accounting(&store);
        let supplier_id = value_id(
            &store
                .create_record("suppliers", json!({"name":"Garde achats SA"}))
                .unwrap(),
        );
        let product_id = tracked_product(&store, "Produit gardé", 0);
        let order_input = |order_id: &str, line_id: &str, order_date: &str, mode: &str| {
            SaveSupplierOrderDraftInput {
                order: SupplierOrderDraftInput {
                    id: Some(order_id.into()),
                    supplier_id: supplier_id.clone(),
                    project_id: None,
                    title: "Commande sous garde".into(),
                    order_date: order_date.into(),
                    currency: "CHF".into(),
                    notes: None,
                    terms: None,
                },
                lines: vec![SupplierOrderLineInput {
                    id: Some(line_id.into()),
                    catalog_item_id: (mode == "stocked_receipt").then(|| product_id.clone()),
                    position: 0,
                    description: "Article protégé".into(),
                    quantity_milli: 1_000,
                    unit: "pièce".into(),
                    unit_price_cents: 500,
                    discount_bp: 0,
                    vat_bp: 0,
                    category: "Matériaux".into(),
                    expense_account_id: None,
                    project_id: None,
                    fulfillment_mode: mode.into(),
                }],
            }
        };
        let order_id = "4f847f5b-b3a8-44df-a59a-46c984a022bc";
        let order_line_id = "924fd50c-b16a-4860-877d-36f8303fca90";
        store
            .save_supplier_order_draft(order_input(
                order_id,
                order_line_id,
                "2026-10-01",
                "stocked_receipt",
            ))
            .unwrap();
        let connection = store.connect().unwrap();
        assert!(connection.execute(
            "UPDATE supplier_orders SET number='CF-FAUX',status='confirmed',confirmed_at='2026-10-01T00:00:00Z' WHERE id=?",
            rusqlite::params![order_id],
        ).is_err(), "une confirmation SQL sans snapshot doit échouer");
        drop(connection);
        store
            .confirm_supplier_order(ConfirmSupplierOrderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: order_id.into(),
            })
            .unwrap();
        let cancel_order_id = "9d2762ca-d8d0-4c5a-ab21-544dca6f3577";
        let cancel_line_id = "46349577-1385-4854-87aa-0640694f4800";
        store
            .save_supplier_order_draft(order_input(
                cancel_order_id,
                cancel_line_id,
                "2026-09-01",
                "direct",
            ))
            .unwrap();
        store
            .confirm_supplier_order(ConfirmSupplierOrderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: cancel_order_id.into(),
            })
            .unwrap();
        let cancel_input = CancelSupplierOrderRemainderInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_order_id: cancel_order_id.into(),
            reason: "Quantité réduite par accord".into(),
            lines: vec![CancelSupplierOrderRemainderLineInput {
                supplier_order_line_id: cancel_line_id.into(),
                quantity_milli: 400,
            }],
        };
        let cancelled = store
            .cancel_supplier_order_remainder(cancel_input.clone())
            .unwrap();
        assert_eq!(cancelled["lines"][0]["cancelled_quantity_milli"], 400);
        assert_eq!(
            store.cancel_supplier_order_remainder(cancel_input).unwrap()["idempotent"],
            true
        );
        assert!(store.connect().unwrap().execute(
            "INSERT INTO supplier_order_cancellation_lines(id,request_id,supplier_order_id,supplier_order_line_id,quantity_milli,reason,created_at) VALUES(?,?,?,?,?,?,?)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(),uuid::Uuid::new_v4().to_string(),cancel_order_id,cancel_line_id,601,"forgé","2026-09-01T00:00:00Z"],
        ).is_err());
        let connection = store.connect().unwrap();
        assert!(connection.execute(
            "UPDATE supplier_orders SET status='closed',closed_at='2026-10-01T00:00:00Z',updated_at='2026-10-01T00:00:00Z' WHERE id=?",
            rusqlite::params![order_id],
        ).is_err(), "une commande non rapprochée ne peut pas être fermée par SQL");
        assert!(connection.execute(
            "UPDATE supplier_orders SET status='cancelled',cancelled_at='2026-10-01T00:00:00Z',cancellation_reason='forgé',updated_at='2026-10-01T00:00:00Z' WHERE id=?",
            rusqlite::params![order_id],
        ).is_err(), "une commande avec reliquat ne peut pas être annulée par SQL");
        assert!(connection.execute(
            "INSERT INTO supplier_operation_requests(request_id,operation,payload_sha256,payload_json,result_entity_type,result_entity_id,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(),"forged","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","{}","supplier_receipt","missing","{}","2026-10-01T00:00:00Z"],
        ).is_err());
        drop(connection);
        assert!(
            store
                .save_supplier_receipt_draft(SaveSupplierReceiptDraftInput {
                    receipt: SupplierReceiptDraftInput {
                        id: None,
                        supplier_order_id: order_id.into(),
                        receipt_date: "2026-09-30".into(),
                        reference: None,
                        notes: None
                    },
                    lines: vec![SupplierReceiptLineInput {
                        supplier_order_line_id: order_line_id.into(),
                        quantity_milli: 1_000
                    }],
                })
                .is_err(),
            "une réception antérieure à la commande doit échouer"
        );
        let receipt = store
            .save_supplier_receipt_draft(SaveSupplierReceiptDraftInput {
                receipt: SupplierReceiptDraftInput {
                    id: Some("3a1bd0e8-eadd-428b-bc40-b455df38bb9b".into()),
                    supplier_order_id: order_id.into(),
                    receipt_date: "2026-10-02".into(),
                    reference: None,
                    notes: None,
                },
                lines: vec![SupplierReceiptLineInput {
                    supplier_order_line_id: order_line_id.into(),
                    quantity_milli: 1_000,
                }],
            })
            .unwrap();
        let receipt_id = receipt["receipt"]["id"].as_str().unwrap().to_owned();
        let october_period = value_id(
            &store
                .upsert_accounting_period(AccountingPeriodInput {
                    id: None,
                    name: "Octobre achats".into(),
                    date_from: "2026-10-01".into(),
                    date_to: "2026-10-31".into(),
                })
                .unwrap(),
        );
        store.close_accounting_period(&october_period).unwrap();
        assert!(store
            .issue_supplier_receipt(IssueSupplierReceiptInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_receipt_id: receipt_id.clone(),
            })
            .is_err());
        let receipt_state: (String,i64) = store.connect().unwrap().query_row(
            "SELECT status,(SELECT COUNT(*) FROM stock_movements WHERE supplier_receipt_id=?1) FROM supplier_receipts WHERE id=?1",
            rusqlite::params![receipt_id],|row| Ok((row.get(0)?,row.get(1)?)),
        ).unwrap();
        assert_eq!(receipt_state, ("draft".into(), 0));

        let direct_order_id = "d9212446-11da-4032-8c47-ae2beea45c25";
        let direct_line_id = "f58ef14a-fc94-4ac4-8e58-c686ad9d8fef";
        store
            .save_supplier_order_draft(order_input(
                direct_order_id,
                direct_line_id,
                "2026-11-01",
                "direct",
            ))
            .unwrap();
        store
            .confirm_supplier_order(ConfirmSupplierOrderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: direct_order_id.into(),
            })
            .unwrap();
        let invoice_id = "6ad3e61e-ea8f-4414-939c-70beabf724ff";
        let invoice_item_id = "8032c8ad-b48f-4f69-8650-34c3bd3e3a68";
        store
            .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
                id: Some(invoice_id.into()),
                supplier_id: supplier_id.clone(),
                project_id: None,
                date: "2026-11-02".into(),
                due_date: "2026-11-30".into(),
                reference: Some("TAMPER-1".into()),
                note: None,
                items: vec![SupplierInvoiceLineInput {
                    id: Some(invoice_item_id.into()),
                    description: "Direct".into(),
                    quantity_milli: 1_000,
                    unit: Some("pièce".into()),
                    unit_price_cents: 500,
                    discount_bp: 0,
                    vat_bp: 0,
                    category: "Charge".into(),
                    expense_account_id: None,
                    project_id: None,
                }],
            })
            .unwrap();
        let connection = store.connect().unwrap();
        assert!(connection.execute(
            "INSERT INTO supplier_invoice_matches(id,request_id,supplier_invoice_id,supplier_invoice_item_id,supplier_order_id,supplier_order_line_id,quantity_milli,net_cents,vat_cents,total_cents,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(),uuid::Uuid::new_v4().to_string(),invoice_id,invoice_item_id,direct_order_id,direct_line_id,1_000,499,0,499,"2026-11-02T00:00:00Z"],
        ).is_err(), "un montant rapproché falsifié doit échouer");
        drop(connection);
        store
            .save_supplier_invoice_match(SaveSupplierInvoiceMatchInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_invoice_id: invoice_id.into(),
                supplier_order_id: direct_order_id.into(),
                allocations: vec![SupplierInvoiceMatchAllocationInput {
                    supplier_invoice_item_id: invoice_item_id.into(),
                    supplier_order_line_id: direct_line_id.into(),
                    supplier_receipt_line_id: None,
                    quantity_milli: 1_000,
                }],
                order_allocations: vec![],
            })
            .unwrap();
        store.validate_supplier_invoice(invoice_id).unwrap();
        let second_expense = value_id(
            &store
                .upsert_account(AccountInput {
                    id: None,
                    code: "6020".into(),
                    name: "Autres achats".into(),
                    account_type: "expense".into(),
                    normal_balance: "debit".into(),
                    report_section: "other_operating_expense".into(),
                    active: true,
                })
                .unwrap(),
        );
        let fake_reclassification_id = uuid::Uuid::new_v4().to_string();
        let mut fake_connection = store.connect().unwrap();
        let fake_tx = fake_connection.transaction().unwrap();
        let fake_journal = crate::accounting::post_entry(
            &fake_tx,
            "2026-11-04",
            "Écriture de reclassement falsifiée",
            "supplier_expense_reclassification",
            &fake_reclassification_id,
            "post",
            vec![
                crate::accounting::EntryLine {
                    account_id: second_expense.clone(),
                    debit_cents: 500,
                    credit_cents: 0,
                    currency: "CHF".into(),
                    memo: None,
                    project_id: None,
                    client_id: None,
                    employee_id: None,
                },
                crate::accounting::EntryLine {
                    account_id: accounts["supplier_payable"].clone(),
                    debit_cents: 0,
                    credit_cents: 500,
                    currency: "CHF".into(),
                    memo: None,
                    project_id: None,
                    client_id: None,
                    employee_id: None,
                },
            ],
        )
        .unwrap();
        fake_tx.execute(
            "INSERT INTO supplier_expense_reclassifications(id,request_id,supplier_invoice_id,effective_date,reason,journal_entry_id,created_at) VALUES(?,?,?,?,?,?,?)",
            rusqlite::params![fake_reclassification_id,uuid::Uuid::new_v4().to_string(),invoice_id,"2026-11-04","faux reclassement",fake_journal["id"].as_str().unwrap(),"2026-11-04T00:00:00Z"],
        ).unwrap();
        assert!(fake_tx.execute(
            "INSERT INTO supplier_expense_reclassification_lines(id,reclassification_id,supplier_invoice_item_id,old_expense_account_id,new_expense_account_id,amount_cents,created_at) VALUES(?,?,?,?,?,?,?)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(),fake_reclassification_id,invoice_item_id,accounts["expense"],second_expense,500,"2026-09-04T00:00:00Z"],
        ).is_err(), "un faux journal dette/charge ne peut pas justifier un reclassement");
        fake_tx.rollback().unwrap();
        assert!(store
            .reclassify_supplier_invoice_expense(ReclassifySupplierInvoiceExpenseInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_invoice_id: invoice_id.into(),
                effective_date: "2026-10-05".into(),
                reason: "Période fermée".into(),
                lines: vec![SupplierExpenseReclassificationLineInput {
                    supplier_invoice_item_id: invoice_item_id.into(),
                    new_expense_account_id: second_expense
                }],
            })
            .is_err());
        let connection = store.connect().unwrap();
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM supplier_expense_reclassifications WHERE supplier_invoice_id=?",rusqlite::params![invoice_id],|row| row.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM journal_entries WHERE source_type='supplier_expense_reclassification'",[],|row| row.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(
            connection
                .query_row(
                    "SELECT posted_expense_account_id FROM supplier_invoice_items WHERE id=?",
                    rusqlite::params![invoice_item_id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            accounts["expense"]
        );
        drop(connection);

        let reverse_order_id = "25af1dbe-d05b-4081-a73b-367b582dbb73";
        let reverse_line_id = "f49b669e-0957-48dc-bac0-d2555d783107";
        store
            .save_supplier_order_draft(order_input(
                reverse_order_id,
                reverse_line_id,
                "2026-11-01",
                "stocked_receipt",
            ))
            .unwrap();
        store
            .confirm_supplier_order(ConfirmSupplierOrderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: reverse_order_id.into(),
            })
            .unwrap();
        let reverse_receipt = store
            .save_supplier_receipt_draft(SaveSupplierReceiptDraftInput {
                receipt: SupplierReceiptDraftInput {
                    id: Some("a1e06df4-6616-44f9-b116-ecf286592f8e".into()),
                    supplier_order_id: reverse_order_id.into(),
                    receipt_date: "2026-11-05".into(),
                    reference: None,
                    notes: None,
                },
                lines: vec![SupplierReceiptLineInput {
                    supplier_order_line_id: reverse_line_id.into(),
                    quantity_milli: 1_000,
                }],
            })
            .unwrap();
        let reverse_receipt_id = reverse_receipt["receipt"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        store
            .issue_supplier_receipt(IssueSupplierReceiptInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_receipt_id: reverse_receipt_id.clone(),
            })
            .unwrap();
        let november_period = value_id(
            &store
                .upsert_accounting_period(AccountingPeriodInput {
                    id: None,
                    name: "Novembre achats".into(),
                    date_from: "2026-11-01".into(),
                    date_to: "2026-11-30".into(),
                })
                .unwrap(),
        );
        store.close_accounting_period(&november_period).unwrap();
        assert!(store
            .reverse_supplier_receipt(ReverseSupplierReceiptInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_receipt_id: reverse_receipt_id.clone(),
                reason: "Retour en période fermée".into(),
            })
            .is_err());
        let reverse_state: (String,i64) = store.connect().unwrap().query_row(
            "SELECT status,(SELECT COUNT(*) FROM stock_movements WHERE supplier_receipt_id=?1) FROM supplier_receipts WHERE id=?1",
            rusqlite::params![reverse_receipt_id],|row| Ok((row.get(0)?,row.get(1)?)),
        ).unwrap();
        assert_eq!(reverse_state, ("issued".into(), 1));
    }

    #[test]
    fn supplier_receipt_reversal_aggregates_stock_and_allows_full_cancellation() {
        let (_temporary, store) = initialized_store();
        let supplier_id = value_id(
            &store
                .create_record("suppliers", json!({"name":"Extournes achats SA"}))
                .unwrap(),
        );
        let product_id = tracked_product(&store, "Produit extourné", 0);

        let order_id = "93377a21-140a-488b-880f-448593a56d1f";
        let order_line_id = "a63b801d-8c2a-4167-b38d-66f42831e2ab";
        store
            .save_supplier_order_draft(SaveSupplierOrderDraftInput {
                order: SupplierOrderDraftInput {
                    id: Some(order_id.into()),
                    supplier_id: supplier_id.clone(),
                    project_id: None,
                    title: "Commande à extourner".into(),
                    order_date: "2026-08-01".into(),
                    currency: "CHF".into(),
                    notes: None,
                    terms: None,
                },
                lines: vec![SupplierOrderLineInput {
                    id: Some(order_line_id.into()),
                    catalog_item_id: Some(product_id.clone()),
                    position: 0,
                    description: "Produit".into(),
                    quantity_milli: 1_000,
                    unit: "pièce".into(),
                    unit_price_cents: 500,
                    discount_bp: 0,
                    vat_bp: 0,
                    category: "Matériaux".into(),
                    expense_account_id: None,
                    project_id: None,
                    fulfillment_mode: "stocked_receipt".into(),
                }],
            })
            .unwrap();
        store
            .confirm_supplier_order(ConfirmSupplierOrderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: order_id.into(),
            })
            .unwrap();
        let receipt = store
            .save_supplier_receipt_draft(SaveSupplierReceiptDraftInput {
                receipt: SupplierReceiptDraftInput {
                    id: Some("249b7711-b83f-4488-9ad8-4ffab33f799b".into()),
                    supplier_order_id: order_id.into(),
                    receipt_date: "2026-08-02".into(),
                    reference: None,
                    notes: None,
                },
                lines: vec![SupplierReceiptLineInput {
                    supplier_order_line_id: order_line_id.into(),
                    quantity_milli: 1_000,
                }],
            })
            .unwrap();
        let receipt_id = receipt["receipt"]["id"].as_str().unwrap().to_owned();
        let receipt_line_id = receipt["lines"][0]["id"].as_str().unwrap().to_owned();
        let mut forged_issue_connection = store.connect().unwrap();
        let forged_issue = forged_issue_connection.transaction().unwrap();
        forged_issue.execute(
            "UPDATE supplier_receipts SET number='RF-FAUX',status='issuing',snapshot_json='{}',issued_at='2026-08-02T00:00:00Z',updated_at='2026-08-02T00:00:00Z' WHERE id=?",
            rusqlite::params![receipt_id],
        ).unwrap();
        assert!(
            forged_issue
                .execute(
                    "UPDATE supplier_receipts SET status='issued' WHERE id=?",
                    rusqlite::params![receipt_id],
                )
                .is_err(),
            "une réception stockée ne peut pas devenir émise sans son entrée exacte"
        );
        forged_issue.rollback().unwrap();
        store
            .issue_supplier_receipt(IssueSupplierReceiptInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_receipt_id: receipt_id.clone(),
            })
            .unwrap();
        let mut forged_reverse_connection = store.connect().unwrap();
        let forged_reverse = forged_reverse_connection.transaction().unwrap();
        forged_reverse.execute(
            "UPDATE supplier_receipts SET status='reversing',reversed_at='2026-08-02T01:00:00Z',reversal_reason='faux',updated_at='2026-08-02T01:00:00Z' WHERE id=?",
            rusqlite::params![receipt_id],
        ).unwrap();
        assert!(
            forged_reverse
                .execute(
                    "UPDATE supplier_receipts SET status='reversed' WHERE id=?",
                    rusqlite::params![receipt_id],
                )
                .is_err(),
            "une réception stockée ne peut pas devenir extournée sans son mouvement inverse exact"
        );
        forged_reverse.rollback().unwrap();
        let draft_invoice_id = "fdf73564-0833-46c7-b4fd-88d40aba48bb";
        let draft_invoice_line_id = "475232c8-4c48-4b8e-a303-e995939a6810";
        store
            .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
                id: Some(draft_invoice_id.into()),
                supplier_id: supplier_id.clone(),
                project_id: None,
                date: "2026-08-02".into(),
                due_date: "2026-09-01".into(),
                reference: Some("BROUILLON-EXT-1".into()),
                note: None,
                items: vec![SupplierInvoiceLineInput {
                    id: Some(draft_invoice_line_id.into()),
                    description: "Produit".into(),
                    quantity_milli: 1_000,
                    unit: Some("pièce".into()),
                    unit_price_cents: 500,
                    discount_bp: 0,
                    vat_bp: 0,
                    category: "Matériaux".into(),
                    expense_account_id: None,
                    project_id: None,
                }],
            })
            .unwrap();
        store
            .save_supplier_invoice_match(SaveSupplierInvoiceMatchInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_invoice_id: draft_invoice_id.into(),
                supplier_order_id: order_id.into(),
                allocations: vec![SupplierInvoiceMatchAllocationInput {
                    supplier_invoice_item_id: draft_invoice_line_id.into(),
                    supplier_order_line_id: order_line_id.into(),
                    supplier_receipt_line_id: Some(receipt_line_id),
                    quantity_milli: 1_000,
                }],
                order_allocations: vec![],
            })
            .unwrap();
        let edit_error = store
            .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
                id: Some(draft_invoice_id.into()),
                supplier_id: supplier_id.clone(),
                project_id: None,
                date: "2026-08-02".into(),
                due_date: "2026-09-02".into(),
                reference: Some("BROUILLON-EXT-1".into()),
                note: Some("Modification qui ne doit pas effacer le lien".into()),
                items: vec![SupplierInvoiceLineInput {
                    id: Some(draft_invoice_line_id.into()),
                    description: "Produit".into(),
                    quantity_milli: 1_000,
                    unit: Some("pièce".into()),
                    unit_price_cents: 500,
                    discount_bp: 0,
                    vat_bp: 0,
                    category: "Matériaux".into(),
                    expense_account_id: None,
                    project_id: None,
                }],
            })
            .unwrap_err()
            .to_string();
        assert!(edit_error.contains("Retirez explicitement"), "{edit_error}");
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM supplier_invoice_matches WHERE supplier_invoice_id=?",
                    rusqlite::params![draft_invoice_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
            "une édition refusée conserve le rapprochement"
        );
        assert!(store
            .reverse_supplier_receipt(ReverseSupplierReceiptInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_receipt_id: receipt_id.clone(),
                reason: "Lien encore présent".into(),
            })
            .is_err());
        let clear_match = SaveSupplierInvoiceMatchInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_invoice_id: draft_invoice_id.into(),
            supplier_order_id: order_id.into(),
            allocations: vec![],
            order_allocations: vec![],
        };
        let cleared = store
            .save_supplier_invoice_match(clear_match.clone())
            .unwrap();
        assert!(cleared["matches"].as_array().unwrap().is_empty());
        assert_eq!(
            store.save_supplier_invoice_match(clear_match).unwrap()["idempotent"],
            true
        );
        store
            .reverse_supplier_receipt(ReverseSupplierReceiptInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_receipt_id: receipt_id.clone(),
                reason: "Réception saisie par erreur".into(),
            })
            .unwrap();
        assert!(store
            .connect()
            .unwrap()
            .execute(
                "UPDATE supplier_receipts SET reversal_reason='altéré' WHERE id=?",
                rusqlite::params![receipt_id],
            )
            .is_err());
        let cancelled = store
            .cancel_supplier_order_remainder(CancelSupplierOrderRemainderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: order_id.into(),
                reason: "Commande annulée après extourne".into(),
                lines: vec![CancelSupplierOrderRemainderLineInput {
                    supplier_order_line_id: order_line_id.into(),
                    quantity_milli: 1_000,
                }],
            })
            .unwrap();
        assert_eq!(cancelled["order"]["status"], "cancelled");
        let first_state: (i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT stock_quantity_milli,(SELECT COUNT(*) FROM stock_movements WHERE supplier_receipt_id=?1) FROM catalog_items WHERE id=?2",
                rusqlite::params![receipt_id, product_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(first_state, (0, 2));

        let aggregate_order_id = "032cb8d6-2b52-460f-bea6-807892171a64";
        let aggregate_line_one = "d2f74067-7d70-4d6a-9eaa-ce72c846564c";
        let aggregate_line_two = "855ff3e9-f08f-4bdb-8d99-0c480e144a99";
        let make_line = |id: &str, position: i64| SupplierOrderLineInput {
            id: Some(id.into()),
            catalog_item_id: Some(product_id.clone()),
            position,
            description: format!("Lot {}", position + 1),
            quantity_milli: 5_000,
            unit: "pièce".into(),
            unit_price_cents: 100,
            discount_bp: 0,
            vat_bp: 0,
            category: "Matériaux".into(),
            expense_account_id: None,
            project_id: None,
            fulfillment_mode: "stocked_receipt".into(),
        };
        store
            .save_supplier_order_draft(SaveSupplierOrderDraftInput {
                order: SupplierOrderDraftInput {
                    id: Some(aggregate_order_id.into()),
                    supplier_id,
                    project_id: None,
                    title: "Commande multi-lignes".into(),
                    order_date: "2026-08-03".into(),
                    currency: "CHF".into(),
                    notes: None,
                    terms: None,
                },
                lines: vec![
                    make_line(aggregate_line_one, 0),
                    make_line(aggregate_line_two, 1),
                ],
            })
            .unwrap();
        store
            .confirm_supplier_order(ConfirmSupplierOrderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: aggregate_order_id.into(),
            })
            .unwrap();
        let aggregate_receipt = store
            .save_supplier_receipt_draft(SaveSupplierReceiptDraftInput {
                receipt: SupplierReceiptDraftInput {
                    id: Some("503f954e-bbe0-40ae-a5e3-f5c30a2fc8ec".into()),
                    supplier_order_id: aggregate_order_id.into(),
                    receipt_date: "2026-08-04".into(),
                    reference: None,
                    notes: None,
                },
                lines: vec![
                    SupplierReceiptLineInput {
                        supplier_order_line_id: aggregate_line_one.into(),
                        quantity_milli: 5_000,
                    },
                    SupplierReceiptLineInput {
                        supplier_order_line_id: aggregate_line_two.into(),
                        quantity_milli: 5_000,
                    },
                ],
            })
            .unwrap();
        let aggregate_receipt_id = aggregate_receipt["receipt"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        store
            .issue_supplier_receipt(IssueSupplierReceiptInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_receipt_id: aggregate_receipt_id.clone(),
            })
            .unwrap();
        store
            .record_stock_exit(StockExitInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                catalog_item_id: product_id.clone(),
                quantity_milli: 3_000,
                reason: "Consommation avant retour".into(),
                reference: None,
                date: Some("2026-08-05".into()),
            })
            .unwrap();
        let error = store
            .reverse_supplier_receipt(ReverseSupplierReceiptInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_receipt_id: aggregate_receipt_id.clone(),
                reason: "Retour impossible".into(),
            })
            .unwrap_err()
            .to_string();
        assert!(error.contains("ne permet pas d’extourner"), "{error}");
        let aggregate_state: (String, i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT receipt.status,item.stock_quantity_milli,(SELECT COUNT(*) FROM stock_movements WHERE supplier_receipt_id=receipt.id) FROM supplier_receipts receipt JOIN catalog_items item ON item.id=? WHERE receipt.id=?",
                rusqlite::params![product_id, aggregate_receipt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(aggregate_state, ("issued".into(), 7_000, 2));
    }

    #[test]
    fn supplier_invoice_price_mismatch_stays_a_resolvable_draft() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let supplier_id = value_id(
            &store
                .create_record("suppliers", json!({"name":"Contrôle trois voies SA"}))
                .unwrap(),
        );
        let order_id = "1b74e920-9116-4ae5-9ed1-bdbb001250c8";
        let order_line_id = "c7862571-4da6-4773-9b15-597131db5189";
        store
            .save_supplier_order_draft(SaveSupplierOrderDraftInput {
                order: SupplierOrderDraftInput {
                    id: Some(order_id.into()),
                    supplier_id: supplier_id.clone(),
                    project_id: None,
                    title: "Commande au prix convenu".into(),
                    order_date: "2026-08-10".into(),
                    currency: "CHF".into(),
                    notes: None,
                    terms: None,
                },
                lines: vec![SupplierOrderLineInput {
                    id: Some(order_line_id.into()),
                    catalog_item_id: None,
                    position: 0,
                    description: "Prestation".into(),
                    quantity_milli: 1_000,
                    unit: "forfait".into(),
                    unit_price_cents: 500,
                    discount_bp: 0,
                    vat_bp: 0,
                    category: "Charges".into(),
                    expense_account_id: None,
                    project_id: None,
                    fulfillment_mode: "direct".into(),
                }],
            })
            .unwrap();
        store
            .confirm_supplier_order(ConfirmSupplierOrderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: order_id.into(),
            })
            .unwrap();
        let invoice_id = "2b2b3973-d073-44ab-b94f-a3eb9b8bea62";
        let invoice_item_id = "32376587-20ba-4729-a120-58a766cf0870";
        store
            .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
                id: Some(invoice_id.into()),
                supplier_id,
                project_id: None,
                date: "2026-08-11".into(),
                due_date: "2026-09-10".into(),
                reference: Some("ECART-PRIX-1".into()),
                note: None,
                items: vec![SupplierInvoiceLineInput {
                    id: Some(invoice_item_id.into()),
                    description: "Prestation facturée".into(),
                    quantity_milli: 1_000,
                    unit: Some("forfait".into()),
                    unit_price_cents: 600,
                    discount_bp: 0,
                    vat_bp: 0,
                    category: "Charges".into(),
                    expense_account_id: None,
                    project_id: None,
                }],
            })
            .unwrap();
        assert!(
            store
                .save_supplier_invoice_match(SaveSupplierInvoiceMatchInput {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    supplier_invoice_id: invoice_id.into(),
                    supplier_order_id: order_id.into(),
                    allocations: vec![],
                    order_allocations: vec![],
                })
                .is_err(),
            "une liste vide ne crée pas un rapprochement initial"
        );
        store
            .save_supplier_invoice_match(SaveSupplierInvoiceMatchInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_invoice_id: invoice_id.into(),
                supplier_order_id: order_id.into(),
                allocations: vec![SupplierInvoiceMatchAllocationInput {
                    supplier_invoice_item_id: invoice_item_id.into(),
                    supplier_order_line_id: order_line_id.into(),
                    supplier_receipt_line_id: None,
                    quantity_milli: 1_000,
                }],
                order_allocations: vec![],
            })
            .unwrap();
        let before = store.get_workspace().unwrap();
        let invoice = before["supplier_invoices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == invoice_id)
            .unwrap();
        assert_eq!(invoice["match_status"], "mismatch");
        let error = store
            .validate_supplier_invoice(invoice_id)
            .unwrap_err()
            .to_string();
        assert!(error.contains("rapprochement"), "{error}");
        let state: (String, String, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT invoice.status,order_row.status,(SELECT COUNT(*) FROM journal_entries WHERE source_type='supplier_invoice' AND source_id=invoice.id) FROM supplier_invoices invoice JOIN supplier_orders order_row ON order_row.id=? WHERE invoice.id=?",
                rusqlite::params![order_id, invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, ("draft".into(), "confirmed".into(), 0));
    }

    #[test]
    fn supplier_match_rounding_is_exact_across_multiple_orders() {
        let (_temporary, store) = initialized_store();
        enable_accounting(&store);
        let supplier_id = value_id(
            &store
                .create_record("suppliers", json!({"name":"Arrondis achats SA"}))
                .unwrap(),
        );
        let order_id = "631ea32a-4335-4ef4-86fa-7eacb544ae4f";
        let first_order_line_id = "11111111-1111-4111-8111-111111111111";
        let second_order_line_id = "22222222-2222-4222-8222-222222222222";
        let make_line = |id: &str, position: i64| SupplierOrderLineInput {
            id: Some(id.into()),
            catalog_item_id: None,
            position,
            description: format!("Demi-unité {}", position + 1),
            quantity_milli: 1_000,
            unit: "unité".into(),
            unit_price_cents: 1,
            discount_bp: 5_000,
            vat_bp: 0,
            category: "Charges".into(),
            expense_account_id: None,
            project_id: None,
            fulfillment_mode: "direct".into(),
        };
        store
            .save_supplier_order_draft(SaveSupplierOrderDraftInput {
                order: SupplierOrderDraftInput {
                    id: Some(order_id.into()),
                    supplier_id: supplier_id.clone(),
                    project_id: None,
                    title: "Commande avec arrondi".into(),
                    order_date: "2026-08-15".into(),
                    currency: "CHF".into(),
                    notes: None,
                    terms: None,
                },
                lines: vec![
                    make_line(first_order_line_id, 0),
                    make_line(second_order_line_id, 1),
                ],
            })
            .unwrap();
        store
            .confirm_supplier_order(ConfirmSupplierOrderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: order_id.into(),
            })
            .unwrap();
        let invoice_id = "939c9248-0832-4fe1-91b3-185958b6a13d";
        let invoice_item_id = "6ad5babb-f280-4e19-8aab-a7446973cac9";
        store
            .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
                id: Some(invoice_id.into()),
                supplier_id: supplier_id.clone(),
                project_id: None,
                date: "2026-08-16".into(),
                due_date: "2026-09-15".into(),
                reference: Some("ARRONDI-1".into()),
                note: None,
                items: vec![SupplierInvoiceLineInput {
                    id: Some(invoice_item_id.into()),
                    description: "Deux unités remisées".into(),
                    quantity_milli: 2_000,
                    unit: Some("unité".into()),
                    unit_price_cents: 1,
                    discount_bp: 5_000,
                    vat_bp: 0,
                    category: "Charges".into(),
                    expense_account_id: None,
                    project_id: None,
                }],
            })
            .unwrap();
        let mut tamper_connection = store.connect().unwrap();
        let tamper_tx = tamper_connection.transaction().unwrap();
        tamper_tx.execute(
            "INSERT INTO supplier_invoice_matches(id,request_id,supplier_invoice_id,supplier_invoice_item_id,supplier_order_id,supplier_order_line_id,quantity_milli,net_cents,vat_cents,total_cents,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(),uuid::Uuid::new_v4().to_string(),invoice_id,invoice_item_id,order_id,first_order_line_id,1_000,1,0,1,"2026-08-16T00:00:00Z"],
        ).unwrap();
        assert!(tamper_tx.execute(
            "INSERT INTO supplier_invoice_matches(id,request_id,supplier_invoice_id,supplier_invoice_item_id,supplier_order_id,supplier_order_line_id,quantity_milli,net_cents,vat_cents,total_cents,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(),uuid::Uuid::new_v4().to_string(),invoice_id,invoice_item_id,order_id,second_order_line_id,1_000,1,0,1,"2026-08-16T00:00:01Z"],
        ).is_err(), "SQLite refuse que deux allocations arrondissent chacune le même centime");
        tamper_tx.rollback().unwrap();
        let matched = store
            .save_supplier_invoice_match(SaveSupplierInvoiceMatchInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_invoice_id: invoice_id.into(),
                supplier_order_id: order_id.into(),
                allocations: vec![
                    SupplierInvoiceMatchAllocationInput {
                        supplier_invoice_item_id: invoice_item_id.into(),
                        supplier_order_line_id: second_order_line_id.into(),
                        supplier_receipt_line_id: None,
                        quantity_milli: 1_000,
                    },
                    SupplierInvoiceMatchAllocationInput {
                        supplier_invoice_item_id: invoice_item_id.into(),
                        supplier_order_line_id: first_order_line_id.into(),
                        supplier_receipt_line_id: None,
                        quantity_milli: 1_000,
                    },
                ],
                order_allocations: vec![],
            })
            .unwrap();
        let allocated = matched["matches"].as_array().unwrap();
        assert_eq!(
            allocated
                .iter()
                .map(|row| row["quantity_milli"].as_i64().unwrap())
                .sum::<i64>(),
            2_000
        );
        assert_eq!(
            allocated
                .iter()
                .map(|row| row["net_cents"].as_i64().unwrap())
                .sum::<i64>(),
            1,
            "le centime résiduel est réparti une seule fois"
        );
        assert_eq!(
            allocated
                .iter()
                .map(|row| row["total_cents"].as_i64().unwrap())
                .sum::<i64>(),
            1
        );
        let alternate_order_id = "89029111-66a6-4558-8b9d-2618ae441026";
        let alternate_line_id = "50dfdd04-f535-409f-b13d-8d71342df723";
        store
            .save_supplier_order_draft(SaveSupplierOrderDraftInput {
                order: SupplierOrderDraftInput {
                    id: Some(alternate_order_id.into()),
                    supplier_id: supplier_id.clone(),
                    project_id: None,
                    title: "Autre commande".into(),
                    order_date: "2026-08-15".into(),
                    currency: "CHF".into(),
                    notes: None,
                    terms: None,
                },
                lines: vec![SupplierOrderLineInput {
                    id: Some(alternate_line_id.into()),
                    catalog_item_id: None,
                    position: 0,
                    description: "Autre commande".into(),
                    quantity_milli: 2_000,
                    unit: "unité".into(),
                    unit_price_cents: 1,
                    discount_bp: 5_000,
                    vat_bp: 0,
                    category: "Charges".into(),
                    expense_account_id: None,
                    project_id: None,
                    fulfillment_mode: "direct".into(),
                }],
            })
            .unwrap();
        store
            .confirm_supplier_order(ConfirmSupplierOrderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: alternate_order_id.into(),
            })
            .unwrap();
        let multi_request = SaveSupplierInvoiceMatchInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_invoice_id: invoice_id.into(),
            supplier_order_id: order_id.into(),
            allocations: vec![SupplierInvoiceMatchAllocationInput {
                supplier_invoice_item_id: invoice_item_id.into(),
                supplier_order_line_id: first_order_line_id.into(),
                supplier_receipt_line_id: None,
                quantity_milli: 1_000,
            }],
            order_allocations: vec![SupplierInvoiceOrderAllocationsInput {
                supplier_order_id: alternate_order_id.into(),
                allocations: vec![SupplierInvoiceMatchAllocationInput {
                    supplier_invoice_item_id: invoice_item_id.into(),
                    supplier_order_line_id: alternate_line_id.into(),
                    supplier_receipt_line_id: None,
                    quantity_milli: 1_000,
                }],
            }],
        };
        let multi = store
            .save_supplier_invoice_match(multi_request.clone())
            .unwrap();
        assert_eq!(multi["orders"].as_array().unwrap().len(), 2);
        assert_eq!(
            multi["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["quantity_milli"].as_i64().unwrap())
                .sum::<i64>(),
            2_000
        );
        assert_eq!(
            multi["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["net_cents"].as_i64().unwrap())
                .sum::<i64>(),
            1,
            "le centime de la facture est réparti une seule fois entre les commandes"
        );
        assert_eq!(
            store.save_supplier_invoice_match(multi_request).unwrap()["idempotent"],
            true
        );
        let foreign_supplier_id = value_id(
            &store
                .create_record("suppliers", json!({"name":"Autre fournisseur SA"}))
                .unwrap(),
        );
        let foreign_order_id = "0a66b1bd-ffb8-4c86-9f4f-76aca1489432";
        let foreign_line_id = "1099e70f-241c-4d60-9dd8-c0a573685e84";
        store
            .save_supplier_order_draft(SaveSupplierOrderDraftInput {
                order: SupplierOrderDraftInput {
                    id: Some(foreign_order_id.into()),
                    supplier_id: foreign_supplier_id,
                    project_id: None,
                    title: "Commande étrangère".into(),
                    order_date: "2026-08-15".into(),
                    currency: "CHF".into(),
                    notes: None,
                    terms: None,
                },
                lines: vec![make_line(foreign_line_id, 0)],
            })
            .unwrap();
        store
            .confirm_supplier_order(ConfirmSupplierOrderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: foreign_order_id.into(),
            })
            .unwrap();
        let invalid_multi = store
            .save_supplier_invoice_match(SaveSupplierInvoiceMatchInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_invoice_id: invoice_id.into(),
                supplier_order_id: order_id.into(),
                allocations: vec![SupplierInvoiceMatchAllocationInput {
                    supplier_invoice_item_id: invoice_item_id.into(),
                    supplier_order_line_id: first_order_line_id.into(),
                    supplier_receipt_line_id: None,
                    quantity_milli: 1_000,
                }],
                order_allocations: vec![SupplierInvoiceOrderAllocationsInput {
                    supplier_order_id: foreign_order_id.into(),
                    allocations: vec![SupplierInvoiceMatchAllocationInput {
                        supplier_invoice_item_id: invoice_item_id.into(),
                        supplier_order_line_id: foreign_line_id.into(),
                        supplier_receipt_line_id: None,
                        quantity_milli: 1_000,
                    }],
                }],
            })
            .unwrap_err()
            .to_string();
        assert!(
            invalid_multi.contains("même fournisseur"),
            "{invalid_multi}"
        );
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM supplier_invoice_matches WHERE supplier_invoice_id=?",
                    rusqlite::params![invoice_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2,
            "une commande incompatible ne doit supprimer aucune allocation existante"
        );
        let direct_match_id = multi["matches"][0]["id"].as_str().unwrap();
        assert!(
            store
                .connect()
                .unwrap()
                .execute(
                    "UPDATE supplier_invoice_matches SET supplier_order_id=? WHERE id=?",
                    rusqlite::params![alternate_order_id, direct_match_id],
                )
                .is_err(),
            "une allocation enregistrée reste immuable en SQL"
        );
        store.validate_supplier_invoice(invoice_id).unwrap();
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT status FROM supplier_orders WHERE id=?",
                    rusqlite::params![order_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "confirmed",
            "la première commande reste ouverte car une de ses lignes n’est pas rapprochée"
        );
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT status FROM supplier_orders WHERE id=?",
                    rusqlite::params![alternate_order_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "confirmed",
            "la commande supplémentaire reste ouverte pour son reliquat"
        );

        let global_tolerance_invoice_id = "791c8b1c-4fab-49f1-95fc-e6797f2e9512";
        let global_tolerance_item_ids = [
            "fc903077-a9e8-4d34-bb38-c7b95df52169",
            "d8b0a95c-6098-4c1e-900b-6f68a59fa470",
        ];
        store
            .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
                id: Some(global_tolerance_invoice_id.into()),
                supplier_id: supplier_id.clone(),
                project_id: None,
                date: "2026-08-17".into(),
                due_date: "2026-09-16".into(),
                reference: Some("TOLERANCE-GLOBALE-DEUX-COMMANDES".into()),
                note: None,
                items: global_tolerance_item_ids
                    .iter()
                    .enumerate()
                    .map(|(position, id)| SupplierInvoiceLineInput {
                        id: Some((*id).into()),
                        description: format!("Écart global {}", position + 1),
                        quantity_milli: 1_000,
                        unit: Some("unité".into()),
                        unit_price_cents: 2,
                        discount_bp: 0,
                        vat_bp: 0,
                        category: "Charges".into(),
                        expense_account_id: None,
                        project_id: None,
                    })
                    .collect(),
            })
            .unwrap();
        store
            .save_supplier_invoice_match(SaveSupplierInvoiceMatchInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_invoice_id: global_tolerance_invoice_id.into(),
                supplier_order_id: order_id.into(),
                allocations: vec![SupplierInvoiceMatchAllocationInput {
                    supplier_invoice_item_id: global_tolerance_item_ids[0].into(),
                    supplier_order_line_id: second_order_line_id.into(),
                    supplier_receipt_line_id: None,
                    quantity_milli: 1_000,
                }],
                order_allocations: vec![SupplierInvoiceOrderAllocationsInput {
                    supplier_order_id: alternate_order_id.into(),
                    allocations: vec![SupplierInvoiceMatchAllocationInput {
                        supplier_invoice_item_id: global_tolerance_item_ids[1].into(),
                        supplier_order_line_id: alternate_line_id.into(),
                        supplier_receipt_line_id: None,
                        quantity_milli: 1_000,
                    }],
                }],
            })
            .unwrap();
        let global_tolerance_workspace = store.get_workspace().unwrap();
        assert_eq!(
            global_tolerance_workspace["supplier_invoices"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == global_tolerance_invoice_id)
                .unwrap()["match_status"],
            "mismatch",
            "deux écarts unitaires tolérés ne doivent pas multiplier la tolérance par commande"
        );
        assert!(store
            .validate_supplier_invoice(global_tolerance_invoice_id)
            .is_err());
        for linked_order_id in [order_id, alternate_order_id] {
            assert_eq!(
                store
                    .connect()
                    .unwrap()
                    .query_row(
                        "SELECT status FROM supplier_orders WHERE id=?",
                        rusqlite::params![linked_order_id],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap(),
                "confirmed",
                "un écart global supérieur à la tolérance ne doit clôturer aucune commande"
            );
        }

        let amplified_order_id = "1c35b60c-98aa-4815-a0cf-bff167c1e078";
        let amplified_line_ids = [
            "33333333-3333-4333-8333-333333333333",
            "44444444-4444-4444-8444-444444444444",
            "55555555-5555-4555-8555-555555555555",
        ];
        let amplified_item_ids = [
            "d4578976-348d-4687-b69d-72bdc31cfad3",
            "0c050135-7cdd-473e-a5a1-d7b27dff7dc6",
            "349720e8-3064-4af1-a12d-7dc4b6fc89f9",
        ];
        store
            .save_supplier_order_draft(SaveSupplierOrderDraftInput {
                order: SupplierOrderDraftInput {
                    id: Some(amplified_order_id.into()),
                    supplier_id: supplier_id.clone(),
                    project_id: None,
                    title: "Commande révélant la tolérance cumulée".into(),
                    order_date: "2026-08-17".into(),
                    currency: "CHF".into(),
                    notes: None,
                    terms: None,
                },
                lines: amplified_line_ids
                    .iter()
                    .enumerate()
                    .map(|(position, id)| SupplierOrderLineInput {
                        id: Some((*id).into()),
                        catalog_item_id: None,
                        position: position as i64,
                        description: format!("Centime commandé {}", position + 1),
                        quantity_milli: 1_000,
                        unit: "unité".into(),
                        unit_price_cents: 2,
                        discount_bp: 0,
                        vat_bp: 0,
                        category: "Charges".into(),
                        expense_account_id: None,
                        project_id: None,
                        fulfillment_mode: "direct".into(),
                    })
                    .collect(),
            })
            .unwrap();
        store
            .confirm_supplier_order(ConfirmSupplierOrderInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_order_id: amplified_order_id.into(),
            })
            .unwrap();
        let amplified_invoice_id = "88998563-75ce-4268-a235-3804152f24c4";
        store
            .save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
                id: Some(amplified_invoice_id.into()),
                supplier_id,
                project_id: None,
                date: "2026-08-18".into(),
                due_date: "2026-09-17".into(),
                reference: Some("TOLERANCE-CUMULEE-1".into()),
                note: None,
                items: amplified_item_ids
                    .iter()
                    .enumerate()
                    .map(|(position, id)| SupplierInvoiceLineInput {
                        id: Some((*id).into()),
                        description: format!("Centime facturé {}", position + 1),
                        quantity_milli: 1_000,
                        unit: Some("unité".into()),
                        unit_price_cents: 1,
                        discount_bp: 0,
                        vat_bp: 0,
                        category: "Charges".into(),
                        expense_account_id: None,
                        project_id: None,
                    })
                    .collect(),
            })
            .unwrap();
        store
            .save_supplier_invoice_match(SaveSupplierInvoiceMatchInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                supplier_invoice_id: amplified_invoice_id.into(),
                supplier_order_id: amplified_order_id.into(),
                allocations: amplified_item_ids
                    .iter()
                    .zip(amplified_line_ids.iter())
                    .map(|(item_id, line_id)| SupplierInvoiceMatchAllocationInput {
                        supplier_invoice_item_id: (*item_id).into(),
                        supplier_order_line_id: (*line_id).into(),
                        supplier_receipt_line_id: None,
                        quantity_milli: 1_000,
                    })
                    .collect(),
                order_allocations: vec![],
            })
            .unwrap();
        let amplified_workspace = store.get_workspace().unwrap();
        assert_eq!(
            amplified_workspace["supplier_invoices"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == amplified_invoice_id)
                .unwrap()["match_status"],
            "mismatch"
        );
        assert!(store
            .validate_supplier_invoice(amplified_invoice_id)
            .is_err());
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT status FROM supplier_orders WHERE id=?",
                    rusqlite::params![amplified_order_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "confirmed",
            "la tolérance ne peut pas s’amplifier jusqu’à clôturer la commande"
        );
    }

    #[test]
    fn supplier_large_confirmation_replays_from_compact_operation_metadata() {
        let (_temporary, store) = initialized_store();
        let supplier_id = value_id(
            &store
                .create_record("suppliers", json!({"name":"Commande volumineuse SA"}))
                .unwrap(),
        );
        let order_id = "38c89c75-d328-4e46-b77b-faa280cb82f5";
        let description = "Description contractuelle détaillée ".repeat(30);
        let lines = (0..550)
            .map(|position| SupplierOrderLineInput {
                id: Some(uuid::Uuid::new_v4().to_string()),
                catalog_item_id: None,
                position,
                description: format!("{description}{position}"),
                quantity_milli: 1_000,
                unit: "unité".into(),
                unit_price_cents: 1,
                discount_bp: 0,
                vat_bp: 0,
                category: "Charges".into(),
                expense_account_id: None,
                project_id: None,
                fulfillment_mode: "direct".into(),
            })
            .collect();
        store
            .save_supplier_order_draft(SaveSupplierOrderDraftInput {
                order: SupplierOrderDraftInput {
                    id: Some(order_id.into()),
                    supplier_id,
                    project_id: None,
                    title: "Commande avec contenu conséquent".into(),
                    order_date: "2026-08-20".into(),
                    currency: "CHF".into(),
                    notes: None,
                    terms: None,
                },
                lines,
            })
            .unwrap();
        let confirm = ConfirmSupplierOrderInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_order_id: order_id.into(),
        };
        let confirmed = store.confirm_supplier_order(confirm.clone()).unwrap();
        assert!(serde_json::to_vec(&confirmed).unwrap().len() > 500_000);
        let stored_lengths: (i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT LENGTH(payload_json),LENGTH(response_json) FROM supplier_operation_requests WHERE request_id=?",
                rusqlite::params![confirm.request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(stored_lengths.0 < 1_000 && stored_lengths.1 < 1_000);
        let replay = store.confirm_supplier_order(confirm).unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(replay["lines"].as_array().unwrap().len(), 550);
    }

    #[test]
    fn manual_stock_ledger_is_idempotent_bounded_and_tamper_resistant() {
        let (_temporary, store) = initialized_store();
        let catalog_item_id = tracked_product(&store, "Article registre", 2_000);
        let entry_request_id = uuid::Uuid::new_v4().to_string();
        let entry_input = StockEntryInput {
            request_id: entry_request_id.clone(),
            catalog_item_id: catalog_item_id.clone(),
            quantity_milli: 5_000,
            reason: "Réception fournisseur".into(),
            reference: Some("BL-2026-001".into()),
            date: Some("2026-09-01".into()),
        };
        let entry = store.record_stock_entry(entry_input.clone()).unwrap();
        assert_eq!(entry["idempotent"], false);
        assert_eq!(entry["movement"]["quantity_delta_milli"], 5_000);
        assert_eq!(entry["catalog_item"]["stock_quantity_milli"], 5_000);

        let replay = store.record_stock_entry(entry_input).unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(replay["movement"]["id"], entry["movement"]["id"]);
        assert!(store
            .record_stock_entry(StockEntryInput {
                request_id: entry_request_id,
                catalog_item_id: catalog_item_id.clone(),
                quantity_milli: 5_001,
                reason: "Réception fournisseur".into(),
                reference: Some("BL-2026-001".into()),
                date: Some("2026-09-01".into()),
            })
            .unwrap_err()
            .to_string()
            .contains("déjà été utilisé"));

        let exit = store
            .record_stock_exit(StockExitInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                catalog_item_id: catalog_item_id.clone(),
                quantity_milli: 1_250,
                reason: "Consommation chantier".into(),
                reference: Some("CHANTIER-42".into()),
                date: Some("2026-09-02".into()),
            })
            .unwrap();
        assert_eq!(exit["catalog_item"]["stock_quantity_milli"], 3_750);
        let correction = store
            .record_stock_correction(StockCorrectionInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                catalog_item_id: catalog_item_id.clone(),
                delta_quantity_milli: -750,
                reason: "Écart inventaire contrôlé".into(),
                reference: None,
                date: Some("2026-09-03".into()),
            })
            .unwrap();
        assert_eq!(correction["catalog_item"]["stock_quantity_milli"], 3_000);

        assert!(store
            .record_stock_exit(StockExitInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                catalog_item_id: catalog_item_id.clone(),
                quantity_milli: 3_001,
                reason: "Sortie impossible".into(),
                reference: None,
                date: None,
            })
            .unwrap_err()
            .to_string()
            .contains("Stock insuffisant"));
        assert!(store
            .record_stock_entry(StockEntryInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                catalog_item_id: catalog_item_id.clone(),
                quantity_milli: 9_000_000_000_000_000,
                reason: "Dépassement impossible".into(),
                reference: None,
                date: None,
            })
            .is_err());

        assert!(store
            .update_record(
                "catalog_items",
                &catalog_item_id,
                json!({"stock_quantity_milli":4_000}),
            )
            .is_err());
        assert!(store
            .update_record(
                "catalog_items",
                &catalog_item_id,
                json!({"track_stock":false}),
            )
            .is_err());
        assert!(store
            .update_record("catalog_items", &catalog_item_id, json!({"kind":"service"}),)
            .is_err());
        let direct = store.connect().unwrap();
        assert!(direct
            .execute(
                "UPDATE stock_movements SET reason='altéré' WHERE id=?",
                rusqlite::params![entry["movement"]["id"].as_str().unwrap()],
            )
            .is_err());
        assert!(direct
            .execute(
                "DELETE FROM stock_movements WHERE id=?",
                rusqlite::params![entry["movement"]["id"].as_str().unwrap()],
            )
            .is_err());
        let movement_count: i64 = direct
            .query_row("SELECT COUNT(*) FROM stock_movements", [], |row| row.get(0))
            .unwrap();
        assert_eq!(movement_count, 3);
        drop(direct);

        let workspace = store.get_workspace().unwrap();
        let item = workspace["catalog_items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == catalog_item_id)
            .unwrap();
        assert_eq!(item["stock_quantity_milli"], 3_000);
        assert_eq!(item["stock_status"], "in_stock");
        assert_eq!(workspace["stock_movements"].as_array().unwrap().len(), 3);
        assert_eq!(store.verify_audit_log().unwrap()["valid"], true);

        assert!(store
            .create_record(
                "catalog_items",
                json!({
                    "kind":"product",
                    "name":"Stock initial interdit",
                    "track_stock":true,
                    "stock_quantity_milli":1
                }),
            )
            .is_err());
        assert!(store
            .create_record(
                "catalog_items",
                json!({
                    "kind":"service",
                    "name":"Service jamais suivi",
                    "track_stock":true,
                    "stock_quantity_milli":0
                }),
            )
            .unwrap_err()
            .to_string()
            .contains("uniquement"));
        let stale_untracked = value_id(
            &store
                .create_record(
                    "catalog_items",
                    json!({
                        "kind":"product",
                        "name":"Ancien solde non suivi",
                        "track_stock":false,
                        "stock_quantity_milli":1_000
                    }),
                )
                .unwrap(),
        );
        assert!(store
            .update_record(
                "catalog_items",
                &stale_untracked,
                json!({"track_stock":true}),
            )
            .is_err());
    }

    #[test]
    fn invoice_stock_exit_is_atomic_idempotent_and_skips_credit_notes() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client stock"))
                .unwrap(),
        );
        let first_item_id = tracked_product(&store, "Produit A", 1_000);
        let second_item_id = tracked_product(&store, "Produit B", 500);
        for (catalog_item_id, quantity_milli, reference) in [
            (first_item_id.clone(), 10_000, "OPEN-A"),
            (second_item_id.clone(), 1_000, "OPEN-B"),
        ] {
            store
                .record_stock_entry(StockEntryInput {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    catalog_item_id,
                    quantity_milli,
                    reason: "Ouverture contrôlée".into(),
                    reference: Some(reference.into()),
                    date: Some("2026-09-01".into()),
                })
                .unwrap();
        }

        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture stock atomique",
                        "type":"standard",
                        "service_date_from":"2026-09-01",
                        "service_date_to":"2026-09-01"
                    }),
                )
                .unwrap(),
        );
        let first_line_id = value_id(
            &store
                .create_record(
                    "invoice_items",
                    json!({
                        "invoice_id":invoice_id,
                        "catalog_item_id":first_item_id,
                        "description":"Produit A, lot 1",
                        "quantity":2.5,
                        "unit":"unité",
                        "unit_price_cents":1_000,
                        "vat_bp":0
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":invoice_id,
                    "catalog_item_id":first_item_id,
                    "description":"Produit A, lot 2",
                    "quantity":1.25,
                    "unit":"unité",
                    "unit_price_cents":1_000,
                    "vat_bp":0
                }),
            )
            .unwrap();
        let second_line_id = value_id(
            &store
                .create_record(
                    "invoice_items",
                    json!({
                        "invoice_id":invoice_id,
                        "catalog_item_id":second_item_id,
                        "description":"Produit B",
                        "quantity":1.001,
                        "unit":"unité",
                        "unit_price_cents":1_000,
                        "vat_bp":0
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":invoice_id,
                    "description":"Prestation non suivie",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":500,
                    "vat_bp":0
                }),
            )
            .unwrap();

        assert!(store
            .issue_invoice(&invoice_id, Some("2026-09-02".into()), None)
            .unwrap_err()
            .to_string()
            .contains("Stock insuffisant"));
        let connection = store.connect().unwrap();
        let failed_state: (Option<String>, i64, i64, i64) = connection
            .query_row(
                "SELECT invoice.number,
                        (SELECT stock_quantity_milli FROM catalog_items WHERE id=?2),
                        (SELECT stock_quantity_milli FROM catalog_items WHERE id=?3),
                        (SELECT COUNT(*) FROM stock_movements WHERE invoice_id=?1)
                 FROM invoices invoice WHERE invoice.id=?1",
                rusqlite::params![invoice_id, first_item_id, second_item_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(failed_state, (None, 10_000, 1_000, 0));
        drop(connection);

        store
            .record_stock_entry(StockEntryInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                catalog_item_id: second_item_id.clone(),
                quantity_milli: 1,
                reason: "Complément avant émission".into(),
                reference: None,
                date: Some("2026-09-02".into()),
            })
            .unwrap();
        let connection = store.connect().unwrap();
        connection
            .execute_batch(&format!(
                "CREATE TRIGGER test_stock_failure BEFORE INSERT ON stock_movements
                 WHEN NEW.invoice_item_id='{second_line_id}'
                 BEGIN SELECT RAISE(ABORT,'simulated stock failure'); END;"
            ))
            .unwrap();
        drop(connection);
        assert!(store
            .issue_invoice(&invoice_id, Some("2026-09-02".into()), None)
            .unwrap_err()
            .to_string()
            .contains("simulated stock failure"));
        let connection = store.connect().unwrap();
        let rolled_back: (Option<String>, i64, i64, i64) = connection
            .query_row(
                "SELECT invoice.number,
                        (SELECT stock_quantity_milli FROM catalog_items WHERE id=?2),
                        (SELECT stock_quantity_milli FROM catalog_items WHERE id=?3),
                        (SELECT COUNT(*) FROM stock_movements WHERE invoice_id=?1)
                 FROM invoices invoice WHERE invoice.id=?1",
                rusqlite::params![invoice_id, first_item_id, second_item_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(rolled_back, (None, 10_000, 1_001, 0));
        connection
            .execute_batch("DROP TRIGGER test_stock_failure;")
            .unwrap();
        drop(connection);

        let issued = store
            .issue_invoice(&invoice_id, Some("2026-09-02".into()), None)
            .unwrap();
        assert_eq!(issued["status"], "emise");
        let connection = store.connect().unwrap();
        let issued_state: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT stock_quantity_milli FROM catalog_items WHERE id=?2),
                   (SELECT stock_quantity_milli FROM catalog_items WHERE id=?3),
                   (SELECT COUNT(*) FROM stock_movements WHERE invoice_id=?1)",
                rusqlite::params![invoice_id, first_item_id, second_item_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(issued_state, (6_250, 0, 3));
        let first_line_delta: i64 = connection
            .query_row(
                "SELECT quantity_delta_milli FROM stock_movements WHERE invoice_item_id=?",
                rusqlite::params![first_line_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first_line_delta, -2_500);
        assert!(connection
            .execute(
                "UPDATE invoices SET status='annulee' WHERE id=?",
                rusqlite::params![invoice_id],
            )
            .is_err());
        drop(connection);

        store
            .issue_invoice(&invoice_id, Some("2026-09-02".into()), None)
            .unwrap();
        let replay_count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM stock_movements WHERE invoice_id=?",
                rusqlite::params![invoice_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(replay_count, 3);

        let credit_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "original_invoice_id":invoice_id,
                        "title":"Avoir sans retour stock implicite",
                        "type":"credit_note",
                        "service_date_from":"2026-09-01",
                        "service_date_to":"2026-09-01"
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":credit_id,
                    "catalog_item_id":first_item_id,
                    "description":"Avoir produit sans retour physique",
                    "quantity":1,
                    "unit":"unité",
                    "unit_price_cents":1_000,
                    "vat_bp":0
                }),
            )
            .unwrap();
        store
            .issue_invoice(&credit_id, Some("2026-09-03".into()), None)
            .unwrap();
        let credit_state: (i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT
                   (SELECT stock_quantity_milli FROM catalog_items WHERE id=?2),
                   (SELECT COUNT(*) FROM stock_movements WHERE invoice_id=?1)",
                rusqlite::params![credit_id, first_item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(credit_state, (6_250, 0));

        for (invoice_type, issue_date) in [
            ("deposit", "2026-09-04"),
            ("progress", "2026-09-05"),
            ("final", "2026-09-06"),
        ] {
            let is_deposit = invoice_type == "deposit";
            let deposit_percentage_bp = is_deposit.then_some(3_000);
            let deposit_basis_json = is_deposit.then(|| {
                json!([{
                    "id":"deposit-base-stock-line",
                    "catalog_item_id":first_item_id,
                    "description":"Produit sans livraison dédiée",
                    "quantity":1,
                    "unit":"unité",
                    "unit_price_cents":1_000,
                    "discount_bp":0,
                    "vat_bp":0
                }])
            });
            let special_invoice_id = value_id(
                &store
                    .create_record(
                        "invoices",
                        json!({
                            "client_id":client_id,
                            "title":format!("Document {invoice_type} sans sortie automatique"),
                            "type":invoice_type,
                            "deposit_percentage_bp":deposit_percentage_bp,
                            "deposit_basis_json":deposit_basis_json,
                            "service_date_from":"2026-09-01",
                            "service_date_to":"2026-09-01"
                        }),
                    )
                    .unwrap(),
            );
            store
                .create_record(
                    "invoice_items",
                    json!({
                        "invoice_id":special_invoice_id,
                        "catalog_item_id":if is_deposit { None } else { Some(first_item_id.as_str()) },
                        "description":if is_deposit { "Acompte 30 % — Produit sans livraison dédiée" } else { "Produit sans livraison dédiée" },
                        "quantity":1,
                        "unit":if is_deposit { "acompte" } else { "unité" },
                        "unit_price_cents":if is_deposit { 300 } else { 1_000 },
                        "discount_bp":0,
                        "vat_bp":0
                    }),
                )
                .unwrap();
            store
                .issue_invoice(&special_invoice_id, Some(issue_date.into()), None)
                .unwrap();
            let special_state: (i64, i64) = store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT
                       (SELECT stock_quantity_milli FROM catalog_items WHERE id=?2),
                       (SELECT COUNT(*) FROM stock_movements WHERE invoice_id=?1)",
                    rusqlite::params![special_invoice_id, first_item_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(special_state, (6_250, 0), "type {invoice_type}");
        }
        assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
    }

    #[test]
    fn paid_invoice_correction_preserves_original_and_requires_credit_first() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client correction"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture historique",
                        "type":"standard",
                        "service_date_from":"2026-09-01",
                        "service_date_to":"2026-09-01",
                        "notes":"Texte original"
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":invoice_id,
                    "description":"Prestation originale",
                    "quantity":2,
                    "unit":"heure",
                    "unit_price_cents":12_500,
                    "vat_bp":810
                }),
            )
            .unwrap();
        let issued = store
            .issue_invoice(&invoice_id, Some("2026-09-02".into()), None)
            .unwrap();
        let original_number = issued["number"].as_str().unwrap().to_owned();
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE invoices SET status='payee',paid_cents=total_cents WHERE id=?",
                rusqlite::params![invoice_id],
            )
            .unwrap();

        let correction = store
            .create_invoice_correction(CreateInvoiceCorrectionInput {
                original_invoice_id: invoice_id.clone(),
                reason: "Montant et description à rectifier".into(),
            })
            .unwrap();
        let credit_id = correction["credit_note_id"].as_str().unwrap();
        let replacement_id = correction["replacement_invoice_id"].as_str().unwrap();
        let connection = store.connect().unwrap();
        let original_after: (String, String, String) = connection
            .query_row(
                "SELECT number,title,status FROM invoices WHERE id=?",
                rusqlite::params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            original_after,
            (original_number, "Facture historique".into(), "payee".into())
        );
        let draft_totals: (i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT total_cents FROM invoices WHERE id=?1),
                   (SELECT total_cents FROM invoices WHERE id=?2)",
                rusqlite::params![credit_id, replacement_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(draft_totals.0 < 0);
        assert_eq!(draft_totals.0.checked_neg(), Some(draft_totals.1));
        drop(connection);

        let dependency_error = store
            .issue_invoice(replacement_id, Some("2026-09-03".into()), None)
            .unwrap_err()
            .to_string();
        assert!(dependency_error.contains("d’abord l’avoir correctif"));
        store
            .issue_invoice(credit_id, Some("2026-09-03".into()), None)
            .unwrap();
        store
            .issue_invoice(replacement_id, Some("2026-09-03".into()), None)
            .unwrap();
        assert!(store
            .create_invoice_correction(CreateInvoiceCorrectionInput {
                original_invoice_id: invoice_id.clone(),
                reason: "Tentative sur une ancienne version".into(),
            })
            .unwrap_err()
            .to_string()
            .contains("facture de remplacement la plus récente"));
        let next_correction = store
            .create_invoice_correction(CreateInvoiceCorrectionInput {
                original_invoice_id: replacement_id.to_owned(),
                reason: "Deuxième correction sur la version récente".into(),
            })
            .unwrap();
        assert!(next_correction["credit_note_id"].as_str().is_some());
        assert!(next_correction["replacement_invoice_id"].as_str().is_some());
        assert!(store
            .update_record(
                "invoices",
                &invoice_id,
                json!({"title":"Réécriture interdite"}),
            )
            .is_err());
        assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
    }

    #[test]
    fn draft_invoice_correction_can_be_abandoned_without_touching_original() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client abandon correction"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture originale conservée",
                        "type":"standard",
                        "service_date_from":"2026-09-01",
                        "service_date_to":"2026-09-01"
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":invoice_id,
                    "description":"Prestation à conserver",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":25_000,
                    "vat_bp":810
                }),
            )
            .unwrap();
        let original = store
            .issue_invoice(&invoice_id, Some("2026-09-02".into()), None)
            .unwrap();
        let original_number = original["number"].as_str().unwrap().to_owned();
        let original_total = original["total_cents"].as_i64().unwrap();
        let correction = store
            .create_invoice_correction(CreateInvoiceCorrectionInput {
                original_invoice_id: invoice_id.clone(),
                reason: "Correction préparée par erreur".into(),
            })
            .unwrap();
        let workflow_id = correction["workflow_id"].as_str().unwrap().to_owned();
        let credit_id = correction["credit_note_id"].as_str().unwrap().to_owned();
        let replacement_id = correction["replacement_invoice_id"]
            .as_str()
            .unwrap()
            .to_owned();
        store
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO invoice_qr_bills(
                   invoice_id,input_json,payload,reference_type,is_qr_iban,
                   character_count,byte_count,frozen_at,created_at,updated_at
                 ) VALUES(?, '{}', 'SPC', 'NON', 0, 3, 3, NULL, ?, ?)",
                rusqlite::params![replacement_id, now_iso(), now_iso()],
            )
            .unwrap();

        let abandoned = store
            .abandon_invoice_correction(AbandonInvoiceCorrectionInput {
                workflow_id: workflow_id.clone(),
            })
            .unwrap();
        assert_eq!(abandoned["abandoned"], true);

        let connection = store.connect().unwrap();
        let deleted_counts: (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM invoice_correction_workflows WHERE id=?1),
                   (SELECT COUNT(*) FROM invoices WHERE id IN (?2,?3)),
                   (SELECT COUNT(*) FROM invoice_items WHERE invoice_id IN (?2,?3)),
                   (SELECT COUNT(*) FROM invoice_qr_bills WHERE invoice_id IN (?2,?3))",
                rusqlite::params![workflow_id, credit_id, replacement_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(deleted_counts, (0, 0, 0, 0));
        let original_after: (String, String, String, i64, i64) = connection
            .query_row(
                "SELECT number,title,status,total_cents,
                        (SELECT COUNT(*) FROM invoice_items WHERE invoice_id=invoices.id)
                   FROM invoices WHERE id=?",
                rusqlite::params![invoice_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            original_after,
            (
                original_number,
                "Facture originale conservée".into(),
                "emise".into(),
                original_total,
                1,
            )
        );
        let audit_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log
                  WHERE action='abandon_correction'
                    AND entity_type='invoice_correction' AND entity_id=?",
                rusqlite::params![workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 1);
        drop(connection);
        assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
    }

    #[test]
    fn invoice_correction_cannot_be_abandoned_after_credit_note_is_issued() {
        let (_temporary, store) = initialized_store();
        let client_id = value_id(
            &store
                .create_record("clients", test_client("Client correction émise"))
                .unwrap(),
        );
        let invoice_id = value_id(
            &store
                .create_record(
                    "invoices",
                    json!({
                        "client_id":client_id,
                        "title":"Facture à corriger",
                        "type":"standard",
                        "service_date_from":"2026-09-01",
                        "service_date_to":"2026-09-01"
                    }),
                )
                .unwrap(),
        );
        store
            .create_record(
                "invoice_items",
                json!({
                    "invoice_id":invoice_id,
                    "description":"Prestation",
                    "quantity":1,
                    "unit":"forfait",
                    "unit_price_cents":10_000,
                    "vat_bp":0
                }),
            )
            .unwrap();
        store
            .issue_invoice(&invoice_id, Some("2026-09-02".into()), None)
            .unwrap();
        let correction = store
            .create_invoice_correction(CreateInvoiceCorrectionInput {
                original_invoice_id: invoice_id,
                reason: "Correction dont l’avoir sera émis".into(),
            })
            .unwrap();
        let workflow_id = correction["workflow_id"].as_str().unwrap().to_owned();
        let credit_id = correction["credit_note_id"].as_str().unwrap().to_owned();
        let replacement_id = correction["replacement_invoice_id"]
            .as_str()
            .unwrap()
            .to_owned();
        store
            .issue_invoice(&credit_id, Some("2026-09-03".into()), None)
            .unwrap();

        let error = store
            .abandon_invoice_correction(AbandonInvoiceCorrectionInput {
                workflow_id: workflow_id.clone(),
            })
            .unwrap_err()
            .to_string();
        assert!(error.contains("ne peut plus être abandonnée"));
        let remaining: (i64, i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM invoice_correction_workflows WHERE id=?1),
                   (SELECT COUNT(*) FROM invoices WHERE id IN (?2,?3)),
                   (SELECT COUNT(*) FROM invoice_items WHERE invoice_id IN (?2,?3))",
                rusqlite::params![workflow_id, credit_id, replacement_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(remaining, (1, 2, 2));
        assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
    }
}
