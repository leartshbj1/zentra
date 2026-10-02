//! Synthetic payment projection parity and opt-in, optimized profiling.
//! All fixtures live in fresh temporary profiles and use the business commands.
use super::*;
use crate::{
    accounting::WorkspaceInvoicePaymentChecks,
    customer_credit_settlements::ReverseCustomerCreditSettlementInput, models::RecordPaymentInput,
};
use std::time::Instant;

#[path = "payment_read_projection_tests.rs"]
mod payment_read_projection_tests;

struct Fixture {
    _temporary: tempfile::TempDir,
    store: LocalStore,
    client: String,
}

fn fixture(received: bool) -> Fixture {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("synthetic-profile")).unwrap();
    let mut onboarding = crate::tests::test_onboarding();
    onboarding.vat_registered = true;
    onboarding.vat_number = Some("CHE-123.456.789 TVA".into());
    onboarding.default_vat_bp = Some(810);
    store.complete_onboarding(onboarding, "1.0.0").unwrap();
    crate::tests::enable_accounting(&store);
    if received {
        store
            .create_vat_profile(crate::vat_reporting::VatProfileInput {
                id: None,
                effective_from: "2026-01-01".into(),
                effective_to: None,
                reporting_method: "effective".into(),
                form_of_reporting: "received".into(),
                periodicity: "quarterly".into(),
                gross_or_net: "net".into(),
                tdfn_activity_id: None,
                tdfn_rate_bp: None,
                afc_authorization_confirmed: true,
                notes: None,
                close_previous_open_profile: false,
            })
            .unwrap();
    }
    let client = id(&store
        .create_record(
            "clients",
            json!({
                "name":"Client synthétique paiements", "address_line1":"Rue du Test",
                "address_line2":"7", "postal_code":"1000", "city":"Lausanne", "country":"CH"
            }),
        )
        .unwrap());
    Fixture {
        _temporary: temporary,
        store,
        client,
    }
}

fn id(value: &Value) -> String {
    value["id"].as_str().expect("record identifier").into()
}

fn document(fixture: &Fixture, net: i64, rate: i64, original: Option<&str>) -> String {
    let invoice = fixture
        .store
        .create_record(
            "invoices",
            json!({
                "client_id":fixture.client, "title":"Facture synthétique de contrôle",
                "type":if original.is_some() {"credit_note"} else {"standard"},
                "original_invoice_id":original,
                "service_date_from":"2026-02-01", "service_date_to":"2026-02-01"
            }),
        )
        .unwrap();
    let invoice = id(&invoice);
    fixture
        .store
        .create_record(
            "invoice_items",
            json!({
                "invoice_id":invoice, "description":"Prestation synthétique", "quantity":1,
                "unit":"forfait", "unit_price_cents":net, "vat_bp":rate
            }),
        )
        .unwrap();
    fixture
        .store
        .issue_invoice(
            &invoice,
            Some(if original.is_some() {
                "2026-03-01".into()
            } else {
                "2026-02-01".into()
            }),
            None,
        )
        .unwrap();
    invoice
}

fn pay(store: &LocalStore, invoice: &str, amount: i64, date: &str) -> String {
    let request_id = Uuid::new_v4().to_string();
    let saved = store
        .record_payment(RecordPaymentInput {
            request_id: request_id.clone(),
            invoice_id: invoice.into(),
            amount_cents: amount,
            date: Some(date.into()),
            method: Some("bank".into()),
            reference: Some("Fixture synthétique".into()),
            notes: None,
        })
        .unwrap();
    assert_eq!(id(&saved), request_id);
    request_id
}

fn payment<'a>(workspace: &'a Value, payment_id: &str) -> &'a Value {
    workspace["payments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["id"] == payment_id)
        .unwrap()
}

fn without_journals(mut workspace: Value) -> Value {
    let fields = workspace.as_object_mut().unwrap();
    assert!(fields.remove("journal_entries").is_some());
    assert!(fields.remove("journal_lines").is_some());
    workspace
}

