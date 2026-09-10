//! Durable, private proposals. Saving is reversible and never contacts the
//! retirement endpoint, installs a database, or acknowledges captured events.
use super::super::installation::journal::{self, Stamp, Step};
use super::*;
use crate::business_sync::files as retained;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::Duration};

const MAX_TOTAL: u64 = 4 * 1024 * 1024 * 1024;
const MAX_METADATA: u64 = 64 * 1024 * 1024;

pub(super) mod installation;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Point {
    Flushed,
    Published,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Proposal {
    version: u32,
    resolution_id: String,
    binding: Binding,
    transaction_id: String,
    receipt_sha256: String,
    created_at: String,
    request: merge::resolution::Request,
    preview: Value,
    // Original row-image references remain available even when Shared was
    // chosen and those versions disappear from the proposed business rows.
    original_files: BTreeMap<String, Vec<retained::RetainedFile>>,
    #[serde(default)]
    replacement_files: BTreeMap<String, Vec<retained::RetainedFile>>,
    steps: Vec<Step>,
    final_files: Vec<Step>,
    prior_files: Vec<files::PriorFile>,
    artifacts: BTreeMap<String, Stamp>,
}

fn root(store: &LocalStore) -> AppResult<PathBuf> {
    let mut path = store.attachments_dir.clone();
    if !snapshot::regular_metadata(&path)?.is_dir() {
        return Err(invalid("Le stockage des propositions est invalide."));
    }
    for part in [retained::DIRECTORY, "resolutions"] {
        path.push(part);
        if !path.try_exists()? {
            fs::create_dir(&path)?;
            snapshot::sync_directory(path.parent().unwrap())?;
        }
        if !snapshot::regular_metadata(&path)?.is_dir() {
            return Err(invalid("Le dossier des propositions est invalide."));
        }
    }
    Ok(path)
}

fn artifact(folder: &Path, name: &str) -> AppResult<PathBuf> {
    let valid = matches!(
        name,
        "candidate.sqlite"
            | "model.sqlite"
            | "receipt.json"
            | "replacement.sqlite"
            | "replacement.json"
    ) || name.strip_prefix("blobs/").is_some_and(hash);
    if !valid {
        return Err(invalid("Une pièce de la proposition est inconnue."));
    }
    if name.starts_with("blobs/") && !snapshot::regular_metadata(&folder.join("blobs"))?.is_dir() {
        return Err(invalid(
            "Les documents de la proposition sont inaccessibles.",
        ));
    }
    Ok(folder.join(name))
}

fn budget(artifacts: &BTreeMap<String, Stamp>, extra: u64) -> AppResult<()> {
    let total = artifacts
        .values()
        .try_fold(extra, |n, s| n.checked_add(s.size_bytes));
    if artifacts.len() >= 50_003 || total.is_none_or(|n| n > MAX_TOTAL) {
        return Err(invalid(
            "Cette proposition dépasse la capacité de préparation locale.",
        ));
    }
    Ok(())
}

fn copy_blob(
    folder: &Path,
    artifacts: &mut BTreeMap<String, Stamp>,
    source: &Path,
    stamp: &Stamp,
) -> AppResult<()> {
    let name = format!("blobs/{}", stamp.sha256);
    if let Some(existing) = artifacts.get(&name) {
        if existing != stamp {
            return Err(invalid(
                "Deux versions du document ont des preuves incompatibles.",
            ));
        }
        return Ok(());
    }
    budget(artifacts, stamp.size_bytes)?;
    journal::copy_verified(source, &artifact(folder, &name)?, stamp)?;
    artifacts.insert(name, stamp.clone());
    Ok(())
}

fn copy_database(source: &rusqlite::Connection, path: &Path) -> AppResult<Stamp> {
    let pages: u64 = source.pragma_query_value(None, "page_count", |r| r.get(0))?;
    let size: u64 = source.pragma_query_value(None, "page_size", |r| r.get(0))?;
    if pages.checked_mul(size).is_none_or(|n| n > MAX_TOTAL / 2) {
        return Err(invalid("La base proposée est trop volumineuse."));
    }
    let mut c = rusqlite::Connection::open(path)?;
    rusqlite::backup::Backup::new(source, &mut c)?.run_to_completion(
        256,
        Duration::from_millis(1),
        None,
    )?;
    c.pragma_update(None, "journal_mode", "DELETE")?;
    c.pragma_update(None, "synchronous", "FULL")?;
    let integrity: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(invalid("La copie proposée est endommagée."));
    }
    drop(c);
    fs::OpenOptions::new().write(true).open(path)?.sync_all()?;
    journal::stamp(path)?.ok_or_else(|| invalid("La copie proposée a disparu."))
}

