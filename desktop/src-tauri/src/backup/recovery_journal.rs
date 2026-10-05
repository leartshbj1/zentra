//! Local restore intent. Paths are derived here, never deserialized from a journal.
//! A pending intent always rolls back; only an atomically published commit keeps
//! the new profile. Disk presence makes rollback replayable after every rename.
use super::*;
use sha2::{Digest, Sha256};
use std::{cell::{Cell, RefCell}, marker::PhantomData, rc::Rc};

const JOURNAL: &str = ".zentra-restore-journal.json";
const JOURNAL_LIMIT: u64 = 16 * 1024;
const AUXILIARY_FILES: &[&str] = &[
    "company-collaboration.json", "company-sync-baseline.json",
    "company-sync-reference.zentra", "cloud-backup-state.json",
    "backup-status.json", "joined-company-copy.json",
];

thread_local! {
    // A synchronous finalizer alone may use its exact restore generation.
    // This is neither a global bypass nor transferable to another worker.
    static OWNERS: RefCell<Vec<(PathBuf, String)>> = const { RefCell::new(Vec::new()) };
}

struct RecoveryOwner {
    root: PathBuf,
    token: String,
    _not_send: PhantomData<Rc<()>>,
}

impl RecoveryOwner {
    fn acquire(root: &Path, token: &str) -> Self {
        OWNERS.with(|owners| owners.borrow_mut().push((root.to_path_buf(), token.into())));
        Self { root: root.to_path_buf(), token: token.into(), _not_send: PhantomData }
    }
}

impl Drop for RecoveryOwner {
    fn drop(&mut self) {
        OWNERS.with(|owners| {
            let mut owners = owners.borrow_mut();
            if let Some(index) = owners.iter().rposition(|(root, token)| root == &self.root && token == &self.token) {
                owners.remove(index);
            }
        });
    }
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase { Pending, Committed, RolledBack }

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Auxiliary { name: String, bytes: Option<u64>, sha256: Option<String> }

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    format: String, version: u32, token: String, phase: Phase,
    complete_archive: bool, auxiliary: Vec<Auxiliary>,
}

pub(super) struct RecoveryJournal {
    root: PathBuf,
    intent: Intent,
    pub(super) database_path: PathBuf,
    pub(super) attachments_dir: PathBuf,
    pub(super) staged_database: PathBuf,
    pub(super) staged_attachments: PathBuf,
    pub(super) old_database: PathBuf,
    pub(super) old_attachments: PathBuf,
    auxiliary_dir: PathBuf,
    _owner: Option<RecoveryOwner>,
    committed: Cell<bool>,
}

fn blocked() -> AppError {
    AppError::Restore("Une restauration doit être reprise avant de rouvrir l’entreprise. Les fichiers disponibles sont conservés. Fermez puis rouvrez Zentra. Si le problème persiste, contactez le support sans supprimer le dossier local.".into())
}

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))] { metadata.file_type().is_symlink() }
}

fn ordinary(path: &Path, directory: bool) -> AppResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !linked(&metadata) && metadata.is_dir() == directory
            && (directory || metadata.is_file()) => Ok(true),
        Ok(_) => Err(blocked()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn admit_database(path: &Path) -> AppResult<()> {
    ordinary(path, false)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        ordinary(&PathBuf::from(format!("{}{}", path.display(), suffix)), false)?;
    }
    Ok(())
}

pub(super) fn require_business_access(root: &Path) -> AppResult<()> {
    if !ordinary(root, true)? { return Err(blocked()); }
    admit_database(&root.join("helvichantier.sqlite3"))?;
    let path = root.join(JOURNAL);
    if !ordinary(&path, false)? { return Ok(()); }
    if fs::metadata(&path)?.len() > JOURNAL_LIMIT { return Err(blocked()); }
    let intent: Intent = serde_json::from_reader(File::open(path)?).map_err(|_| blocked())?;
    let journal = RecoveryJournal::from_intent(root, intent)?;
    let owned = OWNERS.with(|owners| owners.borrow().iter().any(|(directory, token)|
        directory == root && token == &journal.intent.token));
    if journal.intent.phase != Phase::Pending {
        // Durable commit/rollback already selected a complete profile. Deferred
        // cleanup deletes only superseded files and cannot discard new writes.
        if !ordinary(&journal.database_path, false)? || !ordinary(&journal.attachments_dir, true)? { return Err(blocked()); }
        return Ok(());
    }
    if owned { Ok(()) } else { Err(blocked()) }
}

