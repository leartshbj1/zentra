use super::*;

fn fixture() -> (tempfile::TempDir, LocalStore) {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().into()).unwrap();
    (temporary, store)
}
fn nonce(store: &LocalStore) -> String { crate::member_context::read(&store.connect().unwrap()).unwrap() }

#[test]
fn ordinary_private_restore_reinstalls_original_nonce_after_identity_triggers() {
    let (_temporary, store) = fixture();
    let alice = uuid::Uuid::new_v4().to_string();
    let bob = uuid::Uuid::new_v4().to_string();
    set_identity(&store, "org-a", &alice, "Alice", "owner").unwrap();
    let original = nonce(&store);
    let original_scope = crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();
    let saved = private_rows(&store).unwrap();
    set_identity(&store, "org-a", &bob, "Bob", "member").unwrap();
    assert_ne!(nonce(&store), original);
    let _guard = store.lock().unwrap();
    restore_private(&store, &saved).unwrap();
    assert_eq!(nonce(&store), original);
    assert_eq!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(), original_scope);
}

#[test]
fn private_restore_with_cleared_context_rows_starts_a_new_nonce() {
    let (_temporary, store) = fixture();
    let user = uuid::Uuid::new_v4().to_string();
    set_identity(&store, "org-a", &user, "Alice", "owner").unwrap();
    let original = nonce(&store);
    // Helper witness only: the company-account Tauri/restore handler is not
    // invoked here. Its separate whole-company scope remains a required guard.
    let rows: Vec<_> = private_rows(&store).unwrap().into_iter().map(|(table, rows)| {
        let selected = if table == "company_local_identity" { rows.into_iter().filter(|row|row["organization_id"]=="org-a").collect() } else { vec![] };
        (table, selected)
    }).collect();
    let _guard = store.lock().unwrap();
    restore_private(&store, &rows).unwrap();
    assert_ne!(nonce(&store), original);
    assert_eq!(store.connect().unwrap().query_row::<String,_,_>("SELECT user_id FROM company_local_identity", [], |row|row.get(0)).unwrap(), user);
}

#[test]
fn shared_copy_strips_nonce_and_manual_restore_regenerates_it() {
    let (_temporary, store) = fixture();
    let user = uuid::Uuid::new_v4().to_string();
    set_identity(&store, "org-a", &user, "Alice", "owner").unwrap();
    let original = nonce(&store);
    let copy = store.create_backup(None, "member-context-test").unwrap();
    let inspected = tempfile::tempdir().unwrap();
    let database_path = inspected.path().join("shared.sqlite3");
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&copy).unwrap()).unwrap();
    let mut database = Vec::new();
    std::io::Read::read_to_end(&mut archive.by_name("database.sqlite3").unwrap(), &mut database).unwrap();
    std::fs::write(&database_path, database).unwrap();
    let connection = rusqlite::Connection::open(&database_path).unwrap();
    assert_eq!(connection.query_row::<i64,_,_>("SELECT COUNT(*) FROM company_local_member_context", [], |row|row.get(0)).unwrap(), 0);
    assert_eq!(connection.query_row::<i64,_,_>("SELECT COUNT(*) FROM company_local_identity", [], |row|row.get(0)).unwrap(), 0);
    drop(connection);
    let _guard = store.lock().unwrap();
    store.restore_backup(&copy, "member-context-test").unwrap();
    assert_ne!(nonce(&store), original);
    assert!(local_table("company_local_member_context"));
    assert_eq!(store.connect().unwrap().query_row::<i64,_,_>("SELECT COUNT(*) FROM company_local_identity", [], |row|row.get(0)).unwrap(), 0);
}
