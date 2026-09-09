use super::*;
use rusqlite::Connection;
use serde_json::json;

#[path = "accounting_transition_tests.rs"]
mod accounting_transitions;
#[path = "operational_transition_tests.rs"]
mod operational_transitions;

pub(super) fn setup() -> (tempfile::TempDir, LocalStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    (directory, store)
}
pub(super) fn bind(store: &LocalStore) {
    let mut c = store.connect().unwrap();
    let tx = c.transaction().unwrap();
    let generation = Uuid::new_v4().to_string();
    let capture = Uuid::new_v4().to_string();
    let source = Uuid::new_v4().to_string();
    let receipt = json!({"organization_id":"org-outgoing","generation":generation,"transfer_id":source,"revision":1});
    tx.execute(
        "INSERT INTO business_sync_binding VALUES(1,'org-outgoing',?,?,1,'2026-09-08')",
        params![store.installation_id, capture],
    )
    .unwrap();
    tx.execute("INSERT INTO business_sync_baseline VALUES(1,'org-outgoing',?,?,?,'published','2026-09-08')",params![generation,source,receipt.to_string()]).unwrap();
    super::super::install_capture_triggers(&tx).unwrap();
    tx.commit().unwrap();
}
pub(super) fn client(c: &Connection, id: &str, notes: &str) {
    c.execute("INSERT INTO clients(id,name,notes,created_at,updated_at) VALUES(?,'Client fictif',?,'2026-09-08','2026-09-08')",params![id,notes]).unwrap();
}
fn all(p: &Prepared) -> Vec<Value> {
    p.manifest
        .chunks
        .iter()
        .enumerate()
        .flat_map(|(i, _)| {
            let v: Value =
                serde_json::from_slice(&fs::read(p.folder.join(format!("{i:04}.json"))).unwrap())
                    .unwrap();
            v["changes"].as_array().unwrap().clone()
        })
        .collect()
}
pub(super) fn next(store: &LocalStore) -> Prepared {
    prepare_next(store, "org-outgoing", "owner")
        .unwrap()
        .unwrap()
}

#[test]
fn exact_images_order_and_original_revision_survive_deletion_and_restart() {
    let (_directory, store) = setup();
    bind(&store);
    let c = store.connect().unwrap();
    c.execute_batch("BEGIN").unwrap();
    c.execute("INSERT INTO clients(rowid,id,name,notes,created_at,updated_at) VALUES(9007199254740993,'a','Client','Ligne 1\nLigne 2','x','x')",[]).unwrap();
    c.execute(
        "UPDATE clients SET notes=? WHERE id='a'",
        ["Conditions\nL’acompte 🏗️\nC:\\dossier"],
    )
    .unwrap();
    c.execute("DELETE FROM clients WHERE id='a'", []).unwrap();
    assert!(prepare_next(&store, "org-outgoing", "owner")
        .unwrap()
        .is_none());
    c.execute_batch("COMMIT").unwrap();
    c.execute("INSERT INTO business_sync_cursor SELECT 1,organization_id,server_generation,4 FROM business_sync_baseline",[]).unwrap();
    let p = next(&store);
    let changes = all(&p);
    assert_eq!(p.manifest.base_revision, 1);
    assert_eq!(changes.len(), 3);
    assert!(changes
        .iter()
        .all(|v| v["source_rowid"] == "9007199254740993"));
    assert_eq!(changes[0]["after_json"], changes[1]["before_json"]);
    assert_eq!(changes[1]["after_json"], changes[2]["before_json"]);
    assert!(changes[2]["after_json"].is_null());
    let originals: Vec<(Option<String>, Option<String>)> = c
        .prepare("SELECT before_json,after_json FROM business_sync_changes ORDER BY sequence")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for (change, (before, after)) in changes.iter().zip(originals) {
        assert_eq!(change["before_json"], json!(before));
        assert_eq!(change["after_json"], json!(after));
    }
    assert_eq!(p.manifest.schema_version, 60);
    let descriptor_before = fs::read(p.folder.join("manifest.json")).unwrap();
    crate::document_parent_tests::restore_v60_guards(&c);
    let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
    assert_eq!(next(&reopened).manifest, p.manifest);
    assert_eq!(
        fs::read(p.folder.join("manifest.json")).unwrap(),
        descriptor_before
    );
    assert_eq!(
        super::super::status(&reopened.connect().unwrap()).unwrap()["pending_transactions"],
        1
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM business_sync_receipts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn large_operations_are_bounded_and_a_corrupt_cached_chunk_is_never_replaced() {
    let (_directory, store) = setup();
    bind(&store);
    let c = store.connect().unwrap();
    c.execute_batch("BEGIN").unwrap();
    for i in 0..601 {
        client(&c, &format!("c-{i}"), "Notes\nDeuxième ligne");
    }
    c.execute_batch("COMMIT").unwrap();
    let p = next(&store);
    assert_eq!(p.manifest.chunks.len(), 4);
    assert_eq!(p.manifest.change_count, 601);
    assert!(p
        .manifest
        .chunks
        .iter()
        .all(|c| c.change_count <= 200 && c.size_bytes <= CHUNK_BYTES as u64));
    let chunk = p.folder.join("0000.json");
    fs::write(&chunk, b"altered").unwrap();
    assert!(prepare_next(&store, "org-outgoing", "owner").is_err());
    assert_eq!(fs::read(&chunk).unwrap(), b"altered");
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM business_sync_changes", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        601
    );
}

#[test]
fn business_row_position_cannot_change_and_unpublished_or_foreign_work_is_not_sent() {
    let (_directory, store) = setup();
    assert!(prepare_next(&store, "org-outgoing", "owner")
        .unwrap()
        .is_none());
    bind(&store);
    let c = store.connect().unwrap();
    client(&c, "one", "");
    assert!(c
        .execute("UPDATE clients SET rowid=rowid+100 WHERE id='one'", [])
        .is_err());
    assert!(prepare_next(&store, "org-other", "owner").is_err());
    assert!(prepare_next(&store, "org-outgoing", "read_only").is_err());
    super::super::detach_restored_copy(&c).unwrap();
    assert!(prepare_next(&store, "org-outgoing", "owner").is_err());
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM business_sync_changes", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn an_old_unknown_position_is_preserved_and_requires_reconciliation() {
    let (_directory, store) = setup();
    bind(&store);
    let c = store.connect().unwrap();
    c.execute_batch("DROP TRIGGER zentra_sync_clients_insert")
        .unwrap();
    client(&c, "legacy", "");
    let image: String = c
        .query_row(
            "SELECT json_object('id',id,'name',name) FROM clients WHERE id='legacy'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    c.execute("INSERT INTO business_sync_changes(generation,transaction_id,organization_id,installation_id,table_name,row_key_json,operation,after_json,base_revision) SELECT generation,?,organization_id,installation_id,'clients','[\"legacy\"]','insert',?,1 FROM business_sync_binding",params![Uuid::new_v4().to_string(),image]).unwrap();
    let error = prepare_next(&store, "org-outgoing", "owner")
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("ordre d’origine"));
    assert!(c
        .query_row("SELECT source_rowid FROM business_sync_changes", [], |r| {
            r.get::<_, Option<String>>(0)
        })
        .unwrap()
        .is_none());
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM clients WHERE id='legacy'", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        1
    );
}

