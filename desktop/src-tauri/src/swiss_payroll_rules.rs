use std::fmt;

use chrono::{Datelike, Months, NaiveDate};

/// Plafond annuel du salaire soumis à l'assurance-chômage en 2026.
pub(crate) const SWISS_AC_ANNUAL_CEILING_CENTS_2026: i64 = 14_820_000;
/// Gain assuré LAA maximal 2026, commun à l'AAP et à l'AANP.
/// Le taux reste celui de la police réelle de l'assureur et ne doit jamais
/// être remplacé par un taux national fictif.
pub(crate) const SWISS_LAA_ANNUAL_CEILING_CENTS_2026: i64 = 14_820_000;
pub(crate) const SWISS_AVS_REFERENCE_AGE_MONTHLY_ALLOWANCE_CENTS: i64 = 140_000;
pub(crate) const SWISS_LPP_ENTRY_THRESHOLD_CENTS_2026: i64 = 2_268_000;
pub(crate) const SWISS_LPP_ANNUAL_SALARY_CEILING_CENTS_2026: i64 = 9_072_000;
pub(crate) const SWISS_LPP_COORDINATION_DEDUCTION_CENTS_2026: i64 = 2_646_000;
pub(crate) const SWISS_LPP_MIN_COORDINATED_SALARY_CENTS_2026: i64 = 378_000;
pub(crate) const SWISS_LPP_MAX_COORDINATED_SALARY_CENTS_2026: i64 = 6_426_000;
const SWISS_AC_YEAR_DAYS: i64 = 360;

