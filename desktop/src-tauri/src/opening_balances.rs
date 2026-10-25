//! Reprise d'ouverture depuis un autre logiciel (bexio, WinBIZ, Crésus,
//! Banana, AbaNinja/Swiss21 ou un fichier Excel) : factures clients encore ouvertes et
//! bilan d'ouverture. Les montants viennent du fichier vérifié par
//! l'utilisateur ; l'app contrôle chaque ligne et passe elle-même les
//! écritures. Une facture reprise n'est jamais un produit ni une TVA de
//! l'exercice : elle est comptabilisée contre le compte 9100.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    accounting::{ensure_accounting_date_open, post_entry, post_invoice_if_enabled, validate_date, EntryLine},
    audit::append_audit,
    database::{build_document_snapshot, now_iso, query_record_tx, recompute_invoice, LocalStore},
    error::{command_error, AppError, AppResult},
};

/// Libellé de la contrepartie d'une créance reprise, sur le compte d'ouverture.
pub(crate) const OPENING_MEMO: &str = "Reprise solde d'ouverture";
const OPENING_ACCOUNT_CODE: &str = "9100";
const OPENING_ACCOUNT_NAME: &str = "Bilan d'ouverture";
const MAX_INVOICES: usize = 5_000;
const MAX_BALANCE_LINES: usize = 500;
/// Un milliard de francs : au-delà, la ligne est certainement mal lue.
const MAX_AMOUNT_CENTS: i64 = 100_000_000_000;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

fn at_line(line: i64, error: AppError) -> AppError {
    let message = match error {
        AppError::Validation(message) => message,
        other => other.to_string(),
    };
    invalid(format!("Ligne {line} : {message}"))
}

fn table_present(connection: &Connection, name: &str) -> AppResult<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
        [name],
        |row| row.get(0),
    )?)
}

/// Vrai pour une facture créée par la reprise d'ouverture (faux sur un schéma
/// antérieur, qui n'a pas encore la table).
pub(crate) fn is_opening_receivable(connection: &Connection, invoice_id: &str) -> AppResult<bool> {
    if !table_present(connection, "opening_receivables")? {
        return Ok(false);
    }
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM opening_receivables WHERE invoice_id=?)",
        [invoice_id],
        |row| row.get(0),
    )?)
}

/// Fragment SQL qui écarte les factures reprises d'une requête sur `alias`.
pub(crate) fn exclusion_clause(connection: &Connection, alias: &str) -> AppResult<String> {
    Ok(if table_present(connection, "opening_receivables")? {
        format!(" AND NOT EXISTS(SELECT 1 FROM opening_receivables opening WHERE opening.invoice_id={alias}.id)")
    } else {
        String::new()
    })
}

/// Encaissements de factures reprises dans la période : leur TVA éventuelle
/// relève du décompte bexio et ne peut pas être reconstituée ici.
pub(crate) fn paid_in_period(connection: &Connection, from: &str, to: &str) -> AppResult<i64> {
    if !table_present(connection, "opening_receivables")? {
        return Ok(0);
    }
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM payments p JOIN opening_receivables o ON o.invoice_id=p.invoice_id WHERE p.date BETWEEN ? AND ?",
        params![from, to],
        |row| row.get(0),
    )?)
}

/// Un avoir sur une facture reprise débiterait un produit qui n'a jamais été
/// comptabilisé dans Zentra : la correction passe par la fiduciaire.
pub(crate) fn refuse_credit_note(connection: &Connection, original_invoice_id: &str) -> AppResult<()> {
    if is_opening_receivable(connection, original_invoice_id)? {
        return Err(invalid(
            "Cette facture vient d'une reprise d'ouverture : elle ne se corrige pas par un avoir. Pour l'annuler ou la réduire, passez une perte sur créance avec votre fiduciaire.",
        ));
    }
    Ok(())
}

