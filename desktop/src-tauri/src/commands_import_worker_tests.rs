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

pub(super) fn unlicensed_fixture() -> (tempfile::TempDir, LocalStore) {
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

pub(super) fn signed_fixture_token(store: &LocalStore, access_role: &str) -> String {
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

pub(super) fn fixture() -> (tempfile::TempDir, LocalStore) {
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

pub(super) fn scope(store: &LocalStore) -> String {
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

fn deletion_fixture(
    store: &LocalStore,
    count: usize,
) -> (String, Vec<(String, std::path::PathBuf)>) {
    let input = invoice(store);
    let invoice_id = input.id.clone().unwrap();
    store.save_supplier_invoice_draft(input).unwrap();
    for index in 0..count {
        let mut bytes = crate::attachments::test_pdf_bytes();
        bytes.extend_from_slice(format!("\n% synthetic attachment {index}\n").as_bytes());
        store
            .add_supplier_invoice_attachment_bytes(&invoice_id, "synthetic.pdf", &bytes)
            .unwrap();
    }
    let records = crate::database::query_all(
        &store.connect().unwrap(),
        "SELECT id,stored_name FROM attachments WHERE entity_type='supplier_invoice' AND entity_id=? ORDER BY created_at,id",
        [&invoice_id],
    )
    .unwrap();
    let files = records
        .iter()
        .map(|record| {
            (
                record["id"].as_str().unwrap().to_owned(),
                store
                    .safe_attachment_path(record["stored_name"].as_str().unwrap())
                    .unwrap(),
            )
        })
        .collect();
    (invoice_id, files)
}

fn deletion_counts(store: &LocalStore) -> (i64, i64, i64, i64, i64) {
    store.connect().unwrap().query_row(
        "SELECT (SELECT COUNT(*) FROM supplier_invoices),(SELECT COUNT(*) FROM supplier_invoice_items),(SELECT COUNT(*) FROM attachments),(SELECT COUNT(*) FROM supplier_email_invoice_imports),(SELECT COUNT(*) FROM audit_log)",
        [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
    ).unwrap()
}

#[cfg(windows)]
#[test]
fn actual_attachment_delete_confirms_committed_metadata_when_windows_file_is_locked() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_temporary, store) = fixture();
    let (_invoice_id, files) = deletion_fixture(&store, 1);
    let (attachment_id, path) = &files[0];
    let before = deletion_counts(&store);
    // Permit read/write, but deliberately omit FILE_SHARE_DELETE. The control
    // proves the real OS refuses remove_file before the actual IPC call.
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(path)
        .unwrap();
    assert_eq!(
        std::fs::remove_file(path).unwrap_err().raw_os_error(),
        Some(32)
    );
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(delete_supplier_invoice_attachment(app.state(), attachment_id.clone(), None)).unwrap(),
        json!({"deleted":true,"id":attachment_id})
    );
    assert_eq!(
        deletion_counts(&store),
        (before.0, before.1, before.2 - 1, before.3, before.4 + 1)
    );
    assert!(
        path.is_file(),
        "confirmed metadata deletion is not a physical-erasure promise"
    );
    assert!(
        tauri::async_runtime::block_on(delete_supplier_invoice_attachment(app.state(), attachment_id.clone(), None))
            .unwrap_err()
            .contains("Enregistrement introuvable")
    );
    assert_eq!(
        deletion_counts(&store),
        (before.0, before.1, before.2 - 1, before.3, before.4 + 1)
    );
    drop(locked);
}

#[cfg(windows)]
#[test]
fn actual_draft_delete_continues_other_file_cleanup_after_a_locked_first_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_temporary, store) = fixture();
    let (invoice_id, files) = deletion_fixture(&store, 3);
    let before = deletion_counts(&store);
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&files[0].1)
        .unwrap();
    assert_eq!(
        std::fs::remove_file(&files[0].1)
            .unwrap_err()
            .raw_os_error(),
        Some(32)
    );
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    assert_eq!(
        delete_supplier_invoice_draft(app.state(), invoice_id.clone()).unwrap(),
        json!({"deleted":true,"id":invoice_id})
    );
    assert_eq!(
        deletion_counts(&store),
        (
            before.0 - 1,
            before.1 - 1,
            before.2 - 3,
            before.3,
            before.4 + 4
        )
    );
    assert!(files[0].1.is_file());
    assert!(files[1..].iter().all(|(_, path)| !path.exists()));
    drop(locked);
}