#[test]
fn deleted_documents_use_retained_bytes_and_missing_proofs_are_not_reconstructed() {
    let (_directory, store) = setup();
    bind(&store);
    let c = store.connect().unwrap();
    let content = b"Plan original";
    fs::write(store.attachments_dir.join("plan.txt"), content).unwrap();
    c.execute_batch("BEGIN").unwrap();
    c.execute("INSERT INTO attachments(id,original_name,stored_name,size_bytes,sha256,created_at,updated_at) VALUES('doc','plan.txt','plan.txt',?,?,'x','x')",params![content.len() as i64,digest(content)]).unwrap();
    c.execute("DELETE FROM attachments WHERE id='doc'", [])
        .unwrap();
    c.execute_batch("COMMIT").unwrap();
    fs::remove_file(store.attachments_dir.join("plan.txt")).unwrap();
    let p = next(&store);
    assert_eq!(
        p.manifest.files,
        vec![Blob {
            sha256: digest(content),
            size_bytes: content.len() as u64
        }]
    );
    let changes = all(&p);
    assert_eq!(changes[0]["files_after"], changes[1]["files_before"]);
    let refs = store
        .attachments_dir
        .join(files::DIRECTORY)
        .join("references");
    for entry in fs::read_dir(&refs).unwrap() {
        fs::remove_file(entry.unwrap().path()).unwrap();
    }
    fs::write(store.attachments_dir.join("plan.txt"), content).unwrap();
    assert!(prepare_next(&store, "org-outgoing", "owner").is_err());
    assert_eq!(fs::read_dir(refs).unwrap().count(), 0);
}

