use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

#[cfg(test)]
use std::collections::BTreeMap;

use chrono::{DateTime, Datelike, Days, Local, NaiveDate, Utc};
use rusqlite::{
    functions::FunctionFlags,
    params, params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection, OptionalExtension, Row, Transaction, TransactionBehavior,
};
use serde_json::{json, Map, Number, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    account_cloud::AccountProtectedCache,
    accounting::{
        cash_vat_invoice_is_consistent, ensure_accounting_date_open,
        payment_accounting_block_reason, post_expense_if_enabled, post_invoice_if_enabled,
        post_payment_if_enabled, validate_payment_for_accounting,
    },
    audit::{append_audit, verify_audit_chain},
    branding::stage_active_company_logo_for_snapshot,
    error::{AppError, AppResult},
    installation::load_or_create,
    license::LicenseProtectedCache,
    models::{
        AbandonInvoiceCorrectionInput, AppStateInfo, CompleteOnboardingResult, ConvertQuoteInput,
        CreateInvoiceCorrectionInput, DeleteResult, OnboardingInput, OnboardingIssue,
        OnboardingValidation, RecordPaymentInput, SaveDocumentWithItemsInput, TimerInput,
    },
    noga::validate_activity_profile,
    payroll::{
        explicit_settings_rate_issues, import_explicit_settings_rates, take_explicit_settings_rates,
    },
    reminders::cancel_settled_reminders,
    schema::{
        MIGRATION_V10_SQL, MIGRATION_V11_SQL, MIGRATION_V12_SQL, MIGRATION_V13_SQL,
        MIGRATION_V14_SQL, MIGRATION_V15_SQL, MIGRATION_V16_SQL, MIGRATION_V17_SQL,
        MIGRATION_V18_SQL, MIGRATION_V19_FINALIZE_SQL, MIGRATION_V19_SQL,
        MIGRATION_V20_REBUILD_STOCK_SQL, MIGRATION_V20_SQL, MIGRATION_V20_STOCK_TRIGGERS_SQL,
        MIGRATION_V21_REBUILD_STOCK_SQL, MIGRATION_V21_SQL, MIGRATION_V21_STOCK_TRIGGERS_SQL,
        MIGRATION_V22_SQL, MIGRATION_V23_SQL, MIGRATION_V24_SQL, MIGRATION_V25_SQL,
        MIGRATION_V26_SQL, MIGRATION_V27_SQL, MIGRATION_V28_SQL, MIGRATION_V29_SQL,
        MIGRATION_V2_SQL, MIGRATION_V30_SQL, MIGRATION_V31_SQL, MIGRATION_V32_SQL,
        MIGRATION_V33_SQL, MIGRATION_V34_SQL, MIGRATION_V35_SQL, MIGRATION_V36_SQL,
        MIGRATION_V37_SQL, MIGRATION_V38_SQL, MIGRATION_V39_SQL, MIGRATION_V3_SQL,
        MIGRATION_V40_SQL, MIGRATION_V41_SQL, MIGRATION_V42_SQL, MIGRATION_V43_SQL,
        MIGRATION_V4_SQL, MIGRATION_V5_SQL, MIGRATION_V6_SQL, MIGRATION_V7_SQL, MIGRATION_V8_SQL,
        MIGRATION_V9_SQL, SCHEMA_SQL, SCHEMA_VERSION,
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
    pub(crate) account_protected_cache: AccountProtectedCache,
    pub(crate) license_protected_cache: LicenseProtectedCache,
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
    payment_terms_days: i64,
    quote_validity_days: i64,
    default_hourly_rate_cents: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OnboardingValidationScope {
    Essential,
    Complete,
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

fn migrate_v20(transaction: &Transaction<'_>) -> AppResult<()> {
    let mut statement = transaction.prepare("PRAGMA table_info(settings)")?;
    let settings_columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    for (column, definition) in [
        (
            "sales_order_prefix",
            "sales_order_prefix TEXT NOT NULL DEFAULT 'C'",
        ),
        (
            "delivery_note_prefix",
            "delivery_note_prefix TEXT NOT NULL DEFAULT 'BL'",
        ),
        (
            "sales_order_start_number",
            "sales_order_start_number INTEGER NOT NULL DEFAULT 1 CHECK (sales_order_start_number>0)",
        ),
        (
            "delivery_note_start_number",
            "delivery_note_start_number INTEGER NOT NULL DEFAULT 1 CHECK (delivery_note_start_number>0)",
        ),
    ] {
        if !settings_columns.contains(column) {
            transaction.execute_batch(&format!(
                "ALTER TABLE settings ADD COLUMN {definition};"
            ))?;
        }
    }

    let mut statement = transaction.prepare("PRAGMA table_info(stock_movements)")?;
    let stock_columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    if !stock_columns.contains("delivery_note_line_id") {
        transaction.execute_batch(MIGRATION_V20_REBUILD_STOCK_SQL)?;
    }
    transaction.execute_batch(MIGRATION_V20_SQL)?;
    transaction.execute_batch(MIGRATION_V20_STOCK_TRIGGERS_SQL)?;
    Ok(())
}

fn migrate_v21(transaction: &Transaction<'_>) -> AppResult<()> {
    let settings_columns = {
        let mut statement = transaction.prepare("PRAGMA table_info(settings)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        columns
    };
    for (column, definition) in [
        (
            "supplier_order_prefix",
            "supplier_order_prefix TEXT NOT NULL DEFAULT 'CF'",
        ),
        (
            "supplier_receipt_prefix",
            "supplier_receipt_prefix TEXT NOT NULL DEFAULT 'RF'",
        ),
        (
            "supplier_credit_prefix",
            "supplier_credit_prefix TEXT NOT NULL DEFAULT 'AF'",
        ),
        (
            "supplier_order_start_number",
            "supplier_order_start_number INTEGER NOT NULL DEFAULT 1 CHECK (supplier_order_start_number>0)",
        ),
        (
            "supplier_receipt_start_number",
            "supplier_receipt_start_number INTEGER NOT NULL DEFAULT 1 CHECK (supplier_receipt_start_number>0)",
        ),
        (
            "supplier_credit_start_number",
            "supplier_credit_start_number INTEGER NOT NULL DEFAULT 1 CHECK (supplier_credit_start_number>0)",
        ),
    ] {
        if !settings_columns.contains(column) {
            transaction.execute_batch(&format!(
                "ALTER TABLE settings ADD COLUMN {definition};"
            ))?;
        }
    }

    let supplier_item_columns = {
        let mut statement = transaction.prepare("PRAGMA table_info(supplier_invoice_items)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        columns
    };
    if !supplier_item_columns.contains("posted_expense_account_id") {
        transaction.execute_batch(
            "ALTER TABLE supplier_invoice_items ADD COLUMN posted_expense_account_id TEXT REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT;",
        )?;
    }

    let supplier_invoice_columns = {
        let mut statement = transaction.prepare("PRAGMA table_info(supplier_invoices)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        columns
    };
    if !supplier_invoice_columns.contains("credited_cents") {
        transaction.execute_batch(
            "ALTER TABLE supplier_invoices ADD COLUMN credited_cents INTEGER NOT NULL DEFAULT 0 CHECK (credited_cents>=0);",
        )?;
    }

    transaction.execute_batch(MIGRATION_V21_SQL)?;

    let stock_columns = {
        let mut statement = transaction.prepare("PRAGMA table_info(stock_movements)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        columns
    };
    if !stock_columns.contains("supplier_receipt_line_id") {
        transaction.execute_batch(MIGRATION_V21_REBUILD_STOCK_SQL)?;
    }
    transaction.execute_batch(MIGRATION_V21_STOCK_TRIGGERS_SQL)?;
    Ok(())
}

fn migrate_v22(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V22_SQL)?;
    Ok(())
}

fn migrate_v23(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V23_SQL)?;
    Ok(())
}

fn migrate_v24(transaction: &Transaction<'_>) -> AppResult<()> {
    for (table, column, definition) in [
        ("reminder_settings", "last_scan_at", "last_scan_at TEXT"),
        (
            "reminder_templates",
            "payment_deadline_days",
            "payment_deadline_days INTEGER NOT NULL DEFAULT 10 CHECK (payment_deadline_days BETWEEN 1 AND 90)",
        ),
        (
            "reminders",
            "payment_deadline_days",
            "payment_deadline_days INTEGER NOT NULL DEFAULT 10 CHECK (payment_deadline_days BETWEEN 1 AND 90)",
        ),
    ] {
        let columns = {
            let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<HashSet<_>, _>>()?;
            columns
        };
        if !columns.contains(column) {
            transaction.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {definition};"
            ))?;
        }
    }

    // V23 stored the already-rendered subject and body on each reminder. Freeze
    // the source template while it is still available so V24 can safely render
    // a fresh balance and payment deadline after a partial payment. An orphaned
    // legacy reminder gets a conservative neutral template instead of reusing a
    // stale amount embedded in its rendered body.
    let legacy_reminders = {
        let mut statement = transaction.prepare(
            r#"SELECT r.id,r.status,r.snapshot_json,t.subject,t.body,t.days_after_due,
                      r.scheduled_date,i.due_date
                 FROM reminders r
                 JOIN invoices i ON i.id=r.invoice_id
                 LEFT JOIN reminder_templates t ON t.id=r.template_id
                WHERE r.status IN ('planned','due','completed')"#,
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (
        id,
        status,
        raw_snapshot,
        subject,
        body,
        template_days_after_due,
        scheduled_date,
        invoice_due_date,
    ) in legacy_reminders
    {
        let mut snapshot = serde_json::from_str::<Value>(&raw_snapshot)
            .unwrap_or_else(|_| json!({ "legacy_snapshot_json": raw_snapshot }));
        if !snapshot.is_object() {
            snapshot = json!({ "legacy_snapshot": snapshot });
        }
        let object = snapshot
            .as_object_mut()
            .ok_or_else(|| AppError::Validation("Snapshot de relance invalide.".into()))?;
        if matches!(status.as_str(), "planned" | "due") {
            object.entry("template_subject").or_insert_with(|| {
                Value::String(
                    subject.unwrap_or_else(|| "Relance · facture {invoice_number}".into()),
                )
            });
            object.entry("template_body").or_insert_with(|| {
                Value::String(body.unwrap_or_else(|| {
                    "Bonjour {client_name},\n\nLe solde de {balance} relatif à la facture {invoice_number}, échue le {due_date}, reste ouvert. Merci d’effectuer le règlement d’ici au {payment_deadline} ou de nous contacter.\n\nAvec nos salutations,\n{sender_name}".into()
                }))
            });
            object
                .entry("template_recovered_during_v24_migration")
                .or_insert(Value::Bool(true));
            if let Some(days_after_due) = template_days_after_due {
                object
                    .entry("days_after_due")
                    .or_insert_with(|| Value::Number(days_after_due.into()));
            }
        } else if status == "completed" && !object.contains_key("days_after_due") {
            let parse_legacy_date = |value: &str| {
                NaiveDate::parse_from_str(value, "%Y-%m-%d")
                    .ok()
                    .filter(|date| date.format("%Y-%m-%d").to_string() == value)
            };
            let recovered_delay = invoice_due_date
                .as_deref()
                .and_then(|due_date| {
                    Some((
                        parse_legacy_date(due_date)?,
                        parse_legacy_date(&scheduled_date)?,
                    ))
                })
                .and_then(|(due_date, scheduled_date)| {
                    let days = (scheduled_date - due_date).num_days();
                    (days >= 0).then_some(days)
                });
            if let Some(days_after_due) = recovered_delay {
                object.insert(
                    "days_after_due".into(),
                    Value::Number(days_after_due.into()),
                );
                object.insert(
                    "days_after_due_recovered_from_schedule_v24".into(),
                    Value::Bool(true),
                );
            } else {
                object.insert("historical_delay_review_required".into(), Value::Bool(true));
            }
        }
        object
            .entry("payment_deadline_days")
            .or_insert_with(|| Value::Number(10.into()));
        transaction.execute(
            "UPDATE reminders SET snapshot_json=? WHERE id=?",
            params![serde_json::to_string(&snapshot)?, id],
        )?;
    }
    transaction.execute_batch(MIGRATION_V24_SQL)?;
    Ok(())
}

fn migrate_v25(transaction: &Transaction<'_>) -> AppResult<()> {
    let columns = {
        let mut statement = transaction.prepare("PRAGMA table_info(payroll_document_imports)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        columns
    };
    if !columns.contains("analysis_manifest_json") {
        transaction.execute_batch(
            "ALTER TABLE payroll_document_imports ADD COLUMN analysis_manifest_json TEXT CHECK (
                analysis_manifest_json IS NULL OR (
                    LENGTH(analysis_manifest_json) BETWEEN 2 AND 1000000
                    AND json_valid(analysis_manifest_json)=1
                )
            );",
        )?;
    }
    transaction.execute_batch(MIGRATION_V25_SQL)?;
    Ok(())
}

fn add_column_if_missing(
    transaction: &Transaction<'_>,
    table: &str,
    column: &str,
    definition: &str,
) -> AppResult<()> {
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    if !columns.contains(column) {
        transaction.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {definition};"))?;
    }
    Ok(())
}

fn migrate_v26(transaction: &Transaction<'_>) -> AppResult<()> {
    for (table, column, definition) in [
        (
            "payroll_document_imports",
            "human_review_attestation_version",
            "human_review_attestation_version TEXT",
        ),
        (
            "payroll_document_imports",
            "human_review_attested_at",
            "human_review_attested_at TEXT",
        ),
        (
            "payroll_document_imports",
            "confirmation_evidence_sha256",
            "confirmation_evidence_sha256 TEXT CHECK (confirmation_evidence_sha256 IS NULL OR (LENGTH(confirmation_evidence_sha256)=64 AND confirmation_evidence_sha256 NOT GLOB '*[^0-9a-f]*'))",
        ),
        (
            "payslips",
            "source_payroll_import_id",
            "source_payroll_import_id TEXT REFERENCES payroll_document_imports(id) ON UPDATE CASCADE ON DELETE RESTRICT",
        ),
        (
            "payslips",
            "source_import_evidence_json",
            "source_import_evidence_json TEXT CHECK (source_import_evidence_json IS NULL OR (LENGTH(source_import_evidence_json) BETWEEN 2 AND 1000000 AND json_valid(source_import_evidence_json)=1))",
        ),
        (
            "payslips",
            "source_import_evidence_sha256",
            "source_import_evidence_sha256 TEXT CHECK (source_import_evidence_sha256 IS NULL OR (LENGTH(source_import_evidence_sha256)=64 AND source_import_evidence_sha256 NOT GLOB '*[^0-9a-f]*'))",
        ),
        (
            "vat_adjustments",
            "request_id",
            "request_id TEXT CHECK (request_id IS NULL OR LENGTH(request_id)=36)",
        ),
        (
            "vat_adjustments",
            "request_sha256",
            "request_sha256 TEXT CHECK (request_sha256 IS NULL OR (LENGTH(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'))",
        ),
        (
            "vat_adjustments",
            "request_json",
            "request_json TEXT CHECK (request_json IS NULL OR (LENGTH(request_json) BETWEEN 2 AND 20000 AND json_valid(request_json)=1))",
        ),
        (
            "accounting_settings",
            "vat_deferred_payable_account_id",
            "vat_deferred_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT",
        ),
    ] {
        add_column_if_missing(transaction, table, column, definition)?;
    }
    transaction.execute_batch(MIGRATION_V26_SQL)?;
    Ok(())
}

fn migrate_v27(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V27_SQL)?;
    Ok(())
}

fn migrate_v28(transaction: &Transaction<'_>) -> AppResult<()> {
    for (table, column, definition) in [
        (
            "employees",
            "employment_contract_kind",
            "employment_contract_kind TEXT CHECK (employment_contract_kind IS NULL OR employment_contract_kind IN ('indefinite','fixed'))",
        ),
        (
            "employees",
            "lpp_assessment_year",
            "lpp_assessment_year INTEGER CHECK (lpp_assessment_year IS NULL OR lpp_assessment_year BETWEEN 1900 AND 9999)",
        ),
        (
            "employees",
            "lpp_annual_salary_cents",
            "lpp_annual_salary_cents INTEGER CHECK (lpp_annual_salary_cents IS NULL OR lpp_annual_salary_cents >= 0)",
        ),
        (
            "employees",
            "lpp_exception_code",
            "lpp_exception_code TEXT CHECK (lpp_exception_code IS NULL OR lpp_exception_code IN ('short_fixed_contract','other_legal'))",
        ),
        (
            "employees",
            "lpp_exception_evidence_reference",
            "lpp_exception_evidence_reference TEXT CHECK (lpp_exception_evidence_reference IS NULL OR LENGTH(TRIM(lpp_exception_evidence_reference)) BETWEEN 1 AND 500)",
        ),
        (
            "payroll_contribution_definitions",
            "lpp_component",
            "lpp_component TEXT CHECK (lpp_component IS NULL OR lpp_component IN ('risk','savings','combined'))",
        ),
        (
            "payroll_contribution_definitions",
            "lpp_employee_id",
            "lpp_employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT",
        ),
        (
            "payslip_contributions",
            "lpp_component",
            "lpp_component TEXT CHECK (lpp_component IS NULL OR lpp_component IN ('risk','savings','combined'))",
        ),
        (
            "payslip_contributions",
            "lpp_employee_id",
            "lpp_employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT",
        ),
    ] {
        add_column_if_missing(transaction, table, column, definition)?;
    }
    transaction.execute_batch(MIGRATION_V28_SQL)?;
    Ok(())
}

fn migrate_v29(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V29_SQL)?;
    Ok(())
}

fn migrate_v30(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V30_SQL)?;
    Ok(())
}

fn migrate_v31(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V31_SQL)?;
    Ok(())
}

fn migrate_v32(transaction: &Transaction<'_>) -> AppResult<()> {
    for (table, column, definition) in [
        (
            "employees",
            "laa_opening_year",
            "laa_opening_year INTEGER CHECK (laa_opening_year IS NULL OR laa_opening_year BETWEEN 1900 AND 9999)",
        ),
        (
            "employees",
            "laa_opening_basis_cents",
            "laa_opening_basis_cents INTEGER CHECK (laa_opening_basis_cents IS NULL OR laa_opening_basis_cents >= 0)",
        ),
    ] {
        add_column_if_missing(transaction, table, column, definition)?;
    }
    transaction.execute_batch(MIGRATION_V32_SQL)?;
    Ok(())
}

fn migrate_v33(transaction: &Transaction<'_>) -> AppResult<()> {
    let invalid_period_dates: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM accounting_periods
         WHERE LENGTH(date_from)<>10
            OR date_from NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
            OR DATE(date_from) IS NULL OR DATE(date_from)<>date_from
            OR LENGTH(date_to)<>10
            OR date_to NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
            OR DATE(date_to) IS NULL OR DATE(date_to)<>date_to",
        [],
        |row| row.get(0),
    )?;
    if invalid_period_dates != 0 {
        return Err(AppError::Validation(format!(
            "Migration V33 bloquée : {invalid_period_dates} période(s) comptable(s) utilisent une date non canonique. Corrigez-les au format AAAA-MM-JJ avant d'établir la frontière cumulative de clôture."
        )));
    }
    transaction.execute_batch(MIGRATION_V33_SQL)?;
    Ok(())
}

fn migrate_v34(transaction: &Transaction<'_>) -> AppResult<()> {
    for (column, definition) in [
        (
            "small_salary_assessment_year",
            "small_salary_assessment_year INTEGER CHECK (small_salary_assessment_year IS NULL OR small_salary_assessment_year BETWEEN 1900 AND 9999)",
        ),
        (
            "small_salary_decision_date",
            "small_salary_decision_date TEXT CHECK (small_salary_decision_date IS NULL OR (LENGTH(small_salary_decision_date)=10 AND small_salary_decision_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND DATE(small_salary_decision_date) IS NOT NULL AND DATE(small_salary_decision_date)=small_salary_decision_date))",
        ),
        (
            "small_salary_sector",
            "small_salary_sector TEXT CHECK (small_salary_sector IS NULL OR small_salary_sector IN ('ordinary','private_household','arts_culture'))",
        ),
        (
            "small_salary_employee_requested_contributions",
            "small_salary_employee_requested_contributions INTEGER CHECK (small_salary_employee_requested_contributions IS NULL OR small_salary_employee_requested_contributions IN (0,1))",
        ),
        (
            "small_salary_opening_gross_cents",
            "small_salary_opening_gross_cents INTEGER CHECK (small_salary_opening_gross_cents IS NULL OR small_salary_opening_gross_cents >= 0)",
        ),
        (
            "small_salary_opening_contributed_basis_cents",
            "small_salary_opening_contributed_basis_cents INTEGER CHECK (small_salary_opening_contributed_basis_cents IS NULL OR small_salary_opening_contributed_basis_cents >= 0)",
        ),
        (
            "small_salary_evidence_reference",
            "small_salary_evidence_reference TEXT CHECK (small_salary_evidence_reference IS NULL OR LENGTH(TRIM(small_salary_evidence_reference)) BETWEEN 1 AND 500)",
        ),
    ] {
        add_column_if_missing(transaction, "employees", column, definition)?;
    }
    transaction.execute_batch(MIGRATION_V34_SQL)?;
    Ok(())
}

fn migrate_v35(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V35_SQL)?;
    Ok(())
}

fn migrate_v36(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V36_SQL)?;
    Ok(())
}

fn migrate_v37(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V37_SQL)?;
    Ok(())
}

fn migrate_v38(transaction: &Transaction<'_>) -> AppResult<()> {
    let mut statement = transaction.prepare("PRAGMA table_info(license_state)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    if columns.is_empty() {
        // Certaines bases historiques partielles (notamment des installations
        // interrompues avant l'activation) ne possèdent encore aucune ligne ni
        // table de licence. Elles restent légitimement sans licence après la
        // migration, mais reçoivent le schéma V38 afin de démarrer en lecture
        // seule au lieu de rendre toute la base inutilisable.
        transaction.execute_batch(
            "CREATE TABLE license_state (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               token_sha256 TEXT NOT NULL CHECK (
                 LENGTH(token_sha256)=64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'
               ),
               license_id TEXT NOT NULL,
               customer_name TEXT,
               plan TEXT NOT NULL,
               price_chf_cents INTEGER NOT NULL,
               issued_at TEXT NOT NULL,
               valid_from TEXT NOT NULL,
               valid_until TEXT NOT NULL,
               verified_at TEXT NOT NULL,
               last_seen_date TEXT NOT NULL,
               clock_anchor_version INTEGER NOT NULL DEFAULT 0
                 CHECK (clock_anchor_version IN (0, 1))
             );
             PRAGMA user_version=38;",
        )?;
        return Ok(());
    }
    if columns.iter().any(|column| column == "token_sha256")
        && !columns.iter().any(|column| column == "token")
    {
        transaction.pragma_update(None, "user_version", 38)?;
        return Ok(());
    }
    if !columns.iter().any(|column| column == "token") {
        return Err(AppError::Validation(
            "La table de licence historique a une structure inconnue; la migration est arrêtée sans modifier les données."
                .into(),
        ));
    }
    transaction.execute_batch(MIGRATION_V38_SQL)?;
    Ok(())
}

fn migrate_v39(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(MIGRATION_V39_SQL)?;
    Ok(())
}

fn migrate_v40(transaction: &Transaction<'_>) -> AppResult<()> {
    let invoices_exist: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='invoices')",
        [],
        |row| row.get(0),
    )?;
    if !invoices_exist {
        // Certaines fixtures et quelques bases d'installation interrompues ne
        // possèdent pas encore le module ventes. Leur migration doit rester
        // additive sans inventer une table métier partielle.
        transaction.pragma_update(None, "user_version", 40)?;
        return Ok(());
    }
    add_column_if_missing(
        transaction,
        "invoices",
        "deposit_percentage_bp",
        "deposit_percentage_bp INTEGER CHECK (deposit_percentage_bp IS NULL OR (TYPEOF(deposit_percentage_bp)='integer' AND deposit_percentage_bp BETWEEN 1 AND 10000))",
    )?;
    transaction.execute_batch(MIGRATION_V40_SQL)?;
    Ok(())
}

fn migrate_v41(transaction: &Transaction<'_>) -> AppResult<()> {
    let invoices_exist: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='invoices')",
        [],
        |row| row.get(0),
    )?;
    if !invoices_exist {
        transaction.pragma_update(None, "user_version", 41)?;
        return Ok(());
    }
    add_column_if_missing(
        transaction,
        "invoices",
        "deposit_basis_json",
        "deposit_basis_json TEXT CHECK (deposit_basis_json IS NULL OR (json_valid(deposit_basis_json)=1 AND json_type(deposit_basis_json)='array'))",
    )?;
    transaction.execute_batch(MIGRATION_V41_SQL)?;
    Ok(())
}

fn migrate_v42(transaction: &Transaction<'_>) -> AppResult<()> {
    let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='vat_source_classifications')", [], |row| row.get(0))?;
    if !exists {
        transaction.pragma_update(None, "user_version", 42)?;
        return Ok(());
    }
    add_column_if_missing(
        transaction,
        "supplier_credit_note_items",
        "posted_expense_account_id",
        "posted_expense_account_id TEXT REFERENCES accounts(id)",
    )?;
    transaction.execute_batch(MIGRATION_V42_SQL)?;
    Ok(())
}

fn migrate_v43(transaction: &Transaction<'_>) -> AppResult<()> {
    let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='supplier_credit_allocations')", [], |row| row.get(0))?;
    if !exists {
        transaction.pragma_update(None, "user_version", 43)?;
        return Ok(());
    }
    // An old creation timestamp is not evidence of the effective settlement date.
    // Keep historical rows undated; all new allocations must carry an explicit date.
    add_column_if_missing(
        transaction,
        "supplier_credit_allocations",
        "effective_date",
        "effective_date TEXT",
    )?;
    transaction.execute_batch(MIGRATION_V43_SQL)?;
    Ok(())
}

fn migrate_v44(transaction: &Transaction<'_>) -> AppResult<()> {
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='bank_movements')",
        [],
        |row| row.get(0),
    )?;
    // Like the earlier domain migrations, retain support for isolated legacy module stores.
    if !exists {
        transaction.pragma_update(None, "user_version", 44)?;
        return Ok(());
    }
    transaction.execute_batch(crate::schema::MIGRATION_V44_SQL)?;
    Ok(())
}

fn migrate_v45(transaction: &Transaction<'_>) -> AppResult<()> {
    let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='bank_expense_reconciliations')", [], |row| row.get(0))?;
    if exists {
        transaction.execute_batch(crate::schema::MIGRATION_V45_SQL)?;
    } else {
        transaction.pragma_update(None, "user_version", 45)?;
    }
    Ok(())
}

fn migrate_v46(transaction: &Transaction<'_>) -> AppResult<()> {
    let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='bank_expense_reconciliations')", [], |row| row.get(0))?;
    if exists { transaction.execute_batch(crate::schema::MIGRATION_V46_SQL)?; }
    else { transaction.pragma_update(None, "user_version", 46)?; }
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

