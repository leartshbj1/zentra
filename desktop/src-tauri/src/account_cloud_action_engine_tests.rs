//! Actual private consumer helpers, protected account files and LocalStore.
//! HTTP futures and the work-round execution port are synthetic. Work-round
//! tests never assert a remote confirmation or a canonical native ACK. The
//! licence is genuinely signed by the
//! public test authority; these tests grant no production or server admission.
//! Written for native CI, not executed locally while AppControl blocks Cargo.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration as ChronoDuration, Local};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::future::{join, AbortHandle, Abortable};
use std::{
    cell::Cell,
    sync::{atomic::AtomicBool, mpsc},
    thread,
    time::Duration as StdDuration,
};
use tauri::async_runtime::channel;

struct Fixture {
    _directory: tempfile::TempDir,
    store: LocalStore,
    session: CloudSession,
    member: String,
    license_token: String,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let mut store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    let signing = SigningKey::from_bytes(&[31; 32]);
    store.configure_test_license_key(signing.verifying_key().to_bytes());
    store
        .complete_onboarding(crate::tests::test_onboarding(), "action-consumer-test")
        .unwrap();
    let now = Utc::now();
    let today = Local::now().date_naive();
    let payload = crate::models::LicenseTokenPayload {
        token_version: 2,
        license_id: Uuid::new_v4().to_string(),
        installation_id: store.installation_id.clone(),
        jti: Uuid::new_v4().to_string(),
        kid: "hc-prod-v1".into(),
        customer_name: Some("Synthetic Action Engine company".into()),
        access_role: "owner".into(),
        account_user_id: None,
        account_session_id: None,
        plan: crate::license::LICENSE_PLAN.into(),
        price_chf_cents: crate::license::LICENSE_PRICE_CHF_CENTS,
        issued_at: now.to_rfc3339(),
        valid_from: (today - ChronoDuration::days(1))
            .format("%Y-%m-%d")
            .to_string(),
        valid_until: (today + ChronoDuration::days(30))
            .format("%Y-%m-%d")
            .to_string(),
    };
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
    let license_token = format!(
        "{encoded}.{}",
        URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes())
    );
    let installed = store.install_server_issued_license(&license_token).unwrap();
    assert_eq!(installed["status"], "valid");
    assert_eq!(installed["read_only"], false);
    store.require_write_access().unwrap();
    store.clone().require_write_access().unwrap();
    let session = CloudSession {
        version: SECRET_VERSION,
        installation_id: store.installation_id.clone(),
        session_token: format!("zds_{}", "A".repeat(43)),
        session_expires_at: (now + ChronoDuration::days(1)).to_rfc3339(),
        organization_id: format!("org_{}", Uuid::new_v4()),
        organization_name: "Synthetic Action Engine company".into(),
        role: "owner".into(),
        connected_at: now.to_rfc3339(),
    };
    write_server_verified_secret(
        &session_path(&store),
        &session,
        &store.account_protected_cache.session,
    )
    .unwrap();
    let member = Uuid::new_v4().to_string();
    crate::company_collaboration::set_identity(
        &store,
        &session.organization_id,
        &member,
        "Synthetic owner",
        "owner",
    )
    .unwrap();
    // The real first-company account binding supplies the local consent/link.
    // No fabricated preference file or bypass of automation::bound is used.
    bind_new_company_to_account(&store).unwrap();
    crate::automation::bound(&store, &session.organization_id).unwrap();
    Fixture {
        _directory: directory,
        store,
        session,
        member,
        license_token,
    }
}

fn selected() -> QuoteExecutionSelection {
    QuoteExecutionSelection {
        source_id: "synthetic-source".into(),
        proposal_id: "synthetic-proposal".into(),
    }
}

fn request_body() -> Vec<u8> {
    protocol::reserve_request(&selected()).unwrap()
}

fn captured(store: &LocalStore) -> ActionStamp {
    tauri::async_runtime::block_on(capture(store)).unwrap()
}

fn references(store: &LocalStore) -> [Option<Vec<u8>>; 3] {
    [
        session_path(store),
        pending_path(store),
        exchange_path(store),
    ]
    .each_ref()
    .map(|path| optional_account_reference(path).unwrap())
}

fn revisions(store: &LocalStore) -> [u64; 3] {
    [
        store
            .account_protected_cache
            .session
            .revision
            .load(Ordering::Relaxed),
        store
            .account_protected_cache
            .pending
            .revision
            .load(Ordering::Relaxed),
        store
            .account_protected_cache
            .exchange
            .revision
            .load(Ordering::Relaxed),
    ]
}

fn assert_changed<T>(result: AppResult<T>) {
    match result {
        Err(AppError::Validation(message)) => assert_eq!(
            message,
            "Le compte ou l’entreprise a changé. Le devis reste dans son espace d’origine."
        ),
        _ => panic!("expected the fixed stale-action rejection"),
    }
}

fn late_change(
    store: &LocalStore,
    original: &ActionStamp,
    change: impl FnOnce(),
    network_error: bool,
) -> AppResult<Vec<u8>> {
    let calls = Cell::new(0);
    let result = tauri::async_runtime::block_on(exchange_with(
        store,
        original,
        request_body(),
        |_, _| async {
            calls.set(calls.get() + 1);
            let _account = store
                .account_protected_cache
                .operation_lock
                .try_lock()
                .expect("no account guard may cross the HTTP wait");
            change();
            if network_error {
                Err(AppError::Remote("synthetic obsolete failure".into()))
            } else {
                Ok((StatusCode::OK, b"synthetic original response".to_vec()))
            }
        },
    ));
    assert_eq!(calls.get(), 1, "no automatic retry or /me request");
    result
}

