//! Tarifs de régie : une table par association ou par année, avec les
//! catégories de personnel (chef d'équipe, ouvrier qualifié, aide, apprenti…)
//! et les machines. Le fichier de l'association est lu par l'écran ; ici la
//! table est enregistrée telle quelle, et un rapport de régie signé peut être
//! facturé à ses tarifs sans toucher au rapport lui-même.

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaborRateInput {
    #[serde(default)]
    pub id: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub code: Option<String>,
    pub label: String,
    pub unit: String,
    pub rate_cents: i64,
    #[serde(default)]
    pub cost_cents: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaborRateTableInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub valid_from: Option<String>,
    pub is_default: bool,
    pub archived: bool,
    pub rates: Vec<LaborRateInput>,
}

fn optional_text(value: Option<String>, max: usize, label: &str) -> AppResult<Option<String>> {
    let value = value.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
    if value.as_ref().is_some_and(|text| text.chars().count() > max) {
        return Err(invalid(format!("{label} : {max} caractères au plus.")));
    }
    Ok(value)
}

/// Tarif à appliquer à une ligne d'heures d'un rapport : le tarif choisi s'il
/// est dans la table, sinon le tarif de même code, sinon celui de même libellé.
pub fn matching_rate(tx: &Transaction<'_>, table_id: &str, labor_rate_id: Option<&str>, description: &str) -> AppResult<Option<i64>> {
    if let Some(rate_id) = labor_rate_id.filter(|id| !id.is_empty()) {
        let direct: Option<i64> = tx
            .query_row("SELECT rate_cents FROM labor_rates WHERE id=? AND table_id=?", params![rate_id, table_id], |row| row.get(0))
            .optional()?;
        if direct.is_some() {
            return Ok(direct);
        }
        let by_code: Option<i64> = tx
            .query_row(
                "SELECT target.rate_cents FROM labor_rates source JOIN labor_rates target ON target.table_id=?2 AND target.code IS NOT NULL AND target.code=source.code WHERE source.id=?1 LIMIT 1",
                params![rate_id, table_id],
                |row| row.get(0),
            )
            .optional()?;
        if by_code.is_some() {
            return Ok(by_code);
        }
    }
    Ok(tx
        .query_row(
            "SELECT rate_cents FROM labor_rates WHERE table_id=? AND LOWER(TRIM(label))=LOWER(TRIM(?)) ORDER BY position LIMIT 1",
            params![table_id, description],
            |row| row.get(0),
        )
        .optional()?)
}

