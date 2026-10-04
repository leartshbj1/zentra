//! Real delayed three-way merge application with older-producer metadata.
//! No external HTTP, installed older binary, or production account is used.
//! These witnesses must be compiled/executed by the native CI gate.
use super::*;
use tauri::Manager;

const ORGANIZATION: &str = "merge-version-compat-company";

fn older_manifest(manifest: crate::cloud_backup::Manifest) -> crate::cloud_backup::Manifest {
    let mut value = serde_json::to_value(manifest).unwrap();
    value["app_version"] = json!("1.90.12");
    let original: crate::cloud_backup::Manifest = serde_json::from_value(value).unwrap();
    original.validate().unwrap();
    original
}

struct Fixture {
    _directory: tempfile::TempDir,
    receiver: LocalStore,
    local_client: String,
    remote_client: String,
    reference_path: PathBuf,
    received_path: PathBuf,
}

fn local_context(store: &LocalStore) -> (String, String, String, i64) {
    let _local = store.lock().unwrap();
    let connection = store.connect().unwrap();
    (
        crate::work_notes::workspace_scope(&connection).unwrap(),
        crate::member_context::read(&connection).unwrap(),
        crate::company_sync_digest::local(store).unwrap(),
        clock(store).unwrap(),
    )
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let common = LocalStore::initialize(directory.path().join("common")).unwrap();
    common.complete_onboarding(crate::tests::test_onboarding(), "1.90.12").unwrap();
    common.create_record("clients", json!({"name":"Common synthetic client"})).unwrap();
    let base = directory.path().join("base-before-upgrade.zentra");
    common.create_backup_at(&base, "1.90.12").unwrap();
    let receiver = LocalStore::initialize(directory.path().join("receiver")).unwrap();
    let remote = LocalStore::initialize(directory.path().join("remote")).unwrap();
    for target in [&receiver, &remote] {
        apply(target, &base, ORGANIZATION, 1, clock(target).unwrap(), true, false).unwrap();
    }
    set_identity(&receiver, ORGANIZATION, "synthetic-member", "Synthetic Member", "owner").unwrap();
    let now = chrono::Utc::now();
    crate::account_cloud::write_automation_session_for_test(&receiver, &json!({
        "version":1, "installation_id":receiver.installation_id,
        "session_token":format!("zds_{}", "M".repeat(43)),
        "session_expires_at":(now + chrono::Duration::hours(1)).to_rfc3339(),
        "organization_id":ORGANIZATION, "organization_name":"Synthetic merged company",
        "role":"owner", "connected_at":now.to_rfc3339()
    })).unwrap();
    let local = receiver.create_record("clients", json!({"name":"Local synthetic client"})).unwrap();
    let remote_client = remote.create_record("clients", json!({"name":"Remote synthetic client"})).unwrap();
    fs::write(receiver.attachments_dir.join("local-plan.txt"), b"local plan retained").unwrap();
    fs::write(remote.attachments_dir.join("remote-photo.txt"), b"remote photo retained").unwrap();
    let reference_path = file_path(&receiver, &uuid::Uuid::new_v4().to_string()).unwrap();
    // Real archive bytes declare the older producer version. The actual merge
    // keeps this original remote archive manifest in its own output.
    remote.create_backup_at(&reference_path, "1.90.12").unwrap();
    let before = local_context(&receiver);
    stage_merge(&receiver, &base, &reference_path, ORGANIZATION, 2).unwrap();
    assert_eq!(local_context(&receiver), before, "staging must not change live data");
    let mut prefs = load(&receiver).unwrap();
    let received = prefs.received.as_mut().unwrap();
    assert!(received.merge.is_some(), "this witness must use the merged branch");
    let received_path = file_path(&receiver, &received.id).unwrap();
    // Reconstruct persisted transport metadata from a stage created before an
    // upgrade. No installed old executable is used; the bytes and merge are real.
    received.manifest = older_manifest(received.manifest.clone());
    let merge = received.merge.as_mut().unwrap();
    merge.reference_manifest = older_manifest(merge.reference_manifest.clone());
    assert_eq!(merge.reference_id, reference_path.file_stem().unwrap().to_str().unwrap());
    assert_ne!(crate::cloud_backup::file_manifest(&reference_path).unwrap(), merge.reference_manifest,
        "the historical complete reference-Manifest comparison must reject this fixture");
    save(&receiver, &prefs).unwrap();
    Fixture { _directory:directory, receiver,
        local_client:local["id"].as_str().unwrap().into(),
        remote_client:remote_client["id"].as_str().unwrap().into(),
        reference_path, received_path }
}

