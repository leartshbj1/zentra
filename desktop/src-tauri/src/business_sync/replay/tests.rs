use super::*;
use crate::business_sync::outgoing::Prepared;
use serde_json::json;
use uuid::Uuid;

pub(in crate::business_sync) fn copy_receiver(
    source: &LocalStore,
) -> (tempfile::TempDir, LocalStore) {
    let directory = tempfile::tempdir().unwrap();
    let receiver = LocalStore::initialize(directory.path().join("receiver")).unwrap();
    let c = source.connect().unwrap();
    let mut target = receiver.connect().unwrap();
    rusqlite::backup::Backup::new(&c, &mut target)
        .unwrap()
        .run_to_completion(256, Duration::from_millis(1), None)
        .unwrap();
    target
        .execute(
            "UPDATE business_sync_binding SET installation_id=?1,generation=?2 WHERE id=1",
            params![receiver.installation_id, Uuid::new_v4().to_string()],
        )
        .unwrap();
    drop(target);
    (directory, receiver)
}
fn rows(store: &LocalStore) -> Vec<(String, String, i64, String)> {
    let c = store.connect().unwrap();
    let mut result = Vec::new();
    for (table, rule) in policy().unwrap().tables {
        let mut q = c
            .prepare(&format!(
                "SELECT {},r.rowid,{} FROM {} r ORDER BY {}",
                json_key("r", &rule.key).unwrap(),
                json_image("r", &rule.columns).unwrap(),
                identifier(&table).unwrap(),
                json_key("r", &rule.key).unwrap()
            ))
            .unwrap();
        result.extend(
            q.query_map([], |r| Ok((table.clone(), r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap(),
        );
    }
    result
}
fn changes(prepared: &Prepared) -> Vec<RowChange> {
    prepared
        .manifest
        .chunks
        .iter()
        .enumerate()
        .flat_map(|(i, _)| {
            let contents: Value = serde_json::from_slice(
                &fs::read(prepared.folder.join(format!("{i:04}.json"))).unwrap(),
            )
            .unwrap();
            contents["changes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| RowChange {
                    table: c["table"].as_str().unwrap().into(),
                    key_json: c["key_json"].as_str().unwrap().into(),
                    before_json: c["before_json"].as_str().map(str::to_owned),
                    after_json: c["after_json"].as_str().map(str::to_owned),
                    // These fixtures share one base and no competing inserts, so the
                    // native source order is also the canonical order for this test.
                    canonical_rowid: c["source_rowid"].as_str().unwrap().parse().unwrap(),
                })
                .collect::<Vec<_>>()
        })
        .collect()
}
pub(in crate::business_sync) fn verify_candidate(
    receiver: &LocalStore,
    prepared: &Prepared,
    source_after: &LocalStore,
) {
    let before = rows(receiver);
    let candidate = build(
        receiver,
        &Context {
            fingerprint_version: STATE_FINGERPRINT_VERSION,
            organization: prepared.manifest.organization_id.clone(),
            generation: prepared.manifest.generation.clone(),
            base_revision: prepared.manifest.base_revision,
            source_state_sha256: state_fingerprint(&receiver.connect().unwrap()).unwrap(),
            target_state_sha256: state_fingerprint(&source_after.connect().unwrap()).unwrap(),
        },
        changes(prepared).into_iter().map(Ok),
    )
    .unwrap();
    assert_eq!(candidate.changes, prepared.manifest.change_count);
    assert_eq!(
        candidate.statements + candidate.automatic,
        candidate.changes
    );
    let actual = rows(&candidate.store);
    let expected = rows(source_after);
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(&expected) {
        assert!(
            actual == expected,
            "Shared row differs: {} {}",
            actual.0,
            actual.1
        );
    }
    assert_eq!(rows(receiver), before);
    assert_eq!(
        local_fingerprint(&candidate.store.connect().unwrap()).unwrap(),
        local_fingerprint(&receiver.connect().unwrap()).unwrap()
    );
    assert!(candidate.database_path().is_file());
    assert_ne!(candidate.before_sha256, candidate.after_sha256);
    assert_eq!(
        receiver
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM business_sync_changes", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

fn setup_with(before_bind: impl FnOnce(&LocalStore)) -> (tempfile::TempDir, LocalStore, Context) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    before_bind(&store);
    let generation = Uuid::new_v4().to_string();
    let bootstrap = Uuid::new_v4().to_string();
    let capture = Uuid::new_v4().to_string();
    let mut connection = store.connect().unwrap();
    let c = connection.transaction().unwrap();
    c.execute(
        "INSERT INTO business_sync_binding VALUES(1,'org-replay',?,?,1,'now')",
        params![store.installation_id, capture],
    )
    .unwrap();
    c.execute("INSERT INTO business_sync_baseline VALUES(1,'org-replay',?,?,?,'received','now')",params![generation,bootstrap,json!({"organization_id":"org-replay","generation":generation,"transfer_id":bootstrap,"revision":1}).to_string()]).unwrap();
    crate::business_sync::install_capture_triggers(&c).unwrap();
    c.commit().unwrap();
    let initial = state_fingerprint(&store.connect().unwrap()).unwrap();
    (
        directory,
        store,
        Context {
            fingerprint_version: STATE_FINGERPRINT_VERSION,
            organization: "org-replay".into(),
            generation,
            base_revision: 1,
            source_state_sha256: initial.clone(),
            target_state_sha256: initial,
        },
    )
}
fn setup() -> (tempfile::TempDir, LocalStore, Context) {
    setup_with(|_| {})
}
#[test]
#[ignore = "Explicit fictitious native database and outgoing transfer export for server delivery acceptance"]
fn export_native_canonical_delivery_fixture() {
    let path = std::path::PathBuf::from(std::env::var("ZENTRA_CANONICAL_DELIVERY_EXPORT").unwrap());
    fs::create_dir_all(&path).unwrap();
    assert!(!path.join("baseline.sqlite").exists());
    let (_directory, source, _) = setup();
    let data=rows(&source).into_iter().map(|(table,key,rowid,row)|json!({"table":table,"key_json":key,"source_rowid":rowid.to_string(),"row_json":row})).collect::<Vec<_>>();
    fs::write(
        path.join("source.json"),
        serde_json::to_vec_pretty(&data).unwrap(),
    )
    .unwrap();
    let mut copy = Connection::open(path.join("baseline.sqlite")).unwrap();
    rusqlite::backup::Backup::new(&source.connect().unwrap(), &mut copy)
        .unwrap()
        .run_to_completion(256, Duration::from_millis(1), None)
        .unwrap();
    drop(copy);
    source
        .create_record(
            "clients",
            json!({"name":"Client réception","notes":"Conditions\nAcompte 30 % 😀"}),
        )
        .unwrap();
    let prepared = crate::business_sync::outgoing::prepare_next(&source, "org-replay", "owner")
        .unwrap()
        .unwrap();
    fs::copy(
        prepared.folder.join("manifest.json"),
        path.join("manifest.json"),
    )
    .unwrap();
    for (index, _) in prepared.manifest.chunks.iter().enumerate() {
        fs::copy(
            prepared.folder.join(format!("{index:04}.json")),
            path.join(format!("{index:04}.json")),
        )
        .unwrap();
    }
}
#[test]
#[ignore = "Requires the exact delivery bundle exported by the real server acceptance test"]
fn receive_actual_server_canonical_delivery_on_native_candidate() {
    let path = std::path::PathBuf::from(std::env::var("ZENTRA_CANONICAL_DELIVERY_QA").unwrap());
    let proof: Value = serde_json::from_slice(&fs::read(path.join("proof.json")).unwrap()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let receiver = LocalStore::initialize(directory.path().join("receiver")).unwrap();
    let source = Connection::open(path.join("baseline.sqlite")).unwrap();
    let mut target = receiver.connect().unwrap();
    rusqlite::backup::Backup::new(&source, &mut target)
        .unwrap()
        .run_to_completion(256, Duration::from_millis(1), None)
        .unwrap();
    target.execute("UPDATE business_sync_binding SET organization_id=?1,installation_id=?2,generation=?3 WHERE id=1",params![proof["organization_id"].as_str().unwrap(),receiver.installation_id,Uuid::new_v4().to_string()]).unwrap();
    target
        .execute(
            "UPDATE business_sync_baseline SET organization_id=?1,server_generation=?2 WHERE id=1",
            params![
                proof["organization_id"].as_str().unwrap(),
                proof["generation"].as_str().unwrap()
            ],
        )
        .unwrap();
    drop(target);
    let expected = delivery::Expected {
        organization: proof["organization_id"].as_str().unwrap().into(),
        generation: proof["generation"].as_str().unwrap().into(),
        source_revision: proof["source_revision"].as_i64().unwrap(),
        bundle_sha256: proof["bundle_sha256"].as_str().unwrap().into(),
    };
    let bundle = fs::read(path.join("bundle.json")).unwrap();
    let manifest = fs::read(path.join("original-manifest.json")).unwrap();
    let raw = || {
        (0..proof["parts"].as_u64().unwrap())
            .map(|i| {
                (
                    fs::read(path.join(format!("changes-{i:04}.json"))).unwrap(),
                    fs::read(path.join(format!("positions-{i:04}.json"))).unwrap(),
                )
            })
            .collect::<Vec<_>>()
    };
    let before = rows(&receiver);
    let candidate = delivery::prepare_candidate(
        &receiver,
        &expected,
        &bundle,
        &manifest,
        raw().into_iter().map(Ok),
    )
    .unwrap();
    assert_eq!(
        candidate.after_sha256,
        proof["target_state_sha256"].as_str().unwrap()
    );
    let client_rowid: String = candidate
        .store
        .connect()
        .unwrap()
        .query_row(
            "SELECT CAST(rowid AS TEXT) FROM clients WHERE id=?1",
            [proof["client_id"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(client_rowid, proof["client_rowid"].as_str().unwrap());
    assert_ne!(client_rowid, proof["origin_rowid"].as_str().unwrap());
    drop(candidate);
    assert_eq!(rows(&receiver), before);
    for mode in ["missing", "extra", "altered"] {
        let mut parts = raw();
        if mode == "missing" {
            parts.pop();
        } else if mode == "extra" {
            parts.push(parts[0].clone());
        } else {
            parts[0].1[0] ^= 1;
        }
        assert!(
            delivery::prepare_candidate(
                &receiver,
                &expected,
                &bundle,
                &manifest,
                parts.into_iter().map(Ok)
            )
            .is_err(),
            "{mode}"
        );
        assert_eq!(rows(&receiver), before);
    }
}
#[test]
fn resumable_state_fingerprint_matches_independent_vectors() {
    let vector: Value =
        serde_json::from_str(include_str!("../../business_sync_state_hash_vectors.json")).unwrap();
    assert_eq!(vector["version"], STATE_FINGERPRINT_VERSION);
    let mut hash = StateFingerprint::new();
    assert_eq!(hash.hex(), vector["seed"].as_str().unwrap());
    for row in vector["rows"].as_array().unwrap() {
        let fields = row["fields"].as_array().unwrap();
        hash.row(std::array::from_fn(|i| fields[i].as_str().unwrap()));
        assert_eq!(hash.hex(), row["sha256"].as_str().unwrap());
        // Reconstructing from a saved chain head is enough to resume.
        hash = StateFingerprint(hash.0);
    }
}
#[test]
fn state_fingerprint_exports_native_sqlite_unicode_and_i64_rows() {
    let (_directory, store, _) = setup_with(|store| {
        let c = store.connect().unwrap();
        for i in 0..131 {
            let id = if i == 0 {
                "😀\u{e000}\0é".to_string()
            } else {
                format!("client-{i:03}")
            };
            let rowid = if i == 0 {
                i64::MIN
            } else if i == 130 {
                i64::MAX
            } else {
                i
            };
            c.execute("INSERT INTO clients(rowid,id,name,notes,created_at,updated_at) VALUES(?1,?2,'Client fictif',?3,'2026-09-09','2026-09-09')",params![rowid,id,"Conditions\nAcompte 30 %\nÉchéance 😀\0suite"]).unwrap();
        }
        c.execute("INSERT INTO catalog_items(id,kind,name,sales_price_cents,purchase_cost_cents,created_at,updated_at) VALUES('precise','service','Fictif',9223372036854775807,9007199254740993,'2026-09-09','2026-09-09')",[]).unwrap();
        c.execute("INSERT INTO quotes(id,title,created_at,updated_at) VALUES('decimal','Décimales','2026-09-09','2026-09-09')",[]).unwrap();
        for (i, quantity) in [0.0, 1.0, 1.25, 0.1, 0.0000001, 1.2345678901234567]
            .into_iter()
            .enumerate()
        {
            c.execute("INSERT INTO quote_items(id,quote_id,description,quantity,created_at,updated_at) VALUES(?1,'decimal','Quantité',?2,'2026-09-09','2026-09-09')",params![format!("decimal-{i}"),quantity]).unwrap();
        }
    });
    let data = rows(&store);
    let sha256 = state_fingerprint(&store.connect().unwrap()).unwrap();
    let mut hash = StateFingerprint::new();
    for (table, key, rowid, image) in &data {
        hash.row([table, key, &rowid.to_string(), image]);
    }
    assert_eq!(sha256, hash.hex());
    if let Ok(path) = std::env::var("ZENTRA_STATE_FINGERPRINT_QA") {
        let rows = data.into_iter().map(|(table,key,rowid,image)| json!({"table":table,"key_json":key,"source_rowid":rowid.to_string(),"row_json":image})).collect::<Vec<_>>();
        fs::write(
            path,
            serde_json::to_vec_pretty(
                &json!({"version":STATE_FINGERPRINT_VERSION,"sha256":sha256,"rows":rows}),
            )
            .unwrap(),
        )
        .unwrap();
    }
}
#[test]
fn replay_rejects_unrecognized_fingerprint_version() {
    let (_directory, store, mut context) = setup();
    let original = rows(&store);
    for version in [0, 1, 3, u32::MAX] {
        context.fingerprint_version = version;
        let error = build(&store, &context, std::iter::empty()).err().unwrap();
        assert!(
            error.to_string().contains("version de vérification"),
            "{error}"
        );
    }
    assert_eq!(rows(&store), original);
}
fn expected_hash(store: &LocalStore, changes: &[RowChange]) -> String {
    let mut data = rows(store)
        .into_iter()
        .map(|(table, key, rowid, image)| ((table, key), (rowid, image)))
        .collect::<std::collections::BTreeMap<_, _>>();
    for change in changes {
        let key = (change.table.clone(), change.key_json.clone());
        if let Some(after) = &change.after_json {
            let normalized = normalize(
                &store.connect().unwrap(),
                &policy().unwrap().tables[&change.table],
                &change.key_json,
                after,
            )
            .unwrap();
            data.insert(key, (change.canonical_rowid, normalized));
        } else {
            data.remove(&key);
        }
    }
    let mut hash = StateFingerprint::new();
    for ((table, key), (rowid, image)) in data {
        hash.row([&table, &key, &rowid.to_string(), &image]);
    }
    hash.hex()
}
fn update_row(store: &LocalStore, table: &str, id: &str, field: &str, value: &str) -> RowChange {
    let rule = &policy().unwrap().tables[table];
    let c = store.connect().unwrap();
    let key = json!([id]).to_string();
    let (rowid, before) = current(&c, table, rule, &key).unwrap().unwrap();
    let after = c
        .query_row(
            &format!("SELECT json_set(?1,'$.{field}',?2)"),
            params![before, value],
            |r| r.get(0),
        )
        .unwrap();
    RowChange {
        table: table.into(),
        key_json: key,
        before_json: Some(before),
        after_json: Some(after),
        canonical_rowid: rowid,
    }
}

#[test]
fn rejects_wrong_state_hashes_and_duplicate_fields_before_native_application() {
    let (_directory, store, mut context) = setup();
    let baseline = rows(&store);
    let make = || RowChange {
        table: "clients".into(),
        key_json: "[\"remote\"]".into(),
        before_json: None,
        after_json: Some(client("remote", "Remote")),
        canonical_rowid: 42,
    };
    context.target_state_sha256 = expected_hash(&store, &[make()]);
    let original = context.source_state_sha256.clone();
    context.source_state_sha256 = "0".repeat(64);
    assert!(build(&store, &context, [Ok(make())]).is_err());
    context.source_state_sha256 = original;
    let target = context.target_state_sha256.clone();
    context.target_state_sha256 = "0".repeat(64);
    assert!(build(&store, &context, [Ok(make())]).is_err());
    context.target_state_sha256 = target;
    let mut duplicate = make();
    duplicate.after_json = Some(duplicate.after_json.unwrap().replacen(
        '{',
        "{\"id\":\"remote\",",
        1,
    ));
    assert!(build(&store, &context, [Ok(duplicate)]).is_err());
    assert_eq!(rows(&store), baseline);
}

#[test]
fn native_issued_invoice_guard_remains_effective_even_with_matching_state_hashes() {
    let mut id = String::new();
    let (_directory, store, mut context) = setup_with(|store| {
        store.install_swiss_accounting_starter().unwrap();
        let client=store.create_record("clients",json!({"name":"Client","address_line1":"Route 1","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap();
        let invoice=store.save_document_with_items(crate::models::SaveDocumentWithItemsInput {entity:"invoices".into(),id:None,data:json!({"client_id":client["id"],"title":"Prestation","currency":"CHF","service_date_from":"2026-09-08","service_date_to":"2026-09-08"}),items:vec![json!({"description":"Service","quantity":1,"unit":"forfait","unit_price_cents":10000,"discount_bp":0,"vat_bp":0})]}).unwrap();
        id = invoice["document"]["id"].as_str().unwrap().into();
        store
            .issue_invoice(&id, Some("2026-09-08".into()), None)
            .unwrap();
    });
    let before = rows(&store);
    let change = update_row(&store, "invoices", &id, "title", "Reecriture interdite");
    context.target_state_sha256 = expected_hash(&store, std::slice::from_ref(&change));
    let error = build(&store, &context, [Ok(change)]).err().unwrap();
    assert!(
        matches!(error, AppError::Database(_)),
        "Expected the native SQLite protection, got {error}"
    );
    assert_eq!(rows(&store), before);
}

#[test]
fn local_timer_prevents_closing_or_deleting_a_remote_task_and_is_never_replaced() {
    let mut id = String::new();
    let (_directory, store, mut context) = setup_with(|store| {
        let project = store
            .create_record("projects", json!({"name":"Projet"}))
            .unwrap();
        let task = store
            .save_project_task(crate::models::SaveProjectTaskInput {
                id: None,
                project_id: project["id"].as_str().unwrap().into(),
                milestone_id: None,
                title: "Intervention".into(),
                description: None,
                due_date: None,
                priority: None,
                sort_order: None,
                employee_id: None,
            })
            .unwrap();
        id = task["id"].as_str().unwrap().into();
        store.connect().unwrap().execute("INSERT INTO active_timers(id,project_id,task_id,started_at,note) VALUES(1,?1,?2,'2026-09-09T08:00:00Z','Travail local')",params![project["id"].as_str().unwrap(),id]).unwrap();
    });
    let before = rows(&store);
    let timer = store.get_active_timer().unwrap();
    let change = update_row(&store, "project_tasks", &id, "status", "done");
    context.target_state_sha256 = expected_hash(&store, std::slice::from_ref(&change));
    let error = build(&store, &context, [Ok(change)]).err().unwrap();
    assert!(
        error.to_string().contains("task has an active timer"),
        "{error}"
    );
    let mut deletion = update_row(&store, "project_tasks", &id, "title", "Unused");
    deletion.after_json = None;
    context.target_state_sha256 = expected_hash(&store, std::slice::from_ref(&deletion));
    let error = build(&store, &context, [Ok(deletion)])
        .err()
        .expect("A remote deletion must not detach the local timer");
    assert!(
        error.to_string().contains("données propres à cet appareil"),
        "{error}"
    );
    assert_eq!(rows(&store), before);
    assert_eq!(store.get_active_timer().unwrap(), timer);
}

pub(in crate::business_sync) fn verify_missing_stock_effect(
    receiver: &LocalStore,
    prepared: &Prepared,
) {
    let mut context = Context {
        fingerprint_version: STATE_FINGERPRINT_VERSION,
        organization: prepared.manifest.organization_id.clone(),
        generation: prepared.manifest.generation.clone(),
        base_revision: prepared.manifest.base_revision,
        source_state_sha256: state_fingerprint(&receiver.connect().unwrap()).unwrap(),
        target_state_sha256: String::new(),
    };
    let incomplete = changes(prepared)
        .into_iter()
        .filter(|c| c.table != "catalog_items")
        .collect::<Vec<_>>();
    context.target_state_sha256 = expected_hash(receiver, &incomplete);
    let before = rows(receiver);
    let error = build(receiver, &context, incomplete.into_iter().map(Ok))
        .err()
        .unwrap();
    assert!(
        error.to_string().contains("absente de la transaction"),
        "Unexpected rejection: {error}"
    );
    assert_eq!(rows(receiver), before);
}
fn client(id: &str, name: &str) -> String {
    let rule = &policy().unwrap().tables["clients"];
    let mut values = serde_json::Map::new();
    for c in &rule.columns {
        values.insert(c.clone(), Value::Null);
    }
    for (key, value) in [
        ("id", id),
        ("name", name),
        ("country", "CH"),
        ("created_at", "2026-09-09"),
        ("updated_at", "2026-09-09"),
    ] {
        values.insert(key.into(), json!(value));
    }
    values.insert("archived".into(), json!(0));
    // Retain exactly the current shared columns, including native defaults.
    values.retain(|key, _| rule.columns.contains(key));
    Value::Object(values).to_string()
}
#[test]
fn refuses_wrong_context_and_pending_local_work_without_touching_the_profile() {
    let (_directory, store, mut context) = setup();
    let before = rows(&store);
    context.base_revision = 2;
    assert!(build(&store, &context, std::iter::empty()).is_err());
    assert_eq!(rows(&store), before);
    context.base_revision = 1;
    store
        .create_record("clients", json!({"name":"Local draft"}))
        .unwrap();
    let local = rows(&store);
    assert!(build(&store, &context, std::iter::empty()).is_err());
    assert_eq!(rows(&store), local);
}
#[test]
fn candidate_insert_is_isolated_and_discarded_on_drop() {
    let (_directory, store, mut context) = setup();
    let before = rows(&store);
    let change = RowChange {
        table: "clients".into(),
        key_json: "[\"remote\"]".into(),
        before_json: None,
        after_json: Some(client("remote", "Remote client")),
        canonical_rowid: 42,
    };
    let (_oracle_directory, oracle) = copy_receiver(&store);
    oracle.connect().unwrap().execute("INSERT INTO clients(rowid,id,name,country,created_at,updated_at) VALUES(42,'remote','Remote client','CH','2026-09-09','2026-09-09')",[]).unwrap();
    context.target_state_sha256 = state_fingerprint(&oracle.connect().unwrap()).unwrap();
    let candidate = build(&store, &context, [Ok(change)]).unwrap();
    assert_eq!(candidate.statements, 1);
    assert_eq!(candidate.automatic, 0);
    let path = candidate.database_path().to_path_buf();
    assert!(path.exists());
    assert_eq!(rows(&store), before);
    drop(candidate);
    assert!(!path.exists());
    assert_eq!(rows(&store), before);
}

#[test]
fn native_project_document_changes_preserve_transport_queue_without_echo() {
    use crate::project_documents::AddProjectDocumentInput;
    use base64::{engine::general_purpose::STANDARD, Engine};
    for deleting in [false, true] {
        let mut project_id = String::new();
        let mut document_id = String::new();
        let (_directory, source, _) = setup_with(|store| {
            let project = store
                .create_record("projects", json!({"name":"Projet documents"}))
                .unwrap();
            project_id = project["id"].as_str().unwrap().into();
            let document = store
                .add_project_document(AddProjectDocumentInput {
                    project_id: project_id.clone(),
                    original_name: "notes.txt".into(),
                    content_base64: STANDARD.encode(b"Notes du projet"),
                })
                .unwrap();
            document_id = document["id"].as_str().unwrap().into();
            // Retain sparse rowids and retry metadata as well as queue content.
            store.connect().unwrap().execute("UPDATE project_document_sync SET rowid=91,attempts=4,last_error='Connexion interrompue' WHERE document_id=?1", [&document_id]).unwrap();
        });
        let (_receiver_directory, receiver) = copy_receiver(&source);
        if deleting {
            source.delete_project_document(&document_id).unwrap();
        } else {
            source
                .add_project_document(AddProjectDocumentInput {
                    project_id,
                    original_name: "conditions.txt".into(),
                    content_base64: STANDARD.encode("Conditions\nAcompte à la commande".as_bytes()),
                })
                .unwrap();
        }
        let prepared = crate::business_sync::outgoing::prepare_next(&source, "org-replay", "owner")
            .unwrap()
            .unwrap();
        verify_candidate(&receiver, &prepared, &source);
        assert_ne!(
            local_fingerprint(&source.connect().unwrap()).unwrap(),
            local_fingerprint(&receiver.connect().unwrap()).unwrap()
        );
        // This only verifies metadata replay. Installing the content still
        // requires the file hashes and the canonical receipt transport.
        assert!(!prepared.manifest.files.is_empty());
    }
}
