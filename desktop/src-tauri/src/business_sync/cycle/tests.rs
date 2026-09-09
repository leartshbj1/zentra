use super::*;

#[test]
fn cycle_gate_is_profile_scoped_and_retained_until_last_worker_drops() {
    let root = tempfile::tempdir().unwrap();
    let first = LocalStore::initialize(root.path().join("a")).unwrap();
    let second = LocalStore::initialize(root.path().join("b")).unwrap();
    let gate = acquire(&first).unwrap();
    let worker = gate.clone();
    assert!(try_acquire(&first).unwrap().is_none());
    assert!(try_acquire(&second).unwrap().is_some());
    assert!(cancel(&first).unwrap());
    assert!(gate.cancelled.load(Ordering::Acquire));
    drop(gate);
    assert!(
        try_acquire(&first).unwrap().is_none(),
        "A cancelled worker still owns the lease"
    );
    drop(worker);
    let resumed = acquire(&first).unwrap();
    assert!(!resumed.cancelled.load(Ordering::Acquire));
    drop(resumed);
    assert!(!cancel(&first).unwrap());
}

#[test]
fn cycle_gate_refuses_a_replaced_unknown_registry() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(root.path().join("profile")).unwrap();
    let gate = acquire(&store).unwrap();
    drop(gate);
    let c = Connection::open(store.data_dir.join("business-cycle/registry.sqlite")).unwrap();
    c.pragma_update(None, "application_id", 17).unwrap();
    drop(c);
    assert!(try_acquire(&store).is_err());
}

#[test]
fn cycle_gate_excludes_a_second_process_and_survives_owner_exit() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(root.path().join("profile")).unwrap();
    let gate = acquire(&store).unwrap();
    let child = |busy: bool| {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "business_sync::cycle::tests::cycle_gate_child",
                "--ignored",
                "--nocapture",
            ])
            .env("ZENTRA_CYCLE_GATE_PROFILE", &store.data_dir)
            .env("ZENTRA_CYCLE_GATE_BUSY", if busy { "1" } else { "0" })
            .output()
            .unwrap()
    };
    let result = child(true);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
    drop(gate);
    let result = child(false);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
    // The successful child exits while its SQLite lease is still alive.
    assert!(try_acquire(&store).unwrap().is_some());
}

#[test]
#[ignore = "Child process of the cycle-gate ownership test"]
fn cycle_gate_child() {
    let path = PathBuf::from(std::env::var("ZENTRA_CYCLE_GATE_PROFILE").unwrap());
    let store = LocalStore::initialize(path).unwrap();
    let expected_busy = std::env::var("ZENTRA_CYCLE_GATE_BUSY").unwrap() == "1";
    let lease = try_acquire(&store).unwrap();
    assert_eq!(lease.is_none(), expected_busy);
    std::process::exit(0);
}
