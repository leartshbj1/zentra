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
    for _ in 0..100 {
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
    assert_eq!(current["state"], "valid");
    assert_eq!(current["checked_accounting_rules"], accounting_rules);
    assert_eq!(current["verified_audit_entries"], native["entries"]);
    assert_eq!(current["last_audit_hash"], native["last_hash"]);
    assert_eq!(request(session, remote, Method::POST).await?, current);
    println!("QA_INTEGRITY_COMPLETE transfer={} entries={} requests={} native_hash_match=true cursor_recovered=true replay_stable=true replication_active=false validator={}",remote.transfer_id,native["entries"],calls,current["validator_sha256"]);
    println!("QA_FINANCIAL_COMPLETE rules={accounting_rules} accounting_cursor_recovered=true replication_active=false");
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
    assert_eq!(prepared.manifest.tables.get("invoices"), Some(&1));
    assert_eq!(prepared.manifest.tables.get("payments"), Some(&1));
    assert_eq!(prepared.files.len(), 5);
    let connection = store.connect().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM journal_entries", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row("SELECT SUM(debit_cents) FROM journal_lines", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        130000
    );
    assert_eq!(
        connection
            .query_row("SELECT SUM(credit_cents) FROM journal_lines", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        130000
    );
    assert!(
        crate::audit::verify_audit_chain(&connection).unwrap()["entries"]
            .as_u64()
            .unwrap()
            > 1000
    );
}
