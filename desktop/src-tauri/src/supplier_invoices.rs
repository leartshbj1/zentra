use std::collections::HashSet;

use chrono::NaiveDate;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    accounting::{ensure_accounting_date_open, post_entry, EntryLine},
    attachments::{delete_draft_attachments_in_transaction, supplier_invoice_attachment_snapshot},
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
    models::{RecordSupplierPaymentInput, SaveSupplierInvoiceDraftInput, SupplierInvoiceLineInput},
};

#[derive(Debug)]
struct PreparedLine {
    id: String,
    description: String,
    quantity_milli: i64,
    unit: String,
    unit_price_cents: i64,
    discount_bp: i64,
    vat_bp: i64,
    net_cents: i64,
    vat_cents: i64,
    total_cents: i64,
    category: String,
    expense_account_id: Option<String>,
    project_id: Option<String>,
}

type ExistingPaymentRow = (
    String,
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
);

type SupplierPaymentContextRow = (
    String,
    String,
    i64,
    i64,
    String,
    Option<String>,
    Option<String>,
);

type SupplierInvoiceValidationRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    i64,
    i64,
    i64,
    Option<String>,
    Option<String>,
);

type SupplierAccountingSettingsRow = (bool, Option<String>, Option<String>, Option<String>);

impl LocalStore {
    pub fn save_supplier_invoice_draft(
        &self,
        input: SaveSupplierInvoiceDraftInput,
    ) -> AppResult<Value> {
        let supplier_id = required(&input.supplier_id, "fournisseur", 100)?;
        let document_date = date(&input.date, "date de facture")?;
        let due_date = date(&input.due_date, "échéance")?;
        if due_date < document_date {
            return Err(AppError::Validation(
                "L’échéance ne peut pas précéder la date de la facture fournisseur.".into(),
            ));
        }
        if input.items.is_empty() {
            return Err(AppError::Validation(
                "Ajoutez au moins une ligne à la facture fournisseur.".into(),
            ));
        }
        if input.items.len() > 250 {
            return Err(AppError::Validation(
                "Une facture fournisseur ne peut pas dépasser 250 lignes.".into(),
            ));
        }
        let reference = optional_text(input.reference.as_deref(), "référence", 200)?;
        let note = optional_text(input.note.as_deref(), "note", 10_000)?;
        let project_id = optional_id(input.project_id.as_deref());
        if let Some(id) = input.id.as_deref().filter(|id| !id.trim().is_empty()) {
            Uuid::parse_str(id).map_err(|_| {
                AppError::Validation(
                    "L’identifiant technique du brouillon fournisseur est invalide.".into(),
                )
            })?;
        }

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let existing_supplier_id = if let Some(id) =
            input.id.as_deref().filter(|id| !id.trim().is_empty())
        {
            let row = tx
                .query_row(
                    "SELECT supplier_id,status FROM supplier_invoices WHERE id=?",
                    params![id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            if let Some((supplier_id, status)) = row {
                if status != "draft" {
                    return Err(AppError::Validation(
                        "Une facture fournisseur validée est immuable. Corrigez-la plus tard avec un avoir fournisseur."
                            .into(),
                    ));
                }
                Some(supplier_id)
            } else {
                None
            }
        } else {
            None
        };

        let (supplier_name, supplier_archived): (String, bool) = tx
            .query_row(
                "SELECT name,archived_at IS NOT NULL FROM suppliers WHERE id=?",
                params![supplier_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("suppliers/{supplier_id}")))?;
        if supplier_archived && existing_supplier_id.as_deref() != Some(supplier_id.as_str()) {
            return Err(AppError::Validation(
                "Ce fournisseur est archivé. Réactivez-le avant de créer une nouvelle facture."
                    .into(),
            ));
        }
        validate_optional_project(&tx, project_id.as_deref())?;

        let (vat_registered, default_vat_bp, extra_settings): (bool, i64, String) = tx.query_row(
            "SELECT vat_registered,default_vat_bp,extra_settings_json FROM settings WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let allowed_vat_rates = configured_vat_rates(default_vat_bp, &extra_settings);
        let mut lines = Vec::with_capacity(input.items.len());
        let mut net_cents = 0_i64;
        let mut vat_cents = 0_i64;
        for line in input.items {
            let prepared = prepare_line(
                &tx,
                line,
                project_id.as_deref(),
                vat_registered,
                &allowed_vat_rates,
            )?;
            net_cents = net_cents.checked_add(prepared.net_cents).ok_or_else(|| {
                AppError::Validation("Le total net de la facture est trop élevé.".into())
            })?;
            vat_cents = vat_cents.checked_add(prepared.vat_cents).ok_or_else(|| {
                AppError::Validation("Le total TVA de la facture est trop élevé.".into())
            })?;
            lines.push(prepared);
        }
        let total_cents = net_cents
            .checked_add(vat_cents)
            .ok_or_else(|| AppError::Validation("Le total de la facture est trop élevé.".into()))?;
        if total_cents <= 0 {
            return Err(AppError::Validation(
                "Le total de la facture fournisseur doit être supérieur à zéro.".into(),
            ));
        }

        let id = input
            .id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let before = query_all(
            &tx,
            "SELECT * FROM supplier_invoices WHERE id=?",
            params![id],
        )?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
        let now = now_iso();
        if before.is_null() {
            tx.execute(
                "INSERT INTO supplier_invoices(id,supplier_id,project_id,document_date,due_date,supplier_name,reference,reference_normalized,currency,status,net_cents,vat_cents,total_cents,paid_cents,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'draft',?,?,?,0,?,?,?)",
                params![id,supplier_id,project_id,document_date,due_date,supplier_name,reference,normalize_reference(reference.as_deref()),"CHF",net_cents,vat_cents,total_cents,note,now,now],
            )?;
        } else {
            tx.execute(
                "UPDATE supplier_invoices SET supplier_id=?,project_id=?,document_date=?,due_date=?,supplier_name=?,reference=?,reference_normalized=?,currency='CHF',net_cents=?,vat_cents=?,total_cents=?,note=?,updated_at=? WHERE id=? AND status='draft'",
                params![supplier_id,project_id,document_date,due_date,supplier_name,reference,normalize_reference(reference.as_deref()),net_cents,vat_cents,total_cents,note,now,id],
            )?;
            tx.execute(
                "DELETE FROM supplier_invoice_items WHERE supplier_invoice_id=?",
                params![id],
            )?;
        }
        for (position, line) in lines.iter().enumerate() {
            tx.execute(
                "INSERT INTO supplier_invoice_items(id,supplier_invoice_id,position,description,quantity_milli,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,category,expense_account_id,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![line.id,id,position as i64,line.description,line.quantity_milli,line.unit,line.unit_price_cents,line.discount_bp,line.vat_bp,line.net_cents,line.vat_cents,line.total_cents,line.category,line.expense_account_id,line.project_id,now,now],
            )?;
        }
        let result = supplier_invoice_bundle(&tx, &id)?;
        append_audit(
            &tx,
            if before.is_null() { "create" } else { "update" },
            "supplier_invoice_draft",
            &id,
            &json!({"before":before,"after":result}),
        )?;
        tx.commit()?;
        Ok(result)
    }

    pub fn validate_supplier_invoice(&self, id: &str) -> AppResult<Value> {
        let id = required(id, "facture fournisseur", 100)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = validate_supplier_invoice_in_transaction(&tx, &id)?;
        append_audit(&tx, "validate", "supplier_invoice", &id, &result)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn record_supplier_payment(&self, input: RecordSupplierPaymentInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = record_supplier_payment_in_transaction(&tx, input)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn delete_supplier_invoice_draft(&self, id: &str) -> AppResult<Value> {
        let id = required(id, "facture fournisseur", 100)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let before = query_all(
            &tx,
            "SELECT * FROM supplier_invoices WHERE id=?",
            params![id],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound(format!("supplier_invoices/{id}")))?;
        if before["status"] != "draft" {
            return Err(AppError::Validation(
                "Seul un brouillon fournisseur peut être supprimé.".into(),
            ));
        }
        let attachment_files = delete_draft_attachments_in_transaction(&tx, &id)?;
        // Supprimer les lignes tant que le parent est encore visible comme
        // brouillon : leur garde SQL interdit toute suppression après validation.
        tx.execute(
            "DELETE FROM supplier_invoice_items WHERE supplier_invoice_id=?",
            params![id],
        )?;
        tx.execute("DELETE FROM supplier_invoices WHERE id=?", params![id])?;
        append_audit(&tx, "delete", "supplier_invoice_draft", &id, &before)?;
        tx.commit()?;
        self.remove_stored_attachment_files(&attachment_files)?;
        Ok(json!({"deleted":true,"id":id}))
    }
}

/// Noyau transactionnel unique des paiements fournisseurs. Le rapprochement
/// CAMT l'appelle dans sa transaction `Immediate` afin que paiement, écriture
/// et lien bancaire soient validés ou annulés ensemble.
pub(crate) fn record_supplier_payment_in_transaction(
    tx: &Transaction<'_>,
    input: RecordSupplierPaymentInput,
) -> AppResult<Value> {
    let request_id = required(&input.request_id, "identifiant de requête", 120)?;
    Uuid::parse_str(&request_id).map_err(|_| {
        AppError::Validation(
            "L’identifiant technique du paiement est invalide; rouvrez le formulaire et réessayez."
                .into(),
        )
    })?;
    let invoice_id = required(&input.supplier_invoice_id, "facture fournisseur", 100)?;
    let payment_date = date(&input.date, "date de paiement")?;
    if input.amount_cents <= 0 {
        return Err(AppError::Validation(
            "Le montant du paiement doit être supérieur à zéro.".into(),
        ));
    }
    let method = optional_text(input.method.as_deref(), "mode de paiement", 100)?;
    let reference = optional_text(input.reference.as_deref(), "référence", 200)?;
    let notes = optional_text(input.notes.as_deref(), "note", 2_000)?;

    let existing_payment: Option<ExistingPaymentRow> = tx
        .query_row(
            "SELECT id,supplier_invoice_id,date,amount_cents,method,reference,notes FROM supplier_payments WHERE request_id=?",
            params![request_id],
            |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,Option<String>>(5)?,row.get::<_,Option<String>>(6)?)),
        )
        .optional()?;
    if let Some((
        existing_id,
        existing_invoice,
        existing_date,
        existing_amount,
        existing_method,
        existing_reference,
        existing_notes,
    )) = existing_payment
    {
        if existing_invoice != invoice_id
            || existing_date != payment_date
            || existing_amount != input.amount_cents
            || existing_method != method
            || existing_reference != reference
            || existing_notes != notes
        {
            return Err(AppError::Validation(format!(
                "L’identifiant de paiement {request_id} existe déjà avec d’autres données. Elyko bloque le doublon."
            )));
        }
        let result = supplier_invoice_bundle(tx, &invoice_id)?;
        return Ok(json!({"payment_id":existing_id,"idempotent":true,"document":result}));
    }

    let payment_context: SupplierPaymentContextRow = tx
        .query_row(
            "SELECT status,document_date,total_cents,paid_cents,currency,project_id,validation_journal_entry_id FROM supplier_invoices WHERE id=?",
            params![invoice_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("supplier_invoices/{invoice_id}")))?;
    let (
        status,
        document_date,
        total_cents,
        paid_cents,
        currency,
        project_id,
        validation_journal_entry_id,
    ) = payment_context;
    if status != "validated" {
        return Err(AppError::Validation(
            "Validez d’abord la facture fournisseur avant d’enregistrer son paiement.".into(),
        ));
    }
    if payment_date < document_date {
        return Err(AppError::Validation(
            "La date du paiement ne peut pas précéder la date de la facture.".into(),
        ));
    }
    let remaining = total_cents.checked_sub(paid_cents).ok_or_else(|| {
        AppError::Validation("Le solde fournisseur enregistré est incohérent.".into())
    })?;
    if input.amount_cents > remaining {
        return Err(AppError::Validation(format!(
            "Le paiement dépasse le solde restant de {:.2} CHF.",
            remaining as f64 / 100.0
        )));
    }
    ensure_accounting_date_open(tx, &payment_date)?;
    let bank_account: String = tx
        .query_row(
            "SELECT bank_account_id FROM accounting_settings WHERE id=1 AND enabled=1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::Validation(
                "Le compte bancaire de liaison doit être configuré avant le paiement fournisseur."
                    .into(),
            )
        })?;
    require_active_account(tx, &bank_account, "asset", "Le compte bancaire")?;
    let validation_journal_entry_id = validation_journal_entry_id.ok_or_else(|| {
        AppError::Validation("L’écriture de validation fournisseur est absente.".into())
    })?;
    let mut payable_accounts = tx
        .prepare(
            "SELECT lines.account_id FROM journal_lines lines JOIN accounts account ON account.id=lines.account_id WHERE lines.journal_entry_id=? AND lines.credit_cents=? AND lines.debit_cents=0 AND account.account_type='liability'",
        )?
        .query_map(params![validation_journal_entry_id,total_cents], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    payable_accounts.sort();
    payable_accounts.dedup();
    let payable_account = match payable_accounts.as_slice() {
        [account] => account.clone(),
        _ => return Err(AppError::Validation("Le compte de dette fournisseur figé dans l’écriture d’origine n’est pas identifiable de manière unique.".into())),
    };
    require_active_account(
        tx,
        &payable_account,
        "liability",
        "Le compte de dette fournisseur figé",
    )?;

    let payment_id = Uuid::new_v4().to_string();
    let lines = vec![
        EntryLine {
            account_id: payable_account,
            debit_cents: input.amount_cents,
            credit_cents: 0,
            currency: currency.clone(),
            memo: Some("Règlement dette fournisseur".into()),
            project_id: project_id.clone(),
            client_id: None,
            employee_id: None,
        },
        EntryLine {
            account_id: bank_account,
            debit_cents: 0,
            credit_cents: input.amount_cents,
            currency,
            memo: Some("Paiement fournisseur".into()),
            project_id,
            client_id: None,
            employee_id: None,
        },
    ];
    let journal = post_entry(
        tx,
        &payment_date,
        "Paiement fournisseur",
        "supplier_payment",
        &payment_id,
        &format!("invoice:{invoice_id}"),
        lines,
    )?;
    let journal_id = journal["id"].as_str().ok_or_else(|| {
        AppError::Validation("L’écriture du paiement fournisseur n’a pas d’identifiant.".into())
    })?;
    let now = now_iso();
    tx.execute(
        "INSERT INTO supplier_payments(id,supplier_invoice_id,request_id,date,amount_cents,method,reference,notes,journal_entry_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        params![payment_id,invoice_id,request_id,payment_date,input.amount_cents,method,reference,notes,journal_id,now],
    )?;
    let result = supplier_invoice_bundle(tx, &invoice_id)?;
    append_audit(
        tx,
        "record",
        "supplier_payment",
        &payment_id,
        &json!({"request_id":request_id,"document":result}),
    )?;
    Ok(json!({"payment_id":payment_id,"idempotent":false,"document":result}))
}

fn validate_supplier_invoice_in_transaction(tx: &Transaction<'_>, id: &str) -> AppResult<Value> {
    let invoice_row: SupplierInvoiceValidationRow = tx
        .query_row(
            "SELECT status,supplier_id,supplier_name,document_date,due_date,reference,reference_normalized,currency,net_cents,vat_cents,total_cents,project_id,note FROM supplier_invoices WHERE id=?",
            params![id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,row.get(12)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("supplier_invoices/{id}")))?;
    let (
        status,
        supplier_id,
        supplier_name,
        document_date,
        due_date,
        reference,
        reference_normalized,
        currency,
        net_cents,
        vat_cents,
        total_cents,
        project_id,
        note,
    ) = invoice_row;
    if status != "draft" {
        return Err(AppError::Validation(
            "Cette facture fournisseur est déjà validée et verrouillée.".into(),
        ));
    }
    let normalized = reference_normalized
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::Validation(
                "Le numéro ou la référence du fournisseur est obligatoire avant validation.".into(),
            )
        })?;
    if total_cents <= 0
        || net_cents < 0
        || vat_cents < 0
        || net_cents.checked_add(vat_cents) != Some(total_cents)
    {
        return Err(AppError::Validation(
            "Les totaux de la facture fournisseur sont incohérents.".into(),
        ));
    }
    let duplicate: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM supplier_invoices WHERE id<>? AND supplier_id=? AND reference_normalized=? AND status='validated')",
        params![id,supplier_id,normalized],
        |row| row.get(0),
    )?;
    if duplicate {
        return Err(AppError::Validation(
            "Une facture validée de ce fournisseur possède déjà la même référence.".into(),
        ));
    }
    ensure_accounting_date_open(tx, &document_date)?;
    let settings: Option<SupplierAccountingSettingsRow> = tx
        .query_row(
            "SELECT enabled,expense_account_id,vat_receivable_account_id,supplier_payable_account_id FROM accounting_settings WHERE id=1",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        )
        .optional()?;
    let (enabled, default_expense, vat_receivable, payable) = settings.ok_or_else(|| {
        AppError::Validation(
            "Configurez la comptabilité avant de valider une facture fournisseur.".into(),
        )
    })?;
    if !enabled {
        return Err(AppError::Validation(
            "Activez la comptabilité avant de valider une facture fournisseur.".into(),
        ));
    }
    let default_expense = required_option(default_expense, "compte de charges")?;
    let vat_receivable = required_option(vat_receivable, "compte de TVA préalable")?;
    let payable = required_option(
        payable,
        "compte de dettes fournisseurs dans Plan & liaisons",
    )?;
    require_active_account(tx, &default_expense, "expense", "Le compte de charges")?;
    require_active_account(tx, &vat_receivable, "asset", "Le compte de TVA préalable")?;
    require_active_account(
        tx,
        &payable,
        "liability",
        "Le compte de dettes fournisseurs",
    )?;

    let items = query_all(
        tx,
        "SELECT * FROM supplier_invoice_items WHERE supplier_invoice_id=? ORDER BY position,rowid",
        params![id],
    )?;
    if items.is_empty() {
        return Err(AppError::Validation(
            "La facture fournisseur doit contenir au moins une ligne.".into(),
        ));
    }
    validate_stored_lines_for_current_tax_rules(tx, &items, net_cents, vat_cents, total_cents)?;
    let mut lines = Vec::new();
    for item in &items {
        let amount = item["line_net_cents"].as_i64().unwrap_or(-1);
        if amount <= 0 {
            continue;
        }
        let account_id = item["expense_account_id"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&default_expense)
            .to_owned();
        require_active_account(
            tx,
            &account_id,
            "expense",
            "Le compte de charge de la ligne",
        )?;
        lines.push(EntryLine {
            account_id,
            debit_cents: amount,
            credit_cents: 0,
            currency: currency.clone(),
            memo: item["description"].as_str().map(ToOwned::to_owned),
            project_id: item["project_id"]
                .as_str()
                .map(ToOwned::to_owned)
                .or_else(|| project_id.clone()),
            client_id: None,
            employee_id: None,
        });
    }
    if vat_cents > 0 {
        lines.push(EntryLine {
            account_id: vat_receivable,
            debit_cents: vat_cents,
            credit_cents: 0,
            currency: currency.clone(),
            memo: Some("TVA préalable fournisseur".into()),
            project_id: project_id.clone(),
            client_id: None,
            employee_id: None,
        });
    }
    lines.push(EntryLine {
        account_id: payable,
        debit_cents: 0,
        credit_cents: total_cents,
        currency: currency.clone(),
        memo: Some("Dette fournisseur".into()),
        project_id: project_id.clone(),
        client_id: None,
        employee_id: None,
    });
    let attachment_snapshot = supplier_invoice_attachment_snapshot(tx, id)?;
    let snapshot = json!({
        "schema":"elyko.supplier_invoice_snapshot.v1",
        "captured_at":now_iso(),
        "document":{"id":id,"supplier_id":supplier_id,"supplier_name":supplier_name,"document_date":document_date,"due_date":due_date,"reference":reference,"currency":currency,"net_cents":net_cents,"vat_cents":vat_cents,"total_cents":total_cents,"project_id":project_id,"note":note},
        "supplier":query_all(tx,"SELECT * FROM suppliers WHERE id=?",params![supplier_id])?.into_iter().next(),
        "items":items,
        "attachments":attachment_snapshot,
    });
    let journal = post_entry(
        tx,
        &document_date,
        &format!(
            "Facture fournisseur {} · {}",
            supplier_name,
            reference.as_deref().unwrap_or_default()
        ),
        "supplier_invoice",
        id,
        "validate",
        lines,
    )?;
    let journal_id = journal["id"].as_str().ok_or_else(|| {
        AppError::Validation("L’écriture fournisseur n’a pas d’identifiant.".into())
    })?;
    let now = now_iso();
    tx.execute(
        "UPDATE supplier_invoices SET status='validated',validated_at=?,validation_journal_entry_id=?,snapshot_json=?,updated_at=? WHERE id=? AND status='draft'",
        params![now,journal_id,serde_json::to_string(&snapshot)?,now,id],
    )?;
    supplier_invoice_bundle(tx, id)
}

