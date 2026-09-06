//! Explicit adoption of open, agreed-basis credits with no prior cash refund.
//! The old issue journals are preserved. Applications use the ordinary dated
//! settlement command inside the same transaction; preview always rolls back.
use std::collections::BTreeSet;

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    accounting::ensure_accounting_date_open,
    audit::append_audit,
    customer_credit_math::project,
    customer_credit_settlements::{journal_snapshot, record, CustomerCreditSettlementInput},
    database::{now_iso, query_all, refresh_invoice_payment_state, LocalStore},
    error::{AppError, AppResult},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryCredit {
    pub credit_note_id: String,
    pub applied_cents: i64,
    pub application_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryInput {
    pub request_id: String,
    pub original_invoice_id: String,
    pub source_token: String,
    pub reference: String,
    pub reason: String,
    pub no_prior_refund: bool,
    pub credits: Vec<RecoveryCredit>,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn field(value: &Value, name: &str) -> String {
    value[name].as_str().unwrap_or_default().into()
}
fn cents(value: &Value, name: &str) -> i64 {
    value[name].as_i64().unwrap_or_default()
}
fn token(source: &Value) -> AppResult<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(source)?)))
}

fn normalize(mut input: RecoveryInput) -> AppResult<RecoveryInput> {
    input.request_id = Uuid::parse_str(&input.request_id)
        .map_err(|_| invalid("L’identifiant de la reprise est invalide."))?
        .to_string();
    input.reference = input.reference.trim().into();
    input.reason = input.reason.trim().into();
    if input.reference.is_empty()
        || input.reference.chars().count() > 255
        || !(5..=1000).contains(&input.reason.chars().count())
    {
        return Err(invalid(
            "Renseignez une référence et un motif de reprise de 5 à 1 000 caractères.",
        ));
    }
    if !input.no_prior_refund {
        return Err(invalid("Cette reprise exige de confirmer qu’aucun remboursement ni déduction sur une autre facture n’a déjà été effectué. Les autres cas nécessitent un rapprochement des écritures existantes."));
    }
    if input.credits.is_empty() || input.credits.len() > 500 {
        return Err(invalid(
            "La reprise doit contenir les avoirs historiques de la facture.",
        ));
    }
    input
        .credits
        .sort_by(|a, b| a.credit_note_id.cmp(&b.credit_note_id));
    if input
        .credits
        .windows(2)
        .any(|pair| pair[0].credit_note_id == pair[1].credit_note_id)
    {
        return Err(invalid("Un avoir figure plusieurs fois dans la reprise."));
    }
    Ok(input)
}

// Include all relevant financial facts in the optimistic review token. A payment,
// new credit, edited journal, changed account, VAT profile or closure invalidates it.
fn snapshot(tx: &Transaction<'_>, original: &str) -> AppResult<Value> {
    let documents=query_all(tx,"SELECT * FROM invoices WHERE id=?1 OR (original_invoice_id=?1 AND type='avoir' AND number IS NOT NULL AND status<>'annulee') ORDER BY id",[original])?;
    let mut items = Vec::new();
    let mut journals = Vec::new();
    for doc in &documents {
        let id = field(doc, "id");
        items.extend(query_all(
            tx,
            "SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY position,id",
            [&id],
        )?);
        for journal in query_all(tx,"SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=? ORDER BY id",[&id])? {
            journals.push(journal_snapshot(tx,&field(&journal,"id"))?);
        }
    }
    Ok(
        json!({"documents":documents,"items":items,"journals":journals,
        "payments":query_all(tx,"SELECT * FROM payments WHERE invoice_id=? ORDER BY date,created_at,id",[original])?,
        "registered":query_all(tx,"SELECT d.* FROM customer_credit_documents d JOIN invoices i ON i.id=d.credit_note_id WHERE i.original_invoice_id=? ORDER BY d.credit_note_id",[original])?,
        "settlements":query_all(tx,"SELECT e.* FROM customer_credit_settlements e JOIN invoices c ON c.id=e.credit_note_id WHERE e.invoice_id=?1 OR c.original_invoice_id=?1 ORDER BY e.sequence",[original])?,
        "profiles":query_all(tx,"SELECT * FROM vat_profiles ORDER BY effective_from,id",[])?,
        "periods":query_all(tx,"SELECT * FROM accounting_periods ORDER BY date_to,id",[])?,
        "accounting":query_all(tx,"SELECT * FROM accounting_settings ORDER BY id",[])?,
        "accounts":query_all(tx,"SELECT * FROM accounts ORDER BY id",[])?}),
    )
}

