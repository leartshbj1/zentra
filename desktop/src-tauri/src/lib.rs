mod backup;
mod commands;
mod database;
mod error;
mod models;
mod schema;

use commands::*;
use database::LocalStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;
            let data_dir = resolve_data_dir(app.handle())?;
            let store = LocalStore::initialize(data_dir)?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            complete_onboarding,
            get_workspace,
            create_record,
            update_record,
            delete_record,
            update_settings,
            issue_quote,
            issue_invoice,
            record_payment,
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
        .expect("HelviChantier n'a pas pu démarrer");
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use rusqlite::OptionalExtension;
    use serde_json::json;

    use crate::{database::LocalStore, models::OnboardingInput, schema::BUSINESS_TABLES};

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
            uid_number: None,
            vat_number: None,
            vat_registered: false,
            default_vat_bp: Some(0),
            iban: None,
            bank_name: None,
            currency: "CHF".into(),
            quote_prefix: "D".into(),
            invoice_prefix: "F".into(),
            payment_terms_days: 30,
            quote_validity_days: 30,
            default_hourly_rate_cents: 0,
            logo_path: None,
            extra_settings_json: Some(json!({
                "work": {"roundingMinutes": 15},
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

    #[test]
    fn fresh_database_is_empty_and_requires_onboarding() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        let state = store.app_state("1.0.0").expect("application state");
        assert!(!state.onboarding_completed);

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
        assert!(state.onboarding_completed);

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
    }

    #[test]
    fn backup_restore_round_trip_recovers_local_rows() {
        let (temporary, store) = initialized_store();
        let client = store
            .create_record("clients", json!({"name": "Client à sauvegarder"}))
            .expect("create client");
        let client_id = value_id(&client);
        let backup_path = temporary.path().join("recette.hchantier");
        store
            .create_backup(Some(backup_path.to_string_lossy().into_owned()), "1.0.0")
            .expect("create backup");
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
        let entry = store.stop_timer().expect("stop timer");
        assert_eq!(entry["minutes"], 1);
        assert_eq!(entry["note"], "Temps réellement mesuré");
        assert_eq!(store.get_active_timer().expect("active timer"), json!(null));
    }
}
