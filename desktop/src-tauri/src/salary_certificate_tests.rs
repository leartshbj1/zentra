use super::*;
use lopdf::Document;

fn fixture() -> (CertificateDraft, CertificateInput) {
    let items: Vec<Value> = [
        ("base","Salaire mensuel","earning",500000,""),
        ("hours","Salaire horaire","earning",60000,""),
        ("family","Allocations familiales","earning",30000,""),
        ("avs","AVS / AI / APG","deduction",29700,"avs_ai_apg"),
        ("ac","AC","deduction",6200,"ac"),
        ("aanp","AANP","deduction",8100,"aanp"),
        ("ijm","IJM","deduction",6400,"ijm"),
        ("lpp","LPP","deduction",28000,"lpp"),
        ("tax","Impôt à la source","deduction",41300,"source_tax"),
        ("employer","AVS employeur","employer",29700,"avs_ai_apg"),
    ].iter().map(|(id,label,kind,amount,category)|json!({"id":id,"label":label,"kind":kind,"amount_cents":amount,"category":category})).collect();
    let contributions: Vec<Value>=items.iter().filter(|i|i["category"]!="").map(|i|json!({"payslip_item_id":i["id"],"side":if i["kind"]=="employer"{"employer"}else{"employee"},"category":i["category"]})).collect();
    let snapshot = json!({"schema":"helvichantier.payslip_snapshot.v1","payslip":{"id":"p1","period":"2026-12"},"employee":{"id":"e1"},"items":items,"contributions":contributions});
    let rows=rows_from_payslips(&[json!({"id":"p1","period":"2026-12","employee_id":"e1","snapshot_json":snapshot.to_string()})]).unwrap();
    let identity = CertificateIdentity {
        name: "Alex Exemple".into(),
        address: "Rue du Lac 8\n2000 Neuchâtel".into(),
        avs_number: "756.1234.5678.97".into(),
        birth_date: "1990-02-28".into(),
        period_start: "2026-01-01".into(),
        period_end: "2026-12-31".into(),
        employer_contact: "Entreprise Exemple SA\nRue du Test 12\n1000 Lausanne\n021 000 00 00"
            .into(),
        place_date: "Lausanne, 31.12.2026".into(),
    };
    let draft = CertificateDraft {
        employee_id: "e1".into(),
        year: 2026,
        source_hash: "test".into(),
        identity: identity.clone(),
        rows,
        sources: vec![],
        withholding_rows: vec![],
        payslip_count: 1,
        unpaid_count: 0,
    };
    let input = CertificateInput {
        employee_id: "e1".into(),
        year: 2026,
        source_hash: "test".into(),
        identity,
        allocations: draft
            .rows
            .iter()
            .map(|r| (r.id.clone(), r.proposed_box.clone()))
            .collect(),
        source_ids: vec![],
        realization_note: String::new(),
        extras: vec![],
        free_transport: true,
        meals: false,
        effective_expenses_attested: false,
        benefits: String::new(),
        remarks: String::new(),
        reviewed: true,
    };
    (draft, input)
}
fn string_value(values: &BTreeMap<String, FormValue>, key: &str) -> String {
    match &values[key] {
        FormValue::Text(v) => v.clone(),
        _ => panic!("not text"),
    }
}

#[test]
fn fiscal_net_excludes_source_tax_and_ijm_and_employer_costs() {
    let (draft, input) = fixture();
    assert_eq!(draft.rows.len(), 9);
    let (values, _) = certificate_values(&draft, &input).unwrap();
    for (key, expected) in [
        ("1", "5900"),
        ("8", "5900"),
        ("9", "440"),
        ("10_1", "280"),
        ("11", "5180"),
        ("12", "413"),
    ] {
        assert_eq!(
            string_value(&values, &format!("DezZahlNull_{key}")),
            expected
        );
    }
    assert!(string_value(&values, "TextLinks_15_1").contains("IJM"));
    let mut incorrect = input.clone();
    let ijm = draft.rows.iter().find(|r| r.label == "IJM").unwrap();
    incorrect.allocations.insert(ijm.id.clone(), "9".into());
    assert!(certificate_values(&draft, &incorrect).is_err());
    incorrect = input.clone();
    incorrect.identity.avs_number = "756.000.000.000".into();
    assert!(certificate_values(&draft, &incorrect).is_err());
    incorrect = input.clone();
    incorrect.allocations.clear();
    assert!(certificate_values(&draft, &incorrect).is_err());
}

#[test]
fn paper_rounding_preserves_printed_equations_and_nearest_fiscal_net() {
    for cents in 0..100 {
        let amounts = BTreeMap::from([
            ("1".into(), 500001 + cents),
            ("2_2".into(), 12349),
            ("9".into(), 32949),
            ("10_1".into(), 28049),
            ("8".into(), 512350 + cents),
            ("11".into(), 451352 + cents),
        ]);
        let rounded = rounded_amounts(&amounts);
        assert_eq!(rounded["11"], (amounts["11"] + 50) / 100);
        assert_eq!(rounded["8"], rounded["1"] + rounded["2_2"]);
        assert_eq!(rounded["11"], rounded["8"] - rounded["9"] - rounded["10_1"]);
    }
}

