//! Additional payroll guard candidate, separate from generic CRUD coverage.
//! Actual Tauri handlers, real LocalStore mutex and existing signature-checked
//! test-only licence fixtures. No production key, licence exemption or payment.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use futures_util::future::join;
use serde_json::json;
use std::{future::Future, sync::mpsc, thread, time::Duration};
use tauri::Manager;

fn nonce(store: &LocalStore) -> String {
    crate::member_context::read(&store.connect().unwrap()).unwrap()
}
fn identity(store: &LocalStore, user: &str, role: &str) {
    crate::company_collaboration::set_identity(store, "synthetic-payroll-org", user, "Synthetic payroll member", role).unwrap();
}
fn employee(store: &LocalStore, id: &str, name: &str) {
    store.create_record("employees", json!({"id":id,"name":name})).unwrap();
}
fn input(id: Option<String>, employee_id: String, amount: i64) -> SavePayslipWithContributionsInput {
    SavePayslipWithContributionsInput {
        id, employee_id, period: "2026-09".into(), status: "a_controler".into(),
        payment_date: None, notes: Some("Synthetic guarded payroll save".into()),
        lines: vec![crate::models::PayslipManualLineInput {
            id: None, label: "Synthetic monthly wage".into(), kind: "earning".into(),
            amount_cents: amount, posting_account_id: None, expense_account_id: None,
        }], contributions: Vec::new(),
    }
}
fn snapshot(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();
    let mut values = serde_json::Map::new();
    for table in ["employees", "payslips", "payslip_items", "payslip_contributions", "payslip_small_salary_assessments", "audit_log", "journal_entries", "journal_lines", "company_local_clock"] {
        values.insert(table.into(), json!(crate::database::query_all(
            &connection, &format!("SELECT * FROM {table} ORDER BY rowid"), [],
        ).unwrap()));
    }
    Value::Object(values)
}
fn responsive<T>(store: &LocalStore, command: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    let held = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = held.lock().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(command, async move { let _ = release_tx.send(()); }));
    assert!(holder.join().unwrap(), "actual payroll handler must yield while waiting for the local mutex");
    result
}

#[test]
fn actual_payslip_handler_yields_and_keeps_current_and_legacy_success_receipts() {
    for legacy in [false, true] {
        let (_directory, store) = fixture();
        identity(&store, &uuid::Uuid::new_v4().to_string(), "owner");
        let employee_id = uuid::Uuid::new_v4().to_string();
        employee(&store, &employee_id, "Synthetic payroll A");
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let expected_scope = if legacy { None } else { Some(scope(&store)) };
        let expected_nonce = if legacy { None } else { Some(nonce(&store)) };
        let journal_count_before: i64 = store.connect().unwrap().query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0)).unwrap();
        let mut initial = input(None, employee_id.clone(), 512_345);
        initial.status = "brouillon".into(); // The first active caller is a salary-only draft.
        store.require_write_access().unwrap();
        let result = responsive(&store, save_payslip_with_contributions(
            app.state(), initial, expected_scope.clone(), expected_nonce.clone(),
        )).unwrap();
        let id = result["payslip"]["id"].as_str().unwrap().to_owned();
        assert_eq!(result["payslip"]["employee_id"], employee_id);
        assert_eq!(result["payslip"]["status"], "brouillon");
        assert_eq!(result["payslip"]["gross_cents"], 512_345);
        assert_eq!(result["payslip"]["net_cents"], 512_345);
        assert_eq!(result["manual_lines"].as_array().unwrap().len(), 1);
        assert!(result["contributions"].as_array().unwrap().is_empty());
        let updated = responsive(&store, save_payslip_with_contributions(
            app.state(), input(Some(id.clone()), employee_id, 534_567), expected_scope, expected_nonce,
        )).unwrap();
        assert_eq!(updated["payslip"]["id"], id);
        assert_eq!(updated["payslip"]["gross_cents"], 534_567);
        assert_eq!(store.connect().unwrap().query_row::<i64, _, _>(
            "SELECT COUNT(*) FROM audit_log WHERE entity_type='payslip_atomic' AND entity_id=?", [&id], |row| row.get(0),
        ).unwrap(), 2);
        assert_eq!(store.connect().unwrap().query_row::<i64, _, _>("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0)).unwrap(), journal_count_before);
        assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
    }
}

