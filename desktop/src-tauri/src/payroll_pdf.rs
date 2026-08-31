use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use encoding_rs::WINDOWS_1252;
use lopdf::{
    content::{Content, Operation},
    dictionary, Document, Object, ObjectId, Stream, StringFormat,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::{
    branding::{load_pdf_logo, load_pdf_logo_with_fallback, PdfLogo},
    database::{query_all, row_to_json_public, LocalStore},
    error::{AppError, AppResult},
    models::GeneratePayslipPdfInput,
};

const PAGE_WIDTH: f32 = 595.28;
const PAGE_HEIGHT: f32 = 841.89;
const MARGIN: f32 = 42.0;
const NAVY: [f32; 3] = [0.047, 0.102, 0.173];
const BLUE: [f32; 3] = [0.102, 0.333, 0.878];
const PALE_BLUE: [f32; 3] = [0.929, 0.953, 1.0];
const INK: [f32; 3] = [0.075, 0.102, 0.145];
const MUTED: [f32; 3] = [0.365, 0.408, 0.475];
const LINE: [f32; 3] = [0.843, 0.867, 0.902];
const PALE: [f32; 3] = [0.969, 0.976, 0.988];
const GREEN: [f32; 3] = [0.059, 0.478, 0.333];
const GREEN_PALE: [f32; 3] = [0.918, 0.976, 0.949];
const AMBER: [f32; 3] = [0.714, 0.365, 0.0];
const AMBER_PALE: [f32; 3] = [1.0, 0.969, 0.878];

#[derive(Debug, Clone)]
struct PayslipPdfLine {
    label: String,
    kind: String,
    amount_cents: i64,
    detail: String,
}

#[derive(Debug, Clone)]
struct PayslipPdfData {
    company_name: String,
    logo_path: String,
    company_address: Vec<String>,
    uid_number: String,
    employee_name: String,
    employee_number: String,
    employee_role: String,
    employee_address: Vec<String>,
    avs_number: String,
    employee_iban: String,
    employment_rate: i64,
    period: String,
    payment_date: String,
    status: String,
    captured_at: String,
    notes: String,
    lines: Vec<PayslipPdfLine>,
    gross_cents: i64,
    deductions_cents: i64,
    reimbursements_cents: i64,
    net_cents: i64,
    employer_costs_cents: i64,
    final_document: bool,
}

impl LocalStore {
    pub fn generate_payslip_pdf(&self, input: GeneratePayslipPdfInput) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let destination = validate_pdf_destination(&input.destination_path)?;
        let data = load_payslip_data(&connection, input.payslip_id.trim())?;
        let page_count = render_payslip_pdf(
            &destination,
            &data,
            Some(self.attachments_dir.join("branding").as_path()),
        )?;
        Ok(json!({
            "path": destination.to_string_lossy(),
            "pages": page_count,
            "final_document": data.final_document,
            "status": data.status,
        }))
    }
}