#[test]
fn actual_deletions_accept_missing_files_but_remove_remaining_draft_files() {
    let (_temporary, store) = fixture();
    let (invoice_id, files) = deletion_fixture(&store, 3);
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    std::fs::remove_file(&files[0].1).unwrap();
    tauri::async_runtime::block_on(delete_supplier_invoice_attachment(app.state(), files[0].0.clone(), None)).unwrap();
    std::fs::remove_file(&files[1].1).unwrap();
    delete_supplier_invoice_draft(app.state(), invoice_id).unwrap();
    assert!(files.iter().all(|(_, path)| !path.exists()));
    assert_eq!(deletion_counts(&store).0, 0);
    assert_eq!(deletion_counts(&store).2, 0);
}

#[test]
fn actual_delete_sql_failure_rolls_back_metadata_audit_and_preserves_every_file() {
    for delete_draft in [false, true] {
        let (_temporary, store) = fixture();
        let (invoice_id, files) = deletion_fixture(&store, 2);
        let bytes: Vec<_> = files
            .iter()
            .map(|(_, path)| std::fs::read(path).unwrap())
            .collect();
        let before = deletion_counts(&store);
        store.connect().unwrap().execute_batch(
            "CREATE TRIGGER synthetic_delete_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='attachment_delete' BEGIN SELECT RAISE(ABORT,'synthetic delete audit failure'); END;",
        ).unwrap();
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let error = if delete_draft {
            delete_supplier_invoice_draft(app.state(), invoice_id)
        } else {
            tauri::async_runtime::block_on(delete_supplier_invoice_attachment(app.state(), files[0].0.clone(), None))
        }
        .unwrap_err();
        assert!(error.contains("synthetic delete audit failure"), "{error}");
        assert_eq!(deletion_counts(&store), before);
        for ((_, path), original) in files.iter().zip(bytes) {
            assert_eq!(std::fs::read(path).unwrap(), original);
        }
    }
}

#[test]
fn actual_delete_rejects_unsafe_stored_paths_before_committing_any_metadata() {
    for delete_draft in [false, true] {
        let (_temporary, store) = fixture();
        let (invoice_id, files) = deletion_fixture(&store, 2);
        // Simulate corrupt legacy metadata; only this temporary test database
        // drops its immutable-update guard to construct the negative fixture.
        store
            .connect()
            .unwrap()
            .execute_batch("DROP TRIGGER attachments_no_update;")
            .unwrap();
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE attachments SET stored_name='../../synthetic-outside.pdf' WHERE id=?",
                [&files[1].0],
            )
            .unwrap();
        let before = deletion_counts(&store);
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let error = if delete_draft {
            delete_supplier_invoice_draft(app.state(), invoice_id)
        } else {
            tauri::async_runtime::block_on(delete_supplier_invoice_attachment(app.state(), files[1].0.clone(), None))
        }
        .unwrap_err();
        assert!(error.contains("Chemin refusé"), "{error}");
        assert_eq!(deletion_counts(&store), before);
        assert!(files.iter().all(|(_, path)| path.is_file()));
    }
}

#[test]
fn actual_deletion_handlers_keep_missing_and_read_only_license_guards() {
    let (_temporary, store) = unlicensed_fixture();
    let (invoice_id, files) = deletion_fixture(&store, 1);
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    for expected in [
        "Licence requise",
        "Votre rôle Zentra est limité à la lecture",
    ] {
        let before = deletion_counts(&store);
        for error in [
            tauri::async_runtime::block_on(delete_supplier_invoice_attachment(app.state(), files[0].0.clone(), None)).unwrap_err(),
            delete_supplier_invoice_draft(app.state(), invoice_id.clone()).unwrap_err(),
        ] {
            assert!(error.contains(expected), "{error}");
        }
        assert_eq!(deletion_counts(&store), before);
        assert!(files[0].1.is_file());
        if expected == "Licence requise" {
            store
                .install_server_issued_license(&signed_fixture_token(&store, "read_only"))
                .unwrap();
        }
    }
}