fn prepare_line(
    tx: &Transaction<'_>,
    input: SupplierInvoiceLineInput,
    invoice_project_id: Option<&str>,
    vat_registered: bool,
    allowed_vat_rates: &HashSet<i64>,
) -> AppResult<PreparedLine> {
    let description = required(&input.description, "description de ligne", 1_000)?;
    let category = required(&input.category, "catégorie de coût", 200)?;
    if input.quantity_milli <= 0 || input.quantity_milli > 1_000_000_000 {
        return Err(AppError::Validation(
            "La quantité d’une ligne doit être supérieure à zéro.".into(),
        ));
    }
    if input.unit_price_cents < 0 || input.unit_price_cents > 10_000_000_000 {
        return Err(AppError::Validation(
            "Le prix unitaire d’une ligne est invalide.".into(),
        ));
    }
    if !(0..=10_000).contains(&input.discount_bp) || !(0..=10_000).contains(&input.vat_bp) {
        return Err(AppError::Validation(
            "La remise et le taux TVA doivent être compris entre 0 et 100 %.".into(),
        ));
    }
    if !vat_registered && input.vat_bp != 0 {
        return Err(AppError::Validation(
            "L’entreprise n’est pas déclarée assujettie à la TVA; utilisez un taux nul.".into(),
        ));
    }
    if vat_registered && input.vat_bp != 0 && !allowed_vat_rates.contains(&input.vat_bp) {
        return Err(AppError::Validation(format!(
            "Le taux TVA {:.2} % n’est pas configuré dans les paramètres de l’entreprise.",
            input.vat_bp as f64 / 100.0
        )));
    }
    let base = rounded_ratio(
        input.quantity_milli as i128 * input.unit_price_cents as i128,
        1_000,
        "montant de ligne",
    )?;
    let discount = rounded_ratio(
        base as i128 * input.discount_bp as i128,
        10_000,
        "remise de ligne",
    )?;
    let net_cents = base
        .checked_sub(discount)
        .ok_or_else(|| AppError::Validation("La remise de ligne dépasse son montant.".into()))?;
    let vat_cents = rounded_ratio(
        net_cents as i128 * input.vat_bp as i128,
        10_000,
        "TVA de ligne",
    )?;
    let total_cents = net_cents
        .checked_add(vat_cents)
        .ok_or_else(|| AppError::Validation("Le total de ligne est trop élevé.".into()))?;
    let project_id = optional_id(input.project_id.as_deref());
    validate_optional_project(tx, project_id.as_deref().or(invoice_project_id))?;
    let expense_account_id = optional_id(input.expense_account_id.as_deref());
    if let Some(account_id) = expense_account_id.as_deref() {
        require_active_account(tx, account_id, "expense", "Le compte de charge de la ligne")?;
    }
    let id = input
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    Uuid::parse_str(&id).map_err(|_| {
        AppError::Validation("L’identifiant technique d’une ligne fournisseur est invalide.".into())
    })?;
    Ok(PreparedLine {
        id,
        description,
        quantity_milli: input.quantity_milli,
        unit: optional_text(input.unit.as_deref(), "unité", 50)?.unwrap_or_else(|| "unité".into()),
        unit_price_cents: input.unit_price_cents,
        discount_bp: input.discount_bp,
        vat_bp: input.vat_bp,
        net_cents,
        vat_cents,
        total_cents,
        category,
        expense_account_id,
        project_id,
    })
}

