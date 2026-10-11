//! Actual LocalStore/SQLite/ZIP and prepare/upload/confirmation workers. Only
//! the HTTP edge is a closed synthetic transport. These tests establish no
//! remote admission, PostgreSQL/D1 result, A7 evidence or native execution.
use super::*;
use crate::{
    action_engine_quote::{ActionEngineQuoteActor,ActionEngineQuoteInput,ActionEngineQuoteSource},
    action_engine_resources::{article_revision,export_resources,resource_hash},
};
use std::sync::{Arc,Mutex};
use uuid::Uuid;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD,Engine};
use chrono::{Duration as ChronoDuration,Local,Utc};
use ed25519_dalek::{Signer,SigningKey};

const ORGANIZATION:&str="qa-action-execution-company";
const USER:&str="qa-action-owner";

// Compile-time witness for the consumer's tauri::async_runtime::spawn. Merely
// constructs/drops futures; never polls HTTP. Native CI still must compile it.
const _:fn(&LocalStore,&ProjectSyncSession)=|store,session| {
    fn require_send<T:Send>(_:T) {}
    require_send(recover_action_engine_publication(store,session));
    require_send(publish_action_engine_quote(store,session));
};

struct Fixture { _directory:tempfile::TempDir,store:LocalStore,input:ActionEngineQuoteInput }
fn signed_fixture_token(store:&LocalStore,role:&str)->String {
    let signing=SigningKey::from_bytes(&[31;32]);
    let now=Utc::now();let today=Local::now().date_naive();
    let payload=crate::models::LicenseTokenPayload {
        token_version:2,license_id:Uuid::new_v4().to_string(),installation_id:store.installation_id.clone(),
        jti:Uuid::new_v4().to_string(),kid:"hc-prod-v1".into(),customer_name:Some("Synthetic Action execution company".into()),
        access_role:role.into(),account_user_id:None,account_session_id:None,
        plan:crate::license::LICENSE_PLAN.into(),price_chf_cents:crate::license::LICENSE_PRICE_CHF_CENTS,
        issued_at:now.to_rfc3339(),valid_from:(today-ChronoDuration::days(1)).format("%Y-%m-%d").to_string(),
        valid_until:(today+ChronoDuration::days(30)).format("%Y-%m-%d").to_string(),
    };
    let encoded=URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
    format!("{encoded}.{}",URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes()))
}
fn fixture(enabled:bool)->Fixture {
    let directory=tempfile::tempdir().unwrap();
    let mut store=LocalStore::initialize(directory.path().join("profile")).unwrap();
    // A public synthetic authority scoped to this store exercises the actual
    // signature/installation/role/clock/write path, even in a debug build with
    // no embedded key. This does not establish paid or remote entitlement.
    store.configure_test_license_key(SigningKey::from_bytes(&[31;32]).verifying_key().to_bytes());
    store.complete_onboarding(crate::tests::test_onboarding(),env!("CARGO_PKG_VERSION")).unwrap();
    let licensed=store.install_server_issued_license(&signed_fixture_token(&store,"owner")).unwrap();
    assert_eq!(licensed["status"],"valid");assert_eq!(licensed["read_only"],false);
    store.require_write_access().unwrap();store.clone().require_write_access().unwrap();
    set_identity(&store,ORGANIZATION,USER,"QA owner","owner").unwrap();
    let db=store.connect().unwrap();
    db.execute("UPDATE settings SET vat_registered=1,default_vat_bp=810,updated_at='2026-10-11T00:00:00Z' WHERE id=1",[]).unwrap();
    let article=Uuid::new_v4().to_string();
    db.execute("INSERT INTO catalog_items(id,kind,sku,name,description,unit,sales_price_cents,vat_bp,created_at,updated_at)
        VALUES(?,'product','RAD-100','Radiateur','radiateurs','pièce',19900,810,'2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')",[&article]).unwrap();
    let resources=export_resources(&db).unwrap();
    let plan=json!({"schemaVersion":1,"engineVersion":"action-engine-quote-v1","kind":"prepare_quote_draft",
        "organizationId":ORGANIZATION,"contextRevision":"qa-action-mail-v1","sourceId":"qa-mail-1","sourceRevision":"mail-v1",
        "status":"ready","reasons":[],"customer":{"kind":"new","name":"Camille Exemple","email":"camille@example.ch"},
        "title":"Devis radiateurs","currency":"CHF","lines":[{"articleId":article,"articleRevision":article_revision(&resources.articles[0]),
            "description":"Radiateur","unit":"pièce","quantityMilli":3000,"unitPriceCents":19900,"taxRateBp":810,
            "netCents":59700,"evidence":"3 radiateurs"}],"netCents":59700,"confidence":0.99,"requiresHumanValidation":true});
    let canonical=plan.to_string();
    let input=ActionEngineQuoteInput {
        fingerprint:format!("{:x}",Sha256::digest(canonical.as_bytes())),canonical_plan_json:canonical,
        proposal_id:Uuid::new_v4().to_string(),reservation_id:Uuid::new_v4().to_string(),
        source:ActionEngineQuoteSource {id:"qa-mail-1".into(),revision:"mail-v1".into(),organization_id:ORGANIZATION.into(),
            sender_email:"camille@example.ch".into(),sender_name:"Camille Exemple".into(),subject:"Devis radiateurs".into(),body:"3 radiateurs".into()},
        actor:ActionEngineQuoteActor {organization_id:ORGANIZATION.into(),user_id:USER.into()},installation_id:store.installation_id.clone(),
        expected_workspace_scope:crate::work_notes::workspace_scope(&db).unwrap(),expected_member_context_nonce:crate::member_context::read(&db).unwrap(),
        expected_resources_hash:resource_hash(&resources),expected_context_revision:"qa-action-mail-v1".into(),
        customer_id:Uuid::new_v4().to_string(),quote_id:Uuid::new_v4().to_string(),
    };
    drop(db);
    if enabled { save(&store,&Preferences {organization_id:Some(ORGANIZATION.into()),base_clock:clock(&store).unwrap(),..Preferences::default()}).unwrap(); }
    Fixture {_directory:directory,store,input}
}

fn business(store:&LocalStore)->Value {
    let db=store.connect().unwrap();
    let mut result=serde_json::Map::new();
    for table in ["clients","quotes","quote_items","audit_log","action_engine_quote_receipts","company_local_action_engine_quote_outbox",
        "company_local_action_engine_quote_publications","company_local_action_engine_quote_confirmations"] {
        result.insert(table.into(),json!(query_all(&db,&format!("SELECT * FROM {table} ORDER BY 1"),[]).unwrap()));
    }
    Value::Object(result)
}
fn state_bytes(store:&LocalStore)->Option<Vec<u8>> { fs::read(store.data_dir.join(STATE)).ok() }
fn pending(store:&LocalStore)->Pending { prepare(store,ORGANIZATION,false).unwrap() }
fn packet_json(packet:&PublicationUploadRequest)->Value { serde_json::from_slice(packet.body.as_deref().unwrap()).unwrap() }
fn recover<F,Fut>(store:&LocalStore,transport:F)->AppResult<()>
where F:FnMut(PublicationUploadRequest)->Fut+Send,Fut:std::future::Future<Output=AppResult<Value>>+Send {
    tauri::async_runtime::block_on(async {
        let _account=store.account_protected_cache.operation_lock.lock().await;
        recover_action_engine_publication_with(store,ORGANIZATION,"owner",transport).await
    })
}
fn publish<F,Fut>(store:&LocalStore,transport:F)->AppResult<()>
where F:FnMut(PublicationUploadRequest)->Fut+Send,Fut:std::future::Future<Output=AppResult<Value>>+Send {
    tauri::async_runtime::block_on(async {
        let _account=store.account_protected_cache.operation_lock.lock().await;
        publish_action_engine_quote_with(store,ORGANIZATION,"owner",transport).await
    })
}

#[test]
fn action_execution_refuses_disabled_foreign_read_only_and_ambiguous_workspace_without_http_or_consent() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let licensed=fixture(true);
    licensed.store.install_server_issued_license(&signed_fixture_token(&licensed.store,"read_only")).unwrap();
    let before=business(&licensed.store);
    assert!(licensed.store.require_write_access().is_err());
    assert!(licensed.store.commit_action_engine_quote_draft(licensed.input.clone()).is_err());
    assert_eq!(business(&licensed.store),before,"real licence refusal precedes draft/client/receipt writes");
    for fault in ["disabled","foreign","read_only","conflict","received","restore"] {
        let f=fixture(fault!="disabled");
        let mut prefs=load(&f.store).unwrap();
        match fault {
            "foreign"=>prefs.organization_id=Some("other-company".into()),
            "read_only"=>set_identity(&f.store,ORGANIZATION,USER,"QA owner","read_only").unwrap(),
            "conflict"=>prefs.conflict=true,
            "received"=>{
                let frozen=pending(&f.store);
                prefs=load(&f.store).unwrap();prefs.pending=None;
                prefs.received=Some(Received {id:frozen.id,organization:ORGANIZATION.into(),revision:1,clock:frozen.clock,manifest:frozen.manifest,merge:None});
            },
            "restore"=>prefs.base_clock=-1,
            _=>{},
        }
        if fault!="disabled" { save(&f.store,&prefs).unwrap(); }
        let before=business(&f.store);let bytes=state_bytes(&f.store);
        assert!(recover(&f.store,|_|async {panic!("no HTTP for a closed workspace")}).is_err(),"{fault}");
        assert!(publish(&f.store,|_|async {panic!("no HTTP or activation for a closed workspace")}).is_err(),"{fault}");
        assert_eq!(business(&f.store),before);assert_eq!(state_bytes(&f.store),bytes);
    }
}