fn prepare_onboarding(
    input: OnboardingInput,
    scope: OnboardingValidationScope,
) -> Result<PreparedOnboarding, Vec<OnboardingIssue>> {
    let essential = scope == OnboardingValidationScope::Essential;
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
    if let Some(extra) = extra_value.as_object_mut() {
        extra.insert(
            "setupDeferred".into(),
            json!({
                "billing": essential,
                "work": essential,
                "backup": essential,
            }),
        );
    }
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
        (true, None | Some(0)) if essential => 0,
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
    let raw_iban = input.iban.as_deref().unwrap_or("").trim();
    let iban = if raw_iban.is_empty() {
        // Les coordonnées bancaires peuvent être complétées après le premier
        // lancement. Toute valeur effectivement fournie reste validée avant la
        // transaction, et les flux qui exigent un IBAN restent fail-closed.
        if !essential {
            issues.push(onboarding_issue(
                2,
                "billing.iban",
                "L’IBAN",
                "L’IBAN ou le QR-IBAN est obligatoire pour la configuration complète.".into(),
            ));
        }
        String::new()
    } else {
        match normalize_and_validate_iban(raw_iban) {
            Ok(value) => value,
            Err(error) => {
                issues.push(onboarding_issue(
                    2,
                    "billing.iban",
                    "L’IBAN",
                    validation_message(error),
                ));
                String::new()
            }
        }
    };
    let payment_terms_days = if (1..=365).contains(&input.payment_terms_days) {
        input.payment_terms_days
    } else {
        issues.push(onboarding_issue(
            2,
            "billing.paymentTermsDays",
            "Le délai de paiement",
            "Le délai de paiement doit être compris entre 1 et 365 jours.".into(),
        ));
        30
    };
    let quote_validity_days = if (1..=365).contains(&input.quote_validity_days) {
        input.quote_validity_days
    } else {
        issues.push(onboarding_issue(
            2,
            "billing.quoteValidityDays",
            "La validité des devis",
            "La validité des devis doit être comprise entre 1 et 365 jours.".into(),
        ));
        30
    };
    let default_hourly_rate_cents = if input.default_hourly_rate_cents >= 0 {
        input.default_hourly_rate_cents
    } else {
        issues.push(onboarding_issue(
            3,
            "work.defaultHourlyRateCents",
            "Le coût horaire par défaut",
            "default_hourly_rate_cents ne peut pas être négatif.".into(),
        ));
        0
    };
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
        payment_terms_days,
        quote_validity_days,
        default_hourly_rate_cents,
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
            account_protected_cache: AccountProtectedCache::default(),
            license_protected_cache: LicenseProtectedCache::default(),
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
        connection.create_scalar_function(
            "zentra_sha256",
            1,
            FunctionFlags::SQLITE_UTF8
                | FunctionFlags::SQLITE_DETERMINISTIC
                | FunctionFlags::SQLITE_INNOCUOUS,
            |context| {
                let value = context.get::<String>(0)?;
                Ok(format!("{:x}", Sha256::digest(value.as_bytes())))
            },
        )?;
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
        let moves_plaintext_license = current != 0 && current < 38;
        if moves_plaintext_license {
            // Le coffre doit être durable avant que la transaction ne retire le
            // jeton de SQLite. En cas d'arrêt entre les deux, la base v37 reste
            // intacte et la migration peut être rejouée sans perte.
            self.stage_legacy_license_token_migration(&connection)?;
            connection.execute_batch(
                "PRAGMA wal_checkpoint(TRUNCATE);
                 PRAGMA secure_delete=ON;",
            )?;
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        match current {
            0 => {
                transaction.execute_batch(SCHEMA_SQL)?;
                migrate_v20(&transaction)?;
                migrate_v21(&transaction)?;
                migrate_v22(&transaction)?;
                migrate_v23(&transaction)?;
                migrate_v24(&transaction)?;
                migrate_v25(&transaction)?;
                migrate_v26(&transaction)?;
                migrate_v27(&transaction)?;
                migrate_v28(&transaction)?;
            }
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
            12..=23 => {}
            24 => {
                migrate_v25(&transaction)?;
                migrate_v26(&transaction)?;
                migrate_v27(&transaction)?;
                migrate_v28(&transaction)?;
            }
            25 => {
                migrate_v26(&transaction)?;
                migrate_v27(&transaction)?;
                migrate_v28(&transaction)?;
            }
            26 => {
                migrate_v27(&transaction)?;
                migrate_v28(&transaction)?;
            }
            27 => migrate_v28(&transaction)?,
            28..=48 => {}
            _ => {
                return Err(AppError::Validation(format!(
                    "Migration locale non prise en charge depuis la version {current}."
                )))
            }
        }
        if current != 0 && current < 13 {
            migrate_v13(&transaction)?;
        }
        if current != 0 && current < 24 {
            migrate_v14(&transaction)?;
            migrate_v15(&transaction)?;
            migrate_v16(&transaction)?;
            migrate_v17(&transaction)?;
            migrate_v18(&transaction)?;
            migrate_v19(&transaction)?;
            migrate_v20(&transaction)?;
            migrate_v21(&transaction)?;
            migrate_v22(&transaction)?;
            migrate_v23(&transaction)?;
            migrate_v24(&transaction)?;
            migrate_v25(&transaction)?;
            migrate_v26(&transaction)?;
            migrate_v27(&transaction)?;
            migrate_v28(&transaction)?;
        }
        if current < 29 {
            migrate_v29(&transaction)?;
        }
        if current < 30 {
            migrate_v30(&transaction)?;
        }
        if current < 31 {
            migrate_v31(&transaction)?;
        }
        if current < 32 {
            migrate_v32(&transaction)?;
        }
        if current < 33 {
            migrate_v33(&transaction)?;
        }
        if current < 34 {
            migrate_v34(&transaction)?;
        }
        if current < 35 {
            migrate_v35(&transaction)?;
        }
        if current < 36 {
            migrate_v36(&transaction)?;
        }
        if current < 37 {
            migrate_v37(&transaction)?;
        }
        if current < 38 {
            migrate_v38(&transaction)?;
        }
        if current < 39 {
            migrate_v39(&transaction)?;
        }
        if current < 40 {
            migrate_v40(&transaction)?;
        }
        if current < 41 {
            migrate_v41(&transaction)?;
        }
        if current < 42 {
            migrate_v42(&transaction)?;
        }
        if current < 43 {
            migrate_v43(&transaction)?;
        }
        if current < 44 {
            migrate_v44(&transaction)?;
        }
        if current < 45 {
            migrate_v45(&transaction)?;
        }
        if current < 46 { migrate_v46(&transaction)?; }
        if current < 47 {
            let complete: bool = transaction.query_row("SELECT COUNT(*)=2 FROM sqlite_master WHERE type='table' AND name IN ('expenses','vat_source_classifications')", [], |row| row.get(0))?;
            if complete { transaction.execute_batch(crate::schema::MIGRATION_V47_SQL)?; }
            else { transaction.pragma_update(None,"user_version",47)?; }
        }
        if current < 48 {
            let complete: bool = transaction.query_row("SELECT COUNT(*)=2 FROM sqlite_master WHERE type='table' AND name IN ('expense_refunds','bank_movements')", [], |row| row.get(0))?;
            if complete { transaction.execute_batch(crate::schema::MIGRATION_V48_SQL)?; }
            else { transaction.pragma_update(None,"user_version",48)?; }
        }
        if current < 49 {
            let complete: bool = transaction.query_row("SELECT COUNT(*)=2 FROM sqlite_master WHERE type='table' AND name IN ('expense_refunds','attachments')", [], |row| row.get(0))?;
            if complete { transaction.execute_batch(crate::schema::MIGRATION_V49_SQL)?; }
            else { transaction.pragma_update(None,"user_version",49)?; }
        }
        transaction.commit()?;
        if moves_plaintext_license {
            // Le rebuild a exécuté secure_delete; le checkpoint puis VACUUM
            // retirent également les anciennes pages libres et le WAL.
            connection.execute_batch(
                "PRAGMA wal_checkpoint(TRUNCATE);
                 VACUUM;
                 PRAGMA wal_checkpoint(TRUNCATE);",
            )?;
        }
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
        self.validate_onboarding_scoped(input, OnboardingValidationScope::Complete)
    }

    pub(crate) fn validate_onboarding_scoped(
        &self,
        input: OnboardingInput,
        scope: OnboardingValidationScope,
    ) -> OnboardingValidation {
        let logo_path = input.logo_path.clone();
        let mut issues = prepare_onboarding(input, scope).err().unwrap_or_default();
        if let Err(error) = self.validate_company_logo_source(logo_path.as_deref()) {
            issues.push(onboarding_issue(
                1,
                "organization.logoPath",
                "Le logo de l'entreprise",
                validation_message(error),
            ));
        }
        OnboardingValidation {
            valid: issues.is_empty(),
            issues,
        }
    }

    pub fn complete_onboarding(
        &self,
        input: OnboardingInput,
        app_version: &str,
    ) -> AppResult<CompleteOnboardingResult> {
        self.complete_onboarding_scoped(input, app_version, OnboardingValidationScope::Complete)
    }

    pub(crate) fn complete_onboarding_scoped(
        &self,
        mut input: OnboardingInput,
        app_version: &str,
        scope: OnboardingValidationScope,
    ) -> AppResult<CompleteOnboardingResult> {
        let stored_logo = self.store_company_logo_reference(input.logo_path.as_deref())?;
        input.logo_path = stored_logo;
        let prepared = prepare_onboarding(input, scope).map_err(|issues| {
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
            payment_terms_days,
            quote_validity_days,
            default_hourly_rate_cents,
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
                payment_terms_days,
                quote_validity_days,
                default_hourly_rate_cents,
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
        let agenda_events = query_all(
            connection,
            "SELECT * FROM agenda_events ORDER BY start_date,start_time,title COLLATE NOCASE,created_at",
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
        let invoice_correction_workflows = query_all(
            connection,
            "SELECT * FROM invoice_correction_workflows ORDER BY created_at DESC,id",
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
                    source_type,invoice_id,invoice_item_id,delivery_note_id,delivery_note_line_id,
                    supplier_receipt_id,supplier_receipt_line_id,
                    reverses_stock_movement_id,created_at
             FROM stock_movements ORDER BY sequence DESC",
            [],
        )?;
        let sales_orders = query_all(
            connection,
            "SELECT * FROM sales_orders ORDER BY order_date DESC,created_at DESC",
            [],
        )?;
        let sales_order_lines = query_all(
            connection,
            "SELECT line.*,
                    COALESCE((SELECT SUM(cancelled.quantity_milli) FROM sales_order_cancellation_lines cancelled WHERE cancelled.sales_order_line_id=line.id),0) AS cancelled_quantity_milli,
                    COALESCE((SELECT SUM(delivery.quantity_milli) FROM delivery_note_lines delivery JOIN delivery_notes note ON note.id=delivery.delivery_note_id WHERE delivery.sales_order_line_id=line.id AND note.status='issued'),0) AS delivered_quantity_milli,
                    COALESCE((SELECT SUM(allocation.quantity_milli) FROM sales_order_invoice_allocations allocation WHERE allocation.sales_order_line_id=line.id),0) AS invoiced_quantity_milli,
                    COALESCE((SELECT SUM(event.quantity_delta_milli) FROM stock_reservation_events event WHERE event.sales_order_line_id=line.id),0) AS reserved_quantity_milli
             FROM sales_order_lines line ORDER BY line.sales_order_id,line.position,line.created_at",
            [],
        )?;
        let sales_order_cancellation_lines = query_all(
            connection,
            "SELECT * FROM sales_order_cancellation_lines ORDER BY created_at,rowid",
            [],
        )?;
        let delivery_notes = query_all(
            connection,
            "SELECT * FROM delivery_notes ORDER BY delivery_date DESC,created_at DESC",
            [],
        )?;
        let delivery_note_lines = query_all(
            connection,
            "SELECT * FROM delivery_note_lines ORDER BY delivery_note_id,position,created_at",
            [],
        )?;
        let stock_reservation_events = query_all(
            connection,
            "SELECT * FROM stock_reservation_events ORDER BY sequence DESC",
            [],
        )?;
        let sales_order_invoice_batches = query_all(
            connection,
            "SELECT * FROM sales_order_invoice_batches ORDER BY created_at DESC",
            [],
        )?;
        let sales_order_invoice_allocations = query_all(
            connection,
            "SELECT * FROM sales_order_invoice_allocations ORDER BY batch_id,rowid",
            [],
        )?;
        let recurrence_schedules = query_all(
            connection,
            "SELECT id,source_sales_order_id,frequency,anchor_date,anchor_day,
                    anchor_is_month_end,payment_terms_days,next_scheduled_for,end_date,
                    status,review_reason,source_order_snapshot_sha256,
                    source_snapshot_sha256,completed_at,created_at,updated_at
             FROM recurrence_schedules ORDER BY created_at DESC,id",
            [],
        )?;
        let recurrence_occurrences = query_all(
            connection,
            "SELECT occurrence.*,invoice.status AS invoice_status,invoice.number AS invoice_number
             FROM recurrence_occurrences occurrence
             JOIN invoices invoice ON invoice.id=occurrence.invoice_id
             ORDER BY occurrence.scheduled_for DESC,occurrence.sequence DESC",
            [],
        )?;
        let stock_availability = query_all(
            connection,
            "SELECT item.id AS catalog_item_id,item.stock_quantity_milli AS on_hand_milli,
                    COALESCE(SUM(event.quantity_delta_milli),0) AS reserved_milli,
                    item.stock_quantity_milli-COALESCE(SUM(event.quantity_delta_milli),0) AS available_milli
             FROM catalog_items item
             LEFT JOIN stock_reservation_events event ON event.catalog_item_id=item.id
             WHERE item.track_stock=1
             GROUP BY item.id,item.stock_quantity_milli
             ORDER BY item.name COLLATE NOCASE,item.id",
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
        let mut expenses = query_all(
            connection,
            "SELECT * FROM expenses ORDER BY date DESC, created_at DESC",
            [],
        )?;
        crate::purchase_costs::enrich(connection, "expense", &mut expenses)?;
        let supplier_invoices = query_all(
            connection,
            "SELECT invoice.*,
                    MAX(0,invoice.total_cents-invoice.paid_cents-invoice.credited_cents) AS balance_cents,
                    CASE
                      WHEN EXISTS(
                        SELECT 1 FROM supplier_invoice_matches match_row
                        JOIN supplier_order_lines order_line ON order_line.id=match_row.supplier_order_line_id
                        LEFT JOIN supplier_receipt_lines receipt_line ON receipt_line.id=match_row.supplier_receipt_line_id
                        LEFT JOIN supplier_receipts receipt ON receipt.id=receipt_line.supplier_receipt_id
                        WHERE match_row.supplier_invoice_id=invoice.id AND (
                          (match_row.supplier_receipt_line_id IS NOT NULL AND (receipt.id IS NULL OR receipt.status<>'issued'))
                          OR ABS(match_row.net_cents-CAST(ROUND(CAST(order_line.line_net_cents AS REAL)*CAST(match_row.quantity_milli AS REAL)/CAST(order_line.quantity_milli AS REAL)) AS INTEGER))>1
                          OR ABS(match_row.vat_cents-CAST(ROUND(CAST(order_line.line_vat_cents AS REAL)*CAST(match_row.quantity_milli AS REAL)/CAST(order_line.quantity_milli AS REAL)) AS INTEGER))>1
                          OR ABS(match_row.total_cents-CAST(ROUND(CAST(order_line.line_total_cents AS REAL)*CAST(match_row.quantity_milli AS REAL)/CAST(order_line.quantity_milli AS REAL)) AS INTEGER))>1
                        )
                      ) OR EXISTS(
                        SELECT 1 FROM supplier_invoice_matches match_row
                        JOIN supplier_order_lines order_line ON order_line.id=match_row.supplier_order_line_id
                        WHERE match_row.supplier_invoice_id=invoice.id
                        GROUP BY match_row.supplier_invoice_id
                        HAVING ABS(SUM(match_row.net_cents)-SUM(CAST(ROUND(CAST(order_line.line_net_cents AS REAL)*CAST(match_row.quantity_milli AS REAL)/CAST(order_line.quantity_milli AS REAL)) AS INTEGER)))>1
                          OR ABS(SUM(match_row.vat_cents)-SUM(CAST(ROUND(CAST(order_line.line_vat_cents AS REAL)*CAST(match_row.quantity_milli AS REAL)/CAST(order_line.quantity_milli AS REAL)) AS INTEGER)))>1
                          OR ABS(SUM(match_row.total_cents)-SUM(CAST(ROUND(CAST(order_line.line_total_cents AS REAL)*CAST(match_row.quantity_milli AS REAL)/CAST(order_line.quantity_milli AS REAL)) AS INTEGER)))>1
                      ) THEN 'mismatch'
                      WHEN COALESCE((SELECT SUM(match_row.quantity_milli) FROM supplier_invoice_matches match_row WHERE match_row.supplier_invoice_id=invoice.id),0)=0 THEN 'unmatched'
                      WHEN COALESCE((SELECT SUM(match_row.quantity_milli) FROM supplier_invoice_matches match_row WHERE match_row.supplier_invoice_id=invoice.id),0)
                           >=COALESCE((SELECT SUM(item.quantity_milli) FROM supplier_invoice_items item WHERE item.supplier_invoice_id=invoice.id),0) THEN 'matched'
                      ELSE 'partial'
                    END AS match_status
             FROM supplier_invoices invoice ORDER BY invoice.document_date DESC, invoice.created_at DESC",
            [],
        )?;
        let mut supplier_invoice_items = query_all(
            connection,
            "SELECT * FROM supplier_invoice_items ORDER BY supplier_invoice_id,position,rowid",
            [],
        )?;
        crate::purchase_costs::enrich(connection, "supplier_invoice_item", &mut supplier_invoice_items)?;
        let supplier_email_invoice_imports = query_all(
            connection,
            "SELECT * FROM supplier_email_invoice_imports ORDER BY created_at DESC,supplier_invoice_id",
            [],
        )?;
        let supplier_payments = query_all(
            connection,
            "SELECT * FROM supplier_payments ORDER BY date DESC,created_at DESC",
            [],
        )?;
        let supplier_orders = query_all(
            connection,
            "SELECT * FROM supplier_orders ORDER BY order_date DESC,created_at DESC",
            [],
        )?;
        let supplier_order_lines = query_all(
            connection,
            "SELECT line.*,
                    COALESCE((SELECT SUM(cancelled.quantity_milli) FROM supplier_order_cancellation_lines cancelled WHERE cancelled.supplier_order_line_id=line.id),0) AS cancelled_quantity_milli,
                    COALESCE((SELECT SUM(receipt_line.quantity_milli) FROM supplier_receipt_lines receipt_line JOIN supplier_receipts receipt ON receipt.id=receipt_line.supplier_receipt_id WHERE receipt_line.supplier_order_line_id=line.id AND receipt.status='issued'),0) AS received_quantity_milli,
                    COALESCE((SELECT SUM(match_row.quantity_milli) FROM supplier_invoice_matches match_row WHERE match_row.supplier_order_line_id=line.id),0) AS matched_quantity_milli,
                    CASE WHEN line.fulfillment_mode='direct' THEN 0 ELSE MAX(0,line.quantity_milli-COALESCE((SELECT SUM(cancelled.quantity_milli) FROM supplier_order_cancellation_lines cancelled WHERE cancelled.supplier_order_line_id=line.id),0)-COALESCE((SELECT SUM(receipt_line.quantity_milli) FROM supplier_receipt_lines receipt_line JOIN supplier_receipts receipt ON receipt.id=receipt_line.supplier_receipt_id WHERE receipt_line.supplier_order_line_id=line.id AND receipt.status='issued'),0)) END AS remaining_receivable_milli,
                    MAX(0,line.quantity_milli-COALESCE((SELECT SUM(cancelled.quantity_milli) FROM supplier_order_cancellation_lines cancelled WHERE cancelled.supplier_order_line_id=line.id),0)-COALESCE((SELECT SUM(match_row.quantity_milli) FROM supplier_invoice_matches match_row WHERE match_row.supplier_order_line_id=line.id),0)) AS remaining_matchable_milli
             FROM supplier_order_lines line ORDER BY line.supplier_order_id,line.position,line.created_at",
            [],
        )?;
        let supplier_order_cancellation_lines = query_all(
            connection,
            "SELECT * FROM supplier_order_cancellation_lines ORDER BY created_at,id",
            [],
        )?;
        let supplier_receipts = query_all(
            connection,
            "SELECT * FROM supplier_receipts ORDER BY receipt_date DESC,created_at DESC",
            [],
        )?;
        let supplier_receipt_lines = query_all(
            connection,
            "SELECT * FROM supplier_receipt_lines ORDER BY supplier_receipt_id,position,created_at",
            [],
        )?;
        let supplier_invoice_matches = query_all(
            connection,
            "SELECT * FROM supplier_invoice_matches ORDER BY supplier_invoice_id,supplier_invoice_item_id,created_at,id",
            [],
        )?;
        let supplier_credit_notes = query_all(
            connection,
            "SELECT credit.*,
                    COALESCE((SELECT SUM(CASE allocation.event_type WHEN 'apply' THEN allocation.amount_cents ELSE -allocation.amount_cents END) FROM supplier_credit_allocations allocation WHERE allocation.supplier_credit_note_id=credit.id),0) AS allocated_cents,
                    MAX(0,credit.total_cents-COALESCE((SELECT SUM(CASE allocation.event_type WHEN 'apply' THEN allocation.amount_cents ELSE -allocation.amount_cents END) FROM supplier_credit_allocations allocation WHERE allocation.supplier_credit_note_id=credit.id),0)) AS available_cents
             FROM supplier_credit_notes credit ORDER BY credit.document_date DESC,credit.created_at DESC",
            [],
        )?;
        let mut supplier_credit_note_items = query_all(
            connection,
            "SELECT * FROM supplier_credit_note_items ORDER BY supplier_credit_note_id,position,created_at",
            [],
        )?;
        crate::purchase_costs::enrich(connection, "supplier_credit_note_item", &mut supplier_credit_note_items)?;
        let supplier_credit_allocations = query_all(
            connection,
            "SELECT * FROM supplier_credit_allocations ORDER BY sequence",
            [],
        )?;
        let supplier_expense_reclassifications = query_all(
            connection,
            "SELECT * FROM supplier_expense_reclassifications ORDER BY effective_date,created_at,id",
            [],
        )?;
        let supplier_expense_reclassification_lines = query_all(
            connection,
            "SELECT * FROM supplier_expense_reclassification_lines ORDER BY reclassification_id,created_at,id",
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
        let mut payments = query_all(
            connection,
            "SELECT payment.*,
                    entry.id AS journal_entry_id,
                    entry.number AS journal_entry_number,
                    entry.source_event AS journal_source_event,
                    (
                      WITH RECURSIVE reversal_chain(id,depth) AS (
                        SELECT entry.id,0
                        UNION ALL
                        SELECT child.id,reversal_chain.depth+1
                        FROM reversal_chain
                        JOIN journal_entries child ON child.reversal_of=reversal_chain.id
                      )
                      SELECT COALESCE(MAX(depth),0)%2=0 FROM reversal_chain
                    ) AS journal_entry_is_active,
                    (
                      WITH RECURSIVE reversal_chain(id,depth) AS (
                        SELECT entry.id,0
                        UNION ALL
                        SELECT child.id,reversal_chain.depth+1
                        FROM reversal_chain
                        JOIN journal_entries child ON child.reversal_of=reversal_chain.id
                      )
                      SELECT COALESCE(MAX(depth),0) FROM reversal_chain
                    ) AS journal_reversal_depth,
                    CASE WHEN entry.id IS NULL THEN NULL ELSE (
                      entry.entry_date=payment.date
                      AND entry.description='Paiement client'
                      AND entry.reversal_of IS NULL
                      AND (SELECT COUNT(*) FROM journal_lines line WHERE line.journal_entry_id=entry.id)=2
                      AND (SELECT COUNT(*) FROM journal_lines line JOIN accounts account ON account.id=line.account_id
                           WHERE line.journal_entry_id=entry.id AND line.memo='Encaissement'
                             AND line.debit_cents=payment.amount_cents AND line.credit_cents=0
                             AND line.currency=invoice.currency AND account.active=1 AND account.account_type='asset'
                             AND line.project_id IS invoice.project_id AND line.client_id IS invoice.client_id
                             AND line.employee_id IS NULL)=1
                      AND (SELECT COUNT(*) FROM journal_lines line JOIN accounts account ON account.id=line.account_id
                           WHERE line.journal_entry_id=entry.id AND line.memo='Règlement créance'
                             AND line.debit_cents=0 AND line.credit_cents=payment.amount_cents
                             AND line.currency=invoice.currency AND account.active=1 AND account.account_type='asset'
                             AND line.project_id IS invoice.project_id AND line.client_id IS invoice.client_id
                             AND line.employee_id IS NULL)=1
                      AND (SELECT line.account_id FROM journal_lines line WHERE line.journal_entry_id=entry.id AND line.memo='Encaissement' LIMIT 1)
                          <>(SELECT line.account_id FROM journal_lines line WHERE line.journal_entry_id=entry.id AND line.memo='Règlement créance' LIMIT 1)
                      AND (SELECT line.account_id FROM journal_lines line WHERE line.journal_entry_id=entry.id AND line.memo='Règlement créance' LIMIT 1)
                          =(SELECT original_line.account_id FROM journal_entries original
                            JOIN journal_lines original_line ON original_line.journal_entry_id=original.id
                           WHERE original.source_type='invoice' AND original.source_id=payment.invoice_id
                             AND original.source_event='issue' AND original_line.memo='Créance client' LIMIT 1)
                      AND (WITH RECURSIVE invoice_chain(id,depth) AS (
                             SELECT original.id,0 FROM journal_entries original
                              WHERE original.source_type='invoice' AND original.source_id=payment.invoice_id
                                AND original.source_event='issue' AND original.reversal_of IS NULL
                             UNION ALL
                             SELECT child.id,invoice_chain.depth+1 FROM invoice_chain
                             JOIN journal_entries child ON child.reversal_of=invoice_chain.id
                           )
                           SELECT COUNT(*)>0 AND COALESCE(MAX(depth),1)%2=0 FROM invoice_chain)
                    ) END AS journal_entry_semantically_valid
             FROM payments payment
             JOIN invoices invoice ON invoice.id=payment.invoice_id
             LEFT JOIN journal_entries entry
               ON entry.source_type='payment'
              AND entry.source_id=payment.id
              AND entry.source_event='invoice:'||payment.invoice_id
             ORDER BY payment.date DESC,payment.created_at DESC",
            [],
        )?;
        // La preuve verte affichée par l'interface couvre aussi la TVA sur
        // encaissements. Une écriture banque/débiteurs correcte ne suffit pas
        // si la reclassification TVA liée manque ou ne correspond plus au
        // cumul de la facture.
        for payment in &mut payments {
            let accounting_block_reason = payment
                .get("id")
                .and_then(Value::as_str)
                .map(|payment_id| {
                    payment_accounting_block_reason(connection, payment_id)
                        .unwrap_or_else(|error| Some(error.to_string()))
                })
                .unwrap_or_else(|| Some("Identifiant du paiement invalide.".into()));
            payment["accounting_blocked"] = json!(accounting_block_reason.is_some());
            payment["accounting_block_reason"] = accounting_block_reason
                .map(Value::String)
                .unwrap_or(Value::Null);
            let sql_proof_valid = payment["journal_entry_semantically_valid"]
                .as_bool()
                .or_else(|| {
                    payment["journal_entry_semantically_valid"]
                        .as_i64()
                        .map(|value| value != 0)
                })
                .unwrap_or(false);
            let cash_vat_valid = payment
                .get("invoice_id")
                .and_then(Value::as_str)
                .is_some_and(|invoice_id| {
                    cash_vat_invoice_is_consistent(connection, invoice_id).unwrap_or(false)
                });
            payment["journal_entry_semantically_valid"] = json!(sql_proof_valid && cash_vat_valid);
        }
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
        let reminder_deliveries = query_all(
            connection,
            "SELECT * FROM reminder_deliveries ORDER BY sequence",
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
        let backup_status = self.backup_status();

        let mut workspace = json!({
            "settings": settings,
            "clients": clients,
            "catalog_items": catalog_items,
            "suppliers": suppliers,
            "projects": projects,
            "quotes": quotes,
            "quote_items": quote_items,
            "invoices": invoices,
            "invoice_correction_workflows": invoice_correction_workflows,
            "invoice_items": invoice_items,
            "invoice_qr_bills": invoice_qr_bills,
            "employees": employees,
            "time_entries": time_entries,
            "expenses": expenses,
            "supplier_invoices":supplier_invoices,
            "supplier_email_invoice_imports":supplier_email_invoice_imports,
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
        workspace["agenda_events"] = json!(agenda_events);
        workspace["backup_status"] = backup_status;
        workspace["reminder_deliveries"] = json!(reminder_deliveries);
        workspace["time_billing_batches"] = json!(time_billing_batches);
        workspace["time_billing_entries"] = json!(time_billing_entries);
        workspace["bank_supplier_reconciliations"] = json!(bank_supplier_reconciliations);
        workspace["stock_movements"] = json!(stock_movements);
        workspace["sales_orders"] = json!(sales_orders);
        workspace["sales_order_lines"] = json!(sales_order_lines);
        workspace["sales_order_cancellation_lines"] = json!(sales_order_cancellation_lines);
        workspace["delivery_notes"] = json!(delivery_notes);
        workspace["delivery_note_lines"] = json!(delivery_note_lines);
        workspace["stock_reservation_events"] = json!(stock_reservation_events);
        workspace["sales_order_invoice_batches"] = json!(sales_order_invoice_batches);
        workspace["sales_order_invoice_allocations"] = json!(sales_order_invoice_allocations);
        workspace["recurrence_schedules"] = json!(recurrence_schedules);
        workspace["recurrence_occurrences"] = json!(recurrence_occurrences);
        workspace["supplier_orders"] = json!(supplier_orders);
        workspace["supplier_order_lines"] = json!(supplier_order_lines);
        workspace["supplier_order_cancellation_lines"] = json!(supplier_order_cancellation_lines);
        workspace["supplier_receipts"] = json!(supplier_receipts);
        workspace["supplier_receipt_lines"] = json!(supplier_receipt_lines);
        workspace["supplier_invoice_matches"] = json!(supplier_invoice_matches);
        workspace["supplier_credit_notes"] = json!(supplier_credit_notes);
        workspace["supplier_credit_note_items"] = json!(supplier_credit_note_items);
        workspace["expense_refunds"] = json!(query_all(connection,"SELECT r.*,m.id AS bank_match_id FROM expense_refunds r LEFT JOIN active_bank_expense_refund_matches m ON m.refund_id=r.id ORDER BY r.payment_date DESC,r.created_at DESC,r.id",[])?);
        workspace["supplier_credit_allocations"] = json!(supplier_credit_allocations);
        workspace["supplier_expense_reclassifications"] = json!(supplier_expense_reclassifications);
        workspace["supplier_expense_reclassification_lines"] =
            json!(supplier_expense_reclassification_lines);
        workspace["stock_availability"] = json!(stock_availability);
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
            require_setup_confirmed(&transaction, "work")?;
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
        if entity == "expenses" {
            let expense_date = object
                .get("date")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Validation("date est obligatoire.".into()))?;
            ensure_accounting_date_open(&transaction, expense_date)?;
            if let Some(paid_at) = object.get("paid_at").and_then(Value::as_str) {
                ensure_accounting_date_open(&transaction, paid_at)?;
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
            validate_deposit_basis_matches_items(&transaction, &document_id)?;
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
            require_setup_confirmed(&transaction, "work")?;
            validate_time_entry_task_link(&transaction, &object, Some(&previous))?;
        }
        if object.is_empty() {
            return Err(AppError::Validation("Aucun champ à modifier.".into()));
        }
        if entity == "expenses" {
            let fiscal_source_changed = [
                "date",
                "supplier",
                "category",
                "reference",
                "currency",
                "net_cents",
                "vat_cents",
                "total_cents",
            ]
            .iter()
            .any(|field| object.contains_key(*field));
            if fiscal_source_changed {
                let previous_date =
                    previous
                        .get("date")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            AppError::Validation(
                                "La date historique de la dépense est invalide.".into(),
                            )
                        })?;
                let next_date = object
                    .get("date")
                    .and_then(Value::as_str)
                    .unwrap_or(previous_date);
                ensure_accounting_date_open(&transaction, previous_date)?;
                ensure_accounting_date_open(&transaction, next_date)?;
            }
            if object.contains_key("payment_status") || object.contains_key("paid_at") {
                let previous_status = previous
                    .get("payment_status")
                    .and_then(Value::as_str)
                    .unwrap_or("paid");
                if previous_status == "paid" {
                    let previous_effective_date = previous
                        .get("paid_at")
                        .and_then(Value::as_str)
                        .or_else(|| previous.get("date").and_then(Value::as_str))
                        .ok_or_else(|| {
                            AppError::Validation(
                                "La date historique de paiement de la dépense est invalide.".into(),
                            )
                        })?;
                    ensure_accounting_date_open(&transaction, previous_effective_date)?;
                }
                let next_status = object
                    .get("payment_status")
                    .and_then(Value::as_str)
                    .unwrap_or(previous_status);
                if next_status == "paid" {
                    let next_effective_date = match object.get("paid_at") {
                        Some(Value::String(value)) => Some(value.as_str()),
                        Some(Value::Null) => None,
                        _ => previous.get("paid_at").and_then(Value::as_str),
                    }
                    .or_else(|| {
                        object
                            .get("date")
                            .and_then(Value::as_str)
                            .or_else(|| previous.get("date").and_then(Value::as_str))
                    })
                    .ok_or_else(|| {
                        AppError::Validation(
                            "La date de paiement de la dépense est invalide.".into(),
                        )
                    })?;
                    ensure_accounting_date_open(&transaction, next_effective_date)?;
                }
            }
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
        if entity == "invoices" {
            validate_deposit_basis_matches_items(&transaction, id)?;
        }
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
        } else if entity == "clients" {
            ensure_client_sales_empty_before_delete(&transaction, id)?;
        } else if entity == "catalog_items" {
            ensure_catalog_sales_empty_before_delete(&transaction, id)?;
        }
        if entity == "expenses" {
            let expense_date = previous
                .get("date")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::Validation("La date historique de la dépense est invalide.".into())
                })?;
            ensure_accounting_date_open(&transaction, expense_date)?;
            if let Some(paid_at) = previous.get("paid_at").and_then(Value::as_str) {
                ensure_accounting_date_open(&transaction, paid_at)?;
            }
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
        if let Some(requested_logo) = object.get("logo_path").cloned() {
            let current_logo: Option<String> =
                connection.query_row("SELECT logo_path FROM settings WHERE id=1", [], |row| {
                    row.get(0)
                })?;
            let normalized_logo = match requested_logo {
                Value::Null => None,
                Value::String(path) if path.trim().is_empty() => None,
                Value::String(path) => {
                    match self.store_company_logo_reference(Some(path.as_str())) {
                        Ok(stored) => stored,
                        Err(_error)
                            if current_logo
                                .as_deref()
                                .is_some_and(|current| current.trim() == path.trim())
                                && !crate::branding::is_managed_logo_reference(&path) =>
                        {
                            // Compatibilité ciblée : un profil ancien peut encore
                            // pointer vers un logo externe aujourd'hui indisponible.
                            // Une sauvegarde ou un réglage sans rapport ne doit pas
                            // effacer cette donnée. Dès que le fichier redevient
                            // accessible, le même flux le recopiera localement.
                            current_logo.clone()
                        }
                        Err(error) => return Err(error),
                    }
                }
                _ => {
                    return Err(AppError::Validation(
                        "logo_path doit être un chemin de fichier ou null.".into(),
                    ))
                }
            };
            object.insert(
                "logo_path".into(),
                normalized_logo.map(Value::String).unwrap_or(Value::Null),
            );
        }
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
            current_extra_settings_json,
        ): SettingsValidationRow = transaction.query_row(
            "SELECT vat_registered,default_vat_bp,uid_number,vat_number,noga_section,noga_division,activity_description,noga_detailed_code,iban,extra_settings_json FROM settings WHERE id=1",
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
                    row.get(9)?,
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
        let effective_extra_settings_json = object
            .get("extra_settings_json")
            .and_then(Value::as_str)
            .or(current_extra_settings_json.as_deref())
            .unwrap_or("{}");
        let billing_deferred = serde_json::from_str::<Value>(effective_extra_settings_json)?
            .pointer("/setupDeferred/billing")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !(billing_deferred && vat_registered == 1 && vat_bp == 0) {
            validate_vat_configuration(vat_registered == 1, vat_bp)?;
        }
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
        if !effective_iban.trim().is_empty() {
            normalize_and_validate_iban(&effective_iban)?;
        }
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
        if valid < date {
            return Err(AppError::Validation(
                "La date de validité du devis ne peut pas précéder sa date d'émission.".into(),
            ));
        }
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
        crate::sales_pdf::validate_document_snapshot_legal_fields("quotes", &snapshot)?;
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
        let correction_dependency: Option<(String, Option<String>)> = transaction
            .query_row(
                "SELECT workflow.credit_note_id,credit.number
                   FROM invoice_correction_workflows workflow
                   JOIN invoices credit ON credit.id=workflow.credit_note_id
                  WHERE workflow.replacement_invoice_id=? LIMIT 1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if correction_dependency
            .as_ref()
            .is_some_and(|(_, credit_number)| credit_number.as_deref().is_none_or(str::is_empty))
        {
            return Err(AppError::Validation(
                "Émettez d’abord l’avoir correctif préparé avec cette facture de remplacement."
                    .into(),
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
        validate_invoice_deposit_percentage(
            existing
                .as_object()
                .ok_or_else(|| AppError::Validation("La facture à émettre est invalide.".into()))?,
            false,
        )?;
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
        if due < date {
            return Err(AppError::Validation(
                "La date d'échéance de la facture ne peut pas précéder sa date d'émission.".into(),
            ));
        }
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
        validate_deposit_basis_matches_items(&transaction, id)?;
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
                    "L'avoir doit conserver le client, le projet et la devise de la facture originale."
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
                "SELECT COALESCE(SUM(-total_cents),0) FROM invoices WHERE type='avoir' AND original_invoice_id=? AND number IS NOT NULL AND status<>'annulee' AND id<>?",
                params![original, id],
                |row| row.get(0),
            )?;
            let requested_credit = totals.2.checked_neg().ok_or_else(|| {
                AppError::Validation("Le montant de l'avoir dépasse la capacité locale.".into())
            })?;
            let total_credit = already_credited
                .checked_add(requested_credit)
                .ok_or_else(|| {
                    AppError::Validation(
                        "Le cumul des avoirs dépasse la capacité monétaire locale.".into(),
                    )
                })?;
            if total_credit > original_total {
                return Err(AppError::Validation(
                    "Le cumul des avoirs ne peut pas dépasser le total de la facture originale."
                        .into(),
                ));
            }
        }
        if let Some((original, expected_subtotal, expected_vat, expected_total)) = transaction
            .query_row(
                "SELECT workflow.original_invoice_id,original.subtotal_cents,
                        original.vat_cents,original.total_cents
                   FROM invoice_correction_workflows workflow
                   JOIN invoices original ON original.id=workflow.original_invoice_id
                  WHERE workflow.credit_note_id=? LIMIT 1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?
        {
            let requested_credit = totals.2.checked_neg().ok_or_else(|| {
                AppError::Validation("Le montant de l’avoir correctif est invalide.".into())
            })?;
            if requested_credit != expected_total
                || totals.0.abs() != expected_subtotal.abs()
                || totals.1.abs() != expected_vat.abs()
            {
                return Err(AppError::Validation(format!(
                    "L’avoir correctif de {original} doit reprendre exactement le hors taxe, la TVA et le total de la facture originale ({expected_total} centimes)."
                )));
            }
        }
        let number_type = if invoice_type == "avoir" {
            "credit_note"
        } else {
            "invoice"
        };
        let number = assign_document_number(&transaction, "invoices", id, number_type, &date)?;
        let payment_snapshot = build_document_snapshot(
            &transaction,
            "invoices",
            "invoice_items",
            id,
            &json!({"number":number.clone(),"issue_date":date.clone(),"due_date":due.clone(),"service_date_from":service_from.clone(),"service_date_to":service_to.clone()}),
        )?;
        crate::swiss_qr::ensure_automatic_invoice_qr(&transaction, &payment_snapshot)?;
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
        crate::sales_pdf::validate_document_snapshot_legal_fields("invoices", &snapshot)?;
        transaction.execute(
            "UPDATE invoices SET number = ?, status = CASE WHEN status = 'brouillon' THEN 'emise' ELSE status END, issue_date = ?, due_date = ?,service_date_from=?,service_date_to=?,snapshot_json=?, updated_at = ? WHERE id = ?",
            params![number, date, due,service_from,service_to,serde_json::to_string(&snapshot)?, now_iso(), id],
        )?;
        let stock_movements = crate::stock::apply_invoice_stock_movements(&transaction, id)?;
        let record = query_record_tx(&transaction, "invoices", id)?;
        let journal = post_invoice_if_enabled(&transaction, id)?;
        let linked_sales_order: Option<(String, String)> = transaction
            .query_row(
                "SELECT sales_order_id,role FROM sales_order_invoice_batches WHERE invoice_id=?",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((sales_order_id, role)) = linked_sales_order.as_ref() {
            let closed = crate::sales_fulfillment::close_sales_order_if_fully_allocated(
                &transaction,
                sales_order_id,
            )?;
            if role == "final" && !closed {
                return Err(AppError::Validation(
                    "La facture finale ne couvre plus tout le reliquat de la commande; l'émission a été annulée."
                        .into(),
                ));
            }
        }
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

    pub fn create_invoice_correction(
        &self,
        input: CreateInvoiceCorrectionInput,
    ) -> AppResult<Value> {
        let original_id = input.original_invoice_id.trim();
        let reason = input.reason.trim();
        if original_id.is_empty() {
            return Err(AppError::Validation(
                "La facture originale est obligatoire.".into(),
            ));
        }
        if !(5..=1_000).contains(&reason.len()) {
            return Err(AppError::Validation(
                "Expliquez la correction en 5 à 1 000 caractères.".into(),
            ));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let original = query_record_tx(&transaction, "invoices", original_id)?;
        let original_number = original
            .get("number")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                AppError::Validation(
                    "Seule une facture déjà émise peut être corrigée par ce flux.".into(),
                )
            })?;
        let original_type = original
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("standard");
        if matches!(original_type, "avoir" | "credit_note") {
            return Err(AppError::Validation(
                "Un avoir ne peut pas devenir la facture source d’une nouvelle correction.".into(),
            ));
        }
        let status = original.get("status").and_then(Value::as_str).unwrap_or("");
        if !matches!(
            status,
            "emise" | "en_retard" | "partiellement_payee" | "payee"
        ) {
            return Err(AppError::Validation(
                "Cette facture n’est pas dans un état corrigeable.".into(),
            ));
        }
        let active_workflow: bool = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM invoice_correction_workflows workflow
               JOIN invoices credit ON credit.id=workflow.credit_note_id
               JOIN invoices replacement ON replacement.id=workflow.replacement_invoice_id
               WHERE workflow.original_invoice_id=?
                 AND (credit.number IS NULL OR replacement.number IS NULL)
             )",
            params![original_id],
            |row| row.get(0),
        )?;
        if active_workflow {
            return Err(AppError::Validation(
                "Une correction de cette facture est déjà en préparation. Terminez ses deux brouillons avant d’en créer une autre."
                    .into(),
            ));
        }
        let credited: i64 = transaction.query_row(
            "SELECT COALESCE(SUM(-total_cents),0) FROM invoices
              WHERE type='avoir' AND original_invoice_id=?
                AND number IS NOT NULL AND status<>'annulee'",
            params![original_id],
            |row| row.get(0),
        )?;
        if credited > 0 {
            return Err(AppError::Validation(
                "Cette facture possède déjà un avoir émis. Corrigez la facture de remplacement la plus récente pour préserver la chaîne."
                    .into(),
            ));
        }
        let line_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM invoice_items WHERE invoice_id=?",
            params![original_id],
            |row| row.get(0),
        )?;
        if line_count == 0 {
            return Err(AppError::Validation(
                "La facture originale ne contient aucune ligne à reprendre.".into(),
            ));
        }

        let workflow_id = Uuid::new_v4().to_string();
        let credit_id = Uuid::new_v4().to_string();
        let replacement_id = Uuid::new_v4().to_string();
        let created_at = now_iso();
        let issue_date = today();
        let payment_terms_days: i64 = transaction.query_row(
            "SELECT payment_terms_days FROM settings WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        let replacement_due = add_days(&issue_date, payment_terms_days)?;
        let original_title = original
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Facture");
        let original_notes = original.get("notes").and_then(Value::as_str).unwrap_or("");
        let correction_note = format!(
            "Correction de {original_number} — Motif : {reason}{}",
            if original_notes.trim().is_empty() {
                String::new()
            } else {
                format!("\n\nNotes originales : {}", original_notes.trim())
            }
        );

        for (id, title, invoice_type, due_date, linked_original) in [
            (
                credit_id.as_str(),
                format!("Avoir correctif — {original_number}"),
                "avoir",
                issue_date.as_str(),
                Some(original_id),
            ),
            (
                replacement_id.as_str(),
                original_title.to_owned(),
                original_type,
                replacement_due.as_str(),
                None,
            ),
        ] {
            transaction.execute(
                "INSERT INTO invoices(
                   id,client_id,project_id,quote_id,original_invoice_id,number,title,type,
                   deposit_percentage_bp,deposit_basis_json,status,
                   issue_date,due_date,service_date_from,service_date_to,currency,
                   subtotal_cents,discount_cents,vat_cents,total_cents,paid_cents,
                   notes,terms,snapshot_json,created_at,updated_at
                 )
                 SELECT ?,client_id,project_id,NULL,?,NULL,?,?,
                        CASE WHEN ?='acompte' THEN deposit_percentage_bp ELSE NULL END,
                        CASE WHEN ?='acompte' THEN deposit_basis_json ELSE NULL END,'brouillon',
                        ?,?,service_date_from,service_date_to,currency,
                        0,0,0,0,0,?,terms,NULL,?,?
                   FROM invoices WHERE id=?",
                params![
                    id,
                    linked_original,
                    title,
                    invoice_type,
                    invoice_type,
                    invoice_type,
                    issue_date,
                    due_date,
                    correction_note,
                    created_at,
                    created_at,
                    original_id
                ],
            )?;
        }

        let lines = {
            let mut statement = transaction.prepare(
                "SELECT catalog_item_id,position,description,quantity,unit,
                        unit_price_cents,discount_bp,vat_bp
                   FROM invoice_items WHERE invoice_id=? ORDER BY position,id",
            )?;
            let rows = statement.query_map(params![original_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (
            catalog_item_id,
            position,
            description,
            quantity,
            unit,
            unit_price_cents,
            discount_bp,
            vat_bp,
        ) in lines
        {
            for (invoice_id, price) in [
                (credit_id.as_str(), -unit_price_cents.abs()),
                (replacement_id.as_str(), unit_price_cents.abs()),
            ] {
                transaction.execute(
                    "INSERT INTO invoice_items(
                       id,invoice_id,catalog_item_id,position,description,quantity,unit,
                       unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,
                       line_total_cents,created_at,updated_at
                     ) VALUES(?,?,?,?,?,?,?,?,?,?,0,0,0,?,?)",
                    params![
                        Uuid::new_v4().to_string(),
                        invoice_id,
                        catalog_item_id,
                        position,
                        description,
                        quantity,
                        unit,
                        price,
                        discount_bp,
                        vat_bp,
                        created_at,
                        created_at
                    ],
                )?;
            }
        }
        recompute_all_invoice_lines(&transaction, &credit_id)?;
        recompute_invoice(&transaction, &credit_id)?;
        recompute_all_invoice_lines(&transaction, &replacement_id)?;
        recompute_invoice(&transaction, &replacement_id)?;
        transaction.execute(
            "INSERT INTO invoice_correction_workflows(
               id,original_invoice_id,credit_note_id,replacement_invoice_id,reason,created_at
             ) VALUES(?,?,?,?,?,?)",
            params![
                workflow_id,
                original_id,
                credit_id,
                replacement_id,
                reason,
                created_at
            ],
        )?;
        let credit = query_record_tx(&transaction, "invoices", &credit_id)?;
        let replacement = query_record_tx(&transaction, "invoices", &replacement_id)?;
        append_audit(
            &transaction,
            "prepare_correction",
            "invoice",
            original_id,
            &json!({
                "workflow_id":workflow_id,
                "original_number":original_number,
                "credit_note_id":credit_id,
                "replacement_invoice_id":replacement_id,
                "reason":reason
            }),
        )?;
        append_audit(&transaction, "create", "credit_note", &credit_id, &credit)?;
        append_audit(
            &transaction,
            "create_replacement",
            "invoice",
            &replacement_id,
            &replacement,
        )?;
        transaction.commit()?;
        Ok(json!({
            "workflow_id":workflow_id,
            "credit_note_id":credit_id,
            "replacement_invoice_id":replacement_id,
            "reason":reason
        }))
    }

    pub fn abandon_invoice_correction(
        &self,
        input: AbandonInvoiceCorrectionInput,
    ) -> AppResult<Value> {
        let workflow_id = input.workflow_id.trim();
        if workflow_id.is_empty() {
            return Err(AppError::Validation(
                "La correction à abandonner est obligatoire.".into(),
            ));
        }

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let workflow = transaction
            .query_row(
                "SELECT workflow.original_invoice_id,original.number,original.title,
                        workflow.credit_note_id,credit.status,credit.number,
                        workflow.replacement_invoice_id,replacement.status,replacement.number,
                        workflow.reason,workflow.created_at
                   FROM invoice_correction_workflows workflow
                   JOIN invoices original ON original.id=workflow.original_invoice_id
                   JOIN invoices credit ON credit.id=workflow.credit_note_id
                   JOIN invoices replacement ON replacement.id=workflow.replacement_invoice_id
                  WHERE workflow.id=?",
                params![workflow_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| {
                AppError::NotFound(format!("invoice_correction_workflows/{workflow_id}"))
            })?;
        let (
            original_id,
            original_number,
            original_title,
            credit_id,
            credit_status,
            credit_number,
            replacement_id,
            replacement_status,
            replacement_number,
            reason,
            prepared_at,
        ) = workflow;

        if credit_status != "brouillon"
            || replacement_status != "brouillon"
            || credit_number.is_some()
            || replacement_number.is_some()
        {
            return Err(AppError::Validation(
                "La correction ne peut plus être abandonnée dès que l’avoir ou la facture de remplacement a été émis."
                    .into(),
            ));
        }

        let has_operational_links: bool = transaction.query_row(
            "SELECT
                EXISTS(SELECT 1 FROM payments WHERE invoice_id IN (?1,?2)) OR
                EXISTS(SELECT 1 FROM bank_reconciliations WHERE invoice_id IN (?1,?2)) OR
                EXISTS(SELECT 1 FROM stock_movements WHERE invoice_id IN (?1,?2)) OR
                EXISTS(SELECT 1 FROM time_billing_batches WHERE invoice_id IN (?1,?2)) OR
                EXISTS(SELECT 1 FROM sales_order_invoice_batches WHERE invoice_id IN (?1,?2)) OR
                EXISTS(SELECT 1 FROM quote_conversions WHERE invoice_id IN (?1,?2)) OR
                EXISTS(SELECT 1 FROM reminders WHERE invoice_id IN (?1,?2)) OR
                EXISTS(SELECT 1 FROM recurrence_occurrences WHERE invoice_id IN (?1,?2)) OR
                EXISTS(SELECT 1 FROM invoices WHERE original_invoice_id IN (?1,?2)) OR
                EXISTS(
                    SELECT 1 FROM journal_entries
                     WHERE source_id IN (?1,?2)
                       AND source_type IN ('invoice','credit_note')
                )",
            params![credit_id, replacement_id],
            |row| row.get(0),
        )?;
        if has_operational_links {
            return Err(AppError::Validation(
                "La correction contient déjà des opérations liées et ne peut pas être abandonnée automatiquement."
                    .into(),
            ));
        }

        let qr_bill_count = transaction.execute(
            "DELETE FROM invoice_qr_bills WHERE invoice_id IN (?1,?2)",
            params![credit_id, replacement_id],
        )?;
        let line_count = transaction.execute(
            "DELETE FROM invoice_items WHERE invoice_id IN (?1,?2)",
            params![credit_id, replacement_id],
        )?;
        if transaction.execute(
            "DELETE FROM invoice_correction_workflows WHERE id=?",
            params![workflow_id],
        )? != 1
        {
            return Err(AppError::NotFound(format!(
                "invoice_correction_workflows/{workflow_id}"
            )));
        }
        let deleted_invoices = transaction.execute(
            "DELETE FROM invoices
              WHERE id IN (?1,?2) AND status='brouillon' AND number IS NULL",
            params![credit_id, replacement_id],
        )?;
        if deleted_invoices != 2 {
            return Err(AppError::Validation(
                "La correction a changé pendant l’abandon. Aucune donnée n’a été supprimée.".into(),
            ));
        }

        append_audit(
            &transaction,
            "abandon_correction",
            "invoice_correction",
            workflow_id,
            &json!({
                "original_invoice_id":original_id,
                "original_number":original_number,
                "original_title":original_title,
                "credit_note_id":credit_id,
                "replacement_invoice_id":replacement_id,
                "reason":reason,
                "prepared_at":prepared_at,
                "deleted_line_count":line_count,
                "deleted_qr_bill_count":qr_bill_count
            }),
        )?;
        transaction.commit()?;
        Ok(json!({
            "abandoned":true,
            "workflow_id":workflow_id,
            "original_invoice_id":original_id,
            "credit_note_id":credit_id,
            "replacement_invoice_id":replacement_id
        }))
    }

    pub fn update_quote_status(&self, id: &str, status: &str) -> AppResult<Value> {
        let normalized = match status {
            "accepted" | "accepte" => "accepte",
            "refused" | "refuse" => "refuse",
            "expired" | "expire" => "expire",
            "cancelled" | "canceled" | "annule" | "annulee" => "annulee",
            _ => {
                return Err(AppError::Validation(
                    "status doit être accepted, refused, expired ou cancelled.".into(),
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
        let transition_allowed =
            current == "emis" || (current == "accepte" && normalized == "annulee");
        if !transition_allowed {
            return Err(AppError::Validation(format!(
                "Transition de statut interdite depuis {current}."
            )));
        }
        if normalized == "annulee" {
            ensure_quote_has_no_downstream_document(&transaction, id)?;
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

    /// Prépare une version modifiable d'un devis déjà émis sans réécrire le
    /// document historique. L'ancienne version reste numérotée, avec son
    /// snapshot et sa chaîne d'audit; si une commande ou facture en dépend,
    /// son statut reste inchangé. La nouvelle version repart en brouillon et
    /// recevra un nouveau numéro à sa prochaine émission.
    #[cfg(test)]
    pub fn create_quote_revision(&self, id: &str) -> AppResult<Value> {
        self.create_quote_revision_with_request_id(&Uuid::new_v4().to_string(), id)
    }

    /// Variante idempotente utilisée par l'interface. Le résultat complet est
    /// conservé dans la chaîne d'audit afin qu'une réponse perdue puisse être
    /// rejouée à l'identique sans créer une deuxième révision.
    pub fn create_quote_revision_with_request_id(
        &self,
        request_id: &str,
        id: &str,
    ) -> AppResult<Value> {
        const OPERATION: &str = "create_quote_revision";
        const REQUEST_ENTITY: &str = "quote_revision_request";

        let request_id = Uuid::parse_str(request_id.trim())
            .map(|value| value.to_string())
            .map_err(|_| AppError::Validation("request_id doit être un UUID valide.".into()))?;
        let id = Uuid::parse_str(id.trim())
            .map(|value| value.to_string())
            .map_err(|_| AppError::Validation("id doit être un UUID valide.".into()))?;
        let payload = json!({"request_id":request_id,"quote_id":id});
        let payload_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(&payload)?));
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let replay_payloads = {
            let mut statement = transaction.prepare(
                "SELECT payload_json FROM audit_log
                 WHERE entity_type=? AND entity_id=? AND action='complete'
                 ORDER BY rowid",
            )?;
            let rows = statement
                .query_map(params![REQUEST_ENTITY, request_id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        if replay_payloads.len() > 1 {
            return Err(AppError::Validation(
                "Le registre idempotent de cette révision est incohérent.".into(),
            ));
        }
        if let Some(replay_payload) = replay_payloads.first() {
            let replay: Value = serde_json::from_str(replay_payload).map_err(|_| {
                AppError::Validation(
                    "Le registre idempotent de cette révision est illisible.".into(),
                )
            })?;
            if replay.get("operation").and_then(Value::as_str) != Some(OPERATION)
                || replay.get("payload_sha256").and_then(Value::as_str)
                    != Some(payload_sha256.as_str())
                || replay.get("source_quote_id").and_then(Value::as_str) != Some(id.as_str())
            {
                return Err(AppError::Validation(
                    "Ce request_id a déjà été utilisé pour une autre révision ou un autre devis."
                        .into(),
                ));
            }
            let response = replay.get("response").cloned().ok_or_else(|| {
                AppError::Validation("La réponse idempotente de cette révision est absente.".into())
            })?;
            let revision_id = response
                .pointer("/revision/id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::Validation(
                        "La réponse idempotente de cette révision est incohérente.".into(),
                    )
                })?;
            if response.pointer("/source/id").and_then(Value::as_str) != Some(id.as_str())
                || replay.get("revision_quote_id").and_then(Value::as_str) != Some(revision_id)
            {
                return Err(AppError::Validation(
                    "La source ou le résultat idempotent de cette révision est incohérent.".into(),
                ));
            }
            let revision_exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM quotes WHERE id=?)",
                params![revision_id],
                |row| row.get(0),
            )?;
            if !revision_exists {
                return Err(AppError::Validation(
                    "La révision enregistrée pour cette tentative n'existe plus.".into(),
                ));
            }
            transaction.commit()?;
            return Ok(response);
        }

        let conflicting_sales_request: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sales_operation_requests WHERE request_id=?)",
            params![request_id],
            |row| row.get(0),
        )?;
        if conflicting_sales_request {
            return Err(AppError::Validation(
                "Ce request_id a déjà été utilisé pour une autre opération commerciale.".into(),
            ));
        }

        let source = query_record_tx(&transaction, "quotes", &id)?;
        if source
            .get("number")
            .and_then(Value::as_str)
            .is_none_or(|number| number.trim().is_empty())
        {
            return Err(AppError::Validation(
                "Ce devis est encore un brouillon et peut être modifié directement.".into(),
            ));
        }
        let has_downstream_document = quote_downstream_document(&transaction, &id)?.is_some();

        let status = source.get("status").and_then(Value::as_str).unwrap_or("");
        if !matches!(status, "emis" | "accepte" | "refuse" | "expire" | "annulee") {
            return Err(AppError::Validation(format!(
                "Le devis ne peut pas être révisé depuis le statut {status}."
            )));
        }
        let line_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM quote_items WHERE quote_id=?",
            params![id],
            |row| row.get(0),
        )?;
        if line_count == 0 {
            return Err(AppError::Validation(
                "Le devis à réviser ne contient aucune ligne.".into(),
            ));
        }

        let revision_id = Uuid::new_v4().to_string();
        let now = now_iso();
        let revision_issue_date = today();
        let quote_validity_days: i64 = transaction.query_row(
            "SELECT quote_validity_days FROM settings WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        let revision_valid_until = add_days(&revision_issue_date, quote_validity_days)?;
        transaction.execute(
            "INSERT INTO quotes(
               id,client_id,project_id,number,title,status,issue_date,valid_until,currency,
               subtotal_cents,discount_cents,vat_cents,total_cents,notes,terms,snapshot_json,
               created_at,updated_at
             )
             SELECT ?,client_id,project_id,NULL,title,'brouillon',?,?,currency,
                    0,0,0,0,notes,terms,NULL,?,?
               FROM quotes WHERE id=?",
            params![
                revision_id,
                revision_issue_date,
                revision_valid_until,
                now,
                now,
                id
            ],
        )?;
        let source_lines = {
            let mut statement = transaction.prepare(
                "SELECT catalog_item_id,position,description,quantity,unit,unit_price_cents,
                        discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents
                   FROM quote_items WHERE quote_id=? ORDER BY position,rowid",
            )?;
            let rows = statement
                .query_map(params![id], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, f64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for line in source_lines {
            transaction.execute(
                "INSERT INTO quote_items(
                   id,quote_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,
                   discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at
                 ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    Uuid::new_v4().to_string(),
                    revision_id,
                    line.0,
                    line.1,
                    line.2,
                    line.3,
                    line.4,
                    line.5,
                    line.6,
                    line.7,
                    line.8,
                    line.9,
                    line.10,
                    now,
                    now
                ],
            )?;
        }
        recompute_quote(&transaction, &revision_id)?;

        if status != "annulee" && !has_downstream_document {
            transaction.execute(
                "UPDATE quotes SET status='annulee',updated_at=? WHERE id=?",
                params![now_iso(), id],
            )?;
        }
        let revision = query_record_tx(&transaction, "quotes", &revision_id)?;
        let items = query_all(
            &transaction,
            "SELECT * FROM quote_items WHERE quote_id=? ORDER BY position,rowid",
            params![revision_id],
        )?;
        append_audit(
            &transaction,
            "revise",
            "quote",
            &id,
            &json!({
                "source_number":source.get("number"),
                "source_status":status,
                "revision_quote_id":revision_id,
                "request_id":request_id,
                "payload_sha256":payload_sha256,
                "source_preserved":true,
                "source_status_preserved":has_downstream_document
            }),
        )?;
        let response = json!({
            "source":source,
            "revision":revision,
            "items":items
        });
        append_audit(
            &transaction,
            "create_revision",
            "quote",
            &revision_id,
            &json!({
                "source_quote_id":id,
                "request_id":request_id,
                "payload_sha256":payload_sha256,
                "document":revision,
                "items":items
            }),
        )?;
        append_audit(
            &transaction,
            "complete",
            REQUEST_ENTITY,
            &request_id,
            &json!({
                "operation":OPERATION,
                "payload_sha256":payload_sha256,
                "source_quote_id":id,
                "revision_quote_id":revision_id,
                "response":response
            }),
        )?;
        transaction.commit()?;
        Ok(response)
    }

    pub fn convert_quote_to_invoice(&self, input: ConvertQuoteInput) -> AppResult<Value> {
        let deposit_percentage_bp = match input.deposit_percentage_bp {
            Some(value) if (1..=10_000).contains(&value) => Some(value),
            Some(_) => {
                return Err(AppError::Validation(
                    "Le pourcentage d'acompte doit être compris entre 0,01 et 100 %.".into(),
                ))
            }
            None => None,
        };
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
        let existing_order: Option<String> = transaction
            .query_row(
                "SELECT id FROM sales_orders WHERE quote_id=?",
                params![input.quote_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing_order) = existing_order {
            return Err(AppError::Validation(format!(
                "Ce devis a déjà été converti en commande client {existing_order}."
            )));
        }
        let contains_tracked_stock: bool = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM quote_items line
               JOIN catalog_items item ON item.id=line.catalog_item_id
               WHERE line.quote_id=? AND item.track_stock=1
             )",
            params![input.quote_id],
            |row| row.get(0),
        )?;
        if contains_tracked_stock {
            return Err(AppError::Validation(
                "Ce devis contient un article suivi en stock. Convertissez-le en commande client puis émettez un bon de livraison avant de facturer."
                    .into(),
            ));
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
        let mut statement=transaction.prepare("SELECT id,position,catalog_item_id,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents FROM quote_items WHERE quote_id=? ORDER BY position,rowid")?;
        let items = statement
            .query_map(params![input.quote_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, f64>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, i64>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, i64>(10)?,
                    r.get::<_, i64>(11)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        if items.is_empty() {
            return Err(AppError::Validation(
                "Le devis accepté ne contient aucune ligne.".into(),
            ));
        }
        let deposit_basis_json = deposit_percentage_bp
            .map(|_| {
                serde_json::to_string(
                    &items
                        .iter()
                        .map(|item| {
                            json!({
                                "id": item.0,
                                "catalog_item_id": item.2,
                                "description": item.3,
                                "quantity": item.4,
                                "unit": item.5,
                                "unit_price_cents": item.6,
                                "discount_bp": item.7,
                                "vat_bp": item.8,
                            })
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .transpose()?;
        if let Some(serialized_basis) = deposit_basis_json.as_ref() {
            let basis_value = Value::String(serialized_basis.clone());
            validate_deposit_basis_json(Some(&basis_value))?;
        }
        let invoice_type = if deposit_percentage_bp.is_some() {
            "acompte"
        } else {
            "standard"
        };
        transaction.execute(
            "INSERT INTO invoices(id,client_id,project_id,quote_id,title,type,deposit_percentage_bp,deposit_basis_json,status,issue_date,due_date,service_date_from,service_date_to,currency,notes,terms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'brouillon',?,?,?,?,?,?,?,?,?)",
            params![
                invoice_id,
                quote["client_id"].as_str(),
                quote["project_id"].as_str(),
                input.quote_id,
                title,
                invoice_type,
                deposit_percentage_bp,
                deposit_basis_json,
                issue_date,
                due_date,
                service_from,
                service_to,
                quote["currency"].as_str(),
                quote["notes"].as_str(),
                quote["terms"].as_str(),
                now,
                now
            ],
        )?;
        for item in items {
            if let Some(percentage_bp) = deposit_percentage_bp {
                let amount_cents = round_basis_points(item.9, percentage_bp);
                let vat_cents = round_basis_points(amount_cents, item.8);
                transaction.execute(
                    "INSERT INTO invoice_items(id,invoice_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at) VALUES(?,?,NULL,?,?,1,'acompte',?,0,?,?,?,?,?,?)",
                    params![
                        Uuid::new_v4().to_string(),
                        invoice_id,
                        item.1,
                        deposit_line_description(percentage_bp, &item.3),
                        amount_cents,
                        item.8,
                        amount_cents,
                        vat_cents,
                        amount_cents.saturating_add(vat_cents),
                        now,
                        now
                    ],
                )?;
            } else {
                transaction.execute("INSERT INTO invoice_items(id,invoice_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![Uuid::new_v4().to_string(),invoice_id,item.2,item.1,item.3,item.4,item.5,item.6,item.7,item.8,item.9,item.10,item.11,now,now])?;
            }
        }
        recompute_invoice(&transaction, &invoice_id)?;
        if deposit_percentage_bp.is_some() {
            let total_cents: i64 = transaction.query_row(
                "SELECT total_cents FROM invoices WHERE id=?",
                params![invoice_id],
                |row| row.get(0),
            )?;
            if total_cents <= 0 {
                return Err(AppError::Validation(
                    "Ce pourcentage produit un acompte de 0 CHF. Choisissez un pourcentage plus élevé."
                        .into(),
                ));
            }
            validate_deposit_basis_matches_items(&transaction, &invoice_id)?;
        }
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
        require_setup_confirmed(&transaction, "work")?;
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
                "deposit_percentage_bp",
                "deposit_basis_json",
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
                "employment_contract_kind",
                "reference_age_date",
                "avs_allowance_waived",
                "contractual_weekly_minutes",
                "ac_opening_year",
                "ac_opening_basis_cents",
                "laa_opening_year",
                "laa_opening_basis_cents",
                "small_salary_assessment_year",
                "small_salary_decision_date",
                "small_salary_sector",
                "small_salary_employee_requested_contributions",
                "small_salary_opening_gross_cents",
                "small_salary_opening_contributed_basis_cents",
                "small_salary_evidence_reference",
                "lpp_assessment_year",
                "lpp_annual_salary_cents",
                "lpp_exception_code",
                "lpp_exception_evidence_reference",
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
        "quotes"=>record.get("number").and_then(Value::as_str).is_some_and(|v|!v.is_empty()),
        "invoices"=>record.get("number").and_then(Value::as_str).is_some_and(|v|!v.is_empty()) || record.get("id").and_then(Value::as_str).is_some_and(|id|transaction.query_row("SELECT EXISTS(SELECT 1 FROM sales_order_invoice_batches WHERE invoice_id=?)",params![id],|r|r.get::<_,bool>(0)).unwrap_or(true)),
        "payments"=>true,
        "quote_items"=>record.get("quote_id").and_then(Value::as_str).is_some_and(|id|transaction.query_row("SELECT number IS NOT NULL FROM quotes WHERE id=?",params![id],|r|r.get::<_,bool>(0)).unwrap_or(true)),
        "invoice_items"=>record.get("invoice_id").and_then(Value::as_str).is_some_and(|id|transaction.query_row("SELECT number IS NOT NULL OR EXISTS(SELECT 1 FROM sales_order_invoice_batches WHERE invoice_id=invoices.id) FROM invoices WHERE id=?",params![id],|r|r.get::<_,bool>(0)).unwrap_or(true)),
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

fn ensure_quote_has_no_downstream_document(
    transaction: &Transaction<'_>,
    quote_id: &str,
) -> AppResult<()> {
    let Some((document_kind, document_id)) = quote_downstream_document(transaction, quote_id)?
    else {
        return Ok(());
    };
    Err(AppError::Validation(format!(
        "Ce devis est déjà lié à {document_kind} {document_id}. Annulez ou corrigez d'abord le document en aval afin de préserver la traçabilité."
    )))
}

fn quote_downstream_document(
    transaction: &Transaction<'_>,
    quote_id: &str,
) -> AppResult<Option<(&'static str, String)>> {
    let invoice_id: Option<String> = transaction
        .query_row(
            "SELECT invoice_id FROM quote_conversions WHERE quote_id=?",
            params![quote_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(invoice_id) = invoice_id {
        return Ok(Some(("la facture", invoice_id)));
    }
    let order_id: Option<String> = transaction
        .query_row(
            "SELECT id FROM sales_orders WHERE quote_id=? ORDER BY created_at LIMIT 1",
            params![quote_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(order_id) = order_id {
        return Ok(Some(("la commande", order_id)));
    }
    Ok(None)
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
        ("sales_orders", "commandes clients"),
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

fn ensure_client_sales_empty_before_delete(
    transaction: &Transaction<'_>,
    client_id: &str,
) -> AppResult<()> {
    let orders: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM sales_orders WHERE client_id=?",
        params![client_id],
        |row| row.get(0),
    )?;
    if orders > 0 {
        return Err(AppError::Validation(format!(
            "Le client ne peut pas être supprimé car {orders} commande(s) client, leurs livraisons, réservations ou allocations y sont liées. Archivez le client à la place."
        )));
    }
    Ok(())
}

fn ensure_catalog_sales_empty_before_delete(
    transaction: &Transaction<'_>,
    catalog_item_id: &str,
) -> AppResult<()> {
    let order_lines: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM sales_order_lines WHERE catalog_item_id=?",
        params![catalog_item_id],
        |row| row.get(0),
    )?;
    let reservation_events: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM stock_reservation_events WHERE catalog_item_id=?",
        params![catalog_item_id],
        |row| row.get(0),
    )?;
    if order_lines > 0 || reservation_events > 0 {
        return Err(AppError::Validation(format!(
            "L'article ne peut pas être supprimé car il est lié à {order_lines} ligne(s) de commande et {reservation_events} événement(s) de réservation/livraison. Archivez-le à la place."
        )));
    }
    Ok(())
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

fn validate_invoice_deposit_percentage(
    object: &Map<String, Value>,
    require_deposit_basis: bool,
) -> AppResult<()> {
    let invoice_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("standard");
    let percentage = object.get("deposit_percentage_bp");

    if invoice_type == "acompte" {
        if percentage
            .and_then(Value::as_i64)
            .is_some_and(|value| (1..=10_000).contains(&value))
        {
            validate_deposit_basis_json(object.get("deposit_basis_json"))?;
            if require_deposit_basis
                && parsed_deposit_basis(object.get("deposit_basis_json"))?.is_none()
            {
                return Err(AppError::Validation(
                    "Une nouvelle facture d'acompte exige une base détaillée non vide.".into(),
                ));
            }
            return Ok(());
        }
        return Err(AppError::Validation(
            "Une facture d'acompte exige deposit_percentage_bp entre 1 et 10000 (0,01 % à 100 %)."
                .into(),
        ));
    }

    if percentage.is_some_and(|value| !value.is_null()) {
        return Err(AppError::Validation(
            "deposit_percentage_bp doit être null pour une facture qui n'est pas un acompte."
                .into(),
        ));
    }
    if object
        .get("deposit_basis_json")
        .is_some_and(|value| !value.is_null())
    {
        return Err(AppError::Validation(
            "deposit_basis_json doit être null pour une facture qui n'est pas un acompte.".into(),
        ));
    }
    Ok(())
}

fn parsed_deposit_basis(value: Option<&Value>) -> AppResult<Option<Vec<Map<String, Value>>>> {
    let parsed = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(lines)) => Value::Array(lines.clone()),
        Some(Value::String(serialized)) => serde_json::from_str(serialized).map_err(|_| {
            AppError::Validation("deposit_basis_json doit contenir un tableau JSON valide.".into())
        })?,
        Some(_) => {
            return Err(AppError::Validation(
                "deposit_basis_json doit contenir un tableau JSON valide.".into(),
            ))
        }
    };
    let lines = parsed.as_array().ok_or_else(|| {
        AppError::Validation("deposit_basis_json doit contenir un tableau JSON valide.".into())
    })?;
    if lines.is_empty() {
        return Err(AppError::Validation(
            "La base détaillée de l'acompte ne peut pas être vide.".into(),
        ));
    }
    if lines.len() > 5_000 {
        return Err(AppError::Validation(
            "La base détaillée de l'acompte dépasse 5000 lignes.".into(),
        ));
    }
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            line.as_object().cloned().ok_or_else(|| {
                AppError::Validation(format!(
                    "La ligne {} de la base d'acompte doit être un objet.",
                    index + 1
                ))
            })
        })
        .collect::<AppResult<Vec<_>>>()
        .map(Some)
}

fn validate_deposit_basis_json(value: Option<&Value>) -> AppResult<()> {
    let Some(lines) = parsed_deposit_basis(value)? else {
        // Compatibilité : les acomptes historiques ne possédaient pas cette
        // base séparée. Ils restent lisibles et peuvent être migrés au prochain
        // enregistrement depuis l'éditeur.
        return Ok(());
    };
    const ALLOWED: &[&str] = &[
        "id",
        "catalog_item_id",
        "description",
        "quantity",
        "unit",
        "unit_price_cents",
        "discount_bp",
        "vat_bp",
    ];
    for (index, line) in lines.iter().enumerate() {
        validate_keys(line, ALLOWED)?;
        let row = index + 1;
        required_text(
            line.get("description")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            &format!("deposit_basis_json[{row}].description"),
            10_000,
        )?;
        required_text(
            line.get("unit").and_then(Value::as_str).unwrap_or_default(),
            &format!("deposit_basis_json[{row}].unit"),
            80,
        )?;
        if line
            .get("id")
            .is_some_and(|id| !id.is_null() && id.as_str().is_none_or(str::is_empty))
        {
            return Err(AppError::Validation(format!(
                "deposit_basis_json[{row}].id doit être un texte non vide ou null."
            )));
        }
        if line.get("catalog_item_id").is_some_and(|catalog_id| {
            !catalog_id.is_null()
                && catalog_id
                    .as_str()
                    .is_none_or(|identifier| identifier.trim().is_empty())
        }) {
            return Err(AppError::Validation(format!(
                "deposit_basis_json[{row}].catalog_item_id doit être un texte non vide ou null."
            )));
        }
        let quantity = line.get("quantity").and_then(Value::as_f64).unwrap_or(0.0);
        if !quantity.is_finite() || quantity <= 0.0 {
            return Err(AppError::Validation(format!(
                "deposit_basis_json[{row}].quantity doit être strictement positive."
            )));
        }
        let unit_price = line
            .get("unit_price_cents")
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        if !(0..=9_000_000_000_000_000).contains(&unit_price) {
            return Err(AppError::Validation(format!(
                "deposit_basis_json[{row}].unit_price_cents est hors de la plage monétaire sûre."
            )));
        }
        for field in ["discount_bp", "vat_bp"] {
            if !line
                .get(field)
                .and_then(Value::as_i64)
                .is_some_and(|basis_points| (0..=10_000).contains(&basis_points))
            {
                return Err(AppError::Validation(format!(
                    "deposit_basis_json[{row}].{field} doit être un entier entre 0 et 10000."
                )));
            }
        }
    }
    Ok(())
}

fn validate_deposit_basis_matches_items(
    transaction: &Transaction<'_>,
    invoice_id: &str,
) -> AppResult<()> {
    let (invoice_type, percentage_bp, serialized_basis): (String, Option<i64>, Option<String>) =
        transaction
            .query_row(
                "SELECT type,deposit_percentage_bp,deposit_basis_json FROM invoices WHERE id=?",
                params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("invoices/{invoice_id}")))?;
    if invoice_type != "acompte" {
        return Ok(());
    }
    let Some(serialized_basis) = serialized_basis else {
        return Ok(());
    };
    let percentage_bp = percentage_bp.ok_or_else(|| {
        AppError::Validation("Le pourcentage de la facture d'acompte est manquant.".into())
    })?;
    let basis_value = Value::String(serialized_basis);
    let basis_lines = parsed_deposit_basis(Some(&basis_value))?.ok_or_else(|| {
        AppError::Validation("La base détaillée de la facture d'acompte est manquante.".into())
    })?;
    let actual_lines = {
        let mut statement = transaction.prepare(
            "SELECT catalog_item_id,quantity,unit,unit_price_cents,discount_bp,vat_bp
               FROM invoice_items WHERE invoice_id=? ORDER BY position,rowid",
        )?;
        let rows = statement
            .query_map(params![invoice_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    if basis_lines.len() != actual_lines.len() {
        return Err(AppError::Validation(
            "Les lignes facturées ne correspondent pas à la base détaillée de l'acompte.".into(),
        ));
    }
    for (index, (basis, actual)) in basis_lines.iter().zip(actual_lines).enumerate() {
        let quantity = basis.get("quantity").and_then(Value::as_f64).unwrap_or(0.0);
        let unit_price = basis
            .get("unit_price_cents")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let discount_bp = basis
            .get("discount_bp")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let vat_bp = basis.get("vat_bp").and_then(Value::as_i64).unwrap_or(0);
        let raw_subtotal = quantity * unit_price as f64;
        if !raw_subtotal.is_finite() || raw_subtotal.abs() > 9_000_000_000_000_000_f64 {
            return Err(AppError::Validation(format!(
                "La ligne {} de la base d'acompte dépasse la plage monétaire sûre.",
                index + 1
            )));
        }
        let base_subtotal = raw_subtotal.round() as i64;
        let base_discount = round_basis_points(base_subtotal, discount_bp);
        let expected_amount = round_basis_points(base_subtotal - base_discount, percentage_bp);
        let (catalog_item_id, actual_quantity, unit, amount, actual_discount, actual_vat) = actual;
        if catalog_item_id.is_some()
            || (actual_quantity - 1.0).abs() > f64::EPSILON
            || unit != "acompte"
            || amount != expected_amount
            || actual_discount != 0
            || actual_vat != vat_bp
        {
            return Err(AppError::Validation(format!(
                "La ligne {} facturée ne correspond pas au pourcentage et à la base détaillée de l'acompte.",
                index + 1
            )));
        }
    }
    Ok(())
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
            validate_invoice_deposit_percentage(object, creating)?;
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
            for (field, maximum) in [
                ("employment_contract_kind", 20),
                ("lpp_exception_code", 40),
                ("lpp_exception_evidence_reference", 500),
                ("small_salary_sector", 30),
                ("small_salary_evidence_reference", 500),
                ("small_salary_decision_date", 10),
            ] {
                match object.get(field).cloned() {
                    Some(Value::String(value)) => {
                        let trimmed = value.trim();
                        if trimmed.is_empty() {
                            object.insert(field.into(), Value::Null);
                        } else if trimmed.chars().count() <= maximum {
                            object.insert(field.into(), Value::String(trimmed.to_owned()));
                        } else {
                            return Err(AppError::Validation(format!(
                                "{field} ne peut pas dépasser {maximum} caractères."
                            )));
                        }
                    }
                    Some(Value::Null) | None => {}
                    Some(_) => {
                        return Err(AppError::Validation(format!(
                            "{field} doit être du texte ou null."
                        )))
                    }
                }
            }
            let employment_contract_kind = object
                .get("employment_contract_kind")
                .and_then(Value::as_str);
            if employment_contract_kind
                .is_some_and(|value| !matches!(value, "indefinite" | "fixed"))
            {
                return Err(AppError::Validation(
                    "employment_contract_kind doit être indefinite, fixed ou null.".into(),
                ));
            }
            if employment_contract_kind == Some("fixed") && (start.is_none() || end.is_none()) {
                return Err(AppError::Validation(
                    "Un contrat fixed exige ses dates de début et de fin.".into(),
                ));
            }

            let lpp_assessment_year = object.get("lpp_assessment_year");
            let lpp_annual_salary = object.get("lpp_annual_salary_cents");
            let assessment_year_present = lpp_assessment_year.is_some_and(|value| !value.is_null());
            let annual_salary_present = lpp_annual_salary.is_some_and(|value| !value.is_null());
            if assessment_year_present != annual_salary_present {
                return Err(AppError::Validation(
                    "L’année d’évaluation LPP et le salaire annuel LPP doivent être confirmés ensemble, même si le salaire vaut zéro."
                        .into(),
                ));
            }
            if assessment_year_present
                && !lpp_assessment_year
                    .and_then(Value::as_i64)
                    .is_some_and(|year| (1900..=9999).contains(&year))
            {
                return Err(AppError::Validation(
                    "lpp_assessment_year doit être une année comprise entre 1900 et 9999.".into(),
                ));
            }
            if annual_salary_present
                && !lpp_annual_salary
                    .and_then(Value::as_i64)
                    .is_some_and(|salary| salary >= 0)
            {
                return Err(AppError::Validation(
                    "lpp_annual_salary_cents doit être un montant entier positif ou nul.".into(),
                ));
            }

            let lpp_exception_code = object.get("lpp_exception_code").and_then(Value::as_str);
            if lpp_exception_code
                .is_some_and(|value| !matches!(value, "short_fixed_contract" | "other_legal"))
            {
                return Err(AppError::Validation(
                    "lpp_exception_code doit être short_fixed_contract, other_legal ou null."
                        .into(),
                ));
            }
            let exception_evidence_present = object
                .get("lpp_exception_evidence_reference")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty());
            if lpp_exception_code.is_some() != exception_evidence_present {
                return Err(AppError::Validation(
                    "Une exception LPP exige simultanément son code et une référence de preuve non vide."
                        .into(),
                ));
            }
            if lpp_exception_code == Some("short_fixed_contract")
                && (employment_contract_kind != Some("fixed") || start.is_none() || end.is_none())
            {
                return Err(AppError::Validation(
                    "L’exception LPP short_fixed_contract exige un contrat fixed et ses deux dates."
                        .into(),
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
            let laa_opening_year = object.get("laa_opening_year");
            let laa_opening_basis = object.get("laa_opening_basis_cents");
            let laa_year_present = laa_opening_year.is_some_and(|value| !value.is_null());
            let laa_basis_present = laa_opening_basis.is_some_and(|value| !value.is_null());
            if laa_year_present != laa_basis_present {
                return Err(AppError::Validation(
                    "L’année et la base d’ouverture LAA doivent être confirmées ensemble, même si la base est zéro."
                        .into(),
                ));
            }
            if laa_year_present
                && !laa_opening_year
                    .and_then(Value::as_i64)
                    .is_some_and(|year| (1900..=9999).contains(&year))
            {
                return Err(AppError::Validation(
                    "laa_opening_year doit être une année comprise entre 1900 et 9999.".into(),
                ));
            }
            if laa_basis_present
                && !laa_opening_basis
                    .and_then(Value::as_i64)
                    .is_some_and(|basis| basis >= 0)
            {
                return Err(AppError::Validation(
                    "laa_opening_basis_cents doit être un montant entier positif ou nul.".into(),
                ));
            }

            let small_salary_fields = [
                "small_salary_assessment_year",
                "small_salary_decision_date",
                "small_salary_sector",
                "small_salary_employee_requested_contributions",
                "small_salary_opening_gross_cents",
                "small_salary_opening_contributed_basis_cents",
                "small_salary_evidence_reference",
            ];
            let confirmed_small_salary_fields = small_salary_fields
                .iter()
                .filter(|field| object.get(**field).is_some_and(|value| !value.is_null()))
                .count();
            if !matches!(confirmed_small_salary_fields, 0 | 7) {
                return Err(AppError::Validation(
                    "Les sept champs de décision annuelle des salaires de minime importance doivent être confirmés ensemble, même si les montants valent zéro et la demande salarié vaut non."
                        .into(),
                ));
            }
            if confirmed_small_salary_fields == 7 {
                if !object
                    .get("small_salary_assessment_year")
                    .and_then(Value::as_i64)
                    .is_some_and(|year| (1900..=9999).contains(&year))
                {
                    return Err(AppError::Validation(
                        "small_salary_assessment_year doit être une année comprise entre 1900 et 9999."
                            .into(),
                    ));
                }
                if !object
                    .get("small_salary_sector")
                    .and_then(Value::as_str)
                    .is_some_and(|sector| {
                        matches!(sector, "ordinary" | "private_household" | "arts_culture")
                    })
                {
                    return Err(AppError::Validation(
                        "small_salary_sector doit être ordinary, private_household ou arts_culture."
                            .into(),
                    ));
                }
                if object
                    .get("small_salary_employee_requested_contributions")
                    .is_some_and(|value| {
                        value.as_bool().is_none()
                            && !value.as_i64().is_some_and(|flag| matches!(flag, 0 | 1))
                    })
                {
                    return Err(AppError::Validation(
                        "small_salary_employee_requested_contributions doit être oui ou non."
                            .into(),
                    ));
                }
                for field in [
                    "small_salary_opening_gross_cents",
                    "small_salary_opening_contributed_basis_cents",
                ] {
                    if !object
                        .get(field)
                        .and_then(Value::as_i64)
                        .is_some_and(|amount| amount >= 0)
                    {
                        return Err(AppError::Validation(format!(
                            "{field} doit être un montant entier positif ou nul."
                        )));
                    }
                }
                let opening_gross = object["small_salary_opening_gross_cents"]
                    .as_i64()
                    .expect("validated opening gross");
                let opening_contributed = object["small_salary_opening_contributed_basis_cents"]
                    .as_i64()
                    .expect("validated opening contributed basis");
                if opening_contributed > opening_gross {
                    return Err(AppError::Validation(
                        "La base d'ouverture déjà cotisée ne peut pas dépasser le salaire brut d'ouverture."
                            .into(),
                    ));
                }
                if !object
                    .get("small_salary_evidence_reference")
                    .and_then(Value::as_str)
                    .is_some_and(|reference| {
                        !reference.is_empty() && reference.chars().count() <= 500
                    })
                {
                    return Err(AppError::Validation(
                        "small_salary_evidence_reference est obligatoire et limitée à 500 caractères."
                        .into(),
                    ));
                }
                let assessment_year = object["small_salary_assessment_year"]
                    .as_i64()
                    .expect("validated small salary assessment year");
                let decision_date = object
                    .get("small_salary_decision_date")
                    .and_then(Value::as_str)
                    .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
                    .ok_or_else(|| {
                        AppError::Validation(
                            "small_salary_decision_date doit être une date valide au format AAAA-MM-JJ."
                                .into(),
                        )
                    })?;
                if i64::from(decision_date.year()) != assessment_year {
                    return Err(AppError::Validation(
                        "small_salary_decision_date doit appartenir à l'année d'évaluation.".into(),
                    ));
                }
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
    if entity == "invoices"
        && merged.get("type").and_then(Value::as_str) == Some("acompte")
        && parsed_deposit_basis(merged.get("deposit_basis_json"))?.is_none()
    {
        let previous_was_legacy_deposit =
            matches!(
                previous.get("type").and_then(Value::as_str),
                Some("acompte" | "deposit")
            ) && parsed_deposit_basis(previous.get("deposit_basis_json"))?.is_none();
        if !previous_was_legacy_deposit {
            return Err(AppError::Validation(
                "Une facture d'acompte exige une base détaillée non vide.".into(),
            ));
        }
    }

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

fn deposit_line_description(percentage_bp: i64, description: &str) -> String {
    let whole = percentage_bp / 100;
    let decimals = percentage_bp % 100;
    let percentage = if decimals == 0 {
        whole.to_string()
    } else if decimals % 10 == 0 {
        format!("{whole},{}", decimals / 10)
    } else {
        format!("{whole},{decimals:02}")
    };
    format!("Acompte {percentage} % — {}", description.trim())
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
    match object.get("iban").cloned() {
        Some(Value::String(iban)) if iban.trim().is_empty() => {
            object.insert("iban".into(), Value::Null);
        }
        Some(Value::String(iban)) => {
            object.insert(
                "iban".into(),
                Value::String(normalize_and_validate_iban(&iban)?),
            );
        }
        Some(Value::Null) | None => {}
        Some(_) => {
            return Err(AppError::Validation(
                "iban doit être une chaîne de caractères ou null.".into(),
            ));
        }
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
    let raw_date = input
        .date
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::Validation(
                "La date réelle de l'encaissement est obligatoire; Zentra ne la remplace jamais par la date du jour."
                    .into(),
            )
        })?;
    let date = normalized_date(raw_date, "date")?;
    let method = clean_optional(input.method, 80);
    let reference = clean_optional(input.reference, 160);
    let notes = clean_optional(input.notes, 5000);
    let request_id = Uuid::parse_str(input.request_id.trim())
        .map(|parsed| parsed.to_string())
        .map_err(|_| {
            AppError::Validation(
                "request_id doit être un UUID valide pour sécuriser la reprise du paiement.".into(),
            )
        })?;
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
            // Une reprise ne se contente pas de retrouver la ligne métier : elle
            // revalide la preuve comptable historique sans la recalculer avec une
            // configuration de comptes qui a pu changer depuis. Elle reste donc
            // idempotente même après clôture de la période concernée.
            return payment_record_with_journal(transaction, &request_id);
        }
        return Err(AppError::Validation(
            "Cet identifiant de reprise correspond déjà à un autre paiement. Rechargez la facture avant de réessayer."
                .into(),
        ));
    }
    ensure_accounting_date_open(transaction, &date)?;
    let (total_cents, paid_cents, credited_cents, invoice_type, invoice_status, number, issue_date): (
        i64,
        i64,
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
    ) = transaction
        .query_row(
            "SELECT i.total_cents,COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id=i.id),0),COALESCE((SELECT SUM(-c.total_cents) FROM invoices c WHERE c.type='avoir' AND c.original_invoice_id=i.id AND c.number IS NOT NULL AND c.status<>'annulee'),0),i.type,i.status,i.number,i.issue_date FROM invoices i WHERE i.id = ?",
            params![input.invoice_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("invoices/{}", input.invoice_id)))?;
    if invoice_type == "avoir" {
        return Err(AppError::Validation(
            "Un avoir ne peut recevoir aucun encaissement.".into(),
        ));
    }
    if !matches!(
        invoice_status.as_str(),
        "emise" | "en_retard" | "partiellement_payee" | "payee"
    ) {
        return Err(AppError::Validation(
            "Seule une facture émise et active peut recevoir un encaissement.".into(),
        ));
    }
    if number.is_none() {
        return Err(AppError::Validation(
            "La facture doit être émise avant tout paiement.".into(),
        ));
    }
    let issue_date = issue_date
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::Validation("La facture émise n'a pas de date d'émission.".into())
        })?;
    if date < issue_date {
        return Err(AppError::Validation(
            "La date du paiement ne peut pas précéder la date d'émission de la facture. Un acompte antérieur doit suivre un flux d'avance distinct."
                .into(),
        ));
    }
    if total_cents <= 0 {
        return Err(AppError::Validation(
            "Cette facture ne possède aucun montant payable.".into(),
        ));
    }
    let settled_after_payment = paid_cents
        .checked_add(credited_cents)
        .and_then(|value| value.checked_add(input.amount_cents))
        .ok_or_else(|| {
            AppError::Validation(
                "Le cumul des paiements et avoirs dépasse la capacité monétaire locale.".into(),
            )
        })?;
    if settled_after_payment > total_cents {
        return Err(AppError::Validation(
            "Le paiement dépasse le solde restant de la facture.".into(),
        ));
    }
    let id = request_id;
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
    let journal = post_payment_if_enabled(transaction, &id)?.ok_or_else(|| {
        AppError::Validation(
            "Activez la comptabilité et ses comptes de liaison avant d'enregistrer un paiement client. L'opération a été annulée sans modifier la facture."
                .into(),
        )
    })?;
    let record = payment_record_with_journal(transaction, &id)?;
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

/// Retourne la preuve de liaison comptable avec le paiement. Le lien reste
/// dérivable du triplet immuable `(source_type, source_id, source_event)` du
/// journal et ne dépend donc pas d'une donnée dupliquée dans `payments`.
pub(crate) fn payment_record_with_journal(
    transaction: &Transaction<'_>,
    payment_id: &str,
) -> AppResult<Value> {
    validate_payment_for_accounting(transaction, payment_id)?;
    let record = query_optional_tx(
        transaction,
        "SELECT payment.*,
                entry.id AS journal_entry_id,
                entry.number AS journal_entry_number,
                entry.source_event AS journal_source_event,
                (
                  WITH RECURSIVE reversal_chain(id,depth) AS (
                    SELECT entry.id,0
                    UNION ALL
                    SELECT child.id,reversal_chain.depth+1
                    FROM reversal_chain
                    JOIN journal_entries child ON child.reversal_of=reversal_chain.id
                  )
                  SELECT COALESCE(MAX(depth),0)%2=0 FROM reversal_chain
                ) AS journal_entry_is_active,
                (
                  WITH RECURSIVE reversal_chain(id,depth) AS (
                    SELECT entry.id,0
                    UNION ALL
                    SELECT child.id,reversal_chain.depth+1
                    FROM reversal_chain
                    JOIN journal_entries child ON child.reversal_of=reversal_chain.id
                  )
                  SELECT COALESCE(MAX(depth),0) FROM reversal_chain
                ) AS journal_reversal_depth
         FROM payments payment
         JOIN journal_entries entry
           ON entry.source_type='payment'
          AND entry.source_id=payment.id
          AND entry.source_event='invoice:'||payment.invoice_id
         WHERE payment.id=?",
        params![payment_id],
    )?
    .ok_or_else(|| {
        AppError::Validation(format!(
            "Le paiement {payment_id} n'est pas relié à son écriture comptable attendue."
        ))
    })?;
    let journal_id = record["journal_entry_id"]
        .as_str()
        .ok_or_else(|| AppError::Validation("Lien de journal du paiement invalide.".into()))?;
    let valid: bool = transaction.query_row(
        "WITH RECURSIVE reversal_chain(id,depth) AS (
             SELECT ?1,0
             UNION ALL
             SELECT child.id,reversal_chain.depth+1
             FROM reversal_chain
             JOIN journal_entries child ON child.reversal_of=reversal_chain.id
         )
         SELECT
           entry.entry_date=payment.date
           AND entry.description='Paiement client'
           AND entry.reversal_of IS NULL
           AND (SELECT MAX(depth) FROM reversal_chain)%2=0
           AND (SELECT COUNT(*) FROM journal_lines line WHERE line.journal_entry_id=entry.id)=2
           AND (SELECT COALESCE(SUM(line.debit_cents),0) FROM journal_lines line WHERE line.journal_entry_id=entry.id)=payment.amount_cents
           AND (SELECT COALESCE(SUM(line.credit_cents),0) FROM journal_lines line WHERE line.journal_entry_id=entry.id)=payment.amount_cents
           AND (SELECT COUNT(*)
                FROM journal_lines line JOIN accounts account ON account.id=line.account_id
                WHERE line.journal_entry_id=entry.id AND line.debit_cents=payment.amount_cents
                  AND line.credit_cents=0 AND line.currency=invoice.currency
                  AND line.memo='Encaissement' AND account.active=1 AND account.account_type='asset'
                  AND line.project_id IS invoice.project_id AND line.client_id IS invoice.client_id
                  AND line.employee_id IS NULL)=1
           AND (SELECT COUNT(*)
                FROM journal_lines line JOIN accounts account ON account.id=line.account_id
                WHERE line.journal_entry_id=entry.id AND line.debit_cents=0
                  AND line.credit_cents=payment.amount_cents AND line.currency=invoice.currency
                  AND line.memo='Règlement créance' AND account.active=1 AND account.account_type='asset'
                  AND line.project_id IS invoice.project_id AND line.client_id IS invoice.client_id
                  AND line.employee_id IS NULL)=1
           AND (SELECT line.account_id FROM journal_lines line WHERE line.journal_entry_id=entry.id AND line.memo='Encaissement' LIMIT 1)
               <>(SELECT line.account_id FROM journal_lines line WHERE line.journal_entry_id=entry.id AND line.memo='Règlement créance' LIMIT 1)
           AND (SELECT line.account_id FROM journal_lines line WHERE line.journal_entry_id=entry.id AND line.memo='Règlement créance' LIMIT 1)
               =(SELECT original_line.account_id FROM journal_entries original
                 JOIN journal_lines original_line ON original_line.journal_entry_id=original.id
                WHERE original.source_type='invoice' AND original.source_id=payment.invoice_id
                  AND original.source_event='issue' AND original_line.memo='Créance client' LIMIT 1)
           AND (WITH RECURSIVE invoice_chain(id,depth) AS (
                  SELECT original.id,0 FROM journal_entries original
                   WHERE original.source_type='invoice' AND original.source_id=payment.invoice_id
                     AND original.source_event='issue' AND original.reversal_of IS NULL
                  UNION ALL
                  SELECT child.id,invoice_chain.depth+1 FROM invoice_chain
                  JOIN journal_entries child ON child.reversal_of=invoice_chain.id
                )
                SELECT COUNT(*)>0 AND COALESCE(MAX(depth),1)%2=0 FROM invoice_chain)
         FROM payments payment
         JOIN invoices invoice ON invoice.id=payment.invoice_id
         JOIN journal_entries entry ON entry.id=?1
         WHERE payment.id=?2 AND entry.source_type='payment'
           AND entry.source_id=payment.id
           AND entry.source_event='invoice:'||payment.invoice_id",
        params![journal_id, payment_id],
        |row| row.get(0),
    )?;
    if !valid {
        return Err(AppError::Validation(format!(
            "L'écriture comptable reliée au paiement {payment_id} n'est plus active, équilibrée ou conforme à sa source. La reprise est bloquée."
        )));
    }
    let invoice_id = record["invoice_id"]
        .as_str()
        .ok_or_else(|| AppError::Validation("Facture du paiement invalide.".into()))?;
    let invoice_status: String = transaction.query_row(
        "SELECT status FROM invoices WHERE id=?",
        params![invoice_id],
        |row| row.get(0),
    )?;
    if !matches!(
        invoice_status.as_str(),
        "emise" | "en_retard" | "partiellement_payee" | "payee"
    ) {
        return Err(AppError::Validation(format!(
            "La facture liée au paiement {payment_id} n'est plus active. La reprise est bloquée."
        )));
    }
    if !cash_vat_invoice_is_consistent(transaction, invoice_id)? {
        return Err(AppError::Validation(format!(
            "La chaîne de TVA sur encaissements liée au paiement {payment_id} est absente ou incohérente. La reprise est bloquée."
        )));
    }
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
    let settled = paid.checked_add(credited).ok_or_else(|| {
        AppError::Validation(
            "Le cumul des paiements et avoirs dépasse la capacité monétaire locale.".into(),
        )
    })?;
    transaction.execute(
        "UPDATE invoices SET paid_cents=?, status=CASE WHEN status='annulee' THEN status WHEN ? >= total_cents AND total_cents > 0 THEN 'payee' WHEN ? > 0 THEN 'partiellement_payee' WHEN number IS NOT NULL THEN 'emise' ELSE 'brouillon' END, updated_at=? WHERE id=?",
        params![paid, settled, paid, now_iso(), invoice_id],
    )?;
    Ok(())
}

pub(crate) fn assign_document_number(
    transaction: &Transaction<'_>,
    table: &str,
    id: &str,
    document_type: &str,
    issue_date: &str,
) -> AppResult<String> {
    if matches!(document_type, "quote" | "invoice" | "credit_note") {
        require_setup_confirmed(transaction, "billing")?;
    }
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
        "sales_order" => ("sales_order_prefix", "sales_order_start_number"),
        "delivery_note" => ("delivery_note_prefix", "delivery_note_start_number"),
        "supplier_order" => ("supplier_order_prefix", "supplier_order_start_number"),
        "supplier_receipt" => ("supplier_receipt_prefix", "supplier_receipt_start_number"),
        "supplier_credit_note" => ("supplier_credit_prefix", "supplier_credit_start_number"),
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

pub(crate) fn require_setup_confirmed(transaction: &Transaction<'_>, area: &str) -> AppResult<()> {
    let extra_settings_json: String = transaction.query_row(
        "SELECT extra_settings_json FROM settings WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    let extra: Value = serde_json::from_str(&extra_settings_json)?;
    let deferred = extra
        .pointer(&format!("/setupDeferred/{area}"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !deferred {
        return Ok(());
    }
    let message = match area {
        "billing" => "Confirmez les réglages de facturation dans Paramètres avant d’émettre ou numéroter un document.",
        "work" => "Confirmez les règles de temps et de coûts dans Paramètres avant de saisir ou chronométrer des heures.",
        _ => "Confirmez les réglages différés dans Paramètres avant de continuer.",
    };
    Err(AppError::Validation(message.into()))
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
    let settings = build_issuer_snapshot(transaction)?;
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

/// Construit l'identité documentaire de l'entreprise à l'instant d'émission.
/// Tous les documents finalisés partagent cette sélection, notamment le chemin
/// du logo local immuable et le numéro de bâtiment conservé dans les réglages
/// étendus.
pub(crate) fn build_issuer_snapshot(transaction: &Transaction<'_>) -> AppResult<Value> {
    let active_logo: Option<String> = transaction
        .query_row("SELECT logo_path FROM settings WHERE id=1", [], |row| {
            row.get(0)
        })
        .optional()?
        .flatten();
    if let Some(active_logo) = active_logo.filter(|path| !path.trim().is_empty()) {
        stage_active_company_logo_for_snapshot(transaction, &active_logo).map_err(|error| {
            AppError::Validation(format!(
                "Le logo actif n'a pas pu être figé dans le stockage local avant l'émission : {error}"
            ))
        })?;
    }
    enrich_issuer_snapshot(
        query_optional_tx(
            transaction,
            "SELECT company_name,legal_form,owner_name,email,phone,address_line1,address_line2,postal_code,city,canton,country,uid_number,vat_number,vat_registered,iban,bank_name,currency,logo_path,extra_settings_json,noga_section,noga_division,activity_description,noga_detailed_code FROM settings WHERE id=1",
            [],
        )?
        .ok_or(AppError::OnboardingRequired)?,
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
            | "all_day"
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
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return tauri_plugin_zentra_mobile::share_file(path).map_err(AppError::Validation);
    }
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
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(path).spawn()?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(AppError::UnsupportedPlatform)
}

#[cfg(test)]
mod v21_migration_tests {
    use super::*;

    #[test]
    fn migration_v20_to_v21_preserves_rows_stock_sequence_and_is_idempotent() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            tx.execute_batch(SCHEMA_SQL).unwrap();
            migrate_v20(&tx).unwrap();
            tx.execute(
                "INSERT INTO clients(id,name,created_at,updated_at) VALUES('client-v20','Client conservé','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO catalog_items(id,kind,name,track_stock,stock_quantity_milli,created_at,updated_at) VALUES('item-v20','product','Stock conservé',1,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO stock_movements(sequence,id,source_key,request_id,request_sha256,request_json,catalog_item_id,movement_type,quantity_delta_milli,balance_after_milli,reason,movement_date,source_type,created_at) VALUES(41,'movement-v20','manual:5b2d9677-4b14-4651-8ae5-d1ae981089a8','5b2d9677-4b14-4651-8ae5-d1ae981089a8','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}','item-v20','entry',1250,1250,'Stock réel conservé','2026-01-01','manual','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            20
        );
        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v21(&tx).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            21
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT name FROM clients WHERE id='client-v20'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "Client conservé"
        );
        let movement: (i64, i64, Option<String>, Option<String>) = connection.query_row(
            "SELECT sequence,quantity_delta_milli,supplier_receipt_id,supplier_receipt_line_id FROM stock_movements WHERE id='movement-v20'",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).unwrap();
        assert_eq!(movement, (41, 1_250, None, None));
        for table in [
            "supplier_orders",
            "supplier_receipts",
            "supplier_invoice_matches",
            "supplier_credit_notes",
            "supplier_expense_reclassifications",
        ] {
            assert_eq!(
                connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0,
                "{table} doit être vide après migration"
            );
        }
        connection.pragma_update(None, "user_version", 20).unwrap();
        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v21(&tx).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM stock_movements WHERE id='movement-v20'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }
}

#[cfg(test)]
mod v22_migration_tests {
    use super::*;

    #[test]
    fn migration_v21_to_v22_preserves_business_rows_and_seeds_no_compliance_data() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            tx.execute_batch(SCHEMA_SQL).unwrap();
            migrate_v20(&tx).unwrap();
            migrate_v21(&tx).unwrap();
            tx.execute(
                "INSERT INTO clients(id,name,created_at,updated_at) VALUES('client-v21','Client conservé V22','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            21
        );
        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v22(&tx).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            22
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT name FROM clients WHERE id='client-v21'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "Client conservé V22"
        );
        for table in [
            "vat_profiles",
            "vat_source_classifications",
            "vat_adjustments",
            "vat_return_exports",
            "closing_reviews",
            "closing_package_exports",
        ] {
            assert_eq!(
                connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0,
                "{table} doit rester vide après migration"
            );
        }
        connection.pragma_update(None, "user_version", 21).unwrap();
        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v22(&tx).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM clients WHERE id='client-v21'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }
}

#[cfg(test)]
mod v24_migration_tests {
    use super::*;

    #[test]
    fn migration_v23_to_v24_preserves_reminders_and_installs_empty_guarded_ledgers() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            tx.execute_batch(SCHEMA_SQL).unwrap();
            migrate_v20(&tx).unwrap();
            migrate_v21(&tx).unwrap();
            migrate_v22(&tx).unwrap();
            migrate_v23(&tx).unwrap();
            tx.execute(
                "INSERT INTO clients(id,name,email,created_at,updated_at) VALUES('client-v23','Client relance V23','client@example.ch','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO invoices(id,client_id,number,title,type,status,issue_date,due_date,currency,total_cents,paid_cents,created_at,updated_at) VALUES('invoice-v23','client-v23','F-2026-0001','Facture relance V23','standard','emise','2026-01-01','2026-01-31','CHF',12500,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO reminder_settings(id,enabled,sender_name,created_at,updated_at) VALUES(1,1,'Entreprise V23','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO reminder_templates(id,level,name,subject,body,days_after_due,active,created_at,updated_at) VALUES('template-v23',1,'Rappel V23','Facture {invoice_number}','Solde {balance_cents}',5,1,'2026-02-01T00:00:00Z','2026-02-01T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO reminders(id,invoice_id,template_id,level,scheduled_date,status,subject,body,invoice_number,currency,invoice_total_cents,balance_cents,snapshot_json,notes,created_at,updated_at) VALUES('reminder-v23','invoice-v23','template-v23',1,'2026-02-05','due','Facture F-2026-0001','Solde 12500','F-2026-0001','CHF',12500,12500,'{\"schema\":\"legacy-reminder-v23\"}','Note conservée','2026-02-05T00:00:00Z','2026-02-05T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO reminder_history(id,reminder_id,action,occurred_at,note) VALUES('history-v23','reminder-v23','created','2026-02-05T00:00:00Z','Historique conservé')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO invoices(id,client_id,number,title,type,status,issue_date,due_date,currency,total_cents,paid_cents,created_at,updated_at) VALUES('invoice-completed-v23','client-v23','F-2026-0002','Facture envoyée V23','standard','emise','2026-01-01','2026-01-31','CHF',9800,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO reminders(id,invoice_id,template_id,level,scheduled_date,status,subject,body,invoice_number,currency,invoice_total_cents,balance_cents,snapshot_json,notes,created_at,updated_at) VALUES('reminder-completed-v23','invoice-completed-v23','template-v23',1,'2026-02-10','completed','Facture F-2026-0002','Solde 9800','F-2026-0002','CHF',9800,9800,'{\"schema\":\"legacy-completed-v23\"}',NULL,'2026-02-10T00:00:00Z','2026-02-11T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO reminder_history(id,reminder_id,action,occurred_at,note) VALUES('history-sent-v23','reminder-completed-v23','sent_manually','2026-02-10T12:00:00Z','Envoi V23')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO reminder_history(id,reminder_id,action,occurred_at,note) VALUES('history-completed-v23','reminder-completed-v23','completed','2026-02-11T08:00:00Z','Traitée V23')",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            23
        );

        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v24(&tx).unwrap();
            tx.commit().unwrap();
        }

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            24
        );
        let settings: (i64, String, Option<String>) = connection
            .query_row(
                "SELECT enabled,sender_name,last_scan_at FROM reminder_settings WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(settings, (1, "Entreprise V23".into(), None));
        let template: (String, i64, i64) = connection
            .query_row(
                "SELECT name,days_after_due,payment_deadline_days FROM reminder_templates WHERE id='template-v23'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(template, ("Rappel V23".into(), 5, 10));
        let reminder: (String, String, i64, String) = connection
            .query_row(
                "SELECT status,notes,payment_deadline_days,snapshot_json FROM reminders WHERE id='reminder-v23'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(reminder.0, "due");
        assert_eq!(reminder.1, "Note conservée");
        assert_eq!(reminder.2, 10);
        let migrated_snapshot: Value = serde_json::from_str(&reminder.3).unwrap();
        assert_eq!(migrated_snapshot["schema"], "legacy-reminder-v23");
        assert_eq!(
            migrated_snapshot["template_subject"],
            "Facture {invoice_number}"
        );
        assert_eq!(migrated_snapshot["template_body"], "Solde {balance_cents}");
        assert_eq!(migrated_snapshot["days_after_due"], 5);
        assert_eq!(migrated_snapshot["payment_deadline_days"], 10);
        let completed_snapshot: String = connection
            .query_row(
                "SELECT snapshot_json FROM reminders WHERE id='reminder-completed-v23'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let completed_snapshot: Value = serde_json::from_str(&completed_snapshot).unwrap();
        assert_eq!(
            completed_snapshot["days_after_due"], 10,
            "le délai V23 envoyé vient de scheduled_date - due_date, jamais du modèle mutable J+5"
        );
        assert_eq!(
            completed_snapshot["days_after_due_recovered_from_schedule_v24"],
            true
        );
        let history: (String, String) = connection
            .query_row(
                "SELECT action,note FROM reminder_history WHERE id='history-v23'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(history, ("created".into(), "Historique conservé".into()));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM reminder_templates", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1,
            "la migration ne doit semer aucun modèle supplémentaire"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM reminders", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            2,
            "la migration ne doit semer aucune relance supplémentaire"
        );
        for table in ["reminder_operation_requests", "reminder_deliveries"] {
            assert_eq!(
                connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0,
                "{table} doit être créé vide"
            );
        }

        assert!(connection
            .execute(
                "UPDATE reminder_history SET note='altéré' WHERE id='history-v23'",
                [],
            )
            .is_err());
        assert!(connection
            .execute("DELETE FROM reminder_history WHERE id='history-v23'", [])
            .is_err());
        assert!(connection
            .execute(
                "UPDATE reminders SET status='planned' WHERE id='reminder-v23'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE reminders SET status='completed' WHERE id='reminder-v23'",
                [],
            )
            .is_err());
        connection
            .execute(
                "INSERT INTO reminder_deliveries(id,request_id,reminder_id,action,prepared_on,current_balance_cents,payment_deadline_date,subject,body,payload_sha256,payload_json,created_at) VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','reminder-v23','manual_sent','2026-02-05',12500,'2026-02-15','Facture F-2026-0001','Solde 12500','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}','2026-02-05T00:00:00Z')",
                [],
            )
            .unwrap();
        assert_eq!(
            connection
                .execute(
                    "UPDATE reminders SET status='completed' WHERE id='reminder-v23'",
                    [],
                )
                .unwrap(),
            1
        );
        assert!(connection
            .execute(
                "UPDATE reminders SET status='due' WHERE id='reminder-v23'",
                [],
            )
            .is_err());
        assert!(connection
            .execute("DELETE FROM reminders WHERE id='reminder-v23'", [])
            .is_err());

        connection
            .execute(
                "INSERT INTO reminder_operation_requests(request_id,operation,payload_sha256,payload_json,response_json,created_at) VALUES('11111111-1111-4111-8111-111111111111','scan',?1,'{}','{}','2026-02-05T00:00:00Z')",
                params!["a".repeat(64)],
            )
            .unwrap();
        assert!(connection
            .execute(
                "UPDATE reminder_operation_requests SET created_at='2026-02-06T00:00:00Z' WHERE request_id='11111111-1111-4111-8111-111111111111'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM reminder_operation_requests WHERE request_id='11111111-1111-4111-8111-111111111111'",
                [],
            )
            .is_err());

        connection
            .execute(
                "INSERT INTO reminder_deliveries(id,request_id,reminder_id,action,prepared_on,current_balance_cents,payment_deadline_date,subject,body,payload_sha256,payload_json,created_at) VALUES('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','reminder-v23','print_confirmed','2026-02-05',12500,'2026-02-15','Facture F-2026-0001','Solde CHF 125.00',?1,'{}','2026-02-05T00:00:00Z')",
                params!["b".repeat(64)],
            )
            .unwrap();
        assert!(connection
            .execute(
                "UPDATE reminder_deliveries SET subject='altéré' WHERE id='22222222-2222-4222-8222-222222222222'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM reminder_deliveries WHERE id='22222222-2222-4222-8222-222222222222'",
                [],
            )
            .is_err());
        assert_eq!(
            connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }
}

#[cfg(test)]
mod v25_migration_tests {
    use super::*;

    #[test]
    fn migration_dispatch_upgrades_a_profile_without_v29_v30_objects_to_latest() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        {
            let connection = store.connect().unwrap();
            connection
                .execute_batch(
                    "DROP TRIGGER IF EXISTS settings_logo_asset_insert_guard;
                     DROP TRIGGER IF EXISTS settings_logo_asset_update_guard;
                     DROP TRIGGER IF EXISTS payments_invoice_issue_date_guard;
                     DROP TRIGGER IF EXISTS invoices_issued_no_unsafe_cancel;
                     DROP TABLE IF EXISTS company_brand_assets;
                     INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at)
                     VALUES(1,0,'Profil pré-V29 conservé','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
                     PRAGMA user_version=28;",
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO payroll_contribution_definitions(
                       id,code,label,category,side,calculation_kind,rate_bp,
                       fixed_amount_cents,annual_ceiling_cents,basis_kind,source,
                       effective_from,effective_to,active,created_at,updated_at
                     ) VALUES(
                       'caf-vs-v28','CAF_VS_2026','CAF salarié VS 2026',
                       'family_allowance','employee','rate',13,NULL,NULL,'gross',?1,
                       '2026-01-01','2026-12-31',1,
                       '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'
                     )",
                    params!["https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/OrwD3z_mIEOztplxBzs7qQ/Document/Kantone_2026_f-1.pdf"],
                )
                .unwrap();
            let new_object_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name IN(
                       'company_brand_assets','settings_logo_asset_insert_guard',
                       'settings_logo_asset_update_guard','payments_invoice_issue_date_guard',
                       'invoices_issued_no_unsafe_cancel'
                     )",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(new_object_count, 0);
        }

        store.migrate().unwrap();

        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('payroll_document_imports') WHERE name='analysis_manifest_json'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT company_name FROM settings WHERE id=1", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "Profil pré-V29 conservé"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT source FROM payroll_contribution_definitions WHERE id='caf-vs-v28'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/Ypzfdm2t_km4jeHFYxWRdA/Document/Tableau%20synoptique%2020-1.pdf"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name IN(
                       'company_brand_assets','settings_logo_asset_insert_guard',
                       'settings_logo_asset_update_guard','payments_invoice_issue_date_guard',
                       'invoices_issued_no_unsafe_cancel'
                     )",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            5
        );
        drop(connection);

        store.migrate().unwrap();
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('payroll_document_imports') WHERE name='human_review_attested_at'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn migration_v24_to_v25_preserves_legacy_imports_and_adds_a_guarded_manifest() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            // V5 contient la forme historique exacte de la table d'import,
            // sans la colonne V25.
            tx.execute_batch(
                "CREATE TABLE employees(id TEXT PRIMARY KEY);
                 CREATE TABLE payslips(id TEXT PRIMARY KEY);
                 CREATE TABLE journal_entries(id TEXT PRIMARY KEY,reversal_of TEXT);",
            )
            .unwrap();
            tx.execute_batch(MIGRATION_V5_SQL).unwrap();
            tx.execute_batch("PRAGMA user_version=24;").unwrap();
            tx.execute(
                "INSERT INTO payroll_document_imports(id,source_name,stored_path,file_sha256,media_kind,file_size,page_count,extraction_engine,engine_version,draft_json,confidence_bp,status,created_at,updated_at) VALUES('import-v24','fiche.pdf','C:/local/fiche.pdf',?1,'pdf',42,2,'pdf_text','legacy','{}',6500,'needs_review','2026-08-31T12:00:00Z','2026-08-31T12:00:00Z')",
                params!["a".repeat(64)],
            )
            .unwrap();
            tx.commit().unwrap();
        }

        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v25(&tx).unwrap();
            tx.commit().unwrap();
        }

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            25
        );
        let columns = {
            let mut statement = connection
                .prepare("PRAGMA table_info(payroll_document_imports)")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<HashSet<_>, _>>()
                .unwrap()
        };
        assert!(columns.contains("analysis_manifest_json"));
        assert_eq!(
            connection
                .query_row(
                    "SELECT analysis_manifest_json FROM payroll_document_imports WHERE id='import-v24'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap(),
            None
        );

        let manifest = json!({
            "schema_version": 1,
            "model_id": "modele-local",
            "model_revision": "revision-1",
            "input_sha256": "a".repeat(64),
            "analyzed_pages": [1, 2],
            "passes": 2,
            "field_provenance": [],
            "line_provenance": [],
            "conflicts": [],
            "analyzed_at": "2026-08-31T12:00:00Z"
        })
        .to_string();
        connection
            .execute(
                "UPDATE payroll_document_imports SET analysis_manifest_json=? WHERE id='import-v24'",
                params![manifest],
            )
            .unwrap();
        assert!(connection
            .execute(
                "UPDATE payroll_document_imports SET analysis_manifest_json='{invalide' WHERE id='import-v24'",
                [],
            )
            .is_err());

        // La migration est rejouable sans perdre la preuve déjà sauvegardée.
        connection.pragma_update(None, "user_version", 24).unwrap();
        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v25(&tx).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM payroll_document_imports WHERE id='import-v24' AND analysis_manifest_json IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }
}

#[cfg(test)]
mod v26_migration_tests {
    use super::*;

    #[test]
    fn migration_v26_is_additive_replayable_and_preserves_legacy_rows() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection
            .execute_batch(
                "CREATE TABLE accounts(id TEXT PRIMARY KEY);
                 CREATE TABLE accounting_settings(
                   id INTEGER PRIMARY KEY CHECK(id=1),
                   enabled INTEGER NOT NULL DEFAULT 0,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 INSERT INTO accounting_settings(id,enabled,created_at,updated_at)
                 VALUES(1,0,'2026-08-31T12:00:00Z','2026-08-31T12:00:00Z');
                 CREATE TABLE payslips(id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
                 CREATE TABLE payroll_document_imports(
                   id TEXT PRIMARY KEY,
                   source_name TEXT NOT NULL,
                   file_sha256 TEXT NOT NULL,
                   media_kind TEXT NOT NULL,
                   file_size INTEGER NOT NULL,
                   page_count INTEGER,
                   extraction_engine TEXT NOT NULL,
                   engine_version TEXT,
                   draft_json TEXT NOT NULL,
                   analysis_manifest_json TEXT,
                   confidence_bp INTEGER NOT NULL,
                   status TEXT NOT NULL,
                   employee_id TEXT,
                   payslip_id TEXT,
                   reviewed_at TEXT
                 );
                 CREATE TABLE vat_adjustments(
                   sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                   id TEXT NOT NULL UNIQUE,
                   adjustment_date TEXT NOT NULL,
                   category TEXT NOT NULL,
                   amount_cents INTEGER NOT NULL,
                   tax_rate_bp INTEGER,
                   description TEXT NOT NULL,
                   evidence_reference TEXT,
                   reverses_adjustment_id TEXT UNIQUE REFERENCES vat_adjustments(id),
                   created_by TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );
                 INSERT INTO payslips(id,created_at) VALUES('slip-v25','2026-08-31T12:00:00Z');
                 INSERT INTO payroll_document_imports(id,source_name,file_sha256,media_kind,file_size,page_count,extraction_engine,engine_version,draft_json,analysis_manifest_json,confidence_bp,status,employee_id,payslip_id,reviewed_at)
                 VALUES('import-v25','fiche.pdf','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','pdf',42,1,'pdf_text','legacy','{}','{\"schema_version\":1}',6500,'confirmed','employee-v25','slip-v25','2026-08-31T12:00:00Z');
                 INSERT INTO vat_adjustments(id,adjustment_date,category,amount_cents,tax_rate_bp,description,evidence_reference,reverses_adjustment_id,created_by,created_at)
                 VALUES('legacy-vat-adjustment','2026-06-30','input_materials',100,NULL,'Ligne V25 conservee',NULL,NULL,'legacy','2026-06-30T00:00:00Z');
                 PRAGMA user_version=25;",
            )
            .unwrap();

        for pass in 0..2 {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v26(&tx).unwrap();
            tx.commit().unwrap();
            if pass == 0 {
                connection.pragma_update(None, "user_version", 25).unwrap();
            }
        }
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            26
        );

        let import_columns = {
            let mut statement = connection
                .prepare("PRAGMA table_info(payroll_document_imports)")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<HashSet<_>, _>>()
                .unwrap()
        };
        for column in [
            "human_review_attestation_version",
            "human_review_attested_at",
            "confirmation_evidence_sha256",
        ] {
            assert!(import_columns.contains(column));
        }
        let payslip_columns = {
            let mut statement = connection.prepare("PRAGMA table_info(payslips)").unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<HashSet<_>, _>>()
                .unwrap()
        };
        for column in [
            "source_payroll_import_id",
            "source_import_evidence_json",
            "source_import_evidence_sha256",
        ] {
            assert!(payslip_columns.contains(column));
        }
        let vat_columns = {
            let mut statement = connection
                .prepare("PRAGMA table_info(vat_adjustments)")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<HashSet<_>, _>>()
                .unwrap()
        };
        for column in ["request_id", "request_sha256", "request_json"] {
            assert!(vat_columns.contains(column));
        }
        let accounting_columns = {
            let mut statement = connection
                .prepare("PRAGMA table_info(accounting_settings)")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<HashSet<_>, _>>()
                .unwrap()
        };
        assert!(accounting_columns.contains("vat_deferred_payable_account_id"));
        let legacy_vat_request: (Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT request_id,request_sha256,request_json FROM vat_adjustments WHERE id='legacy-vat-adjustment'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(legacy_vat_request, (None, None, None));
        assert!(connection
            .execute(
                "INSERT INTO vat_adjustments(id,request_id,request_sha256,request_json,adjustment_date,category,amount_cents,description,created_by,created_at) VALUES('bad-vat','not-an-uuid',?1,'{}','2026-07-01','input_materials',1,'invalid','tester','2026-07-01T00:00:00Z')",
                params!["b".repeat(64)],
            )
            .is_err());
        let preserved: (String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT file_sha256,human_review_attested_at,confirmation_evidence_sha256 FROM payroll_document_imports WHERE id='import-v25'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(preserved.0, "a".repeat(64));
        assert_eq!(preserved.1, None);
        assert_eq!(preserved.2, None);
        assert!(connection
            .execute(
                "UPDATE payroll_document_imports SET confirmation_evidence_sha256=? WHERE id='import-v25'",
                params!["b".repeat(64)],
            )
            .is_err());
    }
}

#[cfg(test)]
mod v27_migration_tests {
    use super::*;

    #[test]
    fn migration_v27_enables_multi_order_global_tolerance_and_is_replayable() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(SCHEMA_SQL).unwrap();
        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v20(&tx).unwrap();
            migrate_v21(&tx).unwrap();
            migrate_v22(&tx).unwrap();
            migrate_v23(&tx).unwrap();
            migrate_v24(&tx).unwrap();
            migrate_v25(&tx).unwrap();
            migrate_v26(&tx).unwrap();
            tx.commit().unwrap();
        }

        for pass in 0..2 {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v27(&tx).unwrap();
            tx.commit().unwrap();
            if pass == 0 {
                connection.pragma_update(None, "user_version", 26).unwrap();
            }
        }

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            27
        );
        let triggers = {
            let mut statement = connection
                .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<HashSet<_>, _>>()
                .unwrap()
        };
        assert!(!triggers.contains("supplier_invoice_matches_single_order_insert_guard"));
        assert!(!triggers.contains("supplier_invoice_matches_single_order_update_guard"));
        assert!(triggers.contains("supplier_invoice_matches_no_update"));
        let close_guard: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='supplier_orders_close_guard'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(close_guard.contains("linked.supplier_invoice_id"));
        assert!(close_guard.contains("GROUP BY match_row.supplier_invoice_id"));
        assert!(!close_guard
            .contains("GROUP BY match_row.supplier_invoice_id,match_row.supplier_order_id"));
        let validation_guard: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='supplier_invoices_validation_guard'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(validation_guard.contains("GROUP BY match_row.supplier_invoice_id"));
        assert!(!validation_guard
            .contains("GROUP BY match_row.supplier_invoice_id,match_row.supplier_order_id"));
    }
}

#[cfg(test)]
mod v28_migration_tests {
    use super::*;

    fn table_columns(connection: &Connection, table: &str) -> HashSet<String> {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<HashSet<_>, _>>()
            .unwrap()
    }

    #[test]
    fn migration_v28_is_additive_replayable_and_invents_no_lpp_data() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection
            .execute_batch(
                "CREATE TABLE employees(id TEXT PRIMARY KEY,name TEXT NOT NULL);
                 CREATE TABLE payroll_contribution_definitions(id TEXT PRIMARY KEY);
                 CREATE TABLE payslip_contributions(id TEXT PRIMARY KEY);
                 INSERT INTO employees(id,name) VALUES('employee-v27','Employé conservé');
                 INSERT INTO payroll_contribution_definitions(id) VALUES('definition-v27');
                 INSERT INTO payslip_contributions(id) VALUES('snapshot-v27');
                 PRAGMA user_version=27;",
            )
            .unwrap();

        for pass in 0..2 {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v28(&tx).unwrap();
            tx.commit().unwrap();
            if pass == 0 {
                connection.pragma_update(None, "user_version", 27).unwrap();
            }
        }

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            28
        );
        let employee_columns = table_columns(&connection, "employees");
        for column in [
            "employment_contract_kind",
            "lpp_assessment_year",
            "lpp_annual_salary_cents",
            "lpp_exception_code",
            "lpp_exception_evidence_reference",
        ] {
            assert!(employee_columns.contains(column), "missing {column}");
        }
        for table in ["payroll_contribution_definitions", "payslip_contributions"] {
            let columns = table_columns(&connection, table);
            assert!(columns.contains("lpp_component"));
            assert!(columns.contains("lpp_employee_id"));
        }

        type PreservedEmployeeLpp = (
            String,
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<String>,
        );
        let preserved: PreservedEmployeeLpp = connection
            .query_row(
                "SELECT name,employment_contract_kind,lpp_assessment_year,lpp_annual_salary_cents,lpp_exception_code,lpp_exception_evidence_reference FROM employees WHERE id='employee-v27'",
                [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
            )
            .unwrap();
        assert_eq!(
            preserved,
            ("Employé conservé".into(), None, None, None, None, None)
        );
        let definition_lpp: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT lpp_component,lpp_employee_id FROM payroll_contribution_definitions WHERE id='definition-v27'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(definition_lpp, (None, None));
        let snapshot_lpp: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT lpp_component,lpp_employee_id FROM payslip_contributions WHERE id='snapshot-v27'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(snapshot_lpp, (None, None));

        assert!(connection
            .execute(
                "UPDATE employees SET employment_contract_kind='invented' WHERE id='employee-v27'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE payroll_contribution_definitions SET lpp_component='invented' WHERE id='definition-v27'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE payslip_contributions SET lpp_employee_id='missing-employee' WHERE id='snapshot-v27'",
                [],
            )
            .is_err());
    }

    #[test]
    fn employee_lpp_fields_are_whitelisted_and_validated_together() {
        let spec = entity_spec("employees").unwrap();
        for field in [
            "employment_contract_kind",
            "lpp_assessment_year",
            "lpp_annual_salary_cents",
            "lpp_exception_code",
            "lpp_exception_evidence_reference",
        ] {
            assert!(spec.fields.contains(&field), "{field} is not whitelisted");
        }

        let mut valid = json!({
            "employment_contract_kind":"fixed",
            "employment_start_date":"2026-01-01",
            "employment_end_date":"2026-04-01",
            "lpp_assessment_year":2026,
            "lpp_annual_salary_cents":2_268_001,
            "lpp_exception_code":"short_fixed_contract",
            "lpp_exception_evidence_reference":"Contrat signé C-2026-001"
        })
        .as_object()
        .unwrap()
        .clone();
        normalize_record("employees", &mut valid, true).unwrap();

        let mut missing_salary = json!({"lpp_assessment_year":2026})
            .as_object()
            .unwrap()
            .clone();
        assert!(normalize_record("employees", &mut missing_salary, true).is_err());

        let mut missing_evidence = json!({"lpp_exception_code":"other_legal"})
            .as_object()
            .unwrap()
            .clone();
        assert!(normalize_record("employees", &mut missing_evidence, true).is_err());

        let mut undated_fixed = json!({"employment_contract_kind":"fixed"})
            .as_object()
            .unwrap()
            .clone();
        assert!(normalize_record("employees", &mut undated_fixed, true).is_err());
    }
}

#[cfg(test)]
mod v29_logo_migration_tests {
    use super::*;
    use image::{DynamicImage, ImageFormat};

    #[test]
    fn migration_v29_is_replayable_and_only_allows_registered_new_logo_paths() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE settings(id INTEGER PRIMARY KEY,logo_path TEXT);
                 INSERT INTO settings(id,logo_path) VALUES(1,'C:\\ancien\\logo-client.png');
                 PRAGMA user_version=28;",
            )
            .unwrap();

        for pass in 0..2 {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v29(&transaction).unwrap();
            transaction.commit().unwrap();
            if pass == 0 {
                connection.pragma_update(None, "user_version", 28).unwrap();
            }
        }

        assert_eq!(
            connection
                .query_row("SELECT logo_path FROM settings WHERE id=1", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "C:\\ancien\\logo-client.png"
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            29
        );
        assert!(connection
            .execute(
                "UPDATE settings SET logo_path='C:\\injected\\logo.png' WHERE id=1",
                [],
            )
            .is_err());

        let digest = "a".repeat(64);
        let file_name = format!("logo-{digest}.png");
        connection
            .execute(
                "INSERT INTO company_brand_assets(sha256,file_name,media_type,byte_size,width,height,created_at,last_verified_at) VALUES(?,?,?,?,?,?,?,?)",
                params![digest, file_name, "image/png", 1024, 120, 60, "2026-09-02T10:00:00Z", "2026-09-02T10:00:00Z"],
            )
            .unwrap();
        let managed_path = format!("C:\\Profil\\Zentra\\attachments\\branding\\{}", file_name);
        connection
            .execute(
                "UPDATE settings SET logo_path=? WHERE id=1",
                params![managed_path],
            )
            .unwrap();
        connection
            .execute("UPDATE settings SET logo_path=NULL WHERE id=1", [])
            .unwrap();
    }

    #[test]
    fn first_snapshot_after_v28_upgrade_stages_the_active_logo_without_rewriting_history() {
        let temporary = tempfile::tempdir().unwrap();
        let profile = temporary.path().join("profile");
        let legacy_logo = temporary.path().join("logo-externe-client.png");
        DynamicImage::new_rgba8(96, 48)
            .save_with_format(&legacy_logo, ImageFormat::Png)
            .unwrap();
        let store = LocalStore::initialize(profile).unwrap();
        let legacy_path = legacy_logo.to_string_lossy().into_owned();
        let historical_snapshot = json!({
            "schema": "helvichantier.document_snapshot.v1",
            "issuer": {"logo_path": legacy_path.clone()},
            "document": {"id": "quote-before-v29"}
        })
        .to_string();
        {
            let connection = store.connect().unwrap();
            connection
                .execute_batch(
                    "DROP TRIGGER IF EXISTS settings_logo_asset_insert_guard;
                     DROP TRIGGER IF EXISTS settings_logo_asset_update_guard;
                     DROP TABLE IF EXISTS company_brand_assets;",
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO settings(id,onboarding_completed,company_name,logo_path,created_at,updated_at)
                     VALUES(1,1,'Entreprise V28',?,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')",
                    params![legacy_path],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO quotes(id,number,title,status,issue_date,currency,snapshot_json,created_at,updated_at)
                     VALUES('quote-before-v29','D-2026-0001','Ancien devis','envoye','2026-08-01','CHF',?,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')",
                    params![historical_snapshot],
                )
                .unwrap();
            connection.pragma_update(None, "user_version", 28).unwrap();
        }

        store.migrate().unwrap();
        let issuer = {
            let mut connection = store.connect().unwrap();
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            let issuer = build_issuer_snapshot(&transaction).unwrap();
            transaction.commit().unwrap();
            issuer
        };
        let managed_path = issuer["logo_path"].as_str().unwrap();
        assert_ne!(managed_path, legacy_path);
        assert!(crate::branding::is_managed_logo_reference(managed_path));
        let canonical_managed = fs::canonicalize(managed_path).unwrap();
        let canonical_branding = fs::canonicalize(store.attachments_dir.join("branding")).unwrap();
        assert_eq!(
            canonical_managed.parent(),
            Some(canonical_branding.as_path()),
            "la copie migrée doit rester directement dans le dossier branding canonique"
        );

        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT logo_path FROM settings WHERE id=1", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            managed_path
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT snapshot_json FROM quotes WHERE id='quote-before-v29'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            historical_snapshot,
            "la migration active ne doit jamais modifier un snapshot déjà émis"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM company_brand_assets", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }

    #[test]
    fn first_snapshot_after_v28_upgrade_fails_closed_when_legacy_logo_is_unreadable() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let missing_logo = temporary.path().join("logo-supprime.png");
        let missing_path = missing_logo.to_string_lossy().into_owned();
        {
            let connection = store.connect().unwrap();
            connection
                .execute_batch(
                    "DROP TRIGGER IF EXISTS settings_logo_asset_insert_guard;
                     DROP TRIGGER IF EXISTS settings_logo_asset_update_guard;
                     DROP TABLE IF EXISTS company_brand_assets;",
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO settings(id,onboarding_completed,company_name,logo_path,created_at,updated_at)
                     VALUES(1,1,'Entreprise V28',?,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')",
                    params![missing_path],
                )
                .unwrap();
            connection.pragma_update(None, "user_version", 28).unwrap();
        }

        store.migrate().unwrap();
        let mut connection = store.connect().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let error = build_issuer_snapshot(&transaction).unwrap_err();
        assert!(error.to_string().contains("avant l'émission"));
        drop(transaction);

        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT logo_path FROM settings WHERE id=1", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            missing_path
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM company_brand_assets", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }
}

#[cfg(test)]
mod v30_migration_tests {
    use super::*;

    #[test]
    fn migration_v30_is_replayable_and_guards_invoice_payment_integrity() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE invoices(
                    id TEXT PRIMARY KEY,
                    number TEXT,
                    type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    issue_date TEXT,
                    total_cents INTEGER NOT NULL,
                    original_invoice_id TEXT
                 );
                 CREATE TABLE payments(
                    id TEXT PRIMARY KEY,
                    invoice_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL
                 );
                 INSERT INTO invoices(id,number,type,status,issue_date,total_cents)
                 VALUES
                    ('invoice-open','F-2026-0001','standard','emise','2026-09-01',10000),
                    ('invoice-cancelled','F-2026-0002','standard','annulee','2026-09-01',10000),
                    ('credit-note','A-2026-0001','avoir','emise','2026-09-01',-1000),
                    ('invoice-draft',NULL,'standard','brouillon','2026-09-01',10000),
                    ('invoice-numbered-draft','F-2026-0003','standard','brouillon','2026-09-01',10000),
                    ('invoice-date','F-2026-0004','standard','emise','2026-09-01',10000);
                 PRAGMA user_version=29;",
            )
            .unwrap();

        for pass in 0..2 {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v30(&transaction).unwrap();
            transaction.commit().unwrap();
            if pass == 0 {
                connection.pragma_update(None, "user_version", 29).unwrap();
            }
        }

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            30
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN('payments_invoice_issue_date_guard','invoices_issued_no_unsafe_cancel')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );

        connection
            .execute(
                "INSERT INTO payments(id,invoice_id,date,amount_cents) VALUES('payment-1','invoice-open','2026-09-02',6000)",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO payments(id,invoice_id,date,amount_cents) VALUES('payment-over','invoice-open','2026-09-03',4001)",
                [],
            )
            .is_err());
        connection
            .execute(
                "INSERT INTO payments(id,invoice_id,date,amount_cents) VALUES('payment-2','invoice-open','2026-09-03',4000)",
                [],
            )
            .unwrap();
        for (id, invoice_id, date) in [
            ("payment-before", "invoice-open", "2026-08-31"),
            ("payment-cancelled", "invoice-cancelled", "2026-09-02"),
            ("payment-credit", "credit-note", "2026-09-02"),
            ("payment-draft", "invoice-draft", "2026-09-02"),
            (
                "payment-numbered-draft",
                "invoice-numbered-draft",
                "2026-09-02",
            ),
            ("payment-invalid-date", "invoice-date", "demain"),
            ("payment-impossible-date", "invoice-date", "2026-02-30"),
            ("payment-impossible-month", "invoice-date", "2026-19-09"),
        ] {
            assert!(connection
                .execute(
                    "INSERT INTO payments(id,invoice_id,date,amount_cents) VALUES(?,?,?,100)",
                    params![id, invoice_id, date],
                )
                .is_err());
        }
        assert!(connection
            .execute(
                "UPDATE invoices SET status='annulee' WHERE id='invoice-open'",
                [],
            )
            .is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM invoices WHERE id='invoice-open'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "emise"
        );
        assert!(connection
            .execute(
                "UPDATE invoices SET status='annulee' WHERE id='credit-note'",
                [],
            )
            .is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM invoices WHERE id='credit-note'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "emise",
            "un avoir numéroté est aussi un document émis; sa correction exige un document inverse traçable"
        );
    }
}

#[cfg(test)]
mod v31_caf_source_migration_tests {
    use super::*;

    const LEGACY_CAF_AMOUNTS_SOURCE: &str = "https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/OrwD3z_mIEOztplxBzs7qQ/Document/Kantone_2026_f-1.pdf";
    const OFFICIAL_CAF_RATE_SOURCE: &str = "https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/Ypzfdm2t_km4jeHFYxWRdA/Document/Tableau%20synoptique%2020-1.pdf";

    fn definition_sources(connection: &Connection) -> Vec<(String, String)> {
        let mut statement = connection
            .prepare("SELECT id,source FROM payroll_contribution_definitions ORDER BY id")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn migration_v31_replaces_only_the_legacy_valais_employee_caf_2026_source_and_replays() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE payroll_contribution_definitions(
                   id TEXT PRIMARY KEY,
                   category TEXT NOT NULL,
                   side TEXT NOT NULL,
                   calculation_kind TEXT NOT NULL,
                   rate_bp INTEGER,
                   source TEXT NOT NULL,
                   effective_from TEXT NOT NULL,
                   effective_to TEXT,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE payslip_contributions(
                   id TEXT PRIMARY KEY,
                   source TEXT NOT NULL
                 );
                 PRAGMA user_version=30;",
            )
            .unwrap();

        for (id, category, side, rate_bp, effective_from, effective_to, source) in [
            (
                "caf-vs-target",
                "family_allowance",
                "employee",
                13,
                "2026-01-01",
                Some("2026-12-31"),
                format!("Décision caisse; {LEGACY_CAF_AMOUNTS_SOURCE}; dossier local"),
            ),
            (
                "caf-vs-already-current",
                "family_allowance",
                "employee",
                13,
                "2026-01-01",
                Some("2026-12-31"),
                OFFICIAL_CAF_RATE_SOURCE.to_owned(),
            ),
            (
                "caf-employer",
                "family_allowance",
                "employer",
                13,
                "2026-01-01",
                Some("2026-12-31"),
                LEGACY_CAF_AMOUNTS_SOURCE.to_owned(),
            ),
            (
                "caf-other-rate",
                "family_allowance",
                "employee",
                14,
                "2026-01-01",
                Some("2026-12-31"),
                LEGACY_CAF_AMOUNTS_SOURCE.to_owned(),
            ),
            (
                "caf-other-year",
                "family_allowance",
                "employee",
                13,
                "2025-01-01",
                Some("2025-12-31"),
                LEGACY_CAF_AMOUNTS_SOURCE.to_owned(),
            ),
            (
                "other-category",
                "other",
                "employee",
                13,
                "2026-01-01",
                Some("2026-12-31"),
                LEGACY_CAF_AMOUNTS_SOURCE.to_owned(),
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO payroll_contribution_definitions(
                       id,category,side,calculation_kind,rate_bp,source,
                       effective_from,effective_to,updated_at
                     ) VALUES(?,?,?,'rate',?,?,?,?,?)",
                    params![
                        id,
                        category,
                        side,
                        rate_bp,
                        source,
                        effective_from,
                        effective_to,
                        "2026-08-31T12:00:00Z"
                    ],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO payslip_contributions(id,source) VALUES('frozen-payslip',?)",
                params![LEGACY_CAF_AMOUNTS_SOURCE],
            )
            .unwrap();

        let before = definition_sources(&connection);
        let mut after_first_pass = None;
        for pass in 0..2 {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v31(&transaction).unwrap();
            transaction.commit().unwrap();
            if pass == 0 {
                after_first_pass = Some(definition_sources(&connection));
                connection.pragma_update(None, "user_version", 30).unwrap();
            }
        }
        let after = definition_sources(&connection);

        assert_eq!(after_first_pass.as_ref(), Some(&after));

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            31
        );
        assert_eq!(
            after
                .iter()
                .find(|(id, _)| id == "caf-vs-target")
                .unwrap()
                .1,
            format!("Décision caisse; {OFFICIAL_CAF_RATE_SOURCE}; dossier local")
        );
        assert_eq!(
            after
                .iter()
                .find(|(id, _)| id == "caf-vs-already-current")
                .unwrap()
                .1,
            OFFICIAL_CAF_RATE_SOURCE
        );
        for untouched_id in [
            "caf-employer",
            "caf-other-rate",
            "caf-other-year",
            "other-category",
        ] {
            assert_eq!(
                after.iter().find(|(id, _)| id == untouched_id),
                before.iter().find(|(id, _)| id == untouched_id),
                "V31 ne doit pas modifier le profil {untouched_id}"
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT source FROM payslip_contributions WHERE id='frozen-payslip'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            LEGACY_CAF_AMOUNTS_SOURCE,
            "la preuve source d'une fiche historique doit rester figée"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT updated_at FROM payroll_contribution_definitions WHERE id='caf-vs-target'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "2026-08-31T12:00:00Z",
            "la correction réglementaire ne doit pas falsifier la date de saisie utilisateur"
        );
    }
}

#[cfg(test)]
mod v32_laa_opening_migration_tests {
    use super::*;

    fn employee_columns(connection: &Connection) -> HashSet<String> {
        let mut statement = connection.prepare("PRAGMA table_info(employees)").unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<HashSet<_>, _>>()
            .unwrap()
    }

    #[test]
    fn migration_v32_is_additive_replayable_and_preserves_existing_opening_data() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE employees(
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   ac_opening_year INTEGER CHECK(ac_opening_year IS NULL OR ac_opening_year BETWEEN 1900 AND 9999),
                   ac_opening_basis_cents INTEGER CHECK(ac_opening_basis_cents IS NULL OR ac_opening_basis_cents>=0)
                 );
                 CREATE TRIGGER employees_payroll_decisions_insert_guard
                 BEFORE INSERT ON employees
                 WHEN (NEW.ac_opening_year IS NULL)<>(NEW.ac_opening_basis_cents IS NULL)
                 BEGIN SELECT RAISE(ABORT,'AC opening year and basis must be confirmed together'); END;
                 CREATE TRIGGER employees_payroll_decisions_update_guard
                 BEFORE UPDATE OF ac_opening_year,ac_opening_basis_cents ON employees
                 WHEN (NEW.ac_opening_year IS NULL)<>(NEW.ac_opening_basis_cents IS NULL)
                 BEGIN SELECT RAISE(ABORT,'AC opening year and basis must be confirmed together'); END;
                 INSERT INTO employees(id,name,ac_opening_year,ac_opening_basis_cents)
                 VALUES('employee-v31','Employé conservé',2026,123456);
                 PRAGMA user_version=31;",
            )
            .unwrap();

        for pass in 0..2 {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            migrate_v32(&transaction).unwrap();
            transaction.commit().unwrap();
            if pass == 0 {
                connection.pragma_update(None, "user_version", 31).unwrap();
            }
        }

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            32
        );
        let columns = employee_columns(&connection);
        assert!(columns.contains("laa_opening_year"));
        assert!(columns.contains("laa_opening_basis_cents"));
        assert_eq!(
            connection
                .query_row(
                    "SELECT name,ac_opening_year,ac_opening_basis_cents,laa_opening_year,laa_opening_basis_cents FROM employees WHERE id='employee-v31'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                            row.get::<_, Option<i64>>(4)?,
                        ))
                    },
                )
                .unwrap(),
            (
                "Employé conservé".into(),
                Some(2026),
                Some(123456),
                None,
                None
            )
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN('employees_payroll_decisions_insert_guard','employees_payroll_decisions_update_guard')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );

        connection
            .execute(
                "INSERT INTO employees(id,name,laa_opening_year,laa_opening_basis_cents) VALUES('valid-laa','Base zéro',2026,0)",
                [],
            )
            .unwrap();
        for sql in [
            "INSERT INTO employees(id,name,laa_opening_year) VALUES('missing-laa-basis','Incomplet',2026)",
            "INSERT INTO employees(id,name,laa_opening_basis_cents) VALUES('missing-laa-year','Incomplet',100)",
            "INSERT INTO employees(id,name,laa_opening_year,laa_opening_basis_cents) VALUES('bad-laa-year','Année invalide',1899,100)",
            "INSERT INTO employees(id,name,laa_opening_year,laa_opening_basis_cents) VALUES('bad-laa-basis','Base invalide',2026,-1)",
            "INSERT INTO employees(id,name,ac_opening_year) VALUES('missing-ac-basis','AC incomplet',2026)",
            "UPDATE employees SET laa_opening_basis_cents=NULL WHERE id='valid-laa'",
        ] {
            assert!(connection.execute(sql, []).is_err(), "SQL accepté: {sql}");
        }
    }

    #[test]
    fn fresh_v32_database_and_employee_normalization_enforce_the_laa_opening_pair() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let columns = employee_columns(&connection);
        assert!(columns.contains("laa_opening_year"));
        assert!(columns.contains("laa_opening_basis_cents"));
        connection
            .execute(
                "INSERT INTO employees(id,name,laa_opening_year,laa_opening_basis_cents,created_at,updated_at) VALUES('fresh-valid','Employé neuf',2026,0,'2026-09-02T00:00:00Z','2026-09-02T00:00:00Z')",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO employees(id,name,laa_opening_year,created_at,updated_at) VALUES('fresh-invalid','Employé incomplet',2026,'2026-09-02T00:00:00Z','2026-09-02T00:00:00Z')",
                [],
            )
            .is_err());
        drop(connection);

        let spec = entity_spec("employees").unwrap();
        assert!(spec.fields.contains(&"laa_opening_year"));
        assert!(spec.fields.contains(&"laa_opening_basis_cents"));

        let mut valid = json!({
            "name":"Employé normalisé",
            "laa_opening_year":2026,
            "laa_opening_basis_cents":0
        })
        .as_object()
        .unwrap()
        .clone();
        normalize_record("employees", &mut valid, true).unwrap();

        for invalid in [
            json!({"name":"Incomplet","laa_opening_year":2026}),
            json!({"name":"Incomplet","laa_opening_basis_cents":0}),
            json!({"name":"Année invalide","laa_opening_year":1899,"laa_opening_basis_cents":0}),
            json!({"name":"Base invalide","laa_opening_year":2026,"laa_opening_basis_cents":-1}),
        ] {
            let mut object = invalid.as_object().unwrap().clone();
            assert!(normalize_record("employees", &mut object, true).is_err());
        }
    }
}

#[cfg(test)]
mod v33_cumulative_close_migration_tests {
    use super::*;

    const NOW: &str = "2026-12-31T12:00:00Z";

    fn insert_journal(
        connection: &Connection,
        id: &str,
        number: &str,
        date: &str,
        source_type: &str,
        source_id: &str,
        source_event: &str,
    ) {
        connection
            .execute(
                "INSERT INTO journal_entries(
                   id,number,entry_date,description,source_type,source_id,source_event,status,created_at
                 ) VALUES(?,?,?,'Preuve test',?,?,?,'posted',?)",
                params![id, number, date, source_type, source_id, source_event, NOW],
            )
            .unwrap();
    }

    fn insert_invoice_draft(connection: &Connection, id: &str, item_id: &str, date: &str) {
        connection
            .execute(
                "INSERT INTO invoices(
                   id,title,type,status,issue_date,due_date,currency,subtotal_cents,vat_cents,total_cents,created_at,updated_at
                 ) VALUES(?,'Facture test','standard','brouillon',?,?,'CHF',10000,810,10810,?,?)",
                params![id, date, date, NOW, NOW],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO invoice_items(
                   id,invoice_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,
                   line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at
                 ) VALUES(?,?,0,'Prestation',1.0,'forfait',10000,0,810,10000,810,10810,?,?)",
                params![item_id, id, NOW, NOW],
            )
            .unwrap();
    }

    fn insert_supplier_invoice_draft(
        connection: &Connection,
        id: &str,
        item_id: &str,
        reference: &str,
    ) {
        connection
            .execute(
                "INSERT INTO supplier_invoices(
                   id,supplier_id,document_date,due_date,supplier_name,reference,reference_normalized,
                   currency,status,net_cents,vat_cents,total_cents,paid_cents,created_at,updated_at
                 ) VALUES(?,'supplier-1','2026-02-10','2026-03-10','Fournisseur test',?,?,
                          'CHF','draft',10000,810,10810,0,?,?)",
                params![id, reference, reference, NOW, NOW],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO supplier_invoice_items(
                   id,supplier_invoice_id,position,description,quantity_milli,unit,unit_price_cents,
                   discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,category,
                   posted_expense_account_id,created_at,updated_at
                 ) VALUES(?,?,0,'Achat',1000,'unité',10000,0,810,10000,810,10810,'matériel',
                          'account-expense',?,?)",
                params![item_id, id, NOW, NOW],
            )
            .unwrap();
    }

    #[test]
    fn v33_dispatch_and_sqlite_guards_cover_every_closed_source_family() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();

        // La migration doit être rejouable depuis une vraie base V32 et ne doit
        // créer aucune donnée métier.
        {
            let connection = store.connect().unwrap();
            connection.pragma_update(None, "user_version", 32).unwrap();
        }
        store.migrate().unwrap();

        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE
                       (type='view' AND name='vat_source_fiscal_dates') OR
                       (type='trigger' AND name IN(
                         'journal_entries_closed_through_insert_guard',
                         'journal_lines_closed_through_insert_guard',
                         'accounting_periods_closed_no_update',
                         'accounting_periods_closed_no_delete',
                         'payments_closed_through_insert_guard',
                         'supplier_payments_closed_through_insert_guard',
                         'expenses_closed_through_insert_guard',
                         'invoices_closed_through_issue_guard',
                         'supplier_invoices_closed_through_validation_guard',
                         'vat_adjustments_closed_through_insert_guard',
                         'vat_profiles_closed_through_update_guard',
                         'vat_source_classifications_closed_through_update_guard'
                       ))",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            13
        );

        connection
            .execute(
                "INSERT INTO accounts(id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at)
                 VALUES('account-1','1020','Banque','asset','debit','current_assets',1,?1,?1)",
                params![NOW],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO accounts(id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at)
                 VALUES('account-expense','6000','Charges','expense','debit','other_operating_expense',1,?1,?1)",
                params![NOW],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO suppliers(id,name,currency,payment_terms_days,created_at,updated_at)
                 VALUES('supplier-1','Fournisseur test','CHF',30,?1,?1)",
                params![NOW],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at)
                 VALUES('period-2026','Exercice 2026','2026-01-01','2026-12-31','open',?1,?1)",
                params![NOW],
            )
            .unwrap();

        insert_invoice_draft(
            &connection,
            "invoice-existing",
            "item-existing",
            "2026-02-01",
        );
        connection
            .execute(
                "UPDATE invoices SET number='F-2026-0001',status='emise' WHERE id='invoice-existing'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO payments(id,invoice_id,date,amount_cents,created_at,updated_at)
                 VALUES('payment-existing','invoice-existing','2026-03-01',1000,?1,?1)",
                params![NOW],
            )
            .unwrap();

        insert_journal(
            &connection,
            "journal-supplier-existing",
            "J-2026-000001",
            "2026-02-10",
            "supplier_invoice",
            "supplier-invoice-existing",
            "validate",
        );
        insert_journal(
            &connection,
            "journal-supplier-future-validation",
            "J-2026-000002",
            "2026-02-10",
            "supplier_invoice",
            "supplier-invoice-after-close",
            "validate",
        );
        insert_journal(
            &connection,
            "journal-supplier-payment-existing",
            "J-2026-000003",
            "2026-03-15",
            "supplier_payment",
            "supplier-payment-existing",
            "invoice:supplier-invoice-existing",
        );
        insert_journal(
            &connection,
            "journal-supplier-payment-after-close",
            "J-2026-000004",
            "2026-03-20",
            "supplier_payment",
            "supplier-payment-after-close",
            "invoice:supplier-invoice-existing",
        );
        insert_supplier_invoice_draft(
            &connection,
            "supplier-invoice-existing",
            "supplier-item-existing",
            "REF-EXISTING",
        );
        connection
            .execute(
                "UPDATE supplier_invoices
                 SET status='validated',validated_at=?1,validation_journal_entry_id='journal-supplier-existing',
                     snapshot_json='{}',updated_at=?1
                 WHERE id='supplier-invoice-existing'",
                params![NOW],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO supplier_payments(
                   id,supplier_invoice_id,request_id,date,amount_cents,journal_entry_id,created_at
                 ) VALUES(
                   'supplier-payment-existing','supplier-invoice-existing',
                   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-03-15',1000,
                   'journal-supplier-payment-existing',?1
                 )",
                params![NOW],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO expenses(
                   id,date,due_date,supplier,category,currency,net_cents,vat_cents,total_cents,
                   payment_status,paid_at,created_at,updated_at
                 ) VALUES(
                   'expense-existing','2026-04-01','2026-04-30','Fournisseur test','matériel','CHF',
                   10000,810,10810,'paid','2026-04-01',?1,?1
                 )",
                params![NOW],
            )
            .unwrap();

        connection
            .execute(
                "UPDATE accounting_periods SET status='closed',closed_at=?1,updated_at=?1
                 WHERE id='period-2026'",
                params![NOW],
            )
            .unwrap();

        let counts_before: (i64, i64, i64, i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM invoices),
                   (SELECT COUNT(*) FROM payments),
                   (SELECT COUNT(*) FROM supplier_invoices),
                   (SELECT COUNT(*) FROM supplier_payments),
                   (SELECT COUNT(*) FROM expenses),
                   (SELECT COUNT(*) FROM journal_lines)",
                [],
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

        // Famille ventes et encaissements : nouvelle émission/paiement
        // antidatés bloqués, paiements historiques immuables, facture émise
        // financièrement immuable et non supprimable.
        insert_invoice_draft(
            &connection,
            "invoice-after-close",
            "item-after-close",
            "2026-05-01",
        );
        assert!(connection
            .execute(
                "UPDATE invoices SET number='F-2026-0002',status='emise' WHERE id='invoice-after-close'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO payments(id,invoice_id,date,amount_cents,created_at,updated_at)
                 VALUES('payment-after-close','invoice-existing','2026-05-01',100,?1,?1)",
                params![NOW],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE payments SET amount_cents=1 WHERE id='payment-existing'",
                [],
            )
            .is_err());
        assert!(connection
            .execute("DELETE FROM payments WHERE id='payment-existing'", [])
            .is_err());
        assert!(connection
            .execute(
                "UPDATE invoices SET title='Altération' WHERE id='invoice-existing'",
                [],
            )
            .is_err());
        assert!(connection
            .execute("DELETE FROM invoices WHERE id='invoice-existing'", [])
            .is_err());

        // Famille fournisseurs : validation/paiement antidatés bloqués et
        // documents déjà validés/paiements déjà inscrits immuables.
        insert_supplier_invoice_draft(
            &connection,
            "supplier-invoice-after-close",
            "supplier-item-after-close",
            "REF-AFTER-CLOSE",
        );
        assert!(connection
            .execute(
                "UPDATE supplier_invoices
                 SET status='validated',validated_at=?1,
                     validation_journal_entry_id='journal-supplier-future-validation',
                     snapshot_json='{}',updated_at=?1
                 WHERE id='supplier-invoice-after-close'",
                params![NOW],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO supplier_payments(
                   id,supplier_invoice_id,request_id,date,amount_cents,journal_entry_id,created_at
                 ) VALUES(
                   'supplier-payment-after-close','supplier-invoice-existing',
                   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-03-20',100,
                   'journal-supplier-payment-after-close',?1
                 )",
                params![NOW],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE supplier_payments SET amount_cents=1 WHERE id='supplier-payment-existing'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM supplier_payments WHERE id='supplier-payment-existing'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE supplier_invoices SET note='Altération' WHERE id='supplier-invoice-existing'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM supplier_invoices WHERE id='supplier-invoice-existing'",
                [],
            )
            .is_err());

        // Famille dépenses et journal : aucune apparition, mutation,
        // suppression ou ligne supplémentaire dans l'historique scellé.
        assert!(connection
            .execute(
                "INSERT INTO expenses(
                   id,date,due_date,currency,net_cents,vat_cents,total_cents,payment_status,created_at,updated_at
                 ) VALUES('expense-after-close','2025-12-31','2026-01-31','CHF',100,8,108,'pending',?1,?1)",
                params![NOW],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE expenses SET vat_cents=1,total_cents=10001 WHERE id='expense-existing'",
                [],
            )
            .is_err());
        assert!(connection
            .execute("DELETE FROM expenses WHERE id='expense-existing'", [])
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO journal_lines(
                   id,journal_entry_id,account_id,debit_cents,credit_cents,currency,created_at
                 ) VALUES('late-line','journal-supplier-existing','account-1',1,0,'CHF',?1)",
                params![NOW],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at)
                 VALUES('non-canonical','Invalide','2027-1-01','2027-12-31','open',?1,?1)",
                params![NOW],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE accounting_periods SET status='open' WHERE id='period-2026'",
                [],
            )
            .is_err());
        assert!(connection
            .execute("DELETE FROM accounting_periods WHERE id='period-2026'", [])
            .is_err());

        let counts_after: (i64, i64, i64, i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM invoices),
                   (SELECT COUNT(*) FROM payments),
                   (SELECT COUNT(*) FROM supplier_invoices),
                   (SELECT COUNT(*) FROM supplier_payments),
                   (SELECT COUNT(*) FROM expenses),
                   (SELECT COUNT(*) FROM journal_lines)",
                [],
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
            counts_after,
            (
                counts_before.0 + 1,
                counts_before.1,
                counts_before.2 + 1,
                counts_before.3,
                counts_before.4,
                counts_before.5,
            ),
            "seuls les deux brouillons de préparation restent autorisés"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn v33_refuses_to_derive_a_boundary_from_noncanonical_legacy_periods() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        {
            let connection = store.connect().unwrap();
            connection
                .execute_batch(
                    "DROP TRIGGER accounting_periods_canonical_dates_insert_guard;
                     INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at)
                     VALUES('legacy-invalid','Invalide','2026-1-01','2026-12-31','closed',
                            '2026-12-31T00:00:00Z','2026-12-31T00:00:00Z');
                     PRAGMA user_version=32;",
                )
                .unwrap();
        }
        let error = store.migrate().unwrap_err().to_string();
        assert!(error.contains("Migration V33 bloquée"));
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            32,
            "la migration invalide doit être entièrement annulée"
        );
    }
}