/// Cache and former paths read the exact same database snapshot. Comparing all
/// retained fields also covers fields unrelated to the optimized invoice checks.
fn assert_parity(store: &LocalStore) -> Value {
    let mut connection = store.connect().unwrap();
    let snapshot = connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .unwrap();
    let complete = store
        .payment_workspace_for_test(&snapshot, false, true)
        .unwrap();
    let former = store
        .payment_workspace_for_test(&snapshot, false, false)
        .unwrap();
    assert_eq!(complete, former, "complete workspace changed");
    let interface = store
        .payment_workspace_for_test(&snapshot, true, true)
        .unwrap();
    let former_interface = store
        .payment_workspace_for_test(&snapshot, true, false)
        .unwrap();
    assert_eq!(interface, former_interface, "interface workspace changed");
    assert_eq!(interface, without_journals(complete.clone()));
    snapshot.commit().unwrap();
    complete
}

fn assert_healthy(workspace: &Value, expected_payments: usize) {
    let payments = workspace["payments"].as_array().unwrap();
    assert_eq!(payments.len(), expected_payments);
    for row in payments {
        assert_eq!(row["accounting_blocked"], false, "{row}");
        assert!(row["accounting_block_reason"].is_null(), "{row}");
        assert_eq!(row["journal_entry_semantically_valid"], true, "{row}");
        assert_eq!(row["journal_entry_is_active"], 1, "{row}");
        assert_eq!(row["journal_reversal_depth"], 0, "{row}");
        assert!(row["journal_entry_id"].as_str().is_some(), "{row}");
    }
}

#[test]
fn dense_and_sparse_real_payment_workspaces_preserve_complete_and_interface_values() {
    for (invoices, per_invoice) in [(1, 12), (4, 3), (12, 1)] {
        for received in [false, true] {
            let fixture = fixture(received);
            for _ in 0..invoices {
                let invoice = document(&fixture, per_invoice * 1_000, 810, None);
                for _ in 0..per_invoice {
                    pay(&fixture.store, &invoice, 1_081, "2026-02-15");
                }
            }
            let workspace = assert_parity(&fixture.store);
            assert_healthy(&workspace, (invoices * per_invoice) as usize);
            for invoice in workspace["invoices"].as_array().unwrap() {
                assert_eq!(invoice["status"], "payee");
                assert_eq!(invoice["paid_cents"], invoice["total_cents"]);
                assert_eq!(invoice["paid_cents"], per_invoice * 1_081);
            }
        }
    }
}

