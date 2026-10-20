//! Actual LocalStore/SQLite transactions. These synthetic private inputs are
//! not evidence of a remote reservation, Automation entitlement or IPC route.
use super::*;
use crate::action_engine_quote_publication::{ActionEngineQuoteConfirmation, ActionEngineQuoteRecoveryOrigin};
use crate::database::query_all;
use serde_json::Value;

#[path = "action_engine_license_fixture_tests.rs"]
mod test_license;

struct Fixture {
    directory: tempfile::TempDir,
    store: LocalStore,
    client_id: String,
    article_id: String,
}
fn fixture(existing: bool) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let mut store = LocalStore::initialize(directory.path().join("profile")).unwrap();
    test_license::configure(&mut store);
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    test_license::install(&store);
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

fn creation_event(store: &LocalStore, quote_id: &str) -> (String, Value) {
    let rows = query_all(&store.connect().unwrap(),
        "SELECT id,payload_json FROM audit_log WHERE action='create' AND entity_type='action_engine_quote' AND entity_id=?",
        [quote_id]).unwrap();
    assert_eq!(rows.len(), 1, "one immutable creation event per quote");
    (rows[0]["id"].as_str().unwrap().into(),
        serde_json::from_str(rows[0]["payload_json"].as_str().unwrap()).unwrap())
}

fn recovery_selection(input: &ActionEngineQuoteInput) -> ActionEngineQuoteRecoverySelection {
    ActionEngineQuoteRecoverySelection {
        source_id: input.source.id.clone(), proposal_id: input.proposal_id.clone(),
        reservation_id: input.reservation_id.clone(), fingerprint: input.fingerprint.clone(),
        actor: input.actor.clone(), installation_id: input.installation_id.clone(),
        expected_workspace_scope: input.expected_workspace_scope.clone(),
        expected_member_context_nonce: input.expected_member_context_nonce.clone(),
    }
}
fn recovery_work_origin(input: &ActionEngineQuoteInput) -> ActionEngineQuoteRecoveryOrigin {
    ActionEngineQuoteRecoveryOrigin {
        actor: input.actor.clone(), installation_id: input.installation_id.clone(),
        expected_workspace_scope: input.expected_workspace_scope.clone(),
        expected_member_context_nonce: input.expected_member_context_nonce.clone(),
    }
}
// Reuse the real writer and the small existing fixture; creation order is
// deliberately the reverse of proposal BINARY order.
fn two_recovery_work_requests(f: &Fixture) -> [ActionEngineQuoteInput; 2] {
    let mut first = input(f, true);
    first.proposal_id = "00000000-0000-4000-8000-000000000002".into();
    f.store.commit_action_engine_quote_draft(first.clone()).unwrap();
    let mut second = input(f, true);
    second.proposal_id = "00000000-0000-4000-8000-000000000001".into();
    second.source.id = "ticket-b".into();
    change_plan(&mut second, |plan| { plan["sourceId"] = json!("ticket-b"); });
    f.store.commit_action_engine_quote_draft(second.clone()).unwrap();
    [first, second]
}

// Real frozen native archive/link plus a synthetic private A7 caller result.
// This does not test remote authentication or manufacture a server authority.
fn activity_candidate(f: &Fixture) -> (String, crate::cloud_backup::Manifest) {
    let _local = f.store.lock().unwrap();
    let snapshot_id = Uuid::new_v4().to_string();
    let path = f.store.data_dir.join("company-sync").join(format!("{snapshot_id}.zentra"));
    f.store.create_collaboration_backup_at(&path, env!("CARGO_PKG_VERSION"), "company-a", &snapshot_id, 0).unwrap();
    let manifest = crate::cloud_backup::file_manifest(&path).unwrap();
    let clock: i64 = f.store.connect().unwrap().query_row(
        "SELECT value FROM company_local_clock WHERE id=1", [], |row| row.get(0)).unwrap();
    crate::action_engine_quote_publication::link_prepared(&f.store,"company-a",&snapshot_id,0,clock,&manifest).unwrap();
    (snapshot_id,manifest)
}
fn activity_confirmation(f: &Fixture, request: &ActionEngineQuoteInput, snapshot_id: &str) -> ActionEngineQuoteConfirmation {
    ActionEngineQuoteConfirmation {
        schema_version: 1, state: "confirmed".into(), source_id: request.source.id.clone(),
        proposal_id: request.proposal_id.clone(), reservation_id: request.reservation_id.clone(),
        publication_snapshot_id: snapshot_id.into(),
        receipt: f.store.recover_action_engine_quote_receipt(recovery_selection(request)).unwrap().receipt,
    }
}
fn activity_snapshot(store: &LocalStore) -> Value {
    let mut result = snapshot(store);
    let db = store.connect().unwrap();
    for table in ["company_local_action_engine_quote_publications", "company_local_action_engine_quote_confirmations"] {
        result.as_object_mut().unwrap().insert(table.into(),json!(query_all(&db,
            &format!("SELECT * FROM {table} ORDER BY organization_id,proposal_id"),[]).unwrap()));
    }
    result
}
fn corruptible_activity_connection(store: &LocalStore) -> rusqlite::Connection {
    let db = corruptible_recovery_connection(store);
    db.execute_batch("DROP TRIGGER IF EXISTS company_local_action_quote_confirmation_update;
        DROP TRIGGER IF EXISTS company_local_action_quote_publication_update;").unwrap();
    db
}

fn relink_activity_candidate(f: &Fixture, snapshot_id: &str, manifest: &crate::cloud_backup::Manifest) -> AppResult<()> {
    let _local = f.store.lock().unwrap();
    let clock: i64 = f.store.connect().unwrap().query_row(
        "SELECT value FROM company_local_clock WHERE id=1", [], |row| row.get(0)).unwrap();
    crate::action_engine_quote_publication::link_prepared(&f.store,"company-a",snapshot_id,0,clock,manifest)
}

#[test]
fn publication_link_refuses_a_new_candidate_before_local_creation_without_mutation() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);
    f.store.commit_action_engine_quote_draft(input(&f,true)).unwrap();
    let (snapshot_id,manifest)=activity_candidate(&f);
    let db=corruptible_activity_connection(&f.store);
    db.execute("DELETE FROM company_local_action_engine_quote_publications",[]).unwrap();
    // Simulate a local creation clock ahead of the clock used for a new link,
    // without changing the host clock or the real frozen business archive.
    db.execute("UPDATE company_local_action_engine_quote_outbox
        SET created_at='9999-12-31T23:59:59Z',updated_at='9999-12-31T23:59:59Z'",[]).unwrap();
    let before=activity_snapshot(&f.store);
    assert!(relink_activity_candidate(&f,&snapshot_id,&manifest).is_err());
    assert_eq!(activity_snapshot(&f.store),before,"a clock rollback must not persist a new unreadable candidate");
}

#[test]
fn publication_link_rechecks_replayed_creation_time_as_an_instant_without_rewriting_it() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);
    f.store.commit_action_engine_quote_draft(input(&f,true)).unwrap();
    let (snapshot_id,manifest)=activity_candidate(&f);
    let db=corruptible_activity_connection(&f.store);
    let created_at: String=db.query_row("SELECT created_at FROM company_local_action_engine_quote_outbox",[],|row| row.get(0)).unwrap();
    let created=chrono::DateTime::parse_from_rfc3339(&created_at).unwrap();
    for (case,at,refused) in [
        ("earlier",(created-chrono::Duration::seconds(1)).to_rfc3339(),true),
        ("invalid","9999-99-99T99:99:99Z".to_owned(),true),
        ("equal",created_at,false),
        ("equivalent_offset",created.with_timezone(&chrono::FixedOffset::east_opt(3600).unwrap()).to_rfc3339(),false),
    ] {
        db.execute("UPDATE company_local_action_engine_quote_publications SET created_at=?",[at]).unwrap();
        let before=activity_snapshot(&f.store);
        let result=relink_activity_candidate(&f,&snapshot_id,&manifest);
        assert_eq!(result.is_err(),refused,"{case}");
        assert_eq!(activity_snapshot(&f.store),before,"{case}: replay must keep its original timestamp");
    }
}

#[test]
fn transport_ack_refuses_a_clock_rollback_atomically_and_an_explicit_retry_succeeds() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);
    let request=input(&f,true);
    f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let (snapshot_id,manifest)=activity_candidate(&f);
    let db=corruptible_activity_connection(&f.store);
    let original: String=db.query_row("SELECT created_at FROM company_local_action_engine_quote_publications",[],|row| row.get(0)).unwrap();
    // This future instant is lexically earlier than the current UTC clock.
    // SQLite's text ordering alone would permit an ACK before its candidate.
    let future=(chrono::Utc::now()+chrono::Duration::hours(1))
        .with_timezone(&chrono::FixedOffset::west_opt(7200).unwrap()).to_rfc3339();
    db.execute("UPDATE company_local_action_engine_quote_publications SET created_at=?",[future]).unwrap();
    let before=activity_snapshot(&f.store);
    assert!(crate::action_engine_quote_publication::mark_published(&f.store,"company-a",&snapshot_id,0,&manifest,1).is_err());
    assert_eq!(activity_snapshot(&f.store),before);
    db.execute("UPDATE company_local_action_engine_quote_publications SET created_at=?",[original]).unwrap();
    crate::action_engine_quote_publication::mark_published(&f.store,"company-a",&snapshot_id,0,&manifest,1).unwrap();
    let published=activity_snapshot(&f.store);
    assert_eq!(published["company_local_action_engine_quote_publications"][0]["published_revision"],json!(1));
    assert_eq!(published["company_local_action_engine_quote_outbox"][0]["state"],json!("pending"));
    assert_eq!(published["company_local_action_engine_quote_confirmations"],json!([]));
    crate::action_engine_quote_publication::mark_published(&f.store,"company-a",&snapshot_id,0,&manifest,1).unwrap();
    assert_eq!(activity_snapshot(&f.store),published,"transport ACK replay preserves its first timestamp");
}

