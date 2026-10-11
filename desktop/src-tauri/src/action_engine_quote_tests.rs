//! Actual LocalStore/SQLite transactions. These synthetic private inputs are
//! not evidence of a remote reservation, Automation entitlement or IPC route.
use super::*;
use crate::database::query_all;
use serde_json::Value;

struct Fixture {
    directory: tempfile::TempDir,
    store: LocalStore,
    client_id: String,
    article_id: String,
}
fn fixture(existing: bool) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    let client_id = Uuid::new_v4().to_string();
    let article_id = Uuid::new_v4().to_string();
    let db = store.connect().unwrap();
    db.execute("INSERT INTO company_local_identity VALUES(1,'company-a','owner-a','Synthetic owner','owner')", []).unwrap();
    db.execute("UPDATE settings SET vat_registered=1,default_vat_bp=810,updated_at='2026-10-11T00:00:00Z' WHERE id=1", []).unwrap();
    if existing {
        db.execute("INSERT INTO clients(id,name,email,created_at,updated_at) VALUES(?,'Camille Exemple','camille@example.ch','2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')", [&client_id]).unwrap();
    }
    db.execute("INSERT INTO catalog_items(id,kind,sku,name,description,unit,sales_price_cents,vat_bp,created_at,updated_at)
        VALUES(?,'product','RAD-A','Radiateur','radiateurs','pièce',19900,810,'2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')", [&article_id]).unwrap();
    drop(db);
    Fixture {
        directory,
        store,
        client_id,
        article_id,
    }
}
fn input(f: &Fixture, existing: bool) -> ActionEngineQuoteInput {
    let db = f.store.connect().unwrap();
    let resources = export_resources(&db).unwrap();
    let customer = if existing {
        let customer = resources
            .customers
            .iter()
            .find(|customer| customer.id == f.client_id)
            .unwrap();
        json!({"kind":"existing","id":f.client_id,"revision":customer_revision(customer),"name":"Camille Exemple"})
    } else {
        json!({"kind":"new","name":"Camille Exemple","email":"camille@example.ch"})
    };
    let plan = json!({
        "schemaVersion":1,"engineVersion":"action-engine-quote-v1","kind":"prepare_quote_draft",
        "organizationId":"company-a","contextRevision":"qa-publication-source-v1","sourceId":"ticket-a","sourceRevision":"mail-v1",
        "status":"ready","reasons":[],"customer":customer,"title":"Devis radiateurs","currency":"CHF",
        "lines":[{"articleId":f.article_id,"articleRevision":article_revision(&resources.articles[0]),"description":"Radiateur","unit":"pièce",
            "quantityMilli":3000,"unitPriceCents":19900,"taxRateBp":810,"netCents":59700,"evidence":"3 radiateurs"}],
        "netCents":59700,"confidence":0.99,"requiresHumanValidation":true
    });
    let canonical_plan_json = serde_json::to_string(&plan).unwrap();
    ActionEngineQuoteInput {
        fingerprint: sha(canonical_plan_json.as_bytes()),
        canonical_plan_json,
        proposal_id: Uuid::new_v4().to_string(),
        reservation_id: Uuid::new_v4().to_string(),
        source: ActionEngineQuoteSource {
            id: "ticket-a".into(),
            revision: "mail-v1".into(),
            organization_id: "company-a".into(),
            sender_email: "camille@example.ch".into(),
            sender_name: "Camille Exemple".into(),
            subject: "Devis radiateurs".into(),
            body: "3 radiateurs".into(),
        },
        actor: ActionEngineQuoteActor {
            organization_id: "company-a".into(),
            user_id: "owner-a".into(),
        },
        installation_id: f.store.installation_id.clone(),
        expected_workspace_scope: crate::work_notes::workspace_scope(&db).unwrap(),
        expected_member_context_nonce: crate::member_context::read(&db).unwrap(),
        expected_resources_hash: resource_hash(&resources),
        expected_context_revision: "qa-publication-source-v1".into(),
        customer_id: f.client_id.clone(),
        quote_id: Uuid::new_v4().to_string(),
    }
}
fn change_plan(input: &mut ActionEngineQuoteInput, update: impl FnOnce(&mut Value)) {
    let mut plan: Value = serde_json::from_str(&input.canonical_plan_json).unwrap();
    update(&mut plan);
    input.canonical_plan_json = serde_json::to_string(&plan).unwrap();
    input.fingerprint = sha(input.canonical_plan_json.as_bytes());
}
fn snapshot(store: &LocalStore) -> Value {
    let db = store.connect().unwrap();
    let mut result = serde_json::Map::new();
    for table in [
        "clients",
        "quotes",
        "quote_items",
        "invoices",
        "invoice_items",
        "payments",
        "journal_entries",
        "journal_lines",
        "stock_movements",
        "stock_reservation_events",
        "device_number_ranges",
        "document_creators",
        "audit_log",
        "company_local_clock",
        "action_engine_quote_receipts",
        "company_local_action_engine_quote_outbox",
    ] {
        result.insert(
            table.into(),
            json!(query_all(&db, &format!("SELECT * FROM {table} ORDER BY 1,2"), []).unwrap()),
        );
    }
    Value::Object(result)
}
fn fresh_origin(store: &LocalStore, input: &mut ActionEngineQuoteInput) {
    let db = store.connect().unwrap();
    input.expected_workspace_scope = crate::work_notes::workspace_scope(&db).unwrap();
    input.expected_member_context_nonce = crate::member_context::read(&db).unwrap();
}
fn refuses(store: &LocalStore, input: ActionEngineQuoteInput, code: &str) {
    let before = snapshot(store);
    assert!(store
        .commit_action_engine_quote_draft(input)
        .unwrap_err()
        .to_string()
        .contains(&format!("action_engine:{code}")));
    assert_eq!(snapshot(store), before);
}

