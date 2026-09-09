use super::*;
use crate::business_sync::{files as retained, identifier, json_image, json_key};
use journal::{Stamp, Step};
use std::collections::BTreeMap;

type Key = (String, String);
fn file_key(root: &str, path: &str) -> Key {
    (root.to_owned(), path.to_lowercase())
}
type Transition = (
    Option<String>,
    Vec<RetainedFile>,
    Option<String>,
    Vec<RetainedFile>,
);
fn bind_image(table: &str, image: Option<&str>, files: &[RetainedFile]) -> AppResult<()> {
    let reference = image
        .map(serde_json::from_str::<Value>)
        .transpose()?
        .as_ref()
        .map(|row| retained::reference(table, row))
        .transpose()?
        .flatten();
    match reference {
        None if files.is_empty() => Ok(()),
        Some(r)
            if files.len() == 1
                && files[0].root == r.root
                && files[0].path == r.path
                && r.sha256.as_ref().is_none_or(|s| *s == files[0].sha256)
                && r.size.is_none_or(|s| s == files[0].size_bytes) =>
        {
            Ok(())
        }
        _ => Err(invalid(
            "La preuve du fichier ne correspond pas à sa ligne métier.",
        )),
    }
}
/// Final paths only. Deleted/replaced historical bytes remain retained; unrelated
/// local documents and unregistered exports are never swept or overwritten.
pub(super) fn plan(
    store: &LocalStore,
    tx: &rusqlite::Transaction<'_>,
    folder: &Path,
    chunks: &[crate::business_sync::outgoing::Chunk],
) -> AppResult<Vec<Step>> {
    let mut changed: BTreeMap<Key, Transition> = BTreeMap::new();
    for (i, expected) in chunks.iter().enumerate() {
        let raw = read(
            &folder.join("changes").join(format!("{i:04}.json")),
            CHUNK_BYTES as u64,
        )?;
        if raw.len() as u64 != expected.size_bytes || digest(&raw) != expected.sha256 {
            return Err(invalid(
                "Le fragment a changé pendant la préparation des documents.",
            ));
        }
        let part: Changes = serde_json::from_slice(&raw)?;
        for c in part.changes {
            bind_image(&c.table, c.before_json.as_deref(), &c.files_before)?;
            bind_image(&c.table, c.after_json.as_deref(), &c.files_after)?;
            if !retained::has_files(&c.table) {
                continue;
            }
            changed
                .entry((c.table, c.key_json))
                .and_modify(|t| {
                    t.2 = c.after_json.clone();
                    t.3 = c.files_after.clone();
                })
                .or_insert((c.before_json, c.files_before, c.after_json, c.files_after));
        }
    }
    let mut before = BTreeMap::<Key, Stamp>::new();
    let mut final_files = BTreeMap::<Key, Stamp>::new();
    let mut names = BTreeMap::new();
    for (_, first, _, last) in changed.values() {
        for (list, map) in [(first, &mut before), (last, &mut final_files)] {
            for f in list {
                let key = file_key(&f.root, &f.path);
                if names
                    .insert(key.clone(), f.path.clone())
                    .is_some_and(|old| old != f.path)
                {
                    return Err(invalid(
                        "Deux noms de document ne diffèrent que par leurs majuscules.",
                    ));
                }
                let stamp = Stamp {
                    sha256: f.sha256.clone(),
                    size_bytes: f.size_bytes,
                };
                if map
                    .insert(key, stamp.clone())
                    .is_some_and(|old| old != stamp)
                {
                    return Err(invalid("Deux références de document se contredisent."));
                }
            }
        }
    }
    // Check every final registry reference sharing one of the planned paths.
    // This protects immutable exports and shared legacy logo names as well.
    let contract = policy()?;
    for (table, rule) in &contract.tables {
        if !retained::has_files(table) {
            continue;
        }
        let mut q = tx.prepare(&format!(
            "SELECT {},{} FROM {} r",
            json_key("r", &rule.key)?,
            json_image("r", &rule.columns)?,
            identifier(table)?
        ))?;
        let mut rows = q.query([])?;
        while let Some(row) = rows.next()? {
            let key: String = row.get(0)?;
            let image: String = row.get(1)?;
            let Some(reference) = retained::reference(table, &serde_json::from_str(&image)?)?
            else {
                continue;
            };
            let reference_key = file_key(reference.root, &reference.path);
            let Some(desired) = final_files.get(&reference_key) else {
                continue;
            };
            if names.get(&reference_key) != Some(&reference.path) {
                return Err(invalid(
                    "Un autre document utilise ce nom avec des majuscules différentes.",
                ));
            }
            if reference
                .sha256
                .as_ref()
                .is_some_and(|sha| sha != &desired.sha256)
                || reference
                    .size
                    .is_some_and(|size| size != desired.size_bytes)
            {
                return Err(invalid(
                    "Un autre document utilise ce chemin avec un contenu différent.",
                ));
            }
            if reference.sha256.is_none() && !changed.contains_key(&(table.clone(), key)) {
                let s = Step {
                    root: reference.root.into(),
                    path: reference.path,
                    before: None,
                    after: desired.clone(),
                };
                if journal::stamp(&journal::target(store, &s, false)?)?.as_ref() != Some(desired) {
                    return Err(invalid(
                        "Ce chemin est encore utilisé par un document existant.",
                    ));
                }
            }
        }
    }
    let mut steps = Vec::new();
    for (key, after) in final_files {
        let root = key.0.clone();
        let path = names[&key].clone();
        let mut step = Step {
            root: root.clone(),
            path: path.clone(),
            before: None,
            after,
        };
        let actual = journal::stamp(&journal::target(store, &step, false)?)?;
        if actual.as_ref() == Some(&step.after) {
            continue;
        }
        if actual.is_some() && before.get(&key) != actual.as_ref() {
            return Err(invalid(
                "Un fichier local différent occupe le chemin du document reçu.",
            ));
        }
        step.before = actual;
        steps.push(step);
    }
    Ok(steps)
}