#[test]
fn transport_ack_replay_corroborates_historical_instants_without_using_the_current_clock() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);
    f.store.commit_action_engine_quote_draft(input(&f,true)).unwrap();
    let (snapshot_id,manifest)=activity_candidate(&f);
    crate::action_engine_quote_publication::mark_published(&f.store,"company-a",&snapshot_id,0,&manifest,1).unwrap();
    let db=corruptible_activity_connection(&f.store);
    let future=chrono::Utc::now()+chrono::Duration::hours(2);
    let created=future.with_timezone(&chrono::FixedOffset::west_opt(7200).unwrap()).to_rfc3339();
    for (case,at,refused) in [
        ("equivalent_offset",future.with_timezone(&chrono::FixedOffset::east_opt(7200).unwrap()).to_rfc3339(),false),
        ("earlier",(future-chrono::Duration::seconds(1)).with_timezone(&chrono::FixedOffset::east_opt(7200).unwrap()).to_rfc3339(),true),
        ("invalid","9999-99-99T99:99:99Z".to_owned(),true),
    ] {
        db.execute("UPDATE company_local_action_engine_quote_publications SET created_at=?,published_at=?",params![created,at]).unwrap();
        let before=activity_snapshot(&f.store);
        let result=crate::action_engine_quote_publication::mark_published(&f.store,"company-a",&snapshot_id,0,&manifest,1);
        assert_eq!(result.is_err(),refused,"{case}");
        assert_eq!(activity_snapshot(&f.store),before,"{case}: historical ACK dates are immutable");
    }
}

#[test]
fn canonical_ack_rolls_back_an_unreadable_candidate_and_a_valid_retry_restores_activity() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);
    let request=input(&f,true);
    f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let (snapshot_id,_)=activity_candidate(&f);
    let confirmation=activity_confirmation(&f,&request,&snapshot_id);
    let db=corruptible_activity_connection(&f.store);
    let original: String=db.query_row("SELECT created_at FROM company_local_action_engine_quote_publications",[],|row| row.get(0)).unwrap();
    let created_at: String=db.query_row("SELECT created_at FROM company_local_action_engine_quote_outbox",[],|row| row.get(0)).unwrap();
    let earlier=(chrono::DateTime::parse_from_rfc3339(&created_at).unwrap()-chrono::Duration::seconds(1)).to_rfc3339();
    db.execute("UPDATE company_local_action_engine_quote_publications SET created_at=?",[earlier]).unwrap();
    let before=activity_snapshot(&f.store);
    assert!(f.store.acknowledge_action_engine_quote_confirmation(recovery_selection(&request),confirmation.clone()).is_err());
    assert_eq!(activity_snapshot(&f.store),before,"the new canonical marker and terminal outbox state must roll back together");
    db.execute("UPDATE company_local_action_engine_quote_publications SET created_at=?",[original]).unwrap();
    f.store.acknowledge_action_engine_quote_confirmation(recovery_selection(&request),confirmation).unwrap();
    let page=f.store.read_action_engine_quote_activity(recovery_work_origin(&request),None,1).unwrap();
    assert_eq!(page.entries.len(),1);
    assert_eq!(page.entries[0].proposal_id,request.proposal_id);
    assert!(page.next_after_proposal_id.is_none());
}

#[test]
fn confirmed_activity_empty_page_checks_origin_onboarding_and_closed_bounds_without_writing() {
    let f = fixture(true);
    let request = input(&f,true);
    let origin = recovery_work_origin(&request);
    let before = activity_snapshot(&f.store);
    let page = f.store.read_action_engine_quote_activity(origin.clone(),None,50).unwrap();
    assert_eq!(serde_json::to_value(&page).unwrap(),json!({"entries":[],"nextAfterProposalId":null}));
    for limit in [0,51,usize::MAX] {
        assert!(f.store.read_action_engine_quote_activity(origin.clone(),None,limit).is_err());
    }
    for cursor in ["".to_owned(),"x".repeat(161),"déjà".into(),"x\n".into()] {
        assert!(f.store.read_action_engine_quote_activity(origin.clone(),Some(cursor),1).is_err());
    }
    for field in ["user","organization","installation","workspace","nonce"] {
        let mut changed = origin.clone();
        match field {
            "user" => changed.actor.user_id="other-user".into(),
            "organization" => changed.actor.organization_id="other-company".into(),
            "installation" => changed.installation_id=Uuid::new_v4().to_string(),
            "workspace" => changed.expected_workspace_scope=Uuid::new_v4().to_string(),
            _ => changed.expected_member_context_nonce="0".repeat(32),
        }
        assert!(f.store.read_action_engine_quote_activity(changed,None,1).is_err(),"{field}");
    }
    assert_eq!(activity_snapshot(&f.store),before);
    f.store.connect().unwrap().execute("UPDATE company_local_identity SET role='read_only'",[]).unwrap();
    assert!(f.store.read_action_engine_quote_activity(origin.clone(),None,1).is_err());
    f.store.connect().unwrap().execute("UPDATE company_local_identity SET role='owner'",[]).unwrap();
    f.store.connect().unwrap().execute("UPDATE settings SET onboarding_completed=0 WHERE id=1",[]).unwrap();
    assert!(matches!(f.store.read_action_engine_quote_activity(origin,None,1).unwrap_err(),AppError::OnboardingRequired));
}

#[test]
fn confirmed_activity_starts_only_after_exact_a7_ack_and_replay_reopen_keeps_one_historical_entry() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);
    let request=input(&f,true);
    f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let origin=recovery_work_origin(&request);
    let (snapshot_id,manifest)=activity_candidate(&f);
    crate::action_engine_quote_publication::mark_published(&f.store,"company-a",&snapshot_id,0,&manifest,1).unwrap();
    assert!(f.store.read_action_engine_quote_activity(origin.clone(),None,10).unwrap().entries.is_empty(),
        "a draft, receipt, candidate and transport ACK are not canonical activity");
    let confirmation=activity_confirmation(&f,&request,&snapshot_id);
    f.store.acknowledge_action_engine_quote_confirmation(recovery_selection(&request),confirmation.clone()).unwrap();
    let before=activity_snapshot(&f.store);
    let page=f.store.read_action_engine_quote_activity(origin.clone(),None,10).unwrap();
    assert_eq!(page.entries.len(),1);
    let confirmed_at: String=f.store.connect().unwrap().query_row(
        "SELECT confirmed_at FROM company_local_action_engine_quote_confirmations",[],|row| row.get(0)).unwrap();
    assert_eq!(serde_json::to_value(&page).unwrap(),json!({"entries":[{
        "organizationId":"company-a","proposalId":request.proposal_id,"quoteId":request.quote_id,
        "confirmedAt":confirmed_at,"kind":"quote_draft_created","requiresHumanValidation":true
    }],"nextAfterProposalId":null}));
    f.store.acknowledge_action_engine_quote_confirmation(recovery_selection(&request),confirmation).unwrap();
    assert_eq!(f.store.read_action_engine_quote_activity(origin.clone(),None,10).unwrap(),page);
    std::fs::remove_file(f.store.data_dir.join("company-sync").join(format!("{snapshot_id}.zentra"))).unwrap();
    let reopened=LocalStore::initialize(f.store.data_dir.clone()).unwrap();
    assert_eq!(reopened.read_action_engine_quote_activity(origin,None,10).unwrap(),page,
        "lost ACK/restart/archive pruning do not duplicate or erase confirmed history");
    assert_eq!(activity_snapshot(&reopened),before);
    assert_eq!(reopened.connect().unwrap().query_row::<i64,_,_>("PRAGMA user_version",[],|row| row.get(0)).unwrap(),crate::schema::SCHEMA_VERSION);
}

#[test]
fn confirmed_activity_pages_in_binary_proposal_order_with_verified_lookahead_not_timestamp_watermark() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);
    let requests=two_recovery_work_requests(&f);
    let (snapshot_id,_)=activity_candidate(&f);
    for request in &requests {
        f.store.acknowledge_action_engine_quote_confirmation(recovery_selection(request),activity_confirmation(&f,request,&snapshot_id)).unwrap();
    }
    let origin=recovery_work_origin(&requests[0]);
    let before=activity_snapshot(&f.store);
    let first=f.store.read_action_engine_quote_activity(origin.clone(),None,1).unwrap();
    assert_eq!(first.entries.len(),1);
    assert_eq!(first.entries[0].proposal_id,requests[1].proposal_id);
    assert_eq!(first.next_after_proposal_id.as_deref(),Some(requests[1].proposal_id.as_str()));
    let last=f.store.read_action_engine_quote_activity(origin.clone(),first.next_after_proposal_id,1).unwrap();
    assert_eq!(last.entries.len(),1);
    assert_eq!(last.entries[0].proposal_id,requests[0].proposal_id);
    assert!(last.next_after_proposal_id.is_none());
    let all=f.store.read_action_engine_quote_activity(origin.clone(),None,50).unwrap();
    assert_eq!(all.entries,vec![first.entries[0].clone(),last.entries[0].clone()]);
    assert!(all.next_after_proposal_id.is_none());
    assert!(f.store.read_action_engine_quote_activity(origin,Some(requests[0].proposal_id.clone()),1).unwrap().entries.is_empty());
    assert_eq!(activity_snapshot(&f.store),before);
}

#[test]
fn confirmed_activity_excludes_other_actor_installation_and_company_markers_from_this_local_feed() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);
    let requests=two_recovery_work_requests(&f);
    let (snapshot_id,_)=activity_candidate(&f);
    for request in &requests {
        f.store.acknowledge_action_engine_quote_confirmation(recovery_selection(request),activity_confirmation(&f,request,&snapshot_id)).unwrap();
    }
    // Only isolated corruption fixtures bypass immutability. A foreign marker
    // is intentionally out of scope, never claimed as a shared team activity.
    let db=corruptible_activity_connection(&f.store);
    for (column,value,original) in [
        ("actor_user_id","other-user".to_owned(),requests[1].actor.user_id.clone()),
        ("installation_id",Uuid::new_v4().to_string(),requests[1].installation_id.clone()),
        ("organization_id","company-b".to_owned(),"company-a".to_owned()),
    ] {
        db.execute(&format!("UPDATE company_local_action_engine_quote_confirmations SET {column}=? WHERE proposal_id=?"),params![value,requests[1].proposal_id]).unwrap();
        let before=activity_snapshot(&f.store);
        let page=f.store.read_action_engine_quote_activity(recovery_work_origin(&requests[0]),None,1).unwrap();
        assert_eq!(page.entries.len(),1,"{column}");
        assert_eq!(page.entries[0].proposal_id,requests[0].proposal_id,"{column}");
        assert!(page.next_after_proposal_id.is_none(),"{column}");
        assert_eq!(activity_snapshot(&f.store),before,"{column}");
        db.execute(&format!("UPDATE company_local_action_engine_quote_confirmations SET {column}=? WHERE proposal_id=?"),params![original,requests[1].proposal_id]).unwrap();
    }
}

