use super::{DiagnosticArea, DiagnosticLog, DiagnosticPhase, DiagnosticRecord, StartupOperation};
use crate::{error::AppError, initialize_local_store_with_diagnostics, initialize_profile_diagnostics};
use std::fs;

fn records(log: &DiagnosticLog) -> Vec<DiagnosticRecord> {
    let _guard = log.0.operation_lock.lock().unwrap();
    log.records().unwrap().0
}

fn assert_original_sqlite_failure(error: &AppError) {
    match error {
        AppError::Database(error) => {
            assert_eq!(error.sqlite_error_code(), Some(rusqlite::ErrorCode::NotADatabase));
        }
        _ => panic!("expected the original SQLite failure variant"),
    }
}

#[test]
fn invalid_sqlite_keeps_original_error_and_records_only_fixed_startup_fields() {
    let temporary = tempfile::tempdir().unwrap();
    let data_dir = temporary.path().join("PRIVATE_PROFILE_SENTINEL");
    let log = initialize_profile_diagnostics(&data_dir).unwrap();
    fs::write(data_dir.join("helvichantier.sqlite3"), b"PRIVATE_DATABASE_SENTINEL: not SQLite").unwrap();

    let error = initialize_local_store_with_diagnostics(data_dir, &log).err().unwrap();
    assert_original_sqlite_failure(&error);
    let records = records(&log);
    let failures: Vec<_> = records.iter().filter(|record|
        record.event.operation == "app.local_store.initialize"
        && record.event.phase == DiagnosticPhase::Failure).collect();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].event.area, DiagnosticArea::App);
    assert_eq!(failures[0].event.error_code.as_deref(), Some("STORAGE"));
    let event = serde_json::to_value(&failures[0].event).unwrap();
    let allowed = ["id", "sessionId", "timestamp", "area", "operation", "phase", "errorCode"];
    assert_eq!(event.as_object().unwrap().len(), allowed.len());
    assert!(event.as_object().unwrap().keys().all(|key| allowed.contains(&key.as_str())));
    let serialized = serde_json::to_string(&records).unwrap();
    assert!(!serialized.contains("PRIVATE_"));
    assert!(!serialized.contains("helvichantier.sqlite3"));
    assert!(!serialized.contains("not a database"));
}

#[test]
fn successful_local_store_retains_start_record_and_current_schema() {
    let temporary = tempfile::tempdir().unwrap();
    let data_dir = temporary.path().join("profile");
    let log = initialize_profile_diagnostics(&data_dir).unwrap();
    let store = initialize_local_store_with_diagnostics(data_dir, &log).unwrap();
    let version: i64 = store.connect().unwrap()
        .pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert_eq!(version, crate::schema::SCHEMA_VERSION);
    let records = records(&log);
    assert!(records.iter().any(|record| record.event.operation == "app.start"
        && record.event.phase == DiagnosticPhase::Info));
    assert!(!records.iter().any(|record| record.event.operation == "app.local_store.initialize"
        && record.event.phase == DiagnosticPhase::Failure));
}

#[test]
fn unavailable_journal_does_not_replace_real_sqlite_failure() {
    let temporary = tempfile::tempdir().unwrap();
    let data_dir = temporary.path();
    fs::write(data_dir.join("diagnostics"), b"blocked journal").unwrap();
    fs::write(data_dir.join("helvichantier.sqlite3"), b"not a SQLite database").unwrap();
    let log = initialize_profile_diagnostics(data_dir).unwrap();
    let error = initialize_local_store_with_diagnostics(data_dir.to_owned(), &log).err().unwrap();
    assert_original_sqlite_failure(&error);
    assert_eq!(fs::read(data_dir.join("diagnostics")).unwrap().as_slice(), b"blocked journal");
}

#[test]
fn unavailable_journal_does_not_block_successful_local_store() {
    let temporary = tempfile::tempdir().unwrap();
    let data_dir = temporary.path();
    fs::write(data_dir.join("diagnostics"), b"blocked journal").unwrap();
    let log = initialize_profile_diagnostics(data_dir).unwrap();
    let store = initialize_local_store_with_diagnostics(data_dir.to_owned(), &log).unwrap();
    assert!(store.database_path.is_file());
    assert_eq!(fs::read(data_dir.join("diagnostics")).unwrap().as_slice(), b"blocked journal");
}

#[test]
fn updater_failure_has_a_separate_fixed_phase_and_code() {
    let temporary = tempfile::tempdir().unwrap();
    let log = initialize_profile_diagnostics(temporary.path()).unwrap();
    log.record_startup_failure(StartupOperation::Updater);
    let records = records(&log);
    let failures: Vec<_> = records.iter().filter(|record|
        record.event.operation == "app.updater.initialize"
        && record.event.phase == DiagnosticPhase::Failure).collect();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].event.area, DiagnosticArea::App);
    assert_eq!(failures[0].event.error_code.as_deref(), Some("INTERNAL"));
}

#[test]
fn refused_profile_directory_preserves_error_before_journal_admission() {
    let temporary = tempfile::tempdir().unwrap();
    let data_dir = temporary.path().join("existing-file");
    fs::write(&data_dir, b"leave original file intact").unwrap();
    let error = initialize_profile_diagnostics(&data_dir).err().unwrap();
    assert!(matches!(error, AppError::Io(_)));
    assert_eq!(fs::read(&data_dir).unwrap().as_slice(), b"leave original file intact");
    assert!(!temporary.path().join("diagnostics").exists());
}
