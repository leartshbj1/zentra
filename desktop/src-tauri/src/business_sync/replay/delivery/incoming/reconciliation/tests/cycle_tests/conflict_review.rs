use super::super::super::{files, saved, verify};
use super::*;
use crate::business_sync::replay::delivery::incoming::reconciliation::review::{self, Action};
use crate::business_sync::replay::reconciliation::resolution::{Choice, Decision, Request};

#[test]
#[ignore = "Isolated process worker invoked by the saved proposal recovery test"]
fn saved_proposal_crash_worker() {
    let local = LocalStore::initialize(PathBuf::from(
        std::env::var("ZENTRA_PROPOSAL_PROFILE").unwrap(),
    ))
    .unwrap();
    let folder = PathBuf::from(std::env::var("ZENTRA_PROPOSAL_FOLDER").unwrap());
    let id = std::env::var("ZENTRA_PROPOSAL_ID").unwrap();
    let point = std::env::var("ZENTRA_PROPOSAL_POINT").unwrap();
    let header: Header =
        serde_json::from_slice(&fs::read(folder.join("header.json")).unwrap()).unwrap();
    let revision = verify(&local, &folder, &header, "owner", || Ok(())).unwrap();
    let account = "d".repeat(64);
    let scope = merge::resolution::Scope {
        store: &local,
        context: &revision.context,
        capture: &header.binding.capture,
        receipt_sha256: &header.entry.receipt_sha256,
        role: "owner",
        account_binding: &account,
        acknowledgement: revision.acknowledgement.as_ref(),
    };
    let request = Request {
        review_id: merge::resolution::review_id(&revision.prepared, &scope).unwrap(),
        after_sequence: None,
        decisions: revision
            .prepared
            .rows()
            .prepare("SELECT DISTINCT transaction_id FROM pending_changes")
            .unwrap()
            .query_map([], |r| {
                Ok(Decision {
                    transaction_id: r.get(0)?,
                    choice: Choice::Shared,
                })
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap(),
    };
    let saved_request = request.clone();
    let plan = std::cell::RefCell::new(None);
    merge::resolution::preview_and_save(
        &revision.prepared,
        &scope,
        request,
        || Ok(()),
        |candidate| {
            let files = files::plan(candidate, &local, &folder, &revision.chunks)?;
            let report = files.preview(&local)?;
            *plan.borrow_mut() = Some(files);
            Ok(report)
        },
        |candidate, result| {
            *result = saved::save_with_checkpoint(
                &local,
                &header,
                &id,
                saved_request,
                result,
                candidate,
                &plan.borrow_mut().take().unwrap(),
                &revision.receipt,
                || Ok(()),
                |p| {
                    if format!("{p:?}") == point {
                        std::process::exit(75);
                    }
                    Ok(())
                },
            )?;
            Ok(())
        },
    )
    .unwrap();
    panic!("Crash boundary not reached");
}

pub(super) fn drawing(store: &LocalStore, c: &rusqlite::Connection, name: &str, bytes: &[u8]) {
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
        let saved_header = header.clone();
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
        // A durable proposal survives disposal of every temporary model and
        // native candidate used by process_with_transport. No working data or
        // receipt changes until a separate, future installation is authorized.
        let proposal_id = uuid::Uuid::new_v4().to_string();
        let saved = review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction.clone(),
            Action::Save {
                resolution_id: proposal_id.clone(),
                request: request(Choice::Shared),
            },
            "d".repeat(64),
        )
        .await
        .unwrap();
        assert_eq!(saved["state"], "resolution_saved");
        assert_eq!(saved["saved"]["candidate_and_documents_preserved"], true);
        assert_eq!(saved["saved"]["server_retirement_requested"], false);
        assert_eq!(saved["can_install"], false);
        let reopened = review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction.clone(),
            Action::ReadSaved {
                resolution_id: proposal_id.clone(),
            },
            "d".repeat(64),
        )
        .await
        .unwrap();
        assert_eq!(reopened, saved);
        let listed = review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction.clone(),
            Action::ListSaved {
                review_id: report["review_id"].as_str().unwrap().into(),
            },
            "d".repeat(64),
        )
        .await
        .unwrap();
        assert_eq!(listed["proposals"].as_array().unwrap().len(), 1);
        assert_eq!(listed["proposals"][0]["resolution_id"], proposal_id);
        assert!(listed["proposals"][0].get("decisions").is_none());
        assert!(review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction.clone(),
            Action::ListSaved {
                review_id: report["review_id"].as_str().unwrap().into()
            },
            "e".repeat(64)
        )
        .await
        .is_err());
        let other_review = review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction.clone(),
            Action::Inspect {
                after_sequence: None,
                review_id: None,
            },
            "e".repeat(64),
        )
        .await
        .unwrap();
        let other_list = review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction.clone(),
            Action::ListSaved {
                review_id: other_review["review_id"].as_str().unwrap().into(),
            },
            "e".repeat(64),
        )
        .await
        .unwrap();
        assert!(other_list["proposals"].as_array().unwrap().is_empty());
        let local_proposal_id = uuid::Uuid::new_v4().to_string();
        let kept = review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction.clone(),
            Action::Save {
                resolution_id: local_proposal_id.clone(),
                request: request(Choice::Local),
            },
            "d".repeat(64),
        )
        .await
        .unwrap();
        assert_eq!(kept["state"], "resolution_saved");
        let kept_folder = local
            .attachments_dir
            .join(crate::business_sync::files::DIRECTORY)
            .join("resolutions")
            .join(&local_proposal_id);
        let metadata: Value =
            serde_json::from_slice(&fs::read(kept_folder.join("proposal.json")).unwrap()).unwrap();
        assert_eq!(metadata["version"], 2);
        let replacements: merge::replacements::Plan =
            serde_json::from_slice(&fs::read(kept_folder.join("replacement.json")).unwrap())
                .unwrap();
        assert_eq!(replacements.originals.len(), 1);
        assert_eq!(replacements.transactions.len(), 1);
        // Even self-consistent file hashes cannot rebind a saved choice to a
        // different server revision. Reject it before freezing the live store.
        let original_plan = fs::read(kept_folder.join("replacement.json")).unwrap();
        let original_metadata = fs::read(kept_folder.join("proposal.json")).unwrap();
        let original_seal = fs::read(kept_folder.join("proposal.sha256")).unwrap();
        let mut changed_plan: Value = serde_json::from_slice(&original_plan).unwrap();
        changed_plan["base_revision"] = json!(replacements.base_revision + 1);
        let changed_plan = serde_json::to_vec(&changed_plan).unwrap();
        let mut changed_metadata = metadata.clone();
        changed_metadata["artifacts"]["replacement.json"]["sha256"] = json!(digest(&changed_plan));
        changed_metadata["artifacts"]["replacement.json"]["size_bytes"] = json!(changed_plan.len());
        let changed_metadata = serde_json::to_vec(&changed_metadata).unwrap();
        fs::write(kept_folder.join("replacement.json"), changed_plan).unwrap();
        fs::write(kept_folder.join("proposal.json"), &changed_metadata).unwrap();
        fs::write(kept_folder.join("proposal.sha256"), digest(&changed_metadata)).unwrap();
        assert!(review::process_with_transport(
            local.clone(), server.clone(), "owner".into(), transaction.clone(),
            Action::ReadSaved { resolution_id: local_proposal_id.clone() }, "d".repeat(64),
        ).await.is_err());
        fs::write(kept_folder.join("replacement.json"), original_plan).unwrap();
        fs::write(kept_folder.join("proposal.json"), original_metadata).unwrap();
        fs::write(kept_folder.join("proposal.sha256"), original_seal).unwrap();
        // Recreate only the saved replacement DB and its retained row evidence
        // in a fresh disposable profile; no current working documents copied.
        let probe_root = tempfile::tempdir().unwrap();
        let mut probe = local.clone();
        probe.data_dir = probe_root.path().to_path_buf();
        probe.database_path = probe.data_dir.join("probe.sqlite");
        probe.attachments_dir = probe.data_dir.join("attachments");
        probe.exports_dir = probe.data_dir.join("exports");
        probe.backups_dir = probe.data_dir.join("backups");
        for folder in [
            &probe.attachments_dir,
            &probe.exports_dir,
            &probe.backups_dir,
        ] {
            fs::create_dir(folder).unwrap();
        }
        fs::copy(kept_folder.join("replacement.sqlite"), &probe.database_path).unwrap();
        for row in replacements.transactions.iter().flat_map(|t| &t.changes) {
            if !crate::business_sync::files::has_files(&row.table) {
                continue;
            }
            for raw in row.before_json.iter().chain(row.after_json.iter()) {
                let key = format!("{}:{}", row.table, digest(raw.as_bytes()));
                let files: Vec<crate::business_sync::files::RetainedFile> =
                    serde_json::from_value(metadata["replacement_files"][&key].clone()).unwrap();
                for file in files {
                    crate::business_sync::files::retain_verified_image(
                        &probe.data_dir,
                        &row.table,
                        raw,
                        &file,
                        &kept_folder.join("blobs").join(&file.sha256),
                    )
                    .unwrap();
                }
            }
        }
        let outgoing = outgoing::prepare_next(&probe, "org-replay", "owner")
            .unwrap()
            .unwrap();
        assert_eq!(
            outgoing.manifest.capture_generation,
            replacements.replacement_capture_generation
        );
        assert_eq!(outgoing.manifest.base_revision, 2);
        assert_eq!(outgoing.manifest.files.len(), 2);
        for bytes in [shared_bytes.as_slice(), local_bytes.as_slice()] {
            assert!(outgoing
                .manifest
                .files
                .iter()
                .any(|f| f.sha256 == digest(bytes)));
            assert_eq!(
                fs::read(kept_folder.join("blobs").join(digest(bytes))).unwrap(),
                bytes
            );
        }
        assert_eq!(
            replay::state_fingerprint(&local.connect().unwrap()).unwrap(),
            original_state
        );
        assert_eq!(
            merge::internal_fingerprint(&local.connect().unwrap()).unwrap(),
            original_internal
        );
        assert_eq!(
            review::process_with_transport(
                local.clone(),
                server.clone(),
                "owner".into(),
                transaction.clone(),
                Action::Save {
                    resolution_id: proposal_id.clone(),
                    request: request(Choice::Shared)
                },
                "d".repeat(64),
            )
            .await
            .unwrap(),
            saved
        );
        assert!(review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction.clone(),
            Action::Save {
                resolution_id: proposal_id.clone(),
                request: request(Choice::Local)
            },
            "d".repeat(64),
        )
        .await
        .is_err());
        assert!(review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction.clone(),
            Action::ReadSaved {
                resolution_id: proposal_id.clone()
            },
            "e".repeat(64),
        )
        .await
        .is_err());
        let saved_folder = local
            .attachments_dir
            .join(crate::business_sync::files::DIRECTORY)
            .join("resolutions")
            .join(&proposal_id);
        for bytes in [
            original_bytes.as_slice(),
            local_bytes.as_slice(),
            shared_bytes.as_slice(),
        ] {
            assert_eq!(
                fs::read(saved_folder.join("blobs").join(digest(bytes))).unwrap(),
                bytes
            );
        }
        let read_saved = || {
            super::super::super::saved::read_saved(
                &local,
                &saved_header,
                &proposal_id,
                report["review_id"].as_str().unwrap(),
            )
        };
        let native = saved_folder.join("candidate.sqlite");
        let native_bytes = fs::read(&native).unwrap();
        fs::write(&native, b"truncated after interruption").unwrap();
        assert!(read_saved().is_err());
        fs::write(&native, native_bytes).unwrap();
        let saved_blob = saved_folder.join("blobs").join(digest(shared_bytes));
        fs::remove_file(&saved_blob).unwrap();
        assert!(read_saved().is_err());
        fs::write(&saved_blob, shared_bytes).unwrap();
        assert_eq!(read_saved().unwrap(), saved);
        for (point, durable) in [
            (saved::Point::Flushed, false),
            (saved::Point::Published, true),
        ] {
            let crash_id = uuid::Uuid::new_v4().to_string();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command.args(["business_sync::replay::delivery::incoming::reconciliation::tests::cycle_tests::conflict_review::saved_proposal_crash_worker", "--exact", "--ignored", "--nocapture"])
                .env("ZENTRA_PROPOSAL_PROFILE", &local.data_dir).env("ZENTRA_PROPOSAL_FOLDER", &received)
                .env("ZENTRA_PROPOSAL_ID", &crash_id).env("ZENTRA_PROPOSAL_POINT", format!("{point:?}"))
                .spawn().unwrap();
            let started = std::time::Instant::now();
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert_eq!(status.code(), Some(75));
                    break;
                }
                if started.elapsed() > std::time::Duration::from_secs(90) {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("Proposal crash worker timed out");
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let reopened = LocalStore::initialize(local.data_dir.clone()).unwrap();
            assert_eq!(reopened.installation_id, local.installation_id);
            let recovered = saved::read_saved(
                &reopened,
                &saved_header,
                &crash_id,
                report["review_id"].as_str().unwrap(),
            );
            if durable {
                let recovered = recovered.unwrap();
                assert_eq!(recovered["decision_sha256"], saved["decision_sha256"]);
                assert_eq!(recovered["saved"]["resolution_id"], crash_id);
            } else {
                assert!(
                    recovered.is_err(),
                    "An unfinished copy must not appear as a saved proposal"
                );
            }
            assert_eq!(
                replay::state_fingerprint(&reopened.connect().unwrap()).unwrap(),
                original_state
            );
            assert_eq!(
                merge::internal_fingerprint(&reopened.connect().unwrap()).unwrap(),
                original_internal
            );
        }
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
        assert!(
            read_saved().is_err(),
            "Even a document discarded by Shared remains part of the comparison preconditions"
        );
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
        let rows_request = || merge::resolution::details::RowsRequest {
            review_id: report["review_id"].as_str().unwrap().into(),
            local_transaction_id: report["transactions"][0]["transaction_id"]
                .as_str()
                .unwrap()
                .into(),
            after_sequence: None,
        };
        let details = review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction_id.clone(),
            Action::Changes(rows_request()),
            "d".repeat(64),
        )
        .await
        .unwrap();
        assert_eq!(
            details["change_count"],
            report["transactions"][0]["change_count"]
        );
        assert!(review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction_id.clone(),
            Action::Changes(rows_request()),
            "e".repeat(64)
        )
        .await
        .is_err());
        let client = details["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["table"] == "clients")
            .unwrap();
        let text = review::process_with_transport(
            local.clone(),
            server.clone(),
            "owner".into(),
            transaction_id.clone(),
            Action::Text(merge::resolution::details::TextRequest {
                review_id: report["review_id"].as_str().unwrap().into(),
                local_transaction_id: rows_request().local_transaction_id,
                sequence: client["sequence"].as_str().unwrap().into(),
                image: merge::resolution::details::Image::Local,
                field: "name".into(),
                offset: 0,
            }),
            "d".repeat(64),
        )
        .await
        .unwrap();
        assert_eq!(text["text"], "Choix local");
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
