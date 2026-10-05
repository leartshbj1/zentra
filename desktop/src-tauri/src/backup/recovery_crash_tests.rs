//! Real SQLite, native .zentra archives, referenced PDF and managed PNG branding.
//! The process-kill witness is deliberately opt-in on disposable Windows CI.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::process::{Child, Command, Stdio};

const AUXILIARY: &[&str] = &[
    "company-collaboration.json", "company-sync-baseline.json",
    "company-sync-reference.zentra", "cloud-backup-state.json",
    "backup-status.json", "joined-company-copy.json",
];
const RESTORE_BOUNDARIES: &[&str] = &[
    "intent_published", "database_staged", "attachments_staged",
    "old_database_renamed", "old_attachments_renamed",
    "new_database_renamed", "new_attachments_renamed", "finalized",
    "commit_published", "cleanup_database_removed", "cleanup_attachments_removed",
    "cleanup_auxiliary_file_company-collaboration.json", "cleanup_auxiliary_file_company-sync-baseline.json",
    "cleanup_auxiliary_file_company-sync-reference.zentra", "cleanup_auxiliary_file_cloud-backup-state.json",
    "cleanup_auxiliary_file_backup-status.json", "cleanup_auxiliary_file_joined-company-copy.json",
    "cleanup_auxiliary_removed", "cleanup_journal_removed",
];
const ROLLBACK_BOUNDARIES: &[&str] = &[
    "rollback_new_database_removed", "rollback_database_restored",
    "rollback_new_attachments_removed", "rollback_attachments_restored",
    "rollback_auxiliary_company-collaboration.json",
    "rollback_auxiliary_company-sync-baseline.json",
    "rollback_auxiliary_company-sync-reference.zentra",
    "rollback_auxiliary_cloud-backup-state.json",
    "rollback_auxiliary_backup-status.json",
    "rollback_auxiliary_joined-company-copy.json",
    "rollback_published", "cleanup_database_removed", "cleanup_attachments_removed",
    "cleanup_auxiliary_file_company-collaboration.json", "cleanup_auxiliary_file_company-sync-baseline.json",
    "cleanup_auxiliary_file_company-sync-reference.zentra", "cleanup_auxiliary_file_cloud-backup-state.json",
    "cleanup_auxiliary_file_backup-status.json", "cleanup_auxiliary_file_joined-company-copy.json",
    "cleanup_auxiliary_removed", "cleanup_journal_removed",
];

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Expected {
    pub(crate) project: String, pub(crate) document: String, pub(crate) document_base64: String,
    pub(crate) logo_path: String, pub(crate) logo_base64: String, pub(crate) scope: String,
}

pub(crate) fn fixture(root: &Path, name: &str, color: u8) -> (LocalStore, Expected) {
    let store = LocalStore::initialize(root.join(name)).unwrap();
    let now = now_iso();
    store.connect().unwrap().execute(
        "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,?,?,?)",
        params![format!("Synthetic {name}"), now, now],
    ).unwrap();
    let project = store.create_record("projects", json!({"name": format!("Projet synthétique {name}")})).unwrap();
    let project = project["id"].as_str().unwrap().to_owned();
    let document_base64 = STANDARD.encode(crate::attachments::test_pdf_bytes());
    let document = store.add_project_document(crate::project_documents::AddProjectDocumentInput {
        project_id: project.clone(), original_name: "Plan synthétique.pdf".into(), content_base64: document_base64.clone(),
    }).unwrap();
    let logo_source = root.join(format!("{name}.png"));
    image::RgbaImage::from_pixel(64, 32, image::Rgba([color, 81, 119, 255]))
        .save_with_format(&logo_source, image::ImageFormat::Png).unwrap();
    let logo_path = store.stage_company_logo(logo_source.to_str().unwrap()).unwrap();
    store.connect().unwrap().execute("UPDATE settings SET logo_path=? WHERE id=1", [&logo_path]).unwrap();
    let expected = Expected {
        project, document: document["id"].as_str().unwrap().into(), document_base64,
        logo_base64: STANDARD.encode(fs::read(&logo_path).unwrap()), logo_path,
        scope: crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(),
    };
    (store, expected)
}

pub(crate) fn assert_profile(store: &LocalStore, expected: &Expected, excluded: &Expected, preserve_scope: bool) {
    validate_database(&store.database_path).unwrap();
    let workspace = store.get_workspace().unwrap();
    let visible_projects = workspace["projects"].as_array().unwrap();
    assert_eq!(visible_projects.len(), 1);
    assert_eq!(visible_projects[0]["id"], expected.project);
    assert_eq!(store.read_project_document(&expected.document).unwrap(), expected.document_base64);
    assert!(store.read_project_document(&excluded.document).is_err());
    assert_eq!(store.company_logo_preview(&expected.logo_path).unwrap(), format!("data:image/png;base64,{}", expected.logo_base64));
    let connection = store.connect().unwrap();
    let projects: Vec<String> = connection.prepare("SELECT id FROM projects ORDER BY id").unwrap()
        .query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(projects, vec![expected.project.clone()]);
    if preserve_scope { assert_eq!(crate::work_notes::workspace_scope(&connection).unwrap(), expected.scope); }
}

pub(crate) fn auxiliary_fixture(store: &LocalStore) -> Vec<Option<Vec<u8>>> {
    AUXILIARY.iter().enumerate().map(|(index, name)| {
        // Include absent state, so rollback must remove files created by a
        // finalizer as well as restore files that existed before the swap.
        if index == 5 { return None; }
        let bytes = if *name == "company-collaboration.json" { b"{}".to_vec() }
            else { format!("synthetic-original-{name}").into_bytes() };
        fs::write(store.data_dir.join(name), &bytes).unwrap();
        Some(bytes)
    }).collect()
}

fn change_auxiliary(store: &LocalStore) -> AppResult<()> {
    for name in AUXILIARY { fs::write(store.data_dir.join(name), format!("synthetic-new-{name}"))?; }
    Ok(())
}

pub(crate) fn assert_auxiliary(store: &LocalStore, before: &[Option<Vec<u8>>]) {
    for (name, bytes) in AUXILIARY.iter().zip(before) {
        assert_eq!(fs::read(store.data_dir.join(name)).ok(), *bytes, "{name}");
    }
}

fn profile_bytes(root: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    WalkDir::new(root).follow_links(false).into_iter().map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| (entry.path().strip_prefix(root).unwrap().to_path_buf(), fs::read(entry.path()).unwrap())).collect()
}

fn byte_fingerprint(bytes: &[u8]) -> (usize, String) {
    (bytes.len(), format!("{:x}", Sha256::digest(bytes)))
}

fn assert_file_bytes(path: &Path, expected: &[u8], context: &str) {
    let actual = fs::read(path).unwrap();
    assert!(actual.as_slice() == expected,
        "{context}: {} actual(size,sha256)={:?} expected(size,sha256)={:?}",
        path.display(), byte_fingerprint(&actual), byte_fingerprint(expected));
}

