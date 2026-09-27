//! Explicit, read-only profiling of the synthetic historical workspace.
//! Never use a customer profile. The fixture marker and name are mandatory.
use super::*;
use std::time::Instant;

#[test]
#[ignore = "Requires the explicitly generated synthetic volume profile"]
fn profile_synthetic_workspace_volume() {
    let data_dir = PathBuf::from(std::env::var("ZENTRA_VOLUME_PROFILE").expect("synthetic fixture path"));
    let marker: Value = serde_json::from_slice(&fs::read(data_dir.parent().unwrap().join("fixture.json")).unwrap()).unwrap();
    assert_eq!(marker["synthetic"], true);
    let check = Connection::open_with_flags(data_dir.join("helvichantier.sqlite3"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let name: String = check.query_row("SELECT company_name FROM settings", [], |r| r.get(0)).unwrap();
    assert_eq!(name, "Atelier Recette 1905");
    let store = LocalStore {
        database_path: data_dir.join("helvichantier.sqlite3"),
        attachments_dir: data_dir.join("attachments"),
        backups_dir: data_dir.join("backups"),
        exports_dir: data_dir.join("exports"),
        data_dir,
        installation_id: "synthetic-volume-read-only".into(),
        account_protected_cache: AccountProtectedCache::default(),
        license_protected_cache: LicenseProtectedCache::default(),
        operation_lock: Arc::new(Mutex::new(())),
    };
    let connection = store.connect().unwrap();
    connection.pragma_update(None, "query_only", "ON").unwrap();
    let mut times = Vec::new();
    for table in ["quote_items", "invoice_items", "journal_lines", "invoices", "quotes"] {
        let start = Instant::now();
        let rows = query_all(&connection, &format!("SELECT * FROM {table}"), []).unwrap();
        times.push(json!({"phase":table,"rows":rows.len(),"ms":start.elapsed().as_secs_f64()*1000.0}));
    }
    let start = Instant::now();
    let workspace = store.workspace_from_connection(&connection).unwrap();
    times.push(json!({"phase":"workspace","ms":start.elapsed().as_secs_f64()*1000.0}));
    let start = Instant::now();
    let serialized = serde_json::to_string(&workspace).unwrap();
    times.push(json!({"phase":"serialize","ms":start.elapsed().as_secs_f64()*1000.0,"bytes":serialized.len()}));
    assert_eq!(workspace["invoices"].as_array().unwrap().len(), marker["counts"]["invoices"].as_u64().unwrap() as usize);
    let copied: Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(workspace, copied);
    println!("VOLUME_PROFILE {}", json!(times));
}
