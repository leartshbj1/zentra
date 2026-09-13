use super::*;
use serde_json::json;

#[test]
fn document_customization_rejects_invalid_values_and_preserves_legacy_settings() {
    let old: Composition = serde_json::from_value(json!({})).unwrap();
    let serialized = serde_json::to_value(&old).unwrap();
    for field in ["pageOrientation", "titleFontFamily", "tableHeaderColor", "tableHeaderTextColor", "tableStripeColor", "tableLineColor"] { assert!(serialized.get(field).is_none()); }
    for bad in [json!({"pageOrientation":"sideways"}), json!({"titleFontFamily":"remote"}), json!({"tableHeaderColor":"white"}), json!({"tableHeaderTextColor":"#abcdefg"}), json!({"tableStripeColor":"url(x)"}), json!({"tableLineColor":"#123"})] {
        assert!(serde_json::from_value::<Composition>(bad).unwrap().validate().is_err());
    }
}

#[test]
fn document_customization_landscape_paginates_and_keeps_payment_portrait() {
    let design: Composition = serde_json::from_value(json!({"pageOrientation":"landscape","titleFontFamily":"times","titleSize":30,"tableStyle":"striped","tableHeaderColor":"#182b49","tableStripeColor":"#eef3ef","tableLineColor":"#793c32"})).unwrap();
    let style = DocumentStyle { composition: Some(design), ..Default::default() };
    let mut writer = Composer::new(&style, None, "Entreprise", "Document test").unwrap();
    writer.heading("Document test").unwrap();
    assert!(writer.pages[0].iter().any(|op| op.operator == "Tf" && op.operands[0].as_name().unwrap() == b"C5" && op.operands[1].as_float().unwrap() == 30.));
    let rows: Vec<_> = (0..90).map(|i| (vec![format!("Prestation {i} {}", "Description détaillée ".repeat(20)), format!("{i}.00")], false)).collect();
    writer.table(&["Description", "Montant"], &[0.8,0.2], &rows).unwrap();
    writer.total("TOTAL", "CHF 540.50", true).unwrap();
    let expected_qr_ops = vec![Operation::new("re", vec![0.into(),0.into(),WIDTH.into(),297.into()])];
    writer.payment_page(expected_qr_ops.clone()).unwrap();
    assert!(writer.pages.last().unwrap().iter().any(|op| op.operator == "re" && op.operands == expected_qr_ops[0].operands));
    let (bytes, count) = writer.finish("Recette").unwrap();
    assert!(count > 3);
    let pdf = Document::load_mem(&bytes).unwrap();
    let pages = pdf.get_pages();
    for (number, id) in &pages {
        let bounds = pdf.get_object(*id).unwrap().as_dict().unwrap().get(b"MediaBox").unwrap().as_array().unwrap();
        let width = bounds[2].as_float().unwrap(); let height = bounds[3].as_float().unwrap();
        assert_eq!([width,height], if *number as usize == count { [WIDTH,HEIGHT] } else { [HEIGHT,WIDTH] });
        let ops = Content::decode(&pdf.get_page_content(*id).unwrap()).unwrap();
        let (mut position, mut font, mut size) = ((0.,0.), 0usize, 9.);
        for op in ops.operations {
            match op.operator.as_str() {
                "Tm" => position = (op.operands[4].as_float().unwrap(), op.operands[5].as_float().unwrap()),
                "Tf" => { font = std::str::from_utf8(op.operands[0].as_name().unwrap()).unwrap().trim_start_matches('C').parse().unwrap(); size = op.operands[1].as_float().unwrap(); },
                "Tj" => { let length: f32 = op.operands[0].as_str().unwrap().iter().map(|b| metrics::WIDTHS[font][*b as usize] as f32 * size / 1000.).sum(); assert!(position.0 >= 30. && position.0 + length <= width - 30.); assert!(position.1 >= 20. && position.1 <= height - 30.); },
                _ => {}
            }
        }
    }
    let text = pdf.extract_text(&pages.keys().copied().collect::<Vec<_>>()).unwrap();
    for i in 0..90 { assert!(text.contains(&format!("Prestation {i} "))); }
    assert!(text.contains("540.50"));
}

