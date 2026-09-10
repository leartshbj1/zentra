//! Native durability and exclusion, independent of authenticated application.
//! The fixtures insert explicit private intents; no retirement is dispatched.
use super::*;
use crate::database::LocalStore;
use rusqlite::params;

pub(super) struct Fixture {
    _directory: tempfile::TempDir,
    pub(super) store: LocalStore,
    pub(super) intent: Value,
    received_receipt: String,
}
pub(super) fn setup() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    let mut c = store.connect().unwrap();
    let tx = c.transaction().unwrap();
    let generation = Uuid::new_v4().to_string();
    let capture = Uuid::new_v4().to_string();
    let bootstrap = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO business_sync_binding VALUES(1,'org-resolution',?,?,1,'2026-09-10')",
        params![store.installation_id, capture],
    )
    .unwrap();
    tx.execute("INSERT INTO business_sync_baseline VALUES(1,'org-resolution',?,?,?,'received','2026-09-10')", params![generation,bootstrap,json!({"organization_id":"org-resolution","generation":generation,"transfer_id":bootstrap,"revision":1}).to_string()]).unwrap();
    install_capture_triggers(&tx).unwrap();
    tx.execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('client','Avant le conflit','2026-09-10','2026-09-10')",[]).unwrap();
    tx.commit().unwrap();
    let received_transaction = Uuid::new_v4().to_string();
    let received_receipt = json!({"organization_id":"org-resolution","generation":generation,"revision":2,"transaction_id":received_transaction}).to_string();
    let receipt_sha256: String = c
        .query_row("SELECT zentra_sha256(?1)", [&received_receipt], |r| {
            r.get(0)
        })
        .unwrap();
    let intent = json!({
        "format":"zentra-conflict-application","version":1,
        "resolution_id":Uuid::new_v4().to_string(),"proposal_sha256":"a".repeat(64),
        "organization_id":"org-resolution","installation_id":store.installation_id,
        "generation":generation,"capture_generation":capture,
        "replacement_capture_generation":Uuid::new_v4().to_string(),
        "source_revision":1,"base_revision":2,"received_transaction_id":received_transaction,
        "first_sequence":"1","last_sequence":"1","receipt_sha256":receipt_sha256,
        "review_id":"c".repeat(64),"decision_sha256":"d".repeat(64)
    });
    Fixture {
        _directory: directory,
        store,
        intent,
        received_receipt,
    }
}
fn insert(c: &Connection, intent: &Value, replace: bool) -> rusqlite::Result<usize> {
    let raw = intent.to_string();
    c.execute(&format!("INSERT {}INTO business_sync_resolution_intent(id,resolution_id,proposal_sha256,intent_json,intent_sha256,state) VALUES(1,?1,?2,?3,zentra_sha256(?3),'prepared')", if replace {"OR REPLACE "} else {""}), params![intent["resolution_id"].as_str(),intent["proposal_sha256"].as_str(),raw])
}
pub(super) fn freeze(f: &Fixture) {
    let c = f.store.connect().unwrap();
    c.pragma_update(None, "synchronous", "FULL").unwrap();
    insert(&c, &f.intent, false).unwrap();
}
pub(super) fn retirement(f: &Fixture) -> Value {
    let intent = retirement::Intent::read(f.intent.to_string().as_bytes()).unwrap();
    let request = intent.request();
    let mut proof = serde_json::to_value(&request).unwrap();
    proof["format"] = json!("zentra-conflict-retirement");
    proof["version"] = json!(1);
    proof["organization_id"] = f.intent["organization_id"].clone();
    proof["installation_id"] = f.intent["installation_id"].clone();
    proof["binding_sha256"] = json!(request.binding_sha256().unwrap());
    proof["registered_at"] = json!("2026-09-10T00:00:00Z");
    proof["retired"] = json!(true);
    proof["transaction_acknowledged"] = json!(false);
    proof["business_revision_changed"] = json!(false);
    proof
}
fn retire(c: &Connection, proof: &Value) -> rusqlite::Result<usize> {
    c.execute("UPDATE business_sync_resolution_intent SET state='retired',retirement_json=?1,retirement_sha256=zentra_sha256(?1) WHERE id=1",[proof.to_string()])
}
fn evidence(c: &Connection) -> Vec<String> {
    c.prepare("SELECT json_array(sequence,generation,transaction_id,table_name,before_json,after_json) FROM business_sync_changes ORDER BY sequence").unwrap().query_map([],|r|r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

#[test]
fn frozen_intent_survives_restart_and_rolls_back_shared_writes_without_acknowledgement() {
    let f = setup();
    let before = evidence(&f.store.connect().unwrap());
    assert!(outgoing::prepare_next(&f.store, "org-resolution", "owner")
        .unwrap()
        .is_some());
    freeze(&f);
    let restarted = LocalStore::initialize(f.store.data_dir.clone()).unwrap();
    let other = restarted.connect().unwrap();
    for sql in [
        "UPDATE clients SET name='Une saisie concurrente' WHERE id='client'",
        "DELETE FROM clients WHERE id='client'",
        "INSERT INTO clients(id,name,created_at,updated_at) VALUES('new','Nouveau','x','x')",
    ] {
        assert!(other
            .execute(sql, [])
            .unwrap_err()
            .to_string()
            .contains("résolution de conflit"));
    }
    assert_eq!(
        other
            .query_row("SELECT name FROM clients WHERE id='client'", [], |r| r
                .get::<_, String>(
                0
            ))
            .unwrap(),
        "Avant le conflit"
    );
    assert_eq!(evidence(&other), before);
    assert!(
        outgoing::prepare_next(&restarted, "org-resolution", "owner")
            .err()
            .unwrap()
            .to_string()
            .contains("résolution de conflit")
    );
    for table in [
        "business_sync_receipts",
        "business_sync_cursor",
        "business_sync_installed_revisions",
        "business_sync_resolutions",
    ] {
        assert_eq!(
            other
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    // Cancellation is safe only before any request could have been dispatched.
    other
        .execute("DELETE FROM business_sync_resolution_intent", [])
        .unwrap();
    other
        .execute(
            "UPDATE clients SET name='Après annulation' WHERE id='client'",
            [],
        )
        .unwrap();
    assert_eq!(evidence(&other).len(), before.len() + 1);
}

#[test]
fn retirement_requires_durable_monotonic_state_and_keeps_uncertain_requests_frozen() {
    let f = setup();
    let c = f.store.connect().unwrap();
    assert!(
        insert(&c, &f.intent, false).is_err(),
        "NORMAL WAL durability is insufficient before dispatch"
    );
    c.pragma_update(None, "synchronous", "FULL").unwrap();
    insert(&c, &f.intent, false).unwrap();
    assert!(
        insert(&c, &f.intent, true).is_err(),
        "REPLACE cannot overwrite a frozen proposal"
    );
    assert!(
        retire(&c, &retirement(&f)).is_err(),
        "Prepared cannot jump past dispatch intent"
    );
    assert!(c.execute("UPDATE business_sync_resolution_intent SET intent_json='{}',intent_sha256=zentra_sha256('{}')",[]).is_err());
    c.execute(
        "UPDATE business_sync_resolution_intent SET state='retiring'",
        [],
    )
    .unwrap();
    drop(c);
    let restarted = LocalStore::initialize(f.store.data_dir.clone()).unwrap();
    let c = restarted.connect().unwrap();
    c.pragma_update(None, "synchronous", "FULL").unwrap();
    assert!(c
        .execute("DELETE FROM business_sync_resolution_intent", [])
        .is_err());
    assert!(c
        .execute(
            "UPDATE business_sync_resolution_intent SET state='prepared'",
            []
        )
        .is_err());
    for field in [
        "resolution_id",
        "organization_id",
        "installation_id",
        "generation",
        "capture_generation",
        "receipt_sha256",
        "review_id",
        "decision_sha256",
        "first_sequence",
        "last_sequence",
        "binding_sha256",
        "registered_at",
        "format",
    ] {
        let mut wrong = retirement(&f);
        wrong[field] = json!("different");
        assert!(retire(&c, &wrong).is_err(), "Mismatched retirement {field}");
    }
    let mut wrong = retirement(&f);
    wrong["transaction_acknowledged"] = json!(true);
    assert!(retire(&c, &wrong).is_err());
    for field in ["version", "retired", "business_revision_changed", "extra"] {
        let mut wrong = retirement(&f);
        wrong[field] = json!(2);
        assert!(retire(&c, &wrong).is_err(), "Unverified proof {field}");
    }
    retire(&c, &retirement(&f)).unwrap();
    assert!(c
        .execute("DELETE FROM business_sync_resolution_intent", [])
        .is_err());
    assert!(c.execute("UPDATE business_sync_resolution_intent SET state='retiring',retirement_json=NULL,retirement_sha256=NULL",[]).is_err());
    assert_eq!(
        c.query_row(
            "SELECT state FROM business_sync_resolution_intent",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "retired"
    );
    assert!(ensure_no_resolution(&c).is_err());
}

#[test]
fn installed_mapping_requires_exact_received_revision_and_is_immutable() {
    let f = setup();
    freeze(&f);
    let c = f.store.connect().unwrap();
    c.pragma_update(None, "synchronous", "FULL").unwrap();
    c.execute(
        "UPDATE business_sync_resolution_intent SET state='retiring'",
        [],
    )
    .unwrap();
    let proof = retirement(&f);
    retire(&c, &proof).unwrap();
    let add = |replace: bool| {
        c.execute(&format!("INSERT {}INTO business_sync_resolutions VALUES(?1,?2,zentra_sha256(?2),?3,zentra_sha256(?3),?4,zentra_sha256(?4),'2026-09-10')",if replace {"OR REPLACE "}else{""}),params![f.intent["resolution_id"].as_str(),f.intent.to_string(),proof.to_string(),json!({"resolution_id":f.intent["resolution_id"],"originals":[]}).to_string()])
    };
    assert!(
        add(false).is_err(),
        "No install without a received revision"
    );
    c.execute(
        "UPDATE business_sync_binding SET generation=?1",
        [f.intent["replacement_capture_generation"].as_str()],
    )
    .unwrap();
    assert!(add(false).is_err(), "A new capture alone is insufficient");
    c.execute("INSERT INTO business_sync_installed_revisions VALUES('org-resolution',?1,2,?2,?3,?4,'2026-09-10')",params![f.intent["generation"].as_str(),f.intent["received_transaction_id"].as_str(),f.intent["receipt_sha256"].as_str(),f.received_receipt]).unwrap();
    add(false).unwrap();
    assert!(add(true).is_err());
    assert!(c
        .execute("DELETE FROM business_sync_resolutions", [])
        .is_err());
    assert!(c
        .execute(
            "UPDATE business_sync_resolutions SET installed_at='changed'",
            []
        )
        .is_err());
    c.execute("DELETE FROM business_sync_resolution_intent", [])
        .unwrap();
    ensure_no_resolution(&c).unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM business_sync_receipts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0,
        "Retirement is never an acknowledgement"
    );
}

#[test]
fn migration_62_preserves_original_business_rows_and_shared_contract() {
    let f = setup();
    let c = f.store.connect().unwrap();
    let before = evidence(&c);
    let contract = snapshot::contract_hash().unwrap();
    c.execute_batch("DROP TABLE business_sync_resolution_cancellations; DROP TRIGGER zentra_resolution_write_guard; DROP TABLE business_sync_resolution_intent; DROP TABLE business_sync_resolutions; PRAGMA user_version=62;").unwrap();
    drop(c);
    let restarted = LocalStore::initialize(f.store.data_dir.clone()).unwrap();
    let c = restarted.connect().unwrap();
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::schema::SCHEMA_VERSION
    );
    assert_eq!(evidence(&c), before);
    assert_eq!(snapshot::contract_hash().unwrap(), contract);
    assert_eq!(DATA_SCHEMA_VERSION, 60);
    c.execute(
        "UPDATE clients SET notes='Après migration' WHERE id='client'",
        [],
    )
    .unwrap();
    assert_eq!(evidence(&c).len(), before.len() + 1);
}

#[test]
fn full_backup_preserves_a_frozen_intent_without_resuming_its_old_capture() {
    let f = setup();
    freeze(&f);
    let c = f.store.connect().unwrap();
    c.pragma_update(None, "synchronous", "FULL").unwrap();
    c.execute(
        "UPDATE business_sync_resolution_intent SET state='retiring'",
        [],
    )
    .unwrap();
    drop(c);
    // Recovery also uses plain SQLite connections. Integrity checks must not
    // depend on application-defined functions embedded in table CHECK clauses.
    let plain = Connection::open(&f.store.database_path).unwrap();
    assert_eq!(
        plain
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(plain);
    let archive = f._directory.path().join("frozen.zentra");
    f.store
        .create_backup_at(&archive, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let restored = LocalStore::initialize(f._directory.path().join("restored")).unwrap();
    restored
        .restore_backup(archive.to_str().unwrap(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    let c = restored.connect().unwrap();
    let (state, raw): (String, String) = c
        .query_row(
            "SELECT state,intent_json FROM business_sync_resolution_intent",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "retiring");
    assert_eq!(raw, f.intent.to_string());
    assert_eq!(
        c.query_row(
            "SELECT capture_enabled FROM business_sync_binding",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_ne!(restored.installation_id, f.store.installation_id);
    assert!(outgoing::prepare_next(&restored, "org-resolution", "owner").is_err());
    assert_eq!(evidence(&c), evidence(&f.store.connect().unwrap()));
}

fn worker(f: &Fixture, mode: &str) -> std::process::ExitStatus {
    std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "business_sync::resolution_tests::resolution_process_worker",
            "--ignored",
            "--exact",
        ])
        .env("ZENTRA_RESOLUTION_WORKER_PROFILE", &f.store.data_dir)
        .env("ZENTRA_RESOLUTION_WORKER_MODE", mode)
        .status()
        .unwrap()
}

#[test]
fn abrupt_process_exit_keeps_the_freeze_for_a_second_process() {
    let f = setup();
    std::fs::write(
        f.store.data_dir.join("resolution-fixture.json"),
        f.intent.to_string(),
    )
    .unwrap();
    let before = evidence(&f.store.connect().unwrap());
    assert_eq!(worker(&f, "freeze-exit").code(), Some(91));
    assert!(worker(&f, "write").success());
    assert_eq!(evidence(&f.store.connect().unwrap()), before);
    assert!(ensure_no_resolution(&f.store.connect().unwrap()).is_err());
}

#[test]
#[ignore = "Child process for durable resolution exclusion"]
fn resolution_process_worker() {
    let directory =
        std::path::PathBuf::from(std::env::var("ZENTRA_RESOLUTION_WORKER_PROFILE").unwrap());
    let store = LocalStore::initialize(directory).unwrap();
    let c = store.connect().unwrap();
    match std::env::var("ZENTRA_RESOLUTION_WORKER_MODE")
        .unwrap()
        .as_str()
    {
        "freeze-exit" => {
            let intent: Value = serde_json::from_slice(
                &std::fs::read(store.data_dir.join("resolution-fixture.json")).unwrap(),
            )
            .unwrap();
            c.pragma_update(None, "synchronous", "FULL").unwrap();
            insert(&c, &intent, false).unwrap();
            c.execute(
                "UPDATE business_sync_resolution_intent SET state='retiring'",
                [],
            )
            .unwrap();
            std::process::exit(91); // Skip destructors and connection cleanup.
        }
        "write" => {
            let error = c
                .execute(
                    "UPDATE clients SET name='Autre processus' WHERE id='client'",
                    [],
                )
                .unwrap_err();
            assert!(error.to_string().contains("résolution de conflit"));
            assert!(outgoing::prepare_next(&store, "org-resolution", "owner").is_err());
        }
        _ => panic!("Unknown fixture action"),
    }
}
