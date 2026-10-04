//! Real workers, LocalStore locks, archives, preferences and connection guards.
//! No HTTP response or server authorization is proved by these local witnesses.
//! Native CI must compile and execute this module; do not run blocked binaries.
use super::*;
use futures_util::future::join;
use std::{future::Future, sync::mpsc, thread, time::Duration};

const ORGANIZATION: &str = "reference-worker-test-company";

fn fixture() -> (tempfile::TempDir, LocalStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    store.complete_onboarding(crate::tests::test_onboarding(), "reference-worker-test").unwrap();
    set_identity(&store, ORGANIZATION, "member-a", "Synthetic Alice", "owner").unwrap();
    store.create_record("clients", json!({"name":"Synthetic reference client"})).unwrap();
    (directory, store)
}

fn prepared(store: &LocalStore) -> (Pending, LocalTransferOrigin) {
    tauri::async_runtime::block_on(async {
        let _account = store.account_protected_cache.operation_lock.lock().await;
        prepare_for_send_worker(store, ORGANIZATION, true).await.unwrap()
    })
}

fn confirmed(store: &LocalStore, origin: LocalTransferOrigin, pending: Pending, revision: u64) -> AppResult<()> {
    tauri::async_runtime::block_on(async {
        let _account = store.account_protected_cache.operation_lock.lock().await;
        confirm_sent_worker(store, origin, pending, revision).await
    })
}

/// A future waiting on the true worker's LocalStore lock must yield so that
/// another future on that same executor can release it. No timing relaxation.
fn responsive<T>(store: &LocalStore, operation: impl Future<Output = AppResult<T>>) -> AppResult<T> {
    let owned = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _local = owned.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(operation, async {
        assert!(store.account_protected_cache.operation_lock.try_lock().is_none(),
            "the real caller must retain account -> local ordering until its worker finishes");
        let _ = release_tx.send(());
    }));
    assert!(holder.join().unwrap(), "reference worker blocked the releasing executor");
    assert!(store.account_protected_cache.operation_lock.try_lock().is_some());
    result
}

fn validation(result: AppResult<impl Sized>, expected: &str) {
    match result {
        Err(AppError::Validation(message)) => assert!(message.contains(expected), "{message}"),
        Err(error) => panic!("expected fixed local validation, received {error:?}"),
        Ok(_) => panic!("the obsolete or invalid confirmation was accepted"),
    }
}

#[derive(PartialEq, Debug)]
struct LocalEvidence {
    preferences: Option<Vec<u8>>,
    baseline: Option<Vec<u8>>,
    reference: Option<Vec<u8>>,
    digest: String,
    clock: i64,
}
fn evidence(store: &LocalStore) -> LocalEvidence {
    let _local = store.lock().unwrap();
    evidence_locked(store)
}
fn evidence_locked(store: &LocalStore) -> LocalEvidence {
    let optional = |name| {
        let path = store.data_dir.join(name);
        path.is_file().then(|| fs::read(path).unwrap())
    };
    LocalEvidence {
        preferences: optional(STATE),
        baseline: optional("company-sync-baseline.json"),
        reference: optional("company-sync-reference.zentra"),
        digest: crate::company_sync_digest::local(store).unwrap(),
        clock: clock(store).unwrap(),
    }
}

#[test]
fn preparation_confirmation_and_reference_workers_yield_while_waiting_for_the_real_local_lock() {
    let (directory, store) = fixture();
    let (pending, origin) = responsive(&store, async {
        let _account = store.account_protected_cache.operation_lock.lock().await;
        prepare_for_send_worker(&store, ORGANIZATION, true).await
    }).unwrap();
    let downloaded = directory.path().join("original-published.zentra");
    fs::copy(file_path(&store, &pending.id).unwrap(), &downloaded).unwrap();
    responsive(&store, async {
        let _account = store.account_protected_cache.operation_lock.lock().await;
        confirm_sent_worker(&store, origin, pending.clone(), 1).await
    }).unwrap();
    let (reference_origin, existing) = responsive(&store, async {
        let _account = store.account_protected_cache.operation_lock.lock().await;
        read_reference_worker(&store, ORGANIZATION, 1).await
    }).unwrap();
    assert_eq!(existing.unwrap(), store.data_dir.join("company-sync-reference.zentra"));
    let before = evidence(&store);
    responsive(&store, async {
        let _account = store.account_protected_cache.operation_lock.lock().await;
        install_reference_worker(&store, reference_origin, 1, downloaded, pending.manifest).await
    }).unwrap();
    assert_eq!(evidence(&store), before);
}

