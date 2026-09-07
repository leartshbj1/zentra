use super::*;
use crate::bank_import::customer_refunds::{CreateInput, MatchInput, UnmatchInput};
use crate::customer_credit_settlements::ReverseCustomerCreditSettlementInput;
use crate::expense_refund_attachments::RefundAttachmentInput;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    io::{Cursor, Read},
    path::Path,
};
use uuid::Uuid;

fn setup() -> (tempfile::TempDir, LocalStore, String, String) {
    let (dir, store, client) = fixture();
    received(&store);
    let project = store
        .create_record(
            "projects",
            json!({"name":"Projet remboursement client","client_id":client}),
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let invoice = document(&store, &client, None, &[(10_000, 810)]);
    store
        .update_record("invoices", &invoice, json!({"project_id":project}))
        .unwrap();
    issue(&store, &invoice, "2026-02-01").unwrap();
    pay(&store, &invoice, 10_810, "2026-02-15");
    let credit = document(&store, &client, Some(&invoice), &[(5_000, 810)]);
    store
        .update_record("invoices", &credit, json!({"project_id":project}))
        .unwrap();
    issue(&store, &credit, "2026-03-01").unwrap();
    (dir, store, credit, project)
}
fn xml(key: &str, amount: &str, date: &str) -> String {
    format!(
        r#"<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>{key}</MsgId></GrpHdr><Stmt><Acct><Id><IBAN>CH4431999123000889012</IBAN></Id><Ccy>CHF</Ccy></Acct><Ntry><Amt Ccy="CHF">{amount}</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>{date}</Dt></BookgDt><AcctSvcrRef>{key}</AcctSvcrRef><NtryDtls><TxDtls><Refs><AcctSvcrRef>{key}-TX</AcctSvcrRef><EndToEndId>E2E-{key}</EndToEndId></Refs><RmtInf><Ustrd>Remboursement client {key}</Ustrd></RmtInf><RltdPties><Cdtr><Nm>Client avoirs</Nm></Cdtr></RltdPties></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>"#
    )
}
fn movement(store: &LocalStore, dir: &Path, key: &str, amount: &str, date: &str) -> String {
    import(store, dir, key, &xml(key, amount, date))
}
fn import(store: &LocalStore, dir: &Path, key: &str, xml: &str) -> String {
    let file = dir.join(format!("{key}.xml"));
    std::fs::write(&file, xml).unwrap();
    store.import_camt_file(&file.to_string_lossy()).unwrap();
    store.get_bank_workspace().unwrap()["movements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["unstructured"].as_str().unwrap_or_default().contains(key))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn create(store: &LocalStore, credit: &str, movement: &str) -> CreateInput {
    let (amount, date): (i64, String) = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT amount_cents,COALESCE(booking_date,value_date) FROM bank_movements WHERE id=?",
            [movement],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    CreateInput {
        request_id: Uuid::new_v4().to_string(),
        movement_id: movement.into(),
        customer_credit_note_id: credit.into(),
        expected_amount_cents: amount,
        expected_date: date,
        reference: "AV-CLIENT-2026".into(),
        reason: "Remboursement réellement versé au client".into(),
        attachment: None,
    }
}
fn matched(movement: &str, refund: &str) -> MatchInput {
    MatchInput {
        request_id: Uuid::new_v4().to_string(),
        movement_id: movement.into(),
        refund_id: refund.into(),
        date_difference_reason: None,
    }
}
fn manual(store: &LocalStore, credit: &str, amount: i64, date: &str) -> String {
    store
        .record_customer_credit_settlement(refund_input(store, credit, amount, date))
        .unwrap()["settlement"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn unlink(store: &LocalStore, match_id: &str) -> UnmatchInput {
    let input = UnmatchInput {
        request_id: Uuid::new_v4().to_string(),
        match_id: match_id.into(),
        reason: "Réaffectation documentée du rapprochement".into(),
    };
    store
        .unmatch_bank_customer_credit_refund(input.clone())
        .unwrap();
    input
}
fn receipt() -> RefundAttachmentInput {
    let mut bytes = Cursor::new(Vec::new());
    image::RgbImage::from_pixel(2, 2, image::Rgb([35, 96, 62]))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    RefundAttachmentInput {
        original_name: "confirmation-client.png".into(),
        content_base64: STANDARD.encode(bytes.into_inner()),
    }
}
fn counts(store: &LocalStore) -> (i64, i64, i64, i64, i64) {
    store.connect().unwrap().query_row("SELECT (SELECT COUNT(*) FROM customer_credit_settlements),(SELECT COUNT(*) FROM journal_entries),(SELECT COUNT(*) FROM bank_customer_credit_refund_matches),(SELECT COUNT(*) FROM attachments),(SELECT COUNT(*) FROM bank_customer_credit_refund_requests)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap()
}
#[test]
fn bank_customer_links_existing_refund_without_second_money_or_vat_and_reimports_safely() {
    let (dir, store, credit, _) = setup();
    let refund = manual(&store, &credit, 5405, "2026-03-15");
    let movement = movement(&store, dir.path(), "CLIENT-EXISTING", "54.05", "2026-03-15");
    let before = counts(&store);
    let vat = cash_vat_due(&store, "2026-03-31");
    let input = matched(&movement, &refund);
    let result = store
        .match_bank_customer_credit_refund(input.clone())
        .unwrap();
    assert_eq!(result["already_recorded"], false);
    assert_eq!((counts(&store).0, counts(&store).1), (before.0, before.1));
    assert_eq!(cash_vat_due(&store, "2026-03-31"), vat);
    assert_eq!(
        store.match_bank_customer_credit_refund(input).unwrap()["already_recorded"],
        true
    );
    let bank = store.get_bank_workspace().unwrap();
    assert_eq!(bank["summary"]["unreconciled_supplier_count"], 0);
    assert_eq!(
        bank["movements"][0]["refund_match"]["customer_credit_note_id"],
        credit
    );
    assert!(bank["movements"][0]["refund_match"]["integrity_issue"].is_null());
    let linked = counts(&store);
    import(
        &store,
        dir.path(),
        "CLIENT-EXISTING",
        &xml("CLIENT-EXISTING", "54.05", "2026-03-15"),
    );
    assert_eq!(counts(&store), linked);
    assert_eq!(
        store.get_accounting_continuity().unwrap()["customer_credit_issues"],
        json!([])
    );
    assert!(store
        .match_bank_customer_credit_refund(matched(&movement, &refund))
        .is_err());
}
#[test]
fn bank_customer_create_is_atomic_with_optional_receipt_and_exact_replay() {
    let (dir, store, credit, project) = setup();
    let movement = movement(&store, dir.path(), "CLIENT-CREATE", "27.03", "2026-03-15");
    let mut input = create(&store, &credit, &movement);
    input.attachment = Some(receipt());
    let before = counts(&store);
    store.connect().unwrap().execute_batch("CREATE TRIGGER bank_customer_fail_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='bank_customer_credit_refund_match' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    assert!(store
        .create_bank_customer_credit_refund(input.clone())
        .is_err());
    assert_eq!(counts(&store), before);
    assert_eq!(
        std::fs::read_dir(dir.path().join("profile/attachments"))
            .unwrap()
            .count(),
        0
    );
    store
        .connect()
        .unwrap()
        .execute_batch("DROP TRIGGER bank_customer_fail_audit")
        .unwrap();
    let result = store
        .create_bank_customer_credit_refund(input.clone())
        .unwrap();
    assert_eq!(result["refund"]["date"], "2026-03-15");
    assert_eq!(result["refund"]["amount_cents"], 2703);
    assert_eq!(result["attachment"]["project_id"], project);
    assert_eq!(
        store.get_workspace().unwrap()["customer_credit_balances"][0]["remaining_cents"],
        2702
    );
    let after = counts(&store);
    assert_eq!(
        store
            .create_bank_customer_credit_refund(input.clone())
            .unwrap()["already_recorded"],
        true
    );
    assert_eq!(counts(&store), after);
    input.reason.push_str(" différent");
    assert!(store.create_bank_customer_credit_refund(input).is_err());
    assert_eq!(counts(&store), after);
    assert_eq!(cash_vat_due(&store, "2026-03-31"), 607);
}
#[test]
fn bank_customer_unlink_preserves_refund_blocks_duplicate_creation_and_allows_financial_correction()
{
    let (dir, store, credit, _) = setup();
    let movement = movement(&store, dir.path(), "CLIENT-UNLINK", "27.03", "2026-03-15");
    let input = create(&store, &credit, &movement);
    let result = store
        .create_bank_customer_credit_refund(input.clone())
        .unwrap();
    let refund = result["refund"]["id"].as_str().unwrap();
    let reverse = ReverseCustomerCreditSettlementInput {
        request_id: Uuid::new_v4().to_string(),
        settlement_id: refund.into(),
        date: "2026-03-16".into(),
        reason: "Le virement a été retourné au compte bancaire".into(),
    };
    assert!(store
        .reverse_customer_credit_settlement(reverse.clone())
        .unwrap_err()
        .to_string()
        .contains("Dissociez"));
    let before = counts(&store);
    let vat = cash_vat_due(&store, "2026-03-31");
    let dissociation = unlink(&store, &input.request_id);
    assert_eq!(counts(&store), before);
    assert_eq!(cash_vat_due(&store, "2026-03-31"), vat);
    assert_eq!(
        store
            .unmatch_bank_customer_credit_refund(dissociation)
            .unwrap()["already_recorded"],
        true
    );
    assert!(store.create_bank_customer_credit_refund(input).is_err());
    assert!(store
        .create_bank_customer_credit_refund(create(&store, &credit, &movement))
        .unwrap_err()
        .to_string()
        .contains("conservé"));
    import(
        &store,
        dir.path(),
        "CLIENT-UNLINK",
        &xml("CLIENT-UNLINK", "27.03", "2026-03-15"),
    );
    let bank = store.get_bank_workspace().unwrap();
    assert_eq!(
        bank["movements"][0]["refund_history"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        bank["movements"][0]["refund_suggestion"]["candidates"][0]["refund_id"],
        refund
    );
    store.reverse_customer_credit_settlement(reverse).unwrap();
    assert_eq!(cash_vat_due(&store, "2026-03-31"), 810);
    assert_eq!(
        store.get_accounting_continuity().unwrap()["customer_credit_issues"],
        json!([])
    );
}
#[test]
fn bank_customer_requires_date_reason_and_rejects_bad_amount_direction_or_proof() {
    let (dir, store, credit, _) = setup();
    let refund = manual(&store, &credit, 2703, "2026-03-14");
    let movement = movement(&store, dir.path(), "CLIENT-DATE", "27.03", "2026-03-15");
    let mut input = matched(&movement, &refund);
    assert!(store
        .match_bank_customer_credit_refund(input.clone())
        .unwrap_err()
        .to_string()
        .contains("écart"));
    input.date_difference_reason = Some("Différence de date de valeur de la banque".into());
    store
        .match_bank_customer_credit_refund(input.clone())
        .unwrap();
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row(
                "SELECT date FROM customer_credit_settlements WHERE id=?",
                [&refund],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "2026-03-14"
    );
    unlink(&store, &input.request_id);
    let other = self::movement(
        &store,
        dir.path(),
        "CLIENT-WRONG-AMOUNT",
        "27.02",
        "2026-03-15",
    );
    let mut other_input = matched(&other, &refund);
    other_input.date_difference_reason = input.date_difference_reason.clone();
    assert!(store
        .match_bank_customer_credit_refund(other_input)
        .is_err());
    let credit_movement = import(
        &store,
        dir.path(),
        "CLIENT-CRDT",
        &xml("CLIENT-CRDT", "27.03", "2026-03-15").replace("DBIT", "CRDT"),
    );
    assert!(store
        .create_bank_customer_credit_refund(create(&store, &credit, &credit_movement))
        .is_err());
    // Tampering with an immutable source is only simulated by removing its guard.
    store.connect().unwrap().execute_batch("DROP TRIGGER bank_customer_refund_match_no_update; UPDATE bank_customer_credit_refund_matches SET source_json='{}';").unwrap();
    assert!(
        !store.get_accounting_continuity().unwrap()["customer_credit_issues"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn bank_customer_csv_closing_and_backup_keep_evidence_and_receipt() {
    let (dir, store, credit, _) = setup();
    let movement = movement(&store, dir.path(), "CLIENT-EXPORT", "54.05", "2026-03-15");
    let mut input = create(&store, &credit, &movement);
    input.attachment = Some(receipt());
    let result = store
        .create_bank_customer_credit_refund(input.clone())
        .unwrap();
    let path = store
        .export_csv_archive(
            Some(
                dir.path()
                    .join("customer-bank.zip")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    for name in [
        "02_ventes/rapprochements_remboursements_avoirs_clients.csv",
        "02_ventes/creations_bancaires_remboursements_clients.csv",
    ] {
        let mut content = String::new();
        zip.by_name(name)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert!(content.contains(&input.request_id));
    }
    store
        .upsert_accounting_period(crate::models::AccountingPeriodInput {
            id: None,
            name: "Premier trimestre client".into(),
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
    let mut zip =
        zip::ZipArchive::new(std::fs::File::open(closing["path"].as_str().unwrap()).unwrap())
            .unwrap();
    let mut content = String::new();
    zip.by_name("02_pieces/rapprochements_remboursements_clients.csv")
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert!(content.contains(&input.request_id));
    let backup = store
        .create_backup(
            Some(
                dir.path()
                    .join("client.zentra")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let restored = LocalStore::initialize(dir.path().join("restored")).unwrap();
    restored.restore_backup(&backup, "test").unwrap();
    assert_eq!(counts(&restored), counts(&store));
    assert_eq!(cash_vat_due(&restored, "2026-03-31"), 405);
    assert!(restored
        .verified_attachment_path(result["attachment"]["id"].as_str().unwrap())
        .is_ok());
    assert_eq!(
        restored.get_bank_workspace().unwrap()["movements"][0]["refund_match"]["id"],
        input.request_id
    );
}

#[test]
fn bank_customer_rejects_stale_review_and_unsafe_bank_evidence_without_money_changes() {
    let (dir, store, credit, _) = setup();
    // Only this temporary corrupt-data fixture removes the existing lifecycle guard.
    store
        .connect()
        .unwrap()
        .execute_batch("DROP TRIGGER bank_movements_guarded_update;")
        .unwrap();
    let movement = movement(&store, dir.path(), "CLIENT-REVIEW", "27.03", "2026-03-15");
    let before = counts(&store);
    let mut input = create(&store, &credit, &movement);
    input.expected_amount_cents += 1;
    assert!(store
        .create_bank_customer_credit_refund(input)
        .unwrap_err()
        .to_string()
        .contains("changé"));
    let mut input = create(&store, &credit, &movement);
    input.expected_date = "2026-03-14".into();
    assert!(store
        .create_bank_customer_credit_refund(input)
        .unwrap_err()
        .to_string()
        .contains("changé"));
    for (column, invalid, original) in [
        ("status", "PDNG", "BOOK"),
        ("strong_key", "", "CLIENT-REVIEW-TX"),
        ("account_currency", "EUR", "CHF"),
        ("currency", "EUR", "CHF"),
        (
            "account_id",
            "CH9300762011623852957",
            "CH4431999123000889012",
        ),
        ("reference_type", "CONFLICT", "NON"),
    ] {
        // Temporary fixture corruption exercises validation before the first link.
        let c = store.connect().unwrap();
        c.execute(
            &format!("UPDATE bank_movements SET {column}=? WHERE id=?"),
            rusqlite::params![invalid, movement],
        )
        .unwrap();
        assert!(
            store
                .create_bank_customer_credit_refund(create(&store, &credit, &movement))
                .is_err(),
            "{column}"
        );
        assert_eq!(counts(&store), before);
        c.execute(
            &format!("UPDATE bank_movements SET {column}=? WHERE id=?"),
            rusqlite::params![original, movement],
        )
        .unwrap();
    }
    store
        .create_bank_customer_credit_refund(create(&store, &credit, &movement))
        .unwrap();
}

#[test]
fn bank_customer_refund_is_exclusive_and_original_proofs_are_immutable() {
    let (dir, store, credit, _) = setup();
    let refund = manual(&store, &credit, 2703, "2026-03-15");
    let first = movement(&store, dir.path(), "CLIENT-FIRST", "27.03", "2026-03-15");
    let second = movement(&store, dir.path(), "CLIENT-SECOND", "27.03", "2026-03-15");
    let input = matched(&first, &refund);
    store
        .match_bank_customer_credit_refund(input.clone())
        .unwrap();
    let before = counts(&store);
    assert!(store
        .match_bank_customer_credit_refund(matched(&second, &refund))
        .is_err());
    let c = store.connect().unwrap();
    assert!(c.execute("INSERT INTO bank_customer_credit_refund_matches SELECT ?1,?2,refund_id,date_difference_reason,source_json,confirmed_at FROM bank_customer_credit_refund_matches WHERE id=?3",rusqlite::params![Uuid::new_v4().to_string(),second,input.request_id]).is_err());
    assert!(c
        .execute(
            "UPDATE bank_movements SET amount_cents=1 WHERE id=?",
            [&first]
        )
        .is_err());
    assert!(c
        .execute(
            "DELETE FROM bank_customer_credit_refund_matches WHERE id=?",
            [&input.request_id]
        )
        .is_err());
    assert_eq!(counts(&store), before);
    unlink(&store, &input.request_id);
    assert_eq!(
        store.get_bank_workspace().unwrap()["movements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == first)
            .unwrap()["refund_suggestion"]["can_create"],
        false
    );
    store
        .match_bank_customer_credit_refund(matched(&second, &refund))
        .unwrap();
    assert_eq!((counts(&store).0, counts(&store).1), (before.0, before.1));
}

#[test]
fn bank_customer_migration_56_preserves_existing_refunds_without_inventing_links() {
    let (dir, store, credit, _) = setup();
    let refund = manual(&store, &credit, 2703, "2026-03-15");
    let before = counts(&store);
    let c = store.connect().unwrap();
    for line in include_str!("bank_customer_credit_refund_schema.sql")
        .lines()
        .filter(|line| line.starts_with("CREATE TRIGGER IF NOT EXISTS "))
    {
        let name = line.split_whitespace().nth(5).unwrap();
        c.execute_batch(&format!("DROP TRIGGER {name}")).unwrap();
    }
    c.execute_batch("DROP VIEW active_bank_customer_credit_refund_matches; DROP TABLE bank_customer_credit_refund_requests; DROP TABLE bank_customer_credit_refund_unlinks; DROP TABLE bank_customer_credit_refund_matches; PRAGMA user_version=56;").unwrap();
    drop(c);
    drop(store);
    let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
    assert_eq!(counts(&store), before);
    assert_eq!(
        store.get_workspace().unwrap()["customer_credit_settlements"][0]["id"],
        refund
    );
    assert_eq!(
        store
            .connect()
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::schema::SCHEMA_VERSION
    );
    store
        .connect()
        .unwrap()
        .execute_batch(include_str!("bank_customer_credit_refund_schema.sql"))
        .unwrap();
    assert_eq!(counts(&store), before);
}

#[test]
fn bank_customer_administrative_links_after_closing_leave_the_financial_snapshot_unchanged() {
    let (dir, store, credit, _) = setup();
    classify_customer_lines(&store);
    let refund = manual(&store, &credit, 2703, "2026-03-15");
    let movement = movement(&store, dir.path(), "CLIENT-CLOSED", "27.03", "2026-03-15");
    let period = store
        .upsert_accounting_period(crate::models::AccountingPeriodInput {
            id: None,
            name: "Trimestre clos".into(),
            date_from: "2026-01-01".into(),
            date_to: "2026-03-31".into(),
        })
        .unwrap();
    store
        .close_accounting_period(period["id"].as_str().unwrap())
        .unwrap();
    let filter = || crate::models::PeriodFilter {
        date_from: Some("2026-01-01".into()),
        date_to: Some("2026-03-31".into()),
    };
    let before = store.prepare_fiduciary_pre_closing(filter()).unwrap();
    assert!(store
        .create_bank_customer_credit_refund(create(&store, &credit, &movement))
        .unwrap_err()
        .to_string()
        .contains("clôturée"));
    let input = matched(&movement, &refund);
    store
        .match_bank_customer_credit_refund(input.clone())
        .unwrap();
    unlink(&store, &input.request_id);
    let after = store.prepare_fiduciary_pre_closing(filter()).unwrap();
    assert_eq!(before["source_sha256"], after["source_sha256"]);
    assert_eq!(cash_vat_due(&store, "2026-03-31"), 607);
}

#[test]
fn bank_customer_unlink_after_closing_preserves_the_original_exported_link() {
    let (dir, store, credit, _) = setup();
    classify_customer_lines(&store);
    let refund = manual(&store, &credit, 2703, "2026-03-15");
    let movement = movement(
        &store,
        dir.path(),
        "CLIENT-PRE-CLOSE",
        "27.03",
        "2026-03-15",
    );
    let input = matched(&movement, &refund);
    store
        .match_bank_customer_credit_refund(input.clone())
        .unwrap();
    let period = store
        .upsert_accounting_period(crate::models::AccountingPeriodInput {
            id: None,
            name: "Rapprochement déjà classé".into(),
            date_from: "2026-01-01".into(),
            date_to: "2026-03-31".into(),
        })
        .unwrap();
    store
        .close_accounting_period(period["id"].as_str().unwrap())
        .unwrap();
    let filter = || crate::models::PeriodFilter {
        date_from: Some("2026-01-01".into()),
        date_to: Some("2026-03-31".into()),
    };
    let before = store.prepare_fiduciary_pre_closing(filter()).unwrap();
    let archive = store
        .export_fiduciary_closing_zip(before["review_id"].as_str().unwrap(), "test")
        .unwrap();
    let mut zip =
        zip::ZipArchive::new(std::fs::File::open(archive["path"].as_str().unwrap()).unwrap())
            .unwrap();
    let mut csv = String::new();
    zip.by_name("02_pieces/rapprochements_remboursements_clients.csv")
        .unwrap()
        .read_to_string(&mut csv)
        .unwrap();
    assert!(csv.contains(&input.request_id));
    unlink(&store, &input.request_id);
    let after = store.prepare_fiduciary_pre_closing(filter()).unwrap();
    assert_eq!(before["source_sha256"], after["source_sha256"]);
    assert_eq!(
        store.get_bank_workspace().unwrap()["movements"][0]["refund_history"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