#[test]
fn confirmed_activity_remains_the_original_draft_fact_after_current_business_changes_issue_or_deletion() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for stage in ["edited","issued","deleted"] {
        let f=fixture(true);
        let request=input(&f,true);
        f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
        let (snapshot_id,_)=activity_candidate(&f);
        f.store.acknowledge_action_engine_quote_confirmation(recovery_selection(&request),activity_confirmation(&f,&request,&snapshot_id)).unwrap();
        let origin=recovery_work_origin(&request);
        let original=f.store.read_action_engine_quote_activity(origin.clone(),None,10).unwrap();
        let db=f.store.connect().unwrap();
        db.execute("UPDATE clients SET name='Changed customer',email='changed@example.test',address_line1='Rue fictive 1',postal_code='1200',city='Genève' WHERE id=?",[&request.customer_id]).unwrap();
        db.execute("UPDATE catalog_items SET sales_price_cents=1,archived_at='later' WHERE id=?",[&f.article_id]).unwrap();
        db.execute("UPDATE settings SET vat_number='CHE-123.456.789 TVA' WHERE id=1",[]).unwrap();
        drop(db);
        match stage {
            "edited"=>{f.store.update_record("quotes",&request.quote_id,json!({"title":"Human edited draft"})).unwrap();},
            "issued"=>{f.store.issue_quote(&request.quote_id,Some("2026-10-11".into()),Some("2026-11-10".into())).unwrap();},
            _=>{f.store.delete_record("quotes",&request.quote_id).unwrap();},
        }
        let before=activity_snapshot(&f.store);
        assert_eq!(f.store.read_action_engine_quote_activity(origin,None,10).unwrap(),original,
            "{stage}: opening a current quote is separate from its historical creation fact");
        assert_eq!(activity_snapshot(&f.store),before,"{stage}");
    }
}

#[test]
fn confirmed_activity_refuses_missing_or_contradictory_evidence_without_repairing_it() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for mutation in ["receipt","outbox","audit","candidate","receipt_hash","manifest","time","blob","utf8","oversized"] {
        let f=fixture(true);
        let request=input(&f,true);
        f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
        let (snapshot_id,_)=activity_candidate(&f);
        f.store.acknowledge_action_engine_quote_confirmation(recovery_selection(&request),activity_confirmation(&f,&request,&snapshot_id)).unwrap();
        let db=corruptible_activity_connection(&f.store);
        match mutation {
            "receipt"=>{db.execute("DELETE FROM action_engine_quote_receipts",[]).unwrap();},
            "outbox"=>{db.execute("DELETE FROM company_local_action_engine_quote_outbox",[]).unwrap();},
            "audit"=>{db.execute("DELETE FROM audit_log WHERE entity_type='action_engine_quote'",[]).unwrap();},
            "candidate"=>{db.execute("DELETE FROM company_local_action_engine_quote_publications",[]).unwrap();},
            "receipt_hash"=>{db.execute("UPDATE company_local_action_engine_quote_confirmations SET receipt_sha256=?",["0".repeat(64)]).unwrap();},
            "manifest"=>{db.execute("UPDATE company_local_action_engine_quote_publications SET manifest_json='{}',manifest_sha256=?",[sha(b"{}")]).unwrap();},
            "time"=>{db.execute("UPDATE company_local_action_engine_quote_confirmations SET confirmed_at='9999-99-99T99:99:99Z'",[]).unwrap();},
            "blob"=>{db.execute("UPDATE company_local_action_engine_quote_confirmations SET confirmed_at=X'80'",[]).unwrap();},
            "utf8"=>{db.execute("UPDATE company_local_action_engine_quote_confirmations SET confirmed_at=CAST(X'80' AS TEXT)",[]).unwrap();},
            _=>{db.execute("UPDATE company_local_action_engine_quote_confirmations SET source_id=?",["x".repeat(161)]).unwrap();},
        }
        let before=activity_snapshot(&f.store);
        assert!(f.store.read_action_engine_quote_activity(recovery_work_origin(&request),None,1).is_err(),"{mutation}");
        assert_eq!(activity_snapshot(&f.store),before,"{mutation}");
    }
}

#[test]
fn confirmed_activity_corrupt_lookahead_refuses_the_whole_page_instead_of_hiding_the_error() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);
    let requests=two_recovery_work_requests(&f);
    let (snapshot_id,_)=activity_candidate(&f);
    for request in &requests {
        f.store.acknowledge_action_engine_quote_confirmation(recovery_selection(request),activity_confirmation(&f,request,&snapshot_id)).unwrap();
    }
    corruptible_activity_connection(&f.store).execute(
        "UPDATE company_local_action_engine_quote_confirmations SET confirmed_at='9999-99-99T99:99:99Z' WHERE proposal_id=?",
        [&requests[0].proposal_id]).unwrap();
    let before=activity_snapshot(&f.store);
    assert!(f.store.read_action_engine_quote_activity(recovery_work_origin(&requests[0]),None,1).is_err(),
        "the first visible row is valid; the extra row must still be corroborated");
    assert_eq!(activity_snapshot(&f.store),before);
}

#[test]
fn confirmed_activity_missing_or_open_schema_is_an_error_and_never_an_empty_or_repaired_page() {
    for schema in ["missing","unknown_column"] {
        let f=fixture(true);
        let request=input(&f,true);
        let db=f.store.connect().unwrap();
        if schema=="missing" {
            db.execute("DROP TABLE company_local_action_engine_quote_confirmations",[]).unwrap();
        } else {
            db.execute("ALTER TABLE company_local_action_engine_quote_confirmations ADD COLUMN unknown_field TEXT",[]).unwrap();
        }
        let before=query_all(&db,"SELECT type,name,sql FROM sqlite_master ORDER BY type,name",[]).unwrap();
        assert!(f.store.read_action_engine_quote_activity(recovery_work_origin(&request),None,1).is_err(),"{schema}");
        assert_eq!(query_all(&db,"SELECT type,name,sql FROM sqlite_master ORDER BY type,name",[]).unwrap(),before,"{schema}");
    }
}

#[test]
fn strict_recovery_first_writer_creates_the_first_real_draft_and_matching_local_receipt_once() {
    let f = fixture(true);
    let request = input(&f, true);
    let receipt = f.store.commit_action_engine_quote_draft_after_recovery(request.clone()).unwrap();
    assert_eq!(receipt.quote_id, request.quote_id);
    assert_eq!(receipt.proposal_id, request.proposal_id);
    assert_eq!(receipt.status, "draft");
    assert!(receipt.quote_number.is_none());
    let recovered = f.store.recover_action_engine_quote_receipt(recovery_selection(&request)).unwrap();
    assert_eq!(recovered.receipt, receipt);
    assert_eq!(recovered.local_outbox_state, ActionEngineLocalQuoteOutboxState::Pending);
    let committed = snapshot(&f.store);
    for table in ["quotes", "action_engine_quote_receipts", "company_local_action_engine_quote_outbox"] {
        assert_eq!(committed[table].as_array().unwrap().len(), 1, "{table}");
    }
}

#[test]
fn strict_recovery_first_writer_atomically_refuses_a_second_draft_behind_pending_or_uncertain_history() {
    for state in ["pending", "uncertain"] {
        let f = fixture(true);
        let first = input(&f, true);
        f.store.commit_action_engine_quote_draft_after_recovery(first).unwrap();
        let mut second = input(&f, true);
        second.source.id = "ticket-b".into();
        change_plan(&mut second, |plan| { plan["sourceId"] = json!("ticket-b"); });
        f.store.connect().unwrap().execute(
            "UPDATE company_local_action_engine_quote_outbox SET state=?,updated_at=created_at", [state]).unwrap();
        let before = snapshot(&f.store);
        let error = f.store.commit_action_engine_quote_draft_after_recovery(second).unwrap_err();
        assert!(error.to_string().contains("action_engine:recovery_pending"), "{state}: {error}");
        assert_eq!(snapshot(&f.store), before, "{state}: client/draft/receipt/audit/outbox remain unchanged");
    }
}

#[test]
fn strict_recovery_first_writer_replays_an_exact_historical_receipt_even_with_other_pending_intentions() {
    let f = fixture(true);
    // Deliberately use the fixture-only multi-receipt entry point to construct
    // an existing local history that the production strict method must replay.
    let requests = two_recovery_work_requests(&f);
    let original = f.store.recover_action_engine_quote_receipt(recovery_selection(&requests[0])).unwrap();
    let before = snapshot(&f.store);
    let replay = f.store.commit_action_engine_quote_draft_after_recovery(requests[0].clone()).unwrap();
    assert_eq!(replay, original.receipt);
    assert_eq!(snapshot(&f.store), before, "replay precedes the recovery guard and never creates another draft");
}

#[test]
fn strict_recovery_first_writer_does_not_treat_another_organizations_local_row_as_its_own_pending_work() {
    let f = fixture(true);
    let first = input(&f, true);
    f.store.commit_action_engine_quote_draft(first).unwrap();
    // Isolated foreign recovery debris is not accepted as valid history. It
    // only proves that the new-creation guard is scoped to the current company.
    let db = corruptible_recovery_connection(&f.store);
    db.execute("UPDATE company_local_action_engine_quote_outbox SET organization_id='company-b'", []).unwrap();
    drop(db);
    let mut second = input(&f, true);
    second.source.id = "ticket-b".into();
    change_plan(&mut second, |plan| { plan["sourceId"] = json!("ticket-b"); });
    let receipt = f.store.commit_action_engine_quote_draft_after_recovery(second.clone()).unwrap();
    assert_eq!(receipt.quote_id, second.quote_id);
    assert_eq!(f.store.connect().unwrap().query_row::<i64, _, _>(
        "SELECT count(*) FROM company_local_action_engine_quote_outbox WHERE organization_id='company-b'", [],
        |row| row.get(0)).unwrap(), 1, "foreign debris is neither used nor repaired");
}

