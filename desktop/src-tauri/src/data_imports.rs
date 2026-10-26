//! Reprise des données d'un autre logiciel (bexio, WinBIZ, Crésus, Banana,
//! AbaNinja/Swiss21 ou un fichier Excel/CSV) avec historique et annulation.
//! L'app lit le fichier et prépare l'aperçu ; ces commandes refont chaque
//! contrôle, écrivent dans une seule transaction et gardent la trace des
//! fiches créées ou mises à jour. Annuler supprime ce qui n'a pas encore servi,
//! rétablit les articles mis à jour et extourne les écritures reprises ; ce qui
//! est déjà utilisé reste en place et figure dans le rapport.

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    accounting::{reverse_journal_entry_tx, valid_report_section},
    audit::append_audit,
    bexio_import::BexioContactImport,
    catalog_import::{import_catalog_items_checked_tx, CatalogImportChange, ImportCatalogItemsInput},
    database::{now_iso, query_all, query_record_tx, LocalStore},
    commands::run_scoped_local_operation,
    error::{command_error, AppError, AppResult},
    opening_balances::{
        import_opening_balance_tx, import_opening_receivables_tx, OpeningBalanceInput,
        OpeningReceivablesInput,
    },
};

const MAX_ACCOUNTS: usize = 2_000;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportOrigin {
    pub source: String,
    #[serde(default)]
    pub file_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationContactsInput {
    pub origin: ImportOrigin,
    pub contacts: BexioContactImport,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationCatalogInput {
    pub origin: ImportOrigin,
    pub catalog: ImportCatalogItemsInput,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountImportRow {
    pub line: i64,
    pub code: String,
    pub name: String,
    pub account_type: String,
    pub normal_balance: String,
    pub report_section: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationAccountsInput {
    pub origin: ImportOrigin,
    pub rows: Vec<AccountImportRow>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationReceivablesInput {
    pub origin: ImportOrigin,
    pub receivables: OpeningReceivablesInput,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationBalanceInput {
    pub origin: ImportOrigin,
    pub balance: OpeningBalanceInput,
}

/// Nom affiché du logiciel d'origine, repris dans les libellés créés.
pub(crate) fn source_label(source: &str) -> AppResult<&'static str> {
    Ok(match source {
        "bexio" => "bexio",
        "winbiz" => "WinBIZ",
        "cresus" => "Crésus",
        "banana" => "Banana",
        "abaninja" => "AbaNinja",
        "generic" => "fichier importé",
        _ => return Err(invalid("Choisissez le logiciel d'origine de l'export.")),
    })
}

fn clean_file_name(origin: &ImportOrigin) -> AppResult<Option<String>> {
    let Some(name) = origin.file_name.as_deref().map(str::trim).filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    if name.chars().any(char::is_control) {
        return Err(invalid("Le nom du fichier importé est illisible."));
    }
    Ok(Some(name.chars().take(255).collect()))
}

struct Tracked {
    entity: &'static str,
    id: String,
    action: &'static str,
    before: Option<Value>,
}

#[allow(clippy::too_many_arguments)]
fn record_import(
    tx: &Transaction<'_>,
    origin: &ImportOrigin,
    kind: &str,
    created: i64,
    updated: i64,
    skipped: i64,
    report: &Value,
    records: Vec<Tracked>,
) -> AppResult<String> {
    source_label(&origin.source)?;
    let id = Uuid::new_v4().to_string();
    let file_name = clean_file_name(origin)?;
    tx.execute(
        "INSERT INTO data_imports(id,source,kind,file_name,created_count,updated_count,skipped_count,report_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)",
        params![id, origin.source, kind, file_name, created, updated, skipped, serde_json::to_string(report)?, now_iso()],
    )?;
    for record in records {
        tx.execute(
            "INSERT INTO data_import_records(import_id,entity,record_id,action,before_json) VALUES(?,?,?,?,?)",
            params![
                id,
                record.entity,
                record.id,
                record.action,
                record.before.map(|value| serde_json::to_string(&value)).transpose()?
            ],
        )?;
    }
    append_audit(
        tx,
        "import",
        "data_import",
        &id,
        &json!({"source":origin.source,"kind":kind,"file_name":file_name,"created":created,"updated":updated,"skipped":skipped}),
    )?;
    Ok(id)
}

fn count(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap_or(0)
}

/// Comptes absents du plan : ajoutés tels que vérifiés dans l'aperçu. Un
/// numéro déjà présent n'est jamais renommé, reclassé ni désactivé.
fn import_accounts_tx(tx: &Transaction<'_>, rows: &[AccountImportRow]) -> AppResult<(Value, Vec<String>)> {
    if rows.is_empty() || rows.len() > MAX_ACCOUNTS {
        return Err(invalid("Importez entre 1 et 2 000 comptes à la fois."));
    }
    let mut seen = std::collections::HashSet::new();
    let mut report = Vec::new();
    let mut created = Vec::new();
    let now = now_iso();
    for row in rows {
        let at = |message: &str| invalid(format!("Ligne {} : {message}", row.line));
        let code = row.code.trim().to_uppercase();
        if code.is_empty() || code.len() > 10 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(at("le numéro de compte est illisible."));
        }
        if !seen.insert(code.clone()) {
            return Err(at("ce compte apparaît deux fois dans le fichier."));
        }
        let name = row.name.trim();
        if name.is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control) {
            return Err(at("indiquez un nom de compte de 1 à 200 caractères."));
        }
        if !matches!(row.account_type.as_str(), "asset" | "liability" | "equity" | "revenue" | "expense") {
            return Err(at("choisissez la nature du compte."));
        }
        if !matches!(row.normal_balance.as_str(), "debit" | "credit") {
            return Err(at("le solde normal doit être au débit ou au crédit."));
        }
        if !valid_report_section(&row.account_type, &row.report_section) {
            return Err(at("la rubrique ne correspond pas à la nature du compte."));
        }
        let existing: Option<String> = tx
            .query_row("SELECT name FROM accounts WHERE code=?", [&code], |r| r.get(0))
            .optional()?;
        if let Some(existing) = existing {
            report.push(json!({"line":row.line,"code":code,"name":existing,"status":"skipped","reason":"Compte déjà présent, gardé tel quel"}));
            continue;
        }
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO accounts(id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)",
            params![id, code, name, row.account_type, row.normal_balance, row.report_section, now, now],
        )?;
        let saved = query_record_tx(tx, "accounts", &id)?;
        append_audit(tx, "create", "account", &id, &saved)?;
        report.push(json!({"line":row.line,"code":code,"name":name,"status":"created"}));
        created.push(id);
    }
    let created_count = created.len();
    Ok((json!({"created":created_count,"skipped":report.len()-created_count,"rows":report}), created))
}

impl LocalStore {
    fn migration_transaction<T>(&self, operation: impl FnOnce(&Transaction<'_>) -> AppResult<T>) -> AppResult<T> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = operation(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn import_migration_contacts(&self, input: MigrationContactsInput) -> AppResult<Value> {
        source_label(&input.origin.source)?;
        self.check_contact_import(&input.contacts)?;
        let origin = input.origin;
        self.migration_transaction(|tx| {
            let entity: &'static str = if input.contacts.entity == "clients" { "clients" } else { "suppliers" };
            let audit_source = format!("{}_export", origin.source);
            let (mut receipt, ids) = crate::database::import_contacts_tx(tx, input.contacts, &audit_source)?;
            let records = ids.into_iter().map(|id| Tracked { entity, id, action: "created", before: None }).collect();
            let import_id = record_import(tx, &origin, entity, count(&receipt, "created"), 0, count(&receipt, "skipped"), &receipt["rows"], records)?;
            receipt["import_id"] = json!(import_id);
            Ok(receipt)
        })
    }

    pub fn import_migration_catalog(&self, input: MigrationCatalogInput) -> AppResult<Value> {
        source_label(&input.origin.source)?;
        let origin = input.origin;
        self.migration_transaction(|tx| {
            let (mut receipt, changes) = import_catalog_items_checked_tx(tx, input.catalog)?;
            let records = changes
                .into_iter()
                .map(|change| match change {
                    CatalogImportChange::Created(id) => Tracked { entity: "catalog_items", id, action: "created", before: None },
                    CatalogImportChange::Updated { id, before } => Tracked { entity: "catalog_items", id, action: "updated", before: Some(before) },
                })
                .collect();
            let summary = json!({"created":receipt["created_count"],"updated":receipt["updated_count"],"skipped":receipt["skipped_count"]});
            let import_id = record_import(
                tx, &origin, "catalog",
                count(&receipt, "created_count"), count(&receipt, "updated_count"), count(&receipt, "skipped_count"),
                &summary, records,
            )?;
            receipt["import_id"] = json!(import_id);
            Ok(receipt)
        })
    }

    pub fn import_migration_accounts(&self, input: MigrationAccountsInput) -> AppResult<Value> {
        source_label(&input.origin.source)?;
        self.migration_transaction(|tx| {
            let (mut receipt, ids) = import_accounts_tx(tx, &input.rows)?;
            let records = ids.into_iter().map(|id| Tracked { entity: "accounts", id, action: "created", before: None }).collect();
            let import_id = record_import(tx, &input.origin, "accounts", count(&receipt, "created"), 0, count(&receipt, "skipped"), &receipt["rows"], records)?;
            receipt["import_id"] = json!(import_id);
            Ok(receipt)
        })
    }

    pub fn import_migration_receivables(&self, input: MigrationReceivablesInput) -> AppResult<Value> {
        let label = source_label(&input.origin.source)?;
        self.migration_transaction(|tx| {
            let mut receipt = import_opening_receivables_tx(tx, &input.receivables, label)?;
            let records = receipt["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|row| row["invoice_id"].as_str())
                .map(|id| Tracked { entity: "invoices", id: id.to_owned(), action: "created", before: None })
                .collect();
            let import_id = record_import(tx, &input.origin, "opening_receivables", count(&receipt, "created"), 0, count(&receipt, "skipped"), &receipt["rows"], records)?;
            receipt["import_id"] = json!(import_id);
            Ok(receipt)
        })
    }

    pub fn import_migration_balance(&self, input: MigrationBalanceInput) -> AppResult<Value> {
        let label = source_label(&input.origin.source)?;
        self.migration_transaction(|tx| {
            let mut receipt = import_opening_balance_tx(tx, &input.balance, label)?;
            let journal_id = receipt["journal"]["id"].as_str().unwrap_or_default().to_owned();
            if journal_id.is_empty() {
                return Err(invalid("L'écriture du bilan d'ouverture n'a pas pu être relue."));
            }
            let lines = receipt["plan"]["lines"].as_array().map_or(0, Vec::len) as i64;
            let import_id = record_import(
                tx, &input.origin, "opening_balance", lines, 0, 0,
                &receipt["plan"]["lines"],
                vec![Tracked { entity: "journal_entries", id: journal_id, action: "created", before: None }],
            )?;
            receipt["import_id"] = json!(import_id);
            Ok(receipt)
        })
    }

    pub fn list_data_imports(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(Value::Array(query_all(
            &connection,
            "SELECT id,source,kind,file_name,created_count,updated_count,skipped_count,created_at,undone_at,
                    json(undo_report_json) AS undo_report
               FROM data_imports ORDER BY created_at DESC,rowid DESC LIMIT 200",
            [],
        )?))
    }

    pub fn get_data_import_report(&self, id: &str) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let report: Option<String> = connection
            .query_row("SELECT report_json FROM data_imports WHERE id=?", [id], |row| row.get(0))
            .optional()?;
        let report = report.ok_or_else(|| invalid("Cet import est introuvable."))?;
        Ok(serde_json::from_str(&report)?)
    }

    pub fn undo_data_import(&self, id: &str) -> AppResult<Value> {
        self.migration_transaction(|tx| undo_import_tx(tx, id))
    }
}

/// Tables où une fiche reprise est déjà utilisée (clés étrangères et pièces
/// jointes). `own` liste les tables qui appartiennent à la fiche elle-même.
fn usages(tx: &Transaction<'_>, table: &str, id: &str, own: &[&str]) -> AppResult<Vec<String>> {
    let references: Vec<(String, String)> = {
        let mut statement = tx.prepare(
            "SELECT m.name,f.\"from\" FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
              WHERE m.type='table' AND f.\"table\"=? ORDER BY m.name",
        )?;
        let rows = statement
            .query_map([table], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut used = Vec::new();
    for (other, column) in references {
        if own.contains(&other.as_str()) || used.contains(&other) {
            continue;
        }
        let present: bool = tx.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM \"{}\" WHERE \"{}\"=?)", other.replace('"', "\"\""), column.replace('"', "\"\"")),
            [id],
            |row| row.get(0),
        )?;
        if present {
            used.push(other);
        }
    }
    let attached: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM attachments WHERE entity_id=?)", [id], |row| row.get(0))?;
    if attached {
        used.push("attachments".into());
    }
    Ok(used)
}

fn label_of(record: &Value) -> String {
    ["name", "number", "code"]
        .iter()
        .find_map(|key| record[*key].as_str().filter(|value| !value.is_empty()))
        .unwrap_or_default()
        .to_owned()
}

fn undo_import_tx(tx: &Transaction<'_>, id: &str) -> AppResult<Value> {
    let row: Option<(String, String, Option<String>, String)> = tx
        .query_row(
            "SELECT kind,source,undone_at,created_at FROM data_imports WHERE id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let (kind, source, undone_at, created_at) = row.ok_or_else(|| invalid("Cet import est introuvable."))?;
    if undone_at.is_some() {
        return Err(invalid("Cet import est déjà annulé."));
    }
    let label = source_label(&source)?;
    let records: Vec<(String, String, String, Option<String>)> = {
        let mut statement = tx.prepare(
            "SELECT entity,record_id,action,before_json FROM data_import_records WHERE import_id=? ORDER BY rowid DESC",
        )?;
        let rows = statement
            .query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    if kind == "opening_receivables" {
        // Le bilan d'ouverture repris ensuite compte ces créances : il doit
        // être annulé d'abord, sinon le compte de créances serait faux.
        let later_balance: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM opening_balance_imports i WHERE i.created_at>=?
               AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reversal_of=i.journal_entry_id))",
            [&created_at],
            |row| row.get(0),
        )?;
        if later_balance {
            return Err(invalid("Un bilan d'ouverture a été repris après ces factures. Annulez d'abord ce bilan, puis les factures."));
        }
    }
    let (mut removed, mut restored, mut reversed) = (0_i64, 0_i64, 0_i64);
    let mut kept = Vec::new();
    let now = now_iso();
    for (entity, record_id, action, before) in records {
        let table = match entity.as_str() {
            "clients" | "suppliers" | "catalog_items" | "accounts" | "invoices" | "journal_entries" => entity.as_str(),
            _ => return Err(invalid("L'historique de cet import est illisible.")),
        };
        let current: Option<Value> = query_all(tx, &format!("SELECT * FROM {table} WHERE id=?"), [&record_id])?.into_iter().next();
        let Some(current) = current else {
            continue;
        };
        let name = label_of(&current);
        match (table, action.as_str()) {
            ("journal_entries", _) => {
                let already: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM journal_entries WHERE reversal_of=?)", [&record_id], |row| row.get(0))?;
                if !already {
                    let date = current["entry_date"].as_str().unwrap_or_default().to_owned();
                    reverse_journal_entry_tx(tx, &record_id, &date, Some(format!("Annulation de la reprise {label}")))?;
                    reversed += 1;
                }
            }
            ("invoices", _) => {
                if current["status"] == "annulee" {
                    continue;
                }
                let used = usages(tx, "invoices", &record_id, &["invoice_items", "invoice_qr_bills", "opening_receivables"])?;
                if !used.is_empty() {
                    kept.push(json!({"entity":table,"id":record_id,"name":name,"reason":"Déjà encaissée, rappelée ou liée à un autre document","used_in":used}));
                    continue;
                }
                let issue: Option<String> = tx
                    .query_row(
                        "SELECT e.id FROM journal_entries e WHERE e.source_type='invoice' AND e.source_id=? AND e.source_event='issue'
                           AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reversal_of=e.id)",
                        [&record_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(entry) = issue {
                    let date = current["issue_date"].as_str().unwrap_or_default().to_owned();
                    reverse_journal_entry_tx(tx, &entry, &date, Some(format!("Annulation de la reprise {label} {name}")))?;
                    reversed += 1;
                }
                tx.execute(
                    "INSERT INTO data_import_invoice_cancellations(invoice_id,import_id,created_at) VALUES(?,?,?)",
                    params![record_id, id, now],
                )?;
                tx.execute("UPDATE invoices SET status='annulee',updated_at=? WHERE id=?", params![now, record_id])?;
                append_audit(tx, "undo_import", "invoice", &record_id, &json!({"import_id":id,"status":"annulee"}))?;
                removed += 1;
            }
            ("catalog_items", "updated") => {
                let before: Value = serde_json::from_str(before.as_deref().unwrap_or("null"))?;
                let kind = before["kind"].as_str().unwrap_or_default();
                if current["track_stock"].as_i64() == Some(1) && kind != "product" {
                    kept.push(json!({"entity":table,"id":record_id,"name":name,"reason":"Suivi en stock depuis l’import : prix gardés"}));
                    continue;
                }
                tx.execute(
                    "UPDATE catalog_items SET kind=?,sku=?,name=?,description=?,unit=?,sales_price_cents=?,purchase_cost_cents=?,vat_bp=?,updated_at=? WHERE id=?",
                    params![
                        kind,
                        before["sku"].as_str(),
                        before["name"].as_str(),
                        before["description"].as_str(),
                        before["unit"].as_str(),
                        before["sales_price_cents"].as_i64(),
                        before["purchase_cost_cents"].as_i64(),
                        before["vat_bp"].as_i64(),
                        now,
                        record_id
                    ],
                )?;
                append_audit(tx, "undo_import", "catalog_item", &record_id, &json!({"import_id":id,"restored":before}))?;
                restored += 1;
            }
            _ => {
                let used = usages(tx, table, &record_id, &[])?;
                if !used.is_empty() {
                    kept.push(json!({"entity":table,"id":record_id,"name":name,"reason":"Déjà utilisée dans Zentra","used_in":used}));
                    continue;
                }
                tx.execute(&format!("DELETE FROM {table} WHERE id=?"), [&record_id])?;
                append_audit(tx, "delete", table, &record_id, &json!({"import_id":id,"previous":current}))?;
                removed += 1;
            }
        }
    }
    let report = json!({"removed":removed,"restored":restored,"reversed":reversed,"kept":kept});
    tx.execute(
        "UPDATE data_imports SET undone_at=?,undo_report_json=? WHERE id=?",
        params![now, serde_json::to_string(&report)?, id],
    )?;
    append_audit(tx, "undo", "data_import", id, &report)?;
    Ok(report)
}

#[tauri::command]
pub async fn import_migration_contacts(state: tauri::State<'_, LocalStore>, input: MigrationContactsInput, expected_workspace_scope: Option<String>) -> Result<Value, String> {
    run_scoped_local_operation(state.inner().clone(), expected_workspace_scope, move |store| {
        store.require_write_access().map_err(command_error)?;
        store.import_migration_contacts(input).map_err(command_error)
    })
    .await
}

#[tauri::command]
pub async fn import_migration_catalog(state: tauri::State<'_, LocalStore>, input: MigrationCatalogInput, expected_workspace_scope: Option<String>) -> Result<Value, String> {
    run_scoped_local_operation(state.inner().clone(), expected_workspace_scope, move |store| {
        store.require_write_access().map_err(command_error)?;
        store.import_migration_catalog(input).map_err(command_error)
    })
    .await
}

#[tauri::command]
pub async fn import_migration_accounts(state: tauri::State<'_, LocalStore>, input: MigrationAccountsInput, expected_workspace_scope: Option<String>) -> Result<Value, String> {
    run_scoped_local_operation(state.inner().clone(), expected_workspace_scope, move |store| {
        store.require_write_access().map_err(command_error)?;
        store.import_migration_accounts(input).map_err(command_error)
    })
    .await
}

#[tauri::command]
pub async fn import_migration_receivables(state: tauri::State<'_, LocalStore>, input: MigrationReceivablesInput, expected_workspace_scope: Option<String>) -> Result<Value, String> {
    run_scoped_local_operation(state.inner().clone(), expected_workspace_scope, move |store| {
        store.require_write_access().map_err(command_error)?;
        store.import_migration_receivables(input).map_err(command_error)
    })
    .await
}

#[tauri::command]
pub async fn import_migration_balance(state: tauri::State<'_, LocalStore>, input: MigrationBalanceInput, expected_workspace_scope: Option<String>) -> Result<Value, String> {
    run_scoped_local_operation(state.inner().clone(), expected_workspace_scope, move |store| {
        store.require_write_access().map_err(command_error)?;
        store.import_migration_balance(input).map_err(command_error)
    })
    .await
}

#[tauri::command]
pub async fn list_data_imports(state: tauri::State<'_, LocalStore>, expected_workspace_scope: Option<String>) -> Result<Value, String> {
    run_scoped_local_operation(state.inner().clone(), expected_workspace_scope, move |store| store.list_data_imports().map_err(command_error)).await
}

#[tauri::command]
pub async fn get_data_import_report(state: tauri::State<'_, LocalStore>, id: String, expected_workspace_scope: Option<String>) -> Result<Value, String> {
    run_scoped_local_operation(state.inner().clone(), expected_workspace_scope, move |store| store.get_data_import_report(&id).map_err(command_error)).await
}

#[tauri::command]
pub async fn undo_data_import(state: tauri::State<'_, LocalStore>, id: String, expected_workspace_scope: Option<String>) -> Result<Value, String> {
    run_scoped_local_operation(state.inner().clone(), expected_workspace_scope, move |store| {
        store.require_write_access().map_err(command_error)?;
        store.undo_data_import(&id).map_err(command_error)
    })
    .await
}

#[cfg(test)]
#[path = "data_imports_tests.rs"]
mod tests;
