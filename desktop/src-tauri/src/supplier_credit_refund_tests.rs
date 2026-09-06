use super::*;
use crate::supplier_credit_refunds::{ReverseSupplierCreditRefundInput, SupplierCreditRefundInput};
use pretty_assertions::assert_eq;
use rusqlite::params;
use std::io::Read;

fn refund(credit: &str, amount: i64, date: &str) -> SupplierCreditRefundInput {
    SupplierCreditRefundInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        supplier_credit_note_id: credit.into(),
        amount_cents: amount,
        date: date.into(),
        reference: "Virement AV-DATES".into(),
        reason: "Remboursement reçu du fournisseur".into(),
    }
}
fn reversal(id: &str, date: &str) -> ReverseSupplierCreditRefundInput {
    ReverseSupplierCreditRefundInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        refund_id: id.into(),
        date: date.into(),
        reason: "Virement retourné au fournisseur".into(),
    }
}

#[test]
fn supplier_refund_and_compensation_share_one_balance_and_exact_reversal() {
    let (_temp, store, invoice, draft) = fixture();
    validate(&store, &draft);
    let credit = draft.id.unwrap();
    let input = refund(&credit, 1200, "2026-05-15");
    let result = store.record_supplier_credit_refund(input.clone()).unwrap();
    assert_eq!(result["balance"]["remaining_cents"], 800);
    assert_eq!(
        store.record_supplier_credit_refund(input.clone()).unwrap()["idempotent"],
        true
    );
    let mut conflict = input;
    conflict.amount_cents = 1000;
    assert!(store.record_supplier_credit_refund(conflict).is_err());
    let mut apply = ApplySupplierCreditInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        supplier_credit_note_id: credit.clone(),
        supplier_invoice_id: invoice,
        amount_cents: 801,
        effective_date: "2026-05-16".into(),
    };
    assert!(store.apply_supplier_credit(apply.clone()).is_err());
    apply.amount_cents = 800;
    store.apply_supplier_credit(apply).unwrap();
    assert!(store
        .record_supplier_credit_refund(refund(&credit, 1, "2026-05-17"))
        .is_err());
    let id = result["refund"]["id"].as_str().unwrap();
    let reverse = reversal(id, "2026-05-18");
    let reversed = store
        .reverse_supplier_credit_refund(reverse.clone())
        .unwrap();
    assert_eq!(reversed["balance"]["remaining_cents"], 1200);
    assert_eq!(
        store.reverse_supplier_credit_refund(reverse).unwrap()["idempotent"],
        true
    );
    assert!(store
        .reverse_supplier_credit_refund(reversal(id, "2026-05-19"))
        .is_err());
    store
        .record_supplier_credit_refund(refund(&credit, 1200, "2026-05-19"))
        .unwrap();
    let workspace = store.get_workspace().unwrap();
    assert_eq!(
        workspace["supplier_credit_notes"][0]["allocated_cents"],
        800
    );
    assert_eq!(
        workspace["supplier_credit_notes"][0]["refunded_cents"],
        1200
    );
    assert_eq!(workspace["supplier_credit_notes"][0]["available_cents"], 0);
    assert_eq!(
        workspace["supplier_credit_refunds"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert!(store
        .reverse_journal_entry(
            result["refund"]["journal_entry_id"].as_str().unwrap(),
            "2026-05-19",
            None
        )
        .is_err());
    assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
}

#[test]
fn supplier_refund_dates_closing_and_replay_survive_backup() {
    let (temp, store, _invoice, draft) = fixture();
    validate(&store, &draft);
    let credit = draft.id.unwrap();
    for date in ["2026-02-30", "2026-5-15", "2026-05-09", "2099-01-01"] {
        assert!(
            store
                .record_supplier_credit_refund(refund(&credit, 500, date))
                .is_err(),
            "{date}"
        );
    }
    let input = refund(&credit, 500, "2026-05-15");
    let saved = store.record_supplier_credit_refund(input.clone()).unwrap();
    let period = value_id(
        &store
            .upsert_accounting_period(AccountingPeriodInput {
                id: None,
                name: "Mai".into(),
                date_from: "2026-05-01".into(),
                date_to: "2026-05-31".into(),
            })
            .unwrap(),
    );
    store.close_accounting_period(&period).unwrap();
    assert_eq!(
        store.record_supplier_credit_refund(input.clone()).unwrap()["idempotent"],
        true
    );
    assert!(store
        .record_supplier_credit_refund(refund(&credit, 500, "2026-05-20"))
        .is_err());
    let id = saved["refund"]["id"].as_str().unwrap();
    assert!(store
        .reverse_supplier_credit_refund(reversal(id, "2026-05-30"))
        .is_err());
    store
        .reverse_supplier_credit_refund(reversal(id, "2026-06-01"))
        .unwrap();
    let archive = temp
        .path()
        .join("refund.zentra")
        .to_string_lossy()
        .into_owned();
    store
        .create_backup(Some(archive.clone()), "1.35.0")
        .unwrap();
    store.restore_backup(&archive, "1.35.0").unwrap();
    assert_eq!(
        store.record_supplier_credit_refund(input).unwrap()["idempotent"],
        true
    );
    assert_eq!(
        store.get_workspace().unwrap()["supplier_credit_refunds"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let connection = store.connect().unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert!(connection
        .execute(
            "DELETE FROM supplier_credit_refunds WHERE id=?",
            params![id]
        )
        .is_err());
    assert!(connection
        .execute(
            "UPDATE supplier_credit_refunds SET amount_cents=1 WHERE id=?",
            params![id]
        )
        .is_err());
}

#[test]
fn supplier_refund_cannot_spend_a_future_reversal() {
    let (_temp, store, invoice, draft) = fixture();
    validate(&store, &draft);
    let credit = draft.id.unwrap();
    let applied = store
        .apply_supplier_credit(ApplySupplierCreditInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_credit_note_id: credit.clone(),
            supplier_invoice_id: invoice,
            amount_cents: 1500,
            effective_date: "2026-05-15".into(),
        })
        .unwrap();
    store
        .reverse_supplier_credit_allocation(ReverseSupplierCreditAllocationInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            supplier_credit_allocation_id: applied["allocation"]["id"].as_str().unwrap().into(),
            reason: "Compensation annulée".into(),
            effective_date: "2026-05-20".into(),
        })
        .unwrap();
    assert!(store
        .record_supplier_credit_refund(refund(&credit, 1000, "2026-05-18"))
        .is_err());
    assert_eq!(
        store.get_workspace().unwrap()["supplier_credit_refunds"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    store
        .record_supplier_credit_refund(refund(&credit, 1000, "2026-05-21"))
        .unwrap();
}

#[test]
fn supplier_refund_serializes_competing_requests() {
    let (_temp, store, _invoice, draft) = fixture();
    validate(&store, &draft);
    let credit = draft.id.unwrap();
    let store = std::sync::Arc::new(store);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let store = store.clone();
            let barrier = barrier.clone();
            let input = refund(&credit, 1500, "2026-05-15");
            std::thread::spawn(move || {
                barrier.wait();
                store.record_supplier_credit_refund(input).is_ok()
            })
        })
        .collect();
    let succeeded = workers
        .into_iter()
        .map(|w| w.join().expect("competing refund worker must not panic"))
        .filter(|ok| *ok)
        .count();
    assert_eq!(succeeded, 1);
    assert_eq!(
        store.get_workspace().unwrap()["supplier_credit_notes"][0]["available_cents"],
        500
    );
}

#[test]
fn supplier_refund_uses_original_payable_even_after_settings_change() {
    let (_temp, store, _invoice, draft) = fixture();
    validate(&store, &draft);
    let credit = draft.id.unwrap();
    let connection = store.connect().unwrap();
    let original: String = connection
        .query_row(
            "SELECT supplier_payable_account_id FROM accounting_settings WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    connection.execute("UPDATE accounting_settings SET supplier_payable_account_id=vat_payable_account_id WHERE id=1",[]).unwrap();
    let result = store
        .record_supplier_credit_refund(refund(&credit, 2000, "2026-05-15"))
        .unwrap();
    assert_eq!(result["refund"]["payable_account_id"], original);
    let bank = result["refund"]["bank_account_id"].as_str().unwrap();
    let journal = result["refund"]["journal_entry_id"].as_str().unwrap();
    let delta:i64=connection.query_row("SELECT SUM(debit_cents-credit_cents) FROM journal_lines WHERE journal_entry_id=? AND account_id=?",params![journal,bank],|r|r.get(0)).unwrap();
    assert_eq!(delta, 2000);
    let total: i64 = connection
        .query_row(
            "SELECT SUM(debit_cents-credit_cents) FROM journal_lines WHERE journal_entry_id=?",
            params![journal],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(total, 0);
}

#[test]
fn supplier_refund_is_exported_with_its_journal_and_credit_links() {
    let (temp, store, _invoice, draft) = fixture();
    validate(&store, &draft);
    let credit = draft.id.unwrap();
    let result = store
        .record_supplier_credit_refund(refund(&credit, 1000, "2026-05-15"))
        .unwrap();
    let id = result["refund"]["id"].as_str().unwrap();
    let archive = store
        .export_csv_archive(
            Some(temp.path().join("lists.zip").to_string_lossy().into_owned()),
            "1.35.0",
        )
        .unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive).unwrap()).unwrap();
    let mut csv = String::new();
    zip.by_name("03_achats/remboursements_avoirs_fournisseurs.csv")
        .unwrap()
        .read_to_string(&mut csv)
        .unwrap();
    assert!(csv.contains(id));
    assert!(csv.contains(&credit));
    assert!(csv.contains("journal_entry_id"));
    store
        .upsert_accounting_period(AccountingPeriodInput {
            id: None,
            name: "Mai export".into(),
            date_from: "2026-05-01".into(),
            date_to: "2026-05-31".into(),
        })
        .unwrap();
    let filter = crate::models::PeriodFilter {
        date_from: Some("2026-05-01".into()),
        date_to: Some("2026-05-31".into()),
    };
    let review = store.prepare_fiduciary_pre_closing(filter).unwrap();
    assert_eq!(review["checks"]["journal_balanced"], true);
    assert_eq!(review["checks"]["balance_sheet_balanced"], true);
    let closing = store
        .export_fiduciary_closing_zip(review["review_id"].as_str().unwrap(), "1.35.0")
        .unwrap();
    let mut zip =
        zip::ZipArchive::new(std::fs::File::open(closing["path"].as_str().unwrap()).unwrap())
            .unwrap();
    let mut journal = String::new();
    zip.by_name("01_comptabilite/journal.csv")
        .unwrap()
        .read_to_string(&mut journal)
        .unwrap();
    assert!(journal.contains(id));
    assert!(journal.contains("supplier_credit_refund"));
}

#[test]
fn supplier_refund_migration_from_50_does_not_invent_a_payment() {
    let (temp, store, _invoice, draft) = fixture();
    validate(&store, &draft);
    let connection = store.connect().unwrap();
    let path: String = connection
        .query_row(
            "SELECT file FROM pragma_database_list WHERE name='main'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    connection.execute_batch("DROP TRIGGER supplier_credit_allocation_refund_balance; DROP TRIGGER supplier_credit_allocation_refund_chronology; DROP VIEW supplier_credit_settlement_timeline; DROP VIEW supplier_credit_balances; DROP TABLE supplier_credit_refunds; PRAGMA user_version=50;").unwrap();
    let before: i64 = connection
        .query_row("SELECT COUNT(*) FROM journal_entries", [], |r| r.get(0))
        .unwrap();
    drop(connection);
    drop(store);
    let parent = std::path::Path::new(&path).parent().unwrap();
    assert!(parent.starts_with(temp.path()));
    let migrated = LocalStore::initialize(parent.to_path_buf()).unwrap();
    let workspace = migrated.get_workspace().unwrap();
    assert_eq!(
        workspace["supplier_credit_refunds"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        workspace["supplier_credit_notes"][0]["available_cents"],
        2000
    );
    let connection = migrated.connect().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM journal_entries", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::schema::SCHEMA_VERSION
    );
    assert_eq!(
        connection
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}
