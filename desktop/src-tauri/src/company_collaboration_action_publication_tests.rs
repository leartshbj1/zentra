//! Real LocalStore/SQLite/ZIP fixtures with synthetic identity. These private
//! tests establish no remote entitlement, central reservation or A7 evidence.
use super::{
    apply, apply_merged, clock, confirm_sent, file_path, load, prepare,
    require_action_engine_quote_write_ready, save, MergeReception, Preferences, Received,
};
use crate::{
    action_engine_quote::{
        ActionEngineQuoteActor, ActionEngineQuoteInput, ActionEngineQuoteSource,
    },
    action_engine_quote_publication::{link_prepared, retained_snapshot_ids},
    action_engine_resources::{article_revision, export_resources, resource_hash},
    database::{query_all, LocalStore},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const ORGANIZATION: &str = "synthetic-publication-company";

struct Fixture {
    directory: tempfile::TempDir,
    store: LocalStore,
    input: ActionEngineQuoteInput,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("local")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    let db = store.connect().unwrap();
    db.execute("INSERT INTO company_local_identity VALUES(1,?,'synthetic-owner','Synthetic owner','owner')", [ORGANIZATION]).unwrap();
    db.execute("UPDATE settings SET vat_registered=1,default_vat_bp=810,updated_at='2026-10-11T00:00:00Z' WHERE id=1", []).unwrap();
    let article_id = Uuid::new_v4().to_string();
    db.execute("INSERT INTO catalog_items(id,kind,sku,name,description,unit,sales_price_cents,vat_bp,created_at,updated_at)
        VALUES(?,'product','RAD-100','Radiateur','radiateurs','pièce',19900,810,'2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')", [&article_id]).unwrap();
    let resources = export_resources(&db).unwrap();
    let plan = json!({
        "schemaVersion":1,"engineVersion":"action-engine-quote-v1","kind":"prepare_quote_draft",
        "organizationId":ORGANIZATION,"contextRevision":"qa-publication-mail-v1",
        "sourceId":"synthetic-mail-1","sourceRevision":"mail-v1","status":"ready","reasons":[],
        "customer":{"kind":"new","name":"Camille Exemple","email":"camille@example.ch"},
        "title":"Devis radiateurs","currency":"CHF",
        "lines":[{"articleId":article_id,"articleRevision":article_revision(&resources.articles[0]),
            "description":"Radiateur","unit":"pièce","quantityMilli":3000,"unitPriceCents":19900,
            "taxRateBp":810,"netCents":59700,"evidence":"3 radiateurs"}],
        "netCents":59700,"confidence":0.99,"requiresHumanValidation":true
    });
    let canonical_plan_json = serde_json::to_string(&plan).unwrap();
    let input = ActionEngineQuoteInput {
        fingerprint: format!("{:x}", Sha256::digest(canonical_plan_json.as_bytes())),
        canonical_plan_json,
        proposal_id: Uuid::new_v4().to_string(),
        reservation_id: Uuid::new_v4().to_string(),
        source: ActionEngineQuoteSource {
            id: "synthetic-mail-1".into(),
            revision: "mail-v1".into(),
            organization_id: ORGANIZATION.into(),
            sender_email: "camille@example.ch".into(),
            sender_name: "Camille Exemple".into(),
            subject: "Devis radiateurs".into(),
            body: "3 radiateurs".into(),
        },
        actor: ActionEngineQuoteActor {
            organization_id: ORGANIZATION.into(),
            user_id: "synthetic-owner".into(),
        },
        installation_id: store.installation_id.clone(),
        expected_workspace_scope: crate::work_notes::workspace_scope(&db).unwrap(),
        expected_member_context_nonce: crate::member_context::read(&db).unwrap(),
        expected_resources_hash: resource_hash(&resources),
        expected_context_revision: "qa-publication-mail-v1".into(),
        customer_id: Uuid::new_v4().to_string(),
        quote_id: Uuid::new_v4().to_string(),
    };
    drop(db);
    Fixture {
        directory,
        store,
        input,
    }
}

fn links(store: &LocalStore) -> Vec<Value> {
    query_all(
        &store.connect().unwrap(),
        "SELECT * FROM company_local_action_engine_quote_publications ORDER BY snapshot_id",
        [],
    )
    .unwrap()
}

fn outbox(store: &LocalStore) -> Vec<Value> {
    query_all(
        &store.connect().unwrap(),
        "SELECT * FROM company_local_action_engine_quote_outbox ORDER BY proposal_id",
        [],
    )
    .unwrap()
}

fn private_business(store: &LocalStore) -> Value {
    let db = store.connect().unwrap();
    let mut value = serde_json::Map::new();
    for table in [
        "clients",
        "quotes",
        "quote_items",
        "audit_log",
        "action_engine_quote_receipts",
        "company_local_action_engine_quote_outbox",
        "company_local_action_engine_quote_publications",
    ] {
        value.insert(
            table.into(),
            json!(query_all(&db, &format!("SELECT * FROM {table} ORDER BY 1"), []).unwrap()),
        );
    }
    Value::Object(value)
}

#[test]
fn exact_prepare_ack_reopen_and_second_candidate_keep_all_archives_without_confirming_execution() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    let receipt = fixture
        .store
        .commit_action_engine_quote_draft(fixture.input.clone())
        .unwrap();
    let pending = prepare(&fixture.store, ORGANIZATION, false).unwrap();
    let first = links(&fixture.store);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["snapshot_id"], pending.id);
    assert_eq!(first[0]["quote_id"], receipt.quote_id);
    assert_eq!(first[0]["archive_sha256"], pending.manifest.sha256);
    assert!(first[0]["published_revision"].is_null());
    assert!(prepare(&fixture.store, ORGANIZATION, false).unwrap() == pending);
    assert_eq!(links(&fixture.store), first);
    assert!(confirm_sent(&fixture.store, &pending.id, pending.base_revision + 2).is_err());
    assert_eq!(links(&fixture.store), first);
    assert!(load(&fixture.store).unwrap().pending.is_some());
    confirm_sent(&fixture.store, &pending.id, pending.base_revision + 1).unwrap();
    let acknowledged = links(&fixture.store);
    assert_eq!(
        acknowledged[0]["published_revision"],
        pending.base_revision + 1
    );
    assert_eq!(outbox(&fixture.store)[0]["state"], "pending");
    assert!(file_path(&fixture.store, &pending.id).unwrap().is_file());
    let reopened = LocalStore::initialize(fixture.store.data_dir.clone()).unwrap();
    assert_eq!(links(&reopened), acknowledged);
    assert_eq!(
        reopened
            .connect()
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        62
    );
    let next = prepare(&reopened, ORGANIZATION, false).unwrap();
    assert_ne!(next.id, pending.id);
    assert_eq!(next.base_revision, pending.base_revision + 1);
    let pinned = retained_snapshot_ids(&reopened.connect().unwrap()).unwrap();
    assert_eq!(pinned.len(), 2);
    assert!(pinned.contains(&pending.id) && pinned.contains(&next.id));
    assert_eq!(
        links(&reopened)
            .iter()
            .find(|row| row["snapshot_id"] == pending.id),
        acknowledged.first()
    );
}

