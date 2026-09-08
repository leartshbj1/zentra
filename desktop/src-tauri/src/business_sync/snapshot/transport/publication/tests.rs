use super::*;
use std::sync::{atomic::AtomicUsize, Mutex};

#[test]
#[ignore = "Requires the native source bundle and the exact history response exported by the real server test"]
fn source_accepts_the_actual_server_publication_receipt() {
    let folder = PathBuf::from(std::env::var("ZENTRA_CANONICAL_QA").expect("native source bundle"));
    let response = PathBuf::from(
        std::env::var("ZENTRA_CANONICAL_DOWNLOAD_QA").expect("server response bundle"),
    );
    let descriptor = fs::read(folder.join("prepared.json")).unwrap();
    let prepared: Prepared = serde_json::from_slice(&descriptor).unwrap();
    let bound = BoundSnapshot {
        prepared,
        folder,
        descriptor_sha256: digest(&descriptor),
    };
    let head: Value =
        serde_json::from_slice(&fs::read(response.join("history.json")).unwrap()).unwrap();
    let receipt = &head["receipt"];
    let accepted = super::super::super::incoming::validate_source_receipt(
        &bound.prepared,
        &bound.folder,
        files::manifest_json(&bound).unwrap(),
        receipt["generation"].as_str().unwrap(),
        &serde_json::to_vec(receipt).unwrap(),
    )
    .unwrap();
    assert_eq!(&accepted, receipt);
    assert_eq!(accepted["row_count"], bound.prepared.manifest.row_count);
}

struct Fake {
    receipt: Value,
    current: AtomicBool,
    lose: AtomicBool,
    disconnect: AtomicBool,
    published: AtomicBool,
    calls: Mutex<Vec<String>>,
    publications: AtomicUsize,
    role: String,
    cancelled: Mutex<u16>,
}
fn fixture() -> (tempfile::TempDir, LocalStore, Fake) {
    let (directory, store) = super::super::super::tests::setup();
    let p = store
        .prepare_business_snapshot_mode("org-publish", "owner", true)
        .unwrap();
    let bound = load_prepared(&store, "org-publish").unwrap().unwrap();
    let generation = Uuid::new_v4().to_string();
    let audit = crate::audit::verify_audit_chain(&store.connect().unwrap()).unwrap();
    let receipt = json!({"format":"zentra-shared-history","version":1,"transfer_id":p.transfer_id,"organization_id":p.organization_id,"generation":generation,"revision":1,
        "manifest_sha256":digest(&serde_json::to_vec(&p.manifest).unwrap()),"files_manifest_sha256":digest(files::manifest_json(&bound).unwrap().as_bytes()),
        "validator_sha256":"a".repeat(64),"integrity_validator_sha256":"b".repeat(64),"structural_validator_sha256":"c".repeat(64),
        "row_count":p.manifest.row_count,"file_count":p.files.len(),"audit_entries":audit["entries"],"last_audit_hash":audit["last_hash"],"committed_at":now_iso()});
    save_receipts(
        &store,
        &bound,
        RemoteStatus {
            transfer_id: p.transfer_id,
            organization_id: p.organization_id,
            installation_id: p.installation_id,
            generation,
            state: "uploaded".into(),
            manifest_sha256: receipt["manifest_sha256"].as_str().unwrap().into(),
            uploaded_chunks: p
                .manifest
                .chunks
                .iter()
                .enumerate()
                .map(|(i, c)| Receipt {
                    chunk_index: i,
                    sha256: c.sha256.clone(),
                    size_bytes: c.size_bytes,
                    row_count: c.row_count,
                })
                .collect(),
            replication_active: false,
        },
        None,
    )
    .unwrap();
    (
        directory,
        store,
        Fake {
            receipt,
            current: AtomicBool::new(true),
            lose: AtomicBool::new(false),
            disconnect: AtomicBool::new(false),
            published: AtomicBool::new(false),
            calls: Mutex::new(vec![]),
            publications: AtomicUsize::new(0),
            role: "owner".into(),
            cancelled: Mutex::new(200),
        },
    )
}
impl PublicationTransport for Fake {
    fn organization(&self) -> &str {
        "org-publish"
    }
    fn role(&self) -> &str {
        &self.role
    }
    fn ensure_current(&self, _: &LocalStore) -> AppResult<()> {
        if self.current.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(invalid("Compte changé"))
        }
    }
    async fn call(&self, method: Method, path: &str, id: &str) -> AppResult<(u16, Vec<u8>)> {
        self.calls.lock().unwrap().push(path.into());
        assert_eq!(id, self.receipt["transfer_id"]);
        let mut status = 200;
        let value = if path.ends_with("/publish") {
            self.published.store(true, Ordering::Release);
            self.publications.fetch_add(1, Ordering::AcqRel);
            if self.lose.swap(false, Ordering::AcqRel) {
                return Err(invalid("Réponse perdue"));
            }
            if self.disconnect.swap(false, Ordering::AcqRel) {
                self.current.store(false, Ordering::Release);
            }
            self.receipt.clone()
        } else if path.ends_with("/history") {
            json!({"state":"published","receipt":self.receipt})
        } else if method == Method::DELETE {
            status = if self.published.load(Ordering::Acquire) {
                409
            } else {
                *self.cancelled.lock().unwrap()
            };
            if status == 200 {
                json!({"state":"abandoned","transfer_id":id})
            } else {
                json!({"error":"Annulation non confirmée"})
            }
        } else {
            json!({"state":"valid"})
        };
        Ok((status, serde_json::to_vec(&value)?))
    }
}
fn write(store: &LocalStore) -> AppResult<Value> {
    store.create_record("clients", json!({"name":"Travail après partage"}))
}

