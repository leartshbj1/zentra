//! Export trusted structural rules from a newly migrated database, never from
//! an uploaded client schema. CI detects drift before a server can validate it.
use super::*;
use crate::database::LocalStore;
use std::path::Path;

fn portable_sql(sql: String) -> String {
    sql.replace("\r\n", "\n").trim().to_owned()
}

fn schema_contract(connection: &Connection) -> AppResult<Value> {
    let mut tables = BTreeMap::new();
    for (name, rule) in policy()?.tables {
        let ddl: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            [&name],
            |row| row.get(0),
        )?;
        let columns = connection.prepare("SELECT cid,name,type,\"notnull\",dflt_value,pk FROM pragma_table_info(?) ORDER BY cid")?
            .query_map([&name], |row| Ok(json!({
                "name":row.get::<_,String>(1)?, "type":row.get::<_,String>(2)?,
                "not_null":row.get::<_,bool>(3)?, "default":row.get::<_,Option<String>>(4)?,
                "primary_key_position":row.get::<_,i64>(5)?,
            })))?.collect::<Result<Vec<_>,_>>()?;
        let foreign_keys = connection.prepare("SELECT id,seq,\"table\",\"from\",\"to\",on_update,on_delete,\"match\" FROM pragma_foreign_key_list(?) ORDER BY id,seq")?
            .query_map([&name], |row| Ok(json!({
                "id":row.get::<_,i64>(0)?, "sequence":row.get::<_,i64>(1)?,
                "table":row.get::<_,String>(2)?, "from":row.get::<_,String>(3)?,
                "to":row.get::<_,Option<String>>(4)?, "on_update":row.get::<_,String>(5)?,
                "on_delete":row.get::<_,String>(6)?, "match":row.get::<_,String>(7)?,
            })))?.collect::<Result<Vec<_>,_>>()?;
        let indexes = connection.prepare("SELECT name,origin,partial FROM pragma_index_list(?) WHERE \"unique\"=1 ORDER BY name")?
            .query_map([&name], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,bool>(2)?)))?
            .collect::<Result<Vec<_>,_>>()?;
        let mut unique = Vec::new();
        for (index, origin, partial) in indexes {
            let sql: Option<String> = connection.query_row(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
                [&index],
                |row| row.get(0),
            )?;
            let fields = connection.prepare("SELECT seqno,cid,name,\"desc\",coll FROM pragma_index_xinfo(?) WHERE \"key\"=1 ORDER BY seqno")?
                .query_map([&index], |row| Ok(json!({
                    "column_id":row.get::<_,i64>(1)?, "name":row.get::<_,Option<String>>(2)?,
                    "descending":row.get::<_,bool>(3)?, "collation":row.get::<_,String>(4)?,
                })))?.collect::<Result<Vec<_>,_>>()?;
            unique.push(json!({"name":index,"origin":origin,"partial":partial,"sql":sql.map(portable_sql),"fields":fields}));
        }
        assert_eq!(
            columns.len(),
            rule.columns.len() + rule.local_columns.len(),
            "{name}"
        );
        tables.insert(name, json!({"sql":portable_sql(ddl),"columns":columns,"foreign_keys":foreign_keys,"unique":unique}));
    }
    Ok(
        json!({"version":1,"schema_version":DATA_SCHEMA_VERSION,
        "protocol_sha256":super::snapshot::contract_hash()?,"tables":tables}),
    )
}

#[test]
fn structural_contract_matches_the_actual_migrated_database() {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    let connection = store.connect().unwrap();
    assert_eq!(
        connection.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(),
        crate::schema::SCHEMA_VERSION,
    );
    let generated = schema_contract(&connection).unwrap();
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/business_sync_schema.json");
    let expected: Value = serde_json::from_slice(
        &std::fs::read(path)
            .expect("Generate the checked schema contract explicitly before validating it"),
    )
    .unwrap();
    assert_eq!(
        generated, expected,
        "Regenerate and review every structural rule when the native schema changes"
    );
}

#[test]
#[ignore = "Explicit generation of the trusted native structural schema; review its diff"]
fn export_trusted_structural_schema() {
    let output = std::env::var("ZENTRA_SYNC_SCHEMA_OUTPUT")
        .expect("Choose an explicit absolute schema output path");
    assert!(Path::new(&output).is_absolute());
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    let generated = schema_contract(&store.connect().unwrap()).unwrap();
    let mut bytes = serde_json::to_vec_pretty(&generated).unwrap();
    bytes.push(b'\n');
    std::fs::write(output, bytes).unwrap();
}
