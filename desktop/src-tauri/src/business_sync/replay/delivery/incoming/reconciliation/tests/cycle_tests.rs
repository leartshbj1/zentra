use super::*;
use crate::business_sync::{cycle, outgoing::transport as sender};
use std::sync::{Arc, Mutex};

mod business_commands;

struct Server {
    header: Header,
    folder: PathBuf,
    calls: Mutex<Vec<String>>,
    fail_once: Mutex<bool>,
    change_history: Mutex<Option<LocalStore>>,
    cancel_after_read: Mutex<Option<LocalStore>>,
}
impl Transport for Server {
    fn organization(&self) -> &str {
        &self.header.binding.organization
    }
    fn ensure_current(&self, _: &LocalStore) -> AppResult<()> {
        Ok(())
    }
    async fn get(&self, query: &[(&str, &str)], limit: u64) -> AppResult<Vec<u8>> {
        let field = |name: &str| {
            query
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| *value)
        };
        let resource = field("resource").unwrap_or("discovery");
        self.calls.lock().unwrap().push(resource.into());
        if std::mem::take(&mut *self.fail_once.lock().unwrap()) {
            return Err(invalid("Interrupted network response"));
        }
        if let Some(store) = self.change_history.lock().unwrap().take() {
            store
                .connect()
                .unwrap()
                .execute(
                    "UPDATE business_sync_binding SET generation=?1",
                    [Uuid::new_v4().to_string()],
                )
                .unwrap();
        }
        if let Some(store) = self.cancel_after_read.lock().unwrap().take() {
            assert!(cycle::cancel(&store).unwrap());
        }
        let bytes = if resource == "discovery" {
            let after: i64 = field("after_revision").unwrap().parse().unwrap();
            let head = self.header.entry.revision;
            let commits = if after < head {
                vec![serde_json::to_value(&self.header.entry).unwrap()]
            } else {
                vec![]
            };
            serde_json::to_vec(&json!({"organization_id":self.header.binding.organization,"generation":self.header.binding.generation,"head_revision":head,"commits":commits,"next_revision":head,"has_more":false})).unwrap()
        } else if resource == "file" {
            let sha = field("sha256").unwrap();
            let bytes = fs::read(self.folder.join("files").join(sha)).unwrap();
            if let Some(part) = field("part") {
                bytes
                    .chunks(FILE_PART_BYTES as usize)
                    .nth(part.parse().unwrap())
                    .unwrap()
                    .to_vec()
            } else {
                serde_json::to_vec(&json!({"format":"zentra-canonical-file","version":1,"transaction_id":self.header.entry.transaction_id,"organization_id":self.header.binding.organization,"generation":self.header.binding.generation,"sha256":sha,"size_bytes":bytes.len(),"part_bytes":FILE_PART_BYTES,"parts":bytes.chunks(FILE_PART_BYTES as usize).enumerate().map(|(i,b)|json!({"part_index":i,"sha256":digest(b),"size_bytes":b.len()})).collect::<Vec<_>>()})).unwrap()
            }
        } else {
            let path = match resource {
                "receipt" | "bundle" | "manifest" => self.folder.join(format!("{resource}.json")),
                "changes" | "positions" => self.folder.join(resource).join(format!(
                    "{:04}.json",
                    field("part").unwrap().parse::<usize>().unwrap()
                )),
                _ => panic!("Unexpected server resource {resource}"),
            };
            fs::read(path).unwrap()
        };
        assert!(bytes.len() as u64 <= limit);
        Ok(bytes)
    }
}
impl sender::Transport for Server {
    fn organization(&self) -> &str {
        &self.header.binding.organization
    }
    fn role(&self) -> &str {
        "owner"
    }
    fn current(&self, _: &LocalStore) -> AppResult<()> {
        Ok(())
    }
    async fn request(
        &self,
        _: reqwest::Method,
        _: &str,
        _: Option<usize>,
        _: Option<Vec<u8>>,
    ) -> AppResult<(u16, Vec<u8>)> {
        self.calls.lock().unwrap().push("send".into());
        Err(invalid("Upload network unavailable"))
    }
}