fn validate_pdf_destination(raw_path: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(raw_path.trim());
    if raw_path.trim().is_empty() || !path.is_absolute() {
        return Err(AppError::Validation(
            "Choisissez un emplacement local absolu pour le PDF.".into(),
        ));
    }
    if path.extension().and_then(|value| value.to_str()) != Some("pdf") {
        return Err(AppError::Validation(
            "Le fichier de destination doit porter l’extension .pdf.".into(),
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        AppError::Validation("Le dossier de destination du PDF est invalide.".into())
    })?;
    if !parent.is_dir() {
        return Err(AppError::Validation(
            "Le dossier de destination du PDF n’existe pas.".into(),
        ));
    }
    Ok(path)
}

fn load_payslip_data(
    connection: &rusqlite::Connection,
    payslip_id: &str,
) -> AppResult<PayslipPdfData> {
    if payslip_id.is_empty() {
        return Err(AppError::Validation(
            "La fiche de salaire est obligatoire.".into(),
        ));
    }
    let payslip = connection
        .query_row(
            "SELECT * FROM payslips WHERE id=?",
            params![payslip_id],
            row_to_json_public,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("payslips/{payslip_id}")))?;
    let status = string_at(&payslip, "status");
    if !matches!(
        status.as_str(),
        "a_controler" | "valide" | "comptabilise" | "paye"
    ) {
        return Err(AppError::Validation(
            "La fiche doit d’abord être contrôlée avant de produire un PDF.".into(),
        ));
    }

    if matches!(status.as_str(), "comptabilise" | "paye") {
        let live_payment_date = string_at(&payslip, "payment_date");
        let snapshot = string_at(&payslip, "snapshot_json");
        if snapshot.is_empty() {
            return Err(AppError::Validation(
                "Le document comptabilisé ne contient pas son instantané figé.".into(),
            ));
        }
        let snapshot: Value = serde_json::from_str(&snapshot)?;
        let mut data = pdf_data_from_values(
            snapshot.get("issuer").unwrap_or(&Value::Null),
            snapshot.get("employee").unwrap_or(&Value::Null),
            snapshot.get("payslip").unwrap_or(&Value::Null),
            snapshot
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            snapshot
                .get("contributions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            string_at(&snapshot, "captured_at"),
            true,
        )?;
        data.status = status;
        // Financial and identity fields stay frozen at posting. The actual payment date is the
        // only later business event allowed by the immutable-payslip trigger, so a paid PDF must
        // display that audited live value instead of the earlier planned/snapshot date.
        if data.status == "paye" && !live_payment_date.is_empty() {
            data.payment_date = live_payment_date;
        }
        return Ok(data);
    }

    let issuer =
        connection.query_row("SELECT * FROM settings WHERE id=1", [], row_to_json_public)?;
    let employee = connection.query_row(
        "SELECT e.* FROM employees e JOIN payslips p ON p.employee_id=e.id WHERE p.id=?",
        params![payslip_id],
        row_to_json_public,
    )?;
    let items = query_all(
        connection,
        "SELECT * FROM payslip_items WHERE payslip_id=? ORDER BY position,rowid",
        params![payslip_id],
    )?;
    let contributions = query_all(
        connection,
        "SELECT * FROM payslip_contributions WHERE payslip_id=? ORDER BY rowid",
        params![payslip_id],
    )?;
    pdf_data_from_values(
        &issuer,
        &employee,
        &payslip,
        items,
        contributions,
        String::new(),
        false,
    )
}

fn pdf_data_from_values(
    issuer: &Value,
    employee: &Value,
    payslip: &Value,
    items: Vec<Value>,
    contributions: Vec<Value>,
    captured_at: String,
    final_document: bool,
) -> AppResult<PayslipPdfData> {
    let contribution_map: HashMap<String, &Value> = contributions
        .iter()
        .filter_map(|row| {
            let id = string_at(row, "payslip_item_id");
            (!id.is_empty()).then_some((id, row))
        })
        .collect();

    let lines: Vec<PayslipPdfLine> = items
        .iter()
        .map(|row| {
            let id = string_at(row, "id");
            let contribution = contribution_map.get(&id).copied();
            PayslipPdfLine {
                label: string_at(row, "label"),
                kind: string_at(row, "kind"),
                amount_cents: integer_at(row, "amount_cents"),
                detail: contribution.map(contribution_detail).unwrap_or_else(|| {
                    match string_at(row, "kind").as_str() {
                        "earning" => "Élément salarial contrôlé".into(),
                        "reimbursement" => "Remboursement de frais hors salaire brut".into(),
                        _ => "Montant saisi et contrôlé".into(),
                    }
                }),
            }
        })
        .collect();

    if lines.is_empty() {
        return Err(AppError::Validation(
            "La fiche ne contient aucune ligne salariale à exporter.".into(),
        ));
    }
    let gross_cents = lines
        .iter()
        .filter(|line| line.kind == "earning")
        .map(|line| line.amount_cents)
        .sum();
    let deductions_cents = lines
        .iter()
        .filter(|line| line.kind == "deduction")
        .map(|line| line.amount_cents)
        .sum();
    let reimbursements_cents = lines
        .iter()
        .filter(|line| line.kind == "reimbursement")
        .map(|line| line.amount_cents)
        .sum();
    let employer_costs_cents = lines
        .iter()
        .filter(|line| line.kind == "employer")
        .map(|line| line.amount_cents)
        .sum();

    let employee_name = string_at(employee, "name");
    let period = string_at(payslip, "period");
    if employee_name.is_empty() || period.is_empty() {
        return Err(AppError::Validation(
            "Le collaborateur ou la période manque dans la fiche.".into(),
        ));
    }

    let company_address = compact_lines([
        string_at(issuer, "address_line1"),
        string_at(issuer, "address_line2"),
        join_non_empty(
            &string_at(issuer, "postal_code"),
            &string_at(issuer, "city"),
        ),
    ]);
    let employee_address = compact_lines([
        string_at(employee, "address_line1"),
        string_at(employee, "address_line2"),
        join_non_empty(
            &string_at(employee, "postal_code"),
            &string_at(employee, "city"),
        ),
    ]);

    Ok(PayslipPdfData {
        company_name: string_at(issuer, "company_name"),
        logo_path: string_at(issuer, "logo_path"),
        company_address,
        uid_number: string_at(issuer, "uid_number"),
        employee_name,
        employee_number: string_at(employee, "employee_number"),
        employee_role: string_at(employee, "role"),
        employee_address,
        avs_number: string_at(employee, "social_security_number"),
        employee_iban: string_at(employee, "iban"),
        employment_rate: integer_at(employee, "employment_rate"),
        period,
        payment_date: string_at(payslip, "payment_date"),
        status: string_at(payslip, "status"),
        captured_at,
        notes: string_at(payslip, "notes"),
        lines,
        gross_cents,
        deductions_cents,
        reimbursements_cents,
        net_cents: gross_cents
            .saturating_add(reimbursements_cents)
            .saturating_sub(deductions_cents),
        employer_costs_cents,
        final_document,
    })
}

fn contribution_detail(row: &Value) -> String {
    let basis = format_money(integer_at(row, "basis_cents"));
    let calculation = if string_at(row, "calculation_kind") == "rate" {
        format!(
            "{} %",
            format_decimal(integer_at(row, "rate_bp") as f64 / 100.0)
        )
    } else {
        format!(
            "Fixe {}",
            format_money(integer_at(row, "fixed_amount_cents"))
        )
    };
    let source = string_at(row, "source");
    let source = if source.is_empty() {
        "source configurée".to_owned()
    } else {
        truncate(&source, 42)
    };
    format!("Base {basis} · {calculation} · {source}")
}

fn render_payslip_pdf(
    path: &Path,
    data: &PayslipPdfData,
    branding_dir: Option<&Path>,
) -> AppResult<usize> {
    let mut ordered_lines = Vec::with_capacity(data.lines.len());
    for kind in ["earning", "reimbursement", "deduction", "employer"] {
        ordered_lines.extend(data.lines.iter().filter(|line| line.kind == kind).cloned());
    }

    let chunks = paginate_payslip_lines(&ordered_lines);

    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let regular_font = add_font(&mut document, "Helvetica");
    let bold_font = add_font(&mut document, "Helvetica-Bold");
    let logo = branding_dir
        .and_then(|directory| load_pdf_logo_with_fallback(&data.logo_path, directory))
        .or_else(|| load_pdf_logo(&data.logo_path));
    let logo_object = logo
        .as_ref()
        .map(|image| add_logo_image(&mut document, image));
    let mut resources = dictionary! {
        "Font" => dictionary! {
            "F1" => regular_font,
            "F2" => bold_font,
        }
    };
    if let Some(logo_object) = logo_object {
        resources.set("XObject", dictionary! { "Logo" => logo_object });
    }
    let resources_id = document.add_object(resources);
    let total_pages = chunks.len();
    let mut page_ids = Vec::with_capacity(total_pages);

    for (index, chunk) in chunks.iter().enumerate() {
        let is_first = index == 0;
        let is_last = index + 1 == total_pages;
        let operations = render_page(
            data,
            chunk,
            index + 1,
            total_pages,
            is_first,
            is_last,
            logo.as_ref(),
        );
        let content = Content { operations }.encode().map_err(|error| {
            AppError::Validation(format!("Le contenu PDF est invalide : {error}"))
        })?;
        let content_id = document.add_object(Stream::new(dictionary! {}, content));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "MediaBox" => vec![0.into(), 0.into(), Object::Real(PAGE_WIDTH), Object::Real(PAGE_HEIGHT)],
            "Resources" => resources_id,
        });
        page_ids.push(page_id);
    }

    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => total_pages as i64,
        }),
    );
    let catalog_id = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    let info_id = document.add_object(dictionary! {
        "Title" => pdf_literal(&format!("Fiche de salaire {} — {}", data.period, data.employee_name)),
        "Author" => pdf_literal(&data.company_name),
        "Creator" => pdf_literal("Elyko — paie locale"),
        "Subject" => pdf_literal(if data.final_document { "Fiche de salaire comptabilisée" } else { "Aperçu de fiche de salaire à contrôler" }),
    });
    document.trailer.set("Root", catalog_id);
    document.trailer.set("Info", info_id);
    document.compress();

    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    document
        .save(&temporary)
        .map_err(|error| AppError::Validation(format!("Le PDF n’a pas pu être écrit : {error}")))?;
    if let Err(error) = replace_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(total_pages)
}

