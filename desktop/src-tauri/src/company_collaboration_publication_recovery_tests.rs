//! Real pending archives, preferences and confirmation workers with an injected
//! probe/commit transport. The small client facsimile observes the probe/head/
//! merge ordering; it does not prove HTTP, PostgreSQL/D1, or the full Tauri command.
//! Native compilation/execution is required before this code can be released.
use super::*;
use std::sync::{Arc, Mutex};

const ORGANIZATION: &str = "publication-recovery-fictitious-company";

fn fixture() -> (tempfile::TempDir, LocalStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    store.complete_onboarding(crate::tests::test_onboarding(), "publication-recovery-test").unwrap();
    set_identity(&store, ORGANIZATION, "fictitious-owner", "Fictitious Owner", "owner").unwrap();
    store.create_record("clients", json!({"name":"Fictitious original client"})).unwrap();
    (directory, store)
}

fn prepared(store: &LocalStore) -> Pending {
    tauri::async_runtime::block_on(async {
        let _account = store.account_protected_cache.operation_lock.lock().await;
        prepare_for_send_worker(store, ORGANIZATION, true).await.unwrap().0
    })
}

fn recovered<F, Fut>(store: &LocalStore, transport: F) -> AppResult<bool>
where
    F: FnOnce(Value) -> Fut,
    Fut: std::future::Future<Output = AppResult<Value>>,
{
    let mut once = Some(transport);
    recovered_flow(store, move |body| {
        once.take().expect("this fixture must not commit after its receipt response")(body)
    })
}

fn recovered_flow<F, Fut>(store: &LocalStore, transport: F) -> AppResult<bool>
where
    F: FnMut(Value) -> Fut,
    Fut: std::future::Future<Output = AppResult<Value>>,
{
    tauri::async_runtime::block_on(async {
        let _account = store.account_protected_cache.operation_lock.lock().await;
        recover_pending_publication_with(store, ORGANIZATION, transport).await
    })
}

fn receipt(pending: &Pending) -> Value {
    json!({"known":true,"committed":true,"revision":pending.base_revision + 1,"snapshotId":pending.id})
}

fn fixed_files(store: &LocalStore) -> Vec<Option<Vec<u8>>> {
    [STATE, "company-sync-reference.zentra", "company-sync-baseline.json"].iter().map(|name| {
        let path = store.data_dir.join(name);
        path.is_file().then(|| fs::read(path).unwrap())
    }).collect()
}

fn assert_probe(body: &Value, pending: &Pending) {
    assert_eq!(body, &json!({"action":"recover-publication","id":pending.id,
        "baseRevision":pending.base_revision,"manifest":pending.manifest}));
    assert!(body.get("entries").is_none());
    assert!(body.get("numbers").is_none());
}

#[test]
fn receipt_probe_precedes_a_newer_head_merge_without_uploading_and_keeps_post_snapshot_changes_dirty() {
    let (_directory, store) = fixture();
    let pending = prepared(&store);
    assert_eq!(pending.base_revision, 0);
    let original = fs::read(file_path(&store, &pending.id).unwrap()).unwrap();
    assert!(!store.data_dir.join("company-sync-reference.zentra").exists());
    store.create_record("clients", json!({"name":"Fictitious edit after the snapshot"})).unwrap();
    let live_clock = clock(&store).unwrap();
    let live_digest = crate::company_sync_digest::local(&store).unwrap();
    assert!(live_clock > pending.clock);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let observed = calls.clone();
    let expected = pending.clone();
    assert!(recovered(&store, move |body| async move {
        assert_probe(&body, &expected);
        observed.lock().unwrap().push("recover-publication");
        Ok(receipt(&expected))
    }).unwrap());
    // Client facsimile: only after the probe may the fresh head select a merge.
    // The recovered local reference no longer needs its pruned server copy.
    calls.lock().unwrap().push("GET head");
    let newer_head = json!({"organizationId":ORGANIZATION,"revision":12});
    let prefs = load(&store).unwrap();
    assert_eq!(prefs.revision, 1, "never acknowledge with the current head's revision");
    assert_eq!(prefs.base_clock, pending.clock);
    assert!(prefs.pending.is_none());
    assert_eq!(fs::read(store.data_dir.join("company-sync-reference.zentra")).unwrap(), original);
    assert_eq!(clock(&store).unwrap(), live_clock);
    assert_eq!(crate::company_sync_digest::local(&store).unwrap(), live_digest);
    assert_eq!(status(&store).unwrap()["pending"], true);
    assert!(newer_head["revision"].as_u64().unwrap() > prefs.revision);
    calls.lock().unwrap().push("merge using recovered reference");
    assert_eq!(*calls.lock().unwrap(), ["recover-publication", "GET head", "merge using recovered reference"]);
}

