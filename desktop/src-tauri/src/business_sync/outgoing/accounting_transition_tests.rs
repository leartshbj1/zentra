//! Real local accounting operations exported with their original capture order.
use super::*;

pub(super) fn source_rows(store: &LocalStore) -> Vec<Value> {
    let c = store.connect().unwrap();
    let mut source = Vec::new();
    for (table, rule) in super::super::super::policy().unwrap().tables {
        let sql = format!(
            "SELECT {},{},CAST(rowid AS TEXT) FROM {} r ORDER BY rowid",
            super::super::super::json_key("r", &rule.key).unwrap(),
            super::super::super::json_image("r", &rule.columns).unwrap(),
            super::super::super::identifier(&table).unwrap()
        );
        let mut query = c.prepare(&sql).unwrap();
        for row in query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .unwrap()
        {
            let (key, image, rowid) = row.unwrap();
            source
                .push(json!({"table":table,"key_json":key,"row_json":image,"source_rowid":rowid}));
        }
    }
    source
}
fn supplier_invoice(store: &LocalStore) -> String {
    let supplier = store
        .create_record("suppliers", json!({"name":"Fournisseur fictif"}))
        .unwrap();
    let id = Uuid::new_v4().to_string();
    store.save_supplier_invoice_draft(serde_json::from_value(json!({"id":id,"supplier_id":supplier["id"],"date":"2026-09-01","due_date":"2026-09-30","reference":"RECETTE-ACHAT","items":[{"description":"Marchandises","quantity_milli":1000,"unit_price_cents":10000,"vat_bp":0,"category":"Marchandises"}]})).unwrap()).unwrap();
    id
}
fn expense_refund_input(
    id: &str,
    reverses_id: Option<String>,
) -> crate::expense_refunds::ExpenseRefundInput {
    serde_json::from_value(json!({"request_id":Uuid::new_v4().to_string(),"expense_id":id,"credit_date":"2026-09-08","payment_date":"2026-09-08","reference":"RECETTE-RETOUR","reason":"Retour de marchandises fictif","net_cents":3000,"vat_cents":0,"reverses_id":reverses_id})).unwrap()
}
fn supplier_refund_input(id: &str) -> crate::supplier_credit_refunds::SupplierCreditRefundInput {
    serde_json::from_value(json!({"request_id":Uuid::new_v4().to_string(),"supplier_credit_note_id":id,"date":"2026-09-08","amount_cents":1000,"reference":"RECETTE-RETOUR","reason":"Retour de marchandises fictif"})).unwrap()
}
#[test]
fn native_accounting_transitions_preserve_posting_payment_and_credit_order() {
    let output = std::env::var("ZENTRA_ACCOUNTING_TRANSITION_OUTPUT")
        .ok()
        .map(PathBuf::from);
    if let Some(folder) = &output {
        fs::create_dir(folder).unwrap();
    }
    for scenario in [
        "expense",
        "payroll",
        "payroll-post",
        "payroll-adult-post",
        "payroll-adult-validate",
        "supplier-validate",
        "supplier-payment",
        "supplier-credit",
        "expense-refund",
        "expense-refund-reversal",
        "supplier-refund",
        "supplier-refund-reversal",
    ] {
        let (_directory, store) = setup();
        store.install_swiss_accounting_starter().unwrap();
        let mut id = String::new();
        let mut pending_payroll = None;
        let mut refund_id = None;
        if scenario.starts_with("supplier-") {
            id = supplier_invoice(&store);
            if scenario != "supplier-validate" {
                store.validate_supplier_invoice(&id).unwrap();
            }
            if scenario == "supplier-credit" || scenario.starts_with("supplier-refund") {
                let supplier: String = store
                    .connect()
                    .unwrap()
                    .query_row(
                        "SELECT supplier_id FROM supplier_invoices WHERE id=?",
                        [&id],
                        |r| r.get(0),
                    )
                    .unwrap();
                let credit = Uuid::new_v4().to_string();
                store.save_supplier_credit_note_draft(serde_json::from_value(json!({"id":credit,"supplier_id":supplier,"document_date":"2026-09-02","reference":"RECETTE-AVOIR","items":[{"description":"Retour","quantity_milli":1000,"unit_price_cents":3000,"vat_bp":0,"category":"Marchandises"}],"allocations":[{"supplier_invoice_id":id,"amount_cents":2000,"effective_date":"2026-09-03"}]})).unwrap()).unwrap();
                id = credit;
                if scenario.starts_with("supplier-refund") {
                    store
                        .validate_supplier_credit_note(
                            crate::models::ValidateSupplierCreditNoteInput {
                                request_id: Uuid::new_v4().to_string(),
                                supplier_credit_note_id: id.clone(),
                            },
                        )
                        .unwrap();
                    if scenario == "supplier-refund-reversal" {
                        let result = store
                            .record_supplier_credit_refund(supplier_refund_input(&id))
                            .unwrap();
                        refund_id = Some(result["refund"]["id"].as_str().unwrap().to_string());
                    }
                }
            }
        } else if scenario.starts_with("expense-refund") {
            let expense = store.create_record("expenses",json!({"date":"2026-09-08","paid_at":"2026-09-08","payment_status":"paid","supplier":"Fournisseur fictif","reference":"RECETTE-DEPENSE","net_cents":10000,"vat_cents":0})).unwrap();
            id = expense["id"].as_str().unwrap().to_string();
            if scenario == "expense-refund-reversal" {
                let result = store
                    .record_expense_refund(expense_refund_input(&id, None))
                    .unwrap();
                refund_id = Some(result["refund"]["id"].as_str().unwrap().to_string());
            }
        } else if scenario.starts_with("payroll") {
            let employee = store
                .create_record("employees", json!({"name":"Employé fictif"}))
                .unwrap();
            let employee_id = employee["id"].as_str().unwrap().to_string();
            let adult = scenario.starts_with("payroll-adult-");
            let contributions = if adult {
                crate::tests::configure_adult_test_payroll(&store, &employee_id)
            } else {
                vec![crate::tests::configure_minor_test_payroll(
                    &store,
                    &employee_id,
                    50000,
                )]
            };
            let input = json!({"id":null,"employee_id":employee_id,"period":"2026-08","status":"valide","payment_date":null,"notes":null,"lines":[{"id":null,"label":"Salaire fictif","kind":"earning","amount_cents":if adult {500000} else {50000},"posting_account_id":null,"expense_account_id":null}],"contributions":contributions});
            if scenario == "payroll-adult-validate" {
                pending_payroll = Some(input);
            } else {
                let saved = store
                    .save_payslip_with_contributions(serde_json::from_value(input).unwrap())
                    .unwrap();
                id = saved["payslip"]["id"].as_str().unwrap().into();
            }
            if scenario == "payroll" {
                store
                    .post_payslip(crate::models::PostPayslipInput {
                        payslip_id: id.clone(),
                        entry_date: Some("2026-08-31".into()),
                    })
                    .unwrap();
            }
        }
        let source = source_rows(&store);
        if scenario == "expense" {
            if let Some(folder) = &output {
                let c = store.connect().unwrap();
                let mut q=c.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name").unwrap();
                let triggers: Vec<String> = q
                    .query_map([], |r| r.get(0))
                    .unwrap()
                    .map(Result::unwrap)
                    .collect();
                fs::write(
                    folder.join("native-triggers.json"),
                    serde_json::to_vec(&triggers).unwrap(),
                )
                .unwrap();
                assert_eq!(
                    c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    crate::schema::SCHEMA_VERSION
                );
            }
        }
        bind(&store);
        let (_receiver_directory, receiver) =
            crate::business_sync::replay::tests::copy_receiver(&store);
        match scenario {
            "expense" => {
                store.create_record("expenses",json!({"date":"2026-09-08","paid_at":"2026-09-08","payment_status":"paid","supplier":"Fournisseur fictif","reference":"RECETTE-DEPENSE","net_cents":10000,"vat_cents":0})).unwrap();
            }
            "payroll" => {
                store
                    .pay_payslip(crate::models::PayPayslipInput {
                        payslip_id: id,
                        payment_date: Some("2026-09-08".into()),
                        reference: Some("RECETTE-SALAIRE".into()),
                        regulatory_override_reason: None,
                    })
                    .unwrap();
            }
            "payroll-adult-validate" => {
                store
                    .save_payslip_with_contributions(
                        serde_json::from_value(pending_payroll.unwrap()).unwrap(),
                    )
                    .unwrap();
            }
            "payroll-post" | "payroll-adult-post" => {
                store
                    .post_payslip(crate::models::PostPayslipInput {
                        payslip_id: id,
                        entry_date: Some("2026-08-31".into()),
                    })
                    .unwrap();
            }
            "supplier-validate" => {
                store.validate_supplier_invoice(&id).unwrap();
            }
            "supplier-payment" => {
                store
                    .record_supplier_payment(crate::models::RecordSupplierPaymentInput {
                        request_id: Uuid::new_v4().to_string(),
                        supplier_invoice_id: id,
                        amount_cents: 3000,
                        date: "2026-09-08".into(),
                        method: Some("Banque".into()),
                        reference: Some("RECETTE-PAIEMENT".into()),
                        notes: None,
                    })
                    .unwrap();
            }
            "supplier-credit" => {
                store
                    .validate_supplier_credit_note(crate::models::ValidateSupplierCreditNoteInput {
                        request_id: Uuid::new_v4().to_string(),
                        supplier_credit_note_id: id,
                    })
                    .unwrap();
            }
            "expense-refund" | "expense-refund-reversal" => {
                store
                    .record_expense_refund(expense_refund_input(&id, refund_id))
                    .unwrap();
            }
            "supplier-refund" => {
                store
                    .record_supplier_credit_refund(supplier_refund_input(&id))
                    .unwrap();
            }
            "supplier-refund-reversal" => {
                store.reverse_supplier_credit_refund(serde_json::from_value(json!({"request_id":Uuid::new_v4().to_string(),"refund_id":refund_id.unwrap(),"date":"2026-09-08","reason":"Correction du remboursement fictif"})).unwrap()).unwrap();
            }
            _ => unreachable!(),
        }
        let prepared = next(&store);
        crate::business_sync::replay::tests::verify_candidate(&receiver, &prepared, &store);
        let changes = all(&prepared);
        assert!(
            scenario == "payroll-adult-validate"
                || changes.iter().any(|c| c["table"] == "journal_entries"),
            "{scenario}"
        );
        assert!(
            changes.iter().any(|c| c["table"] == "audit_log"),
            "{scenario}"
        );
        if let Some(folder) = &output {
            let directory = folder.join(scenario);
            fs::create_dir(&directory).unwrap();
            fs::write(
                directory.join("source.json"),
                serde_json::to_vec(&source).unwrap(),
            )
            .unwrap();
            fs::write(
                directory.join("manifest.json"),
                serde_json::to_vec(&prepared.manifest).unwrap(),
            )
            .unwrap();
            for (i, _) in prepared.manifest.chunks.iter().enumerate() {
                fs::copy(
                    prepared.folder.join(format!("{i:04}.json")),
                    directory.join(format!("{i:04}.json")),
                )
                .unwrap();
            }
        }
        println!(
            "QA_ACCOUNTING_TRANSITION scenario={scenario} changes={}",
            changes.len()
        );
    }
}
