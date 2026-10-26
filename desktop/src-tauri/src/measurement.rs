//! Métré des positions de devis et de facture : chaque ligne de mesure porte
//! une formule (« 4,20 × 2,60 », « 0,90 × 2,10 » pour une ouverture à
//! déduire) et la quantité de la position est la somme des lignes. Le calcul
//! est en virgule fixe (9 décimales) avec arrondi demi vers l'extérieur, puis
//! la quantité est arrondie au millième. `desktop/src/measurement.ts` fait
//! exactement le même calcul pour l'affichage en direct.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};

const SCALE: i128 = 1_000_000_000;
/// Valeur absolue maximale d'un résultat intermédiaire (un milliard).
const LIMIT: i128 = 1_000_000_000 * SCALE;
pub const MAX_ROWS: usize = 60;
const MAX_FORMULA: usize = 200;
const MAX_LABEL: usize = 120;
const MAX_SECTION: usize = 120;
const MAX_DEPTH: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MeasurementRow {
    #[serde(default)]
    pub label: String,
    pub formula: String,
    #[serde(default)]
    pub deduct: bool,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

fn round_div(numerator: i128, denominator: i128) -> i128 {
    let negative = (numerator < 0) != (denominator < 0);
    let (n, d) = (numerator.abs(), denominator.abs());
    let quotient = (n + d / 2) / d;
    if negative {
        -quotient
    } else {
        quotient
    }
}

fn bounded(value: i128) -> AppResult<i128> {
    if value.abs() > LIMIT {
        Err(invalid("Le métré dépasse la taille admise."))
    } else {
        Ok(value)
    }
}

struct Parser<'a> {
    chars: Vec<char>,
    index: usize,
    depth: usize,
    formula: &'a str,
}

impl Parser<'_> {
    fn error(&self) -> AppError {
        invalid(format!("La formule « {} » n'est pas lisible.", self.formula))
    }

    fn skip_spaces(&mut self) {
        while self.index < self.chars.len() && self.chars[self.index].is_whitespace() {
            self.index += 1;
        }
    }

    fn peek(&mut self) -> Option<char> {
        self.skip_spaces();
        self.chars.get(self.index).copied()
    }

    fn expression(&mut self) -> AppResult<i128> {
        let mut value = self.term()?;
        while let Some(operator) = self.peek() {
            match operator {
                '+' => {
                    self.index += 1;
                    value = bounded(value + self.term()?)?;
                }
                '-' | '−' | '–' => {
                    self.index += 1;
                    value = bounded(value - self.term()?)?;
                }
                _ => break,
            }
        }
        Ok(value)
    }

    fn term(&mut self) -> AppResult<i128> {
        let mut value = self.factor()?;
        while let Some(operator) = self.peek() {
            match operator {
                '*' | '×' | 'x' | 'X' | '·' => {
                    self.index += 1;
                    let right = self.factor()?;
                    value = bounded(round_div(value * right, SCALE))?;
                }
                '/' | '÷' | ':' => {
                    self.index += 1;
                    let right = self.factor()?;
                    if right == 0 {
                        return Err(invalid(format!("La formule « {} » divise par zéro.", self.formula)));
                    }
                    value = bounded(round_div(value * SCALE, right))?;
                }
                _ => break,
            }
        }
        Ok(value)
    }

    fn factor(&mut self) -> AppResult<i128> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.error());
        }
        let value = match self.peek() {
            Some('-' | '−' | '–') => {
                self.index += 1;
                -self.factor()?
            }
            Some('+') => {
                self.index += 1;
                self.factor()?
            }
            Some('(') => {
                self.index += 1;
                let value = self.expression()?;
                if self.peek() != Some(')') {
                    return Err(self.error());
                }
                self.index += 1;
                value
            }
            Some(c) if c.is_ascii_digit() || c == '.' || c == ',' => self.number()?,
            _ => return Err(self.error()),
        };
        self.depth -= 1;
        Ok(value)
    }

    fn number(&mut self) -> AppResult<i128> {
        let mut whole: i128 = 0;
        let mut fraction: i128 = 0;
        let mut decimals = 0u32;
        let mut seen_separator = false;
        let mut digits = 0usize;
        while let Some(&c) = self.chars.get(self.index) {
            if c.is_ascii_digit() {
                let digit = i128::from(c as u8 - b'0');
                if seen_separator {
                    if decimals == 9 {
                        return Err(invalid(format!("La formule « {} » a trop de décimales.", self.formula)));
                    }
                    fraction = fraction * 10 + digit;
                    decimals += 1;
                } else {
                    whole = whole * 10 + digit;
                    if whole > 1_000_000_000 {
                        return Err(invalid("Le métré dépasse la taille admise."));
                    }
                }
                digits += 1;
            } else if (c == '.' || c == ',') && !seen_separator {
                seen_separator = true;
            } else if c == '\'' && !seen_separator && digits > 0 {
                // Séparateur de milliers suisse : 1'250.
            } else {
                break;
            }
            self.index += 1;
        }
        if digits == 0 {
            return Err(self.error());
        }
        let fraction_scaled = fraction * 10_i128.pow(9 - decimals);
        bounded(whole * SCALE + fraction_scaled)
    }
}

