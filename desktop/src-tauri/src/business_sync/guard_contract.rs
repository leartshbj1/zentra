//! Trusted native guards and their actual SQLite read dependencies.
//! This catalog is generated from a fresh profile, never from an upload.
use super::*;
use crate::database::LocalStore;
use regex::Regex;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use std::path::Path;

fn catalog(connection: &Connection, after: bool) -> Value {
    let policy = policy().unwrap();
    let view_parser =
        Regex::new(r"(?is)^CREATE VIEW(?: IF NOT EXISTS)? (\w+)\s+AS\s+(.*)$").unwrap();
    let views = connection
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='view' ORDER BY name")
        .unwrap()
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .unwrap()
        .map(|row| {
            let (name, sql) = row.unwrap();
            let sql = sql.replace("\r\n", "\n");
            let parsed = view_parser
                .captures(&sql)
                .unwrap_or_else(|| panic!("Unclassified view {name}"));
            (name, parsed[2].to_owned())
        })
        .collect::<BTreeMap<_, _>>();
    let timing = if after { "AFTER" } else { "BEFORE" };
    let header = Regex::new(&format!(
        r"(?is)^CREATE TRIGGER(?: IF NOT EXISTS)? \w+\s+{timing}\s+"
    ))
    .unwrap();
    let parser = Regex::new(&format!(r"(?is)^CREATE TRIGGER(?: IF NOT EXISTS)? (\w+)\s+{timing} (INSERT|UPDATE|DELETE)(?: OF ([\w,\s]+))? ON (\w+)\s+(?:WHEN\s+(.*?)\s+)?BEGIN\s+SELECT RAISE\(ABORT\s*,\s*'((?:[^']|'')*)'\);\s*END\s*;?$")).unwrap();
    // These triggers write additional rows. Keep their exact SQL in the
    // catalog for replay review; never silently classify them as pure guards.
    let effect_names = [
        "bank_expense_register",
        "employees_small_salary_decision_insert_history",
        "employees_small_salary_decision_update_history",
        "project_document_queue_delete",
        "project_document_queue_insert",
        "stock_movements_apply_balance",
        "supplier_credit_allocations_apply_after_insert",
        "supplier_credit_allocations_apply_invoice_total",
        "supplier_payments_update_invoice_total",
    ];
    let image = Regex::new(r"(?i)\b(OLD|NEW)\.(\w+)\b").unwrap();
    let rows = connection.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name").unwrap()
        .query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).unwrap()
        .collect::<Result<Vec<_>,_>>().unwrap();
    let mut guards = Vec::new();
    let mut effects = Vec::new();
    for (name, table, sql) in rows {
        if !policy.tables.contains_key(&table) || !header.is_match(&sql) {
            continue;
        }
        let sql = sql.replace("\r\n", "\n");
        if after && effect_names.contains(&name.as_str()) {
            effects.push(json!({"name":name,"table":table,"sql":sql}));
            continue;
        }
        let parsed = parser
            .captures(&sql)
            .unwrap_or_else(|| panic!("Unclassified native guard {name}: {sql}"));
        assert_eq!(parsed.get(1).unwrap().as_str(), name);
        assert_eq!(parsed.get(4).unwrap().as_str(), table);
        let columns: Vec<_> = parsed
            .get(3)
            .map(|m| m.as_str().split(',').map(str::trim).collect())
            .unwrap_or_default();
        let condition = parsed.get(5).map(|m| m.as_str()).unwrap_or("1");
        let inspected = image.replace_all(condition, |m: &regex::Captures<'_>| {
            let field = &m[2];
            let rule = &policy.tables[&table];
            assert!(
                field == "rowid"
                    || rule
                        .columns
                        .iter()
                        .chain(&rule.local_columns)
                        .any(|c| c == field),
                "{name}: unknown image column {field}"
            );
            format!(
                "json_extract(?{},'$.{field}')",
                if m[1].eq_ignore_ascii_case("OLD") {
                    1
                } else {
                    2
                }
            )
        });
        let reads = Arc::new(Mutex::new(BTreeMap::<String, BTreeSet<String>>::new()));
        let functions = Arc::new(Mutex::new(BTreeSet::<String>::new()));
        let observed_reads = reads.clone();
        let observed_functions = functions.clone();
        connection.authorizer(Some(move |ctx: AuthContext<'_>| {
            match ctx.action {
                AuthAction::Read {
                    table_name,
                    column_name,
                } => {
                    observed_reads
                        .lock()
                        .unwrap()
                        .entry(table_name.into())
                        .or_default()
                        .insert(column_name.into());
                }
                AuthAction::Function { function_name } => {
                    observed_functions
                        .lock()
                        .unwrap()
                        .insert(function_name.into());
                }
                _ => {}
            }
            Authorization::Allow
        }));
        let inspection = connection.prepare(&format!("SELECT ({inspected})"));
        connection.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        drop(inspection.unwrap_or_else(|e| panic!("Cannot compile guard {name}: {e}")));
        let reads = reads
            .lock()
            .unwrap()
            .clone()
            .into_iter()
            .filter_map(|(table, mut columns)| {
                // SQLite may report its JSON table-valued function as a read.
                if matches!(table.as_str(), "json_each" | "json_tree") {
                    return None;
                }
                columns.remove(""); // COUNT(*) still records the table with no fields.
                if views.contains_key(&table) {
                    return Some((table, columns));
                }
                if policy.local_tables.contains_key(&table) {
                    // Local receiver guards remain explicit in the contract;
                    // the server must never invent another device's timers.
                    return Some((table, columns));
                }
                let rule = policy
                    .tables
                    .get(&table)
                    .unwrap_or_else(|| panic!("{name} reads unclassified table {table}"));
                for field in &columns {
                    assert!(
                        field == "ROWID"
                            || rule
                                .columns
                                .iter()
                                .chain(&rule.local_columns)
                                .any(|c| c == field),
                        "{name}: unknown read {table}.{field}"
                    );
                }
                Some((table, columns))
            })
            .collect::<BTreeMap<_, _>>();
        let local_reads = reads
            .keys()
            .filter(|t| policy.local_tables.contains_key(*t))
            .cloned()
            .collect::<Vec<_>>();
        guards.push(json!({"name":name,"table":table,"operation":parsed[2].to_ascii_lowercase(),"update_columns":columns,
            "condition":condition,"message":parsed[6].replace("''","'"),"reads":reads,"local_reads":local_reads,"functions":functions.lock().unwrap().clone()}));
    }
    let views = views
        .into_iter()
        .filter(|(name, _)| guards.iter().any(|g| g["reads"].get(name).is_some()))
        .collect::<BTreeMap<_, _>>();
    let mut result = json!({"version":1,"native_schema_version":crate::schema::SCHEMA_VERSION,"data_schema_version":DATA_SCHEMA_VERSION,"guards":guards,"views":views});
    if after {
        assert_eq!(effects.len(), effect_names.len());
        result["effects"] = json!(effects);
    }
    result
}