#[test]
fn recovery_work_empty_queue_requires_a_real_origin_and_returns_only_selectors() {
    let f = fixture(true);
    let request = input(&f, true);
    let before = snapshot(&f.store);
    let work = f.store.read_action_engine_quote_recovery_work(recovery_work_origin(&request), 50).unwrap();
    assert!(work.selections.is_empty());
    assert!(!work.has_more);
    assert_eq!(serde_json::to_value(&work).unwrap(), json!({"selections":[],"hasMore":false}));
    assert_eq!(snapshot(&f.store), before, "empty reads cannot repair or create a receipt");
}

#[test]
fn recovery_work_does_not_treat_invalid_empty_origin_or_onboarding_as_an_empty_success() {
    for field in ["workspace", "nonce", "installation", "organization", "user", "role", "identity", "onboarding"] {
        let f = fixture(true);
        let request = input(&f, true);
        let mut origin = recovery_work_origin(&request);
        match field {
            "workspace" => origin.expected_workspace_scope = Uuid::new_v4().to_string(),
            "nonce" => origin.expected_member_context_nonce = "0".repeat(32),
            "installation" => origin.installation_id = Uuid::new_v4().to_string(),
            "organization" => origin.actor.organization_id = "company-b".into(),
            "user" => origin.actor.user_id = "another-user".into(),
            "role" => { f.store.connect().unwrap().execute("UPDATE company_local_identity SET role='read_only'", []).unwrap(); }
            "identity" => { f.store.connect().unwrap().execute("DELETE FROM company_local_identity", []).unwrap(); }
            _ => { f.store.connect().unwrap().execute("UPDATE settings SET onboarding_completed=0 WHERE id=1", []).unwrap(); }
        }
        let before = snapshot(&f.store);
        let error = f.store.read_action_engine_quote_recovery_work(origin, 1).unwrap_err();
        if field == "onboarding" { assert!(matches!(error, AppError::OnboardingRequired)); }
        else { assert!(error.to_string().contains("action_engine:forbidden"), "{field}: {error}"); }
        assert_eq!(snapshot(&f.store), before, "{field}");
    }
}

#[test]
fn recovery_work_requires_closed_bounded_origin_and_limit_one_through_fifty() {
    let f = fixture(true);
    let request = input(&f, true);
    let origin = recovery_work_origin(&request);
    let encoded = serde_json::to_value(&origin).unwrap();
    assert_eq!(encoded.as_object().unwrap().len(), 4);
    for field in ["unknown", "actor", "installationId", "expectedWorkspaceScope", "expectedMemberContextNonce"] {
        let mut changed = encoded.clone();
        if field == "unknown" { changed["unknown"] = json!(true); }
        else { changed.as_object_mut().unwrap().remove(field); }
        assert!(serde_json::from_value::<ActionEngineQuoteRecoveryOrigin>(changed).is_err(), "{field}");
    }
    let before = snapshot(&f.store);
    for limit in [0, 51, usize::MAX] {
        assert!(f.store.read_action_engine_quote_recovery_work(origin.clone(), limit).is_err());
    }
    for malformed in ["", " ", "A"].map(str::to_owned) {
        let mut changed = origin.clone(); changed.expected_member_context_nonce = malformed;
        assert!(f.store.read_action_engine_quote_recovery_work(changed, 1).is_err());
    }
    let mut changed = origin.clone(); changed.actor.user_id = "x".repeat(161);
    assert!(f.store.read_action_engine_quote_recovery_work(changed, 1).is_err());
    let mut changed = origin;
    // A known noncanonical representation avoids depending on the random UUID.
    changed.installation_id = "00000000-0000-4000-8000-00000000000A".into();
    assert!(f.store.read_action_engine_quote_recovery_work(changed, 1).is_err());
    assert_eq!(snapshot(&f.store), before);
}

#[test]
fn recovery_work_orders_two_real_creations_bounds_the_page_and_keeps_pending_uncertain_only() {
    let f = fixture(true);
    let requests = two_recovery_work_requests(&f);
    let origin = recovery_work_origin(&requests[0]);
    let before = snapshot(&f.store);
    let first = f.store.read_action_engine_quote_recovery_work(origin.clone(), 1).unwrap();
    assert!(first.has_more, "consumer must drain recovery before any new work");
    assert_eq!(serde_json::to_value(&first.selections).unwrap(), json!([recovery_selection(&requests[1])]));
    for limit in [2, 50] {
        let page = f.store.read_action_engine_quote_recovery_work(origin.clone(), limit).unwrap();
        assert!(!page.has_more);
        assert_eq!(serde_json::to_value(&page.selections).unwrap(),
            json!([recovery_selection(&requests[1]), recovery_selection(&requests[0])]));
    }
    assert_eq!(snapshot(&f.store), before);
    let db = f.store.connect().unwrap();
    db.execute("UPDATE company_local_action_engine_quote_outbox SET state='confirmed',updated_at=created_at WHERE proposal_id=?",
        [&requests[1].proposal_id]).unwrap();
    db.execute("UPDATE company_local_action_engine_quote_outbox SET state='uncertain',attempt_count=1,updated_at=created_at WHERE proposal_id=?",
        [&requests[0].proposal_id]).unwrap();
    drop(db);
    let before = snapshot(&f.store);
    let page = f.store.read_action_engine_quote_recovery_work(origin, 1).unwrap();
    assert!(!page.has_more);
    assert_eq!(serde_json::to_value(&page.selections).unwrap(), json!([recovery_selection(&requests[0])]));
    // This is a local queue filter, not a claim that the manually set confirmed
    // status in this isolated fixture constitutes canonical A7 evidence.
    assert_eq!(snapshot(&f.store), before);
}

#[test]
fn recovery_work_keeps_historical_intentions_after_current_quote_catalogue_or_client_changes() {
    let f = fixture(true);
    let request = input(&f, true);
    f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let db = f.store.connect().unwrap();
    db.execute("DELETE FROM quote_items WHERE quote_id=?", [&request.quote_id]).unwrap();
    db.execute("DELETE FROM quotes WHERE id=?", [&request.quote_id]).unwrap();
    db.execute("UPDATE clients SET email='changed@example.test' WHERE id=?", [&request.customer_id]).unwrap();
    db.execute("UPDATE catalog_items SET sales_price_cents=123,archived_at='later' WHERE id=?", [&f.article_id]).unwrap();
    drop(db);
    let before = snapshot(&f.store);
    let work = f.store.read_action_engine_quote_recovery_work(recovery_work_origin(&request), 1).unwrap();
    assert!(!work.has_more);
    assert_eq!(serde_json::to_value(&work.selections).unwrap(), json!([recovery_selection(&request)]));
    assert_eq!(snapshot(&f.store), before);
}

#[test]
fn recovery_work_refuses_orphan_corrupt_or_foreign_rows_instead_of_skipping_them() {
    for mutation in ["missing_receipt", "missing_audit", "payload_hash", "foreign_user", "foreign_installation",
        "state", "blob_source", "oversize_source", "oversize_proposal", "blob_fingerprint"] {
        let f = fixture(true);
        let request = input(&f, true);
        f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
        let db = corruptible_recovery_connection(&f.store);
        match mutation {
            "missing_receipt" => { db.execute("DELETE FROM action_engine_quote_receipts", []).unwrap(); }
            "missing_audit" => { db.execute("DELETE FROM audit_log WHERE entity_type='action_engine_quote'", []).unwrap(); }
            "payload_hash" => { db.execute("UPDATE company_local_action_engine_quote_outbox SET payload_sha256=?", ["0".repeat(64)]).unwrap(); }
            "foreign_user" => { db.execute("UPDATE action_engine_quote_receipts SET actor_user_id='another-user'", []).unwrap(); }
            "foreign_installation" => { db.execute("UPDATE action_engine_quote_receipts SET installation_id=?", [Uuid::new_v4().to_string()]).unwrap(); }
            "state" => { db.execute("UPDATE company_local_action_engine_quote_outbox SET state='invalid'", []).unwrap(); }
            "blob_source" => { db.execute("UPDATE action_engine_quote_receipts SET source_id=CAST(source_id AS BLOB)", []).unwrap(); }
            "oversize_source" => { db.execute("UPDATE action_engine_quote_receipts SET source_id=?", ["x".repeat(161)]).unwrap(); }
            "oversize_proposal" => { db.execute("UPDATE company_local_action_engine_quote_outbox SET proposal_id=?", ["x".repeat(161)]).unwrap(); }
            _ => { db.execute("UPDATE company_local_action_engine_quote_outbox SET fingerprint=CAST(fingerprint AS BLOB)", []).unwrap(); }
        }
        drop(db);
        let before = snapshot(&f.store);
        assert!(f.store.read_action_engine_quote_recovery_work(recovery_work_origin(&request), 1).is_err(), "{mutation}");
        assert_eq!(snapshot(&f.store), before, "{mutation}: no repair/backfill/deletion");
    }
}

#[test]
fn recovery_work_checks_the_extra_has_more_row_before_returning_any_page() {
    let f = fixture(true);
    let requests = two_recovery_work_requests(&f);
    let db = corruptible_recovery_connection(&f.store);
    // The valid proposal ...001 is the visible page; its extra ...002 row is an
    // orphan and must block success rather than being hidden behind has_more.
    db.execute("DELETE FROM action_engine_quote_receipts WHERE proposal_id=?", [&requests[0].proposal_id]).unwrap();
    drop(db);
    let before = snapshot(&f.store);
    assert!(f.store.read_action_engine_quote_recovery_work(recovery_work_origin(&requests[0]), 1).is_err());
    assert_eq!(snapshot(&f.store), before);
}

#[test]
fn recovery_work_checks_original_origin_after_waiting_for_the_local_mutex() {
    let f = fixture(true);
    let origin = recovery_work_origin(&input(&f, true));
    let guard = f.store.lock().unwrap();
    let owned = f.store.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || { send.send(()).unwrap(); owned.read_action_engine_quote_recovery_work(origin, 1) });
    receive.recv().unwrap();
    f.store.connect().unwrap().execute("UPDATE company_local_identity SET user_id='different-member'", []).unwrap();
    let before = snapshot(&f.store);
    drop(guard);
    assert!(reader.join().unwrap().unwrap_err().to_string().contains("action_engine:forbidden"));
    assert_eq!(snapshot(&f.store), before);
}