#[cfg(test)]
mod v34_small_salary_migration_tests {
    use super::*;

    const NOW: &str = "2026-09-02T12:00:00Z";

    fn v33_fixture_store(root: &Path, incompatible_history_table: bool) -> LocalStore {
        let data_dir = root.join("profile");
        let attachments_dir = data_dir.join("attachments");
        let backups_dir = data_dir.join("backups");
        let exports_dir = data_dir.join("exports");
        fs::create_dir_all(&attachments_dir).unwrap();
        fs::create_dir_all(&backups_dir).unwrap();
        fs::create_dir_all(&exports_dir).unwrap();
        let store = LocalStore {
            database_path: data_dir.join("helvichantier.sqlite3"),
            data_dir,
            attachments_dir,
            backups_dir,
            exports_dir,
            installation_id: "v33-fixture".into(),
            account_protected_cache: AccountProtectedCache::default(),
            license_protected_cache: LicenseProtectedCache::default(),
            operation_lock: Arc::new(Mutex::new(())),
        };
        let connection = Connection::open(&store.database_path).unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE employees(
                   id TEXT PRIMARY KEY,
                   birth_date TEXT,
                   ac_opening_year INTEGER,
                   ac_opening_basis_cents INTEGER,
                   laa_opening_year INTEGER,
                   laa_opening_basis_cents INTEGER,
                   name TEXT NOT NULL,
                   status TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE payslips(
                   id TEXT PRIMARY KEY,
                   employee_id TEXT NOT NULL REFERENCES employees(id),
                   period TEXT NOT NULL,
                   status TEXT NOT NULL,
                   gross_cents INTEGER NOT NULL DEFAULT 0,
                   payment_date TEXT,
                   payment_journal_entry_id TEXT
                 );
                 CREATE TABLE payslip_items(
                   id TEXT PRIMARY KEY,
                   payslip_id TEXT NOT NULL REFERENCES payslips(id)
                 );
                 CREATE TABLE payslip_contributions(
                   id TEXT PRIMARY KEY,
                   payslip_id TEXT NOT NULL REFERENCES payslips(id)
                 );
                 INSERT INTO employees(
                   id,name,status,created_at,updated_at
                 ) VALUES(
                   'legacy-v33','Collaborateur V33','actif',
                   '2026-09-01T00:00:00Z','2026-09-01T00:00:00Z'
                 );
                 PRAGMA user_version=33;",
            )
            .unwrap();
        if incompatible_history_table {
            connection
                .execute_batch(
                    "CREATE TABLE employee_small_salary_decisions(blocker TEXT NOT NULL);",
                )
                .unwrap();
        }
        drop(connection);
        store
    }