/// Valeur d'une formule, en virgule fixe à 9 décimales.
pub fn evaluate(formula: &str) -> AppResult<i128> {
    let trimmed = formula.trim();
    if trimmed.is_empty() {
        return Err(invalid("Une ligne de métré n'a pas de formule."));
    }
    if trimmed.chars().count() > MAX_FORMULA {
        return Err(invalid("Une formule de métré est trop longue (200 caractères au plus)."));
    }
    let mut parser = Parser { chars: trimmed.chars().collect(), index: 0, depth: 0, formula: trimmed };
    let value = parser.expression()?;
    if parser.peek().is_some() {
        return Err(parser.error());
    }
    Ok(value)
}

/// Quantité de la position, en millièmes : somme des lignes, les déductions
/// étant soustraites, arrondie une seule fois à la fin.
pub fn quantity_milli(rows: &[MeasurementRow]) -> AppResult<i64> {
    if rows.is_empty() {
        return Err(invalid("Le métré ne contient aucune ligne."));
    }
    if rows.len() > MAX_ROWS {
        return Err(invalid("Le métré contient trop de lignes (60 au plus)."));
    }
    let mut total: i128 = 0;
    for row in rows {
        if row.label.chars().count() > MAX_LABEL {
            return Err(invalid("Le libellé d'une ligne de métré est trop long (120 caractères au plus)."));
        }
        let value = evaluate(&row.formula)?;
        total = bounded(if row.deduct { total - value } else { total + value })?;
    }
    let milli = round_div(total, SCALE / 1_000);
    if milli < 0 {
        return Err(invalid("Les déductions du métré dépassent la quantité mesurée."));
    }
    Ok(milli as i64)
}

/// Lit `measurements_json` : `None` si absent ou vide.
pub fn parse_rows(value: Option<&Value>) -> AppResult<Option<Vec<MeasurementRow>>> {
    let rows: Vec<MeasurementRow> = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(text)) if text.trim().is_empty() => return Ok(None),
        Some(Value::String(text)) => serde_json::from_str(text).map_err(|_| invalid("Le métré enregistré est invalide."))?,
        Some(Value::Array(_)) => serde_json::from_value(value.cloned().unwrap_or(Value::Null)).map_err(|_| invalid("Le métré enregistré est invalide."))?,
        Some(_) => return Err(invalid("Le métré enregistré est invalide.")),
    };
    let rows: Vec<MeasurementRow> = rows
        .into_iter()
        .map(|row| MeasurementRow { label: row.label.trim().to_owned(), formula: row.formula.trim().replace(['−', '–'], "-"), deduct: row.deduct })
        .collect();
    if rows.is_empty() {
        Ok(None)
    } else {
        Ok(Some(rows))
    }
}

/// Normalise une ligne de devis ou de facture avant le calcul des montants :
/// le chapitre est nettoyé, le métré validé et la quantité recalculée.
pub fn normalize_line(object: &mut Map<String, Value>) -> AppResult<()> {
    if let Some(section) = object.get("section_title").cloned() {
        match section {
            Value::Null => {}
            Value::String(text) => {
                let text = text.trim().to_owned();
                if text.chars().count() > MAX_SECTION {
                    return Err(invalid("Le titre du chapitre est trop long (120 caractères au plus)."));
                }
                object.insert("section_title".into(), if text.is_empty() { Value::Null } else { Value::String(text) });
            }
            _ => return Err(invalid("Le titre du chapitre est invalide.")),
        }
    }
    if object.contains_key("measurements_json") {
        match parse_rows(object.get("measurements_json"))? {
            None => {
                object.insert("measurements_json".into(), Value::Null);
            }
            Some(rows) => {
                let milli = quantity_milli(&rows)?;
                object.insert("quantity".into(), json!(milli as f64 / 1_000.0));
                object.insert("measurements_json".into(), Value::String(serde_json::to_string(&rows)?));
            }
        }
    }
    Ok(())
}

