//! Paiements sûrs : contrôles calculés par l'app avant de payer un
//! fournisseur, double validation des gros montants et écritures
//! inhabituelles sur une facture fournisseur.
//!
//! Tout part des données de l'app, jamais d'un modèle : IBAN déjà payés,
//! paiements enregistrés, factures du même fournisseur. Les contrôles sont
//! recalculés au moment d'écrire l'ordre pain.001, et chaque alerte
//! confirmée en connaissance de cause est gardée dans le journal d'audit.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{Duration, Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
};

/// Double validation au-delà de CHF 5 000.00, réglable dans Paramètres.
pub(crate) const DEFAULT_APPROVAL_THRESHOLD_CENTS: i64 = 500_000;
/// Relance d'un justificatif manquant après 10 jours, réglable.
pub(crate) const DEFAULT_RECEIPT_REMINDER_DAYS: i64 = 10;
/// Montant inhabituel : plus de 3 fois le montant habituel du fournisseur…
pub(crate) const UNUSUAL_FACTOR: i64 = 3;
/// …avec au moins 4 factures connues sur deux ans…
pub(crate) const UNUSUAL_MIN_HISTORY: usize = 4;
/// …et au moins CHF 100 d'écart, pour ne pas alerter sur de petites sommes.
pub(crate) const UNUSUAL_MIN_GAP_CENTS: i64 = 10_000;
/// Même fournisseur et même montant à moins de 10 jours : doublon possible.
pub(crate) const DUPLICATE_WINDOW_DAYS: i64 = 10;
/// Écriture inhabituelle : il faut au moins 3 factures validées du fournisseur.
pub(crate) const ENTRY_MIN_HISTORY: usize = 3;
/// Une habitude est un compte ou un taux présent sur au moins 60 % des lignes.
pub(crate) const ENTRY_DOMINANT_PERCENT: usize = 60;
const HISTORY_WINDOW_DAYS: i64 = 730;
const LOCAL_USER_ID: &str = "local-user";
const LOCAL_USER_NAME: &str = "Utilisateur de cet appareil";

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

pub(crate) fn normalize_iban(value: &str) -> String {
    value.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase()
}

/// « CH93 •••• 2957 » : assez pour reconnaître le compte, pas pour le recopier.
pub(crate) fn mask_iban(value: &str) -> String {
    let chars: Vec<char> = normalize_iban(value).chars().collect();
    if chars.len() < 9 {
        return chars.into_iter().collect();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head} •••• {tail}")
}

fn parse_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.get(..10)?, "%Y-%m-%d").ok()
}

fn median(values: &mut [i64]) -> Option<i64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 1 { values[middle] } else { (values[middle - 1] + values[middle]) / 2 })
}

