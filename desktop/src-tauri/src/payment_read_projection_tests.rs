//! Opt-in profiling through the public workspace getters, using the real
//! payment fixtures from the parent projection test module.
use super::*;

#[test]
#[ignore = "Explicit optimized public-getter benchmark; preparation creates 3072 real payments"]
fn benchmark_public_payment_workspace_densities() {
    assert!(
        !cfg!(debug_assertions),
        "Run this informative benchmark with cargo test --release"
    );
    let mut densities = Vec::new();
    for (invoices, per_invoice) in [(1_i64, 1_024_i64), (32, 32), (1_024, 1)] {
        println!(
            "PUBLIC_PAYMENT_WORKSPACE_PREPARING invoices={invoices} paymentsPerInvoice={per_invoice}"
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

        // References, parity assertions and warm-up are all outside timing.
        // These reference reads use one explicit snapshot; timed reads below
        // use the shipped getters' own connections and deferred snapshots.
        let (complete_reference, interface_reference) = {
            let mut connection = fixture.store.connect().unwrap();
            let snapshot = connection
                .transaction_with_behavior(TransactionBehavior::Deferred)
                .unwrap();
            let complete = fixture
                .store
                .payment_workspace_for_test(&snapshot, false, true)
                .unwrap();
            let interface = fixture
                .store
                .payment_workspace_for_test(&snapshot, true, true)
                .unwrap();
            snapshot.commit().unwrap();
            (complete, interface)
        };
        assert_eq!(
            interface_reference,
            without_journals(complete_reference.clone())
        );
        assert_healthy(&complete_reference, (invoices * per_invoice) as usize);
        assert_healthy(&interface_reference, (invoices * per_invoice) as usize);
        assert_eq!(fixture.store.get_workspace().unwrap(), complete_reference);
        assert_eq!(
            fixture.store.get_interface_workspace().unwrap(),
            interface_reference
        );

        let mut runs = Vec::new();
        for pass in 0..3 {
            let scopes = if pass % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            };
            for (position, interface) in scopes.into_iter().enumerate() {
                let start = Instant::now();
                let value = if interface {
                    fixture.store.get_interface_workspace().unwrap()
                } else {
                    fixture.store.get_workspace().unwrap()
                };
                let read_ms = start.elapsed().as_secs_f64() * 1_000.0;
                let reference = if interface {
                    &interface_reference
                } else {
                    &complete_reference
                };
                assert_eq!(&value, reference);
                assert_healthy(&value, (invoices * per_invoice) as usize);
                assert_eq!(
                    value["invoices"].as_array().unwrap().len(),
                    invoices as usize
                );
                let bytes = serde_json::to_vec(&value).unwrap().len();
                runs.push(json!({"pass":pass + 1, "position":position + 1,
                    "scope":if interface {"interface"} else {"complete"},
                    "getter":if interface {"get_interface_workspace"} else {"get_workspace"},
                    "readMs":read_ms, "bytes":bytes}));
            }
        }
        let density = json!({"invoices":invoices, "paymentsPerInvoice":per_invoice,
            "payments":invoices * per_invoice, "receivedVat":true,
            "preparationMs":preparation_ms, "publicGetters":true,
            "newConnectionPerRead":true, "standaloneDeferredSnapshot":true,
            "alternatingOrder":true, "allRetainedValuesEqual":true,
            "individualPaymentProofsChecked":true, "runs":runs});
        println!("PUBLIC_PAYMENT_WORKSPACE_DENSITY {density}");
        densities.push(density);
    }
    let proof = json!({"synthetic":true, "optimized":true, "timingThreshold":null,
        "fixtureCommands":["create_record","issue_invoice","record_payment"],
        "preparationOutsideTiming":true, "assertionsOutsideTiming":true,
        "serializationOutsideTiming":true, "densities":densities});
    if let Ok(destination) = std::env::var("ZENTRA_PUBLIC_PAYMENT_BENCHMARK_JSON") {
        fs::write(destination, serde_json::to_vec_pretty(&proof).unwrap()).unwrap();
    }
    println!("PUBLIC_PAYMENT_WORKSPACE_BENCHMARK {proof}");
}
