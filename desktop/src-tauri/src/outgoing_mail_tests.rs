use super::*;
use crate::models::{InstallReminderCycleInput, RecordPaymentInput};
use std::sync::Mutex;
static TEST_MAIL: Mutex<()> = Mutex::new(());

fn enable_logo(temporary: &tempfile::TempDir, store: &LocalStore) {
    let source = temporary.path().join("company-logo.png");
    image::RgbaImage::from_pixel(800, 200, image::Rgba([25, 80, 55, 255]))
        .save(&source)
        .unwrap();
    let managed = store.stage_company_logo(source.to_str().unwrap()).unwrap();
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE settings SET logo_path=? WHERE id=1",
            params![managed],
        )
        .unwrap();
    store
        .save_mail_templates(
            &scope(store).unwrap(),
            MailTemplates::default(),
            Some(MailSignature {
                include_company_logo: true,
            }),
        )
        .unwrap();
}

#[test]
fn mail_logo_embeds_company_image_with_plain_text_html_and_pdf() {
    let _serial = TEST_MAIL.lock().unwrap_or_else(|p| p.into_inner());
    for entity in ["quotes", "invoices"] {
        let (temporary, store, target) = fixture(entity);
        let before = input(&store, target.clone());
        enable_logo(&temporary, &store);
        assert!(send_using(&store, before, |_, _| panic!(
            "Changed signature needs a fresh preview"
        ))
        .is_err());
        let p = preview(&store, &target).unwrap();
        assert!(text(&p, "signatureLogoDataUrl").starts_with("data:image/png;base64,"));
        let logo = selected_mail_logo(&store).unwrap().unwrap();
        assert_eq!((logo.width, logo.height), (180, 45));
        assert!(logo.bytes.len() < 200_000);
        send_using(&store, input(&store, target), |_, message| {
            let raw = String::from_utf8(message.formatted()).unwrap();
            for part in [
                "multipart/mixed",
                "multipart/alternative",
                "multipart/related",
                "text/plain",
                "text/html",
                "image/png",
                "application/pdf",
                "Content-ID: <company-logo@zentra.local>",
                "Content-Disposition: inline",
            ] {
                assert!(raw.contains(part), "missing {part}");
            }
            assert_eq!(raw.matches("Content-Disposition: attachment").count(), 1);
            Ok(())
        })
        .unwrap();
        // An older client saving text templates must neither erase nor fail on the signature.
        store
            .save_mail_templates(&scope(&store).unwrap(), MailTemplates::default(), None)
            .unwrap();
        assert!(signature(&store).unwrap().include_company_logo);
        assert!(serde_json::from_value::<MailTemplates>(
            serde_json::to_value(templates(&store).unwrap()).unwrap()
        )
        .is_ok());
    }
}

#[test]
fn mail_logo_html_escapes_customer_text_preserves_newlines_and_places_logo_last() {
    let logo = MailLogo {
        bytes: vec![],
        width: 180,
        height: 45,
    };
    let html = signature_html(
        "Bonjour <script>alert('x')</script> & \"client\"\r\n\r\nMerci",
        &logo,
    );
    assert!(
        html.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;client&quot;")
    );
    assert!(html.contains("<br>\n<br>\nMerci"));
    assert!(!html.contains("<script>"));
    assert!(html.find("Merci").unwrap() < html.find("<img").unwrap());
    assert!(!html.contains("https://"));
}

#[test]
fn mail_logo_missing_or_damaged_blocks_send_with_recovery_but_can_be_disabled() {
    let _serial = TEST_MAIL.lock().unwrap_or_else(|p| p.into_inner());
    let (temporary, store, target) = fixture("quotes");
    assert!(!signature(&store).unwrap().include_company_logo);
    assert!(store
        .save_mail_templates(
            &scope(&store).unwrap(),
            MailTemplates::default(),
            Some(MailSignature {
                include_company_logo: true
            })
        )
        .is_err());
    enable_logo(&temporary, &store);
    let path: String = store
        .connect()
        .unwrap()
        .query_row("SELECT logo_path FROM settings WHERE id=1", [], |r| {
            r.get(0)
        })
        .unwrap();
    std::fs::write(path, b"invalid logo").unwrap();
    assert_eq!(
        text(&preview(&store, &target).unwrap(), "signatureLogoError"),
        LOGO_HELP
    );
    assert!(
        send_using(&store, input(&store, target.clone()), |_, _| panic!(
            "Invalid logo must not reach SMTP"
        ))
        .is_err()
    );
    store
        .save_mail_templates(
            &scope(&store).unwrap(),
            MailTemplates::default(),
            Some(MailSignature {
                include_company_logo: false,
            }),
        )
        .unwrap();
    send_using(&store, input(&store, target), |_, message| {
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(!raw.contains("image/png") && !raw.contains("multipart/related"));
        assert!(raw.contains("application/pdf"));
        Ok(())
    })
    .unwrap();
}

