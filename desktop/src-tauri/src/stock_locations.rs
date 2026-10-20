//! Dépôts, transferts et traçabilité par lot ou numéro de série. La quantité
//! totale reste celle des mouvements de stock ; ce module la répartit entre
//! dépôts et en suit les lots, sans jamais réécrire un mouvement existant.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
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
pub struct WarehouseInput {
    pub id: Option<String>,
    pub code: String,
    pub name: String,
    pub is_default: bool,
    pub archived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferInput {
    pub catalog_item_id: String,
    pub from_warehouse_id: String,
    pub to_warehouse_id: String,
    pub quantity_milli: i64,
    pub transfer_date: String,
    pub note: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LotMovementInput {
    pub catalog_item_id: String,
    pub codes: Vec<String>,
    /// Positif : entrée ; négatif : sortie. Pour un numéro de série, ±1000 par code.
    pub quantity_milli: i64,
    pub movement_date: String,
    pub expiry_date: Option<String>,
    pub warehouse_id: Option<String>,
    pub source_type: String,
    pub source_id: Option<String>,
    pub reference: String,
}

fn default_warehouse(connection: &Connection) -> AppResult<Option<String>> {
    Ok(connection.query_row("SELECT id FROM warehouses WHERE is_default=1", [], |row| row.get(0)).optional()?)
}

/// Stock d'un article dans un dépôt : mouvements placés (le dépôt principal reçoit les autres) et transferts.
pub(crate) fn warehouse_balance(connection: &Connection, catalog_item_id: &str, warehouse_id: &str) -> AppResult<i64> {
    let default = default_warehouse(connection)?.unwrap_or_default();
    let moved: i64 = connection.query_row(
        "SELECT COALESCE(SUM(m.quantity_delta_milli),0) FROM stock_movements m LEFT JOIN stock_movement_warehouses w ON w.stock_movement_id=m.id
          WHERE m.catalog_item_id=? AND COALESCE(w.warehouse_id,?)=?",
        params![catalog_item_id, default, warehouse_id],
        |row| row.get(0),
    )?;
    let transferred: i64 = connection.query_row(
        "SELECT COALESCE(SUM(CASE WHEN to_warehouse_id=?2 THEN quantity_milli ELSE -quantity_milli END),0) FROM stock_transfers
          WHERE catalog_item_id=?1 AND (to_warehouse_id=?2 OR from_warehouse_id=?2)",
        params![catalog_item_id, warehouse_id],
        |row| row.get(0),
    )?;
    Ok(moved + transferred)
}

fn lot_balance(connection: &Connection, lot_id: &str) -> AppResult<i64> {
    Ok(connection.query_row("SELECT COALESCE(SUM(quantity_milli),0) FROM stock_lot_movements WHERE lot_id=?", [lot_id], |row| row.get(0))?)
}

impl LocalStore {
    pub fn save_warehouse(&self, input: WarehouseInput) -> AppResult<Value> {
        let code = input.code.trim().to_uppercase();
        let name = input.name.trim().to_owned();
        if code.is_empty() || code.chars().count() > 12 || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(invalid("Le code du dépôt : 1 à 12 lettres ou chiffres (par exemple ATELIER)."));
        }
        if name.is_empty() || name.chars().count() > 80 {
            return Err(invalid("Donnez un nom au dépôt (80 caractères au plus)."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        let taken: Option<String> = tx.query_row("SELECT id FROM warehouses WHERE code=?", [&code], |row| row.get(0)).optional()?;
        // Le premier dépôt devient le dépôt principal ; il le reste tant qu'un autre ne le remplace pas.
        let first = !tx.query_row("SELECT EXISTS(SELECT 1 FROM warehouses)", [], |row| row.get::<_, bool>(0))?;
        let make_default = (input.is_default || first) && !input.archived;
        let id = match input.id {
            Some(id) => {
                if taken.as_deref().is_some_and(|other| other != id) {
                    return Err(invalid("Ce code est déjà utilisé par un autre dépôt."));
                }
                let was_default: Option<bool> = tx.query_row("SELECT is_default=1 FROM warehouses WHERE id=?", [&id], |row| row.get(0)).optional()?;
                let Some(was_default) = was_default else { return Err(invalid("Dépôt introuvable.")) };
                if was_default && (input.archived || !input.is_default) {
                    return Err(invalid("Choisissez d’abord un autre dépôt principal."));
                }
                if input.archived {
                    let item_ids: Vec<String> = {
                        let mut statement = tx.prepare("SELECT id FROM catalog_items")?;
                        let rows = statement.query_map([], |row| row.get(0))?;
                        rows.collect::<Result<_, _>>()?
                    };
                    for item in item_ids {
                        if warehouse_balance(&tx, &item, &id)? != 0 {
                            return Err(invalid("Ce dépôt contient encore du stock : transférez-le avant de l’archiver."));
                        }
                    }
                }
                if make_default { tx.execute("UPDATE warehouses SET is_default=0,updated_at=? WHERE is_default=1 AND id<>?", params![now, id])?; }
                tx.execute(
                    "UPDATE warehouses SET code=?,name=?,is_default=?,archived_at=CASE WHEN ? THEN COALESCE(archived_at,?) ELSE NULL END,updated_at=? WHERE id=?",
                    params![code, name, make_default || was_default, input.archived, now, now, id],
                )?;
                id
            }
            None => {
                if taken.is_some() {
                    return Err(invalid("Ce code est déjà utilisé par un autre dépôt."));
                }
                if make_default { tx.execute("UPDATE warehouses SET is_default=0,updated_at=? WHERE is_default=1", [&now])?; }
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO warehouses(id,code,name,is_default,archived_at,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)",
                    params![id, code, name, make_default, now, now],
                )?;
                id
            }
        };
        append_audit(&tx, "save", "warehouses", &id, &json!({ "code": code, "name": name, "is_default": make_default, "archived": input.archived }))?;
        tx.commit()?;
        Ok(json!({ "id": id }))
    }

    /// Place un mouvement de stock dans un dépôt (par défaut, il est au dépôt principal).
    pub fn assign_movement_warehouse(&self, movement_id: &str, warehouse_id: &str) -> AppResult<()> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM warehouses WHERE id=? AND archived_at IS NULL)", [warehouse_id], |row| row.get(0))?;
        let movement: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM stock_movements WHERE id=?)", [movement_id], |row| row.get(0))?;
        if !active || !movement {
            return Err(invalid("Mouvement ou dépôt introuvable."));
        }
        tx.execute(
            "INSERT INTO stock_movement_warehouses(stock_movement_id,warehouse_id,updated_at) VALUES(?,?,?)
             ON CONFLICT(stock_movement_id) DO UPDATE SET warehouse_id=excluded.warehouse_id,updated_at=excluded.updated_at",
            params![movement_id, warehouse_id, now_iso()],
        )?;
        append_audit(&tx, "assign", "stock_movement_warehouses", movement_id, &json!({ "warehouse_id": warehouse_id }))?;
        tx.commit()?;
        Ok(())
    }

