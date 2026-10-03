//! Synthetic native IPC recovery contracts. Sources are inventoried for native
//! CI; browser fixtures and a static review do not prove these tests executed.
use super::import_worker_tests::{fixture, scope, signed_fixture_token, unlicensed_fixture};
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::future::join;
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use std::{collections::BTreeMap, sync::{mpsc, Arc, Barrier}, thread, time::Duration};
use tauri::Manager;

fn seed(store: &LocalStore) -> RecordPaymentInput {
    crate::tests::enable_accounting(store);
    let client = store.create_record("clients", json!({
        "name":"Client synthétique de reprise", "address_line1":"Rue du Test",
        "address_line2":"1", "postal_code":"1000", "city":"Lausanne", "country":"CH",
    })).unwrap()["id"].as_str().unwrap().to_owned();
    let invoice = store.create_record("invoices", json!({
        "client_id":client, "title":"Reprise synthétique", "service_date_from":"2026-02-01",
    })).unwrap()["id"].as_str().unwrap().to_owned();
    store.create_record("invoice_items", json!({
        "invoice_id":invoice, "description":"Prestation synthétique", "quantity":1,
        "unit":"forfait", "unit_price_cents":10000, "vat_bp":0,
    })).unwrap();
    store.issue_invoice(&invoice, Some("2026-02-01".into()), None).unwrap();
    RecordPaymentInput {
        request_id: uuid::Uuid::new_v4().to_string(), invoice_id: invoice, amount_cents:1025,
        date:Some("2026-02-02".into()), method:Some("Virement".into()),
        reference:Some("SYNTHETIC-RECEIPT".into()), notes:None,
    }
}

fn probe(store: &LocalStore, inputs: Vec<RecordPaymentInput>, origin: String) -> Result<Value, String> {
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    tauri::async_runtime::block_on(read_payment_request(app.state(), inputs, origin))
}

fn snapshot(store: &LocalStore) -> Value {
    let connection = Connection::open_with_flags(&store.database_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut state = serde_json::Map::new();
    for table in ["invoices", "payments", "journal_entries", "journal_lines", "audit_log",
        "accounting_settings", "company_local_clock", "company_local_notes_scope", "license_state"] {
        state.insert(table.into(), json!(crate::database::query_all(
            &connection, &format!("SELECT * FROM {table} ORDER BY rowid"), [],
        ).unwrap()));
    }
    json!(state)
}

fn protected_files(store: &LocalStore) -> BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(&store.data_dir).unwrap().filter_map(|entry| {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        (entry.path().is_file() && name.starts_with("license-"))
            .then(|| (name, std::fs::read(entry.path()).unwrap()))
    }).collect()
}

fn alias(store: &LocalStore, original: &str, canonical: &str) {
    let mut connection = store.connect().unwrap();
    let transaction = connection.transaction().unwrap();
    crate::audit::append_audit(&transaction, "company.merge_branch", "company", "shared", &json!({
        "format":1, "confirmed_duplicate_receipt":{"localId":original,"remoteId":canonical},
        "original_entries":[],
    })).unwrap();
    transaction.commit().unwrap();
}