fn source_documents(source: &Value, original: &str) -> AppResult<(Value, Vec<Value>)> {
    let docs = source["documents"]
        .as_array()
        .ok_or_else(|| invalid("La facture est introuvable."))?;
    let invoice = docs
        .iter()
        .find(|doc| {
            doc["id"] == original
                && doc["type"] != "avoir"
                && doc["number"].is_string()
                && !matches!(doc["status"].as_str(), Some("annulee" | "brouillon"))
        })
        .ok_or_else(|| invalid("Choisissez une facture émise pour reprendre ses avoirs."))?
        .clone();
    let registered: BTreeSet<_> = source["registered"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|doc| field(doc, "credit_note_id"))
        .collect();
    let credits: Vec<_> = docs
        .iter()
        .filter(|doc| doc["type"] == "avoir" && !registered.contains(&field(doc, "id")))
        .cloned()
        .collect();
    if credits.is_empty() {
        return Err(invalid(
            "Cette facture n’a plus d’avoir historique à reprendre. Actualisez son dossier.",
        ));
    }
    Ok((invoice, credits))
}

fn validate_issue_journal(tx: &Transaction<'_>, doc: &Value) -> AppResult<()> {
    let id = field(doc, "id");
    let credit = doc["type"] == "avoir";
    let total = i128::from(cents(doc, "total_cents")).abs();
    let vat = i128::from(cents(doc, "vat_cents")).abs();
    let journals = query_all(
        tx,
        "SELECT * FROM journal_entries WHERE source_type='invoice' AND source_id=?",
        [&id],
    )?;
    let fail = || {
        invalid(&format!("Le journal de {} exige un rapprochement avant la reprise (montants, comptes, date ou extourne).",field(doc,"number")))
    };
    let items=query_all(tx,"SELECT line_net_cents,line_vat_cents,line_total_cents FROM invoice_items WHERE invoice_id=?",[&id])?;
    let sum = |column: &str| {
        items
            .iter()
            .map(|item| i128::from(cents(item, column)))
            .sum::<i128>()
    };
    if items.is_empty()
        || sum("line_total_cents") != i128::from(cents(doc, "total_cents"))
        || sum("line_vat_cents") != i128::from(cents(doc, "vat_cents"))
        || sum("line_net_cents")
            != i128::from(cents(doc, "total_cents")) - i128::from(cents(doc, "vat_cents"))
    {
        return Err(fail());
    }
    if journals.len() != 1 || total == 0 || vat > total {
        return Err(fail());
    }
    let journal = &journals[0];
    let jid = field(journal, "id");
    let reversed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM journal_entries WHERE reversal_of=?)",
        [&jid],
        |r| r.get(0),
    )?;
    if journal["source_event"] != "issue"
        || journal["entry_date"] != doc["issue_date"]
        || journal["status"] != "posted"
        || !journal["reversal_of"].is_null()
        || reversed
    {
        return Err(fail());
    }
    let lines=query_all(tx,"SELECT l.*,a.account_type FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=? ORDER BY l.rowid",[&jid])?;
    let expected = if credit {
        [
            ("Réduction créance client", "asset", -total),
            ("Extourne produit", "revenue", total - vat),
            ("Extourne TVA", "liability", vat),
        ]
    } else {
        [
            ("Créance client", "asset", total),
            ("Produit facturé", "revenue", -(total - vat)),
            ("TVA due", "liability", -vat),
        ]
    };
    let mut seen = BTreeSet::new();
    for line in &lines {
        let memo = field(line, "memo");
        let Some((_, kind, amount)) = expected.iter().find(|(name, _, _)| *name == memo) else {
            return Err(fail());
        };
        let debit = i128::from(cents(line, "debit_cents"));
        let credit = i128::from(cents(line, "credit_cents"));
        if !seen.insert(memo)
            || line["account_type"] != *kind
            || line["currency"] != doc["currency"]
            || line["client_id"] != doc["client_id"]
            || line["project_id"] != doc["project_id"]
            || debit != (*amount).max(0)
            || credit != (-amount).max(0)
        {
            return Err(fail());
        }
    }
    if expected
        .iter()
        .any(|(memo, _, amount)| *amount != 0 && !seen.contains(*memo))
    {
        return Err(fail());
    }
    Ok(())
}

