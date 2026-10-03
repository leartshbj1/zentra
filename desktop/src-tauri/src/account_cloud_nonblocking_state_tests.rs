//! Real account-state response handlers, with a real signed test-authority
//! licence and LocalStore mutex. Requests return synthetic bytes; no network.
//! Prepared for native CI. These witnesses have not been compiled locally.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration as ChronoDuration, Local};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::future::join;
use std::{future::Future, sync::mpsc, thread, time::Duration};

// The same public test authority used by commands_import_worker_tests. A
// synthetic store trusts only this public key; no production key or licence is
// created, and installation/signature/clock/role/write checks remain real.
fn fixture() -> (tempfile::TempDir, LocalStore, CloudSession, String) {
    let temporary = tempfile::tempdir().unwrap();
    let mut store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    let signing = SigningKey::from_bytes(&[31; 32]);
    store.configure_test_license_key(signing.verifying_key().to_bytes());
    store.complete_onboarding(crate::tests::test_onboarding(), "account-state-worker-test").unwrap();
    let now = Utc::now();
    let today = Local::now().date_naive();
    let payload = crate::models::LicenseTokenPayload {
        token_version: 2,
        license_id: Uuid::new_v4().to_string(),
        installation_id: store.installation_id.clone(),
        jti: Uuid::new_v4().to_string(),
        kid: "hc-prod-v1".into(),
        customer_name: Some("Synthetic account-state company".into()),
        access_role: "owner".into(),
        account_user_id: None,
        account_session_id: None,
        plan: crate::license::LICENSE_PLAN.into(),
        price_chf_cents: crate::license::LICENSE_PRICE_CHF_CENTS,
        issued_at: now.to_rfc3339(),
        valid_from: (today - ChronoDuration::days(1)).format("%Y-%m-%d").to_string(),
        valid_until: (today + ChronoDuration::days(30)).format("%Y-%m-%d").to_string(),
    };
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
    let token = format!("{encoded}.{}", URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes()));
    let installed = store.install_server_issued_license(&token).unwrap();
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
        organization_name: "Synthetic account-state company".into(),
        role: "owner".into(),
        connected_at: now.to_rfc3339(),
    };
    write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
    let member = Uuid::new_v4().to_string();
    crate::company_collaboration::set_identity(&store, &session.organization_id, &member, "Alice", "owner").unwrap();
    (temporary, store, session, member)
}

fn nonce(store: &LocalStore) -> String {
    crate::member_context::read(&store.connect().unwrap()).unwrap()
}

fn draft_scope(store: &LocalStore) -> String {
    crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap()
}

fn license_identity(store: &LocalStore) -> (String, String) {
    store.connect().unwrap().query_row(
        "SELECT license_id,token_sha256 FROM license_state WHERE id=1", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap()
}

fn assert_access(store: &LocalStore, expected: &str, original: &(String, String)) {
    assert_eq!(license_identity(store), *original, "invalidation must not replace the installed token");
    let state = store.get_license_state().unwrap();
    assert_eq!(state["status"], expected);
    assert_eq!(state["read_only"], expected != "valid");
    assert_eq!(store.require_write_access().is_ok(), expected == "valid");
}

fn me(store: &LocalStore, session: &CloudSession, member: &str, name: &str, role: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "userId":member,"email":"synthetic@example.invalid","displayName":name,
        "installationId":store.installation_id,
        "organization":{"id":session.organization_id,"name":session.organization_name,"role":role},
        "entitlementValidUntil":(Utc::now() + ChronoDuration::days(30)).to_rfc3339(),
    })).unwrap()
}

// The connected cache reader and Ready synthetic request do not suspend before
// the relevant licence/identity worker. Thus join first polls the actual handler
// into its held-local-mutex wait. Its peer must still run on that same executor
// and find the account guard retained. An inline LocalStore.lock waits for the
// original five-second holder deadline and fails, rather than passing by delay.
fn responsive<T>(
    store: &LocalStore,
    command: impl Future<Output = AppResult<T>>,
    before_release: impl FnOnce(),
) -> AppResult<T> {
    let locked = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _local = locked.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(command, async {
        assert!(store.account_protected_cache.operation_lock.try_lock().is_none(),
            "the account guard must remain held while the local worker waits");
        before_release();
        let _ = release_tx.send(());
    }));
    assert!(holder.join().unwrap(), "the real account-state handler blocked its releasing executor");
    assert!(store.account_protected_cache.operation_lock.try_lock().is_some());
    result
}

