//! Actual IPC handlers with synthetic files and a held LocalStore lock.
//! These tests run in native CI; browser fixtures do not prove native execution.
use super::*;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{Duration as ChronoDuration, Local, Utc};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::future::join;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{future::Future, sync::mpsc, thread, time::Duration};
use tauri::Manager;

fn unlicensed_fixture() -> (tempfile::TempDir, LocalStore) {
    let temporary = tempfile::tempdir().unwrap();
    let mut store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    // CI runs the real release-profile guards. Give only this synthetic store
    // an authority whose private key is public test data, never a paid licence.
    store.configure_test_license_key(SigningKey::from_bytes(&[31; 32]).verifying_key().to_bytes());
    store
        .complete_onboarding(crate::tests::test_onboarding(), "import-worker-test")
        .unwrap();
    (temporary, store)
}

fn signed_fixture_token(store: &LocalStore, access_role: &str) -> String {
    let signing = SigningKey::from_bytes(&[31; 32]);
    let now = Utc::now();
    let today = Local::now().date_naive();
    let payload = crate::models::LicenseTokenPayload {
        token_version: 2,
        license_id: uuid::Uuid::new_v4().to_string(),
        installation_id: store.installation_id.clone(),
        jti: uuid::Uuid::new_v4().to_string(),
        kid: "hc-prod-v1".into(),
        customer_name: Some("Synthetic IPC company".into()),
        access_role: access_role.into(),
        account_user_id: None,
        account_session_id: None,
        plan: crate::license::LICENSE_PLAN.into(),
        price_chf_cents: crate::license::LICENSE_PRICE_CHF_CENTS,
        issued_at: now.to_rfc3339(),
        valid_from: (today - ChronoDuration::days(1))
            .format("%Y-%m-%d")
            .to_string(),
        valid_until: (today + ChronoDuration::days(30))
            .format("%Y-%m-%d")
            .to_string(),
    };
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
    format!(
        "{encoded}.{}",
        URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes())
    )
}

fn fixture() -> (tempfile::TempDir, LocalStore) {
    let (temporary, store) = unlicensed_fixture();
    let state = store
        .install_server_issued_license(&signed_fixture_token(&store, "owner"))
        .unwrap();
    assert_eq!(state["status"], "valid");
    assert_eq!(state["read_only"], false);
    // The exact handler guard still validates signature, installation, role
    // and protected clock state; the fixture does not skip require_write.
    store.require_write_access().unwrap();
    store.clone().require_write_access().unwrap();
    (temporary, store)
}

fn scope(store: &LocalStore) -> String {
    crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap()
}

fn responsive<T>(
    store: &LocalStore,
    command: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let locked_store = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = locked_store.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(command, async move {
        let _ = release_tx.send(());
    }));
    assert!(
        holder.join().unwrap(),
        "the actual import handler blocked the waiting executor"
    );
    result
}

fn catalog(sku: &str) -> ImportCatalogItemsInput {
    ImportCatalogItemsInput {
        conflict_policy: crate::catalog_import::CatalogImportConflictPolicy::Skip,
        rows: vec![crate::catalog_import::CatalogImportRowInput {
            row_number: 2,
            sku: sku.into(),
            name: "Synthetic article".into(),
            description: String::new(),
            unit: "pièce".into(),
            purchase_cost_cents: 100,
            sales_price_cents: 200,
            vat_bp: 0,
            kind: "product".into(),
        }],
    }
}

fn contacts(store: &LocalStore) -> crate::bexio_import::BexioContactImport {
    crate::bexio_import::BexioContactImport {
        scope: crate::bexio_import::scope(store).unwrap(),
        entity: "clients".into(),
        rows: vec![crate::bexio_import::BexioContactRow {
            line: 2,
            data: json!({"name":"Synthetic imported client"}),
        }],
    }
}

fn invoice(store: &LocalStore) -> SaveSupplierInvoiceDraftInput {
    let supplier = store
        .create_record("suppliers", json!({"name":"Synthetic supplier"}))
        .unwrap();
    SaveSupplierInvoiceDraftInput {
        id: Some(uuid::Uuid::new_v4().to_string()),
        supplier_id: supplier["id"].as_str().unwrap().into(),
        project_id: None,
        date: "2026-09-02".into(),
        due_date: "2026-10-02".into(),
        reference: Some("INV-SYNTHETIC-42".into()),
        note: None,
        items: vec![crate::models::SupplierInvoiceLineInput {
            id: Some(uuid::Uuid::new_v4().to_string()),
            description: "Synthetic purchase".into(),
            quantity_milli: 1000,
            unit: Some("forfait".into()),
            unit_price_cents: 10810,
            discount_bp: 0,
            vat_bp: 0,
            category: "Fournitures".into(),
            expense_account_id: None,
            project_id: None,
        }],
    }
}

