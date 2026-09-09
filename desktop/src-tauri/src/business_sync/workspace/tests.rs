use super::*;
fn setup() -> (tempfile::TempDir, LocalStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    (directory, store)
}
fn payload(work: &Workspace) {
    fs::create_dir(work.path().join("documents")).unwrap();
    fs::write(work.path().join("documents/plan.bin"), vec![7; 128 * 1024]).unwrap();
    fs::write(work.path().join("candidate.sqlite"), b"Disposable model").unwrap();
}
fn abandon(mut work: Workspace) -> PathBuf {
    let path = work.path.clone();
    work.lease.take();
    // Simulates a terminated owner without calling the RAII collector. Real
    // cross-process termination is independently tested below.
    std::mem::forget(work);
    path
}
#[test]
fn normal_drop_removes_only_its_own_workspace_and_cleanup_preserves_live_owners() {
    let (_root, store) = setup();
    fs::write(store.attachments_dir.join("customer.txt"), b"Keep").unwrap();
    let one = Workspace::new(&store, "reconciliation-model").unwrap();
    let two = Workspace::new(&store, "reconciliation-native").unwrap();
    payload(&one);
    payload(&two);
    let one_path = one.path().to_path_buf();
    let two_path = two.path().to_path_buf();
    let summary = cleanup(&store).unwrap();
    assert_eq!(summary.active, 2);
    assert_eq!(summary.removed, 0);
    drop(one);
    assert!(!one_path.exists());
    assert!(two_path.exists());
    drop(two);
    assert!(!two_path.exists());
    assert_eq!(
        fs::read(store.attachments_dir.join("customer.txt")).unwrap(),
        b"Keep"
    );
}
#[test]
fn abandoned_workspace_is_reclaimed_but_foreign_or_unrecognized_directories_are_preserved() {
    let (_root, store) = setup();
    let work = Workspace::new(&store, "reconciliation-files").unwrap();
    payload(&work);
    let path = abandon(work);
    let foreign = Workspace::new(&store, "reconciliation-model").unwrap();
    payload(&foreign);
    let foreign = abandon(foreign);
    let c = Connection::open(foreign.join("lease.sqlite")).unwrap();
    c.execute("UPDATE owner SET installation='foreign'", [])
        .unwrap();
    drop(c);
    let unknown = store
        .data_dir
        .join(DIRECTORY)
        .join(format!("v1-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&unknown).unwrap();
    fs::write(unknown.join("customer.txt"), b"Keep unknown").unwrap();
    let summary = cleanup(&store).unwrap();
    assert_eq!(summary.removed, 1);
    assert_eq!(summary.preserved, 2);
    assert!(!path.exists());
    assert!(foreign.exists());
    assert!(unknown.exists());
}
#[test]
fn another_collector_defers_drop_without_losing_the_eventual_cleanup() {
    let (_root, store) = setup();
    let work = Workspace::new(&store, "reconciliation-files").unwrap();
    payload(&work);
    let path = work.path().to_path_buf();
    let lock = gate(&work.root, Duration::ZERO).unwrap();
    assert!(cleanup(&store).unwrap().deferred);
    drop(work);
    assert!(path.exists());
    drop(lock);
    assert_eq!(cleanup(&store).unwrap().removed, 1);
    assert!(!path.exists());
}
#[test]
fn cleanup_does_not_follow_symlinks_or_remove_a_tree_containing_them() {
    let (root, store) = setup();
    let external = root.path().join("outside");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("customer.txt"), b"Outside business data").unwrap();
    let work = Workspace::new(&store, "reconciliation-files").unwrap();
    payload(&work);
    let path = abandon(work);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&external, path.join("external")).unwrap();
    #[cfg(windows)]
    {
        // Junctions do not require the optional Windows symlink privilege.
        let mut command = std::process::Command::new("powershell.exe");
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        let status=command.args(["-NoProfile","-NonInteractive","-Command","New-Item -ItemType Junction -Path $env:ZENTRA_QA_LINK -Target $env:ZENTRA_QA_TARGET | Out-Null"])
            .env("ZENTRA_QA_LINK",path.join("external")).env("ZENTRA_QA_TARGET",&external).status().unwrap();
        assert!(status.success());
    }
    assert_eq!(cleanup(&store).unwrap().preserved, 1);
    assert!(path.join("documents/plan.bin").exists());
    assert_eq!(
        fs::read(external.join("customer.txt")).unwrap(),
        b"Outside business data"
    );
    // Remove only the test junction/link itself so TempDir teardown never walks
    // it. These exact paths were created above within this isolated fixture.
    #[cfg(windows)]
    fs::remove_dir(path.join("external")).unwrap();
    #[cfg(unix)]
    fs::remove_file(path.join("external")).unwrap();
}
#[test]
#[ignore = "Worker invoked with an isolated profile by process ownership tests"]
fn workspace_process_worker() {
    let store =
        LocalStore::initialize(PathBuf::from(std::env::var("ZENTRA_WORK_PROFILE").unwrap()))
            .unwrap();
    let work = Workspace::new(&store, "reconciliation-native").unwrap();
    payload(&work);
    fs::write(
        store.data_dir.join("worker-ready"),
        work.path().to_string_lossy().as_bytes(),
    )
    .unwrap();
    loop {
        std::thread::sleep(Duration::from_millis(100));
    }
}
#[test]
fn live_process_is_preserved_and_killed_process_is_collected_on_startup() {
    let (_root, store) = setup();
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .args([
            "business_sync::workspace::tests::workspace_process_worker",
            "--ignored",
            "--exact",
            "--nocapture",
        ])
        .env("ZENTRA_WORK_PROFILE", &store.data_dir)
        .spawn()
        .unwrap();
    let ready = store.data_dir.join("worker-ready");
    let started = std::time::Instant::now();
    while !ready.exists() {
        if child.try_wait().unwrap().is_some() {
            panic!("Worker exited before ready");
        }
        if started.elapsed() > Duration::from_secs(90) {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Worker timed out");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let path = PathBuf::from(fs::read_to_string(ready).unwrap());
    let result = cleanup(&store).unwrap();
    assert_eq!(result.active, 1);
    assert_eq!(result.removed, 0);
    assert!(path.exists());
    child.kill().unwrap();
    child.wait().unwrap();
    let restarted = LocalStore::initialize(store.data_dir.clone()).unwrap();
    assert_eq!(restarted.installation_id, store.installation_id);
    assert!(!path.exists());
}