pub(super) fn require_statement_access(root: &Path) -> AppResult<()> {
    // Existing connections may move to another worker or prepare later SQL.
    // Ordinary statements need only this cheap durable-journal presence check;
    // a pending generation rechecks its exact synchronous owner admission.
    if ordinary(&root.join(JOURNAL), false)? { require_business_access(root) } else { Ok(()) }
}

fn tree(path: &Path) -> AppResult<()> {
    if !ordinary(path, true)? { return Ok(()); }
    for entry in WalkDir::new(path).follow_links(false) {
        let entry = entry.map_err(|_| blocked())?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if linked(&metadata) || (!metadata.is_dir() && !metadata.is_file()) { return Err(blocked()); }
    }
    Ok(())
}

fn synchronize(path: &Path) -> AppResult<()> {
    if ordinary(path, false)? { OpenOptions::new().read(true).write(true).open(path)?.sync_all()?; }
    Ok(())
}

fn synchronize_tree(path: &Path) -> AppResult<()> {
    tree(path)?;
    if !ordinary(path, true)? { return Ok(()); }
    for entry in WalkDir::new(path).follow_links(false) {
        let entry = entry.map_err(|_| blocked())?;
        if entry.file_type().is_file() { OpenOptions::new().read(true).write(true).open(entry.path())?.sync_all()?; }
    }
    Ok(())
}

fn synchronize_directory(path: &Path) -> AppResult<()> {
    // Match the existing cross-platform NamedTempFile + sync_all + persist
    // primitive. Unix also permits syncing the containing directory. This is
    // process-crash recovery; physical power-loss durability needs OS testing.
    #[cfg(unix)] File::open(path)?.sync_all()?;
    #[cfg(not(unix))] let _ = path;
    Ok(())
}

fn digest(path: &Path) -> AppResult<(u64, String)> {
    if !ordinary(path, false)? { return Err(blocked()); }
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        bytes = bytes.checked_add(count as u64).ok_or_else(blocked)?;
        digest.update(&buffer[..count]);
    }
    Ok((bytes, format!("{:x}", digest.finalize())))
}

