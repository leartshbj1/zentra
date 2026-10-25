//! Situations SIA 118 cumulées depuis un devis accepté.
//!
//! Chaque situation reprend l'avancement cumulé de chaque position (en % ou
//! en quantité), calcule les travaux exécutés à ce jour, retient la garantie
//! sur ce cumul, puis facture seulement la différence avec la situation
//! précédente. La facture créée est une vraie facture brouillon : une ligne
//! par position avancée, une ligne de retenue par taux de TVA et, si demandé,
//! une ligne d'arrondi au 5 centimes. L'arrondi est reporté d'une situation à
//! l'autre, si bien que le cumul facturé reste au plus près du cumul exact.
//! Le décompte final reprend les quantités finales ; la retenue est ensuite
//! libérée par une facture à part (ou tout de suite si une garantie la
//! remplace). `desktop/src/progressBilling.ts` refait le même calcul pour
//! l'aperçu.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, recompute_all_invoice_lines, recompute_invoice, LocalStore},
    error::{command_error, AppError, AppResult},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// Arrondi d'un montant à un taux en points de base, demi vers l'extérieur
/// (même règle que les lignes de document).
pub fn round_bp(value: i64, basis_points: i64) -> i64 {
    let sign = if value < 0 { -1_i128 } else { 1_i128 };
    let absolute = i128::from(value).abs();
    (sign * ((absolute * i128::from(basis_points) + 5_000) / 10_000)) as i64
}

