//! Prepared actual LocalStore V2 transaction and read-probe tests.
//! No local native execution; command authority has a separate actual-handler suite.
use crate::{database::{LocalStore,query_all},models::SaveDocumentWithItemsInput};
use serde_json::{json,Value};

fn fixture()->(tempfile::TempDir,LocalStore,String) {
    let directory=tempfile::tempdir().unwrap();
    let store=LocalStore::initialize(directory.path().join("profile")).unwrap();
    store.complete_onboarding(crate::tests::test_onboarding(),env!("CARGO_PKG_VERSION")).unwrap();
    let client_id=uuid::Uuid::new_v4().to_string();
    store.create_record("clients",json!({"id":client_id,"name":"Synthetic receipt client"})).unwrap();
    (directory,store,client_id)
}
fn input(entity:&str,client_id:&str)->SaveDocumentWithItemsInput {
    let mut data=json!({"client_id":client_id,"title":"Synthetic frozen creation","status":"brouillon","currency":"CHF","issue_date":"2026-09-01","notes":"First line\nSecond line"});
    if entity=="quotes" {data["valid_until"]=json!("2026-10-01");}
    else {data["type"]=json!("standard");data["due_date"]=json!("2026-10-01");data["service_date_from"]=json!("2026-09-01");data["service_date_to"]=json!("2026-09-01");}
    SaveDocumentWithItemsInput{entity:entity.into(),id:None,data,items:vec![
        json!({"description":"Synthetic first line","quantity":2.125,"unit":"h","unit_price_cents":12_345,"discount_bp":1250,"vat_bp":0}),
        json!({"description":"Synthetic second line","quantity":1,"unit":"piece","unit_price_cents":900,"discount_bp":0,"vat_bp":0}),
    ]}
}
fn snapshot(store:&LocalStore)->Value {
    let connection=store.connect().unwrap();let mut rows=serde_json::Map::new();
    for table in ["settings","clients","quotes","quote_items","invoices","invoice_items","document_creators","audit_log","journal_entries","journal_lines","company_local_clock"] {
        rows.insert(table.into(),json!(query_all(&connection,&format!("SELECT * FROM {table} ORDER BY rowid"),[]).unwrap()));
    }
    Value::Object(rows)
}