#[test]
fn recovery_work_missing_schema_is_an_error_without_implicit_installation_or_repair() {
    let f = fixture(true);
    let request = input(&f, true);
    f.store.connect().unwrap().execute_batch("DROP TABLE company_local_action_engine_quote_outbox").unwrap();
    assert!(f.store.read_action_engine_quote_recovery_work(recovery_work_origin(&request), 1).is_err());
    let exists: bool = f.store.connect().unwrap().query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='company_local_action_engine_quote_outbox')", [], |row| row.get(0)).unwrap();
    assert!(!exists, "read must not call ensure_schema or silently recreate an empty queue");
}

fn recovery_refuses(store: &LocalStore, selection: ActionEngineQuoteRecoverySelection, code: &str) {
    let before = snapshot(store);
    let error = store.recover_action_engine_quote_receipt(selection).unwrap_err();
    assert!(error.to_string().contains(&format!("action_engine:{code}")), "{error}");
    assert_eq!(snapshot(store), before, "recovery must not repair/recreate/mutate");
}
// Corrupt only an isolated synthetic fixture, never bypass a production guard.
fn corruptible_recovery_connection(store: &LocalStore) -> rusqlite::Connection {
    let db = store.connect().unwrap();
    db.execute_batch("PRAGMA foreign_keys=OFF;PRAGMA ignore_check_constraints=ON;
      DROP TRIGGER IF EXISTS action_engine_quote_receipt_update;
      DROP TRIGGER IF EXISTS action_engine_quote_receipt_delete;
      DROP TRIGGER IF EXISTS action_engine_quote_outbox_update;
      DROP TRIGGER IF EXISTS audit_log_no_update;
      DROP TRIGGER IF EXISTS audit_log_no_delete;").unwrap();
    db
}
fn replace_recovery_audit(db: &rusqlite::Connection, quote: &str, payload_json: &str) {
    let (id, time, actor, previous): (String, String, String, Option<String>) = db.query_row(
        "SELECT id,occurred_at,actor,previous_hash FROM audit_log WHERE action='create' AND entity_type='action_engine_quote' AND entity_id=?",
        [quote], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    let hash = sha(format!("{}\n{}\n{}\n{}\ncreate\naction_engine_quote\n{}\n{}",
        previous.as_deref().unwrap_or(""),id,time,actor,quote,payload_json).as_bytes());
    db.execute("UPDATE audit_log SET payload_json=?,entry_hash=? WHERE id=?",params![payload_json,hash,id]).unwrap();
}

#[test]
fn recovery_transaction_helper_reuses_the_callers_snapshot_without_locking_or_committing() {
    let f=fixture(true);
    let request=input(&f,true);
    f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let selection=recovery_selection(&request);
    let original=f.store.recover_action_engine_quote_receipt(selection.clone()).unwrap();
    let before=snapshot(&f.store);
    {
        let _caller_lock=f.store.lock().unwrap();
        let mut connection=f.store.connect().unwrap();
        let tx=connection.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
        tx.execute("UPDATE company_local_action_engine_quote_outbox SET state='uncertain',attempt_count=1,updated_at=created_at",[]).unwrap();
        // The helper must read this same uncommitted transaction and remain
        // independent of today's business rows, like the public recovery.
        tx.execute("DELETE FROM quote_items WHERE quote_id=?",[&request.quote_id]).unwrap();
        tx.execute("DELETE FROM quotes WHERE id=?",[&request.quote_id]).unwrap();
        let recovered=recover_action_engine_quote_receipt_in_transaction(&tx,&f.store,&selection).unwrap();
        assert_eq!(recovered.receipt,original.receipt);
        assert_eq!(recovered.receipt_sha256,original.receipt_sha256);
        assert_eq!(recovered.local_outbox_state,ActionEngineLocalQuoteOutboxState::Uncertain);
        assert_eq!(recovered.attempt_count,1);
        assert!(!tx.is_autocommit(),"only the caller may close its transaction");
        tx.rollback().unwrap();
    }
    assert_eq!(snapshot(&f.store),before,"helper must not escape the caller's rollback");
    assert_eq!(f.store.recover_action_engine_quote_receipt(selection).unwrap(),original);
}

#[test]
fn recovery_transaction_helper_keeps_selector_origin_and_missing_outbox_refusals() {
    let f=fixture(true);
    let request=input(&f,true);
    f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let selection=recovery_selection(&request);
    let before=snapshot(&f.store);
    {
        let _caller_lock=f.store.lock().unwrap();
        let mut connection=f.store.connect().unwrap();
        let tx=connection.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
        let mut malformed=selection.clone(); malformed.fingerprint.clear();
        assert!(recover_action_engine_quote_receipt_in_transaction(&tx,&f.store,&malformed)
            .unwrap_err().to_string().contains("action_engine:invalid_record"));
        let mut stale=selection.clone(); stale.expected_member_context_nonce="0".repeat(32);
        assert!(recover_action_engine_quote_receipt_in_transaction(&tx,&f.store,&stale)
            .unwrap_err().to_string().contains("action_engine:forbidden"));
        tx.execute("DELETE FROM company_local_action_engine_quote_outbox",[]).unwrap();
        assert!(recover_action_engine_quote_receipt_in_transaction(&tx,&f.store,&selection)
            .unwrap_err().to_string().contains("action_engine:recovery_uncertain"));
        assert_eq!(tx.query_row::<i64,_,_>("SELECT count(*) FROM company_local_action_engine_quote_outbox",[],|r|r.get(0)).unwrap(),0,
            "missing private history must never be backfilled");
        tx.execute("UPDATE company_local_identity SET user_id='different-member'",[]).unwrap();
        assert!(recover_action_engine_quote_receipt_in_transaction(&tx,&f.store,&selection)
            .unwrap_err().to_string().contains("action_engine:forbidden"),"origin is checked before absence");
        assert!(!tx.is_autocommit());
        tx.rollback().unwrap();
    }
    assert_eq!(snapshot(&f.store),before);
    assert!(f.store.recover_action_engine_quote_receipt(selection).is_ok());
}

#[test]
fn selector_recovery_reads_both_customer_branches_without_reusing_the_mail_or_plan() {
    for existing in [false, true] {
        let f = fixture(existing);
        if existing {
            // The existing native customer matcher trims/case-folds emails;
            // historical recovery must preserve that accepted stored text.
            f.store.connect().unwrap().execute("UPDATE clients SET email='  Camille@Example.ch  '",[]).unwrap();
        }
        let request = input(&f, existing);
        let receipt = f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
        let selected = recovery_selection(&request);
        let before = snapshot(&f.store);
        let recovered = f.store.recover_action_engine_quote_receipt(selected.clone()).unwrap();
        assert_eq!(recovered.receipt, receipt);
        assert_eq!(recovered.reservation_id, request.reservation_id);
        assert_eq!(recovered.receipt_sha256, sha(serde_json::to_string(&receipt).unwrap().as_bytes()));
        assert_eq!(recovered.local_outbox_state, ActionEngineLocalQuoteOutboxState::Pending);
        assert_eq!(recovered.attempt_count, 0);
        assert_eq!(snapshot(&f.store), before);
        let wire = serde_json::to_value(&recovered).unwrap();
        assert_eq!(wire.as_object().unwrap().len(), 5);
        assert!(wire.get("confirmed").is_none());
        let selection_wire = serde_json::to_value(selected).unwrap();
        for absent in ["source", "body", "canonicalPlanJson", "expectedResourcesHash"] {
            assert!(selection_wire.get(absent).is_none());
        }
        let reopened = LocalStore::initialize(f.store.data_dir.clone()).unwrap();
        assert_eq!(reopened.recover_action_engine_quote_receipt(recovery_selection(&request)).unwrap(), recovered);
    }
}

#[test]
fn selector_recovery_keeps_the_creation_fact_after_human_changes_issue_and_deletion() {
    for stage in ["edited", "issued", "deleted"] {
        // Issued documents are intentionally immutable; delete a separate
        // draft rather than asking the public repository to delete an issue.
        let f = fixture(true);
        let request = input(&f, true);
        let receipt = f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
        let selected = recovery_selection(&request);
        if stage == "edited" {
            f.store.update_record("quotes", &request.quote_id, json!({"title":"Human edited"})).unwrap();
        }
        let db = f.store.connect().unwrap();
        db.execute("UPDATE catalog_items SET archived_at='later',sales_price_cents=1",[]).unwrap();
        db.execute("UPDATE settings SET vat_number='CHE-123.456.789 TVA' WHERE id=1",[]).unwrap();
        db.execute("UPDATE clients SET address_line1='Rue fictive 1',postal_code='1200',city='Genève' WHERE id=?",[&request.customer_id]).unwrap();
        drop(db);
        match stage {
            "issued" => { f.store.issue_quote(&request.quote_id,Some("2026-10-11".into()),Some("2026-11-10".into())).unwrap(); }
            "deleted" => { f.store.delete_record("quotes", &request.quote_id).unwrap(); }
            _ => {}
        }
        let before = snapshot(&f.store);
        let recovered = f.store.recover_action_engine_quote_receipt(selected.clone()).unwrap();
        assert_eq!(recovered.receipt, receipt, "{stage}");
        assert!(recovered.receipt.quote_number.is_none());
        assert_eq!(recovered.receipt.status,"draft");
        assert!(!frozen_quote_publication_matches(&f.store.connect().unwrap(),&request.actor.organization_id,
            &request.proposal_id,&request.reservation_id,&request.fingerprint,&request.quote_id,
            &recovered.receipt_sha256).unwrap(),"{stage} cannot be a first initial-draft publication proof");
        assert_eq!(snapshot(&f.store),before,"{stage}");
    }
}

#[test]
fn recovery_local_outbox_status_does_not_invent_a_canonical_confirmation() {
    let f = fixture(true);
    let request = input(&f,true);
    f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    for (state, expected) in [("uncertain",ActionEngineLocalQuoteOutboxState::Uncertain),
        ("confirmed",ActionEngineLocalQuoteOutboxState::Confirmed)] {
        f.store.connect().unwrap().execute(
            "UPDATE company_local_action_engine_quote_outbox SET state=?,attempt_count=attempt_count+1,updated_at=?",
            params![state,now_iso()]).unwrap();
        let before = snapshot(&f.store);
        let result = f.store.recover_action_engine_quote_receipt(recovery_selection(&request)).unwrap();
        assert_eq!(result.local_outbox_state,expected);
        assert!(serde_json::to_value(result).unwrap().get("canonicalEvidence").is_none());
        assert_eq!(snapshot(&f.store),before);
    }
}

#[test]
fn recovery_missing_or_orphaned_durable_rows_are_uncertain_not_none_or_a_retry() {
    for missing in ["both", "outbox", "receipt", "audit", "schema"] {
        let f = fixture(true);
        let request = input(&f,true);
        if missing != "both" { f.store.commit_action_engine_quote_draft(request.clone()).unwrap(); }
        let db = corruptible_recovery_connection(&f.store);
        match missing {
            "outbox" => { db.execute("DELETE FROM company_local_action_engine_quote_outbox",[]).unwrap(); }
            "receipt" => { db.execute("DELETE FROM action_engine_quote_receipts",[]).unwrap(); }
            "audit" => { db.execute("DELETE FROM audit_log WHERE entity_type='action_engine_quote'",[]).unwrap(); }
            "schema" => { db.execute_batch("DROP TABLE company_local_action_engine_quote_outbox").unwrap(); }
            _ => {}
        }
        drop(db);
        if missing == "schema" {
            assert!(f.store.recover_action_engine_quote_receipt(recovery_selection(&request)).unwrap_err()
                .to_string().contains("action_engine:recovery_uncertain"));
        } else { recovery_refuses(&f.store,recovery_selection(&request),"recovery_uncertain"); }
    }
}

#[test]
fn recovery_requires_fresh_physical_origin_member_identity_and_original_selectors() {
    let f = fixture(true);
    let request = input(&f,true);
    f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    for field in ["workspace", "nonce", "installation", "organization", "user", "source", "proposal", "reservation", "fingerprint"] {
        let mut selection = recovery_selection(&request);
        let code = match field {
            "workspace" => { selection.expected_workspace_scope=Uuid::new_v4().to_string(); "forbidden" }
            "nonce" => { selection.expected_member_context_nonce="0".repeat(32); "forbidden" }
            "installation" => { selection.installation_id=Uuid::new_v4().to_string(); "forbidden" }
            "organization" => { selection.actor.organization_id="company-b".into(); "forbidden" }
            "user" => { selection.actor.user_id="another-user".into(); "forbidden" }
            "source" => { selection.source_id="another-source".into(); "recovery_uncertain" }
            "proposal" => { selection.proposal_id=Uuid::new_v4().to_string(); "recovery_uncertain" }
            "reservation" => { selection.reservation_id=Uuid::new_v4().to_string(); "recovery_uncertain" }
            _ => { selection.fingerprint="0".repeat(64); "recovery_uncertain" }
        };
        recovery_refuses(&f.store,selection,code);
    }
    f.store.connect().unwrap().execute("UPDATE company_local_identity SET role='read_only'",[]).unwrap();
    let mut selection = recovery_selection(&request);
    selection.expected_member_context_nonce=crate::member_context::read(&f.store.connect().unwrap()).unwrap();
    recovery_refuses(&f.store,selection,"forbidden");
}

#[test]
fn recovery_checks_origin_after_waiting_for_the_store_mutex() {
    let f=fixture(true);
    let request=input(&f,true);
    f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let selected=recovery_selection(&request);
    let guard=f.store.lock().unwrap();
    let owned=f.store.clone();
    let (send,receive)=std::sync::mpsc::channel();
    let reader=std::thread::spawn(move || { send.send(()).unwrap(); owned.recover_action_engine_quote_receipt(selected) });
    receive.recv().unwrap();
    f.store.connect().unwrap().execute("UPDATE company_local_identity SET user_id='different-member'",[]).unwrap();
    let before=snapshot(&f.store);
    drop(guard);
    assert!(reader.join().unwrap().unwrap_err().to_string().contains("action_engine:forbidden"));
    assert_eq!(snapshot(&f.store),before);
}

#[test]
fn recovery_rejects_hash_type_budget_and_closed_json_corruption_without_repair() {
    for mutation in ["plan_hash", "receipt_hash", "request_hash", "payload_hash", "payload_identity",
        "payload_duplicate", "payload_unknown", "receipt_missing_null", "receipt_duplicate",
        "receipt_unknown", "plan_unknown", "blob_plan", "oversize_plan", "counter_type", "state"] {
        let f=fixture(true);
        let request=input(&f,true);
        f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
        let db=corruptible_recovery_connection(&f.store);
        let mut selected=recovery_selection(&request);
        match mutation {
            "plan_hash" => { db.execute("UPDATE action_engine_quote_receipts SET plan_json=plan_json||' '",[]).unwrap(); }
            "receipt_hash" => { db.execute("UPDATE action_engine_quote_receipts SET receipt_sha256=?",["0".repeat(64)]).unwrap(); }
            "request_hash" => { db.execute("UPDATE action_engine_quote_receipts SET request_sha256=?",["0".repeat(64)]).unwrap(); }
            "payload_hash" => { db.execute("UPDATE company_local_action_engine_quote_outbox SET payload_sha256=?",["0".repeat(64)]).unwrap(); }
            "blob_plan" => { db.execute("UPDATE action_engine_quote_receipts SET plan_json=CAST(plan_json AS BLOB)",[]).unwrap(); }
            "oversize_plan" => { db.execute("UPDATE action_engine_quote_receipts SET plan_json=?",[" ".repeat(65_537)]).unwrap(); }
            "counter_type" => { db.execute("UPDATE company_local_action_engine_quote_outbox SET attempt_count=0.5",[]).unwrap(); }
            "state" => { db.execute("UPDATE company_local_action_engine_quote_outbox SET state='unknown'",[]).unwrap(); }
            "plan_unknown" => {
                let raw:String=db.query_row("SELECT plan_json FROM action_engine_quote_receipts",[],|r|r.get(0)).unwrap();
                let changed=format!("{{\"unknown\":1,{}",&raw[1..]);
                selected.fingerprint=sha(changed.as_bytes());
                db.execute("UPDATE action_engine_quote_receipts SET plan_json=?,fingerprint=?",params![changed,selected.fingerprint]).unwrap();
            }
            "receipt_missing_null" | "receipt_duplicate" | "receipt_unknown" => {
                let raw:String=db.query_row("SELECT receipt_json FROM action_engine_quote_receipts",[],|r|r.get(0)).unwrap();
                let changed=match mutation {
                    "receipt_missing_null" => raw.replace("\"quoteNumber\":null,",""),
                    "receipt_duplicate" => format!("{{\"quoteNumber\":null,{}",&raw[1..]),
                    _ => format!("{{\"unknown\":1,{}",&raw[1..]),
                };
                db.execute("UPDATE action_engine_quote_receipts SET receipt_json=?,receipt_sha256=?",params![changed,sha(changed.as_bytes())]).unwrap();
            }
            _ => {
                let raw:String=db.query_row("SELECT payload_json FROM company_local_action_engine_quote_outbox",[],|r|r.get(0)).unwrap();
                let changed=match mutation {
                    "payload_duplicate" => format!("{{\"quoteId\":\"{}\",{}",request.quote_id,&raw[1..]),
                    "payload_unknown" => format!("{{\"unknown\":1,{}",&raw[1..]),
                    _ => { let mut value:Value=serde_json::from_str(&raw).unwrap(); value["customerId"]=json!(Uuid::new_v4().to_string()); serde_json::to_string(&value).unwrap() }
                };
                db.execute("UPDATE company_local_action_engine_quote_outbox SET payload_json=?,payload_sha256=?",params![changed,sha(changed.as_bytes())]).unwrap();
            }
        }
        drop(db);
        recovery_refuses(&f.store,selected,"recovery_uncertain");
    }
}

#[test]
fn recovery_corroborates_unique_closed_audit_creation_and_source_request_hash() {
    for mutation in ["entry_hash", "duplicate_event", "unknown", "duplicate", "quantity", "creation_hash", "source_hash",
        "creation_duplicate", "creation_unknown", "creation_missing_null"] {
        let f=fixture(true);
        let request=input(&f,true);
        f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
        let (_,mut payload)=creation_event(&f.store,&request.quote_id);
        let db=corruptible_recovery_connection(&f.store);
        match mutation {
            "entry_hash" => { db.execute("UPDATE audit_log SET entry_hash=? WHERE entity_type='action_engine_quote'",["0".repeat(64)]).unwrap(); }
            "duplicate_event" => {
                db.execute("INSERT INTO audit_log SELECT ?,occurred_at,actor,action,entity_type,entity_id,payload_json,previous_hash,? FROM audit_log WHERE entity_type='action_engine_quote'",
                    params![Uuid::new_v4().to_string(),"1".repeat(64)]).unwrap();
            }
            _ => {
                match mutation {
                    "quantity" => payload["quantityMilli"]=json!([4000]),
                    "creation_hash" => payload["creationSha256"]=json!("0".repeat(64)),
                    "source_hash" => {
                        let mut creation:Value=serde_json::from_str(payload["creationJson"].as_str().unwrap()).unwrap();
                        creation["sourceCanonicalSha256"]=json!("0".repeat(64));
                        // Preserve native typed order; hashes remain internally valid
                        // until request_sha256 is recomputed from this forged source.
                        let typed:QuoteCreation=serde_json::from_value(creation).unwrap();
                        let raw=serde_json::to_string(&typed).unwrap();
                        payload["creationSha256"]=json!(sha(raw.as_bytes())); payload["creationJson"]=json!(raw);
                    }
                    "creation_duplicate" | "creation_unknown" | "creation_missing_null" => {
                        let original=payload["creationJson"].as_str().unwrap();
                        let raw=match mutation {
                            "creation_duplicate"=>format!("{{\"version\":1,{}",&original[1..]),
                            "creation_unknown"=>format!("{{\"unknown\":true,{}",&original[1..]),
                            _=>original.replace("\"projectId\":null,",""),
                        };
                        payload["creationSha256"]=json!(sha(raw.as_bytes())); payload["creationJson"]=json!(raw);
                    }
                    _ => {}
                }
                let raw=serde_json::to_string(&payload).unwrap();
                let changed=match mutation {
                    "unknown"=>format!("{{\"unknown\":1,{}",&raw[1..]),
                    "duplicate"=>format!("{{\"netCents\":59700,{}",&raw[1..]),
                    _=>raw,
                };
                replace_recovery_audit(&db,&request.quote_id,&changed);
            }
        }
        drop(db);
        recovery_refuses(&f.store,recovery_selection(&request),"recovery_uncertain");
    }
}

#[test]
fn frozen_publication_requires_initial_actual_customer_quote_and_all_lines() {
    for mutation in ["none", "customer", "quote", "line", "quantity", "deleted", "extra_line"] {
        let f=fixture(true);
        let request=input(&f,true);
        let receipt=f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
        let receipt_sha=sha(serde_json::to_string(&receipt).unwrap().as_bytes());
        let db=f.store.connect().unwrap();
        match mutation {
            "customer"=>{ db.execute("UPDATE clients SET name='Human renamed' WHERE id=?",[&request.customer_id]).unwrap(); }
            "quote"=>{ db.execute("UPDATE quotes SET title='Human edited' WHERE id=?",[&request.quote_id]).unwrap(); }
            "line"=>{ db.execute("UPDATE quote_items SET description='Human edited' WHERE quote_id=?",[&request.quote_id]).unwrap(); }
            "quantity"=>{ db.execute("UPDATE quote_items SET quantity=3.1 WHERE quote_id=?",[&request.quote_id]).unwrap(); }
            "deleted"=>{ db.execute("DELETE FROM quote_items WHERE quote_id=?",[&request.quote_id]).unwrap(); db.execute("DELETE FROM quotes WHERE id=?",[&request.quote_id]).unwrap(); }
            "extra_line"=>{ db.execute("INSERT INTO quote_items(id,quote_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at) SELECT ?,quote_id,catalog_item_id,position+1,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at FROM quote_items WHERE quote_id=?",
                params![Uuid::new_v4().to_string(),request.quote_id]).unwrap(); }
            _=>{}
        }
        let before=snapshot(&f.store);
        assert_eq!(frozen_quote_publication_matches(&db,&request.actor.organization_id,&request.proposal_id,
            &request.reservation_id,&request.fingerprint,&request.quote_id,&receipt_sha).unwrap(),mutation=="none","{mutation}");
        assert_eq!(f.store.recover_action_engine_quote_receipt(recovery_selection(&request)).unwrap().receipt,receipt);
        assert_eq!(snapshot(&f.store),before);
    }
}

#[test]
fn frozen_publication_missing_receipt_is_older_archive_but_corrupt_history_is_an_error() {
    let f=fixture(true);
    let request=input(&f,true);
    let receipt_sha="0".repeat(64);
    let db=f.store.connect().unwrap();
    assert!(!frozen_quote_publication_matches(&db,&request.actor.organization_id,&request.proposal_id,
        &request.reservation_id,&request.fingerprint,&request.quote_id,&receipt_sha).unwrap());
    drop(db);
    let receipt=f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let db=f.store.connect().unwrap();
    assert!(frozen_quote_publication_matches(&db,&request.actor.organization_id,&request.proposal_id,
        &request.reservation_id,&request.fingerprint,&request.quote_id,&receipt_sha).is_err());
    drop(db);
    let db=corruptible_recovery_connection(&f.store);
    db.execute("UPDATE audit_log SET entry_hash=? WHERE entity_type='action_engine_quote'",["0".repeat(64)]).unwrap();
    assert!(frozen_quote_publication_matches(&db,&request.actor.organization_id,&request.proposal_id,
        &request.reservation_id,&request.fingerprint,&request.quote_id,
        &sha(serde_json::to_string(&receipt).unwrap().as_bytes())).is_err());
}

#[test]
fn recovery_selection_is_closed_and_malformed_selectors_never_read_a_receipt() {
    let f=fixture(true);
    let request=input(&f,true);
    f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let value=serde_json::to_value(recovery_selection(&request)).unwrap();
    let mut unknown=value.clone(); unknown["body"]=json!("not accepted");
    assert!(serde_json::from_value::<ActionEngineQuoteRecoverySelection>(unknown).is_err());
    let raw=serde_json::to_string(&value).unwrap();
    assert!(serde_json::from_str::<ActionEngineQuoteRecoverySelection>(&format!("{{\"sourceId\":\"ticket-a\",{}",&raw[1..])).is_err());
    for malformed in ["UPPERCASE", "not-a-hash", ""] {
        let mut selected=recovery_selection(&request); selected.fingerprint=malformed.into();
        recovery_refuses(&f.store,selected,"invalid_record");
    }
}

#[test]
fn old_sync_flights_block_new_drafts_but_not_a_matching_historical_receipt() {
    for state in ["pending", "received", "conflict", "foreign", "default"] {
        for historical in [false,true] {
            let f=fixture(true);
            let request=input(&f,true);
            let original=if historical { Some(f.store.commit_action_engine_quote_draft(request.clone()).unwrap()) } else { None };
            // Valid bounded transport metadata suffices for the existing prefs
            // loader; these bytes are not presented as a published ZIP proof.
            let path=f.directory.path().join("synthetic-transport.bin");
            std::fs::write(&path,b"synthetic transport metadata fixture").unwrap();
            let manifest=crate::cloud_backup::file_manifest(&path).unwrap();
            let value=match state {
                "pending"=>json!({"organization_id":"company-a","pending":{
                    "id":Uuid::new_v4().to_string(),"base_revision":0,"clock":0,"manifest":manifest,"content_version":2}}),
                "received"=>json!({"organization_id":"company-a","received":{
                    "id":Uuid::new_v4().to_string(),"organization":"company-a","revision":1,"clock":0,"manifest":manifest}}),
                "conflict"=>json!({"organization_id":"company-a","conflict":true}),
                "foreign"=>json!({"organization_id":"company-b"}),
                _=>json!({}),
            };
            let prefs=f.store.data_dir.join("company-collaboration.json");
            let bytes=serde_json::to_vec(&value).unwrap();
            std::fs::write(&prefs,&bytes).unwrap();
            let before=snapshot(&f.store);
            match f.store.commit_action_engine_quote_draft(request.clone()) {
                Ok(receipt)=>{
                    assert!(historical || state=="default","new draft bypassed {state}");
                    if let Some(expected)=original { assert_eq!(receipt,expected); assert_eq!(snapshot(&f.store),before); }
                }
                Err(_)=>{ assert!(!historical && state!="default","historical replay was blocked by {state}"); assert_eq!(snapshot(&f.store),before); }
            }
            assert_eq!(std::fs::read(prefs).unwrap(),bytes,"guard must not settle or discard a flight");
        }
    }
}

#[test]
fn creation_evidence_is_read_from_real_customer_quote_and_lines_for_both_customer_branches() {
    for existing in [false, true] {
        let f = fixture(existing);
        let request = input(&f, existing);
        let receipt = f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
        let (_, payload) = creation_event(&f.store, &request.quote_id);
        let raw = payload["creationJson"].as_str().unwrap();
        let creation: QuoteCreation = serde_json::from_str(raw).unwrap();
        assert_eq!(sha(raw.as_bytes()), payload["creationSha256"].as_str().unwrap());
        assert_eq!(serde_json::to_string(&creation).unwrap(), raw, "typed compact serialization has a fixed field order");
        assert_eq!(creation.version, 1);
        assert_eq!(creation.customer_created, !existing);
        assert_eq!(creation.source_canonical_sha256, sha(&serde_json::to_vec(&request.source).unwrap()));
        assert_eq!(payload["receipt"], serde_json::to_value(receipt).unwrap());
        let current = snapshot(&f.store);
        let customer = &current["clients"][0];
        let quote = &current["quotes"][0];
        let line = &current["quote_items"][0];
        assert_eq!(creation.customer.id, customer["id"].as_str().unwrap());
        assert_eq!(creation.customer.name, customer["name"].as_str().unwrap());
        assert_eq!(creation.customer.email.as_deref(), customer["email"].as_str());
        assert_eq!(creation.customer.country, customer["country"].as_str().unwrap());
        assert_eq!(creation.customer.created_at, customer["created_at"].as_str().unwrap());
        assert_eq!(creation.customer.updated_at, customer["updated_at"].as_str().unwrap());
        assert!(creation.customer.archived_at.is_none());
        assert_eq!(creation.quote.id, quote["id"].as_str().unwrap());
        assert_eq!(creation.quote.client_id, quote["client_id"].as_str().unwrap());
        assert_eq!(creation.quote.title, quote["title"].as_str().unwrap());
        assert_eq!(creation.quote.issue_date, quote["issue_date"].as_str().unwrap());
        assert_eq!(creation.quote.valid_until, quote["valid_until"].as_str().unwrap());
        assert_eq!(creation.quote.subtotal_cents, quote["subtotal_cents"].as_i64().unwrap());
        assert_eq!(creation.quote.vat_cents, quote["vat_cents"].as_i64().unwrap());
        assert_eq!(creation.quote.total_cents, quote["total_cents"].as_i64().unwrap());
        assert_eq!(creation.quote.created_at, quote["created_at"].as_str().unwrap());
        assert_eq!(creation.quote.updated_at, quote["updated_at"].as_str().unwrap());
        assert!(creation.quote.number.is_none() && creation.quote.project_id.is_none()
            && creation.quote.notes.is_none() && creation.quote.terms.is_none() && creation.quote.snapshot_json.is_none());
        assert_eq!(creation.lines.len(), 1);
        assert_eq!(creation.lines[0].id, line["id"].as_str().unwrap());
        assert_eq!(creation.lines[0].catalog_item_id, line["catalog_item_id"].as_str().unwrap());
        assert_eq!(creation.lines[0].quantity_milli, 3000);
        assert_eq!(creation.lines[0].quantity_milli as f64 / 1000.0, line["quantity"].as_f64().unwrap());
        assert_eq!(creation.lines[0].line_net_cents, line["line_net_cents"].as_i64().unwrap());
        assert_eq!(creation.lines[0].line_vat_cents, line["line_vat_cents"].as_i64().unwrap());
        assert_eq!(creation.lines[0].line_total_cents, line["line_total_cents"].as_i64().unwrap());
        assert_eq!(creation.lines[0].created_at, line["created_at"].as_str().unwrap());
        assert_eq!(creation.lines[0].updated_at, line["updated_at"].as_str().unwrap());
        assert_eq!(f.store.verify_audit_log().unwrap()["valid"], true);
    }
}

#[test]
fn typed_creation_json_preserves_unicode_nulls_and_order_without_source_mail_or_local_secrets() {
    let f = fixture(false);
    let mut request = input(&f, false);
    request.source.sender_name = "Équipe 🚀 \"Léman\" \\ \u{2028} Deuxième\nligne".into();
    request.source.subject = "Offre 🚀 \"Léman\" \\ \u{2028} fin".into();
    request.source.body.push_str("\nRAW_MAIL_PRIVATE_SENTINEL");
    let customer_name = request.source.sender_name.clone();
    let quote_title = request.source.subject.clone();
    change_plan(&mut request, |plan| {
        plan["customer"]["name"] = json!(customer_name);
        plan["title"] = json!(quote_title);
    });
    f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let (_, payload) = creation_event(&f.store, &request.quote_id);
    let raw = payload["creationJson"].as_str().unwrap();
    let creation: QuoteCreation = serde_json::from_str(raw).unwrap();
    assert_eq!(creation.customer.name, request.source.sender_name);
    assert_eq!(creation.quote.title, request.source.subject);
    assert!(raw.starts_with("{\"version\":1,\"sourceCanonicalSha256\":"));
    assert!(raw.contains(",\"customerCreated\":true,\"customer\":{\"id\":"));
    assert!(raw.contains(",\"projectId\":null,\"number\":null,\"title\":"));
    assert!(raw.contains(",\"description\":\"Radiateur\",\"quantityMilli\":3000,\"unit\":"));
    assert_eq!(raw, serde_json::to_string(&creation).unwrap());
    assert_eq!(sha(raw.as_bytes()), payload["creationSha256"].as_str().unwrap());
    for private in ["RAW_MAIL_PRIVATE_SENTINEL", request.expected_workspace_scope.as_str(),
        request.expected_member_context_nonce.as_str(), request.installation_id.as_str(), "senderEmail", "senderName"] {
        assert!(!raw.contains(private), "private source/origin value was copied into creation evidence: {private}");
    }
    let mut unknown: Value = serde_json::from_str(raw).unwrap();
    unknown["unexpected"] = json!(true);
    assert!(serde_json::from_value::<QuoteCreation>(unknown).is_err());
    let duplicate = raw.replacen("{\"version\":1,", "{\"version\":1,\"version\":1,", 1);
    assert!(serde_json::from_str::<QuoteCreation>(&duplicate).is_err());
}

#[test]
fn creation_evidence_remains_historical_after_human_edits_and_deletion_without_recreation() {
    let f = fixture(true);
    let request = input(&f, true);
    let receipt = f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let original_event = creation_event(&f.store, &request.quote_id);
    f.store.update_record("quotes", &request.quote_id, json!({"title":"Human edited after creation"})).unwrap();
    f.store.update_record("clients", &request.customer_id, json!({"name":"Human changed client name"})).unwrap();
    f.store.update_record("quote_items", &line_id(&request, 0), json!({"quantity":4})).unwrap();
    assert_eq!(creation_event(&f.store, &request.quote_id), original_event);
    assert_eq!(f.store.commit_action_engine_quote_draft(request.clone()).unwrap(), receipt);
    f.store.delete_record("quotes", &request.quote_id).unwrap();
    let deleted = snapshot(&f.store);
    assert_eq!(f.store.commit_action_engine_quote_draft(request.clone()).unwrap(), receipt);
    assert_eq!(snapshot(&f.store), deleted);
    assert_eq!(creation_event(&f.store, &request.quote_id), original_event);
    let creation: QuoteCreation = serde_json::from_str(original_event.1["creationJson"].as_str().unwrap()).unwrap();
    assert_eq!(creation.quote.title, "Devis radiateurs");
    assert_eq!(creation.lines[0].quantity_milli, 3000);
    assert_eq!(creation.customer.name, "Camille Exemple");
    // This local historical receipt is not authorization for first central
    // confirmation after those edits/deletion. That server proof stays closed.
    assert_eq!(f.store.verify_audit_log().unwrap()["valid"], true);
}

#[test]
fn issuance_does_not_rewrite_the_initial_unnumbered_creation_evidence_or_receipt() {
    let f = fixture(true);
    let request = input(&f, true);
    let receipt = f.store.commit_action_engine_quote_draft(request.clone()).unwrap();
    let original_event = creation_event(&f.store, &request.quote_id);
    let db = f.store.connect().unwrap();
    db.execute("UPDATE settings SET vat_number='CHE-123.456.789 TVA' WHERE id=1", []).unwrap();
    db.execute("UPDATE clients SET address_line1='Rue fictive 1',postal_code='1200',city='Genève' WHERE id=?", [&request.customer_id]).unwrap();
    drop(db);
    let issued = f.store.issue_quote(&request.quote_id, Some("2026-10-11".into()), Some("2026-11-10".into())).unwrap();
    assert_eq!(issued["status"], "emis");
    assert!(issued["number"].as_str().is_some_and(|number| !number.is_empty()));
    assert_eq!(creation_event(&f.store, &request.quote_id), original_event);
    assert_eq!(f.store.commit_action_engine_quote_draft(request).unwrap(), receipt);
    assert!(receipt.quote_number.is_none());
    assert_eq!(receipt.status, "draft");
    // An issued current quote must not be mistaken for an initial draft by the
    // future first-confirmation verifier; this test proves only local history.
    assert_eq!(f.store.verify_audit_log().unwrap()["valid"], true);
}

#[test]
fn changed_stored_values_before_creation_readback_roll_back_every_native_effect() {
    for mutation in ["quantity", "money", "title", "customer"] {
        let f = fixture(false);
        let request = input(&f, false);
        let sql = match mutation {
            "quantity" => "CREATE TRIGGER qa_corrupt_creation AFTER INSERT ON quote_items BEGIN UPDATE quote_items SET quantity=quantity+0.001 WHERE id=NEW.id; END;",
            "money" => "CREATE TRIGGER qa_corrupt_creation AFTER INSERT ON quote_items BEGIN UPDATE quote_items SET unit_price_cents=unit_price_cents+0.5 WHERE id=NEW.id; END;",
            "title" => "CREATE TRIGGER qa_corrupt_creation AFTER INSERT ON quotes BEGIN UPDATE quotes SET title='Changed by synthetic trigger' WHERE id=NEW.id; END;",
            "customer" => "CREATE TRIGGER qa_corrupt_creation AFTER INSERT ON clients BEGIN UPDATE clients SET name='Changed by synthetic trigger' WHERE id=NEW.id; END;",
            _ => unreachable!(),
        };
        f.store.connect().unwrap().execute_batch(sql).unwrap();
        let before = snapshot(&f.store);
        assert!(f.store.commit_action_engine_quote_draft(request).is_err(), "{mutation}");
        assert_eq!(snapshot(&f.store), before, "readback failure must roll back customer/quote/receipt/audit/outbox: {mutation}");
    }
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
    let quote_id = request.quote_id.clone();
    f.store.commit_action_engine_quote_draft(request).unwrap();
    let data = snapshot(&f.store);
    assert_eq!(data["quote_items"][0]["quantity"], 0.125);
    assert_eq!(data["quote_items"][0]["line_net_cents"], 2488);
    assert_eq!(data["quote_items"][0]["line_vat_cents"], 202);
    assert_eq!(data["quotes"][0]["total_cents"], 2690);
    let (_, evidence) = creation_event(&f.store, &quote_id);
    let creation: QuoteCreation = serde_json::from_str(evidence["creationJson"].as_str().unwrap()).unwrap();
    assert_eq!(creation.lines[0].quantity_milli, 125);
    assert_eq!(creation.lines[0].line_net_cents, 2488);
    assert_eq!(creation.lines[0].line_vat_cents, 202);
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
    let mut b = LocalStore::initialize(f.directory.path().join("profile")).unwrap();
    test_license::configure(&mut b);
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
    let mut reopened = LocalStore::initialize(directory.path().join("profile")).unwrap();
    test_license::configure(&mut reopened);
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
    let mut reopened = LocalStore::initialize(f.directory.path().join("profile")).unwrap();
    test_license::configure(&mut reopened);
    let db = reopened.connect().unwrap();
    assert_eq!(
        db.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        crate::schema::SCHEMA_VERSION
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
    let creation = creation_event(&f.store, &request.quote_id);
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
    let (copied_id, copied_payload): (String, String) = copied.query_row(
        "SELECT id,payload_json FROM audit_log WHERE action='create' AND entity_type='action_engine_quote' AND entity_id=?",
        [&request.quote_id], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(copied_id, creation.0);
    let copied_payload: Value = serde_json::from_str(&copied_payload).unwrap();
    assert_eq!(copied_payload, creation.1);
    assert_eq!(sha(copied_payload["creationJson"].as_str().unwrap().as_bytes()),
        copied_payload["creationSha256"].as_str().unwrap());
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
    copied.pragma_update(None,"query_only",true).unwrap();
    assert!(frozen_quote_publication_matches(&copied,&request.actor.organization_id,&request.proposal_id,
        &request.reservation_id,&request.fingerprint,&request.quote_id,
        &sha(serde_json::to_string(&receipt).unwrap().as_bytes())).unwrap(),
        "a real stripped archive contains initial business facts but no private outbox");
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
    assert!(f.store.recover_action_engine_quote_receipt(recovery_selection(&request)).unwrap_err()
        .to_string().contains("action_engine:recovery_uncertain"),
        "manual restore must not backfill a missing private recovery outbox");
    assert_eq!(snapshot(&f.store),restored);
    assert_eq!(
        f.store.commit_action_engine_quote_draft(request).unwrap(),
        receipt
    );
    assert_eq!(snapshot(&f.store), restored);
    assert_eq!(creation_event(&f.store, &receipt.quote_id), creation);
    assert_eq!(f.store.verify_audit_log().unwrap()["valid"], true);
}
