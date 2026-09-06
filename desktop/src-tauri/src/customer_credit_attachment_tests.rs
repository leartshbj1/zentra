use super::*;
use crate::expense_refund_attachments::RefundAttachmentInput;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::io::{Cursor, Read};

fn receipt() -> RefundAttachmentInput {
    let mut bytes = Cursor::new(Vec::new());
    image::RgbImage::from_pixel(2, 2, image::Rgb([35, 96, 62]))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    RefundAttachmentInput {
        original_name: "confirmation-virement.png".into(),
        content_base64: STANDARD.encode(bytes.into_inner()),
    }
}
fn setup() -> (tempfile::TempDir, LocalStore, String, String, String) {
    setup_with_accounting(true)
}
fn setup_with_accounting(enabled: bool) -> (tempfile::TempDir, LocalStore, String, String, String) {
    let (dir, store, client) = fixture();
    received(&store);
    if !enabled {
        let mut configuration = store.get_accounting_settings().unwrap();
        configuration["enabled"] = json!(false);
        store
            .configure_accounting(serde_json::from_value(configuration).unwrap())
            .unwrap();
    }
    let project = store
        .create_record(
            "projects",
            json!({"name":"Projet documents client","client_id":client}),
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
    if enabled {
        pay(&store, &invoice, 10_810, "2026-02-15");
    }
    let credit = document(&store, &client, Some(&invoice), &[(5_000, 810)]);
    store
        .update_record("invoices", &credit, json!({"project_id":project}))
        .unwrap();
    issue(&store, &credit, "2026-03-01").unwrap();
    if !enabled {
        let application: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT id FROM customer_credit_settlements WHERE credit_note_id=?",
                [&credit],
                |row| row.get(0),
            )
            .unwrap();
        store
            .reverse_customer_credit_settlement(
                crate::customer_credit_settlements::ReverseCustomerCreditSettlementInput {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    settlement_id: application,
                    date: "2026-03-02".into(),
                    reason: "Déduction annulée avant remboursement".into(),
                },
            )
            .unwrap();
    }
    classify_customer_lines(&store);
    let refund = store
        .record_customer_credit_settlement(refund_input(&store, &credit, 2_703, "2026-04-01"))
        .unwrap();
    let event = refund["settlement"]["id"].as_str().unwrap().to_owned();
    (dir, store, credit, event, project)
}
fn financial_snapshot(store: &LocalStore) -> Value {
    let connection = store.connect().unwrap();
    let mut snapshot = json!({});
    for table in [
        "invoices",
        "payments",
        "journal_entries",
        "journal_lines",
        "customer_credit_settlements",
        "customer_credit_settlement_lines",
        "customer_credit_settlement_postings",
    ] {
        snapshot[table] = json!(crate::database::query_all(
            &connection,
            &format!("SELECT * FROM {table} ORDER BY rowid"),
            []
        )
        .unwrap());
    }
    snapshot
}
fn stored_files(store: &LocalStore) -> Vec<String> {
    let mut files = std::fs::read_dir(&store.attachments_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    files.sort();
    files
}

#[test]
fn customer_receipt_for_unposted_settlement_is_present_in_draft_closing() {
    let (_dir, store, _credit, event, _project) = setup_with_accounting(false);
    let file = store
        .add_customer_credit_settlement_attachment(&event, receipt())
        .unwrap();
    let period = store
        .upsert_accounting_period(crate::models::AccountingPeriodInput {
            id: None,
            name: "Règlement non comptabilisé".into(),
            date_from: "2026-04-01".into(),
            date_to: "2026-06-30".into(),
        })
        .unwrap();
    let review = store
        .prepare_fiduciary_pre_closing(crate::models::PeriodFilter {
            date_from: Some("2026-04-01".into()),
            date_to: Some("2026-06-30".into()),
        })
        .unwrap();
    assert_eq!(review["checks"]["attachments_total"], 1);
    assert_eq!(review["checks"]["attachments_verified"], 1);
    assert_eq!(review["checks"]["ready_for_final"], false);
    assert!(store
        .finalize_accounting_period_with_review(
            period["id"].as_str().unwrap(),
            review["review_id"].as_str().unwrap()
        )
        .is_err());
    let result = store
        .export_fiduciary_closing_zip(review["review_id"].as_str().unwrap(), "test")
        .unwrap();
    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(result["path"].as_str().unwrap()).unwrap())
            .unwrap();
    let mut contents = String::new();
    archive
        .by_name("02_pieces/index_pieces.json")
        .unwrap()
        .read_to_string(&mut contents)
        .unwrap();
    let index: Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(index["attachments"][0]["id"], file["id"]);
    assert_eq!(index["customer_credit_settlements"][0]["id"], event);
    assert_eq!(
        index["customer_credit_settlements"][0]["journal_proof_valid"],
        false
    );
    assert!(index["customer_credit_settlements"][0]["journal_entry_id"].is_null());
}

