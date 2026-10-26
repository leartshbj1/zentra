//! Parc installé chez les clients : chaudières, pompes à chaleur, portes…
//! Chaque équipement peut avoir un entretien périodique. L'interface calcule
//! la prochaine échéance ; planifier un entretien crée en une seule
//! transaction le rendez-vous d'agenda et la ligne d'entretien, et annuler
//! les retire tous les deux tant que le rendez-vous n'a pas eu lieu.

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    accounting::validate_date,
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

fn text(value: &str, max: usize, label: &str) -> AppResult<String> {
    let value = value.trim().to_owned();
    if value.chars().count() > max {
        return Err(invalid(format!("{label} : {max} caractères au maximum.")));
    }
    Ok(value)
}

fn optional_date(value: Option<String>, field: &str) -> AppResult<Option<String>> {
    match value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
        Some(date) => {
            validate_date(&date, field)?;
            Ok(Some(date))
        }
        None => Ok(None),
    }
}

fn valid_time(value: &str) -> bool {
    value.len() == 5
        && chrono::NaiveTime::parse_from_str(value, "%H:%M").is_ok_and(|time| time.format("%H:%M").to_string() == value)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EquipmentInput {
    pub id: Option<String>,
    pub client_id: String,
    pub project_id: Option<String>,
    pub kind: String,
    pub brand: String,
    pub model: String,
    pub serial_number: String,
    pub installed_on: Option<String>,
    pub warranty_until: Option<String>,
    pub location: String,
    pub service_interval_months: Option<i64>,
    pub last_service_on: Option<String>,
    pub notes: String,
    pub archived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanServiceInput {
    pub equipment_id: String,
    pub date: String,
    pub start_time: String,
    pub end_time: String,
    pub employee_id: Option<String>,
    pub title: String,
}

impl LocalStore {
    pub fn save_installed_equipment(&self, input: EquipmentInput) -> AppResult<Value> {
        let kind = text(&input.kind, 120, "Type")?;
        if kind.is_empty() {
            return Err(invalid("Indiquez le type d’équipement, par exemple « Chaudière »."));
        }
        let brand = text(&input.brand, 120, "Marque")?;
        let model = text(&input.model, 120, "Modèle")?;
        let serial = text(&input.serial_number, 120, "Numéro de série")?;
        let location = text(&input.location, 300, "Lieu")?;
        let notes = text(&input.notes, 4000, "Notes")?;
        let installed_on = optional_date(input.installed_on, "installed_on")?;
        let warranty_until = optional_date(input.warranty_until, "warranty_until")?;
        let last_service_on = optional_date(input.last_service_on, "last_service_on")?;
        if input.service_interval_months.is_some_and(|months| !(1..=120).contains(&months)) {
            return Err(invalid("L’intervalle d’entretien va de 1 à 120 mois."));
        }
        let project_id = input.project_id.filter(|value| !value.is_empty());
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let client: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM clients WHERE id=?)", [&input.client_id], |row| row.get(0))?;
        if !client {
            return Err(invalid("Choisissez le client chez qui l’équipement est installé."));
        }
        if let Some(project) = project_id.as_deref() {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)", [project], |row| row.get(0))?;
            if !exists {
                return Err(invalid("Projet introuvable."));
            }
        }
        let now = now_iso();
        let archived_at = input.archived.then(|| now.clone());
        let id = match input.id.filter(|value| !value.is_empty()) {
            Some(id) => {
                let changed = tx.execute(
                    "UPDATE installed_equipment SET client_id=?,project_id=?,kind=?,brand=?,model=?,serial_number=?,installed_on=?,warranty_until=?,location=?,
                       service_interval_months=?,last_service_on=?,notes=?,archived_at=CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(archived_at,?) END,updated_at=? WHERE id=?",
                    params![input.client_id, project_id, kind, brand, model, serial, installed_on, warranty_until, location,
                        input.service_interval_months, last_service_on, notes, archived_at, archived_at, now, id],
                )?;
                if changed == 0 {
                    return Err(invalid("Équipement introuvable."));
                }
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO installed_equipment(id,client_id,project_id,kind,brand,model,serial_number,installed_on,warranty_until,location,
                       service_interval_months,last_service_on,notes,archived_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    params![id, input.client_id, project_id, kind, brand, model, serial, installed_on, warranty_until, location,
                        input.service_interval_months, last_service_on, notes, archived_at, now, now],
                )?;
                id
            }
        };
        append_audit(&tx, "save", "installed_equipment", &id, &json!({ "client_id": input.client_id, "kind": kind, "interval": input.service_interval_months }))?;
        tx.commit()?;
        Ok(json!({ "id": id }))
    }

    pub fn delete_installed_equipment(&self, id: &str) -> AppResult<()> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Les rendez-vous déjà planifiés restent dans l'agenda : seul le lien disparaît.
        if tx.execute("DELETE FROM installed_equipment WHERE id=?", [id])? == 0 {
            return Err(invalid("Équipement introuvable."));
        }
        append_audit(&tx, "delete", "installed_equipment", id, &json!({}))?;
        tx.commit()?;
        Ok(())
    }

    /// Crée le rendez-vous d'entretien et sa ligne dans la même transaction.
    pub fn plan_equipment_service(&self, input: PlanServiceInput) -> AppResult<Value> {
        validate_date(&input.date, "date")?;
        if !valid_time(&input.start_time) || !valid_time(&input.end_time) || input.end_time <= input.start_time {
            return Err(invalid("Choisissez une heure de fin après l’heure de début."));
        }
        let title = text(&input.title, 200, "Titre")?;
        if title.is_empty() {
            return Err(invalid("Le rendez-vous d’entretien a besoin d’un titre."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let equipment: Option<(String, Option<String>)> = tx
            .query_row("SELECT location,project_id FROM installed_equipment WHERE id=? AND archived_at IS NULL", [&input.equipment_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let Some((location, project_id)) = equipment else { return Err(invalid("Équipement introuvable ou archivé.")) };
        if let Some(employee) = input.employee_id.as_deref() {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM employees WHERE id=?)", [employee], |row| row.get(0))?;
            if !exists {
                return Err(invalid("Collaborateur introuvable."));
            }
        }
        let pending: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM equipment_services s JOIN agenda_events e ON e.id=s.agenda_event_id
               WHERE s.equipment_id=? AND s.status='planned' AND e.status='scheduled')",
            [&input.equipment_id],
            |row| row.get(0),
        )?;
        if pending {
            return Err(invalid("Un entretien est déjà planifié pour cet équipement."));
        }
        let now = now_iso();
        let event_id = Uuid::new_v4().to_string();
        let location = Some(location.trim().to_owned()).filter(|value| !value.is_empty());
        tx.execute(
            "INSERT INTO agenda_events(id,title,start_date,end_date,all_day,start_time,end_time,kind,status,location,notes,project_id,employee_id,created_at,updated_at)
             VALUES(?,?,?,?,0,?,?,'visit','scheduled',?,NULL,?,?,?,?)",
            params![event_id, title, input.date, input.date, input.start_time, input.end_time, location, project_id, input.employee_id, now, now],
        )?;
        let service_id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO equipment_services(id,equipment_id,status,service_date,agenda_event_id,notes,created_at,updated_at) VALUES(?,?,'planned',?,?,'',?,?)",
            params![service_id, input.equipment_id, input.date, event_id, now, now],
        )?;
        append_audit(&tx, "plan", "equipment_service", &service_id, &json!({ "equipment_id": input.equipment_id, "agenda_event_id": event_id, "date": input.date }))?;
        tx.commit()?;
        Ok(json!({ "serviceId": service_id, "agendaEventId": event_id }))
    }

    /// Annule un entretien planifié : la ligne et son rendez-vous encore à venir disparaissent.
    pub fn cancel_equipment_service(&self, service_id: &str) -> AppResult<()> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, Option<String>)> = tx
            .query_row("SELECT status,agenda_event_id FROM equipment_services WHERE id=?", [service_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let Some((status, event_id)) = row else { return Err(invalid("Entretien introuvable.")) };
        if status != "planned" {
            return Err(invalid("Cet entretien est déjà fait : il reste dans l’historique."));
        }
        tx.execute("DELETE FROM equipment_services WHERE id=?", [service_id])?;
        if let Some(event) = event_id.as_deref() {
            tx.execute("DELETE FROM agenda_events WHERE id=? AND status='scheduled'", [event])?;
        }
        append_audit(&tx, "cancel", "equipment_service", service_id, &json!({ "agenda_event_id": event_id }))?;
        tx.commit()?;
        Ok(())
    }

    /// Note un entretien fait : la ligne planifiée passe à « fait » (ou une
    /// ligne est créée), le rendez-vous est terminé et la date du dernier
    /// entretien avance.
    pub fn complete_equipment_service(&self, equipment_id: &str, service_id: Option<&str>, date: &str, notes: &str) -> AppResult<Value> {
        validate_date(date, "date")?;
        let notes = text(notes, 2000, "Notes")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM installed_equipment WHERE id=?)", [equipment_id], |row| row.get(0))?;
        if !exists {
            return Err(invalid("Équipement introuvable."));
        }
        let now = now_iso();
        let id = complete_in(&tx, equipment_id, service_id, date, &notes, &now)?;
        tx.execute(
            "UPDATE installed_equipment SET last_service_on=CASE WHEN last_service_on IS NULL OR last_service_on<? THEN ? ELSE last_service_on END,updated_at=? WHERE id=?",
            params![date, date, now, equipment_id],
        )?;
        append_audit(&tx, "complete", "equipment_service", &id, &json!({ "equipment_id": equipment_id, "date": date }))?;
        tx.commit()?;
        Ok(json!({ "serviceId": id }))
    }
}

