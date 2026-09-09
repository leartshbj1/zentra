use super::*;
use std::{collections::BTreeMap, sync::Mutex};

struct Fake {
    organization: String,
    responses: BTreeMap<String, Vec<u8>>,
    calls: Mutex<Vec<String>>,
    fail: Mutex<Option<String>>,
    current: AtomicBool,
    change_cursor: Mutex<Option<PathBuf>>,
}
impl Transport for Fake {
    fn organization(&self) -> &str {
        &self.organization
    }
    fn ensure_current(&self, _: &LocalStore) -> AppResult<()> {
        if self.current.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(invalid("Session changed"))
        }
    }
    async fn get(&self, q: &[(&str, &str)], limit: u64) -> AppResult<Vec<u8>> {
        let key = key(q);
        self.calls.lock().unwrap().push(key.clone());
        if self.fail.lock().unwrap().as_ref() == Some(&key) {
            return Err(invalid("Offline"));
        }
        if let Some(path) = self.change_cursor.lock().unwrap().take() {
            rusqlite::Connection::open(path)
                .unwrap()
                .execute(
                    "INSERT INTO business_sync_cursor VALUES(1,'org',?1,2)",
                    [ID],
                )
                .unwrap();
        }
        let bytes = self
            .responses
            .get(&key)
            .ok_or_else(|| invalid(&format!("Unknown test resource {key}")))?
            .clone();
        assert!(
            bytes.len() as u64 <= limit,
            "The production caller must bound each expected resource"
        );
        Ok(bytes)
    }
}
const ID: &str = "11111111-1111-4111-8111-111111111111";
fn key(q: &[(&str, &str)]) -> String {
    let resource = q
        .iter()
        .find(|(k, _)| *k == "resource")
        .map(|(_, v)| *v)
        .unwrap_or("discovery");
    let sha = q
        .iter()
        .find(|(k, _)| *k == "sha256")
        .map(|(_, v)| *v)
        .unwrap_or("");
    let part = q
        .iter()
        .find(|(k, _)| *k == "part")
        .map(|(_, v)| *v)
        .unwrap_or("");
    format!("{resource}:{sha}:{part}")
}
fn encode(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}
fn setup(files: Vec<Vec<u8>>) -> (tempfile::TempDir, LocalStore, Fake) {
    let root = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(root.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    let mut c = store.connect().unwrap();
    let tx = c.transaction().unwrap();
    tx.execute(
        "INSERT INTO business_sync_binding VALUES(1,'org',?,?,1,'now')",
        rusqlite::params![store.installation_id, Uuid::new_v4().to_string()],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO business_sync_baseline VALUES(1,'org',?,?,?,'received','now')",
        rusqlite::params![ID, ID, json!({"revision":1}).to_string()],
    )
    .unwrap();
    crate::business_sync::install_capture_triggers(&tx).unwrap();
    tx.commit().unwrap();
    let (mut bundle, manifest, original, positions, _) = super::super::tests::fixture();
    let mut manifest: Value = serde_json::from_slice(&manifest).unwrap();
    let mut original: Value = serde_json::from_slice(&original).unwrap();
    let mut positions: Value = serde_json::from_slice(&positions).unwrap();
    let mut data = BTreeMap::new();
    let files: BTreeMap<_, _> = files
        .into_iter()
        .map(|bytes| (digest(&bytes), bytes))
        .collect();
    manifest["files"] = json!(files
        .iter()
        .map(|(sha, b)| json!({"sha256":sha,"size_bytes":b.len()}))
        .collect::<Vec<_>>());
    original["changes"][0]["files_after"]=json!(files.iter().map(|(sha,b)|json!({"root":"attachments","path":format!("{sha}.bin"),"sha256":sha,"size_bytes":b.len()})).collect::<Vec<_>>());
    for (sha, b) in &files {
        let mut parts = Vec::new();
        for (i, bytes) in b.chunks(FILE_PART_BYTES as usize).enumerate() {
            parts.push(json!({"part_index":i,"sha256":digest(bytes),"size_bytes":bytes.len()}));
            data.insert(format!("file:{sha}:{i}"), bytes.to_vec());
        }
        data.insert(format!("file:{sha}:"),encode(&json!({"format":"zentra-canonical-file","version":1,"transaction_id":ID,"organization_id":"org","generation":ID,"sha256":sha,"size_bytes":b.len(),"part_bytes":FILE_PART_BYTES,"parts":parts})));
    }
    let original = encode(&original);
    positions["source_sha256"] = json!(digest(&original));
    let positions = encode(&positions);
    manifest["chunks"][0]["sha256"] = json!(digest(&original));
    manifest["chunks"][0]["size_bytes"] = json!(original.len());
    manifest["size_bytes"] = json!(original.len());
    let manifest = encode(&manifest);
    bundle["original_manifest_sha256"] = json!(digest(&manifest));
    bundle["parts"][0]["source_sha256"] = json!(digest(&original));
    bundle["parts"][0]["source_bytes"] = json!(original.len());
    bundle["parts"][0]["positions_sha256"] = json!(digest(&positions));
    bundle["parts"][0]["positions_bytes"] = json!(positions.len());
    let receipt = encode(&super::super::tests::receipt(&bundle));
    let discovery = json!({"organization_id":"org","generation":ID,"head_revision":2,"commits":[{"transaction_id":ID,"source_revision":1,"revision":2,"bundle_sha256":digest(&encode(&bundle)),"receipt_sha256":digest(&receipt),"origin_installation_id":ID}],"next_revision":2,"has_more":false});
    data.insert("discovery::".into(), encode(&discovery));
    data.insert("receipt::".into(), receipt);
    data.insert("bundle::".into(), encode(&bundle));
    data.insert("manifest::".into(), manifest);
    data.insert("changes::0".into(), original);
    data.insert("positions::0".into(), positions);
    (
        root,
        store,
        Fake {
            organization: "org".into(),
            responses: data,
            calls: Mutex::new(Vec::new()),
            fail: Mutex::new(None),
            current: AtomicBool::new(true),
            change_cursor: Mutex::new(None),
        },
    )
}

#[test]
#[ignore = "Requires the exact committed D1 fixture; run explicitly with ZENTRA_CANONICAL_DELIVERY_QA"]
fn downloads_actual_d1_revision_then_builds_a_native_candidate() {
    tauri::async_runtime::block_on(async {
        let input = PathBuf::from(std::env::var("ZENTRA_CANONICAL_DELIVERY_QA").unwrap());
        let proof: Value =
            serde_json::from_slice(&fs::read(input.join("proof.json")).unwrap()).unwrap();
        let (_root, store, mut fake) = setup(vec![]);
        let source = rusqlite::Connection::open(input.join("baseline.sqlite")).unwrap();
        let mut target = store.connect().unwrap();
        rusqlite::backup::Backup::new(&source, &mut target)
            .unwrap()
            .run_to_completion(256, std::time::Duration::from_millis(1), None)
            .unwrap();
        let organization = proof["organization_id"].as_str().unwrap();
        let generation = proof["generation"].as_str().unwrap();
        target.execute("UPDATE business_sync_binding SET organization_id=?1,installation_id=?2,generation=?3 WHERE id=1",rusqlite::params![organization,store.installation_id,Uuid::new_v4().to_string()]).unwrap();
        target.execute("UPDATE business_sync_baseline SET organization_id=?1,server_generation=?2 WHERE id=1",rusqlite::params![organization,generation]).unwrap();
        drop(target);
        store.migrate().unwrap();
        fake.organization = organization.into();
        fake.responses.clear();
        for (kind, name) in [
            ("receipt", "commit-receipt.json"),
            ("bundle", "bundle.json"),
            ("manifest", "original-manifest.json"),
        ] {
            fake.responses
                .insert(format!("{kind}::"), fs::read(input.join(name)).unwrap());
        }
        for i in 0..proof["parts"].as_u64().unwrap() {
            for kind in ["changes", "positions"] {
                fake.responses.insert(
                    format!("{kind}::{i}"),
                    fs::read(input.join(format!("{kind}-{i:04}.json"))).unwrap(),
                );
            }
        }
        let receipt: Value = serde_json::from_slice(&fake.responses["receipt::"]).unwrap();
        let entry = json!({"transaction_id":proof["transaction_id"],"source_revision":proof["source_revision"],"revision":proof["revision"],"bundle_sha256":proof["bundle_sha256"],"receipt_sha256":proof["receipt_sha256"],"origin_installation_id":receipt["origin_installation_id"]});
        fake.responses.insert("discovery::".into(),encode(&json!({"organization_id":organization,"generation":generation,"head_revision":2,"commits":[entry.clone()],"next_revision":2,"has_more":false})));
        let before =
            crate::business_sync::replay::state_fingerprint(&store.connect().unwrap()).unwrap();
        let result = finish(&store, &fake).await;
        assert_eq!(result["revision"], 2);
        let binding = Binding::read(&store, organization).unwrap();
        let path = store
            .data_dir
            .join("business-reception")
            .join(digest(&serde_json::to_vec(&binding).unwrap()))
            .join(proof["transaction_id"].as_str().unwrap());
        let header = Header {
            version: 1,
            binding,
            entry: serde_json::from_value(entry).unwrap(),
        };
        let candidate = staged_candidate(&store, &path, &header).unwrap();
        assert_eq!(
            candidate.after_sha256,
            proof["target_state_sha256"].as_str().unwrap()
        );
        let c = rusqlite::Connection::open(candidate.database_path()).unwrap();
        let rowid: String = c
            .query_row(
                "SELECT CAST(rowid AS TEXT) FROM clients WHERE id=?1",
                [proof["client_id"].as_str().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rowid, "9007199254740993");
        assert_eq!(
            crate::business_sync::replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
            before
        );
        store
            .create_record("clients", json!({"name":"Edited during reception"}))
            .unwrap();
        assert!(staged_candidate(&store, &path, &header)
            .err()
            .unwrap()
            .to_string()
            .contains("modifications locales"));
    });
}
fn folder(store: &LocalStore) -> PathBuf {
    store
        .data_dir
        .join("business-reception")
        .join(digest(
            &serde_json::to_vec(&Binding::read(store, "org").unwrap()).unwrap(),
        ))
        .join(ID)
}
async fn finish(store: &LocalStore, fake: &Fake) -> Value {
    for _ in 0..20 {
        let value = receive_pass(store, fake, 1).await.unwrap();
        if value["state"] == "transaction_received" {
            return value;
        }
    }
    panic!("Reception did not make progress");
}
#[test]
fn downloads_original_rows_and_binary_files_resumes_without_replacing_local_work() {
    tauri::async_runtime::block_on(async {
        let files = vec![vec![], vec![73; FILE_PART_BYTES as usize + 19]];
        let (_root, store, fake) = setup(files.clone());
        store
            .create_record("clients", json!({"name":"Created offline"}))
            .unwrap();
        let pending = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM business_sync_changes", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
        let blocked = format!("file:{}:1", digest(&files[1]));
        *fake.fail.lock().unwrap() = Some(blocked.clone());
        let mut interrupted = false;
        for _ in 0..10 {
            if receive_pass(&store, &fake, 1).await.is_err() {
                interrupted = true;
                break;
            }
        }
        assert!(interrupted);
        assert!(!folder(&store).join("received.json").exists());
        let first = format!("file:{}:0", digest(&files[1]));
        assert_eq!(
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|s| **s == first)
                .count(),
            1
        );
        *fake.fail.lock().unwrap() = None;
        // Disk state, not an in-memory transfer, determines the next fragment.
        let restarted = LocalStore::initialize(store.data_dir.clone()).unwrap();
        let result = finish(&restarted, &fake).await;
        assert_eq!(result["installed"], false);
        assert_eq!(result["acknowledged"], false);
        assert_eq!(result["installed_revision"], 1);
        assert_eq!(
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|s| **s == first)
                .count(),
            1
        );
        for bytes in files {
            assert_eq!(
                fs::read(folder(&store).join("files").join(digest(&bytes))).unwrap(),
                bytes
            );
        }
        let c = store.connect().unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM business_sync_changes", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            pending
        );
        assert_eq!(
            c.query_row("SELECT name FROM clients", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "Created offline"
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM business_sync_cursor", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM business_sync_receipts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    });
}
#[test]
fn resumes_the_same_receipt_as_newer_commits_arrive_and_handles_an_empty_history_tail() {
    tauri::async_runtime::block_on(async {
        let (_root, store, mut fake) = setup(vec![]);
        let first = receive_pass(&store, &fake, 1).await.unwrap();
        assert_eq!(first["received_pieces"], 1);
        let mut d: Value = serde_json::from_slice(&fake.responses["discovery::"]).unwrap();
        let mut later = d["commits"][0].clone();
        later["transaction_id"] = json!(Uuid::new_v4().to_string());
        later["source_revision"] = json!(2);
        later["revision"] = json!(3);
        d["commits"].as_array_mut().unwrap().push(later);
        d["head_revision"] = json!(3);
        d["next_revision"] = json!(3);
        fake.responses.insert("discovery::".into(), encode(&d));
        let result = finish(&store, &fake).await;
        assert_eq!(result["head_revision"], 3);
        assert_eq!(result["revision"], 2);
        assert_eq!(result["installed_revision"], 1);
        assert_eq!(
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|s| *s == "changes::0")
                .count(),
            1
        );
        let (_other_root, other, mut no_new) = setup(vec![]);
        no_new.responses.insert("discovery::".into(),encode(&json!({"organization_id":"org","generation":ID,"head_revision":1,"commits":[],"next_revision":1,"has_more":false})));
        assert_eq!(
            receive_pass(&other, &no_new, 8).await.unwrap()["state"],
            "no_new_revision"
        );
        assert!(!other.data_dir.join("business-reception").exists());
    });
}

#[test]
fn rejects_company_or_cursor_changes_during_network_reads() {
    tauri::async_runtime::block_on(async {
        let (_root, store, fake) = setup(vec![]);
        fake.current.store(false, Ordering::Release);
        assert!(receive_pass(&store, &fake, 8).await.is_err());
        assert!(fake.calls.lock().unwrap().is_empty());
        fake.current.store(true, Ordering::Release);
        *fake.change_cursor.lock().unwrap() = Some(store.database_path.clone());
        assert!(receive_pass(&store, &fake, 8)
            .await
            .unwrap_err()
            .to_string()
            .contains("changé"));
        assert!(!store.data_dir.join("business-reception").exists());
    });
}
#[test]
fn discovery_rejects_gaps_wrong_context_and_unsupported_revisions() {
    tauri::async_runtime::block_on(async {
        let (_root, store, mut fake) = setup(vec![]);
        let original: Value = serde_json::from_slice(&fake.responses["discovery::"]).unwrap();
        for mode in [
            "company",
            "generation",
            "head",
            "gap",
            "next",
            "more",
            "duplicate",
        ] {
            let mut value = original.clone();
            match mode {
                "company" => value["organization_id"] = json!("other"),
                "generation" => value["generation"] = json!(Uuid::new_v4().to_string()),
                "head" => value["head_revision"] = json!(SAFE_REVISION + 1),
                "gap" => value["commits"][0]["revision"] = json!(3),
                "next" => value["next_revision"] = json!(1),
                "more" => value["has_more"] = json!(true),
                _ => {
                    value["commits"] =
                        json!([value["commits"][0].clone(), value["commits"][0].clone()])
                }
            }
            fake.responses.insert("discovery::".into(), encode(&value));
            assert!(receive_pass(&store, &fake, 8).await.is_err(), "{mode}");
        }
        assert!(!store.data_dir.join("business-reception").exists());
    });
}
#[test]
fn whole_file_hash_rejects_a_forged_catalogue_even_when_part_hashes_match() {
    tauri::async_runtime::block_on(async {
        let original = vec![1, 2, 3];
        let sha = digest(&original);
        let (_root, store, mut fake) = setup(vec![original]);
        let mut catalogue: Value =
            serde_json::from_slice(&fake.responses[&format!("file:{sha}:")]).unwrap();
        let altered = vec![4, 5, 6];
        catalogue["parts"][0]["sha256"] = json!(digest(&altered));
        fake.responses
            .insert(format!("file:{sha}:"), encode(&catalogue));
        fake.responses.insert(format!("file:{sha}:0"), altered);
        assert!(receive_pass(&store, &fake, 8)
            .await
            .unwrap_err()
            .to_string()
            .contains("empreinte originale"));
        assert!(!folder(&store).join("received.json").exists());
        assert!(!folder(&store).join("files").join(sha).exists());
    });
}
#[test]
fn changed_cached_bytes_or_forged_progress_cannot_confirm_reception() {
    tauri::async_runtime::block_on(async {
        let (_root, store, fake) = setup(vec![vec![7, 8, 9]]);
        receive_pass(&store, &fake, 1).await.unwrap();
        let path = folder(&store);
        write(
            &path.join("progress.json"),
            &serde_json::to_vec(&Progress {
                pieces: 2,
                file: 1,
                part: 0,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(receive_pass(&store, &fake, 8).await.is_err());
        assert!(!path.join("received.json").exists());
        write(
            &path.join("progress.json"),
            &serde_json::to_vec(&Progress::default()).unwrap(),
        )
        .unwrap();
        finish(&store, &fake).await;
        fs::write(path.join("changes/0000.json"), b"{}").unwrap();
        assert!(receive_pass(&store, &fake, 8).await.is_err());
        let header: Header =
            serde_json::from_slice(&read(&path.join("header.json"), 16 * 1024).unwrap()).unwrap();
        assert!(verify_downloaded(&path, &header).is_err());
    });
}
#[test]
fn rejects_catalogue_path_context_and_part_shape_changes() {
    tauri::async_runtime::block_on(async {
        for mode in ["company", "transaction", "size", "part", "hash", "count"] {
            let (_root, store, mut fake) = setup(vec![vec![7]]);
            let sha = digest(&[7]);
            let key = format!("file:{sha}:");
            let mut c: Value = serde_json::from_slice(&fake.responses[&key]).unwrap();
            match mode {
                "company" => c["organization_id"] = json!("other"),
                "transaction" => c["transaction_id"] = json!("../file"),
                "size" => c["size_bytes"] = json!(2),
                "part" => c["parts"][0]["part_index"] = json!(1),
                "hash" => c["parts"][0]["sha256"] = json!("BAD"),
                _ => c["parts"] = json!([]),
            }
            fake.responses.insert(key, encode(&c));
            assert!(receive_pass(&store, &fake, 8).await.is_err(), "{mode}");
            assert!(!folder(&store).join("received.json").exists());
        }
    });
}
