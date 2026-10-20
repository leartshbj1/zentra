//! Impôt à la source d'après les fichiers tarifaires de l'ESTV
//! (enregistrements « 06 », positions fixes), puis écriture du fichier de
//! structure Swissdec ELM préparé par l'interface. Le montant calculé reste
//! une retenue manuelle de la fiche, vérifiée par l'utilisateur.

use std::{collections::BTreeSet, fs, io::Write};

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{command_error, AppError, AppResult},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TariffRow {
    pub canton: String,
    pub code: String,
    pub valid_from: String,
    pub income_from_cents: i64,
    pub step_cents: i64,
    pub children: i64,
    pub min_tax_cents: i64,
    pub rate_bp: i64,
}

fn digits(line: &str, from: usize, to: usize) -> Option<i64> {
    let value = line.get(from - 1..to)?.trim();
    if value.is_empty() {
        return Some(0);
    }
    value.parse().ok()
}

/// Lit une ligne « 06 » du format ESTV :
/// 1-2 type, 3-4 mutation, 5-6 canton, 7-16 code tarifaire, 17-24 date
/// d'entrée en vigueur, 25-33 revenu dès (centimes), 34-42 échelon (centimes),
/// 43 sexe, 44-45 enfants, 46-54 impôt minimum (centimes), 55-59 taux (2 décimales).
pub(crate) fn parse_tariff_line(line: &str) -> Option<TariffRow> {
    if !line.starts_with("06") || line.len() < 59 || !line.is_ascii() {
        return None;
    }
    if line.get(2..4)? == "03" {
        return None; // suppression : ignorée, l'import remplace le barème entier
    }
    let canton = line.get(4..6)?.trim().to_uppercase();
    let code = line.get(6..16)?.trim().to_uppercase();
    let date = line.get(16..24)?;
    if canton.len() != 2 || !canton.bytes().all(|b| b.is_ascii_uppercase()) || code.is_empty() || !date.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let valid_from = format!("{}-{}-{}", &date[0..4], &date[4..6], &date[6..8]);
    let row = TariffRow {
        canton,
        code,
        valid_from,
        income_from_cents: digits(line, 25, 33)?,
        step_cents: digits(line, 34, 42)?,
        children: digits(line, 44, 45)?,
        min_tax_cents: digits(line, 46, 54)?,
        rate_bp: digits(line, 55, 59)?,
    };
    (row.rate_bp <= 10_000 && row.step_cents >= 0).then_some(row)
}

/// Impôt du mois : revenu × taux, arrondi au centime, au moins l'impôt minimum.
pub(crate) fn tax_cents(income_cents: i64, rate_bp: i64, min_tax_cents: i64) -> i64 {
    if income_cents <= 0 || rate_bp <= 0 {
        return 0;
    }
    let computed = ((i128::from(income_cents) * i128::from(rate_bp) + 5_000) / 10_000) as i64;
    computed.max(min_tax_cents)
}

impl LocalStore {
    pub fn import_source_tax_tariffs(&self, text: &str) -> AppResult<Value> {
        if text.len() > 80_000_000 {
            return Err(invalid("Le fichier tarifaire est trop volumineux."));
        }
        let rows: Vec<TariffRow> = text.lines().filter_map(parse_tariff_line).collect();
        if rows.is_empty() {
            return Err(invalid("Aucune ligne de barème reconnue. Choisissez un fichier tarifaire de l'ESTV (format texte, enregistrements 06)."));
        }
        let sets: BTreeSet<(String, String)> = rows.iter().map(|row| (row.canton.clone(), row.valid_from.clone())).collect();
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (canton, valid_from) in &sets {
            tx.execute("DELETE FROM company_local_source_tax_tariffs WHERE canton=? AND valid_from=?", params![canton, valid_from])?;
        }
        {
            let mut insert = tx.prepare(
                "INSERT OR REPLACE INTO company_local_source_tax_tariffs(canton,code,valid_from,income_from_cents,step_cents,children,min_tax_cents,rate_bp) VALUES(?,?,?,?,?,?,?,?)",
            )?;
            for row in &rows {
                insert.execute(params![row.canton, row.code, row.valid_from, row.income_from_cents, row.step_cents, row.children, row.min_tax_cents, row.rate_bp])?;
            }
        }
        let summary = json!({ "rows": rows.len(), "sets": sets.iter().map(|(canton, date)| json!({"canton": canton, "valid_from": date})).collect::<Vec<_>>(),
            "sha256": format!("{:x}", Sha256::digest(text.as_bytes())) });
        append_audit(&tx, "import", "source_tax_tariffs", "estv", &summary)?;
        tx.commit()?;
        Ok(summary)
    }

    pub fn list_source_tax_tariff_sets(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(Value::Array(query_all(
            &connection,
            "SELECT canton,valid_from,COUNT(*) AS rows,COUNT(DISTINCT code) AS codes FROM company_local_source_tax_tariffs GROUP BY canton,valid_from ORDER BY canton,valid_from DESC",
            [],
        )?))
    }

