//! Flow layout for user-designed documents. Business values come from the existing
//! validated/snapshotted data; templates contain presentation and plain rich text only.
use crate::{
    branding::PdfLogo,
    document_design::DocumentStyle,
    error::{AppError, AppResult},
};
use encoding_rs::WINDOWS_1252;
use lopdf::{
    content::{Content, Operation},
    dictionary, Document, Object, Stream,
};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};
#[path = "document_font_metrics.rs"]
mod metrics;
const WIDTH: f32 = 595.276;
const HEIGHT: f32 = 841.89;
const INK: [f32; 3] = [0.12, 0.14, 0.15];

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RichRun {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RichParagraph {
    pub runs: Vec<RichRun>,
    pub align: String,
    pub bullet: bool,
}
impl Default for RichParagraph {
    fn default() -> Self {
        Self {
            runs: vec![],
            align: "left".into(),
            bullet: false,
        }
    }
}
pub(crate) type RichText = Vec<RichParagraph>;
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Composition {
    pub version: u32,
    pub font_family: String,
    pub body_size: f32,
    pub title_size: f32,
    pub title_bold: bool,
    pub title_italic: bool,
    pub title_align: String,
    pub margin_mm: f32,
    pub line_spacing: f32,
    pub logo_position: String,
    pub logo_height: f32,
    pub table_style: String,
    pub table_padding: f32,
    pub totals_position: String,
    pub intro: RichText,
    pub closing: RichText,
    pub footer_text: RichText,
}
impl Default for Composition {
    fn default() -> Self {
        Self {
            version: 1,
            font_family: "helvetica".into(),
            body_size: 9.0,
            title_size: 24.0,
            title_bold: true,
            title_italic: false,
            title_align: "left".into(),
            margin_mm: 15.0,
            line_spacing: 1.35,
            logo_position: "left".into(),
            logo_height: 36.0,
            table_style: "band".into(),
            table_padding: 6.0,
            totals_position: "beforeNotes".into(),
            intro: vec![],
            closing: vec![],
            footer_text: vec![],
        }
    }
}
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn encoded(value: &str) -> AppResult<Vec<u8>> {
    let value = value
        .replace('\t', "    ")
        .replace('\u{202f}', " ")
        .replace('\u{00a0}', " ");
    let (bytes, _, error) = WINDOWS_1252.encode(&value);
    if error {
        return Err(invalid("Un caractère de votre texte n’existe pas dans la police PDF. Remplacez les emojis ou symboles inhabituels, puis réessayez."));
    }
    Ok(bytes.into_owned())
}
impl Composition {
    pub fn validate(&self) -> AppResult<()> {
        if self.version != 1
            || !["helvetica", "times", "courier"].contains(&self.font_family.as_str())
            || !["left", "center", "right"].contains(&self.title_align.as_str())
            || !["left", "center", "right", "hidden"].contains(&self.logo_position.as_str())
            || !["band", "striped", "lines"].contains(&self.table_style.as_str())
            || !["beforeNotes", "afterNotes"].contains(&self.totals_position.as_str())
            || ![
                (self.body_size, 8., 12.),
                (self.title_size, 18., 34.),
                (self.margin_mm, 12., 25.),
                (self.line_spacing, 1.15, 1.8),
                (self.logo_height, 24., 72.),
                (self.table_padding, 4., 10.),
            ]
            .iter()
            .all(|(v, a, b)| v.is_finite() && v >= a && v <= b)
        {
            return Err(invalid("Choisissez une police, une taille et une mise en page parmi les réglages proposés."));
        }
        for (text, limit) in [
            (&self.intro, 5000),
            (&self.closing, 5000),
            (&self.footer_text, 180),
        ] {
            let mut count = text.len().saturating_sub(1);
            if text.len() > 60 {
                return Err(invalid(
                    "Ce texte comporte trop de paragraphes (60 maximum).",
                ));
            }
            for p in text {
                if !["left", "center", "right"].contains(&p.align.as_str()) || p.runs.len() > 500 {
                    return Err(invalid("Mise en forme du texte invalide."));
                }
                for run in &p.runs {
                    count += run.text.chars().count();
                    if run
                        .text
                        .chars()
                        .any(|c| c.is_control() && c != '\n' && c != '\t')
                    {
                        return Err(invalid(
                            "Retirez les caractères de contrôle de votre texte.",
                        ));
                    }
                    encoded(&run.text)?;
                }
            }
            if count > limit {
                return Err(invalid(&format!("Ce texte dépasse la limite de {limit} caractères. Raccourcissez-le avant d’enregistrer.")));
            }
        }
        Ok(())
    }
    fn font(&self, bold: bool, italic: bool) -> usize {
        (match self.font_family.as_str() {
            "times" => 4,
            "courier" => 8,
            _ => 0,
        }) + usize::from(bold)
            + 2 * usize::from(italic)
    }
}
pub(crate) fn plain(value: &str) -> RichText {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(|s| RichParagraph {
            runs: vec![RichRun {
                text: s.into(),
                ..Default::default()
            }],
            ..Default::default()
        })
        .collect()
}
#[derive(Clone)]
struct Glyph {
    byte: u8,
    font: usize,
    underline: bool,
}
fn measure(line: &[Glyph], size: f32) -> f32 {
    line.iter()
        .map(|g| metrics::WIDTHS[g.font][g.byte as usize] as f32 * size / 1000.)
        .sum()
}
fn wrap(
    style: &Composition,
    text: &RichText,
    width: f32,
    size: f32,
) -> AppResult<Vec<(Vec<Glyph>, String, bool, bool)>> {
    let mut result = Vec::new();
    for paragraph in text {
        let mut glyphs = Vec::new();
        for run in &paragraph.runs {
            let font = style.font(run.bold, run.italic);
            glyphs.extend(encoded(&run.text)?.into_iter().map(|byte| Glyph {
                byte,
                font,
                underline: run.underline,
            }));
        }
        let available = width - if paragraph.bullet { size * 1.5 } else { 0. };
        let mut start = 0;
        let mut first = true;
        if glyphs.is_empty() {
            result.push((
                vec![],
                paragraph.align.clone(),
                paragraph.bullet,
                paragraph.bullet,
            ));
        }
        while start < glyphs.len() {
            let mut end = start;
            let mut last_space = None;
            let mut length = 0.;
            while end < glyphs.len() && glyphs[end].byte != b'\n' {
                let advance = measure(&glyphs[end..end + 1], size);
                if length + advance > available && end > start {
                    break;
                }
                length += advance;
                if glyphs[end].byte == b' ' {
                    last_space = Some(end);
                }
                end += 1;
            }
            let explicit = end < glyphs.len() && glyphs[end].byte == b'\n';
            let mut next = end;
            if !explicit && end < glyphs.len() {
                if let Some(space) = last_space.filter(|s| *s > start) {
                    end = space;
                    next = space + 1;
                }
            }
            result.push((
                glyphs[start..end].to_vec(),
                paragraph.align.clone(),
                paragraph.bullet && first,
                paragraph.bullet,
            ));
            first = false;
            start = if explicit { next + 1 } else { next };
        }
    }
    Ok(result)
}
fn rect(ops: &mut Vec<Operation>, x: f32, y: f32, w: f32, h: f32, color: [f32; 3]) {
    ops.extend([
        Operation::new("rg", color.into_iter().map(Object::from).collect()),
        Operation::new("re", vec![x.into(), y.into(), w.into(), h.into()]),
        Operation::new("f", vec![]),
    ]);
}
fn draw(ops: &mut Vec<Operation>, glyphs: &[Glyph], x: f32, y: f32, size: f32, color: [f32; 3]) {
    let mut offset = x;
    let mut start = 0;
    while start < glyphs.len() {
        let mut end = start + 1;
        while end < glyphs.len()
            && glyphs[end].font == glyphs[start].font
            && glyphs[end].underline == glyphs[start].underline
        {
            end += 1;
        }
        let run = &glyphs[start..end];
        ops.extend([
            Operation::new("BT", vec![]),
            Operation::new(
                "Tf",
                vec![
                    Object::Name(format!("C{}", run[0].font).into_bytes()),
                    size.into(),
                ],
            ),
            Operation::new("rg", color.into_iter().map(Object::from).collect()),
            Operation::new(
                "Tm",
                vec![
                    1.into(),
                    0.into(),
                    0.into(),
                    1.into(),
                    offset.into(),
                    y.into(),
                ],
            ),
            Operation::new(
                "Tj",
                vec![Object::String(
                    run.iter().map(|g| g.byte).collect(),
                    lopdf::StringFormat::Literal,
                )],
            ),
            Operation::new("ET", vec![]),
        ]);
        let width = measure(run, size);
        if run[0].underline {
            rect(
                ops,
                offset,
                y - size * 0.15,
                width,
                (size * 0.055).max(0.4),
                color,
            );
        }
        offset += width;
        start = end;
    }
}

pub(crate) struct Composer<'a> {
    pub pages: Vec<Vec<Operation>>,
    pub y: f32,
    pub style: &'a DocumentStyle,
    pub design: &'a Composition,
    logo: Option<&'a PdfLogo>,
    identity: String,
    title: String,
    payment_pages: Vec<usize>,
    footer: Vec<(Vec<Glyph>, String, bool, bool)>,
    bottom: f32,
}
impl<'a> Composer<'a> {
    pub fn new(
        style: &'a DocumentStyle,
        logo: Option<&'a PdfLogo>,
        identity: &str,
        title: &str,
    ) -> AppResult<Self> {
        let design = style
            .composition
            .as_ref()
            .ok_or_else(|| invalid("Présentation absente."))?;
        design.validate()?;
        let width = WIDTH - 2. * design.margin_mm * 72. / 25.4;
        let footer = wrap(
            design,
            &if design.footer_text.is_empty() {
                plain(&style.footer)
            } else {
                design.footer_text.clone()
            },
            width,
            8.,
        )?;
        if footer.len() > 4 {
            return Err(invalid(
                "Le pied de page dépasse quatre lignes. Raccourcissez-le ou réduisez les marges.",
            ));
        }
        let bottom = 42. + footer.len() as f32 * 11.;
        let mut result = Self {
            pages: vec![],
            y: 0.,
            style,
            design,
            logo: if design.logo_position == "hidden" {
                None
            } else {
                logo
            },
            identity: identity.into(),
            title: title.into(),
            payment_pages: vec![],
            footer,
            bottom,
        };
        result.page(true)?;
        Ok(result)
    }
    pub fn left(&self) -> f32 {
        self.design.margin_mm * 72. / 25.4
    }
    pub fn width(&self) -> f32 {
        WIDTH - 2. * self.left()
    }
    fn ops(&mut self) -> &mut Vec<Operation> {
        self.pages.last_mut().unwrap()
    }
    pub fn page(&mut self, first: bool) -> AppResult<()> {
        self.pages.push(vec![]);
        self.y = HEIGHT - self.left();
        if self.pages.len() > 200 {
            return Err(invalid(
                "Le document dépasse 200 pages. Réduisez son contenu avant de l’exporter.",
            ));
        }
        if self.style.layout == "signature" {
            let accent = self.style.accent();
            rect(self.ops(), 0., HEIGHT - 6., WIDTH, 6., accent);
        }
        if first {
            if self.design.logo_position != "hidden" {
                if let Some(logo) = self.logo {
                    let scale = (self.style.logo_width as f32 / logo.width as f32)
                        .min(self.design.logo_height / logo.height as f32);
                    let w = logo.width as f32 * scale;
                    let h = logo.height as f32 * scale;
                    let x = match self.design.logo_position.as_str() {
                        "center" => (WIDTH - w) / 2.,
                        "right" => WIDTH - self.left() - w,
                        _ => self.left(),
                    };
                    let y = self.y - h;
                    self.ops().extend([
                        Operation::new("q", vec![]),
                        Operation::new(
                            "cm",
                            vec![w.into(), 0.into(), 0.into(), h.into(), x.into(), y.into()],
                        ),
                        Operation::new("Do", vec![Object::Name(b"Logo".to_vec())]),
                        Operation::new("Q", vec![]),
                    ]);
                    self.y = y - 14.;
                }
            }
            self.paragraph(&self.identity.clone(), self.design.body_size + 2., true)?;
        } else {
            self.paragraph(
                &format!("{} · {} · suite", self.identity, self.title),
                9.,
                true,
            )?;
            self.gap(10.);
        }
        Ok(())
    }
    pub fn ensure(&mut self, height: f32) -> AppResult<()> {
        if self.y - height < self.bottom {
            self.page(false)?;
        }
        Ok(())
    }
    pub fn gap(&mut self, height: f32) {
        self.y -= height;
    }
    pub fn paragraph(&mut self, text: &str, size: f32, bold: bool) -> AppResult<()> {
        let mut value = plain(text);
        for p in &mut value {
            for r in &mut p.runs {
                r.bold = bold;
            }
        }
        self.rich_sized(&value, size, INK)
    }
    pub fn heading(&mut self, text: &str) -> AppResult<()> {
        let value = vec![RichParagraph {
            runs: vec![RichRun {
                text: text.into(),
                bold: self.design.title_bold,
                italic: self.design.title_italic,
                underline: false,
            }],
            align: self.design.title_align.clone(),
            bullet: false,
        }];
        self.gap(8.);
        self.rich_sized(&value, self.design.title_size, self.style.ink())?;
        self.gap(8.);
        Ok(())
    }
    pub fn rich(&mut self, text: &RichText) -> AppResult<()> {
        self.rich_sized(text, self.design.body_size, INK)
    }
    fn rich_sized(&mut self, text: &RichText, size: f32, color: [f32; 3]) -> AppResult<()> {
        let lines = wrap(self.design, text, self.width(), size)?;
        let leading = size * self.design.line_spacing;
        for (line, align, bullet, indent) in lines {
            self.ensure(leading)?;
            self.y -= size;
            let x = self.left()
                + match align.as_str() {
                    "center" => (self.width() - measure(&line, size)) / 2.,
                    "right" => self.width() - measure(&line, size),
                    _ => {
                        if indent {
                            size * 1.5
                        } else {
                            0.
                        }
                    }
                };
            let y = self.y;
            draw(self.ops(), &line, x, y, size, color);
            if bullet {
                let glyph = Glyph {
                    byte: 149,
                    font: self.design.font(false, false),
                    underline: false,
                };
                let left = self.left();
                draw(self.ops(), &[glyph], left, y, size, color);
            }
            self.y -= leading - size;
        }
        Ok(())
    }
    /// Rows wrap in every column and split at line boundaries on very long entries.
    pub fn table(
        &mut self,
        headers: &[&str],
        fractions: &[f32],
        rows: &[(Vec<String>, bool)],
    ) -> AppResult<()> {
        self.table_row(
            &headers.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            fractions,
            true,
            true,
            0,
        )?;
        for (index, (cells, bold)) in rows.iter().enumerate() {
            let size = self.design.body_size;
            let height = cells
                .iter()
                .zip(fractions)
                .map(|(s, f)| {
                    wrap(
                        self.design,
                        &plain(s),
                        self.width() * f - 2. * self.design.table_padding,
                        size,
                    )
                    .map(|l| l.len())
                })
                .collect::<AppResult<Vec<_>>>()?
                .into_iter()
                .max()
                .unwrap_or(1) as f32
                * size
                * self.design.line_spacing
                + self.design.table_padding;
            if self.y - height < self.bottom && height < HEIGHT - self.left() - self.bottom - 70. {
                self.page(false)?;
                self.table_row(
                    &headers.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                    fractions,
                    true,
                    true,
                    0,
                )?;
            }
            self.table_row(cells, fractions, *bold, false, index)?;
        }
        self.gap(12.);
        Ok(())
    }
    fn table_row(
        &mut self,
        cells: &[String],
        fractions: &[f32],
        bold: bool,
        header: bool,
        index: usize,
    ) -> AppResult<()> {
        let padding = self.design.table_padding;
        let vertical_padding = padding / 2.;
        let size = self.design.body_size;
        let leading = size * self.design.line_spacing;
        let wrapped = cells
            .iter()
            .zip(fractions)
            .map(|(s, f)| {
                let mut p = plain(s);
                for p in &mut p {
                    for r in &mut p.runs {
                        r.bold = bold;
                    }
                }
                wrap(self.design, &p, self.width() * f - padding * 2., size)
            })
            .collect::<AppResult<Vec<_>>>()?;
        let count = wrapped.iter().map(Vec::len).max().unwrap_or(1);
        let mut start = 0;
        while start < count {
            self.ensure(leading + 2. * vertical_padding)?;
            let available = ((self.y - self.bottom - 2. * vertical_padding) / leading)
                .floor()
                .max(1.) as usize;
            let end = (start + available).min(count);
            let height = (end - start) as f32 * leading + 2. * vertical_padding;
            let left = self.left();
            let width = self.width();
            let top = self.y;
            let band = header && self.design.table_style == "band";
            if band || header || self.design.table_style == "striped" && index % 2 == 0 {
                let color = if band {
                    self.style.accent()
                } else {
                    self.style.pale()
                };
                rect(self.ops(), left, top - height, width, height, color);
            }
            let color = if band { self.style.on_accent() } else { INK };
            let mut x = left;
            for (column, (lines, f)) in wrapped.iter().zip(fractions).enumerate() {
                for (row, (line, _, _, _)) in lines.iter().enumerate().take(end).skip(start) {
                    let cell_x = if column > 0 && (!header || cells.len() == 2) {
                        x + width * f - padding - measure(line, size)
                    } else {
                        x + padding
                    };
                    draw(
                        self.ops(),
                        line,
                        cell_x,
                        top - vertical_padding - size - (row - start) as f32 * leading,
                        size,
                        color,
                    );
                }
                x += width * f;
            }
            rect(
                self.ops(),
                left,
                top - height,
                width,
                0.4,
                [0.85, 0.87, 0.86],
            );
            self.y -= height;
            start = end;
            if start < count {
                self.page(false)?;
            }
        }
        Ok(())
    }
    pub fn total(&mut self, label: &str, value: &str, strong: bool) -> AppResult<()> {
        self.table_row(
            &[label.into(), value.into()],
            &[0.67, 0.33],
            strong,
            strong,
            1,
        )
    }
    /// Payment sections have separate fonts and fixed coordinates, unaffected by the template.
    pub fn payment_page(&mut self, mut ops: Vec<Operation>) -> AppResult<()> {
        self.page(false)?;
        self.paragraph("Section de paiement", 14., true)?;
        self.paragraph("À utiliser avec la facture correspondante. Le montant et la référence proviennent du document figé.",9.,false)?;
        self.payment_pages.push(self.pages.len() - 1);
        self.ops().append(&mut ops);
        Ok(())
    }
    pub fn finish(mut self, proof: &str) -> AppResult<(Vec<u8>, usize)> {
        let mut pdf = Document::with_version("1.7");
        let pages_id = pdf.new_object_id();
        let mut fonts = lopdf::Dictionary::new();
        for (i, name) in metrics::FONT_NAMES.iter().enumerate() {
            let id=pdf.add_object(dictionary!{"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>*name,"Encoding"=>"WinAnsiEncoding"});
            fonts.set(format!("C{i}"), id);
        }
        // Original Swiss QR renderer uses F1/F2; never substitute these.
        for (key, name) in [("F1", "Helvetica"), ("F2", "Helvetica-Bold")] {
            let id=pdf.add_object(dictionary!{"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>name,"Encoding"=>"WinAnsiEncoding"});
            fonts.set(key, id);
        }
        let mut resources = dictionary! {"Font"=>fonts};
        if let Some(logo) = self.logo {
            let id = crate::sales_pdf::add_logo_image(&mut pdf, logo);
            resources.set("XObject", dictionary! {"Logo"=>id});
        }
        let resources = pdf.add_object(resources);
        let count = self.pages.len();
        let left = self.left();
        let width = self.width();
        let mut kids = vec![];
        for (index, ops) in self.pages.iter_mut().enumerate() {
            let payment = self.payment_pages.contains(&index);
            let mut y = if payment {
                330. + self.footer.len() as f32 * 11.
            } else {
                self.bottom - 14.
            };
            for (line, align, bullet, indent) in &self.footer {
                let x = left
                    + match align.as_str() {
                        "center" => (width - measure(line, 8.)) / 2.,
                        "right" => width - measure(line, 8.),
                        _ => {
                            if *indent {
                                12.
                            } else {
                                0.
                            }
                        }
                    };
                draw(ops, line, x, y, 8., self.style.ink());
                if *bullet {
                    draw(
                        ops,
                        &[Glyph {
                            byte: 149,
                            font: self.design.font(false, false),
                            underline: false,
                        }],
                        left,
                        y,
                        8.,
                        self.style.ink(),
                    );
                }
                y -= 11.;
            }
            let footer = format!("Zentra · {}/{}", index + 1, count);
            let lines = wrap(self.design, &plain(&footer), width, 7.)?;
            draw(
                ops,
                &lines[0].0,
                left,
                if payment { 312. } else { 23. },
                7.,
                INK,
            );
            // Proof can be long: give it real lines, above content rather than clipping a footer.
            let stream = pdf.add_object(Stream::new(
                dictionary! {},
                Content {
                    operations: ops.clone(),
                }
                .encode()
                .map_err(|e| invalid(&e.to_string()))?,
            ));
            kids.push(Object::Reference(pdf.add_object(dictionary!{"Type"=>"Page","Parent"=>pages_id,"MediaBox"=>vec![0.into(),0.into(),WIDTH.into(),HEIGHT.into()],"Resources"=>resources,"Contents"=>stream})));
        }
        pdf.objects.insert(
            pages_id,
            dictionary! {"Type"=>"Pages","Kids"=>kids,"Count"=>count as i64}.into(),
        );
        let catalog = pdf.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
        let info=pdf.add_object(dictionary!{"Title"=>Object::string_literal(encoded(&self.title)?),"Author"=>Object::string_literal(encoded(&self.identity)?),"Creator"=>"Zentra","Subject"=>Object::string_literal(encoded(proof)?)});
        pdf.trailer.set("Root", catalog);
        pdf.trailer.set("Info", info);
        pdf.compress();
        let mut bytes = vec![];
        pdf.save_to(&mut bytes)?;
        Ok((bytes, count))
    }
}
pub(crate) fn write_pdf(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut file = tempfile::NamedTempFile::new_in(
        path.parent()
            .ok_or_else(|| invalid("Choisissez un dossier pour le PDF."))?,
    )?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| AppError::Io(e.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn document_composition_bullets_keep_their_hanging_indent_and_print_in_the_footer() {
        let design: Composition = serde_json::from_value(json!({"closing":[{"bullet":true,"runs":[{"text":"Une condition détaillée. ".repeat(20)}]}],"footerText":[{"bullet":true,"runs":[{"text":"Un pied de page en liste."}]}]})).unwrap();
        let lines = wrap(&design, &design.closing, 160., 10.).unwrap();
        assert!(lines.len() > 3);
        assert!(lines[0].2);
        assert!(lines.iter().skip(1).all(|line| !line.2));
        assert!(lines.iter().all(|line| line.3));
        let mut style = DocumentStyle::default();
        style.composition = Some(design.clone());
        let mut writer =
            Composer::new(&style, None, "Atelier du Léman", "Contrôle des listes").unwrap();
        let expected_left = writer.left() + design.body_size * 1.5;
        writer.rich(&design.closing).unwrap();
        let (bytes, _) = writer.finish("Contrôle").unwrap();
        let pdf = Document::load_mem(&bytes).unwrap();
        let content = Content::decode(
            &pdf.get_page_content(*pdf.get_pages().values().next().unwrap())
                .unwrap(),
        )
        .unwrap();
        let mut position = (0., 0.);
        let mut bullets = 0;
        let mut body_lines = 0;
        for op in content.operations {
            if op.operator == "Tm" {
                position = (
                    op.operands[4].as_float().unwrap(),
                    op.operands[5].as_float().unwrap(),
                );
            }
            if op.operator == "Tj" {
                let text = op.operands[0].as_str().unwrap();
                if text == [149] {
                    bullets += 1;
                }
                if text.starts_with(b"Une")
                    || text.starts_with(b"condition")
                    || text.starts_with(b"d\xe9taill\xe9e")
                {
                    assert!((position.0 - expected_left).abs() < 0.1);
                    body_lines += 1;
                }
            }
        }
        assert!(body_lines > 1);
        assert_eq!(bullets, 2, "one body bullet and one footer bullet");
        if let Some(directory) = std::env::var_os("ZENTRA_DESIGN_SAMPLES") {
            std::fs::write(Path::new(&directory).join("bullet-layout.pdf"), bytes).unwrap();
        }
    }
    #[test]
    fn composition_rejects_unknown_format_and_keeps_html_as_literal_text() {
        for value in [
            json!({"version":2}),
            json!({"bodySize":50}),
            json!({"marginMm":0}),
            json!({"fontFamily":"url(remote)"}),
            json!({"footerText":[{"runs":[{"text":"a".repeat(181)}]}]}),
            json!({"closing":[{"runs":[{"text":"😀"}]}]}),
        ] {
            let style: Composition = serde_json::from_value(value).unwrap();
            assert!(style.validate().is_err());
        }
        assert!(serde_json::from_value::<Composition>(json!({"html":"<script>"})).is_err());
        let style: Composition =
            serde_json::from_value(json!({"intro":[{"runs":[{"text":"<script>texte</script>"}]}]}))
                .unwrap();
        style.validate().unwrap();
        let legacy = json!({"extra_settings_json":json!({"documentAppearance":{"quotes":{"accentColor":"#182b49"}},"documentComposition":{"quotes":style}}).to_string()});
        let parsed = DocumentStyle::from_issuer(&legacy, "quotes").unwrap();
        assert!(parsed.composition.is_some());
        assert!(DocumentStyle::from_issuer(&legacy, "invoices")
            .unwrap()
            .composition
            .is_none());
    }
    #[test]
    fn long_documents_reflow_without_losing_rows_or_crossing_the_page_edges() {
        for family in ["helvetica", "times", "courier"] {
            let mut style = DocumentStyle::default();
            let mut design = Composition::default();
            design.font_family = family.into();
            design.body_size = 12.;
            design.title_size = 34.;
            design.margin_mm = 25.;
            design.line_spacing = 1.8;
            design.table_padding = 10.;
            design.intro = plain(&"Introduction détaillée avec un retour à la ligne.\n".repeat(12));
            design.closing =
                plain(&"Conditions complémentaires à conserver intégralement. ".repeat(45));
            design.footer_text = vec![RichParagraph {
                runs: vec![RichRun {
                    text: "Un pied de page personnalisé".into(),
                    bold: true,
                    italic: true,
                    underline: true,
                }],
                align: "center".into(),
                bullet: false,
            }];
            style.composition = Some(design.clone());
            let mut writer = Composer::new(
                &style,
                None,
                "Entreprise d’exemple avec un nom particulièrement long",
                "Document de contrôle",
            )
            .unwrap();
            writer
                .heading("Une présentation avec un titre long sur plusieurs lignes")
                .unwrap();
            writer.rich(&design.intro).unwrap();
            let rows = (0..80)
                .map(|i| {
                    (
                        vec![
                            format!(
                                "LIGNE-{i:03} - {}",
                                "Une description très complète. ".repeat(if i == 3 {
                                    70
                                } else {
                                    2
                                })
                            ),
                            format!("{i}.00"),
                        ],
                        false,
                    )
                })
                .collect::<Vec<_>>();
            writer
                .table(&["Description", "Montant CHF"], &[0.72, 0.28], &rows)
                .unwrap();
            writer.total("TOTAL TTC", "CHF 9'999.95", true).unwrap();
            writer.rich(&design.closing).unwrap();
            let (bytes, count) = writer.finish("Test sans écriture").unwrap();
            assert!(count > 3);
            let pdf = Document::load_mem(&bytes).unwrap();
            let text = pdf
                .extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
                .unwrap();
            for i in 0..80 {
                assert!(text.contains(&format!("LIGNE-{i:03}")), "{family}, row {i}");
            }
            assert!(text.contains("9'999.95"));
            assert!(text.contains("personnalisé"));
            for id in pdf.get_pages().values() {
                let content = Content::decode(&pdf.get_page_content(*id).unwrap()).unwrap();
                let mut font = 0usize;
                let mut size = 0.;
                let mut point = (0., 0.);
                for op in content.operations {
                    if op.operator == "Tf" {
                        let name = std::str::from_utf8(op.operands[0].as_name().unwrap()).unwrap();
                        font = name.trim_start_matches('C').parse().unwrap();
                        size = op.operands[1].as_float().unwrap();
                    }
                    if op.operator == "Tm" {
                        point = (
                            op.operands[4].as_float().unwrap(),
                            op.operands[5].as_float().unwrap(),
                        );
                        assert!(point.1 >= 20. && point.1 <= HEIGHT - 30.);
                    }
                    if op.operator == "Tj" {
                        let data = op.operands[0].as_str().unwrap();
                        let width = data
                            .iter()
                            .map(|b| metrics::WIDTHS[font][*b as usize] as f32 * size / 1000.)
                            .sum::<f32>();
                        assert!(
                            point.0 >= 0. && point.0 + width <= WIDTH - 30.,
                            "{family}: {}..{}",
                            point.0,
                            point.0 + width
                        );
                    }
                }
            }
            if let Some(directory) = std::env::var_os("ZENTRA_DESIGN_SAMPLES") {
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::write(
                    Path::new(&directory).join(format!("long-{family}.pdf")),
                    bytes,
                )
                .unwrap();
            }
        }
    }
}
