//! Kits de prestations : une prestation du catalogue (« Pose d'une prise
//! T13 ») composée de matériel et de main-d'œuvre. Le prix et le coût du kit
//! sont la somme de ses lignes, calculée ici à l'enregistrement ; le devis
//! reprend ensuite le kit comme n'importe quel article.

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceKitLineInput {
    pub kind: String,
    #[serde(default)]
    pub component_item_id: Option<String>,
    pub description: String,
    pub quantity_milli: i64,
    pub unit_price_cents: i64,
    #[serde(default)]
    pub unit_cost_cents: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceKitInput {
    pub catalog_item_id: String,
    #[serde(default)]
    pub notes: Option<String>,
    pub lines: Vec<ServiceKitLineInput>,
}

/// Montant d'une ligne : quantité (millièmes) × prix unitaire, au centime.
pub fn line_amount(quantity_milli: i64, unit_cents: i64) -> i64 {
    ((i128::from(quantity_milli) * i128::from(unit_cents) + 500) / 1_000) as i64
}

/// Prix et coût du kit à partir de ses lignes.
pub fn kit_totals(lines: &[ServiceKitLineInput]) -> (i64, i64) {
    lines.iter().fold((0, 0), |(price, cost), line| {
        (price + line_amount(line.quantity_milli, line.unit_price_cents), cost + line_amount(line.quantity_milli, line.unit_cost_cents))
    })
}

impl LocalStore {
    /// Enregistre les lignes du kit et met à jour le prix et le coût de la prestation.
    pub fn save_service_kit(&self, input: ServiceKitInput) -> AppResult<Value> {
        if input.lines.is_empty() || input.lines.len() > 100 {
            return Err(invalid("Un kit contient entre 1 et 100 lignes."));
        }
        let notes = input.notes.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
        if notes.as_ref().is_some_and(|text| text.chars().count() > 2_000) {
            return Err(invalid("La remarque du kit est trop longue."));
        }
        for line in &input.lines {
            let description = line.description.trim();
            if !matches!(line.kind.as_str(), "material" | "labor")
                || description.is_empty()
                || description.chars().count() > 200
                || !(1..=1_000_000_000).contains(&line.quantity_milli)
                || !(0..=100_000_000).contains(&line.unit_price_cents)
                || !(0..=100_000_000).contains(&line.unit_cost_cents)
            {
                return Err(invalid("Vérifiez chaque ligne du kit : nature, désignation, quantité et prix positifs."));
            }
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let kind: Option<String> = tx
            .query_row("SELECT kind FROM catalog_items WHERE id=?", [&input.catalog_item_id], |row| row.get(0))
            .optional()?;
        match kind.as_deref() {
            Some("service") => {}
            Some(_) => return Err(invalid("Un kit est une prestation : choisissez un service du catalogue.")),
            None => return Err(invalid("Prestation introuvable.")),
        }
        for line in &input.lines {
            if let Some(component) = line.component_item_id.as_deref().filter(|id| !id.is_empty()) {
                if component == input.catalog_item_id {
                    return Err(invalid("Un kit ne peut pas se contenir lui-même."));
                }
                let (exists, nested): (bool, bool) = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM catalog_items WHERE id=?1), EXISTS(SELECT 1 FROM service_kits WHERE catalog_item_id=?1)",
                    [component],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                if !exists {
                    return Err(invalid("Un article du kit est introuvable dans le catalogue."));
                }
                if nested {
                    return Err(invalid("Un kit ne peut pas contenir un autre kit."));
                }
            }
        }
        let now = now_iso();
        tx.execute(
            "INSERT INTO service_kits(catalog_item_id,notes,created_at,updated_at) VALUES(?,?,?,?)
             ON CONFLICT(catalog_item_id) DO UPDATE SET notes=excluded.notes,updated_at=excluded.updated_at",
            params![input.catalog_item_id, notes, now, now],
        )?;
        tx.execute("DELETE FROM service_kit_lines WHERE kit_item_id=?", [&input.catalog_item_id])?;
        for (position, line) in input.lines.iter().enumerate() {
            tx.execute(
                "INSERT INTO service_kit_lines(id,kit_item_id,position,kind,component_item_id,description,quantity_milli,unit_price_cents,unit_cost_cents) VALUES(?,?,?,?,?,?,?,?,?)",
                params![
                    Uuid::new_v4().to_string(),
                    input.catalog_item_id,
                    position as i64,
                    line.kind,
                    line.component_item_id.as_deref().filter(|id| !id.is_empty()),
                    line.description.trim(),
                    line.quantity_milli,
                    line.unit_price_cents,
                    line.unit_cost_cents
                ],
            )?;
        }
        let (price, cost) = kit_totals(&input.lines);
        tx.execute(
            "UPDATE catalog_items SET sales_price_cents=?,purchase_cost_cents=?,updated_at=? WHERE id=?",
            params![price, cost, now, input.catalog_item_id],
        )?;
        append_audit(&tx, "save", "service_kits", &input.catalog_item_id, &json!({ "lines": input.lines.len(), "sales_price_cents": price, "purchase_cost_cents": cost }))?;
        tx.commit()?;
        Ok(json!({ "salesPriceCents": price, "purchaseCostCents": cost }))
    }

    /// Retire le kit ; la prestation reste au catalogue avec son dernier prix.
    pub fn delete_service_kit(&self, catalog_item_id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let removed = tx.execute("DELETE FROM service_kits WHERE catalog_item_id=?", [catalog_item_id])?;
        if removed == 0 {
            return Err(invalid("Kit introuvable."));
        }
        append_audit(&tx, "delete", "service_kits", catalog_item_id, &json!({}))?;
        tx.commit()?;
        Ok(json!({ "removed": true }))
    }
}

#[tauri::command]
pub fn save_service_kit(state: tauri::State<'_, LocalStore>, input: ServiceKitInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_service_kit(input).map_err(command_error)
}

#[tauri::command]
pub fn delete_service_kit(state: tauri::State<'_, LocalStore>, catalog_item_id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.delete_service_kit(&catalog_item_id).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog_import::{CatalogImportConflictPolicy, CatalogImportRowInput, ImportCatalogItemsInput};

    fn line(kind: &str, component: Option<String>, description: &str, quantity_milli: i64, price: i64, cost: i64) -> ServiceKitLineInput {
        ServiceKitLineInput { kind: kind.into(), component_item_id: component, description: description.into(), quantity_milli, unit_price_cents: price, unit_cost_cents: cost }
    }

    #[test]
    fn a_kit_prices_materials_and_labour_and_trade_imports_keep_their_ean() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "service-kit-test").unwrap();
        let row = |row_number: usize, sku: &str, name: &str, sale: i64, cost: i64, ean: Option<&str>| CatalogImportRowInput {
            row_number, sku: sku.into(), name: name.into(), description: String::new(), unit: "pièce".into(), purchase_cost_cents: cost, sales_price_cents: sale, vat_bp: 810,
            kind: "product".into(), ean: ean.map(Into::into), trade_source: Some("datanorm".into()),
        };
        store.import_catalog_items(ImportCatalogItemsInput { conflict_policy: CatalogImportConflictPolicy::Update, rows: vec![
            row(2, "EL-2040", "Prise T13", 1_250, 875, Some("7610000000024")),
            row(3, "EL-2050", "Boîte d'encastrement", 320, 180, None),
        ] }).unwrap();
        assert!(store.import_catalog_items(ImportCatalogItemsInput { conflict_policy: CatalogImportConflictPolicy::Update, rows: vec![row(2, "EL-9", "Faux", 1, 1, Some("12AB"))] }).is_err());
        let connection = store.connect().unwrap();
        let (socket, ean, source): (String, String, String) = connection.query_row("SELECT id,ean,trade_source FROM catalog_items WHERE sku='EL-2040'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((ean.as_str(), source.as_str()), ("7610000000024", "datanorm"));
        let boxed: String = connection.query_row("SELECT id FROM catalog_items WHERE sku='EL-2050'", [], |r| r.get(0)).unwrap();
        drop(connection);

        let kit = store.create_record("catalog_items", json!({"name":"Pose d'une prise T13","kind":"service","unit":"pièce","sales_price_cents":0,"vat_bp":810})).unwrap()["id"].as_str().unwrap().to_owned();
        let saved = store.save_service_kit(ServiceKitInput { catalog_item_id: kit.clone(), notes: None, lines: vec![
            line("material", Some(socket.clone()), "Prise T13", 1_000, 1_250, 875),
            line("material", Some(boxed.clone()), "Boîte d'encastrement", 1_000, 320, 180),
            line("labor", None, "Électricien", 750, 9_600, 6_500),
        ] }).unwrap();
        // 12.50 + 3.20 + 0,75 h × 96.– = 87.70 ; coût 8.75 + 1.80 + 0,75 h × 65.– = 59.30
        assert_eq!(saved["salesPriceCents"], json!(1_250 + 320 + 7_200));
        assert_eq!(saved["purchaseCostCents"], json!(875 + 180 + 4_875));
        let connection = store.connect().unwrap();
        let price: i64 = connection.query_row("SELECT sales_price_cents FROM catalog_items WHERE id=?", [&kit], |r| r.get(0)).unwrap();
        assert_eq!(price, 8_770);
        drop(connection);
        assert!(store.save_service_kit(ServiceKitInput { catalog_item_id: socket.clone(), notes: None, lines: vec![line("labor", None, "x", 1_000, 1, 0)] }).is_err(), "un produit n'est pas un kit");
        assert!(store.save_service_kit(ServiceKitInput { catalog_item_id: kit.clone(), notes: None, lines: vec![line("material", Some(kit.clone()), "Soi-même", 1_000, 1, 0)] }).is_err());
        assert!(store.save_service_kit(ServiceKitInput { catalog_item_id: kit.clone(), notes: None, lines: vec![] }).is_err());
        store.delete_service_kit(&kit).unwrap();
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["service_kits"].as_array().unwrap().len(), 0);
        assert_eq!(line_amount(333, 100), 33);
        assert_eq!(line_amount(335, 100), 34);
    }
}
