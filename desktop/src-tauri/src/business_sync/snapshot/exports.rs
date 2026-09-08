//! Initial history includes registered VAT XMLs and closing packages. Their
//! immutable rows remain unchanged; catalogue v2 identifies the storage root.

use super::*;
use zip::ZipArchive;

const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

enum Proof {
    Vat(String),
    Closing {
        manifest: String,
        source: String,
        period: String,
        review: String,
        status: String,
    },
}

pub(super) fn freeze(
    connection: &Connection,
    root: &Path,
    folder: &Path,
    files: &mut Vec<FrozenFile>,
) -> AppResult<()> {
    let mut references: BTreeMap<String, Vec<Proof>> = BTreeMap::new();
    let mut statement =
        connection.prepare("SELECT file_name,xml_sha256 FROM vat_return_exports")?;
    for reference in statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, Proof::Vat(row.get(1)?)))
    })? {
        let (name, proof) = reference?;
        references.entry(name).or_default().push(proof);
    }
    let mut statement = connection.prepare("SELECT file_name,manifest_sha256,source_sha256,accounting_period_id,closing_review_id,package_status FROM closing_package_exports")?;
    for reference in statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            Proof::Closing {
                manifest: row.get(1)?,
                source: row.get(2)?,
                period: row.get(3)?,
                review: row.get(4)?,
                status: row.get(5)?,
            },
        ))
    })? {
        let (name, proof) = reference?;
        references.entry(name).or_default().push(proof);
    }
    if references.is_empty() {
        return Ok(());
    }
    if files.len().saturating_add(references.len()) > MAX_FILES {
        return Err(invalid(
            "Les documents de l'historique dépassent 50 000 fichiers.",
        ));
    }
    if !regular_metadata(root)?.is_dir() {
        return Err(invalid("Le stockage des exports est inaccessible."));
    }
    let canonical_root = fs::canonicalize(root)?;
    let mut total = files.iter().map(|file| file.size_bytes).sum::<u64>();
    let mut names = files
        .iter()
        .map(|file| file.path.to_lowercase())
        .collect::<BTreeSet<_>>();
    let blob_folder = folder.join("files");
    for (name, proofs) in references {
        let path = format!("exports/{name}");
        validate_storage_path(&path)?;
        if !names.insert(path.to_lowercase()) {
            return Err(invalid(
                "Deux exports portent des noms incompatibles sur un autre appareil.",
            ));
        }
        let source_path = root.join(&name);
        let metadata = regular_metadata(&source_path).map_err(|_| invalid(&format!("L'export {name} est absent ou inaccessible. Restaurez-le avant de partager l'historique.")))?;
        if !metadata.is_file() || !fs::canonicalize(&source_path)?.starts_with(&canonical_root) {
            return Err(invalid(
                "Un export enregistré est absent ou sort du stockage local.",
            ));
        }
        let (sha256, size_bytes) = freeze_file_blob(&source_path, &blob_folder, total)?;
        // Validate the frozen bytes, not a live file that could change again.
        for proof in proofs {
            match proof {
                Proof::Vat(expected) if !valid_digest(&expected) || expected != sha256 => {
                    return Err(invalid("Un export TVA ne correspond plus à son empreinte enregistrée. Restaurez-le avant de partager l'historique."));
                }
                Proof::Vat(_) => (),
                proof @ Proof::Closing { .. } => {
                    verify_closing(&blob_folder.join(&sha256), &proof)?
                }
            }
        }
        total += size_bytes;
        files.push(FrozenFile {
            path,
            sha256,
            size_bytes,
        });
    }
    sync_directory(&blob_folder)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(())
}

fn small_member(archive: &mut ZipArchive<File>, name: &str, limit: u64) -> AppResult<Vec<u8>> {
    let member = archive.by_name(name)?;
    if member.size() > limit {
        return Err(invalid(
            "Le manifeste d'un dossier de clôture est trop volumineux.",
        ));
    }
    let mut bytes = Vec::new();
    member.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid(
            "Le manifeste d'un dossier de clôture dépasse sa taille autorisée.",
        ));
    }
    Ok(bytes)
}

