use super::*;

const OLD: &str = "CH9300762011623852957";
const NEW: &str = "CH5604835012345678009";

fn day(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
}

fn past(id: &str, total_cents: i64, date: &str) -> PastInvoice {
    PastInvoice {
        id: id.into(),
        reference: Some(format!("R-{id}")),
        reference_normalized: Some(format!("R{}", id.to_uppercase())),
        payment_reference: None,
        creditor_iban: None,
        total_cents,
        document_date: day(date),
        validated: true,
        same_supplier: true,
    }
}

fn candidate(total_cents: i64, date: &str, iban: &str) -> Candidate {
    Candidate {
        invoice_id: "new".into(),
        total_cents,
        document_date: day(date),
        reference_normalized: Some("RNEW".into()),
        payment_reference: None,
        iban: Some(iban.into()),
    }
}

fn paid(date: &str, amount_cents: i64) -> PastPayment {
    PastPayment { date: day(date), amount_cents }
}

fn seen(iban: &str, date: &str) -> SeenIban {
    SeenIban { iban: iban.into(), first_seen: day(date) }
}

fn kinds(findings: &[Finding]) -> Vec<&'static str> {
    findings.iter().map(Finding::kind).collect()
}

#[test]
fn iban_changed_since_the_last_payment_order_shows_both_masked_ibans_and_the_change_date() {
    let history = SupplierHistory {
        payments: vec![paid("2026-08-03", 12_000)],
        paid_ibans: vec![PaidIban { iban: OLD.into(), paid_on: day("2026-08-01") }],
        seen_ibans: vec![seen(OLD, "2025-01-10"), seen(NEW, "2026-10-20")],
        ..SupplierHistory::default()
    };
    let findings = evaluate_payment(&candidate(12_000, "2026-10-21", "ch56 0483 5012 3456 7800 9"), &history);
    assert_eq!(
        findings[0],
        Finding::IbanChanged { previous_iban: OLD.into(), current_iban: NEW.into(), changed_on: Some(day("2026-10-20")), last_paid_on: Some(day("2026-08-01")) }
    );
    let shown = findings[0].json();
    assert_eq!(shown["previousIban"], "CH93 •••• 2957");
    assert_eq!(shown["currentIban"], "CH56 •••• 8009");
    assert_eq!(shown["changedOn"], "2026-10-20");
    // Même IBAN que le dernier ordre : rien à signaler.
    assert!(!kinds(&evaluate_payment(&candidate(12_000, "2026-10-21", OLD), &history)).contains(&"iban_changed"));
}

#[test]
fn iban_changed_without_any_order_compares_with_the_iban_known_at_the_last_recorded_payment() {
    let mut history = SupplierHistory {
        payments: vec![paid("2026-06-30", 8_990)],
        seen_ibans: vec![seen(OLD, "2025-01-01"), seen(NEW, "2026-09-15")],
        ..SupplierHistory::default()
    };
    let findings = evaluate_payment(&candidate(8_990, "2026-10-01", NEW), &history);
    assert_eq!(
        findings[0],
        Finding::IbanChanged { previous_iban: OLD.into(), current_iban: NEW.into(), changed_on: Some(day("2026-09-15")), last_paid_on: Some(day("2026-06-30")) }
    );
    // Le nouvel IBAN était déjà connu au moment du dernier paiement.
    history.seen_ibans = vec![seen(OLD, "2025-01-01"), seen(NEW, "2026-05-01")];
    assert!(!kinds(&evaluate_payment(&candidate(8_990, "2026-10-01", NEW), &history)).contains(&"iban_changed"));
}

#[test]
fn a_supplier_never_paid_is_new_and_one_payment_is_enough_to_know_it() {
    assert_eq!(kinds(&evaluate_payment(&candidate(5_000, "2026-10-01", NEW), &SupplierHistory::default())), vec!["new_supplier"]);
    let paid_once = SupplierHistory { payments: vec![paid("2026-02-01", 5_000)], ..SupplierHistory::default() };
    assert!(evaluate_payment(&candidate(5_000, "2026-10-01", NEW), &paid_once).is_empty());
    let ordered_once = SupplierHistory { paid_ibans: vec![PaidIban { iban: NEW.into(), paid_on: day("2026-02-01") }], ..SupplierHistory::default() };
    assert!(evaluate_payment(&candidate(5_000, "2026-10-01", NEW), &ordered_once).is_empty());
}

