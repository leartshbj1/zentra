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


fn interface_workspace_fixture() -> (tempfile::TempDir, LocalStore) {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store.complete_onboarding(crate::tests::test_onboarding(), "1.0.0").unwrap();
    store.install_swiss_accounting_starter().unwrap();
    store.create_record("clients", json!({"name":"Client projection"})).unwrap();
    let connection = store.connect().unwrap();
    let debit: String = connection.query_row("SELECT id FROM accounts WHERE code='1020'", [], |r| r.get(0)).unwrap();
    let credit: String = connection.query_row("SELECT id FROM accounts WHERE code='3200'", [], |r| r.get(0)).unwrap();
    drop(connection);
    store.post_manual_journal_entry(serde_json::from_value(json!({
        "entry_date":"2026-09-04", "description":"Journal conservé", "currency":"CHF",
        "lines":[
            {"account_id":debit,"debit_cents":10000,"credit_cents":0},
            {"account_id":credit,"debit_cents":0,"credit_cents":10000}
        ]
    })).unwrap()).unwrap();
    (temporary, store)
}

fn without_bulk_journals(mut workspace: Value) -> Value {
    let object = workspace.as_object_mut().unwrap();
    assert!(object.remove("journal_entries").is_some());
    assert!(object.remove("journal_lines").is_some());
    workspace
}

#[test]
fn interface_workspace_preserves_every_other_field_and_journal_views() {
    let (_temporary, store) = interface_workspace_fixture();
    let complete = store.get_workspace().unwrap();
    assert_eq!(complete["journal_entries"].as_array().unwrap().len(), 1);
    assert_eq!(complete["journal_lines"].as_array().unwrap().len(), 2);
    assert_eq!(complete["clients"].as_array().unwrap().len(), 1);
    let journal = store.get_journal(crate::models::PeriodFilter::default()).unwrap();
    let interface = store.get_interface_workspace().unwrap();
    assert_eq!(interface, without_bulk_journals(complete.clone()));
    assert_eq!(store.get_workspace().unwrap(), complete);
    assert_eq!(store.get_journal(crate::models::PeriodFilter::default()).unwrap(), journal);
    assert_eq!(journal["entries"].as_array().unwrap().len(), 1);
    assert_eq!(journal["lines"].as_array().unwrap().len(), 2);
}

#[test]
fn interface_workspace_onboarding_scopes_keep_complete_internal_results() {
    let (_temporary, store) = interface_workspace_fixture();
    for scope in [OnboardingValidationScope::Essential, OnboardingValidationScope::Complete] {
        let result = store.complete_onboarding_for_interface(
            crate::tests::test_onboarding(), "1.0.0", scope,
        ).unwrap();
        assert!(result.app_state.onboarding_completed);
        assert_eq!(result.workspace, without_bulk_journals(store.get_workspace().unwrap()));
    }
    let complete = store.complete_onboarding(crate::tests::test_onboarding(), "1.0.0").unwrap();
    assert_eq!(complete.workspace["journal_entries"].as_array().unwrap().len(), 1);
    assert_eq!(complete.workspace["journal_lines"].as_array().unwrap().len(), 2);
}

