//! Recovery-only startup admission. No profile or cause is exposed by this state.
use crate::{
    database::{LocalStore, StoreInitializationError},
    diagnostics::{DiagnosticLog, StartupOperation},
    error::AppResult,
};
use std::path::PathBuf;
use tauri::{Manager, Runtime};

pub(crate) const PUBLIC_REFUSAL: &str = "ZT-STARTUP-RECOVERY-REQUIRED";

pub(crate) struct StartupRecoveryFailure;

pub(crate) fn readiness<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<bool, String> {
    if app.try_state::<StartupRecoveryFailure>().is_some() {
        return Err(PUBLIC_REFUSAL.into());
    }
    Ok(app.try_state::<LocalStore>().is_some())
}

pub(crate) fn initialize_store<R: Runtime>(
    app: &tauri::AppHandle<R>,
    data_dir: PathBuf,
    log: &DiagnosticLog,
) -> AppResult<Option<LocalStore>> {
    admit_initialization(app, LocalStore::initialize_for_startup(data_dir), log)
}

fn admit_initialization<R: Runtime>(
    app: &tauri::AppHandle<R>,
    result: Result<LocalStore, StoreInitializationError>,
    log: &DiagnosticLog,
) -> AppResult<Option<LocalStore>> {
    match result {
        Ok(store) => Ok(Some(store)),
        Err(StoreInitializationError::Recovery(_)) => {
            log.record_startup_failure(StartupOperation::LocalStore);
            app.manage(StartupRecoveryFailure);
            Ok(None)
        }
        Err(StoreInitializationError::Other(error)) => {
            log.record_startup_failure(StartupOperation::LocalStore);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::recovery_crash_tests::{fixture, assert_profile, auxiliary_fixture, assert_auxiliary};
    use crate::error::AppError;
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::{collections::BTreeMap, fs, path::Path};

    const AUXILIARY: &[&str] = &[
        "company-collaboration.json", "company-sync-baseline.json",
        "company-sync-reference.zentra", "cloud-backup-state.json",
        "backup-status.json", "joined-company-copy.json",
    ];

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap()
    }

    fn journal(store: &LocalStore, phase: &str) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        let saved = store.data_dir.join(format!(".restore-state-{token}"));
        fs::create_dir(&saved).unwrap();
        let auxiliary: Vec<Value> = AUXILIARY.iter().map(|name| {
            let active = store.data_dir.join(name);
            if active.is_file() {
                let bytes = fs::read(&active).unwrap();
                fs::write(saved.join(name), &bytes).unwrap();
                json!({"name":name,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes))})
            } else { json!({"name":name,"bytes":null,"sha256":null}) }
        }).collect();
        fs::write(store.data_dir.join(".zentra-restore-journal.json"), serde_json::to_vec(&json!({
            "format":"zentra-local-restore","version":1,"token":token,"phase":phase,
            "complete_archive":true,"auxiliary":auxiliary,
        })).unwrap()).unwrap();
        token
    }

    fn fingerprints(root: &Path) -> BTreeMap<String, (u64, String)> {
        walkdir::WalkDir::new(root).into_iter().map(Result::unwrap)
            .filter(|entry| entry.file_type().is_file())
            .filter_map(|entry| {
                let relative = entry.path().strip_prefix(root).unwrap();
                // Only the already-managed, safe diagnostic log may change.
                if relative.starts_with("diagnostics") { return None; }
                let bytes = fs::read(entry.path()).unwrap();
                Some((relative.to_string_lossy().into_owned(), (bytes.len() as u64, format!("{:x}",Sha256::digest(bytes)))))
            }).collect()
    }

    fn copy_tree(source: &Path, destination: &Path) {
        for entry in walkdir::WalkDir::new(source) {
            let entry = entry.unwrap();
            let target = destination.join(entry.path().strip_prefix(source).unwrap());
            if entry.file_type().is_dir() { fs::create_dir_all(target).unwrap(); }
            else { assert!(entry.file_type().is_file()); fs::copy(entry.path(), target).unwrap(); }
        }
    }

    fn assert_refused(app: &tauri::App<tauri::test::MockRuntime>) {
        assert!(app.try_state::<LocalStore>().is_none());
        assert!(app.try_state::<StartupRecoveryFailure>().is_some());
        assert_eq!(readiness(app.handle()), Err(PUBLIC_REFUSAL.into()));
    }

    fn assert_primary_diagnostic(root: &Path) {
        let text = fs::read_to_string(root.join("diagnostics/events.jsonl")).unwrap();
        let records: Vec<Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        let failures: Vec<_> = records.iter().filter(|record|
            record["event"]["operation"] == "app.local_store.initialize"
            && record["event"]["phase"] == "failure").collect();
        assert!(!failures.is_empty());
        for record in failures { assert_eq!(record["event"]["errorCode"], "STORAGE"); }
        assert!(!text.contains("PRIVATE_SENTINEL"));
        assert!(!text.contains(PUBLIC_REFUSAL));
    }

    fn error(kind: usize) -> AppError {
        match kind {
            0 => AppError::Database(rusqlite::Error::InvalidQuery),
            1 => AppError::Io(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "PRIVATE_SENTINEL")),
            2 => AppError::Json(serde_json::from_str::<Value>("{").unwrap_err()),
            3 => AppError::Pdf(lopdf::Error::DictKey("PRIVATE_SENTINEL".into())),
            4 => AppError::Archive(zip::result::ZipError::FileNotFound),
            5 => AppError::Validation("PRIVATE_SENTINEL".into()),
            6 => AppError::Restore("PRIVATE_SENTINEL".into()),
            7 => AppError::Remote("PRIVATE_SENTINEL".into()),
            8 => AppError::NotFound("PRIVATE_SENTINEL".into()),
            9 => AppError::OnboardingRequired,
            10 => AppError::UnsafePath("PRIVATE_SENTINEL".into()),
            11 => AppError::UnsupportedPlatform,
            _ => unreachable!(),
        }
    }

    #[test]
    fn exact_origin_captures_every_variant_and_preserves_other_errors() {
        let temporary = tempfile::tempdir().unwrap();
        let log = crate::initialize_profile_diagnostics(temporary.path()).unwrap();
        for kind in 0..12 {
            let recovery_app = app();
            assert!(admit_initialization(recovery_app.handle(), Err(StoreInitializationError::Recovery(error(kind))), &log).unwrap().is_none());
            assert_refused(&recovery_app);
            let other_app = app();
            let original = error(kind);
            let expected_kind = std::mem::discriminant(&original);
            let expected_message = original.to_string();
            let actual = admit_initialization(other_app.handle(), Err(StoreInitializationError::Other(original)), &log).unwrap_err();
            assert_eq!(std::mem::discriminant(&actual), expected_kind);
            assert_eq!(actual.to_string(), expected_message);
            assert!(other_app.try_state::<StartupRecoveryFailure>().is_none());
            assert_eq!(readiness(other_app.handle()), Ok(false));
        }
        assert_primary_diagnostic(temporary.path());
    }

    #[test]
    fn no_journal_happy_bool_and_refusal_priority_with_artificial_store() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime = app();
        assert_eq!(serde_json::to_value(readiness(runtime.handle()).unwrap()).unwrap(), json!(false));
        let log = crate::initialize_profile_diagnostics(temporary.path()).unwrap();
        runtime.manage(log.clone());
        let store = initialize_store(runtime.handle(), temporary.path().into(), &log).unwrap().unwrap();
        assert!(runtime.try_state::<LocalStore>().is_none());
        runtime.manage(store);
        assert_eq!(serde_json::to_value(readiness(runtime.handle()).unwrap()).unwrap(), json!(true));
        runtime.manage(StartupRecoveryFailure);
        assert_eq!(readiness(runtime.handle()), Err(PUBLIC_REFUSAL.into()));
        assert!(runtime.try_state::<DiagnosticLog>().is_some());
    }

    #[test]
    fn invalid_journal_refuses_before_business_directories_identity_or_migration() {
        let temporary = tempfile::tempdir().unwrap();
        fs::write(temporary.path().join(".zentra-restore-journal.json"), b"PRIVATE_SENTINEL malformed").unwrap();
        let before = fingerprints(temporary.path());
        let runtime = app();
        let log = crate::initialize_profile_diagnostics(temporary.path()).unwrap();
        runtime.manage(log.clone());
        assert!(initialize_store(runtime.handle(), temporary.path().into(), &log).unwrap().is_none());
        assert_refused(&runtime);
        assert_eq!(before, fingerprints(temporary.path()));
        for name in ["attachments", "backups", "exports", "helvichantier.sqlite3", "installation.json"] {
            assert!(!temporary.path().join(name).exists());
        }
        assert_primary_diagnostic(temporary.path());
    }

    #[test]
    fn historical_hidden_profile_without_journal_never_creates_an_empty_company() {
        let temporary = tempfile::tempdir().unwrap();
        let old = temporary.path().join(format!(".before-restore-{}.sqlite3", uuid::Uuid::new_v4()));
        fs::write(&old, b"PRIVATE_SENTINEL historical company").unwrap();
        let before = fingerprints(temporary.path());
        assert!(matches!(LocalStore::initialize_for_startup(temporary.path().into()), Err(StoreInitializationError::Recovery(AppError::Restore(_)))));
        let runtime = app();
        let log = crate::initialize_profile_diagnostics(temporary.path()).unwrap();
        assert!(initialize_store(runtime.handle(), temporary.path().into(), &log).unwrap().is_none());
        assert_refused(&runtime);
        assert_eq!(before, fingerprints(temporary.path()));
        assert!(!temporary.path().join("helvichantier.sqlite3").exists());
    }

    #[test]
    fn directory_and_post_recovery_database_failures_keep_historical_errors() {
        let temporary = tempfile::tempdir().unwrap();
        let not_directory = temporary.path().join("file");
        fs::write(&not_directory, b"PRIVATE_SENTINEL").unwrap();
        assert!(matches!(LocalStore::initialize_for_startup(not_directory.clone()), Err(StoreInitializationError::Other(AppError::Io(_)))));
        assert!(matches!(LocalStore::initialize(not_directory), Err(AppError::Io(_))));
        let profile = temporary.path().join("profile");
        fs::create_dir(&profile).unwrap();
        fs::write(profile.join("helvichantier.sqlite3"), b"PRIVATE_SENTINEL not SQLite").unwrap();
        assert!(matches!(LocalStore::initialize_for_startup(profile.clone()), Err(StoreInitializationError::Other(AppError::Database(_)))));
        let runtime = app();
        let log = crate::initialize_profile_diagnostics(&profile).unwrap();
        assert!(matches!(initialize_store(runtime.handle(), profile, &log), Err(AppError::Database(_))));
        assert!(runtime.try_state::<StartupRecoveryFailure>().is_none());
    }

    #[test]
    fn explicit_native_diagnostic_export_succeeds_or_refuses_without_business_store() {
        for blocked_export in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            fs::write(temporary.path().join(".zentra-restore-journal.json"), b"PRIVATE_SENTINEL invalid intent").unwrap();
            if blocked_export { fs::write(temporary.path().join("exports"), b"PRIVATE_SENTINEL existing file").unwrap(); }
            let runtime = app();
            let log = crate::initialize_profile_diagnostics(temporary.path()).unwrap();
            runtime.manage(log.clone());
            assert!(initialize_store(runtime.handle(), temporary.path().into(), &log).unwrap().is_none());
            assert_refused(&runtime);
            let result = tauri::async_runtime::block_on(crate::diagnostics::export_diagnostics(runtime.state()));
            if blocked_export {
                let message = result.unwrap_err();
                assert!(!message.contains("PRIVATE_SENTINEL"));
                assert_eq!(fs::read(temporary.path().join("exports")).unwrap(), b"PRIVATE_SENTINEL existing file");
            } else {
                let file = PathBuf::from(result.unwrap());
                assert!(file.starts_with(temporary.path().join("exports")));
                let exported = fs::read_to_string(file).unwrap();
                assert!(exported.contains("app.local_store.initialize") && exported.contains("STORAGE"));
                assert!(!exported.contains("PRIVATE_SENTINEL"));
            }
            assert_refused(&runtime);
            assert!(!temporary.path().join("helvichantier.sqlite3").exists());
        }
    }

    #[test]
    fn pending_blocked_preserves_active_previous_candidates_documents_and_logo() {
        let temporary = tempfile::tempdir().unwrap();
        let (store, _) = fixture(temporary.path(), "active", 41);
        let (candidate, _) = fixture(temporary.path(), "candidate", 42);
        let _ = auxiliary_fixture(&store);
        let token = journal(&store, "pending");
        store.connect().unwrap_err();
        fs::copy(&store.database_path, store.data_dir.join(format!(".before-restore-{token}.sqlite3"))).unwrap();
        fs::copy(&candidate.database_path, store.data_dir.join(format!(".restore-{token}.sqlite3"))).unwrap();
        copy_tree(&store.attachments_dir, &store.data_dir.join(format!(".before-restore-attachments-{token}")));
        copy_tree(&candidate.attachments_dir, &store.data_dir.join(format!(".restore-attachments-{token}")));
        fs::remove_dir_all(store.data_dir.join(format!(".restore-state-{token}"))).unwrap();
        let before = (fingerprints(&store.data_dir), fingerprints(&candidate.data_dir));
        let runtime = app();
        let log = crate::initialize_profile_diagnostics(&store.data_dir).unwrap();
        assert!(initialize_store(runtime.handle(), store.data_dir.clone(), &log).unwrap().is_none());
        assert_refused(&runtime);
        assert!(store.connect().is_err());
        assert_eq!(before, (fingerprints(&store.data_dir), fingerprints(&candidate.data_dir)));
    }

    #[test]
    fn real_recovery_database_and_validation_failures_are_tagged() {
        for invalid_sqlite in [true, false] {
            let temporary = tempfile::tempdir().unwrap();
            let (store, _) = fixture(temporary.path(), "active", 51);
            let token = journal(&store, "pending");
            let old = store.data_dir.join(format!(".before-restore-{token}.sqlite3"));
            if invalid_sqlite { fs::write(&old, b"not SQLite").unwrap(); }
            else { let db = rusqlite::Connection::open(&old).unwrap(); db.execute_batch("CREATE TABLE unrelated(id INTEGER);").unwrap(); }
            let failure = LocalStore::initialize_for_startup(store.data_dir.clone()).unwrap_err();
            if invalid_sqlite { assert!(matches!(failure, StoreInitializationError::Recovery(AppError::Database(_)))); }
            else { assert!(matches!(failure, StoreInitializationError::Recovery(AppError::Validation(_)))); }
            let runtime = app();
            let log = crate::initialize_profile_diagnostics(&store.data_dir).unwrap();
            assert!(initialize_store(runtime.handle(), store.data_dir.clone(), &log).unwrap().is_none());
            assert_refused(&runtime);
            assert!(old.exists() && store.database_path.exists());
        }
    }

    #[test]
    fn pending_valid_rolls_back_and_durable_phases_reopen_real_profiles() {
        for phase in ["pending", "committed", "rolled_back"] {
            let temporary = tempfile::tempdir().unwrap();
            let (store, expected) = fixture(temporary.path(), "active", 61);
            let (_, excluded) = fixture(temporary.path(), "excluded", 62);
            let before_auxiliary = auxiliary_fixture(&store);
            journal(&store, phase);
            let runtime = app();
            let log = crate::initialize_profile_diagnostics(&store.data_dir).unwrap();
            let reopened = initialize_store(runtime.handle(), store.data_dir.clone(), &log).unwrap().unwrap();
            assert_profile(&reopened, &expected, &excluded, true);
            assert_auxiliary(&reopened, &before_auxiliary);
            assert!(!store.data_dir.join(".zentra-restore-journal.json").exists());
            runtime.manage(reopened);
            assert_eq!(readiness(runtime.handle()), Ok(true));
        }
    }

    #[cfg(windows)]
    #[test]
    fn durable_cleanup_io_refuses_boot_then_reopen_keeps_selected_profile() {
        use std::os::windows::fs::OpenOptionsExt;
        for phase in ["committed", "rolled_back"] {
            let temporary = tempfile::tempdir().unwrap();
            let (store, expected) = fixture(temporary.path(), "active", 71);
            let (_, excluded) = fixture(temporary.path(), "excluded", 72);
            let before_auxiliary = auxiliary_fixture(&store);
            let token = journal(&store, phase);
            let staged_database = store.data_dir.join(format!(".restore-{token}.sqlite3"));
            fs::copy(&store.database_path, &staged_database).unwrap();
            let stage = store.data_dir.join(format!(".restore-attachments-{token}"));
            fs::create_dir(&stage).unwrap();
            let locked = stage.join("cleanup-lock");
            fs::write(&locked, b"CI temporary cleanup boundary").unwrap();
            // Permit reads/metadata, refuse deletion only. This proves the
            // active-profile validations can finish before cleanup is blocked.
            let held = fs::OpenOptions::new().read(true).share_mode(0x1 | 0x2).open(&locked).unwrap();
            assert_eq!(fs::read(&locked).unwrap(), b"CI temporary cleanup boundary");
            assert!(matches!(LocalStore::initialize_for_startup(store.data_dir.clone()), Err(StoreInitializationError::Recovery(AppError::Io(_)))));
            // Cleanup removed its preceding staged DB before reaching the
            // delete-denied attachment. The Io did not originate in admission.
            assert!(!staged_database.exists());
            let runtime = app();
            let log = crate::initialize_profile_diagnostics(&store.data_dir).unwrap();
            runtime.manage(log.clone());
            assert!(initialize_store(runtime.handle(), store.data_dir.clone(), &log).unwrap().is_none());
            assert_refused(&runtime);
            let intent: Value = serde_json::from_slice(&fs::read(store.data_dir.join(".zentra-restore-journal.json")).unwrap()).unwrap();
            assert_eq!(intent["phase"], phase);
            assert!(locked.exists());
            assert_profile(&store, &expected, &excluded, true);
            assert_auxiliary(&store, &before_auxiliary);
            assert_primary_diagnostic(&store.data_dir);
            drop(held);
            let reopened_app = app();
            let reopened = initialize_store(reopened_app.handle(), store.data_dir.clone(), &log).unwrap().unwrap();
            assert_profile(&reopened, &expected, &excluded, true);
            assert_auxiliary(&reopened, &before_auxiliary);
            assert!(!stage.exists() && !store.data_dir.join(".zentra-restore-journal.json").exists());
            reopened_app.manage(reopened);
            assert_eq!(readiness(reopened_app.handle()), Ok(true));
        }
    }
}
