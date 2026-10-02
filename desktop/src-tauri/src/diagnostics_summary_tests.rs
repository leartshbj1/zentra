//! Timestamp selection over the real journal, without native commands or HTTP.
//! These tests require native CI; local rustfmt parsing is not execution.
use super::*;

fn fixture(limit: u64) -> (tempfile::TempDir, DiagnosticLog) {
    let directory = tempfile::tempdir().unwrap();
    let log = DiagnosticLog::new(directory.path(), limit);
    (directory, log)
}

fn event(at: &str, phase: DiagnosticPhase, frontend: bool) -> DiagnosticEvent {
    let mut event = DiagnosticEvent::native(
        &Uuid::new_v4().to_string(),
        if frontend {
            "get_workspace"
        } else {
            "project.exchange"
        },
        phase,
        (phase == DiagnosticPhase::Failure).then_some(if frontend {
            "STORAGE"
        } else {
            "storage.io"
        }),
    );
    event.timestamp = at.into();
    event.area = if frontend {
        DiagnosticArea::Command
    } else {
        DiagnosticArea::Sync
    };
    event.validate().unwrap();
    event
}

fn assert_retained_order(log: &DiagnosticLog, expected: &[DiagnosticEvent]) {
    let text = fs::read_to_string(log.export().unwrap()).unwrap();
    let exported: Vec<DiagnosticRecord> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(exported.len(), expected.len());
    for (record, original) in exported.iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(&record.event).unwrap(),
            serde_json::to_value(original).unwrap()
        );
    }
}

#[test]
fn delayed_frontend_failure_does_not_replace_a_newer_native_incident() {
    let (_directory, log) = fixture(MAX_FILE_BYTES);
    let native = event("2026-10-02T12:00:10.000Z", DiagnosticPhase::Failure, false);
    let delayed = event("2026-10-02T12:00:09.900Z", DiagnosticPhase::Failure, true);
    let success = event("2026-10-02T12:00:10.001Z", DiagnosticPhase::Success, true);
    log.append(std::slice::from_ref(&native)).unwrap();
    log.append(&[delayed.clone(), success.clone()]).unwrap();

    let summary = log.summary().unwrap();
    assert_eq!(summary.event_count, 3);
    assert_eq!(
        summary.first_event_at.as_deref(),
        Some(delayed.timestamp.as_str())
    );
    assert_eq!(
        summary.last_event_at.as_deref(),
        Some(success.timestamp.as_str())
    );
    assert_eq!(
        serde_json::to_value(summary.last_incident.unwrap()).unwrap(),
        serde_json::to_value(&native).unwrap()
    );
    // The old event is retained; summary selection neither filters nor reorders export.
    assert_retained_order(&log, &[native, delayed, success]);
}

#[test]
fn summary_compares_rfc3339_instants_with_positive_and_negative_offsets() {
    let (_directory, log) = fixture(MAX_FILE_BYTES);
    let native = event("2026-10-02T12:00:00+02:00", DiagnosticPhase::Failure, false);
    let older = event("2026-10-02T10:30:00+01:00", DiagnosticPhase::Failure, true);
    let first = event("2026-10-02T09:00:00Z", DiagnosticPhase::Start, true);
    let last = event("2026-10-02T05:15:00-05:00", DiagnosticPhase::Success, true);
    let appended = [native.clone(), last.clone(), first.clone(), older];
    log.append(&appended).unwrap();

    let summary = log.summary().unwrap();
    assert_eq!(
        summary.first_event_at.as_deref(),
        Some(first.timestamp.as_str())
    );
    assert_eq!(
        summary.last_event_at.as_deref(),
        Some(last.timestamp.as_str())
    );
    let incident = summary.last_incident.unwrap();
    assert_eq!(incident.id, native.id);
    assert_eq!(incident.session_id, native.session_id);
    assert_eq!(incident.timestamp, native.timestamp);
    assert_eq!(summary.event_count, appended.len());
    assert_retained_order(&log, &appended);
}

