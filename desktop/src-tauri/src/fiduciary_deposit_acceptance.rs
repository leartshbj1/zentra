//! Artifact-producing acceptance through application commands, never a user's profile.
use crate::{
    database::LocalStore,
    models::{
        AccountingPeriodInput, AssociateBankAccountInput, ConfirmBankReconciliationInput,
        ConvertQuoteInput, GenerateSalesDocumentPdfInput, LedgerInput, PeriodFilter,
    },
    tests::{enable_accounting, test_onboarding},
    vat_reporting::{VatProfileInput, VatReturnPreviewInput, VatSourceClassificationInput},
};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::Path};
use uuid::Uuid;

const IBAN: &str = "CH9300762011623852957";
fn id(value: &Value) -> String {
    value["id"].as_str().unwrap().to_owned()
}
fn save(folder: &Path, name: &str, value: &impl serde::Serialize) {
    fs::write(folder.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn initialize(path: &Path) -> (LocalStore, HashMap<&'static str, String>, String) {
    let store = LocalStore::initialize(path.to_path_buf()).unwrap();
    let mut onboarding = test_onboarding();
    onboarding.company_name = "Recette acompte fictive Sàrl".into();
    onboarding.vat_registered = true;
    onboarding.uid_number = Some("CHE-123.456.789".into());
    onboarding.vat_number = Some("CHE-123.456.789 TVA".into());
    onboarding.default_vat_bp = Some(810);
    onboarding.iban = Some(IBAN.into());
    store
        .complete_onboarding(onboarding, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let accounts = enable_accounting(&store);
    store
        .associate_bank_account(AssociateBankAccountInput {
            account_id: IBAN.into(),
            currency: "CHF".into(),
        })
        .unwrap();
    let profile = store
        .create_vat_profile(VatProfileInput {
            id: Some(Uuid::new_v4().to_string()),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            reporting_method: "effective".into(),
            form_of_reporting: "agreed".into(),
            periodicity: "quarterly".into(),
            gross_or_net: "net".into(),
            tdfn_activity_id: None,
            tdfn_rate_bp: None,
            afc_authorization_confirmed: false,
            notes: Some("Recette fictive, sans validation professionnelle ni transmission".into()),
            close_previous_open_profile: false,
        })
        .unwrap();
    (store, accounts, profile.id)
}
fn client(store: &LocalStore) -> String {
    id(&store.create_record("clients", json!({"name":"Client fictif - ne pas contacter",
        "address_line1":"Rue de test","address_line2":"7","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap())
}
fn classify(store: &LocalStore, source: &str, treatment: &str) {
    store
        .set_vat_source_classification(VatSourceClassificationInput {
            source_type: "invoice_item".into(),
            source_id: source.into(),
            treatment: treatment.into(),
            note: Some("Qualification de recette fictive".into()),
        })
        .unwrap();
}
fn period(from: &str, to: &str) -> PeriodFilter {
    PeriodFilter {
        date_from: Some(from.into()),
        date_to: Some(to.into()),
    }
}
fn row(store: &LocalStore, entity: &str, identifier: &str) -> Value {
    store.get_workspace().unwrap()[entity]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == identifier)
        .unwrap()
        .clone()
}
fn proof(store: &LocalStore) -> Value {
    let workspace = store.get_workspace().unwrap();
    json!({"quotes":workspace["quotes"],"invoices":workspace["invoices"],"invoice_items":workspace["invoice_items"],
        "quote_invoice_pairs":workspace["quote_invoice_pairs"],"payments":workspace["payments"],
        "journal":store.get_journal(period("2026-01-01","2026-12-31")).unwrap()})
}
fn pdf(store: &LocalStore, folder: &Path, entity: &str, identifier: &str, name: &str) {
    let receipt = store
        .generate_sales_document_pdf(GenerateSalesDocumentPdfInput {
            entity: entity.into(),
            document_id: identifier.into(),
            destination_path: folder.join(name).to_string_lossy().into_owned(),
        })
        .unwrap();
    assert_eq!(receipt["final_document"], true);
    save(folder, &format!("{name}.json"), &receipt);
}
fn money(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

/// Synthetic bank statement, with unique banking IDs and the actual frozen invoice reference.
fn statement(
    folder: &Path,
    name: &str,
    date: &str,
    amount: i64,
    opening: i64,
    reference: Option<&str>,
) -> String {
    let remittance = reference.map(|reference| format!("<Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry><Issr>ISO</Issr></Tp><Ref>{reference}</Ref></CdtrRefInf></Strd>"))
        .unwrap_or_else(|| "<Ustrd>RECETTE FICTIVE - paiement sans reference</Ustrd>".into());
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
 <BkToCstmrStmt>
  <GrpHdr><MsgId>RECETTE-{name}</MsgId><CreDtTm>{date}T12:00:00Z</CreDtTm></GrpHdr>
  <Stmt><Id>RECETTE-{name}</Id><CreDtTm>{date}T12:00:00Z</CreDtTm>
   <Acct><Id><IBAN>{IBAN}</IBAN></Id><Ccy>CHF</Ccy><Ownr><Nm>Recette fictive</Nm></Ownr></Acct>
   <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">{opening}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>{date}</Dt></Dt></Bal>
   <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">{closing}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>{date}</Dt></Dt></Bal>
   <Ntry><Amt Ccy="CHF">{amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd><RvslInd>false</RvslInd><Sts><Cd>BOOK</Cd></Sts>
    <BookgDt><Dt>{date}</Dt></BookgDt><ValDt><Dt>{date}</Dt></ValDt><AcctSvcrRef>C-{name}</AcctSvcrRef>
    <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>RCDT</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly></Domn></BkTxCd>
    <NtryDtls><TxDtls><Refs><AcctSvcrRef>D-{name}</AcctSvcrRef><EndToEndId>E2E-{name}</EndToEndId><TxId>TX-{name}</TxId></Refs>
     <Amt Ccy="CHF">{amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd>
     <RltdPties><Dbtr><Pty><Nm>Client fictif</Nm></Pty></Dbtr></RltdPties><RmtInf>{remittance}</RmtInf>
    </TxDtls></NtryDtls>
   </Ntry>
  </Stmt>
 </BkToCstmrStmt>
</Document>"#,
        amount = money(amount),
        opening = money(opening),
        closing = money(opening + amount)
    );
    let path = folder.join(format!("{name}.xml"));
    fs::write(&path, xml).unwrap();
    path.to_string_lossy().into_owned()
}
fn reference(store: &LocalStore, invoice: &str) -> Value {
    let qr = store.get_invoice_qr_bill(invoice).unwrap();
    assert_eq!(qr["frozen"], true);
    assert_eq!(qr["reference_type"], "SCOR");
    assert!(!qr["input"]["reference"].as_str().unwrap().is_empty());
    qr
}
fn import_and_replay(
    store: &LocalStore,
    folder: &Path,
    path: &str,
    name: &str,
    paid: i64,
    partial: i64,
    review: i64,
) -> Value {
    let receipt = store.import_camt_with_reconciliation(path, true).unwrap();
    save(folder, &format!("{name}-import.json"), &receipt);
    assert_eq!(receipt["automatic_reconciliation"]["paid_count"], paid);
    assert_eq!(
        receipt["automatic_reconciliation"]["partial_count"],
        partial
    );
    assert_eq!(receipt["automatic_reconciliation"]["review_count"], review);
    assert_eq!(receipt["automatic_reconciliation"]["failures"], json!([]));
    let before = proof(store);
    let replay = store.import_camt_with_reconciliation(path, true).unwrap();
    save(folder, &format!("{name}-rejeu.json"), &replay);
    assert_eq!(replay["duplicate"], true);
    assert_eq!(replay["automatic_reconciliation"]["paid_count"], 0);
    assert_eq!(replay["automatic_reconciliation"]["partial_count"], 0);
    assert_eq!(
        proof(store),
        before,
        "reimport must preserve exact business rows and journal"
    );
    receipt
}
fn assert_balanced(journal: &Value) {
    for entry in journal["entries"].as_array().unwrap() {
        let lines: Vec<_> = journal["lines"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|line| line["journal_entry_id"] == entry["id"])
            .collect();
        assert!(!lines.is_empty());
        assert_eq!(
            lines
                .iter()
                .map(|line| line["debit_cents"].as_i64().unwrap())
                .sum::<i64>(),
            lines
                .iter()
                .map(|line| line["credit_cents"].as_i64().unwrap())
                .sum::<i64>()
        );
    }
}

fn ordinary_bank_invoice(store: &LocalStore, client: &str, title: &str) -> String {
    let invoice = id(&store
        .create_record(
            "invoices",
            json!({"client_id":client,"title":title,
        "service_date_from":"2026-04-01","service_date_to":"2026-04-01"}),
        )
        .unwrap());
    let line = id(&store
        .create_record(
            "invoice_items",
            json!({"invoice_id":invoice,"description":"Scénario bancaire fictif sans TVA",
        "quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":0}),
        )
        .unwrap());
    classify(store, &line, "exempt");
    store
        .issue_invoice(&invoice, Some("2026-04-01".into()), None)
        .unwrap();
    invoice
}

fn execute_bank_review_cases(folder: &Path, profile_path: &Path) {
    fs::create_dir(folder).unwrap();
    let (store, _, _) = initialize(profile_path);
    let client = client(&store);
    let first = ordinary_bank_invoice(&store, &client, "Facture fictive A");
    let second = ordinary_bank_invoice(&store, &client, "Facture fictive B");
    let path = statement(folder, "camt-sans-reference", "2026-04-10", 10000, 0, None);
    import_and_replay(&store, folder, &path, "sans-reference", 0, 0, 1);
    let bank = store.get_bank_workspace().unwrap();
    let movement = &bank["movements"][0];
    assert!(movement["reconciliation"].is_null());
    assert_eq!(
        movement["suggestion"]["candidates"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    for invoice in [&first, &second] {
        assert_eq!(row(&store, "invoices", invoice)["paid_cents"], 0);
    }
    save(folder, "propositions-sans-reference.json", &bank);
    let confirm = ConfirmBankReconciliationInput {
        movement_id: id(movement),
        invoice_id: first.clone(),
    };
    let confirmed = store.confirm_bank_reconciliation(confirm.clone()).unwrap();
    let proof_before = proof(&store);
    let confirmed_again = store.confirm_bank_reconciliation(confirm).unwrap();
    assert_eq!(id(&confirmed["payment"]), id(&confirmed_again["payment"]));
    assert_eq!(proof(&store), proof_before);
    save(folder, "confirmation-manuelle.json", &confirmed);
    save(folder, "confirmation-manuelle-rejeu.json", &confirmed_again);
    let second_qr = reference(&store, &second);
    let partial_path = statement(
        folder,
        "camt-partiel",
        "2026-04-11",
        4000,
        10000,
        second_qr["input"]["reference"].as_str(),
    );
    import_and_replay(&store, folder, &partial_path, "partiel", 0, 1, 0);
    let partially_paid = row(&store, "invoices", &second);
    assert_eq!(partially_paid["paid_cents"], 4000);
    assert_eq!(
        partially_paid["total_cents"].as_i64().unwrap()
            - partially_paid["paid_cents"].as_i64().unwrap(),
        6000
    );
    save(folder, "apres-paiement-partiel.json", &partially_paid);
    let last_path = statement(
        folder,
        "camt-complement",
        "2026-04-12",
        6000,
        14000,
        second_qr["input"]["reference"].as_str(),
    );
    import_and_replay(&store, folder, &last_path, "complement", 1, 0, 0);
    let third = ordinary_bank_invoice(
        &store,
        &client,
        "Facture fictive C - contrôle du trop-perçu",
    );
    let third_qr = reference(&store, &third);
    let excess_path = statement(
        folder,
        "camt-excedent",
        "2026-04-13",
        12000,
        20000,
        third_qr["input"]["reference"].as_str(),
    );
    import_and_replay(&store, folder, &excess_path, "excedent", 0, 0, 1);
    let bank = store.get_bank_workspace().unwrap();
    let excess = bank["movements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|movement| movement["amount_cents"] == 12000)
        .unwrap();
    assert!(excess["reconciliation"].is_null());
    assert_eq!(row(&store, "invoices", &third)["paid_cents"], 0);
    let before = proof(&store);
    let refusal = store
        .confirm_bank_reconciliation(ConfirmBankReconciliationInput {
            movement_id: id(excess),
            invoice_id: third.clone(),
        })
        .unwrap_err()
        .to_string();
    assert_eq!(proof(&store), before);
    save(
        folder,
        "excedent-conserve-a-traiter.json",
        &json!({"bank_movement":excess,"invoice":row(&store,"invoices",&third),
        "bank_amount_cents":12000,"invoice_due_cents":10000,"excess_cents":2000,"manual_matching_error":refusal,
        "money_preserved":true,"split_payment_and_customer_credit_completed":false,
        "remaining_requirement":"Affectation de 100 CHF à la facture et conservation/règlement explicite des 20 CHF reçus en trop"}),
    );
    let journal = store
        .get_journal(period("2026-01-01", "2026-12-31"))
        .unwrap();
    assert_balanced(&journal);
    save(folder, "journal.json", &journal);
    save(folder, "banque.json", &bank);
    save(
        folder,
        "donnees-metier-fictives.json",
        &store.get_workspace().unwrap(),
    );
}

#[test]
#[ignore = "Explicit native acceptance; requires a new ZENTRA_DEPOSIT_OUTPUT directory"]
fn execute_deposit_and_bank_case_with_native_exports() {
    let output = std::path::PathBuf::from(
        std::env::var("ZENTRA_DEPOSIT_OUTPUT").expect("explicit output directory"),
    );
    assert!(output.is_absolute());
    fs::create_dir(&output).expect("refuse to overwrite an earlier acceptance run");
    let temporary = tempfile::tempdir().unwrap();
    let (store, accounts, profile) = initialize(&temporary.path().join("main"));
    let client = client(&store);
    let project = id(&store
        .create_record(
            "projects",
            json!({"client_id":client,"name":"Projet fictif - acompte et solde"}),
        )
        .unwrap());
    let quote = id(&store.create_record("quotes", json!({"client_id":client,"project_id":project,"title":"RECETTE FICTIVE - Ne pas payer",
        "notes":"Devis fictif de validation du logiciel. Aucune prestation réelle.","terms":"Acompte de 30 % puis facture de solde."})).unwrap());
    store.create_record("quote_items", json!({"quote_id":quote,"description":"Prestation fictive de recette","quantity":1,"unit":"forfait","unit_price_cents":100_000,"vat_bp":810})).unwrap();
    store
        .issue_quote(&quote, Some("2026-01-05".into()), Some("2026-02-05".into()))
        .unwrap();
    store.update_quote_status(&quote, "accepted").unwrap();
    pdf(&store, &output, "quotes", &quote, "devis-fictif.pdf");
    let conversion = ConvertQuoteInput {
        quote_id: quote.clone(),
        title: None,
        deposit_percentage_bp: Some(3000),
        issue_date: Some("2026-01-10".into()),
        due_date: Some("2026-02-09".into()),
        service_date_from: Some("2026-03-01".into()),
        service_date_to: Some("2026-03-20".into()),
    };
    let pair = store.convert_quote_to_invoice(conversion.clone()).unwrap();
    save(&output, "conversion.json", &pair);
    let deposit = id(&pair["invoice"]);
    let balance = id(&pair["balance_invoice"]);
    assert_ne!(deposit, balance);
    let before = proof(&store);
    let repeated_conversion = store
        .convert_quote_to_invoice(conversion)
        .unwrap_err()
        .to_string();
    assert_eq!(proof(&store), before);
    save(
        &output,
        "conversion-repetee-refusee.json",
        &json!({"error":repeated_conversion,"unchanged":true}),
    );
    for line in store.get_workspace().unwrap()["invoice_items"]
        .as_array()
        .unwrap()
    {
        classify(&store, line["id"].as_str().unwrap(), "taxable");
    }
    let issued_deposit = store
        .issue_invoice(&deposit, Some("2026-01-10".into()), None)
        .unwrap();
    let deposit_qr = reference(&store, &deposit);
    pdf(
        &store,
        &output,
        "invoices",
        &deposit,
        "facture-acompte-fictive.pdf",
    );
    let deposit_path = statement(
        &output,
        "camt-acompte",
        "2026-01-15",
        32430,
        0,
        deposit_qr["input"]["reference"].as_str(),
    );
    import_and_replay(&store, &output, &deposit_path, "acompte", 1, 0, 0);
    assert_eq!(row(&store, "invoices", &deposit)["status"], "payee");
    assert_eq!(row(&store, "invoices", &deposit)["paid_cents"], 32430);
    assert_eq!(row(&store, "invoices", &balance)["paid_cents"], 0);
    save(&output, "apres-acompte.json", &proof(&store));
    save(
        &output,
        "resultat-janvier-avant-prestation.json",
        &store
            .get_income_statement(period("2026-01-01", "2026-01-31"))
            .unwrap(),
    );
    let issued_balance = store
        .issue_invoice(
            &balance,
            Some("2026-03-20".into()),
            Some("2026-04-19".into()),
        )
        .unwrap();
    assert_ne!(issued_deposit["number"], issued_balance["number"]);
    let balance_qr = reference(&store, &balance);
    assert_ne!(
        deposit_qr["input"]["reference"],
        balance_qr["input"]["reference"]
    );
    save(
        &output,
        "references-factures.json",
        &json!({"deposit":deposit_qr,"balance":balance_qr}),
    );
    pdf(
        &store,
        &output,
        "invoices",
        &balance,
        "facture-solde-fictive.pdf",
    );
    let balance_path = statement(
        &output,
        "camt-solde",
        "2026-03-25",
        75670,
        32430,
        balance_qr["input"]["reference"].as_str(),
    );
    import_and_replay(&store, &output, &balance_path, "solde", 1, 0, 0);
    for invoice in [&deposit, &balance] {
        assert_eq!(row(&store, "invoices", invoice)["status"], "payee");
    }
    let workspace = store.get_workspace().unwrap();
    let actual = json!({"quote_gross":pair["quote"]["total_cents"],"deposit_gross":issued_deposit["total_cents"],
        "balance_gross":issued_balance["total_cents"],"total_vat":issued_deposit["vat_cents"].as_i64().unwrap()+issued_balance["vat_cents"].as_i64().unwrap()});
    let expected: Value = serde_json::from_str(include_str!(
        "../../../docs/recette-fiduciaire/attendus.json"
    ))
    .unwrap();
    save(
        &output,
        "comparaison.json",
        &json!({"expected":expected["deposit_case"],"actual":actual,"equal":actual==expected["deposit_case"]}),
    );
    assert_eq!(actual, expected["deposit_case"]);
    assert_eq!(workspace["invoices"].as_array().unwrap().len(), 2);
    assert_eq!(workspace["payments"].as_array().unwrap().len(), 2);
    assert_eq!(
        workspace["quote_invoice_pairs"].as_array().unwrap().len(),
        1
    );
    for invoice in workspace["invoices"].as_array().unwrap() {
        assert_eq!(invoice["project_id"], project);
        assert_eq!(invoice["quote_id"], quote);
    }
    let q1 = period("2026-01-01", "2026-03-31");
    let vat = store
        .preview_vat_return(VatReturnPreviewInput {
            date_from: "2026-01-01".into(),
            date_to: "2026-03-31".into(),
            submission_type: "initial".into(),
            profile_id: Some(profile.clone()),
        })
        .unwrap();
    assert!(vat.exportable, "{:?}", vat.blocking_issues);
    assert_eq!(vat.payable_tax_cents, 8100);
    let income = store.get_income_statement(q1.clone()).unwrap();
    assert_eq!(income["revenue_cents"], 100000);
    for (name, key, expected) in [("banque", "bank", 108100), ("clients", "ar", 0)] {
        let ledger = store
            .get_ledger(LedgerInput {
                account_id: accounts[key].clone(),
                date_from: q1.date_from.clone(),
                date_to: q1.date_to.clone(),
            })
            .unwrap();
        assert_eq!(ledger["net_debit_cents"], expected);
        save(&output, &format!("grand-livre-{name}.json"), &ledger);
    }
    let journal = store.get_journal(q1.clone()).unwrap();
    assert_eq!(journal["entries"].as_array().unwrap().len(), 4);
    assert_balanced(&journal);
    save(&output, "journal-T1.json", &journal);
    save(&output, "resultat-T1.json", &income);
    save(&output, "tva-T1.json", &vat);
    save(&output, "donnees-metier-avant-cloture.json", &workspace);
    save(
        &output,
        "banque-apres-solde.json",
        &store.get_bank_workspace().unwrap(),
    );
    let period_id = id(&store
        .upsert_accounting_period(AccountingPeriodInput {
            id: None,
            name: "Recette premier trimestre 2026".into(),
            date_from: "2026-01-01".into(),
            date_to: "2026-03-31".into(),
        })
        .unwrap());
    let review = store.prepare_fiduciary_pre_closing(q1.clone()).unwrap();
    save(&output, "pre-cloture.json", &review);
    let closed = store
        .finalize_accounting_period_with_review(&period_id, review["review_id"].as_str().unwrap())
        .unwrap();
    assert_eq!(closed["period"]["status"], "closed");
    save(&output, "cloture-T1.json", &closed);
    let closing_zip = store
        .export_fiduciary_closing_zip(
            review["review_id"].as_str().unwrap(),
            env!("CARGO_PKG_VERSION"),
        )
        .unwrap();
    fs::copy(
        closing_zip["path"].as_str().unwrap(),
        output.join("cloture-T1.zip"),
    )
    .unwrap();
    save(&output, "cloture-T1-export.json", &closing_zip);
    let original = row(&store, "invoices", &balance);
    let credit = id(&store.create_record("invoices",json!({"client_id":client,"project_id":project,"type":"credit_note","original_invoice_id":balance,
        "title":"AVOIR FICTIF - correction après clôture","service_date_from":"2026-04-10","service_date_to":"2026-04-10",
        "notes":"Document fictif de recette. Réduction de prestation de 100 CHF HT."})).unwrap());
    let credit_line=id(&store.create_record("invoice_items",json!({"invoice_id":credit,"description":"Réduction fictive de prestation","quantity":1,"unit":"forfait","unit_price_cents":10000,"vat_bp":810})).unwrap());
    classify(&store, &credit_line, "taxable");
    store
        .issue_invoice(&credit, Some("2026-04-10".into()), None)
        .unwrap();
    assert_eq!(row(&store, "invoices", &credit)["total_cents"], -10810);
    let after_credit = row(&store, "invoices", &balance);
    save(
        &output,
        "original-avant-apres-avoir.json",
        &json!({"before":original,"after":after_credit}),
    );
    // Issuing a linked credit refreshes payment-status metadata. All document
    // fields, including its frozen snapshot bytes, must stay exactly identical.
    let mut original_content = original.clone();
    original_content
        .as_object_mut()
        .unwrap()
        .remove("updated_at");
    let mut after_content = after_credit.clone();
    after_content.as_object_mut().unwrap().remove("updated_at");
    assert_eq!(after_content, original_content);
    assert_eq!(store.get_journal(q1).unwrap(), journal);
    let q2 = store
        .get_journal(period("2026-04-01", "2026-06-30"))
        .unwrap();
    assert_balanced(&q2);
    assert_eq!(q2["entries"].as_array().unwrap().len(), 1);
    let q2_vat = store
        .preview_vat_return(VatReturnPreviewInput {
            date_from: "2026-04-01".into(),
            date_to: "2026-06-30".into(),
            submission_type: "initial".into(),
            profile_id: Some(profile),
        })
        .unwrap();
    assert_eq!(q2_vat.payable_tax_cents, -810);
    save(&output, "journal-T2-apres-avoir.json", &q2);
    save(&output, "tva-T2-apres-avoir.json", &q2_vat);
    pdf(
        &store,
        &output,
        "invoices",
        &credit,
        "avoir-apres-cloture-fictif.pdf",
    );
    let before = proof(&store);
    let mut refusals = Vec::new();
    refusals.push(
        store
            .update_record("invoices", &balance, json!({"title":"Mutation refusée"}))
            .unwrap_err()
            .to_string(),
    );
    refusals.push(
        store
            .delete_record("invoices", &balance)
            .unwrap_err()
            .to_string(),
    );
    let entry = id(&journal["entries"][0]);
    refusals.push(
        store
            .update_record(
                "journal_entries",
                &entry,
                json!({"description":"Mutation refusée"}),
            )
            .unwrap_err()
            .to_string(),
    );
    refusals.push(
        store
            .delete_record("journal_entries", &entry)
            .unwrap_err()
            .to_string(),
    );
    assert_eq!(proof(&store), before);
    save(
        &output,
        "modifications-refusees.json",
        &json!({"errors":refusals,"unchanged":true}),
    );
    save(
        &output,
        "donnees-metier-apres-avoir.json",
        &store.get_workspace().unwrap(),
    );
    let backup_path = output.join("dossier-fictif.zentra");
    let backup = store
        .create_backup(
            Some(backup_path.to_string_lossy().into_owned()),
            env!("CARGO_PKG_VERSION"),
        )
        .unwrap();
    save(&output, "sauvegarde.json", &backup);
    let restored = LocalStore::initialize(temporary.path().join("restored")).unwrap();
    restored
        .restore_backup(&backup_path.to_string_lossy(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    assert_eq!(proof(&restored), proof(&store));
    assert_eq!(
        restored.get_invoice_qr_bill(&deposit).unwrap(),
        store.get_invoice_qr_bill(&deposit).unwrap()
    );
    assert_eq!(
        restored.get_invoice_qr_bill(&balance).unwrap(),
        store.get_invoice_qr_bill(&balance).unwrap()
    );
    assert_eq!(restored.verify_audit_log().unwrap()["valid"], true);
    assert_eq!(
        restored.get_accounting_continuity().unwrap()["total_anomalies"],
        0
    );
    save(
        &output,
        "restauration.json",
        &json!({"restore_completed":true,"business_equal":true,"references_equal":true,"audit_valid":true,"continuity_anomalies":0}),
    );
    execute_bank_review_cases(
        &output.join("cas-bancaires-a-controler"),
        &temporary.path().join("bank-review"),
    );
    save(
        &output,
        "provenance.json",
        &json!({"case":"deposit_case","application_version":env!("CARGO_PKG_VERSION"),
        "schema_version":store.connect().unwrap().query_row("PRAGMA user_version",[],|row|row.get::<_,i64>(0)).unwrap(),
        "harness_sha256":format!("{:x}",<sha2::Sha256 as sha2::Digest>::digest(include_str!("fiduciary_deposit_acceptance.rs").replace("\r\n","\n").as_bytes())),
        "expected_sha256":format!("{:x}",<sha2::Sha256 as sha2::Digest>::digest(include_str!("../../../docs/recette-fiduciaire/attendus.json").replace("\r\n","\n").as_bytes())),
        "source_revision":std::env::var("ZENTRA_FIDUCIARY_SOURCE_REVISION").unwrap_or_default(),"source_hash_newlines":"LF",
        "synthetic":true,"professional_approval":false,"submission_to_afc":false,
        "execution":"LocalStore commands, isolated temporary profiles","advance_recognition_requires_professional_review":true}),
    );
}
