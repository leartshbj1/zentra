use super::*;

fn composed_issuer(family: &str, orientation: &str, size: f32, intro_lines: usize) -> Value {
    let (mut issuer, _, _) = example_reports();
    issuer["extra_settings_json"] = json!(json!({
        "documentAppearance":{"accounts":{"accentColor":"#225944","layout":"signature"}},
        "documentComposition":{"accounts":{
            "version":1,"fontFamily":family,"titleFontFamily":"inter",
            "bodySize":size,"titleSize":26,"marginMm":15,"lineSpacing":1.35,
            "tablePadding":6,"tableStyle":"striped","pageOrientation":orientation,
            "intro":[{"runs":[{"text":"Informations complémentaires.\n".repeat(intro_lines)}]}]
        }}
    }).to_string());
    issuer
}

fn page_texts(bytes: &[u8]) -> Vec<String> {
    let pdf = Document::load_mem(bytes).unwrap();
    pdf.get_pages().keys().map(|page| pdf.extract_text(&[*page]).unwrap()).collect()
}

fn assert_section_with_content(pages: &[String], section: &str, first: &str, case: &str) {
    let matches = pages.iter().filter(|page| page.lines().any(|line| line.trim() == section)).collect::<Vec<_>>();
    assert_eq!(matches.len(), 1, "{case}: section {section} missing or repeated");
    assert!(matches[0].contains(first), "{case}: {section} is separated from {first}");
}

#[test]
fn account_section_labels_stay_with_first_account_across_page_sizes_and_fonts() {
    let (_, balance, income) = example_reports();
    for family in ["inter", "literata"] {
        for orientation in ["portrait", "landscape"] {
            for size in [9., 12.] {
                for intro_lines in 0..7 {
                    let case = format!("{family}-{orientation}-{size}-{intro_lines}");
                    let issuer = composed_issuer(family, orientation, size, intro_lines);
                    let (bytes, _) = render_accounts_pdf(&issuer, &balance, &income, false, "EXEMPLE").unwrap();
                    let pages = page_texts(&bytes);
                    let closing_page = pages.iter().find(|page| page.contains("Contrôle : actifs = passifs")).unwrap();
                    assert!(closing_page.contains("TOTAL PASSIFS"), "{case}: balance check orphaned on its own page");
                    for (section, first) in [
                        ("Actifs circulants", "1020"), ("Actifs immobilisés", "1500"),
                        ("Dettes à court terme", "2000"), ("Dettes à long terme", "2450"),
                        ("Fonds propres", "2800"), ("Chiffre d’affaires net", "3000"),
                        ("Achats et coût des marchandises", "4000"), ("Charges de personnel", "5000"),
                        ("Autres charges d’exploitation", "6000"), ("Amortissements", "6800"),
                        ("Résultat financier", "6900"), ("Impôts directs", "8900"),
                    ] { assert_section_with_content(&pages, section, first, &case); }
                    let all = pages.join("\n");
                    for total in ["178'000.00", "150'000.00", "20'000.00", "12'000.00"] {
                        assert!(all.contains(total), "{case}: lost {total}");
                    }
                    if intro_lines == 4 {
                        if let Some(directory) = std::env::var_os("ZENTRA_DESIGN_SAMPLES") {
                            std::fs::create_dir_all(&directory).unwrap();
                            std::fs::write(std::path::Path::new(&directory).join(format!("accounts-grouped-{case}.pdf")), bytes).unwrap();
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn account_sections_with_long_rows_and_empty_sections_keep_all_content() {
    let issuer = composed_issuer("literata", "landscape", 12., 4);
    let (_, mut balance, income) = example_reports();
    balance["rows"][0]["name"] = json!(format!("DEBUT-LONG {} FIN-LONG", "Description comptable complète. ".repeat(400)));
    balance["rows"].as_array_mut().unwrap().retain(|row| string(row,"report_section") != "equity");
    for index in 0..80 {
        balance["rows"].as_array_mut().unwrap().push(row(&format!("R{index:03}"), "Compte de recette supplémentaire", "current_assets", index, index));
    }
    let (bytes, _) = render_accounts_pdf(&issuer, &balance, &income, false, "EXEMPLE").unwrap();
    let pages = page_texts(&bytes);
    assert!(pages.len() > 4);
    assert_section_with_content(&pages, "Actifs circulants", "1020", "long row");
    assert_section_with_content(&pages, "Fonds propres", "Total Fonds propres", "empty section");
    let all = pages.join("\n");
    assert!(all.contains("DEBUT-LONG") && all.contains("FIN-LONG"));
    for page in &pages {
        if page.contains("Description comptable") || page.contains("FIN-LONG") {
            assert!(page.contains("Comptes / libellés"), "Continued row lost its column headings");
        }
    }
    for index in 0..80 { assert!(all.contains(&format!("R{index:03}"))); }
    if let Some(directory) = std::env::var_os("ZENTRA_DESIGN_SAMPLES") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(std::path::Path::new(&directory).join("accounts-grouped-long.pdf"), bytes).unwrap();
    }
}