#[test]
fn action_execution_idle_recovery_neither_publishes_nor_prepares_an_archive() {
    let f=fixture(true);let before=business(&f.store);let bytes=state_bytes(&f.store);
    recover(&f.store,|_|async {panic!("idle recovery has no transport")}).unwrap();
    assert_eq!(business(&f.store),before);assert_eq!(state_bytes(&f.store),bytes);
    assert!(!f.store.data_dir.join("company-sync").exists());
}

#[test]
fn action_execution_recovers_exact_old_committed_pending_before_any_new_draft() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);let old=pending(&f.store);let original=fs::read(file_path(&f.store,&old.id).unwrap()).unwrap();
    let mut calls=0;
    recover(&f.store,|packet| {
        calls+=1;assert_eq!(packet.method,Method::POST);assert!(packet.query.is_empty());
        assert_eq!(packet_json(&packet),json!({"action":"recover-publication","id":old.id,"baseRevision":old.base_revision,"manifest":old.manifest}));
        std::future::ready(Ok(json!({"known":true,"committed":true,"revision":old.base_revision+1,"snapshotId":old.id})))
    }).unwrap();
    assert_eq!(calls,1);assert!(load(&f.store).unwrap().pending.is_none());
    assert_eq!(load(&f.store).unwrap().revision,1);
    assert_eq!(fs::read(f.store.data_dir.join("company-sync-reference.zentra")).unwrap(),original);
    assert_eq!(business(&f.store)["quotes"],json!([]));
    assert_eq!(business(&f.store)["company_local_action_engine_quote_confirmations"],json!([]));
}