#[test]
fn mail_logo_is_added_to_reminders_and_stays_scoped_to_the_company() {
    let _serial = TEST_MAIL.lock().unwrap_or_else(|p| p.into_inner());
    let (temporary, store, _) = fixture("invoices");
    enable_logo(&temporary, &store);
    store
        .install_reminder_cycle(InstallReminderCycleInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            sender_name: None,
        })
        .unwrap();
    let scan = store.generate_due_reminders(None).unwrap();
    let target = MailTarget {
        entity: "reminders".into(),
        id: text(&scan["created"][0], "id"),
    };
    assert!(preview(&store, &target).unwrap()["signatureLogoDataUrl"].is_string());
    send_using(&store, input(&store, target), |_, message| {
        assert!(String::from_utf8(message.formatted())
            .unwrap()
            .contains("Content-ID: <company-logo@zentra.local>"));
        Ok(())
    })
    .unwrap();
    let (_other, other, _) = fixture("quotes");
    assert!(!signature(&other).unwrap().include_company_logo);
    assert!(other.outgoing_mail_state().unwrap()["companyLogoDataUrl"].is_null());
}
#[test]
fn mail_connection_ipc_accepts_only_writable_connection_fields() {
    let input = json!({"host":"mail.infomaniak.com","port":465,"security":"tls","username":"contact@example.invalid","fromEmail":"contact@example.invalid","fromName":"Entreprise","password":"FAKE-TEST-PASSWORD"});
    let connection: MailConnection = serde_json::from_value(input.clone()).unwrap();
    connection.validate().unwrap();
    for connected in [false, true] {
        let mut read_state = input.clone();
        read_state["connected"] = json!(connected);
        assert!(serde_json::from_value::<MailConnection>(read_state).is_err());
    }
    let mut saved = input;
    saved["password"] = json!("");
    assert!(serde_json::from_value::<MailConnection>(saved).is_ok());
}
fn fixture(entity: &str) -> (tempfile::TempDir, LocalStore, MailTarget) {
    let temporary = tempfile::tempdir().unwrap();
    let mut store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    // Native CI executes the release-profile licence guard. Only this fixture
    // gets a public synthetic authority; no guard or production key is skipped.
    store.configure_test_license_key(
        ed25519_dalek::SigningKey::from_bytes(&[29; 32])
            .verifying_key()
            .to_bytes(),
    );
    store
        .complete_onboarding(crate::tests::test_onboarding(), "1.0.0")
        .unwrap();
    install_synthetic_mail_license(&store);
    crate::tests::enable_accounting(&store);
    let client=store.create_record("clients",json!({"name":"Client Exemple","email":"client@example.invalid","address_line1":"Rue Exemple 1","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap();
    let mut fields = json!({"client_id":client["id"],"title":"Prestation test"});
    if entity == "invoices" {
        fields["service_date_from"] = json!("2026-01-01");
        fields["service_date_to"] = json!("2026-01-31");
    }
    let doc = store.create_record(entity, fields).unwrap();
    let id = text(&doc, "id");
    let items = if entity == "quotes" {
        "quote_items"
    } else {
        "invoice_items"
    };
    let fk = if entity == "quotes" {
        "quote_id"
    } else {
        "invoice_id"
    };
    store.create_record(items,json!({fk:id,"description":"Prestation test","quantity":1,"unit":"forfait","unit_price_cents":12500,"vat_bp":0})).unwrap();
    let today = chrono::Local::now().date_naive();
    let issue = (today - chrono::Days::new(60)).to_string();
    let due = (today - chrono::Days::new(30)).to_string();
    if entity == "quotes" {
        store.issue_quote(&id, Some(issue), Some(due)).unwrap();
    } else {
        store.issue_invoice(&id, Some(issue), Some(due)).unwrap();
    }
    let key = scope(&store).unwrap();
    std::fs::create_dir_all(folder(&store, &key)).unwrap();
    let connection = MailConnection {
        host: "smtp.example.invalid".into(),
        port: 465,
        security: "tls".into(),
        username: "test@example.invalid".into(),
        password: "LOCAL-FIXTURE-NOT-A-SECRET".into(),
        from_name: "Entreprise de test".into(),
        from_email: "test@example.invalid".into(),
    };
    write_protected_atomically_with_reference_after_server_verification(
        &secret_path(&store, &key),
        &serde_json::to_vec(&connection).unwrap(),
    )
    .unwrap();
    (
        temporary,
        store,
        MailTarget {
            entity: entity.into(),
            id,
        },
    )
}
fn install_synthetic_mail_license(store: &LocalStore) {
    use ed25519_dalek::Signer;
    let now = chrono::Utc::now();
    let today = chrono::Local::now().date_naive();
    let payload = crate::models::LicenseTokenPayload {
        token_version: 2,
        license_id: uuid::Uuid::new_v4().to_string(),
        installation_id: store.installation_id.clone(),
        jti: uuid::Uuid::new_v4().to_string(),
        kid: "hc-prod-v1".into(),
        customer_name: Some("Synthetic SMTP receipt company".into()),
        access_role: "owner".into(),
        account_user_id: None,
        account_session_id: None,
        plan: crate::license::LICENSE_PLAN.into(),
        price_chf_cents: crate::license::LICENSE_PRICE_CHF_CENTS,
        issued_at: now.to_rfc3339(),
        valid_from: (today - chrono::Duration::days(1)).to_string(),
        valid_until: (today + chrono::Duration::days(30)).to_string(),
    };
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).unwrap());
    let signature = ed25519_dalek::SigningKey::from_bytes(&[29; 32]).sign(encoded.as_bytes());
    let token = format!(
        "{encoded}.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes())
    );
    let state = store.install_server_issued_license(&token).unwrap();
    assert_eq!(state["status"], "valid");
    assert_eq!(state["read_only"], false);
    store.require_write_access().unwrap();
    store.clone().require_write_access().unwrap();
}
fn input(store: &LocalStore, target: MailTarget) -> SendMailInput {
    let p = preview(store, &target).unwrap();
    SendMailInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        scope: text(&p, "scope"),
        source_revision: text(&p, "sourceRevision"),
        target,
        recipient: text(&p, "recipient"),
        subject: text(&p, "subject"),
        body: text(&p, "body"),
    }
}
fn copy(input: &SendMailInput) -> SendMailInput {
    serde_json::from_value(serde_json::to_value(input).unwrap()).unwrap()
}
fn shared_connection() -> Value {
    json!({"connected":true,"connectionId":"bbbbbbbb-1111-4111-8111-111111111111","fromEmail":"office@example.invalid","fromName":"Nom vérifié"})
}
fn shared_request(store:&LocalStore,input:&SendMailInput)->AppResult<Value>{
    shared::prepare(store,input,"org-a",&shared_connection(),"bbbbbbbb-1111-4111-8111-111111111111")
}
fn shared_receipt(store:&LocalStore,input:&SendMailInput,status:&str)->Value{
    let raw:String=history_db(store,&input.scope).unwrap().query_row("SELECT payload_json FROM submissions WHERE request_id=?",params![input.request_id],|r|r.get(0)).unwrap();
    let payload:Value=serde_json::from_str(&raw).unwrap();
    json!({"requestId":input.request_id,"entity":input.target.entity,"documentId":input.target.id,"recipient":payload["recipient"],"subject":payload["subject"],"fromEmail":payload["from_email"],"attachmentHash":payload["attachment_sha256"],"status":status})
}
#[test]
fn shared_mail_builds_real_pdf_and_logo_and_recovers_without_second_submission(){
    let _serial=TEST_MAIL.lock().unwrap_or_else(|p|p.into_inner());
    for entity in ["quotes","invoices"] {
        let (temp,store,target)=fixture(entity);enable_logo(&temp,&store);
        let draft=input(&store,target.clone());
        let request=shared_request(&store,&draft).unwrap();
        let bytes=base64::engine::general_purpose::STANDARD.decode(text(&request,"pdfBase64")).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));assert!(bytes.len()>1000);
        assert!(text(&request,"signatureLogoDataUrl").starts_with("data:image/png;base64,"));
        assert!(!request.to_string().contains("LOCAL-FIXTURE-NOT-A-SECRET"));
        assert!(shared_request(&store,&draft).is_err()); // even a lost response cannot resend
        let receipt=shared_receipt(&store,&draft,"accepted");
        let recovered=shared::accept_receipt(&store,&draft.scope,&draft.request_id,"org-a",&receipt).unwrap();
        assert_eq!(recovered["status"],"accepted");assert_eq!(recovered["historyWarning"],false);
        assert_eq!(shared_request(&store,&draft).unwrap()["replayed"],true);
        assert_eq!(shared::accept_receipt(&store,&draft.scope,&draft.request_id,"org-a",&receipt).unwrap()["status"],"accepted");
        let count:i64=store.connect().unwrap().query_row("SELECT COUNT(*) FROM audit_log WHERE action='smtp_accepted'",[],|r|r.get(0)).unwrap();assert_eq!(count,1);
        assert_eq!(preview(&store,&target).unwrap()["history"][0]["channel"],"company_mail");
        let history=history_db(&store,&draft.scope).unwrap();
        let raw:String=history.query_row("SELECT payload_json FROM submissions",[],|r|r.get(0)).unwrap();
        assert!(!raw.contains("pdfBase64")&&!raw.contains("signatureLogoDataUrl"));
    }
}
#[test]
fn shared_mail_rejects_stale_document_sender_and_cross_company_receipts(){
    let _serial=TEST_MAIL.lock().unwrap_or_else(|p|p.into_inner());
    let (_temp,store,target)=fixture("quotes");let stale=input(&store,target.clone());
    store.connect().unwrap().execute("UPDATE clients SET email='changed@example.invalid'",[]).unwrap();
    assert!(shared_request(&store,&stale).unwrap_err().to_string().contains("changé"));
    let draft=input(&store,target);
    assert!(shared::prepare(&store,&draft,"org-a",&shared_connection(),"different-connection").is_err());
    shared_request(&store,&draft).unwrap();
    let receipt=shared_receipt(&store,&draft,"accepted");
    for field in ["requestId","entity","documentId","recipient","subject","fromEmail","attachmentHash"] {
        let mut changed=receipt.clone();changed[field]=json!("wrong");
        assert!(shared::accept_receipt(&store,&draft.scope,&draft.request_id,"org-a",&changed).is_err(),"{field}");
    }
    assert!(shared::accept_receipt(&store,&draft.scope,&draft.request_id,"org-b",&receipt).is_err());
    crate::company_collaboration::set_identity(&store,"other-org","owner","Other","owner").unwrap();
    assert!(shared::accept_receipt(&store,&draft.scope,&draft.request_id,"org-a",&receipt).is_err());
}
#[test]
fn shared_mail_nonaccepted_states_do_not_create_business_receipts_and_cannot_regress_acceptance(){
    let _serial=TEST_MAIL.lock().unwrap_or_else(|p|p.into_inner());
    let (_temp,store,target)=fixture("quotes");let draft=input(&store,target);shared_request(&store,&draft).unwrap();
    for status in ["pending","uncertain","rejected"] {
        let receipt=shared_receipt(&store,&draft,status);
        assert_eq!(shared::accept_receipt(&store,&draft.scope,&draft.request_id,"org-a",&receipt).unwrap()["status"],status);
        assert!(shared_request(&store,&draft).is_err());
        let count:i64=store.connect().unwrap().query_row("SELECT COUNT(*) FROM audit_log WHERE action='smtp_accepted'",[],|r|r.get(0)).unwrap();assert_eq!(count,0);
    }
    let accepted=shared_receipt(&store,&draft,"accepted");
    shared::accept_receipt(&store,&draft.scope,&draft.request_id,"org-a",&accepted).unwrap();
    let old=shared_receipt(&store,&draft,"pending");
    assert_eq!(shared::accept_receipt(&store,&draft.scope,&draft.request_id,"org-a",&old).unwrap()["status"],"accepted");
    assert!(shared::accept_receipt(&store,&draft.scope,&uuid::Uuid::new_v4().to_string(),"org-a",&accepted).unwrap_err().to_string().contains("Aucun envoi n’a été préparé"));
}
#[test]
fn shared_mail_reminder_recovery_preserves_paid_or_cancelled_status(){
    let _serial=TEST_MAIL.lock().unwrap_or_else(|p|p.into_inner());
    for paid_during_send in [false,true] {
        let (_temp,store,invoice)=fixture("invoices");
        store.install_reminder_cycle(InstallReminderCycleInput{request_id:uuid::Uuid::new_v4().to_string(),sender_name:None}).unwrap();
        let scan=store.generate_due_reminders(None).unwrap();
        let target=MailTarget{entity:"reminders".into(),id:text(&scan["created"][0],"id")};
        let draft=input(&store,target.clone());shared_request(&store,&draft).unwrap();
        if paid_during_send {
            store.record_payment(RecordPaymentInput{request_id:uuid::Uuid::new_v4().to_string(),invoice_id:invoice.id,amount_cents:12500,date:Some(chrono::Local::now().date_naive().to_string()),method:Some("bank".into()),reference:None,notes:None}).unwrap();
        } else {
            store.connect().unwrap().execute("UPDATE reminders SET status='cancelled' WHERE id=?",params![target.id]).unwrap();
        }
        let before:String=store.connect().unwrap().query_row("SELECT status FROM reminders WHERE id=?",params![target.id],|r|r.get(0)).unwrap();
        let receipt=shared_receipt(&store,&draft,"accepted");
        assert_eq!(shared::accept_receipt(&store,&draft.scope,&draft.request_id,"org-a",&receipt).unwrap()["historyWarning"],false);
        let after:String=store.connect().unwrap().query_row("SELECT status FROM reminders WHERE id=?",params![target.id],|r|r.get(0)).unwrap();assert_eq!(before,after);
    }
}
#[test]
fn mail_read_only_collaborator_cannot_submit_with_a_saved_connection() {
    let _serial = TEST_MAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (_temporary, store, target) = fixture("quotes");
    store.connect().unwrap().execute("INSERT INTO company_local_identity VALUES(1,'test-company','test-user','Test','owner')",[]).unwrap();
    let draft = input(&store, target);
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE company_local_identity SET role='read_only' WHERE id=1",
            [],
        )
        .unwrap();
    let error = send_using(&store, draft, |_, _| {
        panic!("A read-only collaborator must not contact SMTP")
    })
    .unwrap_err();
    assert!(error.to_string().contains("consultation uniquement"));
}
#[test]
fn mail_quote_uses_real_pdf_and_never_resends_same_attempt() {
    let _serial = TEST_MAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (_temporary, store, target) = fixture("quotes");
    let draft = input(&store, target.clone());
    let replay = copy(&draft);
    let result = send_using(&store, draft, |_, message| {
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(raw.contains("application/pdf"));
        assert!(raw.contains("Content-Disposition: attachment"));
        assert!(raw.contains("client@example.invalid"));
        assert!(raw.contains("125.00"));
        assert!(!raw.contains("LOCAL-FIXTURE-NOT-A-SECRET"));
        Ok(())
    })
    .unwrap();
    assert_eq!(result["status"], "accepted");
    assert_eq!(result["historyWarning"], false);
    assert_eq!(
        send_using(&store, replay, |_, _| panic!("must not transmit twice")).unwrap()["replayed"],
        true
    );
    let count: i64 = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM audit_log WHERE action='smtp_accepted'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(
        preview(&store, &target).unwrap()["history"][0]["status"],
        "accepted"
    );
}
#[test]
fn mail_uncertain_attempt_cannot_be_replayed_or_recorded_as_success() {
    let _serial = TEST_MAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (_temporary, store, target) = fixture("quotes");
    let draft = input(&store, target.clone());
    let replay = copy(&draft);
    assert!(
        send_using(&store, draft, |_, _| Err(SubmissionFailure::Uncertain))
            .unwrap_err()
            .to_string()
            .contains("peut-être")
    );
    assert!(send_using(&store, replay, |_, _| panic!("no automatic retry")).is_err());
    assert_eq!(
        preview(&store, &target).unwrap()["history"][0]["status"],
        "uncertain"
    );
    let count: i64 = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM audit_log WHERE action='smtp_accepted'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}