#[test]
fn interface_workspace_does_not_reduce_exports_backups_or_collaboration_archives() {
    use std::io::Read;
    let (temporary, store) = interface_workspace_fixture();
    let complete = store.get_workspace().unwrap();
    assert_eq!(store.get_interface_workspace().unwrap(), without_bulk_journals(complete.clone()));
    let exported = store.export_json(
        Some(temporary.path().join("complete.json").to_string_lossy().into_owned()), "1.0.0",
    ).unwrap();
    let exported: Value = serde_json::from_slice(&fs::read(exported).unwrap()).unwrap();
    for key in ["journal_entries", "journal_lines"] {
        assert_eq!(exported["data"][key], complete[key]);
    }
    let csv = store.export_csv_archive(
        Some(temporary.path().join("complete.zip").to_string_lossy().into_owned()), "1.0.0",
    ).unwrap();
    let mut csv = zip::ZipArchive::new(fs::File::open(csv).unwrap()).unwrap();
    for (entry, key) in [("05_comptabilite/journal.csv", "journal_entries"),
                         ("05_comptabilite/lignes_journal.csv", "journal_lines")] {
        let mut text = String::new();
        csv.by_name(entry).unwrap().read_to_string(&mut text).unwrap();
        for row in complete[key].as_array().unwrap() {
            assert!(text.contains(row["id"].as_str().unwrap()), "missing journal row in {entry}");
        }
    }
    let backup_path = store.create_backup(
        Some(temporary.path().join("complete.zentra").to_string_lossy().into_owned()), "1.0.0",
    ).unwrap();
    let collaboration_path = temporary.path().join("collaboration.zentra");
    // This is the same archive entry point used by company_collaboration.
    store.create_backup_at(&collaboration_path, "1.0.0").unwrap();
    for (index, archive_path) in [PathBuf::from(backup_path), collaboration_path].iter().enumerate() {
        let mut archive = zip::ZipArchive::new(fs::File::open(archive_path).unwrap()).unwrap();
        let database_path = temporary.path().join(format!("archive-{index}.sqlite3"));
        let mut database_file = fs::File::create(&database_path).unwrap();
        std::io::copy(&mut archive.by_name("database.sqlite3").unwrap(), &mut database_file).unwrap();
        drop(database_file);
        let connection = Connection::open_with_flags(database_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let entries = query_all(&connection, "SELECT * FROM journal_entries ORDER BY entry_date,number", []).unwrap();
        let lines = query_all(&connection, "SELECT * FROM journal_lines ORDER BY journal_entry_id,rowid", []).unwrap();
        assert_eq!(Value::Array(entries), complete["journal_entries"]);
        assert_eq!(Value::Array(lines), complete["journal_lines"]);
        let balance: i64 = connection.query_row("SELECT SUM(debit_cents-credit_cents) FROM journal_lines", [], |r| r.get(0)).unwrap();
        assert_eq!(balance, 0);
    }
}


#[test]
#[ignore = "Requires the explicitly generated synthetic volume profile"]
fn profile_synthetic_interface_workspace_volume() {
    let data_dir = PathBuf::from(std::env::var("ZENTRA_VOLUME_PROFILE").expect("synthetic fixture path"));
    let marker: Value = serde_json::from_slice(&fs::read(data_dir.parent().unwrap().join("fixture.json")).unwrap()).unwrap();
    assert_eq!(marker["synthetic"], true);
    let check = Connection::open_with_flags(data_dir.join("helvichantier.sqlite3"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let name: String = check.query_row("SELECT company_name FROM settings", [], |r| r.get(0)).unwrap();
    assert_eq!(name, "Atelier Recette 1905");
    drop(check);
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
    // Warm both projections. Alternate their order to avoid giving the lighter
    // projection a systematic page-cache/allocator advantage. Same connection,
    // instance, source and optimized binary; no inference about cold UI startup.
    for scope in [WorkspaceReadScope::Complete, WorkspaceReadScope::Interface] {
        drop(store.workspace_from_connection_scoped(&connection, scope).unwrap());
    }
    let mut measurements = Vec::new();
    for pass in 0..3 {
        let scopes = if pass % 2 == 0 {
            [WorkspaceReadScope::Complete, WorkspaceReadScope::Interface]
        } else {
            [WorkspaceReadScope::Interface, WorkspaceReadScope::Complete]
        };
        let mut full = None;
        let mut interface = None;
        for (position, scope) in scopes.into_iter().enumerate() {
            let start = Instant::now();
            let workspace = store.workspace_from_connection_scoped(&connection, scope).unwrap();
            let read_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let serialized = serde_json::to_vec(&workspace).unwrap();
            let serialize_ms = start.elapsed().as_secs_f64() * 1000.0;
            let bytes = serialized.len();
            drop(serialized);
            assert_eq!(workspace["invoices"].as_array().unwrap().len(), marker["counts"]["invoices"].as_u64().unwrap() as usize);
            measurements.push(json!({"pass":pass+1,"position":position+1,
                "scope":if scope == WorkspaceReadScope::Complete {"complete"} else {"interface"},
                "readMs":read_ms,"serializeMs":serialize_ms,"bytes":bytes}));
            if scope == WorkspaceReadScope::Complete { full = Some(workspace); }
            else { interface = Some(workspace); }
        }
        // Full structural equality of every retained value, outside timing.
        assert_eq!(interface.unwrap(), without_bulk_journals(full.unwrap()));
    }
    println!("VOLUME_INTERFACE_PROFILE {}", json!({"sameConnection":true,"alternatingOrder":true,"allRetainedValuesEqual":true,"runs":measurements}));
}