fn application_intent(
    folder: &Path,
    proposal: &Proposal,
    proposal_sha256: &str,
) -> AppResult<crate::business_sync::retirement::Intent> {
    use crate::business_sync::retirement::Intent;
    let plan: merge::replacements::Plan = serde_json::from_slice(&read(
        &artifact(folder, "replacement.json")?, MAX_METADATA,
    )?)?;
    if plan.version != 1 || plan.resolution_id != proposal.resolution_id
        || plan.original_capture_generation != proposal.binding.capture
        || plan.base_revision != proposal.binding.revision.checked_add(1).ok_or_else(|| invalid("La révision est trop élevée."))?
        || plan.occurred_at != proposal.created_at
        || Some(plan.decision_sha256.as_str()) != proposal.preview["decision_sha256"].as_str()
        || proposal.request.review_id != proposal.preview["review_id"]
        || plan.originals.is_empty()
    {
        return Err(invalid("Les remplacements sauvegardés ne correspondent pas à la proposition."));
    }
    let mut previous = 0;
    let mut seen = std::collections::BTreeSet::new();
    for original in &plan.originals {
        let first = integer(&original.first_sequence)?;
        let last = integer(&original.last_sequence)?;
        let choice = proposal.preview["decisions"][&original.transaction_id].as_str().unwrap_or("automatic");
        if first <= previous || last < first || !uuid(&original.transaction_id)
            || !hash(&original.original_sha256) || !seen.insert(&original.transaction_id)
            || original.choice != choice
        {
            return Err(invalid("Les opérations originales de la proposition ont changé."));
        }
        previous = last;
    }
    let value = Intent {
        format: "zentra-conflict-application".into(), version: 1,
        resolution_id: proposal.resolution_id.clone(), proposal_sha256: proposal_sha256.into(),
        organization_id: proposal.binding.organization.clone(), installation_id: proposal.binding.installation.clone(),
        generation: proposal.binding.generation.clone(), capture_generation: proposal.binding.capture.clone(),
        replacement_capture_generation: plan.replacement_capture_generation,
        source_revision: proposal.binding.revision, base_revision: plan.base_revision,
        received_transaction_id: proposal.transaction_id.clone(),
        first_sequence: plan.originals[0].first_sequence.clone(), last_sequence: previous.to_string(),
        receipt_sha256: proposal.receipt_sha256.clone(), review_id: proposal.request.review_id.clone(),
        decision_sha256: plan.decision_sha256,
    };
    Intent::read(&serde_json::to_vec(&value)?)
}

