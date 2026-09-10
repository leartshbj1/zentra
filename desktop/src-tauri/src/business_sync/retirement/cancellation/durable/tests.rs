use super::*;
mod recovery;
use crate::business_sync::{
    cycle,
    replay::delivery::incoming,
    resolution_tests::{self, Fixture},
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

struct Server {
    store: LocalStore,
    proof: Vec<u8>,
    committed: Mutex<Option<Vec<u8>>>,
    calls: Mutex<Vec<String>>,
    failure: Mutex<Option<(StatusCode, Vec<u8>)>>,
    post_failure: Mutex<Option<(StatusCode, Vec<u8>)>>,
    lose_response: AtomicBool,
    disconnect: AtomicBool,
    current: AtomicBool,
    role: String,
    organization: String,
    crash: u8,
}
impl retirement::Transport for Server {
    fn organization(&self) -> &str {
        &self.organization
    }
    fn role(&self) -> &str {
        &self.role
    }
    fn ensure_current(&self, _: &LocalStore) -> AppResult<()> {
        if self.current.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(invalid("Session changed"))
        }
    }
    async fn get(&self, _: &str) -> AppResult<(StatusCode, Vec<u8>)> {
        panic!("Cancellation must never dispatch retirement");
    }
    async fn post(&self, _: Vec<u8>) -> AppResult<(StatusCode, Vec<u8>)> {
        panic!("Cancellation must never dispatch retirement");
    }
}
impl Server {
    fn frozen(&self) {
        let c = self.store.connect().unwrap();
        let value = retirement::load(&c, &self.store).unwrap().unwrap();
        assert_eq!(value.stage, retirement::Stage::Retiring);
        assert!(value.cancellation_requested);
        assert!(c
            .execute(
                "UPDATE clients SET name='Concurrent write' WHERE id='client'",
                []
            )
            .is_err());
    }
}
impl Transport for Server {
    async fn cancellation_get(&self, _: &str) -> AppResult<(StatusCode, Vec<u8>)> {
        self.frozen(); // A distinct SQLite connection sees the flag before HTTP.
        self.calls.lock().unwrap().push("GET".into());
        if let Some(failure) = self.failure.lock().unwrap().take() {
            return Ok(failure);
        }
        Ok(self
            .committed
            .lock()
            .unwrap()
            .clone()
            .map_or((StatusCode::NOT_FOUND, vec![]), |raw| (StatusCode::OK, raw)))
    }
    async fn cancellation_post(&self, body: Vec<u8>) -> AppResult<(StatusCode, Vec<u8>)> {
        self.frozen();
        let frozen = retirement::load(&self.store.connect().unwrap(), &self.store)
            .unwrap()
            .unwrap();
        assert_eq!(body, serde_json::to_vec(&frozen.intent.request()).unwrap());
        self.calls.lock().unwrap().push("POST".into());
        if self.crash == 1 {
            std::process::exit(101);
        }
        if let Some(failure) = self.post_failure.lock().unwrap().take() {
            return Ok(failure);
        }
        *self.committed.lock().unwrap() = Some(self.proof.clone());
        if self.crash > 1 {
            use std::io::Write;
            let mut file =
                std::fs::File::create(self.store.data_dir.join("cancel-server-committed.json"))
                    .unwrap();
            file.write_all(&self.proof).unwrap();
            file.sync_all().unwrap();
            if self.crash == 2 {
                std::process::exit(102);
            }
        }
        if self.disconnect.swap(false, Ordering::SeqCst) {
            self.current.store(false, Ordering::SeqCst);
        }
        if self.lose_response.swap(false, Ordering::SeqCst) {
            return Err(invalid("Response lost after acceptance"));
        }
        Ok((StatusCode::OK, self.proof.clone()))
    }
}
fn proof(f: &Fixture) -> Value {
    let mut proof = resolution_tests::retirement(f);
    proof["format"] = json!("zentra-conflict-retirement-cancellation");
    proof["retired"] = json!(false);
    proof["cancelled"] = json!(true);
    proof
}
fn server(f: &Fixture, proof: &Value) -> Arc<Guarded<Server>> {
    server_for(&f.store, proof)
}
fn server_for(store: &LocalStore, proof: &Value) -> Arc<Guarded<Server>> {
    Arc::new(Guarded::new(
        Server {
            store: store.clone(),
            proof: format!(" \n{}\n", serde_json::to_string_pretty(proof).unwrap()).into_bytes(),
            committed: Mutex::new(None),
            calls: Mutex::new(vec![]),
            failure: Mutex::new(None),
            post_failure: Mutex::new(None),
            lose_response: AtomicBool::new(false),
            disconnect: AtomicBool::new(false),
            current: AtomicBool::new(true),
            role: "owner".into(),
            organization: "org-resolution".into(),
            crash: 0,
        },
        incoming::selection(store, "org-resolution").unwrap(),
        cycle::acquire(store).unwrap(),
    ))
}
fn id(f: &Fixture) -> String {
    f.intent["resolution_id"].as_str().unwrap().into()
}
fn original(c: &Connection) -> Vec<String> {
    c.prepare("SELECT json_array(sequence,generation,transaction_id,table_name,before_json,after_json) FROM business_sync_changes ORDER BY sequence").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}
