use crate::{
    audit::append_audit,
    database::{query_all, row_to_json_public, LocalStore},
    error::{AppError, AppResult},
    salary_certificate_pdf::{certificate_pdf, FormValue},
    sales_pdf::validate_pdf_destination,
};
use chrono::{Datelike, NaiveDate};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write};

const EARNINGS: &[&str] = &["1", "2_1", "2_2", "2_3", "3", "4", "5", "6", "7"];
const DEDUCTIONS: &[&str] = &["9", "10_1", "10_2", "12", "exclude"];
const EXPENSES: &[&str] = &["13_1_1", "13_1_2", "13_2_1", "13_2_2", "13_2_3", "13_3"];
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").trim().into()
}
fn joined(values: Vec<String>) -> String {
    values
        .into_iter()
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateRow {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub amount_cents: i64,
    pub proposed_box: String,
    pub fixed_box: bool,
    pub count: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateIdentity {
    pub name: String,
    pub address: String,
    pub avs_number: String,
    pub birth_date: String,
    pub period_start: String,
    pub period_end: String,
    pub employer_contact: String,
    pub place_date: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateDraft {
    pub employee_id: String,
    pub year: i32,
    pub source_hash: String,
    pub identity: CertificateIdentity,
    pub rows: Vec<CertificateRow>,
    pub sources: Vec<CertificateSource>,
    pub withholding_rows: Vec<CertificateRow>,
    pub payslip_count: usize,
    pub unpaid_count: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateSource {
    pub id: String,
    pub period: String,
    pub payment_date: String,
    pub default_included: bool,
    pub rows: Vec<CertificateRow>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CertificateExtra {
    pub box_id: String,
    pub label: String,
    pub amount_cents: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CertificateInput {
    pub employee_id: String,
    pub year: i32,
    pub source_hash: String,
    pub identity: CertificateIdentity,
    pub allocations: BTreeMap<String, String>,
    pub source_ids: Vec<String>,
    pub realization_note: String,
    pub extras: Vec<CertificateExtra>,
    pub free_transport: bool,
    pub meals: bool,
    pub effective_expenses_attested: bool,
    pub benefits: String,
    pub remarks: String,
    pub reviewed: bool,
}

fn selected_rows(
    sources: &[CertificateSource],
    withholding: &[CertificateRow],
    ids: &[String],
) -> AppResult<Vec<CertificateRow>> {
    let unique: std::collections::BTreeSet<_> = ids.iter().collect();
    if unique.len() != ids.len()
        || ids
            .iter()
            .any(|id| !sources.iter().any(|source| source.id == *id))
    {
        return Err(invalid("La sélection des fiches annuelles est invalide."));
    }
    let mut groups: BTreeMap<String, CertificateRow> = BTreeMap::new();
    for row in sources
        .iter()
        .filter(|s| ids.contains(&s.id))
        .flat_map(|s| s.rows.iter())
        .chain(withholding.iter())
    {
        if let Some(group) = groups.get_mut(&row.id) {
            group.amount_cents = group
                .amount_cents
                .checked_add(row.amount_cents)
                .ok_or_else(|| invalid("Cumul annuel trop élevé."))?;
            group.count += row.count;
        } else {
            groups.insert(row.id.clone(), row.clone());
        }
    }
    Ok(groups.into_values().collect())
}

fn proposed_box(kind: &str, label: &str, contribution: Option<&Value>) -> (String, bool) {
    if let Some(row) = contribution.filter(|v| v["side"] == "employee") {
        let known = match row["category"].as_str().unwrap_or("") {
            "avs_ai_apg" | "ac" | "aanp" => "9",
            "lpp" => "10_1",
            "source_tax" => "12",
            "ijm" | "aap" | "family_allowance" => "exclude",
            _ => "",
        };
        if !known.is_empty() {
            return (known.into(), true);
        }
    }
    let normalized = label.to_lowercase();
    if kind == "earning"
        && [
            "salaire mensuel",
            "salaire horaire",
            "salaire de base",
            "13e salaire",
            "13ème salaire",
            "allocations familiales",
            "monatslohn",
            "stundenlohn",
        ]
        .iter()
        .any(|label| normalized.starts_with(label))
    {
        return ("1".into(), false);
    }
    (String::new(), false)
}

fn rows_from_payslips(payslips: &[Value]) -> AppResult<Vec<CertificateRow>> {
    let mut groups: BTreeMap<String, CertificateRow> = BTreeMap::new();
    for payslip in payslips {
        let snapshot: Value =
            serde_json::from_str(payslip["snapshot_json"].as_str().ok_or_else(|| {
                invalid("Une fiche payée ne possède pas son instantané comptabilisé.")
            })?)?;
        if snapshot["schema"] != "helvichantier.payslip_snapshot.v1"
            || snapshot["payslip"]["id"] != payslip["id"]
            || snapshot["payslip"]["period"] != payslip["period"]
            || !snapshot["contributions"].is_array()
        {
            return Err(invalid(
                "Une fiche payée ne possède pas de preuve comptabilisée cohérente.",
            ));
        }
        if snapshot["employee"]["id"] != payslip["employee_id"] {
            return Err(invalid(
                "L’identité figée d’une fiche ne correspond pas au collaborateur.",
            ));
        }
        let contributions = snapshot["contributions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for item in snapshot["items"]
            .as_array()
            .ok_or_else(|| invalid("Une fiche payée est incomplète."))?
        {
            let kind = text(item, "kind");
            if kind == "employer" {
                continue;
            }
            if !["earning", "deduction", "reimbursement"].contains(&kind.as_str()) {
                return Err(invalid("Une rubrique de salaire a une nature inconnue."));
            }
            let amount = item["amount_cents"]
                .as_i64()
                .filter(|v| *v >= 0 && *v <= 100_000_000_000)
                .ok_or_else(|| invalid("Un montant salarial est invalide."))?;
            if amount == 0 {
                continue;
            }
            let label = text(item, "label");
            let contribution = contributions
                .iter()
                .find(|row| row["payslip_item_id"] == item["id"] && !item["id"].is_null());
            let (box_id, fixed) = proposed_box(&kind, &label, contribution);
            let id = format!(
                "{:x}",
                Sha256::digest(format!("{kind}|{label}|{box_id}|{fixed}"))
            );
            let group = groups.entry(id.clone()).or_insert(CertificateRow {
                id,
                label,
                kind,
                amount_cents: 0,
                proposed_box: box_id,
                fixed_box: fixed,
                count: 0,
            });
            group.amount_cents = group
                .amount_cents
                .checked_add(amount)
                .ok_or_else(|| invalid("Le cumul annuel dépasse la limite autorisée."))?;
            group.count += 1;
        }
    }
    Ok(groups.into_values().collect())
}

impl LocalStore {
    pub fn salary_certificate_draft(
        &self,
        employee_id: &str,
        year: i32,
    ) -> AppResult<CertificateDraft> {
        if !(2000..=2099).contains(&year) || employee_id.trim().is_empty() {
            return Err(invalid("Choisissez un collaborateur et une année valides."));
        }
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let employee = connection.query_row(
            "SELECT * FROM employees WHERE id=?",
            params![employee_id],
            row_to_json_public,
        )?;
        let issuer =
            connection.query_row("SELECT * FROM settings WHERE id=1", [], row_to_json_public)?;
        let start = format!("{year}-01-01");
        let end = format!("{year}-12-31");
        let broken: i64=connection.query_row("SELECT COUNT(*) FROM payslips p WHERE p.employee_id=? AND p.status='paye' AND (p.payment_date IS NULL OR LENGTH(p.payment_date)<>10 OR DATE(p.payment_date,'+0 days') IS NOT p.payment_date OR NOT EXISTS(SELECT 1 FROM journal_entries j WHERE j.id=p.payment_journal_entry_id AND j.source_type='payslip' AND j.source_id=p.id AND j.source_event='payment' AND j.entry_date=p.payment_date AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reversal_of=j.id)))",params![employee_id],|r|r.get(0))?;
        if broken > 0 {
            return Err(invalid(
                "Régularisez les anciens paiements de salaire avant le certificat annuel.",
            ));
        }
        let payslips = query_all(&connection, "SELECT id,employee_id,period,status,payment_date,payment_journal_entry_id,snapshot_json FROM payslips WHERE employee_id=? AND status IN ('comptabilise','paye') AND (substr(period,1,4)=? OR (payment_date>=? AND payment_date<=?)) ORDER BY period,id", params![employee_id,year.to_string(),start,end])?;
        let unpaid: i64 = connection.query_row("SELECT COUNT(*) FROM payslips WHERE employee_id=? AND substr(period,1,4)=? AND status NOT IN ('comptabilise','paye')", params![employee_id,year.to_string()], |r| r.get(0))?;
        let mut sources = vec![];
        let mut withholding_rows = vec![];
        for payslip in &payslips {
            let mut rows = rows_from_payslips(std::slice::from_ref(payslip))?;
            if payslip["status"] == "paye"
                && text(payslip, "payment_date").starts_with(&year.to_string())
            {
                withholding_rows.extend(
                    rows.iter()
                        .filter(|row| row.fixed_box && row.proposed_box == "12")
                        .cloned(),
                );
            }
            rows.retain(|row| !(row.fixed_box && row.proposed_box == "12"));
            sources.push(CertificateSource {
                id: text(payslip, "id"),
                period: text(payslip, "period"),
                payment_date: text(payslip, "payment_date"),
                default_included: text(payslip, "period").starts_with(&year.to_string()),
                rows,
            });
        }
        let source_ids: Vec<String> = sources
            .iter()
            .filter(|s| s.default_included)
            .map(|s| s.id.clone())
            .collect();
        let rows = selected_rows(&sources, &withholding_rows, &source_ids)?;
        let source_hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(
                &json!({"year":year,"employee":employee,"issuer":issuer,"payslips":payslips})
            )?)
        );
        let hire = text(&employee, "employment_start_date");
        let leave = text(&employee, "employment_end_date");
        let period_floor = if !leave.is_empty()
            && leave < start
            && NaiveDate::parse_from_str(&leave, "%Y-%m-%d").is_ok()
        {
            format!("{}-01-01", &leave[..4])
        } else {
            start.clone()
        };
        let identity = CertificateIdentity {
            name: text(&employee, "name"),
            address: joined(vec![
                text(&employee, "address_line1"),
                text(&employee, "address_line2"),
                format!(
                    "{} {}",
                    text(&employee, "postal_code"),
                    text(&employee, "city")
                )
                .trim()
                .into(),
            ]),
            avs_number: text(&employee, "social_security_number"),
            birth_date: text(&employee, "birth_date"),
            period_start: if hire.is_empty() {
                String::new()
            } else {
                hire.max(period_floor)
            },
            period_end: if leave.is_empty() {
                end.clone()
            } else {
                leave.min(end)
            },
            employer_contact: joined(vec![
                text(&issuer, "company_name"),
                text(&issuer, "owner_name"),
                text(&issuer, "address_line1"),
                text(&issuer, "address_line2"),
                format!("{} {}", text(&issuer, "postal_code"), text(&issuer, "city"))
                    .trim()
                    .into(),
                text(&issuer, "phone"),
            ]),
            place_date: format!(
                "{}, {}",
                text(&issuer, "city"),
                chrono::Local::now().format("%d.%m.%Y")
            ),
        };
        Ok(CertificateDraft {
            employee_id: employee_id.into(),
            year,
            source_hash,
            identity,
            rows,
            sources,
            withholding_rows,
            payslip_count: source_ids.len(),
            unpaid_count: unpaid.max(0) as usize,
        })
    }
    pub fn salary_certificate_preview(&self, input: &CertificateInput) -> AppResult<Vec<u8>> {
        let draft = self.salary_certificate_draft(&input.employee_id, input.year)?;
        if input.source_hash != draft.source_hash {
            return Err(invalid(
                "Les données de paie ont changé. Rechargez le certificat avant de l’exporter.",
            ));
        }
        let mut selected = draft.clone();
        selected.rows = selected_rows(&draft.sources, &draft.withholding_rows, &input.source_ids)?;
        let exceptional = draft.sources.iter().any(|source| {
            input.source_ids.contains(&source.id) != source.default_included
                || !source.payment_date.is_empty()
                    && source.period.get(..4) != source.payment_date.get(..4)
                || input.source_ids.contains(&source.id)
                    && (source.payment_date.is_empty()
                        || !source.payment_date.starts_with(&input.year.to_string()))
        });
        if exceptional && input.realization_note.trim().len() < 10 {
            return Err(invalid("Précisez le rattachement fiscal des salaires non versés ou payés sur une autre année (montant connu et paiement certain, ou réalisation différée)."));
        }
        let (values, annex) = certificate_values(&selected, input)?;
        certificate_pdf(&values, &annex)
    }
    pub fn export_salary_certificate(
        &self,
        input: &CertificateInput,
        destination: &str,
    ) -> AppResult<String> {
        if !input.reviewed {
            return Err(invalid(
                "Vérifiez l’intégralité des prestations annuelles avant l’export du certificat.",
            ));
        }
        let path = validate_pdf_destination(destination)?;
        let bytes = self.salary_certificate_preview(input)?;
        let sha = format!("{:x}", Sha256::digest(&bytes));
        let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&path)
            .map_err(|e| AppError::Io(e.error))?;
        let mut connection = self.connect()?;
        let tx = connection.transaction()?;
        append_audit(
            &tx,
            "salary_certificate.exported",
            "salary_certificate",
            &format!("{}-{}", input.employee_id, input.year),
            &json!({"input":input,"pdf_sha256":sha,"form":"AFC-11-01.21","generated_at":crate::database::now_iso()}),
        )?;
        tx.commit()?;
        Ok(path.to_string_lossy().into_owned())
    }
}

fn certificate_values(
    draft: &CertificateDraft,
    input: &CertificateInput,
) -> AppResult<(BTreeMap<String, FormValue>, Vec<String>)> {
    let identity = &input.identity;
    if identity.name.trim().is_empty()
        || identity.address.trim().is_empty()
        || identity.employer_contact.trim().is_empty()
        || identity.place_date.trim().is_empty()
    {
        return Err(invalid(
            "Complétez les coordonnées du collaborateur et de l’employeur.",
        ));
    }
    let avs: Vec<u32> = identity
        .avs_number
        .chars()
        .filter_map(|c| c.to_digit(10))
        .collect();
    if avs.len() != 13
        || avs[..3] != [7, 5, 6]
        || (10
            - avs[..12]
                .iter()
                .enumerate()
                .map(|(i, v)| v * if i % 2 == 0 { 1 } else { 3 })
                .sum::<u32>()
                % 10)
            % 10
            != avs[12]
    {
        return Err(invalid("Le numéro AVS du collaborateur est invalide."));
    }
    let date = |raw: &str| {
        NaiveDate::parse_from_str(raw, "%Y-%m-%d")
            .map_err(|_| invalid("Une date du certificat est invalide."))
    };
    let birth = date(&identity.birth_date)?;
    let from = date(&identity.period_start)?;
    let to = date(&identity.period_end)?;
    if from.year() > input.year || to.year() > input.year || from > to || birth >= from {
        return Err(invalid(
            "Vérifiez les dates de naissance et la période salariée de l’année choisie.",
        ));
    }
    if (from.year() != input.year || to.year() != input.year)
        && input.realization_note.trim().len() < 10
    {
        return Err(invalid("Précisez les prestations versées après la fin des rapports de travail dans la justification fiscale."));
    }
    if input.allocations.len() != draft.rows.len() || input.extras.len() > 80 {
        return Err(invalid(
            "Toutes les rubriques annuelles doivent être contrôlées.",
        ));
    }
    let mut amounts: BTreeMap<String, i64> = BTreeMap::new();
    let mut descriptions: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut excluded = vec![];
    let mut annex = vec![];
    for row in &draft.rows {
        let target = input
            .allocations
            .get(&row.id)
            .ok_or_else(|| invalid("Une rubrique annuelle n’a pas été classée."))?;
        let allowed = match row.kind.as_str() {
            "earning" => EARNINGS,
            "deduction" => DEDUCTIONS,
            "reimbursement" => EXPENSES,
            _ => &[],
        };
        if !allowed.contains(&target.as_str()) || row.fixed_box && target != &row.proposed_box {
            return Err(invalid(
                "La classification d’une rubrique ne correspond pas à sa nature salariale.",
            ));
        }
        if target == "exclude" {
            excluded.push(format!(
                "{} : {} CHF",
                row.label,
                exact_amount(row.amount_cents)
            ));
            continue;
        }
        let total = amounts.entry(target.clone()).or_default();
        *total = total
            .checked_add(row.amount_cents)
            .ok_or_else(|| invalid("Cumul annuel trop élevé."))?;
        descriptions
            .entry(target.clone())
            .or_default()
            .push(row.label.clone());
    }
    for extra in &input.extras {
        if !EARNINGS.contains(&extra.box_id.as_str())
            && !DEDUCTIONS[..4].contains(&extra.box_id.as_str())
            && !EXPENSES.contains(&extra.box_id.as_str())
        {
            return Err(invalid("Rubrique complémentaire inconnue."));
        }
        if extra.label.trim().is_empty()
            || !(-100_000_000_000..=100_000_000_000).contains(&extra.amount_cents)
        {
            return Err(invalid(
                "Justifiez chaque prestation complémentaire avec un libellé et un montant valides.",
            ));
        }
        let total = amounts.entry(extra.box_id.clone()).or_default();
        *total = total
            .checked_add(extra.amount_cents)
            .ok_or_else(|| invalid("Cumul annuel trop élevé."))?;
        descriptions
            .entry(extra.box_id.clone())
            .or_default()
            .push(extra.label.clone());
    }
    if amounts
        .iter()
        .any(|(key, amount)| key != "12" && *amount < 0)
    {
        return Err(invalid(
            "Un cumul de rubrique est négatif. Contrôlez les corrections annuelles.",
        ));
    }
    let gross: i64 = EARNINGS
        .iter()
        .map(|key| amounts.get(*key).copied().unwrap_or(0))
        .sum();
    let social = amounts.get("9").copied().unwrap_or(0)
        + amounts.get("10_1").copied().unwrap_or(0)
        + amounts.get("10_2").copied().unwrap_or(0);
    if gross < 0 || social > gross || amounts.values().all(|amount| *amount == 0) {
        return Err(invalid(
            "Vérifiez le salaire brut et les cotisations annuelles.",
        ));
    }
    amounts.insert("8".into(), gross);
    amounts.insert("11".into(), gross - social);
    let mut values = BTreeMap::new();
    let rounded = rounded_amounts(&amounts);
    for (key, francs) in &rounded {
        values.insert(
            format!("DezZahlNull_{key}"),
            FormValue::Text(francs.to_string()),
        );
    }
    if amounts.values().any(|cents| cents % 100 != 0) {
        annex.push("Montants exacts avant arrondi au franc sur le formulaire :".into());
        for (key, cents) in &amounts {
            annex.push(format!(
                "Ch. {} : {} CHF",
                key.replace('_', "."),
                exact_amount(*cents)
            ));
        }
        annex.push("Le net fiscal est arrondi au franc le plus proche. Les écarts d’arrondi des rubriques sont compensés dans une rémunération afin de préserver les totaux imprimés.".into());
    }
    for key in ["2_3", "3", "4", "7", "13_1_2", "13_2_3"] {
        if let Some(labels) = descriptions.get(key) {
            let description = labels.join(", ");
            // Keep the official field readable, with the full classification in
            // an identified annex when its single line cannot contain it.
            let label = if description.chars().count() > 35 {
                annex.push(format!(
                    "Ch. {} - nature : {}",
                    key.replace('_', "."),
                    description
                ));
                "Voir annexe".into()
            } else {
                description
            };
            values.insert(format!("TextLinks_{key}-Art"), FormValue::Text(label));
        }
    }
    values.insert("OptionKreuzOhneRahmen_A".into(), FormValue::Check(true));
    values.insert("OptionKreuzOhneRahmen_B".into(), FormValue::Check(false));
    values.insert(
        "OptionKreuzOhneRahmen_F".into(),
        FormValue::Check(input.free_transport),
    );
    values.insert(
        "OptionKreuzOhneRahmen_G".into(),
        FormValue::Check(input.meals),
    );
    values.insert(
        "OptionKreuzOhneRahmen_13_1_1".into(),
        FormValue::Check(input.effective_expenses_attested),
    );
    for (key, value) in [
        ("AHVLinks_C", identity.avs_number.clone()),
        ("TextLinks_C-GebDatum", birth.format("%d.%m.%Y").to_string()),
        ("TextLinks_D", input.year.to_string()),
        ("TextLinks_E-von", from.format("%d.%m.%Y").to_string()),
        ("TextLinks_E-bis", to.format("%d.%m.%Y").to_string()),
        (
            "TextMehrzeiligLinks_Empfaenger",
            format!("{}\n{}", identity.name, identity.address),
        ),
        (
            "TextMehrzeiligLinks_Bestaetigung",
            identity.employer_contact.clone(),
        ),
        ("TextLinks_I", identity.place_date.clone()),
    ] {
        values.insert(key.into(), FormValue::Text(value));
    }
    let remarks = joined(vec![
        input.remarks.trim().into(),
        input.realization_note.trim().into(),
        input
            .extras
            .iter()
            .filter(|extra| extra.box_id == "12")
            .map(|extra| {
                format!(
                    "Ch. 12 - {} : {} CHF",
                    extra.label,
                    exact_amount(extra.amount_cents)
                )
            })
            .collect::<Vec<_>>()
            .join("; "),
        if excluded.is_empty() {
            String::new()
        } else {
            format!("Retenues hors net fiscal : {}", excluded.join("; "))
        },
    ]);
    for (prefix, value) in [("14", input.benefits.clone()), ("15", remarks)] {
        let mut wrapped = wrap_observations(&value, if prefix == "14" { 70 } else { 95 });
        if wrapped.len() > 2 {
            annex.push(format!("Ch. {prefix} : {value}"));
            wrapped = vec!["Voir annexe jointe au certificat de salaire.".into()];
        }
        for index in 0..2 {
            values.insert(
                format!("TextLinks_{prefix}_{}", index + 1),
                FormValue::Text(wrapped.get(index).cloned().unwrap_or_default()),
            );
        }
    }
    if !annex.is_empty() {
        annex.insert(
            0,
            format!(
                "Annexe au certificat de salaire {} - {} - AVS {}",
                input.year, identity.name, identity.avs_number
            ),
        );
    }
    Ok((values, annex))
}
fn exact_amount(cents: i64) -> String {
    format!(
        "{}{}.{:02}",
        if cents < 0 { "-" } else { "" },
        cents.unsigned_abs() / 100,
        cents.unsigned_abs() % 100
    )
}

fn rounded_amounts(amounts: &BTreeMap<String, i64>) -> BTreeMap<String, i64> {
    let mut rounded: BTreeMap<String, i64> = amounts
        .iter()
        .map(|(key, cents)| {
            (
                key.clone(),
                if *cents < 0 {
                    -((-cents + 50) / 100)
                } else {
                    (cents + 50) / 100
                },
            )
        })
        .collect();
    let deductions: i64 = ["9", "10_1", "10_2"]
        .iter()
        .map(|key| rounded.get(*key).copied().unwrap_or(0))
        .sum();
    let target_gross = rounded["11"] + deductions;
    let printed_gross: i64 = EARNINGS
        .iter()
        .map(|key| rounded.get(*key).copied().unwrap_or(0))
        .sum();
    let difference = target_gross - printed_gross;
    if difference != 0 {
        // Prefer an existing ancillary benefit; never introduce a fictitious
        // tax box merely to carry a rounding difference.
        let target = EARNINGS
            .iter()
            .copied()
            .filter(|key| {
                rounded.get(*key).copied().unwrap_or(0) + difference >= 0
                    && amounts.get(*key).copied().unwrap_or(0) > 0
            })
            .max_by_key(|key| (*key != "1", amounts.get(*key).copied().unwrap_or(0)));
        if let Some(key) = target {
            *rounded.entry(key.into()).or_default() += difference;
        }
    }
    rounded.insert("8".into(), target_gross);
    rounded
}
fn wrap_observations(value: &str, width: usize) -> Vec<String> {
    let mut lines = vec![];
    let mut current = String::new();
    for word in value.split_whitespace() {
        if !current.is_empty() && current.chars().count() + word.chars().count() + 1 > width {
            lines.push(current);
            current = String::new();
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

#[cfg(test)]
#[path = "salary_certificate_tests.rs"]
mod tests;
