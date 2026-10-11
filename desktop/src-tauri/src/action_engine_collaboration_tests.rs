//! Real SQLite/ZIP receive fixtures. Local synthetic identity and a private
//! input do not establish remote admission or a central reservation.
use super::{action_receipts, apply, clock, load};
use crate::{
    action_engine_quote::{
        ActionEngineQuoteActor, ActionEngineQuoteInput, ActionEngineQuoteSource,
    },
    action_engine_resources::{article_revision, export_resources, resource_hash},
    database::{query_all, LocalStore},
};
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

const ORGANIZATION: &str = "synthetic-action-company";

struct Fixture {
    directory: tempfile::TempDir,
    store: LocalStore,
    request: ActionEngineQuoteInput,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("local")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    let article_id = Uuid::new_v4().to_string();
    let db = store.connect().unwrap();
    db.execute(
        "INSERT INTO company_local_identity VALUES(1,?,'synthetic-owner','Synthetic owner','owner')",
        [ORGANIZATION],
    )
    .unwrap();
    db.execute(
        "UPDATE settings SET vat_registered=1,default_vat_bp=810,updated_at='2026-10-11T00:00:00Z' WHERE id=1",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO catalog_items(id,kind,sku,name,description,unit,sales_price_cents,vat_bp,created_at,updated_at)
         VALUES(?,'product','RAD-100','Radiateur','radiateurs','pièce',19900,810,'2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')",
        [&article_id],
    )
    .unwrap();
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
    let request = ActionEngineQuoteInput {
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
        request,
    }
}

fn archive(store: &LocalStore, path: &Path) {
    store
        .create_collaboration_backup_at(
            path,
            env!("CARGO_PKG_VERSION"),
            ORGANIZATION,
            &Uuid::new_v4().to_string(),
            1,
        )
        .unwrap();
}

fn snapshot(store: &LocalStore) -> Value {
    let db = store.connect().unwrap();
    let mut rows = serde_json::Map::new();
    for table in [
        "clients",
        "catalog_items",
        "quotes",
        "quote_items",
        "document_creators",
        "audit_log",
        "company_local_identity",
        "company_local_member_context",
        "company_local_notes_scope",
        "company_local_clock",
        "action_engine_quote_receipts",
        "company_local_action_engine_quote_outbox",
    ] {
        rows.insert(
            table.into(),
            json!(query_all(&db, &format!("SELECT * FROM {table} ORDER BY 1"), []).unwrap()),
        );
    }
    Value::Object(rows)
}

fn require_receive_refusal(fixture: &Fixture, path: &Path) {
    let before = snapshot(&fixture.store);
    let preferences = serde_json::to_value(load(&fixture.store).unwrap()).unwrap();
    let error = apply(
        &fixture.store,
        path,
        ORGANIZATION,
        2,
        clock(&fixture.store).unwrap(),
        false,
        true,
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("Automation"), "{error}");
    assert!(error.contains("conservées"), "{error}");
    assert!(error.contains("Réunissez les changements"), "{error}");
    assert_eq!(snapshot(&fixture.store), before);
    assert_eq!(
        serde_json::to_value(load(&fixture.store).unwrap()).unwrap(),
        preferences
    );
    assert_eq!(fixture.store.verify_audit_log().unwrap()["valid"], true);
}

#[test]
fn accepting_a_remote_copy_without_local_creation_receipt_rolls_back_all_local_facts() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    let remote = fixture
        .directory
        .path()
        .join("remote-without-receipt.zentra");
    archive(&fixture.store, &remote);
    fixture
        .store
        .commit_action_engine_quote_draft(fixture.request.clone())
        .unwrap();
    assert_eq!(action_receipts(&fixture.store).unwrap().len(), 1);
    assert_eq!(
        snapshot(&fixture.store)["clients"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    require_receive_refusal(&fixture, &remote);
}

#[test]
fn accepting_a_copy_with_identical_creation_receipt_preserves_local_outbox_and_recovery() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    let receipt = fixture
        .store
        .commit_action_engine_quote_draft(fixture.request.clone())
        .unwrap();
    let remote = fixture
        .directory
        .path()
        .join("remote-identical-receipt.zentra");
    archive(&fixture.store, &remote);
    // This private delivery state is absent from the archive and must survive
    // accepting the received company branch instead of being reset to pending.
    fixture.store.connect().unwrap().execute(
        "UPDATE company_local_action_engine_quote_outbox SET state='uncertain',attempt_count=2,updated_at='2099-01-01T00:00:00Z'",
        [],
    ).unwrap();
    fixture
        .store
        .connect()
        .unwrap()
        .execute(
            "UPDATE clients SET name='Unsent local edit' WHERE id=?",
            [&fixture.request.customer_id],
        )
        .unwrap();
    let before = snapshot(&fixture.store);
    apply(
        &fixture.store,
        &remote,
        ORGANIZATION,
        2,
        clock(&fixture.store).unwrap(),
        false,
        true,
    )
    .unwrap();
    let received = snapshot(&fixture.store);
    assert_eq!(
        received["action_engine_quote_receipts"],
        before["action_engine_quote_receipts"]
    );
    assert_eq!(
        received["company_local_action_engine_quote_outbox"],
        before["company_local_action_engine_quote_outbox"]
    );
    assert_eq!(
        received["company_local_identity"],
        before["company_local_identity"]
    );
    assert_eq!(received["clients"][0]["name"], "Camille Exemple");
    assert_eq!(received["quotes"].as_array().unwrap().len(), 1);
    assert_eq!(load(&fixture.store).unwrap().revision, 2);
    let mut retry = fixture.request;
    let db = fixture.store.connect().unwrap();
    retry.expected_workspace_scope = crate::work_notes::workspace_scope(&db).unwrap();
    retry.expected_member_context_nonce = crate::member_context::read(&db).unwrap();
    drop(db);
    assert_eq!(
        fixture
            .store
            .commit_action_engine_quote_draft(retry)
            .unwrap(),
        receipt
    );
    assert_eq!(snapshot(&fixture.store), received);
}

#[test]
fn accepting_a_copy_with_changed_receipt_provenance_under_the_same_key_rolls_back() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let fixture = fixture();
    fixture
        .store
        .commit_action_engine_quote_draft(fixture.request.clone())
        .unwrap();
    let original = fixture.directory.path().join("original-receipt.zentra");
    archive(&fixture.store, &original);
    let remote = LocalStore::initialize(fixture.directory.path().join("remote")).unwrap();
    remote
        .restore_company_snapshot(original.to_str().unwrap(), || Ok(()))
        .unwrap();
    let db = remote.connect().unwrap();
    let trigger: String = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='action_engine_quote_receipt_update'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // Deliberately corrupt only this disposable synthetic branch. Restore the
    // immutable guard before writing the archive: the receiver must reject a
    // changed creation fact even when SQLite checks and schema remain valid.
    db.execute_batch("DROP TRIGGER action_engine_quote_receipt_update")
        .unwrap();
    db.execute(
        "UPDATE action_engine_quote_receipts SET actor_user_id='different-synthetic-user' WHERE organization_id=? AND source_id=?",
        params![ORGANIZATION, fixture.request.source.id],
    ).unwrap();
    db.execute_batch(&trigger).unwrap();
    drop(db);
    crate::backup::validate_database(&remote.database_path).unwrap();
    let changed = fixture
        .directory
        .path()
        .join("remote-changed-receipt.zentra");
    archive(&remote, &changed);
    assert_ne!(
        action_receipts(&fixture.store).unwrap(),
        action_receipts(&remote).unwrap()
    );
    require_receive_refusal(&fixture, &changed);
}