/// Arrondi commercial suisse au 5 centimes (2 vers le bas, 3 vers le haut).
pub fn round_five(cents: i64) -> i64 {
    let remainder = cents.rem_euclid(5);
    if remainder < 3 {
        cents - remainder
    } else {
        cents + (5 - remainder)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuoteLine {
    pub id: String,
    pub position: i64,
    pub description: String,
    pub quantity: f64,
    pub unit: String,
    pub unit_price_cents: i64,
    pub discount_bp: i64,
    pub vat_bp: i64,
}

impl QuoteLine {
    fn base_cents(&self, quantity: f64) -> AppResult<i64> {
        let base = quantity * self.unit_price_cents as f64;
        if !base.is_finite() || base.abs() > 1e15 {
            return Err(invalid("Une position dépasse la capacité de calcul en centimes."));
        }
        Ok(base.round() as i64)
    }

    fn net_of_base(&self, base: i64) -> i64 {
        base - round_bp(base, self.discount_bp)
    }

    /// Montant net de la position au devis (identique à la ligne enregistrée).
    pub fn contract_net_cents(&self) -> AppResult<i64> {
        Ok(self.net_of_base(self.base_cents(self.quantity)?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Progress {
    /// Avancement cumulé en points de base (10 000 = 100 %).
    Percent(i64),
    /// Quantité cumulée exécutée (métré de situation ou décompte final).
    Quantity(f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct LineProgress {
    pub quote_item_id: String,
    pub progress: Progress,
    pub cumulative_quantity: f64,
    pub cumulative_net_cents: i64,
}

/// Travaux exécutés cumulés d'une position. En pour cent, la base exacte du
/// devis est proratisée, si bien que 100 % redonne le montant du devis au
/// centime ; en quantité, le calcul est celui d'une ligne ordinaire.
pub fn line_progress(line: &QuoteLine, progress: Progress) -> AppResult<LineProgress> {
    match progress {
        Progress::Percent(percent) => {
            if !(0..=10_000).contains(&percent) {
                return Err(invalid("L'avancement d'une position est compris entre 0 et 100 %. Au-delà, saisissez la quantité exécutée."));
            }
            let base = round_bp(line.base_cents(line.quantity)?, percent);
            let quantity = (line.quantity * percent as f64 / 10_000.0 * 1_000.0).round() / 1_000.0;
            Ok(LineProgress { quote_item_id: line.id.clone(), progress, cumulative_quantity: quantity, cumulative_net_cents: line.net_of_base(base) })
        }
        Progress::Quantity(quantity) => {
            if !quantity.is_finite() || !(0.0..=1_000_000_000.0).contains(&quantity) {
                return Err(invalid("La quantité exécutée d'une position doit être positive."));
            }
            let quantity = (quantity * 1_000.0).round() / 1_000.0;
            let base = line.base_cents(quantity)?;
            Ok(LineProgress { quote_item_id: line.id.clone(), progress, cumulative_quantity: quantity, cumulative_net_cents: line.net_of_base(base) })
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BillKind {
    Situation,
    Final,
    RetentionRelease,
}

impl BillKind {
    pub fn parse(value: &str) -> AppResult<Self> {
        match value {
            "situation" => Ok(Self::Situation),
            "final" => Ok(Self::Final),
            "retention_release" => Ok(Self::RetentionRelease),
            _ => Err(invalid("Le type de situation est inconnu.")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Situation => "situation",
            Self::Final => "final",
            Self::RetentionRelease => "retention_release",
        }
    }
}

/// État cumulé laissé par la dernière situation valable.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PreviousState {
    pub sequence: i64,
    pub line_net: BTreeMap<String, i64>,
    pub retention_by_rate: BTreeMap<i64, i64>,
    /// Somme des arrondis déjà facturés (toujours entre -2 et +2 centimes).
    pub rounding_cents: i64,
    /// Somme des montants nets déjà facturés, arrondis compris.
    pub billed_net_cents: i64,
    pub final_billed: bool,
    pub retention_released: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InvoiceLine {
    pub description: String,
    pub unit: String,
    pub unit_price_cents: i64,
    pub vat_bp: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Computation {
    pub lines: Vec<LineProgress>,
    pub invoice_lines: Vec<InvoiceLine>,
    pub cumulative_net_cents: i64,
    pub retention_by_rate: BTreeMap<i64, i64>,
    pub cumulative_retention_cents: i64,
    pub previous_net_cents: i64,
    /// Net de cette facture avant arrondi.
    pub net_cents: i64,
    pub vat_cents: i64,
    pub exact_total_cents: i64,
    pub rounding_cents: i64,
    pub total_cents: i64,
}

fn percent_label(basis_points: i64) -> String {
    let whole = basis_points / 100;
    let decimals = basis_points % 100;
    if decimals == 0 {
        format!("{whole}")
    } else if decimals % 10 == 0 {
        format!("{whole},{}", decimals / 10)
    } else {
        format!("{whole},{decimals:02}")
    }
}

fn quantity_label(quantity: f64) -> String {
    crate::measurement::format_milli((quantity * 1_000.0).round() as i64)
}

/// Calcule une situation, le décompte final ou la libération de la retenue.
pub fn compute(
    kind: BillKind,
    quote_lines: &[QuoteLine],
    requested: &BTreeMap<String, Progress>,
    retention_bp: i64,
    release_retention: bool,
    round_to_five: bool,
    previous: &PreviousState,
) -> AppResult<Computation> {
    if !(0..=3_000).contains(&retention_bp) {
        return Err(invalid("La retenue de garantie est comprise entre 0 et 30 %."));
    }
    if previous.retention_released {
        return Err(invalid("La retenue de garantie de ce devis est déjà libérée : la facturation est terminée."));
    }
    if previous.final_billed && kind != BillKind::RetentionRelease {
        return Err(invalid("Le décompte final de ce devis est déjà établi."));
    }
    for id in requested.keys() {
        if !quote_lines.iter().any(|line| &line.id == id) {
            return Err(invalid("Une position de la situation n'existe pas dans le devis."));
        }
    }
    let mut lines = Vec::new();
    let mut invoice_lines = Vec::new();
    let mut works_by_rate: BTreeMap<i64, i64> = BTreeMap::new();
    let retention_by_rate: BTreeMap<i64, i64>;
    match kind {
        BillKind::RetentionRelease => {
            if !previous.final_billed {
                return Err(invalid("La retenue se libère après le décompte final."));
            }
            if previous.retention_by_rate.values().all(|amount| *amount == 0) {
                return Err(invalid("Aucune retenue de garantie n'est à libérer."));
            }
            for (rate, amount) in &previous.retention_by_rate {
                if *amount != 0 {
                    invoice_lines.push(InvoiceLine {
                        description: "Libération de la retenue de garantie".into(),
                        unit: "forfait".into(),
                        unit_price_cents: *amount,
                        vat_bp: *rate,
                    });
                }
            }
            retention_by_rate = previous.retention_by_rate.keys().map(|rate| (*rate, 0)).collect();
            for line in quote_lines {
                let net = previous.line_net.get(&line.id).copied().unwrap_or(0);
                *works_by_rate.entry(line.vat_bp).or_insert(0) += net;
            }
        }
        BillKind::Situation | BillKind::Final => {
            for line in quote_lines {
                let progress = match requested.get(&line.id) {
                    Some(progress) => *progress,
                    // Décompte final : une position non saisie est réputée achevée selon le devis.
                    None if kind == BillKind::Final => Progress::Quantity(line.quantity),
                    // Situation : une position non saisie garde son avancement précédent.
                    None => {
                        let net = previous.line_net.get(&line.id).copied().unwrap_or(0);
                        *works_by_rate.entry(line.vat_bp).or_insert(0) += net;
                        continue;
                    }
                };
                let computed = line_progress(line, progress)?;
                let before = previous.line_net.get(&line.id).copied().unwrap_or(0);
                let increment = computed.cumulative_net_cents - before;
                *works_by_rate.entry(line.vat_bp).or_insert(0) += computed.cumulative_net_cents;
                if increment != 0 {
                    let progress_text = match progress {
                        Progress::Percent(percent) => format!("cumul {} %", percent_label(percent)),
                        Progress::Quantity(_) => format!("cumul {} {} sur {}", quantity_label(computed.cumulative_quantity), line.unit, quantity_label(line.quantity)),
                    };
                    invoice_lines.push(InvoiceLine {
                        description: format!("{} — {progress_text}", line.description.trim()),
                        unit: "situation".into(),
                        unit_price_cents: increment,
                        vat_bp: line.vat_bp,
                    });
                }
                lines.push(computed);
            }
            let keep = !(kind == BillKind::Final && release_retention);
            retention_by_rate = works_by_rate
                .iter()
                .map(|(rate, works)| (*rate, if keep { round_bp(*works, retention_bp) } else { 0 }))
                .collect();
            let mut rates: Vec<i64> = retention_by_rate.keys().chain(previous.retention_by_rate.keys()).copied().collect();
            rates.sort_unstable();
            rates.dedup();
            for rate in rates {
                let now = retention_by_rate.get(&rate).copied().unwrap_or(0);
                let before = previous.retention_by_rate.get(&rate).copied().unwrap_or(0);
                if now != before {
                    let description = if now == 0 {
                        "Retenue de garantie libérée (garantie fournie)".to_owned()
                    } else {
                        format!("Retenue de garantie {} % sur les travaux exécutés", percent_label(retention_bp))
                    };
                    invoice_lines.push(InvoiceLine { description, unit: "forfait".into(), unit_price_cents: -(now - before), vat_bp: rate });
                }
            }
        }
    }
    let cumulative_net_cents: i64 = works_by_rate.values().sum();
    let cumulative_retention_cents: i64 = retention_by_rate.values().sum();
    let net_cents: i64 = invoice_lines.iter().map(|line| line.unit_price_cents).sum();
    let vat_cents: i64 = invoice_lines.iter().map(|line| round_bp(line.unit_price_cents, line.vat_bp)).sum();
    let exact_total_cents = net_cents + vat_cents;
    if invoice_lines.is_empty() || exact_total_cents == 0 {
        return Err(invalid("Rien de nouveau à facturer depuis la situation précédente."));
    }
    if exact_total_cents < 0 {
        return Err(invalid("L'avancement saisi est inférieur à la situation précédente. Corrigez par un avoir."));
    }
    // Le total de chaque facture tombe sur 5 centimes ; l'écart d'arrondi des
    // factures précédentes est repris ici, si bien que le cumul reste exact.
    let rounding_cents = if round_to_five {
        round_five(exact_total_cents - previous.rounding_cents) - exact_total_cents
    } else {
        0
    };
    if rounding_cents != 0 {
        // L'arrondi suit le taux principal ; sur quelques centimes sa TVA est nulle.
        let main_rate = works_by_rate.iter().max_by_key(|(_, works)| **works).map(|(rate, _)| *rate).unwrap_or(0);
        let rate = if round_bp(rounding_cents, main_rate) == 0 { main_rate } else { 0 };
        invoice_lines.push(InvoiceLine { description: "Arrondi au 5 centimes".into(), unit: "arrondi".into(), unit_price_cents: rounding_cents, vat_bp: rate });
    }
    Ok(Computation {
        lines,
        invoice_lines,
        cumulative_net_cents,
        cumulative_retention_cents,
        retention_by_rate,
        previous_net_cents: previous.billed_net_cents,
        net_cents,
        vat_cents,
        exact_total_cents,
        rounding_cents,
        total_cents: exact_total_cents + rounding_cents,
    })
}

/// Montant suisse « 12'345.60 » pour le décompte imprimé.
fn money(cents: i64) -> String {
    let negative = cents < 0;
    let absolute = cents.unsigned_abs();
    let francs = (absolute / 100).to_string();
    let mut grouped = String::new();
    for (index, digit) in francs.chars().enumerate() {
        if index > 0 && (francs.len() - index) % 3 == 0 {
            grouped.push('\'');
        }
        grouped.push(digit);
    }
    format!("{}{grouped}.{:02}", if negative { "-" } else { "" }, absolute % 100)
}

fn swiss_date(date: &str) -> String {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").map(|value| value.format("%d.%m.%Y").to_string()).unwrap_or_else(|_| date.to_owned())
}

/// Décompte imprimé dans les remarques de la facture (figé à l'émission).
pub fn recap_text(kind: BillKind, sequence: i64, progress_date: &str, retention_bp: i64, currency: &str, computation: &Computation) -> String {
    let title = match kind {
        BillKind::Situation => format!("Décompte de la situation n° {sequence} (avancement au {})", swiss_date(progress_date)),
        BillKind::Final => format!("Décompte final (situation n° {sequence}, au {})", swiss_date(progress_date)),
        BillKind::RetentionRelease => format!("Libération de la retenue de garantie (au {})", swiss_date(progress_date)),
    };
    let mut rows = vec![
        title,
        format!("Travaux exécutés à ce jour (HT) : {currency} {}", money(computation.cumulative_net_cents)),
    ];
    if computation.cumulative_retention_cents != 0 {
        rows.push(format!("Retenue de garantie {} % : -{currency} {}", percent_label(retention_bp), money(computation.cumulative_retention_cents)));
    }
    if computation.previous_net_cents != 0 {
        rows.push(format!("Déjà facturé (HT) : -{currency} {}", money(computation.previous_net_cents)));
    }
    rows.push(format!("Montant de cette facture (HT) : {currency} {}", money(computation.net_cents + computation.rounding_cents)));
    rows.join("\n")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressLineInput {
    pub quote_item_id: String,
    /// « percent » ou « quantity ».
    pub mode: String,
    #[serde(default)]
    pub cumulative_percent_bp: Option<i64>,
    #[serde(default)]
    pub cumulative_quantity: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressBillInput {
    pub quote_id: String,
    pub kind: String,
    pub progress_date: String,
    pub retention_bp: i64,
    pub round_to_five: bool,
    #[serde(default)]
    pub release_retention: bool,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub lines: Vec<ProgressLineInput>,
}

fn requested_progress(lines: &[ProgressLineInput]) -> AppResult<BTreeMap<String, Progress>> {
    if lines.len() > 500 {
        return Err(invalid("La situation contient trop de positions."));
    }
    let mut requested = BTreeMap::new();
    for line in lines {
        let progress = match line.mode.as_str() {
            "percent" => Progress::Percent(line.cumulative_percent_bp.ok_or_else(|| invalid("Saisissez l'avancement en pour cent."))?),
            "quantity" => Progress::Quantity(line.cumulative_quantity.ok_or_else(|| invalid("Saisissez la quantité exécutée."))?),
            _ => return Err(invalid("Le mode d'avancement est inconnu.")),
        };
        if requested.insert(line.quote_item_id.clone(), progress).is_some() {
            return Err(invalid("Une position apparaît deux fois dans la situation."));
        }
    }
    Ok(requested)
}

fn load_quote_lines(tx: &Transaction<'_>, quote_id: &str) -> AppResult<Vec<QuoteLine>> {
    let mut statement = tx.prepare(
        "SELECT id,position,description,quantity,unit,COALESCE(unit_price_cents,0),COALESCE(discount_bp,0),COALESCE(vat_bp,0)
           FROM quote_items WHERE quote_id=? ORDER BY position,rowid",
    )?;
    let rows = statement.query_map([quote_id], |row| {
        Ok(QuoteLine {
            id: row.get(0)?,
            position: row.get(1)?,
            description: row.get(2)?,
            quantity: row.get(3)?,
            unit: row.get(4)?,
            unit_price_cents: row.get(5)?,
            discount_bp: row.get(6)?,
            vat_bp: row.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// État laissé par les situations valables (factures non annulées) du devis.
pub fn previous_state(tx: &Transaction<'_>, quote_id: &str) -> AppResult<PreviousState> {
    let mut state = PreviousState::default();
    let mut statement = tx.prepare(
        "SELECT b.id,b.sequence,b.kind,b.cumulative_net_cents,b.retention_by_rate_json,b.exact_total_cents,b.rounding_cents,b.net_cents,i.number
           FROM progress_bills b JOIN invoices i ON i.id=b.invoice_id
          WHERE b.quote_id=? AND i.status<>'annulee' ORDER BY b.sequence",
    )?;
    let bills = statement
        .query_map([quote_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, sequence, kind, cumulative, retention_json, exact, rounding, net, number) in bills {
        if number.as_deref().is_none_or(str::is_empty) {
            return Err(invalid(format!("La situation n° {sequence} est encore un brouillon : émettez-la ou supprimez-la avant d'en préparer une autre.")));
        }
        state.sequence = sequence;
        let _ = exact;
        state.rounding_cents += rounding;
        state.billed_net_cents += net + rounding;
        let _ = cumulative;
        let retention: BTreeMap<String, i64> = serde_json::from_str(&retention_json)?;
        state.retention_by_rate = retention
            .into_iter()
            .map(|(rate, amount)| rate.parse::<i64>().map(|rate| (rate, amount)).map_err(|_| invalid("Retenue enregistrée invalide.")))
            .collect::<AppResult<_>>()?;
        match kind.as_str() {
            "final" => state.final_billed = true,
            "retention_release" => state.retention_released = true,
            _ => {}
        }
        if kind != "retention_release" {
            let mut lines = tx.prepare("SELECT quote_item_id,cumulative_net_cents FROM progress_bill_lines WHERE bill_id=?")?;
            let values = lines.query_map([&id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
            for value in values {
                let (item, net) = value?;
                state.line_net.insert(item, net);
            }
        }
    }
    // La numérotation continue même après une facture annulée.
    let last: Option<i64> = tx.query_row("SELECT MAX(sequence) FROM progress_bills WHERE quote_id=?", [quote_id], |row| row.get(0))?;
    state.sequence = last.unwrap_or(0);
    Ok(state)
}

/// Une situation se recalcule depuis le devis : ses lignes ne se modifient pas à la main.
pub fn ensure_lines_editable(tx: &Transaction<'_>, invoice_id: &str) -> AppResult<()> {
    let progress: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM progress_bills WHERE invoice_id=?)", [invoice_id], |row| row.get(0))?;
    if progress {
        return Err(invalid("Cette situation est calculée depuis le devis. Pour la changer, supprimez le brouillon puis préparez-la à nouveau."));
    }
    Ok(())
}

/// Vrai si la facture est une situation (lignes négatives de retenue admises).
pub fn is_progress_invoice(tx: &Transaction<'_>, invoice_id: &str) -> AppResult<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM progress_bills WHERE invoice_id=?)", [invoice_id], |row| row.get(0))?)
}

/// Le devis est-il facturé par situations ?
pub fn quote_has_plan(tx: &Transaction<'_>, quote_id: &str) -> AppResult<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM progress_billing_plans WHERE quote_id=?)", [quote_id], |row| row.get(0))?)
}

impl LocalStore {
    /// Prépare la situation, le décompte final ou la libération de la retenue
    /// en facture brouillon. Rien n'est émis : la personne vérifie puis émet.
    pub fn create_progress_bill(&self, input: ProgressBillInput) -> AppResult<Value> {
        let kind = BillKind::parse(input.kind.trim())?;
        let progress_date = NaiveDate::parse_from_str(input.progress_date.trim(), "%Y-%m-%d")
            .map_err(|_| invalid("La date d'avancement doit être au format AAAA-MM-JJ."))?
            .format("%Y-%m-%d")
            .to_string();
        let due_date = match input.due_date.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => Some(
                NaiveDate::parse_from_str(value, "%Y-%m-%d")
                    .map_err(|_| invalid("L'échéance doit être au format AAAA-MM-JJ."))?
                    .format("%Y-%m-%d")
                    .to_string(),
            ),
            None => None,
        };
        let requested = requested_progress(&input.lines)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let quote: Option<(String, Option<String>, Option<String>, String, String, Option<String>)> = tx
            .query_row(
                "SELECT status,client_id,project_id,title,currency,terms FROM quotes WHERE id=?",
                [&input.quote_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .optional()?;
        let (status, client_id, project_id, title, currency, terms) = quote.ok_or_else(|| invalid("Devis introuvable."))?;
        if status != "accepte" {
            return Err(invalid("Seul un devis accepté se facture par situations."));
        }
        let converted: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM quote_conversions WHERE quote_id=?1) OR EXISTS(SELECT 1 FROM quote_invoice_pairs WHERE quote_id=?1)
                 OR EXISTS(SELECT 1 FROM invoices WHERE quote_id=?1 AND status<>'annulee' AND id NOT IN (SELECT invoice_id FROM progress_bills) AND type<>'avoir')",
            [&input.quote_id],
            |row| row.get(0),
        )?;
        if converted {
            return Err(invalid("Ce devis est déjà facturé autrement (facture complète, acompte ou commande)."));
        }
        let quote_lines = load_quote_lines(&tx, &input.quote_id)?;
        if quote_lines.is_empty() {
            return Err(invalid("Le devis ne contient aucune position."));
        }
        let previous = previous_state(&tx, &input.quote_id)?;
        let computation = compute(kind, &quote_lines, &requested, input.retention_bp, input.release_retention, input.round_to_five, &previous)?;
        let now = now_iso();
        tx.execute(
            "INSERT INTO progress_billing_plans(quote_id,retention_bp,round_to_five,created_at,updated_at) VALUES(?,?,?,?,?)
             ON CONFLICT(quote_id) DO UPDATE SET retention_bp=excluded.retention_bp,round_to_five=excluded.round_to_five,updated_at=excluded.updated_at",
            params![input.quote_id, input.retention_bp, input.round_to_five, now, now],
        )?;
        let sequence = previous.sequence + 1;
        let invoice_id = Uuid::new_v4().to_string();
        let (invoice_type, invoice_title) = match kind {
            BillKind::Situation => ("situation", format!("Situation n° {sequence} — {title}")),
            BillKind::Final => ("finale", format!("Décompte final — {title}")),
            BillKind::RetentionRelease => ("standard", format!("Libération de la retenue — {title}")),
        };
        let notes = recap_text(kind, sequence, &progress_date, input.retention_bp, &currency, &computation);
        tx.execute(
            "INSERT INTO invoices(id,client_id,project_id,quote_id,title,type,status,issue_date,due_date,service_date_from,service_date_to,currency,notes,terms,created_at,updated_at)
             VALUES(?,?,?,?,?,?,'brouillon',?,?,?,?,?,?,?,?,?)",
            params![invoice_id, client_id, project_id, input.quote_id, invoice_title, invoice_type, progress_date, due_date, progress_date, progress_date, currency, notes, terms, now, now],
        )?;
        for (index, line) in computation.invoice_lines.iter().enumerate() {
            tx.execute(
                "INSERT INTO invoice_items(id,invoice_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at)
                 VALUES(?,?,NULL,?,?,1,?,?,0,?,0,0,0,?,?)",
                params![Uuid::new_v4().to_string(), invoice_id, index as i64, line.description, line.unit, line.unit_price_cents, line.vat_bp, now, now],
            )?;
        }
        recompute_all_invoice_lines(&tx, &invoice_id)?;
        recompute_invoice(&tx, &invoice_id)?;
        let total: i64 = tx.query_row("SELECT total_cents FROM invoices WHERE id=?", [&invoice_id], |row| row.get(0))?;
        if total != computation.total_cents {
            return Err(invalid("Le total de la situation ne correspond pas au calcul. Rien n'a été créé."));
        }
        let bill_id = Uuid::new_v4().to_string();
        let retention_json = serde_json::to_string(&computation.retention_by_rate.iter().map(|(rate, amount)| (rate.to_string(), *amount)).collect::<BTreeMap<_, _>>())?;
        tx.execute(
            "INSERT INTO progress_bills(id,quote_id,invoice_id,sequence,kind,progress_date,retention_bp,cumulative_net_cents,cumulative_retention_cents,retention_by_rate_json,previous_net_cents,net_cents,exact_total_cents,rounding_cents,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                bill_id,
                input.quote_id,
                invoice_id,
                sequence,
                kind.as_str(),
                progress_date,
                input.retention_bp,
                computation.cumulative_net_cents,
                computation.cumulative_retention_cents,
                retention_json,
                computation.previous_net_cents,
                computation.net_cents,
                computation.exact_total_cents,
                computation.rounding_cents,
                now
            ],
        )?;
        for computed in &computation.lines {
            let line = quote_lines.iter().find(|line| line.id == computed.quote_item_id).ok_or_else(|| invalid("Position introuvable."))?;
            let (mode, percent) = match computed.progress {
                Progress::Percent(percent) => ("percent", Some(percent)),
                Progress::Quantity(_) => ("quantity", None),
            };
            tx.execute(
                "INSERT INTO progress_bill_lines(bill_id,quote_item_id,position,description,unit,contract_quantity,unit_price_cents,discount_bp,vat_bp,mode,cumulative_percent_bp,cumulative_quantity,cumulative_net_cents,previous_net_cents)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    bill_id,
                    line.id,
                    line.position,
                    line.description,
                    line.unit,
                    line.quantity,
                    line.unit_price_cents,
                    line.discount_bp,
                    line.vat_bp,
                    mode,
                    percent,
                    computed.cumulative_quantity,
                    computed.cumulative_net_cents,
                    previous.line_net.get(&line.id).copied().unwrap_or(0)
                ],
            )?;
        }
        // Positions non saisies d'une situation : leur avancement précédent est reporté.
        if kind == BillKind::Situation {
            for line in &quote_lines {
                if computation.lines.iter().any(|computed| computed.quote_item_id == line.id) {
                    continue;
                }
                if previous.line_net.contains_key(&line.id) {
                    tx.execute(
                        "INSERT INTO progress_bill_lines(bill_id,quote_item_id,position,description,unit,contract_quantity,unit_price_cents,discount_bp,vat_bp,mode,cumulative_percent_bp,cumulative_quantity,cumulative_net_cents,previous_net_cents)
                         SELECT ?,quote_item_id,position,description,unit,contract_quantity,unit_price_cents,discount_bp,vat_bp,mode,cumulative_percent_bp,cumulative_quantity,cumulative_net_cents,cumulative_net_cents
                           FROM progress_bill_lines WHERE quote_item_id=? AND bill_id=(SELECT b.id FROM progress_bills b JOIN invoices i ON i.id=b.invoice_id WHERE b.quote_id=? AND i.status<>'annulee' AND b.kind<>'retention_release' AND b.id<>? ORDER BY b.sequence DESC LIMIT 1)",
                        params![bill_id, line.id, input.quote_id, bill_id],
                    )?;
                }
            }
        }
        append_audit(
            &tx,
            "create",
            "progress_bill",
            &bill_id,
            &json!({ "quote_id": input.quote_id, "invoice_id": invoice_id, "sequence": sequence, "kind": kind.as_str(), "total_cents": computation.total_cents }),
        )?;
        tx.commit()?;
        Ok(json!({ "invoiceId": invoice_id, "billId": bill_id, "sequence": sequence, "netCents": computation.net_cents + computation.rounding_cents, "vatCents": computation.vat_cents, "totalCents": computation.total_cents }))
    }
}

#[tauri::command]
pub fn create_progress_bill(state: tauri::State<'_, LocalStore>, input: ProgressBillInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.create_progress_bill(input).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(id: &str, quantity: f64, price: i64, vat: i64) -> QuoteLine {
        QuoteLine { id: id.into(), position: 0, description: format!("Position {id}"), quantity, unit: "m²".into(), unit_price_cents: price, discount_bp: 0, vat_bp: vat }
    }

    fn progress(entries: &[(&str, Progress)]) -> BTreeMap<String, Progress> {
        entries.iter().map(|(id, value)| ((*id).to_owned(), *value)).collect()
    }

    /// Applique une situation calculée à l'état cumulé, comme le ferait l'émission.
    fn advance(previous: &PreviousState, kind: BillKind, computation: &Computation) -> PreviousState {
        let mut next = previous.clone();
        next.sequence += 1;
        for line in &computation.lines {
            next.line_net.insert(line.quote_item_id.clone(), line.cumulative_net_cents);
        }
        next.retention_by_rate = computation.retention_by_rate.clone();
        next.rounding_cents += computation.rounding_cents;
        next.billed_net_cents += computation.net_cents + computation.rounding_cents;
        next.final_billed |= kind == BillKind::Final;
        next.retention_released |= kind == BillKind::RetentionRelease;
        next
    }

    #[test]
    fn swiss_rounding_to_five_centimes() {
        assert_eq!(round_five(1_002), 1_000);
        assert_eq!(round_five(1_003), 1_005);
        assert_eq!(round_five(1_007), 1_005);
        assert_eq!(round_five(1_008), 1_010);
        assert_eq!(round_five(-3), -5);
        assert_eq!(round_bp(10_925, 810), 885);
    }

    #[test]
    fn cumulative_situations_deduct_previous_ones_and_retain_the_guarantee() {
        // Peinture 200 m² à 25.– et plâtrerie forfait 8 000.–, TVA 8,1 %.
        let lines = vec![line("a", 200.0, 2_500, 810), line("b", 1.0, 800_000, 810)];
        let contract: i64 = lines.iter().map(|line| line.contract_net_cents().unwrap()).sum();
        assert_eq!(contract, 1_300_000);
        let start = PreviousState::default();

        let first = compute(BillKind::Situation, &lines, &progress(&[("a", Progress::Percent(4_000)), ("b", Progress::Percent(2_500))]), 1_000, false, true, &start).unwrap();
        // Travaux 2 000 + 2 000 = 4 000.–, retenue 10 % = 400.–
        assert_eq!(first.cumulative_net_cents, 400_000);
        assert_eq!(first.cumulative_retention_cents, 40_000);
        assert_eq!(first.net_cents, 360_000);
        assert_eq!(first.vat_cents, round_bp(200_000, 810) + round_bp(200_000, 810) - round_bp(40_000, 810));
        assert_eq!(first.total_cents % 5, 0);
        let after_first = advance(&start, BillKind::Situation, &first);

        // Situation 2 en quantité pour la peinture (métré 150 m²), « b » inchangé.
        let second = compute(BillKind::Situation, &lines, &progress(&[("a", Progress::Quantity(150.0))]), 1_000, false, true, &after_first).unwrap();
        assert_eq!(second.cumulative_net_cents, 375_000 + 200_000);
        assert_eq!(second.previous_net_cents, 360_000 + first.rounding_cents);
        // Incrément peinture 3 750 − 2 000 = 1 750.–, retenue supplémentaire 175.–
        assert_eq!(second.net_cents, 175_000 - 17_500);
        assert_eq!(second.invoice_lines[0].unit_price_cents, 175_000);
        assert!(second.invoice_lines[0].description.contains("cumul 150 m² sur 200"));
        let after_second = advance(&after_first, BillKind::Situation, &second);

        // Décompte final : tout achevé, la retenue reste (10 % de 13 000.–).
        let last = compute(BillKind::Final, &lines, &BTreeMap::new(), 1_000, false, true, &after_second).unwrap();
        assert_eq!(last.cumulative_net_cents, contract);
        assert_eq!(last.cumulative_retention_cents, 130_000);
        let after_final = advance(&after_second, BillKind::Final, &last);
        let billed_net: i64 = [&first, &second, &last].iter().map(|bill| bill.net_cents).sum();
        assert_eq!(billed_net, contract - 130_000);
        // Chaque facture tombe sur 5 centimes et les arrondis reportés restent sous 3 centimes.
        assert!(after_final.rounding_cents.abs() <= 2);
        assert!([&first, &second, &last].iter().all(|bill| bill.total_cents % 5 == 0));
        let exact: i64 = [&first, &second, &last].iter().map(|bill| bill.exact_total_cents).sum();
        assert_eq!(round_five(exact) - exact, after_final.rounding_cents);
        assert!(compute(BillKind::Situation, &lines, &BTreeMap::new(), 1_000, false, true, &after_final).is_err());

        // Libération de la retenue : 1 300.– HT plus TVA, puis plus rien.
        let release = compute(BillKind::RetentionRelease, &lines, &BTreeMap::new(), 1_000, false, true, &after_final).unwrap();
        assert_eq!(release.net_cents, 130_000);
        assert_eq!(release.cumulative_retention_cents, 0);
        let done = advance(&after_final, BillKind::RetentionRelease, &release);
        let total_net: i64 = [&first, &second, &last, &release].iter().map(|bill| bill.net_cents).sum();
        assert_eq!(total_net, contract);
        assert!(compute(BillKind::RetentionRelease, &lines, &BTreeMap::new(), 1_000, false, true, &done).is_err());
    }

    #[test]
    fn a_bank_guarantee_releases_the_retention_on_the_final_account() {
        let lines = vec![line("a", 10.0, 10_000, 810), line("b", 1.0, 50_000, 0)];
        let first = compute(BillKind::Situation, &lines, &progress(&[("a", Progress::Percent(5_000))]), 500, false, false, &PreviousState::default()).unwrap();
        assert_eq!(first.retention_by_rate.get(&810), Some(&2_500));
        let state = advance(&PreviousState::default(), BillKind::Situation, &first);
        let last = compute(BillKind::Final, &lines, &BTreeMap::new(), 500, true, false, &state).unwrap();
        assert_eq!(last.cumulative_retention_cents, 0);
        assert!(last.invoice_lines.iter().any(|line| line.description.contains("libérée") && line.unit_price_cents == 2_500 && line.vat_bp == 810));
        // Deux taux de TVA : la retenue suit chacun.
        assert_eq!(last.invoice_lines.iter().filter(|line| line.vat_bp == 0).count(), 1);
        assert_eq!(last.rounding_cents, 0);
        let after = advance(&state, BillKind::Final, &last);
        assert!(compute(BillKind::RetentionRelease, &lines, &BTreeMap::new(), 500, false, false, &after).is_err());
    }

    #[test]
    fn invalid_or_backward_progress_is_refused() {
        let lines = vec![line("a", 10.0, 10_000, 810)];
        let start = PreviousState::default();
        assert!(compute(BillKind::Situation, &lines, &progress(&[("a", Progress::Percent(10_001))]), 1_000, false, true, &start).is_err());
        assert!(compute(BillKind::Situation, &lines, &progress(&[("a", Progress::Quantity(-1.0))]), 1_000, false, true, &start).is_err());
        assert!(compute(BillKind::Situation, &lines, &progress(&[("x", Progress::Percent(100))]), 1_000, false, true, &start).is_err());
        assert!(compute(BillKind::Situation, &lines, &progress(&[("a", Progress::Percent(0))]), 1_000, false, true, &start).is_err());
        assert!(compute(BillKind::Situation, &lines, &progress(&[("a", Progress::Percent(5_000))]), 3_001, false, true, &start).is_err());
        assert!(compute(BillKind::RetentionRelease, &lines, &BTreeMap::new(), 1_000, false, true, &start).is_err());
        let first = compute(BillKind::Situation, &lines, &progress(&[("a", Progress::Percent(6_000))]), 1_000, false, true, &start).unwrap();
        let state = advance(&start, BillKind::Situation, &first);
        assert!(compute(BillKind::Situation, &lines, &progress(&[("a", Progress::Percent(4_000))]), 1_000, false, true, &state).is_err());
        // Au-delà du devis : seulement en quantité (plus-value du métré final).
        let beyond = compute(BillKind::Final, &lines, &progress(&[("a", Progress::Quantity(12.0))]), 1_000, false, true, &state).unwrap();
        assert_eq!(beyond.cumulative_net_cents, 120_000);
    }

    #[test]
    fn the_recap_prints_cumulated_work_retention_and_previous_bills() {
        let lines = vec![line("a", 100.0, 1_000, 810)];
        let first = compute(BillKind::Situation, &lines, &progress(&[("a", Progress::Percent(3_000))]), 1_000, false, false, &PreviousState::default()).unwrap();
        let state = advance(&PreviousState::default(), BillKind::Situation, &first);
        let second = compute(BillKind::Situation, &lines, &progress(&[("a", Progress::Percent(7_000))]), 1_000, false, false, &state).unwrap();
        let text = recap_text(BillKind::Situation, 2, "2026-10-25", 1_000, "CHF", &second);
        assert!(text.contains("situation n° 2 (avancement au 25.10.2026)"));
        assert!(text.contains("Travaux exécutés à ce jour (HT) : CHF 700.00"));
        assert!(text.contains("Retenue de garantie 10 % : -CHF 70.00"));
        assert!(text.contains("Déjà facturé (HT) : -CHF 270.00"));
        assert_eq!(money(1_234_567), "12'345.67");
    }
}

#[cfg(test)]
mod store_tests {
    use super::*;
    use crate::models::{ConvertQuoteInput, SaveDocumentWithItemsInput};

    fn accepted_quote(store: &LocalStore) -> (String, Vec<String>) {
        let client = store
            .create_record("clients", json!({"name":"Gérance Dupont","address_line1":"Rue du Rhône","address_line2":"4","postal_code":"1204","city":"Genève","country":"CH"}))
            .unwrap()["id"].as_str().unwrap().to_owned();
        let saved = store.save_document_with_items(SaveDocumentWithItemsInput {
            entity: "quotes".into(),
            id: None,
            data: json!({"client_id":client,"title":"Rénovation cage d'escalier","currency":"CHF","issue_date":"2026-09-01","valid_until":"2026-10-01"}),
            items: vec![
                json!({"description":"Peinture murs","quantity":200,"unit":"m²","unit_price_cents":2_500,"discount_bp":0,"vat_bp":810}),
                json!({"description":"Plâtrerie","quantity":1,"unit":"forfait","unit_price_cents":800_000,"discount_bp":0,"vat_bp":810}),
            ],
        }).unwrap();
        let quote = saved["document"]["id"].as_str().unwrap().to_owned();
        let items = saved["items"].as_array().unwrap().iter().map(|item| item["id"].as_str().unwrap().to_owned()).collect();
        store.issue_quote(&quote, Some("2026-09-01".into()), Some("2026-10-01".into())).unwrap();
        store.update_quote_status(&quote, "accepted").unwrap();
        (quote, items)
    }

    fn input(quote: &str, kind: &str, lines: Vec<ProgressLineInput>) -> ProgressBillInput {
        ProgressBillInput { quote_id: quote.into(), kind: kind.into(), progress_date: "2026-10-25".into(), retention_bp: 1_000, round_to_five: true, release_retention: false, due_date: None, lines }
    }

    fn percent(id: &str, value: i64) -> ProgressLineInput {
        ProgressLineInput { quote_item_id: id.into(), mode: "percent".into(), cumulative_percent_bp: Some(value), cumulative_quantity: None }
    }

    #[test]
    fn situations_become_real_invoices_chained_on_the_quote() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "progress-test").unwrap();
        let (quote, items) = accepted_quote(&store);

        let first = store.create_progress_bill(input(&quote, "situation", vec![percent(&items[0], 4_000), percent(&items[1], 2_500)])).unwrap();
        assert_eq!(first["sequence"], json!(1));
        let first_invoice = first["invoiceId"].as_str().unwrap().to_owned();
        // Un deuxième brouillon est refusé tant que le premier n'est pas émis.
        assert!(store.create_progress_bill(input(&quote, "situation", vec![percent(&items[0], 5_000)])).is_err());
        // Les lignes d'une situation ne se modifient pas à la main.
        assert!(store.save_document_with_items(SaveDocumentWithItemsInput { entity: "invoices".into(), id: Some(first_invoice.clone()), data: json!({"title":"Modifiée"}), items: vec![json!({"description":"x","quantity":1,"unit":"forfait","unit_price_cents":1,"discount_bp":0,"vat_bp":0})] }).is_err());
        // La conversion ordinaire du devis est fermée.
        assert!(store.convert_quote_to_invoice(ConvertQuoteInput { quote_id: quote.clone(), title: None, deposit_percentage_bp: None, issue_date: None, due_date: None, service_date_from: Some("2026-10-01".into()), service_date_to: Some("2026-10-25".into()) }).is_err());
        // La retenue est une ligne négative admise à l'émission.
        store.issue_invoice(&first_invoice, Some("2026-10-25".into()), Some("2026-11-24".into())).unwrap();
        let connection = store.connect().unwrap();
        let (subtotal, total, kind, notes): (i64, i64, String, String) = connection
            .query_row("SELECT subtotal_cents,total_cents,type,notes FROM invoices WHERE id=?", [&first_invoice], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .unwrap();
        assert_eq!(subtotal, 360_000);
        assert_eq!(total, 389_160);
        assert_eq!(kind, "situation");
        assert!(notes.contains("Travaux exécutés à ce jour (HT) : CHF 4'000.00"));
        drop(connection);

        let second = store.create_progress_bill(input(&quote, "situation", vec![ProgressLineInput { quote_item_id: items[0].clone(), mode: "quantity".into(), cumulative_percent_bp: None, cumulative_quantity: Some(150.0) }])).unwrap();
        assert_eq!(second["sequence"], json!(2));
        let second_invoice = second["invoiceId"].as_str().unwrap().to_owned();
        assert_eq!(second["totalCents"].as_i64().unwrap() % 5, 0);
        store.issue_invoice(&second_invoice, Some("2026-11-25".into()), Some("2026-12-25".into())).unwrap();

        let last = store.create_progress_bill(input(&quote, "final", vec![])).unwrap();
        let last_invoice = last["invoiceId"].as_str().unwrap().to_owned();
        store.issue_invoice(&last_invoice, Some("2026-12-20".into()), Some("2027-01-19".into())).unwrap();
        let connection = store.connect().unwrap();
        let billed: i64 = connection.query_row("SELECT SUM(net_cents) FROM progress_bills WHERE quote_id=?", [&quote], |row| row.get(0)).unwrap();
        assert_eq!(billed, 1_300_000 - 130_000);
        let carried: i64 = connection.query_row("SELECT COUNT(*) FROM progress_bill_lines l JOIN progress_bills b ON b.id=l.bill_id WHERE b.invoice_id=?", [&second_invoice], |row| row.get(0)).unwrap();
        assert_eq!(carried, 2, "la plâtrerie non saisie est reportée avec son avancement précédent");
        // Une situation émise est figée.
        assert!(connection.execute("DELETE FROM progress_bills WHERE invoice_id=?", [&first_invoice]).is_err());
        drop(connection);
        assert!(store.create_progress_bill(input(&quote, "situation", vec![percent(&items[0], 10_000)])).is_err());

        let release = store.create_progress_bill(input(&quote, "retention_release", vec![])).unwrap();
        // 1 300.– HT de retenue libérée, à l'arrondi au 5 centimes près.
        assert!((release["netCents"].as_i64().unwrap() - 130_000).abs() <= 4);
        assert_eq!(release["totalCents"].as_i64().unwrap() % 5, 0);
    }
}
