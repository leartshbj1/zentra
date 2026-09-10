use super::conflict_review::drawing;
use super::*;
use crate::business_sync::{
    replay::{
        delivery::incoming::reconciliation::{
            application,
            review::{self, Action},
        },
        reconciliation::resolution::{Choice, Decision, Request},
    },
    retirement::{durable, Request as RetirementRequest},
};
use reqwest::StatusCode;

impl durable::Transport for Server {
    fn organization(&self) -> &str {
        &self.header.binding.organization
    }
    fn role(&self) -> &str {
        "owner"
    }
    fn ensure_current(&self, store: &LocalStore) -> AppResult<()> {
        Transport::ensure_current(self, store)
    }
    async fn get(&self, _: &str) -> AppResult<(StatusCode, Vec<u8>)> {
        self.calls.lock().unwrap().push("retirement_lookup".into());
        Ok((StatusCode::NOT_FOUND, vec![]))
    }
    async fn post(&self, body: Vec<u8>) -> AppResult<(StatusCode, Vec<u8>)> {
        self.calls.lock().unwrap().push("retirement_post".into());
        if std::mem::take(&mut *self.fail_once.lock().unwrap()) { return Err(invalid("Retirement response lost")); }
        let request: RetirementRequest = serde_json::from_slice(&body).unwrap();
        assert_eq!(request.generation, self.header.binding.generation);
        assert_eq!(request.capture_generation, self.header.binding.capture);
        assert_eq!(request.receipt_sha256, self.header.entry.receipt_sha256);
        let mut proof = serde_json::to_value(&request).unwrap();
        proof["format"] = json!("zentra-conflict-retirement");
        proof["version"] = json!(1);
        proof["organization_id"] = json!(self.header.binding.organization);
        proof["installation_id"] = json!(self.header.binding.installation);
        proof["binding_sha256"] = json!(request.binding_sha256().unwrap());
        proof["registered_at"] = json!("2026-09-10T00:00:00Z");
        proof["retired"] = json!(true);
        proof["business_revision_changed"] = json!(false);
        proof["transaction_acknowledged"] = json!(false);
        Ok((StatusCode::OK, serde_json::to_vec(&proof).unwrap()))
    }
}

