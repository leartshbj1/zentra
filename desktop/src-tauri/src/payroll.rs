use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    accounting::{post_payslip_if_enabled, post_payslip_payment_if_enabled, validate_date},
    audit::append_audit,
    database::{enrich_issuer_snapshot, now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
    models::{
        ApplyPayrollInput, CalculateEmployeePayrollInput, CalculatePayrollInput,
        ContributionDefinitionInput, ContributionSelectionInput, OnboardingIssue, PayPayslipInput,
        PostPayslipInput, SavePayslipWithContributionsInput,
    },
    swiss_payroll_rules::{
        ac_is_due, ac_reference_age_status_for_period, apply_avs_reference_age_allowance,
        avs_is_due_for_period, prorated_ac_ceiling_through_period,
        SWISS_AC_ANNUAL_CEILING_CENTS_2026,
    },
};

const CH_2026_SOURCE: &str = "https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/Ypzfdm2t_km4jeHFYxWRdA/Document/Tableau%20synoptique%2020-1.pdf";
const SETTINGS_RATE_ID_PREFIX: &str = "settings-rate-";
const SETTINGS_RATE_SOURCE: &str = "Questionnaire local Elyko (saisie client)";

#[derive(Debug)]
struct Definition {
    id: String,
    code: String,
    label: String,
    category: String,
    side: String,
    calculation_kind: String,
    rate_bp: Option<i64>,
    fixed_amount_cents: Option<i64>,
    annual_ceiling_cents: Option<i64>,
    basis_kind: String,
    source: String,
    effective_from: String,
    effective_to: Option<String>,
    liability_account_id: Option<String>,
    expense_account_id: Option<String>,
}

#[derive(Debug)]
struct EmployeePayrollContext {
    id: String,
    birth_date: Option<String>,
    employment_start: Option<String>,
    employment_end: Option<String>,
    reference_age_date: Option<String>,
    avs_allowance_waived: Option<bool>,
    contractual_weekly_minutes: Option<i64>,
    ac_opening_year: Option<i64>,
    ac_opening_basis_cents: Option<i64>,
}

#[derive(Debug)]
struct PreparedSettingsRate {
    id: String,
    code: String,
    label: String,
    side: &'static str,
    rate_bp: i64,
    annual_ceiling_cents: Option<i64>,
    source: String,
    effective_from: String,
    active: bool,
}

/// Extrait les anciennes listes de taux du questionnaire et les neutralise dans
/// les réglages persistés. Le retour est importé une seule fois dans le moteur.
pub(crate) fn take_explicit_settings_rates(extra_settings: &mut Value) -> Option<Value> {
    let payroll = extra_settings.get_mut("payroll")?.as_object_mut()?;
    let should_import = ["employeeRates", "employerRates"].iter().any(|field| {
        payroll.get(*field).is_some_and(|value| match value {
            Value::Array(values) => !values.is_empty(),
            Value::Null => false,
            _ => true,
        })
    });
    if !should_import {
        return None;
    }
    let original = Value::Object(payroll.clone());
    payroll.insert("employeeRates".into(), json!([]));
    payroll.insert("employerRates".into(), json!([]));
    payroll.insert("ratesImported".into(), json!(true));
    Some(json!({"payroll":original}))
}

fn onboarding_rate_issue(field: String, label: &str, message: String) -> OnboardingIssue {
    OnboardingIssue {
        step: 4,
        field,
        label: label.into(),
        message,
    }
}