    fn insert_employee(connection: &Connection, id: &str) {
        connection
            .execute(
                "INSERT INTO employees(id,name,status,created_at,updated_at)
                 VALUES(?1,'Collaborateur test','actif',?2,?2)",
                params![id, NOW],
            )
            .unwrap();
    }

    fn confirm_decision(connection: &Connection, id: &str, requested: i64) {
        connection
            .execute(
                "UPDATE employees SET
                   small_salary_assessment_year=2026,
                   small_salary_decision_date='2026-01-01',
                   small_salary_sector='ordinary',
                   small_salary_employee_requested_contributions=?,
                   small_salary_opening_gross_cents=0,
                   small_salary_opening_contributed_basis_cents=0,
                   small_salary_evidence_reference='Décision initiale'
                 WHERE id=?",
                params![requested, id],
            )
            .unwrap();
    }

    fn insert_payslip(connection: &Connection, id: &str, employee_id: &str, status: &str) {
        connection
            .execute(
                "INSERT INTO payslips(
                   id,employee_id,period,status,gross_cents,deductions_cents,net_cents,
                   employer_costs_cents,created_at,updated_at
                 ) VALUES(?,?, '2026-06',?,100000,0,100000,0,?4,?4)",
                params![id, employee_id, status, NOW],
            )
            .unwrap();
    }

    fn insert_trace(connection: &Connection, payslip_id: &str, employee_id: &str) {
        let assessment = json!({
            "assessment_year": 2026,
            "decision_revision": 1,
            "decision_date": "2026-01-01",
            "sector": "ordinary",
            "employee_requested_contributions": false,
            "threshold_cents": 250_000,
            "opening_gross_cents": 0,
            "opening_contributed_basis_cents": 0,
            "prior_gross_cents": 0,
            "prior_contributed_basis_cents": 0,
            "current_gross_cents": 100_000,
            "cumulative_gross_cents": 100_000,
            "contributions_due": false,
            "statutory_contribution_basis_cents": 0,
            "statutory_catchup_basis_cents": 0,
            "reason_code": "ordinary_minor_salary_exempt",
            "evidence_reference": "Décision initiale",
        });
        let serialized = serde_json::to_string(&assessment).unwrap();
        let assessment_sha256 = format!("{:x}", Sha256::digest(serialized.as_bytes()));
        connection
            .execute(
                "INSERT INTO payslip_small_salary_assessments(
                   payslip_id,employee_id,assessment_year,decision_revision,decision_date,sector,
                   employee_requested_contributions,threshold_cents,opening_gross_cents,
                   opening_contributed_basis_cents,prior_gross_cents,
                   prior_contributed_basis_cents,current_gross_cents,cumulative_gross_cents,
                   contributions_due,statutory_contribution_basis_cents,
                   statutory_catchup_basis_cents,reason_code,evidence_reference,
                   assessment_json,assessment_sha256,source_reference,created_at
                 ) VALUES(
                   ?,?,2026,1,'2026-01-01','ordinary',0,250000,0,0,0,0,100000,100000,
                   0,0,0,'ordinary_minor_salary_exempt','Décision initiale',?,?,
                   'https://www.ahv-iv.ch/2.04',?
                  )",
                params![payslip_id, employee_id, serialized, assessment_sha256, NOW],
            )
            .unwrap();
    }

    #[test]
    fn v34_migrates_a_v33_layout_without_inventing_an_annual_decision() {
        let temporary = tempfile::tempdir().unwrap();
        let store = v33_fixture_store(temporary.path(), false);

        store.migrate().unwrap();

        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let employee_columns = connection
            .prepare("PRAGMA table_info(employees)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for column in [
            "small_salary_assessment_year",
            "small_salary_decision_date",
            "small_salary_sector",
            "small_salary_employee_requested_contributions",
            "small_salary_opening_gross_cents",
            "small_salary_opening_contributed_basis_cents",
            "small_salary_evidence_reference",
        ] {
            assert!(employee_columns.iter().any(|value| value == column));
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM employee_small_salary_decisions",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "V34 must never invent the client's annual decision"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('payslip_small_salary_assessments')
                     WHERE name='decision_revision'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn v34_failure_rolls_back_columns_tables_triggers_and_schema_version() {
        let temporary = tempfile::tempdir().unwrap();
        let store = v33_fixture_store(temporary.path(), true);

        let error = store.migrate().unwrap_err().to_string();
        assert!(
            error.contains("employee_id") || error.contains("column"),
            "{error}"
        );

        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            33
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('employees')
                     WHERE name LIKE 'small_salary_%'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "ALTER TABLE operations must roll back with the failed migration"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type='table' AND name='payslip_small_salary_assessments'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type='trigger' AND name='employees_small_salary_decision_update_history'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('employee_small_salary_decisions')
                     WHERE name='blocker'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
            "the original V33 blocker table must survive intact"
        );
    }

    #[test]
    fn v34_allows_only_the_immutable_legacy_posted_to_paid_transition_without_trace() {
        let temporary = tempfile::tempdir().unwrap();
        let store = v33_fixture_store(temporary.path(), false);
        {
            let connection = Connection::open(&store.database_path).unwrap();
            connection
                .execute_batch(
                    "INSERT INTO employees(
                       id,birth_date,name,status,created_at,updated_at
                     ) VALUES
                       ('legacy-good','1990-01-01','Legacy good','actif',
                        '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
                       ('legacy-bad','1990-01-01','Legacy bad','actif',
                        '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
                       ('legacy-valid','1990-01-01','Legacy valid','actif',
                        '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
                     INSERT INTO payslips(
                       id,employee_id,period,status,gross_cents
                     ) VALUES
                       ('legacy-good-slip','legacy-good','2026-06','comptabilise',100000),
                       ('legacy-bad-slip','legacy-bad','2026-06','comptabilise',100000),
                       ('legacy-valid-slip','legacy-valid','2026-06','valide',100000);",
                )
                .unwrap();
        }

        store.migrate().unwrap();
        let connection = store.connect().unwrap();
        connection
            .execute(
                "UPDATE payslips SET status='paye',payment_date='2026-06-30',
                   payment_journal_entry_id='legacy-payment-journal'
                 WHERE id='legacy-good-slip'",
                [],
            )
            .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM payslips WHERE id='legacy-good-slip'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "paye"
        );
        assert!(connection
            .execute(
                "UPDATE payslips SET status='paye',payment_date='2026-06-30'
                 WHERE id='legacy-bad-slip'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE payslips SET status='comptabilise',payment_date='2026-06-30',
                   payment_journal_entry_id='not-a-payment-transition'
                 WHERE id='legacy-valid-slip'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO payslips(
                   id,employee_id,period,status,gross_cents,payment_date,
                   payment_journal_entry_id
                 ) VALUES('direct-paid','legacy-good','2026-07','paye',100000,
                          '2026-07-31','direct-journal')",
                [],
            )
            .is_err());
    }

    #[test]
    fn v34_allows_a_structural_correction_before_first_payslip_validation() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();
        insert_employee(&connection, "prevalidation-correction");
        confirm_decision(&connection, "prevalidation-correction", 0);

        connection
            .execute(
                "UPDATE employees SET
                   small_salary_decision_date='2026-02-01',
                   small_salary_sector='private_household',
                   small_salary_opening_gross_cents=1000,
                   small_salary_evidence_reference='Correction avant validation'
                 WHERE id='prevalidation-correction'",
                [],
            )
            .unwrap();

        let revisions = connection
            .prepare(
                "SELECT revision,revision_kind,sector,opening_gross_cents
                 FROM employee_small_salary_decisions
                 WHERE employee_id='prevalidation-correction' ORDER BY revision",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            revisions,
            vec![
                (1, "initial".into(), "ordinary".into(), 0),
                (
                    2,
                    "prevalidation_correction".into(),
                    "private_household".into(),
                    1000,
                ),
            ]
        );
    }

    #[test]
    fn v34_sql_guards_reject_direct_status_and_forged_assessment_traces() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();
        let digest: String = connection
            .query_row("SELECT zentra_sha256('abc')", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        insert_employee(&connection, "no-decision");
        connection
            .execute(
                "UPDATE employees SET birth_date='1990-01-01' WHERE id='no-decision'",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO payslips(
                   id,employee_id,period,status,gross_cents,deductions_cents,net_cents,
                   employer_costs_cents,created_at,updated_at
                 ) VALUES('no-decision-valid','no-decision','2026-06','valide',
                          100000,0,100000,0,?1,?1)",
                params![NOW],
            )
            .is_err());
        insert_employee(&connection, "missing-birth-date");
        assert!(connection
            .execute(
                "INSERT INTO payslips(
                   id,employee_id,period,status,gross_cents,deductions_cents,net_cents,
                   employer_costs_cents,created_at,updated_at
                 ) VALUES('missing-birth-valid','missing-birth-date','2026-06','valide',
                          100000,0,100000,0,?1,?1)",
                params![NOW],
            )
            .is_err());

        insert_employee(&connection, "sql-guard");
        connection
            .execute(
                "UPDATE employees SET birth_date='1990-01-01' WHERE id='sql-guard'",
                [],
            )
            .unwrap();
        confirm_decision(&connection, "sql-guard", 0);
        assert!(connection
            .execute(
                "INSERT INTO payslips(
                   id,employee_id,period,status,gross_cents,deductions_cents,net_cents,
                   employer_costs_cents,created_at,updated_at
                 ) VALUES('direct-valid','sql-guard','2026-06','valide',100000,0,
                          100000,0,?1,?1)",
                params![NOW],
            )
            .is_err());

        insert_payslip(&connection, "guarded-slip", "sql-guard", "brouillon");
        assert!(connection
            .execute(
                "UPDATE payslips SET status='valide' WHERE id='guarded-slip'",
                [],
            )
            .is_err());
        connection
            .pragma_update(None, "trusted_schema", "OFF")
            .unwrap();
        insert_trace(&connection, "guarded-slip", "sql-guard");
        connection
            .execute(
                "UPDATE payslips SET status='valide' WHERE id='guarded-slip'",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "DELETE FROM payslip_small_salary_assessments
                 WHERE payslip_id='guarded-slip'",
                [],
            )
            .is_err());

        connection
            .execute(
                "INSERT INTO payslips(
                   id,employee_id,period,status,gross_cents,deductions_cents,net_cents,
                   employer_costs_cents,created_at,updated_at
                 ) VALUES
                   ('forged-hash','sql-guard','2026-07','brouillon',100000,0,100000,0,?1,?1),
                   ('forged-json','sql-guard','2026-08','brouillon',100000,0,100000,0,?1,?1),
                   ('forged-cumulative','sql-guard','2026-09','brouillon',100000,0,100000,0,?1,?1),
                   ('forged-policy','sql-guard','2026-10','brouillon',100000,0,100000,0,?1,?1)",
                params![NOW],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO payslip_small_salary_assessments
                 SELECT 'forged-hash',employee_id,assessment_year,decision_revision,
                        decision_date,sector,employee_requested_contributions,
                        threshold_cents,opening_gross_cents,
                        opening_contributed_basis_cents,prior_gross_cents,
                        prior_contributed_basis_cents,current_gross_cents,
                        cumulative_gross_cents,contributions_due,
                        statutory_contribution_basis_cents,
                        statutory_catchup_basis_cents,reason_code,evidence_reference,
                        assessment_json,?1,source_reference,created_at
                 FROM payslip_small_salary_assessments WHERE payslip_id='guarded-slip'",
                params!["a".repeat(64)],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO payslip_small_salary_assessments
                 SELECT 'forged-json',employee_id,assessment_year,decision_revision,
                        decision_date,sector,employee_requested_contributions,
                        threshold_cents+1,opening_gross_cents,
                        opening_contributed_basis_cents,prior_gross_cents,
                        prior_contributed_basis_cents,current_gross_cents,
                        cumulative_gross_cents,contributions_due,
                        statutory_contribution_basis_cents,
                        statutory_catchup_basis_cents,reason_code,evidence_reference,
                        assessment_json,assessment_sha256,source_reference,created_at
                 FROM payslip_small_salary_assessments WHERE payslip_id='guarded-slip'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO payslip_small_salary_assessments
                 SELECT 'forged-cumulative',employee_id,assessment_year,decision_revision,
                        decision_date,sector,employee_requested_contributions,
                        threshold_cents,opening_gross_cents,
                        opening_contributed_basis_cents,prior_gross_cents,
                        prior_contributed_basis_cents,current_gross_cents,
                        cumulative_gross_cents+1,contributions_due,
                        statutory_contribution_basis_cents,
                        statutory_catchup_basis_cents,reason_code,evidence_reference,
                        json_set(assessment_json,'$.cumulative_gross_cents',cumulative_gross_cents+1),
                        zentra_sha256(json_set(assessment_json,'$.cumulative_gross_cents',cumulative_gross_cents+1)),
                        source_reference,created_at
                 FROM payslip_small_salary_assessments WHERE payslip_id='guarded-slip'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO payslip_small_salary_assessments
                 SELECT 'forged-policy',employee_id,assessment_year,decision_revision,
                        decision_date,sector,employee_requested_contributions,
                        0,opening_gross_cents,opening_contributed_basis_cents,
                        prior_gross_cents,prior_contributed_basis_cents,current_gross_cents,
                        cumulative_gross_cents,contributions_due,
                        statutory_contribution_basis_cents,
                        statutory_catchup_basis_cents,reason_code,evidence_reference,
                        json_set(assessment_json,'$.threshold_cents',0),
                        zentra_sha256(json_set(assessment_json,'$.threshold_cents',0)),
                        source_reference,created_at
                 FROM payslip_small_salary_assessments WHERE payslip_id='guarded-slip'",
                [],
            )
            .is_err());
    }

    #[test]
    fn v34_is_idempotent_and_enforces_atomic_decisions_and_trace_lifecycle() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        {
            let connection = store.connect().unwrap();
            connection.pragma_update(None, "user_version", 33).unwrap();
        }
        store.migrate().unwrap();
        // Rejouer V34 sur un schéma déjà enrichi doit rester sans effet métier.
        {
            let connection = store.connect().unwrap();
            connection.pragma_update(None, "user_version", 33).unwrap();
        }
        store.migrate().unwrap();

        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let columns = connection
            .prepare("PRAGMA table_info(employees)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for column in [
            "small_salary_assessment_year",
            "small_salary_decision_date",
            "small_salary_sector",
            "small_salary_employee_requested_contributions",
            "small_salary_opening_gross_cents",
            "small_salary_opening_contributed_basis_cents",
            "small_salary_evidence_reference",
        ] {
            assert!(columns.iter().any(|value| value == column), "{column}");
        }

        insert_employee(&connection, "atomic");
        assert!(connection
            .execute(
                "UPDATE employees SET small_salary_assessment_year=2026 WHERE id='atomic'",
                [],
            )
            .is_err());

        // Avant toute première validation, une nouvelle révision structurelle
        // remplace proprement la décision affichée sans sceller une erreur de
        // saisie du questionnaire.
        insert_employee(&connection, "correctable");
        confirm_decision(&connection, "correctable", 0);
        connection
            .execute(
                "UPDATE employees SET
                   small_salary_decision_date='2026-02-01',
                   small_salary_sector='private_household',
                   small_salary_opening_gross_cents=1000,
                   small_salary_evidence_reference='Correction avant validation'
                 WHERE id='correctable'",
                [],
            )
            .unwrap();
        let corrected: (i64, String, String, i64) = connection
            .query_row(
                "SELECT revision,revision_kind,sector,opening_gross_cents
                 FROM employee_small_salary_decisions
                 WHERE employee_id='correctable' ORDER BY revision DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            corrected,
            (
                2,
                "prevalidation_correction".into(),
                "private_household".into(),
                1000
            )
        );
        assert!(connection
            .execute(
                "UPDATE employees SET
                   small_salary_assessment_year=2026,
                   small_salary_decision_date='2025-12-31',
                   small_salary_sector='ordinary',
                   small_salary_employee_requested_contributions=0,
                   small_salary_opening_gross_cents=0,
                   small_salary_opening_contributed_basis_cents=0,
                   small_salary_evidence_reference='Mauvaise année'
                 WHERE id='atomic'",
                [],
            )
            .is_err());

        // Une fiche V33 legacy sans trace autorise exactement la première
        // confirmation complète, puis scelle sa structure annuelle.
        insert_employee(&connection, "legacy");
        connection
            .execute(
                "UPDATE employees SET birth_date='2010-01-01' WHERE id='legacy'",
                [],
            )
            .unwrap();
        insert_payslip(&connection, "legacy-slip", "legacy", "valide");
        confirm_decision(&connection, "legacy", 0);
        assert!(connection
            .execute(
                "UPDATE employees SET small_salary_sector='arts_culture'
                 WHERE id='legacy'",
                [],
            )
            .is_err());

        insert_employee(&connection, "traced");
        confirm_decision(&connection, "traced", 0);
        insert_payslip(&connection, "trace-slip", "traced", "brouillon");
        insert_trace(&connection, "trace-slip", "traced");
        connection
            .execute(
                "UPDATE payslips SET status='valide' WHERE id='trace-slip'",
                [],
            )
            .unwrap();

        // Une année suivante reçoit sa propre décision initiale; la décision
        // 2026 et sa trace restent adressables pour les replays historiques.
        insert_employee(&connection, "rollover");
        confirm_decision(&connection, "rollover", 0);
        insert_payslip(&connection, "rollover-slip", "rollover", "brouillon");
        insert_trace(&connection, "rollover-slip", "rollover");
        connection
            .execute(
                "UPDATE payslips SET status='valide' WHERE id='rollover-slip'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE employees SET
                   small_salary_assessment_year=2027,
                   small_salary_decision_date='2027-01-02',
                   small_salary_sector='ordinary',
                   small_salary_employee_requested_contributions=0,
                   small_salary_opening_gross_cents=0,
                   small_salary_opening_contributed_basis_cents=0,
                   small_salary_evidence_reference='Décision annuelle 2027'
                 WHERE id='rollover'",
                [],
            )
            .unwrap();
        let rollover_rows: Vec<(i64, i64, String)> = connection
            .prepare(
                "SELECT assessment_year,revision,revision_kind
                 FROM employee_small_salary_decisions
                 WHERE employee_id='rollover' ORDER BY assessment_year,revision",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rollover_rows,
            vec![(2026, 1, "initial".into()), (2027, 1, "initial".into())]
        );

        // Une fiche validée reste corrigeable via le workflow contrôlé: retour
        // en brouillon, puis remplacement de la trace, jamais mise à jour.
        assert!(connection
            .execute(
                "UPDATE payslip_small_salary_assessments SET prior_gross_cents=1
                 WHERE payslip_id='trace-slip'",
                [],
            )
            .is_err());
        connection
            .execute(
                "UPDATE payslips SET status='brouillon' WHERE id='trace-slip'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "DELETE FROM payslip_small_salary_assessments WHERE payslip_id='trace-slip'",
                [],
            )
            .unwrap();
        insert_trace(&connection, "trace-slip", "traced");
        connection
            .execute(
                "UPDATE payslips SET status='valide' WHERE id='trace-slip'",
                [],
            )
            .unwrap();

        // La demande prospective est la seule transition admise après une
        // validation: nouvelle preuve et date strictement postérieure à juin.
        connection
            .execute(
                "UPDATE payslips SET payment_date='2026-06-30' WHERE id='trace-slip'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE employees SET
                   small_salary_employee_requested_contributions=1,
                   small_salary_decision_date='2026-07-01',
                   small_salary_evidence_reference='Demande signée juillet'
                 WHERE id='traced'",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "UPDATE employees SET small_salary_employee_requested_contributions=0
                 WHERE id='traced'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE employees SET small_salary_opening_gross_cents=1
                 WHERE id='traced'",
                [],
            )
            .is_err());

        // Une période postérieure déjà comptabilisée scelle la fiche valide
        // dont elle dépend pour ses cumuls annuels.
        insert_employee(&connection, "chain");
        connection
            .execute(
                "UPDATE employees SET birth_date='2010-01-01' WHERE id='chain'",
                [],
            )
            .unwrap();
        confirm_decision(&connection, "chain", 0);
        insert_payslip(&connection, "chain-june", "chain", "valide");
        insert_trace(&connection, "chain-june", "chain");
        connection
            .execute(
                "INSERT INTO payslips(
                   id,employee_id,period,status,gross_cents,deductions_cents,net_cents,
                   employer_costs_cents,created_at,updated_at
                 ) VALUES('chain-july','chain','2026-07','valide',100000,0,
                          100000,0,?1,?1)",
                params![NOW],
            )
            .unwrap();
        assert!(connection
            .execute(
                "UPDATE payslips SET gross_cents=100001 WHERE id='chain-june'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM payslip_small_salary_assessments
                 WHERE payslip_id='chain-june'",
                [],
            )
            .is_err());

        connection
            .execute(
                "UPDATE payslips SET status='comptabilise' WHERE id='trace-slip'",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "DELETE FROM payslip_small_salary_assessments WHERE payslip_id='trace-slip'",
                [],
            )
            .is_err());
    }
}