fn email_input(
    path: &std::path::Path,
    invoice: SaveSupplierInvoiceDraftInput,
) -> ImportSupplierEmailInvoiceDraftInput {
    let pdf = crate::attachments::test_pdf_bytes();
    let content = format!("From: Synthetic supplier <invoice@synthetic.example>\r\nSubject: Facture INV-SYNTHETIC-42\r\nMessage-ID: <synthetic-import-worker@synthetic.example>\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nDate de facture: 02.09.2026\r\nDate d'échéance: 02.10.2026\r\nTotal TTC CHF 108.10\r\n--x\r\nContent-Type: application/pdf; name=facture.pdf\r\nContent-Disposition: attachment; filename=facture.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--x--\r\n", STANDARD.encode(&pdf));
    std::fs::write(path, &content).unwrap();
    ImportSupplierEmailInvoiceDraftInput {
        invoice,
        source_path: path.to_string_lossy().into_owned(),
        source_sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
        attachment_sha256: Some(format!("{:x}", Sha256::digest(&pdf))),
    }
}

fn camt(path: &std::path::Path) -> String {
    std::fs::write(path, r#"<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>SYNTHETIC-WORKER</MsgId></GrpHdr><Stmt><Id>SYNTHETIC-STMT</Id><Acct><Id><IBAN>CH9300762011623852957</IBAN></Id><Ccy>CHF</Ccy></Acct><Ntry><Amt Ccy="CHF">108.10</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-09-02</Dt></BookgDt><ValDt><Dt>2026-09-02</Dt></ValDt><AcctSvcrRef>SYNTHETIC-WORKER-1</AcctSvcrRef><NtryDtls><TxDtls><Refs><EndToEndId>SYNTHETIC-E2E</EndToEndId><TxId>SYNTHETIC-TX</TxId></Refs><RmtInf><Ustrd>Synthetic receipt</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>"#).unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn all_eight_actual_handlers_leave_the_executor_responsive_and_preserve_retry_contracts() {
    let (temporary, store) = fixture();
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let origin = Some(scope(&store));
    let path = camt(&temporary.path().join("synthetic.xml"));
    let first = responsive(
        &store,
        import_camt_file(app.state(), path.clone(), Some(false), origin.clone()),
    )
    .unwrap();
    let retry = responsive(
        &store,
        import_camt_file(app.state(), path, Some(false), origin.clone()),
    )
    .unwrap();
    assert_eq!(first["imported_count"], 1);
    assert_eq!(retry["duplicate"], true);
    responsive(&store, get_bank_workspace(app.state(), origin.clone())).unwrap();
    responsive(
        &store,
        import_catalog_items(app.state(), catalog("SYNTHETIC-42"), origin.clone()),
    )
    .unwrap();
    responsive(
        &store,
        import_catalog_items(app.state(), catalog("SYNTHETIC-42"), origin.clone()),
    )
    .unwrap();
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM catalog_items WHERE sku='SYNTHETIC-42'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
        1
    );
    let imported = responsive(
        &store,
        import_bexio_contacts(app.state(), contacts(&store), origin.clone()),
    )
    .unwrap();
    assert_eq!(imported["created"], 1);
    let retry = responsive(
        &store,
        import_bexio_contacts(app.state(), contacts(&store), origin.clone()),
    )
    .unwrap();
    assert_eq!(retry["skipped"], 1);
    let mail = email_input(&temporary.path().join("synthetic.eml"), invoice(&store));
    let draft_id = mail.invoice.id.clone().unwrap();
    let inspected = responsive(
        &store,
        inspect_supplier_email_file(app.state(), mail.source_path.clone(), origin.clone()),
    )
    .unwrap();
    assert_eq!(inspected["sha256"], mail.source_sha256);
    responsive(
        &store,
        import_supplier_email_invoice_draft(app.state(), mail.clone(), origin.clone()),
    )
    .unwrap();
    responsive(
        &store,
        import_supplier_email_invoice_draft(app.state(), mail, origin.clone()),
    )
    .unwrap();
    let pdf = crate::attachments::test_pdf_bytes();
    let scan = responsive(
        &store,
        add_scanned_supplier_attachment(
            app.state(),
            draft_id.clone(),
            "scan.pdf".into(),
            STANDARD.encode(&pdf),
            origin.clone(),
        ),
    )
    .unwrap();
    let attachment_path = temporary.path().join("synthetic.pdf");
    std::fs::write(&attachment_path, pdf).unwrap();
    let file = responsive(
        &store,
        add_supplier_invoice_attachment(
            app.state(),
            AddSupplierInvoiceAttachmentInput {
                supplier_invoice_id: draft_id.clone(),
                source_path: attachment_path.to_string_lossy().into_owned(),
            },
            origin,
        ),
    )
    .unwrap();
    assert_eq!(scan["id"], file["id"]);
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM attachments WHERE entity_id=?",
                [draft_id],
                |r| r.get(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn a_queued_real_handler_rejects_the_old_scope_after_a_real_database_restore() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let (_temporary, store) = fixture();
    let (_other_temporary, other) = fixture();
    other
        .create_record("clients", json!({"name":"Destination company client"}))
        .unwrap();
    let backup = other.create_backup(None, "import-worker-test").unwrap();
    let origin = scope(&store);
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let replacing_store = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (replace_tx, replace_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = replacing_store.lock().unwrap();
        ready_tx.send(()).unwrap();
        let continued = replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        replacing_store
            .restore_backup(&backup, "import-worker-test")
            .unwrap();
        continued
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(
        import_catalog_items(
            app.state(),
            catalog("MUST-NOT-BE-WRITTEN"),
            Some(origin.clone()),
        ),
        async move {
            let _ = replace_tx.send(());
        },
    ));
    assert!(
        holder.join().unwrap(),
        "replacement future could not run until the invoke thread unblocked"
    );
    assert!(result
        .unwrap_err()
        .contains("L’entreprise ouverte a changé"));
    assert_ne!(scope(&store), origin);
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM catalog_items", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store.get_workspace().unwrap()["clients"][0]["name"],
        "Destination company client"
    );
    responsive(
        &store,
        import_catalog_items(app.state(), catalog("CURRENT-SPACE"), Some(scope(&store))),
    )
    .unwrap();
    // No origin argument preserves the old contract; legacy clients do not gain
    // retrospective protection against queued workspace replacement.
    responsive(
        &store,
        import_catalog_items(app.state(), catalog("LEGACY-SPACE"), None),
    )
    .unwrap();
}