fn verify_closing(path: &Path, proof: &Proof) -> AppResult<()> {
    let Proof::Closing {
        manifest: expected,
        source,
        period,
        review,
        status,
    } = proof
    else {
        return Err(invalid("Le type de preuve de clôture est invalide."));
    };
    if !valid_digest(expected) || !valid_digest(source) {
        return Err(invalid(
            "L'empreinte enregistrée du dossier de clôture est invalide.",
        ));
    }
    let mut archive = ZipArchive::new(File::open(path)?)?;
    if archive.len() < 3 || archive.len() > MAX_FILES + 100 {
        return Err(invalid(
            "Le dossier de clôture contient un nombre de fichiers invalide.",
        ));
    }
    let mut names = BTreeSet::new();
    let mut portable = BTreeSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let member = archive.by_index(index)?;
        let name = member.name();
        safe_relative(name)?;
        total = total.saturating_add(member.size());
        if member.is_dir()
            || member.size() > MAX_FILE_BYTES
            || total > MAX_FILE_TOTAL
            || member
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || !names.insert(name.to_owned())
            || !portable.insert(name.to_lowercase())
        {
            return Err(invalid("Le contenu d'un dossier de clôture est incohérent ou dépasse les limites autorisées."));
        }
    }
    let manifest_bytes = small_member(&mut archive, "manifest.json", MAX_MANIFEST_BYTES)?;
    if digest(&manifest_bytes) != *expected {
        return Err(invalid(
            "Le manifeste du dossier de clôture ne correspond plus à sa preuve enregistrée.",
        ));
    }
    let manifest: Value = serde_json::from_slice(&manifest_bytes)?;
    for (field, value) in [
        ("schema", "elyko.fiduciary-manifest.v1"),
        ("hash_algorithm", "SHA-256"),
        ("currency", "CHF"),
        ("source_sha256", source.as_str()),
        ("accounting_period_id", period.as_str()),
        ("review_id", review.as_str()),
        ("package_status", status.as_str()),
    ] {
        if manifest[field].as_str() != Some(value) {
            return Err(invalid(
                "Le dossier de clôture ne correspond pas à l'exercice et à la revue enregistrés.",
            ));
        }
    }
    let entries = manifest["files"]
        .as_array()
        .filter(|files| !files.is_empty() && files.len() <= MAX_FILES + 98)
        .ok_or_else(|| invalid("Le catalogue du dossier de clôture est invalide."))?;
    let mut expected_names = BTreeSet::from(["manifest.json".to_owned(), "SHA256SUMS".to_owned()]);
    let mut checksums = String::new();
    for entry in entries {
        let name = entry["path"]
            .as_str()
            .ok_or_else(|| invalid("Une référence du dossier de clôture est absente."))?;
        safe_relative(name)?;
        let hash = entry["sha256"]
            .as_str()
            .filter(|value| valid_digest(value))
            .ok_or_else(|| invalid("Une empreinte du dossier de clôture est invalide."))?;
        let size = entry["size_bytes"]
            .as_u64()
            .filter(|size| *size <= MAX_FILE_BYTES)
            .ok_or_else(|| invalid("Une taille du dossier de clôture est invalide."))?;
        if !expected_names.insert(name.to_owned()) {
            return Err(invalid(
                "Un fichier est répété dans le manifeste de clôture.",
            ));
        }
        let mut member = archive.by_name(name)?;
        if member.size() != size {
            return Err(invalid(
                "Une pièce du dossier de clôture a changé de taille.",
            ));
        }
        let mut hasher = Sha256::new();
        let mut length = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = member.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            length += count as u64;
            if length > size {
                return Err(invalid(
                    "Une pièce du dossier de clôture dépasse sa taille enregistrée.",
                ));
            }
            hasher.update(&buffer[..count]);
        }
        if length != size || format!("{:x}", hasher.finalize()) != hash {
            return Err(invalid("Une pièce du dossier de clôture est altérée. Restaurez le dossier avant de partager l'historique."));
        }
        checksums.push_str(&format!("{hash}  {name}\n"));
    }
    checksums.push_str(&format!("{expected}  manifest.json\n"));
    if names != expected_names
        || small_member(&mut archive, "SHA256SUMS", MAX_MANIFEST_BYTES)? != checksums.as_bytes()
    {
        return Err(invalid("Le dossier de clôture contient des fichiers ou des empreintes non conformes au manifeste."));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