fn transport(store: &LocalStore, folder: PathBuf, header: Header) -> Arc<cycle::Guarded<Server>> {
    // Keep the generated server bytes elsewhere so reception must download and
    // verify them through the actual transport, not reuse pre-populated staging.
    let source = folder.with_file_name(format!("server-fixture-{}", Uuid::new_v4()));
    fs::rename(&folder, &source).unwrap();
    Arc::new(cycle::Guarded::new(
        Server {
            folder: source,
            header,
            calls: Mutex::new(vec![]),
            fail_once: Mutex::new(false),
            change_history: Mutex::new(None),
            cancel_after_read: Mutex::new(None),
        },
        selection(store, "org-replay").unwrap(),
        cycle::acquire(store).unwrap(),
    ))
}
fn pending(store: &LocalStore) -> i64 {
    crate::business_sync::status(&store.connect().unwrap()).unwrap()["pending_transactions"]
        .as_i64()
        .unwrap()
}
fn acknowledged(store: &LocalStore) -> i64 {
    store
        .connect()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM business_sync_receipts", [], |r| {
            r.get(0)
        })
        .unwrap()
}

#[test]
fn cycle_downloads_and_reconciles_own_receipt_before_any_further_upload() {
    tauri::async_runtime::block_on(async {
        let (_root, store, p, before, after) = setup();
        let (folder, header) = stage(&store, &p, &before, &after);
        let t = transport(&store, folder, header);
        // A form can retain its input while a received revision waits to install.
        let waiting = cycle::pass(store.clone(), t.clone(), false).await.unwrap();
        assert_eq!(waiting["state"], "awaiting_installation");
        assert_eq!(acknowledged(&store), 0);
        assert_eq!(pending(&store), 1);
        let installed = cycle::pass(store.clone(), t.clone(), true).await.unwrap();
        assert_eq!(installed["state"], "installed");
        assert_eq!(installed["workspace_changed"], true);
        assert_eq!(installed["detail"]["acknowledged"], true);
        assert_eq!(acknowledged(&store), 1);
        assert_eq!(pending(&store), 0);
        assert_eq!(
            replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
            after
        );
        let idle = cycle::pass(store.clone(), t.clone(), true).await.unwrap();
        assert_eq!(idle["state"], "idle");
        assert!(!t.transport.calls.lock().unwrap().contains(&"send".into()));
        assert!(t
            .transport
            .calls
            .lock()
            .unwrap()
            .contains(&"changes".into()));
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM business_sync_changes", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    });
}

#[test]
fn cycle_cancellation_after_network_reply_keeps_rows_and_blocks_a_competing_pass() {
    tauri::async_runtime::block_on(async {
        let (_root, store, p, before, after) = setup();
        let (folder, header) = stage(&store, &p, &before, &after);
        let t = transport(&store, folder, header);
        *t.transport.cancel_after_read.lock().unwrap() = Some(store.clone());
        let error = cycle::pass(store.clone(), t.clone(), true)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("suspendue"), "{error}");
        assert_eq!(acknowledged(&store), 0);
        assert_eq!(pending(&store), 1);
        assert_eq!(
            replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
            after
        );
        assert!(cycle::acquire(&store).is_err());
        drop(t);
        assert!(cycle::acquire(&store).is_ok());
    });
}

#[test]
fn cycle_transfers_a_document_in_fragments_and_preserves_its_original_proof() {
    tauri::async_runtime::block_on(async {
        let (_root, store, context) = replay::tests::setup_with(|_| {});
        let bytes = vec![17u8; FILE_PART_BYTES as usize + 29];
        fs::write(store.attachments_dir.join("plan.bin"), &bytes).unwrap();
        store.connect().unwrap().execute("INSERT INTO attachments(id,original_name,stored_name,size_bytes,sha256,created_at,updated_at) VALUES('plan','plan.bin','plan.bin',?1,?2,'2026-09-09','2026-09-09')", params![bytes.len() as i64,digest(&bytes)]).unwrap();
        let after = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
        let p = outgoing::prepare_next(&store, "org-replay", "owner")
            .unwrap()
            .unwrap();
        let (folder, header) = stage(&store, &p, &context.source_state_sha256, &after);
        let t = transport(&store, folder, header);
        let result = cycle::pass(store.clone(), t.clone(), true).await.unwrap();
        assert_eq!(result["state"], "installed");
        assert_eq!(acknowledged(&store), 1);
        assert_eq!(pending(&store), 0);
        assert_eq!(
            fs::read(store.attachments_dir.join("plan.bin")).unwrap(),
            bytes
        );
        assert_eq!(
            t.transport
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|kind| *kind == "file")
                .count(),
            3
        );
        assert!(crate::business_sync::files::retained_blob_path(
            &store.data_dir,
            &digest(&bytes),
            bytes.len() as u64
        )
        .unwrap()
        .exists());
    });
}