#[test]
fn invalid_middle_payment_dates_amounts_and_cumulative_totals_block_the_entire_invoice() {
    for (case, expected) in [
        ("negative", "nul ou négatif"),
        ("date", "date non canonique"),
        ("before_issue", "précède"),
        ("stored_total", "total encaissé mémorisé"),
        ("overpayment", "dépasse le solde ouvert"),
        ("overflow", "capacité monétaire locale"),
    ] {
        let fixture = fixture(false);
        let invoice = document(&fixture, 10_000, 0, None);
        let ids = [
            pay(&fixture.store, &invoice, 1_000, "2026-02-15"),
            pay(&fixture.store, &invoice, 1_000, "2026-02-16"),
            pay(&fixture.store, &invoice, 1_000, "2026-02-17"),
        ];
        assert_healthy(&assert_parity(&fixture.store), 3);
        let connection = fixture.store.connect().unwrap();
        // Deliberately reproduce corrupt historical data, only in this fresh
        // disposable profile. Production writes retain their immutable guards.
        connection
            .execute_batch("DROP TRIGGER payments_no_update; PRAGMA ignore_check_constraints=ON;")
            .unwrap();
        match case {
            "negative" => {
                connection
                    .execute("UPDATE payments SET amount_cents=-1 WHERE id=?", [&ids[1]])
                    .unwrap();
            }
            "date" => {
                connection
                    .execute(
                        "UPDATE payments SET date='2026-02-30' WHERE id=?",
                        [&ids[1]],
                    )
                    .unwrap();
            }
            "before_issue" => {
                connection
                    .execute(
                        "UPDATE payments SET date='2026-01-31' WHERE id=?",
                        [&ids[1]],
                    )
                    .unwrap();
            }
            "stored_total" => {
                connection
                    .execute("UPDATE invoices SET paid_cents=3001 WHERE id=?", [&invoice])
                    .unwrap();
            }
            "overpayment" => {
                connection
                    .execute(
                        "UPDATE payments SET amount_cents=10000 WHERE id=?",
                        [&ids[1]],
                    )
                    .unwrap();
                connection
                    .execute(
                        "UPDATE invoices SET paid_cents=12000 WHERE id=?",
                        [&invoice],
                    )
                    .unwrap();
            }
            "overflow" => {
                connection
                    .execute(
                        "UPDATE payments SET amount_cents=?1 WHERE id=?2",
                        params![i64::MAX, ids[1]],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        drop(connection);
        let workspace = assert_parity(&fixture.store);
        for payment_id in &ids {
            let row = payment(&workspace, payment_id);
            assert_eq!(row["accounting_blocked"], true, "case {case}: {row}");
            assert!(
                row["accounting_block_reason"]
                    .as_str()
                    .unwrap()
                    .contains(expected),
                "case {case}: {row}"
            );
        }
    }
}

#[test]
fn credit_application_and_its_real_reversal_preserve_payment_proofs() {
    let fixture = fixture(true);
    let invoice = document(&fixture, 10_000, 810, None);
    let first = pay(&fixture.store, &invoice, 3_000, "2026-02-15");
    let credit = document(&fixture, 2_000, 810, Some(&invoice));
    let connection = fixture.store.connect().unwrap();
    let application: String = connection.query_row(
        "SELECT id FROM customer_credit_settlements WHERE credit_note_id=? AND event_type='apply'",
        [&credit], |row| row.get(0),
    ).unwrap();
    drop(connection);
    let applied = assert_parity(&fixture.store);
    assert_healthy(&applied, 1);
    assert_eq!(payment(&applied, &first)["amount_cents"], 3_000);
    assert_eq!(
        crate::customer_credit_math::project(
            &fixture.store.connect().unwrap(),
            &invoice,
            "9999-12-31"
        )
        .unwrap()
        .remaining()
        .unwrap(),
        5_648
    );
    fixture
        .store
        .reverse_customer_credit_settlement(ReverseCustomerCreditSettlementInput {
            request_id: Uuid::new_v4().to_string(),
            settlement_id: application,
            date: "2026-03-02".into(),
            reason: "Annulation synthétique de l’imputation".into(),
        })
        .unwrap();
    pay(&fixture.store, &invoice, 2_000, "2026-03-03");
    let reversed = assert_parity(&fixture.store);
    assert_healthy(&reversed, 2);
    assert_eq!(
        crate::customer_credit_math::project(
            &fixture.store.connect().unwrap(),
            &invoice,
            "9999-12-31"
        )
        .unwrap()
        .remaining()
        .unwrap(),
        5_810
    );
    let kinds = reversed["customer_credit_settlements"].as_array().unwrap();
    assert!(kinds.iter().any(|row| row["event_type"] == "reverse_apply"));
}

#[test]
fn one_corrupt_payment_journal_never_reuses_the_other_payments_individual_proof() {
    let fixture = fixture(false);
    let invoice = document(&fixture, 10_000, 0, None);
    let ids = [
        pay(&fixture.store, &invoice, 1_000, "2026-02-15"),
        pay(&fixture.store, &invoice, 1_000, "2026-02-16"),
        pay(&fixture.store, &invoice, 1_000, "2026-02-17"),
    ];
    let healthy = assert_parity(&fixture.store);
    assert_healthy(&healthy, 3);
    let journal = payment(&healthy, &ids[1])["journal_entry_id"]
        .as_str()
        .unwrap();
    let connection = fixture.store.connect().unwrap();
    connection
        .execute_batch("DROP TRIGGER journal_lines_no_update;")
        .unwrap();
    assert_eq!(connection.execute(
        "UPDATE journal_lines SET memo='Journal synthétique corrompu' WHERE journal_entry_id=? AND memo='Encaissement'",
        [journal],
    ).unwrap(), 1);
    drop(connection);
    let broken = assert_parity(&fixture.store);
    for (index, payment_id) in ids.iter().enumerate() {
        let row = payment(&broken, payment_id);
        assert_eq!(row["journal_entry_semantically_valid"], index != 1, "{row}");
        assert_eq!(row["accounting_blocked"], false, "{row}");
        assert_eq!(
            row["journal_entry_id"],
            payment(&healthy, payment_id)["journal_entry_id"]
        );
    }
}

#[test]
fn received_vat_corruption_is_observed_by_a_new_workspace_read_after_a_success() {
    let fixture = fixture(true);
    let invoice = document(&fixture, 10_000, 810, None);
    let first = pay(&fixture.store, &invoice, 5_405, "2026-02-15");
    let second = pay(&fixture.store, &invoice, 5_405, "2026-04-15");
    assert_healthy(&fixture.store.get_workspace().unwrap(), 2);
    assert_healthy(&assert_parity(&fixture.store), 2);
    let connection = fixture.store.connect().unwrap();
    let due: i64 = connection.query_row(
        "SELECT COALESCE(SUM(line.credit_cents-line.debit_cents),0) FROM journal_lines line JOIN accounting_settings settings ON settings.vat_payable_account_id=line.account_id",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(due, 810);
    connection
        .execute_batch("DROP TRIGGER journal_lines_no_update;")
        .unwrap();
    assert_eq!(connection.execute(
        "UPDATE journal_lines SET debit_cents=debit_cents-1 WHERE journal_entry_id=(SELECT id FROM journal_entries WHERE source_type='vat_cash_reclassification' AND source_id=?) AND memo='Reclassement TVA à régulariser'",
        [&first],
    ).unwrap(), 1);
    drop(connection);
    // Public entry point gets a fresh cache, not the previous successful result.
    let interface = fixture.store.get_interface_workspace().unwrap();
    let broken = assert_parity(&fixture.store);
    assert_eq!(interface, without_journals(broken.clone()));
    for payment_id in [&first, &second] {
        assert_eq!(
            payment(&broken, payment_id)["journal_entry_semantically_valid"],
            false
        );
        assert_eq!(payment(&broken, payment_id)["accounting_blocked"], false);
    }
}

#[test]
fn cached_invoice_success_still_checks_each_payment_exists() {
    let fixture = fixture(false);
    let invoice = document(&fixture, 10_000, 0, None);
    let payment_id = pay(&fixture.store, &invoice, 1_000, "2026-02-15");
    let connection = fixture.store.connect().unwrap();
    let mut checks = WorkspaceInvoicePaymentChecks::new(&connection);
    assert!(checks.payment_block_reason(&payment_id).unwrap().is_none());
    connection
        .execute_batch("DROP TRIGGER payments_no_delete;")
        .unwrap();
    connection
        .execute("DELETE FROM payments WHERE id=?", [&payment_id])
        .unwrap();
    assert!(matches!(
        checks.payment_block_reason(&payment_id),
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        checks.payment_block_reason(&Uuid::new_v4().to_string()),
        Err(AppError::NotFound(_))
    ));
}

fn read_while_payment_commits(
    fixture: &Fixture,
    invoice: &str,
    interface: bool,
    protected_snapshot: bool,
) -> Value {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    };
    use std::time::Duration;
    let writer_store = fixture.store.clone();
    let writer_invoice = invoice.to_owned();
    let (start_sender, start_receiver) = mpsc::channel();
    let (done_sender, done_receiver) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        start_receiver
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        let result = writer_store
            .record_payment(RecordPaymentInput {
                request_id: Uuid::new_v4().to_string(),
                invoice_id: writer_invoice,
                amount_cents: 1_081,
                date: Some("2026-02-16".into()),
                method: Some("bank".into()),
                reference: None,
                notes: None,
            })
            .map_err(|error| error.to_string());
        done_sender.send(result).unwrap();
    });
    let mut connection = fixture.store.connect().unwrap();
    let after_onboarding = Arc::new(AtomicBool::new(false));
    let phase = Arc::clone(&after_onboarding);
    // The initial onboarding query reads only onboarding_completed. Preparing
    // the following settings.* query proves that first read has returned. This
    // avoids depending on a magic VM-instruction count or global test hooks.
    connection.authorizer(Some(move |context: AuthContext<'_>| {
        if matches!(
            context.action,
            AuthAction::Read {
                table_name: "settings",
                column_name: "company_name",
            }
        ) {
            phase.store(true, Ordering::Release);
        }
        Authorization::Allow
    }));
    let observed = Arc::new(Mutex::new(None));
    let observed_in_callback = Arc::clone(&observed);
    let mut signalled = false;
    connection.progress_handler(
        1,
        Some(move || {
            if !signalled && after_onboarding.load(Ordering::Acquire) {
                signalled = true;
                let completed = if start_sender.send(()).is_ok() {
                    done_receiver
                        .recv_timeout(Duration::from_secs(10))
                        .map_err(|error| error.to_string())
                        .and_then(|result| result)
                } else {
                    Err("synthetic writer did not start".into())
                };
                *observed_in_callback.lock().unwrap() = Some(completed);
            }
            false
        }),
    );
    let during = if protected_snapshot {
        // This is the exact standalone helper used by both public getters.
        // The test does NOT start a transaction on behalf of the application.
        fixture.store.workspace_snapshot_from_connection(
            &mut connection,
            if interface {
                WorkspaceReadScope::Interface
            } else {
                WorkspaceReadScope::Complete
            },
        )
    } else {
        // Sensitivity control: emulate the former read path without BEGIN,
        // under the identical writer timing and the exact same projection.
        fixture
            .store
            .payment_workspace_for_test(&connection, interface, true)
    }
    .unwrap();
    connection.progress_handler(0, None::<fn() -> bool>);
    connection.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    let write_result = observed
        .lock()
        .unwrap()
        .take()
        .expect("writer completed after onboarding during the read");
    assert!(write_result.is_ok(), "{write_result:?}");
    writer.join().unwrap();
    during
}

