use super::*;
use std::sync::atomic::AtomicUsize;

fn fixture() -> (tempfile::TempDir, LocalStore, Selection) {
    let root = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(root.path().join("profile")).unwrap();
    let selection = Selection {
        organization_id: "org".into(),
        installation_id: store.installation_id.clone(),
        capture_generation: "capture".into(),
        generation: "history".into(),
        bootstrap_transfer_id: "initial".into(),
    };
    (root, store, selection)
}
#[test]
fn only_an_explicit_current_window_answer_permits_installation() {
    let (_root, store, selection) = fixture();
    let checked = AtomicUsize::new(0);
    request(
        &store,
        &selection,
        || {
            checked.fetch_add(1, Ordering::AcqRel);
            Ok(())
        },
        |event| {
            assert_eq!(event.selection, selection);
            assert!(respond(&store, &event.request_id, true)?);
            assert!(!respond(&store, &event.request_id, true)?);
            Ok(())
        },
        Duration::from_secs(1),
    )
    .unwrap();
    assert!(checked.load(Ordering::Acquire) >= 3);
    let denied = request(
        &store,
        &selection,
        || Ok(()),
        |event| {
            respond(&store, &event.request_id, false)?;
            Ok(())
        },
        Duration::from_secs(1),
    );
    assert!(matches!(denied, Err(AppError::BusinessInstallDeferred)));
}
#[test]
fn timeout_disconnect_and_changed_context_never_grant_permission() {
    let (_root, store, selection) = fixture();
    let last = Mutex::new(String::new());
    let expired = request(
        &store,
        &selection,
        || Ok(()),
        |event| {
            *last.lock().unwrap() = event.request_id;
            Ok(())
        },
        Duration::from_millis(1),
    );
    assert!(matches!(expired, Err(AppError::BusinessInstallDeferred)));
    assert!(!respond(&store, &last.lock().unwrap(), true).unwrap());
    assert!(request(
        &store,
        &selection,
        || Ok(()),
        |_| Err(AppError::BusinessInstallDeferred),
        Duration::from_secs(1)
    )
    .is_err());
    let changed = AtomicBool::new(false);
    let outcome = request(
        &store,
        &selection,
        || {
            if changed.load(Ordering::Acquire) {
                Err(AppError::BusinessSyncPaused)
            } else {
                Ok(())
            }
        },
        |event| {
            respond(&store, &event.request_id, true)?;
            changed.store(true, Ordering::Release);
            Ok(())
        },
        Duration::from_secs(1),
    );
    assert!(matches!(outcome, Err(AppError::BusinessSyncPaused)));
}
#[test]
fn another_profile_cannot_answer_the_installation_request() {
    let (_root, store, selection) = fixture();
    let (_other_root, other, _) = fixture();
    request(
        &store,
        &selection,
        || Ok(()),
        |event| {
            assert!(!respond(&other, &event.request_id, true)?);
            assert!(respond(&store, &event.request_id, true)?);
            Ok(())
        },
        Duration::from_secs(1),
    )
    .unwrap();
}
#[test]
fn scoped_pause_does_not_cancel_numbering_or_another_business_request() {
    let (_root, store, _) = fixture();
    let run = super::super::acquire(&store).unwrap();
    assert!(!super::super::cancel_matching(&store, Some("first")).unwrap());
    run.ensure_running().unwrap();
    run.request_id.set("first".into()).unwrap();
    assert!(!super::super::cancel_matching(&store, Some("second")).unwrap());
    run.ensure_running().unwrap();
    assert!(super::super::cancel_matching(&store, Some("first")).unwrap());
    assert!(matches!(
        run.ensure_running(),
        Err(AppError::BusinessSyncPaused)
    ));
}