#[test]
fn an_unacknowledged_pending_archive_survives_restart_and_confirms_the_original_clock_and_digest() {
    let (directory, store) = fixture();
    let (pending, _) = prepared(&store);
    let original = fs::read(file_path(&store, &pending.id).unwrap()).unwrap();
    let expected_digest = crate::company_sync_digest::archive(&file_path(&store, &pending.id).unwrap()).unwrap();
    // This models only the local absence of an ACK, not a real HTTP commit.
    let reopened = LocalStore::initialize(directory.path().join("profile")).unwrap();
    let (retried, origin) = prepared(&reopened);
    assert!(retried == pending, "a restart must reuse the exact pending archive, ID, clock and manifest");
    reopened.create_record("clients", json!({"name":"Created after the snapshot"})).unwrap();
    let live_clock = clock(&reopened).unwrap();
    assert!(live_clock > pending.clock);
    let live_digest = crate::company_sync_digest::local(&reopened).unwrap();
    confirmed(&reopened, origin.clone(), retried.clone(), 1).unwrap();
    let prefs = load(&reopened).unwrap();
    assert_eq!(prefs.base_clock, pending.clock);
    assert_eq!(prefs.revision, 1);
    assert!(prefs.pending.is_none());
    assert_eq!(clock(&reopened).unwrap(), live_clock);
    assert_eq!(crate::company_sync_digest::local(&reopened).unwrap(), live_digest);
    assert_eq!(fs::read(reopened.data_dir.join("company-sync-reference.zentra")).unwrap(), original);
    assert_eq!(baseline(&reopened, &prefs).as_deref(), Some(expected_digest.as_str()));
    assert_eq!(status(&reopened).unwrap()["pending"], true,
        "a later local edit must still be sent after the old snapshot is confirmed");
    let before = evidence(&reopened);
    validation(confirmed(&reopened, origin, retried, 1), "L’envoi local a changé");
    assert_eq!(evidence(&reopened), before);
    let (next, _) = prepared(&reopened);
    assert_ne!(next.id, pending.id);
    assert_eq!(next.base_revision, 1);
    assert_eq!(next.clock, live_clock);
}

#[test]
fn older_producer_metadata_and_legacy_protocol_versions_keep_the_exact_pending_bytes_compatible() {
    for content_version in [0, 1, 2] {
        let (directory, store) = fixture();
        let (mut pending, origin) = prepared(&store);
        let mut manifest = serde_json::to_value(&pending.manifest).unwrap();
        manifest["app_version"] = json!("1.90.12");
        pending.manifest = serde_json::from_value(manifest).unwrap();
        pending.content_version = content_version;
        let mut prefs = load(&store).unwrap();
        prefs.pending = Some(pending.clone());
        save(&store, &prefs).unwrap();
        let original = fs::read(file_path(&store, &pending.id).unwrap()).unwrap();
        let downloaded = directory.path().join("older-producer.zentra");
        fs::write(&downloaded, &original).unwrap();
        let (resumed, resumed_origin) = prepared(&store);
        assert!(resumed == pending, "metadata and negotiated protocol are durable, not rewritten on an upgrade");
        assert_eq!(resumed_origin.workspace_scope, origin.workspace_scope);
        assert_eq!(resumed_origin.member_context, origin.member_context);
        confirmed(&store, resumed_origin.clone(), resumed.clone(), 1).unwrap();
        fs::remove_file(store.data_dir.join("company-sync-reference.zentra")).unwrap();
        tauri::async_runtime::block_on(async {
            let _account = store.account_protected_cache.operation_lock.lock().await;
            install_reference_worker(&store, resumed_origin, 1, downloaded, resumed.manifest).await.unwrap()
        });
        assert_eq!(fs::read(store.data_dir.join("company-sync-reference.zentra")).unwrap(), original);
        assert_eq!(load(&store).unwrap().base_clock, pending.clock);
        assert_eq!(load(&store).unwrap().revision, 1);
    }
}