#[test]
fn saved_resolution_application_validates_files_and_freezes_only_a_fresh_authorized_proposal() {
    tauri::async_runtime::block_on(async {
        let (_root, local, context) = replay::tests::setup_with(|s| {
            drawing(s, &s.connect().unwrap(), "original.txt", b"original");
        });
        let (_other_root, other) = replay::tests::copy_receiver(&local);
        fs::write(other.attachments_dir.join("original.txt"), b"original").unwrap();
        for (store, name, bytes) in [
            (&local, "local.txt", b"local".as_slice()),
            (&other, "shared.txt", b"shared".as_slice()),
        ] {
            let mut c = store.connect().unwrap();
            let tx = c.transaction().unwrap();
            tx.execute("DELETE FROM attachments WHERE id='drawing-review'", [])
                .unwrap();
            drawing(store, &tx, name, bytes);
            tx.commit().unwrap();
        }
        let sent = outgoing::prepare_next(&other, "org-replay", "owner")
            .unwrap()
            .unwrap();
        let shared = replay::state_fingerprint(&other.connect().unwrap()).unwrap();
        let (folder, header) =
            stage_from(&local, &other, &sent, &context.source_state_sha256, &shared);
        let transaction = header.entry.transaction_id.clone();
        let t = transport(&local, folder, header);
        let mut state = String::new();
        for _ in 0..10 {
            let report = cycle::pass(local.clone(), t.clone(), true).await.unwrap();
            state = report["state"].as_str().unwrap().into();
            if state != "receiving" {
                break;
            }
        }
        assert_eq!(state, "conflict");
        let inspect = review::process_with_transport(
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
        review::process_with_transport(
            local.clone(),
            t.clone(),
            "owner".into(),
            transaction.clone(),
            Action::Save {
                resolution_id: id.clone(),
                request: Request {
                    review_id: inspect["review_id"].as_str().unwrap().into(),
                    after_sequence: None,
                    decisions: vec![Decision {
                        transaction_id: inspect["transactions"][0]["transaction_id"]
                            .as_str()
                            .unwrap()
                            .into(),
                        choice: Choice::Shared,
                    }],
                },
            },
            "d".repeat(64),
        )
        .await
        .unwrap();
        let original_state = replay::state_fingerprint(&local.connect().unwrap()).unwrap();
        let original_internal = merge::internal_fingerprint(&local.connect().unwrap()).unwrap();
        // UI refusal and a reconnected, stale review must not freeze the profile.
        for (account, allowed) in [("d", false), ("e", true)] {
            assert!(application::retire_saved(
                local.clone(),
                t.clone(),
                transaction.clone(),
                id.clone(),
                account.repeat(64),
                Arc::new(move || if allowed {
                    Ok(())
                } else {
                    Err(invalid("UI is editing"))
                })
            )
            .await
            .is_err());
            assert!(durable::load(&local.connect().unwrap(), &local)
                .unwrap()
                .is_none());
            assert_eq!(
                merge::internal_fingerprint(&local.connect().unwrap()).unwrap(),
                original_internal
            );
        }
        // A source edit at the last permission boundary invalidates the cutoff.
        let changed = local.clone();
        assert!(application::retire_saved(local.clone(), t.clone(), transaction.clone(), id.clone(), "d".repeat(64), Arc::new(move || {
            changed.connect()?.execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('late-client','Concurrent edit','2026-09-10','2026-09-10')", [])?;
            Ok(())
        })).await.is_err());
        assert!(durable::load(&local.connect().unwrap(), &local)
            .unwrap()
            .is_none());
        // The old proposal is now stale. Keep this assertion independent from
        // the successful application below by saving a new current comparison.
        let inspect = review::process_with_transport(
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
        let current_id = Uuid::new_v4().to_string();
        let request = Request {
            review_id: inspect["review_id"].as_str().unwrap().into(),
            after_sequence: None,
            decisions: inspect["transactions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|v| !v["conflict"].is_null())
                .map(|v| Decision {
                    transaction_id: v["transaction_id"].as_str().unwrap().into(),
                    choice: Choice::Shared,
                })
                .collect(),
        };
        review::process_with_transport(
            local.clone(),
            t.clone(),
            "owner".into(),
            transaction.clone(),
            Action::Save {
                resolution_id: current_id.clone(),
                request,
            },
            "d".repeat(64),
        )
        .await
        .unwrap();
        let prior = fs::read(local.attachments_dir.join("local.txt")).unwrap();
        fs::write(
            local.attachments_dir.join("local.txt"),
            b"changed outside the app",
        )
        .unwrap();
        assert!(application::retire_saved(
            local.clone(),
            t.clone(),
            transaction.clone(),
            current_id.clone(),
            "d".repeat(64),
            Arc::new(|| Ok(()))
        )
        .await
        .is_err());
        assert!(durable::load(&local.connect().unwrap(), &local)
            .unwrap()
            .is_none());
        fs::write(local.attachments_dir.join("local.txt"), prior).unwrap();
        let state_before_application =
            replay::state_fingerprint(&local.connect().unwrap()).unwrap();
        assert_ne!(state_before_application, original_state);
        let frozen = application::retire_saved(
            local.clone(),
            t.clone(),
            transaction.clone(),
            current_id.clone(),
            "d".repeat(64),
            Arc::new(|| Ok(())),
        )
        .await
        .unwrap();
        assert_eq!(frozen.stage, durable::Stage::Retired);
        assert_eq!(frozen.intent.review_id, inspect["review_id"]);
        let resumed = application::retire_saved(
            LocalStore::initialize(local.data_dir.clone()).unwrap(),
            t.clone(),
            transaction,
            current_id,
            "different protected session after reconnect".into(),
            Arc::new(|| panic!("Recovery must not repeat initial permission")),
        )
        .await
        .unwrap();
        assert_eq!(resumed.raw_intent, frozen.raw_intent);
        assert_eq!(resumed.retirement, frozen.retirement);
        assert_eq!(
            t.transport
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|s| s.as_str() == "retirement_post")
                .count(),
            1
        );
        assert_eq!(
            replay::state_fingerprint(&local.connect().unwrap()).unwrap(),
            state_before_application
        );
        assert_eq!(
            fs::read(local.attachments_dir.join("local.txt")).unwrap(),
            b"local"
        );
        assert_eq!(acknowledged(&local), 0);
    });
}
