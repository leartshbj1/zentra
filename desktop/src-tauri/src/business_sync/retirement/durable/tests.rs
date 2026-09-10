use super::*;
use crate::business_sync::{
    cycle,
    replay::delivery::incoming,
    resolution_tests::{self, Fixture},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::{fs, io::Write, path::PathBuf};

struct Server {
    store: LocalStore,
    organization: String,
    role: String,
    current: AtomicBool,
    disconnect: AtomicBool,
    lose_response: AtomicBool,
    hide_once: AtomicBool,
    failure: Mutex<Option<(StatusCode, Vec<u8>)>>,
    proof: Vec<u8>,
    committed: Mutex<Option<Vec<u8>>>,
    posts: Mutex<Vec<Vec<u8>>>,
    calls: Mutex<Vec<String>>,
    crash: Option<(PathBuf, bool)>,
}
impl Transport for Server {
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
        self.calls.lock().unwrap().push("GET".into());
        if let Some(response) = self.failure.lock().unwrap().take() {
            return Ok(response);
        }
        if self.hide_once.swap(false, Ordering::SeqCst) {
            return Ok((StatusCode::NOT_FOUND, vec![]));
        }
        Ok(self
            .committed
            .lock()
            .unwrap()
            .clone()
            .map_or((StatusCode::NOT_FOUND, vec![]), |p| (StatusCode::OK, p)))
    }
    async fn post(&self, body: Vec<u8>) -> AppResult<(StatusCode, Vec<u8>)> {
        // Read through an independent connection at the actual send boundary.
        let c = self.store.connect().unwrap();
        let frozen = load(&c, &self.store).unwrap().unwrap();
        assert_eq!(frozen.stage, Stage::Retiring);
        assert_eq!(body, serde_json::to_vec(&frozen.intent.request()).unwrap());
        assert!(c
            .execute("UPDATE clients SET name='Concurrent' WHERE id='client'", [])
            .is_err());
        self.calls.lock().unwrap().push("POST".into());
        self.posts.lock().unwrap().push(body);
        if let Some((_, false)) = &self.crash {
            std::process::exit(93);
        }
        if let Some(response) = self.failure.lock().unwrap().take() {
            return Ok(response);
        }
        *self.committed.lock().unwrap() = Some(self.proof.clone());
        if let Some((path, true)) = &self.crash {
            let mut file = fs::File::create(path).unwrap();
            file.write_all(&self.proof).unwrap();
            file.sync_all().unwrap();
            std::process::exit(94); // Skip SQLite destructors and async cleanup.
        }
        if self.disconnect.swap(false, Ordering::SeqCst) {
            self.current.store(false, Ordering::SeqCst);
        }
        if self.lose_response.swap(false, Ordering::SeqCst) {
            return Err(invalid("Response lost after server commit"));
        }
        Ok((StatusCode::OK, self.proof.clone()))
    }
}
fn server(f: &Fixture) -> Arc<Guarded<Server>> {
    server_for(&f.store, &resolution_tests::retirement(f))
}
fn server_for(store: &LocalStore, proof: &Value) -> Arc<Guarded<Server>> {
    Arc::new(Guarded::new(
        Server {
            store: store.clone(),
            organization: "org-resolution".into(),
            role: "owner".into(),
            current: AtomicBool::new(true),
            disconnect: AtomicBool::new(false),
            lose_response: AtomicBool::new(false),
            hide_once: AtomicBool::new(false),
            failure: Mutex::new(None),
            // Preserve the exact wire whitespace; never replace it with reserialized JSON.
            proof: format!(" \n{}\n", serde_json::to_string_pretty(proof).unwrap()).into_bytes(),
            committed: Mutex::new(None),
            posts: Mutex::new(vec![]),
            calls: Mutex::new(vec![]),
            crash: None,
        },
        incoming::selection(store, "org-resolution").unwrap(),
        cycle::acquire(store).unwrap(),
    ))
}
fn id(f: &Fixture) -> String {
    f.intent["resolution_id"].as_str().unwrap().into()
}
fn stage(f: &Fixture) -> Stage {
    load(&f.store.connect().unwrap(), &f.store)
        .unwrap()
        .unwrap()
        .stage
}
fn no_ack(f: &Fixture) {
    let c = f.store.connect().unwrap();
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
    assert_eq!(
        c.query_row("SELECT name FROM clients WHERE id='client'", [], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "Avant le conflit"
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM business_sync_changes", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn retirement_dispatch_is_durable_and_exact_proof_survives_restart_without_acknowledging() {
    tauri::async_runtime::block_on(async {
        let f = resolution_tests::setup();
        resolution_tests::freeze(&f);
        let t = server(&f);
        let finished = run(f.store.clone(), t.clone(), id(&f)).await.unwrap();
        assert_eq!(finished.stage, Stage::Retired);
        assert_eq!(
            finished.retirement.as_ref().unwrap().as_bytes(),
            t.transport.proof
        );
        assert_eq!(finished.raw_intent, f.intent.to_string());
        let reopened = LocalStore::initialize(f.store.data_dir.clone()).unwrap();
        let again = run(reopened, t.clone(), id(&f)).await.unwrap();
        assert_eq!(again.raw_intent, finished.raw_intent);
        assert_eq!(again.retirement, finished.retirement);
        assert_eq!(*t.transport.calls.lock().unwrap(), ["POST"]);
        assert!(cancel_prepared(&f.store, &t, &id(&f)).is_err());
        no_ack(&f);
    });
}

#[test]
fn retirement_response_loss_reconnects_without_rewriting_the_frozen_choice() {
    tauri::async_runtime::block_on(async {
        let f = resolution_tests::setup();
        resolution_tests::freeze(&f);
        let t = server(&f);
        t.transport.lose_response.store(true, Ordering::SeqCst);
        assert!(run(f.store.clone(), t.clone(), id(&f)).await.is_err());
        assert_eq!(stage(&f), Stage::Retiring);
        assert!(cancel_prepared(&f.store, &t, &id(&f)).is_err());
        let committed = t.transport.committed.lock().unwrap().clone();
        drop(t); // A new login/process has a new lease, not a new review choice.
        let t = server(&f);
        *t.transport.committed.lock().unwrap() = committed;
        let finished = run(
            LocalStore::initialize(f.store.data_dir.clone()).unwrap(),
            t.clone(),
            id(&f),
        )
        .await
        .unwrap();
        assert_eq!(finished.raw_intent, f.intent.to_string());
        assert_eq!(*t.transport.calls.lock().unwrap(), ["GET"]);
        no_ack(&f);
    });
}

#[test]
fn retirement_invisible_post_retries_identical_bytes_and_never_treats_404_as_cancellation() {
    tauri::async_runtime::block_on(async {
        let f = resolution_tests::setup();
        resolution_tests::freeze(&f);
        let t = server(&f);
        t.transport.lose_response.store(true, Ordering::SeqCst);
        assert!(run(f.store.clone(), t.clone(), id(&f)).await.is_err());
        t.transport.hide_once.store(true, Ordering::SeqCst);
        assert!(cycle::try_acquire(&f.store).unwrap().is_none());
        run(f.store.clone(), t.clone(), id(&f)).await.unwrap();
        let posts = t.transport.posts.lock().unwrap();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0], posts[1]);
        assert_eq!(*t.transport.calls.lock().unwrap(), ["POST", "GET", "POST"]);
        assert_eq!(stage(&f), Stage::Retired);
        no_ack(&f);
    });
}