#[test]
fn an_acquired_scoped_worker_finishes_before_a_real_restore_can_replace_its_database() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let (_temporary, store) = fixture();
    let (_other_temporary, other) = fixture();
    let backup = other.create_backup(None, "import-worker-test").unwrap();
    let origin = scope(&store);
    let (running_tx, running_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (completed_tx, completed_rx) = mpsc::channel();
    let operation_store = store.clone();
    let restoring_store = store.clone();
    let expected = origin.clone();
    // This is the scoped helper with the real catalog operation, not a direct
    // handler pause: no testing hook is added to a production command.
    let (result, (restore, completed_rx)) = tauri::async_runtime::block_on(join(
        run_scoped_local_operation(operation_store, Some(origin.clone()), move |store| {
            running_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            store
                .import_catalog_items(catalog("BEFORE-RESTORE"))
                .map_err(command_error)
        }),
        async move {
            running_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let restore = thread::spawn(move || {
                attempt_tx.send(()).unwrap();
                let _guard = restoring_store.lock().unwrap();
                // Once acquired, the destination still is the original company
                // and the operation completed there before the replacement.
                assert_eq!(scope(&restoring_store), expected);
                let count = restoring_store
                    .connect()
                    .unwrap()
                    .query_row::<i64, _, _>(
                        "SELECT COUNT(*) FROM catalog_items WHERE sku='BEFORE-RESTORE'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                restoring_store
                    .restore_backup(&backup, "import-worker-test")
                    .unwrap();
                completed_tx.send(()).unwrap();
                count
            });
            attempt_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(
                matches!(
                    completed_rx.recv_timeout(Duration::from_millis(50)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ),
                "restore finished while the import still held LocalStore"
            );
            release_tx.send(()).unwrap();
            // Keep the receiver alive until the real restoration confirms completion.
            (restore, completed_rx)
        },
    ));
    result.unwrap();
    completed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(restore.join().unwrap(), 1);
    assert_ne!(scope(&store), origin);
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM catalog_items", [], |r| r.get(0))
            .unwrap(),
        0
    );
}

#[test]
fn every_actual_handler_checks_origin_before_opening_files_decoding_or_writing() {
    let (_temporary, store) = fixture();
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let wrong = Some(uuid::Uuid::new_v4().to_string());
    let invoice = invoice(&store);
    let before = store.get_workspace().unwrap();
    let assert_changed = |result: Result<Value, String>| {
        assert!(result
            .unwrap_err()
            .contains("L’entreprise ouverte a changé"))
    };
    assert_changed(responsive(
        &store,
        import_camt_file(
            app.state(),
            "does-not-exist.xml".into(),
            Some(true),
            wrong.clone(),
        ),
    ));
    assert_changed(responsive(
        &store,
        get_bank_workspace(app.state(), wrong.clone()),
    ));
    assert_changed(responsive(
        &store,
        import_catalog_items(app.state(), catalog("UNSAFE"), wrong.clone()),
    ));
    assert_changed(responsive(
        &store,
        import_bexio_contacts(app.state(), contacts(&store), wrong.clone()),
    ));
    assert_changed(responsive(
        &store,
        inspect_supplier_email_file(app.state(), "does-not-exist.eml".into(), wrong.clone()),
    ));
    assert_changed(responsive(
        &store,
        import_supplier_email_invoice_draft(
            app.state(),
            ImportSupplierEmailInvoiceDraftInput {
                invoice: invoice.clone(),
                source_path: "does-not-exist.eml".into(),
                source_sha256: "invalid".into(),
                attachment_sha256: None,
            },
            wrong.clone(),
        ),
    ));
    assert_changed(responsive(
        &store,
        add_scanned_supplier_attachment(
            app.state(),
            invoice.id.clone().unwrap(),
            "bad.pdf".into(),
            "!invalid base64!".into(),
            wrong.clone(),
        ),
    ));
    assert_changed(responsive(
        &store,
        add_supplier_invoice_attachment(
            app.state(),
            AddSupplierInvoiceAttachmentInput {
                supplier_invoice_id: invoice.id.unwrap(),
                source_path: "does-not-exist.pdf".into(),
            },
            wrong,
        ),
    ));
    assert_eq!(store.get_workspace().unwrap(), before);
}

#[test]
fn actual_draft_save_rejects_old_scan_scope_even_when_the_supplier_survives_restore() {
    let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let (_temporary, store) = fixture();
    let input = invoice(&store);
    let original = scope(&store);
    let saved_company = store.create_backup(None, "import-worker-test").unwrap();
    {
        let _guard = store.lock().unwrap();
        // Clone/restore preserves supplier UUIDs; checking only supplier IDs
        // therefore cannot keep old scanned data out of the new workspace.
        store
            .restore_backup(&saved_company, "import-worker-test")
            .unwrap();
    }
    let current = scope(&store);
    assert_ne!(current, original);
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM suppliers WHERE id=?",
                [&input.supplier_id],
                |row| row.get(0)
            )
            .unwrap(),
        1
    );
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let before = store.get_workspace().unwrap();
    let error =
        save_supplier_invoice_draft(app.state(), input.clone(), None, Some(original)).unwrap_err();
    assert!(error.contains("L’entreprise ouverte a changé"));
    assert_eq!(store.get_workspace().unwrap(), before);
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM supplier_invoices", [], |row| row
                .get(0))
            .unwrap(),
        0
    );
    save_supplier_invoice_draft(app.state(), input.clone(), None, Some(current)).unwrap();
    let mut legacy = input;
    legacy.id = Some(uuid::Uuid::new_v4().to_string());
    legacy.reference = Some("LEGACY-SYNTHETIC-42".into());
    legacy.items[0].id = Some(uuid::Uuid::new_v4().to_string());
    save_supplier_invoice_draft(app.state(), legacy, None, None).unwrap();
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM supplier_invoices", [], |row| row
                .get(0))
            .unwrap(),
        2
    );
}