/// La hauteur d'une table dépend à la fois du nombre de rubriques et des
/// intertitres de catégories. Une limite fondée uniquement sur le nombre de
/// lignes faisait chevaucher les totaux dès qu'un bulletin contenait plusieurs
/// familles (gains, frais, retenues et charges employeur).
fn payroll_lines_height(lines: &[PayslipPdfLine]) -> f32 {
    let category_headings = lines
        .iter()
        .enumerate()
        .filter(|(index, line)| {
            *index == 0 || lines[*index - 1].kind.as_str() != line.kind.as_str()
        })
        .count();
    lines.len() as f32 * 21.0 + category_headings as f32 * 18.0
}

fn largest_fitting_prefix(lines: &[PayslipPdfLine], budget: f32) -> usize {
    (1..=lines.len())
        .take_while(|count| payroll_lines_height(&lines[..*count]) <= budget)
        .last()
        .unwrap_or(1)
}

fn balanced_split(lines: &[PayslipPdfLine], first_budget: f32, last_budget: f32) -> usize {
    (1..lines.len())
        .filter(|split| {
            payroll_lines_height(&lines[..*split]) <= first_budget
                && payroll_lines_height(&lines[*split..]) <= last_budget
        })
        .min_by_key(|split| {
            let left = payroll_lines_height(&lines[..*split]);
            let right = payroll_lines_height(&lines[*split..]);
            ((left - right).abs() * 100.0) as i64
        })
        .unwrap_or_else(|| largest_fitting_prefix(lines, first_budget).min(lines.len() - 1))
}

