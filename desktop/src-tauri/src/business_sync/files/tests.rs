use super::*;
use crate::{database::LocalStore, project_documents::AddProjectDocumentInput};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::params;
use serde_json::json;
use uuid::Uuid;

fn fixture(enabled: bool) -> (tempfile::TempDir, LocalStore, String) {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    let project = Uuid::new_v4().to_string();
    let connection = store.connect().unwrap();
    connection.execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Recette fichiers','2026-09-08','2026-09-08')", []).unwrap();
    connection.execute("INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,'Projet fictif','2026-09-08','2026-09-08')", [&project]).unwrap();
    if enabled {
        capture(&store);
    }
    (temporary, store, project)
}

fn capture(store: &LocalStore) {
    let mut connection = store.connect().unwrap();
    let transaction = connection.transaction().unwrap();
    transaction
        .execute(
            "INSERT INTO business_sync_binding VALUES(1,'org-file-qa',?,?,1,'2026-09-08')",
            params![store.installation_id, Uuid::new_v4().to_string()],
        )
        .unwrap();
    super::super::install_capture_triggers(&transaction).unwrap();
    transaction.commit().unwrap();
}

#[test]
fn deleting_a_document_created_before_capture_seals_its_bytes_first() {
    let (_temporary, store, project) = fixture(false);
    let bytes = b"Document historique";
    let document = add(&store, &project, bytes).unwrap();
    assert!(!blob(&store, bytes).exists());
    capture(&store);
    store
        .delete_project_document(document["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(fs::read(blob(&store, bytes)).unwrap(), bytes);
    assert_eq!(images(&store).len(), 1);
}

#[test]
fn prepared_supplier_attachment_keeps_bytes_after_transaction_and_deletion() {
    let (_temporary, store, _project) = fixture(true);
    let supplier = Uuid::new_v4().to_string();
    let invoice = Uuid::new_v4().to_string();
    let connection = store.connect().unwrap();
    connection.execute("INSERT INTO suppliers(id,name,created_at,updated_at) VALUES(?,'Fournisseur fictif','2026-09-08','2026-09-08')", [&supplier]).unwrap();
    connection.execute("INSERT INTO supplier_invoices(id,supplier_id,document_date,due_date,supplier_name,created_at,updated_at) VALUES(?,?,'2026-09-08','2026-09-08','Fournisseur fictif','2026-09-08','2026-09-08')", params![invoice,supplier]).unwrap();
    let bytes = crate::attachments::test_pdf_bytes();
    let attachment = store
        .add_supplier_invoice_attachment_bytes(&invoice, "justificatif.pdf", &bytes)
        .unwrap();
    assert_eq!(fs::read(blob(&store, &bytes)).unwrap(), bytes);
    store
        .delete_supplier_invoice_attachment(attachment["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(fs::read(blob(&store, &bytes)).unwrap(), bytes);
    for image in images(&store) {
        retain_image(&store.data_dir, "attachments", &image).unwrap();
    }
}

fn add(store: &LocalStore, project: &str, content: &[u8]) -> AppResult<Value> {
    store.add_project_document(AddProjectDocumentInput {
        project_id: project.into(),
        original_name: "plan.txt".into(),
        content_base64: STANDARD.encode(content),
    })
}

fn blob(store: &LocalStore, bytes: &[u8]) -> PathBuf {
    store
        .attachments_dir
        .join(DIRECTORY)
        .join("blobs")
        .join(digest(bytes))
}

fn images(store: &LocalStore) -> Vec<String> {
    let connection = store.connect().unwrap();
    let mut statement = connection.prepare("SELECT before_json FROM business_sync_changes WHERE table_name='attachments' AND before_json IS NOT NULL UNION SELECT after_json FROM business_sync_changes WHERE table_name='attachments' AND after_json IS NOT NULL").unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn project_add_delete_and_restart_retain_committed_bytes_and_exact_row_images() {
    let (_temporary, store, project) = fixture(true);
    let bytes = "Plan provisoire\nConditions en français 🏗️".as_bytes();
    let document = add(&store, &project, bytes).unwrap();
    store
        .delete_project_document(document["id"].as_str().unwrap())
        .unwrap();
    assert!(!store
        .attachments_dir
        .join(document["stored_name"].as_str().unwrap())
        .exists());
    let store = LocalStore::initialize(store.data_dir.clone()).unwrap();
    assert_eq!(fs::read(blob(&store, bytes)).unwrap(), bytes);
    let images = images(&store);
    assert_eq!(images.len(), 1);
    retain_image(&store.data_dir, "attachments", &images[0]).unwrap();
    assert_eq!(
        super::super::status(&store.connect().unwrap()).unwrap()["pending_transactions"],
        2
    );
}

#[test]
fn replacing_a_document_preserves_both_versions_without_mutating_its_identity() {
    let (_temporary, store, project) = fixture(true);
    let old = b"Version initiale";
    let new = b"Version corrigee";
    let document = add(&store, &project, old).unwrap();
    // Content metadata is immutable. Replacement creates a new attachment.
    let replacement = add(&store, &project, new).unwrap();
    assert_ne!(replacement["id"], document["id"]);
    // A later external change cannot rewrite the already captured old version.
    fs::write(
        store
            .attachments_dir
            .join(document["stored_name"].as_str().unwrap()),
        b"external change",
    )
    .unwrap();
    store
        .delete_project_document(document["id"].as_str().unwrap())
        .unwrap();
    store
        .delete_project_document(replacement["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(fs::read(blob(&store, old)).unwrap(), old);
    assert_eq!(fs::read(blob(&store, new)).unwrap(), new);
    assert_eq!(images(&store).len(), 2);
    for image in images(&store) {
        retain_image(&store.data_dir, "attachments", &image).unwrap();
    }
}

#[test]
fn a_failed_cache_write_rolls_back_attachment_audit_and_journal() {
    let (_temporary, store, project) = fixture(true);
    // Simulate an inaccessible cache without depending on the OS account's ACLs.
    fs::write(store.attachments_dir.join(DIRECTORY), b"blocked").unwrap();
    assert!(add(&store, &project, b"No committed orphan").is_err());
    let connection = store.connect().unwrap();
    for table in ["attachments", "audit_log", "business_sync_changes"] {
        assert_eq!(
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn rollback_and_savepoints_do_not_make_retained_orphans_sendable() {
    let (_temporary, store, _project) = fixture(true);
    let path = store.attachments_dir.join("rolled-back.txt");
    fs::write(&path, b"version abandonnee").unwrap();
    let connection = store.connect().unwrap();
    connection
        .execute_batch("BEGIN; SAVEPOINT document;")
        .unwrap();
    connection.execute("INSERT INTO attachments(id,original_name,stored_name,size_bytes,sha256,created_at,updated_at) VALUES('rolled-back','x','rolled-back.txt',?,?, '2026-09-08','2026-09-08')",
        params![19, digest(b"version abandonnee")]).unwrap_err();
    // A wrong registered size must fail before the row and journal can commit.
    connection.execute("INSERT INTO attachments(id,original_name,stored_name,size_bytes,sha256,created_at,updated_at) VALUES('rolled-back','x','rolled-back.txt',?,?, '2026-09-08','2026-09-08')",
        params![b"version abandonnee".len() as i64, digest(b"version abandonnee")]).unwrap();
    connection
        .execute_batch("ROLLBACK TO document; RELEASE document; COMMIT;")
        .unwrap();
    assert!(blob(&store, b"version abandonnee").exists());
    assert!(images(&store).is_empty());
    assert_eq!(
        super::super::status(&connection).unwrap()["pending_transactions"],
        0
    );
}

#[test]
fn corrupt_or_missing_retained_bytes_block_deletion_without_rebuilding_evidence() {
    for missing in [false, true] {
        let (_temporary, store, project) = fixture(true);
        let bytes = b"Version a conserver";
        let document = add(&store, &project, bytes).unwrap();
        if missing {
            fs::remove_file(blob(&store, bytes)).unwrap();
        } else {
            fs::write(blob(&store, bytes), b"tampered").unwrap();
        }
        assert!(store
            .delete_project_document(document["id"].as_str().unwrap())
            .is_err());
        assert!(store
            .attachments_dir
            .join(document["stored_name"].as_str().unwrap())
            .exists());
        assert_eq!(
            super::super::status(&store.connect().unwrap()).unwrap()["pending_transactions"],
            1
        );
    }
}

#[test]
fn ordinary_profiles_do_not_create_pending_storage() {
    let (_temporary, store, project) = fixture(false);
    let document = add(&store, &project, b"Document local").unwrap();
    store
        .delete_project_document(document["id"].as_str().unwrap())
        .unwrap();
    assert!(!store.attachments_dir.join(DIRECTORY).exists());
    assert!(images(&store).is_empty());
}

#[test]
fn full_backup_restores_deleted_pending_files_but_keeps_replication_detached() {
    let (temporary, store, project) = fixture(true);
    let bytes = b"Document conserve dans la sauvegarde";
    let document = add(&store, &project, bytes).unwrap();
    store
        .delete_project_document(document["id"].as_str().unwrap())
        .unwrap();
    let archive = store
        .create_backup(None, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let target = LocalStore::initialize(temporary.path().join("restored")).unwrap();
    target
        .restore_backup(&archive, env!("CARGO_PKG_VERSION"))
        .unwrap();
    assert_eq!(fs::read(blob(&target, bytes)).unwrap(), bytes);
    assert_eq!(images(&target), images(&store));
    for image in images(&target) {
        retain_image(&target.data_dir, "attachments", &image).unwrap();
    }
    assert_eq!(
        super::super::status(&target.connect().unwrap()).unwrap()["state"],
        "needs_reconciliation"
    );
}

#[test]
fn portable_file_classification_preserves_export_bytes_without_confusing_manifest_hashes() {
    let (_temporary, store, _project) = fixture(false);
    fs::create_dir(store.attachments_dir.join("payroll-imports")).unwrap();
    fs::create_dir(store.attachments_dir.join("branding")).unwrap();
    for (table, row, root, path, bytes) in [
        (
            "payroll_document_imports",
            json!({"stored_path":"C:\\ancien-pc\\attachments\\payroll-imports\\fiche.pdf", "file_sha256":digest(b"payroll"), "file_size":7}),
            "attachments",
            "payroll-imports/fiche.pdf",
            b"payroll".as_slice(),
        ),
        (
            "company_brand_assets",
            json!({"file_name":"logo.png", "sha256":digest(b"logo"), "byte_size":4}),
            "attachments",
            "branding/logo.png",
            b"logo".as_slice(),
        ),
        (
            "settings",
            json!({"logo_path":"/ancien-mac/downloads/logo.png"}),
            "attachments",
            "branding/logo.png",
            b"logo".as_slice(),
        ),
        (
            "vat_return_exports",
            json!({"file_name":"tva.xml", "xml_sha256":digest(b"xml")}),
            "exports",
            "tva.xml",
            b"xml".as_slice(),
        ),
        (
            "closing_package_exports",
            json!({"file_name":"cloture.zip", "manifest_sha256":digest(b"inner manifest")}),
            "exports",
            "cloture.zip",
            b"ZIP content".as_slice(),
        ),
    ] {
        fs::write(store.data_dir.join(root).join(path), bytes).unwrap();
        let image = row.to_string();
        retain_image(&store.data_dir, table, &image).unwrap();
        fs::remove_file(store.data_dir.join(root).join(path)).unwrap();
        retain_image(&store.data_dir, table, &image).unwrap();
        assert_eq!(fs::read(blob(&store, bytes)).unwrap(), bytes);
    }
}

#[test]
fn unsafe_paths_and_false_hashes_cannot_write_a_receipt() {
    let (_temporary, store, _project) = fixture(false);
    for path in [
        "../secret",
        "/elsewhere/file",
        "C:\\secret",
        "branding/../secret",
        "CON.txt",
        ".business-sync-pending/blobs/x",
    ] {
        let row = json!({"stored_name":path,"size_bytes":0,"sha256":digest(b"")});
        assert!(
            retain_image(&store.data_dir, "attachments", &row.to_string()).is_err(),
            "{path}"
        );
    }
    let row = json!({"file_name":"false.xml","xml_sha256":digest(b"expected")});
    fs::write(store.exports_dir.join("false.xml"), b"different").unwrap();
    assert!(retain_image(&store.data_dir, "vat_return_exports", &row.to_string()).is_err());
    assert_eq!(
        fs::read_dir(store.attachments_dir.join(DIRECTORY).join("references"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn damaged_receipt_is_rejected_even_while_original_file_still_exists() {
    let (_temporary, store, project) = fixture(true);
    let document = add(&store, &project, b"Proof").unwrap();
    let image = images(&store).remove(0);
    let path = store
        .attachments_dir
        .join(DIRECTORY)
        .join("references")
        .join(format!("{}.json", receipt_key("attachments", &image)));
    fs::write(&path, br#"{"version":2}"#).unwrap();
    assert!(store
        .delete_project_document(document["id"].as_str().unwrap())
        .is_err());
}

#[test]
fn old_development_capture_with_unretained_changes_requires_reconciliation() {
    let (_temporary, store, _project) = fixture(true);
    let connection = store.connect().unwrap();
    connection.execute_batch("DROP TRIGGER zentra_sync_attachments_insert;
        CREATE TRIGGER zentra_sync_attachments_insert AFTER INSERT ON attachments BEGIN SELECT 1; END;").unwrap();
    connection.execute("INSERT INTO business_sync_changes(generation,transaction_id,organization_id,installation_id,table_name,row_key_json,operation,after_json) SELECT generation,'old-change',organization_id,installation_id,'attachments','[\"old-file\"]','insert','{}' FROM business_sync_binding", []).unwrap();
    let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
    assert_eq!(
        super::super::status(&reopened.connect().unwrap()).unwrap()["state"],
        "needs_reconciliation"
    );
    assert_eq!(images(&reopened), vec!["{}"]);
}

#[test]
fn old_development_triggers_without_file_changes_upgrade_and_capture_normally() {
    let (_temporary, store, project) = fixture(true);
    store.connect().unwrap().execute_batch("DROP TRIGGER zentra_sync_attachments_insert;
        CREATE TRIGGER zentra_sync_attachments_insert AFTER INSERT ON attachments BEGIN SELECT 1; END;").unwrap();
    let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
    add(&reopened, &project, b"new capture").unwrap();
    assert_eq!(
        fs::read(blob(&reopened, b"new capture")).unwrap(),
        b"new capture"
    );
    assert_eq!(
        super::super::status(&reopened.connect().unwrap()).unwrap()["state"],
        "capturing"
    );
}