impl RecoveryJournal {
    fn from_intent(root: &Path, intent: Intent) -> AppResult<Self> {
        if !ordinary(root, true)? { return Err(blocked()); }
        let token = Uuid::parse_str(&intent.token).map_err(|_| blocked())?;
        if token.to_string() != intent.token || token.get_version_num() != 4
            || token.get_variant() != uuid::Variant::RFC4122 || intent.format != "zentra-local-restore"
            || intent.version != 1 || intent.auxiliary.len() != AUXILIARY_FILES.len() {
            return Err(blocked());
        }
        for (entry, name) in intent.auxiliary.iter().zip(AUXILIARY_FILES) {
            if entry.name != *name || entry.bytes.is_some() != entry.sha256.is_some()
                || entry.sha256.as_ref().is_some_and(|value| value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())) {
                return Err(blocked());
            }
        }
        // Fixed direct children of the admitted LocalStore root only.
        let committed = intent.phase == Phase::Committed;
        Ok(Self {
            root: root.to_path_buf(), database_path: root.join("helvichantier.sqlite3"),
            attachments_dir: root.join("attachments"),
            staged_database: root.join(format!(".restore-{token}.sqlite3")),
            staged_attachments: root.join(format!(".restore-attachments-{token}")),
            old_database: root.join(format!(".before-restore-{token}.sqlite3")),
            old_attachments: root.join(format!(".before-restore-attachments-{token}")),
            auxiliary_dir: root.join(format!(".restore-state-{token}")), intent, _owner: None, committed: Cell::new(committed),
        })
    }

    pub(super) fn begin(root: &Path, complete_archive: bool) -> AppResult<Self> {
        if !ordinary(root, true)? { return Err(blocked()); }
        recover(root)?;
        if !ordinary(&root.join("helvichantier.sqlite3"), false)?
            || !ordinary(&root.join("attachments"), true)? { return Err(blocked()); }
        tree(&root.join("attachments"))?;
        let token = Uuid::new_v4().to_string();
        let auxiliary_dir = root.join(format!(".restore-state-{token}"));
        fs::create_dir(&auxiliary_dir)?;
        let mut auxiliary = Vec::new();
        for name in AUXILIARY_FILES {
            let active = root.join(name);
            let record = if ordinary(&active, false)? {
                let saved = auxiliary_dir.join(name);
                fs::copy(&active, &saved)?;
                synchronize(&saved)?;
                let (bytes, sha256) = digest(&saved)?;
                Auxiliary { name: (*name).into(), bytes: Some(bytes), sha256: Some(sha256) }
            } else { Auxiliary { name: (*name).into(), bytes: None, sha256: None } };
            auxiliary.push(record);
        }
        synchronize_directory(&auxiliary_dir)?;
        let mut journal = Self::from_intent(root, Intent {
            format: "zentra-local-restore".into(), version: 1, token,
            phase: Phase::Pending, complete_archive, auxiliary,
        })?;
        journal.write(Phase::Pending)?;
        journal._owner = Some(RecoveryOwner::acquire(root, &journal.intent.token));
        checkpoint(root, "intent_published");
        Ok(journal)
    }

    fn write(&self, phase: Phase) -> AppResult<()> {
        // Refuse a link at the fixed target before persist replaces it.
        ordinary(&self.root.join(JOURNAL), false)?;
        let mut file = tempfile::Builder::new().prefix(".restore-journal-").tempfile_in(&self.root)?;
        let value = Intent { format: self.intent.format.clone(), version: self.intent.version,
            token: self.intent.token.clone(), phase, complete_archive: self.intent.complete_archive,
            auxiliary: self.intent.auxiliary.iter().map(|entry| Auxiliary {
                name: entry.name.clone(), bytes: entry.bytes, sha256: entry.sha256.clone(),
            }).collect() };
        serde_json::to_writer(file.as_file_mut(), &value)?;
        file.as_file().sync_all()?;
        file.persist(self.root.join(JOURNAL)).map_err(|error| AppError::Io(error.error))?;
        if phase == Phase::Committed { self.committed.set(true); }
        synchronize_directory(&self.root)
    }

    fn admitted_paths(&self) -> AppResult<()> {
        for path in [&self.database_path, &self.staged_database, &self.old_database] { admit_database(path)?; }
        for path in [&self.attachments_dir, &self.staged_attachments, &self.old_attachments, &self.auxiliary_dir] { tree(path)?; }
        for name in AUXILIARY_FILES { ordinary(&self.root.join(name), false)?; }
        Ok(())
    }

    fn checked_auxiliary(&self) -> AppResult<()> {
        if !ordinary(&self.auxiliary_dir, true)? { return Err(blocked()); }
        for entry in &self.intent.auxiliary {
            if let (Some(bytes), Some(sha256)) = (entry.bytes, entry.sha256.as_ref()) {
                if digest(&self.auxiliary_dir.join(&entry.name))? != (bytes, sha256.clone()) { return Err(blocked()); }
            } else if self.auxiliary_dir.join(&entry.name).exists() { return Err(blocked()); }
        }
        // No arbitrary local file may be deleted via the saved-state directory.
        for entry in fs::read_dir(&self.auxiliary_dir)? {
            let entry = entry?;
            if !AUXILIARY_FILES.iter().any(|name| entry.file_name().as_os_str() == std::ffi::OsStr::new(*name)) { return Err(blocked()); }
        }
        Ok(())
    }

    fn cleanup(&self) -> AppResult<()> {
        self.admitted_paths()?;
        for path in [&self.staged_database, &self.old_database] {
            if ordinary(path, false)? { fs::remove_file(path)?; }
            for suffix in ["-wal", "-shm", "-journal"] {
                let sidecar = PathBuf::from(format!("{}{}", path.display(), suffix));
                if ordinary(&sidecar, false)? { fs::remove_file(sidecar)?; }
            }
        }
        checkpoint(&self.root, "cleanup_database_removed");
        for path in [&self.staged_attachments, &self.old_attachments] {
            if ordinary(path, true)? { fs::remove_dir_all(path)?; }
        }
        checkpoint(&self.root, "cleanup_attachments_removed");
        if ordinary(&self.auxiliary_dir, true)? {
            for entry in fs::read_dir(&self.auxiliary_dir)? {
                let entry = entry?;
                if !AUXILIARY_FILES.iter().any(|name| entry.file_name().as_os_str() == std::ffi::OsStr::new(*name)) { return Err(blocked()); }
            }
            for name in AUXILIARY_FILES {
                let path = self.auxiliary_dir.join(name);
                if ordinary(&path, false)? { fs::remove_file(path)?; }
                checkpoint(&self.root, &format!("cleanup_auxiliary_file_{name}"));
            }
            fs::remove_dir(&self.auxiliary_dir)?;
        }
        checkpoint(&self.root, "cleanup_auxiliary_removed");
        fs::remove_file(self.root.join(JOURNAL))?;
        checkpoint(&self.root, "cleanup_journal_removed");
        synchronize_directory(&self.root)
    }

    pub(super) fn rollback(&self) -> AppResult<()> {
        let current: Intent = serde_json::from_reader(File::open(self.root.join(JOURNAL))?).map_err(|_| blocked())?;
        if current.token != self.intent.token || current.phase != Phase::Pending { return Err(blocked()); }
        self.admitted_paths()?;
        self.checked_auxiliary()?;
        let original_database = if ordinary(&self.old_database, false)? { &self.old_database } else { &self.database_path };
        let original_attachments = if ordinary(&self.old_attachments, true)? { &self.old_attachments } else { &self.attachments_dir };
        if !ordinary(original_database, false)? || !ordinary(original_attachments, true)? { return Err(blocked()); }
        // Admit the previous database before deleting any newly installed data.
        // Missing historical attachments are preserved as they were; recovery
        // must not impose a new completeness rule on the previous company.
        validate_database(original_database)?;
        if ordinary(&self.old_database, false)? {
            remove_sqlite_sidecars(&self.database_path)?;
            if ordinary(&self.database_path, false)? { fs::remove_file(&self.database_path)?; }
            checkpoint(&self.root, "rollback_new_database_removed");
            fs::rename(&self.old_database, &self.database_path)?;
        }
        checkpoint(&self.root, "rollback_database_restored");
        if ordinary(&self.old_attachments, true)? {
            if ordinary(&self.attachments_dir, true)? { fs::remove_dir_all(&self.attachments_dir)?; }
            checkpoint(&self.root, "rollback_new_attachments_removed");
            fs::rename(&self.old_attachments, &self.attachments_dir)?;
        }
        checkpoint(&self.root, "rollback_attachments_restored");
        for entry in &self.intent.auxiliary {
            let active = self.root.join(&entry.name);
            if entry.bytes.is_some() {
                let mut file = tempfile::NamedTempFile::new_in(&self.root)?;
                io::copy(&mut File::open(self.auxiliary_dir.join(&entry.name))?, file.as_file_mut())?;
                file.as_file().sync_all()?;
                file.persist(&active).map_err(|error| AppError::Io(error.error))?;
            } else if ordinary(&active, false)? { fs::remove_file(active)?; }
            checkpoint(&self.root, &format!("rollback_auxiliary_{}", entry.name));
        }
        synchronize(&self.database_path)?;
        synchronize_tree(&self.attachments_dir)?;
        self.write(Phase::RolledBack)?;
        checkpoint(&self.root, "rollback_published");
        self.cleanup()
    }

    pub(super) fn synchronize_staged(&self) -> AppResult<()> {
        self.admitted_paths()?;
        synchronize(&self.staged_database)?;
        synchronize_tree(&self.staged_attachments)
    }

    pub(super) fn commit(&self) -> AppResult<()> {
        self.admitted_paths()?;
        synchronize(&self.database_path)?;
        synchronize_tree(&self.attachments_dir)?;
        for name in AUXILIARY_FILES { synchronize(&self.root.join(name))?; }
        self.write(Phase::Committed)?;
        checkpoint(&self.root, "commit_published");
        // A cleanup error cannot turn an already committed restoration into a
        // rollback. Keep the journal so the next startup can finish safely.
        self.cleanup()
    }

    pub(super) fn is_committed(&self) -> bool {
        self.committed.get()
    }
}

