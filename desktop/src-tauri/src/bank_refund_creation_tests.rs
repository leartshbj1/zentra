fn new_bank_refund(store: &LocalStore) -> ExpenseRefundInput {
    let project = store.create_record("projects", json!({"name":"Projet remboursement bancaire"})).unwrap();
    let purchase = store.create_record("expenses", json!({"project_id":project["id"],"date":"2026-08-20","paid_at":"2026-08-20","payment_status":"paid","supplier":"Matériaux Léman SA","reference":"RECU-BANK-REFUND","net_cents":10000,"vat_cents":810})).unwrap();
    let expense_id = value_id(&purchase);
    store.set_vat_source_classification(VatSourceClassificationInput { source_type:"expense".into(),source_id:expense_id.clone(),treatment:"input_materials".into(),note:None }).unwrap();
    ExpenseRefundInput { request_id:Uuid::new_v4().to_string(),expense_id,credit_date:"2026-08-21".into(),payment_date:"2026-08-31".into(),reference:"AV-BANK-054".into(),reason:"Retour partiel de marchandises".into(),net_cents:5000,vat_cents:405,reverses_id:None }
}
fn bank_refund_receipt() -> crate::expense_refund_attachments::RefundAttachmentInput {
    use base64::{engine::general_purpose::STANDARD, Engine};
    crate::expense_refund_attachments::RefundAttachmentInput { original_name:"avoir-rembourse.pdf".into(),content_base64:STANDARD.encode(crate::attachments::test_pdf_bytes()) }
}
fn bank_refund_creation_counts(store:&LocalStore,dir:&Path)->(i64,i64,i64,i64,i64,usize) {
    let (a,b,c,d,e)=store.connect().unwrap().query_row("SELECT (SELECT COUNT(*) FROM expense_refunds),(SELECT COUNT(*) FROM bank_expense_refund_matches),(SELECT COUNT(*) FROM attachments),(SELECT COUNT(*) FROM journal_entries),(SELECT COUNT(*) FROM audit_log)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    (a,b,c,d,e,std::fs::read_dir(dir.join("profile/attachments")).unwrap().count())
}

#[test]
fn bank_refund_creation_records_one_payment_vat_project_receipt_and_replays_after_restore() {
    let (dir,store)=ready(); let input=new_bank_refund(&store);
    let movement=debit(&store,dir.path(),"CREATE-REF",Some(refund_credit("54.05","CREATE-REF")));
    assert_eq!(store.get_bank_workspace().unwrap()["movements"][0]["refund_suggestion"]["can_create"],true);
    let before=counts(&store).0;
    let result=store.create_bank_expense_refund(input.clone(),Some(bank_refund_receipt()),&movement).unwrap();
    let refund=value_id(&result["refund"]);
    assert_eq!(result["refund"]["total_cents"],5405);
    assert_eq!(result["refund"]["payment_date"],"2026-08-31");
    assert_eq!(counts(&store).0,before+2);
    let tax=preview(&store); assert!(tax.exportable,"{:?}",tax.blocking_issues); assert_eq!(tax.payable_tax_cents,-405);
    let workspace=store.get_workspace().unwrap();
    assert_eq!(workspace["expenses"][0]["cost_cents"],10000,"The original purchase remains intact");
    assert_eq!(workspace["expenses"][0]["cost_cents"].as_i64().unwrap()-result["refund"]["cost_cents"].as_i64().unwrap(),5000);
    assert_eq!(workspace["attachments"][0]["entity_id"],refund);
    assert_eq!(workspace["attachments"][0]["project_id"],workspace["expenses"][0]["project_id"]);
    let file_id=value_id(&workspace["attachments"][0]);
    assert_eq!(std::fs::read(store.verified_attachment_path(&file_id).unwrap()).unwrap(),crate::attachments::test_pdf_bytes());
    assert_eq!(store.get_bank_workspace().unwrap()["summary"]["unreconciled_count"],0);
    let snapshot=bank_refund_creation_counts(&store,dir.path());
    assert_eq!(store.create_bank_expense_refund(input.clone(),Some(bank_refund_receipt()),&movement).unwrap()["already_recorded"],true);
    assert_eq!(bank_refund_creation_counts(&store,dir.path()),snapshot);
    let backup=store.create_backup(Some(dir.path().join("bank-refund.zentra").to_string_lossy().into()),"1.32.0").unwrap();
    let restored=LocalStore::initialize(dir.path().join("restored")).unwrap(); restored.restore_backup(&backup,"1.32.0").unwrap();
    assert_eq!(restored.create_bank_expense_refund(input,Some(bank_refund_receipt()),&movement).unwrap()["already_recorded"],true);
    assert_eq!(std::fs::read(restored.verified_attachment_path(&file_id).unwrap()).unwrap(),crate::attachments::test_pdf_bytes());
    assert_eq!(preview(&restored).source_sha256,tax.source_sha256);
}

#[test]
fn bank_refund_creation_rejects_changed_amount_date_direction_status_and_closed_period() {
    let (dir,store)=ready(); let input=new_bank_refund(&store);
    let movement=debit(&store,dir.path(),"BOUND-REF",Some(refund_credit("54.05","BOUND-REF")));
    let baseline=bank_refund_creation_counts(&store,dir.path());
    for changed in [ExpenseRefundInput{net_cents:4999,..input.clone()},ExpenseRefundInput{payment_date:"2026-09-01".into(),..input.clone()},ExpenseRefundInput{reverses_id:Some(Uuid::new_v4().to_string()),..input.clone()}] {
        assert!(store.create_bank_expense_refund(changed,None,&movement).is_err());
        assert_eq!(bank_refund_creation_counts(&store,dir.path()),baseline);
    }
    for (key,xml) in [("DEBIT-REF",debit_fixture("54.05","DEBIT-REF",None)),("PENDING-REF",fixture("054","08","PDNG","54.05","PENDING-REF",Some("D-PENDING-REF"),None,None,false,true)),("REVERSED-REF",refund_credit("54.05","REVERSED-REF").replace("<RvslInd>false</RvslInd>","<RvslInd>true</RvslInd>"))] {
        let id=debit(&store,dir.path(),key,Some(xml)); let before=bank_refund_creation_counts(&store,dir.path());
        assert!(store.create_bank_expense_refund(input.clone(),None,&id).is_err(),"{key}");
        assert_eq!(bank_refund_creation_counts(&store,dir.path()),before);
    }
    store.connect().unwrap().execute("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES('closed','T3','2026-07-01','2026-09-30','closed','2026-09-05','2026-09-05')",[]).unwrap();
    let before=bank_refund_creation_counts(&store,dir.path());
    assert!(store.create_bank_expense_refund(input,None,&movement).is_err());
    assert_eq!(bank_refund_creation_counts(&store,dir.path()),before);
}

#[test]
fn bank_refund_creation_late_failure_rolls_back_bank_money_vat_and_installed_file() {
    let (dir,store)=ready(); let input=new_bank_refund(&store);
    let movement=debit(&store,dir.path(),"ATOMIC-REF",Some(refund_credit("54.05","ATOMIC-REF")));
    let before=bank_refund_creation_counts(&store,dir.path()); let tax=preview(&store);
    for trigger in ["CREATE TRIGGER fail_creation BEFORE INSERT ON bank_expense_refund_matches BEGIN SELECT RAISE(ABORT,'injected bank failure'); END;","CREATE TRIGGER fail_creation BEFORE INSERT ON audit_log WHEN NEW.action='record_refund' BEGIN SELECT RAISE(ABORT,'injected after file installation'); END;"] {
        store.connect().unwrap().execute_batch(trigger).unwrap();
        assert!(store.create_bank_expense_refund(input.clone(),Some(bank_refund_receipt()),&movement).is_err());
        assert_eq!(bank_refund_creation_counts(&store,dir.path()),before);
        assert_eq!(preview(&store).source_sha256,tax.source_sha256);
        store.connect().unwrap().execute_batch("DROP TRIGGER fail_creation;").unwrap();
    }
    store.create_bank_expense_refund(input,Some(bank_refund_receipt()),&movement).unwrap();
}

#[test]
fn bank_refund_creation_replay_cannot_reactivate_unlinked_or_changed_requests() {
    let (dir,store)=ready(); let input=new_bank_refund(&store);
    let movement=debit(&store,dir.path(),"REPLAY-REF",Some(refund_credit("54.05","REPLAY-REF")));
    let other=debit(&store,dir.path(),"OTHER-REF",Some(refund_credit("54.05","OTHER-REF")));
    let result=store.create_bank_expense_refund(input.clone(),None,&movement).unwrap();
    let baseline=bank_refund_creation_counts(&store,dir.path());
    assert!(store.create_bank_expense_refund(input.clone(),None,&other).is_err());
    assert!(store.record_expense_refund(input.clone()).is_err());
    assert!(store.create_bank_expense_refund(ExpenseRefundInput{reason:"Motif différent après réponse perdue".into(),..input.clone()},None,&movement).is_err());
    assert!(store.create_bank_expense_refund(ExpenseRefundInput{request_id:Uuid::new_v4().to_string(),..input.clone()},None,&movement).is_err());
    assert_eq!(bank_refund_creation_counts(&store,dir.path()),baseline);
    store.unmatch_bank_expense_refund(refund_unlink(&input.request_id)).unwrap();
    let baseline=bank_refund_creation_counts(&store,dir.path());
    assert!(store.create_bank_expense_refund(input.clone(),None,&movement).is_err());
    assert_eq!(bank_refund_creation_counts(&store,dir.path()),baseline);
    store.match_bank_expense_refund(refund_match(&movement,&value_id(&result["refund"]))).unwrap();
    assert!(store.create_bank_expense_refund(input,None,&movement).is_err());
}

#[test]
fn bank_refund_creation_concurrent_identical_requests_keep_one_refund_and_match() {
    let (dir,store)=ready(); let input=new_bank_refund(&store);
    let movement=debit(&store,dir.path(),"RACE-REF",Some(refund_credit("54.05","RACE-REF")));
    std::thread::scope(|scope| {
        let one=scope.spawn(||store.create_bank_expense_refund(input.clone(),None,&movement));
        let two=scope.spawn(||store.create_bank_expense_refund(input.clone(),None,&movement));
        assert_eq!(one.join().unwrap().unwrap()["refund"]["id"],two.join().unwrap().unwrap()["refund"]["id"]);
    });
    let counts=bank_refund_creation_counts(&store,dir.path()); assert_eq!((counts.0,counts.1),(1,1));
    assert_eq!(preview(&store).payable_tax_cents,-405);
}
