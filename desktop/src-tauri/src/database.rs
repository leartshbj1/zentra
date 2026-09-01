use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

#[cfg(test)]
use std::collections::BTreeMap;

use chrono::{DateTime, Days, Local, NaiveDate, Utc};
use rusqlite::{
    params, params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection, OptionalExtension, Row, Transaction, TransactionBehavior,
};
use serde_json::{json, Map, Number, Value};
use uuid::Uuid;

use crate::{
    accounting::{
        ensure_accounting_date_open, post_expense_if_enabled, post_invoice_if_enabled,
        post_payment_if_enabled,
    },
    audit::{append_audit, verify_audit_chain},
    error::{AppError, AppResult},
    installation::load_or_create,
    models::{
        AppStateInfo, CompleteOnboardingResult, ConvertQuoteInput, DeleteResult, OnboardingInput,
        OnboardingIssue, OnboardingValidation, RecordPaymentInput, SaveDocumentWithItemsInput,
        TimerInput,
    },
    noga::validate_activity_profile,
    payroll::{
        explicit_settings_rate_issues, import_explicit_settings_rates, take_explicit_settings_rates,
    },
    reminders::cancel_settled_reminders,
    schema::{
        MIGRATION_V10_SQL, MIGRATION_V11_SQL, MIGRATION_V12_SQL, MIGRATION_V13_SQL,
        MIGRATION_V14_SQL, MIGRATION_V15_SQL, MIGRATION_V16_SQL, MIGRATION_V17_SQL,
        MIGRATION_V18_SQL, MIGRATION_V19_FINALIZE_SQL, MIGRATION_V19_SQL, MIGRATION_V2_SQL,
        MIGRATION_V3_SQL, MIGRATION_V4_SQL, MIGRATION_V5_SQL, MIGRATION_V6_SQL, MIGRATION_V7_SQL,
        MIGRATION_V8_SQL, MIGRATION_V9_SQL, SCHEMA_SQL, SCHEMA_VERSION,
    },
    swiss_qr::normalize_and_validate_iban,
};

#[cfg(test)]
use crate::schema::BUSINESS_TABLES;

#[derive(Debug, Clone)]
pub struct LocalStore {
    pub(crate) data_dir: PathBuf,
    pub(crate) database_path: PathBuf,
    pub(crate) attachments_dir: PathBuf,
    pub(crate) backups_dir: PathBuf,
    pub(crate) exports_dir: PathBuf,
    pub(crate) installation_id: String,
    operation_lock: Arc<Mutex<()>>,
}

type ActivityStateRow = (
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

type SettingsValidationRow = (
    i64,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

#[derive(Debug)]
struct PreparedOnboarding {
    input: OnboardingInput,
    company_name: String,
    currency: String,
    noga_section: String,
    noga_division: String,
    activity_description: String,
    noga_detailed_code: Option<String>,
    quote_prefix: String,
    invoice_prefix: String,
    credit_note_prefix: String,
    quote_start_number: i64,
    invoice_start_number: i64,
    credit_note_start_number: i64,
    default_vat_bp: i64,
    iban: String,
    settings_rates_to_import: Option<Value>,
    extra_settings_json: String,
}

fn migrate_v6(transaction: &Transaction<'_>) -> AppResult<()> {
    for (table, column, definition) in [
        (
            "payslip_contributions",
            "liability_account_id",
            "liability_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT",
        ),
        (
            "payslip_contributions",
            "expense_account_id",
            "expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT",
        ),
        ("payslips", "payment_reference", "payment_reference TEXT"),
        (
            "payslips",
            "payment_journal_entry_id",
            "payment_journal_entry_id TEXT REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT",
        ),
    ] {
        let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        if !columns.contains(column) {
            transaction.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {definition};"))?;
        }
    }
    transaction.execute_batch(MIGRATION_V6_SQL)?;
    Ok(())
}

fn migrate_v7(transaction: &Transaction<'_>) -> AppResult<()> {
    let mut statement = transaction.prepare("PRAGMA table_info(employees)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    for (column, definition) in [
        ("reference_age_date", "reference_age_date TEXT"),
        (
            "avs_allowance_waived",
            "avs_allowance_waived INTEGER CHECK (avs_allowance_waived IS NULL OR avs_allowance_waived IN (0, 1))",
        ),
    ] {
        if !columns.contains(column) {
            transaction.execute_batch(&format!(
                "ALTER TABLE employees ADD COLUMN {definition};"
            ))?;
        }
    }
    transaction.execute_batch(MIGRATION_V7_SQL)?;
    Ok(())
}

fn migrate_v8(transaction: &Transaction<'_>) -> AppResult<()> {
    let mut statement = transaction.prepare("PRAGMA table_info(payslip_items)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    for (column, definition) in [
        (
            "posting_account_id",
            "posting_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT",
        ),
        (
            "expense_account_id",
            "expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT",
        ),
    ] {
        if !columns.contains(column) {
            transaction.execute_batch(&format!(
                "ALTER TABLE payslip_items ADD COLUMN {definition};"
            ))?;
        }
    }
    transaction.execute_batch(MIGRATION_V8_SQL)?;
    Ok(())
}

fn migrate_v9(transaction: &Transaction<'_>) -> AppResult<()> {
    let mut statement = transaction.prepare("PRAGMA table_info(employees)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    for (column, definition) in [
        (
            "contractual_weekly_minutes",
            "contractual_weekly_minutes INTEGER CHECK (contractual_weekly_minutes IS NULL OR contractual_weekly_minutes BETWEEN 0 AND 10080)",
        ),
        (
            "ac_opening_year",
            "ac_opening_year INTEGER CHECK (ac_opening_year IS NULL OR ac_opening_year BETWEEN 1900 AND 9999)",
        ),
        (
            "ac_opening_basis_cents",
            "ac_opening_basis_cents INTEGER CHECK (ac_opening_basis_cents IS NULL OR ac_opening_basis_cents >= 0)",
        ),
    ] {
        if !columns.contains(column) {
            transaction.execute_batch(&format!(
                "ALTER TABLE employees ADD COLUMN {definition};"
            ))?;
        }
    }
    transaction.execute_batch(MIGRATION_V9_SQL)?;
    Ok(())
}

fn migrate_v10(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V10_SQL)?;
    for table in ["quote_items", "invoice_items"] {
        let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        drop(statement);
        if !columns.contains("catalog_item_id") {
            transaction.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN catalog_item_id TEXT REFERENCES catalog_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT;"
            ))?;
        }
    }
    transaction.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_quote_items_catalog ON quote_items(catalog_item_id) WHERE catalog_item_id IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_invoice_items_catalog ON invoice_items(catalog_item_id) WHERE catalog_item_id IS NOT NULL;",
    )?;
    Ok(())
}

fn migrate_v11(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V11_SQL)?;
    let mut statement = transaction.prepare("PRAGMA table_info(expenses)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    for (column, definition) in [
        (
            "supplier_id",
            "supplier_id TEXT REFERENCES suppliers(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        ),
        ("due_date", "due_date TEXT"),
        (
            "payment_status",
            "payment_status TEXT NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('pending', 'paid'))",
        ),
        ("paid_at", "paid_at TEXT"),
    ] {
        if !columns.contains(column) {
            transaction.execute_batch(&format!(
                "ALTER TABLE expenses ADD COLUMN {definition};"
            ))?;
        }
    }
    transaction.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_expenses_supplier_date ON expenses(supplier_id, date DESC) WHERE supplier_id IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_expenses_payment_due ON expenses(payment_status, due_date) WHERE payment_status = 'pending';
         CREATE TRIGGER IF NOT EXISTS expenses_payment_state_insert_guard
           BEFORE INSERT ON expenses
           WHEN NEW.payment_status='pending' AND (NEW.due_date IS NULL OR TRIM(NEW.due_date)='' OR NEW.paid_at IS NOT NULL)
           BEGIN SELECT RAISE(ABORT,'pending expense requires a due date and no payment date'); END;
         CREATE TRIGGER IF NOT EXISTS expenses_payment_state_update_guard
           BEFORE UPDATE OF payment_status,paid_at,due_date ON expenses
           WHEN NEW.payment_status='pending' AND (NEW.due_date IS NULL OR TRIM(NEW.due_date)='' OR NEW.paid_at IS NOT NULL)
           BEGIN SELECT RAISE(ABORT,'pending expense requires a due date and no payment date'); END;",
    )?;
    Ok(())
}

fn migrate_v12(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V12_SQL)?;
    Ok(())
}

fn migrate_v13(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V13_SQL)?;
    Ok(())
}

fn migrate_v14(transaction: &Transaction<'_>) -> AppResult<()> {
    let mut statement = transaction.prepare("PRAGMA table_info(accounting_settings)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    if !columns.contains("supplier_payable_account_id") {
        transaction.execute_batch(
            "ALTER TABLE accounting_settings ADD COLUMN supplier_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT;",
        )?;
    }
    transaction.execute_batch(MIGRATION_V14_SQL)?;
    Ok(())
}

fn migrate_v15(transaction: &Transaction<'_>) -> AppResult<()> {
    let mut statement = transaction.prepare("PRAGMA table_info(bank_movements)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    if !columns.contains("counterparty_iban") {
        transaction
            .execute_batch("ALTER TABLE bank_movements ADD COLUMN counterparty_iban TEXT;")?;
    }
    transaction.execute_batch(MIGRATION_V15_SQL)?;
    Ok(())
}

fn migrate_v16(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V16_SQL)?;
    Ok(())
}

fn migrate_v17(transaction: &Transaction<'_>) -> AppResult<()> {
    let mut statement = transaction.prepare("PRAGMA table_info(employees)")?;
    let employee_columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    if !employee_columns.contains("country") {
        transaction.execute_batch(
            "ALTER TABLE employees ADD COLUMN country TEXT NOT NULL DEFAULT 'CH';",
        )?;
    }

    let mut statement = transaction.prepare("PRAGMA table_info(clients)")?;
    let client_columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    if !client_columns.contains("archived_at") {
        transaction.execute_batch("ALTER TABLE clients ADD COLUMN archived_at TEXT;")?;
    }

    transaction.execute_batch(MIGRATION_V17_SQL)?;
    Ok(())
}

fn migrate_v18(transaction: &Transaction<'_>) -> AppResult<()> {
    let mut statement = transaction.prepare("PRAGMA table_info(license_state)")?;
    let license_columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    if !license_columns.contains("clock_anchor_version") {
        transaction.execute_batch(
            "ALTER TABLE license_state ADD COLUMN clock_anchor_version INTEGER NOT NULL DEFAULT 0 CHECK (clock_anchor_version IN (0,1));",
        )?;
    }

    let invalid_kind: Option<(String, String)> = transaction
        .query_row(
            "SELECT id,kind FROM catalog_items
             WHERE track_stock=1 AND kind<>'product' ORDER BY id LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((catalog_item_id, kind)) = invalid_kind {
        return Err(AppError::Validation(format!(
            "La migration du stock est impossible : l'article {catalog_item_id} est de type {kind}, alors que seuls les produits peuvent être suivis. Désactivez son suivi avant la mise à niveau."
        )));
    }
    let oversized: Option<(String, i64)> = transaction
        .query_row(
            "SELECT id,stock_quantity_milli FROM catalog_items
             WHERE track_stock=1 AND stock_quantity_milli>9000000000000000
             ORDER BY stock_quantity_milli DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((catalog_item_id, quantity)) = oversized {
        return Err(AppError::Validation(format!(
            "La migration du stock est impossible : l'article {catalog_item_id} possède {quantity} millièmes, au-delà de la limite sûre de 9000000000000000. Corrigez cette donnée avant la mise à niveau."
        )));
    }
    transaction.execute_batch(MIGRATION_V18_SQL)?;
    Ok(())
}

fn migrate_v19(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V19_SQL)?;
    let mut statement = transaction.prepare("PRAGMA table_info(time_entries)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    if !columns.contains("task_id") {
        transaction.execute_batch(
            "ALTER TABLE time_entries ADD COLUMN task_id TEXT REFERENCES project_tasks(id) ON UPDATE CASCADE ON DELETE SET NULL;",
        )?;
    }
    let mut statement = transaction.prepare("PRAGMA table_info(active_timers)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    if !columns.contains("task_id") {
        transaction.execute_batch(
            "ALTER TABLE active_timers ADD COLUMN task_id TEXT REFERENCES project_tasks(id) ON UPDATE CASCADE ON DELETE SET NULL;",
        )?;
    }
    transaction.execute_batch(MIGRATION_V19_FINALIZE_SQL)?;
    Ok(())
}

fn onboarding_issue(step: u8, field: &str, label: &str, message: String) -> OnboardingIssue {
    OnboardingIssue {
        step,
        field: field.into(),
        label: label.into(),
        message,
    }
}

fn validation_message(error: AppError) -> String {
    match error {
        AppError::Validation(message) => message,
        other => other.to_string(),
    }
}

fn prepare_onboarding(input: OnboardingInput) -> Result<PreparedOnboarding, Vec<OnboardingIssue>> {
    let mut issues = Vec::new();
    let company_name = match required_text(&input.company_name, "company_name", 200) {
        Ok(value) => value,
        Err(error) => {
            issues.push(onboarding_issue(
                1,
                "organization.legalName",
                "La raison sociale",
                validation_message(error),
            ));
            input.company_name.trim().to_owned()
        }
    };
    let currency = match normalized_code(&input.currency, "currency", 3, "CHF") {
        Ok(value) => value,
        Err(error) => {
            issues.push(onboarding_issue(
                2,
                "billing.currency",
                "La devise",
                validation_message(error),
            ));
            "CHF".into()
        }
    };
    let noga_section = input.noga_section.trim().to_uppercase();
    let noga_division = input.noga_division.trim().to_owned();
    let activity_description = input.activity_description.trim().to_owned();
    let noga_detailed_code = input
        .noga_detailed_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if let Err(error) = validate_activity_profile(
        &noga_section,
        &noga_division,
        &activity_description,
        noga_detailed_code.as_deref(),
    ) {
        let message = validation_message(error);
        let (field, label) = if message.contains("noga_section") {
            ("business.nogaSection", "La section NOGA")
        } else if message.contains("noga_division") || message.contains("division NOGA") {
            ("business.nogaDivision", "La division NOGA")
        } else if message.contains("activity_description") {
            ("business.activityDescription", "L’activité précise")
        } else {
            ("business.nogaDetailedCode", "Le code NOGA détaillé")
        };
        issues.push(onboarding_issue(1, field, label, message));
    }
    let quote_prefix = match normalized_prefix(&input.quote_prefix, "D") {
        Ok(value) => value,
        Err(error) => {
            issues.push(onboarding_issue(
                2,
                "billing.quotePrefix",
                "Le préfixe des devis",
                validation_message(error),
            ));
            "D".into()
        }
    };
    let invoice_prefix = match normalized_prefix(&input.invoice_prefix, "F") {
        Ok(value) => value,
        Err(error) => {
            issues.push(onboarding_issue(
                2,
                "billing.invoicePrefix",
                "Le préfixe des factures",
                validation_message(error),
            ));
            "F".into()
        }
    };
    let mut extra_value = match parsed_json_object(input.extra_settings_json.clone()) {
        Ok(value) => value,
        Err(error) => {
            issues.push(onboarding_issue(
                5,
                "backup.folder",
                "La configuration locale",
                validation_message(error),
            ));
            json!({})
        }
    };
    let billing = extra_value
        .get("billing")
        .and_then(Value::as_object)
        .cloned();
    let credit_note_prefix_raw = input
        .credit_note_prefix
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            billing
                .as_ref()
                .and_then(|value| value.get("creditNotePrefix"))
                .and_then(Value::as_str)
        })
        .unwrap_or("A");
    let credit_note_prefix = match normalized_prefix(credit_note_prefix_raw, "A") {
        Ok(value) => value,
        Err(error) => {
            issues.push(onboarding_issue(
                2,
                "billing.creditNotePrefix",
                "Le préfixe des avoirs",
                validation_message(error),
            ));
            "A".into()
        }
    };
    let start_number = |explicit, key, field, label, issues: &mut Vec<OnboardingIssue>| {
        match explicit_start_number(explicit, billing.as_ref(), key) {
            Ok(value) => value,
            Err(error) => {
                issues.push(onboarding_issue(2, field, label, validation_message(error)));
                1
            }
        }
    };
    let quote_start_number = start_number(
        input.quote_start_number,
        "nextQuoteNumber",
        "billing.nextQuoteNumber",
        "Le prochain numéro de devis",
        &mut issues,
    );
    let invoice_start_number = start_number(
        input.invoice_start_number,
        "nextInvoiceNumber",
        "billing.nextInvoiceNumber",
        "Le prochain numéro de facture",
        &mut issues,
    );
    let credit_note_start_number = start_number(
        input.credit_note_start_number,
        "nextCreditNoteNumber",
        "billing.nextCreditNoteNumber",
        "Le prochain numéro d’avoir",
        &mut issues,
    );
    let default_vat_bp = match (input.vat_registered, input.default_vat_bp) {
        (true, Some(value)) if (1..=10_000).contains(&value) => value,
        (true, _) => {
            issues.push(onboarding_issue(
                2,
                "billing.vatRatesBp",
                "Les taux de TVA",
                "Un taux de TVA explicite est obligatoire pour une entreprise assujettie.".into(),
            ));
            0
        }
        (false, None | Some(0)) => 0,
        (false, Some(_)) => {
            issues.push(onboarding_issue(
                2,
                "billing.vatRatesBp",
                "Les taux de TVA",
                "Le taux de TVA doit être 0 pour une entreprise non assujettie.".into(),
            ));
            0
        }
    };
    if let Err(error) = validate_vat_identifier(
        input.vat_registered,
        input.uid_number.as_deref(),
        input.vat_number.as_deref(),
    ) {
        issues.push(onboarding_issue(
            1,
            "organization.vatIdentifier",
            "L’identifiant TVA",
            validation_message(error),
        ));
    }
    let iban = match normalize_and_validate_iban(input.iban.as_deref().unwrap_or("")) {
        Ok(value) => value,
        Err(error) => {
            issues.push(onboarding_issue(
                2,
                "billing.iban",
                "L’IBAN",
                validation_message(error),
            ));
            input
                .iban
                .as_deref()
                .unwrap_or("")
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>()
                .to_uppercase()
        }
    };
    if !(1..=365).contains(&input.payment_terms_days) {
        issues.push(onboarding_issue(
            2,
            "billing.paymentTermsDays",
            "Le délai de paiement",
            "Le délai de paiement doit être compris entre 1 et 365 jours.".into(),
        ));
    }
    if !(1..=365).contains(&input.quote_validity_days) {
        issues.push(onboarding_issue(
            2,
            "billing.quoteValidityDays",
            "La validité des devis",
            "La validité des devis doit être comprise entre 1 et 365 jours.".into(),
        ));
    }
    if input.default_hourly_rate_cents < 0 {
        issues.push(onboarding_issue(
            3,
            "work.defaultHourlyRateCents",
            "Le coût horaire par défaut",
            "default_hourly_rate_cents ne peut pas être négatif.".into(),
        ));
    }
    let settings_rates_to_import = take_explicit_settings_rates(&mut extra_value);
    if let Some(rates) = settings_rates_to_import.as_ref() {
        issues.extend(explicit_settings_rate_issues(rates));
    }
    let extra_settings_json = match serde_json::to_string(&extra_value) {
        Ok(value) => value,
        Err(error) => {
            issues.push(onboarding_issue(
                5,
                "backup.folder",
                "La configuration locale",
                error.to_string(),
            ));
            "{}".into()
        }
    };
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(PreparedOnboarding {
        input,
        company_name,
        currency,
        noga_section,
        noga_division,
        activity_description,
        noga_detailed_code,
        quote_prefix,
        invoice_prefix,
        credit_note_prefix,
        quote_start_number,
        invoice_start_number,
        credit_note_start_number,
        default_vat_bp,
        iban,
        settings_rates_to_import,
        extra_settings_json,
    })
}