fn assert_one_payment(store: &LocalStore, invoice: &str, payment: &str, amount: i64) {
    let connection = store.connect().unwrap();
    let (count, paid): (i64, i64) = connection.query_row(
        "SELECT COUNT(*),COALESCE(SUM(amount_cents),0) FROM payments WHERE invoice_id=?",
        [invoice], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!((count, paid), (1, amount));
    assert_eq!(connection.query_row(
        "SELECT COUNT(*) FROM journal_entries WHERE source_type='payment' AND source_id=?",
        [payment], |row| row.get::<_, i64>(0),
    ).unwrap(), 1);
    assert_eq!(connection.query_row(
        "SELECT COUNT(*) FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.source_type='payment' AND j.source_id=?",
        [payment], |row| row.get::<_, i64>(0),
    ).unwrap(), 2);
}

#[test]
fn absent_probe_preserves_financial_rows_license_and_original_request_identity() {
    let (_temporary, store) = fixture();
    let input = seed(&store);
    let origin = scope(&store);
    let before = snapshot(&store);
    let files = protected_files(&store);
    assert_eq!(probe(&store, vec![input.clone()], origin.clone()).unwrap(), json!({
        "status":"absent", "originalRequestId":input.request_id, "workspaceScope":origin,
    }));
    assert_eq!(snapshot(&store), before);
    assert_eq!(protected_files(&store), files);
}

#[test]
fn exact_recorded_probe_uses_historical_oracle_without_requiring_current_review() {
    let (_temporary, store) = fixture();
    let input = seed(&store);
    let saved = store.record_payment(input.clone()).unwrap();
    // Current setup can change after a committed receipt. Its historical proof
    // must remain tied to the posted accounts rather than the current review.
    store.connect().unwrap().execute(
        "UPDATE accounting_settings SET enabled=0,bank_account_id=NULL WHERE id=1", [],
    ).unwrap();
    let before = snapshot(&store);
    let result = probe(&store, vec![input.clone()], scope(&store)).unwrap();
    assert_eq!(result, json!({
        "status":"recorded", "originalRequestId":input.request_id,
        "canonicalPaymentId":input.request_id, "wasAliased":false,
        "workspaceScope":scope(&store), "variantIndex":0, "journalEntryId":saved["journal_entry_id"],
    }));
    assert_eq!(snapshot(&store), before);
}

#[test]
fn native_normalization_matches_real_write_for_blank_unicode_truncation_and_uuid() {
    let (_temporary, store) = fixture();
    let mut input = seed(&store);
    input.date = Some(" 2026-2-2 ".into());
    input.method = Some(format!("\u{2003}{} suffix \u{2003}", "é🧾".repeat(50)));
    input.reference = Some(" \u{2003}\t ".into());
    input.notes = Some(format!("\u{2003}{} extra \u{2003}", "à🧾".repeat(2600)));
    let canonical_id = input.request_id.clone();
    input.request_id = format!(" {} ", input.request_id.to_uppercase());
    let saved = store.record_payment(input.clone()).unwrap();
    assert_eq!(saved["id"], canonical_id);
    assert_eq!(saved["date"], "2026-02-02");
    assert_eq!(saved["reference"], Value::Null);
    assert_eq!(saved["method"].as_str().unwrap().chars().count(), 80);
    assert_eq!(saved["notes"].as_str().unwrap().chars().count(), 5000);
    let result = probe(&store, vec![input], scope(&store)).unwrap();
    assert_eq!(result["status"], "recorded");
    assert_eq!(result["originalRequestId"], canonical_id);
}

#[test]
fn equivalent_native_payloads_return_the_first_original_variant_index() {
    let (_temporary, store) = fixture();
    let input = seed(&store);
    store.record_payment(input.clone()).unwrap();
    let mut wrong = input.clone();
    wrong.amount_cents += 1;
    let mut equivalent = input.clone();
    equivalent.method = Some(" Virement ".into());
    equivalent.notes = Some("\u{2003}\t".into());
    let result = probe(&store, vec![wrong, equivalent, input.clone(), input], scope(&store)).unwrap();
    assert_eq!(result["status"], "recorded");
    assert_eq!(result["variantIndex"], 1);
}

#[test]
fn corrected_payload_and_late_original_cannot_create_two_payments_in_either_order() {
    for corrected_first in [false, true] {
        let (_temporary, store) = fixture();
        let original = seed(&store);
        let mut corrected = original.clone();
        corrected.amount_cents = 2075;
        corrected.date = Some("2026-02-03".into());
        corrected.reference = Some("SYNTHETIC-CORRECTION".into());
        let variants = vec![original.clone(), corrected.clone()];
        let origin = scope(&store);
        assert_eq!(probe(&store, variants.clone(), origin.clone()).unwrap()["status"], "absent");
        let app = tauri::test::mock_builder().manage(store.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let (first, late, expected_index) = if corrected_first {
            (corrected, original, 1)
        } else {
            (original, corrected, 0)
        };
        let saved = record_payment(app.state(), first.clone(), None, Some(origin.clone())).unwrap();
        let before = snapshot(&store);
        let error = record_payment(app.state(), late, None, Some(origin.clone())).unwrap_err();
        assert!(error.contains("autre paiement"), "{error}");
        // Write permission may advance licence metadata; financial rows never
        // change after the mismatched replay, including the linked journal.
        let after = snapshot(&store);
        for table in ["invoices", "payments", "journal_entries", "journal_lines"] {
            assert_eq!(after[table], before[table]);
        }
        let proof = probe(&store, variants, origin).unwrap();
        assert_eq!(proof["status"], "recorded");
        assert_eq!(proof["variantIndex"], expected_index);
        assert_eq!(proof["journalEntryId"], saved["journal_entry_id"]);
        assert_one_payment(&store, &first.invoice_id, &first.request_id, first.amount_cents);
    }
}

#[test]
fn immediate_transactions_also_serialize_competing_variants_without_the_ui_lock() {
    let (_temporary, store) = fixture();
    let original = seed(&store);
    let mut corrected = original.clone();
    corrected.amount_cents = 2075;
    let barrier = Arc::new(Barrier::new(3));
    let writers: Vec<_> = [original.clone(), corrected.clone()].into_iter().map(|input| {
        let clone = store.clone();
        let barrier = barrier.clone();
        thread::spawn(move || { barrier.wait(); clone.record_payment(input) })
    }).collect();
    barrier.wait();
    let results: Vec<_> = writers.into_iter().map(|writer| writer.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
    let proof = probe(&store, vec![original.clone(), corrected.clone()], scope(&store)).unwrap();
    assert_eq!(proof["status"], "recorded");
    let expected = if proof["variantIndex"] == 0 { original } else { corrected };
    assert_one_payment(&store, &expected.invoice_id, &expected.request_id, expected.amount_cents);
}

#[test]
fn review_only_correction_keeps_uuid_and_does_not_change_payment_identity() {
    let (_temporary, store) = fixture();
    let input = seed(&store);
    let bank: String = store.connect().unwrap().query_row(
        "SELECT bank_account_id FROM accounting_settings WHERE id=1", [], |row| row.get(0),
    ).unwrap();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let wrong = crate::models::PaymentReview { balance_cents:9999, bank_account_id:bank.clone() };
    assert!(record_payment(app.state(), input.clone(), Some(wrong), Some(scope(&store)))
        .unwrap_err().contains("changé depuis"));
    assert_eq!(probe(&store, vec![input.clone()], scope(&store)).unwrap()["status"], "absent");
    let current = crate::models::PaymentReview { balance_cents:10000, bank_account_id:bank };
    record_payment(app.state(), input.clone(), Some(current), Some(scope(&store))).unwrap();
    // Frontend keeps two full variants with differing reviews; native input
    // excludes review and intentionally sees two identical payment payloads.
    let proof = probe(&store, vec![input.clone(), input.clone()], scope(&store)).unwrap();
    assert_eq!(proof["status"], "recorded");
    assert_eq!(proof["variantIndex"], 0);
    assert_one_payment(&store, &input.invoice_id, &input.request_id, input.amount_cents);
}

#[test]
fn canonical_alias_proof_reuses_the_real_canonical_payment_and_never_replays_another_payload() {
    let (_temporary, store) = fixture();
    let original = seed(&store);
    let mut canonical = original.clone();
    canonical.request_id = uuid::Uuid::new_v4().to_string();
    let saved = store.record_payment(canonical.clone()).unwrap();
    alias(&store, &original.request_id, &canonical.request_id);
    let before = snapshot(&store);
    let proof = probe(&store, vec![original.clone()], scope(&store)).unwrap();
    assert_eq!(proof, json!({
        "status":"recorded", "originalRequestId":original.request_id,
        "canonicalPaymentId":canonical.request_id, "wasAliased":true,
        "workspaceScope":scope(&store), "variantIndex":0, "journalEntryId":saved["journal_entry_id"],
    }));
    assert_eq!(snapshot(&store), before);
    let mut corrected = original.clone();
    corrected.amount_cents += 1;
    assert_eq!(probe(&store, vec![corrected.clone()], scope(&store)).unwrap()["status"], "conflict");
    assert!(store.record_payment(corrected).unwrap_err().to_string().contains("autre paiement"));
    assert_one_payment(&store, &canonical.invoice_id, &canonical.request_id, canonical.amount_cents);
}

#[test]
fn aliases_missing_canonical_cycles_and_multiple_targets_never_report_absent() {
    for kind in ["missing", "cycle", "multiple", "deep", "invalid"] {
        let (_temporary, store) = fixture();
        let original = seed(&store);
        let canonical = uuid::Uuid::new_v4().to_string();
        alias(&store, &original.request_id, &canonical);
        match kind {
            "cycle" => alias(&store, &canonical, &original.request_id),
            "multiple" => alias(&store, &original.request_id, &uuid::Uuid::new_v4().to_string()),
            "deep" => {
                let mut current = canonical.clone();
                for _ in 0..33 {
                    let next = uuid::Uuid::new_v4().to_string();
                    alias(&store, &current, &next);
                    current = next;
                }
            }
            "invalid" => alias(&store, &canonical, "invalid-canonical-id"),
            _ => {}
        }
        let before = snapshot(&store);
        assert_eq!(probe(&store, vec![original], scope(&store)).unwrap()["status"], "conflict", "{kind}");
        assert_eq!(snapshot(&store), before);
    }
}

#[test]
fn alias_with_both_original_and_canonical_business_rows_is_a_conflict() {
    let (_temporary, store) = fixture();
    let original = seed(&store);
    store.record_payment(original.clone()).unwrap();
    let mut canonical = original.clone();
    canonical.request_id = uuid::Uuid::new_v4().to_string();
    store.record_payment(canonical.clone()).unwrap();
    alias(&store, &original.request_id, &canonical.request_id);
    let before = snapshot(&store);
    assert_eq!(probe(&store, vec![original], scope(&store)).unwrap()["status"], "conflict");
    assert_eq!(snapshot(&store), before);
}

#[test]
fn transitive_alias_confirms_only_canonical_and_refuses_a_residual_intermediate_receipt() {
    for residual in [false, true] {
        let (_temporary, store) = fixture();
        let original = seed(&store);
        let mut intermediate = original.clone();
        intermediate.request_id = uuid::Uuid::new_v4().to_string();
        let mut canonical = original.clone();
        canonical.request_id = uuid::Uuid::new_v4().to_string();
        if residual { store.record_payment(intermediate.clone()).unwrap(); }
        store.record_payment(canonical.clone()).unwrap();
        alias(&store, &original.request_id, &intermediate.request_id);
        alias(&store, &intermediate.request_id, &canonical.request_id);
        let before = snapshot(&store);
        let proof = probe(&store, vec![original], scope(&store)).unwrap();
        assert_eq!(proof["status"], if residual { "conflict" } else { "recorded" });
        if !residual { assert_eq!(proof["canonicalPaymentId"], canonical.request_id); }
        assert_eq!(snapshot(&store), before);
    }
}

#[test]
fn corrupt_linked_journal_is_conflict_without_repair_or_a_new_payment() {
    let (_temporary, store) = fixture();
    let input = seed(&store);
    let saved = store.record_payment(input.clone()).unwrap();
    let connection = store.connect().unwrap();
    connection.execute_batch("DROP TRIGGER journal_lines_no_update").unwrap();
    connection.execute(
        "UPDATE journal_lines SET memo='Synthetic corrupt proof' WHERE journal_entry_id=? AND memo='Encaissement'",
        [saved["journal_entry_id"].as_str().unwrap()],
    ).unwrap();
    let before = snapshot(&store);
    assert_eq!(probe(&store, vec![input], scope(&store)).unwrap()["status"], "conflict");
    assert_eq!(snapshot(&store), before);
}

#[test]
fn corrupt_alias_audit_cannot_be_hidden_as_a_simple_absence() {
    let (_temporary, store) = fixture();
    let original = seed(&store);
    alias(&store, &original.request_id, &uuid::Uuid::new_v4().to_string());
    let connection = store.connect().unwrap();
    connection.execute_batch("DROP TRIGGER audit_log_no_update").unwrap();
    connection.execute("UPDATE audit_log SET payload_json='not-json' WHERE action='company.merge_branch'", []).unwrap();
    let before = snapshot(&store);
    assert_eq!(probe(&store, vec![original], scope(&store)).unwrap()["status"], "conflict");
    assert_eq!(snapshot(&store), before);
}

#[test]
fn probe_batch_bounds_and_shared_uuid_invoice_contract_are_checked_without_writes() {
    let (_temporary, store) = fixture();
    let input = seed(&store);
    let mut different_request = input.clone();
    different_request.request_id = uuid::Uuid::new_v4().to_string();
    let mut different_invoice = input.clone();
    different_invoice.invoice_id = uuid::Uuid::new_v4().to_string();
    for inputs in [vec![], vec![input.clone(); 13], vec![input.clone(), different_request],
        vec![input.clone(), different_invoice]] {
        let before = snapshot(&store);
        assert!(probe(&store, inputs, scope(&store)).is_err());
        assert_eq!(snapshot(&store), before);
    }
    assert_eq!(probe(&store, vec![input; 12], scope(&store)).unwrap()["status"], "absent");
}

#[test]
fn wrong_scope_precedes_payload_validation_and_write_licence_guard() {
    let (_temporary, store) = unlicensed_fixture();
    let mut input = seed(&store);
    input.request_id = "invalid".into();
    let before = snapshot(&store);
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    assert!(tauri::async_runtime::block_on(read_payment_request(
        app.state(), vec![input.clone()], "retired-workspace".into(),
    )).unwrap_err().contains("L’entreprise ouverte a changé"));
    assert!(record_payment(app.state(), input, None, Some("retired-workspace".into()))
        .unwrap_err().contains("L’entreprise ouverte a changé"));
    assert_eq!(snapshot(&store), before);
}

#[test]
fn real_restore_and_a_preexisting_clone_preserve_uuid_but_refuse_the_previous_scope() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let (_temporary, store) = fixture();
    let input = seed(&store);
    store.record_payment(input.clone()).unwrap();
    let origin = scope(&store);
    let clone = store.clone();
    let backup = store.create_backup(None, "synthetic-payment-recovery").unwrap();
    store.restore_backup(&backup, "synthetic-payment-recovery").unwrap();
    let current = scope(&store);
    assert_ne!(current, origin);
    let before = snapshot(&store);
    let error = probe(&clone, vec![input.clone()], origin.clone()).unwrap_err();
    assert!(error.contains("L’entreprise ouverte a changé"));
    let app = tauri::test::mock_builder().manage(clone.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    assert!(record_payment(app.state(), input.clone(), None, Some(origin)).unwrap_err()
        .contains("L’entreprise ouverte a changé"));
    assert_eq!(snapshot(&store), before);
    assert_eq!(probe(&clone, vec![input], current).unwrap()["status"], "recorded");
}

#[test]
fn probe_waits_off_executor_and_checks_origin_after_the_cloned_store_lock() {
    let (_temporary, store) = fixture();
    let input = seed(&store);
    let origin = scope(&store);
    let clone = store.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = clone.lock().unwrap();
        ready_tx.send(()).unwrap();
        if release_rx.recv_timeout(Duration::from_secs(5)).is_err() { return false; }
        clone.connect().unwrap().execute("UPDATE company_local_notes_scope SET scope=? WHERE id=1",
            [uuid::Uuid::new_v4().to_string()]).unwrap();
        true
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let (result, ()) = tauri::async_runtime::block_on(join(
        read_payment_request(app.state(), vec![input], origin),
        async move { release_tx.send(()).unwrap(); },
    ));
    assert!(holder.join().unwrap(), "probe blocked the waiting executor");
    assert!(result.unwrap_err().contains("L’entreprise ouverte a changé"));
}

fn expired_token(store: &LocalStore) -> String {
    let token = signed_fixture_token(store, "owner");
    let encoded = token.split('.').next().unwrap();
    let mut payload: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
    let today = chrono::Local::now().date_naive();
    payload["valid_from"] = json!((today - chrono::Duration::days(3)).format("%Y-%m-%d").to_string());
    payload["valid_until"] = json!((today - chrono::Duration::days(1)).format("%Y-%m-%d").to_string());
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
    format!("{encoded}.{}", URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&[31;32]).sign(encoded.as_bytes()).to_bytes()))
}

#[test]
fn missing_expired_read_only_and_wrong_license_never_block_a_read_only_proof() {
    for access in ["missing", "expired", "read_only", "wrong"] {
        let (_temporary, store) = unlicensed_fixture();
        let input = seed(&store);
        store.record_payment(input.clone()).unwrap();
        match access {
            "expired" => {
                let license = store.install_server_issued_license(&expired_token(&store)).unwrap();
                assert_eq!(license["status"], "expired");
            }
            "read_only" => { store.install_server_issued_license(&signed_fixture_token(&store, access)).unwrap(); }
            "wrong" => {
                let (_foreign_temporary, foreign) = fixture();
                assert!(store.install_server_issued_license(&signed_fixture_token(&foreign, "owner"))
                    .unwrap_err().to_string().contains("installation"));
            }
            _ => {}
        }
        assert!(store.require_write_access().is_err(), "{access}");
        let before = snapshot(&store);
        let files = protected_files(&store);
        assert_eq!(probe(&store, vec![input], scope(&store)).unwrap()["status"], "recorded", "{access}");
        assert_eq!(snapshot(&store), before, "{access}");
        assert_eq!(protected_files(&store), files, "{access}");
    }
}

#[test]
fn optional_write_scope_preserves_legacy_replay_and_write_permission_contracts() {
    let (_temporary, store) = fixture();
    let input = seed(&store);
    let app = tauri::test::mock_builder().manage(store.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let saved = record_payment(app.state(), input.clone(), None, None).unwrap();
    assert_eq!(record_payment(app.state(), input.clone(), None, Some(scope(&store))).unwrap()["id"], saved["id"]);
    store.install_server_issued_license(&signed_fixture_token(&store, "read_only")).unwrap();
    for origin in [None, Some(scope(&store))] {
        assert!(record_payment(app.state(), input.clone(), None, origin).unwrap_err().contains("lecture"));
    }
    assert_one_payment(&store, &input.invoice_id, &input.request_id, input.amount_cents);
}

#[test]
fn sqlite_failures_missing_database_and_missing_scope_are_errors_never_absence() {
    let (_temporary, store) = fixture();
    let input = seed(&store);
    let origin = scope(&store);
    let mut missing = store.clone();
    missing.database_path = store.data_dir.join("does-not-exist.sqlite3");
    assert!(probe(&missing, vec![input.clone()], origin.clone()).is_err());
    assert!(!missing.database_path.exists(), "read-only open created a database");
    let connection = store.connect().unwrap();
    connection.execute("DELETE FROM company_local_notes_scope", []).unwrap();
    assert!(probe(&store, vec![input.clone()], origin).is_err());
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM company_local_notes_scope", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
    crate::work_notes::ensure_workspace_scope(&connection).unwrap();
    let current = scope(&store);
    connection.execute_batch("DROP TABLE payments").unwrap();
    assert!(probe(&store, vec![input], current).is_err());
}