/// Compte 9100 « Bilan d'ouverture » : repris s'il existe, créé sinon.
pub(crate) fn opening_account(tx: &Transaction<'_>) -> AppResult<String> {
    let existing: Option<(String, String, i64)> = tx
        .query_row(
            "SELECT id,account_type,active FROM accounts WHERE code=?",
            [OPENING_ACCOUNT_CODE],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((id, kind, active)) = existing {
        if kind != "equity" || active != 1 {
            return Err(invalid(
                "Le compte 9100 existe déjà avec un autre usage ou il est désactivé. Corrigez-le dans Plan & liaisons avant la reprise d'ouverture.",
            ));
        }
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    tx.execute(
        "INSERT INTO accounts(id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at) VALUES(?,?,?,'equity','credit','equity',1,?,?)",
        params![id, OPENING_ACCOUNT_CODE, OPENING_ACCOUNT_NAME, now, now],
    )?;
    Ok(id)
}

/// 123456 → « 1'234.56 », pour les libellés seulement.
fn chf(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let cents = cents.unsigned_abs();
    let digits = (cents / 100).to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push('\'');
        }
        grouped.push(digit);
    }
    format!("{sign}{grouped}.{:02}", cents % 100)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpeningReceivableRow {
    pub line: i64,
    pub number: String,
    pub client_id: String,
    pub issue_date: String,
    pub due_date: String,
    pub open_cents: i64,
    #[serde(default)]
    pub total_cents: Option<i64>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpeningReceivablesInput {
    pub rows: Vec<OpeningReceivableRow>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpeningBalanceLineInput {
    pub line: i64,
    pub code: String,
    #[serde(default)]
    pub name: Option<String>,
    /// Solde dans le sens normal du compte (actif au débit, passif au crédit).
    #[serde(default)]
    pub balance_cents: Option<i64>,
    /// Ou bien les colonnes Débit et Crédit telles qu'exportées.
    #[serde(default)]
    pub debit_cents: Option<i64>,
    #[serde(default)]
    pub credit_cents: Option<i64>,
}

impl OpeningBalanceLineInput {
    /// (débit, crédit) une fois le sens normal du compte connu.
    fn sides(&self, normal_debit: bool) -> AppResult<(i64, i64)> {
        let (debit, credit) = match (self.balance_cents, self.debit_cents, self.credit_cents) {
            (Some(balance), None, None) => {
                let debit_side = normal_debit == (balance > 0);
                if debit_side { (balance.abs(), 0) } else { (0, balance.abs()) }
            }
            (None, debit, credit) if debit.is_some() || credit.is_some() => {
                let (debit, credit) = (debit.unwrap_or(0), credit.unwrap_or(0));
                if debit < 0 || credit < 0 {
                    return Err(invalid("le débit et le crédit doivent être positifs."));
                }
                let net = debit - credit;
                (net.max(0), (-net).max(0))
            }
            _ => return Err(invalid("indiquez soit un solde, soit un débit et un crédit.")),
        };
        if debit > MAX_AMOUNT_CENTS || credit > MAX_AMOUNT_CENTS {
            return Err(invalid("le solde dépasse le montant accepté."));
        }
        Ok((debit, credit))
    }

    fn is_zero(&self) -> bool {
        self.balance_cents.unwrap_or(0) == 0 && self.debit_cents.unwrap_or(0) == self.credit_cents.unwrap_or(0)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpeningBalanceInput {
    pub entry_date: String,
    pub lines: Vec<OpeningBalanceLineInput>,
}

struct PlannedLine {
    line: i64,
    code: String,
    name: String,
    account_id: Option<String>,
    create: Option<(&'static str, &'static str, &'static str)>,
    debit_cents: i64,
    credit_cents: i64,
    note: Option<String>,
}

struct BalancePlan {
    entry_date: String,
    lines: Vec<PlannedLine>,
    receivables_cents: i64,
    difference_cents: i64,
    opening_debit_cents: i64,
    opening_credit_cents: i64,
}

impl BalancePlan {
    fn json(&self) -> Value {
        json!({
            "entry_date": self.entry_date,
            "lines": self.lines.iter().map(|line| json!({
                "line": line.line, "code": line.code, "name": line.name,
                "debit_cents": line.debit_cents, "credit_cents": line.credit_cents,
                "create": line.create.is_some(), "note": line.note,
            })).collect::<Vec<_>>(),
            "opening": { "code": OPENING_ACCOUNT_CODE, "name": OPENING_ACCOUNT_NAME, "debit_cents": self.opening_debit_cents, "credit_cents": self.opening_credit_cents },
            "receivables_cents": self.receivables_cents,
            "difference_cents": self.difference_cents,
            "balanced": self.difference_cents == 0,
        })
    }
}

fn receivable_account(tx: &Transaction<'_>) -> AppResult<Option<String>> {
    Ok(tx
        .query_row("SELECT ar_account_id FROM accounting_settings WHERE id=1 AND enabled=1", [], |row| row.get(0))
        .optional()?
        .flatten())
}

fn plan_opening_balance(tx: &Transaction<'_>, input: &OpeningBalanceInput) -> AppResult<BalancePlan> {
    validate_date(&input.entry_date, "entry_date")?;
    let ar = receivable_account(tx)?.ok_or_else(|| {
        invalid("Activez d'abord la comptabilité dans Comptabilité › Plan & liaisons : le bilan d'ouverture y est passé en une écriture.")
    })?;
    ensure_accounting_date_open(tx, &input.entry_date)?;
    let active: Option<String> = tx
        .query_row(
            "SELECT i.entry_date FROM opening_balance_imports i WHERE i.source='bexio' AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reversal_of=i.journal_entry_id) ORDER BY i.created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(date) = active {
        return Err(invalid(format!(
            "Un bilan d'ouverture a déjà été repris au {date}. Annulez cette reprise (ou extournez son écriture dans le journal) avant d'en reprendre un autre."
        )));
    }
    if input.lines.is_empty() || input.lines.len() > MAX_BALANCE_LINES {
        return Err(invalid("Le bilan doit contenir entre 1 et 500 comptes."));
    }
    let mut seen = HashSet::new();
    let mut lines = Vec::new();
    for row in &input.lines {
        let code = row.code.trim().to_owned();
        if code.is_empty() || code.len() > 10 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(at_line(row.line, invalid("le numéro de compte est illisible.")));
        }
        if code == OPENING_ACCOUNT_CODE {
            return Err(at_line(row.line, invalid("le compte 9100 sert à équilibrer la reprise. Retirez cette ligne.")));
        }
        if !seen.insert(code.clone()) {
            return Err(at_line(row.line, invalid(format!("le compte {code} apparaît deux fois."))));
        }
        if row.is_zero() {
            continue;
        }
        let existing: Option<(String, String, String, String)> = tx
            .query_row(
                "SELECT id,name,account_type,normal_balance FROM accounts WHERE code=? AND active=1",
                [&code],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let (account_id, name, kind, normal, create) = match existing {
            Some((id, name, kind, normal)) => (Some(id), name, kind, normal, None),
            None => {
                let chart = crate::swiss_sme_chart::SWISS_SME_CHART.iter().find(|entry| entry.0 == code);
                match chart {
                    Some(&(_, name, kind, normal, section)) => (None, name.to_owned(), kind.to_owned(), normal.to_owned(), Some((kind, normal, section))),
                    None => {
                        return Err(at_line(row.line, invalid(format!(
                            "le compte {code} n'existe pas dans votre plan comptable. Ajoutez-le dans Plan & liaisons, puis recommencez."
                        ))))
                    }
                }
            }
        };
        if !matches!(kind.as_str(), "asset" | "liability" | "equity") {
            return Err(at_line(row.line, invalid(format!(
                "le compte {code} {name} est un compte de résultat. Le bilan d'ouverture ne reprend que les comptes de bilan (classes 1 et 2)."
            ))));
        }
        let (debit_cents, credit_cents) = row.sides(normal == "debit").map_err(|error| at_line(row.line, error))?;
        lines.push(PlannedLine { line: row.line, code, name, account_id, create, debit_cents, credit_cents, note: None });
    }
    let sum = |lines: &[PlannedLine]| lines.iter().map(|line| line.debit_cents - line.credit_cents).sum::<i64>();
    let difference_cents = sum(&lines);
    // Les factures ouvertes déjà reprises portent leur part des créances :
    // le compte de créances ne reçoit ici que le reste du solde bexio.
    let receivables_cents: i64 = tx.query_row(
        "SELECT COALESCE(SUM(o.open_cents),0) FROM opening_receivables o JOIN invoices i ON i.id=o.invoice_id
          WHERE i.issue_date<=? AND i.status<>'annulee'
            AND EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type='invoice' AND je.source_id=i.id AND je.source_event='issue')",
        [&input.entry_date],
        |row| row.get(0),
    )?;
    if receivables_cents > 0 {
        let note = format!("dont {} déjà repris avec les factures ouvertes", chf(receivables_cents));
        let index = lines.iter().position(|line| line.account_id.as_deref() == Some(ar.as_str()));
        let index = match index {
            Some(index) => index,
            None => {
                let (code, name): (String, String) = tx.query_row("SELECT code,name FROM accounts WHERE id=?", [&ar], |r| Ok((r.get(0)?, r.get(1)?)))?;
                lines.push(PlannedLine { line: 0, code, name, account_id: Some(ar.clone()), create: None, debit_cents: 0, credit_cents: 0, note: None });
                lines.len() - 1
            }
        };
        let remaining = lines[index].debit_cents - lines[index].credit_cents - receivables_cents;
        lines[index].debit_cents = remaining.max(0);
        lines[index].credit_cents = (-remaining).max(0);
        lines[index].note = Some(note);
    }
    lines.retain(|line| line.debit_cents != 0 || line.credit_cents != 0);
    let balance = sum(&lines);
    if lines.is_empty() || (lines.len() < 2 && balance == 0) {
        return Err(invalid("Aucun solde à reprendre dans ce bilan."));
    }
    Ok(BalancePlan {
        entry_date: input.entry_date.clone(),
        lines,
        receivables_cents,
        difference_cents,
        opening_debit_cents: (-balance).max(0),
        opening_credit_cents: balance.max(0),
    })
}

impl LocalStore {
    pub fn import_opening_receivables(&self, input: OpeningReceivablesInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let receipt = import_opening_receivables_tx(&tx, &input, "bexio")?;
        tx.commit()?;
        Ok(receipt)
    }

    pub fn preview_opening_balance(&self, input: OpeningBalanceInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction()?;
        let plan = plan_opening_balance(&tx, &input)?;
        // Aperçu seulement : rien n'est écrit.
        tx.rollback()?;
        Ok(plan.json())
    }

    pub fn import_opening_balance(&self, input: OpeningBalanceInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let receipt = import_opening_balance_tx(&tx, &input, "bexio")?;
        tx.commit()?;
        Ok(receipt)
    }
}

/// Factures encore ouvertes dans l'ancien logiciel (`label`, par exemple
/// « bexio » ou « WinBIZ ») : émises et comptabilisées contre le compte
/// d'ouverture, dans la transaction de l'appelant.
pub(crate) fn import_opening_receivables_tx(tx: &Transaction<'_>, input: &OpeningReceivablesInput, label: &str) -> AppResult<Value> {
    if input.rows.is_empty() || input.rows.len() > MAX_INVOICES {
        return Err(invalid("Importez entre 1 et 5 000 factures ouvertes à la fois."));
    }
    let received: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM vat_profiles WHERE form_of_reporting='received')",
        [],
        |row| row.get(0),
    )?;
    if received {
        return Err(invalid(format!(
            "Votre TVA est décomptée selon les contre-prestations reçues : la TVA de ces factures sera due à l'encaissement et Zentra ne peut pas la reconstituer depuis {label}. Saisissez ces factures avec votre fiduciaire.",
        )));
    }
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    let (mut created, mut skipped) = (0_i64, 0_i64);
    for row in &input.rows {
        let line = row.line;
        let number = row.number.trim().to_owned();
        if number.is_empty() || number.chars().count() > 60 || number.chars().any(char::is_control) {
            return Err(at_line(line, invalid("le numéro de facture est manquant ou trop long.")));
        }
        if !seen.insert(number.to_lowercase()) {
            return Err(at_line(line, invalid(format!("la facture {number} apparaît deux fois dans le fichier."))));
        }
        validate_date(&row.issue_date, "issue_date").map_err(|error| at_line(line, error))?;
        validate_date(&row.due_date, "due_date").map_err(|error| at_line(line, error))?;
        if row.due_date < row.issue_date {
            return Err(at_line(line, invalid("l'échéance précède la date de la facture.")));
        }
        if row.open_cents <= 0 || row.open_cents > MAX_AMOUNT_CENTS {
            return Err(at_line(line, invalid("le montant ouvert doit être positif.")));
        }
        if row.total_cents.is_some_and(|total| total < row.open_cents || total > MAX_AMOUNT_CENTS) {
            return Err(at_line(line, invalid("le montant ouvert dépasse le total de la facture.")));
        }
        let client: Option<String> = tx
            .query_row("SELECT name FROM clients WHERE id=?", [&row.client_id], |r| r.get(0))
            .optional()?;
        if client.is_none() {
            return Err(at_line(line, invalid(format!("le client est introuvable. Importez d'abord vos clients {label}."))));
        }
        let already: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM opening_receivables WHERE source='bexio' AND source_number=?)",
            [&number],
            |r| r.get(0),
        )?;
        let taken: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM invoices WHERE number=?)", [&number], |r| r.get(0))?;
        if already || taken {
            skipped += 1;
            rows.push(json!({ "line": line, "number": number, "status": "skipped",
                "reason": if already { "Déjà reprise" } else { "Numéro déjà utilisé dans Zentra" } }));
            continue;
        }
        ensure_accounting_date_open(&tx, &row.issue_date).map_err(|error| at_line(line, error))?;
        let id = Uuid::new_v4().to_string();
        let now = now_iso();
        let title = row
            .title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(|title| title.chars().take(200).collect::<String>())
            .unwrap_or_else(|| format!("Facture {label} {number}"));
        let description = match row.total_cents {
            Some(total) if total != row.open_cents => format!("Solde ouvert de la facture {label} {number} (total {} CHF)", chf(total)),
            _ => format!("Facture {label} {number}"),
        };
        tx.execute(
            "INSERT INTO invoices(id,client_id,title,type,status,issue_date,due_date,service_date_from,service_date_to,currency,notes,created_at,updated_at)
             VALUES(?,?,?,'standard','brouillon',?,?,?,?,'CHF',?,?,?)",
            params![id, row.client_id, title, row.issue_date, row.due_date, row.issue_date, row.issue_date,
                format!("Reprise {label} : facture {number} du {}.", row.issue_date), now, now],
        )?;
        tx.execute(
            "INSERT INTO invoice_items(id,invoice_id,catalog_item_id,position,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at)
             VALUES(?,?,NULL,0,?,1,'forfait',?,0,0,?,0,?,?,?)",
            params![Uuid::new_v4().to_string(), id, description, row.open_cents, row.open_cents, row.open_cents, now, now],
        )?;
        recompute_invoice(&tx, &id)?;
        tx.execute(
            "INSERT INTO opening_receivables(invoice_id,source,source_number,original_total_cents,open_cents,created_at) VALUES(?,'bexio',?,?,?,?)",
            params![id, number, row.total_cents, row.open_cents, now],
        )?;
        let overrides = json!({"number": number, "issue_date": row.issue_date, "due_date": row.due_date,
            "service_date_from": row.issue_date, "service_date_to": row.issue_date});
        let payment_snapshot = build_document_snapshot(&tx, "invoices", "invoice_items", &id, &overrides)
            .map_err(|error| at_line(line, error))?;
        crate::swiss_qr::ensure_automatic_invoice_qr(&tx, &payment_snapshot).map_err(|error| at_line(line, error))?;
        tx.execute(
            "UPDATE invoice_qr_bills SET frozen_at=COALESCE(frozen_at,?),updated_at=? WHERE invoice_id=?",
            params![now, now, id],
        )?;
        let snapshot = build_document_snapshot(&tx, "invoices", "invoice_items", &id, &overrides)?;
        crate::sales_pdf::validate_document_snapshot_legal_fields("invoices", &snapshot)
            .map_err(|error| at_line(line, error))?;
        tx.execute(
            "UPDATE invoices SET number=?,status='emise',snapshot_json=?,updated_at=? WHERE id=?",
            params![number, serde_json::to_string(&snapshot)?, now_iso(), id],
        )?;
        let journal = post_invoice_if_enabled(&tx, &id).map_err(|error| at_line(line, error))?;
        let record = query_record_tx(&tx, "invoices", &id)?;
        append_audit(tx, "import_opening", "invoice", &id, &json!({"source": label, "source_number": number, "open_cents": row.open_cents, "original_total_cents": row.total_cents, "document": record, "journal": journal}))?;
        created += 1;
        rows.push(json!({ "line": line, "number": number, "status": "created", "invoice_id": id }));
    }
    Ok(json!({ "created": created, "skipped": skipped, "rows": rows }))
}

