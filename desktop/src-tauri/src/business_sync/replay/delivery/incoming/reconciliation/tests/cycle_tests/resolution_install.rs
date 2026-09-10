use super::conflict_review::drawing;
use super::*;
mod recovery;
use crate::business_sync::{
    replay::delivery::incoming::reconciliation::{
        application,
        review::{self, Action},
        saved::installation as installer,
    },
    replay::reconciliation::resolution::{Choice, Decision, Request},
    retirement::durable,
};

struct Fixture {
    _root: tempfile::TempDir,
    _other: tempfile::TempDir,
    local: LocalStore,
    transport: Arc<cycle::Guarded<Server>>,
    frozen: durable::Frozen,
}
async fn prepared(choice: Choice) -> Fixture {
    let (root, local, context) = replay::tests::setup_with(|s| {
        drawing(s, &s.connect().unwrap(), "drawing.txt", b"original")
    });
    let (other_root, other) = replay::tests::copy_receiver(&local);
    fs::write(other.attachments_dir.join("drawing.txt"), b"original").unwrap();
    for (store, bytes) in [
        (&local, b"local version".as_slice()),
        (&other, b"shared version".as_slice()),
    ] {
        let mut c = store.connect().unwrap();
        let tx = c.transaction().unwrap();
        tx.execute("DELETE FROM attachments WHERE id='drawing-review'", [])
            .unwrap();
        drawing(store, &tx, "drawing.txt", bytes);
        tx.commit().unwrap();
    }
    let sent = outgoing::prepare_next(&other, "org-replay", "owner")
        .unwrap()
        .unwrap();
    let shared = replay::state_fingerprint(&other.connect().unwrap()).unwrap();
    let (folder, header) = stage_from(&local, &other, &sent, &context.source_state_sha256, &shared);
    let transaction = header.entry.transaction_id.clone();
    let t = transport(&local, folder, header);
    let mut state = String::new();
    for _ in 0..10 {
        let result = cycle::pass(local.clone(), t.clone(), true).await.unwrap();
        state = result["state"].as_str().unwrap().into();
        if state != "receiving" {
            break;
        }
    }
    assert_eq!(state, "conflict");
    let report = review::process_with_transport(
        local.clone(),
        t.clone(),
        "owner".into(),
        transaction.clone(),
        Action::Inspect {
            after_sequence: None,
            review_id: None,
        },
        "d".repeat(64),
    )
    .await
    .unwrap();
    let id = Uuid::new_v4().to_string();
    let request = Request {
        review_id: report["review_id"].as_str().unwrap().into(),
        after_sequence: None,
        decisions: vec![Decision {
            transaction_id: report["transactions"][0]["transaction_id"]
                .as_str()
                .unwrap()
                .into(),
            choice,
        }],
    };
    review::process_with_transport(
        local.clone(),
        t.clone(),
        "owner".into(),
        transaction.clone(),
        Action::Save {
            resolution_id: id.clone(),
            request,
        },
        "d".repeat(64),
    )
    .await
    .unwrap();
    let frozen = application::retire_saved(
        local.clone(),
        t.clone(),
        transaction,
        id,
        "d".repeat(64),
        Arc::new(|| Ok(())),
    )
    .await
    .unwrap();
    Fixture {
        _root: root,
        _other: other_root,
        local,
        transport: t,
        frozen,
    }
}
fn evidence(store: &LocalStore, capture: &str) -> Vec<String> {
    store.connect().unwrap().prepare("SELECT json_array(sequence,generation,transaction_id,table_name,row_key_json,before_json,after_json,source_rowid,base_revision) FROM business_sync_changes WHERE generation=?1 ORDER BY sequence").unwrap()
        .query_map([capture],|r|r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}
fn number(store: &LocalStore, value: i64) {
    store.connect().unwrap().execute("INSERT INTO number_sequences(document_type,year,next_value) VALUES('invoice',2099,?1) ON CONFLICT(document_type,year) DO UPDATE SET next_value=excluded.next_value",[value]).unwrap();
}
fn assert_private(store: &LocalStore, value: i64) {
    assert_eq!(store.connect().unwrap().query_row("SELECT next_value FROM number_sequences WHERE document_type='invoice' AND year=2099",[],|r|r.get::<_,i64>(0)).unwrap(),value);
}

#[test]
fn resolution_installs_shared_or_local_choice_preserving_recent_private_state_and_original_events()
{
    tauri::async_runtime::block_on(async {
        for choice in [Choice::Shared, Choice::Local] {
            let f = prepared(choice).await;
            let id = &f.frozen.intent.resolution_id;
            let original = evidence(&f.local, &f.frozen.intent.capture_generation);
            let original_state = replay::state_fingerprint(&f.local.connect().unwrap()).unwrap();
            // A private allocation arriving after retirement must survive the
            // stale private copy stored with the original proposal.
            number(&f.local, 41);
            let changed = std::cell::Cell::new(false);
            let rejected = installer::install(
                &f.local,
                id,
                || Transport::ensure_current(f.transport.as_ref(), &f.local),
                |point| {
                    if point == installer::Point::Prepared && !changed.replace(true) {
                        number(&f.local, 42);
                    }
                    Ok(())
                },
            );
            assert!(rejected.is_err());
            assert!(
                changed.get(),
                "Preparation failed before the concurrent edit: {rejected:?}"
            );
            assert_private(&f.local, 42);
            assert_eq!(
                replay::state_fingerprint(&f.local.connect().unwrap()).unwrap(),
                original_state
            );
            // A failure after file replacement restores the original bytes;
            // the retirement fence remains so the same choice can be retried.
            assert!(installer::install(
                &f.local,
                id,
                || Transport::ensure_current(f.transport.as_ref(), &f.local),
                |point| {
                    if point == installer::Point::BeforeCommit {
                        Err(invalid("Interrupted before SQLite commit"))
                    } else {
                        Ok(())
                    }
                }
            )
            .is_err());
            assert_eq!(
                fs::read(f.local.attachments_dir.join("drawing.txt")).unwrap(),
                b"local version"
            );
            assert_eq!(
                durable::load(&f.local.connect().unwrap(), &f.local)
                    .unwrap()
                    .unwrap()
                    .stage,
                durable::Stage::Retired
            );
            assert_eq!(
                evidence(&f.local, &f.frozen.intent.capture_generation),
                original
            );
            // A lost response AFTER SQLite commit must recover as installed.
            assert!(installer::install(
                &f.local,
                id,
                || Transport::ensure_current(f.transport.as_ref(), &f.local),
                |point| {
                    if point == installer::Point::Committed {
                        Err(invalid("Response lost after SQLite commit"))
                    } else {
                        Ok(())
                    }
                }
            )
            .is_err());
            let reopened = LocalStore::initialize(f.local.data_dir.clone()).unwrap();
            assert!(durable::load(&reopened.connect().unwrap(), &reopened)
                .unwrap()
                .is_none());
            let result = installer::install(
                &reopened,
                id,
                || Ok(()),
                |_| panic!("A completed resolution must not run twice"),
            )
            .unwrap();
            assert_eq!(result["installed"], true);
            assert_eq!(result["already_installed"], true);
            assert_eq!(result["acknowledged"], false);
            assert_private(&reopened, 42);
            assert_eq!(
                evidence(&reopened, &f.frozen.intent.capture_generation),
                original
            );
            let raw: String = reopened
                .connect()
                .unwrap()
                .query_row(
                    "SELECT mapping_json FROM business_sync_resolutions WHERE resolution_id=?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            let plan: merge::replacements::Plan = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                replay::state_fingerprint(&reopened.connect().unwrap()).unwrap(),
                plan.replacement_state_sha256
            );
            assert_eq!(
                fs::read(reopened.attachments_dir.join("drawing.txt")).unwrap(),
                if matches!(choice, Choice::Local) {
                    b"local version".as_slice()
                } else {
                    b"shared version".as_slice()
                }
            );
            assert_eq!(acknowledged(&reopened), 0);
            let outgoing = outgoing::prepare_next(&reopened, "org-replay", "owner").unwrap();
            if matches!(choice, Choice::Local) {
                let outgoing = outgoing.unwrap();
                assert_eq!(
                    outgoing.manifest.capture_generation,
                    plan.replacement_capture_generation
                );
                assert_eq!(
                    outgoing.manifest.transaction_id,
                    plan.transactions[0].transaction_id
                );
            } else {
                assert!(outgoing.is_none());
            }
        }
    });
}
