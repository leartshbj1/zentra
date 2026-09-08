use super::*;
use rusqlite::params;
use zip::{write::SimpleFileOptions, ZipWriter};

fn fixture() -> (tempfile::TempDir, Connection, PathBuf, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("exports");
    let frozen = temporary.path().join("frozen");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&frozen).unwrap();
    fs::create_dir(frozen.join("files")).unwrap();
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE vat_return_exports(file_name TEXT,xml_sha256 TEXT);
        CREATE TABLE closing_package_exports(file_name TEXT,manifest_sha256 TEXT,source_sha256 TEXT,accounting_period_id TEXT,closing_review_id TEXT,package_status TEXT);").unwrap();
    (temporary, db, root, frozen)
}

fn register_vat(db: &Connection, name: &str, bytes: &[u8]) {
    db.execute(
        "INSERT INTO vat_return_exports VALUES(?,?)",
        params![name, digest(bytes)],
    )
    .unwrap();
}

fn register_closing(db: &Connection, name: &str, proof: &Proof) {
    if let Proof::Closing {
        manifest,
        source,
        period,
        review,
        status,
    } = proof
    {
        db.execute(
            "INSERT INTO closing_package_exports VALUES(?,?,?,?,?,?)",
            params![name, manifest, source, period, review, status],
        )
        .unwrap();
    } else {
        panic!("wrong fixture")
    }
}

