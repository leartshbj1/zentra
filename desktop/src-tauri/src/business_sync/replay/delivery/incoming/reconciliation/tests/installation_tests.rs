use super::super::install::{reconcile, Point};
use super::*;
use crate::error::AppError;
use std::cell::Cell;

fn journal(store: &LocalStore) -> Vec<String> {
    store.connect().unwrap().prepare("SELECT json_array(sequence,generation,transaction_id,organization_id,installation_id,table_name,row_key_json,operation,before_json,after_json,source_rowid,base_revision) FROM business_sync_changes ORDER BY sequence").unwrap().query_map([], |r|r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}
fn installed(store: &LocalStore) -> i64 {
    store
        .connect()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM business_sync_installed_revisions",
            [],
            |r| r.get(0),
        )
        .unwrap()
}
fn acknowledge_count(store: &LocalStore) -> i64 {
    store
        .connect()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM business_sync_receipts", [], |r| {
            r.get(0)
        })
        .unwrap()
}
fn local_edit(store: &LocalStore) {
    store
        .connect()
        .unwrap()
        .execute("UPDATE clients SET name='Later edit' WHERE id='own'", [])
        .unwrap();
}
fn client(store: &LocalStore, id: &str) {
    store.connect().unwrap().execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES(?1,?1,'2026-09-09','2026-09-09')",[id]).unwrap();
}
#[test]
fn own_install_acknowledges_only_first_transaction_and_preserves_later_original_evidence() {
    let (_root, store, p, before, after) = setup();
    let (folder, header) = stage(&store, &p, &before, &after);
    local_edit(&store);
    let original = journal(&store);
    let working = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
    let local = replay::local_fingerprint(&store.connect().unwrap()).unwrap();
    let gated = Cell::new(false);
    let result = reconcile(
        &store,
        &folder,
        &header,
        "owner",
        || Ok(()),
        |point| {
            if point == Point::DatabaseLocked {
                let c = rusqlite::Connection::open(&store.database_path).unwrap();
                c.busy_timeout(std::time::Duration::ZERO).unwrap();
                assert!(c.execute_batch("BEGIN IMMEDIATE").is_err());
                assert_eq!(
                    c.query_row("SELECT name FROM clients WHERE id='own'", [], |r| r
                        .get::<_, String>(0))
                        .unwrap(),
                    "Later edit"
                );
                gated.set(true);
            }
            Ok(())
        },
    )
    .unwrap();
    assert!(gated.get());
    assert_eq!(result["installed"], true);
    assert_eq!(result["acknowledged"], true);
    assert_eq!(journal(&store), original);
    assert_eq!(installed(&store), 1);
    assert_eq!(acknowledge_count(&store), 1);
    assert_eq!(Binding::read(&store, "org-replay").unwrap().revision, 2);
    assert_eq!(
        replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
        working
    );
    assert_eq!(
        replay::local_fingerprint(&store.connect().unwrap()).unwrap(),
        local
    );
    let next = outgoing::prepare_next(&store, "org-replay", "owner")
        .unwrap()
        .unwrap();
    assert_ne!(next.manifest.transaction_id, p.manifest.transaction_id);
    assert_eq!(next.manifest.change_count, 1);
    let again = reconcile(
        &store,
        &folder,
        &header,
        "owner",
        || Ok(()),
        |_| panic!("Already installed"),
    )
    .unwrap();
    assert_eq!(again["already_installed"], true);
    assert_eq!(again["acknowledged"], true);
    assert_eq!(journal(&store), original);
}

#[test]
fn new_writes_after_preparation_abort_without_acknowledging_or_advancing() {
    for local_only in [false, true] {
        let (_root, store, p, before, after) = setup();
        let (folder, header) = stage(&store, &p, &before, &after);
        let expected = std::cell::RefCell::new(String::new());
        let error=reconcile(&store,&folder,&header,"owner",||Ok(()),|point| {
            if point==Point::Prepared {
                if local_only {
                    store.connect().unwrap().execute("INSERT INTO number_sequences(document_type,year,next_value) VALUES('quote',2099,73)",[]).unwrap();
                } else { local_edit(&store); }
                *expected.borrow_mut()=replay::state_fingerprint(&store.connect().unwrap()).unwrap();
            }
            Ok(())
        }).unwrap_err();
        assert!(error.to_string().contains("changé"), "{error}");
        assert_eq!(
            replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
            *expected.borrow()
        );
        assert_eq!(installed(&store), 0);
        assert_eq!(acknowledge_count(&store), 0);
        assert_eq!(Binding::read(&store, "org-replay").unwrap().revision, 1);
    }
}

