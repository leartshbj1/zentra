use super::*;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        assert!(!kind.is_symlink());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target.join(entry.file_name()));
        } else {
            assert!(kind.is_file());
            fs::copy(entry.path(), target.join(entry.file_name())).unwrap();
        }
    }
}
fn snapshots(root: &Path) -> BTreeMap<std::path::PathBuf, String> {
    let mut found = BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            found.extend(snapshots(&entry.path()));
        } else if ["candidate.sqlite", "replacement.sqlite", "proposal.json"]
            .iter()
            .any(|name| entry.file_name() == *name)
        {
            found.insert(
                entry.path(),
                format!("{:x}", Sha256::digest(fs::read(entry.path()).unwrap())),
            );
        }
    }
    found
}

#[test]
#[ignore = "Requires an actual retired profile produced by the schema63 native binary"]
fn schema63_retired_proposal_installs_after_migration_without_resealing_original_snapshots() {
    let source =
        std::path::PathBuf::from(std::env::var("ZENTRA_SCHEMA63_RETIRED_PROFILE").unwrap());
    let original = rusqlite::Connection::open_with_flags(
        source.join("helvichantier.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        original
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        63,
        "Use the genuine prior-version fixture, never relabel a current profile"
    );
    drop(original);
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("profile");
    copy_tree(&source, &path);
    let sealed = snapshots(&path);
    assert!(sealed.len() >= 3);
    let id = fs::read_to_string(path.join("legacy-resolution-id.txt")).unwrap();
    let local = LocalStore::initialize(path.clone()).unwrap();
    let _lease = cycle::acquire(&local).unwrap();
    let frozen = durable::load(&local.connect().unwrap(), &local)
        .unwrap()
        .unwrap();
    assert_eq!(frozen.stage, durable::Stage::Retired);
    assert!(!frozen.cancellation_requested);
    assert_eq!(frozen.intent.resolution_id, id);
    let before = evidence(&local, &frozen.intent.capture_generation);
    assert_private(&local, 71);
    assert_eq!(
        snapshots(&path),
        sealed,
        "Initialization must not rewrite sealed proposals"
    );
    let result = installer::install(&local, &id, || Ok(()), |_| Ok(())).unwrap();
    assert_eq!(result["installed"], true);
    assert_eq!(result["acknowledged"], false);
    assert_private(&local, 71);
    assert_eq!(evidence(&local, &frozen.intent.capture_generation), before);
    assert_eq!(
        fs::read(local.attachments_dir.join("drawing.txt")).unwrap(),
        b"shared version"
    );
    assert!(durable::load(&local.connect().unwrap(), &local)
        .unwrap()
        .is_none());
    assert_eq!(
        snapshots(&path),
        sealed,
        "Migrated copies must not replace sealed artifacts"
    );
    let result =
        installer::install(&local, &id, || Ok(()), |_| panic!("Already installed")).unwrap();
    assert_eq!(result["already_installed"], true);
    assert_eq!(
        local
            .connect()
            .unwrap()
            .query_row(
                "SELECT generation FROM business_sync_binding WHERE id=1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        frozen.intent.replacement_capture_generation
    );
    assert_eq!(
        local
            .connect()
            .unwrap()
            .query_row(
                "SELECT revision FROM business_sync_cursor WHERE id=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        frozen.intent.base_revision
    );
}