fn complete_in(tx: &Transaction<'_>, equipment_id: &str, service_id: Option<&str>, date: &str, notes: &str, now: &str) -> AppResult<String> {
    if let Some(service_id) = service_id {
        let event: Option<Option<String>> = tx
            .query_row("SELECT agenda_event_id FROM equipment_services WHERE id=? AND equipment_id=?", [service_id, equipment_id], |row| row.get(0))
            .optional()?;
        let Some(event) = event else { return Err(invalid("Entretien introuvable.")) };
        tx.execute("UPDATE equipment_services SET status='done',service_date=?,notes=?,updated_at=? WHERE id=?", params![date, notes, now, service_id])?;
        if let Some(event) = event {
            tx.execute("UPDATE agenda_events SET status='completed',updated_at=? WHERE id=? AND status='scheduled'", params![now, event])?;
        }
        return Ok(service_id.to_owned());
    }
    let id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO equipment_services(id,equipment_id,status,service_date,agenda_event_id,notes,created_at,updated_at) VALUES(?,?,'done',?,NULL,?,?,?)",
        params![id, equipment_id, date, notes, now, now],
    )?;
    Ok(id)
}

#[tauri::command]
pub fn save_installed_equipment(state: tauri::State<'_, LocalStore>, input: EquipmentInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_installed_equipment(input).map_err(command_error)
}