#[test]
fn actual_deletion_handlers_preserve_validated_documents_and_email_evidence() {
    let (temporary, store) = fixture();
    crate::tests::enable_accounting(&store);
    let (invoice_id, files) = deletion_fixture(&store, 1);
    store.validate_supplier_invoice(&invoice_id).unwrap();
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let before = deletion_counts(&store);
    assert!(
        tauri::async_runtime::block_on(delete_supplier_invoice_attachment(app.state(), files[0].0.clone(), None))
            .unwrap_err()
            .contains("Un justificatif validé est immuable")
    );
    assert!(delete_supplier_invoice_draft(app.state(), invoice_id)
        .unwrap_err()
        .contains("Seul un brouillon fournisseur"));
    assert_eq!(deletion_counts(&store), before);
    assert!(files[0].1.is_file());

    let input = invoice(&store);
    let email = email_input(&temporary.path().join("delete-evidence.eml"), input);
    let email_invoice = email.invoice.id.clone().unwrap();
    store.import_supplier_email_invoice_draft(email).unwrap();
    let attachment: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT attachment_id FROM supplier_email_invoice_imports WHERE supplier_invoice_id=?",
            [&email_invoice],
            |row| row.get(0),
        )
        .unwrap();
    let path = store.verified_attachment_path(&attachment).unwrap();
    let before = deletion_counts(&store);
    assert!(tauri::async_runtime::block_on(delete_supplier_invoice_attachment(app.state(), attachment, None))
        .unwrap_err()
        .contains("Cette pièce prouve l'import"));
    assert_eq!(deletion_counts(&store), before);
    assert!(path.is_file());
    delete_supplier_invoice_draft(app.state(), email_invoice).unwrap();
    assert!(!path.exists());
    assert_eq!(deletion_counts(&store).3, before.3 - 1);
}

// Origin-scoped attachment IPC. No test invokes an external file viewer: open
// witnesses deliberately remove the synthetic file before the actual handler.
mod attachment_origin_scope {
    use super::*;

    #[derive(Clone, Copy, Debug)]
    enum Operation {
        Open,
        Delete,
    }

    async fn run(
        state: State<'_, LocalStore>,
        operation: Operation,
        id: String,
        expected: Option<String>,
    ) -> Result<Value, String> {
        match operation {
            Operation::Open => open_attachment(state, id, expected)
                .await
                .map(Value::String),
            Operation::Delete => delete_supplier_invoice_attachment(state, id, expected).await,
        }
    }

    // Exact 8efa71c9 handler bodies, renamed only. This source witness retains
    // the former contract without changing the current production handlers.
    fn historical_delete_supplier_invoice_attachment(
        state: State<'_, LocalStore>,
        id: String,
    ) -> Result<Value, String> {
        let _guard = state.lock().map_err(command_error)?;
        require_write(&state)?;
        state
            .delete_supplier_invoice_attachment(&id)
            .map_err(command_error)
    }