#[test]
fn duplicates_are_found_by_number_payment_reference_or_same_amount_within_ten_days() {
    let reference = "210000000003139471430009017".to_owned();
    let mut same_number = past("x", 99_000, "2026-01-01");
    same_number.reference_normalized = Some("RNEW".into());
    let mut same_qr = past("y", 77_000, "2026-03-01");
    same_qr.payment_reference = Some(reference.clone());
    let same_amount = past("z", 45_000, "2026-09-25");
    let monthly = past("m", 45_000, "2026-08-30");
    let history = SupplierHistory { payments: vec![paid("2026-01-10", 1)], invoices: vec![same_number, same_qr, same_amount, monthly], ..SupplierHistory::default() };
    let mut current = candidate(45_000, "2026-10-01", NEW);
    current.payment_reference = Some(reference.clone());
    let reasons: Vec<(String, DuplicateReason)> = evaluate_payment(&current, &history)
        .into_iter()
        .filter_map(|finding| match finding {
            Finding::PossibleDuplicate { other_invoice_id, reason, .. } => Some((other_invoice_id, reason)),
            _ => None,
        })
        .collect();
    // Un abonnement du même montant un mois plus tôt n'est pas un doublon.
    assert_eq!(
        reasons,
        vec![("x".into(), DuplicateReason::SameNumber), ("y".into(), DuplicateReason::SamePaymentReference), ("z".into(), DuplicateReason::SameAmountAndDate)]
    );

    // Une autre fiche fournisseur avec la même référence QR et le même IBAN : la même facture saisie deux fois.
    let mut other_card = past("w", 1_000, "2026-01-01");
    other_card.same_supplier = false;
    other_card.payment_reference = Some(reference.clone());
    other_card.creditor_iban = Some(NEW.into());
    let mut elsewhere = other_card.clone();
    elsewhere.id = "v".into();
    elsewhere.creditor_iban = Some(OLD.into());
    let history = SupplierHistory { payments: vec![paid("2026-01-10", 1)], invoices: vec![other_card, elsewhere], ..SupplierHistory::default() };
    let found = evaluate_payment(&current, &history);
    assert_eq!(found.len(), 1);
    assert!(matches!(&found[0], Finding::PossibleDuplicate { other_invoice_id, reason: DuplicateReason::SamePaymentReference, .. } if other_invoice_id == "w"));
    assert_eq!(found[0].json()["reason"], "same_payment_reference");
}

#[test]
fn an_unusual_amount_needs_four_known_invoices_three_times_the_median_and_one_hundred_francs() {
    let history = SupplierHistory {
        payments: vec![paid("2026-01-10", 10_000)],
        invoices: vec![past("a", 10_000, "2026-01-01"), past("b", 12_000, "2026-03-01"), past("c", 11_000, "2026-05-01"), past("d", 9_000, "2026-07-01")],
        ..SupplierHistory::default()
    };
    let findings = evaluate_payment(&candidate(40_000, "2026-10-01", NEW), &history);
    assert_eq!(findings, vec![Finding::UnusualAmount { usual_cents: 10_500, history_count: 4 }]);
    assert_eq!(findings[0].json()["factor"], 3);
    assert!(evaluate_payment(&candidate(30_000, "2026-10-01", NEW), &history).is_empty());

    let mut short = history.clone();
    short.invoices.pop();
    assert!(evaluate_payment(&candidate(40_000, "2026-10-01", NEW), &short).is_empty());

    // Petites sommes : CHF 50 au lieu de CHF 10, c'est cinq fois plus mais pas CHF 100 de plus.
    let small = SupplierHistory {
        payments: vec![paid("2026-01-10", 1_000)],
        invoices: (0..4).map(|n| past(&format!("s{n}"), 1_000, "2026-02-01")).collect(),
        ..SupplierHistory::default()
    };
    assert!(evaluate_payment(&candidate(5_000, "2026-10-01", NEW), &small).is_empty());
}

#[test]
fn supplier_summary_counts_payments_twelve_months_last_payment_and_paid_ibans() {
    let history = SupplierHistory {
        payments: vec![paid("2025-06-01", 50_000), paid("2026-02-01", 10_000), paid("2026-09-01", 12_000)],
        paid_ibans: vec![PaidIban { iban: OLD.into(), paid_on: day("2025-06-01") }, PaidIban { iban: NEW.into(), paid_on: day("2026-09-01") }],
        invoices: vec![past("a", 10_000, "2026-01-01"), past("b", 12_000, "2026-08-25")],
        ..SupplierHistory::default()
    };
    let summary = supplier_summary("new", &history, day("2026-10-25"));
    assert_eq!(summary["paymentCount"], 3);
    assert_eq!(summary["total12MonthsCents"], 22_000);
    assert_eq!(summary["lastPaymentDate"], "2026-09-01");
    assert_eq!(summary["lastPaymentCents"], 12_000);
    assert_eq!(summary["usualCents"], 11_000);
    assert_eq!(summary["paidIbans"], json!(["CH56 •••• 8009", "CH93 •••• 2957"]));
}

