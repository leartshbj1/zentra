//! Authenticate a received next revision, prepare an isolated origin/remote
//! merge, and optionally install it with a durable receipt and whole-transaction ack.
use super::*;
use crate::business_sync::{outgoing, replay::reconciliation as merge};
mod atomic;
mod files;
mod install;

struct Revision {
    prepared: merge::Prepared,
    context: crate::business_sync::replay::Context,
    acknowledgement: Option<merge::Acknowledgement>,
    manifest_sha256: String,
    receipt: Vec<u8>,
    files: Option<files::Plan>,
}
impl Revision {
    fn summary(&self, header: &Header) -> Value {
        let mut value = self.prepared.summary();
        value["transaction_id"] = json!(header.entry.transaction_id);
        value["revision"] = json!(header.entry.revision);
        value["origin_transaction_verified"] = json!(self.acknowledgement.is_some());
        value["documents_verified"] = json!(self.files.is_some());
        value
    }
}

fn prepare(
    store: &LocalStore,
    folder: &Path,
    header: &Header,
    role: &str,
    ensure_current: impl Fn() -> AppResult<()>,
) -> AppResult<Value> {
    Ok(verify(store, folder, header, role, ensure_current)?.summary(header))
}
fn verify(
    store: &LocalStore,
    folder: &Path,
    header: &Header,
    role: &str,
    ensure_current: impl Fn() -> AppResult<()>,
) -> AppResult<Revision> {
    ensure_current()?;
    if Binding::read(store, &header.binding.organization)? != header.binding {
        return Err(invalid(
            "Le dossier de travail a changé avant la réconciliation.",
        ));
    }
    let root = store.data_dir.join("business-reception");
    let bound = root.join(digest(&serde_json::to_vec(&header.binding)?));
    if folder != bound.join(&header.entry.transaction_id) {
        return Err(invalid(
            "Le dossier reçu appartient à une autre installation.",
        ));
    }
    for path in [
        store.data_dir.as_path(),
        root.as_path(),
        bound.as_path(),
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
    let manifest = read(&folder.join("manifest.json"), 8 * 1024 * 1024)?;
    let decoder = Decoder::new(
        &read(&folder.join("bundle.json"), BUNDLE_BYTES as u64)?,
        &manifest,
        &expected,
    )?;
    let own = expected.receipt.origin_installation_id == store.installation_id
        && expected.receipt.capture_generation == header.binding.capture;
    let acknowledgement = if own {
        // Recreate from the immutable native evidence, not from the received
        // manifest. Compare every original byte before excluding a transaction.
        let outgoing = outgoing::prepare_next(store, &header.binding.organization, role)?
            .ok_or_else(|| {
                invalid("Le reçu ne correspond à aucune transaction locale en attente.")
            })?;
        if serde_json::to_vec(&outgoing.manifest)? != manifest {
            return Err(invalid(
                "Le manifeste reçu diffère de la première transaction locale.",
            ));
        }
        for i in 0..outgoing.manifest.chunks.len() {
            let original = read(
                &outgoing.folder.join(format!("{i:04}.json")),
                CHUNK_BYTES as u64,
            )?;
            if original
                != read(
                    &folder.join("changes").join(format!("{i:04}.json")),
                    CHUNK_BYTES as u64,
                )?
            {
                return Err(invalid(
                    "Les écritures reçues diffèrent du journal d’origine.",
                ));
            }
        }
        Some(merge::Acknowledgement {
            transaction_id: outgoing.manifest.transaction_id,
            first_sequence: integer(&outgoing.manifest.first_sequence)?,
            last_sequence: integer(&outgoing.manifest.last_sequence)?,
            change_count: outgoing.manifest.change_count,
        })
    } else {
        None
    };
    let context = decoder.context();
    let count = decoder.bundle.parts.len();
    let chunks = decoder.manifest.chunks.clone();
    let rows = super::super::decoded_parts(
        decoder,
        (0..count).map(|i| {
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
    let prepared = merge::prepare(
        store,
        &context,
        &header.binding.capture,
        acknowledgement.as_ref(),
        rows,
        &ensure_current,
    )?;
    ensure_current()?;
    let files = if prepared.candidate().is_ok() {
        Some(files::plan(&prepared, store, folder, &chunks)?)
    } else {
        None
    };
    ensure_current()?;
    Ok(Revision {
        prepared,
        context,
        acknowledgement,
        manifest_sha256: digest(&manifest),
        receipt: raw,
        files,
    })
}

#[tauri::command]
pub async fn prepare_business_reconciliation(
    state: State<'_, LocalStore>,
    transaction_id: String,
) -> Result<Value, String> {
    process(state.inner().clone(), transaction_id, false).await
}

#[tauri::command]
pub async fn reconcile_business_transaction(
    state: State<'_, LocalStore>,
    transaction_id: String,
) -> Result<Value, String> {
    process(state.inner().clone(), transaction_id, true).await
}
async fn process(
    store: LocalStore,
    transaction_id: String,
    install: bool,
) -> Result<Value, String> {
    if !uuid(&transaction_id) {
        return Err("Choisissez une transaction reçue valide.".into());
    }
    let session = project_sync_session(&store)
        .await
        .map_err(command_error)?
        .ok_or_else(|| "Reconnectez votre compte pour réconcilier les modifications.".to_owned())?;
    if install {
        let _lock = store.lock().map_err(command_error)?;
        session.ensure_current_for(&store).map_err(command_error)?;
        if let Some(raw) =
            super::installation::installed(&store, &session.organization_id, &transaction_id)
                .map_err(command_error)?
        {
            return install::already_installed(&store, &raw).map_err(command_error);
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
            "Cette transaction n’est pas la prochaine révision à réconcilier.".to_owned()
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
        if install {
            install::reconcile(
                &store,
                &folder,
                &header,
                &session.role,
                || session.ensure_current_for(&store),
                |_| Ok(()),
            )
        } else {
            prepare(&store, &folder, &header, &session.role, || {
                session.ensure_current_for(&store)
            })
        }
    })
    .await
    .map_err(|_| {
        "La préparation a été interrompue. Le dossier de travail est conservé.".to_owned()
    })?
    .map_err(command_error)
}

#[cfg(test)]
mod tests;
