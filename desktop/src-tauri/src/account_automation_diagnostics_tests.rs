//! Real Automation orchestration and journal worker, with owned fictitious
//! stores/logs and injected transport. Never replaces ACTIVE_LOG or calls HTTP.
use super::*;
use crate::{account_cloud::automation_request_with, database::LocalStore};
use chrono::Utc;
use futures_util::future::join;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

const ORG: &str = "org_369d3fcf-b05b-4d78-9f2a-3c4141aed7fd";
const SESSION_FILE: &str = "cloud-account-session.protected";

fn fixture() -> (tempfile::TempDir, LocalStore, DiagnosticLog) {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().into()).unwrap();
    let log = DiagnosticLog::new(temporary.path(), MAX_FILE_BYTES);
    fs::write(
        store.data_dir.join("company-collaboration.json"),
        serde_json::to_vec(&json!({
            "organization_id": ORG,
        }))
        .unwrap(),
    )
    .unwrap();
    (temporary, store, log)
}

fn session(store: &LocalStore, role: &str) -> Value {
    json!({
        "version": 1,
        "installation_id": store.installation_id,
        "session_token": format!("zds_{}", "B".repeat(43)),
        "session_expires_at": (Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
        "organization_id": ORG,
        "organization_name": "Fictitious private-customer@example.ch",
        "role": role,
        "connected_at": Utc::now().to_rfc3339(),
    })
}

fn write_session(store: &LocalStore, value: &Value) {
    crate::installation::write_protected_atomically(
        &store.data_dir.join(SESSION_FILE),
        &serde_json::to_vec(value).unwrap(),
    )
    .unwrap();
}

#[derive(Debug, PartialEq)]
struct LocalReceipt {
    scope: String,
    session: Option<Vec<u8>>,
    collaboration: Vec<u8>,
    license_files: Vec<Option<Vec<u8>>>,
}

fn local_receipt(store: &LocalStore) -> LocalReceipt {
    let scope = crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();
    let session = fs::read(store.data_dir.join(SESSION_FILE)).ok();
    let collaboration = fs::read(store.data_dir.join("company-collaboration.json")).unwrap();
    let license_files = [
        "license-clock.dpapi",
        "license-clock.protected",
        "license-clock-pending.dpapi",
        "license-clock-pending.protected",
        "license-installation.dpapi",
        "license-installation.protected",
        "license-refresh-attempt.dpapi",
        "license-refresh-attempt.protected",
        "license-token.dpapi",
        "license-token.protected",
    ]
    .iter()
    .map(|name| fs::read(store.data_dir.join(name)).ok())
    .collect();
    LocalReceipt {
        scope,
        session,
        collaboration,
        license_files,
    }
}

fn prepared(log: &DiagnosticLog, error: &AppError) -> PreparedNativeError {
    PreparedNativeError {
        log: log.clone(),
        event: DiagnosticEvent::native(
            &log.0.session_id,
            "command.native",
            DiagnosticPhase::Failure,
            Some(native_error_code(error)),
        ),
    }
}

async fn finish_on_log(log: DiagnosticLog, result: AppResult<Value>) -> Result<Value, String> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let message = error.to_string();
            let receipt = prepared(&log, &error);
            drop(error);
            record_prepared_native_error(Some(receipt)).await;
            Err(message)
        }
    }
}