fn paginate_payslip_lines(lines: &[PayslipPdfLine]) -> Vec<Vec<PayslipPdfLine>> {
    const SINGLE_PAGE_BUDGET: f32 = 285.0;
    const FIRST_NON_FINAL_BUDGET: f32 = 420.0;
    const CONTINUATION_NON_FINAL_BUDGET: f32 = 600.0;
    const LAST_CONTINUATION_BUDGET: f32 = 465.0;

    if lines.is_empty() || payroll_lines_height(lines) <= SINGLE_PAGE_BUDGET {
        return vec![lines.to_vec()];
    }

    let mut chunks = Vec::new();
    let mut remaining = lines;
    while !remaining.is_empty() {
        if !chunks.is_empty() && payroll_lines_height(remaining) <= LAST_CONTINUATION_BUDGET {
            chunks.push(remaining.to_vec());
            break;
        }

        let budget = if chunks.is_empty() {
            FIRST_NON_FINAL_BUDGET
        } else {
            CONTINUATION_NON_FINAL_BUDGET
        };
        let fitting = largest_fitting_prefix(remaining, budget);
        let split = if fitting >= remaining.len() {
            balanced_split(remaining, budget, LAST_CONTINUATION_BUDGET)
        } else {
            fitting
        };
        chunks.push(remaining[..split].to_vec());
        remaining = &remaining[split..];
    }
    chunks
}

fn payslip_status_label(status: &str, final_document: bool) -> &'static str {
    match status {
        "paye" => "DOCUMENT FINAL · PAYÉ",
        "comptabilise" => "DOCUMENT FINAL · COMPTABILISÉ",
        _ if final_document => "DOCUMENT FINAL · FIGÉ",
        _ => "À CONTRÔLER · NON COMPTABILISÉ",
    }
}

fn replace_file(temporary: &Path, destination: &Path) -> AppResult<()> {
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    fs::rename(temporary, destination)?;
    Ok(())
}

fn add_font(document: &mut Document, base_font: &str) -> ObjectId {
    document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => base_font,
        "Encoding" => "WinAnsiEncoding",
    })
}

fn add_logo_image(document: &mut Document, logo: &PdfLogo) -> ObjectId {
    document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => i64::from(logo.width),
            "Height" => i64::from(logo.height),
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        },
        logo.rgb.clone(),
    ))
}