#[test]
fn mail_stale_recipient_or_company_cannot_send() {
    let _serial = TEST_MAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (_temporary, store, target) = fixture("quotes");
    let draft = input(&store, target.clone());
    store
        .connect()
        .unwrap()
        .execute("UPDATE clients SET email='new@example.invalid'", [])
        .unwrap();
    assert!(send_using(&store, draft, |_, _| panic!("stale recipient"))
        .unwrap_err()
        .to_string()
        .contains("changé"));
    let draft = input(&store, target);
    crate::company_collaboration::set_identity(&store, "other-org", "owner", "Other", "owner")
        .unwrap();
    assert!(send_using(&store, draft, |_, _| panic!("wrong company"))
        .unwrap_err()
        .to_string()
        .contains("entreprise a changé"));
    assert_eq!(
        store.outgoing_mail_state().unwrap()["connection"]["connected"],
        false
    );
}
#[test]
fn mail_templates_roundtrip_and_credentials_stay_out_of_business_data() {
    let _serial = TEST_MAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (_temporary, store, target) = fixture("quotes");
    let key = scope(&store).unwrap();
    let mut templates = MailTemplates::default();
    templates.quotes.subject = "{entreprise} / {numero}".into();
    templates.quotes.body = "Bonjour {client}\n\n{montant}\n{email_entreprise}".into();
    store.save_mail_templates(&key, templates, None).unwrap();
    let p = preview(&store, &target).unwrap();
    assert!(text(&p, "subject").starts_with("Entreprise de test / "));
    assert!(text(&p, "body").contains("\n\n125.00 CHF"));
    let business = store.get_workspace().unwrap().to_string();
    assert!(!business.contains("LOCAL-FIXTURE-NOT-A-SECRET"));
    assert!(!store
        .outgoing_mail_state()
        .unwrap()
        .to_string()
        .contains("LOCAL-FIXTURE-NOT-A-SECRET"));
    let protected = std::fs::read(secret_path(&store, &key)).unwrap();
    assert!(!String::from_utf8_lossy(&protected).contains("LOCAL-FIXTURE-NOT-A-SECRET"));
    clear_local_connections(&store).unwrap();
    assert!(!secret_path(&store, &key).exists());
    let disconnected = store.outgoing_mail_state().unwrap();
    let company: Value = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT company_name,email FROM settings WHERE id=1",
            [],
            row_to_json_public,
        )
        .unwrap();
    assert_eq!(disconnected["connection"]["connected"], false);
    assert_eq!(
        disconnected["connection"]["fromName"],
        company["company_name"]
    );
    assert_eq!(disconnected["connection"]["fromEmail"], company["email"]);
}
#[test]
fn mail_reminder_rechecks_payment_and_closes_only_after_smtp_acceptance() {
    let _serial = TEST_MAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (_temporary, store, _invoice) = fixture("invoices");
    store
        .install_reminder_cycle(InstallReminderCycleInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            sender_name: Some("Entreprise de test".into()),
        })
        .unwrap();
    let scan = store.generate_due_reminders(None).unwrap();
    let id = text(&scan["created"][0], "id");
    assert!(!id.is_empty());
    let target = MailTarget {
        entity: "reminders".into(),
        id: id.clone(),
    };
    let draft = input(&store, target.clone());
    assert!(send_using(&store, copy(&draft), |_, _| Err(
        SubmissionFailure::Rejected
    ))
    .is_err());
    let state: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT status FROM reminders WHERE id=?",
            params![id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "due");
    let result = send_using(&store, input(&store, target.clone()), |_, _| Ok(())).unwrap();
    assert_eq!(result["historyWarning"], false);
    let state: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT status FROM reminders WHERE id=?",
            params![id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "completed");
    // A second invoice supplies an unpaid reminder; a payment invalidates its composer.
    let (_other_temp, other, other_invoice) = fixture("invoices");
    other
        .install_reminder_cycle(InstallReminderCycleInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            sender_name: None,
        })
        .unwrap();
    let scan = other.generate_due_reminders(None).unwrap();
    let pending = input(
        &other,
        MailTarget {
            entity: "reminders".into(),
            id: text(&scan["created"][0], "id"),
        },
    );
    other
        .record_payment(RecordPaymentInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            invoice_id: other_invoice.id,
            amount_cents: 12500,
            date: Some(chrono::Local::now().date_naive().to_string()),
            method: Some("bank".into()),
            reference: None,
            notes: None,
        })
        .unwrap();
    assert!(send_using(&other, pending, |_, _| panic!(
        "paid invoice must not be reminded"
    ))
    .is_err());
}