#[derive(Debug, Clone, Copy)]
pub(crate) struct LppAssessmentInput<'a> {
    pub period: &'a str,
    pub birth_date: Option<&'a str>,
    pub employment_start: Option<&'a str>,
    pub employment_end: Option<&'a str>,
    pub employment_contract_kind: Option<&'a str>,
    pub assessment_year: Option<i64>,
    pub annual_salary_cents: Option<i64>,
    pub exception_code: Option<&'a str>,
    pub exception_evidence_reference: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LppCoverage {
    NotDueUnderAge,
    NotDueUnderThreshold,
    Exempt,
    RiskOnly,
    RiskAndSavings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LppAssessment {
    pub coverage: LppCoverage,
    pub annual_salary_cents: Option<i64>,
    pub coordinated_annual_salary_cents: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LppAssessmentError {
    InvalidPeriod,
    UnsupportedYear,
    BirthDateRequired,
    InvalidBirthDate,
    AssessmentRequired,
    AssessmentYearMismatch,
    InvalidAnnualSalary,
    ContractKindRequired,
    InvalidContractKind,
    EmploymentStartRequired,
    InvalidEmploymentStart,
    EmploymentEndRequired,
    InvalidEmploymentEnd,
    EmploymentEndBeforeStart,
    PeriodOutsideEmployment,
    ExceptionEvidenceRequired,
    InvalidException,
}

impl fmt::Display for LppAssessmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidPeriod => "La période LPP doit être au format AAAA-MM.",
            Self::UnsupportedYear => {
                "Le moteur LPP déterministe ne prend en charge que les périodes 2026."
            }
            Self::BirthDateRequired => {
                "La date de naissance est obligatoire pour contrôler l'assujettissement LPP."
            }
            Self::InvalidBirthDate => {
                "La date de naissance LPP doit être une date valide au format AAAA-MM-JJ."
            }
            Self::AssessmentRequired => {
                "L'année d'évaluation et le salaire annuel LPP doivent être confirmés ensemble."
            }
            Self::AssessmentYearMismatch => {
                "L'évaluation salariale LPP ne correspond pas à l'année de la période."
            }
            Self::InvalidAnnualSalary => {
                "Le salaire annuel LPP doit être un montant positif ou nul."
            }
            Self::ContractKindRequired => {
                "La nature fixe ou indéterminée du contrat doit être confirmée pour la LPP."
            }
            Self::InvalidContractKind => "La nature du contrat LPP doit être indefinite ou fixed.",
            Self::EmploymentStartRequired => {
                "La date de début du contrat est obligatoire pour contrôler la LPP."
            }
            Self::InvalidEmploymentStart => "La date de début du contrat LPP est invalide.",
            Self::EmploymentEndRequired => {
                "Un contrat fixed exige une date de fin pour contrôler la LPP."
            }
            Self::InvalidEmploymentEnd => "La date de fin du contrat LPP est invalide.",
            Self::EmploymentEndBeforeStart => {
                "La date de fin du contrat LPP précède sa date de début."
            }
            Self::PeriodOutsideEmployment => {
                "La période LPP se situe hors des rapports de travail confirmés."
            }
            Self::ExceptionEvidenceRequired => {
                "Une exception LPP exige un code et une référence de preuve non vide."
            }
            Self::InvalidException => {
                "L'exception LPP ne correspond pas aux caractéristiques confirmées du contrat."
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for LppAssessmentError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcProratedCeiling {
    pub calendar_year: i32,
    pub employment_from: NaiveDate,
    pub employment_to: NaiveDate,
    pub days_30_360: i64,
    pub ceiling_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AvsReferenceAgeBasis {
    pub original_basis_cents: i64,
    pub effective_basis_cents: i64,
    pub allowance_applied_cents: i64,
    pub allowance_waived: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AcReferenceAgeStatus {
    /// La caisse ou la fiduciaire a confirmé que l'AC reste due.
    ConfirmedSubject,
    /// La caisse ou la fiduciaire a confirmé que l'âge de référence est atteint.
    ConfirmedExempt,
    /// Aucun statut explicite n'est disponible; le moteur ne devine ni sexe ni âge de référence.
    NeedsReview,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SwissPayrollRuleError {
    InvalidPeriod,
    InvalidEmploymentStart,
    InvalidEmploymentEnd,
    EmploymentEndBeforeStart,
    PeriodOutsideEmployment,
    InvalidAnnualCeiling,
    BirthDateRequired,
    InvalidBirthDate,
    InvalidReferenceAgeDate,
    ReferenceAgeReviewRequired,
    AvsAllowanceChoiceRequired,
}

impl fmt::Display for SwissPayrollRuleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidPeriod => "La période de paie doit être au format AAAA-MM.",
            Self::InvalidEmploymentStart => {
                "La date d'entrée en fonction doit être une date valide au format AAAA-MM-JJ."
            }
            Self::InvalidEmploymentEnd => {
                "La date de fin d'emploi doit être une date valide au format AAAA-MM-JJ."
            }
            Self::EmploymentEndBeforeStart => {
                "La date de fin d'emploi précède la date d'entrée en fonction."
            }
            Self::PeriodOutsideEmployment => {
                "La période de paie se situe hors des rapports de travail confirmés."
            }
            Self::InvalidAnnualCeiling => "Le plafond annuel AC doit être positif.",
            Self::BirthDateRequired => {
                "La date de naissance est obligatoire pour contrôler l'assujettissement AVS et AC."
            }
            Self::InvalidBirthDate => {
                "La date de naissance doit être une date valide au format AAAA-MM-JJ."
            }
            Self::InvalidReferenceAgeDate => {
                "La date confirmée d'atteinte de l'âge de référence doit être valide."
            }
            Self::ReferenceAgeReviewRequired => {
                "Le statut d'assujettissement après l'âge de référence doit être confirmé explicitement; Zentra ne le déduit pas du sexe."
            }
            Self::AvsAllowanceChoiceRequired => {
                "Après l'âge de référence, confirmez si la franchise AVS est conservée ou si le collaborateur y renonce."
            }
        };
        formatter.write_str(message)
    }
}

/// Applique la franchise AVS de CHF 1'400 à chaque mois civil entier ou entamé
/// couvert après le mois de l'atteinte de l'âge de référence. Une renonciation conserve la base entière et un choix
/// absent bloque le calcul. Le montant annuel de CHF 16'800 résulte des douze
/// franchises mensuelles; une fiche Zentra représente une période mensuelle.
pub(crate) fn apply_avs_reference_age_allowance(
    basis_cents: i64,
    reference_age_status: AcReferenceAgeStatus,
    allowance_waived: Option<bool>,
) -> Result<AvsReferenceAgeBasis, SwissPayrollRuleError> {
    match reference_age_status {
        AcReferenceAgeStatus::ConfirmedSubject => Ok(AvsReferenceAgeBasis {
            original_basis_cents: basis_cents,
            effective_basis_cents: basis_cents,
            allowance_applied_cents: 0,
            allowance_waived: None,
        }),
        AcReferenceAgeStatus::NeedsReview => Err(SwissPayrollRuleError::ReferenceAgeReviewRequired),
        AcReferenceAgeStatus::ConfirmedExempt => match allowance_waived {
            None => Err(SwissPayrollRuleError::AvsAllowanceChoiceRequired),
            Some(true) => Ok(AvsReferenceAgeBasis {
                original_basis_cents: basis_cents,
                effective_basis_cents: basis_cents,
                allowance_applied_cents: 0,
                allowance_waived: Some(true),
            }),
            Some(false) => {
                let allowance = basis_cents.min(SWISS_AVS_REFERENCE_AGE_MONTHLY_ALLOWANCE_CENTS);
                Ok(AvsReferenceAgeBasis {
                    original_basis_cents: basis_cents,
                    effective_basis_cents: basis_cents.saturating_sub(allowance),
                    allowance_applied_cents: allowance,
                    allowance_waived: Some(false),
                })
            }
        },
    }
}

/// Détermine uniquement les situations certaines : une date d'âge de
/// référence confirmée prime; avant 64 ans l'AC est encore due; dès 64 ans
/// sans confirmation, une revue est exigée. Aucun sexe n'est demandé ou inféré.
pub(crate) fn ac_reference_age_status_for_period(
    period: &str,
    birth_date: Option<&str>,
    confirmed_reference_age_date: Option<&str>,
) -> Result<AcReferenceAgeStatus, SwissPayrollRuleError> {
    let (year, month) = parse_period(period)?;
    let period_start = NaiveDate::from_ymd_opt(year, month, 1).expect("validated month");
    let next_month = next_month_start(period_start);
    let period_end = next_month.pred_opt().expect("period has a previous day");

    if let Some(reference_date) = confirmed_reference_age_date
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let reference_date = NaiveDate::parse_from_str(reference_date, "%Y-%m-%d")
            .map_err(|_| SwissPayrollRuleError::InvalidReferenceAgeDate)?;
        // L'AC reste due pendant tout le mois où l'âge de référence est atteint;
        // l'exemption et la franchise AVS commencent le mois civil suivant.
        return Ok(if period_start >= next_month_start(reference_date) {
            AcReferenceAgeStatus::ConfirmedExempt
        } else {
            AcReferenceAgeStatus::ConfirmedSubject
        });
    }

    let Some(birth_date) = birth_date.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(AcReferenceAgeStatus::NeedsReview);
    };
    let birth_date = NaiveDate::parse_from_str(birth_date, "%Y-%m-%d")
        .map_err(|_| SwissPayrollRuleError::InvalidBirthDate)?;
    let sixty_fourth_birthday = birth_date
        .with_year(birth_date.year() + 64)
        .or_else(|| NaiveDate::from_ymd_opt(birth_date.year() + 64, 2, 28))
        .expect("a 64th birthday is representable");
    Ok(if period_end < sixty_fourth_birthday {
        AcReferenceAgeStatus::ConfirmedSubject
    } else {
        AcReferenceAgeStatus::NeedsReview
    })
}

/// L'obligation AVS/AI/APG (et donc l'affiliation AC) commence le 1er janvier
/// de l'année qui suit le 17e anniversaire.
pub(crate) fn avs_is_due_for_period(
    period: &str,
    birth_date: Option<&str>,
) -> Result<bool, SwissPayrollRuleError> {
    let (year, _) = parse_period(period)?;
    let birth_date = birth_date
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(SwissPayrollRuleError::BirthDateRequired)?;
    let birth_date = NaiveDate::parse_from_str(birth_date, "%Y-%m-%d")
        .map_err(|_| SwissPayrollRuleError::InvalidBirthDate)?;
    Ok(year >= birth_date.year().saturating_add(18))
}

/// Qualifie l'assujettissement LPP 2026 sans fabriquer de taux de caisse.
/// Le moteur ne calcule que le statut légal et, lorsque la couverture est due,
/// le salaire coordonné annuel obligatoire. Les cotisations effectives restent
/// celles du règlement réel de l'institution de prévoyance.
pub(crate) fn assess_lpp_2026(
    input: LppAssessmentInput<'_>,
) -> Result<LppAssessment, LppAssessmentError> {
    let (year, month) =
        parse_period(input.period).map_err(|_| LppAssessmentError::InvalidPeriod)?;
    if year != 2026 {
        return Err(LppAssessmentError::UnsupportedYear);
    }
    let birth_date = input
        .birth_date
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(LppAssessmentError::BirthDateRequired)
        .and_then(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map_err(|_| LppAssessmentError::InvalidBirthDate)
        })?;

    // Les risques décès et invalidité commencent le 1er janvier suivant le
    // 17e anniversaire. Avant cette date, les autres données LPP ne sont pas
    // nécessaires pour conclure avec certitude que la couverture n'est pas due.
    if year < birth_date.year().saturating_add(18) {
        return Ok(LppAssessment {
            coverage: LppCoverage::NotDueUnderAge,
            annual_salary_cents: None,
            coordinated_annual_salary_cents: None,
        });
    }

    let (assessment_year, annual_salary_cents) =
        match (input.assessment_year, input.annual_salary_cents) {
            (Some(assessment_year), Some(annual_salary_cents)) => {
                (assessment_year, annual_salary_cents)
            }
            _ => return Err(LppAssessmentError::AssessmentRequired),
        };
    if assessment_year != i64::from(year) {
        return Err(LppAssessmentError::AssessmentYearMismatch);
    }
    if annual_salary_cents < 0 {
        return Err(LppAssessmentError::InvalidAnnualSalary);
    }
    // Le texte légal vise un salaire strictement supérieur au seuil d'entrée.
    if annual_salary_cents <= SWISS_LPP_ENTRY_THRESHOLD_CENTS_2026 {
        return Ok(LppAssessment {
            coverage: LppCoverage::NotDueUnderThreshold,
            annual_salary_cents: Some(annual_salary_cents),
            coordinated_annual_salary_cents: None,
        });
    }

    let contract_kind = input
        .employment_contract_kind
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(LppAssessmentError::ContractKindRequired)?;
    if !matches!(contract_kind, "indefinite" | "fixed") {
        return Err(LppAssessmentError::InvalidContractKind);
    }
    let employment_start = input
        .employment_start
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(LppAssessmentError::EmploymentStartRequired)
        .and_then(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map_err(|_| LppAssessmentError::InvalidEmploymentStart)
        })?;
    let employment_end = input
        .employment_end
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map_err(|_| LppAssessmentError::InvalidEmploymentEnd)
        })
        .transpose()?;
    if contract_kind == "fixed" && employment_end.is_none() {
        return Err(LppAssessmentError::EmploymentEndRequired);
    }
    if employment_end.is_some_and(|end| end < employment_start) {
        return Err(LppAssessmentError::EmploymentEndBeforeStart);
    }

    let period_start = NaiveDate::from_ymd_opt(year, month, 1).expect("validated LPP period month");
    let period_end = next_month_start(period_start)
        .pred_opt()
        .expect("validated LPP period has a previous day");
    if employment_start > period_end || employment_end.is_some_and(|end| end < period_start) {
        return Err(LppAssessmentError::PeriodOutsideEmployment);
    }

    let exception_code = input
        .exception_code
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let exception_evidence = input
        .exception_evidence_reference
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if exception_code.is_some() != exception_evidence.is_some() {
        return Err(LppAssessmentError::ExceptionEvidenceRequired);
    }
    if exception_code.is_some_and(|code| !matches!(code, "short_fixed_contract" | "other_legal")) {
        return Err(LppAssessmentError::InvalidException);
    }

    let short_fixed_contract = if contract_kind == "fixed" {
        let employment_end = employment_end.expect("fixed contract end validated above");
        let three_month_mark = employment_start
            .checked_add_months(Months::new(3))
            .ok_or(LppAssessmentError::InvalidEmploymentEnd)?;
        employment_end < three_month_mark
    } else {
        false
    };
    match (short_fixed_contract, exception_code) {
        (true, Some("short_fixed_contract" | "other_legal")) | (false, Some("other_legal")) => {
            return Ok(LppAssessment {
                coverage: LppCoverage::Exempt,
                annual_salary_cents: Some(annual_salary_cents),
                coordinated_annual_salary_cents: None,
            })
        }
        (true, None) => return Err(LppAssessmentError::ExceptionEvidenceRequired),
        (false, Some("short_fixed_contract")) => return Err(LppAssessmentError::InvalidException),
        _ => {}
    }

    let coordinated_annual_salary_cents = annual_salary_cents
        .min(SWISS_LPP_ANNUAL_SALARY_CEILING_CENTS_2026)
        .saturating_sub(SWISS_LPP_COORDINATION_DEDUCTION_CENTS_2026)
        .clamp(
            SWISS_LPP_MIN_COORDINATED_SALARY_CENTS_2026,
            SWISS_LPP_MAX_COORDINATED_SALARY_CENTS_2026,
        );
    let coverage = if year >= birth_date.year().saturating_add(25) {
        LppCoverage::RiskAndSavings
    } else {
        LppCoverage::RiskOnly
    };
    Ok(LppAssessment {
        coverage,
        annual_salary_cents: Some(annual_salary_cents),
        coordinated_annual_salary_cents: Some(coordinated_annual_salary_cents),
    })
}