impl LocalStore {
    pub fn initialize(data_dir: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&data_dir)?;
        let attachments_dir = data_dir.join("attachments");
        let backups_dir = data_dir.join("backups");
        let exports_dir = data_dir.join("exports");
        fs::create_dir_all(&attachments_dir)?;
        fs::create_dir_all(&backups_dir)?;
        fs::create_dir_all(&exports_dir)?;

        let installation_id = load_or_create(&data_dir)?;
        let store = Self {
            database_path: data_dir.join("helvichantier.sqlite3"),
            data_dir,
            attachments_dir,
            backups_dir,
            exports_dir,
            installation_id,
            operation_lock: Arc::new(Mutex::new(())),
        };
        store.migrate()?;
        Ok(store)
    }

    pub fn lock(&self) -> AppResult<MutexGuard<'_, ()>> {
        self.operation_lock.lock().map_err(|_| {
            AppError::Validation("Le verrou de la base locale est indisponible.".into())
        })
    }

    pub fn connect(&self) -> AppResult<Connection> {
        let connection = Connection::open(&self.database_path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(connection)
    }

    pub fn migrate(&self) -> AppResult<()> {
        let mut connection = self.connect()?;
        let current: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if current > SCHEMA_VERSION {
            return Err(AppError::Validation(format!(
                "La base locale utilise une version plus récente ({current}) que cette application ({SCHEMA_VERSION})."
            )));
        }
        if current == SCHEMA_VERSION {
            return Ok(());
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        match current {
            0 => transaction.execute_batch(SCHEMA_SQL)?,
            1 => {
                transaction.execute_batch(MIGRATION_V2_SQL)?;
                transaction.execute_batch(MIGRATION_V3_SQL)?;
                transaction.execute_batch(MIGRATION_V4_SQL)?;
                transaction.execute_batch(MIGRATION_V5_SQL)?;
                migrate_v6(&transaction)?;
                migrate_v7(&transaction)?;
                migrate_v8(&transaction)?;
                migrate_v9(&transaction)?;
                migrate_v10(&transaction)?;
                migrate_v11(&transaction)?;
                migrate_v12(&transaction)?;
            }
            2 => {
                transaction.execute_batch(MIGRATION_V3_SQL)?;
                transaction.execute_batch(MIGRATION_V4_SQL)?;
                transaction.execute_batch(MIGRATION_V5_SQL)?;
                migrate_v6(&transaction)?;
                migrate_v7(&transaction)?;
                migrate_v8(&transaction)?;
                migrate_v9(&transaction)?;
                migrate_v10(&transaction)?;
                migrate_v11(&transaction)?;
                migrate_v12(&transaction)?;
            }
            3 => {
                transaction.execute_batch(MIGRATION_V4_SQL)?;
                transaction.execute_batch(MIGRATION_V5_SQL)?;
                migrate_v6(&transaction)?;
                migrate_v7(&transaction)?;
                migrate_v8(&transaction)?;
                migrate_v9(&transaction)?;
                migrate_v10(&transaction)?;
                migrate_v11(&transaction)?;
                migrate_v12(&transaction)?;
            }
            4 => {
                transaction.execute_batch(MIGRATION_V5_SQL)?;
                migrate_v6(&transaction)?;
                migrate_v7(&transaction)?;
                migrate_v8(&transaction)?;
                migrate_v9(&transaction)?;
                migrate_v10(&transaction)?;
                migrate_v11(&transaction)?;
                migrate_v12(&transaction)?;
            }
            5 => {
                migrate_v6(&transaction)?;
                migrate_v7(&transaction)?;
                migrate_v8(&transaction)?;
                migrate_v9(&transaction)?;
                migrate_v10(&transaction)?;
                migrate_v11(&transaction)?;
                migrate_v12(&transaction)?;
            }
            6 => {
                migrate_v7(&transaction)?;
                migrate_v8(&transaction)?;
                migrate_v9(&transaction)?;
                migrate_v10(&transaction)?;
                migrate_v11(&transaction)?;
                migrate_v12(&transaction)?;
            }
            7 => {
                migrate_v8(&transaction)?;
                migrate_v9(&transaction)?;
                migrate_v10(&transaction)?;
                migrate_v11(&transaction)?;
                migrate_v12(&transaction)?;
            }
            8 => {
                migrate_v9(&transaction)?;
                migrate_v10(&transaction)?;
                migrate_v11(&transaction)?;
                migrate_v12(&transaction)?;
            }
            9 => {
                migrate_v10(&transaction)?;
                migrate_v11(&transaction)?;
                migrate_v12(&transaction)?;
            }
            10 => {
                migrate_v11(&transaction)?;
                migrate_v12(&transaction)?;
            }
            11 => migrate_v12(&transaction)?,
            12..=18 => {}
            _ => {
                return Err(AppError::Validation(format!(
                    "Migration locale non prise en charge depuis la version {current}."
                )))
            }
        }
        if current != 0 && current < 13 {
            migrate_v13(&transaction)?;
        }
        if current != 0 {
            migrate_v14(&transaction)?;
            migrate_v15(&transaction)?;
            migrate_v16(&transaction)?;
            migrate_v17(&transaction)?;
            migrate_v18(&transaction)?;
            migrate_v19(&transaction)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn app_state(&self, app_version: &str) -> AppResult<AppStateInfo> {
        let connection = self.connect()?;
        let settings: Option<ActivityStateRow> = connection
            .query_row(
                "SELECT onboarding_completed,noga_section,noga_division,activity_description,noga_detailed_code FROM settings WHERE id=1",
                [],
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
            .optional()?;
        let onboarding_completed = settings.as_ref().is_some_and(|row| row.0 == 1);
        let activity_profile_required = match settings.as_ref() {
            None => true,
            Some(row) => validate_activity_profile(
                row.1.as_deref().unwrap_or(""),
                row.2.as_deref().unwrap_or(""),
                row.3.as_deref().unwrap_or(""),
                row.4.as_deref(),
            )
            .is_err(),
        };
        Ok(AppStateInfo {
            onboarding_completed,
            activity_profile_required,
            data_dir: self.data_dir.to_string_lossy().into_owned(),
            database_path: self.database_path.to_string_lossy().into_owned(),
            app_version: app_version.to_owned(),
        })
    }

    pub fn require_onboarding(&self, connection: &Connection) -> AppResult<()> {
        let completed = connection
            .query_row(
                "SELECT onboarding_completed FROM settings WHERE id = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0);
        if completed != 1 {
            return Err(AppError::OnboardingRequired);
        }
        Ok(())
    }

    pub fn validate_onboarding(&self, input: OnboardingInput) -> OnboardingValidation {
        match prepare_onboarding(input) {
            Ok(_) => OnboardingValidation {
                valid: true,
                issues: Vec::new(),
            },
            Err(issues) => OnboardingValidation {
                valid: false,
                issues,
            },
        }
    }

    pub fn complete_onboarding(
        &self,
        input: OnboardingInput,
        app_version: &str,
    ) -> AppResult<CompleteOnboardingResult> {
        let prepared = prepare_onboarding(input).map_err(|issues| {
            AppError::Validation(
                issues
                    .into_iter()
                    .map(|issue| issue.message)
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        })?;
        let PreparedOnboarding {
            input,
            company_name,
            currency,
            noga_section,
            noga_division,
            activity_description,
            noga_detailed_code,
            quote_prefix,
            invoice_prefix,
            credit_note_prefix,
            quote_start_number,
            invoice_start_number,
            credit_note_start_number,
            default_vat_bp,
            iban,
            settings_rates_to_import,
            extra_settings_json,
        } = prepared;
        let now = now_iso();
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            r#"INSERT INTO settings (
                id,onboarding_completed,company_name,legal_form,owner_name,email,phone,
                address_line1,address_line2,postal_code,city,canton,country,noga_section,
                noga_division,activity_description,noga_detailed_code,uid_number,vat_number,
                vat_registered,default_vat_bp,iban,bank_name,currency,
                quote_prefix,invoice_prefix,credit_note_prefix,quote_start_number,
                invoice_start_number,credit_note_start_number,payment_terms_days,quote_validity_days,
                default_hourly_rate_cents,logo_path,extra_settings_json,created_at,updated_at
              ) VALUES (
                1,1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,
                ?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,
                ?32,?33,?34,?35
              )
              ON CONFLICT(id) DO UPDATE SET
                onboarding_completed=1,company_name=excluded.company_name,
                legal_form=excluded.legal_form,owner_name=excluded.owner_name,
                email=excluded.email,phone=excluded.phone,address_line1=excluded.address_line1,
                address_line2=excluded.address_line2,postal_code=excluded.postal_code,
                city=excluded.city,canton=excluded.canton,country=excluded.country,
                noga_section=excluded.noga_section,noga_division=excluded.noga_division,
                activity_description=excluded.activity_description,
                noga_detailed_code=excluded.noga_detailed_code,
                uid_number=excluded.uid_number,vat_number=excluded.vat_number,
                vat_registered=excluded.vat_registered,default_vat_bp=excluded.default_vat_bp,
                iban=excluded.iban,bank_name=excluded.bank_name,currency=excluded.currency,
                quote_prefix=excluded.quote_prefix,invoice_prefix=excluded.invoice_prefix,
                credit_note_prefix=excluded.credit_note_prefix,
                quote_start_number=excluded.quote_start_number,
                invoice_start_number=excluded.invoice_start_number,
                credit_note_start_number=excluded.credit_note_start_number,
                payment_terms_days=excluded.payment_terms_days,
                quote_validity_days=excluded.quote_validity_days,
                default_hourly_rate_cents=excluded.default_hourly_rate_cents,
                logo_path=excluded.logo_path,extra_settings_json=excluded.extra_settings_json,
                updated_at=excluded.updated_at"#,
            params![
                company_name,
                clean_optional(input.legal_form, 80),
                clean_optional(input.owner_name, 200),
                clean_optional(input.email, 254),
                clean_optional(input.phone, 80),
                clean_optional(input.address_line1, 300),
                clean_optional(input.address_line2, 300),
                clean_optional(input.postal_code, 24),
                clean_optional(input.city, 120),
                clean_optional(input.canton, 80),
                clean_optional(input.country, 2).unwrap_or_else(|| "CH".into()),
                noga_section,
                noga_division,
                activity_description,
                noga_detailed_code,
                clean_optional(input.uid_number, 80),
                clean_optional(input.vat_number, 80),
                bool_to_i64(input.vat_registered),
                default_vat_bp,
                iban,
                clean_optional(input.bank_name, 160),
                currency,
                quote_prefix,
                invoice_prefix,
                credit_note_prefix,
                quote_start_number,
                invoice_start_number,
                credit_note_start_number,
                input.payment_terms_days,
                input.quote_validity_days,
                input.default_hourly_rate_cents,
                clean_optional(input.logo_path, 2000),
                extra_settings_json,
                now,
                now,
            ],
        )?;
        if let Some(rates) = settings_rates_to_import.as_ref() {
            import_explicit_settings_rates(&transaction, rates)?;
        }
        let workspace = self.workspace_from_connection(&transaction)?;
        let app_state = AppStateInfo {
            onboarding_completed: true,
            activity_profile_required: false,
            data_dir: self.data_dir.to_string_lossy().into_owned(),
            database_path: self.database_path.to_string_lossy().into_owned(),
            app_version: app_version.to_owned(),
        };
        transaction.commit()?;
        Ok(CompleteOnboardingResult {
            app_state,
            workspace,
        })
    }

    pub fn get_workspace(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.workspace_from_connection(&connection)
    }

    fn workspace_from_connection(&self, connection: &Connection) -> AppResult<Value> {
        self.require_onboarding(connection)?;
        let settings = query_optional(connection, "SELECT * FROM settings WHERE id = 1", [])?;
        let clients = query_all(
            connection,
            "SELECT * FROM clients ORDER BY name, created_at",
            [],
        )?;
        let catalog_items = query_all(
            connection,
            "SELECT item.*,
                    CASE
                      WHEN item.track_stock=0 THEN 'not_tracked'
                      WHEN item.stock_quantity_milli=0 THEN 'out_of_stock'
                      WHEN item.stock_quantity_milli<=item.reorder_level_milli THEN 'low_stock'
                      ELSE 'in_stock'
                    END AS stock_status
             FROM catalog_items item
             ORDER BY CASE WHEN item.archived_at IS NULL THEN 0 ELSE 1 END,
                      item.name COLLATE NOCASE,item.created_at",
            [],
        )?;
        let suppliers = query_all(
            connection,
            "SELECT * FROM suppliers ORDER BY CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END, name COLLATE NOCASE, created_at",
            [],
        )?;
        let projects = query_all(
            connection,
            "SELECT * FROM projects ORDER BY CASE status WHEN 'en_cours' THEN 0 WHEN 'planifie' THEN 1 ELSE 2 END, COALESCE(planned_start_date, created_at) DESC",
            [],
        )?;
        let project_milestones = query_all(
            connection,
            "SELECT * FROM project_milestones ORDER BY project_id,sort_order,COALESCE(due_date,'9999-12-31'),created_at",
            [],
        )?;
        let project_tasks = query_all(
            connection,
            "SELECT * FROM project_tasks ORDER BY project_id,sort_order,COALESCE(due_date,'9999-12-31'),created_at",
            [],
        )?;
        let quotes = query_all(
            connection,
            "SELECT * FROM quotes ORDER BY COALESCE(issue_date, created_at) DESC, created_at DESC",
            [],
        )?;
        let quote_items = query_all(
            connection,
            "SELECT * FROM quote_items ORDER BY quote_id, position, created_at",
            [],
        )?;
        let invoices = query_all(
            connection,
            "SELECT * FROM invoices ORDER BY COALESCE(issue_date, created_at) DESC, created_at DESC",
            [],
        )?;
        let invoice_items = query_all(
            connection,
            "SELECT * FROM invoice_items ORDER BY invoice_id, position, created_at",
            [],
        )?;
        let stock_movements = query_all(
            connection,
            "SELECT sequence,id,source_key,request_id,catalog_item_id,movement_type,
                    quantity_delta_milli,balance_after_milli,reason,reference,movement_date,
                    source_type,invoice_id,invoice_item_id,created_at
             FROM stock_movements ORDER BY sequence DESC",
            [],
        )?;
        let invoice_qr_bills = query_all(
            connection,
            "SELECT * FROM invoice_qr_bills ORDER BY created_at,invoice_id",
            [],
        )?;
        let employees = query_all(
            connection,
            "SELECT * FROM employees ORDER BY name, created_at",
            [],
        )?;
        let time_entries = query_all(
            connection,
            "SELECT entry.*,
                    CASE
                      WHEN billed.id IS NULL THEN 'unbilled'
                      WHEN invoice.number IS NULL THEN 'reserved'
                      ELSE 'billed'
                    END AS billing_status,
                    billed.batch_id AS billing_batch_id,
                    batch.invoice_id AS billing_invoice_id,
                    invoice.number AS billing_invoice_number
             FROM time_entries entry
             LEFT JOIN time_billing_entries billed ON billed.time_entry_id=entry.id
             LEFT JOIN time_billing_batches batch ON batch.id=billed.batch_id
             LEFT JOIN invoices invoice ON invoice.id=batch.invoice_id
             ORDER BY entry.date DESC, entry.created_at DESC",
            [],
        )?;
        let time_billing_batches = query_all(
            connection,
            "SELECT * FROM time_billing_batches ORDER BY created_at DESC",
            [],
        )?;
        let time_billing_entries = query_all(
            connection,
            "SELECT * FROM time_billing_entries ORDER BY batch_id,entry_date_snapshot,time_entry_id",
            [],
        )?;
        let expenses = query_all(
            connection,
            "SELECT * FROM expenses ORDER BY date DESC, created_at DESC",
            [],
        )?;
        let supplier_invoices = query_all(
            connection,
            "SELECT * FROM supplier_invoices ORDER BY document_date DESC, created_at DESC",
            [],
        )?;
        let supplier_invoice_items = query_all(
            connection,
            "SELECT * FROM supplier_invoice_items ORDER BY supplier_invoice_id,position,rowid",
            [],
        )?;
        let supplier_payments = query_all(
            connection,
            "SELECT * FROM supplier_payments ORDER BY date DESC,created_at DESC",
            [],
        )?;
        let payslips = query_all(
            connection,
            "SELECT * FROM payslips ORDER BY period DESC, created_at DESC",
            [],
        )?;
        let payslip_items = query_all(
            connection,
            "SELECT * FROM payslip_items ORDER BY payslip_id, position, created_at",
            [],
        )?;
        let payments = query_all(
            connection,
            "SELECT * FROM payments ORDER BY date DESC, created_at DESC",
            [],
        )?;
        let bank_imports = query_all(
            connection,
            "SELECT * FROM bank_imports ORDER BY created_at DESC,rowid DESC",
            [],
        )?;
        let bank_movements = query_all(
            connection,
            "SELECT * FROM bank_movements ORDER BY COALESCE(booking_date,value_date,created_at) DESC,entry_sequence",
            [],
        )?;
        let bank_reconciliations = query_all(
            connection,
            "SELECT * FROM bank_reconciliations ORDER BY confirmed_at DESC,rowid DESC",
            [],
        )?;
        let bank_supplier_reconciliations = query_all(
            connection,
            "SELECT * FROM bank_supplier_reconciliations ORDER BY confirmed_at DESC,rowid DESC",
            [],
        )?;
        let bank_movement_keys = query_all(
            connection,
            "SELECT * FROM bank_movement_keys ORDER BY movement_id,reference_level",
            [],
        )?;
        let bank_account_links = query_all(
            connection,
            "SELECT * FROM bank_account_links ORDER BY account_id",
            [],
        )?;
        let attachments = query_all(
            connection,
            "SELECT * FROM attachments ORDER BY created_at DESC",
            [],
        )?;
        let active_timer =
            query_optional(connection, "SELECT * FROM active_timers WHERE id = 1", [])?;
        let accounts = query_all(connection, "SELECT * FROM accounts ORDER BY code", [])?;
        let accounting_settings = query_optional(
            connection,
            "SELECT * FROM accounting_settings WHERE id=1",
            [],
        )?;
        let accounting_periods = query_all(
            connection,
            "SELECT * FROM accounting_periods ORDER BY date_from",
            [],
        )?;
        let journal_entries = query_all(
            connection,
            "SELECT * FROM journal_entries ORDER BY entry_date,number",
            [],
        )?;
        let journal_lines = query_all(
            connection,
            "SELECT * FROM journal_lines ORDER BY journal_entry_id,rowid",
            [],
        )?;
        let reminder_settings =
            query_optional(connection, "SELECT * FROM reminder_settings WHERE id=1", [])?;
        let reminder_templates = query_all(
            connection,
            "SELECT * FROM reminder_templates ORDER BY level",
            [],
        )?;
        let reminders = query_all(
            connection,
            "SELECT * FROM reminders ORDER BY scheduled_date,level",
            [],
        )?;
        let reminder_history = query_all(
            connection,
            "SELECT * FROM reminder_history ORDER BY occurred_at,rowid",
            [],
        )?;
        let payroll_contribution_definitions = query_all(
            connection,
            "SELECT * FROM payroll_contribution_definitions ORDER BY code,effective_from",
            [],
        )?;
        let payslip_contributions = query_all(
            connection,
            "SELECT * FROM payslip_contributions ORDER BY payslip_id,rowid",
            [],
        )?;
        let payroll_document_imports = query_all(
            connection,
            "SELECT * FROM payroll_document_imports ORDER BY created_at DESC",
            [],
        )?;
        let employee_payroll_templates = query_all(
            connection,
            "SELECT * FROM employee_payroll_templates ORDER BY employee_id",
            [],
        )?;
        let quote_conversions = query_all(
            connection,
            "SELECT * FROM quote_conversions ORDER BY created_at",
            [],
        )?;
        let audit_log = query_all(
            connection,
            "SELECT * FROM audit_log ORDER BY occurred_at,rowid",
            [],
        )?;

        let mut workspace = json!({
            "settings": settings,
            "clients": clients,
            "catalog_items": catalog_items,
            "suppliers": suppliers,
            "projects": projects,
            "quotes": quotes,
            "quote_items": quote_items,
            "invoices": invoices,
            "invoice_items": invoice_items,
            "invoice_qr_bills": invoice_qr_bills,
            "employees": employees,
            "time_entries": time_entries,
            "expenses": expenses,
            "supplier_invoices":supplier_invoices,
            "supplier_invoice_items":supplier_invoice_items,
            "supplier_payments":supplier_payments,
            "payslips": payslips,
            "payslip_items": payslip_items,
            "payments": payments,
            "bank_imports":bank_imports,
            "bank_movements":bank_movements,
            "bank_reconciliations":bank_reconciliations,
            "bank_movement_keys":bank_movement_keys,
            "bank_account_links":bank_account_links,
            "attachments": attachments,
            "active_timer": active_timer,
            "accounts":accounts,
            "accounting_settings":accounting_settings,
            "accounting_periods":accounting_periods,
            "journal_entries":journal_entries,
            "journal_lines":journal_lines,
            "reminder_settings":reminder_settings,
            "reminder_templates":reminder_templates,
            "reminders":reminders,
            "reminder_history":reminder_history,
            "payroll_contribution_definitions":payroll_contribution_definitions,
            "payslip_contributions":payslip_contributions,
            "payroll_document_imports":payroll_document_imports,
            "employee_payroll_templates":employee_payroll_templates,
            "quote_conversions":quote_conversions,
            "audit_log":audit_log,
        });
        workspace["time_billing_batches"] = json!(time_billing_batches);
        workspace["time_billing_entries"] = json!(time_billing_entries);
        workspace["bank_supplier_reconciliations"] = json!(bank_supplier_reconciliations);
        workspace["stock_movements"] = json!(stock_movements);
        workspace["project_milestones"] = json!(project_milestones);
        workspace["project_tasks"] = json!(project_tasks);
        workspace["schema_version"] = json!(SCHEMA_VERSION);
        Ok(workspace)
    }

    pub fn create_record(&self, entity: &str, data: Value) -> AppResult<Value> {
        if entity == "payments" {
            let input: RecordPaymentInput = serde_json::from_value(data)?;
            return self.record_payment(input);
        }
        let spec = entity_spec(entity)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut object = value_object(data)?;
        if entity == "expenses" {
            enrich_expense_supplier_snapshot(&connection, &mut object)?;
        }
        strip_readonly_fields(entity, &mut object);
        validate_keys(&object, spec.fields)?;
        normalize_record(entity, &mut object, true)?;
        validate_required(&object, spec.required)?;

        let id = object
            .remove("id")
            .and_then(|value| value.as_str().map(ToOwned::to_owned))
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = now_iso();

        let mut columns = vec!["id".to_owned()];
        let mut values = vec![SqlValue::Text(id.clone())];
        for field in spec.fields {
            if let Some(value) = object.get(*field) {
                columns.push((*field).to_owned());
                values.push(json_to_sql(value)?);
            }
        }
        columns.extend(["created_at".to_owned(), "updated_at".to_owned()]);
        values.extend([SqlValue::Text(now.clone()), SqlValue::Text(now)]);
        let placeholders = vec!["?"; columns.len()].join(",");
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            spec.table,
            columns.join(","),
            placeholders
        );

        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if entity == "time_entries" {
            validate_time_entry_task_link(&transaction, &object, None)?;
        }
        if entity == "payslip_items" {
            let payslip_id = object
                .get("payslip_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let protected: bool = transaction
                .query_row(
                    "SELECT status IN ('valide','comptabilise','paye') FROM payslips WHERE id=?",
                    params![payslip_id],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(true);
            if protected {
                return Err(AppError::Validation(
                    "Les lignes d’une fiche validée doivent être modifiées par le flux atomique de paie."
                        .into(),
                ));
            }
        }
        transaction.execute(&sql, params_from_iter(values))?;
        recompute_after_change(&transaction, entity, &object, None)?;
        if entity == "expenses"
            && object
                .get("payment_status")
                .and_then(Value::as_str)
                .unwrap_or("paid")
                == "paid"
        {
            post_expense_if_enabled(&transaction, &id)?.ok_or_else(|| {
                AppError::Validation(
                    "Activez la comptabilité et ses comptes de liaison avant d'enregistrer un achat déjà payé. L'opération a été annulée sans modifier vos données."
                        .into(),
                )
            })?;
        }
        let record = query_record_tx(&transaction, spec.table, &id)?;
        append_audit(&transaction, "create", entity, &id, &record)?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn save_document_with_items(&self, input: SaveDocumentWithItemsInput) -> AppResult<Value> {
        let (entity, item_entity, parent_column) = match input.entity.as_str() {
            "quotes" => ("quotes", "quote_items", "quote_id"),
            "invoices" => ("invoices", "invoice_items", "invoice_id"),
            _ => {
                return Err(AppError::Validation(
                    "entity doit être quotes ou invoices.".into(),
                ))
            }
        };
        if input.items.is_empty() {
            return Err(AppError::Validation(
                "Le document doit contenir au moins une ligne.".into(),
            ));
        }
        let document_spec = entity_spec(entity)?;
        let item_spec = entity_spec(item_entity)?;
        let mut document_data = value_object(input.data)?;
        document_data.remove("id");
        strip_readonly_fields(entity, &mut document_data);
        validate_keys(&document_data, document_spec.fields)?;

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (document_id, previous) = match input.id.filter(|value| !value.trim().is_empty()) {
            Some(id) => {
                let previous = query_record_tx(&transaction, document_spec.table, &id)?;
                ensure_record_mutable(&transaction, entity, &previous)?;
                normalize_record_patch(entity, &mut document_data, &previous)?;
                if !document_data.is_empty() {
                    let mut assignments = Vec::new();
                    let mut values = Vec::new();
                    for field in document_spec.fields {
                        if let Some(value) = document_data.get(*field) {
                            assignments.push(format!("{field}=?"));
                            values.push(json_to_sql(value)?);
                        }
                    }
                    assignments.push("updated_at=?".into());
                    values.push(SqlValue::Text(now_iso()));
                    values.push(SqlValue::Text(id.clone()));
                    transaction.execute(
                        &format!(
                            "UPDATE {} SET {} WHERE id=?",
                            document_spec.table,
                            assignments.join(",")
                        ),
                        params_from_iter(values),
                    )?;
                }
                (id, previous)
            }
            None => {
                normalize_record(entity, &mut document_data, true)?;
                validate_required(&document_data, document_spec.required)?;
                let id = Uuid::new_v4().to_string();
                let now = now_iso();
                let mut columns = vec!["id".to_owned()];
                let mut values = vec![SqlValue::Text(id.clone())];
                for field in document_spec.fields {
                    if let Some(value) = document_data.get(*field) {
                        columns.push((*field).to_owned());
                        values.push(json_to_sql(value)?);
                    }
                }
                columns.extend(["created_at".to_owned(), "updated_at".to_owned()]);
                values.extend([SqlValue::Text(now.clone()), SqlValue::Text(now)]);
                transaction.execute(
                    &format!(
                        "INSERT INTO {} ({}) VALUES ({})",
                        document_spec.table,
                        columns.join(","),
                        vec!["?"; columns.len()].join(",")
                    ),
                    params_from_iter(values),
                )?;
                (id, Value::Null)
            }
        };

        transaction.execute(
            &format!("DELETE FROM {} WHERE {parent_column}=?", item_spec.table),
            params![document_id],
        )?;
        for (position, item) in input.items.into_iter().enumerate() {
            let mut item_data = value_object(item)?;
            let item_id = item_data
                .remove("id")
                .and_then(|value| value.as_str().map(ToOwned::to_owned))
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            strip_readonly_fields(item_entity, &mut item_data);
            item_data.insert(parent_column.into(), json!(document_id));
            item_data.insert("position".into(), json!(position));
            validate_keys(&item_data, item_spec.fields)?;
            normalize_record(item_entity, &mut item_data, true)?;
            validate_required(&item_data, item_spec.required)?;
            let now = now_iso();
            let mut columns = vec!["id".to_owned()];
            let mut values = vec![SqlValue::Text(item_id)];
            for field in item_spec.fields {
                if let Some(value) = item_data.get(*field) {
                    columns.push((*field).to_owned());
                    values.push(json_to_sql(value)?);
                }
            }
            columns.extend(["created_at".to_owned(), "updated_at".to_owned()]);
            values.extend([SqlValue::Text(now.clone()), SqlValue::Text(now)]);
            transaction.execute(
                &format!(
                    "INSERT INTO {} ({}) VALUES ({})",
                    item_spec.table,
                    columns.join(","),
                    vec!["?"; columns.len()].join(",")
                ),
                params_from_iter(values),
            )?;
        }
        if entity == "quotes" {
            recompute_quote(&transaction, &document_id)?;
        } else {
            recompute_invoice(&transaction, &document_id)?;
        }
        let document = query_record_tx(&transaction, document_spec.table, &document_id)?;
        let items = query_all(
            &transaction,
            &format!(
                "SELECT * FROM {} WHERE {parent_column}=? ORDER BY position,rowid",
                item_spec.table
            ),
            params![document_id],
        )?;
        let result = json!({"document":document,"items":items});
        append_audit(
            &transaction,
            if previous.is_null() {
                "create"
            } else {
                "update"
            },
            "document_atomic",
            &document_id,
            &json!({"entity":entity,"before":previous,"after":result.clone()}),
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn update_record(&self, entity: &str, id: &str, data: Value) -> AppResult<Value> {
        if id.trim().is_empty() {
            return Err(AppError::Validation("id est obligatoire.".into()));
        }
        let spec = entity_spec(entity)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut object = value_object(data)?;
        object.remove("id");
        if entity == "expenses" {
            enrich_expense_supplier_snapshot(&connection, &mut object)?;
        }
        strip_readonly_fields(entity, &mut object);
        validate_keys(&object, spec.fields)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = query_record_tx(&transaction, spec.table, id)?;
        ensure_record_mutable(&transaction, entity, &previous)?;
        normalize_record_patch(entity, &mut object, &previous)?;
        if entity == "time_entries" {
            validate_time_entry_task_link(&transaction, &object, Some(&previous))?;
        }
        if object.is_empty() {
            return Err(AppError::Validation("Aucun champ à modifier.".into()));
        }
        let mut assignments = Vec::new();
        let mut values = Vec::new();
        for field in spec.fields {
            if let Some(value) = object.get(*field) {
                assignments.push(format!("{field} = ?"));
                values.push(json_to_sql(value)?);
            }
        }
        assignments.push("updated_at = ?".into());
        values.push(SqlValue::Text(now_iso()));
        values.push(SqlValue::Text(id.to_owned()));
        let sql = format!(
            "UPDATE {} SET {} WHERE id = ?",
            spec.table,
            assignments.join(",")
        );
        if transaction.execute(&sql, params_from_iter(values))? != 1 {
            return Err(AppError::NotFound(format!("{entity}/{id}")));
        }
        recompute_after_change(&transaction, entity, &object, Some(&previous))?;
        if entity == "expenses"
            && previous.get("payment_status").and_then(Value::as_str) == Some("pending")
            && object.get("payment_status").and_then(Value::as_str) == Some("paid")
        {
            post_expense_if_enabled(&transaction, id)?.ok_or_else(|| {
                AppError::Validation(
                    "Activez la comptabilité et ses comptes de liaison avant de marquer cet achat payé. L'opération a été annulée sans modifier vos données."
                        .into(),
                )
            })?;
        }
        let record = query_record_tx(&transaction, spec.table, id)?;
        append_audit(
            &transaction,
            "update",
            entity,
            id,
            &json!({"before":previous,"after":record.clone()}),
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn delete_record(&self, entity: &str, id: &str) -> AppResult<DeleteResult> {
        let spec = entity_spec(entity)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = query_record_tx(&transaction, spec.table, id)?;
        if entity == "projects" {
            ensure_project_empty_before_delete(&transaction, id)?;
        }
        ensure_record_mutable(&transaction, entity, &previous)?;
        let deleted = transaction.execute(
            &format!("DELETE FROM {} WHERE id = ?", spec.table),
            params![id],
        )? == 1;
        if !deleted {
            return Err(AppError::NotFound(format!("{entity}/{id}")));
        }
        recompute_after_delete(&transaction, entity, &previous)?;
        append_audit(&transaction, "delete", entity, id, &previous)?;
        transaction.commit()?;

        Ok(DeleteResult {
            deleted,
            id: id.to_owned(),
        })
    }

    pub fn update_settings(&self, data: Value) -> AppResult<Value> {
        const FIELDS: &[&str] = &[
            "company_name",
            "legal_form",
            "owner_name",
            "email",
            "phone",
            "address_line1",
            "address_line2",
            "postal_code",
            "city",
            "canton",
            "country",
            "noga_section",
            "noga_division",
            "activity_description",
            "noga_detailed_code",
            "uid_number",
            "vat_number",
            "vat_registered",
            "default_vat_bp",
            "iban",
            "bank_name",
            "currency",
            "quote_prefix",
            "invoice_prefix",
            "credit_note_prefix",
            "quote_start_number",
            "invoice_start_number",
            "credit_note_start_number",
            "payment_terms_days",
            "quote_validity_days",
            "default_hourly_rate_cents",
            "logo_path",
            "extra_settings_json",
        ];
        let mut object = value_object(data)?;
        validate_keys(&object, FIELDS)?;
        let settings_rates_to_import =
            if let Some(extra) = object.get("extra_settings_json").cloned() {
                let mut normalized_extra = parsed_json_object(Some(extra))?;
                let rates = take_explicit_settings_rates(&mut normalized_extra);
                object.insert("extra_settings_json".into(), normalized_extra);
                rates
            } else {
                None
            };
        normalize_settings_patch(&mut object)?;
        if object.is_empty() {
            return Err(AppError::Validation("Aucun réglage à modifier.".into()));
        }

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (
            current_vat_registered,
            current_vat_bp,
            current_uid,
            current_vat_number,
            current_noga_section,
            current_noga_division,
            current_activity_description,
            current_noga_detailed_code,
            current_iban,
        ): SettingsValidationRow = transaction.query_row(
            "SELECT vat_registered,default_vat_bp,uid_number,vat_number,noga_section,noga_division,activity_description,noga_detailed_code,iban FROM settings WHERE id=1",
            [],
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
                    row.get(8)?,
                ))
            },
        )?;
        let vat_registered = object
            .get("vat_registered")
            .and_then(Value::as_bool)
            .map(bool_to_i64)
            .unwrap_or(current_vat_registered);
        let vat_bp = object
            .get("default_vat_bp")
            .and_then(Value::as_i64)
            .unwrap_or(current_vat_bp);
        validate_vat_configuration(vat_registered == 1, vat_bp)?;
        let effective_text = |field: &str, current: Option<String>| match object.get(field) {
            Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.clone()),
            Some(_) => None,
            None => current,
        };
        let uid_number = effective_text("uid_number", current_uid);
        let vat_number = effective_text("vat_number", current_vat_number);
        validate_vat_identifier(
            vat_registered == 1,
            uid_number.as_deref(),
            vat_number.as_deref(),
        )?;
        let noga_section = effective_text("noga_section", current_noga_section)
            .unwrap_or_default()
            .trim()
            .to_uppercase();
        let noga_division = effective_text("noga_division", current_noga_division)
            .unwrap_or_default()
            .trim()
            .to_owned();
        let activity_description =
            effective_text("activity_description", current_activity_description)
                .unwrap_or_default()
                .trim()
                .to_owned();
        let noga_detailed_code = effective_text("noga_detailed_code", current_noga_detailed_code);
        validate_activity_profile(
            &noga_section,
            &noga_division,
            &activity_description,
            noga_detailed_code.as_deref(),
        )?;
        let effective_iban = effective_text("iban", current_iban).unwrap_or_default();
        normalize_and_validate_iban(&effective_iban)?;
        let mut assignments = Vec::new();
        let mut values = Vec::new();
        for field in FIELDS {
            if let Some(value) = object.get(*field) {
                assignments.push(format!("{field} = ?"));
                values.push(json_to_sql(value)?);
            }
        }
        assignments.push("updated_at = ?".into());
        values.push(SqlValue::Text(now_iso()));
        if transaction.execute(
            &format!("UPDATE settings SET {} WHERE id = 1", assignments.join(",")),
            params_from_iter(values),
        )? != 1
        {
            return Err(AppError::OnboardingRequired);
        }
        if let Some(rates) = settings_rates_to_import.as_ref() {
            import_explicit_settings_rates(&transaction, rates)?;
        }
        let record = query_optional_tx(&transaction, "SELECT * FROM settings WHERE id = 1", [])?
            .ok_or(AppError::OnboardingRequired)?;
        append_audit(&transaction, "update", "settings", "1", &record)?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn issue_quote(
        &self,
        id: &str,
        issue_date: Option<String>,
        valid_until: Option<String>,
    ) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = query_record_tx(&transaction, "quotes", id)?;
        if existing
            .get("number")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
        {
            transaction.commit()?;
            return Ok(existing);
        }
        let date = normalized_date(issue_date.as_deref().unwrap_or(&today()), "issue_date")?;
        let quote_validity_days: i64 = transaction.query_row(
            "SELECT quote_validity_days FROM settings WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let valid = match valid_until {
            Some(value) if !value.trim().is_empty() => normalized_date(&value, "valid_until")?,
            _ => add_days(&date, quote_validity_days)?,
        };
        let number = assign_document_number(&transaction, "quotes", id, "quote", &date)?;
        let item_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM quote_items WHERE quote_id=?",
            params![id],
            |row| row.get(0),
        )?;
        if item_count == 0 {
            return Err(AppError::Validation(
                "Le devis doit contenir au moins une ligne avant émission.".into(),
            ));
        }
        let snapshot = build_document_snapshot(
            &transaction,
            "quotes",
            "quote_items",
            id,
            &json!({"number":number.clone(),"issue_date":date.clone(),"valid_until":valid.clone()}),
        )?;
        transaction.execute(
            "UPDATE quotes SET number = ?, status = CASE WHEN status = 'brouillon' THEN 'emis' ELSE status END, issue_date = ?, valid_until = ?, snapshot_json=?, updated_at = ? WHERE id = ?",
            params![number, date, valid, serde_json::to_string(&snapshot)?, now_iso(), id],
        )?;
        let record = query_record_tx(&transaction, "quotes", id)?;
        append_audit(&transaction, "issue", "quote", id, &record)?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn issue_invoice(
        &self,
        id: &str,
        issue_date: Option<String>,
        due_date: Option<String>,
    ) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = query_record_tx(&transaction, "invoices", id)?;
        if existing
            .get("number")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
        {
            transaction.commit()?;
            return Ok(existing);
        }
        if existing.get("status").and_then(Value::as_str) != Some("brouillon") {
            return Err(AppError::Validation(
                "Seule une facture brouillon peut être émise.".into(),
            ));
        }
        let date = normalized_date(issue_date.as_deref().unwrap_or(&today()), "issue_date")?;
        ensure_accounting_date_open(&transaction, &date)?;
        let payment_terms_days: i64 = transaction.query_row(
            "SELECT payment_terms_days FROM settings WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let invoice_type = existing
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("standard");
        if !matches!(invoice_type, "avoir" | "credit_note") {
            let issuer_iban: Option<String> =
                transaction
                    .query_row("SELECT iban FROM settings WHERE id=1", [], |row| row.get(0))?;
            normalize_and_validate_iban(issuer_iban.as_deref().unwrap_or(""))?;
        }
        let due = match due_date {
            Some(value) if !value.trim().is_empty() => normalized_date(&value, "due_date")?,
            _ if invoice_type == "avoir" => date.clone(),
            _ => add_days(&date, payment_terms_days)?,
        };
        let service_from = existing
            .get("service_date_from")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                AppError::Validation("service_date_from est obligatoire avant émission.".into())
            })?
            .to_owned();
        normalized_date(&service_from, "service_date_from")?;
        let service_to = existing
            .get("service_date_to")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .unwrap_or(&service_from)
            .to_owned();
        normalized_date(&service_to, "service_date_to")?;
        if service_to < service_from {
            return Err(AppError::Validation(
                "service_date_to précède service_date_from.".into(),
            ));
        }
        let item_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM invoice_items WHERE invoice_id=?",
            params![id],
            |r| r.get(0),
        )?;
        if item_count == 0 {
            return Err(AppError::Validation(
                "La facture doit contenir au moins une ligne avant émission.".into(),
            ));
        }
        let original_invoice_id = existing
            .get("original_invoice_id")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(ToOwned::to_owned);
        let mut original_credit_limit = None;
        if invoice_type == "avoir" {
            let original = original_invoice_id.as_deref().ok_or_else(|| {
                AppError::Validation(
                    "original_invoice_id est obligatoire pour émettre un avoir.".into(),
                )
            })?;
            let original_document: Option<(
                Option<String>,
                Option<String>,
                String,
                i64,
            )> = transaction
                .query_row(
                    "SELECT client_id,project_id,currency,total_cents FROM invoices WHERE id=? AND type<>'avoir' AND number IS NOT NULL AND status<>'annulee'",
                    params![original],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?;
            let (original_client, original_project, original_currency, original_total) =
                original_document.ok_or_else(|| {
                    AppError::Validation(
                        "L'avoir doit référencer une facture originale émise et non annulée."
                            .into(),
                    )
                })?;
            let credit_client = existing
                .get("client_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let credit_project = existing
                .get("project_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let credit_currency = existing
                .get("currency")
                .and_then(Value::as_str)
                .unwrap_or("");
            if credit_client != original_client
                || credit_project != original_project
                || credit_currency != original_currency
            {
                return Err(AppError::Validation(
                    "L'avoir doit conserver le client, le chantier et la devise de la facture originale."
                        .into(),
                ));
            }
            if original_total <= 0 {
                return Err(AppError::Validation(
                    "Le total de la facture originale doit être positif.".into(),
                ));
            }
            original_credit_limit = Some((original.to_owned(), original_total));
            transaction.execute("UPDATE invoice_items SET unit_price_cents=-ABS(unit_price_cents) WHERE invoice_id=?",params![id])?;
            recompute_all_invoice_lines(&transaction, id)?;
            recompute_invoice(&transaction, id)?;
        } else {
            let negative:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id=? AND (unit_price_cents<0 OR line_total_cents<0))",params![id],|r|r.get(0))?;
            if negative {
                return Err(AppError::Validation(
                    "Les montants négatifs sont réservés aux avoirs.".into(),
                ));
            }
        }
        let totals: (i64, i64, i64) = transaction.query_row(
            "SELECT subtotal_cents,vat_cents,total_cents FROM invoices WHERE id=?",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if (invoice_type == "avoir" && (totals.0 >= 0 || totals.1 > 0 || totals.2 >= 0))
            || (invoice_type != "avoir" && (totals.0 < 0 || totals.1 < 0 || totals.2 <= 0))
        {
            return Err(AppError::Validation(
                "Le signe des montants ne correspond pas au type de document.".into(),
            ));
        }
        if let Some((original, original_total)) = original_credit_limit {
            let already_credited: i64 = transaction.query_row(
                "SELECT COALESCE(SUM(-total_cents),0) FROM invoices WHERE type='avoir' AND original_invoice_id=? AND number IS NOT NULL AND id<>?",
                params![original, id],
                |row| row.get(0),
            )?;
            let requested_credit = totals.2.checked_neg().ok_or_else(|| {
                AppError::Validation("Le montant de l'avoir dépasse la capacité locale.".into())
            })?;
            if already_credited.saturating_add(requested_credit) > original_total {
                return Err(AppError::Validation(
                    "Le cumul des avoirs ne peut pas dépasser le total de la facture originale."
                        .into(),
                ));
            }
        }
        let number_type = if invoice_type == "avoir" {
            "credit_note"
        } else {
            "invoice"
        };
        let number = assign_document_number(&transaction, "invoices", id, number_type, &date)?;
        let qr_frozen_at = now_iso();
        transaction.execute(
            "UPDATE invoice_qr_bills SET frozen_at=COALESCE(frozen_at,?),updated_at=? WHERE invoice_id=?",
            params![qr_frozen_at, qr_frozen_at, id],
        )?;
        let snapshot = build_document_snapshot(
            &transaction,
            "invoices",
            "invoice_items",
            id,
            &json!({"number":number.clone(),"issue_date":date.clone(),"due_date":due.clone(),"service_date_from":service_from.clone(),"service_date_to":service_to.clone()}),
        )?;
        transaction.execute(
            "UPDATE invoices SET number = ?, status = CASE WHEN status = 'brouillon' THEN 'emise' ELSE status END, issue_date = ?, due_date = ?,service_date_from=?,service_date_to=?,snapshot_json=?, updated_at = ? WHERE id = ?",
            params![number, date, due,service_from,service_to,serde_json::to_string(&snapshot)?, now_iso(), id],
        )?;
        let stock_movements = crate::stock::apply_invoice_stock_movements(&transaction, id)?;
        let record = query_record_tx(&transaction, "invoices", id)?;
        let journal = post_invoice_if_enabled(&transaction, id)?;
        if let Some(original) = original_invoice_id.as_deref() {
            refresh_invoice_payment_state(&transaction, original)?;
            cancel_settled_reminders(&transaction, original)?;
        }
        append_audit(
            &transaction,
            "issue",
            if invoice_type == "avoir" {
                "credit_note"
            } else {
                "invoice"
            },
            id,
            &json!({"document":record.clone(),"journal":journal,"stock_movements":stock_movements}),
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn update_quote_status(&self, id: &str, status: &str) -> AppResult<Value> {
        let normalized = match status {
            "accepted" | "accepte" => "accepte",
            "refused" | "refuse" => "refuse",
            "expired" | "expire" => "expire",
            _ => {
                return Err(AppError::Validation(
                    "status doit être accepted, refused ou expired.".into(),
                ))
            }
        };
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = query_record_tx(&transaction, "quotes", id)?;
        if previous.get("number").and_then(Value::as_str).is_none() {
            return Err(AppError::Validation(
                "Le devis doit être émis avant de recevoir une décision.".into(),
            ));
        }
        let current = previous.get("status").and_then(Value::as_str).unwrap_or("");
        if current == normalized {
            transaction.commit()?;
            return Ok(previous);
        }
        if current != "emis" {
            return Err(AppError::Validation(format!(
                "Transition de statut interdite depuis {current}."
            )));
        }
        transaction.execute(
            "UPDATE quotes SET status=?,updated_at=? WHERE id=?",
            params![normalized, now_iso(), id],
        )?;
        let record = query_record_tx(&transaction, "quotes", id)?;
        append_audit(
            &transaction,
            "status",
            "quote",
            id,
            &json!({"from":current,"to":normalized}),
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn convert_quote_to_invoice(&self, input: ConvertQuoteInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let quote = query_record_tx(&transaction, "quotes", &input.quote_id)?;
        if quote["status"] != "accepte" {
            return Err(AppError::Validation(
                "Seul un devis accepté peut être converti en facture.".into(),
            ));
        }
        let existing: Option<String> = transaction
            .query_row(
                "SELECT invoice_id FROM quote_conversions WHERE quote_id=?",
                params![input.quote_id],
                |r| r.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(AppError::Validation(format!(
                "Ce devis a déjà été converti en facture {}.",
                existing.unwrap_or_default()
            )));
        }
        let issue_date = input
            .issue_date
            .as_deref()
            .map(|v| normalized_date(v, "issue_date"))
            .transpose()?;
        let due_date = input
            .due_date
            .as_deref()
            .map(|v| normalized_date(v, "due_date"))
            .transpose()?;
        let service_from = input
            .service_date_from
            .as_deref()
            .map(|v| normalized_date(v, "service_date_from"))
            .transpose()?;
        let service_to = input
            .service_date_to
            .as_deref()
            .map(|v| normalized_date(v, "service_date_to"))
            .transpose()?;
        if let (Some(from), Some(to)) = (&service_from, &service_to) {
            if to < from {
                return Err(AppError::Validation(
                    "service_date_to précède service_date_from.".into(),
                ));
            }
        }
        let invoice_id = Uuid::new_v4().to_string();
        let now = now_iso();
        let title = input
            .title
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| quote["title"].as_str().unwrap_or("Facture").to_owned());
        transaction.execute("INSERT INTO invoices(id,client_id,project_id,quote_id,title,type,status,issue_date,due_date,service_date_from,service_date_to,currency,notes,terms,created_at,updated_at) VALUES(?,?,?,?,?,'standard','brouillon',?,?,?,?,?,?,?,?,?)",params![invoice_id,quote["client_id"].as_str(),quote["project_id"].as_str(),input.quote_id,title,issue_date,due_date,service_from,service_to,quote["currency"].as_str(),quote["notes"].as_str(),quote["terms"].as_str(),now,now])?;
        let mut statement=transaction.prepare("SELECT position,catalog_item_id,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents FROM quote_items WHERE quote_id=? ORDER BY position,rowid")?;
        let items = statement
            .query_map(params![input.quote_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, i64>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, i64>(10)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        if items.is_empty() {
            return Err(AppError::Validation(
                "Le devis accepté ne contient aucune ligne.".into(),
            ));
        }
        for item in items {
            transaction.execute("INSERT INTO invoice_items(id,invoice_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![Uuid::new_v4().to_string(),invoice_id,item.1,item.0,item.2,item.3,item.4,item.5,item.6,item.7,item.8,item.9,item.10,now,now])?;
        }
        recompute_invoice(&transaction, &invoice_id)?;
        transaction.execute(
            "INSERT INTO quote_conversions(quote_id,invoice_id,created_at) VALUES(?,?,?)",
            params![input.quote_id, invoice_id, now],
        )?;
        let invoice = query_record_tx(&transaction, "invoices", &invoice_id)?;
        let invoice_items = query_all(
            &transaction,
            "SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY position,rowid",
            params![invoice_id],
        )?;
        let result = json!({"quote":quote,"invoice":invoice,"invoice_items":invoice_items});
        append_audit(&transaction, "convert", "quote", &input.quote_id, &result)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn record_payment(&self, input: RecordPaymentInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record = record_payment_in_transaction(&transaction, input)?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn start_timer(&self, input: TimerInput) -> AppResult<Value> {
        let project_id = input.project_id.trim().to_owned();
        if project_id.is_empty() {
            return Err(AppError::Validation("project_id est obligatoire.".into()));
        }
        let task_id = match input.task_id {
            Some(value) if value.trim().is_empty() => None,
            Some(value) if value.trim().chars().count() > 80 => {
                return Err(AppError::Validation(
                    "task_id ne peut pas dépasser 80 caractères.".into(),
                ));
            }
            Some(value) => Some(value.trim().to_owned()),
            None => None,
        };
        if input.billing_rate_cents < 0 || input.cost_rate_cents < 0 {
            return Err(AppError::Validation(
                "Les taux du chronomètre ne peuvent pas être négatifs.".into(),
            ));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?)",
            params![project_id],
            |row| row.get(0),
        )?;
        if !project_exists {
            return Err(AppError::NotFound(format!("projects/{project_id}")));
        }
        if let Some(task_id) = task_id.as_deref() {
            let task: Option<(String, String)> = transaction
                .query_row(
                    "SELECT project_id,status FROM project_tasks WHERE id=?",
                    params![task_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((task_project_id, task_status)) = task else {
                return Err(AppError::NotFound(format!("project_tasks/{task_id}")));
            };
            if task_project_id != project_id {
                return Err(AppError::Validation(
                    "La tâche du chronomètre appartient à un autre projet.".into(),
                ));
            }
            if !matches!(task_status.as_str(), "todo" | "in_progress") {
                return Err(AppError::Validation(
                    "Le chronomètre ne peut démarrer que sur une tâche ouverte.".into(),
                ));
            }
        }
        let timer_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM active_timers WHERE id = 1)",
            [],
            |row| row.get(0),
        )?;
        if timer_exists {
            return Err(AppError::Validation(
                "Un chronomètre est déjà en cours. Arrêtez-le avant d'en démarrer un autre.".into(),
            ));
        }
        transaction.execute(
            "INSERT INTO active_timers (id,project_id,task_id,employee_id,started_at,note,billable,billing_rate_cents,cost_rate_cents) VALUES (1,?,?,?,?,?,?,?,?)",
            params![
                project_id,
                task_id,
                clean_optional(input.employee_id, 80),
                now_iso(),
                clean_optional(input.note, 5000),
                bool_to_i64(input.billable),
                input.billing_rate_cents,
                input.cost_rate_cents,
            ],
        )?;
        let timer =
            query_optional_tx(&transaction, "SELECT * FROM active_timers WHERE id = 1", [])?
                .ok_or_else(|| AppError::NotFound("active_timers/1".into()))?;
        transaction.commit()?;
        Ok(timer)
    }

    pub fn stop_timer(&self) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let timer =
            query_optional_tx(&transaction, "SELECT * FROM active_timers WHERE id = 1", [])?
                .ok_or_else(|| AppError::NotFound("Aucun chronomètre actif".into()))?;
        let started_at = timer
            .get("started_at")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Validation("Horodatage du chronomètre invalide.".into()))?;
        let started = DateTime::parse_from_rfc3339(started_at)
            .map_err(|_| AppError::Validation("Horodatage du chronomètre invalide.".into()))?;
        let ended = Utc::now();
        let elapsed_seconds = ended
            .signed_duration_since(started.with_timezone(&Utc))
            .num_seconds()
            .max(0);
        let elapsed_minutes = ((elapsed_seconds + 59) / 60).max(1);
        let extra_settings_json: String = transaction.query_row(
            "SELECT extra_settings_json FROM settings WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        let work_settings: Value = serde_json::from_str(&extra_settings_json)?;
        let rounding_minutes = work_settings
            .pointer("/work/roundingMinutes")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let configured_break = work_settings
            .pointer("/work/breakMinutes")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if !(0..=1_440).contains(&rounding_minutes) || !(0..=1_440).contains(&configured_break) {
            return Err(AppError::Validation(
                "Les règles locales d'arrondi et de pause doivent être comprises entre 0 et 1440 minutes."
                    .into(),
            ));
        }
        let break_minutes = configured_break.min(elapsed_minutes.saturating_sub(1));
        let worked_minutes = elapsed_minutes - break_minutes;
        let minutes = if rounding_minutes > 1 {
            worked_minutes
                .saturating_add(rounding_minutes - 1)
                .saturating_div(rounding_minutes)
                .saturating_mul(rounding_minutes)
        } else {
            worked_minutes
        };
        let id = Uuid::new_v4().to_string();
        let now = ended.to_rfc3339();
        transaction.execute(
            "INSERT INTO time_entries (id,project_id,task_id,employee_id,date,started_at,ended_at,minutes,break_minutes,billable,billing_rate_cents,cost_rate_cents,note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                id,
                timer.get("project_id").and_then(Value::as_str),
                timer.get("task_id").and_then(Value::as_str),
                timer.get("employee_id").and_then(Value::as_str),
                &started_at[..10.min(started_at.len())],
                started_at,
                now,
                minutes,
                break_minutes,
                timer.get("billable").and_then(Value::as_bool).map(bool_to_i64).unwrap_or(1),
                timer.get("billing_rate_cents").and_then(Value::as_i64).unwrap_or(0),
                timer.get("cost_rate_cents").and_then(Value::as_i64).unwrap_or(0),
                timer.get("note").and_then(Value::as_str),
                "approuve",
                now,
                now,
            ],
        )?;
        transaction.execute("DELETE FROM active_timers WHERE id = 1", [])?;
        let record = query_record_tx(&transaction, "time_entries", &id)?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn cancel_timer(&self) -> AppResult<DeleteResult> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let deleted = connection.execute("DELETE FROM active_timers WHERE id = 1", [])? == 1;
        Ok(DeleteResult {
            deleted,
            id: "1".into(),
        })
    }

    pub fn get_active_timer(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(
            query_optional(&connection, "SELECT * FROM active_timers WHERE id = 1", [])?
                .unwrap_or(Value::Null),
        )
    }

    pub fn open_attachment(&self, id: &str) -> AppResult<String> {
        let path = self.verified_attachment_path(id)?;
        open_path(&path)?;
        Ok(path.to_string_lossy().into_owned())
    }

    pub fn open_data_folder(&self) -> AppResult<String> {
        open_path(&self.data_dir)?;
        Ok(self.data_dir.to_string_lossy().into_owned())
    }

    pub fn list_audit_log(
        &self,
        entity_type: Option<String>,
        entity_id: Option<String>,
    ) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let rows=match (entity_type,entity_id){
            (Some(kind),Some(id))=>query_all(&connection,"SELECT * FROM audit_log WHERE entity_type=? AND entity_id=? ORDER BY occurred_at,rowid",params![kind,id])?,
            (Some(kind),None)=>query_all(&connection,"SELECT * FROM audit_log WHERE entity_type=? ORDER BY occurred_at,rowid",params![kind])?,
            (None,Some(id))=>query_all(&connection,"SELECT * FROM audit_log WHERE entity_id=? ORDER BY occurred_at,rowid",params![id])?,
            (None,None)=>query_all(&connection,"SELECT * FROM audit_log ORDER BY occurred_at,rowid",[])?,
        };
        Ok(Value::Array(rows))
    }

    pub fn verify_audit_log(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        verify_audit_chain(&connection)
    }

    #[cfg(test)]
    pub fn business_row_counts(&self) -> AppResult<BTreeMap<String, i64>> {
        let connection = self.connect()?;
        let mut counts = BTreeMap::new();
        for table in BUSINESS_TABLES {
            let count: i64 =
                connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            counts.insert((*table).to_owned(), count);
        }
        Ok(counts)
    }

    pub(crate) fn safe_attachment_path(&self, stored_name: &str) -> AppResult<PathBuf> {
        if stored_name.is_empty()
            || stored_name.contains('/')
            || stored_name.contains('\\')
            || stored_name.contains("..")
        {
            return Err(AppError::UnsafePath(PathBuf::from(stored_name)));
        }
        Ok(self.attachments_dir.join(stored_name))
    }
}

struct EntitySpec {
    table: &'static str,
    fields: &'static [&'static str],
    required: &'static [&'static str],
}

fn entity_spec(entity: &str) -> AppResult<EntitySpec> {
    let spec = match entity {
        "clients" => EntitySpec {
            table: "clients",
            fields: &[
                "name",
                "company",
                "contact_person",
                "email",
                "phone",
                "address_line1",
                "address_line2",
                "postal_code",
                "city",
                "canton",
                "country",
                "notes",
                "archived_at",
            ],
            required: &["name"],
        },
        "catalog_items" => EntitySpec {
            table: "catalog_items",
            fields: &[
                "kind",
                "sku",
                "name",
                "description",
                "unit",
                "sales_price_cents",
                "purchase_cost_cents",
                "vat_bp",
                "track_stock",
                "stock_quantity_milli",
                "reorder_level_milli",
                "archived_at",
            ],
            required: &["kind", "name"],
        },
        "suppliers" => EntitySpec {
            table: "suppliers",
            fields: &[
                "name",
                "contact_name",
                "email",
                "phone",
                "address",
                "uid_number",
                "iban",
                "currency",
                "payment_terms_days",
                "notes",
                "archived_at",
            ],
            required: &["name"],
        },
        "projects" => EntitySpec {
            table: "projects",
            fields: &[
                "client_id",
                "code",
                "name",
                "address_line1",
                "address_line2",
                "postal_code",
                "city",
                "canton",
                "status",
                "planned_start_date",
                "planned_end_date",
                "actual_start_date",
                "actual_end_date",
                "budget_cents",
                "planned_minutes",
                "progress",
                "description",
                "notes",
            ],
            required: &["name"],
        },
        "quotes" => EntitySpec {
            table: "quotes",
            fields: &[
                "client_id",
                "project_id",
                "title",
                "status",
                "issue_date",
                "valid_until",
                "currency",
                "notes",
                "terms",
            ],
            required: &["title"],
        },
        "quote_items" => EntitySpec {
            table: "quote_items",
            fields: &[
                "quote_id",
                "catalog_item_id",
                "position",
                "description",
                "quantity",
                "unit",
                "unit_price_cents",
                "discount_bp",
                "vat_bp",
                "line_net_cents",
                "line_vat_cents",
                "line_total_cents",
            ],
            required: &["quote_id", "description", "vat_bp"],
        },
        "invoices" => EntitySpec {
            table: "invoices",
            fields: &[
                "client_id",
                "project_id",
                "quote_id",
                "original_invoice_id",
                "title",
                "type",
                "status",
                "issue_date",
                "due_date",
                "service_date_from",
                "service_date_to",
                "currency",
                "notes",
                "terms",
            ],
            required: &["title"],
        },
        "invoice_items" => EntitySpec {
            table: "invoice_items",
            fields: &[
                "invoice_id",
                "catalog_item_id",
                "position",
                "description",
                "quantity",
                "unit",
                "unit_price_cents",
                "discount_bp",
                "vat_bp",
                "line_net_cents",
                "line_vat_cents",
                "line_total_cents",
            ],
            required: &["invoice_id", "description", "vat_bp"],
        },
        "employees" => EntitySpec {
            table: "employees",
            fields: &[
                "employee_number",
                "name",
                "role",
                "email",
                "phone",
                "address_line1",
                "address_line2",
                "postal_code",
                "city",
                "canton",
                "country",
                "birth_date",
                "social_security_number",
                "iban",
                "employment_start_date",
                "employment_end_date",
                "reference_age_date",
                "avs_allowance_waived",
                "contractual_weekly_minutes",
                "ac_opening_year",
                "ac_opening_basis_cents",
                "employment_rate",
                "hourly_rate_cents",
                "monthly_salary_cents",
                "status",
                "notes",
            ],
            required: &["name"],
        },
        "time_entries" => EntitySpec {
            table: "time_entries",
            fields: &[
                "project_id",
                "task_id",
                "employee_id",
                "date",
                "started_at",
                "ended_at",
                "minutes",
                "break_minutes",
                "billable",
                "billing_rate_cents",
                "cost_rate_cents",
                "note",
                "status",
            ],
            required: &["project_id", "date", "minutes"],
        },
        "expenses" => EntitySpec {
            table: "expenses",
            fields: &[
                "project_id",
                "supplier_id",
                "date",
                "due_date",
                "supplier",
                "category",
                "reference",
                "currency",
                "net_cents",
                "vat_cents",
                "total_cents",
                "payment_status",
                "paid_at",
                "reimbursable",
                "note",
            ],
            required: &["date"],
        },
        "payslips" => EntitySpec {
            table: "payslips",
            fields: &[
                "employee_id",
                "period",
                "status",
                "gross_cents",
                "deductions_cents",
                "net_cents",
                "employer_costs_cents",
                "payment_date",
                "notes",
            ],
            required: &["employee_id", "period"],
        },
        "payslip_items" => EntitySpec {
            table: "payslip_items",
            fields: &[
                "payslip_id",
                "position",
                "label",
                "kind",
                "amount_cents",
                "posting_account_id",
                "expense_account_id",
            ],
            required: &["payslip_id", "label", "kind", "amount_cents"],
        },
        "payments" => EntitySpec {
            table: "payments",
            fields: &[
                "invoice_id",
                "date",
                "amount_cents",
                "method",
                "reference",
                "notes",
            ],
            required: &["invoice_id", "date", "amount_cents"],
        },
        _ => {
            return Err(AppError::Validation(format!(
                "Entité non autorisée : {entity}"
            )))
        }
    };
    Ok(spec)
}

fn ensure_record_mutable(
    transaction: &Transaction<'_>,
    entity: &str,
    record: &Value,
) -> AppResult<()> {
    let locked=match entity {
        "quotes"|"invoices"=>record.get("number").and_then(Value::as_str).is_some_and(|v|!v.is_empty()),
        "payments"=>true,
        "quote_items"=>record.get("quote_id").and_then(Value::as_str).is_some_and(|id|transaction.query_row("SELECT number IS NOT NULL FROM quotes WHERE id=?",params![id],|r|r.get::<_,bool>(0)).unwrap_or(true)),
        "invoice_items"=>record.get("invoice_id").and_then(Value::as_str).is_some_and(|id|transaction.query_row("SELECT number IS NOT NULL FROM invoices WHERE id=?",params![id],|r|r.get::<_,bool>(0)).unwrap_or(true)),
        "payslips"=>record.get("status").and_then(Value::as_str).is_some_and(|v|matches!(v,"valide"|"comptabilise"|"paye")),
        "payslip_items"=>record.get("payslip_id").and_then(Value::as_str).is_some_and(|id|transaction.query_row("SELECT status IN ('valide','comptabilise','paye') FROM payslips WHERE id=?",params![id],|r|r.get::<_,bool>(0)).unwrap_or(true)),
        "expenses"=>record.get("id").and_then(Value::as_str).is_some_and(|id|transaction.query_row("SELECT EXISTS(SELECT 1 FROM journal_entries WHERE source_type='expense' AND source_id=?)",params![id],|r|r.get::<_,bool>(0)).unwrap_or(true)),
        _=>false,
    };
    if locked {
        return Err(AppError::Validation("Cet enregistrement financier est immuable. Utilisez un avoir ou une écriture d'extourne.".into()));
    }
    Ok(())
}

fn ensure_project_empty_before_delete(
    transaction: &Transaction<'_>,
    project_id: &str,
) -> AppResult<()> {
    const DEPENDENCIES: &[(&str, &str)] = &[
        ("project_milestones", "jalons"),
        ("project_tasks", "tâches"),
        ("time_entries", "temps saisis"),
        ("time_billing_batches", "lots de facturation des temps"),
        ("quotes", "devis"),
        ("invoices", "factures clients"),
        ("expenses", "dépenses"),
        ("supplier_invoices", "factures fournisseurs"),
        ("supplier_invoice_items", "lignes de factures fournisseurs"),
        ("active_timers", "chronomètre actif"),
        ("attachments", "pièces jointes"),
        ("journal_lines", "écritures comptables"),
    ];
    let mut linked = Vec::new();
    for (table, label) in DEPENDENCIES {
        let count: i64 = transaction.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE project_id=?"),
            params![project_id],
            |row| row.get(0),
        )?;
        if count > 0 {
            linked.push(format!("{label} ({count})"));
        }
    }
    if linked.is_empty() {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "Le projet ne peut pas être supprimé car il contient encore : {}. Supprimez ou réaffectez ces données avant de réessayer.",
            linked.join(", ")
        )))
    }
}

fn value_object(data: Value) -> AppResult<Map<String, Value>> {
    data.as_object()
        .cloned()
        .ok_or_else(|| AppError::Validation("Les données doivent être un objet JSON.".into()))
}

fn enrich_expense_supplier_snapshot(
    connection: &Connection,
    object: &mut Map<String, Value>,
) -> AppResult<()> {
    let supplier_id = match object.get("supplier_id").cloned() {
        Some(Value::String(value)) if value.trim().is_empty() => {
            object.insert("supplier_id".into(), Value::Null);
            return Ok(());
        }
        Some(Value::String(value)) => value,
        Some(Value::Null) | None => return Ok(()),
        Some(_) => {
            return Err(AppError::Validation(
                "supplier_id doit être un identifiant texte ou null.".into(),
            ));
        }
    };
    let supplier_name: String = connection
        .query_row(
            "SELECT name FROM suppliers WHERE id=?",
            params![supplier_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("suppliers/{supplier_id}")))?;
    let snapshot_missing = object
        .get("supplier")
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty());
    if snapshot_missing {
        object.insert("supplier".into(), Value::String(supplier_name));
    }
    Ok(())
}

fn validate_keys(object: &Map<String, Value>, allowed: &[&str]) -> AppResult<()> {
    let allowed: HashSet<&str> = allowed.iter().copied().collect();
    for key in object.keys() {
        if key != "id" && !allowed.contains(key.as_str()) {
            return Err(AppError::Validation(format!("Champ non autorisé : {key}")));
        }
    }
    Ok(())
}

fn validate_required(object: &Map<String, Value>, required: &[&str]) -> AppResult<()> {
    for field in required {
        let valid = object.get(*field).is_some_and(|value| match value {
            Value::String(value) => !value.trim().is_empty(),
            Value::Null => false,
            _ => true,
        });
        if !valid {
            return Err(AppError::Validation(format!(
                "Le champ {field} est obligatoire."
            )));
        }
    }
    Ok(())
}

fn strip_readonly_fields(entity: &str, object: &mut Map<String, Value>) {
    let fields: &[&str] = match entity {
        "quotes" => &[
            "number",
            "snapshot_json",
            "subtotal_cents",
            "discount_cents",
            "vat_cents",
            "total_cents",
        ],
        "invoices" => &[
            "number",
            "snapshot_json",
            "subtotal_cents",
            "discount_cents",
            "vat_cents",
            "total_cents",
            "paid_cents",
        ],
        "quote_items" | "invoice_items" => {
            &["line_net_cents", "line_vat_cents", "line_total_cents"]
        }
        "payslips" => &[
            "gross_cents",
            "deductions_cents",
            "net_cents",
            "employer_costs_cents",
        ],
        _ => &[],
    };
    for field in fields {
        object.remove(*field);
    }
}

fn normalize_record(
    entity: &str,
    object: &mut Map<String, Value>,
    creating: bool,
) -> AppResult<()> {
    for value in object.values_mut() {
        if let Value::String(text) = value {
            *text = text.trim().to_owned();
        }
    }
    if creating && matches!(entity, "quotes" | "invoices") {
        object.insert("status".into(), Value::String("brouillon".into()));
    }
    if let Some(currency) = object.get_mut("currency") {
        let value = currency.as_str().unwrap_or("CHF");
        *currency = Value::String(normalized_code(value, "currency", 3, "CHF")?);
    }
    match entity {
        "catalog_items" => normalize_catalog_item(object)?,
        "suppliers" => normalize_supplier(object)?,
        "quote_items" | "invoice_items" => normalize_line_item(object)?,
        "invoices" => {
            if let Some(invoice_type) = object.get_mut("type") {
                let normalized = match invoice_type.as_str().unwrap_or_default() {
                    "standard" => "standard",
                    "deposit" | "acompte" => "acompte",
                    "progress" | "situation" => "situation",
                    "final" | "finale" => "finale",
                    "credit_note" | "avoir" => "avoir",
                    _ => {
                        return Err(AppError::Validation(
                            "type doit être standard, deposit, progress, final ou credit_note."
                                .into(),
                        ))
                    }
                };
                *invoice_type = Value::String(normalized.into());
            }
        }
        "expenses" => normalize_expense(object)?,
        "employees" => {
            if let Some(country) = object.get_mut("country") {
                *country = Value::String(normalized_code(
                    country.as_str().unwrap_or("CH"),
                    "country",
                    2,
                    "CH",
                )?);
            }
            let parsed_date = |field: &str| -> AppResult<Option<NaiveDate>> {
                let Some(value) = object
                    .get(field)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    return Ok(None);
                };
                NaiveDate::parse_from_str(value, "%Y-%m-%d")
                    .map(Some)
                    .map_err(|_| {
                        AppError::Validation(format!(
                            "{field} doit être une date valide au format AAAA-MM-JJ."
                        ))
                    })
            };
            let birth = parsed_date("birth_date")?;
            let start = parsed_date("employment_start_date")?;
            let end = parsed_date("employment_end_date")?;
            let reference_age = parsed_date("reference_age_date")?;
            if start.zip(end).is_some_and(|(from, to)| to < from) {
                return Err(AppError::Validation(
                    "La fin du contrat précède son début.".into(),
                ));
            }
            if birth
                .zip(reference_age)
                .is_some_and(|(birth, reference)| reference <= birth)
            {
                return Err(AppError::Validation(
                    "La date confirmée de l'âge de référence doit être postérieure à la naissance."
                        .into(),
                ));
            }
            if object.get("avs_allowance_waived").is_some_and(|value| {
                !value.is_null()
                    && value.as_bool().is_none()
                    && !value.as_i64().is_some_and(|flag| matches!(flag, 0 | 1))
            }) {
                return Err(AppError::Validation(
                    "avs_allowance_waived doit être oui, non ou non confirmé.".into(),
                ));
            }
            if object
                .get("contractual_weekly_minutes")
                .is_some_and(|value| {
                    !value.is_null()
                        && !value
                            .as_i64()
                            .is_some_and(|minutes| (0..=10_080).contains(&minutes))
                })
            {
                return Err(AppError::Validation(
                    "contractual_weekly_minutes doit être un nombre entier entre 0 et 10080, ou non confirmé."
                        .into(),
                ));
            }
            let ac_opening_year = object.get("ac_opening_year");
            let ac_opening_basis = object.get("ac_opening_basis_cents");
            let year_present = ac_opening_year.is_some_and(|value| !value.is_null());
            let basis_present = ac_opening_basis.is_some_and(|value| !value.is_null());
            if year_present != basis_present {
                return Err(AppError::Validation(
                    "L’année et la base d’ouverture AC doivent être confirmées ensemble, même si la base est zéro."
                        .into(),
                ));
            }
            if year_present
                && !ac_opening_year
                    .and_then(Value::as_i64)
                    .is_some_and(|year| (1900..=9999).contains(&year))
            {
                return Err(AppError::Validation(
                    "ac_opening_year doit être une année comprise entre 1900 et 9999.".into(),
                ));
            }
            if basis_present
                && !ac_opening_basis
                    .and_then(Value::as_i64)
                    .is_some_and(|basis| basis >= 0)
            {
                return Err(AppError::Validation(
                    "ac_opening_basis_cents doit être un montant entier positif ou nul.".into(),
                ));
            }
        }
        "payslips"
            if object
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| matches!(status, "valide" | "comptabilise" | "paye")) =>
        {
            return Err(AppError::Validation(
                "Une fiche validée doit passer par le flux atomique de paie et ses contrôles réglementaires."
                    .into(),
            ));
        }
        "payslips" if !object.contains_key("net_cents") => {
            let gross = object
                .get("gross_cents")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let deductions = object
                .get("deductions_cents")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            object.insert("net_cents".into(), json!(gross.saturating_sub(deductions)));
        }
        "payslips" => {}
        "payslip_items" => {
            if let Some(kind) = object.get_mut("kind") {
                let normalized = match kind.as_str().unwrap_or_default() {
                    "earning" | "gain" => "earning",
                    "deduction" => "deduction",
                    "reimbursement" | "expense_reimbursement" | "non_gross_payment" => {
                        "reimbursement"
                    }
                    "employer" => "employer",
                    _ => {
                        return Err(AppError::Validation(
                            "kind doit être earning, deduction, reimbursement ou employer.".into(),
                        ))
                    }
                };
                *kind = Value::String(normalized.into());
            }
            if object
                .get("amount_cents")
                .and_then(Value::as_i64)
                .is_some_and(|value| value < 0)
            {
                return Err(AppError::Validation(
                    "amount_cents ne peut pas être négatif.".into(),
                ));
            }
        }
        "projects" => {
            if let Some(progress) = object.get("progress").and_then(Value::as_i64) {
                if !(0..=100).contains(&progress) {
                    return Err(AppError::Validation(
                        "progress doit être compris entre 0 et 100.".into(),
                    ));
                }
            }
        }
        "time_entries"
            if object
                .get("minutes")
                .and_then(Value::as_i64)
                .is_some_and(|value| value < 0) =>
        {
            return Err(AppError::Validation(
                "minutes ne peut pas être négatif.".into(),
            ));
        }
        "time_entries" => {}
        _ => {}
    }
    Ok(())
}

fn normalize_catalog_item(object: &mut Map<String, Value>) -> AppResult<()> {
    if let Some(kind) = object.get("kind") {
        if !kind
            .as_str()
            .is_some_and(|value| matches!(value, "product" | "service"))
        {
            return Err(AppError::Validation(
                "kind doit être product ou service.".into(),
            ));
        }
    }

    if let Some(name) = object.get("name") {
        let Some(name) = name.as_str() else {
            return Err(AppError::Validation("name doit être du texte.".into()));
        };
        if name.is_empty() || name.chars().count() > 200 {
            return Err(AppError::Validation(
                "name doit contenir entre 1 et 200 caractères.".into(),
            ));
        }
    }

    match object.get("sku").cloned() {
        Some(Value::Null) | None => {}
        Some(Value::String(value)) if value.is_empty() => {
            object.insert("sku".into(), Value::Null);
        }
        Some(Value::String(value)) if value.chars().count() <= 80 => {}
        Some(Value::String(_)) => {
            return Err(AppError::Validation(
                "sku ne peut pas dépasser 80 caractères.".into(),
            ));
        }
        Some(_) => return Err(AppError::Validation("sku doit être du texte.".into())),
    }

    match object.get("description").cloned() {
        Some(Value::Null) => {
            object.insert("description".into(), Value::String(String::new()));
        }
        Some(Value::String(value)) if value.chars().count() <= 10_000 => {}
        Some(Value::String(_)) => {
            return Err(AppError::Validation(
                "description ne peut pas dépasser 10000 caractères.".into(),
            ));
        }
        Some(_) => {
            return Err(AppError::Validation(
                "description doit être du texte.".into(),
            ));
        }
        None => {}
    }

    match object.get("unit").cloned() {
        Some(Value::Null) => {
            object.insert("unit".into(), Value::String("unité".into()));
        }
        Some(Value::String(value)) if value.is_empty() => {
            object.insert("unit".into(), Value::String("unité".into()));
        }
        Some(Value::String(value)) if value.chars().count() <= 40 => {}
        Some(Value::String(_)) => {
            return Err(AppError::Validation(
                "unit ne peut pas dépasser 40 caractères.".into(),
            ));
        }
        Some(_) => return Err(AppError::Validation("unit doit être du texte.".into())),
        None => {}
    }

    for (field, maximum) in [
        ("sales_price_cents", i64::MAX),
        ("purchase_cost_cents", i64::MAX),
        ("vat_bp", 10_000),
        ("stock_quantity_milli", i64::MAX),
        ("reorder_level_milli", i64::MAX),
    ] {
        if object.get(field).is_some_and(|value| {
            !value
                .as_i64()
                .is_some_and(|number| (0..=maximum).contains(&number))
        }) {
            return Err(AppError::Validation(format!(
                "{field} doit être un nombre entier positif ou nul{}.",
                if field == "vat_bp" {
                    " inférieur ou égal à 10000"
                } else {
                    ""
                }
            )));
        }
    }

    if let Some(value) = object.get("track_stock").cloned() {
        let normalized = match value {
            Value::Bool(value) => value,
            Value::Number(value) if value.as_i64().is_some_and(|flag| matches!(flag, 0 | 1)) => {
                value.as_i64() == Some(1)
            }
            _ => {
                return Err(AppError::Validation(
                    "track_stock doit être oui ou non.".into(),
                ));
            }
        };
        object.insert("track_stock".into(), Value::Bool(normalized));
    }
    if object.get("track_stock").and_then(Value::as_bool) == Some(true)
        && object.get("kind").and_then(Value::as_str) != Some("product")
    {
        return Err(AppError::Validation(
            "track_stock peut être activé uniquement pour un article de type product.".into(),
        ));
    }

    match object.get("archived_at").cloned() {
        Some(Value::String(value)) if value.is_empty() => {
            object.insert("archived_at".into(), Value::Null);
        }
        Some(Value::String(value)) => {
            DateTime::parse_from_rfc3339(&value).map_err(|_| {
                AppError::Validation("archived_at doit être une date/heure ISO 8601 valide.".into())
            })?;
        }
        Some(Value::Null) | None => {}
        Some(_) => {
            return Err(AppError::Validation(
                "archived_at doit être une date/heure ISO 8601 ou null.".into(),
            ));
        }
    }
    Ok(())
}

fn normalize_supplier(object: &mut Map<String, Value>) -> AppResult<()> {
    if let Some(name) = object.get("name") {
        let Some(name) = name.as_str() else {
            return Err(AppError::Validation("name doit être du texte.".into()));
        };
        if name.is_empty() || name.chars().count() > 200 {
            return Err(AppError::Validation(
                "name doit contenir entre 1 et 200 caractères.".into(),
            ));
        }
    }
    for (field, maximum) in [
        ("contact_name", 200),
        ("email", 254),
        ("phone", 80),
        ("address", 1_000),
        ("uid_number", 80),
        ("notes", 10_000),
    ] {
        match object.get(field).cloned() {
            Some(Value::String(value)) if value.is_empty() => {
                object.insert(field.into(), Value::Null);
            }
            Some(Value::String(value)) if value.chars().count() <= maximum => {}
            Some(Value::String(_)) => {
                return Err(AppError::Validation(format!(
                    "{field} ne peut pas dépasser {maximum} caractères."
                )));
            }
            Some(Value::Null) | None => {}
            Some(_) => {
                return Err(AppError::Validation(format!(
                    "{field} doit être du texte ou null."
                )));
            }
        }
    }
    if object
        .get("currency")
        .and_then(Value::as_str)
        .is_some_and(|currency| currency != "CHF")
    {
        return Err(AppError::Validation(
            "La devise d’un fournisseur doit être CHF.".into(),
        ));
    }
    if object
        .get("payment_terms_days")
        .is_some_and(|value| !value.as_i64().is_some_and(|number| number >= 0))
    {
        return Err(AppError::Validation(
            "payment_terms_days doit être un nombre entier positif ou nul.".into(),
        ));
    }
    match object.get("iban").cloned() {
        Some(Value::String(value)) if value.is_empty() => {
            object.insert("iban".into(), Value::Null);
        }
        Some(Value::String(value)) => {
            object.insert(
                "iban".into(),
                Value::String(normalize_and_validate_iban(&value)?),
            );
        }
        Some(Value::Null) | None => {}
        Some(_) => {
            return Err(AppError::Validation(
                "iban doit être un IBAN CH ou LI ou null.".into(),
            ));
        }
    }
    match object.get("archived_at").cloned() {
        Some(Value::String(value)) if value.is_empty() => {
            object.insert("archived_at".into(), Value::Null);
        }
        Some(Value::String(value)) => {
            DateTime::parse_from_rfc3339(&value).map_err(|_| {
                AppError::Validation("archived_at doit être une date/heure ISO 8601 valide.".into())
            })?;
        }
        Some(Value::Null) | None => {}
        Some(_) => {
            return Err(AppError::Validation(
                "archived_at doit être une date/heure ISO 8601 ou null.".into(),
            ));
        }
    }
    Ok(())
}

fn normalize_expense(object: &mut Map<String, Value>) -> AppResult<()> {
    if object
        .get("currency")
        .and_then(Value::as_str)
        .is_some_and(|currency| currency != "CHF")
    {
        return Err(AppError::Validation(
            "La devise d’une dépense doit être CHF.".into(),
        ));
    }
    for field in ["date", "due_date", "paid_at"] {
        match object.get(field).cloned() {
            Some(Value::String(value)) if value.is_empty() && field != "date" => {
                object.insert(field.into(), Value::Null);
            }
            Some(Value::String(value)) => {
                object.insert(field.into(), Value::String(normalized_date(&value, field)?));
            }
            Some(Value::Null) | None if field != "date" => {}
            None => {}
            Some(_) => {
                return Err(AppError::Validation(format!(
                    "{field} doit être une date AAAA-MM-JJ{}.",
                    if field == "date" { "" } else { " ou null" }
                )));
            }
        }
    }
    if let (Some(date), Some(due_date)) = (
        object.get("date").and_then(Value::as_str),
        object.get("due_date").and_then(Value::as_str),
    ) {
        if due_date < date {
            return Err(AppError::Validation(
                "due_date ne peut pas précéder la date de la dépense.".into(),
            ));
        }
    }
    let payment_status = match object.get("payment_status") {
        Some(Value::String(value)) if matches!(value.as_str(), "pending" | "paid") => {
            value.as_str()
        }
        None => "paid",
        _ => {
            return Err(AppError::Validation(
                "payment_status doit être pending ou paid.".into(),
            ));
        }
    };
    if payment_status == "pending" {
        if !object
            .get("due_date")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
        {
            return Err(AppError::Validation(
                "due_date est obligatoire pour une dépense en attente.".into(),
            ));
        }
        if object.get("paid_at").is_some_and(|value| !value.is_null()) {
            return Err(AppError::Validation(
                "paid_at doit être null pour une dépense en attente.".into(),
            ));
        }
    }
    if let Some(value) = object.get("supplier") {
        if !value.is_null()
            && !value
                .as_str()
                .is_some_and(|supplier| supplier.chars().count() <= 500)
        {
            return Err(AppError::Validation(
                "supplier doit être du texte de 500 caractères maximum ou null.".into(),
            ));
        }
    }
    for field in ["net_cents", "vat_cents", "total_cents"] {
        if object
            .get(field)
            .is_some_and(|value| !value.as_i64().is_some_and(|amount| amount >= 0))
        {
            return Err(AppError::Validation(format!(
                "{field} doit être un montant entier positif ou nul."
            )));
        }
    }
    let net = object.get("net_cents").and_then(Value::as_i64).unwrap_or(0);
    let vat = object.get("vat_cents").and_then(Value::as_i64).unwrap_or(0);
    let expected_total = net.checked_add(vat).ok_or_else(|| {
        AppError::Validation("Les montants de la dépense sont trop élevés.".into())
    })?;
    match object.get("total_cents").and_then(Value::as_i64) {
        Some(total) if total != expected_total => {
            return Err(AppError::Validation(
                "total_cents doit être égal à net_cents + vat_cents.".into(),
            ));
        }
        Some(_) => {}
        None => {
            object.insert("total_cents".into(), json!(expected_total));
        }
    }
    Ok(())
}

fn normalize_record_patch(
    entity: &str,
    object: &mut Map<String, Value>,
    previous: &Value,
) -> AppResult<()> {
    let supplied_fields: Vec<String> = object.keys().cloned().collect();
    let mut merged = previous
        .as_object()
        .cloned()
        .ok_or_else(|| AppError::Validation("L'enregistrement existant est invalide.".into()))?;
    for (key, value) in object.iter() {
        merged.insert(key.clone(), value.clone());
    }
    if entity == "expenses"
        && (object.contains_key("net_cents") || object.contains_key("vat_cents"))
        && !object.contains_key("total_cents")
    {
        if let (Some(net), Some(vat)) = (
            merged.get("net_cents").and_then(Value::as_i64),
            merged.get("vat_cents").and_then(Value::as_i64),
        ) {
            if let Some(total) = net.checked_add(vat) {
                merged.insert("total_cents".into(), json!(total));
            }
        }
    }
    normalize_record(entity, &mut merged, false)?;

    for field in supplied_fields {
        if let Some(value) = merged.get(&field) {
            object.insert(field, value.clone());
        }
    }
    match entity {
        "quote_items" | "invoice_items" => {
            for field in ["line_net_cents", "line_vat_cents", "line_total_cents"] {
                if let Some(value) = merged.get(field) {
                    object.insert(field.into(), value.clone());
                }
            }
        }
        "expenses" => {
            if object.contains_key("net_cents") || object.contains_key("vat_cents") {
                let total = merged
                    .get("net_cents")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .saturating_add(merged.get("vat_cents").and_then(Value::as_i64).unwrap_or(0));
                object.insert("total_cents".into(), json!(total));
            }
        }
        "payslips"
            if object.contains_key("gross_cents") || object.contains_key("deductions_cents") =>
        {
            let net = merged
                .get("gross_cents")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .saturating_sub(
                    merged
                        .get("deductions_cents")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                );
            object.insert("net_cents".into(), json!(net));
        }
        "payslips" => {}
        _ => {}
    }
    Ok(())
}

fn normalize_line_item(object: &mut Map<String, Value>) -> AppResult<()> {
    let quantity = object
        .get("quantity")
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    let unit_price = object
        .get("unit_price_cents")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let discount_bp = object
        .get("discount_bp")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let vat_bp = object.get("vat_bp").and_then(Value::as_i64).unwrap_or(0);
    if !quantity.is_finite() || quantity < 0.0 {
        return Err(AppError::Validation(
            "quantity doit être un nombre positif.".into(),
        ));
    }
    if !(0..=10_000).contains(&discount_bp) || !(0..=10_000).contains(&vat_bp) {
        return Err(AppError::Validation(
            "discount_bp et vat_bp doivent être compris entre 0 et 10000.".into(),
        ));
    }
    let base = (quantity * unit_price as f64).round() as i64;
    let discount = round_basis_points(base, discount_bp);
    let net = base.saturating_sub(discount);
    let vat = round_basis_points(net, vat_bp);
    object.insert("quantity".into(), json!(quantity));
    object.insert("line_net_cents".into(), json!(net));
    object.insert("line_vat_cents".into(), json!(vat));
    object.insert("line_total_cents".into(), json!(net.saturating_add(vat)));
    Ok(())
}

fn round_basis_points(value: i64, basis_points: i64) -> i64 {
    let sign = if value < 0 { -1_i128 } else { 1_i128 };
    let absolute = (value as i128).abs();
    (sign * ((absolute * basis_points as i128 + 5_000) / 10_000)) as i64
}

fn recompute_all_invoice_lines(transaction: &Transaction<'_>, invoice_id: &str) -> AppResult<()> {
    let mut statement=transaction.prepare("SELECT id,quantity,unit_price_cents,discount_bp,vat_bp FROM invoice_items WHERE invoice_id=?")?;
    let rows = statement
        .query_map(params![invoice_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (id, quantity, price, discount_bp, vat_bp) in rows {
        let base = (quantity * price as f64).round() as i64;
        let discount = round_basis_points(base, discount_bp);
        let net = base - discount;
        let vat = round_basis_points(net, vat_bp);
        transaction.execute("UPDATE invoice_items SET line_net_cents=?,line_vat_cents=?,line_total_cents=?,updated_at=? WHERE id=?",params![net,vat,net+vat,now_iso(),id])?;
    }
    Ok(())
}

fn normalize_settings_patch(object: &mut Map<String, Value>) -> AppResult<()> {
    if let Some(value) = object.get("company_name") {
        required_text(value.as_str().unwrap_or_default(), "company_name", 200)?;
    }
    if let Some(value) = object.get_mut("currency") {
        *value = Value::String(normalized_code(
            value.as_str().unwrap_or("CHF"),
            "currency",
            3,
            "CHF",
        )?);
    }
    if let Some(value) = object.get_mut("iban") {
        let iban = value.as_str().ok_or_else(|| {
            AppError::Validation("iban doit être une chaîne de caractères.".into())
        })?;
        *value = Value::String(normalize_and_validate_iban(iban)?);
    }
    if let Some(value) = object.get_mut("noga_section") {
        let section = value.as_str().ok_or_else(|| {
            AppError::Validation("noga_section doit être une chaîne de caractères.".into())
        })?;
        *value = Value::String(section.trim().to_uppercase());
    }
    for field in [
        "noga_division",
        "activity_description",
        "noga_detailed_code",
    ] {
        if let Some(value) = object.get_mut(field) {
            if value.is_null() && field == "noga_detailed_code" {
                continue;
            }
            let text = value.as_str().ok_or_else(|| {
                AppError::Validation(format!("{field} doit être une chaîne de caractères."))
            })?;
            *value = Value::String(text.trim().to_owned());
        }
    }
    if let Some(value) = object.get_mut("quote_prefix") {
        *value = Value::String(normalized_prefix(value.as_str().unwrap_or("D"), "D")?);
    }
    if let Some(value) = object.get_mut("invoice_prefix") {
        *value = Value::String(normalized_prefix(value.as_str().unwrap_or("F"), "F")?);
    }
    if let Some(value) = object.get_mut("credit_note_prefix") {
        *value = Value::String(normalized_prefix(value.as_str().unwrap_or("A"), "A")?);
    }
    if let Some(value) = object.get_mut("vat_registered") {
        let normalized = match value {
            Value::Bool(value) => *value,
            Value::Number(value) if value.as_i64() == Some(0) => false,
            Value::Number(value) if value.as_i64() == Some(1) => true,
            _ => {
                return Err(AppError::Validation(
                    "vat_registered doit être un booléen.".into(),
                ))
            }
        };
        *value = Value::Bool(normalized);
    }
    for field in ["default_vat_bp"] {
        if object
            .get(field)
            .and_then(Value::as_i64)
            .is_some_and(|value| !(0..=10_000).contains(&value))
        {
            return Err(AppError::Validation(format!(
                "{field} doit être compris entre 0 et 10000."
            )));
        }
    }
    for field in ["payment_terms_days", "quote_validity_days"] {
        if object
            .get(field)
            .and_then(Value::as_i64)
            .is_some_and(|value| !(0..=365).contains(&value))
        {
            return Err(AppError::Validation(format!(
                "{field} doit être compris entre 0 et 365."
            )));
        }
    }
    for field in [
        "quote_start_number",
        "invoice_start_number",
        "credit_note_start_number",
    ] {
        if object
            .get(field)
            .and_then(Value::as_i64)
            .is_some_and(|value| value <= 0)
        {
            return Err(AppError::Validation(format!(
                "{field} doit être strictement positif."
            )));
        }
    }
    if object
        .get("default_hourly_rate_cents")
        .and_then(Value::as_i64)
        .is_some_and(|value| value < 0)
    {
        return Err(AppError::Validation(
            "default_hourly_rate_cents ne peut pas être négatif.".into(),
        ));
    }
    if let Some(extra) = object.get("extra_settings_json").cloned() {
        object.insert(
            "extra_settings_json".into(),
            Value::String(normalize_json_object(Some(extra))?),
        );
    }
    Ok(())
}

fn validate_vat_configuration(vat_registered: bool, vat_bp: i64) -> AppResult<()> {
    match (vat_registered, vat_bp) {
        (true, 1..=10_000) | (false, 0) => Ok(()),
        (true, _) => Err(AppError::Validation(
            "Un taux de TVA explicite est obligatoire pour une entreprise assujettie.".into(),
        )),
        (false, _) => Err(AppError::Validation(
            "Le taux de TVA doit être 0 pour une entreprise non assujettie.".into(),
        )),
    }
}

fn validate_vat_identifier(
    vat_registered: bool,
    uid_number: Option<&str>,
    vat_number: Option<&str>,
) -> AppResult<()> {
    if vat_registered
        && ![uid_number, vat_number]
            .into_iter()
            .flatten()
            .any(|value| !value.trim().is_empty())
    {
        return Err(AppError::Validation(
            "uid_number ou vat_number est obligatoire pour une entreprise assujettie à la TVA."
                .into(),
        ));
    }
    Ok(())
}

fn recompute_after_change(
    transaction: &Transaction<'_>,
    entity: &str,
    object: &Map<String, Value>,
    previous: Option<&Value>,
) -> AppResult<()> {
    match entity {
        "quote_items" => {
            if let Some(previous_parent) = previous
                .and_then(|value| value.get("quote_id"))
                .and_then(Value::as_str)
            {
                recompute_quote(transaction, previous_parent)?;
            }
            if let Some(parent) = object.get("quote_id").and_then(Value::as_str) {
                recompute_quote(transaction, parent)?;
            }
        }
        "invoice_items" => {
            if let Some(previous_parent) = previous
                .and_then(|value| value.get("invoice_id"))
                .and_then(Value::as_str)
            {
                recompute_invoice(transaction, previous_parent)?;
            }
            if let Some(parent) = object.get("invoice_id").and_then(Value::as_str) {
                recompute_invoice(transaction, parent)?;
            }
        }
        "payslip_items" => {
            if let Some(previous_parent) = previous
                .and_then(|value| value.get("payslip_id"))
                .and_then(Value::as_str)
            {
                recompute_payslip(transaction, previous_parent)?;
            }
            if let Some(parent) = object.get("payslip_id").and_then(Value::as_str) {
                recompute_payslip(transaction, parent)?;
            }
        }
        "payments" => {
            if let Some(previous_parent) = previous
                .and_then(|value| value.get("invoice_id"))
                .and_then(Value::as_str)
            {
                refresh_invoice_payment_state(transaction, previous_parent)?;
            }
            if let Some(parent) = object.get("invoice_id").and_then(Value::as_str) {
                refresh_invoice_payment_state(transaction, parent)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn recompute_after_delete(
    transaction: &Transaction<'_>,
    entity: &str,
    previous: &Value,
) -> AppResult<()> {
    match entity {
        "quote_items" => {
            if let Some(parent) = previous.get("quote_id").and_then(Value::as_str) {
                recompute_quote(transaction, parent)?;
            }
        }
        "invoice_items" => {
            if let Some(parent) = previous.get("invoice_id").and_then(Value::as_str) {
                recompute_invoice(transaction, parent)?;
            }
        }
        "payslip_items" => {
            if let Some(parent) = previous.get("payslip_id").and_then(Value::as_str) {
                recompute_payslip(transaction, parent)?;
            }
        }
        "payments" => {
            if let Some(parent) = previous.get("invoice_id").and_then(Value::as_str) {
                refresh_invoice_payment_state(transaction, parent)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn recompute_quote(transaction: &Transaction<'_>, quote_id: &str) -> AppResult<()> {
    let (subtotal, discount, vat, total): (i64, i64, i64, i64) = transaction.query_row(
        "SELECT CAST(COALESCE(SUM(ROUND(quantity * unit_price_cents)),0) AS INTEGER), CAST(COALESCE(SUM(ROUND(quantity * unit_price_cents) - line_net_cents),0) AS INTEGER), COALESCE(SUM(line_vat_cents),0), COALESCE(SUM(line_total_cents),0) FROM quote_items WHERE quote_id = ?",
        params![quote_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    transaction.execute(
        "UPDATE quotes SET subtotal_cents=?,discount_cents=?,vat_cents=?,total_cents=?,updated_at=? WHERE id=?",
        params![subtotal, discount, vat, total, now_iso(), quote_id],
    )?;
    Ok(())
}

pub(crate) fn recompute_invoice(transaction: &Transaction<'_>, invoice_id: &str) -> AppResult<()> {
    let (subtotal, discount, vat, total): (i64, i64, i64, i64) = transaction.query_row(
        "SELECT CAST(COALESCE(SUM(ROUND(quantity * unit_price_cents)),0) AS INTEGER), CAST(COALESCE(SUM(ROUND(quantity * unit_price_cents) - line_net_cents),0) AS INTEGER), COALESCE(SUM(line_vat_cents),0), COALESCE(SUM(line_total_cents),0) FROM invoice_items WHERE invoice_id = ?",
        params![invoice_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    transaction.execute(
        "UPDATE invoices SET subtotal_cents=?,discount_cents=?,vat_cents=?,total_cents=?,updated_at=? WHERE id=?",
        params![subtotal, discount, vat, total, now_iso(), invoice_id],
    )?;
    refresh_invoice_payment_state(transaction, invoice_id)
}

fn recompute_payslip(transaction: &Transaction<'_>, payslip_id: &str) -> AppResult<()> {
    let (gross, deductions, employer, reimbursements): (i64, i64, i64, i64) = transaction.query_row(
        "SELECT COALESCE(SUM(CASE WHEN kind IN ('earning','gain') THEN amount_cents ELSE 0 END),0), COALESCE(SUM(CASE WHEN kind='deduction' THEN ABS(amount_cents) ELSE 0 END),0), COALESCE(SUM(CASE WHEN kind='employer' THEN amount_cents ELSE 0 END),0), COALESCE(SUM(CASE WHEN kind='reimbursement' THEN amount_cents ELSE 0 END),0) FROM payslip_items WHERE payslip_id = ?",
        params![payslip_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    transaction.execute(
        "UPDATE payslips SET gross_cents=?,deductions_cents=?,net_cents=?,employer_costs_cents=?,updated_at=? WHERE id=?",
        params![gross, deductions, gross.saturating_add(reimbursements).saturating_sub(deductions), employer, now_iso(), payslip_id],
    )?;
    Ok(())
}

/// Noyau transactionnel unique des encaissements. Les imports bancaires
/// l'appellent dans la même transaction que leur rapprochement afin qu'un
/// paiement, son écriture comptable et le lien CAMT réussissent ou échouent ensemble.
pub(crate) fn record_payment_in_transaction(
    transaction: &Transaction<'_>,
    input: RecordPaymentInput,
) -> AppResult<Value> {
    if input.amount_cents <= 0 {
        return Err(AppError::Validation(
            "Le montant du paiement doit être supérieur à zéro.".into(),
        ));
    }
    let date = normalized_date(input.date.as_deref().unwrap_or(&today()), "date")?;
    let method = clean_optional(input.method, 80);
    let reference = clean_optional(input.reference, 160);
    let notes = clean_optional(input.notes, 5000);
    let requested_id = input
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::parse_str(value)
                .map(|parsed| parsed.to_string())
                .map_err(|_| {
                    AppError::Validation(
                        "request_id doit être un UUID valide pour sécuriser la reprise du paiement."
                            .into(),
                    )
                })
        })
        .transpose()?;
    if let Some(request_id) = requested_id.as_deref() {
        if let Some(existing) = query_optional_tx(
            transaction,
            "SELECT * FROM payments WHERE id=?",
            params![request_id],
        )? {
            let same_request = existing["invoice_id"].as_str() == Some(input.invoice_id.as_str())
                && existing["date"].as_str() == Some(date.as_str())
                && existing["amount_cents"].as_i64() == Some(input.amount_cents)
                && existing["method"].as_str() == method.as_deref()
                && existing["reference"].as_str() == reference.as_deref()
                && existing["notes"].as_str() == notes.as_deref();
            if same_request {
                return Ok(existing);
            }
            return Err(AppError::Validation(
                "Cet identifiant de reprise correspond déjà à un autre paiement. Rechargez la facture avant de réessayer."
                    .into(),
            ));
        }
    }
    let (total_cents, paid_cents, credited_cents, invoice_type, number): (
        i64,
        i64,
        i64,
        String,
        Option<String>,
    ) = transaction
        .query_row(
            "SELECT i.total_cents,i.paid_cents,COALESCE((SELECT SUM(-c.total_cents) FROM invoices c WHERE c.type='avoir' AND c.original_invoice_id=i.id AND c.number IS NOT NULL AND c.status<>'annulee'),0),i.type,i.number FROM invoices i WHERE i.id = ?",
            params![input.invoice_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("invoices/{}", input.invoice_id)))?;
    if invoice_type == "avoir" {
        return Err(AppError::Validation(
            "Un avoir ne peut recevoir aucun encaissement.".into(),
        ));
    }
    if number.is_none() {
        return Err(AppError::Validation(
            "La facture doit être émise avant tout paiement.".into(),
        ));
    }
    if total_cents <= 0 {
        return Err(AppError::Validation(
            "Cette facture ne possède aucun montant payable.".into(),
        ));
    }
    if paid_cents
        .saturating_add(credited_cents)
        .saturating_add(input.amount_cents)
        > total_cents
    {
        return Err(AppError::Validation(
            "Le paiement dépasse le solde restant de la facture.".into(),
        ));
    }
    let id = requested_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_iso();
    transaction.execute(
        "INSERT INTO payments (id,invoice_id,date,amount_cents,method,reference,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        params![
            id,
            input.invoice_id,
            date,
            input.amount_cents,
            method,
            reference,
            notes,
            now,
            now,
        ],
    )?;
    refresh_invoice_payment_state(transaction, &input.invoice_id)?;
    let record = query_record_tx(transaction, "payments", &id)?;
    let journal = post_payment_if_enabled(transaction, &id)?.ok_or_else(|| {
        AppError::Validation(
            "Activez la comptabilité et ses comptes de liaison avant d'enregistrer un paiement client. L'opération a été annulée sans modifier la facture."
                .into(),
        )
    })?;
    cancel_settled_reminders(transaction, &input.invoice_id)?;
    append_audit(
        transaction,
        "record",
        "payment",
        &id,
        &json!({"payment":record.clone(),"journal":journal}),
    )?;
    Ok(record)
}

pub(crate) fn refresh_invoice_payment_state(
    transaction: &Transaction<'_>,
    invoice_id: &str,
) -> AppResult<()> {
    let (paid, credited): (i64, i64) = transaction.query_row(
        "SELECT COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id=i.id),0),COALESCE((SELECT SUM(-c.total_cents) FROM invoices c WHERE c.type='avoir' AND c.original_invoice_id=i.id AND c.number IS NOT NULL AND c.status<>'annulee'),0) FROM invoices i WHERE i.id=?",
        params![invoice_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let settled = paid.saturating_add(credited);
    transaction.execute(
        "UPDATE invoices SET paid_cents=?, status=CASE WHEN status='annulee' THEN status WHEN ? >= total_cents AND total_cents > 0 THEN 'payee' WHEN ? > 0 THEN 'partiellement_payee' WHEN number IS NOT NULL THEN 'emise' ELSE 'brouillon' END, updated_at=? WHERE id=?",
        params![paid, settled, paid, now_iso(), invoice_id],
    )?;
    Ok(())
}

fn assign_document_number(
    transaction: &Transaction<'_>,
    table: &str,
    id: &str,
    document_type: &str,
    issue_date: &str,
) -> AppResult<String> {
    let existing: Option<String> = transaction
        .query_row(
            &format!("SELECT number FROM {table} WHERE id = ?"),
            params![id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("{table}/{id}")))?;
    if let Some(number) = existing.filter(|value| !value.trim().is_empty()) {
        return Ok(number);
    }
    let year: i64 = issue_date[..4]
        .parse()
        .map_err(|_| AppError::Validation("Année d'émission invalide.".into()))?;
    let (prefix_column, start_column) = match document_type {
        "quote" => ("quote_prefix", "quote_start_number"),
        "invoice" => ("invoice_prefix", "invoice_start_number"),
        "credit_note" => ("credit_note_prefix", "credit_note_start_number"),
        _ => {
            return Err(AppError::Validation(
                "Type de séquence documentaire invalide.".into(),
            ))
        }
    };
    let (prefix, start): (String, i64) = transaction.query_row(
        &format!("SELECT {prefix_column},{start_column} FROM settings WHERE id = 1"),
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let current: Option<i64> = transaction
        .query_row(
            "SELECT next_value FROM number_sequences WHERE document_type = ? AND year = ?",
            params![document_type, year],
            |row| row.get(0),
        )
        .optional()?;
    let next = current.unwrap_or(start);
    transaction.execute(
        "INSERT INTO number_sequences (document_type,year,next_value) VALUES (?,?,?) ON CONFLICT(document_type,year) DO UPDATE SET next_value=excluded.next_value",
        params![document_type, year, next + 1],
    )?;
    Ok(format!("{prefix}-{year}-{next:04}"))
}

pub(crate) fn query_record_tx(
    transaction: &Transaction<'_>,
    table: &str,
    id: &str,
) -> AppResult<Value> {
    query_optional_tx(
        transaction,
        &format!("SELECT * FROM {table} WHERE id = ?"),
        params![id],
    )?
    .ok_or_else(|| AppError::NotFound(format!("{table}/{id}")))
}

fn validate_time_entry_task_link(
    transaction: &Transaction<'_>,
    patch: &Map<String, Value>,
    previous: Option<&Value>,
) -> AppResult<()> {
    let project_id = patch
        .get("project_id")
        .and_then(Value::as_str)
        .or_else(|| previous.and_then(|record| record["project_id"].as_str()))
        .ok_or_else(|| AppError::Validation("project_id est obligatoire.".into()))?;
    let task_value = if patch.contains_key("task_id") {
        patch.get("task_id")
    } else {
        previous.map(|record| &record["task_id"])
    };
    let Some(task_value) = task_value else {
        return Ok(());
    };
    if task_value.is_null() {
        return Ok(());
    }
    let task_id = task_value
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Validation("task_id doit être un identifiant ou null.".into()))?;
    let task_project_id: Option<String> = transaction
        .query_row(
            "SELECT project_id FROM project_tasks WHERE id=?",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(task_project_id) = task_project_id else {
        return Err(AppError::NotFound(format!("project_tasks/{task_id}")));
    };
    if task_project_id != project_id {
        return Err(AppError::Validation(
            "La tâche affectée au temps appartient à un autre projet.".into(),
        ));
    }
    Ok(())
}

fn build_document_snapshot(
    transaction: &Transaction<'_>,
    table: &str,
    items_table: &str,
    id: &str,
    overrides: &Value,
) -> AppResult<Value> {
    let mut document = query_record_tx(transaction, table, id)?
        .as_object()
        .cloned()
        .ok_or_else(|| AppError::Validation("Document invalide.".into()))?;
    if let Some(values) = overrides.as_object() {
        for (key, value) in values {
            document.insert(key.clone(), value.clone());
        }
    }
    let settings=enrich_issuer_snapshot(query_optional_tx(transaction,"SELECT company_name,legal_form,owner_name,email,phone,address_line1,address_line2,postal_code,city,canton,country,uid_number,vat_number,vat_registered,iban,bank_name,currency,logo_path,extra_settings_json,noga_section,noga_division,activity_description,noga_detailed_code FROM settings WHERE id=1",[])?.ok_or(AppError::OnboardingRequired)?)?;
    let client = if let Some(client_id) = document.get("client_id").and_then(Value::as_str) {
        query_optional_tx(
            transaction,
            "SELECT * FROM clients WHERE id=?",
            params![client_id],
        )?
        .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let parent_column = if table == "quotes" {
        "quote_id"
    } else {
        "invoice_id"
    };
    let items = query_all(
        transaction,
        &format!("SELECT * FROM {items_table} WHERE {parent_column}=? ORDER BY position,rowid"),
        params![id],
    )?;
    let qr_bill = if table == "invoices" {
        query_optional_tx(
            transaction,
            "SELECT invoice_id,input_json,payload,reference_type,is_qr_iban,character_count,byte_count,frozen_at,created_at,updated_at FROM invoice_qr_bills WHERE invoice_id=?",
            params![id],
        )?
        .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    Ok(
        json!({"schema":"helvichantier.document_snapshot.v1","captured_at":now_iso(),"issuer":settings,"customer":client,"document":Value::Object(document),"items":items,"qr_bill":qr_bill}),
    )
}

pub(crate) fn enrich_issuer_snapshot(mut issuer: Value) -> AppResult<Value> {
    let extra = issuer
        .get("extra_settings_json")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(serde_json::from_str::<Value>)
        .transpose()?
        .unwrap_or_else(|| json!({}));
    let building_number = extra
        .pointer("/organization/address/buildingNumber")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    issuer
        .as_object_mut()
        .ok_or_else(|| AppError::Validation("Snapshot émetteur invalide.".into()))?
        .insert("building_number".into(), Value::String(building_number));
    Ok(issuer)
}

pub(crate) fn query_all<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> AppResult<Vec<Value>> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(params, row_to_json)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn query_optional<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> AppResult<Option<Value>> {
    let mut statement = connection.prepare(sql)?;
    statement
        .query_row(params, row_to_json)
        .optional()
        .map_err(Into::into)
}

fn query_optional_tx<P: rusqlite::Params>(
    transaction: &Transaction<'_>,
    sql: &str,
    params: P,
) -> AppResult<Option<Value>> {
    let mut statement = transaction.prepare(sql)?;
    statement
        .query_row(params, row_to_json)
        .optional()
        .map_err(Into::into)
}

fn row_to_json(row: &Row<'_>) -> rusqlite::Result<Value> {
    let statement = row.as_ref();
    let mut object = Map::new();
    for index in 0..statement.column_count() {
        let name = statement.column_name(index)?.to_owned();
        let value = match row.get_ref(index)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(value) if is_boolean_column(&name) => Value::Bool(value != 0),
            ValueRef::Integer(value) => Value::Number(Number::from(value)),
            ValueRef::Real(value) => Number::from_f64(value)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            ValueRef::Text(value) => {
                let text = String::from_utf8_lossy(value).into_owned();
                Value::String(text)
            }
            ValueRef::Blob(_) => Value::Null,
        };
        object.insert(name, value);
    }
    Ok(Value::Object(object))
}

pub(crate) fn row_to_json_public(row: &Row<'_>) -> rusqlite::Result<Value> {
    row_to_json(row)
}

fn is_boolean_column(name: &str) -> bool {
    matches!(
        name,
        "onboarding_completed"
            | "vat_registered"
            | "billable"
            | "reimbursable"
            | "track_stock"
            | "active"
            | "reversal"
            | "enabled"
    )
}

fn json_to_sql(value: &Value) -> AppResult<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(bool_to_i64(*value)),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                SqlValue::Integer(integer)
            } else if let Some(unsigned) = value.as_u64() {
                SqlValue::Integer(i64::try_from(unsigned).map_err(|_| {
                    AppError::Validation("Nombre entier trop grand pour SQLite.".into())
                })?)
            } else {
                SqlValue::Real(
                    value
                        .as_f64()
                        .ok_or_else(|| AppError::Validation("Nombre JSON invalide.".into()))?,
                )
            }
        }
        Value::String(value) => SqlValue::Text(value.clone()),
        Value::Array(_) | Value::Object(_) => SqlValue::Text(serde_json::to_string(value)?),
    })
}

fn normalize_json_object(value: Option<Value>) -> AppResult<String> {
    Ok(serde_json::to_string(&parsed_json_object(value)?)?)
}

fn parsed_json_object(value: Option<Value>) -> AppResult<Value> {
    let value = match value {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(Value::Object(object)) => Value::Object(object),
        Some(Value::String(text)) => serde_json::from_str(&text)?,
        Some(_) => {
            return Err(AppError::Validation(
                "extra_settings_json doit contenir un objet JSON.".into(),
            ))
        }
    };
    if !value.is_object() {
        return Err(AppError::Validation(
            "extra_settings_json doit contenir un objet JSON.".into(),
        ));
    }
    Ok(value)
}

fn explicit_start_number(
    explicit: Option<i64>,
    billing: Option<&Map<String, Value>>,
    key: &str,
) -> AppResult<i64> {
    let value = explicit
        .or_else(|| billing.and_then(|v| v.get(key)).and_then(Value::as_i64))
        .unwrap_or(1);
    if value <= 0 {
        return Err(AppError::Validation(format!(
            "{key} doit être strictement positif."
        )));
    }
    Ok(value)
}

fn required_text(value: &str, field: &str, max: usize) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::Validation(format!(
            "Le champ {field} est obligatoire."
        )));
    }
    if value.chars().count() > max {
        return Err(AppError::Validation(format!(
            "Le champ {field} dépasse {max} caractères."
        )));
    }
    Ok(value.to_owned())
}

fn clean_optional(value: Option<String>, max: usize) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(max).collect())
        }
    })
}

fn normalized_prefix(value: &str, fallback: &str) -> AppResult<String> {
    let value = if value.trim().is_empty() {
        fallback
    } else {
        value.trim()
    }
    .to_uppercase();
    if value.len() > 12
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(AppError::Validation(
            "Le préfixe doit contenir uniquement lettres, chiffres ou tirets (12 caractères max)."
                .into(),
        ));
    }
    Ok(value)
}

fn normalized_code(value: &str, field: &str, length: usize, fallback: &str) -> AppResult<String> {
    let value = if value.trim().is_empty() {
        fallback
    } else {
        value.trim()
    }
    .to_uppercase();
    if value.len() != length
        || !value
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return Err(AppError::Validation(format!(
            "{field} doit contenir exactement {length} lettres."
        )));
    }
    Ok(value)
}

fn normalized_date(value: &str, field: &str) -> AppResult<String> {
    NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d")
        .map(|date| date.format("%Y-%m-%d").to_string())
        .map_err(|_| AppError::Validation(format!("{field} doit être au format AAAA-MM-JJ.")))
}

fn add_days(value: &str, days: i64) -> AppResult<String> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::Validation("Date invalide.".into()))?;
    let days = u64::try_from(days)
        .map_err(|_| AppError::Validation("Le nombre de jours ne peut pas être négatif.".into()))?;
    date.checked_add_days(Days::new(days))
        .map(|value| value.format("%Y-%m-%d").to_string())
        .ok_or_else(|| AppError::Validation("La date calculée dépasse la plage autorisée.".into()))
}

pub(crate) fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn today() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

fn bool_to_i64(value: bool) -> i64 {
    i64::from(value)
}

fn open_path(path: &Path) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(path)
            .spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn()?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(path).spawn()?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(AppError::UnsupportedPlatform)
}