fn verify_artifacts(folder: &Path, proposal: &Proposal, proposal_sha256: &str) -> AppResult<()> {
    budget(&proposal.artifacts, 0)?;
    for name in ["candidate.sqlite", "model.sqlite", "receipt.json"] {
        if !proposal.artifacts.contains_key(name) {
            return Err(invalid("La proposition sauvegardée est incomplète."));
        }
    }
    if proposal.version == 2
        && ["replacement.sqlite", "replacement.json"]
            .iter()
            .any(|name| !proposal.artifacts.contains_key(*name))
    {
        return Err(invalid(
            "La proposition ne contient pas ses opérations de remplacement.",
        ));
    }
    for (name, expected) in &proposal.artifacts {
        if !hash(&expected.sha256)
            || journal::stamp(&artifact(folder, name)?)?.as_ref() != Some(expected)
        {
            return Err(invalid(
                "Une pièce sauvegardée de la proposition est absente ou altérée.",
            ));
        }
    }
    if proposal.artifacts["receipt.json"].sha256 != proposal.receipt_sha256 {
        return Err(invalid(
            "Le reçu sauvegardé ne correspond plus à la comparaison.",
        ));
    }
    if proposal.version == 2 {
        application_intent(folder, proposal, proposal_sha256)?;
    }
    for stamp in proposal
        .final_files
        .iter()
        .map(|s| &s.after)
        .chain(proposal.steps.iter().filter_map(|s| s.before.as_ref()))
        .chain(proposal.prior_files.iter().filter_map(|s| s.stamp.as_ref()))
    {
        if proposal.artifacts.get(&format!("blobs/{}", stamp.sha256)) != Some(stamp) {
            return Err(invalid(
                "Une version du plan documentaire manque dans la proposition.",
            ));
        }
    }
    for file in proposal
        .original_files
        .values()
        .chain(proposal.replacement_files.values())
        .flatten()
    {
        if proposal.artifacts.get(&format!("blobs/{}", file.sha256))
            != Some(&Stamp {
                sha256: file.sha256.clone(),
                size_bytes: file.size_bytes,
            })
        {
            return Err(invalid("Une version originale manque dans la proposition."));
        }
    }
    Ok(())
}

fn report(proposal: Proposal) -> Value {
    let mut result = proposal.preview;
    result["state"] = json!("resolution_saved");
    result["transaction_id"] = json!(proposal.transaction_id);
    result["saved"] = json!({"resolution_id":proposal.resolution_id,"created_at":proposal.created_at,
        "candidate_and_documents_preserved":true,"server_retirement_requested":false});
    result
}

