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
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), "1.0.0")
        .unwrap();
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