fn prepare_explicit_settings_rates(
    extra_settings: &Value,
) -> Result<Vec<PreparedSettingsRate>, Vec<OnboardingIssue>> {
    let Some(payroll) = extra_settings.get("payroll").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let enabled = payroll
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut external_keys = HashSet::new();
    let mut prepared = Vec::new();
    let mut issues = Vec::new();
    for (field, side, code_side) in [
        ("employeeRates", "employee", "E"),
        ("employerRates", "employer", "R"),
    ] {
        let rates = match payroll.get(field) {
            None | Some(Value::Null) => &[][..],
            Some(Value::Array(rates)) => rates.as_slice(),
            Some(_) => {
                issues.push(onboarding_rate_issue(
                    format!("payroll.{field}"),
                    "Les taux de paie",
                    format!("payroll.{field} doit être une liste de taux explicites."),
                ));
                continue;
            }
        };
        for (index, rate) in rates.iter().enumerate() {
            let Some(object) = rate.as_object() else {
                issues.push(onboarding_rate_issue(
                    format!("payroll.{field}.{index}"),
                    "Le taux de paie",
                    format!("Chaque entrée payroll.{field} doit être un objet."),
                ));
                continue;
            };
            let raw_id = object.get("id").and_then(Value::as_str).unwrap_or("");
            let external_id = raw_id.trim();
            let path_key = if external_id.is_empty() {
                index.to_string()
            } else {
                external_id.to_owned()
            };
            let path = format!("payroll.{field}.{path_key}");
            let issue_count = issues.len();
            if external_id.is_empty() || external_id.chars().count() > 500 {
                issues.push(onboarding_rate_issue(
                    format!("{path}.id"),
                    "L’identifiant du taux",
                    "L’identifiant du taux est obligatoire et limité à 500 caractères.".into(),
                ));
            }
            let external_key = format!("{side}:{external_id}");
            if !external_id.is_empty() && !external_keys.insert(external_key.clone()) {
                issues.push(onboarding_rate_issue(
                    format!("{path}.id"),
                    "L’identifiant du taux",
                    format!(
                        "Le taux {external_id} est présent plusieurs fois dans payroll.{field}."
                    ),
                ));
            }
            let label = object
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if label.is_empty() || label.chars().count() > 200 {
                issues.push(onboarding_rate_issue(
                    format!("{path}.label"),
                    "Le libellé du taux",
                    "Le libellé du taux est obligatoire et limité à 200 caractères.".into(),
                ));
            }
            let rate_bp = object.get("rateBp").and_then(Value::as_i64);
            if !rate_bp.is_some_and(|value| (1..=10_000).contains(&value)) {
                issues.push(onboarding_rate_issue(
                    format!("{path}.rateBp"),
                    "Le taux",
                    "Le taux doit être compris entre 0,01 % et 100 %.".into(),
                ));
            }
            let effective_from = object
                .get("effectiveFrom")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if effective_from.is_empty()
                || effective_from.chars().count() > 10
                || validate_date(effective_from, "payroll rate effectiveFrom").is_err()
            {
                issues.push(onboarding_rate_issue(
                    format!("{path}.effectiveFrom"),
                    "La date d’effet",
                    "La date d’effet doit être une date valide au format AAAA-MM-JJ.".into(),
                ));
            }
            let annual_ceiling_cents = match object.get("annualCeilingCents") {
                None | Some(Value::Null) => None,
                Some(value) => match value.as_i64().filter(|amount| *amount > 0) {
                    Some(amount) => Some(amount),
                    None => {
                        issues.push(onboarding_rate_issue(
                            format!("{path}.annualCeilingCents"),
                            "Le plafond annuel",
                            "Le plafond annuel doit être un montant positif.".into(),
                        ));
                        None
                    }
                },
            };
            if issues.len() != issue_count {
                continue;
            }
            let source = object
                .get("sourceUrl")
                .and_then(Value::as_str)
                .or_else(|| object.get("sourceLabel").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(SETTINGS_RATE_SOURCE)
                .to_owned();
            let mut hasher = Sha256::new();
            hasher.update(external_key.as_bytes());
            let hash = format!("{:x}", hasher.finalize());
            prepared.push(PreparedSettingsRate {
                id: format!("{SETTINGS_RATE_ID_PREFIX}{side}-{}", &hash[..32]),
                code: format!("SET_{code_side}_{}", hash.to_uppercase()),
                label: label.to_owned(),
                side,
                rate_bp: rate_bp.expect("validated rate"),
                annual_ceiling_cents,
                source,
                effective_from: effective_from.to_owned(),
                active: enabled,
            });
        }
    }
    if issues.is_empty() {
        Ok(prepared)
    } else {
        Err(issues)
    }
}

pub(crate) fn explicit_settings_rate_issues(extra_settings: &Value) -> Vec<OnboardingIssue> {
    prepare_explicit_settings_rates(extra_settings)
        .err()
        .unwrap_or_default()
}

/// Importe uniquement les taux explicitement présents dans le questionnaire.
/// `ON CONFLICT DO NOTHING` protège toute définition déjà personnalisée. Les
/// identifiants déterministes empêchent les doublons en cas de reprise après erreur.
pub(crate) fn import_explicit_settings_rates(
    transaction: &Transaction<'_>,
    extra_settings: &Value,
) -> AppResult<()> {
    let rates = prepare_explicit_settings_rates(extra_settings).map_err(|issues| {
        AppError::Validation(
            issues
                .into_iter()
                .map(|issue| issue.message)
                .collect::<Vec<_>>()
                .join(" "),
        )
    })?;
    for rate in rates {
        let now = now_iso();
        transaction.execute(
            "INSERT INTO payroll_contribution_definitions(id,code,label,category,side,calculation_kind,rate_bp,fixed_amount_cents,annual_ceiling_cents,basis_kind,source,effective_from,effective_to,active,liability_account_id,expense_account_id,created_at,updated_at) VALUES(?,?,?,'other',?,'rate',?,NULL,?,'gross',?,?,NULL,?,NULL,NULL,?,?) ON CONFLICT DO NOTHING",
            params![rate.id,rate.code,rate.label,rate.side,rate.rate_bp,rate.annual_ceiling_cents,rate.source,rate.effective_from,rate.active as i64,now,now],
        )?;
    }
    Ok(())
}

impl LocalStore {
    /// Profil réglementaire explicite, jamais installé automatiquement.
    pub fn get_payroll_regulatory_profiles(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(json!([{
            "id":"CH-2026",
            "label":"Suisse 2026 - cotisations fédérales par part",
            "source":CH_2026_SOURCE,
            "effective_from":"2026-01-01",
            "effective_to":"2026-12-31",
            "definitions":[
                profile_line("AVS_EMPLOYEE","AVS salarié", "avs_ai_apg","employee",435,None),
                profile_line("AVS_EMPLOYER","AVS employeur", "avs_ai_apg","employer",435,None),
                profile_line("AI_EMPLOYEE","AI salarié", "avs_ai_apg","employee",70,None),
                profile_line("AI_EMPLOYER","AI employeur", "avs_ai_apg","employer",70,None),
                profile_line("APG_EMPLOYEE","APG salarié", "avs_ai_apg","employee",25,None),
                profile_line("APG_EMPLOYER","APG employeur", "avs_ai_apg","employer",25,None),
                profile_line("AC_EMPLOYEE","AC salarié", "ac","employee",110,Some(SWISS_AC_ANNUAL_CEILING_CENTS_2026)),
                profile_line("AC_EMPLOYER","AC employeur", "ac","employer",110,Some(SWISS_AC_ANNUAL_CEILING_CENTS_2026))
            ],
            "not_included":["lpp","aanp","aap","ijm","family_allowance","source_tax","other"]
        }]))
    }

    pub fn list_payroll_contribution_definitions(&self, as_of: Option<String>) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        match as_of {
            Some(date) => {
                validate_date(&date, "as_of")?;
                Ok(Value::Array(query_all(&connection,"SELECT * FROM payroll_contribution_definitions WHERE effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY code",params![date,date])?))
            }
            None => Ok(Value::Array(query_all(
                &connection,
                "SELECT * FROM payroll_contribution_definitions ORDER BY effective_from DESC,code",
                [],
            )?)),
        }
    }

    pub fn get_payslip_contributions(&self, payslip_id: &str) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(Value::Array(query_all(
            &connection,
            "SELECT * FROM payslip_contributions WHERE payslip_id=? ORDER BY rowid",
            params![payslip_id],
        )?))
    }

    pub fn upsert_payroll_contribution_definition(
        &self,
        input: ContributionDefinitionInput,
    ) -> AppResult<Value> {
        validate_definition_input(&input)?;
        let id = input
            .id
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = now_iso();
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        validate_contribution_accounts(&tx, &input)?;
        tx.execute("INSERT INTO payroll_contribution_definitions(id,code,label,category,side,calculation_kind,rate_bp,fixed_amount_cents,annual_ceiling_cents,basis_kind,source,effective_from,effective_to,active,liability_account_id,expense_account_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,label=excluded.label,category=excluded.category,side=excluded.side,calculation_kind=excluded.calculation_kind,rate_bp=excluded.rate_bp,fixed_amount_cents=excluded.fixed_amount_cents,annual_ceiling_cents=excluded.annual_ceiling_cents,basis_kind=excluded.basis_kind,source=excluded.source,effective_from=excluded.effective_from,effective_to=excluded.effective_to,active=excluded.active,liability_account_id=excluded.liability_account_id,expense_account_id=excluded.expense_account_id,updated_at=excluded.updated_at",params![id,input.code.trim().to_uppercase(),input.label.trim(),input.category,input.side,input.calculation_kind,input.rate_bp,input.fixed_amount_cents,input.annual_ceiling_cents,input.basis_kind,input.source.trim(),input.effective_from,input.effective_to,input.active as i64,input.liability_account_id,input.expense_account_id,now,now])?;
        let record = tx.query_row(
            "SELECT * FROM payroll_contribution_definitions WHERE id=?",
            params![id],
            crate::database::row_to_json_public,
        )?;
        append_audit(
            &tx,
            "upsert",
            "payroll_contribution_definition",
            &id,
            &record,
        )?;
        tx.commit()?;
        Ok(record)
    }

    pub fn delete_payroll_contribution_definition(&self, id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record = tx
            .query_row(
                "SELECT * FROM payroll_contribution_definitions WHERE id=?",
                params![id],
                crate::database::row_to_json_public,
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("payroll_contribution_definitions/{id}")))?;
        let used: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM payslip_contributions WHERE definition_id=?)",
            params![id],
            |r| r.get(0),
        )?;
        if used {
            return Err(AppError::Validation("Cette cotisation figure déjà sur une fiche de salaire et ne peut plus être supprimée.".into()));
        }
        tx.execute(
            "DELETE FROM payroll_contribution_definitions WHERE id=?",
            params![id],
        )?;
        append_audit(
            &tx,
            "delete",
            "payroll_contribution_definition",
            id,
            &record,
        )?;
        tx.commit()?;
        Ok(json!({"deleted":true,"id":id}))
    }

    pub fn calculate_payroll_contributions(
        &self,
        input: CalculatePayrollInput,
    ) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        calculate(
            &connection,
            &input.period,
            input.gross_cents,
            &input.items,
            None,
        )
    }

    pub fn calculate_employee_payroll_contributions(
        &self,
        input: CalculateEmployeePayrollInput,
    ) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let employee = load_employee_payroll_context(&connection, input.employee_id.trim())?;
        calculate(
            &connection,
            &input.period,
            input.gross_cents,
            &input.items,
            Some(&employee),
        )
    }

    pub fn apply_payroll_contributions(&self, input: ApplyPayrollInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = apply_contributions_tx(&tx, &input.payslip_id, &input.period, &input.items)?;
        append_audit(
            &tx,
            "apply_contributions",
            "payslip",
            &input.payslip_id,
            &result,
        )?;
        tx.commit()?;
        Ok(result)
    }

    pub fn save_payslip_with_contributions(
        &self,
        input: SavePayslipWithContributionsInput,
    ) -> AppResult<Value> {
        validate_atomic_payslip_input(&input)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        let existing_id = input
            .id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let payslip_id = existing_id
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let previous = if existing_id.is_some() {
            Some(
                tx.query_row(
                    "SELECT * FROM payslips WHERE id=?",
                    params![payslip_id],
                    crate::database::row_to_json_public,
                )
                .optional()?
                .ok_or_else(|| AppError::NotFound(format!("payslips/{payslip_id}")))?,
            )
        } else {
            None
        };
        if previous.as_ref().is_some_and(|row| {
            row["status"]
                .as_str()
                .is_some_and(|status| matches!(status, "comptabilise" | "paye"))
        }) {
            return Err(AppError::Validation(
                "Une fiche comptabilisée ou payée est immuable.".into(),
            ));
        }
        let employee_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM employees WHERE id=?)",
            params![input.employee_id.trim()],
            |row| row.get(0),
        )?;
        if !employee_exists {
            return Err(AppError::NotFound(format!(
                "employees/{}",
                input.employee_id.trim()
            )));
        }
        let payment_date = input
            .payment_date
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let notes = input
            .notes
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if previous.is_some() {
            tx.execute("UPDATE payslips SET employee_id=?,period=?,status=?,payment_date=?,notes=?,updated_at=? WHERE id=?",params![input.employee_id.trim(),input.period,input.status,payment_date,notes,now,payslip_id])?;
        } else {
            tx.execute("INSERT INTO payslips(id,employee_id,period,status,gross_cents,deductions_cents,net_cents,employer_costs_cents,payment_date,notes,created_at,updated_at) VALUES(?,?,?,?,0,0,0,0,?,?,?,?)",params![payslip_id,input.employee_id.trim(),input.period,input.status,payment_date,notes,now,now])?;
        }

        tx.execute(
            "DELETE FROM payslip_contributions WHERE payslip_id=?",
            params![payslip_id],
        )?;
        tx.execute(
            "DELETE FROM payslip_items WHERE payslip_id=?",
            params![payslip_id],
        )?;
        for (position, line) in input.lines.iter().enumerate() {
            let line_id = line
                .id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            tx.execute("INSERT INTO payslip_items(id,payslip_id,position,label,kind,amount_cents,posting_account_id,expense_account_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",params![line_id,payslip_id,position as i64,line.label.trim(),line.kind,line.amount_cents,line.posting_account_id.as_deref(),line.expense_account_id.as_deref(),now,now])?;
        }
        recompute_payslip(&tx, &payslip_id)?;
        let contribution_result =
            apply_contributions_tx(&tx, &payslip_id, &input.period, &input.contributions)?;
        if input.status == "valide" {
            validate_validated_swiss_payslip(
                &tx,
                input.employee_id.trim(),
                &input.period,
                &contribution_result["calculation"],
            )?;
        }
        let result = json!({
            "payslip": contribution_result["payslip"].clone(),
            "manual_lines": query_all(&tx,"SELECT pi.* FROM payslip_items pi LEFT JOIN payslip_contributions pc ON pc.payslip_item_id=pi.id WHERE pi.payslip_id=? AND pc.id IS NULL ORDER BY pi.position,pi.rowid",params![payslip_id])?,
            "calculation": contribution_result["calculation"].clone(),
            "contributions": contribution_result["contributions"].clone()
        });
        append_audit(
            &tx,
            if previous.is_some() {
                "update"
            } else {
                "create"
            },
            "payslip_atomic",
            &payslip_id,
            &json!({"before":previous,"after":result.clone()}),
        )?;
        tx.commit()?;
        Ok(result)
    }

    pub fn post_payslip(&self, input: PostPayslipInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (period, status, employee_id, gross_cents): (String, String, String, i64) = tx
            .query_row(
                "SELECT period,status,employee_id,gross_cents FROM payslips WHERE id=?",
                params![input.payslip_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("payslips/{}", input.payslip_id)))?;
        let date = input.entry_date.unwrap_or_else(|| format!("{}-01", period));
        validate_date(&date, "entry_date")?;
        if status == "paye" {
            return Err(AppError::Validation(
                "La fiche de salaire est déjà payée.".into(),
            ));
        }
        if status == "comptabilise" {
            let payslip = tx.query_row(
                "SELECT * FROM payslips WHERE id=?",
                params![input.payslip_id],
                crate::database::row_to_json_public,
            )?;
            tx.commit()?;
            return Ok(json!({"payslip":payslip,"journal":null}));
        }
        if status != "valide" {
            return Err(AppError::Validation(
                "Seule une fiche de salaire au statut valide peut être comptabilisée.".into(),
            ));
        }
        let persisted_items = query_all(
            &tx,
            "SELECT pc.*,d.code,d.annual_ceiling_cents AS statutory_annual_ceiling_cents \
             FROM payslip_contributions pc \
             JOIN payroll_contribution_definitions d ON d.id=pc.definition_id \
             WHERE pc.payslip_id=? ORDER BY pc.rowid",
            params![input.payslip_id],
        )?;
        validate_validated_swiss_payslip(
            &tx,
            &employee_id,
            &period,
            &json!({"period":period,"gross_cents":gross_cents,"items":persisted_items}),
        )?;
        let journal = post_payslip_if_enabled(&tx, &input.payslip_id, &date)?.ok_or_else(|| {
            AppError::Validation(
                "La comptabilité doit être configurée et activée avant de comptabiliser une fiche de salaire."
                    .into(),
            )
        })?;
        let issuer=enrich_issuer_snapshot(tx.query_row("SELECT company_name,legal_form,owner_name,address_line1,address_line2,postal_code,city,canton,country,uid_number,vat_number,vat_registered,iban,bank_name,currency,logo_path,extra_settings_json,noga_section,noga_division,activity_description,noga_detailed_code FROM settings WHERE id=1",[],crate::database::row_to_json_public)?)?;
        let employee = tx.query_row(
            "SELECT e.* FROM employees e JOIN payslips p ON p.employee_id=e.id WHERE p.id=?",
            params![input.payslip_id],
            crate::database::row_to_json_public,
        )?;
        let current = tx.query_row(
            "SELECT * FROM payslips WHERE id=?",
            params![input.payslip_id],
            crate::database::row_to_json_public,
        )?;
        let items = query_all(
            &tx,
            "SELECT * FROM payslip_items WHERE payslip_id=? ORDER BY position,rowid",
            params![input.payslip_id],
        )?;
        let contributions = query_all(
            &tx,
            "SELECT * FROM payslip_contributions WHERE payslip_id=? ORDER BY rowid",
            params![input.payslip_id],
        )?;
        let snapshot = json!({"schema":"helvichantier.payslip_snapshot.v1","captured_at":now_iso(),"issuer":issuer,"employee":employee,"payslip":current,"items":items,"contributions":contributions});
        tx.execute(
            "UPDATE payslips SET status='comptabilise',snapshot_json=?,updated_at=? WHERE id=?",
            params![
                serde_json::to_string(&snapshot)?,
                now_iso(),
                input.payslip_id
            ],
        )?;
        let payslip = tx.query_row(
            "SELECT * FROM payslips WHERE id=?",
            params![input.payslip_id],
            crate::database::row_to_json_public,
        )?;
        append_audit(
            &tx,
            "post",
            "payslip",
            &input.payslip_id,
            &json!({"payslip":payslip,"journal":journal}),
        )?;
        tx.commit()?;
        Ok(json!({"payslip":payslip,"journal":journal}))
    }

    pub fn pay_payslip(&self, input: PayPayslipInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (status, stored_payment_date, stored_reference, stored_journal_id): (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = tx
            .query_row(
                "SELECT status,payment_date,payment_reference,payment_journal_entry_id FROM payslips WHERE id=?",
                params![input.payslip_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("payslips/{}", input.payslip_id)))?;
        let requested_reference = input
            .reference
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        if requested_reference
            .as_deref()
            .is_some_and(|value| value.chars().count() > 200 || value.chars().any(char::is_control))
        {
            return Err(AppError::Validation(
                "La référence de paiement est limitée à 200 caractères sans contrôle invisible."
                    .into(),
            ));
        }
        if status == "paye" {
            let requested_date = input
                .payment_date
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if requested_date.is_some_and(|value| stored_payment_date.as_deref() != Some(value))
                || requested_reference != stored_reference
            {
                return Err(AppError::Validation(
                    "Cette fiche est déjà payée avec une autre date ou référence.".into(),
                ));
            }
            let payslip = tx.query_row(
                "SELECT * FROM payslips WHERE id=?",
                params![input.payslip_id],
                crate::database::row_to_json_public,
            )?;
            let journal = stored_journal_id
                .as_deref()
                .map(|journal_id| payroll_payment_journal(&tx, journal_id))
                .transpose()?;
            tx.commit()?;
            return Ok(json!({"payslip":payslip,"journal":journal,"idempotent":true}));
        }
        if status != "comptabilise" {
            return Err(AppError::Validation(
                "Seule une fiche comptabilisée peut être marquée comme payée.".into(),
            ));
        }
        let payment_date = input
            .payment_date
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
        validate_date(&payment_date, "payment_date")?;
        let journal = post_payslip_payment_if_enabled(
            &tx,
            &input.payslip_id,
            &payment_date,
            requested_reference.as_deref(),
        )?
        .ok_or_else(|| {
            AppError::Validation(
                "La comptabilité doit être configurée et activée avant de payer une fiche de salaire."
                    .into(),
            )
        })?;
        let journal_id = journal["id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("L'écriture de paiement est invalide.".into()))?;
        tx.execute(
            "UPDATE payslips SET status='paye',payment_date=?,payment_reference=?,payment_journal_entry_id=?,updated_at=? WHERE id=?",
            params![
                payment_date,
                requested_reference,
                journal_id,
                now_iso(),
                input.payslip_id
            ],
        )?;
        let payslip = tx.query_row(
            "SELECT * FROM payslips WHERE id=?",
            params![input.payslip_id],
            crate::database::row_to_json_public,
        )?;
        append_audit(
            &tx,
            "payment",
            "payslip",
            &input.payslip_id,
            &json!({
                "from":"comptabilise",
                "to":"paye",
                "payment_date":payment_date,
                "payment_reference":requested_reference,
                "journal":journal
            }),
        )?;
        tx.commit()?;
        Ok(json!({"payslip":payslip,"journal":journal,"idempotent":false}))
    }
}

fn payroll_payment_journal(tx: &Transaction<'_>, journal_id: &str) -> AppResult<Value> {
    let entry = tx
        .query_row(
            "SELECT * FROM journal_entries WHERE id=? AND source_type='payslip' AND source_event='payment'",
            params![journal_id],
            crate::database::row_to_json_public,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("journal_entries/{journal_id}")))?;
    let lines = query_all(
        tx,
        "SELECT jl.*,a.code AS account_code,a.name AS account_name FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.journal_entry_id=? ORDER BY jl.rowid",
        params![journal_id],
    )?;
    Ok(json!({"entry":entry,"lines":lines,"id":journal_id}))
}