fn actor(user: &str, role: &str, solo: bool) -> Actor {
    Actor { user_id: user.into(), display_name: user.to_uppercase(), role: role.into(), solo }
}

fn approval(status: &str, amount_cents: i64, iban: &str) -> Approval {
    Approval {
        status: status.into(),
        amount_cents,
        creditor_iban: iban.into(),
        prepared_by_user_id: "anna".into(),
        prepared_by_name: "Anna".into(),
        prepared_at: "2026-10-25T08:00:00Z".into(),
        approved_by_user_id: (status == "approved").then(|| "marc".into()),
        approved_by_name: (status == "approved").then(|| "Marc".into()),
        approved_at: (status == "approved").then(|| "2026-10-25T09:00:00Z".into()),
    }
}

#[test]
fn double_validation_starts_at_the_threshold_can_be_switched_off_and_never_blocks_a_one_person_company() {
    let settings = Settings::default();
    let team = actor("anna", "admin", false);
    assert!(approval_required(&settings, &team, 500_000));
    assert!(!approval_required(&settings, &team, 499_999));
    assert!(!approval_required(&Settings { approval_enabled: false, ..settings }, &team, 900_000));
    assert!(approval_required(&Settings { approval_threshold_cents: 100_000, ..settings }, &team, 100_000));
    assert!(!approval_required(&settings, &actor("anna", "owner", true), 900_000));
}

#[test]
fn the_person_who_prepares_cannot_approve_alone_and_only_an_owner_or_admin_approves() {
    let prepared = approval("prepared", 600_000, OLD);
    assert!(approval_refusal(&actor("anna", "admin", false), &prepared).unwrap().contains("ne peut pas l'approuver seule"));
    assert_eq!(approval_refusal(&actor("marc", "admin", false), &prepared), None);
    assert_eq!(approval_refusal(&actor("marc", "owner", false), &prepared), None);
    assert!(approval_refusal(&actor("marc", "member", false), &prepared).unwrap().contains("propriétaire ou un administrateur"));
    assert!(approval_refusal(&actor("marc", "accountant", false), &prepared).is_some());
    // Seul dans l'entreprise : la même personne peut approuver.
    assert_eq!(approval_refusal(&actor("anna", "owner", true), &prepared), None);
    assert!(approval_refusal(&actor("marc", "admin", false), &approval("approved", 600_000, OLD)).unwrap().contains("déjà approuvé"));
}

#[test]
fn an_approval_covers_its_amount_at_most_and_its_iban_only() {
    let approved = approval("approved", 600_000, OLD);
    assert!(approval_covers(Some(&approved), 600_000, OLD));
    assert!(approval_covers(Some(&approved), 550_000, "ch93 0076 2011 6238 5295 7"));
    assert!(!approval_covers(Some(&approved), 600_001, OLD));
    assert!(!approval_covers(Some(&approved), 600_000, NEW));
    assert!(!approval_covers(Some(&approval("prepared", 600_000, OLD)), 600_000, OLD));
    assert!(!approval_covers(None, 600_000, OLD));
    let shown = approval_json(Some(&approved), &Settings::default(), &actor("anna", "admin", false), 600_000, NEW);
    assert_eq!(shown["required"], true);
    assert_eq!(shown["covered"], false);
    assert_eq!(shown["stale"], true);
    assert_eq!(shown["preparedByMe"], true);
}

fn line(description: &str, account: &str, vat_bp: i64) -> EntryLine {
    EntryLine { description: description.into(), account_id: account.into(), vat_bp }
}

#[test]
fn an_unusual_entry_is_an_account_or_vat_rate_never_used_for_this_supplier_or_an_unusual_total() {
    let usual = |total_cents: i64| PastEntry { lines: vec![line("Ciment", "4000", 810), line("Sable", "4000", 810)], total_cents };
    let history = vec![usual(10_000), usual(11_000), usual(12_000)];
    let ordinary = entry_review(&[line("Gravier", "4000", 810)], 11_500, &history);
    assert_eq!((ordinary.usual_account_id.as_deref(), ordinary.usual_vat_bp, ordinary.findings.len()), (Some("4000"), Some(810), 0));

    let review = entry_review(&[line("Ordinateur", "1520", 810), line("Livre", "4000", 260)], 11_000, &history);
    assert_eq!(
        review.findings,
        vec![
            EntryFinding::UnusualAccount { line: 0, description: "Ordinateur".into(), account_id: "1520".into() },
            EntryFinding::UnusualVatRate { line: 1, description: "Livre".into(), vat_bp: 260 },
        ]
    );
    assert_eq!(entry_review(&[line("Ciment", "4000", 810)], 100_000, &history).findings, vec![EntryFinding::UnusualAmount { usual_cents: 11_000 }]);

    // Un taux déjà utilisé une fois pour ce fournisseur n'est pas inhabituel.
    let mut with_reduced = history.clone();
    with_reduced.push(PastEntry { lines: vec![line("Classeurs", "4000", 260)], total_cents: 11_000 });
    assert!(entry_review(&[line("Livre", "4000", 260)], 11_000, &with_reduced).findings.is_empty());

    // Moins de trois factures connues : on montre l'habitude, sans alerte.
    let young = entry_review(&[line("Ordinateur", "1520", 0)], 900_000, &history[..2]);
    assert_eq!((young.history_count, young.findings.len()), (2, 0));
}

