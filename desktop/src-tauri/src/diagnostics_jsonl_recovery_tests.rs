//! Real JSONL append/read/export paths with synthetic interrupted-write tails.
//! No global journal, private data, disk-full injector or application profile.
use super::*;

fn fixture(limit: u64) -> (tempfile::TempDir, DiagnosticLog) {
    let temporary = tempfile::tempdir().unwrap();
    let log = DiagnosticLog::new(temporary.path(), limit);
    log.ensure_directory(&log.0.directory).unwrap();
    (temporary, log)
}

fn event(log: &DiagnosticLog) -> DiagnosticEvent {
    DiagnosticEvent::native(
        &log.0.session_id,
        "command.native",
        DiagnosticPhase::Failure,
        Some("storage.io"),
    )
}

fn bytes(log: &DiagnosticLog, event: &DiagnosticEvent) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&DiagnosticRecord {
        event: event.clone(),
        app_version: log.0.app_version.clone(),
        platform: log.0.platform.clone(),
    })
    .unwrap();
    bytes.push(b'\n');
    bytes
}

fn ids(log: &DiagnosticLog) -> Vec<String> {
    log.records()
        .unwrap()
        .0
        .into_iter()
        .map(|record| record.event.id)
        .collect()
}

#[test]
fn partial_tail_keeps_prior_records_and_does_not_consume_the_next_complete_record() {
    let (_temporary, log) = fixture(MAX_FILE_BYTES);
    let previous = event(&log);
    let interrupted = bytes(&log, &event(&log));
    let mut before = bytes(&log, &previous);
    before.extend_from_slice(&interrupted[..70]);
    let current = log.0.directory.join(FILE_NAMES[0]);
    fs::write(&current, &before).unwrap();
    assert_eq!(ids(&log), vec![previous.id.clone()]);

    let next = event(&log);
    log.append(std::slice::from_ref(&next)).unwrap();
    assert_eq!(ids(&log), vec![previous.id, next.id.clone()]);
    let mut expected = before;
    expected.push(b'\n');
    expected.extend_from_slice(&bytes(&log, &next));
    assert_eq!(fs::read(&current).unwrap(), expected);
    // The export still discards the interrupted record, retaining the two
    // confirmed references without including or rewriting the bad prefix.
    let exported = fs::read_to_string(log.export().unwrap()).unwrap();
    assert_eq!(exported.lines().count(), 2);
    assert!(exported.contains(&next.id));
}

#[test]
fn complete_record_without_newline_is_preserved_before_the_next_record() {
    let (_temporary, log) = fixture(MAX_FILE_BYTES);
    let previous = event(&log);
    let mut before = bytes(&log, &previous);
    assert_eq!(before.pop(), Some(b'\n'));
    let current = log.0.directory.join(FILE_NAMES[0]);
    fs::write(&current, &before).unwrap();
    let next = event(&log);
    log.append(std::slice::from_ref(&next)).unwrap();
    assert_eq!(ids(&log), vec![previous.id, next.id.clone()]);
    before.push(b'\n');
    before.extend_from_slice(&bytes(&log, &next));
    assert_eq!(fs::read(current).unwrap(), before);
}

#[test]
fn separator_is_counted_and_can_fill_the_current_file_exactly() {
    let (_temporary, initial) = fixture(MAX_FILE_BYTES);
    let previous = event(&initial);
    let mut before = bytes(&initial, &previous);
    let line_size = before.len() as u64;
    before.pop();
    let log = DiagnosticLog::new(&initial.0.data_dir, line_size * 2);
    let current = log.0.directory.join(FILE_NAMES[0]);
    fs::write(&current, &before).unwrap();
    let next = event(&log);
    assert_eq!(bytes(&log, &next).len() as u64, line_size);
    log.append(std::slice::from_ref(&next)).unwrap();
    let (_, files, size) = log.records().unwrap();
    assert_eq!(files, 1);
    assert_eq!(size, log.0.max_file_bytes);
    assert_eq!(ids(&log), vec![previous.id, next.id]);
    assert!(!log.0.directory.join(FILE_NAMES[1]).exists());
}

