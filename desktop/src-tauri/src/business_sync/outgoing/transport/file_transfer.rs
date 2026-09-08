use super::*;
use std::io::{Seek, SeekFrom};
const PART_BYTES: u64 = 4 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    manifest_sha256: String,
    sha256: String,
    size_bytes: u64,
    parts: Vec<Blob>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FilePart {
    part_index: usize,
    sha256: String,
    size_bytes: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Status {
    transaction_id: String,
    organization_id: String,
    installation_id: String,
    generation: String,
    capture_generation: String,
    manifest_sha256: String,
    sha256: String,
    size_bytes: u64,
    verified: bool,
    uploaded_parts: Vec<FilePart>,
    canonical_committed: bool,
    replication_active: bool,
}
fn plan(store: &LocalStore, folder: &Path, manifest_hash: &str, blob: &Blob) -> AppResult<Plan> {
    let source = crate::business_sync::files::retained_blob_path(
        &store.data_dir,
        &blob.sha256,
        blob.size_bytes,
    )?;
    let cache = folder.join("file-transfer");
    super::super::folder(&cache)?;
    let path = cache.join(format!("{}.json", blob.sha256));
    if path.try_exists()? {
        let meta = snapshot::regular_metadata(&path)?;
        if !meta.is_file() || meta.len() > 64 * 1024 {
            return Err(invalid("La préparation du document est altérée."));
        }
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(64 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        let p: Plan = serde_json::from_slice(&bytes)?;
        if p.manifest_sha256 != manifest_hash
            || p.sha256 != blob.sha256
            || p.size_bytes != blob.size_bytes
            || p.parts.len() != blob.size_bytes.div_ceil(PART_BYTES) as usize
            || p.parts.iter().enumerate().any(|(i, c)| {
                c.size_bytes != PART_BYTES.min(blob.size_bytes - i as u64 * PART_BYTES)
                    || c.sha256.len() != 64
                    || !c
                        .sha256
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(invalid(
                "Le plan du document ne correspond pas à la transaction.",
            ));
        }
        return Ok(p);
    }
    let mut file = fs::File::open(source)?;
    let mut total = Sha256::new();
    let mut parts = Vec::new();
    let mut received = 0;
    while received < blob.size_bytes {
        let expected = PART_BYTES.min(blob.size_bytes - received);
        let mut bytes = vec![0; expected as usize];
        file.read_exact(&mut bytes)?;
        total.update(&bytes);
        parts.push(Blob {
            sha256: digest(&bytes),
            size_bytes: expected,
        });
        received += expected;
    }
    let mut extra = [0];
    if file.read(&mut extra)? != 0 || format!("{:x}", total.finalize()) != blob.sha256 {
        return Err(invalid("Le contenu conservé du document a changé."));
    }
    let p = Plan {
        manifest_sha256: manifest_hash.into(),
        sha256: blob.sha256.clone(),
        size_bytes: blob.size_bytes,
        parts,
    };
    let mut temp = tempfile::NamedTempFile::new_in(&cache)?;
    temp.write_all(&serde_json::to_vec(&p)?)?;
    temp.as_file().sync_all()?;
    temp.persist_noclobber(path).map_err(|e| e.error)?;
    snapshot::sync_directory(&cache)?;
    Ok(p)
}
fn read_part(store: &LocalStore, plan: &Plan, index: usize) -> AppResult<Vec<u8>> {
    let part = plan
        .parts
        .get(index)
        .ok_or_else(|| invalid("Fragment de document inconnu."))?;
    let source = crate::business_sync::files::retained_blob_path(
        &store.data_dir,
        &plan.sha256,
        plan.size_bytes,
    )?;
    let mut file = fs::File::open(source)?;
    file.seek(SeekFrom::Start(index as u64 * PART_BYTES))?;
    let mut bytes = vec![0; part.size_bytes as usize];
    file.read_exact(&mut bytes)?;
    if digest(&bytes) != part.sha256 {
        return Err(invalid("Un fragment local du document est altéré."));
    }
    Ok(bytes)
}
fn validate(
    code: u16,
    bytes: &[u8],
    p: &Prepared,
    plan: &Plan,
    previous: Option<&Status>,
    required: Option<usize>,
) -> AppResult<Status> {
    if !(200..300).contains(&code) {
        return Err(invalid(
            "L’envoi du document est interrompu. Ses copies restent conservées.",
        ));
    }
    let s: Status = serde_json::from_slice(bytes)?;
    let m = &p.manifest;
    if s.transaction_id != m.transaction_id
        || s.organization_id != m.organization_id
        || s.installation_id != m.installation_id
        || s.generation != m.generation
        || s.capture_generation != m.capture_generation
        || s.manifest_sha256 != plan.manifest_sha256
        || s.sha256 != plan.sha256
        || s.size_bytes != plan.size_bytes
        || s.canonical_committed
        || s.replication_active
    {
        return Err(invalid(
            "La confirmation ne correspond pas au document envoyé.",
        ));
    }
    let mut indices = std::collections::BTreeSet::new();
    for c in &s.uploaded_parts {
        if !indices.insert(c.part_index)
            || plan
                .parts
                .get(c.part_index)
                .is_none_or(|e| e.sha256 != c.sha256 || e.size_bytes != c.size_bytes)
        {
            return Err(invalid("Un fragment de document confirmé est incohérent."));
        }
    }
    if (s.verified && indices.len() != plan.parts.len())
        || required.is_some_and(|i| !indices.contains(&i))
        || previous.is_some_and(|old| {
            (old.verified && !s.verified)
                || old
                    .uploaded_parts
                    .iter()
                    .any(|c| !indices.contains(&c.part_index))
        })
    {
        return Err(invalid(
            "La confirmation du document est incomplète ou a régressé.",
        ));
    }
    Ok(s)
}
async fn request(
    store: &LocalStore,
    t: &impl Transport,
    p: &Prepared,
    plan: &Plan,
    method: Method,
    index: Option<usize>,
    body: Option<Vec<u8>>,
) -> AppResult<(u16, Vec<u8>)> {
    t.current(store)?;
    bound(store, p)?;
    let result = t
        .file_request(FileRequest {
            method,
            id: p.manifest.transaction_id.clone(),
            sha: plan.sha256.clone(),
            index,
            hash: index.map(|i| plan.parts[i].sha256.clone()),
            body,
        })
        .await?;
    t.current(store)?;
    bound(store, p)?;
    Ok(result)
}
pub(super) async fn send(
    store: &LocalStore,
    t: &impl Transport,
    p: &Prepared,
    pending: &[Blob],
    mut budget: usize,
) -> AppResult<usize> {
    let mut sent = 0;
    for blob in pending {
        if budget == 0 {
            break;
        }
        t.current(store)?;
        bound(store, p)?;
        let profile = store.clone();
        let folder = p.folder.clone();
        let hash = digest(&serde_json::to_vec(&p.manifest)?);
        let blob = blob.clone();
        let plan =
            tauri::async_runtime::spawn_blocking(move || plan(&profile, &folder, &hash, &blob))
                .await
                .map_err(|_| invalid("La préparation du document a été interrompue."))??;
        let (code, bytes) = request(store, t, p, &plan, Method::GET, None, None).await?;
        let mut status = validate(code, &bytes, p, &plan, None, None)?;
        let missing = (0..plan.parts.len())
            .filter(|i| !status.uploaded_parts.iter().any(|c| c.part_index == *i))
            .collect::<Vec<_>>();
        for index in missing {
            if budget == 0 {
                break;
            }
            let profile = store.clone();
            let local_plan = plan.clone();
            let bytes = tauri::async_runtime::spawn_blocking(move || {
                read_part(&profile, &local_plan, index)
            })
            .await
            .map_err(|_| invalid("La lecture du document a été interrompue."))??;
            let (code, bytes) =
                request(store, t, p, &plan, Method::PUT, Some(index), Some(bytes)).await?;
            status = validate(code, &bytes, p, &plan, Some(&status), Some(index))?;
            budget -= 1;
            sent += 1;
        }
        if !status.verified && status.uploaded_parts.len() == plan.parts.len() && budget > 0 {
            let (code, bytes) = request(store, t, p, &plan, Method::POST, None, None).await?;
            status = validate(code, &bytes, p, &plan, Some(&status), None)?;
            if !status.verified {
                return Err(invalid(
                    "Le serveur n’a pas encore confirmé le document complet.",
                ));
            }
            budget -= 1;
        }
    }
    Ok(sent)
}

#[cfg(test)]
mod tests;
