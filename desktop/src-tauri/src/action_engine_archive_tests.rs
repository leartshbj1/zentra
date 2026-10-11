//! Real ZIP/SQLite compatibility fixtures, never production company data.
use super::*;
use crate::action_engine_quote::{
    ActionEngineQuoteActor, ActionEngineQuoteInput, ActionEngineQuoteSource,
};
use crate::action_engine_resources::{article_revision, customer_revision, export_resources, resource_hash};
use sha2::{Digest, Sha256};

#[path = "action_engine_license_fixture_tests.rs"]
mod test_license;

const ORG: &str = "synthetic-action-company";
const SNAPSHOT: &str = "52bbc724-29c0-4760-9a3b-6c4d529050bb";
const CLIENT: &str = "257968c5-fb8b-498a-92fe-7a86165ccc97";
const ARTICLE: &str = "827a1da0-508f-402f-8acf-677cb070bc0c";
const OWNER: &str = "synthetic-action-owner";
const PROPOSAL: &str = "b8390cc3-1907-4580-855c-a0a66eac5b33";
const RESERVATION: &str = "a045d94e-09cc-4fe5-9728-3fd06045c0ca";
const QUOTE: &str = "f2875368-8d48-42ed-8883-5b9406e20fdc";
const PLANNING_SNAPSHOT: &str = "db759b49-d4dd-48f8-94fd-4aac53df9739";
const PUBLICATION: &str = "b459d94e-134a-4df1-a3b8-88c3478b92ba";

// Declaration order matches captureQuotePlan in the real TypeScript reader.
// A serde_json::Value would sort keys and change the original plan fingerprint.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalFixturePlan<'a> {
    schema_version: u8,
    engine_version: &'a str,
    kind: &'a str,
    organization_id: &'a str,
    context_revision: &'a str,
    source_id: &'a str,
    source_revision: &'a str,
    status: &'a str,
    reasons: Vec<&'a str>,
    customer: CanonicalFixtureCustomer<'a>,
    title: &'a str,
    currency: &'a str,
    lines: Vec<CanonicalFixtureLine<'a>>,
    net_cents: i64,
    confidence: f64,
    requires_human_validation: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalFixtureCustomer<'a> {
    kind: &'a str,
    id: &'a str,
    revision: &'a str,
    name: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalFixtureLine<'a> {
    article_id: &'a str,
    article_revision: &'a str,
    description: &'a str,
    unit: &'a str,
    quantity_milli: i64,
    unit_price_cents: i64,
    tax_rate_bp: i64,
    net_cents: i64,
    evidence: &'a str,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn quote_input(store: &LocalStore) -> ActionEngineQuoteInput {
    let db = store.connect().unwrap();
    db.execute("INSERT INTO company_local_identity VALUES(1,?,?,'Synthetic owner','owner')", params![ORG, OWNER]).unwrap();
    db.execute("UPDATE settings SET vat_registered=1,default_vat_bp=810 WHERE id=1", []).unwrap();
    let resources = export_resources(&db).unwrap();
    let customer = &resources.customers[0];
    let article = &resources.articles[0];
    let customer_revision = customer_revision(customer);
    let article_revision = article_revision(article);
    let source = ActionEngineQuoteSource {
        id: "synthetic-archive-mail".into(),
        revision: "synthetic-archive-mail-v1".into(),
        organization_id: ORG.into(),
        sender_email: "client@example.test".into(),
        sender_name: customer.name.clone(),
        subject: "Devis «Léman» 🚀".into(),
        body: "Installer 1.25 radiateurs Léman.\nValidation humaine requise.".into(),
    };
    let canonical_plan_json = serde_json::to_string(&CanonicalFixturePlan {
        schema_version: 1,
        engine_version: "action-engine-quote-v1",
        kind: "prepare_quote_draft",
        organization_id: ORG,
        context_revision: "synthetic-archive-context-v1",
        source_id: &source.id,
        source_revision: &source.revision,
        status: "ready",
        reasons: vec![],
        customer: CanonicalFixtureCustomer {
            kind: "existing", id: CLIENT, revision: &customer_revision, name: &customer.name,
        },
        title: &source.subject,
        currency: "CHF",
        lines: vec![CanonicalFixtureLine {
            article_id: ARTICLE, article_revision: &article_revision,
            description: &article.name, unit: &article.unit,
            quantity_milli: 1250, unit_price_cents: 12345, tax_rate_bp: 810,
            net_cents: 15431, evidence: "1.25 radiateurs Léman",
        }],
        net_cents: 15431,
        confidence: 0.99,
        requires_human_validation: true,
    }).unwrap();
    ActionEngineQuoteInput {
        fingerprint: hash(canonical_plan_json.as_bytes()),
        canonical_plan_json,
        proposal_id: PROPOSAL.into(),
        reservation_id: RESERVATION.into(),
        source,
        actor: ActionEngineQuoteActor { organization_id: ORG.into(), user_id: OWNER.into() },
        installation_id: store.installation_id.clone(),
        expected_workspace_scope: crate::work_notes::workspace_scope(&db).unwrap(),
        expected_member_context_nonce: crate::member_context::read(&db).unwrap(),
        expected_resources_hash: resource_hash(&resources),
        expected_context_revision: "synthetic-archive-context-v1".into(),
        customer_id: CLIENT.into(),
        quote_id: QUOTE.into(),
    }
}

