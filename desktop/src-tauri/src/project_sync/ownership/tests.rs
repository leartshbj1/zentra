use super::*;
use crate::project_documents::AddProjectDocumentInput;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::sync::atomic::AtomicUsize;

fn fixture() -> (tempfile::TempDir, LocalStore, String) {
    let root = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(root.path().join("profile")).unwrap();
    let project = Uuid::new_v4().to_string();
    let c = store.connect().unwrap();
    c.execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Documents test','2026-01-01','2026-01-01')",[]).unwrap();
    c.execute("INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,'Projet','2026-01-01','2026-01-01')",[&project]).unwrap();
    (root, store, project)
}
fn bind(store: &LocalStore, installed: bool) {
    let c = store.connect().unwrap();
    c.execute(
        "INSERT INTO business_sync_binding VALUES(1,'org',?,'generation',1,'2026-01-01')",
        [&store.installation_id],
    )
    .unwrap();
    crate::business_sync::upgrade_file_capture(&c).unwrap();
    // Controlled local evidence fixture. Receipt authentication/publication is
    // tested in the business-sync suite; these tests exercise file routing.
    if installed {
        c.execute("INSERT INTO business_sync_baseline VALUES(1,'org','remote','initial','{}','published','2026-01-01')",[]).unwrap();
    }
}
fn add(store: &LocalStore, project: &str) -> String {
    add_bytes(store, project, b"plan")
}
fn add_bytes(store: &LocalStore, project: &str, bytes: &[u8]) -> String {
    store
        .add_project_document(AddProjectDocumentInput {
            project_id: project.into(),
            original_name: "plan.txt".into(),
            content_base64: STANDARD.encode(bytes),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
fn ack(store: &LocalStore) {
    store.connect().unwrap().execute("INSERT INTO business_sync_receipts(generation,transaction_id,acknowledged_through,content_sha256,server_revision,acknowledged_at) SELECT generation,transaction_id,MAX(sequence),?,2,'2026-01-02' FROM business_sync_changes GROUP BY generation,transaction_id ON CONFLICT(generation,transaction_id) DO UPDATE SET acknowledged_through=excluded.acknowledged_through",["a".repeat(64)]).unwrap();
}

#[test]
fn shared_status_uses_pending_changes_and_receipts_instead_of_legacy_queue() {
    let (_root, store, project) = fixture();
    let historical = add(&store, &project);
    bind(&store, true);
    let new = add_bytes(&store, &project, b"Plan modifie");
    assert_ne!(historical, new);
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE project_document_sync SET state='synced',last_error='Ancienne erreur'",
            [],
        )
        .unwrap();
    let status = store.project_sync_status().unwrap();
    assert_eq!(status["mode"], "business");
    assert_eq!(status["pending"], 1);
    let documents = status["documents"].as_array().unwrap();
    assert_eq!(
        documents
            .iter()
            .find(|r| r["document_id"] == historical)
            .unwrap()["state"],
        "synced"
    );
    assert_eq!(
        documents.iter().find(|r| r["document_id"] == new).unwrap()["state"],
        "upload"
    );
    assert!(documents.iter().all(|r| r["last_error"].is_null()));
    ack(&store);
    assert_eq!(store.project_sync_status().unwrap()["pending"], 0);
    store.delete_project_document(&new).unwrap();
    let status = store.project_sync_status().unwrap();
    assert_eq!(status["pending"], 1);
    assert_eq!(
        status["documents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["document_id"] == new)
            .unwrap()["state"],
        "delete"
    );
    ack(&store);
    assert_eq!(
        store.project_sync_status().unwrap()["documents"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.read_project_document(&historical).unwrap(),
        STANDARD.encode(b"plan")
    );
}

#[test]
fn prepared_or_restored_binding_blocks_legacy_without_claiming_files_synced() {
    let (_root, store, project) = fixture();
    add(&store, &project);
    bind(&store, false);
    assert!(legacy_allowed(&store.connect().unwrap()).is_err());
    assert_eq!(store.project_sync_status().unwrap()["mode"], "preparing");
    assert_eq!(store.project_sync_status().unwrap()["pending"], 1);
    store.connect().unwrap().execute("INSERT INTO business_sync_baseline VALUES(1,'org','remote','initial','{}','received','2026-01-01')",[]).unwrap();
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE business_sync_binding SET capture_enabled=0,installation_id='other'",
            [],
        )
        .unwrap();
    assert_eq!(store.project_sync_status().unwrap()["mode"], "preparing");
    assert_eq!(store.project_sync_status().unwrap()["pending"], 1);
}

#[test]
fn shared_sync_command_returns_local_status_without_connecting_the_legacy_feed() {
    tauri::async_runtime::block_on(async {
        let (_root, store, project) = fixture();
        add(&store, &project);
        bind(&store, true);
        let run = cycle::acquire(&store).unwrap();
        assert_eq!(
            super::super::synchronize(&store, run).await.unwrap(),
            (true, false)
        );
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM project_sync_binding", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    });
}

#[test]
fn ownership_and_current_account_are_checked_before_and_after_network_even_on_error() {
    tauri::async_runtime::block_on(async {
        let (_root, store, _) = fixture();
        let run = cycle::acquire(&store).unwrap();
        let current = AtomicBool::new(true);
        let calls = AtomicUsize::new(0);
        let check = || {
            if current.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(AppError::Validation("Compte changé".into()))
            }
        };
        let response = checked_response(&store, &run, check, async {
            calls.fetch_add(1, Ordering::AcqRel);
            current.store(false, Ordering::Release);
            Err(AppError::Validation("Erreur réseau".into()))
        })
        .await;
        assert!(response.unwrap_err().to_string().contains("Compte changé"));
        current.store(true, Ordering::Release);
        let response = checked_response(&store, &run, check, async {
            calls.fetch_add(1, Ordering::AcqRel);
            bind(&store, true);
            Ok((StatusCode::OK, b"response".to_vec()))
        })
        .await;
        assert!(response.is_err());
        let response = checked_response(&store, &run, check, async {
            calls.fetch_add(1, Ordering::AcqRel);
            Ok((StatusCode::OK, Vec::new()))
        })
        .await;
        assert!(response.is_err());
        assert_eq!(calls.load(Ordering::Acquire), 2);
    });
}

#[test]
fn a_late_legacy_deletion_cannot_remove_a_shared_file() {
    let (_root, store, project) = fixture();
    let id = add(&store, &project);
    bind(&store, true);
    let deletion = RemoteDocument {
        sequence: 1,
        document_id: id.clone(),
        project_id: project,
        project_name: "Projet".into(),
        action: "deleted".into(),
        original_name: String::new(),
        media_type: String::new(),
        size_bytes: 0,
        sha256: String::new(),
        created_at: now_iso(),
    };
    assert!(store
        .apply_remote_document_checked(&deletion, None, || Ok(()))
        .is_err());
    assert_eq!(
        store.read_project_document(&id).unwrap(),
        STANDARD.encode(b"plan")
    );
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM business_sync_changes", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

fn remote_file(project: &str) -> RemoteDocument {
    RemoteDocument {
        sequence: 1,
        document_id: Uuid::new_v4().to_string(),
        project_id: project.into(),
        project_name: "Projet".into(),
        action: "stored".into(),
        original_name: "plan.txt".into(),
        media_type: "text/plain".into(),
        size_bytes: 4,
        sha256: format!("{:x}", Sha256::digest(b"plan")),
        created_at: now_iso(),
    }
}
#[test]
fn changing_account_before_commit_removes_only_the_new_cache_file() {
    let (_root, store, project) = fixture();
    let remote = remote_file(&project);
    let path = store
        .attachments_dir
        .join(format!("{}.txt", remote.document_id));
    let checks = AtomicUsize::new(0);
    let error = store
        .apply_remote_document_checked(&remote, Some(b"plan"), || {
            if checks.fetch_add(1, Ordering::AcqRel) == 0 {
                Ok(())
            } else {
                Err(AppError::Validation("Compte changé".into()))
            }
        })
        .unwrap_err();
    assert!(error.to_string().contains("Compte changé"));
    assert!(!path.exists());
    assert!(store.project_sync_status().unwrap()["documents"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(store
        .apply_remote_document_checked(&remote, Some(b"plan"), || Ok(()))
        .unwrap());
    assert_eq!(fs::read(&path).unwrap(), b"plan");
}
#[test]
fn interrupted_cache_is_reused_only_when_its_exact_content_matches() {
    let (_root, store, project) = fixture();
    let remote = remote_file(&project);
    let path = store
        .attachments_dir
        .join(format!("{}.txt", remote.document_id));
    fs::write(&path, b"Different local document").unwrap();
    assert!(store
        .apply_remote_document_checked(&remote, Some(b"plan"), || Ok(()))
        .is_err());
    assert_eq!(fs::read(&path).unwrap(), b"Different local document");
    fs::write(&path, b"plan").unwrap();
    assert!(store
        .apply_remote_document_checked(&remote, Some(b"plan"), || Ok(()))
        .unwrap());
    assert_eq!(
        store.read_project_document(&remote.document_id).unwrap(),
        STANDARD.encode(b"plan")
    );
}