// Exact prior send_using body retained only as a synthetic regression witness.
fn send_using_before_confirmed_receipt(
    store: &LocalStore,
    input: SendMailInput,
    submit: impl FnOnce(&SmtpTransport, &Message) -> Result<(), SubmissionFailure>,
) -> AppResult<Value> {
    let _mail = MailGuard::take()?;
    uuid::Uuid::parse_str(&input.request_id)
        .map_err(|_| invalid("Rouvrez l’e-mail pour préparer un nouvel envoi."))?;
    address(&input.recipient)?;
    validate_message(&input.subject, &input.body)?;
    let payload_hash = hash(&serde_json::to_vec(&input)?);
    let (transport, message) = {
        let _local = store.lock()?;
        check_scope(store, &input.scope)?;
        require_sender(store)?;
        let db = history_db(store, &input.scope)?;
        let previous: Option<(String, String)> = db
            .query_row(
                "SELECT payload_hash,status FROM submissions WHERE request_id=?",
                params![input.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((old, status)) = previous {
            if old != payload_hash {
                return Err(invalid("Cette tentative existe déjà. Fermez puis rouvrez le message avant de préparer un autre envoi."));
            }
            if status == "accepted" {
                let recorded = record_receipt(store, &input).is_ok();
                return Ok(json!({"status":"accepted","replayed":true,"historyWarning":!recorded}));
            }
            return Err(invalid("L’envoi précédent n’a pas de confirmation certaine. Vérifiez auprès du destinataire ou de votre messagerie avant de préparer un nouvel envoi : réessayer pourrait créer un doublon."));
        }
        let current = preview(store, &input.target)?;
        if text(&current, "sourceRevision") != input.source_revision {
            return Err(invalid("Le document ou son solde a changé. Fermez puis rouvrez l’e-mail pour utiliser les informations à jour."));
        }
        let connection = read_connection(store, &input.scope)?;
        let logo = selected_mail_logo(store)?;
        let pdf = store.document_pdf_preview(
            &text(&current, "documentEntity"),
            &text(&current, "documentId"),
        )?;
        let message_id = format!(
            "<{}@{}>",
            input.request_id,
            connection
                .from_email
                .split('@')
                .next_back()
                .unwrap_or("zentra.local")
        );
        let pdf_sha256 = hash(&pdf);
        let reminder = if input.target.entity == "reminders" {
            Some(store.preview_reminder_delivery(ReminderPreviewInput {
                id: input.target.id.clone(),
                prepared_on: None,
            })?)
        } else {
            None
        };
        let payload = json!({"schema":"zentra.smtp_submission.v1","request_id":input.request_id,"channel":"smtp","recipient":input.recipient,"subject":input.subject,"body":input.body,"from_email":connection.from_email,"from_name":connection.from_name,"attachment_name":current["attachmentName"],"attachment_sha256":pdf_sha256,"reminder":reminder,"message_id":message_id});
        let message = build_message(
            &connection,
            &input,
            pdf,
            &text(&current, "attachmentName"),
            &message_id,
            logo.as_ref(),
        )?;
        let transport = connection.transport()?;
        db.execute(
            "INSERT INTO submissions VALUES(?,?,?,?,?,?,'pending',?,?,?)",
            params![
                input.request_id,
                payload_hash,
                input.target.entity,
                input.target.id,
                input.recipient,
                input.subject,
                now_iso(),
                message_id,
                payload.to_string()
            ],
        )?;
        (transport, message)
    };
    // Network I/O never holds the company lock or the GUI thread.
    let result = submit(&transport, &message);
    let status = match result {
        Ok(()) => "accepted",
        Err(SubmissionFailure::Rejected) => "rejected",
        Err(SubmissionFailure::Uncertain) => "uncertain",
    };
    let persisted = history_db(store, &input.scope)
        .and_then(|db| {
            Ok(db.execute(
                "UPDATE submissions SET status=? WHERE request_id=?",
                params![status, input.request_id],
            )?)
        })
        .is_ok();
    if result.is_err() {
        return Err(invalid(if status == "rejected" {
            "Le serveur a refusé l’e-mail. Vérifiez le destinataire, l’expéditeur autorisé et les réglages de votre messagerie avant de préparer un nouvel envoi."
        } else {
            "La connexion a été interrompue. L’e-mail a peut-être été envoyé : vérifiez auprès du destinataire avant de préparer un nouvel envoi. Aucun renvoi automatique n’aura lieu."
        }));
    }
    let _local = store.lock()?;
    let recorded = record_receipt(store, &input).is_ok();
    Ok(json!({"status":"accepted","replayed":false,"historyWarning":!persisted||!recorded}))
}

fn history_reporter_guard_checkpoint(
    store: &LocalStore,
    checks: &mut Vec<(bool, bool)>,
    readers: &mut Vec<(std::thread::JoinHandle<()>, std::sync::mpsc::Receiver<bool>)>,
) {
    let mail_available = MailGuard::take().is_ok();
    let reader = store.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        tx.send(reader.lock().is_ok()).unwrap();
    });
    let store_available = rx.recv_timeout(Duration::from_secs(1)).ok() == Some(true);
    checks.push((mail_available, store_available));
    // Retain the receiver through thread completion even when a negative
    // guard oracle times out; do not introduce a SendError fixture cascade.
    readers.push((thread, rx));
}
fn finish_history_reporter_checks(
    checks: Vec<(bool, bool)>,
    readers: Vec<(std::thread::JoinHandle<()>, std::sync::mpsc::Receiver<bool>)>,
) {
    for (thread, _receiver) in readers {
        thread.join().unwrap();
    }
    assert!(!checks.is_empty());
    assert!(checks.iter().all(|&(mail, store)| mail && store));
}
fn submission_status(store: &LocalStore, scope: &str, request_id: &str) -> String {
    history_db(store, scope)
        .unwrap()
        .query_row(
            "SELECT status FROM submissions WHERE request_id=?",
            params![request_id],
            |r| r.get(0),
        )
        .unwrap()
}
fn smtp_receipt_count(store: &LocalStore) -> i64 {
    store
        .connect()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM audit_log WHERE action='smtp_accepted'",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn mail_confirmed_acceptance_survives_poisoned_store_and_replay_submits_once() {
    let _serial = TEST_MAIL.lock().unwrap_or_else(|p| p.into_inner());
    for before in [true, false] {
        let (temporary, store, target) = fixture("quotes");
        let draft = input(&store, target);
        let replay = copy(&draft);
        let key = draft.scope.clone();
        let request = draft.request_id.clone();
        let mut submissions = 0;
        let mut reports = Vec::new();
        let submit = |_: &SmtpTransport, _: &Message| {
            submissions += 1;
            let poisoned = store.clone();
            assert!(std::thread::spawn(move || {
                let _guard = poisoned.lock().unwrap();
                panic!("Synthetic local-store poison after SMTP acceptance");
            })
            .join()
            .is_err());
            Ok(())
        };
        let result = if before {
            send_using_before_confirmed_receipt(&store, draft, submit)
        } else {
            send_using_with_history_reporter(&store, draft, submit, |error| {
                assert!(matches!(error, AppError::Validation(_)));
                assert!(MailGuard::take().is_ok());
                reports.push("input.validation");
            })
        };
        assert_eq!(submissions, 1);
        assert_eq!(submission_status(&store, &key, &request), "accepted");
        assert_eq!(smtp_receipt_count(&store), 0);
        if before {
            assert_eq!(
                result.unwrap_err().to_string(),
                "Champ invalide : Le verrou de la base locale est indisponible."
            );
            assert!(reports.is_empty());
        } else {
            let receipt = result.unwrap();
            assert_eq!(receipt["status"], "accepted");
            assert_eq!(receipt["historyWarning"], true);
            assert_eq!(receipt["replayed"], false);
            assert_eq!(reports, ["input.validation"]);
        }
        // Reopening restores the per-instance mutex, not by clearing poison
        // in product code. The same persisted attempt can only be recovered.
        let mut reopened = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        reopened.configure_test_license_key(
            ed25519_dalek::SigningKey::from_bytes(&[29; 32])
                .verifying_key()
                .to_bytes(),
        );
        reopened.require_write_access().unwrap();
        let recovered = send_using_with_history_reporter(
            &reopened,
            replay,
            |_, _| panic!("A confirmed request must never be submitted again"),
            |_| panic!("The recovered receipt should succeed"),
        )
        .unwrap();
        assert_eq!(recovered["status"], "accepted");
        assert_eq!(recovered["replayed"], true);
        assert_eq!(recovered["historyWarning"], false);
        assert_eq!(smtp_receipt_count(&reopened), 1);
        assert_eq!(submissions, 1);
    }
}

