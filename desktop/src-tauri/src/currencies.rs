//! Cours de change (CHF pour une unité de devise) et contre-valeur CHF des
//! écritures en devise. Le journal garde les montants du document ; la
//! contre-valeur est calculée ici, de façon déterministe, avec le cours saisi
//! pour la date de l'écriture. Un paiement solde la créance (ou la dette) au
//! cours du document : l'écart avec le cours du jour du paiement est la
//! différence de change réalisée, comptée en 6950 (gain) ou 6900 (perte).

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{command_error, AppError, AppResult},
};

/// Un cours vaut pour les 31 jours qui suivent sa date (cours mensuel de l'ESTV).
pub(crate) const RATE_VALIDITY_DAYS: i64 = 31;
const SCALE: i128 = 1_000_000;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// Montant CHF arrondi au centime (demi-centime vers l'extérieur).
pub(crate) fn to_chf(cents: i64, rate_micro: i64) -> i64 {
    let product = cents as i128 * rate_micro as i128;
    let rounded = if product >= 0 { (product + SCALE / 2) / SCALE } else { -((-product + SCALE / 2) / SCALE) };
    rounded as i64
}

/// Cours en vigueur à la date : le plus récent, au plus 31 jours avant.
pub(crate) fn rate_on(connection: &Connection, currency: &str, date: &str) -> AppResult<Option<(i64, String)>> {
    Ok(connection
        .query_row(
            "SELECT chf_per_unit_micro,rate_date FROM exchange_rates WHERE currency=? AND rate_date<=? AND rate_date>=date(?,?) ORDER BY rate_date DESC LIMIT 1",
            params![currency, date, date, format!("-{RATE_VALIDITY_DAYS} day")],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

fn base_is_chf(connection: &Connection) -> AppResult<bool> {
    let base: String = connection.query_row("SELECT UPPER(TRIM(currency)) FROM settings WHERE id=1", [], |row| row.get(0))?;
    Ok(base == "CHF")
}

struct Line {
    id: String,
    account_id: String,
    debit: i64,
    credit: i64,
    currency: String,
    client_id: Option<String>,
}

struct Converted {
    line: usize,
    rate: i64,
    rate_date: String,
    debit: i64,
    credit: i64,
}

fn lines_of(connection: &Connection, entry_id: &str) -> AppResult<Vec<Line>> {
    let mut statement = connection.prepare(
        "SELECT id,account_id,debit_cents,credit_cents,UPPER(TRIM(currency)),client_id FROM journal_lines WHERE journal_entry_id=? ORDER BY rowid",
    )?;
    let rows = statement.query_map([entry_id], |row| {
        Ok(Line { id: row.get(0)?, account_id: row.get(1)?, debit: row.get(2)?, credit: row.get(3)?, currency: row.get(4)?, client_id: row.get(5)? })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn account_by_code(connection: &Connection, code: &str) -> AppResult<Option<String>> {
    Ok(connection
        .query_row("SELECT id FROM accounts WHERE code=? AND active=1 ORDER BY id LIMIT 1", [code], |row| row.get(0))
        .optional()?)
}

/// Cours appliqués à l'écriture du document que ce paiement règle, par compte.
fn document_rates(connection: &Connection, source_type: &str, source_event: &str) -> AppResult<BTreeMap<String, (i64, String)>> {
    let document_type = match source_type {
        "payment" => "invoice",
        "supplier_payment" => "supplier_invoice",
        _ => return Ok(BTreeMap::new()),
    };
    let Some(document_id) = source_event.strip_prefix("invoice:") else { return Ok(BTreeMap::new()) };
    let mut statement = connection.prepare(
        "SELECT l.account_id,c.chf_per_unit_micro,c.rate_date FROM journal_entries e
           JOIN journal_lines l ON l.journal_entry_id=e.id
           JOIN journal_line_conversions c ON c.journal_line_id=l.id
          WHERE e.source_type=? AND e.source_id=? AND e.reversal_of IS NULL
          ORDER BY e.entry_date,e.rowid,l.rowid",
    )?;
    let rows = statement.query_map(params![document_type, document_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)))?;
    let mut rates = BTreeMap::new();
    for row in rows {
        let (account, rate, date) = row?;
        rates.entry(account).or_insert((rate, date));
    }
    Ok(rates)
}

/// Le document réglé est en devise mais pas encore converti : le paiement attend son cours.
fn document_waiting(connection: &Connection, source_type: &str, source_event: &str) -> AppResult<bool> {
    let document_type = match source_type {
        "payment" => "invoice",
        "supplier_payment" => "supplier_invoice",
        _ => return Ok(false),
    };
    let Some(document_id) = source_event.strip_prefix("invoice:") else { return Ok(false) };
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id=e.id
           WHERE e.source_type=? AND e.source_id=? AND e.reversal_of IS NULL AND UPPER(TRIM(l.currency))<>'CHF'
             AND NOT EXISTS(SELECT 1 FROM journal_line_conversions c WHERE c.journal_entry_id=e.id))",
        params![document_type, document_id],
        |row| row.get(0),
    )?)
}

/// Contre-valeur CHF d'une écriture en devise. Renvoie false si un cours manque
/// (l'écriture reste en attente) ; ne fait rien si elle est déjà convertie.
pub(crate) fn convert_entry(connection: &Connection, entry_id: &str) -> AppResult<bool> {
    // Date de création de l'écriture : deux appareils qui convertissent la même écriture
    // au même cours produisent exactement les mêmes lignes.
    let (date, source_type, source_event, reversal_of, now): (String, String, String, Option<String>, String) = connection.query_row(
        "SELECT entry_date,source_type,source_event,reversal_of,created_at FROM journal_entries WHERE id=?",
        [entry_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    )?;
    let lines = lines_of(connection, entry_id)?;
    if lines.iter().all(|line| line.currency == "CHF") || !base_is_chf(connection)? {
        return Ok(true);
    }
    let done: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM journal_line_conversions WHERE journal_entry_id=?)", [entry_id], |row| row.get(0))?;
    if done {
        return Ok(true);
    }
    if let Some(original) = reversal_of {
        return mirror_reversal(connection, entry_id, &original, &lines, &now);
    }
    // Paiement d'un document en devise : la créance ou la dette au cours du document.
    let historic = document_rates(connection, &source_type, &source_event)?;
    if historic.is_empty() && document_waiting(connection, &source_type, &source_event)? {
        return Ok(false);
    }
    let mut converted = Vec::new();
    let mut rates_used = std::collections::BTreeSet::new();
    for (index, line) in lines.iter().enumerate() {
        if line.currency == "CHF" {
            continue;
        }
        let rate = match historic.get(&line.account_id) {
            Some(rate) => Some(rate.clone()),
            None => rate_on(connection, &line.currency, &date)?,
        };
        let Some((rate, rate_date)) = rate else { return Ok(false) };
        rates_used.insert(rate);
        converted.push(Converted { line: index, rate, rate_date, debit: to_chf(line.debit, rate), credit: to_chf(line.credit, rate) });
    }
    if converted.iter().any(|row| row.debit + row.credit == 0) {
        return Ok(false);
    }
    let chf_lines = lines.iter().enumerate().filter(|(_, line)| line.currency == "CHF");
    let debit: i64 = converted.iter().map(|row| row.debit).sum::<i64>() + chf_lines.clone().map(|(_, line)| line.debit).sum::<i64>();
    let credit: i64 = converted.iter().map(|row| row.credit).sum::<i64>() + chf_lines.map(|(_, line)| line.credit).sum::<i64>();
    let gap = debit - credit;
    let mut adjustment: Option<(String, i64, i64, &'static str)> = None;
    if gap != 0 {
        let realised = rates_used.len() > 1;
        let account = if realised { account_by_code(connection, if gap > 0 { "6950" } else { "6900" })? } else { None };
        match account {
            Some(account) => adjustment = Some((account, (-gap).max(0), gap.max(0), if gap > 0 { "Gain de change" } else { "Perte de change" })),
            None => {
                // Arrondi : le centime va sur la plus grande ligne du côté le plus faible.
                let side_debit = gap < 0;
                let target = converted
                    .iter_mut()
                    .filter(|row| if side_debit { row.debit > 0 } else { row.credit > 0 })
                    .max_by_key(|row| row.debit + row.credit)
                    .ok_or_else(|| invalid("Écriture en devise sans ligne à ajuster."))?;
                if side_debit { target.debit += -gap } else { target.credit += gap }
            }
        }
    }
    for row in &converted {
        let line = &lines[row.line];
        connection.execute(
            "INSERT INTO journal_line_conversions(journal_line_id,journal_entry_id,currency,rate_date,chf_per_unit_micro,chf_debit_cents,chf_credit_cents,created_at) VALUES(?,?,?,?,?,?,?,?)",
            params![line.id, entry_id, line.currency, row.rate_date, row.rate, row.debit, row.credit, now],
        )?;
    }
    if let Some((account, debit, credit, memo)) = adjustment {
        let client = lines.iter().find_map(|line| line.client_id.clone());
        connection.execute(
            "INSERT INTO journal_fx_adjustments(id,journal_entry_id,account_id,chf_debit_cents,chf_credit_cents,memo,client_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
            params![format!("fx-{entry_id}"), entry_id, account, debit, credit, memo, client, now],
        )?;
    }
    Ok(true)
}

/// L'extourne reprend exactement la contre-valeur de l'écriture d'origine.
fn mirror_reversal(connection: &Connection, entry_id: &str, original: &str, lines: &[Line], now: &str) -> AppResult<bool> {
    let mut statement = connection.prepare(
        "SELECT l.account_id,l.debit_cents,l.credit_cents,c.currency,c.rate_date,c.chf_per_unit_micro,c.chf_debit_cents,c.chf_credit_cents
           FROM journal_lines l JOIN journal_line_conversions c ON c.journal_line_id=l.id WHERE l.journal_entry_id=? ORDER BY l.rowid",
    )?;
    let mut sources = statement
        .query_map([original], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, i64>(5)?, row.get::<_, i64>(6)?, row.get::<_, i64>(7)?))
        })?
        .map(|row| row.map(Some))
        .collect::<Result<Vec<_>, _>>()?;
    if sources.is_empty() {
        return Ok(false);
    }
    let mut rows = Vec::new();
    for line in lines.iter().filter(|line| line.currency != "CHF") {
        let found = sources.iter_mut().find(|source| {
            source.as_ref().is_some_and(|(account, debit, credit, currency, ..)| *account == line.account_id && *debit == line.credit && *credit == line.debit && *currency == line.currency)
        });
        let Some(source) = found.and_then(Option::take) else { return Ok(false) };
        rows.push((line.id.clone(), source));
    }
    for (line_id, (_, _, _, currency, rate_date, rate, chf_debit, chf_credit)) in rows {
        connection.execute(
            "INSERT INTO journal_line_conversions(journal_line_id,journal_entry_id,currency,rate_date,chf_per_unit_micro,chf_debit_cents,chf_credit_cents,created_at) VALUES(?,?,?,?,?,?,?,?)",
            params![line_id, entry_id, currency, rate_date, rate, chf_credit, chf_debit, now],
        )?;
    }
    let adjustment = connection
        .query_row("SELECT account_id,chf_debit_cents,chf_credit_cents,memo,client_id FROM journal_fx_adjustments WHERE journal_entry_id=?", [original], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?))
        })
        .optional()?;
    if let Some((account, debit, credit, memo, client)) = adjustment {
        connection.execute(
            "INSERT INTO journal_fx_adjustments(id,journal_entry_id,account_id,chf_debit_cents,chf_credit_cents,memo,client_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
            params![format!("fx-{entry_id}"), entry_id, account, credit, debit, format!("Extourne · {memo}"), client, now],
        )?;
    }
    Ok(true)
}