#[test]
fn document_customization_section_label_stays_with_following_text() {
    let style = DocumentStyle { composition: Some(Composition { page_orientation: Some("landscape".into()), ..Default::default() }), ..Default::default() };
    let mut writer = Composer::new(&style, None, "Entreprise", "Devis").unwrap();
    writer.y = writer.bottom + style.composition.as_ref().unwrap().line_spacing * 9. * 1.5;
    writer.paragraph("Remarques et conditions", 9., true).unwrap();
    writer.paragraph("Paiement selon les conditions convenues.", 9., false).unwrap();
    assert_eq!(writer.pages.len(), 2);
    let (bytes, _) = writer.finish("Recette").unwrap();
    let pdf = Document::load_mem(&bytes).unwrap();
    assert!(!pdf.extract_text(&[1]).unwrap().contains("Remarques et conditions"));
    let second = pdf.extract_text(&[2]).unwrap();
    assert!(second.contains("Remarques et conditions") && second.contains("Paiement selon les conditions convenues."));
}

#[test]
fn document_customization_all_four_exports_and_saved_settings_keep_new_options() {
    use crate::database::LocalStore;
    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temp.path().join("profile")).unwrap();
    let source = temp.path().join("logo.png");
    image::RgbImage::from_pixel(280, 64, image::Rgb([25,70,55])).save(&source).unwrap();
    let logo = store.stage_company_logo(source.to_str().unwrap()).unwrap();
    let issuer = json!({"company_name":"Atelier du Léman Sàrl","address_line1":"Rue du Lac 12","postal_code":"1000","city":"Lausanne","country":"CH","vat_registered":true,"uid_number":"CHE-123.456.789","vat_number":"CHE-123.456.789 TVA","logo_path":logo});
    let composition = json!({"pageOrientation":"landscape","fontFamily":"helvetica","titleFontFamily":"times","titleSize":30,"logoPosition":"right","tableStyle":"striped","tableHeaderColor":"#182b49","tableHeaderTextColor":"#ffffff","tableStripeColor":"#eef3ef","tableLineColor":"#b3c6bb","intro":[{"runs":[{"text":"Votre document sur mesure.","bold":true}]}],"closing":[{"runs":[{"text":"Merci de votre confiance.","italic":true}]}]});
    let mut designs = json!({});
    for kind in ["invoices","quotes","accounts","payslips"] {
        designs[kind] = composition.clone();
        let bytes = store.document_design_example(kind, json!({"composition":composition}), issuer.clone()).unwrap();
        let pdf = Document::load_mem(&bytes).unwrap();
        let pages = pdf.get_pages();
        let first_id = *pages.values().next().unwrap();
        let bounds = pdf.get_object(first_id).unwrap().as_dict().unwrap().get(b"MediaBox").unwrap().as_array().unwrap();
        assert_eq!(bounds[2].as_float().unwrap(), HEIGHT);
        let content = Content::decode(&pdf.get_page_content(first_id).unwrap()).unwrap();
        let text = pdf.extract_text(&pages.keys().copied().collect::<Vec<_>>()).unwrap();
        assert!(text.contains(match kind { "accounts" => "178'000.00", "payslips" => "5'336.00", _ => "540.50" }));
        assert!(text.contains("Votre document sur mesure."));
        assert!(text.contains("Merci de votre confiance."));
        assert!(content.operations.iter().any(|op| op.operator == "rg" && [0,1,2].map(|i| op.operands[i].as_float().unwrap()) == text_color("#182b49").unwrap()));
        if let Some(directory) = std::env::var_os("ZENTRA_CUSTOM_SAMPLES") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(std::path::Path::new(&directory).join(format!("{kind}-custom.pdf")), bytes).unwrap();
        }
    }
    store.connect().unwrap().execute("INSERT INTO settings(id,onboarding_completed,company_name,noga_section,noga_division,activity_description,created_at,updated_at) VALUES(1,1,'Entreprise test','F','43','Travaux spécialisés','2026-09-13T01:00:00Z','2026-09-13T01:00:00Z')", []).unwrap();
    let saved = store.update_settings(json!({"extra_settings_json":{"documentComposition":designs}})).unwrap();
    let extra: serde_json::Value = serde_json::from_str(saved["extra_settings_json"].as_str().unwrap()).unwrap();
    for kind in ["invoices","quotes","accounts","payslips"] { assert_eq!(extra["documentComposition"][kind], composition); }
}

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
fn document_layout_precision_values_survive_all_four_pdf_exports() {
    use crate::database::LocalStore;
    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temp.path().join("profile")).unwrap();
    let source = temp.path().join("logo.png");
    image::RgbImage::from_pixel(100, 100, image::Rgb([25, 70, 55])).save(&source).unwrap();
    let logo = store.stage_company_logo(source.to_str().unwrap()).unwrap();
    let issuer = json!({"company_name":"Atelier du Léman Sàrl","address_line1":"Rue du Lac 12","postal_code":"1000","city":"Lausanne","country":"CH","vat_registered":true,"uid_number":"CHE-123.456.789","vat_number":"CHE-123.456.789 TVA","logo_path":logo});
    let values = json!({"fontFamily":"times","bodySize":9.5,"titleSize":27,"marginMm":17.5,"lineSpacing":1.4,"logoPosition":"right","logoHeight":43,"tablePadding":7.5,"topMarginMm":22.5,"logoGap":17,"blockSpacing":1.15,"intro":[{"runs":[{"text":"Votre document sur mesure.","bold":true}]}],"closing":[{"runs":[{"text":"Merci pour votre confiance.","italic":true}]}]});
    let composition: Composition = serde_json::from_value(values.clone()).unwrap();
    composition.validate().unwrap();
    let serialized = serde_json::to_value(&composition).unwrap();
    for key in ["bodySize", "titleSize", "marginMm", "lineSpacing", "logoHeight", "tablePadding", "topMarginMm", "logoGap", "blockSpacing"] {
        assert!((serialized[key].as_f64().unwrap() - values[key].as_f64().unwrap()).abs() < 0.000001, "{key}");
    }
    for kind in ["quotes", "invoices", "accounts", "payslips"] {
        let bytes = store.document_design_example(kind, json!({"composition":values}), issuer.clone()).unwrap();
        let pdf = Document::load_mem(&bytes).unwrap();
        let pages = pdf.get_pages();
        let text = pdf.extract_text(&pages.keys().copied().collect::<Vec<_>>()).unwrap();
        assert!(text.contains("Votre document sur mesure."));
        assert!(text.contains("Merci pour votre confiance."));
        assert!(text.contains(match kind { "accounts" => "178'000.00", "payslips" => "5'336.00", _ => "540.50" }));
        let first = Content::decode(&pdf.get_page_content(*pages.values().next().unwrap()).unwrap()).unwrap();
        let mut matrix = None;
        let mut found_logo = false;
        for op in &first.operations {
            if op.operator == "cm" { matrix = Some(&op.operands); }
            if op.operator == "Do" && op.operands[0].as_name().is_ok_and(|name| name == b"Logo") {
                let transform = matrix.unwrap();
                assert!((transform[0].as_float().unwrap() - 43.).abs() < 0.01);
                assert!((transform[3].as_float().unwrap() - 43.).abs() < 0.01);
                assert!((transform[4].as_float().unwrap() - (WIDTH - 17.5 * 72. / 25.4 - 43.)).abs() < 0.01);
                found_logo = true;
            }
        }
        assert!(found_logo);
        if let Some(directory) = std::env::var_os("ZENTRA_PRECISION_SAMPLES") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(std::path::Path::new(&directory).join(format!("{kind}-precision.pdf")), bytes).unwrap();
        }
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
