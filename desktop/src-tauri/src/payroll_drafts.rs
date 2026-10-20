//! Brouillons de salaires du mois : copie des lignes saisies le mois
//! précédent pour chaque collaborateur encore en poste, puis cotisations
//! recalculées par l'app avec les mêmes définitions. Rien n'est validé :
//! chaque fiche reste « brouillon » jusqu'au contrôle humain.

use chrono::{Datelike, NaiveDate};
use rusqlite::params;
use serde_json::{json, Value};

use crate::{
    database::{query_all, LocalStore},
    error::{command_error, AppError, AppResult},
    models::{ContributionSelectionInput, PayslipManualLineInput, SavePayslipWithContributionsInput},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

fn month_start(period: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(&format!("{period}-01"), "%Y-%m-%d").map_err(|_| invalid("La période doit être au format AAAA-MM."))
}

/// Mois précédent : « 2026-01 » → « 2025-12 ».
pub(crate) fn previous_period(period: &str) -> AppResult<String> {
    let start = month_start(period)?;
    let previous = start.pred_opt().ok_or_else(|| invalid("Période invalide."))?;
    Ok(format!("{:04}-{:02}", previous.year(), previous.month()))
}

/// Même jour de paiement dans le nouveau mois, ramené au dernier jour si besoin.
pub(crate) fn same_payday(previous_payment: &str, period: &str) -> AppResult<Option<String>> {
    let Ok(paid) = NaiveDate::parse_from_str(previous_payment, "%Y-%m-%d") else { return Ok(None) };
    let start = month_start(period)?;
    let next_month = if start.month() == 12 { NaiveDate::from_ymd_opt(start.year() + 1, 1, 1) } else { NaiveDate::from_ymd_opt(start.year(), start.month() + 1, 1) }
        .ok_or_else(|| invalid("Période invalide."))?;
    let last = next_month.pred_opt().ok_or_else(|| invalid("Période invalide."))?.day();
    Ok(NaiveDate::from_ymd_opt(start.year(), start.month(), paid.day().min(last)).map(|date| date.format("%Y-%m-%d").to_string()))
}

impl LocalStore {
    /// Prépare les brouillons de `period` à partir des fiches du mois précédent.
    pub fn prepare_payroll_drafts(&self, period: &str) -> AppResult<Value> {
        let start = month_start(period)?;
        let previous = previous_period(period)?;
        let end = {
            let next = if start.month() == 12 { NaiveDate::from_ymd_opt(start.year() + 1, 1, 1) } else { NaiveDate::from_ymd_opt(start.year(), start.month() + 1, 1) };
            next.and_then(|date| date.pred_opt()).ok_or_else(|| invalid("Période invalide."))?.format("%Y-%m-%d").to_string()
        };
        let start_text = start.format("%Y-%m-%d").to_string();
        let sources = {
            let connection = self.connect()?;
            self.require_onboarding(&connection)?;
            query_all(
                &connection,
                "SELECT p.id,p.employee_id,p.payment_date,e.name FROM payslips p JOIN employees e ON e.id=p.employee_id
                  WHERE p.period=? AND p.status IN ('valide','comptabilise','paye')
                    AND (e.employment_start_date IS NULL OR e.employment_start_date='' OR e.employment_start_date<=?)
                    AND (e.employment_end_date IS NULL OR e.employment_end_date='' OR e.employment_end_date>=?)
                    AND NOT EXISTS(SELECT 1 FROM payslips n WHERE n.employee_id=p.employee_id AND n.period=?)
                  ORDER BY e.name,p.id",
                params![previous, end, start_text, period],
            )?
        };
        let mut created = Vec::new();
        let mut failed = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for source in sources {
            let employee_id = source["employee_id"].as_str().unwrap_or_default().to_owned();
            // Une seule fiche par collaborateur, même s'il en avait plusieurs le mois précédent.
            if !seen.insert(employee_id.clone()) {
                continue;
            }
            let source_id = source["id"].as_str().unwrap_or_default().to_owned();
            let name = source["name"].as_str().unwrap_or_default().to_owned();
            let (lines, contributions) = {
                let connection = self.connect()?;
                let lines = query_all(
                    &connection,
                    "SELECT label,kind,amount_cents,posting_account_id,expense_account_id FROM payslip_items i
                      WHERE i.payslip_id=? AND NOT EXISTS(SELECT 1 FROM payslip_contributions c WHERE c.payslip_item_id=i.id)
                      ORDER BY i.position,i.id",
                    params![source_id],
                )?;
                let contributions = query_all(
                    &connection,
                    "SELECT DISTINCT definition_id FROM payslip_contributions WHERE payslip_id=? ORDER BY definition_id",
                    params![source_id],
                )?;
                (lines, contributions)
            };
            let input = SavePayslipWithContributionsInput {
                id: None,
                employee_id: employee_id.clone(),
                period: period.to_owned(),
                status: "brouillon".into(),
                payment_date: source["payment_date"].as_str().map(|date| same_payday(date, period)).transpose()?.flatten(),
                notes: Some(format!("Préparée depuis la fiche de {previous} : vérifiez les heures, absences et éléments variables.")),
                lines: lines
                    .iter()
                    .map(|line| PayslipManualLineInput {
                        id: None,
                        label: line["label"].as_str().unwrap_or_default().to_owned(),
                        kind: line["kind"].as_str().unwrap_or_default().to_owned(),
                        amount_cents: line["amount_cents"].as_i64().unwrap_or_default(),
                        posting_account_id: line["posting_account_id"].as_str().map(ToOwned::to_owned),
                        expense_account_id: line["expense_account_id"].as_str().map(ToOwned::to_owned),
                    })
                    .collect(),
                // Bases recalculées par l'app sur les lignes du nouveau mois.
                contributions: contributions
                    .iter()
                    .filter_map(|row| row["definition_id"].as_str())
                    .map(|definition_id| ContributionSelectionInput { definition_id: definition_id.to_owned(), basis_cents: None, year_to_date_basis_cents: None })
                    .collect(),
            };
            if input.lines.is_empty() {
                failed.push(json!({ "employee_id": employee_id, "name": name, "reason": "La fiche du mois précédent n'a aucune ligne saisie." }));
                continue;
            }
            match self.save_payslip_with_contributions(input) {
                Ok(payslip) => created.push(json!({ "employee_id": employee_id, "name": name, "payslip_id": payslip["id"] })),
                Err(error) => failed.push(json!({ "employee_id": employee_id, "name": name, "reason": error.to_string() })),
            }
        }
        Ok(json!({ "period": period, "source_period": previous, "created": created, "failed": failed }))
    }
}

#[tauri::command]
pub fn prepare_payroll_drafts(state: tauri::State<'_, LocalStore>, period: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.prepare_payroll_drafts(&period).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn periods_and_paydays() {
        assert_eq!(previous_period("2026-01").unwrap(), "2025-12");
        assert_eq!(previous_period("2026-11").unwrap(), "2026-10");
        assert!(previous_period("2026-13").is_err());
        assert_eq!(same_payday("2026-01-31", "2026-02").unwrap().as_deref(), Some("2026-02-28"));
        assert_eq!(same_payday("2026-10-25", "2026-11").unwrap().as_deref(), Some("2026-11-25"));
        assert_eq!(same_payday("pas une date", "2026-11").unwrap(), None);
    }
}
