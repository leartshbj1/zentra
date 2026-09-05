//! Dated supplier refunds keep the original purchase and payment immutable.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
use sha2::{Digest, Sha256};

use crate::{
    accounting::{ensure_accounting_date_open, post_entry, validate_date, EntryLine},
    audit::append_audit,
    database::{now_iso, query_all, query_record_tx, LocalStore},
    error::{AppError, AppResult},
    expense_refund_attachments::RefundAttachmentInput,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpenseRefundInput {
    pub request_id: String,
    pub expense_id: String,
    pub credit_date: String,
    pub payment_date: String,
    pub reference: String,
    pub reason: String,
    pub net_cents: i64,
    pub vat_cents: i64,
    pub reverses_id: Option<String>,
}

fn reject(message: &str) -> AppError {
    AppError::Validation(message.into())
}

fn account(
    connection: &Connection,
    sql: &str,
    id: &str,
    amount: i64,
    label: &str,
) -> AppResult<String> {
    let rows = query_all(connection, sql, params![id, amount])?;
    if rows.len() != 1 {
        return Err(reject(&format!("Le compte {label} historique est absent ou ambigu. Contrôlez la dépense dans Comptabilité.")));
    }
    rows[0]["account_id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| reject("Compte historique invalide."))
}

fn line(account: &str, amount: i64, memo: &str, project: &Option<String>) -> EntryLine {
    EntryLine {
        account_id: account.into(),
        debit_cents: amount.max(0),
        credit_cents: (-amount).max(0),
        currency: "CHF".into(),
        memo: Some(memo.into()),
        project_id: project.clone(),
        client_id: None,
        employee_id: None,
    }
}

impl LocalStore {
    pub fn record_expense_refund(&self, input: ExpenseRefundInput) -> AppResult<Value> {
        self.record_expense_refund_with_attachment(input, None)
    }

    pub fn record_expense_refund_with_attachment(&self, mut input: ExpenseRefundInput, attachment: Option<RefundAttachmentInput>) -> AppResult<Value> {
        input.request_id = Uuid::parse_str(input.request_id.trim())
            .map_err(|_| reject("Identifiant de tentative invalide."))?
            .to_string();
        input.expense_id = Uuid::parse_str(input.expense_id.trim())
            .map_err(|_| reject("Dépense invalide."))?
            .to_string();
        input.reverses_id = input
            .reverses_id
            .map(|id| {
                Uuid::parse_str(id.trim())
                    .map(|id| id.to_string())
                    .map_err(|_| reject("Remboursement à corriger invalide."))
            })
            .transpose()?;
        input.credit_date = input.credit_date.trim().into();
        input.payment_date = input.payment_date.trim().into();
        input.reference = input.reference.trim().into();
        input.reason = input.reason.trim().into();
        validate_date(&input.credit_date, "date de l’avoir")?;
        validate_date(&input.payment_date, "date du remboursement")?;
        if !(1..=255).contains(&input.reference.chars().count())
            || !(5..=1000).contains(&input.reason.chars().count())
            || input.reference.contains('\0')
            || input.reason.contains('\0')
        {
            return Err(reject(
                "Indiquez la référence de l’avoir et un motif de 5 à 1000 caractères.",
            ));
        }
        let total = input
            .net_cents
            .checked_add(input.vat_cents)
            .ok_or_else(|| reject("Montant hors capacité."))?;
        if input.net_cents < 0 || input.vat_cents < 0 || total <= 0 || total > 9_000_000_000_000 {
            return Err(reject(
                "Renseignez un remboursement positif avec des montants HT et TVA cohérents.",
            ));
        }
        if input.payment_date < input.credit_date
            || input.payment_date > chrono::Local::now().format("%Y-%m-%d").to_string()
        {
            return Err(reject(
                "Le remboursement doit être déjà reçu et ne peut pas précéder l’avoir.",
            ));
        }
        let attachment_bytes = attachment.as_ref().map(RefundAttachmentInput::decode).transpose()?;
        let request_json = match (&attachment, &attachment_bytes) {
            (Some(file), Some(bytes)) => serde_json::to_string(&json!({"refund":input,"attachment":{"original_name":file.original_name.trim(),"sha256":format!("{:x}",Sha256::digest(bytes))}}))?,
            _ => serde_json::to_string(&input)?,
        };
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(row) = query_all(
            &tx,
            "SELECT * FROM expense_refunds WHERE request_id=?",
            params![input.request_id],
        )?
        .into_iter()
        .next()
        {
            if row["request_json"] != request_json {
                return Err(reject(
                    "Cette tentative a déjà été enregistrée avec d’autres données.",
                ));
            }
            return Ok(json!({"refund":row,"already_recorded":true}));
        }
        let expense = query_record_tx(&tx, "expenses", &input.expense_id)?;
        if expense["payment_status"] != "paid" || expense["currency"] != "CHF" {
            return Err(reject(
                "Seule une dépense payée en CHF peut recevoir un remboursement.",
            ));
        }
        let paid_date=expense["paid_at"].as_str().filter(|s|!s.is_empty()).ok_or_else(||reject("La date du paiement d’origine est inconnue. Contrôlez d’abord cette ancienne dépense."))?;
        if input.credit_date.as_str() < paid_date || input.payment_date.as_str() < paid_date {
            return Err(reject(
                "La correction du prix et le remboursement ne peuvent pas précéder la comptabilisation du paiement d’origine. Contrôlez les pièces si l’avoir est antérieur.",
            ));
        }
        ensure_accounting_date_open(&tx, &input.credit_date)?;
        ensure_accounting_date_open(&tx, &input.payment_date)?;
        let project = expense["project_id"].as_str().map(str::to_owned);
        let (treatment, cost, expense_account, vat_account, bank_account, clearing_account, sign) =
            if let Some(ref reverse_id) = input.reverses_id {
                let original = query_record_tx(&tx, "expense_refunds", reverse_id)?;
                if original["event_type"] != "refund"
                    || original["expense_id"] != input.expense_id
                    || original["net_cents"] != input.net_cents
                    || original["vat_cents"] != input.vat_cents
                    || input.credit_date.as_str()
                        < original["credit_date"].as_str().unwrap_or_default()
                    || input.payment_date.as_str()
                        < original["payment_date"].as_str().unwrap_or_default()
                {
                    return Err(reject("La correction doit reprendre les montants du remboursement et être datée après celui-ci."));
                }
                if tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM expense_refunds WHERE reverses_id=?)",
                    params![reverse_id],
                    |r| r.get::<_, bool>(0),
                )? {
                    return Err(reject("Ce remboursement a déjà été corrigé."));
                }
                for field in ["credit_journal_id", "payment_journal_id"] {
                    if !crate::expense_journal::state(
                        &tx,
                        original[field].as_str().unwrap_or_default(),
                        "9999-12-31",
                    )?
                    .active
                    {
                        return Err(reject(
                            "Une écriture du remboursement est incohérente. Contrôlez le journal.",
                        ));
                    }
                }
                (
                    original["treatment"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    original["cost_cents"].as_i64().unwrap_or_default(),
                    original["expense_account_id"].as_str().map(str::to_owned),
                    original["vat_account_id"].as_str().map(str::to_owned),
                    original["bank_account_id"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    original["clearing_account_id"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    -1,
                )
            } else {
                let duplicate=tx.query_row("SELECT EXISTS(SELECT 1 FROM expense_refunds r WHERE expense_id=?1 AND event_type='refund' AND reference=?2 AND credit_date=?3 AND payment_date=?4 AND net_cents=?5 AND vat_cents=?6 AND NOT EXISTS(SELECT 1 FROM expense_refunds v WHERE v.reverses_id=r.id))",params![input.expense_id,input.reference,input.credit_date,input.payment_date,input.net_cents,input.vat_cents],|r|r.get::<_,bool>(0))?;
                if duplicate {
                    return Err(reject("Un remboursement identique est déjà enregistré. Consultez l’historique avant de créer une autre saisie."));
                }
                let (refunded_net,refunded_vat):(i64,i64)=tx.query_row("SELECT COALESCE(SUM(CASE event_type WHEN 'refund' THEN net_cents ELSE -net_cents END),0),COALESCE(SUM(CASE event_type WHEN 'refund' THEN vat_cents ELSE -vat_cents END),0) FROM expense_refunds WHERE expense_id=?",params![input.expense_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
                if input.net_cents
                    > expense["net_cents"].as_i64().unwrap_or_default() - refunded_net
                    || input.vat_cents
                        > expense["vat_cents"].as_i64().unwrap_or_default() - refunded_vat
                {
                    return Err(reject(
                        "Le remboursement dépasse le solde HT ou TVA de la dépense.",
                    ));
                }
                let mut proof = vec![expense.clone()];
                crate::purchase_costs::enrich(&tx, "expense", &mut proof)?;
                if proof[0]["cost_review_required"] != false {
                    return Err(reject("Contrôlez la classification TVA et le journal de cet achat avant de le rembourser."));
                }
                let root:String=tx.query_row("SELECT id FROM journal_entries WHERE source_type='expense' AND source_id=? AND source_event='create'",params![input.expense_id],|r|r.get(0))?;
                let vat = expense["vat_cents"].as_i64().unwrap_or_default();
                let net = expense["net_cents"].as_i64().unwrap_or_default();
                let vat_in_cost = proof[0]["cost_cents"].as_i64().unwrap_or_default() - net;
                let treatment = if vat_in_cost == vat {
                    "non_deductible".to_owned()
                } else {
                    tx.query_row("SELECT treatment FROM vat_source_classifications WHERE source_type='expense' AND source_id=?",params![input.expense_id],|r|r.get::<_,String>(0))?
                };
                let cost = input.net_cents
                    + if treatment == "non_deductible" {
                        input.vat_cents
                    } else {
                        0
                    };
                let expense_account = if cost > 0 {
                    Some(account(&tx,"SELECT l.account_id FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=?1 AND l.memo='Charge' AND l.debit_cents=?2 AND l.credit_cents=0 AND a.account_type='expense'",&root,net,"de charge")?)
                } else {
                    None
                };
                let vat_account = if treatment != "non_deductible" && input.vat_cents > 0 {
                    Some(account(&tx,"SELECT l.account_id FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=?1 AND l.memo='TVA préalable' AND l.debit_cents=?2 AND l.credit_cents=0 AND a.account_type='asset'",&root,vat,"de TVA préalable")?)
                } else {
                    None
                };
                let bank_account=account(&tx,"SELECT l.account_id FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=?1 AND l.memo='Paiement dépense' AND l.credit_cents=?2 AND l.debit_cents=0 AND a.account_type='asset'",&root,net+vat,"bancaire")?;
                let clearing:Option<String>=tx.query_row("SELECT supplier_payable_account_id FROM accounting_settings WHERE id=1 AND enabled=1",[],|r|r.get(0)).optional()?.flatten();
                let clearing=clearing.ok_or_else(||reject("Activez la comptabilité et la liaison du compte fournisseurs avant de rembourser une dépense."))?;
                let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=? AND account_type='liability' AND active=1)",params![clearing],|r|r.get(0))?;
                if !valid
                    || [
                        Some(&bank_account),
                        expense_account.as_ref(),
                        vat_account.as_ref(),
                    ]
                    .contains(&Some(&clearing))
                {
                    return Err(reject("La liaison du compte fournisseurs est invalide."));
                }
                (
                    treatment,
                    cost,
                    expense_account,
                    vat_account,
                    bank_account,
                    clearing,
                    1,
                )
            };
        // A change of VAT method needs its own transition assessment; never silently
        // drop a historically deducted tax from a simple-rate return.
        if treatment != "non_deductible" && input.vat_cents > 0 {
            let simple:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM vat_profiles WHERE reporting_method='simple_tax_rate' AND (effective_from<=?1 AND COALESCE(effective_to,'9999-12-31')>=?1 OR effective_from<=?2 AND COALESCE(effective_to,'9999-12-31')>=?2))",params![input.credit_date,input.payment_date],|r|r.get(0))?;
            if simple {
                return Err(reject("Ce remboursement concerne une TVA précédemment déduite, mais sa date appartient à un régime TDFN. Faites contrôler la correction liée au changement de méthode avant de l’enregistrer."));
            }
        }
        let id = Uuid::new_v4().to_string();
        let description = format!(
            "{} de dépense · {}",
            if sign == 1 {
                "Remboursement"
            } else {
                "Correction du remboursement"
            },
            input.reference
        );
        let mut credit_lines = vec![line(
            &clearing_account,
            sign * total,
            "Avoir à rembourser",
            &project,
        )];
        if cost > 0 {
            credit_lines.push(line(
                expense_account
                    .as_deref()
                    .ok_or_else(|| reject("Compte de charge manquant."))?,
                -sign * cost,
                "Correction du coût de l’achat",
                &project,
            ));
        }
        if total > cost {
            credit_lines.push(line(
                vat_account
                    .as_deref()
                    .ok_or_else(|| reject("Compte de TVA manquant."))?,
                -sign * (total - cost),
                "Correction de TVA préalable",
                &project,
            ));
        }
        let credit = post_entry(
            &tx,
            &input.credit_date,
            &description,
            "expense_refund",
            &id,
            "credit",
            credit_lines,
        )?;
        let payment = post_entry(
            &tx,
            &input.payment_date,
            &description,
            "expense_refund",
            &id,
            "payment",
            vec![
                line(&bank_account, sign * total, "Remboursement reçu", &project),
                line(
                    &clearing_account,
                    -sign * total,
                    "Solde de l’avoir",
                    &project,
                ),
            ],
        )?;
        tx.execute("INSERT INTO expense_refunds(id,request_id,request_json,expense_id,event_type,reverses_id,credit_date,payment_date,reference,reason,net_cents,vat_cents,total_cents,cost_cents,treatment,expense_account_id,vat_account_id,bank_account_id,clearing_account_id,credit_journal_id,payment_journal_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![id,input.request_id,request_json,input.expense_id,if sign==1{"refund"}else{"reverse"},input.reverses_id,input.credit_date,input.payment_date,input.reference,input.reason,input.net_cents,input.vat_cents,total,cost,treatment,expense_account,vat_account,bank_account,clearing_account,credit["entry"]["id"].as_str(),payment["entry"]["id"].as_str(),now_iso()])?;
        let refund = query_record_tx(&tx, "expense_refunds", &id)?;
        let mut prepared = match (&attachment, &attachment_bytes) {
            (Some(file), Some(bytes)) => Some(self.prepare_supplier_invoice_attachment_bytes(&file.original_name, bytes)?),
            _ => None,
        };
        if let Some(file) = &mut prepared {
            self.insert_prepared_expense_refund_attachment(&tx, &id, file)?;
            file.install()?;
        }
        append_audit(
            &tx,
            if sign == 1 {
                "record_refund"
            } else {
                "correct_refund"
            },
            "expense_refund",
            &id,
            &refund,
        )?;
        tx.commit()?;
        if let Some(file) = &mut prepared { file.retain(); }
        Ok(json!({"refund":refund,"already_recorded":false}))
    }
}
