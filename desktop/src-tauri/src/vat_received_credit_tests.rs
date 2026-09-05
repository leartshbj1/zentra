use super::*;
use crate::models::{
    ApplySupplierCreditInput, RecordSupplierPaymentInput, ReverseSupplierCreditAllocationInput,
    SaveSupplierCreditNoteDraftInput, ValidateSupplierCreditNoteInput,
};

fn setup(rates: &[i64]) -> (tempfile::TempDir, LocalStore, String, String, Vec<String>) {
    let (temp, store, _) = fixture();
    let mut received = profile(false);
    received.form_of_reporting = "received".into();
    received.afc_authorization_confirmed = true;
    store.create_vat_profile(received).unwrap();
    let supplier = store
        .create_record("suppliers", json!({"name":"Compensations TVA SA"}))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let invoice = Uuid::new_v4().to_string();
    let lines: Vec<_> = rates.iter().map(|_| Uuid::new_v4().to_string()).collect();
    store.save_supplier_invoice_draft(serde_json::from_value(json!({"id":invoice,"supplier_id":supplier,"date":"2026-01-15","due_date":"2026-04-30","reference":"FA-COMPENSATION","items":rates.iter().zip(&lines).map(|(rate,id)|json!({"id":id,"description":format!("Marchandises {rate}"),"quantity_milli":1000,"unit_price_cents":10000,"vat_bp":rate,"category":"Marchandises"})).collect::<Vec<_>>()})).unwrap()).unwrap();
    for (index, id) in lines.iter().enumerate() {
        classify(
            &store,
            "supplier_invoice_item",
            id,
            match index {
                1 => "input_investments",
                2 => "non_deductible",
                _ => "input_materials",
            },
        );
    }
    store.validate_supplier_invoice(&invoice).unwrap();
    (temp, store, supplier, invoice, lines)
}

fn credit_document(store: &LocalStore, supplier: &str, rates: &[i64], net: i64) -> String {
    let id = Uuid::new_v4().to_string();
    let lines: Vec<_> = rates.iter().map(|_| Uuid::new_v4().to_string()).collect();
    let draft:SaveSupplierCreditNoteDraftInput=serde_json::from_value(json!({"id":id,"supplier_id":supplier,"document_date":"2026-01-20","reference":format!("AV-{id}"),"items":rates.iter().zip(&lines).map(|(rate,id)|json!({"id":id,"description":format!("Retour {rate}"),"quantity_milli":1000,"unit_price_cents":net,"vat_bp":rate,"category":"Marchandises"})).collect::<Vec<_>>(),"allocations":[]})).unwrap();
    store.save_supplier_credit_note_draft(draft).unwrap();
    for (index, id) in lines.iter().enumerate() {
        classify(
            store,
            "supplier_credit_note_item",
            id,
            match index {
                1 => "input_investments",
                2 => "non_deductible",
                _ => "input_materials",
            },
        );
    }
    store
        .validate_supplier_credit_note(ValidateSupplierCreditNoteInput {
            request_id: Uuid::new_v4().to_string(),
            supplier_credit_note_id: id.clone(),
        })
        .unwrap();
    id
}

fn pay(
    store: &LocalStore,
    invoice: &str,
    date: &str,
    amount: i64,
) -> crate::error::AppResult<serde_json::Value> {
    store.record_supplier_payment(RecordSupplierPaymentInput {
        request_id: Uuid::new_v4().to_string(),
        supplier_invoice_id: invoice.into(),
        amount_cents: amount,
        date: date.into(),
        method: Some("bank".into()),
        reference: None,
        notes: None,
    })
}

fn apply(credit: &str, invoice: &str, date: &str, amount: i64) -> ApplySupplierCreditInput {
    ApplySupplierCreditInput {
        request_id: Uuid::new_v4().to_string(),
        supplier_credit_note_id: credit.into(),
        supplier_invoice_id: invoice.into(),
        amount_cents: amount,
        effective_date: date.into(),
    }
}