fn assert_profile_bytes(root: &Path, expected: &std::collections::BTreeMap<PathBuf, Vec<u8>>, context: &str) {
    let actual = profile_bytes(root);
    let paths: std::collections::BTreeSet<PathBuf> = actual.keys().chain(expected.keys()).cloned().collect();
    let differences: Vec<PathBuf> = paths.into_iter().filter(|path| actual.get(path) != expected.get(path)).collect();
    let summary: Vec<_> = differences.iter().take(12).map(|path| (
        path, actual.get(path).map(|bytes| byte_fingerprint(bytes)),
        expected.get(path).map(|bytes| byte_fingerprint(bytes)),
    )).collect();
    assert!(differences.is_empty(),
        "{context}: {} file differences; first 12 (path,actual(size,sha256),expected(size,sha256))={summary:?}",
        differences.len());
}

fn assert_quarantined<T>(result: AppResult<T>) {
    let error = result.err().expect("normal operation must be refused");
    assert!(matches!(&error, AppError::Restore(_)));
    assert!(error.to_string().contains("restauration doit être reprise"));
    assert!(!error.to_string().starts_with("Champ invalide"));
}

#[test]
fn preexisting_connection_and_prepared_shared_or_private_writes_cannot_commit_while_pending() {
    let root = tempfile::tempdir().unwrap();
    let (current, original) = fixture(root.path(), "current", 30);
    auxiliary_fixture(&current);
    let connection = current.connect().unwrap();
    let mut shared = connection.prepare("INSERT INTO clients(id,name,created_at,updated_at) VALUES('prepared-refusal','must refuse','2026-10-04','2026-10-04')").unwrap();
    let mut private = connection.prepare("UPDATE company_local_notes_scope SET scope='prepared-private-refusal' WHERE id=1").unwrap();
    let journal = recovery_journal::RecoveryJournal::begin(&current.data_dir, false).unwrap();
    drop(journal); // Simulate an interrupted owner with a durable Pending intent.
    assert!(shared.execute([]).is_err(), "execution-time shared gate must reject already prepared SQL");
    assert!(private.execute([]).is_err(), "commit hook must reject untracked/private prepared SQL");
    assert!(connection.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get::<_, i64>(0)).is_err());
    assert_quarantined(current.get_workspace());
    recover_interrupted_restore(&current.data_dir).unwrap();
    assert_eq!(crate::work_notes::workspace_scope(&current.connect().unwrap()).unwrap(), original.scope);
    assert_eq!(current.connect().unwrap().query_row("SELECT COUNT(*) FROM clients WHERE id='prepared-refusal'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    shared.execute([]).unwrap();
    assert_eq!(current.connect().unwrap().query_row("SELECT COUNT(*) FROM clients WHERE id='prepared-refusal'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn pending_published_after_connection_open_is_refused_before_register_or_pragmas() {
    let root = tempfile::tempdir().unwrap();
    let (current, _) = fixture(root.path(), "current", 30);
    auxiliary_fixture(&current);
    let direct = Connection::open(&current.database_path).unwrap();
    direct.pragma_update(None, "journal_mode", "DELETE").unwrap();
    drop(direct);
    let before = fs::read(&current.database_path).unwrap();
    let expected = current.data_dir.clone();
    let _hook = recovery_journal::once_test_checkpoint("connection_opened", move |directory| {
        assert_eq!(directory, expected.as_path());
        drop(recovery_journal::RecoveryJournal::begin(directory, false).unwrap());
    });
    assert_quarantined(current.connect());
    assert_file_bytes(&current.database_path, &before, "Pending admission must not change SQLite");
    let inspected = Connection::open_with_flags(&current.database_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(inspected.pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0)).unwrap(), "delete");
    drop(inspected);
    recover_interrupted_restore(&current.data_dir).unwrap();
    current.connect().unwrap();
}

#[test]
fn failed_rollback_quarantines_scoped_writes_reads_exports_and_publication_until_recovery() {
    for damage in ["missing", "hash", "size"] {
        let root = tempfile::tempdir().unwrap();
        let (source, candidate) = fixture(root.path(), "source", 220);
        let archive = source.create_backup(None, env!("CARGO_PKG_VERSION")).unwrap();
        let (current, original) = fixture(root.path(), "current", 30);
        let auxiliary = auxiliary_fixture(&current);
        let existing_entries: std::collections::BTreeSet<_> = fs::read_dir(&current.data_dir).unwrap()
            .map(|entry| entry.unwrap().path()).collect();
        let mut extraction_path = None;
        let mut saved_path = None;
        let mut saved_bytes = Vec::new();
        let mut installed_bytes = None;
        let error = current.restore_company_snapshot(&archive, || {
            // Identify this invocation's unique newly created extraction by its
            // database/attachment layout. Do not exclude directories by prefix.
            let mut extractions: Vec<_> = fs::read_dir(&current.data_dir)?
                .map(|entry| entry.map(|entry| entry.path())).collect::<Result<_, _>>()?;
            extractions.retain(|path| !existing_entries.contains(path)
                && path.is_dir() && path.join(DATABASE_ENTRY).is_file()
                && path.join("attachments").is_dir());
            assert_eq!(extractions.len(), 1, "this restore must own exactly one new extraction TempDir");
            let extraction = extractions.pop().unwrap();
            assert!(extraction.file_name().unwrap().to_string_lossy().starts_with("restore-"));
            extraction_path = Some(extraction);
            change_auxiliary(&current)?;
            let intent: Value = serde_json::from_slice(&fs::read(current.data_dir.join(".zentra-restore-journal.json"))?)?;
            let path = current.data_dir.join(format!(".restore-state-{}", intent["token"].as_str().unwrap())).join("cloud-backup-state.json");
            saved_bytes = fs::read(&path)?;
            match damage {
                "missing" => fs::remove_file(&path)?,
                "hash" => { let mut bytes = saved_bytes.clone(); bytes[0] ^= 1; fs::write(&path, bytes)?; }
                "size" => { let mut bytes = saved_bytes.clone(); bytes.push(0); fs::write(&path, bytes)?; }
                _ => unreachable!(),
            }
            saved_path = Some(path);
            installed_bytes = Some(profile_bytes(&current.data_dir));
            Err(AppError::Validation("synthetic-finalizer-and-saved-state-failure".into()))
        }).unwrap_err();
        assert!(error.to_string().contains("retour automatique est incomplet"));
        let mut preserved = installed_bytes.unwrap();
        let extraction = extraction_path.unwrap();
        let relative_extraction = extraction.strip_prefix(&current.data_dir).unwrap();
        assert_eq!(relative_extraction.components().count(), 1);
        assert!(preserved.contains_key(&relative_extraction.join(DATABASE_ENTRY)));
        assert!(fs::symlink_metadata(&extraction).is_err_and(|error| error.kind() == io::ErrorKind::NotFound),
            "the identified extraction TempDir must be removed on return: {}", extraction.display());
        // Only this exact invocation-owned TempDir expires on return. All old,
        // active, journal, auxiliary, sidecar and unrelated files remain covered.
        preserved.retain(|path, _| !path.starts_with(relative_extraction));
        assert_profile_bytes(&current.data_dir, &preserved, &format!("neither profile may be deleted after {damage}"));
        assert_quarantined(current.connect());
        assert_quarantined(current.get_workspace());
        assert_quarantined(current.create_record("projects", json!({"name":"must never be acknowledged"})));
        assert_quarantined(current.read_project_document(&candidate.document));
        assert_quarantined(current.company_logo_preview(&candidate.logo_path));
        let output = root.path().join("must-not-publish.zentra");
        assert_quarantined(current.create_backup(Some(output.to_string_lossy().into()), env!("CARGO_PKG_VERSION")));
        assert!(!output.exists());
        let snapshot = root.path().join("must-not-snapshot.sqlite3");
        assert_quarantined(current.snapshot_database(&snapshot));
        assert!(!snapshot.exists());
        let exported = root.path().join("must-not-export.json");
        assert_quarantined(current.export_json(Some(exported.to_string_lossy().into()), env!("CARGO_PKG_VERSION")));
        assert!(!exported.exists());
        let called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let inside = called.clone();
        let scoped = tauri::async_runtime::block_on(crate::commands::run_scoped_local_operation(
            current.clone(), Some(original.scope.clone()), move |store| {
                inside.store(true, std::sync::atomic::Ordering::SeqCst);
                store.create_record("projects", json!({"name":"scoped must not run"})).map_err(crate::error::command_error)
            },
        ));
        assert!(scoped.unwrap_err().contains("restauration doit être reprise"));
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
        assert_quarantined(tauri::async_runtime::block_on(crate::company_collaboration::prepare_recovery_test_publication(&current, "company")));
        assert_quarantined(current.prepare_recovery_test_cloud_backup("company"));
        assert_profile_bytes(&current.data_dir, &preserved, "refused operations must not mutate old or candidate files");
        fs::write(saved_path.unwrap(), saved_bytes).unwrap();
        recover_interrupted_restore(&current.data_dir).unwrap();
        let reopened = LocalStore::initialize(current.data_dir.clone()).unwrap();
        assert_profile(&reopened, &original, &candidate, true);
        assert_auxiliary(&reopened, &auxiliary);
        let second = LocalStore::initialize(current.data_dir.clone()).unwrap();
        assert_profile(&second, &original, &candidate, true);
        assert_auxiliary(&second, &auxiliary);
        let written = tauri::async_runtime::block_on(crate::commands::run_scoped_local_operation(
            second.clone(), Some(original.scope.clone()), |store| {
                store.create_record("projects", json!({"name":"ordinary write after recovery"})).map_err(crate::error::command_error)
            },
        )).unwrap();
        assert!(written["id"].is_string());
        assert!(tauri::async_runtime::block_on(crate::company_collaboration::prepare_recovery_test_publication(&second, "company")).is_ok());
    }
}

#[test]
fn restore_owner_permit_is_exact_thread_scoped_and_revoked_after_panic() {
    let root = tempfile::tempdir().unwrap();
    let (source, candidate) = fixture(root.path(), "source", 220);
    let archive = source.create_backup(None, env!("CARGO_PKG_VERSION")).unwrap();
    let (current, original) = fixture(root.path(), "current", 30);
    let auxiliary = auxiliary_fixture(&current);
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = current.restore_company_snapshot(&archive, || {
            assert_profile(&current, &candidate, &original, false);
            let other_thread = current.clone();
            let transferred_connection = current.connect()?;
            std::thread::spawn(move || {
                assert_quarantined(other_thread.connect());
                assert_quarantined(other_thread.create_record("projects", json!({"name":"another thread"})));
                assert!(transferred_connection.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get::<_, i64>(0)).is_err());
                assert!(transferred_connection.execute("INSERT INTO projects(id,name,created_at,updated_at) VALUES('transferred','must refuse','2026-10-04','2026-10-04')", []).is_err());
            }).join().unwrap();
            let path = current.data_dir.join(".zentra-restore-journal.json");
            let valid = fs::read(&path)?;
            let mut other_generation: Value = serde_json::from_slice(&valid)?;
            other_generation["token"] = json!(Uuid::new_v4().to_string());
            fs::write(&path, serde_json::to_vec(&other_generation)?)?;
            assert_quarantined(current.connect());
            fs::write(path, valid)?;
            panic!("synthetic-finalizer-panic");
        });
    }));
    assert!(panic.is_err());
    assert_quarantined(current.connect());
    assert_quarantined(current.create_record("projects", json!({"name":"after panic"})));
    recover_interrupted_restore(&current.data_dir).unwrap();
    let reopened = LocalStore::initialize(current.data_dir.clone()).unwrap();
    assert_profile(&reopened, &original, &candidate, true);
    assert_auxiliary(&reopened, &auxiliary);
}