fn render_page(
    data: &PayslipPdfData,
    lines: &[PayslipPdfLine],
    page_number: usize,
    total_pages: usize,
    first: bool,
    last: bool,
    logo: Option<&PdfLogo>,
) -> Vec<Operation> {
    let mut ops = Vec::new();
    fill_rect(&mut ops, 0.0, PAGE_HEIGHT - 8.0, PAGE_WIDTH, 8.0, BLUE);
    let brand_text_x = if let Some(logo) = logo {
        let (width, height) = fitted_size(logo.width, logo.height, 72.0, 25.0);
        draw_image(&mut ops, "Logo", MARGIN, 786.0, width, height);
        MARGIN + width + 9.0
    } else {
        MARGIN
    };
    text(
        &mut ops,
        brand_text_x,
        798.0,
        9.0,
        "F2",
        BLUE,
        "ELYKO · PAIE LOCALE",
    );
    text_right(
        &mut ops,
        PAGE_WIDTH - MARGIN,
        805.0,
        8.5,
        "F1",
        MUTED,
        &format!("Page {page_number}/{total_pages}"),
    );

    let mut table_y;
    if first {
        text(
            &mut ops,
            MARGIN,
            763.0,
            23.0,
            "F2",
            NAVY,
            "FICHE DE SALAIRE",
        );
        text_right(
            &mut ops,
            PAGE_WIDTH - MARGIN,
            764.0,
            16.0,
            "F2",
            NAVY,
            &format_period(&data.period),
        );

        fill_rect(&mut ops, MARGIN, 666.0, 245.0, 73.0, PALE);
        label_value_block(
            &mut ops,
            MARGIN + 14.0,
            721.0,
            "EMPLOYEUR",
            &data.company_name,
            &data.company_address,
        );
        if !data.uid_number.is_empty() {
            text(
                &mut ops,
                MARGIN + 14.0,
                671.5,
                7.5,
                "F1",
                MUTED,
                &format!("IDE {}", data.uid_number),
            );
        }

        fill_rect(
            &mut ops,
            308.0,
            666.0,
            PAGE_WIDTH - MARGIN - 308.0,
            73.0,
            PALE_BLUE,
        );
        label_value_block(
            &mut ops,
            322.0,
            721.0,
            "COLLABORATEUR",
            &data.employee_name,
            &data.employee_address,
        );

        let status_label = payslip_status_label(&data.status, data.final_document);
        fill_rect(
            &mut ops,
            MARGIN,
            631.0,
            PAGE_WIDTH - 2.0 * MARGIN,
            23.0,
            if data.final_document {
                GREEN_PALE
            } else {
                AMBER_PALE
            },
        );
        text(
            &mut ops,
            MARGIN + 10.0,
            638.5,
            8.2,
            "F2",
            if data.final_document { GREEN } else { AMBER },
            status_label,
        );

        let meta = [
            ("N° employé", fallback(&data.employee_number)),
            ("Fonction", fallback(&data.employee_role)),
            ("Taux", format!("{} %", data.employment_rate.max(0))),
            ("N° AVS", fallback(&data.avs_number)),
            ("Paiement", format_date(&data.payment_date)),
        ];
        let cell_width = (PAGE_WIDTH - 2.0 * MARGIN) / meta.len() as f32;
        for (index, (label, value)) in meta.iter().enumerate() {
            let x = MARGIN + index as f32 * cell_width;
            stroke_rect(&mut ops, x, 582.0, cell_width, 38.0, LINE, 0.6);
            text(&mut ops, x + 8.0, 606.0, 6.8, "F2", MUTED, label);
            text(
                &mut ops,
                x + 8.0,
                591.0,
                8.0,
                "F2",
                INK,
                &truncate(value, 18),
            );
        }
        table_y = 554.0;
    } else {
        text(
            &mut ops,
            MARGIN,
            769.0,
            16.0,
            "F2",
            NAVY,
            "FICHE DE SALAIRE · SUITE",
        );
        text_right(
            &mut ops,
            PAGE_WIDTH - MARGIN,
            770.0,
            10.0,
            "F2",
            NAVY,
            &format!("{} · {}", data.employee_name, format_period(&data.period)),
        );
        table_y = 738.0;
    }

    fill_rect(
        &mut ops,
        MARGIN,
        table_y - 2.0,
        PAGE_WIDTH - 2.0 * MARGIN,
        22.0,
        NAVY,
    );
    text(
        &mut ops,
        MARGIN + 10.0,
        table_y + 5.0,
        7.5,
        "F2",
        [1.0, 1.0, 1.0],
        "ÉLÉMENT",
    );
    text(
        &mut ops,
        300.0,
        table_y + 5.0,
        7.5,
        "F2",
        [1.0, 1.0, 1.0],
        "BASE / CALCUL",
    );
    text_right(
        &mut ops,
        PAGE_WIDTH - MARGIN - 10.0,
        table_y + 5.0,
        7.5,
        "F2",
        [1.0, 1.0, 1.0],
        "MONTANT CHF",
    );
    table_y -= 22.0;

    let mut previous_kind = "";
    for line in lines {
        if line.kind != previous_kind {
            let heading = match line.kind.as_str() {
                "earning" => "RÉMUNÉRATION",
                "reimbursement" => "REMBOURSEMENTS HORS BRUT",
                "deduction" => "RETENUES EMPLOYÉ",
                "employer" => "COTISATIONS EMPLOYEUR · INFORMATIF",
                _ => "AUTRES ÉLÉMENTS",
            };
            fill_rect(
                &mut ops,
                MARGIN,
                table_y - 17.0,
                PAGE_WIDTH - 2.0 * MARGIN,
                18.0,
                PALE,
            );
            text(
                &mut ops,
                MARGIN + 10.0,
                table_y - 11.0,
                7.0,
                "F2",
                BLUE,
                heading,
            );
            table_y -= 18.0;
            previous_kind = &line.kind;
        }
        line_segment(
            &mut ops,
            MARGIN,
            table_y - 20.0,
            PAGE_WIDTH - 2.0 * MARGIN,
            0.45,
            LINE,
        );
        text(
            &mut ops,
            MARGIN + 10.0,
            table_y - 13.5,
            8.4,
            "F2",
            INK,
            &truncate(&line.label, 39),
        );
        text(
            &mut ops,
            300.0,
            table_y - 13.5,
            7.2,
            "F1",
            MUTED,
            &truncate(&line.detail, 46),
        );
        text_right(
            &mut ops,
            PAGE_WIDTH - MARGIN - 10.0,
            table_y - 13.5,
            8.4,
            "F2",
            INK,
            &format_amount(line.amount_cents),
        );
        table_y -= 21.0;
    }

    if last {
        render_totals(&mut ops, data);
    }
    render_footer(&mut ops, data, page_number, total_pages);
    ops
}

fn fitted_size(width: u32, height: u32, max_width: f32, max_height: f32) -> (f32, f32) {
    let width = width.max(1) as f32;
    let height = height.max(1) as f32;
    let scale = (max_width / width).min(max_height / height);
    (width * scale, height * scale)
}

fn draw_image(ops: &mut Vec<Operation>, name: &str, x: f32, y: f32, width: f32, height: f32) {
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new(
        "cm",
        vec![
            Object::Real(width),
            0.into(),
            0.into(),
            Object::Real(height),
            Object::Real(x),
            Object::Real(y),
        ],
    ));
    ops.push(Operation::new(
        "Do",
        vec![Object::Name(name.as_bytes().to_vec())],
    ));
    ops.push(Operation::new("Q", vec![]));
}

