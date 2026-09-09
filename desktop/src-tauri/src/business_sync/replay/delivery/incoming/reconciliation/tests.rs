use super::*;
use crate::business_sync::replay;
use rusqlite::params;
mod installation_tests;

fn stage(
    store: &LocalStore,
    p: &outgoing::Prepared,
    before: &str,
    after: &str,
) -> (PathBuf, Header) {
    stage_from(store, store, p, before, after)
}
fn stage_from(
    store: &LocalStore,
    source: &LocalStore,
    p: &outgoing::Prepared,
    before: &str,
    after: &str,
) -> (PathBuf, Header) {
    let binding = Binding::read(store, "org-replay").unwrap();
    let folder = store
        .data_dir
        .join("business-reception")
        .join(digest(&serde_json::to_vec(&binding).unwrap()))
        .join(&p.manifest.transaction_id);
    for name in ["changes", "positions", "files"] {
        fs::create_dir_all(folder.join(name)).unwrap();
    }
    let manifest = serde_json::to_vec(&p.manifest).unwrap();
    for f in &p.manifest.files {
        let path = crate::business_sync::files::retained_blob_path(
            &source.data_dir,
            &f.sha256,
            f.size_bytes,
        )
        .unwrap();
        fs::copy(path, folder.join("files").join(&f.sha256)).unwrap();
    }
    let mut parts = vec![];
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
    let bundle = json!({"format":"zentra-canonical-transaction-bundle","version":1,"schema_version":60,"contract_sha256":snapshot::contract_hash().unwrap(),
        "organization_id":"org-replay","origin_installation_id":p.manifest.installation_id,"generation":binding.generation,"capture_generation":p.manifest.capture_generation,
        "transaction_id":p.manifest.transaction_id,"source_transfer_id":p.manifest.bootstrap_transfer_id,"source_revision":binding.revision,"original_manifest_sha256":digest(&manifest),
        "review_attempt":Uuid::new_v4().to_string(),"review_validator_sha256":"a".repeat(64),"validation_sha256":"b".repeat(64),"fingerprint_version":2,
        "fingerprint_contract_sha256":fingerprint_contract().unwrap(),"source_state_sha256":before,"target_state_sha256":after,"source_rows":1,"target_rows":2,"parts":parts});
    let receipt = serde_json::to_vec(&replay::delivery::tests::receipt(&bundle)).unwrap();
    let bundle = serde_json::to_vec(&bundle).unwrap();
    let base_revision = binding.revision;
    let header = Header {
        version: 1,
        binding,
        entry: Entry {
            transaction_id: p.manifest.transaction_id.clone(),
            source_revision: base_revision,
            revision: base_revision + 1,
            bundle_sha256: digest(&bundle),
            receipt_sha256: digest(&receipt),
            origin_installation_id: p.manifest.installation_id.clone(),
        },
    };
    for (name, bytes) in [
        ("header.json", serde_json::to_vec(&header).unwrap()),
        ("manifest.json", manifest),
        ("bundle.json", bundle),
        ("receipt.json", receipt),
    ] {
        fs::write(folder.join(name), bytes).unwrap();
    }
    verify_downloaded(&folder, &header).unwrap();
    (folder, header)
}
fn setup() -> (
    tempfile::TempDir,
    LocalStore,
    outgoing::Prepared,
    String,
    String,
) {
    let (root, store, context) = replay::tests::setup_with(|_| {});
    store.connect().unwrap().execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('own','Original','2026-09-09','2026-09-09')",[]).unwrap();
    let after = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
    let p = outgoing::prepare_next(&store, "org-replay", "owner")
        .unwrap()
        .unwrap();
    (root, store, p, context.source_state_sha256, after)
}

#[test]
fn staged_origin_receipt_requires_exact_original_bytes_and_keeps_later_writes() {
    let (_root, store, p, before, after) = setup();
    let (folder, header) = stage(&store, &p, &before, &after);
    store
        .connect()
        .unwrap()
        .execute("UPDATE clients SET name='Later edit' WHERE id='own'", [])
        .unwrap();
    let working = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
    let result = prepare(&store, &folder, &header, "owner", || Ok(())).unwrap();
    assert_eq!(result["state"], "reconciliation_rows_prepared");
    assert_eq!(result["origin_transaction_verified"], true);
    assert_eq!(result["native_guards_validated"], true);
    assert_eq!(result["merged_state_sha256"], working);
    assert_eq!(result["pending_changes"], 2);
    assert_eq!(result["installed"], false);
    assert_eq!(result["acknowledged"], false);
    let c = store.connect().unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM business_sync_receipts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM business_sync_changes", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(replay::state_fingerprint(&c).unwrap(), working);
    assert!(!fs::read_dir(&store.data_dir).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("reconciliation-")));
}

#[test]
fn another_capture_from_same_installation_is_remote_and_is_never_content_deduplicated() {
    let (_root, store, mut p, before, after) = setup();
    p.manifest.capture_generation = Uuid::new_v4().to_string();
    let (folder, header) = stage(&store, &p, &before, &after);
    let result = prepare(&store, &folder, &header, "owner", || Ok(())).unwrap();
    assert_eq!(result["origin_transaction_verified"], false);
    assert_eq!(result["state"], "reconciliation_conflict");
    assert_eq!(result["conflict_count"], 1);
    assert_eq!(result["native_guards_validated"], false);
    assert_eq!(result["acknowledged"], false);
}

#[test]
fn refuses_unrelated_own_manifest_altered_staging_and_session_change() {
    let (_root, store, mut p, before, after) = setup();
    let (folder, header) = stage(&store, &p, &before, &after);
    assert!(prepare(&store, &folder, &header, "viewer", || Ok(())).is_err());
    assert!(prepare(&store, &folder, &header, "owner", || Err(invalid(
        "Session changed"
    )))
    .is_err());
    let bytes = fs::read(folder.join("changes/0000.json")).unwrap();
    fs::write(folder.join("changes/0000.json"), b"{}").unwrap();
    assert!(prepare(&store, &folder, &header, "owner", || Ok(())).is_err());
    fs::write(folder.join("changes/0000.json"), bytes).unwrap();
    p.manifest.transaction_id = Uuid::new_v4().to_string();
    let (other_folder, other_header) = stage(&store, &p, &before, &after);
    let error = prepare(&store, &other_folder, &other_header, "owner", || Ok(()))
        .unwrap_err()
        .to_string();
    assert!(error.contains("manifeste"), "{error}");
    store
        .connect()
        .unwrap()
        .execute(
            "INSERT INTO business_sync_cursor VALUES(1,?1,?2,2)",
            params![header.binding.organization, header.binding.generation],
        )
        .unwrap();
    assert!(prepare(&store, &folder, &header, "owner", || Ok(())).is_err());
    assert_eq!(
        replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
        after
    );
}