fn no_ack(c: &Connection) {
    for table in [
        "business_sync_receipts",
        "business_sync_cursor",
        "business_sync_installed_revisions",
        "business_sync_resolutions",
    ] {
        assert_eq!(
            c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn cancellation_storage_requires_exact_full_durability_and_rolls_back_release_with_its_proof() {
    let f = resolution_tests::setup();
    resolution_tests::freeze(&f);
    let mut c = f.store.connect().unwrap();
    let before = original(&c);
    let raw = proof(&f).to_string();
    let insert = |c: &Connection, raw: &str, seal: &str| {
        c.execute("INSERT INTO business_sync_resolution_cancellations VALUES(?1,?2,zentra_sha256(?2),?3,?4,'2026-09-10T00:00:00Z')", params![id(&f),f.intent.to_string(),raw,seal])
    };
    c.pragma_update(None, "synchronous", "FULL").unwrap();
    assert!(
        insert(&c, &raw, &digest(raw.as_bytes())).is_err(),
        "No cancellation requested yet"
    );
    c.execute(
        "UPDATE business_sync_resolution_intent SET state='retiring',cancellation_requested=1",
        [],
    )
    .unwrap();
    assert!(c
        .execute(
            "UPDATE business_sync_resolution_intent SET cancellation_requested=0",
            []
        )
        .is_err());
    c.pragma_update(None, "synchronous", "NORMAL").unwrap();
    assert!(insert(&c, &raw, &digest(raw.as_bytes())).is_err());
    c.pragma_update(None, "synchronous", "FULL").unwrap();
    assert!(insert(&c, &raw, &"f".repeat(64)).is_err());
    let mut forged = proof(&f);
    forged["binding_sha256"] = json!("e".repeat(64));
    let forged = forged.to_string();
    assert!(insert(&c, &forged, &digest(forged.as_bytes())).is_err());
    assert!(c
        .execute("DELETE FROM business_sync_resolution_intent", [])
        .is_err());
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    insert(&tx, &raw, &digest(raw.as_bytes())).unwrap();
    tx.execute("DELETE FROM business_sync_resolution_intent", [])
        .unwrap();
    tx.execute(
        "UPDATE clients SET notes='Must roll back too' WHERE id='client'",
        [],
    )
    .unwrap();
    tx.rollback().unwrap();
    assert!(
        retirement::load(&c, &f.store)
            .unwrap()
            .unwrap()
            .cancellation_requested
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM business_sync_resolution_cancellations",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(original(&c), before);
    assert!(c
        .execute(
            "UPDATE clients SET notes='Still frozen' WHERE id='client'",
            []
        )
        .is_err());
    no_ack(&c);
}

#[test]
fn exact_negative_proof_releases_writes_once_and_permanently_prevents_identity_reuse() {
    tauri::async_runtime::block_on(async {
        let f = resolution_tests::setup();
        resolution_tests::freeze(&f);
        let before = original(&f.store.connect().unwrap());
        let t = server(&f, &proof(&f));
        let Outcome::Cancelled(done) = run(f.store.clone(), t.clone(), id(&f)).await.unwrap()
        else {
            panic!("Expected cancellation");
        };
        assert_eq!(done["cancelled"], true);
        assert_eq!(done["already_cancelled"], false);
        let c = f.store.connect().unwrap();
        assert!(retirement::load(&c, &f.store).unwrap().is_none());
        no_ack(&c);
        assert_eq!(original(&c), before);
        let raw: String = c.query_row("SELECT cancellation_json FROM business_sync_resolution_cancellations WHERE resolution_id=?1", [id(&f)], |r| r.get(0)).unwrap();
        assert_eq!(raw.as_bytes(), t.transport.proof);
        for sql in [
            "DELETE FROM business_sync_resolution_cancellations",
            "UPDATE business_sync_resolution_cancellations SET cancelled_at='changed'",
        ] {
            assert!(c.execute(sql, []).is_err());
        }
        c.pragma_update(None, "synchronous", "FULL").unwrap();
        let tx = c.unchecked_transaction().unwrap();
        let intent = Intent::read(f.intent.to_string().as_bytes()).unwrap();
        assert!(retirement::prepare(&tx, &intent).is_err());
        tx.rollback().unwrap();
        c.execute(
            "UPDATE clients SET notes='Edits enabled after durable proof' WHERE id='client'",
            [],
        )
        .unwrap();
        let again = LocalStore::initialize(f.store.data_dir.clone()).unwrap();
        let Outcome::Cancelled(done) = run(again, t.clone(), id(&f)).await.unwrap() else {
            panic!("Expected durable retry");
        };
        assert_eq!(done["already_cancelled"], true);
        assert_eq!(*t.transport.calls.lock().unwrap(), ["GET", "POST"]);
    });
}

#[test]
fn response_loss_and_session_loss_preserve_the_fence_until_exact_cancellation_is_recovered() {
    tauri::async_runtime::block_on(async {
        for disconnect in [false, true] {
            let f = resolution_tests::setup();
            resolution_tests::freeze(&f);
            let t = server(&f, &proof(&f));
            if disconnect {
                t.transport.disconnect.store(true, Ordering::SeqCst);
            } else {
                t.transport.lose_response.store(true, Ordering::SeqCst);
            }
            assert!(run(f.store.clone(), t.clone(), id(&f)).await.is_err());
            let restarted = LocalStore::initialize(f.store.data_dir.clone()).unwrap();
            assert!(
                retirement::load(&restarted.connect().unwrap(), &restarted)
                    .unwrap()
                    .unwrap()
                    .cancellation_requested
            );
            assert!(
                retirement::run(restarted.clone(), t.clone(), id(&f))
                    .await
                    .is_err(),
                "Must not restart a cancelled retirement dispatch"
            );
            let remote = t.transport.committed.lock().unwrap().clone();
            drop(t);
            let fresh = server(&f, &proof(&f)); // Fresh session and process lease.
            *fresh.transport.committed.lock().unwrap() = remote;
            let Outcome::Cancelled(_) = run(restarted, fresh.clone(), id(&f)).await.unwrap() else {
                panic!("Expected recovered cancellation");
            };
            assert_eq!(*fresh.transport.calls.lock().unwrap(), ["GET"]);
            no_ack(&f.store.connect().unwrap());
        }
    });
}

#[test]
fn missing_forbidden_and_invalid_cancellation_responses_never_release_the_frozen_dossier() {
    tauri::async_runtime::block_on(async {
        let f = resolution_tests::setup();
        resolution_tests::freeze(&f);
        let t = server(&f, &proof(&f));
        let mut wrong = proof(&f);
        wrong["transaction_acknowledged"] = json!(true);
        for (status, raw) in [
            (StatusCode::FORBIDDEN, vec![]),
            (StatusCode::CONFLICT, vec![]),
            (StatusCode::OK, b"{}".to_vec()),
            (StatusCode::OK, wrong.to_string().into_bytes()),
            (StatusCode::OK, vec![b' '; MAX_PROOF_BYTES + 1]),
        ] {
            *t.transport.failure.lock().unwrap() = Some((status, raw));
            assert!(run(f.store.clone(), t.clone(), id(&f)).await.is_err());
            t.transport.frozen();
            assert_eq!(
                f.store
                    .connect()
                    .unwrap()
                    .query_row(
                        "SELECT COUNT(*) FROM business_sync_resolution_cancellations",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
        }
        assert!(t
            .transport
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|call| call == "GET"));
        *t.transport.post_failure.lock().unwrap() = Some((StatusCode::NOT_FOUND, vec![]));
        assert!(run(f.store.clone(), t.clone(), id(&f)).await.is_err());
        t.transport.frozen();
        let Outcome::Cancelled(_) = run(f.store.clone(), t, id(&f)).await.unwrap() else {
            panic!("Expected cancellation after valid proof");
        };
    });
}

#[test]
fn accepted_retirement_is_retained_as_installable_and_cannot_be_cancelled() {
    tauri::async_runtime::block_on(async {
        let f = resolution_tests::setup();
        resolution_tests::freeze(&f);
        let t = server(&f, &resolution_tests::retirement(&f));
        let Outcome::Retired(done) = run(f.store.clone(), t.clone(), id(&f)).await.unwrap() else {
            panic!("Expected retirement winner");
        };
        assert_eq!(done.stage, retirement::Stage::Retired);
        assert!(done.cancellation_requested);
        assert_eq!(done.retirement.unwrap().as_bytes(), t.transport.proof);
        no_ack(&f.store.connect().unwrap());
        let Outcome::Retired(_) = run(f.store.clone(), t.clone(), id(&f)).await.unwrap() else {
            panic!("Cannot cancel an accepted retirement");
        };
        assert_eq!(*t.transport.calls.lock().unwrap(), ["GET", "POST"]);
        assert!(f
            .store
            .connect()
            .unwrap()
            .execute("DELETE FROM business_sync_resolution_intent", [])
            .is_err());
        assert_eq!(
            f.store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM business_sync_resolution_cancellations",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    });
}

#[test]
fn cancellation_rejects_foreign_roles_and_wrong_decisions_before_http() {
    tauri::async_runtime::block_on(async {
        let f = resolution_tests::setup();
        resolution_tests::freeze(&f);
        for (role, org) in [("read_only", "org-resolution"), ("owner", "foreign")] {
            let mut t = server(&f, &proof(&f));
            Arc::get_mut(&mut t).unwrap().transport.role = role.into();
            Arc::get_mut(&mut t).unwrap().transport.organization = org.into();
            assert!(run(f.store.clone(), t.clone(), id(&f)).await.is_err());
            assert!(t.transport.calls.lock().unwrap().is_empty());
        }
        let t = server(&f, &proof(&f));
        assert!(
            run(f.store.clone(), t.clone(), uuid::Uuid::new_v4().to_string())
                .await
                .is_err()
        );
        assert!(t.transport.calls.lock().unwrap().is_empty());
        assert!(
            !retirement::load(&f.store.connect().unwrap(), &f.store)
                .unwrap()
                .unwrap()
                .cancellation_requested
        );
    });
}
