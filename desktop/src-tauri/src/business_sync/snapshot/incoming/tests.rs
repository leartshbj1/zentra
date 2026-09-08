use super::*;
use std::sync::Mutex;

struct Fake {
    head: Head,
    rows: Vec<Vec<u8>>,
    pages: Vec<Vec<u8>>,
    files: BTreeMap<String, Vec<u8>>,
    current: AtomicBool,
    calls: Mutex<Vec<String>>,
    fail_at: Mutex<Option<usize>>,
    disconnect: AtomicBool,
}
impl Fake {
    fn from_snapshot(store: &LocalStore) -> Self {
        let p = store
            .prepare_business_snapshot("org-receive", "owner")
            .unwrap();
        let folder = store.snapshot_folder(&p.transfer_id).unwrap();
        let rows = p
            .manifest
            .chunks
            .iter()
            .enumerate()
            .map(|(i, _)| fs::read(folder.join("rows").join(format!("{i:04}.json"))).unwrap())
            .collect();
        let pages = p
            .files
            .chunks(200)
            .map(|files| serde_json::to_vec(&json!({"version":2,"files":files})).unwrap())
            .collect::<Vec<_>>();
        let files_manifest_json=serde_json::to_string(&json!({"format":"zentra-business-files","version":2,
            "pages":pages.iter().enumerate().map(|(i,b)|json!({"sha256":digest(b),"size_bytes":b.len(),"file_count":p.files.iter().skip(i*200).take(200).count()})).collect::<Vec<_>>(),
            "file_count":p.files.len(),"size_bytes":p.files.iter().map(|f|f.size_bytes).sum::<u64>()})).unwrap();
        let manifest_json = serde_json::to_string(&p.manifest).unwrap();
        let audit_entries = p.manifest.tables["audit_log"];
        let last_audit_hash = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT entry_hash FROM audit_log ORDER BY rowid DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        let head = Head {
            state: "published".into(),
            head_revision: 1,
            receipt: PublicationReceipt {
                format: "zentra-shared-history".into(),
                version: 1,
                transfer_id: p.transfer_id,
                organization_id: p.organization_id,
                generation: Uuid::new_v4().to_string(),
                revision: 1,
                manifest_sha256: digest(manifest_json.as_bytes()),
                files_manifest_sha256: digest(files_manifest_json.as_bytes()),
                validator_sha256: "a".repeat(64),
                integrity_validator_sha256: "b".repeat(64),
                structural_validator_sha256: "c".repeat(64),
                row_count: p.manifest.row_count,
                file_count: p.files.len(),
                audit_entries,
                last_audit_hash,
                committed_at: now_iso(),
            },
            manifest_json,
            files_manifest_json,
        };
        Self {
            head,
            rows,
            pages,
            files: p
                .files
                .iter()
                .map(|f| {
                    (
                        f.sha256.clone(),
                        fs::read(folder.join("files").join(&f.sha256)).unwrap(),
                    )
                })
                .collect(),
            current: AtomicBool::new(true),
            calls: Mutex::new(vec![]),
            fail_at: Mutex::new(None),
            disconnect: AtomicBool::new(false),
        }
    }
    fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
    fn folder(&self, store: &LocalStore) -> PathBuf {
        store
            .data_dir
            .join("business-history")
            .join(digest(self.organization().as_bytes()))
            .join(&self.head.receipt.transfer_id)
    }
}
impl HistoryTransport for Fake {
    fn organization(&self) -> &str {
        &self.head.receipt.organization_id
    }
    fn ensure_current(&self, _: &LocalStore) -> AppResult<()> {
        if self.current.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(invalid("Compte changé"))
        }
    }
    async fn get(&self, path: &str, query: &[(&str, &str)]) -> AppResult<Vec<u8>> {
        self.calls.lock().unwrap().push(format!("{path}?{query:?}"));
        if self
            .fail_at
            .lock()
            .unwrap()
            .is_some_and(|n| n == self.count())
        {
            return Err(invalid("Réseau interrompu"));
        }
        if self.disconnect.swap(false, Ordering::AcqRel) {
            self.current.store(false, Ordering::Release);
        }
        let q: BTreeMap<_, _> = query.iter().copied().collect();
        if query.is_empty() {
            return Ok(serde_json::to_vec(&self.head)?);
        }
        assert_eq!(q["transfer_id"], self.head.receipt.transfer_id);
        if path == "/api/sync/history/file" {
            let index = q["part"].parse::<usize>().unwrap();
            let bytes = &self.files[q["sha256"]];
            let at = index * PART_BYTES as usize;
            return Ok(bytes[at..(at + PART_BYTES as usize).min(bytes.len())].to_vec());
        }
        let index = q["index"].parse::<usize>().unwrap();
        Ok(if q["kind"] == "rows" {
            self.rows[index].clone()
        } else {
            self.pages[index].clone()
        })
    }
}
async fn finish(store: &LocalStore, source: &Fake) -> Value {
    for _ in 0..100 {
        let state = receive_pass(store, source, PARTS_PER_PASS).await.unwrap();
        if state["state"] == "history_received" {
            return state;
        }
    }
    panic!("Reception did not finish");
}
fn setup() -> (tempfile::TempDir, LocalStore, LocalStore, Fake) {
    let (root, source) = super::super::tests::setup();
    fs::write(
        source.attachments_dir.join("large.txt"),
        vec![23; PART_BYTES as usize + 31],
    )
    .unwrap();
    fs::write(source.attachments_dir.join("empty.txt"), []).unwrap();
    let fake = Fake::from_snapshot(&source);
    let recipient = LocalStore::initialize(root.path().join("recipient")).unwrap();
    (root, source, recipient, fake)
}
#[test]
fn receives_exact_files_resumes_after_interruption_and_preserves_the_working_profile() {
    tauri::async_runtime::block_on(async {
        let (_root, _source, recipient, fake) = setup();
        let original_installation = recipient.installation_id.clone();
        let connection = recipient.connect().unwrap();
        connection.execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('local','Client encore local','now','now')",[]).unwrap();
        drop(connection);
        *fake.fail_at.lock().unwrap() = Some(3);
        assert!(receive_pass(&recipient, &fake, PARTS_PER_PASS)
            .await
            .unwrap_err()
            .to_string()
            .contains("interrompu"));
        let rows_before = fs::read_dir(fake.folder(&recipient).join("rows"))
            .unwrap()
            .count();
        assert!(rows_before > 0);
        let first_piece_calls = fake
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.contains("(\"index\", \"0\")") && c.contains("rows"))
            .count();
        let result = finish(&recipient, &fake).await;
        assert_eq!(result["replication_active"], false);
        assert_eq!(recipient.installation_id, original_installation);
        assert_eq!(
            recipient
                .connect()
                .unwrap()
                .query_row("SELECT name FROM clients WHERE id='local'", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "Client encore local"
        );
        assert_eq!(
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.contains("(\"index\", \"0\")") && c.contains("rows"))
                .count(),
            first_piece_calls
        );
        for (sha, bytes) in &fake.files {
            assert_eq!(
                &fs::read(fake.folder(&recipient).join("files").join(sha)).unwrap(),
                bytes
            );
        }
        let count = fake.count();
        finish(&recipient, &fake).await;
        assert_eq!(
            fake.count(),
            count + 1,
            "Completed content is not downloaded twice"
        );
        assert_eq!(
            recipient
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM business_sync_binding", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    });
}
#[test]
fn changed_company_and_damaged_content_never_confirm_reception() {
    tauri::async_runtime::block_on(async {
        let (_root, _source, recipient, mut fake) = setup();
        fake.disconnect.store(true, Ordering::Release);
        assert!(receive_pass(&recipient, &fake, 8).await.is_err());
        assert!(!fake.folder(&recipient).exists());
        fake.current.store(true, Ordering::Release);
        fake.rows[0][0] ^= 1;
        assert!(receive_pass(&recipient, &fake, 8)
            .await
            .unwrap_err()
            .to_string()
            .contains("empreinte"));
        assert!(!fake.folder(&recipient).join("received.json").exists());
    });
}
#[test]
fn altered_binary_is_rejected_and_existing_local_changes_remain_unchanged() {
    tauri::async_runtime::block_on(async {
        let (_root, source, recipient, mut fake) = setup();
        let sha = fake
            .files
            .iter()
            .find(|(_, b)| !b.is_empty())
            .unwrap()
            .0
            .clone();
        fake.files.get_mut(&sha).unwrap()[0] ^= 1;
        let before = fs::read(&recipient.database_path).unwrap();
        assert!(receive_pass(&recipient, &fake, 8)
            .await
            .unwrap_err()
            .to_string()
            .contains("empreinte"));
        assert!(!fake.folder(&recipient).join("received.json").exists());
        assert_eq!(fs::read(&recipient.database_path).unwrap(), before);
        assert!(source
            .connect()
            .unwrap()
            .query_row(
                "SELECT capture_enabled FROM business_sync_binding",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
    });
}
#[test]
fn actual_server_publication_is_received_by_another_native_profile() {
    tauri::async_runtime::block_on(async {
        let Ok(input) = std::env::var("ZENTRA_CANONICAL_DOWNLOAD_QA") else {
            return;
        };
        let input = PathBuf::from(input);
        let head: Head =
            serde_json::from_slice(&fs::read(input.join("history.json")).unwrap()).unwrap();
        let (m, f) = head.validate("org_first").unwrap();
        let mut files = BTreeMap::new();
        let pages = f
            .pages
            .iter()
            .enumerate()
            .map(|(i, _)| fs::read(input.join("catalogue").join(format!("{i:04}.json"))).unwrap())
            .collect::<Vec<_>>();
        for page in &pages {
            for file in serde_json::from_slice::<FilePage>(page).unwrap().files {
                files.insert(
                    file.sha256.clone(),
                    fs::read(input.join("files").join(file.sha256)).unwrap(),
                );
            }
        }
        let fake = Fake {
            head,
            rows: m
                .chunks
                .iter()
                .enumerate()
                .map(|(i, _)| fs::read(input.join("rows").join(format!("{i:04}.json"))).unwrap())
                .collect(),
            pages,
            files,
            current: AtomicBool::new(true),
            calls: Mutex::new(vec![]),
            fail_at: Mutex::new(None),
            disconnect: AtomicBool::new(false),
        };
        let root = tempfile::tempdir().unwrap();
        let recipient = LocalStore::initialize(root.path().join("second-native")).unwrap();
        *fake.fail_at.lock().unwrap() = Some(4);
        assert!(receive_pass(&recipient, &fake, 8).await.is_err());
        let result = finish(&recipient, &fake).await;
        assert_eq!(result["rows"], 1365);
        assert_eq!(result["files"], 5);
        for (i, bytes) in fake.rows.iter().enumerate() {
            assert_eq!(
                &fs::read(
                    fake.folder(&recipient)
                        .join("rows")
                        .join(format!("{i:04}.json"))
                )
                .unwrap(),
                bytes
            );
        }
        for (sha, bytes) in &fake.files {
            assert_eq!(
                &fs::read(fake.folder(&recipient).join("files").join(sha)).unwrap(),
                bytes
            );
        }
        assert_eq!(
            recipient
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM invoices", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0,
            "Receiving is not a destructive database restore"
        );
    });
}