fn fixture() -> (tempfile::TempDir, LocalStore) {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    let db = store.connect().unwrap();
    db.execute("INSERT INTO clients(id,name,email,created_at,updated_at) VALUES(?,?,?,'2026-10-11T10:00:00+00:00','2026-10-11T10:00:00+00:00')",
        params![CLIENT, "Équipe 🚀 \"Léman\"", "client@example.test"]).unwrap();
    db.execute("INSERT INTO catalog_items(id,kind,sku,name,description,unit,sales_price_cents,vat_bp,created_at,updated_at) VALUES(?,'service',NULL,?,?, 'pièce',12345,810,'2026-10-11T10:00:00+00:00','2026-10-11T10:00:00+00:00')",
        params![ARTICLE,"Radiateur Léman", "Installation\nDeuxième ligne \\ U+2028: \u{2028}"]).unwrap();
    drop(db);
    (temporary, store)
}

fn archive(store: &LocalStore, path: &Path) {
    store
        .create_collaboration_backup_at(path, env!("CARGO_PKG_VERSION"), ORG, SNAPSHOT, 7)
        .unwrap();
}
fn manifest(zip: &mut ZipArchive<File>) -> BackupManifest {
    serde_json::from_reader(zip.by_name("manifest.json").unwrap()).unwrap()
}

