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
    error::{AppError, AppResult},
    models::{AppStateInfo, DeleteResult, OnboardingInput, RecordPaymentInput, TimerInput},
    schema::{SCHEMA_SQL, SCHEMA_VERSION},
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
    operation_lock: Arc<Mutex<()>>,
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

        let store = Self {
            database_path: data_dir.join("helvichantier.sqlite3"),
            data_dir,
            attachments_dir,
            backups_dir,
            exports_dir,
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
        let connection = self.connect()?;
        let current: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if current > SCHEMA_VERSION {
            return Err(AppError::Validation(format!(
                "La base locale utilise une version plus récente ({current}) que cette application ({SCHEMA_VERSION})."
            )));
        }
        connection.execute_batch(SCHEMA_SQL)?;
        Ok(())
    }

    pub fn app_state(&self, app_version: &str) -> AppResult<AppStateInfo> {
        let connection = self.connect()?;
        let onboarding_completed = connection
            .query_row(
                "SELECT onboarding_completed FROM settings WHERE id = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            == 1;
        Ok(AppStateInfo {
            onboarding_completed,
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

    pub fn complete_onboarding(
        &self,
        input: OnboardingInput,
        app_version: &str,
    ) -> AppResult<AppStateInfo> {
        let company_name = required_text(&input.company_name, "company_name", 200)?;
        let currency = normalized_code(&input.currency, "currency", 3, "CHF")?;
        let quote_prefix = normalized_prefix(&input.quote_prefix, "D")?;
        let invoice_prefix = normalized_prefix(&input.invoice_prefix, "F")?;
        let default_vat_bp = match (input.vat_registered, input.default_vat_bp) {
            (true, Some(value)) if (1..=10_000).contains(&value) => value,
            (true, _) => {
                return Err(AppError::Validation(
                    "Un taux de TVA explicite est obligatoire pour une entreprise assujettie."
                        .into(),
                ))
            }
            (false, None | Some(0)) => 0,
            (false, Some(_)) => {
                return Err(AppError::Validation(
                    "Le taux de TVA doit être 0 pour une entreprise non assujettie.".into(),
                ))
            }
        };
        if !(0..=365).contains(&input.payment_terms_days) {
            return Err(AppError::Validation(
                "payment_terms_days doit être compris entre 0 et 365.".into(),
            ));
        }
        if !(0..=365).contains(&input.quote_validity_days) {
            return Err(AppError::Validation(
                "quote_validity_days doit être compris entre 0 et 365.".into(),
            ));
        }
        if input.default_hourly_rate_cents < 0 {
            return Err(AppError::Validation(
                "default_hourly_rate_cents ne peut pas être négatif.".into(),
            ));
        }
        let extra_settings_json = normalize_json_object(input.extra_settings_json)?;
        let now = now_iso();
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            r#"INSERT INTO settings (
                id,onboarding_completed,company_name,legal_form,owner_name,email,phone,
                address_line1,address_line2,postal_code,city,canton,country,uid_number,
                vat_number,vat_registered,default_vat_bp,iban,bank_name,currency,
                quote_prefix,invoice_prefix,payment_terms_days,quote_validity_days,
                default_hourly_rate_cents,logo_path,extra_settings_json,created_at,updated_at
              ) VALUES (
                1,1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,
                ?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27
              )
              ON CONFLICT(id) DO UPDATE SET
                onboarding_completed=1,company_name=excluded.company_name,
                legal_form=excluded.legal_form,owner_name=excluded.owner_name,
                email=excluded.email,phone=excluded.phone,address_line1=excluded.address_line1,
                address_line2=excluded.address_line2,postal_code=excluded.postal_code,
                city=excluded.city,canton=excluded.canton,country=excluded.country,
                uid_number=excluded.uid_number,vat_number=excluded.vat_number,
                vat_registered=excluded.vat_registered,default_vat_bp=excluded.default_vat_bp,
                iban=excluded.iban,bank_name=excluded.bank_name,currency=excluded.currency,
                quote_prefix=excluded.quote_prefix,invoice_prefix=excluded.invoice_prefix,
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
                clean_optional(input.uid_number, 80),
                clean_optional(input.vat_number, 80),
                bool_to_i64(input.vat_registered),
                default_vat_bp,
                clean_optional(input.iban, 80),
                clean_optional(input.bank_name, 160),
                currency,
                quote_prefix,
                invoice_prefix,
                input.payment_terms_days,
                input.quote_validity_days,
                input.default_hourly_rate_cents,
                clean_optional(input.logo_path, 2000),
                extra_settings_json,
                now,
                now,
            ],
        )?;
        transaction.commit()?;
        self.app_state(app_version)
    }

    pub fn get_workspace(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let settings = query_optional(&connection, "SELECT * FROM settings WHERE id = 1", [])?;
        let clients = query_all(
            &connection,
            "SELECT * FROM clients ORDER BY name, created_at",
            [],
        )?;
        let projects = query_all(
            &connection,
            "SELECT * FROM projects ORDER BY CASE status WHEN 'en_cours' THEN 0 WHEN 'planifie' THEN 1 ELSE 2 END, COALESCE(planned_start_date, created_at) DESC",
            [],
        )?;
        let quotes = query_all(
            &connection,
            "SELECT * FROM quotes ORDER BY COALESCE(issue_date, created_at) DESC, created_at DESC",
            [],
        )?;
        let quote_items = query_all(
            &connection,
            "SELECT * FROM quote_items ORDER BY quote_id, position, created_at",
            [],
        )?;
        let invoices = query_all(
            &connection,
            "SELECT * FROM invoices ORDER BY COALESCE(issue_date, created_at) DESC, created_at DESC",
            [],
        )?;
        let invoice_items = query_all(
            &connection,
            "SELECT * FROM invoice_items ORDER BY invoice_id, position, created_at",
            [],
        )?;
        let employees = query_all(
            &connection,
            "SELECT * FROM employees ORDER BY name, created_at",
            [],
        )?;
        let time_entries = query_all(
            &connection,
            "SELECT * FROM time_entries ORDER BY date DESC, created_at DESC",
            [],
        )?;
        let expenses = query_all(
            &connection,
            "SELECT * FROM expenses ORDER BY date DESC, created_at DESC",
            [],
        )?;
        let payslips = query_all(
            &connection,
            "SELECT * FROM payslips ORDER BY period DESC, created_at DESC",
            [],
        )?;
        let payslip_items = query_all(
            &connection,
            "SELECT * FROM payslip_items ORDER BY payslip_id, position, created_at",
            [],
        )?;
        let payments = query_all(
            &connection,
            "SELECT * FROM payments ORDER BY date DESC, created_at DESC",
            [],
        )?;
        let attachments = query_all(
            &connection,
            "SELECT * FROM attachments ORDER BY created_at DESC",
            [],
        )?;
        let active_timer =
            query_optional(&connection, "SELECT * FROM active_timers WHERE id = 1", [])?;

        Ok(json!({
            "settings": settings,
            "clients": clients,
            "projects": projects,
            "quotes": quotes,
            "quote_items": quote_items,
            "invoices": invoices,
            "invoice_items": invoice_items,
            "employees": employees,
            "time_entries": time_entries,
            "expenses": expenses,
            "payslips": payslips,
            "payslip_items": payslip_items,
            "payments": payments,
            "attachments": attachments,
            "active_timer": active_timer,
        }))
    }

    pub fn create_record(&self, entity: &str, data: Value) -> AppResult<Value> {
        if entity == "payments" {
            let input: RecordPaymentInput = serde_json::from_value(data)?;
            return self.record_payment(input);
        }
        if entity == "attachments" {
            return self.add_attachment(data);
        }

        let spec = entity_spec(entity)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut object = value_object(data)?;
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
        transaction.execute(&sql, params_from_iter(values))?;
        recompute_after_change(&transaction, entity, &object, None)?;
        let record = query_record_tx(&transaction, spec.table, &id)?;
        transaction.commit()?;
        Ok(record)
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
        strip_readonly_fields(entity, &mut object);
        validate_keys(&object, spec.fields)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = query_record_tx(&transaction, spec.table, id)?;
        normalize_record_patch(entity, &mut object, &previous)?;
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
        let record = query_record_tx(&transaction, spec.table, id)?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn delete_record(&self, entity: &str, id: &str) -> AppResult<DeleteResult> {
        let spec = entity_spec(entity)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = query_record_tx(&transaction, spec.table, id)?;
        let deleted = transaction.execute(
            &format!("DELETE FROM {} WHERE id = ?", spec.table),
            params![id],
        )? == 1;
        if !deleted {
            return Err(AppError::NotFound(format!("{entity}/{id}")));
        }
        recompute_after_delete(&transaction, entity, &previous)?;
        transaction.commit()?;

        if entity == "attachments" {
            if let Some(stored_name) = previous.get("stored_name").and_then(Value::as_str) {
                self.remove_attachment_file(stored_name)?;
            }
        }
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
            "uid_number",
            "vat_number",
            "vat_registered",
            "default_vat_bp",
            "iban",
            "bank_name",
            "currency",
            "quote_prefix",
            "invoice_prefix",
            "payment_terms_days",
            "quote_validity_days",
            "default_hourly_rate_cents",
            "logo_path",
            "extra_settings_json",
        ];
        let mut object = value_object(data)?;
        validate_keys(&object, FIELDS)?;
        normalize_settings_patch(&mut object)?;
        if object.is_empty() {
            return Err(AppError::Validation("Aucun réglage à modifier.".into()));
        }

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (current_vat_registered, current_vat_bp): (i64, i64) = transaction.query_row(
            "SELECT vat_registered, default_vat_bp FROM settings WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
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
        let record = query_optional_tx(&transaction, "SELECT * FROM settings WHERE id = 1", [])?
            .ok_or(AppError::OnboardingRequired)?;
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
        transaction.execute(
            "UPDATE quotes SET number = ?, status = CASE WHEN status = 'brouillon' THEN 'emis' ELSE status END, issue_date = ?, valid_until = ?, updated_at = ? WHERE id = ?",
            params![number, date, valid, now_iso(), id],
        )?;
        let record = query_record_tx(&transaction, "quotes", id)?;
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
        let date = normalized_date(issue_date.as_deref().unwrap_or(&today()), "issue_date")?;
        let payment_terms_days: i64 = transaction.query_row(
            "SELECT payment_terms_days FROM settings WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let due = match due_date {
            Some(value) if !value.trim().is_empty() => normalized_date(&value, "due_date")?,
            _ => add_days(&date, payment_terms_days)?,
        };
        let number = assign_document_number(&transaction, "invoices", id, "invoice", &date)?;
        transaction.execute(
            "UPDATE invoices SET number = ?, status = CASE WHEN status = 'brouillon' THEN 'emise' ELSE status END, issue_date = ?, due_date = ?, updated_at = ? WHERE id = ?",
            params![number, date, due, now_iso(), id],
        )?;
        let record = query_record_tx(&transaction, "invoices", id)?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn record_payment(&self, input: RecordPaymentInput) -> AppResult<Value> {
        if input.amount_cents <= 0 {
            return Err(AppError::Validation(
                "Le montant du paiement doit être supérieur à zéro.".into(),
            ));
        }
        let date = normalized_date(input.date.as_deref().unwrap_or(&today()), "date")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (total_cents, paid_cents): (i64, i64) = transaction
            .query_row(
                "SELECT total_cents, paid_cents FROM invoices WHERE id = ?",
                params![input.invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("invoices/{}", input.invoice_id)))?;
        if total_cents <= 0 {
            return Err(AppError::Validation(
                "Cette facture ne possède aucun montant payable.".into(),
            ));
        }
        if paid_cents.saturating_add(input.amount_cents) > total_cents {
            return Err(AppError::Validation(
                "Le paiement dépasse le solde restant de la facture.".into(),
            ));
        }
        let id = Uuid::new_v4().to_string();
        let now = now_iso();
        transaction.execute(
            "INSERT INTO payments (id,invoice_id,date,amount_cents,method,reference,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            params![
                id,
                input.invoice_id,
                date,
                input.amount_cents,
                clean_optional(input.method, 80),
                clean_optional(input.reference, 160),
                clean_optional(input.notes, 5000),
                now,
                now,
            ],
        )?;
        refresh_invoice_payment_state(&transaction, &input.invoice_id)?;
        let record = query_record_tx(&transaction, "payments", &id)?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn start_timer(&self, input: TimerInput) -> AppResult<Value> {
        if input.project_id.trim().is_empty() {
            return Err(AppError::Validation("project_id est obligatoire.".into()));
        }
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
            params![input.project_id],
            |row| row.get(0),
        )?;
        if !project_exists {
            return Err(AppError::NotFound(format!("projects/{}", input.project_id)));
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
            "INSERT INTO active_timers (id,project_id,employee_id,started_at,note,billable,billing_rate_cents,cost_rate_cents) VALUES (1,?,?,?,?,?,?,?)",
            params![
                input.project_id,
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
        let minutes = ((elapsed_seconds + 59) / 60).max(1);
        let id = Uuid::new_v4().to_string();
        let now = ended.to_rfc3339();
        transaction.execute(
            "INSERT INTO time_entries (id,project_id,employee_id,date,started_at,ended_at,minutes,break_minutes,billable,billing_rate_cents,cost_rate_cents,note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                id,
                timer.get("project_id").and_then(Value::as_str),
                timer.get("employee_id").and_then(Value::as_str),
                &started_at[..10.min(started_at.len())],
                started_at,
                now,
                minutes,
                0,
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

    pub fn add_attachment(&self, data: Value) -> AppResult<Value> {
        let object = value_object(data)?;
        let source = object
            .get("source_path")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Validation("source_path est obligatoire.".into()))?;
        let source_path = PathBuf::from(source);
        if !source_path.is_file() {
            return Err(AppError::Validation(
                "Le fichier sélectionné est introuvable.".into(),
            ));
        }
        let original_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| AppError::Validation("Nom de fichier invalide.".into()))?
            .to_owned();
        let extension = source_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{}", sanitize_extension(value)))
            .unwrap_or_default();
        let stored_name = format!("{}{}", Uuid::new_v4(), extension);
        let destination = self.attachments_dir.join(&stored_name);
        fs::copy(&source_path, &destination)?;
        let metadata = fs::metadata(&destination)?;
        let sha256 = sha256_file(&destination)?;
        let id = Uuid::new_v4().to_string();
        let now = now_iso();
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        if let Err(error) = connection.execute(
            "INSERT INTO attachments (id,project_id,entity_type,entity_id,original_name,stored_name,mime_type,size_bytes,sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            params![
                id,
                object.get("project_id").and_then(Value::as_str),
                object.get("entity_type").and_then(Value::as_str),
                object.get("entity_id").and_then(Value::as_str),
                original_name,
                stored_name,
                object.get("mime_type").and_then(Value::as_str),
                i64::try_from(metadata.len()).unwrap_or(i64::MAX),
                sha256,
                now,
                now,
            ],
        ) {
            let _ = fs::remove_file(&destination);
            return Err(error.into());
        }
        query_record(&connection, "attachments", &id)
    }

    pub fn attachment_path(&self, id: &str) -> AppResult<PathBuf> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let stored_name: String = connection
            .query_row(
                "SELECT stored_name FROM attachments WHERE id = ?",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("attachments/{id}")))?;
        self.safe_attachment_path(&stored_name)
    }

    pub fn open_attachment(&self, id: &str) -> AppResult<String> {
        let path = self.attachment_path(id)?;
        open_path(&path)?;
        Ok(path.to_string_lossy().into_owned())
    }

    pub fn open_data_folder(&self) -> AppResult<String> {
        open_path(&self.data_dir)?;
        Ok(self.data_dir.to_string_lossy().into_owned())
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

    fn remove_attachment_file(&self, stored_name: &str) -> AppResult<()> {
        let path = self.safe_attachment_path(stored_name)?;
        if path.is_file() {
            fs::remove_file(path)?;
        }
        Ok(())
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
                "title",
                "type",
                "status",
                "issue_date",
                "due_date",
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
                "birth_date",
                "social_security_number",
                "iban",
                "employment_start_date",
                "employment_end_date",
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
                "date",
                "supplier",
                "category",
                "reference",
                "currency",
                "net_cents",
                "vat_cents",
                "total_cents",
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
            fields: &["payslip_id", "position", "label", "kind", "amount_cents"],
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
        "attachments" => EntitySpec {
            table: "attachments",
            fields: &[
                "project_id",
                "entity_type",
                "entity_id",
                "original_name",
                "mime_type",
            ],
            required: &["original_name"],
        },
        _ => {
            return Err(AppError::Validation(format!(
                "Entité non autorisée : {entity}"
            )))
        }
    };
    Ok(spec)
}

fn value_object(data: Value) -> AppResult<Map<String, Value>> {
    data.as_object()
        .cloned()
        .ok_or_else(|| AppError::Validation("Les données doivent être un objet JSON.".into()))
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
            "subtotal_cents",
            "discount_cents",
            "vat_cents",
            "total_cents",
        ],
        "invoices" => &[
            "number",
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
        "expenses" => {
            let net = object.get("net_cents").and_then(Value::as_i64).unwrap_or(0);
            let vat = object.get("vat_cents").and_then(Value::as_i64).unwrap_or(0);
            if !object.contains_key("total_cents") {
                object.insert("total_cents".into(), json!(net.saturating_add(vat)));
            }
        }
        "payslips" => {
            let gross = object
                .get("gross_cents")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let deductions = object
                .get("deductions_cents")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if !object.contains_key("net_cents") {
                object.insert("net_cents".into(), json!(gross.saturating_sub(deductions)));
            }
        }
        "payslip_items" => {
            if let Some(kind) = object.get_mut("kind") {
                let normalized = match kind.as_str().unwrap_or_default() {
                    "earning" | "gain" => "earning",
                    "deduction" => "deduction",
                    "employer" => "employer",
                    _ => {
                        return Err(AppError::Validation(
                            "kind doit être earning, deduction ou employer.".into(),
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
        "time_entries" => {
            if object
                .get("minutes")
                .and_then(Value::as_i64)
                .is_some_and(|value| value < 0)
            {
                return Err(AppError::Validation(
                    "minutes ne peut pas être négatif.".into(),
                ));
            }
        }
        _ => {}
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
        "payslips" => {
            if object.contains_key("gross_cents") || object.contains_key("deductions_cents") {
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
        }
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
    let discount = ((base as i128 * discount_bp as i128 + 5_000) / 10_000) as i64;
    let net = base.saturating_sub(discount);
    let vat = ((net as i128 * vat_bp as i128 + 5_000) / 10_000) as i64;
    object.insert("quantity".into(), json!(quantity));
    object.insert("line_net_cents".into(), json!(net));
    object.insert("line_vat_cents".into(), json!(vat));
    object.insert("line_total_cents".into(), json!(net.saturating_add(vat)));
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
    if let Some(value) = object.get_mut("quote_prefix") {
        *value = Value::String(normalized_prefix(value.as_str().unwrap_or("D"), "D")?);
    }
    if let Some(value) = object.get_mut("invoice_prefix") {
        *value = Value::String(normalized_prefix(value.as_str().unwrap_or("F"), "F")?);
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

fn recompute_invoice(transaction: &Transaction<'_>, invoice_id: &str) -> AppResult<()> {
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
    let (gross, deductions, employer): (i64, i64, i64) = transaction.query_row(
        "SELECT COALESCE(SUM(CASE WHEN kind IN ('earning','gain') THEN amount_cents ELSE 0 END),0), COALESCE(SUM(CASE WHEN kind='deduction' THEN ABS(amount_cents) ELSE 0 END),0), COALESCE(SUM(CASE WHEN kind='employer' THEN amount_cents ELSE 0 END),0) FROM payslip_items WHERE payslip_id = ?",
        params![payslip_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    transaction.execute(
        "UPDATE payslips SET gross_cents=?,deductions_cents=?,net_cents=?,employer_costs_cents=?,updated_at=? WHERE id=?",
        params![gross, deductions, gross.saturating_sub(deductions), employer, now_iso(), payslip_id],
    )?;
    Ok(())
}

fn refresh_invoice_payment_state(transaction: &Transaction<'_>, invoice_id: &str) -> AppResult<()> {
    let paid: i64 = transaction.query_row(
        "SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE invoice_id = ?",
        params![invoice_id],
        |row| row.get(0),
    )?;
    transaction.execute(
        "UPDATE invoices SET paid_cents=?, status=CASE WHEN status='annulee' THEN status WHEN ? >= total_cents AND total_cents > 0 THEN 'payee' WHEN ? > 0 THEN 'partiellement_payee' WHEN number IS NOT NULL THEN 'emise' ELSE 'brouillon' END, updated_at=? WHERE id=?",
        params![paid, paid, paid, now_iso(), invoice_id],
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
    let prefix_column = if document_type == "quote" {
        "quote_prefix"
    } else {
        "invoice_prefix"
    };
    let prefix: String = transaction.query_row(
        &format!("SELECT {prefix_column} FROM settings WHERE id = 1"),
        [],
        |row| row.get(0),
    )?;
    let current: Option<i64> = transaction
        .query_row(
            "SELECT next_value FROM number_sequences WHERE document_type = ? AND year = ?",
            params![document_type, year],
            |row| row.get(0),
        )
        .optional()?;
    let next = current.unwrap_or(1);
    transaction.execute(
        "INSERT INTO number_sequences (document_type,year,next_value) VALUES (?,?,?) ON CONFLICT(document_type,year) DO UPDATE SET next_value=excluded.next_value",
        params![document_type, year, next + 1],
    )?;
    Ok(format!("{prefix}-{year}-{next:04}"))
}

fn query_record(connection: &Connection, table: &str, id: &str) -> AppResult<Value> {
    query_optional(
        connection,
        &format!("SELECT * FROM {table} WHERE id = ?"),
        params![id],
    )?
    .ok_or_else(|| AppError::NotFound(format!("{table}/{id}")))
}

fn query_record_tx(transaction: &Transaction<'_>, table: &str, id: &str) -> AppResult<Value> {
    query_optional_tx(
        transaction,
        &format!("SELECT * FROM {table} WHERE id = ?"),
        params![id],
    )?
    .ok_or_else(|| AppError::NotFound(format!("{table}/{id}")))
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

fn is_boolean_column(name: &str) -> bool {
    matches!(
        name,
        "onboarding_completed" | "vat_registered" | "billable" | "reimbursable"
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
    Ok(serde_json::to_string(&value)?)
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

fn sanitize_extension(extension: &str) -> String {
    extension
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>()
        .to_lowercase()
}

fn sha256_file(path: &Path) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
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