#[tauri::command]
pub fn delete_installed_equipment(state: tauri::State<'_, LocalStore>, id: String) -> Result<(), String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.delete_installed_equipment(&id).map_err(command_error)
}

#[tauri::command]
pub fn plan_equipment_service(state: tauri::State<'_, LocalStore>, input: PlanServiceInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.plan_equipment_service(input).map_err(command_error)
}

#[tauri::command]
pub fn cancel_equipment_service(state: tauri::State<'_, LocalStore>, service_id: String) -> Result<(), String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.cancel_equipment_service(&service_id).map_err(command_error)
}

#[tauri::command]
pub fn complete_equipment_service(state: tauri::State<'_, LocalStore>, equipment_id: String, service_id: Option<String>, date: String, notes: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.complete_equipment_service(&equipment_id, service_id.as_deref(), &date, &notes).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "installed-equipment-test").unwrap();
        store
            .connect()
            .unwrap()
            .execute("INSERT INTO clients(id,name,address_line1,postal_code,city,country,created_at,updated_at) VALUES('c1','Keller','Rue du Lac 4','1260','Nyon','CH','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [])
            .unwrap();
        (temporary, store)
    }

    fn boiler() -> EquipmentInput {
        EquipmentInput { id: None, client_id: "c1".into(), project_id: None, kind: "Chaudière".into(), brand: "Viessmann".into(), model: "Vitodens 200".into(),
            serial_number: "7720-1144".into(), installed_on: Some("2023-11-20".into()), warranty_until: Some("2025-11-20".into()), location: "Sous-sol, Rue du Lac 4, Nyon".into(),
            service_interval_months: Some(12), last_service_on: Some("2025-11-25".into()), notes: String::new(), archived: false }
    }

    fn plan(equipment_id: &str) -> PlanServiceInput {
        PlanServiceInput { equipment_id: equipment_id.into(), date: "2026-11-24".into(), start_time: "08:00".into(), end_time: "09:00".into(), employee_id: None,
            title: "Entretien · Chaudière Keller".into() }
    }

    #[test]
    fn equipment_is_validated_and_saved() {
        let (_temporary, store) = store();
        assert!(store.save_installed_equipment(EquipmentInput { kind: " ".into(), ..boiler() }).is_err());
        assert!(store.save_installed_equipment(EquipmentInput { client_id: "missing".into(), ..boiler() }).is_err());
        assert!(store.save_installed_equipment(EquipmentInput { service_interval_months: Some(0), ..boiler() }).is_err());
        assert!(store.save_installed_equipment(EquipmentInput { warranty_until: Some("2025-02-30".into()), ..boiler() }).is_err());
        let id = store.save_installed_equipment(boiler()).unwrap()["id"].as_str().unwrap().to_owned();
        store.save_installed_equipment(EquipmentInput { id: Some(id.clone()), archived: true, ..boiler() }).unwrap();
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["installed_equipment"][0]["serial_number"], "7720-1144");
        assert!(workspace["installed_equipment"][0]["archived_at"].is_string());
    }

    #[test]
    fn planning_creates_one_appointment_and_cancel_removes_it() {
        let (_temporary, store) = store();
        let id = store.save_installed_equipment(boiler()).unwrap()["id"].as_str().unwrap().to_owned();
        assert!(store.plan_equipment_service(PlanServiceInput { end_time: "07:00".into(), ..plan(&id) }).is_err());
        let planned = store.plan_equipment_service(plan(&id)).unwrap();
        assert!(store.plan_equipment_service(plan(&id)).unwrap_err().to_string().contains("déjà planifié"));
        let connection = store.connect().unwrap();
        let (kind, location): (String, String) = connection
            .query_row("SELECT kind,location FROM agenda_events WHERE id=?", [planned["agendaEventId"].as_str().unwrap()], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert_eq!((kind.as_str(), location.as_str()), ("visit", "Sous-sol, Rue du Lac 4, Nyon"));
        drop(connection);
        store.cancel_equipment_service(planned["serviceId"].as_str().unwrap()).unwrap();
        let events: i64 = store.connect().unwrap().query_row("SELECT COUNT(*) FROM agenda_events", [], |row| row.get(0)).unwrap();
        assert_eq!(events, 0);
    }

    #[test]
    fn completing_moves_the_last_service_date_forward_only() {
        let (_temporary, store) = store();
        let id = store.save_installed_equipment(boiler()).unwrap()["id"].as_str().unwrap().to_owned();
        let planned = store.plan_equipment_service(plan(&id)).unwrap();
        let service = planned["serviceId"].as_str().unwrap();
        store.complete_equipment_service(&id, Some(service), "2026-11-24", "Brûleur nettoyé").unwrap();
        assert!(store.cancel_equipment_service(service).is_err());
        store.complete_equipment_service(&id, None, "2024-01-10", "").unwrap();
        let connection = store.connect().unwrap();
        let last: String = connection.query_row("SELECT last_service_on FROM installed_equipment WHERE id=?", [&id], |row| row.get(0)).unwrap();
        let status: String = connection.query_row("SELECT status FROM agenda_events WHERE id=?", [planned["agendaEventId"].as_str().unwrap()], |row| row.get(0)).unwrap();
        assert_eq!((last.as_str(), status.as_str()), ("2026-11-24", "completed"));
    }
}