pub(super) fn recover(root: &Path) -> AppResult<()> {
    let path = root.join(JOURNAL);
    if !ordinary(&path, false)? {
        // A crash from an older version has no durable intent. Never create an
        // empty database over its hidden previous company.
        for entry in fs::read_dir(root)? {
            let name = entry?.file_name();
            let name = name.to_string_lossy();
            let token = name.strip_prefix(".before-restore-attachments-").or_else(||
                name.strip_prefix(".before-restore-").and_then(|name| name.strip_suffix(".sqlite3")));
            if token.is_some_and(|token| Uuid::parse_str(token).is_ok_and(|uuid|
                uuid.to_string() == token && uuid.get_version_num() == 4 && uuid.get_variant() == uuid::Variant::RFC4122)) {
                return Err(blocked());
            }
        }
        return Ok(());
    }
    if !ordinary(root, true)? { return Err(blocked()); }
    if fs::metadata(&path)?.len() > JOURNAL_LIMIT { return Err(blocked()); }
    let intent: Intent = serde_json::from_reader(File::open(&path)?).map_err(|_| blocked())?;
    let journal = RecoveryJournal::from_intent(root, intent)?;
    journal.admitted_paths()?;
    match journal.intent.phase {
        Phase::Pending => journal.rollback(),
        Phase::Committed | Phase::RolledBack => {
            if !ordinary(&journal.database_path, false)? || !ordinary(&journal.attachments_dir, true)? { return Err(blocked()); }
            validate_database(&journal.database_path)?;
            if journal.intent.phase == Phase::Committed && journal.intent.complete_archive {
                files::validate_files(&journal.database_path, &journal.attachments_dir)?;
            }
            journal.cleanup()
        }
    }
}

