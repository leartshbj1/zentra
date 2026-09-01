use std::collections::BTreeMap;

use chrono::{Local, NaiveDate};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, query_record_tx, LocalStore},
    error::{AppError, AppResult},
    models::{StockCorrectionInput, StockEntryInput, StockExitInput},
};

const MAX_STOCK_QUANTITY_MILLI: i64 = 9_000_000_000_000_000;
const MAX_STOCK_LINES_PER_INVOICE: usize = 10_000;

#[derive(Debug, Clone, Copy)]
enum ManualMovementType {
    Entry,
    Exit,
    Correction,
}

impl ManualMovementType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Entry => "entry",
            Self::Exit => "exit",
            Self::Correction => "correction",
        }
    }

    fn audit_action(self) -> &'static str {
        match self {
            Self::Entry => "stock_entry",
            Self::Exit => "stock_exit",
            Self::Correction => "stock_correction",
        }
    }
}

#[derive(Debug)]
struct ManualMovement {
    request_id: String,
    catalog_item_id: String,
    movement_type: ManualMovementType,
    quantity_delta_milli: i64,
    reason: String,
    reference: Option<String>,
    requested_date: Option<String>,
}

#[derive(Debug)]
struct InvoiceStockLine {
    invoice_item_id: String,
    catalog_item_id: String,
    quantity_milli: i64,
    existing_movement_id: Option<String>,
}

fn payload_hash(payload_json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(payload_json.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn normalized_uuid(value: &str, field: &str) -> AppResult<String> {
    Uuid::parse_str(value.trim())
        .map(|value| value.to_string())
        .map_err(|_| AppError::Validation(format!("{field} doit être un UUID valide.")))
}

fn required_text(value: String, field: &str, maximum: usize) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::Validation(format!("{field} est obligatoire.")));
    }
    if value.chars().count() > maximum {
        return Err(AppError::Validation(format!(
            "{field} ne peut pas dépasser {maximum} caractères."
        )));
    }
    Ok(value.to_owned())
}

fn optional_text(value: Option<String>, field: &str, maximum: usize) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > maximum {
        return Err(AppError::Validation(format!(
            "{field} ne peut pas dépasser {maximum} caractères."
        )));
    }
    Ok(Some(value.to_owned()))
}

fn optional_date(value: Option<String>) -> AppResult<Option<String>> {
    let value = optional_text(value, "date", 10)?;
    value
        .map(|value| {
            NaiveDate::parse_from_str(&value, "%Y-%m-%d")
                .map(|_| value)
                .map_err(|_| {
                    AppError::Validation(
                        "date doit être une date valide au format AAAA-MM-JJ.".into(),
                    )
                })
        })
        .transpose()
}

fn today() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

fn validate_catalog_item_id(value: String) -> AppResult<String> {
    required_text(value, "catalog_item_id", 255)
}

fn validate_positive_quantity(value: i64) -> AppResult<i64> {
    if !(1..=MAX_STOCK_QUANTITY_MILLI).contains(&value) {
        return Err(AppError::Validation(format!(
            "quantity_milli doit être compris entre 1 et {MAX_STOCK_QUANTITY_MILLI}."
        )));
    }
    Ok(value)
}

fn validate_correction_delta(value: i64) -> AppResult<i64> {
    if value == 0 || !(-MAX_STOCK_QUANTITY_MILLI..=MAX_STOCK_QUANTITY_MILLI).contains(&value) {
        return Err(AppError::Validation(format!(
            "delta_quantity_milli doit être non nul et compris entre -{MAX_STOCK_QUANTITY_MILLI} et {MAX_STOCK_QUANTITY_MILLI}."
        )));
    }
    Ok(value)
}