#[test]
fn every_existing_pending_protocol_uses_only_the_receipt_probe_and_original_manifest() {
    for content_version in [0, 1, 2] {
        let (_directory, store) = fixture();
        let mut pending = prepared(&store);
        pending.content_version = content_version;
        let mut manifest = serde_json::to_value(&pending.manifest).unwrap();
        manifest["app_version"] = json!("1.90.12");
        pending.manifest = serde_json::from_value(manifest).unwrap();
        let mut prefs = load(&store).unwrap();
        prefs.pending = Some(pending.clone());
        save(&store, &prefs).unwrap();
        let expected = pending.clone();
        assert!(recovered(&store, move |body| async move {
            assert_probe(&body, &expected);
            Ok(receipt(&expected))
        }).unwrap());
        assert_eq!(load(&store).unwrap().revision, 1);
        assert!(load(&store).unwrap().pending.is_none());
    }
}

#[test]
fn known_false_retains_the_exact_pending_and_allows_the_existing_client_flow() {
    let (_directory, store) = fixture();
    let pending = prepared(&store);
    let before = fixed_files(&store);
    let digest = crate::company_sync_digest::local(&store).unwrap();
    let expected = pending.clone();
    let recovered = recovered(&store, move |body| async move {
        assert_probe(&body, &expected);
        Ok(json!({"known":false}))
    }).unwrap();
    assert!(!recovered, "the caller must retain its preexisting prepare/merge path");
    assert_eq!(fixed_files(&store), before);
    assert_eq!(crate::company_sync_digest::local(&store).unwrap(), digest);
    assert!(load(&store).unwrap().pending.as_ref() == Some(&pending));
}

#[test]
fn known_pending_commits_only_the_original_id_before_a_newer_head_can_merge() {
    let (_directory, store) = fixture();
    let pending = prepared(&store);
    let original = fs::read(file_path(&store, &pending.id).unwrap()).unwrap();
    store.create_record("clients", json!({"name":"Fictitious later edit during a stalled publication"})).unwrap();
    let live_clock = clock(&store).unwrap();
    let live_digest = crate::company_sync_digest::local(&store).unwrap();
    let mut calls = Vec::new();
    assert!(recovered_flow(&store, |body| {
        calls.push(body.clone());
        let response = match calls.len() {
            1 => {
                assert_probe(&body, &pending);
                json!({"known":true,"pending":true})
            }
            2 => {
                assert_eq!(body, json!({"action":"commit","id":pending.id}));
                json!({"committed":true,"revision":1,"snapshotId":pending.id})
            }
            _ => panic!("no prepare, upload, close or new publication may follow the probe"),
        };
        std::future::ready(Ok(response))
    }).unwrap());
    assert_eq!(calls.len(), 2);
    // Client facsimile: a fresh head/merge decision is downstream of both calls.
    let prefs = load(&store).unwrap();
    assert_eq!(prefs.revision, 1);
    assert_eq!(prefs.base_clock, pending.clock);
    assert!(prefs.pending.is_none());
    assert_eq!(fs::read(store.data_dir.join("company-sync-reference.zentra")).unwrap(), original);
    assert_eq!(clock(&store).unwrap(), live_clock);
    assert_eq!(crate::company_sync_digest::local(&store).unwrap(), live_digest);
    assert_eq!(status(&store).unwrap()["pending"], true);
}

