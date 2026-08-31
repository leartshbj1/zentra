use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, OptionalExtension, Transaction,
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
    wages_expense: String,
    wages_payable: String,
    social_expense: String,
    social_payable: String,
}

#[derive(Debug, Clone)]
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
);

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
        let unbalanced:i64=tx.query_row("SELECT COUNT(*) FROM (SELECT je.id FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id WHERE je.entry_date BETWEEN ? AND ? GROUP BY je.id HAVING SUM(jl.debit_cents)<>SUM(jl.credit_cents))",params![period["date_from"].as_str(),period["date_to"].as_str()],|r|r.get(0))?;
        if unbalanced != 0 {
            return Err(AppError::Validation(
                "La période contient des écritures déséquilibrées.".into(),
            ));
        }
        let date_to = period["date_to"].as_str().ok_or_else(|| {
            AppError::Validation("La période n'a pas de date de fin valide.".into())
        })?;
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

    pub fn configure_accounting(&self, input: AccountingSettingsInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let ids = [
            input.ar_account_id.as_deref(),
            input.revenue_account_id.as_deref(),
            input.vat_payable_account_id.as_deref(),
            input.bank_account_id.as_deref(),
            input.expense_account_id.as_deref(),
            input.vat_receivable_account_id.as_deref(),
            input.wages_expense_account_id.as_deref(),
            input.wages_payable_account_id.as_deref(),
            input.social_expense_account_id.as_deref(),
            input.social_payable_account_id.as_deref(),
        ];
        if input.enabled
            && ids.iter().any(|id| match id {
                None => true,
                Some(value) => value.trim().is_empty(),
            })
        {
            return Err(AppError::Validation("Tous les comptes de liaison doivent être explicitement sélectionnés avant d'activer la comptabilité.".into()));
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
            for (id, expected, label) in [
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
            ] {
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
        }
        let now = now_iso();
        tx.execute(
            "INSERT INTO accounting_settings(id,enabled,ar_account_id,revenue_account_id,vat_payable_account_id,bank_account_id,expense_account_id,vat_receivable_account_id,wages_expense_account_id,wages_payable_account_id,social_expense_account_id,social_payable_account_id,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,ar_account_id=excluded.ar_account_id,revenue_account_id=excluded.revenue_account_id,vat_payable_account_id=excluded.vat_payable_account_id,bank_account_id=excluded.bank_account_id,expense_account_id=excluded.expense_account_id,vat_receivable_account_id=excluded.vat_receivable_account_id,wages_expense_account_id=excluded.wages_expense_account_id,wages_payable_account_id=excluded.wages_payable_account_id,social_expense_account_id=excluded.social_expense_account_id,social_payable_account_id=excluded.social_payable_account_id,updated_at=excluded.updated_at",
            params![input.enabled as i64,input.ar_account_id,input.revenue_account_id,input.vat_payable_account_id,input.bank_account_id,input.expense_account_id,input.vat_receivable_account_id,input.wages_expense_account_id,input.wages_payable_account_id,input.social_expense_account_id,input.social_payable_account_id,now,now],
        )?;
        let record = one_json(&tx, "SELECT * FROM accounting_settings WHERE id=1", [])?;
        append_audit(&tx, "configure", "accounting_settings", "1", &record)?;
        tx.commit()?;
        Ok(record)
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
        let (where_sql, values) = period_clause(&filter, "entry_date")?;
        let entries = query_all(
            &connection,
            &format!("SELECT * FROM journal_entries {where_sql} ORDER BY entry_date,number"),
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

pub(crate) fn post_invoice_if_enabled(
    tx: &Transaction<'_>,
    invoice_id: &str,
) -> AppResult<Option<Value>> {
    let Some(map) = accounting_map(tx)? else {
        return Ok(None);
    };
    let (kind, total, net, vat, currency, project, client, number): InvoicePostingRow = tx.query_row("SELECT type,total_cents,total_cents-vat_cents,vat_cents,currency,project_id,client_id,number FROM invoices WHERE id=?",params![invoice_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)))?;
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
    if kind == "avoir" {
        if total >= 0 || net > 0 || vat > 0 {
            return Err(AppError::Validation(
                "Un avoir émis doit avoir des montants négatifs.".into(),
            ));
        }
        push_line(
            &mut lines,
            &map.revenue,
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
                &map.vat_payable,
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
            &map.ar,
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
        &map.ar,
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
        &map.wages_expense,
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
            &map.wages_payable,
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
            .unwrap_or(&map.social_payable);
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
                "account_id": map.social_payable,
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
                    .unwrap_or(&map.social_expense);
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
                        "account_id": map.social_expense,
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
        "SELECT EXISTS(SELECT 1 FROM journal_lines WHERE account_id=? UNION ALL SELECT 1 FROM accounting_settings WHERE ar_account_id=? OR revenue_account_id=? OR vat_payable_account_id=? OR bank_account_id=? OR expense_account_id=? OR vat_receivable_account_id=? OR wages_expense_account_id=? OR wages_payable_account_id=? OR social_expense_account_id=? OR social_payable_account_id=? UNION ALL SELECT 1 FROM payroll_contribution_definitions WHERE liability_account_id=? OR expense_account_id=? UNION ALL SELECT 1 FROM payslip_contributions WHERE liability_account_id=? OR expense_account_id=? UNION ALL SELECT 1 FROM payslip_items WHERE posting_account_id=? OR expense_account_id=?)",
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
    let map = tx.query_row("SELECT ar_account_id,revenue_account_id,vat_payable_account_id,bank_account_id,expense_account_id,vat_receivable_account_id,wages_expense_account_id,wages_payable_account_id,social_expense_account_id,social_payable_account_id FROM accounting_settings WHERE id=1 AND enabled=1",[],|r|Ok(AccountingMap{ar:r.get(0)?,revenue:r.get(1)?,vat_payable:r.get(2)?,bank:r.get(3)?,expense:r.get(4)?,vat_receivable:r.get(5)?,wages_expense:r.get(6)?,wages_payable:r.get(7)?,social_expense:r.get(8)?,social_payable:r.get(9)?})).optional()?;
    if let Some(map) = &map {
        for (account_id, expected_type, label) in [
            (&map.ar, "asset", "Le compte clients"),
            (&map.revenue, "revenue", "Le compte de produits"),
            (&map.vat_payable, "liability", "Le compte de TVA due"),
            (&map.bank, "asset", "Le compte bancaire"),
            (&map.expense, "expense", "Le compte de charges"),
            (&map.vat_receivable, "asset", "Le compte de TVA préalable"),
            (
                &map.wages_expense,
                "expense",
                "Le compte de charges salariales",
            ),
            (&map.wages_payable, "liability", "Le compte de salaires dus"),
            (
                &map.social_expense,
                "expense",
                "Le compte de charges sociales",
            ),
            (
                &map.social_payable,
                "liability",
                "Le compte de cotisations dues",
            ),
        ] {
            validate_account_type(tx, account_id, &[expected_type], label)?;
        }
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
    validate_date(date, "entry_date")?;
    if lines.len() < 2 {
        return Err(AppError::Validation(
            "Une écriture doit contenir au moins deux lignes.".into(),
        ));
    }
    let closed:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM accounting_periods WHERE status='closed' AND ? BETWEEN date_from AND date_to)",params![date],|r|r.get(0))?;
    if closed {
        return Err(AppError::Validation(
            "La période comptable correspondant à cette date est clôturée.".into(),
        ));
    }
    let debit: i64 = lines.iter().map(|l| l.debit_cents).sum();
    let credit: i64 = lines.iter().map(|l| l.credit_cents).sum();
    if debit <= 0 || debit != credit {
        return Err(AppError::Validation(format!(
            "Écriture déséquilibrée : débits {debit}, crédits {credit}."
        )));
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
