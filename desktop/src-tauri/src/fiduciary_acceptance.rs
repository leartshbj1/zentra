//! Explicit acceptance execution, using the same LocalStore commands as the UI.
//! Never seed posted entries, calculate expected values with the production engine,
//! or open the user's profile. Artifacts are written only to a new explicit folder.
use std::{fs, path::Path};

use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    customer_credit_settlements::CustomerCreditSettlementInput,
    database::LocalStore,
    models::{
        AccountInput, AccountingPeriodInput, GenerateSalesDocumentPdfInput, LedgerInput,
        ManualJournalInput, ManualJournalLineInput, PeriodFilter, RecordPaymentInput,
        RecordSupplierPaymentInput, ValidateSupplierCreditNoteInput,
    },
    supplier_credit_refunds::SupplierCreditRefundInput,
    tests::{enable_accounting, test_onboarding},
    vat_reporting::{
        ExportVatReturnInput, VatProfileInput, VatReturnPreviewInput, VatSourceClassificationInput,
    },
};

fn id(value: &Value) -> String {
    value["id"].as_str().unwrap().to_owned()
}
fn uuid() -> String {
    Uuid::new_v4().to_string()
}
fn save(path: &Path, name: &str, value: &impl serde::Serialize) {
    fs::write(path.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn classify(store: &LocalStore, kind: &str, source: &str, treatment: &str) {
    store
        .set_vat_source_classification(VatSourceClassificationInput {
            source_type: kind.into(),
            source_id: source.into(),
            treatment: treatment.into(),
            note: Some("Scénario fictif de recette fiduciaire, aucune remise à l’AFC".into()),
        })
        .unwrap();
}
fn sale(store: &LocalStore, client: &str, original: Option<&str>, net: i64, date: &str) -> String {
    let document = id(&store
        .create_record(
            "invoices",
            json!({
                "client_id":client,"title":"RECETTE FICTIVE - Ne pas payer",
                "type":if original.is_some() {"credit_note"} else {"standard"},
                "original_invoice_id":original,"service_date_from":date,"service_date_to":date,
                "notes":"Données fictives. Document destiné uniquement à la validation du logiciel."
            }),
        )
        .unwrap());
    let line = id(&store
        .create_record(
            "invoice_items",
            json!({"invoice_id":document,
        "description":if original.is_some(){"Réduction de prestation"}else{"Prestation de recette"},
        "quantity":1,"unit":"forfait","unit_price_cents":net,"vat_bp":810}),
        )
        .unwrap());
    classify(store, "invoice_item", &line, "taxable");
    store
        .issue_invoice(&document, Some(date.into()), None)
        .unwrap();
    document
}

#[test]
#[ignore = "Explicit artifact-producing acceptance; requires a new ZENTRA_FIDUCIARY_OUTPUT folder"]
fn execute_ledger_case_with_native_exports() {
    let output = std::path::PathBuf::from(
        std::env::var("ZENTRA_FIDUCIARY_OUTPUT").expect("explicit output directory"),
    );
    assert!(output.is_absolute(), "absolute output directory required");
    fs::create_dir(&output).expect("refuse to overwrite an earlier acceptance run");
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    let mut onboarding = test_onboarding();
    onboarding.company_name = "Recette fiduciaire fictive Sàrl".into();
    onboarding.vat_registered = true;
    onboarding.uid_number = Some("CHE-123.456.789".into());
    onboarding.vat_number = Some("CHE-123.456.789 TVA".into());
    onboarding.default_vat_bp = Some(810);
    // Ordinary IBAN for a synthetic document; every page is labelled as a test.
    onboarding.iban = Some("CH9300762011623852957".into());
    save(&output, "configuration-entreprise.json", &onboarding);
    store
        .complete_onboarding(onboarding, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let accounts = enable_accounting(&store);
    let goods = id(&store
        .upsert_account(AccountInput {
            id: None,
            code: "4000".into(),
            name: "Achats de marchandises".into(),
            account_type: "expense".into(),
            normal_balance: "debit".into(),
            report_section: "cost_of_goods".into(),
            active: true,
        })
        .unwrap());
    let mut mapping = store.get_accounting_settings().unwrap();
    mapping["expense_account_id"] = json!(goods);
    store
        .configure_accounting(serde_json::from_value(mapping.clone()).unwrap())
        .unwrap();
    save(&output, "configuration-comptable.json", &mapping);
    let capital = id(&store
        .upsert_account(AccountInput {
            id: None,
            code: "2800".into(),
            name: "Capital social".into(),
            account_type: "equity".into(),
            normal_balance: "credit".into(),
            report_section: "equity".into(),
            active: true,
        })
        .unwrap());
    let profile = store
        .create_vat_profile(VatProfileInput {
            id: Some(uuid()),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            reporting_method: "effective".into(),
            form_of_reporting: "agreed".into(),
            periodicity: "quarterly".into(),
            gross_or_net: "net".into(),
            tdfn_activity_id: None,
            tdfn_rate_bp: None,
            afc_authorization_confirmed: false,
            notes: Some("Recette fictive, sans transmission".into()),
            close_previous_open_profile: false,
        })
        .unwrap();
    let period = PeriodFilter {
        date_from: Some("2026-01-01".into()),
        date_to: Some("2026-12-31".into()),
    };
    store
        .upsert_accounting_period(AccountingPeriodInput {
            id: None,
            name: "Recette 2026".into(),
            date_from: "2026-01-01".into(),
            date_to: "2026-12-31".into(),
        })
        .unwrap();
    let opening = store
        .post_manual_journal_entry(ManualJournalInput {
            entry_date: "2026-01-01".into(),
            description: "Apport initial fictif".into(),
            currency: "CHF".into(),
            lines: vec![
                (accounts["bank"].clone(), 1_000_000, 0),
                (capital, 0, 1_000_000),
            ]
            .into_iter()
            .map(
                |(account_id, debit_cents, credit_cents)| ManualJournalLineInput {
                    account_id,
                    debit_cents,
                    credit_cents,
                    memo: None,
                    project_id: None,
                    client_id: None,
                    employee_id: None,
                },
            )
            .collect(),
        })
        .unwrap();
    let client=id(&store.create_record("clients",json!({"name":"Client fictif - ne pas contacter",
        "address_line1":"Rue de test","address_line2":"7","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap());
    let invoice = sale(&store, &client, None, 100_000, "2026-01-05");
    let payment_input = RecordPaymentInput {
        request_id: uuid(),
        invoice_id: invoice.clone(),
        amount_cents: 108_100,
        date: Some("2026-01-10".into()),
        method: Some("bank".into()),
        reference: Some("RECETTE-VENTE".into()),
        notes: None,
    };
    let payment = store.record_payment(payment_input.clone()).unwrap();
    let payment_replay = store.record_payment(payment_input).unwrap();
    assert_eq!(id(&payment), id(&payment_replay));

    let supplier = id(&store
        .create_record(
            "suppliers",
            json!({"name":"Fournisseur fictif - marchandises"}),
        )
        .unwrap());
    let purchase = uuid();
    let purchase_line = uuid();
    store.save_supplier_invoice_draft(serde_json::from_value(json!({"id":purchase,"supplier_id":supplier,
        "date":"2026-01-12","due_date":"2026-02-12","reference":"RECETTE-ACHAT",
        "items":[{"id":purchase_line,"description":"Marchandises intégralement consommées","quantity_milli":1000,
            "unit_price_cents":40_000,"vat_bp":810,"category":"Marchandises"}]})).unwrap()).unwrap();
    classify(
        &store,
        "supplier_invoice_item",
        &purchase_line,
        "input_materials",
    );
    let supplier_evidence = output.join("pieces-fournisseur-fictives.pdf");
    fs::write(
        &supplier_evidence,
        include_bytes!("../../../docs/recette-fiduciaire/fixtures/pieces-fournisseur-fictives.pdf"),
    )
    .unwrap();
    let attachment = store
        .add_supplier_invoice_attachment(crate::attachments::AddSupplierInvoiceAttachmentInput {
            supplier_invoice_id: purchase.clone(),
            source_path: supplier_evidence.to_string_lossy().into_owned(),
        })
        .unwrap();
    save(&output, "justificatif-fournisseur-import.json", &attachment);
    store.validate_supplier_invoice(&purchase).unwrap();
    let supplier_payment = store
        .record_supplier_payment(RecordSupplierPaymentInput {
            request_id: uuid(),
            supplier_invoice_id: purchase,
            amount_cents: 43_240,
            date: "2026-01-15".into(),
            method: Some("bank".into()),
            reference: Some("RECETTE-ACHAT".into()),
            notes: None,
        })
        .unwrap();

    let credit = sale(&store, &client, Some(&invoice), 10_000, "2026-01-20");
    let customer_refund = store
        .record_customer_credit_settlement(CustomerCreditSettlementInput {
            request_id: uuid(),
            credit_note_id: credit.clone(),
            event_type: "refund".into(),
            invoice_id: None,
            date: "2026-01-21".into(),
            amount_cents: 10_810,
            bank_account_id: Some(accounts["bank"].clone()),
            reference: "RECETTE-REMBOURSEMENT-CLIENT".into(),
            reason: "Réduction de prestation et remboursement fictifs".into(),
        })
        .unwrap();
    let supplier_credit = uuid();
    let supplier_credit_line = uuid();
    store.save_supplier_credit_note_draft(serde_json::from_value(json!({"id":supplier_credit,"supplier_id":supplier,
        "document_date":"2026-01-22","reference":"RECETTE-AVOIR-ACHAT","items":[{"id":supplier_credit_line,
        "description":"Réduction sur marchandises","quantity_milli":1000,"unit_price_cents":5000,"vat_bp":810,
        "category":"Marchandises"}],"allocations":[]})).unwrap()).unwrap();
    classify(
        &store,
        "supplier_credit_note_item",
        &supplier_credit_line,
        "input_materials",
    );
    store
        .validate_supplier_credit_note(ValidateSupplierCreditNoteInput {
            request_id: uuid(),
            supplier_credit_note_id: supplier_credit.clone(),
        })
        .unwrap();
    let supplier_refund = store
        .record_supplier_credit_refund(SupplierCreditRefundInput {
            request_id: uuid(),
            supplier_credit_note_id: supplier_credit,
            amount_cents: 5405,
            date: "2026-01-23".into(),
            reference: "RECETTE-REMBOURSEMENT-FOURNISSEUR".into(),
            reason: "Réduction confirmée et remboursée, recette fictive".into(),
        })
        .unwrap();

    let vat = store
        .preview_vat_return(VatReturnPreviewInput {
            date_from: "2026-01-01".into(),
            date_to: "2026-03-31".into(),
            submission_type: "initial".into(),
            profile_id: Some(profile.id.clone()),
        })
        .unwrap();
    let trial = store.get_trial_balance(period.clone()).unwrap();
    let income = store.get_income_statement(period.clone()).unwrap();
    let balance = store.get_balance_sheet(period.clone()).unwrap();
    let journal = store.get_journal(period.clone()).unwrap();
    let bank = store
        .get_ledger(LedgerInput {
            account_id: accounts["bank"].clone(),
            date_from: period.date_from.clone(),
            date_to: period.date_to.clone(),
        })
        .unwrap();
    let continuity = store.get_accounting_continuity().unwrap();
    let effective = vat.effective_reporting_method.as_ref().unwrap();
    let actual = json!({"sales_net":income["revenue_cents"],"purchases_net":income["expense_cents"],
        "vat_due":effective.output_tax_cents,"vat_recoverable":effective.input_tax_material_and_services_cents,
        "vat_payable":vat.payable_tax_cents,"profit_before_tax":income["profit_cents"],"bank":bank["net_debit_cents"],
        "assets_with_vat_unoffset":balance["assets_cents"],
        "liabilities_and_equity_with_vat_unoffset":(["liabilities_cents","equity_cents","current_result_cents","unallocated_prior_results_cents"]
            .iter().map(|key|balance[key].as_i64().unwrap()).sum::<i64>())});
    let expected: Value = serde_json::from_str(include_str!(
        "../../../docs/recette-fiduciaire/attendus.json"
    ))
    .unwrap();
    save(
        &output,
        "comparaison.json",
        &json!({"expected":expected["ledger_case"],"actual":actual,
        "equal":actual==expected["ledger_case"],"scope":"Commandes natives, profil isolé fictif; aucune validation professionnelle"}),
    );
    for (name, value) in [
        ("journal.json", &journal),
        ("grand-livre-banque.json", &bank),
        ("balance-comptes.json", &trial),
        ("bilan.json", &balance),
        ("resultat.json", &income),
        ("continuite.json", &continuity),
    ] {
        save(&output, name, value);
    }
    save(&output, "tva-apercu.json", &vat);
    save(
        &output,
        "donnees-metier-fictives.json",
        &store.get_workspace().unwrap(),
    );
    save(
        &output,
        "operations.json",
        &json!({"opening":opening,"payment":payment,"payment_replay":payment_replay,
        "supplier_payment":supplier_payment,"customer_refund":customer_refund,"supplier_refund":supplier_refund}),
    );
    assert_eq!(
        actual, expected["ledger_case"],
        "independent acceptance amounts"
    );
    assert_eq!(continuity["total_anomalies"], 0);
    assert_eq!(trial["balanced"], true);
    assert_eq!(balance["balanced"], true);
    for key in ["ar", "supplier_payable"] {
        let ledger = store
            .get_ledger(LedgerInput {
                account_id: accounts[key].clone(),
                date_from: period.date_from.clone(),
                date_to: period.date_to.clone(),
            })
            .unwrap();
        assert_eq!(ledger["net_debit_cents"], 0, "{key} should be settled");
        save(&output, &format!("grand-livre-{key}.json"), &ledger);
    }
    assert!(vat.exportable, "{:?}", vat.blocking_issues);
    let vat_export = store
        .export_vat_return_xml(ExportVatReturnInput {
            date_from: "2026-01-01".into(),
            date_to: "2026-03-31".into(),
            submission_type: "initial".into(),
            profile_id: Some(profile.id),
            business_reference_id: "RECETTE-FICTIVE-2026-T1".into(),
            file_name: None,
        })
        .unwrap();
    fs::copy(&vat_export.file_path, output.join("tva-2026-T1.xml")).unwrap();
    save(&output, "tva-export.json", &vat_export);
    for (document, name) in [
        (&invoice, "facture-fictive.pdf"),
        (&credit, "avoir-fictif.pdf"),
    ] {
        let result = store
            .generate_sales_document_pdf(GenerateSalesDocumentPdfInput {
                entity: "invoices".into(),
                document_id: document.clone(),
                destination_path: output.join(name).to_string_lossy().into_owned(),
            })
            .unwrap();
        save(&output, &format!("{name}.json"), &result);
    }
    let annual = store
        .export_annual_accounts_pdf(
            period.clone(),
            &output.join("comptes-annuels-fictifs.pdf").to_string_lossy(),
        )
        .unwrap();
    save(&output, "comptes-annuels-export.json", &annual);
    let review = store.prepare_fiduciary_pre_closing(period).unwrap();
    assert_eq!(review["checks"]["attachments_total"], 1);
    assert_eq!(review["checks"]["attachments_verified"], 1);
    save(&output, "pre-cloture.json", &review);
    let closing = store
        .export_fiduciary_closing_zip(
            review["review_id"].as_str().unwrap(),
            env!("CARGO_PKG_VERSION"),
        )
        .unwrap();
    fs::copy(
        closing["path"].as_str().unwrap(),
        output.join("dossier-cloture-provisoire.zip"),
    )
    .unwrap();
    save(&output, "cloture-export.json", &closing);
    save(
        &output,
        "provenance.json",
        &json!({"application_version":env!("CARGO_PKG_VERSION"),
        "schema_version":store.connect().unwrap().query_row("PRAGMA user_version",[],|row|row.get::<_,i64>(0)).unwrap(),
        "harness_sha256":format!("{:x}",<sha2::Sha256 as sha2::Digest>::digest(include_str!("fiduciary_acceptance.rs").replace("\r\n","\n").as_bytes())),
        "source_hash_newlines":"LF",
        "source_revision":std::env::var("ZENTRA_FIDUCIARY_SOURCE_REVISION").unwrap_or_default(),
        "case":"ledger_case","execution":"LocalStore commands used by the application, isolated temporary profile",
        "synthetic":true,"professional_approval":false,"submission_to_afc":false,
        "expected_sha256":format!("{:x}",<sha2::Sha256 as sha2::Digest>::digest(include_str!("../../../docs/recette-fiduciaire/attendus.json").replace("\r\n","\n").as_bytes()))}),
    );
}