fn render_totals(ops: &mut Vec<Operation>, data: &PayslipPdfData) {
    fill_rect(ops, 290.0, 87.0, PAGE_WIDTH - MARGIN - 290.0, 130.0, PALE);
    total_row(ops, 305.0, 197.0, "Salaire brut", data.gross_cents, false);
    total_row(
        ops,
        305.0,
        177.0,
        "Remboursements hors brut",
        data.reimbursements_cents,
        false,
    );
    total_row(
        ops,
        305.0,
        157.0,
        "Retenues employé",
        data.deductions_cents,
        false,
    );
    total_row(
        ops,
        305.0,
        137.0,
        "Charges employeur",
        data.employer_costs_cents,
        false,
    );
    fill_rect(ops, 290.0, 87.0, PAGE_WIDTH - MARGIN - 290.0, 42.0, NAVY);
    text(
        ops,
        305.0,
        103.0,
        10.0,
        "F2",
        [1.0, 1.0, 1.0],
        "NET À PAYER",
    );
    text_right(
        ops,
        PAGE_WIDTH - MARGIN - 14.0,
        101.0,
        15.0,
        "F2",
        [1.0, 1.0, 1.0],
        &format_money(data.net_cents),
    );

    text(ops, MARGIN, 193.0, 7.0, "F2", MUTED, "VERSEMENT");
    text(
        ops,
        MARGIN,
        176.0,
        9.0,
        "F2",
        INK,
        &format!("Date : {}", format_date(&data.payment_date)),
    );
    text(
        ops,
        MARGIN,
        159.0,
        8.0,
        "F1",
        MUTED,
        "Compte du collaborateur",
    );
    text(
        ops,
        MARGIN,
        145.0,
        8.5,
        "F2",
        INK,
        &truncate(&fallback(&data.employee_iban), 36),
    );
    if !data.notes.trim().is_empty() {
        text(ops, MARGIN, 118.0, 7.0, "F2", MUTED, "REMARQUE");
        text(
            ops,
            MARGIN,
            103.0,
            7.5,
            "F1",
            INK,
            &truncate(data.notes.trim(), 55),
        );
    }
}

fn render_footer(
    ops: &mut Vec<Operation>,
    data: &PayslipPdfData,
    page_number: usize,
    total_pages: usize,
) {
    line_segment(ops, MARGIN, 63.0, PAGE_WIDTH - 2.0 * MARGIN, 0.6, LINE);
    let proof = if data.final_document {
        if data.captured_at.is_empty() {
            "Valeurs comptabilisées et figées localement".to_owned()
        } else {
            format!(
                "Valeurs comptabilisées et figées le {}",
                format_date_time(&data.captured_at)
            )
        }
    } else {
        "Aperçu local — contrôle humain obligatoire avant comptabilisation".to_owned()
    };
    text(ops, MARGIN, 46.0, 6.7, "F1", MUTED, &proof);
    text_right(
        ops,
        PAGE_WIDTH - MARGIN,
        46.0,
        6.7,
        "F1",
        MUTED,
        &format!("Elyko · {page_number}/{total_pages}"),
    );
}

fn total_row(ops: &mut Vec<Operation>, x: f32, y: f32, label: &str, cents: i64, strong: bool) {
    text(
        ops,
        x,
        y,
        8.0,
        if strong { "F2" } else { "F1" },
        MUTED,
        label,
    );
    text_right(
        ops,
        PAGE_WIDTH - MARGIN - 14.0,
        y,
        8.5,
        "F2",
        INK,
        &format_money(cents),
    );
}

fn label_value_block(
    ops: &mut Vec<Operation>,
    x: f32,
    y: f32,
    label: &str,
    value: &str,
    address: &[String],
) {
    text(ops, x, y, 6.8, "F2", MUTED, label);
    text(ops, x, y - 15.0, 10.0, "F2", INK, &truncate(value, 34));
    let mut address_y = y - 29.0;
    for line in address.iter().take(2) {
        text(ops, x, address_y, 7.4, "F1", MUTED, &truncate(line, 42));
        address_y -= 10.0;
    }
}

fn text(
    ops: &mut Vec<Operation>,
    x: f32,
    y: f32,
    size: f32,
    font: &str,
    color: [f32; 3],
    value: &str,
) {
    ops.push(Operation::new("BT", vec![]));
    ops.push(Operation::new(
        "Tf",
        vec![Object::Name(font.as_bytes().to_vec()), Object::Real(size)],
    ));
    ops.push(Operation::new(
        "rg",
        color.into_iter().map(Object::Real).collect(),
    ));
    ops.push(Operation::new(
        "Tm",
        vec![
            Object::Integer(1),
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(1),
            Object::Real(x),
            Object::Real(y),
        ],
    ));
    ops.push(Operation::new("Tj", vec![pdf_literal(value)]));
    ops.push(Operation::new("ET", vec![]));
}

fn text_right(
    ops: &mut Vec<Operation>,
    right: f32,
    y: f32,
    size: f32,
    font: &str,
    color: [f32; 3],
    value: &str,
) {
    let width = value.chars().count() as f32 * size * 0.52;
    text(
        ops,
        (right - width).max(MARGIN),
        y,
        size,
        font,
        color,
        value,
    );
}