#[test]
fn mail_confirmed_history_failures_are_reported_after_both_guards_without_retry() {
    let _serial = TEST_MAIL.lock().unwrap_or_else(|p| p.into_inner());
    let (_temporary, store, target) = fixture("quotes");
    let draft = input(&store, target);
    let replay = copy(&draft);
    let key = draft.scope.clone();
    let request = draft.request_id.clone();
    let history_path = folder(&store, &key).join("submissions.sqlite3");
    let mut saved_history = None;
    let mut submissions = 0;
    let mut categories = Vec::new();
    let mut checks = Vec::new();
    let mut readers = Vec::new();
    let result = send_using_with_history_reporter(
        &store,
        draft,
        |_, _| {
            submissions += 1;
            saved_history = Some(std::fs::read(&history_path).unwrap());
            std::fs::write(&history_path, b"SYNTHETIC INVALID SMTP HISTORY").unwrap();
            Ok(())
        },
        |error| {
            assert!(matches!(error, AppError::Database(_)));
            categories.push("storage.database");
            history_reporter_guard_checkpoint(&store, &mut checks, &mut readers);
        },
    )
    .unwrap();
    finish_history_reporter_checks(checks, readers);
    assert_eq!(result["status"], "accepted");
    assert_eq!(result["historyWarning"], true);
    assert_eq!(categories, ["storage.database", "storage.database"]);
    assert_eq!(submissions, 1);
    std::fs::write(&history_path, saved_history.unwrap()).unwrap();
    assert_eq!(submission_status(&store, &key, &request), "pending");
    assert_eq!(smtp_receipt_count(&store), 0);
    assert!(send_using_with_history_reporter(
        &store,
        replay,
        |_, _| panic!("An uncertain persisted receipt cannot authorize retry"),
        |_| panic!("No best-effort history failure on this refusal"),
    )
    .is_err());
    assert_eq!(submissions, 1);
}