#[test]
fn publication_intent_blocks_real_business_writes_and_survives_restart_and_lost_response() {
    tauri::async_runtime::block_on(async {
        let (_root, store, fake) = fixture();
        assert!(write(&store)
            .unwrap_err()
            .to_string()
            .contains("publication"));
        fake.lose.store(true, Ordering::Release);
        assert!(pass(&store, &fake)
            .await
            .unwrap_err()
            .to_string()
            .contains("Réponse perdue"));
        let restarted = LocalStore::initialize(store.data_dir.clone()).unwrap();
        assert!(write(&restarted).is_err());
        assert!(is_committing(&restarted).unwrap());
        assert_eq!(
            pass(&restarted, &fake).await.unwrap()["state"],
            "history_installed"
        );
        assert!(!has_intent(&restarted).unwrap());
        assert_eq!(fake.publications.load(Ordering::Acquire), 2);
        assert_eq!(
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|s| s.ends_with("/structure"))
                .count(),
            1
        );
        write(&restarted).unwrap();
        let c = restarted.connect().unwrap();
        assert_eq!(
            crate::business_sync::status(&c).unwrap()["pending_transactions"],
            1
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM business_sync_receipts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM shared_numbering_binding", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM device_number_ranges", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    });
}
#[test]
fn post_snapshot_edits_require_a_fresh_snapshot_and_are_not_acknowledged_or_deleted() {
    tauri::async_runtime::block_on(async {
        let (_root, store, mut fake) = fixture();
        // Simulate an earlier explicit preparation which did not yet request
        // publication. No shared history exists at this point.
        store
            .connect()
            .unwrap()
            .execute("DELETE FROM business_sync_publication_intent", [])
            .unwrap();
        write(&store).unwrap();
        let old = fake.receipt["transfer_id"].as_str().unwrap().to_owned();
        assert!(store
            .prepare_business_snapshot_mode("org-publish", "owner", true)
            .unwrap_err()
            .to_string()
            .contains("dossier a changé"));
        assert_eq!(
            cancel(&store, &fake).await.unwrap()["state"],
            "not_prepared"
        );
        let p = store
            .prepare_business_snapshot_mode("org-publish", "owner", true)
            .unwrap();
        assert_ne!(p.transfer_id, old);
        assert_eq!(p.manifest.tables["clients"], 1);
        let c = store.connect().unwrap();
        assert!(
            c.query_row(
                "SELECT COUNT(*) FROM business_sync_changes WHERE generation=?",
                [old],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
                > 0
        );
        assert_eq!(
            crate::business_sync::status(&c).unwrap()["pending_transactions"],
            0
        );
        fake.role = "member".into();
        assert!(cancel(&store, &fake).await.is_err());
        assert!(write(&store).is_err());
    });
}
#[test]
fn cancellation_requires_remote_confirmation_and_recovers_a_committed_publication() {
    tauri::async_runtime::block_on(async {
        let (_root, store, fake) = fixture();
        *fake.cancelled.lock().unwrap() = 503;
        assert!(cancel(&store, &fake).await.is_err());
        assert!(write(&store).is_err());
        fake.lose.store(true, Ordering::Release);
        assert!(pass(&store, &fake).await.is_err());
        assert_eq!(
            cancel(&store, &fake).await.unwrap()["state"],
            "history_installed"
        );
        assert!(!has_intent(&store).unwrap());
        assert!(store
            .connect()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM business_sync_baseline)",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
        write(&store).unwrap();
    });
}
#[test]
fn changed_account_and_forged_receipt_do_not_release_the_guard_or_activate_numbers() {
    tauri::async_runtime::block_on(async {
        let (_root, store, mut fake) = fixture();
        fake.disconnect.store(true, Ordering::Release);
        assert!(pass(&store, &fake)
            .await
            .unwrap_err()
            .to_string()
            .contains("Compte changé"));
        fake.current.store(true, Ordering::Release);
        let original = fake.receipt.clone();
        for field in [
            "manifest_sha256",
            "files_manifest_sha256",
            "generation",
            "transfer_id",
            "last_audit_hash",
        ] {
            fake.receipt = original.clone();
            fake.receipt[field] = json!("d".repeat(64));
            let bound = load_prepared(&store, "org-publish").unwrap().unwrap();
            assert!(
                confirmed(
                    &store,
                    &bound,
                    original["generation"].as_str().unwrap(),
                    &serde_json::to_vec(&fake.receipt).unwrap(),
                    || Ok(())
                )
                .is_err(),
                "{field}"
            );
            assert!(write(&store).is_err());
            assert_eq!(
                store
                    .connect()
                    .unwrap()
                    .query_row("SELECT COUNT(*) FROM shared_numbering_binding", [], |r| r
                        .get::<_, i64>(
                        0
                    ))
                    .unwrap(),
                0
            );
        }
        fake.receipt = original;
        assert_eq!(
            pass(&store, &fake).await.unwrap()["state"],
            "history_installed"
        );
    });
}