#[test]
fn native_guard_catalog_matches_every_current_shared_before_trigger() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    let mut actual = catalog(&store.connect().unwrap(), false);
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/business_sync_guards.json");
    let expected: Value = serde_json::from_slice(
        &std::fs::read(path).expect("Generate and review the trusted native guard catalog"),
    )
    .unwrap();
    preserve_catalog_producer_version(&mut actual, &expected);
    assert_eq!(
        actual, expected,
        "Review every native protection change before the server accepts it"
    );
}

#[test]
#[ignore = "Explicit export of native protections and SQLite-derived dependencies; review before use"]
fn export_trusted_native_guards() {
    let output = std::env::var("ZENTRA_NATIVE_GUARDS_OUTPUT")
        .expect("Choose an explicit absolute output path");
    assert!(Path::new(&output).is_absolute());
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    let actual = catalog(&store.connect().unwrap(), false);
    let mut bytes = serde_json::to_vec_pretty(&actual).unwrap();
    bytes.push(b'\n');
    std::fs::write(output, bytes).unwrap();
}

#[test]
fn native_after_catalog_covers_guards_and_explicit_row_effects() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    let mut actual = catalog(&store.connect().unwrap(), true);
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/business_sync_after_guards.json");
    let expected: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    preserve_catalog_producer_version(&mut actual, &expected);
    assert_eq!(
        actual, expected,
        "Review every native AFTER protection and row effect"
    );
}

fn preserve_catalog_producer_version(actual: &mut Value, expected: &Value) {
    // This field identifies the native version that originally exported the
    // catalogue. A local-only migration (V62 installation receipts) must not
    // change the shared validator hash or invalidate prepared V60 transactions.
    // Every guard, dependency, view, row effect and the data format still match
    // exactly below. A real protection change therefore still fails the test.
    assert_eq!(actual["native_schema_version"], crate::schema::SCHEMA_VERSION);
    let producer=expected["native_schema_version"].as_i64().unwrap();
    assert!((i64::from(DATA_SCHEMA_VERSION)..=crate::schema::SCHEMA_VERSION).contains(&producer));
    actual["native_schema_version"]=json!(producer);
}

#[test]
#[ignore = "Explicit export of native AFTER protections and row effects; review before use"]
fn export_trusted_native_after_guards() {
    let output = std::env::var("ZENTRA_NATIVE_AFTER_GUARDS_OUTPUT")
        .expect("Choose an explicit absolute output path");
    assert!(Path::new(&output).is_absolute());
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    let actual = catalog(&store.connect().unwrap(), true);
    let mut bytes = serde_json::to_vec_pretty(&actual).unwrap();
    bytes.push(b'\n');
    std::fs::write(output, bytes).unwrap();
}
