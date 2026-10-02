//! Windows sharing fixtures using the real log append/rotation/reader paths.
//! No application profile, global ACTIVE_LOG, network or business data.
use super::*;
use std::{collections::HashSet, os::windows::fs::OpenOptionsExt, thread};

const SHARE_READ_WRITE: u32 = 0x0000_0003;
const SHARE_READ_WRITE_DELETE: u32 = 0x0000_0007;

fn event(log: &DiagnosticLog) -> DiagnosticEvent {
    DiagnosticEvent::native(
        &log.0.session_id,
        "command.native",
        DiagnosticPhase::Failure,
        Some("storage.io"),
    )
}

fn record_bytes(log: &DiagnosticLog, event: &DiagnosticEvent) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&DiagnosticRecord {
        event: event.clone(),
        app_version: log.0.app_version.clone(),
        platform: log.0.platform.clone(),
    })
    .unwrap();
    bytes.push(b'\n');
    bytes
}

fn fixture() -> (tempfile::TempDir, DiagnosticLog) {
    let temporary = tempfile::tempdir().unwrap();
    let initial = DiagnosticLog::new(temporary.path(), MAX_FILE_BYTES);
    let bytes: Vec<_> = (0..MAX_FILES)
        .map(|_| record_bytes(&initial, &event(&initial)))
        .collect();
    assert!(bytes.iter().all(|value| value.len() == bytes[0].len()));
    // Each slot contains one complete record. The next equal-sized record
    // must enter the actual rotation path, not just append to free capacity.
    let log = DiagnosticLog::new(temporary.path(), bytes[0].len() as u64);
    log.ensure_directory(&log.0.directory).unwrap();
    for (name, bytes) in FILE_NAMES.iter().zip(bytes) {
        fs::write(log.0.directory.join(name), bytes).unwrap();
    }
    assert_eq!(log.records().unwrap().0.len(), MAX_FILES);
    (temporary, log)
}

fn snapshot(log: &DiagnosticLog) -> (Vec<Vec<u8>>, Vec<String>) {
    let bytes = FILE_NAMES
        .iter()
        .map(|name| fs::read(log.0.directory.join(name)).unwrap())
        .collect();
    let ids = log
        .records()
        .unwrap()
        .0
        .into_iter()
        .map(|record| record.event.id)
        .collect();
    (bytes, ids)
}

fn assert_locked_slot_preserves_all_records_then_resumes(index: usize) {
    let (_temporary, log) = fixture();
    let before = snapshot(&log);
    let held = OpenOptions::new()
        .read(true)
        .share_mode(SHARE_READ_WRITE)
        .open(log.0.directory.join(FILE_NAMES[index]))
        .unwrap();
    let next = event(&log);
    let cloned = log.clone();
    for attempt in 0..3 {
        let writer = if attempt % 2 == 0 { &log } else { &cloned };
        assert_eq!(
            writer.append(std::slice::from_ref(&next)),
            Err(DiagnosticError::StorageUnavailable),
        );
        // Byte-for-byte equality is stronger than a hash-only oracle. Also
        // exercise the real validated read path and retained reference order.
        assert_eq!(snapshot(&log), before);
        assert_eq!(log.summary().unwrap().event_count, MAX_FILES);
    }
    drop(held);
    cloned.append(std::slice::from_ref(&next)).unwrap();
    let (records, files, bytes) = log.records().unwrap();
    let ids: Vec<_> = records
        .iter()
        .map(|record| record.event.id.clone())
        .collect();
    assert_eq!(&ids[..2], &before.1[1..]);
    assert_eq!(ids.last(), Some(&next.id));
    assert_eq!(files, MAX_FILES);
    assert!(bytes <= log.0.max_file_bytes * MAX_FILES as u64);
    assert_eq!(records.len(), MAX_FILES);
}

#[test]
fn locked_current_file_refuses_rotation_without_discarding_older_incidents() {
    assert_locked_slot_preserves_all_records_then_resumes(0);
}

#[test]
fn locked_previous_file_refuses_rotation_without_discarding_oldest_incidents() {
    assert_locked_slot_preserves_all_records_then_resumes(1);
}

#[test]
fn locked_oldest_file_refuses_rotation_and_resumes_after_reader_release() {
    assert_locked_slot_preserves_all_records_then_resumes(2);
}

#[test]
fn reserved_sources_refuse_late_incompatible_readers_until_their_handles_drop() {
    let (_temporary, log) = fixture();
    let before = snapshot(&log);
    let guard = log.0.operation_lock.lock().unwrap();
    let mut reservations = log.reserve_rotation_files().unwrap();
    // The removed destination is deliberately released before removal. The
    // two source handles must remain alive through both moves.
    drop(reservations[2].take());
    for name in &FILE_NAMES[..2] {
        let error = OpenOptions::new()
            .read(true)
            .share_mode(SHARE_READ_WRITE)
            .open(log.0.directory.join(name))
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(32));
    }
    drop(reservations);
    drop(guard);
    for name in &FILE_NAMES[..2] {
        OpenOptions::new()
            .read(true)
            .share_mode(SHARE_READ_WRITE)
            .open(log.0.directory.join(name))
            .unwrap();
    }
    assert_eq!(snapshot(&log), before);
}

