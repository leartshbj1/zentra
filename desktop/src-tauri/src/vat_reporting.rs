use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

use chrono::{Datelike, Months, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[path = "vat_received.rs"]
mod received;

#[path = "vat_transition.rs"]
mod transition;

use crate::{
    accounting::{closed_accounting_through, validate_received_vat_accounting_configuration},
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{AppError, AppResult},
};

const ECH_STANDARD: &str = "eCH-0217";
const ECH_VERSION: &str = "2.0.0";
const ECH_NAMESPACE: &str = "http://www.ech.ch/xmlns/eCH-0217/2";
const ECH_0058_NAMESPACE: &str = "http://www.ech.ch/xmlns/eCH-0058/5";
const ECH_0108_NAMESPACE: &str = "http://www.ech.ch/xmlns/eCH-0108/7";
const MAX_ECH_RATE_LINES: usize = 100;
const MAX_MONEY_CENTS: i128 = 9_000_000_000_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatProfileInput {
    #[serde(default)]
    pub id: Option<String>,
    pub effective_from: String,
    #[serde(default)]
    pub effective_to: Option<String>,
    pub reporting_method: String,
    pub form_of_reporting: String,
    pub periodicity: String,
    #[serde(default = "default_net_basis")]
    pub gross_or_net: String,
    #[serde(default)]
    pub tdfn_activity_id: Option<String>,
    #[serde(default)]
    pub tdfn_rate_bp: Option<i64>,
    #[serde(default)]
    pub afc_authorization_confirmed: bool,
    #[serde(default)]
    pub notes: Option<String>,
    /// Ferme atomiquement le profil ouvert la veille de `effective_from`.
    #[serde(default)]
    pub close_previous_open_profile: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatProfile {
    pub id: String,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub reporting_method: String,
    pub form_of_reporting: String,
    pub periodicity: String,
    pub gross_or_net: String,
    pub tdfn_activity_id: Option<String>,
    pub tdfn_rate_bp: Option<i64>,
    pub afc_authorization_confirmed: bool,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatSourceClassificationInput {
    pub source_type: String,
    pub source_id: String,
    pub treatment: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListVatSourceClassificationsInput {
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatSourceClassification {
    pub id: String,
    pub source_type: String,
    pub source_id: String,
    pub treatment: String,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatAdjustmentInput {
    /// UUID stable genere par le client avant le premier appel. Une reprise
    /// reutilise strictement cet identifiant et le meme contenu normalise.
    pub request_id: String,
    pub adjustment_date: String,
    pub category: String,
    pub amount_cents: i64,
    #[serde(default)]
    pub tax_rate_bp: Option<i64>,
    pub description: String,
    #[serde(default)]
    pub evidence_reference: Option<String>,
    pub created_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReverseVatAdjustmentInput {
    /// UUID stable genere par le client avant le premier appel.
    pub request_id: String,
    pub original_adjustment_id: String,
    pub adjustment_date: String,
    pub description: String,
    #[serde(default)]
    pub evidence_reference: Option<String>,
    pub created_by: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListVatAdjustmentsInput {
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatAdjustment {
    pub sequence: i64,
    pub id: String,
    pub adjustment_date: String,
    pub category: String,
    pub amount_cents: i64,
    pub tax_rate_bp: Option<i64>,
    pub description: String,
    pub evidence_reference: Option<String>,
    pub reverses_adjustment_id: Option<String>,
    pub created_by: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatReturnPreviewInput {
    pub date_from: String,
    pub date_to: String,
    pub submission_type: String,
    #[serde(default)]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExportVatReturnInput {
    pub date_from: String,
    pub date_to: String,
    pub submission_type: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    pub business_reference_id: String,
    #[serde(default)]
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListVatReturnExportsInput {
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatBlockingIssue {
    pub code: String,
    pub message: String,
    pub source_type: Option<String>,
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatUnclassifiedSource {
    pub source_type: String,
    pub source_id: String,
    pub parent_id: String,
    pub occurrence_date: String,
    pub description: String,
    pub amount_cents: i64,
    pub vat_cents: i64,
    pub vat_rate_bp: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatClassifiedSource {
    #[serde(flatten)]
    pub source: VatUnclassifiedSource,
    pub treatment: String,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatReceivedPayment {
    pub payment_id: String,
    pub date: String,
    pub gross_cents: i64,
    pub net_cents: i64,
    pub vat_cents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatReceivedAllocation {
    pub source_type: String,
    pub source_id: String,
    pub parent_id: String,
    pub description: String,
    pub currency: String,
    #[serde(flatten)]
    pub payment: VatReceivedPayment,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatPreClosingSource {
    #[serde(flatten)]
    pub source: VatUnclassifiedSource,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatRateLine {
    pub tax_rate_bp: i64,
    pub turnover_cents: i64,
    pub calculated_tax_cents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatActivityRateLine {
    pub activity_id: String,
    pub tax_rate_bp: i64,
    pub turnover_cents: i64,
    pub calculated_tax_cents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatVariousDeduction {
    pub amount_cents: i64,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatTurnoverComputationPreview {
    pub total_consideration_cents: i64,
    pub supplies_to_foreign_countries_cents: i64,
    pub supplies_abroad_cents: i64,
    pub transfer_notification_procedure_cents: i64,
    pub supplies_exempt_from_tax_cents: i64,
    pub reduction_of_consideration_cents: i64,
    pub various_deduction: Option<VatVariousDeduction>,
    pub taxable_turnover_cents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatEffectiveReportingMethodPreview {
    pub gross_or_net: String,
    pub gross_or_net_code: i64,
    pub opted_cents: i64,
    pub supplies_per_tax_rate: Vec<VatRateLine>,
    pub acquisition_tax: Vec<VatRateLine>,
    pub input_tax_material_and_services_cents: i64,
    pub input_tax_investments_cents: i64,
    pub subsequent_input_tax_deduction_cents: i64,
    pub input_tax_corrections_cents: i64,
    pub input_tax_reductions_cents: i64,
    pub output_tax_cents: i64,
    pub acquisition_tax_cents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatSimpleTaxRateMethodPreview {
    pub supplies_per_tax_rate: Vec<VatActivityRateLine>,
    pub acquisition_tax: Vec<VatRateLine>,
    pub input_tax_corrections_cents: i64,
    pub output_tax_cents: i64,
    pub acquisition_tax_cents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatOtherFlowsPreview {
    pub subsidies_cents: i64,
    pub donations_cents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatReturnPreview {
    pub standard: String,
    pub standard_version: String,
    pub currency: String,
    pub profile: VatProfile,
    pub date_from: String,
    pub date_to: String,
    pub submission_type: String,
    pub exportable: bool,
    pub blocking_issues: Vec<VatBlockingIssue>,
    pub warnings: Vec<String>,
    pub unclassified_sources: Vec<VatUnclassifiedSource>,
    #[serde(default)]
    pub classified_sources: Vec<VatClassifiedSource>,
    #[serde(default)]
    pub received_allocations: Vec<VatReceivedAllocation>,
    #[serde(default)]
    pub pre_closing_sources: Vec<VatPreClosingSource>,
    pub source_sha256: String,
    pub turnover_computation: VatTurnoverComputationPreview,
    pub effective_reporting_method: Option<VatEffectiveReportingMethodPreview>,
    pub simple_tax_rate_method: Option<VatSimpleTaxRateMethodPreview>,
    pub payable_tax_cents: i64,
    pub payable_code: String,
    pub other_flows_of_funds: VatOtherFlowsPreview,
    pub source_count: usize,
    pub adjustment_count: usize,
    pub transmission_wording: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VatReturnExport {
    pub sequence: i64,
    pub id: String,
    pub profile_id: String,
    pub date_from: String,
    pub date_to: String,
    pub submission_type: String,
    pub source_sha256: String,
    pub payload: VatReturnPreview,
    pub xml_sha256: String,
    pub file_name: String,
    pub file_path: String,
    pub created_at: String,
    pub transmission_status: String,
    pub transmission_wording: String,
}

#[derive(Debug, Clone, Serialize)]
struct RawVatSource {
    source_type: String,
    source_id: String,
    parent_id: String,
    occurrence_date: String,
    description: String,
    currency: String,
    net_cents: i64,
    vat_cents: i64,
    total_cents: i64,
    vat_rate_bp: Option<i64>,
    classification_id: Option<String>,
    treatment: Option<String>,
    classification_note: Option<String>,
    classification_updated_at: Option<String>,
    reliable: bool,
    reliability_detail: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    received_payments: Vec<VatReceivedPayment>,
}

#[derive(Debug, Clone, Serialize)]
struct SourceFingerprint<'a> {
    schema: &'static str,
    profile: &'a VatProfile,
    date_from: &'a str,
    date_to: &'a str,
    submission_type: &'a str,
    organisation_uid: &'a str,
    organisation_name: &'a str,
    sources: &'a [RawVatSource],
    adjustments: &'a [VatAdjustment],
}

#[derive(Debug, Default)]
struct CalculationBuilder {
    total_consideration: i128,
    supplies_to_foreign: i128,
    supplies_abroad: i128,
    transfer_notification: i128,
    supplies_exempt: i128,
    reduction_of_consideration: i128,
    various_deduction: i128,
    opted: i128,
    supplies_by_rate: BTreeMap<i64, i128>,
    acquisition_by_rate: BTreeMap<i64, i128>,
    input_materials: i128,
    input_investments: i128,
    subsequent_input_tax: i128,
    input_tax_corrections: i128,
    input_tax_reductions: i128,
    subsidies: i128,
    donations: i128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rational {
    numerator: i128,
    denominator: i128,
}

impl Rational {
    const ZERO: Self = Self {
        numerator: 0,
        denominator: 1,
    };

    fn new(numerator: i128, denominator: i128) -> AppResult<Self> {
        if denominator <= 0 {
            return Err(AppError::Validation(
                "Dénominateur monétaire interne invalide.".into(),
            ));
        }
        if numerator == 0 {
            return Ok(Self::ZERO);
        }
        let divisor = gcd(numerator.unsigned_abs(), denominator as u128) as i128;
        Ok(Self {
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        })
    }

    fn add(self, other: Self) -> AppResult<Self> {
        let divisor = gcd(self.denominator as u128, other.denominator as u128) as i128;
        let left_factor = other.denominator / divisor;
        let right_factor = self.denominator / divisor;
        let left = self
            .numerator
            .checked_mul(left_factor)
            .ok_or_else(money_overflow)?;
        let right = other
            .numerator
            .checked_mul(right_factor)
            .ok_or_else(money_overflow)?;
        let denominator = self
            .denominator
            .checked_mul(left_factor)
            .ok_or_else(money_overflow)?;
        Self::new(
            left.checked_add(right).ok_or_else(money_overflow)?,
            denominator,
        )
    }

    fn subtract_integer(self, cents: i128) -> AppResult<Self> {
        self.add(Self::new(-cents, 1)?)
    }

    fn add_integer(self, cents: i128) -> AppResult<Self> {
        self.add(Self::new(cents, 1)?)
    }

    fn rounded_cents(self) -> AppResult<i64> {
        let absolute = self.numerator.unsigned_abs();
        let denominator = self.denominator as u128;
        let quotient = absolute / denominator;
        let remainder = absolute % denominator;
        let rounded = if remainder.saturating_mul(2) >= denominator {
            quotient.checked_add(1).ok_or_else(money_overflow)?
        } else {
            quotient
        };
        let signed = if self.numerator < 0 {
            -(i128::try_from(rounded).map_err(|_| money_overflow())?)
        } else {
            i128::try_from(rounded).map_err(|_| money_overflow())?
        };
        checked_i64(signed, "montant de TVA calculé")
    }
}

fn default_net_basis() -> String {
    "net".into()
}

fn money_overflow() -> AppError {
    AppError::Validation(
        "Calcul TVA bloqué : la capacité monétaire exacte en centimes a été dépassée.".into(),
    )
}

fn gcd(mut left: u128, mut right: u128) -> u128 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left.max(1)
}

impl LocalStore {
    /// Ajoute une version de configuration. Une reprise avec le même identifiant
    /// et les mêmes valeurs est idempotente; une version existante n'est jamais
    /// réécrite, sauf pour fermer explicitement le profil jusque-là ouvert.
    pub fn create_vat_profile(&self, input: VatProfileInput) -> AppResult<VatProfile> {
        let normalized = normalize_profile_input(input)?;
        let _guard = self.lock()?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(existing) = load_profile_by_id(&transaction, &normalized.id)? {
            if profile_matches_input(&existing, &normalized) {
                transaction.commit()?;
                return Ok(existing);
            }
            return Err(AppError::Validation(format!(
                "Le profil TVA {} existe déjà avec un autre contenu; créez une nouvelle version.",
                normalized.id
            )));
        }

        ensure_vat_date_open(&transaction, &normalized.effective_from, "Le profil TVA")?;

        if normalized.form_of_reporting == "received" {
            validate_received_vat_accounting_configuration(
                &transaction,
                &normalized.effective_from,
                normalized.effective_to.as_deref(),
            )?;
        }

        if normalized.close_previous_open_profile {
            let previous: Option<(String, String)> = transaction
                .query_row(
                    "SELECT id,effective_from FROM vat_profiles WHERE effective_to IS NULL ORDER BY effective_from DESC LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((previous_id, previous_from)) = previous {
                let previous_from_date = parse_date(&previous_from, "effective_from")?;
                if previous_from_date >= normalized.effective_from_date {
                    return Err(AppError::Validation(
                        "Le profil TVA ouvert ne peut pas être fermé par une version antérieure ou commençant le même jour."
                            .into(),
                    ));
                }
                let previous_to = normalized
                    .effective_from_date
                    .pred_opt()
                    .ok_or_else(|| AppError::Validation("Date de profil TVA hors plage.".into()))?
                    .format("%Y-%m-%d")
                    .to_string();
                ensure_vat_profile_future_close_is_safe(&transaction, &previous_to)?;
                transaction.execute(
                    "UPDATE vat_profiles SET effective_to=?,updated_at=? WHERE id=? AND effective_to IS NULL",
                    params![previous_to, now_iso(), previous_id],
                )?;
            }
        }

        let overlaps: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM vat_profiles WHERE effective_from<=COALESCE(?,'9999-12-31') AND COALESCE(effective_to,'9999-12-31')>=?",
            params![normalized.effective_to, normalized.effective_from],
            |row| row.get(0),
        )?;
        if overlaps != 0 {
            return Err(AppError::Validation(
                "La période du nouveau profil TVA chevauche une version existante.".into(),
            ));
        }

        let now = now_iso();
        transaction.execute(
            "INSERT INTO vat_profiles(id,effective_from,effective_to,reporting_method,form_of_reporting,periodicity,gross_or_net,tdfn_activity_id,tdfn_rate_bp,afc_authorization_confirmed,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                normalized.id,
                normalized.effective_from,
                normalized.effective_to,
                normalized.reporting_method,
                normalized.form_of_reporting,
                normalized.periodicity,
                normalized.gross_or_net,
                normalized.tdfn_activity_id,
                normalized.tdfn_rate_bp,
                i64::from(normalized.afc_authorization_confirmed),
                normalized.notes,
                now,
                now,
            ],
        )?;
        let result = load_profile_by_id(&transaction, &normalized.id)?
            .ok_or_else(|| AppError::NotFound(format!("vat_profiles/{}", normalized.id)))?;
        transition::ensure_supported(&transaction)?;
        crate::input_vat_accounting::sync_period(
            &transaction,
            &normalized.effective_from,
            normalized.effective_to.as_deref().unwrap_or("9999-12-31"),
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn list_vat_profiles(&self) -> AppResult<Vec<VatProfile>> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut statement = connection.prepare(
            "SELECT id,effective_from,effective_to,reporting_method,form_of_reporting,periodicity,gross_or_net,tdfn_activity_id,tdfn_rate_bp,afc_authorization_confirmed,notes,created_at,updated_at FROM vat_profiles ORDER BY effective_from DESC,created_at DESC,id",
        )?;
        let rows = statement.query_map([], map_profile)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    #[allow(dead_code)]
    pub fn vat_profile_for_date(&self, date: &str) -> AppResult<VatProfile> {
        let date = normalize_date(date, "date")?;
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        load_profile_for_period(&connection, &date, &date, None)
    }

    /// Définit explicitement le traitement fiscal d'une source existante. La
    /// classification peut être corrigée; chaque export conserve néanmoins sa
    /// photographie et son empreinte antérieures dans le registre immuable.
    pub fn set_vat_source_classification(
        &self,
        input: VatSourceClassificationInput,
    ) -> AppResult<VatSourceClassification> {
        let source_type = input.source_type.trim().to_string();
        let source_id = required_text(&input.source_id, "source_id", 255)?;
        let treatment = input.treatment.trim().to_string();
        validate_source_type_and_treatment(&source_type, &treatment)?;
        let note = optional_text(input.note, "note", 1_000)?;

        let _guard = self.lock()?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !vat_source_exists(&transaction, &source_type, &source_id)? {
            return Err(AppError::NotFound(format!("{source_type}/{source_id}")));
        }

        let existing = load_classification(&transaction, &source_type, &source_id)?;
        if let Some(existing) = existing {
            if existing.treatment == treatment && existing.note == note {
                let closed = closed_accounting_through(&transaction)?;
                let fiscal_date = vat_source_fiscal_date(&transaction, &source_type, &source_id)?;
                if !matches!((closed, fiscal_date), (Some(closed), Some(date)) if date <= closed) {
                    crate::input_vat_accounting::sync_source(
                        &transaction,
                        &source_type,
                        &source_id,
                    )?;
                }
                transaction.commit()?;
                return Ok(existing);
            }
            ensure_vat_source_open(&transaction, &source_type, &source_id)?;
            transaction.execute(
                "UPDATE vat_source_classifications SET treatment=?,note=?,updated_at=? WHERE id=?",
                params![treatment, note, now_iso(), existing.id],
            )?;
        } else {
            ensure_vat_source_open(&transaction, &source_type, &source_id)?;
            let id = Uuid::new_v4().to_string();
            let now = now_iso();
            transaction.execute(
                "INSERT INTO vat_source_classifications(id,source_type,source_id,treatment,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                params![id,source_type,source_id,treatment,note,now,now],
            )?;
        }

        let result = load_classification(&transaction, &source_type, &source_id)?
            .ok_or_else(|| AppError::NotFound(format!("{source_type}/{source_id}")))?;
        crate::input_vat_accounting::sync_source(&transaction, &source_type, &source_id)?;
        append_audit(
            &transaction,
            "classify_vat",
            &source_type,
            &source_id,
            &serde_json::to_value(&result)?,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn list_vat_source_classifications(
        &self,
        input: ListVatSourceClassificationsInput,
    ) -> AppResult<Vec<VatSourceClassification>> {
        let source_type = input
            .source_type
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if let Some(source_type) = source_type.as_deref() {
            validate_source_type(source_type)?;
        }
        let source_id = input
            .source_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut statement = connection.prepare(
            "SELECT id,source_type,source_id,treatment,note,created_at,updated_at FROM vat_source_classifications ORDER BY source_type,source_id",
        )?;
        let rows = statement.query_map([], map_classification)?;
        let mut result = Vec::new();
        for row in rows {
            let row = row?;
            if source_type
                .as_deref()
                .is_some_and(|filter| filter != row.source_type)
                || source_id
                    .as_deref()
                    .is_some_and(|filter| filter != row.source_id)
            {
                continue;
            }
            result.push(row);
        }
        Ok(result)
    }
}

#[derive(Debug)]
struct NormalizedVatProfileInput {
    id: String,
    effective_from: String,
    effective_from_date: NaiveDate,
    effective_to: Option<String>,
    reporting_method: String,
    form_of_reporting: String,
    periodicity: String,
    gross_or_net: String,
    tdfn_activity_id: Option<String>,
    tdfn_rate_bp: Option<i64>,
    afc_authorization_confirmed: bool,
    notes: Option<String>,
    close_previous_open_profile: bool,
}

fn normalize_profile_input(input: VatProfileInput) -> AppResult<NormalizedVatProfileInput> {
    let id = match input.id {
        Some(value) => required_text(&value, "id", 255)?,
        None => Uuid::new_v4().to_string(),
    };
    let effective_from_date = parse_date(&input.effective_from, "effective_from")?;
    let effective_from = effective_from_date.format("%Y-%m-%d").to_string();
    let effective_to = input
        .effective_to
        .filter(|value| !value.trim().is_empty())
        .map(|value| normalize_date(&value, "effective_to"))
        .transpose()?;
    if effective_to
        .as_deref()
        .is_some_and(|value| value < effective_from.as_str())
    {
        return Err(AppError::Validation(
            "effective_to doit être postérieure ou égale à effective_from.".into(),
        ));
    }
    let reporting_method = input.reporting_method.trim().to_string();
    if !matches!(reporting_method.as_str(), "effective" | "simple_tax_rate") {
        return Err(AppError::Validation(
            "reporting_method doit valoir effective ou simple_tax_rate.".into(),
        ));
    }
    let form_of_reporting = input.form_of_reporting.trim().to_string();
    if !matches!(form_of_reporting.as_str(), "agreed" | "received") {
        return Err(AppError::Validation(
            "form_of_reporting doit valoir agreed ou received.".into(),
        ));
    }
    let periodicity = input.periodicity.trim().to_string();
    if !matches!(
        periodicity.as_str(),
        "monthly" | "quarterly" | "semiannual" | "annual"
    ) {
        return Err(AppError::Validation(
            "periodicity doit valoir monthly, quarterly, semiannual ou annual.".into(),
        ));
    }
    let gross_or_net = input.gross_or_net.trim().to_string();
    if !matches!(gross_or_net.as_str(), "net" | "gross") {
        return Err(AppError::Validation(
            "gross_or_net doit valoir net ou gross.".into(),
        ));
    }
    let tdfn_activity_id = input
        .tdfn_activity_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string());
    let notes = optional_text(input.notes, "notes", 20_000)?;

    match reporting_method.as_str() {
        "effective" => {
            if tdfn_activity_id.is_some() || input.tdfn_rate_bp.is_some() {
                return Err(AppError::Validation(
                    "Un profil effectif ne doit pas contenir de code ni de taux TDFN/TaF.".into(),
                ));
            }
        }
        "simple_tax_rate" => {
            if effective_from_date
                < NaiveDate::from_ymd_opt(2025, 1, 1).expect("valid constant date")
            {
                return Err(AppError::Validation(
                    "simple_tax_rate (TDFN/TaF) eCH-0217 v2.0.0 n'est disponible que dès le 2025-01-01."
                        .into(),
                ));
            }
            let activity_id = tdfn_activity_id.as_deref().ok_or_else(|| {
                AppError::Validation("tdfn_activity_id est obligatoire pour TDFN/TaF.".into())
            })?;
            if activity_id.len() != 5 || !activity_id.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(AppError::Validation(
                    "tdfn_activity_id doit contenir exactement cinq chiffres autorisés par l'AFC."
                        .into(),
                ));
            }
            if !input
                .tdfn_rate_bp
                .is_some_and(|rate| (0..=10_000).contains(&rate))
            {
                return Err(AppError::Validation(
                    "tdfn_rate_bp doit être compris entre 0 et 10000.".into(),
                ));
            }
            if !input.afc_authorization_confirmed {
                return Err(AppError::Validation(
                    "L'autorisation AFC du code d'activité et du taux TDFN/TaF doit être confirmée explicitement."
                        .into(),
                ));
            }
            if gross_or_net != "gross" {
                return Err(AppError::Validation(
                    "Les chiffres d'affaires TDFN/TaF doivent être configurés en brut selon eCH-0217 v2.0.0."
                        .into(),
                ));
            }
        }
        _ => unreachable!(),
    }

    Ok(NormalizedVatProfileInput {
        id,
        effective_from,
        effective_from_date,
        effective_to,
        reporting_method,
        form_of_reporting,
        periodicity,
        gross_or_net,
        tdfn_activity_id,
        tdfn_rate_bp: input.tdfn_rate_bp,
        afc_authorization_confirmed: input.afc_authorization_confirmed,
        notes,
        close_previous_open_profile: input.close_previous_open_profile,
    })
}

fn profile_matches_input(profile: &VatProfile, input: &NormalizedVatProfileInput) -> bool {
    profile.effective_from == input.effective_from
        && profile.effective_to == input.effective_to
        && profile.reporting_method == input.reporting_method
        && profile.form_of_reporting == input.form_of_reporting
        && profile.periodicity == input.periodicity
        && profile.gross_or_net == input.gross_or_net
        && profile.tdfn_activity_id == input.tdfn_activity_id
        && profile.tdfn_rate_bp == input.tdfn_rate_bp
        && profile.afc_authorization_confirmed == input.afc_authorization_confirmed
        && profile.notes == input.notes
}

fn map_profile(row: &Row<'_>) -> rusqlite::Result<VatProfile> {
    Ok(VatProfile {
        id: row.get(0)?,
        effective_from: row.get(1)?,
        effective_to: row.get(2)?,
        reporting_method: row.get(3)?,
        form_of_reporting: row.get(4)?,
        periodicity: row.get(5)?,
        gross_or_net: row.get(6)?,
        tdfn_activity_id: row.get(7)?,
        tdfn_rate_bp: row.get(8)?,
        afc_authorization_confirmed: row.get::<_, i64>(9)? != 0,
        notes: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn load_profile_by_id(connection: &Connection, id: &str) -> AppResult<Option<VatProfile>> {
    connection
        .query_row(
            "SELECT id,effective_from,effective_to,reporting_method,form_of_reporting,periodicity,gross_or_net,tdfn_activity_id,tdfn_rate_bp,afc_authorization_confirmed,notes,created_at,updated_at FROM vat_profiles WHERE id=?",
            params![id],
            map_profile,
        )
        .optional()
        .map_err(Into::into)
}

fn load_profile_for_period(
    connection: &Connection,
    date_from: &str,
    date_to: &str,
    profile_id: Option<&str>,
) -> AppResult<VatProfile> {
    let profile = if let Some(profile_id) = profile_id {
        load_profile_by_id(connection, profile_id)?
            .ok_or_else(|| AppError::NotFound(format!("vat_profiles/{profile_id}")))?
    } else {
        connection
            .query_row(
                "SELECT id,effective_from,effective_to,reporting_method,form_of_reporting,periodicity,gross_or_net,tdfn_activity_id,tdfn_rate_bp,afc_authorization_confirmed,notes,created_at,updated_at FROM vat_profiles WHERE effective_from<=? AND COALESCE(effective_to,'9999-12-31')>=? ORDER BY effective_from DESC LIMIT 1",
                params![date_from, date_to],
                map_profile,
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("vat_profile/{date_from}/{date_to}")))?
    };
    if profile.effective_from.as_str() > date_from
        || profile
            .effective_to
            .as_deref()
            .is_some_and(|effective_to| effective_to < date_to)
    {
        return Err(AppError::Validation(
            "Le profil TVA sélectionné ne couvre pas toute la période du décompte.".into(),
        ));
    }
    Ok(profile)
}

fn map_classification(row: &Row<'_>) -> rusqlite::Result<VatSourceClassification> {
    Ok(VatSourceClassification {
        id: row.get(0)?,
        source_type: row.get(1)?,
        source_id: row.get(2)?,
        treatment: row.get(3)?,
        note: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn load_classification(
    connection: &Connection,
    source_type: &str,
    source_id: &str,
) -> AppResult<Option<VatSourceClassification>> {
    connection
        .query_row(
            "SELECT id,source_type,source_id,treatment,note,created_at,updated_at FROM vat_source_classifications WHERE source_type=? AND source_id=?",
            params![source_type, source_id],
            map_classification,
        )
        .optional()
        .map_err(Into::into)
}

fn validate_source_type(source_type: &str) -> AppResult<()> {
    if matches!(
        source_type,
        "invoice_item" | "supplier_invoice_item" | "supplier_credit_note_item" | "expense"
    ) {
        Ok(())
    } else {
        Err(AppError::Validation("Type de source TVA inconnu.".into()))
    }
}

fn validate_source_type_and_treatment(source_type: &str, treatment: &str) -> AppResult<()> {
    validate_source_type(source_type)?;
    let valid = match source_type {
        "invoice_item" => matches!(
            treatment,
            "taxable"
                | "supplies_to_foreign"
                | "supplies_abroad"
                | "transfer_notification"
                | "exempt"
                | "out_of_scope"
                | "opted"
        ),
        "supplier_invoice_item" | "supplier_credit_note_item" | "expense" => matches!(
            treatment,
            "input_materials" | "input_investments" | "non_deductible"
        ),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "Le traitement {treatment} n'est pas autorisé pour {source_type}."
        )))
    }
}

fn vat_source_exists(
    connection: &Connection,
    source_type: &str,
    source_id: &str,
) -> AppResult<bool> {
    let sql = match source_type {
        "invoice_item" => "SELECT EXISTS(SELECT 1 FROM invoice_items WHERE id=?)",
        "supplier_invoice_item" => "SELECT EXISTS(SELECT 1 FROM supplier_invoice_items WHERE id=?)",
        "expense" => "SELECT EXISTS(SELECT 1 FROM expenses WHERE id=?)",
        "supplier_credit_note_item" => {
            "SELECT EXISTS(SELECT 1 FROM supplier_credit_note_items WHERE id=?)"
        }
        _ => return Ok(false),
    };
    connection
        .query_row(sql, params![source_id], |row| row.get(0))
        .map_err(Into::into)
}

fn vat_source_fiscal_date(
    connection: &Connection,
    source_type: &str,
    source_id: &str,
) -> AppResult<Option<String>> {
    connection
        .query_row(
            "SELECT fiscal_date FROM vat_source_fiscal_dates WHERE source_type=? AND source_id=?",
            params![source_type, source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn ensure_vat_date_open(connection: &Connection, date: &str, subject: &str) -> AppResult<()> {
    let date_value = parse_date(date, "date TVA")?;
    if let Some(closed_through) = closed_accounting_through(connection)? {
        let closed_through_date = parse_date(&closed_through, "frontière de clôture")?;
        if date_value <= closed_through_date {
            return Err(AppError::Validation(format!(
                "La clôture comptable est cumulative jusqu'au {closed_through}. {subject} doit être daté après cette frontière; enregistrez toute correction dans une période ouverte ultérieure avec la référence de l'opération d'origine."
            )));
        }
    }
    Ok(())
}

fn ensure_vat_profile_future_close_is_safe(
    connection: &Connection,
    previous_to: &str,
) -> AppResult<()> {
    let previous_to_date = parse_date(previous_to, "fin du profil TVA précédent")?;
    if let Some(closed_through) = closed_accounting_through(connection)? {
        let closed_through_date = parse_date(&closed_through, "frontière de clôture")?;
        if previous_to_date < closed_through_date {
            return Err(AppError::Validation(format!(
                "Le profil TVA précédent couvre une période clôturée cumulativement jusqu'au {closed_through}; sa nouvelle date de fin ne peut pas précéder cette frontière."
            )));
        }
    }
    Ok(())
}

fn ensure_vat_source_open(
    connection: &Connection,
    source_type: &str,
    source_id: &str,
) -> AppResult<()> {
    if let Some(fiscal_date) = vat_source_fiscal_date(connection, source_type, source_id)? {
        ensure_vat_date_open(
            connection,
            &fiscal_date,
            "La classification de cette source TVA",
        )?;
    }
    Ok(())
}

/// Refuse une clôture qui figerait des sources nécessaires à un décompte TVA
/// sans décision fiscale exploitable ou avec une anomalie qui empêche encore
/// leur déclaration. Les profils déterminent les sources pertinentes et leur
/// date d'occurrence (facturation ou encaissement).
pub(crate) fn ensure_vat_sources_classified_through(
    connection: &Connection,
    date_to: &str,
) -> AppResult<()> {
    let date_to = normalize_date(date_to, "date_to de clôture")?;
    let profiles = {
        let mut statement = connection.prepare(
            "SELECT id,effective_from,effective_to,reporting_method,form_of_reporting,periodicity,gross_or_net,tdfn_activity_id,tdfn_rate_bp,afc_authorization_confirmed,notes,created_at,updated_at
             FROM vat_profiles
             WHERE effective_from<=?
             ORDER BY effective_from,id",
        )?;
        let rows = statement.query_map(params![date_to], map_profile)?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let mut unresolved = BTreeSet::new();
    let mut reporting_issues = Vec::new();
    for profile in profiles {
        let range_to = profile
            .effective_to
            .as_deref()
            .map(|profile_to| profile_to.min(date_to.as_str()))
            .unwrap_or(date_to.as_str());
        if profile.effective_from.as_str() > range_to {
            continue;
        }

        let mut profile_issues = Vec::new();
        for source in load_raw_vat_sources(
            connection,
            &profile,
            &profile.effective_from,
            range_to,
            &mut profile_issues,
        )? {
            let classification_is_valid = source.classification_id.is_some()
                && source.treatment.as_deref().is_some_and(|treatment| {
                    validate_source_type_and_treatment(&source.source_type, treatment).is_ok()
                });
            if !classification_is_valid {
                unresolved.insert((source.source_type, source.source_id));
            }
        }
        // Classification changes also affect the original journal date. Do not
        // freeze an unpaid purchase before the user can decide its treatment.
        for source in load_received_pre_closing_sources(connection, &profile, range_to)? {
            unresolved.insert((source.source_type, source.source_id));
        }
        reporting_issues.extend(profile_issues);
    }

    sort_and_deduplicate_issues(&mut reporting_issues);
    if unresolved.is_empty() && reporting_issues.is_empty() {
        return Ok(());
    }

    let examples = unresolved
        .iter()
        .take(5)
        .map(|(source_type, source_id)| format!("{source_type}/{source_id}"))
        .collect::<Vec<_>>()
        .join(", ");
    let reporting_details = reporting_issues
        .iter()
        .take(5)
        .map(|issue| issue.message.as_str())
        .collect::<Vec<_>>()
        .join(" | ");
    let classification_message = if unresolved.is_empty() {
        String::new()
    } else {
        format!(
            " {} source(s) TVA cumulative(s) n'ont pas de classification fiscale valide. Classifiez-les dans TVA. Sources : {examples}.",
            unresolved.len()
        )
    };
    let reporting_message = if reporting_issues.is_empty() {
        String::new()
    } else {
        format!(
            " {} anomalie(s) rendent encore le décompte non rapportable. Corrigez-les avant de fermer la période : {reporting_details}",
            reporting_issues.len()
        )
    };
    Err(AppError::Validation(format!(
        "La clôture est bloquée : le dossier TVA cumulatif jusqu'au {date_to} n'est pas exportable.{classification_message}{reporting_message}"
    )))
}

fn required_text(value: &str, field: &str, max_length: usize) -> AppResult<String> {
    let value = value.trim();
    let length = value.chars().count();
    if length == 0 || length > max_length {
        return Err(AppError::Validation(format!(
            "{field} doit contenir entre 1 et {max_length} caractères."
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(AppError::Validation(format!(
            "{field} contient un caractère de contrôle interdit."
        )));
    }
    Ok(value.to_string())
}

fn optional_text(
    value: Option<String>,
    field: &str,
    max_length: usize,
) -> AppResult<Option<String>> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(|value| required_text(&value, field, max_length))
        .transpose()
}

fn parse_date(value: &str, field: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::Validation(format!("{field} doit être au format AAAA-MM-JJ.")))
}

fn normalize_date(value: &str, field: &str) -> AppResult<String> {
    Ok(parse_date(value, field)?.format("%Y-%m-%d").to_string())
}

impl LocalStore {
    pub fn create_vat_adjustment(&self, input: VatAdjustmentInput) -> AppResult<VatAdjustment> {
        let normalized = normalize_adjustment_input(input)?;
        let _guard = self.lock()?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some((existing, stored_sha256, stored_json)) =
            load_adjustment_by_request_id(&transaction, &normalized.request_id)?
        {
            if stored_sha256 == normalized.request_sha256
                && stored_json == normalized.request_json
                && adjustment_matches_input(&existing, &normalized)
            {
                transaction.commit()?;
                return Ok(existing);
            }
            return Err(AppError::Validation(format!(
                "Le request_id {} a déjà été utilisé avec un autre ajustement TVA.",
                normalized.request_id
            )));
        }

        ensure_vat_date_open(
            &transaction,
            &normalized.adjustment_date,
            "L'ajustement TVA",
        )?;

        if load_adjustment_by_id(&transaction, &normalized.id)?.is_some() {
            return Err(AppError::Validation(format!(
                "L'identifiant {} appartient deja a une ligne TVA anterieure sans preuve de requete rejouable.",
                normalized.id
            )));
        }

        transaction.execute(
            "INSERT INTO vat_adjustments(id,request_id,request_sha256,request_json,adjustment_date,category,amount_cents,tax_rate_bp,description,evidence_reference,reverses_adjustment_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?)",
            params![
                normalized.id,
                normalized.request_id,
                normalized.request_sha256,
                normalized.request_json,
                normalized.adjustment_date,
                normalized.category,
                normalized.amount_cents,
                normalized.tax_rate_bp,
                normalized.description,
                normalized.evidence_reference,
                normalized.created_by,
                now_iso(),
            ],
        )?;
        let result = load_adjustment_by_id(&transaction, &normalized.id)?
            .ok_or_else(|| AppError::NotFound(format!("vat_adjustments/{}", normalized.id)))?;
        append_audit(
            &transaction,
            "create",
            "vat_adjustment",
            &result.id,
            &serde_json::json!({
                "schema": "zentra.vat-adjustment-audit.v1",
                "request_id": normalized.request_id,
                "request_sha256": normalized.request_sha256,
                "adjustment": &result,
            }),
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn reverse_vat_adjustment(
        &self,
        input: ReverseVatAdjustmentInput,
    ) -> AppResult<VatAdjustment> {
        let normalized = normalize_reverse_adjustment_input(input)?;

        let _guard = self.lock()?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let original = load_adjustment_by_id(&transaction, &normalized.original_adjustment_id)?
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "vat_adjustments/{}",
                    normalized.original_adjustment_id
                ))
            })?;
        if original.reverses_adjustment_id.is_some() {
            return Err(AppError::Validation(
                "Une extourne ne peut pas elle-même être extournée.".into(),
            ));
        }

        if let Some((existing, stored_sha256, stored_json)) =
            load_adjustment_by_request_id(&transaction, &normalized.request_id)?
        {
            if stored_sha256 == normalized.request_sha256
                && stored_json == normalized.request_json
                && existing.reverses_adjustment_id.as_deref()
                    == Some(normalized.original_adjustment_id.as_str())
                && existing.adjustment_date == normalized.adjustment_date
                && existing.category == original.category
                && existing.amount_cents == -original.amount_cents
                && existing.tax_rate_bp == original.tax_rate_bp
                && existing.description == normalized.description
                && existing.evidence_reference == normalized.evidence_reference
                && existing.created_by == normalized.created_by
            {
                transaction.commit()?;
                return Ok(existing);
            }
            return Err(AppError::Validation(format!(
                "Le request_id {} existe déjà avec un autre contenu d'extourne.",
                normalized.request_id
            )));
        }

        if normalized.adjustment_date < original.adjustment_date {
            return Err(AppError::Validation(
                "L'extourne TVA ne peut pas précéder l'ajustement d'origine.".into(),
            ));
        }
        ensure_vat_date_open(&transaction, &normalized.adjustment_date, "L'extourne TVA")?;

        if load_adjustment_by_id(&transaction, &normalized.id)?.is_some() {
            return Err(AppError::Validation(format!(
                "L'identifiant {} appartient deja a une ligne TVA anterieure sans preuve de requete rejouable.",
                normalized.id
            )));
        }

        let already_reversed: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM vat_adjustments WHERE reverses_adjustment_id=?)",
            params![normalized.original_adjustment_id],
            |row| row.get(0),
        )?;
        if already_reversed {
            return Err(AppError::Validation(
                "Cet ajustement TVA a déjà été extourné.".into(),
            ));
        }

        transaction.execute(
            "INSERT INTO vat_adjustments(id,request_id,request_sha256,request_json,adjustment_date,category,amount_cents,tax_rate_bp,description,evidence_reference,reverses_adjustment_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                normalized.id,
                normalized.request_id,
                normalized.request_sha256,
                normalized.request_json,
                normalized.adjustment_date,
                original.category,
                -original.amount_cents,
                original.tax_rate_bp,
                normalized.description,
                normalized.evidence_reference,
                normalized.original_adjustment_id,
                normalized.created_by,
                now_iso(),
            ],
        )?;
        let result = load_adjustment_by_id(&transaction, &normalized.id)?
            .ok_or_else(|| AppError::NotFound(format!("vat_adjustments/{}", normalized.id)))?;
        append_audit(
            &transaction,
            "reverse",
            "vat_adjustment",
            &result.id,
            &serde_json::json!({
                "schema": "zentra.vat-adjustment-audit.v1",
                "request_id": normalized.request_id,
                "request_sha256": normalized.request_sha256,
                "original_adjustment_id": normalized.original_adjustment_id,
                "adjustment": &result,
            }),
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn list_vat_adjustments(
        &self,
        input: ListVatAdjustmentsInput,
    ) -> AppResult<Vec<VatAdjustment>> {
        let date_from = input
            .date_from
            .map(|value| normalize_date(&value, "date_from"))
            .transpose()?;
        let date_to = input
            .date_to
            .map(|value| normalize_date(&value, "date_to"))
            .transpose()?;
        if date_from
            .as_deref()
            .zip(date_to.as_deref())
            .is_some_and(|(from, to)| from > to)
        {
            return Err(AppError::Validation(
                "date_from doit précéder ou être égale à date_to.".into(),
            ));
        }
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut statement = connection.prepare(
            "SELECT sequence,id,adjustment_date,category,amount_cents,tax_rate_bp,description,evidence_reference,reverses_adjustment_id,created_by,created_at FROM vat_adjustments ORDER BY adjustment_date,sequence",
        )?;
        let rows = statement.query_map([], map_adjustment)?;
        let mut result = Vec::new();
        for row in rows {
            let row = row?;
            if date_from
                .as_deref()
                .is_some_and(|date_from| row.adjustment_date.as_str() < date_from)
                || date_to
                    .as_deref()
                    .is_some_and(|date_to| row.adjustment_date.as_str() > date_to)
            {
                continue;
            }
            result.push(row);
        }
        Ok(result)
    }
}

#[derive(Debug)]
struct NormalizedVatAdjustmentInput {
    id: String,
    request_id: String,
    request_sha256: String,
    request_json: String,
    adjustment_date: String,
    category: String,
    amount_cents: i64,
    tax_rate_bp: Option<i64>,
    description: String,
    evidence_reference: Option<String>,
    created_by: String,
}

fn normalize_adjustment_input(
    input: VatAdjustmentInput,
) -> AppResult<NormalizedVatAdjustmentInput> {
    let request_id = normalize_request_id(&input.request_id)?;
    let id = request_id.clone();
    let adjustment_date = normalize_date(&input.adjustment_date, "adjustment_date")?;
    let category = input.category.trim().to_string();
    if !matches!(
        category.as_str(),
        "supplies_to_foreign"
            | "supplies_abroad"
            | "transfer_notification"
            | "supplies_exempt"
            | "reduction_of_consideration"
            | "various_deduction"
            | "opted"
            | "acquisition_tax"
            | "input_materials"
            | "input_investments"
            | "subsequent_input_tax"
            | "input_tax_corrections"
            | "input_tax_reductions"
            | "subsidies"
            | "donations"
    ) {
        return Err(AppError::Validation(
            "Catégorie d'ajustement TVA inconnue.".into(),
        ));
    }
    if input.amount_cents == 0 || i128::from(input.amount_cents).abs() > MAX_MONEY_CENTS {
        return Err(AppError::Validation(
            "amount_cents doit être non nul et rester dans la capacité monétaire locale.".into(),
        ));
    }
    if category == "acquisition_tax" {
        if !input
            .tax_rate_bp
            .is_some_and(|rate| (0..=10_000).contains(&rate))
        {
            return Err(AppError::Validation(
                "tax_rate_bp est obligatoire pour acquisition_tax.".into(),
            ));
        }
    } else if input.tax_rate_bp.is_some() {
        return Err(AppError::Validation(
            "tax_rate_bp n'est admis que pour acquisition_tax.".into(),
        ));
    }
    let description = required_text(&input.description, "description", 500)?;
    let evidence_reference = optional_text(input.evidence_reference, "evidence_reference", 500)?;
    let created_by = required_text(&input.created_by, "created_by", 200)?;
    let request_json = serde_json::to_string(&serde_json::json!({
        "operation": "create_vat_adjustment",
        "adjustment_date": adjustment_date,
        "category": category,
        "amount_cents": input.amount_cents,
        "tax_rate_bp": input.tax_rate_bp,
        "description": description,
        "evidence_reference": evidence_reference,
        "created_by": created_by,
    }))?;
    let request_sha256 = sha256_hex(request_json.as_bytes());
    Ok(NormalizedVatAdjustmentInput {
        id,
        request_id,
        request_sha256,
        request_json,
        adjustment_date,
        category,
        amount_cents: input.amount_cents,
        tax_rate_bp: input.tax_rate_bp,
        description,
        evidence_reference,
        created_by,
    })
}

fn adjustment_matches_input(
    adjustment: &VatAdjustment,
    input: &NormalizedVatAdjustmentInput,
) -> bool {
    adjustment.reverses_adjustment_id.is_none()
        && adjustment.adjustment_date == input.adjustment_date
        && adjustment.category == input.category
        && adjustment.amount_cents == input.amount_cents
        && adjustment.tax_rate_bp == input.tax_rate_bp
        && adjustment.description == input.description
        && adjustment.evidence_reference == input.evidence_reference
        && adjustment.created_by == input.created_by
}

#[derive(Debug)]
struct NormalizedReverseVatAdjustmentInput {
    id: String,
    request_id: String,
    request_sha256: String,
    request_json: String,
    original_adjustment_id: String,
    adjustment_date: String,
    description: String,
    evidence_reference: Option<String>,
    created_by: String,
}

fn normalize_reverse_adjustment_input(
    input: ReverseVatAdjustmentInput,
) -> AppResult<NormalizedReverseVatAdjustmentInput> {
    let request_id = normalize_request_id(&input.request_id)?;
    let id = request_id.clone();
    let original_adjustment_id =
        required_text(&input.original_adjustment_id, "original_adjustment_id", 255)?;
    let adjustment_date = normalize_date(&input.adjustment_date, "adjustment_date")?;
    let description = required_text(&input.description, "description", 500)?;
    let evidence_reference = optional_text(input.evidence_reference, "evidence_reference", 500)?;
    let created_by = required_text(&input.created_by, "created_by", 200)?;
    let request_json = serde_json::to_string(&serde_json::json!({
        "operation": "reverse_vat_adjustment",
        "original_adjustment_id": original_adjustment_id,
        "adjustment_date": adjustment_date,
        "description": description,
        "evidence_reference": evidence_reference,
        "created_by": created_by,
    }))?;
    let request_sha256 = sha256_hex(request_json.as_bytes());
    Ok(NormalizedReverseVatAdjustmentInput {
        id,
        request_id,
        request_sha256,
        request_json,
        original_adjustment_id,
        adjustment_date,
        description,
        evidence_reference,
        created_by,
    })
}

fn normalize_request_id(value: &str) -> AppResult<String> {
    Uuid::parse_str(value.trim())
        .map(|request_id| request_id.hyphenated().to_string())
        .map_err(|_| AppError::Validation("request_id doit etre un UUID valide.".into()))
}

fn map_adjustment(row: &Row<'_>) -> rusqlite::Result<VatAdjustment> {
    Ok(VatAdjustment {
        sequence: row.get(0)?,
        id: row.get(1)?,
        adjustment_date: row.get(2)?,
        category: row.get(3)?,
        amount_cents: row.get(4)?,
        tax_rate_bp: row.get(5)?,
        description: row.get(6)?,
        evidence_reference: row.get(7)?,
        reverses_adjustment_id: row.get(8)?,
        created_by: row.get(9)?,
        created_at: row.get(10)?,
    })
}

fn load_adjustment_by_id(connection: &Connection, id: &str) -> AppResult<Option<VatAdjustment>> {
    connection
        .query_row(
            "SELECT sequence,id,adjustment_date,category,amount_cents,tax_rate_bp,description,evidence_reference,reverses_adjustment_id,created_by,created_at FROM vat_adjustments WHERE id=?",
            params![id],
            map_adjustment,
        )
        .optional()
        .map_err(Into::into)
}

fn load_adjustment_by_request_id(
    connection: &Connection,
    request_id: &str,
) -> AppResult<Option<(VatAdjustment, String, String)>> {
    let stored: Option<(String, String, String)> = connection
        .query_row(
            "SELECT id,request_sha256,request_json FROM vat_adjustments WHERE request_id=?",
            params![request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    stored
        .map(|(id, request_sha256, request_json)| {
            load_adjustment_by_id(connection, &id)?
                .map(|adjustment| (adjustment, request_sha256, request_json))
                .ok_or_else(|| AppError::NotFound(format!("vat_adjustments/{id}")))
        })
        .transpose()
}

fn load_adjustments_for_period(
    connection: &Connection,
    date_from: &str,
    date_to: &str,
) -> AppResult<Vec<VatAdjustment>> {
    let mut statement = connection.prepare(
        "SELECT sequence,id,adjustment_date,category,amount_cents,tax_rate_bp,description,evidence_reference,reverses_adjustment_id,created_by,created_at FROM vat_adjustments WHERE adjustment_date BETWEEN ? AND ? ORDER BY adjustment_date,sequence",
    )?;
    let rows = statement.query_map(params![date_from, date_to], map_adjustment)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

impl LocalStore {
    pub fn preview_vat_return(&self, input: VatReturnPreviewInput) -> AppResult<VatReturnPreview> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        build_vat_preview(&connection, input)
    }
}

fn build_vat_preview(
    connection: &Connection,
    input: VatReturnPreviewInput,
) -> AppResult<VatReturnPreview> {
    let date_from = normalize_date(&input.date_from, "date_from")?;
    let date_to = normalize_date(&input.date_to, "date_to")?;
    if date_from > date_to {
        return Err(AppError::Validation(
            "date_from doit précéder ou être égale à date_to.".into(),
        ));
    }
    let submission_type = input.submission_type.trim().to_string();
    if !matches!(
        submission_type.as_str(),
        "initial" | "correction" | "annual_reconciliation"
    ) {
        return Err(AppError::Validation(
            "submission_type doit valoir initial, correction ou annual_reconciliation.".into(),
        ));
    }
    let profile_id = input
        .profile_id
        .as_deref()
        .map(|value| required_text(value, "profile_id", 255))
        .transpose()?;
    let profile = load_profile_for_period(connection, &date_from, &date_to, profile_id.as_deref())?;
    validate_reporting_period(&profile, &date_from, &date_to, &submission_type)?;
    if profile.reporting_method == "simple_tax_rate" && date_from.as_str() < "2025-01-01" {
        return Err(AppError::Validation(
            "simpleTaxRateMethod ne peut être utilisé que pour une période commençant dès le 2025-01-01."
                .into(),
        ));
    }

    let (organisation_name, raw_uid, base_currency): (String, Option<String>, String) = connection
        .query_row(
            "SELECT company_name,COALESCE(NULLIF(TRIM(vat_number),''),NULLIF(TRIM(uid_number),'')),UPPER(TRIM(currency)) FROM settings WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
    let mut blocking_issues = Vec::new();
    if organisation_name.trim().is_empty() || organisation_name.chars().count() > 255 {
        push_issue(
            &mut blocking_issues,
            "invalid_organisation_name",
            "Le nom d'organisation doit contenir entre 1 et 255 caractères pour l'export eCH."
                .into(),
            None,
            None,
        );
    }
    if base_currency != "CHF" {
        push_issue(
            &mut blocking_issues,
            "non_chf_ledger",
            format!(
                "Décompte bloqué : la monnaie de tenue locale est {base_currency}; aucun registre de conversion CHF traçable n'est disponible."
            ),
            None,
            None,
        );
    }
    let organisation_uid = match raw_uid.as_deref().map(normalize_uid).transpose() {
        Ok(Some(uid)) => uid,
        Ok(None) => {
            push_issue(
                &mut blocking_issues,
                "missing_uid",
                "Décompte bloqué : renseignez le numéro IDE/TVA CHE de l'entreprise.".into(),
                None,
                None,
            );
            String::new()
        }
        Err(error) => {
            push_issue(
                &mut blocking_issues,
                "invalid_uid",
                error.to_string(),
                None,
                None,
            );
            String::new()
        }
    };

    let mut source_issues = Vec::new();
    let sources = load_raw_vat_sources(
        connection,
        &profile,
        &date_from,
        &date_to,
        &mut source_issues,
    )?;
    blocking_issues.extend(source_issues);
    let adjustments = load_adjustments_for_period(connection, &date_from, &date_to)?;

    let source_snapshot = SourceFingerprint {
        schema: "elyko.vat-source-fingerprint.v1",
        profile: &profile,
        date_from: &date_from,
        date_to: &date_to,
        submission_type: &submission_type,
        organisation_uid: &organisation_uid,
        organisation_name: &organisation_name,
        sources: &sources,
        adjustments: &adjustments,
    };
    let source_sha256 = sha256_hex(&serde_json::to_vec(&source_snapshot)?);

    let mut unclassified_sources = Vec::new();
    let mut calculation = CalculationBuilder::default();
    let include_transactions = submission_type != "annual_reconciliation";
    for source in &sources {
        if source.treatment.is_none() {
            unclassified_sources.push(VatUnclassifiedSource {
                source_type: source.source_type.clone(),
                source_id: source.source_id.clone(),
                parent_id: source.parent_id.clone(),
                occurrence_date: source.occurrence_date.clone(),
                description: source.description.clone(),
                amount_cents: if profile.reporting_method == "simple_tax_rate"
                    || profile.gross_or_net == "gross"
                {
                    source.total_cents
                } else {
                    source.net_cents
                },
                vat_cents: source.vat_cents,
                vat_rate_bp: source.vat_rate_bp,
            });
            continue;
        }
        if !include_transactions || !source.reliable || source.currency != "CHF" {
            continue;
        }
        apply_classified_source(&mut calculation, source, &profile)?;
    }
    if !unclassified_sources.is_empty() {
        push_issue(
            &mut blocking_issues,
            "unclassified_sources",
            format!(
                "{} source(s) pertinente(s) n'ont pas de traitement TVA explicite.",
                unclassified_sources.len()
            ),
            None,
            None,
        );
    }
    for adjustment in &adjustments {
        apply_adjustment(&mut calculation, adjustment)?;
    }

    let taxable_turnover = calculation
        .total_consideration
        .checked_sub(calculation.supplies_to_foreign)
        .and_then(|value| value.checked_sub(calculation.supplies_abroad))
        .and_then(|value| value.checked_sub(calculation.transfer_notification))
        .and_then(|value| value.checked_sub(calculation.supplies_exempt))
        .and_then(|value| value.checked_sub(calculation.reduction_of_consideration))
        .and_then(|value| value.checked_sub(calculation.various_deduction))
        .ok_or_else(money_overflow)?;
    let supplied_turnover = calculation
        .supplies_by_rate
        .values()
        .try_fold(0_i128, |sum, amount| {
            sum.checked_add(*amount).ok_or_else(money_overflow)
        })?;
    if taxable_turnover != supplied_turnover {
        push_issue(
            &mut blocking_issues,
            "taxable_turnover_mismatch",
            format!(
                "Décompte bloqué : le chiffre 299 calculé ({}) ne correspond pas à la somme des chiffres 300–379 ({}).",
                format_cents_i128(taxable_turnover),
                format_cents_i128(supplied_turnover)
            ),
            None,
            None,
        );
    }
    if calculation.opted > taxable_turnover && calculation.opted > 0 {
        push_issue(
            &mut blocking_issues,
            "opted_exceeds_taxable",
            "Le montant opté (chiffre 205) dépasse le chiffre d'affaires imposable calculé.".into(),
            None,
            None,
        );
    }
    if calculation.supplies_by_rate.len() > MAX_ECH_RATE_LINES
        || calculation.acquisition_by_rate.len() > MAX_ECH_RATE_LINES
    {
        push_issue(
            &mut blocking_issues,
            "too_many_rate_lines",
            "Le XSD eCH-0217 accepte au plus 100 lignes de taux pour les prestations et 100 pour l'impôt sur les acquisitions."
                .into(),
            None,
            None,
        );
    }
    for rate in calculation
        .supplies_by_rate
        .keys()
        .chain(calculation.acquisition_by_rate.keys())
    {
        if !valid_swiss_legal_rate(&date_from, *rate) {
            push_issue(
                &mut blocking_issues,
                "unsupported_tax_rate",
                format!(
                    "Le taux {}% n'est pas un taux légal suisse pris en charge pour cette période; vérifiez la source AFC avant l'export.",
                    format_percent(*rate)
                ),
                None,
                None,
            );
        }
    }
    if profile.reporting_method == "simple_tax_rate"
        && (calculation.input_materials != 0
            || calculation.input_investments != 0
            || calculation.subsequent_input_tax != 0
            || calculation.input_tax_reductions != 0
            || calculation.opted != 0)
    {
        push_issue(
            &mut blocking_issues,
            "unsupported_simple_tax_rate_adjustment",
            "Un ajustement actif vise un champ qui n'existe pas dans simpleTaxRateMethod (périodes dès 2025); extournez-le ou utilisez une catégorie eCH compatible."
                .into(),
            None,
            None,
        );
    }

    let turnover_computation = VatTurnoverComputationPreview {
        total_consideration_cents: checked_i64(
            calculation.total_consideration,
            "totalConsideration",
        )?,
        supplies_to_foreign_countries_cents: checked_i64(
            calculation.supplies_to_foreign,
            "suppliesToForeignCountries",
        )?,
        supplies_abroad_cents: checked_i64(calculation.supplies_abroad, "suppliesAbroad")?,
        transfer_notification_procedure_cents: checked_i64(
            calculation.transfer_notification,
            "transferNotificationProcedure",
        )?,
        supplies_exempt_from_tax_cents: checked_i64(
            calculation.supplies_exempt,
            "suppliesExemptFromTax",
        )?,
        reduction_of_consideration_cents: checked_i64(
            calculation.reduction_of_consideration,
            "reductionOfConsideration",
        )?,
        various_deduction: if calculation.various_deduction == 0 {
            None
        } else {
            Some(VatVariousDeduction {
                amount_cents: checked_i64(calculation.various_deduction, "variousDeduction")?,
                description: "Divers, détails dans l'aperçu Zentra".into(),
            })
        },
        taxable_turnover_cents: checked_i64(taxable_turnover, "taxableTurnover")?,
    };

    let (effective_reporting_method, simple_tax_rate_method, payable_tax_cents) =
        calculate_method_preview(&profile, &calculation)?;
    let mut warnings = vec![
        "Pré-déclaration locale : le fichier n'est ni transmis à l'AFC, ni accepté, ni certifié par Zentra. Il doit être contrôlé puis importé manuellement dans « Décompter la TVA ».".into(),
        "L'identité CHE est normalisée localement; sa concordance avec le compte AFC ne peut être vérifiée hors ligne.".into(),
    ];
    if profile.form_of_reporting == "received" {
        warnings.push(
            "Mode reçu : seules les factures dont tous les paiements se situent dans cette période et soldent exactement le document sont calculées; toute ventilation inter-périodes bloque l'export."
                .into(),
        );
    }
    if submission_type == "annual_reconciliation" {
        warnings.push(
            "La concordance annuelle eCH contient uniquement les ajustements datés dans la période (delta), jamais une répétition des transactions du décompte complet."
                .into(),
        );
        if adjustments.is_empty() {
            push_issue(
                &mut blocking_issues,
                "empty_annual_reconciliation",
                "Une concordance annuelle doit contenir au moins un ajustement explicite représentant le delta constaté."
                    .into(),
                None,
                None,
            );
        }
    }
    if profile.reporting_method == "simple_tax_rate" {
        warnings.push(
            "Le code d'activité et le taux TDFN/TaF proviennent de la confirmation utilisateur; Zentra ne peut pas vérifier hors ligne l'autorisation partenaire AFC."
                .into(),
        );
    }

    sort_and_deduplicate_issues(&mut blocking_issues);
    unclassified_sources.sort_by(|left, right| {
        (&left.source_type, &left.source_id).cmp(&(&right.source_type, &right.source_id))
    });
    let mut classified_sources = sources
        .iter()
        .filter_map(|source| {
            if source.source_type == "invoice_item" {
                return None;
            }
            source
                .treatment
                .as_ref()
                .map(|treatment| VatClassifiedSource {
                    source: VatUnclassifiedSource {
                        source_type: source.source_type.clone(),
                        source_id: source.source_id.clone(),
                        parent_id: source.parent_id.clone(),
                        occurrence_date: source.occurrence_date.clone(),
                        description: source.description.clone(),
                        amount_cents: source.net_cents,
                        vat_cents: source.vat_cents,
                        vat_rate_bp: source.vat_rate_bp,
                    },
                    treatment: treatment.clone(),
                    currency: source.currency.clone(),
                })
        })
        .collect::<Vec<_>>();
    classified_sources.sort_by(|left, right| {
        right
            .source
            .occurrence_date
            .cmp(&left.source.occurrence_date)
            .then_with(|| left.source.source_id.cmp(&right.source.source_id))
    });
    let current_source_ids: BTreeSet<_> = sources
        .iter()
        .map(|source| (source.source_type.as_str(), source.source_id.as_str()))
        .collect();
    let pre_closing_sources = load_received_pre_closing_sources(connection, &profile, &date_to)?
        .into_iter()
        .filter(|source| {
            !current_source_ids.contains(&(source.source_type.as_str(), source.source_id.as_str()))
        })
        .map(|source| VatPreClosingSource {
            currency: source.currency,
            source: VatUnclassifiedSource {
                source_type: source.source_type,
                source_id: source.source_id,
                parent_id: source.parent_id,
                occurrence_date: source.occurrence_date,
                description: source.description,
                amount_cents: source.net_cents,
                vat_cents: source.vat_cents,
                vat_rate_bp: source.vat_rate_bp,
            },
        })
        .collect();
    let mut received_allocations = sources
        .iter()
        .flat_map(|source| {
            source
                .received_payments
                .iter()
                .map(|payment| VatReceivedAllocation {
                    source_type: source.source_type.clone(),
                    source_id: source.source_id.clone(),
                    parent_id: source.parent_id.clone(),
                    description: source.description.clone(),
                    currency: source.currency.clone(),
                    payment: payment.clone(),
                })
        })
        .collect::<Vec<_>>();
    received_allocations.sort_by(|left, right| {
        (
            &left.payment.date,
            &left.payment.payment_id,
            &left.source_id,
        )
            .cmp(&(
                &right.payment.date,
                &right.payment.payment_id,
                &right.source_id,
            ))
    });
    Ok(VatReturnPreview {
        standard: ECH_STANDARD.into(),
        standard_version: ECH_VERSION.into(),
        currency: "CHF".into(),
        profile,
        date_from,
        date_to,
        submission_type,
        exportable: blocking_issues.is_empty(),
        blocking_issues,
        warnings,
        unclassified_sources,
        classified_sources,
        received_allocations,
        pre_closing_sources,
        source_sha256,
        turnover_computation,
        effective_reporting_method,
        simple_tax_rate_method,
        payable_tax_cents,
        payable_code: if payable_tax_cents < 0 {
            "510".into()
        } else {
            "500".into()
        },
        other_flows_of_funds: VatOtherFlowsPreview {
            subsidies_cents: checked_i64(calculation.subsidies, "subsidies")?,
            donations_cents: checked_i64(calculation.donations, "donations")?,
        },
        source_count: sources.len(),
        adjustment_count: adjustments.len(),
        transmission_wording: "Généré localement pour contrôle et import manuel; aucune transmission AFC n'a été effectuée."
            .into(),
    })
}

fn load_raw_vat_sources(
    connection: &Connection,
    profile: &VatProfile,
    date_from: &str,
    date_to: &str,
    issues: &mut Vec<VatBlockingIssue>,
) -> AppResult<Vec<RawVatSource>> {
    transition::append_period_issues(connection, profile, date_to, issues)?;
    let mut sources = load_sales_sources(
        connection,
        &profile.form_of_reporting,
        date_from,
        date_to,
        issues,
    )?;
    if profile.reporting_method == "effective" {
        sources.extend(load_supplier_sources(
            connection,
            &profile.form_of_reporting,
            date_from,
            date_to,
            issues,
        )?);
        sources.extend(load_expense_sources(
            connection,
            &profile.form_of_reporting,
            date_from,
            date_to,
        )?);
        if profile.form_of_reporting == "agreed" {
            sources.extend(load_supplier_credit_sources(
                connection, date_from, date_to,
            )?);
        }
    }
    let mut unreliable_parents = BTreeSet::new();
    let mut foreign_parents = BTreeSet::new();
    for source in &sources {
        if !source.reliable && unreliable_parents.insert(source.parent_id.clone()) {
            push_issue(
                issues,
                "unreliable_received_allocation",
                source.reliability_detail.clone().unwrap_or_else(|| {
                    "La période d'encaissement ou de paiement ne peut pas être ventilée exactement."
                        .into()
                }),
                Some(source.source_type.clone()),
                Some(source.source_id.clone()),
            );
        }
        if source.currency != "CHF" && foreign_parents.insert(source.parent_id.clone()) {
            push_issue(
                issues,
                "foreign_currency_source",
                format!(
                    "La source {} est en {}; aucun cours CHF documenté n'est disponible pour le décompte.",
                    source.parent_id, source.currency
                ),
                Some(source.source_type.clone()),
                Some(source.source_id.clone()),
            );
        }
    }
    sources.sort_by(|left, right| {
        (
            &left.occurrence_date,
            &left.source_type,
            &left.parent_id,
            &left.source_id,
        )
            .cmp(&(
                &right.occurrence_date,
                &right.source_type,
                &right.parent_id,
                &right.source_id,
            ))
    });
    Ok(sources)
}

/// Unclassified issued documents may have no receipt yet, but their original
/// accounting period must remain open until their classification is decided.
/// These rows are never added to the received return's tax bases or fingerprint.
fn load_received_pre_closing_sources(
    connection: &Connection,
    profile: &VatProfile,
    date_to: &str,
) -> AppResult<Vec<RawVatSource>> {
    if profile.form_of_reporting != "received" {
        return Ok(Vec::new());
    }
    let mut ignored_issues = Vec::new();
    let mut sources = load_sales_sources(
        connection,
        "agreed",
        &profile.effective_from,
        date_to,
        &mut ignored_issues,
    )?;
    if profile.reporting_method == "effective" {
        sources.extend(load_supplier_sources(
            connection,
            "agreed",
            &profile.effective_from,
            date_to,
            &mut ignored_issues,
        )?);
        sources.extend(load_expense_sources(
            connection,
            "agreed",
            &profile.effective_from,
            date_to,
        )?);
        sources.extend(load_supplier_credit_sources(
            connection,
            &profile.effective_from,
            date_to,
        )?);
    }
    sources.retain(|source| {
        source.classification_id.is_none()
            || !source.treatment.as_deref().is_some_and(|treatment| {
                validate_source_type_and_treatment(&source.source_type, treatment).is_ok()
            })
    });
    sources.sort_by(|left, right| {
        right
            .occurrence_date
            .cmp(&left.occurrence_date)
            .then_with(|| {
                (&left.source_type, &left.source_id).cmp(&(&right.source_type, &right.source_id))
            })
    });
    Ok(sources)
}

fn load_sales_sources(
    connection: &Connection,
    form: &str,
    date_from: &str,
    date_to: &str,
    issues: &mut Vec<VatBlockingIssue>,
) -> AppResult<Vec<RawVatSource>> {
    if form == "agreed" {
        let mut statement = connection.prepare(
            "SELECT item.id,invoice.id,invoice.issue_date,item.description,UPPER(TRIM(invoice.currency)),item.line_net_cents,item.line_vat_cents,item.line_total_cents,item.vat_bp,classification.id,classification.treatment,classification.note,classification.updated_at
             FROM invoice_items item
             JOIN invoices invoice ON invoice.id=item.invoice_id
             LEFT JOIN vat_source_classifications classification ON classification.source_type='invoice_item' AND classification.source_id=item.id
             WHERE invoice.number IS NOT NULL AND invoice.status IN ('emise','partiellement_payee','payee')
               AND invoice.issue_date BETWEEN ? AND ?
               AND (item.line_net_cents<>0 OR item.line_vat_cents<>0 OR item.line_total_cents<>0)
             ORDER BY invoice.issue_date,invoice.id,item.position,item.id",
        )?;
        let rows = statement.query_map(params![date_from, date_to], |row| {
            Ok(RawVatSource {
                source_type: "invoice_item".into(),
                source_id: row.get(0)?,
                parent_id: row.get(1)?,
                occurrence_date: row.get(2)?,
                description: row.get(3)?,
                currency: row.get(4)?,
                net_cents: row.get(5)?,
                vat_cents: row.get(6)?,
                total_cents: row.get(7)?,
                vat_rate_bp: Some(row.get(8)?),
                classification_id: row.get(9)?,
                treatment: row.get(10)?,
                classification_note: row.get(11)?,
                classification_updated_at: row.get(12)?,
                reliable: true,
                reliability_detail: None,
                received_payments: Vec::new(),
            })
        })?;
        return rows.collect::<Result<Vec<_>, _>>().map_err(Into::into);
    }

    let credit_note_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM invoices WHERE type='avoir' AND number IS NOT NULL AND status<>'annulee' AND issue_date<=?",
        params![date_to],
        |row| row.get(0),
    )?;
    if credit_note_count != 0 {
        push_issue(
            issues,
            "received_credit_note_timing_unknown",
            "Mode reçu bloqué : les avoirs clients locaux n'enregistrent pas une date d'imputation ou de remboursement permettant leur affectation exacte à une période TVA."
                .into(),
            None,
            None,
        );
    }
    received::load_sources(connection, "invoice_item", date_from, date_to, issues)
}

fn load_supplier_sources(
    connection: &Connection,
    form: &str,
    date_from: &str,
    date_to: &str,
    issues: &mut Vec<VatBlockingIssue>,
) -> AppResult<Vec<RawVatSource>> {
    let credit_note_count: i64 = if form == "agreed" {
        0
    } else {
        connection.query_row(
            "SELECT COUNT(*) FROM supplier_credit_notes WHERE status='validated' AND vat_cents<>0 AND document_date<=?",
            params![date_to],
            |row| row.get(0),
        )?
    };
    if credit_note_count != 0 {
        push_issue(
            issues,
            "unsupported_supplier_credit_tax",
            "Mode reçu bloqué : les avoirs fournisseurs nécessitent une date d'imputation ou de remboursement fiscalement justifiée. La date du document ne suffit pas à les affecter à ce décompte."
                .into(),
            None,
            None,
        );
    }
    if form == "agreed" {
        let mut statement = connection.prepare(
            "SELECT item.id,invoice.id,invoice.document_date,item.description,UPPER(TRIM(invoice.currency)),item.line_net_cents,item.line_vat_cents,item.line_total_cents,item.vat_bp,classification.id,classification.treatment,classification.note,classification.updated_at
             FROM supplier_invoice_items item
             JOIN supplier_invoices invoice ON invoice.id=item.supplier_invoice_id
             LEFT JOIN vat_source_classifications classification ON classification.source_type='supplier_invoice_item' AND classification.source_id=item.id
             WHERE invoice.status='validated' AND invoice.document_date BETWEEN ? AND ?
               AND (item.line_net_cents<>0 OR item.line_vat_cents<>0 OR item.line_total_cents<>0)
             ORDER BY invoice.document_date,invoice.id,item.position,item.id",
        )?;
        let rows = statement.query_map(params![date_from, date_to], |row| {
            Ok(RawVatSource {
                source_type: "supplier_invoice_item".into(),
                source_id: row.get(0)?,
                parent_id: row.get(1)?,
                occurrence_date: row.get(2)?,
                description: row.get(3)?,
                currency: row.get(4)?,
                net_cents: row.get(5)?,
                vat_cents: row.get(6)?,
                total_cents: row.get(7)?,
                vat_rate_bp: Some(row.get(8)?),
                classification_id: row.get(9)?,
                treatment: row.get(10)?,
                classification_note: row.get(11)?,
                classification_updated_at: row.get(12)?,
                reliable: true,
                reliability_detail: None,
                received_payments: Vec::new(),
            })
        })?;
        return rows.collect::<Result<Vec<_>, _>>().map_err(Into::into);
    }

    received::load_sources(
        connection,
        "supplier_invoice_item",
        date_from,
        date_to,
        issues,
    )
}

fn load_supplier_credit_sources(
    connection: &Connection,
    date_from: &str,
    date_to: &str,
) -> AppResult<Vec<RawVatSource>> {
    let mut statement = connection.prepare(
        "SELECT item.id,credit.id,credit.document_date,item.description,UPPER(TRIM(credit.currency)),-item.line_net_cents,-item.line_vat_cents,-item.line_total_cents,item.vat_bp,classification.id,classification.treatment,classification.note,classification.updated_at
         FROM supplier_credit_note_items item JOIN supplier_credit_notes credit ON credit.id=item.supplier_credit_note_id
         LEFT JOIN vat_source_classifications classification ON classification.source_type='supplier_credit_note_item' AND classification.source_id=item.id
         WHERE credit.status='validated' AND credit.document_date BETWEEN ? AND ? AND (item.line_net_cents<>0 OR item.line_vat_cents<>0 OR item.line_total_cents<>0)
         ORDER BY credit.document_date,credit.id,item.position,item.id"
    )?;
    let rows = statement.query_map(params![date_from, date_to], |row| {
        Ok(RawVatSource {
            source_type: "supplier_credit_note_item".into(),
            source_id: row.get(0)?,
            parent_id: row.get(1)?,
            occurrence_date: row.get(2)?,
            description: format!("Avoir fournisseur · {}", row.get::<_, String>(3)?),
            currency: row.get(4)?,
            net_cents: row.get(5)?,
            vat_cents: row.get(6)?,
            total_cents: row.get(7)?,
            vat_rate_bp: Some(row.get(8)?),
            classification_id: row.get(9)?,
            treatment: row.get(10)?,
            classification_note: row.get(11)?,
            classification_updated_at: row.get(12)?,
            reliable: true,
            reliability_detail: None,
            received_payments: Vec::new(),
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn load_expense_sources(
    connection: &Connection,
    form: &str,
    date_from: &str,
    date_to: &str,
) -> AppResult<Vec<RawVatSource>> {
    let (date_expression, status_filter) = if form == "received" {
        (
            "COALESCE(NULLIF(expense.paid_at,''),expense.date)",
            "AND expense.payment_status='paid'",
        )
    } else {
        ("expense.date", "")
    };
    let sql = format!(
        "SELECT expense.id,{date_expression},COALESCE(NULLIF(TRIM(expense.supplier),''),NULLIF(TRIM(expense.category),''),NULLIF(TRIM(expense.reference),''),expense.id),UPPER(TRIM(expense.currency)),expense.net_cents,expense.vat_cents,expense.total_cents,classification.id,classification.treatment,classification.note,classification.updated_at
         FROM expenses expense
         LEFT JOIN vat_source_classifications classification ON classification.source_type='expense' AND classification.source_id=expense.id
         WHERE {date_expression} BETWEEN ? AND ? {status_filter}
           AND (expense.net_cents<>0 OR expense.vat_cents<>0 OR expense.total_cents<>0)
         ORDER BY {date_expression},expense.id"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params![date_from, date_to], |row| {
        let id: String = row.get(0)?;
        Ok(RawVatSource {
            source_type: "expense".into(),
            source_id: id.clone(),
            parent_id: id,
            occurrence_date: row.get(1)?,
            description: row.get(2)?,
            currency: row.get(3)?,
            net_cents: row.get(4)?,
            vat_cents: row.get(5)?,
            total_cents: row.get(6)?,
            vat_rate_bp: None,
            classification_id: row.get(7)?,
            treatment: row.get(8)?,
            classification_note: row.get(9)?,
            classification_updated_at: row.get(10)?,
            reliable: true,
            reliability_detail: None,
            received_payments: Vec::new(),
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn apply_classified_source(
    calculation: &mut CalculationBuilder,
    source: &RawVatSource,
    profile: &VatProfile,
) -> AppResult<()> {
    let treatment = source
        .treatment
        .as_deref()
        .ok_or_else(|| AppError::Validation("Classification TVA absente.".into()))?;
    match source.source_type.as_str() {
        "invoice_item" => {
            let amount = if profile.reporting_method == "simple_tax_rate"
                || profile.gross_or_net == "gross"
            {
                i128::from(source.total_cents)
            } else {
                i128::from(source.net_cents)
            };
            add_money(
                &mut calculation.total_consideration,
                amount,
                "totalConsideration",
            )?;
            match treatment {
                "taxable" | "opted" => {
                    let rate = source.vat_rate_bp.ok_or_else(|| {
                        AppError::Validation(format!(
                            "Le taux TVA de la ligne {} est absent.",
                            source.source_id
                        ))
                    })?;
                    add_rate_turnover(&mut calculation.supplies_by_rate, rate, amount)?;
                    if treatment == "opted" && profile.reporting_method == "effective" {
                        add_money(&mut calculation.opted, amount, "opted")?;
                    }
                }
                "supplies_to_foreign" => add_money(
                    &mut calculation.supplies_to_foreign,
                    amount,
                    "suppliesToForeignCountries",
                )?,
                "supplies_abroad" => {
                    add_money(&mut calculation.supplies_abroad, amount, "suppliesAbroad")?
                }
                "transfer_notification" => add_money(
                    &mut calculation.transfer_notification,
                    amount,
                    "transferNotificationProcedure",
                )?,
                "exempt" => add_money(
                    &mut calculation.supplies_exempt,
                    amount,
                    "suppliesExemptFromTax",
                )?,
                "out_of_scope" => add_money(
                    &mut calculation.various_deduction,
                    amount,
                    "variousDeduction",
                )?,
                _ => {
                    return Err(AppError::Validation(format!(
                        "Traitement TVA de vente inattendu : {treatment}."
                    )))
                }
            }
        }
        "supplier_invoice_item" | "supplier_credit_note_item" | "expense" => match treatment {
            "input_materials" => add_money(
                &mut calculation.input_materials,
                i128::from(source.vat_cents),
                "inputTaxMaterialAndServices",
            )?,
            "input_investments" => add_money(
                &mut calculation.input_investments,
                i128::from(source.vat_cents),
                "inputTaxInvestments",
            )?,
            "non_deductible" => {}
            _ => {
                return Err(AppError::Validation(format!(
                    "Traitement TVA d'achat inattendu : {treatment}."
                )))
            }
        },
        _ => {
            return Err(AppError::Validation(format!(
                "Type de source TVA inattendu : {}.",
                source.source_type
            )))
        }
    }
    Ok(())
}

fn apply_adjustment(
    calculation: &mut CalculationBuilder,
    adjustment: &VatAdjustment,
) -> AppResult<()> {
    let amount = i128::from(adjustment.amount_cents);
    match adjustment.category.as_str() {
        "supplies_to_foreign" => {
            add_money(
                &mut calculation.total_consideration,
                amount,
                "totalConsideration",
            )?;
            add_money(
                &mut calculation.supplies_to_foreign,
                amount,
                "suppliesToForeignCountries",
            )?;
        }
        "supplies_abroad" => {
            add_money(
                &mut calculation.total_consideration,
                amount,
                "totalConsideration",
            )?;
            add_money(&mut calculation.supplies_abroad, amount, "suppliesAbroad")?;
        }
        "transfer_notification" => {
            add_money(
                &mut calculation.total_consideration,
                amount,
                "totalConsideration",
            )?;
            add_money(
                &mut calculation.transfer_notification,
                amount,
                "transferNotificationProcedure",
            )?;
        }
        "supplies_exempt" => {
            add_money(
                &mut calculation.total_consideration,
                amount,
                "totalConsideration",
            )?;
            add_money(
                &mut calculation.supplies_exempt,
                amount,
                "suppliesExemptFromTax",
            )?;
        }
        "reduction_of_consideration" => add_money(
            &mut calculation.reduction_of_consideration,
            amount,
            "reductionOfConsideration",
        )?,
        "various_deduction" => {
            add_money(
                &mut calculation.total_consideration,
                amount,
                "totalConsideration",
            )?;
            add_money(
                &mut calculation.various_deduction,
                amount,
                "variousDeduction",
            )?;
        }
        "opted" => add_money(&mut calculation.opted, amount, "opted")?,
        "acquisition_tax" => add_rate_turnover(
            &mut calculation.acquisition_by_rate,
            adjustment.tax_rate_bp.ok_or_else(|| {
                AppError::Validation("Taux absent sur un ajustement acquisition_tax.".into())
            })?,
            amount,
        )?,
        "input_materials" => add_money(
            &mut calculation.input_materials,
            amount,
            "inputTaxMaterialAndServices",
        )?,
        "input_investments" => add_money(
            &mut calculation.input_investments,
            amount,
            "inputTaxInvestments",
        )?,
        "subsequent_input_tax" => add_money(
            &mut calculation.subsequent_input_tax,
            amount,
            "subsequentInputTaxDeduction",
        )?,
        "input_tax_corrections" => add_money(
            &mut calculation.input_tax_corrections,
            amount,
            "inputTaxCorrections",
        )?,
        "input_tax_reductions" => add_money(
            &mut calculation.input_tax_reductions,
            amount,
            "inputTaxReductions",
        )?,
        "subsidies" => add_money(&mut calculation.subsidies, amount, "subsidies")?,
        "donations" => add_money(&mut calculation.donations, amount, "donations")?,
        _ => {
            return Err(AppError::Validation(format!(
                "Catégorie d'ajustement inattendue : {}.",
                adjustment.category
            )))
        }
    }
    Ok(())
}

fn calculate_method_preview(
    profile: &VatProfile,
    calculation: &CalculationBuilder,
) -> AppResult<(
    Option<VatEffectiveReportingMethodPreview>,
    Option<VatSimpleTaxRateMethodPreview>,
    i64,
)> {
    let mut acquisition_lines = Vec::new();
    let mut acquisition_exact = Rational::ZERO;
    for (rate, turnover) in &calculation.acquisition_by_rate {
        if *turnover == 0 {
            continue;
        }
        let tax = rate_tax(*turnover, *rate, false)?;
        acquisition_exact = acquisition_exact.add(tax)?;
        acquisition_lines.push(VatRateLine {
            tax_rate_bp: *rate,
            turnover_cents: checked_i64(*turnover, "acquisitionTax.turnover")?,
            calculated_tax_cents: tax.rounded_cents()?,
        });
    }

    if profile.reporting_method == "effective" {
        let gross = profile.gross_or_net == "gross";
        let mut supply_lines = Vec::new();
        let mut output_exact = Rational::ZERO;
        for (rate, turnover) in &calculation.supplies_by_rate {
            if *turnover == 0 {
                continue;
            }
            let tax = rate_tax(*turnover, *rate, gross)?;
            output_exact = output_exact.add(tax)?;
            supply_lines.push(VatRateLine {
                tax_rate_bp: *rate,
                turnover_cents: checked_i64(*turnover, "suppliesPerTaxRate.turnover")?,
                calculated_tax_cents: tax.rounded_cents()?,
            });
        }
        let payable = output_exact
            .add(acquisition_exact)?
            .subtract_integer(calculation.input_materials)?
            .subtract_integer(calculation.input_investments)?
            .subtract_integer(calculation.subsequent_input_tax)?
            .add_integer(calculation.input_tax_corrections)?
            .add_integer(calculation.input_tax_reductions)?
            .rounded_cents()?;
        let effective = VatEffectiveReportingMethodPreview {
            gross_or_net: profile.gross_or_net.clone(),
            gross_or_net_code: if gross { 2 } else { 1 },
            opted_cents: checked_i64(calculation.opted, "opted")?,
            supplies_per_tax_rate: supply_lines,
            acquisition_tax: acquisition_lines,
            input_tax_material_and_services_cents: checked_i64(
                calculation.input_materials,
                "inputTaxMaterialAndServices",
            )?,
            input_tax_investments_cents: checked_i64(
                calculation.input_investments,
                "inputTaxInvestments",
            )?,
            subsequent_input_tax_deduction_cents: checked_i64(
                calculation.subsequent_input_tax,
                "subsequentInputTaxDeduction",
            )?,
            input_tax_corrections_cents: checked_i64(
                calculation.input_tax_corrections,
                "inputTaxCorrections",
            )?,
            input_tax_reductions_cents: checked_i64(
                calculation.input_tax_reductions,
                "inputTaxReductions",
            )?,
            output_tax_cents: output_exact.rounded_cents()?,
            acquisition_tax_cents: acquisition_exact.rounded_cents()?,
        };
        return Ok((Some(effective), None, payable));
    }

    let taxable_turnover = calculation
        .supplies_by_rate
        .values()
        .try_fold(0_i128, |sum, turnover| {
            sum.checked_add(*turnover).ok_or_else(money_overflow)
        })?;
    let tdfn_rate = profile.tdfn_rate_bp.ok_or_else(|| {
        AppError::Validation("Le profil TDFN/TaF ne contient aucun taux autorisé.".into())
    })?;
    let activity_id = profile.tdfn_activity_id.clone().ok_or_else(|| {
        AppError::Validation("Le profil TDFN/TaF ne contient aucun code d'activité.".into())
    })?;
    let output_exact = if taxable_turnover == 0 {
        Rational::ZERO
    } else {
        rate_tax(taxable_turnover, tdfn_rate, false)?
    };
    let supplies_per_tax_rate = if taxable_turnover == 0 {
        Vec::new()
    } else {
        vec![VatActivityRateLine {
            activity_id,
            tax_rate_bp: tdfn_rate,
            turnover_cents: checked_i64(taxable_turnover, "suppliesPerTaxRate.turnover")?,
            calculated_tax_cents: output_exact.rounded_cents()?,
        }]
    };
    let payable = output_exact
        .add(acquisition_exact)?
        .add_integer(calculation.input_tax_corrections)?
        .rounded_cents()?;
    let simple = VatSimpleTaxRateMethodPreview {
        supplies_per_tax_rate,
        acquisition_tax: acquisition_lines,
        input_tax_corrections_cents: checked_i64(
            calculation.input_tax_corrections,
            "inputTaxCorrections",
        )?,
        output_tax_cents: output_exact.rounded_cents()?,
        acquisition_tax_cents: acquisition_exact.rounded_cents()?,
    };
    Ok((None, Some(simple), payable))
}

fn rate_tax(turnover_cents: i128, rate_bp: i64, gross: bool) -> AppResult<Rational> {
    if !(0..=10_000).contains(&rate_bp) {
        return Err(AppError::Validation(format!(
            "Taux TVA hors plage : {rate_bp} points de base."
        )));
    }
    let numerator = turnover_cents
        .checked_mul(i128::from(rate_bp))
        .ok_or_else(money_overflow)?;
    let denominator = if gross {
        i128::from(10_000_i64 + rate_bp)
    } else {
        10_000
    };
    Rational::new(numerator, denominator)
}

fn add_money(target: &mut i128, amount: i128, field: &str) -> AppResult<()> {
    let value = target.checked_add(amount).ok_or_else(money_overflow)?;
    if value.abs() > MAX_MONEY_CENTS {
        return Err(AppError::Validation(format!(
            "{field} dépasse la capacité monétaire locale."
        )));
    }
    *target = value;
    Ok(())
}

fn add_rate_turnover(rates: &mut BTreeMap<i64, i128>, rate: i64, amount: i128) -> AppResult<()> {
    let current = rates.get(&rate).copied().unwrap_or(0);
    let next = current.checked_add(amount).ok_or_else(money_overflow)?;
    if next.abs() > MAX_MONEY_CENTS {
        return Err(AppError::Validation(
            "Le chiffre d'affaires groupé par taux dépasse la capacité monétaire locale.".into(),
        ));
    }
    if next == 0 {
        rates.remove(&rate);
    } else {
        rates.insert(rate, next);
    }
    Ok(())
}

fn checked_i64(value: i128, field: &str) -> AppResult<i64> {
    if value.abs() > MAX_MONEY_CENTS {
        return Err(AppError::Validation(format!(
            "{field} dépasse la capacité monétaire locale."
        )));
    }
    i64::try_from(value).map_err(|_| money_overflow())
}

fn validate_reporting_period(
    profile: &VatProfile,
    date_from: &str,
    date_to: &str,
    submission_type: &str,
) -> AppResult<()> {
    let from = parse_date(date_from, "date_from")?;
    let to = parse_date(date_to, "date_to")?;
    if submission_type == "annual_reconciliation" {
        let expected_from = NaiveDate::from_ymd_opt(from.year(), 1, 1)
            .ok_or_else(|| AppError::Validation("Année de décompte invalide.".into()))?;
        let expected_to = NaiveDate::from_ymd_opt(from.year(), 12, 31)
            .ok_or_else(|| AppError::Validation("Année de décompte invalide.".into()))?;
        if from != expected_from || to != expected_to {
            return Err(AppError::Validation(
                "Une concordance annuelle doit couvrir l'année fiscale entière (01-01 au 31-12)."
                    .into(),
            ));
        }
        return Ok(());
    }
    if from.day() != 1 {
        return Err(AppError::Validation(
            "La période TVA doit commencer le premier jour du mois.".into(),
        ));
    }
    let months = match profile.periodicity.as_str() {
        "monthly" => 1,
        "quarterly" if matches!(from.month(), 1 | 4 | 7 | 10) => 3,
        "semiannual" if matches!(from.month(), 1 | 7) => 6,
        "annual" if from.month() == 1 => 12,
        "quarterly" => {
            return Err(AppError::Validation(
                "Un trimestre TVA doit commencer en janvier, avril, juillet ou octobre.".into(),
            ))
        }
        "semiannual" => {
            return Err(AppError::Validation(
                "Un semestre TVA doit commencer en janvier ou juillet.".into(),
            ))
        }
        "annual" => {
            return Err(AppError::Validation(
                "Une période TVA annuelle doit commencer le 1er janvier.".into(),
            ))
        }
        _ => {
            return Err(AppError::Validation(
                "Périodicité du profil TVA invalide.".into(),
            ))
        }
    };
    let expected_to = from
        .checked_add_months(Months::new(months))
        .and_then(|date| date.pred_opt())
        .ok_or_else(|| AppError::Validation("Période TVA hors plage.".into()))?;
    if to != expected_to {
        return Err(AppError::Validation(format!(
            "La période {} exige une date de fin au {}.",
            profile.periodicity,
            expected_to.format("%Y-%m-%d")
        )));
    }
    Ok(())
}

fn normalize_uid(value: &str) -> AppResult<String> {
    let mut value = value.trim().to_uppercase();
    for suffix in ["MWST", "TVA", "IVA", "VAT"] {
        value = value.replace(suffix, "");
    }
    let normalized = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    if normalized.len() != 12
        || !normalized.starts_with("CHE")
        || !normalized[3..].bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AppError::Validation(
            "Le numéro IDE/TVA doit pouvoir être normalisé au format CHE suivi de neuf chiffres."
                .into(),
        ));
    }
    Ok(normalized)
}

fn valid_swiss_legal_rate(date_from: &str, rate_bp: i64) -> bool {
    date_from >= "2024-01-01" && matches!(rate_bp, 260 | 380 | 810)
}

fn push_issue(
    issues: &mut Vec<VatBlockingIssue>,
    code: &str,
    message: String,
    source_type: Option<String>,
    source_id: Option<String>,
) {
    issues.push(VatBlockingIssue {
        code: code.into(),
        message,
        source_type,
        source_id,
    });
}

fn sort_and_deduplicate_issues(issues: &mut Vec<VatBlockingIssue>) {
    issues.sort_by(|left, right| {
        (
            &left.code,
            &left.source_type,
            &left.source_id,
            &left.message,
        )
            .cmp(&(
                &right.code,
                &right.source_type,
                &right.source_id,
                &right.message,
            ))
    });
    issues.dedup();
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn format_cents_i128(cents: i128) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let absolute = cents.unsigned_abs();
    format!("{sign}{}.{:02}", absolute / 100, absolute % 100)
}

fn format_cents(cents: i64) -> String {
    format_cents_i128(i128::from(cents))
}

fn format_percent(rate_bp: i64) -> String {
    let sign = if rate_bp < 0 { "-" } else { "" };
    let absolute = rate_bp.unsigned_abs();
    format!("{sign}{}.{:02}", absolute / 100, absolute % 100)
}

impl LocalStore {
    /// Génère un fichier local eCH-0217 v2.0.0 et inscrit ses deux empreintes
    /// dans le registre immuable. Cette méthode ne transmet rien à l'AFC.
    pub fn export_vat_return_xml(&self, input: ExportVatReturnInput) -> AppResult<VatReturnExport> {
        let business_reference_id =
            required_text(&input.business_reference_id, "business_reference_id", 50)?;
        let preview_input = VatReturnPreviewInput {
            date_from: input.date_from,
            date_to: input.date_to,
            submission_type: input.submission_type,
            profile_id: input.profile_id,
        };

        let _guard = self.lock()?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let preview = build_vat_preview(&transaction, preview_input)?;
        if !preview.exportable {
            let details = preview
                .blocking_issues
                .iter()
                .take(5)
                .map(|issue| issue.message.as_str())
                .collect::<Vec<_>>()
                .join(" | ");
            return Err(AppError::Validation(format!(
                "Export TVA bloqué : {details}"
            )));
        }
        validate_export_transition(&transaction, &preview)?;

        let (organisation_name, raw_uid): (String, Option<String>) = transaction.query_row(
            "SELECT company_name,COALESCE(NULLIF(TRIM(vat_number),''),NULLIF(TRIM(uid_number),'')) FROM settings WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let organisation_uid = normalize_uid(raw_uid.as_deref().ok_or_else(|| {
            AppError::Validation("Le numéro IDE/TVA CHE est obligatoire pour l'export.".into())
        })?)?;
        let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let xml = build_ech_0217_xml(
            &preview,
            &organisation_uid,
            organisation_name.trim(),
            &business_reference_id,
            &created_at,
        )?;
        let xml_bytes = xml.as_bytes();
        if xml_bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            return Err(AppError::Validation(
                "Le générateur XML a produit un BOM UTF-8 interdit.".into(),
            ));
        }
        let xml_sha256 = sha256_hex(xml_bytes);
        let id = Uuid::new_v4().to_string();
        let generated_name = format!(
            "TVA_{}_{}_{}_{}.xml",
            preview.date_from,
            preview.date_to,
            preview.submission_type,
            &id[..8]
        );
        let file_name =
            validate_xml_file_name(input.file_name.as_deref().unwrap_or(&generated_name))?;
        let file_path = self.exports_dir.join(&file_name);
        write_exclusive_xml(&file_path, xml_bytes)?;

        let payload_json = serde_json::to_string(&preview)?;
        let database_result = (|| -> AppResult<i64> {
            transaction.execute(
                "INSERT INTO vat_return_exports(id,profile_id,date_from,date_to,submission_type,source_sha256,payload_json,xml_sha256,file_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                params![
                    id,
                    preview.profile.id,
                    preview.date_from,
                    preview.date_to,
                    preview.submission_type,
                    preview.source_sha256,
                    payload_json,
                    xml_sha256,
                    file_name,
                    created_at,
                ],
            )?;
            let sequence = transaction.last_insert_rowid();
            transaction.commit()?;
            Ok(sequence)
        })();
        let sequence = match database_result {
            Ok(sequence) => sequence,
            Err(error) => {
                let _ = fs::remove_file(&file_path);
                return Err(error);
            }
        };

        Ok(VatReturnExport {
            sequence,
            id,
            profile_id: preview.profile.id.clone(),
            date_from: preview.date_from.clone(),
            date_to: preview.date_to.clone(),
            submission_type: preview.submission_type.clone(),
            source_sha256: preview.source_sha256.clone(),
            payload: preview,
            xml_sha256,
            file_name,
            file_path: file_path.to_string_lossy().into_owned(),
            created_at,
            transmission_status: "not_transmitted".into(),
            transmission_wording:
                "Fichier XML généré localement; aucune transmission ni acceptation AFC n'est enregistrée."
                    .into(),
        })
    }

    pub fn list_vat_return_exports(
        &self,
        input: ListVatReturnExportsInput,
    ) -> AppResult<Vec<VatReturnExport>> {
        let date_from = input
            .date_from
            .map(|value| normalize_date(&value, "date_from"))
            .transpose()?;
        let date_to = input
            .date_to
            .map(|value| normalize_date(&value, "date_to"))
            .transpose()?;
        if date_from
            .as_deref()
            .zip(date_to.as_deref())
            .is_some_and(|(from, to)| from > to)
        {
            return Err(AppError::Validation(
                "date_from doit précéder ou être égale à date_to.".into(),
            ));
        }
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut statement = connection.prepare(
            "SELECT sequence,id,profile_id,date_from,date_to,submission_type,source_sha256,payload_json,xml_sha256,file_name,created_at FROM vat_return_exports ORDER BY sequence DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
            ))
        })?;
        let mut result = Vec::new();
        for row in rows {
            let (
                sequence,
                id,
                profile_id,
                row_from,
                row_to,
                submission_type,
                source_sha256,
                payload_json,
                xml_sha256,
                file_name,
                created_at,
            ) = row?;
            if date_from
                .as_deref()
                .is_some_and(|filter| row_to.as_str() < filter)
                || date_to
                    .as_deref()
                    .is_some_and(|filter| row_from.as_str() > filter)
            {
                continue;
            }
            let payload: VatReturnPreview = serde_json::from_str(&payload_json)?;
            let file_path = self.exports_dir.join(&file_name);
            result.push(VatReturnExport {
                sequence,
                id,
                profile_id,
                date_from: row_from,
                date_to: row_to,
                submission_type,
                source_sha256,
                payload,
                xml_sha256,
                file_name,
                file_path: file_path.to_string_lossy().into_owned(),
                created_at,
                transmission_status: "not_transmitted".into(),
                transmission_wording:
                    "Registre local uniquement; Zentra ne dispose d'aucune preuve de transmission ou d'acceptation AFC."
                        .into(),
            });
        }
        Ok(result)
    }
}

fn validate_export_transition(
    connection: &Connection,
    preview: &VatReturnPreview,
) -> AppResult<()> {
    let exact_initial: i64 = connection.query_row(
        "SELECT COUNT(*) FROM vat_return_exports WHERE date_from=? AND date_to=? AND submission_type='initial'",
        params![preview.date_from, preview.date_to],
        |row| row.get(0),
    )?;
    let exact_annual: i64 = connection.query_row(
        "SELECT COUNT(*) FROM vat_return_exports WHERE date_from=? AND date_to=? AND submission_type='annual_reconciliation'",
        params![preview.date_from, preview.date_to],
        |row| row.get(0),
    )?;
    match preview.submission_type.as_str() {
        "initial" if exact_initial != 0 => Err(AppError::Validation(
            "Une soumission initiale est déjà enregistrée pour cette période; utilisez une correction complète."
                .into(),
        )),
        "correction" if exact_initial == 0 => Err(AppError::Validation(
            "Une correction exige une soumission initiale enregistrée pour la même période.".into(),
        )),
        "correction" => {
            let locked_by_annual: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM vat_return_exports WHERE submission_type='annual_reconciliation' AND date_from<=? AND date_to>=?)",
                params![preview.date_from, preview.date_to],
                |row| row.get(0),
            )?;
            if locked_by_annual {
                Err(AppError::Validation(
                    "Cette période est déjà couverte par une concordance annuelle, qui ne peut pas être corrigée par ce workflow."
                        .into(),
                ))
            } else {
                Ok(())
            }
        }
        "annual_reconciliation" if exact_annual != 0 => Err(AppError::Validation(
            "Une concordance annuelle est déjà enregistrée pour cette année et ne peut pas être corrigée."
                .into(),
        )),
        "annual_reconciliation" => {
            let covered_periods: i64 = connection.query_row(
                "SELECT COUNT(DISTINCT date_from || '/' || date_to) FROM vat_return_exports WHERE submission_type IN ('initial','correction') AND date_from>=? AND date_to<=?",
                params![preview.date_from, preview.date_to],
                |row| row.get(0),
            )?;
            let expected_periods = match preview.profile.periodicity.as_str() {
                "monthly" => 12,
                "quarterly" => 4,
                "semiannual" => 2,
                "annual" => 1,
                _ => 0,
            };
            if covered_periods < expected_periods {
                Err(AppError::Validation(format!(
                    "La concordance annuelle exige les {expected_periods} période(s) de base enregistrées; {covered_periods} seulement sont présentes."
                )))
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    }
}

fn build_ech_0217_xml(
    preview: &VatReturnPreview,
    uid: &str,
    organisation_name: &str,
    business_reference_id: &str,
    generation_time: &str,
) -> AppResult<String> {
    if !preview.exportable {
        return Err(AppError::Validation(
            "Un aperçu bloqué ne peut pas être sérialisé en XML eCH.".into(),
        ));
    }
    let submission_code = match preview.submission_type.as_str() {
        "initial" => 1,
        "correction" => 2,
        "annual_reconciliation" => 3,
        _ => {
            return Err(AppError::Validation(
                "Type de soumission XML inconnu.".into(),
            ))
        }
    };
    let form_code = match preview.profile.form_of_reporting.as_str() {
        "agreed" => 1,
        "received" => 2,
        _ => return Err(AppError::Validation("Mode de décompte XML inconnu.".into())),
    };

    let mut xml = String::with_capacity(8_192);
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    xml.push_str(&format!(
        "<eCH-0217:VATDeclaration xmlns:eCH-0058=\"{}\" xmlns:eCH-0108=\"{}\" xmlns:eCH-0217=\"{}\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\n",
        ECH_0058_NAMESPACE, ECH_0108_NAMESPACE, ECH_NAMESPACE
    ));
    xml.push_str("  <eCH-0217:generalInformation>\n");
    push_xml_value(&mut xml, 4, "eCH-0217:uid", uid);
    push_xml_value(&mut xml, 4, "eCH-0217:organisationName", organisation_name);
    push_xml_value(&mut xml, 4, "eCH-0217:generationTime", generation_time);
    push_xml_value(
        &mut xml,
        4,
        "eCH-0217:reportingPeriodFrom",
        &preview.date_from,
    );
    push_xml_value(
        &mut xml,
        4,
        "eCH-0217:reportingPeriodTill",
        &preview.date_to,
    );
    push_xml_value(
        &mut xml,
        4,
        "eCH-0217:typeOfSubmission",
        &submission_code.to_string(),
    );
    push_xml_value(
        &mut xml,
        4,
        "eCH-0217:formOfReporting",
        &form_code.to_string(),
    );
    push_xml_value(
        &mut xml,
        4,
        "eCH-0217:businessReferenceId",
        business_reference_id,
    );
    xml.push_str("    <eCH-0217:sendingApplication>\n");
    push_xml_value(&mut xml, 6, "eCH-0058:manufacturer", "Zentra");
    push_xml_value(&mut xml, 6, "eCH-0058:product", "Zentra");
    push_xml_value(
        &mut xml,
        6,
        "eCH-0058:productVersion",
        env!("CARGO_PKG_VERSION"),
    );
    xml.push_str("    </eCH-0217:sendingApplication>\n");
    xml.push_str("  </eCH-0217:generalInformation>\n");

    let turnover = &preview.turnover_computation;
    xml.push_str("  <eCH-0217:turnoverComputation>\n");
    push_xml_money(
        &mut xml,
        4,
        "eCH-0217:totalConsideration",
        turnover.total_consideration_cents,
    );
    push_optional_xml_money(
        &mut xml,
        4,
        "eCH-0217:suppliesToForeignCountries",
        turnover.supplies_to_foreign_countries_cents,
    );
    push_optional_xml_money(
        &mut xml,
        4,
        "eCH-0217:suppliesAbroad",
        turnover.supplies_abroad_cents,
    );
    push_optional_xml_money(
        &mut xml,
        4,
        "eCH-0217:transferNotificationProcedure",
        turnover.transfer_notification_procedure_cents,
    );
    push_optional_xml_money(
        &mut xml,
        4,
        "eCH-0217:suppliesExemptFromTax",
        turnover.supplies_exempt_from_tax_cents,
    );
    push_optional_xml_money(
        &mut xml,
        4,
        "eCH-0217:reductionOfConsideration",
        turnover.reduction_of_consideration_cents,
    );
    if let Some(various) = &turnover.various_deduction {
        xml.push_str("    <eCH-0217:variousDeduction>\n");
        push_xml_money(
            &mut xml,
            6,
            "eCH-0217:amountVariousDeduction",
            various.amount_cents,
        );
        push_xml_value(
            &mut xml,
            6,
            "eCH-0217:descriptionVariousDeduction",
            &various.description,
        );
        xml.push_str("    </eCH-0217:variousDeduction>\n");
    }
    xml.push_str("  </eCH-0217:turnoverComputation>\n");

    if let Some(effective) = &preview.effective_reporting_method {
        xml.push_str("  <eCH-0217:effectiveReportingMethod>\n");
        push_xml_value(
            &mut xml,
            4,
            "eCH-0217:grossOrNet",
            &effective.gross_or_net_code.to_string(),
        );
        push_optional_xml_money(&mut xml, 4, "eCH-0217:opted", effective.opted_cents);
        for line in &effective.supplies_per_tax_rate {
            push_turnover_rate(&mut xml, "suppliesPerTaxRate", line, 4);
        }
        for line in &effective.acquisition_tax {
            push_turnover_rate(&mut xml, "acquisitionTax", line, 4);
        }
        push_optional_xml_money(
            &mut xml,
            4,
            "eCH-0217:inputTaxMaterialAndServices",
            effective.input_tax_material_and_services_cents,
        );
        push_optional_xml_money(
            &mut xml,
            4,
            "eCH-0217:inputTaxInvestments",
            effective.input_tax_investments_cents,
        );
        push_optional_xml_money(
            &mut xml,
            4,
            "eCH-0217:subsequentInputTaxDeduction",
            effective.subsequent_input_tax_deduction_cents,
        );
        push_optional_xml_money(
            &mut xml,
            4,
            "eCH-0217:inputTaxCorrections",
            effective.input_tax_corrections_cents,
        );
        push_optional_xml_money(
            &mut xml,
            4,
            "eCH-0217:inputTaxReductions",
            effective.input_tax_reductions_cents,
        );
        xml.push_str("  </eCH-0217:effectiveReportingMethod>\n");
    } else if let Some(simple) = &preview.simple_tax_rate_method {
        xml.push_str("  <eCH-0217:simpleTaxRateMethod>\n");
        for line in &simple.supplies_per_tax_rate {
            xml.push_str("    <eCH-0217:suppliesPerTaxRate>\n");
            push_xml_value(&mut xml, 6, "eCH-0217:activityID", &line.activity_id);
            push_xml_value(
                &mut xml,
                6,
                "eCH-0217:taxRate",
                &format_percent(line.tax_rate_bp),
            );
            push_xml_money(&mut xml, 6, "eCH-0217:turnover", line.turnover_cents);
            xml.push_str("    </eCH-0217:suppliesPerTaxRate>\n");
        }
        for line in &simple.acquisition_tax {
            push_turnover_rate(&mut xml, "acquisitionTax", line, 4);
        }
        push_optional_xml_money(
            &mut xml,
            4,
            "eCH-0217:inputTaxCorrections",
            simple.input_tax_corrections_cents,
        );
        xml.push_str("  </eCH-0217:simpleTaxRateMethod>\n");
    } else {
        return Err(AppError::Validation(
            "L'aperçu ne contient aucune méthode de décompte XML.".into(),
        ));
    }

    push_xml_money(
        &mut xml,
        2,
        "eCH-0217:payableTax",
        preview.payable_tax_cents,
    );
    let flows = &preview.other_flows_of_funds;
    if flows.subsidies_cents != 0 || flows.donations_cents != 0 {
        xml.push_str("  <eCH-0217:otherFlowsOfFunds>\n");
        push_optional_xml_money(&mut xml, 4, "eCH-0217:subsidies", flows.subsidies_cents);
        push_optional_xml_money(&mut xml, 4, "eCH-0217:donations", flows.donations_cents);
        xml.push_str("  </eCH-0217:otherFlowsOfFunds>\n");
    }
    xml.push_str("</eCH-0217:VATDeclaration>\n");
    Ok(xml)
}

fn push_turnover_rate(xml: &mut String, element: &str, line: &VatRateLine, indent: usize) {
    let spaces = " ".repeat(indent);
    xml.push_str(&format!("{spaces}<eCH-0217:{element}>\n"));
    push_xml_value(
        xml,
        indent + 2,
        "eCH-0217:taxRate",
        &format_percent(line.tax_rate_bp),
    );
    push_xml_money(xml, indent + 2, "eCH-0217:turnover", line.turnover_cents);
    xml.push_str(&format!("{spaces}</eCH-0217:{element}>\n"));
}

fn push_xml_money(xml: &mut String, indent: usize, element: &str, cents: i64) {
    push_xml_value(xml, indent, element, &format_cents(cents));
}

fn push_optional_xml_money(xml: &mut String, indent: usize, element: &str, cents: i64) {
    if cents != 0 {
        push_xml_money(xml, indent, element, cents);
    }
}

fn push_xml_value(xml: &mut String, indent: usize, element: &str, value: &str) {
    xml.push_str(&" ".repeat(indent));
    xml.push('<');
    xml.push_str(element);
    xml.push('>');
    xml.push_str(&escape_xml(value));
    xml.push_str("</");
    xml.push_str(element);
    xml.push_str(">\n");
}

fn escape_xml(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn validate_xml_file_name(value: &str) -> AppResult<String> {
    let value = required_text(value, "file_name", 255)?;
    let path = Path::new(&value);
    if path.file_name().and_then(|name| name.to_str()) != Some(value.as_str())
        || path.extension().and_then(|extension| extension.to_str()) != Some("xml")
        || value.chars().any(|character| {
            matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        })
        || value.ends_with('.')
        || value.ends_with(' ')
        || value == ".xml"
    {
        return Err(AppError::Validation(
            "file_name doit être un simple nom de fichier local se terminant par .xml.".into(),
        ));
    }
    Ok(value)
}

fn write_exclusive_xml(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use quick_xml::{events::Event, Reader};
    use rusqlite::params;
    use sha2::{Digest, Sha256};

    use super::*;

    fn initialized_store(company_name: &str) -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile")).expect("store");
        let connection = store.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,uid_number,vat_number,currency,created_at,updated_at) VALUES(1,1,?,'CHE-123.456.789','CHE-123.456.789 TVA','CHF','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                params![company_name],
            )
            .expect("settings");
        (temporary, store)
    }

    fn effective_profile(form: &str) -> VatProfileInput {
        VatProfileInput {
            id: Some(format!("effective-{form}")),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            reporting_method: "effective".into(),
            form_of_reporting: form.into(),
            periodicity: "quarterly".into(),
            gross_or_net: "net".into(),
            tdfn_activity_id: None,
            tdfn_rate_bp: None,
            afc_authorization_confirmed: false,
            notes: None,
            close_previous_open_profile: false,
        }
    }

    fn simple_profile() -> VatProfileInput {
        VatProfileInput {
            id: Some("tdfn-2026".into()),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            reporting_method: "simple_tax_rate".into(),
            form_of_reporting: "agreed".into(),
            periodicity: "quarterly".into(),
            gross_or_net: "gross".into(),
            tdfn_activity_id: Some("00001".into()),
            tdfn_rate_bp: Some(620),
            afc_authorization_confirmed: true,
            notes: Some("Autorisation confirmée par l'utilisateur".into()),
            close_previous_open_profile: false,
        }
    }

    fn insert_issued_invoice(
        store: &LocalStore,
        invoice_id: &str,
        item_id: &str,
        issue_date: &str,
        net_cents: i64,
        vat_cents: i64,
        rate_bp: i64,
    ) {
        insert_issued_invoice_in_currency(
            store, invoice_id, item_id, issue_date, net_cents, vat_cents, rate_bp, "CHF",
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_issued_invoice_in_currency(
        store: &LocalStore,
        invoice_id: &str,
        item_id: &str,
        issue_date: &str,
        net_cents: i64,
        vat_cents: i64,
        rate_bp: i64,
        currency: &str,
    ) {
        let connection = store.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO invoices(id,number,title,type,status,issue_date,due_date,currency,subtotal_cents,vat_cents,total_cents,created_at,updated_at) VALUES(?,NULL,'Test','standard','brouillon',?,?,?,?,?,?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                params![invoice_id,issue_date,issue_date,currency,net_cents,vat_cents,net_cents+vat_cents],
            )
            .expect("draft invoice");
        connection
            .execute(
                "INSERT INTO invoice_items(id,invoice_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at) VALUES(?,?,0,'Conseil & support',1.0,'forfait',?,0,?,?,?,?, '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                params![item_id,invoice_id,net_cents,rate_bp,net_cents,vat_cents,net_cents+vat_cents],
            )
            .expect("invoice line");
        connection
            .execute(
                "UPDATE invoices SET number=?,status='emise' WHERE id=?",
                params![format!("F-{invoice_id}"), invoice_id],
            )
            .expect("issue invoice");
    }

    fn classify_sale(store: &LocalStore, item_id: &str) {
        store
            .set_vat_source_classification(VatSourceClassificationInput {
                source_type: "invoice_item".into(),
                source_id: item_id.into(),
                treatment: "taxable".into(),
                note: None,
            })
            .expect("classification");
    }

    fn q1_preview(profile_id: &str, submission_type: &str) -> VatReturnPreviewInput {
        VatReturnPreviewInput {
            date_from: "2026-01-01".into(),
            date_to: "2026-03-31".into(),
            submission_type: submission_type.into(),
            profile_id: Some(profile_id.into()),
        }
    }

    #[test]
    fn profiles_are_versioned_without_overlap() {
        let (_temporary, store) = initialized_store("Zentra Tests");
        store
            .create_vat_profile(effective_profile("agreed"))
            .expect("first profile");
        let mut overlap = effective_profile("received");
        overlap.id = Some("received-version".into());
        overlap.effective_from = "2026-07-01".into();
        overlap.effective_to = Some("2026-12-31".into());
        assert!(store.create_vat_profile(overlap.clone()).is_err());

        overlap.close_previous_open_profile = true;
        store
            .create_vat_profile(overlap)
            .expect("close then version");
        let profiles = store.list_vat_profiles().expect("profiles");
        assert_eq!(profiles.len(), 2);
        let old = profiles
            .iter()
            .find(|profile| profile.id == "effective-agreed")
            .expect("old profile");
        assert_eq!(old.effective_to.as_deref(), Some("2026-06-30"));
        assert_eq!(
            store
                .vat_profile_for_date("2026-08-01")
                .expect("dated profile")
                .id,
            "received-version"
        );
    }

    #[test]
    fn reporting_transition_rejects_unpaid_invoice_and_preserves_previous_profile() {
        let (_temporary, store) = initialized_store("Transition TVA");
        store
            .create_vat_profile(effective_profile("agreed"))
            .unwrap();
        insert_issued_invoice(
            &store,
            "transition-invoice",
            "transition-line",
            "2026-12-01",
            10_000,
            810,
            810,
        );
        classify_sale(&store, "transition-line");
        let mut next = effective_profile("received");
        next.effective_from = "2027-01-01".into();
        next.close_previous_open_profile = true;
        let error = store
            .create_vat_profile(next)
            .expect_err("an open debtor requires a documented transition correction");
        assert!(error.to_string().contains("transition-invoice"), "{error}");
        let profiles = store.list_vat_profiles().unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(
            profiles[0].effective_to, None,
            "rejection must roll back the previous profile's closure"
        );
    }

    fn next_reporting_profile(form: &str) -> VatProfileInput {
        VatProfileInput {
            id: Some(format!("next-{form}")),
            effective_from: "2027-01-01".into(),
            close_previous_open_profile: true,
            ..effective_profile(form)
        }
    }

    fn transition_payment(store: &LocalStore, id: &str, date: &str, amount: i64) {
        store.connect().unwrap().execute(
            "INSERT INTO payments(id,invoice_id,date,amount_cents,created_at,updated_at) VALUES(?,'transition-invoice',?,?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            params![id,date,amount],
        ).unwrap();
    }

    #[test]
    fn reporting_transition_uses_balances_before_boundary_in_both_directions() {
        for (before, after) in [("agreed", "received"), ("received", "agreed")] {
            let (_temporary, store) = initialized_store("Transition TVA");
            store.create_vat_profile(effective_profile(before)).unwrap();
            insert_issued_invoice(
                &store,
                "transition-invoice",
                "transition-line",
                "2026-12-01",
                10_000,
                810,
                810,
            );
            transition_payment(&store, "before", "2026-12-31", 5_000);
            transition_payment(&store, "on-boundary", "2027-01-01", 5_810);
            let error = store
                .create_vat_profile(next_reporting_profile(after))
                .unwrap_err();
            assert!(error.to_string().contains("58.10 CHF"), "{error}");
        }
    }

    #[test]
    fn reporting_transition_allows_documents_fully_paid_before_boundary() {
        for (before, after) in [("agreed", "received"), ("received", "agreed")] {
            let (_temporary, store) = initialized_store("Transition TVA");
            store.create_vat_profile(effective_profile(before)).unwrap();
            insert_issued_invoice(
                &store,
                "transition-invoice",
                "transition-line",
                "2026-12-01",
                10_000,
                810,
                810,
            );
            transition_payment(&store, "before", "2026-12-31", 10_810);
            let next = next_reporting_profile(after);
            store.create_vat_profile(next.clone()).unwrap();
            store.create_vat_profile(next).unwrap();
            assert_eq!(
                store.list_vat_profiles().unwrap().len(),
                2,
                "retry is idempotent"
            );
        }
    }

    #[test]
    fn reporting_transition_does_not_block_same_basis_versioning() {
        let (_temporary, store) = initialized_store("Transition TVA");
        store
            .create_vat_profile(effective_profile("agreed"))
            .unwrap();
        insert_issued_invoice(
            &store,
            "transition-invoice",
            "transition-line",
            "2026-12-01",
            10_000,
            810,
            810,
        );
        store
            .create_vat_profile(next_reporting_profile("agreed"))
            .unwrap();
    }

    #[test]
    fn reporting_transition_restored_history_blocks_export_and_closure_but_not_previous_period() {
        for (before, after) in [("agreed", "received"), ("received", "agreed")] {
            let (_temporary, store) = initialized_store("Transition TVA");
            store.create_vat_profile(effective_profile(before)).unwrap();
            store
                .create_vat_profile(next_reporting_profile(after))
                .unwrap();
            // Represents an existing profile from an older release, or a subsequently entered invoice.
            insert_issued_invoice(
                &store,
                "transition-invoice",
                "transition-line",
                "2026-12-01",
                10_000,
                810,
                810,
            );
            classify_sale(&store, "transition-line");
            transition_payment(&store, "after", "2027-01-15", 10_810);
            let input = VatReturnPreviewInput {
                date_from: "2027-01-01".into(),
                date_to: "2027-03-31".into(),
                submission_type: "initial".into(),
                profile_id: Some(format!("next-{after}")),
            };
            for submission in ["initial", "correction", "annual_reconciliation"] {
                let preview = store
                    .preview_vat_return(VatReturnPreviewInput {
                        submission_type: submission.into(),
                        date_to: if submission == "annual_reconciliation" {
                            "2027-12-31".into()
                        } else {
                            input.date_to.clone()
                        },
                        ..input.clone()
                    })
                    .unwrap();
                assert!(!preview.exportable, "{before} -> {after} / {submission}");
                assert!(preview.blocking_issues.iter().any(|issue| issue.code
                    == "vat_reporting_transition_open_balance"
                    && issue.message.contains("108.10 CHF")));
            }
            let before_preview = store
                .preview_vat_return(VatReturnPreviewInput {
                    date_from: "2026-10-01".into(),
                    date_to: "2026-12-31".into(),
                    submission_type: "initial".into(),
                    profile_id: Some(format!("effective-{before}")),
                })
                .unwrap();
            assert!(
                before_preview.exportable,
                "{:?}",
                before_preview.blocking_issues
            );
            assert!(store
                .export_vat_return_xml(ExportVatReturnInput {
                    date_from: input.date_from,
                    date_to: input.date_to,
                    submission_type: input.submission_type,
                    profile_id: input.profile_id,
                    business_reference_id: "transition-export".into(),
                    file_name: None
                })
                .is_err());
            assert!(
                ensure_vat_sources_classified_through(&store.connect().unwrap(), "2027-03-31")
                    .is_err()
            );
            // Even a later quarter with no transactions must not hide an unrecorded transition.
            let later = store
                .preview_vat_return(VatReturnPreviewInput {
                    date_from: "2027-04-01".into(),
                    date_to: "2027-06-30".into(),
                    submission_type: "initial".into(),
                    profile_id: None,
                })
                .unwrap();
            assert!(!later.exportable);
        }
    }

    #[test]
    fn reporting_transition_inspects_pending_expenses_and_later_payment_dates() {
        for paid_at in [None, Some("2027-02-01")] {
            let (_temporary, store) = initialized_store("Transition TVA");
            store
                .create_vat_profile(effective_profile("agreed"))
                .unwrap();
            store.connect().unwrap().execute("INSERT INTO expenses(id,date,due_date,reference,net_cents,vat_cents,total_cents,payment_status,paid_at,created_at,updated_at) VALUES('transition-expense','2026-12-01','2027-02-01','Marchandises décembre',10000,810,10810,?,?,'2026-12-01','2026-12-01')", params![if paid_at.is_some() { "paid" } else { "pending" }, paid_at]).unwrap();
            let error = store
                .create_vat_profile(next_reporting_profile("received"))
                .unwrap_err();
            assert!(
                error.to_string().contains("Marchandises décembre"),
                "{error}"
            );
        }
    }

    #[test]
    fn reporting_transition_tdfn_inspects_sales_without_separate_input_tax() {
        let (_temporary, store) = initialized_store("Transition TVA");
        store.create_vat_profile(simple_profile()).unwrap();
        store.connect().unwrap().execute("INSERT INTO expenses(id,date,due_date,net_cents,vat_cents,total_cents,payment_status,created_at,updated_at) VALUES('transition-expense','2026-12-01','2027-02-01',10000,810,10810,'pending','2026-12-01','2026-12-01')", []).unwrap();
        let next = VatProfileInput {
            id: Some("tdfn-next".into()),
            effective_from: "2027-01-01".into(),
            form_of_reporting: "received".into(),
            close_previous_open_profile: true,
            ..simple_profile()
        };
        store.create_vat_profile(next).unwrap();
        insert_issued_invoice(
            &store,
            "transition-invoice",
            "transition-line",
            "2026-12-01",
            10_000,
            810,
            810,
        );
        classify_sale(&store, "transition-line");
        let preview = store
            .preview_vat_return(VatReturnPreviewInput {
                date_from: "2027-01-01".into(),
                date_to: "2027-03-31".into(),
                submission_type: "initial".into(),
                profile_id: None,
            })
            .unwrap();
        let issues: Vec<_> = preview
            .blocking_issues
            .iter()
            .filter(|issue| issue.code == "vat_reporting_transition_open_balance")
            .collect();
        assert_eq!(issues.len(), 1);
        assert!(issues[0].message.contains("art. 107 OTVA"));
    }

    #[test]
    fn reporting_transition_combined_method_change_also_blocks_preceding_return() {
        let (_temporary, store) = initialized_store("Transition TVA");
        store
            .create_vat_profile(effective_profile("agreed"))
            .unwrap();
        store
            .create_vat_profile(VatProfileInput {
                effective_from: "2027-01-01".into(),
                form_of_reporting: "received".into(),
                close_previous_open_profile: true,
                ..simple_profile()
            })
            .unwrap();
        insert_issued_invoice(
            &store,
            "transition-invoice",
            "transition-line",
            "2026-12-01",
            10_000,
            810,
            810,
        );
        classify_sale(&store, "transition-line");
        let preview = store
            .preview_vat_return(VatReturnPreviewInput {
                date_from: "2026-10-01".into(),
                date_to: "2026-12-31".into(),
                submission_type: "initial".into(),
                profile_id: None,
            })
            .unwrap();
        assert!(preview
            .blocking_issues
            .iter()
            .any(|issue| issue.message.contains("art. 79 al. 4 OTVA")));
    }

    #[test]
    fn received_profile_fails_closed_without_a_distinct_deferred_vat_account() {
        let (_temporary, store) = initialized_store("Zentra Tests");
        store
            .install_swiss_accounting_starter()
            .expect("accounting starter");
        store
            .connect()
            .expect("connection")
            .execute(
                "UPDATE accounting_settings SET vat_deferred_payable_account_id=NULL WHERE id=1",
                [],
            )
            .expect("simulate legacy mapping");
        let error = store
            .create_vat_profile(effective_profile("received"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("TVA à régulariser"), "{error}");
        assert!(store.list_vat_profiles().expect("profiles").is_empty());
    }

    #[test]
    fn effective_calculation_uses_exact_cents_and_reversal_history() {
        let (_temporary, store) = initialized_store("Zentra Tests");
        store
            .create_vat_profile(effective_profile("agreed"))
            .expect("profile");
        insert_issued_invoice(
            &store,
            "invoice-1",
            "item-1",
            "2026-02-01",
            10_000,
            810,
            810,
        );
        classify_sale(&store, "item-1");
        let preview = store
            .preview_vat_return(q1_preview("effective-agreed", "initial"))
            .expect("preview");
        assert!(preview.exportable, "{:?}", preview.blocking_issues);
        assert_eq!(
            preview.turnover_computation.total_consideration_cents,
            10_000
        );
        assert_eq!(preview.turnover_computation.taxable_turnover_cents, 10_000);
        assert_eq!(preview.payable_tax_cents, 810);
        assert_eq!(
            preview
                .effective_reporting_method
                .as_ref()
                .expect("effective")
                .supplies_per_tax_rate[0]
                .tax_rate_bp,
            810
        );

        let adjustment = store
            .create_vat_adjustment(VatAdjustmentInput {
                request_id: "11111111-1111-4111-8111-111111111111".into(),
                adjustment_date: "2026-03-20".into(),
                category: "input_materials".into(),
                amount_cents: 100,
                tax_rate_bp: None,
                description: "Correction documentée".into(),
                evidence_reference: Some("PIÈCE-1".into()),
                created_by: "tester".into(),
            })
            .expect("adjustment");
        assert_eq!(
            store
                .preview_vat_return(q1_preview("effective-agreed", "initial"))
                .expect("adjusted preview")
                .payable_tax_cents,
            710
        );
        store
            .reverse_vat_adjustment(ReverseVatAdjustmentInput {
                request_id: "22222222-2222-4222-8222-222222222222".into(),
                original_adjustment_id: adjustment.id,
                adjustment_date: "2026-03-21".into(),
                description: "Extourne correction".into(),
                evidence_reference: Some("PIÈCE-2".into()),
                created_by: "tester".into(),
            })
            .expect("reversal");
        assert_eq!(
            store
                .preview_vat_return(q1_preview("effective-agreed", "initial"))
                .expect("reversed preview")
                .payable_tax_cents,
            810
        );
        assert_eq!(
            store
                .list_vat_adjustments(ListVatAdjustmentsInput::default())
                .expect("history")
                .len(),
            2
        );
        let connection = store.connect().expect("connection");
        assert!(connection
            .execute(
                "UPDATE vat_adjustments SET amount_cents=1 WHERE id='11111111-1111-4111-8111-111111111111'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM vat_adjustments WHERE id='11111111-1111-4111-8111-111111111111'",
                [],
            )
            .is_err());
    }

    #[test]
    fn adjustment_requests_are_replay_safe_conflict_checked_and_audited_once() {
        let (_temporary, store) = initialized_store("Zentra TVA idempotence");
        let request = VatAdjustmentInput {
            request_id: "33333333-3333-4333-8333-333333333333".into(),
            adjustment_date: "2026-03-20".into(),
            category: "input_materials".into(),
            amount_cents: 125,
            tax_rate_bp: None,
            description: "Correction avec reprise sure".into(),
            evidence_reference: Some("DOSSIER-TVA-42".into()),
            created_by: "responsable TVA".into(),
        };
        let first = store
            .create_vat_adjustment(request.clone())
            .expect("first adjustment");
        let replay = store
            .create_vat_adjustment(request.clone())
            .expect("stable replay");
        assert_eq!(first.id, request.request_id);
        assert_eq!(replay.id, first.id);
        assert_eq!(replay.sequence, first.sequence);

        let mut conflicting_request = request;
        conflicting_request.amount_cents = 126;
        let conflict = store
            .create_vat_adjustment(conflicting_request)
            .expect_err("same request id with changed content");
        assert!(conflict.to_string().contains("request_id"));

        let reversal_request = ReverseVatAdjustmentInput {
            request_id: "44444444-4444-4444-8444-444444444444".into(),
            original_adjustment_id: first.id,
            adjustment_date: "2026-03-21".into(),
            description: "Extourne controlee".into(),
            evidence_reference: Some("DOSSIER-TVA-43".into()),
            created_by: "responsable TVA".into(),
        };
        let reversal = store
            .reverse_vat_adjustment(reversal_request.clone())
            .expect("first reversal");
        let reversal_replay = store
            .reverse_vat_adjustment(reversal_request.clone())
            .expect("stable reversal replay");
        assert_eq!(reversal.id, reversal_request.request_id);
        assert_eq!(reversal_replay.id, reversal.id);
        assert_eq!(reversal_replay.sequence, reversal.sequence);

        let mut conflicting_reversal = reversal_request;
        conflicting_reversal.description = "Autre motif".into();
        let conflict = store
            .reverse_vat_adjustment(conflicting_reversal)
            .expect_err("same reversal request id with changed content");
        assert!(conflict.to_string().contains("request_id"));

        let invalid = store
            .create_vat_adjustment(VatAdjustmentInput {
                request_id: "pas-un-uuid".into(),
                adjustment_date: "2026-03-22".into(),
                category: "input_materials".into(),
                amount_cents: 1,
                tax_rate_bp: None,
                description: "Invalide".into(),
                evidence_reference: None,
                created_by: "tester".into(),
            })
            .expect_err("invalid request id");
        assert!(invalid.to_string().contains("UUID"));

        let connection = store.connect().expect("connection");
        let stored: (i64, i64, String, String) = connection
            .query_row(
                "SELECT COUNT(*),COUNT(DISTINCT request_id),MIN(request_sha256),MIN(request_json) FROM vat_adjustments",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("request evidence");
        assert_eq!(stored.0, 2);
        assert_eq!(stored.1, 2);
        assert_eq!(stored.2.len(), 64);
        assert!(stored.3.contains("vat_adjustment"));
        let audit_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE entity_type='vat_adjustment'",
                [],
                |row| row.get(0),
            )
            .expect("audit count");
        assert_eq!(audit_count, 2, "replays must not append duplicate audits");
        let verified = crate::audit::verify_audit_chain(&connection).expect("valid audit chain");
        assert_eq!(verified["valid"], true);
        assert_eq!(verified["entries"], 2);
    }

    #[test]
    fn received_mode_allocates_partial_payments_to_their_own_period() {
        let (_temporary, store) = initialized_store("Zentra Tests");
        store
            .create_vat_profile(effective_profile("received"))
            .expect("profile");
        insert_issued_invoice(
            &store,
            "invoice-2",
            "item-2",
            "2026-02-01",
            10_000,
            810,
            810,
        );
        classify_sale(&store, "item-2");
        let connection = store.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO payments(id,invoice_id,date,amount_cents,created_at,updated_at) VALUES('payment-1','invoice-2','2026-03-31',5000,'2026-03-31T00:00:00Z','2026-03-31T00:00:00Z')",
                [],
            )
            .expect("first payment");
        let q1 = store
            .preview_vat_return(q1_preview("effective-received", "initial"))
            .unwrap();
        assert!(q1.exportable, "{:?}", q1.blocking_issues);
        assert_eq!(q1.turnover_computation.total_consideration_cents, 4625);
        assert_eq!(q1.payable_tax_cents, 375);
        assert_eq!(q1.received_allocations.len(), 1);
        assert_eq!(q1.received_allocations[0].payment.gross_cents, 5000);
        assert_eq!(q1.received_allocations[0].payment.vat_cents, 375);
        assert_eq!(q1.received_allocations[0].payment.date, "2026-03-31");
        connection
            .execute(
                "INSERT INTO payments(id,invoice_id,date,amount_cents,created_at,updated_at) VALUES('payment-2','invoice-2','2026-04-01',5810,'2026-04-01T00:00:00Z','2026-04-01T00:00:00Z')",
                [],
            )
            .expect("second payment");
        let preview = store
            .preview_vat_return(q1_preview("effective-received", "initial"))
            .expect("preview");
        assert!(preview.exportable, "{:?}", preview.blocking_issues);
        assert_eq!(
            preview.source_sha256, q1.source_sha256,
            "later payments cannot rewrite an earlier return"
        );
        let q2 = store
            .preview_vat_return(VatReturnPreviewInput {
                date_from: "2026-04-01".into(),
                date_to: "2026-06-30".into(),
                ..q1_preview("effective-received", "initial")
            })
            .unwrap();
        assert!(q2.exportable, "{:?}", q2.blocking_issues);
        assert_eq!(q2.turnover_computation.total_consideration_cents, 5375);
        assert_eq!(q2.payable_tax_cents, 435);
        assert_eq!(q2.received_allocations[0].payment.gross_cents, 5810);
        assert_eq!(q2.received_allocations[0].payment.vat_cents, 435);
        let export = store
            .export_vat_return_xml(ExportVatReturnInput {
                date_from: "2026-01-01".into(),
                date_to: "2026-03-31".into(),
                submission_type: "initial".into(),
                profile_id: Some("effective-received".into()),
                business_reference_id: "Q1-2026".into(),
                file_name: None,
            })
            .expect("partial receipt XML export");
        let xml = std::fs::read_to_string(export.file_path).unwrap();
        assert!(xml.contains("<eCH-0217:payableTax>3.75</eCH-0217:payableTax>"));
        if let Ok(path) = std::env::var("ZENTRA_QA_RECEIVED_XML_PATH") {
            std::fs::write(path, &xml).unwrap();
        }
    }

    #[test]
    fn received_simple_method_uses_only_the_gross_amount_actually_paid() {
        let (_temporary, store) = initialized_store("Zentra Tests");
        let mut profile = simple_profile();
        profile.form_of_reporting = "received".into();
        store.create_vat_profile(profile).unwrap();
        insert_issued_invoice(
            &store,
            "tdfn-partial",
            "tdfn-line",
            "2026-02-01",
            10000,
            810,
            810,
        );
        classify_sale(&store, "tdfn-line");
        store.connect().unwrap().execute("INSERT INTO payments(id,invoice_id,date,amount_cents,created_at,updated_at) VALUES('tdfn-payment','tdfn-partial','2026-03-31',5000,'2026-03-31','2026-03-31')", []).unwrap();
        let q1 = store
            .preview_vat_return(q1_preview("tdfn-2026", "initial"))
            .unwrap();
        assert!(q1.exportable, "{:?}", q1.blocking_issues);
        assert_eq!(q1.turnover_computation.total_consideration_cents, 5000);
        assert_eq!(q1.payable_tax_cents, 310);
        assert!(q1.effective_reporting_method.is_none());
        assert_eq!(q1.received_allocations[0].payment.gross_cents, 5000);
    }

    #[test]
    fn simple_tax_rate_uses_gross_activity_turnover_without_floats() {
        let (_temporary, store) = initialized_store("Zentra Tests");
        store.create_vat_profile(simple_profile()).expect("profile");
        insert_issued_invoice(
            &store,
            "invoice-3",
            "item-3",
            "2026-02-01",
            10_000,
            810,
            810,
        );
        classify_sale(&store, "item-3");
        let preview = store
            .preview_vat_return(q1_preview("tdfn-2026", "initial"))
            .expect("preview");
        assert!(preview.exportable, "{:?}", preview.blocking_issues);
        let simple = preview
            .simple_tax_rate_method
            .as_ref()
            .expect("simple method");
        assert_eq!(simple.supplies_per_tax_rate.len(), 1);
        assert_eq!(simple.supplies_per_tax_rate[0].activity_id, "00001");
        assert_eq!(simple.supplies_per_tax_rate[0].turnover_cents, 10_810);
        assert_eq!(simple.output_tax_cents, 670);
        assert_eq!(preview.payable_tax_cents, 670);

        let xml = build_ech_0217_xml(
            &preview,
            "CHE123456789",
            "Zentra Tests",
            "TDFN-Q1-2026",
            "2026-04-01T10:00:00Z",
        )
        .expect("simple XML");
        assert!(xml.contains("<eCH-0217:simpleTaxRateMethod>"));
        assert!(xml.contains("<eCH-0217:activityID>00001</eCH-0217:activityID>"));
        assert!(!xml.contains("<eCH-0217:activityId>"));
    }

    #[test]
    fn xml_export_is_escaped_hashed_registered_and_immutable() {
        let (_temporary, store) = initialized_store("Atelier & Fils <Sàrl>");
        store
            .create_vat_profile(effective_profile("agreed"))
            .expect("profile");
        insert_issued_invoice(
            &store,
            "invoice-4",
            "item-4",
            "2026-02-01",
            10_000,
            810,
            810,
        );
        classify_sale(&store, "item-4");
        let first_preview = store
            .preview_vat_return(q1_preview("effective-agreed", "initial"))
            .expect("preview");
        let second_preview = store
            .preview_vat_return(q1_preview("effective-agreed", "initial"))
            .expect("preview again");
        assert_eq!(first_preview.source_sha256, second_preview.source_sha256);

        let export = store
            .export_vat_return_xml(ExportVatReturnInput {
                date_from: "2026-01-01".into(),
                date_to: "2026-03-31".into(),
                submission_type: "initial".into(),
                profile_id: Some("effective-agreed".into()),
                business_reference_id: "Q1 & <2026>".into(),
                file_name: Some("tva-q1-2026.xml".into()),
            })
            .expect("export");
        let bytes = fs::read(&export.file_path).expect("xml bytes");
        assert!(!bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        assert_eq!(
            export.xml_sha256,
            Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let xml = String::from_utf8(bytes).expect("utf8");
        assert!(xml.contains("http://www.ech.ch/xmlns/eCH-0217/2"));
        assert!(xml.contains("Atelier &amp; Fils &lt;Sàrl&gt;"));
        assert!(xml.contains("Q1 &amp; &lt;2026&gt;"));
        assert!(xml.contains("<eCH-0217:turnoverComputation>"));
        assert!(xml.contains("<eCH-0217:effectiveReportingMethod>"));
        assert!(xml.contains("<eCH-0217:payableTax>8.10</eCH-0217:payableTax>"));
        let mut reader = Reader::from_str(&xml);
        loop {
            if matches!(reader.read_event().expect("well-formed XML"), Event::Eof) {
                break;
            }
        }
        let registry = store
            .list_vat_return_exports(ListVatReturnExportsInput::default())
            .expect("registry");
        assert_eq!(registry.len(), 1);
        assert_eq!(registry[0].xml_sha256, export.xml_sha256);
        assert_eq!(registry[0].transmission_status, "not_transmitted");
        let connection = store.connect().expect("connection");
        assert!(connection
            .execute(
                "UPDATE vat_return_exports SET file_name='other.xml' WHERE id=?",
                params![export.id],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM vat_return_exports WHERE sequence=?",
                params![export.sequence],
            )
            .is_err());
        assert!(store
            .export_vat_return_xml(ExportVatReturnInput {
                date_from: "2026-01-01".into(),
                date_to: "2026-03-31".into(),
                submission_type: "initial".into(),
                profile_id: Some("effective-agreed".into()),
                business_reference_id: "duplicate".into(),
                file_name: None,
            })
            .is_err());
    }

    #[test]
    fn unclassified_source_blocks_export_but_remains_visible() {
        let (_temporary, store) = initialized_store("Zentra Tests");
        store
            .create_vat_profile(effective_profile("agreed"))
            .expect("profile");
        insert_issued_invoice(
            &store,
            "invoice-5",
            "item-5",
            "2026-02-01",
            10_000,
            810,
            810,
        );
        let preview = store
            .preview_vat_return(q1_preview("effective-agreed", "initial"))
            .expect("preview");
        assert!(!preview.exportable);
        assert_eq!(preview.unclassified_sources.len(), 1);
        assert_eq!(preview.unclassified_sources[0].source_id, "item-5");
    }

    #[test]
    fn cumulative_close_preflight_requires_a_valid_classification() {
        let (_temporary, store) = initialized_store("Zentra pré-clôture TVA");
        store
            .create_vat_profile(effective_profile("agreed"))
            .expect("profile");
        insert_issued_invoice(
            &store,
            "invoice-preclose",
            "item-preclose",
            "2026-02-01",
            10_000,
            810,
            810,
        );
        store
            .install_swiss_accounting_starter()
            .expect("accounting and historical invoice posting");
        let period = store
            .upsert_accounting_period(crate::models::AccountingPeriodInput {
                id: Some("period-preclose-vat".into()),
                name: "Exercice 2026".into(),
                date_from: "2026-01-01".into(),
                date_to: "2026-12-31".into(),
            })
            .expect("period");
        let period_id = period["id"].as_str().expect("period id");

        let missing_error = store
            .close_accounting_period(period_id)
            .unwrap_err()
            .to_string();
        assert!(missing_error.contains("1 source(s) TVA cumulative(s)"));
        assert!(missing_error.contains("invoice_item/item-preclose"));
        let connection = store.connect().expect("connection");
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM accounting_periods WHERE id=?",
                    params![period_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "open"
        );

        connection
            .pragma_update(None, "ignore_check_constraints", true)
            .expect("allow corruption fixture");
        connection
            .execute(
                "INSERT INTO vat_source_classifications(id,source_type,source_id,treatment,note,created_at,updated_at)
                 VALUES('invalid-preclose','invoice_item','item-preclose','invalid-treatment',NULL,?1,?1)",
                params![now_iso()],
            )
            .expect("invalid legacy classification fixture");
        drop(connection);
        let invalid_error = store
            .close_accounting_period(period_id)
            .unwrap_err()
            .to_string();
        assert!(invalid_error.contains("invoice_item/item-preclose"));
        let connection = store.connect().expect("connection");
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM accounting_periods WHERE id=?",
                    params![period_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "open"
        );
        connection
            .execute(
                "DELETE FROM vat_source_classifications WHERE id='invalid-preclose'",
                [],
            )
            .expect("remove corruption fixture");
        connection
            .pragma_update(None, "ignore_check_constraints", false)
            .expect("restore checks");
        drop(connection);

        classify_sale(&store, "item-preclose");
        let closed = store
            .close_accounting_period(period_id)
            .expect("close after valid classification");
        assert_eq!(closed["status"], "closed");
    }

    #[test]
    fn cumulative_close_preflight_rejects_a_non_reportable_foreign_currency_source() {
        let (_temporary, store) = initialized_store("Zentra pré-clôture devise");
        store
            .create_vat_profile(effective_profile("agreed"))
            .expect("profile");
        insert_issued_invoice_in_currency(
            &store,
            "invoice-eur-preclose",
            "item-eur-preclose",
            "2026-02-01",
            10_000,
            810,
            810,
            "EUR",
        );
        classify_sale(&store, "item-eur-preclose");

        let connection = store.connect().expect("connection");
        let error = ensure_vat_sources_classified_through(&connection, "2026-12-31")
            .unwrap_err()
            .to_string();
        assert!(error.contains("n'est pas exportable"));
        assert!(error.contains("1 anomalie(s)"));
        assert!(error.contains("est en EUR"));
        assert!(error.contains("Corrigez-les avant de fermer"));
    }

    #[test]
    fn cumulative_close_freezes_vat_facts_but_keeps_exact_replays_idempotent() {
        let (_temporary, store) = initialized_store("Zentra TVA clôturée");
        let profile_input = effective_profile("agreed");
        let profile = store
            .create_vat_profile(profile_input.clone())
            .expect("historical profile");
        insert_issued_invoice(
            &store,
            "invoice-closed",
            "item-closed",
            "2026-02-01",
            10_000,
            810,
            810,
        );
        let classification_input = VatSourceClassificationInput {
            source_type: "invoice_item".into(),
            source_id: "item-closed".into(),
            treatment: "taxable".into(),
            note: Some("Décision initiale".into()),
        };
        let classification = store
            .set_vat_source_classification(classification_input.clone())
            .expect("historical classification");
        let adjustment_input = VatAdjustmentInput {
            request_id: "55555555-5555-4555-8555-555555555555".into(),
            adjustment_date: "2026-03-20".into(),
            category: "input_materials".into(),
            amount_cents: 125,
            tax_rate_bp: None,
            description: "Ajustement historique".into(),
            evidence_reference: Some("TVA-2026-1".into()),
            created_by: "responsable TVA".into(),
        };
        let adjustment = store
            .create_vat_adjustment(adjustment_input.clone())
            .expect("historical adjustment");

        let chronology_error = store
            .reverse_vat_adjustment(ReverseVatAdjustmentInput {
                request_id: "66666666-6666-4666-8666-666666666666".into(),
                original_adjustment_id: adjustment.id.clone(),
                adjustment_date: "2026-03-19".into(),
                description: "Extourne trop ancienne".into(),
                evidence_reference: Some("TVA-2026-2".into()),
                created_by: "responsable TVA".into(),
            })
            .unwrap_err()
            .to_string();
        assert!(chronology_error.contains("ne peut pas précéder"));

        let connection = store.connect().unwrap();
        connection
            .execute(
                "INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at)
                 VALUES('period-vat-2026','Exercice 2026','2026-01-01','2026-12-31','open',?1,?1)",
                params![now_iso()],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE accounting_periods SET status='closed',closed_at=?1,updated_at=?1
                 WHERE id='period-vat-2026'",
                params![now_iso()],
            )
            .unwrap();
        drop(connection);

        assert_eq!(
            store
                .create_vat_profile(profile_input.clone())
                .expect("exact profile replay")
                .id,
            profile.id
        );
        assert_eq!(
            store
                .set_vat_source_classification(classification_input.clone())
                .expect("exact classification replay")
                .id,
            classification.id
        );
        assert_eq!(
            store
                .create_vat_adjustment(adjustment_input.clone())
                .expect("exact adjustment replay")
                .sequence,
            adjustment.sequence
        );

        let mut changed_classification = classification_input;
        changed_classification.treatment = "exempt".into();
        let classification_error = store
            .set_vat_source_classification(changed_classification)
            .unwrap_err()
            .to_string();
        assert!(classification_error.contains("cumulative jusqu'au 2026-12-31"));

        let old_adjustment_error = store
            .create_vat_adjustment(VatAdjustmentInput {
                request_id: "77777777-7777-4777-8777-777777777777".into(),
                adjustment_date: "2025-12-31".into(),
                category: "input_materials".into(),
                amount_cents: 10,
                tax_rate_bp: None,
                description: "Ajustement antidaté hors période explicite".into(),
                evidence_reference: Some("TVA-OLD".into()),
                created_by: "responsable TVA".into(),
            })
            .unwrap_err()
            .to_string();
        assert!(old_adjustment_error.contains("cumulative jusqu'au 2026-12-31"));

        let mut old_profile = effective_profile("received");
        old_profile.id = Some("retroactive-profile".into());
        old_profile.effective_from = "2025-01-01".into();
        old_profile.effective_to = Some("2025-12-31".into());
        let profile_error = store
            .create_vat_profile(old_profile)
            .unwrap_err()
            .to_string();
        assert!(profile_error.contains("cumulative jusqu'au 2026-12-31"));

        let mut future_profile = effective_profile("agreed");
        future_profile.id = Some("future-profile".into());
        future_profile.effective_from = "2027-01-01".into();
        future_profile.close_previous_open_profile = true;
        let connection = store.connect().unwrap();
        assert!(connection
            .execute(
                "UPDATE vat_profiles SET effective_to='2026-12-31',notes='mutation historique interdite' WHERE id=?",
                params![profile.id],
            )
            .is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT effective_to FROM vat_profiles WHERE id=?",
                    params![profile.id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap(),
            None
        );
        drop(connection);
        let future_profile = store
            .create_vat_profile(future_profile)
            .expect("future profile after close");
        assert_eq!(future_profile.effective_from, "2027-01-01");
        let connection = store.connect().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT effective_to FROM vat_profiles WHERE id=?",
                    params![profile.id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap()
                .as_deref(),
            Some("2026-12-31")
        );
        drop(connection);

        let old_reversal_error = store
            .reverse_vat_adjustment(ReverseVatAdjustmentInput {
                request_id: "88888888-8888-4888-8888-888888888888".into(),
                original_adjustment_id: adjustment.id.clone(),
                adjustment_date: "2026-12-31".into(),
                description: "Extourne dans la clôture".into(),
                evidence_reference: Some("TVA-2026-3".into()),
                created_by: "responsable TVA".into(),
            })
            .unwrap_err()
            .to_string();
        assert!(old_reversal_error.contains("cumulative jusqu'au 2026-12-31"));

        let reversal_input = ReverseVatAdjustmentInput {
            request_id: "99999999-9999-4999-8999-999999999999".into(),
            original_adjustment_id: adjustment.id,
            adjustment_date: "2027-01-02".into(),
            description: "Correction future référencée".into(),
            evidence_reference: Some("TVA-2027-1".into()),
            created_by: "responsable TVA".into(),
        };
        let reversal = store
            .reverse_vat_adjustment(reversal_input.clone())
            .expect("future reversal");
        assert_eq!(
            reversal.reverses_adjustment_id.as_deref(),
            Some("55555555-5555-4555-8555-555555555555")
        );

        let connection = store.connect().unwrap();
        connection
            .execute(
                "INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at)
                 VALUES('period-vat-2027','Exercice 2027','2027-01-01','2027-12-31','open',?1,?1)",
                params![now_iso()],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE accounting_periods SET status='closed',closed_at=?1,updated_at=?1
                 WHERE id='period-vat-2027'",
                params![now_iso()],
            )
            .unwrap();
        drop(connection);

        assert_eq!(
            store
                .reverse_vat_adjustment(reversal_input)
                .expect("exact reversal replay after later close")
                .sequence,
            reversal.sequence
        );

        let connection = store.connect().unwrap();
        assert!(connection
            .execute(
                "UPDATE vat_profiles SET updated_at='2099-01-01T00:00:00Z' WHERE id=?",
                params![profile.id],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE vat_source_classifications SET updated_at='2099-01-01T00:00:00Z' WHERE id=?",
                params![classification.id],
            )
            .is_err());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM vat_adjustments", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM audit_log WHERE entity_type='vat_adjustment'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2,
            "les rejets et replays TVA ne doivent ajouter aucun audit"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM vat_profiles WHERE id='future-profile'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
            "la nouvelle version TVA future doit être conservée"
        );
    }
}