#[test]
fn cancelled_receipt_and_resumed_commit_conflict_preserve_pending_before_reloading_head() {
    for probe_pending in [false, true] {
        let (_directory, store) = fixture();
        let pending = prepared(&store);
        let before = fixed_files(&store);
        let different_snapshot = uuid::Uuid::new_v4().to_string();
        let mut calls = Vec::new();
        assert!(recovered_flow(&store, |body| {
            calls.push(body.clone());
            let response = if calls.len() == 1 {
                assert_probe(&body, &pending);
                if probe_pending { json!({"known":true,"pending":true}) }
                else { json!({"known":true,"committed":false,"revision":2,"snapshotId":different_snapshot}) }
            } else {
                assert!(probe_pending);
                assert_eq!(calls.len(), 2);
                assert_eq!(body, json!({"action":"commit","id":pending.id}));
                json!({"committed":false,"conflict":true,"revision":2,"snapshotId":different_snapshot})
            };
            std::future::ready(Ok(response))
        }).unwrap());
        assert_eq!(calls.len(), if probe_pending { 2 } else { 1 });
        assert_eq!(fixed_files(&store), before);
        assert!(load(&store).unwrap().pending.as_ref() == Some(&pending));
        assert_eq!(load(&store).unwrap().revision, 0, "a failed operation is never an ACK");
    }
}

#[test]
fn failed_or_malformed_commit_retry_keeps_the_pending_evidence() {
    for failure in ["unavailable", "foreign_snapshot", "current_head", "extra", "missing_conflict", "false_same_id", "false_null_head", "false_negative_revision"] {
        let (_directory, store) = fixture();
        let pending = prepared(&store);
        let before = fixed_files(&store);
        let mut calls = 0;
        let result = recovered_flow(&store, |body| {
            calls += 1;
            if calls == 1 {
                assert_probe(&body, &pending);
                return std::future::ready(Ok(json!({"known":true,"pending":true})));
            }
            assert_eq!(calls, 2, "only the original commit may be retried");
            assert_eq!(body, json!({"action":"commit","id":pending.id}));
            if failure == "unavailable" {
                return std::future::ready(Err(invalid("Synthetic lost commit ACK; keep pending")));
            }
            let mut response = json!({"committed":true,"revision":1,"snapshotId":pending.id});
            match failure {
                "foreign_snapshot" => response["snapshotId"] = json!(uuid::Uuid::new_v4().to_string()),
                "current_head" => response["revision"] = json!(12),
                "extra" => response["known"] = json!(true),
                "missing_conflict" => response = json!({"committed":false,"revision":2,"snapshotId":uuid::Uuid::new_v4().to_string()}),
                "false_same_id" => response = json!({"committed":false,"conflict":true,"revision":2,"snapshotId":pending.id}),
                "false_null_head" => response = json!({"committed":false,"conflict":true,"revision":2,"snapshotId":null}),
                "false_negative_revision" => response = json!({"committed":false,"conflict":true,"revision":-1,"snapshotId":null}),
                _ => unreachable!(),
            }
            std::future::ready(Ok(response))
        });
        assert!(result.is_err(), "{failure} must stop before merging");
        assert_eq!(calls, 2);
        assert_eq!(fixed_files(&store), before);
        assert!(load(&store).unwrap().pending.as_ref() == Some(&pending));
    }
}

#[test]
fn a_changed_origin_or_pending_during_probe_never_retries_commit() {
    for changed in ["account", "pending", "archive"] {
        let (_directory, store) = fixture();
        let pending = prepared(&store);
        let mut calls = 0;
        let result = recovered_flow(&store, |body| {
            calls += 1;
            assert_eq!(calls, 1, "obsolete local evidence must never reach commit");
            assert_probe(&body, &pending);
            match changed {
                "account" => {
                    set_identity(&store, ORGANIZATION, "another-member", "Fictitious Other Member", "owner").unwrap();
                    set_identity(&store, ORGANIZATION, "fictitious-owner", "Fictitious Owner", "owner").unwrap();
                }
                "pending" => {
                    let mut prefs = load(&store).unwrap();
                    prefs.pending.as_mut().unwrap().clock += 1;
                    save(&store, &prefs).unwrap();
                }
                "archive" => fs::write(file_path(&store, &pending.id).unwrap(), b"synthetic damaged archive").unwrap(),
                _ => unreachable!(),
            }
            std::future::ready(Ok(json!({"known":true,"pending":true})))
        });
        assert!(result.is_err());
        assert_eq!(calls, 1);
        assert!(load(&store).unwrap().pending.is_some());
        assert_eq!(load(&store).unwrap().revision, 0);
        assert!(!store.data_dir.join("company-sync-reference.zentra").exists());
    }
}