#[test]
fn retirement_rejects_bad_http_and_wire_proofs_without_releasing_or_acknowledging() {
    tauri::async_runtime::block_on(async {
        let f = resolution_tests::setup();
        resolution_tests::freeze(&f);
        let t = server(&f);
        let mut bad: Value = serde_json::from_slice(&t.transport.proof).unwrap();
        bad["transaction_acknowledged"] = json!(true);
        let mut other = bad.clone();
        other["transaction_acknowledged"] = json!(false);
        other["installation_id"] = json!(uuid::Uuid::new_v4().to_string());
        let duplicate = t.transport.proof.iter().position(|b| *b == b'{').unwrap();
        let mut repeated = t.transport.proof.clone();
        repeated.splice(
            duplicate + 1..duplicate + 1,
            b"\"version\":1,".iter().copied(),
        );
        for response in [
            (StatusCode::OK, bad.to_string().into_bytes()),
            (StatusCode::OK, other.to_string().into_bytes()),
            (StatusCode::OK, repeated),
            (StatusCode::OK, vec![b' '; MAX_PROOF_BYTES + 1]),
            (StatusCode::ACCEPTED, t.transport.proof.clone()),
            (StatusCode::UNAUTHORIZED, vec![]),
            (StatusCode::FORBIDDEN, vec![]),
            (StatusCode::CONFLICT, vec![]),
            (StatusCode::SERVICE_UNAVAILABLE, vec![]),
        ] {
            *t.transport.failure.lock().unwrap() = Some(response);
            assert!(run(f.store.clone(), t.clone(), id(&f)).await.is_err());
            assert_eq!(stage(&f), Stage::Retiring);
            assert!(cancel_prepared(&f.store, &t, &id(&f)).is_err());
            no_ack(&f);
        }
        assert_eq!(t.transport.posts.lock().unwrap().len(), 1);
    });
}

