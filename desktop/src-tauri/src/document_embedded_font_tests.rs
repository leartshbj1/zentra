use super::*;
use crate::database::LocalStore;
use serde_json::json;

fn embedded_names(pdf: &Document) -> Vec<String> {
    pdf.objects
        .values()
        .filter_map(|object| {
            let dictionary = object.as_dict().ok()?;
            (dictionary.get(b"Subtype").ok()?.as_name().ok()? == b"TrueType").then(|| {
                String::from_utf8(
                    dictionary
                        .get(b"BaseFont")
                        .unwrap()
                        .as_name()
                        .unwrap()
                        .to_vec(),
                )
                .unwrap()
            })
        })
        .collect()
}

#[test]
fn document_embedded_fonts_only_include_used_variants_and_preserve_legacy_resources() {
    let legacy = DocumentStyle {
        composition: Some(Composition::default()),
        ..Default::default()
    };
    let mut old = Composer::new(&legacy, None, "Atelier", "Ancien modèle").unwrap();
    old.heading("Ancien modèle").unwrap();
    assert!(
        embedded_names(&Document::load_mem(&old.finish("Test").unwrap().0).unwrap()).is_empty()
    );
    let design: Composition = serde_json::from_value(json!({"footerText":[{"runs":[{"text":"Œuvre · été, Zürich, cœur, 25 €","fontFamily":"literata","bold":true,"italic":true}]}]})).unwrap();
    let style = DocumentStyle {
        composition: Some(design),
        ..Default::default()
    };
    let mut writer = Composer::new(&style, None, "Atelier", "Polices intégrées").unwrap();
    writer.heading("Polices intégrées").unwrap();
    let (bytes, _) = writer.finish("Test").unwrap();
    let pdf = Document::load_mem(&bytes).unwrap();
    assert_eq!(embedded_names(&pdf), vec!["ZENTRA+Literata-BoldItalic"]);
    assert!(
        bytes.len() < 50_000,
        "one used font must not add every font file"
    );
    let text = pdf.extract_text(&[1]).unwrap();
    assert!(text.contains("Œuvre · été, Zürich, cœur, 25 €"), "{text}");
}

#[test]
fn document_embedded_fonts_keep_all_variants_searchable_and_use_real_widths() {
    let runs: Vec<_> = ["inter","literata"].iter().flat_map(|family| [false,true].into_iter().flat_map(move |italic| [false,true].into_iter().map(move |bold| json!({"text":format!("{family} {bold} {italic} : À bientôt, Zürich. "),"fontFamily":family,"bold":bold,"italic":italic})))).collect();
    let design: Composition =
        serde_json::from_value(json!({"fontFamily":"inter","intro":[{"runs":runs}]})).unwrap();
    let style = DocumentStyle {
        composition: Some(design),
        ..Default::default()
    };
    let mut writer = Composer::new(&style, None, "Atelier", "Variantes").unwrap();
    writer.heading("Variantes").unwrap();
    writer
        .rich(&style.composition.as_ref().unwrap().intro)
        .unwrap();
    let (bytes, _) = writer.finish("Test").unwrap();
    let pdf = Document::load_mem(&bytes).unwrap();
    assert_eq!(embedded_names(&pdf).len(), 8);
    // This deliberately uses all eight variants, each carrying the full OFL
    // notice. Normal documents embed fewer variants (checked separately).
    assert!(
        bytes.len() < 200_000,
        "all licensed variants: {} bytes",
        bytes.len()
    );
    eprintln!(
        "PDF with all eight licensed variants: {} bytes",
        bytes.len()
    );
    let text = pdf
        .extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
        .unwrap();
    for family in ["inter", "literata"] {
        for bold in [false, true] {
            for italic in [false, true] {
                assert!(
                    text.contains(&format!("{family} {bold} {italic}")),
                    "{text}"
                );
            }
        }
    }
    assert_ne!(font_width(12, b'W'), font_width(12, b'i'));
    assert_ne!(font_width(12, b'W'), font_width(0, b'W'));
    for object in pdf
        .objects
        .values()
        .filter_map(|object| object.as_dict().ok())
    {
        if object
            .get(b"Subtype")
            .is_ok_and(|v| v.as_name().is_ok_and(|n| n == b"TrueType"))
        {
            assert_eq!(
                object.get(b"Widths").unwrap().as_array().unwrap().len(),
                256
            );
            let descriptor = pdf
                .get_object(
                    object
                        .get(b"FontDescriptor")
                        .unwrap()
                        .as_reference()
                        .unwrap(),
                )
                .unwrap()
                .as_dict()
                .unwrap();
            let file = pdf
                .get_object(
                    descriptor
                        .get(b"FontFile2")
                        .unwrap()
                        .as_reference()
                        .unwrap(),
                )
                .unwrap()
                .as_stream()
                .unwrap();
            let contents = file.decompressed_content().unwrap();
            assert!(contents.starts_with(&[0, 1, 0, 0]));
            assert_eq!(
                contents.len() as i64,
                file.dict.get(b"Length1").unwrap().as_i64().unwrap()
            );
            assert!(object.get(b"ToUnicode").is_ok());
        }
    }
}

