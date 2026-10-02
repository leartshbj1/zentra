//! Exercise the actual IPC handlers, not only their worker helper. A second
//! future must run while each command waits for the existing local-store lock.
use super::*;
use futures_util::future::join;
use serde_json::json;
use std::{future::Future, sync::mpsc, thread, time::Duration};
use tauri::Manager;

fn fixture() -> (tempfile::TempDir, LocalStore) {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), "pdf-worker-test")
        .unwrap();
    (temporary, store)
}

fn responsive_result<T>(
    store: &LocalStore,
    command: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let locked_store = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let lock_holder = thread::spawn(move || {
        let _guard = locked_store.lock().unwrap();
        ready_tx.send(()).unwrap();
        // The deadline prevents a reverted inline handler from hanging CI.
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(command, async move {
        let _ = release_tx.send(());
    }));
    assert!(
        lock_holder.join().unwrap(),
        "the actual PDF command blocked its waiting executor until the lock deadline"
    );
    result
}

fn pdf_text(bytes: &[u8]) -> String {
    assert!(bytes.starts_with(b"%PDF-"));
    let pdf = lopdf::Document::load_mem(bytes).unwrap();
    assert!(!pdf.get_pages().is_empty());
    pdf.extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
        .unwrap()
}

#[test]
fn real_design_preview_and_export_commands_leave_the_executor_responsive() {
    let (temporary, store) = fixture();
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let before = store.get_workspace().unwrap();
    for kind in ["quotes", "invoices", "payslips", "accounts"] {
        let issuer = json!({"company_name":"WORKER DESIGN COMPANY"});
        let bytes = responsive_result(
            &store,
            document_design_example(app.state(), kind.into(), json!({}), issuer.clone()),
        )
        .unwrap();
        assert!(pdf_text(&bytes).contains("WORKER DESIGN COMPANY"));
        let destination = temporary.path().join(format!("{kind}.pdf"));
        let path = responsive_result(
            &store,
            export_document_design_example(
                app.state(),
                kind.into(),
                json!({}),
                issuer,
                destination.to_string_lossy().into_owned(),
            ),
        )
        .unwrap();
        assert_eq!(std::path::Path::new(&path), destination);
        assert_eq!(std::fs::read(destination).unwrap(), bytes);
    }
    assert_eq!(store.get_workspace().unwrap(), before);
}

#[test]
fn real_sales_preview_and_export_preserve_the_issued_document_and_company_data() {
    let (temporary, store) = fixture();
    let client = store
        .create_record(
            "clients",
            json!({
                "name":"FROZEN WORKER CLIENT","address_line1":"Rue test 1",
                "postal_code":"1000","city":"Lausanne","country":"CH"
            }),
        )
        .unwrap();
    let quote = store
        .create_record(
            "quotes",
            json!({
                "client_id":client["id"],"title":"Worker quote"
            }),
        )
        .unwrap();
    let id = quote["id"].as_str().unwrap().to_owned();
    store
        .create_record(
            "quote_items",
            json!({
                "quote_id":id,"description":"FROZEN WORKER SERVICE","quantity":1,
                "unit":"forfait","unit_price_cents":12500,"vat_bp":0
            }),
        )
        .unwrap();
    store
        .issue_quote(&id, Some("2026-10-02".into()), Some("2026-11-01".into()))
        .unwrap();
    store
        .update_record(
            "clients",
            client["id"].as_str().unwrap(),
            json!({"name":"CHANGED LIVE CLIENT"}),
        )
        .unwrap();
    let before = store.get_workspace().unwrap();
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let preview = responsive_result(
        &store,
        document_pdf_preview(app.state(), "quotes".into(), id.clone()),
    )
    .unwrap();
    let preview_text = pdf_text(&preview);
    assert!(preview_text.contains("FROZEN WORKER CLIENT"));
    assert!(preview_text.contains("FROZEN WORKER SERVICE"));
    assert!(!preview_text.contains("CHANGED LIVE CLIENT"));
    let destination = temporary.path().join("quote.pdf");
    let result = responsive_result(
        &store,
        generate_sales_document_pdf(
            app.state(),
            GenerateSalesDocumentPdfInput {
                entity: "quotes".into(),
                document_id: id,
                destination_path: destination.to_string_lossy().into_owned(),
            },
        ),
    )
    .unwrap();
    assert_eq!(result["final_document"], true);
    assert_eq!(pdf_text(&std::fs::read(destination).unwrap()), preview_text);
    assert_eq!(store.get_workspace().unwrap(), before);
}

#[test]
fn real_annual_accounts_and_project_report_commands_render_without_blocking() {
    let (temporary, store) = fixture();
    crate::tests::enable_accounting(&store);
    let before = store.get_workspace().unwrap();
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let destination = temporary.path().join("annual.pdf");
    let result = responsive_result(
        &store,
        export_annual_accounts_pdf(
            app.state(),
            PeriodFilter {
                date_from: Some("2026-01-01".into()),
                date_to: Some("2026-12-31".into()),
            },
            destination.to_string_lossy().into_owned(),
        ),
    )
    .unwrap();
    assert_eq!(result["balanced"], true);
    pdf_text(&std::fs::read(destination).unwrap());
    let report = serde_json::from_value(json!({
        "language":"fr","title":"WORKER PROJECT REPORT","subtitle":"Project fixture",
        "sections":[{"title":"Project facts","headers":["Item","Value"],"rows":[["Reference","WORKER PROJECT REFERENCE"]]}]
    })).unwrap();
    let destination = temporary.path().join("project.pdf");
    let result = responsive_result(
        &store,
        crate::project_report::export_project_report_pdf(
            app.state(),
            report,
            destination.to_string_lossy().into_owned(),
            None,
        ),
    )
    .unwrap();
    assert_eq!(result["path"], destination.to_string_lossy().as_ref());
    let text = pdf_text(&std::fs::read(destination).unwrap());
    assert!(text.contains("WORKER PROJECT REPORT"));
    assert!(text.contains("WORKER PROJECT REFERENCE"));
    assert_eq!(store.get_workspace().unwrap(), before);
}

fn invalid_certificate() -> crate::salary_certificate::CertificateInput {
    serde_json::from_value(json!({
        "employeeId":"missing-worker-employee","year":2026,"sourceHash":"missing-source",
        "identity":{"name":"","address":"","avsNumber":"","birthDate":"","periodStart":"2026-01-01","periodEnd":"2026-12-31","employerContact":"","placeDate":""},
        "allocations":{},"sourceIds":[],"realizationNote":"","extras":[],
        "freeTransport":false,"meals":false,"effectiveExpensesAttested":false,
        "benefits":"","remarks":"","reviewed":false
    })).unwrap()
}

#[test]
fn real_payroll_pdf_commands_preserve_errors_and_existing_destination_files() {
    let (temporary, store) = fixture();
    let app = tauri::test::mock_builder()
        .manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let destination = temporary.path().join("existing.pdf");
    std::fs::write(&destination, b"existing destination stays intact").unwrap();
    let input = || GeneratePayslipPdfInput {
        payslip_id: "missing-worker-payslip".into(),
        destination_path: destination.to_string_lossy().into_owned(),
    };
    let expected = command_error(store.generate_payslip_pdf(input()).unwrap_err());
    let error = responsive_result(&store, generate_payslip_pdf(app.state(), input())).unwrap_err();
    assert_eq!(error, expected);
    let expected = command_error(
        store
            .salary_certificate_preview(&invalid_certificate())
            .unwrap_err(),
    );
    let error = responsive_result(
        &store,
        salary_certificate_preview(app.state(), invalid_certificate()),
    )
    .unwrap_err();
    assert_eq!(error, expected);
    let expected = command_error(
        store
            .export_salary_certificate(&invalid_certificate(), destination.to_str().unwrap())
            .unwrap_err(),
    );
    let error = responsive_result(
        &store,
        export_salary_certificate(
            app.state(),
            invalid_certificate(),
            destination.to_string_lossy().into_owned(),
        ),
    )
    .unwrap_err();
    assert_eq!(error, expected);
    assert_eq!(
        std::fs::read(destination).unwrap(),
        b"existing destination stays intact"
    );
}