#[test]
fn separator_forces_rotation_when_the_next_record_alone_would_just_fit() {
    let (_temporary, initial) = fixture(MAX_FILE_BYTES);
    let previous = event(&initial);
    let mut before = bytes(&initial, &previous);
    let line_size = before.len() as u64;
    before.pop();
    let log = DiagnosticLog::new(&initial.0.data_dir, line_size * 2 - 1);
    fs::write(log.0.directory.join(FILE_NAMES[0]), &before).unwrap();
    let next = event(&log);
    assert_eq!(bytes(&log, &next).len() as u64, line_size);
    log.append(std::slice::from_ref(&next)).unwrap();
    assert_eq!(
        fs::read(log.0.directory.join(FILE_NAMES[1])).unwrap(),
        before
    );
    assert_eq!(
        fs::read(log.0.directory.join(FILE_NAMES[0])).unwrap(),
        bytes(&log, &next),
    );
    let (_, files, size) = log.records().unwrap();
    assert_eq!(files, 2);
    assert!(size <= log.0.max_file_bytes * MAX_FILES as u64);
    assert_eq!(ids(&log), vec![previous.id, next.id]);
}

#[test]
fn full_unterminated_tail_rotates_without_truncating_or_extending_that_file() {
    let (_temporary, initial) = fixture(MAX_FILE_BYTES);
    let next = event(&initial);
    let line_size = bytes(&initial, &next).len();
    let log = DiagnosticLog::new(&initial.0.data_dir, line_size as u64);
    let mut partial = vec![b' '; line_size];
    partial[0] = b'{';
    fs::write(log.0.directory.join(FILE_NAMES[0]), &partial).unwrap();
    log.append(std::slice::from_ref(&next)).unwrap();
    assert_eq!(
        fs::read(log.0.directory.join(FILE_NAMES[1])).unwrap(),
        partial
    );
    assert_eq!(ids(&log), vec![next.id]);
    assert_eq!(log.records().unwrap().1, 2);
}

#[test]
fn empty_current_file_does_not_get_a_leading_separator() {
    let (_temporary, log) = fixture(MAX_FILE_BYTES);
    let current = log.0.directory.join(FILE_NAMES[0]);
    fs::write(&current, b"").unwrap();
    let next = event(&log);
    log.append(std::slice::from_ref(&next)).unwrap();
    assert_eq!(fs::read(current).unwrap(), bytes(&log, &next));
    assert_eq!(ids(&log), vec![next.id]);
}

#[test]
fn normal_complete_batch_keeps_its_original_bytes_without_extra_separators() {
    let (_temporary, log) = fixture(MAX_FILE_BYTES);
    let previous = event(&log);
    let mut expected = bytes(&log, &previous);
    let current = log.0.directory.join(FILE_NAMES[0]);
    fs::write(&current, &expected).unwrap();
    let values = vec![event(&log), event(&log)];
    for value in &values {
        expected.extend_from_slice(&bytes(&log, value));
    }
    log.append(&values).unwrap();
    assert_eq!(fs::read(current).unwrap(), expected);
    assert_eq!(
        ids(&log),
        vec![previous.id, values[0].id.clone(), values[1].id.clone()]
    );
}

#[test]
fn empty_batch_does_not_modify_an_unterminated_tail() {
    let (_temporary, log) = fixture(MAX_FILE_BYTES);
    let current = log.0.directory.join(FILE_NAMES[0]);
    let partial = b"{\"event\":";
    fs::write(&current, partial).unwrap();
    log.append(&[]).unwrap();
    assert_eq!(fs::read(current).unwrap(), partial);
}

#[cfg(windows)]
#[test]
fn unreadable_tail_refuses_before_writing_then_recovers_after_handle_release() {
    use std::os::windows::fs::OpenOptionsExt;

    let (_temporary, log) = fixture(MAX_FILE_BYTES);
    let previous = event(&log);
    let mut before = bytes(&log, &previous);
    before.pop();
    let current = log.0.directory.join(FILE_NAMES[0]);
    fs::write(&current, &before).unwrap();
    // Allow writes and deletion but deny a new read handle, targeting only
    // the new one-byte tail inspection rather than rotation admission.
    let held = OpenOptions::new()
        .write(true)
        .share_mode(0x0000_0006)
        .open(&current)
        .unwrap();
    let next = event(&log);
    for _ in 0..3 {
        assert_eq!(
            log.append(std::slice::from_ref(&next)),
            Err(DiagnosticError::StorageUnavailable),
        );
    }
    drop(held);
    assert_eq!(fs::read(&current).unwrap(), before);
    assert_eq!(ids(&log), vec![previous.id.clone()]);
    log.append(std::slice::from_ref(&next)).unwrap();
    assert_eq!(ids(&log), vec![previous.id, next.id]);
}