fn assert_account_available_while_failure_waits_for_journal(postflight: bool) {
    let (_temporary, store, log) = fixture();
    if postflight {
        write_session(&store, &session(&store, "owner"));
    } else {
        fs::write(store.data_dir.join(SESSION_FILE), b"").unwrap();
    }
    let before = local_receipt(&store);
    let expected = if postflight {
        "Champ invalide : La réponse ne correspond pas à votre entreprise."
    } else {
        "Champ invalide : La donnée locale protégée est vide ou trop volumineuse."
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let acknowledged = Arc::new(AtomicBool::new(false));
    let captured = Arc::new(Mutex::new(None));
    let held = log.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = held.0.operation_lock.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let transport_calls = calls.clone();
    let finish_log = log.clone();
    let capture = captured.clone();
    let ack = acknowledged.clone();
    let command = async {
        let result = automation_request_with(
            &store,
            None,
            move |_, _, _, _| async move {
                transport_calls.fetch_add(1, Ordering::SeqCst);
                Ok((
                    StatusCode::OK,
                    serde_json::to_vec(&json!({
                        "organizationId":"foreign-synthetic",
                        "privateBody":"password=synthetic-secret /private/receipt.pdf",
                    }))
                    .unwrap(),
                ))
            },
            move |result| async move {
                let error = result.unwrap_err();
                assert!(matches!(&error, AppError::Validation(_)));
                let message = error.to_string();
                let receipt = prepared(&finish_log, &error);
                *capture.lock().unwrap() =
                    Some((receipt.event.id.clone(), receipt.event.timestamp.clone()));
                drop(error);
                record_prepared_native_error(Some(receipt)).await;
                Err(message)
            },
        )
        .await;
        ack.store(true, Ordering::SeqCst);
        result
    };
    let (result, (account_available_before_ack, released)) =
        tauri::async_runtime::block_on(join(command, async {
            let guard = store.account_protected_cache.operation_lock.lock().await;
            let available_before_ack = !acknowledged.load(Ordering::SeqCst);
            drop(guard);
            // No assertion may strand the fixture's held journal mutex.
            let released = release_tx.send(()).is_ok();
            (available_before_ack, released)
        }));
    assert!(
        holder.join().unwrap(),
        "journal waiting retained the async executor or account mutex"
    );
    assert!(released);
    assert!(account_available_before_ack);
    assert_eq!(result, Err(expected.into()));
    assert_eq!(calls.load(Ordering::SeqCst), usize::from(postflight));
    assert_eq!(local_receipt(&store), before);
    let (id, timestamp) = captured.lock().unwrap().clone().unwrap();
    let summary = log.summary().unwrap();
    assert_eq!(summary.event_count, 1);
    let incident = summary.last_incident.unwrap();
    assert_eq!(incident.id, id);
    assert_eq!(incident.timestamp, timestamp);
    assert_eq!(incident.operation, "command.native");
    assert_eq!(incident.error_code.as_deref(), Some("input.validation"));
    assert_eq!(incident.duration_ms, None);
    let bytes = fs::read_to_string(log.0.directory.join(FILE_NAMES[0])).unwrap();
    for secret in [
        ORG,
        "zds_",
        "private-customer",
        "password",
        "synthetic-secret",
        "receipt.pdf",
        "foreign-synthetic",
    ] {
        assert!(!bytes.contains(secret));
    }
}

#[test]
fn preflight_failure_releases_account_while_real_journal_worker_waits() {
    assert_account_available_while_failure_waits_for_journal(false);
}

#[test]
fn postflight_failure_releases_account_while_real_journal_worker_waits() {
    assert_account_available_while_failure_waits_for_journal(true);
}

#[test]
fn native_failures_keep_original_messages_when_journal_storage_is_unavailable() {
    for case in ["preflight", "transport", "server", "json", "postflight"] {
        let (_temporary, store, log) = fixture();
        if case == "preflight" {
            fs::write(store.data_dir.join(SESSION_FILE), b"").unwrap();
        } else {
            write_session(&store, &session(&store, "owner"));
        }
        fs::write(&log.0.directory, b"fixed occupied child").unwrap();
        let before = local_receipt(&store);
        let before_log = fs::read(&log.0.directory).unwrap();
        let calls = AtomicUsize::new(0);
        let finished = AtomicUsize::new(0);
        let expected = match case {
            "preflight" => {
                "Champ invalide : La donnée locale protégée est vide ou trop volumineuse."
            }
            "transport" => "Fictitious transport original failure",
            "server" => "Fictitious server original failure",
            "json" => "Champ invalide : La réponse du serveur pour suggestion est invalide.",
            _ => "Champ invalide : La réponse ne correspond pas à votre entreprise.",
        };
        let result = tauri::async_runtime::block_on(automation_request_with(
            &store,
            None,
            |_, _, _, _| async {
                calls.fetch_add(1, Ordering::SeqCst);
                match case {
                    "transport" => Err(AppError::Remote(
                        "Fictitious transport original failure".into(),
                    )),
                    "server" => Ok((
                        StatusCode::SERVICE_UNAVAILABLE,
                        br#"{"error":"Fictitious server original failure"}"#.to_vec(),
                    )),
                    "json" => Ok((StatusCode::OK, b"invalid synthetic json".to_vec())),
                    _ => Ok((
                        StatusCode::OK,
                        br#"{"organizationId":"foreign-synthetic"}"#.to_vec(),
                    )),
                }
            },
            |result| {
                finished.fetch_add(1, Ordering::SeqCst);
                finish_on_log(log.clone(), result)
            },
        ));
        assert_eq!(result, Err(expected.into()));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            usize::from(case != "preflight")
        );
        assert_eq!(finished.load(Ordering::SeqCst), 1);
        assert_eq!(fs::read(&log.0.directory).unwrap(), before_log);
        assert_eq!(local_receipt(&store), before);
    }
}

#[test]
fn missing_and_expired_sessions_keep_direct_messages_without_transport_or_native_log() {
    for expired in [false, true] {
        let (_temporary, store, log) = fixture();
        if expired {
            let mut value = session(&store, "owner");
            value["session_expires_at"] =
                json!((Utc::now() - chrono::Duration::days(1)).to_rfc3339());
            write_session(&store, &value);
        }
        let before = local_receipt(&store);
        let calls = AtomicUsize::new(0);
        let finished = AtomicUsize::new(0);
        let result = tauri::async_runtime::block_on(automation_request_with(
            &store,
            None,
            |_, _, _, _| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok((StatusCode::OK, b"{}".to_vec()))
            },
            |result| {
                finished.fetch_add(1, Ordering::SeqCst);
                finish_on_log(log.clone(), result)
            },
        ));
        assert_eq!(
            result,
            Err(if expired {
                "Reconnectez votre compte Zentra pour obtenir des suggestions."
            } else {
                "Connectez votre compte dans Paramètres → Compte et accès."
            }
            .into())
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(finished.load(Ordering::SeqCst), 0);
        assert_eq!(log.summary().unwrap().event_count, 0);
        assert_eq!(local_receipt(&store), before);
    }
}