#[test]
fn action_execution_crash_before_prepare_resumes_the_same_archive_for_each_existing_protocol() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for version in [0,1,2] {
        let f=fixture(true);let mut old=pending(&f.store);old.content_version=version;
        let mut prefs=load(&f.store).unwrap();prefs.pending=Some(old.clone());save(&f.store,&prefs).unwrap();
        let original=fs::read(file_path(&f.store,&old.id).unwrap()).unwrap();
        let mut sequence=Vec::new();let mut uploads=Vec::new();
        recover(&f.store,|packet| {
            if packet.method==Method::GET {sequence.push("head");return std::future::ready(Ok(json!({"organizationId":ORGANIZATION,"revision":0,"contentTransfer":1})));}
            if packet.method==Method::PUT {
                sequence.push("upload");assert!(packet.query.iter().any(|(key,value)|key=="id"&&value==&old.id));
                let bytes=packet.body.unwrap();
                if let Some((_,hash))=packet.query.iter().find(|(key,_)|key=="blob") {assert_eq!(format!("{:x}",Sha256::digest(&bytes)),*hash);}
                uploads.extend_from_slice(&bytes);return std::future::ready(Ok(Value::Null));
            }
            let body=packet_json(&packet);
            match body["action"].as_str().unwrap() {
                "recover-publication"=>{sequence.push("probe");std::future::ready(Ok(json!({"known":false})))},
                "prepare"|"prepare-content"=>{
                    sequence.push("prepare");assert_eq!(body["id"],old.id);assert_eq!(body["baseRevision"],old.base_revision);
                    assert_eq!(body["manifest"],serde_json::to_value(&old.manifest).unwrap());assert_eq!(body["confirmFullAccess"],false);
                    if body["action"]=="prepare-content" {std::future::ready(Ok(json!({"missing":body["entries"].as_array().unwrap().iter().map(|part|part["sha256"].clone()).collect::<Vec<_>>()})))}
                    else {std::future::ready(Ok(json!({"received":[]}))) }
                },
                "commit"=>{sequence.push("commit");assert_eq!(body,json!({"action":"commit","id":old.id}));std::future::ready(Ok(json!({"committed":true,"revision":1,"snapshotId":old.id})))},
                _=>panic!("unexpected protocol action"),
            }
        }).unwrap();
        assert_eq!(&sequence[..3],["probe","head","prepare"]);assert_eq!(sequence.last(),Some(&"commit"));
        assert_eq!(uploads,original);assert!(load(&f.store).unwrap().pending.is_none());
        assert_eq!(business(&f.store)["quotes"],json!([]));
    }
}