#[test]
fn document_embedded_fonts_persist_in_settings_and_preserve_all_four_financial_examples() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("profile");
    let store = LocalStore::initialize(path.clone()).unwrap();
    store.connect().unwrap().execute("INSERT INTO settings(id,onboarding_completed,company_name,noga_section,noga_division,activity_description,created_at,updated_at) VALUES(1,1,'Atelier','F','43','Travaux spécialisés','2026-09-13T01:00:00Z','2026-09-13T01:00:00Z')",[]).unwrap();
    let design = json!({"fontFamily":"inter","titleFontFamily":"literata","intro":[{"runs":[{"text":"Votre document sur mesure.","fontFamily":"inter"}]}],"closing":[{"runs":[{"text":"Merci de votre confiance.","fontFamily":"literata","italic":true}]}]});
    let library = json!([{"version":1,"id":"713a3d9d-e8da-4ca8-9b56-b0e02d3b3da3","name":"Mon modèle","sourceKind":"invoices","style":{"composition":design}}]);
    let extra = json!({"documentComposition":{"invoices":design,"quotes":design,"accounts":design,"payslips":design},"documentDesignTemplates":library});
    store
        .update_settings(json!({"extra_settings_json":extra}))
        .unwrap();
    drop(store);
    let store = LocalStore::initialize(path).unwrap();
    let stored: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT extra_settings_json FROM settings WHERE id=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let loaded: serde_json::Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(loaded["documentDesignTemplates"], library);
    assert_eq!(loaded["documentComposition"], extra["documentComposition"]);
    let issuer = json!({"company_name":"Atelier du Léman Sàrl","address_line1":"Rue du Lac 12","postal_code":"1000","city":"Lausanne","country":"CH","vat_registered":true,"uid_number":"CHE-123.456.789","vat_number":"CHE-123.456.789 TVA"});
    for family in ["inter", "literata"] {
        for kind in ["quotes", "invoices", "accounts", "payslips"] {
            let mut composition = design.clone();
            composition["fontFamily"] = json!(family);
            composition["closing"] = json!([{"numbered":true,"runs":[{"text":"Paiement selon les conditions convenues.","fontFamily":family,"bold":true}]},{"numbered":true,"runs":[{"text":"Merci de votre confiance.","fontFamily":family,"italic":true}]}]);
            let bytes = store
                .document_design_example(
                    kind,
                    json!({"composition":composition,"footer":"Atelier du Léman · Lausanne"}),
                    issuer.clone(),
                )
                .unwrap();
            let pdf = Document::load_mem(&bytes).unwrap();
            let text = pdf
                .extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
                .unwrap();
            for expected in match kind {
                "payslips" => vec!["5'336.00"],
                "accounts" => vec!["178'000.00", "20'000.00"],
                _ => vec!["540.50", "40.50"],
            } {
                assert!(text.contains(expected), "{kind}: {text}");
            }
            assert!(text.contains("EXEMPLE"));
            assert!(text.contains("Merci de votre confiance."));
            assert!(embedded_names(&pdf)
                .iter()
                .any(|name| name.to_lowercase().contains(family)));
            assert!(bytes.len() < 150_000);
            if let Some(folder) = std::env::var_os("ZENTRA_FONT_SAMPLES") {
                std::fs::create_dir_all(&folder).unwrap();
                std::fs::write(
                    Path::new(&folder).join(format!("{kind}-{family}.pdf")),
                    bytes,
                )
                .unwrap();
            }
        }
    }
    for table in ["quotes", "invoices", "payslips", "journal_entries"] {
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