fn apply_deferred(store: &LocalStore) -> Result<Value, String> {
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    tauri::async_runtime::block_on(apply_company_update(app.state()))
}

fn backup_names(store: &LocalStore) -> Vec<String> {
    let mut files: Vec<_> = fs::read_dir(&store.backups_dir).unwrap().map(|entry| {
        entry.unwrap().file_name().to_string_lossy().into_owned()
    }).collect();
    files.sort();
    files
}

#[derive(Debug, PartialEq)]
struct Snapshot {
    context: (String, String, String, i64),
    workspace: Value,
    preferences: Vec<u8>,
    baseline: Vec<u8>,
    reference: Vec<u8>,
    received: Vec<u8>,
    audit: Vec<Value>,
    audit_validation: Value,
    backups: Vec<String>,
    local_attachment: Vec<u8>,
}
fn snapshot(f: &Fixture) -> Snapshot {
    let db = f.receiver.connect().unwrap();
    Snapshot {
        context:local_context(&f.receiver),
        workspace:f.receiver.get_workspace().unwrap(),
        preferences:fs::read(f.receiver.data_dir.join(STATE)).unwrap(),
        baseline:fs::read(f.receiver.data_dir.join("company-sync-reference.zentra")).unwrap(),
        reference:fs::read(&f.reference_path).unwrap(),
        received:fs::read(&f.received_path).unwrap(),
        audit:query_all(&db, "SELECT rowid,* FROM audit_log ORDER BY rowid", []).unwrap(),
        audit_validation:crate::audit::verify_audit_chain(&db).unwrap(),
        backups:backup_names(&f.receiver),
        local_attachment:fs::read(f.receiver.attachments_dir.join("local-plan.txt")).unwrap(),
    }
}

#[test]
fn real_deferred_older_version_merge_keeps_both_branches_identity_and_original_reference() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f = fixture();
    let before = snapshot(&f);
    let original_metadata = serde_json::to_value(load(&f.receiver).unwrap().received.unwrap()).unwrap();
    let mut archive = zip::ZipArchive::new(File::open(&f.received_path).unwrap()).unwrap();
    let original_archive_manifest: Value = serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
    assert_eq!(original_archive_manifest["app_version"], "1.90.12");
    drop(archive);
    let result = apply_deferred(&f.receiver).unwrap();
    assert_eq!(result["changed"], true);
    let after_context = local_context(&f.receiver);
    assert_eq!(after_context.0, before.context.0);
    assert_eq!(after_context.1, before.context.1);
    let workspace = f.receiver.get_workspace().unwrap();
    let clients = workspace["clients"].as_array().unwrap();
    assert_eq!(clients.len(), 3);
    assert!(clients.iter().any(|client| client["id"] == f.local_client));
    assert!(clients.iter().any(|client| client["id"] == f.remote_client));
    assert_eq!(fs::read(f.receiver.attachments_dir.join("local-plan.txt")).unwrap(), before.local_attachment);
    assert_eq!(fs::read(f.receiver.attachments_dir.join("remote-photo.txt")).unwrap(), b"remote photo retained");
    let prefs = load(&f.receiver).unwrap();
    assert_eq!(prefs.revision, 2);
    assert!(prefs.received.is_none());
    let outgoing = prefs.pending.unwrap();
    assert_eq!(outgoing.base_revision, 2);
    assert_eq!(outgoing.clock, after_context.3);
    require_archive_content(&file_path(&f.receiver, &outgoing.id).unwrap(), &outgoing.manifest,
        "The merged outgoing archive must match its exact pending content.").unwrap();
    assert_eq!(fs::read(f.receiver.data_dir.join("company-sync-reference.zentra")).unwrap(), before.reference);
    assert_eq!(original_metadata["manifest"]["app_version"], "1.90.12");
    assert_eq!(original_metadata["merge"]["reference_manifest"]["app_version"], "1.90.12");
    let db = f.receiver.connect().unwrap();
    assert!(db.query_row("SELECT COUNT(*) FROM audit_log WHERE action='company.merge_branch'", [], |row| row.get::<_, i64>(0)).unwrap() > 0);
    crate::audit::verify_audit_chain(&db).unwrap();
    assert!(backup_names(&f.receiver).len() > before.backups.len());
    assert!(f.receiver.account_protected_cache.operation_lock.try_lock().is_some());
}