#[test]
fn real_me_role_change_yields_while_revalidating_signed_licence_before_identity_rotation() {
    let (_temporary, store, session, member) = fixture();
    let original_nonce = nonce(&store);
    let scope = draft_scope(&store);
    let installed = license_identity(&store);
    let response = me(&store, &session, &member, "Alice", "accountant");
    let state = responsive(&store, cloud_account_state_with(&store, |_| async move {
        Ok((StatusCode::OK, response))
    }), || {
        assert_eq!(read_session_secret(&store).unwrap().unwrap().role, "owner");
        assert_eq!(nonce(&store), original_nonce);
        assert_eq!(license_identity(&store), installed);
    }).unwrap();
    assert_eq!(state.status, "connected");
    assert_eq!(state.role.as_deref(), Some("accountant"));
    assert_eq!(read_session_secret(&store).unwrap().unwrap().role, "accountant");
    assert_ne!(nonce(&store), original_nonce);
    assert_eq!(draft_scope(&store), scope);
    assert_eq!(store.connect().unwrap().query_row::<String, _, _>("SELECT role FROM company_local_identity", [], |row| row.get(0)).unwrap(), "accountant");
    assert_access(&store, "invalid", &installed);
}

#[test]
fn real_me_402_yields_and_marks_real_signed_licence_inactive_without_changing_member_context() {
    let (_temporary, store, session, _member) = fixture();
    let original_nonce = nonce(&store);
    let scope = draft_scope(&store);
    let installed = license_identity(&store);
    let state = responsive(&store, cloud_account_state_with(&store, |_| async {
        Ok((StatusCode::PAYMENT_REQUIRED, br#"{"error":"inactive"}"#.to_vec()))
    }), || assert_eq!(read_session_secret(&store).unwrap(), Some(session.clone()))).unwrap();
    assert_eq!(state.status, "inactive");
    assert_eq!(read_session_secret(&store).unwrap(), Some(session));
    assert_eq!(nonce(&store), original_nonce);
    assert_eq!(draft_scope(&store), scope);
    assert_access(&store, "inactive", &installed);
}

#[test]
fn real_account_state_expiry_yields_without_request_or_reviving_write_access() {
    let (_temporary, store, mut session, _member) = fixture();
    let original_nonce = nonce(&store);
    let scope = draft_scope(&store);
    let installed = license_identity(&store);
    session.session_expires_at = (Utc::now() - ChronoDuration::seconds(1)).to_rfc3339();
    write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
    let state = responsive(&store, cloud_account_state_with(&store, |_| async {
        panic!("expired session must not be sent to /me")
    }), || assert_eq!(read_session_secret(&store).unwrap(), Some(session.clone()))).unwrap();
    assert_eq!(state.status, "expired");
    assert_eq!(nonce(&store), original_nonce);
    assert_eq!(draft_scope(&store), scope);
    assert_access(&store, "invalid", &installed);
}

#[test]
fn real_cached_account_expiry_reader_yields_under_the_account_guard_and_keeps_drafts() {
    let (_temporary, store, mut session, _member) = fixture();
    let original_nonce = nonce(&store);
    let scope = draft_scope(&store);
    let installed = license_identity(&store);
    session.session_expires_at = (Utc::now() - ChronoDuration::seconds(1)).to_rfc3339();
    write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
    let state = responsive(&store, async {
        let _account = store.account_protected_cache.operation_lock.lock().await;
        cached_cloud_account_state_worker(&store).await
    }, || assert_eq!(nonce(&store), original_nonce)).unwrap();
    assert_eq!(state.status, "expired");
    assert_eq!(nonce(&store), original_nonce);
    assert_eq!(draft_scope(&store), scope);
    assert_access(&store, "invalid", &installed);
}

#[test]
fn real_late_me_fallback_yields_for_the_newer_expired_session_without_applying_old_402() {
    let (_temporary, store, session, _member) = fixture();
    let original_nonce = nonce(&store);
    let installed = license_identity(&store);
    let mut newer = session.clone();
    newer.session_token = format!("zds_{}", "C".repeat(43));
    newer.session_expires_at = (Utc::now() - ChronoDuration::seconds(1)).to_rfc3339();
    let state = responsive(&store, cloud_account_state_with(&store, |_| async {
        let _account = store.account_protected_cache.operation_lock.try_lock().unwrap();
        write_server_verified_secret(&session_path(&store), &newer, &store.account_protected_cache.session).unwrap();
        Ok((StatusCode::PAYMENT_REQUIRED, b"{}".to_vec()))
    }), || assert_eq!(read_session_secret(&store).unwrap(), Some(newer.clone()))).unwrap();
    assert_eq!(state.status, "expired");
    assert_eq!(read_session_secret(&store).unwrap(), Some(newer));
    assert_eq!(nonce(&store), original_nonce);
    assert_access(&store, "invalid", &installed);
}

#[test]
fn real_identical_me_and_rename_yield_for_identity_lock_without_invalidating_license_or_drafts() {
    let (_temporary, store, session, member) = fixture();
    let original_nonce = nonce(&store);
    let scope = draft_scope(&store);
    let installed = license_identity(&store);
    for name in ["Alice", "Alice renamed"] {
        let response = me(&store, &session, &member, name, "owner");
        let state = responsive(&store, cloud_account_state_with(&store, |_| async move {
            Ok((StatusCode::OK, response))
        }), || assert_eq!(nonce(&store), original_nonce)).unwrap();
        assert_eq!(state.status, "connected");
        assert_eq!(nonce(&store), original_nonce);
        assert_eq!(draft_scope(&store), scope);
        assert_access(&store, "valid", &installed);
    }
}

#[test]
fn real_late_402_cannot_invalidate_newer_connected_session_or_its_signed_licence() {
    let (_temporary, store, session, _member) = fixture();
    let original_nonce = nonce(&store);
    let installed = license_identity(&store);
    let mut newer = session.clone();
    newer.session_token = format!("zds_{}", "C".repeat(43));
    let state = tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async {
        let _account = store.account_protected_cache.operation_lock.try_lock().unwrap();
        write_server_verified_secret(&session_path(&store), &newer, &store.account_protected_cache.session).unwrap();
        Ok((StatusCode::PAYMENT_REQUIRED, b"{}".to_vec()))
    })).unwrap();
    assert_eq!(state.status, "connected");
    assert_eq!(read_session_secret(&store).unwrap(), Some(newer));
    assert_eq!(nonce(&store), original_nonce);
    assert_access(&store, "valid", &installed);
}

