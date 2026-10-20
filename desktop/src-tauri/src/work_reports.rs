//! Rapports de régie signés sur place : heures et matériel, signature du
//! client sur le téléphone, puis facture en brouillon au clic. Une fois
//! signé, le rapport est figé ; la facture reprend exactement ses lignes.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    accounting::validate_date,
    audit::append_audit,
    database::{now_iso, query_all, query_record_tx, recompute_all_invoice_lines, recompute_invoice, LocalStore},
    error::{command_error, AppError, AppResult},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// Chemin SVG d'une signature : seulement M/L et des nombres, au moins un trait.
pub(crate) fn valid_signature(path: &str) -> bool {
    (10..=60_000).contains(&path.len())
        && path.chars().all(|c| matches!(c, 'M' | 'L' | 'm' | 'l' | '0'..='9' | ' ' | '.' | ',' | '-'))
        && path.matches(['L', 'l']).count() >= 2
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkReportLineInput {
    pub kind: String,
    #[serde(default)]
    pub catalog_item_id: Option<String>,
    pub description: String,
    pub quantity: f64,
    pub unit: String,
    pub unit_price_cents: i64,
    #[serde(default)]
    pub vat_bp: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkReportInput {
    #[serde(default)]
    pub id: Option<String>,
    pub client_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub report_date: String,
    #[serde(default)]
    pub site: Option<String>,
    pub description: String,
    #[serde(default)]
    pub technician: Option<String>,
    pub lines: Vec<WorkReportLineInput>,
}

fn clean(value: Option<String>, max: usize, label: &str) -> AppResult<Option<String>> {
    let value = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    if value.as_ref().is_some_and(|v| v.chars().count() > max) {
        return Err(invalid(format!("{label} : {max} caractères au maximum.")));
    }
    Ok(value)
}

impl LocalStore {
    pub fn save_work_report(&self, input: WorkReportInput) -> AppResult<Value> {
        validate_date(&input.report_date, "report_date")?;
        let description = input.description.trim().to_owned();
        if description.is_empty() || description.chars().count() > 4000 {
            return Err(invalid("Décrivez le travail effectué (4000 caractères au maximum)."));
        }
        if input.lines.len() > 200 {
            return Err(invalid("Un rapport contient 200 lignes au maximum."));
        }
        for line in &input.lines {
            if !matches!(line.kind.as_str(), "labor" | "material")
                || line.description.trim().is_empty() || line.description.chars().count() > 500
                || !(line.quantity > 0.0 && line.quantity <= 100_000.0) || !line.quantity.is_finite()
                || line.unit.trim().is_empty() || line.unit.chars().count() > 32
                || !(0..=100_000_000_000).contains(&line.unit_price_cents) || !(0..=10_000).contains(&line.vat_bp)
            {
                return Err(invalid("Vérifiez chaque ligne : description, quantité positive, unité, prix et TVA."));
            }
        }
        let site = clean(input.site, 300, "Lieu")?;
        let technician = clean(input.technician, 200, "Intervenant")?;
        let project_id = input.project_id.filter(|v| !v.is_empty());
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let client: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM clients WHERE id=?)", [&input.client_id], |r| r.get(0))?;
        if !client {
            return Err(invalid("Choisissez le client du rapport."));
        }
        let now = now_iso();
        let id = match input.id.filter(|v| !v.is_empty()) {
            Some(id) => {
                let status: Option<String> = tx.query_row("SELECT status FROM work_reports WHERE id=?", [&id], |r| r.get(0)).optional()?;
                match status.as_deref() {
                    Some("draft") => {}
                    Some(_) => return Err(invalid("Ce rapport est signé : il ne se modifie plus.")),
                    None => return Err(invalid("Rapport introuvable.")),
                }
                tx.execute(
                    "UPDATE work_reports SET client_id=?,project_id=?,report_date=?,site=?,description=?,technician=?,updated_at=? WHERE id=?",
                    params![input.client_id, project_id, input.report_date, site, description, technician, now, id],
                )?;
                tx.execute("DELETE FROM work_report_lines WHERE report_id=?", [&id])?;
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO work_reports(id,client_id,project_id,report_date,site,description,technician,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'draft',?,?)",
                    params![id, input.client_id, project_id, input.report_date, site, description, technician, now, now],
                )?;
                id
            }
        };
        for (position, line) in input.lines.iter().enumerate() {
            tx.execute(
                "INSERT INTO work_report_lines(id,report_id,position,kind,catalog_item_id,description,quantity,unit,unit_price_cents,vat_bp,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(), id, position as i64, line.kind, line.catalog_item_id.as_deref().filter(|v| !v.is_empty()),
                    line.description.trim(), line.quantity, line.unit.trim(), line.unit_price_cents, line.vat_bp, now],
            )?;
        }
        let record = query_record_tx(&tx, "work_reports", &id)?;
        append_audit(&tx, "save", "work_report", &id, &record)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn delete_work_report(&self, id: &str) -> AppResult<()> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deleted = tx.execute("DELETE FROM work_reports WHERE id=? AND status='draft'", [id])?;
        if deleted != 1 {
            return Err(invalid("Seul un rapport non signé se supprime."));
        }
        append_audit(&tx, "delete", "work_report", id, &json!({}))?;
        tx.commit()?;
        Ok(())
    }

    pub fn sign_work_report(&self, id: &str, signer_name: &str, signature_path: &str) -> AppResult<Value> {
        let signer = signer_name.trim();
        if signer.is_empty() || signer.chars().count() > 200 {
            return Err(invalid("Indiquez le nom de la personne qui signe."));
        }
        if !valid_signature(signature_path) {
            return Err(invalid("La signature est vide ou illisible. Faites signer à nouveau."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let lines: i64 = tx.query_row("SELECT COUNT(*) FROM work_report_lines WHERE report_id=?", [id], |r| r.get(0))?;
        if lines == 0 {
            return Err(invalid("Ajoutez au moins une ligne d'heures ou de matériel avant la signature."));
        }
        let now = now_iso();
        let changed = tx.execute(
            "UPDATE work_reports SET status='signed',signer_name=?,signature_path=?,signed_at=?,updated_at=? WHERE id=? AND status='draft'",
            params![signer, signature_path, now, now, id],
        )?;
        if changed != 1 {
            return Err(invalid("Ce rapport est déjà signé ou introuvable."));
        }
        let record = query_record_tx(&tx, "work_reports", id)?;
        append_audit(&tx, "sign", "work_report", id, &json!({"signer_name": signer, "signed_at": now}))?;
        tx.commit()?;
        Ok(record)
    }

    /// Facture en brouillon avec exactement les lignes du rapport signé.
    pub fn invoice_work_report(&self, id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let report: Option<(String, Option<String>, String, String, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT client_id,project_id,report_date,status,invoice_id,site FROM work_reports WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?;
        let (client_id, project_id, date, status, invoice_id, site) = report.ok_or_else(|| invalid("Rapport introuvable."))?;
        if let Some(invoice_id) = invoice_id {
            let invoice = query_record_tx(&tx, "invoices", &invoice_id)?;
            tx.commit()?;
            return Ok(invoice);
        }
        if status != "signed" {
            return Err(invalid("Faites d'abord signer le rapport."));
        }
        let lines = query_all(&tx, "SELECT catalog_item_id,description,quantity,unit,unit_price_cents,vat_bp FROM work_report_lines WHERE report_id=? ORDER BY position,id", params![id])?;
        let invoice_id = Uuid::new_v4().to_string();
        let now = now_iso();
        let title = match site { Some(site) => format!("Intervention du {date} · {site}"), None => format!("Intervention du {date}") };
        let title: String = title.chars().take(200).collect();
        tx.execute(
            "INSERT INTO invoices(id,client_id,project_id,title,type,status,service_date_from,service_date_to,currency,notes,created_at,updated_at) VALUES(?,?,?,?,'standard','brouillon',?,?,'CHF',?,?,?)",
            params![invoice_id, client_id, project_id, title, date, date, "Selon rapport d'intervention signé.", now, now],
        )?;
        for (position, line) in lines.iter().enumerate() {
            tx.execute(
                "INSERT INTO invoice_items(id,invoice_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,0,0,0,?,?)",
                params![Uuid::new_v4().to_string(), invoice_id, line["catalog_item_id"].as_str(), position as i64, line["description"].as_str(),
                    line["quantity"].as_f64(), line["unit"].as_str(), line["unit_price_cents"].as_i64(), line["vat_bp"].as_i64(), now, now],
            )?;
        }
        recompute_all_invoice_lines(&tx, &invoice_id)?;
        recompute_invoice(&tx, &invoice_id)?;
        tx.execute("UPDATE work_reports SET status='invoiced',invoice_id=?,updated_at=? WHERE id=?", params![invoice_id, now, id])?;
        let invoice = query_record_tx(&tx, "invoices", &invoice_id)?;
        append_audit(&tx, "invoice", "work_report", id, &json!({"invoice_id": invoice_id}))?;
        tx.commit()?;
        Ok(invoice)
    }
}

#[tauri::command]
pub fn save_work_report(state: tauri::State<'_, LocalStore>, input: WorkReportInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_work_report(input).map_err(command_error)
}

#[tauri::command]
pub fn delete_work_report(state: tauri::State<'_, LocalStore>, id: String) -> Result<(), String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.delete_work_report(&id).map_err(command_error)
}

#[tauri::command]
pub fn sign_work_report(state: tauri::State<'_, LocalStore>, id: String, signer_name: String, signature_path: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.sign_work_report(&id, &signer_name, &signature_path).map_err(command_error)
}

#[tauri::command]
pub fn invoice_work_report(state: tauri::State<'_, LocalStore>, id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.invoice_work_report(&id).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIGNATURE: &str = "M10 50 L40 20 L80 60 L120 30";

    fn store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "work-reports-test").unwrap();
        store
            .connect()
            .unwrap()
            .execute("INSERT INTO clients(id,name,address_line1,postal_code,city,country,created_at,updated_at) VALUES('c1','Dupont SA','Rue du Lac 3','1006','Lausanne','CH','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [])
            .unwrap();
        (temporary, store)
    }

    fn input(lines: Vec<WorkReportLineInput>) -> WorkReportInput {
        WorkReportInput { id: None, client_id: "c1".into(), project_id: None, report_date: "2026-10-20".into(), site: Some("Cuisine".into()),
            description: "Remplacement du mitigeur".into(), technician: Some("Marc".into()), lines }
    }

    fn line(kind: &str, quantity: f64, price: i64) -> WorkReportLineInput {
        WorkReportLineInput { kind: kind.into(), catalog_item_id: None, description: format!("{kind} {quantity}"), quantity, unit: if kind == "labor" { "h".into() } else { "pce".into() }, unit_price_cents: price, vat_bp: 810 }
    }

    #[test]
    fn signatures_are_short_vector_paths() {
        assert!(valid_signature(SIGNATURE));
        assert!(!valid_signature("M10 50"));
        assert!(!valid_signature("M10 50 L20 30 L30 40 <script>"));
    }

    #[test]
    fn a_signed_report_is_frozen_and_becomes_one_draft_invoice() {
        let (_temporary, store) = store();
        let draft = store.save_work_report(input(vec![])).unwrap();
        let id = draft["id"].as_str().unwrap().to_owned();
        assert!(store.sign_work_report(&id, "M. Dupont", SIGNATURE).unwrap_err().to_string().contains("au moins une ligne"));
        let mut edit = input(vec![line("labor", 3.0, 9_500), line("material", 1.0, 12_000)]);
        edit.id = Some(id.clone());
        store.save_work_report(edit.clone()).unwrap();
        assert!(store.sign_work_report(&id, "M. Dupont", "M1 1").is_err());
        store.sign_work_report(&id, "M. Dupont", SIGNATURE).unwrap();
        assert!(store.save_work_report(edit).is_err());
        assert!(store.delete_work_report(&id).is_err());
        let connection = store.connect().unwrap();
        assert!(connection.execute("UPDATE work_reports SET description='autre' WHERE id=?", [&id]).is_err());
        assert!(connection.execute("DELETE FROM work_report_lines WHERE report_id=?", [&id]).is_err());
        drop(connection);
        let invoice = store.invoice_work_report(&id).unwrap();
        assert_eq!(invoice["status"], "brouillon");
        // 3 h × 95.00 + 120.00 = 405.00 net, TVA 8.1 % ligne par ligne.
        assert_eq!(invoice["subtotal_cents"], 40_500);
        assert_eq!(invoice["total_cents"], 40_500 + 2_309 + 972);
        assert_eq!(store.invoice_work_report(&id).unwrap()["id"], invoice["id"]);
        let status: String = store.connect().unwrap().query_row("SELECT status FROM work_reports WHERE id=?", [&id], |r| r.get(0)).unwrap();
        assert_eq!(status, "invoiced");
    }

    #[test]
    fn drafts_can_be_deleted() {
        let (_temporary, store) = store();
        let id = store.save_work_report(input(vec![line("labor", 1.5, 9_000)])).unwrap()["id"].as_str().unwrap().to_owned();
        store.delete_work_report(&id).unwrap();
        let count: i64 = store.connect().unwrap().query_row("SELECT COUNT(*) FROM work_report_lines", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }
}
