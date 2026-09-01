use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Transaction,
    TransactionBehavior,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
    models::{
        AccountInput, AccountingPeriodInput, AccountingSettingsInput, LedgerInput,
        ManualJournalInput, PeriodFilter,
    },
};

#[derive(Debug, Clone)]
struct AccountingMap {
    ar: String,
    revenue: String,
    vat_payable: String,
    bank: String,
    expense: String,
    vat_receivable: String,
    wages_expense: Option<String>,
    wages_payable: Option<String>,
    social_expense: Option<String>,
    social_payable: Option<String>,
    supplier_payable: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EntryLine {
    pub account_id: String,
    pub debit_cents: i64,
    pub credit_cents: i64,
    pub currency: String,
    pub memo: Option<String>,
    pub project_id: Option<String>,
    pub client_id: Option<String>,
    pub employee_id: Option<String>,
}

type InvoicePostingRow = (
    String,
    i64,
    i64,
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn payroll_accounting_mappings_required(connection: &Connection) -> AppResult<bool> {
    connection
        .query_row(
            "SELECT COALESCE(json_extract(extra_settings_json,'$.payroll.enabled'),0)=1
                OR EXISTS(SELECT 1 FROM payslips WHERE status IN('comptabilise','paye'))
             FROM settings WHERE id=1",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

impl LocalStore {
    pub fn list_accounting_periods(&self) -> AppResult<Value> {
        let c = self.connect()?;
        self.require_onboarding(&c)?;
        Ok(Value::Array(query_all(
            &c,
            "SELECT * FROM accounting_periods ORDER BY date_from DESC",
            [],
        )?))
    }

    pub fn upsert_accounting_period(&self, input: AccountingPeriodInput) -> AppResult<Value> {
        validate_date(&input.date_from, "date_from")?;
        validate_date(&input.date_to, "date_to")?;
        if input.date_from > input.date_to {
            return Err(AppError::Validation(
                "date_from doit précéder date_to.".into(),
            ));
        }
        let name = required(&input.name, "name", 120)?;
        let id = input
            .id
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut c = self.connect()?;
        self.require_onboarding(&c)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let closed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM accounting_periods WHERE id=? AND status='closed')",
            params![id],
            |r| r.get(0),
        )?;
        if closed {
            return Err(AppError::Validation(
                "Une période clôturée est irréversible.".into(),
            ));
        }
        let overlap:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM accounting_periods WHERE id<>? AND NOT(date_to<? OR date_from>?))",params![id,input.date_from,input.date_to],|r|r.get(0))?;
        if overlap {
            return Err(AppError::Validation(
                "Cette période chevauche une période comptable existante.".into(),
            ));
        }
        let now = now_iso();
        tx.execute("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES(?,?,?,?,'open',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,date_from=excluded.date_from,date_to=excluded.date_to,updated_at=excluded.updated_at",params![id,name,input.date_from,input.date_to,now,now])?;
        let row = one_json(
            &tx,
            "SELECT * FROM accounting_periods WHERE id=?",
            params![id],
        )?;
        append_audit(&tx, "upsert", "accounting_period", &id, &row)?;
        tx.commit()?;
        Ok(row)
    }

    pub fn close_accounting_period(&self, id: &str) -> AppResult<Value> {
        let mut c = self.connect()?;
        self.require_onboarding(&c)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let period = one_json(
            &tx,
            "SELECT * FROM accounting_periods WHERE id=?",
            params![id],
        )?;
        if period["status"] == "closed" {
            return Ok(period);
        }
        let date_from = period["date_from"].as_str().ok_or_else(|| {
            AppError::Validation("La période n'a pas de date de début valide.".into())
        })?;
        let date_to = period["date_to"].as_str().ok_or_else(|| {
            AppError::Validation("La période n'a pas de date de fin valide.".into())
        })?;
        let unresolved_closed_history = closed_history_unposted_count(&tx)?;
        if unresolved_closed_history != 0 {
            return Err(AppError::Validation(format!(
                "La clôture est bloquée : {unresolved_closed_history} opération(s) d'une période déjà fermée ne figurent pas dans la reprise comptable. Préparez un solde d'ouverture contrôlé avec votre fiduciaire avant de clôturer un nouvel exercice."
            )));
        }
        let semantic_mismatches = semantic_posting_mismatches_in_range(&tx, "0001-01-01", date_to)?;
        if semantic_mismatches != 0 {
            return Err(AppError::Validation(format!(
                "La clôture est bloquée : {semantic_mismatches} écriture(s) automatique(s) ne correspondent pas exactement à leur opération métier (date, montant, devise ou compte lié). Corrigez-les depuis l'assistant de continuité."
            )));
        }
        let incomplete_sources =
            financial_sources_without_effective_posting_in_range(&tx, date_from, date_to)?;
        if incomplete_sources != 0 {
            return Err(AppError::Validation(format!(
                "La clôture est bloquée : {incomplete_sources} opération(s) financière(s) de cette période n'ont pas une écriture comptable active et traçable. Activez ou corrigez la comptabilité, puis relancez le contrôle."
            )));
        }
        let unbalanced:i64=tx.query_row("SELECT COUNT(*) FROM (SELECT je.id FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id WHERE je.entry_date BETWEEN ? AND ? GROUP BY je.id HAVING SUM(jl.debit_cents)<>SUM(jl.credit_cents))",params![period["date_from"].as_str(),period["date_to"].as_str()],|r|r.get(0))?;
        if unbalanced != 0 {
            return Err(AppError::Validation(
                "La période contient des écritures déséquilibrées.".into(),
            ));
        }
        // The balance sheet produced for the closing date is cumulative. Refuse the close if any
        // historical journal line up to that date uses another currency, otherwise the period
        // could be marked closed while its statutory balance sheet remains impossible to render.
        crate::accounting_closure::ensure_base_currency_for_ranges(
            &tx,
            &[("0001-01-01", date_to)],
        )?;
        let now = now_iso();
        tx.execute(
            "UPDATE accounting_periods SET status='closed',closed_at=?,updated_at=? WHERE id=?",
            params![now, now, id],
        )?;
        let row = one_json(
            &tx,
            "SELECT * FROM accounting_periods WHERE id=?",
            params![id],
        )?;
        append_audit(&tx, "close", "accounting_period", id, &row)?;
        tx.commit()?;
        Ok(row)
    }

    pub fn list_accounts(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(Value::Array(query_all(
            &connection,
            "SELECT * FROM accounts ORDER BY code, name",
            [],
        )?))
    }

    pub fn upsert_account(&self, input: AccountInput) -> AppResult<Value> {
        let code = required(&input.code, "code", 32)?.to_uppercase();
        let name = required(&input.name, "name", 200)?;
        if !matches!(
            input.account_type.as_str(),
            "asset" | "liability" | "equity" | "revenue" | "expense"
        ) {
            return Err(AppError::Validation(
                "account_type doit être asset, liability, equity, revenue ou expense.".into(),
            ));
        }
        if !matches!(input.normal_balance.as_str(), "debit" | "credit") {
            return Err(AppError::Validation(
                "normal_balance doit être debit ou credit.".into(),
            ));
        }
        if !valid_report_section(&input.account_type, &input.report_section) {
            return Err(AppError::Validation(
                "report_section est invalide ou incompatible avec account_type.".into(),
            ));
        }
        let id = input
            .id
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = now_iso();
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String, String, String)> = tx
            .query_row(
                "SELECT code,account_type,normal_balance,report_section FROM accounts WHERE id=?",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((old_code, old_type, old_balance, old_section)) = existing {
            let used = account_is_referenced(&tx, &id)?;
            if used && !input.active {
                return Err(AppError::Validation(
                    "Un compte utilisé par la configuration ou le journal ne peut pas être désactivé. Créez un nouveau compte pour les opérations futures sans casser l'historique."
                        .into(),
                ));
            }
            if used
                && (old_code != code
                    || old_type != input.account_type
                    || old_balance != input.normal_balance
                    || old_section != input.report_section)
            {
                return Err(AppError::Validation(
                    "Le code, le type, le solde normal et la rubrique d'un compte utilisé sont figés afin de préserver les rapports historiques."
                        .into(),
                ));
            }
        }
        tx.execute(
            "INSERT INTO accounts(id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,account_type=excluded.account_type,normal_balance=excluded.normal_balance,report_section=excluded.report_section,active=excluded.active,updated_at=excluded.updated_at",
            params![id,code,name,input.account_type,input.normal_balance,input.report_section,input.active as i64,now,now],
        )?;
        let record = one_json(&tx, "SELECT * FROM accounts WHERE id=?", params![id])?;
        append_audit(&tx, "upsert", "account", &id, &record)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn delete_account(&self, id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record = one_json(&tx, "SELECT * FROM accounts WHERE id=?", params![id])?;
        let used = account_is_referenced(&tx, id)?;
        if used {
            return Err(AppError::Validation("Ce compte est utilisé par la configuration ou le journal et ne peut pas être supprimé.".into()));
        }
        tx.execute("DELETE FROM accounts WHERE id=?", params![id])?;
        append_audit(&tx, "delete", "account", id, &record)?;
        tx.commit()?;
        Ok(json!({"deleted":true,"id":id}))
    }

    pub fn get_accounting_settings(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(query_all(
            &connection,
            "SELECT * FROM accounting_settings WHERE id=1",
            [],
        )?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
    }

    pub fn get_accounting_continuity(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        accounting_continuity_report(&connection)
    }

    pub fn install_swiss_accounting_starter(&self) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing_configuration: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM accounting_settings WHERE enabled=1 OR ar_account_id IS NOT NULL OR revenue_account_id IS NOT NULL OR vat_payable_account_id IS NOT NULL OR bank_account_id IS NOT NULL OR expense_account_id IS NOT NULL OR vat_receivable_account_id IS NOT NULL OR wages_expense_account_id IS NOT NULL OR wages_payable_account_id IS NOT NULL OR social_expense_account_id IS NOT NULL OR social_payable_account_id IS NOT NULL OR supplier_payable_account_id IS NOT NULL)",
            [],
            |row| row.get(0),
        )?;
        let existing_journal: bool =
            tx.query_row("SELECT EXISTS(SELECT 1 FROM journal_entries)", [], |row| {
                row.get(0)
            })?;
        if existing_configuration || existing_journal {
            return Err(AppError::Validation(
                "L'assistant de démarrage est réservé à une comptabilité vierge. Une configuration ou des écritures existent déjà : réactivez et vérifiez vos comptes de liaison manuellement afin de ne rien écraser."
                    .into(),
            ));
        }
        let specs = [
            (
                "1100",
                "Créances clients",
                "asset",
                "debit",
                "current_assets",
            ),
            (
                "3200",
                "Produits de facturation",
                "revenue",
                "credit",
                "net_revenue",
            ),
            (
                "2200",
                "TVA due",
                "liability",
                "credit",
                "short_term_liabilities",
            ),
            ("1020", "Banque", "asset", "debit", "current_assets"),
            (
                "6000",
                "Charges d'exploitation",
                "expense",
                "debit",
                "other_operating_expense",
            ),
            ("1170", "TVA préalable", "asset", "debit", "current_assets"),
            (
                "5000",
                "Charges de salaires",
                "expense",
                "debit",
                "personnel_expense",
            ),
            (
                "2000",
                "Salaires dus",
                "liability",
                "credit",
                "short_term_liabilities",
            ),
            (
                "5700",
                "Charges sociales",
                "expense",
                "debit",
                "personnel_expense",
            ),
            (
                "2270",
                "Cotisations sociales dues",
                "liability",
                "credit",
                "short_term_liabilities",
            ),
            (
                "2001",
                "Dettes fournisseurs",
                "liability",
                "credit",
                "short_term_liabilities",
            ),
        ];
        let now = now_iso();
        let mut account_ids = Vec::with_capacity(specs.len());
        for (code, name, account_type, normal_balance, report_section) in specs {
            let existing = tx
                .query_row(
                    "SELECT id,name,account_type,normal_balance,report_section,active FROM accounts WHERE code=?",
                    params![code],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, bool>(5)?,
                        ))
                    },
                )
                .optional()?;
            let id = if let Some((
                id,
                actual_name,
                actual_type,
                actual_balance,
                actual_section,
                actual_active,
            )) = existing
            {
                if actual_type != account_type
                    || actual_balance != normal_balance
                    || actual_section != report_section
                {
                    return Err(AppError::Validation(format!(
                        "Le compte {code} existe avec une classification incompatible. Corrigez-le avec votre fiduciaire ou choisissez manuellement les comptes de liaison."
                    )));
                }
                if actual_name.trim() != name {
                    return Err(AppError::Validation(format!(
                        "Le compte {code} existe déjà sous le nom « {actual_name} ». Zentra refuse de lui attribuer automatiquement le rôle « {name} » : choisissez vos comptes de liaison manuellement."
                    )));
                }
                tx.execute(
                    "UPDATE accounts SET active=1,updated_at=? WHERE id=?",
                    params![now, id],
                )?;
                if !actual_active {
                    let account = one_json(&tx, "SELECT * FROM accounts WHERE id=?", params![id])?;
                    append_audit(&tx, "reactivate", "account", &id, &account)?;
                }
                id
            } else {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO accounts(id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)",
                    params![id,code,name,account_type,normal_balance,report_section,now,now],
                )?;
                let account = one_json(&tx, "SELECT * FROM accounts WHERE id=?", params![id])?;
                append_audit(&tx, "install", "account", &id, &account)?;
                id
            };
            account_ids.push(id);
        }
        tx.execute(
            "INSERT INTO accounting_settings(id,enabled,ar_account_id,revenue_account_id,vat_payable_account_id,bank_account_id,expense_account_id,vat_receivable_account_id,wages_expense_account_id,wages_payable_account_id,social_expense_account_id,social_payable_account_id,supplier_payable_account_id,created_at,updated_at) VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=1,ar_account_id=excluded.ar_account_id,revenue_account_id=excluded.revenue_account_id,vat_payable_account_id=excluded.vat_payable_account_id,bank_account_id=excluded.bank_account_id,expense_account_id=excluded.expense_account_id,vat_receivable_account_id=excluded.vat_receivable_account_id,wages_expense_account_id=excluded.wages_expense_account_id,wages_payable_account_id=excluded.wages_payable_account_id,social_expense_account_id=excluded.social_expense_account_id,social_payable_account_id=excluded.social_payable_account_id,supplier_payable_account_id=excluded.supplier_payable_account_id,updated_at=excluded.updated_at",
            params![
                account_ids[0],account_ids[1],account_ids[2],account_ids[3],account_ids[4],
                account_ids[5],account_ids[6],account_ids[7],account_ids[8],account_ids[9],account_ids[10],now,now
            ],
        )?;
        let synchronization = synchronize_accounting_history(&tx)?;
        let settings = one_json(&tx, "SELECT * FROM accounting_settings WHERE id=1", [])?;
        let result = json!({"settings":settings,"synchronization":synchronization});
        append_audit(&tx, "install", "accounting_starter", "1", &result)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn configure_accounting(&self, input: AccountingSettingsInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (current_enabled, current_supplier_payable): (bool, Option<String>) = tx
            .query_row(
                "SELECT enabled,supplier_payable_account_id FROM accounting_settings WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .unwrap_or((false, None));
        let effective_supplier_payable = input
            .supplier_payable_account_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .or(current_supplier_payable);
        let journal_count: i64 =
            tx.query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0))?;
        if current_enabled && !input.enabled && journal_count > 0 {
            return Err(AppError::Validation(
                "La comptabilité contient déjà des écritures et ne peut plus être désactivée. Vous pouvez modifier les comptes de liaison pour les opérations futures sans altérer l'historique."
                    .into(),
            ));
        }
        let payroll_mappings_required = payroll_accounting_mappings_required(&tx)?;
        let mut ids = vec![
            input.ar_account_id.as_deref(),
            input.revenue_account_id.as_deref(),
            input.vat_payable_account_id.as_deref(),
            input.bank_account_id.as_deref(),
            input.expense_account_id.as_deref(),
            input.vat_receivable_account_id.as_deref(),
            effective_supplier_payable.as_deref(),
        ];
        if payroll_mappings_required {
            ids.extend([
                input.wages_expense_account_id.as_deref(),
                input.wages_payable_account_id.as_deref(),
                input.social_expense_account_id.as_deref(),
                input.social_payable_account_id.as_deref(),
            ]);
        }
        if input.enabled
            && ids.iter().any(|id| match id {
                None => true,
                Some(value) => value.trim().is_empty(),
            })
        {
            return Err(AppError::Validation(if payroll_mappings_required {
                "Les onze comptes de liaison doivent être explicitement sélectionnés avant d'activer la comptabilité.".into()
            } else {
                "Les sept comptes de liaison hors paie doivent être explicitement sélectionnés avant d'activer la comptabilité.".into()
            }));
        }
        for id in ids.iter().flatten() {
            let active: bool = tx
                .query_row("SELECT active FROM accounts WHERE id=?", params![id], |r| {
                    r.get::<_, i64>(0)
                })
                .optional()?
                .map(|v| v == 1)
                .ok_or_else(|| AppError::NotFound(format!("accounts/{id}")))?;
            if input.enabled && !active {
                return Err(AppError::Validation(format!("Le compte {id} est inactif.")));
            }
        }
        if input.enabled {
            let mut typed_mappings = vec![
                (input.ar_account_id.as_deref(), "asset", "ar_account_id"),
                (
                    input.revenue_account_id.as_deref(),
                    "revenue",
                    "revenue_account_id",
                ),
                (
                    input.vat_payable_account_id.as_deref(),
                    "liability",
                    "vat_payable_account_id",
                ),
                (input.bank_account_id.as_deref(), "asset", "bank_account_id"),
                (
                    input.expense_account_id.as_deref(),
                    "expense",
                    "expense_account_id",
                ),
                (
                    input.vat_receivable_account_id.as_deref(),
                    "asset",
                    "vat_receivable_account_id",
                ),
                (
                    effective_supplier_payable.as_deref(),
                    "liability",
                    "supplier_payable_account_id",
                ),
            ];
            if payroll_mappings_required {
                typed_mappings.extend([
                    (
                        input.wages_expense_account_id.as_deref(),
                        "expense",
                        "wages_expense_account_id",
                    ),
                    (
                        input.wages_payable_account_id.as_deref(),
                        "liability",
                        "wages_payable_account_id",
                    ),
                    (
                        input.social_expense_account_id.as_deref(),
                        "expense",
                        "social_expense_account_id",
                    ),
                    (
                        input.social_payable_account_id.as_deref(),
                        "liability",
                        "social_payable_account_id",
                    ),
                ]);
            }
            for (id, expected, label) in typed_mappings {
                let Some(id) = id.filter(|value| !value.trim().is_empty()) else {
                    return Err(AppError::Validation(format!(
                        "{label} doit être sélectionné."
                    )));
                };
                let actual: String = tx.query_row(
                    "SELECT account_type FROM accounts WHERE id=?",
                    params![id],
                    |r| r.get(0),
                )?;
                if actual != expected {
                    return Err(AppError::Validation(format!(
                        "{label} doit référencer un compte de type {expected}."
                    )));
                }
            }
            validate_core_mapping_role_separation(
                input.ar_account_id.as_deref(),
                input.bank_account_id.as_deref(),
                input.vat_receivable_account_id.as_deref(),
            )?;
        }
        let now = now_iso();
        tx.execute(
            "INSERT INTO accounting_settings(id,enabled,ar_account_id,revenue_account_id,vat_payable_account_id,bank_account_id,expense_account_id,vat_receivable_account_id,wages_expense_account_id,wages_payable_account_id,social_expense_account_id,social_payable_account_id,supplier_payable_account_id,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,ar_account_id=excluded.ar_account_id,revenue_account_id=excluded.revenue_account_id,vat_payable_account_id=excluded.vat_payable_account_id,bank_account_id=excluded.bank_account_id,expense_account_id=excluded.expense_account_id,vat_receivable_account_id=excluded.vat_receivable_account_id,wages_expense_account_id=excluded.wages_expense_account_id,wages_payable_account_id=excluded.wages_payable_account_id,social_expense_account_id=excluded.social_expense_account_id,social_payable_account_id=excluded.social_payable_account_id,supplier_payable_account_id=excluded.supplier_payable_account_id,updated_at=excluded.updated_at",
            params![input.enabled as i64,input.ar_account_id,input.revenue_account_id,input.vat_payable_account_id,input.bank_account_id,input.expense_account_id,input.vat_receivable_account_id,input.wages_expense_account_id,input.wages_payable_account_id,input.social_expense_account_id,input.social_payable_account_id,effective_supplier_payable,now,now],
        )?;
        let record = one_json(&tx, "SELECT * FROM accounting_settings WHERE id=1", [])?;
        let synchronization = if input.enabled {
            synchronize_accounting_history(&tx)?
        } else {
            json!({
                "created_total": 0,
                "created_invoices": 0,
                "created_payments": 0,
                "created_expenses": 0,
                "created_payslips": 0,
                "created_payslip_payments": 0,
                "remaining": accounting_continuity_report(&tx)?,
            })
        };
        let result = json!({"settings":record,"synchronization":synchronization});
        append_audit(&tx, "configure", "accounting_settings", "1", &result)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn post_manual_journal_entry(&self, input: ManualJournalInput) -> AppResult<Value> {
        validate_date(&input.entry_date, "entry_date")?;
        let description = required(&input.description, "description", 500)?;
        let currency = currency(&input.currency)?;
        let lines = input
            .lines
            .into_iter()
            .map(|line| EntryLine {
                account_id: line.account_id,
                debit_cents: line.debit_cents,
                credit_cents: line.credit_cents,
                currency: currency.clone(),
                memo: line.memo,
                project_id: line.project_id,
                client_id: line.client_id,
                employee_id: line.employee_id,
            })
            .collect::<Vec<_>>();
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let source_id = Uuid::new_v4().to_string();
        let result = post_entry(
            &tx,
            &input.entry_date,
            &description,
            "manual",
            &source_id,
            "posted",
            lines,
        )?;
        append_audit(
            &tx,
            "post",
            "journal_entry",
            result["id"].as_str().unwrap_or(""),
            &result,
        )?;
        tx.commit()?;
        Ok(result)
    }

    pub fn reverse_journal_entry(
        &self,
        id: &str,
        entry_date: &str,
        description: Option<String>,
    ) -> AppResult<Value> {
        validate_date(entry_date, "entry_date")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let original = one_json(&tx, "SELECT * FROM journal_entries WHERE id=?", params![id])?;
        if matches!(
            original["source_type"].as_str(),
            Some("supplier_invoice" | "supplier_payment")
        ) {
            return Err(AppError::Validation(
                "Une écriture fournisseur ne peut pas être extournée isolément. Utilisez le futur flux d’avoir ou de remboursement afin que le document, la dette et le journal restent cohérents."
                    .into(),
            ));
        }
        let conflicting_reversal: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM journal_entries WHERE reversal_of=? AND NOT(source_type='journal_reversal' AND source_id=? AND source_event='reverse'))",
            params![id, id],
            |row| row.get(0),
        )?;
        if conflicting_reversal {
            return Err(AppError::Validation(
                "Cette écriture a déjà été extournée. Pour rétablir son effet, extournez l'écriture d'extourne au lieu de créer une seconde compensation."
                    .into(),
            ));
        }
        if entry_date < original["entry_date"].as_str().unwrap_or("") {
            return Err(AppError::Validation(
                "L'extourne ne peut pas précéder l'écriture originale.".into(),
            ));
        }
        let rows = query_all(
            &tx,
            "SELECT * FROM journal_lines WHERE journal_entry_id=? ORDER BY rowid",
            params![id],
        )?;
        let lines = rows
            .into_iter()
            .map(|row| EntryLine {
                account_id: row["account_id"].as_str().unwrap_or("").into(),
                debit_cents: row["credit_cents"].as_i64().unwrap_or(0),
                credit_cents: row["debit_cents"].as_i64().unwrap_or(0),
                currency: row["currency"].as_str().unwrap_or("CHF").into(),
                memo: Some(format!(
                    "Extourne {}",
                    original["number"].as_str().unwrap_or("")
                )),
                project_id: row["project_id"].as_str().map(Into::into),
                client_id: row["client_id"].as_str().map(Into::into),
                employee_id: row["employee_id"].as_str().map(Into::into),
            })
            .collect();
        let label = description
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| format!("Extourne {}", original["number"].as_str().unwrap_or("")));
        let result = post_entry_with_reversal(
            &tx,
            entry_date,
            &label,
            "journal_reversal",
            id,
            "reverse",
            lines,
            Some(id),
        )?;
        append_audit(&tx, "reverse", "journal_entry", id, &result)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn get_journal(&self, filter: PeriodFilter) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let (where_sql, values) = period_clause(&filter, "je.entry_date")?;
        let entries = query_all(
            &connection,
            &format!("SELECT je.*,EXISTS(SELECT 1 FROM journal_entries reversal WHERE reversal.reversal_of=je.id) AS has_reversal FROM journal_entries je {where_sql} ORDER BY je.entry_date,je.number"),
            params_from_iter(values),
        )?;
        let lines = query_all(&connection,&format!("SELECT jl.*,a.code AS account_code,a.name AS account_name,je.number AS entry_number,je.entry_date FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id JOIN journal_entries je ON je.id=jl.journal_entry_id {} ORDER BY je.entry_date,je.number,jl.rowid", period_join_clause(&filter,"je.entry_date")?.0),params_from_iter(period_join_clause(&filter,"je.entry_date")?.1))?;
        Ok(json!({"entries":entries,"lines":lines}))
    }

    pub fn get_ledger(&self, input: LedgerInput) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let account = query_all(
            &connection,
            "SELECT * FROM accounts WHERE id=?",
            params![input.account_id],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound(format!("accounts/{}", input.account_id)))?;
        let filter = PeriodFilter {
            date_from: input.date_from,
            date_to: input.date_to,
        };
        let (extra, mut values) = period_and_clause(&filter, "je.entry_date")?;
        values.insert(0, SqlValue::Text(input.account_id));
        let lines=query_all(&connection,&format!("SELECT jl.*,je.number AS entry_number,je.entry_date,je.description FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=? {extra} ORDER BY je.entry_date,je.number,jl.rowid"),params_from_iter(values))?;
        let debit: i64 = lines.iter().filter_map(|v| v["debit_cents"].as_i64()).sum();
        let credit: i64 = lines
            .iter()
            .filter_map(|v| v["credit_cents"].as_i64())
            .sum();
        Ok(
            json!({"account":account,"lines":lines,"debit_cents":debit,"credit_cents":credit,"net_debit_cents":debit-credit}),
        )
    }

    pub fn get_trial_balance(&self, filter: PeriodFilter) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let (extra, values) = period_join_clause(&filter, "je.entry_date")?;
        let rows=query_all(&connection,&format!("SELECT a.id,a.code,a.name,a.account_type,a.normal_balance,a.report_section,COALESCE(SUM(jl.debit_cents),0) AS debit_cents,COALESCE(SUM(jl.credit_cents),0) AS credit_cents,MAX(COALESCE(SUM(jl.debit_cents),0)-COALESCE(SUM(jl.credit_cents),0),0) AS debit_balance_cents,MAX(COALESCE(SUM(jl.credit_cents),0)-COALESCE(SUM(jl.debit_cents),0),0) AS credit_balance_cents FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id {extra} GROUP BY a.id ORDER BY a.code"),params_from_iter(values))?;
        let debit: i64 = rows.iter().filter_map(|v| v["debit_cents"].as_i64()).sum();
        let credit: i64 = rows.iter().filter_map(|v| v["credit_cents"].as_i64()).sum();
        Ok(json!({"rows":rows,"debit_cents":debit,"credit_cents":credit,"balanced":debit==credit}))
    }

    pub fn get_income_statement(&self, filter: PeriodFilter) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        crate::accounting_closure::income_statement_report(&connection, &filter)
    }

    pub fn get_balance_sheet(&self, filter: PeriodFilter) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        crate::accounting_closure::balance_sheet_report(&connection, &filter)
    }

    pub fn get_accounting_dashboard(&self, filter: PeriodFilter) -> AppResult<Value> {
        let settings = self.get_accounting_settings()?;
        let trial = self.get_trial_balance(filter.clone())?;
        let income = self.get_income_statement(filter)?;
        let connection = self.connect()?;
        let entry_count: i64 =
            connection.query_row("SELECT COUNT(*) FROM journal_entries", [], |r| r.get(0))?;
        Ok(
            json!({"settings":settings,"entry_count":entry_count,"trial_balance":trial,"income_statement":income}),
        )
    }
}

