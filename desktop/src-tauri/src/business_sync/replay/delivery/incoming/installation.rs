//! Apply a verified subsequent revision within the working SQLite transaction.
//! Files have a durable rollback journal; the installed receipt decides recovery.
use super::*;
use rusqlite::{params, TransactionBehavior};
mod files;
pub(crate) mod journal;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Point {
    Prepared,
    IntentSaved,
    FileInstalled(usize),
    BeforeCommit,
    Committed,
}

pub(super) fn installed(
    store: &LocalStore,
    organization: &str,
    id: &str,
) -> AppResult<Option<String>> {
    let c = store.connect()?;
    let found:Option<(String,String)>=c.query_row("SELECT r.receipt_sha256,r.receipt_json FROM business_sync_installed_revisions r JOIN business_sync_baseline b ON b.organization_id=r.organization_id AND b.server_generation=r.generation WHERE r.organization_id=?1 AND r.transaction_id=?2",params![organization,id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((sha, raw)) = found else {
        return Ok(None);
    };
    if digest(raw.as_bytes()) != sha {
        return Err(invalid("Le reçu d’installation conservé est altéré."));
    }
    Ok(Some(raw))
}
pub(super) fn install(
    store: &LocalStore,
    folder: &Path,
    header: &Header,
    ensure_current: impl Fn() -> AppResult<()>,
    checkpoint: impl Fn(Point) -> AppResult<()>,
) -> AppResult<Value> {
    let reception = store.data_dir.join("business-reception");
    let binding_folder = reception.join(digest(&serde_json::to_vec(&header.binding)?));
    if folder != binding_folder.join(&header.entry.transaction_id) {
        return Err(invalid(
            "Le dossier reçu ne correspond pas à cette installation.",
        ));
    }
    for path in [
        store.data_dir.as_path(),
        reception.as_path(),
        binding_folder.as_path(),
        folder,
        &folder.join("changes"),
        &folder.join("positions"),
        &folder.join("files"),
    ] {
        if !snapshot::regular_metadata(path)?.is_dir() {
            return Err(invalid("Le dossier de réception est invalide."));
        }
    }
    verify_downloaded(folder, header)?;
    let raw = read(&folder.join("receipt.json"), 16 * 1024)?;
    let expected = Expected::from_authenticated_receipt(
        &raw,
        ReceiptRequest {
            organization: &header.binding.organization,
            generation: &header.binding.generation,
            transaction_id: &header.entry.transaction_id,
            source_revision: header.binding.revision,
            receipt_sha256: &header.entry.receipt_sha256,
        },
    )?;
    let bundle = read(&folder.join("bundle.json"), BUNDLE_BYTES as u64)?;
    let manifest = read(&folder.join("manifest.json"), 8 * 1024 * 1024)?;
    let decoder = Decoder::new(&bundle, &manifest, &expected)?;
    let context = decoder.context();
    let parts = decoder.bundle.parts.len();
    let chunks = decoder.manifest.chunks.clone();
    ensure_current()?;
    checkpoint(Point::Prepared)?;
    let _lock = store.lock()?;
    journal::recover(store)?;
    ensure_current()?;
    if crate::cloud_backup::is_restoring() {
        return Err(invalid("Attendez la fin de la restauration."));
    }
    if let Some(receipt) = installed(
        store,
        &header.binding.organization,
        &header.entry.transaction_id,
    )? {
        if receipt.as_bytes() != raw {
            return Err(invalid("Cette transaction a déjà un autre reçu installé."));
        }
        return installed_status(&receipt);
    }
    let outcome = (|| -> AppResult<Value> {
        let mut c = store.connect()?;
        // The filesystem intent may be removed after this commit. Make the WAL
        // decision durable before cleanup (NORMAL is not enough for the WAL).
        c.pragma_update(None, "synchronous", "FULL")?;
        c.pragma_update(None, "temp_store", "FILE")?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if Binding::from_connection(&tx, store, &header.binding.organization)? != header.binding {
            return Err(invalid("La révision de travail a changé."));
        }
        let rows = super::super::decoded_parts(
            decoder,
            (0..parts).map(|i| {
                Ok((
                    read(
                        &folder.join("changes").join(format!("{i:04}.json")),
                        CHUNK_BYTES as u64,
                    )?,
                    read(
                        &folder.join("positions").join(format!("{i:04}.json")),
                        POSITION_BYTES as u64,
                    )?,
                ))
            }),
        );
        let result = crate::business_sync::replay::apply_rows(&tx, store, &context, rows)?;
        let steps = files::plan(store, &tx, folder, &chunks)?;
        ensure_current()?;
        let intent = journal::Journal::prepare(store, header, steps)?;
        checkpoint(Point::IntentSaved)?;
        intent.apply(store, folder, &checkpoint)?;
        ensure_current()?;
        tx.execute(
            "INSERT INTO business_sync_installed_revisions VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                header.binding.organization,
                header.binding.generation,
                header.entry.revision,
                header.entry.transaction_id,
                header.entry.receipt_sha256,
                std::str::from_utf8(&raw).map_err(|_| invalid("Le reçu est illisible."))?,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        tx.execute("INSERT INTO business_sync_cursor VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET organization_id=excluded.organization_id,generation=excluded.generation,revision=excluded.revision",params![header.binding.organization,header.binding.generation,header.entry.revision])?;
        checkpoint(Point::BeforeCommit)?;
        ensure_current()?;
        intent.verify_installed_files(store)?;
        tx.commit()?;
        checkpoint(Point::Committed)?;
        Ok(
            json!({"state":"transaction_installed","transaction_id":header.entry.transaction_id,"revision":header.entry.revision,"changes":result.changes,"statements":result.statements,"native_effects":result.automatic,"source_state_sha256":result.before_sha256,"target_state_sha256":result.after_sha256,"installed":true,"acknowledged":false,"replication_active":false}),
        )
    })();
    let recovery = journal::recover(store);
    match (outcome, recovery) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (_, Err(error)) => Err(error),
    }
}
fn installed_status(raw: &str) -> AppResult<Value> {
    let receipt: Value = serde_json::from_str(raw)?;
    Ok(
        json!({"state":"transaction_installed","already_installed":true,"installed":true,"acknowledged":false,"receipt":receipt,"replication_active":false}),
    )
}

#[tauri::command]
pub async fn install_business_transaction(
    state: State<'_, LocalStore>,
    transaction_id: String,
) -> Result<Value, String> {
    let lease = crate::business_sync::cycle::acquire(state.inner()).map_err(command_error)?;
    if !uuid(&transaction_id) {
        return Err("Choisissez une transaction reçue valide.".into());
    }
    let store = state.inner().clone();
    let session = project_sync_session(&store)
        .await
        .map_err(command_error)?
        .ok_or_else(|| "Reconnectez votre compte pour installer les modifications.".to_owned())?;
    {
        let _lock = store.lock().map_err(command_error)?;
        journal::recover(&store).map_err(command_error)?;
        session.ensure_current_for(&store).map_err(command_error)?;
        if let Some(receipt) =
            installed(&store, &session.organization_id, &transaction_id).map_err(command_error)?
        {
            return installed_status(&receipt).map_err(command_error);
        }
    }
    let binding = Binding::read(&store, &session.organization_id).map_err(command_error)?;
    let after = binding.revision.to_string();
    let raw = fetch(
        &session,
        &store,
        &binding,
        &[
            ("generation", &binding.generation),
            ("after_revision", &after),
        ],
        64 * 1024,
    )
    .await
    .map_err(command_error)?;
    let discovery: Discovery = serde_json::from_slice(&raw)
        .map_err(|_| "La liste des révisions est illisible.".to_owned())?;
    discovery.validate(&binding).map_err(command_error)?;
    let entry = discovery
        .commits
        .first()
        .filter(|e| e.transaction_id == transaction_id)
        .cloned()
        .ok_or_else(|| {
            "Cette transaction n’est pas la prochaine révision à installer.".to_owned()
        })?;
    let folder = store
        .data_dir
        .join("business-reception")
        .join(digest(
            &serde_json::to_vec(&binding).map_err(|_| "Le dossier est illisible.".to_owned())?,
        ))
        .join(&transaction_id);
    let header = Header {
        version: 1,
        binding,
        entry,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        install(
            &store,
            &folder,
            &header,
            || session.ensure_current_for(&store),
            |_| Ok(()),
        )
    })
    .await
    .map_err(|_| "L’installation a été interrompue. La reprise protégera vos données.".to_owned())?
    .map_err(command_error)
}

#[cfg(test)]
mod tests;
