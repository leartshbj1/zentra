//! One transaction owns the purchase, receipt metadata, VAT, payment and bank proof.
use super::*;
use crate::{models::CreateBankExpenseInput, vat_reporting::VatSourceClassificationInput};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

fn bounded(value: &str, label: &str, max: usize, required: bool) -> AppResult<String> {
    let value = value.trim();
    if (required && value.is_empty()) || value.chars().count() > max || value.contains('\0') {
        return Err(reject(&format!(
            "{label} : renseignez un texte de {} à {max} caractères.",
            if required { 1 } else { 0 }
        )));
    }
    Ok(value.into())
}

impl LocalStore {
    pub fn create_bank_expense(&self, input: CreateBankExpenseInput) -> AppResult<Value> {
        let request = Uuid::parse_str(input.request_id.trim())
            .map_err(|_| reject("Identifiant de création invalide."))?
            .to_string();
        let movement_id = Uuid::parse_str(input.movement_id.trim())
            .map_err(|_| reject("Mouvement bancaire invalide."))?
            .to_string();
        let date = input.date.trim();
        validate_date(date, "date du justificatif")?;
        let supplier = bounded(&input.supplier, "Fournisseur", 500, true)?;
        let reference = bounded(&input.reference, "Référence du justificatif", 255, true)?;
        let category = bounded(&input.category, "Catégorie", 255, true)?;
        let note = bounded(&input.note, "Note", 1000, false)?;
        let treatment = input.vat_treatment.trim();
        if !matches!(
            treatment,
            "input_materials" | "input_investments" | "non_deductible"
        ) {
            return Err(reject("Choisissez le traitement de la TVA de cet achat."));
        }
        let project = input
            .project_id
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(|p| {
                Uuid::parse_str(p)
                    .map(|p| p.to_string())
                    .map_err(|_| reject("Projet invalide."))
            })
            .transpose()?;
        const MAX_BYTES: usize = 25 * 1024 * 1024;
        if input.content_base64.len() > MAX_BYTES.div_ceil(3) * 4 {
            return Err(reject("Le justificatif dépasse 25 Mo."));
        }
        let bytes = STANDARD
            .decode(&input.content_base64)
            .map_err(|_| reject("Justificatif illisible."))?;
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err(reject("Joignez un justificatif de 1 octet à 25 Mo."));
        }
        let payload = json!({"movement_id":movement_id,"date":date,"supplier":supplier,"reference":reference,"category":category,"project_id":project,"vat_cents":input.vat_cents,"vat_treatment":treatment,"note":note,"original_name":input.original_name.trim(),"receipt_sha256":format!("{:x}",Sha256::digest(&bytes))});
        let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&payload)?));
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(previous) = query_all(
            &tx,
            "SELECT * FROM bank_expense_creation_requests WHERE request_id=?",
            params![request],
        )?
        .into_iter()
        .next()
        {
            if previous["payload_sha256"] != hash {
                return Err(reject("Cet essai a déjà été enregistré avec d’autres données. Actualisez les mouvements."));
            }
            let link = existing(&tx, &movement_id)?
                .ok_or_else(|| reject("La preuve bancaire est manquante."))?;
            if link["id"] != previous["reconciliation_id"] {
                return Err(reject(
                    "La preuve bancaire ne correspond plus à la création.",
                ));
            }
            let expense = query_record_tx(
                &tx,
                "expenses",
                link["expense_id"].as_str().unwrap_or_default(),
            )?;
            let journal = paid_journal(
                &tx,
                expense["id"].as_str().unwrap_or_default(),
                expense["total_cents"].as_i64().unwrap_or(0),
                expense["paid_at"].as_str().unwrap_or_default(),
            )?;
            if link["journal_entry_id"] != journal {
                return Err(reject("La preuve comptable de la création a changé."));
            }
            // Receipt verification is also required on replay; no new file is installed.
            self.verified_attachment_path(previous["attachment_id"].as_str().unwrap_or_default())?;
            return Ok(
                json!({"expense":expense,"reconciliation":link,"attachment_id":previous["attachment_id"],"already_recorded":true}),
            );
        }
        let linked: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM bank_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_supplier_reconciliations WHERE movement_id=?1) OR EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE movement_id=?1)",params![movement_id],|r|r.get(0))?;
        if linked {
            return Err(reject(
                "Ce mouvement est déjà rapproché. Actualisez les mouvements.",
            ));
        }
        let movement = query_record_tx(&tx, "bank_movements", &movement_id)?;
        let paid_at = eligible_movement(&tx, &movement)?;
        if date > paid_at.as_str() {
            return Err(reject(
                "La date du justificatif ne peut pas suivre le paiement bancaire.",
            ));
        }
        ensure_accounting_date_open(&tx, date)?;
        ensure_accounting_date_open(&tx, &paid_at)?;
        let total = movement["amount_cents"].as_i64().unwrap_or(0);
        if total <= 0 || input.vat_cents < 0 || input.vat_cents >= total {
            return Err(reject(
                "La TVA doit être positive ou nulle et inférieure au montant du débit.",
            ));
        }
        if let Some(id) = &project {
            query_record_tx(&tx, "projects", id)?;
        }
        // Reject an already entered receipt, including supplier invoices, rather than guessing.
        let duplicate: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM expenses WHERE lower(trim(supplier))=lower(?1) AND lower(trim(reference))=lower(?2)) OR EXISTS(SELECT 1 FROM supplier_invoices WHERE lower(trim(supplier_name))=lower(?1) AND lower(trim(reference))=lower(?2)) OR EXISTS(SELECT 1 FROM attachments WHERE sha256=?3 AND entity_type IN ('expense','supplier_invoice'))",params![supplier,reference,payload["receipt_sha256"].as_str()],|r|r.get(0))?;
        if duplicate {
            return Err(reject("Ce justificatif ou cette référence fournisseur existe déjà dans les achats. Rapprochez la dépense ou la facture existante."));
        }
        let mut receipt =
            self.prepare_supplier_invoice_attachment_bytes(&input.original_name, &bytes)?;
        let expense_id = Uuid::new_v4().to_string();
        let now = now_iso();
        tx.execute("INSERT INTO expenses(id,project_id,date,supplier,category,reference,currency,net_cents,vat_cents,total_cents,payment_status,paid_at,note,created_at,updated_at) VALUES(?,?,?,?,?,?,'CHF',?,?,?,'paid',?,?,?,?)",params![expense_id,project,date,supplier,category,reference,total-input.vat_cents,input.vat_cents,total,paid_at,note,now,now])?;
        let attachment_id = self.insert_prepared_expense_attachment(&tx, &expense_id, &receipt)?;
        post_expense_if_enabled(&tx, &expense_id)?.ok_or_else(|| {
            reject(
                "Activez la comptabilité et ses comptes de liaison avant de créer cette dépense.",
            )
        })?;
        self.set_vat_source_classification_in_transaction(&tx,VatSourceClassificationInput {source_type:"expense".into(),source_id:expense_id.clone(),treatment:treatment.into(),note:Some("Traitement choisi lors de la création depuis le relevé bancaire, justificatif joint.".into())})?;
        let journal = paid_journal(&tx, &expense_id, total, &paid_at)?;
        let id = Uuid::new_v4().to_string();
        tx.execute("INSERT INTO bank_expense_reconciliations(id,movement_id,expense_id,journal_entry_id,amount_cents,confirmed_at) VALUES(?,?,?,?,?,?)",params![id,movement_id,expense_id,journal,total,now])?;
        tx.execute("INSERT INTO bank_expense_creation_requests(request_id,payload_sha256,reconciliation_id,attachment_id,created_at) VALUES(?,?,?,?,?)",params![request,hash,id,attachment_id,now])?;
        let result = json!({"expense":query_record_tx(&tx,"expenses",&expense_id)?,"reconciliation":existing(&tx,&movement_id)?,"attachment_id":attachment_id,"already_recorded":false});
        append_audit(
            &tx,
            "create_from_bank",
            "expenses",
            &expense_id,
            &json!({"result":result,"request_id":request,"payload_sha256":hash}),
        )?;
        receipt.install()?;
        tx.commit()?;
        receipt.retain();
        Ok(result)
    }
}