#[test]
fn mail_confirmed_replay_preserves_acceptance_and_reports_receipt_failure_without_payload() {
    let _serial = TEST_MAIL.lock().unwrap_or_else(|p| p.into_inner());
    let (_temporary, store, target) = fixture("quotes");
    let draft = input(&store, target);
    let replay = copy(&draft);
    let recovered = copy(&draft);
    let key = draft.scope.clone();
    let request = draft.request_id.clone();
    store.connect().unwrap().execute_batch(
        "CREATE TRIGGER refuse_smtp_fixture_receipt BEFORE INSERT ON audit_log WHEN NEW.action='smtp_accepted' BEGIN SELECT RAISE(FAIL,'PRIVATE-FIXTURE-RECIPIENT-SUBJECT-BODY'); END;"
    ).unwrap();
    let mut submissions = 0;
    let mut categories = Vec::new();
    let mut checks = Vec::new();
    let mut readers = Vec::new();
    let mut reporter = |error: &AppError| {
        // Only the closed category is retained by this fixture reporter.
        assert!(matches!(error, AppError::Database(_)));
        categories.push("storage.database");
        history_reporter_guard_checkpoint(&store, &mut checks, &mut readers);
    };
    let accepted = send_using_with_history_reporter(
        &store,
        draft,
        |_, _| {
            submissions += 1;
            Ok(())
        },
        &mut reporter,
    )
    .unwrap();
    assert_eq!(accepted["status"], "accepted");
    assert_eq!(accepted["historyWarning"], true);
    let accepted_again = send_using_with_history_reporter(
        &store,
        replay,
        |_, _| panic!("Accepted replay is a receipt recovery only"),
        &mut reporter,
    )
    .unwrap();
    assert_eq!(accepted_again["status"], "accepted");
    assert_eq!(accepted_again["replayed"], true);
    assert_eq!(accepted_again["historyWarning"], true);
    drop(reporter);
    finish_history_reporter_checks(checks, readers);
    assert_eq!(categories, ["storage.database", "storage.database"]);
    assert_eq!(submissions, 1);
    assert_eq!(submission_status(&store, &key, &request), "accepted");
    assert_eq!(smtp_receipt_count(&store), 0);
    store
        .connect()
        .unwrap()
        .execute_batch("DROP TRIGGER refuse_smtp_fixture_receipt")
        .unwrap();
    let accepted_final = send_using_with_history_reporter(
        &store,
        recovered,
        |_, _| panic!("Recovery after history repair must not resend"),
        |_| panic!("History repair must not report an error"),
    )
    .unwrap();
    assert_eq!(accepted_final["status"], "accepted");
    assert_eq!(accepted_final["historyWarning"], false);
    assert_eq!(smtp_receipt_count(&store), 1);
}

