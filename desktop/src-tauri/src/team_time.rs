//! Absences et vacances (soldes calculés par l'app), notes de frais des
//! collaborateurs : justificatif, validation, puis remboursement par une
//! ligne de la fiche de salaire en brouillon. Rien n'est validé sans clic.

use base64::Engine;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    accounting::validate_date,
    audit::append_audit,
    database::{now_iso, query_all, query_record_tx, LocalStore},
    error::{command_error, AppError, AppResult},
    models::{ContributionSelectionInput, PayslipManualLineInput, SavePayslipWithContributionsInput},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

const ABSENCE_KINDS: &[&str] = &["vacation", "sick", "accident", "military", "maternity", "paternity", "training", "other"];

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AbsenceInput {
    #[serde(default)]
    pub id: Option<String>,
    pub employee_id: String,
    pub kind: String,
    pub start_date: String,
    pub end_date: String,
    pub days: f64,
    #[serde(default = "full")]
    pub incapacity_percent: i64,
    #[serde(default)]
    pub certificate: bool,
    #[serde(default)]
    pub note: Option<String>,
}
fn full() -> i64 {
    100
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExpenseClaimInput {
    pub employee_id: String,
    pub claim_date: String,
    pub category: String,
    pub description: String,
    pub amount_cents: i64,
    #[serde(default)]
    pub receipt_name: Option<String>,
    #[serde(default)]
    pub receipt_base64: Option<String>,
}

fn employee_exists(tx: &rusqlite::Transaction<'_>, id: &str) -> AppResult<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM employees WHERE id=?)", [id], |r| r.get(0))?)
}

impl LocalStore {
    pub fn save_leave_settings(&self, employee_id: &str, vacation_days_per_year: f64, carried_over_days: f64) -> AppResult<Value> {
        if !(0.0..=60.0).contains(&vacation_days_per_year) || !(-60.0..=60.0).contains(&carried_over_days) {
            return Err(invalid("Le droit annuel va de 0 à 60 jours, le report de −60 à 60 jours."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !employee_exists(&tx, employee_id)? {
            return Err(invalid("Collaborateur introuvable."));
        }
        tx.execute(
            "INSERT INTO employee_leave_settings(employee_id,vacation_days_per_year,carried_over_days,updated_at) VALUES(?,?,?,?)
             ON CONFLICT(employee_id) DO UPDATE SET vacation_days_per_year=excluded.vacation_days_per_year,carried_over_days=excluded.carried_over_days,updated_at=excluded.updated_at",
            params![employee_id, vacation_days_per_year, carried_over_days, now_iso()],
        )?;
        let record = tx.query_row("SELECT * FROM employee_leave_settings WHERE employee_id=?", [employee_id], crate::database::row_to_json_public)?;
        append_audit(&tx, "save", "employee_leave_settings", employee_id, &record)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn save_absence(&self, input: AbsenceInput) -> AppResult<Value> {
        validate_date(&input.start_date, "start_date")?;
        validate_date(&input.end_date, "end_date")?;
        if input.end_date < input.start_date {
            return Err(invalid("La fin de l'absence précède son début."));
        }
        if !ABSENCE_KINDS.contains(&input.kind.as_str()) || !(input.days > 0.0 && input.days <= 366.0) || !(1..=100).contains(&input.incapacity_percent) {
            return Err(invalid("Vérifiez le type, le nombre de jours et le taux d'incapacité."));
        }
        let note = input.note.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        if note.as_ref().is_some_and(|v| v.chars().count() > 1000) {
            return Err(invalid("La note dépasse 1000 caractères."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !employee_exists(&tx, &input.employee_id)? {
            return Err(invalid("Collaborateur introuvable."));
        }
        let now = now_iso();
        let id = match input.id.filter(|v| !v.is_empty()) {
            Some(id) => {
                let changed = tx.execute(
                    "UPDATE absences SET employee_id=?,kind=?,start_date=?,end_date=?,days=?,incapacity_percent=?,certificate=?,note=?,updated_at=? WHERE id=?",
                    params![input.employee_id, input.kind, input.start_date, input.end_date, input.days, input.incapacity_percent, input.certificate, note, now, id],
                )?;
                if changed != 1 {
                    return Err(invalid("Absence introuvable."));
                }
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO absences(id,employee_id,kind,start_date,end_date,days,incapacity_percent,certificate,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    params![id, input.employee_id, input.kind, input.start_date, input.end_date, input.days, input.incapacity_percent, input.certificate, note, now, now],
                )?;
                id
            }
        };
        let record = query_record_tx(&tx, "absences", &id)?;
        append_audit(&tx, "save", "absence", &id, &record)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn delete_absence(&self, id: &str) -> AppResult<()> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.execute("DELETE FROM absences WHERE id=? AND ijm_declared_at IS NULL", [id])? != 1 {
            return Err(invalid("Une absence déclarée à l'assurance IJM ne se supprime pas."));
        }
        append_audit(&tx, "delete", "absence", id, &json!({}))?;
        tx.commit()?;
        Ok(())
    }

    /// Trace la déclaration faite auprès de l'assurance perte de gain maladie.
    pub fn mark_ijm_declared(&self, id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        if tx.execute("UPDATE absences SET ijm_declared_at=?,updated_at=? WHERE id=? AND kind='sick' AND ijm_declared_at IS NULL", params![now, now, id])? != 1 {
            return Err(invalid("Cette absence n'est pas un arrêt maladie à déclarer."));
        }
        let record = query_record_tx(&tx, "absences", id)?;
        append_audit(&tx, "ijm_declared", "absence", id, &json!({"declared_at": now}))?;
        tx.commit()?;
        Ok(record)
    }

    pub fn add_expense_claim(&self, input: ExpenseClaimInput) -> AppResult<Value> {
        validate_date(&input.claim_date, "claim_date")?;
        let category = input.category.trim().to_owned();
        let description = input.description.trim().to_owned();
        if category.is_empty() || category.chars().count() > 80 || description.is_empty() || description.chars().count() > 500 {
            return Err(invalid("Indiquez la catégorie et ce qui a été payé."));
        }
        if !(1..=10_000_000).contains(&input.amount_cents) {
            return Err(invalid("Le montant doit être entre 0.01 et 100 000 francs."));
        }
        let mut prepared = match (input.receipt_name.as_deref(), input.receipt_base64.as_deref()) {
            (Some(name), Some(data)) if !data.is_empty() => {
                let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| invalid("Le justificatif est illisible."))?;
                Some(self.prepare_supplier_invoice_attachment_bytes(name, &bytes)?)
            }
            _ => None,
        };
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !employee_exists(&tx, &input.employee_id)? {
            return Err(invalid("Collaborateur introuvable."));
        }
        let id = Uuid::new_v4().to_string();
        let now = now_iso();
        tx.execute(
            "INSERT INTO expense_claims(id,employee_id,claim_date,category,description,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'submitted',?,?)",
            params![id, input.employee_id, input.claim_date, category, description, input.amount_cents, now, now],
        )?;
        if let Some(prepared) = prepared.as_mut() {
            let attachment_id = self.insert_prepared_expense_claim_attachment(&tx, &id, prepared)?;
            tx.execute("UPDATE expense_claims SET attachment_id=? WHERE id=?", params![attachment_id, id])?;
            prepared.install()?;
        }
        let record = query_record_tx(&tx, "expense_claims", &id)?;
        append_audit(&tx, "submit", "expense_claim", &id, &record)?;
        tx.commit()?;
        if let Some(prepared) = prepared.as_mut() {
            prepared.retain();
        }
        Ok(record)
    }

    pub fn decide_expense_claim(&self, id: &str, approve: bool, note: Option<String>) -> AppResult<Value> {
        let note = note.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        if note.as_ref().is_some_and(|v| v.chars().count() > 500) {
            return Err(invalid("La remarque dépasse 500 caractères."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        let changed = tx.execute(
            "UPDATE expense_claims SET status=?,decided_at=?,decision_note=?,updated_at=? WHERE id=? AND status IN ('submitted','approved','rejected')",
            params![if approve { "approved" } else { "rejected" }, now, note, now, id],
        )?;
        if changed != 1 {
            return Err(invalid("Cette note de frais est déjà remboursée ou introuvable."));
        }
        let record = query_record_tx(&tx, "expense_claims", id)?;
        append_audit(&tx, if approve { "approve" } else { "reject" }, "expense_claim", id, &record)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn delete_expense_claim(&self, id: &str) -> AppResult<()> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.execute("DELETE FROM expense_claims WHERE id=? AND status IN ('submitted','rejected')", [id])? != 1 {
            return Err(invalid("Une note de frais validée ne se supprime pas."));
        }
        append_audit(&tx, "delete", "expense_claim", id, &json!({}))?;
        tx.commit()?;
        Ok(())
    }

    /// Ajoute les notes de frais validées comme lignes de remboursement à la
    /// fiche en brouillon. Les cotisations gardent leurs bases : un
    /// remboursement de frais n'y est pas soumis.
    pub fn add_approved_claims_to_payslip(&self, payslip_id: &str) -> AppResult<usize> {
        let (payslip, claims, lines, bases) = {
            let connection = self.connect()?;
            self.require_onboarding(&connection)?;
            let payslip = connection
                .query_row("SELECT employee_id,period,status,payment_date,notes FROM payslips WHERE id=?", [payslip_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
                })
                .optional()?
                .ok_or_else(|| invalid("Fiche de salaire introuvable."))?;
            if !matches!(payslip.2.as_str(), "brouillon" | "a_controler") {
                return Err(invalid("Ajoutez les frais à une fiche encore en brouillon."));
            }
            let claims = query_all(&connection, "SELECT id,claim_date,description,amount_cents FROM expense_claims WHERE employee_id=? AND status='approved' ORDER BY claim_date,id", params![payslip.0])?;
            let lines = query_all(
                &connection,
                "SELECT label,kind,amount_cents,posting_account_id,expense_account_id FROM payslip_items i WHERE i.payslip_id=? AND NOT EXISTS(SELECT 1 FROM payslip_contributions c WHERE c.payslip_item_id=i.id) ORDER BY i.position,i.id",
                params![payslip_id],
            )?;
            let bases = query_all(
                &connection,
                "SELECT definition_id,MAX(basis_cents) AS basis_cents,MAX(year_to_date_basis_cents) AS year_to_date_basis_cents FROM payslip_contributions WHERE payslip_id=? GROUP BY definition_id ORDER BY definition_id",
                params![payslip_id],
            )?;
            (payslip, claims, lines, bases)
        };
        if claims.is_empty() {
            return Ok(0);
        }
        let mut manual: Vec<PayslipManualLineInput> = lines
            .iter()
            .map(|line| PayslipManualLineInput {
                id: None,
                label: line["label"].as_str().unwrap_or_default().to_owned(),
                kind: line["kind"].as_str().unwrap_or_default().to_owned(),
                amount_cents: line["amount_cents"].as_i64().unwrap_or_default(),
                posting_account_id: line["posting_account_id"].as_str().map(ToOwned::to_owned),
                expense_account_id: line["expense_account_id"].as_str().map(ToOwned::to_owned),
            })
            .collect();
        for claim in &claims {
            let label: String = format!("Note de frais du {} · {}", claim["claim_date"].as_str().unwrap_or_default(), claim["description"].as_str().unwrap_or_default()).chars().take(200).collect();
            manual.push(PayslipManualLineInput { id: None, label, kind: "reimbursement".into(), amount_cents: claim["amount_cents"].as_i64().unwrap_or_default(), posting_account_id: None, expense_account_id: None });
        }
        self.save_payslip_with_contributions(SavePayslipWithContributionsInput {
            id: Some(payslip_id.to_owned()),
            employee_id: payslip.0.clone(),
            period: payslip.1.clone(),
            status: payslip.2.clone(),
            payment_date: payslip.3.clone(),
            notes: payslip.4.clone(),
            lines: manual,
            contributions: bases
                .iter()
                .filter_map(|row| Some(ContributionSelectionInput {
                    definition_id: row["definition_id"].as_str()?.to_owned(),
                    basis_cents: row["basis_cents"].as_i64(),
                    year_to_date_basis_cents: row["year_to_date_basis_cents"].as_i64(),
                }))
                .collect(),
        })?;
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        for claim in &claims {
            let id = claim["id"].as_str().unwrap_or_default();
            tx.execute("UPDATE expense_claims SET status='reimbursed',payslip_id=?,updated_at=? WHERE id=? AND status='approved'", params![payslip_id, now, id])?;
            append_audit(&tx, "reimburse", "expense_claim", id, &json!({"payslip_id": payslip_id}))?;
        }
        tx.commit()?;
        Ok(claims.len())
    }
}

#[tauri::command]
pub fn save_leave_settings(state: tauri::State<'_, LocalStore>, employee_id: String, vacation_days_per_year: f64, carried_over_days: f64) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_leave_settings(&employee_id, vacation_days_per_year, carried_over_days).map_err(command_error)
}

#[tauri::command]
pub fn save_absence(state: tauri::State<'_, LocalStore>, input: AbsenceInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_absence(input).map_err(command_error)
}

#[tauri::command]
pub fn delete_absence(state: tauri::State<'_, LocalStore>, id: String) -> Result<(), String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.delete_absence(&id).map_err(command_error)
}

#[tauri::command]
pub fn mark_ijm_declared(state: tauri::State<'_, LocalStore>, id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.mark_ijm_declared(&id).map_err(command_error)
}

#[tauri::command]
pub fn add_expense_claim(state: tauri::State<'_, LocalStore>, input: ExpenseClaimInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.add_expense_claim(input).map_err(command_error)
}

#[tauri::command]
pub fn decide_expense_claim(state: tauri::State<'_, LocalStore>, id: String, approve: bool, note: Option<String>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.decide_expense_claim(&id, approve, note).map_err(command_error)
}

#[tauri::command]
pub fn delete_expense_claim(state: tauri::State<'_, LocalStore>, id: String) -> Result<(), String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.delete_expense_claim(&id).map_err(command_error)
}

#[tauri::command]
pub fn add_approved_claims_to_payslip(state: tauri::State<'_, LocalStore>, payslip_id: String) -> Result<usize, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.add_approved_claims_to_payslip(&payslip_id).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_employee() -> (tempfile::TempDir, LocalStore, String) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "team-time-test").unwrap();
        let id = store.create_record("employees", json!({"name": "Marc Rochat"})).unwrap()["id"].as_str().unwrap().to_owned();
        (temporary, store, id)
    }

    #[test]
    fn absences_and_leave_settings() {
        let (_temporary, store, employee) = store_with_employee();
        store.save_leave_settings(&employee, 25.0, 2.5).unwrap();
        assert!(store.save_leave_settings(&employee, 90.0, 0.0).is_err());
        let sick = store.save_absence(AbsenceInput { id: None, employee_id: employee.clone(), kind: "sick".into(), start_date: "2026-09-01".into(), end_date: "2026-10-15".into(), days: 33.0, incapacity_percent: 100, certificate: true, note: None }).unwrap();
        let id = sick["id"].as_str().unwrap().to_owned();
        assert!(store.save_absence(AbsenceInput { id: None, employee_id: employee.clone(), kind: "sick".into(), start_date: "2026-09-02".into(), end_date: "2026-09-01".into(), days: 1.0, incapacity_percent: 100, certificate: false, note: None }).is_err());
        store.mark_ijm_declared(&id).unwrap();
        assert!(store.mark_ijm_declared(&id).is_err());
        assert!(store.delete_absence(&id).is_err());
        let vacation = store.save_absence(AbsenceInput { id: None, employee_id: employee, kind: "vacation".into(), start_date: "2026-07-06".into(), end_date: "2026-07-10".into(), days: 5.0, incapacity_percent: 100, certificate: false, note: None }).unwrap();
        assert!(store.mark_ijm_declared(vacation["id"].as_str().unwrap()).is_err());
        store.delete_absence(vacation["id"].as_str().unwrap()).unwrap();
    }

    #[test]
    fn expense_claims_are_decided_then_frozen() {
        let (_temporary, store, employee) = store_with_employee();
        let claim = store.add_expense_claim(ExpenseClaimInput { employee_id: employee.clone(), claim_date: "2026-10-12".into(), category: "Repas".into(), description: "Repas client Dupont".into(), amount_cents: 4_850, receipt_name: None, receipt_base64: None }).unwrap();
        let id = claim["id"].as_str().unwrap().to_owned();
        assert!(store.add_expense_claim(ExpenseClaimInput { employee_id: employee, claim_date: "2026-10-12".into(), category: "Repas".into(), description: "x".into(), amount_cents: 0, receipt_name: None, receipt_base64: None }).is_err());
        assert_eq!(store.decide_expense_claim(&id, false, Some("Ticket manquant".into())).unwrap()["status"], "rejected");
        assert_eq!(store.decide_expense_claim(&id, true, None).unwrap()["status"], "approved");
        assert!(store.delete_expense_claim(&id).is_err());
        let connection = store.connect().unwrap();
        // Remboursée seulement avec la fiche de salaire qui la paie.
        connection.execute("UPDATE expense_claims SET status='reimbursed',payslip_id=NULL WHERE id=?", [&id]).unwrap_err();
    }
}