// ---------------------------------------------------------------------------
// Réglages, personne qui agit
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Settings {
    pub approval_enabled: bool,
    pub approval_threshold_cents: i64,
    pub receipt_reminder_days: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { approval_enabled: true, approval_threshold_cents: DEFAULT_APPROVAL_THRESHOLD_CENTS, receipt_reminder_days: DEFAULT_RECEIPT_REMINDER_DAYS }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Actor {
    pub user_id: String,
    pub display_name: String,
    pub role: String,
    /// Entreprise d'une seule personne : on garde les alertes, sans bloquer.
    pub solo: bool,
}

impl Actor {
    pub fn may_approve(&self) -> bool {
        matches!(self.role.as_str(), "owner" | "admin")
    }

    fn json(&self) -> Value {
        json!({"userId": self.user_id, "displayName": self.display_name, "role": self.role, "solo": self.solo, "mayApprove": self.may_approve()})
    }
}

// ---------------------------------------------------------------------------
// 1. Contrôles avant paiement
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PastInvoice {
    pub id: String,
    pub reference: Option<String>,
    pub reference_normalized: Option<String>,
    /// Référence QR ou créancier (RF) de la QR-facture, si elle en a une.
    pub payment_reference: Option<String>,
    pub creditor_iban: Option<String>,
    pub total_cents: i64,
    pub document_date: NaiveDate,
    pub validated: bool,
    /// Faux pour une facture d'une autre fiche trouvée par IBAN et référence QR.
    pub same_supplier: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PastPayment {
    pub date: NaiveDate,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PaidIban {
    pub iban: String,
    pub paid_on: NaiveDate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SeenIban {
    pub iban: String,
    pub first_seen: NaiveDate,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SupplierHistory {
    pub invoices: Vec<PastInvoice>,
    pub payments: Vec<PastPayment>,
    /// IBAN écrits dans les ordres de paiement déjà préparés.
    pub paid_ibans: Vec<PaidIban>,
    /// IBAN vus sur la fiche ou sur une QR-facture, avec leur première date.
    pub seen_ibans: Vec<SeenIban>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub invoice_id: String,
    pub total_cents: i64,
    pub document_date: NaiveDate,
    pub reference_normalized: Option<String>,
    pub payment_reference: Option<String>,
    pub iban: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DuplicateReason {
    SameNumber,
    SamePaymentReference,
    SameAmountAndDate,
}

impl DuplicateReason {
    fn code(self) -> &'static str {
        match self {
            Self::SameNumber => "same_number",
            Self::SamePaymentReference => "same_payment_reference",
            Self::SameAmountAndDate => "same_amount_and_date",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Finding {
    IbanChanged { previous_iban: String, current_iban: String, changed_on: Option<NaiveDate>, last_paid_on: Option<NaiveDate> },
    NewSupplier,
    PossibleDuplicate { other_invoice_id: String, other_reference: Option<String>, other_total_cents: i64, other_document_date: NaiveDate, reason: DuplicateReason },
    UnusualAmount { usual_cents: i64, history_count: usize },
}

impl Finding {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::IbanChanged { .. } => "iban_changed",
            Self::NewSupplier => "new_supplier",
            Self::PossibleDuplicate { .. } => "possible_duplicate",
            Self::UnusualAmount { .. } => "unusual_amount",
        }
    }

    pub fn json(&self) -> Value {
        match self {
            Self::IbanChanged { previous_iban, current_iban, changed_on, last_paid_on } => json!({
                "kind": self.kind(),
                "previousIban": mask_iban(previous_iban),
                "currentIban": mask_iban(current_iban),
                "changedOn": changed_on.map(|date| date.to_string()),
                "lastPaidOn": last_paid_on.map(|date| date.to_string()),
            }),
            Self::NewSupplier => json!({"kind": self.kind()}),
            Self::PossibleDuplicate { other_invoice_id, other_reference, other_total_cents, other_document_date, reason } => json!({
                "kind": self.kind(),
                "otherInvoiceId": other_invoice_id,
                "otherReference": other_reference,
                "otherTotalCents": other_total_cents,
                "otherDocumentDate": other_document_date.to_string(),
                "reason": reason.code(),
            }),
            Self::UnusualAmount { usual_cents, history_count } => json!({
                "kind": self.kind(),
                "usualCents": usual_cents,
                "historyCount": history_count,
                "factor": UNUSUAL_FACTOR,
            }),
        }
    }
}

/// IBAN changé depuis le dernier paiement. La référence est l'IBAN du dernier
/// ordre préparé ; sans ordre, l'IBAN connu avant le dernier paiement enregistré.
fn iban_change(current: &str, history: &SupplierHistory) -> Option<Finding> {
    let changed_on = history.seen_ibans.iter().filter(|seen| seen.iban == current).map(|seen| seen.first_seen).min();
    if let Some(last) = history.paid_ibans.iter().max_by_key(|paid| paid.paid_on) {
        return (last.iban != current).then(|| Finding::IbanChanged {
            previous_iban: last.iban.clone(),
            current_iban: current.to_owned(),
            changed_on,
            last_paid_on: Some(last.paid_on),
        });
    }
    let last_payment = history.payments.iter().map(|payment| payment.date).max()?;
    if changed_on.is_some_and(|date| date <= last_payment) {
        return None;
    }
    let previous = history
        .seen_ibans
        .iter()
        .filter(|seen| seen.iban != current && seen.first_seen <= last_payment)
        .max_by_key(|seen| seen.first_seen)?;
    Some(Finding::IbanChanged { previous_iban: previous.iban.clone(), current_iban: current.to_owned(), changed_on, last_paid_on: Some(last_payment) })
}

fn duplicates(candidate: &Candidate, history: &SupplierHistory) -> Vec<Finding> {
    let iban = candidate.iban.as_deref().map(normalize_iban);
    history
        .invoices
        .iter()
        .filter(|other| other.id != candidate.invoice_id)
        .filter_map(|other| {
            let reason = if other.same_supplier && candidate.reference_normalized.is_some() && other.reference_normalized == candidate.reference_normalized {
                Some(DuplicateReason::SameNumber)
            } else if candidate.payment_reference.is_some()
                && other.payment_reference == candidate.payment_reference
                && (other.same_supplier || (iban.is_some() && other.creditor_iban.as_deref().map(normalize_iban) == iban))
            {
                Some(DuplicateReason::SamePaymentReference)
            } else if other.same_supplier
                && candidate.total_cents > 0
                && other.total_cents == candidate.total_cents
                && (other.document_date - candidate.document_date).num_days().abs() <= DUPLICATE_WINDOW_DAYS
            {
                Some(DuplicateReason::SameAmountAndDate)
            } else {
                None
            };
            reason.map(|reason| Finding::PossibleDuplicate {
                other_invoice_id: other.id.clone(),
                other_reference: other.reference.clone(),
                other_total_cents: other.total_cents,
                other_document_date: other.document_date,
                reason,
            })
        })
        .collect()
}

/// Médiane des factures validées du fournisseur sur deux ans, sans la facture elle-même.
fn usual_total(candidate_id: &str, around: NaiveDate, history: &SupplierHistory) -> (Option<i64>, usize) {
    let mut totals: Vec<i64> = history
        .invoices
        .iter()
        .filter(|other| other.same_supplier && other.validated && other.id != candidate_id && other.total_cents > 0)
        .filter(|other| (around - other.document_date).num_days().abs() <= HISTORY_WINDOW_DAYS)
        .map(|other| other.total_cents)
        .collect();
    let count = totals.len();
    (median(&mut totals), count)
}

pub(crate) fn is_unusual_total(total_cents: i64, usual_cents: i64, history_count: usize, min_history: usize) -> bool {
    history_count >= min_history
        && usual_cents > 0
        && total_cents > usual_cents.saturating_mul(UNUSUAL_FACTOR)
        && total_cents - usual_cents >= UNUSUAL_MIN_GAP_CENTS
}

pub(crate) fn evaluate_payment(candidate: &Candidate, history: &SupplierHistory) -> Vec<Finding> {
    let mut findings = Vec::new();
    if let Some(current) = candidate.iban.as_deref().map(normalize_iban).filter(|iban| !iban.is_empty()) {
        findings.extend(iban_change(&current, history));
    }
    if history.payments.is_empty() && history.paid_ibans.is_empty() {
        findings.push(Finding::NewSupplier);
    }
    findings.extend(duplicates(candidate, history));
    let (usual, count) = usual_total(&candidate.invoice_id, candidate.document_date, history);
    if let Some(usual_cents) = usual.filter(|usual| is_unusual_total(candidate.total_cents, *usual, count, UNUSUAL_MIN_HISTORY)) {
        findings.push(Finding::UnusualAmount { usual_cents, history_count: count });
    }
    findings
}

/// Résumé affiché sur la carte d'alerte, façon « Bill Protection ».
pub(crate) fn supplier_summary(candidate_id: &str, history: &SupplierHistory, today: NaiveDate) -> Value {
    let year_ago = today - Duration::days(365);
    let total_12_months: i64 = history.payments.iter().filter(|payment| payment.date > year_ago && payment.date <= today).map(|payment| payment.amount_cents).sum();
    let last = history.payments.iter().max_by_key(|payment| payment.date);
    let (usual, count) = usual_total(candidate_id, today, history);
    let mut ibans: Vec<String> = Vec::new();
    let mut paid = history.paid_ibans.clone();
    paid.sort_by(|left, right| right.paid_on.cmp(&left.paid_on));
    for iban in paid.iter().map(|paid| paid.iban.clone()) {
        if !ibans.contains(&iban) {
            ibans.push(iban);
        }
    }
    json!({
        "paymentCount": history.payments.len(),
        "total12MonthsCents": total_12_months,
        "lastPaymentDate": last.map(|payment| payment.date.to_string()),
        "lastPaymentCents": last.map(|payment| payment.amount_cents),
        "usualCents": usual.filter(|_| count >= 2),
        "invoiceCount": count,
        "paidIbans": ibans.iter().map(|iban| mask_iban(iban)).collect::<Vec<_>>(),
    })
}

/// IBAN réellement écrit dans l'ordre pour ce paiement (bloc CdtTrfTxInf).
pub(crate) fn xml_creditor_iban(xml: &str, end_to_end_id: &str) -> Option<String> {
    let needle = format!("<EndToEndId>{end_to_end_id}</EndToEndId>");
    let at = xml.find(&needle)?;
    let start = xml[..at].rfind("<CdtTrfTxInf>")?;
    let end = at + xml[at..].find("</CdtTrfTxInf>")?;
    let block = &xml[start..end];
    let account = &block[block.find("<CdtrAcct>")?..];
    let open = account.find("<IBAN>")? + "<IBAN>".len();
    let close = open + account[open..].find("</IBAN>")?;
    Some(normalize_iban(&account[open..close]))
}

// ---------------------------------------------------------------------------
// 2. Double validation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Approval {
    pub status: String,
    pub amount_cents: i64,
    pub creditor_iban: String,
    pub prepared_by_user_id: String,
    pub prepared_by_name: String,
    pub prepared_at: String,
    pub approved_by_user_id: Option<String>,
    pub approved_by_name: Option<String>,
    pub approved_at: Option<String>,
}

/// Une entreprise d'une seule personne n'est jamais bloquée : elle garde les alertes.
pub(crate) fn approval_required(settings: &Settings, actor: &Actor, amount_cents: i64) -> bool {
    settings.approval_enabled && !actor.solo && amount_cents >= settings.approval_threshold_cents
}

/// Pourquoi cette personne ne peut pas approuver, ou None si elle le peut.
pub(crate) fn approval_refusal(actor: &Actor, approval: &Approval) -> Option<&'static str> {
    if approval.status == "approved" {
        return Some("Ce paiement est déjà approuvé.");
    }
    if !actor.may_approve() {
        return Some("Seul le propriétaire ou un administrateur peut approuver un paiement.");
    }
    if !actor.solo && approval.prepared_by_user_id == actor.user_id {
        return Some("La personne qui a préparé ce paiement ne peut pas l'approuver seule. Demandez à un autre administrateur.");
    }
    None
}

/// L'approbation vaut pour ce montant au plus, et pour cet IBAN seulement.
pub(crate) fn approval_covers(approval: Option<&Approval>, amount_cents: i64, iban: &str) -> bool {
    approval.is_some_and(|approval| approval.status == "approved" && amount_cents <= approval.amount_cents && normalize_iban(&approval.creditor_iban) == normalize_iban(iban))
}

fn approval_json(approval: Option<&Approval>, settings: &Settings, actor: &Actor, amount_cents: i64, iban: &str) -> Value {
    let covered = approval_covers(approval, amount_cents, iban);
    json!({
        "required": approval_required(settings, actor, amount_cents),
        "covered": covered,
        "status": approval.map(|approval| approval.status.clone()),
        "stale": approval.is_some_and(|approval| approval.status == "approved" && !covered),
        "amountCents": approval.map(|approval| approval.amount_cents),
        "preparedBy": approval.map(|approval| approval.prepared_by_name.clone()),
        "preparedByMe": approval.is_some_and(|approval| approval.prepared_by_user_id == actor.user_id),
        "preparedAt": approval.map(|approval| approval.prepared_at.clone()),
        "approvedBy": approval.and_then(|approval| approval.approved_by_name.clone()),
        "approvedAt": approval.and_then(|approval| approval.approved_at.clone()),
        "refusal": approval.and_then(|approval| approval_refusal(actor, approval)),
    })
}

// ---------------------------------------------------------------------------
// 4. Écriture inhabituelle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EntryLine {
    pub description: String,
    /// Compte de charge, celui par défaut quand la ligne n'en a pas.
    pub account_id: String,
    pub vat_bp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PastEntry {
    pub lines: Vec<EntryLine>,
    pub total_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EntryFinding {
    UnusualAccount { line: usize, description: String, account_id: String },
    UnusualVatRate { line: usize, description: String, vat_bp: i64 },
    UnusualAmount { usual_cents: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EntryReview {
    pub usual_account_id: Option<String>,
    pub usual_vat_bp: Option<i64>,
    pub history_count: usize,
    pub findings: Vec<EntryFinding>,
}

fn dominant<T: Ord + Clone>(values: impl Iterator<Item = T>) -> Option<T> {
    let mut counts = BTreeMap::<T, usize>::new();
    let mut total = 0;
    for value in values {
        *counts.entry(value).or_default() += 1;
        total += 1;
    }
    let (value, count) = counts.into_iter().max_by_key(|(_, count)| *count)?;
    (count * 100 >= total * ENTRY_DOMINANT_PERCENT).then_some(value)
}

/// Compte, taux de TVA et montant comparés aux factures validées du fournisseur.
/// Un compte ou un taux déjà utilisé pour lui n'est jamais signalé.
pub(crate) fn entry_review(lines: &[EntryLine], total_cents: i64, history: &[PastEntry]) -> EntryReview {
    let past_lines = || history.iter().flat_map(|entry| entry.lines.iter());
    let usual_account_id = dominant(past_lines().map(|line| line.account_id.clone()));
    let usual_vat_bp = dominant(past_lines().map(|line| line.vat_bp));
    let mut review = EntryReview { usual_account_id: usual_account_id.clone(), usual_vat_bp, history_count: history.len(), findings: Vec::new() };
    if history.len() < ENTRY_MIN_HISTORY {
        return review;
    }
    let known_accounts: HashSet<&str> = past_lines().map(|line| line.account_id.as_str()).collect();
    let known_rates: HashSet<i64> = past_lines().map(|line| line.vat_bp).collect();
    for (index, line) in lines.iter().enumerate() {
        if usual_account_id.as_ref().is_some_and(|usual| usual != &line.account_id) && !known_accounts.contains(line.account_id.as_str()) {
            review.findings.push(EntryFinding::UnusualAccount { line: index, description: line.description.clone(), account_id: line.account_id.clone() });
        }
        if usual_vat_bp.is_some_and(|usual| usual != line.vat_bp) && !known_rates.contains(&line.vat_bp) {
            review.findings.push(EntryFinding::UnusualVatRate { line: index, description: line.description.clone(), vat_bp: line.vat_bp });
        }
    }
    let mut totals: Vec<i64> = history.iter().map(|entry| entry.total_cents).filter(|total| *total > 0).collect();
    let count = totals.len();
    if let Some(usual_cents) = median(&mut totals).filter(|usual| is_unusual_total(total_cents, *usual, count, ENTRY_MIN_HISTORY)) {
        review.findings.push(EntryFinding::UnusualAmount { usual_cents });
    }
    review
}

// ---------------------------------------------------------------------------
// Lecture en base
// ---------------------------------------------------------------------------

fn table_exists(connection: &Connection, name: &str) -> AppResult<bool> {
    Ok(connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)", [name], |row| row.get(0))?)
}

/// Historique des IBAN (v78), seulement quand les tables d'achat existent :
/// toute vraie base les a, les bases partielles des anciens tests non.
/// La reprise des ordres déjà préparés ne se fait que dans la base de
/// l'appareil (`with_orders`) : dans une copie d'archive, la table porte déjà
/// la garde d'écriture de l'entreprise.
pub(crate) fn migrate_history(connection: &Connection, with_orders: bool) -> AppResult<()> {
    for table in ["suppliers", "supplier_invoices", "supplier_invoice_payment_details", "supplier_payment_orders", "supplier_payment_order_items"] {
        if !table_exists(connection, table)? {
            return Ok(());
        }
    }
    if with_orders {
        connection.execute_batch(crate::schema::MIGRATION_V78_ORDERS_SQL)?;
    }
    connection.execute_batch(crate::schema::MIGRATION_V78_HISTORY_SQL)?;
    Ok(())
}

pub(crate) fn load_settings(connection: &Connection) -> AppResult<Settings> {
    if !table_exists(connection, "payment_safety_settings")? {
        return Ok(Settings::default());
    }
    let row = connection
        .query_row(
            "SELECT approval_enabled,approval_threshold_cents,receipt_reminder_days FROM payment_safety_settings WHERE id=1",
            [],
            |row| Ok(Settings { approval_enabled: row.get(0)?, approval_threshold_cents: row.get(1)?, receipt_reminder_days: row.get(2)? }),
        )
        .optional()?;
    Ok(row.unwrap_or_default())
}

fn settings_json(settings: &Settings) -> Value {
    json!({
        "approvalEnabled": settings.approval_enabled,
        "approvalThresholdCents": settings.approval_threshold_cents,
        "receiptReminderDays": settings.receipt_reminder_days,
    })
}

/// La personne connectée au compte Zentra ; sans compte, l'utilisateur de cet appareil.
pub(crate) fn load_actor(connection: &Connection) -> AppResult<Actor> {
    let identity: Option<(String, String, String)> = if table_exists(connection, "company_local_identity")? {
        connection
            .query_row("SELECT user_id,display_name,role FROM company_local_identity WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .optional()?
    } else {
        None
    };
    let Some((user_id, display_name, role)) = identity else {
        return Ok(Actor { user_id: LOCAL_USER_ID.into(), display_name: LOCAL_USER_NAME.into(), role: "owner".into(), solo: true });
    };
    let members: Option<i64> = if table_exists(connection, "company_local_team_size")? {
        connection.query_row("SELECT members FROM company_local_team_size WHERE id=1", [], |row| row.get(0)).optional()?
    } else {
        None
    };
    // Tant que l'équipe n'a pas été lue, on la suppose à plusieurs : la règle stricte s'applique.
    Ok(Actor { user_id, display_name: if display_name.trim().is_empty() { LOCAL_USER_NAME.into() } else { display_name }, role, solo: members.is_some_and(|members| members <= 1) })
}

#[derive(Debug, Clone)]
struct InvoiceRow {
    id: String,
    supplier_id: String,
    supplier_name: String,
    reference: Option<String>,
    reference_normalized: Option<String>,
    document_date: NaiveDate,
    total_cents: i64,
    balance_cents: i64,
    validated: bool,
    details_iban: Option<String>,
    payment_reference: Option<String>,
    supplier_iban: Option<String>,
}

impl InvoiceRow {
    /// Même règle que l'ordre préparé par l'interface : la QR-facture, sinon la fiche.
    fn payable_iban(&self) -> Option<String> {
        self.details_iban.clone().or_else(|| self.supplier_iban.as_deref().map(normalize_iban)).filter(|iban| !iban.is_empty())
    }

    fn candidate(&self, iban: Option<String>, total_cents: i64) -> Candidate {
        Candidate {
            invoice_id: self.id.clone(),
            total_cents,
            document_date: self.document_date,
            reference_normalized: crate::supplier_invoices::normalize_supplier_reference(self.reference.as_deref()).or_else(|| self.reference_normalized.clone()),
            payment_reference: self.payment_reference.clone(),
            iban,
        }
    }
}

const INVOICE_SELECT: &str = "SELECT invoice.id,invoice.supplier_id,invoice.supplier_name,invoice.reference,invoice.reference_normalized,invoice.document_date,invoice.total_cents,
       MAX(0,invoice.total_cents-invoice.paid_cents-COALESCE(invoice.credited_cents,0)),invoice.status,
       details.creditor_iban,details.reference_type,details.reference,supplier.iban
FROM supplier_invoices invoice
LEFT JOIN supplier_invoice_payment_details details ON details.supplier_invoice_id=invoice.id
LEFT JOIN suppliers supplier ON supplier.id=invoice.supplier_id";

fn invoice_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<InvoiceRow>> {
    let reference_type: Option<String> = row.get(10)?;
    let payment_reference: Option<String> = row.get(11)?;
    let date: String = row.get(5)?;
    let Some(document_date) = parse_date(&date) else { return Ok(None) };
    Ok(Some(InvoiceRow {
        id: row.get(0)?,
        supplier_id: row.get(1)?,
        supplier_name: row.get(2)?,
        reference: row.get(3)?,
        reference_normalized: row.get(4)?,
        document_date,
        total_cents: row.get(6)?,
        balance_cents: row.get(7)?,
        validated: row.get::<_, String>(8)? == "validated",
        details_iban: row.get(9)?,
        payment_reference: payment_reference.filter(|value| !value.is_empty() && matches!(reference_type.as_deref(), Some("QRR" | "SCOR"))),
        supplier_iban: row.get(12)?,
    }))
}

fn load_invoice(connection: &Connection, id: &str) -> AppResult<InvoiceRow> {
    connection
        .query_row(&format!("{INVOICE_SELECT} WHERE invoice.id=?"), [id], invoice_row)
        .optional()?
        .flatten()
        .ok_or_else(|| AppError::NotFound(format!("supplier_invoices/{id}")))
}

fn load_history(connection: &Connection, invoice: &InvoiceRow) -> AppResult<SupplierHistory> {
    let mut history = SupplierHistory::default();
    let mut statement = connection.prepare(&format!(
        "{INVOICE_SELECT} WHERE invoice.supplier_id=?1 OR (?2 IS NOT NULL AND details.reference=?2 AND details.reference_type IN ('QRR','SCOR'))"
    ))?;
    for row in statement.query_map(params![invoice.supplier_id, invoice.payment_reference], invoice_row)? {
        let Some(other) = row? else { continue };
        history.invoices.push(PastInvoice {
            same_supplier: other.supplier_id == invoice.supplier_id,
            reference_normalized: crate::supplier_invoices::normalize_supplier_reference(other.reference.as_deref()).or(other.reference_normalized),
            id: other.id,
            reference: other.reference,
            payment_reference: other.payment_reference,
            creditor_iban: other.details_iban,
            total_cents: other.total_cents,
            document_date: other.document_date,
            validated: other.validated,
        });
    }
    let mut statement = connection.prepare(
        "SELECT payment.date,payment.amount_cents FROM supplier_payments payment
         JOIN supplier_invoices invoice ON invoice.id=payment.supplier_invoice_id WHERE invoice.supplier_id=?",
    )?;
    for row in statement.query_map([&invoice.supplier_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))? {
        let (date, amount_cents) = row?;
        if let Some(date) = parse_date(&date) {
            history.payments.push(PastPayment { date, amount_cents });
        }
    }
    if table_exists(connection, "supplier_payment_order_creditors")? {
        let mut statement = connection.prepare("SELECT creditor_iban,paid_on FROM supplier_payment_order_creditors WHERE supplier_id=?")?;
        for row in statement.query_map([&invoice.supplier_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))? {
            let (iban, paid_on) = row?;
            if let Some(paid_on) = parse_date(&paid_on) {
                history.paid_ibans.push(PaidIban { iban: normalize_iban(&iban), paid_on });
            }
        }
    }
    if table_exists(connection, "company_local_supplier_iban_seen")? {
        let mut statement = connection.prepare("SELECT iban,first_seen_at FROM company_local_supplier_iban_seen WHERE supplier_id=?")?;
        for row in statement.query_map([&invoice.supplier_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))? {
            let (iban, first_seen) = row?;
            if let Some(first_seen) = parse_date(&first_seen) {
                history.seen_ibans.push(SeenIban { iban: normalize_iban(&iban), first_seen });
            }
        }
    }
    Ok(history)
}

fn load_approval(connection: &Connection, id: &str) -> AppResult<Option<Approval>> {
    if !table_exists(connection, "supplier_payment_approvals")? {
        return Ok(None);
    }
    Ok(connection
        .query_row(
            "SELECT status,amount_cents,creditor_iban,prepared_by_user_id,prepared_by_name,prepared_at,approved_by_user_id,approved_by_name,approved_at
             FROM supplier_payment_approvals WHERE supplier_invoice_id=?",
            [id],
            |row| {
                Ok(Approval {
                    status: row.get(0)?,
                    amount_cents: row.get(1)?,
                    creditor_iban: row.get(2)?,
                    prepared_by_user_id: row.get(3)?,
                    prepared_by_name: row.get(4)?,
                    prepared_at: row.get(5)?,
                    approved_by_user_id: row.get(6)?,
                    approved_by_name: row.get(7)?,
                    approved_at: row.get(8)?,
                })
            },
        )
        .optional()?)
}

fn today() -> NaiveDate {
    Local::now().date_naive()
}

fn review_invoice(connection: &Connection, invoice: &InvoiceRow, settings: &Settings, actor: &Actor, today: NaiveDate) -> AppResult<Value> {
    let iban = invoice.payable_iban();
    let history = load_history(connection, invoice)?;
    let findings = evaluate_payment(&invoice.candidate(iban.clone(), invoice.total_cents), &history);
    let approval = load_approval(connection, &invoice.id)?;
    Ok(json!({
        "supplierInvoiceId": invoice.id,
        "supplierId": invoice.supplier_id,
        "amountCents": invoice.balance_cents,
        "creditorIban": iban.as_deref().map(mask_iban),
        "findings": findings.iter().map(Finding::json).collect::<Vec<_>>(),
        "history": supplier_summary(&invoice.id, &history, today),
        "approval": approval_json(approval.as_ref(), settings, actor, invoice.balance_cents, iban.as_deref().unwrap_or_default()),
    }))
}

fn actor_payload(actor: &Actor) -> Value {
    json!({"user_id": actor.user_id, "display_name": actor.display_name, "role": actor.role})
}

// ---------------------------------------------------------------------------
// Contrôle au moment d'écrire l'ordre pain.001
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcknowledgedChecksInput {
    pub supplier_invoice_id: String,
    pub kinds: Vec<String>,
}

pub(crate) struct CheckedPayment {
    supplier_invoice_id: String,
    supplier_id: String,
    creditor_iban: String,
    findings: Vec<Value>,
}

/// Recalcule chaque contrôle sur l'IBAN écrit dans le fichier. Une alerte non
/// confirmée, ou un paiement à approuver qui ne l'est pas, arrête l'ordre.
pub(crate) fn verify_export(
    tx: &Transaction<'_>,
    xml: &str,
    items: &[crate::supplier_payment_orders::SupplierPaymentOrderItemInput],
    acknowledged: &[AcknowledgedChecksInput],
) -> AppResult<Vec<CheckedPayment>> {
    let settings = load_settings(tx)?;
    let actor = load_actor(tx)?;
    let mut checked = Vec::with_capacity(items.len());
    for item in items {
        let invoice = load_invoice(tx, &item.supplier_invoice_id)?;
        let label = invoice.reference.clone().filter(|reference| !reference.trim().is_empty()).unwrap_or_else(|| invoice.supplier_name.clone());
        let file_iban = xml_creditor_iban(xml, &item.end_to_end_id).ok_or_else(|| invalid("Un paiement du fichier n'a pas d'IBAN. Préparez l'ordre à nouveau."))?;
        if invoice.payable_iban().is_some_and(|expected| expected != file_iban) {
            return Err(AppError::Validation(format!("L'IBAN du fichier ne correspond pas à celui de la facture {label}. Préparez l'ordre à nouveau.")));
        }
        let history = load_history(tx, &invoice)?;
        let findings = evaluate_payment(&invoice.candidate(Some(file_iban.clone()), invoice.total_cents), &history);
        let confirmed: HashSet<&str> = acknowledged
            .iter()
            .filter(|ack| ack.supplier_invoice_id == item.supplier_invoice_id)
            .flat_map(|ack| ack.kinds.iter().map(String::as_str))
            .collect();
        if findings.iter().any(|finding| !confirmed.contains(finding.kind())) {
            return Err(AppError::Validation(format!("Une alerte reste à confirmer pour la facture {label}. Vérifiez-la, puis confirmez ou retirez-la du lot.")));
        }
        if approval_required(&settings, &actor, item.amount_cents) && !approval_covers(load_approval(tx, &item.supplier_invoice_id)?.as_ref(), item.amount_cents, &file_iban) {
            return Err(AppError::Validation(format!("Le paiement de la facture {label} doit d'abord être approuvé par une deuxième personne.")));
        }
        checked.push(CheckedPayment {
            supplier_invoice_id: item.supplier_invoice_id.clone(),
            supplier_id: invoice.supplier_id,
            creditor_iban: file_iban,
            findings: findings.iter().map(Finding::json).collect(),
        });
    }
    Ok(checked)
}

/// Garde l'IBAN payé par l'ordre et la trace de chaque alerte confirmée.
pub(crate) fn record_export(tx: &Transaction<'_>, order_id: &str, execution_date: &str, checked: &[CheckedPayment]) -> AppResult<()> {
    let actor = load_actor(tx)?;
    for payment in checked {
        if (15..=34).contains(&payment.creditor_iban.len()) {
            tx.execute(
                "INSERT INTO supplier_payment_order_creditors(payment_order_id,supplier_invoice_id,supplier_id,creditor_iban,paid_on) VALUES(?,?,?,?,?)",
                params![order_id, payment.supplier_invoice_id, payment.supplier_id, payment.creditor_iban, execution_date],
            )?;
        }
        if !payment.findings.is_empty() {
            append_audit(
                tx,
                "supplier_payment_check.acknowledged",
                "supplier_invoice",
                &payment.supplier_invoice_id,
                &json!({"payment_order_id": order_id, "findings": payment.findings, "actor": actor_payload(&actor)}),
            )?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentSafetySettingsInput {
    pub approval_enabled: bool,
    pub approval_threshold_cents: i64,
    pub receipt_reminder_days: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentSafetyAcknowledgementInput {
    pub supplier_invoice_id: String,
    pub context: String,
    pub kinds: Vec<String>,
}

impl LocalStore {
    /// Factures validées à payer, avec leurs contrôles, l'historique du
    /// fournisseur et l'état de la double validation.
    pub fn payment_safety_overview(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let settings = load_settings(&connection)?;
        let actor = load_actor(&connection)?;
        let today = today();
        let mut statement = connection.prepare(&format!(
            "{INVOICE_SELECT} WHERE invoice.status='validated' AND invoice.total_cents-invoice.paid_cents-COALESCE(invoice.credited_cents,0)>0 ORDER BY invoice.due_date,invoice.id"
        ))?;
        let invoices = statement.query_map([], invoice_row)?.collect::<Result<Vec<_>, _>>()?;
        let reviews = invoices
            .into_iter()
            .flatten()
            .map(|invoice| review_invoice(&connection, &invoice, &settings, &actor, today))
            .collect::<AppResult<Vec<_>>>()?;
        Ok(json!({"settings": settings_json(&settings), "actor": actor.json(), "invoices": reviews}))
    }

    pub fn save_payment_safety_settings(&self, input: PaymentSafetySettingsInput) -> AppResult<Value> {
        if !(100..=99_999_999_999).contains(&input.approval_threshold_cents) {
            return Err(invalid("Le montant de la double validation doit être d'au moins CHF 1.00."));
        }
        if !(1..=90).contains(&input.receipt_reminder_days) {
            return Err(invalid("Le délai de relance des justificatifs doit être compris entre 1 et 90 jours."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actor = load_actor(&tx)?;
        if !actor.may_approve() {
            return Err(invalid("Seul le propriétaire ou un administrateur peut changer les règles de paiement."));
        }
        let now = now_iso();
        tx.execute(
            "INSERT INTO payment_safety_settings(id,approval_enabled,approval_threshold_cents,receipt_reminder_days,created_at,updated_at) VALUES(1,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET approval_enabled=excluded.approval_enabled,approval_threshold_cents=excluded.approval_threshold_cents,receipt_reminder_days=excluded.receipt_reminder_days,updated_at=excluded.updated_at",
            params![input.approval_enabled, input.approval_threshold_cents, input.receipt_reminder_days, now, now],
        )?;
        let saved = settings_json(&load_settings(&tx)?);
        append_audit(&tx, "update", "payment_safety_settings", "1", &json!({"settings": saved, "actor": actor_payload(&actor)}))?;
        tx.commit()?;
        Ok(saved)
    }

    /// Nombre de membres lu sur le compte Zentra, gardé sur cet appareil.
    pub fn remember_company_team_size(&self, members: i64) -> AppResult<Value> {
        if !(0..=100_000).contains(&members) {
            return Err(invalid("Nombre de membres invalide."));
        }
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        connection.execute(
            "INSERT INTO company_local_team_size(id,members,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET members=excluded.members,updated_at=excluded.updated_at",
            params![members, now_iso()],
        )?;
        Ok(json!({"members": members}))
    }

    /// Préparé : la personne qui prépare demande l'approbation d'une autre.
    pub fn prepare_supplier_payment(&self, supplier_invoice_id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actor = load_actor(&tx)?;
        let invoice = load_invoice(&tx, supplier_invoice_id)?;
        if !invoice.validated || invoice.balance_cents <= 0 {
            return Err(invalid("Seule une facture fournisseur validée, avec un solde à payer, peut être préparée."));
        }
        let iban = invoice.payable_iban().unwrap_or_default();
        let previous = load_approval(&tx, &invoice.id)?;
        if approval_covers(previous.as_ref(), invoice.balance_cents, &iban) {
            return Ok(json!({"supplierInvoiceId": invoice.id, "status": "approved", "changed": false}));
        }
        let now = now_iso();
        tx.execute(
            "INSERT INTO supplier_payment_approvals(supplier_invoice_id,status,amount_cents,creditor_iban,prepared_by_user_id,prepared_by_name,prepared_at,approved_by_user_id,approved_by_name,approved_at,updated_at)
             VALUES(?,'prepared',?,?,?,?,?,NULL,NULL,NULL,?)
             ON CONFLICT(supplier_invoice_id) DO UPDATE SET status='prepared',amount_cents=excluded.amount_cents,creditor_iban=excluded.creditor_iban,
               prepared_by_user_id=excluded.prepared_by_user_id,prepared_by_name=excluded.prepared_by_name,prepared_at=excluded.prepared_at,
               approved_by_user_id=NULL,approved_by_name=NULL,approved_at=NULL,updated_at=excluded.updated_at",
            params![invoice.id, invoice.balance_cents, iban, actor.user_id, actor.display_name, now, now],
        )?;
        append_audit(
            &tx,
            "supplier_payment.prepared",
            "supplier_invoice",
            &invoice.id,
            &json!({"amount_cents": invoice.balance_cents, "creditor_iban": mask_iban(&iban), "previous_status": previous.map(|approval| approval.status), "actor": actor_payload(&actor)}),
        )?;
        tx.commit()?;
        Ok(json!({"supplierInvoiceId": invoice.id, "status": "prepared", "changed": true}))
    }

    pub fn approve_supplier_payment(&self, supplier_invoice_id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actor = load_actor(&tx)?;
        let invoice = load_invoice(&tx, supplier_invoice_id)?;
        let approval = load_approval(&tx, &invoice.id)?.ok_or_else(|| invalid("Préparez d'abord ce paiement."))?;
        if let Some(reason) = approval_refusal(&actor, &approval) {
            return Err(invalid(reason));
        }
        let iban = invoice.payable_iban().unwrap_or_default();
        if invoice.balance_cents > approval.amount_cents || normalize_iban(&approval.creditor_iban) != iban {
            return Err(invalid("Le montant ou l'IBAN a changé depuis la préparation. Préparez le paiement à nouveau."));
        }
        let now = now_iso();
        tx.execute(
            "UPDATE supplier_payment_approvals SET status='approved',approved_by_user_id=?,approved_by_name=?,approved_at=?,updated_at=? WHERE supplier_invoice_id=? AND status='prepared'",
            params![actor.user_id, actor.display_name, now, now, invoice.id],
        )?;
        append_audit(
            &tx,
            "supplier_payment.approved",
            "supplier_invoice",
            &invoice.id,
            &json!({"amount_cents": approval.amount_cents, "creditor_iban": mask_iban(&iban), "prepared_by": approval.prepared_by_name, "actor": actor_payload(&actor)}),
        )?;
        tx.commit()?;
        Ok(json!({"supplierInvoiceId": invoice.id, "status": "approved"}))
    }

    /// Annuler une approbation : le paiement redevient « préparé ».
    pub fn revoke_supplier_payment_approval(&self, supplier_invoice_id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actor = load_actor(&tx)?;
        let approval = load_approval(&tx, supplier_invoice_id)?.filter(|approval| approval.status == "approved").ok_or_else(|| invalid("Ce paiement n'est pas approuvé."))?;
        if !actor.may_approve() && approval.approved_by_user_id.as_deref() != Some(actor.user_id.as_str()) {
            return Err(invalid("Seul le propriétaire ou un administrateur peut annuler une approbation."));
        }
        tx.execute(
            "UPDATE supplier_payment_approvals SET status='prepared',approved_by_user_id=NULL,approved_by_name=NULL,approved_at=NULL,updated_at=? WHERE supplier_invoice_id=?",
            params![now_iso(), supplier_invoice_id],
        )?;
        append_audit(&tx, "supplier_payment.approval_revoked", "supplier_invoice", supplier_invoice_id, &json!({"approved_by": approval.approved_by_name, "actor": actor_payload(&actor)}))?;
        tx.commit()?;
        Ok(json!({"supplierInvoiceId": supplier_invoice_id, "status": "prepared"}))
    }

    /// Retirer une préparation pas encore approuvée.
    pub fn withdraw_supplier_payment_preparation(&self, supplier_invoice_id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actor = load_actor(&tx)?;
        let approval = load_approval(&tx, supplier_invoice_id)?.filter(|approval| approval.status == "prepared").ok_or_else(|| invalid("Ce paiement n'est pas en attente d'approbation."))?;
        if !actor.may_approve() && approval.prepared_by_user_id != actor.user_id {
            return Err(invalid("Seule la personne qui a préparé ce paiement, ou un administrateur, peut le retirer."));
        }
        tx.execute("DELETE FROM supplier_payment_approvals WHERE supplier_invoice_id=? AND status='prepared'", [supplier_invoice_id])?;
        append_audit(&tx, "supplier_payment.preparation_withdrawn", "supplier_invoice", supplier_invoice_id, &json!({"prepared_by": approval.prepared_by_name, "actor": actor_payload(&actor)}))?;
        tx.commit()?;
        Ok(json!({"supplierInvoiceId": supplier_invoice_id, "status": null}))
    }

    /// Compte, taux de TVA et montant d'une facture comparés à l'habitude du fournisseur.
    pub fn review_supplier_invoice_entry(&self, supplier_invoice_id: &str) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let invoice = load_invoice(&connection, supplier_invoice_id)?;
        let default_account: String = connection
            .query_row("SELECT COALESCE(expense_account_id,'') FROM accounting_settings WHERE id=1", [], |row| row.get(0))
            .optional()?
            .unwrap_or_default();
        let lines_of = |invoice_id: &str| -> AppResult<Vec<EntryLine>> {
            let mut statement = connection.prepare(
                "SELECT description,COALESCE(posted_expense_account_id,expense_account_id,?2,''),vat_bp FROM supplier_invoice_items WHERE supplier_invoice_id=?1 ORDER BY position,id",
            )?;
            let rows = statement
                .query_map(params![invoice_id, default_account], |row| Ok(EntryLine { description: row.get(0)?, account_id: row.get(1)?, vat_bp: row.get(2)? }))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        };
        let lines = lines_of(&invoice.id)?;
        let mut statement = connection.prepare(
            "SELECT id,total_cents FROM supplier_invoices WHERE supplier_id=? AND id<>? AND status='validated' ORDER BY document_date DESC,id LIMIT 50",
        )?;
        let past = statement
            .query_map(params![invoice.supplier_id, invoice.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let history = past
            .iter()
            .map(|(id, total_cents)| Ok(PastEntry { lines: lines_of(id)?, total_cents: *total_cents }))
            .collect::<AppResult<Vec<_>>>()?;
        let review = entry_review(&lines, invoice.total_cents, &history);
        let mut labels = HashMap::<String, String>::new();
        let mut accounts = connection.prepare("SELECT id,code,name FROM accounts")?;
        for row in accounts.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))? {
            let (id, code, name) = row?;
            labels.insert(id, format!("{code} {name}"));
        }
        let label = |id: &str| labels.get(id).cloned();
        let findings = review
            .findings
            .iter()
            .map(|finding| match finding {
                EntryFinding::UnusualAccount { line, description, account_id } => json!({"kind": "unusual_account", "line": line, "description": description, "account": label(account_id.as_str())}),
                EntryFinding::UnusualVatRate { line, description, vat_bp } => json!({"kind": "unusual_vat_rate", "line": line, "description": description, "vatBp": vat_bp}),
                EntryFinding::UnusualAmount { usual_cents } => json!({"kind": "unusual_amount", "usualCents": usual_cents, "factor": UNUSUAL_FACTOR}),
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "supplierInvoiceId": invoice.id,
            "supplierName": invoice.supplier_name,
            "historyCount": review.history_count,
            "usualAccount": review.usual_account_id.as_deref().and_then(label),
            "usualVatBp": review.usual_vat_bp,
            "findings": findings,
        }))
    }

    /// Une alerte confirmée en connaissance de cause reste dans le journal d'audit.
    pub fn record_payment_safety_acknowledgement(&self, input: PaymentSafetyAcknowledgementInput) -> AppResult<Value> {
        if !matches!(input.context.as_str(), "entry" | "payment") || input.kinds.is_empty() || input.kinds.len() > 10 {
            return Err(invalid("Confirmation invalide."));
        }
        let known = ["iban_changed", "new_supplier", "possible_duplicate", "unusual_amount", "unusual_account", "unusual_vat_rate"];
        if input.kinds.iter().any(|kind| !known.contains(&kind.as_str())) {
            return Err(invalid("Contrôle inconnu."));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actor = load_actor(&tx)?;
        load_invoice(&tx, &input.supplier_invoice_id)?;
        append_audit(
            &tx,
            "payment_safety.acknowledged",
            "supplier_invoice",
            &input.supplier_invoice_id,
            &json!({"context": input.context, "kinds": input.kinds, "actor": actor_payload(&actor)}),
        )?;
        tx.commit()?;
        Ok(json!({"recorded": true}))
    }
}

#[tauri::command]
pub fn payment_safety_overview(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.payment_safety_overview().map_err(command_error)
}

#[tauri::command]
pub fn save_payment_safety_settings(state: tauri::State<'_, LocalStore>, input: PaymentSafetySettingsInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.save_payment_safety_settings(input).map_err(command_error)
}

#[tauri::command]
pub fn remember_company_team_size(state: tauri::State<'_, LocalStore>, members: i64) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.remember_company_team_size(members).map_err(command_error)
}

#[tauri::command]
pub fn prepare_supplier_payment(state: tauri::State<'_, LocalStore>, supplier_invoice_id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.prepare_supplier_payment(&supplier_invoice_id).map_err(command_error)
}

#[tauri::command]
pub fn approve_supplier_payment(state: tauri::State<'_, LocalStore>, supplier_invoice_id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.approve_supplier_payment(&supplier_invoice_id).map_err(command_error)
}

#[tauri::command]
pub fn revoke_supplier_payment_approval(state: tauri::State<'_, LocalStore>, supplier_invoice_id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.revoke_supplier_payment_approval(&supplier_invoice_id).map_err(command_error)
}

#[tauri::command]
pub fn withdraw_supplier_payment_preparation(state: tauri::State<'_, LocalStore>, supplier_invoice_id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.withdraw_supplier_payment_preparation(&supplier_invoice_id).map_err(command_error)
}

#[tauri::command]
pub fn review_supplier_invoice_entry(state: tauri::State<'_, LocalStore>, supplier_invoice_id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.review_supplier_invoice_entry(&supplier_invoice_id).map_err(command_error)
}

#[tauri::command]
pub fn record_payment_safety_acknowledgement(state: tauri::State<'_, LocalStore>, input: PaymentSafetyAcknowledgementInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.record_payment_safety_acknowledgement(input).map_err(command_error)
}

#[cfg(test)]
#[path = "payment_safety_tests.rs"]
mod tests;