#[test]
fn every_recovery_database_rejects_linked_sqlite_sidecars_before_opening_or_deleting() {
    for database in ["active", "staged", "old"] {
        for suffix in ["-wal", "-shm", "-journal"] {
            let root = tempfile::tempdir().unwrap();
            let (source, _) = fixture(root.path(), "source", 220);
            let (current, _) = fixture(root.path(), "current", 30);
            auxiliary_fixture(&current);
            let snapshot = root.path().join("source.sqlite3");
            source.snapshot_database(&snapshot).unwrap();
            let swap = current.install_restored_data(&snapshot, &source.attachments_dir, true).unwrap();
            let selected = match database { "active" => &swap.database_path, "staged" => &swap.staged_database, "old" => &swap.old_database, _ => unreachable!() };
            let sidecar = PathBuf::from(format!("{}{}", selected.display(), suffix));
            let outside = root.path().join("outside");
            fs::create_dir(&outside).unwrap();
            let sentinel = outside.join("sentinel");
            fs::write(&sentinel, b"synthetic-outside-preserved").unwrap();
            let active = fs::read(&swap.database_path).unwrap();
            let old = fs::read(&swap.old_database).unwrap();
            let journal = fs::read(current.data_dir.join(".zentra-restore-journal.json")).unwrap();
            #[cfg(unix)] std::os::unix::fs::symlink(&sentinel, &sidecar).unwrap();
            #[cfg(windows)] {
                if std::os::windows::fs::symlink_file(&sentinel, &sidecar).is_ok() {
                    println!("NATIVE_SIDECAR_LINK database={database} suffix={suffix} kind=file-symlink");
                } else {
                    // A junction remains a real reparse point and needs no
                    // privilege or global policy change on the Windows runner.
                    for path in [&sidecar, &outside] { assert!(!path.to_string_lossy().chars().any(|ch| "&|^<>%\r\n".contains(ch))); }
                    assert!(Command::new("cmd.exe").args(["/c", "mklink", "/J"]).arg(&sidecar).arg(&outside)
                        .stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success());
                    println!("NATIVE_SIDECAR_LINK database={database} suffix={suffix} kind=directory-junction");
                }
            }
            assert!(LocalStore::initialize(current.data_dir.clone()).is_err());
            assert_file_bytes(&swap.database_path, &active, "linked sidecar must preserve active SQLite");
            assert_file_bytes(&swap.old_database, &old, "linked sidecar must preserve previous SQLite");
            assert_file_bytes(&current.data_dir.join(".zentra-restore-journal.json"), &journal, "linked sidecar must preserve journal");
            assert_eq!(fs::read(&sentinel).unwrap(), b"synthetic-outside-preserved");
            #[cfg(unix)] fs::remove_file(&sidecar).unwrap();
            #[cfg(windows)] {
                if fs::symlink_metadata(&sidecar).unwrap().is_dir() { fs::remove_dir(&sidecar).unwrap(); }
                else { fs::remove_file(&sidecar).unwrap(); }
            }
            swap.rollback().unwrap();
        }
    }
}