#[test]
fn mail_rejected_and_uncertain_keep_original_errors_when_history_fails() {
    let _serial = TEST_MAIL.lock().unwrap_or_else(|p| p.into_inner());
    for failure in [SubmissionFailure::Rejected, SubmissionFailure::Uncertain] {
        let (_temporary, store, target) = fixture("quotes");
        let draft = input(&store, target);
        let replay = copy(&draft);
        let key = draft.scope.clone();
        let request = draft.request_id.clone();
        let history_path = folder(&store, &key).join("submissions.sqlite3");
        let mut saved_history = None;
        let mut submissions = 0;
        let mut reports = 0;
        let mut checks = Vec::new();
        let mut readers = Vec::new();
        let error = send_using_with_history_reporter(
            &store,
            draft,
            |_, _| {
                submissions += 1;
                saved_history = Some(std::fs::read(&history_path).unwrap());
                std::fs::write(&history_path, b"SYNTHETIC INVALID SMTP HISTORY").unwrap();
                Err(failure)
            },
            |error| {
                assert!(matches!(error, AppError::Database(_)));
                reports += 1;
                history_reporter_guard_checkpoint(&store, &mut checks, &mut readers);
            },
        )
        .unwrap_err();
        finish_history_reporter_checks(checks, readers);
        let original = match failure {
            SubmissionFailure::Rejected => "Champ invalide : Le serveur a refusé l’e-mail. Vérifiez le destinataire, l’expéditeur autorisé et les réglages de votre messagerie avant de préparer un nouvel envoi.",
            SubmissionFailure::Uncertain => "Champ invalide : La connexion a été interrompue. L’e-mail a peut-être été envoyé : vérifiez auprès du destinataire avant de préparer un nouvel envoi. Aucun renvoi automatique n’aura lieu.",
        };
        assert_eq!(error.to_string(), original);
        assert_eq!(reports, 1);
        assert_eq!(submissions, 1);
        std::fs::write(&history_path, saved_history.unwrap()).unwrap();
        assert_eq!(submission_status(&store, &key, &request), "pending");
        assert_eq!(smtp_receipt_count(&store), 0);
        assert!(send_using_with_history_reporter(
            &store,
            replay,
            |_, _| panic!("No automatic retry after refused or uncertain SMTP"),
            |_| panic!("No best-effort history failure on this refusal"),
        )
        .is_err());
    }
}

#[test]
fn mail_success_and_replay_do_not_report_native_history_errors() {
    let _serial = TEST_MAIL.lock().unwrap_or_else(|p| p.into_inner());
    let (_temporary, store, target) = fixture("quotes");
    let draft = input(&store, target);
    let replay = copy(&draft);
    let mut submissions = 0;
    let result = send_using_with_history_reporter(
        &store,
        draft,
        |_, _| {
            submissions += 1;
            Ok(())
        },
        |_| panic!("A successful receipt must not create an error event"),
    )
    .unwrap();
    assert_eq!(result["status"], "accepted");
    assert_eq!(result["historyWarning"], false);
    let repeated = send_using_with_history_reporter(
        &store,
        replay,
        |_, _| panic!("Accepted replay must not submit"),
        |_| panic!("Successful replay must not create an error event"),
    )
    .unwrap();
    assert_eq!(repeated["status"], "accepted");
    assert_eq!(repeated["replayed"], true);
    assert_eq!(repeated["historyWarning"], false);
    assert_eq!(submissions, 1);
    assert_eq!(smtp_receipt_count(&store), 1);
}

mod settings_signature_preservation_tests {
    use super::*;

