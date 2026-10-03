use super::*;
use crate::database::LocalStore;
use std::{sync::mpsc, thread, time::Duration};

fn fixture() -> (tempfile::TempDir, LocalStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().into()).unwrap();
    (directory, store)
}
fn nonce(store: &LocalStore) -> String { read(&store.connect().unwrap()).unwrap() }

#[test]
fn repeated_migration_preserves_local_generation() {
    let (_directory, store) = fixture();
    let original = nonce(&store);
    migrate(&store.connect().unwrap()).unwrap();
    assert_eq!(nonce(&store), original);
    assert!(valid_nonce(&original));
}

#[test]
fn identical_me_and_display_name_update_preserve_generation_and_draft_scope() {
    let (_directory, store) = fixture();
    let user = Uuid::new_v4().to_string();
    let scope = crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();
    crate::company_collaboration::set_identity(&store, "org-a", &user, "Alice", "owner").unwrap();
    let original = nonce(&store);
    crate::company_collaboration::set_identity(&store, "org-a", &user, "Alice", "owner").unwrap();
    assert_eq!(nonce(&store), original);
    crate::company_collaboration::set_identity(&store, "org-a", &user, "Alice Nouveau", "owner").unwrap();
    assert_eq!(nonce(&store), original);
    assert_eq!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(), scope);
}

#[test]
fn member_role_and_organization_changes_each_invalidate_the_previous_context() {
    let (_directory, store) = fixture();
    let alice = Uuid::new_v4().to_string();
    let bob = Uuid::new_v4().to_string();
    let scope = crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();
    let mut previous = nonce(&store);
    for (organization, user, role) in [
        ("org-a", alice.as_str(), "owner"),
        ("org-a", bob.as_str(), "owner"),
        ("org-a", bob.as_str(), "read_only"),
        ("org-b", bob.as_str(), "read_only"),
        ("org-a", alice.as_str(), "owner"),
    ] {
        crate::company_collaboration::set_identity(&store, organization, user, "Synthetic User", role).unwrap();
        let current = nonce(&store);
        assert_ne!(current, previous);
        assert!(require_unchanged(&store.connect().unwrap(), Some(&previous)).is_err());
        require_unchanged(&store.connect().unwrap(), Some(&current)).unwrap();
        previous = current;
    }
    assert_eq!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(), scope);
}

#[test]
fn returning_to_same_member_does_not_revive_the_old_pending_generation() {
    let (_directory, store) = fixture();
    let alice = Uuid::new_v4().to_string();
    let bob = Uuid::new_v4().to_string();
    crate::company_collaboration::set_identity(&store, "org-a", &alice, "Alice", "owner").unwrap();
    let first_alice = nonce(&store);
    crate::company_collaboration::set_identity(&store, "org-a", &bob, "Bob", "owner").unwrap();
    crate::company_collaboration::set_identity(&store, "org-a", &alice, "Alice", "owner").unwrap();
    assert_ne!(nonce(&store), first_alice);
    assert!(require_unchanged(&store.connect().unwrap(), Some(&first_alice)).is_err());
}

#[test]
fn explicit_new_local_connection_rotates_even_without_any_identity_row() {
    let (_directory, store) = fixture();
    let original = nonce(&store);
    let connection = store.connect().unwrap();
    assert_eq!(connection.query_row::<i64,_,_>("SELECT COUNT(*) FROM company_local_identity", [], |row| row.get(0)).unwrap(), 0);
    rotate(&connection).unwrap();
    assert_ne!(nonce(&store), original);
    require_unchanged(&connection, None).unwrap(); // Legacy omission is not authority.
    assert!(require_unchanged(&connection, Some(" ")).is_err());
}

#[test]
fn missing_or_corrupt_context_is_never_accepted_as_matching() {
    let (_directory, store) = fixture();
    let original = nonce(&store);
    let connection = store.connect().unwrap();
    connection.execute("UPDATE company_local_member_context SET nonce='malformed'", []).unwrap();
    assert!(read(&connection).is_err());
    assert!(require_unchanged(&connection, Some(&original)).is_err());
    connection.execute("DELETE FROM company_local_member_context", []).unwrap();
    assert!(require_unchanged(&connection, Some(&original)).is_err());
}