// List metadata only. Loading a listed proposal still revalidates every byte
// and the current working files in read_saved. Never expose another session's
// choices, and never treat an unfinished .preparing directory as a proposal.
pub(super) fn list_saved(store: &LocalStore, header: &Header, review_id: &str) -> AppResult<Value> {
    let mut proposals = Vec::new();
    let mut scanned = 0usize;
    let mut metadata_bytes = 0u64;
    for entry in fs::read_dir(root(store)?)? {
        let entry = entry?;
        scanned += 1;
        if scanned > 1_000 {
            return Err(invalid("Le dossier contient trop de propositions. Son nettoyage est nécessaire avant de continuer."));
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !uuid(&name) {
            continue;
        }
        let folder = entry.path();
        if !snapshot::regular_metadata(&folder)?.is_dir() {
            continue;
        }
        let raw = read(&folder.join("proposal.json"), MAX_METADATA)?;
        metadata_bytes = metadata_bytes
            .checked_add(raw.len() as u64)
            .ok_or_else(|| invalid("Les propositions sont trop volumineuses."))?;
        if metadata_bytes > MAX_METADATA {
            return Err(invalid(
                "Les propositions sauvegardées sont trop volumineuses pour une seule consultation.",
            ));
        }
        if read(&folder.join("proposal.sha256"), 64)? != digest(&raw).as_bytes() {
            return Err(invalid(
                "Une proposition sauvegardée est altérée. Les choix doivent être vérifiés.",
            ));
        }
        let proposal: Proposal = serde_json::from_slice(&raw)?;
        if matches!(proposal.version, 1 | 2)
            && proposal.resolution_id == name
            && proposal.binding == header.binding
            && proposal.transaction_id == header.entry.transaction_id
            && proposal.receipt_sha256 == header.entry.receipt_sha256
            && proposal.request.review_id == review_id
            && proposal.preview["review_id"] == review_id
            && proposal.preview["state"] == "resolution_preview"
            && proposal.preview["can_install"] == false
        {
            proposals.push(json!({"resolution_id":name,"created_at":proposal.created_at}));
        }
    }
    proposals.sort_by(|a, b| {
        b["created_at"]
            .as_str()
            .cmp(&a["created_at"].as_str())
            .then_with(|| {
                a["resolution_id"]
                    .as_str()
                    .cmp(&b["resolution_id"].as_str())
            })
    });
    Ok(json!({"state":"saved_resolutions","review_id":review_id,"proposals":proposals}))
}

fn load_proposal(store: &LocalStore, id: &str) -> AppResult<(PathBuf, Proposal, String)> {
    if !uuid(id) {
        return Err(invalid("La proposition demandée est invalide."));
    }
    let folder = root(store)?.join(id);
    if !snapshot::regular_metadata(&folder)?.is_dir() {
        return Err(invalid("La proposition sauvegardée est introuvable."));
    }
    let raw = read(&folder.join("proposal.json"), MAX_METADATA)?;
    let seal = read(&folder.join("proposal.sha256"), 64)?;
    if seal != digest(&raw).as_bytes() {
        return Err(invalid(
            "La preuve de la proposition sauvegardée est altérée.",
        ));
    }
    let proposal: Proposal = serde_json::from_slice(&raw)?;
    if !matches!(proposal.version, 1 | 2) || proposal.resolution_id != id {
        return Err(invalid("La version ou la référence de la proposition est invalide."));
    }
    Ok((folder, proposal, digest(&raw)))
}

fn verify_comparison(proposal: &Proposal, header: &Header, review_id: &str) -> AppResult<()> {
    if proposal.binding != header.binding
        || proposal.transaction_id != header.entry.transaction_id
        || proposal.receipt_sha256 != header.entry.receipt_sha256
        || proposal.request.review_id != review_id
        || proposal.preview["review_id"] != review_id
        || proposal.preview["state"] != "resolution_preview"
        || proposal.preview["can_install"] != false
        || proposal.preview["documents_verified"] != true
    {
        return Err(invalid(
            "La proposition appartient à une autre comparaison. Actualisez les choix.",
        ));
    }
    Ok(())
}

pub(super) fn read_saved(
    store: &LocalStore,
    header: &Header,
    id: &str,
    review_id: &str,
) -> AppResult<Value> {
    let (folder, proposal, seal) = load_proposal(store, id)?;
    verify_comparison(&proposal, header, review_id)?;
    verify_artifacts(&folder, &proposal, &seal)?;
    files::verify_prior(store, &proposal.prior_files)?;
    Ok(report(proposal))
}

/// Freeze exactly the freshly verified comparison, not a later mutable choice.
/// The snapshot is checked again under SQLite's writer gate, after slow file
/// hashing, so another process cannot slip a business edit into the cutoff.
pub(super) fn freeze(
    store: &LocalStore,
    header: &Header,
    id: &str,
    review_id: &str,
    revision: &Revision,
    ensure_current: impl Fn() -> AppResult<()>,
) -> AppResult<crate::business_sync::retirement::Intent> {
    use crate::business_sync::retirement::durable;
    let (folder, proposal, seal) = load_proposal(store, id)?;
    verify_comparison(&proposal, header, review_id)?;
    if proposal.version != 2 {
        return Err(invalid("Enregistrez une nouvelle proposition avant de l’appliquer."));
    }
    verify_artifacts(&folder, &proposal, &seal)?;
    let intent = application_intent(&folder, &proposal, &seal)?;
    let _guard = store.lock()?;
    let mut c = store.connect()?;
    c.pragma_update(None, "synchronous", "FULL")?;
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    ensure_current()?;
    if Binding::from_connection(&tx, store, &header.binding.organization)? != header.binding {
        return Err(invalid("L’historique a changé pendant la préparation de la résolution."));
    }
    revision.prepared.verify_live(&tx, store, &revision.context)?;
    files::verify_prior(store, &proposal.prior_files)?;
    durable::prepare(&tx, &intent)?;
    ensure_current()?;
    tx.commit()?;
    Ok(intent)
}

/// Reauthorization after reconnect must not recalculate the frozen review id.
/// Check the original exact proposal and artifacts against its durable intent.
pub(super) fn verify_frozen(store: &LocalStore, intent: &crate::business_sync::retirement::Intent) -> AppResult<()> {
    let (folder, proposal, seal) = load_proposal(store, &intent.resolution_id)?;
    if proposal.version != 2 || seal != intent.proposal_sha256
        || proposal.preview["state"] != "resolution_preview"
        || proposal.preview["can_install"] != false
        || proposal.preview["documents_verified"] != true
        || application_intent(&folder, &proposal, &seal)? != *intent
    {
        return Err(invalid("La proposition protégée ne correspond plus aux choix enregistrés."));
    }
    verify_artifacts(&folder, &proposal, &seal)?;
    files::verify_prior(store, &proposal.prior_files)
}

// Caller holds the working-store gate and the authenticated cycle lease.
#[allow(clippy::too_many_arguments)]
pub(super) fn save(
    store: &LocalStore,
    header: &Header,
    id: &str,
    request: merge::resolution::Request,
    preview: &Value,
    prepared: &merge::Prepared,
    plan: &files::Plan,
    receipt: &[u8],
    ensure_current: impl Fn() -> AppResult<()>,
) -> AppResult<Value> {
    save_with_checkpoint(
        store,
        header,
        id,
        request,
        preview,
        prepared,
        plan,
        receipt,
        ensure_current,
        |_| Ok(()),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn save_with_checkpoint(
    store: &LocalStore,
    header: &Header,
    id: &str,
    request: merge::resolution::Request,
    preview: &Value,
    prepared: &merge::Prepared,
    plan: &files::Plan,
    receipt: &[u8],
    ensure_current: impl Fn() -> AppResult<()>,
    checkpoint: impl Fn(Point) -> AppResult<()>,
) -> AppResult<Value> {
    if !uuid(id) || digest(receipt) != header.entry.receipt_sha256 {
        return Err(invalid("La référence de la proposition est invalide."));
    }
    ensure_current()?;
    let directory = root(store)?;
    let destination = directory.join(id);
    if destination.try_exists()? {
        let existing = read_saved(store, header, id, &request.review_id)?;
        if existing["decision_sha256"] != preview["decision_sha256"] {
            return Err(invalid(
                "Cette proposition a déjà été sauvegardée avec d’autres choix.",
            ));
        }
        return Ok(existing);
    }
    let temporary = tempfile::Builder::new()
        .prefix(".preparing-")
        .tempdir_in(&directory)?;
    let folder = temporary.path();
    fs::create_dir(folder.join("blobs"))?;
    let mut artifacts = BTreeMap::new();
    let candidate = prepared.candidate()?.connect()?;
    prepared.verify_candidate(&candidate)?;
    for (name, source) in [
        ("candidate.sqlite", &candidate),
        ("model.sqlite", prepared.rows()),
    ] {
        let stamp = copy_database(source, &artifact(folder, name)?)?;
        budget(&artifacts, stamp.size_bytes)?;
        artifacts.insert(name.into(), stamp);
    }
    let receipt_path = artifact(folder, "receipt.json")?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&receipt_path)?;
    file.write_all(receipt)?;
    file.sync_all()?;
    drop(file);
    artifacts.insert(
        "receipt.json".into(),
        Stamp {
            sha256: digest(receipt),
            size_bytes: receipt.len() as u64,
        },
    );
    for final_file in &plan.final_files {
        ensure_current()?;
        let replacement = plan
            .steps
            .iter()
            .any(|s| s.root == final_file.root && s.path == final_file.path);
        let source = if replacement {
            plan.stage
                .path()
                .join("files")
                .join(&final_file.after.sha256)
        } else {
            journal::target(store, final_file, false)?
        };
        copy_blob(folder, &mut artifacts, &source, &final_file.after)?;
    }
    for step in &plan.steps {
        if let Some(before) = &step.before {
            copy_blob(
                folder,
                &mut artifacts,
                &journal::target(store, step, false)?,
                before,
            )?;
        }
    }
    for file in &plan.prior_files {
        ensure_current()?;
        if let Some(stamp) = &file.stamp {
            copy_blob(folder, &mut artifacts, &file.target(store)?, stamp)?;
        }
    }
    let mut original_files = BTreeMap::new();
    let mut q = prepared
        .rows()
        .prepare("SELECT sequence,table_name FROM pending_changes ORDER BY sequence")?;
    let mut rows = q.query([])?;
    while let Some(row) = rows.next()? {
        ensure_current()?;
        let table: String = row.get(1)?;
        if !retained::has_files(&table) {
            continue;
        }
        let images: (Option<String>, Option<String>) = candidate.query_row(
            "SELECT before_json,after_json FROM business_sync_changes WHERE sequence=?1",
            [row.get::<_, i64>(0)?],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        for raw in images.0.iter().chain(images.1.iter()) {
            let key = format!("{table}:{}", digest(raw.as_bytes()));
            if original_files.contains_key(&key) {
                continue;
            }
            let files = retained::retained_image_files(&store.data_dir, &table, raw)?;
            for file in &files {
                let stamp = Stamp {
                    sha256: file.sha256.clone(),
                    size_bytes: file.size_bytes,
                };
                copy_blob(
                    folder,
                    &mut artifacts,
                    &retained::retained_blob_path(&store.data_dir, &file.sha256, file.size_bytes)?,
                    &stamp,
                )?;
            }
            original_files.insert(key, files);
        }
    }
    if serde_json::to_value(plan.preview(store)?)? != preview["documents"] {
        return Err(invalid(
            "Les documents ont changé avant la sauvegarde des choix.",
        ));
    }
    for file in plan.replacement_images.values().flatten() {
        copy_blob(
            folder,
            &mut artifacts,
            &plan.stage.path().join("files").join(&file.sha256),
            &Stamp {
                sha256: file.sha256.clone(),
                size_bytes: file.size_bytes,
            },
        )?;
    }
    let occurred_at = chrono::Utc::now().to_rfc3339();
    let replacement = merge::replacements::prepare(prepared, store, id, preview, &occurred_at)?;
    for row in replacement
        .plan
        .transactions
        .iter()
        .flat_map(|t| &t.changes)
    {
        if !retained::has_files(&row.table) {
            continue;
        }
        for raw in row.before_json.iter().chain(row.after_json.iter()) {
            let image_key = format!("{}:{}", row.table, digest(raw.as_bytes()));
            let evidence = plan.replacement_images.get(&image_key).ok_or_else(|| {
                invalid("Une version de remplacement n’a pas sa preuve documentaire.")
            })?;
            for file in evidence {
                retained::retain_verified_image(
                    &replacement.store().data_dir,
                    &row.table,
                    raw,
                    file,
                    &folder.join("blobs").join(&file.sha256),
                )?;
            }
        }
    }
    let stamp = copy_database(
        &replacement.store().connect()?,
        &artifact(folder, "replacement.sqlite")?,
    )?;
    budget(&artifacts, stamp.size_bytes)?;
    artifacts.insert("replacement.sqlite".into(), stamp);
    let replacement_raw = serde_json::to_vec(&replacement.plan)?;
    budget(&artifacts, replacement_raw.len() as u64)?;
    let replacement_path = artifact(folder, "replacement.json")?;
    let mut replacement_file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&replacement_path)?;
    replacement_file.write_all(&replacement_raw)?;
    replacement_file.sync_all()?;
    drop(replacement_file);
    artifacts.insert(
        "replacement.json".into(),
        Stamp {
            sha256: digest(&replacement_raw),
            size_bytes: replacement_raw.len() as u64,
        },
    );
    let proposal = Proposal {
        version: 2,
        resolution_id: id.into(),
        binding: header.binding.clone(),
        transaction_id: header.entry.transaction_id.clone(),
        receipt_sha256: header.entry.receipt_sha256.clone(),
        created_at: occurred_at,
        request,
        preview: preview.clone(),
        original_files,
        replacement_files: plan.replacement_images.clone(),
        steps: plan.steps.clone(),
        final_files: plan.final_files.clone(),
        prior_files: plan.prior_files.clone(),
        artifacts,
    };
    let raw = serde_json::to_vec(&proposal)?;
    verify_artifacts(folder, &proposal, &digest(&raw))?;
    if raw.len() as u64 > MAX_METADATA {
        return Err(invalid("La proposition contient trop de détails."));
    }
    for (name, bytes) in [
        ("proposal.json", raw.clone()),
        ("proposal.sha256", digest(&raw).into_bytes()),
    ] {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(folder.join(name))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    snapshot::sync_directory(folder)?;
    checkpoint(Point::Flushed)?;
    ensure_current()?;
    fs::rename(folder, &destination)?;
    snapshot::sync_directory(&directory)?;
    checkpoint(Point::Published)?;
    read_saved(store, header, id, &proposal.request.review_id)
}