#[test]
fn actual_payslip_handler_rejects_captured_member_a_to_b_and_aba_without_writes() {
    for editing in [false, true] {
        for return_to_a in [false, true] {
            let (_directory, store) = fixture();
            let alice = uuid::Uuid::new_v4().to_string();
            identity(&store, &alice, "owner");
            let employee_id = uuid::Uuid::new_v4().to_string();
            employee(&store, &employee_id, "Synthetic unchanged payroll employee");
            let existing = if editing {
                Some(store.save_payslip_with_contributions(input(None, employee_id.clone(), 500_000)).unwrap()["payslip"]["id"].as_str().unwrap().to_owned())
            } else { None };
            let expected_scope = scope(&store);
            let expected_nonce = nonce(&store);
            let app = tauri::test::mock_builder().manage(store.clone())
                .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
            // Capture before the real setter transition; poll the actual handler
            // afterwards. This is not a paused/queued setter race witness.
            let pending = save_payslip_with_contributions(app.state(), input(existing, employee_id, 700_000), Some(expected_scope.clone()), Some(expected_nonce.clone()));
            identity(&store, &uuid::Uuid::new_v4().to_string(), "owner");
            if return_to_a { identity(&store, &alice, "owner"); }
            assert_eq!(scope(&store), expected_scope);
            assert_ne!(nonce(&store), expected_nonce);
            store.require_write_access().unwrap();
            let before = snapshot(&store);
            assert!(responsive(&store, pending).unwrap_err().contains("Le compte connecté a changé"));
            assert_eq!(snapshot(&store), before);
        }
    }
}

#[test]
fn queued_actual_payslip_handler_rejects_physical_restore_with_same_employee_and_payslip_ids() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for editing in [false, true] {
    let (_directory, store) = fixture();
    let (_other_directory, other) = fixture();
    let employee_id = uuid::Uuid::new_v4().to_string();
    employee(&store, &employee_id, "Synthetic company A employee");
    employee(&other, &employee_id, "Synthetic company B employee");
    let a = store.save_payslip_with_contributions(input(None, employee_id.clone(), 500_000)).unwrap();
    let payslip_id = a["payslip"]["id"].as_str().unwrap().to_owned();
    // Fixture-only creation with the same UUID in B; ordinary save treats a
    // supplied ID as an existing edit, so create the row before its real engine.
    other.create_record("payslips", json!({"id":payslip_id,"employee_id":employee_id,"period":"2026-09","status":"a_controler"})).unwrap();
    other.save_payslip_with_contributions(input(Some(payslip_id.clone()), employee_id.clone(), 600_000)).unwrap();
    let backup = other.create_backup(None, "payslip-origin-test").unwrap();
    let old_scope = scope(&store);
    let old_nonce = nonce(&store);
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let replacing = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (replace_tx, replace_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = replacing.lock().unwrap();
        let license_before: (String, String) = replacing.connect().unwrap().query_row(
            "SELECT token_sha256,license_id FROM license_state WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        ready_tx.send(()).unwrap();
        let released = replace_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        replacing.require_backup_restore_access().unwrap();
        replacing.restore_backup(&backup, "payslip-origin-test").unwrap();
        let license_after: (String, String) = replacing.connect().unwrap().query_row(
            "SELECT token_sha256,license_id FROM license_state WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(license_before, license_after);
        replacing.require_write_access().unwrap(); // No reinstall under the held mutex.
        (released, snapshot(&replacing))
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let mut captured = input(if editing { Some(payslip_id) } else { None }, employee_id, 900_000);
    if !editing { captured.period = "2026-10".into(); }
    let (result, ()) = tauri::async_runtime::block_on(join(
        save_payslip_with_contributions(app.state(), captured, Some(old_scope.clone()), Some(old_nonce)),
        async move { let _ = replace_tx.send(()); },
    ));
    let (released, destination) = holder.join().unwrap();
    assert!(released, "physical restore must progress beside the waiting actual payroll handler");
    assert_ne!(scope(&store), old_scope);
    assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));
    assert_eq!(snapshot(&store), destination);
    }
}