#[test]
fn received_credit_compensation_and_reversal_preserve_each_rate_and_prior_period() {
    let (_temp, store, supplier, invoice, _) = setup(&[810, 260, 380]);
    pay(&store, &invoice, "2026-03-31", 15725).unwrap();
    let q1 = period_preview(&store, "2026-01-01", "2026-03-31");
    assert!(q1.exportable, "{:?}", q1.blocking_issues);
    assert_eq!(q1.payable_tax_cents, -535);
    let credit = credit_document(&store, &supplier, &[810, 260, 380], 5000);
    // A credit which has not yet been settled does not reduce received input VAT.
    assert_eq!(
        period_preview(&store, "2026-01-01", "2026-03-31").source_sha256,
        q1.source_sha256
    );
    let applied = store
        .apply_supplier_credit(apply(&credit, &invoice, "2026-04-01", 15725))
        .unwrap();
    let q2 = period_preview(&store, "2026-04-01", "2026-06-30");
    assert!(q2.exportable, "{:?}", q2.blocking_issues);
    assert_eq!(q2.payable_tax_cents, 0);
    assert_eq!(q2.received_allocations.len(), 6);
    for source in ["supplier_invoice_item", "supplier_credit_note_item"] {
        let rows: Vec<_> = q2
            .received_allocations
            .iter()
            .filter(|row| row.source_type == source)
            .collect();
        let sign = if source == "supplier_invoice_item" {
            1
        } else {
            -1
        };
        assert_eq!(
            rows.iter().map(|row| row.payment.gross_cents).sum::<i64>(),
            sign * 15725
        );
        assert_eq!(
            rows.iter().map(|row| row.payment.vat_cents).sum::<i64>(),
            sign * 725
        );
        assert!(rows
            .iter()
            .all(|row| row.payment.settlement.as_ref().unwrap().kind == "credit_application"));
    }
    store
        .reverse_supplier_credit_allocation(ReverseSupplierCreditAllocationInput {
            request_id: Uuid::new_v4().to_string(),
            supplier_credit_allocation_id: applied["allocation"]["id"].as_str().unwrap().into(),
            reason: "Compensation remplacée par paiement".into(),
            effective_date: "2026-07-01".into(),
        })
        .unwrap();
    pay(&store, &invoice, "2026-07-02", 15725).unwrap();
    let q3 = period_preview(&store, "2026-07-01", "2026-09-30");
    assert!(q3.exportable, "{:?}", q3.blocking_issues);
    assert_eq!(q3.payable_tax_cents, -535);
    for original in &q2.received_allocations {
        let reverse = q3
            .received_allocations
            .iter()
            .find(|row| row.source_id == original.source_id && row.payment.settlement.is_some())
            .unwrap();
        assert_eq!(reverse.payment.gross_cents, -original.payment.gross_cents);
        assert_eq!(reverse.payment.vat_cents, -original.payment.vat_cents);
        assert_eq!(
            reverse
                .payment
                .settlement
                .as_ref()
                .unwrap()
                .reverses_allocation_id
                .as_deref(),
            Some(original.payment.payment_id.as_str())
        );
    }
    assert_eq!(
        period_preview(&store, "2026-01-01", "2026-03-31").source_sha256,
        q1.source_sha256
    );
    assert_eq!(
        period_preview(&store, "2026-04-01", "2026-06-30").source_sha256,
        q2.source_sha256
    );
    assert_eq!(store.verify_audit_log().unwrap()["valid"], true);
    for (from, to, name) in [
        ("2026-04-01", "2026-06-30", "compensation"),
        ("2026-07-01", "2026-09-30", "extourne"),
    ] {
        let export = store
            .export_vat_return_xml(crate::vat_reporting::ExportVatReturnInput {
                date_from: from.into(),
                date_to: to.into(),
                submission_type: "initial".into(),
                profile_id: None,
                business_reference_id: format!("QA-{name}"),
                file_name: None,
            })
            .unwrap();
        assert_eq!(
            export
                .payload
                .received_allocations
                .iter()
                .filter(|row| row.payment.settlement.is_some())
                .count(),
            6
        );
        if let Ok(directory) = std::env::var("ZENTRA_QA_RECEIVED_CREDIT_EXPORT_DIR") {
            let directory = std::path::Path::new(&directory);
            std::fs::create_dir_all(directory).unwrap();
            std::fs::copy(&export.file_path, directory.join(format!("{name}.xml"))).unwrap();
            std::fs::write(
                directory.join(format!("{name}.json")),
                serde_json::to_vec_pretty(&export).unwrap(),
            )
            .unwrap();
        }
    }
}

