use crate::{
    branding::load_pdf_logo,
    database::{build_issuer_snapshot, now_iso, LocalStore},
    document_composition::{write_pdf, Composer, Composition},
    document_design::DocumentStyle,
    error::{command_error, AppError, AppResult},
    sales_pdf::validate_pdf_destination,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectReport {
    title: String,
    subtitle: String,
    sections: Vec<Section>,
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
    page.heading(&report.title)?;
    page.paragraph(&report.subtitle, 10., false)?;
    page.gap(16.);
    for section in &report.sections {
        page.paragraph(&section.title, 14., true)?;
        page.gap(8.);
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
                            "Aucune donnée enregistrée".into()
                        } else {
                            String::new()
                        }
                    })
                    .collect(),
                false,
            ));
        }
        page.table(&headers, &fractions, &rows)?;
        page.gap(14.);
    }
    page.finish(&format!("Zentra · Rapport de gestion · {}", now_iso()))
}

#[tauri::command]
pub fn export_project_report_pdf(
    state: State<'_, LocalStore>,
    report: ProjectReport,
    destination_path: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    let result = (|| -> AppResult<Value> {
        let path = validate_pdf_destination(&destination_path)?;
        let mut db = state.connect()?;
        state.require_onboarding(&db)?;
        let tx = db.transaction()?;
        let issuer = build_issuer_snapshot(&tx)?;
        tx.commit()?;
        let (bytes, pages) = render(&issuer, &report)?;
        write_pdf(&path, &bytes)?;
        Ok(json!({"path":path.to_string_lossy(),"pages":pages}))
    })();
    result.map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