#[test]
fn the_iban_paid_is_read_from_the_payment_block_not_from_the_debtor_account() {
    let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Document><DbtrAcct><Id><IBAN>CH4431999123000889012</IBAN></Id></DbtrAcct>\
        <CdtTrfTxInf><PmtId><EndToEndId>R-1</EndToEndId></PmtId><CdtrAcct><Id><IBAN>CH9300762011623852957</IBAN></Id></CdtrAcct></CdtTrfTxInf>\
        <CdtTrfTxInf>\n  <PmtId><EndToEndId>R-2</EndToEndId></PmtId>\n  <CdtrAcct><Id><IBAN>CH56 0483 5012 3456 7800 9</IBAN></Id></CdtrAcct>\n</CdtTrfTxInf></Document>";
    assert_eq!(xml_creditor_iban(xml, "R-1").as_deref(), Some(OLD));
    assert_eq!(xml_creditor_iban(xml, "R-2").as_deref(), Some(NEW));
    assert_eq!(xml_creditor_iban(xml, "R-3"), None);
    assert_eq!(mask_iban("CH93 0076 2011 6238 5295 7"), "CH93 •••• 2957");
    assert_eq!(mask_iban("CH12"), "CH12");
}

#[test]
fn migration_keeps_the_iban_history_shared_settings_and_the_one_person_rule() {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store.complete_onboarding(crate::tests::test_onboarding(), "payment-safety-test").unwrap();
    let connection = store.connect().unwrap();
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert_eq!(version, crate::schema::SCHEMA_VERSION);
    assert_eq!(load_settings(&connection).unwrap(), Settings::default());
    // Sans compte Zentra : une seule personne, propriétaire.
    let local = load_actor(&connection).unwrap();
    assert!(local.solo && local.may_approve());

    let supplier = store.create_record("suppliers", json!({"name": "Matériaux Léman SA", "iban": "CH93 0076 2011 6238 5295 7", "currency": "CHF"})).unwrap();
    let supplier_id = supplier["id"].as_str().unwrap().to_owned();
    connection.execute("UPDATE suppliers SET iban=? WHERE id=?", params!["CH56 0483 5012 3456 7800 9", supplier_id]).unwrap();
    connection.execute("UPDATE suppliers SET name='Matériaux Léman' WHERE id=?", params![supplier_id]).unwrap();
    let mut seen = connection.prepare("SELECT iban FROM company_local_supplier_iban_seen WHERE supplier_id=? ORDER BY iban").unwrap();
    let ibans = seen.query_map([&supplier_id], |row| row.get::<_, String>(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(ibans, vec![NEW.to_owned(), OLD.to_owned()]);

    // Membre d'une équipe : strict tant que l'équipe n'est pas lue, puis selon le nombre de membres.
    connection
        .execute("INSERT INTO company_local_identity(id,organization_id,user_id,display_name,role) VALUES(1,'org','anna','Anna','member')", [])
        .unwrap();
    assert!(!load_actor(&connection).unwrap().solo);
    store.remember_company_team_size(1).unwrap();
    assert!(load_actor(&connection).unwrap().solo);
    store.remember_company_team_size(3).unwrap();
    assert!(!load_actor(&connection).unwrap().solo);

    let input = |threshold: i64| PaymentSafetySettingsInput { approval_enabled: true, approval_threshold_cents: threshold, receipt_reminder_days: 14 };
    assert!(store.save_payment_safety_settings(input(200_000)).unwrap_err().to_string().contains("propriétaire ou un administrateur"));
    connection.execute("UPDATE company_local_identity SET role='admin' WHERE id=1", []).unwrap();
    assert!(store.save_payment_safety_settings(input(0)).is_err());
    store.save_payment_safety_settings(input(200_000)).unwrap();
    assert_eq!(load_settings(&connection).unwrap(), Settings { approval_enabled: true, approval_threshold_cents: 200_000, receipt_reminder_days: 14 });
}