#[cfg(test)]
mod v37_supplier_email_provenance_migration_tests {
    use super::*;

    const NOW: &str = "2026-09-03T12:00:00Z";

    fn insert_supplier_invoice(connection: &Connection, invoice_id: &str) {
        connection
            .execute(
                "INSERT OR IGNORE INTO suppliers(
                   id,name,currency,payment_terms_days,created_at,updated_at
                 ) VALUES('supplier-email-test','Fournisseur e-mail','CHF',30,?1,?1)",
                params![NOW],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO supplier_invoices(
                   id,supplier_id,document_date,due_date,supplier_name,currency,status,
                   net_cents,vat_cents,total_cents,paid_cents,created_at,updated_at
                 ) VALUES(?1,'supplier-email-test','2026-09-01','2026-10-01',
                          'Fournisseur e-mail','CHF','draft',0,0,0,0,?2,?2)",
                params![invoice_id, NOW],
            )
            .unwrap();
    }

    fn insert_attachment(
        connection: &Connection,
        invoice_id: &str,
        attachment_id: &str,
        attachment_sha256: &str,
    ) {
        connection
            .execute(
                "INSERT INTO attachments(
                   id,entity_type,entity_id,original_name,stored_name,mime_type,
                   size_bytes,sha256,created_at,updated_at
                 ) VALUES(?1,'supplier_invoice',?2,'facture.pdf',?3,
                          'application/pdf',128,?4,?5,?5)",
                params![
                    attachment_id,
                    invoice_id,
                    format!("{attachment_id}.pdf"),
                    attachment_sha256,
                    NOW
                ],
            )
            .unwrap();
    }

    #[test]
    fn fresh_v37_schema_exposes_and_protects_email_invoice_provenance() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type='table' AND name='supplier_email_invoice_imports'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );

        let source_sha256 = "a".repeat(64);
        let attachment_sha256 = "b".repeat(64);
        insert_supplier_invoice(&connection, "invoice-email-1");
        insert_attachment(
            &connection,
            "invoice-email-1",
            "attachment-email-1",
            &attachment_sha256,
        );
        connection
            .execute(
                "INSERT INTO supplier_email_invoice_imports(
                   supplier_invoice_id,source_sha256,source_message_id,source_file_name,
                   attachment_sha256,attachment_id,created_at
                 ) VALUES(?1,?2,'<message-1@example.test>','facture.eml',?3,
                          'attachment-email-1',?4)",
                params!["invoice-email-1", source_sha256, attachment_sha256, NOW],
            )
            .unwrap();

        assert!(connection
            .execute(
                "UPDATE supplier_email_invoice_imports
                 SET source_file_name='modifie.eml' WHERE supplier_invoice_id='invoice-email-1'",
                [],
            )
            .is_err());
        assert!(connection
            .execute("DELETE FROM attachments WHERE id='attachment-email-1'", [],)
            .is_err());

        insert_supplier_invoice(&connection, "invoice-email-2");
        assert!(connection
            .execute(
                "INSERT INTO supplier_email_invoice_imports(
                   supplier_invoice_id,source_sha256,source_message_id,source_file_name,created_at
                 ) VALUES('invoice-email-2',?1,'<message-2@example.test>','facture-2.eml',?2)",
                params![source_sha256, NOW],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO supplier_email_invoice_imports(
                   supplier_invoice_id,source_sha256,source_message_id,source_file_name,created_at
                 ) VALUES('invoice-email-2',?1,'<MESSAGE-1@EXAMPLE.TEST>','facture-2.eml',?2)",
                params!["c".repeat(64), NOW],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO supplier_email_invoice_imports(
                   supplier_invoice_id,source_sha256,source_file_name,attachment_sha256,
                   attachment_id,created_at
                 ) VALUES('invoice-email-2',?1,'facture-2.eml',?2,
                          'attachment-email-1',?3)",
                params!["d".repeat(64), attachment_sha256, NOW],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO supplier_email_invoice_imports(
                   supplier_invoice_id,source_sha256,source_file_name,created_at
                 ) VALUES('invoice-email-2',?1,'../facture.eml',?2)",
                params!["E".repeat(64), NOW],
            )
            .is_err());

        connection
            .execute(
                "INSERT INTO settings(
                   id,onboarding_completed,company_name,created_at,updated_at
                 ) VALUES(1,1,'Entreprise test',?1,?1)",
                params![NOW],
            )
            .unwrap();
        drop(connection);
        let workspace = store.get_workspace().unwrap();
        assert_eq!(
            workspace["supplier_email_invoice_imports"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            workspace["supplier_email_invoice_imports"][0]["source_file_name"],
            "facture.eml"
        );
    }

    #[test]
    fn dispatch_migrates_v36_to_v37_without_changing_existing_invoices() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        {
            let connection = store.connect().unwrap();
            insert_supplier_invoice(&connection, "invoice-before-v37");
            connection
                .execute_batch(
                    "DROP TABLE supplier_email_invoice_imports;
                     PRAGMA user_version=36;",
                )
                .unwrap();
        }

        store.migrate().unwrap();
        store.migrate().unwrap();

        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM supplier_invoices WHERE id='invoice-before-v37'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "draft"
        );
        let attachment_sha256 = "e".repeat(64);
        insert_attachment(
            &connection,
            "invoice-before-v37",
            "attachment-before-v37",
            &attachment_sha256,
        );
        connection
            .execute(
                "INSERT INTO supplier_email_invoice_imports(
                   supplier_invoice_id,source_sha256,source_file_name,
                   attachment_sha256,attachment_id,created_at
                 ) VALUES('invoice-before-v37',?1,'source.eml',?2,
                          'attachment-before-v37',?3)",
                params!["f".repeat(64), attachment_sha256, NOW],
            )
            .unwrap();
        connection
            .execute(
                "DELETE FROM supplier_invoices WHERE id='invoice-before-v37'",
                [],
            )
            .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM supplier_email_invoice_imports",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "la provenance d'un brouillon supprimé doit suivre sa facture"
        );
    }

    #[test]
    fn v37_rejects_provenance_deletion_once_the_invoice_is_no_longer_a_draft() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection
            .execute_batch(
                "CREATE TABLE supplier_invoices(id TEXT PRIMARY KEY,status TEXT NOT NULL);
                 CREATE TABLE attachments(
                   id TEXT PRIMARY KEY,entity_type TEXT,entity_id TEXT,sha256 TEXT
                 );
                 INSERT INTO supplier_invoices VALUES('invoice-sealed','draft');",
            )
            .unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        migrate_v37(&transaction).unwrap();
        transaction.commit().unwrap();
        connection
            .execute(
                "INSERT INTO attachments(id,entity_type,entity_id,sha256)
                 VALUES('attachment-sealed','supplier_invoice','invoice-sealed',?1)",
                params!["2".repeat(64)],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO supplier_email_invoice_imports(
                   supplier_invoice_id,source_sha256,source_file_name,
                   attachment_sha256,attachment_id,created_at
                 ) VALUES('invoice-sealed',?1,'source.eml',?2,
                          'attachment-sealed',?3)",
                params!["1".repeat(64), "2".repeat(64), NOW],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE supplier_invoices SET status='validated' WHERE id='invoice-sealed'",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "DELETE FROM supplier_email_invoice_imports
                 WHERE supplier_invoice_id='invoice-sealed'",
                [],
            )
            .is_err());
    }
}

