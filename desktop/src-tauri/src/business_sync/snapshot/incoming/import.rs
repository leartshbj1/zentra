//! Build and verify a separate database before installing a shared initial
//! revision into a fresh profile. Existing business work is never overwritten.
use super::*;
use rusqlite::Transaction;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rows {
    version: u32,
    rows: Vec<PortableRow>,
}
struct Built {
    _directory: tempfile::TempDir,
    store: LocalStore,
}

pub(in crate::business_sync::snapshot) fn require_fresh(connection: &Connection) -> AppResult<()> {
    // A brand-new installation has no settings row. Preserve an incomplete
    // setup too: saved company information is already the user's work.
    let configured: bool =
        connection.query_row("SELECT EXISTS(SELECT 1 FROM settings)", [], |r| r.get(0))?;
    let linked:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_binding) OR EXISTS(SELECT 1 FROM business_sync_baseline) OR EXISTS(SELECT 1 FROM business_sync_changes) OR EXISTS(SELECT 1 FROM business_sync_publication_intent) OR EXISTS(SELECT 1 FROM business_sync_cursor) OR EXISTS(SELECT 1 FROM business_sync_resolution_intent) OR EXISTS(SELECT 1 FROM business_sync_resolutions)",[],|r|r.get(0))?;
    if configured || linked {
        return Err(invalid("Ce profil contient déjà un dossier de travail. Utilisez un profil neuf pour rejoindre cette entreprise ; vos données actuelles sont conservées."));
    }
    // These are the built-in defaults of an unconfigured profile. Every other
    // business table must be empty, even if onboarding was never completed.
    let defaults = [
        "settings",
        "accounting_settings",
        "accounts",
        "vat_profiles",
        "reminder_settings",
        "reminder_templates",
        "payroll_contribution_definitions",
    ];
    for table in policy()?
        .tables
        .keys()
        .filter(|t| !defaults.contains(&t.as_str()))
    {
        let present: bool = connection.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {})", identifier(table)?),
            [],
            |r| r.get(0),
        )?;
        if present {
            return Err(invalid(
                "Ce profil contient des données locales. La réception n’a rien remplacé.",
            ));
        }
    }
    Ok(())
}
fn put_row(
    tx: &Transaction<'_>,
    row: PortableRow,
    rule: &crate::business_sync::TablePolicy,
) -> AppResult<()> {
    validate_row(&row.table, &row.row_json)?;
    let data: Value = serde_json::from_str(&row.row_json)?;
    let keys = data
        .as_object()
        .ok_or_else(|| invalid("La ligne reçue est illisible."))?
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    if keys != rule.columns.iter().cloned().collect() {
        return Err(invalid(
            "Une colonne reçue est absente, inconnue ou propre à un autre appareil.",
        ));
    }
    let source = row
        .source_rowid
        .parse::<i64>()
        .map_err(|_| invalid("La position d’origine de la ligne est invalide."))?;
    if source.to_string() != row.source_rowid {
        return Err(invalid(
            "La position d’origine de la ligne n’est pas canonique.",
        ));
    }
    let columns = rule
        .columns
        .iter()
        .map(|c| identifier(c))
        .collect::<AppResult<Vec<_>>>()?
        .join(",");
    let values = rule
        .columns
        .iter()
        .map(|c| format!("json_extract(?2,'$.{c}')"))
        .collect::<Vec<_>>()
        .join(",");
    let table = identifier(&row.table)?;
    tx.execute(
        &format!("INSERT INTO {table}(rowid,{columns}) SELECT ?1,{values}"),
        params![source, row.row_json],
    )?;
    let actual: (String, String) = tx.query_row(
        &format!(
            "SELECT {},{} FROM {table} r WHERE r.rowid=?",
            json_key("r", &rule.key)?,
            json_image("r", &rule.columns)?
        ),
        [source],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if actual.0 != row.key_json || actual.1 != row.row_json {
        return Err(invalid(
            "L’import modifierait une ligne ou son ordre. La base de travail est conservée.",
        ));
    }
    Ok(())
}
fn copy_documents(folder: &Path, built: &LocalStore, files: &[FrozenFile]) -> AppResult<()> {
    for file in files {
        validate_storage_path(&file.path)?;
        let source = folder.join("files").join(&file.sha256);
        if fingerprint_file(&source)? != (file.sha256.clone(), file.size_bytes) {
            return Err(invalid("Un document reçu est incomplet ou altéré."));
        }
        let destination = built.data_dir.join(&file.path);
        fs::create_dir_all(
            destination
                .parent()
                .ok_or_else(|| invalid("L’emplacement du document est invalide."))?,
        )?;
        let mut target = create_file(&destination)?;
        std::io::copy(&mut File::open(source)?, &mut target)?;
        target.sync_all()?;
        if fingerprint_file(&destination)? != (file.sha256.clone(), file.size_bytes) {
            return Err(invalid("La copie du document a été interrompue."));
        }
    }
    Ok(())
}
fn build(target: &LocalStore, head: &Head, folder: &Path) -> AppResult<Built> {
    let (manifest, file_manifest) = head.validate(&head.receipt.organization_id)?;
    if manifest.version != 3 {
        return Err(invalid("Repréparez l’historique avec une version qui conserve l’ordre des événements avant de rejoindre l’entreprise."));
    }
    let complete: PublicationReceipt =
        serde_json::from_slice(&read(&folder.join("received.json"), HEAD_BYTES)?)?;
    if complete != head.receipt {
        return Err(invalid(
            "Terminez la réception de tous les documents avant l’import.",
        ));
    }
    let files = catalog(folder, &file_manifest)?;
    let directory = tempfile::Builder::new()
        .prefix("shared-import-")
        .tempdir_in(&target.data_dir)?;
    let built = LocalStore::initialize(directory.path().join("profile"))?;
    copy_documents(folder, &built, &files)?;
    let mut connection = built.connect()?;
    // This connection only addresses the new disposable profile. Never disable
    // guards or constraints on the user's working connection.
    connection.pragma_update(None, "foreign_keys", false)?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let triggers = tx
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    for (name, _) in &triggers {
        tx.execute_batch(&format!("DROP TRIGGER {}", identifier(name)?))?;
    }
    for table in policy()?.tables.keys() {
        tx.execute(&format!("DELETE FROM {}", identifier(table)?), [])?;
    }
    let contract = policy()?;
    for (index, chunk) in manifest.chunks.iter().enumerate() {
        let bytes = read(
            &folder.join("rows").join(format!("{index:04}.json")),
            CHUNK_BYTES as u64,
        )?;
        if bytes.len() as u64 != chunk.size_bytes || digest(&bytes) != chunk.sha256 {
            return Err(invalid("Un fragment d’historique reçu est altéré."));
        }
        let contents: Rows = serde_json::from_slice(&bytes)?;
        if contents.version != 2 || contents.rows.len() as u64 != chunk.row_count {
            return Err(invalid("Le nombre de lignes reçues est incohérent."));
        }
        for row in contents.rows {
            let rule = contract
                .tables
                .get(&row.table)
                .ok_or_else(|| invalid("Une table reçue ne peut pas être importée."))?;
            put_row(&tx, row, rule)?;
        }
    }
    for (table, expected) in &manifest.tables {
        let actual: u64 = tx.query_row(
            &format!("SELECT COUNT(*) FROM {}", identifier(table)?),
            [],
            |r| r.get(0),
        )?;
        if actual != *expected {
            return Err(invalid(
                "L’import ne contient pas toutes les lignes attendues.",
            ));
        }
    }
    let foreign_keys: i64 =
        tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    if foreign_keys != 0 {
        return Err(invalid("L’historique contient une relation incohérente."));
    }
    let audit = crate::audit::verify_audit_chain(&tx)?;
    if audit["entries"] != head.receipt.audit_entries
        || audit["last_hash"] != json!(head.receipt.last_audit_hash)
    {
        return Err(invalid(
            "L’audit importé ne correspond pas au reçu de publication.",
        ));
    }
    for (_, sql) in &triggers {
        tx.execute_batch(sql)?;
    }
    // Store this device's capture epoch separately from the server's initial
    // history generation. Nothing in this import acknowledges later changes.
    tx.execute(
        "INSERT INTO business_sync_binding VALUES(1,?,?,?,1,?)",
        params![
            head.receipt.organization_id,
            target.installation_id,
            Uuid::new_v4().to_string(),
            now_iso()
        ],
    )?;
    tx.execute(
        "INSERT INTO business_sync_baseline VALUES(1,?,?,?,?,'received',?)",
        params![
            head.receipt.organization_id,
            head.receipt.generation,
            head.receipt.transfer_id,
            serde_json::to_string(&head.receipt)?,
            now_iso()
        ],
    )?;
    install_capture_triggers(&tx)?;
    tx.execute(
        "INSERT INTO shared_numbering_binding VALUES(1,?,?)",
        params![head.receipt.organization_id, now_iso()],
    )?;
    tx.commit()?;
    connection.pragma_update(None, "foreign_keys", true)?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(invalid(
            "La base importée n’a pas passé le contrôle d’intégrité.",
        ));
    }
    // Validate the original registered XML/ZIP against their rows, without
    // regenerating any historical document or modifying issued snapshots.
    freeze_registered_exports(
        &connection,
        &built.exports_dir,
        &directory.path().join("checked-exports"),
    )?;
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    drop(connection);
    Ok(Built {
        _directory: directory,
        store: built,
    })
}
pub(super) fn install_received(
    store: &LocalStore,
    organization: &str,
    id: &str,
    ensure_current: impl Fn() -> AppResult<()>,
) -> AppResult<Value> {
    if !valid_id(id) {
        return Err(invalid("Choisissez un historique reçu valide."));
    }
    let _guard = store.lock()?;
    ensure_current()?;
    if crate::cloud_backup::is_restoring() {
        return Err(invalid("Attendez la fin de la restauration."));
    }
    let folder = store
        .data_dir
        .join("business-history")
        .join(digest(organization.as_bytes()))
        .join(id);
    for path in [
        store.data_dir.join("business-history"),
        folder.parent().unwrap().to_path_buf(),
        folder.clone(),
    ] {
        if !regular_metadata(&path)?.is_dir() {
            return Err(invalid("Le dossier reçu est invalide."));
        }
    }
    let head: Head = serde_json::from_slice(&read(&folder.join("history.json"), HEAD_BYTES)?)?;
    head.validate(organization)?;
    if head.receipt.transfer_id != id {
        return Err(invalid(
            "La révision reçue ne correspond pas au dossier choisi.",
        ));
    }
    let connection = store.connect()?;
    let existing:Option<String>=connection.query_row("SELECT receipt_json FROM business_sync_baseline WHERE id=1 AND organization_id=? AND source_transfer_id=?",params![organization,id],|r|r.get(0)).optional()?;
    if let Some(existing) = existing {
        if serde_json::from_str::<PublicationReceipt>(&existing)? == head.receipt {
            return Ok(
                json!({"state":"history_installed","transfer_id":id,"already_installed":true,"replication_active":false}),
            );
        }
        return Err(invalid("Le reçu du profil de travail est incohérent."));
    }
    require_fresh(&connection)?;
    drop(connection);
    let staged = build(store, &head, &folder)?;
    ensure_current()?;
    // All ordinary business writers share the profile lock. Check freshness
    // again immediately before the reversible installation.
    require_fresh(&store.connect()?)?;
    let safety = store.install_shared_initial_history(
        &staged.store.database_path,
        &staged.store.attachments_dir,
        &staged.store.exports_dir,
    )?;
    Ok(
        json!({"state":"history_installed","transfer_id":id,"rows":head.receipt.row_count,"files":head.receipt.file_count,"safety_backup":safety.to_string_lossy(),"replication_active":false}),
    )
}
#[tauri::command]
pub async fn import_business_history(
    state: State<'_, LocalStore>,
    transfer_id: String,
) -> Result<Value, String> {
    let store = state.inner().clone();
    let lease = crate::business_sync::cycle::acquire(&store).map_err(command_error)?;
    let session = project_sync_session(&store)
        .await
        .map_err(command_error)?
        .ok_or_else(|| "Connectez votre compte avant de rejoindre l’entreprise.".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        install_received(&store, &session.organization_id, &transfer_id, || {
            lease.ensure_running()?;
            session.ensure_current_for(&store)
        })
    })
    .await
    .map_err(|_| "L’import a été interrompu.".to_owned())?
    .map_err(command_error)
}
