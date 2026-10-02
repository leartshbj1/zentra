use crate::{
    branding::load_pdf_logo,
    database::{build_issuer_snapshot, now_iso, LocalStore},
    document_composition::{write_pdf, Composer, Composition},
    document_design::DocumentStyle,
    error::{AppError, AppResult},
    sales_pdf::validate_pdf_destination,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectReport {
    #[serde(default)]
    language: ReportLanguage,
    title: String,
    subtitle: String,
    sections: Vec<Section>,
}
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ReportLanguage {
    #[default]
    Fr,
    De,
    It,
    En,
}
impl ReportLanguage {
    fn continuation(self) -> &'static str {
        match self {
            Self::Fr => "suite",
            Self::De => "Fortsetzung",
            Self::It => "continua",
            Self::En => "continued",
        }
    }
    fn empty(self) -> &'static str {
        match self {
            Self::Fr => "Aucune donnée enregistrée",
            Self::De => "Keine Daten erfasst",
            Self::It => "Nessun dato registrato",
            Self::En => "No data recorded",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Section {
    title: String,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

fn render(issuer: &Value, report: &ProjectReport) -> AppResult<(Vec<u8>, usize)> {
    if report.title.len() > 1000
        || report.subtitle.len() > 1000
        || report.sections.is_empty()
        || report.sections.len() > 5000
    {
        return Err(AppError::Validation("Choisissez les rubriques du rapport. Pour un très grand dossier, exportez les rubriques séparément.".into()));
    }
    let mut cells = 0;
    for section in &report.sections {
        if section.headers.is_empty()
            || section.headers.len() > 4
            || section.title.len() > 1000
            || section
                .rows
                .iter()
                .any(|row| row.len() != section.headers.len())
        {
            return Err(AppError::Validation(
                "La structure du rapport est invalide.".into(),
            ));
        }
        for value in section.headers.iter().chain(section.rows.iter().flatten()) {
            cells += value.len();
            if value.len() > 100_000 || cells > 8_000_000 {
                return Err(AppError::Validation(
                    "Ce rapport est trop volumineux. Exportez ses rubriques séparément.".into(),
                ));
            }
        }
    }
    let mut style = DocumentStyle::from_issuer(issuer, "accounts")?;
    // Reuse the company's typography, color and logo; keep business reports free of invoice-specific text.
    let mut composition = style.composition.take().unwrap_or_default();
    composition.intro.clear();
    composition.closing.clear();
    composition.title_size = 23.;
    composition.body_size = 9.;
    composition.table_style = Composition::default().table_style;
    style.composition = Some(composition);
    let name = issuer["company_name"].as_str().unwrap_or("Zentra");
    let logo = load_pdf_logo(issuer["logo_path"].as_str().unwrap_or(""));
    let mut page = Composer::new(&style, logo.as_ref(), name, &report.title)?;
    page.set_continuation_label(report.language.continuation());
    page.heading(&report.title)?;
    page.paragraph(&report.subtitle, 10., false)?;
    page.gap(16.);
    for section in &report.sections {
        let headers = section
            .headers
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let fractions = match headers.len() {
            1 => vec![1.],
            2 => vec![0.4, 0.6],
            3 => vec![0.5, 0.25, 0.25],
            _ => vec![0.4, 0.2, 0.2, 0.2],
        };
        let mut rows = section
            .rows
            .iter()
            .map(|row| (row.clone(), false))
            .collect::<Vec<_>>();
        if rows.is_empty() {
            rows.push((
                headers
                    .iter()
                    .enumerate()
                    .map(|(i, _)| {
                        if i == 0 {
                            report.language.empty().into()
                        } else {
                            String::new()
                        }
                    })
                    .collect(),
                false,
            ));
        }
        page.table_section(&section.title, &headers, &fractions, &rows)?;
        page.gap(14.);
    }
    page.finish(&format!("Zentra · {}", now_iso()))
}

#[tauri::command]
pub async fn export_project_report_pdf(
    state: State<'_, LocalStore>,
    report: ProjectReport,
    destination_path: String,
) -> Result<Value, String> {
    crate::commands::run_locked_local_operation(state.inner().clone(), move |store| {
        let path = validate_pdf_destination(&destination_path)?;
        let mut db = store.connect()?;
        store.require_onboarding(&db)?;
        let tx = db.transaction()?;
        let issuer = build_issuer_snapshot(&tx)?;
        tx.commit()?;
        let (bytes, pages) = render(&issuer, &report)?;
        write_pdf(&path, &bytes)?;
        Ok(json!({"path":path.to_string_lossy(),"pages":pages}))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_report_payloads_default_to_french_and_unknown_languages_are_rejected() {
        let payload = json!({"title":"Projet", "subtitle":"", "sections":[{"title":"Documents", "headers":["Fichier"], "rows":[]}]});
        let report: ProjectReport = serde_json::from_value(payload.clone()).unwrap();
        assert_eq!(report.language.continuation(), "suite");
        assert_eq!(report.language.empty(), "Aucune donnée enregistrée");
        for invalid in [json!("es"), json!("fr-CH"), json!(null), json!(42)] {
            let mut bad = payload.clone();
            bad["language"] = invalid;
            assert!(serde_json::from_value::<ProjectReport>(bad).is_err());
        }
    }
    #[test]
    fn report_language_reaches_every_continuation_page_without_translating_client_content() {
        for (language, label, empty, title, header) in [
            ("fr", "suite", "Aucune donnée enregistrée", "Documents", "Fichier"),
            ("de", "Fortsetzung", "Keine Daten erfasst", "Dokumente", "Datei"),
            ("it", "continua", "Nessun dato registrato", "Documenti", "File"),
            ("en", "continued", "No data recorded", "Documents", "File"),
        ] {
            let rows: Vec<Vec<String>> = (0..65).map(|i| vec![format!("CLIENT-{i:03}"), "Client text / Kundentext / Texte client".into()]).collect();
            let report: ProjectReport = serde_json::from_value(json!({
                "language":language, "title":"PROJET CLIENT", "subtitle":"REFERENCE-7500-CHF",
                "sections":[{"title":title, "headers":[header], "rows":[]},
                    {"title":"CLIENT CONTENT", "headers":["ID", "CLIENT"], "rows":rows}]
            })).unwrap();
            let (bytes, count) = render(&json!({"company_name":"CLIENT SA"}), &report).unwrap();
            assert!(count > 1);
            let pdf = lopdf::Document::load_mem(&bytes).unwrap();
            let pages: Vec<u32> = pdf.get_pages().keys().copied().collect();
            let all = pdf.extract_text(&pages).unwrap();
            assert!(all.contains(empty));
            assert!(all.contains("REFERENCE-7500-CHF"));
            for i in 0..65 { assert!(all.contains(&format!("CLIENT-{i:03}"))); }
            for number in pages.iter().skip(1) {
                let text = pdf.extract_text(&[*number]).unwrap();
                assert!(text.contains(label), "language {language}, page {number}");
                if language != "fr" { assert!(!text.contains("suite")); }
            }
            if language != "fr" { assert!(!all.contains("Aucune donnée enregistrée")); }
            if let Ok(directory) = std::env::var("ZENTRA_PROJECT_REPORT_LANGUAGE_DIR") {
                let directory = std::path::Path::new(&directory);
                std::fs::create_dir_all(directory).unwrap();
                std::fs::write(directory.join(format!("rapport-{language}.pdf")), bytes).unwrap();
            }
        }
    }
    #[test]
    fn project_report_keeps_long_rows_and_paginates() {
        let rows = (0..95)
            .map(|i| {
                vec![
                    format!(
                        "Prestation {i} · Étude et réalisation {}",
                        "avec suivi détaillé du projet ".repeat(5)
                    ),
                    "21.09.2026".into(),
                    "CHF 1’080.00".into(),
                ]
            })
            .collect();
        let report = ProjectReport {
            language: ReportLanguage::Fr,
            title: "Rénovation - Projet de démonstration".into(),
            subtitle: "Rapport de projet · Situation au 21.09.2026".into(),
            sections: vec![Section {
                title: "Factures et prestations".into(),
                headers: vec!["Objet".into(), "Date".into(), "Total".into()],
                rows,
            }],
        };
        let (bytes, count) =
            render(&json!({"company_name":"Zentra Démonstration SA"}), &report).unwrap();
        assert!(count > 3);
        let doc = lopdf::Document::load_mem(&bytes).unwrap();
        assert_eq!(doc.get_pages().len(), count);
        if let Ok(path) = std::env::var("ZENTRA_PROJECT_REPORT_SAMPLE") {
            std::fs::write(path, bytes).unwrap();
        }
    }
    #[test]
    fn malformed_columns_are_rejected() {
        let report = ProjectReport {
            language: ReportLanguage::Fr,
            title: "Projet".into(),
            subtitle: "".into(),
            sections: vec![Section {
                title: "Test".into(),
                headers: vec!["A".into()],
                rows: vec![vec!["A".into(), "B".into()]],
            }],
        };
        assert!(render(&json!({}), &report).is_err());
    }

    #[test]
    #[ignore = "Requires explicit synthetic frontend JSON and output paths"]
    fn render_frontend_report_fixture() {
        let input = std::env::var("ZENTRA_PROJECT_REPORT_JSON").expect("synthetic report input");
        let output = std::env::var("ZENTRA_PROJECT_REPORT_SAMPLE").expect("sample output");
        let report: ProjectReport = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
        let (bytes, count) = render(&json!({"company_name":"Zentra Démonstration SA"}), &report).unwrap();
        assert!(count > 0);
        let document = lopdf::Document::load_mem(&bytes).unwrap();
        assert_eq!(document.get_pages().len(), count);
        std::fs::write(output, bytes).unwrap();
    }
}