fn validate_atomic_payslip_input(input: &SavePayslipWithContributionsInput) -> AppResult<()> {
    if input.employee_id.trim().is_empty() {
        return Err(AppError::Validation("employee_id est obligatoire.".into()));
    }
    period_date(&input.period)?;
    if !matches!(
        input.status.as_str(),
        "brouillon" | "a_controler" | "valide"
    ) {
        return Err(AppError::Validation(
            "status doit être brouillon, a_controler ou valide.".into(),
        ));
    }
    if let Some(payment_date) = input
        .payment_date
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_date(payment_date, "payment_date")?;
    }
    if input.lines.is_empty() {
        return Err(AppError::Validation(
            "La fiche doit contenir au moins une ligne manuelle.".into(),
        ));
    }
    let mut line_ids = HashSet::new();
    for line in &input.lines {
        if line.label.trim().is_empty() || line.label.chars().count() > 200 {
            return Err(AppError::Validation(
                "Chaque ligne exige un libellé limité à 200 caractères.".into(),
            ));
        }
        if !matches!(
            line.kind.as_str(),
            "earning" | "deduction" | "employer" | "reimbursement"
        ) {
            return Err(AppError::Validation(
                "kind doit être earning, deduction, employer ou reimbursement.".into(),
            ));
        }
        if line.amount_cents < 0 {
            return Err(AppError::Validation(
                "amount_cents ne peut pas être négatif.".into(),
            ));
        }
        if let Some(id) = line
            .id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            if !line_ids.insert(id) {
                return Err(AppError::Validation(format!(
                    "Identifiant de ligne dupliqué : {id}."
                )));
            }
        }
    }
    Ok(())
}