#[test]
fn cycle_preserves_later_offline_edits_then_attempts_only_the_remaining_transaction() {
    tauri::async_runtime::block_on(async {
        let (_root, store, p, before, after) = setup();
        let (folder, header) = stage(&store, &p, &before, &after);
        store
            .connect()
            .unwrap()
            .execute("UPDATE clients SET name='Later edit' WHERE id='own'", [])
            .unwrap();
        let expected = replay::state_fingerprint(&store.connect().unwrap()).unwrap();
        let t = transport(&store, folder, header);
        assert_eq!(
            cycle::pass(store.clone(), t.clone(), true).await.unwrap()["state"],
            "installed"
        );
        assert_eq!(pending(&store), 1);
        assert_eq!(acknowledged(&store), 1);
        assert!(!t.transport.calls.lock().unwrap().contains(&"send".into()));
        let error = cycle::pass(store.clone(), t.clone(), true)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("Upload network unavailable"),
            "{error}"
        );
        let remaining = outgoing::prepare_next(&store, "org-replay", "owner")
            .unwrap()
            .unwrap();
        assert_ne!(remaining.manifest.transaction_id, p.manifest.transaction_id);
        assert_eq!(pending(&store), 1);
        assert_eq!(
            replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
            expected
        );
    });
}

#[test]
fn cycle_conflict_blocks_both_installation_and_upload_without_consuming_evidence() {
    tauri::async_runtime::block_on(async {
        let (_root, store, mut p, before, after) = setup();
        p.manifest.capture_generation = Uuid::new_v4().to_string();
        let (folder, header) = stage(&store, &p, &before, &after);
        let t = transport(&store, folder, header);
        let result = cycle::pass(store.clone(), t.clone(), true).await.unwrap();
        assert_eq!(result["state"], "conflict");
        assert_eq!(result["workspace_changed"], false);
        assert_eq!(result["detail"]["conflict_count"], 1);
        assert_eq!(acknowledged(&store), 0);
        assert_eq!(pending(&store), 1);
        assert!(!t.transport.calls.lock().unwrap().contains(&"send".into()));
        assert_eq!(
            replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
            after
        );
    });
}

#[test]
fn cycle_retries_network_failure_but_rejects_a_history_changed_during_the_request() {
    tauri::async_runtime::block_on(async {
        let (_root, store, p, before, after) = setup();
        let (folder, header) = stage(&store, &p, &before, &after);
        let t = transport(&store, folder, header);
        *t.transport.fail_once.lock().unwrap() = true;
        assert!(cycle::pass(store.clone(), t.clone(), true).await.is_err());
        assert_eq!(acknowledged(&store), 0);
        assert_eq!(
            cycle::pass(store.clone(), t.clone(), false).await.unwrap()["state"],
            "awaiting_installation"
        );
        *t.transport.change_history.lock().unwrap() = Some(store.clone());
        let error = cycle::pass(store.clone(), t.clone(), true)
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("historique sélectionné a changé"),
            "{error}"
        );
        assert_eq!(acknowledged(&store), 0);
        assert_eq!(
            replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
            after
        );
    });
}