#[test]
fn ordinary_rotation_keeps_the_two_sources_and_new_record_with_three_files() {
    let (_temporary, log) = fixture();
    let before = snapshot(&log);
    let next = event(&log);
    log.append(std::slice::from_ref(&next)).unwrap();
    let (records, files, bytes) = log.records().unwrap();
    let ids: Vec<_> = records
        .iter()
        .map(|record| record.event.id.clone())
        .collect();
    assert_eq!(&ids[..2], &before.1[1..]);
    assert_eq!(ids.last(), Some(&next.id));
    assert_eq!(files, MAX_FILES);
    assert!(bytes <= log.0.max_file_bytes * MAX_FILES as u64);
}

#[test]
fn a_compatible_reader_can_remain_open_across_rotation() {
    let (_temporary, log) = fixture();
    let held = OpenOptions::new()
        .read(true)
        .share_mode(SHARE_READ_WRITE_DELETE)
        .open(log.0.directory.join(FILE_NAMES[0]))
        .unwrap();
    let next = event(&log);
    log.append(std::slice::from_ref(&next)).unwrap();
    assert_eq!(log.records().unwrap().0.last().unwrap().event.id, next.id);
    drop(held);
}

#[test]
fn cloned_concurrent_writers_keep_rotation_bounded_and_complete() {
    let (_temporary, log) = fixture();
    let writers: Vec<_> = (0..4)
        .map(|_| {
            let cloned = log.clone();
            thread::spawn(move || {
                let mut written = Vec::new();
                for _ in 0..12 {
                    let next = event(&cloned);
                    cloned.append(std::slice::from_ref(&next)).unwrap();
                    written.push(next.id);
                }
                written
            })
        })
        .collect();
    let written: HashSet<_> = writers
        .into_iter()
        .flat_map(|writer| writer.join().unwrap())
        .collect();
    let (records, files, bytes) = log.records().unwrap();
    assert_eq!(records.len(), MAX_FILES);
    assert_eq!(files, MAX_FILES);
    assert!(bytes <= log.0.max_file_bytes * MAX_FILES as u64);
    let retained: HashSet<_> = records.iter().map(|record| &record.event.id).collect();
    assert_eq!(retained.len(), MAX_FILES);
    assert!(retained.into_iter().all(|id| written.contains(id)));
}

#[test]
fn a_compatible_oldest_reader_retains_its_bytes_while_rotation_and_resume_complete() {
    let (_temporary, log) = fixture();
    let before = snapshot(&log);
    let mut held = OpenOptions::new()
        .read(true)
        .share_mode(SHARE_READ_WRITE_DELETE)
        .open(log.0.directory.join(FILE_NAMES[2]))
        .unwrap();

    let next = event(&log);
    log.append(std::slice::from_ref(&next)).unwrap();
    let (records, files, bytes) = log.records().unwrap();
    let ids: Vec<_> = records
        .iter()
        .map(|record| record.event.id.clone())
        .collect();
    assert_eq!(&ids[..2], &before.1[1..]);
    assert_eq!(ids.last(), Some(&next.id));
    assert_eq!(files, MAX_FILES);
    assert_eq!(records.len(), MAX_FILES);
    assert!(bytes <= log.0.max_file_bytes * MAX_FILES as u64);
    for name in FILE_NAMES {
        assert!(fs::metadata(log.0.directory.join(name)).unwrap().len() <= log.0.max_file_bytes);
    }

    // The old destination is no longer a named diagnostic slot, but the
    // external compatible handle still refers to its original record.
    let mut held_bytes = Vec::new();
    std::io::Read::read_to_end(&mut held, &mut held_bytes).unwrap();
    assert_eq!(held_bytes, before.0[2]);
    drop(held);

    let resumed = event(&log);
    log.clone().append(std::slice::from_ref(&resumed)).unwrap();
    let (records, files, bytes) = log.records().unwrap();
    let retained: Vec<_> = records
        .iter()
        .map(|record| record.event.id.clone())
        .collect();
    assert_eq!(retained, vec![before.1[2].clone(), next.id, resumed.id]);
    assert_eq!(files, MAX_FILES);
    assert_eq!(records.len(), MAX_FILES);
    assert!(bytes <= log.0.max_file_bytes * MAX_FILES as u64);
    for name in FILE_NAMES {
        assert!(fs::metadata(log.0.directory.join(name)).unwrap().len() <= log.0.max_file_bytes);
    }
}
