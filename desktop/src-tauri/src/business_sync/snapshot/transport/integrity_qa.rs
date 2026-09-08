//! Fictitious native postings and a long audit chain for explicit HTTPS QA.
use super::*;

pub(super) fn seed(store: &LocalStore) -> AppResult<()> {
    use crate::models::{RecordPaymentInput, SaveDocumentWithItemsInput};
    store.install_swiss_accounting_starter()?;
    let customer=store.create_record("clients",json!({"name":"Client fictif de recette comptable","address_line1":"Rue du Test","postal_code":"1000","city":"Lausanne","country":"CH"}))?;
    let saved=store.save_document_with_items(SaveDocumentWithItemsInput {
        entity:"invoices".into(),id:None,
        data:json!({"client_id":customer["id"],"title":"Recette HTTPS comptabilité","service_date_from":"2026-09-08","service_date_to":"2026-09-08","currency":"CHF"}),
        items:vec![json!({"description":"Prestation fictive\nDeuxième ligne","quantity":1.25,"unit":"heure","unit_price_cents":80000,"discount_bp":0,"vat_bp":0})],
    })?;
    let id = saved["document"]["id"]
        .as_str()
        .ok_or_else(|| invalid("QA invoice missing"))?;
    store.issue_invoice(id, Some("2026-09-08".into()), None)?;
    store.record_payment(RecordPaymentInput {
        request_id: Uuid::new_v4().to_string(),
        invoice_id: id.into(),
        amount_cents: 30000,
        date: Some("2026-09-08".into()),
        method: Some("Banque".into()),
        reference: None,
        notes: Some("Versement fictif de recette".into()),
    })?;
    let (bank, receivable): (String, String) = store.connect()?.query_row(
        "SELECT bank_account_id,ar_account_id FROM accounting_settings WHERE id=1",
        [], |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let manual = store.post_manual_journal_entry(serde_json::from_value(json!({
        "entry_date":"2026-09-08", "description":"Écriture manuelle fictive et ses deux extournes", "currency":"CHF",
        "lines":[{"account_id":bank,"debit_cents":10000,"credit_cents":0}, {"account_id":receivable,"debit_cents":0,"credit_cents":10000}]
    }))?)?;
    let reversed = store.reverse_journal_entry(manual["id"].as_str().ok_or_else(|| invalid("Manual journal missing"))?, "2026-09-08", None)?;
    store.reverse_journal_entry(reversed["id"].as_str().ok_or_else(|| invalid("Reversal journal missing"))?, "2026-09-08", None)?;
    println!("QA_POSTINGS_FIXTURE entries=5 reversals=2 invoice=100000 payment=30000 manual=10000");
    seed_cash_vat(store, customer["id"].as_str().ok_or_else(|| invalid("QA customer missing"))?)?;
    seed_credit_history(store, customer["id"].as_str().ok_or_else(|| invalid("QA customer missing"))?)?;
    let mut connection = store.connect()?;
    let tx = connection.transaction()?;
    for index in 0..1005 {
        crate::audit::append_audit(
            &tx,
            "qa_integrity",
            "fixture",
            &format!("fictitious-{index}"),
            &json!({"texte":"Recette fictive uniquement\nÉcriture vérifiée","index":index}),
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn seed_cash_vat(store: &LocalStore, customer_id: &str) -> AppResult<()> {
    use crate::models::{RecordPaymentInput, SaveDocumentWithItemsInput};
    store.connect()?.execute("UPDATE settings SET vat_registered=1,uid_number='CHE-123.456.789',vat_number='CHE-123.456.789 TVA' WHERE id=1", [])?;
    store.create_vat_profile(crate::vat_reporting::VatProfileInput {
        id: Some("qa-bootstrap-cash-vat".into()), effective_from: "2026-04-01".into(), effective_to: None,
        reporting_method: "effective".into(), form_of_reporting: "received".into(), periodicity: "quarterly".into(), gross_or_net: "net".into(),
        tdfn_activity_id: None, tdfn_rate_bp: None, afc_authorization_confirmed: true,
        notes: Some("Entreprise fictive de recette uniquement ; aucune déclaration AFC.".into()), close_previous_open_profile: false,
    })?;
    let saved = store.save_document_with_items(SaveDocumentWithItemsInput {
        entity: "invoices".into(), id: None,
        data: json!({"client_id":customer_id,"title":"Recette TVA sur deux encaissements","service_date_from":"2026-04-01","service_date_to":"2026-04-01","currency":"CHF"}),
        items: vec![json!({"description":"Prestation fictive soumise à TVA","quantity":1,"unit":"pièce","unit_price_cents":100000,"discount_bp":0,"vat_bp":810})],
    })?;
    let invoice = saved["document"]["id"].as_str().ok_or_else(|| invalid("Cash VAT invoice missing"))?;
    let item: String = store.connect()?.query_row("SELECT id FROM invoice_items WHERE invoice_id=?", [invoice], |r| r.get(0))?;
    store.set_vat_source_classification(crate::vat_reporting::VatSourceClassificationInput {
        source_type: "invoice_item".into(), source_id: item, treatment: "taxable".into(), note: None,
    })?;
    store.issue_invoice(invoice, Some("2026-04-01".into()), None)?;
    for (date, amount) in [("2026-04-15",33333),("2026-06-15",74767)] {
        store.record_payment(RecordPaymentInput {
            request_id: Uuid::new_v4().to_string(), invoice_id: invoice.into(), amount_cents: amount,
            date: Some(date.into()), method: Some("Banque".into()), reference: None, notes: Some("Recette fictive de ventilation TVA".into()),
        })?;
    }
    let connection = store.connect()?;
    assert!(crate::accounting::cash_vat_invoice_is_consistent(&connection, invoice)?);
    let allocations: Vec<i64> = {
        let mut statement = connection.prepare("SELECT l.debit_cents FROM payments p JOIN journal_entries j ON j.source_type='vat_cash_reclassification' AND j.source_id=p.id JOIN journal_lines l ON l.journal_entry_id=j.id AND l.memo='Reclassement TVA à régulariser' WHERE p.invoice_id=? ORDER BY p.date,p.created_at,p.id")?;
        let rows = statement.query_map([invoice], |r| r.get(0))?;
        rows.collect::<Result<_,_>>()?
    };
    assert_eq!(allocations, vec![2498,5602]);
    println!("QA_CASH_VAT_FIXTURE invoice=108100 vat=8100 payments=33333,74767 allocations=2498,5602 native_consistent=true");
    Ok(())
}

fn seed_credit_history(store: &LocalStore, customer: &str) -> AppResult<()> {
    use crate::customer_credit_settlements::{CustomerCreditSettlementInput, ReverseCustomerCreditSettlementInput};
    use crate::models::{RecordPaymentInput, SaveDocumentWithItemsInput};
    let document = |original: Option<&str>, net: i64, date: &str| -> AppResult<String> {
        let saved = store.save_document_with_items(SaveDocumentWithItemsInput {
            entity: "invoices".into(), id: None,
            data: json!({"client_id":customer,"title":"Dossier fictif avoir et remboursement", "type":if original.is_some() {"credit_note"} else {"standard"},
                "original_invoice_id":original,"service_date_from":"2026-07-01","service_date_to":"2026-07-01","currency":"CHF"}),
            items: vec![json!({"description":"Prestation fictive du dossier d’avoir","quantity":1,"unit":"pièce","unit_price_cents":net,"discount_bp":0,"vat_bp":810})],
        })?;
        let id = saved["document"]["id"].as_str().ok_or_else(|| invalid("QA credit document missing"))?.to_owned();
        let item: String = store.connect()?.query_row("SELECT id FROM invoice_items WHERE invoice_id=?", [&id], |r| r.get(0))?;
        store.set_vat_source_classification(crate::vat_reporting::VatSourceClassificationInput {
            source_type: "invoice_item".into(), source_id: item, treatment: "taxable".into(), note: None,
        })?;
        store.issue_invoice(&id, Some(date.into()), None)?;
        Ok(id)
    };
    let invoice = document(None, 100000, "2026-07-01")?;
    store.record_payment(RecordPaymentInput {
        request_id: Uuid::new_v4().to_string(), invoice_id: invoice.clone(), amount_cents:33333,
        date: Some("2026-07-05".into()), method:Some("Banque".into()), reference:None, notes:Some("Recette fictive avant avoir".into()),
    })?;
    let credit = document(Some(&invoice), 50000, "2026-07-10")?;
    let original: String = store.connect()?.query_row("SELECT id FROM customer_credit_settlements WHERE credit_note_id=?", [&credit], |r| r.get(0))?;
    store.reverse_customer_credit_settlement(ReverseCustomerCreditSettlementInput {
        request_id:Uuid::new_v4().to_string(), settlement_id:original, date:"2026-07-11".into(), reason:"Recette fictive d’annulation de l’imputation".into(),
    })?;
    let bank: String = store.connect()?.query_row("SELECT bank_account_id FROM accounting_settings WHERE id=1", [], |r| r.get(0))?;
    let refund = CustomerCreditSettlementInput {
        request_id:Uuid::new_v4().to_string(), credit_note_id:credit.clone(), event_type:"refund".into(), invoice_id:None,
        date:"2026-07-12".into(), amount_cents:20000, bank_account_id:Some(bank), reference:"QA-REMBOURSEMENT".into(), reason:"Remboursement fictif partiel après annulation".into(),
    };
    let first = store.record_customer_credit_settlement(refund.clone())?;
    let replay = store.record_customer_credit_settlement(refund)?;
    assert_eq!(first["settlement"]["id"], replay["settlement"]["id"]);
    assert_eq!(replay["idempotent"], true);
    store.record_customer_credit_settlement(CustomerCreditSettlementInput {
        request_id:Uuid::new_v4().to_string(), credit_note_id:credit.clone(), event_type:"apply".into(), invoice_id:Some(invoice.clone()),
        date:"2026-07-13".into(), amount_cents:34050, bank_account_id:None, reference:"QA-REIMPUTATION".into(), reason:"Réimputation fictive du solde de l’avoir".into(),
    })?;
    let connection = store.connect()?;
    let events = crate::database::query_all(&connection,"SELECT id FROM customer_credit_settlements WHERE credit_note_id=?",[&credit])?;
    assert_eq!(events.len(),4);
    for event in events {
        assert!(crate::customer_credit_settlements::journal_proof_valid(&connection,event["id"].as_str().unwrap())?);
    }
    assert_eq!(crate::customer_credit_math::project(&connection,&credit,"9999-12-31")?.remaining()?,0);
    assert_eq!(crate::customer_credit_math::project(&connection,&invoice,"9999-12-31")?.remaining()?,40717);
    assert!(crate::accounting::cash_vat_invoice_is_consistent(&connection,&invoice)?);
    println!("QA_CREDIT_FIXTURE events=4 apply=54050 reverse=54050 refund=20000 reapply=34050 remaining=40717 proofs_valid=true replayed=true");
    Ok(())
}

async fn request(
    session: &ProjectSyncSession,
    remote: &RemoteStatus,
    method: Method,
) -> AppResult<Value> {
    let body = (method == Method::POST)
        .then(|| serde_json::to_vec(&json!({"transfer_id":remote.transfer_id})))
        .transpose()?;
    let (status, bytes) = ProjectSyncSession::request(
        session,
        method,
        "/api/sync/bootstrap/integrity",
        &[("transfer_id", remote.transfer_id.as_str())],
        &[("content-type", "application/json".into())],
        body,
        false,
    )
    .await?;
    if !status.is_success() {
        return Err(invalid("Live accounting/audit verification was rejected."));
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    assert_eq!(value["transfer_id"], remote.transfer_id);
    assert_eq!(value["manifest_sha256"], remote.manifest_sha256);
    assert_eq!(value["generation"], remote.generation);
    assert_eq!(value["replication_active"], false);
    assert_eq!(
        value["failed_rule"],
        Value::Null,
        "Rejected integrity rule: {}",
        value["failed_rule"]
    );
    Ok(value)
}

pub(super) async fn run(
    session: &ProjectSyncSession,
    remote: &RemoteStatus,
    native: &Value,
) -> AppResult<()> {
    let mut current = request(session, remote, Method::GET).await?;
    assert_eq!(current["state"], "pending");
    assert_eq!(current["total_audit_entries"], native["entries"]);
    assert!(native["entries"].as_u64().is_some_and(|count| count > 1000));
    let accounting_rules = current["total_accounting_rules"].as_u64().expect("Accounting rule count");
    assert!(accounting_rules > 4);
    let mut calls = 0;
    let mut walked_partial = false;
    let mut accounting_partial = false;
    let mut projection_partial = false;
    for _ in 0..200 {
        current = request(session, remote, Method::POST).await?;
        calls += 1;
        let checked = current["checked_accounting_rules"].as_u64().expect("Accounting cursor");
        assert!(checked <= accounting_rules);
        if current["state"] == "accounting" && checked > 0 && checked < accounting_rules {
            accounting_partial = true;
        }
        if calls == 2 {
            assert_eq!(request(session, remote, Method::GET).await?, current);
        }
        if current["state"] == "projecting" && current["credit_projection"]["phase"] == "verify" && !projection_partial {
            projection_partial = true;
            assert_eq!(request(session, remote, Method::GET).await?, current);
        }
        if current["state"] == "walking" && current["verified_audit_entries"] == 1000 {
            walked_partial = true;
            assert_eq!(request(session, remote, Method::GET).await?, current);
        }
        if calls % 4 == 0 {
            println!(
                "QA_INTEGRITY_PROGRESS indexed={} verified={} total={}",
                current["indexed_audit_entries"],
                current["verified_audit_entries"],
                current["total_audit_entries"]
            );
        }
        if current["state"] == "valid" {
            break;
        }
    }
    assert!(walked_partial);
    assert!(accounting_partial);
    assert!(projection_partial);
    assert_eq!(current["state"], "valid");
    assert_eq!(current["checked_accounting_rules"], accounting_rules);
    assert_eq!(current["verified_audit_entries"], native["entries"]);
    assert_eq!(current["last_audit_hash"], native["last_hash"]);
    assert_eq!(current["credit_projection"]["phase"], "valid");
    assert_eq!(current["credit_projection"]["verified_documents"], 2);
    assert_eq!(current["credit_projection"]["verified_movements"], 8);
    assert_eq!(request(session, remote, Method::POST).await?, current);
    println!("QA_INTEGRITY_COMPLETE transfer={} entries={} requests={} native_hash_match=true cursor_recovered=true replay_stable=true replication_active=false validator={}",remote.transfer_id,native["entries"],calls,current["validator_sha256"]);
    println!("QA_FINANCIAL_COMPLETE rules={accounting_rules} accounting_cursor_recovered=true replication_active=false");
    println!("QA_CREDIT_PROJECTION_COMPLETE documents=2 movements=8 cursor_recovered=true exact_line_vat=true replication_active=false");
    Ok(())
}

#[test]
fn native_integrity_fixture_contains_real_postings_and_a_long_valid_chain() {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    seed(&store).unwrap();
    store.connect().unwrap().execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('qa-native-bootstrap-0000','Client projet fictif','2026-09-08','2026-09-08')",[]).unwrap();
    super::files::seed_live_qa_files(&store).unwrap();
    let prepared = store
        .prepare_business_snapshot("org_first", "owner")
        .unwrap();
    assert_eq!(prepared.manifest.tables.get("invoices"), Some(&4));
    assert_eq!(prepared.manifest.tables.get("payments"), Some(&4));
    assert_eq!(prepared.manifest.tables.get("customer_credit_settlements"), Some(&4));
    assert_eq!(prepared.manifest.tables.get("customer_credit_settlement_postings"), Some(&4));
    assert_eq!(prepared.manifest.tables.get("journal_lines"), Some(&53));
    assert_eq!(prepared.files.len(), 5);
    let connection = store.connect().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM journal_entries", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        18
    );
    assert_eq!(
        connection
            .query_row("SELECT SUM(debit_cents) FROM journal_lines", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        767232
    );
    assert_eq!(
        connection
            .query_row("SELECT SUM(credit_cents) FROM journal_lines", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        767232
    );
    assert!(
        crate::audit::verify_audit_chain(&connection).unwrap()["entries"]
            .as_u64()
            .unwrap()
            > 1000
    );
    if let Ok(folder) = std::env::var("ZENTRA_CREDIT_QA_OUTPUT").or_else(|_| std::env::var("ZENTRA_CASH_VAT_QA_OUTPUT")) {
        let output = PathBuf::from(folder);
        assert!(output.is_absolute());
        let source = store.snapshot_folder(&prepared.transfer_id).unwrap();
        fs::create_dir(&output).unwrap();
        fs::create_dir(output.join("rows")).unwrap();
        write_new(&output.join("prepared.json"), &serde_json::to_vec(&prepared).unwrap()).unwrap();
        for index in 0..prepared.manifest.chunks.len() {
            let name = format!("{index:04}.json");
            write_new(&output.join("rows").join(&name), &fs::read(source.join("rows").join(name)).unwrap()).unwrap();
        }
    }
}