#[test]
fn official_pdf_preserves_canonical_widgets_and_visible_values_with_annex() {
    let (draft, mut input) = fixture();
    input.remarks =
        "Indication complémentaire détaillée pour le contrôle du certificat annuel. ".repeat(6);
    let (values, annex) = certificate_values(&draft, &input).unwrap();
    let bytes = certificate_pdf(&values, &annex).unwrap();
    let pdf = Document::load_mem(&bytes).unwrap();
    assert_eq!(pdf.get_pages().len(), 2);
    let root = pdf
        .get_dictionary(pdf.trailer.get(b"Root").unwrap().as_reference().unwrap())
        .unwrap();
    let form = pdf
        .get_dictionary(root.get(b"AcroForm").unwrap().as_reference().unwrap())
        .unwrap();
    assert!(!form.get(b"NeedAppearances").unwrap().as_bool().unwrap());
    let fields = pdf
        .dereference(form.get(b"Fields").unwrap())
        .unwrap()
        .1
        .as_array()
        .unwrap();
    assert_eq!(fields.len(), 44);
    let first = pdf
        .get_dictionary(*pdf.get_pages().get(&1).unwrap())
        .unwrap();
    let widgets = pdf
        .dereference(first.get(b"Annots").unwrap())
        .unwrap()
        .1
        .as_array()
        .unwrap();
    assert_eq!(widgets.len(), 44);
    for field in fields {
        let id = field.as_reference().unwrap();
        assert!(widgets.iter().any(|w| w.as_reference().ok() == Some(id)));
        let object = pdf.get_dictionary(id).unwrap();
        assert!(!object.has(b"Parent"));
        let name =
            String::from_utf8_lossy(object.get(b"T").unwrap().as_str().unwrap()).into_owned();
        if let Some(value) = values.get(&name) {
            match value {
                FormValue::Text(value) => {
                    let raw = object.get(b"V").unwrap().as_str().unwrap();
                    let decoded = String::from_utf16(
                        &raw[2..]
                            .chunks_exact(2)
                            .map(|x| u16::from_be_bytes([x[0], x[1]]))
                            .collect::<Vec<_>>(),
                    )
                    .unwrap();
                    assert_eq!(decoded, *value);
                    let appearance = pdf
                        .get_object(
                            object
                                .get(b"AP")
                                .unwrap()
                                .as_dict()
                                .unwrap()
                                .get(b"N")
                                .unwrap()
                                .as_reference()
                                .unwrap(),
                        )
                        .unwrap()
                        .as_stream()
                        .unwrap();
                    let content = lopdf::content::Content::decode(&appearance.content).unwrap();
                    let drawn = content
                        .operations
                        .iter()
                        .filter(|op| op.operator == "Tj")
                        .map(|op| {
                            encoding_rs::WINDOWS_1252
                                .decode(op.operands[0].as_str().unwrap())
                                .0
                                .into_owned()
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    assert_eq!(
                        drawn.split_whitespace().collect::<Vec<_>>().join(" "),
                        value.split_whitespace().collect::<Vec<_>>().join(" ")
                    );
                }
                FormValue::Check(checked) => {
                    let state = object.get(b"V").unwrap().as_name().unwrap();
                    assert_eq!(state, object.get(b"AS").unwrap().as_name().unwrap());
                    assert_eq!(state != b"Off", *checked);
                    assert!(object
                        .get(b"AP")
                        .unwrap()
                        .as_dict()
                        .unwrap()
                        .get(b"N")
                        .unwrap()
                        .as_dict()
                        .unwrap()
                        .has(state));
                }
            }
        }
    }
    if let Some(dir) = std::env::var_os("ZENTRA_CERTIFICATE_SAMPLES") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join("certificat-annuel-exemple.pdf"),
            bytes,
        )
        .unwrap();
    }
}

