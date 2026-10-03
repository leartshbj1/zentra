//! Native candidate tests, using synthetic companies and the real handlers.
//! Context transitions call the real serialized identity setter. A captured
//! action is constructed before that transition and then polled at destination.
//! The acquired-worker witness uses the shared production helper/business body,
//! explicitly not a paused Tauri handler or a production testing hook.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use futures_util::future::join;
use serde_json::json;
use std::{future::Future, sync::mpsc, thread, time::Duration};
use tauri::Manager;

fn nonce(store: &LocalStore) -> String {
    crate::member_context::read(&store.connect().unwrap()).unwrap()
}
fn identity(store: &LocalStore, user: &str, name: &str, role: &str) {
    crate::company_collaboration::set_identity(store, "synthetic-org", user, name, role).unwrap();
}
fn snapshot(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();
    let mut values = serde_json::Map::new();
    for table in ["clients", "quotes", "invoices", "catalog_items", "stock_movements", "document_creators", "audit_log", "journal_entries", "journal_lines", "company_local_clock"] {
        values.insert(table.into(), json!(crate::database::query_all(
            &connection, &format!("SELECT * FROM {table} ORDER BY rowid"), [],
        ).unwrap()));
    }
    Value::Object(values)
}
fn responsive<T>(store: &LocalStore, command: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    let held_store = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = held_store.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(command, async move {
        let _ = release_tx.send(());
    }));
    assert!(holder.join().unwrap(), "contextual handler must yield while its local mutex is held");
    result
}

#[derive(Clone, Copy, Debug)]
enum Crud { Create, Update, Delete, Catalog }
async fn crud(
    operation: Crud, state: State<'_, LocalStore>, id: String, revision: String,
    expected_scope: Option<String>, expected_nonce: Option<String>,
) -> Result<Value, String> {
    match operation {
        Crud::Create => create_record(state, "clients".into(), json!({"id":id,"name":"MUST NOT APPLY OLD ACTION"}), expected_scope, expected_nonce).await,
        Crud::Update => update_record(state, "clients".into(), id, json!({"name":"MUST NOT APPLY OLD ACTION"}), expected_scope, expected_nonce).await,
        Crud::Delete => delete_record(state, "clients".into(), id, expected_scope, expected_nonce).await.map(|result| json!({"deleted":result.deleted,"id":result.id})),
        Crud::Catalog => update_catalog_item(state, id, json!({"name":"MUST NOT APPLY OLD ACTION"}), revision, expected_scope, expected_nonce).await,
    }
}

#[test]
fn real_crud_handlers_reject_captured_alice_action_after_real_member_change_and_aba() {
    for return_to_alice in [false, true] {
        for operation in [Crud::Create, Crud::Update, Crud::Delete, Crud::Catalog] {
            let (_temporary, store) = fixture();
            let alice = uuid::Uuid::new_v4().to_string();
            let bob = uuid::Uuid::new_v4().to_string();
            identity(&store, &alice, "Alice", "owner");
            let id = uuid::Uuid::new_v4().to_string();
            store.create_record("clients", json!({"id":id,"name":"Original shared client"})).unwrap();
            let catalog = store.create_record("catalog_items", json!({"id":id,"kind":"service","name":"Original shared item","unit":"heure","sales_price_cents":10000})).unwrap();
            let original_scope = scope(&store);
            let original_nonce = nonce(&store);
            let app = tauri::test::mock_builder().manage(store.clone())
                .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
            // This is a captured, not-yet-polled actual handler. No current nonce
            // is read after the actor transition to bless the older payload.
            let pending = crud(operation, app.state(), id.clone(), catalog["updated_at"].as_str().unwrap().into(), Some(original_scope.clone()), Some(original_nonce.clone()));
            identity(&store, &bob, "Bob", "owner");
            if return_to_alice { identity(&store, &alice, "Alice", "owner"); }
            assert_eq!(scope(&store), original_scope, "draft workspace deliberately stays the same");
            assert_ne!(nonce(&store), original_nonce);
            let before = snapshot(&store);
            store.require_write_access().unwrap();
            let error = responsive(&store, pending).unwrap_err();
            assert!(error.contains("Le compte connecté a changé"), "{operation:?}: {error}");
            assert_eq!(snapshot(&store), before, "{operation:?} wrote records, authors, audit, journals or sync clock under the new actor");
            assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
        }
    }
}