fn apply_contributions_tx(
    tx: &Transaction<'_>,
    payslip_id: &str,
    requested_period: &str,
    items: &[ContributionSelectionInput],
) -> AppResult<Value> {
    let (period, gross, status, employee_id): (String, i64, String, String) = tx
        .query_row(
            "SELECT period,gross_cents,status,employee_id FROM payslips WHERE id=?",
            params![payslip_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("payslips/{payslip_id}")))?;
    if period != requested_period {
        return Err(AppError::Validation(
            "La période demandée ne correspond pas à la fiche de salaire.".into(),
        ));
    }
    if matches!(status.as_str(), "comptabilise" | "paye") {
        return Err(AppError::Validation(
            "Une fiche comptabilisée ou payée est immuable.".into(),
        ));
    }
    let employee = load_employee_payroll_context(tx, &employee_id)?;
    let calculation = calculate(tx, &period, gross, items, Some(&employee))?;
    if status == "valide" {
        validate_validated_swiss_payslip(tx, &employee_id, &period, &calculation)?;
    }
    let existing_ids = query_all(
        tx,
        "SELECT payslip_item_id FROM payslip_contributions WHERE payslip_id=?",
        params![payslip_id],
    )?;
    tx.execute(
        "DELETE FROM payslip_contributions WHERE payslip_id=?",
        params![payslip_id],
    )?;
    for row in existing_ids {
        if let Some(id) = row["payslip_item_id"].as_str() {
            tx.execute("DELETE FROM payslip_items WHERE id=?", params![id])?;
        }
    }
    let now = now_iso();
    for (position, item) in calculation["items"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let item_id = Uuid::new_v4().to_string();
        let contribution_id = Uuid::new_v4().to_string();
        let side = item["side"].as_str().unwrap_or("");
        let kind = if side == "employee" {
            "deduction"
        } else {
            "employer"
        };
        tx.execute("INSERT INTO payslip_items(id,payslip_id,position,label,kind,amount_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",params![item_id,payslip_id,10_000_i64+position as i64,item["label"].as_str(),kind,item["amount_cents"].as_i64(),now,now])?;
        tx.execute("INSERT INTO payslip_contributions(id,payslip_id,definition_id,payslip_item_id,label,category,side,calculation_kind,basis_kind,basis_cents,year_to_date_basis_cents,rate_bp,fixed_amount_cents,annual_ceiling_cents,amount_cents,source,effective_from,effective_to,liability_account_id,expense_account_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![contribution_id,payslip_id,item["definition_id"].as_str(),item_id,item["label"].as_str(),item["category"].as_str(),side,item["calculation_kind"].as_str(),item["basis_kind"].as_str(),item["basis_cents"].as_i64(),item["year_to_date_basis_cents"].as_i64(),item["rate_bp"].as_i64(),item["fixed_amount_cents"].as_i64(),item["annual_ceiling_cents"].as_i64(),item["amount_cents"].as_i64(),item["source"].as_str(),item["effective_from"].as_str(),item["effective_to"].as_str(),item["liability_account_id"].as_str(),item["expense_account_id"].as_str(),now])?;
    }
    recompute_payslip(tx, payslip_id)?;
    Ok(
        json!({"payslip":tx.query_row("SELECT * FROM payslips WHERE id=?",params![payslip_id],crate::database::row_to_json_public)?,"calculation":calculation,"contributions":query_all(tx,"SELECT * FROM payslip_contributions WHERE payslip_id=? ORDER BY rowid",params![payslip_id])?}),
    )
}

fn calculate(
    connection: &Connection,
    period: &str,
    gross: i64,
    selections: &[ContributionSelectionInput],
    employee_context: Option<&EmployeePayrollContext>,
) -> AppResult<Value> {
    if gross < 0 {
        return Err(AppError::Validation(
            "gross_cents ne peut pas être négatif.".into(),
        ));
    }
    let date = period_date(period)?;
    validate_shared_statutory_bases(connection, gross, selections)?;
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    let mut employee = 0_i64;
    let mut employer = 0_i64;
    let mut avs_effective_basis: Option<(i64, String)> = None;
    let mut ac_effective_basis: Option<(i64, String)> = None;
    let mut derived_ac_ytd: Option<i64> = None;
    for selection in selections {
        if !seen.insert(&selection.definition_id) {
            return Err(AppError::Validation(format!(
                "Cotisation sélectionnée deux fois : {}",
                selection.definition_id
            )));
        }
        let def = load_definition(connection, &selection.definition_id)?;
        if date < def.effective_from || def.effective_to.as_ref().is_some_and(|to| date > *to) {
            return Err(AppError::Validation(format!(
                "La cotisation {} n'est pas valable pour {period}.",
                def.code
            )));
        }
        let mut basis = match (def.basis_kind.as_str(), selection.basis_cents) {
            ("gross", _) => gross,
            (_, Some(value)) => value,
            (_, None) => {
                return Err(AppError::Validation(format!(
                    "basis_cents doit être explicite pour {}.",
                    def.code
                )))
            }
        };
        if basis < 0 {
            return Err(AppError::Validation(
                "basis_cents ne peut pas être négatif.".into(),
            ));
        }
        let original_basis = basis;
        let statutory_employee = if matches!(def.category.as_str(), "avs_ai_apg" | "ac") {
            let employee = employee_context.ok_or_else(|| {
                AppError::Validation(format!(
                    "La cotisation {} exige un collaborateur et sa date de naissance pour contrôler l'assujettissement AVS/AC.",
                    def.code
                ))
            })?;
            let avs_due = avs_is_due_for_period(period, employee.birth_date.as_deref())
                .map_err(|error| AppError::Validation(error.to_string()))?;
            if !avs_due {
                return Err(AppError::Validation(format!(
                    "La cotisation {} ne doit pas être appliquée avant le 1er janvier suivant le 17e anniversaire.",
                    def.code
                )));
            }
            Some(employee)
        } else {
            None
        };
        let mut avs_allowance_applied = None;
        let mut avs_allowance_waived = None;
        if def.category == "avs_ai_apg" {
            let employee = statutory_employee.expect("statutory employee validated above");
            let reference_status = ac_reference_age_status_for_period(
                period,
                employee.birth_date.as_deref(),
                employee.reference_age_date.as_deref(),
            )
            .map_err(|error| AppError::Validation(error.to_string()))?;
            let application = apply_avs_reference_age_allowance(
                basis,
                reference_status,
                employee.avs_allowance_waived,
            )
            .map_err(|error| AppError::Validation(error.to_string()))?;
            basis = application.effective_basis_cents;
            avs_allowance_applied = Some(application.allowance_applied_cents);
            avs_allowance_waived = application.allowance_waived;
        }
        let statutory_annual_ceiling = def.annual_ceiling_cents;
        let mut effective_ceiling = statutory_annual_ceiling;
        let mut effective_ytd_basis = selection.year_to_date_basis_cents;
        let mut ac_proration_days = None;
        let mut ac_employment_from = None;
        let mut ac_employment_to = None;
        if def.category == "ac" {
            let employee = statutory_employee.expect("statutory employee validated above");
            let expected_ytd = match derived_ac_ytd {
                Some(value) => value,
                None => {
                    let value = derived_ac_year_to_date_basis(connection, employee, period)?;
                    derived_ac_ytd = Some(value);
                    value
                }
            };
            if selection
                .year_to_date_basis_cents
                .is_some_and(|provided| provided != expected_ytd)
            {
                return Err(AppError::Validation(format!(
                    "Le cumul annuel AC de {} doit être celui calculé localement par Elyko: {} centimes (ouverture confirmée et périodes antérieures), pas {:?}.",
                    def.code, expected_ytd, selection.year_to_date_basis_cents
                )));
            }
            effective_ytd_basis = Some(expected_ytd);
            let reference_status = ac_reference_age_status_for_period(
                period,
                employee.birth_date.as_deref(),
                employee.reference_age_date.as_deref(),
            )
            .map_err(|error| AppError::Validation(error.to_string()))?;
            match ac_is_due(reference_status) {
                Ok(true) => {}
                Ok(false) => {
                    return Err(AppError::Validation(format!(
                        "La cotisation {} ne doit pas être appliquée: la date confirmée de l'âge de référence est atteinte pour {period}.",
                        def.code
                    )))
                }
                Err(error) => return Err(AppError::Validation(error.to_string())),
            }
            let start = employee
                .employment_start
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    AppError::Validation(format!(
                        "La date d'entrée en fonction est obligatoire pour proratiser le plafond AC de {}.",
                        def.code
                    ))
                })?;
            let statutory_ceiling = statutory_annual_ceiling.ok_or_else(|| {
                AppError::Validation(format!(
                    "La cotisation AC {} doit posséder un plafond annuel explicite.",
                    def.code
                ))
            })?;
            let proration = prorated_ac_ceiling_through_period(
                statutory_ceiling,
                period,
                start,
                employee.employment_end.as_deref(),
            )
            .map_err(|error| AppError::Validation(error.to_string()))?;
            effective_ceiling = Some(proration.ceiling_cents);
            ac_proration_days = Some(proration.days_30_360);
            ac_employment_from = Some(proration.employment_from.to_string());
            ac_employment_to = Some(proration.employment_to.to_string());
        }
        if let Some(ceiling) = effective_ceiling {
            let ytd = effective_ytd_basis.ok_or_else(|| {
                AppError::Validation(format!(
                    "year_to_date_basis_cents est obligatoire pour la cotisation plafonnée {}.",
                    def.code
                ))
            })?;
            if ytd < 0 {
                return Err(AppError::Validation(
                    "year_to_date_basis_cents ne peut pas être négatif.".into(),
                ));
            }
            if def.category == "ac" && ytd > ceiling {
                return Err(AppError::Validation(format!(
                    "Le cumul annuel AC confirmé ({ytd} centimes) dépasse le plafond proratisé de {} centimes pour {period}.",
                    ceiling
                )));
            }
            basis = basis.min(ceiling.saturating_sub(ytd).max(0));
        }
        let effective_group = match def.category.as_str() {
            "avs_ai_apg" => Some((&mut avs_effective_basis, "AVS/AI/APG")),
            "ac" => Some((&mut ac_effective_basis, "AC")),
            _ => None,
        };
        if let Some((expected, label)) = effective_group {
            match expected {
                Some((expected_basis, expected_code)) if *expected_basis != basis => {
                    return Err(AppError::Validation(format!(
                        "La base effective {label} doit être identique pour toutes les parts: {} utilise {} centimes, contre {} centimes pour {}.",
                        def.code, basis, expected_basis, expected_code
                    )))
                }
                None => *expected = Some((basis, def.code.clone())),
                _ => {}
            }
        }
        let amount = match def.calculation_kind.as_str() {
            "rate" => round_rate(
                basis,
                def.rate_bp
                    .ok_or_else(|| AppError::Validation("rate_bp manquant.".into()))?,
            ),
            "fixed" => def
                .fixed_amount_cents
                .ok_or_else(|| AppError::Validation("fixed_amount_cents manquant.".into()))?,
            _ => unreachable!(),
        };
        if def.side == "employee" {
            employee = employee.saturating_add(amount)
        } else {
            employer = employer.saturating_add(amount)
        };
        items.push(json!({"definition_id":def.id,"code":def.code,"label":def.label,"category":def.category,"side":def.side,"calculation_kind":def.calculation_kind,"basis_kind":def.basis_kind,"original_basis_cents":original_basis,"basis_cents":basis,"year_to_date_basis_cents":effective_ytd_basis,"rate_bp":def.rate_bp,"fixed_amount_cents":def.fixed_amount_cents,"annual_ceiling_cents":effective_ceiling,"statutory_annual_ceiling_cents":statutory_annual_ceiling,"ac_proration_days_30_360":ac_proration_days,"ac_employment_from":ac_employment_from,"ac_employment_to":ac_employment_to,"avs_allowance_applied_cents":avs_allowance_applied,"avs_allowance_waived":avs_allowance_waived,"amount_cents":amount,"source":def.source,"effective_from":def.effective_from,"effective_to":def.effective_to,"liability_account_id":def.liability_account_id,"expense_account_id":def.expense_account_id}));
    }
    Ok(
        json!({"period":period,"gross_cents":gross,"employee_deductions_cents":employee,"employer_costs_cents":employer,"net_cents":gross.saturating_sub(employee),"items":items}),
    )
}

