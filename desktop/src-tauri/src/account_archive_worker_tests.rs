//! Actual archive IPC refusals, a real restore and the real PDF/encoding workers.
//! No request reaches HTTPS: handler fixtures stop at missing/draft invoices or
//! account permission checks. Native CI must execute these unrun local tests.
use super::*;
use futures_util::future::join;
use std::{future::Future, sync::mpsc, thread};
use tauri::Manager;

fn fixture(role: &str) -> (tempfile::TempDir, LocalStore, CloudSession) {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), "archive-worker-test")
        .unwrap();
    let now = Utc::now();
    let session = CloudSession {
        version: SECRET_VERSION,
        installation_id: store.installation_id.clone(),
        session_token: format!("zds_{}", "A".repeat(43)),
        session_expires_at: (now + chrono::Duration::hours(1)).to_rfc3339(),
        organization_id: format!("org_{}", Uuid::new_v4()),
        organization_name: "Synthetic archive company".into(),
        role: role.into(),
        connected_at: now.to_rfc3339(),
    };
    write_server_verified_secret(
        &session_path(&store),
        &session,
        &store.account_protected_cache.session,
    )
    .unwrap();
    (temporary, store, session)
}

fn scope(store: &LocalStore) -> String {
    crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap()
}

fn invoice(store: &LocalStore, issue: bool) -> String {
    let client = store
        .create_record(
            "clients",
            json!({
                "name":"FROZEN ARCHIVE CLIENT", "address_line1":"Rue du Test 1",
                "postal_code":"1000", "city":"Lausanne", "country":"CH"
            }),
        )
        .unwrap();
    let invoice = store
        .create_record(
            "invoices",
            json!({
                "client_id":client["id"], "title":"Synthetic archive invoice",
                "service_date_from":"2026-10-02", "service_date_to":"2026-10-02"
            }),
        )
        .unwrap();
    let id = invoice["id"].as_str().unwrap().to_owned();
    store
        .create_record(
            "invoice_items",
            json!({
                "invoice_id":id, "description":"FROZEN ARCHIVE SERVICE", "quantity":1,
                "unit":"forfait", "unit_price_cents":12500, "vat_bp":0
            }),
        )
        .unwrap();
    if issue {
        crate::tests::enable_accounting(store);
        store
            .upsert_accounting_period(crate::models::AccountingPeriodInput {
                id: None,
                name: "Synthetic archive fiscal year".into(),
                date_from: "2026-01-01".into(),
                date_to: "2026-12-31".into(),
            })
            .unwrap();
        store
            .issue_invoice(&id, Some("2026-10-02".into()), Some("2026-11-01".into()))
            .unwrap();
        store
            .update_record(
                "clients",
                client["id"].as_str().unwrap(),
                json!({"name":"CHANGED LIVE ARCHIVE CLIENT"}),
            )
            .unwrap();
    }
    id
}

fn responsive<T>(
    store: &LocalStore,
    operation: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let owned = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _local = owned.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(operation, async move {
        // A restored inline handler reaches the lock timeout first; do not
        // replace that primary failure with a cascade SendError panic.
        let _ = release_tx.send(());
    }));
    assert!(
        holder.join().unwrap(),
        "archive IPC blocked the executor while waiting for LocalStore"
    );
    result
}

#[test]
fn real_archive_handler_waiting_for_the_local_lock_leaves_its_executor_responsive() {
    let (_temporary, store, _) = fixture("owner");
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let before = store.get_workspace().unwrap();
    let license_before = store.get_license_state().unwrap();
    let missing = Uuid::new_v4().to_string();
    let result = responsive(
        &store,
        archive_invoice_to_cloud(app.state(), missing.clone(), None, Some(scope(&store))),
    );
    assert_eq!(
        result.unwrap_err(),
        command_error(AppError::NotFound(format!("invoices/{missing}")))
    );
    assert_eq!(store.get_workspace().unwrap(), before);
    assert_eq!(store.get_license_state().unwrap(), license_before);
    assert!(store
        .account_protected_cache
        .operation_lock
        .try_lock()
        .is_some());
}