#[cfg(not(test))]
pub(super) fn checkpoint(_: &Path, _: &str) {}

#[cfg(test)]
thread_local! {
    static ONCE_CHECKPOINT: RefCell<Option<(String, Box<dyn FnOnce(&Path)>)>> = const { RefCell::new(None) };
}

#[cfg(test)]
pub(super) struct TestCheckpoint(PhantomData<Rc<()>>);

#[cfg(test)]
impl Drop for TestCheckpoint {
    fn drop(&mut self) { ONCE_CHECKPOINT.with(|hook| { hook.borrow_mut().take(); }); }
}

#[cfg(test)]
pub(super) fn once_test_checkpoint(phase: &str, action: impl FnOnce(&Path) + 'static) -> TestCheckpoint {
    ONCE_CHECKPOINT.with(|hook| {
        assert!(hook.borrow().is_none());
        *hook.borrow_mut() = Some((phase.into(), Box::new(action)));
    });
    TestCheckpoint(PhantomData)
}

#[cfg(test)]
pub(super) fn checkpoint(root: &Path, phase: &str) {
    let action = ONCE_CHECKPOINT.with(|hook| {
        let matches = hook.borrow().as_ref().is_some_and(|(expected, _)| expected == phase);
        if matches { hook.borrow_mut().take().map(|(_, action)| action) } else { None }
    });
    if let Some(action) = action { action(root); }
    if std::env::var("ZENTRA_RECOVERY_CRASH_PHASE").ok().as_deref() != Some(phase) { return; }
    let expected = std::env::var_os("ZENTRA_RECOVERY_CRASH_ROOT").map(PathBuf::from).expect("isolated crash root");
    assert_eq!(root, expected.join("current"));
    assert_eq!(fs::read(expected.join("synthetic-only.marker")).unwrap(), b"zentra-native-recovery-fixture-v1");
    let marker = expected.join("checkpoint");
    let mut file = File::create(marker).unwrap();
    file.write_all(phase.as_bytes()).unwrap();
    file.sync_all().unwrap();
    // Only the parent-owned disposable test child waits here. The parent kills
    // that exact process; no unwinding or in-memory rollback can help it.
    let deadline = std::time::Instant::now() + Duration::from_secs(180);
    while std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(100)); }
    std::process::exit(73);
}
