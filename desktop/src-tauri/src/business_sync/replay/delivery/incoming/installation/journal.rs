//! Durable filesystem intent. SQLite's installed receipt decides recovery after
//! process exit; in-memory flags or successful download are never commit proof.
use super::*;
use serde::{Deserialize, Serialize};

const MAX_INTENT: u64 = 64 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(in crate::business_sync::replay::delivery::incoming) struct Stamp {
    pub sha256: String,
    pub size_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::business_sync::replay::delivery::incoming) struct Step {
    pub root: String,
    pub path: String,
    pub before: Option<Stamp>,
    pub after: Stamp,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::business_sync::replay::delivery::incoming) struct Journal {
    version: u32,
    installation_id: String,
    organization_id: String,
    generation: String,
    capture: String,
    source_revision: i64,
    revision: i64,
    transaction_id: String,
    receipt_sha256: String,
    stage: String,
    steps: Vec<Step>,
}
fn root(store: &LocalStore) -> PathBuf {
    store.data_dir.join("business-installation")
}
pub(in crate::business_sync::replay::delivery::incoming) fn target(
    store: &LocalStore,
    step: &Step,
    create: bool,
) -> AppResult<PathBuf> {
    if !matches!(step.root.as_str(), "attachments" | "exports") {
        return Err(invalid("Le document sort du stockage géré."));
    }
    snapshot::safe_relative(&step.path)?;
    if step
        .path
        .split('/')
        .next()
        .is_some_and(|p| p.eq_ignore_ascii_case(crate::business_sync::files::DIRECTORY))
    {
        return Err(invalid(
            "Le cache interne ne peut pas être remplacé par un document.",
        ));
    }
    let mut path = store.data_dir.join(&step.root);
    if !snapshot::regular_metadata(&path)?.is_dir() {
        return Err(invalid("Le stockage du document est invalide."));
    }
    let parts: Vec<_> = step.path.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        path.push(part);
        if i + 1 < parts.len() {
            if create {
                directory(&path)?;
                // Flush each newly reachable directory entry on Unix too, not
                // only the leaf containing the final file (branding/imports).
                snapshot::sync_directory(path.parent().unwrap())?;
            } else if !path.try_exists()? {
                continue;
            }
            if path.try_exists()? && !snapshot::regular_metadata(&path)?.is_dir() {
                return Err(invalid("Le dossier du document est invalide."));
            }
        } else if path.try_exists()? && !snapshot::regular_metadata(&path)?.is_file() {
            return Err(invalid("Un document ne peut pas remplacer ce chemin."));
        }
    }
    Ok(path)
}
pub(in crate::business_sync::replay::delivery::incoming) fn stamp(
    path: &Path,
) -> AppResult<Option<Stamp>> {
    if !path.try_exists()? {
        return Ok(None);
    }
    let (sha256, size_bytes) = snapshot::fingerprint_file(path)?;
    Ok(Some(Stamp { sha256, size_bytes }))
}
pub(in crate::business_sync::replay::delivery::incoming) fn copy_verified(
    source: &Path,
    destination: &Path,
    expected: &Stamp,
) -> AppResult<()> {
    let metadata = snapshot::regular_metadata(source)?;
    if !metadata.is_file() || metadata.len() != expected.size_bytes {
        return Err(invalid("La copie du document est absente ou altérée."));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("Le stockage du document est invalide."))?;
    let mut out = tempfile::NamedTempFile::new_in(parent)?;
    let mut input = fs::File::open(source)?.take(expected.size_bytes + 1);
    let mut buffer = [0; 64 * 1024];
    let mut sha = Sha256::new();
    let mut total = 0u64;
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > expected.size_bytes {
            return Err(invalid("Le document a changé pendant sa copie."));
        }
        sha.update(&buffer[..n]);
        out.write_all(&buffer[..n])?;
    }
    if total != expected.size_bytes || format!("{:x}", sha.finalize()) != expected.sha256 {
        return Err(invalid("Le document a changé pendant sa copie."));
    }
    out.as_file().sync_all()?;
    out.persist(destination).map_err(|e| e.error)?;
    snapshot::sync_directory(parent)
}
impl Journal {
    fn validate(&self, store: &LocalStore) -> AppResult<()> {
        if self.version != 1
            || self.installation_id != store.installation_id
            || !uuid(&self.stage)
            || !uuid(&self.generation)
            || !uuid(&self.capture)
            || !uuid(&self.transaction_id)
            || self.organization_id.is_empty()
            || self.organization_id.len() > 256
            || !hash(&self.receipt_sha256)
            || self.source_revision < 1
            || self.source_revision >= SAFE_REVISION
            || self.revision != self.source_revision + 1
            || self.steps.len() > 50_000
        {
            return Err(invalid(
                "Le journal de reprise de synchronisation est invalide.",
            ));
        }
        let mut paths = std::collections::BTreeSet::new();
        let mut total = 0u64;
        for step in &self.steps {
            target(store, step, false)?;
            if !paths.insert(format!("{}/{}", step.root, step.path).to_lowercase()) {
                return Err(invalid("Le journal répète un document."));
            }
            for s in step.before.iter().chain(std::iter::once(&step.after)) {
                if !hash(&s.sha256) || s.size_bytes > 512 * 1024 * 1024 {
                    return Err(invalid("La preuve du document est invalide."));
                }
                total = total
                    .checked_add(s.size_bytes)
                    .ok_or_else(|| invalid("La reprise dépasse la taille autorisée."))?;
            }
        }
        if total > 20 * 1024 * 1024 * 1024 {
            return Err(invalid("La reprise dépasse la taille autorisée."));
        }
        Ok(())
    }
    pub(in crate::business_sync::replay::delivery::incoming) fn prepare(
        store: &LocalStore,
        h: &Header,
        steps: Vec<Step>,
    ) -> AppResult<Self> {
        let directory_path = root(store);
        directory(&directory_path)?;
        // Persist the journal directory's entry before any working file changes.
        // Flushing intent.json's parent alone does not persist this parent entry.
        snapshot::sync_directory(&store.data_dir)?;
        if directory_path.join("intent.json").try_exists()? {
            return Err(invalid("Une installation précédente doit être récupérée."));
        }
        let value = Self {
            version: 1,
            installation_id: store.installation_id.clone(),
            organization_id: h.binding.organization.clone(),
            generation: h.binding.generation.clone(),
            capture: h.binding.capture.clone(),
            source_revision: h.binding.revision,
            revision: h.entry.revision,
            transaction_id: h.entry.transaction_id.clone(),
            receipt_sha256: h.entry.receipt_sha256.clone(),
            stage: Uuid::new_v4().to_string(),
            steps,
        };
        value.validate(store)?;
        let bytes = serde_json::to_vec(&value)?;
        if bytes.len() as u64 > MAX_INTENT {
            return Err(invalid("Le journal de reprise est trop volumineux."));
        }
        let staging = directory_path.join(&value.stage);
        directory(&staging)?;
        for (i, s) in value.steps.iter().enumerate() {
            let path = target(store, s, false)?;
            if stamp(&path)? != s.before {
                return Err(invalid("Un document local a changé avant l’installation."));
            }
            if let Some(before) = &s.before {
                copy_verified(&path, &staging.join(i.to_string()), before)?;
            }
        }
        snapshot::sync_directory(&staging)?;
        write(&directory_path.join("intent.json"), &bytes)?;
        Ok(value)
    }
    pub(in crate::business_sync::replay::delivery::incoming) fn apply(
        &self,
        store: &LocalStore,
        received: &Path,
        checkpoint: &impl Fn(Point) -> AppResult<()>,
    ) -> AppResult<()> {
        for (i, s) in self.steps.iter().enumerate() {
            let path = target(store, s, true)?;
            if stamp(&path)? != s.before {
                return Err(invalid(
                    "Un document local a changé pendant l’installation.",
                ));
            }
            copy_verified(
                &received.join("files").join(&s.after.sha256),
                &path,
                &s.after,
            )?;
            checkpoint(Point::FileInstalled(i))?;
        }
        Ok(())
    }
    pub(in crate::business_sync::replay::delivery::incoming) fn verify_installed_files(
        &self,
        store: &LocalStore,
    ) -> AppResult<()> {
        for step in &self.steps {
            if stamp(&target(store, step, false)?)?.as_ref() != Some(&step.after) {
                return Err(invalid("Un document installé a changé. Le journal et les copies de sécurité sont conservés."));
            }
        }
        Ok(())
    }
    fn rollback(&self, store: &LocalStore) -> AppResult<()> {
        let stage = root(store).join(&self.stage);
        for (i, s) in self.steps.iter().enumerate().rev() {
            let path = target(store, s, true)?;
            let current = stamp(&path)?;
            if current == s.before {
                continue;
            }
            if current.is_some() && current.as_ref() != Some(&s.after) {
                return Err(invalid("Un document a été modifié hors de la synchronisation. Sa copie de sécurité a été conservée."));
            }
            if let Some(before) = &s.before {
                if !snapshot::regular_metadata(&stage)?.is_dir() {
                    return Err(invalid("La copie de sécurité est indisponible."));
                }
                copy_verified(&stage.join(i.to_string()), &path, before)?;
            } else if current.is_some() {
                fs::remove_file(&path)?;
                snapshot::sync_directory(path.parent().unwrap())?;
            }
        }
        Ok(())
    }
    fn cleanup(&self, store: &LocalStore) -> AppResult<()> {
        let root = root(store);
        fs::remove_file(root.join("intent.json"))?;
        snapshot::sync_directory(&root)?;
        let stage = root.join(&self.stage);
        if stage.try_exists()? {
            if !snapshot::regular_metadata(&stage)?.is_dir() {
                return Err(invalid("Le dossier de reprise est invalide."));
            }
            for (i, s) in self.steps.iter().enumerate() {
                if s.before.is_some() {
                    let path = stage.join(i.to_string());
                    if path.try_exists()? {
                        if !snapshot::regular_metadata(&path)?.is_file() {
                            return Err(invalid("La copie de reprise est invalide."));
                        }
                        fs::remove_file(path)?;
                    }
                }
            }
            fs::remove_dir(stage)?;
            snapshot::sync_directory(&root)?;
        }
        Ok(())
    }
}
/// Called under the working-profile lock, or before initialization exposes it.
pub(crate) fn recover(store: &LocalStore) -> AppResult<()> {
    let root = root(store);
    if !root.try_exists()? {
        return Ok(());
    }
    if !snapshot::regular_metadata(&root)?.is_dir() {
        return Err(invalid("Le dossier de reprise est invalide."));
    }
    let intent = root.join("intent.json");
    if !intent.try_exists()? {
        return Ok(());
    }
    let mut connection = store.connect()?;
    // An independent process may still be committing the revision. Acquire the
    // SQLite writer gate before interpreting an absent receipt as a rollback.
    let c = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // The active writer may have completed recovery while we waited. Read the
    // current intent only after its SQLite decision is stable under this gate.
    if !intent.try_exists()? {
        return Ok(());
    }
    let value: Journal = serde_json::from_slice(&read(&intent, MAX_INTENT)?)?;
    value.validate(store)?;
    let installed:Option<(String,String)>=c.query_row("SELECT receipt_sha256,receipt_json FROM business_sync_installed_revisions WHERE organization_id=?1 AND generation=?2 AND revision=?3 AND transaction_id=?4",rusqlite::params![value.organization_id,value.generation,value.revision,value.transaction_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((sha, json)) = installed {
        if sha != value.receipt_sha256 || digest(json.as_bytes()) != sha {
            return Err(invalid("Le reçu d’installation conservé est incohérent."));
        }
        value.verify_installed_files(store)?;
    } else {
        let b = Binding::from_connection(&c, store, &value.organization_id)?;
        if b.generation != value.generation
            || b.capture != value.capture
            || b.revision != value.source_revision
        {
            return Err(invalid(
                "La reprise ne correspond plus au dossier installé.",
            ));
        }
        value.rollback(store)?;
    }
    value.cleanup(store)
}