fn accounting_continuity_report(connection: &Connection) -> AppResult<Value> {
    let enabled: bool = connection
        .query_row(
            "SELECT enabled FROM accounting_settings WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(false);
    let journal_entry_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0))?;
    let missing_invoices: i64 = connection.query_row(
        "SELECT COUNT(*) FROM invoices i WHERE i.number IS NOT NULL AND i.status<>'annulee' AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='invoice' AND je.source_id=i.id AND je.source_event='issue') AND NOT EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND i.issue_date BETWEEN ap.date_from AND ap.date_to)",
        [],
        |row| row.get(0),
    )?;
    let missing_payments: i64 = connection.query_row(
        "SELECT COUNT(*) FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status<>'annulee' AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='payment' AND je.source_id=p.id) AND NOT EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND p.date BETWEEN ap.date_from AND ap.date_to)",
        [],
        |row| row.get(0),
    )?;
    let missing_expenses: i64 = connection.query_row(
        "SELECT COUNT(*) FROM expenses e WHERE e.payment_status='paid' AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='expense' AND je.source_id=e.id) AND NOT EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND COALESCE(e.paid_at,e.date) BETWEEN ap.date_from AND ap.date_to)",
        [],
        |row| row.get(0),
    )?;
    let missing_supplier_invoices: i64 = connection.query_row(
        "SELECT COUNT(*) FROM supplier_invoices invoice WHERE invoice.status='validated' AND NOT EXISTS(SELECT 1 FROM journal_entries entry WHERE entry.source_type='supplier_invoice' AND entry.source_id=invoice.id AND entry.source_event='validate') AND NOT EXISTS(SELECT 1 FROM accounting_periods period WHERE period.status='closed' AND invoice.document_date BETWEEN period.date_from AND period.date_to)",
        [],
        |row| row.get(0),
    )?;
    let missing_supplier_payments: i64 = connection.query_row(
        "SELECT COUNT(*) FROM supplier_payments payment WHERE NOT EXISTS(SELECT 1 FROM journal_entries entry WHERE entry.source_type='supplier_payment' AND entry.source_id=payment.id AND entry.source_event='invoice:'||payment.supplier_invoice_id) AND NOT EXISTS(SELECT 1 FROM accounting_periods period WHERE period.status='closed' AND payment.date BETWEEN period.date_from AND period.date_to)",
        [],
        |row| row.get(0),
    )?;
    let missing_payslips: i64 = connection.query_row(
        "SELECT COUNT(*) FROM payslips p WHERE p.status IN('comptabilise','paye') AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='payslip' AND je.source_id=p.id AND je.source_event='post') AND NOT EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND p.period||'-01' BETWEEN ap.date_from AND ap.date_to)",
        [],
        |row| row.get(0),
    )?;
    let missing_payslip_payments: i64 = connection.query_row(
        "SELECT COUNT(*) FROM payslips p WHERE p.status='paye' AND p.payment_date IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='payslip' AND je.source_id=p.id AND je.source_event='payment') AND NOT EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND p.payment_date BETWEEN ap.date_from AND ap.date_to)",
        [],
        |row| row.get(0),
    )?;
    let undated_payslip_payments: i64 = connection.query_row(
        "SELECT COUNT(*) FROM payslips WHERE status='paye' AND payment_date IS NULL",
        [],
        |row| row.get(0),
    )?;
    let payslip_payment_links_missing: i64 = connection.query_row(
        "SELECT COUNT(*) FROM payslips p WHERE p.status='paye' AND p.payment_date IS NOT NULL AND p.payment_journal_entry_id IS NULL AND EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='payslip' AND je.source_id=p.id AND je.source_event='payment')",
        [],
        |row| row.get(0),
    )?;
    let total_missing = missing_invoices
        + missing_payments
        + missing_expenses
        + missing_supplier_invoices
        + missing_supplier_payments
        + missing_payslips
        + missing_payslip_payments;
    let closed_history_requires_opening = closed_history_unposted_count(connection)?;
    let skipped_cancelled_invoices: i64 = connection.query_row(
        "SELECT COUNT(*) FROM invoices i WHERE i.number IS NOT NULL AND i.status='annulee' AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='invoice' AND je.source_id=i.id AND je.source_event='issue')",
        [],
        |row| row.get(0),
    )?;
    let cancelled_invoice_payments: i64 = connection.query_row(
        "SELECT COUNT(*) FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status='annulee'",
        [],
        |row| row.get(0),
    )?;
    let payroll_mappings_required = payroll_accounting_mappings_required(connection)?;
    let mapping_ready_sql = if payroll_mappings_required {
        "SELECT EXISTS(SELECT 1 FROM accounting_settings s
            JOIN accounts ar ON ar.id=s.ar_account_id AND ar.active=1 AND ar.account_type='asset'
            JOIN accounts rev ON rev.id=s.revenue_account_id AND rev.active=1 AND rev.account_type='revenue'
            JOIN accounts vatp ON vatp.id=s.vat_payable_account_id AND vatp.active=1 AND vatp.account_type='liability'
            JOIN accounts bank ON bank.id=s.bank_account_id AND bank.active=1 AND bank.account_type='asset'
            JOIN accounts expense ON expense.id=s.expense_account_id AND expense.active=1 AND expense.account_type='expense'
            JOIN accounts vatr ON vatr.id=s.vat_receivable_account_id AND vatr.active=1 AND vatr.account_type='asset'
            JOIN accounts wages_expense ON wages_expense.id=s.wages_expense_account_id AND wages_expense.active=1 AND wages_expense.account_type='expense'
            JOIN accounts wages_payable ON wages_payable.id=s.wages_payable_account_id AND wages_payable.active=1 AND wages_payable.account_type='liability'
            JOIN accounts social_expense ON social_expense.id=s.social_expense_account_id AND social_expense.active=1 AND social_expense.account_type='expense'
            JOIN accounts social_payable ON social_payable.id=s.social_payable_account_id AND social_payable.active=1 AND social_payable.account_type='liability'
            JOIN accounts supplier_payable ON supplier_payable.id=s.supplier_payable_account_id AND supplier_payable.active=1 AND supplier_payable.account_type='liability'
            WHERE s.id=1 AND s.enabled=1
              AND s.bank_account_id<>s.ar_account_id
              AND s.bank_account_id<>s.vat_receivable_account_id
              AND s.ar_account_id<>s.vat_receivable_account_id)"
    } else {
        "SELECT EXISTS(SELECT 1 FROM accounting_settings s
            JOIN accounts ar ON ar.id=s.ar_account_id AND ar.active=1 AND ar.account_type='asset'
            JOIN accounts rev ON rev.id=s.revenue_account_id AND rev.active=1 AND rev.account_type='revenue'
            JOIN accounts vatp ON vatp.id=s.vat_payable_account_id AND vatp.active=1 AND vatp.account_type='liability'
            JOIN accounts bank ON bank.id=s.bank_account_id AND bank.active=1 AND bank.account_type='asset'
            JOIN accounts expense ON expense.id=s.expense_account_id AND expense.active=1 AND expense.account_type='expense'
            JOIN accounts vatr ON vatr.id=s.vat_receivable_account_id AND vatr.active=1 AND vatr.account_type='asset'
            JOIN accounts supplier_payable ON supplier_payable.id=s.supplier_payable_account_id AND supplier_payable.active=1 AND supplier_payable.account_type='liability'
            WHERE s.id=1 AND s.enabled=1
              AND s.bank_account_id<>s.ar_account_id
              AND s.bank_account_id<>s.vat_receivable_account_id
              AND s.ar_account_id<>s.vat_receivable_account_id)"
    };
    let mapping_ready: bool = connection.query_row(mapping_ready_sql, [], |row| row.get(0))?;
    let configured_mappings: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM accounting_settings WHERE enabled=1 OR ar_account_id IS NOT NULL OR revenue_account_id IS NOT NULL OR vat_payable_account_id IS NOT NULL OR bank_account_id IS NOT NULL OR expense_account_id IS NOT NULL OR vat_receivable_account_id IS NOT NULL OR wages_expense_account_id IS NOT NULL OR wages_payable_account_id IS NOT NULL OR social_expense_account_id IS NOT NULL OR social_payable_account_id IS NOT NULL OR supplier_payable_account_id IS NOT NULL)",
        [],
        |row| row.get(0),
    )?;
    let reversed_sources: i64 = connection.query_row(
        "WITH RECURSIVE chain(root_id,source_type,source_id,id,depth) AS (
            SELECT id,source_type,source_id,id,0 FROM journal_entries WHERE source_type IN('invoice','payment','expense','payslip','supplier_invoice','supplier_payment')
            UNION ALL
            SELECT chain.root_id,chain.source_type,chain.source_id,je.id,chain.depth+1 FROM chain JOIN journal_entries je ON je.reversal_of=chain.id
        ), roots AS (SELECT root_id,source_type,source_id,MAX(depth) AS max_depth FROM chain GROUP BY root_id,source_type,source_id)
        SELECT COUNT(*) FROM roots LEFT JOIN invoices i ON roots.source_type='invoice' AND i.id=roots.source_id WHERE max_depth%2=1 AND NOT(roots.source_type='invoice' AND i.status='annulee')",
        [],
        |row| row.get(0),
    )?;
    let cancelled_active_postings: i64 = connection.query_row(
        "WITH RECURSIVE chain(root_id,source_type,source_id,id,depth) AS (
            SELECT id,source_type,source_id,id,0 FROM journal_entries WHERE source_type='invoice'
            UNION ALL
            SELECT chain.root_id,chain.source_type,chain.source_id,je.id,chain.depth+1 FROM chain JOIN journal_entries je ON je.reversal_of=chain.id
        ), roots AS (SELECT root_id,source_id,MAX(depth) AS max_depth FROM chain GROUP BY root_id,source_id)
        SELECT COUNT(*) FROM roots JOIN invoices i ON i.id=roots.source_id WHERE i.status='annulee' AND max_depth%2=0",
        [],
        |row| row.get(0),
    )?;
    let semantic_posting_mismatches =
        semantic_posting_mismatches_in_range(connection, "0001-01-01", "9999-12-31")?;
    let total_anomalies = total_missing
        + closed_history_requires_opening
        + cancelled_invoice_payments
        + reversed_sources
        + cancelled_active_postings
        + undated_payslip_payments
        + payslip_payment_links_missing
        + semantic_posting_mismatches
        + i64::from(enabled && !mapping_ready);
    Ok(json!({
        "enabled": enabled,
        "mapping_ready": mapping_ready,
        "starter_available": !configured_mappings && journal_entry_count == 0,
        "journal_entry_count": journal_entry_count,
        "missing_invoices": missing_invoices,
        "missing_payments": missing_payments,
        "missing_expenses": missing_expenses,
        "missing_supplier_invoices":missing_supplier_invoices,
        "missing_supplier_payments":missing_supplier_payments,
        "missing_payslips": missing_payslips,
        "missing_payslip_payments": missing_payslip_payments,
        "undated_payslip_payments": undated_payslip_payments,
        "payslip_payment_links_missing": payslip_payment_links_missing,
        "total_missing": total_missing,
        "closed_history_requires_opening": closed_history_requires_opening,
        "skipped_cancelled_invoices": skipped_cancelled_invoices,
        "cancelled_invoice_payments": cancelled_invoice_payments,
        "reversed_sources": reversed_sources,
        "cancelled_active_postings": cancelled_active_postings,
        "semantic_posting_mismatches": semantic_posting_mismatches,
        "total_anomalies": total_anomalies,
    }))
}

