use std::collections::{HashMap, HashSet};

use rusqlite::{params, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{AppError, AppResult},
};

const MAX_IMPORT_ROWS: usize = 5_000;
const MAX_SAFE_CENTS: i64 = 9_000_000_000_000_000;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CatalogImportConflictPolicy {
    Update,
    Skip,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CatalogImportRowInput {
    pub row_number: usize,
    pub sku: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub unit: String,
    pub purchase_cost_cents: i64,
    pub sales_price_cents: i64,
    pub vat_bp: i64,
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ImportCatalogItemsInput {
    pub conflict_policy: CatalogImportConflictPolicy,
    pub rows: Vec<CatalogImportRowInput>,
}

#[derive(Debug)]
struct ExistingCatalogItem {
    id: String,
    track_stock: bool,
}

#[derive(Debug)]
struct NormalizedRow {
    row_number: usize,
    sku: String,
    sku_key: String,
    name: String,
    description: String,
    unit: String,
    purchase_cost_cents: i64,
    sales_price_cents: i64,
    vat_bp: i64,
    kind: String,
}

#[derive(Debug)]
enum PlannedMutation {
    Create(NormalizedRow),
    Update {
        row: NormalizedRow,
        existing: ExistingCatalogItem,
    },
    Skip,
}

impl LocalStore {
    pub fn import_catalog_items(&self, input: ImportCatalogItemsInput) -> AppResult<Value> {
        let rows = normalize_rows(input.rows)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let existing_by_sku = {
            let mut statement = transaction.prepare(
                "SELECT id,sku,track_stock FROM catalog_items
                  WHERE sku IS NOT NULL AND TRIM(sku)<>'' ORDER BY created_at,id",
            )?;
            let existing = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut by_sku: HashMap<String, Vec<ExistingCatalogItem>> = HashMap::new();
            for (id, sku, track_stock) in existing {
                by_sku
                    .entry(canonical_sku(&sku))
                    .or_default()
                    .push(ExistingCatalogItem { id, track_stock });
            }
            by_sku
        };

        let mut plan = Vec::with_capacity(rows.len());
        for row in rows {
            match existing_by_sku.get(&row.sku_key) {
                Some(matches) if matches.len() > 1 => {
                    return Err(AppError::Validation(format!(
                        "Ligne {} : plusieurs fiches du catalogue utilisent déjà cette référence, sans distinction de majuscules. Corrigez ce doublon avant l'import.",
                        row.row_number
                    )));
                }
                Some(matches) => match input.conflict_policy {
                    CatalogImportConflictPolicy::Skip => plan.push(PlannedMutation::Skip),
                    CatalogImportConflictPolicy::Update => {
                        let existing = matches.first().ok_or_else(|| {
                            AppError::Validation(
                                "Le contrôle des références existantes est incohérent.".into(),
                            )
                        })?;
                        if existing.track_stock && row.kind != "product" {
                            return Err(AppError::Validation(format!(
                                "Ligne {} : un article suivi en stock ne peut pas devenir un service pendant l'import.",
                                row.row_number
                            )));
                        }
                        plan.push(PlannedMutation::Update {
                            row,
                            existing: ExistingCatalogItem {
                                id: existing.id.clone(),
                                track_stock: existing.track_stock,
                            },
                        });
                    }
                },
                None => plan.push(PlannedMutation::Create(row)),
            }
        }

        let batch_id = Uuid::new_v4().to_string();
        let now = now_iso();
        let mut created = 0_usize;
        let mut updated = 0_usize;
        let mut skipped = 0_usize;
        for mutation in plan {
            match mutation {
                PlannedMutation::Create(row) => {
                    transaction.execute(
                        "INSERT INTO catalog_items(
                           id,kind,sku,name,description,unit,sales_price_cents,purchase_cost_cents,
                           vat_bp,track_stock,stock_quantity_milli,reorder_level_milli,archived_at,
                           created_at,updated_at
                         ) VALUES(?,?,?,?,?,?,?,?,?,0,0,0,NULL,?,?)",
                        params![
                            Uuid::new_v4().to_string(),
                            row.kind,
                            row.sku,
                            row.name,
                            row.description,
                            row.unit,
                            row.sales_price_cents,
                            row.purchase_cost_cents,
                            row.vat_bp,
                            now,
                            now
                        ],
                    )?;
                    created += 1;
                }
                PlannedMutation::Update { row, existing } => {
                    let changed = transaction.execute(
                        "UPDATE catalog_items
                            SET kind=?,sku=?,name=?,description=?,unit=?,sales_price_cents=?,
                                purchase_cost_cents=?,vat_bp=?,updated_at=?
                          WHERE id=?",
                        params![
                            row.kind,
                            row.sku,
                            row.name,
                            row.description,
                            row.unit,
                            row.sales_price_cents,
                            row.purchase_cost_cents,
                            row.vat_bp,
                            now,
                            existing.id
                        ],
                    )?;
                    if changed != 1 {
                        return Err(AppError::Validation(format!(
                            "Ligne {} : la fiche à mettre à jour a changé pendant l'import.",
                            row.row_number
                        )));
                    }
                    updated += 1;
                }
                PlannedMutation::Skip => skipped += 1,
            }
        }

        append_audit(
            &transaction,
            "import",
            "catalog",
            &batch_id,
            &json!({
                "source":"validated_local_spreadsheet",
                "conflict_policy":input.conflict_policy,
                "received_count":created + updated + skipped,
                "created_count":created,
                "updated_count":updated,
                "skipped_count":skipped
            }),
        )?;
        transaction.commit()?;

        Ok(json!({
            "batch_id":batch_id,
            "received_count":created + updated + skipped,
            "created_count":created,
            "updated_count":updated,
            "skipped_count":skipped
        }))
    }
}

fn normalize_rows(rows: Vec<CatalogImportRowInput>) -> AppResult<Vec<NormalizedRow>> {
    if rows.is_empty() {
        return Err(AppError::Validation(
            "Le catalogue à importer ne contient aucune ligne.".into(),
        ));
    }
    if rows.len() > MAX_IMPORT_ROWS {
        return Err(AppError::Validation(format!(
            "Le catalogue dépasse la limite de {MAX_IMPORT_ROWS} lignes."
        )));
    }

    let mut row_numbers = HashSet::with_capacity(rows.len());
    let mut sku_keys = HashSet::with_capacity(rows.len());
    rows.into_iter()
        .map(|row| {
            if row.row_number == 0 || !row_numbers.insert(row.row_number) {
                return Err(AppError::Validation(format!(
                    "Le numéro de ligne {} est invalide ou dupliqué.",
                    row.row_number
                )));
            }
            let sku = required_text(row.sku, "Référence", 80, row.row_number)?;
            let sku_key = canonical_sku(&sku);
            if !sku_keys.insert(sku_key.clone()) {
                return Err(AppError::Validation(format!(
                    "Ligne {} : cette référence apparaît plusieurs fois dans le fichier, sans distinction de majuscules.",
                    row.row_number
                )));
            }
            let name = required_text(row.name, "Désignation", 200, row.row_number)?;
            let description = optional_text(row.description, "Description", 10_000, row.row_number)?;
            let unit = required_text(row.unit, "Unité", 40, row.row_number)?;
            if !matches!(row.kind.as_str(), "product" | "service") {
                return Err(AppError::Validation(format!(
                    "Ligne {} : le type doit être product ou service.",
                    row.row_number
                )));
            }
            validate_cents(row.purchase_cost_cents, "Prix d'achat", row.row_number)?;
            validate_cents(row.sales_price_cents, "Prix de vente", row.row_number)?;
            if !(0..=10_000).contains(&row.vat_bp) {
                return Err(AppError::Validation(format!(
                    "Ligne {} : le taux de TVA doit être compris entre 0 et 10000 points de base.",
                    row.row_number
                )));
            }
            Ok(NormalizedRow {
                row_number: row.row_number,
                sku,
                sku_key,
                name,
                description,
                unit,
                purchase_cost_cents: row.purchase_cost_cents,
                sales_price_cents: row.sales_price_cents,
                vat_bp: row.vat_bp,
                kind: row.kind,
            })
        })
        .collect()
}

fn required_text(
    value: String,
    field: &str,
    maximum: usize,
    row_number: usize,
) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(AppError::Validation(format!(
            "Ligne {row_number} : {field} est obligatoire et ne peut pas contenir de caractère de contrôle."
        )));
    }
    if value.chars().count() > maximum {
        return Err(AppError::Validation(format!(
            "Ligne {row_number} : {field} ne peut pas dépasser {maximum} caractères."
        )));
    }
    Ok(value.to_owned())
}

fn optional_text(
    value: String,
    field: &str,
    maximum: usize,
    row_number: usize,
) -> AppResult<String> {
    let value = value.trim();
    if value
        .chars()
        .any(|character| character.is_control() && character != '\n')
    {
        return Err(AppError::Validation(format!(
            "Ligne {row_number} : {field} contient un caractère de contrôle interdit."
        )));
    }
    if value.chars().count() > maximum {
        return Err(AppError::Validation(format!(
            "Ligne {row_number} : {field} ne peut pas dépasser {maximum} caractères."
        )));
    }
    Ok(value.to_owned())
}

fn validate_cents(value: i64, field: &str, row_number: usize) -> AppResult<()> {
    if !(0..=MAX_SAFE_CENTS).contains(&value) {
        return Err(AppError::Validation(format!(
            "Ligne {row_number} : {field} est hors de la plage monétaire sûre."
        )));
    }
    Ok(())
}

fn canonical_sku(value: &str) -> String {
    value.trim().to_lowercase()
}