#[test]
fn retirement_checks_account_changes_roles_and_restored_identity_before_dispatch_or_acceptance() {
    tauri::async_runtime::block_on(async {
        let f = resolution_tests::setup();
        resolution_tests::freeze(&f);
        let mut t = server(&f);
        let raw = f.intent.to_string();
        for (org, role) in [("wrong-org", "owner"), ("org-resolution", "read_only")] {
            let server = &mut Arc::get_mut(&mut t).unwrap().transport;
            server.organization = org.into();
            server.role = role.into();
            assert!(run(f.store.clone(), t.clone(), id(&f)).await.is_err());
            assert_eq!(stage(&f), Stage::Prepared);
            assert!(t.transport.calls.lock().unwrap().is_empty());
        }
        Arc::get_mut(&mut t).unwrap().transport.role = "owner".into();
        t.transport.disconnect.store(true, Ordering::SeqCst);
        assert!(run(f.store.clone(), t.clone(), id(&f)).await.is_err());
        assert_eq!(stage(&f), Stage::Retiring);
        t.transport.current.store(true, Ordering::SeqCst);
        let done = run(f.store.clone(), t.clone(), id(&f)).await.unwrap();
        assert_eq!(done.raw_intent, raw);
        let mut restored = f.store.clone();
        restored.installation_id = uuid::Uuid::new_v4().to_string();
        assert!(run(restored, t.clone(), id(&f)).await.is_err());
        f.store
            .connect()
            .unwrap()
            .execute("UPDATE business_sync_binding SET capture_enabled=0", [])
            .unwrap();
        assert!(run(f.store.clone(), t.clone(), id(&f)).await.is_err());
        assert_eq!(*t.transport.calls.lock().unwrap(), ["POST", "GET"]);
        no_ack(&f);
    });
}

#[test]
fn retirement_pre_dispatch_cancellation_requires_the_exact_intent_and_preserves_business_data() {
    let f = resolution_tests::setup();
    resolution_tests::freeze(&f);
    let t = server(&f);
    assert!(cancel_prepared(&f.store, &t, &uuid::Uuid::new_v4().to_string()).is_err());
    assert_eq!(stage(&f), Stage::Prepared);
    cancel_prepared(&f.store, &t, &id(&f)).unwrap();
    assert!(load(&f.store.connect().unwrap(), &f.store)
        .unwrap()
        .is_none());
    assert!(t.transport.calls.lock().unwrap().is_empty());
    no_ack(&f);
    f.store
        .connect()
        .unwrap()
        .execute(
            "UPDATE clients SET name='Allowed again' WHERE id='client'",
            [],
        )
        .unwrap();
}

#[test]
#[ignore = "Separate process invoked by retirement_dispatch_recovers_after_abrupt_process_exit"]
fn retirement_dispatch_process_worker() {
    let store = LocalStore::initialize(PathBuf::from(
        std::env::var("ZENTRA_RETIREMENT_TEST_PROFILE").unwrap(),
    ))
    .unwrap();
    let proof: Value = serde_json::from_slice(
        &fs::read(store.data_dir.join("retirement-server-proof.json")).unwrap(),
    )
    .unwrap();
    let mut t = server_for(&store, &proof);
    Arc::get_mut(&mut t).unwrap().transport.crash = Some((
        store.data_dir.join("server-committed.json"),
        std::env::var("ZENTRA_RETIREMENT_TEST_COMMIT").unwrap() == "yes",
    ));
    let id = proof["resolution_id"].as_str().unwrap().to_owned();
    tauri::async_runtime::block_on(run(store, t, id)).unwrap();
    panic!("The process exit boundary was not reached");
}

#[test]
fn retirement_dispatch_recovers_after_abrupt_process_exit_before_and_after_server_acceptance() {
    tauri::async_runtime::block_on(async {
        for committed in [false, true] {
            let f = resolution_tests::setup();
            resolution_tests::freeze(&f);
            fs::write(
                f.store.data_dir.join("retirement-server-proof.json"),
                resolution_tests::retirement(&f).to_string(),
            )
            .unwrap();
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "business_sync::retirement::durable::tests::retirement_dispatch_process_worker",
                    "--exact",
                    "--ignored",
                ])
                .env("ZENTRA_RETIREMENT_TEST_PROFILE", &f.store.data_dir)
                .env(
                    "ZENTRA_RETIREMENT_TEST_COMMIT",
                    if committed { "yes" } else { "no" },
                )
                .spawn()
                .unwrap();
            let started = std::time::Instant::now();
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if started.elapsed() > std::time::Duration::from_secs(60) {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("The process worker did not reach the boundary");
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            };
            assert_eq!(status.code(), Some(if committed { 94 } else { 93 }));
            assert_eq!(stage(&f), Stage::Retiring);
            let t = server(&f); // Acquires the SQL lease left by the dead process.
            let path = f.store.data_dir.join("server-committed.json");
            assert_eq!(path.exists(), committed);
            if committed {
                *t.transport.committed.lock().unwrap() = Some(fs::read(path).unwrap());
            }
            let done = run(
                LocalStore::initialize(f.store.data_dir.clone()).unwrap(),
                t.clone(),
                id(&f),
            )
            .await
            .unwrap();
            assert_eq!(done.stage, Stage::Retired);
            assert_eq!(done.raw_intent, f.intent.to_string());
            assert_eq!(
                t.transport.posts.lock().unwrap().len(),
                usize::from(!committed)
            );
            assert_eq!(t.transport.calls.lock().unwrap()[0], "GET");
            no_ack(&f);
        }
    });
}