#[test]
fn staging_error_reports_failed_rollback_and_quarantines_the_unchanged_profile() {
    let root = tempfile::tempdir().unwrap();
    let (source, candidate) = fixture(root.path(), "source", 220);
    let (current, original) = fixture(root.path(), "current", 30);
    let auxiliary = auxiliary_fixture(&current);
    let snapshot = root.path().join("source.sqlite3");
    source.snapshot_database(&snapshot).unwrap();
    let owned_root = current.data_dir.clone();
    let saved = std::rc::Rc::new(std::cell::RefCell::new(None));
    let restore_saved = saved.clone();
    let _hook = recovery_journal::once_test_checkpoint("database_staged", move |directory| {
        assert_eq!(directory, owned_root.as_path());
        let intent: Value = serde_json::from_slice(&fs::read(directory.join(".zentra-restore-journal.json")).unwrap()).unwrap();
        let path = directory.join(format!(".restore-state-{}", intent["token"].as_str().unwrap())).join("cloud-backup-state.json");
        let bytes = fs::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        *restore_saved.borrow_mut() = Some((path, bytes));
    });
    let error = current.install_restored_data(&snapshot, &root.path().join("missing-attachment-source"), false).err().unwrap();
    assert!(error.to_string().contains("préparation de la restauration a échoué"));
    assert!(error.to_string().contains("retour automatique est incomplet"));
    let preserved = profile_bytes(&current.data_dir);
    assert_quarantined(current.connect());
    assert_quarantined(current.create_record("projects", json!({"name":"staging failure"})));
    assert_quarantined(tauri::async_runtime::block_on(crate::company_collaboration::prepare_recovery_test_publication(&current, "company")));
    assert_profile_bytes(&current.data_dir, &preserved, "staging refusal must preserve every profile file");
    let (path, bytes) = saved.borrow_mut().take().unwrap();
    fs::write(path, bytes).unwrap();
    recover_interrupted_restore(&current.data_dir).unwrap();
    let reopened = LocalStore::initialize(current.data_dir.clone()).unwrap();
    assert_profile(&reopened, &original, &candidate, true);
    assert_auxiliary(&reopened, &auxiliary);
}

#[test]
fn deferred_committed_cleanup_reports_completed_restore_and_never_rolls_back_new_writes() {
    let root = tempfile::tempdir().unwrap();
    let (source, candidate) = fixture(root.path(), "source", 220);
    let archive = source.create_backup(None, env!("CARGO_PKG_VERSION")).unwrap();
    let (current, original) = fixture(root.path(), "current", 30);
    auxiliary_fixture(&current);
    let mut obstruction = None;
    let result = current.restore_backup_and_then(&archive, env!("CARGO_PKG_VERSION"), || {
        let intent: Value = serde_json::from_slice(&fs::read(current.data_dir.join(".zentra-restore-journal.json"))?)?;
        let path = current.data_dir.join(format!(".restore-state-{}", intent["token"].as_str().unwrap())).join("unexpected-local-file");
        fs::write(&path, b"do-not-delete-unadmitted-file")?;
        obstruction = Some(path);
        Ok(())
    });
    let message = result.unwrap_err().to_string();
    assert!(message.contains("restauration est terminée et les données sont enregistrées"));
    assert!(message.contains("Fermez puis rouvrez Zentra"));
    assert!(!message.starts_with("Champ invalide"));
    let intent: Value = serde_json::from_slice(&fs::read(current.data_dir.join(".zentra-restore-journal.json")).unwrap()).unwrap();
    assert_eq!(intent["phase"], "committed");
    assert_profile(&current, &candidate, &original, false);
    let written = current.create_record("projects", json!({"name":"accepted only after durable commit"})).unwrap();
    let written_id = written["id"].as_str().unwrap().to_owned();
    assert!(LocalStore::initialize(current.data_dir.clone()).is_err());
    assert!(current.get_workspace().unwrap()["projects"].as_array().unwrap().iter().any(|row| row["id"] == written_id));
    assert_eq!(fs::read(obstruction.as_ref().unwrap()).unwrap(), b"do-not-delete-unadmitted-file");
    assert_eq!(fs::read_dir(&current.backups_dir).unwrap().count(), 1);
    fs::remove_file(obstruction.unwrap()).unwrap();
    for _ in 0..2 {
        let reopened = LocalStore::initialize(current.data_dir.clone()).unwrap();
        validate_database(&reopened.database_path).unwrap();
        assert_eq!(reopened.read_project_document(&candidate.document).unwrap(), candidate.document_base64);
        assert_eq!(reopened.company_logo_preview(&candidate.logo_path).unwrap(), format!("data:image/png;base64,{}", candidate.logo_base64));
        assert!(reopened.read_project_document(&original.document).is_err());
        let projects = reopened.get_workspace().unwrap()["projects"].as_array().unwrap().clone();
        assert_eq!(projects.len(), 2);
        assert!(projects.iter().any(|row| row["id"] == candidate.project));
        assert!(projects.iter().any(|row| row["id"] == written_id));
        assert!(!reopened.data_dir.join(".zentra-restore-journal.json").exists());
    }
}

#[test]
fn common_complete_and_snapshot_engines_restore_synthetic_auxiliary_finalizers_on_error() {
    for complete in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let (source, source_expected) = fixture(root.path(), "source", 220);
        let archive = source.create_backup(None, env!("CARGO_PKG_VERSION")).unwrap();
        let (current, expected) = fixture(root.path(), "current", 30);
        let auxiliary = auxiliary_fixture(&current);
        let finalize = || {
            change_auxiliary(&current)?;
            Err(AppError::Validation("synthetic-finalizer-failure".into()))
        };
        let result = if complete { current.restore_backup_and_then(&archive, env!("CARGO_PKG_VERSION"), finalize) }
            else { current.restore_company_snapshot(&archive, finalize) };
        assert!(result.unwrap_err().to_string().contains("données précédentes ont été rétablies"));
        assert_profile(&current, &expected, &source_expected, true);
        assert_auxiliary(&current, &auxiliary);
        let reopened = LocalStore::initialize(current.data_dir.clone()).unwrap();
        assert_profile(&reopened, &expected, &source_expected, true);
        assert_auxiliary(&reopened, &auxiliary);
    }
}

