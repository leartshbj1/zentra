use super::*;
use std::sync::{atomic::AtomicUsize, Mutex};
pub(super) struct Fake {
    manifest: Manifest,
    exists: AtomicBool,
    received: Mutex<Vec<usize>>,
    puts: AtomicUsize,
    lose: AtomicBool,
    current: AtomicBool,
    forge: AtomicBool,
    detach: AtomicBool,
}
impl Fake {
    pub(super) fn new(manifest: Manifest) -> Self {
        Self {
            manifest,
            exists: AtomicBool::new(false),
            received: Mutex::new(vec![]),
            puts: AtomicUsize::new(0),
            lose: AtomicBool::new(false),
            current: AtomicBool::new(true),
            forge: AtomicBool::new(false),
            detach: AtomicBool::new(false),
        }
    }
    fn receipt(&self) -> Vec<u8> {
        let indices = self.received.lock().unwrap();
        serde_json::to_vec(&Receipt {
            transaction_id: self.manifest.transaction_id.clone(),
            organization_id: self.manifest.organization_id.clone(),
            installation_id: self.manifest.installation_id.clone(),
            generation: if self.forge.load(Ordering::Acquire) {
                Uuid::new_v4().to_string()
            } else {
                self.manifest.generation.clone()
            },
            capture_generation: self.manifest.capture_generation.clone(),
            manifest_sha256: digest(&serde_json::to_vec(&self.manifest).unwrap()),
            state: if indices.len() == self.manifest.chunks.len() {
                "awaiting_validation"
            } else {
                "receiving"
            }
            .into(),
            received_chunks: indices
                .iter()
                .map(|i| {
                    let c = &self.manifest.chunks[*i];
                    Part {
                        chunk_index: *i,
                        sha256: c.sha256.clone(),
                        size_bytes: c.size_bytes,
                        change_count: c.change_count,
                    }
                })
                .collect(),
            files_pending: 0,
            pending_files: vec![],
            canonical_committed: false,
            committed_receipt: None,
            replication_active: false,
        })
        .unwrap()
    }
}
impl Transport for Fake {
    fn organization(&self) -> &str {
        &self.manifest.organization_id
    }
    fn role(&self) -> &str {
        "member"
    }
    fn current(&self, store: &LocalStore) -> AppResult<()> {
        if self.detach.swap(false, Ordering::AcqRel) {
            crate::business_sync::detach_restored_copy(&store.connect()?)?;
        }
        if self.current.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(invalid("Compte changé"))
        }
    }
    async fn request(
        &self,
        method: Method,
        id: &str,
        index: Option<usize>,
        body: Option<Vec<u8>>,
    ) -> AppResult<(u16, Vec<u8>)> {
        assert_eq!(id, self.manifest.transaction_id);
        if method == Method::GET && !self.exists.load(Ordering::Acquire) {
            return Ok((404, b"{}".to_vec()));
        }
        if method == Method::POST {
            let value: Value = serde_json::from_slice(body.as_deref().unwrap()).unwrap();
            assert_eq!(
                value["manifest_json"],
                serde_json::to_string(&self.manifest).unwrap()
            );
            self.exists.store(true, Ordering::Release);
        }
        if method == Method::PUT {
            let i = index.unwrap();
            assert_eq!(
                digest(body.as_deref().unwrap()),
                self.manifest.chunks[i].sha256
            );
            self.puts.fetch_add(1, Ordering::AcqRel);
            let mut parts = self.received.lock().unwrap();
            if !parts.contains(&i) {
                parts.push(i);
            }
            drop(parts);
            if self.lose.swap(false, Ordering::AcqRel) {
                return Err(invalid("Réponse perdue après stockage"));
            }
        }
        Ok((200, self.receipt()))
    }
}
fn fixture() -> (tempfile::TempDir, LocalStore, Fake) {
    let (dir, store) = super::super::tests::setup();
    super::super::tests::bind(&store);
    let c = store.connect().unwrap();
    c.execute_batch("BEGIN").unwrap();
    for i in 0..601 {
        super::super::tests::client(&c, &format!("client-{i}"), "Notes\nConservées");
    }
    c.execute_batch("COMMIT").unwrap();
    let p = super::super::tests::next(&store);
    let fake = Fake::new(p.manifest);
    (dir, store, fake)
}
#[test]
fn lost_chunk_response_resumes_without_consuming_any_local_transaction() {
    tauri::async_runtime::block_on(async {
        let (_dir, store, fake) = fixture();
        fake.lose.store(true, Ordering::Release);
        assert!(transfer(&store, &fake, &super::super::tests::next(&store))
            .await
            .is_err());
        assert_eq!(fake.puts.load(Ordering::Acquire), 1);
        let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
        let result = transfer(&reopened, &fake, &super::super::tests::next(&reopened))
            .await
            .unwrap();
        assert_eq!(result["state"], "awaiting_validation");
        assert_eq!(fake.puts.load(Ordering::Acquire), 4);
        assert_eq!(
            crate::business_sync::status(&reopened.connect().unwrap()).unwrap()
                ["pending_transactions"],
            1
        );
        assert_eq!(
            reopened
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM business_sync_receipts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            reopened
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM business_sync_cursor", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    });
}
#[test]
fn forged_receipts_and_restoration_do_not_upload_more_or_mark_work_applied() {
    tauri::async_runtime::block_on(async {
        let (_dir, store, fake) = fixture();
        fake.exists.store(true, Ordering::Release);
        fake.forge.store(true, Ordering::Release);
        assert!(transfer(&store, &fake, &super::super::tests::next(&store))
            .await
            .is_err());
        assert_eq!(fake.puts.load(Ordering::Acquire), 0);
        fake.forge.store(false, Ordering::Release);
        let p = super::super::tests::next(&store);
        fake.detach.store(true, Ordering::Release);
        assert!(transfer(&store, &fake, &p).await.is_err());
        assert_eq!(fake.puts.load(Ordering::Acquire), 0);
        assert_eq!(
            crate::business_sync::status(&store.connect().unwrap()).unwrap()
                ["pending_transactions"],
            1
        );
    });
}