#[test]
fn action_execution_divergent_head_or_failed_probe_keeps_old_pending_and_never_uploads_or_creates_a_draft() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for fault in ["head","foreign_head","denied","unavailable","cancelled"] {
        let f=fixture(true);let old=pending(&f.store);let before=business(&f.store);let bytes=state_bytes(&f.store);
        let mut calls=0;
        assert!(recover(&f.store,|packet| {
            calls+=1;
            if packet.method==Method::GET {return std::future::ready(Ok(json!({"organizationId":if fault=="foreign_head"{"other-company"}else{ORGANIZATION},"revision":if fault=="head"{1}else{0},"contentTransfer":1})));}
            assert_eq!(packet_json(&packet)["action"],"recover-publication");
            std::future::ready(match fault {
                "denied"|"unavailable"=>Err(invalid("Synthetic transport refusal")),
                "cancelled"=>Ok(json!({"known":true,"committed":false,"revision":1,"snapshotId":Uuid::new_v4().to_string()})),
                _=>Ok(json!({"known":false})),
            })
        }).is_err(),"{fault}");
        assert_eq!(calls,if matches!(fault,"head"|"foreign_head"){2}else{1});
        assert!(load(&f.store).unwrap().pending.as_ref()==Some(&old));
        assert_eq!(business(&f.store),before);assert_eq!(state_bytes(&f.store),bytes);
    }
}

#[test]
fn action_execution_publishes_a_real_committed_draft_with_existing_uploads_without_confirming_a7() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for content in [false,true] {
        let f=fixture(true);f.store.commit_action_engine_quote_draft(f.input.clone()).unwrap();
        let observed=Arc::new(Mutex::new(None::<String>));let captured=observed.clone();
        let mut uploads=Vec::new();let mut calls=Vec::new();
        publish(&f.store,|packet| {
            if packet.method==Method::GET {calls.push("head");return std::future::ready(Ok(json!({"organizationId":ORGANIZATION,"revision":0,"contentTransfer":u8::from(content)})));}
            if packet.method==Method::PUT {calls.push("upload");uploads.extend_from_slice(packet.body.as_deref().unwrap());return std::future::ready(Ok(Value::Null));}
            let body=packet_json(&packet);
            match body["action"].as_str().unwrap() {
                "prepare"|"prepare-content"=>{
                    calls.push("prepare");assert_eq!(body["confirmFullAccess"],false);
                    let id=body["id"].as_str().unwrap().to_owned();*captured.lock().unwrap()=Some(id.clone());
                    let db=f.store.connect().unwrap();
                    assert_eq!(db.query_row("SELECT count(*) FROM quotes WHERE id=? AND number IS NULL AND status='draft'",[&f.input.quote_id],|row|row.get::<_,i64>(0)).unwrap(),1);
                    let links=query_all(&db,"SELECT * FROM company_local_action_engine_quote_publications",[]).unwrap();
                    assert_eq!(links.len(),1);assert_eq!(links[0]["snapshot_id"],id);assert!(links[0]["published_revision"].is_null());
                    if content {std::future::ready(Ok(json!({"missing":body["entries"].as_array().unwrap().iter().map(|part|part["sha256"].clone()).collect::<Vec<_>>()})))}
                    else {std::future::ready(Ok(json!({"received":[]})))}
                },
                "commit"=>{calls.push("commit");assert_eq!(body["id"].as_str(),captured.lock().unwrap().as_deref());std::future::ready(Ok(json!({"committed":true,"revision":1,"snapshotId":body["id"]})))},
                _=>panic!("no enable, receive or different protocol action"),
            }
        }).unwrap();
        assert_eq!(&calls[..2],["head","prepare"]);assert_eq!(calls.last(),Some(&"commit"));
        let id=observed.lock().unwrap().clone().unwrap();
        assert_eq!(uploads,fs::read(file_path(&f.store,&id).unwrap()).unwrap());
        let result=business(&f.store);
        assert_eq!(result["quotes"].as_array().unwrap().len(),1);assert_eq!(result["company_local_action_engine_quote_outbox"][0]["state"],"pending");
        assert_eq!(result["company_local_action_engine_quote_publications"][0]["published_revision"],1);
        assert_eq!(result["company_local_action_engine_quote_confirmations"],json!([]));
        assert_eq!(crate::action_engine_quote_publication::retained_snapshot_ids(&f.store.connect().unwrap()).unwrap(),vec![id]);
    }
}