#[test]
fn malformed_or_outside_journal_tokens_never_touch_a_profile_or_an_external_file() {
    for token in ["../outside", "C:\\outside", "/outside", "00000000000000000000000000000000", "00000000-0000-0000-0000-000000000000"] {
        let root = tempfile::tempdir().unwrap();
        let (current, _) = fixture(root.path(), "current", 30);
        let before = fs::read(&current.database_path).unwrap();
        let outside = root.path().join("outside");
        fs::write(&outside, b"synthetic-preserve").unwrap();
        let auxiliary: Vec<Value> = AUXILIARY.iter().map(|name| json!({"name": name, "bytes": null, "sha256": null})).collect();
        fs::write(current.data_dir.join(".zentra-restore-journal.json"), serde_json::to_vec(&json!({
            "format":"zentra-local-restore", "version":1, "token":token,
            "phase":"pending", "complete_archive":true, "auxiliary":auxiliary,
        })).unwrap()).unwrap();
        assert!(LocalStore::initialize(current.data_dir.clone()).is_err());
        assert_file_bytes(&current.database_path, &before, "untrusted token must preserve SQLite");
        assert_eq!(fs::read(outside).unwrap(), b"synthetic-preserve");
    }
}

#[test]
fn a_linked_restore_directory_cannot_delete_files_outside_the_local_profile() {
    let root = tempfile::tempdir().unwrap();
    let (current, _) = fixture(root.path(), "current", 30);
    auxiliary_fixture(&current);
    let swap = recovery_journal::RecoveryJournal::begin(&current.data_dir, true).unwrap();
    let before = fs::read(&current.database_path).unwrap();
    let outside = root.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel"), b"synthetic-preserve").unwrap();
    #[cfg(unix)] std::os::unix::fs::symlink(&outside, &swap.old_attachments).unwrap();
    #[cfg(windows)] {
        // A directory junction needs no elevation or machine-wide policy change.
        // Both operands are fresh, parent-owned fixture paths, never user input.
        for path in [&outside, &swap.old_attachments] {
            assert!(!path.to_string_lossy().chars().any(|ch| "&|^<>%\r\n".contains(ch)));
        }
        assert!(Command::new("cmd.exe").args(["/c", "mklink", "/J"])
            .arg(&swap.old_attachments).arg(&outside)
            .stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success());
    }
    assert!(LocalStore::initialize(current.data_dir.clone()).is_err());
    assert_file_bytes(&current.database_path, &before, "linked directory must preserve SQLite");
    assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"synthetic-preserve");
    #[cfg(unix)] fs::remove_file(&swap.old_attachments).unwrap();
    #[cfg(windows)] fs::remove_dir(&swap.old_attachments).unwrap();
    swap.rollback().unwrap();
}

#[test]
fn untrusted_journal_schema_and_auxiliary_lists_cannot_expand_the_restore_scope() {
    for attack in ["version", "unknown_path", "auxiliary_name", "missing_auxiliary", "oversized"] {
        let root = tempfile::tempdir().unwrap();
        let (current, _) = fixture(root.path(), "current", 30);
        auxiliary_fixture(&current);
        let swap = recovery_journal::RecoveryJournal::begin(&current.data_dir, true).unwrap();
        let path = current.data_dir.join(".zentra-restore-journal.json");
        let valid = fs::read(&path).unwrap();
        let before = fs::read(&current.database_path).unwrap();
        let mut intent: Value = serde_json::from_slice(&valid).unwrap();
        match attack {
            "version" => intent["version"] = json!(99),
            "unknown_path" => intent["outside_path"] = json!("../outside"),
            "auxiliary_name" => intent["auxiliary"][0]["name"] = json!("license-token.protected"),
            "missing_auxiliary" => { intent["auxiliary"].as_array_mut().unwrap().pop(); }
            "oversized" => {}
            _ => unreachable!(),
        }
        let bytes = if attack == "oversized" { vec![b'x'; 20 * 1024] } else { serde_json::to_vec(&intent).unwrap() };
        fs::write(&path, bytes).unwrap();
        assert!(LocalStore::initialize(current.data_dir.clone()).is_err(), "{attack}");
        assert_file_bytes(&current.database_path, &before, "untrusted intent must preserve SQLite");
        fs::write(&path, valid).unwrap();
        swap.rollback().unwrap();
    }
}

#[test]
fn a_missing_auxiliary_snapshot_blocks_recovery_without_deleting_either_database() {
    let root = tempfile::tempdir().unwrap();
    let (source, _) = fixture(root.path(), "source", 220);
    let (current, _) = fixture(root.path(), "current", 30);
    auxiliary_fixture(&current);
    let snapshot = root.path().join("source.sqlite3");
    source.snapshot_database(&snapshot).unwrap();
    let swap = current.install_restored_data(&snapshot, &source.attachments_dir, true).unwrap();
    let current_bytes = fs::read(&swap.database_path).unwrap();
    let old_bytes = fs::read(&swap.old_database).unwrap();
    let intent: Value = serde_json::from_slice(&fs::read(current.data_dir.join(".zentra-restore-journal.json")).unwrap()).unwrap();
    fs::remove_file(current.data_dir.join(format!(".restore-state-{}", intent["token"].as_str().unwrap())).join("cloud-backup-state.json")).unwrap();
    assert!(LocalStore::initialize(current.data_dir.clone()).is_err());
    assert_file_bytes(&swap.database_path, &current_bytes, "missing saved state must preserve active SQLite");
    assert_file_bytes(&swap.old_database, &old_bytes, "missing saved state must preserve previous SQLite");
    assert!(current.data_dir.join(".zentra-restore-journal.json").is_file());
}

#[test]
fn an_unjournaled_legacy_swap_never_creates_an_empty_company_over_the_hidden_database() {
    let root = tempfile::tempdir().unwrap();
    let (current, _) = fixture(root.path(), "current", 30);
    current.connect().unwrap().execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let hidden = current.data_dir.join(format!(".before-restore-{}.sqlite3", Uuid::new_v4()));
    fs::rename(&current.database_path, &hidden).unwrap();
    let bytes = fs::read(&hidden).unwrap();
    assert!(LocalStore::initialize(current.data_dir.clone()).is_err());
    assert!(!current.database_path.exists());
    assert_file_bytes(&hidden, &bytes, "legacy swap must preserve hidden SQLite");
}

#[derive(Serialize, Deserialize)]
struct CrashPlan { original: Expected, restored: Expected, auxiliary: Vec<Option<Vec<u8>>>, complete: bool }

