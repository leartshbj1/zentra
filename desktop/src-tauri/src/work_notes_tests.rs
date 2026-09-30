use super::*;

fn fixture() -> (tempfile::TempDir, LocalStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    crate::company_collaboration::set_identity(
        &store,
        "notes-company",
        "member-alice",
        "Alice",
        "member",
    )
    .unwrap();
    (dir, store)
}
fn note(id: Option<String>) -> SaveWorkNoteInput {
    SaveWorkNoteInput {
        id,
        title: "Mesures cuisine".into(),
        body: "Mur nord : 2,40 m\nPrendre une photo demain.".into(),
        project_id: None,
        pinned: false,
        expected_updated_at: None,
        expected_workspace_scope: None,
    }
}
fn update(record: &Value) -> SaveWorkNoteInput {
    SaveWorkNoteInput {
        id: Some(record["id"].as_str().unwrap().into()),
        title: record["title"].as_str().unwrap().into(),
        body: record["body"].as_str().unwrap().into(),
        project_id: record["project_id"].as_str().map(str::to_owned),
        pinned: record["pinned"].as_bool().unwrap(),
        expected_updated_at: Some(record["updated_at"].as_str().unwrap().into()),
        expected_workspace_scope: None,
    }
}
fn clock(store: &LocalStore) -> i64 {
    store
        .connect()
        .unwrap()
        .query_row(
            "SELECT value FROM company_local_clock WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn work_note_crud_is_offline_durable_audited_and_preserves_original_author() {
    let (_dir, store) = fixture();
    let project = store
        .create_record("projects", json!({"name":"Cuisine client"}))
        .unwrap();
    let mut draft = note(Some(Uuid::new_v4().to_string()));
    draft.project_id = Some(project["id"].as_str().unwrap().into());
    draft.pinned = true;
    let before = clock(&store);
    let created = store.save_work_note(draft.clone()).unwrap();
    assert!(clock(&store) > before);
    assert_eq!(created["pinned"], true);
    assert_eq!(created["created_by_member_id"], "member-alice");
    assert_eq!(created["author_name"], "Alice");
    assert!(created.get("deleted_at").is_none());
    let after_create = clock(&store);
    assert_eq!(store.save_work_note(draft).unwrap(), created);
    assert_eq!(
        clock(&store),
        after_create,
        "a retry must not dirty the sync clock"
    );
    crate::company_collaboration::set_identity(
        &store,
        "notes-company",
        "member-bob",
        "Bob",
        "member",
    )
    .unwrap();
    let mut draft = update(&created);
    draft.body = "Mesures confirmées\n\nFenêtre : 1,20 m".into();
    let saved = store.save_work_note(draft.clone()).unwrap();
    assert_ne!(saved["updated_at"], created["updated_at"]);
    assert_eq!(saved["created_at"], created["created_at"]);
    assert_eq!(saved["author_name"], "Alice");
    let stable_clock = clock(&store);
    assert_eq!(store.save_work_note(update(&saved)).unwrap(), saved);
    assert_eq!(clock(&store), stable_clock);
    let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
    assert_eq!(
        reopened.get_interface_workspace().unwrap()["work_notes"],
        json!([saved.clone()])
    );
    assert!(reopened.verify_audit_log().is_ok());
    let removed = reopened
        .delete_work_note(saved["id"].as_str().unwrap(), saved["updated_at"].as_str())
        .unwrap();
    assert!(removed.deleted);
    assert!(reopened.get_workspace().unwrap()["work_notes"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(
        !reopened
            .delete_work_note(&removed.id, None)
            .unwrap()
            .deleted
    );
    assert!(reopened
        .save_work_note(draft)
        .unwrap_err()
        .to_string()
        .contains("supprimée"));
    let deleted: bool = reopened
        .connect()
        .unwrap()
        .query_row(
            "SELECT deleted_at IS NOT NULL FROM work_notes WHERE id=?",
            [&removed.id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(deleted, "deletion must remain in shared company archives");
}

#[test]
fn work_note_stale_autosave_and_delete_cannot_overwrite_other_window() {
    let (_dir, store) = fixture();
    let created = store.save_work_note(note(None)).unwrap();
    let mut first = update(&created);
    let mut stale = first.clone();
    first.body = "Modification du collègue".into();
    stale.body = "Texte écrit dans une autre fenêtre".into();
    let changed = store.save_work_note(first).unwrap();
    let before = clock(&store);
    assert!(store.save_work_note(stale).is_err());
    assert!(store
        .delete_work_note(
            created["id"].as_str().unwrap(),
            created["updated_at"].as_str()
        )
        .is_err());
    let mut missing_version = update(&changed);
    missing_version.expected_updated_at = None;
    missing_version.title = "Écrasement sans version".into();
    assert!(store.save_work_note(missing_version).is_err());
    assert_eq!(
        clock(&store),
        before,
        "rejected writes must roll back the entire transaction"
    );
    assert_eq!(
        store.get_workspace().unwrap()["work_notes"],
        json!([changed])
    );
}

#[test]
fn work_note_validation_projects_and_read_only_role_are_enforced() {
    let (_dir, store) = fixture();
    let mut draft = note(None);
    draft.title = "x".repeat(201);
    assert!(store.save_work_note(draft.clone()).is_err());
    draft.title = "Titre\ninterdit".into();
    assert!(store.save_work_note(draft.clone()).is_err());
    draft = note(None);
    draft.body = "x".repeat(100_001);
    assert!(store.save_work_note(draft.clone()).is_err());
    draft.body = "Texte\0invalide".into();
    assert!(store.save_work_note(draft).is_err());
    draft = note(None);
    draft.project_id = Some(Uuid::new_v4().to_string());
    assert!(store.save_work_note(draft).is_err());
    draft = note(None);
    draft.id = Some("not-a-uuid".into());
    assert!(store.save_work_note(draft).is_err());
    let created = store.save_work_note(note(None)).unwrap();
    crate::company_collaboration::set_identity(
        &store,
        "notes-company",
        "member-reader",
        "Reader",
        "read_only",
    )
    .unwrap();
    assert!(store.save_work_note(note(None)).is_err());
    assert!(store
        .delete_work_note(
            created["id"].as_str().unwrap(),
            created["updated_at"].as_str()
        )
        .is_err());
    assert_eq!(
        store.get_workspace().unwrap()["work_notes"],
        json!([created])
    );
}

#[test]
fn work_note_backup_json_export_and_workspace_isolation_preserve_notes_and_tombstones() {
    let (dir, store) = fixture();
    let active = store.save_work_note(note(None)).unwrap();
    let deleted = store.save_work_note(note(None)).unwrap();
    store
        .delete_work_note(
            deleted["id"].as_str().unwrap(),
            deleted["updated_at"].as_str(),
        )
        .unwrap();
    let backup = dir.path().join("notes.zentra");
    store
        .create_backup_at(&backup, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let exported = store
        .export_json(
            Some(dir.path().join("notes.json").to_string_lossy().into()),
            env!("CARGO_PKG_VERSION"),
        )
        .unwrap();
    let value: Value = serde_json::from_slice(&std::fs::read(exported).unwrap()).unwrap();
    assert_eq!(value["data"]["work_notes"], json!([active.clone()]));
    let other = LocalStore::initialize(dir.path().join("other-company")).unwrap();
    other
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    assert!(other.get_workspace().unwrap()["work_notes"]
        .as_array()
        .unwrap()
        .is_empty());
    other
        .restore_backup(&backup.to_string_lossy(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    assert_eq!(
        other.get_workspace().unwrap()["work_notes"],
        json!([active])
    );
    assert!(other
        .save_work_note(note(Some(deleted["id"].as_str().unwrap().into())))
        .is_err());
    assert!(other.verify_audit_log().is_ok());
}

#[test]
fn work_note_v60_migration_preserves_company_and_installs_shared_tracking() {
    let (_dir, store) = fixture();
    let db = store.connect().unwrap();
    db.execute_batch("DROP TABLE work_notes; PRAGMA user_version=60;")
        .unwrap();
    let before = clock(&store);
    store.migrate().unwrap();
    store.migrate().unwrap();
    assert_eq!(
        clock(&store),
        before,
        "schema migration is not a business edit"
    );
    assert_eq!(store.get_workspace().unwrap()["schema_version"], 61);
    assert!(store.get_workspace().unwrap()["work_notes"]
        .as_array()
        .unwrap()
        .is_empty());
    store.save_work_note(note(None)).unwrap();
    assert!(clock(&store) > before);
    let guards:i64=db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'company_guard_work_notes_%'",[],|r|r.get(0)).unwrap();
    assert_eq!(guards, 3);
}

#[test]
fn work_note_revision_advances_even_if_device_clock_moves_back() {
    let future = "2099-01-01T00:00:00+00:00";
    let next = DateTime::parse_from_rfc3339(&next_timestamp(Some(future)).unwrap()).unwrap();
    assert!(next > DateTime::parse_from_rfc3339(future).unwrap());
}

#[test]
fn work_note_draft_scope_is_private_durable_and_rotates_on_import_and_reset() {
    let (dir, store) = fixture();
    let original = workspace_scope(&store.connect().unwrap()).unwrap();
    assert!(Uuid::parse_str(&original).is_ok());
    let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
    assert_eq!(
        workspace_scope(&reopened.connect().unwrap()).unwrap(),
        original
    );
    assert_eq!(
        store.get_interface_workspace().unwrap()["work_notes_scope"],
        original
    );
    let other = LocalStore::initialize(dir.path().join("separate-company")).unwrap();
    assert_ne!(
        workspace_scope(&other.connect().unwrap()).unwrap(),
        original
    );
    let note = store.save_work_note(note(None)).unwrap();
    let archive = dir.path().join("scope-import.zentra");
    store
        .create_backup_at(&archive, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let extracted = dir.path().join("scope-archive");
    store.extract_company_copy(&archive, &extracted).unwrap();
    let shared = Connection::open(extracted.join("database.sqlite3")).unwrap();
    assert_eq!(
        shared
            .query_row("SELECT COUNT(*) FROM company_local_notes_scope", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    store
        .restore_backup(&archive.to_string_lossy(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    let imported = workspace_scope(&store.connect().unwrap()).unwrap();
    assert_ne!(imported, original);
    assert_eq!(store.get_workspace().unwrap()["work_notes"], json!([note]));
    store.reset_local_workspace().unwrap();
    assert_ne!(
        workspace_scope(&store.connect().unwrap()).unwrap(),
        imported
    );
}

#[test]
fn work_note_queued_save_and_delete_cannot_cross_workspace_scope() {
    let (_dir, store) = fixture();
    let old_scope = workspace_scope(&store.connect().unwrap()).unwrap();
    let created = store.save_work_note(note(None)).unwrap();
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE company_local_notes_scope SET scope=? WHERE id=1",
            [Uuid::new_v4().to_string()],
        )
        .unwrap();
    let before = clock(&store);
    let mut queued_new = note(Some(Uuid::new_v4().to_string()));
    queued_new.expected_workspace_scope = Some(old_scope.clone());
    assert!(store.save_work_note(queued_new).is_err());
    let mut queued_update = update(&created);
    queued_update.body = "Ancienne fenêtre après changement d’entreprise".into();
    queued_update.expected_workspace_scope = Some(old_scope.clone());
    assert!(store.save_work_note(queued_update).is_err());
    assert!(store
        .delete_work_note_scoped(
            created["id"].as_str().unwrap(),
            created["updated_at"].as_str(),
            Some(&old_scope)
        )
        .is_err());
    assert_eq!(clock(&store), before);
    assert_eq!(
        store.get_workspace().unwrap()["work_notes"],
        json!([created])
    );
}

#[test]
fn work_note_first_company_edits_merge_against_a_v60_archive_without_server_changes() {
    let (dir, store) = fixture();
    store
        .connect()
        .unwrap()
        .execute_batch("DROP TABLE work_notes; PRAGMA user_version=60;")
        .unwrap();
    let base = dir.path().join("v60-base.zentra");
    store
        .create_backup_at(&base, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let base_bytes = std::fs::read(&base).unwrap();
    store.migrate().unwrap();
    let peer = LocalStore::initialize(dir.path().join("upgraded-peer")).unwrap();
    peer.restore_backup(&base.to_string_lossy(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    let mut alice = note(None);
    alice.body = "Première note Alice".into();
    let mut bob = note(None);
    bob.body = "Première note Bob".into();
    store.save_work_note(alice).unwrap();
    peer.save_work_note(bob).unwrap();
    let local = dir.path().join("v61-local.zentra");
    let remote = dir.path().join("v61-remote.zentra");
    store
        .create_backup_at(&local, env!("CARGO_PKG_VERSION"))
        .unwrap();
    peer.create_backup_at(&remote, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let merged = dir.path().join("first-notes-merged.zentra");
    crate::company_merge::merge(&store, &base, &local, &remote, &merged).unwrap();
    let output = dir.path().join("first-notes-copy");
    store.extract_company_copy(&merged, &output).unwrap();
    let db = Connection::open(output.join("database.sqlite3")).unwrap();
    assert_eq!(workspace_notes(&db).unwrap().len(), 2);
    assert_eq!(
        std::fs::read(&base).unwrap(),
        base_bytes,
        "original transport archive is immutable"
    );
    let guards:i64=db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'company_guard_work_notes_%'",[],|r|r.get(0)).unwrap();
    assert_eq!(guards, 3);
}

#[test]
fn work_note_company_merge_carries_independent_edits_and_rejects_delete_edit_conflict() {
    let (dir, store) = fixture();
    let a = store.save_work_note(note(None)).unwrap();
    let b = store.save_work_note(note(None)).unwrap();
    let base = dir.path().join("base.zentra");
    store
        .create_backup_at(&base, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let peer = LocalStore::initialize(dir.path().join("peer")).unwrap();
    peer.restore_backup(&base.to_string_lossy(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    let mut edit_a = update(&a);
    edit_a.body = "Mesures relevées par Alice".into();
    let mut edit_b = update(&b);
    edit_b.body = "Matériel à prendre par Bob".into();
    store.save_work_note(edit_a).unwrap();
    peer.save_work_note(edit_b).unwrap();
    let local = dir.path().join("local.zentra");
    let remote = dir.path().join("remote.zentra");
    store
        .create_backup_at(&local, env!("CARGO_PKG_VERSION"))
        .unwrap();
    peer.create_backup_at(&remote, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let merged = dir.path().join("merged.zentra");
    crate::company_merge::merge(&store, &base, &local, &remote, &merged).unwrap();
    let extracted = dir.path().join("merged-copy");
    store.extract_company_copy(&merged, &extracted).unwrap();
    let db = Connection::open(extracted.join("database.sqlite3")).unwrap();
    let bodies: Vec<String> = db
        .prepare("SELECT body FROM work_notes ORDER BY body")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        bodies,
        vec!["Matériel à prendre par Bob", "Mesures relevées par Alice"]
    );
    assert!(crate::audit::verify_audit_chain(&db).is_ok());
    // Deleting the same note concurrently with an offline edit must require
    // review; neither branch can silently win or resurrect the note.
    let deleter = LocalStore::initialize(dir.path().join("deleter")).unwrap();
    deleter
        .restore_backup(&base.to_string_lossy(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    deleter
        .delete_work_note(a["id"].as_str().unwrap(), a["updated_at"].as_str())
        .unwrap();
    let deletion = dir.path().join("deletion.zentra");
    deleter
        .create_backup_at(&deletion, env!("CARGO_PKG_VERSION"))
        .unwrap();
    assert!(crate::company_merge::merge(
        &store,
        &base,
        &local,
        &deletion,
        &dir.path().join("conflict.zentra")
    )
    .is_err());
    // A deletion of A and edit of B are independent and both survive sharing.
    crate::company_merge::merge(
        &store,
        &base,
        &remote,
        &deletion,
        &dir.path().join("deleted-merged.zentra"),
    )
    .unwrap();
    store
        .extract_company_copy(
            &dir.path().join("deleted-merged.zentra"),
            &dir.path().join("deleted-copy"),
        )
        .unwrap();
    let deleted_db = Connection::open(dir.path().join("deleted-copy/database.sqlite3")).unwrap();
    assert_eq!(workspace_notes(&deleted_db).unwrap().len(), 1);
    let tombstone: bool = deleted_db
        .query_row(
            "SELECT deleted_at IS NOT NULL FROM work_notes WHERE id=?",
            [a["id"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert!(tombstone);
}