    /// Taux et impôt pour un revenu mensuel, selon le barème en vigueur à `date`.
    pub fn source_tax_lookup(&self, canton: &str, code: &str, income_cents: i64, date: &str) -> AppResult<Value> {
        crate::accounting::validate_date(date, "date")?;
        if !(0..=100_000_000_000).contains(&income_cents) {
            return Err(invalid("Le revenu soumis est invalide."));
        }
        let canton = canton.trim().to_uppercase();
        let code = code.trim().to_uppercase();
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let valid_from: Option<String> = connection
            .query_row("SELECT MAX(valid_from) FROM company_local_source_tax_tariffs WHERE canton=? AND code=? AND valid_from<=?", params![canton, code, date], |r| r.get(0))
            .optional()?
            .flatten();
        let valid_from = valid_from.ok_or_else(|| invalid(format!("Aucun barème {code} du canton {canton} en vigueur à cette date. Importez le fichier tarifaire de l'ESTV.")))?;
        let row: Option<(i64, i64, i64, i64)> = connection
            .query_row(
                "SELECT income_from_cents,step_cents,min_tax_cents,rate_bp FROM company_local_source_tax_tariffs WHERE canton=? AND code=? AND valid_from=? AND income_from_cents<=? ORDER BY income_from_cents DESC LIMIT 1",
                params![canton, code, valid_from, income_cents],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let (from, step, min_tax, rate) = row.ok_or_else(|| invalid("Aucune tranche du barème ne couvre ce revenu."))?;
        Ok(json!({ "canton": canton, "code": code, "valid_from": valid_from, "bracket_from_cents": from, "bracket_step_cents": step,
            "rate_bp": rate, "tax_cents": tax_cents(income_cents, rate, min_tax) }))
    }

    /// Écrit la structure ELM préparée (non certifiée, non transmise) et garde sa trace.
    pub fn export_elm_structure(&self, destination: &str, xml: &str, year: i64) -> AppResult<Value> {
        let path = crate::supplier_payment_orders::validate_xml_destination(destination)?;
        if xml.len() > 20_000_000 || !xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>") || !xml.contains("http://www.swissdec.ch/schema/sd/") {
            return Err(invalid("Le fichier ELM préparé est incomplet."));
        }
        if !(2000..=2100).contains(&year) {
            return Err(invalid("Année invalide."));
        }
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        drop(connection);
        let mut file = fs::File::create(&path)?;
        file.write_all(xml.as_bytes())?;
        file.sync_all()?;
        let sha = format!("{:x}", Sha256::digest(xml.as_bytes()));
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        append_audit(&tx, "export", "elm_structure", &year.to_string(), &json!({"file": path.file_name().and_then(|v| v.to_str()), "sha256": sha, "at": now_iso()}))?;
        tx.commit()?;
        Ok(json!({ "path": path.to_string_lossy(), "sha256": sha }))
    }
}

#[tauri::command]
pub fn import_source_tax_tariffs(state: tauri::State<'_, LocalStore>, text: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.import_source_tax_tariffs(&text).map_err(command_error)
}

#[tauri::command]
pub fn list_source_tax_tariff_sets(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_source_tax_tariff_sets().map_err(command_error)
}

#[tauri::command]
pub fn source_tax_lookup(state: tauri::State<'_, LocalStore>, canton: String, code: String, income_cents: i64, date: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.source_tax_lookup(&canton, &code, income_cents, &date).map_err(command_error)
}

#[tauri::command]
pub fn export_elm_structure(state: tauri::State<'_, LocalStore>, destination: String, xml: String, year: i64) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.export_elm_structure(&destination, &xml, year).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ligne synthétique au format ESTV : GE, A0N, dès 2026-01-01.
    fn line(code: &str, from: i64, step: i64, children: i64, min: i64, rate: i64) -> String {
        format!("0601GE{:<10}20260101{:09}{:09} {:02}{:09}{:05}", code, from, step, children, min, rate)
    }

    #[test]
    fn reads_fixed_width_tariff_lines() {
        let row = parse_tariff_line(&line("A0N", 500_000, 5_000, 0, 0, 512)).unwrap();
        assert_eq!(row, TariffRow { canton: "GE".into(), code: "A0N".into(), valid_from: "2026-01-01".into(), income_from_cents: 500_000, step_cents: 5_000, children: 0, min_tax_cents: 0, rate_bp: 512 });
        assert!(parse_tariff_line("0001GE A0N").is_none());
        assert!(parse_tariff_line(&line("A0N", 1, 1, 0, 0, 512).replacen("0601", "0603", 1)).is_none());
        assert_eq!(tax_cents(512_345, 512, 0), 26_232);
        assert_eq!(tax_cents(100_000, 10, 2_000), 2_000);
        assert_eq!(tax_cents(0, 512, 2_000), 0);
    }

    #[test]
    fn imports_and_finds_the_bracket_in_force() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "source-tax-test").unwrap();
        let file = [line("A0N", 0, 500_000, 0, 0, 0), line("A0N", 500_000, 5_000, 0, 0, 512), line("A0N", 505_000, 5_000, 0, 0, 518), line("B1Y", 500_000, 5_000, 1, 0, 301), "999 fin".into()].join("\r\n");
        let summary = store.import_source_tax_tariffs(&file).unwrap();
        assert_eq!(summary["rows"], 4);
        let found = store.source_tax_lookup("ge", "a0n", 503_000, "2026-03-31").unwrap();
        assert_eq!((found["rate_bp"].as_i64(), found["tax_cents"].as_i64()), (Some(512), Some(25_754)));
        assert_eq!(store.source_tax_lookup("GE", "A0N", 506_000, "2026-03-31").unwrap()["rate_bp"], 518);
        assert!(store.source_tax_lookup("GE", "A0N", 506_000, "2025-12-31").is_err());
        assert!(store.import_source_tax_tariffs("rien à lire").is_err());
        // Réimporter remplace le barème du même canton et de la même date.
        store.import_source_tax_tariffs(&line("A0N", 0, 1_000_000, 0, 0, 400)).unwrap();
        assert_eq!(store.source_tax_lookup("GE", "A0N", 506_000, "2026-03-31").unwrap()["rate_bp"], 400);
        assert_eq!(store.list_source_tax_tariff_sets().unwrap().as_array().unwrap().len(), 1);
    }
}