// Closed numeric protocol, written by the parent aggregate only. These events
// observe the existing assertions; they never authorize a recovery operation.
#[derive(Clone, Copy)]
#[repr(u8)]
enum ProgressStage {
    MatrixStarted = 0, CaseStarted = 1, SourceFixtureReady = 2, ArchiveReady = 3,
    FixturesReady = 4, ChildStarted = 5, CheckpointObserved = 6,
    ChildKillRequested = 7, ChildReaped = 8, FirstReopenValidated = 9,
    SecondReopenValidated = 10, ArtifactsPreserved = 11, CaseCompleted = 12,
    MatrixCompleted = 13, Failed = 14,
}

#[derive(Clone, Copy)]
struct ProgressCase { index: u8, mode: u8, group: u8, boundary: u8 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    v: u8, sequence: u16, case_index: u8, mode: u8, group: u8, boundary: u8,
    stage: u8, ordinal: u8, checkpoint: u8, elapsed_ms: u64,
    proof_write_elapsed_micros_before: u64, planned_cases: u8, planned_kills: u8,
    completed_cases: u8, confirmed_kills: u8, status: u8, failure_category: u8,
}

fn checkpoint_code(phase: &str) -> u8 {
    if let Some(index) = RESTORE_BOUNDARIES.iter().position(|candidate| *candidate == phase) {
        return u8::try_from(index + 1).unwrap();
    }
    // The first eleven rollback names are distinct; cleanup names reuse the
    // restore codes. The catalogue cannot admit a free checkpoint label.
    let index = ROLLBACK_BOUNDARIES[..11].iter().position(|candidate| *candidate == phase)
        .expect("fixed crash checkpoint catalogue");
    u8::try_from(index + 20).unwrap()
}

fn assert_progress_path_ordinary(path: &Path) {
    for ancestor in path.ancestors() {
        let metadata = match fs::symlink_metadata(ancestor) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => panic!("closed progress path metadata refusal"),
        };
        assert!(!metadata.file_type().is_symlink(), "progress path must be ordinary");
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(metadata.file_attributes() & 0x400, 0, "progress path must not be a reparse point");
        }
    }
}

fn owned_progress_root(proof: &Path) -> PathBuf {
    assert!(proof.is_absolute(), "progress root must be absolute");
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
    let expected = repository.join("desktop").join("artifacts").join("recovery-route-witness").join("crash");
    assert_eq!(proof, expected, "progress root must be the fixed owned artifact path");
    assert_progress_path_ordinary(repository);
    assert_progress_path_ordinary(proof);
    assert_eq!(proof.parent().unwrap().canonicalize().unwrap(), expected.parent().unwrap().canonicalize().unwrap());
    expected
}

struct CrashProgress {
    file: File, started: std::time::Instant, sequence: u16,
    completed_cases: u8, confirmed_kills: u8, current: Option<ProgressCase>,
    ordinal: u8, checkpoint: u8, proof_write_elapsed_micros: u64,
    finished: bool, writer_failed: bool,
}

impl CrashProgress {
    fn create(proof: &Path) -> Self {
        let started = std::time::Instant::now();
        let path = proof.join("progress.jsonl");
        assert_progress_path_ordinary(proof);
        assert!(!path.exists(), "old progress must never be truncated or resumed");
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1); // FILE_SHARE_READ only: no second writer/delete.
        }
        Self { file: options.open(path).unwrap(), started, sequence: 0,
            completed_cases: 0, confirmed_kills: 0, current: None, ordinal: 0,
            checkpoint: 0, proof_write_elapsed_micros: 0, finished: false, writer_failed: false }
    }

    fn append(&mut self, stage: ProgressStage, ordinal: u8, checkpoint: u8, failure: u8) -> std::io::Result<()> {
        // Before refers ONLY to previous completed write/flush/sync operations.
        // It excludes creation, serialization, reads and this append's future
        // I/O, including the matrix_completed append itself.
        let case = self.current.unwrap_or(ProgressCase { index: 80, mode: 0, group: 0, boundary: 0 });
        let event = ProgressEvent { v: 1, sequence: self.sequence + 1,
            case_index: case.index, mode: case.mode, group: case.group, boundary: case.boundary,
            stage: stage as u8, ordinal, checkpoint, elapsed_ms: self.started.elapsed().as_millis() as u64,
            proof_write_elapsed_micros_before: self.proof_write_elapsed_micros,
            planned_cases: 80, planned_kills: 122, completed_cases: self.completed_cases,
            confirmed_kills: self.confirmed_kills,
            status: if matches!(stage, ProgressStage::MatrixCompleted) { 1 } else if matches!(stage, ProgressStage::Failed) { 2 } else { 0 },
            failure_category: failure };
        let mut line = serde_json::to_vec(&event).map_err(std::io::Error::other)?;
        if line.len() > 1024 || self.sequence >= 1280 { return Err(std::io::Error::other("closed progress bound")); }
        line.push(b'\n');
        let io_started = std::time::Instant::now();
        use std::io::Write;
        self.file.write_all(&line)?;
        self.file.flush()?;
        self.file.sync_all()?;
        self.proof_write_elapsed_micros += io_started.elapsed().as_micros() as u64;
        self.sequence += 1;
        self.ordinal = ordinal;
        self.checkpoint = checkpoint;
        Ok(())
    }

    fn record(&mut self, stage: ProgressStage, ordinal: u8, checkpoint: u8) {
        if self.append(stage, ordinal, checkpoint, 0).is_err() {
            self.writer_failed = true;
            panic!("closed progress append failed");
        }
    }

    fn begin_case(&mut self, complete: bool, recovery: bool, boundary: usize) {
        self.current = Some(ProgressCase { index: self.completed_cases,
            mode: if complete { 1 } else { 2 }, group: if recovery { 2 } else { 1 }, boundary: u8::try_from(boundary).unwrap() });
        self.ordinal = 0; self.checkpoint = 0;
        self.record(ProgressStage::CaseStarted, 0, 0);
    }

    fn reaped(&mut self, ordinal: u8, checkpoint: u8) {
        // Called ONLY after kill succeeded, wait returned, and its original
        // non-success assertion passed. A requested kill does not count.
        self.confirmed_kills += 1;
        assert!(self.confirmed_kills <= 122);
        self.record(ProgressStage::ChildReaped, ordinal, checkpoint);
    }

    fn completed(&mut self) {
        // All original asserts, retained copies and outcome hashes are already
        // complete and the original outcome has been pushed by this point.
        self.completed_cases += 1;
        assert!(self.completed_cases <= 80);
        self.record(ProgressStage::CaseCompleted, 0, 0);
    }

    fn finish(&mut self) {
        assert_eq!(self.completed_cases, 80);
        assert_eq!(self.confirmed_kills, 122);
        assert_eq!(self.sequence, 1129);
        self.current = None;
        self.record(ProgressStage::MatrixCompleted, 0, 0);
        self.finished = true;
    }
}

