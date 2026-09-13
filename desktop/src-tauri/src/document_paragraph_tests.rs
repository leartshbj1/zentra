use super::*;
use serde_json::json;

#[test]
fn document_paragraph_options_validate_and_keep_legacy_json() {
    let paragraph: RichParagraph = serde_json::from_value(json!({"runs":[]})).unwrap();
    let value = serde_json::to_value(paragraph).unwrap();
    for key in ["numbered", "indent", "spaceAfter"] { assert!(value.get(key).is_none()); }
    for bad in [json!({"indent":4}), json!({"spaceAfter":19}), json!({"spaceAfter":-1}), json!({"numbered":true,"bullet":true})] {
        let design: Composition = serde_json::from_value(json!({"intro":[bad]})).unwrap();
        assert!(design.validate().is_err());
    }
}

#[test]
fn document_paragraph_lists_wrap_indent_and_renumber_with_real_metrics() {
    let paragraphs = [0,1,1,0,1,3,0].iter().map(|depth| json!({"numbered":true,"indent":depth,"spaceAfter":12,"runs":[{"text":"Une condition longue avec toutes les informations utiles. ".repeat(8),"fontFamily":"times","fontSize":14}]})).collect::<Vec<_>>();
    let design: Composition = serde_json::from_value(json!({"closing":paragraphs})).unwrap();
    let lines = wrap(&design, &design.closing, 240., 10.).unwrap();
    let markers = lines.iter().filter(|l| !l.2.is_empty()).map(|l| String::from_utf8(l.2.iter().map(|g| g.byte).collect()).unwrap()).collect::<Vec<_>>();
    assert_eq!(markers, ["1.","1.","2.","2.","1.","1.","3."]);
    assert_eq!(lines.iter().filter(|l| l.4 == 12.).count(), 7);
    assert!(lines.iter().all(|l| measure(&l.0, 10.) + l.3 <= 240.1));
    let style = DocumentStyle { composition: Some(design.clone()), ..Default::default() };
    let mut writer = Composer::new(&style, None, "Atelier du Léman", "Conditions").unwrap();
    writer.rich(&design.closing).unwrap();
    let (bytes,count) = writer.finish("Exemple").unwrap();
    assert!(count > 1);
    let pdf = Document::load_mem(&bytes).unwrap();
    for id in pdf.get_pages().values() {
        let ops = Content::decode(&pdf.get_page_content(*id).unwrap()).unwrap();
        for op in ops.operations.iter().filter(|op| op.operator == "Tm") {
            assert!(op.operands[4].as_float().unwrap() >= 30.);
            assert!(op.operands[5].as_float().unwrap() >= 20.);
        }
    }
}

#[test]
fn document_paragraph_footer_reserves_spacing_and_rejects_excess_height() {
    let design: Composition = serde_json::from_value(json!({"footerText":[{"numbered":true,"indent":2,"spaceAfter":18,"runs":[{"text":"Une note"}]},{"numbered":true,"indent":2,"spaceAfter":18,"runs":[{"text":"Autre note"}]}]})).unwrap();
    let style = DocumentStyle { composition: Some(design), ..Default::default() };
    let writer = Composer::new(&style, None, "Entreprise", "Facture").unwrap();
    assert!((writer.bottom - 100.).abs() < 0.1);
    let (bytes,_) = writer.finish("Exemple").unwrap();
    let text = Document::load_mem(&bytes).unwrap().extract_text(&[1]).unwrap();
    assert!(text.contains("1.") && text.contains("2.") && text.contains("Autre note"));
    let oversized: Composition = serde_json::from_value(json!({"footerText":[{"spaceAfter":18,"runs":[{"text":"Un","fontSize":24}]},{"spaceAfter":18,"runs":[{"text":"Deux","fontSize":24}]},{"spaceAfter":18,"runs":[{"text":"Trois","fontSize":24}]}]})).unwrap();
    assert!(Composer::new(&DocumentStyle { composition: Some(oversized), ..Default::default() }, None, "Entreprise", "Facture").is_err());
}

#[test]
fn document_paragraph_all_four_exports_save_layout_and_keep_amounts() {
    use crate::database::LocalStore;
    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temp.path().join("profile")).unwrap();
    let issuer = json!({"company_name":"Atelier du Léman Sàrl","address_line1":"Rue du Lac 12","postal_code":"1000","city":"Lausanne","country":"CH","vat_registered":true,"uid_number":"CHE-123.456.789","vat_number":"CHE-123.456.789 TVA"});
    let composition = json!({"fontFamily":"times","logoPosition":"right","intro":[{"runs":[{"text":"Votre document personnalisé.","bold":true}]}],"closing":[{"numbered":true,"spaceAfter":6,"runs":[{"text":"Première condition"}]},{"numbered":true,"indent":1,"spaceAfter":12,"runs":[{"text":"Une précision utile","italic":true}]},{"numbered":true,"spaceAfter":6,"runs":[{"text":"Deuxième condition","bold":true}]}],"footerText":[{"spaceAfter":3,"runs":[{"text":"Merci de votre confiance."}]}]});
    let mut designs = json!({});
    for kind in ["invoices","quotes","accounts","payslips"] {
        designs[kind] = composition.clone();
        let bytes = store.document_design_example(kind, json!({"composition":composition}), issuer.clone()).unwrap();
        let pdf = Document::load_mem(&bytes).unwrap();
        let text = pdf.extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>()).unwrap();
        for needle in ["Première condition", "Une précision utile", "Deuxième condition", "1.", "2."] { assert!(text.contains(needle), "{kind}: {needle}"); }
        assert!(text.contains(match kind { "accounts" => "178'000.00", "payslips" => "5'336.00", _ => "540.50" }));
        if let Some(directory) = std::env::var_os("ZENTRA_PARAGRAPH_SAMPLES") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(Path::new(&directory).join(format!("{kind}-paragraphs.pdf")), bytes).unwrap();
        }
    }
    store.connect().unwrap().execute("INSERT INTO settings(id,onboarding_completed,company_name,noga_section,noga_division,activity_description,created_at,updated_at) VALUES(1,1,'Entreprise test','F','43','Travaux spécialisés','2026-09-13T01:00:00Z','2026-09-13T01:00:00Z')", []).unwrap();
    let saved = store.update_settings(json!({"extra_settings_json":{"documentComposition":designs}})).unwrap();
    let extra: serde_json::Value = serde_json::from_str(saved["extra_settings_json"].as_str().unwrap()).unwrap();
    for kind in ["invoices","quotes","accounts","payslips"] { assert_eq!(extra["documentComposition"][kind], composition); }
}