#[test]
fn real_batch_handlers_roll_back_and_email_proof_failure_has_no_partial_draft() {
    let (temporary, store) = fixture();
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let origin = Some(scope(&store));
    // Trigger failure after the first SQL insert rather than only prevalidation.
    store.connect().unwrap().execute_batch("CREATE TRIGGER import_catalog_fail BEFORE INSERT ON catalog_items WHEN NEW.sku='FAIL' BEGIN SELECT RAISE(ABORT,'synthetic SQL failure'); END;").unwrap();
    let mut batch = catalog("FIRST");
    let mut failing = catalog("FAIL").rows.remove(0);
    failing.row_number = 3;
    batch.rows.push(failing);
    let catalog_error = responsive(
        &store,
        import_catalog_items(app.state(), batch, origin.clone()),
    )
    .unwrap_err();
    assert!(
        catalog_error.contains("synthetic SQL failure"),
        "{catalog_error}"
    );
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM catalog_items", [], |r| r.get(0))
            .unwrap(),
        0
    );
    let mut batch = contacts(&store);
    batch.rows.push(crate::bexio_import::BexioContactRow {
        line: 3,
        data: json!({"name":"Invalid client", "not_a_field":"rejected"}),
    });
    let contact_error = responsive(
        &store,
        import_bexio_contacts(app.state(), batch, origin.clone()),
    )
    .unwrap_err();
    assert!(
        contact_error.contains("Champ non autorisé : not_a_field"),
        "{contact_error}"
    );
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM clients", [], |r| r.get(0))
            .unwrap(),
        0
    );
    let mut email = email_input(&temporary.path().join("changed.eml"), invoice(&store));
    email.source_sha256 = "0".repeat(64);
    let before = store.get_workspace().unwrap();
    let email_error = responsive(
        &store,
        import_supplier_email_invoice_draft(app.state(), email, origin.clone()),
    )
    .unwrap_err();
    assert!(
        email_error.contains("Le message e-mail a changé depuis votre contrôle"),
        "{email_error}"
    );
    assert_eq!(store.get_workspace().unwrap(), before);
    // The raw legacy scan errors remain unchanged by the worker migration.
    assert_eq!(
        responsive(
            &store,
            add_scanned_supplier_attachment(
                app.state(),
                uuid::Uuid::new_v4().to_string(),
                "bad.pdf".into(),
                "!bad!".into(),
                origin
            )
        )
        .unwrap_err(),
        "Le fichier transmis est illisible."
    );
}