impl LocalStore {
    /// Enregistre la table et ses tarifs. Un tarif garde son identifiant, si
    /// bien que les rapports qui le citent le retrouvent après une mise à jour.
    pub fn save_labor_rate_table(&self, input: LaborRateTableInput) -> AppResult<Value> {
        let name = input.name.trim().to_owned();
        if name.is_empty() || name.chars().count() > 120 {
            return Err(invalid("Donnez un nom à la table de tarifs (120 caractères au plus)."));
        }
        let source = optional_text(input.source, 160, "Source")?;
        let valid_from = optional_text(input.valid_from, 10, "Date de validité")?;
        if let Some(date) = &valid_from {
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| invalid("La date de validité doit être au format AAAA-MM-JJ."))?;
        }
        if input.rates.is_empty() || input.rates.len() > 500 {
            return Err(invalid("Une table contient entre 1 et 500 tarifs."));
        }
        for rate in &input.rates {
            let label = rate.label.trim();
            if !matches!(rate.kind.as_str(), "personnel" | "machine")
                || label.is_empty()
                || label.chars().count() > 160
                || rate.unit.trim().is_empty()
                || rate.unit.trim().chars().count() > 32
                || !(0..=100_000_000).contains(&rate.rate_cents)
                || rate.cost_cents.is_some_and(|cost| !(0..=100_000_000).contains(&cost))
                || rate.code.as_deref().is_some_and(|code| code.trim().chars().count() > 40)
            {
                return Err(invalid("Vérifiez chaque tarif : catégorie, unité et prix positifs."));
            }
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        let id = match input.id.filter(|id| !id.is_empty()) {
            Some(id) => {
                let changed = tx.execute(
                    "UPDATE labor_rate_tables SET name=?,source=?,valid_from=?,is_default=?,archived_at=CASE WHEN ? THEN COALESCE(archived_at,?) ELSE NULL END,updated_at=? WHERE id=?",
                    params![name, source, valid_from, input.is_default && !input.archived, input.archived, now, now, id],
                )?;
                if changed == 0 {
                    return Err(invalid("Table de tarifs introuvable."));
                }
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO labor_rate_tables(id,name,source,valid_from,is_default,archived_at,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,?)",
                    params![id, name, source, valid_from, input.is_default && !input.archived, now, now],
                )?;
                id
            }
        };
        if input.is_default && !input.archived {
            tx.execute("UPDATE labor_rate_tables SET is_default=0,updated_at=? WHERE id<>? AND is_default=1", params![now, id])?;
        }
        let mut kept = Vec::new();
        for (position, rate) in input.rates.iter().enumerate() {
            let code = rate.code.as_deref().map(str::trim).filter(|code| !code.is_empty());
            let existing = match rate.id.as_deref().filter(|rate_id| !rate_id.is_empty()) {
                Some(rate_id) => tx
                    .query_row("SELECT id FROM labor_rates WHERE id=? AND table_id=?", params![rate_id, id], |row| row.get::<_, String>(0))
                    .optional()?,
                None => None,
            };
            let rate_id = match existing {
                Some(rate_id) => {
                    tx.execute(
                        "UPDATE labor_rates SET position=?,kind=?,code=?,label=?,unit=?,rate_cents=?,cost_cents=? WHERE id=?",
                        params![position as i64, rate.kind, code, rate.label.trim(), rate.unit.trim(), rate.rate_cents, rate.cost_cents, rate_id],
                    )?;
                    rate_id
                }
                None => {
                    let rate_id = Uuid::new_v4().to_string();
                    tx.execute(
                        "INSERT INTO labor_rates(id,table_id,position,kind,code,label,unit,rate_cents,cost_cents) VALUES(?,?,?,?,?,?,?,?,?)",
                        params![rate_id, id, position as i64, rate.kind, code, rate.label.trim(), rate.unit.trim(), rate.rate_cents, rate.cost_cents],
                    )?;
                    rate_id
                }
            };
            kept.push(rate_id);
        }
        let mut statement = tx.prepare("SELECT id FROM labor_rates WHERE table_id=?")?;
        let all = statement.query_map([&id], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for rate_id in all.into_iter().filter(|rate_id| !kept.contains(rate_id)) {
            tx.execute("DELETE FROM labor_rates WHERE id=?", [&rate_id])?;
        }
        append_audit(&tx, "save", "labor_rate_tables", &id, &json!({ "name": name, "rates": input.rates.len(), "default": input.is_default, "archived": input.archived }))?;
        tx.commit()?;
        Ok(json!({ "id": id }))
    }
}

