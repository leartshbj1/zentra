use super::*;
use crate::customer_credit_settlements::{
    journal_proof_valid, ReverseCustomerCreditSettlementInput,
};
use rusqlite::params;
use uuid::Uuid;

fn setup(enabled: bool) -> (tempfile::TempDir, LocalStore, String, String) {
    let (dir, store, client) = fixture();
    if !enabled {
        let mut config = store.get_accounting_settings().unwrap();
        config["enabled"] = json!(false);
        store
            .configure_accounting(serde_json::from_value(config).unwrap())
            .unwrap();
    }
    let invoice = document(&store, &client, None, &[(10_000, 810)]);
    issue(&store, &invoice, "2026-02-01").unwrap();
    let credit = document(&store, &client, Some(&invoice), &[(5_000, 810)]);
    issue(&store, &credit, "2026-03-01").unwrap();
    classify_customer_lines(&store);
    let event = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT id FROM customer_credit_settlements WHERE credit_note_id=?",
            [&credit],
            |row| row.get(0),
        )
        .unwrap();
    (dir, store, credit, event)
}
fn period(store: &LocalStore, from: &str, to: &str) -> String {
    store
        .upsert_accounting_period(crate::models::AccountingPeriodInput {
            id: None,
            name: format!("Contrôle {from} / {to}"),
            date_from: from.into(),
            date_to: to.into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
fn journal(store: &LocalStore, event: &str) -> String {
    store.connect().unwrap().query_row("SELECT journal_entry_id FROM customer_credit_settlement_postings WHERE settlement_id=?",[event],|row|row.get(0)).unwrap()
}
fn snapshot(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();
    let mut result = json!({});
    for table in [
        "invoices",
        "payments",
        "customer_credit_settlements",
        "customer_credit_settlement_lines",
        "customer_credit_settlement_postings",
        "journal_entries",
        "journal_lines",
        "accounting_periods",
        "audit_log",
    ] {
        result[table] = json!(crate::database::query_all(
            &connection,
            &format!("SELECT * FROM {table} ORDER BY rowid"),
            []
        )
        .unwrap());
    }
    result
}
fn reverse(store: &LocalStore, event: &str, date: &str) -> crate::error::AppResult<Value> {
    store.reverse_customer_credit_settlement(ReverseCustomerCreditSettlementInput {
        request_id: Uuid::new_v4().to_string(),
        settlement_id: event.into(),
        date: date.into(),
        reason: "Annulation documentée de la déduction".into(),
    })
}

#[test]
fn missing_customer_posting_is_counted_once_and_cannot_be_closed() {
    let (_dir, store, _credit, event) = setup(false);
    let continuity = store.get_accounting_continuity().unwrap();
    assert_eq!(continuity["missing_customer_credit_settlements"], 1);
    assert_eq!(continuity["total_missing"], 3);
    assert_eq!(continuity["semantic_posting_mismatches"], 0);
    assert_eq!(continuity["total_anomalies"], 3);
    assert_eq!(
        continuity["customer_credit_issues"][0]["settlement_id"],
        event
    );
    assert_eq!(
        continuity["customer_credit_issues"][0]["kind"],
        "missing_posting"
    );
    let id = period(&store, "2026-01-01", "2026-03-31");
    let before = snapshot(&store);
    assert!(store
        .close_accounting_period(&id)
        .unwrap_err()
        .to_string()
        .contains("active et traçable"));
    assert_eq!(snapshot(&store), before);
    let mut config = store.get_accounting_settings().unwrap();
    config["enabled"] = json!(true);
    let result = store
        .configure_accounting(serde_json::from_value(config).unwrap())
        .unwrap();
    assert_eq!(
        result["synchronization"]["created_customer_credit_settlements"],
        1
    );
    assert_eq!(result["synchronization"]["remaining"]["total_anomalies"], 0);
    assert!(
        store.get_accounting_continuity().unwrap()["customer_credit_issues"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    store.close_accounting_period(&id).unwrap();
}

#[test]
fn closed_customer_event_is_reported_and_never_moved_by_backfill() {
    let (_dir, store, _credit, event) = setup(false);
    let reversal = reverse(&store, &event, "2026-03-02").unwrap();
    let reverse_id = reversal["settlement"]["id"].as_str().unwrap();
    let closed = period(&store, "2026-03-02", "2026-03-02");
    // A recovered old database may contain a period closed before automatic posting existed.
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE accounting_periods SET status='closed',closed_at='2026-03-03' WHERE id=?",
            [&closed],
        )
        .unwrap();
    let continuity = store.get_accounting_continuity().unwrap();
    assert_eq!(continuity["closed_history_requires_opening"], 4);
    assert_eq!(continuity["semantic_posting_mismatches"], 0);
    let problem = continuity["customer_credit_issues"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["settlement_id"] == reverse_id)
        .unwrap();
    assert_eq!(problem["closed_period"], 1);
    let mut config = store.get_accounting_settings().unwrap();
    config["enabled"] = json!(true);
    let result = store
        .configure_accounting(serde_json::from_value(config).unwrap())
        .unwrap();
    assert_eq!(result["synchronization"]["skipped_closed_history"], 4);
    assert_eq!(
        result["synchronization"]["requires_opening_balance_review"],
        true
    );
    assert_eq!(result["synchronization"]["remaining"]["total_missing"], 0);
    assert_eq!(result["synchronization"]["remaining"]["total_anomalies"], 4);
    assert_eq!(result["synchronization"]["created_total"], 0);
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM journal_entries WHERE source_id=?",
                [reverse_id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let next = period(&store, "2026-04-01", "2026-06-30");
    let before = snapshot(&store);
    assert!(store
        .close_accounting_period(&next)
        .unwrap_err()
        .to_string()
        .contains("période déjà fermée"));
    assert_eq!(snapshot(&store), before);
}

#[test]
fn orphan_and_extra_customer_journals_block_closing_without_invented_repair() {
    for existing_source in [false, true] {
        let (_dir, store, _credit, event) = setup(true);
        let original = journal(&store, &event);
        let orphan = Uuid::new_v4().to_string();
        let source = if existing_source {
            event.clone()
        } else {
            Uuid::new_v4().to_string()
        };
        let connection = store.connect().unwrap();
        connection.execute("INSERT INTO journal_entries(id,number,entry_date,description,source_type,source_id,source_event,status,reversal_of,created_at) SELECT ?1,'J-ORPHAN','2026-03-10',description,source_type,?2,'unregistered',status,NULL,created_at FROM journal_entries WHERE id=?3",params![orphan,source,original]).unwrap();
        connection.execute("INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_cents,credit_cents,currency,memo,project_id,client_id,employee_id,created_at) SELECT 'extra-'||id,?1,account_id,debit_cents,credit_cents,currency,memo,project_id,client_id,employee_id,created_at FROM journal_lines WHERE journal_entry_id=?2",params![orphan,original]).unwrap();
        let report = store.get_accounting_continuity().unwrap();
        assert_eq!(report["total_missing"], 0);
        assert_eq!(report["semantic_posting_mismatches"], 1);
        assert_eq!(
            report["customer_credit_issues"][0]["kind"],
            "orphan_journal"
        );
        assert_eq!(
            report["customer_credit_issues"][0]["journal_entry_id"],
            orphan
        );
        let id = period(&store, "2026-01-01", "2026-03-31");
        let before = snapshot(&store);
        assert!(store
            .close_accounting_period(&id)
            .unwrap_err()
            .to_string()
            .contains("ne correspondent pas exactement"));
        assert_eq!(snapshot(&store), before);
        let review = store
            .prepare_fiduciary_pre_closing(crate::models::PeriodFilter {
                date_from: Some("2026-01-01".into()),
                date_to: Some("2026-03-31".into()),
            })
            .unwrap();
        assert_eq!(review["checks"]["ready_for_final"], false);
    }
}

#[test]
fn damaged_customer_proofs_remain_readable_but_cannot_be_reversed_or_closed() {
    for damage in ["snapshot", "journal"] {
        let (_dir, store, _credit, event) = setup(true);
        let journal_id = journal(&store, &event);
        let connection = store.connect().unwrap();
        if damage == "snapshot" {
            connection.execute_batch("DROP TRIGGER customer_credit_settlement_posting_no_update; PRAGMA ignore_check_constraints=ON;").unwrap();
            connection.execute("UPDATE customer_credit_settlement_postings SET snapshot_json='broken' WHERE settlement_id=?",[&event]).unwrap();
        } else {
            connection
                .execute_batch("PRAGMA foreign_keys=OFF; DROP TRIGGER journal_lines_no_delete; DROP TRIGGER journal_entries_no_delete;")
                .unwrap();
            connection
                .execute(
                    "DELETE FROM journal_lines WHERE journal_entry_id=?",
                    [&journal_id],
                )
                .unwrap();
            connection
                .execute("DELETE FROM journal_entries WHERE id=?", [&journal_id])
                .unwrap();
        }
        assert!(!journal_proof_valid(&connection, &event).unwrap());
        let workspace = store.get_workspace().unwrap();
        assert_eq!(
            workspace["customer_credit_settlements"][0]["journal_valid"],
            false
        );
        let report = store.get_accounting_continuity().unwrap();
        assert_eq!(report["total_missing"], 0);
        assert_eq!(report["semantic_posting_mismatches"], 1);
        assert_eq!(
            report["customer_credit_issues"][0]["kind"],
            "invalid_posting"
        );
        let id = period(&store, "2026-01-01", "2026-03-31");
        let before = snapshot(&store);
        assert!(reverse(&store, &event, "2026-03-02").is_err());
        assert!(store.close_accounting_period(&id).is_err());
        assert_eq!(snapshot(&store), before);
    }
}

#[test]
fn customer_journal_in_an_earlier_period_is_checked_in_that_period() {
    let (_dir, store, _credit, event) = setup(true);
    let connection = store.connect().unwrap();
    connection
        .execute_batch("DROP TRIGGER journal_entries_no_update;")
        .unwrap();
    connection
        .execute(
            "UPDATE journal_entries SET entry_date='2026-02-20' WHERE id=?",
            [journal(&store, &event)],
        )
        .unwrap();
    let issues = crate::customer_credit_settlements::accounting_issues(
        &connection,
        "2026-02-01",
        "2026-02-28",
    )
    .unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0]["settlement_id"], event);
    let id = period(&store, "2026-02-01", "2026-02-28");
    let before = snapshot(&store);
    assert!(store
        .close_accounting_period(&id)
        .unwrap_err()
        .to_string()
        .contains("ne correspondent pas exactement"));
    assert_eq!(snapshot(&store), before);
}

#[test]
fn generic_customer_journal_reversal_does_not_replace_a_financial_correction() {
    let (_dir, store, _credit, event) = setup(true);
    let journal_id = journal(&store, &event);
    let child = Uuid::new_v4().to_string();
    let connection = store.connect().unwrap();
    connection.execute("INSERT INTO journal_entries(id,number,entry_date,description,source_type,source_id,source_event,status,reversal_of,created_at) SELECT ?1,'J-REVERSAL','2026-03-02',description,'reversal',id,'reversal','posted',id,created_at FROM journal_entries WHERE id=?2",params![child,journal_id]).unwrap();
    assert!(!journal_proof_valid(&connection, &event).unwrap());
    assert_eq!(
        store.get_accounting_continuity().unwrap()["semantic_posting_mismatches"],
        1
    );
}