#[test]
fn deferred_merge_refuses_corrupt_reference_bytes_or_content_manifest_without_changing_live_state() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for changed in ["reference_bytes", "sha256", "size_bytes", "fragment_sha256"] {
        let f = fixture();
        if changed == "reference_bytes" {
            let mut bytes = fs::read(&f.reference_path).unwrap();
            bytes[0] ^= 1;
            fs::write(&f.reference_path, bytes).unwrap();
        } else {
            let mut prefs = load(&f.receiver).unwrap();
            let merge = prefs.received.as_mut().unwrap().merge.as_mut().unwrap();
            let mut value = serde_json::to_value(&merge.reference_manifest).unwrap();
            match changed {
                "sha256" => value["sha256"] = json!("a".repeat(64)),
                "size_bytes" => {
                    value["size_bytes"] = json!(merge.reference_manifest.size_bytes + 1);
                    let last = value["chunks"].as_array().unwrap().len() - 1;
                    let size = value["chunks"][last]["size_bytes"].as_u64().unwrap();
                    value["chunks"][last]["size_bytes"] = json!(size + 1);
                }
                "fragment_sha256" => value["chunks"][0]["sha256"] = json!("b".repeat(64)),
                _ => unreachable!(),
            }
            merge.reference_manifest = serde_json::from_value(value).unwrap();
            merge.reference_manifest.validate().unwrap();
            save(&f.receiver, &prefs).unwrap();
        }
        let before = snapshot(&f);
        let error = apply_deferred(&f.receiver).unwrap_err();
        assert!(error.contains("La copie de référence reçue a changé"), "changed {changed}: {error}");
        assert_eq!(snapshot(&f), before, "changed {changed}");
        assert!(f.receiver.account_protected_cache.operation_lock.try_lock().is_some());
    }
}

#[test]
fn deferred_merge_keeps_strict_original_reference_format_version_and_fragment_metadata() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for changed in ["format", "version", "app_version_empty", "app_version_long", "fragment_hash_invalid", "size_inconsistent"] {
        let f = fixture();
        let mut prefs = load(&f.receiver).unwrap();
        let merge = prefs.received.as_mut().unwrap().merge.as_mut().unwrap();
        let mut value = serde_json::to_value(&merge.reference_manifest).unwrap();
        match changed {
            "format" => value["format"] = json!("unrecognized-backup-format"),
            "version" => value["version"] = json!(2),
            "app_version_empty" => value["app_version"] = json!(""),
            "app_version_long" => value["app_version"] = json!("x".repeat(61)),
            "fragment_hash_invalid" => value["chunks"][0]["sha256"] = json!("not-a-sha256"),
            "size_inconsistent" => value["size_bytes"] = json!(merge.reference_manifest.size_bytes + 1),
            _ => unreachable!(),
        }
        merge.reference_manifest = serde_json::from_value(value).unwrap();
        assert!(merge.reference_manifest.validate().is_err());
        // The persisted invalid input is deliberate: the real command must
        // reject it without repairing metadata or starting any restoration.
        save(&f.receiver, &prefs).unwrap();
        let before = snapshot(&f);
        assert!(apply_deferred(&f.receiver).is_err(), "changed {changed}");
        assert_eq!(snapshot(&f), before, "changed {changed}");
        assert!(f.receiver.account_protected_cache.operation_lock.try_lock().is_some());
    }
}