/// Convertit les écritures en devise encore en attente (périodes ouvertes), dans l'ordre des dates.
pub(crate) fn convert_pending(connection: &Connection) -> AppResult<usize> {
    if !base_is_chf(connection)? {
        return Ok(0);
    }
    let pending = query_all(
        connection,
        "SELECT DISTINCT e.id,e.entry_date,e.rowid AS position FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id=e.id
          WHERE UPPER(TRIM(l.currency))<>'CHF'
            AND NOT EXISTS(SELECT 1 FROM journal_line_conversions c WHERE c.journal_entry_id=e.id)
            AND NOT EXISTS(SELECT 1 FROM accounting_periods p WHERE p.status='closed' AND e.entry_date BETWEEN p.date_from AND p.date_to)
          ORDER BY e.entry_date,position",
        [],
    )?;
    let mut converted = 0;
    for row in pending {
        if convert_entry(connection, row["id"].as_str().unwrap_or_default())? {
            converted += 1;
        }
    }
    Ok(converted)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExchangeRateInput {
    pub currency: String,
    pub rate_date: String,
    /// CHF pour une unité, en millionièmes (0.9412 CHF = 941200).
    pub chf_per_unit_micro: i64,
}

impl LocalStore {
    pub fn list_exchange_rates(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let rates = query_all(
            &connection,
            "SELECT r.currency,r.rate_date,r.chf_per_unit_micro,r.source,
                    EXISTS(SELECT 1 FROM journal_line_conversions c WHERE c.currency=r.currency AND c.rate_date=r.rate_date) AS used
               FROM exchange_rates r ORDER BY r.rate_date DESC,r.currency LIMIT 240",
            [],
        )?;
        let pending = query_all(
            &connection,
            "SELECT UPPER(TRIM(l.currency)) AS currency,COUNT(DISTINCT e.id) AS entries,MIN(e.entry_date) AS first_date,MAX(e.entry_date) AS last_date
               FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id=e.id
              WHERE UPPER(TRIM(l.currency))<>'CHF' AND NOT EXISTS(SELECT 1 FROM journal_line_conversions c WHERE c.journal_entry_id=e.id)
              GROUP BY 1 ORDER BY 1",
            [],
        )?;
        let realised = query_all(
            &connection,
            "SELECT strftime('%Y',e.entry_date) AS year,COALESCE(SUM(a.chf_credit_cents),0) AS gain_cents,COALESCE(SUM(a.chf_debit_cents),0) AS loss_cents
               FROM journal_fx_adjustments a JOIN journal_entries e ON e.id=a.journal_entry_id JOIN accounts acc ON acc.id=a.account_id
              WHERE acc.code IN ('6900','6950') GROUP BY 1 ORDER BY 1 DESC LIMIT 3",
            [],
        )?;
        Ok(json!({ "rates": rates, "pending": pending, "realised": realised, "validityDays": RATE_VALIDITY_DAYS }))
    }

    pub fn save_exchange_rate(&self, input: ExchangeRateInput) -> AppResult<Value> {
        let currency = input.currency.trim().to_uppercase();
        if !matches!(currency.as_str(), "EUR") {
            return Err(invalid("Zentra gère pour l'instant les documents en CHF et en EUR : saisissez un cours EUR."));
        }
        crate::accounting::validate_date(&input.rate_date, "rate_date")?;
        if !(1..=1_000_000_000).contains(&input.chf_per_unit_micro) {
            return Err(invalid("Le cours doit être compris entre 0.000001 et 1000 CHF pour une unité."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let used: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM journal_line_conversions WHERE currency=? AND rate_date=?)",
            params![currency, input.rate_date],
            |row| row.get(0),
        )?;
        if used {
            return Err(invalid("Ce cours est déjà appliqué à des écritures : saisissez plutôt un cours à une autre date."));
        }
        tx.execute(
            "INSERT INTO exchange_rates(currency,rate_date,chf_per_unit_micro,source,created_at) VALUES(?,?,?,'manual',?)
             ON CONFLICT(currency,rate_date) DO UPDATE SET chf_per_unit_micro=excluded.chf_per_unit_micro,source=excluded.source",
            params![currency, input.rate_date, input.chf_per_unit_micro, now_iso()],
        )?;
        let converted = convert_pending(&tx)?;
        append_audit(
            &tx,
            "save_exchange_rate",
            "exchange_rates",
            &format!("{currency}:{}", input.rate_date),
            &json!({ "currency": currency, "rate_date": input.rate_date, "chf_per_unit_micro": input.chf_per_unit_micro, "converted_entries": converted }),
        )?;
        tx.commit()?;
        Ok(json!({ "converted": converted }))
    }

    pub fn delete_exchange_rate(&self, currency: &str, rate_date: &str) -> AppResult<()> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let removed = tx.execute("DELETE FROM exchange_rates WHERE currency=? AND rate_date=?", params![currency, rate_date])?;
        if removed == 0 {
            return Err(invalid("Cours introuvable."));
        }
        append_audit(&tx, "delete_exchange_rate", "exchange_rates", &format!("{currency}:{rate_date}"), &json!({}))?;
        tx.commit()?;
        Ok(())
    }
}

#[tauri::command]
pub fn list_exchange_rates(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_exchange_rates().map_err(command_error)
}

#[tauri::command]
pub fn save_exchange_rate(state: tauri::State<'_, LocalStore>, input: ExchangeRateInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_exchange_rate(input).map_err(command_error)
}

#[tauri::command]
pub fn delete_exchange_rate(state: tauri::State<'_, LocalStore>, currency: String, rate_date: String) -> Result<(), String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.delete_exchange_rate(&currency, &rate_date).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_is_half_away_from_zero() {
        assert_eq!(to_chf(100_000, 941_200), 94_120);
        assert_eq!(to_chf(1, 500_000), 1);
        assert_eq!(to_chf(1, 499_999), 0);
        assert_eq!(to_chf(-1, 500_000), -1);
        assert_eq!(to_chf(123_456, 1_000_000), 123_456);
    }

    fn line(account: &str, debit: i64, credit: i64) -> crate::accounting::EntryLine {
        crate::accounting::EntryLine { account_id: account.into(), debit_cents: debit, credit_cents: credit, currency: "EUR".into(), memo: None, project_id: None, client_id: None, employee_id: None }
    }

    fn post(store: &LocalStore, date: &str, source: (&str, &str, &str), lines: Vec<crate::accounting::EntryLine>) -> String {
        let mut connection = store.connect().unwrap();
        let tx = connection.transaction().unwrap();
        let entry = crate::accounting::post_entry(&tx, date, "Test devise", source.0, source.1, source.2, lines).unwrap();
        tx.commit().unwrap();
        entry["id"].as_str().unwrap().to_owned()
    }

    fn chf(store: &LocalStore, account: &str) -> i64 {
        store.connect().unwrap().query_row("SELECT COALESCE(SUM(debit_cents-credit_cents),0) FROM journal_lines_chf WHERE account_id=?", [account], |row| row.get(0)).unwrap()
    }

    #[test]
    fn eur_invoice_and_payment_are_valued_in_chf_with_the_realised_difference() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "currencies-test").unwrap();
        let a = crate::tests::enable_accounting(&store);
        for (code, name, kind, normal) in [("6900", "Charges financières", "expense", "debit"), ("6950", "Produits financiers", "revenue", "credit")] {
            store.upsert_account(crate::models::AccountInput { id: None, code: code.into(), name: name.into(), account_type: kind.into(), normal_balance: normal.into(), report_section: "financial_result".into(), active: true }).unwrap();
        }
        let gain: String = store.connect().unwrap().query_row("SELECT id FROM accounts WHERE code='6950'", [], |row| row.get(0)).unwrap();
        // Sans cours : la facture attend, les rapports CHF la refusent.
        let invoice = post(&store, "2026-09-10", ("invoice", "inv-eur", "issue"), vec![line(&a["ar"], 108_100, 0), line(&a["revenue"], 0, 100_000), line(&a["vat_payable"], 0, 8_100)]);
        let filter = crate::models::PeriodFilter { date_from: Some("2026-01-01".into()), date_to: Some("2026-12-31".into()) };
        assert!(store.get_trial_balance(filter.clone()).unwrap_err().to_string().contains("EUR"));
        assert_eq!(store.list_exchange_rates().unwrap()["pending"][0]["entries"], 1);
        // Le cours de septembre convertit l'écriture en attente ; arrondi équilibré.
        let saved = store.save_exchange_rate(ExchangeRateInput { currency: "EUR".into(), rate_date: "2026-09-01".into(), chf_per_unit_micro: 941_234 }).unwrap();
        assert_eq!(saved["converted"], 1);
        assert_eq!(chf(&store, &a["ar"]), 101_747);
        assert_eq!(chf(&store, &a["revenue"]), -94_123);
        assert_eq!(chf(&store, &a["vat_payable"]), -7_624);
        // Paiement en octobre à un cours plus haut : la créance est soldée au cours de la facture.
        store.save_exchange_rate(ExchangeRateInput { currency: "EUR".into(), rate_date: "2026-10-01".into(), chf_per_unit_micro: 950_000 }).unwrap();
        let payment = post(&store, "2026-10-05", ("payment", "pay-eur", "invoice:inv-eur"), vec![line(&a["bank"], 108_100, 0), line(&a["ar"], 0, 108_100)]);
        assert_eq!(chf(&store, &a["ar"]), 0);
        assert_eq!(chf(&store, &a["bank"]), 102_695);
        assert_eq!(chf(&store, &gain), -948);
        let trial = store.get_trial_balance(filter).unwrap();
        assert_eq!(trial["balanced"], true);
        assert_eq!(trial["currency"]["base_currency"], "CHF");
        assert_eq!(trial["currency"]["exchange_rates_applied"], true);
        // Un cours appliqué ne change plus ; le journal garde les montants EUR du document.
        assert!(store.save_exchange_rate(ExchangeRateInput { currency: "EUR".into(), rate_date: "2026-09-01".into(), chf_per_unit_micro: 1_000_000 }).is_err());
        assert!(store.delete_exchange_rate("EUR", "2026-10-01").is_err());
        let original: i64 = store.connect().unwrap().query_row("SELECT debit_cents FROM journal_lines WHERE journal_entry_id=? AND account_id=?", params![invoice, a["ar"]], |row| row.get(0)).unwrap();
        assert_eq!(original, 108_100);
        let adjustments: i64 = store.connect().unwrap().query_row("SELECT COUNT(*) FROM journal_fx_adjustments WHERE journal_entry_id=?", [&payment], |row| row.get(0)).unwrap();
        assert_eq!(adjustments, 1);
        assert_eq!(convert_pending(&store.connect().unwrap()).unwrap(), 0);
    }
}