impl Drop for CrashProgress {
    fn drop(&mut self) {
        // Preserve the original unwind. Even a failed proof handle must never
        // panic a second time or turn incomplete evidence into success.
        if !self.finished && std::thread::panicking() {
            let category = if self.writer_failed { 2 } else { 1 };
            let _ = self.append(ProgressStage::Failed, self.ordinal, self.checkpoint, category);
        }
    }
}

// Additive protocol contracts. Prepared here; execution still requires the
// independently admitted native harness. They do not simulate SQLite success.
#[test]
fn progress_contract_fresh_file_never_truncates_old_evidence() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("progress.jsonl"), b"retained").unwrap();
    assert!(std::panic::catch_unwind(|| CrashProgress::create(root.path())).is_err());
    assert_eq!(fs::read(root.path().join("progress.jsonl")).unwrap(), b"retained");
}

#[test]
fn progress_contract_closed_fields_and_prior_io_cost_are_exact() {
    let root = tempfile::tempdir().unwrap();
    let mut progress = CrashProgress::create(root.path());
    progress.record(ProgressStage::MatrixStarted, 0, 0);
    let previous_cost = progress.proof_write_elapsed_micros;
    progress.begin_case(true, false, 0);
    let raw = fs::read_to_string(root.path().join("progress.jsonl")).unwrap();
    let events: Vec<serde_json::Value> = raw.lines().map(|line| {
        assert!(line.is_ascii() && line.len() <= 1024);
        serde_json::from_str(line).unwrap()
    }).collect();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["proofWriteElapsedMicrosBefore"], 0);
    assert_eq!(events[1]["proofWriteElapsedMicrosBefore"].as_u64().unwrap(), previous_cost);
    let fields = ["v","sequence","caseIndex","mode","group","boundary","stage","ordinal","checkpoint","elapsedMs","proofWriteElapsedMicrosBefore","plannedCases","plannedKills","completedCases","confirmedKills","status","failureCategory"];
    for event in events {
        let object = event.as_object().unwrap();
        assert_eq!(object.len(), fields.len());
        assert!(fields.iter().all(|field| object.get(*field).unwrap().as_u64().is_some()));
        assert!(event["proofWriteElapsedMicrosBefore"].as_u64().unwrap() <= event["elapsedMs"].as_u64().unwrap() * 1000 + 999);
    }
}

#[test]
fn progress_contract_failed_assertion_before_reaping_never_counts_a_kill() {
    let root = tempfile::tempdir().unwrap();
    let mut progress = CrashProgress::create(root.path());
    progress.record(ProgressStage::MatrixStarted, 0, 0);
    progress.begin_case(true, false, 0);
    progress.record(ProgressStage::ChildKillRequested, 1, checkpoint_code("intent_published"));
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Same placement as the real kill/wait assertions: a failure prevents
        // entry into reaped. This pure contract does not own a native child.
        assert!(false, "synthetic wait/early-exit/checkpoint failure");
        progress.reaped(1, checkpoint_code("intent_published"));
    }));
    assert!(failed.is_err());
    assert_eq!(progress.confirmed_kills, 0);
}

#[test]
fn progress_contract_failed_assertion_or_copy_never_completes_a_case() {
    let root = tempfile::tempdir().unwrap();
    let mut progress = CrashProgress::create(root.path());
    progress.record(ProgressStage::MatrixStarted, 0, 0);
    progress.begin_case(true, false, 0);
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert!(false, "synthetic reopen/assertion/copy/hash failure");
        progress.completed();
    }));
    assert!(failed.is_err());
    assert_eq!(progress.completed_cases, 0);
}

#[test]
fn progress_contract_unwind_records_only_closed_failure_and_keeps_original_panic() {
    let root = tempfile::tempdir().unwrap();
    let result = std::panic::catch_unwind(|| {
        let mut progress = CrashProgress::create(root.path());
        progress.record(ProgressStage::MatrixStarted, 0, 0);
        panic!("synthetic-original-assertion");
    });
    assert_eq!(result.unwrap_err().downcast_ref::<&str>(), Some(&"synthetic-original-assertion"));
    let lines = fs::read_to_string(root.path().join("progress.jsonl")).unwrap();
    assert!(!lines.contains("synthetic-original-assertion"));
    let final_event: serde_json::Value = serde_json::from_str(lines.lines().last().unwrap()).unwrap();
    assert_eq!(final_event["stage"], 14);
    assert_eq!(final_event["failureCategory"], 1);
    assert_eq!(final_event["status"], 2);
    assert_eq!(final_event["completedCases"], 0);
    assert_eq!(final_event["confirmedKills"], 0);
}

#[test]
fn progress_contract_proof_io_failure_during_unwind_does_not_double_panic() {
    let root = tempfile::tempdir().unwrap();
    let result = std::panic::catch_unwind(|| {
        let mut progress = CrashProgress::create(root.path());
        progress.record(ProgressStage::MatrixStarted, 0, 0);
        // Replace only this synthetic contract's proof handle with read-only
        // access. Drop must ignore its write failure and preserve the unwind.
        progress.file = File::open(root.path().join("progress.jsonl")).unwrap();
        panic!("synthetic-original-after-readonly-handle");
    });
    assert_eq!(result.unwrap_err().downcast_ref::<&str>(), Some(&"synthetic-original-after-readonly-handle"));
}

struct OwnedChild(Child);
impl Drop for OwnedChild { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }

fn kill_at(root: &Path, action: &str, phase: &str, progress: &mut CrashProgress, ordinal: u8) {
    let marker = root.join("checkpoint");
    if marker.exists() { fs::remove_file(&marker).unwrap(); }
    let mut child = OwnedChild(Command::new(std::env::current_exe().unwrap())
        .args(["backup::recovery_crash_tests::native_crash_child", "--exact", "--ignored", "--nocapture"])
        .env("ZENTRA_RECOVERY_CRASH_ROOT", root)
        .env("ZENTRA_RECOVERY_CRASH_PHASE", phase)
        .env("ZENTRA_RECOVERY_CRASH_ACTION", action)
        .stdout(File::create(root.join(format!("child-{action}-{phase}.log"))).unwrap())
        .stderr(File::create(root.join(format!("child-{action}-{phase}-errors.log"))).unwrap())
        .spawn().unwrap());
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    let checkpoint = checkpoint_code(phase);
    progress.record(ProgressStage::ChildStarted, ordinal, checkpoint);
    loop {
        if fs::read_to_string(&marker).ok().as_deref() == Some(phase) { break; }
        if let Some(status) = child.0.try_wait().unwrap() { panic!("child exited before {phase}: {status}"); }
        assert!(std::time::Instant::now() < deadline, "child did not reach {phase}");
        std::thread::sleep(Duration::from_millis(20));
    }
    progress.record(ProgressStage::CheckpointObserved, ordinal, checkpoint);
    progress.record(ProgressStage::ChildKillRequested, ordinal, checkpoint);
    child.0.kill().unwrap();
    assert!(!child.0.wait().unwrap().success());
    progress.reaped(ordinal, checkpoint);
}