#[test]
fn old_pending_without_creation_never_links_newer_receipt_and_new_writer_waits() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    let old = prepare(&fixture.store, ORGANIZATION, false).unwrap();
    let before = private_business(&fixture.store);
    assert!(fixture
        .store
        .commit_action_engine_quote_draft(fixture.input.clone())
        .is_err());
    assert_eq!(private_business(&fixture.store), before);
    assert!(links(&fixture.store).is_empty());
    // Model only a pre-upgrade legacy branch: its old frozen pending predates
    // this committed writer. Production cannot create this state with A9's gate.
    let old_preferences = load(&fixture.store).unwrap();
    save(&fixture.store, &Preferences::default()).unwrap();
    let receipt = fixture
        .store
        .commit_action_engine_quote_draft(fixture.input.clone())
        .unwrap();
    save(&fixture.store, &old_preferences).unwrap();
    let committed = private_business(&fixture.store);
    assert!(prepare(&fixture.store, ORGANIZATION, false).unwrap() == old);
    assert!(links(&fixture.store).is_empty());
    assert_eq!(private_business(&fixture.store), committed);
    // Existing receipt replay remains read-first even while new writing waits.
    assert_eq!(
        fixture
            .store
            .commit_action_engine_quote_draft(fixture.input.clone())
            .unwrap(),
        receipt
    );
    assert_eq!(private_business(&fixture.store), committed);
}

