use super::*;
use crate::bank_import::credit_refunds::CreateInput;
use crate::supplier_credit_refunds::{ReverseSupplierCreditRefundInput, SupplierCreditRefundInput};
use pretty_assertions::assert_eq;

fn credit(store: &LocalStore, mixed_project: bool) -> (String, String) {
    let supplier = value_id(
        &store
            .create_record("suppliers", json!({"name":"Avoirs Léman SA"}))
            .unwrap(),
    );
    let project = value_id(
        &store
            .create_record("projects", json!({"name":"Projet avoir fournisseur"}))
            .unwrap(),
    );
    let id = Uuid::new_v4().to_string();
    let item = json!({"id":Uuid::new_v4().to_string(),"project_id":project,"description":"Retour de marchandises","quantity_milli":1000,"unit_price_cents":5000,"vat_bp":810,"category":"Marchandises"});
    let items = if mixed_project {
        let mut other = item.clone();
        other["id"] = json!(Uuid::new_v4().to_string());
        other["project_id"] = Value::Null;
        vec![item, other]
    } else {
        vec![item]
    };
    store.save_supplier_credit_note_draft(serde_json::from_value(json!({"id":id,"supplier_id":supplier,"document_date":"2026-08-21","reference":"AV-TEST-BANK","items":items,"allocations":[]})).unwrap()).unwrap();
    let rows = crate::database::query_all(
        &store.connect().unwrap(),
        "SELECT id FROM supplier_credit_note_items WHERE supplier_credit_note_id=?",
        params![id],
    )
    .unwrap();
    for row in rows {
        store
            .set_vat_source_classification(VatSourceClassificationInput {
                source_type: "supplier_credit_note_item".into(),
                source_id: value_id(&row),
                treatment: "input_materials".into(),
                note: None,
            })
            .unwrap();
    }
    store
        .validate_supplier_credit_note(crate::models::ValidateSupplierCreditNoteInput {
            request_id: Uuid::new_v4().to_string(),
            supplier_credit_note_id: id.clone(),
        })
        .unwrap();
    (id, project)
}
fn manual(store: &LocalStore, credit: &str, date: &str) -> String {
    value_id(
        &store
            .record_supplier_credit_refund(SupplierCreditRefundInput {
                request_id: Uuid::new_v4().to_string(),
                supplier_credit_note_id: credit.into(),
                date: date.into(),
                amount_cents: 5405,
                reference: "Virement AV-TEST".into(),
                reason: "Marchandises retournées au fournisseur".into(),
            })
            .unwrap()["refund"],
    )
}
fn create(credit: &str, movement: &str) -> CreateInput {
    CreateInput {
        request_id: Uuid::new_v4().to_string(),
        supplier_credit_note_id: credit.into(),
        movement_id: movement.into(),
        reference: "Virement AV-TEST".into(),
        reason: "Remboursement confirmé sur le relevé".into(),
        attachment: bank_refund_receipt(),
    }
}
fn reverse(refund: &str) -> ReverseSupplierCreditRefundInput {
    ReverseSupplierCreditRefundInput {
        request_id: Uuid::new_v4().to_string(),
        refund_id: refund.into(),
        date: "2026-09-01".into(),
        reason: "Le virement a été retourné au fournisseur".into(),
    }
}
fn state(store: &LocalStore, dir: &Path) -> (i64, i64, i64, i64, i64, usize) {
    let (a,b,c,d,e)=store.connect().unwrap().query_row("SELECT (SELECT COUNT(*) FROM supplier_credit_refunds),(SELECT COUNT(*) FROM bank_supplier_credit_refund_matches),(SELECT COUNT(*) FROM attachments),(SELECT COUNT(*) FROM journal_entries),(SELECT COUNT(*) FROM audit_log)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    (
        a,
        b,
        c,
        d,
        e,
        std::fs::read_dir(dir.join("profile/attachments"))
            .unwrap()
            .count(),
    )
}

