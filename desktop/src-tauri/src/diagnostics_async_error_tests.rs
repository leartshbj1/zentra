//! Real log mutex/storage workers; no global-log replacement or network.
use super::*;
use futures_util::future::join;
use std::{sync::mpsc, thread, time::Duration};

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

#[test]
fn native_failure_waiting_for_the_log_mutex_yields_its_async_executor() {
    let temporary = tempfile::tempdir().unwrap();
    let log = DiagnosticLog::new(temporary.path(), MAX_FILE_BYTES);
    let original = AppError::Io(std::io::Error::other(
        "private-customer@example.ch password=synthetic-secret /private/receipt.pdf",
    ));
    let receipt = prepared(&log, &original);
    let id = receipt.event.id.clone();
    let captured_at = receipt.event.timestamp.clone();
    let held = log.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = held.0.operation_lock.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    tauri::async_runtime::block_on(join(
        record_prepared_native_error(Some(receipt)),
        async move {
            // Inline persistence cannot reach this future before the holder
            // times out. Preserve that witness instead of a SendError cascade.
            let _ = release_tx.send(());
        },
    ));
    assert!(holder.join().unwrap(), "native error persistence blocked the async executor");
    let summary = log.summary().unwrap();
    let incident = summary.last_incident.unwrap();
    assert_eq!(incident.id, id);
    assert_eq!(incident.timestamp, captured_at);
    assert_eq!(incident.operation, "command.native");
    assert_eq!(incident.error_code.as_deref(), Some("storage.io"));
    assert_eq!(summary.event_count, 1);
    let text = fs::read_to_string(log.0.directory.join(FILE_NAMES[0])).unwrap();
    assert!(!text.contains("private-customer"));
    assert!(!text.contains("password"));
    assert!(!text.contains("synthetic-secret"));
    assert!(!text.contains("receipt.pdf"));
}

#[test]
fn native_failure_journal_receipt_is_best_effort_with_unavailable_storage() {
    let temporary = tempfile::tempdir().unwrap();
    let log = DiagnosticLog::new(temporary.path(), MAX_FILE_BYTES);
    fs::write(&log.0.directory, b"occupied fixed child").unwrap();
    let before = fs::read(&log.0.directory).unwrap();
    let original = AppError::Validation("Original synthetic refusal".into());
    let receipt = prepared(&log, &original);
    tauri::async_runtime::block_on(record_prepared_native_error(Some(receipt)));
    assert_eq!(fs::read(&log.0.directory).unwrap(), before);
    tauri::async_runtime::block_on(record_prepared_native_error(None));
}

#[test]
fn async_command_result_keeps_successes_and_original_failure_strings() {
    let success = serde_json::json!({"confirmed":true,"syntheticReceipt":"same"});
    let returned = tauri::async_runtime::block_on(crate::error::finish_async_command(Ok(success.clone()))).unwrap();
    assert_eq!(returned, success);
    for error in [
        AppError::Validation("Original synthetic input refusal".into()),
        AppError::Remote("Original synthetic remote refusal".into()),
        AppError::Restore("La restauration est terminée. Fermez puis rouvrez Zentra.".into()),
        AppError::NotFound("synthetic-record".into()),
        AppError::Io(std::io::Error::other("Original synthetic storage refusal")),
        AppError::OnboardingRequired,
    ] {
        let original = error.to_string();
        let returned = tauri::async_runtime::block_on(crate::error::finish_async_command::<()>(Err(error)));
        assert_eq!(returned, Err(original));
    }
}
