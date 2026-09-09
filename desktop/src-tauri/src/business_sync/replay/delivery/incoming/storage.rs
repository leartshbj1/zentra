use super::*;

pub(super) fn directory(path: &Path) -> AppResult<()> {
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.into()),
    }
    if !snapshot::regular_metadata(path)?.is_dir() {
        return Err(invalid("Le dossier de réception est invalide."));
    }
    Ok(())
}
pub(super) fn read(path: &Path, limit: u64) -> AppResult<Vec<u8>> {
    let m = snapshot::regular_metadata(path)?;
    if !m.is_file() || m.len() > limit {
        return Err(invalid(
            "Le fragment conservé est invalide ou trop volumineux.",
        ));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("Le fragment conservé dépasse la limite autorisée."));
    }
    Ok(bytes)
}
pub(super) fn write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Le dossier de réception est invalide."))?;
    if path.try_exists()? && !snapshot::regular_metadata(path)?.is_file() {
        return Err(invalid("Le stockage de réception est invalide."));
    }
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| e.error)?;
    snapshot::sync_directory(parent)
}
pub(super) fn cached(
    path: &Path,
    sha: &str,
    expected: Option<u64>,
    limit: u64,
) -> AppResult<Option<Vec<u8>>> {
    if !path.try_exists()? {
        return Ok(None);
    }
    let bytes = read(path, limit)?;
    if digest(&bytes) != sha || expected.is_some_and(|n| n != bytes.len() as u64) {
        return Ok(None);
    }
    Ok(Some(bytes))
}
pub(super) fn assemble(
    parts: &Path,
    destination: &Path,
    file: &crate::business_sync::outgoing::Blob,
) -> AppResult<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("Le document reçu est invalide."))?;
    if destination.try_exists()?
        && snapshot::fingerprint_file(destination)? == (file.sha256.clone(), file.size_bytes)
    {
        return discard_parts(parts, file.size_bytes);
    }
    let mut out = tempfile::NamedTempFile::new_in(parent)?;
    let mut sha = Sha256::new();
    let mut size = 0u64;
    for index in 0..file.size_bytes.div_ceil(FILE_PART_BYTES) {
        let bytes = read(&parts.join(format!("{index:04}")), FILE_PART_BYTES)?;
        if bytes.len() as u64 != (file.size_bytes - index * FILE_PART_BYTES).min(FILE_PART_BYTES) {
            return Err(invalid("Le document reçu est incomplet."));
        }
        out.write_all(&bytes)?;
        sha.update(&bytes);
        size += bytes.len() as u64;
    }
    if size != file.size_bytes || format!("{:x}", sha.finalize()) != file.sha256 {
        return Err(invalid(
            "Le document ne correspond pas à son empreinte originale.",
        ));
    }
    out.as_file().sync_all()?;
    out.persist(destination).map_err(|e| e.error)?;
    snapshot::sync_directory(parent)?;
    discard_parts(parts, file.size_bytes)
}

// Delete only the exact private fragment paths after durable, whole-file
// verification. Never recursively remove a computed folder or user document.
fn discard_parts(parts: &Path, size: u64) -> AppResult<()> {
    if !snapshot::regular_metadata(parts)?.is_dir() {
        return Err(invalid("Le dossier de fragments est invalide."));
    }
    for index in 0..size.div_ceil(FILE_PART_BYTES) {
        let path = parts.join(format!("{index:04}"));
        if path.try_exists()? {
            if !snapshot::regular_metadata(&path)?.is_file() {
                return Err(invalid("Le fragment conservé est invalide."));
            }
            fs::remove_file(path)?;
        }
    }
    snapshot::sync_directory(parts)
}