#[test]
fn bank_credit_refund_matches_existing_money_without_another_journal_or_vat_event() {
    let (dir, store) = ready();
    let (credit, _) = credit(&store, false);
    let refund = manual(&store, &credit, "2026-08-31");
    let movement = debit(
        &store,
        dir.path(),
        "EXIST-CREDIT",
        Some(refund_credit("54.05", "EXIST-CREDIT")),
    );
    let before = state(&store, dir.path());
    let tax = preview(&store);
    assert_eq!(tax.payable_tax_cents, 405);
    let suggestion =
        store.get_bank_workspace().unwrap()["movements"][0]["refund_suggestion"].clone();
    assert_eq!(
        suggestion["candidates"][0]["supplier_credit_note_id"],
        credit
    );
    assert_eq!(suggestion["candidates"][0]["confirmable"], true);
    let request = refund_match(&movement, &refund);
    let matched = store
        .match_bank_supplier_credit_refund(request.clone())
        .unwrap();
    assert_eq!(matched["already_recorded"], false);
    let after = state(&store, dir.path());
    assert_eq!((after.0, after.3), (before.0, before.3));
    assert_eq!(preview(&store).source_sha256, tax.source_sha256);
    assert_eq!(
        store
            .match_bank_supplier_credit_refund(request.clone())
            .unwrap()["already_recorded"],
        true
    );
    assert_eq!(state(&store, dir.path()), after);
    let mut changed = request.clone();
    changed.date_difference_reason = Some("Autre motif de rapprochement".into());
    assert!(store.match_bank_supplier_credit_refund(changed).is_err());
    let workspace = store.get_bank_workspace().unwrap();
    assert_eq!(workspace["summary"]["unreconciled_count"], 0);
    assert_eq!(
        workspace["movements"][0]["refund_match"]["supplier_credit_note_id"],
        credit
    );
    assert!(store
        .reverse_supplier_credit_refund(reverse(&refund))
        .is_err());
    let unlink = refund_unlink(&request.request_id);
    store
        .unmatch_bank_supplier_credit_refund(unlink.clone())
        .unwrap();
    assert_eq!(
        store.unmatch_bank_supplier_credit_refund(unlink).unwrap()["already_recorded"],
        true
    );
    assert!(store.match_bank_supplier_credit_refund(request).is_err());
    assert_eq!(
        store.get_bank_workspace().unwrap()["movements"][0]["refund_history"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    store
        .reverse_supplier_credit_refund(reverse(&refund))
        .unwrap();
    assert_eq!(preview(&store).payable_tax_cents, 0);
    assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
}

#[test]
fn bank_credit_refund_creation_is_atomic_and_replays_with_receipt_after_backup_restore() {
    let (dir, store) = ready();
    let (credit, project) = credit(&store, false);
    let movement = debit(
        &store,
        dir.path(),
        "CREATE-CREDIT",
        Some(refund_credit("54.05", "CREATE-CREDIT")),
    );
    let input = create(&credit, &movement);
    let before = state(&store, dir.path());
    let result = store
        .create_bank_supplier_credit_refund(input.clone())
        .unwrap();
    let refund = value_id(&result["refund"]);
    let file = value_id(&result["attachment"]);
    assert_eq!(result["refund"]["amount_cents"], 5405);
    assert_eq!(result["refund"]["date"], "2026-08-31");
    assert_eq!(result["attachment"]["project_id"], project);
    assert_eq!(result["attachment"]["entity_id"], refund);
    let after = state(&store, dir.path());
    assert_eq!(
        (after.0, after.1, after.2, after.3, after.5),
        (
            before.0 + 1,
            before.1 + 1,
            before.2 + 1,
            before.3 + 1,
            before.5 + 1
        )
    );
    assert_eq!(preview(&store).payable_tax_cents, 405);
    assert_eq!(
        store.get_workspace().unwrap()["supplier_credit_notes"][0]["available_cents"],
        0
    );
    assert_eq!(
        store
            .create_bank_supplier_credit_refund(input.clone())
            .unwrap()["already_recorded"],
        true
    );
    assert_eq!(state(&store, dir.path()), after);
    let backup = store
        .create_backup(
            Some(
                dir.path()
                    .join("credit-bank.zentra")
                    .to_string_lossy()
                    .into(),
            ),
            "1.35.0",
        )
        .unwrap();
    let restored = LocalStore::initialize(dir.path().join("restored")).unwrap();
    restored.restore_backup(&backup, "1.35.0").unwrap();
    assert_eq!(
        restored
            .create_bank_supplier_credit_refund(input.clone())
            .unwrap()["already_recorded"],
        true
    );
    assert_eq!(
        std::fs::read(restored.verified_attachment_path(&file).unwrap()).unwrap(),
        crate::attachments::test_pdf_bytes()
    );
    let mut changed = input.clone();
    changed.attachment.original_name = "autre.pdf".into();
    assert!(store.create_bank_supplier_credit_refund(changed).is_err());
    let mut changed = input.clone();
    changed.reference = "Autre référence".into();
    assert!(store.create_bank_supplier_credit_refund(changed).is_err());
    store
        .unmatch_bank_supplier_credit_refund(refund_unlink(&input.request_id))
        .unwrap();
    assert!(store
        .create_bank_supplier_credit_refund(input.clone())
        .is_err());
    store
        .match_bank_supplier_credit_refund(refund_match(&movement, &refund))
        .unwrap();
    assert!(store.create_bank_supplier_credit_refund(input).is_err());
}

#[test]
fn bank_credit_refund_exports_keep_source_links_and_verified_receipt_index() {
    let (dir, store) = ready();
    let (credit, project) = credit(&store, false);
    let movement = debit(
        &store,
        dir.path(),
        "EXPORT-CREDIT",
        Some(refund_credit("54.05", "EXPORT-CREDIT")),
    );
    let input = create(&credit, &movement);
    let result = store
        .create_bank_supplier_credit_refund(input.clone())
        .unwrap();
    let refund = value_id(&result["refund"]);
    let attachment = value_id(&result["attachment"]);
    let unlink = refund_unlink(&input.request_id);
    store
        .unmatch_bank_supplier_credit_refund(unlink.clone())
        .unwrap();
    let csv_path = store
        .export_csv_archive(
            Some(
                dir.path()
                    .join("credit-lists.zip")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let mut csv_zip = zip::ZipArchive::new(std::fs::File::open(csv_path).unwrap()).unwrap();
    for (name, expected) in [
        (
            "03_achats/remboursements_avoirs_fournisseurs.csv",
            refund.as_str(),
        ),
        (
            "03_achats/rapprochements_remboursements_avoirs.csv",
            movement.as_str(),
        ),
        (
            "03_achats/dissociations_remboursements_avoirs.csv",
            unlink.request_id.as_str(),
        ),
        (
            "03_achats/creations_bancaires_remboursements_avoirs.csv",
            input.request_id.as_str(),
        ),
        ("10_documents/index_pieces_jointes.csv", attachment.as_str()),
    ] {
        let mut content = String::new();
        std::io::Read::read_to_string(&mut csv_zip.by_name(name).unwrap(), &mut content).unwrap();
        assert!(content.contains(expected), "{name}: {content}");
    }
    store
        .upsert_accounting_period(AccountingPeriodInput {
            id: None,
            name: "Août justificatifs".into(),
            date_from: "2026-08-01".into(),
            date_to: "2026-08-31".into(),
        })
        .unwrap();
    let review = store
        .prepare_fiduciary_pre_closing(crate::models::PeriodFilter {
            date_from: Some("2026-08-01".into()),
            date_to: Some("2026-08-31".into()),
        })
        .unwrap();
    assert_eq!(review["checks"]["attachments_total"], 1);
    assert_eq!(review["checks"]["attachments_verified"], 1);
    assert_eq!(review["checks"]["journal_balanced"], true);
    let export = store
        .export_fiduciary_closing_zip(review["review_id"].as_str().unwrap(), "test")
        .unwrap();
    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(export["path"].as_str().unwrap()).unwrap())
            .unwrap();
    let mut index = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name("02_pieces/index_pieces.json").unwrap(),
        &mut index,
    )
    .unwrap();
    let index: Value = serde_json::from_str(&index).unwrap();
    let file = &index["attachments"][0];
    assert_eq!(file["id"], attachment);
    assert_eq!(file["entity_id"], refund);
    assert_eq!(file["entity_type"], "supplier_credit_refund");
    assert_eq!(file["project_id"], project);
    assert_eq!(file["expected_sha256"], result["attachment"]["sha256"]);
    assert_eq!(file["actual_sha256"], file["expected_sha256"]);
    assert_eq!(file["integrity_valid"], true);
    let mut journal = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name("01_comptabilite/journal.csv").unwrap(),
        &mut journal,
    )
    .unwrap();
    assert!(journal.contains(&refund));
    assert!(journal.contains("supplier_credit_refund"));
}

#[test]
fn bank_credit_refund_bad_movements_files_and_closed_period_leave_no_money_or_file() {
    let (dir, store) = ready();
    let (credit, _) = credit(&store, false);
    for (key, xml) in [
        ("DEBIT-CREDIT", debit_fixture("54.05", "DEBIT-CREDIT", None)),
        ("EXCESS-CREDIT", refund_credit("54.06", "EXCESS-CREDIT")),
        (
            "PENDING-CREDIT",
            fixture(
                "054",
                "08",
                "PDNG",
                "54.05",
                "PENDING-CREDIT",
                Some("D-PENDING-CREDIT"),
                None,
                None,
                false,
                true,
            ),
        ),
        (
            "REVERSE-CREDIT",
            refund_credit("54.05", "REVERSE-CREDIT")
                .replace("<RvslInd>false</RvslInd>", "<RvslInd>true</RvslInd>"),
        ),
        (
            "EARLY-CREDIT",
            refund_credit("54.05", "EARLY-CREDIT").replace("2026-08-31", "2026-08-20"),
        ),
    ] {
        let movement = debit(&store, dir.path(), key, Some(xml));
        let before = state(&store, dir.path());
        assert!(
            store
                .create_bank_supplier_credit_refund(create(&credit, &movement))
                .is_err(),
            "{key}"
        );
        assert_eq!(state(&store, dir.path()), before);
    }
    let movement = debit(
        &store,
        dir.path(),
        "VALID-CREDIT",
        Some(refund_credit("54.05", "VALID-CREDIT")),
    );
    let mut bad = create(&credit, &movement);
    bad.attachment.content_base64 = "SGVsbG8=".into();
    let before = state(&store, dir.path());
    assert!(store.create_bank_supplier_credit_refund(bad).is_err());
    assert_eq!(state(&store, dir.path()), before);
    store.connect().unwrap().execute("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES('closed','T3','2026-07-01','2026-09-30','closed','2026-09-05','2026-09-05')",[]).unwrap();
    assert!(store
        .create_bank_supplier_credit_refund(create(&credit, &movement))
        .is_err());
    assert_eq!(state(&store, dir.path()), before);
}

#[test]
fn bank_credit_refund_commit_failure_rolls_back_installed_receipt_and_all_database_writes() {
    let (dir, store) = ready();
    let (credit, _) = credit(&store, false);
    let movement = debit(
        &store,
        dir.path(),
        "LATE-CREDIT",
        Some(refund_credit("54.05", "LATE-CREDIT")),
    );
    // This FK is checked at COMMIT, after the attachment has been installed on disk.
    store.connect().unwrap().execute_batch("CREATE TABLE deferred_refund_failure (id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_credit_commit AFTER INSERT ON bank_supplier_credit_refund_requests BEGIN INSERT INTO deferred_refund_failure VALUES('missing'); END;").unwrap();
    let before = state(&store, dir.path());
    let tax = preview(&store).source_sha256;
    assert!(store
        .create_bank_supplier_credit_refund(create(&credit, &movement))
        .is_err());
    assert_eq!(state(&store, dir.path()), before);
    assert_eq!(preview(&store).source_sha256, tax);
    store
        .connect()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_credit_commit; DROP TABLE deferred_refund_failure;")
        .unwrap();
    store
        .create_bank_supplier_credit_refund(create(&credit, &movement))
        .unwrap();
}

#[test]
fn bank_credit_refund_and_expense_refund_cannot_share_one_bank_credit() {
    let (dir, store) = ready();
    let (credit, _) = credit(&store, false);
    let refund = manual(&store, &credit, "2026-08-31");
    let (_, _, expense_refund) = refund_purchase(&store);
    let movement = debit(
        &store,
        dir.path(),
        "EXCLUSIVE-CREDIT",
        Some(refund_credit("54.05", "EXCLUSIVE-CREDIT")),
    );
    let first = refund_match(&movement, &refund);
    store
        .match_bank_supplier_credit_refund(first.clone())
        .unwrap();
    assert!(store
        .match_bank_expense_refund(refund_match(&movement, &expense_refund))
        .is_err());
    store
        .unmatch_bank_supplier_credit_refund(refund_unlink(&first.request_id))
        .unwrap();
    let second = refund_match(&movement, &expense_refund);
    store.match_bank_expense_refund(second.clone()).unwrap();
    assert!(store
        .match_bank_supplier_credit_refund(refund_match(&movement, &refund))
        .is_err());
    assert!(store
        .create_bank_supplier_credit_refund(create(&credit, &movement))
        .is_err());
    store
        .unmatch_bank_expense_refund(refund_unlink(&second.request_id))
        .unwrap();
    store
        .match_bank_supplier_credit_refund(refund_match(&movement, &refund))
        .unwrap();
    assert_eq!(
        store.get_bank_workspace().unwrap()["movements"][0]["refund_history"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn bank_credit_refund_date_difference_is_explicit_and_does_not_change_accounted_date() {
    let (dir, store) = ready();
    let (credit, _) = credit(&store, false);
    let refund = manual(&store, &credit, "2026-09-01");
    let movement = debit(
        &store,
        dir.path(),
        "DATE-CREDIT",
        Some(refund_credit("54.05", "DATE-CREDIT")),
    );
    let mut input = refund_match(&movement, &refund);
    let before = state(&store, dir.path());
    assert!(store
        .match_bank_supplier_credit_refund(input.clone())
        .is_err());
    assert_eq!(state(&store, dir.path()), before);
    input.date_difference_reason = Some("Décalage entre comptabilisation et date de valeur".into());
    let tax = preview(&store).source_sha256;
    store.match_bank_supplier_credit_refund(input).unwrap();
    assert_eq!(
        store.get_bank_workspace().unwrap()["movements"][0]["refund_match"]["payment_date"],
        "2026-09-01"
    );
    assert_eq!(preview(&store).source_sha256, tax);
}

#[test]
fn bank_credit_refund_receipts_deduplicate_retain_proofs_and_do_not_guess_a_mixed_project() {
    let (dir, store) = ready();
    let (credit, _) = credit(&store, true);
    let refund = manual(&store, &credit, "2026-08-31");
    let added = store
        .add_supplier_credit_refund_attachment(&refund, bank_refund_receipt())
        .unwrap();
    assert!(added["project_id"].is_null());
    let before = state(&store, dir.path());
    let same = store
        .add_supplier_credit_refund_attachment(&refund, bank_refund_receipt())
        .unwrap();
    assert_eq!(same, added);
    assert_eq!(state(&store, dir.path()), before);
    let connection = store.connect().unwrap();
    assert!(connection
        .execute(
            "DELETE FROM attachments WHERE id=?",
            params![added["id"].as_str()]
        )
        .is_err());
    assert!(connection
        .execute(
            "UPDATE attachments SET original_name='changed.pdf' WHERE id=?",
            params![added["id"].as_str()]
        )
        .is_err());
    assert!(store
        .add_supplier_credit_refund_attachment(&Uuid::new_v4().to_string(), bank_refund_receipt())
        .is_err());
    assert_eq!(state(&store, dir.path()), before);
}

#[test]
fn bank_credit_refund_concurrent_retries_create_one_refund_and_one_file() {
    let (dir, store) = ready();
    let (credit, _) = credit(&store, false);
    let movement = debit(
        &store,
        dir.path(),
        "RACE-CREDIT",
        Some(refund_credit("54.05", "RACE-CREDIT")),
    );
    let input = create(&credit, &movement);
    std::thread::scope(|scope| {
        let a = scope.spawn(|| store.create_bank_supplier_credit_refund(input.clone()));
        let b = scope.spawn(|| store.create_bank_supplier_credit_refund(input.clone()));
        let a = a.join().unwrap().unwrap();
        let b = b.join().unwrap().unwrap();
        assert_eq!(a["match"]["refund_id"], b["match"]["refund_id"]);
    });
    let result = state(&store, dir.path());
    assert_eq!((result.0, result.1, result.2, result.5), (1, 1, 1, 1));
    assert_eq!(preview(&store).payable_tax_cents, 405);
}

#[test]
fn bank_credit_refund_migration_from_51_preserves_money_without_inventing_bank_matches() {
    let (dir, store) = ready();
    let (credit, _) = credit(&store, false);
    let refund = manual(&store, &credit, "2026-08-31");
    let before = counts(&store).0;
    let connection = store.connect().unwrap();
    crate::schema::remove_v52_for_legacy_fixture(&connection);
    connection.pragma_update(None, "user_version", 51).unwrap();
    drop(connection);
    drop(store);
    let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
    let workspace = store.get_workspace().unwrap();
    assert_eq!(workspace["supplier_credit_refunds"][0]["id"], refund);
    assert_eq!(
        workspace["bank_supplier_credit_refund_matches"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(counts(&store).0, before);
    assert_eq!(
        store
            .connect()
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        52
    );
}
