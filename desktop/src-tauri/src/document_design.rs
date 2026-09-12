use crate::{
    database::LocalStore,
    error::{AppError, AppResult},
    sales_pdf::validate_pdf_destination,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DocumentStyle {
    pub accent_color: String,
    pub layout: String,
    pub logo_width: u32,
    pub footer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composition: Option<crate::document_composition::Composition>,
}
impl Default for DocumentStyle {
    fn default() -> Self {
        Self {
            accent_color: "#134d33".into(),
            layout: "signature".into(),
            logo_width: 88,
            footer: String::new(),
            composition: None,
        }
    }
}
impl DocumentStyle {
    pub fn validate(&self) -> AppResult<()> {
        if let Some(composition) = &self.composition { composition.validate()?; }
        if self.accent_color.len() != 7
            || !self.accent_color.starts_with('#')
            || !self.accent_color[1..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
            || !["signature", "minimal"].contains(&self.layout.as_str())
            || ![88, 120, 150].contains(&self.logo_width)
            || self.footer.chars().count() > 100
            || self.footer.chars().any(char::is_control)
            || encoding_rs::WINDOWS_1252.encode(&self.footer).2
        {
            return Err(AppError::Validation("Présentation invalide : choisissez une couleur, un modèle et un pied de page de 100 caractères maximum compatible avec le PDF.".into()));
        }
        Ok(())
    }
    pub fn accent(&self) -> [f32; 3] {
        [1, 3, 5].map(|start| {
            u8::from_str_radix(&self.accent_color[start..start + 2], 16).unwrap_or(0) as f32 / 255.0
        })
    }
    fn luminance(&self) -> f32 {
        self.accent()
            .map(|v| {
                if v <= 0.04045 {
                    v / 12.92
                } else {
                    ((v + 0.055) / 1.055).powf(2.4)
                }
            })
            .iter()
            .zip([0.2126, 0.7152, 0.0722])
            .map(|(v, w)| v * w)
            .sum()
    }
    pub fn ink(&self) -> [f32; 3] {
        self.accent()
            .map(|v| if self.luminance() > 0.18 { v * 0.45 } else { v })
    }
    pub fn on_accent(&self) -> [f32; 3] {
        if self.luminance() > 0.179 {
            [0.067; 3]
        } else {
            [1.0; 3]
        }
    }
    pub fn pale(&self) -> [f32; 3] {
        self.accent().map(|v| v * 0.08 + 0.92)
    }
    pub fn logo_height(&self) -> f32 {
        match self.logo_width {
            150 => 40.0,
            120 => 36.0,
            _ => 32.0,
        }
    }
    pub fn from_issuer(issuer: &Value, kind: &str) -> AppResult<Self> {
        let extra: Value =
            serde_json::from_str(issuer["extra_settings_json"].as_str().unwrap_or("{}"))?;
        let style = extra.pointer(&format!("/documentAppearance/{kind}"));
        let mut result: Self = match style {
            Some(v) if !v.is_null() => serde_json::from_value(v.clone())?,
            _ => Self::default(),
        };
        if let Some(value) = extra.pointer(&format!("/documentComposition/{kind}")) {
            result.composition = Some(serde_json::from_value(value.clone())?);
        }
        result.validate()?;
        Ok(result)
    }
}

pub(crate) fn validate_appearance(extra: &Value) -> AppResult<()> {
    if let Some(value) = extra.get("documentComposition") {
        let styles = value.as_object().ok_or_else(|| AppError::Validation("Présentation des documents invalide.".into()))?;
        for (kind, value) in styles {
            if !["quotes", "invoices", "accounts", "payslips"].contains(&kind.as_str()) { return Err(AppError::Validation("Type de document inconnu.".into())); }
            serde_json::from_value::<crate::document_composition::Composition>(value.clone())?.validate()?;
        }
    }
    if let Some(appearance) = extra.get("documentAppearance") {
        let styles = appearance
            .as_object()
            .ok_or_else(|| AppError::Validation("Présentation des documents invalide.".into()))?;
        for (kind, value) in styles {
            if !["quotes", "invoices", "accounts", "payslips"].contains(&kind.as_str()) {
                return Err(AppError::Validation("Type de document inconnu.".into()));
            }
            serde_json::from_value::<DocumentStyle>(value.clone())?.validate()?;
        }
    }
    Ok(())
}

impl LocalStore {
    /// The preview uses the same snapshot, validation and renderer as the exported file.
    /// Temporary PDF files are removed with the directory, including on errors.
    pub fn document_pdf_preview(&self, kind: &str, id: &str) -> AppResult<Vec<u8>> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("preview.pdf");
        let destination_path = path.to_string_lossy().into_owned();
        match kind {
            "quotes" | "invoices" => { self.generate_sales_document_pdf(crate::models::GenerateSalesDocumentPdfInput { entity:kind.into(), document_id:id.into(), destination_path })?; },
            "payslips" => { self.generate_payslip_pdf(crate::models::GeneratePayslipPdfInput { payslip_id:id.into(), destination_path })?; },
            _ => return Err(AppError::Validation("Type de document inconnu.".into())),
        }
        Ok(std::fs::read(path)?)
    }
    /// Exemples sans écriture comptable, sans numérotation et sans modification des réglages.
    pub fn document_design_example(
        &self,
        kind: &str,
        style: Value,
        mut issuer: Value,
    ) -> AppResult<Vec<u8>> {
        let design: DocumentStyle = serde_json::from_value(style)?;
        design.validate()?;
        if !["quotes", "invoices", "accounts", "payslips"].contains(&kind) {
            return Err(AppError::Validation("Type de document inconnu.".into()));
        }
        if !issuer.is_object() {
            return Err(AppError::Validation("Entreprise invalide.".into()));
        }
        issuer["extra_settings_json"] =
            Value::String(serde_json::json!({"documentAppearance":{kind:design}}).to_string());
        if let Some(path) = issuer["logo_path"].as_str().filter(|p| !p.is_empty()) {
            // Preview only registered assets inside this profile, never an arbitrary path.
            self.company_logo_preview(path)?;
        }
        if kind == "payslips" {
            crate::payroll_pdf::design_example(&issuer, &self.attachments_dir.join("branding"))
        } else if kind == "accounts" {
            crate::financial_pdf::design_example(&issuer)
        } else {
            crate::sales_pdf::design_example(&issuer, kind, &self.attachments_dir.join("branding"))
        }
    }
    pub fn export_document_design_example(
        &self,
        kind: &str,
        style: Value,
        issuer: Value,
        destination: &str,
    ) -> AppResult<String> {
        use std::io::Write;
        let path = validate_pdf_destination(destination)?;
        let bytes = self.document_design_example(kind, style, issuer)?;
        let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        file.persist(&path).map_err(|e| AppError::Io(e.error))?;
        Ok(path.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::Document;
    use serde_json::json;

    #[test]
    fn document_design_examples_embed_the_logo_preserve_totals_and_write_no_business_records() {
        let temp = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temp.path().join("profile")).unwrap();
        let source = temp.path().join("atelier.png");
        let mut image = image::RgbImage::from_pixel(280, 64, image::Rgb([245, 243, 235]));
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            if (12..52).contains(&x) && (12..52).contains(&y)
                || (68..266).contains(&x) && ((18..26).contains(&y) || (38..44).contains(&y))
            {
                *pixel = image::Rgb([30, 80, 54]);
            }
        }
        image.save(&source).unwrap();
        let logo = store.stage_company_logo(source.to_str().unwrap()).unwrap();
        assert!(store
            .company_logo_preview(&logo)
            .unwrap()
            .starts_with("data:image/png;base64,"));
        std::fs::remove_file(&source).unwrap();
        assert!(
            store.company_logo_preview(&logo).is_ok(),
            "original file can disappear after import"
        );
        let issuer = json!({"company_name":"Atelier du Léman Sàrl","legal_form":"Sàrl","address_line1":"Rue du Lac 12","postal_code":"1000","city":"Lausanne","country":"CH","vat_registered":true,"uid_number":"CHE-123.456.789","vat_number":"CHE-123.456.789 TVA","logo_path":logo});
        for kind in ["quotes", "invoices", "accounts", "payslips"] {
            for (layout, color, font) in [("signature", "#182b49", ""), ("minimal", "#d7b878", ""), ("signature", "#182b49", "helvetica"), ("minimal", "#d7b878", "times"), ("minimal", "#182b49", "courier")] {
                let mut style = json!({"accentColor":color,"layout":layout,"logoWidth":150,"footer":"Merci pour votre confiance."});
                if !font.is_empty() { style["composition"] = json!({"version":1,"fontFamily":font,"logoPosition":if font=="times"{"center"}else{"right"},"bodySize":if font=="courier"{12}else{9},"marginMm":if font=="courier"{25}else{15},"titleSize":28,"titleItalic":true,"tableStyle":"striped","intro":[{"runs":[{"text":"Une présentation "},{"text":"personnalisée","bold":true,"italic":true,"underline":true}]}],"closing":[{"bullet":true,"align":"left","runs":[{"text":"Première condition : paiement selon accord.","bold":true}]},{"align":"right","runs":[{"text":"Une seconde ligne de conditions."}]}]}); }
                let bytes = store
                    .document_design_example(kind, style, issuer.clone())
                    .unwrap();
                let pdf = Document::load_mem(&bytes).unwrap();
                let text = pdf
                    .extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
                    .unwrap();
                assert!(text.contains("Merci pour votre confiance."));
                assert!(text.contains("EXEMPLE"));
                assert!(pdf
                    .objects
                    .values()
                    .any(|object| object
                        .as_stream()
                        .is_ok_and(|stream| stream.dict.get(b"Subtype").is_ok_and(|value| value
                            .as_name()
                            .is_ok_and(|name| name == b"Image")))));
                if kind == "payslips" {
                    assert!(text.contains("5'336.00"));
                } else if kind != "accounts" {
                    assert!(text.contains("540.50"));
                    assert!(text.contains("40.50"));
                } else {
                    assert!(text.contains("178'000.00"));
                    assert!(text.contains("20'000.00"));
                }
                if let Some(directory) = std::env::var_os("ZENTRA_DESIGN_SAMPLES") {
                    std::fs::create_dir_all(&directory).unwrap();
                    std::fs::write(
                        std::path::Path::new(&directory).join(if font.is_empty(){format!("{kind}-{layout}.pdf")}else{format!("{kind}-{font}.pdf")}),
                        bytes,
                    )
                    .unwrap();
                }
            }
        }
        let connection = store.connect().unwrap();
        for table in ["quotes", "invoices", "journal_entries", "settings"] {
            assert_eq!(
                connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert!(store
            .company_logo_preview(source.to_str().unwrap())
            .is_err());
        std::fs::write(&logo, b"corrupted").unwrap();
        assert!(store.company_logo_preview(&logo).is_err());
        assert!(store
            .document_design_example("invoices", json!({}), issuer)
            .is_err());
    }

    #[test]
    fn document_design_rejects_invalid_colors_and_unprintable_footer_without_panicking() {
        for value in [
            json!({"accentColor":"#éabcd"}),
            json!({"accentColor":"red"}),
            json!({"logoWidth":999}),
            json!({"layout":"invalid"}),
            json!({"footer":"emoji 😀"}),
            json!({"footer":"a\nb"}),
        ] {
            let style: DocumentStyle = serde_json::from_value(value).unwrap();
            assert!(style.validate().is_err());
        }
        let style: DocumentStyle =
            serde_json::from_value(json!({"accentColor":"#ffffff"})).unwrap();
        style.validate().unwrap();
        assert_eq!(style.on_accent(), [0.067; 3]);
        assert_eq!(style.ink(), [0.45; 3]);
    }
}