#[test]
fn a_changed_account_pending_or_archive_after_commit_response_is_not_locally_acknowledged() {
    for changed in ["account", "pending", "archive"] {
        let (_directory, store) = fixture();
        let pending = prepared(&store);
        let mut calls = 0;
        let result = recovered_flow(&store, |body| {
            calls += 1;
            if calls == 1 {
                assert_probe(&body, &pending);
                return std::future::ready(Ok(json!({"known":true,"pending":true})));
            }
            assert_eq!(calls, 2);
            assert_eq!(body, json!({"action":"commit","id":pending.id}));
            match changed {
                "account" => {
                    set_identity(&store, ORGANIZATION, "another-member", "Fictitious Other Member", "owner").unwrap();
                    set_identity(&store, ORGANIZATION, "fictitious-owner", "Fictitious Owner", "owner").unwrap();
                }
                "pending" => {
                    let mut prefs = load(&store).unwrap();
                    prefs.pending.as_mut().unwrap().clock += 1;
                    save(&store, &prefs).unwrap();
                }
                "archive" => fs::write(file_path(&store, &pending.id).unwrap(), b"synthetic damaged archive").unwrap(),
                _ => unreachable!(),
            }
            std::future::ready(Ok(json!({"committed":true,"revision":1,"snapshotId":pending.id})))
        });
        assert!(result.is_err());
        assert_eq!(calls, 2);
        assert!(load(&store).unwrap().pending.is_some());
        assert_eq!(load(&store).unwrap().revision, 0);
        assert!(!store.data_dir.join("company-sync-reference.zentra").exists());
    }
}

#[test]
fn cancelled_response_requires_a_closed_coherent_historical_head() {
    let (_directory, store) = fixture();
    let mut pending = prepared(&store);
    assert_eq!(publication_recovery_response(&json!({"known":true,"committed":false,"revision":0,"snapshotId":null}), &pending).unwrap(), PublicationRecovery::Cancelled);
    for response in [
        json!({"known":true,"committed":false,"revision":0,"extra":null}),
        json!({"known":true,"committed":false,"revision":0,"snapshotId":uuid::Uuid::new_v4().to_string()}),
        json!({"known":true,"committed":false,"revision":9_007_199_254_740_992u64,"snapshotId":uuid::Uuid::new_v4().to_string()}),
        json!({"known":true,"committed":false,"revision":1,"snapshotId":null}),
    ] {
        assert!(publication_recovery_response(&response, &pending).is_err());
    }
    pending.base_revision = 10;
    assert!(publication_recovery_response(&json!({"known":true,"committed":false,"revision":9,"snapshotId":uuid::Uuid::new_v4().to_string()}), &pending).is_err());
    assert!(publication_recovery_response(&json!({"known":true,"committed":true,"revision":12,"snapshotId":pending.id}), &pending).is_err());
    assert_eq!(publication_recovery_response(&json!({"known":true,"committed":true,"revision":11,"snapshotId":pending.id}), &pending).unwrap(), PublicationRecovery::Committed(11));
}