#[test]
fn date_boundary_offsets_are_ordered_by_instant_not_the_printed_calendar_day() {
    let (_directory, log) = fixture(MAX_FILE_BYTES);
    let native = event("2026-10-03T00:10:00+02:00", DiagnosticPhase::Failure, false);
    let delayed = event("2026-10-02T23:30:00+02:00", DiagnosticPhase::Failure, true);
    let first = event("2026-10-02T18:00:00-03:00", DiagnosticPhase::Start, true);
    let last = event("2026-10-02T23:00:00Z", DiagnosticPhase::Success, true);
    let appended = [last.clone(), native.clone(), first.clone(), delayed];
    log.append(&appended).unwrap();

    let summary = log.summary().unwrap();
    assert_eq!(
        summary.first_event_at.as_deref(),
        Some(first.timestamp.as_str())
    );
    assert_eq!(
        summary.last_event_at.as_deref(),
        Some(last.timestamp.as_str())
    );
    assert_eq!(summary.last_incident.unwrap().id, native.id);
    assert_eq!(summary.event_count, appended.len());
    assert_retained_order(&log, &appended);
}

#[test]
fn equal_instants_keep_first_boundary_and_latest_appended_failure_deterministically() {
    let (_directory, log) = fixture(MAX_FILE_BYTES);
    let first = event("2026-10-02T10:00:00Z", DiagnosticPhase::Failure, false);
    let middle = event("2026-10-02T12:00:00+02:00", DiagnosticPhase::Failure, true);
    let latest_failure = event("2026-10-02T05:00:00-05:00", DiagnosticPhase::Failure, false);
    let last = event("2026-10-02T11:00:00+01:00", DiagnosticPhase::Info, true);
    let appended = [first.clone(), middle, latest_failure.clone(), last.clone()];
    log.append(&appended).unwrap();

    for _ in 0..3 {
        let summary = log.summary().unwrap();
        assert_eq!(
            summary.first_event_at.as_deref(),
            Some(first.timestamp.as_str())
        );
        assert_eq!(
            summary.last_event_at.as_deref(),
            Some(last.timestamp.as_str())
        );
        assert_eq!(summary.last_incident.unwrap().id, latest_failure.id);
        assert_eq!(summary.event_count, appended.len());
    }
    assert_retained_order(&log, &appended);
}

#[test]
fn out_of_order_events_across_rotation_keep_all_retained_errors_and_exact_reference() {
    let (_directory, log) = fixture(700);
    let earlier = event("2026-10-02T09:00:00Z", DiagnosticPhase::Failure, true);
    let latest = event("2026-10-02T12:00:00Z", DiagnosticPhase::Failure, false);
    let later_success = event("2026-10-02T13:00:00Z", DiagnosticPhase::Success, true);
    let delayed = event("2026-10-02T10:00:00Z", DiagnosticPhase::Failure, true);
    let appended = [
        earlier.clone(),
        latest.clone(),
        later_success.clone(),
        delayed,
    ];
    log.append(&appended[..2]).unwrap();
    log.append(&appended[2..]).unwrap();

    let summary = log.summary().unwrap();
    assert!(summary.file_count > 1);
    assert_eq!(summary.event_count, appended.len());
    assert_eq!(
        summary.first_event_at.as_deref(),
        Some(earlier.timestamp.as_str())
    );
    assert_eq!(
        summary.last_event_at.as_deref(),
        Some(later_success.timestamp.as_str())
    );
    assert_eq!(summary.last_incident.unwrap().id, latest.id);
    assert_retained_order(&log, &appended);
}

#[test]
fn empty_and_non_failure_history_have_no_incident_and_keep_chronological_bounds() {
    let (_directory, log) = fixture(MAX_FILE_BYTES);
    let empty = log.summary().unwrap();
    assert_eq!(empty.event_count, 0);
    assert!(empty.first_event_at.is_none());
    assert!(empty.last_event_at.is_none());
    assert!(empty.last_incident.is_none());
    let latest = event("2026-10-02T12:00:00Z", DiagnosticPhase::Success, true);
    let earliest = event("2026-10-02T10:00:00Z", DiagnosticPhase::Info, false);
    let appended = [latest.clone(), earliest.clone()];
    log.append(&appended).unwrap();

    let summary = log.summary().unwrap();
    assert_eq!(summary.event_count, 2);
    assert!(summary.last_incident.is_none());
    assert_eq!(
        summary.first_event_at.as_deref(),
        Some(earliest.timestamp.as_str())
    );
    assert_eq!(
        summary.last_event_at.as_deref(),
        Some(latest.timestamp.as_str())
    );
    assert_retained_order(&log, &appended);
}
