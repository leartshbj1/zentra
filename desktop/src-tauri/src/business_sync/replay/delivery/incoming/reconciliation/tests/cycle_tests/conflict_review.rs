use super::*;
use crate::business_sync::replay::delivery::incoming::reconciliation::review::{self, Action};
use crate::business_sync::replay::reconciliation::resolution::{Choice, Decision, Request};

fn drawing(store: &LocalStore, c: &rusqlite::Connection, name: &str, bytes: &[u8]) {
    fs::write(store.attachments_dir.join(name), bytes).unwrap();
    c.execute("INSERT INTO attachments(id,original_name,stored_name,size_bytes,sha256,created_at,updated_at) VALUES('drawing-review',?1,?1,?2,?3,'2026-09-09','2026-09-09')", params![name, bytes.len() as i64, digest(bytes)]).unwrap();
}

#[test]
fn conflict_review_checks_both_document_choices_and_rejects_missing_or_changed_bytes() {
    tauri::async_runtime::block_on(async {
        let original_bytes = b"Initial drawing for conflict review";
        let local_bytes = b"Locally revised drawing";
        let shared_bytes = b"Drawing revised on the other installation";
        let (_root, local, context) = replay::tests::setup_with(|s| {
            drawing(s, &s.connect().unwrap(), "initial.txt", original_bytes);
        });
        let (_other_root, other) = replay::tests::copy_receiver(&local);
        fs::write(other.attachments_dir.join("initial.txt"), original_bytes).unwrap();
        for (store, name, bytes) in [
            (&local, "local.txt", local_bytes.as_slice()),
            (&other, "shared.txt", shared_bytes.as_slice()),
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
        let shared_state = replay::state_fingerprint(&other.connect().unwrap()).unwrap();
        let (folder, header) = stage_from(
            &local,
            &other,
            &sent,
            &context.source_state_sha256,
            &shared_state,
        );
        let received = folder.clone();
        let transaction = header.entry.transaction_id.clone();
        let server = transport(&local, folder, header);
        let mut state = String::new();
        for _ in 0..10 {
            let status = cycle::pass(local.clone(), server.clone(), true)
                .await
                .unwrap();
            state = status["state"].as_str().unwrap().into();
            if state != "receiving" {
                break;
            }
        }
        assert_eq!(state, "conflict");
        let original_state = replay::state_fingerprint(&local.connect().unwrap()).unwrap();
        let original_internal = merge::internal_fingerprint(&local.connect().unwrap()).unwrap();
        let report = review::process_with_transport(
            local.clone(),
            server.clone(),
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
        let request = |choice| Request {
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
        let mut hashes = vec![];
        for (choice, size, replacements) in [
            (Choice::Local, local_bytes.len(), 0),
            (Choice::Shared, shared_bytes.len(), 1),
        ] {
            let preview = review::process_with_transport(
                local.clone(),
                server.clone(),
                "owner".into(),
                transaction.clone(),
                Action::Preview(request(choice)),
                "d".repeat(64),
            )
            .await
            .unwrap();
            assert_eq!(preview["state"], "resolution_preview");
            assert_eq!(preview["documents_verified"], true);
            assert_eq!(preview["documents"]["final_count"], 1);
            assert_eq!(preview["documents"]["files_to_replace"], replacements);
            assert_eq!(preview["documents"]["total_size_bytes"], size);
            assert_eq!(preview["can_install"], false);
            hashes.push(preview["documents"]["plan_sha256"].clone());
        }
        assert_ne!(hashes[0], hashes[1]);
        // A missing received blob cannot be certified from the row's hash alone.
        let blob = received.join("files").join(digest(shared_bytes));
        fs::remove_file(&blob).unwrap();
        assert!(review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction.clone(),
            Action::Preview(request(Choice::Shared)),
            "d".repeat(64)
        )
        .await
        .is_err());
        fs::write(&blob, shared_bytes).unwrap();
        // Uncaptured edits on disk must not be overwritten by a chosen version.
        fs::write(local.attachments_dir.join("local.txt"), b"Unrecorded edit").unwrap();
        assert!(review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction,
            Action::Preview(request(Choice::Shared)),
            "d".repeat(64)
        )
        .await
        .is_err());
        assert_eq!(
            fs::read(local.attachments_dir.join("local.txt")).unwrap(),
            b"Unrecorded edit"
        );
        assert!(!local.attachments_dir.join("shared.txt").exists());
        assert_eq!(
            replay::state_fingerprint(&local.connect().unwrap()).unwrap(),
            original_state
        );
        assert_eq!(
            merge::internal_fingerprint(&local.connect().unwrap()).unwrap(),
            original_internal
        );
        assert_eq!(acknowledged(&local), 0);
        assert_eq!(pending(&local), 1);
        assert_eq!(Binding::read(&local, "org-replay").unwrap().revision, 1);
        assert!(!server
            .transport
            .calls
            .lock()
            .unwrap()
            .contains(&"send".into()));
    });
}

#[test]
fn conflict_review_rechecks_received_proofs_and_never_installs_its_preview() {
    tauri::async_runtime::block_on(async {
        let (_root, local, mut context) = replay::tests::setup_with(|s| {
            s.create_record("clients", json!({"name":"Nom commun"}))
                .unwrap();
        });
        let (_other_root, other) = replay::tests::copy_receiver(&local);
        let id: String = local
            .connect()
            .unwrap()
            .query_row("SELECT id FROM clients", [], |r| r.get(0))
            .unwrap();
        local
            .update_record("clients", &id, json!({"name":"Choix local"}))
            .unwrap();
        other
            .update_record("clients", &id, json!({"name":"Choix distant"}))
            .unwrap();
        context.target_state_sha256 = replay::state_fingerprint(&other.connect().unwrap()).unwrap();
        let sent = outgoing::prepare_next(&other, "org-replay", "owner")
            .unwrap()
            .unwrap();
        let (folder, header) = stage_from(
            &local,
            &other,
            &sent,
            &context.source_state_sha256,
            &context.target_state_sha256,
        );
        let received_folder = folder.clone();
        let transaction_id = header.entry.transaction_id.clone();
        let server = transport(&local, folder, header);
        assert_eq!(
            cycle::pass(local.clone(), server.clone(), true)
                .await
                .unwrap()["state"],
            "conflict"
        );
        let original = replay::state_fingerprint(&local.connect().unwrap()).unwrap();
        let report = review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction_id.clone(),
            Action::Inspect {
                after_sequence: None,
                review_id: None,
            },
            "d".repeat(64),
        )
        .await
        .unwrap();
        assert_eq!(report["state"], "conflict_review");
        assert_eq!(report["transaction_id"], transaction_id);
        assert_eq!(
            report["transactions"][0]["conflict"]["local"]["fields"]["name"]["value"],
            "Choix local"
        );
        let request = Request {
            after_sequence: None,
            review_id: report["review_id"].as_str().unwrap().into(),
            decisions: vec![Decision {
                transaction_id: report["transactions"][0]["transaction_id"]
                    .as_str()
                    .unwrap()
                    .into(),
                choice: Choice::Shared,
            }],
        };
        // Another account may have the same company and role. Its protected
        // session must still obtain a fresh review before reusing a decision.
        assert!(review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction_id.clone(),
            Action::Inspect {
                after_sequence: None,
                review_id: Some(request.review_id.clone()),
            },
            "e".repeat(64),
        )
        .await
        .is_err());
        let preview = review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction_id.clone(),
            Action::Preview(request),
            "d".repeat(64),
        )
        .await
        .unwrap();
        assert_eq!(preview["state"], "resolution_preview");
        assert_eq!(preview["can_install"], false);
        assert_eq!(preview["documents_verified"], true);
        assert_eq!(preview["documents"]["final_count"], 0);
        assert_eq!(
            preview["proposed_state_sha256"],
            context.target_state_sha256
        );
        assert_eq!(
            replay::state_fingerprint(&local.connect().unwrap()).unwrap(),
            original
        );
        assert_eq!(acknowledged(&local), 0);
        assert_eq!(pending(&local), 1);
        assert_eq!(Binding::read(&local, "org-replay").unwrap().revision, 1);
        assert!(!server
            .transport
            .calls
            .lock()
            .unwrap()
            .contains(&"send".into()));

        // A displayed review never grants permission to use altered staging.
        let proof = received_folder.join("receipt.json");
        let original_receipt = fs::read(&proof).unwrap();
        fs::write(&proof, b"{}").unwrap();
        assert!(review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction_id.clone(),
            Action::Inspect {
                after_sequence: None,
                review_id: None
            },
            "d".repeat(64),
        )
        .await
        .is_err());
        fs::write(&proof, original_receipt).unwrap();
        *server.transport.cancel_after_read.lock().unwrap() = Some(local.clone());
        assert!(review::process_with_transport(
            local.clone(),
            server,
            "owner".into(),
            transaction_id,
            Action::Inspect {
                after_sequence: None,
                review_id: None
            },
            "d".repeat(64),
        )
        .await
        .is_err());
        assert_eq!(
            replay::state_fingerprint(&local.connect().unwrap()).unwrap(),
            original
        );
        assert_eq!(acknowledged(&local), 0);
    });
}