/// Bilan d'ouverture repris de l'ancien logiciel, en une écriture, dans la
/// transaction de l'appelant.
pub(crate) fn import_opening_balance_tx(tx: &Transaction<'_>, input: &OpeningBalanceInput, label: &str) -> AppResult<Value> {
    let plan = plan_opening_balance(tx, input)?;
    let now = now_iso();
    let memo = Some(format!("Bilan d'ouverture {label}"));
    let mut entry = Vec::new();
    for line in &plan.lines {
        let account_id = match (&line.account_id, line.create) {
            (Some(id), _) => id.clone(),
            (None, Some((kind, normal, section))) => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO accounts(id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)",
                    params![id, line.code, line.name, kind, normal, section, now, now],
                )?;
                id
            }
            (None, None) => return Err(invalid(format!("Le compte {} est introuvable.", line.code))),
        };
        entry.push(EntryLine { account_id, debit_cents: line.debit_cents, credit_cents: line.credit_cents, currency: "CHF".into(), memo: memo.clone(), project_id: None, client_id: None, employee_id: None });
    }
    if plan.opening_debit_cents != 0 || plan.opening_credit_cents != 0 {
        entry.push(EntryLine { account_id: opening_account(tx)?, debit_cents: plan.opening_debit_cents, credit_cents: plan.opening_credit_cents, currency: "CHF".into(), memo: memo.clone(), project_id: None, client_id: None, employee_id: None });
    }
    let journal = post_entry(tx, &plan.entry_date, &format!("Bilan d'ouverture repris de {label}"), "manual", &Uuid::new_v4().to_string(), "posted", entry)?;
    let summary = plan.json();
    tx.execute(
        "INSERT INTO opening_balance_imports(id,source,entry_date,journal_entry_id,receivables_cents,difference_cents,lines_json,created_at) VALUES(?,'bexio',?,?,?,?,?,?)",
        params![Uuid::new_v4().to_string(), plan.entry_date, journal["id"].as_str().unwrap_or_default(), plan.receivables_cents, plan.difference_cents, serde_json::to_string(&summary["lines"])?, now],
    )?;
    append_audit(tx, "import_opening_balance", "journal_entry", journal["id"].as_str().unwrap_or_default(), &json!({"source": label, "plan": summary, "journal": journal}))?;
    Ok(json!({ "plan": summary, "journal": journal }))
}