impl std::error::Error for SwissPayrollRuleError {}

/// Indique si l'AC doit être calculée sans jamais inférer le sexe ou l'âge de
/// référence. Le statut `NeedsReview` est volontairement bloquant.
pub(crate) fn ac_is_due(status: AcReferenceAgeStatus) -> Result<bool, SwissPayrollRuleError> {
    match status {
        AcReferenceAgeStatus::ConfirmedSubject => Ok(true),
        AcReferenceAgeStatus::ConfirmedExempt => Ok(false),
        AcReferenceAgeStatus::NeedsReview => Err(SwissPayrollRuleError::ReferenceAgeReviewRequired),
    }
}

/// Calcule le plafond AC cumulé jusqu'à la fin de la période demandée.
///
/// La convention officielle compte chaque mois plein pour 30 jours et l'année
/// pour 360 jours. Les jours de début et de fin sont inclus. Le résultat peut
/// donc être utilisé avec la base cumulée avant le mois courant pour garantir
/// que l'aperçu et l'enregistrement appliquent exactement la même limite.
pub(crate) fn prorated_ac_ceiling_through_period(
    annual_ceiling_cents: i64,
    period: &str,
    employment_start: &str,
    employment_end: Option<&str>,
) -> Result<AcProratedCeiling, SwissPayrollRuleError> {
    if annual_ceiling_cents <= 0 {
        return Err(SwissPayrollRuleError::InvalidAnnualCeiling);
    }
    let (year, month) = parse_period(period)?;
    let employment_start = NaiveDate::parse_from_str(employment_start, "%Y-%m-%d")
        .map_err(|_| SwissPayrollRuleError::InvalidEmploymentStart)?;
    let employment_end = employment_end
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map_err(|_| SwissPayrollRuleError::InvalidEmploymentEnd)
        })
        .transpose()?;
    if employment_end.is_some_and(|end| end < employment_start) {
        return Err(SwissPayrollRuleError::EmploymentEndBeforeStart);
    }

    let year_start = NaiveDate::from_ymd_opt(year, 1, 1).expect("valid calendar year");
    let year_end = NaiveDate::from_ymd_opt(year, 12, 31).expect("valid calendar year");
    let period_start = NaiveDate::from_ymd_opt(year, month, 1).expect("validated month");
    let next_month = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1).expect("valid next year")
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1).expect("validated next month")
    };
    let period_end = next_month.pred_opt().expect("period has a previous day");

    if employment_start > period_end
        || employment_end.is_some_and(|end| end < period_start)
        || employment_start > year_end
        || employment_end.is_some_and(|end| end < year_start)
    {
        return Err(SwissPayrollRuleError::PeriodOutsideEmployment);
    }

    let range_start = employment_start.max(year_start);
    let range_end = employment_end
        .unwrap_or(period_end)
        .min(period_end)
        .min(year_end);
    if range_end < range_start {
        return Err(SwissPayrollRuleError::PeriodOutsideEmployment);
    }
    let days_30_360 = inclusive_days_30_360(range_start, range_end);
    let numerator = annual_ceiling_cents as i128 * days_30_360 as i128;
    let ceiling_cents =
        ((numerator + (SWISS_AC_YEAR_DAYS as i128 / 2)) / SWISS_AC_YEAR_DAYS as i128) as i64;
    Ok(AcProratedCeiling {
        calendar_year: year,
        employment_from: range_start,
        employment_to: range_end,
        days_30_360,
        ceiling_cents,
    })
}