/// Valeur d'une ligne de métré, en millièmes, pour l'impression du détail.
pub fn row_milli(row: &MeasurementRow) -> AppResult<i64> {
    let value = evaluate(&row.formula)?;
    Ok(round_div(value, SCALE / 1_000) as i64)
}

/// Quantité en millièmes écrite à la suisse : « 12,345 », « 4,5 », « 10 ».
pub fn format_milli(milli: i64) -> String {
    let negative = milli < 0;
    let absolute = milli.unsigned_abs();
    let whole = absolute / 1_000;
    let mut fraction = format!("{:03}", absolute % 1_000);
    while fraction.ends_with('0') {
        fraction.pop();
    }
    let sign = if negative { "-" } else { "" };
    if fraction.is_empty() {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole},{fraction}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(formula: &str, deduct: bool) -> MeasurementRow {
        MeasurementRow { label: String::new(), formula: formula.into(), deduct }
    }

    #[test]
    fn a_wall_minus_its_openings_gives_the_painted_surface() {
        let rows = vec![row("4,20 × 2,60", false), row("3.80 x 2.60", false), row("0,90 × 2,10", true), row("2 * 1,20 * 1,40", true)];
        // 10,92 + 9,88 − 1,89 − 3,36 = 15,55
        assert_eq!(quantity_milli(&rows).unwrap(), 15_550);
    }

    #[test]
    fn precedence_parentheses_and_division_are_exact() {
        assert_eq!(evaluate("2 + 3 × 4").unwrap(), 14 * SCALE);
        assert_eq!(evaluate("(2 + 3) × 4").unwrap(), 20 * SCALE);
        assert_eq!(evaluate("-(1,5) + 4").unwrap(), 2_500_000_000);
        assert_eq!(evaluate("10 / 3").unwrap(), 3_333_333_333);
        assert_eq!(evaluate("2 ÷ 3").unwrap(), 666_666_667);
        assert_eq!(evaluate("1'250,5").unwrap(), 1_250_500_000_000);
        assert_eq!(quantity_milli(&[row("10 / 3", false)]).unwrap(), 3_333);
        assert_eq!(quantity_milli(&[row("2 / 3", false)]).unwrap(), 667);
        assert_eq!(quantity_milli(&[row("0,0005", false)]).unwrap(), 1);
    }

    #[test]
    fn unreadable_or_unsafe_formulas_are_refused() {
        for formula in ["", "4,2 ×", "2 3", "(2", "2)", "1/0", "abc", "1,2,3", "0,1234567891", "99999999999"] {
            assert!(evaluate(formula).is_err(), "{formula}");
        }
        assert!(evaluate(&"(".repeat(30)).is_err());
        assert!(evaluate("100000 × 100000").is_err());
        assert!(quantity_milli(&[row("1", false), row("2", true)]).is_err());
        assert!(quantity_milli(&[]).is_err());
    }

    #[test]
    fn a_line_with_a_measurement_gets_its_quantity_from_it() {
        let mut object = Map::new();
        object.insert("quantity".into(), json!(1));
        object.insert("section_title".into(), json!("  Salon  "));
        object.insert("measurements_json".into(), json!(r#"[{"label":"Mur nord","formula":"4,2*2,6"},{"label":"Porte","formula":"0,9*2,1","deduct":true}]"#));
        normalize_line(&mut object).unwrap();
        assert_eq!(object["quantity"], json!(9.03));
        assert_eq!(object["section_title"], json!("Salon"));
        let stored = parse_rows(object.get("measurements_json")).unwrap().unwrap();
        assert_eq!(stored.len(), 2);
        assert!(stored[1].deduct);

        let mut cleared = Map::new();
        cleared.insert("quantity".into(), json!(3));
        cleared.insert("section_title".into(), json!(""));
        cleared.insert("measurements_json".into(), json!("[]"));
        normalize_line(&mut cleared).unwrap();
        assert_eq!(cleared["quantity"], json!(3));
        assert_eq!(cleared["section_title"], Value::Null);
        assert_eq!(cleared["measurements_json"], Value::Null);

        let mut unknown = Map::new();
        unknown.insert("measurements_json".into(), json!(r#"[{"formula":"1","extra":true}]"#));
        assert!(normalize_line(&mut unknown).is_err());
    }

    #[test]
    fn quantities_print_the_swiss_way() {
        assert_eq!(format_milli(15_550), "15,55");
        assert_eq!(format_milli(10_000), "10");
        assert_eq!(format_milli(3_333), "3,333");
        assert_eq!(format_milli(-1_890), "-1,89");
        assert_eq!(row_milli(&row("0,9 × 2,1", true)).unwrap(), 1_890);
    }
}

#[cfg(test)]
mod store_tests {
    use crate::database::LocalStore;
    use crate::models::{ConvertQuoteInput, GenerateSalesDocumentPdfInput, SaveDocumentWithItemsInput};
    use serde_json::json;

    #[test]
    fn chapters_and_measurements_travel_from_quote_to_invoice_and_pdf() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "measurement-test").unwrap();
        let client = store
            .create_record("clients", json!({"name":"Régie Dupont","address_line1":"Rue du Lac","address_line2":"12","postal_code":"1204","city":"Genève","country":"CH"}))
            .unwrap()["id"].as_str().unwrap().to_owned();
        let measured = r#"[{"label":"Mur nord","formula":"4,20 × 2,60"},{"label":"Porte","formula":"0,90 × 2,10","deduct":true}]"#;
        let saved = store.save_document_with_items(SaveDocumentWithItemsInput {
            entity: "quotes".into(),
            id: None,
            data: json!({"client_id":client,"title":"Rafraîchissement appartement","currency":"CHF","issue_date":"2026-10-20","valid_until":"2026-11-20","show_measurements":true}),
            items: vec![
                json!({"description":"Peinture murs, 2 couches","quantity":1,"unit":"m²","unit_price_cents":2_500,"discount_bp":0,"vat_bp":810,"section_title":"Salon","measurements_json":measured}),
                json!({"description":"Plafond","quantity":12.5,"unit":"m²","unit_price_cents":2_800,"discount_bp":0,"vat_bp":810,"section_title":"Salon"}),
                json!({"description":"Faïence, joints","quantity":3,"unit":"m²","unit_price_cents":6_000,"discount_bp":0,"vat_bp":810,"section_title":"Cuisine"}),
            ],
        }).unwrap();
        let items = saved["items"].as_array().unwrap();
        assert_eq!(items[0]["quantity"], json!(9.03));
        assert_eq!(items[0]["line_net_cents"], json!(22_575));
        assert_eq!(items[0]["section_title"], json!("Salon"));
        assert_eq!(saved["document"]["show_measurements"], json!(1));
        // 22 575 + 35 000 + 18 000
        assert_eq!(saved["document"]["subtotal_cents"], json!(75_575));

        let quote = saved["document"]["id"].as_str().unwrap().to_owned();
        store.issue_quote(&quote, Some("2026-10-20".into()), Some("2026-11-20".into())).unwrap();
        let pdf_path = temporary.path().join("devis-chapitres.pdf");
        store.generate_sales_document_pdf(GenerateSalesDocumentPdfInput { entity: "quotes".into(), document_id: quote.clone(), destination_path: pdf_path.to_string_lossy().into_owned() }).unwrap();
        let pdf = lopdf::Document::load(&pdf_path).unwrap();
        let text = pdf.extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>()).unwrap();
        assert!(text.contains("Total Salon"), "{text}");
        assert!(text.contains("Total Cuisine"));
        assert!(text.contains("Mur nord"));

        store.update_quote_status(&quote, "accepted").unwrap();
        store.convert_quote_to_invoice(ConvertQuoteInput { quote_id: quote.clone(), title: None, deposit_percentage_bp: None, issue_date: None, due_date: None, service_date_from: Some("2026-10-20".into()), service_date_to: Some("2026-10-31".into()) }).unwrap();
        let connection = store.connect().unwrap();
        let (sections, measured_lines, flag): (i64, i64, i64) = connection.query_row(
            "SELECT COUNT(i.section_title), COUNT(i.measurements_json), MAX(v.show_measurements) FROM invoices v JOIN invoice_items i ON i.invoice_id=v.id WHERE v.quote_id=?",
            [&quote],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!((sections, measured_lines, flag), (3, 1, 1));
    }
}