#[test]
fn standalone_workspace_snapshot_resists_a_commit_during_read_and_detects_missing_begin() {
    for interface in [false, true] {
        for protected in [true, false] {
            let fixture = fixture(true);
            let invoice = document(&fixture, 10_000, 810, None);
            let first = pay(&fixture.store, &invoice, 1_081, "2026-02-15");
            let before = if interface {
                fixture.store.get_interface_workspace().unwrap()
            } else {
                fixture.store.get_workspace().unwrap()
            };
            assert_healthy(&before, 1);
            let during = read_while_payment_commits(&fixture, &invoice, interface, protected);
            let after = if interface {
                fixture.store.get_interface_workspace().unwrap()
            } else {
                fixture.store.get_workspace().unwrap()
            };
            assert_healthy(&after, 2);
            assert_eq!(after["invoices"][0]["paid_cents"], 2_162);
            assert_ne!(before, after);
            if protected {
                assert_eq!(
                    during, before,
                    "standalone getter mixed snapshots after concurrent payment"
                );
                assert_healthy(&during, 1);
                assert_eq!(payment(&during, &first)["amount_cents"], 1_081);
                assert_eq!(during["invoices"][0]["paid_cents"], 1_081);
            } else {
                assert_ne!(
                    during, before,
                    "sensitivity control must expose the absence of BEGIN"
                );
                assert_eq!(during["payments"].as_array().unwrap().len(), 2);
            }
            let complete = assert_parity(&fixture.store);
            assert_eq!(
                after,
                if interface {
                    without_journals(complete)
                } else {
                    complete
                }
            );
        }
    }
}

