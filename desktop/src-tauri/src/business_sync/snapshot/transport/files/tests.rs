use super::*;
use std::sync::{atomic::AtomicBool, Mutex};

type FakeBlob = (BlobStatus, BTreeMap<usize, Vec<u8>>);

#[test]
fn live_export_fixture_generates_real_registered_exports_before_network_acceptance() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    store.connect().unwrap().execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('qa-native-bootstrap-0000','Client fictif','2026-09-08','2026-09-08')", []).unwrap();
    seed_live_qa_files(&store).unwrap();
    let prepared = store
        .prepare_business_snapshot("org-export-fixture", "owner")
        .unwrap();
    assert_eq!(prepared.version, 2);
    assert_eq!(prepared.files.len(), 5);
    assert_eq!(
        prepared
            .files
            .iter()
            .filter(|file| file.path.starts_with("exports/"))
            .count(),
        2
    );
    assert_eq!(prepared.manifest.tables.get("vat_return_exports"), Some(&1));
    assert_eq!(
        prepared.manifest.tables.get("closing_package_exports"),
        Some(&1)
    );
}

struct Fake {
    prepared: Prepared,
    generation: String,
    manifest: FileManifest,
    catalog: Mutex<Option<SetStatus>>,
    blobs: Mutex<BTreeMap<String, FakeBlob>>,
    requests: Mutex<Vec<(String, String, String)>>,
    puts: Mutex<Vec<(String, usize)>>,
    fail: Mutex<Option<&'static str>>,
    corrupt: Mutex<Option<&'static str>>,
    connected: AtomicBool,
    role: String,
    restore: Mutex<Option<LocalStore>>,
}
impl Fake {
    fn new(store: &LocalStore) -> Self {
        let bound = load_prepared(store, "org-files").unwrap().unwrap();
        let source = read_receipts(&bound).unwrap().unwrap();
        Self {
            manifest: pages(&bound).unwrap(),
            prepared: bound.prepared,
            generation: source.remote.generation,
            catalog: Mutex::new(None),
            blobs: Mutex::new(BTreeMap::new()),
            requests: Mutex::new(vec![]),
            puts: Mutex::new(vec![]),
            fail: Mutex::new(None),
            corrupt: Mutex::new(None),
            connected: AtomicBool::new(true),
            role: "owner".into(),
            restore: Mutex::new(None),
        }
    }
    fn status(&self) -> SetStatus {
        let mut catalog = self.catalog.lock().unwrap().clone().unwrap();
        let blobs = self.blobs.lock().unwrap();
        catalog.total_blobs = blobs.len();
        catalog.verified_blobs = blobs.values().filter(|(blob, _)| blob.verified).count();
        catalog.pending_blobs = blobs
            .values()
            .filter(|(blob, _)| !blob.verified)
            .take(8)
            .map(|(blob, _)| PendingBlob {
                sha256: blob.sha256.clone(),
                size_bytes: blob.size_bytes,
            })
            .collect();
        catalog
    }
    fn reply(&self, phase: &str, mut value: Value) -> AppResult<Vec<u8>> {
        if self
            .fail
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|expected| *expected == phase)
        {
            *self.fail.lock().unwrap() = None;
            return Err(invalid("Fictitious lost response"));
        }
        if let Some(corrupt) = *self.corrupt.lock().unwrap() {
            match corrupt {
                "generation" => value["generation"] = json!(Uuid::new_v4().to_string()),
                "activation" => value["replication_active"] = json!(true),
                "page" if value["uploaded_pages"].is_array() => value["uploaded_pages"] = json!([]),
                "part" if phase == "part" => {
                    value["uploaded_parts"][0]["sha256"] = json!("f".repeat(64))
                }
                _ => {}
            }
        }
        serde_json::to_vec(&value).map_err(Into::into)
    }
}
impl FileTransport for Fake {
    fn organization(&self) -> &str {
        &self.prepared.organization_id
    }
    fn role(&self) -> &str {
        &self.role
    }
    fn ensure_current(&self, _store: &LocalStore) -> AppResult<()> {
        if !self.connected.load(Ordering::Acquire) {
            return Err(invalid("Fictitious disconnected account"));
        }
        Ok(())
    }
    async fn files_request(&self, request: FileRequest) -> AppResult<Vec<u8>> {
        let query = |key| {
            request
                .query
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(
            query("transfer_id"),
            Some(self.prepared.transfer_id.as_str())
        );
        self.requests.lock().unwrap().push((
            request.path.into(),
            request.method.to_string(),
            request
                .body
                .as_ref()
                .map_or_else(String::new, |bytes| digest(bytes)),
        ));
        if request.path == FILES_PATH {
            if request.method == Method::POST {
                let body: Value = serde_json::from_slice(request.body.as_ref().unwrap()).unwrap();
                if body["action"] == "begin" {
                    let manifest: FileManifest =
                        serde_json::from_value(body["manifest"].clone()).unwrap();
                    assert_eq!(manifest, self.manifest);
                    self.catalog
                        .lock()
                        .unwrap()
                        .get_or_insert_with(|| SetStatus {
                            transfer_id: self.prepared.transfer_id.clone(),
                            organization_id: self.prepared.organization_id.clone(),
                            installation_id: self.prepared.installation_id.clone(),
                            generation: self.generation.clone(),
                            manifest_sha256: digest(&serde_json::to_vec(&manifest).unwrap()),
                            state: if manifest.file_count == 0 {
                                "uploaded"
                            } else {
                                "cataloguing"
                            }
                            .into(),
                            uploaded_pages: vec![],
                            file_count: manifest.file_count,
                            size_bytes: manifest.size_bytes,
                            total_blobs: 0,
                            verified_blobs: 0,
                            pending_blobs: vec![],
                            replication_active: false,
                        });
                    return self.reply("begin", json!(self.status()));
                }
                assert_eq!(body["action"], "complete");
                assert!(self.status().pending_blobs.is_empty());
                self.catalog.lock().unwrap().as_mut().unwrap().state = "uploaded".into();
            } else if request.method == Method::PUT {
                let index: usize = query("page").unwrap().parse().unwrap();
                let bytes = request.body.as_ref().unwrap();
                assert_eq!(digest(bytes), self.manifest.pages[index].sha256);
                let body: Value = serde_json::from_slice(bytes).unwrap();
                let entries: Vec<FrozenFile> =
                    serde_json::from_value(body["files"].clone()).unwrap();
                let mut catalog = self.catalog.lock().unwrap();
                let catalog = catalog.as_mut().unwrap();
                if !catalog
                    .uploaded_pages
                    .iter()
                    .any(|page| page.page_index == index)
                {
                    let page = &self.manifest.pages[index];
                    catalog.uploaded_pages.push(PageReceipt {
                        page_index: index,
                        sha256: page.sha256.clone(),
                        size_bytes: page.size_bytes,
                        file_count: page.file_count,
                    });
                    catalog.uploaded_pages.sort_by_key(|page| page.page_index);
                    let mut blobs = self.blobs.lock().unwrap();
                    for entry in entries {
                        blobs.entry(entry.sha256.clone()).or_insert_with(|| {
                            (
                                BlobStatus {
                                    transfer_id: self.prepared.transfer_id.clone(),
                                    organization_id: self.prepared.organization_id.clone(),
                                    installation_id: self.prepared.installation_id.clone(),
                                    generation: self.generation.clone(),
                                    sha256: entry.sha256,
                                    size_bytes: entry.size_bytes,
                                    verified: entry.size_bytes == 0,
                                    uploaded_parts: vec![],
                                    replication_active: false,
                                },
                                BTreeMap::new(),
                            )
                        });
                    }
                }
                if catalog.uploaded_pages.len() == self.manifest.pages.len() {
                    catalog.state = "uploading".into();
                }
            } else {
                assert_eq!(request.method, Method::GET);
            }
            return self.reply(
                if request.method == Method::PUT {
                    "page"
                } else {
                    "set"
                },
                json!(self.status()),
            );
        }
        assert_eq!(request.path, FILE_PATH);
        let sha = query("sha256").unwrap();
        let mut blobs = self.blobs.lock().unwrap();
        let (blob, parts) = blobs.get_mut(sha).unwrap();
        let phase = if request.method == Method::PUT {
            let index: usize = query("part").unwrap().parse().unwrap();
            let bytes = request.body.as_ref().unwrap();
            assert_eq!(
                request
                    .headers
                    .iter()
                    .find(|(key, _)| *key == "x-content-sha256")
                    .unwrap()
                    .1,
                digest(bytes)
            );
            self.puts.lock().unwrap().push((sha.into(), index));
            if let Some(previous) = parts.insert(index, bytes.clone()) {
                assert_eq!(previous, *bytes);
            }
            blob.uploaded_parts = parts
                .iter()
                .map(|(index, bytes)| PartReceipt {
                    part_index: *index,
                    sha256: digest(bytes),
                    size_bytes: bytes.len() as u64,
                })
                .collect();
            if let Some(store) = self.restore.lock().unwrap().take() {
                store
                    .connect()
                    .unwrap()
                    .execute(
                        "UPDATE business_sync_binding SET capture_enabled=0 WHERE id=1",
                        [],
                    )
                    .unwrap();
            }
            "part"
        } else if request.method == Method::POST {
            let bytes = parts.values().flatten().copied().collect::<Vec<_>>();
            assert_eq!(bytes.len() as u64, blob.size_bytes);
            assert_eq!(digest(&bytes), sha);
            blob.verified = true;
            "verify"
        } else {
            assert_eq!(request.method, Method::GET);
            "blob"
        };
        self.reply(phase, json!(blob))
    }
}

fn fixture() -> (tempfile::TempDir, LocalStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    fs::create_dir_all(store.attachments_dir.join("plans")).unwrap();
    let bytes = vec![23u8; PART_BYTES + 31];
    fs::write(store.attachments_dir.join("plans/été.pdf"), &bytes).unwrap();
    fs::write(store.attachments_dir.join("plans/copie.pdf"), &bytes).unwrap();
    fs::write(store.attachments_dir.join("logo.png"), b"Fictitious logo").unwrap();
    fs::write(store.attachments_dir.join("empty.txt"), b"").unwrap();
    store
        .prepare_business_snapshot("org-files", "owner")
        .unwrap();
    let bound = load_prepared(&store, "org-files").unwrap().unwrap();
    let manifest = &bound.prepared.manifest;
    let status = RemoteStatus {
        transfer_id: bound.prepared.transfer_id.clone(),
        organization_id: "org-files".into(),
        installation_id: store.installation_id.clone(),
        generation: Uuid::new_v4().to_string(),
        state: "uploaded".into(),
        manifest_sha256: digest(&serde_json::to_vec(manifest).unwrap()),
        uploaded_chunks: manifest
            .chunks
            .iter()
            .enumerate()
            .map(|(index, part)| Receipt {
                chunk_index: index,
                sha256: part.sha256.clone(),
                size_bytes: part.size_bytes,
                row_count: part.row_count,
            })
            .collect(),
        replication_active: false,
    };
    save_receipts(&store, &bound, status, None).unwrap();
    (directory, store)
}

#[test]
fn lost_responses_resume_the_same_catalogue_and_only_missing_file_parts_after_restart() {
    tauri::async_runtime::block_on(async {
        let (_directory, store) = fixture();
        let fake = Fake::new(&store);
        *fake.fail.lock().unwrap() = Some("begin");
        assert!(transfer_files_pass(&store, &fake, 1).await.is_err());
        *fake.fail.lock().unwrap() = Some("page");
        assert!(transfer_files_pass(&store, &fake, 1).await.is_err());
        *fake.fail.lock().unwrap() = Some("part");
        assert!(transfer_files_pass(&store, &fake, 1).await.is_err());
        let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
        let result = transfer_files_pass(&reopened, &fake, 8).await.unwrap();
        assert_eq!(result["state"], "files_uploaded");
        assert_eq!(result["confirmed_files"], 3);
        assert_eq!(result["replication_active"], false);
        let repeated = transfer_files_pass(&reopened, &fake, 8).await.unwrap();
        assert_eq!(repeated["sent_file_parts"], 0);
        let puts = fake.puts.lock().unwrap();
        assert_eq!(puts.len(), 3);
        assert_eq!(puts.iter().collect::<BTreeSet<_>>().len(), 3);
        let requests = fake.requests.lock().unwrap();
        let begins = requests
            .iter()
            .filter(|(path, method, _)| path == FILES_PATH && method == "POST")
            .take(2)
            .collect::<Vec<_>>();
        assert_eq!(begins[0].2, begins[1].2);
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM shared_numbering_binding", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    });
}

#[test]
fn original_file_edits_do_not_change_the_frozen_transfer_and_parts_are_checked_after_caching() {
    let (_directory, store) = fixture();
    let bound = load_prepared(&store, "org-files").unwrap().unwrap();
    let original = bound
        .prepared
        .files
        .iter()
        .find(|file| file.size_bytes > PART_BYTES as u64)
        .unwrap();
    let blob = PendingBlob {
        sha256: original.sha256.clone(),
        size_bytes: original.size_bytes,
    };
    fs::write(
        store.attachments_dir.join("plans/été.pdf"),
        b"Later local edit",
    )
    .unwrap();
    let plan = part_plan(&store, &bound, &blob).unwrap();
    assert_eq!(plan.parts.len(), 2);
    assert_eq!(
        part_bytes(&store, &bound, &plan, 0).unwrap(),
        vec![23u8; PART_BYTES]
    );
    let path = bound.folder.join("files").join(&blob.sha256);
    let mut bytes = fs::read(&path).unwrap();
    bytes[PART_BYTES] ^= 1;
    fs::write(path, bytes).unwrap();
    assert_eq!(part_plan(&store, &bound, &blob).unwrap(), plan);
    assert!(part_bytes(&store, &bound, &plan, 1).is_err());
}

#[test]
fn contradictory_catalogue_receipts_do_not_replace_the_durable_original() {
    tauri::async_runtime::block_on(async {
        let (_directory, store) = fixture();
        let fake = Fake::new(&store);
        transfer_files_pass(&store, &fake, 1).await.unwrap();
        let bound = load_prepared(&store, "org-files").unwrap().unwrap();
        let path = cache_folder(&bound).unwrap().join("catalog.json");
        let saved = fs::read(&path).unwrap();
        for corrupt in ["generation", "activation", "page"] {
            *fake.corrupt.lock().unwrap() = Some(corrupt);
            assert!(
                transfer_files_pass(&store, &fake, 8).await.is_err(),
                "{corrupt}"
            );
            assert_eq!(fs::read(&path).unwrap(), saved);
        }
        assert!(fake.puts.lock().unwrap().is_empty());
        *fake.corrupt.lock().unwrap() = None;
        assert_eq!(
            transfer_files_pass(&store, &fake, 8).await.unwrap()["state"],
            "files_uploaded"
        );
    });
}

#[test]
fn forged_part_receipt_is_rejected_and_a_later_valid_server_receipt_can_resume() {
    tauri::async_runtime::block_on(async {
        let (_directory, store) = fixture();
        let fake = Fake::new(&store);
        transfer_files_pass(&store, &fake, 1).await.unwrap();
        *fake.corrupt.lock().unwrap() = Some("part");
        assert!(transfer_files_pass(&store, &fake, 1).await.is_err());
        let bound = load_prepared(&store, "org-files").unwrap().unwrap();
        let sha = fake.puts.lock().unwrap()[0].0.clone();
        let cached: DurableFileStatus<BlobStatus> = read_cache(
            &cache_folder(&bound).unwrap(),
            &format!("receipt-{sha}.json"),
        )
        .unwrap()
        .unwrap();
        assert!(cached.status.uploaded_parts.is_empty());
        *fake.corrupt.lock().unwrap() = None;
        assert_eq!(
            transfer_files_pass(&store, &fake, 8).await.unwrap()["state"],
            "files_uploaded"
        );
        assert_eq!(fake.puts.lock().unwrap().len(), 3);
    });
}

#[test]
fn wrong_role_or_restore_cannot_confirm_a_file_upload() {
    tauri::async_runtime::block_on(async {
        let (_directory, store) = fixture();
        let mut fake = Fake::new(&store);
        for role in ["member", "accountant", "read_only", "viewer"] {
            fake.role = role.into();
            assert!(transfer_files_pass(&store, &fake, 8).await.is_err());
        }
        assert!(fake.requests.lock().unwrap().is_empty());
        fake.role = "owner".into();
        transfer_files_pass(&store, &fake, 1).await.unwrap();
        *fake.restore.lock().unwrap() = Some(store.clone());
        assert!(transfer_files_pass(&store, &fake, 1).await.is_err());
        let sha = fake.puts.lock().unwrap()[0].0.clone();
        let path = store
            .snapshot_folder(&fake.prepared.transfer_id)
            .unwrap()
            .join("file-transfer");
        let cached: DurableFileStatus<BlobStatus> =
            read_cache(&path, &format!("receipt-{sha}.json"))
                .unwrap()
                .unwrap();
        assert!(cached.status.uploaded_parts.is_empty());
        assert!(load_prepared(&store, "org-files").is_err());
    });
}
