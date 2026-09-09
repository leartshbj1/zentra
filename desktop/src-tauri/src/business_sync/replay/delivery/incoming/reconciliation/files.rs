//! Select final document versions from the merged rows and original file proofs.
//! A received old version never replaces a later pending local version.
use super::super::installation::journal::{self, Stamp, Step};
use super::*;
use crate::business_sync::{files as retained, policy, replay::normalize};
use rusqlite::{params, Connection};
use std::collections::BTreeMap;

pub(super) struct Plan {
    pub steps: Vec<Step>,
    pub final_files: Vec<Step>,
    pub stage: crate::business_sync::workspace::Workspace,
}
impl Plan {
    pub fn verify_final(&self, store: &LocalStore) -> AppResult<()> {
        for s in &self.final_files {
            if journal::stamp(&journal::target(store, s, false)?)?.as_ref() != Some(&s.after) {
                return Err(invalid(
                    "Un document de la fusion est absent ou a changé avant la confirmation.",
                ));
            }
        }
        Ok(())
    }
}
fn remembered(
    c: &Connection,
    table: &str,
    key: &str,
    image: &str,
) -> AppResult<Option<RetainedFile>> {
    c.query_row("SELECT root,path,sha256,size_bytes FROM reconciliation_file_evidence WHERE table_name=?1 AND row_key_json=?2 AND image_sha256=?3",params![table,key,digest(image.as_bytes())],|r|Ok(RetainedFile {root:r.get(0)?,path:r.get(1)?,sha256:r.get(2)?,size_bytes:r.get(3)?})).optional().map_err(Into::into)
}
fn remember(
    c: &Connection,
    table: &str,
    key: &str,
    image: Option<&str>,
    files: &[RetainedFile],
) -> AppResult<()> {
    let Some(image) = image else {
        if files.is_empty() {
            return Ok(());
        } else {
            return Err(invalid("Un document reçu n’a pas de ligne métier."));
        }
    };
    let row: Value = serde_json::from_str(image)?;
    let Some(reference) = retained::reference(table, &row)? else {
        if files.is_empty() {
            return Ok(());
        } else {
            return Err(invalid(
                "Une preuve de document ne correspond pas à sa ligne.",
            ));
        }
    };
    if files.len() != 1 {
        return Err(invalid("La preuve du document est absente ou répétée."));
    }
    let file = &files[0];
    if file.root != reference.root
        || file.path != reference.path
        || reference.sha256.as_ref().is_some_and(|s| s != &file.sha256)
        || reference.size.is_some_and(|s| s != file.size_bytes)
        || !hash(&file.sha256)
        || file.size_bytes > 512 * 1024 * 1024
    {
        return Err(invalid(
            "La version du document ne correspond pas à sa ligne métier.",
        ));
    }
    let rule = &policy()?.tables[table];
    let normalized = normalize(c, rule, key, image)?;
    if remembered(c, table, key, &normalized)?.is_some_and(|existing| existing != *file) {
        return Err(invalid(
            "Deux preuves attribuent des contenus différents à la même version d’un document.",
        ));
    }
    c.execute(
        "INSERT OR IGNORE INTO reconciliation_file_evidence VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            table,
            key,
            digest(normalized.as_bytes()),
            file.root,
            file.path,
            file.sha256,
            file.size_bytes
        ],
    )?;
    Ok(())
}
fn evidence(
    prepared: &merge::Prepared,
    store: &LocalStore,
    folder: &Path,
    chunks: &[outgoing::Chunk],
) -> AppResult<()> {
    let c = prepared.rows();
    c.execute_batch("CREATE TEMP TABLE reconciliation_file_evidence(table_name TEXT NOT NULL,row_key_json TEXT NOT NULL,image_sha256 TEXT NOT NULL,root TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,PRIMARY KEY(table_name,row_key_json,image_sha256))")?;
    for (i, chunk) in chunks.iter().enumerate() {
        let bytes = read(
            &folder.join("changes").join(format!("{i:04}.json")),
            CHUNK_BYTES as u64,
        )?;
        if digest(&bytes) != chunk.sha256 || bytes.len() as u64 != chunk.size_bytes {
            return Err(invalid(
                "Les documents reçus ont changé après la préparation.",
            ));
        }
        let part: Changes = serde_json::from_slice(&bytes)?;
        for change in part.changes {
            if !retained::has_files(&change.table) {
                continue;
            }
            remember(
                c,
                &change.table,
                &change.key_json,
                change.before_json.as_deref(),
                &change.files_before,
            )?;
            remember(
                c,
                &change.table,
                &change.key_json,
                change.after_json.as_deref(),
                &change.files_after,
            )?;
        }
    }
    // Read raw original images from the unchanged captured evidence. A current
    // working file must never recreate a missing receipt for a historical image.
    let native = prepared.candidate()?.connect()?;
    let mut q = c.prepare(
        "SELECT sequence,table_name,row_key_json FROM pending_changes ORDER BY sequence",
    )?;
    let mut rows = q.query([])?;
    while let Some(r) = rows.next()? {
        let table: String = r.get(1)?;
        if !retained::has_files(&table) {
            continue;
        }
        let key: String = r.get(2)?;
        let images: (Option<String>, Option<String>) = native.query_row(
            "SELECT before_json,after_json FROM business_sync_changes WHERE sequence=?1",
            [r.get::<_, i64>(0)?],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        for raw in images.0.iter().chain(images.1.iter()) {
            let files = retained::retained_image_files(&store.data_dir, &table, raw)?;
            remember(c, &table, &key, Some(raw), &files)?;
        }
    }
    Ok(())
}
fn record(file: &RetainedFile) -> Step {
    Step {
        root: file.root.clone(),
        path: file.path.clone(),
        before: None,
        after: Stamp {
            sha256: file.sha256.clone(),
            size_bytes: file.size_bytes,
        },
    }
}
type FileKey = (String, String);
fn key(file: &RetainedFile) -> FileKey {
    (file.root.clone(), file.path.to_lowercase())
}
fn insert(map: &mut BTreeMap<FileKey, RetainedFile>, file: RetainedFile) -> AppResult<()> {
    if map.get(&key(&file)).is_some_and(|old| old != &file) {
        return Err(invalid(
            "Deux documents utilisent le même chemin avec des noms ou des contenus différents.",
        ));
    }
    if map.len() >= 50_000 && !map.contains_key(&key(&file)) {
        return Err(invalid("La fusion contient trop de documents."));
    }
    map.insert(key(&file), file);
    Ok(())
}
fn known_file(
    c: &Connection,
    store: &LocalStore,
    table: &str,
    row_key: &str,
    image: &str,
) -> AppResult<Option<RetainedFile>> {
    if let Some(file) = remembered(c, table, row_key, image)? {
        return Ok(Some(file));
    }
    let Some(reference) = retained::reference(table, &serde_json::from_str(image)?)? else {
        return Ok(None);
    };
    let probe = Step {
        root: reference.root.into(),
        path: reference.path.clone(),
        before: None,
        after: Stamp {
            sha256: "0".repeat(64),
            size_bytes: 0,
        },
    };
    let actual = journal::stamp(&journal::target(store, &probe, false)?)?;
    let sha = reference
        .sha256
        .or_else(|| actual.as_ref().map(|v| v.sha256.clone()));
    let size = reference
        .size
        .or_else(|| actual.as_ref().map(|v| v.size_bytes));
    match (sha,size) {
        (Some(sha256),Some(size_bytes))=>Ok(Some(RetainedFile {root:reference.root.into(),path:reference.path,sha256,size_bytes})),
        _=>Err(invalid("Un document existant est absent et sa version ne peut pas être vérifiée. Récupérez-le avant la fusion.")),
    }
}
pub(super) fn plan(
    prepared: &merge::Prepared,
    store: &LocalStore,
    received: &Path,
    chunks: &[outgoing::Chunk],
) -> AppResult<Plan> {
    evidence(prepared, store, received, chunks)?;
    let c = prepared.rows();
    let mut current = BTreeMap::new();
    let mut q=c.prepare("SELECT table_name,row_key_json,row_json FROM current_rows ORDER BY table_name,row_key_json")?;
    let mut rows = q.query([])?;
    while let Some(r) = rows.next()? {
        let table: String = r.get(0)?;
        if !retained::has_files(&table) {
            continue;
        }
        let Some(file) = known_file(
            c,
            store,
            &table,
            &r.get::<_, String>(1)?,
            &r.get::<_, String>(2)?,
        )?
        else {
            continue;
        };
        if journal::stamp(&journal::target(store, &record(&file), false)?)?
            .is_some_and(|actual| actual != record(&file).after)
        {
            return Err(invalid(
                "Un fichier local diffère de sa version enregistrée. La fusion l’a conservé.",
            ));
        }
        insert(&mut current, file)?;
    }
    let mut final_files = BTreeMap::new();
    let mut q = c.prepare(
        "SELECT table_name,row_key_json,row_json FROM merged_rows ORDER BY table_name,row_key_json",
    )?;
    let mut rows = q.query([])?;
    while let Some(r) = rows.next()? {
        let table: String = r.get(0)?;
        if !retained::has_files(&table) {
            continue;
        }
        let row_key: String = r.get(1)?;
        let image: String = r.get(2)?;
        let Some(reference) = retained::reference(&table, &serde_json::from_str(&image)?)? else {
            continue;
        };
        let unchanged:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM current_rows WHERE table_name=?1 AND row_key_json=?2 AND row_json=?3)",params![table,row_key,image],|r|r.get(0))?;
        let file = if let Some(file) = remembered(c, &table, &row_key, &image)? {
            file
        } else if unchanged {
            current
                .get(&(reference.root.into(), reference.path.to_lowercase()))
                .cloned()
                .ok_or_else(|| invalid("Le document existant n’a pas de version vérifiable."))?
        } else {
            return Err(invalid(
                "Une nouvelle version de document n’a pas sa preuve d’origine.",
            ));
        };
        insert(&mut final_files, file)?;
    }
    let stage = crate::business_sync::workspace::Workspace::new(store, "reconciliation-files")?;
    fs::create_dir(stage.path().join("files"))?;
    let mut steps = Vec::new();
    let mut verified = Vec::new();
    let mut total = 0u64;
    for (key, file) in final_files {
        total = total
            .checked_add(file.size_bytes)
            .ok_or_else(|| invalid("Les documents dépassent la taille autorisée."))?;
        if total > 20 * 1024 * 1024 * 1024 || file.size_bytes > 512 * 1024 * 1024 {
            return Err(invalid("Les documents dépassent la taille autorisée."));
        }
        let mut step = record(&file);
        let actual = journal::stamp(&journal::target(store, &step, false)?)?;
        verified.push(step.clone());
        if actual.as_ref() == Some(&step.after) {
            continue;
        }
        if actual.is_some()
            && current
                .get(&key)
                .is_none_or(|old| Some(record(old).after) != actual)
        {
            return Err(invalid(
                "Un fichier local non enregistré occupe le chemin du document reçu.",
            ));
        }
        step.before = actual;
        let received_file = received.join("files").join(&file.sha256);
        let source = if received_file.try_exists()? {
            received_file
        } else {
            retained::retained_blob_path(&store.data_dir, &file.sha256, file.size_bytes)?
        };
        let staged = stage.path().join("files").join(&file.sha256);
        if !staged.try_exists()? {
            journal::copy_verified(&source, &staged, &step.after)?;
        }
        steps.push(step);
    }
    Ok(Plan {
        steps,
        final_files: verified,
        stage,
    })
}