/// Les six lignes AVS/AI/APG représentent une seule assiette légale. Les
/// deux parts AC représentent elles aussi une seule assiette et un seul cumul.
/// Cette validation s'exécute avant tout calcul de montant et reste côté Rust,
/// même si un client contourne l'interface.
fn validate_shared_statutory_bases(
    connection: &Connection,
    gross: i64,
    selections: &[ContributionSelectionInput],
) -> AppResult<()> {
    let mut seen = HashSet::new();
    let mut avs_basis: Option<(i64, String)> = None;
    let mut ac_basis: Option<(i64, String)> = None;
    let mut ac_ytd: Option<(Option<i64>, String)> = None;
    for selection in selections {
        if !seen.insert(&selection.definition_id) {
            return Err(AppError::Validation(format!(
                "Cotisation sélectionnée deux fois : {}",
                selection.definition_id
            )));
        }
        let definition = load_definition(connection, &selection.definition_id)?;
        if !matches!(definition.category.as_str(), "avs_ai_apg" | "ac") {
            continue;
        }
        let basis = if definition.basis_kind == "gross" {
            gross
        } else {
            selection.basis_cents.ok_or_else(|| {
                AppError::Validation(format!(
                    "basis_cents doit être explicite pour {}.",
                    definition.code
                ))
            })?
        };
        if basis < 0 {
            return Err(AppError::Validation(
                "basis_cents ne peut pas être négatif.".into(),
            ));
        }
        let (expected_basis, label) = if definition.category == "avs_ai_apg" {
            (&mut avs_basis, "AVS/AI/APG")
        } else {
            (&mut ac_basis, "AC")
        };
        match expected_basis {
            Some((expected, expected_code)) if *expected != basis => {
                return Err(AppError::Validation(format!(
                    "La base {label} doit être identique pour toutes les lignes: {} utilise {} centimes, contre {} centimes pour {}.",
                    definition.code, basis, expected, expected_code
                )))
            }
            None => *expected_basis = Some((basis, definition.code.clone())),
            _ => {}
        }
        if definition.category == "ac" {
            match &ac_ytd {
                Some((expected, expected_code))
                    if *expected != selection.year_to_date_basis_cents =>
                {
                    return Err(AppError::Validation(format!(
                        "Le cumul annuel AC doit être identique pour toutes les parts: {} utilise {:?}, contre {:?} pour {}.",
                        definition.code,
                        selection.year_to_date_basis_cents,
                        expected,
                        expected_code
                    )))
                }
                None => {
                    ac_ytd = Some((
                        selection.year_to_date_basis_cents,
                        definition.code.clone(),
                    ))
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn payroll_setting_text<'a>(settings: &'a Value, pointer: &str) -> &'a str {
    settings
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
}

fn validate_official_federal_group(
    items: &[Value],
    category: &str,
    expected: &[(&str, &str, i64, Option<i64>)],
) -> AppResult<()> {
    let relevant = items
        .iter()
        .filter(|item| item["category"].as_str() == Some(category))
        .collect::<Vec<_>>();
    if relevant.len() != expected.len() {
        return Err(AppError::Validation(format!(
            "Le profil fédéral {category} est incomplet: {} ligne(s) sélectionnée(s), {} attendue(s).",
            relevant.len(),
            expected.len()
        )));
    }
    for (code, side, rate_bp, annual_ceiling) in expected {
        let Some(item) = relevant
            .iter()
            .find(|item| item["code"].as_str() == Some(*code))
        else {
            return Err(AppError::Validation(format!(
                "La cotisation fédérale {code} manque pour valider la fiche."
            )));
        };
        let actual_ceiling = item["statutory_annual_ceiling_cents"]
            .as_i64()
            .or_else(|| item["annual_ceiling_cents"].as_i64());
        if item["side"].as_str() != Some(*side)
            || item["calculation_kind"].as_str() != Some("rate")
            || item["basis_kind"].as_str() != Some("ahv_salary")
            || item["rate_bp"].as_i64() != Some(*rate_bp)
            || actual_ceiling != *annual_ceiling
            || item["source"].as_str() != Some(CH_2026_SOURCE)
            || item["effective_from"].as_str() != Some("2026-01-01")
            || item["effective_to"].as_str() != Some("2026-12-31")
        {
            return Err(AppError::Validation(format!(
                "La cotisation {code} ne correspond pas au profil fédéral suisse 2026 figé (part, taux, base, plafond, source ou dates)."
            )));
        }
    }
    Ok(())
}

/// Garde serveur du statut `valide`. L'interface ne constitue jamais une
/// frontière de sécurité : cette validation est rejouée dans la transaction
/// Rust avant chaque enregistrement ou modification d'une fiche validée.
fn validate_validated_swiss_payslip(
    connection: &Connection,
    employee_id: &str,
    period: &str,
    calculation: &Value,
) -> AppResult<()> {
    let items = calculation["items"].as_array().ok_or_else(|| {
        AppError::Validation("Le détail des cotisations calculées est invalide.".into())
    })?;
    let employee = load_employee_payroll_context(connection, employee_id)?;
    let settings_json: String = connection.query_row(
        "SELECT extra_settings_json FROM settings WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    let settings: Value = serde_json::from_str(&settings_json).map_err(|_| {
        AppError::Validation("La configuration locale de paie est illisible.".into())
    })?;
    if settings
        .pointer("/payroll/enabled")
        .and_then(Value::as_bool)
        != Some(true)
        || settings
            .pointer("/payroll/fiduciaryValidated")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(AppError::Validation(
            "Activez la paie et confirmez sa configuration avec la fiduciaire avant le statut valide."
                .into(),
        ));
    }
    let has_category = |category: &str| {
        items
            .iter()
            .any(|item| item["category"].as_str() == Some(category))
    };
    if has_category("source_tax") {
        return Err(AppError::Validation(
            "L’impôt à la source ne peut pas être validé comme cotisation à taux linéaire; saisissez le montant officiel cantonal comme retenue manuelle et conservez sa référence."
                .into(),
        ));
    }
    if !has_category("aap") {
        return Err(AppError::Validation(
            "La prime accidents professionnels AAP doit être configurée pour valider toute fiche de salarié."
                .into(),
        ));
    }
    if payroll_setting_text(&settings, "/payroll/accidentInsurer").is_empty() {
        return Err(AppError::Validation(
            "L’assureur accidents doit être renseigné avant de valider AAP/AANP.".into(),
        ));
    }
    let weekly_minutes = employee.contractual_weekly_minutes.ok_or_else(|| {
        AppError::Validation(
            "Confirmez les minutes contractuelles hebdomadaires pour décider l’assujettissement AANP."
                .into(),
        )
    })?;
    match (weekly_minutes >= 480, has_category("aanp")) {
        (true, false) => {
            return Err(AppError::Validation(
                "Le contrat atteint 8 heures par semaine: une couverture AANP explicite est obligatoire."
                    .into(),
            ))
        }
        (false, true) => {
            return Err(AppError::Validation(
                "AANP est sélectionnée alors que le contrat confirmé est inférieur à 8 heures par semaine."
                    .into(),
            ))
        }
        _ => {}
    }
    for (category, setting, message) in [
        (
            "lpp",
            "/payroll/pensionFund",
            "La caisse de pension doit être renseignée pour la cotisation LPP sélectionnée.",
        ),
        (
            "ijm",
            "/payroll/dailyAllowanceInsurer",
            "L’assureur IJM doit être renseigné pour la cotisation sélectionnée.",
        ),
        (
            "family_allowance",
            "/payroll/familyAllowanceFund",
            "La caisse d’allocations familiales doit être renseignée pour la cotisation sélectionnée.",
        ),
    ] {
        if has_category(category) && payroll_setting_text(&settings, setting).is_empty() {
            return Err(AppError::Validation(message.into()));
        }
    }

    let avs_due = avs_is_due_for_period(period, employee.birth_date.as_deref())
        .map_err(|error| AppError::Validation(error.to_string()))?;
    if !avs_due {
        if has_category("avs_ai_apg") || has_category("ac") {
            return Err(AppError::Validation(
                "AVS/AI/APG et AC ne doivent pas être appliquées avant le 1er janvier suivant le 17e anniversaire."
                    .into(),
            ));
        }
        return Ok(());
    }
    if !period.starts_with("2026-") {
        return Err(AppError::Validation(
            "Elyko ne possède un profil fédéral figé que pour 2026; chargez et contrôlez le profil officiel de l’année avant validation."
                .into(),
        ));
    }
    if payroll_setting_text(&settings, "/payroll/avsFund").is_empty() {
        return Err(AppError::Validation(
            "La caisse AVS doit être renseignée avant validation.".into(),
        ));
    }
    validate_official_federal_group(
        items,
        "avs_ai_apg",
        &[
            ("AVS_EMPLOYEE", "employee", 435, None),
            ("AVS_EMPLOYER", "employer", 435, None),
            ("AI_EMPLOYEE", "employee", 70, None),
            ("AI_EMPLOYER", "employer", 70, None),
            ("APG_EMPLOYEE", "employee", 25, None),
            ("APG_EMPLOYER", "employer", 25, None),
        ],
    )?;
    let reference_status = ac_reference_age_status_for_period(
        period,
        employee.birth_date.as_deref(),
        employee.reference_age_date.as_deref(),
    )
    .map_err(|error| AppError::Validation(error.to_string()))?;
    match reference_status {
        crate::swiss_payroll_rules::AcReferenceAgeStatus::ConfirmedSubject => {
            validate_official_federal_group(
                items,
                "ac",
                &[
                    (
                        "AC_EMPLOYEE",
                        "employee",
                        110,
                        Some(SWISS_AC_ANNUAL_CEILING_CENTS_2026),
                    ),
                    (
                        "AC_EMPLOYER",
                        "employer",
                        110,
                        Some(SWISS_AC_ANNUAL_CEILING_CENTS_2026),
                    ),
                ],
            )?;
            let expected_ytd = derived_ac_year_to_date_basis(connection, &employee, period)?;
            if items
                .iter()
                .filter(|item| item["category"].as_str() == Some("ac"))
                .any(|item| item["year_to_date_basis_cents"].as_i64() != Some(expected_ytd))
            {
                return Err(AppError::Validation(format!(
                    "Le cumul AC figé doit être {expected_ytd} centimes pour {period}."
                )));
            }
        }
        crate::swiss_payroll_rules::AcReferenceAgeStatus::ConfirmedExempt => {
            if has_category("ac") {
                return Err(AppError::Validation(
                    "L’AC ne doit plus être appliquée après le mois d’atteinte confirmé de l’âge de référence."
                        .into(),
                ));
            }
            if employee.avs_allowance_waived.is_none() {
                return Err(AppError::Validation(
                    "Confirmez si la franchise AVS après l’âge de référence est conservée ou abandonnée."
                        .into(),
                ));
            }
        }
        crate::swiss_payroll_rules::AcReferenceAgeStatus::NeedsReview => {
            return Err(AppError::Validation(
                "Le statut d’assujettissement après l’âge de référence doit être confirmé explicitement."
                    .into(),
            ))
        }
    }
    Ok(())
}

/// Le cumul AC ne fait jamais confiance à une valeur libre envoyée par le
/// client IPC. Il part d'une ouverture annuelle explicitement confirmée, puis
/// additionne une seule fois la base AC figée de chaque période antérieure.
fn derived_ac_year_to_date_basis(
    connection: &Connection,
    employee: &EmployeePayrollContext,
    period: &str,
) -> AppResult<i64> {
    let year = period
        .get(..4)
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or_else(|| AppError::Validation("La période AC est invalide.".into()))?;
    let opening_basis = match (employee.ac_opening_year, employee.ac_opening_basis_cents) {
        (Some(opening_year), Some(basis)) if opening_year == year => basis,
        (Some(opening_year), Some(_)) => {
            return Err(AppError::Validation(format!(
                "La base d’ouverture AC est confirmée pour {opening_year}, pas pour {year}. Confirmez l’ouverture {year}, même si elle vaut zéro."
            )))
        }
        (None, None) => {
            return Err(AppError::Validation(format!(
                "Confirmez la base d’ouverture AC {year} du collaborateur, même si elle vaut zéro."
            )))
        }
        _ => {
            return Err(AppError::Validation(
                "L’année et la base d’ouverture AC doivent être confirmées ensemble.".into(),
            ))
        }
    };
    if opening_basis < 0 {
        return Err(AppError::Validation(
            "La base d’ouverture AC ne peut pas être négative.".into(),
        ));
    }

    let year_start = format!("{year:04}-01");
    let mut statement = connection.prepare(
        "SELECT p.period,p.status,COUNT(pc.id),MIN(pc.basis_cents),MAX(pc.basis_cents) \
         FROM payslips p \
         LEFT JOIN payslip_contributions pc ON pc.payslip_id=p.id AND pc.category='ac' \
         WHERE p.employee_id=? AND p.period>=? AND p.period<? \
         GROUP BY p.id,p.period,p.status ORDER BY p.period",
    )?;
    let rows = statement.query_map(params![employee.id, year_start, period], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, Option<i64>>(4)?,
        ))
    })?;
    let mut ytd = opening_basis;
    for row in rows {
        let (prior_period, status, ac_part_count, minimum_basis, maximum_basis) = row?;
        if !matches!(status.as_str(), "valide" | "comptabilise" | "paye") {
            return Err(AppError::Validation(format!(
                "La fiche AC {prior_period} doit être validée avant de calculer la période {period}."
            )));
        }
        if ac_part_count != 2 || minimum_basis.is_none() || minimum_basis != maximum_basis {
            return Err(AppError::Validation(format!(
                "La fiche {prior_period} doit contenir exactement les deux parts AC sur la même base avant de continuer."
            )));
        }
        ytd = ytd
            .checked_add(maximum_basis.expect("validated AC basis"))
            .ok_or_else(|| {
                AppError::Validation("Le cumul annuel AC dépasse la capacité de calcul.".into())
            })?;
    }
    Ok(ytd)
}

