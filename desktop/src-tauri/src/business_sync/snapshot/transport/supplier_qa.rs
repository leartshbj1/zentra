//! Fictitious native purchase lifecycle, including dated credit and bank reversals.
use super::*;

pub(super) fn enabled() -> bool {
    std::env::var("ZENTRA_SUPPLIER_QA_MODE").is_ok_and(|value| value == "1")
}

fn classify(
    store: &LocalStore,
    table: &str,
    parent: &str,
    id: &str,
    source: &str,
) -> AppResult<()> {
    for line in crate::database::query_all(
        &store.connect()?,
        &format!("SELECT id FROM {table} WHERE {parent}=?"),
        [id],
    )? {
        store.set_vat_source_classification(
            crate::vat_reporting::VatSourceClassificationInput {
                source_type: source.into(),
                source_id: line["id"].as_str().unwrap().into(),
                treatment: "input_materials".into(),
                note: None,
            },
        )?;
    }
    Ok(())
}
fn pay(store: &LocalStore, invoice: &str, amount: i64, date: &str) -> AppResult<()> {
    let input = crate::models::RecordSupplierPaymentInput {
        request_id: Uuid::new_v4().to_string(),
        supplier_invoice_id: invoice.into(),
        amount_cents: amount,
        date: date.into(),
        method: Some("Banque".into()),
        reference: Some("FACTURE-FOURNISSEUR-FICTIVE".into()),
        notes: None,
    };
    store.record_supplier_payment(input.clone())?;
    assert_eq!(store.record_supplier_payment(input)?["idempotent"], true);
    Ok(())
}
pub(super) fn seed(store: &LocalStore) -> AppResult<()> {
    let supplier = store.create_record(
        "suppliers",
        json!({"name":"Fournisseur fictif de recette TVA"}),
    )?["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let invoice = Uuid::new_v4().to_string();
    let items = |price| {
        vec![
            json!({"description":"Marchandises au taux normal","quantity_milli":1000,"unit_price_cents":price,"vat_bp":810,"category":"Marchandises"}),
            json!({"description":"Marchandises au taux réduit","quantity_milli":1000,"unit_price_cents":price,"vat_bp":260,"category":"Marchandises"}),
        ]
    };
    store.save_supplier_invoice_draft(serde_json::from_value(json!({"id":invoice,"supplier_id":supplier,"date":"2026-08-01","due_date":"2026-08-31","reference":"FOURNISSEUR-FICTIF","items":items(5000)}))?)?;
    classify(
        store,
        "supplier_invoice_items",
        "supplier_invoice_id",
        &invoice,
        "supplier_invoice_item",
    )?;
    store.validate_supplier_invoice(&invoice)?;
    pay(store, &invoice, 2000, "2026-08-02")?;
    let credit = Uuid::new_v4().to_string();
    store.save_supplier_credit_note_draft(serde_json::from_value(json!({"id":credit,"supplier_id":supplier,"document_date":"2026-08-03","reference":"AVOIR-FOURNISSEUR-FICTIF","items":items(2500),
        "allocations":[{"supplier_invoice_id":invoice,"amount_cents":1000,"effective_date":"2026-08-04"}]}))?)?;
    classify(
        store,
        "supplier_credit_note_items",
        "supplier_credit_note_id",
        &credit,
        "supplier_credit_note_item",
    )?;
    let validate = crate::models::ValidateSupplierCreditNoteInput {
        request_id: Uuid::new_v4().to_string(),
        supplier_credit_note_id: credit.clone(),
    };
    store.validate_supplier_credit_note(validate.clone())?;
    assert_eq!(
        store.validate_supplier_credit_note(validate)?["idempotent"],
        true
    );
    let apply = crate::models::ApplySupplierCreditInput {
        request_id: Uuid::new_v4().to_string(),
        supplier_credit_note_id: credit.clone(),
        supplier_invoice_id: invoice.clone(),
        amount_cents: 1000,
        effective_date: "2026-08-05".into(),
    };
    let allocation = store.apply_supplier_credit(apply.clone())?["allocation"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(store.apply_supplier_credit(apply)?["idempotent"], true);
    pay(store, &invoice, 1, "2026-08-06")?;
    store.reverse_supplier_credit_allocation(
        crate::models::ReverseSupplierCreditAllocationInput {
            request_id: Uuid::new_v4().to_string(),
            supplier_credit_allocation_id: allocation,
            reason: "Correction fictive après paiement intercalaire".into(),
            effective_date: "2026-08-07".into(),
        },
    )?;
    let refund = |amount, date: &str| crate::supplier_credit_refunds::SupplierCreditRefundInput {
        request_id: Uuid::new_v4().to_string(),
        supplier_credit_note_id: credit.clone(),
        amount_cents: amount,
        date: date.into(),
        reference: "RETOUR-FOURNISSEUR-FICTIF".into(),
        reason: "Remboursement fictif de marchandises".into(),
    };
    let refund_input = refund(1000, "2026-08-08");
    let refunded = store.record_supplier_credit_refund(refund_input.clone())?["refund"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        store.record_supplier_credit_refund(refund_input)?["idempotent"],
        true
    );
    store.reverse_supplier_credit_refund(
        crate::supplier_credit_refunds::ReverseSupplierCreditRefundInput {
            request_id: Uuid::new_v4().to_string(),
            refund_id: refunded,
            date: "2026-08-09".into(),
            reason: "Annulation fictive du virement fournisseur".into(),
        },
    )?;
    store.record_supplier_credit_refund(refund(4268, "2026-08-10"))?;
    pay(store, &invoice, 7534, "2026-08-11")?;
    let connection = store.connect()?;
    crate::vat_reporting::validate_supplier_settlement_chronology(&connection, false, &invoice)?;
    crate::vat_reporting::validate_supplier_settlement_chronology(&connection, true, &credit)?;
    assert_eq!(
        connection.query_row(
            "SELECT total_cents-paid_cents-credited_cents FROM supplier_invoices WHERE id=?",
            [&invoice],
            |r| r.get::<_, i64>(0)
        )?,
        0
    );
    assert_eq!(
        connection.query_row(
            "SELECT remaining_cents FROM supplier_credit_balances WHERE supplier_credit_note_id=?",
            [&credit],
            |r| r.get::<_, i64>(0)
        )?,
        0
    );
    let allocations = expected_vat(store)?;
    assert_eq!(
        allocations.iter().map(|a| a.payment.vat_cents).sum::<i64>(),
        267
    );
    println!("QA_SUPPLIER_FIXTURE invoice=10535 credit=5268 paid=9535 allocated=1000 refunded=4268 invoice_remaining=0 credit_remaining=0 input_vat=267 replayed=true");
    Ok(())
}
fn expected_vat(store: &LocalStore) -> AppResult<Vec<crate::vat_reporting::VatReceivedAllocation>> {
    Ok(store
        .preview_vat_return(crate::vat_reporting::VatReturnPreviewInput {
            date_from: "2026-07-01".into(),
            date_to: "2026-09-30".into(),
            submission_type: "initial".into(),
            profile_id: None,
        })?
        .received_allocations
        .into_iter()
        .filter(|a| a.source_type.starts_with("supplier_"))
        .collect())
}

#[test]
fn native_supplier_fixture_preserves_mixed_vat_and_both_reversal_kinds() {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    super::integrity_qa::seed_with_scenarios(&store, true, true).unwrap();
    store.connect().unwrap().execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('qa-native-bootstrap-0000','Client projet fictif','2026-09-08','2026-09-08')",[]).unwrap();
    super::files::seed_live_qa_files(&store).unwrap();
    let prepared = store
        .prepare_business_snapshot("org_first", "owner")
        .unwrap();
    assert_eq!(prepared.manifest.tables.get("supplier_invoices"), Some(&1));
    assert_eq!(
        prepared.manifest.tables.get("supplier_credit_notes"),
        Some(&1)
    );
    assert_eq!(
        prepared.manifest.tables.get("supplier_credit_allocations"),
        Some(&3)
    );
    assert_eq!(
        prepared.manifest.tables.get("supplier_credit_refunds"),
        Some(&3)
    );
    assert_eq!(prepared.manifest.tables.get("supplier_payments"), Some(&3));
    if let Ok(folder) = std::env::var("ZENTRA_SUPPLIER_QA_OUTPUT") {
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
        write_new(
            &output.join("expected-supplier-vat.json"),
            &serde_json::to_vec(&expected_vat(&store).unwrap()).unwrap(),
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