#[test]
fn received_credit_against_a_different_rate_is_not_assumed_tax_neutral() {
    let (_temp, store, supplier, invoice, _) = setup(&[810]);
    let credit = credit_document(&store, &supplier, &[260], 1000);
    store
        .apply_supplier_credit(apply(&credit, &invoice, "2026-03-31", 1026))
        .unwrap();
    let q1 = period_preview(&store, "2026-01-01", "2026-03-31");
    assert!(q1.exportable, "{:?}", q1.blocking_issues);
    assert_eq!(q1.payable_tax_cents, -51);
    pay(&store, &invoice, "2026-04-01", 9784).unwrap();
    let q2 = period_preview(&store, "2026-04-01", "2026-06-30");
    assert!(q2.exportable, "{:?}", q2.blocking_issues);
    assert_eq!(q2.payable_tax_cents, -733);
    assert_eq!(q1.payable_tax_cents + q2.payable_tax_cents, -784);
    let (_temp2, other, supplier2, invoice2, _) = setup(&[260]);
    let higher_credit = credit_document(&other, &supplier2, &[810], 1000);
    other
        .apply_supplier_credit(apply(&higher_credit, &invoice2, "2026-03-31", 1081))
        .unwrap();
    let payable = period_preview(&other, "2026-01-01", "2026-03-31");
    assert!(payable.exportable, "{:?}", payable.blocking_issues);
    assert_eq!(payable.payable_tax_cents, 54);
    assert_eq!(
        payable
            .effective_reporting_method
            .as_ref()
            .unwrap()
            .input_tax_material_and_services_cents,
        -54
    );
    let export = other
        .export_vat_return_xml(crate::vat_reporting::ExportVatReturnInput {
            date_from: "2026-01-01".into(),
            date_to: "2026-03-31".into(),
            submission_type: "initial".into(),
            profile_id: None,
            business_reference_id: "QA-NEGATIVE-INPUT".into(),
            file_name: None,
        })
        .unwrap();
    if let Ok(directory) = std::env::var("ZENTRA_QA_RECEIVED_CREDIT_EXPORT_DIR") {
        let directory = std::path::Path::new(&directory);
        std::fs::create_dir_all(directory).unwrap();
        std::fs::copy(&export.file_path, directory.join("negative-input.xml")).unwrap();
        std::fs::write(
            directory.join("negative-input.json"),
            serde_json::to_vec_pretty(&export).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn received_credit_legacy_unknown_date_still_blocks_without_guessing_or_writing() {
    let (_temp, store, supplier, invoice, _) = setup(&[810]);
    let credit = credit_document(&store, &supplier, &[810], 5000);
    let connection = store.connect().unwrap();
    connection
        .execute_batch("DROP TRIGGER supplier_credit_allocations_date_guard;")
        .unwrap();
    connection.execute("INSERT INTO supplier_credit_allocations(id,request_id,supplier_credit_note_id,supplier_invoice_id,amount_cents,created_at) VALUES(?1,?2,?3,?4,5405,'2026-03-31T10:00:00Z')",params![Uuid::new_v4().to_string(),Uuid::new_v4().to_string(),credit,invoice]).unwrap();
    let before = journal_count(&store);
    let preview = period_preview(&store, "2026-01-01", "2026-03-31");
    assert!(!preview.exportable);
    assert!(preview
        .blocking_issues
        .iter()
        .any(|issue| issue.code == "unsupported_supplier_credit_tax"));
    assert!(preview.received_allocations.is_empty());
    assert_eq!(journal_count(&store), before);
}

#[test]
fn received_credit_backdated_payment_cannot_overlap_a_compensation_reversed_later() {
    let (_temp, store, supplier, invoice, _) = setup(&[810]);
    let credit = credit_document(&store, &supplier, &[810], 10000);
    let applied = store
        .apply_supplier_credit(apply(&credit, &invoice, "2026-04-01", 10810))
        .unwrap();
    store
        .reverse_supplier_credit_allocation(ReverseSupplierCreditAllocationInput {
            request_id: Uuid::new_v4().to_string(),
            supplier_credit_allocation_id: applied["allocation"]["id"].as_str().unwrap().into(),
            reason: "Annulation compensation".into(),
            effective_date: "2026-07-01".into(),
        })
        .unwrap();
    let before = journal_count(&store);
    assert!(store
        .apply_supplier_credit(apply(&credit, &invoice, "2026-03-31", 10810))
        .unwrap_err()
        .to_string()
        .contains("chronologie"));
    let invalid_draft_id = Uuid::new_v4().to_string();
    store.save_supplier_credit_note_draft(serde_json::from_value(json!({"id":invalid_draft_id,"supplier_id":supplier,"document_date":"2026-01-20","reference":"AV-CHRONO-DRAFT","items":[{"description":"Correction","quantity_milli":1000,"unit_price_cents":10000,"vat_bp":810,"category":"Marchandises"}],"allocations":[{"supplier_invoice_id":invoice,"amount_cents":10810,"effective_date":"2026-03-31"}]})).unwrap()).unwrap();
    assert!(store
        .validate_supplier_credit_note(ValidateSupplierCreditNoteInput {
            request_id: Uuid::new_v4().to_string(),
            supplier_credit_note_id: invalid_draft_id.clone()
        })
        .unwrap_err()
        .to_string()
        .contains("chronologie"));
    let draft_state: (String, Option<String>) = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT status,number FROM supplier_credit_notes WHERE id=?1",
            params![invalid_draft_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(draft_state, ("draft".into(), None));
    assert!(pay(&store, &invoice, "2026-03-31", 10810)
        .unwrap_err()
        .to_string()
        .contains("chronologie"));
    assert_eq!(journal_count(&store), before);
    assert_eq!(
        store.get_workspace().unwrap()["supplier_invoices"][0]["paid_cents"],
        0
    );
    pay(&store, &invoice, "2026-07-01", 10810).unwrap();
    assert!(period_preview(&store, "2026-07-01", "2026-09-30").exportable);
}