#[test]
fn existing_customer_and_unnumbered_draft_lines_receipt_audit_outbox_commit_together_once() {
    let f = fixture(true);
    let request = input(&f, true);
    let expected_line_id = line_id(&request, 0);
    let before = snapshot(&f.store);
    let original = f
        .store
        .commit_action_engine_quote_draft(request.clone())
        .unwrap();
    let committed = snapshot(&f.store);
    assert_eq!(original.customer_id, f.client_id);
    assert_eq!(original.quote_id, request.quote_id);
    assert_eq!(original.quote_number, None);
    assert_eq!(original.status, "draft");
    assert!(original.requires_human_validation);
    assert_eq!(
        f.store.commit_action_engine_quote_draft(request).unwrap(),
        original
    );
    assert_eq!(snapshot(&f.store), committed);
    assert_eq!(committed["clients"].as_array().unwrap().len(), 1);
    assert_eq!(committed["quotes"].as_array().unwrap().len(), 1);
    assert_eq!(committed["quotes"][0]["status"], "brouillon");
    assert!(committed["quotes"][0]["number"].is_null());
    assert_eq!(committed["quotes"][0]["subtotal_cents"], 59700);
    assert_eq!(committed["quotes"][0]["vat_cents"], 4836);
    assert_eq!(committed["quotes"][0]["total_cents"], 64536);
    assert_eq!(committed["quote_items"][0]["line_net_cents"], 59700);
    assert_eq!(committed["quote_items"][0]["id"], expected_line_id);
    let issued = chrono::NaiveDate::parse_from_str(
        committed["quotes"][0]["issue_date"].as_str().unwrap(),
        "%Y-%m-%d",
    )
    .unwrap();
    let valid = chrono::NaiveDate::parse_from_str(
        committed["quotes"][0]["valid_until"].as_str().unwrap(),
        "%Y-%m-%d",
    )
    .unwrap();
    assert_eq!(valid.signed_duration_since(issued).num_days(), 30);
    assert_eq!(
        committed["action_engine_quote_receipts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        committed["company_local_action_engine_quote_outbox"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(committed["document_creators"][0]["user_id"], "owner-a");
    assert_eq!(
        committed["document_creators"][0]["document_id"],
        original.quote_id
    );
    for table in [
        "invoices",
        "invoice_items",
        "payments",
        "journal_entries",
        "journal_lines",
        "stock_movements",
        "stock_reservation_events",
        "device_number_ranges",
    ] {
        assert_eq!(
            committed[table], before[table],
            "unrelated effect in {table}"
        );
    }
    assert_eq!(f.store.verify_audit_log().unwrap()["valid"], true);
    let payload = committed["company_local_action_engine_quote_outbox"][0]["payload_json"]
        .as_str()
        .unwrap();
    for private in [
        "Camille",
        "camille@",
        "radiateurs",
        "19900",
        "sender",
        "ownerToken",
        "memberContext",
        "workspaceScope",
    ] {
        assert!(
            !payload.contains(private),
            "private value in outbox: {private}"
        );
    }
}

#[test]
fn new_customer_uses_only_approved_header_identity_and_reserved_ids() {
    let f = fixture(false);
    let request = input(&f, false);
    let result = f
        .store
        .commit_action_engine_quote_draft(request.clone())
        .unwrap();
    assert_eq!(result.customer_id, request.customer_id);
    assert_eq!(result.quote_id, request.quote_id);
    let rows = snapshot(&f.store);
    assert_eq!(rows["clients"][0]["name"], "Camille Exemple");
    assert_eq!(rows["clients"][0]["email"], "camille@example.ch");
    assert_eq!(rows["clients"].as_array().unwrap().len(), 1);
    let committed = rows;
    assert_eq!(
        f.store.commit_action_engine_quote_draft(request).unwrap(),
        result
    );
    assert_eq!(snapshot(&f.store), committed);
}

#[test]
fn duplicate_active_email_and_archived_only_email_never_create_or_choose_a_customer() {
    for archived in [false, true] {
        let f = fixture(false);
        let db = f.store.connect().unwrap();
        for n in 0..if archived { 1 } else { 2 } {
            db.execute("INSERT INTO clients(id,name,email,archived_at,created_at,updated_at) VALUES(?,'Other','  CAMILLE@example.ch  ',?,'now','now')",
                params![format!("other-{n}"),if archived {Some("archived")} else {None::<&str>}]).unwrap();
        }
        drop(db);
        let request = input(&f, false);
        refuses(&f.store, request, "stale_plan");
    }
}

#[test]
fn an_active_unique_customer_can_coexist_with_an_archived_email_match() {
    let f = fixture(true);
    f.store.connect().unwrap().execute("INSERT INTO clients(id,name,email,archived_at,created_at,updated_at) VALUES('zz-archived','Old','camille@example.ch','archived','now','now')",[]).unwrap();
    assert_eq!(
        f.store
            .commit_action_engine_quote_draft(input(&f, true))
            .unwrap()
            .customer_id,
        f.client_id
    );
}

#[test]
fn current_catalogue_prices_units_names_rates_archive_and_customer_versions_are_rechecked() {
    for mutation in [
        "price", "unit", "name", "tax", "archive", "customer", "company",
    ] {
        let f = fixture(true);
        let request = input(&f, true);
        let db = f.store.connect().unwrap();
        match mutation {
            "price" => db.execute("UPDATE catalog_items SET sales_price_cents=1", []),
            "unit" => db.execute("UPDATE catalog_items SET unit='h'", []),
            "name" => db.execute("UPDATE catalog_items SET name='Different'", []),
            "tax" => db.execute("UPDATE catalog_items SET vat_bp=0", []),
            "archive" => db.execute("UPDATE catalog_items SET archived_at='archived'", []),
            "customer" => db.execute(
                "UPDATE clients SET updated_at='same-facts-new-revision'",
                [],
            ),
            _ => db.execute("UPDATE settings SET payment_terms_days=31", []),
        }
        .unwrap();
        drop(db);
        refuses(&f.store, request, "stale_plan");
    }
}

#[test]
fn fresh_resources_hash_does_not_allow_forged_line_facts_or_customer_resolution() {
    for mutation in [
        "price",
        "unit",
        "tax",
        "articleRevision",
        "customerRevision",
        "customerName",
        "newName",
        "newEmail",
    ] {
        let f = fixture(!mutation.starts_with("new"));
        let mut request = input(&f, !mutation.starts_with("new"));
        change_plan(&mut request, |p| match mutation {
            "price" => {
                p["lines"][0]["unitPriceCents"] = json!(1);
                p["lines"][0]["netCents"] = json!(3);
                p["netCents"] = json!(3);
            }
            "unit" => p["lines"][0]["unit"] = json!("h"),
            "tax" => p["lines"][0]["taxRateBp"] = json!(0),
            "articleRevision" => p["lines"][0]["articleRevision"] = json!("wrong"),
            "customerRevision" => p["customer"]["revision"] = json!("wrong"),
            "customerName" => p["customer"]["name"] = json!("Other"),
            "newName" => p["customer"]["name"] = json!("Name from body"),
            _ => p["customer"]["email"] = json!("body@example.ch"),
        });
        refuses(
            &f.store,
            request,
            if mutation.starts_with("new") {
                "invalid_record"
            } else {
                "stale_plan"
            },
        );
    }
}

#[test]
fn vat_unregistered_uses_effective_zero_even_when_raw_catalogue_rate_is_810() {
    let f = fixture(true);
    f.store
        .connect()
        .unwrap()
        .execute("UPDATE settings SET vat_registered=0,default_vat_bp=0", [])
        .unwrap();
    let mut request = input(&f, true);
    change_plan(&mut request, |p| p["lines"][0]["taxRateBp"] = json!(0));
    f.store.commit_action_engine_quote_draft(request).unwrap();
    let data = snapshot(&f.store);
    assert_eq!(data["quote_items"][0]["vat_bp"], 0);
    assert_eq!(data["quotes"][0]["vat_cents"], 0);
    assert_eq!(data["quotes"][0]["total_cents"], 59700);
    assert_eq!(
        f.store
            .connect()
            .unwrap()
            .query_row::<i64, _, _>("SELECT vat_bp FROM catalog_items", [], |r| r.get(0))
            .unwrap(),
        810
    );
}

#[test]
fn currency_review_and_numeric_overflow_never_write_a_draft() {
    for mutation in [
        "currency",
        "review",
        "quantity",
        "price",
        "net",
        "confidence",
        "human",
    ] {
        let f = fixture(true);
        let mut request = input(&f, true);
        change_plan(&mut request, |p| match mutation {
            "currency" => p["currency"] = json!("USD"),
            "review" => {
                p["status"] = json!("needs_review");
                p["reasons"] = json!(["missing_quantity"]);
            }
            "quantity" => p["lines"][0]["quantityMilli"] = json!(1_000_001),
            "price" => p["lines"][0]["unitPriceCents"] = json!(1_000_000_001_i64),
            "net" => p["lines"][0]["netCents"] = json!(1),
            "confidence" => p["confidence"] = json!(0.94),
            _ => p["requiresHumanValidation"] = json!(false),
        });
        refuses(
            &f.store,
            request,
            if mutation == "review" {
                "review_required"
            } else {
                "invalid_record"
            },
        );
    }
}

#[test]
fn quantity_literal_is_recorroborated_even_with_a_coherently_rehashed_plan() {
    let f = fixture(true);
    let mut request = input(&f, true);
    change_plan(&mut request, |p| {
        p["lines"][0]["quantityMilli"] = json!(999000);
        p["lines"][0]["netCents"] = json!(19_880_100);
        p["netCents"] = json!(19_880_100);
    });
    refuses(&f.store, request, "invalid_record");
    for evidence in [
        "1,000 radiateurs",
        "1.125 radiateurs",
        "3 et 2 radiateurs",
        "radiateurs",
        "-3 radiateurs",
        "3e2 radiateurs",
        "1001 radiateurs",
        "0 radiateurs",
        "3.0001 radiateurs",
        "3 radiateurs le 11/10/2026",
        "3 radiateurs référence 600",
    ] {
        assert_eq!(parse_quantity(evidence, &[]), None, "{evidence}");
    }
    for evidence in [
        "trois radiateurs",
        "three radiators",
        "drei Heizkörper",
        "tre radiatori",
        "un devis pour trois radiateurs",
        "3 RAD-A radiateurs",
    ] {
        assert_eq!(
            parse_quantity(evidence, &["RAD-A"]),
            Some(3000),
            "{evidence}"
        );
    }
    assert_eq!(parse_quantity("2.5 radiateurs", &[]), Some(2500));
    assert_eq!(parse_quantity("0.125 radiateurs", &[]), Some(125));
    assert_eq!(
        parse_quantity("3 RAD-600 radiateurs", &["RAD-600"]),
        Some(3000)
    );
    assert_eq!(parse_quantity("3 radiateurs 600", &["600"]), None);
    assert_eq!(
        parse_quantity("3 RAD-600 et 2 RAD-700", &["RAD-600", "RAD-700"]),
        None
    );
}

#[test]
fn closed_plan_json_and_request_hash_refuse_unknown_duplicate_or_altered_bytes() {
    let f = fixture(true);
    let original = input(&f, true);
    for mutation in ["unknown", "duplicate", "floatingInteger", "rawHash"] {
        let mut request = original.clone();
        match mutation {
            "unknown" => change_plan(&mut request, |p| p["unexpected"] = json!(true)),
            "duplicate" => {
                request
                    .canonical_plan_json
                    .insert_str(1, "\"schemaVersion\":1,");
                request.fingerprint = sha(request.canonical_plan_json.as_bytes());
            }
            "floatingInteger" => {
                request.canonical_plan_json = request
                    .canonical_plan_json
                    .replace("\"quantityMilli\":3000", "\"quantityMilli\":3000.0");
                request.fingerprint = sha(request.canonical_plan_json.as_bytes());
            }
            _ => request.canonical_plan_json.push(' '),
        }
        refuses(&f.store, request, "invalid_record");
    }
}

#[test]
fn milli_quantities_and_tax_half_up_are_proved_with_integer_amounts() {
    let f = fixture(true);
    let mut request = input(&f, true);
    request.source.body = "0.125 radiateurs".into();
    change_plan(&mut request, |p| {
        p["lines"][0]["quantityMilli"] = json!(125);
        p["lines"][0]["netCents"] = json!(2488);
        p["netCents"] = json!(2488);
        p["lines"][0]["evidence"] = json!("0.125 radiateurs");
    });
    f.store.commit_action_engine_quote_draft(request).unwrap();
    let data = snapshot(&f.store);
    assert_eq!(data["quote_items"][0]["quantity"], 0.125);
    assert_eq!(data["quote_items"][0]["line_net_cents"], 2488);
    assert_eq!(data["quote_items"][0]["line_vat_cents"], 202);
    assert_eq!(data["quotes"][0]["total_cents"], 2690);
}

#[test]
fn a_late_failure_rolls_back_new_customer_quote_items_receipt_audit_and_outbox() {
    let f = fixture(false);
    let request = input(&f, false);
    f.store.connect().unwrap().execute_batch("CREATE TRIGGER qa_action_engine_outbox_failure BEFORE INSERT ON company_local_action_engine_quote_outbox BEGIN SELECT RAISE(ABORT,'synthetic last-write failure'); END;").unwrap();
    let before = snapshot(&f.store);
    assert!(f
        .store
        .commit_action_engine_quote_draft(request.clone())
        .is_err());
    assert_eq!(snapshot(&f.store), before);
    f.store
        .connect()
        .unwrap()
        .execute_batch("DROP TRIGGER qa_action_engine_outbox_failure")
        .unwrap();
    let receipt = f
        .store
        .commit_action_engine_quote_draft(request.clone())
        .unwrap();
    assert_eq!(receipt.quote_id, request.quote_id);
    assert_eq!(receipt.customer_id, request.customer_id);
}

#[test]
fn same_source_other_proposal_or_reserved_ids_conflict_and_never_create_another_quote() {
    let f = fixture(true);
    let request = input(&f, true);
    f.store
        .commit_action_engine_quote_draft(request.clone())
        .unwrap();
    for mutation in ["proposal", "reservation", "quote", "sourceBody", "title"] {
        let mut changed = request.clone();
        match mutation {
            "proposal" => changed.proposal_id = Uuid::new_v4().to_string(),
            "reservation" => changed.reservation_id = Uuid::new_v4().to_string(),
            "quote" => changed.quote_id = Uuid::new_v4().to_string(),
            "sourceBody" => changed.source.body.push_str("\nNew data"),
            _ => {
                changed.source.subject = "Changed".into();
                change_plan(&mut changed, |p| p["title"] = json!("Changed"));
            }
        }
        refuses(&f.store, changed, "conflict");
    }
}

#[test]
fn occupied_quote_or_new_customer_id_never_updates_an_unrelated_record() {
    for customer_collision in [false, true] {
        let f = fixture(false);
        let request = input(&f, false);
        if customer_collision {
            f.store
                .create_record(
                    "clients",
                    json!({"id":request.customer_id,"name":"Unrelated"}),
                )
                .unwrap();
        } else {
            f.store
                .create_record(
                    "quotes",
                    json!({"id":request.quote_id,"title":"Unrelated","currency":"CHF"}),
                )
                .unwrap();
        }
        let before = snapshot(&f.store);
        assert!(f.store.commit_action_engine_quote_draft(request).is_err());
        assert_eq!(snapshot(&f.store), before);
    }
}

#[test]
fn historical_receipt_survives_later_edits_catalogue_archive_and_deleted_draft_without_recreation()
{
    let f = fixture(true);
    let request = input(&f, true);
    let receipt = f
        .store
        .commit_action_engine_quote_draft(request.clone())
        .unwrap();
    f.store
        .update_record("quotes", &request.quote_id, json!({"title":"Human edited"}))
        .unwrap();
    f.store
        .connect()
        .unwrap()
        .execute(
            "UPDATE catalog_items SET archived_at='later',sales_price_cents=1",
            [],
        )
        .unwrap();
    let changed = snapshot(&f.store);
    assert_eq!(
        f.store
            .commit_action_engine_quote_draft(request.clone())
            .unwrap(),
        receipt
    );
    assert_eq!(snapshot(&f.store), changed);
    f.store.delete_record("quotes", &request.quote_id).unwrap();
    let deleted = snapshot(&f.store);
    assert_eq!(
        f.store.commit_action_engine_quote_draft(request).unwrap(),
        receipt
    );
    assert_eq!(snapshot(&f.store), deleted);
}

#[test]
fn replay_requires_fresh_physical_member_identity_and_current_write_role() {
    let f = fixture(true);
    let request = input(&f, true);
    f.store
        .commit_action_engine_quote_draft(request.clone())
        .unwrap();
    for mutation in ["workspace", "nonce", "installation", "tenant", "user"] {
        let mut changed = request.clone();
        match mutation {
            "workspace" => changed.expected_workspace_scope = Uuid::new_v4().to_string(),
            "nonce" => changed.expected_member_context_nonce = "0".repeat(32),
            "installation" => changed.installation_id = Uuid::new_v4().to_string(),
            "tenant" => {
                changed.actor.organization_id = "company-b".into();
                changed.source.organization_id = "company-b".into();
                change_plan(&mut changed, |p| p["organizationId"] = json!("company-b"));
            }
            _ => changed.actor.user_id = "other-user".into(),
        }
        let before = snapshot(&f.store);
        assert!(f.store.commit_action_engine_quote_draft(changed).is_err());
        assert_eq!(snapshot(&f.store), before);
    }
    f.store
        .connect()
        .unwrap()
        .execute("UPDATE company_local_identity SET role='read_only'", [])
        .unwrap();
    let mut current = request;
    fresh_origin(&f.store, &mut current);
    refuses(&f.store, current, "forbidden");
}

#[test]
fn simultaneous_native_connections_publish_one_draft_for_the_same_reserved_request() {
    let f = fixture(false);
    let request = input(&f, false);
    let a = f.store.clone();
    let b = LocalStore::initialize(f.directory.path().join("profile")).unwrap();
    let meet = std::sync::Arc::new(std::sync::Barrier::new(2));
    let other = meet.clone();
    let retry = request.clone();
    let first = std::thread::spawn(move || {
        meet.wait();
        a.commit_action_engine_quote_draft(request)
    });
    let second = std::thread::spawn(move || {
        other.wait();
        b.commit_action_engine_quote_draft(retry)
    });
    assert_eq!(
        first.join().unwrap().unwrap(),
        second.join().unwrap().unwrap()
    );
    let data = snapshot(&f.store);
    for table in [
        "clients",
        "quotes",
        "quote_items",
        "action_engine_quote_receipts",
        "company_local_action_engine_quote_outbox",
    ] {
        assert_eq!(data[table].as_array().unwrap().len(), 1);
    }
}

#[test]
fn actual_store_close_reopen_returns_the_original_receipt_after_a_lost_reply() {
    let f = fixture(true);
    let request = input(&f, true);
    let receipt = f
        .store
        .commit_action_engine_quote_draft(request.clone())
        .unwrap();
    let before = snapshot(&f.store);
    let directory = f.directory;
    drop(f.store);
    let reopened = LocalStore::initialize(directory.path().join("profile")).unwrap();
    assert_eq!(
        reopened.commit_action_engine_quote_draft(request).unwrap(),
        receipt
    );
    assert_eq!(snapshot(&reopened), before);
}

#[test]
fn immutable_receipt_and_all_unique_replacement_paths_refuse_direct_sql() {
    let f = fixture(true);
    let request = input(&f, true);
    f.store.commit_action_engine_quote_draft(request).unwrap();
    let before = snapshot(&f.store);
    let db = f.store.connect().unwrap();
    db.execute_batch("PRAGMA recursive_triggers=OFF").unwrap();
    for sql in ["UPDATE action_engine_quote_receipts SET receipt_json=receipt_json","DELETE FROM action_engine_quote_receipts",
        "INSERT OR REPLACE INTO action_engine_quote_receipts SELECT * FROM action_engine_quote_receipts",
        "UPDATE company_local_action_engine_quote_outbox SET payload_json='{}'",
        "INSERT OR REPLACE INTO company_local_action_engine_quote_outbox SELECT * FROM company_local_action_engine_quote_outbox"] {
        assert!(db.execute_batch(sql).is_err());
    }
    for collision in ["source", "proposal", "reservation", "quote"] {
        let original = &before["action_engine_quote_receipts"][0];
        let source = if collision == "source" {
            original["source_id"].as_str().unwrap().to_owned()
        } else {
            Uuid::new_v4().to_string()
        };
        let proposal = if collision == "proposal" {
            original["proposal_id"].as_str().unwrap().to_owned()
        } else {
            Uuid::new_v4().to_string()
        };
        let reservation = if collision == "reservation" {
            original["reservation_id"].as_str().unwrap().to_owned()
        } else {
            Uuid::new_v4().to_string()
        };
        let quote = if collision == "quote" {
            original["quote_id"].as_str().unwrap().to_owned()
        } else {
            Uuid::new_v4().to_string()
        };
        assert!(db.execute("INSERT OR REPLACE INTO action_engine_quote_receipts
            SELECT organization_id,?1,action_kind,?2,?3,fingerprint,request_sha256,resources_sha256,context_revision,
              actor_user_id,installation_id,customer_id,?4,json_set(plan_json,'$.sourceId',?1),
              json_set(receipt_json,'$.proposalId',?2,'$.quoteId',?4),receipt_sha256,created_at
            FROM action_engine_quote_receipts",params![source,proposal,reservation,quote]).is_err(),"{collision}");
    }
    drop(db);
    assert_eq!(snapshot(&f.store), before);
}

#[test]
fn a_recovered_private_outbox_requires_its_matching_shared_creation_receipt() {
    let f = fixture(true);
    let request = input(&f, true);
    f.store.commit_action_engine_quote_draft(request).unwrap();
    let before = snapshot(&f.store);
    let row = &before["company_local_action_engine_quote_outbox"][0];
    let isolated = rusqlite::Connection::open_in_memory().unwrap();
    isolated
        .execute_batch(crate::schema::MIGRATION_V62_SQL)
        .unwrap();
    let sql="INSERT INTO company_local_action_engine_quote_outbox(organization_id,proposal_id,quote_id,fingerprint,payload_json,payload_sha256,state,attempt_count,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'pending',0,?,?)";
    assert!(isolated
        .execute(
            sql,
            params![
                row["organization_id"].as_str().unwrap(),
                row["proposal_id"].as_str().unwrap(),
                row["quote_id"].as_str().unwrap(),
                row["fingerprint"].as_str().unwrap(),
                row["payload_json"].as_str().unwrap(),
                row["payload_sha256"].as_str().unwrap(),
                row["created_at"].as_str().unwrap(),
                row["updated_at"].as_str().unwrap()
            ]
        )
        .is_err());
    let db = f.store.connect().unwrap();
    let tx = db.unchecked_transaction().unwrap();
    tx.execute("DELETE FROM company_local_action_engine_quote_outbox", [])
        .unwrap();
    let mut payload: Value = serde_json::from_str(row["payload_json"].as_str().unwrap()).unwrap();
    payload["reservationId"] = json!(Uuid::new_v4().to_string());
    let payload = serde_json::to_string(&payload).unwrap();
    assert!(tx
        .execute(
            sql,
            params![
                row["organization_id"].as_str().unwrap(),
                row["proposal_id"].as_str().unwrap(),
                row["quote_id"].as_str().unwrap(),
                row["fingerprint"].as_str().unwrap(),
                payload,
                sha(payload.as_bytes()),
                row["created_at"].as_str().unwrap(),
                row["updated_at"].as_str().unwrap()
            ]
        )
        .is_err());
    tx.rollback().unwrap();
    drop(db);
    assert_eq!(snapshot(&f.store), before);
}

#[test]
fn additive_v61_migration_preserves_records_then_reopen_has_schema62_receipts() {
    let f = fixture(true);
    let db = f.store.connect().unwrap();
    db.execute_batch("DROP TRIGGER action_engine_quote_receipt_existing;DROP TRIGGER action_engine_quote_receipt_update;DROP TRIGGER action_engine_quote_receipt_delete;
        DROP TABLE company_local_action_engine_quote_outbox;DROP TABLE action_engine_quote_receipts;PRAGMA user_version=61;").unwrap();
    let clients = query_all(&db, "SELECT * FROM clients", []).unwrap();
    let catalog = query_all(&db, "SELECT * FROM catalog_items", []).unwrap();
    drop(db);
    let reopened = LocalStore::initialize(f.directory.path().join("profile")).unwrap();
    let db = reopened.connect().unwrap();
    assert_eq!(
        db.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        62
    );
    assert_eq!(
        query_all(&db, "SELECT * FROM clients", []).unwrap(),
        clients
    );
    assert_eq!(
        query_all(&db, "SELECT * FROM catalog_items", []).unwrap(),
        catalog
    );
    drop(db);
    assert!(reopened
        .commit_action_engine_quote_draft(input(&f, true))
        .is_ok());
}

#[test]
fn actual_backup_preserves_shared_receipt_strips_outbox_and_restore_replay_is_read_only() {
    let _transfer = crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK
        .lock()
        .unwrap();
    let f = fixture(true);
    let mut request = input(&f, true);
    let receipt = f
        .store
        .commit_action_engine_quote_draft(request.clone())
        .unwrap();
    let backup = f
        .store
        .create_backup(None, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let extract = tempfile::tempdir().unwrap();
    let db_path = extract.path().join("archive.sqlite3");
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&backup).unwrap()).unwrap();
    {
        let mut db_entry = archive.by_name("database.sqlite3").unwrap();
        let mut file = std::fs::File::create(&db_path).unwrap();
        std::io::copy(&mut db_entry, &mut file).unwrap();
    }
    let copied = rusqlite::Connection::open(&db_path).unwrap();
    assert_eq!(
        copied
            .query_row::<i64, _, _>(
                "SELECT count(*) FROM action_engine_quote_receipts",
                [],
                |r| r.get(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        copied
            .query_row::<i64, _, _>(
                "SELECT count(*) FROM company_local_action_engine_quote_outbox",
                [],
                |r| r.get(0)
            )
            .unwrap(),
        0
    );
    drop(copied);
    f.store
        .restore_backup(&backup, env!("CARGO_PKG_VERSION"))
        .unwrap();
    // A restore deliberately loses local member identity and both generations.
    f.store.connect().unwrap().execute("INSERT INTO company_local_identity VALUES(1,'company-a','owner-a','Synthetic owner','owner')",[]).unwrap();
    assert!(f
        .store
        .commit_action_engine_quote_draft(request.clone())
        .is_err());
    fresh_origin(&f.store, &mut request);
    let restored = snapshot(&f.store);
    assert_eq!(
        f.store.commit_action_engine_quote_draft(request).unwrap(),
        receipt
    );
    assert_eq!(snapshot(&f.store), restored);
    assert_eq!(f.store.verify_audit_log().unwrap()["valid"], true);
}