#[test]
fn customer_receipt_concurrent_uploads_share_one_file_and_migration_53_preserves_it() {
    let (dir, store, _credit, event, _project) = setup();
    let store = std::sync::Arc::new(store);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let store = store.clone();
            let event = event.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.add_customer_credit_settlement_attachment(&event, receipt())
            })
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|handle| handle.join().unwrap().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results[0]["id"], results[1]["id"]);
    let money = financial_snapshot(&store);
    let connection = store.connect().unwrap();
    for kind in ["TRIGGER", "VIEW"] {
        let prefix = format!("CREATE {kind} IF NOT EXISTS ");
        for name in crate::schema::MIGRATION_V54_SQL.lines().filter_map(|line| {
            line.strip_prefix(&prefix)
                .and_then(|rest| rest.split_whitespace().next())
        }) {
            assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
            connection
                .execute_batch(&format!("DROP {kind} IF EXISTS {name};"))
                .unwrap();
        }
    }
    connection.pragma_update(None, "user_version", 53).unwrap();
    drop(connection);
    drop(store);
    let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
    assert_eq!(financial_snapshot(&store), money);
    let id = results[0]["id"].as_str().unwrap();
    assert!(store.verified_attachment_path(id).is_ok());
    assert!(store
        .connect()
        .unwrap()
        .execute("DELETE FROM attachments WHERE id=?", [id])
        .is_err());
    assert_eq!(
        store
            .add_customer_credit_settlement_attachment(&event, receipt())
            .unwrap()["id"],
        id
    );
    assert!(!stored_files(&store)
        .iter()
        .any(|name| name.ends_with("attachment-part")));
}

#[test]
fn customer_application_receipt_does_not_guess_a_project_when_documents_differ() {
    let (_dir, store, credit, _refund, project) = setup();
    let connection = store.connect().unwrap();
    let client: String = connection
        .query_row(
            "SELECT client_id FROM invoices WHERE id=?",
            [&credit],
            |row| row.get(0),
        )
        .unwrap();
    drop(connection);
    let other_project = store
        .create_record(
            "projects",
            json!({"name":"Autre projet du client","client_id":client}),
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let target = document(&store, &client, None, &[(10_000, 810)]);
    store
        .update_record("invoices", &target, json!({"project_id":other_project}))
        .unwrap();
    issue(&store, &target, "2026-04-02").unwrap();
    let event = store
        .record_customer_credit_settlement(
            crate::customer_credit_settlements::CustomerCreditSettlementInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                credit_note_id: credit,
                event_type: "apply".into(),
                invoice_id: Some(target),
                date: "2026-04-03".into(),
                amount_cents: 1_000,
                bank_account_id: None,
                reference: "Compensation entre projets".into(),
                reason: "Accord du client pour déduction".into(),
            },
        )
        .unwrap();
    let id = event["settlement"]["id"].as_str().unwrap();
    let file = store
        .add_customer_credit_settlement_attachment(id, receipt())
        .unwrap();
    assert!(file["project_id"].is_null());
    let connection = store.connect().unwrap();
    assert!(connection.execute("INSERT INTO attachments(id,project_id,entity_type,entity_id,original_name,stored_name,mime_type,size_bytes,sha256,created_at,updated_at) SELECT ?,?,'customer_credit_settlement',entity_id,original_name,stored_name,mime_type,size_bytes,?,created_at,updated_at FROM attachments WHERE id=?",rusqlite::params![uuid::Uuid::new_v4().to_string(),project,"a".repeat(64),file["id"].as_str().unwrap()]).is_err());
}

