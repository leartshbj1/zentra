//! Nomenclatures et production simple : fabriquer N produits finis sort les
//! composants suivis en stock et entre le produit fini, avec les mouvements
//! de stock ordinaires et dans une seule transaction. Les besoins se calculent
//! au millième, arrondis vers le haut pour ne jamais sous-consommer.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
    stock::{record_manual_stock_movement_in, ManualMovement, ManualMovementType},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BomLineInput {
    pub component_item_id: String,
    pub quantity_milli: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BomInput {
    pub catalog_item_id: String,
    pub output_quantity_milli: i64,
    pub notes: String,
    pub lines: Vec<BomLineInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionInput {
    pub catalog_item_id: String,
    pub quantity_milli: i64,
    pub production_date: String,
    pub reference: String,
}

/// Besoin d'un composant pour `quantity` produits : ligne × quantité ÷ lot, arrondi au millième supérieur.
pub(crate) fn component_need(line_milli: i64, quantity_milli: i64, output_milli: i64) -> i64 {
    let numerator = line_milli as i128 * quantity_milli as i128;
    let output = output_milli as i128;
    ((numerator + output - 1) / output) as i64
}

impl LocalStore {
    pub fn save_bom(&self, input: BomInput) -> AppResult<Value> {
        if !(1..=9_000_000_000_000).contains(&input.output_quantity_milli) || input.notes.chars().count() > 2_000 {
            return Err(invalid("Indiquez la quantité produite par la nomenclature."));
        }
        if input.lines.is_empty() || input.lines.len() > 500 || input.lines.iter().any(|line| !(1..=9_000_000_000_000).contains(&line.quantity_milli)) {
            return Err(invalid("Une nomenclature a au moins un composant, chacun avec une quantité positive."));
        }
        if input.lines.iter().any(|line| line.component_item_id == input.catalog_item_id) {
            return Err(invalid("Un produit ne peut pas être son propre composant."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let product: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM catalog_items WHERE id=? AND kind='product')", [&input.catalog_item_id], |row| row.get(0))?;
        if !product {
            return Err(invalid("La nomenclature décrit un produit du catalogue."));
        }
        for line in &input.lines {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM catalog_items WHERE id=?)", [&line.component_item_id], |row| row.get(0))?;
            if !exists {
                return Err(invalid("Un composant est introuvable dans le catalogue."));
            }
            // Pas de boucle : un composant ne contient pas, à son tour, le produit fini.
            let loops: bool = tx.query_row(
                "WITH RECURSIVE parts(item) AS (SELECT ? UNION SELECT l.component_item_id FROM parts JOIN bills_of_materials b ON b.catalog_item_id=parts.item JOIN bom_lines l ON l.bom_id=b.id)
                 SELECT EXISTS(SELECT 1 FROM parts WHERE item=?)",
                params![line.component_item_id, input.catalog_item_id],
                |row| row.get(0),
            )?;
            if loops {
                return Err(invalid("Ce composant contient déjà le produit fini : la nomenclature tournerait en boucle."));
            }
        }
        let now = now_iso();
        let existing: Option<String> = tx.query_row("SELECT id FROM bills_of_materials WHERE catalog_item_id=?", [&input.catalog_item_id], |row| row.get(0)).optional()?;
        let id = match existing {
            Some(id) => {
                tx.execute("UPDATE bills_of_materials SET output_quantity_milli=?,notes=?,updated_at=? WHERE id=?", params![input.output_quantity_milli, input.notes.trim(), now, id])?;
                tx.execute("DELETE FROM bom_lines WHERE bom_id=?", [&id])?;
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO bills_of_materials(id,catalog_item_id,output_quantity_milli,notes,updated_at) VALUES(?,?,?,?,?)",
                    params![id, input.catalog_item_id, input.output_quantity_milli, input.notes.trim(), now],
                )?;
                id
            }
        };
        for (position, line) in input.lines.iter().enumerate() {
            tx.execute(
                "INSERT INTO bom_lines(bom_id,position,component_item_id,quantity_milli) VALUES(?,?,?,?)",
                params![id, position as i64, line.component_item_id, line.quantity_milli],
            )?;
        }
        append_audit(&tx, "save", "bills_of_materials", &id, &json!({ "catalog_item_id": input.catalog_item_id, "lines": input.lines.len(), "output_quantity_milli": input.output_quantity_milli }))?;
        tx.commit()?;
        Ok(json!({ "id": id }))
    }

    /// Enregistre une production : sorties des composants suivis, entrée du produit fini.
    pub fn record_production(&self, input: ProductionInput) -> AppResult<Value> {
        if !(1..=9_000_000_000_000).contains(&input.quantity_milli) || input.reference.chars().count() > 200 {
            return Err(invalid("Indiquez une quantité à produire positive."));
        }
        crate::accounting::validate_date(&input.production_date, "production_date")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (bom_id, output, product_name, product_tracked): (String, i64, String, bool) = tx
            .query_row(
                "SELECT b.id,b.output_quantity_milli,i.name,i.track_stock=1 FROM bills_of_materials b JOIN catalog_items i ON i.id=b.catalog_item_id WHERE b.catalog_item_id=?",
                [&input.catalog_item_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
            .ok_or_else(|| invalid("Ce produit n’a pas encore de nomenclature."))?;
        let lines: Vec<(String, i64, String, bool, i64)> = {
            let mut statement = tx.prepare(
                "SELECT l.component_item_id,l.quantity_milli,i.name,i.track_stock=1 AND i.kind='product',
                        i.stock_quantity_milli-COALESCE((SELECT SUM(e.quantity_delta_milli) FROM stock_reservation_events e WHERE e.catalog_item_id=i.id),0)
                   FROM bom_lines l JOIN catalog_items i ON i.id=l.component_item_id WHERE l.bom_id=? ORDER BY l.position",
            )?;
            let rows = statement.query_map([&bom_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut missing = Vec::new();
        let mut components = Vec::new();
        for (component, per_batch, name, tracked, available) in &lines {
            let need = component_need(*per_batch, input.quantity_milli, output);
            if *tracked && need > *available {
                missing.push(format!("{name} (il manque {})", (need - available) as f64 / 1000.0));
            }
            components.push(json!({ "catalog_item_id": component, "name": name, "quantity_milli": need, "tracked": tracked }));
        }
        if !missing.is_empty() {
            return Err(invalid(format!("Stock insuffisant pour produire : {}.", missing.join(", "))));
        }
        let id = Uuid::new_v4().to_string();
        let reason = format!("Production {} × {product_name}", input.quantity_milli as f64 / 1000.0);
        let reference = if input.reference.trim().is_empty() { None } else { Some(input.reference.trim().to_owned()) };
        for component in &mut components {
            if component["tracked"] != true { continue; }
            let movement = record_manual_stock_movement_in(&tx, ManualMovement {
                request_id: Uuid::new_v4().to_string(),
                catalog_item_id: component["catalog_item_id"].as_str().unwrap_or_default().to_owned(),
                movement_type: ManualMovementType::Exit,
                quantity_delta_milli: -component["quantity_milli"].as_i64().unwrap_or_default(),
                reason: reason.clone(),
                reference: reference.clone(),
                requested_date: Some(input.production_date.clone()),
                expected_balance: None,
            })?;
            component["movement_id"] = movement["movement"]["id"].clone();
        }
        let output_movement = if product_tracked {
            let movement = record_manual_stock_movement_in(&tx, ManualMovement {
                request_id: Uuid::new_v4().to_string(),
                catalog_item_id: input.catalog_item_id.clone(),
                movement_type: ManualMovementType::Entry,
                quantity_delta_milli: input.quantity_milli,
                reason: reason.clone(),
                reference: reference.clone(),
                requested_date: Some(input.production_date.clone()),
                expected_balance: None,
            })?;
            movement["movement"]["id"].as_str().map(str::to_owned)
        } else {
            None
        };
        tx.execute(
            "INSERT INTO production_orders(id,catalog_item_id,quantity_milli,production_date,reference,components_json,output_movement_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
            params![id, input.catalog_item_id, input.quantity_milli, input.production_date, input.reference.trim(), serde_json::to_string(&components)?, output_movement, now_iso()],
        )?;
        append_audit(&tx, "produce", "production_orders", &id, &json!({ "catalog_item_id": input.catalog_item_id, "quantity_milli": input.quantity_milli, "components": components }))?;
        tx.commit()?;
        Ok(json!({ "id": id }))
    }
}

#[tauri::command]
pub fn save_bom(state: tauri::State<'_, LocalStore>, input: BomInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_bom(input).map_err(command_error)
}

#[tauri::command]
pub fn record_production(state: tauri::State<'_, LocalStore>, input: ProductionInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.record_production(input).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_round_up_to_the_thousandth() {
        assert_eq!(component_need(4_000, 3_000, 1_000), 12_000);
        assert_eq!(component_need(1_000, 1_000, 3_000), 334);
        assert_eq!(component_need(2_500, 2_000, 4_000), 1_250);
    }

    #[test]
    fn production_moves_components_and_product_together() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "production-test").unwrap();
        let product = |name: &str, tracked: bool| store.create_record("catalog_items", json!({"kind": "product", "name": name, "unit": "pce", "sales_price_cents": 1_000, "vat_bp": 0, "track_stock": tracked})).unwrap()["id"].as_str().unwrap().to_owned();
        let table = product("Table en chêne", true);
        let top = product("Plateau chêne", true);
        let leg = product("Pied", true);
        let screw = product("Vis inox", false);
        let entry = |item: &str, quantity_milli: i64| store.record_stock_entry(crate::models::StockEntryInput { request_id: Uuid::new_v4().to_string(), catalog_item_id: item.into(), quantity_milli, reason: "Réception".into(), reference: None, date: Some("2026-10-01".into()) }).unwrap();
        entry(&top, 3_000);
        entry(&leg, 10_000);
        let bom = |lines: Vec<(&str, i64)>| BomInput { catalog_item_id: table.clone(), output_quantity_milli: 1_000, notes: String::new(), lines: lines.into_iter().map(|(component, quantity_milli)| BomLineInput { component_item_id: component.into(), quantity_milli }).collect() };
        assert!(store.save_bom(bom(vec![(&table, 1_000)])).is_err());
        store.save_bom(bom(vec![(&top, 1_000), (&leg, 4_000), (&screw, 16_000)])).unwrap();
        let produce = |quantity_milli: i64| store.record_production(ProductionInput { catalog_item_id: table.clone(), quantity_milli, production_date: "2026-10-05".into(), reference: "OF-1".into() });
        let error = produce(3_000).unwrap_err().to_string();
        assert!(error.contains("Pied"), "{error}");
        produce(2_000).unwrap();
        let stock = |item: &str| -> i64 { store.connect().unwrap().query_row("SELECT stock_quantity_milli FROM catalog_items WHERE id=?", [item], |row| row.get(0)).unwrap() };
        assert_eq!((stock(&table), stock(&top), stock(&leg)), (2_000, 1_000, 2_000));
        // Le plateau manque désormais : rien n'est sorti ni entré.
        assert!(produce(2_000).is_err());
        assert_eq!((stock(&table), stock(&top), stock(&leg)), (2_000, 1_000, 2_000));
        // Un composant qui contient le produit fini ferait une boucle.
        assert!(store.save_bom(BomInput { catalog_item_id: top.clone(), output_quantity_milli: 1_000, notes: String::new(), lines: vec![BomLineInput { component_item_id: table.clone(), quantity_milli: 1_000 }] }).is_err());
    }
}
