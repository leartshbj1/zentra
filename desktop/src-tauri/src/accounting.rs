use std::collections::BTreeMap;

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
    vat_deferred_payable: Option<String>,
    bank: String,
    expense: String,
    vat_receivable: String,
    wages_expense: Option<String>,
    wages_payable: Option<String>,
    social_expense: Option<String>,
    social_payable: Option<String>,
    supplier_payable: Option<String>,
}

const VAT_DEFERRED_MEMO: &str = "TVA à régulariser · contre-prestations reçues";
const VAT_CASH_RELEASE_MEMO: &str = "Reclassement TVA à régulariser";
const VAT_CASH_DUE_MEMO: &str = "TVA due sur encaissement";
const VAT_CREDIT_DEFERRED_MEMO: &str = "Extourne TVA à régulariser";
const VAT_CREDIT_DUE_MEMO: &str = "Extourne TVA due encaissée";

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
    String,
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
        if let Some(closed_through) = closed_accounting_through(&tx)? {
            let requested_from = chrono::NaiveDate::parse_from_str(&input.date_from, "%Y-%m-%d")
                .map_err(|_| {
                    AppError::Validation("date_from doit être au format AAAA-MM-JJ.".into())
                })?;
            let closed_through_date =
                chrono::NaiveDate::parse_from_str(&closed_through, "%Y-%m-%d").map_err(|_| {
                    AppError::Validation(
                        "La frontière de clôture enregistrée dans la base est invalide.".into(),
                    )
                })?;
            if requested_from <= closed_through_date {
                return Err(AppError::Validation(format!(
                "La comptabilité est clôturée cumulativement jusqu'au {closed_through}. Une nouvelle période doit commencer après cette date."
                )));
            }
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
            financial_sources_without_effective_posting_in_range(&tx, "0001-01-01", date_to)?;
        if incomplete_sources != 0 {
            return Err(AppError::Validation(format!(
                "La clôture cumulative est bloquée : {incomplete_sources} opération(s) financière(s) antérieure(s) ou comprise(s) dans cette période n'ont pas une écriture comptable active et traçable. Activez ou corrigez la comptabilité, puis relancez le contrôle."
            )));
        }
        let unbalanced:i64=tx.query_row("SELECT COUNT(*) FROM (SELECT je.id FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id WHERE je.entry_date BETWEEN '0001-01-01' AND ? GROUP BY je.id HAVING SUM(jl.debit_cents)<>SUM(jl.credit_cents))",params![date_to],|r|r.get(0))?;
        if unbalanced != 0 {
            return Err(AppError::Validation(
                "L'historique cumulatif à clôturer contient des écritures déséquilibrées.".into(),
            ));
        }
        // The balance sheet produced for the closing date is cumulative. Refuse the close if any
        // historical journal line up to that date uses another currency, otherwise the period
        // could be marked closed while its statutory balance sheet remains impossible to render.
        crate::accounting_closure::ensure_base_currency_for_ranges(
            &tx,
            &[("0001-01-01", date_to)],
        )?;
        crate::vat_reporting::ensure_vat_sources_classified_through(&tx, date_to)?;
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
            "SELECT EXISTS(SELECT 1 FROM accounting_settings WHERE enabled=1 OR ar_account_id IS NOT NULL OR revenue_account_id IS NOT NULL OR vat_payable_account_id IS NOT NULL OR vat_deferred_payable_account_id IS NOT NULL OR bank_account_id IS NOT NULL OR expense_account_id IS NOT NULL OR vat_receivable_account_id IS NOT NULL OR wages_expense_account_id IS NOT NULL OR wages_payable_account_id IS NOT NULL OR social_expense_account_id IS NOT NULL OR social_payable_account_id IS NOT NULL OR supplier_payable_account_id IS NOT NULL)",
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
            (
                "2201",
                "TVA à régulariser",
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
            "INSERT INTO accounting_settings(id,enabled,ar_account_id,revenue_account_id,vat_payable_account_id,vat_deferred_payable_account_id,bank_account_id,expense_account_id,vat_receivable_account_id,wages_expense_account_id,wages_payable_account_id,social_expense_account_id,social_payable_account_id,supplier_payable_account_id,created_at,updated_at) VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=1,ar_account_id=excluded.ar_account_id,revenue_account_id=excluded.revenue_account_id,vat_payable_account_id=excluded.vat_payable_account_id,vat_deferred_payable_account_id=excluded.vat_deferred_payable_account_id,bank_account_id=excluded.bank_account_id,expense_account_id=excluded.expense_account_id,vat_receivable_account_id=excluded.vat_receivable_account_id,wages_expense_account_id=excluded.wages_expense_account_id,wages_payable_account_id=excluded.wages_payable_account_id,social_expense_account_id=excluded.social_expense_account_id,social_payable_account_id=excluded.social_payable_account_id,supplier_payable_account_id=excluded.supplier_payable_account_id,updated_at=excluded.updated_at",
            params![
                account_ids[0],account_ids[1],account_ids[2],account_ids[3],account_ids[4],
                account_ids[5],account_ids[6],account_ids[7],account_ids[8],account_ids[9],account_ids[10],account_ids[11],now,now
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
        let received_vat_mapping_required: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM vat_profiles WHERE form_of_reporting='received')",
            [],
            |row| row.get(0),
        )?;
        let mut ids = vec![
            input.ar_account_id.as_deref(),
            input.revenue_account_id.as_deref(),
            input.vat_payable_account_id.as_deref(),
            input.bank_account_id.as_deref(),
            input.expense_account_id.as_deref(),
            input.vat_receivable_account_id.as_deref(),
            effective_supplier_payable.as_deref(),
        ];
        if received_vat_mapping_required {
            ids.push(input.vat_deferred_payable_account_id.as_deref());
        }
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
                if received_vat_mapping_required {
                    "Les douze comptes de liaison, dont la TVA à régulariser exigée par le mode reçu, doivent être explicitement sélectionnés avant d'activer la comptabilité.".into()
                } else {
                    "Les onze comptes de liaison doivent être explicitement sélectionnés avant d'activer la comptabilité.".into()
                }
            } else if received_vat_mapping_required {
                "Les huit comptes de liaison hors paie, dont la TVA à régulariser exigée par le mode reçu, doivent être explicitement sélectionnés avant d'activer la comptabilité.".into()
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
            if let Some(deferred_account_id) = input
                .vat_deferred_payable_account_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                let (actual, active): (String, bool) = tx.query_row(
                    "SELECT account_type,active FROM accounts WHERE id=?",
                    params![deferred_account_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                if actual != "liability" || !active {
                    return Err(AppError::Validation(
                        "vat_deferred_payable_account_id doit référencer un compte de passif actif."
                            .into(),
                    ));
                }
                if input.vat_payable_account_id.as_deref() == Some(deferred_account_id) {
                    return Err(AppError::Validation(
                        "Les liaisons « TVA due » et « TVA à régulariser » doivent utiliser deux comptes distincts."
                            .into(),
                    ));
                }
            }
            validate_core_mapping_role_separation(
                input.ar_account_id.as_deref(),
                input.bank_account_id.as_deref(),
                input.vat_receivable_account_id.as_deref(),
            )?;
            if received_vat_mapping_required {
                let incompatible_history: i64 = tx.query_row(
                    "SELECT COUNT(*)
                       FROM invoices invoice
                       JOIN vat_profiles profile ON profile.form_of_reporting='received' AND profile.effective_from<=invoice.issue_date AND COALESCE(profile.effective_to,'9999-12-31')>=invoice.issue_date
                       JOIN journal_entries entry ON entry.source_type='invoice' AND entry.source_id=invoice.id AND entry.source_event='issue' AND entry.reversal_of IS NULL
                      WHERE invoice.type<>'avoir' AND invoice.vat_cents<>0
                        AND NOT EXISTS(SELECT 1 FROM journal_lines line WHERE line.journal_entry_id=entry.id AND line.memo=?)",
                    params![VAT_DEFERRED_MEMO],
                    |row| row.get(0),
                )?;
                if incompatible_history != 0 {
                    return Err(AppError::Validation(format!(
                        "La comptabilité contient {incompatible_history} facture(s) d'une période en mode reçu dont la TVA a déjà été portée au compte TVA due à l'émission. La nouvelle liaison ne peut pas réécrire cet historique immuable; régularisez-le avec votre fiduciaire avant de poursuivre."
                    )));
                }
            }
        }
        let now = now_iso();
        tx.execute(
            "INSERT INTO accounting_settings(id,enabled,ar_account_id,revenue_account_id,vat_payable_account_id,vat_deferred_payable_account_id,bank_account_id,expense_account_id,vat_receivable_account_id,wages_expense_account_id,wages_payable_account_id,social_expense_account_id,social_payable_account_id,supplier_payable_account_id,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,ar_account_id=excluded.ar_account_id,revenue_account_id=excluded.revenue_account_id,vat_payable_account_id=excluded.vat_payable_account_id,vat_deferred_payable_account_id=excluded.vat_deferred_payable_account_id,bank_account_id=excluded.bank_account_id,expense_account_id=excluded.expense_account_id,vat_receivable_account_id=excluded.vat_receivable_account_id,wages_expense_account_id=excluded.wages_expense_account_id,wages_payable_account_id=excluded.wages_payable_account_id,social_expense_account_id=excluded.social_expense_account_id,social_payable_account_id=excluded.social_payable_account_id,supplier_payable_account_id=excluded.supplier_payable_account_id,updated_at=excluded.updated_at",
            params![input.enabled as i64,input.ar_account_id,input.revenue_account_id,input.vat_payable_account_id,input.vat_deferred_payable_account_id,input.bank_account_id,input.expense_account_id,input.vat_receivable_account_id,input.wages_expense_account_id,input.wages_payable_account_id,input.social_expense_account_id,input.social_payable_account_id,effective_supplier_payable,now,now],
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

    #[cfg(test)]
    pub fn post_manual_journal_entry(&self, input: ManualJournalInput) -> AppResult<Value> {
        self.post_manual_journal_entry_with_request_id(input, &Uuid::new_v4().to_string())
    }

    pub fn post_manual_journal_entry_with_request_id(
        &self,
        input: ManualJournalInput,
        request_id: &str,
    ) -> AppResult<Value> {
        let request_id = Uuid::parse_str(request_id.trim())
            .map(|value| value.to_string())
            .map_err(|_| AppError::Validation("request_id doit être un UUID valide.".into()))?;
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
        let replay: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM journal_entries WHERE source_type='manual' AND source_id=? AND source_event='posted')",
            params![request_id],
            |row| row.get(0),
        )?;
        let result = post_entry(
            &tx,
            &input.entry_date,
            &description,
            "manual",
            &request_id,
            "posted",
            lines,
        )?;
        if !replay {
            append_audit(
                &tx,
                "post",
                "journal_entry",
                result["id"].as_str().unwrap_or(""),
                &result,
            )?;
        }
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
        let rows = query_all(
            &tx,
            "SELECT * FROM journal_lines WHERE journal_entry_id=? ORDER BY rowid",
            params![id],
        )?;
        let lines: Vec<EntryLine> = rows
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

        // Un appel peut avoir été validé puis sa réponse perdue. Rejouer
        // d'abord l'opération idempotente exacte permet à la validation
        // centralisée de comparer date, libellé, parent et lignes avant que le
        // garde métier n'interprète la chaîne désormais paire comme un nouvel
        // essai d'extourne.
        let exact_reversal_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM journal_entries WHERE source_type='journal_reversal' AND source_id=? AND source_event='reverse')",
            params![id],
            |row| row.get(0),
        )?;
        if exact_reversal_exists {
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
            tx.commit()?;
            return Ok(result);
        }
        let protected_business_source: Option<(String, String, String, i64)> = tx
            .query_row(
                "WITH RECURSIVE ancestry(id,source_type,source_id,reversal_of,depth) AS (
                   SELECT id,source_type,source_id,reversal_of,0
                   FROM journal_entries WHERE id=?
                   UNION ALL
                   SELECT parent.id,parent.source_type,parent.source_id,parent.reversal_of,ancestry.depth+1
                   FROM ancestry
                   JOIN journal_entries parent ON parent.id=ancestry.reversal_of
                 )
                 SELECT source_type,source_id,id,depth FROM ancestry
                 WHERE source_type IN ('payment','vat_cash_reclassification','invoice','supplier_invoice','supplier_payment')
                 ORDER BY depth DESC LIMIT 1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((source_type, business_source_id, root_entry_id, selected_depth)) =
            protected_business_source
        {
            // Avant ce garde, une ancienne version pouvait laisser une écriture
            // métier inactive en extournant sa racine. On autorise uniquement
            // l'extourne de la dernière compensation d'une chaîne linéaire et
            // impaire : cette opération rétablit l'effet attendu. Toute action
            // qui rendrait une racine active inactive reste bloquée.
            let restorative_legacy_reversal =
                if matches!(source_type.as_str(), "payment" | "invoice") {
                    let (max_depth, entry_count): (i64, i64) = tx.query_row(
                        "WITH RECURSIVE reversal_chain(id,depth) AS (
                       SELECT ?1,0
                       UNION ALL
                       SELECT child.id,reversal_chain.depth+1
                       FROM reversal_chain
                       JOIN journal_entries child ON child.reversal_of=reversal_chain.id
                     )
                     SELECT COALESCE(MAX(depth),0),COUNT(*) FROM reversal_chain",
                        params![root_entry_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?;
                    max_depth % 2 == 1
                        && selected_depth == max_depth
                        && entry_count == max_depth + 1
                } else {
                    false
                };
            if matches!(
                source_type.as_str(),
                "payment" | "vat_cash_reclassification"
            ) && !restorative_legacy_reversal
            {
                return Err(AppError::Validation(
                    "Une écriture liée à un encaissement client ne peut pas être extournée isolément, y compris sa reclassification de TVA. Le paiement, le solde, la TVA et le rapprochement bancaire doivent rester cohérents. Utilisez un flux métier de remboursement ou d'avoir validé avec votre fiduciaire."
                        .into(),
                ));
            }
            if source_type == "invoice" {
                let has_payment: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM payments WHERE invoice_id=?)",
                    params![business_source_id],
                    |row| row.get(0),
                )?;
                if has_payment && !restorative_legacy_reversal {
                    return Err(AppError::Validation(
                        "L'écriture d'une facture encaissée ne peut pas être extournée isolément. Le paiement, le solde et le statut de la facture ainsi que le rapprochement bancaire doivent rester cohérents. Utilisez un flux métier de remboursement ou d'avoir validé avec votre fiduciaire."
                            .into(),
                    ));
                }
            } else if source_type != "payment" {
                return Err(AppError::Validation(
                    "Une écriture fournisseur ne peut pas être extournée isolément. Utilisez le futur flux d’avoir ou de remboursement afin que le document, la dette et le journal restent cohérents."
                        .into(),
                ));
            }
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
        let (date_from, date_to) = report_bounds(&filter)?;
        let report_currency = crate::accounting_closure::ensure_base_currency_for_ranges(
            &connection,
            &[(&date_from, &date_to)],
        )?;
        let (where_sql, values) = period_clause(&filter, "je.entry_date")?;
        let entries = query_all(
            &connection,
            &format!("SELECT je.*,EXISTS(SELECT 1 FROM journal_entries reversal WHERE reversal.reversal_of=je.id) AS has_reversal FROM journal_entries je {where_sql} ORDER BY je.entry_date,je.number"),
            params_from_iter(values),
        )?;
        let lines = query_all(&connection,&format!("SELECT jl.*,a.code AS account_code,a.name AS account_name,je.number AS entry_number,je.entry_date FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id JOIN journal_entries je ON je.id=jl.journal_entry_id {} ORDER BY je.entry_date,je.number,jl.rowid", period_join_clause(&filter,"je.entry_date")?.0),params_from_iter(period_join_clause(&filter,"je.entry_date")?.1))?;
        Ok(json!({"entries":entries,"lines":lines,"currency":report_currency}))
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
        let (_, date_to) = report_bounds(&filter)?;
        let report_currency = crate::accounting_closure::ensure_base_currency_for_ranges(
            &connection,
            &[("0001-01-01", &date_to)],
        )?;
        let (opening_debit_cents, opening_credit_cents): (i64, i64) = if let Some(date_from) =
            filter.date_from.as_deref()
        {
            connection.query_row(
                    "SELECT COALESCE(SUM(jl.debit_cents),0),COALESCE(SUM(jl.credit_cents),0) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=? AND je.entry_date<?",
                    params![input.account_id, date_from],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?
        } else {
            (0, 0)
        };
        let opening_net_debit_cents = opening_debit_cents - opening_credit_cents;
        let (extra, mut values) = period_and_clause(&filter, "je.entry_date")?;
        values.insert(0, SqlValue::Text(input.account_id));
        let mut lines=query_all(&connection,&format!("SELECT jl.*,je.number AS entry_number,je.entry_date,je.description FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=? {extra} ORDER BY je.entry_date,je.number,jl.rowid"),params_from_iter(values))?;
        let mut running_net_debit_cents = opening_net_debit_cents;
        for line in &mut lines {
            running_net_debit_cents += line["debit_cents"].as_i64().unwrap_or(0)
                - line["credit_cents"].as_i64().unwrap_or(0);
            line["running_net_debit_cents"] = json!(running_net_debit_cents);
            line["running_debit_balance_cents"] = json!(running_net_debit_cents.max(0));
            line["running_credit_balance_cents"] = json!((-running_net_debit_cents).max(0));
        }
        let debit: i64 = lines.iter().filter_map(|v| v["debit_cents"].as_i64()).sum();
        let credit: i64 = lines
            .iter()
            .filter_map(|v| v["credit_cents"].as_i64())
            .sum();
        let movement_net_debit_cents = debit - credit;
        let closing_net_debit_cents = opening_net_debit_cents + movement_net_debit_cents;
        Ok(json!({
            "account":account,
            "lines":lines,
            "currency":report_currency,
            "opening_debit_cents":opening_debit_cents,
            "opening_credit_cents":opening_credit_cents,
            "opening_debit_balance_cents":opening_net_debit_cents.max(0),
            "opening_credit_balance_cents":(-opening_net_debit_cents).max(0),
            "opening_net_debit_cents":opening_net_debit_cents,
            "debit_cents":debit,
            "credit_cents":credit,
            "movement_net_debit_cents":movement_net_debit_cents,
            "net_debit_cents":closing_net_debit_cents,
            "closing_debit_balance_cents":closing_net_debit_cents.max(0),
            "closing_credit_balance_cents":(-closing_net_debit_cents).max(0),
            "closing_net_debit_cents":closing_net_debit_cents,
        }))
    }

    pub fn get_trial_balance(&self, filter: PeriodFilter) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let (date_from, date_to) = report_bounds(&filter)?;
        let report_currency = crate::accounting_closure::ensure_base_currency_for_ranges(
            &connection,
            &[("0001-01-01", &date_to)],
        )?;
        let mut rows=query_all(
            &connection,
            "SELECT a.id,a.code,a.name,a.account_type,a.normal_balance,a.report_section,
                    COALESCE(SUM(CASE WHEN je.entry_date<? THEN jl.debit_cents ELSE 0 END),0) AS opening_debit_cents,
                    COALESCE(SUM(CASE WHEN je.entry_date<? THEN jl.credit_cents ELSE 0 END),0) AS opening_credit_cents,
                    COALESCE(SUM(CASE WHEN je.entry_date BETWEEN ? AND ? THEN jl.debit_cents ELSE 0 END),0) AS debit_cents,
                    COALESCE(SUM(CASE WHEN je.entry_date BETWEEN ? AND ? THEN jl.credit_cents ELSE 0 END),0) AS credit_cents
             FROM accounts a
             LEFT JOIN journal_lines jl ON jl.account_id=a.id
             LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id
             GROUP BY a.id ORDER BY a.code",
            params![date_from,date_from,date_from,date_to,date_from,date_to],
        )?;
        let mut opening_debit_balance_cents = 0i64;
        let mut opening_credit_balance_cents = 0i64;
        let mut closing_debit_balance_cents = 0i64;
        let mut closing_credit_balance_cents = 0i64;
        for row in &mut rows {
            let opening_net_debit_cents = row["opening_debit_cents"].as_i64().unwrap_or(0)
                - row["opening_credit_cents"].as_i64().unwrap_or(0);
            let closing_net_debit_cents = opening_net_debit_cents
                + row["debit_cents"].as_i64().unwrap_or(0)
                - row["credit_cents"].as_i64().unwrap_or(0);
            let opening_debit = opening_net_debit_cents.max(0);
            let opening_credit = (-opening_net_debit_cents).max(0);
            let closing_debit = closing_net_debit_cents.max(0);
            let closing_credit = (-closing_net_debit_cents).max(0);
            row["opening_net_debit_cents"] = json!(opening_net_debit_cents);
            row["opening_debit_balance_cents"] = json!(opening_debit);
            row["opening_credit_balance_cents"] = json!(opening_credit);
            row["debit_balance_cents"] = json!(closing_debit);
            row["credit_balance_cents"] = json!(closing_credit);
            row["closing_net_debit_cents"] = json!(closing_net_debit_cents);
            opening_debit_balance_cents += opening_debit;
            opening_credit_balance_cents += opening_credit;
            closing_debit_balance_cents += closing_debit;
            closing_credit_balance_cents += closing_credit;
        }
        rows.retain(|row| {
            row["opening_debit_cents"].as_i64().unwrap_or(0) != 0
                || row["opening_credit_cents"].as_i64().unwrap_or(0) != 0
                || row["debit_cents"].as_i64().unwrap_or(0) != 0
                || row["credit_cents"].as_i64().unwrap_or(0) != 0
        });
        let debit: i64 = rows.iter().filter_map(|v| v["debit_cents"].as_i64()).sum();
        let credit: i64 = rows.iter().filter_map(|v| v["credit_cents"].as_i64()).sum();
        Ok(json!({
            "rows":rows,
            "currency":report_currency,
            "opening_debit_balance_cents":opening_debit_balance_cents,
            "opening_credit_balance_cents":opening_credit_balance_cents,
            "debit_cents":debit,
            "credit_cents":credit,
            "closing_debit_balance_cents":closing_debit_balance_cents,
            "closing_credit_balance_cents":closing_credit_balance_cents,
            "balanced":debit==credit
                && opening_debit_balance_cents==opening_credit_balance_cents
                && closing_debit_balance_cents==closing_credit_balance_cents,
        }))
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