#[test]
fn customer_receipt_is_deduplicated_verified_project_linked_and_retained_after_reversal() {
    let (_dir, store, _credit, event, project) = setup();
    let money = financial_snapshot(&store);
    let file = store
        .add_customer_credit_settlement_attachment(&event, receipt())
        .unwrap();
    let mut renamed = receipt();
    renamed.original_name = "copie.png".into();
    assert_eq!(
        store
            .add_customer_credit_settlement_attachment(&event, renamed)
            .unwrap()["id"],
        file["id"]
    );
    assert_eq!(file["project_id"], project);
    assert_eq!(financial_snapshot(&store), money);
    let connection = store.connect().unwrap();
    let id = file["id"].as_str().unwrap();
    assert!(connection
        .execute(
            "UPDATE attachments SET entity_type='project' WHERE id=?",
            [id]
        )
        .is_err());
    assert!(connection
        .execute("DELETE FROM attachments WHERE id=?", [id])
        .is_err());
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE entity_type='customer_credit_settlement'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    store
        .reverse_customer_credit_settlement(
            crate::customer_credit_settlements::ReverseCustomerCreditSettlementInput {
                request_id: uuid::Uuid::new_v4().to_string(),
                settlement_id: event.clone(),
                date: "2026-04-02".into(),
                reason: "Virement retourné par la banque".into(),
            },
        )
        .unwrap();
    let path = store.verified_attachment_path(id).unwrap();
    assert_eq!(
        std::fs::read(&path).unwrap(),
        STANDARD.decode(receipt().content_base64).unwrap()
    );
    assert!(!stored_files(&store)
        .iter()
        .any(|name| name.ends_with("attachment-part")));
    std::fs::write(path, b"modified").unwrap();
    assert!(store
        .add_customer_credit_settlement_attachment(&event, receipt())
        .is_err());
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE entity_type='customer_credit_settlement'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn customer_receipt_commit_failure_cleans_the_file_and_preserves_every_financial_row() {
    let (_dir, store, _credit, event, _project) = setup();
    let before = financial_snapshot(&store);
    let files = stored_files(&store);
    let connection = store.connect().unwrap();
    connection.execute_batch("CREATE TABLE qa_receipt_commit(id TEXT PRIMARY KEY,parent TEXT REFERENCES invoices(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER qa_receipt_fail AFTER INSERT ON attachments WHEN NEW.entity_type='customer_credit_settlement' BEGIN INSERT INTO qa_receipt_commit VALUES(NEW.id,'missing-invoice'); END;").unwrap();
    assert!(store
        .add_customer_credit_settlement_attachment(&event, receipt())
        .is_err());
    assert_eq!(stored_files(&store), files);
    assert_eq!(financial_snapshot(&store), before);
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE entity_type='customer_credit_settlement'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    connection
        .execute_batch("DROP TRIGGER qa_receipt_fail; DROP TABLE qa_receipt_commit;")
        .unwrap();
    let mut invalid = receipt();
    invalid.content_base64 = STANDARD.encode(b"not an image");
    assert!(store
        .add_customer_credit_settlement_attachment(&event, invalid)
        .is_err());
    assert!(store
        .add_customer_credit_settlement_attachment(&uuid::Uuid::new_v4().to_string(), receipt())
        .is_err());
    assert_eq!(stored_files(&store), files);
    assert_eq!(financial_snapshot(&store), before);
    assert!(store
        .add_customer_credit_settlement_attachment(&event, receipt())
        .is_ok());
}

#[test]
fn customer_receipt_and_settlements_survive_csv_closing_and_backup_restore() {
    let (dir, store, credit, event, project) = setup();
    let file = store
        .add_customer_credit_settlement_attachment(&event, receipt())
        .unwrap();
    let path = store
        .export_csv_archive(
            Some(
                dir.path()
                    .join("client.csv.zip")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let mut csv = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    for (name, expected) in [
        ("02_ventes/modeles_avoirs_clients.csv", credit.as_str()),
        ("02_ventes/reglements_avoirs_clients.csv", event.as_str()),
        (
            "02_ventes/ventilations_reglements_avoirs_clients.csv",
            event.as_str(),
        ),
        (
            "02_ventes/preuves_reglements_avoirs_clients.csv",
            event.as_str(),
        ),
        (
            "10_documents/index_pieces_jointes.csv",
            file["id"].as_str().unwrap(),
        ),
    ] {
        let mut contents = String::new();
        csv.by_name(name)
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        assert!(contents.contains(expected), "{name}: {contents}");
    }
    store
        .upsert_accounting_period(crate::models::AccountingPeriodInput {
            id: None,
            name: "Deuxième trimestre client".into(),
            date_from: "2026-04-01".into(),
            date_to: "2026-06-30".into(),
        })
        .unwrap();
    let review = store
        .prepare_fiduciary_pre_closing(crate::models::PeriodFilter {
            date_from: Some("2026-04-01".into()),
            date_to: Some("2026-06-30".into()),
        })
        .unwrap();
    assert_eq!(review["checks"]["attachments_total"], 1);
    assert_eq!(review["checks"]["attachments_verified"], 1);
    let closing = store
        .export_fiduciary_closing_zip(review["review_id"].as_str().unwrap(), "test")
        .unwrap();
    let mut closing =
        zip::ZipArchive::new(std::fs::File::open(closing["path"].as_str().unwrap()).unwrap())
            .unwrap();
    let mut index = String::new();
    closing
        .by_name("02_pieces/index_pieces.json")
        .unwrap()
        .read_to_string(&mut index)
        .unwrap();
    let index: Value = serde_json::from_str(&index).unwrap();
    assert_eq!(index["attachments"][0]["entity_id"], event);
    assert_eq!(index["attachments"][0]["project_id"], project);
    assert_eq!(index["attachments"][0]["integrity_valid"], true);
    assert_eq!(index["customer_credit_settlements"][0]["id"], event);
    assert_eq!(
        index["customer_credit_settlements"][0]["credit_note_id"],
        credit
    );
    assert_eq!(
        index["customer_credit_settlements"][0]["journal_proof_valid"],
        true
    );
    assert_eq!(
        index["customer_credit_settlement_lines"][0]["settlement_id"],
        event
    );
    for name in [
        "02_pieces/reglements_avoirs_clients.csv",
        "02_pieces/ventilations_avoirs_clients.csv",
    ] {
        let mut contents = String::new();
        closing
            .by_name(name)
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        assert!(contents.contains(&event));
    }
    let money = financial_snapshot(&store);
    let backup = store
        .create_backup(
            Some(
                dir.path()
                    .join("customer.zentra")
                    .to_string_lossy()
                    .into_owned(),
            ),
            "test",
        )
        .unwrap();
    let restored = LocalStore::initialize(dir.path().join("restored")).unwrap();
    restored.restore_backup(&backup, "test").unwrap();
    assert_eq!(financial_snapshot(&restored), money);
    let bytes = std::fs::read(
        restored
            .verified_attachment_path(file["id"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(bytes, STANDARD.decode(receipt().content_base64).unwrap());
    assert_eq!(
        restored.get_workspace().unwrap()["customer_credit_balances"][0]["remaining_cents"],
        2_702
    );
}