#[test]
fn edited_initial_draft_syncs_normally_but_never_becomes_first_creation_evidence() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    fixture
        .store
        .commit_action_engine_quote_draft(fixture.input.clone())
        .unwrap();
    fixture
        .store
        .connect()
        .unwrap()
        .execute(
            "UPDATE quotes SET title='Human edited draft' WHERE id=?",
            [&fixture.input.quote_id],
        )
        .unwrap();
    let pending = prepare(&fixture.store, ORGANIZATION, false).unwrap();
    assert!(links(&fixture.store).is_empty());
    assert_eq!(outbox(&fixture.store)[0]["state"], "pending");
    confirm_sent(&fixture.store, &pending.id, pending.base_revision + 1).unwrap();
    assert!(links(&fixture.store).is_empty());
    assert_eq!(outbox(&fixture.store)[0]["state"], "pending");
}

#[test]
fn another_local_actor_cannot_ack_or_create_the_reservation_owners_link() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    fixture
        .store
        .commit_action_engine_quote_draft(fixture.input.clone())
        .unwrap();
    let original = prepare(&fixture.store, ORGANIZATION, false).unwrap();
    let first = links(&fixture.store);
    fixture.store.connect().unwrap().execute("UPDATE company_local_identity SET user_id='other-synthetic-owner',display_name='Other owner' WHERE id=1", []).unwrap();
    confirm_sent(&fixture.store, &original.id, original.base_revision + 1).unwrap();
    assert_eq!(links(&fixture.store), first);
    assert!(file_path(&fixture.store, &original.id).unwrap().is_file());
    let other = prepare(&fixture.store, ORGANIZATION, false).unwrap();
    assert_ne!(other.id, original.id);
    assert_eq!(links(&fixture.store), first);
    assert_eq!(
        retained_snapshot_ids(&fixture.store.connect().unwrap()).unwrap(),
        vec![original.id]
    );
    assert_eq!(outbox(&fixture.store)[0]["state"], "pending");
}

