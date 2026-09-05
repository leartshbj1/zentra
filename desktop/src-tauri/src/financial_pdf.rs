use crate::{
    accounting_closure::{balance_sheet_report, income_statement_report},
    database::{build_issuer_snapshot, now_iso, LocalStore},
    error::{AppError, AppResult},
    models::PeriodFilter,
    sales_pdf::{helvetica_text_width, validate_pdf_destination, wrap_text_width},
};
use encoding_rs::WINDOWS_1252;
use lopdf::{
    content::{Content, Operation},
    dictionary, Document, Object, Stream,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;

const LEFT: f32 = 42.0;
const RIGHT: f32 = 553.0;
const FIRST_AMOUNT: f32 = 438.0;
const INK: [f32; 3] = [0.09, 0.15, 0.12];
const GREEN: [f32; 3] = [0.08, 0.30, 0.21];

impl LocalStore {
    pub fn export_annual_accounts_pdf(
        &self,
        filter: PeriodFilter,
        destination: &str,
    ) -> AppResult<Value> {
        let destination = validate_pdf_destination(destination)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction()?;
        let balance = balance_sheet_report(&transaction, &filter)?;
        let income = income_statement_report(&transaction, &filter)?;
        let issuer = build_issuer_snapshot(&transaction)?;
        let closed: bool = transaction
            .query_row(
                "SELECT status='closed' FROM accounting_periods WHERE date_from=? AND date_to=?",
                params![
                    balance["scope"]["date_from"].as_str(),
                    balance["scope"]["date_to"].as_str()
                ],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(false);
        let captured_at = now_iso();
        let (bytes, pages) = render_accounts_pdf(&issuer, &balance, &income, closed, &captured_at)?;
        transaction.commit()?;
        let mut temporary = tempfile::NamedTempFile::new_in(destination.parent().unwrap())?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&destination)
            .map_err(|error| AppError::Io(error.error))?;
        Ok(
            json!({"path":destination.to_string_lossy(),"pages":pages,"closed":closed,
            "balanced":balance["balanced"],"sha256":format!("{:x}",Sha256::digest(&bytes))}),
        )
    }
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn amount(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap_or(0)
}
fn money(cents: i64) -> String {
    let magnitude = i128::from(cents).abs();
    let digits = (magnitude / 100).to_string();
    let mut grouped = String::new();
    for (index, character) in digits.chars().enumerate() {
        if index != 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push('\'');
        }
        grouped.push(character);
    }
    format!(
        "{}{grouped}.{:02}",
        if cents < 0 { "-" } else { "" },
        magnitude % 100
    )
}
fn text(
    ops: &mut Vec<Operation>,
    value: &str,
    x: f32,
    y: f32,
    size: f32,
    bold: bool,
    color: [f32; 3],
) -> AppResult<()> {
    let (bytes, _, invalid) = WINDOWS_1252.encode(value);
    if invalid {
        return Err(AppError::Validation("Un libellé contient des caractères non pris en charge par le PDF. Corrigez-le avant export; aucun caractère ne sera supprimé.".into()));
    }
    ops.extend([
        Operation::new("BT", vec![]),
        Operation::new(
            "Tf",
            vec![
                Object::Name(if bold { b"F2".to_vec() } else { b"F1".to_vec() }),
                size.into(),
            ],
        ),
        Operation::new("rg", color.into_iter().map(Object::from).collect()),
        Operation::new("Td", vec![x.into(), y.into()]),
        Operation::new("Tj", vec![Object::string_literal(bytes.into_owned())]),
        Operation::new("ET", vec![]),
    ]);
    Ok(())
}
fn rule(ops: &mut Vec<Operation>, y: f32) {
    ops.extend([
        Operation::new("RG", vec![0.80.into(), 0.85.into(), 0.82.into()]),
        Operation::new("w", vec![0.5.into()]),
        Operation::new("m", vec![LEFT.into(), y.into()]),
        Operation::new("l", vec![RIGHT.into(), y.into()]),
        Operation::new("S", vec![]),
    ]);
}

struct PageWriter<'a> {
    pages: Vec<Vec<Operation>>,
    y: f32,
    issuer: &'a Value,
    report: &'a Value,
    title: &'a str,
    closed: bool,
}
impl<'a> PageWriter<'a> {
    fn new(issuer: &'a Value, report: &'a Value, title: &'a str, closed: bool) -> AppResult<Self> {
        let mut writer = Self {
            pages: Vec::new(),
            y: 0.0,
            issuer,
            report,
            title,
            closed,
        };
        writer.next_page()?;
        Ok(writer)
    }
    fn next_page(&mut self) -> AppResult<()> {
        let mut ops = Vec::new();
        let mut y = 793.0;
        for line in wrap_text_width(string(self.issuer, "company_name"), 505.0, 15.0, true) {
            text(&mut ops, &line, LEFT, y, 15.0, true, GREEN)?;
            y -= 19.0;
        }
        let address = format!(
            "{} - {} {}",
            string(self.issuer, "address_line1"),
            string(self.issuer, "postal_code"),
            string(self.issuer, "city")
        );
        for line in wrap_text_width(&address, 505.0, 8.0, false) {
            text(&mut ops, &line, LEFT, y, 8.0, false, INK)?;
            y -= 12.0;
        }
        y -= 14.0;
        text(&mut ops, self.title, LEFT, y, 21.0, true, GREEN)?;
        y -= 23.0;
        text(
            &mut ops,
            &format!(
                "Du {} au {} - {} - {}",
                string(&self.report["scope"], "date_from"),
                string(&self.report["scope"], "date_to"),
                string(&self.report["currency"], "base_currency"),
                if self.closed {
                    "Exercice clôturé"
                } else {
                    "Provisoire"
                }
            ),
            LEFT,
            y,
            9.0,
            false,
            INK,
        )?;
        y -= 29.0;
        text(&mut ops, "Comptes / libellés", LEFT, y, 8.5, true, INK)?;
        for (value, right) in [
            (string(&self.report["scope"], "date_to"), FIRST_AMOUNT),
            (string(&self.report["scope"], "previous_date_to"), RIGHT),
        ] {
            text(
                &mut ops,
                value,
                right - helvetica_text_width(value, 9.0, true),
                y,
                9.0,
                true,
                INK,
            )?;
        }
        rule(&mut ops, y - 9.0);
        self.y = y - 29.0;
        self.pages.push(ops);
        Ok(())
    }
    fn line(&mut self, label: &str, amounts: Option<(i64, i64)>, bold: bool) -> AppResult<()> {
        let lines = wrap_text_width(label, 284.0, 9.0, bold);
        let height = (lines.len() as f32 * 13.0).max(16.0) + if bold { 3.0 } else { 0.0 };
        if self.y - height < 90.0 {
            self.next_page()?;
        }
        if height > 490.0 {
            return Err(AppError::Validation(
                "Un libellé comptable est trop long pour une page PDF.".into(),
            ));
        }
        let ops = self.pages.last_mut().unwrap();
        for (index, line) in lines.iter().enumerate() {
            text(
                ops,
                line,
                LEFT,
                self.y - index as f32 * 13.0,
                9.0,
                bold,
                if bold { GREEN } else { INK },
            )?;
        }
        if let Some((current, previous)) = amounts {
            for (value, right) in [(current, FIRST_AMOUNT), (previous, RIGHT)] {
                let value = money(value);
                let size = 9.0_f32.min(96.0 / helvetica_text_width(&value, 1.0, bold));
                text(
                    ops,
                    &value,
                    right - helvetica_text_width(&value, size, bold),
                    self.y,
                    size,
                    bold,
                    INK,
                )?;
            }
        }
        self.y -= height;
        Ok(())
    }
    fn section(&mut self, key: &str, label: &str) -> AppResult<()> {
        if self.y < 165.0 {
            self.next_page()?;
        }
        self.line(label, None, true)?;
        if let Some(rows) = self.report["rows"].as_array() {
            for row in rows
                .iter()
                .filter(|row| string(row, "report_section") == key)
            {
                self.line(
                    &format!("{}   {}", string(row, "code"), string(row, "name")),
                    Some((
                        amount(row, "amount_cents"),
                        amount(row, "previous_amount_cents"),
                    )),
                    false,
                )?;
            }
        }
        self.line(
            &format!("Total {label}"),
            Some((
                amount(&self.report["sections"], key),
                amount(&self.report["previous_sections"], key),
            )),
            true,
        )?;
        self.y -= 5.0;
        Ok(())
    }
    fn total(&mut self, label: &str, key: &str) -> AppResult<()> {
        self.line(
            label,
            Some((
                amount(self.report, key),
                amount(self.report, &format!("previous_{key}")),
            )),
            true,
        )
    }
}

