//! Livre de caisse (espèces) avec comptage du soir, et registre des contrats.
//! Le solde attendu est calculé ici : écritures de caisse et encaissements de
//! factures payées en espèces. Un écart de comptage n'est corrigé qu'au clic,
//! par une écriture liée au comptage. Rien n'est jamais réécrit.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    accounting::validate_date,
    audit::append_audit,
    database::{now_iso, query_record_tx, LocalStore},
    error::{command_error, AppError, AppResult},
};

/// Billets et pièces suisses, en centimes.
pub(crate) const DENOMINATIONS: &[i64] = &[100_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50, 20, 10, 5];
const MAX_CENTS: i64 = 100_000_000_000;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// Mode de paiement en espèces, dans les quatre langues de l'app.
pub(crate) fn is_cash_method(method: &str) -> bool {
    let lower = method.to_lowercase();
    lower
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| matches!(word, "espèces" | "especes" | "espèce" | "espece" | "cash" | "bargeld" | "bar" | "contanti" | "contante" | "contant" | "caisse" | "kasse" | "cassa"))
}

/// Solde attendu en fin de journée `date`.
pub(crate) fn expected_balance(connection: &Connection, date: &str) -> AppResult<i64> {
    let entries: i64 = connection.query_row(
        "SELECT COALESCE(SUM(amount_cents),0) FROM cash_book_entries WHERE entry_date<=?",
        [date],
        |row| row.get(0),
    )?;
    let mut statement = connection.prepare(
        "SELECT p.amount_cents,COALESCE(p.method,'') FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status<>'annulee' AND p.date<=?",
    )?;
    let payments = statement
        .query_map([date], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let cash: i64 = payments.into_iter().filter(|(_, method)| is_cash_method(method)).map(|(amount, _)| amount).sum();
    Ok(entries + cash)
}

/// Total d'un comptage par coupure. Une coupure inconnue est refusée.
pub(crate) fn counted_total(denominations: &BTreeMap<String, i64>) -> AppResult<i64> {
    let mut total = 0_i64;
    for (value, count) in denominations {
        let cents: i64 = value.parse().map_err(|_| invalid("Coupure illisible."))?;
        if !DENOMINATIONS.contains(&cents) {
            return Err(invalid(format!("Coupure inconnue : {cents} centimes.")));
        }
        if !(0..=100_000).contains(count) {
            return Err(invalid("Le nombre de billets ou de pièces doit être entre 0 et 100 000."));
        }
        total += cents * count;
    }
    Ok(total)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CashEntryInput {
    pub entry_date: String,
    pub kind: String,
    /// Montant positif ; le sens vient du type de mouvement.
    pub amount_cents: i64,
    pub description: String,
    #[serde(default)]
    pub reference: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CashCountInput {
    pub count_date: String,
    pub denominations: BTreeMap<String, i64>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContractInput {
    #[serde(default)]
    pub id: Option<String>,
    pub side: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub supplier_id: Option<String>,
    pub party_name: String,
    pub title: String,
    pub start_date: String,
    #[serde(default)]
    pub end_date: Option<String>,
    pub notice_months: i64,
    pub auto_renew: bool,
    pub renewal_months: i64,
    pub amount_cents: i64,
    pub currency: String,
    pub frequency: String,
    #[serde(default)]
    pub indexation: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

fn optional_text(value: Option<String>, max: usize, label: &str) -> AppResult<Option<String>> {
    let value = value.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
    if value.as_ref().is_some_and(|text| text.chars().count() > max) {
        return Err(invalid(format!("{label} : {max} caractères au maximum.")));
    }
    Ok(value)
}

impl LocalStore {
    pub fn add_cash_entry(&self, input: CashEntryInput) -> AppResult<Value> {
        validate_date(&input.entry_date, "entry_date")?;
        let sign = match input.kind.as_str() {
            "opening" | "receipt" | "bank_withdrawal" => 1,
            "expense" | "bank_deposit" => -1,
            _ => return Err(invalid("Type de mouvement de caisse inconnu.")),
        };
        if input.amount_cents <= 0 || input.amount_cents > MAX_CENTS {
            return Err(invalid("Le montant doit être positif."));
        }
        let description = input.description.trim().to_owned();
        if description.is_empty() || description.chars().count() > 300 {
            return Err(invalid("Décrivez le mouvement en 300 caractères au maximum."));
        }
        let reference = optional_text(input.reference, 100, "Référence")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if input.kind == "opening" {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM cash_book_entries WHERE kind='opening')", [], |row| row.get(0))?;
            if exists {
                return Err(invalid("Le fond de caisse initial est déjà saisi. Corrigez-le par un comptage."));
            }
        }
        let amount = sign * input.amount_cents;
        if sign < 0 && expected_balance(&tx, &input.entry_date)? + amount < 0 {
            return Err(invalid("La caisse n'a pas assez d'espèces pour cette sortie à cette date. Vérifiez le montant ou comptez la caisse."));
        }
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO cash_book_entries(id,entry_date,kind,amount_cents,description,reference,created_at) VALUES(?,?,?,?,?,?,?)",
            params![id, input.entry_date, input.kind, amount, description, reference, now_iso()],
        )?;
        let record = query_record_tx(&tx, "cash_book_entries", &id)?;
        append_audit(&tx, "create", "cash_book_entry", &id, &record)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn record_cash_count(&self, input: CashCountInput) -> AppResult<Value> {
        validate_date(&input.count_date, "count_date")?;
        let counted = counted_total(&input.denominations)?;
        let note = optional_text(input.note, 500, "Note")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected = expected_balance(&tx, &input.count_date)?;
        let id = Uuid::new_v4().to_string();
        let denominations: BTreeMap<&String, &i64> = input.denominations.iter().filter(|(_, count)| **count > 0).collect();
        tx.execute(
            "INSERT INTO cash_counts(id,count_date,counted_cents,expected_cents,difference_cents,denominations_json,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
            params![id, input.count_date, counted, expected, counted - expected, serde_json::to_string(&denominations)?, note, now_iso()],
        )?;
        let record = query_record_tx(&tx, "cash_counts", &id)?;
        append_audit(&tx, "count", "cash_count", &id, &record)?;
        tx.commit()?;
        Ok(record)
    }

    /// Aligne le livre de caisse sur un comptage, après le clic de l'utilisateur.
    pub fn correct_cash_count(&self, count_id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count: Option<(String, i64)> = tx
            .query_row("SELECT count_date,difference_cents FROM cash_counts WHERE id=?", [count_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let (date, difference) = count.ok_or_else(|| invalid("Comptage introuvable."))?;
        if let Some(existing) = tx
            .query_row("SELECT id FROM cash_book_entries WHERE count_id=?", [count_id], |row| row.get::<_, String>(0))
            .optional()?
        {
            let record = query_record_tx(&tx, "cash_book_entries", &existing)?;
            tx.commit()?;
            return Ok(record);
        }
        if difference == 0 {
            return Err(invalid("Ce comptage n'a pas d'écart."));
        }
        let later: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM cash_counts WHERE count_date>? OR (count_date=? AND created_at>(SELECT created_at FROM cash_counts WHERE id=?)))", params![date, date, count_id], |row| row.get(0))?;
        if later {
            return Err(invalid("Un comptage plus récent existe : corrigez plutôt celui-là."));
        }
        let id = Uuid::new_v4().to_string();
        let description = if difference > 0 { "Excédent de caisse constaté au comptage" } else { "Manque de caisse constaté au comptage" };
        tx.execute(
            "INSERT INTO cash_book_entries(id,entry_date,kind,amount_cents,description,count_id,created_at) VALUES(?,?,'correction',?,?,?,?)",
            params![id, date, difference, description, count_id, now_iso()],
        )?;
        let record = query_record_tx(&tx, "cash_book_entries", &id)?;
        append_audit(&tx, "correct", "cash_count", count_id, &record)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn save_contract(&self, input: ContractInput) -> AppResult<Value> {
        if !matches!(input.side.as_str(), "customer" | "supplier") {
            return Err(invalid("Choisissez un contrat client ou fournisseur."));
        }
        validate_date(&input.start_date, "start_date")?;
        let end_date = input.end_date.filter(|value| !value.trim().is_empty());
        if let Some(end) = &end_date {
            validate_date(end, "end_date")?;
            if end <= &input.start_date {
                return Err(invalid("La fin du contrat doit suivre son début."));
            }
        }
        let party_name = input.party_name.trim().to_owned();
        let title = input.title.trim().to_owned();
        if party_name.is_empty() || party_name.chars().count() > 200 || title.is_empty() || title.chars().count() > 200 {
            return Err(invalid("Indiquez le partenaire et l'objet du contrat."));
        }
        if !(0..=36).contains(&input.notice_months) || !(1..=120).contains(&input.renewal_months) {
            return Err(invalid("Le préavis va de 0 à 36 mois et la reconduction de 1 à 120 mois."));
        }
        if !(0..=MAX_CENTS).contains(&input.amount_cents) || !matches!(input.currency.as_str(), "CHF" | "EUR")
            || !matches!(input.frequency.as_str(), "monthly" | "quarterly" | "yearly" | "once")
        {
            return Err(invalid("Vérifiez le montant, la devise et la périodicité."));
        }
        let indexation = optional_text(input.indexation, 200, "Indexation")?;
        let note = optional_text(input.note, 2000, "Note")?;
        let (client_id, supplier_id) = if input.side == "customer" { (input.client_id.filter(|v| !v.is_empty()), None) } else { (None, input.supplier_id.filter(|v| !v.is_empty())) };
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        let id = match input.id.filter(|value| !value.is_empty()) {
            Some(id) => {
                let changed = tx.execute(
                    "UPDATE contracts SET side=?,client_id=?,supplier_id=?,party_name=?,title=?,start_date=?,end_date=?,notice_months=?,auto_renew=?,renewal_months=?,amount_cents=?,currency=?,frequency=?,indexation=?,note=?,updated_at=? WHERE id=? AND status='active'",
                    params![input.side, client_id, supplier_id, party_name, title, input.start_date, end_date, input.notice_months, input.auto_renew, input.renewal_months, input.amount_cents, input.currency, input.frequency, indexation, note, now, id],
                )?;
                if changed != 1 {
                    return Err(invalid("Ce contrat est résilié ou introuvable ; il ne se modifie plus."));
                }
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO contracts(id,side,client_id,supplier_id,party_name,title,start_date,end_date,notice_months,auto_renew,renewal_months,amount_cents,currency,frequency,indexation,note,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)",
                    params![id, input.side, client_id, supplier_id, party_name, title, input.start_date, end_date, input.notice_months, input.auto_renew, input.renewal_months, input.amount_cents, input.currency, input.frequency, indexation, note, now, now],
                )?;
                id
            }
        };
        let record = query_record_tx(&tx, "contracts", &id)?;
        append_audit(&tx, "save", "contract", &id, &record)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn terminate_contract(&self, id: &str, terminated_on: &str) -> AppResult<Value> {
        validate_date(terminated_on, "terminated_on")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE contracts SET status='terminated',terminated_on=?,updated_at=? WHERE id=? AND status='active'",
            params![terminated_on, now_iso(), id],
        )?;
        if changed != 1 {
            return Err(invalid("Ce contrat est déjà résilié ou introuvable."));
        }
        let record = query_record_tx(&tx, "contracts", id)?;
        append_audit(&tx, "terminate", "contract", id, &json!({"terminated_on": terminated_on}))?;
        tx.commit()?;
        Ok(record)
    }
}

#[tauri::command]
pub fn add_cash_entry(state: tauri::State<'_, LocalStore>, input: CashEntryInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.add_cash_entry(input).map_err(command_error)
}

#[tauri::command]
pub fn record_cash_count(state: tauri::State<'_, LocalStore>, input: CashCountInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.record_cash_count(input).map_err(command_error)
}

#[tauri::command]
pub fn correct_cash_count(state: tauri::State<'_, LocalStore>, count_id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.correct_cash_count(&count_id).map_err(command_error)
}

#[tauri::command]
pub fn save_contract(state: tauri::State<'_, LocalStore>, input: ContractInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_contract(input).map_err(command_error)
}

#[tauri::command]
pub fn terminate_contract(state: tauri::State<'_, LocalStore>, id: String, terminated_on: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.terminate_contract(&id, &terminated_on).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "cash-book-test").unwrap();
        (temporary, store)
    }

    fn entry(date: &str, kind: &str, cents: i64) -> CashEntryInput {
        CashEntryInput { entry_date: date.into(), kind: kind.into(), amount_cents: cents, description: format!("{kind} {cents}"), reference: None }
    }

    #[test]
    fn cash_methods_in_four_languages() {
        for method in ["Espèces", "especes", "Cash", "Bargeld", "bar", "Contanti", "Caisse"] {
            assert!(is_cash_method(method), "{method}");
        }
        for method in ["Virement", "TWINT / carte (Payrexx)", "Banque", "barrière"] {
            assert!(!is_cash_method(method), "{method}");
        }
    }

    #[test]
    fn count_totals_only_swiss_denominations() {
        let mut count = BTreeMap::new();
        count.insert("20000".to_owned(), 2);
        count.insert("500".to_owned(), 3);
        count.insert("5".to_owned(), 1);
        assert_eq!(counted_total(&count).unwrap(), 41_505);
        count.insert("2500".to_owned(), 1);
        assert!(counted_total(&count).is_err());
    }

    #[test]
    fn evening_count_finds_the_difference_and_corrects_it_once() {
        let (_temporary, store) = store();
        store.add_cash_entry(entry("2026-10-01", "opening", 50_000)).unwrap();
        assert!(store.add_cash_entry(entry("2026-10-01", "opening", 1_000)).is_err());
        store.add_cash_entry(entry("2026-10-02", "receipt", 12_500)).unwrap();
        store.add_cash_entry(entry("2026-10-02", "expense", 3_000)).unwrap();
        store.add_cash_entry(entry("2026-10-03", "bank_deposit", 40_000)).unwrap();
        // Une sortie plus grande que la caisse est refusée.
        assert!(store.add_cash_entry(entry("2026-10-03", "expense", 30_000)).is_err());
        let mut denominations = BTreeMap::new();
        denominations.insert("10000".to_owned(), 1);
        denominations.insert("5".to_owned(), 0);
        denominations.insert("200".to_owned(), 3);
        let count = store.record_cash_count(CashCountInput { count_date: "2026-10-03".into(), denominations, note: None }).unwrap();
        assert_eq!(count["expected_cents"], 19_500);
        assert_eq!(count["counted_cents"], 10_600);
        assert_eq!(count["difference_cents"], -8_900);
        let id = count["id"].as_str().unwrap().to_owned();
        let correction = store.correct_cash_count(&id).unwrap();
        assert_eq!(correction["amount_cents"], -8_900);
        // Rejouer ne crée pas une seconde correction.
        assert_eq!(store.correct_cash_count(&id).unwrap()["id"], correction["id"]);
        let connection = store.connect().unwrap();
        assert_eq!(expected_balance(&connection, "2026-10-03").unwrap(), 10_600);
        assert!(connection.execute("DELETE FROM cash_book_entries", []).is_err());
    }

    #[test]
    fn contracts_are_saved_until_terminated() {
        let (_temporary, store) = store();
        let input = ContractInput {
            id: None, side: "supplier".into(), client_id: None, supplier_id: None, party_name: "Régie du Lac".into(), title: "Bail de l'atelier".into(),
            start_date: "2024-04-01".into(), end_date: Some("2027-03-31".into()), notice_months: 6, auto_renew: true, renewal_months: 12,
            amount_cents: 240_000, currency: "CHF".into(), frequency: "monthly".into(), indexation: Some("IPC chaque avril".into()), note: None,
        };
        let saved = store.save_contract(input.clone()).unwrap();
        let id = saved["id"].as_str().unwrap().to_owned();
        let mut changed = input.clone();
        changed.id = Some(id.clone());
        changed.amount_cents = 245_000;
        assert_eq!(store.save_contract(changed.clone()).unwrap()["amount_cents"], 245_000);
        store.terminate_contract(&id, "2027-03-31").unwrap();
        assert!(store.save_contract(changed).is_err());
        let mut wrong = input;
        wrong.end_date = Some("2024-01-01".into());
        assert!(store.save_contract(wrong).is_err());
    }
}
