use chrono::{Datelike, Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::{
    accounting::validate_date,
    error::{AppError, AppResult},
    models::PeriodFilter,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StatementScope {
    pub date_from: String,
    pub date_to: String,
    pub previous_date_from: String,
    pub previous_date_to: String,
    pub comparison_label: String,
    pub comparison_source: &'static str,
}

#[derive(Debug)]
struct StatementAccountRow {
    id: String,
    code: String,
    name: String,
    account_type: String,
    normal_balance: String,
    report_section: String,
    debit_cents: i64,
    credit_cents: i64,
    previous_debit_cents: i64,
    previous_credit_cents: i64,
}

#[derive(Debug)]
struct StatementTotals {
    rows: Vec<StatementAccountRow>,
    sections: Value,
    previous_sections: Value,
}

/// Resolve an explicit accounting exercise and the comparison exercise displayed beside it.
/// If the requested dates exactly match a stored period, its immediately preceding stored period
/// is used. Otherwise, the same calendar dates one year earlier are used.
pub(crate) fn resolve_statement_scope(
    connection: &Connection,
    filter: &PeriodFilter,
) -> AppResult<StatementScope> {
    let today = Local::now().date_naive();
    let date_to = match filter.date_to.as_deref() {
        Some(value) => parse_date(value, "date_to")?,
        None => today,
    };
    let date_from = match filter.date_from.as_deref() {
        Some(value) => parse_date(value, "date_from")?,
        None => NaiveDate::from_ymd_opt(date_to.year(), 1, 1).ok_or_else(|| {
            AppError::Validation("Impossible de déterminer le début d'exercice.".into())
        })?,
    };
    if date_from > date_to {
        return Err(AppError::Validation(
            "date_from doit précéder ou être égale à date_to.".into(),
        ));
    }

    let exact_period: Option<String> = connection
        .query_row(
            "SELECT id FROM accounting_periods WHERE date_from=? AND date_to=? LIMIT 1",
            params![
                date_from.format("%Y-%m-%d").to_string(),
                date_to.format("%Y-%m-%d").to_string()
            ],
            |row| row.get(0),
        )
        .optional()?;

    if exact_period.is_some() {
        let previous: Option<(String, String, String)> = connection
            .query_row(
                "SELECT name,date_from,date_to FROM accounting_periods WHERE date_to<? ORDER BY date_to DESC LIMIT 1",
                params![date_from.format("%Y-%m-%d").to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((name, previous_from, previous_to)) = previous {
            return Ok(StatementScope {
                date_from: date_from.format("%Y-%m-%d").to_string(),
                date_to: date_to.format("%Y-%m-%d").to_string(),
                previous_date_from: previous_from,
                previous_date_to: previous_to,
                comparison_label: name,
                comparison_source: "registered_period",
            });
        }
    }

    let previous_from = previous_year(date_from)?;
    let previous_to = previous_year(date_to)?;
    Ok(StatementScope {
        date_from: date_from.format("%Y-%m-%d").to_string(),
        date_to: date_to.format("%Y-%m-%d").to_string(),
        previous_date_from: previous_from.format("%Y-%m-%d").to_string(),
        previous_date_to: previous_to.format("%Y-%m-%d").to_string(),
        comparison_label: format!("Exercice {}", previous_to.year()),
        comparison_source: "same_dates_previous_year",
    })
}

/// Refuse monetary aggregation whenever lines use a different currency from the local books.
/// Elyko has no exchange-rate ledger yet, so silently treating EUR cents as CHF cents would make
/// the statements materially wrong.
pub(crate) fn ensure_base_currency_for_ranges(
    connection: &Connection,
    ranges: &[(&str, &str)],
) -> AppResult<Value> {
    let base_currency: String = connection.query_row(
        "SELECT UPPER(TRIM(currency)) FROM settings WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    if base_currency != "CHF" {
        return Err(AppError::Validation(format!(
            "Clôture bloquée : la monnaie de tenue est {base_currency}. Elyko ne produit pas encore les contre-valeurs CHF et la documentation des cours de conversion requises pour des comptes suisses."
        )));
    }

    let mut currencies = Vec::<String>::new();
    for (date_from, date_to) in ranges {
        validate_date(date_from, "date_from")?;
        validate_date(date_to, "date_to")?;
        let mut statement = connection.prepare(
            "SELECT DISTINCT UPPER(TRIM(jl.currency)) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE je.entry_date BETWEEN ? AND ? AND (jl.debit_cents<>0 OR jl.credit_cents<>0) ORDER BY 1",
        )?;
        let values =
            statement.query_map(params![date_from, date_to], |row| row.get::<_, String>(0))?;
        for value in values {
            let value = value?;
            if !currencies.contains(&value) {
                currencies.push(value);
            }
        }
    }
    currencies.sort();
    let foreign = currencies
        .iter()
        .filter(|currency| currency.as_str() != base_currency)
        .cloned()
        .collect::<Vec<_>>();
    if !foreign.is_empty() {
        return Err(AppError::Validation(format!(
            "Agrégation comptable bloquée : le rapport en {base_currency} contient des lignes en {} et aucun cours de conversion traçable n'est enregistré. Corrigez la monnaie des écritures ou comptabilisez leur conversion avant la clôture.",
            foreign.join(", ")
        )));
    }
    Ok(json!({
        "base_currency": base_currency,
        "currencies": currencies,
        "single_currency": true,
        "exchange_rates_applied": false,
    }))
}

pub(crate) fn income_statement_report(
    connection: &Connection,
    filter: &PeriodFilter,
) -> AppResult<Value> {
    let scope = resolve_statement_scope(connection, filter)?;
    let currency = ensure_base_currency_for_ranges(
        connection,
        &[
            (&scope.date_from, &scope.date_to),
            (&scope.previous_date_from, &scope.previous_date_to),
        ],
    )?;
    let totals = statement_rows(connection, &scope, &["revenue", "expense"], false)?;

    let revenue = normal_amount_for_type(&totals.rows, "revenue", false);
    let expense = normal_amount_for_type(&totals.rows, "expense", false);
    let previous_revenue = normal_amount_for_type(&totals.rows, "revenue", true);
    let previous_expense = normal_amount_for_type(&totals.rows, "expense", true);
    let previous_has_activity = totals
        .rows
        .iter()
        .any(|row| row.previous_debit_cents != 0 || row.previous_credit_cents != 0);

    Ok(json!({
        "scope": scope_json(&scope, previous_has_activity),
        "currency": currency,
        "rows": rows_json(&totals.rows, true),
        "sections": totals.sections,
        "previous_sections": totals.previous_sections,
        "revenue_cents": revenue,
        "expense_cents": expense,
        "profit_cents": revenue - expense,
        "previous_revenue_cents": previous_revenue,
        "previous_expense_cents": previous_expense,
        "previous_profit_cents": previous_revenue - previous_expense,
    }))
}

pub(crate) fn balance_sheet_report(
    connection: &Connection,
    filter: &PeriodFilter,
) -> AppResult<Value> {
    let scope = resolve_statement_scope(connection, filter)?;
    // A balance sheet is cumulative. Checking from the first possible ISO date prevents a foreign
    // historical line from being silently folded into the CHF balances at either closing date.
    let currency = ensure_base_currency_for_ranges(connection, &[("0001-01-01", &scope.date_to)])?;
    let totals = statement_rows(connection, &scope, &["asset", "liability", "equity"], true)?;
    let income = income_statement_report(connection, filter)?;

    let assets = normal_amount_for_type(&totals.rows, "asset", false);
    let liabilities = normal_amount_for_type(&totals.rows, "liability", false);
    let equity = normal_amount_for_type(&totals.rows, "equity", false);
    let previous_assets = normal_amount_for_type(&totals.rows, "asset", true);
    let previous_liabilities = normal_amount_for_type(&totals.rows, "liability", true);
    let previous_equity = normal_amount_for_type(&totals.rows, "equity", true);
    let result = income["profit_cents"].as_i64().unwrap_or(0);
    let previous_result = income["previous_profit_cents"].as_i64().unwrap_or(0);
    let prior_results = profit_before(connection, &scope.date_from)?;
    let previous_prior_results = profit_before(connection, &scope.previous_date_from)?;
    let previous_has_activity = totals
        .rows
        .iter()
        .any(|row| row.previous_debit_cents != 0 || row.previous_credit_cents != 0)
        || income["scope"]["previous_has_activity"] == true;

    Ok(json!({
        "as_of": scope.date_to,
        "exercise_from": scope.date_from,
        "scope": scope_json(&scope, previous_has_activity),
        "currency": currency,
        "rows": rows_json(&totals.rows, false),
        "sections": totals.sections,
        "previous_sections": totals.previous_sections,
        "assets_cents": assets,
        "liabilities_cents": liabilities,
        "equity_cents": equity,
        "current_result_cents": result,
        "unallocated_prior_results_cents": prior_results,
        "balanced": assets == liabilities + equity + prior_results + result,
        "previous_assets_cents": previous_assets,
        "previous_liabilities_cents": previous_liabilities,
        "previous_equity_cents": previous_equity,
        "previous_current_result_cents": previous_result,
        "previous_unallocated_prior_results_cents": previous_prior_results,
        "previous_balanced": previous_assets == previous_liabilities + previous_equity + previous_prior_results + previous_result,
    }))
}

fn profit_before(connection: &Connection, date_from: &str) -> AppResult<i64> {
    validate_date(date_from, "date_from")?;
    connection
        .query_row(
            "SELECT COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN jl.credit_cents-jl.debit_cents WHEN a.account_type='expense' THEN jl.credit_cents-jl.debit_cents ELSE 0 END),0) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN accounts a ON a.id=jl.account_id WHERE je.entry_date<? AND a.account_type IN('revenue','expense')",
            params![date_from],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn statement_rows(
    connection: &Connection,
    scope: &StatementScope,
    account_types: &[&str],
    cumulative: bool,
) -> AppResult<StatementTotals> {
    let placeholders = std::iter::repeat_n("?", account_types.len())
        .collect::<Vec<_>>()
        .join(",");
    let (current_condition, previous_condition) = if cumulative {
        ("je.entry_date<=?", "je.entry_date<=?")
    } else {
        (
            "je.entry_date BETWEEN ? AND ?",
            "je.entry_date BETWEEN ? AND ?",
        )
    };
    let sql = format!(
        "SELECT a.id,a.code,a.name,a.account_type,a.normal_balance,a.report_section,\
         COALESCE(SUM(CASE WHEN {current_condition} THEN jl.debit_cents ELSE 0 END),0),\
         COALESCE(SUM(CASE WHEN {current_condition} THEN jl.credit_cents ELSE 0 END),0),\
         COALESCE(SUM(CASE WHEN {previous_condition} THEN jl.debit_cents ELSE 0 END),0),\
         COALESCE(SUM(CASE WHEN {previous_condition} THEN jl.credit_cents ELSE 0 END),0) \
         FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id \
         WHERE a.account_type IN ({placeholders}) GROUP BY a.id ORDER BY a.code"
    );
    let mut values = Vec::<rusqlite::types::Value>::new();
    if cumulative {
        // The current condition appears once for debit and once for credit, likewise previous.
        values.push(scope.date_to.clone().into());
        values.push(scope.date_to.clone().into());
        values.push(scope.previous_date_to.clone().into());
        values.push(scope.previous_date_to.clone().into());
    } else {
        for _ in 0..2 {
            values.push(scope.date_from.clone().into());
            values.push(scope.date_to.clone().into());
        }
        for _ in 0..2 {
            values.push(scope.previous_date_from.clone().into());
            values.push(scope.previous_date_to.clone().into());
        }
    }
    values.extend(
        account_types
            .iter()
            .map(|value| (*value).to_string().into()),
    );

    let mut statement = connection.prepare(&sql)?;
    let mapped = statement.query_map(rusqlite::params_from_iter(values), |row| {
        Ok(StatementAccountRow {
            id: row.get(0)?,
            code: row.get(1)?,
            name: row.get(2)?,
            account_type: row.get(3)?,
            normal_balance: row.get(4)?,
            report_section: row.get(5)?,
            debit_cents: row.get(6)?,
            credit_cents: row.get(7)?,
            previous_debit_cents: row.get(8)?,
            previous_credit_cents: row.get(9)?,
        })
    })?;
    let mut rows = mapped.collect::<Result<Vec<_>, _>>()?;
    rows.retain(|row| {
        row.debit_cents != 0
            || row.credit_cents != 0
            || row.previous_debit_cents != 0
            || row.previous_credit_cents != 0
    });
    let sections = group_sections(&rows, false, account_types);
    let previous_sections = group_sections(&rows, true, account_types);
    Ok(StatementTotals {
        rows,
        sections,
        previous_sections,
    })
}

fn rows_json(rows: &[StatementAccountRow], income: bool) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| {
                let current_amount = row_amount(row, false, income);
                let previous_amount = row_amount(row, true, income);
                json!({
                    "id": row.id,
                    "code": row.code,
                    "name": row.name,
                    "account_type": row.account_type,
                    "normal_balance": row.normal_balance,
                    "report_section": row.report_section,
                    "debit_cents": row.debit_cents,
                    "credit_cents": row.credit_cents,
                    "amount_cents": current_amount,
                    "previous_debit_cents": row.previous_debit_cents,
                    "previous_credit_cents": row.previous_credit_cents,
                    "previous_amount_cents": previous_amount,
                })
            })
            .collect(),
    )
}

fn group_sections(rows: &[StatementAccountRow], previous: bool, account_types: &[&str]) -> Value {
    let income = account_types.contains(&"revenue") || account_types.contains(&"expense");
    let mut sections = Map::new();
    for row in rows {
        let amount = row_amount(row, previous, income);
        let current = sections
            .get(&row.report_section)
            .and_then(Value::as_i64)
            .unwrap_or(0);
        sections.insert(row.report_section.clone(), json!(current + amount));
    }
    Value::Object(sections)
}

fn row_amount(row: &StatementAccountRow, previous: bool, income: bool) -> i64 {
    let (debit, credit) = if previous {
        (row.previous_debit_cents, row.previous_credit_cents)
    } else {
        (row.debit_cents, row.credit_cents)
    };
    if income {
        if row.account_type == "expense" {
            debit - credit
        } else {
            credit - debit
        }
    } else if row.account_type == "asset" {
        debit - credit
    } else {
        credit - debit
    }
}

fn normal_amount_for_type(rows: &[StatementAccountRow], account_type: &str, previous: bool) -> i64 {
    let income = matches!(account_type, "revenue" | "expense");
    rows.iter()
        .filter(|row| row.account_type == account_type)
        .map(|row| row_amount(row, previous, income))
        .sum()
}

fn scope_json(scope: &StatementScope, previous_has_activity: bool) -> Value {
    json!({
        "date_from": scope.date_from,
        "date_to": scope.date_to,
        "previous_date_from": scope.previous_date_from,
        "previous_date_to": scope.previous_date_to,
        "comparison_label": scope.comparison_label,
        "comparison_source": scope.comparison_source,
        "previous_has_activity": previous_has_activity,
    })
}

fn parse_date(value: &str, field: &str) -> AppResult<NaiveDate> {
    validate_date(value, field)?;
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::Validation(format!("{field} doit être au format AAAA-MM-JJ.")))
}

fn previous_year(date: NaiveDate) -> AppResult<NaiveDate> {
    date.with_year(date.year() - 1)
        .or_else(|| NaiveDate::from_ymd_opt(date.year() - 1, date.month(), 28))
        .ok_or_else(|| {
            AppError::Validation("Impossible de déterminer l'exercice précédent.".into())
        })
}

#[cfg(test)]
mod tests {
    use super::{
        balance_sheet_report, income_statement_report, previous_year, resolve_statement_scope,
    };
    use crate::models::PeriodFilter;
    use chrono::NaiveDate;
    use rusqlite::{params, Connection};

    #[test]
    fn previous_year_normalizes_leap_day() {
        assert_eq!(
            previous_year(NaiveDate::from_ymd_opt(2024, 2, 29).unwrap()).unwrap(),
            NaiveDate::from_ymd_opt(2023, 2, 28).unwrap()
        );
    }

    #[test]
    fn reports_compare_previous_exercise_and_limit_current_result() {
        let connection = accounting_connection();
        seed_balanced_entry(
            &connection,
            "e-2025-sale",
            "2025-06-01",
            "bank",
            "revenue",
            100_000,
            "CHF",
        );
        seed_balanced_entry(
            &connection,
            "e-2025-cost",
            "2025-06-02",
            "expense",
            "bank",
            40_000,
            "CHF",
        );
        seed_balanced_entry(
            &connection,
            "e-2026-sale",
            "2026-06-01",
            "bank",
            "revenue",
            150_000,
            "CHF",
        );
        seed_balanced_entry(
            &connection,
            "e-2026-cost",
            "2026-06-02",
            "expense",
            "bank",
            60_000,
            "CHF",
        );

        let filter = PeriodFilter {
            date_from: Some("2026-01-01".into()),
            date_to: Some("2026-12-31".into()),
        };
        let income = income_statement_report(&connection, &filter).unwrap();
        assert_eq!(income["profit_cents"], 90_000);
        assert_eq!(income["previous_profit_cents"], 60_000);
        assert_eq!(income["scope"]["previous_has_activity"], true);

        let balance = balance_sheet_report(&connection, &filter).unwrap();
        // The old report exposed the result since the first journal line (1500 CHF) as the
        // current result. The new report separates the selected 2026 result from prior results.
        assert_eq!(balance["current_result_cents"], 90_000);
        assert_eq!(balance["unallocated_prior_results_cents"], 60_000);
        assert_eq!(balance["previous_current_result_cents"], 60_000);
        assert_eq!(balance["assets_cents"], 150_000);
        assert_eq!(balance["balanced"], true);
    }

    #[test]
    fn report_refuses_foreign_currency_without_exchange_rate_ledger() {
        let connection = accounting_connection();
        seed_balanced_entry(
            &connection,
            "e-eur",
            "2026-06-01",
            "bank",
            "revenue",
            100_000,
            "EUR",
        );
        let error = income_statement_report(
            &connection,
            &PeriodFilter {
                date_from: Some("2026-01-01".into()),
                date_to: Some("2026-12-31".into()),
            },
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("Agrégation comptable bloquée"));
        assert!(error.contains("EUR"));
        assert!(error.contains("cours de conversion"));
    }

    #[test]
    fn exact_period_uses_previous_registered_exercise() {
        let connection = accounting_connection();
        connection.execute("INSERT INTO accounting_periods(id,name,date_from,date_to,status) VALUES('p25','Exercice court 2025','2025-02-01','2025-11-30','closed')", []).unwrap();
        connection.execute("INSERT INTO accounting_periods(id,name,date_from,date_to,status) VALUES('p26','Exercice 2026','2026-01-01','2026-12-31','open')", []).unwrap();
        let scope = resolve_statement_scope(
            &connection,
            &PeriodFilter {
                date_from: Some("2026-01-01".into()),
                date_to: Some("2026-12-31".into()),
            },
        )
        .unwrap();
        assert_eq!(scope.previous_date_from, "2025-02-01");
        assert_eq!(scope.previous_date_to, "2025-11-30");
        assert_eq!(scope.comparison_label, "Exercice court 2025");
        assert_eq!(scope.comparison_source, "registered_period");
    }

    fn accounting_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE settings(id INTEGER PRIMARY KEY,currency TEXT NOT NULL);
             INSERT INTO settings(id,currency) VALUES(1,'CHF');
             CREATE TABLE accounting_periods(id TEXT PRIMARY KEY,name TEXT NOT NULL,date_from TEXT NOT NULL,date_to TEXT NOT NULL,status TEXT NOT NULL);
             CREATE TABLE accounts(id TEXT PRIMARY KEY,code TEXT NOT NULL,name TEXT NOT NULL,account_type TEXT NOT NULL,normal_balance TEXT NOT NULL,report_section TEXT NOT NULL);
             CREATE TABLE journal_entries(id TEXT PRIMARY KEY,entry_date TEXT NOT NULL);
             CREATE TABLE journal_lines(id TEXT PRIMARY KEY,journal_entry_id TEXT NOT NULL,account_id TEXT NOT NULL,debit_cents INTEGER NOT NULL,credit_cents INTEGER NOT NULL,currency TEXT NOT NULL);
             INSERT INTO accounts VALUES('bank','1020','Banque','asset','debit','current_assets');
             INSERT INTO accounts VALUES('equity','2800','Fonds propres','equity','credit','equity');
             INSERT INTO accounts VALUES('revenue','3200','Produits','revenue','credit','net_revenue');
             INSERT INTO accounts VALUES('expense','4000','Charges','expense','debit','cost_of_goods');",
        ).unwrap();
        connection
    }

    fn seed_balanced_entry(
        connection: &Connection,
        id: &str,
        date: &str,
        debit_account: &str,
        credit_account: &str,
        amount: i64,
        currency: &str,
    ) {
        connection
            .execute(
                "INSERT INTO journal_entries(id,entry_date) VALUES(?,?)",
                params![id, date],
            )
            .unwrap();
        connection.execute(
            "INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_cents,credit_cents,currency) VALUES(?,?,?,?,0,?)",
            params![format!("{id}-d"), id, debit_account, amount, currency],
        ).unwrap();
        connection.execute(
            "INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_cents,credit_cents,currency) VALUES(?,?,?,0,?,?)",
            params![format!("{id}-c"), id, credit_account, amount, currency],
        ).unwrap();
    }
}