fn eligibility(
    tx: &Transaction<'_>,
    source: &Value,
    invoice: &Value,
    credits: &[Value],
) -> AppResult<()> {
    let enabled: bool = tx.query_row(
        "SELECT COALESCE((SELECT enabled FROM accounting_settings WHERE id=1),0)",
        [],
        |r| r.get(0),
    )?;
    if !enabled {
        return Err(invalid(
            "Activez la comptabilité et comptabilisez les documents avant leur reprise.",
        ));
    }
    let received:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM vat_profiles WHERE form_of_reporting='received' AND COALESCE(effective_to,'9999-12-31')>=?)",[field(invoice,"issue_date")],|r|r.get(0))?;
    if received {
        return Err(invalid("Ces avoirs concernent la TVA à l’encaissement ou un changement de méthode. Le rapprochement de leur TVA historique doit être documenté avant la reprise ; ce parcours n’est pas encore disponible."));
    }
    for doc in std::iter::once(invoice).chain(credits) {
        ensure_accounting_date_open(tx, &field(doc, "issue_date"))?;
        validate_issue_journal(tx, doc)?;
        if doc["client_id"] != invoice["client_id"] || doc["currency"] != invoice["currency"] {
            return Err(invalid(
                "Les avoirs doivent appartenir au client et à la devise de leur facture.",
            ));
        }
        // Projection checks totals and signed line arithmetic even before adoption.
        if doc["type"] == "avoir" {
            project(tx, &field(doc, "id"), "9999-12-31")?;
            crate::customer_credit_validation::validate_issue_basis(
                tx,
                &field(invoice, "id"),
                &field(doc, "id"),
                &field(doc, "issue_date"),
            )?;
        }
    }
    // Registration of a different model must not reallocate an existing dated event.
    if !source["settlements"].as_array().is_some_and(Vec::is_empty) {
        return Err(invalid("La facture comporte déjà des règlements datés. Leur ventilation doit être rapprochée avec les avoirs historiques avant cette reprise."));
    }
    Ok(())
}

fn plan(tx: &Transaction<'_>, original: &str) -> AppResult<(Value, Value)> {
    let source = snapshot(tx, original)?;
    let (invoice, credits) = source_documents(&source, original)?;
    let blocker = eligibility(tx, &source, &invoice, &credits)
        .err()
        .map(|error| error.to_string());
    let paid: i64 = tx.query_row(
        "SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE invoice_id=?",
        [original],
        |r| r.get(0),
    )?;
    let earliest: String = tx.query_row(
        "SELECT COALESCE(MAX(date),'0001-01-01') FROM payments WHERE invoice_id=?",
        [original],
        |r| r.get(0),
    )?;
    let credit_rows:Vec<_>=credits.iter().map(|credit|json!({"id":credit["id"],"number":credit["number"],"total_cents":-cents(credit,"total_cents"),"issue_date":credit["issue_date"],"earliest_application_date":earliest.clone().max(field(credit,"issue_date"))})).collect();
    let result = json!({"source_token":token(&source)?,"original_invoice_id":original,"number":invoice["number"],"currency":invoice["currency"],"invoice_total_cents":invoice["total_cents"],"paid_cents":paid,"credits":credit_rows,"blocker":blocker});
    Ok((source, result))
}