#[test]
fn confirmation_rejects_each_changed_pending_field_before_modifying_the_reference_or_preferences() {
    for changed in ["id", "base_revision", "clock", "manifest", "content_version"] {
        let (_directory, store) = fixture();
        let (pending, origin) = prepared(&store);
        let mut prefs = load(&store).unwrap();
        let stored = prefs.pending.as_mut().unwrap();
        match changed {
            "id" => stored.id = uuid::Uuid::new_v4().to_string(),
            "base_revision" => stored.base_revision += 1,
            "clock" => stored.clock += 1,
            "manifest" => stored.manifest.sha256 = "a".repeat(64),
            "content_version" => stored.content_version = 1,
            _ => unreachable!(),
        }
        save(&store, &prefs).unwrap();
        let before = evidence(&store);
        validation(confirmed(&store, origin, pending, 1), "L’envoi local a changé");
        assert_eq!(evidence(&store), before, "changed {changed}");
    }
}

#[test]
fn invalid_revision_or_modified_archive_never_clears_the_pending_confirmation() {
    let (_directory, store) = fixture();
    let (pending, origin) = prepared(&store);
    let before = evidence(&store);
    validation(confirmed(&store, origin.clone(), pending.clone(), pending.base_revision),
        "La confirmation du serveur est incohérente");
    assert_eq!(evidence(&store), before);
    fs::write(file_path(&store, &pending.id).unwrap(), b"modified synthetic transport").unwrap();
    let before = evidence(&store);
    validation(confirmed(&store, origin, pending, 1), "L’envoi local a été modifié");
    assert_eq!(evidence(&store), before);
}

#[test]
fn a_failed_baseline_install_retains_the_exact_pending_state_and_the_same_confirmation_can_resume() {
    let (_directory, store) = fixture();
    let (pending, origin) = prepared(&store);
    let original = fs::read(file_path(&store, &pending.id).unwrap()).unwrap();
    let blocked_baseline = store.data_dir.join("company-sync-baseline.json");
    fs::create_dir(&blocked_baseline).unwrap();
    let before = evidence(&store);
    // A real filesystem failure after the reference copy, not a mocked result.
    assert!(matches!(confirmed(&store, origin.clone(), pending.clone(), 1), Err(AppError::Io(_))));
    assert_eq!(fs::read(store.data_dir.join(STATE)).ok(), before.preferences);
    assert_eq!(clock(&store).unwrap(), before.clock);
    assert_eq!(crate::company_sync_digest::local(&store).unwrap(), before.digest);
    assert_eq!(fs::read(file_path(&store, &pending.id).unwrap()).unwrap(), original);
    assert_eq!(fs::read(store.data_dir.join("company-sync-reference.zentra")).unwrap(), original);
    assert!(load(&store).unwrap().pending.as_ref() == Some(&pending));
    assert_eq!(load(&store).unwrap().revision, 0);
    // Remove only the test-owned empty obstacle, then resume the identical ACK.
    fs::remove_dir(blocked_baseline).unwrap();
    confirmed(&store, origin, pending.clone(), 1).unwrap();
    assert_eq!(load(&store).unwrap().revision, 1);
    assert_eq!(load(&store).unwrap().base_clock, pending.clock);
    assert!(load(&store).unwrap().pending.is_none());
}

#[test]
fn changed_member_role_and_return_to_the_same_member_refuse_the_original_confirmation() {
    for changed in ["member", "member_aba", "role"] {
        let (_directory, store) = fixture();
        let (pending, origin) = prepared(&store);
        if changed == "role" {
            set_identity(&store, ORGANIZATION, "member-a", "Synthetic Alice", "read_only").unwrap();
        } else {
            set_identity(&store, ORGANIZATION, "member-b", "Synthetic Bob", "owner").unwrap();
        }
        if changed == "member_aba" {
            set_identity(&store, ORGANIZATION, "member-a", "Synthetic Alice", "owner").unwrap();
        }
        let before = evidence(&store);
        validation(confirmed(&store, origin, pending, 1), "Le compte connecté a changé");
        assert_eq!(evidence(&store), before);
    }
}