const OLD: &[u8] = b"Old project document";
const NEW: &[u8] = b"New project document from another device";
const ADDED: &[u8] = b"Added drawing";
fn attachment(c: &rusqlite::Connection, id: &str, path: &str, bytes: &[u8]) {
    c.execute("INSERT INTO attachments(id,original_name,stored_name,size_bytes,sha256,created_at,updated_at) VALUES(?1,?2,?2,?3,?4,'2026-09-09','2026-09-09')",params![id,path,bytes.len() as i64,digest(bytes)]).unwrap();
}
fn retain(store: &LocalStore) {
    let rule = &crate::business_sync::policy().unwrap().tables["attachments"];
    store.connect().unwrap().query_row(&format!("SELECT zentra_sync_retain_files('attachments',{}) FROM attachments r WHERE id='old'",crate::business_sync::json_image("r",&rule.columns).unwrap()),[],|r|r.get::<_,i64>(0)).unwrap();
}
struct Fixture {
    _source: tempfile::TempDir,
    _receiver: tempfile::TempDir,
    store: LocalStore,
    folder: PathBuf,
    header: Header,
    working: String,
    merged: String,
    journal: Vec<String>,
}
fn fixture() -> Fixture {
    fixture_with_pending(true)
}
fn fixture_with_pending(pending: bool) -> Fixture {
    let (source_root, source, _) = replay::tests::setup_with(|s| {
        fs::write(s.attachments_dir.join("plan.txt"), OLD).unwrap();
        attachment(&s.connect().unwrap(), "old", "plan.txt", OLD);
    });
    let (receiver_root, store) = replay::tests::copy_receiver(&source);
    fs::write(store.attachments_dir.join("plan.txt"), OLD).unwrap();
    fs::write(
        store.attachments_dir.join("unregistered.txt"),
        b"Personal file",
    )
    .unwrap();
    let before = replay::state_fingerprint(&source.connect().unwrap()).unwrap();
    if pending {
        client(&store, "local-pending");
    }
    retain(&source);
    fs::write(source.attachments_dir.join("plan.txt"), NEW).unwrap();
    fs::write(source.attachments_dir.join("added.txt"), ADDED).unwrap();
    let mut c = source.connect().unwrap();
    let tx = c.transaction().unwrap();
    tx.execute("DELETE FROM attachments WHERE id='old'", [])
        .unwrap();
    attachment(&tx, "new", "plan.txt", NEW);
    attachment(&tx, "added", "added.txt", ADDED);
    tx.commit().unwrap();
    let after = replay::state_fingerprint(&source.connect().unwrap()).unwrap();
    let p = outgoing::prepare_next(&source, "org-replay", "owner")
        .unwrap()
        .unwrap();
    let (folder, header) = stage_from(&store, &source, &p, &before, &after);
    let merged = if pending {
        let prepared = prepare(&store, &folder, &header, "owner", || Ok(())).unwrap();
        prepared["merged_state_sha256"]
            .as_str()
            .expect("No conflict")
            .into()
    } else {
        after
    };
    Fixture {
        working: replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
        journal: journal(&store),
        _source: source_root,
        _receiver: receiver_root,
        store,
        folder,
        header,
        merged,
    }
}
#[test]
fn installation_permission_gates_both_direct_and_pending_paths_before_live_writes() {
    for pending in [false, true] {
        let f = fixture_with_pending(pending);
        let requested = Cell::new(0);
        let result = reconcile(
            &f.store,
            &f.folder,
            &f.header,
            "owner",
            || Ok(()),
            |point| {
                if point == Point::Prepared {
                    requested.set(requested.get() + 1);
                    return Err(AppError::BusinessInstallDeferred);
                }
                panic!("A denied installation reached a write checkpoint: {point:?}");
            },
        );
        assert!(matches!(result, Err(AppError::BusinessInstallDeferred)));
        assert_eq!(requested.get(), 1);
        assert_eq!(
            replay::state_fingerprint(&f.store.connect().unwrap()).unwrap(),
            f.working
        );
        assert_eq!(journal(&f.store), f.journal);
        assert_eq!(installed(&f.store), 0);
        assert_eq!(acknowledge_count(&f.store), 0);
        assert_eq!(Binding::read(&f.store, "org-replay").unwrap().revision, 1);
        assert_eq!(
            fs::read(f.store.attachments_dir.join("plan.txt")).unwrap(),
            OLD
        );
        assert!(!f.store.attachments_dir.join("added.txt").exists());
        assert!(!f
            .store
            .data_dir
            .join("business-installation/intent.json")
            .exists());

        let permitted = Cell::new(false);
        let result = reconcile(
            &f.store,
            &f.folder,
            &f.header,
            "owner",
            || Ok(()),
            |point| {
                if point == Point::Prepared {
                    permitted.set(true);
                } else {
                    assert!(permitted.get(), "Write before installation permission");
                }
                Ok(())
            },
        )
        .unwrap();
        assert!(permitted.get());
        assert_eq!(result["installed"], true);
        assert_eq!(
            replay::state_fingerprint(&f.store.connect().unwrap()).unwrap(),
            f.merged
        );
        assert_eq!(journal(&f.store), f.journal);
        assert_eq!(installed(&f.store), 1);
        assert_eq!(Binding::read(&f.store, "org-replay").unwrap().revision, 2);
        assert_eq!(
            fs::read(f.store.attachments_dir.join("plan.txt")).unwrap(),
            NEW
        );
        assert_eq!(
            fs::read(f.store.attachments_dir.join("added.txt")).unwrap(),
            ADDED
        );
    }
}
fn assert_state(f: &Fixture, committed: bool) {
    assert_eq!(
        replay::state_fingerprint(&f.store.connect().unwrap()).unwrap(),
        if committed { &f.merged } else { &f.working }.as_str()
    );
    assert_eq!(
        fs::read(f.store.attachments_dir.join("plan.txt")).unwrap(),
        if committed { NEW } else { OLD }
    );
    assert_eq!(
        f.store.attachments_dir.join("added.txt").exists(),
        committed
    );
    assert_eq!(
        fs::read(f.store.attachments_dir.join("unregistered.txt")).unwrap(),
        b"Personal file"
    );
    assert_eq!(journal(&f.store), f.journal);
    assert_eq!(installed(&f.store), i64::from(committed));
    assert_eq!(acknowledge_count(&f.store), 0);
    assert_eq!(
        Binding::read(&f.store, "org-replay").unwrap().revision,
        if committed { 2 } else { 1 }
    );
    assert!(!f
        .store
        .data_dir
        .join("business-installation/intent.json")
        .exists());
    assert!(
        fs::read_dir(f.store.data_dir.join("business-workspaces"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("v1-")),
        "Disposed or recovered reconciliation workspaces must be collected"
    );
}
#[test]
fn remote_install_keeps_pending_work_and_recovers_errors_before_and_after_sqlite_commit() {
    for point in [
        Point::IntentSaved,
        Point::FileInstalled(0),
        Point::FileInstalled(1),
        Point::BeforeCommit,
        Point::DatabaseCopied(256, false),
        Point::Committed,
    ] {
        let f = fixture();
        let hit = Cell::new(false);
        let error = reconcile(
            &f.store,
            &f.folder,
            &f.header,
            "owner",
            || Ok(()),
            |p| {
                if p == point {
                    hit.set(true);
                    Err(invalid("Injected reconciliation error"))
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert!(hit.get(), "{point:?}: {error}");
        assert_state(&f, point == Point::Committed);
        if point != Point::Committed {
            let result = reconcile(
                &f.store,
                &f.folder,
                &f.header,
                "owner",
                || Ok(()),
                |_| Ok(()),
            )
            .unwrap();
            assert_eq!(result["installed"], true);
            assert_eq!(result["acknowledged"], false);
            assert_state(&f, true);
        }
    }
}

#[test]
#[ignore = "Isolated process worker invoked by the recovery test"]
fn reconciliation_crash_worker() {
    let store = LocalStore::initialize(PathBuf::from(
        std::env::var("ZENTRA_RECONCILE_PROFILE").unwrap(),
    ))
    .unwrap();
    let folder = PathBuf::from(std::env::var("ZENTRA_RECONCILE_FOLDER").unwrap());
    let point = std::env::var("ZENTRA_RECONCILE_POINT").unwrap();
    let header: Header =
        serde_json::from_slice(&fs::read(folder.join("header.json")).unwrap()).unwrap();
    reconcile(
        &store,
        &folder,
        &header,
        "owner",
        || Ok(()),
        |p| {
            if format!("{p:?}") == point {
                std::process::exit(75);
            }
            Ok(())
        },
    )
    .unwrap();
    panic!("Crash boundary not reached");
}
#[test]
fn process_exit_during_database_copy_or_after_commit_recovers_rows_documents_and_pending_evidence()
{
    for point in [
        Point::FileInstalled(0),
        Point::DatabaseCopied(256, false),
        Point::Committed,
    ] {
        let f = fixture();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child=command.args(["business_sync::replay::delivery::incoming::reconciliation::tests::installation_tests::reconciliation_crash_worker","--exact","--ignored","--nocapture"])
            .env("ZENTRA_RECONCILE_PROFILE",&f.store.data_dir).env("ZENTRA_RECONCILE_FOLDER",&f.folder).env("ZENTRA_RECONCILE_POINT",format!("{point:?}")).spawn().unwrap();
        let start = std::time::Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert_eq!(status.code(), Some(75));
                break;
            }
            if start.elapsed() > std::time::Duration::from_secs(90) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("Crash worker timed out");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let restarted = LocalStore::initialize(f.store.data_dir.clone()).unwrap();
        assert_eq!(restarted.installation_id, f.store.installation_id);
        assert_state(&f, point == Point::Committed);
    }
}

fn replace_positions(folder: &Path, header: &mut Header, rowid: i64) {
    let mut positions: Value =
        serde_json::from_slice(&fs::read(folder.join("positions/0000.json")).unwrap()).unwrap();
    for position in positions["positions"].as_array_mut().unwrap() {
        position["canonical_rowid"] = json!(rowid.to_string());
    }
    let positions = serde_json::to_vec(&positions).unwrap();
    fs::write(folder.join("positions/0000.json"), &positions).unwrap();
    let mut bundle: Value =
        serde_json::from_slice(&fs::read(folder.join("bundle.json")).unwrap()).unwrap();
    bundle["parts"][0]["positions_sha256"] = json!(digest(&positions));
    bundle["parts"][0]["positions_bytes"] = json!(positions.len());
    let receipt = serde_json::to_vec(&replay::delivery::tests::receipt(&bundle)).unwrap();
    let bundle = serde_json::to_vec(&bundle).unwrap();
    header.entry.bundle_sha256 = digest(&bundle);
    header.entry.receipt_sha256 = digest(&receipt);
    fs::write(folder.join("bundle.json"), bundle).unwrap();
    fs::write(folder.join("receipt.json"), receipt).unwrap();
    fs::write(
        folder.join("header.json"),
        serde_json::to_vec(header).unwrap(),
    )
    .unwrap();
}
#[test]
fn remote_then_own_install_uses_durable_aliases_without_rewriting_the_outgoing_transaction() {
    let (_source_root, source, context) = replay::tests::setup_with(|_| {});
    let (_root, store) = replay::tests::copy_receiver(&source);
    client(&store, "own");
    let own = outgoing::prepare_next(&store, "org-replay", "owner")
        .unwrap()
        .unwrap();
    let original_manifest = serde_json::to_vec(&own.manifest).unwrap();
    let original_changes = fs::read(own.folder.join("0000.json")).unwrap();
    client(&source, "remote");
    let remote = outgoing::prepare_next(&source, "org-replay", "owner")
        .unwrap()
        .unwrap();
    let canonical = replay::state_fingerprint(&source.connect().unwrap()).unwrap();
    let (folder, header) = stage_from(
        &store,
        &source,
        &remote,
        &context.source_state_sha256,
        &canonical,
    );
    reconcile(&store, &folder, &header, "owner", || Ok(()), |_| Ok(())).unwrap();
    assert_eq!(acknowledge_count(&store), 0);
    let remapped: i64 = store
        .connect()
        .unwrap()
        .query_row("SELECT rowid FROM clients WHERE id='own'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(remapped, 2);
    let target = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
    let still_pending = outgoing::prepare_next(&store, "org-replay", "owner")
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_vec(&still_pending.manifest).unwrap(),
        original_manifest
    );
    assert_eq!(
        fs::read(still_pending.folder.join("0000.json")).unwrap(),
        original_changes
    );
    local_edit(&store);
    let evidence = journal(&store);
    let merged = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
    let (folder, mut header) = stage(&store, &own, &canonical, &target);
    replace_positions(&folder, &mut header, remapped);
    let result = reconcile(&store, &folder, &header, "owner", || Ok(()), |_| Ok(())).unwrap();
    assert_eq!(result["acknowledged"], true);
    assert_eq!(journal(&store), evidence);
    assert_eq!(Binding::read(&store, "org-replay").unwrap().revision, 3);
    assert_eq!(
        replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
        merged
    );
    // A third real installation consumes the preceding cache and the new event
    // created after remapping; its payload still carries the original capture.
    let later = outgoing::prepare_next(&store, "org-replay", "owner")
        .unwrap()
        .unwrap();
    let (folder, header) = stage(&store, &later, &target, &merged);
    reconcile(&store, &folder, &header, "owner", || Ok(()), |_| Ok(())).unwrap();
    assert_eq!(acknowledge_count(&store), 2);
    assert_eq!(journal(&store), evidence);
    assert!(outgoing::prepare_next(&store, "org-replay", "owner")
        .unwrap()
        .is_none());
    let cache = store
        .attachments_dir
        .join(crate::business_sync::files::DIRECTORY)
        .join("canonical")
        .join(&header.binding.generation);
    let names: Vec<_> = fs::read_dir(cache)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(names.iter().any(|n| n.starts_with("3-")));
    assert!(names.iter().any(|n| n.starts_with("4-")));
}

#[test]
fn older_received_document_never_replaces_its_later_local_version_and_tampering_aborts() {
    let (_root, store, context) = replay::tests::setup_with(|_| {});
    fs::write(store.attachments_dir.join("plan.txt"), OLD).unwrap();
    attachment(&store.connect().unwrap(), "old", "plan.txt", OLD);
    let after = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
    let p = outgoing::prepare_next(&store, "org-replay", "owner")
        .unwrap()
        .unwrap();
    let (folder, header) = stage(&store, &p, &context.source_state_sha256, &after);
    retain(&store);
    fs::write(store.attachments_dir.join("plan.txt"), NEW).unwrap();
    let mut c = store.connect().unwrap();
    let tx = c.transaction().unwrap();
    tx.execute("DELETE FROM attachments WHERE id='old'", [])
        .unwrap();
    attachment(&tx, "new", "plan.txt", NEW);
    tx.commit().unwrap();
    let expected = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
    let original = journal(&store);
    fs::write(
        store.attachments_dir.join("plan.txt"),
        b"Unregistered changed bytes",
    )
    .unwrap();
    assert!(reconcile(&store, &folder, &header, "owner", || Ok(()), |_| Ok(())).is_err());
    assert_eq!(
        fs::read(store.attachments_dir.join("plan.txt")).unwrap(),
        b"Unregistered changed bytes"
    );
    assert_eq!(installed(&store), 0);
    fs::write(store.attachments_dir.join("plan.txt"), NEW).unwrap();
    let result = reconcile(&store, &folder, &header, "owner", || Ok(()), |_| Ok(())).unwrap();
    assert_eq!(result["documents_verified"], true);
    assert_eq!(
        fs::read(store.attachments_dir.join("plan.txt")).unwrap(),
        NEW
    );
    assert_eq!(
        replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
        expected
    );
    assert_eq!(journal(&store), original);
    assert_eq!(acknowledge_count(&store), 1);
}

#[test]
fn session_loss_before_commit_and_unregistered_file_collisions_preserve_pending_work() {
    let f = fixture();
    fs::write(f.store.attachments_dir.join("added.txt"), b"Local drawing").unwrap();
    assert!(reconcile(
        &f.store,
        &f.folder,
        &f.header,
        "owner",
        || Ok(()),
        |_| Ok(())
    )
    .is_err());
    assert_eq!(
        fs::read(f.store.attachments_dir.join("added.txt")).unwrap(),
        b"Local drawing"
    );
    assert_eq!(installed(&f.store), 0);
    fs::remove_file(f.store.attachments_dir.join("added.txt")).unwrap();
    let current = Cell::new(true);
    let error = reconcile(
        &f.store,
        &f.folder,
        &f.header,
        "owner",
        || {
            if current.get() {
                Ok(())
            } else {
                Err(invalid("Session changed"))
            }
        },
        |point| {
            if point == Point::BeforeCommit {
                current.set(false);
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("Session changed"));
    assert_state(&f, false);
}

#[test]
fn full_backup_contains_the_exact_installed_canonical_cache() {
    let f = fixture();
    reconcile(
        &f.store,
        &f.folder,
        &f.header,
        "owner",
        || Ok(()),
        |_| Ok(()),
    )
    .unwrap();
    let output = f.store.data_dir.join("reconciliation-backup.zentra");
    f.store
        .create_backup_at(&output, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
    let cache = f
        .store
        .attachments_dir
        .join(crate::business_sync::files::DIRECTORY)
        .join("canonical")
        .join(&f.header.binding.generation);
    let files: Vec<_> = fs::read_dir(cache)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1);
    for path in files {
        let entry = format!(
            "attachments/{}/canonical/{}/{}",
            crate::business_sync::files::DIRECTORY,
            f.header.binding.generation,
            path.file_name().unwrap().to_str().unwrap()
        );
        let mut bytes = Vec::new();
        archive
            .by_name(&entry)
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, fs::read(path).unwrap());
    }
    assert_state(&f, true);
}

#[test]
fn registered_logo_versions_require_original_proofs_even_when_current_bytes_are_available() {
    let (_root, store, context) = replay::tests::setup_with(|_| {});
    let activate = |name: &str, color: [u8; 3]| {
        let external = store.data_dir.join(name);
        image::RgbImage::from_pixel(32, 32, image::Rgb(color))
            .save(&external)
            .unwrap();
        let mut c = store.connect().unwrap();
        let tx = c.transaction().unwrap();
        let managed = crate::branding::stage_active_company_logo_for_snapshot(
            &tx,
            external.to_str().unwrap(),
        )
        .unwrap();
        tx.execute("UPDATE settings SET logo_path=?1 WHERE id=1", [&managed])
            .unwrap();
        tx.commit().unwrap();
        PathBuf::from(managed)
    };
    let old = activate("legacy-source.png", [25, 55, 85]);
    let after = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
    let p = outgoing::prepare_next(&store, "org-replay", "owner")
        .unwrap()
        .unwrap();
    let (folder, header) = stage(&store, &p, &context.source_state_sha256, &after);
    let logo = activate("new-source.png", [105, 75, 45]);
    let bytes = fs::read(&logo).unwrap();
    assert_ne!(logo, old);
    let working = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
    let evidence = journal(&store);
    let proof = crate::business_sync::files::retained_blob_path(
        &store.data_dir,
        &digest(&bytes),
        bytes.len() as u64,
    )
    .unwrap();
    fs::remove_file(&proof).unwrap();
    assert!(reconcile(&store, &folder, &header, "owner", || Ok(()), |_| Ok(())).is_err());
    assert_eq!(fs::read(&logo).unwrap(), bytes);
    assert_eq!(installed(&store), 0);
    assert!(!proof.exists());
    fs::write(proof, &bytes).unwrap();
    reconcile(&store, &folder, &header, "owner", || Ok(()), |_| Ok(())).unwrap();
    assert_eq!(fs::read(&logo).unwrap(), bytes);
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row("SELECT logo_path FROM settings WHERE id=1", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        logo.to_string_lossy()
    );
    assert!(old.exists());
    assert_eq!(
        replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
        working
    );
    assert_eq!(journal(&store), evidence);
    assert_eq!(acknowledge_count(&store), 1);
}