pub(crate) fn render_accounts_pdf(
    issuer: &Value,
    balance: &Value,
    income: &Value,
    closed: bool,
    captured_at: &str,
) -> AppResult<(Vec<u8>, usize)> {
    let mut sheet = PageWriter::new(issuer, balance, "Bilan", closed)?;
    for (key, label) in [
        ("current_assets", "Actifs circulants"),
        ("fixed_assets", "Actifs immobilisés"),
    ] {
        sheet.section(key, label)?;
    }
    sheet.total("TOTAL ACTIFS", "assets_cents")?;
    for (key, label) in [
        ("short_term_liabilities", "Dettes à court terme"),
        ("long_term_liabilities", "Dettes à long terme"),
        ("equity", "Fonds propres"),
    ] {
        sheet.section(key, label)?;
    }
    sheet.total(
        "Résultats antérieurs non affectés",
        "unallocated_prior_results_cents",
    )?;
    sheet.total("Résultat de l'exercice", "current_result_cents")?;
    let sum = |previous: bool| -> AppResult<i64> {
        [
            "liabilities_cents",
            "equity_cents",
            "unallocated_prior_results_cents",
            "current_result_cents",
        ]
        .iter()
        .try_fold(0_i64, |sum, key| {
            sum.checked_add(amount(
                balance,
                &format!("{}{key}", if previous { "previous_" } else { "" }),
            ))
            .ok_or_else(|| AppError::Validation("Total du passif hors capacité monétaire.".into()))
        })
    };
    sheet.line("TOTAL PASSIFS", Some((sum(false)?, sum(true)?)), true)?;
    sheet.line(
        if balance["balanced"] == true {
            "Contrôle : actifs = passifs"
        } else {
            "Bilan non équilibré - écritures à contrôler"
        },
        None,
        true,
    )?;
    let mut result = PageWriter::new(issuer, income, "Compte de résultat", closed)?;
    for (key, label) in [
        ("net_revenue", "Chiffre d'affaires net"),
        ("cost_of_goods", "Achats et coût des marchandises"),
        ("personnel_expense", "Charges de personnel"),
        ("other_operating_expense", "Autres charges d'exploitation"),
        ("depreciation", "Amortissements"),
        ("financial_result", "Résultat financier"),
        ("non_operating_result", "Résultat hors exploitation"),
        ("exceptional_result", "Résultat exceptionnel"),
        ("taxes", "Impôts"),
    ] {
        if income["rows"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| string(row, "report_section") == key))
        {
            result.section(key, label)?;
        }
    }
    result.total("Total des produits", "revenue_cents")?;
    result.total("Total des charges", "expense_cents")?;
    result.total("BÉNÉFICE / PERTE DE L'EXERCICE", "profit_cents")?;
    let mut pages = sheet.pages;
    pages.extend(result.pages);
    let count = pages.len();
    let mut pdf = Document::with_version("1.5");
    let pages_id = pdf.new_object_id();
    let regular=pdf.add_object(dictionary!{"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Helvetica","Encoding"=>"WinAnsiEncoding"});
    let bold=pdf.add_object(dictionary!{"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Helvetica-Bold","Encoding"=>"WinAnsiEncoding"});
    let resources = pdf.add_object(dictionary! {"Font"=>dictionary!{"F1"=>regular,"F2"=>bold}});
    let mut kids = Vec::new();
    for (index, mut ops) in pages.into_iter().enumerate() {
        rule(&mut ops, 65.0);
        text(&mut ops,"Bilan et résultat issus du journal local. Annexe et approbation à joindre selon vos obligations.",LEFT,51.0,7.0,false,INK)?;
        text(
            &mut ops,
            &format!("Zentra - {}", captured_at),
            LEFT,
            38.0,
            7.0,
            false,
            INK,
        )?;
        let page_number = format!("{} / {count}", index + 1);
        text(
            &mut ops,
            &page_number,
            RIGHT - helvetica_text_width(&page_number, 8.0, false),
            38.0,
            8.0,
            false,
            INK,
        )?;
        let content = Content { operations: ops }
            .encode()
            .map_err(|error| AppError::Validation(error.to_string()))?;
        let stream = pdf.add_object(Stream::new(dictionary! {}, content));
        kids.push(pdf.add_object(dictionary!{"Type"=>"Page","Parent"=>pages_id,"MediaBox"=>vec![0.into(),0.into(),595.28.into(),841.89.into()],"Resources"=>resources,"Contents"=>stream}).into());
    }
    pdf.objects.insert(
        pages_id,
        dictionary! {"Type"=>"Pages","Kids"=>kids,"Count"=>count as i64}.into(),
    );
    let catalog = pdf.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
    pdf.trailer.set("Root", catalog);
    pdf.compress();
    let mut bytes = Vec::new();
    pdf.save_to(&mut bytes)?;
    Ok((bytes, count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(code: &str, name: &str, section: &str, current: i64, previous: i64) -> Value {
        json!({"code":code,"name":name,"report_section":section,"amount_cents":current*100,"previous_amount_cents":previous*100})
    }
    fn reports() -> (Value, Value, Value) {
        let issuer = json!({"company_name":"Exemple fictif - Atelier du Léman Sàrl","address_line1":"Rue du Lac 12","postal_code":"1000","city":"Lausanne"});
        let scope = json!({"date_from":"2026-01-01","date_to":"2026-12-31","previous_date_from":"2025-01-01","previous_date_to":"2025-12-31"});
        let balance = json!({"scope":scope,"currency":{"base_currency":"CHF"},"balanced":true,
            "rows":[row("1020","Banque","current_assets",85000,60000),row("1100","Créances clients","current_assets",36000,30000),row("1200","Stocks de marchandises","current_assets",12000,10000),row("1500","Machines et équipements","fixed_assets",45000,50000),row("2000","Dettes fournisseurs","short_term_liabilities",28000,20000),row("2200","TVA à payer","short_term_liabilities",6200,5000),row("2270","Assurances sociales à payer","short_term_liabilities",3800,3000),row("2450","Emprunt bancaire","long_term_liabilities",50000,60000),row("2800","Capital social","equity",20000,20000),row("2950","Réserves","equity",10000,10000)],
            "sections":{"current_assets":13300000,"fixed_assets":4500000,"short_term_liabilities":3800000,"long_term_liabilities":5000000,"equity":3000000},
            "previous_sections":{"current_assets":10000000,"fixed_assets":5000000,"short_term_liabilities":2800000,"long_term_liabilities":6000000,"equity":3000000},
            "assets_cents":17800000,"previous_assets_cents":15000000,"liabilities_cents":8800000,"previous_liabilities_cents":8800000,"equity_cents":3000000,"previous_equity_cents":3000000,"unallocated_prior_results_cents":4000000,"previous_unallocated_prior_results_cents":2000000,"current_result_cents":2000000,"previous_current_result_cents":1200000});
        let income = json!({"scope":scope,"currency":{"base_currency":"CHF"},"rows":[row("3000","Ventes et prestations","net_revenue",250000,200000),row("4000","Achats de marchandises","cost_of_goods",100000,80000),row("5000","Salaires et charges sociales","personnel_expense",95000,80000),row("6000","Loyers et frais d'exploitation","other_operating_expense",20000,15000),row("6800","Amortissements","depreciation",10000,9000),row("6900","Charges financières","financial_result",3000,2000),row("8900","Impôts directs","taxes",2000,2000)],
            "sections":{"net_revenue":25000000,"cost_of_goods":10000000,"personnel_expense":9500000,"other_operating_expense":2000000,"depreciation":1000000,"financial_result":300000,"taxes":200000},
            "previous_sections":{"net_revenue":20000000,"cost_of_goods":8000000,"personnel_expense":8000000,"other_operating_expense":1500000,"depreciation":900000,"financial_result":200000,"taxes":200000},
            "revenue_cents":25000000,"previous_revenue_cents":20000000,"expense_cents":23000000,"previous_expense_cents":18800000,"profit_cents":2000000,"previous_profit_cents":1200000});
        (issuer, balance, income)
    }

    #[test]
    fn comparative_accounts_pdf_preserves_totals_accents_status_and_creates_review_sample() {
        let (issuer, balance, income) = reports();
        let (bytes, pages) =
            render_accounts_pdf(&issuer, &balance, &income, false, "2026-09-05T00:00:00Z").unwrap();
        let pdf = Document::load_mem(&bytes).unwrap();
        assert_eq!(pdf.get_pages().len(), pages);
        let text = pdf
            .extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
            .unwrap();
        for expected in [
            "Bilan",
            "Compte de résultat",
            "Provisoire",
            "Stocks de marchandises",
            "TOTAL ACTIFS",
            "TOTAL PASSIFS",
            "178'000.00",
            "150'000.00",
            "20'000.00",
            "12'000.00",
            "2025-12-31",
        ] {
            assert!(text.contains(expected), "Texte manquant : {expected}");
        }
        assert_eq!(money(-123456), "-1'234.56");
        assert_eq!(money(i64::MIN), "-92'233'720'368'547'758.08");
        if let Some(path) = std::env::var_os("ZENTRA_SAMPLE_ACCOUNTS_PDF") {
            std::fs::write(path, &bytes).unwrap();
        }
    }

    #[test]
    fn financial_pdf_paginates_without_losing_rows_and_rejects_silent_character_loss() {
        let (mut issuer, mut balance, income) = reports();
        for index in 0..75 {
            balance["rows"].as_array_mut().unwrap().push(row(
                &format!("10{index:03}"),
                &format!("Ligne détaillée numéro {index:03} - {}", "W".repeat(85)),
                "current_assets",
                0,
                0,
            ));
        }
        let (bytes, pages) =
            render_accounts_pdf(&issuer, &balance, &income, true, "2026-09-05").unwrap();
        assert!(pages > 4);
        let pdf = Document::load_mem(&bytes).unwrap();
        let text = pdf
            .extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
            .unwrap();
        for index in 0..75 {
            assert!(text.contains(&format!("10{index:03}")));
        }
        assert!(text.contains("Exercice clôturé"));
        issuer["company_name"] = json!("Entreprise 漢字");
        assert!(render_accounts_pdf(&issuer, &balance, &income, false, "2026-09-05").is_err());
    }
}
