//! Listes de prix par client : un rabais sur tout le catalogue et des prix
//! fixes par article. L'interface les applique quand elle ajoute un article
//! à un devis ou une facture ; le document garde ensuite ses propres prix.

use rusqlite::{params, TransactionBehavior};
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
pub struct PriceListItemInput {
    pub catalog_item_id: String,
    pub unit_price_cents: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriceListInput {
    pub id: Option<String>,
    pub name: String,
    pub discount_bp: i64,
    pub archived: bool,
    pub items: Vec<PriceListItemInput>,
    pub client_ids: Vec<String>,
}

impl LocalStore {
    /// Enregistre la liste, ses prix fixes et ses clients (remplacés en entier).
    pub fn save_price_list(&self, input: PriceListInput) -> AppResult<Value> {
        let name = input.name.trim().to_owned();
        if name.is_empty() || name.chars().count() > 80 {
            return Err(invalid("Donnez un nom à la liste de prix (80 caractères au plus)."));
        }
        if !(0..=10_000).contains(&input.discount_bp) {
            return Err(invalid("Le rabais est compris entre 0 et 100 %."));
        }
        if input.items.len() > 2_000 || input.client_ids.len() > 5_000 {
            return Err(invalid("La liste de prix est trop longue."));
        }
        let mut items = std::collections::BTreeSet::new();
        for item in &input.items {
            if !(0..=100_000_000_000).contains(&item.unit_price_cents) || !items.insert(item.catalog_item_id.as_str()) {
                return Err(invalid("Chaque article apparaît une fois, avec un prix positif."));
            }
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        let id = match input.id {
            Some(id) => {
                let changed = tx.execute(
                    "UPDATE price_lists SET name=?,discount_bp=?,archived_at=CASE WHEN ? THEN COALESCE(archived_at,?) ELSE NULL END,updated_at=? WHERE id=?",
                    params![name, input.discount_bp, input.archived, now, now, id],
                )?;
                if changed == 0 {
                    return Err(invalid("Liste de prix introuvable."));
                }
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO price_lists(id,name,discount_bp,archived_at,created_at,updated_at) VALUES(?,?,?,NULL,?,?)",
                    params![id, name, input.discount_bp, now, now],
                )?;
                id
            }
        };
        tx.execute("DELETE FROM price_list_items WHERE price_list_id=?", [&id])?;
        for item in &input.items {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM catalog_items WHERE id=?)", [&item.catalog_item_id], |row| row.get(0))?;
            if !exists {
                return Err(invalid("Un article de la liste est introuvable dans le catalogue."));
            }
            tx.execute(
                "INSERT INTO price_list_items(price_list_id,catalog_item_id,unit_price_cents) VALUES(?,?,?)",
                params![id, item.catalog_item_id, item.unit_price_cents],
            )?;
        }
        // Un client a une seule liste : la nouvelle attribution remplace l'ancienne.
        tx.execute("DELETE FROM client_price_lists WHERE price_list_id=?", [&id])?;
        if !input.archived {
            for client in &input.client_ids {
                let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM clients WHERE id=?)", [client], |row| row.get(0))?;
                if !exists {
                    return Err(invalid("Un client de la liste est introuvable."));
                }
                tx.execute(
                    "INSERT INTO client_price_lists(client_id,price_list_id,updated_at) VALUES(?,?,?)
                     ON CONFLICT(client_id) DO UPDATE SET price_list_id=excluded.price_list_id,updated_at=excluded.updated_at",
                    params![client, id, now],
                )?;
            }
        }
        append_audit(&tx, "save", "price_lists", &id, &json!({ "name": name, "discount_bp": input.discount_bp, "items": input.items.len(), "clients": input.client_ids.len(), "archived": input.archived }))?;
        tx.commit()?;
        Ok(json!({ "id": id }))
    }
}

#[tauri::command]
pub fn save_price_list(state: tauri::State<'_, LocalStore>, input: PriceListInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_price_list(input).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_has_one_list_with_its_fixed_prices() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "price-lists-test").unwrap();
        let client = store.create_record("clients", json!({"name": "Garage Dupont"})).unwrap()["id"].as_str().unwrap().to_owned();
        let item = store.create_record("catalog_items", json!({"name": "Pose carrelage", "kind": "service", "unit": "m²", "sales_price_cents": 8_000, "vat_bp": 0})).unwrap()["id"].as_str().unwrap().to_owned();
        let input = |id: Option<String>, discount_bp: i64, clients: Vec<String>| PriceListInput { id, name: "Revendeurs".into(), discount_bp, archived: false, items: vec![PriceListItemInput { catalog_item_id: item.clone(), unit_price_cents: 7_200 }], client_ids: clients };
        let first = store.save_price_list(input(None, 1_000, vec![client.clone()])).unwrap()["id"].as_str().unwrap().to_owned();
        let second = store.save_price_list(PriceListInput { name: "Partenaires".into(), ..input(None, 500, vec![client.clone()]) }).unwrap()["id"].as_str().unwrap().to_owned();
        let connection = store.connect().unwrap();
        let assigned: String = connection.query_row("SELECT price_list_id FROM client_price_lists WHERE client_id=?", [&client], |row| row.get(0)).unwrap();
        assert_eq!(assigned, second);
        drop(connection);
        assert!(store.save_price_list(input(Some(first.clone()), 10_001, vec![])).is_err());
        assert!(store.save_price_list(PriceListInput { items: vec![PriceListItemInput { catalog_item_id: item.clone(), unit_price_cents: 1 }, PriceListItemInput { catalog_item_id: item.clone(), unit_price_cents: 2 }], ..input(Some(first.clone()), 0, vec![]) }).is_err());
        store.save_price_list(input(Some(first), 1_500, vec![])).unwrap();
        let workspace = store.get_workspace().unwrap();
        assert_eq!(workspace["price_lists"].as_array().unwrap().len(), 2);
        assert_eq!(workspace["price_list_items"].as_array().unwrap().len(), 2);
        assert_eq!(workspace["client_price_lists"].as_array().unwrap().len(), 1);
    }
}