    // No connection, document or SMTP submission is created by these fixtures.
    fn signature_fixture() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let mut store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.configure_test_license_key(
            ed25519_dalek::SigningKey::from_bytes(&[29; 32])
                .verifying_key()
                .to_bytes(),
        );
        store
            .complete_onboarding(crate::tests::test_onboarding(), "1.0.0")
            .unwrap();
        install_synthetic_mail_license(&store);
        (temporary, store)
    }

    fn stored_extra(store: &LocalStore) -> Value {
        let raw: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT extra_settings_json FROM settings WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    fn settings_snapshot(store: &LocalStore) -> Value {
        let db = store.connect().unwrap();
        let settings: Value = db
            .query_row("SELECT * FROM settings WHERE id=1", [], row_to_json_public)
            .unwrap();
        let clock: i64 = db
            .query_row("SELECT value FROM company_local_clock WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap();
        json!({"settings":settings,"clock":clock,"audit":crate::audit::verify_audit_chain(&db).unwrap()})
    }

    #[test]
    fn unrelated_settings_save_preserves_only_the_omitted_mail_signature() {
        let (temporary, store) = signature_fixture();
        enable_logo(&temporary, &store);
        let old_extra = json!({
            "mailSignature":{"includeCompanyLogo":true},
            "billing":{"defaultFooter":"old footer"},
            "payroll":{"oldPreference":true},
            "mailTemplates":MailTemplates::default(),
            "unsupportedOldKey":{"keep":false}
        });
        store
            .update_settings(json!({"extra_settings_json":old_extra}))
            .unwrap();
        let mut incoming_templates = MailTemplates::default();
        incoming_templates.quotes.subject = "Devis {numero}".into();
        // Like backendExtra, the replacement is a JSON string without mailSignature.
        let incoming_extra = json!({
            "mailTemplates":incoming_templates,
            "billing":{"defaultFooter":"new footer"},
            "payroll":{"newPreference":true},
            "backup":{"enabled":false}
        });
        let received = store
            .update_settings(json!({
                "payment_terms_days":45,
                "extra_settings_json":incoming_extra.to_string()
            }))
            .unwrap();
        assert_eq!(received["payment_terms_days"], 45);
        let mut expected = incoming_extra;
        expected["mailSignature"] = json!({"includeCompanyLogo":true});
        assert_eq!(stored_extra(&store), expected);
        let public_state = store.outgoing_mail_state().unwrap();
        assert_eq!(public_state["signature"]["includeCompanyLogo"], true);
        assert_eq!(public_state["templates"]["quotes"]["subject"], "Devis {numero}");
        assert!(public_state["companyLogoDataUrl"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert!(crate::audit::verify_audit_chain(&store.connect().unwrap()).unwrap()["valid"].as_bool().unwrap());
    }

    #[test]
    fn omitted_and_normalized_empty_extra_keep_signature_without_inventing_one() {
        let (temporary, store) = signature_fixture();
        enable_logo(&temporary, &store);
        let before = stored_extra(&store);
        store
            .update_settings(json!({"payment_terms_days":31}))
            .unwrap();
        assert_eq!(stored_extra(&store), before);
        for extra in [json!({}), json!("{}"), Value::Null] {
            store
                .update_settings(json!({"extra_settings_json":extra}))
                .unwrap();
            assert_eq!(stored_extra(&store), json!({"mailSignature":{"includeCompanyLogo":true}}));
            assert!(signature(&store).unwrap().include_company_logo);
        }
        let (_other_temporary, other) = signature_fixture();
        assert!(stored_extra(&other).get("mailSignature").is_none());
        other.update_settings(json!({"extra_settings_json":{}})).unwrap();
        assert_eq!(stored_extra(&other), json!({}));
        assert!(!signature(&other).unwrap().include_company_logo);
    }

    #[test]
    fn explicit_mail_disable_is_not_resurrected_by_an_older_settings_payload() {
        let (temporary, store) = signature_fixture();
        enable_logo(&temporary, &store);
        let stale_extra_without_signature = json!({"backup":{"enabled":false}}).to_string();
        let key = scope(&store).unwrap();
        store
            .save_mail_templates(&key, MailTemplates::default(), Some(MailSignature {
                include_company_logo:false
            }))
            .unwrap();
        store
            .update_settings(json!({"extra_settings_json":stale_extra_without_signature}))
            .unwrap();
        assert!(!signature(&store).unwrap().include_company_logo);
        store.save_mail_templates(&key, MailTemplates::default(), None).unwrap();
        assert!(!signature(&store).unwrap().include_company_logo);
        assert_eq!(stored_extra(&store)["mailSignature"], json!({"includeCompanyLogo":false}));
    }

    #[test]
    fn invalid_unrelated_settings_leave_signature_settings_clock_and_audit_unchanged() {
        let (temporary, store) = signature_fixture();
        enable_logo(&temporary, &store);
        let before = settings_snapshot(&store);
        let error = store
            .update_settings(json!({
                "vat_registered":false,
                "default_vat_bp":810,
                "extra_settings_json":{"backup":{"enabled":false}}
            }))
            .unwrap_err();
        assert!(matches!(error, AppError::Validation(_)));
        assert_eq!(settings_snapshot(&store), before);
        assert!(signature(&store).unwrap().include_company_logo);
    }

    #[test]
    fn audit_failure_rolls_back_preserved_signature_and_retry_commits_once() {
        let (temporary, store) = signature_fixture();
        enable_logo(&temporary, &store);
        let before = settings_snapshot(&store);
        store.connect().unwrap().execute_batch(
            "CREATE TRIGGER refuse_signature_settings_audit BEFORE INSERT ON audit_log WHEN NEW.action='update' AND NEW.entity_type='settings' BEGIN SELECT RAISE(FAIL,'Synthetic settings audit refusal'); END;"
        ).unwrap();
        let patch = json!({"payment_terms_days":45,"extra_settings_json":{"backup":{"enabled":false}}});
        let error = store.update_settings(patch.clone()).unwrap_err();
        assert!(matches!(error, AppError::Database(_)));
        assert_eq!(settings_snapshot(&store), before);
        store.connect().unwrap().execute_batch("DROP TRIGGER refuse_signature_settings_audit").unwrap();
        store.update_settings(patch).unwrap();
        assert_eq!(stored_extra(&store), json!({"backup":{"enabled":false},"mailSignature":{"includeCompanyLogo":true}}));
        let after = settings_snapshot(&store);
        assert_eq!(after["audit"]["entries"].as_i64().unwrap(), before["audit"]["entries"].as_i64().unwrap()+1);
        assert_eq!(after["settings"]["payment_terms_days"],45);
        assert!(after["clock"].as_i64().unwrap()>before["clock"].as_i64().unwrap());
    }

    #[test]
    fn mail_signature_configuration_keeps_admin_scope_template_and_logo_guards() {
        let (temporary, store) = signature_fixture();
        let key = scope(&store).unwrap();
        let before = settings_snapshot(&store);
        assert!(store.save_mail_templates(&key,MailTemplates::default(),Some(MailSignature {
            include_company_logo:true
        })).is_err());
        assert_eq!(settings_snapshot(&store),before);
        enable_logo(&temporary,&store);
        let before = settings_snapshot(&store);
        assert!(store.save_mail_templates("different-company",MailTemplates::default(),Some(MailSignature {
            include_company_logo:false
        })).is_err());
        assert_eq!(settings_snapshot(&store),before);
        let mut invalid_templates=MailTemplates::default();
        invalid_templates.quotes.body="{unsupported_variable}".into();
        assert!(store.save_mail_templates(&key,invalid_templates,Some(MailSignature {
            include_company_logo:false
        })).is_err());
        assert_eq!(settings_snapshot(&store),before);
        store.connect().unwrap().execute(
            "INSERT INTO company_local_identity VALUES(1,'signature-fixture','synthetic-user','Synthetic','member')",[]
        ).unwrap();
        let key=scope(&store).unwrap();
        let before=settings_snapshot(&store);
        let error=store.save_mail_templates(&key,MailTemplates::default(),Some(MailSignature {
            include_company_logo:false
        })).unwrap_err();
        assert!(error.to_string().contains("administrateur"));
        assert_eq!(settings_snapshot(&store),before);
        assert!(signature(&store).unwrap().include_company_logo);
    }
}