#[test]
fn real_me_outage_and_server_failure_preserve_existing_signed_access_and_actor_generation() {
    let (_temporary, store, session, _member) = fixture();
    let original_nonce = nonce(&store);
    let installed = license_identity(&store);
    let outage = tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async {
        Err(AppError::Remote("synthetic outage".into()))
    })).unwrap();
    let failure = tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async {
        Ok((StatusCode::INTERNAL_SERVER_ERROR, b"{}".to_vec()))
    })).unwrap();
    assert_eq!(outage.status, "connected");
    assert_eq!(failure.status, "connected");
    assert_eq!(read_session_secret(&store).unwrap(), Some(session));
    assert_eq!(nonce(&store), original_nonce);
    assert_access(&store, "valid", &installed);
}

#[test]
fn real_malformed_success_does_not_mutate_session_nonce_or_signed_licence() {
    let (_temporary, store, session, _member) = fixture();
    let original_nonce = nonce(&store);
    let installed = license_identity(&store);
    assert!(tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async {
        Ok((StatusCode::OK, b"{}".to_vec()))
    })).is_err());
    assert_eq!(read_session_secret(&store).unwrap(), Some(session));
    assert_eq!(nonce(&store), original_nonce);
    assert_access(&store, "valid", &installed);
}

#[test]
fn real_me_rejection_yields_with_signed_licence_checks_before_clearing_the_previous_actor() {
    for status in [StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN] {
        let (_temporary, store, _session, _member) = fixture();
        let original_nonce = nonce(&store);
        let scope = draft_scope(&store);
        let installed = license_identity(&store);
        let state = responsive(&store, cloud_account_state_with(&store, |_| async move {
            Ok((status, br#"{"error":"revoked"}"#.to_vec()))
        }), || assert_eq!(nonce(&store), original_nonce)).unwrap();
        assert_eq!(state.status, "disconnected");
        assert!(read_session_secret(&store).unwrap().is_none());
        assert_ne!(nonce(&store), original_nonce);
        assert_eq!(draft_scope(&store), scope);
        assert_eq!(store.connect().unwrap().query_row::<i64, _, _>("SELECT COUNT(*) FROM company_local_identity", [], |row| row.get(0)).unwrap(), 0);
        assert_access(&store, "invalid", &installed);
    }
}