#[derive(Debug)]
struct HistoricalEvent {
    kind: String,
    id: String,
    original_date: Option<String>,
    reference: Option<String>,
}

fn closed_history_unposted_count(connection: &Connection) -> AppResult<i64> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM (
            SELECT 'invoice:'||i.id AS source FROM invoices i WHERE i.number IS NOT NULL AND i.status<>'annulee' AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='invoice' AND je.source_id=i.id AND je.source_event='issue') AND EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND i.issue_date BETWEEN ap.date_from AND ap.date_to)
            UNION ALL
            SELECT 'expense:'||e.id FROM expenses e WHERE e.payment_status='paid' AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='expense' AND je.source_id=e.id) AND EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND COALESCE(e.paid_at,e.date) BETWEEN ap.date_from AND ap.date_to)
            UNION ALL
            SELECT 'supplier_invoice:'||invoice.id FROM supplier_invoices invoice WHERE invoice.status='validated' AND NOT EXISTS(SELECT 1 FROM journal_entries entry WHERE entry.source_type='supplier_invoice' AND entry.source_id=invoice.id AND entry.source_event='validate') AND EXISTS(SELECT 1 FROM accounting_periods period WHERE period.status='closed' AND invoice.document_date BETWEEN period.date_from AND period.date_to)
            UNION ALL
            SELECT 'supplier_payment:'||payment.id FROM supplier_payments payment WHERE NOT EXISTS(SELECT 1 FROM journal_entries entry WHERE entry.source_type='supplier_payment' AND entry.source_id=payment.id AND entry.source_event='invoice:'||payment.supplier_invoice_id) AND EXISTS(SELECT 1 FROM accounting_periods period WHERE period.status='closed' AND payment.date BETWEEN period.date_from AND period.date_to)
            UNION ALL
            SELECT 'payslip:'||p.id FROM payslips p WHERE p.status IN('comptabilise','paye') AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='payslip' AND je.source_id=p.id AND je.source_event='post') AND EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND p.period||'-01' BETWEEN ap.date_from AND ap.date_to)
            UNION ALL
            SELECT 'payment:'||p.id FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status<>'annulee' AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='payment' AND je.source_id=p.id) AND EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND p.date BETWEEN ap.date_from AND ap.date_to)
            UNION ALL
            SELECT 'payslip_payment:'||p.id FROM payslips p WHERE p.status='paye' AND p.payment_date IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='payslip' AND je.source_id=p.id AND je.source_event='payment') AND EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND p.payment_date BETWEEN ap.date_from AND ap.date_to)
        )",
        [],
        |row| row.get(0),
    )?)
}