fn supplier_invoice_bundle(tx: &Transaction<'_>, id: &str) -> AppResult<Value> {
    let invoice = query_all(
        tx,
        "SELECT * FROM supplier_invoices WHERE id=?",
        params![id],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| AppError::NotFound(format!("supplier_invoices/{id}")))?;
    let items = query_all(
        tx,
        "SELECT * FROM supplier_invoice_items WHERE supplier_invoice_id=? ORDER BY position,rowid",
        params![id],
    )?;
    let payments = query_all(
        tx,
        "SELECT * FROM supplier_payments WHERE supplier_invoice_id=? ORDER BY date,created_at",
        params![id],
    )?;
    Ok(json!({"invoice":invoice,"items":items,"payments":payments}))
}

fn require_active_account(
    tx: &Transaction<'_>,
    id: &str,
    expected_type: &str,
    label: &str,
) -> AppResult<()> {
    let row: Option<(String, bool)> = tx
        .query_row(
            "SELECT account_type,active FROM accounts WHERE id=?",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (actual_type, active) = row.ok_or_else(|| AppError::NotFound(format!("accounts/{id}")))?;
    if !active {
        return Err(AppError::Validation(format!("{label} est inactif.")));
    }
    if actual_type != expected_type {
        return Err(AppError::Validation(format!(
            "{label} doit être de type {expected_type}."
        )));
    }
    Ok(())
}

fn validate_optional_project(tx: &Transaction<'_>, id: Option<&str>) -> AppResult<()> {
    let Some(id) = id else {
        return Ok(());
    };
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
        params![id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(AppError::NotFound(format!("projects/{id}")));
    }
    Ok(())
}

fn configured_vat_rates(default_rate: i64, extra_settings: &str) -> HashSet<i64> {
    let mut rates = HashSet::from([0, default_rate]);
    if let Ok(value) = serde_json::from_str::<Value>(extra_settings) {
        if let Some(configured) = value
            .get("billing")
            .and_then(|billing| billing.get("vatRatesBp"))
            .and_then(Value::as_array)
        {
            rates.extend(configured.iter().filter_map(Value::as_i64));
        }
    }
    rates
}

fn validate_stored_lines_for_current_tax_rules(
    tx: &Transaction<'_>,
    items: &[Value],
    expected_net_cents: i64,
    expected_vat_cents: i64,
    expected_total_cents: i64,
) -> AppResult<()> {
    let (vat_registered, default_vat_bp, extra_settings): (bool, i64, String) = tx.query_row(
        "SELECT vat_registered,default_vat_bp,extra_settings_json FROM settings WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let allowed_vat_rates = configured_vat_rates(default_vat_bp, &extra_settings);
    let mut net_cents = 0_i64;
    let mut vat_cents = 0_i64;
    let mut total_cents = 0_i64;

    for item in items {
        let quantity_milli = stored_i64(item, "quantity_milli")?;
        let unit_price_cents = stored_i64(item, "unit_price_cents")?;
        let discount_bp = stored_i64(item, "discount_bp")?;
        let vat_bp = stored_i64(item, "vat_bp")?;
        let stored_net = stored_i64(item, "line_net_cents")?;
        let stored_vat = stored_i64(item, "line_vat_cents")?;
        let stored_total = stored_i64(item, "line_total_cents")?;
        if quantity_milli <= 0
            || unit_price_cents < 0
            || !(0..=10_000).contains(&discount_bp)
            || !(0..=10_000).contains(&vat_bp)
        {
            return Err(AppError::Validation(
                "Une ligne fournisseur enregistrée contient une quantité, un prix ou un taux invalide."
                    .into(),
            ));
        }
        if (!vat_registered && vat_bp != 0)
            || (vat_registered && vat_bp != 0 && !allowed_vat_rates.contains(&vat_bp))
        {
            return Err(AppError::Validation(format!(
                "Le taux TVA {:.2} % d’une ligne n’est plus compatible avec la configuration actuelle. Corrigez le brouillon ou les taux avant validation.",
                vat_bp as f64 / 100.0
            )));
        }
        let base = rounded_ratio(
            quantity_milli as i128 * unit_price_cents as i128,
            1_000,
            "montant de ligne enregistré",
        )?;
        let discount = rounded_ratio(
            base as i128 * discount_bp as i128,
            10_000,
            "remise de ligne enregistrée",
        )?;
        let calculated_net = base.checked_sub(discount).ok_or_else(|| {
            AppError::Validation("La remise d’une ligne enregistrée est incohérente.".into())
        })?;
        let calculated_vat = rounded_ratio(
            calculated_net as i128 * vat_bp as i128,
            10_000,
            "TVA de ligne enregistrée",
        )?;
        let calculated_total = calculated_net
            .checked_add(calculated_vat)
            .ok_or_else(|| AppError::Validation("Le total d’une ligne est trop élevé.".into()))?;
        if (stored_net, stored_vat, stored_total)
            != (calculated_net, calculated_vat, calculated_total)
        {
            return Err(AppError::Validation(
                "Les montants d’une ligne fournisseur ne correspondent plus à sa quantité, sa remise et sa TVA."
                    .into(),
            ));
        }
        net_cents = net_cents
            .checked_add(stored_net)
            .ok_or_else(|| AppError::Validation("Le total net est trop élevé.".into()))?;
        vat_cents = vat_cents
            .checked_add(stored_vat)
            .ok_or_else(|| AppError::Validation("Le total TVA est trop élevé.".into()))?;
        total_cents = total_cents
            .checked_add(stored_total)
            .ok_or_else(|| AppError::Validation("Le total TTC est trop élevé.".into()))?;
    }
    if (net_cents, vat_cents, total_cents)
        != (expected_net_cents, expected_vat_cents, expected_total_cents)
    {
        return Err(AppError::Validation(
            "Les totaux du document ne correspondent pas aux lignes fournisseur.".into(),
        ));
    }
    Ok(())
}

fn stored_i64(item: &Value, field: &str) -> AppResult<i64> {
    item[field].as_i64().ok_or_else(|| {
        AppError::Validation(format!(
            "Le champ interne {field} d’une ligne fournisseur est invalide."
        ))
    })
}

fn rounded_ratio(value: i128, divisor: i128, label: &str) -> AppResult<i64> {
    if value < 0 || divisor <= 0 {
        return Err(AppError::Validation(format!("Le {label} est invalide.")));
    }
    let rounded = value
        .checked_add(divisor / 2)
        .and_then(|value| value.checked_div(divisor))
        .ok_or_else(|| AppError::Validation(format!("Le {label} est trop élevé.")))?;
    i64::try_from(rounded).map_err(|_| AppError::Validation(format!("Le {label} est trop élevé.")))
}

fn required(value: &str, label: &str, max: usize) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(AppError::Validation(format!(
            "Le champ {label} est obligatoire et limité à {max} caractères."
        )));
    }
    Ok(value.to_owned())
}

fn required_option(value: Option<String>, label: &str) -> AppResult<String> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Validation(format!("Configurez le {label}.")))
}

fn optional_text(value: Option<&str>, label: &str, max: usize) -> AppResult<Option<String>> {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    if value.is_some_and(|value| value.chars().count() > max) {
        return Err(AppError::Validation(format!(
            "Le champ {label} est limité à {max} caractères."
        )));
    }
    Ok(value.map(ToOwned::to_owned))
}

fn optional_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn date(value: &str, label: &str) -> AppResult<String> {
    let value = value.trim();
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::Validation(format!("La {label} doit être au format AAAA-MM-JJ.")))?;
    Ok(value.to_owned())
}

fn normalize_reference(value: Option<&str>) -> Option<String> {
    let normalized = value
        .unwrap_or_default()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect::<String>();
    (!normalized.is_empty()).then_some(normalized)
}
