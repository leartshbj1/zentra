use super::*;
use crate::business_sync::outgoing::tests::{bind, client, next, setup};
use std::sync::{atomic::AtomicUsize, Mutex};

struct Server {
    upload: super::super::tests::Fake,
    manifest: Manifest,
    review_remaining: AtomicUsize,
    calls: Mutex<Vec<(String, Value)>>,
    committed: AtomicBool,
    lose_commit: AtomicBool,
    lose_stage: Mutex<Option<&'static str>>,
    current: AtomicBool,
    detach_after_request: AtomicBool,
    deny_commit: AtomicBool,
    stop: Mutex<Option<&'static str>>,
    change: Mutex<Option<(&'static str, &'static str, Value)>>,
    attempt: String,
}
impl Server {
    fn new(manifest: Manifest) -> Self {
        Self {
            upload: super::super::tests::Fake::new(manifest.clone()),
            manifest,
            review_remaining: AtomicUsize::new(0),
            calls: Mutex::new(vec![]),
            committed: AtomicBool::new(false),
            lose_commit: AtomicBool::new(false),
            lose_stage: Mutex::new(None),
            current: AtomicBool::new(true),
            detach_after_request: AtomicBool::new(false),
            deny_commit: AtomicBool::new(false),
            stop: Mutex::new(None),
            change: Mutex::new(None),
            attempt: Uuid::new_v4().to_string(),
        }
    }
    fn receipt(&self) -> Value {
        json!({"format":"zentra-canonical-transaction-receipt","version":1,
            "transaction_id":self.manifest.transaction_id,"organization_id":self.manifest.organization_id,
            "generation":self.manifest.generation,"origin_installation_id":self.manifest.installation_id,
            "capture_generation":self.manifest.capture_generation,"source_transfer_id":self.manifest.bootstrap_transfer_id,
            "source_revision":1,"revision":2,"manifest_sha256":digest(&serde_json::to_vec(&self.manifest).unwrap()),
            "bundle_sha256":"b".repeat(64),"fingerprint_version":2,"fingerprint_contract_sha256":fingerprint_contract().unwrap(),
            "source_state_sha256":"c".repeat(64),"target_state_sha256":"d".repeat(64),
            "validation_sha256":"e".repeat(64),"committed_at":"2026-09-09T12:00:00.000Z"})
    }
    fn base(&self) -> Value {
        json!({"transaction_id":self.manifest.transaction_id,"organization_id":self.manifest.organization_id,
            "installation_id":self.manifest.installation_id,"generation":self.manifest.generation,
            "manifest_sha256":digest(&serde_json::to_vec(&self.manifest).unwrap()),"attempt":self.attempt,
            "source_revision":1,"canonical_committed":false,"replication_active":false})
    }
}
impl Transport for Server {
    fn organization(&self) -> &str {
        &self.manifest.organization_id
    }
    fn role(&self) -> &str {
        "owner"
    }
    fn current(&self, _: &LocalStore) -> AppResult<()> {
        require(self.current.load(Ordering::Acquire))
    }
    async fn request(
        &self,
        method: Method,
        id: &str,
        index: Option<usize>,
        body: Option<Vec<u8>>,
    ) -> AppResult<(u16, Vec<u8>)> {
        let (code, bytes) = self.upload.request(method, id, index, body).await?;
        if self.committed.load(Ordering::Acquire) {
            let mut value: Value = serde_json::from_slice(&bytes)?;
            value["state"] = json!("committed");
            value["canonical_committed"] = json!(true);
            value["receipt"] = self.receipt();
            if let Some(("receipt", key, val)) = &*self.change.lock().unwrap() {
                value["receipt"][key] = val.clone();
            }
            return Ok((code, serde_json::to_vec(&value)?));
        }
        Ok((code, bytes))
    }
    async fn lifecycle_request(
        &self,
        path: &'static str,
        id: &str,
        body: Option<Vec<u8>>,
    ) -> AppResult<(u16, Vec<u8>)> {
        assert_eq!(id, self.manifest.transaction_id);
        let body: Value = body
            .map(|v| serde_json::from_slice(&v).unwrap())
            .unwrap_or(Value::Null);
        self.calls
            .lock()
            .unwrap()
            .push((path.to_owned(), body.clone()));
        let mut value = self.base();
        if path == Stage::Review.path() {
            assert!(body == json!({"action":"prepare"}) || body == json!({"action":"advance"}));
            if body["action"] == "advance" {
                let _ =
                    self.review_remaining
                        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1));
            }
            let remaining = self.review_remaining.load(Ordering::Acquire);
            value["state"] = json!(self.stop.lock().unwrap().unwrap_or(if remaining > 0 {
                "copying"
            } else {
                "projected"
            }));
            value["algorithm_version"] = json!(3);
            value["validator_sha256"] = json!("a".repeat(64));
            value["financial_validated"] = json!(false);
            value["copied_rows"] = json!(100 - remaining);
            value["applied_changes"] = json!(if remaining == 0 {
                self.manifest.change_count
            } else {
                0
            });
            value["next_chunk"] = json!(if remaining == 0 {
                self.manifest.chunks.len()
            } else {
                0
            });
            value["audit_entries"] = json!(0);
            value["failed_rule"] = Value::Null;
            value["conflicts"] = json!([]);
        } else if path == Stage::Validation.path() {
            assert!(body.is_null());
            value["phase"] = json!("valid");
            value["algorithm_version"] = json!(9);
            value["validator_sha256"] = json!("e".repeat(64));
            for key in [
                "checked_structural_rules",
                "total_structural_rules",
                "checked_accounting_rules",
                "total_accounting_rules",
            ] {
                value[key] = json!(7);
            }
            for key in ["checked_changes", "total_changes"] {
                value[key] = json!(self.manifest.change_count);
            }
            value["failed_rule"] = Value::Null;
            value["failed_change"] = Value::Null;
            value["credit_projection"] = json!({"phase":"valid"});
            value["snapshot_validated"] = json!(true);
            value["business_validated"] = json!(false);
        } else if path == Stage::Fingerprint.path() {
            assert!(body.is_null());
            value["phase"] = json!("complete");
            value["validation_sha256"] = json!("e".repeat(64));
            value["fingerprint_version"] = json!(2);
            value["fingerprint_contract_sha256"] = json!(fingerprint_contract()?);
            value["source_transfer_id"] = json!(self.manifest.bootstrap_transfer_id);
            value["source_state_sha256"] = json!("c".repeat(64));
            value["target_state_sha256"] = json!("d".repeat(64));
            for key in ["checked_rows", "source_rows", "target_rows"] {
                value[key] = json!(12);
            }
            value["checked_bytes"] = json!(1024);
            value["fingerprint_complete"] = json!(true);
            value["business_validated"] = json!(false);
        } else if path == Stage::Delivery.path() {
            assert!(body.is_null());
            value["state"] = json!("prepared");
            value["prepared_parts"] = json!(self.manifest.chunks.len());
            value["total_parts"] = json!(self.manifest.chunks.len());
            value["bundle_sha256"] = json!("b".repeat(64));
        } else {
            assert_eq!(path, Stage::Commit.path());
            assert!(body.is_null());
            if self.deny_commit.load(Ordering::Acquire) {
                return Ok((409, br#"{"error":"La revision a change"}"#.to_vec()));
            }
            self.committed.store(true, Ordering::Release);
            if self.lose_commit.swap(false, Ordering::AcqRel) {
                return Err(invalid("Réponse perdue après commit"));
            }
            value = json!({"receipt":self.receipt(),"canonical_committed":true,"replication_active":false});
        }
        if self.detach_after_request.load(Ordering::Acquire) {
            self.current.store(false, Ordering::Release);
        }
        if let Some((target, key, val)) = &*self.change.lock().unwrap() {
            if *target == path {
                value[key] = val.clone();
            }
        }
        let mut lost = self.lose_stage.lock().unwrap();
        if *lost == Some(path) {
            *lost = None;
            return Err(invalid("Réponse perdue après progression du contrôle"));
        }
        Ok((200, serde_json::to_vec(&value)?))
    }
}
fn fixture() -> (tempfile::TempDir, LocalStore, Prepared, Server) {
    let (dir, store) = setup();
    bind(&store);
    client(&store.connect().unwrap(), "first", "Écrit avant l’envoi");
    let p = next(&store);
    let server = Server::new(p.manifest.clone());
    (dir, store, p, server)
}
fn originals(store: &LocalStore) -> Vec<String> {
    store.connect().unwrap().prepare("SELECT json_array(sequence,transaction_id,before_json,after_json) FROM business_sync_changes ORDER BY sequence").unwrap()
        .query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
}
fn unchanged(store: &LocalStore, original: &[String]) {
    assert_eq!(originals(store), original);
    let c = store.connect().unwrap();
    for table in [
        "business_sync_receipts",
        "business_sync_cursor",
        "business_sync_installed_revisions",
    ] {
        assert_eq!(
            c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "No local acknowledgement or canonical installation from transport alone"
        );
    }
}
#[test]
fn commit_response_loss_is_discovered_after_restart_without_consuming_later_offline_edits() {
    tauri::async_runtime::block_on(async {
        let (_dir, store, p, server) = fixture();
        client(
            &store.connect().unwrap(),
            "later",
            "Créé pendant l’envoi\nÀ conserver",
        );
        let original = originals(&store);
        server.lose_commit.store(true, Ordering::Release);
        assert!(synchronize(&store, &server, &p).await.is_err());
        unchanged(&store, &original);
        let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
        let result = synchronize(&reopened, &server, &next(&reopened))
            .await
            .unwrap();
        assert_eq!(result["state"], "committed");
        assert_eq!(result["acknowledged"], false);
        assert_eq!(result["canonical_committed"], true);
        assert_eq!(result["replication_active"], false);
        assert_eq!(
            server
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(path, _)| path == Stage::Commit.path())
                .count(),
            1
        );
        unchanged(&reopened, &original);
    });
}
#[test]
fn review_resumes_in_bounded_passes_and_only_commits_after_all_proofs() {
    tauri::async_runtime::block_on(async {
        let (_dir, store, p, server) = fixture();
        server.review_remaining.store(12, Ordering::Release);
        let original = originals(&store);
        for pass in 0..4 {
            let before = server.calls.lock().unwrap().len();
            let result = synchronize(&store, &server, &p).await.unwrap();
            let count = server.calls.lock().unwrap().len() - before;
            assert!(count <= if pass == 0 { 7 } else { 8 });
            unchanged(&store, &original);
            if result["canonical_committed"] == true {
                return;
            }
        }
        panic!("The server lifecycle did not resume to a commit");
    });
}
#[test]
fn lost_intermediate_responses_resume_from_the_same_server_attempt() {
    tauri::async_runtime::block_on(async {
        for stage in [
            Stage::Review,
            Stage::Validation,
            Stage::Fingerprint,
            Stage::Delivery,
        ] {
            let (_dir, store, p, server) = fixture();
            *server.lose_stage.lock().unwrap() = Some(stage.path());
            let original = originals(&store);
            assert!(synchronize(&store, &server, &p).await.is_err());
            unchanged(&store, &original);
            let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
            let result = synchronize(&reopened, &server, &next(&reopened))
                .await
                .unwrap();
            assert_eq!(result["canonical_committed"], true);
            assert_eq!(
                server
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(path, _)| path == Stage::Commit.path())
                    .count(),
                1
            );
            unchanged(&reopened, &original);
        }
    });
}
#[test]
fn invalid_conflicted_stale_or_changed_accounts_stop_before_further_server_mutations() {
    tauri::async_runtime::block_on(async {
        for state in ["conflict", "invalid", "stale"] {
            let (_dir, store, p, server) = fixture();
            *server.stop.lock().unwrap() = Some(state);
            let original = originals(&store);
            let result = synchronize(&store, &server, &p).await.unwrap();
            assert_eq!(result["state"], state);
            assert_eq!(server.calls.lock().unwrap().len(), 1);
            unchanged(&store, &original);
        }
        let (_dir, store, p, server) = fixture();
        server.detach_after_request.store(true, Ordering::Release);
        let original = originals(&store);
        assert!(synchronize(&store, &server, &p).await.is_err());
        assert_eq!(server.calls.lock().unwrap().len(), 1);
        unchanged(&store, &original);
    });
}
#[test]
fn inconsistent_stage_bindings_and_commit_conflicts_cannot_be_reported_as_committed() {
    tauri::async_runtime::block_on(async {
        for (path, key, value) in [
            (
                Stage::Review.path(),
                "generation",
                json!(Uuid::new_v4().to_string()),
            ),
            (
                Stage::Validation.path(),
                "attempt",
                json!(Uuid::new_v4().to_string()),
            ),
            (Stage::Validation.path(), "checked_changes", json!(0)),
            (
                Stage::Fingerprint.path(),
                "validation_sha256",
                json!("1".repeat(64)),
            ),
            (
                Stage::Fingerprint.path(),
                "fingerprint_contract_sha256",
                json!("2".repeat(64)),
            ),
            (
                Stage::Delivery.path(),
                "bundle_sha256",
                json!("3".repeat(64)),
            ),
        ] {
            let (_dir, store, p, server) = fixture();
            *server.change.lock().unwrap() = Some((path, key, value));
            let original = originals(&store);
            assert!(
                synchronize(&store, &server, &p).await.is_err(),
                "{path}:{key}"
            );
            unchanged(&store, &original);
        }
        let (_dir, store, p, server) = fixture();
        server.deny_commit.store(true, Ordering::Release);
        let original = originals(&store);
        assert!(synchronize(&store, &server, &p).await.is_err());
        unchanged(&store, &original);
    });
}
#[test]
fn rediscovered_commit_must_match_original_manifest_capture_device_and_native_contract() {
    tauri::async_runtime::block_on(async {
        let (_dir, store, p, server) = fixture();
        synchronize(&store, &server, &p).await.unwrap();
        let original = originals(&store);
        for (key, val) in [
            ("manifest_sha256", json!("1".repeat(64))),
            ("origin_installation_id", json!(Uuid::new_v4().to_string())),
            ("capture_generation", json!(Uuid::new_v4().to_string())),
            ("source_transfer_id", json!(Uuid::new_v4().to_string())),
            ("fingerprint_contract_sha256", json!("2".repeat(64))),
            ("revision", json!(3)),
        ] {
            *server.change.lock().unwrap() = Some(("receipt", key, val));
            assert!(synchronize(&store, &server, &p).await.is_err(), "{key}");
            unchanged(&store, &original);
        }
    });
}
#[test]
#[ignore = "Requires the exact D1-produced fixture; run with ZENTRA_CANONICAL_DELIVERY_QA"]
fn actual_d1_commit_receipt_is_accepted_for_its_exact_originating_manifest() {
    let root = PathBuf::from(std::env::var("ZENTRA_CANONICAL_DELIVERY_QA").unwrap());
    let raw = fs::read(root.join("original-manifest.json")).unwrap();
    let manifest: Manifest = serde_json::from_slice(&raw).unwrap();
    let receipt = fs::read(root.join("commit-receipt.json")).unwrap();
    let verified = verify_outgoing_receipt(&receipt, &manifest, &digest(&raw)).unwrap();
    assert_eq!(verified["origin_installation_id"], manifest.installation_id);
    assert_eq!(verified["revision"], 2);
    // Exercise the exact envelopes returned by the real local D1 route code,
    // including native guard totals, credit projection and canonical hashes.
    let responses: Vec<Value> =
        serde_json::from_slice(&fs::read(root.join("lifecycle-responses.json")).unwrap()).unwrap();
    assert_eq!(responses.len(), 5);
    let p = Prepared {
        manifest,
        folder: root,
    };
    assert_eq!(
        digest(&serde_json::to_vec(&p.manifest).unwrap()),
        digest(&raw)
    );
    let mut proofs = Proofs::default();
    let mut stage = Stage::Review;
    for response in &responses[..4] {
        assert_eq!(
            format!(
                "/api/sync/transactions/{}",
                response["stage"].as_str().unwrap()
            ),
            stage.path()
        );
        let (next, stopped) = proofs
            .check(stage, &response["response"], &p, &digest(&raw))
            .unwrap();
        assert!(!stopped);
        stage = next;
    }
    assert_eq!(stage, Stage::Commit);
    assert_eq!(
        proofs
            .commit(&responses[4]["response"], &p, &digest(&raw))
            .unwrap(),
        verified
    );
}