#[test]
fn committed_exact_creation_returns_its_original_receipt_without_second_document_lines_audit_or_clock_change() {
    for entity in ["quotes","invoices"] {
        let (_directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let payload=input(entity,&client_id);
        let response=store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();let before=snapshot(&store);
        let replay=store.save_document_with_items_once(payload,Some(request.clone())).unwrap();
        assert_eq!(replay,response);assert_eq!(snapshot(&store),before);assert_eq!(response["creationRequestId"],request);assert_eq!(response["document"]["id"],request);
        let connection=store.connect().unwrap();assert_eq!(connection.query_row::<i64,_,_>(&format!("SELECT COUNT(*) FROM {entity}"),[],|row|row.get(0)).unwrap(),1);
        assert_eq!(response["items"].as_array().unwrap().len(),2);
        assert_eq!(connection.query_row::<i64,_,_>("SELECT COUNT(*) FROM audit_log WHERE entity_type='document_creation_request' AND action='complete'",[],|row|row.get(0)).unwrap(),1);
    }
}

#[test]
fn same_request_with_changed_title_price_order_or_entity_refuses_and_preserves_original_rows() {
    for entity in ["quotes","invoices"] {
        let (_directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let payload=input(entity,&client_id);
        store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();let before=snapshot(&store);
        for variant in 0..4 {
            let mut changed=payload.clone();match variant {0=>changed.data["title"]=json!("Different title"),1=>changed.items[0]["unit_price_cents"]=json!(15_000),2=>changed.items.reverse(),_=>changed=input(if entity=="quotes"{"invoices"}else{"quotes"},&client_id)};
            let error=store.save_document_with_items_once(changed,Some(request.clone())).unwrap_err().to_string();
            assert!(error.contains("déjà enregistré un autre contenu"));assert_eq!(snapshot(&store),before);
        }
    }
}

#[test]
fn failed_second_line_rolls_back_receipt_and_document_then_same_request_can_commit_corrected_input_once() {
    for entity in ["quotes","invoices"] {
        let (_directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let payload=input(entity,&client_id);let before=snapshot(&store);
        let mut invalid=payload.clone();invalid.items[1]["unknown_business_field"]=json!("refuse");
        assert!(store.save_document_with_items_once(invalid,Some(request.clone())).is_err());assert_eq!(snapshot(&store),before);
        let result=store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();let committed=snapshot(&store);
        assert_eq!(store.save_document_with_items_once(payload,Some(request)).unwrap(),result);assert_eq!(snapshot(&store),committed);
    }
}

#[test]
fn receipt_survives_actual_store_reopening_after_a_lost_response() {
    for entity in ["quotes","invoices"] {
        let (directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let payload=input(entity,&client_id);
        let original=store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();let before=snapshot(&store);drop(store);
        let reopened=LocalStore::initialize(directory.path().join("profile")).unwrap();
        assert_eq!(reopened.save_document_with_items_once(payload,Some(request)).unwrap(),original);assert_eq!(snapshot(&reopened),before);
    }
}

#[test]
fn confirmed_creation_never_overwrites_a_later_edit_and_missing_result_never_creates_a_replacement() {
    for entity in ["quotes","invoices"] {
        let (_directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let payload=input(entity,&client_id);
        let original=store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();let id=original["document"]["id"].as_str().unwrap().to_owned();
        store.update_record(entity,&id,json!({"title":"A later legitimate edit"})).unwrap();let edited=snapshot(&store);
        assert_eq!(store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap(),original);assert_eq!(snapshot(&store),edited);
        store.delete_record(entity,&id).unwrap();let removed=snapshot(&store);
        assert!(store.save_document_with_items_once(payload,Some(request)).unwrap_err().to_string().contains("a été supprimé"));assert_eq!(snapshot(&store),removed);
    }
}

#[test]
fn optional_none_retains_legacy_create_and_update_while_a_creation_request_never_updates_an_existing_id() {
    for entity in ["quotes","invoices"] {
        let (_directory,store,client_id)=fixture();let payload=input(entity,&client_id);
        let original=store.save_document_with_items(payload.clone()).unwrap();assert!(original.get("creationRequestId").is_none());
        let mut update=payload;update.id=Some(original["document"]["id"].as_str().unwrap().into());update.data["title"]=json!("Legacy update");
        let before=snapshot(&store);assert!(store.save_document_with_items_once(update.clone(),Some(uuid::Uuid::new_v4().to_string())).is_err());assert_eq!(snapshot(&store),before);
        let changed=store.save_document_with_items(update).unwrap();assert_eq!(changed["document"]["title"],"Legacy update");assert!(changed.get("creationRequestId").is_none());
    }
}


#[test]
fn pure_probe_keeps_original_creation_distinct_from_later_current_values_and_reports_deleted_without_recreation() {
    for entity in ["quotes","invoices"] {
        let (_directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let payload=input(entity,&client_id);
        let before=snapshot(&store);let missing=store.get_document_creation_receipt(payload.clone(),request.clone()).unwrap();
        assert_eq!(missing["receiptVersion"],1);assert_eq!(missing["creationRequestId"],request);assert_eq!(missing["documentId"],request);
        assert_eq!(missing["entity"],entity);assert_eq!(missing["status"],"missing");assert!(missing["originalResponse"].is_null());assert!(missing["currentDocument"].is_null());
        assert_eq!(missing["currentItems"],json!([]));assert!(missing["originalMatchesCurrent"].is_null());assert_eq!(snapshot(&store),before);
        let original=store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();let committed=snapshot(&store);
        let confirmed=store.get_document_creation_receipt(payload.clone(),request.clone()).unwrap();
        assert_eq!(confirmed["status"],"confirmed");assert_eq!(confirmed["originalResponse"],original);assert_eq!(confirmed["currentDocument"],original["document"]);
        assert_eq!(confirmed["currentItems"],original["items"]);assert_eq!(confirmed["originalMatchesCurrent"],true);assert_eq!(snapshot(&store),committed);
        store.update_record(entity,&request,json!({"title":"Later current title"})).unwrap();let edited=snapshot(&store);
        let confirmed=store.get_document_creation_receipt(payload.clone(),request.clone()).unwrap();
        assert_eq!(confirmed["originalResponse"],original);assert_eq!(confirmed["currentDocument"]["title"],"Later current title");assert_eq!(confirmed["originalMatchesCurrent"],false);
        assert_eq!(snapshot(&store),edited);
        store.delete_record(entity,&request).unwrap();let removed=snapshot(&store);
        let deleted=store.get_document_creation_receipt(payload.clone(),request.clone()).unwrap();
        assert_eq!(deleted["status"],"deleted");assert_eq!(deleted["originalResponse"],original);assert!(deleted["currentDocument"].is_null());
        assert_eq!(deleted["currentItems"],json!([]));assert!(deleted["originalMatchesCurrent"].is_null());assert_eq!(snapshot(&store),removed);
        assert!(store.save_document_with_items_once(payload,Some(request)).unwrap_err().to_string().contains("a été supprimé"));assert_eq!(snapshot(&store),removed);
    }
}

#[test]
fn actual_backup_before_commit_loses_receipt_but_explicit_same_attempt_keeps_document_uuid_and_invalidates_old_context() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for entity in ["quotes","invoices"] {
        let (_directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let payload=input(entity,&client_id);
        let before=store.create_backup(None,env!("CARGO_PKG_VERSION")).unwrap();
        let old_scope=crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();let old_nonce=crate::member_context::read(&store.connect().unwrap()).unwrap();
        let first=store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();assert_eq!(first["document"]["id"],request);
        store.restore_backup(&before,env!("CARGO_PKG_VERSION")).unwrap();
        assert_ne!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(),old_scope);
        assert!(crate::member_context::require_unchanged(&store.connect().unwrap(),Some(&old_nonce)).is_err());
        let restored=snapshot(&store);assert_eq!(store.get_document_creation_receipt(payload.clone(),request.clone()).unwrap()["status"],"missing");assert_eq!(snapshot(&store),restored);
        let retried=store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();assert_eq!(retried["document"]["id"],first["document"]["id"]);
        let committed=snapshot(&store);assert_eq!(store.save_document_with_items_once(payload,Some(request)).unwrap(),retried);assert_eq!(snapshot(&store),committed);
        assert_eq!(store.connect().unwrap().query_row::<i64,_,_>(&format!("SELECT COUNT(*) FROM {entity}"),[],|row|row.get(0)).unwrap(),1);
    }
}

#[test]
fn actual_backup_after_commit_preserves_receipt_and_replay_is_read_only_after_restore() {
    let _transfer=crate::cloud_backup::WORKSPACE_TRANSFER_TEST_LOCK.lock().unwrap();
    for entity in ["quotes","invoices"] {
        let (_directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let payload=input(entity,&client_id);
        let original=store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();let backup=store.create_backup(None,env!("CARGO_PKG_VERSION")).unwrap();
        store.update_record(entity,&request,json!({"title":"Only after backup"})).unwrap();store.restore_backup(&backup,env!("CARGO_PKG_VERSION")).unwrap();
        let restored=snapshot(&store);let probe=store.get_document_creation_receipt(payload.clone(),request.clone()).unwrap();assert_eq!(probe["status"],"confirmed");assert_eq!(probe["originalResponse"],original);
        assert_eq!(store.save_document_with_items_once(payload,Some(request)).unwrap(),original);assert_eq!(snapshot(&store),restored);
        assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
    }
}

#[test]
fn deterministic_id_without_receipt_in_either_document_type_refuses_probe_and_create_without_id_only_ack_or_update() {
    for entity in ["quotes","invoices"] {
        for target in ["quotes","invoices"] {
            let (_directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let payload=input(entity,&client_id);
            let mut data=input(target,&client_id).data;data["id"]=json!(request);data["title"]=json!("Existing ID is not a receipt");store.create_record(target,data).unwrap();
            let before=snapshot(&store);
            assert!(store.get_document_creation_receipt(payload.clone(),request.clone()).unwrap_err().to_string().contains("sans confirmation correspondante"));
            assert!(store.save_document_with_items_once(payload,Some(request)).unwrap_err().to_string().contains("sans confirmation correspondante"));assert_eq!(snapshot(&store),before);
        }
    }
}

fn append_test_receipt(store:&LocalStore,request:&str,payload:&Value) {
    let mut connection=store.connect().unwrap();let transaction=connection.transaction().unwrap();
    crate::audit::append_audit(&transaction,"complete",super::DOCUMENT_CREATION_REQUEST_ENTITY,request,payload).unwrap();transaction.commit().unwrap();
    assert!(store.verify_audit_log().unwrap()["valid"].as_bool().unwrap());
}

#[test]
fn immutable_corrupt_or_ambiguous_receipts_fail_closed_without_disabling_audit_guards_or_changing_business_rows() {
    for entity in ["quotes","invoices"] {
        for variant in 0..7 {
            let (_directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let payload=input(entity,&client_id);
            let parsed=super::document_creation_request(&payload,&request).unwrap();
            let mut data=payload.data.clone();data["id"]=json!(request);store.create_record(entity,data).unwrap();
            let mut update=payload.clone();update.id=Some(request.clone());let mut response=store.save_document_with_items(update).unwrap();response["creationRequestId"]=json!(request);
            let mut receipt=json!({"receipt_version":1,"operation":super::DOCUMENT_CREATION_OPERATION,"request_id":request,"entity":entity,"payload_sha256":parsed.payload_sha256,"document_id":request,"response":response});
            match variant {
                0=>receipt=json!("not an object"),
                1=>receipt["receipt_version"]=json!(99),
                2=>receipt["payload_sha256"]=json!("0".repeat(64)),
                3=>receipt["response"]["document"]["id"]=json!(uuid::Uuid::new_v4().to_string()),
                4=>receipt["response"]["items"][0][if entity=="quotes"{"quote_id"}else{"invoice_id"}]=json!(uuid::Uuid::new_v4().to_string()),
                5=>{let first=receipt["response"]["items"][0]["id"].clone();receipt["response"]["items"][1]["id"]=first;},
                _=>receipt["response"]["items"][0]["position"]=json!(5),
            }
            append_test_receipt(&store,&request,&receipt);let before=snapshot(&store);
            assert!(store.get_document_creation_receipt(payload.clone(),request.clone()).is_err());assert!(store.save_document_with_items_once(payload,Some(request)).is_err());assert_eq!(snapshot(&store),before);
        }
        let (_directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let payload=input(entity,&client_id);
        store.save_document_with_items_once(payload.clone(),Some(request.clone())).unwrap();
        let receipt:String=store.connect().unwrap().query_row("SELECT payload_json FROM audit_log WHERE entity_type='document_creation_request' AND entity_id=?",[&request],|row|row.get(0)).unwrap();
        append_test_receipt(&store,&request,&serde_json::from_str(&receipt).unwrap());let before=snapshot(&store);
        assert!(store.get_document_creation_receipt(payload.clone(),request.clone()).unwrap_err().to_string().contains("incohérente"));assert!(store.save_document_with_items_once(payload,Some(request)).is_err());assert_eq!(snapshot(&store),before);
    }
}

#[test]
fn canonical_request_uuid_and_hash_bind_ignored_readonly_input_and_never_accept_changed_or_update_payloads() {
    for entity in ["quotes","invoices"] {
        let (_directory,store,client_id)=fixture();let request=uuid::Uuid::new_v4().to_string();let mut payload=input(entity,&client_id);payload.data["id"]=json!("Ignored header ID still belongs to frozen input");
        let response=store.save_document_with_items_once(payload.clone(),Some(format!("  {}  ",request.to_uppercase()))).unwrap();assert_eq!(response["creationRequestId"],request);assert_eq!(response["document"]["id"],request);
        let before=snapshot(&store);assert_eq!(store.get_document_creation_receipt(payload.clone(),request.clone()).unwrap()["originalResponse"],response);
        let mut changed=payload.clone();changed.data["id"]=json!("A different ignored input is a different attempt payload");assert!(store.get_document_creation_receipt(changed.clone(),request.clone()).is_err());assert!(store.save_document_with_items_once(changed,Some(request.clone())).is_err());
        let mut update=payload.clone();update.id=Some(request.clone());assert!(store.get_document_creation_receipt(update.clone(),request.clone()).is_err());assert!(store.save_document_with_items_once(update,Some(request.clone())).is_err());
        assert!(store.get_document_creation_receipt(payload.clone(),"not-a-request-uuid".into()).is_err());assert!(store.save_document_with_items_once(payload,Some("not-a-request-uuid".into())).is_err());assert_eq!(snapshot(&store),before);
    }
}