fn load_employee_payroll_context(
    connection: &Connection,
    employee_id: &str,
) -> AppResult<EmployeePayrollContext> {
    if employee_id.is_empty() {
        return Err(AppError::Validation("employee_id est obligatoire.".into()));
    }
    connection
        .query_row(
            "SELECT id,birth_date,employment_start_date,employment_end_date,reference_age_date,avs_allowance_waived,contractual_weekly_minutes,ac_opening_year,ac_opening_basis_cents FROM employees WHERE id=?",
            params![employee_id],
            |row| {
                Ok(EmployeePayrollContext {
                    id: row.get(0)?,
                    birth_date: row.get(1)?,
                    employment_start: row.get(2)?,
                    employment_end: row.get(3)?,
                    reference_age_date: row.get(4)?,
                    avs_allowance_waived: row.get(5)?,
                    contractual_weekly_minutes: row.get(6)?,
                    ac_opening_year: row.get(7)?,
                    ac_opening_basis_cents: row.get(8)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("employees/{employee_id}")))
}

fn load_definition(connection: &Connection, id: &str) -> AppResult<Definition> {
    connection.query_row("SELECT id,code,label,category,side,calculation_kind,rate_bp,fixed_amount_cents,annual_ceiling_cents,basis_kind,source,effective_from,effective_to,liability_account_id,expense_account_id FROM payroll_contribution_definitions WHERE id=? AND active=1",params![id],|r|Ok(Definition{id:r.get(0)?,code:r.get(1)?,label:r.get(2)?,category:r.get(3)?,side:r.get(4)?,calculation_kind:r.get(5)?,rate_bp:r.get(6)?,fixed_amount_cents:r.get(7)?,annual_ceiling_cents:r.get(8)?,basis_kind:r.get(9)?,source:r.get(10)?,effective_from:r.get(11)?,effective_to:r.get(12)?,liability_account_id:r.get(13)?,expense_account_id:r.get(14)?})).optional()?.ok_or_else(||AppError::NotFound(format!("payroll_contribution_definitions/{id}")))
}
fn validate_definition_input(i: &ContributionDefinitionInput) -> AppResult<()> {
    if i.code.trim().is_empty() || i.label.trim().is_empty() || i.source.trim().is_empty() {
        return Err(AppError::Validation(
            "code, label et source sont obligatoires.".into(),
        ));
    }
    if !matches!(
        i.category.as_str(),
        "avs_ai_apg"
            | "ac"
            | "lpp"
            | "aanp"
            | "aap"
            | "ijm"
            | "family_allowance"
            | "source_tax"
            | "other"
    ) {
        return Err(AppError::Validation(
            "Catégorie de cotisation invalide.".into(),
        ));
    }
    if !matches!(i.side.as_str(), "employee" | "employer") {
        return Err(AppError::Validation(
            "side doit être employee ou employer.".into(),
        ));
    }
    if !matches!(
        i.basis_kind.as_str(),
        "gross" | "ahv_salary" | "coordinated" | "custom"
    ) {
        return Err(AppError::Validation("basis_kind invalide.".into()));
    }
    match i.calculation_kind.as_str(){"rate" if i.rate_bp.is_some()&&i.fixed_amount_cents.is_none()&&i.rate_bp.is_some_and(|v|(0..=10_000).contains(&v))=>{},"fixed" if i.fixed_amount_cents.is_some_and(|v|v>=0)&&i.rate_bp.is_none()=>{},_=>return Err(AppError::Validation("Une cotisation rate exige uniquement rate_bp; fixed exige uniquement fixed_amount_cents.".into()))}
    if i.annual_ceiling_cents.is_some_and(|v| v <= 0) {
        return Err(AppError::Validation(
            "annual_ceiling_cents doit être positif.".into(),
        ));
    }
    validate_date(&i.effective_from, "effective_from")?;
    if let Some(to) = i.effective_to.as_deref() {
        validate_date(to, "effective_to")?;
        if to < i.effective_from.as_str() {
            return Err(AppError::Validation(
                "effective_to précède effective_from.".into(),
            ));
        }
    }
    Ok(())
}

fn validate_contribution_accounts(
    connection: &Connection,
    input: &ContributionDefinitionInput,
) -> AppResult<()> {
    if input.side == "employee"
        && input
            .expense_account_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    {
        return Err(AppError::Validation(
            "expense_account_id est réservé aux charges de la part employeur.".into(),
        ));
    }
    for (id, expected_type, field) in [
        (
            input.liability_account_id.as_deref(),
            "liability",
            "liability_account_id",
        ),
        (
            input.expense_account_id.as_deref(),
            "expense",
            "expense_account_id",
        ),
    ] {
        let Some(id) = id.map(str::trim).filter(|value| !value.is_empty()) else {
            continue;
        };
        let account = connection
            .query_row(
                "SELECT account_type,active FROM accounts WHERE id=?",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "{field} référence un compte comptable introuvable."
                ))
            })?;
        if account.1 != 1 {
            return Err(AppError::Validation(format!(
                "{field} doit référencer un compte actif."
            )));
        }
        if account.0 != expected_type {
            return Err(AppError::Validation(format!(
                "{field} doit référencer un compte de type {expected_type}."
            )));
        }
    }
    Ok(())
}
fn period_date(period: &str) -> AppResult<String> {
    if period.len() != 7 {
        return Err(AppError::Validation(
            "period doit être au format AAAA-MM.".into(),
        ));
    }
    let date = format!("{period}-01");
    validate_date(&date, "period")?;
    Ok(date)
}
fn round_rate(basis: i64, rate: i64) -> i64 {
    ((basis as i128 * rate as i128 + 5_000) / 10_000) as i64
}
fn recompute_payslip(tx: &rusqlite::Transaction<'_>, id: &str) -> AppResult<()> {
    let (gross, deductions, employer_costs, reimbursements): (i64, i64, i64, i64) = tx
        .query_row(
            "SELECT COALESCE(SUM(CASE WHEN kind='earning' THEN amount_cents ELSE 0 END),0),COALESCE(SUM(CASE WHEN kind='deduction' THEN amount_cents ELSE 0 END),0),COALESCE(SUM(CASE WHEN kind='employer' THEN amount_cents ELSE 0 END),0),COALESCE(SUM(CASE WHEN kind='reimbursement' THEN amount_cents ELSE 0 END),0) FROM payslip_items WHERE payslip_id=?",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    tx.execute(
        "UPDATE payslips SET gross_cents=?,deductions_cents=?,net_cents=?,employer_costs_cents=?,updated_at=? WHERE id=?",
        params![
            gross,
            deductions,
            gross
                .saturating_add(reimbursements)
                .saturating_sub(deductions),
            employer_costs,
            now_iso(),
            id
        ],
    )?;
    Ok(())
}
fn profile_line(
    code: &str,
    label: &str,
    category: &str,
    side: &str,
    rate_bp: i64,
    ceiling: Option<i64>,
) -> Value {
    json!({"code":code,"label":label,"category":category,"side":side,"calculation_kind":"rate","rate_bp":rate_bp,"fixed_amount_cents":null,"annual_ceiling_cents":ceiling,"basis_kind":"ahv_salary","source":CH_2026_SOURCE,"effective_from":"2026-01-01","effective_to":"2026-12-31","active":true})
}