fn perform(tx: &Transaction<'_>, input: &RecoveryInput) -> AppResult<Value> {
    let source = snapshot(tx, &input.original_invoice_id)?;
    if token(&source)? != input.source_token {
        return Err(invalid("Le dossier a changé depuis son ouverture. Actualisez la reprise et vérifiez les nouveaux montants."));
    }
    let (invoice, credits) = source_documents(&source, &input.original_invoice_id)?;
    eligibility(tx, &source, &invoice, &credits)?;
    let expected: BTreeSet<_> = credits.iter().map(|c| field(c, "id")).collect();
    let provided: BTreeSet<_> = input
        .credits
        .iter()
        .map(|c| c.credit_note_id.clone())
        .collect();
    if expected != provided {
        return Err(invalid(
            "Reprenez ensemble tous les avoirs historiques de cette facture.",
        ));
    }
    for credit in &credits {
        tx.execute("INSERT INTO customer_credit_documents(credit_note_id,model,created_at) VALUES(?,'dated_v1',?)",params![field(credit,"id"),now_iso()])?;
    }
    let mut sorted = input.credits.clone();
    sorted.sort_by(|a, b| {
        (&a.application_date, &a.credit_note_id).cmp(&(&b.application_date, &b.credit_note_id))
    });
    for credit in &sorted {
        let available = project(tx, &credit.credit_note_id, "9999-12-31")?.remaining()?;
        if credit.applied_cents < 0
            || credit.applied_cents > available
            || (credit.applied_cents == 0 && credit.application_date.is_some())
        {
            return Err(invalid("Le montant déduit doit rester entre zéro et le total de l’avoir ; seul un montant déduit doit recevoir une date."));
        }
        if credit.applied_cents > 0 {
            let date = credit
                .application_date
                .clone()
                .ok_or_else(|| invalid("Renseignez la date effective de chaque déduction."))?;
            record(
                tx,
                CustomerCreditSettlementInput {
                    request_id: Uuid::new_v4().to_string(),
                    credit_note_id: credit.credit_note_id.clone(),
                    event_type: "apply".into(),
                    invoice_id: Some(input.original_invoice_id.clone()),
                    date,
                    amount_cents: credit.applied_cents,
                    bank_account_id: None,
                    reference: input.reference.clone(),
                    reason: input.reason.clone(),
                },
                None,
                None,
            )?;
        }
    }
    refresh_invoice_payment_state(tx, &input.original_invoice_id)?;
    crate::reminders::cancel_settled_reminders(tx, &input.original_invoice_id)?;
    let remaining = project(tx, &input.original_invoice_id, "9999-12-31")?.remaining()?;
    let balances=query_all(tx,"SELECT b.*,i.number FROM customer_credit_balances b JOIN invoices i ON i.id=b.credit_note_id WHERE i.original_invoice_id=? ORDER BY b.credit_note_id",[&input.original_invoice_id])?;
    let result = json!({"original_invoice_id":input.original_invoice_id,"number":invoice["number"],"currency":invoice["currency"],"invoice_remaining_cents":remaining,"credits":balances,"bank_movement_cents":0,"vat_change_cents":0});
    let id = Uuid::new_v4().to_string();
    tx.execute("INSERT INTO customer_credit_recoveries(id,request_id,original_invoice_id,request_json,source_json,result_json,created_at) VALUES(?,?,?,?,?,?,?)",params![id,input.request_id,input.original_invoice_id,serde_json::to_string(input)?,serde_json::to_string(&source)?,serde_json::to_string(&result)?,now_iso()])?;
    append_audit(
        tx,
        "adopt",
        "customer_credit_recovery",
        &id,
        &json!({"input":input,"result":result}),
    )?;
    Ok(result)
}

impl LocalStore {
    pub fn get_customer_credit_recovery(&self, original: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction()?;
        let (_, result) = plan(&tx, original)?;
        tx.rollback()?;
        Ok(result)
    }
    pub fn preview_customer_credit_recovery(&self, input: RecoveryInput) -> AppResult<Value> {
        let input = normalize(input)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = perform(&tx, &input)?;
        tx.rollback()?;
        Ok(result)
    }
    pub fn adopt_customer_credit_recovery(&self, input: RecoveryInput) -> AppResult<Value> {
        let input = normalize(input)?;
        let payload = serde_json::to_string(&input)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let saved:Option<(String,String)>=tx.query_row("SELECT request_json,result_json FROM customer_credit_recoveries WHERE request_id=?",[&input.request_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((request, result)) = saved {
            if request != payload {
                return Err(invalid("Cette demande de reprise existe avec un autre contenu. Aucune seconde reprise n’a été créée."));
            }
            return Ok(json!({"idempotent":true,"result":serde_json::from_str::<Value>(&result)?}));
        }
        let result = perform(&tx, &input)?;
        tx.commit()?;
        Ok(json!({"idempotent":false,"result":result}))
    }
}
