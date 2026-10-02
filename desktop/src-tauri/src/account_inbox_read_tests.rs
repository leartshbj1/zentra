//! Real account locks, protected references, SQLite scopes and restores.
//! Only the single HTTP future is synthetic; native CI must execute these tests.
use super::*;
use futures_util::{channel::oneshot, future::join};
use std::{cell::{Cell, RefCell}, sync::mpsc, thread, time::Duration};

fn fixture(role: &str) -> (tempfile::TempDir, LocalStore, CloudSession) {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store.complete_onboarding(crate::tests::test_onboarding(), "inbox-read-test").unwrap();
    let now = Utc::now();
    let session = CloudSession {
        version: SECRET_VERSION,
        installation_id: store.installation_id.clone(),
        session_token: format!("zds_{}", "I".repeat(43)),
        session_expires_at: (now + chrono::Duration::hours(1)).to_rfc3339(),
        organization_id: format!("org_{}", Uuid::new_v4()),
        organization_name: "Synthetic inbox company".into(),
        role: role.into(),
        connected_at: now.to_rfc3339(),
    };
    write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
    crate::company_collaboration::account::bind_new_company(&store, &session.organization_id).unwrap();
    (temporary, store, session)
}

fn reply() -> AppResult<(StatusCode, Vec<u8>)> {
    Ok((StatusCode::OK, br#"{"items":[{"id":"synthetic-receipt"}]}"#.to_vec()))
}

fn refs(store: &LocalStore) -> [Option<Vec<u8>>; 3] {
    [session_path(store), pending_path(store), exchange_path(store)]
        .each_ref().map(|path| optional_account_reference(path).unwrap())
}

fn read_with_change(
    store: &LocalStore,
    change: impl FnOnce(),
    fail: bool,
) -> AppResult<serde_json::Value> {
    let count = Cell::new(0);
    let result = tauri::async_runtime::block_on(bound_inbox_get_with(store, |_| async {
        count.set(count.get() + 1);
        {
            let _account = store.account_protected_cache.operation_lock.try_lock()
                .expect("the request future must not retain the account lock");
            let _local = store.lock().unwrap();
            change();
        }
        if fail { Err(AppError::Remote("synthetic obsolete network failure".into())) } else { reply() }
    }));
    assert_eq!(count.get(), 1, "no retries or /me calls");
    result
}

fn changed(result: AppResult<serde_json::Value>) {
    match result {
        Err(AppError::Validation(message)) => assert_eq!(message, "La connexion ou l’entreprise ouverte a changé. Rouvrez la réception."),
        other => panic!("expected a fixed obsolete-context rejection, received {other:?}"),
    }
}

fn held_local_lock(store: &LocalStore) -> (mpsc::Sender<()>, thread::JoinHandle<bool>) {
    let owned = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _local = owned.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    (release_tx, holder)
}

#[test]
fn local_lock_waits_yield_the_executor_during_capture_and_admission() {
    let (_temporary, store, _) = fixture("owner");
    let (release, holder) = held_local_lock(&store);
    let (result, ()) = tauri::async_runtime::block_on(join(
        bound_inbox_get_with(&store, |_| async { reply() }),
        async { release.send(()).unwrap(); },
    ));
    assert!(holder.join().unwrap(), "capturing the scope must not block the releasing future");
    assert!(result.is_ok());

    let holder = RefCell::new(None);
    let (release_tx, release_rx) = oneshot::channel();
    let (result, ()) = tauri::async_runtime::block_on(join(
        bound_inbox_get_with(&store, |_| async {
            let (release, waiting) = held_local_lock(&store);
            holder.replace(Some(waiting));
            release_tx.send(release).unwrap();
            reply()
        }),
        async { release_rx.await.unwrap().send(()).unwrap(); },
    ));
    assert!(holder.into_inner().unwrap().join().unwrap(), "admitting the receipt must not block the releasing future");
    assert!(result.is_ok());
}

#[test]
fn a_pending_inbox_read_leaves_both_locks_and_cached_account_available() {
    let (_temporary, store, session) = fixture("owner");
    let before = refs(&store);
    let scope = crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();
    let expected_organization = session.organization_id.clone();
    let (started_tx, started_rx) = oneshot::channel();
    let (reply_tx, reply_rx) = oneshot::channel();
    let (result, ()) = tauri::async_runtime::block_on(join(
        bound_inbox_get_with(&store, |outgoing| async move {
            assert_eq!(outgoing.organization_id, expected_organization);
            assert_eq!(outgoing.role, "owner");
            started_tx.send(()).unwrap();
            reply_rx.await.expect("the concurrent probe must finish before the HTTP future")
        }),
        async {
            started_rx.await.unwrap();
            {
                let _account = store.account_protected_cache.operation_lock.try_lock()
                    .expect("a slow inbox must not block account/Automation operations");
                assert_eq!(cached_cloud_account_state(&store).unwrap().status, "connected");
                let _local = store.lock().unwrap();
                store.connect().unwrap().execute("UPDATE settings SET company_name='Synthetic local edit' WHERE id=1", []).unwrap();
                crate::automation::bound(&store, &session.organization_id).unwrap();
            }
            reply_tx.send(reply()).unwrap();
        },
    ));
    assert_eq!(result.unwrap()["items"][0]["id"], "synthetic-receipt");
    assert_eq!(refs(&store), before, "the GET never writes account references");
    assert_eq!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(), scope);
    assert_eq!(store.connect().unwrap().query_row("SELECT company_name FROM settings WHERE id=1", [], |row| row.get::<_, String>(0)).unwrap(), "Synthetic local edit");
}

#[test]
fn unchanged_read_only_session_receives_the_list_without_writing_account_or_license() {
    let (_temporary, store, _) = fixture("read_only");
    let before = refs(&store);
    let license_before = store.get_license_state().unwrap();
    let result = tauri::async_runtime::block_on(bound_inbox_get_with(&store, |outgoing| async move {
        assert_eq!(outgoing.role, "read_only");
        reply()
    })).unwrap();
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(refs(&store), before);
    assert_eq!(store.get_license_state().unwrap(), license_before);
}

#[test]
fn unchanged_network_and_json_failures_keep_their_original_contract() {
    let (_temporary, store, _) = fixture("owner");
    let before = refs(&store);
    let result = tauri::async_runtime::block_on(bound_inbox_get_with(&store, |_| async {
        Err(AppError::Remote("synthetic original outage".into()))
    }));
    assert!(matches!(result, Err(AppError::Remote(message)) if message == "synthetic original outage"));
    let result = tauri::async_runtime::block_on(bound_inbox_get_with(&store, |_| async {
        Ok((StatusCode::OK, b"not-json".to_vec()))
    }));
    assert!(matches!(result, Err(AppError::Remote(message)) if message == "La réception est indisponible."));
    assert_eq!(refs(&store), before);
}

#[test]
fn logged_out_or_replaced_sessions_reject_late_success_and_failure() {
    for fail in [false, true] {
        for logout in [false, true] {
            let (_temporary, store, session) = fixture("owner");
            changed(read_with_change(&store, || {
                if logout {
                    remove_secret(&session_path(&store), &store.account_protected_cache.session).unwrap();
                } else {
                    let mut next = session.clone();
                    next.session_token = format!("zds_{}", "N".repeat(43));
                    write_server_verified_secret(&session_path(&store), &next, &store.account_protected_cache.session).unwrap();
                }
            }, fail));
        }
    }
}

#[test]
fn every_session_attribute_and_expiry_is_revalidated() {
    for kind in 0..8 {
        let (_temporary, store, session) = fixture("owner");
        changed(read_with_change(&store, || {
            let mut next = session.clone();
            match kind {
                0 => next.role = "read_only".into(),
                1 => next.organization_id = format!("org_{}", Uuid::new_v4()),
                2 => next.organization_name = "Renamed synthetic company".into(),
                3 => next.connected_at = (Utc::now() + chrono::Duration::seconds(1)).to_rfc3339(),
                4 => next.session_expires_at = (Utc::now() + chrono::Duration::hours(2)).to_rfc3339(),
                5 => next.session_expires_at = (Utc::now() - chrono::Duration::seconds(1)).to_rfc3339(),
                6 => next.installation_id = Uuid::new_v4().to_string(),
                _ => next.version = 99,
            }
            write_server_verified_secret(&session_path(&store), &next, &store.account_protected_cache.session).unwrap();
        }, false));
    }
}

#[test]
fn pending_exchange_and_rotated_protected_references_reject_old_responses() {
    for fail in [false, true] {
        for kind in 0..3 {
            let (_temporary, store, session) = fixture("owner");
            changed(read_with_change(&store, || {
                match kind {
                    0 => write_server_verified_secret(&pending_path(&store), &PendingAuthorization {
                        version: SECRET_VERSION,
                        installation_id: store.installation_id.clone(),
                        device_code: format!("zdv_{}", "P".repeat(43)),
                        user_code: "ABCD-EFGH".into(),
                        verification_uri: "https://zentraapp.ch/appareil?code=ABCD-EFGH".into(),
                        expires_at: (Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
                        interval_seconds: 3,
                    }, &store.account_protected_cache.pending).unwrap(),
                    1 => write_server_verified_secret(&exchange_path(&store), &PendingExchange {
                        version: SECRET_VERSION,
                        installation_id: store.installation_id.clone(),
                        session: session.clone(),
                        license_token: "synthetic-not-an-actual-license".repeat(8),
                    }, &store.account_protected_cache.exchange).unwrap(),
                    _ => {
                        let reference = optional_account_reference(&session_path(&store)).unwrap();
                        // macOS preserves its Keychain marker on an ordinary
                        // rewrite. Remove and recreate the protected reference
                        // to exercise a real rotation on every supported OS.
                        remove_secret(&session_path(&store), &store.account_protected_cache.session).unwrap();
                        write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
                        assert_ne!(optional_account_reference(&session_path(&store)).unwrap(), reference);
                    }
                }
            }, fail));
        }
    }
}

#[test]
fn same_company_real_backup_restore_rejects_late_success_and_failure() {
    for fail in [false, true] {
        let (_temporary, store, session) = fixture("owner");
        let backup = store.create_backup(None, "inbox-read-test").unwrap();
        let scope = crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();
        let before = refs(&store);
        changed(read_with_change(&store, || {
            store.restore_backup(&backup, "inbox-read-test").unwrap();
            assert_eq!(crate::company_collaboration::status(&store).unwrap()["organizationId"], session.organization_id);
            assert_ne!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(), scope);
            assert_eq!(refs(&store), before);
        }, fail));
    }
}

#[test]
fn private_workspace_and_binding_changes_do_not_admit_the_old_receipt() {
    for kind in 0..2 {
        let (_temporary, store, session) = fixture("owner");
        changed(read_with_change(&store, || {
            if kind == 0 {
                let db = store.connect().unwrap();
                for _ in 0..2 {
                    db.execute("UPDATE company_local_notes_scope SET scope=? WHERE id=1", [Uuid::new_v4().to_string()]).unwrap();
                }
            } else {
                let path = store.data_dir.join("company-collaboration.json");
                let mut prefs: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                prefs["organization_id"] = json!(format!("org_{}", Uuid::new_v4()));
                fs::write(path, serde_json::to_vec(&prefs).unwrap()).unwrap();
                assert_ne!(crate::company_collaboration::status(&store).unwrap()["organizationId"], session.organization_id);
            }
        }, false));
    }
}

#[test]
fn invalid_initial_scope_or_session_never_starts_the_request() {
    for kind in 0..3 {
        let (_temporary, store, session) = fixture("owner");
        match kind {
            0 => remove_secret(&session_path(&store), &store.account_protected_cache.session).unwrap(),
            1 => {
                let mut expired = session.clone();
                expired.session_expires_at = (Utc::now() - chrono::Duration::seconds(1)).to_rfc3339();
                write_server_verified_secret(&session_path(&store), &expired, &store.account_protected_cache.session).unwrap();
            }
            _ => fs::remove_file(store.data_dir.join("company-collaboration.json")).unwrap(),
        }
        let count = Cell::new(0);
        let result = tauri::async_runtime::block_on(bound_inbox_get_with(&store, |_| async {
            count.set(count.get() + 1);
            reply()
        }));
        assert!(result.is_err());
        assert_eq!(count.get(), 0);
    }
}