fn parse_period(period: &str) -> Result<(i32, u32), SwissPayrollRuleError> {
    let mut parts = period.split('-');
    let year = parts
        .next()
        .filter(|value| value.len() == 4)
        .and_then(|value| value.parse::<i32>().ok());
    let month = parts
        .next()
        .filter(|value| value.len() == 2)
        .and_then(|value| value.parse::<u32>().ok());
    if parts.next().is_some()
        || !year.is_some_and(|value| (1..=9_998).contains(&value))
        || !month.is_some_and(|value| (1..=12).contains(&value))
    {
        return Err(SwissPayrollRuleError::InvalidPeriod);
    }
    Ok((
        year.expect("validated year"),
        month.expect("validated month"),
    ))
}

fn next_month_start(date: NaiveDate) -> NaiveDate {
    if date.month() == 12 {
        NaiveDate::from_ymd_opt(date.year() + 1, 1, 1).expect("valid next year")
    } else {
        NaiveDate::from_ymd_opt(date.year(), date.month() + 1, 1).expect("validated next month")
    }
}

fn inclusive_days_30_360(start: NaiveDate, end: NaiveDate) -> i64 {
    debug_assert!(start <= end);
    let serial = |date: NaiveDate| {
        let next_day = date.succ_opt();
        let is_last_day_of_month = next_day.is_some_and(|next| next.month() != date.month());
        let convention_day = if is_last_day_of_month {
            30
        } else {
            date.day().min(30)
        };
        i64::from(date.year()) * SWISS_AC_YEAR_DAYS
            + i64::from(date.month0()) * 30
            + i64::from(convention_day)
    };
    serial(end) - serial(start) + 1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lpp_input() -> LppAssessmentInput<'static> {
        LppAssessmentInput {
            period: "2026-06",
            birth_date: Some("1990-06-15"),
            employment_start: Some("2020-01-01"),
            employment_end: None,
            employment_contract_kind: Some("indefinite"),
            assessment_year: Some(2026),
            annual_salary_cents: Some(8_000_000),
            exception_code: None,
            exception_evidence_reference: None,
        }
    }

    #[test]
    fn lpp_threshold_is_strict_and_coordinated_salary_is_bounded() {
        let at_threshold = assess_lpp_2026(LppAssessmentInput {
            annual_salary_cents: Some(SWISS_LPP_ENTRY_THRESHOLD_CENTS_2026),
            ..lpp_input()
        })
        .unwrap();
        assert_eq!(at_threshold.coverage, LppCoverage::NotDueUnderThreshold);
        assert_eq!(at_threshold.coordinated_annual_salary_cents, None);

        let first_insured_cent = assess_lpp_2026(LppAssessmentInput {
            annual_salary_cents: Some(SWISS_LPP_ENTRY_THRESHOLD_CENTS_2026 + 1),
            ..lpp_input()
        })
        .unwrap();
        assert_eq!(
            first_insured_cent.coordinated_annual_salary_cents,
            Some(SWISS_LPP_MIN_COORDINATED_SALARY_CENTS_2026)
        );

        let at_salary_ceiling = assess_lpp_2026(LppAssessmentInput {
            annual_salary_cents: Some(SWISS_LPP_ANNUAL_SALARY_CEILING_CENTS_2026),
            ..lpp_input()
        })
        .unwrap();
        assert_eq!(
            at_salary_ceiling.coordinated_annual_salary_cents,
            Some(SWISS_LPP_MAX_COORDINATED_SALARY_CENTS_2026)
        );
        let above_salary_ceiling = assess_lpp_2026(LppAssessmentInput {
            annual_salary_cents: Some(SWISS_LPP_ANNUAL_SALARY_CEILING_CENTS_2026 * 2),
            ..lpp_input()
        })
        .unwrap();
        assert_eq!(
            above_salary_ceiling.coordinated_annual_salary_cents,
            Some(SWISS_LPP_MAX_COORDINATED_SALARY_CENTS_2026)
        );
    }

    #[test]
    fn lpp_risk_and_savings_start_on_the_required_january_first() {
        let under_risk_age = assess_lpp_2026(LppAssessmentInput {
            birth_date: Some("2009-01-01"),
            ..lpp_input()
        })
        .unwrap();
        assert_eq!(under_risk_age.coverage, LppCoverage::NotDueUnderAge);

        let first_risk_year = assess_lpp_2026(LppAssessmentInput {
            birth_date: Some("2008-12-31"),
            ..lpp_input()
        })
        .unwrap();
        assert_eq!(first_risk_year.coverage, LppCoverage::RiskOnly);

        let last_risk_only_year = assess_lpp_2026(LppAssessmentInput {
            birth_date: Some("2002-01-01"),
            ..lpp_input()
        })
        .unwrap();
        assert_eq!(last_risk_only_year.coverage, LppCoverage::RiskOnly);

        let first_savings_year = assess_lpp_2026(LppAssessmentInput {
            birth_date: Some("2001-12-31"),
            ..lpp_input()
        })
        .unwrap();
        assert_eq!(first_savings_year.coverage, LppCoverage::RiskAndSavings);
    }

    #[test]
    fn lpp_fixed_contract_boundary_is_three_calendar_months() {
        let exact_three_months = LppAssessmentInput {
            period: "2026-03",
            employment_start: Some("2026-01-01"),
            employment_end: Some("2026-03-31"),
            employment_contract_kind: Some("fixed"),
            exception_code: Some("short_fixed_contract"),
            exception_evidence_reference: Some("Contrat signé C-2026-001"),
            ..lpp_input()
        };
        assert_eq!(
            assess_lpp_2026(exact_three_months).unwrap().coverage,
            LppCoverage::Exempt
        );
        assert_eq!(
            assess_lpp_2026(LppAssessmentInput {
                exception_code: None,
                exception_evidence_reference: None,
                ..exact_three_months
            }),
            Err(LppAssessmentError::ExceptionEvidenceRequired)
        );

        let more_than_three_months = LppAssessmentInput {
            employment_end: Some("2026-04-01"),
            exception_code: None,
            exception_evidence_reference: None,
            ..exact_three_months
        };
        assert_eq!(
            assess_lpp_2026(more_than_three_months).unwrap().coverage,
            LppCoverage::RiskAndSavings
        );
        assert_eq!(
            assess_lpp_2026(LppAssessmentInput {
                exception_code: Some("short_fixed_contract"),
                exception_evidence_reference: Some("Contrat signé C-2026-001"),
                ..more_than_three_months
            }),
            Err(LppAssessmentError::InvalidException)
        );
    }

    #[test]
    fn reproduces_the_official_partial_year_example() {
        let result = prorated_ac_ceiling_through_period(
            SWISS_AC_ANNUAL_CEILING_CENTS_2026,
            "2026-12",
            "2026-04-15",
            Some("2026-12-29"),
        )
        .unwrap();

        assert_eq!(result.days_30_360, 255);
        assert_eq!(result.ceiling_cents, 10_497_500);
        assert_eq!(result.employment_from.to_string(), "2026-04-15");
        assert_eq!(result.employment_to.to_string(), "2026-12-29");
    }

    #[test]
    fn full_calendar_year_keeps_the_statutory_ceiling() {
        let result = prorated_ac_ceiling_through_period(
            SWISS_AC_ANNUAL_CEILING_CENTS_2026,
            "2026-12",
            "2020-07-01",
            None,
        )
        .unwrap();

        assert_eq!(result.days_30_360, 360);
        assert_eq!(result.ceiling_cents, SWISS_AC_ANNUAL_CEILING_CENTS_2026);
    }

    #[test]
    fn every_full_month_counts_as_thirty_days_including_february() {
        let january = prorated_ac_ceiling_through_period(
            SWISS_AC_ANNUAL_CEILING_CENTS_2026,
            "2026-01",
            "2026-01-01",
            None,
        )
        .unwrap();
        let february = prorated_ac_ceiling_through_period(
            SWISS_AC_ANNUAL_CEILING_CENTS_2026,
            "2026-02",
            "2026-01-01",
            None,
        )
        .unwrap();

        assert_eq!(january.days_30_360, 30);
        assert_eq!(january.ceiling_cents, 1_235_000);
        assert_eq!(february.days_30_360, 60);
        assert_eq!(february.ceiling_cents, 2_470_000);
    }

    #[test]
    fn a_partial_month_includes_both_boundary_days_and_rounds_to_cents() {
        let result = prorated_ac_ceiling_through_period(
            SWISS_AC_ANNUAL_CEILING_CENTS_2026,
            "2026-04",
            "2026-04-15",
            None,
        )
        .unwrap();

        assert_eq!(result.days_30_360, 16);
        assert_eq!(result.ceiling_cents, 658_667);
    }

    #[test]
    fn the_thirty_first_is_the_thirtieth_day_of_the_month() {
        let result = prorated_ac_ceiling_through_period(
            SWISS_AC_ANNUAL_CEILING_CENTS_2026,
            "2026-01",
            "2026-01-30",
            Some("2026-01-31"),
        )
        .unwrap();

        assert_eq!(result.days_30_360, 1);
        assert_eq!(result.ceiling_cents, 41_167);
    }

    #[test]
    fn a_known_employment_end_clamps_the_cumulative_ceiling() {
        let result = prorated_ac_ceiling_through_period(
            SWISS_AC_ANNUAL_CEILING_CENTS_2026,
            "2026-08",
            "2026-01-01",
            Some("2026-08-12"),
        )
        .unwrap();

        assert_eq!(result.days_30_360, 222);
        assert_eq!(result.ceiling_cents, 9_139_000);
    }

    #[test]
    fn refuses_invalid_or_out_of_contract_periods() {
        assert_eq!(
            prorated_ac_ceiling_through_period(
                SWISS_AC_ANNUAL_CEILING_CENTS_2026,
                "2026-03",
                "2026-04-01",
                None,
            ),
            Err(SwissPayrollRuleError::PeriodOutsideEmployment)
        );
        assert_eq!(
            prorated_ac_ceiling_through_period(
                SWISS_AC_ANNUAL_CEILING_CENTS_2026,
                "2026-04",
                "2026-04-20",
                Some("2026-04-19"),
            ),
            Err(SwissPayrollRuleError::EmploymentEndBeforeStart)
        );
        assert_eq!(
            prorated_ac_ceiling_through_period(
                SWISS_AC_ANNUAL_CEILING_CENTS_2026,
                "2026-13",
                "2026-01-01",
                None,
            ),
            Err(SwissPayrollRuleError::InvalidPeriod)
        );
    }

    #[test]
    fn reference_age_status_is_never_inferred() {
        assert_eq!(ac_is_due(AcReferenceAgeStatus::ConfirmedSubject), Ok(true));
        assert_eq!(ac_is_due(AcReferenceAgeStatus::ConfirmedExempt), Ok(false));
        assert_eq!(
            ac_is_due(AcReferenceAgeStatus::NeedsReview),
            Err(SwissPayrollRuleError::ReferenceAgeReviewRequired)
        );
        assert_eq!(
            ac_reference_age_status_for_period("2026-08", Some("1970-03-01"), None),
            Ok(AcReferenceAgeStatus::ConfirmedSubject)
        );
        assert_eq!(
            ac_reference_age_status_for_period("2026-08", Some("1962-03-01"), None),
            Ok(AcReferenceAgeStatus::NeedsReview)
        );
        assert_eq!(
            ac_reference_age_status_for_period("2026-08", Some("1962-03-01"), Some("2026-09-01")),
            Ok(AcReferenceAgeStatus::ConfirmedSubject)
        );
        assert_eq!(
            ac_reference_age_status_for_period("2026-09", Some("1962-03-01"), Some("2026-09-01")),
            Ok(AcReferenceAgeStatus::ConfirmedSubject)
        );
        assert_eq!(
            ac_reference_age_status_for_period("2026-10", Some("1962-03-01"), Some("2026-09-01")),
            Ok(AcReferenceAgeStatus::ConfirmedExempt)
        );
        assert_eq!(
            ac_reference_age_status_for_period("2027-01", Some("1962-03-01"), Some("2026-12-31")),
            Ok(AcReferenceAgeStatus::ConfirmedExempt)
        );
    }

    #[test]
    fn avs_starts_on_january_first_after_the_seventeenth_birthday() {
        assert_eq!(
            avs_is_due_for_period("2025-12", Some("2008-01-01")),
            Ok(false)
        );
        assert_eq!(
            avs_is_due_for_period("2026-01", Some("2008-12-31")),
            Ok(true)
        );
        assert_eq!(
            avs_is_due_for_period("2026-01", None),
            Err(SwissPayrollRuleError::BirthDateRequired)
        );
    }

    #[test]
    fn avs_reference_age_allowance_requires_an_explicit_choice() {
        assert_eq!(
            apply_avs_reference_age_allowance(500_000, AcReferenceAgeStatus::ConfirmedExempt, None),
            Err(SwissPayrollRuleError::AvsAllowanceChoiceRequired)
        );
        assert_eq!(
            apply_avs_reference_age_allowance(
                500_000,
                AcReferenceAgeStatus::ConfirmedExempt,
                Some(false)
            )
            .unwrap(),
            AvsReferenceAgeBasis {
                original_basis_cents: 500_000,
                effective_basis_cents: 360_000,
                allowance_applied_cents: 140_000,
                allowance_waived: Some(false),
            }
        );
        assert_eq!(
            apply_avs_reference_age_allowance(
                80_000,
                AcReferenceAgeStatus::ConfirmedExempt,
                Some(false)
            )
            .unwrap()
            .effective_basis_cents,
            0
        );
        assert_eq!(
            apply_avs_reference_age_allowance(
                500_000,
                AcReferenceAgeStatus::ConfirmedExempt,
                Some(true)
            )
            .unwrap()
            .effective_basis_cents,
            500_000
        );
    }
}