    async fn historical_open_attachment(
        state: State<'_, LocalStore>,
        id: String,
    ) -> Result<String, String> {
        let store = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = store.lock().map_err(command_error)?;
            store.open_attachment(&id).map_err(command_error)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    #[test]
    fn historical_handlers_reach_restored_same_uuid_instead_of_refusing_original_scope() {
        let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
            .lock()
            .unwrap();
        let (_temporary, store) = fixture();
        let (_invoice, files) = deletion_fixture(&store, 1);
        let (id, path) = &files[0];
        let bytes = std::fs::read(path).unwrap();
        let origin = scope(&store);
        let backup = store.create_backup(None, "attachment-origin-test").unwrap();
        {
            let _guard = store.lock().unwrap();
            store
                .restore_backup(&backup, "attachment-origin-test")
                .unwrap();
        }
        assert_ne!(scope(&store), origin);
        assert_eq!(
            store.get_workspace().unwrap()["attachments"][0]["id"],
            id.as_str()
        );
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        std::fs::remove_file(path).unwrap();
        let error =
            tauri::async_runtime::block_on(historical_open_attachment(app.state(), id.clone()))
                .unwrap_err();
        assert!(
            error.contains("Le justificatif local est absent"),
            "{error}"
        );
        std::fs::write(path, bytes).unwrap();
        let before = deletion_counts(&store);
        assert_eq!(
            historical_delete_supplier_invoice_attachment(app.state(), id.clone()).unwrap(),
            json!({"deleted":true,"id":id})
        );
        let after = deletion_counts(&store);
        assert_eq!(
            after,
            (before.0, before.1, before.2 - 1, before.3, before.4 + 1)
        );
        assert!(!path.exists());
    }

    #[test]
    fn queued_actual_handlers_refuse_original_scope_after_real_restore_with_same_uuid() {
        let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
            .lock()
            .unwrap();
        let (_temporary, store) = fixture();
        let (_invoice, files) = deletion_fixture(&store, 1);
        let (id, path) = &files[0];
        let original_bytes = std::fs::read(path).unwrap();
        let backup = store.create_backup(None, "attachment-origin-test").unwrap();
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        for operation in [Operation::Open, Operation::Delete] {
            let origin = scope(&store);
            let replacing = store.clone();
            let backup = backup.clone();
            let path_for_restore = path.clone();
            let (ready_tx, ready_rx) = mpsc::channel();
            let (replace_tx, replace_rx) = mpsc::channel();
            let holder = thread::spawn(move || {
                let _guard = replacing.lock().unwrap();
                ready_tx.send(()).unwrap();
                let released = replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
                replacing
                    .restore_backup(&backup, "attachment-origin-test")
                    .unwrap();
                let bytes = std::fs::read(&path_for_restore).unwrap();
                if matches!(operation, Operation::Open) {
                    // Even a regressed scope guard cannot launch a real viewer.
                    std::fs::remove_file(&path_for_restore).unwrap();
                }
                (
                    released,
                    replacing.get_workspace().unwrap(),
                    deletion_counts(&replacing),
                    bytes,
                )
            });
            ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let (result, ()) = tauri::async_runtime::block_on(join(
                run(app.state(), operation, id.clone(), Some(origin.clone())),
                async move {
                    replace_tx.send(()).unwrap();
                },
            ));
            let (released, restored, counts, bytes) = holder.join().unwrap();
            assert!(
                released,
                "{operation:?} blocked the executor waiting for LocalStore"
            );
            let error = result.unwrap_err();
            assert!(
                error.contains("L’entreprise ouverte a changé"),
                "{operation:?}: {error}"
            );
            assert_ne!(scope(&store), origin);
            assert_eq!(store.get_workspace().unwrap(), restored);
            assert_eq!(deletion_counts(&store), counts);
            assert_eq!(restored["attachments"][0]["id"], id.as_str());
            assert_eq!(bytes, original_bytes);
            if matches!(operation, Operation::Open) {
                assert!(!path.exists());
                std::fs::write(path, &original_bytes).unwrap();
            } else {
                assert_eq!(std::fs::read(path).unwrap(), original_bytes);
            }
        }
    }

    #[test]
    fn current_scope_and_legacy_none_preserve_missing_file_errors_and_delete_receipts() {
        let (_temporary, store) = fixture();
        let (_invoice, files) = deletion_fixture(&store, 2);
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        for ((id, path), expected) in files.iter().zip([Some(scope(&store)), None]) {
            let bytes = std::fs::read(path).unwrap();
            let before = deletion_counts(&store);
            std::fs::remove_file(path).unwrap();
            let error = responsive(
                &store,
                run(app.state(), Operation::Open, id.clone(), expected.clone()),
            )
            .unwrap_err();
            assert!(
                error.contains("Le justificatif local est absent"),
                "{error}"
            );
            assert_eq!(deletion_counts(&store), before);
            std::fs::write(path, bytes).unwrap();
            let receipt = responsive(
                &store,
                run(app.state(), Operation::Delete, id.clone(), expected.clone()),
            )
            .unwrap();
            assert_eq!(receipt, json!({"deleted":true,"id":id}));
            let after = (before.0, before.1, before.2 - 1, before.3, before.4 + 1);
            assert_eq!(deletion_counts(&store), after);
            assert!(!path.exists());
            let error = tauri::async_runtime::block_on(run(
                app.state(),
                Operation::Delete,
                id.clone(),
                expected,
            ))
            .unwrap_err();
            assert!(error.contains("Enregistrement introuvable"), "{error}");
            assert_eq!(deletion_counts(&store), after);
        }
    }

    #[test]
    fn stale_scope_precedes_uuid_validation_license_and_file_lookup() {
        let (_temporary, store) = unlicensed_fixture();
        let (_invoice, files) = deletion_fixture(&store, 1);
        let (id, path) = &files[0];
        let before = store.get_workspace().unwrap();
        let bytes = std::fs::read(path).unwrap();
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        std::fs::remove_file(path).unwrap();
        for operation in [Operation::Open, Operation::Delete] {
            for old_id in ["invalid-uuid".to_owned(), id.clone()] {
                let error = tauri::async_runtime::block_on(run(
                    app.state(),
                    operation,
                    old_id,
                    Some("synthetic-old-scope".into()),
                ))
                .unwrap_err();
                assert!(
                    error.contains("L’entreprise ouverte a changé"),
                    "{operation:?}: {error}"
                );
            }
        }
        assert_eq!(store.get_workspace().unwrap(), before);
        assert!(!path.exists());
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn scoped_delete_keeps_license_guards_and_open_keeps_its_read_only_contract() {
        let (_temporary, store) = unlicensed_fixture();
        let (_invoice, files) = deletion_fixture(&store, 1);
        let (id, path) = &files[0];
        let bytes = std::fs::read(path).unwrap();
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        for refusal in [
            "Licence requise",
            "Votre rôle Zentra est limité à la lecture",
        ] {
            let before = deletion_counts(&store);
            std::fs::remove_file(path).unwrap();
            for expected in [Some(scope(&store)), None] {
                let error = tauri::async_runtime::block_on(run(
                    app.state(),
                    Operation::Delete,
                    id.clone(),
                    expected.clone(),
                ))
                .unwrap_err();
                assert!(error.contains(refusal), "{error}");
                let error = tauri::async_runtime::block_on(run(
                    app.state(),
                    Operation::Open,
                    id.clone(),
                    expected,
                ))
                .unwrap_err();
                assert!(
                    error.contains("Le justificatif local est absent"),
                    "{error}"
                );
            }
            assert_eq!(deletion_counts(&store), before);
            std::fs::write(path, &bytes).unwrap();
            if refusal == "Licence requise" {
                store
                    .install_server_issued_license(&signed_fixture_token(&store, "read_only"))
                    .unwrap();
            }
        }
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn scoped_delete_preserves_validated_invoice_and_email_import_evidence() {
        let (temporary, store) = fixture();
        crate::tests::enable_accounting(&store);
        let (invoice_id, files) = deletion_fixture(&store, 1);
        store.validate_supplier_invoice(&invoice_id).unwrap();
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let before = deletion_counts(&store);
        let error = tauri::async_runtime::block_on(run(
            app.state(),
            Operation::Delete,
            files[0].0.clone(),
            Some(scope(&store)),
        ))
        .unwrap_err();
        assert!(
            error.contains("Un justificatif validé est immuable"),
            "{error}"
        );
        assert_eq!(deletion_counts(&store), before);
        assert!(files[0].1.is_file());
        let input = invoice(&store);
        let email = email_input(&temporary.path().join("scoped-evidence.eml"), input);
        let invoice_id = email.invoice.id.clone().unwrap();
        store.import_supplier_email_invoice_draft(email).unwrap();
        let attachment: String = store.connect().unwrap().query_row(
            "SELECT attachment_id FROM supplier_email_invoice_imports WHERE supplier_invoice_id=?",
            [&invoice_id], |row| row.get(0),
        ).unwrap();
        let path = store.verified_attachment_path(&attachment).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let before = deletion_counts(&store);
        let error = tauri::async_runtime::block_on(run(
            app.state(),
            Operation::Delete,
            attachment,
            Some(scope(&store)),
        ))
        .unwrap_err();
        assert!(error.contains("Cette pièce prouve l'import"), "{error}");
        assert_eq!(deletion_counts(&store), before);
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

mod fixed_asset_account_preparation {
    use super::*;

    fn account(store: &LocalStore, code: &str, kind: &str, section: &str, active: bool) -> Value {
        store
            .upsert_account(AccountInput {
                id: None,
                code: code.into(),
                name: format!("Synthetic account {code}"),
                account_type: kind.into(),
                normal_balance: "debit".into(),
                report_section: section.into(),
                active,
            })
            .unwrap()
    }

    fn accounts_and_audit(store: &LocalStore) -> (Value, Vec<Value>) {
        (
            store.list_accounts().unwrap(),
            crate::database::query_all(
                &store.connect().unwrap(),
                "SELECT * FROM audit_log ORDER BY rowid",
                [],
            )
            .unwrap(),
        )
    }

    fn prepare(store: &LocalStore, expected: String) -> Result<Value, String> {
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        tauri::async_runtime::block_on(prepare_fixed_asset_accounts(app.state(), expected))
    }

    #[test]
    fn actual_preparation_creates_only_missing_accounts_and_is_idempotent() {
        for (has_asset, has_depreciation) in
            [(false, false), (true, false), (false, true), (true, true)]
        {
            let (_temporary, store) = fixture();
            let asset = has_asset.then(|| account(&store, "1500", "asset", "fixed_assets", true));
            let depreciation =
                has_depreciation.then(|| account(&store, "6800", "expense", "depreciation", true));
            let (before_accounts, before_audit) = accounts_and_audit(&store);
            let receipt = prepare(&store, scope(&store)).unwrap();
            let created = usize::from(!has_asset) + usize::from(!has_depreciation);
            assert_eq!(
                receipt["accounts"].as_array().unwrap().len(),
                before_accounts.as_array().unwrap().len() + created
            );
            let (after_accounts, after_audit) = accounts_and_audit(&store);
            assert_eq!(receipt["accounts"], after_accounts);
            assert_eq!(after_audit.len(), before_audit.len() + created);
            for (field, existing, code, kind, section) in [
                ("assetAccountId", asset, "1500", "asset", "fixed_assets"),
                (
                    "depreciationAccountId",
                    depreciation,
                    "6800",
                    "expense",
                    "depreciation",
                ),
            ] {
                let selected = receipt["accounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["id"] == receipt[field])
                    .unwrap();
                if let Some(existing) = existing {
                    assert_eq!(selected, &existing);
                } else {
                    assert_eq!(selected["code"], code);
                    assert_eq!(selected["account_type"], kind);
                    assert_eq!(selected["report_section"], section);
                    assert_eq!(selected["normal_balance"], "debit");
                    assert_eq!(selected["active"], true);
                    let audit = after_audit
                        .iter()
                        .find(|row| {
                            row["entity_type"] == "account" && row["entity_id"] == receipt[field]
                        })
                        .unwrap();
                    assert_eq!(audit["action"], "upsert");
                    let payload: Value =
                        serde_json::from_str(audit["payload_json"].as_str().unwrap()).unwrap();
                    assert_eq!(&payload, selected);
                }
            }
            assert_eq!(prepare(&store, scope(&store)).unwrap(), receipt);
            assert_eq!(accounts_and_audit(&store), (after_accounts, after_audit));
            assert_eq!(
                crate::audit::verify_audit_chain(&store.connect().unwrap()).unwrap()["valid"],
                true
            );
        }
    }

    #[test]
    fn actual_preparation_reuses_sorted_custom_usages_without_reclassifying_default_codes() {
        let (_temporary, store) = fixture();
        account(&store, "1500", "asset", "current_assets", true);
        account(&store, "6800", "expense", "other_operating_expense", true);
        account(&store, "1400", "asset", "fixed_assets", false);
        account(&store, "1600", "asset", "fixed_assets", true);
        let asset = account(&store, "1590", "asset", "fixed_assets", true);
        account(&store, "6890", "expense", "depreciation", true);
        let depreciation = account(&store, "6810", "expense", "depreciation", true);
        let before = accounts_and_audit(&store);
        let receipt = prepare(&store, scope(&store)).unwrap();
        assert_eq!(receipt["assetAccountId"], asset["id"]);
        assert_eq!(receipt["depreciationAccountId"], depreciation["id"]);
        assert_eq!(receipt["accounts"], before.0);
        assert_eq!(accounts_and_audit(&store), before);
    }

    #[test]
    fn two_actual_preparations_share_one_atomic_creation_and_return_the_same_accounts() {
        let (_temporary, store) = fixture();
        let before = accounts_and_audit(&store);
        let expected = scope(&store);
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (first, second) = tauri::async_runtime::block_on(join(
            prepare_fixed_asset_accounts(app.state(), expected.clone()),
            prepare_fixed_asset_accounts(app.state(), expected),
        ));
        let first = first.unwrap();
        assert_eq!(second.unwrap(), first);
        let after = accounts_and_audit(&store);
        assert_eq!(first["accounts"], after.0);
        assert_eq!(
            after.0.as_array().unwrap().len(),
            before.0.as_array().unwrap().len() + 2
        );
        assert_eq!(after.1.len(), before.1.len() + 2);
    }

    #[test]
    fn actual_preparation_refuses_either_occupied_or_inactive_default_before_any_creation() {
        for (code, kind, section, active) in [
            ("1500", "asset", "current_assets", true),
            ("6800", "expense", "other_operating_expense", true),
            ("1500", "asset", "fixed_assets", false),
            ("6800", "expense", "depreciation", false),
        ] {
            let (_temporary, store) = fixture();
            account(&store, code, kind, section, active);
            let before = accounts_and_audit(&store);
            let error = prepare(&store, scope(&store)).unwrap_err();
            assert!(
                error.contains(&format!("Le compte {code} existe avec un autre usage")),
                "{error}"
            );
            assert_eq!(accounts_and_audit(&store), before);
        }
    }

    #[test]
    fn actual_preparation_rolls_back_both_creations_when_the_second_insert_or_audit_fails() {
        for trigger in [
            "CREATE TRIGGER synthetic_fail_second_account BEFORE INSERT ON accounts WHEN NEW.code='6800' BEGIN SELECT RAISE(ABORT,'synthetic second account failure'); END",
            "CREATE TRIGGER synthetic_fail_second_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='account' AND json_extract(NEW.payload_json,'$.code')='6800' BEGIN SELECT RAISE(ABORT,'synthetic second audit failure'); END",
        ] {
            let (_temporary, store) = fixture();
            store.connect().unwrap().execute_batch(trigger).unwrap();
            let before = accounts_and_audit(&store);
            assert!(prepare(&store, scope(&store)).unwrap_err().contains("synthetic second"));
            assert_eq!(accounts_and_audit(&store), before);
            assert_eq!(crate::audit::verify_audit_chain(&store.connect().unwrap()).unwrap()["valid"], true);
            store.connect().unwrap().execute_batch("DROP TRIGGER IF EXISTS synthetic_fail_second_account; DROP TRIGGER IF EXISTS synthetic_fail_second_audit;").unwrap();
            let receipt = prepare(&store, scope(&store)).unwrap();
            assert_eq!(receipt["accounts"].as_array().unwrap().len(), before.0.as_array().unwrap().len() + 2);
            assert_eq!(accounts_and_audit(&store).1.len(), before.1.len() + 2);
        }
    }

    #[test]
    fn actual_preparation_waits_off_executor_and_checks_the_scope_after_real_restore() {
        let _transfer_test = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
            .lock()
            .unwrap();
        let (temporary, store) = fixture();
        let original_account = account(&store, "1700", "asset", "fixed_assets", true);
        let snapshot = temporary.path().join("account-preparation.zentra");
        store
            .create_backup_at(&snapshot, "fixed-asset-account-test")
            .unwrap();
        let expected = scope(&store);
        let app = tauri::test::mock_builder()
            .manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let replacing_store = store.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let holder = thread::spawn(move || {
            let _guard = replacing_store.lock().unwrap();
            ready_tx.send(()).unwrap();
            let released = release_rx.recv_timeout(Duration::from_secs(5)).is_ok();
            replacing_store
                .restore_backup(&snapshot.to_string_lossy(), "fixed-asset-account-test")
                .unwrap();
            (released, accounts_and_audit(&replacing_store))
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (result, ()) = tauri::async_runtime::block_on(join(
            prepare_fixed_asset_accounts(app.state(), expected.clone()),
            async move {
                release_tx.send(()).unwrap();
            },
        ));
        let (released, restored) = holder.join().unwrap();
        assert!(
            released,
            "the actual preparation handler blocked the waiting executor"
        );
        assert!(result
            .unwrap_err()
            .contains("L’entreprise ouverte a changé"));
        assert_ne!(scope(&store), expected);
        assert_eq!(accounts_and_audit(&store), restored);
        let preserved = restored
            .0
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["code"] == "1700")
            .unwrap();
        assert_eq!(preserved["id"], original_account["id"]);
        assert_eq!(
            restored
                .0
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["code"] == "1700")
                .count(),
            1
        );
        assert!(!restored
            .0
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["code"] == "6800"));
        store
            .install_server_issued_license(&signed_fixture_token(&store, "owner"))
            .unwrap();
        let receipt = responsive(
            &store,
            prepare_fixed_asset_accounts(app.state(), scope(&store)),
        )
        .unwrap();
        assert_eq!(receipt["accounts"], store.list_accounts().unwrap());
        assert_eq!(
            receipt["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["code"] == "1700")
                .count(),
            1
        );
    }

    #[test]
    fn actual_preparation_preserves_license_role_foreign_installation_and_onboarding_rejections() {
        for access in ["missing", "read_only", "foreign"] {
            let (_temporary, store) = unlicensed_fixture();
            if access == "read_only" {
                store
                    .install_server_issued_license(&signed_fixture_token(&store, access))
                    .unwrap();
            } else if access == "foreign" {
                let (_foreign_temporary, foreign) = fixture();
                let rejection = store
                    .install_server_issued_license(&signed_fixture_token(&foreign, "owner"))
                    .unwrap_err();
                assert!(rejection.to_string().contains("installation"), "{rejection}");
            }
            let before = accounts_and_audit(&store);
            let error = prepare(&store, scope(&store)).unwrap_err();
            assert!(
                error.contains("Licence requise") || error.contains("limité à la lecture"),
                "{error}"
            );
            assert_eq!(accounts_and_audit(&store), before);
            let error = prepare(&store, uuid::Uuid::new_v4().to_string()).unwrap_err();
            assert!(error.contains("L’entreprise ouverte a changé"), "{error}");
            assert_eq!(accounts_and_audit(&store), before);
        }
        let (_temporary, store) = fixture();
        store
            .connect()
            .unwrap()
            .execute("UPDATE settings SET onboarding_completed=0 WHERE id=1", [])
            .unwrap();
        let before = crate::database::query_all(
            &store.connect().unwrap(),
            "SELECT * FROM accounts ORDER BY code,name",
            [],
        )
        .unwrap();
        let error = prepare(&store, scope(&store)).unwrap_err();
        assert!(
            error.contains("Le questionnaire initial doit être terminé"),
            "{error}"
        );
        assert_eq!(
            crate::database::query_all(
                &store.connect().unwrap(),
                "SELECT * FROM accounts ORDER BY code,name",
                []
            )
            .unwrap(),
            before
        );
    }
}