fn held_local_lock(store: &LocalStore) -> (mpsc::Sender<()>, thread::JoinHandle<bool>) {
    let owned = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _local = owned.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(StdDuration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(StdDuration::from_secs(5)).unwrap();
    (release_tx, holder)
}

#[test]
fn capture_records_real_bound_owner_and_reads_do_not_advance_private_generations() {
    let f = fixture();
    let before_refs = references(&f.store);
    let before_revisions = revisions(&f.store);
    let original = captured(&f.store);
    assert_eq!(original.user_id, f.member);
    assert_eq!(original.role, "owner");
    assert_eq!(original.installation_id, f.store.installation_id);
    assert_eq!(original.inbox.session, f.session);
    assert_eq!(
        original.member_nonce,
        crate::member_context::read(&f.store.connect().unwrap()).unwrap()
    );
    assert_eq!(
        original.inbox.workspace_scope,
        crate::work_notes::workspace_scope(&f.store.connect().unwrap()).unwrap()
    );
    tauri::async_runtime::block_on(check(&f.store, &original)).unwrap();
    assert!(captured(&f.store) == original);
    assert_eq!(references(&f.store), before_refs);
    assert_eq!(revisions(&f.store), before_revisions);
    assert_eq!(f.store.get_license_state().unwrap()["status"], "valid");
    f.store.require_write_access().unwrap();
}

#[test]
fn capture_refuses_absent_identity_unbound_expired_foreign_installation_and_read_only() {
    for fault in [
        "identity",
        "unbound",
        "expired",
        "installation",
        "role",
        "organization",
    ] {
        let f = fixture();
        match fault {
            "identity" => {
                f.store
                    .connect()
                    .unwrap()
                    .execute("DELETE FROM company_local_identity", [])
                    .unwrap();
            }
            "unbound" => {
                fs::remove_file(f.store.data_dir.join("company-collaboration.json")).unwrap();
            }
            "expired" | "installation" | "role" => {
                let mut session = f.session.clone();
                if fault == "expired" {
                    session.session_expires_at =
                        (Utc::now() - ChronoDuration::seconds(1)).to_rfc3339();
                } else if fault == "installation" {
                    session.installation_id = Uuid::new_v4().to_string();
                } else {
                    session.role = "read_only".into();
                    crate::company_collaboration::set_identity(
                        &f.store,
                        &session.organization_id,
                        &f.member,
                        "Synthetic owner",
                        "read_only",
                    )
                    .unwrap();
                }
                write_server_verified_secret(
                    &session_path(&f.store),
                    &session,
                    &f.store.account_protected_cache.session,
                )
                .unwrap();
            }
            "organization" => {
                crate::company_collaboration::set_identity(
                    &f.store,
                    &format!("org_{}", Uuid::new_v4()),
                    &f.member,
                    "Synthetic owner",
                    "owner",
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            tauri::async_runtime::block_on(capture(&f.store)).is_err(),
            "{fault}"
        );
    }
}

#[test]
fn capture_and_validation_yield_the_executor_while_workers_retain_account_guard() {
    let f = fixture();
    let (release, holder) = held_local_lock(&f.store);
    let (result, ()) = tauri::async_runtime::block_on(join(capture(&f.store), async {
        assert!(f
            .store
            .account_protected_cache
            .operation_lock
            .try_lock()
            .is_none());
        release.send(()).unwrap();
    }));
    assert!(
        holder.join().unwrap(),
        "capture must not block its releasing executor"
    );
    let original = result.unwrap();
    let (release, holder) = held_local_lock(&f.store);
    let (result, ()) = tauri::async_runtime::block_on(join(check(&f.store, &original), async {
        assert!(f
            .store
            .account_protected_cache
            .operation_lock
            .try_lock()
            .is_none());
        release.send(()).unwrap();
    }));
    assert!(
        holder.join().unwrap(),
        "validation must run off the releasing executor"
    );
    result.unwrap();
    assert!(f
        .store
        .account_protected_cache
        .operation_lock
        .try_lock()
        .is_some());
}

#[test]
fn a_pending_exchange_leaves_account_and_local_work_available_until_its_reply() {
    let f = fixture();
    let original = captured(&f.store);
    let before_refs = references(&f.store);
    let before_revisions = revisions(&f.store);
    let (started_tx, mut started_rx) = channel(1);
    let (reply_tx, mut reply_rx) = channel(1);
    let (result, ()) = tauri::async_runtime::block_on(join(
        exchange_with(
            &f.store,
            &original,
            request_body(),
            |outgoing, body| async move {
                assert_eq!(outgoing, f.session);
                assert_eq!(body, request_body());
                started_tx.send(()).await.unwrap();
                reply_rx.recv().await.unwrap()
            },
        ),
        async {
            started_rx.recv().await.unwrap();
            {
                let _account = f
                    .store
                    .account_protected_cache
                    .operation_lock
                    .try_lock()
                    .expect("HTTP must not block account changes");
                let _local = f.store.lock().unwrap();
                f.store.require_write_access().unwrap();
                f.store
                    .connect()
                    .unwrap()
                    .execute(
                        "UPDATE settings SET company_name='Synthetic concurrent work' WHERE id=1",
                        [],
                    )
                    .unwrap();
            }
            reply_tx
                .send(Ok((
                    StatusCode::OK,
                    b"synthetic reserved response".to_vec(),
                )))
                .await
                .unwrap();
        },
    ));
    assert_eq!(result.unwrap(), b"synthetic reserved response");
    assert_eq!(references(&f.store), before_refs);
    assert_eq!(revisions(&f.store), before_revisions);
    assert_eq!(
        f.store
            .connect()
            .unwrap()
            .query_row::<String, _, _>("SELECT company_name FROM settings WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap(),
        "Synthetic concurrent work"
    );
    f.store.require_write_access().unwrap();
}

#[test]
fn same_reference_secret_aba_on_a_clone_rejects_success_and_network_failure() {
    for network_error in [false, true] {
        for kind in 0..3 {
            let f = fixture();
            let cloned = f.store.clone();
            let pending = PendingAuthorization {
                version: SECRET_VERSION,
                installation_id: f.store.installation_id.clone(),
                device_code: format!("zdv_{}", "P".repeat(43)),
                user_code: "ABCD-EFGH".into(),
                verification_uri: "https://zentraapp.ch/appareil?code=ABCD-EFGH".into(),
                expires_at: (Utc::now() + ChronoDuration::minutes(5)).to_rfc3339(),
                interval_seconds: 3,
            };
            validate_pending_for_installation(&pending, &f.store.installation_id).unwrap();
            let exchange = PendingExchange {
                version: SECRET_VERSION,
                installation_id: f.store.installation_id.clone(),
                session: f.session.clone(),
                license_token: f.license_token.clone(),
            };
            validate_exchange_for_installation(&exchange, &f.store.installation_id).unwrap();
            let (path, cache, value) = match kind {
                0 => (
                    session_path(&f.store),
                    &cloned.account_protected_cache.session,
                    serde_json::to_value(&f.session).unwrap(),
                ),
                1 => (
                    pending_path(&f.store),
                    &cloned.account_protected_cache.pending,
                    serde_json::to_value(&pending).unwrap(),
                ),
                _ => (
                    exchange_path(&f.store),
                    &cloned.account_protected_cache.exchange,
                    serde_json::to_value(&exchange).unwrap(),
                ),
            };
            write_server_verified_secret(&path, &value, cache).unwrap();
            let original = captured(&f.store);
            let initial_bytes = fs::read(&path).unwrap();
            let before_refs = references(&f.store);
            let before_revisions = revisions(&f.store);
            assert_changed(late_change(
                &f.store,
                &original,
                || {
                    let mut intermediate = value.clone();
                    match kind {
                        0 => {
                            intermediate["session_token"] = json!(format!("zds_{}", "N".repeat(43)))
                        }
                        1 => intermediate["device_code"] = json!(format!("zdv_{}", "Q".repeat(43))),
                        _ => {
                            intermediate["session"]["session_token"] =
                                json!(format!("zds_{}", "N".repeat(43)))
                        }
                    }
                    write_server_verified_secret(&path, &intermediate, cache).unwrap();
                    write_server_verified_secret(&path, &value, cache).unwrap();
                    // Model Keychain retaining an identical opaque reference. The
                    // controlled write revisions, not random encryption, fence ABA.
                    fs::write(&path, &initial_bytes).unwrap();
                    assert_eq!(references(&f.store), before_refs);
                    assert_ne!(revisions(&f.store), before_revisions);
                },
                network_error,
            ));
            assert_eq!(read_session_secret(&f.store).unwrap(), Some(f.session));
            f.store.require_write_access().unwrap();
        }
    }
}

#[test]
fn external_pending_reference_removal_rejects_without_a_process_revision_change() {
    for network_error in [false, true] {
        let f = fixture();
        let pending = PendingAuthorization {
            version: SECRET_VERSION,
            installation_id: f.store.installation_id.clone(),
            device_code: format!("zdv_{}", "P".repeat(43)),
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://zentraapp.ch/appareil?code=ABCD-EFGH".into(),
            expires_at: (Utc::now() + ChronoDuration::minutes(5)).to_rfc3339(),
            interval_seconds: 3,
        };
        validate_pending_for_installation(&pending, &f.store.installation_id).unwrap();
        write_server_verified_secret(
            &pending_path(&f.store),
            &pending,
            &f.store.account_protected_cache.pending,
        )
        .unwrap();
        let original = captured(&f.store);
        let before = revisions(&f.store);
        assert_changed(late_change(
            &f.store,
            &original,
            || {
                // A second process need not share the in-memory revision. Its
                // protected marker removal must still invalidate the response.
                fs::remove_file(pending_path(&f.store)).unwrap();
                assert_eq!(revisions(&f.store), before);
                assert_eq!(
                    read_session_secret(&f.store).unwrap(),
                    Some(f.session.clone())
                );
            },
            network_error,
        ));
    }
}

#[test]
fn logout_login_and_member_aba_do_not_restore_an_original_execution_stamp() {
    for network_error in [false, true] {
        for logout in [false, true] {
            let f = fixture();
            let original = captured(&f.store);
            assert_changed(late_change(
                &f.store,
                &original,
                || {
                    if logout {
                        remove_secret(
                            &session_path(&f.store),
                            &f.store.account_protected_cache.session,
                        )
                        .unwrap();
                        write_server_verified_secret(
                            &session_path(&f.store),
                            &f.session,
                            &f.store.account_protected_cache.session,
                        )
                        .unwrap();
                    } else {
                        crate::company_collaboration::set_identity(
                            &f.store,
                            &f.session.organization_id,
                            &Uuid::new_v4().to_string(),
                            "Synthetic other owner",
                            "owner",
                        )
                        .unwrap();
                        crate::company_collaboration::set_identity(
                            &f.store,
                            &f.session.organization_id,
                            &f.member,
                            "Synthetic owner",
                            "owner",
                        )
                        .unwrap();
                        assert_ne!(
                            crate::member_context::read(&f.store.connect().unwrap()).unwrap(),
                            original.member_nonce
                        );
                    }
                },
                network_error,
            ));
            assert_eq!(read_session_secret(&f.store).unwrap(), Some(f.session));
            assert_eq!(
                f.store
                    .connect()
                    .unwrap()
                    .query_row::<String, _, _>(
                        "SELECT user_id FROM company_local_identity WHERE id=1",
                        [],
                        |row| row.get(0)
                    )
                    .unwrap(),
                f.member
            );
        }
    }
}

#[test]
fn changed_user_organization_or_role_rejects_late_success_and_late_failure() {
    for network_error in [false, true] {
        for fault in ["user", "organization", "role"] {
            let f = fixture();
            let original = captured(&f.store);
            assert_changed(late_change(
                &f.store,
                &original,
                || {
                    let organization = if fault == "organization" {
                        format!("org_{}", Uuid::new_v4())
                    } else {
                        f.session.organization_id.clone()
                    };
                    let user = if fault == "user" {
                        Uuid::new_v4().to_string()
                    } else {
                        f.member.clone()
                    };
                    let role = if fault == "role" {
                        "read_only"
                    } else {
                        "owner"
                    };
                    crate::company_collaboration::set_identity(
                        &f.store,
                        &organization,
                        &user,
                        "Synthetic changed owner",
                        role,
                    )
                    .unwrap();
                },
                network_error,
            ));
        }
    }
}

#[test]
fn rotated_workspace_or_member_nonce_rejects_both_response_and_failure_without_new_writes() {
    for network_error in [false, true] {
        for workspace in [false, true] {
            let f = fixture();
            let original = captured(&f.store);
            assert_changed(late_change(
                &f.store,
                &original,
                || {
                    let _local = f.store.lock().unwrap();
                    let db = f.store.connect().unwrap();
                    if workspace {
                        db.execute(
                            "UPDATE company_local_notes_scope SET scope=? WHERE id=1",
                            [Uuid::new_v4().to_string()],
                        )
                        .unwrap();
                    } else {
                        crate::member_context::rotate(&db).unwrap();
                    }
                },
                network_error,
            ));
            assert_eq!(
                f.store
                    .connect()
                    .unwrap()
                    .query_row::<i64, _, _>("SELECT COUNT(*) FROM quotes", [], |row| row.get(0))
                    .unwrap(),
                0
            );
            assert_eq!(read_session_secret(&f.store).unwrap(), Some(f.session));
        }
    }
}

#[test]
fn a_stale_stamp_is_rejected_before_transport_or_local_effect_is_invoked() {
    let f = fixture();
    let original = captured(&f.store);
    crate::member_context::rotate(&f.store.connect().unwrap()).unwrap();
    assert_changed(tauri::async_runtime::block_on(exchange_with(
        &f.store,
        &original,
        request_body(),
        |_, _| async { panic!("stale capture must not send HTTP") },
    )));
    let called = Arc::new(AtomicBool::new(false));
    let operation_called = called.clone();
    assert_changed(tauri::async_runtime::block_on(local_effect(
        &f.store,
        &original,
        move |_, _| {
            operation_called.store(true, Ordering::SeqCst);
            Ok(())
        },
    )));
    assert!(!called.load(Ordering::SeqCst));
}

#[test]
fn unchanged_exchange_preserves_outage_and_bounds_status_errors_without_showing_remote_body() {
    let f = fixture();
    let original = captured(&f.store);
    let outage = tauri::async_runtime::block_on(exchange_with(
        &f.store,
        &original,
        request_body(),
        |_, _| async { Err(AppError::Remote("synthetic original outage".into())) },
    ));
    assert!(
        matches!(outage, Err(AppError::Remote(message)) if message == "synthetic original outage")
    );
    for status in [
        StatusCode::UNAUTHORIZED,
        StatusCode::PAYMENT_REQUIRED,
        StatusCode::FORBIDDEN,
        StatusCode::CONFLICT,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        let result = tauri::async_runtime::block_on(exchange_with(
            &f.store,
            &original,
            request_body(),
            |_, _| async move {
                Ok((
                    status,
                    br#"{"error":"private remote body must not be shown"}"#.to_vec(),
                ))
            },
        ));
        if matches!(status.as_u16(), 401 | 402 | 403) {
            assert_changed(result);
        } else {
            let error = result.unwrap_err();
            assert!(!error.to_string().contains("private remote body"));
            assert_eq!(
                matches!(error, AppError::Remote(_)),
                status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS
            );
        }
    }
    let oversized = tauri::async_runtime::block_on(exchange_with(
        &f.store,
        &original,
        request_body(),
        |_, _| async { Ok((StatusCode::OK, vec![b' '; protocol::MAX_RESPONSE_BYTES + 1])) },
    ));
    assert!(oversized.is_err());
    assert_eq!(read_session_secret(&f.store).unwrap(), Some(f.session));
    f.store.require_write_access().unwrap();
}

#[test]
fn cancelling_local_effect_wait_keeps_account_guard_in_the_detached_real_worker() {
    let f = fixture();
    let original = captured(&f.store);
    let expected_user = original.user_id.clone();
    let (started_tx, mut started_rx) = channel(1);
    let (finished_tx, mut finished_rx) = channel(1);
    let (release_tx, release_rx) = mpsc::channel();
    let (abort, registration) = AbortHandle::new_pair();
    tauri::async_runtime::block_on(async {
        let (cancelled, ()) = join(
            Abortable::new(local_effect(&f.store, &original, move |store, stamp| {
                assert!(store.account_protected_cache.operation_lock.try_lock().is_none());
                let _local = store.lock()?;
                store.require_write_access()?;
                assert_eq!(stamp.user_id, expected_user);
                started_tx.try_send(()).unwrap();
                release_rx.recv_timeout(StdDuration::from_secs(5)).expect("cancelled caller must release its still-running worker");
                store.connect()?.execute("UPDATE settings SET company_name='Synthetic completed detached effect' WHERE id=1", [])?;
                finished_tx.try_send(()).unwrap();
                Ok(())
            }), registration),
            async {
                started_rx.recv().await.unwrap();
                abort.abort();
            },
        ).await;
        assert!(
            cancelled.is_err(),
            "the awaited future must actually be dropped before probing the guard"
        );
        assert!(
            f.store
                .account_protected_cache
                .operation_lock
                .try_lock()
                .is_none(),
            "cancelling the caller must not unlock an ongoing local effect"
        );
        assert!(finished_rx.try_recv().is_err());
        release_tx.send(()).unwrap();
        finished_rx.recv().await.unwrap();
        // Wait through the final worker drop rather than asserting a racy
        // try_lock immediately after its pre-return finished signal.
        check(&f.store, &original).await.unwrap();
    });
    assert!(f
        .store
        .account_protected_cache
        .operation_lock
        .try_lock()
        .is_some());
    assert_eq!(
        f.store
            .connect()
            .unwrap()
            .query_row::<String, _, _>("SELECT company_name FROM settings WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap(),
        "Synthetic completed detached effect"
    );
    f.store.require_write_access().unwrap();
}

#[test]
fn waiting_local_effect_revalidates_context_after_acquiring_account_guard() {
    let f = fixture();
    let original = captured(&f.store);
    let called = Arc::new(AtomicBool::new(false));
    let operation_called = called.clone();
    let account = f
        .store
        .account_protected_cache
        .operation_lock
        .try_lock()
        .unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(
        local_effect(&f.store, &original, move |_, _| {
            operation_called.store(true, Ordering::SeqCst);
            Ok(())
        }),
        async {
            {
                let _local = f.store.lock().unwrap();
                crate::member_context::rotate(&f.store.connect().unwrap()).unwrap();
            }
            drop(account);
        },
    ));
    assert_changed(result);
    assert!(!called.load(Ordering::SeqCst));
    assert!(f
        .store
        .account_protected_cache
        .operation_lock
        .try_lock()
        .is_some());
}

#[test]
fn private_execution_future_is_send_without_being_polled_or_starting_transport() {
    fn require_send<T: Send>(_: T) {}
    let f = fixture();
    let before_refs = references(&f.store);
    let before_revisions = revisions(&f.store);
    // This generic bound is checked when native CI compiles the real consumer.
    // Dropping its unpolled future cannot start HTTPS or a publication phase.
    require_send(execute_quote_draft(&f.store, selected()));
    assert_eq!(references(&f.store), before_refs);
    assert_eq!(revisions(&f.store), before_revisions);
    assert_eq!(
        f.store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM quotes", [], |row| row.get(0))
            .unwrap(),
        0
    );
}

fn work_discovered(sources: &[String], cursor: Option<&str>) -> AppResult<(StatusCode, Vec<u8>)> {
    Ok((
        StatusCode::OK,
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion":1,"state":"discovered","sourceIds":sources,"nextCursor":cursor
        }))
        .unwrap(),
    ))
}

fn work_prepared(source: &str, ready: bool) -> AppResult<(StatusCode, Vec<u8>)> {
    Ok((StatusCode::OK, serde_json::to_vec(&serde_json::json!({
        "schemaVersion":1,"state":"prepared","sourceId":source,"proposalId":format!("proposal-{source}"),
        "fingerprint":"a".repeat(64),"disposition":if ready {"ready"} else {"needs_review"},
        "reasons":if ready {vec![]} else {vec!["missing_article"]},"requiresHumanValidation":true
    })).unwrap()))
}

fn work_operation(body: &[u8]) -> serde_json::Value {
    serde_json::from_slice(body).unwrap()
}

// Use the ACTUAL writer to create a genuine local recovery intention. Its plan
// is a private synthetic fixture, not a server reservation/admission/proof.
fn work_local_draft(f: &Fixture) -> crate::action_engine_quote::ActionEngineQuoteInput {
    use crate::action_engine_quote::{ActionEngineQuoteInput, ActionEngineQuoteSource};
    use crate::action_engine_resources::{article_revision, export_resources, resource_hash};
    use sha2::{Digest, Sha256};
    let article = Uuid::new_v4().to_string();
    let db = f.store.connect().unwrap();
    db.execute("UPDATE settings SET vat_registered=1,default_vat_bp=810,updated_at='2026-10-11T00:00:00Z' WHERE id=1", []).unwrap();
    db.execute("INSERT INTO catalog_items(id,kind,sku,name,description,unit,sales_price_cents,vat_bp,created_at,updated_at)
        VALUES(?,'product','SYNTHETIC','Radiateur','radiateurs','pièce',19900,810,'2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')", [&article]).unwrap();
    let resources = export_resources(&db).unwrap();
    let original = captured(&f.store);
    let plan = serde_json::json!({
        "schemaVersion":1,"engineVersion":"action-engine-quote-v1","kind":"prepare_quote_draft",
        "organizationId":f.session.organization_id,"contextRevision":"synthetic-round-v1",
        "sourceId":"synthetic-local-source","sourceRevision":"mail-v1","status":"ready","reasons":[],
        "customer":{"kind":"new","name":"Camille Exemple","email":"camille@example.ch"},
        "title":"Devis radiateurs","currency":"CHF",
        "lines":[{"articleId":article,"articleRevision":article_revision(&resources.articles[0]),
            "description":"Radiateur","unit":"pièce","quantityMilli":3000,
            "unitPriceCents":19900,"taxRateBp":810,"netCents":59700,"evidence":"3 radiateurs"}],
        "netCents":59700,"confidence":0.99,"requiresHumanValidation":true
    });
    let canonical_plan_json = serde_json::to_string(&plan).unwrap();
    let input = ActionEngineQuoteInput {
        fingerprint: format!("{:x}", Sha256::digest(canonical_plan_json.as_bytes())),
        canonical_plan_json,
        proposal_id: Uuid::new_v4().to_string(),
        reservation_id: Uuid::new_v4().to_string(),
        source: ActionEngineQuoteSource {
            id: "synthetic-local-source".into(),
            revision: "mail-v1".into(),
            organization_id: f.session.organization_id.clone(),
            sender_email: "camille@example.ch".into(),
            sender_name: "Camille Exemple".into(),
            subject: "Devis radiateurs".into(),
            body: "3 radiateurs".into(),
        },
        actor: ActionEngineQuoteActor {
            organization_id: f.session.organization_id.clone(),
            user_id: f.member.clone(),
        },
        installation_id: f.store.installation_id.clone(),
        expected_workspace_scope: original.inbox.workspace_scope,
        expected_member_context_nonce: original.member_nonce,
        expected_resources_hash: resource_hash(&resources),
        expected_context_revision: "synthetic-round-v1".into(),
        customer_id: Uuid::new_v4().to_string(),
        quote_id: Uuid::new_v4().to_string(),
    };
    drop(db);
    f.store
        .commit_action_engine_quote_draft(input.clone())
        .unwrap();
    input
}

#[test]
fn work_round_empty_completion_is_memory_only_and_refuses_another_advance() {
    let f = fixture();
    let before_refs = references(&f.store);
    let before_revisions = revisions(&f.store);
    let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
    let result = tauri::async_runtime::block_on(advance_quote_work_round_with(&f.store, &mut round,
        |identity, body| { assert_eq!(identity,f.session); assert_eq!(work_operation(&body),serde_json::json!({"schemaVersion":1,"operation":"discover","limit":20,"cursor":null}));
            async {work_discovered(&[],None)} },
        |_,_,_| async {panic!("empty discovery cannot execute")})).unwrap();
    assert_eq!(
        result,
        QuoteWorkBatchOutcome::Page {
            confirmed: 0,
            held: 0,
            review_required: 0,
            round_complete: true
        }
    );
    assert!(round.complete && round.cursor.is_none() && round.seen_sources.is_empty());
    assert!(
        tauri::async_runtime::block_on(advance_quote_work_round_with(
            &f.store,
            &mut round,
            |_, _| async { panic!("completed round cannot send HTTP") },
            |_, _, _| async { panic!("completed round cannot execute") }
        ))
        .is_err()
    );
    assert_eq!(references(&f.store), before_refs);
    assert_eq!(revisions(&f.store), before_revisions);
}

#[test]
fn work_round_review_summary_never_reserves_or_executes_a_quote() {
    let f = fixture();
    let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
    let calls = Cell::new(0);
    let result = tauri::async_runtime::block_on(advance_quote_work_round_with(
        &f.store,
        &mut round,
        |_, body| {
            calls.set(calls.get() + 1);
            let request = work_operation(&body);
            async move {
                if request["operation"] == "discover" {
                    work_discovered(&["needs-review".into()], None)
                } else {
                    assert_eq!(request["sourceId"], "needs-review");
                    work_prepared("needs-review", false)
                }
            }
        },
        |_, _, _| async { panic!("needs_review must never reserve or write") },
    ))
    .unwrap();
    assert_eq!(calls.get(), 2);
    assert_eq!(
        result,
        QuoteWorkBatchOutcome::Page {
            confirmed: 0,
            held: 0,
            review_required: 1,
            round_complete: true
        }
    );
    assert!(round.seen_sources.contains("needs-review"));
    assert_eq!(
        f.store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM quotes", [], |row| row.get(0))
            .unwrap(),
        0
    );
}

#[test]
fn work_round_ready_forwards_same_origin_selectors_and_digest_without_claiming_confirmation() {
    let f = fixture();
    let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
    let original = round.original.clone();
    let calls = Cell::new(0);
    let result = tauri::async_runtime::block_on(advance_quote_work_round_with(
        &f.store,
        &mut round,
        |_, body| {
            let request = work_operation(&body);
            async move {
                if request["operation"] == "discover" {
                    work_discovered(&["ready".into()], None)
                } else {
                    work_prepared("ready", true)
                }
            }
        },
        |stamp, selection, digest| {
            assert!(stamp == original);
            assert_eq!(selection.source_id, "ready");
            assert_eq!(selection.proposal_id, "proposal-ready");
            assert_eq!(digest, "a".repeat(64));
            calls.set(calls.get() + 1);
            async { Ok(QuoteExecutionOutcome::Held) }
        },
    ))
    .unwrap();
    assert_eq!(calls.get(), 1);
    assert_eq!(
        result,
        QuoteWorkBatchOutcome::Page {
            confirmed: 0,
            held: 1,
            review_required: 0,
            round_complete: true
        }
    );
}

#[test]
fn work_round_advances_complete_pages_then_a_new_round_starts_without_a_watermark() {
    let f = fixture();
    let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
    for page in 0..2 {
        let expected_cursor = if page == 0 {
            None
        } else {
            Some("cursor_page_2")
        };
        let size = if page == 0 { 20 } else { 2 };
        let result = tauri::async_runtime::block_on(advance_quote_work_round_with(
            &f.store,
            &mut round,
            |_, body| {
                let request = work_operation(&body);
                async move {
                    if request["operation"] == "discover" {
                        assert_eq!(request["cursor"], serde_json::json!(expected_cursor));
                        work_discovered(
                            &(0..size)
                                .map(|i| format!("page-{page}-{i}"))
                                .collect::<Vec<_>>(),
                            if page == 0 {
                                Some("cursor_page_2")
                            } else {
                                None
                            },
                        )
                    } else {
                        work_prepared(request["sourceId"].as_str().unwrap(), false)
                    }
                }
            },
            |_, _, _| async { panic!("review-only page cannot execute") },
        ))
        .unwrap();
        assert_eq!(
            result,
            QuoteWorkBatchOutcome::Page {
                confirmed: 0,
                held: 0,
                review_required: size,
                round_complete: page == 1
            }
        );
    }
    assert_eq!(round.seen_sources.len(), 22);
    assert_eq!(round.visited_cursors.len(), 1);
    let fresh = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
    assert!(fresh.cursor.is_none() && fresh.seen_sources.is_empty() && !fresh.complete);
}

#[test]
fn work_round_rejects_repeated_cursor_or_source_before_any_page_preparation() {
    for repeated_cursor in [false, true] {
        let f = fixture();
        let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
        tauri::async_runtime::block_on(advance_quote_work_round_with(
            &f.store,
            &mut round,
            |_, body| {
                let request = work_operation(&body);
                async move {
                    if request["operation"] == "discover" {
                        work_discovered(
                            &(0..20).map(|i| format!("source-{i}")).collect::<Vec<_>>(),
                            Some("page_two"),
                        )
                    } else {
                        work_prepared(request["sourceId"].as_str().unwrap(), false)
                    }
                }
            },
            |_, _, _| async { panic!("review-only page") },
        ))
        .unwrap();
        let calls = Cell::new(0);
        let result = tauri::async_runtime::block_on(advance_quote_work_round_with(
            &f.store,
            &mut round,
            |_, body| {
                calls.set(calls.get() + 1);
                assert_eq!(work_operation(&body)["operation"], "discover");
                async move {
                    if repeated_cursor {
                        work_discovered(
                            &(0..20).map(|i| format!("next-{i}")).collect::<Vec<_>>(),
                            Some("page_two"),
                        )
                    } else {
                        work_discovered(&["source-0".into()], None)
                    }
                }
            },
            |_, _, _| async { panic!("replayed page must fail before effects") },
        ));
        assert!(result.is_err());
        assert_eq!(calls.get(), 1);
        assert_eq!(round.cursor.as_deref(), Some("page_two"));
        assert_eq!(round.seen_sources.len(), 20);
        assert!(!round.complete);
    }
}

#[test]
fn work_round_refuses_account_change_during_preparation_on_success_and_failure() {
    for failure in [false, true] {
        let f = fixture();
        let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
        let result = tauri::async_runtime::block_on(advance_quote_work_round_with(
            &f.store,
            &mut round,
            |_, body| {
                let request = work_operation(&body);
                let f = &f;
                async move {
                    if request["operation"] == "discover" {
                        work_discovered(&["ready".into()], None)
                    } else {
                        crate::member_context::rotate(&f.store.connect().unwrap()).unwrap();
                        if failure {
                            Err(AppError::Remote("obsolete response".into()))
                        } else {
                            work_prepared("ready", true)
                        }
                    }
                }
            },
            |_, _, _| async { panic!("changed origin cannot execute") },
        ));
        assert_changed(result);
        assert!(!round.complete);
        assert!(round.seen_sources.is_empty() && round.cursor.is_none());
    }
}

#[test]
fn work_round_rechecks_original_after_executor_wait_before_interpreting_its_result() {
    for failure in [false, true] {
        let f = fixture();
        let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
        let result = tauri::async_runtime::block_on(advance_quote_work_round_with(
            &f.store,
            &mut round,
            |_, body| {
                let request = work_operation(&body);
                async move {
                    if request["operation"] == "discover" {
                        work_discovered(&["ready".into()], None)
                    } else {
                        work_prepared("ready", true)
                    }
                }
            },
            |_, _, _| async {
                crate::member_context::rotate(&f.store.connect().unwrap()).unwrap();
                if failure {
                    Err(AppError::Remote("obsolete execution failure".into()))
                } else {
                    Ok(QuoteExecutionOutcome::Held)
                }
            },
        ));
        assert_changed(result);
        assert!(!round.complete && round.cursor.is_none() && round.seen_sources.is_empty());
    }
}

#[test]
fn work_round_partial_page_failure_keeps_original_cursor_for_a_safe_retry() {
    let f = fixture();
    let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
    for retry in [false, true] {
        let calls = Cell::new(0);
        let result = tauri::async_runtime::block_on(advance_quote_work_round_with(
            &f.store,
            &mut round,
            |_, body| {
                calls.set(calls.get() + 1);
                let request = work_operation(&body);
                async move {
                    if request["operation"] == "discover" {
                        assert!(request["cursor"].is_null());
                        work_discovered(&["first".into(), "second".into()], None)
                    } else if request["sourceId"] == "second" && !retry {
                        Err(AppError::Remote("synthetic interrupted page".into()))
                    } else {
                        work_prepared(request["sourceId"].as_str().unwrap(), false)
                    }
                }
            },
            |_, _, _| async { panic!("review-only page") },
        ));
        assert_eq!(calls.get(), 3);
        if retry {
            assert_eq!(
                result.unwrap(),
                QuoteWorkBatchOutcome::Page {
                    confirmed: 0,
                    held: 0,
                    review_required: 2,
                    round_complete: true
                }
            );
        } else {
            assert!(matches!(result, Err(AppError::Remote(_))));
            assert!(!round.complete && round.cursor.is_none() && round.seen_sources.is_empty());
        }
    }
}

#[test]
fn work_round_real_pending_receipt_always_precedes_discovery_even_on_repeated_held_result() {
    let f = fixture();
    let input = work_local_draft(&f);
    let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
    for _ in 0..2 {
        let calls = Cell::new(0);
        let result = tauri::async_runtime::block_on(advance_quote_work_round_with(
            &f.store,
            &mut round,
            |_, _| async { panic!("pending real local receipt must prevent discovery/prepare") },
            |original, selection, fingerprint| {
                assert_eq!(original.user_id, f.member);
                assert_eq!(selection.source_id, input.source.id);
                assert_eq!(selection.proposal_id, input.proposal_id);
                assert_eq!(fingerprint, input.fingerprint);
                calls.set(calls.get() + 1);
                async { Ok(QuoteExecutionOutcome::Held) }
            },
        ))
        .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(
            result,
            QuoteWorkBatchOutcome::Recovery {
                confirmed: 0,
                still_pending: true,
                has_more: false
            }
        );
        assert!(!round.complete && round.cursor.is_none() && round.seen_sources.is_empty());
    }
    assert_eq!(
        f.store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM quotes", [], |row| row.get(0))
            .unwrap(),
        1
    );
}

#[test]
fn work_round_external_corruption_is_not_an_empty_queue_or_a_permission_to_discover() {
    let f = fixture();
    work_local_draft(&f);
    // Model corruption outside the SQL guards on this disposable test DB only.
    // The ordinary trigger correctly forbids changing an immutable payload.
    f.store
        .connect()
        .unwrap()
        .execute_batch("DROP TRIGGER action_engine_quote_outbox_update;")
        .unwrap();
    f.store
        .connect()
        .unwrap()
        .execute(
            "UPDATE company_local_action_engine_quote_outbox SET payload_sha256=?",
            ["0".repeat(64)],
        )
        .unwrap();
    let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
    assert!(
        tauri::async_runtime::block_on(advance_quote_work_round_with(
            &f.store,
            &mut round,
            |_, _| async { panic!("corruption cannot disappear into empty success") },
            |_, _, _| async { panic!("corrupt selection cannot execute") }
        ))
        .is_err()
    );
    assert!(!round.complete && round.cursor.is_none() && round.seen_sources.is_empty());
}

#[test]
fn work_round_cancelled_preparation_does_not_advance_the_continuation_or_execute() {
    let f = fixture();
    let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
    let (started_tx, mut started_rx) = channel(1);
    let (abort, registration) = AbortHandle::new_pair();
    let (result, ()) = tauri::async_runtime::block_on(join(
        Abortable::new(
            advance_quote_work_round_with(
                &f.store,
                &mut round,
                |_, body| {
                    let request = work_operation(&body);
                    let started = &started_tx;
                    async move {
                        if request["operation"] == "discover" {
                            work_discovered(&["ready".into()], None)
                        } else {
                            started.try_send(()).unwrap();
                            std::future::pending::<AppResult<(StatusCode, Vec<u8>)>>().await
                        }
                    }
                },
                |_, _, _| async { panic!("cancelled preparation cannot execute") },
            ),
            registration,
        ),
        async {
            started_rx.recv().await.unwrap();
            abort.abort();
        },
    ));
    assert!(result.is_err());
    assert!(!round.complete && round.cursor.is_none() && round.seen_sources.is_empty());
}

#[test]
fn work_round_invalid_summary_requires_review_without_effect_or_cursor_progress() {
    for fault in ["source", "human", "extra", "oversize"] {
        let f = fixture();
        let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
        let result = tauri::async_runtime::block_on(advance_quote_work_round_with(
            &f.store,
            &mut round,
            |_, body| {
                let request = work_operation(&body);
                async move {
                    if request["operation"] == "discover" {
                        work_discovered(&["ready".into()], None)
                    } else {
                        let (_, bytes) = work_prepared("ready", true)?;
                        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                        match fault {
                            "source" => value["sourceId"] = serde_json::json!("foreign-source"),
                            "human" => value["requiresHumanValidation"] = serde_json::json!(false),
                            "extra" => {
                                value["canonicalPlanJson"] = serde_json::json!("untrusted plan")
                            }
                            "oversize" => {
                                return Ok((
                                    StatusCode::OK,
                                    vec![b' '; protocol::MAX_WORK_RESPONSE_BYTES + 1],
                                ))
                            }
                            _ => unreachable!(),
                        }
                        Ok((StatusCode::OK, serde_json::to_vec(&value).unwrap()))
                    }
                }
            },
            |_, _, _| async { panic!("malformed summary cannot reserve/write") },
        ));
        assert!(result.is_err());
        assert!(!round.complete && round.cursor.is_none() && round.seen_sources.is_empty());
    }
}

#[test]
fn work_round_source_budget_rejects_new_page_before_preparation() {
    let f = fixture();
    let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
    round.seen_sources = (0..MAX_ROUND_SOURCES)
        .map(|i| format!("seen-{i}"))
        .collect();
    let result = tauri::async_runtime::block_on(advance_quote_work_round_with(
        &f.store,
        &mut round,
        |_, body| {
            assert_eq!(work_operation(&body)["operation"], "discover");
            async { work_discovered(&["new-source".into()], None) }
        },
        |_, _, _| async { panic!("bounded round must stop before preparation/execution") },
    ));
    assert!(result.is_err());
    assert_eq!(round.seen_sources.len(), MAX_ROUND_SOURCES);
    assert!(!round.complete);
}

#[test]
fn private_work_round_futures_are_send_without_polling_or_starting_transport() {
    fn require_send<T: Send>(_: T) {}
    let f = fixture();
    let before_refs = references(&f.store);
    let before_revisions = revisions(&f.store);
    require_send(begin_quote_work_round(&f.store));
    let mut round = tauri::async_runtime::block_on(begin_quote_work_round(&f.store)).unwrap();
    require_send(advance_quote_work_round(&f.store, &mut round));
    assert_eq!(references(&f.store), before_refs);
    assert_eq!(revisions(&f.store), before_revisions);
    assert_eq!(
        f.store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM quotes", [], |row| row.get(0))
            .unwrap(),
        0
    );
}