#[test]
fn a_confirmation_queued_behind_a_real_restore_refuses_the_old_physical_space_before_pending_validation() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_directory, store) = fixture();
    let (pending, origin) = prepared(&store);
    let client_id = store.get_workspace().unwrap()["clients"][0]["id"].clone();
    let backup = store.create_backup(None, "reference-worker-test").unwrap();
    let owned = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (restore_tx, restore_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _local = owned.lock().unwrap();
        ready_tx.send(()).unwrap();
        assert!(restore_rx.recv_timeout(Duration::from_secs(5)).is_ok());
        owned.restore_backup(&backup, "reference-worker-test").unwrap();
        evidence_locked(&owned)
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let old_scope = origin.workspace_scope.clone();
    let (result, ()) = tauri::async_runtime::block_on(join(async {
        let _account = store.account_protected_cache.operation_lock.lock().await;
        confirm_sent_worker(&store, origin, pending, 1).await
    }, async { let _ = restore_tx.send(()); }));
    let restored = holder.join().unwrap();
    validation(result, "L’entreprise ouverte a changé");
    assert_ne!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(), old_scope);
    assert_eq!(store.get_workspace().unwrap()["clients"][0]["id"], client_id);
    assert_eq!(evidence(&store), restored);
}

#[test]
fn missing_or_corrupt_cached_reference_requires_an_exact_guarded_replacement_without_business_changes() {
    for corrupt in [false, true] {
        let (directory, store) = fixture();
        let (pending, origin) = prepared(&store);
        let downloaded = directory.path().join("downloaded-reference.zentra");
        fs::copy(file_path(&store, &pending.id).unwrap(), &downloaded).unwrap();
        confirmed(&store, origin, pending.clone(), 1).unwrap();
        let reference = store.data_dir.join("company-sync-reference.zentra");
        if corrupt { fs::write(&reference, b"corrupt cached reference").unwrap(); }
        else { fs::remove_file(&reference).unwrap(); }
        let before = evidence(&store);
        let (origin, existing) = tauri::async_runtime::block_on(async {
            let _account = store.account_protected_cache.operation_lock.lock().await;
            read_reference_worker(&store, ORGANIZATION, 1).await.unwrap()
        });
        assert!(existing.is_none());
        assert_eq!(evidence(&store), before, "a readonly probe cannot publish or repair a reference");
        let mut wrong_manifest = pending.manifest.clone();
        wrong_manifest.sha256 = "b".repeat(64);
        validation(tauri::async_runtime::block_on(async {
            let _account = store.account_protected_cache.operation_lock.lock().await;
            install_reference_worker(&store, origin.clone(), 1, downloaded.clone(), wrong_manifest).await
        }), "La copie de référence a changé");
        assert_eq!(evidence(&store), before);
        tauri::async_runtime::block_on(async {
            let _account = store.account_protected_cache.operation_lock.lock().await;
            install_reference_worker(&store, origin, 1, downloaded.clone(), pending.manifest).await.unwrap()
        });
        assert_eq!(fs::read(reference).unwrap(), fs::read(downloaded).unwrap());
        assert_eq!(clock(&store).unwrap(), before.clock);
        assert_eq!(crate::company_sync_digest::local(&store).unwrap(), before.digest);
        assert_eq!(fs::read(store.data_dir.join(STATE)).ok(), before.preferences);
    }
}

#[test]
fn reference_installation_retains_the_original_generation_and_revision_across_the_network_boundary() {
    for changed in ["member", "organization", "revision"] {
        let (directory, store) = fixture();
        let (pending, origin) = prepared(&store);
        let downloaded = directory.path().join("downloaded-reference.zentra");
        fs::copy(file_path(&store, &pending.id).unwrap(), &downloaded).unwrap();
        confirmed(&store, origin, pending.clone(), 1).unwrap();
        let (origin, _) = tauri::async_runtime::block_on(async {
            let _account = store.account_protected_cache.operation_lock.lock().await;
            read_reference_worker(&store, ORGANIZATION, 1).await.unwrap()
        });
        match changed {
            "member" => set_identity(&store, ORGANIZATION, "member-b", "Synthetic Bob", "owner").unwrap(),
            "organization" | "revision" => {
                let mut prefs = load(&store).unwrap();
                if changed == "organization" { prefs.organization_id = Some("another-company".into()); }
                else { prefs.revision += 1; }
                save(&store, &prefs).unwrap();
            }
            _ => unreachable!(),
        }
        let before = evidence(&store);
        validation(tauri::async_runtime::block_on(async {
            let _account = store.account_protected_cache.operation_lock.lock().await;
            install_reference_worker(&store, origin, 1, downloaded, pending.manifest).await
        }), match changed {
            "member" => "Le compte connecté a changé",
            "organization" => "La connexion ou l’entreprise ouverte a changé",
            "revision" => "La version de référence a changé",
            _ => unreachable!(),
        });
        assert_eq!(evidence(&store), before);
    }
}