#[test]
fn a_real_payment_keeps_its_invoice_posting_lines_and_audit_in_one_envelope() {
    use crate::models::{RecordPaymentInput, SaveDocumentWithItemsInput};
    let (_directory, store) = setup();
    store.install_swiss_accounting_starter().unwrap();
    let client=store.create_record("clients",json!({"name":"Client fictif","address_line1":"Rue du Client","address_line2":"7","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap();
    let saved=store.save_document_with_items(SaveDocumentWithItemsInput{entity:"invoices".into(),id:None,data:json!({"client_id":client["id"],"title":"Recette","service_date_from":"2026-09-08","service_date_to":"2026-09-08","currency":"CHF"}),items:vec![json!({"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":100_000,"discount_bp":0,"vat_bp":0})]}).unwrap();
    let invoice = saved["document"]["id"].as_str().unwrap();
    store
        .issue_invoice(invoice, Some("2026-09-08".into()), None)
        .unwrap();
    bind(&store);
    let payment = RecordPaymentInput {
        request_id: Uuid::new_v4().to_string(),
        invoice_id: invoice.into(),
        amount_cents: 30_000,
        date: Some("2026-09-08".into()),
        method: Some("Banque".into()),
        reference: None,
        notes: Some("Paiement partiel\nFiduciaire".into()),
    };
    store.record_payment(payment.clone()).unwrap();
    let p = next(&store);
    let rows = all(&p);
    for table in [
        "invoices",
        "payments",
        "journal_entries",
        "journal_lines",
        "audit_log",
    ] {
        assert!(rows.iter().any(|r| r["table"] == table), "{table}");
    }
    let lines: Vec<Value> = rows
        .iter()
        .filter(|r| r["table"] == "journal_lines" && r["operation"] == "insert")
        .map(|r| serde_json::from_str(r["after_json"].as_str().unwrap()).unwrap())
        .collect();
    assert_eq!(
        lines
            .iter()
            .map(|r| r["debit_cents"].as_i64().unwrap())
            .sum::<i64>(),
        30_000
    );
    assert_eq!(
        lines
            .iter()
            .map(|r| r["credit_cents"].as_i64().unwrap())
            .sum::<i64>(),
        30_000
    );
    store.record_payment(payment).unwrap();
    assert_eq!(next(&store).manifest, p.manifest);
    assert_eq!(
        super::super::status(&store.connect().unwrap()).unwrap()["pending_transactions"],
        1
    );
}

#[test]
fn native_document_emission_preserves_original_intermediate_images() {
    use crate::models::SaveDocumentWithItemsInput;
    let output = std::env::var("ZENTRA_DOCUMENT_TRANSITION_OUTPUT")
        .ok()
        .map(PathBuf::from);
    if let Some(output) = &output {
        fs::create_dir(output).unwrap();
    }
    for entity in ["invoices", "quotes"] {
        let (_directory, store) = setup();
        store.install_swiss_accounting_starter().unwrap();
        let client=store.create_record("clients",json!({"name":"Client fictif","address_line1":"Rue du Client","address_line2":"7","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap();
        let mut data =
            json!({"client_id":client["id"],"title":"Emission hors ligne","currency":"CHF"});
        if entity == "invoices" {
            data["service_date_from"] = json!("2026-09-08");
            data["service_date_to"] = json!("2026-09-08");
        }
        let saved=store.save_document_with_items(SaveDocumentWithItemsInput{entity:entity.into(),id:None,data,items:vec![json!({"description":"Prestation","quantity":1,"unit":"forfait","unit_price_cents":100_000,"discount_bp":0,"vat_bp":0})]}).unwrap();
        let id = saved["document"]["id"].as_str().unwrap();
        let mut source = Vec::new();
        let c = store.connect().unwrap();
        for (table, rule) in super::super::policy().unwrap().tables {
            let sql = format!(
                "SELECT {},{},CAST(rowid AS TEXT) FROM {} r ORDER BY rowid",
                super::super::json_key("r", &rule.key).unwrap(),
                super::super::json_image("r", &rule.columns).unwrap(),
                super::super::identifier(&table).unwrap()
            );
            let mut query = c.prepare(&sql).unwrap();
            let rows = query
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .unwrap();
            for row in rows {
                let (key, image, rowid) = row.unwrap();
                source.push(
                    json!({"table":table,"key_json":key,"row_json":image,"source_rowid":rowid}),
                );
            }
        }
        drop(c);
        bind(&store);
        let (_receiver_directory, receiver) =
            crate::business_sync::replay::tests::copy_receiver(&store);
        if entity == "invoices" {
            store
                .issue_invoice(id, Some("2026-09-08".into()), None)
                .unwrap();
        } else {
            store
                .issue_quote(id, Some("2026-09-08".into()), Some("2026-10-08".into()))
                .unwrap();
        }
        let p = next(&store);
        crate::business_sync::replay::tests::verify_candidate(&receiver, &p, &store);
        let changes = all(&p);
        assert!(changes.iter().any(|c| c["table"] == entity
            && c["operation"] == "update"
            && serde_json::from_str::<Value>(c["before_json"].as_str().unwrap()).unwrap()
                ["number"]
                .is_null()
            && serde_json::from_str::<Value>(c["after_json"].as_str().unwrap()).unwrap()
                ["number"]
                .is_string()));
        if let Some(output) = &output {
            let directory = output.join(entity);
            fs::create_dir(&directory).unwrap();
            fs::write(
                directory.join("source.json"),
                serde_json::to_vec(&source).unwrap(),
            )
            .unwrap();
            fs::write(
                directory.join("manifest.json"),
                serde_json::to_vec(&p.manifest).unwrap(),
            )
            .unwrap();
            for (index, _) in p.manifest.chunks.iter().enumerate() {
                fs::copy(
                    p.folder.join(format!("{index:04}.json")),
                    directory.join(format!("{index:04}.json")),
                )
                .unwrap();
            }
        }
    }
}