fn synchronize_accounting_history(tx: &Transaction<'_>) -> AppResult<Value> {
    if accounting_map(tx)?.is_none() {
        return accounting_continuity_report(tx);
    }
    let events = {
        let mut statement = tx.prepare(
            "SELECT kind,id,original_date,reference FROM (
                SELECT 'invoice' AS kind,i.id AS id,i.issue_date AS original_date,NULL AS reference,i.issue_date AS sort_date,i.created_at AS created_at,10 AS priority FROM invoices i WHERE i.number IS NOT NULL AND i.status<>'annulee' AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='invoice' AND je.source_id=i.id AND je.source_event='issue') AND NOT EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND i.issue_date BETWEEN ap.date_from AND ap.date_to)
                UNION ALL
                SELECT 'expense',e.id,COALESCE(e.paid_at,e.date),NULL,COALESCE(e.paid_at,e.date),e.created_at,20 FROM expenses e WHERE e.payment_status='paid' AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='expense' AND je.source_id=e.id) AND NOT EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND COALESCE(e.paid_at,e.date) BETWEEN ap.date_from AND ap.date_to)
                UNION ALL
                SELECT 'payslip',p.id,p.period||'-01',NULL,p.period||'-01',p.created_at,30 FROM payslips p WHERE p.status IN('comptabilise','paye') AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='payslip' AND je.source_id=p.id AND je.source_event='post') AND NOT EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND p.period||'-01' BETWEEN ap.date_from AND ap.date_to)
                UNION ALL
                SELECT 'payment',p.id,p.date,NULL,p.date,p.created_at,40 FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status<>'annulee' AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='payment' AND je.source_id=p.id) AND NOT EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND p.date BETWEEN ap.date_from AND ap.date_to)
                UNION ALL
                SELECT 'payslip_payment',p.id,p.payment_date,p.payment_reference,p.payment_date,p.updated_at,50 FROM payslips p WHERE p.status='paye' AND p.payment_date IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='payslip' AND je.source_id=p.id AND je.source_event='payment') AND NOT EXISTS(SELECT 1 FROM accounting_periods ap WHERE ap.status='closed' AND p.payment_date BETWEEN ap.date_from AND ap.date_to)
            ) ORDER BY sort_date,priority,created_at,id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(HistoricalEvent {
                    kind: row.get(0)?,
                    id: row.get(1)?,
                    original_date: row.get(2)?,
                    reference: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let skipped_closed_history = closed_history_unposted_count(tx)?;
    let mut created_invoices = 0_usize;
    let mut created_payments = 0_usize;
    let mut created_expenses = 0_usize;
    let mut created_payslips = 0_usize;
    let mut created_payslip_payments = 0_usize;
    for event in &events {
        let original_date = event.original_date.as_deref().ok_or_else(|| {
            AppError::Validation(format!(
                "L'événement historique {} / {} n'a pas de date comptable; corrigez la donnée avant la synchronisation.",
                event.kind, event.id
            ))
        })?;
        let journal = match event.kind.as_str() {
            "invoice" => {
                let journal = post_invoice_if_enabled(tx, &event.id)?.ok_or_else(|| {
                    AppError::Validation("La liaison comptable des factures est inactive.".into())
                })?;
                created_invoices += 1;
                journal
            }
            "expense" => {
                let journal = post_expense_if_enabled(tx, &event.id)?.ok_or_else(|| {
                    AppError::Validation("La liaison comptable des achats est inactive.".into())
                })?;
                created_expenses += 1;
                journal
            }
            "payslip" => {
                let journal =
                    post_payslip_if_enabled(tx, &event.id, original_date)?.ok_or_else(|| {
                        AppError::Validation(
                            "La liaison comptable des salaires est inactive.".into(),
                        )
                    })?;
                created_payslips += 1;
                journal
            }
            "payment" => {
                let journal = post_payment_if_enabled(tx, &event.id)?.ok_or_else(|| {
                    AppError::Validation(
                        "La liaison comptable des encaissements est inactive.".into(),
                    )
                })?;
                created_payments += 1;
                journal
            }
            "payslip_payment" => {
                let journal = post_payslip_payment_if_enabled(
                    tx,
                    &event.id,
                    original_date,
                    event.reference.as_deref(),
                )?
                .ok_or_else(|| {
                    AppError::Validation(
                        "La liaison comptable des paiements de salaires est inactive.".into(),
                    )
                })?;
                let journal_id = journal["id"].as_str().ok_or_else(|| {
                    AppError::Validation("L'écriture de paiement historique est invalide.".into())
                })?;
                tx.execute(
                    "UPDATE payslips SET payment_journal_entry_id=?,updated_at=? WHERE id=? AND payment_journal_entry_id IS NULL",
                    params![journal_id, now_iso(), event.id],
                )?;
                created_payslip_payments += 1;
                journal
            }
            _ => unreachable!("historical accounting query controls event kinds"),
        };
        append_audit(
            tx,
            "backfill",
            "journal_entry",
            journal["id"].as_str().unwrap_or(""),
            &json!({"source_type":event.kind,"source_id":event.id,"journal":journal}),
        )?;
    }
    let remaining = accounting_continuity_report(tx)?;
    if remaining["total_missing"].as_i64().unwrap_or(i64::MAX) != 0 {
        return Err(AppError::Validation(
            "La synchronisation comptable n'a pas pu couvrir tous les événements des périodes ouvertes; aucune modification n'a été enregistrée."
                .into(),
        ));
    }
    let created_total = events.len();
    Ok(json!({
        "created_total": created_total,
        "created_invoices": created_invoices,
        "created_payments": created_payments,
        "created_expenses": created_expenses,
        "created_payslips": created_payslips,
        "created_payslip_payments": created_payslip_payments,
        "skipped_closed_history": skipped_closed_history,
        "requires_opening_balance_review": skipped_closed_history > 0,
        "remaining": remaining,
    }))
}

pub(crate) fn post_invoice_if_enabled(
    tx: &Transaction<'_>,
    invoice_id: &str,
) -> AppResult<Option<Value>> {
    post_invoice(tx, invoice_id)
}

fn posted_invoice_account(
    tx: &Transaction<'_>,
    invoice_id: &str,
    memo: &str,
    expected_type: &str,
) -> AppResult<Option<String>> {
    let source_entry: Option<String> = tx
        .query_row(
            "SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=? AND source_event='issue'",
            params![invoice_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(source_entry) = source_entry else {
        return Ok(None);
    };
    let reversal_depth: i64 = tx.query_row(
        "WITH RECURSIVE chain(id,depth) AS (
            SELECT ?,0
            UNION ALL
            SELECT je.id,chain.depth+1 FROM chain JOIN journal_entries je ON je.reversal_of=chain.id
        ) SELECT MAX(depth) FROM chain",
        params![source_entry],
        |row| row.get(0),
    )?;
    if reversal_depth % 2 == 1 {
        return Err(AppError::Validation(format!(
            "L'écriture d'émission de la facture {invoice_id} est extournée. Rétablissez ou corrigez d'abord l'opération métier avant tout paiement ou avoir."
        )));
    }
    let mut statement = tx.prepare(
        "SELECT DISTINCT jl.account_id FROM journal_lines jl WHERE jl.journal_entry_id=? AND jl.memo=? ORDER BY jl.account_id",
    )?;
    let accounts = statement
        .query_map(params![source_entry, memo], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    match accounts.as_slice() {
        [] => Ok(None),
        [account_id] => {
            validate_account_type(
                tx,
                account_id,
                &[expected_type],
                "Le compte figé de la facture d'origine",
            )?;
            Ok(Some(account_id.clone()))
        }
        _ => Err(AppError::Validation(format!(
            "La facture {invoice_id} contient plusieurs comptes figés pour « {memo} »; l'opération est bloquée."
        ))),
    }
}

fn post_invoice(tx: &Transaction<'_>, invoice_id: &str) -> AppResult<Option<Value>> {
    let Some(map) = accounting_map(tx)? else {
        return Ok(None);
    };
    let (kind, total, net, vat, currency, project, client, number, original_invoice_id): InvoicePostingRow = tx.query_row("SELECT type,total_cents,total_cents-vat_cents,vat_cents,currency,project_id,client_id,number,original_invoice_id FROM invoices WHERE id=?",params![invoice_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?)))?;
    if number.is_none() {
        return Err(AppError::Validation(
            "Une facture doit être numérotée avant sa comptabilisation.".into(),
        ));
    }
    if total == 0 {
        return Err(AppError::Validation(
            "Une facture à montant nul ne peut pas être émise.".into(),
        ));
    }
    let mut lines = Vec::new();
    let reversal_ar = if kind == "avoir" {
        match original_invoice_id.as_deref() {
            Some(original) => posted_invoice_account(tx, original, "Créance client", "asset")?,
            None => None,
        }
    } else {
        None
    };
    let reversal_revenue = if kind == "avoir" {
        match original_invoice_id.as_deref() {
            Some(original) => posted_invoice_account(tx, original, "Produit facturé", "revenue")?,
            None => None,
        }
    } else {
        None
    };
    let reversal_vat = if kind == "avoir" {
        match original_invoice_id.as_deref() {
            Some(original) => posted_invoice_account(tx, original, "TVA due", "liability")?,
            None => None,
        }
    } else {
        None
    };
    if kind == "avoir" {
        if total >= 0 || net > 0 || vat > 0 {
            return Err(AppError::Validation(
                "Un avoir émis doit avoir des montants négatifs.".into(),
            ));
        }
        push_line(
            &mut lines,
            reversal_revenue.as_deref().unwrap_or(&map.revenue),
            -net,
            0,
            &currency,
            project.clone(),
            client.clone(),
            None,
            "Extourne produit",
        );
        if vat != 0 {
            push_line(
                &mut lines,
                reversal_vat.as_deref().unwrap_or(&map.vat_payable),
                -vat,
                0,
                &currency,
                project.clone(),
                client.clone(),
                None,
                "Extourne TVA",
            );
        }
        push_line(
            &mut lines,
            reversal_ar.as_deref().unwrap_or(&map.ar),
            0,
            -total,
            &currency,
            project,
            client,
            None,
            "Réduction créance client",
        );
    } else {
        if total <= 0 || net < 0 || vat < 0 {
            return Err(AppError::Validation(
                "Une facture doit avoir des montants positifs.".into(),
            ));
        }
        push_line(
            &mut lines,
            &map.ar,
            total,
            0,
            &currency,
            project.clone(),
            client.clone(),
            None,
            "Créance client",
        );
        if net != 0 {
            push_line(
                &mut lines,
                &map.revenue,
                0,
                net,
                &currency,
                project.clone(),
                client.clone(),
                None,
                "Produit facturé",
            );
        }
        if vat != 0 {
            push_line(
                &mut lines,
                &map.vat_payable,
                0,
                vat,
                &currency,
                project,
                client,
                None,
                "TVA due",
            );
        }
    }
    let date: String = tx.query_row(
        "SELECT issue_date FROM invoices WHERE id=?",
        params![invoice_id],
        |r| r.get(0),
    )?;
    Ok(Some(post_entry(
        tx,
        &date,
        &format!("Émission {}", number.unwrap_or_default()),
        "invoice",
        invoice_id,
        "issue",
        lines,
    )?))
}

pub(crate) fn post_payment_if_enabled(
    tx: &Transaction<'_>,
    payment_id: &str,
) -> AppResult<Option<Value>> {
    let Some(map) = accounting_map(tx)? else {
        return Ok(None);
    };
    let (invoice_id,date,amount,currency,project,client):(String,String,i64,String,Option<String>,Option<String>)=tx.query_row("SELECT p.invoice_id,p.date,p.amount_cents,i.currency,i.project_id,i.client_id FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.id=?",params![payment_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    let ar_account = posted_invoice_account(tx, &invoice_id, "Créance client", "asset")?
        .unwrap_or_else(|| map.ar.clone());
    let mut lines = Vec::new();
    push_line(
        &mut lines,
        &map.bank,
        amount,
        0,
        &currency,
        project.clone(),
        client.clone(),
        None,
        "Encaissement",
    );
    push_line(
        &mut lines,
        &ar_account,
        0,
        amount,
        &currency,
        project,
        client,
        None,
        "Règlement créance",
    );
    Ok(Some(post_entry(
        tx,
        &date,
        "Paiement client",
        "payment",
        payment_id,
        &format!("invoice:{invoice_id}"),
        lines,
    )?))
}

pub(crate) fn post_expense_if_enabled(
    tx: &Transaction<'_>,
    expense_id: &str,
) -> AppResult<Option<Value>> {
    let Some(map) = accounting_map(tx)? else {
        return Ok(None);
    };
    let (date, net, vat, total, currency, project, payment_status): (
        String,
        i64,
        i64,
        i64,
        String,
        Option<String>,
        String,
    ) = tx.query_row(
        "SELECT COALESCE(paid_at,date),net_cents,vat_cents,total_cents,currency,project_id,payment_status FROM expenses WHERE id=?",
        params![expense_id],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        },
    )?;
    if payment_status != "paid" {
        return Ok(None);
    }
    if total <= 0 || net < 0 || vat < 0 || net + vat != total {
        return Err(AppError::Validation(
            "La dépense doit avoir des montants positifs cohérents.".into(),
        ));
    }
    let mut lines = Vec::new();
    if net != 0 {
        push_line(
            &mut lines,
            &map.expense,
            net,
            0,
            &currency,
            project.clone(),
            None,
            None,
            "Charge",
        );
    }
    if vat != 0 {
        push_line(
            &mut lines,
            &map.vat_receivable,
            vat,
            0,
            &currency,
            project.clone(),
            None,
            None,
            "TVA préalable",
        );
    }
    push_line(
        &mut lines,
        &map.bank,
        0,
        total,
        &currency,
        project,
        None,
        None,
        "Paiement dépense",
    );
    Ok(Some(post_entry(
        tx, &date, "Dépense", "expense", expense_id, "create", lines,
    )?))
}

pub(crate) fn post_payslip_if_enabled(
    tx: &Transaction<'_>,
    payslip_id: &str,
    entry_date: &str,
) -> AppResult<Option<Value>> {
    let Some(map) = accounting_map(tx)? else {
        return Ok(None);
    };
    let wages_expense = map.wages_expense.as_deref().ok_or_else(|| {
        AppError::Validation(
            "Le compte de charges salariales doit être configuré avant de comptabiliser une fiche de salaire."
                .into(),
        )
    })?;
    let wages_payable = map.wages_payable.as_deref().ok_or_else(|| {
        AppError::Validation(
            "Le compte de salaires à payer doit être configuré avant de comptabiliser une fiche de salaire."
                .into(),
        )
    })?;
    let social_expense = map.social_expense.as_deref().ok_or_else(|| {
        AppError::Validation(
            "Le compte de charges sociales doit être configuré avant de comptabiliser une fiche de salaire."
                .into(),
        )
    })?;
    let social_payable = map.social_payable.as_deref().ok_or_else(|| {
        AppError::Validation(
            "Le compte de cotisations à payer doit être configuré avant de comptabiliser une fiche de salaire."
                .into(),
        )
    })?;
    validate_account_type(
        tx,
        wages_expense,
        &["expense"],
        "Le compte de charges salariales",
    )?;
    validate_account_type(
        tx,
        wages_payable,
        &["liability"],
        "Le compte de salaires à payer",
    )?;
    validate_account_type(
        tx,
        social_expense,
        &["expense"],
        "Le compte de charges sociales",
    )?;
    validate_account_type(
        tx,
        social_payable,
        &["liability"],
        "Le compte de cotisations à payer",
    )?;
    let (gross,deductions,net,employer,employee):(i64,i64,i64,i64,String)=tx.query_row("SELECT gross_cents,deductions_cents,net_cents,employer_costs_cents,employee_id FROM payslips WHERE id=?",params![payslip_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    let reimbursements: i64 = tx.query_row(
        "SELECT COALESCE(SUM(amount_cents),0) FROM payslip_items WHERE payslip_id=? AND kind='reimbursement'",
        params![payslip_id],
        |row| row.get(0),
    )?;
    let expected_net = gross
        .checked_sub(deductions)
        .and_then(|value| value.checked_add(reimbursements));
    if gross <= 0
        || deductions < 0
        || reimbursements < 0
        || employer < 0
        || expected_net != Some(net)
    {
        return Err(AppError::Validation(
            "Les totaux de la fiche de salaire sont incohérents.".into(),
        ));
    }
    let currency: String =
        tx.query_row("SELECT currency FROM settings WHERE id=1", [], |r| r.get(0))?;
    let mut lines = Vec::new();
    let mut fallbacks = Vec::new();
    push_line(
        &mut lines,
        wages_expense,
        gross,
        0,
        &currency,
        None,
        None,
        Some(employee.clone()),
        "Salaire brut",
    );
    if net > 0 {
        push_line(
            &mut lines,
            wages_payable,
            0,
            net,
            &currency,
            None,
            None,
            Some(employee.clone()),
            "Salaire net dû",
        );
    }
    let contributions = {
        let mut statement = tx.prepare(
            "SELECT label,side,amount_cents,liability_account_id,expense_account_id FROM payslip_contributions WHERE payslip_id=? ORDER BY rowid",
        )?;
        let rows = statement
            .query_map(params![payslip_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut frozen_employee_deductions = 0_i64;
    let mut frozen_employer_costs = 0_i64;
    for (label, side, amount, liability_account_id, expense_account_id) in contributions {
        if amount <= 0 {
            continue;
        }
        let liability = liability_account_id
            .as_deref()
            .filter(|account| !account.trim().is_empty())
            .unwrap_or(social_payable);
        validate_account_type(
            tx,
            liability,
            &["liability"],
            &format!("Le compte créancier de la cotisation « {label} »"),
        )?;
        if liability_account_id
            .as_deref()
            .is_none_or(|account| account.trim().is_empty())
        {
            fallbacks.push(json!({
                "contribution": label,
                "field": "liability_account_id",
                "account_id": social_payable,
                "reason": "Compte créancier non figé : utilisation du compte général de cotisations dues."
            }));
        }
        match side.as_str() {
            "employee" => {
                frozen_employee_deductions = frozen_employee_deductions
                    .checked_add(amount)
                    .ok_or_else(|| {
                        AppError::Validation(
                            "Le total des retenues dépasse la capacité locale.".into(),
                        )
                    })?;
                push_line(
                    &mut lines,
                    liability,
                    0,
                    amount,
                    &currency,
                    None,
                    None,
                    Some(employee.clone()),
                    &format!(
                        "Retenue employé · {label} · {}",
                        if liability_account_id.is_some() {
                            "compte figé"
                        } else {
                            "compte général"
                        }
                    ),
                );
            }
            "employer" => {
                frozen_employer_costs =
                    frozen_employer_costs.checked_add(amount).ok_or_else(|| {
                        AppError::Validation(
                            "Le total des charges employeur dépasse la capacité locale.".into(),
                        )
                    })?;
                let expense = expense_account_id
                    .as_deref()
                    .filter(|account| !account.trim().is_empty())
                    .unwrap_or(social_expense);
                validate_account_type(
                    tx,
                    expense,
                    &["expense"],
                    &format!("Le compte de charge de la cotisation « {label} »"),
                )?;
                if expense_account_id
                    .as_deref()
                    .is_none_or(|account| account.trim().is_empty())
                {
                    fallbacks.push(json!({
                        "contribution": label,
                        "field": "expense_account_id",
                        "account_id": social_expense,
                        "reason": "Compte de charge non figé : utilisation du compte général de charges sociales."
                    }));
                }
                push_line(
                    &mut lines,
                    expense,
                    amount,
                    0,
                    &currency,
                    None,
                    None,
                    Some(employee.clone()),
                    &format!(
                        "Charge employeur · {label} · {}",
                        if expense_account_id.is_some() {
                            "compte figé"
                        } else {
                            "compte général"
                        }
                    ),
                );
                push_line(
                    &mut lines,
                    liability,
                    0,
                    amount,
                    &currency,
                    None,
                    None,
                    Some(employee.clone()),
                    &format!(
                        "Dette employeur · {label} · {}",
                        if liability_account_id.is_some() {
                            "compte figé"
                        } else {
                            "compte général"
                        }
                    ),
                );
            }
            _ => {
                return Err(AppError::Validation(format!(
                    "Le côté comptable de la cotisation « {label} » est invalide."
                )))
            }
        }
    }
    let manual_items = {
        let mut statement = tx.prepare(
            "SELECT pi.label,pi.kind,pi.amount_cents,pi.posting_account_id,pi.expense_account_id FROM payslip_items pi LEFT JOIN payslip_contributions pc ON pc.payslip_item_id=pi.id WHERE pi.payslip_id=? AND pc.id IS NULL AND pi.kind IN ('deduction','employer','reimbursement') ORDER BY pi.position,pi.rowid",
        )?;
        let rows = statement
            .query_map(params![payslip_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut mapped_deductions = 0_i64;
    let mut mapped_employer_costs = 0_i64;
    let mut mapped_reimbursements = 0_i64;
    for (label, kind, amount, posting_account_id, expense_account_id) in manual_items {
        if amount <= 0 {
            continue;
        }
        match kind.as_str() {
            "deduction" => {
                let account = require_manual_payroll_account(
                    tx,
                    posting_account_id.as_deref(),
                    &["asset", "liability"],
                    &label,
                    "compte de contrepartie",
                )?;
                mapped_deductions = mapped_deductions.checked_add(amount).ok_or_else(|| {
                    AppError::Validation(
                        "Le total des retenues manuelles dépasse la capacité locale.".into(),
                    )
                })?;
                push_line(
                    &mut lines,
                    account,
                    0,
                    amount,
                    &currency,
                    None,
                    None,
                    Some(employee.clone()),
                    &format!("Retenue manuelle · {label} · compte explicitement choisi"),
                );
            }
            "reimbursement" => {
                let expense = require_manual_payroll_account(
                    tx,
                    expense_account_id.as_deref(),
                    &["expense"],
                    &label,
                    "compte de charge",
                )?;
                mapped_reimbursements =
                    mapped_reimbursements.checked_add(amount).ok_or_else(|| {
                        AppError::Validation(
                            "Le total des remboursements dépasse la capacité locale.".into(),
                        )
                    })?;
                push_line(
                    &mut lines,
                    expense,
                    amount,
                    0,
                    &currency,
                    None,
                    None,
                    Some(employee.clone()),
                    &format!("Remboursement hors salaire brut · {label}"),
                );
            }
            "employer" => {
                let liability = require_manual_payroll_account(
                    tx,
                    posting_account_id.as_deref(),
                    &["liability"],
                    &label,
                    "compte de dette",
                )?;
                let expense = require_manual_payroll_account(
                    tx,
                    expense_account_id.as_deref(),
                    &["expense"],
                    &label,
                    "compte de charge",
                )?;
                mapped_employer_costs =
                    mapped_employer_costs.checked_add(amount).ok_or_else(|| {
                        AppError::Validation(
                            "Le total des charges employeur manuelles dépasse la capacité locale."
                                .into(),
                        )
                    })?;
                push_line(
                    &mut lines,
                    expense,
                    amount,
                    0,
                    &currency,
                    None,
                    None,
                    Some(employee.clone()),
                    &format!("Charge employeur manuelle · {label}"),
                );
                push_line(
                    &mut lines,
                    liability,
                    0,
                    amount,
                    &currency,
                    None,
                    None,
                    Some(employee.clone()),
                    &format!("Dette employeur manuelle · {label}"),
                );
            }
            _ => unreachable!("manual payroll query filters kinds"),
        }
    }
    let classified_deductions = frozen_employee_deductions.checked_add(mapped_deductions);
    let classified_employer = frozen_employer_costs.checked_add(mapped_employer_costs);
    if classified_deductions != Some(deductions)
        || classified_employer != Some(employer)
        || mapped_reimbursements != reimbursements
    {
        return Err(AppError::Validation(
            "Les lignes et cotisations classées ne correspondent pas aux totaux de la fiche de salaire."
                .into(),
        ));
    }
    let mut journal = post_entry(
        tx,
        entry_date,
        "Comptabilisation paie",
        "payslip",
        payslip_id,
        "post",
        lines,
    )?;
    journal["accounting_fallbacks"] = Value::Array(fallbacks);
    Ok(Some(journal))
}

pub(crate) fn post_payslip_payment_if_enabled(
    tx: &Transaction<'_>,
    payslip_id: &str,
    payment_date: &str,
    reference: Option<&str>,
) -> AppResult<Option<Value>> {
    let Some(map) = accounting_map(tx)? else {
        return Ok(None);
    };
    let (net, employee, period): (i64, String, String) = tx.query_row(
        "SELECT net_cents,employee_id,period FROM payslips WHERE id=?",
        params![payslip_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if net <= 0 {
        return Err(AppError::Validation(
            "Le salaire net à payer doit être strictement positif.".into(),
        ));
    }
    let wages_payable_account = posted_wages_payable_account(tx, payslip_id, &employee, net)?;
    let currency: String = tx.query_row("SELECT currency FROM settings WHERE id=1", [], |row| {
        row.get(0)
    })?;
    let reference_note = reference
        .filter(|value| !value.is_empty())
        .map(|value| format!(" · Réf. {value}"))
        .unwrap_or_default();
    let mut lines = Vec::new();
    push_line(
        &mut lines,
        &wages_payable_account,
        net,
        0,
        &currency,
        None,
        None,
        Some(employee.clone()),
        &format!("Extinction salaire net dû · {period}{reference_note}"),
    );
    push_line(
        &mut lines,
        &map.bank,
        0,
        net,
        &currency,
        None,
        None,
        Some(employee),
        &format!("Paiement bancaire du salaire · {period}{reference_note}"),
    );
    Ok(Some(post_entry(
        tx,
        payment_date,
        &format!("Paiement salaire {period}"),
        "payslip",
        payslip_id,
        "payment",
        lines,
    )?))
}

fn posted_wages_payable_account(
    tx: &Transaction<'_>,
    payslip_id: &str,
    employee_id: &str,
    net_cents: i64,
) -> AppResult<String> {
    let mut statement = tx.prepare(
        "SELECT jl.account_id FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id WHERE je.source_type='payslip' AND je.source_id=? AND je.source_event='post' AND jl.memo='Salaire net dû' AND jl.employee_id=? AND jl.debit_cents=0 AND jl.credit_cents=? ORDER BY jl.rowid",
    )?;
    let accounts = statement
        .query_map(params![payslip_id, employee_id, net_cents], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let account_id = match accounts.as_slice() {
        [account_id] => account_id.clone(),
        [] => {
            return Err(AppError::Validation(
                "L'écriture de paie d'origine ne contient pas de compte de salaire net dû identifiable."
                    .into(),
            ))
        }
        _ => {
            return Err(AppError::Validation(
                "L'écriture de paie d'origine contient plusieurs comptes de salaire net dû; le paiement est bloqué."
                    .into(),
            ))
        }
    };
    validate_account_type(
        tx,
        &account_id,
        &["liability"],
        "Le compte de salaire net dû figé",
    )?;
    Ok(account_id)
}

fn account_is_referenced(tx: &Transaction<'_>, account_id: &str) -> AppResult<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM journal_lines WHERE account_id=? UNION ALL SELECT 1 FROM accounting_settings WHERE ar_account_id=? OR revenue_account_id=? OR vat_payable_account_id=? OR bank_account_id=? OR expense_account_id=? OR vat_receivable_account_id=? OR wages_expense_account_id=? OR wages_payable_account_id=? OR social_expense_account_id=? OR social_payable_account_id=? OR supplier_payable_account_id=? UNION ALL SELECT 1 FROM supplier_invoice_items WHERE expense_account_id=? UNION ALL SELECT 1 FROM payroll_contribution_definitions WHERE liability_account_id=? OR expense_account_id=? UNION ALL SELECT 1 FROM payslip_contributions WHERE liability_account_id=? OR expense_account_id=? UNION ALL SELECT 1 FROM payslip_items WHERE posting_account_id=? OR expense_account_id=?)",
        params![
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id,
            account_id
        ],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn validate_account_type(
    tx: &Transaction<'_>,
    account_id: &str,
    expected_types: &[&str],
    label: &str,
) -> AppResult<()> {
    let actual = tx
        .query_row(
            "SELECT account_type FROM accounts WHERE id=?",
            params![account_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("accounts/{account_id}")))?;
    if !expected_types.contains(&actual.as_str()) {
        return Err(AppError::Validation(format!(
            "{label} doit être de type {}.",
            expected_types.join(" ou ")
        )));
    }
    Ok(())
}

fn require_manual_payroll_account<'a>(
    tx: &Transaction<'_>,
    account_id: Option<&'a str>,
    expected_types: &[&str],
    line_label: &str,
    field_label: &str,
) -> AppResult<&'a str> {
    let account_id = account_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::Validation(format!(
                "La ligne de paie « {line_label} » exige un {field_label} explicite avant comptabilisation."
            ))
        })?;
    let account = tx
        .query_row(
            "SELECT account_type,active FROM accounts WHERE id=?",
            params![account_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("accounts/{account_id}")))?;
    if !account.1 {
        return Err(AppError::Validation(format!(
            "Le {field_label} de la ligne « {line_label} » est inactif."
        )));
    }
    if !expected_types.contains(&account.0.as_str()) {
        return Err(AppError::Validation(format!(
            "Le {field_label} de la ligne « {line_label} » doit être de type {}.",
            expected_types.join(" ou ")
        )));
    }
    Ok(account_id)
}

fn accounting_map(tx: &Transaction<'_>) -> AppResult<Option<AccountingMap>> {
    let map = tx.query_row("SELECT ar_account_id,revenue_account_id,vat_payable_account_id,bank_account_id,expense_account_id,vat_receivable_account_id,wages_expense_account_id,wages_payable_account_id,social_expense_account_id,social_payable_account_id,supplier_payable_account_id FROM accounting_settings WHERE id=1 AND enabled=1",[],|r|Ok(AccountingMap{ar:r.get(0)?,revenue:r.get(1)?,vat_payable:r.get(2)?,bank:r.get(3)?,expense:r.get(4)?,vat_receivable:r.get(5)?,wages_expense:r.get(6)?,wages_payable:r.get(7)?,social_expense:r.get(8)?,social_payable:r.get(9)?,supplier_payable:r.get(10)?})).optional()?;
    if let Some(map) = &map {
        for (account_id, expected_type, label) in [
            (&map.ar, "asset", "Le compte clients"),
            (&map.revenue, "revenue", "Le compte de produits"),
            (&map.vat_payable, "liability", "Le compte de TVA due"),
            (&map.bank, "asset", "Le compte bancaire"),
            (&map.expense, "expense", "Le compte de charges"),
            (&map.vat_receivable, "asset", "Le compte de TVA préalable"),
        ] {
            validate_account_type(tx, account_id, &[expected_type], label)?;
        }
        if let Some(account_id) = map.supplier_payable.as_deref() {
            validate_account_type(
                tx,
                account_id,
                &["liability"],
                "Le compte de dettes fournisseurs",
            )?;
        }
        validate_core_mapping_role_separation(
            Some(map.ar.as_str()),
            Some(map.bank.as_str()),
            Some(map.vat_receivable.as_str()),
        )?;
    }
    Ok(map)
}

pub(crate) fn post_entry(
    tx: &Transaction<'_>,
    date: &str,
    description: &str,
    source_type: &str,
    source_id: &str,
    source_event: &str,
    lines: Vec<EntryLine>,
) -> AppResult<Value> {
    post_entry_with_reversal(
        tx,
        date,
        description,
        source_type,
        source_id,
        source_event,
        lines,
        None,
    )
}
#[allow(clippy::too_many_arguments)]
fn post_entry_with_reversal(
    tx: &Transaction<'_>,
    date: &str,
    description: &str,
    source_type: &str,
    source_id: &str,
    source_event: &str,
    lines: Vec<EntryLine>,
    reversal_of: Option<&str>,
) -> AppResult<Value> {
    ensure_accounting_date_open(tx, date)?;
    if lines.len() < 2 {
        return Err(AppError::Validation(
            "Une écriture doit contenir au moins deux lignes.".into(),
        ));
    }
    let debit: i64 = lines.iter().map(|l| l.debit_cents).sum();
    let credit: i64 = lines.iter().map(|l| l.credit_cents).sum();
    if debit <= 0 || debit != credit {
        return Err(AppError::Validation(format!(
            "Écriture déséquilibrée : débits {debit}, crédits {credit}."
        )));
    }
    if source_type != "manual" && reversal_of.is_none() {
        let mut sides = std::collections::BTreeMap::<&str, (i64, i64)>::new();
        for line in &lines {
            let totals = sides.entry(line.account_id.as_str()).or_default();
            totals.0 = totals.0.saturating_add(line.debit_cents);
            totals.1 = totals.1.saturating_add(line.credit_cents);
        }
        if let Some((account_id, _)) = sides
            .iter()
            .find(|(_, (account_debit, account_credit))| *account_debit > 0 && *account_credit > 0)
        {
            return Err(AppError::Validation(format!(
                "L'écriture automatique utiliserait le même compte {account_id} au débit et au crédit. Corrigez les comptes de liaison avant de poursuivre."
            )));
        }
    }
    for line in &lines {
        if line.debit_cents < 0
            || line.credit_cents < 0
            || (line.debit_cents == 0) == (line.credit_cents == 0)
        {
            return Err(AppError::Validation("Chaque ligne doit avoir un débit ou un crédit strictement positif, jamais les deux.".into()));
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=? AND active=1)",
            params![line.account_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(AppError::Validation(format!(
                "Compte actif introuvable : {}",
                line.account_id
            )));
        }
    }
    if let Some(existing) = tx
        .query_row(
            "SELECT id FROM journal_entries WHERE source_type=? AND source_id=? AND source_event=?",
            params![source_type, source_id, source_event],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        let (existing_date, existing_description, existing_reversal_of): (
            String,
            String,
            Option<String>,
        ) = tx.query_row(
            "SELECT entry_date,description,reversal_of FROM journal_entries WHERE id=?",
            params![existing],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let existing_lines = {
            let mut statement = tx.prepare(
                "SELECT account_id,debit_cents,credit_cents,currency,memo,project_id,client_id,employee_id FROM journal_lines WHERE journal_entry_id=? ORDER BY rowid",
            )?;
            let rows = statement.query_map(params![existing], |row| {
                Ok(EntryLine {
                    account_id: row.get(0)?,
                    debit_cents: row.get(1)?,
                    credit_cents: row.get(2)?,
                    currency: row.get(3)?,
                    memo: row.get(4)?,
                    project_id: row.get(5)?,
                    client_id: row.get(6)?,
                    employee_id: row.get(7)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        if existing_date != date
            || existing_description != description
            || existing_reversal_of.as_deref() != reversal_of
            || existing_lines != lines
        {
            return Err(AppError::Validation(format!(
                "Une écriture existe déjà pour {source_type}/{source_id}/{source_event}, mais sa date, son libellé ou ses lignes diffèrent. Zentra bloque la reprise pour éviter une fausse idempotence."
            )));
        }
        return journal_entry_json(tx, &existing);
    }
    let year: i64 = date[0..4]
        .parse()
        .map_err(|_| AppError::Validation("Année comptable invalide.".into()))?;
    let next = tx
        .query_row(
            "SELECT next_value FROM accounting_sequences WHERE year=?",
            params![year],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(1);
    tx.execute("INSERT INTO accounting_sequences(year,next_value) VALUES(?,?) ON CONFLICT(year) DO UPDATE SET next_value=excluded.next_value",params![year,next+1])?;
    let id = Uuid::new_v4().to_string();
    let number = format!("J-{year}-{next:06}");
    let now = now_iso();
    tx.execute("INSERT INTO journal_entries(id,number,entry_date,description,source_type,source_id,source_event,status,reversal_of,created_at) VALUES(?,?,?,?,?,?,?,'posted',?,?)",params![id,number,date,description,source_type,source_id,source_event,reversal_of,now])?;
    for line in lines {
        tx.execute("INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_cents,credit_cents,currency,memo,project_id,client_id,employee_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![Uuid::new_v4().to_string(),id,line.account_id,line.debit_cents,line.credit_cents,line.currency,line.memo,line.project_id,line.client_id,line.employee_id,now])?;
    }
    journal_entry_json(tx, &id)
}

fn validate_core_mapping_role_separation(
    ar_account_id: Option<&str>,
    bank_account_id: Option<&str>,
    vat_receivable_account_id: Option<&str>,
) -> AppResult<()> {
    let roles = [
        (ar_account_id, "Créances clients"),
        (bank_account_id, "Banque"),
        (vat_receivable_account_id, "TVA préalable"),
    ];
    for left in 0..roles.len() {
        for right in (left + 1)..roles.len() {
            if roles[left]
                .0
                .zip(roles[right].0)
                .is_some_and(|(left_id, right_id)| {
                    !left_id.trim().is_empty() && left_id == right_id
                })
            {
                return Err(AppError::Validation(format!(
                    "Les liaisons « {} » et « {} » doivent utiliser deux comptes distincts.",
                    roles[left].1, roles[right].1
                )));
            }
        }
    }
    Ok(())
}

fn journal_entry_json(tx: &Transaction<'_>, id: &str) -> AppResult<Value> {
    let entry = one_json(tx, "SELECT * FROM journal_entries WHERE id=?", params![id])?;
    let mut st=tx.prepare("SELECT jl.*,a.code AS account_code,a.name AS account_name FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.journal_entry_id=? ORDER BY jl.rowid")?;
    let lines = st
        .query_map(params![id], crate::database::row_to_json_public)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"entry":entry,"lines":lines,"id":id}))
}

#[allow(clippy::too_many_arguments)]
fn push_line(
    lines: &mut Vec<EntryLine>,
    account: &str,
    debit: i64,
    credit: i64,
    currency: &str,
    project: Option<String>,
    client: Option<String>,
    employee: Option<String>,
    memo: &str,
) {
    if debit == 0 && credit == 0 {
        return;
    }
    lines.push(EntryLine {
        account_id: account.into(),
        debit_cents: debit,
        credit_cents: credit,
        currency: currency.into(),
        memo: Some(memo.into()),
        project_id: project,
        client_id: client,
        employee_id: employee,
    });
}
fn one_json<P: rusqlite::Params>(tx: &Transaction<'_>, sql: &str, p: P) -> AppResult<Value> {
    let mut st = tx.prepare(sql)?;
    st.query_row(p, crate::database::row_to_json_public)
        .optional()?
        .ok_or_else(|| AppError::NotFound(sql.into()))
}
fn required(value: &str, field: &str, max: usize) -> AppResult<String> {
    let v = value.trim();
    if v.is_empty() || v.chars().count() > max {
        return Err(AppError::Validation(format!(
            "{field} est obligatoire et limité à {max} caractères."
        )));
    }
    Ok(v.into())
}
fn valid_report_section(account_type: &str, section: &str) -> bool {
    match account_type {
        "asset" => matches!(section, "current_assets" | "fixed_assets"),
        "liability" => matches!(section, "short_term_liabilities" | "long_term_liabilities"),
        "equity" => section == "equity",
        "revenue" => matches!(
            section,
            "net_revenue" | "financial_result" | "non_operating_result" | "exceptional_result"
        ),
        "expense" => matches!(
            section,
            "cost_of_goods"
                | "personnel_expense"
                | "other_operating_expense"
                | "depreciation"
                | "financial_result"
                | "non_operating_result"
                | "exceptional_result"
                | "taxes"
        ),
        _ => false,
    }
}
fn currency(value: &str) -> AppResult<String> {
    let v = value.trim().to_uppercase();
    if !matches!(v.as_str(), "CHF" | "EUR") {
        return Err(AppError::Validation(
            "currency doit être CHF ou EUR.".into(),
        ));
    }
    Ok(v)
}
pub(crate) fn validate_date(value: &str, field: &str) -> AppResult<()> {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::Validation(format!("{field} doit être au format AAAA-MM-JJ.")))?;
    Ok(())
}

pub(crate) fn ensure_accounting_date_open(connection: &Connection, date: &str) -> AppResult<()> {
    validate_date(date, "entry_date")?;
    let closed: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM accounting_periods WHERE status='closed' AND ? BETWEEN date_from AND date_to)",
        params![date],
        |row| row.get(0),
    )?;
    if closed {
        return Err(AppError::Validation(
            "La période comptable correspondant à cette date est clôturée.".into(),
        ));
    }
    Ok(())
}

fn financial_sources_without_effective_posting_in_range(
    connection: &Connection,
    date_from: &str,
    date_to: &str,
) -> AppResult<i64> {
    Ok(connection.query_row(
        "WITH RECURSIVE chain(root_id,source_type,source_id,source_event,id,depth) AS (
            SELECT id,source_type,source_id,source_event,id,0 FROM journal_entries WHERE reversal_of IS NULL
            UNION ALL
            SELECT chain.root_id,chain.source_type,chain.source_id,chain.source_event,je.id,chain.depth+1 FROM chain JOIN journal_entries je ON je.reversal_of=chain.id
        ), effective_sources(source_type,source_id,source_event) AS (
            SELECT source_type,source_id,source_event FROM chain GROUP BY root_id,source_type,source_id,source_event HAVING MAX(depth)%2=0
        )
        SELECT COUNT(*) FROM (
            SELECT 'invoice:'||i.id FROM invoices i WHERE i.number IS NOT NULL AND i.status<>'annulee' AND i.issue_date BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM effective_sources e WHERE e.source_type='invoice' AND e.source_id=i.id AND e.source_event='issue')
            UNION ALL
            SELECT 'payment:'||p.id FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status<>'annulee' AND p.date BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM effective_sources e WHERE e.source_type='payment' AND e.source_id=p.id)
            UNION ALL
            SELECT 'expense:'||e.id FROM expenses e WHERE e.payment_status='paid' AND COALESCE(e.paid_at,e.date) BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM effective_sources source WHERE source.source_type='expense' AND source.source_id=e.id)
            UNION ALL
            SELECT 'supplier_invoice:'||invoice.id FROM supplier_invoices invoice WHERE invoice.status='validated' AND invoice.document_date BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM effective_sources source WHERE source.source_type='supplier_invoice' AND source.source_id=invoice.id AND source.source_event='validate')
            UNION ALL
            SELECT 'supplier_payment:'||payment.id FROM supplier_payments payment WHERE payment.date BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM effective_sources source WHERE source.source_type='supplier_payment' AND source.source_id=payment.id AND source.source_event='invoice:'||payment.supplier_invoice_id)
            UNION ALL
            SELECT 'payslip:'||p.id FROM payslips p WHERE p.status IN('comptabilise','paye') AND p.period||'-01' BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM effective_sources e WHERE e.source_type='payslip' AND e.source_id=p.id AND e.source_event='post')
            UNION ALL
            SELECT 'payslip_payment:'||p.id FROM payslips p WHERE p.status='paye' AND p.payment_date IS NOT NULL AND p.payment_date BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM effective_sources e WHERE e.source_type='payslip' AND e.source_id=p.id AND e.source_event='payment')
            UNION ALL
            SELECT 'undated_payslip_payment:'||p.id FROM payslips p WHERE p.status='paye' AND p.payment_date IS NULL AND p.period||'-01' BETWEEN ? AND ?
            UNION ALL
            SELECT 'cancelled_invoice_posting:'||i.id FROM invoices i WHERE i.status='annulee' AND i.issue_date BETWEEN ? AND ? AND EXISTS(SELECT 1 FROM effective_sources e WHERE e.source_type='invoice' AND e.source_id=i.id AND e.source_event='issue')
            UNION ALL
            SELECT 'cancelled_invoice_payment:'||p.id FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status='annulee' AND p.date BETWEEN ? AND ?
        )",
        params![
            date_from, date_to, date_from, date_to, date_from, date_to, date_from, date_to,
            date_from, date_to, date_from, date_to, date_from, date_to, date_from, date_to,
            date_from, date_to, date_from, date_to
        ],
        |row| row.get(0),
    )?)
}

#[derive(Debug)]
struct EffectivePosting {
    id: String,
    entry_date: String,
    lines: Vec<EntryLine>,
}

fn effective_postings(
    connection: &Connection,
    source_type: &str,
    source_id: &str,
    source_event: &str,
) -> AppResult<Vec<EffectivePosting>> {
    let roots = {
        let mut statement = connection.prepare(
            "SELECT id FROM journal_entries WHERE reversal_of IS NULL AND source_type=? AND source_id=? AND source_event=? ORDER BY created_at,id",
        )?;
        let rows = statement.query_map(params![source_type, source_id, source_event], |row| {
            row.get::<_, String>(0)
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut active = Vec::new();
    for root_id in roots {
        let depth: i64 = connection.query_row(
            "WITH RECURSIVE chain(id,depth) AS (
                SELECT ?,0
                UNION ALL
                SELECT je.id,chain.depth+1 FROM chain JOIN journal_entries je ON je.reversal_of=chain.id
            ) SELECT MAX(depth) FROM chain",
            params![root_id],
            |row| row.get(0),
        )?;
        if depth % 2 != 0 {
            continue;
        }
        let entry_date: String = connection.query_row(
            "SELECT entry_date FROM journal_entries WHERE id=?",
            params![root_id],
            |row| row.get(0),
        )?;
        let lines = {
            let mut statement = connection.prepare(
                "SELECT account_id,debit_cents,credit_cents,currency,memo,project_id,client_id,employee_id FROM journal_lines WHERE journal_entry_id=? ORDER BY rowid",
            )?;
            let rows = statement.query_map(params![root_id], |row| {
                Ok(EntryLine {
                    account_id: row.get(0)?,
                    debit_cents: row.get(1)?,
                    credit_cents: row.get(2)?,
                    currency: row.get(3)?,
                    memo: row.get(4)?,
                    project_id: row.get(5)?,
                    client_id: row.get(6)?,
                    employee_id: row.get(7)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        active.push(EffectivePosting {
            id: root_id,
            entry_date,
            lines,
        });
    }
    Ok(active)
}

fn exact_line_account<'a>(
    posting: &'a EffectivePosting,
    memo: &str,
    debit_cents: i64,
    credit_cents: i64,
) -> Option<&'a str> {
    let mut matches = posting.lines.iter().filter(|line| {
        line.memo.as_deref() == Some(memo)
            && line.debit_cents == debit_cents
            && line.credit_cents == credit_cents
    });
    let account = matches.next()?.account_id.as_str();
    if matches.next().is_some() {
        None
    } else {
        Some(account)
    }
}

fn prefixed_line_account<'a>(
    posting: &'a EffectivePosting,
    memo_prefix: &str,
    debit_cents: i64,
    credit_cents: i64,
) -> Option<&'a str> {
    let mut matches = posting.lines.iter().filter(|line| {
        line.memo
            .as_deref()
            .is_some_and(|memo| memo.starts_with(memo_prefix))
            && line.debit_cents == debit_cents
            && line.credit_cents == credit_cents
    });
    let account = matches.next()?.account_id.as_str();
    if matches.next().is_some() {
        None
    } else {
        Some(account)
    }
}

fn posting_totals_match(posting: &EffectivePosting, expected: i64, currency: &str) -> bool {
    let debit = posting
        .lines
        .iter()
        .try_fold(0_i64, |total, line| total.checked_add(line.debit_cents));
    let credit = posting
        .lines
        .iter()
        .try_fold(0_i64, |total, line| total.checked_add(line.credit_cents));
    debit == Some(expected)
        && credit == Some(expected)
        && posting.lines.len() >= 2
        && posting.lines.iter().all(|line| line.currency == currency)
}

fn account_has_type(connection: &Connection, account_id: &str, expected: &str) -> AppResult<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=? AND account_type=?)",
        params![account_id, expected],
        |row| row.get(0),
    )?)
}

fn semantic_posting_mismatches_in_range(
    connection: &Connection,
    date_from: &str,
    date_to: &str,
) -> AppResult<i64> {
    let mut mismatches = 0_i64;

    let invoices = {
        let mut statement = connection.prepare(
            "SELECT id,type,total_cents,vat_cents,currency,issue_date,original_invoice_id FROM invoices WHERE number IS NOT NULL AND status<>'annulee' AND issue_date BETWEEN ? AND ?",
        )?;
        let rows = statement.query_map(params![date_from, date_to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (id, kind, total, vat, currency, issue_date, original_invoice_id) in invoices {
        let postings = effective_postings(connection, "invoice", &id, "issue")?;
        if postings.is_empty() {
            continue;
        }
        if postings.len() != 1 {
            mismatches += 1;
            continue;
        }
        let posting = &postings[0];
        let net = total - vat;
        let expected_total = total.saturating_abs();
        let mut valid = posting.entry_date == issue_date
            && expected_total > 0
            && posting_totals_match(posting, expected_total, &currency);
        if kind == "avoir" {
            let ar = exact_line_account(posting, "Réduction créance client", 0, -total);
            let revenue = if net != 0 {
                exact_line_account(posting, "Extourne produit", -net, 0)
            } else {
                Some("")
            };
            let vat_account = if vat != 0 {
                exact_line_account(posting, "Extourne TVA", -vat, 0)
            } else {
                Some("")
            };
            valid &= total < 0
                && net <= 0
                && vat <= 0
                && ar.is_some_and(|account| {
                    account_has_type(connection, account, "asset").unwrap_or(false)
                })
                && revenue.is_some_and(|account| {
                    account.is_empty()
                        || account_has_type(connection, account, "revenue").unwrap_or(false)
                })
                && vat_account.is_some_and(|account| {
                    account.is_empty()
                        || account_has_type(connection, account, "liability").unwrap_or(false)
                });
            if let Some(original_id) = original_invoice_id {
                let original = effective_postings(connection, "invoice", &original_id, "issue")?;
                valid &= original.len() == 1
                    && ar
                        == original.first().and_then(|entry| {
                            entry
                                .lines
                                .iter()
                                .find(|line| line.memo.as_deref() == Some("Créance client"))
                                .map(|line| line.account_id.as_str())
                        })
                    && revenue
                        == original
                            .first()
                            .and_then(|entry| {
                                entry
                                    .lines
                                    .iter()
                                    .find(|line| line.memo.as_deref() == Some("Produit facturé"))
                                    .map(|line| line.account_id.as_str())
                            })
                            .or(if net == 0 { Some("") } else { None })
                    && vat_account
                        == original
                            .first()
                            .and_then(|entry| {
                                entry
                                    .lines
                                    .iter()
                                    .find(|line| line.memo.as_deref() == Some("TVA due"))
                                    .map(|line| line.account_id.as_str())
                            })
                            .or(if vat == 0 { Some("") } else { None });
            }
        } else {
            let ar = exact_line_account(posting, "Créance client", total, 0);
            let revenue = if net != 0 {
                exact_line_account(posting, "Produit facturé", 0, net)
            } else {
                Some("")
            };
            let vat_account = if vat != 0 {
                exact_line_account(posting, "TVA due", 0, vat)
            } else {
                Some("")
            };
            valid &= total > 0
                && net >= 0
                && vat >= 0
                && ar.is_some_and(|account| {
                    account_has_type(connection, account, "asset").unwrap_or(false)
                })
                && revenue.is_some_and(|account| {
                    account.is_empty()
                        || account_has_type(connection, account, "revenue").unwrap_or(false)
                })
                && vat_account.is_some_and(|account| {
                    account.is_empty()
                        || account_has_type(connection, account, "liability").unwrap_or(false)
                });
        }
        if !valid {
            mismatches += 1;
        }
    }

    let payments = {
        let mut statement = connection.prepare(
            "SELECT p.id,p.invoice_id,p.date,p.amount_cents,i.currency FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status<>'annulee' AND p.date BETWEEN ? AND ?",
        )?;
        let rows = statement.query_map(params![date_from, date_to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (id, invoice_id, date, amount, currency) in payments {
        let postings =
            effective_postings(connection, "payment", &id, &format!("invoice:{invoice_id}"))?;
        if postings.is_empty() {
            continue;
        }
        if postings.len() != 1 {
            mismatches += 1;
            continue;
        }
        let posting = &postings[0];
        let bank = exact_line_account(posting, "Encaissement", amount, 0);
        let ar = exact_line_account(posting, "Règlement créance", 0, amount);
        let original = effective_postings(connection, "invoice", &invoice_id, "issue")?;
        let original_ar = original.first().and_then(|entry| {
            entry
                .lines
                .iter()
                .find(|line| line.memo.as_deref() == Some("Créance client"))
                .map(|line| line.account_id.as_str())
        });
        let valid = posting.entry_date == date
            && amount > 0
            && posting_totals_match(posting, amount, &currency)
            && bank.is_some_and(|account| {
                account_has_type(connection, account, "asset").unwrap_or(false)
            })
            && ar.is_some()
            && bank != ar
            && original.len() == 1
            && ar == original_ar;
        if !valid {
            mismatches += 1;
        }
    }

    let expenses = {
        let mut statement = connection.prepare(
            "SELECT id,COALESCE(paid_at,date),net_cents,vat_cents,total_cents,currency FROM expenses WHERE payment_status='paid' AND COALESCE(paid_at,date) BETWEEN ? AND ?",
        )?;
        let rows = statement.query_map(params![date_from, date_to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (id, date, net, vat, total, currency) in expenses {
        let postings = effective_postings(connection, "expense", &id, "create")?;
        if postings.is_empty() {
            continue;
        }
        if postings.len() != 1 {
            mismatches += 1;
            continue;
        }
        let posting = &postings[0];
        let charge = if net != 0 {
            exact_line_account(posting, "Charge", net, 0)
        } else {
            Some("")
        };
        let vat_line = if vat != 0 {
            exact_line_account(posting, "TVA préalable", vat, 0)
        } else {
            Some("")
        };
        let bank = exact_line_account(posting, "Paiement dépense", 0, total);
        let valid = posting.entry_date == date
            && total > 0
            && net >= 0
            && vat >= 0
            && net.checked_add(vat) == Some(total)
            && posting_totals_match(posting, total, &currency)
            && charge.is_some_and(|account| {
                account.is_empty()
                    || account_has_type(connection, account, "expense").unwrap_or(false)
            })
            && vat_line.is_some_and(|account| {
                account.is_empty()
                    || account_has_type(connection, account, "asset").unwrap_or(false)
            })
            && bank.is_some_and(|account| {
                account_has_type(connection, account, "asset").unwrap_or(false)
            })
            && (vat == 0 || vat_line != bank);
        if !valid {
            mismatches += 1;
        }
    }

    let supplier_invoices = {
        let mut statement = connection.prepare(
            "SELECT id,document_date,net_cents,vat_cents,total_cents,currency,validation_journal_entry_id FROM supplier_invoices WHERE status='validated' AND document_date BETWEEN ? AND ?",
        )?;
        let rows = statement.query_map(params![date_from, date_to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (id, document_date, net, vat, total, currency, linked_journal_id) in supplier_invoices {
        let postings = effective_postings(connection, "supplier_invoice", &id, "validate")?;
        if postings.is_empty() {
            continue;
        }
        if postings.len() != 1 {
            mismatches += 1;
            continue;
        }
        let posting = &postings[0];
        let charge_lines = posting.lines.iter().filter(|line| {
            line.debit_cents > 0 && line.memo.as_deref() != Some("TVA préalable fournisseur")
        });
        let mut charge_total = 0_i64;
        let mut charge_accounts_valid = true;
        for line in charge_lines {
            charge_total = charge_total.saturating_add(line.debit_cents);
            charge_accounts_valid &= account_has_type(connection, &line.account_id, "expense")?;
        }
        let vat_account = if vat > 0 {
            exact_line_account(posting, "TVA préalable fournisseur", vat, 0)
        } else {
            Some("")
        };
        let payable = exact_line_account(posting, "Dette fournisseur", 0, total);
        let valid = posting.entry_date == document_date
            && linked_journal_id.as_deref() == Some(posting.id.as_str())
            && total > 0
            && net >= 0
            && vat >= 0
            && net.checked_add(vat) == Some(total)
            && charge_total == net
            && charge_accounts_valid
            && posting_totals_match(posting, total, &currency)
            && vat_account.is_some_and(|account| {
                account.is_empty()
                    || account_has_type(connection, account, "asset").unwrap_or(false)
            })
            && payable.is_some_and(|account| {
                account_has_type(connection, account, "liability").unwrap_or(false)
            });
        if !valid {
            mismatches += 1;
        }
    }

    let supplier_payments = {
        let mut statement = connection.prepare(
            "SELECT payment.id,payment.supplier_invoice_id,payment.date,payment.amount_cents,payment.journal_entry_id,invoice.currency,invoice.total_cents,invoice.document_date FROM supplier_payments payment JOIN supplier_invoices invoice ON invoice.id=payment.supplier_invoice_id WHERE payment.date BETWEEN ? AND ?",
        )?;
        let rows = statement.query_map(params![date_from, date_to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (
        id,
        invoice_id,
        payment_date,
        amount,
        linked_journal_id,
        currency,
        invoice_total,
        invoice_date,
    ) in supplier_payments
    {
        let postings = effective_postings(
            connection,
            "supplier_payment",
            &id,
            &format!("invoice:{invoice_id}"),
        )?;
        if postings.is_empty() {
            continue;
        }
        if postings.len() != 1 {
            mismatches += 1;
            continue;
        }
        let posting = &postings[0];
        let payable = exact_line_account(posting, "Règlement dette fournisseur", amount, 0);
        let bank = exact_line_account(posting, "Paiement fournisseur", 0, amount);
        let original = effective_postings(connection, "supplier_invoice", &invoice_id, "validate")?;
        let original_payable = original
            .first()
            .and_then(|entry| exact_line_account(entry, "Dette fournisseur", 0, invoice_total));
        let valid = posting.entry_date == payment_date
            && linked_journal_id == posting.id
            && amount > 0
            && payment_date >= invoice_date
            && posting_totals_match(posting, amount, &currency)
            && payable.is_some()
            && original.len() == 1
            && payable == original_payable
            && bank.is_some_and(|account| {
                account_has_type(connection, account, "asset").unwrap_or(false)
            });
        if !valid {
            mismatches += 1;
        }
    }

    let payslips = {
        let currency: String =
            connection.query_row("SELECT currency FROM settings WHERE id=1", [], |row| {
                row.get(0)
            })?;
        let mut statement = connection.prepare(
            "SELECT p.id,p.period,p.gross_cents,p.net_cents,p.employer_costs_cents,p.status,p.payment_date,p.payment_journal_entry_id,
                    COALESCE((SELECT SUM(pi.amount_cents) FROM payslip_items pi WHERE pi.payslip_id=p.id AND pi.kind='reimbursement'),0)
             FROM payslips p WHERE p.status IN('comptabilise','paye') AND p.period||'-01' BETWEEN ? AND ?",
        )?;
        let rows = statement
            .query_map(params![date_from, date_to], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        (currency, rows)
    };
    for (
        id,
        period,
        gross,
        net,
        employer_costs,
        status,
        payment_date,
        payment_journal_id,
        reimbursements,
    ) in payslips.1
    {
        let postings = effective_postings(connection, "payslip", &id, "post")?;
        if !postings.is_empty() {
            let valid = if postings.len() == 1 {
                let posting = &postings[0];
                let expected = gross
                    .checked_add(employer_costs)
                    .and_then(|value| value.checked_add(reimbursements));
                posting.entry_date.starts_with(&period)
                    && expected
                        .is_some_and(|amount| posting_totals_match(posting, amount, &payslips.0))
                    && exact_line_account(posting, "Salaire brut", gross, 0).is_some_and(
                        |account| account_has_type(connection, account, "expense").unwrap_or(false),
                    )
                    && (net == 0
                        || exact_line_account(posting, "Salaire net dû", 0, net).is_some_and(
                            |account| {
                                account_has_type(connection, account, "liability").unwrap_or(false)
                            },
                        ))
            } else {
                false
            };
            if !valid {
                mismatches += 1;
            }
        }
        if status == "paye" {
            let Some(payment_date) = payment_date else {
                continue;
            };
            if payment_date.as_str() < date_from || payment_date.as_str() > date_to {
                continue;
            }
            let payment_postings = effective_postings(connection, "payslip", &id, "payment")?;
            if payment_postings.is_empty() {
                continue;
            }
            let valid = if payment_postings.len() == 1 {
                let posting = &payment_postings[0];
                let payable = prefixed_line_account(posting, "Extinction salaire net dû", net, 0);
                let bank = prefixed_line_account(posting, "Paiement bancaire du salaire", 0, net);
                let posted_payable = postings
                    .first()
                    .and_then(|entry| exact_line_account(entry, "Salaire net dû", 0, net));
                posting.entry_date == payment_date
                    && payment_journal_id.as_deref() == Some(posting.id.as_str())
                    && posting_totals_match(posting, net, &payslips.0)
                    && payable.is_some()
                    && payable == posted_payable
                    && bank.is_some_and(|account| {
                        account_has_type(connection, account, "asset").unwrap_or(false)
                    })
            } else {
                false
            };
            if !valid {
                mismatches += 1;
            }
        }
    }

    Ok(mismatches)
}
fn period_clause(filter: &PeriodFilter, column: &str) -> AppResult<(String, Vec<SqlValue>)> {
    period_parts(filter, column, "WHERE")
}
fn period_join_clause(filter: &PeriodFilter, column: &str) -> AppResult<(String, Vec<SqlValue>)> {
    period_parts(filter, column, "WHERE")
}
fn period_and_clause(filter: &PeriodFilter, column: &str) -> AppResult<(String, Vec<SqlValue>)> {
    period_parts(filter, column, "AND")
}
fn period_parts(
    filter: &PeriodFilter,
    column: &str,
    prefix: &str,
) -> AppResult<(String, Vec<SqlValue>)> {
    let mut clauses = Vec::new();
    let mut vals = Vec::new();
    if let Some(v) = filter.date_from.as_deref() {
        validate_date(v, "date_from")?;
        clauses.push(format!("{column}>=?"));
        vals.push(SqlValue::Text(v.into()));
    }
    if let Some(v) = filter.date_to.as_deref() {
        validate_date(v, "date_to")?;
        clauses.push(format!("{column}<=?"));
        vals.push(SqlValue::Text(v.into()));
    }
    if clauses.is_empty() {
        Ok((String::new(), vals))
    } else {
        Ok((format!("{prefix} {}", clauses.join(" AND ")), vals))
    }
}