#[test]
fn action_archive_has_positional_stored_projection_of_the_actual_frozen_database() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let (temporary, mut store) = fixture();
    test_license::configure(&mut store);
    test_license::install(&store);
    let request = quote_input(&store);
    // Both manifests describe actual local archives. The committed publication
    // context below is explicitly synthetic; no PostgreSQL authority is claimed.
    let planning_path = temporary.path().join("synthetic-planning.zentra");
    store.create_collaboration_backup_at(&planning_path, env!("CARGO_PKG_VERSION"), ORG, PLANNING_SNAPSHOT, 6).unwrap();
    let planning_manifest = crate::cloud_backup::file_manifest(&planning_path).unwrap();
    let planning_manifest_json = serde_json::to_string(&planning_manifest).unwrap();
    let reservation_created_at = chrono::Utc::now().timestamp();
    let receipt = store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let path = temporary.path().join("synthetic.zentra");
    archive(&store, &path);
    let publication_created_at = chrono::Utc::now().timestamp();
    // A subsequent live edit cannot alter either frozen projection or SQLite.
    store.connect().unwrap().execute("UPDATE catalog_items SET sales_price_cents=54321,updated_at='2026-10-11T10:01:00+00:00' WHERE id=?",[ARTICLE]).unwrap();
    let mut zip = ZipArchive::new(File::open(&path).unwrap()).unwrap();
    assert_eq!(zip.by_index(0).unwrap().name(), "manifest.json");
    assert_eq!(
        zip.by_index(0).unwrap().compression(),
        CompressionMethod::Stored
    );
    assert_eq!(
        zip.by_index(1).unwrap().name(),
        "automation/resources.v1.json"
    );
    assert_eq!(
        zip.by_index(1).unwrap().compression(),
        CompressionMethod::Stored
    );
    let metadata = manifest(&mut zip);
    let descriptor = metadata.action_engine_resources.unwrap();
    let mut bytes = Vec::new();
    zip.by_index(1).unwrap().read_to_end(&mut bytes).unwrap();
    assert_eq!(descriptor.size_bytes, bytes.len());
    assert_eq!(descriptor.sha256, format!("{:x}", Sha256::digest(&bytes)));
    assert_eq!(
        (descriptor.customer_count, descriptor.article_count),
        (1, 1)
    );
    let sidecar: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(sidecar["organizationId"], ORG);
    assert_eq!(sidecar["snapshotId"], SNAPSHOT);
    assert_eq!(sidecar["baseRevision"], 7);
    assert_eq!(sidecar["schemaVersion"], 62);
    assert_eq!(sidecar["resources"]["articles"][0]["unitPriceCents"], 12345);
    let db_path = temporary.path().join("frozen.sqlite3");
    {
        let mut file = File::create(&db_path).unwrap();
        io::copy(&mut zip.by_name(DATABASE_ENTRY).unwrap(), &mut file).unwrap();
    }
    let frozen = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let resources = crate::action_engine_resources::export_resources(&frozen).unwrap();
    assert_eq!(
        sidecar["resourcesHash"],
        crate::action_engine_resources::resource_hash(&resources)
    );
    assert_ne!(
        crate::action_engine_resources::resource_hash(&resources),
        crate::action_engine_resources::resource_hash(
            &crate::action_engine_resources::export_resources(&store.connect().unwrap()).unwrap()
        )
    );
    for (table, expected) in [("clients", 1), ("quotes", 1), ("quote_items", 1), ("action_engine_quote_receipts", 1), ("company_local_action_engine_quote_outbox", 0)] {
        assert_eq!(frozen.query_row::<i64, _, _>(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap(), expected);
    }
    let customer: (String, String) = frozen.query_row("SELECT name,email FROM clients WHERE id=?", [CLIENT], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(customer, (request.source.sender_name.clone(), request.source.sender_email.clone()));
    let quote: (String, Option<String>, String, String, i64, i64, i64) = frozen.query_row(
        "SELECT client_id,number,status,title,subtotal_cents,vat_cents,total_cents FROM quotes WHERE id=?", [QUOTE],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))).unwrap();
    assert_eq!(quote, (CLIENT.into(), None, "brouillon".into(), request.source.subject.clone(), 15431, 1250, 16681));
    let line: (String, f64, i64, i64, i64, i64, i64) = frozen.query_row(
        "SELECT catalog_item_id,quantity,unit_price_cents,vat_bp,line_net_cents,line_vat_cents,line_total_cents FROM quote_items WHERE quote_id=?", [QUOTE],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))).unwrap();
    assert_eq!(line, (ARTICLE.into(), 1.25, 12345, 810, 15431, 1250, 16681));
    let receipt_json = serde_json::to_string(&receipt).unwrap();
    let stored_receipt: (String, String, String) = frozen.query_row(
        "SELECT plan_json,receipt_json,receipt_sha256 FROM action_engine_quote_receipts WHERE organization_id=? AND proposal_id=?",
        params![ORG, PROPOSAL], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
    assert_eq!(stored_receipt, (request.canonical_plan_json.clone(), receipt_json.clone(), hash(receipt_json.as_bytes())));
    let audits = query_all(&frozen, "SELECT payload_json FROM audit_log WHERE action='create' AND entity_type='action_engine_quote' AND entity_id=?", [QUOTE]).unwrap();
    assert_eq!(audits.len(), 1);
    let payload: Value = serde_json::from_str(audits[0]["payload_json"].as_str().unwrap()).unwrap();
    let creation_json = payload["creationJson"].as_str().unwrap();
    let creation: Value = serde_json::from_str(creation_json).unwrap();
    let source_canonical_json = serde_json::to_string(&request.source).unwrap();
    assert_eq!(payload["receipt"], serde_json::to_value(&receipt).unwrap());
    assert_eq!(payload["creationSha256"], hash(creation_json.as_bytes()));
    assert_eq!(creation["sourceCanonicalSha256"], hash(source_canonical_json.as_bytes()));
    assert_eq!(creation["customer"]["id"], CLIENT);
    assert_eq!(creation["quote"]["id"], QUOTE);
    assert_eq!(creation["quote"]["totalCents"], 16681);
    assert_eq!(creation["lines"].as_array().unwrap().len(), 1);
    assert_eq!(creation["lines"][0]["quantityMilli"], 1250);
    assert_eq!(crate::audit::verify_audit_chain(&frozen).unwrap()["valid"], true);

    // Full interoperability evidence has a separate, test-only directory gate.
    // Export only after all frozen business, receipt and audit assertions pass.
    if let Some(output) = std::env::var_os("ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE") {
        let output = PathBuf::from(output);
        fs::create_dir_all(&output).unwrap();
        let full_archive = fs::read(&path).unwrap();
        let transport_manifest = crate::cloud_backup::file_manifest(&path).unwrap();
        let transport_manifest_json = serde_json::to_string(&transport_manifest).unwrap();
        assert_eq!(transport_manifest.sha256, hash(&full_archive));
        assert_eq!(transport_manifest.size_bytes, full_archive.len() as u64);
        let metadata = json!({
            "format": "zentra-action-quote-archive-fixture", "schemaVersion": 1,
            "synthetic": true, "nativeFixture": true,
            "sourceCommit": option_env!("CIRCLE_SHA1"),
            "appVersion": env!("CARGO_PKG_VERSION"), "nativeSchemaVersion": SCHEMA_VERSION,
            "publicationContext": "synthetic_committed_no_remote_authority",
            "archiveFile": "synthetic-quote.zentra",
            "archiveSha256": transport_manifest.sha256, "archiveSizeBytes": transport_manifest.size_bytes,
            "origin": {"organizationId": ORG, "snapshotId": SNAPSHOT, "baseRevision": 7, "archiveSha256": transport_manifest.sha256},
            "canonicalPlanJson": request.canonical_plan_json,
            "sourceCanonicalJson": source_canonical_json,
            "proposal": {"id": PROPOSAL, "organizationId": ORG, "fingerprint": request.fingerprint,
                "plan": serde_json::from_str::<Value>(&request.canonical_plan_json).unwrap()},
            "reservation": {"id": RESERVATION, "organizationId": ORG, "proposalId": PROPOSAL,
                "fingerprint": request.fingerprint, "userId": OWNER, "installationId": request.installation_id,
                "customerId": CLIENT, "quoteId": QUOTE, "createdAt": reservation_created_at, "receipt": null},
            "binding": {"resourcesSha256": request.expected_resources_hash,
                "sourceCanonicalSha256": hash(source_canonical_json.as_bytes()),
                "planningPublication": {"organizationId": ORG, "snapshotId": PLANNING_SNAPSHOT,
                    "baseRevision": 6, "revision": 7, "archiveSha256": planning_manifest.sha256,
                    "manifestSha256": hash(planning_manifest_json.as_bytes())}},
            "publication": {"id": PUBLICATION, "organizationId": ORG, "snapshotId": SNAPSHOT,
                "installationId": request.installation_id, "userId": OWNER, "baseRevision": 7,
                "archiveSha256": transport_manifest.sha256, "manifestSha256": hash(transport_manifest_json.as_bytes()),
                "sizeBytes": transport_manifest.size_bytes, "state": "committed",
                "result": {"committed": true, "revision": 8, "snapshotId": SNAPSHOT},
                "createdAt": publication_created_at, "settledAt": publication_created_at},
            "receipt": receipt,
            "transportManifestJson": transport_manifest_json,
            "planningTransportManifestJson": planning_manifest_json,
        });
        fs::write(output.join("synthetic-quote.zentra"), &full_archive).unwrap();
        fs::write(output.join("synthetic-quote-metadata.json"), serde_json::to_vec_pretty(&metadata).unwrap()).unwrap();
    }
    // Optional evidence for the TypeScript codec: generated by this real native
    // writer from this synthetic fixture, not a handwritten ZIP approximation.
    if let Some(output) = std::env::var_os("ZENTRA_ACTION_PREFIX_EVIDENCE") {
        let output = PathBuf::from(output);
        fs::create_dir_all(output.parent().unwrap()).unwrap();
        let mut prefix = fs::read(&path).unwrap();
        prefix.truncate(8 * 1024 * 1024);
        fs::write(output, prefix).unwrap();
    }
}

