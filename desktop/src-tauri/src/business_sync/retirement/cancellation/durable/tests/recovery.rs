use super::*;
use std::{fs, path::PathBuf};

#[test]
fn complete_backup_retains_immutable_cancellation_but_restores_an_unbound_installation() {
    tauri::async_runtime::block_on(async {
        let f = resolution_tests::setup();
        resolution_tests::freeze(&f);
        let t = server(&f, &proof(&f));
        let Outcome::Cancelled(_) = run(f.store.clone(), t.clone(), id(&f)).await.unwrap() else {
            panic!("Expected cancellation");
        };
        drop(t);
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("cancelled.zentra");
        f.store
            .create_backup_at(&archive, env!("CARGO_PKG_VERSION"))
            .unwrap();
        let restored = LocalStore::initialize(directory.path().join("restored")).unwrap();
        restored
            .restore_backup(archive.to_str().unwrap(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        let c = restored.connect().unwrap();
        let saved: String = c.query_row("SELECT cancellation_json FROM business_sync_resolution_cancellations WHERE resolution_id=?1", [id(&f)], |r| r.get(0)).unwrap();
        super::super::Receipt::read(
            saved.as_bytes(),
            &Intent::read(f.intent.to_string().as_bytes()).unwrap(),
        )
        .unwrap();
        assert_ne!(restored.installation_id, f.store.installation_id);
        assert_eq!(
            c.query_row(
                "SELECT capture_enabled FROM business_sync_binding",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(original(&c), original(&f.store.connect().unwrap()));
        no_ack(&c);
        let t = server_for(&f.store, &proof(&f));
        assert!(run(restored, t.clone(), id(&f)).await.is_err());
        assert!(t.transport.calls.lock().unwrap().is_empty());
    });
}

#[test]
#[ignore = "Child process invoked by cancellation_recovers_across_abrupt_exits"]
fn cancellation_process_worker() {
    let store = LocalStore::initialize(PathBuf::from(
        std::env::var("ZENTRA_CANCELLATION_PROFILE").unwrap(),
    ))
    .unwrap();
    let proof: Value =
        serde_json::from_slice(&fs::read(store.data_dir.join("cancel-server-proof.json")).unwrap())
            .unwrap();
    let phase: u8 = std::env::var("ZENTRA_CANCELLATION_EXIT")
        .unwrap()
        .parse()
        .unwrap();
    let mut t = server_for(&store, &proof);
    Arc::get_mut(&mut t).unwrap().transport.crash = phase;
    let id = proof["resolution_id"].as_str().unwrap().to_owned();
    let done = tauri::async_runtime::block_on(run(store, t, id)).unwrap();
    assert!(matches!(done, Outcome::Cancelled(_)));
    assert_eq!(phase, 3);
    std::process::exit(103); // Durable local completion, no Rust destructors.
}

#[test]
fn cancellation_recovers_across_abrupt_exits_before_server_after_server_and_after_local_commit() {
    tauri::async_runtime::block_on(async {
        for phase in [1, 2, 3] {
            let f = resolution_tests::setup();
            resolution_tests::freeze(&f);
            let before = original(&f.store.connect().unwrap());
            fs::write(
                f.store.data_dir.join("cancel-server-proof.json"),
                proof(&f).to_string(),
            )
            .unwrap();
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["business_sync::retirement::cancellation::durable::tests::recovery::cancellation_process_worker", "--exact", "--ignored"])
                .env("ZENTRA_CANCELLATION_PROFILE", &f.store.data_dir)
                .env("ZENTRA_CANCELLATION_EXIT", phase.to_string()).spawn().unwrap();
            let started = std::time::Instant::now();
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if started.elapsed() > std::time::Duration::from_secs(60) {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("Cancellation worker failed to reach its boundary");
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            };
            assert_eq!(status.code(), Some(100 + phase));
            let restarted = LocalStore::initialize(f.store.data_dir.clone()).unwrap();
            let frozen = retirement::load(&restarted.connect().unwrap(), &restarted).unwrap();
            if phase < 3 {
                let frozen = frozen.unwrap();
                assert!(frozen.cancellation_requested);
                assert_eq!(frozen.stage, retirement::Stage::Retiring);
            } else {
                assert!(frozen.is_none());
            }
            let t = server_for(&restarted, &proof(&f));
            let remote = restarted.data_dir.join("cancel-server-committed.json");
            assert_eq!(remote.exists(), phase > 1);
            if remote.exists() {
                *t.transport.committed.lock().unwrap() = Some(fs::read(remote).unwrap());
            }
            let Outcome::Cancelled(done) = run(restarted.clone(), t.clone(), id(&f)).await.unwrap()
            else {
                panic!("Expected recovery");
            };
            assert_eq!(done["already_cancelled"], phase == 3);
            let expected: &[&str] = match phase {
                1 => &["GET", "POST"],
                2 => &["GET"],
                _ => &[],
            };
            assert_eq!(*t.transport.calls.lock().unwrap(), expected);
            assert_eq!(original(&restarted.connect().unwrap()), before);
            no_ack(&restarted.connect().unwrap());
            restarted
                .connect()
                .unwrap()
                .execute(
                    "UPDATE clients SET notes='After recovery' WHERE id='client'",
                    [],
                )
                .unwrap();
        }
    });
}