#[test]
fn archive_queued_behind_account_lock_rejects_an_old_scope_after_real_restore_with_same_invoice_uuid(
) {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let (_temporary, store, _) = fixture("owner");
    // A draft is a network-free inverse witness: a missing scope guard reaches
    // the issued-document rule rather than any real account endpoint.
    let id = invoice(&store, false);
    let origin = scope(&store);
    let backup = store.create_backup(None, "archive-worker-test").unwrap();
    let protected_before = read_protected_reference(&session_path(&store)).unwrap();
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let account_guard = store
        .account_protected_cache
        .operation_lock
        .try_lock()
        .unwrap();
    let replacing = store.clone();
    let (result, restored) = tauri::async_runtime::block_on(join(
        archive_invoice_to_cloud(app.state(), id.clone(), None, Some(origin.clone())),
        async move {
            let restored = tauri::async_runtime::spawn_blocking(move || {
                let _local = replacing.lock().unwrap();
                replacing
                    .restore_backup(&backup, "archive-worker-test")
                    .unwrap();
                replacing.get_workspace().unwrap()
            })
            .await
            .unwrap();
            drop(account_guard);
            restored
        },
    ));
    assert!(result
        .unwrap_err()
        .contains("L’entreprise ouverte a changé"));
    assert_ne!(scope(&store), origin);
    assert_eq!(restored["invoices"][0]["id"], id);
    assert_eq!(store.get_workspace().unwrap(), restored);
    assert_eq!(
        read_protected_reference(&session_path(&store)).unwrap(),
        protected_before
    );
    for expected in [Some(scope(&store)), None] {
        let result = tauri::async_runtime::block_on(archive_invoice_to_cloud(
            app.state(),
            id.clone(),
            None,
            expected,
        ));
        assert!(result
            .unwrap_err()
            .contains("Émettez la facture avant de l’archiver"));
    }
}

#[test]
fn scoped_and_legacy_preparation_preserve_real_frozen_pdf_hash_metadata_and_local_license() {
    let (_temporary, store, _) = fixture("owner");
    let id = invoice(&store, true);
    let before = store.get_workspace().unwrap();
    let license_before = store.get_license_state().unwrap();
    let current_scope = scope(&store);
    let (scoped, scoped_hash) = tauri::async_runtime::block_on(prepare_invoice_archive_on_worker(
        store.clone(),
        id.clone(),
        Some(current_scope),
    ))
    .unwrap();
    let (legacy, legacy_hash) = tauri::async_runtime::block_on(prepare_invoice_archive_on_worker(
        store.clone(),
        id.clone(),
        None,
    ))
    .unwrap();
    assert_eq!(scoped.source_invoice_id, id);
    assert_eq!(scoped.issue_date, "2026-10-02");
    assert_eq!(scoped.fiscal_year_end.as_deref(), Some("2026-12-31"));
    assert_eq!(scoped.paid_at, None);
    assert_eq!(scoped.invoice_number, legacy.invoice_number);
    assert_eq!(scoped.pdf_bytes, legacy.pdf_bytes);
    assert_eq!(scoped_hash, legacy_hash);
    assert_eq!(
        scoped_hash,
        format!("{:x}", Sha256::digest(&scoped.pdf_bytes))
    );
    let pdf = lopdf::Document::load_mem(&scoped.pdf_bytes).unwrap();
    let text = pdf
        .extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
        .unwrap();
    assert!(text.contains("FROZEN ARCHIVE CLIENT"));
    assert!(text.contains("FROZEN ARCHIVE SERVICE"));
    assert!(!text.contains("CHANGED LIVE ARCHIVE CLIENT"));
    assert_eq!(store.get_workspace().unwrap(), before);
    assert_eq!(store.get_license_state().unwrap(), license_before);
}