fn closing(path: &Path, variant: &str) -> Proof {
    let data_name = if variant == "unsafe" {
        "../data.txt"
    } else {
        "data.txt"
    };
    let source = digest(b"fictitious closing source");
    let data = b"Donnees de cloture fictives";
    let mut manifest = json!({"schema":"elyko.fiduciary-manifest.v1","hash_algorithm":"SHA-256","currency":"CHF",
        "source_sha256":source,"accounting_period_id":"period","review_id":"review","package_status":"FINAL",
        "files":[{"path":data_name,"size_bytes":data.len(),"sha256":digest(data)}]});
    if variant == "duplicate_manifest" {
        let first = manifest["files"][0].clone();
        manifest["files"].as_array_mut().unwrap().push(first);
    }
    let mut manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    if variant == "large_manifest" {
        manifest_bytes = vec![b' '; MAX_MANIFEST_BYTES as usize + 1];
    }
    let manifest_hash = digest(&manifest_bytes);
    let mut sums = format!(
        "{}  {data_name}\n{manifest_hash}  manifest.json\n",
        digest(data)
    )
    .into_bytes();
    if variant == "sums" {
        sums.push(b' ');
    }
    if variant == "manifest" {
        manifest_bytes.push(b' ');
    }
    let bytes = if variant == "data" {
        b"Donnees de cloture modifiees".as_slice()
    } else {
        data.as_slice()
    };
    let mut members = vec![
        (data_name, bytes.to_vec()),
        ("manifest.json", manifest_bytes),
        ("SHA256SUMS", sums),
    ];
    if variant == "extra" {
        members.push(("hidden.txt", b"unlisted content".to_vec()));
    }
    if variant == "case" {
        members.push(("DATA.txt", data.to_vec()));
    }
    let mut zip = ZipWriter::new(File::create(path).unwrap());
    for (name, bytes) in members {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().sync_all().unwrap();
    Proof::Closing {
        manifest: manifest_hash,
        source,
        period: "period".into(),
        review: "review".into(),
        status: "FINAL".into(),
    }
}

#[test]
fn catalogues_registered_exports_separately_from_attachments_and_ignores_unregistered_files() {
    let (temporary, db, root, frozen) = fixture();
    let attached = b"Document de projet";
    let xml = b"<tva>Export historique</tva>";
    let attachment = temporary.path().join("attachment.xml");
    fs::write(&attachment, attached).unwrap();
    let (sha256, size_bytes) = freeze_file_blob(&attachment, &frozen.join("files"), 0).unwrap();
    let mut files = vec![FrozenFile {
        path: "attachments/tva.xml".into(),
        sha256,
        size_bytes,
    }];
    fs::write(root.join("tva.xml"), xml).unwrap();
    fs::write(root.join("rapport-temporaire.csv"), b"not registered").unwrap();
    register_vat(&db, "tva.xml", xml);
    register_vat(&db, "tva.xml", xml);
    freeze(&db, &root, &frozen, &mut files).unwrap();
    assert_eq!(
        files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["attachments/tva.xml", "exports/tva.xml"]
    );
    for (file, bytes) in files.iter().zip([attached.as_slice(), xml.as_slice()]) {
        assert_eq!(
            fs::read(frozen.join("files").join(&file.sha256)).unwrap(),
            bytes
        );
    }
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM vat_return_exports", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn missing_and_tampered_vat_exports_cannot_be_silently_omitted() {
    for missing in [false, true] {
        let (_temporary, db, root, frozen) = fixture();
        register_vat(&db, "tva.xml", b"expected");
        if !missing {
            fs::write(root.join("tva.xml"), b"altered").unwrap();
        }
        let mut files = Vec::new();
        assert!(freeze(&db, &root, &frozen, &mut files).is_err());
        assert!(files.is_empty());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM vat_return_exports", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

#[test]
fn refuses_case_collisions_and_exports_outside_the_registered_directory() {
    for names in [
        vec!["../secret.xml"],
        vec!["nested/report.xml"],
        vec!["CON.xml"],
        vec!["TVA.xml", "tva.xml"],
    ] {
        let (_temporary, db, root, frozen) = fixture();
        for name in &names {
            register_vat(&db, name, b"export");
        }
        if names.len() == 2 {
            fs::write(root.join("TVA.xml"), b"export").unwrap();
            fs::write(root.join("tva.xml"), b"export").unwrap();
        }
        assert!(
            freeze(&db, &root, &frozen, &mut vec![]).is_err(),
            "{names:?}"
        );
    }
}

#[test]
fn freezes_a_closing_zip_using_its_own_hash_after_checking_all_inner_files() {
    let (_temporary, db, root, frozen) = fixture();
    let archive = root.join("closing.zip");
    let proof = closing(&archive, "valid");
    register_closing(&db, "closing.zip", &proof);
    let before = fs::read(&archive).unwrap();
    let mut files = Vec::new();
    freeze(&db, &root, &frozen, &mut files).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "exports/closing.zip");
    assert_eq!(files[0].sha256, digest(&before));
    if let Proof::Closing { manifest, .. } = proof {
        assert_ne!(files[0].sha256, manifest);
    }
    fs::remove_file(&archive).unwrap();
    assert_eq!(
        fs::read(frozen.join("files").join(&files[0].sha256)).unwrap(),
        before
    );
}

#[test]
fn rejects_altered_or_ambiguous_closing_content_even_when_the_zip_itself_is_readable() {
    for variant in [
        "data",
        "manifest",
        "sums",
        "extra",
        "case",
        "unsafe",
        "duplicate_manifest",
        "large_manifest",
    ] {
        let (_temporary, _db, root, _frozen) = fixture();
        let path = root.join("closing.zip");
        let proof = closing(&path, variant);
        assert!(verify_closing(&path, &proof).is_err(), "accepted {variant}");
    }
}

#[test]
fn refuses_a_closing_archive_from_another_recorded_review_or_exercise() {
    for field in ["period", "review", "source", "status"] {
        let (_temporary, _db, root, _frozen) = fixture();
        let path = root.join("closing.zip");
        let mut proof = closing(&path, "valid");
        if let Proof::Closing {
            period,
            review,
            source,
            status,
            ..
        } = &mut proof
        {
            match field {
                "period" => *period = "other-period".into(),
                "review" => *review = "other-review".into(),
                "source" => *source = digest(b"other source"),
                _ => *status = "DRAFT".into(),
            }
        }
        assert!(
            verify_closing(&path, &proof).is_err(),
            "accepted wrong {field}"
        );
    }
}

#[test]
fn legacy_preparations_without_export_rows_remain_readable_without_rewriting_the_descriptor() {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store.connect().unwrap().execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'QA Legacy','2026-09-08','2026-09-08')", []).unwrap();
    let mut prepared = store
        .prepare_business_snapshot("org-legacy", "owner")
        .unwrap();
    prepared.version = 1;
    prepared
        .verify(
            &store.snapshot_folder(&prepared.transfer_id).unwrap(),
            "org-legacy",
            &store.installation_id,
            &prepared.transfer_id,
        )
        .unwrap();
}
