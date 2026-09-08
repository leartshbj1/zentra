//! Real old-version adoption, never a production mutation or source of customer data.
use super::*;
use crate::{
    customer_credit_recovery::{RecoveryCredit, RecoveryInput},
    customer_credit_settlements::CustomerCreditSettlementInput,
    models::{RecordPaymentInput, SaveDocumentWithItemsInput},
};

pub(super) fn enabled() -> bool {
    std::env::var("ZENTRA_RECOVERY_QA_MODE").is_ok_and(|value| value == "1")
}

fn document(
    store: &LocalStore,
    customer: &str,
    original: Option<&str>,
    values: &[(i64, i64)],
    date: &str,
) -> AppResult<String> {
    let saved = store.save_document_with_items(SaveDocumentWithItemsInput {
        entity: "invoices".into(), id: None,
        data: json!({"client_id":customer,"title":"Ancien dossier fictif de reprise TVA","type":if original.is_some() {"credit_note"} else {"standard"},
            "original_invoice_id":original,"service_date_from":"2026-08-01","service_date_to":"2026-08-01","currency":"CHF"}),
        items: values.iter().map(|(net, rate)| json!({"description":"Ligne fictive de reprise","quantity":1,"unit":"pièce","unit_price_cents":net,"discount_bp":0,"vat_bp":rate})).collect(),
    })?;
    let id = saved["document"]["id"]
        .as_str()
        .ok_or_else(|| invalid("Recovery document missing"))?
        .to_owned();
    for item in crate::database::query_all(
        &store.connect()?,
        "SELECT id FROM invoice_items WHERE invoice_id=?",
        [&id],
    )? {
        store.set_vat_source_classification(
            crate::vat_reporting::VatSourceClassificationInput {
                source_type: "invoice_item".into(),
                source_id: item["id"].as_str().unwrap().into(),
                treatment: "taxable".into(),
                note: None,
            },
        )?;
    }
    store.issue_invoice(&id, Some(date.into()), None)?;
    Ok(id)
}
fn pay(store: &LocalStore, invoice: &str, amount: i64, date: &str) -> AppResult<()> {
    store.record_payment(RecordPaymentInput {
        request_id: Uuid::new_v4().to_string(),
        invoice_id: invoice.into(),
        amount_cents: amount,
        date: Some(date.into()),
        method: Some("Banque".into()),
        reference: Some("REPRISE-FICTIVE".into()),
        notes: None,
    })?;
    Ok(())
}

