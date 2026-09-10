use super::*;

#[test]
fn resolution_installs_only_the_independently_verified_origin_acknowledgement() {
    tauri::async_runtime::block_on(async {
        let (_root, local, p, before, after) = super::super::super::setup();
        let capture = p.manifest.capture_generation.clone();
        let received = p.manifest.transaction_id.clone();
        let (folder, header) = super::super::super::stage(&local, &p, &before, &after);
        local
            .connect()
            .unwrap()
            .execute(
                "UPDATE clients SET name='Later offline edit' WHERE id='own'",
                [],
            )
            .unwrap();
        let original = evidence(&local, &capture);
        let t = transport(&local, folder, header);
        let mut state = String::new();
        for _ in 0..10 {
            let report = receive_pass(&local, t.as_ref(), 8).await.unwrap();
            state = report["state"].as_str().unwrap().into();
            if state == "transaction_received" {
                break;
            }
        }
        assert_eq!(state, "transaction_received");
        let report = review::process_with_transport(
            local.clone(),
            t.clone(),
            "owner".into(),
            received.clone(),
            Action::Inspect {
                after_sequence: None,
                review_id: None,
            },
            "d".repeat(64),
        )
        .await
        .unwrap();
        assert_eq!(report["confirmed_transaction_id"], received);
        let later = report["transactions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["transaction_id"] != received)
            .unwrap()["transaction_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let request = Request {
            review_id: report["review_id"].as_str().unwrap().into(),
            after_sequence: None,
            decisions: vec![Decision {
                transaction_id: later.clone(),
                choice: Choice::Shared,
            }],
        };
        let id = Uuid::new_v4().to_string();
        review::process_with_transport(
            local.clone(),
            t.clone(),
            "owner".into(),
            received.clone(),
            Action::Save {
                resolution_id: id.clone(),
                request,
            },
            "d".repeat(64),
        )
        .await
        .unwrap();
        let permissions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = permissions.clone();
        let result = application::apply_saved(
            local.clone(),
            t.clone(),
            received.clone(),
            id.clone(),
            "d".repeat(64),
            Arc::new(move || {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }),
        )
        .await
        .unwrap();
        assert_eq!(permissions.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(result["installed"], true);
        assert_eq!(result["acknowledged"], true);
        assert_eq!(result["workspace_changed"], true);
        assert_ne!(result["selection"]["capture_generation"], capture);
        assert_eq!(evidence(&local, &capture), original);
        assert_eq!(acknowledged(&local), 1);
        let c = local.connect().unwrap();
        let (ack, sha): (String, String) = c
            .query_row(
                "SELECT transaction_id,content_sha256 FROM business_sync_receipts",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(ack, received);
        assert_ne!(ack, later);
        assert_eq!(sha, digest(&serde_json::to_vec(&p.manifest).unwrap()));
        assert_eq!(
            c.query_row("SELECT name FROM clients WHERE id='own'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Original"
        );
        drop(c);
        let mut resumed = Arc::new(cycle::Guarded::new(
            Server {
                header: t.transport.header.clone(),
                folder: t.transport.folder.clone(),
                calls: Mutex::new(vec![]),
                fail_once: Mutex::new(false),
                change_history: Mutex::new(None),
                cancel_after_read: Mutex::new(None),
            },
            selection(&local, "org-replay").unwrap(),
            t.lease(),
        ));
        let repeated = application::apply_saved(
            local.clone(),
            resumed.clone(),
            received.clone(),
            id.clone(),
            "reconnected session".into(),
            Arc::new(|| panic!("Already installed")),
        )
        .await
        .unwrap();
        assert_eq!(repeated["already_installed"], true);
        assert_eq!(repeated["acknowledged"], true);
        assert!(resumed.transport.calls.lock().unwrap().is_empty());
        Arc::get_mut(&mut resumed)
            .unwrap()
            .transport
            .header
            .binding
            .organization = "other-company".into();
        assert!(application::apply_saved(
            local.clone(),
            resumed,
            received,
            id,
            "foreign session".into(),
            Arc::new(|| panic!("Foreign company"))
        )
        .await
        .is_err());
        assert_eq!(acknowledged(&local), 1);
    });
}

#[test]
#[ignore = "Child process invoked by the resolution installation recovery test"]
fn resolution_install_process_worker() {
    let store = LocalStore::initialize(PathBuf::from(
        std::env::var("ZENTRA_INSTALL_TEST_PROFILE").unwrap(),
    ))
    .unwrap();
    let id = std::env::var("ZENTRA_INSTALL_TEST_ID").unwrap();
    let after = std::env::var("ZENTRA_INSTALL_TEST_AFTER").unwrap() == "yes";
    let lease = cycle::acquire(&store).unwrap();
    installer::install(
        &store,
        &id,
        || lease.ensure_running(),
        |point| {
            if (!after && matches!(point, installer::Point::FileInstalled(_)))
                || (after && point == installer::Point::Committed)
            {
                std::process::exit(if after { 97 } else { 96 });
            }
            Ok(())
        },
    )
    .unwrap();
    panic!("The process did not reach the installation boundary");
}

#[test]
fn resolution_installs_and_recovers_documents_after_real_process_exit() {
    tauri::async_runtime::block_on(async {
        for after in [false, true] {
            let f = prepared(Choice::Shared).await;
            number(&f.local, 71);
            let original = evidence(&f.local, &f.frozen.intent.capture_generation);
            let id = f.frozen.intent.resolution_id.clone();
            drop(f.transport);
            let mut child=std::process::Command::new(std::env::current_exe().unwrap())
                .args(["business_sync::replay::delivery::incoming::reconciliation::tests::cycle_tests::resolution_install::recovery::resolution_install_process_worker","--exact","--ignored"])
                .env("ZENTRA_INSTALL_TEST_PROFILE",&f.local.data_dir).env("ZENTRA_INSTALL_TEST_ID",&id)
                .env("ZENTRA_INSTALL_TEST_AFTER",if after {"yes"} else {"no"}).spawn().unwrap();
            let start = std::time::Instant::now();
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if start.elapsed() > std::time::Duration::from_secs(60) {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("The installer did not reach the process boundary");
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            };
            assert_eq!(status.code(), Some(if after { 97 } else { 96 }));
            let reopened = LocalStore::initialize(f.local.data_dir.clone()).unwrap();
            assert_eq!(
                fs::read(reopened.attachments_dir.join("drawing.txt")).unwrap(),
                if after {
                    b"shared version".as_slice()
                } else {
                    b"local version".as_slice()
                }
            );
            assert_eq!(
                durable::load(&reopened.connect().unwrap(), &reopened)
                    .unwrap()
                    .is_none(),
                after
            );
            let lease = cycle::acquire(&reopened).unwrap();
            let result =
                installer::install(&reopened, &id, || lease.ensure_running(), |_| Ok(())).unwrap();
            assert_eq!(result["installed"], true);
            assert_eq!(
                fs::read(reopened.attachments_dir.join("drawing.txt")).unwrap(),
                b"shared version"
            );
            assert_private(&reopened, 71);
            assert_eq!(
                evidence(&reopened, &f.frozen.intent.capture_generation),
                original
            );
            assert_eq!(acknowledged(&reopened), 0);
        }
    });
}