#[test]
fn real_create_cannot_leave_a_new_record_or_author_under_bob_after_alice_capture() {
    let (_temporary, store) = fixture();
    let alice = uuid::Uuid::new_v4().to_string();
    let bob = uuid::Uuid::new_v4().to_string();
    identity(&store, &alice, "Alice", "owner");
    let id = uuid::Uuid::new_v4().to_string();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let pending = create_record(app.state(), "quotes".into(), json!({"id":id,"title":"Captured Alice quote"}), Some(scope(&store)), Some(nonce(&store)));
    identity(&store, &bob, "Bob", "owner");
    let before = snapshot(&store);
    assert!(responsive(&store, pending).unwrap_err().contains("Le compte connecté a changé"));
    assert_eq!(snapshot(&store), before);
    assert_eq!(store.connect().unwrap().query_row::<i64, _, _>("SELECT COUNT(*) FROM quotes WHERE id=?", [&id], |row| row.get(0)).unwrap(), 0);
    assert_eq!(store.connect().unwrap().query_row::<i64, _, _>("SELECT COUNT(*) FROM document_creators WHERE document_id=?", [&id], |row| row.get(0)).unwrap(), 0);
}

#[test]
fn repeated_me_and_rename_keep_captured_handler_valid_and_record_the_actual_author() {
    let (_temporary, store) = fixture();
    let alice = uuid::Uuid::new_v4().to_string();
    identity(&store, &alice, "Alice", "owner");
    let original = nonce(&store);
    let id = uuid::Uuid::new_v4().to_string();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let pending = create_record(app.state(), "quotes".into(), json!({"id":id,"title":"Valid Alice quote"}), Some(scope(&store)), Some(original.clone()));
    identity(&store, &alice, "Alice", "owner");
    identity(&store, &alice, "Alice Renamed", "owner");
    assert_eq!(nonce(&store), original);
    assert_eq!(responsive(&store, pending).unwrap()["id"], id);
    let author: (String, String) = store.connect().unwrap().query_row(
        "SELECT user_id,display_name FROM document_creators WHERE entity='quotes' AND document_id=?", [&id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(author, (alice, "Alice Renamed".into()));
    assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
}

#[test]
fn stale_member_precedes_missing_licence_and_business_checks_without_writes() {
    let (_temporary, store) = unlicensed_fixture();
    let alice = uuid::Uuid::new_v4().to_string();
    let bob = uuid::Uuid::new_v4().to_string();
    identity(&store, &alice, "Alice", "owner");
    let old = nonce(&store);
    identity(&store, &bob, "Bob", "owner");
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let before = snapshot(&store);
    for operation in [Crud::Create, Crud::Update, Crud::Delete, Crud::Catalog] {
        let error = responsive(&store, crud(operation, app.state(), "missing".into(), "missing-revision".into(), Some(scope(&store)), Some(old.clone()))).unwrap_err();
        assert!(error.contains("Le compte connecté a changé"), "{operation:?}: {error}");
    }
    assert_eq!(snapshot(&store), before);
    let error = responsive(&store, create_record(app.state(), "clients".into(), json!({"name":"Must remain read-only"}), Some(scope(&store)), Some(nonce(&store)))).unwrap_err();
    assert!(error.contains("lecture seule"), "a current local context must not replace the real licence guard");
    assert_eq!(snapshot(&store), before);
}

#[test]
fn real_role_change_rotates_nonce_and_current_or_legacy_context_cannot_bypass_signed_read_only_licence() {
    let (_temporary, store) = fixture();
    let alice = uuid::Uuid::new_v4().to_string();
    identity(&store, &alice, "Alice", "owner");
    let owner_nonce = nonce(&store);
    identity(&store, &alice, "Alice", "read_only");
    store.install_server_issued_license(&signed_fixture_token(&store, "read_only")).unwrap();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let before = snapshot(&store);
    let error = responsive(&store, create_record(app.state(), "clients".into(), json!({"name":"Old owner action"}), Some(scope(&store)), Some(owner_nonce))).unwrap_err();
    assert!(error.contains("Le compte connecté a changé"));
    for expected in [Some(nonce(&store)), None] {
        let error = responsive(&store, create_record(app.state(), "clients".into(), json!({"name":"No write permission"}), Some(scope(&store)), expected)).unwrap_err();
        assert!(error.contains("limité à la lecture"));
    }
    assert_eq!(snapshot(&store), before);
}

#[test]
fn current_and_legacy_member_args_preserve_real_crud_and_catalog_cas_contracts() {
    for legacy in [false, true] {
        let (_temporary, store) = fixture();
        let alice = uuid::Uuid::new_v4().to_string();
        identity(&store, &alice, "Alice", "owner");
        let expected = if legacy { None } else { Some(nonce(&store)) };
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let saved = responsive(&store, create_record(app.state(), "clients".into(), json!({"id":id,"name":"Valid client"}), Some(scope(&store)), expected.clone())).unwrap();
        assert_eq!(saved["id"], id);
        let updated = responsive(&store, update_record(app.state(), "clients".into(), id.clone(), json!({"name":"Updated client"}), Some(scope(&store)), expected.clone())).unwrap();
        assert_eq!(updated["name"], "Updated client");
        assert!(responsive(&store, delete_record(app.state(), "clients".into(), id, Some(scope(&store)), expected.clone())).unwrap().deleted);
        let item = store.create_record("catalog_items", json!({"kind":"service","name":"Original service","unit":"heure","sales_price_cents":10000})).unwrap();
        let item_id = item["id"].as_str().unwrap().to_owned();
        assert_eq!(responsive(&store, update_catalog_item(app.state(), item_id.clone(), json!({"name":"Updated service"}), item["updated_at"].as_str().unwrap().into(), Some(scope(&store)), expected.clone())).unwrap()["name"], "Updated service");
        let before = snapshot(&store);
        let error = responsive(&store, update_catalog_item(app.state(), item_id, json!({"name":"Stale CAS"}), "deliberately-wrong-revision".into(), Some(scope(&store)), expected)).unwrap_err();
        assert!(error.contains("a changé"));
        assert_eq!(snapshot(&store), before);
        assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
    }
}

#[test]
fn actual_readonly_workspace_getter_rejects_changed_member_and_aba_without_requiring_a_licence() {
    for return_to_alice in [false, true] {
        let (_temporary, store) = unlicensed_fixture();
        let alice = uuid::Uuid::new_v4().to_string();
        let bob = uuid::Uuid::new_v4().to_string();
        identity(&store, &alice, "Alice", "owner");
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let pending = get_workspace(app.state(), Some(scope(&store)), Some(nonce(&store)));
        identity(&store, &bob, "Bob", "owner");
        if return_to_alice { identity(&store, &alice, "Alice", "owner"); }
        let before = snapshot(&store);
        assert!(responsive(&store, pending).unwrap_err().contains("Le compte connecté a changé"));
        for expected in [Some(nonce(&store)), None] {
            let workspace = responsive(&store, get_workspace(app.state(), Some(scope(&store)), expected)).unwrap();
            assert_eq!(workspace["work_notes_scope"], scope(&store));
        }
        assert_eq!(snapshot(&store), before);
    }
}

#[test]
fn unconfigured_app_state_business_read_is_bound_to_original_member_by_shared_worker() {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().into()).unwrap();
    let alice = uuid::Uuid::new_v4().to_string();
    let bob = uuid::Uuid::new_v4().to_string();
    identity(&store, &alice, "Alice", "owner");
    let original_scope = scope(&store);
    let original_nonce = nonce(&store);
    assert!(!store.app_state("empty-member-test").unwrap().onboarding_completed);
    // The exact shared worker and app_state body used by get_app_state. This
    // witness does not instantiate its AppHandle or call that Tauri handler.
    let pending = run_member_scoped_local_operation(store.clone(), Some(original_scope.clone()), Some(original_nonce), |store| store.app_state("empty-member-test").map_err(command_error));
    identity(&store, &bob, "Bob", "owner");
    let before = snapshot(&store);
    assert!(responsive(&store, pending).unwrap_err().contains("Le compte connecté a changé"));
    let current = responsive(&store, run_member_scoped_local_operation(store.clone(), Some(original_scope), Some(nonce(&store)), |store| store.app_state("empty-member-test").map_err(command_error))).unwrap();
    assert!(!current.onboarding_completed);
    assert_eq!(snapshot(&store), before);
}

#[test]
fn acquired_member_worker_commits_with_original_author_before_real_identity_setter_can_change_it() {
    let (_temporary, store) = fixture();
    let alice = uuid::Uuid::new_v4().to_string();
    let bob = uuid::Uuid::new_v4().to_string();
    identity(&store, &alice, "Alice", "owner");
    let original_nonce = nonce(&store);
    let original_scope = scope(&store);
    let id = uuid::Uuid::new_v4().to_string();
    let entered_id = id.clone();
    let expected_alice = alice.clone();
    let changing = store.clone();
    let observed = store.clone();
    let (acquired_tx, acquired_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (completed_tx, completed_rx) = mpsc::channel();
    let command = run_member_scoped_local_operation(store.clone(), Some(original_scope.clone()), Some(original_nonce.clone()), move |store| {
        require_write(store)?;
        acquired_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Synthetic commit release missing".to_owned())?;
        assert_eq!(store.connect().unwrap().query_row::<String, _, _>("SELECT user_id FROM company_local_identity", [], |row| row.get(0)).unwrap(), expected_alice);
        store.create_record("quotes", json!({"id":entered_id,"title":"Committed under Alice"})).map_err(command_error)
    });
    let (result, (setter, completed_rx)) = tauri::async_runtime::block_on(join(command, async move {
        acquired_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let setter = thread::spawn(move || {
            attempt_tx.send(()).unwrap();
            identity(&changing, &bob, "Bob", "owner");
            completed_tx.send(()).unwrap();
        });
        attempt_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(completed_rx.recv_timeout(Duration::from_millis(50)), Err(mpsc::RecvTimeoutError::Timeout)), "identity setter escaped the held business-operation mutex");
        assert_eq!(nonce(&observed), original_nonce);
        release_tx.send(()).unwrap();
        (setter, completed_rx)
    }));
    assert_eq!(result.unwrap()["id"], id);
    completed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    setter.join().unwrap();
    assert_eq!(scope(&store), original_scope);
    assert_eq!(store.connect().unwrap().query_row::<String, _, _>("SELECT user_id FROM document_creators WHERE entity='quotes' AND document_id=?", [&id], |row| row.get(0)).unwrap(), alice);
    assert_eq!(store.connect().unwrap().query_row::<i64, _, _>("SELECT COUNT(*) FROM audit_log WHERE entity_type='quotes' AND entity_id=?", [&id], |row| row.get(0)).unwrap(), 1);
    assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
}

#[test]
fn actual_local_admission_identity_reader_yields_and_returns_only_nonce_without_changing_drafts() {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().into()).unwrap();
    let original_nonce = nonce(&store);
    let original_scope = scope(&store);
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let result = responsive(&store, crate::diagnostics::get_form_draft_identity(app.state())).unwrap();
    let encoded = serde_json::to_value(result).unwrap();
    assert_eq!(encoded, json!({"memberId":null,"memberContextNonce":original_nonce}));
    assert_eq!(scope(&store), original_scope);
}