#[test]
fn immutable_encoding_keeps_exact_prepared_bytes_after_a_real_restore() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let (_temporary, store, _) = fixture("owner");
    let id = invoice(&store, true);
    let backup = store.create_backup(None, "archive-worker-test").unwrap();
    let origin = scope(&store);
    let (local, digest) = tauri::async_runtime::block_on(prepare_invoice_archive_on_worker(
        store.clone(),
        id.clone(),
        Some(origin.clone()),
    ))
    .unwrap();
    let expected_bytes = local.pdf_bytes.clone();
    let expected_number = local.invoice_number.clone();
    {
        let _local = store.lock().unwrap();
        store
            .restore_backup(&backup, "archive-worker-test")
            .unwrap();
    }
    assert_ne!(scope(&store), origin);
    let before = store.get_workspace().unwrap();
    let body = tauri::async_runtime::block_on(encode_invoice_archive_on_worker(
        local,
        2,
        Some("Synthetic correction".into()),
    ))
    .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["sourceInvoiceId"], id);
    assert_eq!(value["invoiceNumber"], expected_number);
    assert_eq!(value["issueDate"], "2026-10-02");
    assert_eq!(value["paidAt"], serde_json::Value::Null);
    assert_eq!(value["fiscalYearEnd"], "2026-12-31");
    assert_eq!(value["revision"], 2);
    assert_eq!(value["correctionKind"], "correction");
    assert_eq!(value["correctionReason"], "Synthetic correction");
    let bytes = STANDARD
        .decode(value["pdfBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(bytes, expected_bytes);
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), digest);
    assert_eq!(store.get_workspace().unwrap(), before);
}

#[test]
fn unchanged_account_permissions_and_expiry_reject_before_pdf_or_remote_requests() {
    for kind in ["read_only", "expired", "missing"] {
        let (_temporary, store, mut session) = fixture(if kind == "read_only" {
            "read_only"
        } else {
            "owner"
        });
        if kind == "expired" {
            session.session_expires_at = (Utc::now() - chrono::Duration::seconds(1)).to_rfc3339();
            write_server_verified_secret(
                &session_path(&store),
                &session,
                &store.account_protected_cache.session,
            )
            .unwrap();
        } else if kind == "missing" {
            remove_secret(
                &session_path(&store),
                &store.account_protected_cache.session,
            )
            .unwrap();
        }
        let before = store.get_workspace().unwrap();
        let license_before = store.get_license_state().unwrap();
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        for expected in [Some(scope(&store)), None] {
            let result = tauri::async_runtime::block_on(archive_invoice_to_cloud(
                app.state(),
                Uuid::new_v4().to_string(),
                None,
                expected,
            ));
            let expected_message = match kind {
                "read_only" => "Votre rôle est limité à la consultation des archives.",
                "expired" => "La session du compte a expiré. Reconnectez ce poste.",
                _ => "Reliez ce poste au compte Zentra avant d’archiver une facture.",
            };
            assert_eq!(
                result.unwrap_err(),
                command_error(AppError::Validation(expected_message.into()))
            );
        }
        assert_eq!(store.get_workspace().unwrap(), before);
        assert_eq!(store.get_license_state().unwrap(), license_before);
    }
}

#[test]
fn immutable_body_encoding_keeps_initial_metadata_and_its_existing_size_limit() {
    let local = |size| LocalInvoiceArchive {
        source_invoice_id: "synthetic-invoice".into(),
        invoice_number: "F-TEST".into(),
        issue_date: "2026-10-02".into(),
        paid_at: Some("2026-10-03".into()),
        fiscal_year_end: Some("2026-12-31".into()),
        pdf_bytes: vec![7; size],
    };
    let body = tauri::async_runtime::block_on(encode_invoice_archive_on_worker(local(8), 1, None))
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["correctionKind"], "initial");
    assert_eq!(value["correctionReason"], serde_json::Value::Null);
    assert_eq!(value["paidAt"], "2026-10-03");
    assert_eq!(
        STANDARD
            .decode(value["pdfBase64"].as_str().unwrap())
            .unwrap(),
        vec![7; 8]
    );
    let error = tauri::async_runtime::block_on(encode_invoice_archive_on_worker(
        local(14 * 1024 * 1024),
        1,
        None,
    ));
    assert!(
        matches!(error, Err(AppError::Validation(message)) if message == "Le PDF encodé dépasse la limite d’archivage de 12 Mo.")
    );
}