#[test]
fn actual_payslip_handler_preserves_create_and_update_rollback_on_business_error() {
    let (_directory, store) = fixture();
    identity(&store, &uuid::Uuid::new_v4().to_string(), "owner");
    let employee_id = uuid::Uuid::new_v4().to_string();
    employee(&store, &employee_id, "Synthetic rollback employee");
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    for editing in [false, true] {
        let id = if editing {
            Some(store.save_payslip_with_contributions(input(None, employee_id.clone(), 500_000)).unwrap()["payslip"]["id"].as_str().unwrap().to_owned())
        } else { None };
        let mut bad = input(id, employee_id.clone(), 700_000);
        bad.contributions.push(crate::models::ContributionSelectionInput { definition_id: "synthetic-nonexistent-contribution".into(), basis_cents: None, year_to_date_basis_cents: None });
        let before = snapshot(&store);
        let error = responsive(&store, save_payslip_with_contributions(app.state(), bad, Some(scope(&store)), Some(nonce(&store)))).unwrap_err();
        assert!(error.contains("payroll_contribution_definitions/synthetic-nonexistent-contribution"), "the real contribution lookup must fail inside the payroll transaction: {error}");
        assert!(!error.contains("L’entreprise ouverte a changé") && !error.contains("Le compte connecté a changé") && !error.contains("lecture seule"));
        assert_eq!(snapshot(&store), before, "business failure must leave no wage, line, trace, audit, journal or sync-clock write");
    }
}

#[test]
fn actual_payslip_handler_keeps_real_signed_read_only_licence_for_current_and_legacy_contexts() {
    let (_directory, store) = fixture();
    identity(&store, &uuid::Uuid::new_v4().to_string(), "read_only");
    let employee_id = uuid::Uuid::new_v4().to_string();
    employee(&store, &employee_id, "Synthetic read-only employee");
    // Reuse the existing isolated test authority and real verifier, never an
    // unsigned flag, production licence or bypass of require_write.
    store.install_server_issued_license(&signed_fixture_token(&store, "read_only")).unwrap();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let before = snapshot(&store);
    for legacy in [false, true] {
        let error = responsive(&store, save_payslip_with_contributions(app.state(), input(None, employee_id.clone(), 500_000), if legacy { None } else { Some(scope(&store)) }, if legacy { None } else { Some(nonce(&store)) })).unwrap_err();
        assert!(error.contains("limité à la lecture"));
    }
    assert_eq!(snapshot(&store), before);
}

#[test]
fn actual_payslip_handler_checks_stale_origin_before_missing_licence_and_business_inputs() {
    let (_directory, store) = unlicensed_fixture();
    identity(&store, &uuid::Uuid::new_v4().to_string(), "owner");
    let old_nonce = nonce(&store);
    identity(&store, &uuid::Uuid::new_v4().to_string(), "owner");
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let mut bad = input(None, String::new(), -1);
    bad.period = "invalid-period".into();
    let before = snapshot(&store);
    let error = responsive(&store, save_payslip_with_contributions(app.state(), bad, Some(scope(&store)), Some(old_nonce))).unwrap_err();
    assert!(error.contains("Le compte connecté a changé"));
    for legacy in [false, true] {
        let error = responsive(&store, save_payslip_with_contributions(app.state(), input(None, "missing-employee".into(), 500_000), if legacy { None } else { Some(scope(&store)) }, if legacy { None } else { Some(nonce(&store)) })).unwrap_err();
        assert!(error.contains("lecture seule"));
    }
    assert_eq!(snapshot(&store), before);
}