#[tauri::command]
pub fn import_opening_receivables(state: tauri::State<'_, LocalStore>, input: OpeningReceivablesInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.import_opening_receivables(input).map_err(command_error)
}

#[tauri::command]
pub fn preview_opening_balance(state: tauri::State<'_, LocalStore>, input: OpeningBalanceInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.preview_opening_balance(input).map_err(command_error)
}

#[tauri::command]
pub fn import_opening_balance(state: tauri::State<'_, LocalStore>, input: OpeningBalanceInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.import_opening_balance(input).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::RecordPaymentInput;

    fn store_with_client(accounting: bool) -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "opening-balance-test").unwrap();
        if accounting {
            crate::tests::enable_accounting(&store);
        }
        store
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO clients(id,name,address_line1,postal_code,city,country,created_at,updated_at) VALUES('client-bexio','Muster AG','Bahnhofstrasse 1','8001','Zürich','CH','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        (temporary, store)
    }

    fn row(line: i64, number: &str, open: i64) -> OpeningReceivableRow {
        OpeningReceivableRow { line, number: number.into(), client_id: "client-bexio".into(), issue_date: "2025-12-10".into(), due_date: "2026-01-09".into(), open_cents: open, total_cents: Some(open), title: None }
    }

    #[test]
    fn labels_group_thousands() {
        assert_eq!(chf(0), "0.00");
        assert_eq!(chf(123_456), "1'234.56");
        assert_eq!(chf(100_000_000), "1'000'000.00");
        assert_eq!(chf(-5), "-0.05");
    }

    #[test]
    fn open_invoices_become_issued_receivables_against_the_opening_account() {
        let (_temporary, store) = store_with_client(true);
        let mut partial = row(3, "RE-00042", 40_000);
        partial.total_cents = Some(100_000);
        let receipt = store
            .import_opening_receivables(OpeningReceivablesInput { rows: vec![row(2, "RE-00041", 125_050), partial] })
            .unwrap();
        assert_eq!(receipt["created"], 2);
        let connection = store.connect().unwrap();
        let (status, total, vat, number): (String, i64, i64, String) = connection
            .query_row("SELECT status,total_cents,vat_cents,number FROM invoices WHERE number='RE-00042'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap();
        assert_eq!((status.as_str(), total, vat, number.as_str()), ("emise", 40_000, 0, "RE-00042"));
        // Créance au débit, compte d'ouverture au crédit : aucun produit, aucune TVA.
        let lines: Vec<(String, i64, i64, String)> = connection
            .prepare("SELECT a.code,l.debit_cents,l.credit_cents,l.memo FROM journal_lines l JOIN journal_entries e ON e.id=l.journal_entry_id JOIN accounts a ON a.id=l.account_id JOIN invoices i ON i.id=e.source_id WHERE e.source_type='invoice' AND i.number='RE-00042' ORDER BY l.debit_cents DESC")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(lines, vec![("1100".into(), 40_000, 0, "Créance client".into()), ("9100".into(), 0, 40_000, OPENING_MEMO.into())]);
        let revenue: i64 = connection
            .query_row("SELECT COUNT(*) FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.account_type='revenue'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(revenue, 0);
        drop(connection);
        let continuity = store.get_accounting_continuity().unwrap();
        assert_eq!(continuity["semantic_posting_mismatches"], 0, "{continuity}");
        assert_eq!(continuity["missing_invoices"], 0, "{continuity}");
        // Une seconde reprise du même fichier ne crée rien.
        let again = store.import_opening_receivables(OpeningReceivablesInput { rows: vec![row(2, "RE-00041", 125_050)] }).unwrap();
        assert_eq!((again["created"].as_i64(), again["skipped"].as_i64()), (Some(0), Some(1)));
    }

    #[test]
    fn a_reprised_invoice_is_paid_through_its_receivable_and_never_credited() {
        let (_temporary, store) = store_with_client(true);
        store.import_opening_receivables(OpeningReceivablesInput { rows: vec![row(2, "RE-00050", 80_000)] }).unwrap();
        let invoice_id: String = store.connect().unwrap().query_row("SELECT id FROM invoices WHERE number='RE-00050'", [], |r| r.get(0)).unwrap();
        store
            .record_payment(RecordPaymentInput { request_id: Uuid::new_v4().to_string(), invoice_id: invoice_id.clone(), amount_cents: 80_000, date: Some("2026-01-20".into()), method: Some("bank".into()), reference: None, notes: None })
            .unwrap();
        let connection = store.connect().unwrap();
        let status: String = connection.query_row("SELECT status FROM invoices WHERE id=?", [&invoice_id], |r| r.get(0)).unwrap();
        assert_eq!(status, "payee");
        let settled: i64 = connection
            .query_row("SELECT COALESCE(SUM(l.credit_cents),0) FROM journal_lines l JOIN journal_entries e ON e.id=l.journal_entry_id JOIN accounts a ON a.id=l.account_id WHERE e.source_type='payment' AND a.code='1100'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(settled, 80_000);
        assert!(refuse_credit_note(&connection, &invoice_id).is_err());
    }

    #[test]
    fn invalid_rows_change_nothing() {
        let (_temporary, store) = store_with_client(false);
        let mut late = row(4, "RE-1", 1_000);
        late.due_date = "2025-01-01".into();
        let error = store.import_opening_receivables(OpeningReceivablesInput { rows: vec![row(2, "RE-0", 500), late] }).unwrap_err();
        assert!(error.to_string().contains("Ligne 4"), "{error}");
        let mut stranger = row(5, "RE-2", 1_000);
        stranger.client_id = "inconnu".into();
        assert!(store.import_opening_receivables(OpeningReceivablesInput { rows: vec![stranger] }).is_err());
        let count: i64 = store.connect().unwrap().query_row("SELECT COUNT(*) FROM invoices", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        // Sans comptabilité, la facture est créée sans écriture.
        store.import_opening_receivables(OpeningReceivablesInput { rows: vec![row(2, "RE-3", 1_000)] }).unwrap();
        let entries: i64 = store.connect().unwrap().query_row("SELECT COUNT(*) FROM journal_entries", [], |r| r.get(0)).unwrap();
        assert_eq!(entries, 0);
    }

    fn balance(line: i64, code: &str, cents: i64) -> OpeningBalanceLineInput {
        OpeningBalanceLineInput { line, code: code.into(), name: None, balance_cents: Some(cents), debit_cents: None, credit_cents: None }
    }

    #[test]
    fn opening_balance_counts_reprised_invoices_once_and_balances_on_9100() {
        let (_temporary, store) = store_with_client(true);
        store.import_opening_receivables(OpeningReceivablesInput { rows: vec![row(2, "RE-00060", 30_000)] }).unwrap();
        let input = OpeningBalanceInput {
            entry_date: "2026-01-01".into(),
            lines: vec![balance(2, "1020", 500_000), balance(3, "1100", 50_000), balance(4, "2000", 150_000), balance(5, "2800", 400_000)],
        };
        let preview = store.preview_opening_balance(input.clone()).unwrap();
        assert_eq!(preview["receivables_cents"], 30_000);
        assert_eq!(preview["difference_cents"], 0);
        let ar = preview["lines"].as_array().unwrap().iter().find(|line| line["code"] == "1100").unwrap();
        assert_eq!((ar["debit_cents"].as_i64(), ar["credit_cents"].as_i64()), (Some(20_000), Some(0)));
        // L'aperçu n'écrit rien.
        let entries = || store.connect().unwrap().query_row("SELECT COUNT(*) FROM journal_entries", [], |r| r.get::<_, i64>(0)).unwrap();
        let before = entries();
        store.preview_opening_balance(input.clone()).unwrap();
        assert_eq!(entries(), before);
        store.import_opening_balance(input.clone()).unwrap();
        let connection = store.connect().unwrap();
        let account = |code: &str| -> i64 {
            connection
                .query_row("SELECT COALESCE(SUM(l.debit_cents-l.credit_cents),0) FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.code=?", [code], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(account("1100"), 50_000);
        assert_eq!(account("1020"), 500_000);
        assert_eq!(account("2000"), -150_000);
        assert_eq!(account("9100"), 0);
        drop(connection);
        let error = store.import_opening_balance(input).unwrap_err();
        assert!(error.to_string().contains("déjà été repris"), "{error}");
    }

    #[test]
    fn opening_balance_refuses_result_accounts_and_unknown_codes() {
        let (_temporary, store) = store_with_client(true);
        let refused = |lines| store.preview_opening_balance(OpeningBalanceInput { entry_date: "2026-01-01".into(), lines }).unwrap_err().to_string();
        assert!(refused(vec![balance(2, "3000", 1_000)]).contains("compte de résultat"));
        assert!(refused(vec![balance(2, "1234", 1_000)]).contains("n'existe pas"));
        assert!(refused(vec![balance(2, "9100", 1_000)]).contains("9100"));
        assert!(refused(vec![balance(2, "1020", 1_000), balance(3, "1020", 1_000)]).contains("deux fois"));
        // Un compte du plan PME absent est créé à la reprise ; l'écart reste visible sur 9100.
        let preview = store.preview_opening_balance(OpeningBalanceInput { entry_date: "2026-01-01".into(), lines: vec![balance(2, "1060", 10_000)] }).unwrap();
        assert_eq!(preview["lines"][0]["create"], true);
        assert_eq!(preview["difference_cents"], 10_000);
        assert_eq!(preview["opening"]["credit_cents"], 10_000);
        // Colonnes Débit / Crédit : le sens vient du fichier, pas du compte.
        let sides = OpeningBalanceLineInput { line: 2, code: "2000".into(), name: None, balance_cents: None, debit_cents: Some(500), credit_cents: Some(2_000) };
        let preview = store.preview_opening_balance(OpeningBalanceInput { entry_date: "2026-01-01".into(), lines: vec![sides] }).unwrap();
        assert_eq!((preview["lines"][0]["debit_cents"].as_i64(), preview["lines"][0]["credit_cents"].as_i64()), (Some(0), Some(1_500)));
        assert_eq!(preview["opening"]["debit_cents"], 1_500);
    }
}