#[test]
fn annual_draft_proposes_service_year_exposes_cross_year_payments_and_rejects_stale_sources() {
    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temp.path().join("profile")).unwrap();
    let connection = store.connect().unwrap();
    connection.execute_batch("INSERT INTO settings(id,onboarding_completed,company_name,city,created_at,updated_at) VALUES(1,1,'Exemple SA','Lausanne','2026-01-01','2026-01-01'); INSERT INTO employees(id,name,birth_date,employment_start_date,employment_end_date,created_at,updated_at) VALUES('e1','Alex Exemple','2010-01-01','2025-11-15','2026-08-31','2025-11-15','2025-11-15');").unwrap();
    for (id, period, payment) in [
        ("p1", "2025-12", "2026-01-05"),
        ("p2", "2026-01", "2026-01-31"),
        ("p3", "2026-02", "2027-01-05"),
    ] {
        connection.execute("INSERT INTO journal_entries(id,number,entry_date,description,source_type,source_id,source_event,created_at) VALUES(?,?,?,'Paie de test','payslip',?,'payment',?)",params![id,id,payment,id,payment]).unwrap();
        let snapshot = json!({"schema":"helvichantier.payslip_snapshot.v1","payslip":{"id":id,"period":period},"employee":{"id":"e1"},"items":[{"id":id,"label":"Salaire mensuel","kind":"earning","amount_cents":100000}],"contributions":[]});
        connection.execute("INSERT INTO payslips(id,employee_id,period,status,payment_date,payment_journal_entry_id,snapshot_json,created_at,updated_at) VALUES(?,'e1',?,'paye',?,?,?,?,?)",params![id,period,payment,id,snapshot.to_string(),payment,payment]).unwrap();
    }
    connection.execute("INSERT INTO payslips(id,employee_id,period,status,created_at,updated_at) VALUES('draft','e1','2026-03','brouillon','2026-03-01','2026-03-01')",[]).unwrap();
    let draft = store.salary_certificate_draft("e1", 2026).unwrap();
    assert_eq!(draft.payslip_count, 2);
    assert_eq!(draft.sources.len(), 3);
    assert!(
        !draft
            .sources
            .iter()
            .find(|s| s.id == "p1")
            .unwrap()
            .default_included
    );
    assert!(
        draft
            .sources
            .iter()
            .find(|s| s.id == "p3")
            .unwrap()
            .default_included
    );
    assert_eq!(draft.unpaid_count, 1);
    assert_eq!(draft.rows[0].amount_cents, 200000);
    assert_eq!(draft.identity.period_start, "2026-01-01");
    assert_eq!(draft.identity.period_end, "2026-08-31");
    let (_, mut input) = fixture();
    input.source_hash = draft.source_hash.clone();
    input.source_ids = draft
        .sources
        .iter()
        .filter(|s| s.default_included)
        .map(|s| s.id.clone())
        .collect();
    input.allocations = draft
        .rows
        .iter()
        .map(|row| (row.id.clone(), row.proposed_box.clone()))
        .collect();
    assert!(store
        .salary_certificate_preview(&input)
        .unwrap_err()
        .to_string()
        .contains("rattachement fiscal"));
    input.realization_note =
        "Salaires connus, non contestés et dont le paiement est certain à la clôture.".into();
    let exported = temp.path().join("certificat.pdf");
    store
        .export_salary_certificate(&input, exported.to_str().unwrap())
        .unwrap();
    assert!(std::fs::read(&exported).unwrap().starts_with(b"%PDF"));
    let audit: String = connection
        .query_row(
            "SELECT payload_json FROM audit_log WHERE action='salary_certificate.exported'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let audit: Value = serde_json::from_str(&audit).unwrap();
    assert_eq!(audit["input"]["sourceIds"], json!(input.source_ids));
    assert_eq!(
        audit["pdf_sha256"],
        format!("{:x}", Sha256::digest(std::fs::read(&exported).unwrap()))
    );
    connection
        .execute(
            "UPDATE employees SET address_line1='Nouvelle adresse 4' WHERE id='e1'",
            [],
        )
        .unwrap();
    assert!(store
        .salary_certificate_preview(&input)
        .unwrap_err()
        .to_string()
        .contains("changé"));
    assert_ne!(
        store
            .salary_certificate_draft("e1", 2026)
            .unwrap()
            .source_hash,
        draft.source_hash
    );
    input.reviewed = false;
    assert!(store
        .export_salary_certificate(&input, temp.path().join("refuse.pdf").to_str().unwrap())
        .is_err());
    assert!(!temp.path().join("refuse.pdf").exists());
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM journal_entries", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn source_selection_keeps_withholding_separate_and_refunds_do_not_change_fiscal_net() {
    let (draft, mut input) = fixture();
    let wages: Vec<_> = draft
        .rows
        .iter()
        .filter(|r| r.proposed_box != "12")
        .cloned()
        .collect();
    let tax: Vec<_> = draft
        .rows
        .iter()
        .filter(|r| r.proposed_box == "12")
        .cloned()
        .collect();
    let sources = vec![CertificateSource {
        id: "december".into(),
        period: "2025-12".into(),
        payment_date: "2026-01-05".into(),
        default_included: false,
        rows: wages,
    }];
    assert_eq!(selected_rows(&sources, &tax, &[]).unwrap().len(), 1);
    assert_eq!(
        selected_rows(&sources, &tax, &["december".into()])
            .unwrap()
            .len(),
        9
    );
    assert!(selected_rows(&sources, &tax, &["december".into(), "december".into()]).is_err());
    assert!(selected_rows(&sources, &tax, &["unknown".into()]).is_err());
    input.extras.push(CertificateExtra {
        box_id: "12".into(),
        label: "Remboursement de retenue par l’employeur".into(),
        amount_cents: -50050,
    });
    let (values, _) = certificate_values(&draft, &input).unwrap();
    assert_eq!(string_value(&values, "DezZahlNull_12"), "-88");
    assert_eq!(string_value(&values, "DezZahlNull_11"), "5180");
}