    pub fn transfer_stock(&self, input: TransferInput) -> AppResult<Value> {
        if input.quantity_milli <= 0 || input.from_warehouse_id == input.to_warehouse_id || input.note.chars().count() > 500 {
            return Err(invalid("Indiquez une quantité positive et deux dépôts différents."));
        }
        crate::accounting::validate_date(&input.transfer_date, "transfer_date")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for warehouse in [&input.from_warehouse_id, &input.to_warehouse_id] {
            let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM warehouses WHERE id=? AND archived_at IS NULL)", [warehouse], |row| row.get(0))?;
            if !active {
                return Err(invalid("Choisissez deux dépôts actifs."));
            }
        }
        let available = warehouse_balance(&tx, &input.catalog_item_id, &input.from_warehouse_id)?;
        if available < input.quantity_milli {
            return Err(invalid(format!("Le dépôt de départ n’a que {} en stock pour cet article.", available as f64 / 1000.0)));
        }
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO stock_transfers(id,catalog_item_id,from_warehouse_id,to_warehouse_id,quantity_milli,transfer_date,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
            params![id, input.catalog_item_id, input.from_warehouse_id, input.to_warehouse_id, input.quantity_milli, input.transfer_date, input.note.trim(), now_iso()],
        )?;
        append_audit(&tx, "transfer", "stock_transfers", &id, &json!({ "catalog_item_id": input.catalog_item_id, "from": input.from_warehouse_id, "to": input.to_warehouse_id, "quantity_milli": input.quantity_milli }))?;
        tx.commit()?;
        Ok(json!({ "id": id }))
    }

    pub fn set_item_tracking(&self, catalog_item_id: &str, mode: Option<&str>) -> AppResult<()> {
        if mode.is_some_and(|value| !matches!(value, "lot" | "serial")) {
            return Err(invalid("Suivi inconnu."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let product: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM catalog_items WHERE id=? AND kind='product')", [catalog_item_id], |row| row.get(0))?;
        if !product {
            return Err(invalid("Le suivi par lot ou numéro de série concerne les produits."));
        }
        let used: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM stock_lots WHERE catalog_item_id=?)", [catalog_item_id], |row| row.get(0))?;
        let current: Option<String> = tx.query_row("SELECT mode FROM catalog_item_tracking WHERE catalog_item_id=?", [catalog_item_id], |row| row.get(0)).optional()?;
        if used && current.as_deref() != mode {
            return Err(invalid("Des lots existent déjà pour cet article : son mode de suivi ne change plus."));
        }
        match mode {
            Some(mode) => tx.execute(
                "INSERT INTO catalog_item_tracking(catalog_item_id,mode,updated_at) VALUES(?,?,?) ON CONFLICT(catalog_item_id) DO UPDATE SET mode=excluded.mode,updated_at=excluded.updated_at",
                params![catalog_item_id, mode, now_iso()],
            )?,
            None => tx.execute("DELETE FROM catalog_item_tracking WHERE catalog_item_id=?", [catalog_item_id])?,
        };
        append_audit(&tx, "tracking", "catalog_item_tracking", catalog_item_id, &json!({ "mode": mode }))?;
        tx.commit()?;
        Ok(())
    }

    /// Entrée ou sortie de lots ou de numéros de série, avec la pièce qui la justifie.
    pub fn record_lot_movement(&self, input: LotMovementInput) -> AppResult<Value> {
        crate::accounting::validate_date(&input.movement_date, "movement_date")?;
        if let Some(expiry) = input.expiry_date.as_deref() { crate::accounting::validate_date(expiry, "expiry_date")?; }
        if !matches!(input.source_type.as_str(), "entry" | "exit" | "receipt" | "delivery") || input.reference.chars().count() > 200 {
            return Err(invalid("Origine du mouvement inconnue."));
        }
        let codes: Vec<String> = input.codes.iter().map(|code| code.trim().to_owned()).filter(|code| !code.is_empty()).collect();
        if codes.is_empty() || codes.len() > 500 || codes.iter().any(|code| code.chars().count() > 80) {
            return Err(invalid("Indiquez au moins un numéro de lot ou de série (80 caractères au plus)."));
        }
        if codes.iter().collect::<std::collections::BTreeSet<_>>().len() != codes.len() {
            return Err(invalid("Un même numéro apparaît deux fois."));
        }
        if input.quantity_milli == 0 {
            return Err(invalid("La quantité ne peut pas être nulle."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mode: String = tx
            .query_row("SELECT mode FROM catalog_item_tracking WHERE catalog_item_id=?", [&input.catalog_item_id], |row| row.get(0))
            .optional()?
            .ok_or_else(|| invalid("Activez d’abord le suivi par lot ou numéro de série pour cet article."))?;
        if mode == "serial" && input.quantity_milli.abs() != 1_000 {
            return Err(invalid("Un numéro de série correspond à une seule pièce."));
        }
        if mode == "lot" && codes.len() != 1 {
            return Err(invalid("Enregistrez un lot à la fois."));
        }
        if let Some(warehouse) = input.warehouse_id.as_deref() {
            let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM warehouses WHERE id=? AND archived_at IS NULL)", [warehouse], |row| row.get(0))?;
            if !active { return Err(invalid("Dépôt introuvable.")); }
        }
        let now = now_iso();
        for code in &codes {
            let existing: Option<String> = tx.query_row("SELECT id FROM stock_lots WHERE catalog_item_id=? AND code=?", params![input.catalog_item_id, code], |row| row.get(0)).optional()?;
            let lot_id = match existing {
                Some(id) => id,
                None if input.quantity_milli > 0 => {
                    let id = Uuid::new_v4().to_string();
                    tx.execute(
                        "INSERT INTO stock_lots(id,catalog_item_id,mode,code,expiry_date,warehouse_id,created_at) VALUES(?,?,?,?,?,?,?)",
                        params![id, input.catalog_item_id, mode, code, input.expiry_date, input.warehouse_id, now],
                    )?;
                    id
                }
                None => return Err(invalid(format!("Le numéro {code} n’est pas en stock."))),
            };
            let balance = lot_balance(&tx, &lot_id)?;
            if balance + input.quantity_milli < 0 {
                return Err(invalid(format!("Le numéro {code} n’a que {} en stock.", balance as f64 / 1000.0)));
            }
            if mode == "serial" && balance + input.quantity_milli > 1_000 {
                return Err(invalid(format!("Le numéro de série {code} est déjà en stock.")));
            }
            tx.execute(
                "INSERT INTO stock_lot_movements(id,lot_id,quantity_milli,movement_date,source_type,source_id,reference,created_at) VALUES(?,?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(), lot_id, input.quantity_milli, input.movement_date, input.source_type, input.source_id, input.reference.trim(), now],
            )?;
        }
        append_audit(&tx, "lot_movement", "stock_lot_movements", &input.catalog_item_id, &json!({ "codes": codes, "quantity_milli": input.quantity_milli, "source_type": input.source_type, "source_id": input.source_id }))?;
        tx.commit()?;
        Ok(json!({ "count": codes.len() }))
    }
}

#[tauri::command]
pub fn save_warehouse(state: tauri::State<'_, LocalStore>, input: WarehouseInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_warehouse(input).map_err(command_error)
}

#[tauri::command]
pub fn assign_movement_warehouse(state: tauri::State<'_, LocalStore>, movement_id: String, warehouse_id: String) -> Result<(), String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.assign_movement_warehouse(&movement_id, &warehouse_id).map_err(command_error)
}

#[tauri::command]
pub fn transfer_stock(state: tauri::State<'_, LocalStore>, input: TransferInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.transfer_stock(input).map_err(command_error)
}

#[tauri::command]
pub fn set_item_tracking(state: tauri::State<'_, LocalStore>, catalog_item_id: String, mode: Option<String>) -> Result<(), String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.set_item_tracking(&catalog_item_id, mode.as_deref()).map_err(command_error)
}

#[tauri::command]
pub fn record_lot_movement(state: tauri::State<'_, LocalStore>, input: LotMovementInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.record_lot_movement(input).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warehouse(store: &LocalStore, code: &str, is_default: bool) -> String {
        store.save_warehouse(WarehouseInput { id: None, code: code.into(), name: code.into(), is_default, archived: false }).unwrap()["id"].as_str().unwrap().to_owned()
    }

    #[test]
    fn transfers_move_stock_between_warehouses_and_lots_are_traced() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "stock-locations-test").unwrap();
        let item = store.create_record("catalog_items", json!({"kind": "product", "name": "Robinet thermostatique", "unit": "pce", "sales_price_cents": 18_000, "vat_bp": 0, "track_stock": true})).unwrap()["id"].as_str().unwrap().to_owned();
        let main = warehouse(&store, "ATELIER", false);
        let van = warehouse(&store, "VAN-1", false);
        {
            let connection = store.connect().unwrap();
            assert_eq!(default_warehouse(&connection).unwrap().as_deref(), Some(main.as_str()));
            connection.execute(
                "INSERT INTO stock_movements(id,source_key,catalog_item_id,movement_type,quantity_delta_milli,balance_after_milli,reason,movement_date,source_type,created_at) VALUES('m1','test:m1',?,'correction',10000,10000,'Stock initial','2026-10-01','opening','2026-10-01T08:00:00Z')",
                [&item],
            ).unwrap();
        }
        let transfer = |quantity_milli: i64| store.transfer_stock(TransferInput { catalog_item_id: item.clone(), from_warehouse_id: main.clone(), to_warehouse_id: van.clone(), quantity_milli, transfer_date: "2026-10-02".into(), note: String::new() });
        assert!(transfer(12_000).is_err());
        transfer(4_000).unwrap();
        let connection = store.connect().unwrap();
        assert_eq!(warehouse_balance(&connection, &item, &main).unwrap(), 6_000);
        assert_eq!(warehouse_balance(&connection, &item, &van).unwrap(), 4_000);
        drop(connection);
        // Un dépôt avec du stock ne s'archive pas ; le principal non plus.
        assert!(store.save_warehouse(WarehouseInput { id: Some(van.clone()), code: "VAN-1".into(), name: "VAN-1".into(), is_default: false, archived: true }).is_err());
        assert!(store.save_warehouse(WarehouseInput { id: Some(main.clone()), code: "ATELIER".into(), name: "Atelier".into(), is_default: false, archived: false }).is_err());

        let lot = |codes: Vec<&str>, quantity_milli: i64, source_type: &str| store.record_lot_movement(LotMovementInput { catalog_item_id: item.clone(), codes: codes.into_iter().map(Into::into).collect(), quantity_milli,
            movement_date: "2026-10-03".into(), expiry_date: None, warehouse_id: None, source_type: source_type.into(), source_id: None, reference: "BL-2026-0007".into() });
        assert!(lot(vec!["SN-1"], 1_000, "entry").is_err());
        store.set_item_tracking(&item, Some("serial")).unwrap();
        lot(vec!["SN-1", "SN-2"], 1_000, "receipt").unwrap();
        assert!(lot(vec!["SN-1"], 1_000, "entry").is_err());
        assert!(lot(vec!["SN-3"], -1_000, "delivery").is_err());
        assert!(lot(vec!["SN-1"], 2_000, "entry").is_err());
        lot(vec!["SN-1"], -1_000, "delivery").unwrap();
        assert!(lot(vec!["SN-1"], -1_000, "delivery").is_err());
        assert!(store.set_item_tracking(&item, Some("lot")).is_err());
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["stock_lot_movements"].as_array().unwrap().len(), 3);
        assert_eq!(workspace["stock_transfers"].as_array().unwrap().len(), 1);
    }
}