fn fill_rect(ops: &mut Vec<Operation>, x: f32, y: f32, width: f32, height: f32, color: [f32; 3]) {
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new(
        "rg",
        color.into_iter().map(Object::Real).collect(),
    ));
    ops.push(Operation::new(
        "re",
        [x, y, width, height]
            .into_iter()
            .map(Object::Real)
            .collect(),
    ));
    ops.push(Operation::new("f", vec![]));
    ops.push(Operation::new("Q", vec![]));
}

fn stroke_rect(
    ops: &mut Vec<Operation>,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    color: [f32; 3],
    line_width: f32,
) {
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new(
        "RG",
        color.into_iter().map(Object::Real).collect(),
    ));
    ops.push(Operation::new("w", vec![Object::Real(line_width)]));
    ops.push(Operation::new(
        "re",
        [x, y, width, height]
            .into_iter()
            .map(Object::Real)
            .collect(),
    ));
    ops.push(Operation::new("S", vec![]));
    ops.push(Operation::new("Q", vec![]));
}

fn line_segment(
    ops: &mut Vec<Operation>,
    x: f32,
    y: f32,
    width: f32,
    line_width: f32,
    color: [f32; 3],
) {
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new(
        "RG",
        color.into_iter().map(Object::Real).collect(),
    ));
    ops.push(Operation::new("w", vec![Object::Real(line_width)]));
    ops.push(Operation::new("m", vec![Object::Real(x), Object::Real(y)]));
    ops.push(Operation::new(
        "l",
        vec![Object::Real(x + width), Object::Real(y)],
    ));
    ops.push(Operation::new("S", vec![]));
    ops.push(Operation::new("Q", vec![]));
}

fn pdf_literal(value: &str) -> Object {
    let normalized = normalize_pdf_text(value);
    let (encoded, _, _) = WINDOWS_1252.encode(&normalized);
    Object::String(encoded.into_owned(), StringFormat::Literal)
}

fn normalize_pdf_text(value: &str) -> String {
    value
        .replace('’', "'")
        .replace(['–', '—', '·'], "-")
        .replace('→', "->")
        .replace(['\n', '\r'], " ")
}

