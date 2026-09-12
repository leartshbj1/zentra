use super::*;
use serde_json::json;

fn printed(ops: &[Operation], needle: &str) -> (f32, f32, [f32; 3]) {
    let (mut x, mut y, mut ink) = (0., 0., INK);
    for op in ops {
        match op.operator.as_str() {
            "Tm" => { x = op.operands[4].as_float().unwrap(); y = op.operands[5].as_float().unwrap(); }
            "rg" => { ink = [0,1,2].map(|i| op.operands[i].as_float().unwrap()); }
            "Tj" if WINDOWS_1252.decode(op.operands[0].as_str().unwrap()).0.contains(needle) => return (x, y, ink),
            _ => {}
        }
    }
    panic!("Missing text: {needle}");
}

#[test]
fn document_layout_keeps_old_settings_and_rejects_invalid_overrides() {
    let old: Composition = serde_json::from_value(json!({"marginMm":20})).unwrap();
    old.validate().unwrap();
    let serialized = serde_json::to_value(&old).unwrap();
    for field in ["companyAlign", "recipientAlign", "topMarginMm", "logoGap", "blockSpacing", "textColor", "titleColor", "closingOnNewPage"] {
        assert!(serialized.get(field).is_none(), "absent overrides stay absent: {field}");
    }
    for bad in [json!({"companyAlign":"justify"}), json!({"recipientAlign":"outside"}), json!({"topMarginMm":46}), json!({"logoGap":-1}), json!({"blockSpacing":0}), json!({"textColor":"white"}), json!({"titleColor":"#12345z"})] {
        assert!(serde_json::from_value::<Composition>(bad).unwrap().validate().is_err());
    }
}

#[test]
fn document_layout_aligns_blocks_and_colors_without_modifying_text() {
    let design: Composition = serde_json::from_value(json!({"companyAlign":"center","recipientAlign":"right","topMarginMm":35,"blockSpacing":1.5,"textColor":"#182b49","titleColor":"#793c32"})).unwrap();
    let style = DocumentStyle { composition: Some(design), ..Default::default() };
    let mut writer = Composer::new(&style, None, "Entreprise test", "Facture test").unwrap();
    let left = writer.left();
    let (company_x, company_y, ink) = printed(&writer.pages[0], "Entreprise test");
    assert!(company_x > left + 100.);
    assert!((company_y - (HEIGHT - 35. * 72. / 25.4 - 11.)).abs() < 0.01);
    assert_eq!(ink, text_color("#182b49").unwrap());
    writer.company_line("Adresse test", 9., false).unwrap();
    writer.heading("Facture test").unwrap();
    assert_eq!(printed(&writer.pages[0], "Facture test").2, text_color("#793c32").unwrap());
    writer.recipient_line("Client test", 9., false).unwrap();
    assert!(printed(&writer.pages[0], "Client test").0 > WIDTH / 2.);
    let before = writer.y; writer.gap(10.);
    assert!((before - writer.y - 15.).abs() < 0.01);
    writer.rich(&serde_json::from_value(json!([{"runs":[{"text":"Passage rouge","color":"#ff0000"}]}])).unwrap()).unwrap();
    assert_eq!(printed(&writer.pages[0], "Passage rouge").2, [1.,0.,0.]);
    writer.total("TOTAL TTC", "CHF 540.50", true).unwrap();
    let (bytes, count) = writer.finish("test").unwrap();
    assert_eq!(count, 1);
    assert!(Document::load_mem(&bytes).unwrap().extract_text(&[1]).unwrap().contains("540.50"));
}

#[test]
fn document_layout_page_break_skips_empty_conditions_and_keeps_totals() {
    let style = DocumentStyle { composition: Some(Composition { closing_on_new_page: Some(true), ..Default::default() }), ..Default::default() };
    let mut writer = Composer::new(&style, None, "Entreprise", "Devis").unwrap();
    writer.total("TOTAL TTC", "CHF 540.50", true).unwrap();
    writer.begin_closing(has_text(&plain("  \n  "))).unwrap();
    assert_eq!(writer.pages.len(), 1);
    writer.begin_closing(has_text(&plain("Conditions convenues"))).unwrap();
    writer.rich(&plain("Conditions convenues")).unwrap();
    let (bytes, count) = writer.finish("test").unwrap();
    assert_eq!(count, 2);
    let pdf = Document::load_mem(&bytes).unwrap();
    assert!(pdf.extract_text(&[1]).unwrap().contains("540.50"));
    assert!(!pdf.extract_text(&[1]).unwrap().contains("Conditions convenues"));
    assert!(pdf.extract_text(&[2]).unwrap().contains("Conditions convenues"));
}

#[test]
fn document_layout_all_four_native_exports_apply_the_saved_overrides() {
    use crate::database::LocalStore;
    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temp.path().join("profile")).unwrap();
    let source = temp.path().join("logo.png");
    image::RgbImage::from_pixel(280, 64, image::Rgb([25,70,55])).save(&source).unwrap();
    let logo = store.stage_company_logo(source.to_str().unwrap()).unwrap();
    let issuer = json!({"company_name":"Atelier du Léman Sàrl","legal_form":"Sàrl","address_line1":"Rue du Lac 12","postal_code":"1000","city":"Lausanne","country":"CH","vat_registered":true,"uid_number":"CHE-123.456.789","vat_number":"CHE-123.456.789 TVA","logo_path":logo});
    for kind in ["quotes","invoices","accounts","payslips"] {
        let design = json!({"fontFamily":"times","companyAlign":"center","recipientAlign":"right","logoPosition":"center","logoGap":24,"topMarginMm":25,"blockSpacing":0.5,"textColor":"#182b49","titleColor":"#793c32","closingOnNewPage":true,"closing":[{"runs":[{"text":"Conditions distinctes de recette","bold":true}]}]});
        let bytes = store.document_design_example(kind, json!({"composition":design}), issuer.clone()).unwrap();
        let pdf = Document::load_mem(&bytes).unwrap();
        let pages = pdf.get_pages();
        let text = pdf.extract_text(&pages.keys().copied().collect::<Vec<_>>()).unwrap();
        assert!(text.contains(match kind { "accounts" => "178'000.00", "payslips" => "5'336.00", _ => "540.50" }));
        assert!(!pdf.extract_text(&[1]).unwrap().contains("Conditions distinctes"));
        let first = Content::decode(&pdf.get_page_content(*pages.values().next().unwrap()).unwrap()).unwrap();
        assert!(printed(&first.operations, "Atelier du Léman").0 > 120.);
        let mut matrix = None;
        for op in &first.operations {
            if op.operator == "cm" { matrix = Some(&op.operands); }
            if op.operator == "Do" && op.operands[0].as_name().is_ok_and(|name| name == b"Logo") {
                let transform = matrix.unwrap();
                let x = transform[4].as_float().unwrap(); let width = transform[0].as_float().unwrap();
                assert!((x - (WIDTH-width)/2.).abs() < 0.01);
                let logo_bottom = transform[5].as_float().unwrap();
                let (_, baseline, _) = printed(&first.operations, "Atelier du Léman");
                assert!((logo_bottom - baseline - 24. - 11.).abs() < 0.01);
            }
        }
        if let Some(directory) = std::env::var_os("ZENTRA_LAYOUT_SAMPLES") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(std::path::Path::new(&directory).join(format!("{kind}-layout.pdf")), bytes).unwrap();
        }
    }
    let connection = store.connect().unwrap();
    for table in ["quotes","invoices","payslips","journal_entries"] {
        assert_eq!(connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get::<_,i64>(0)).unwrap(), 0);
    }
}
