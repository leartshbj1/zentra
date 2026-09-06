use super::*;
use crate::{
    customer_credit_recovery::{RecoveryCredit, RecoveryInput},
    database::query_all,
};
use std::io::Read;

#[test]
fn recovery_detects_a_legacy_line_tax_that_disagrees_with_its_issued_header() {
    let (_dir, store, invoice, credits) = legacy();
    let connection = store.connect().unwrap();
    connection
        .execute_batch("DROP TRIGGER invoice_items_issued_no_update;")
        .unwrap();
    // Preserve the gross and remain below the original per-rate ceiling. Only
    // the reconciliation with the immutable issue totals exposes these 5 cents.
    connection.execute("UPDATE invoice_items SET line_net_cents=line_net_cents-5,line_vat_cents=line_vat_cents+5 WHERE invoice_id=?",[&credits[0]]).unwrap();
    let before = financial_snapshot(&store);
    let plan = store.get_customer_credit_recovery(&invoice).unwrap();
    assert!(plan["blocker"].as_str().unwrap().contains("journal"));
    assert_eq!(before, financial_snapshot(&store));
}
use uuid::Uuid;

fn legacy() -> (tempfile::TempDir, LocalStore, String, Vec<String>) {
    let (dir, store, client) = fixture();
    let mut settings = store.get_accounting_settings().unwrap();
    settings["enabled"] = json!(false);
    store
        .configure_accounting(serde_json::from_value(settings).unwrap())
        .unwrap();
    let invoice = document(&store, &client, None, &[(10_000, 810)]);
    issue(&store, &invoice, "2026-02-01").unwrap();
    let mut credits = Vec::new();
    for net in [5_000, 2_000] {
        let credit = document(&store, &client, Some(&invoice), &[(net, 810)]);
        issue(&store, &credit, "2026-03-01").unwrap();
        credits.push(credit);
    }
    let connection = store.connect().unwrap();
    // Reproduce a v52 profile before accounting was activated: no dated events
    // or settlement journals existed in that version.
    assert_eq!(
        query_all(&connection, "SELECT * FROM journal_entries", [])
            .unwrap()
            .len(),
        0
    );
    crate::schema::remove_v52_for_legacy_fixture(&connection);
    connection
        .execute_batch(crate::schema::MIGRATION_V52_SQL)
        .unwrap();
    drop(connection);
    drop(store);
    let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
    let mut settings = store.get_accounting_settings().unwrap();
    settings["enabled"] = json!(true);
    store
        .configure_accounting(serde_json::from_value(settings).unwrap())
        .unwrap();
    (dir, store, invoice, credits)
}
fn input(store: &LocalStore, invoice: &str, credits: &[String]) -> RecoveryInput {
    let plan = store.get_customer_credit_recovery(invoice).unwrap();
    assert!(plan["blocker"].is_null(), "{plan:#}");
    RecoveryInput {
        request_id: Uuid::new_v4().to_string(),
        original_invoice_id: invoice.into(),
        source_token: plan["source_token"].as_str().unwrap().into(),
        reference: "Accord client 2026-03".into(),
        reason: "Déductions rapprochées avec le client, aucun remboursement effectué".into(),
        no_prior_refund: true,
        credits: credits
            .iter()
            .enumerate()
            .map(|(index, id)| RecoveryCredit {
                credit_note_id: id.clone(),
                applied_cents: if index == 0 { 2_703 } else { 0 },
                application_date: if index == 0 {
                    Some("2026-03-15".into())
                } else {
                    None
                },
            })
            .collect(),
    }
}
fn financial_snapshot(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();
    let mut value = json!({});
    for table in [
        "invoices",
        "payments",
        "customer_credit_documents",
        "customer_credit_settlements",
        "customer_credit_settlement_lines",
        "customer_credit_settlement_postings",
        "customer_credit_recoveries",
        "journal_entries",
        "journal_lines",
        "audit_log",
        "sqlite_sequence",
    ] {
        value[table] = json!(query_all(
            &connection,
            &format!("SELECT * FROM {table} ORDER BY rowid"),
            []
        )
        .unwrap());
    }
    value
}
#[test]
fn recovery_preview_is_write_free_and_adoption_preserves_issued_money() {
    let (_dir, store, invoice, credits) = legacy();
    let request = input(&store, &invoice, &credits);
    let before = financial_snapshot(&store);
    let preview = store
        .preview_customer_credit_recovery(request.clone())
        .unwrap();
    assert_eq!(preview["invoice_remaining_cents"], 8_107);
    assert_eq!(preview["bank_movement_cents"], 0);
    assert_eq!(preview["vat_change_cents"], 0);
    assert_eq!(
        before,
        financial_snapshot(&store),
        "preview must roll back even audit/number sequences"
    );
    let adopted = store
        .adopt_customer_credit_recovery(request.clone())
        .unwrap();
    assert_eq!(adopted["result"], preview);
    let connection = store.connect().unwrap();
    let issues = crate::customer_credit_settlements::accounting_issues(
        &connection,
        "0001-01-01",
        "9999-12-31",
    )
    .unwrap();
    assert!(issues.is_empty(), "{issues:?}");
    for old in before["journal_entries"].as_array().unwrap() {
        let rows = query_all(
            &connection,
            "SELECT * FROM journal_entries WHERE id=?",
            [old["id"].as_str().unwrap()],
        )
        .unwrap();
        assert_eq!(&rows[0], old);
    }
    for old in before["journal_lines"].as_array().unwrap() {
        let rows = query_all(
            &connection,
            "SELECT * FROM journal_lines WHERE id=?",
            [old["id"].as_str().unwrap()],
        )
        .unwrap();
        assert_eq!(&rows[0], old);
    }
    assert_eq!(cash_vat_due(&store, "2026-12-31"), 243);
    assert!(connection
        .execute("DELETE FROM customer_credit_recoveries", [])
        .is_err());
    assert!(connection
        .execute(
            "UPDATE customer_credit_recoveries SET created_at='changed'",
            []
        )
        .is_err());
    let after = financial_snapshot(&store);
    assert_eq!(
        store
            .adopt_customer_credit_recovery(request.clone())
            .unwrap()["idempotent"],
        true
    );
    assert_eq!(after, financial_snapshot(&store));
    let mut changed = request;
    changed.reason.push('!');
    assert!(store.adopt_customer_credit_recovery(changed).is_err());
    assert_eq!(after, financial_snapshot(&store));
    let refund = store
        .record_customer_credit_settlement(refund_input(&store, &credits[0], 2_702, "2026-04-01"))
        .unwrap();
    assert_eq!(refund["balance"]["remaining_cents"], 0);
    assert_eq!(
        cash_vat_due(&store, "2026-12-31"),
        243,
        "agreed VAT must not be deducted twice on refund"
    );
}
#[test]
fn recovery_rejects_stale_review_and_incomplete_or_invalid_facts_atomically() {
    let (_dir, store, invoice, credits) = legacy();
    let base = input(&store, &invoice, &credits);
    let before = financial_snapshot(&store);
    let mut invalids = Vec::new();
    let mut c = base.clone();
    c.credits.pop();
    invalids.push(c);
    let mut c = base.clone();
    c.credits.push(c.credits[0].clone());
    invalids.push(c);
    let mut c = base.clone();
    c.credits[0].applied_cents = 5_406;
    invalids.push(c);
    let mut c = base.clone();
    c.credits[0].application_date = None;
    invalids.push(c);
    let mut c = base.clone();
    c.credits[0].application_date = Some("2026-02-28".into());
    invalids.push(c);
    let mut c = base.clone();
    c.credits[0].application_date = Some("2099-01-01".into());
    invalids.push(c);
    let mut c = base.clone();
    c.credits[1].application_date = Some("2026-03-01".into());
    invalids.push(c);
    let mut c = base.clone();
    c.no_prior_refund = false;
    invalids.push(c);
    for request in invalids {
        assert!(store.adopt_customer_credit_recovery(request).is_err());
        assert_eq!(before, financial_snapshot(&store));
    }
    pay(&store, &invoice, 1_000, "2026-03-10");
    let after = financial_snapshot(&store);
    assert!(store
        .adopt_customer_credit_recovery(base)
        .unwrap_err()
        .to_string()
        .contains("changé"));
    assert_eq!(after, financial_snapshot(&store));
    let mut request = input(&store, &invoice, &credits);
    request.credits[0].application_date = Some("2026-03-09".into());
    assert!(store
        .adopt_customer_credit_recovery(request)
        .unwrap_err()
        .to_string()
        .contains("chronologie"));
    assert_eq!(after, financial_snapshot(&store));
}
#[test]
fn recovery_late_failure_rolls_back_registration_applications_journals_and_audit() {
    let (_dir, store, invoice, credits) = legacy();
    let request = input(&store, &invoice, &credits);
    store.connect().unwrap().execute_batch("CREATE TRIGGER fail_recovery BEFORE INSERT ON customer_credit_recoveries BEGIN SELECT RAISE(ABORT,'injected last write failure'); END;").unwrap();
    let before = financial_snapshot(&store);
    assert!(store
        .adopt_customer_credit_recovery(request.clone())
        .is_err());
    assert_eq!(before, financial_snapshot(&store));
    store
        .connect()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_recovery;")
        .unwrap();
    store.adopt_customer_credit_recovery(request).unwrap();
}
#[test]
fn recovery_blockers_preserve_closed_received_and_damaged_histories() {
    let (_dir, store, invoice, credits) = legacy();
    let request = input(&store, &invoice, &credits);
    let connection = store.connect().unwrap();
    connection
        .execute_batch("DROP TRIGGER journal_lines_no_update;")
        .unwrap();
    connection.execute("UPDATE journal_lines SET memo='historical unknown allocation' WHERE journal_entry_id=(SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=?) AND memo='Extourne TVA'",[&credits[0]]).unwrap();
    let before = financial_snapshot(&store);
    assert!(
        store.get_customer_credit_recovery(&invoice).unwrap()["blocker"]
            .as_str()
            .unwrap()
            .contains("journal")
    );
    assert!(store.adopt_customer_credit_recovery(request).is_err());
    assert_eq!(before, financial_snapshot(&store));
    let (_dir2, store2, invoice2, _credits2) = legacy();
    // Simulate a restored history whose VAT profile is received. This must not
    // silently relabel its old issue-VAT journals as dated settlement VAT.
    let connection = store2.connect().unwrap();
    connection.execute_batch("INSERT INTO vat_profiles(id,effective_from,reporting_method,form_of_reporting,periodicity,gross_or_net,afc_authorization_confirmed,notes,created_at,updated_at) VALUES('legacy-received','2026-01-01','effective','received','quarterly','gross',1,'recovered profile','2026-01-01','2026-01-01');").unwrap();
    assert!(
        store2.get_customer_credit_recovery(&invoice2).unwrap()["blocker"]
            .as_str()
            .unwrap()
            .contains("encaissement")
    );
    let (_dir3, store3, invoice3, _credits3) = legacy();
    let period = store3
        .upsert_accounting_period(crate::models::AccountingPeriodInput {
            id: None,
            name: "Exercice repris".into(),
            date_from: "2026-02-15".into(),
            date_to: "2026-02-28".into(),
        })
        .unwrap();
    store3
        .connect()
        .unwrap()
        .execute(
            "UPDATE accounting_periods SET status='closed',closed_at='2026-03-01' WHERE id=?",
            [period["id"].as_str().unwrap()],
        )
        .unwrap();
    assert!(
        store3.get_customer_credit_recovery(&invoice3).unwrap()["blocker"]
            .as_str()
            .is_some()
    );
}
#[test]
fn recovery_competing_requests_share_one_atomic_registration() {
    let (dir, store, invoice, credits) = legacy();
    let first = input(&store, &invoice, &credits);
    let mut second = first.clone();
    second.request_id = Uuid::new_v4().to_string();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let worker = |request: RecoveryInput| {
        let path = dir.path().join("profile");
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let store = LocalStore::initialize(path).unwrap();
            barrier.wait();
            store.adopt_customer_credit_recovery(request)
        })
    };
    let a = worker(first);
    let b = worker(second);
    let outcomes = [a.join().unwrap(), b.join().unwrap()];
    assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(outcomes.iter().filter(|r| r.is_err()).count(), 1);
    let connection = store.connect().unwrap();
    assert_eq!(
        query_all(&connection, "SELECT * FROM customer_credit_recoveries", [])
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        query_all(&connection, "SELECT * FROM customer_credit_settlements", [])
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn recovery_v54_migration_preserves_legacy_rows_and_exports_retain_the_proof() {
    let (dir, store, invoice, credits) = legacy();
    let before = financial_snapshot(&store);
    store
        .connect()
        .unwrap()
        .execute_batch("DROP TABLE customer_credit_recoveries; PRAGMA user_version=54;")
        .unwrap();
    drop(store);
    let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
    assert_eq!(before, financial_snapshot(&store));
    assert_eq!(
        store
            .connect()
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        55
    );
    let request = input(&store, &invoice, &credits);
    store
        .adopt_customer_credit_recovery(request.clone())
        .unwrap();
    let connection = store.connect().unwrap();
    let proof = query_all(&connection, "SELECT * FROM customer_credit_recoveries", []).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(proof[0]["source_json"].as_str().unwrap()).unwrap()
            ["registered"],
        json!([])
    );
    let csv_path = store
        .export_csv_archive(
            Some(
                dir.path()
                    .join("legacy.csv.zip")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let mut csv = zip::ZipArchive::new(std::fs::File::open(csv_path).unwrap()).unwrap();
    let mut contents = String::new();
    csv.by_name("02_ventes/reprises_avoirs_clients.csv")
        .unwrap()
        .read_to_string(&mut contents)
        .unwrap();
    assert!(contents.contains(&request.reference));
    assert!(contents.contains(&request.source_token));
    store
        .upsert_accounting_period(crate::models::AccountingPeriodInput {
            id: None,
            name: "Reprise des avoirs".into(),
            date_from: "2026-01-01".into(),
            date_to: "2026-03-31".into(),
        })
        .unwrap();
    let review = store
        .prepare_fiduciary_pre_closing(crate::models::PeriodFilter {
            date_from: Some("2026-01-01".into()),
            date_to: Some("2026-03-31".into()),
        })
        .unwrap();
    let closing = store
        .export_fiduciary_closing_zip(review["review_id"].as_str().unwrap(), "test")
        .unwrap();
    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(closing["path"].as_str().unwrap()).unwrap())
            .unwrap();
    let mut contents = String::new();
    archive
        .by_name("02_pieces/index_pieces.json")
        .unwrap()
        .read_to_string(&mut contents)
        .unwrap();
    let index: Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(index["customer_credit_recoveries"], json!(proof));
    let mut contents = String::new();
    archive
        .by_name("02_pieces/reprises_avoirs_clients.csv")
        .unwrap()
        .read_to_string(&mut contents)
        .unwrap();
    assert!(contents.contains(&request.source_token));
    let backup = store
        .create_backup(
            Some(
                dir.path()
                    .join("legacy.zentra")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let restored = LocalStore::initialize(dir.path().join("restored")).unwrap();
    restored.restore_backup(&backup, "test").unwrap();
    let restored_connection = restored.connect().unwrap();
    for table in [
        "customer_credit_recoveries",
        "customer_credit_documents",
        "customer_credit_settlements",
        "customer_credit_settlement_lines",
        "customer_credit_settlement_postings",
        "journal_entries",
        "journal_lines",
    ] {
        let sql = format!("SELECT * FROM {table} ORDER BY rowid");
        assert_eq!(
            query_all(&connection, &sql, []).unwrap(),
            query_all(&restored_connection, &sql, []).unwrap(),
            "{table}"
        );
    }
    assert_eq!(
        restored.adopt_customer_credit_recovery(request).unwrap()["idempotent"],
        true
    );
}