fn string_at(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn integer_at(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

fn compact_lines<const N: usize>(values: [String; N]) -> Vec<String> {
    values
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect()
}

fn join_non_empty(left: &str, right: &str) -> String {
    [left.trim(), right.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn fallback(value: &str) -> String {
    if value.trim().is_empty() {
        "Non renseigné".into()
    } else {
        value.trim().into()
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    let value = normalize_pdf_text(value.trim());
    if value.chars().count() <= max_chars {
        return value;
    }
    let mut result: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    result.push('…');
    result
}

fn format_money(cents: i64) -> String {
    format!("CHF {}", format_amount(cents))
}

fn format_amount(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let absolute = cents.unsigned_abs();
    let francs = absolute / 100;
    let decimals = absolute % 100;
    let digits = francs.to_string();
    let mut grouped = String::new();
    for (index, character) in digits.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            grouped.push('\'');
        }
        grouped.push(character);
    }
    let grouped: String = grouped.chars().rev().collect();
    format!("{sign}{grouped}.{decimals:02}")
}

fn format_decimal(value: f64) -> String {
    let mut formatted = format!("{value:.2}");
    while formatted.ends_with('0') {
        formatted.pop();
    }
    if formatted.ends_with('.') {
        formatted.pop();
    }
    formatted
}

fn format_period(period: &str) -> String {
    let Some((year, month)) = period.split_once('-') else {
        return fallback(period);
    };
    let month = match month {
        "01" => "janvier",
        "02" => "février",
        "03" => "mars",
        "04" => "avril",
        "05" => "mai",
        "06" => "juin",
        "07" => "juillet",
        "08" => "août",
        "09" => "septembre",
        "10" => "octobre",
        "11" => "novembre",
        "12" => "décembre",
        _ => return fallback(period),
    };
    format!("{month} {year}")
}

fn format_date(value: &str) -> String {
    let parts: Vec<_> = value.split('-').collect();
    if parts.len() == 3 {
        format!("{}.{}.{}", parts[2], parts[1], parts[0])
    } else if value.trim().is_empty() {
        "Non renseignée".into()
    } else {
        value.into()
    }
}

fn format_date_time(value: &str) -> String {
    format_date(value.split('T').next().unwrap_or(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_line(index: usize, kind: &str) -> PayslipPdfLine {
        PayslipPdfLine {
            label: format!("Rubrique {index}"),
            kind: kind.into(),
            amount_cents: 10_000 + index as i64,
            detail: "Montant contrôlé".into(),
        }
    }

    #[test]
    fn pagination_reserves_the_totals_area_even_with_many_category_headings() {
        let mut lines = Vec::new();
        for (kind, count) in [
            ("earning", 3),
            ("reimbursement", 3),
            ("deduction", 3),
            ("employer", 3),
        ] {
            for _ in 0..count {
                lines.push(sample_line(lines.len(), kind));
            }
        }

        assert!(payroll_lines_height(&lines) > 285.0);
        let chunks = paginate_payslip_lines(&lines);
        assert!(
            chunks.len() >= 2,
            "the totals must move to a continuation page"
        );
        assert_eq!(chunks.iter().map(Vec::len).sum::<usize>(), lines.len());
        assert!(payroll_lines_height(chunks.last().expect("last page")) <= 465.0);
    }

    #[test]
    fn paid_document_is_labelled_as_paid_not_only_posted() {
        assert_eq!(payslip_status_label("paye", true), "DOCUMENT FINAL · PAYÉ");
        assert_eq!(
            payslip_status_label("comptabilise", true),
            "DOCUMENT FINAL · COMPTABILISÉ"
        );
    }

    #[test]
    fn renders_a_parseable_professional_payslip() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let destination = std::env::var_os("ELYKO_SAMPLE_PDF")
            .map(PathBuf::from)
            .unwrap_or_else(|| directory.path().join("fiche.pdf"));
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).expect("create sample PDF directory");
        }
        let logo_path = directory.path().join("logo.png");
        image::DynamicImage::new_rgba8(96, 48)
            .save_with_format(&logo_path, image::ImageFormat::Png)
            .expect("write test logo");
        let data = PayslipPdfData {
            company_name: "Atelier Démo Sàrl".into(),
            logo_path: logo_path.to_string_lossy().into_owned(),
            company_address: vec!["Rue du Lac 8".into(), "1000 Lausanne".into()],
            uid_number: "CHE-123.456.789".into(),
            employee_name: "Élodie Exemple".into(),
            employee_number: "E-0042".into(),
            employee_role: "Cheffe de projet".into(),
            employee_address: vec!["Avenue du Test 12".into(), "1200 Genève".into()],
            avs_number: "756.1234.5678.97".into(),
            employee_iban: "CH93 0076 2011 6238 5295 7".into(),
            employment_rate: 80,
            period: "2026-08".into(),
            payment_date: "2026-08-25".into(),
            status: "comptabilise".into(),
            captured_at: "2026-08-25T10:30:00Z".into(),
            notes: "Paiement mensuel".into(),
            lines: vec![
                PayslipPdfLine {
                    label: "Salaire mensuel".into(),
                    kind: "earning".into(),
                    amount_cents: 650_000,
                    detail: "Élément salarial contrôlé".into(),
                },
                PayslipPdfLine {
                    label: "AVS / AI / APG".into(),
                    kind: "deduction".into(),
                    amount_cents: 34_450,
                    detail: "Base CHF 6'500.00 - 5.3 % - AVS 2026".into(),
                },
                PayslipPdfLine {
                    label: "Assurance-chômage".into(),
                    kind: "deduction".into(),
                    amount_cents: 7_150,
                    detail: "Base CHF 6'500.00 - 1.1 % - AC 2026".into(),
                },
                PayslipPdfLine {
                    label: "Part AVS employeur".into(),
                    kind: "employer".into(),
                    amount_cents: 34_450,
                    detail: "Base CHF 6'500.00 - 5.3 % - AVS 2026".into(),
                },
                PayslipPdfLine {
                    label: "Remboursement de frais".into(),
                    kind: "reimbursement".into(),
                    amount_cents: 20_000,
                    detail: "Remboursement de frais hors salaire brut".into(),
                },
            ],
            gross_cents: 650_000,
            deductions_cents: 41_600,
            reimbursements_cents: 20_000,
            net_cents: 628_400,
            employer_costs_cents: 34_450,
            final_document: true,
        };
        let pages = render_payslip_pdf(&destination, &data, None).expect("render payslip");
        assert_eq!(pages, 1);
        let bytes = fs::read(&destination).expect("read pdf");
        assert!(bytes.starts_with(b"%PDF-1.7"));
        assert!(bytes.len() > 2_000);
        let parsed = Document::load(&destination).expect("parse generated PDF");
        assert!(parsed.objects.values().any(|object| match object {
            Object::Stream(stream) =>
                stream.dict.get(b"Subtype").ok() == Some(&Object::Name(b"Image".to_vec())),
            _ => false,
        }));
    }

    #[test]
    fn paid_payslip_uses_the_audited_payment_date_over_the_posting_snapshot() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE payslips(
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    payment_date TEXT,
                    snapshot_json TEXT
                );",
            )
            .expect("payslip table");
        let snapshot = serde_json::json!({
            "captured_at":"2026-08-31T12:00:00Z",
            "issuer":{"company_name":"Entreprise test"},
            "employee":{"name":"Employé test"},
            "payslip":{
                "period":"2026-08",
                "payment_date":"2026-08-31",
                "status":"comptabilise",
                "notes":""
            },
            "items":[{
                "id":"salary-line",
                "label":"Salaire brut",
                "kind":"earning",
                "amount_cents":500000
            }],
            "contributions":[]
        });
        connection
            .execute(
                "INSERT INTO payslips(id,status,payment_date,snapshot_json) VALUES('paid-slip','paye','2026-09-02',?)",
                rusqlite::params![snapshot.to_string()],
            )
            .expect("paid payslip");

        let data = load_payslip_data(&connection, "paid-slip").expect("load paid payslip");
        assert_eq!(data.payment_date, "2026-09-02");
        assert_eq!(data.status, "paye");
        assert!(data.final_document);
    }
}