fn quantity_to_milli(quantity: f64) -> AppResult<i64> {
    if !quantity.is_finite() || quantity <= 0.0 {
        return Err(AppError::Validation(
            "La quantité d'un article suivi doit être strictement positive.".into(),
        ));
    }
    let scaled = quantity * 1_000.0;
    if !scaled.is_finite() || scaled > MAX_STOCK_QUANTITY_MILLI as f64 {
        return Err(AppError::Validation(
            "La quantité facturée dépasse la capacité du registre de stock.".into(),
        ));
    }
    let rounded = scaled.round();
    if (scaled - rounded).abs() > 0.000_001 {
        return Err(AppError::Validation(
            "La quantité d'un article suivi doit être exprimable en millièmes d'unité.".into(),
        ));
    }
    let quantity_milli = rounded as i64;
    if !(1..=MAX_STOCK_QUANTITY_MILLI).contains(&quantity_milli) {
        return Err(AppError::Validation(
            "La quantité facturée dépasse la capacité du registre de stock.".into(),
        ));
    }
    Ok(quantity_milli)
}

fn load_manual_result(
    transaction: &Transaction<'_>,
    movement_id: &str,
    idempotent: bool,
) -> AppResult<Value> {
    let movement = query_record_tx(transaction, "stock_movements", movement_id)?;
    let catalog_item_id = movement
        .get("catalog_item_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Validation("Le mouvement de stock est incomplet.".into()))?;
    let catalog_item = query_record_tx(transaction, "catalog_items", catalog_item_id)?;
    Ok(json!({
        "movement": movement,
        "catalog_item": catalog_item,
        "idempotent": idempotent,
    }))
}

impl LocalStore {
    pub fn record_stock_entry(&self, input: StockEntryInput) -> AppResult<Value> {
        let quantity = validate_positive_quantity(input.quantity_milli)?;
        self.record_manual_stock_movement(ManualMovement {
            request_id: input.request_id,
            catalog_item_id: input.catalog_item_id,
            movement_type: ManualMovementType::Entry,
            quantity_delta_milli: quantity,
            reason: input.reason,
            reference: input.reference,
            requested_date: input.date,
        })
    }

    pub fn record_stock_exit(&self, input: StockExitInput) -> AppResult<Value> {
        let quantity = validate_positive_quantity(input.quantity_milli)?;
        self.record_manual_stock_movement(ManualMovement {
            request_id: input.request_id,
            catalog_item_id: input.catalog_item_id,
            movement_type: ManualMovementType::Exit,
            quantity_delta_milli: -quantity,
            reason: input.reason,
            reference: input.reference,
            requested_date: input.date,
        })
    }

    pub fn record_stock_correction(&self, input: StockCorrectionInput) -> AppResult<Value> {
        let delta = validate_correction_delta(input.delta_quantity_milli)?;
        self.record_manual_stock_movement(ManualMovement {
            request_id: input.request_id,
            catalog_item_id: input.catalog_item_id,
            movement_type: ManualMovementType::Correction,
            quantity_delta_milli: delta,
            reason: input.reason,
            reference: input.reference,
            requested_date: input.date,
        })
    }

    fn record_manual_stock_movement(&self, input: ManualMovement) -> AppResult<Value> {
        let request_id = normalized_uuid(&input.request_id, "request_id")?;
        let catalog_item_id = validate_catalog_item_id(input.catalog_item_id)?;
        let reason = required_text(input.reason, "reason", 500)?;
        let reference = optional_text(input.reference, "reference", 200)?;
        let requested_date = optional_date(input.requested_date)?;
        let movement_date = requested_date.clone().unwrap_or_else(today);
        let request_payload = json!({
            "catalog_item_id": catalog_item_id,
            "movement_type": input.movement_type.as_str(),
            "quantity_delta_milli": input.quantity_delta_milli,
            "reason": reason,
            "reference": reference,
            "date": requested_date,
        });
        let request_json = serde_json::to_string(&request_payload)?;
        let request_sha256 = payload_hash(&request_json);

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT id,request_sha256,request_json FROM stock_movements WHERE request_id=?",
                params![request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((movement_id, existing_sha256, existing_json)) = existing {
            if existing_sha256 != request_sha256 || existing_json != request_json {
                return Err(AppError::Validation(
                    "Ce request_id a déjà été utilisé avec un autre mouvement de stock.".into(),
                ));
            }
            let result = load_manual_result(&transaction, &movement_id, true)?;
            transaction.commit()?;
            return Ok(result);
        }

        let item: Option<(i64, i64)> = transaction
            .query_row(
                "SELECT track_stock,stock_quantity_milli FROM catalog_items WHERE id=?",
                params![catalog_item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (track_stock, current_balance) =
            item.ok_or_else(|| AppError::NotFound(format!("catalog_items/{catalog_item_id}")))?;
        if track_stock != 1 {
            return Err(AppError::Validation(
                "L'article doit être configuré avec track_stock=1 avant tout mouvement.".into(),
            ));
        }
        let balance_after = current_balance
            .checked_add(input.quantity_delta_milli)
            .filter(|balance| (0..=MAX_STOCK_QUANTITY_MILLI).contains(balance))
            .ok_or_else(|| {
                if input.quantity_delta_milli < 0 {
                    AppError::Validation(
                        "Stock insuffisant : une quantité négative est interdite.".into(),
                    )
                } else {
                    AppError::Validation(
                        "Le solde de stock dépasse la capacité locale autorisée.".into(),
                    )
                }
            })?;

        let movement_id = Uuid::new_v4().to_string();
        let source_key = format!("manual:{request_id}");
        let created_at = now_iso();
        transaction.execute(
            "INSERT INTO stock_movements(
               id,source_key,request_id,request_sha256,request_json,catalog_item_id,
               movement_type,quantity_delta_milli,balance_after_milli,reason,reference,
               movement_date,source_type,invoice_id,invoice_item_id,created_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                movement_id,
                source_key,
                request_id,
                request_sha256,
                request_json,
                catalog_item_id,
                input.movement_type.as_str(),
                input.quantity_delta_milli,
                balance_after,
                reason,
                reference,
                movement_date,
                "manual",
                Option::<String>::None,
                Option::<String>::None,
                created_at,
            ],
        )?;
        let result = load_manual_result(&transaction, &movement_id, false)?;
        append_audit(
            &transaction,
            input.movement_type.audit_action(),
            "stock_movement",
            &movement_id,
            &json!({
                "request_id": request_id,
                "request_sha256": request_sha256,
                "result": result,
            }),
        )?;
        transaction.commit()?;
        Ok(result)
    }
}

/// Crée les sorties d'une facture déjà gelée dans la transaction d'émission.
/// Seules les factures `standard` sont concernées. Les acomptes, situations,
/// finales, avoirs et brouillons sont explicitement ignorés afin de ne jamais
/// déduire deux fois une même livraison sans workflow logistique dédié. Une
/// facture ayant des mouvements ne peut ensuite pas être annulée tant qu'un
/// futur workflow d'extourne dédié et vérifiable n'existe pas.
pub(crate) fn apply_invoice_stock_movements(
    transaction: &Transaction<'_>,
    invoice_id: &str,
) -> AppResult<Value> {
    let invoice: Option<(String, String, Option<String>, Option<String>)> = transaction
        .query_row(
            "SELECT type,status,number,issue_date FROM invoices WHERE id=?",
            params![invoice_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let (invoice_type, status, number, issue_date) =
        invoice.ok_or_else(|| AppError::NotFound(format!("invoices/{invoice_id}")))?;
    if invoice_type != "standard"
        || status == "brouillon"
        || status == "annulee"
        || number.as_deref().is_none_or(str::is_empty)
    {
        return Ok(json!([]));
    }
    if !matches!(status.as_str(), "emise" | "partiellement_payee" | "payee") {
        return Err(AppError::Validation(
            "La sortie automatique exige une facture standard réellement émise.".into(),
        ));
    }
    let number = number.expect("checked as present and non-empty");
    if number.chars().count() > 200 {
        return Err(AppError::Validation(
            "Le numéro de facture dépasse 200 caractères et ne peut pas référencer le stock."
                .into(),
        ));
    }
    let movement_date = issue_date
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::Validation(
                "La date d'émission est obligatoire avant la sortie de stock.".into(),
            )
        })?;
    NaiveDate::parse_from_str(&movement_date, "%Y-%m-%d").map_err(|_| {
        AppError::Validation(
            "La date d'émission est invalide; aucune sortie de stock n'a été créée.".into(),
        )
    })?;

    let mut statement = transaction.prepare(
        "SELECT line.id,line.catalog_item_id,line.quantity,item.stock_quantity_milli,
                movement.id,movement.quantity_delta_milli,movement.catalog_item_id,movement.invoice_id
         FROM invoice_items line
         JOIN catalog_items item ON item.id=line.catalog_item_id AND item.track_stock=1 AND item.kind='product'
         LEFT JOIN stock_movements movement ON movement.invoice_item_id=line.id
         WHERE line.invoice_id=? AND line.quantity>0
         ORDER BY line.position,line.rowid",
    )?;
    let rows = statement
        .query_map(params![invoice_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    if rows.len() > MAX_STOCK_LINES_PER_INVOICE {
        return Err(AppError::Validation(format!(
            "Une facture peut contenir au maximum {MAX_STOCK_LINES_PER_INVOICE} lignes suivies en stock."
        )));
    }

    let mut lines = Vec::with_capacity(rows.len());
    let mut requirements: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    for (
        invoice_item_id,
        catalog_item_id,
        quantity,
        current_balance_milli,
        existing_movement_id,
        existing_delta_milli,
        existing_catalog_item_id,
        existing_invoice_id,
    ) in rows
    {
        let quantity_milli = quantity_to_milli(quantity)?;
        if let Some(existing_id) = existing_movement_id.as_deref() {
            if existing_delta_milli != Some(-quantity_milli)
                || existing_catalog_item_id.as_deref() != Some(catalog_item_id.as_str())
                || existing_invoice_id.as_deref() != Some(invoice_id)
            {
                return Err(AppError::Validation(format!(
                    "Le mouvement existant de la ligne {invoice_item_id} ne correspond pas à la facture."
                )));
            }
            if existing_id.is_empty() {
                return Err(AppError::Validation(
                    "Un mouvement de stock existant possède un identifiant invalide.".into(),
                ));
            }
        } else {
            let requirement = requirements
                .entry(catalog_item_id.clone())
                .or_insert((current_balance_milli, 0));
            if requirement.0 != current_balance_milli {
                return Err(AppError::Validation(
                    "Le solde d'un article a changé pendant l'émission de la facture.".into(),
                ));
            }
            requirement.1 = requirement
                .1
                .checked_add(quantity_milli)
                .filter(|total| *total <= MAX_STOCK_QUANTITY_MILLI)
                .ok_or_else(|| {
                    AppError::Validation(
                        "La quantité totale facturée dépasse la capacité du registre de stock."
                            .into(),
                    )
                })?;
        }
        lines.push(InvoiceStockLine {
            invoice_item_id,
            catalog_item_id,
            quantity_milli,
            existing_movement_id,
        });
    }

    for (catalog_item_id, (available, required)) in &requirements {
        if required > available {
            return Err(AppError::Validation(format!(
                "Stock insuffisant pour l'article {catalog_item_id}: {available} millièmes disponibles, {required} requis."
            )));
        }
    }

    let created_at = now_iso();
    let reason = format!("Sortie automatique à l'émission de la facture {number}");
    if reason.chars().count() > 500 {
        return Err(AppError::Validation(
            "La référence de facture est trop longue pour le registre de stock.".into(),
        ));
    }
    let mut inserted = false;
    for line in &lines {
        if line.existing_movement_id.is_some() {
            continue;
        }
        let current_balance: i64 = transaction.query_row(
            "SELECT stock_quantity_milli FROM catalog_items WHERE id=? AND track_stock=1",
            params![line.catalog_item_id],
            |row| row.get(0),
        )?;
        let balance_after = current_balance
            .checked_sub(line.quantity_milli)
            .filter(|balance| *balance >= 0)
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "Stock insuffisant pour l'article {}.",
                    line.catalog_item_id
                ))
            })?;
        let movement_id = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO stock_movements(
               id,source_key,request_id,request_sha256,request_json,catalog_item_id,
               movement_type,quantity_delta_milli,balance_after_milli,reason,reference,
               movement_date,source_type,invoice_id,invoice_item_id,created_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                movement_id,
                format!("invoice:{}", line.invoice_item_id),
                Option::<String>::None,
                Option::<String>::None,
                Option::<String>::None,
                line.catalog_item_id,
                "exit",
                -line.quantity_milli,
                balance_after,
                reason,
                number,
                movement_date,
                "invoice",
                invoice_id,
                line.invoice_item_id,
                created_at,
            ],
        )?;
        inserted = true;
    }

    let movements = query_all(
        transaction,
        "SELECT sequence,id,source_key,request_id,catalog_item_id,movement_type,
                quantity_delta_milli,balance_after_milli,reason,reference,movement_date,
                source_type,invoice_id,invoice_item_id,created_at
         FROM stock_movements WHERE invoice_id=? ORDER BY sequence",
        params![invoice_id],
    )?;
    if inserted {
        append_audit(
            transaction,
            "stock_issue",
            "invoice",
            invoice_id,
            &json!({"invoice_number": number, "stock_movements": movements}),
        )?;
    }
    Ok(json!(movements))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{quantity_to_milli, MAX_STOCK_QUANTITY_MILLI};
    use crate::schema::MIGRATION_V18_SQL;

    #[test]
    fn invoice_quantities_must_be_exact_milli_units() {
        assert_eq!(quantity_to_milli(1.234).unwrap(), 1_234);
        assert_eq!(quantity_to_milli(0.001).unwrap(), 1);
        assert!(quantity_to_milli(0.000_1).is_err());
        assert!(quantity_to_milli(f64::INFINITY).is_err());
        assert!(quantity_to_milli(MAX_STOCK_QUANTITY_MILLI as f64 + 10_000.0).is_err());
    }

    #[test]
    fn v18_opening_migration_is_idempotent_and_preserves_balance() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE catalog_items(
                   id TEXT PRIMARY KEY,
                   kind TEXT NOT NULL,
                   track_stock INTEGER NOT NULL,
                   stock_quantity_milli INTEGER NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE invoices(
                   id TEXT PRIMARY KEY,
                   number TEXT,
                   status TEXT NOT NULL,
                   type TEXT NOT NULL,
                   issue_date TEXT
                 );
                 CREATE TABLE invoice_items(
                   id TEXT PRIMARY KEY,
                   invoice_id TEXT NOT NULL REFERENCES invoices(id),
                   catalog_item_id TEXT REFERENCES catalog_items(id),
                   quantity REAL NOT NULL
                 );
                 INSERT INTO catalog_items VALUES('tracked','product',1,12500,'2026-08-31T12:00:00Z');
                 INSERT INTO catalog_items VALUES('zero','product',1,0,'2026-08-31T12:00:00Z');
                 INSERT INTO catalog_items VALUES('untracked','product',0,9000,'2026-08-31T12:00:00Z');
                 PRAGMA user_version=17;",
            )
            .unwrap();

        connection.execute_batch(MIGRATION_V18_SQL).unwrap();
        connection.execute_batch(MIGRATION_V18_SQL).unwrap();

        let opening: (i64, i64, i64) = connection
            .query_row(
                "SELECT COUNT(*),quantity_delta_milli,balance_after_milli
                 FROM stock_movements WHERE catalog_item_id='tracked'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(opening, (1, 12_500, 12_500));
        let untouched: i64 = connection
            .query_row(
                "SELECT stock_quantity_milli FROM catalog_items WHERE id='tracked'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(untouched, 12_500);
        let other_openings: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM stock_movements WHERE catalog_item_id<>'tracked'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(other_openings, 0);
    }
}