#[test]
fn action_execution_lost_commit_ack_recovers_the_same_draft_without_upload_or_a7_confirmation() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);f.store.commit_action_engine_quote_draft(f.input.clone()).unwrap();
    assert!(publish(&f.store,|packet| {
        if packet.method==Method::GET {return std::future::ready(Ok(json!({"organizationId":ORGANIZATION,"revision":0})));}
        if packet.method==Method::PUT {return std::future::ready(Ok(Value::Null));}
        let body=packet_json(&packet);
        if body["action"]=="prepare" {std::future::ready(Ok(json!({"received":[]})))}
        else {assert_eq!(body["action"],"commit");std::future::ready(Err(invalid("Synthetic lost HTTP ACK after server commit")))}
    }).is_err());
    let old=load(&f.store).unwrap().pending.unwrap();let mut calls=0;
    recover(&f.store,|packet| {calls+=1;assert_eq!(packet_json(&packet)["action"],"recover-publication");
        std::future::ready(Ok(json!({"known":true,"committed":true,"revision":1,"snapshotId":old.id}))) }).unwrap();
    assert_eq!(calls,1);assert!(load(&f.store).unwrap().pending.is_none());
    let result=business(&f.store);assert_eq!(result["quotes"].as_array().unwrap().len(),1);
    assert_eq!(result["company_local_action_engine_quote_outbox"][0]["state"],"pending");
    assert_eq!(result["company_local_action_engine_quote_confirmations"],json!([]));
}

#[test]
fn action_execution_new_publication_refuses_old_pending_and_changed_origin_before_prepare() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    let f=fixture(true);let old=pending(&f.store);let before=business(&f.store);let bytes=state_bytes(&f.store);
    assert!(publish(&f.store,|_|async {panic!("old pending belongs to the recovery path before draft")}).is_err());
    assert!(load(&f.store).unwrap().pending.as_ref()==Some(&old));assert_eq!(business(&f.store),before);assert_eq!(state_bytes(&f.store),bytes);
    for fault in ["account_generation","rejected_head_generation","pending","conflict","received","disabled"] {
        let other=fixture(true);other.store.commit_action_engine_quote_draft(other.input.clone()).unwrap();
        let mut calls=0;
        assert!(publish(&other.store,|packet| {
            calls+=1;assert_eq!(packet.method,Method::GET);
            if matches!(fault,"account_generation"|"rejected_head_generation") {
                set_identity(&other.store,ORGANIZATION,"temporary-user","QA temporary","owner").unwrap();
                set_identity(&other.store,ORGANIZATION,USER,"QA owner","owner").unwrap();
            } else if fault=="pending" {pending(&other.store);}
            else {
                let mut prefs=load(&other.store).unwrap();
                if fault=="conflict" {prefs.conflict=true;}
                else if fault=="disabled" {prefs.organization_id=None;}
                else {let frozen=pending(&other.store);prefs.received=Some(Received {id:frozen.id,organization:ORGANIZATION.into(),revision:1,clock:frozen.clock,manifest:frozen.manifest,merge:None});}
                save(&other.store,&prefs).unwrap();
            }
            std::future::ready(if fault=="rejected_head_generation" {Err(invalid("Synthetic rejected HTTP after account generation changed"))}
                else {Ok(json!({"organizationId":ORGANIZATION,"revision":0}))})
        }).is_err(),"{fault}");
        assert_eq!(calls,1);assert_eq!(business(&other.store)["quotes"].as_array().unwrap().len(),1);
        assert_eq!(business(&other.store)["company_local_action_engine_quote_confirmations"],json!([]));
    }
}