#[cfg(test)]
mod v40_invoice_deposit_migration_tests {
    use super::*;

    #[test]
    fn deposit_percentage_is_required_only_for_deposit_invoices() {
        let mut missing = json!({"title":"Acompte","type":"deposit"})
            .as_object()
            .unwrap()
            .clone();
        let error = normalize_record("invoices", &mut missing, true).unwrap_err();
        assert!(error.to_string().contains("deposit_percentage_bp"));

        let mut valid = json!({
            "title":"Acompte",
            "type":"deposit",
            "deposit_percentage_bp":3_000,
            "deposit_basis_json":[{
                "id":"base-1",
                "catalog_item_id":null,
                "description":"Mandat détaillé",
                "quantity":2,
                "unit":"heure",
                "unit_price_cents":5_000,
                "discount_bp":0,
                "vat_bp":810
            }]
        })
        .as_object()
        .unwrap()
        .clone();
        normalize_record("invoices", &mut valid, true).unwrap();
        assert_eq!(valid["type"], "acompte");
        assert_eq!(valid["deposit_percentage_bp"], 3_000);

        let mut missing_basis = json!({
            "title":"Nouvel acompte sans base",
            "type":"deposit",
            "deposit_percentage_bp":3_000
        })
        .as_object()
        .unwrap()
        .clone();
        assert!(normalize_record("invoices", &mut missing_basis, true)
            .unwrap_err()
            .to_string()
            .contains("base détaillée"));

        let mut legacy = json!({
            "title":"Acompte historique",
            "type":"acompte",
            "deposit_percentage_bp":3_000,
            "deposit_basis_json":null
        })
        .as_object()
        .unwrap()
        .clone();
        normalize_record("invoices", &mut legacy, false).unwrap();

        for invalid in [json!(0), json!(10_001), json!(30.5), Value::Null] {
            let mut record = json!({
                "title":"Acompte",
                "type":"acompte",
                "deposit_percentage_bp":invalid
            })
            .as_object()
            .unwrap()
            .clone();
            assert!(normalize_record("invoices", &mut record, true).is_err());
        }

        let mut standard = json!({
            "title":"Facture",
            "type":"standard",
            "deposit_percentage_bp":3_000
        })
        .as_object()
        .unwrap()
        .clone();
        assert!(normalize_record("invoices", &mut standard, true)
            .unwrap_err()
            .to_string()
            .contains("doit être null"));
    }

