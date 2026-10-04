//! Actual archive cache/reconstruction/application, with no external HTTP.
//! Only missing fragment bytes come from a closed fixture transport. Native CI
//! must execute these witnesses; an older installed binary is not run here.
use super::*;
use std::{cell::RefCell, collections::HashMap};
use tauri::Manager;

const ORGANIZATION: &str = "content-version-compat-company";

fn older_manifest(mut manifest: crate::cloud_backup::Manifest) -> crate::cloud_backup::Manifest {
    let mut value = serde_json::to_value(&manifest).unwrap();
    value["app_version"] = json!("1.90.12");
    manifest = serde_json::from_value(value).unwrap();
    manifest.validate().unwrap();
    manifest
}

struct Fixture {
    _directory: tempfile::TempDir,
    source: LocalStore,
    receiver: LocalStore,
    path: PathBuf,
    manifest: crate::cloud_backup::Manifest,
    parts: Vec<crate::cloud_backup::Chunk>,
    bytes: HashMap<String, Vec<u8>>,
    original: Vec<u8>,
}
fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let source = LocalStore::initialize(directory.path().join("source")).unwrap();
    source.complete_onboarding(crate::tests::test_onboarding(), "1.90.12").unwrap();
    source.create_record("clients", json!({"name":"Synthetic older-version client"})).unwrap();
    // Deterministic, incompressible-enough owned content exercises multiple
    // real transport parts rather than a fabricated list of hashes.
    let mut value = 7u32;
    let attachment: Vec<u8> = (0..1_400_000).map(|_| {
        value = value.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (value >> 24) as u8
    }).collect();
    fs::write(source.attachments_dir.join("synthetic-volume.bin"), attachment).unwrap();
    let archive = directory.path().join("older-producer.zentra");
    source.create_backup_at(&archive, "1.90.12").unwrap();
    let manifest = older_manifest(crate::cloud_backup::file_manifest(&archive).unwrap());
    let source_cache = directory.path().join("source-parts");
    fs::create_dir(&source_cache).unwrap();
    let parts = crate::company_content::prepare(&archive, &source_cache).unwrap();
    assert!(parts.len() > 1);
    let bytes = parts.iter().map(|part| {
        (part.sha256.clone(), crate::company_content::cached(&source_cache, part).unwrap().unwrap())
    }).collect();
    let receiver = LocalStore::initialize(directory.path().join("receiver")).unwrap();
    let path = file_path(&receiver, &uuid::Uuid::new_v4().to_string()).unwrap();
    let original = fs::read(archive).unwrap();
    Fixture { _directory: directory, source, receiver, path, manifest, parts, bytes, original }
}

