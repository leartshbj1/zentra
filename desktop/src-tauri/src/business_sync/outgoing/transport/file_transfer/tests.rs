use super::*;
use std::sync::{atomic::AtomicUsize, Mutex};
struct Fake {
    rows: super::super::tests::Fake,
    manifest: Manifest,
    parts: Mutex<BTreeMap<usize, Vec<u8>>>,
    verified: AtomicBool,
    puts: AtomicUsize,
    lose_part: AtomicBool,
    lose_verify: AtomicBool,
    forge: AtomicBool,
    changed: AtomicBool,
}
impl Fake {
    fn new(manifest: Manifest) -> Self {
        Self {
            rows: super::super::tests::Fake::new(manifest.clone()),
            manifest,
            parts: Mutex::new(BTreeMap::new()),
            verified: AtomicBool::new(false),
            puts: AtomicUsize::new(0),
            lose_part: AtomicBool::new(false),
            lose_verify: AtomicBool::new(false),
            forge: AtomicBool::new(false),
            changed: AtomicBool::new(false),
        }
    }
    fn status(&self) -> Vec<u8> {
        let file = &self.manifest.files[0];
        serde_json::to_vec(&Status {
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
            sha256: file.sha256.clone(),
            size_bytes: file.size_bytes,
            verified: self.verified.load(Ordering::Acquire),
            uploaded_parts: self
                .parts
                .lock()
                .unwrap()
                .iter()
                .map(|(i, b)| FilePart {
                    part_index: *i,
                    sha256: digest(b),
                    size_bytes: b.len() as u64,
                })
                .collect(),
            canonical_committed: false,
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
        if self.changed.load(Ordering::Acquire) {
            return Err(invalid("Compte changé"));
        }
        self.rows.current(store)
    }
    async fn request(
        &self,
        method: Method,
        id: &str,
        index: Option<usize>,
        body: Option<Vec<u8>>,
    ) -> AppResult<(u16, Vec<u8>)> {
        let (code, bytes) = self.rows.request(method, id, index, body).await?;
        if code != 200 {
            return Ok((code, bytes));
        }
        let mut v: Value = serde_json::from_slice(&bytes)?;
        let pending = !self.verified.load(Ordering::Acquire);
        v["files_pending"] = json!(usize::from(pending));
        v["pending_files"] = if pending {
            json!(self.manifest.files)
        } else {
            json!([])
        };
        if v["state"] == "awaiting_validation" && pending {
            v["state"] = json!("awaiting_files");
        }
        Ok((code, serde_json::to_vec(&v)?))
    }
    async fn file_request(&self, r: FileRequest) -> AppResult<(u16, Vec<u8>)> {
        assert_eq!(r.id, self.manifest.transaction_id);
        assert_eq!(r.sha, self.manifest.files[0].sha256);
        if r.method == Method::PUT {
            let i = r.index.unwrap();
            let body = r.body.unwrap();
            assert_eq!(r.hash.unwrap(), digest(&body));
            self.puts.fetch_add(1, Ordering::AcqRel);
            self.parts.lock().unwrap().insert(i, body);
            if self.lose_part.swap(false, Ordering::AcqRel) {
                return Err(invalid("Réponse perdue après stockage du document"));
            }
        }
        if r.method == Method::POST {
            let bytes = self
                .parts
                .lock()
                .unwrap()
                .values()
                .flatten()
                .copied()
                .collect::<Vec<_>>();
            assert_eq!(digest(&bytes), r.sha);
            self.verified.store(true, Ordering::Release);
            if self.lose_verify.swap(false, Ordering::AcqRel) {
                return Err(invalid("Réponse de vérification perdue"));
            }
        }
        Ok((200, self.status()))
    }
}
fn fixture(size: usize) -> (tempfile::TempDir, LocalStore, Fake) {
    let (dir, store) = super::super::super::tests::setup();
    super::super::super::tests::bind(&store);
    let bytes = vec![37; size];
    fs::write(store.attachments_dir.join("plan.txt"), &bytes).unwrap();
    let c = store.connect().unwrap();
    c.execute_batch("BEGIN").unwrap();
    c.execute("INSERT INTO attachments(id,original_name,stored_name,size_bytes,sha256,created_at,updated_at) VALUES('doc','plan.txt','plan.txt',?,?,'x','x')",params![size as i64,digest(&bytes)]).unwrap();
    c.execute("DELETE FROM attachments WHERE id='doc'", [])
        .unwrap();
    c.execute_batch("COMMIT").unwrap();
    fs::remove_file(store.attachments_dir.join("plan.txt")).unwrap();
    let p = super::super::super::tests::next(&store);
    let fake = Fake::new(p.manifest);
    (dir, store, fake)
}
fn next(store: &LocalStore) -> Prepared {
    super::super::super::tests::next(store)
}
fn pending(store: &LocalStore) {
    assert_eq!(
        crate::business_sync::status(&store.connect().unwrap()).unwrap()["pending_transactions"],
        1
    );
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM business_sync_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM business_sync_cursor", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn a_deleted_document_resumes_lost_part_and_verification_responses_after_restart() {
    tauri::async_runtime::block_on(async {
        let (_dir, store, fake) = fixture(PART_BYTES as usize + 19);
        fake.lose_part.store(true, Ordering::Release);
        assert!(transfer(&store, &fake, next(&store)).await.is_err());
        assert_eq!(fake.puts.load(Ordering::Acquire), 1);
        pending(&store);
        let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
        fake.lose_verify.store(true, Ordering::Release);
        assert!(transfer(&reopened, &fake, next(&reopened)).await.is_err());
        assert_eq!(fake.puts.load(Ordering::Acquire), 2);
        pending(&reopened);
        let result = transfer(&reopened, &fake, next(&reopened)).await.unwrap();
        assert_eq!(result["files_pending"], 0);
        assert_eq!(result["state"], "awaiting_validation");
        assert_eq!(fake.puts.load(Ordering::Acquire), 2);
        pending(&reopened);
    });
}
#[test]
fn large_documents_obey_the_shared_pass_budget_and_empty_documents_have_no_phantom_part() {
    tauri::async_runtime::block_on(async {
        let (_dir, store, fake) = fixture(9 * PART_BYTES as usize + 1);
        let first = transfer(&store, &fake, next(&store)).await.unwrap();
        assert_eq!(first["sent_file_parts"], 7);
        assert_eq!(first["files_pending"], 1);
        let last = transfer(&store, &fake, next(&store)).await.unwrap();
        assert_eq!(last["sent_file_parts"], 3);
        assert_eq!(last["files_pending"], 0);
        pending(&store);
        let (_dir, empty, fake) = fixture(0);
        let result = transfer(&empty, &fake, next(&empty)).await.unwrap();
        assert_eq!(result["files_pending"], 0);
        assert_eq!(fake.puts.load(Ordering::Acquire), 0);
        pending(&empty);
    });
}
#[test]
fn forged_receipts_and_changed_local_bytes_do_not_confirm_documents_or_business_work() {
    tauri::async_runtime::block_on(async {
        let (_dir, store, fake) = fixture(37);
        fake.forge.store(true, Ordering::Release);
        assert!(transfer(&store, &fake, next(&store)).await.is_err());
        assert_eq!(fake.puts.load(Ordering::Acquire), 0);
        pending(&store);
        fake.forge.store(false, Ordering::Release);
        let prepared = next(&store);
        let path = crate::business_sync::files::retained_blob_path(
            &store.data_dir,
            &fake.manifest.files[0].sha256,
            37,
        )
        .unwrap();
        fs::write(path, vec![99; 37]).unwrap();
        assert!(transfer(&store, &fake, prepared).await.is_err());
        assert_eq!(fake.puts.load(Ordering::Acquire), 0);
        pending(&store);
    });
}