#[test]
fn denied_unavailable_unmigrated_or_malformed_responses_never_acknowledge_or_fall_back() {
    for failure in ["denied", "unavailable", "unmigrated", "foreign_snapshot", "current_head", "missing", "extra", "negative_extra", "wrong_boolean", "unsafe_revision", "pending_false", "pending_extra", "cancelled_same_id", "cancelled_null_head", "cancelled_invalid_id"] {
        let (_directory, store) = fixture();
        let pending = prepared(&store);
        let before = fixed_files(&store);
        let expected = pending.clone();
        let result = recovered(&store, move |body| async move {
            assert_probe(&body, &expected);
            if ["denied", "unavailable", "unmigrated"].contains(&failure) {
                return Err(invalid("Synthetic unavailable/denied recovery endpoint; keep pending"));
            }
            let mut response = receipt(&expected);
            match failure {
                "foreign_snapshot" => response["snapshotId"] = json!(uuid::Uuid::new_v4().to_string()),
                "current_head" => response["revision"] = json!(12),
                "missing" => { response.as_object_mut().unwrap().remove("snapshotId"); },
                "extra" => response["extra"] = json!(true),
                "negative_extra" => response = json!({"known":false,"revision":1}),
                "wrong_boolean" => response["committed"] = json!("true"),
                "unsafe_revision" => response["revision"] = json!(9_007_199_254_740_992u64),
                "pending_false" => response = json!({"known":true,"pending":false}),
                "pending_extra" => response = json!({"known":true,"pending":true,"revision":0}),
                "cancelled_same_id" => response = json!({"known":true,"committed":false,"revision":2,"snapshotId":expected.id}),
                "cancelled_null_head" => response = json!({"known":true,"committed":false,"revision":2,"snapshotId":null}),
                "cancelled_invalid_id" => response = json!({"known":true,"committed":false,"revision":2,"snapshotId":"not-an-id"}),
                _ => unreachable!(),
            }
            Ok(response)
        });
        assert!(result.is_err(), "{failure} must not resume a merge or send");
        assert_eq!(fixed_files(&store), before, "changed files for {failure}");
        assert!(load(&store).unwrap().pending.as_ref() == Some(&pending));
    }
}

#[test]
fn changed_account_generation_refuses_positive_and_negative_replies_without_clearing_pending() {
    for known in [false, true] {
        let (_directory, store) = fixture();
        let pending = prepared(&store);
        let before = fixed_files(&store);
        let owned = store.clone();
        let expected = pending.clone();
        let result = recovered(&store, move |body| async move {
            assert_probe(&body, &expected);
            set_identity(&owned, ORGANIZATION, "another-member", "Fictitious Other Member", "owner")?;
            set_identity(&owned, ORGANIZATION, "fictitious-owner", "Fictitious Owner", "owner")?;
            Ok(if known { receipt(&expected) } else { json!({"known":false}) })
        });
        assert!(result.is_err(), "returning to the same account must not revive its old generation");
        assert_eq!(fixed_files(&store), before);
        assert!(load(&store).unwrap().pending.as_ref() == Some(&pending));
    }
}

#[test]
fn a_changed_pending_or_corrupt_archive_during_the_probe_keeps_the_local_evidence() {
    for changed in ["pending", "archive"] {
        let (_directory, store) = fixture();
        let pending = prepared(&store);
        let owned = store.clone();
        let expected = pending.clone();
        let result = recovered(&store, move |body| async move {
            assert_probe(&body, &expected);
            if changed == "pending" {
                let mut prefs = load(&owned)?;
                prefs.pending.as_mut().unwrap().clock += 1;
                save(&owned, &prefs)?;
            } else {
                fs::write(file_path(&owned, &expected.id)?, b"synthetic damaged archive")?;
            }
            Ok(receipt(&expected))
        });
        assert!(result.is_err());
        assert!(load(&store).unwrap().pending.is_some());
        assert_eq!(load(&store).unwrap().revision, 0);
        assert!(!store.data_dir.join("company-sync-reference.zentra").exists());
        assert!(!store.data_dir.join("company-sync-baseline.json").exists());
    }
}

#[test]
fn no_pending_means_no_recovery_transport_or_new_publication() {
    let (_directory, store) = fixture();
    let before = fixed_files(&store);
    assert!(!recovered(&store, |_| async {
        panic!("an idle company must not call the receipt endpoint")
    }).unwrap());
    assert_eq!(fixed_files(&store), before);
    assert!(load(&store).unwrap().pending.is_none());
}