fn id(f: &Fixture) -> &str {
    f.path.file_stem().unwrap().to_str().unwrap()
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
fn reconstruct(f: &Fixture, manifest: &crate::cloud_backup::Manifest, parts: Vec<crate::cloud_backup::Chunk>, calls: &RefCell<Vec<String>>) -> AppResult<PathBuf> {
    tauri::async_runtime::block_on(download_content_with(&f.receiver, ORGANIZATION,
        &f.path, manifest, parts, |part| {
            calls.borrow_mut().push(part.sha256.clone());
            let bytes = f.bytes[&part.sha256].clone();
            async move { Ok(bytes) }
        }))
}

#[test]
fn actual_download_cache_reuses_identical_older_producer_bytes_without_rewriting_metadata() {
    let f = fixture();
    fs::write(&f.path, &f.original).unwrap();
    let expected = serde_json::to_value(&f.manifest).unwrap();
    assert_ne!(crate::cloud_backup::file_manifest(&f.path).unwrap(), f.manifest,
        "the historical whole-Manifest comparison must fail for this fixture");
    let before = local_context(&f.receiver);
    assert_eq!(cached_download(&f.receiver, id(&f), &f.manifest).unwrap(), Some(f.path.clone()));
    assert_eq!(serde_json::to_value(&f.manifest).unwrap(), expected);
    assert_eq!(fs::read(&f.path).unwrap(), f.original);
    assert_eq!(local_context(&f.receiver), before);
}

#[test]
fn cached_download_still_requires_strict_original_metadata_and_all_content_checks() {
    for changed in ["format", "version", "app_version", "sha256", "size", "fragment"] {
        let f = fixture();
        fs::write(&f.path, &f.original).unwrap();
        let mut value = serde_json::to_value(&f.manifest).unwrap();
        match changed {
            "format" => value["format"] = json!("other-format"),
            "version" => value["version"] = json!(2),
            "app_version" => value["app_version"] = json!(""),
            "sha256" => value["sha256"] = json!("a".repeat(64)),
            "size" => {
                value["size_bytes"] = json!(f.manifest.size_bytes + 1);
                let last = value["chunks"].as_array().unwrap().len() - 1;
                let size = value["chunks"][last]["size_bytes"].as_u64().unwrap();
                value["chunks"][last]["size_bytes"] = json!(size + 1);
            }
            "fragment" => value["chunks"][0]["sha256"] = json!("b".repeat(64)),
            _ => unreachable!(),
        }
        let manifest: crate::cloud_backup::Manifest = serde_json::from_value(value.clone()).unwrap();
        let before = local_context(&f.receiver);
        let result = cached_download(&f.receiver, id(&f), &manifest);
        if ["format", "version", "app_version"].contains(&changed) { assert!(result.is_err()); }
        else { manifest.validate().unwrap(); assert!(result.unwrap().is_none()); }
        assert_eq!(serde_json::to_value(&manifest).unwrap(), value);
        assert_eq!(fs::read(&f.path).unwrap(), f.original);
        assert_eq!(local_context(&f.receiver), before);
    }
}

#[test]
fn cold_reconstruction_verifies_real_parts_and_installs_the_exact_older_archive() {
    let f = fixture();
    let calls = RefCell::new(Vec::new());
    let before = local_context(&f.receiver);
    let metadata = serde_json::to_value(&f.manifest).unwrap();
    assert_eq!(reconstruct(&f, &f.manifest, f.parts.clone(), &calls).unwrap(), f.path);
    let unique: std::collections::HashSet<_> = f.parts.iter().map(|p| p.sha256.clone()).collect();
    assert_eq!(calls.borrow().len(), unique.len());
    assert!(calls.borrow().iter().all(|hash| unique.contains(hash)));
    assert_eq!(fs::read(&f.path).unwrap(), f.original);
    assert_eq!(serde_json::to_value(&f.manifest).unwrap(), metadata);
    assert_eq!(local_context(&f.receiver), before);
    assert_eq!(cached_download(&f.receiver, id(&f), &f.manifest).unwrap(), Some(f.path.clone()));
}

#[test]
fn a_warm_real_content_cache_reconstructs_an_older_archive_without_any_fragment_fetch() {
    let f = fixture();
    let cache = crate::company_content::directory(&f.receiver.data_dir, ORGANIZATION).unwrap();
    for part in &f.parts {
        crate::company_content::put(&cache, part, &f.bytes[&part.sha256]).unwrap();
    }
    let before = local_context(&f.receiver);
    let calls = RefCell::new(Vec::new());
    let path = tauri::async_runtime::block_on(download_content_with(&f.receiver, ORGANIZATION,
        &f.path, &f.manifest, f.parts.clone(), |part| {
            calls.borrow_mut().push(part.sha256);
            async { Err(invalid("A valid cached fragment reached the closed transport.")) }
        })).unwrap();
    assert!(calls.borrow().is_empty());
    assert_eq!(path, f.path);
    assert_eq!(fs::read(path).unwrap(), f.original);
    assert_eq!(local_context(&f.receiver), before);
}

#[test]
fn reconstruction_rejects_corrupt_fragments_and_whole_content_mismatches_before_replacing_an_existing_file() {
    for changed in ["fragment_bytes", "whole_sha256", "fixed_chunk_sha256"] {
        let f = fixture();
        let previous = b"previous test-owned cached download";
        fs::write(&f.path, previous).unwrap();
        let mut value = serde_json::to_value(&f.manifest).unwrap();
        if changed == "whole_sha256" { value["sha256"] = json!("a".repeat(64)); }
        if changed == "fixed_chunk_sha256" { value["chunks"][0]["sha256"] = json!("b".repeat(64)); }
        let manifest: crate::cloud_backup::Manifest = serde_json::from_value(value).unwrap();
        manifest.validate().unwrap();
        let before = local_context(&f.receiver);
        let result = tauri::async_runtime::block_on(download_content_with(&f.receiver, ORGANIZATION,
            &f.path, &manifest, f.parts.clone(), |part| {
                let mut bytes = f.bytes[&part.sha256].clone();
                if changed == "fragment_bytes" { bytes[0] ^= 1; }
                async move { Ok(bytes) }
            }));
        assert!(result.is_err(), "changed {changed}");
        assert_eq!(fs::read(&f.path).unwrap(), previous);
        assert_eq!(local_context(&f.receiver), before);
    }
    let f = fixture();
    let mut value = serde_json::to_value(&f.manifest).unwrap();
    value["version"] = json!(2);
    let invalid = serde_json::from_value(value).unwrap();
    let calls = RefCell::new(Vec::new());
    let before = local_context(&f.receiver);
    assert!(reconstruct(&f, &invalid, f.parts.clone(), &calls).is_err());
    assert!(calls.borrow().is_empty());
    assert!(!f.path.exists());
    assert_eq!(local_context(&f.receiver), before);
}

fn deferred(f: &Fixture) {
    let first = f._directory.path().join("first-company.zentra");
    f.source.create_backup_at(&first, "1.90.12").unwrap();
    apply(&f.receiver, &first, ORGANIZATION, 1, clock(&f.receiver).unwrap(), true, false).unwrap();
    set_identity(&f.receiver, ORGANIZATION, "synthetic-member", "Synthetic Member", "owner").unwrap();
    let now = chrono::Utc::now();
    crate::account_cloud::write_automation_session_for_test(&f.receiver, &json!({
        "version":1, "installation_id":f.receiver.installation_id,
        "session_token":format!("zds_{}", "C".repeat(43)),
        "session_expires_at":(now + chrono::Duration::hours(1)).to_rfc3339(),
        "organization_id":ORGANIZATION, "organization_name":"Synthetic version company",
        "role":"owner", "connected_at":now.to_rfc3339()
    })).unwrap();
    f.source.create_record("clients", json!({"name":"Arrived from the older producer"})).unwrap();
    f.source.create_backup_at(&f.path, "1.90.12").unwrap();
    let manifest = older_manifest(crate::cloud_backup::file_manifest(&f.path).unwrap());
    let mut prefs = load(&f.receiver).unwrap();
    prefs.received = Some(Received { id:id(f).into(), organization:ORGANIZATION.into(),
        revision:2, clock:clock(&f.receiver).unwrap(), manifest, merge:None });
    save(&f.receiver, &prefs).unwrap();
}

#[test]
fn the_real_deferred_company_handler_applies_older_producer_bytes_and_preserves_local_identity_and_scope() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f = fixture();
    deferred(&f);
    let original = fs::read(&f.path).unwrap();
    let before = local_context(&f.receiver);
    let old_received = load(&f.receiver).unwrap().received.unwrap();
    assert_ne!(crate::cloud_backup::file_manifest(&f.path).unwrap(), old_received.manifest);
    let app = tauri::test::mock_builder().manage(f.receiver.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let result = tauri::async_runtime::block_on(apply_company_update(app.state())).unwrap();
    assert_eq!(result["changed"], true);
    let after = local_context(&f.receiver);
    assert_eq!(after.0, before.0);
    assert_eq!(after.1, before.1);
    assert_eq!(f.receiver.get_workspace().unwrap()["clients"].as_array().unwrap().len(), 2);
    let prefs = load(&f.receiver).unwrap();
    assert_eq!(prefs.revision, 2);
    assert!(prefs.received.is_none());
    assert_eq!(fs::read(f.receiver.data_dir.join("company-sync-reference.zentra")).unwrap(), original);
    assert_eq!(serde_json::to_value(&old_received.manifest).unwrap()["app_version"], "1.90.12");
    assert!(f.receiver.account_protected_cache.operation_lock.try_lock().is_some());
}

#[test]
fn the_real_deferred_handler_refuses_invalid_original_metadata_and_content_without_applying_the_archive() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for changed in ["version", "whole_sha256", "fixed_chunk_sha256"] {
        let f = fixture();
        deferred(&f);
        let mut prefs = load(&f.receiver).unwrap();
        let received = prefs.received.as_mut().unwrap();
        let mut value = serde_json::to_value(&received.manifest).unwrap();
        match changed {
            "version" => value["version"] = json!(2),
            "whole_sha256" => value["sha256"] = json!("a".repeat(64)),
            "fixed_chunk_sha256" => value["chunks"][0]["sha256"] = json!("b".repeat(64)),
            _ => unreachable!(),
        }
        received.manifest = serde_json::from_value(value).unwrap();
        save(&f.receiver, &prefs).unwrap();
        let before = local_context(&f.receiver);
        let original = fs::read(&f.path).unwrap();
        let preferences = fs::read(f.receiver.data_dir.join(STATE)).unwrap();
        let reference = fs::read(f.receiver.data_dir.join("company-sync-reference.zentra")).unwrap();
        let app = tauri::test::mock_builder().manage(f.receiver.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        assert!(tauri::async_runtime::block_on(apply_company_update(app.state())).is_err());
        assert_eq!(local_context(&f.receiver), before);
        assert_eq!(fs::read(&f.path).unwrap(), original);
        assert_eq!(fs::read(f.receiver.data_dir.join(STATE)).unwrap(), preferences);
        assert_eq!(fs::read(f.receiver.data_dir.join("company-sync-reference.zentra")).unwrap(), reference);
        assert!(f.receiver.account_protected_cache.operation_lock.try_lock().is_some());
    }
}