#[test]
fn actual_identity_setter_waits_for_the_shared_local_lock_and_does_not_change_actor_mid_operation() {
    let (_directory, store) = fixture();
    let alice = Uuid::new_v4().to_string();
    let bob = Uuid::new_v4().to_string();
    crate::company_collaboration::set_identity(&store, "org-a", &alice, "Alice", "owner").unwrap();
    let original = nonce(&store);
    let held = store.lock().unwrap();
    let changing = store.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let (completed_tx, completed_rx) = mpsc::channel();
    let setter = thread::spawn(move || {
        started_tx.send(()).unwrap();
        let result = crate::company_collaboration::set_identity(&changing, "org-a", &bob, "Bob", "owner");
        completed_tx.send(result).unwrap();
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(completed_rx.recv_timeout(Duration::from_millis(50)), Err(mpsc::RecvTimeoutError::Timeout)));
    assert_eq!(nonce(&store), original);
    assert_eq!(store.connect().unwrap().query_row::<String,_,_>("SELECT user_id FROM company_local_identity", [], |row| row.get(0)).unwrap(), alice);
    drop(held);
    completed_rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
    setter.join().unwrap();
    assert_ne!(nonce(&store), original);
}

fn remove_context_from_historical_schema61(store: &LocalStore) {
    let connection = store.connect().unwrap();
    assert_eq!(connection.pragma_query_value::<i64, _>(None, "user_version", |row| row.get(0)).unwrap(), 61);
    connection.execute_batch("DROP TRIGGER company_member_context_insert; DROP TRIGGER company_member_context_delete; DROP TRIGGER company_member_context_update; DROP TABLE company_local_member_context;").unwrap();
    assert_eq!(connection.query_row::<i64, _, _>("SELECT COUNT(*) FROM sqlite_master WHERE name='company_local_member_context'", [], |row| row.get(0)).unwrap(), 0);
}

#[test]
fn actual_schema61_fast_path_repairs_missing_context_without_changing_business_or_draft_scope() {
    let (_directory, store) = fixture();
    store.complete_onboarding(crate::tests::test_onboarding(), "member-migration-test").unwrap();
    let user = Uuid::new_v4().to_string();
    crate::company_collaboration::set_identity(&store, "org-a", &user, "Alice", "owner").unwrap();
    store.create_record("clients", serde_json::json!({"name":"Existing schema61 client"})).unwrap();
    let original = nonce(&store);
    let scope = crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();
    let business = store.get_workspace().unwrap();
    remove_context_from_historical_schema61(&store);
    // Real LocalStore::migrate must repair the existing-61 early-return branch.
    // Calling member_context::migrate alone would miss this regression.
    store.migrate().unwrap();
    let repaired = nonce(&store);
    assert!(valid_nonce(&repaired));
    assert_ne!(repaired, original);
    assert_eq!(store.get_workspace().unwrap(), business);
    assert_eq!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(), scope);
    assert_eq!(store.connect().unwrap().query_row::<String, _, _>("SELECT user_id FROM company_local_identity", [], |row| row.get(0)).unwrap(), user);
    store.migrate().unwrap();
    assert_eq!(nonce(&store), repaired);
    crate::company_collaboration::set_identity(&store, "org-a", &user, "Alice Renamed", "owner").unwrap();
    assert_eq!(nonce(&store), repaired);
    crate::company_collaboration::set_identity(&store, "org-a", &user, "Alice Renamed", "read_only").unwrap();
    assert_ne!(nonce(&store), repaired, "the fast-path migration must also install the update trigger");
}

#[test]
fn actual_restore_of_historical_schema61_archive_regenerates_its_missing_context() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_directory, store) = fixture();
    store.complete_onboarding(crate::tests::test_onboarding(), "member-old-archive-test").unwrap();
    let id = Uuid::new_v4().to_string();
    store.create_record("clients", serde_json::json!({"id":id,"name":"Historical archived client"})).unwrap();
    remove_context_from_historical_schema61(&store);
    let archive = store.create_backup(None, "member-old-archive-test").unwrap();
    // Restore operates under the same caller-owned local mutex as production.
    let _guard = store.lock().unwrap();
    store.restore_backup(&archive, "member-old-archive-test").unwrap();
    assert!(valid_nonce(&nonce(&store)));
    assert_eq!(store.connect().unwrap().query_row::<String, _, _>("SELECT name FROM clients WHERE id=?", [&id], |row| row.get(0)).unwrap(), "Historical archived client");
    assert_eq!(store.connect().unwrap().query_row::<i64, _, _>("SELECT COUNT(*) FROM company_local_identity", [], |row| row.get(0)).unwrap(), 0);
    let current = nonce(&store);
    store.migrate().unwrap();
    assert_eq!(nonce(&store), current);
}