#[derive(Debug)]
struct PaymentAccountingState {
    invoice_id: String,
    invoice_type: String,
    invoice_status: String,
    invoice_number: Option<String>,
    issue_date: Option<String>,
    total_cents: i64,
    stored_paid_cents: i64,
}

fn canonical_accounting_date(value: &str) -> bool {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == value)
}

/// Explique pourquoi une ligne de paiement historique ne peut pas devenir une
/// écriture. Le contrôle porte sur toute la chaîne de règlement de la facture,
/// car une ligne négative ou un avoir mal signé fausserait aussi le solde des
/// autres encaissements.
pub(crate) fn payment_accounting_block_reason(
    connection: &Connection,
    payment_id: &str,
) -> AppResult<Option<String>> {
    let linked_invoice_id = connection
        .query_row(
            "SELECT invoice_id FROM payments WHERE id=?",
            params![payment_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("payments/{payment_id}")))?;
    let state = connection
        .query_row(
            "SELECT invoice.id,invoice.type,invoice.status,invoice.number,invoice.issue_date,invoice.total_cents,invoice.paid_cents
               FROM payments payment JOIN invoices invoice ON invoice.id=payment.invoice_id
              WHERE payment.id=?",
            params![payment_id],
            |row| {
                Ok(PaymentAccountingState {
                    invoice_id: row.get(0)?,
                    invoice_type: row.get(1)?,
                    invoice_status: row.get(2)?,
                    invoice_number: row.get(3)?,
                    issue_date: row.get(4)?,
                    total_cents: row.get(5)?,
                    stored_paid_cents: row.get(6)?,
                })
            },
        )
        .optional()?;
    let Some(state) = state else {
        return Ok(Some(format!(
            "la facture liée {linked_invoice_id} est introuvable"
        )));
    };
    if state.invoice_type == "avoir" {
        return Ok(Some("un avoir ne peut recevoir aucun encaissement".into()));
    }
    if !matches!(
        state.invoice_status.as_str(),
        "emise" | "en_retard" | "partiellement_payee" | "payee"
    ) {
        return Ok(Some(
            "la facture liée n'est pas une facture émise et active".into(),
        ));
    }
    if state
        .invoice_number
        .as_deref()
        .is_none_or(|number| number.trim().is_empty())
    {
        return Ok(Some("la facture liée n'a pas de numéro d'émission".into()));
    }
    let Some(issue_date) = state.issue_date.as_deref() else {
        return Ok(Some("la facture liée n'a pas de date d'émission".into()));
    };
    if !canonical_accounting_date(issue_date) {
        return Ok(Some(
            "la date d'émission de la facture n'est pas canonique".into(),
        ));
    }
    if state.total_cents <= 0 {
        return Ok(Some("la facture liée n'a aucun montant payable".into()));
    }

    let payments = {
        let mut statement = connection.prepare(
            "SELECT id,date,amount_cents FROM payments WHERE invoice_id=? ORDER BY date,created_at,id",
        )?;
        let rows = statement
            .query_map(params![state.invoice_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut paid_cents = 0_i64;
    for (related_id, date, amount_cents) in &payments {
        if *amount_cents <= 0 {
            return Ok(Some(format!(
                "le paiement lié {related_id} possède un montant nul ou négatif"
            )));
        }
        if !canonical_accounting_date(date) {
            return Ok(Some(format!(
                "le paiement lié {related_id} possède une date non canonique"
            )));
        }
        if date.as_str() < issue_date {
            return Ok(Some(format!(
                "le paiement lié {related_id} précède la date d'émission de la facture"
            )));
        }
        let Some(total) = paid_cents.checked_add(*amount_cents) else {
            return Ok(Some(
                "le cumul des paiements dépasse la capacité monétaire locale".into(),
            ));
        };
        paid_cents = total;
    }
    if state.stored_paid_cents != paid_cents {
        return Ok(Some(format!(
            "le total encaissé mémorisé ({}) ne correspond pas aux paiements ({paid_cents})",
            state.stored_paid_cents
        )));
    }

    let credits = {
        let mut statement = connection.prepare(
            "SELECT id,total_cents,issue_date FROM invoices WHERE type='avoir' AND original_invoice_id=? AND number IS NOT NULL AND status<>'annulee' ORDER BY issue_date,created_at,id",
        )?;
        let rows = statement
            .query_map(params![state.invoice_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut validated_credits = Vec::with_capacity(credits.len());
    for (credit_id, total_cents, credit_date) in credits {
        let Some(credit_amount) = total_cents.checked_neg().filter(|value| *value > 0) else {
            return Ok(Some(format!(
                "l'avoir lié {credit_id} ne possède pas un montant créditeur valide"
            )));
        };
        let Some(credit_date) = credit_date else {
            return Ok(Some(format!(
                "l'avoir lié {credit_id} n'a pas de date d'émission"
            )));
        };
        if !canonical_accounting_date(&credit_date) {
            return Ok(Some(format!(
                "l'avoir lié {credit_id} possède une date non canonique"
            )));
        }
        validated_credits.push((credit_id, credit_date, credit_amount));
    }
    let mut running_paid = 0_i64;
    for (related_id, payment_date, amount_cents) in payments {
        running_paid = running_paid.checked_add(amount_cents).ok_or_else(|| {
            AppError::Validation(
                "Le cumul des paiements dépasse la capacité monétaire locale.".into(),
            )
        })?;
        let credited_at_payment = validated_credits
            .iter()
            .filter(|(_, credit_date, _)| credit_date <= &payment_date)
            .try_fold(0_i64, |total, (_, _, amount)| total.checked_add(*amount));
        if credited_at_payment
            .and_then(|credited| running_paid.checked_add(credited))
            .is_none_or(|settled| settled > state.total_cents)
        {
            return Ok(Some(format!(
                "le paiement lié {related_id} dépasse le solde ouvert à sa date"
            )));
        }
    }
    Ok(None)
}

pub(crate) fn validate_payment_for_accounting(
    connection: &Connection,
    payment_id: &str,
) -> AppResult<()> {
    if let Some(reason) = payment_accounting_block_reason(connection, payment_id)? {
        return Err(AppError::Validation(format!(
            "Le paiement {payment_id} est bloqué : {reason}."
        )));
    }
    Ok(())
}

fn blocked_unposted_payments(
    connection: &Connection,
    backfill_candidates_only: bool,
) -> AppResult<Vec<Value>> {
    let ids = {
        let mut statement = connection.prepare(
            "SELECT payment.id,payment.invoice_id
               FROM payments payment LEFT JOIN invoices invoice ON invoice.id=payment.invoice_id
              WHERE NOT EXISTS(
                      SELECT 1 FROM journal_entries entry
                       WHERE entry.source_type='payment' AND entry.source_id=payment.id
                    )
                AND (?=0 OR (
                      COALESCE(invoice.status,'')<>'annulee'
                      AND NOT EXISTS(
                        SELECT 1 FROM accounting_periods period
                         WHERE period.status='closed' AND payment.date BETWEEN period.date_from AND period.date_to
                      )
                    ))
              ORDER BY payment.date,payment.created_at,payment.id",
        )?;
        let rows = statement
            .query_map(params![i64::from(backfill_candidates_only)], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut blocked = Vec::new();
    for (payment_id, invoice_id) in ids {
        if let Some(reason) = payment_accounting_block_reason(connection, &payment_id)? {
            blocked.push(json!({
                "id": payment_id,
                "invoice_id": invoice_id,
                "reason": reason,
            }));
        }
    }
    Ok(blocked)
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
    let blocked_payments = blocked_unposted_payments(connection, false)?;
    let payroll_mappings_required = payroll_accounting_mappings_required(connection)?;
    let mapping_ready_sql = if payroll_mappings_required {
        "SELECT EXISTS(SELECT 1 FROM accounting_settings s
            JOIN accounts ar ON ar.id=s.ar_account_id AND ar.active=1 AND ar.account_type='asset'
            JOIN accounts rev ON rev.id=s.revenue_account_id AND rev.active=1 AND rev.account_type='revenue'
            JOIN accounts vatp ON vatp.id=s.vat_payable_account_id AND vatp.active=1 AND vatp.account_type='liability'
            LEFT JOIN accounts vatd ON vatd.id=s.vat_deferred_payable_account_id AND vatd.active=1 AND vatd.account_type='liability'
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
              AND s.ar_account_id<>s.vat_receivable_account_id
              AND (NOT EXISTS(SELECT 1 FROM vat_profiles WHERE form_of_reporting='received')
                   OR (vatd.id IS NOT NULL AND s.vat_deferred_payable_account_id<>s.vat_payable_account_id)))"
    } else {
        "SELECT EXISTS(SELECT 1 FROM accounting_settings s
            JOIN accounts ar ON ar.id=s.ar_account_id AND ar.active=1 AND ar.account_type='asset'
            JOIN accounts rev ON rev.id=s.revenue_account_id AND rev.active=1 AND rev.account_type='revenue'
            JOIN accounts vatp ON vatp.id=s.vat_payable_account_id AND vatp.active=1 AND vatp.account_type='liability'
            LEFT JOIN accounts vatd ON vatd.id=s.vat_deferred_payable_account_id AND vatd.active=1 AND vatd.account_type='liability'
            JOIN accounts bank ON bank.id=s.bank_account_id AND bank.active=1 AND bank.account_type='asset'
            JOIN accounts expense ON expense.id=s.expense_account_id AND expense.active=1 AND expense.account_type='expense'
            JOIN accounts vatr ON vatr.id=s.vat_receivable_account_id AND vatr.active=1 AND vatr.account_type='asset'
            JOIN accounts supplier_payable ON supplier_payable.id=s.supplier_payable_account_id AND supplier_payable.active=1 AND supplier_payable.account_type='liability'
            WHERE s.id=1 AND s.enabled=1
              AND s.bank_account_id<>s.ar_account_id
              AND s.bank_account_id<>s.vat_receivable_account_id
              AND s.ar_account_id<>s.vat_receivable_account_id
              AND (NOT EXISTS(SELECT 1 FROM vat_profiles WHERE form_of_reporting='received')
                   OR (vatd.id IS NOT NULL AND s.vat_deferred_payable_account_id<>s.vat_payable_account_id)))"
    };
    let mapping_ready: bool = connection.query_row(mapping_ready_sql, [], |row| row.get(0))?;
    let configured_mappings: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM accounting_settings WHERE enabled=1 OR ar_account_id IS NOT NULL OR revenue_account_id IS NOT NULL OR vat_payable_account_id IS NOT NULL OR vat_deferred_payable_account_id IS NOT NULL OR bank_account_id IS NOT NULL OR expense_account_id IS NOT NULL OR vat_receivable_account_id IS NOT NULL OR wages_expense_account_id IS NOT NULL OR wages_payable_account_id IS NOT NULL OR social_expense_account_id IS NOT NULL OR social_payable_account_id IS NOT NULL OR supplier_payable_account_id IS NOT NULL)",
        [],
        |row| row.get(0),
    )?;
    let reversed_sources: i64 = connection.query_row(
        "WITH RECURSIVE chain(root_id,source_type,source_id,id,depth) AS (
            SELECT id,source_type,source_id,id,0 FROM journal_entries WHERE source_type IN('invoice','payment','vat_cash_reclassification','expense','payslip','supplier_invoice','supplier_payment')
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
        "blocked_payment_count": blocked_payments.len(),
        "blocked_payments": blocked_payments,
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
    let blocked_payments = blocked_unposted_payments(tx, true)?;
    if !blocked_payments.is_empty() {
        let summary = blocked_payments
            .iter()
            .take(5)
            .map(|payment| {
                format!(
                    "{}: {}",
                    payment["id"].as_str().unwrap_or("paiement inconnu"),
                    payment["reason"].as_str().unwrap_or("donnée invalide")
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(AppError::Validation(format!(
            "La synchronisation comptable est bloquée par {} paiement(s) historique(s) invalide(s) ({summary}). Aucun journal n'a été créé; corrigez ces données avant de relancer.",
            blocked_payments.len()
        )));
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

pub(crate) fn validate_received_vat_accounting_configuration(
    connection: &Connection,
    effective_from: &str,
    effective_to: Option<&str>,
) -> AppResult<()> {
    let mapping: Option<(Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT vat_payable_account_id,vat_deferred_payable_account_id FROM accounting_settings WHERE id=1 AND enabled=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((vat_payable, vat_deferred)) = mapping else {
        return Ok(());
    };
    let vat_payable = vat_payable.filter(|value| !value.trim().is_empty());
    let vat_deferred = vat_deferred.filter(|value| !value.trim().is_empty());
    let valid_mapping = vat_payable
        .as_deref()
        .zip(vat_deferred.as_deref())
        .is_some_and(|(due, deferred)| {
            due != deferred
                && connection
                    .query_row(
                        "SELECT COUNT(*)=2 FROM accounts WHERE id IN (?,?) AND active=1 AND account_type='liability'",
                        params![due, deferred],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap_or(false)
        });
    if !valid_mapping {
        return Err(AppError::Validation(
            "Le mode « contre-prestations reçues » exige deux comptes de passif actifs et distincts : « TVA due » et « TVA à régulariser ». Configurez-les dans Comptabilité > Plan & liaisons avant d'activer ce profil TVA."
                .into(),
        ));
    }
    let incompatible_history: i64 = connection.query_row(
        "SELECT COUNT(*)
           FROM invoices invoice
           JOIN journal_entries entry ON entry.source_type='invoice' AND entry.source_id=invoice.id AND entry.source_event='issue' AND entry.reversal_of IS NULL
          WHERE invoice.type<>'avoir' AND invoice.vat_cents<>0
            AND invoice.issue_date>=? AND (? IS NULL OR invoice.issue_date<=?)
            AND NOT EXISTS(
              SELECT 1 FROM journal_lines line
               WHERE line.journal_entry_id=entry.id AND line.memo=?
            )",
        params![effective_from, effective_to, effective_to, VAT_DEFERRED_MEMO],
        |row| row.get(0),
    )?;
    if incompatible_history != 0 {
        return Err(AppError::Validation(format!(
            "Le profil reçu est rétroactif sur {incompatible_history} facture(s) déjà comptabilisée(s) avec TVA due à l'émission. Zentra bloque cette activation : extournez et régularisez l'historique avec votre fiduciaire, ou choisissez une date d'effet future."
        )));
    }
    Ok(())
}

fn invoice_uses_received_vat(tx: &Transaction<'_>, issue_date: &str) -> AppResult<bool> {
    Ok(tx
        .query_row(
            "SELECT form_of_reporting FROM vat_profiles WHERE effective_from<=? AND COALESCE(effective_to,'9999-12-31')>=? ORDER BY effective_from DESC LIMIT 1",
            params![issue_date, issue_date],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .is_some_and(|basis| basis == "received"))
}

#[derive(Debug)]
struct CashVatState {
    deferred_account: String,
    invoice_total_cents: i64,
    invoice_vat_cents: i64,
    released_cents: i64,
    credit_deferred_cents: i64,
    due_by_account: BTreeMap<String, i64>,
}

impl CashVatState {
    fn deferred_remaining(&self) -> AppResult<i64> {
        self.invoice_vat_cents
            .checked_sub(self.released_cents)
            .and_then(|value| value.checked_sub(self.credit_deferred_cents))
            .filter(|value| *value >= 0)
            .ok_or_else(|| {
                AppError::Validation(
                    "La ventilation historique de TVA reçue dépasse la TVA différée de la facture; l'opération est bloquée."
                        .into(),
                )
            })
    }
}

fn cash_vat_state(tx: &Transaction<'_>, invoice_id: &str) -> AppResult<Option<CashVatState>> {
    let Some(deferred_account) =
        posted_invoice_account(tx, invoice_id, VAT_DEFERRED_MEMO, "liability")?
    else {
        return Ok(None);
    };
    let (invoice_total_cents, invoice_vat_cents): (i64, i64) = tx.query_row(
        "SELECT total_cents,vat_cents FROM invoices WHERE id=? AND type<>'avoir'",
        params![invoice_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if invoice_total_cents <= 0 || invoice_vat_cents <= 0 {
        return Err(AppError::Validation(
            "La facture en mode reçu ne possède pas une base TVA positive cohérente.".into(),
        ));
    }
    let released_cents: i64 = tx.query_row(
        "SELECT COALESCE(SUM(line.debit_cents),0)
           FROM journal_entries entry
           JOIN payments payment ON payment.id=entry.source_id AND entry.source_type='vat_cash_reclassification'
           JOIN journal_lines line ON line.journal_entry_id=entry.id AND line.memo=?
          WHERE entry.reversal_of IS NULL AND payment.invoice_id=?",
        params![VAT_CASH_RELEASE_MEMO, invoice_id],
        |row| row.get(0),
    )?;
    let credit_deferred_cents: i64 = tx.query_row(
        "SELECT COALESCE(SUM(line.debit_cents),0)
           FROM invoices credit
           JOIN journal_entries entry ON entry.source_type='invoice' AND entry.source_id=credit.id AND entry.source_event='issue' AND entry.reversal_of IS NULL
           JOIN journal_lines line ON line.journal_entry_id=entry.id AND line.memo=?
          WHERE credit.type='avoir' AND credit.original_invoice_id=? AND credit.number IS NOT NULL AND credit.status<>'annulee'",
        params![VAT_CREDIT_DEFERRED_MEMO, invoice_id],
        |row| row.get(0),
    )?;
    let mut due_by_account = BTreeMap::new();
    {
        let mut statement = tx.prepare(
            "SELECT line.account_id,COALESCE(SUM(line.credit_cents),0)
               FROM journal_entries entry
               JOIN payments payment ON payment.id=entry.source_id AND entry.source_type='vat_cash_reclassification'
               JOIN journal_lines line ON line.journal_entry_id=entry.id AND line.memo=?
              WHERE entry.reversal_of IS NULL AND payment.invoice_id=?
              GROUP BY line.account_id ORDER BY line.account_id",
        )?;
        let rows = statement.query_map(params![VAT_CASH_DUE_MEMO, invoice_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (account_id, amount) = row?;
            due_by_account.insert(account_id, amount);
        }
    }
    {
        let mut statement = tx.prepare(
            "SELECT line.account_id,COALESCE(SUM(line.debit_cents),0)
               FROM invoices credit
               JOIN journal_entries entry ON entry.source_type='invoice' AND entry.source_id=credit.id AND entry.source_event='issue' AND entry.reversal_of IS NULL
               JOIN journal_lines line ON line.journal_entry_id=entry.id AND line.memo=?
              WHERE credit.type='avoir' AND credit.original_invoice_id=? AND credit.number IS NOT NULL AND credit.status<>'annulee'
              GROUP BY line.account_id ORDER BY line.account_id",
        )?;
        let rows = statement.query_map(params![VAT_CREDIT_DUE_MEMO, invoice_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (account_id, amount) = row?;
            let remaining = due_by_account
                .get(&account_id)
                .copied()
                .unwrap_or(0)
                .checked_sub(amount)
                .filter(|value| *value >= 0)
                .ok_or_else(|| {
                    AppError::Validation(
                        "Un avoir historique extourne davantage de TVA due que les encaissements liés; l'opération est bloquée."
                            .into(),
                    )
                })?;
            due_by_account.insert(account_id, remaining);
        }
    }
    due_by_account.retain(|_, amount| *amount > 0);
    let state = CashVatState {
        deferred_account,
        invoice_total_cents,
        invoice_vat_cents,
        released_cents,
        credit_deferred_cents,
        due_by_account,
    };
    state.deferred_remaining()?;
    Ok(Some(state))
}

fn rounded_proportion(amount: i64, numerator: i64, denominator: i64) -> AppResult<i64> {
    if amount < 0 || numerator < 0 || denominator <= 0 || numerator > denominator {
        return Err(AppError::Validation(
            "La proportion de TVA reçue est incohérente; l'opération est bloquée.".into(),
        ));
    }
    let product = i128::from(amount)
        .checked_mul(i128::from(numerator))
        .ok_or_else(|| AppError::Validation("Calcul proportionnel de TVA hors capacité.".into()))?;
    let rounded = product
        .checked_add(i128::from(denominator / 2))
        .and_then(|value| value.checked_div(i128::from(denominator)))
        .ok_or_else(|| AppError::Validation("Calcul proportionnel de TVA invalide.".into()))?;
    i64::try_from(rounded)
        .map_err(|_| AppError::Validation("Calcul proportionnel de TVA hors capacité.".into()))
}

fn post_invoice(tx: &Transaction<'_>, invoice_id: &str) -> AppResult<Option<Value>> {
    let Some(map) = accounting_map(tx)? else {
        return Ok(None);
    };
    let (kind, total, net, vat, currency, project, client, number, original_invoice_id, date): InvoicePostingRow = tx.query_row("SELECT type,total_cents,total_cents-vat_cents,vat_cents,currency,project_id,client_id,number,original_invoice_id,issue_date FROM invoices WHERE id=?",params![invoice_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?)))?;
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
    let original_cash_vat = if kind == "avoir" {
        match original_invoice_id.as_deref() {
            Some(original) => cash_vat_state(tx, original)?,
            None => None,
        }
    } else {
        None
    };
    let reversal_vat = if kind == "avoir" && original_cash_vat.is_none() {
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
            let credit_vat = vat.checked_neg().ok_or_else(|| {
                AppError::Validation(
                    "Le montant de TVA de l'avoir dépasse la capacité locale.".into(),
                )
            })?;
            if let Some(cash_state) = original_cash_vat.as_ref() {
                let later_payment_already_posted: bool = tx.query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM payments payment
                       JOIN journal_entries entry ON entry.source_type='payment' AND entry.source_id=payment.id AND entry.source_event='invoice:'||payment.invoice_id AND entry.reversal_of IS NULL
                       WHERE payment.invoice_id=? AND payment.date>?
                    )",
                    params![original_invoice_id.as_deref().unwrap_or(""), date],
                    |row| row.get(0),
                )?;
                if later_payment_already_posted {
                    return Err(AppError::Validation(
                        "Cet avoir serait antidaté avant un encaissement déjà comptabilisé en mode reçu. L'émission est bloquée, car elle modifierait rétroactivement la ventilation de TVA; régularisez la chronologie avec votre fiduciaire."
                            .into(),
                    ));
                }
                let deferred_debit = credit_vat.min(cash_state.deferred_remaining()?);
                if deferred_debit > 0 {
                    push_line(
                        &mut lines,
                        &cash_state.deferred_account,
                        deferred_debit,
                        0,
                        &currency,
                        project.clone(),
                        client.clone(),
                        None,
                        VAT_CREDIT_DEFERRED_MEMO,
                    );
                }
                let mut due_debit = credit_vat - deferred_debit;
                for (account_id, available) in &cash_state.due_by_account {
                    let amount = due_debit.min(*available);
                    if amount > 0 {
                        push_line(
                            &mut lines,
                            account_id,
                            amount,
                            0,
                            &currency,
                            project.clone(),
                            client.clone(),
                            None,
                            VAT_CREDIT_DUE_MEMO,
                        );
                        due_debit -= amount;
                    }
                    if due_debit == 0 {
                        break;
                    }
                }
                if due_debit != 0 {
                    return Err(AppError::Validation(
                        "La TVA de cet avoir dépasse la TVA différée et la TVA déjà devenue due sur les encaissements de la facture originale. L'avoir est bloqué pour éviter un solde TVA débiteur incohérent."
                            .into(),
                    ));
                }
            } else {
                push_line(
                    &mut lines,
                    reversal_vat.as_deref().unwrap_or(&map.vat_payable),
                    credit_vat,
                    0,
                    &currency,
                    project.clone(),
                    client.clone(),
                    None,
                    "Extourne TVA",
                );
            }
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
            let received_basis = invoice_uses_received_vat(tx, &date)?;
            let (vat_account, vat_memo) = if received_basis {
                (
                    map.vat_deferred_payable.as_deref().ok_or_else(|| {
                        AppError::Validation(
                            "Cette facture relève des contre-prestations reçues, mais aucun compte « TVA à régulariser » n'est configuré. L'émission est annulée; configurez Comptabilité > Plan & liaisons."
                                .into(),
                        )
                    })?,
                    VAT_DEFERRED_MEMO,
                )
            } else {
                (map.vat_payable.as_str(), "TVA due")
            };
            push_line(
                &mut lines,
                vat_account,
                0,
                vat,
                &currency,
                project,
                client,
                None,
                vat_memo,
            );
        }
    }
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

fn post_cash_vat_reclassification(
    tx: &Transaction<'_>,
    map: &AccountingMap,
    payment_id: &str,
) -> AppResult<Option<Value>> {
    let has_already_posted_later_payment: bool = tx.query_row(
        "SELECT EXISTS(
           SELECT 1
             FROM payments current
             JOIN payments later ON later.invoice_id=current.invoice_id
             JOIN journal_entries posted ON posted.source_type='payment' AND posted.source_id=later.id AND posted.source_event='invoice:'||later.invoice_id AND posted.reversal_of IS NULL
            WHERE current.id=?
              AND (later.date>current.date
                   OR (later.date=current.date AND later.created_at>current.created_at)
                   OR (later.date=current.date AND later.created_at=current.created_at AND later.id>current.id))
        )",
        params![payment_id],
        |row| row.get(0),
    )?;
    if has_already_posted_later_payment {
        return Err(AppError::Validation(
            "Un encaissement plus récent de cette facture est déjà comptabilisé. Zentra bloque l'ajout antidaté, car il modifierait rétroactivement la ventilation proportionnelle de TVA; régularisez l'ordre avec votre fiduciaire."
                .into(),
        ));
    }
    let (invoice_id, date, currency, project, client, paid_total, credited_total): (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        i64,
        i64,
    ) = tx.query_row(
        "SELECT invoice.id,payment.date,invoice.currency,invoice.project_id,invoice.client_id,
                (SELECT COALESCE(SUM(other.amount_cents),0) FROM payments other
                  WHERE other.invoice_id=invoice.id
                    AND (other.date<payment.date
                         OR (other.date=payment.date AND other.created_at<payment.created_at)
                         OR (other.date=payment.date AND other.created_at=payment.created_at AND other.id<=payment.id))),
                (SELECT COALESCE(SUM(-credit.total_cents),0)
                   FROM invoices credit
                   JOIN journal_entries credit_entry ON credit_entry.source_type='invoice' AND credit_entry.source_id=credit.id AND credit_entry.source_event='issue' AND credit_entry.reversal_of IS NULL
                  WHERE credit.type='avoir' AND credit.original_invoice_id=invoice.id
                    AND credit.number IS NOT NULL AND credit.status<>'annulee'
                    AND credit.issue_date<=payment.date)
           FROM payments payment JOIN invoices invoice ON invoice.id=payment.invoice_id
          WHERE payment.id=?",
        params![payment_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        },
    )?;
    let Some(state) = cash_vat_state(tx, &invoice_id)? else {
        return Ok(None);
    };
    let deferred_remaining = state.deferred_remaining()?;
    if deferred_remaining == 0 {
        return Ok(None);
    }
    let settled = paid_total
        .checked_add(credited_total)
        .is_some_and(|settled_total| settled_total >= state.invoice_total_cents);
    let allocation = if settled {
        deferred_remaining
    } else {
        rounded_proportion(
            state.invoice_vat_cents,
            paid_total,
            state.invoice_total_cents,
        )?
        .saturating_sub(state.released_cents)
        .min(deferred_remaining)
    };
    if allocation == 0 {
        return Ok(None);
    }
    if map.vat_payable == state.deferred_account {
        return Err(AppError::Validation(
            "Les comptes de TVA due et de TVA à régulariser sont identiques; l'encaissement est annulé avant toute écriture."
                .into(),
        ));
    }
    let lines = vec![
        EntryLine {
            account_id: state.deferred_account,
            debit_cents: allocation,
            credit_cents: 0,
            currency: currency.clone(),
            memo: Some(VAT_CASH_RELEASE_MEMO.into()),
            project_id: project.clone(),
            client_id: client.clone(),
            employee_id: None,
        },
        EntryLine {
            account_id: map.vat_payable.clone(),
            debit_cents: 0,
            credit_cents: allocation,
            currency,
            memo: Some(VAT_CASH_DUE_MEMO.into()),
            project_id: project,
            client_id: client,
            employee_id: None,
        },
    ];
    Ok(Some(post_entry(
        tx,
        &date,
        "Reclassement TVA sur encaissement",
        "vat_cash_reclassification",
        payment_id,
        &format!("invoice:{invoice_id}"),
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
    validate_payment_for_accounting(tx, payment_id)?;
    let (invoice_id,date,amount,currency,project,client):(String,String,i64,String,Option<String>,Option<String>)=tx.query_row("SELECT p.invoice_id,p.date,p.amount_cents,i.currency,i.project_id,i.client_id FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.id=?",params![payment_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    let ar_account = posted_invoice_account(tx, &invoice_id, "Créance client", "asset")?
        .ok_or_else(|| {
            AppError::Validation(format!(
                "Le paiement {payment_id} est bloqué : la facture {invoice_id} ne possède pas d'écriture d'émission active et conforme."
            ))
        })?;
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
    let journal = post_entry(
        tx,
        &date,
        "Paiement client",
        "payment",
        payment_id,
        &format!("invoice:{invoice_id}"),
        lines,
    )?;
    post_cash_vat_reclassification(tx, &map, payment_id)?;
    let has_unposted_sibling: bool = tx.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM payments sibling
            WHERE sibling.invoice_id=?
              AND NOT EXISTS(
                SELECT 1 FROM journal_entries entry
                 WHERE entry.source_type='payment' AND entry.source_id=sibling.id
              )
              AND NOT EXISTS(
                SELECT 1 FROM accounting_periods period
                 WHERE period.status='closed' AND sibling.date BETWEEN period.date_from AND period.date_to
              )
         )",
        params![invoice_id],
        |row| row.get(0),
    )?;
    if !has_unposted_sibling && !cash_vat_invoice_is_consistent(tx, &invoice_id)? {
        return Err(AppError::Validation(format!(
            "Le paiement {payment_id} est bloqué : la chaîne de TVA de la facture {invoice_id} est absente ou incohérente. Aucune écriture n'a été conservée."
        )));
    }
    Ok(Some(journal))
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
        "SELECT EXISTS(SELECT 1 FROM journal_lines WHERE account_id=? UNION ALL SELECT 1 FROM accounting_settings WHERE ar_account_id=? OR revenue_account_id=? OR vat_payable_account_id=? OR vat_deferred_payable_account_id=? OR bank_account_id=? OR expense_account_id=? OR vat_receivable_account_id=? OR wages_expense_account_id=? OR wages_payable_account_id=? OR social_expense_account_id=? OR social_payable_account_id=? OR supplier_payable_account_id=? UNION ALL SELECT 1 FROM supplier_invoice_items WHERE expense_account_id=? UNION ALL SELECT 1 FROM payroll_contribution_definitions WHERE liability_account_id=? OR expense_account_id=? UNION ALL SELECT 1 FROM payslip_contributions WHERE liability_account_id=? OR expense_account_id=? UNION ALL SELECT 1 FROM payslip_items WHERE posting_account_id=? OR expense_account_id=?)",
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
    let map = tx.query_row("SELECT ar_account_id,revenue_account_id,vat_payable_account_id,vat_deferred_payable_account_id,bank_account_id,expense_account_id,vat_receivable_account_id,wages_expense_account_id,wages_payable_account_id,social_expense_account_id,social_payable_account_id,supplier_payable_account_id FROM accounting_settings WHERE id=1 AND enabled=1",[],|r|Ok(AccountingMap{ar:r.get(0)?,revenue:r.get(1)?,vat_payable:r.get(2)?,vat_deferred_payable:r.get(3)?,bank:r.get(4)?,expense:r.get(5)?,vat_receivable:r.get(6)?,wages_expense:r.get(7)?,wages_payable:r.get(8)?,social_expense:r.get(9)?,social_payable:r.get(10)?,supplier_payable:r.get(11)?})).optional()?;
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
        if let Some(account_id) = map.vat_deferred_payable.as_deref() {
            validate_account_type(
                tx,
                account_id,
                &["liability"],
                "Le compte de TVA à régulariser",
            )?;
            if account_id == map.vat_payable {
                return Err(AppError::Validation(
                    "Les comptes de TVA due et de TVA à régulariser doivent être distincts.".into(),
                ));
            }
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
    if lines.len() < 2 {
        return Err(AppError::Validation(
            "Une écriture doit contenir au moins deux lignes.".into(),
        ));
    }
    let debit = lines
        .iter()
        .try_fold(0_i64, |total, line| total.checked_add(line.debit_cents))
        .ok_or_else(|| {
            AppError::Validation("Le total des débits dépasse la limite autorisée.".into())
        })?;
    let credit = lines
        .iter()
        .try_fold(0_i64, |total, line| total.checked_add(line.credit_cents))
        .ok_or_else(|| {
            AppError::Validation("Le total des crédits dépasse la limite autorisée.".into())
        })?;
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
    ensure_accounting_date_open(tx, date)?;
    for line in &lines {
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
    let parsed = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::Validation(format!("{field} doit être au format AAAA-MM-JJ.")))?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err(AppError::Validation(format!(
            "{field} doit être une date canonique au format AAAA-MM-JJ."
        )));
    }
    Ok(())
}

pub(crate) fn closed_accounting_through(connection: &Connection) -> AppResult<Option<String>> {
    connection
        .query_row(
            "SELECT MAX(date_to) FROM accounting_periods WHERE status='closed'",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

pub(crate) fn ensure_accounting_date_open(connection: &Connection, date: &str) -> AppResult<()> {
    validate_date(date, "entry_date")?;
    if let Some(closed_through) = closed_accounting_through(connection)? {
        let requested_date = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| {
            AppError::Validation("entry_date doit être au format AAAA-MM-JJ.".into())
        })?;
        let closed_through_date = chrono::NaiveDate::parse_from_str(&closed_through, "%Y-%m-%d")
            .map_err(|_| {
                AppError::Validation(
                    "La frontière de clôture enregistrée dans la base est invalide.".into(),
                )
            })?;
        if requested_date <= closed_through_date {
            return Err(AppError::Validation(format!(
                "La comptabilité est clôturée cumulativement jusqu'au {closed_through}. Enregistrez la correction dans une période ouverte ultérieure et référencez l'opération d'origine."
            )));
        }
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

pub(crate) fn cash_vat_invoice_is_consistent(
    connection: &Connection,
    invoice_id: &str,
) -> AppResult<bool> {
    let original = effective_postings(connection, "invoice", invoice_id, "issue")?;
    let deferred_account = original.first().and_then(|posting| {
        posting
            .lines
            .iter()
            .find(|line| line.memo.as_deref() == Some(VAT_DEFERRED_MEMO))
            .map(|line| line.account_id.as_str())
    });
    let reclassification_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM journal_entries entry JOIN payments payment ON payment.id=entry.source_id WHERE entry.source_type='vat_cash_reclassification' AND entry.reversal_of IS NULL AND payment.invoice_id=?",
        params![invoice_id],
        |row| row.get(0),
    )?;
    let Some(_deferred_account) = deferred_account else {
        return Ok(reclassification_count == 0);
    };
    let (
        total,
        vat,
        paid,
        credited,
        released,
        due_created,
        credit_deferred,
        credit_due,
    ): (i64, i64, i64, i64, i64, i64, i64, i64) = connection.query_row(
        "SELECT invoice.total_cents,invoice.vat_cents,
                (SELECT COALESCE(SUM(payment.amount_cents),0) FROM payments payment WHERE payment.invoice_id=invoice.id),
                (SELECT COALESCE(SUM(-credit.total_cents),0) FROM invoices credit WHERE credit.type='avoir' AND credit.original_invoice_id=invoice.id AND credit.number IS NOT NULL AND credit.status<>'annulee'),
                (SELECT COALESCE(SUM(line.debit_cents),0) FROM journal_entries entry JOIN payments payment ON payment.id=entry.source_id JOIN journal_lines line ON line.journal_entry_id=entry.id AND line.memo=?2 WHERE entry.source_type='vat_cash_reclassification' AND entry.reversal_of IS NULL AND payment.invoice_id=invoice.id),
                (SELECT COALESCE(SUM(line.credit_cents),0) FROM journal_entries entry JOIN payments payment ON payment.id=entry.source_id JOIN journal_lines line ON line.journal_entry_id=entry.id AND line.memo=?3 WHERE entry.source_type='vat_cash_reclassification' AND entry.reversal_of IS NULL AND payment.invoice_id=invoice.id),
                (SELECT COALESCE(SUM(line.debit_cents),0) FROM invoices credit JOIN journal_entries entry ON entry.source_type='invoice' AND entry.source_id=credit.id AND entry.source_event='issue' AND entry.reversal_of IS NULL JOIN journal_lines line ON line.journal_entry_id=entry.id AND line.memo=?4 WHERE credit.type='avoir' AND credit.original_invoice_id=invoice.id AND credit.number IS NOT NULL AND credit.status<>'annulee'),
                (SELECT COALESCE(SUM(line.debit_cents),0) FROM invoices credit JOIN journal_entries entry ON entry.source_type='invoice' AND entry.source_id=credit.id AND entry.source_event='issue' AND entry.reversal_of IS NULL JOIN journal_lines line ON line.journal_entry_id=entry.id AND line.memo=?5 WHERE credit.type='avoir' AND credit.original_invoice_id=invoice.id AND credit.number IS NOT NULL AND credit.status<>'annulee')
           FROM invoices invoice WHERE invoice.id=?1",
        params![
            invoice_id,
            VAT_CASH_RELEASE_MEMO,
            VAT_CASH_DUE_MEMO,
            VAT_CREDIT_DEFERRED_MEMO,
            VAT_CREDIT_DUE_MEMO
        ],
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
    )?;
    if total <= 0
        || vat <= 0
        || released != due_created
        || released < 0
        || credit_deferred < 0
        || credit_due < 0
        || credit_due > released
        || released
            .checked_add(credit_deferred)
            .is_none_or(|allocated| allocated > vat)
    {
        return Ok(false);
    }
    let remaining_after_credits = vat - credit_deferred;
    let settled = paid
        .checked_add(credited)
        .is_some_and(|settled_total| settled_total >= total);
    let expected_release = if settled {
        remaining_after_credits
    } else {
        rounded_proportion(vat, paid, total)?.min(remaining_after_credits)
    };
    Ok(released == expected_release)
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
            let vat_lines = posting
                .lines
                .iter()
                .filter(|line| {
                    matches!(
                        line.memo.as_deref(),
                        Some("Extourne TVA")
                            | Some(VAT_CREDIT_DEFERRED_MEMO)
                            | Some(VAT_CREDIT_DUE_MEMO)
                    )
                })
                .collect::<Vec<_>>();
            let vat_debit = vat_lines
                .iter()
                .try_fold(0_i64, |sum, line| sum.checked_add(line.debit_cents));
            let vat_lines_valid = if vat == 0 {
                vat_lines.is_empty()
            } else {
                vat_debit == Some(-vat)
                    && vat_lines.iter().all(|line| {
                        line.credit_cents == 0
                            && account_has_type(connection, &line.account_id, "liability")
                                .unwrap_or(false)
                    })
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
                && vat_lines_valid;
            if let Some(original_id) = original_invoice_id.as_deref() {
                let original = effective_postings(connection, "invoice", original_id, "issue")?;
                let original_posting = original.first();
                let original_deferred = original_posting.and_then(|entry| {
                    entry
                        .lines
                        .iter()
                        .find(|line| line.memo.as_deref() == Some(VAT_DEFERRED_MEMO))
                });
                let credit_basis_valid = if vat == 0 {
                    true
                } else if let Some(deferred_line) = original_deferred {
                    vat_lines.iter().all(|line| {
                        matches!(
                            line.memo.as_deref(),
                            Some(VAT_CREDIT_DEFERRED_MEMO) | Some(VAT_CREDIT_DUE_MEMO)
                        ) && (line.memo.as_deref() != Some(VAT_CREDIT_DEFERRED_MEMO)
                            || line.account_id == deferred_line.account_id)
                    })
                } else {
                    vat_lines.len() == 1 && vat_lines[0].memo.as_deref() == Some("Extourne TVA")
                };
                valid &= original.len() == 1
                    && credit_basis_valid
                    && ar
                        == original_posting.and_then(|entry| {
                            entry
                                .lines
                                .iter()
                                .find(|line| line.memo.as_deref() == Some("Créance client"))
                                .map(|line| line.account_id.as_str())
                        })
                    && revenue
                        == original_posting
                            .and_then(|entry| {
                                entry
                                    .lines
                                    .iter()
                                    .find(|line| line.memo.as_deref() == Some("Produit facturé"))
                                    .map(|line| line.account_id.as_str())
                            })
                            .or(if net == 0 { Some("") } else { None });
            }
        } else {
            let ar = exact_line_account(posting, "Créance client", total, 0);
            let revenue = if net != 0 {
                exact_line_account(posting, "Produit facturé", 0, net)
            } else {
                Some("")
            };
            let received_basis: bool = connection
                .query_row(
                    "SELECT form_of_reporting='received' FROM vat_profiles WHERE effective_from<=? AND COALESCE(effective_to,'9999-12-31')>=? ORDER BY effective_from DESC LIMIT 1",
                    params![issue_date, issue_date],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(false);
            let vat_account = if vat != 0 {
                exact_line_account(
                    posting,
                    if received_basis {
                        VAT_DEFERRED_MEMO
                    } else {
                        "TVA due"
                    },
                    0,
                    vat,
                )
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
        let mut valid = posting.entry_date == date
            && amount > 0
            && posting_totals_match(posting, amount, &currency)
            && bank.is_some_and(|account| {
                account_has_type(connection, account, "asset").unwrap_or(false)
            })
            && ar.is_some()
            && bank != ar
            && original.len() == 1
            && ar == original_ar;
        let original_deferred = original.first().and_then(|entry| {
            entry
                .lines
                .iter()
                .find(|line| line.memo.as_deref() == Some(VAT_DEFERRED_MEMO))
                .map(|line| line.account_id.as_str())
        });
        let vat_postings = effective_postings(
            connection,
            "vat_cash_reclassification",
            &id,
            &format!("invoice:{invoice_id}"),
        )?;
        if let Some(deferred_account) = original_deferred {
            let vat_posting_valid = match vat_postings.as_slice() {
                [] => true,
                [vat_posting] => {
                    let release = vat_posting
                        .lines
                        .iter()
                        .find(|line| line.memo.as_deref() == Some(VAT_CASH_RELEASE_MEMO));
                    let due = vat_posting
                        .lines
                        .iter()
                        .find(|line| line.memo.as_deref() == Some(VAT_CASH_DUE_MEMO));
                    release.zip(due).is_some_and(|(release, due)| {
                        vat_posting.entry_date == date
                            && vat_posting.lines.len() == 2
                            && release.account_id == deferred_account
                            && release.debit_cents > 0
                            && release.credit_cents == 0
                            && due.debit_cents == 0
                            && due.credit_cents == release.debit_cents
                            && due.account_id != release.account_id
                            && release.currency == currency
                            && due.currency == currency
                            && account_has_type(connection, &due.account_id, "liability")
                                .unwrap_or(false)
                    })
                }
                _ => false,
            };
            valid &= vat_posting_valid && cash_vat_invoice_is_consistent(connection, &invoice_id)?;
        } else {
            valid &= vat_postings.is_empty();
        }
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
fn report_bounds(filter: &PeriodFilter) -> AppResult<(String, String)> {
    let date_from = filter
        .date_from
        .clone()
        .unwrap_or_else(|| "0001-01-01".into());
    let date_to = filter
        .date_to
        .clone()
        .unwrap_or_else(|| "9999-12-31".into());
    validate_date(&date_from, "date_from")?;
    validate_date(&date_to, "date_to")?;
    if date_from > date_to {
        return Err(AppError::Validation(
            "date_from doit précéder ou être égale à date_to.".into(),
        ));
    }
    Ok((date_from, date_to))
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

#[cfg(test)]
mod historical_payment_guard_tests {
    use super::*;

    #[test]
    fn business_guard_rechecks_status_dates_amounts_and_open_balance() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE invoices(
                   id TEXT PRIMARY KEY,type TEXT NOT NULL,status TEXT NOT NULL,number TEXT,
                   issue_date TEXT,total_cents INTEGER NOT NULL,paid_cents INTEGER NOT NULL,
                   original_invoice_id TEXT,created_at TEXT NOT NULL
                 );
                 CREATE TABLE payments(
                   id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,date TEXT NOT NULL,
                   amount_cents INTEGER NOT NULL,created_at TEXT NOT NULL
                 );
                 INSERT INTO invoices(id,type,status,number,issue_date,total_cents,paid_cents,created_at)
                 VALUES('invoice-1','standard','partiellement_payee','F-2026-0001','2026-09-01',10000,4000,'2026-09-01T08:00:00Z');
                 INSERT INTO payments(id,invoice_id,date,amount_cents,created_at)
                 VALUES('payment-1','invoice-1','2026-09-02',4000,'2026-09-02T08:00:00Z');",
            )
            .unwrap();
        assert_eq!(
            payment_accounting_block_reason(&connection, "payment-1").unwrap(),
            None
        );

        connection
            .execute(
                "UPDATE payments SET date='2026-08-31' WHERE id='payment-1'",
                [],
            )
            .unwrap();
        assert!(payment_accounting_block_reason(&connection, "payment-1")
            .unwrap()
            .unwrap()
            .contains("précède"));

        connection
            .execute_batch(
                "UPDATE payments SET date='2026-09-02',amount_cents=11000 WHERE id='payment-1';
                 UPDATE invoices SET paid_cents=11000 WHERE id='invoice-1';",
            )
            .unwrap();
        assert!(payment_accounting_block_reason(&connection, "payment-1")
            .unwrap()
            .unwrap()
            .contains("dépasse le solde ouvert"));

        connection
            .execute_batch(
                "UPDATE payments SET amount_cents=4000 WHERE id='payment-1';
                 UPDATE invoices SET paid_cents=4000,status='brouillon' WHERE id='invoice-1';",
            )
            .unwrap();
        assert!(payment_accounting_block_reason(&connection, "payment-1")
            .unwrap()
            .unwrap()
            .contains("émise et active"));

        connection
            .execute("UPDATE invoices SET type='avoir' WHERE id='invoice-1'", [])
            .unwrap();
        assert!(payment_accounting_block_reason(&connection, "payment-1")
            .unwrap()
            .unwrap()
            .contains("avoir"));
    }

    #[test]
    fn v29_historical_invalid_payment_stays_visible_and_aborts_backfill_atomically() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        {
            let connection = store.connect().unwrap();
            connection
                .execute_batch(
                    "INSERT INTO settings(id,onboarding_completed,company_name,noga_section,noga_division,activity_description,created_at,updated_at)
                     VALUES(1,1,'Entreprise historique','G','47','Commerce','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z');
                     DROP TRIGGER IF EXISTS payments_invoice_issue_date_guard;
                     DROP TRIGGER IF EXISTS invoices_issued_no_unsafe_cancel;
                     INSERT INTO invoices(id,number,title,type,status,issue_date,due_date,currency,total_cents,paid_cents,created_at,updated_at)
                     VALUES('invoice-history','F-2026-0001','Facture historique','standard','partiellement_payee','2026-09-01','2026-09-30','CHF',10000,5000,'2026-09-01T08:00:00Z','2026-09-01T08:00:00Z');
                     INSERT INTO payments(id,invoice_id,date,amount_cents,created_at,updated_at)
                     VALUES('payment-antedated','invoice-history','2026-08-31',5000,'2026-09-02T08:00:00Z','2026-09-02T08:00:00Z');
                     PRAGMA user_version=29;",
                )
                .unwrap();
        }
        store.migrate().unwrap();

        let continuity = store.get_accounting_continuity().unwrap();
        assert_eq!(continuity["blocked_payment_count"], 1);
        assert_eq!(continuity["blocked_payments"][0]["id"], "payment-antedated");
        assert!(continuity["blocked_payments"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("précède"));

        let error = store.install_swiss_accounting_starter().unwrap_err();
        let message = error.to_string();
        assert!(message.contains("payment-antedated"));
        assert!(message.contains("Aucun journal n'a été créé"));

        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM journal_entries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM accounts", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0,
            "le plan comptable et son backfill doivent être atomiques"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM payments WHERE id='payment-antedated'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
            "la donnée historique bloquée reste consultable"
        );
    }
}

#[cfg(test)]
mod cumulative_close_tests {
    use super::*;

    fn initialized_store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();
        connection
            .execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,currency,created_at,updated_at)
                 VALUES(1,1,'Zentra clôture','CHF','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);
        store.install_swiss_accounting_starter().unwrap();
        (temporary, store)
    }

    fn create_2026_period(store: &LocalStore) -> Value {
        store
            .upsert_accounting_period(AccountingPeriodInput {
                id: Some("period-2026".into()),
                name: "Exercice 2026".into(),
                date_from: "2026-01-01".into(),
                date_to: "2026-12-31".into(),
            })
            .unwrap()
    }

    fn entry_lines(debit_account: &str, credit_account: &str, amount: i64) -> Vec<EntryLine> {
        vec![
            EntryLine {
                account_id: debit_account.into(),
                debit_cents: amount,
                credit_cents: 0,
                currency: "CHF".into(),
                memo: Some("Débit test".into()),
                project_id: None,
                client_id: None,
                employee_id: None,
            },
            EntryLine {
                account_id: credit_account.into(),
                debit_cents: 0,
                credit_cents: amount,
                currency: "CHF".into(),
                memo: Some("Crédit test".into()),
                project_id: None,
                client_id: None,
                employee_id: None,
            },
        ]
    }

    #[test]
    fn cumulative_close_blocks_gap_backdating_without_consuming_state_and_allows_exact_replay() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();
        connection
            .execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,currency,created_at,updated_at)
                 VALUES(1,1,'Zentra clôture','CHF','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);
        store.install_swiss_accounting_starter().unwrap();

        let connection = store.connect().unwrap();
        let debit_account: String = connection
            .query_row("SELECT id FROM accounts WHERE code='1020'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let credit_account: String = connection
            .query_row("SELECT id FROM accounts WHERE code='3200'", [], |row| {
                row.get(0)
            })
            .unwrap();
        drop(connection);

        let period = store
            .upsert_accounting_period(AccountingPeriodInput {
                id: Some("period-2026".into()),
                name: "Exercice 2026".into(),
                date_from: "2026-01-01".into(),
                date_to: "2026-12-31".into(),
            })
            .unwrap();
        let original = {
            let mut connection = store.connect().unwrap();
            let transaction = connection.transaction().unwrap();
            let result = post_entry(
                &transaction,
                "2026-06-30",
                "Écriture rejouable",
                "manual",
                "stable-operation",
                "posted",
                entry_lines(&debit_account, &credit_account, 10_000),
            )
            .unwrap();
            transaction.commit().unwrap();
            result
        };
        store
            .close_accounting_period(period["id"].as_str().unwrap())
            .unwrap();

        let connection = store.connect().unwrap();
        assert_eq!(
            closed_accounting_through(&connection).unwrap().as_deref(),
            Some("2026-12-31")
        );
        let before: (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM journal_entries),
                   (SELECT COUNT(*) FROM journal_lines),
                   (SELECT COUNT(*) FROM accounting_sequences),
                   (SELECT COUNT(*) FROM audit_log)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        drop(connection);

        let replay = {
            let mut connection = store.connect().unwrap();
            let transaction = connection.transaction().unwrap();
            let result = post_entry(
                &transaction,
                "2026-06-30",
                "Écriture rejouable",
                "manual",
                "stable-operation",
                "posted",
                entry_lines(&debit_account, &credit_account, 10_000),
            )
            .unwrap();
            transaction.commit().unwrap();
            result
        };
        assert_eq!(replay["id"], original["id"]);

        let mut connection = store.connect().unwrap();
        let transaction = connection.transaction().unwrap();
        let conflict = post_entry(
            &transaction,
            "2026-06-30",
            "Écriture rejouable",
            "manual",
            "stable-operation",
            "posted",
            entry_lines(&debit_account, &credit_account, 10_001),
        )
        .unwrap_err()
        .to_string();
        assert!(conflict.contains("fausse idempotence"));
        drop(transaction);
        drop(connection);

        let manual_error = store
            .post_manual_journal_entry(ManualJournalInput {
                entry_date: "2025-06-30".into(),
                description: "Antidatage dans un intervalle sans période".into(),
                currency: "CHF".into(),
                lines: vec![
                    crate::models::ManualJournalLineInput {
                        account_id: debit_account.clone(),
                        debit_cents: 100,
                        credit_cents: 0,
                        memo: None,
                        project_id: None,
                        client_id: None,
                        employee_id: None,
                    },
                    crate::models::ManualJournalLineInput {
                        account_id: credit_account.clone(),
                        debit_cents: 0,
                        credit_cents: 100,
                        memo: None,
                        project_id: None,
                        client_id: None,
                        employee_id: None,
                    },
                ],
            })
            .unwrap_err()
            .to_string();
        assert!(
            manual_error.contains("cumulativement jusqu'au 2026-12-31"),
            "erreur manuelle inattendue: {manual_error}"
        );

        let mut connection = store.connect().unwrap();
        let transaction = connection.transaction().unwrap();
        let automatic_error = post_entry(
            &transaction,
            "2025-12-31",
            "Automatique antidatée",
            "test_automatic",
            "new-operation",
            "post",
            entry_lines(&debit_account, &credit_account, 200),
        )
        .unwrap_err()
        .to_string();
        assert!(
            automatic_error.contains("cumulativement jusqu'au 2026-12-31"),
            "erreur automatique inattendue: {automatic_error}"
        );
        drop(transaction);
        drop(connection);

        let period_error = store
            .upsert_accounting_period(AccountingPeriodInput {
                id: Some("period-gap-2025".into()),
                name: "Intervalle antérieur".into(),
                date_from: "2025-01-01".into(),
                date_to: "2025-12-31".into(),
            })
            .unwrap_err()
            .to_string();
        assert!(
            period_error.contains("cumulativement jusqu'au 2026-12-31"),
            "erreur de période inattendue: {period_error}"
        );

        let connection = store.connect().unwrap();
        let after: (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM journal_entries),
                   (SELECT COUNT(*) FROM journal_lines),
                   (SELECT COUNT(*) FROM accounting_sequences),
                   (SELECT COUNT(*) FROM audit_log)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            after, before,
            "les rejets et replays ne consomment aucun état"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM accounting_sequences WHERE year=2025",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        drop(connection);

        store
            .upsert_accounting_period(AccountingPeriodInput {
                id: Some("period-2027".into()),
                name: "Exercice 2027".into(),
                date_from: "2027-01-01".into(),
                date_to: "2027-12-31".into(),
            })
            .unwrap();
        let reversal = store
            .reverse_journal_entry(
                original["id"].as_str().unwrap(),
                "2027-01-02",
                Some("Correction de stable-operation".into()),
            )
            .unwrap();
        assert_eq!(reversal["entry"]["reversal_of"], original["id"]);
    }

    #[test]
    fn cumulative_close_rejects_unposted_source_before_period_start() {
        let (_temporary, store) = initialized_store();
        let period = create_2026_period(&store);
        let connection = store.connect().unwrap();
        connection
            .execute(
                "INSERT INTO expenses(
                    id,date,due_date,supplier,category,currency,net_cents,vat_cents,total_cents,
                    payment_status,paid_at,created_at,updated_at
                 ) VALUES(
                    'prior-unposted-expense','2025-06-01',NULL,'Fournisseur historique','Matériel',
                    'CHF',1000,0,1000,'paid',NULL,'2025-06-01T00:00:00Z','2025-06-01T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        drop(connection);

        let error = store
            .close_accounting_period(period["id"].as_str().unwrap())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("clôture cumulative") && error.contains("antérieure"),
            "erreur cumulative inattendue: {error}"
        );
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM accounting_periods WHERE id='period-2026'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "open"
        );
    }

    #[test]
    fn cumulative_close_rejects_unbalanced_entry_before_period_start() {
        let (_temporary, store) = initialized_store();
        let period = create_2026_period(&store);
        let connection = store.connect().unwrap();
        let account_id: String = connection
            .query_row("SELECT id FROM accounts WHERE code='1020'", [], |row| {
                row.get(0)
            })
            .unwrap();
        connection
            .execute(
                "INSERT INTO journal_entries(
                    id,number,entry_date,description,source_type,source_id,source_event,status,created_at
                 ) VALUES(
                    'prior-unbalanced-entry','OD-2025-000001','2025-06-01','Écriture historique déséquilibrée',
                    'manual','prior-unbalanced-source','posted','posted','2025-06-01T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO journal_lines(
                    id,journal_entry_id,account_id,debit_cents,credit_cents,currency,memo,created_at
                 ) VALUES(
                    'prior-unbalanced-line','prior-unbalanced-entry',?,1000,0,'CHF','Débit isolé',
                    '2025-06-01T00:00:00Z'
                 )",
                params![account_id],
            )
            .unwrap();
        drop(connection);

        let error = store
            .close_accounting_period(period["id"].as_str().unwrap())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("historique cumulatif") && error.contains("déséquilibrées"),
            "erreur de déséquilibre cumulative inattendue: {error}"
        );
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM accounting_periods WHERE id='period-2026'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "open"
        );
    }

    #[test]
    fn expense_payment_guard_uses_expense_date_when_paid_at_is_null() {
        let (_temporary, store) = initialized_store();
        let connection = store.connect().unwrap();
        connection
            .execute(
                "INSERT INTO expenses(
                    id,date,due_date,supplier,category,currency,net_cents,vat_cents,total_cents,
                    payment_status,paid_at,created_at,updated_at
                 ) VALUES(
                    'closed-pending-expense','2026-06-01','2026-06-30','Fournisseur','Matériel',
                    'CHF',1000,0,1000,'pending',NULL,'2026-06-01T00:00:00Z','2026-06-01T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO expenses(
                    id,date,due_date,supplier,category,currency,net_cents,vat_cents,total_cents,
                    payment_status,paid_at,created_at,updated_at
                 ) VALUES(
                    'closed-blank-paid-at-expense','2026-07-01','2026-07-31','Fournisseur','Matériel',
                    'CHF',2000,0,2000,'pending',NULL,'2026-07-01T00:00:00Z','2026-07-01T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO accounting_periods(
                    id,name,date_from,date_to,status,closed_at,created_at,updated_at
                 ) VALUES(
                    'closed-2026','Exercice 2026','2026-01-01','2026-12-31','closed',
                    '2027-01-15T00:00:00Z','2026-01-01T00:00:00Z','2027-01-15T00:00:00Z'
                 )",
                [],
            )
            .unwrap();

        let error = connection
            .execute(
                "UPDATE expenses SET payment_status='paid' WHERE id='closed-pending-expense'",
                [],
            )
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("expense payment history through the closed date is immutable"),
            "garde de paiement inattendue: {error}"
        );
        let state: (String, Option<String>) = connection
            .query_row(
                "SELECT payment_status,paid_at FROM expenses WHERE id='closed-pending-expense'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, ("pending".into(), None));

        let blank_error = connection
            .execute(
                "UPDATE expenses SET payment_status='paid',paid_at=''
                 WHERE id='closed-blank-paid-at-expense'",
                [],
            )
            .unwrap_err()
            .to_string();
        assert!(
            blank_error.contains("expense payment history through the closed date is immutable"),
            "garde avec date de paiement vide inattendue: {blank_error}"
        );
        let blank_state: (String, Option<String>) = connection
            .query_row(
                "SELECT payment_status,paid_at FROM expenses WHERE id='closed-blank-paid-at-expense'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(blank_state, ("pending".into(), None));
    }
}

#[cfg(test)]
mod manual_journal_idempotence_tests {
    use super::*;
    use crate::models::ManualJournalLineInput;

    fn initialized_store() -> (tempfile::TempDir, LocalStore, String, String) {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local database");
        let connection = store.connect().expect("connect local database");
        connection
            .execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,currency,created_at,updated_at)
                 VALUES(1,1,'Zentra journal','CHF','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .expect("mark onboarding complete");
        drop(connection);
        store
            .install_swiss_accounting_starter()
            .expect("install accounting starter");
        let connection = store.connect().expect("connect local database");
        let debit_account = connection
            .query_row("SELECT id FROM accounts WHERE code='1020'", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("read debit account");
        let credit_account = connection
            .query_row("SELECT id FROM accounts WHERE code='3200'", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("read credit account");
        drop(connection);
        (temporary, store, debit_account, credit_account)
    }

    fn manual_input(
        debit_account: &str,
        credit_account: &str,
        description: &str,
    ) -> ManualJournalInput {
        ManualJournalInput {
            entry_date: "2026-09-04".into(),
            description: description.into(),
            currency: "CHF".into(),
            lines: vec![
                ManualJournalLineInput {
                    account_id: debit_account.into(),
                    debit_cents: 10_000,
                    credit_cents: 0,
                    memo: Some("Débit contrôlé".into()),
                    project_id: None,
                    client_id: None,
                    employee_id: None,
                },
                ManualJournalLineInput {
                    account_id: credit_account.into(),
                    debit_cents: 0,
                    credit_cents: 10_000,
                    memo: Some("Crédit contrôlé".into()),
                    project_id: None,
                    client_id: None,
                    employee_id: None,
                },
            ],
        }
    }

    #[test]
    fn manual_journal_request_replays_once_and_rejects_changed_payload() {
        let (_temporary, store, debit_account, credit_account) = initialized_store();
        let request_id = Uuid::new_v4().to_string();
        let first = store
            .post_manual_journal_entry_with_request_id(
                manual_input(&debit_account, &credit_account, "Écriture rejouable"),
                &request_id,
            )
            .expect("post manual journal entry");
        let replay = store
            .post_manual_journal_entry_with_request_id(
                manual_input(&debit_account, &credit_account, "Écriture rejouable"),
                &request_id,
            )
            .expect("replay manual journal entry");
        assert_eq!(replay["id"], first["id"]);

        let conflict = store
            .post_manual_journal_entry_with_request_id(
                manual_input(&debit_account, &credit_account, "Contenu modifié"),
                &request_id,
            )
            .expect_err("a request id cannot be reused for changed content");
        assert!(conflict.to_string().contains("fausse idempotence"));

        let connection = store.connect().expect("connect local database");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM journal_entries WHERE source_type='manual' AND source_id=? AND source_event='posted'",
                    params![request_id],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count manual journal entries"),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM audit_log WHERE action='post' AND entity_type='journal_entry' AND entity_id=?",
                    params![first["id"].as_str().unwrap_or_default()],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count manual journal audit rows"),
            1
        );
    }

    #[test]
    fn manual_journal_rejects_total_overflow_without_writing() {
        let (_temporary, store, debit_account, credit_account) = initialized_store();
        let mut input = manual_input(&debit_account, &credit_account, "Montant excessif");
        input.lines = vec![
            ManualJournalLineInput {
                account_id: debit_account.clone(),
                debit_cents: i64::MAX,
                credit_cents: 0,
                memo: None,
                project_id: None,
                client_id: None,
                employee_id: None,
            },
            ManualJournalLineInput {
                account_id: debit_account,
                debit_cents: 1,
                credit_cents: 0,
                memo: None,
                project_id: None,
                client_id: None,
                employee_id: None,
            },
            ManualJournalLineInput {
                account_id: credit_account.clone(),
                debit_cents: 0,
                credit_cents: i64::MAX,
                memo: None,
                project_id: None,
                client_id: None,
                employee_id: None,
            },
            ManualJournalLineInput {
                account_id: credit_account,
                debit_cents: 0,
                credit_cents: 1,
                memo: None,
                project_id: None,
                client_id: None,
                employee_id: None,
            },
        ];

        let error = store
            .post_manual_journal_entry_with_request_id(input, &Uuid::new_v4().to_string())
            .expect_err("overflowing totals must be rejected");
        assert!(error.to_string().contains("total des débits"));
        let connection = store.connect().expect("connect local database");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM journal_entries WHERE source_type='manual'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count manual journal entries"),
            0
        );
    }
}