#[test]
#[ignore = "child entry point; selected only by the owned process-kill witness"]
fn native_crash_child() {
    assert_eq!(std::env::var("CIRCLECI").ok().as_deref(), Some("true"));
    assert!(cfg!(windows));
    let root = PathBuf::from(std::env::var_os("ZENTRA_RECOVERY_CRASH_ROOT").expect("isolated root"));
    assert_eq!(fs::read(root.join("synthetic-only.marker")).unwrap(), b"zentra-native-recovery-fixture-v1");
    let plan: CrashPlan = serde_json::from_slice(&fs::read(root.join("plan.json")).unwrap()).unwrap();
    let current = LocalStore::initialize(root.join("current")).unwrap();
    if std::env::var("ZENTRA_RECOVERY_CRASH_ACTION").unwrap() == "reopen" { return; }
    let archive = root.join("portable.zentra");
    if plan.complete {
        current.restore_backup_and_then(archive.to_str().unwrap(), env!("CARGO_PKG_VERSION"), || change_auxiliary(&current)).unwrap();
    } else {
        current.restore_company_snapshot(archive.to_str().unwrap(), || change_auxiliary(&current)).unwrap();
    }
}

#[test]
#[ignore = "real process kills require the disposable Windows CI native harness"]
fn native_crash_boundaries_restore_one_complete_profile_before_migration() {
    assert_eq!(std::env::var("CIRCLECI").ok().as_deref(), Some("true"));
    assert!(cfg!(windows));
    let proof = PathBuf::from(std::env::var_os("ZENTRA_RECOVERY_CRASH_PROOF").expect("fresh native evidence directory"));
    let proof = owned_progress_root(&proof);
    assert!(!proof.exists());
    fs::create_dir_all(&proof).unwrap();
    let mut progress = CrashProgress::create(&proof);
    progress.record(ProgressStage::MatrixStarted, 0, 0);
    let mut outcomes = Vec::new();
    for complete in [true, false] {
        for (recovery, boundaries) in [(false, RESTORE_BOUNDARIES), (true, ROLLBACK_BOUNDARIES)] {
            for (boundary, phase) in boundaries.iter().enumerate() {
                progress.begin_case(complete, recovery, boundary);
                // Short, retained fixture paths avoid Windows MAX_PATH surprises
                // and preserve the real files/logs even if an assertion fails.
                let case = proof.join(format!("c{:02}", outcomes.len()));
                fs::create_dir(&case).unwrap();
                let root = case.join("t");
                fs::create_dir(&root).unwrap();
                fs::write(root.join("synthetic-only.marker"), b"zentra-native-recovery-fixture-v1").unwrap();
                let (source, restored) = fixture(&root, "source", 220);
                progress.record(ProgressStage::SourceFixtureReady, 0, 0);
                let archive = source.create_backup(Some(root.join("portable.zentra").to_string_lossy().into()), env!("CARGO_PKG_VERSION")).unwrap();
                progress.record(ProgressStage::ArchiveReady, 0, 0);
                let (current, original) = fixture(&root, "current", 30);
                let auxiliary = auxiliary_fixture(&current);
                let installation = current.installation_id.clone();
                fs::write(root.join("plan.json"), serde_json::to_vec(&CrashPlan { original: original.clone(), restored: restored.clone(), auxiliary: auxiliary.clone(), complete }).unwrap()).unwrap();
                // Restore cannot consult the producer's profile or absolute paths.
                fs::rename(&source.data_dir, root.join("source-inaccessible")).unwrap();
                assert!(!source.data_dir.exists());
                progress.record(ProgressStage::FixturesReady, 0, 0);
                if recovery { kill_at(&root, "restore", "finalized", &mut progress, 1); kill_at(&root, "reopen", phase, &mut progress, 2); }
                else { kill_at(&root, "restore", phase, &mut progress, 1); }
                let reopened = LocalStore::initialize(current.data_dir.clone()).unwrap();
                let committed = !recovery && (*phase == "commit_published" || phase.starts_with("cleanup_"));
                let (expected, excluded) = if committed { (&restored, &original) } else { (&original, &restored) };
                assert_profile(&reopened, expected, excluded, !committed);
                assert_eq!(reopened.installation_id, installation);
                if committed { for name in AUXILIARY { assert_eq!(fs::read(reopened.data_dir.join(name)).unwrap(), format!("synthetic-new-{name}").as_bytes()); } }
                else { assert_auxiliary(&reopened, &auxiliary); }
                progress.record(ProgressStage::FirstReopenValidated, 0, 0);
                let second = LocalStore::initialize(current.data_dir.clone()).unwrap();
                assert_profile(&second, expected, excluded, !committed);
                assert_eq!(second.installation_id, installation);
                if committed { for name in AUXILIARY { assert_eq!(fs::read(second.data_dir.join(name)).unwrap(), format!("synthetic-new-{name}").as_bytes()); } }
                else { assert_auxiliary(&second, &auxiliary); }
                assert!(!reopened.data_dir.join(".zentra-restore-journal.json").exists());
                if complete { assert_eq!(fs::read_dir(&reopened.backups_dir).unwrap().count(), 1); }
                progress.record(ProgressStage::SecondReopenValidated, 0, 0);
                fs::copy(&archive, case.join("portable.zentra")).unwrap();
                reopened.connect().unwrap().execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
                fs::copy(&reopened.database_path, case.join("restored.sqlite3")).unwrap();
                copy_directory(&reopened.attachments_dir, &case.join("attachments")).unwrap();
                if complete { copy_directory(&reopened.backups_dir, &case.join("safety-backups")).unwrap(); }
                for name in AUXILIARY { if reopened.data_dir.join(name).is_file() { fs::copy(reopened.data_dir.join(name), case.join(name)).unwrap(); } }
                progress.record(ProgressStage::ArtifactsPreserved, 0, 0);
                let sha256 = |path: &Path| format!("{:x}", Sha256::digest(fs::read(path).unwrap()));
                outcomes.push(json!({"phase":phase, "recoveryInterrupted":recovery, "completeArchive":complete,
                    "result": if committed {"committed-new-profile"} else {"original-profile"}, "nativeSqliteValidated":true,
                    "nativeWorkspaceRead":true, "documentBase64Exact":true, "managedLogoBase64Exact":true, "auxiliaryExact":true, "secondCleanReopen":true,
                    "archiveSha256":sha256(&case.join("portable.zentra")), "databaseSha256":sha256(&case.join("restored.sqlite3")),
                    "artifactDirectory":case.file_name().unwrap().to_string_lossy()}));
                progress.completed();
            }
        }
    }
    fs::write(proof.join("outcomes.json"), serde_json::to_vec_pretty(&json!({"source":std::env::var("CIRCLE_SHA1").unwrap(),
        "synthetic":true, "nativeExecution":"compiled-library-harness-with-owned-child-kills", "packageExecuted":false,
        "actualTauriIpcExecuted":false, "physicalPowerLossVerified":false, "cases":outcomes})).unwrap()).unwrap();
    progress.finish();
}