#[tauri::command]
pub fn save_labor_rate_table(state: tauri::State<'_, LocalStore>, input: LaborRateTableInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_labor_rate_table(input).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::work_reports::{WorkReportInput, WorkReportLineInput};

    fn rate(id: Option<String>, kind: &str, code: &str, label: &str, cents: i64) -> LaborRateInput {
        LaborRateInput { id, kind: kind.into(), code: Some(code.into()), label: label.into(), unit: "h".into(), rate_cents: cents, cost_cents: Some(cents / 2) }
    }

    fn table(id: Option<String>, name: &str, rates: Vec<LaborRateInput>) -> LaborRateTableInput {
        LaborRateTableInput { id, name: name.into(), source: Some("Association cantonale".into()), valid_from: Some("2026-01-01".into()), is_default: true, archived: false, rates }
    }

    #[test]
    fn a_signed_report_is_invoiced_at_the_association_rates() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "labor-rates-test").unwrap();
        let first = store.save_labor_rate_table(table(None, "Tarifs 2025", vec![rate(None, "personnel", "CE", "Chef d'équipe", 9_200), rate(None, "personnel", "OQ", "Ouvrier qualifié", 8_400)])).unwrap()["id"].as_str().unwrap().to_owned();
        let connection = store.connect().unwrap();
        let old_rate: String = connection.query_row("SELECT id FROM labor_rates WHERE table_id=? AND code='CE'", [&first], |row| row.get(0)).unwrap();
        drop(connection);
        let second = store.save_labor_rate_table(table(None, "Tarifs 2026", vec![rate(None, "personnel", "CE", "Chef d'équipe", 9_800), rate(None, "personnel", "AP", "Apprenti", 3_500), rate(None, "machine", "NAC", "Nacelle", 12_000)])).unwrap()["id"].as_str().unwrap().to_owned();
        let connection = store.connect().unwrap();
        let defaults: i64 = connection.query_row("SELECT COUNT(*) FROM labor_rate_tables WHERE is_default=1", [], |row| row.get(0)).unwrap();
        assert_eq!(defaults, 1, "une seule table par défaut");
        drop(connection);

        let client = store.create_record("clients", json!({"name":"Régie du Lac"})).unwrap()["id"].as_str().unwrap().to_owned();
        let line = |description: &str, rate_id: Option<String>, price: i64| WorkReportLineInput { kind: "labor".into(), catalog_item_id: None, description: description.into(), quantity: 2.0, unit: "h".into(), unit_price_cents: price, vat_bp: 810, labor_rate_id: rate_id };
        let report = store.save_work_report(WorkReportInput {
            id: None, client_id: client, project_id: None, report_date: "2026-10-20".into(), site: Some("Rue du Lac 3".into()), description: "Reprise de fissures".into(), technician: None,
            lines: vec![line("Chef d'équipe", Some(old_rate), 9_200), line("Apprenti", None, 0), line("Manœuvre", None, 5_000)],
        }).unwrap()["id"].as_str().unwrap().to_owned();
        store.sign_work_report(&report, "M. Dupont", "M10 10 L20 20 L30 30").unwrap();
        let invoice = store.invoice_work_report(&report, Some(&second)).unwrap();
        let invoice_id = invoice["id"].as_str().unwrap().to_owned();
        let connection = store.connect().unwrap();
        let prices: Vec<i64> = {
            let mut statement = connection.prepare("SELECT unit_price_cents FROM invoice_items WHERE invoice_id=? ORDER BY position").unwrap();
            statement.query_map([&invoice_id], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
        };
        // Chef d'équipe au tarif 2026 par son code, apprenti par son libellé, manœuvre inconnu : prix du rapport.
        assert_eq!(prices, vec![9_800, 3_500, 5_000]);
        let report_prices: i64 = connection.query_row("SELECT SUM(unit_price_cents) FROM work_report_lines WHERE report_id=?", [&report], |row| row.get(0)).unwrap();
        assert_eq!(report_prices, 9_200 + 5_000, "le rapport signé reste tel quel");
        drop(connection);

        // Mise à jour : l'identifiant du tarif est conservé, un tarif retiré disparaît.
        let connection = store.connect().unwrap();
        let kept: String = connection.query_row("SELECT id FROM labor_rates WHERE table_id=? AND code='CE'", [&second], |row| row.get(0)).unwrap();
        drop(connection);
        store.save_labor_rate_table(table(Some(second.clone()), "Tarifs 2026", vec![rate(Some(kept.clone()), "personnel", "CE", "Chef d'équipe", 9_900)])).unwrap();
        let connection = store.connect().unwrap();
        let (count, price): (i64, i64) = connection.query_row("SELECT COUNT(*), MAX(rate_cents) FROM labor_rates WHERE table_id=?", [&second], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!((count, price), (1, 9_900));
        let same: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM labor_rates WHERE id=?)", [&kept], |row| row.get(0)).unwrap();
        assert!(same);
        drop(connection);
        assert!(store.save_labor_rate_table(table(None, "", vec![rate(None, "personnel", "X", "X", 1)])).is_err());
        assert!(store.save_labor_rate_table(table(None, "Vide", vec![])).is_err());
        assert!(store.save_labor_rate_table(table(None, "Mauvais", vec![rate(None, "robot", "X", "X", 1)])).is_err());
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["labor_rate_tables"].as_array().unwrap().len(), 2);
    }
}