#[test]
fn actual_import_guard_refuses_missing_read_only_and_foreign_installation_licenses() {
    let (_temporary, store) = unlicensed_fixture();
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let before = store.get_workspace().unwrap();
    let missing = responsive(
        &store,
        import_catalog_items(app.state(), catalog("NO-LICENSE"), Some(scope(&store))),
    )
    .unwrap_err();
    assert!(missing.contains("Licence requise"), "{missing}");
    assert_eq!(store.get_workspace().unwrap(), before);
    let state = store
        .install_server_issued_license(&signed_fixture_token(&store, "read_only"))
        .unwrap();
    assert_eq!(state["status"], "valid");
    assert_eq!(state["read_only"], true);
    assert_eq!(
        store.get_license_state().unwrap()["access_role"],
        "read_only"
    );
    let before = store.get_workspace().unwrap();
    let limited = responsive(
        &store,
        import_catalog_items(app.state(), catalog("READ-ONLY"), Some(scope(&store))),
    )
    .unwrap_err();
    assert!(
        limited.contains("Votre rôle Zentra est limité à la lecture"),
        "{limited}"
    );
    assert_eq!(store.get_workspace().unwrap(), before);
    let (_foreign_temporary, foreign) = unlicensed_fixture();
    let error = store
        .install_server_issued_license(&signed_fixture_token(&foreign, "owner"))
        .unwrap_err();
    assert!(error.to_string().contains("installation"), "{error}");
    assert_eq!(
        store.get_license_state().unwrap()["access_role"],
        "read_only"
    );
    assert_eq!(store.get_workspace().unwrap(), before);
    let fresh_temporary = tempfile::tempdir().unwrap();
    let fresh = LocalStore::initialize(fresh_temporary.path().join("profile")).unwrap();
    fresh
        .complete_onboarding(crate::tests::test_onboarding(), "import-worker-test")
        .unwrap();
    // A separately constructed store keeps its normal embedded authority. The
    // fixture key cannot validate even a correctly bound token in that store.
    let no_inheritance = fresh
        .install_server_issued_license(&signed_fixture_token(&fresh, "owner"))
        .unwrap_err()
        .to_string();
    assert!(
        no_inheritance.contains("Signature de licence invalide")
            || no_inheritance.contains("ne contient pas les informations de vérification"),
        "{no_inheritance}"
    );
    assert_eq!(
        fresh.get_license_state().unwrap()["status"],
        if option_env!("HELVICHANTIER_LICENSE_PUBLIC_KEY_B64URL").is_some() {
            "missing"
        } else {
            "not_configured"
        }
    );
    let (_owner_temporary, owner) = fixture();
    owner.clone().require_write_access().unwrap();
}