#[test]
fn changed_session_or_company_during_transport_refuses_historical_response_without_logging_direct_strings(
) {
    for change in ["removed", "token", "organization"] {
        let (_temporary, store, log) = fixture();
        write_session(&store, &session(&store, "owner"));
        let calls = AtomicUsize::new(0);
        let finished = AtomicUsize::new(0);
        let result = tauri::async_runtime::block_on(automation_request_with(
            &store,
            None,
            |_, _, _, _| async {
                calls.fetch_add(1, Ordering::SeqCst);
                // The original transport section is outside the account lock.
                let guard = store
                    .account_protected_cache
                    .operation_lock
                    .try_lock()
                    .unwrap();
                if change == "removed" {
                    crate::installation::remove_protected(&store.data_dir.join(SESSION_FILE))
                        .unwrap();
                } else {
                    let mut value = session(&store, "owner");
                    if change == "token" {
                        value["session_token"] = json!(format!("zds_{}", "C".repeat(43)));
                    } else {
                        value["organization_id"] =
                            json!("org_008fc730-e9c6-48f2-b915-96b5ab2baf0a");
                    }
                    write_session(&store, &value);
                }
                drop(guard);
                Ok((
                    StatusCode::OK,
                    serde_json::to_vec(&json!({"organizationId":ORG,"historical":true})).unwrap(),
                ))
            },
            |result| {
                finished.fetch_add(1, Ordering::SeqCst);
                finish_on_log(log.clone(), result)
            },
        ));
        assert_eq!(
            result,
            Err(if change == "removed" {
                "La connexion a changé."
            } else {
                "La connexion a changé. Relancez la suggestion."
            }
            .into())
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(finished.load(Ordering::SeqCst), 0);
        assert_eq!(log.summary().unwrap().event_count, 0);
    }
}

#[test]
fn successful_get_and_post_preserve_request_arguments_and_do_not_log_failures() {
    for data in [
        None,
        Some(
            json!({"action":"centre","organizationId":"foreign","nativeResources":{"untrusted":true}}),
        ),
    ] {
        let (_temporary, store, log) = fixture();
        let value = session(&store, "owner");
        write_session(&store, &value);
        let before = local_receipt(&store);
        let expected_post = data.is_some();
        let response = json!({"organizationId":ORG,"summary":{"confirmed":true}});
        let calls = AtomicUsize::new(0);
        let finished = AtomicUsize::new(0);
        let transport_calls = &calls;
        let transport_store = &store;
        let expected_session = &value;
        let expected_response = &response;
        let result = tauri::async_runtime::block_on(automation_request_with(
            &store,
            data,
            |method, url, body, bearer| async move {
                transport_calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(
                    method,
                    if expected_post {
                        Method::POST
                    } else {
                        Method::GET
                    }
                );
                assert_eq!(url.as_str(), "https://zentraapp.ch/api/automation");
                assert_eq!(bearer, expected_session["session_token"].as_str().unwrap());
                assert!(transport_store
                    .account_protected_cache
                    .operation_lock
                    .try_lock()
                    .is_some());
                if let Some(body) = body {
                    let body: Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(body["organizationId"], ORG);
                    assert!(body.get("nativeResources").is_none());
                    assert_eq!(body["action"], "centre");
                } else {
                    assert!(!expected_post);
                }
                Ok((
                    StatusCode::OK,
                    serde_json::to_vec(expected_response).unwrap(),
                ))
            },
            |result| {
                finished.fetch_add(1, Ordering::SeqCst);
                finish_on_log(log.clone(), result)
            },
        ));
        assert_eq!(result, Ok(response));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(finished.load(Ordering::SeqCst), 0);
        assert_eq!(log.summary().unwrap().event_count, 0);
        assert_eq!(local_receipt(&store), before);
    }
}

#[test]
fn read_only_settings_refusal_keeps_role_validation_and_skips_transport() {
    let (_temporary, store, log) = fixture();
    write_session(&store, &session(&store, "read_only"));
    let before = local_receipt(&store);
    let calls = AtomicUsize::new(0);
    let result = tauri::async_runtime::block_on(automation_request_with(
        &store,
        Some(json!({"action":"settings"})),
        |_, _, _, _| async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok((StatusCode::OK, b"{}".to_vec()))
        },
        |result| finish_on_log(log.clone(), result),
    ));
    assert_eq!(
        result,
        Err(
            "Champ invalide : Seul le titulaire ou un administrateur peut changer les réglages."
                .into()
        )
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(log.summary().unwrap().event_count, 1);
    assert_eq!(local_receipt(&store), before);
}