#[test]
fn action_archive_restores_with_the_existing_restore_path_and_no_projection_reader() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let (temporary, store) = fixture();
    let path = temporary.path().join("compatible.zentra");
    archive(&store, &path);
    let target_dir = tempfile::tempdir().unwrap();
    let target = LocalStore::initialize(target_dir.path().join("target")).unwrap();
    target
        .restore_backup(path.to_str().unwrap(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    let db = target.connect().unwrap();
    assert_eq!(
        db.query_row::<String, _, _>("SELECT name FROM clients WHERE id=?", [CLIENT], |r| r
            .get(0))
            .unwrap(),
        "Équipe 🚀 \"Léman\""
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT sales_price_cents FROM catalog_items WHERE id=?",
            [ARTICLE],
            |r| r.get(0)
        )
        .unwrap(),
        12345
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT COUNT(*) FROM company_local_action_engine_quote_outbox",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn unavailable_action_projection_does_not_block_existing_company_archives_or_restore() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let (temporary, store) = fixture();
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE catalog_items SET sales_price_cents=1000000001 WHERE id=?",
            [ARTICLE],
        )
        .unwrap();
    let path = temporary.path().join("unavailable.zentra");
    archive(&store, &path);
    let mut zip = ZipArchive::new(File::open(&path).unwrap()).unwrap();
    assert!(manifest(&mut zip).action_engine_resources.is_none());
    assert!(zip.by_name("automation/resources.v1.json").is_err());
    let target_dir = tempfile::tempdir().unwrap();
    let target = LocalStore::initialize(target_dir.path().into()).unwrap();
    target
        .restore_backup(path.to_str().unwrap(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    assert_eq!(
        target
            .connect()
            .unwrap()
            .query_row::<i64, _, _>(
                "SELECT sales_price_cents FROM catalog_items WHERE id=?",
                [ARTICLE],
                |r| r.get(0)
            )
            .unwrap(),
        1000000001
    );
}

#[test]
fn manual_backup_keeps_its_existing_format_without_action_projection() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let (temporary, store) = fixture();
    let path = temporary.path().join("manual.zentra");
    store
        .create_backup_at(&path, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let mut zip = ZipArchive::new(File::open(path).unwrap()).unwrap();
    assert!(manifest(&mut zip).action_engine_resources.is_none());
    assert!(zip.by_name("automation/resources.v1.json").is_err());
}
