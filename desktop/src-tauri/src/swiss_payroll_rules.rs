use std::fmt;

use chrono::{Datelike, NaiveDate};

/// Plafond annuel du salaire soumis à l'assurance-chômage en 2026.
pub(crate) const SWISS_AC_ANNUAL_CEILING_CENTS_2026: i64 = 14_820_000;
/// Gain assuré LAA maximal 2026, commun à l'AAP et à l'AANP.
/// Le taux reste celui de la police réelle de l'assureur et ne doit jamais
/// être remplacé par un taux national fictif.
pub(crate) const SWISS_LAA_ANNUAL_CEILING_CENTS_2026: i64 = 14_820_000;
pub(crate) const SWISS_AVS_REFERENCE_AGE_MONTHLY_ALLOWANCE_CENTS: i64 = 140_000;
const SWISS_AC_YEAR_DAYS: i64 = 360;

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
