use super::*;
use crate::business_sync::{self, outgoing, replay};
use std::time::{Duration, Instant};

const OLD: &[u8] = b"Original project document";
const NEW: &[u8] = b"Revised project document, with new details";
const ADDED: &[u8] = b"New document from another device";
struct Fixture {
    _source_root: tempfile::TempDir,
    _receiver_root: tempfile::TempDir,
    store: LocalStore,
    folder: PathBuf,
    header: Header,
    before: String,
    after: String,
}
fn attachment(c: &rusqlite::Connection, id: &str, path: &str, bytes: &[u8]) {
    let rowid = match id {
        "existing" => 1,
        "replacement" => 2,
        "alias" => 4,
        _ => 3,
    };
    c.execute("INSERT INTO attachments(rowid,id,original_name,stored_name,size_bytes,sha256,created_at,updated_at) VALUES(?5,?1,?2,?2,?3,?4,'2026-09-09','2026-09-09')",params![id,path,bytes.len() as i64,digest(bytes),rowid]).unwrap();
}
fn fixture() -> Fixture {
    fixture_with_alias(false)
}
fn fixture_with_alias(alias: bool) -> Fixture {
    let (source_root, source, _) = replay::tests::setup_with(|s| {
        fs::write(s.attachments_dir.join("existing.txt"), OLD).unwrap();
        attachment(&s.connect().unwrap(), "existing", "existing.txt", OLD);
        if alias {
            fs::write(s.attachments_dir.join("EXISTING.txt"), OLD).unwrap();
            attachment(&s.connect().unwrap(), "alias", "EXISTING.txt", OLD);
        }
    });
    let (receiver_root, store) = replay::tests::copy_receiver(&source);
    fs::write(store.attachments_dir.join("existing.txt"), OLD).unwrap();
    if alias {
        fs::write(store.attachments_dir.join("EXISTING.txt"), OLD).unwrap();
    }
    fs::write(
        store.attachments_dir.join("unrelated.txt"),
        b"Keep local document",
    )
    .unwrap();
    fs::write(
        store.exports_dir.join("unregistered.txt"),
        b"Keep local export",
    )
    .unwrap();
    let before = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
    let mut c = source.connect().unwrap();
    let rule = &business_sync::policy().unwrap().tables["attachments"];
    // Preserve the preimage before replacing the managed file, as native file
    // commands do. Real capture triggers generate the transaction's envelopes.
    c.query_row(&format!("SELECT zentra_sync_retain_files('attachments',{}) FROM attachments r WHERE id='existing'",business_sync::json_image("r",&rule.columns).unwrap()),[],|r|r.get::<_,i64>(0)).unwrap();
    fs::write(source.attachments_dir.join("existing.txt"), NEW).unwrap();
    fs::write(source.attachments_dir.join("added.txt"), ADDED).unwrap();
    let tx = c.transaction().unwrap();
    // Attachments are immutable: replacement removes an unlinked old record
    // and inserts a new record. Keep those native guards enabled in this fixture.
    tx.execute("DELETE FROM attachments WHERE id='existing'", [])
        .unwrap();
    attachment(&tx, "replacement", "existing.txt", NEW);
    attachment(&tx, "added", "added.txt", ADDED);
    tx.execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('received-client','Client reçu','2026-09-09','2026-09-09')",[]).unwrap();
    tx.commit().unwrap();
    drop(c);
    let after = replay::state_fingerprint(&source.connect().unwrap()).unwrap();
    let p = outgoing::prepare_next(&source, "org-replay", "owner")
        .unwrap()
        .unwrap();
    let binding = Binding::read(&store, "org-replay").unwrap();
    let folder = store
        .data_dir
        .join("business-reception")
        .join(digest(&serde_json::to_vec(&binding).unwrap()))
        .join(&p.manifest.transaction_id);
    fs::create_dir_all(&folder).unwrap();
    for name in ["changes", "positions", "files"] {
        fs::create_dir(folder.join(name)).unwrap();
    }
    let manifest = fs::read(p.folder.join("manifest.json")).unwrap();
    let mut parts = Vec::new();
    for (i, _) in p.manifest.chunks.iter().enumerate() {
        let original = fs::read(p.folder.join(format!("{i:04}.json"))).unwrap();
        let changes: Value = serde_json::from_slice(&original).unwrap();
        let positions=serde_json::to_vec(&json!({"version":1,"part_index":i,"source_sha256":digest(&original),"positions":changes["changes"].as_array().unwrap().iter().map(|c|json!({"table":c["table"],"key_json":c["key_json"],"canonical_rowid":c["source_rowid"]})).collect::<Vec<_>>()})).unwrap();
        fs::write(
            folder.join("changes").join(format!("{i:04}.json")),
            &original,
        )
        .unwrap();
        fs::write(
            folder.join("positions").join(format!("{i:04}.json")),
            &positions,
        )
        .unwrap();
        parts.push(json!({"source_sha256":digest(&original),"source_bytes":original.len(),"positions_sha256":digest(&positions),"positions_bytes":positions.len(),"change_count":changes["changes"].as_array().unwrap().len()}));
    }
    for f in &p.manifest.files {
        let path =
            business_sync::files::retained_blob_path(&source.data_dir, &f.sha256, f.size_bytes)
                .unwrap();
        fs::copy(path, folder.join("files").join(&f.sha256)).unwrap();
    }
    let bundle = json!({"format":"zentra-canonical-transaction-bundle","version":1,"schema_version":60,"contract_sha256":snapshot::contract_hash().unwrap(),
        "organization_id":"org-replay","origin_installation_id":source.installation_id,"generation":binding.generation,"capture_generation":p.manifest.capture_generation,
        "transaction_id":p.manifest.transaction_id,"source_transfer_id":Uuid::new_v4().to_string(),"source_revision":1,"original_manifest_sha256":digest(&manifest),
        "review_attempt":Uuid::new_v4().to_string(),"review_validator_sha256":"a".repeat(64),"validation_sha256":"b".repeat(64),"fingerprint_version":2,
        "fingerprint_contract_sha256":fingerprint_contract().unwrap(),"source_state_sha256":before,"target_state_sha256":after,"source_rows":1,"target_rows":2,"parts":parts});
    // Whitespace is deliberately significant for the authenticated receipt hash.
    let receipt = serde_json::to_vec_pretty(&super::super::super::tests::receipt(&bundle)).unwrap();
    let bundle = serde_json::to_vec(&bundle).unwrap();
    let header = Header {
        version: 1,
        binding,
        entry: Entry {
            transaction_id: p.manifest.transaction_id,
            source_revision: 1,
            revision: 2,
            bundle_sha256: digest(&bundle),
            receipt_sha256: digest(&receipt),
            origin_installation_id: source.installation_id.clone(),
        },
    };
    fs::write(
        folder.join("header.json"),
        serde_json::to_vec(&header).unwrap(),
    )
    .unwrap();
    fs::write(folder.join("receipt.json"), receipt).unwrap();
    fs::write(folder.join("manifest.json"), manifest).unwrap();
    fs::write(folder.join("bundle.json"), bundle).unwrap();
    verify_downloaded(&folder, &header).unwrap();
    Fixture {
        _source_root: source_root,
        _receiver_root: receiver_root,
        store,
        folder,
        header,
        before,
        after,
    }
}
fn assert_state(f: &Fixture, committed: bool) {
    let c = f.store.connect().unwrap();
    assert_eq!(
        replay::state_fingerprint(&c).unwrap(),
        if committed { &f.after } else { &f.before }.as_str()
    );
    assert_eq!(
        fs::read(f.store.attachments_dir.join("existing.txt")).unwrap(),
        if committed { NEW } else { OLD }
    );
    let added = f.store.attachments_dir.join("added.txt");
    assert_eq!(added.exists(), committed);
    if committed {
        assert_eq!(fs::read(added).unwrap(), ADDED);
    }
    assert_eq!(
        fs::read(f.store.attachments_dir.join("unrelated.txt")).unwrap(),
        b"Keep local document"
    );
    assert_eq!(
        fs::read(f.store.exports_dir.join("unregistered.txt")).unwrap(),
        b"Keep local export"
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM business_sync_changes", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM business_sync_installed_revisions",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        i64::from(committed)
    );
    assert_eq!(
        Binding::read(&f.store, "org-replay").unwrap().revision,
        if committed { 2 } else { 1 }
    );
    assert!(!f
        .store
        .data_dir
        .join("business-installation/intent.json")
        .exists());
}
#[test]
fn installs_rows_files_and_receipt_together_and_retry_preserves_exact_receipt_bytes() {
    let f = fixture();
    let local = replay::local_fingerprint(&f.store.connect().unwrap()).unwrap();
    let result = install(&f.store, &f.folder, &f.header, || Ok(()), |_| Ok(())).unwrap();
    assert_eq!(result["installed"], true);
    assert_state(&f, true);
    assert_eq!(
        replay::local_fingerprint(&f.store.connect().unwrap()).unwrap(),
        local
    );
    let again = install(&f.store, &f.folder, &f.header, || Ok(()), |_| Ok(())).unwrap();
    assert_eq!(again["already_installed"], true);
    assert_state(&f, true);
}
#[test]
fn errors_at_every_installation_boundary_restore_or_keep_the_committed_revision() {
    for point in [
        Point::IntentSaved,
        Point::FileInstalled(0),
        Point::FileInstalled(1),
        Point::BeforeCommit,
        Point::Committed,
    ] {
        let f = fixture();
        assert!(install(
            &f.store,
            &f.folder,
            &f.header,
            || Ok(()),
            |p| if p == point {
                Err(invalid("Injected installation error"))
            } else {
                Ok(())
            }
        )
        .is_err());
        assert_state(&f, point == Point::Committed);
    }
}
#[test]
#[ignore = "Worker invoked by the process-crash recovery test with isolated fictitious paths"]
fn installation_crash_worker() {
    let root = PathBuf::from(std::env::var("ZENTRA_INSTALL_CRASH_PROFILE").unwrap());
    let folder = PathBuf::from(std::env::var("ZENTRA_INSTALL_CRASH_FOLDER").unwrap());
    let point = std::env::var("ZENTRA_INSTALL_CRASH_POINT").unwrap();
    let store = LocalStore::initialize(root).unwrap();
    let header: Header =
        serde_json::from_slice(&fs::read(folder.join("header.json")).unwrap()).unwrap();
    install(
        &store,
        &folder,
        &header,
        || Ok(()),
        |p| {
            if format!("{p:?}") == point {
                std::process::exit(75);
            }
            Ok(())
        },
    )
    .unwrap();
    panic!("Crash boundary was not reached");
}
fn crash(f: &Fixture, point: Point) {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.args(["business_sync::replay::delivery::incoming::installation::tests::installation_crash_worker","--ignored","--exact","--nocapture"])
        .env("ZENTRA_INSTALL_CRASH_PROFILE",&f.store.data_dir).env("ZENTRA_INSTALL_CRASH_FOLDER",&f.folder).env("ZENTRA_INSTALL_CRASH_POINT",format!("{point:?}"));
    let mut child = command.spawn().unwrap();
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(75));
            break;
        }
        if start.elapsed() > Duration::from_secs(90) {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Isolated crash worker timed out");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
#[test]
fn abrupt_process_exit_recovers_from_the_durable_sqlite_commit_decision() {
    for point in [
        Point::IntentSaved,
        Point::FileInstalled(0),
        Point::FileInstalled(1),
        Point::BeforeCommit,
        Point::Committed,
    ] {
        let f = fixture();
        crash(&f, point);
        assert!(f
            .store
            .data_dir
            .join("business-installation/intent.json")
            .is_file());
        let restarted = LocalStore::initialize(f.store.data_dir.clone()).unwrap();
        assert_eq!(restarted.installation_id, f.store.installation_id);
        assert_state(&f, point == Point::Committed);
        journal::recover(&restarted).unwrap();
    }
}

#[test]
fn pending_local_writes_and_session_changes_preserve_the_working_profile() {
    let f = fixture();
    f.store
        .create_record("clients", json!({"name":"Created offline"}))
        .unwrap();
    let pending_before = replay::state_fingerprint(&f.store.connect().unwrap()).unwrap();
    let error = install(&f.store, &f.folder, &f.header, || Ok(()), |_| Ok(())).unwrap_err();
    assert!(error.to_string().contains("modifications locales"));
    assert_eq!(
        replay::state_fingerprint(&f.store.connect().unwrap()).unwrap(),
        pending_before
    );
    assert_eq!(
        fs::read(f.store.attachments_dir.join("existing.txt")).unwrap(),
        OLD
    );
    assert!(!f.store.attachments_dir.join("added.txt").exists());
    for at in [
        Point::IntentSaved,
        Point::FileInstalled(1),
        Point::BeforeCommit,
    ] {
        let f = fixture();
        let current = std::cell::Cell::new(true);
        let error = install(
            &f.store,
            &f.folder,
            &f.header,
            || {
                if current.get() {
                    Ok(())
                } else {
                    Err(invalid("Session changed"))
                }
            },
            |p| {
                if p == at {
                    current.set(false);
                }
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("Session changed"));
        assert_state(&f, false);
    }
}
#[test]
fn an_unregistered_local_file_cannot_be_overwritten_by_a_received_document() {
    let f = fixture();
    let path = f.store.attachments_dir.join("added.txt");
    fs::write(&path, b"Local unrelated version").unwrap();
    let error = install(&f.store, &f.folder, &f.header, || Ok(()), |_| Ok(())).unwrap_err();
    assert!(error.to_string().contains("fichier local différent"));
    assert_eq!(fs::read(&path).unwrap(), b"Local unrelated version");
    fs::remove_file(path).unwrap();
    assert_state(&f, false);
}

#[test]
fn an_unchanged_registry_reference_with_a_case_alias_prevents_replacing_its_file() {
    let f = fixture_with_alias(true);
    let error = install(&f.store, &f.folder, &f.header, || Ok(()), |_| Ok(())).unwrap_err();
    assert!(error.to_string().contains("majuscules"), "{error}");
    assert_state(&f, false);
}

#[test]
fn authenticated_hashes_do_not_authorize_a_file_path_unrelated_to_its_business_row() {
    let mut f = fixture();
    let folder = &f.folder;
    let mut changes: Value =
        serde_json::from_slice(&fs::read(folder.join("changes/0000.json")).unwrap()).unwrap();
    for row in changes["changes"].as_array_mut().unwrap() {
        for key in ["files_before", "files_after"] {
            for file in row[key].as_array_mut().unwrap() {
                if file["path"] == "existing.txt" {
                    file["path"] = json!("victim.txt");
                }
            }
        }
    }
    let raw = serde_json::to_vec(&changes).unwrap();
    let mut positions: Value =
        serde_json::from_slice(&fs::read(folder.join("positions/0000.json")).unwrap()).unwrap();
    positions["source_sha256"] = json!(digest(&raw));
    let positions = serde_json::to_vec(&positions).unwrap();
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(folder.join("manifest.json")).unwrap()).unwrap();
    manifest["size_bytes"] = json!(raw.len());
    manifest["chunks"][0]["sha256"] = json!(digest(&raw));
    manifest["chunks"][0]["size_bytes"] = json!(raw.len());
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let mut bundle: Value =
        serde_json::from_slice(&fs::read(folder.join("bundle.json")).unwrap()).unwrap();
    bundle["original_manifest_sha256"] = json!(digest(&manifest));
    bundle["parts"][0]["source_sha256"] = json!(digest(&raw));
    bundle["parts"][0]["source_bytes"] = json!(raw.len());
    bundle["parts"][0]["positions_sha256"] = json!(digest(&positions));
    bundle["parts"][0]["positions_bytes"] = json!(positions.len());
    let receipt = serde_json::to_vec(&super::super::super::tests::receipt(&bundle)).unwrap();
    let bundle = serde_json::to_vec(&bundle).unwrap();
    f.header.entry.bundle_sha256 = digest(&bundle);
    f.header.entry.receipt_sha256 = digest(&receipt);
    for (path, bytes) in [
        ("changes/0000.json", raw),
        ("positions/0000.json", positions),
        ("manifest.json", manifest),
        ("bundle.json", bundle),
        ("receipt.json", receipt),
        ("header.json", serde_json::to_vec(&f.header).unwrap()),
    ] {
        fs::write(folder.join(path), bytes).unwrap();
    }
    fs::write(f.store.attachments_dir.join("victim.txt"), OLD).unwrap();
    verify_downloaded(folder, &f.header).unwrap();
    let error = install(&f.store, folder, &f.header, || Ok(()), |_| Ok(())).unwrap_err();
    assert!(error.to_string().contains("ligne métier"), "{error}");
    assert_state(&f, false);
    assert_eq!(
        fs::read(f.store.attachments_dir.join("victim.txt")).unwrap(),
        OLD
    );
}
#[test]
fn changed_downloads_or_receipts_cannot_start_installation() {
    for name in [
        "receipt.json",
        "header.json",
        "manifest.json",
        "bundle.json",
        "changes/0000.json",
        "positions/0000.json",
    ] {
        let f = fixture();
        fs::write(f.folder.join(name), b"{}").unwrap();
        assert!(
            install(&f.store, &f.folder, &f.header, || Ok(()), |_| Ok(())).is_err(),
            "{name}"
        );
        assert_state(&f, false);
    }
    let f = fixture();
    fs::write(f.folder.join("files").join(digest(NEW)), b"damaged").unwrap();
    assert!(install(&f.store, &f.folder, &f.header, || Ok(()), |_| Ok(())).is_err());
    assert_state(&f, false);
}
#[test]
fn recovery_preserves_unexpected_edits_and_blocks_further_app_writes_until_resolved() {
    for committed in [false, true] {
        let f = fixture();
        crash(
            &f,
            if committed {
                Point::Committed
            } else {
                Point::BeforeCommit
            },
        );
        let path = f.store.attachments_dir.join("existing.txt");
        fs::write(&path, b"Edited outside the app").unwrap();
        assert!(LocalStore::initialize(f.store.data_dir.clone()).is_err());
        // Tauri's create_record command takes this gate before calling the store.
        let attempt = (|| -> AppResult<Value> {
            let _guard = f.store.lock()?;
            f.store
                .create_record("clients", json!({"name":"Must wait for recovery"}))
        })();
        assert!(attempt.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"Edited outside the app");
        assert!(f
            .store
            .data_dir
            .join("business-installation/intent.json")
            .exists());
        fs::write(path, NEW).unwrap();
        LocalStore::initialize(f.store.data_dir.clone()).unwrap();
        assert_state(&f, committed);
    }
}
#[test]
fn a_damaged_rollback_copy_is_preserved_for_recovery_instead_of_silently_discarded() {
    let f = fixture();
    crash(&f, Point::BeforeCommit);
    let root = f.store.data_dir.join("business-installation");
    let intent: Value =
        serde_json::from_slice(&fs::read(root.join("intent.json")).unwrap()).unwrap();
    let index = intent["steps"]
        .as_array()
        .unwrap()
        .iter()
        .position(|s| s["path"] == "existing.txt")
        .unwrap();
    let backup = root
        .join(intent["stage"].as_str().unwrap())
        .join(index.to_string());
    fs::write(&backup, b"damaged backup").unwrap();
    assert!(LocalStore::initialize(f.store.data_dir.clone()).is_err());
    assert_eq!(
        fs::read(f.store.attachments_dir.join("existing.txt")).unwrap(),
        NEW
    );
    assert!(root.join("intent.json").exists());
    fs::write(backup, OLD).unwrap();
    LocalStore::initialize(f.store.data_dir.clone()).unwrap();
    assert_state(&f, false);
}

#[test]
fn migrating_61_adds_only_local_receipt_metadata_and_preserves_the_shared_contract() {
    let f = fixture();
    let c = f.store.connect().unwrap();
    let contract = snapshot::contract_hash().unwrap();
    c.execute_batch("DROP TABLE business_sync_installed_revisions; PRAGMA user_version=61;")
        .unwrap();
    drop(c);
    let s = LocalStore::initialize(f.store.data_dir.clone()).unwrap();
    assert_eq!(
        s.connect()
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::schema::SCHEMA_VERSION
    );
    assert_eq!(snapshot::contract_hash().unwrap(), contract);
    assert_eq!(business_sync::DATA_SCHEMA_VERSION, 60);
    assert_state(&f, false);
}

#[test]
fn recovery_never_rolls_back_files_while_another_sqlite_writer_is_active() {
    let f = fixture();
    crash(&f, Point::BeforeCommit);
    let writer = f.store.connect().unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(journal::recover(&f.store).is_err());
    assert_eq!(
        fs::read(f.store.attachments_dir.join("existing.txt")).unwrap(),
        NEW
    );
    assert!(f
        .store
        .data_dir
        .join("business-installation/intent.json")
        .exists());
    writer.execute_batch("ROLLBACK").unwrap();
    drop(writer);
    journal::recover(&f.store).unwrap();
    assert_state(&f, false);
}

#[test]
#[ignore = "Requires the exact D1-produced fixture; run explicitly with ZENTRA_CANONICAL_DELIVERY_QA"]
fn installs_actual_d1_revision_into_the_working_profile_with_exact_canonical_rowids() {
    let input = PathBuf::from(std::env::var("ZENTRA_CANONICAL_DELIVERY_QA").unwrap());
    let proof: Value =
        serde_json::from_slice(&fs::read(input.join("proof.json")).unwrap()).unwrap();
    let root = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(root.path().join("receiver")).unwrap();
    let source = rusqlite::Connection::open(input.join("baseline.sqlite")).unwrap();
    let mut target = store.connect().unwrap();
    rusqlite::backup::Backup::new(&source, &mut target)
        .unwrap()
        .run_to_completion(256, Duration::from_millis(1), None)
        .unwrap();
    let organization = proof["organization_id"].as_str().unwrap();
    let generation = proof["generation"].as_str().unwrap();
    target.execute("UPDATE business_sync_binding SET organization_id=?1,installation_id=?2,generation=?3 WHERE id=1",params![organization,store.installation_id,Uuid::new_v4().to_string()]).unwrap();
    target
        .execute(
            "UPDATE business_sync_baseline SET organization_id=?1,server_generation=?2 WHERE id=1",
            params![organization, generation],
        )
        .unwrap();
    drop(target);
    store.migrate().unwrap();
    let raw = fs::read(input.join("commit-receipt.json")).unwrap();
    let receipt: Value = serde_json::from_slice(&raw).unwrap();
    let binding = Binding::read(&store, organization).unwrap();
    let header=Header{version:1,binding,entry:serde_json::from_value(json!({"transaction_id":proof["transaction_id"],"source_revision":proof["source_revision"],"revision":proof["revision"],"bundle_sha256":proof["bundle_sha256"],"receipt_sha256":proof["receipt_sha256"],"origin_installation_id":receipt["origin_installation_id"]})).unwrap()};
    let folder = store
        .data_dir
        .join("business-reception")
        .join(digest(&serde_json::to_vec(&header.binding).unwrap()))
        .join(&header.entry.transaction_id);
    for directory in ["changes", "positions", "files"] {
        fs::create_dir_all(folder.join(directory)).unwrap();
    }
    fs::write(
        folder.join("header.json"),
        serde_json::to_vec(&header).unwrap(),
    )
    .unwrap();
    fs::write(folder.join("receipt.json"), &raw).unwrap();
    fs::copy(input.join("bundle.json"), folder.join("bundle.json")).unwrap();
    fs::copy(
        input.join("original-manifest.json"),
        folder.join("manifest.json"),
    )
    .unwrap();
    for i in 0..proof["parts"].as_u64().unwrap() {
        for kind in ["changes", "positions"] {
            fs::copy(
                input.join(format!("{kind}-{i:04}.json")),
                folder.join(kind).join(format!("{i:04}.json")),
            )
            .unwrap();
        }
    }
    install(&store, &folder, &header, || Ok(()), |_| Ok(())).unwrap();
    let c = store.connect().unwrap();
    assert_eq!(
        replay::state_fingerprint(&c).unwrap(),
        proof["target_state_sha256"].as_str().unwrap()
    );
    assert_eq!(
        c.query_row(
            "SELECT CAST(rowid AS TEXT) FROM clients WHERE id=?1",
            [proof["client_id"].as_str().unwrap()],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "9007199254740993"
    );
    assert_eq!(
        installed(&store, organization, &header.entry.transaction_id)
            .unwrap()
            .unwrap()
            .as_bytes(),
        raw
    );
    assert_eq!(Binding::read(&store, organization).unwrap().revision, 2);
    assert_eq!(
        install(&store, &folder, &header, || Ok(()), |_| Ok(())).unwrap()["already_installed"],
        true
    );
}