pub(super) fn seed(store: &LocalStore, customer: &str) -> AppResult<()> {
    let partial = document(store, customer, None, &[(10000, 810)], "2026-08-01")?;
    let full = document(
        store,
        customer,
        None,
        &[(5000, 810), (5000, 260)],
        "2026-08-01",
    )?;
    pay(store, &full, 10535, "2026-08-10")?;
    store
        .connect()?
        .execute("UPDATE accounting_settings SET enabled=0 WHERE id=1", [])?;
    let partial_credit = document(
        store,
        customer,
        Some(&partial),
        &[(5000, 810)],
        "2026-08-15",
    )?;
    let full_credit = document(
        store,
        customer,
        Some(&full),
        &[(2500, 810), (2500, 260)],
        "2026-08-15",
    )?;
    // Recreate the actual v52 layout, as in the existing migration tests.
    // This runs before the other QA dated credits exist, inside a temp profile.
    let connection = store.connect()?;
    crate::schema::remove_v52_for_legacy_fixture(&connection);
    connection.execute_batch(crate::schema::MIGRATION_V52_SQL)?;
    drop(connection);
    let migrated = LocalStore::initialize(store.data_dir.clone())?;
    let mut settings = migrated.get_accounting_settings()?;
    settings["enabled"] = json!(true);
    migrated.configure_accounting(serde_json::from_value(settings)?)?;
    pay(&migrated, &partial, 3000, "2026-09-01")?;
    for (invoice, credit, applied) in [(&partial, &partial_credit, 2703), (&full, &full_credit, 0)]
    {
        let plan = migrated.get_customer_credit_recovery(invoice)?;
        assert!(plan["blocker"].is_null(), "{plan}");
        let request = RecoveryInput {
            request_id: Uuid::new_v4().to_string(),
            original_invoice_id: invoice.clone(),
            source_token: plan["source_token"].as_str().unwrap().into(),
            reference: "REPRISE-ANCIEN-DOSSIER".into(),
            reason: "Reprise fictive contrôlée, aucun remboursement antérieur".into(),
            no_prior_refund: true,
            confirm_vat_reconciliation: true,
            credits: vec![RecoveryCredit {
                credit_note_id: credit.clone(),
                applied_cents: applied,
                application_date: (applied > 0).then(|| "2026-08-20".into()),
            }],
        };
        migrated.preview_customer_credit_recovery(request.clone())?;
        migrated.adopt_customer_credit_recovery(request.clone())?;
        assert_eq!(
            migrated.adopt_customer_credit_recovery(request)?["idempotent"],
            true
        );
        assert!(crate::customer_credit_recovery_vat::proof_valid(
            &migrated.connect()?,
            invoice
        )?);
    }
    let bank: String = migrated.connect()?.query_row(
        "SELECT bank_account_id FROM accounting_settings WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    for (amount, date) in [(1000, "2026-09-03"), (4268, "2026-09-05")] {
        migrated.record_customer_credit_settlement(CustomerCreditSettlementInput {
            request_id: Uuid::new_v4().to_string(),
            credit_note_id: full_credit.clone(),
            event_type: "refund".into(),
            invoice_id: None,
            date: date.into(),
            amount_cents: amount,
            bank_account_id: Some(bank.clone()),
            reference: "REMBOURSEMENT-REPRISE".into(),
            reason: "Remboursement fictif après la reprise des écritures".into(),
        })?;
    }
    let c = migrated.connect()?;
    assert_eq!(
        crate::customer_credit_math::project(&c, &partial, "9999-12-31")?.remaining()?,
        5107
    );
    assert_eq!(
        crate::customer_credit_math::project(&c, &full_credit, "9999-12-31")?.remaining()?,
        0
    );
    assert_eq!(c.query_row("SELECT due_change_cents FROM customer_credit_recovery_postings WHERE original_invoice_id=? AND source_type='payment'",[&partial],|r|r.get::<_,i64>(0))?,-1);
    assert_eq!(c.query_row("SELECT due_change_cents FROM customer_credit_recovery_postings WHERE original_invoice_id=? AND source_type='credit'",[&full],|r|r.get::<_,i64>(0))?,268);
    assert!(c.query_row("SELECT journal_entry_id IS NULL FROM customer_credit_recovery_postings WHERE original_invoice_id=? AND source_type='payment'",[&full],|r|r.get::<_,bool>(0))?);
    for invoice in [&partial, &full] {
        assert!(crate::customer_credit_recovery_vat::proof_valid(
            &c, invoice
        )?);
        assert!(crate::accounting::cash_vat_invoice_is_consistent(
            &c, invoice
        )?);
    }
    println!("QA_RECOVERY_FIXTURE models=2 proofs=4 partial_correction=-1 restored_vat=268 null_correction=true mixed_rates=true replayed=true proofs_valid=true");
    Ok(())
}

#[test]
fn native_recovery_fixture_preserves_old_sources_and_exact_corrections() {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    super::integrity_qa::seed_with_recovery(&store, true).unwrap();
    store.connect().unwrap().execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('qa-native-bootstrap-0000','Client projet fictif','2026-09-08','2026-09-08')",[]).unwrap();
    super::files::seed_live_qa_files(&store).unwrap();
    let prepared = store
        .prepare_business_snapshot("org_first", "owner")
        .unwrap();
    assert_eq!(prepared.manifest.tables.get("invoices"), Some(&8));
    assert_eq!(prepared.manifest.tables.get("payments"), Some(&6));
    assert_eq!(
        prepared
            .manifest
            .tables
            .get("customer_credit_recovery_postings"),
        Some(&4)
    );
    assert_eq!(prepared.files.len(), 5);
    let c = store.connect().unwrap();
    let sums: (i64, i64) = c
        .query_row(
            "SELECT SUM(debit_cents),SUM(credit_cents) FROM journal_lines",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(sums.0, sums.1);
    assert!(
        crate::audit::verify_audit_chain(&c).unwrap()["entries"]
            .as_u64()
            .unwrap()
            > 1000
    );
    println!(
        "QA_RECOVERY_COUNTS journals={} lines={} debit={} credit={}",
        prepared.manifest.tables["journal_entries"],
        prepared.manifest.tables["journal_lines"],
        sums.0,
        sums.1
    );
    if let Ok(folder) = std::env::var("ZENTRA_RECOVERY_QA_OUTPUT") {
        let output = PathBuf::from(folder);
        assert!(output.is_absolute());
        let source = store.snapshot_folder(&prepared.transfer_id).unwrap();
        fs::create_dir(&output).unwrap();
        fs::create_dir(output.join("rows")).unwrap();
        write_new(
            &output.join("prepared.json"),
            &serde_json::to_vec(&prepared).unwrap(),
        )
        .unwrap();
        for index in 0..prepared.manifest.chunks.len() {
            let name = format!("{index:04}.json");
            write_new(
                &output.join("rows").join(&name),
                &fs::read(source.join("rows").join(name)).unwrap(),
            )
            .unwrap();
        }
    }
}