    #[test]
    fn migration_v40_is_idempotent_preserves_invoices_and_seals_the_new_financial_field() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE invoices (
                   id TEXT PRIMARY KEY,
                   client_id TEXT,
                   project_id TEXT,
                   quote_id TEXT,
                   original_invoice_id TEXT,
                   number TEXT,
                   title TEXT NOT NULL,
                   type TEXT NOT NULL DEFAULT 'standard',
                   status TEXT NOT NULL DEFAULT 'brouillon',
                   issue_date TEXT,
                   due_date TEXT,
                   service_date_from TEXT,
                   service_date_to TEXT,
                   currency TEXT NOT NULL DEFAULT 'CHF',
                   subtotal_cents INTEGER NOT NULL DEFAULT 0,
                   discount_cents INTEGER NOT NULL DEFAULT 0,
                   vat_cents INTEGER NOT NULL DEFAULT 0,
                   total_cents INTEGER NOT NULL DEFAULT 0,
                   paid_cents INTEGER NOT NULL DEFAULT 0,
                   notes TEXT,
                   terms TEXT,
                   snapshot_json TEXT,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE sales_order_invoice_batches(invoice_id TEXT);
                 INSERT INTO invoices(
                   id,number,title,type,status,issue_date,total_cents,created_at,updated_at
                 ) VALUES(
                   'invoice-issued','F-2026-0001','Facture historique','standard','emise',
                   '2026-09-01',10000,'2026-09-01T00:00:00Z','2026-09-01T00:00:00Z'
                 );
                 INSERT INTO invoices(
                   id,title,type,status,created_at,updated_at
                 ) VALUES(
                   'invoice-legacy-deposit','Acompte historique','acompte','brouillon',
                   '2026-09-01T00:00:00Z','2026-09-01T00:00:00Z'
                 );
                 PRAGMA user_version=39;",
            )
            .unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        migrate_v40(&transaction).unwrap();
        transaction.commit().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        migrate_v40(&transaction).unwrap();
        transaction.commit().unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            40
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM invoices WHERE id='invoice-issued'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Facture historique"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT deposit_percentage_bp FROM invoices WHERE id='invoice-legacy-deposit'",
                    [],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .unwrap(),
            None,
            "la migration ne doit pas inventer un pourcentage historique"
        );
        assert!(connection
            .execute(
                "UPDATE invoices SET deposit_percentage_bp=3000 WHERE id='invoice-issued'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE invoices SET deposit_percentage_bp=10001 WHERE id='invoice-legacy-deposit'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE invoices SET deposit_percentage_bp=30.5 WHERE id='invoice-legacy-deposit'",
                [],
            )
            .is_err());

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        migrate_v41(&transaction).unwrap();
        transaction.commit().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        migrate_v41(&transaction).unwrap();
        transaction.commit().unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            41
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT deposit_basis_json FROM invoices WHERE id='invoice-legacy-deposit'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap(),
            None,
            "la migration ne doit pas inventer la base d'un acompte historique"
        );
        let detailed_basis = r#"[{"id":"base-1","catalog_item_id":null,"description":"Mandat","quantity":2,"unit":"heure","unit_price_cents":5000,"discount_bp":0,"vat_bp":810}]"#;
        connection
            .execute(
                "UPDATE invoices SET deposit_basis_json=? WHERE id='invoice-legacy-deposit'",
                params![detailed_basis],
            )
            .unwrap();
        assert!(connection
            .execute(
                "UPDATE invoices SET deposit_basis_json='{}' WHERE id='invoice-legacy-deposit'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE invoices SET deposit_basis_json='[]' WHERE id='invoice-issued'",
                [],
            )
            .is_err());
    }
}