#[test]
#[ignore = "Explicit optimized synthetic benchmark; preparation creates 3072 real payments"]
fn benchmark_real_payment_workspace_densities() {
    assert!(
        !cfg!(debug_assertions),
        "Run this informative benchmark with cargo test --release"
    );
    let mut densities = Vec::new();
    for (invoices, per_invoice) in [(1_i64, 1_024_i64), (32, 32), (1_024, 1)] {
        println!(
            "PAYMENT_WORKSPACE_PREPARING invoices={invoices} paymentsPerInvoice={per_invoice}"
        );
        let prepare = Instant::now();
        let fixture = fixture(true);
        for _ in 0..invoices {
            let invoice = document(&fixture, per_invoice * 1_000, 810, None);
            for _ in 0..per_invoice {
                pay(&fixture.store, &invoice, 1_081, "2026-02-15");
            }
        }
        let preparation_ms = prepare.elapsed().as_secs_f64() * 1_000.0;
        let mut connection = fixture.store.connect().unwrap();
        let snapshot = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .unwrap();
        for (interface, memoize) in [(false, false), (false, true), (true, false), (true, true)] {
            drop(
                fixture
                    .store
                    .payment_workspace_for_test(&snapshot, interface, memoize)
                    .unwrap(),
            );
        }
        let mut runs = Vec::new();
        for pass in 0..3 {
            let paths = if pass % 2 == 0 {
                [(false, false), (false, true), (true, false), (true, true)]
            } else {
                [(true, true), (true, false), (false, true), (false, false)]
            };
            let mut values = Vec::new();
            for (position, (interface, memoize)) in paths.into_iter().enumerate() {
                let start = Instant::now();
                let value = fixture
                    .store
                    .payment_workspace_for_test(&snapshot, interface, memoize)
                    .unwrap();
                let read_ms = start.elapsed().as_secs_f64() * 1_000.0;
                // Assertions and serialization are intentionally outside read timing.
                assert_healthy(&value, (invoices * per_invoice) as usize);
                assert_eq!(
                    value["invoices"].as_array().unwrap().len(),
                    invoices as usize
                );
                let bytes = serde_json::to_vec(&value).unwrap().len();
                runs.push(json!({"pass":pass + 1, "position":position + 1,
                    "scope":if interface {"interface"} else {"complete"},
                    "path":if memoize {"invoiceCache"} else {"formerPerPayment"},
                    "readMs":read_ms, "bytes":bytes}));
                values.push((interface, memoize, value));
            }
            let value = |interface, memoize| {
                &values
                    .iter()
                    .find(|entry| entry.0 == interface && entry.1 == memoize)
                    .unwrap()
                    .2
            };
            assert_eq!(value(false, true), value(false, false));
            assert_eq!(value(true, true), value(true, false));
            assert_eq!(
                value(true, true),
                &without_journals(value(false, true).clone())
            );
        }
        snapshot.commit().unwrap();
        let density = json!({"invoices":invoices, "paymentsPerInvoice":per_invoice,
            "payments":invoices * per_invoice, "receivedVat":true,
            "preparationMs":preparation_ms, "sameConnection":true,
            "stableSnapshot":true, "alternatingOrder":true,
            "allRetainedValuesEqual":true, "runs":runs});
        println!("PAYMENT_WORKSPACE_DENSITY {density}");
        densities.push(density);
    }
    let proof = json!({"synthetic":true, "optimized":true, "timingThreshold":null,
        "fixtureCommands":["create_record","issue_invoice","record_payment"],
        "preparationOutsideTiming":true, "densities":densities});
    if let Ok(destination) = std::env::var("ZENTRA_PAYMENT_BENCHMARK_JSON") {
        fs::write(destination, serde_json::to_vec_pretty(&proof).unwrap()).unwrap();
    }
    println!("PAYMENT_WORKSPACE_BENCHMARK {proof}");
}
