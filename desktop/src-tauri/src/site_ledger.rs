//! Fiche chantier : budget prévu par nature de coût, sous-traitances
//! convenues contre devis, rattachement des factures fournisseurs. Le calcul
//! prévu/réel et le post-calcul se font dans `desktop/src/siteLedger.ts` à
//! partir des tables existantes ; ici seulement des enregistrements simples,
//! chacun réversible.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
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

const CATEGORIES: [&str; 5] = ["labor", "material", "subcontract", "machine", "other"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetLineInput {
    pub category: String,
    pub label: String,
    pub amount_cents: i64,
    #[serde(default)]
    pub minutes: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectBudgetInput {
    pub project_id: String,
    pub lines: Vec<BudgetLineInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSubcontractInput {
    #[serde(default)]
    pub id: Option<String>,
    pub project_id: String,
    #[serde(default)]
    pub supplier_id: Option<String>,
    pub label: String,
    pub agreed_cents: i64,
    pub closed: bool,
}

impl LocalStore {
    /// Remplace le budget prévu du chantier (une ligne par poste).
    pub fn save_project_budget(&self, input: ProjectBudgetInput) -> AppResult<Value> {
        if input.lines.len() > 300 {
            return Err(invalid("Le budget contient trop de lignes (300 au plus)."));
        }
        for line in &input.lines {
            let label = line.label.trim();
            if !CATEGORIES.contains(&line.category.as_str())
                || label.is_empty()
                || label.chars().count() > 160
                || !(0..=100_000_000_000).contains(&line.amount_cents)
                || line.minutes.is_some_and(|minutes| !(0..=100_000_000).contains(&minutes))
            {
                return Err(invalid("Vérifiez chaque poste du budget : nature, libellé et montant positif."));
            }
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)", [&input.project_id], |row| row.get(0))?;
        if !exists {
            return Err(invalid("Chantier introuvable."));
        }
        let now = now_iso();
        tx.execute("DELETE FROM project_budget_lines WHERE project_id=?", [&input.project_id])?;
        for (position, line) in input.lines.iter().enumerate() {
            tx.execute(
                "INSERT INTO project_budget_lines(id,project_id,position,category,label,amount_cents,minutes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(), input.project_id, position as i64, line.category, line.label.trim(), line.amount_cents, line.minutes, now, now],
            )?;
        }
        let total: i64 = input.lines.iter().map(|line| line.amount_cents).sum();
        append_audit(&tx, "save", "project_budget", &input.project_id, &json!({ "lines": input.lines.len(), "total_cents": total }))?;
        tx.commit()?;
        Ok(json!({ "projectId": input.project_id, "totalCents": total }))
    }

    pub fn save_project_subcontract(&self, input: ProjectSubcontractInput) -> AppResult<Value> {
        let label = input.label.trim().to_owned();
        if label.is_empty() || label.chars().count() > 160 {
            return Err(invalid("Décrivez la sous-traitance (160 caractères au plus)."));
        }
        if !(0..=100_000_000_000).contains(&input.agreed_cents) {
            return Err(invalid("Le montant convenu doit être positif."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)", [&input.project_id], |row| row.get(0))?;
        if !project {
            return Err(invalid("Chantier introuvable."));
        }
        let supplier = input.supplier_id.filter(|id| !id.is_empty());
        if let Some(supplier) = &supplier {
            let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM suppliers WHERE id=?)", [supplier], |row| row.get(0))?;
            if !known {
                return Err(invalid("Fournisseur introuvable."));
            }
        }
        let now = now_iso();
        let status = if input.closed { "closed" } else { "open" };
        let id = match input.id.filter(|id| !id.is_empty()) {
            Some(id) => {
                let changed = tx.execute(
                    "UPDATE project_subcontracts SET supplier_id=?,label=?,agreed_cents=?,status=?,updated_at=? WHERE id=? AND project_id=?",
                    params![supplier, label, input.agreed_cents, status, now, id, input.project_id],
                )?;
                if changed == 0 {
                    return Err(invalid("Sous-traitance introuvable."));
                }
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO project_subcontracts(id,project_id,supplier_id,label,agreed_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    params![id, input.project_id, supplier, label, input.agreed_cents, status, now, now],
                )?;
                id
            }
        };
        append_audit(&tx, "save", "project_subcontracts", &id, &json!({ "project_id": input.project_id, "agreed_cents": input.agreed_cents, "status": status }))?;
        tx.commit()?;
        Ok(json!({ "id": id }))
    }

    /// Relie (ou délie) une facture fournisseur à une sous-traitance du chantier.
    pub fn link_supplier_invoice_subcontract(&self, supplier_invoice_id: &str, subcontract_id: Option<&str>) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let invoice_project: Option<Option<String>> = tx
            .query_row("SELECT project_id FROM supplier_invoices WHERE id=?", [supplier_invoice_id], |row| row.get(0))
            .optional()?;
        let invoice_project = invoice_project.ok_or_else(|| invalid("Facture fournisseur introuvable."))?;
        let previous: Option<String> = tx
            .query_row("SELECT subcontract_id FROM supplier_invoice_subcontracts WHERE supplier_invoice_id=?", [supplier_invoice_id], |row| row.get(0))
            .optional()?;
        tx.execute("DELETE FROM supplier_invoice_subcontracts WHERE supplier_invoice_id=?", [supplier_invoice_id])?;
        if let Some(subcontract) = subcontract_id.filter(|id| !id.is_empty()) {
            let project: Option<String> = tx
                .query_row("SELECT project_id FROM project_subcontracts WHERE id=?", [subcontract], |row| row.get(0))
                .optional()?;
            let project = project.ok_or_else(|| invalid("Sous-traitance introuvable."))?;
            if invoice_project.as_deref().is_some_and(|current| current != project) {
                return Err(invalid("Cette facture est rattachée à un autre chantier."));
            }
            tx.execute(
                "INSERT INTO supplier_invoice_subcontracts(supplier_invoice_id,subcontract_id,created_at) VALUES(?,?,?)",
                params![supplier_invoice_id, subcontract, now_iso()],
            )?;
        }
        append_audit(&tx, "link", "supplier_invoice_subcontract", supplier_invoice_id, &json!({ "subcontract_id": subcontract_id, "previous": previous }))?;
        tx.commit()?;
        Ok(json!({ "previousSubcontractId": previous }))
    }

    /// Rattache une facture fournisseur brouillon à un chantier (ou l'en
    /// détache) et rend le chantier précédent, pour qu'Annuler le remette.
    /// Une facture validée garde son chantier : il est figé dans l'écriture.
    pub fn assign_supplier_invoice_project(&self, supplier_invoice_id: &str, project_id: Option<&str>) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<(String, Option<String>)> = tx
            .query_row("SELECT status,project_id FROM supplier_invoices WHERE id=?", [supplier_invoice_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let (status, previous) = current.ok_or_else(|| invalid("Facture fournisseur introuvable."))?;
        if status != "draft" {
            return Err(invalid("Une facture validée garde son chantier : il est figé dans la comptabilité."));
        }
        let project = project_id.filter(|id| !id.is_empty());
        if let Some(project) = project {
            let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)", [project], |row| row.get(0))?;
            if !known {
                return Err(invalid("Chantier introuvable."));
            }
        }
        tx.execute("UPDATE supplier_invoices SET project_id=? WHERE id=? AND status='draft'", params![project, supplier_invoice_id])?;
        append_audit(&tx, "assign_project", "supplier_invoices", supplier_invoice_id, &json!({ "project_id": project, "previous": previous }))?;
        tx.commit()?;
        Ok(json!({ "previousProjectId": previous }))
    }
}

#[tauri::command]
pub fn save_project_budget(state: tauri::State<'_, LocalStore>, input: ProjectBudgetInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_project_budget(input).map_err(command_error)
}

#[tauri::command]
pub fn save_project_subcontract(state: tauri::State<'_, LocalStore>, input: ProjectSubcontractInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_project_subcontract(input).map_err(command_error)
}

#[tauri::command]
pub fn link_supplier_invoice_subcontract(state: tauri::State<'_, LocalStore>, supplier_invoice_id: String, subcontract_id: Option<String>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.link_supplier_invoice_subcontract(&supplier_invoice_id, subcontract_id.as_deref()).map_err(command_error)
}

#[tauri::command]
pub fn assign_supplier_invoice_project(state: tauri::State<'_, LocalStore>, supplier_invoice_id: String, project_id: Option<String>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.assign_supplier_invoice_project(&supplier_invoice_id, project_id.as_deref()).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SaveSupplierInvoiceDraftInput, SupplierInvoiceLineInput};

    #[test]
    fn budget_subcontract_and_supplier_invoice_follow_the_site() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "site-ledger-test").unwrap();
        let client = store.create_record("clients", json!({"name":"Famille Dupont"})).unwrap()["id"].as_str().unwrap().to_owned();
        let project = store.create_record("projects", json!({"name":"Villa Dupont","client_id":client})).unwrap()["id"].as_str().unwrap().to_owned();
        let other = store.create_record("projects", json!({"name":"Atelier Martin","client_id":client})).unwrap()["id"].as_str().unwrap().to_owned();

        let saved = store.save_project_budget(ProjectBudgetInput { project_id: project.clone(), lines: vec![
            BudgetLineInput { category: "labor".into(), label: "Peintres".into(), amount_cents: 600_000, minutes: Some(6_000) },
            BudgetLineInput { category: "material".into(), label: "Peinture et fournitures".into(), amount_cents: 180_000, minutes: None },
        ] }).unwrap();
        assert_eq!(saved["totalCents"], json!(780_000));
        assert!(store.save_project_budget(ProjectBudgetInput { project_id: project.clone(), lines: vec![BudgetLineInput { category: "travel".into(), label: "x".into(), amount_cents: 1, minutes: None }] }).is_err());

        let supplier = store.create_record("suppliers", json!({"name":"Échafaudages Léman SA"})).unwrap()["id"].as_str().unwrap().to_owned();
        let subcontract = store.save_project_subcontract(ProjectSubcontractInput { id: None, project_id: project.clone(), supplier_id: Some(supplier.clone()), label: "Échafaudage façade".into(), agreed_cents: 240_000, closed: false }).unwrap()["id"].as_str().unwrap().to_owned();

        let draft = store.save_supplier_invoice_draft(SaveSupplierInvoiceDraftInput {
            id: None, supplier_id: supplier.clone(), project_id: None, date: "2026-10-20".into(), due_date: "2026-11-19".into(),
            reference: Some("F-2026-118".into()), note: Some("Chantier Villa Dupont".into()),
            items: vec![SupplierInvoiceLineInput { id: None, description: "Location échafaudage".into(), quantity_milli: 1_000, unit: Some("forfait".into()), unit_price_cents: 120_000, discount_bp: 0, vat_bp: 810, category: "Sous-traitance".into(), expense_account_id: None, project_id: None }],
        }).unwrap();
        let invoice = draft["invoice"]["id"].as_str().unwrap().to_owned();
        let assigned = store.assign_supplier_invoice_project(&invoice, Some(&project)).unwrap();
        assert_eq!(assigned["previousProjectId"], Value::Null);
        // Annuler remet l'état précédent.
        store.assign_supplier_invoice_project(&invoice, None).unwrap();
        store.assign_supplier_invoice_project(&invoice, Some(&project)).unwrap();
        store.link_supplier_invoice_subcontract(&invoice, Some(&subcontract)).unwrap();
        let other_subcontract = store.save_project_subcontract(ProjectSubcontractInput { id: None, project_id: other.clone(), supplier_id: None, label: "Électricité".into(), agreed_cents: 50_000, closed: false }).unwrap()["id"].as_str().unwrap().to_owned();
        assert!(store.link_supplier_invoice_subcontract(&invoice, Some(&other_subcontract)).is_err(), "un autre chantier est refusé");
        let unlinked = store.link_supplier_invoice_subcontract(&invoice, None).unwrap();
        assert_eq!(unlinked["previousSubcontractId"], json!(subcontract));
        assert!(store.assign_supplier_invoice_project("inconnue", Some(&project)).is_err());

        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["project_budget_lines"].as_array().unwrap().len(), 2);
        assert_eq!(workspace["project_subcontracts"].as_array().unwrap().len(), 2);
    }
}