#[test]
fn ordinary_receive_restores_published_private_links_and_outbox_but_never_exports_them() {
    use std::{fs::File, io::Write};
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    fixture
        .store
        .commit_action_engine_quote_draft(fixture.input.clone())
        .unwrap();
    let pending = prepare(&fixture.store, ORGANIZATION, false).unwrap();
    confirm_sent(&fixture.store, &pending.id, pending.base_revision + 1).unwrap();
    let saved_links = links(&fixture.store);
    let saved_outbox = outbox(&fixture.store);
    let remote = fixture.directory.path().join("received-identical.zentra");
    fixture
        .store
        .create_collaboration_backup_at(
            &remote,
            env!("CARGO_PKG_VERSION"),
            ORGANIZATION,
            &Uuid::new_v4().to_string(),
            2,
        )
        .unwrap();
    let extracted = tempfile::tempdir().unwrap();
    fixture
        .store
        .extract_company_copy(&remote, extracted.path())
        .unwrap();
    let frozen = Connection::open(extracted.path().join("database.sqlite3")).unwrap();
    for table in [
        "company_local_action_engine_quote_publications",
        "company_local_action_engine_publication_schema",
        "company_local_action_engine_quote_outbox",
    ] {
        assert_eq!(
            frozen
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    assert_eq!(
        frozen
            .query_row(
                "SELECT count(*) FROM action_engine_quote_receipts",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    // Model an older/foreign sender that did not strip installation-private
    // rows. Its copy of the same shared receipt does not authenticate its local
    // identity, delivery state or confirmation. Keep the actual ZIP envelope.
    frozen.execute("INSERT INTO company_local_identity VALUES(1,?,'foreign-owner','Foreign owner','owner')", [ORGANIZATION]).unwrap();
    let saved = &saved_outbox[0];
    frozen.execute("INSERT INTO company_local_action_engine_quote_outbox
        (organization_id,proposal_id,quote_id,fingerprint,payload_json,payload_sha256,state,attempt_count,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'confirmed',7,?,'2099-01-01T00:00:00Z')",
        params![saved["organization_id"].as_str().unwrap(),saved["proposal_id"].as_str().unwrap(),
            saved["quote_id"].as_str().unwrap(),saved["fingerprint"].as_str().unwrap(),
            saved["payload_json"].as_str().unwrap(),saved["payload_sha256"].as_str().unwrap(),
            saved["created_at"].as_str().unwrap()]).unwrap();
    frozen.execute_batch("PRAGMA journal_mode=DELETE; VACUUM;").unwrap();
    assert_eq!(frozen.query_row("SELECT user_id FROM company_local_identity WHERE id=1", [], |row| row.get::<_, String>(0)).unwrap(), "foreign-owner");
    assert_eq!(frozen.query_row("SELECT state FROM company_local_action_engine_quote_outbox", [], |row| row.get::<_, String>(0)).unwrap(), "confirmed");
    drop(frozen);
    let unstripped = fixture.directory.path().join("received-unstripped-private.zentra");
    let mut incoming = ZipArchive::new(File::open(&remote).unwrap()).unwrap();
    let mut writer = ZipWriter::new(File::create(&unstripped).unwrap());
    for index in 0..incoming.len() {
        let mut entry = incoming.by_index(index).unwrap();
        let name = entry.name().to_owned();
        writer.start_file(&name, SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
        if name == "database.sqlite3" {
            writer.write_all(&std::fs::read(extracted.path().join("database.sqlite3")).unwrap()).unwrap();
        } else {
            std::io::copy(&mut entry, &mut writer).unwrap();
        }
    }
    writer.finish().unwrap().sync_all().unwrap();
    let imported = LocalStore::initialize(fixture.directory.path().join("other-installation")).unwrap();
    imported.restore_backup(unstripped.to_str().unwrap(), env!("CARGO_PKG_VERSION")).unwrap();
    let imported_db = imported.connect().unwrap();
    for table in ["company_local_identity", "company_local_action_engine_quote_outbox", "company_local_action_engine_quote_publications"] {
        assert_eq!(imported_db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }
    assert_eq!(imported_db.query_row("SELECT count(*) FROM action_engine_quote_receipts", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(imported_db.query_row("SELECT count(*) FROM quotes", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_ne!(crate::member_context::read(&imported_db).unwrap(), crate::member_context::read(&fixture.store.connect().unwrap()).unwrap());
    drop(imported_db);
    apply(
        &fixture.store,
        &unstripped,
        ORGANIZATION,
        2,
        clock(&fixture.store).unwrap(),
        false,
        true,
    )
    .unwrap();
    assert_eq!(links(&fixture.store), saved_links);
    assert_eq!(outbox(&fixture.store), saved_outbox);
    assert!(file_path(&fixture.store, &pending.id).unwrap().is_file());
    assert_eq!(load(&fixture.store).unwrap().revision, 2);
    assert_eq!(fixture.store.verify_audit_log().unwrap()["valid"], true);
}

#[test]
fn pending_received_conflict_and_other_company_block_only_new_writing() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    require_action_engine_quote_write_ready(&fixture.store, ORGANIZATION).unwrap();
    let pending = prepare(&fixture.store, ORGANIZATION, false).unwrap();
    assert!(require_action_engine_quote_write_ready(&fixture.store, ORGANIZATION).is_err());
    for preferences in [
        Preferences {
            received: Some(Received {
                id: pending.id.clone(),
                organization: ORGANIZATION.into(),
                revision: 1,
                clock: pending.clock,
                manifest: pending.manifest.clone(),
                merge: None,
            }),
            ..Preferences::default()
        },
        Preferences {
            conflict: true,
            ..Preferences::default()
        },
        Preferences {
            organization_id: Some("other-company".into()),
            ..Preferences::default()
        },
    ] {
        save(&fixture.store, &preferences).unwrap();
        assert!(require_action_engine_quote_write_ready(&fixture.store, ORGANIZATION).is_err());
    }
    save(&fixture.store, &Preferences::default()).unwrap();
    require_action_engine_quote_write_ready(&fixture.store, ORGANIZATION).unwrap();
    assert!(links(&fixture.store).is_empty());
}

#[test]
fn a_changed_frozen_archive_refuses_link_replay_and_keeps_all_existing_recovery_facts() {
    use std::io::Write;
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    fixture
        .store
        .commit_action_engine_quote_draft(fixture.input.clone())
        .unwrap();
    let pending = prepare(&fixture.store, ORGANIZATION, false).unwrap();
    let before = private_business(&fixture.store);
    let path = file_path(&fixture.store, &pending.id).unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"changed synthetic archive")
        .unwrap();
    assert!(link_prepared(
        &fixture.store,
        ORGANIZATION,
        &pending.id,
        pending.base_revision,
        pending.clock,
        &pending.manifest
    )
    .is_err());
    assert_eq!(private_business(&fixture.store), before);
    assert!(load(&fixture.store).unwrap().pending.is_some());
    assert!(retained_snapshot_ids(&fixture.store.connect().unwrap())
        .unwrap()
        .contains(&pending.id));
}

#[test]
fn orphaned_private_link_is_an_error_instead_of_an_empty_cleanup_pin_set() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    fixture
        .store
        .commit_action_engine_quote_draft(fixture.input.clone())
        .unwrap();
    let pending = prepare(&fixture.store, ORGANIZATION, false).unwrap();
    let db = fixture.store.connect().unwrap();
    db.pragma_update(None, "foreign_keys", false).unwrap();
    db.execute("DELETE FROM company_local_action_engine_quote_outbox WHERE organization_id=? AND proposal_id=?", params![ORGANIZATION, fixture.input.proposal_id]).unwrap();
    assert!(retained_snapshot_ids(&db).is_err());
    assert!(file_path(&fixture.store, &pending.id).unwrap().is_file());
}

#[test]
fn merged_copy_adds_a_candidate_without_replacing_the_prior_retained_archive() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    fixture
        .store
        .commit_action_engine_quote_draft(fixture.input.clone())
        .unwrap();
    let original = prepare(&fixture.store, ORGANIZATION, false).unwrap();
    let first = links(&fixture.store);
    let reference_id = Uuid::new_v4().to_string();
    let reference = file_path(&fixture.store, &reference_id).unwrap();
    fixture
        .store
        .create_collaboration_backup_at(
            &reference,
            env!("CARGO_PKG_VERSION"),
            ORGANIZATION,
            &reference_id,
            1,
        )
        .unwrap();
    let merged = fixture
        .directory
        .path()
        .join("merged-identical-business.zentra");
    let merged_id = Uuid::new_v4().to_string();
    fixture
        .store
        .create_collaboration_backup_at(
            &merged,
            env!("CARGO_PKG_VERSION"),
            ORGANIZATION,
            &merged_id,
            1,
        )
        .unwrap();
    // This test exercises the private post-merge hook using an already merged
    // equal business branch, not conflict selection or remote authorization.
    let received = Received {
        id: merged_id,
        organization: ORGANIZATION.into(),
        revision: 1,
        clock: clock(&fixture.store).unwrap(),
        manifest: crate::cloud_backup::file_manifest(&merged).unwrap(),
        merge: Some(MergeReception {
            local_digest: crate::company_sync_digest::local(&fixture.store).unwrap(),
            reference_id,
            reference_manifest: crate::cloud_backup::file_manifest(&reference).unwrap(),
        }),
    };
    apply_merged(&fixture.store, &received, &merged).unwrap();
    let current = load(&fixture.store).unwrap().pending.unwrap();
    assert_ne!(current.id, original.id);
    assert_eq!(current.base_revision, 1);
    let after = links(&fixture.store);
    assert_eq!(after.len(), 2);
    assert_eq!(
        after.iter().find(|row| row["snapshot_id"] == original.id),
        first.first()
    );
    let pinned = retained_snapshot_ids(&fixture.store.connect().unwrap()).unwrap();
    assert!(pinned.contains(&original.id) && pinned.contains(&current.id));
    assert!(file_path(&fixture.store, &original.id).unwrap().is_file());
    assert!(file_path(&fixture.store, &current.id).unwrap().is_file());
    assert_eq!(outbox(&fixture.store)[0]["state"], "pending");
}
