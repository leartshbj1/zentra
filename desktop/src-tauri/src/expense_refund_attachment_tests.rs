use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use crate::expense_refund_attachments::RefundAttachmentInput;

fn receipt(suffix: usize) -> RefundAttachmentInput {
    let mut bytes = crate::attachments::test_pdf_bytes();
    bytes.extend_from_slice(format!("\n% piece {suffix}\n").as_bytes());
    RefundAttachmentInput { original_name: format!("avoir-{suffix}.pdf"), content_base64: STANDARD.encode(bytes) }
}

fn counts(store: &LocalStore, dir: &std::path::Path) -> (i64, i64, i64, usize) {
    let (refunds, files, journals) = store.connect().unwrap().query_row(
        "SELECT (SELECT COUNT(*) FROM expense_refunds),(SELECT COUNT(*) FROM attachments),(SELECT COUNT(*) FROM journal_entries)",
        [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ).unwrap();
    (refunds, files, journals, std::fs::read_dir(dir.join("profile/attachments")).unwrap().count())
}

#[test]
fn refund_attachment_creation_replays_without_duplicate_and_backs_up_project_evidence() {
    let (dir, store, _) = fixture();
    store.create_vat_profile(profile(false)).unwrap();
    let project=store.create_record("projects",json!({"name":"Projet avoir fournisseur"})).unwrap();
    let expense=store.create_record("expenses",json!({"project_id":project["id"],"date":"2026-02-10","paid_at":"2026-02-10","payment_status":"paid","supplier":"Fournisseur retours","reference":"EXP-DOC","net_cents":10000,"vat_cents":810})).unwrap();
    let expense_id=expense["id"].as_str().unwrap();
    classify(&store,"expense",expense_id,"input_materials");
    let request=input(expense_id); let file=receipt(1);
    let result=store.record_expense_refund_with_attachment(request.clone(),Some(file.clone())).unwrap();
    let refund_id=result["refund"]["id"].as_str().unwrap();
    let workspace=store.get_workspace().unwrap();
    let record=&workspace["attachments"][0];
    assert_eq!(record["entity_type"],"expense_refund");
    assert_eq!(record["entity_id"],refund_id);
    assert_eq!(record["project_id"],project["id"]);
    let attachment_id=record["id"].as_str().unwrap();
    assert_eq!(std::fs::read(store.verified_attachment_path(attachment_id).unwrap()).unwrap(),STANDARD.decode(&file.content_base64).unwrap());
    let before=counts(&store,dir.path());
    assert_eq!(store.record_expense_refund_with_attachment(request.clone(),Some(file.clone())).unwrap()["already_recorded"],true);
    assert_eq!(counts(&store,dir.path()),before);
    assert!(store.record_expense_refund_with_attachment(request.clone(),Some(receipt(2))).is_err());
    assert!(store.record_expense_refund(request).is_err());
    assert!(!result["refund"]["request_json"].as_str().unwrap().contains(&file.content_base64));
    let backup=store.create_backup(Some(dir.path().join("pieces.zentra").to_string_lossy().into()),"1.31.0").unwrap();
    let restored=LocalStore::initialize(dir.path().join("restored")).unwrap();
    restored.restore_backup(&backup,"1.31.0").unwrap();
    assert_eq!(std::fs::read(restored.verified_attachment_path(attachment_id).unwrap()).unwrap(),STANDARD.decode(&file.content_base64).unwrap());
    assert_eq!(restored.get_workspace().unwrap()["attachments"][0]["project_id"],project["id"]);
}

#[test]
fn refund_attachment_rejection_and_late_audit_failure_roll_back_money_and_files() {
    let (dir,store,_)=fixture(); store.create_vat_profile(profile(false)).unwrap();
    let expense=purchase(&store,true); let request=input(&expense); let before=counts(&store,dir.path());
    let invalid=RefundAttachmentInput{original_name:"avoir.pdf".into(),content_base64:STANDARD.encode(b"<html>invalid</html>")};
    assert!(store.record_expense_refund_with_attachment(request.clone(),Some(invalid)).is_err());
    assert_eq!(counts(&store,dir.path()),before);
    store.connect().unwrap().execute_batch("CREATE TRIGGER test_refund_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='record_refund' BEGIN SELECT RAISE(ABORT,'injected late failure'); END;").unwrap();
    assert!(store.record_expense_refund_with_attachment(request.clone(),Some(receipt(1))).is_err());
    assert_eq!(counts(&store,dir.path()),before);
    store.connect().unwrap().execute_batch("DROP TRIGGER test_refund_audit_failure;").unwrap();
    store.record_expense_refund_with_attachment(request,Some(receipt(1))).unwrap();
    assert_eq!(counts(&store,dir.path()).1,1);
}

#[test]
fn refund_attachment_added_later_keeps_vat_journals_and_corrected_history() {
    let (dir,store,_)=fixture(); store.create_vat_profile(profile(false)).unwrap();
    let expense=purchase(&store,true); let request=input(&expense);
    let result=store.record_expense_refund(request.clone()).unwrap();
    let refund_id=result["refund"]["id"].as_str().unwrap();
    let before=period_preview(&store,"2026-04-01","2026-06-30"); let journals=journal_count(&store);
    let record=store.add_expense_refund_attachment(refund_id,receipt(1)).unwrap();
    let first=counts(&store,dir.path());
    assert_eq!(store.add_expense_refund_attachment(refund_id,receipt(1)).unwrap()["id"],record["id"]);
    assert_eq!(counts(&store,dir.path()),first);
    assert_eq!(period_preview(&store,"2026-04-01","2026-06-30").source_sha256,before.source_sha256);
    assert_eq!(journal_count(&store),journals);
    assert_eq!(store.record_expense_refund(request.clone()).unwrap()["already_recorded"],true);
    let mut correction=request; correction.request_id=Uuid::new_v4().to_string(); correction.reverses_id=Some(refund_id.into());
    correction.credit_date="2026-08-01".into(); correction.payment_date="2026-08-01".into(); correction.reason="Erreur de saisie documentée".into();
    store.record_expense_refund_with_attachment(correction,Some(receipt(2))).unwrap();
    assert!(store.verified_attachment_path(record["id"].as_str().unwrap()).unwrap().is_file());
    assert_eq!(store.get_workspace().unwrap()["attachments"].as_array().unwrap().len(),2);
    assert!(store.connect().unwrap().execute("DELETE FROM attachments WHERE id=?",params![record["id"].as_str()]).is_err());
    assert!(store.delete_project_document(record["id"].as_str().unwrap()).is_err());
    assert!(store.delete_supplier_invoice_attachment(record["id"].as_str().unwrap()).is_err());
}

#[test]
fn refund_attachment_limits_and_orphans_leave_no_copied_files() {
    let (dir,store,_)=fixture(); store.create_vat_profile(profile(false)).unwrap();
    let expense=purchase(&store,true); let result=store.record_expense_refund(input(&expense)).unwrap();
    let refund_id=result["refund"]["id"].as_str().unwrap();
    let before=counts(&store,dir.path());
    assert!(store.add_expense_refund_attachment(&Uuid::new_v4().to_string(),receipt(1)).is_err());
    assert_eq!(counts(&store,dir.path()),before);
    for index in 0..20 { store.add_expense_refund_attachment(refund_id,receipt(index)).unwrap(); }
    let full=counts(&store,dir.path());
    assert!(store.add_expense_refund_attachment(refund_id,receipt(20)).is_err());
    assert_eq!(counts(&store,dir.path()),full);
    store.add_expense_refund_attachment(refund_id,receipt(0)).unwrap();
    assert_eq!(counts(&store,dir.path()),full);
}

#[test]
fn refund_attachment_schema_48_migrates_and_preserves_legacy_request_replay() {
    let (dir,store,_)=fixture(); store.create_vat_profile(profile(false)).unwrap();
    let expense=purchase(&store,true); let request=input(&expense);
    let result=store.record_expense_refund(request.clone()).unwrap();
    store.connect().unwrap().execute_batch("DROP TRIGGER expense_refund_attachment_insert_guard; DROP TRIGGER expense_refund_attachment_no_delete; PRAGMA user_version=48;").unwrap();
    let migrated=LocalStore::initialize(dir.path().join("profile")).unwrap();
    assert_eq!(migrated.connect().unwrap().query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),crate::schema::SCHEMA_VERSION);
    assert_eq!(migrated.record_expense_refund(request).unwrap()["already_recorded"],true);
    migrated.add_expense_refund_attachment(result["refund"]["id"].as_str().unwrap(),receipt(1)).unwrap();
    assert!(migrated.connect().unwrap().execute("UPDATE attachments SET entity_id='invalid' WHERE entity_type='expense_refund'",[]).is_err());
    assert!(migrated.connect().unwrap().execute("DELETE FROM attachments WHERE entity_type='expense_refund'",[]).is_err());
}
