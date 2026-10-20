//! Centres de coûts et budget. Le réel vient du journal (contre-valeur CHF) ;
//! le centre d'une ligne suit son projet, sinon sa personne, sinon son compte.
//! Les écarts et pourcentages sont calculés par l'interface, de façon
//! déterministe, à partir de ces sommes.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{command_error, AppError, AppResult},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CostCenterInput {
    pub id: Option<String>,
    pub code: String,
    pub name: String,
    pub archived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetAccountInput {
    pub account_id: String,
    pub months: Vec<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetInput {
    pub year: i64,
    pub cost_center_id: String,
    pub accounts: Vec<BudgetAccountInput>,
}

/// Centre d'une ligne : projet, sinon personne, sinon compte, sinon « non réparti » ('').
const RESOLVED_CENTER: &str = "COALESCE(pc.cost_center_id, ec.cost_center_id, ac.cost_center_id, '')";
const CENTER_JOINS: &str = "LEFT JOIN cost_center_assignments pc ON pc.kind='project' AND pc.target_id=jl.project_id
     LEFT JOIN cost_center_assignments ec ON ec.kind='employee' AND ec.target_id=jl.employee_id
     LEFT JOIN cost_center_assignments ac ON ac.kind='account' AND ac.target_id=jl.account_id";

impl LocalStore {
    pub fn list_cost_centers(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(json!({
            "centers": query_all(&connection, "SELECT id,code,name,archived_at FROM cost_centers ORDER BY archived_at IS NOT NULL,code", [])?,
            "assignments": query_all(&connection, "SELECT kind,target_id,cost_center_id FROM cost_center_assignments ORDER BY kind,target_id", [])?,
        }))
    }

    pub fn save_cost_center(&self, input: CostCenterInput) -> AppResult<Value> {
        let code = input.code.trim().to_uppercase();
        let name = input.name.trim().to_owned();
        if code.is_empty() || code.chars().count() > 12 || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(invalid("Le code du centre : 1 à 12 lettres ou chiffres, sans espace (par exemple ATELIER)."));
        }
        if name.is_empty() || name.chars().count() > 80 {
            return Err(invalid("Donnez un nom au centre de coûts (80 caractères au plus)."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        let taken: Option<String> = tx.query_row("SELECT id FROM cost_centers WHERE code=?", [&code], |row| row.get(0)).optional()?;
        let id = match input.id {
            Some(id) => {
                if taken.as_deref().is_some_and(|other| other != id) {
                    return Err(invalid("Ce code est déjà utilisé par un autre centre."));
                }
                let changed = tx.execute(
                    "UPDATE cost_centers SET code=?,name=?,archived_at=CASE WHEN ? THEN COALESCE(archived_at,?) ELSE NULL END,updated_at=? WHERE id=?",
                    params![code, name, input.archived, now, now, id],
                )?;
                if changed == 0 {
                    return Err(invalid("Centre de coûts introuvable."));
                }
                id
            }
            None => {
                if taken.is_some() {
                    return Err(invalid("Ce code est déjà utilisé par un autre centre."));
                }
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO cost_centers(id,code,name,archived_at,created_at,updated_at) VALUES(?,?,?,NULL,?,?)",
                    params![id, code, name, now, now],
                )?;
                id
            }
        };
        append_audit(&tx, "save", "cost_centers", &id, &json!({ "code": code, "name": name, "archived": input.archived }))?;
        tx.commit()?;
        Ok(json!({ "id": id }))
    }

    pub fn assign_cost_center(&self, kind: &str, target_id: &str, cost_center_id: Option<&str>) -> AppResult<()> {
        if !matches!(kind, "project" | "employee" | "account") || target_id.is_empty() || target_id.len() > 64 {
            return Err(invalid("Rattachement inconnu."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let table = match kind { "project" => "projects", "employee" => "employees", _ => "accounts" };
        let exists: bool = tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?)"), [target_id], |row| row.get(0))?;
        if !exists {
            return Err(invalid("L'élément à rattacher est introuvable."));
        }
        match cost_center_id {
            Some(center) => {
                let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM cost_centers WHERE id=? AND archived_at IS NULL)", [center], |row| row.get(0))?;
                if !active {
                    return Err(invalid("Choisissez un centre de coûts actif."));
                }
                tx.execute(
                    "INSERT INTO cost_center_assignments(kind,target_id,cost_center_id,updated_at) VALUES(?,?,?,?)
                     ON CONFLICT(kind,target_id) DO UPDATE SET cost_center_id=excluded.cost_center_id,updated_at=excluded.updated_at",
                    params![kind, target_id, center, now_iso()],
                )?;
            }
            None => {
                tx.execute("DELETE FROM cost_center_assignments WHERE kind=? AND target_id=?", params![kind, target_id])?;
            }
        }
        append_audit(&tx, "assign", "cost_center_assignments", &format!("{kind}:{target_id}"), &json!({ "cost_center_id": cost_center_id }))?;
        tx.commit()?;
        Ok(())
    }

    /// Remplace le budget d'une année pour un centre (ou toute l'entreprise).
    pub fn save_budget(&self, input: BudgetInput) -> AppResult<Value> {
        if !(2000..=2100).contains(&input.year) || input.accounts.len() > 500 {
            return Err(invalid("Budget invalide."));
        }
        if input.accounts.iter().any(|row| row.months.len() != 12 || row.months.iter().any(|v| !(0..=100_000_000_000).contains(v))) {
            return Err(invalid("Chaque compte du budget a douze montants positifs."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !input.cost_center_id.is_empty() {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM cost_centers WHERE id=?)", [&input.cost_center_id], |row| row.get(0))?;
            if !exists {
                return Err(invalid("Centre de coûts introuvable."));
            }
        }
        tx.execute("DELETE FROM budget_lines WHERE year=? AND cost_center_id=?", params![input.year, input.cost_center_id])?;
        let now = now_iso();
        let mut total = 0_i64;
        for row in &input.accounts {
            let kind: Option<String> = tx.query_row("SELECT account_type FROM accounts WHERE id=?", [&row.account_id], |r| r.get(0)).optional()?;
            if !matches!(kind.as_deref(), Some("revenue" | "expense")) {
                return Err(invalid("Le budget porte sur des comptes de produits et de charges."));
            }
            for (index, amount) in row.months.iter().enumerate().filter(|(_, amount)| **amount > 0) {
                tx.execute(
                    "INSERT INTO budget_lines(year,month,account_id,cost_center_id,amount_cents,updated_at) VALUES(?,?,?,?,?,?)",
                    params![input.year, index as i64 + 1, row.account_id, input.cost_center_id, amount, now],
                )?;
                total += amount;
            }
        }
        append_audit(&tx, "save", "budget_lines", &format!("{}:{}", input.year, input.cost_center_id), &json!({ "accounts": input.accounts.len(), "total_cents": total }))?;
        tx.commit()?;
        Ok(json!({ "totalCents": total }))
    }

    /// Budget de l'année et réel par mois, compte et centre (contre-valeur CHF uniquement).
    pub fn get_budget_report(&self, year: i64) -> AppResult<Value> {
        if !(2000..=2100).contains(&year) {
            return Err(invalid("Année invalide."));
        }
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let from = format!("{year}-01-01");
        let to = format!("{year}-12-31");
        let budget = query_all(&connection, "SELECT month,account_id,cost_center_id,amount_cents FROM budget_lines WHERE year=? ORDER BY account_id,cost_center_id,month", [year])?;
        let actual = query_all(
            &connection,
            &format!(
                "SELECT CAST(strftime('%m',je.entry_date) AS INTEGER) AS month,jl.account_id,{RESOLVED_CENTER} AS cost_center_id,
                        SUM(jl.debit_cents) AS debit_cents,SUM(jl.credit_cents) AS credit_cents
                   FROM journal_lines_chf jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN accounts a ON a.id=jl.account_id
                   {CENTER_JOINS}
                  WHERE je.entry_date BETWEEN ? AND ? AND a.account_type IN('revenue','expense') AND jl.currency='CHF'
                  GROUP BY 1,2,3 ORDER BY 2,3,1"
            ),
            params![from, to],
        )?;
        let waiting: i64 = connection.query_row(
            "SELECT COUNT(DISTINCT je.id) FROM journal_lines_chf jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE je.entry_date BETWEEN ? AND ? AND jl.currency<>'CHF'",
            params![from, to],
            |row| row.get(0),
        )?;
        Ok(json!({ "year": year, "budget": budget, "actual": actual, "entriesWaitingForRate": waiting }))
    }
}

#[tauri::command]
pub fn list_cost_centers(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_cost_centers().map_err(command_error)
}

#[tauri::command]
pub fn save_cost_center(state: tauri::State<'_, LocalStore>, input: CostCenterInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_cost_center(input).map_err(command_error)
}

#[tauri::command]
pub fn assign_cost_center(state: tauri::State<'_, LocalStore>, kind: String, target_id: String, cost_center_id: Option<String>) -> Result<(), String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.assign_cost_center(&kind, &target_id, cost_center_id.as_deref()).map_err(command_error)
}

#[tauri::command]
pub fn save_budget(state: tauri::State<'_, LocalStore>, input: BudgetInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_budget(input).map_err(command_error)
}

#[tauri::command]
pub fn get_budget_report(state: tauri::State<'_, LocalStore>, year: i64) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_budget_report(year).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(account: &str, debit: i64, credit: i64, project: Option<&str>) -> crate::accounting::EntryLine {
        crate::accounting::EntryLine { account_id: account.into(), debit_cents: debit, credit_cents: credit, currency: "CHF".into(), memo: None, project_id: project.map(Into::into), client_id: None, employee_id: None }
    }

    #[test]
    fn actuals_follow_the_project_then_the_account() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "cost-centers-test").unwrap();
        let a = crate::tests::enable_accounting(&store);
        let workshop = store.save_cost_center(CostCenterInput { id: None, code: "atelier".into(), name: "Atelier".into(), archived: false }).unwrap()["id"].as_str().unwrap().to_owned();
        let office = store.save_cost_center(CostCenterInput { id: None, code: "ADMIN".into(), name: "Administration".into(), archived: false }).unwrap()["id"].as_str().unwrap().to_owned();
        assert!(store.save_cost_center(CostCenterInput { id: None, code: "ATELIER".into(), name: "Doublon".into(), archived: false }).is_err());
        assert!(store.save_cost_center(CostCenterInput { id: None, code: "a b".into(), name: "Espace".into(), archived: false }).is_err());
        let project = store.create_record("projects", json!({"name": "Chantier Morel"})).unwrap()["id"].as_str().unwrap().to_owned();
        store.assign_cost_center("project", &project, Some(&workshop)).unwrap();
        store.assign_cost_center("account", &a["expense"], Some(&office)).unwrap();
        assert!(store.assign_cost_center("project", "missing", Some(&workshop)).is_err());
        {
            let mut connection = store.connect().unwrap();
            let tx = connection.transaction().unwrap();
            crate::accounting::post_entry(&tx, "2026-03-10", "Matériel chantier", "manual", "m-1", "posted", vec![line(&a["expense"], 40_000, 0, Some(&project)), line(&a["bank"], 0, 40_000, None)]).unwrap();
            crate::accounting::post_entry(&tx, "2026-03-12", "Fournitures bureau", "manual", "m-2", "posted", vec![line(&a["expense"], 5_000, 0, None), line(&a["bank"], 0, 5_000, None)]).unwrap();
            tx.commit().unwrap();
        }
        store.save_budget(BudgetInput { year: 2026, cost_center_id: workshop.clone(), accounts: vec![BudgetAccountInput { account_id: a["expense"].clone(), months: vec![30_000; 12] }] }).unwrap();
        assert!(store.save_budget(BudgetInput { year: 2026, cost_center_id: String::new(), accounts: vec![BudgetAccountInput { account_id: a["bank"].clone(), months: vec![1; 12] }] }).is_err());
        let report = store.get_budget_report(2026).unwrap();
        let actual = report["actual"].as_array().unwrap();
        let by_center = |center: &str| actual.iter().filter(|row| row["cost_center_id"] == center).map(|row| row["debit_cents"].as_i64().unwrap()).sum::<i64>();
        assert_eq!(by_center(&workshop), 40_000);
        assert_eq!(by_center(&office), 5_000);
        assert_eq!(report["budget"].as_array().unwrap().len(), 12);
        // Le budget est remplacé, pas additionné.
        store.save_budget(BudgetInput { year: 2026, cost_center_id: workshop.clone(), accounts: vec![BudgetAccountInput { account_id: a["expense"].clone(), months: vec![0, 0, 50_000, 0, 0, 0, 0, 0, 0, 0, 0, 0] }] }).unwrap();
        assert_eq!(store.get_budget_report(2026).unwrap()["budget"].as_array().unwrap().len(), 1);
        store.assign_cost_center("account", &a["expense"], None).unwrap();
        let report = store.get_budget_report(2026).unwrap();
        assert!(report["actual"].as_array().unwrap().iter().any(|row| row["cost_center_id"] == "" && row["debit_cents"] == 5_000));
    }
}
