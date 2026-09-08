use super::*;

fn rewrite_archive(
    source: &Path,
    destination: &Path,
    mut change: impl FnMut(&str, Vec<u8>) -> Option<Vec<u8>>,
    extras: &[(&str, &[u8])],
) {
    let mut input = ZipArchive::new(File::open(source).unwrap()).unwrap();
    let mut output = ZipWriter::new(File::create(destination).unwrap());
    let options = SimpleFileOptions::default();
    for index in 0..input.len() {
        let mut entry = input.by_index(index).unwrap();
        let name = entry.name().to_owned();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        if let Some(bytes) = change(&name, bytes) {
            output.start_file(&name, options).unwrap();
            output.write_all(&bytes).unwrap();
        }
    }
    for (name, bytes) in extras {
        output.start_file(*name, options).unwrap();
        output.write_all(bytes).unwrap();
    }
    output.finish().unwrap();
}

pub(crate) fn assert_registered_export_backup(
    store: &LocalStore,
    file_name: &str,
    expected: &[u8],
) {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("complete.zentra");
    let name = format!("exports/{file_name}");
    let table = if file_name.ends_with(".xml") {
        "vat_return_exports"
    } else {
        "closing_package_exports"
    };
    let registry_before = query_all(
        &store.connect().unwrap(),
        &format!("SELECT * FROM {table}"),
        [],
    )
    .unwrap();
    store
        .create_backup_at(&source, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let mut archive = ZipArchive::new(File::open(&source).unwrap()).unwrap();
    let manifest: BackupManifest =
        serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
    assert_eq!(manifest.format_version, 2);
    assert_eq!(manifest.exports_prefix.as_deref(), Some(EXPORTS_PREFIX));
    let mut bytes = Vec::new();
    archive
        .by_name(&name)
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, expected);
    drop(archive);

    let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
    fs::write(
        destination.exports_dir.join("old.csv"),
        b"old company export",
    )
    .unwrap();
    destination
        .restore_backup(source.to_str().unwrap(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    assert_eq!(
        fs::read(destination.exports_dir.join(file_name)).unwrap(),
        expected
    );
    assert!(!destination.exports_dir.join("old.csv").exists());
    assert_eq!(
        query_all(
            &destination.connect().unwrap(),
            &format!("SELECT * FROM {table}"),
            []
        )
        .unwrap(),
        registry_before
    );
    assert_eq!(
        query_all(
            &store.connect().unwrap(),
            &format!("SELECT * FROM {table}"),
            []
        )
        .unwrap(),
        registry_before
    );
    let safety = fs::read_dir(&destination.backups_dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("avant-restauration")
        })
        .unwrap();
    let mut safety = ZipArchive::new(File::open(safety).unwrap()).unwrap();
    let mut original = Vec::new();
    safety
        .by_name("exports/old.csv")
        .unwrap()
        .read_to_end(&mut original)
        .unwrap();
    assert_eq!(original, b"old company export");

    for remove in [false, true] {
        let damaged = temporary.path().join(format!("damaged-{remove}.zentra"));
        rewrite_archive(
            &source,
            &damaged,
            |entry, bytes| {
                if entry == name {
                    if remove {
                        None
                    } else {
                        Some(b"corrupt export".to_vec())
                    }
                } else {
                    Some(bytes)
                }
            },
            &[],
        );
        assert!(destination
            .restore_backup(damaged.to_str().unwrap(), env!("CARGO_PKG_VERSION"))
            .is_err());
        assert_eq!(
            fs::read(destination.exports_dir.join(file_name)).unwrap(),
            expected
        );
        assert_eq!(
            query_all(
                &destination.connect().unwrap(),
                &format!("SELECT * FROM {table}"),
                []
            )
            .unwrap(),
            registry_before
        );
    }

    // A normal profile also fails before publishing a supposedly complete backup
    // if its registered accounting export has been lost or changed externally.
    let original_path = store.exports_dir.join(file_name);
    let original_bytes = fs::read(&original_path).unwrap();
    fs::remove_file(&original_path).unwrap();
    let missing = temporary.path().join("missing.zentra");
    assert!(store
        .create_backup_at(&missing, env!("CARGO_PKG_VERSION"))
        .is_err());
    assert!(!missing.exists());
    store
        .restore_backup(source.to_str().unwrap(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    assert_eq!(fs::read(&original_path).unwrap(), expected);
    fs::write(&original_path, b"corrupt export").unwrap();
    assert!(store
        .create_backup_at(&missing, env!("CARGO_PKG_VERSION"))
        .is_err());
    assert!(!missing.exists());
    store
        .restore_backup(source.to_str().unwrap(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    assert_eq!(fs::read(&original_path).unwrap(), original_bytes);
}

#[test]
fn backup_roundtrip_preserves_extra_exports_nested_paths_and_distinct_storage_roots() {
    let temporary = tempfile::tempdir().unwrap();
    let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
    fs::create_dir_all(source.exports_dir.join("reports")).unwrap();
    fs::write(source.exports_dir.join("reports/data.csv"), b"csv report").unwrap();
    fs::write(source.exports_dir.join("same.pdf"), b"export").unwrap();
    fs::write(source.attachments_dir.join("same.pdf"), b"attachment").unwrap();
    let archive = temporary.path().join("roundtrip.zentra");
    source.create_backup_at(&archive, "test").unwrap();
    let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
    destination
        .restore_backup(archive.to_str().unwrap(), "test")
        .unwrap();
    assert_eq!(
        fs::read(destination.exports_dir.join("reports/data.csv")).unwrap(),
        b"csv report"
    );
    assert_eq!(
        fs::read(destination.exports_dir.join("same.pdf")).unwrap(),
        b"export"
    );
    assert_eq!(
        fs::read(destination.attachments_dir.join("same.pdf")).unwrap(),
        b"attachment"
    );
}

#[test]
fn legacy_v1_restores_database_and_attachments_without_mixing_destination_exports() {
    let temporary = tempfile::tempdir().unwrap();
    let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
    fs::write(source.attachments_dir.join("old.txt"), b"legacy attachment").unwrap();
    let current = temporary.path().join("current.zentra");
    let legacy = temporary.path().join("legacy.hchantier");
    source.create_backup_at(&current, "test").unwrap();
    rewrite_archive(
        &current,
        &legacy,
        |name, bytes| {
            if name == "manifest.json" {
                let mut manifest: Value = serde_json::from_slice(&bytes).unwrap();
                manifest["format_version"] = 1.into();
                manifest.as_object_mut().unwrap().remove("exports_prefix");
                Some(serde_json::to_vec(&manifest).unwrap())
            } else {
                Some(bytes)
            }
        },
        &[],
    );
    let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
    fs::write(
        destination.exports_dir.join("foreign.csv"),
        b"other company",
    )
    .unwrap();
    destination
        .restore_backup(legacy.to_str().unwrap(), "test")
        .unwrap();
    assert_eq!(
        fs::read(destination.attachments_dir.join("old.txt")).unwrap(),
        b"legacy attachment"
    );
    assert_eq!(fs::read_dir(&destination.exports_dir).unwrap().count(), 0);
}

#[test]
fn backup_restore_rejects_export_limits_paths_and_collisions_before_installing() {
    let temporary = tempfile::tempdir().unwrap();
    let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
    fs::write(source.exports_dir.join("report.csv"), vec![0x41; 65]).unwrap();
    let archive = temporary.path().join("source.zentra");
    source.create_backup_at(&archive, "test").unwrap();
    let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
    fs::write(destination.exports_dir.join("original.txt"), b"preserve").unwrap();
    let error = destination
        .restore_backup_with_limits(
            archive.to_str().unwrap(),
            "test",
            ArchiveExtractionLimits {
                exports_bytes: 32,
                ..ARCHIVE_EXTRACTION_LIMITS
            },
        )
        .unwrap_err();
    assert!(error.to_string().contains("dépasse la limite"));
    for (index, name) in [
        "exports/../outside.csv",
        "exports/C:/outside",
        "exports/report.csv.",
        "exports/REPORT.csv",
        "exports/NUL",
        "unknown/file",
    ]
    .iter()
    .enumerate()
    {
        let damaged = temporary.path().join(format!("path-{index}.zentra"));
        rewrite_archive(
            &archive,
            &damaged,
            |_, bytes| Some(bytes),
            &[(name, b"invalid")],
        );
        assert!(
            destination
                .restore_backup(damaged.to_str().unwrap(), "test")
                .is_err(),
            "accepted {name}"
        );
        assert_eq!(
            fs::read(destination.exports_dir.join("original.txt")).unwrap(),
            b"preserve"
        );
        assert!(!destination.exports_dir.join("report.csv").exists());
    }
    assert_eq!(fs::read_dir(&destination.backups_dir).unwrap().count(), 0);
}

#[test]
fn backup_rejects_recursive_destinations_and_cleans_failed_archive_writes() {
    let temporary = tempfile::tempdir().unwrap();
    let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
    for root in [&source.exports_dir, &source.attachments_dir] {
        assert!(source
            .create_backup_at(&root.join("recursive.zentra"), "test")
            .is_err());
        assert!(!root.join("recursive.zentra").exists());
    }
    // The streamed size failure occurs after the temporary archive is opened.
    fs::write(source.exports_dir.join("report.csv"), [0_u8; 65]).unwrap();
    let destination = temporary.path().join("failed.zentra");
    assert!(source
        .create_backup_at_with_limits(
            &destination,
            "test",
            ArchiveExtractionLimits {
                exports_bytes: 32,
                ..ARCHIVE_EXTRACTION_LIMITS
            },
            true,
        )
        .is_err());
    assert!(!destination.exists());
    assert!(!fs::read_dir(temporary.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".zentra-backup-")));
}
