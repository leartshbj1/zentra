//! Support mailbox handoff. Originals and drafts commit together; retries never overwrite an edited invoice.
use crate::{
    account_cloud::project_sync_session,
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
    models::{SaveSupplierInvoiceDraftInput, SupplierInvoiceLineInput},
};
use reqwest::Method;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::State;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub(crate) const PATH: &str = "/api/supplier-inbox";
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn normalized(value: &str) -> String {
    value
        .nfkd()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn text<'a>(value: &'a Value, key: &str) -> AppResult<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| invalid("Complétez les informations de la facture avant de continuer."))
}
fn existing_import(store: &LocalStore, item: &Value) -> AppResult<Option<Value>> {
    let id = text(item, "id")?;
    let db = store.connect()?;
    let existing:Option<(String,String)>=db.query_row("SELECT i.status,p.attachment_sha256 FROM supplier_invoices i JOIN supplier_email_invoice_imports p ON p.supplier_invoice_id=i.id WHERE i.id=?",params![id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((status, sha)) = existing {
        if item["sha256"] != sha {
            return Err(invalid(
                "Le justificatif a changé. Ouvrez la facture existante.",
            ));
        }
        let automatic:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM audit_log WHERE entity_type='supplier_mailbox_invoice' AND entity_id=? AND json_extract(payload_json,'$.automatic')=1)",params![id],|r|r.get(0))?;
        Ok(Some(
            json!({"id":id,"automatic":automatic&&status=="validated","idempotent":true}),
        ))
    } else {
        Ok(None)
    }
}

pub(crate) fn automatic_draft(
    store: &LocalStore,
    item: &Value,
) -> AppResult<SaveSupplierInvoiceDraftInput> {
    let e = &item["extraction"];
    if e["kind"] != "supplier_invoice"
        || e["currency"] != "CHF"
        || e["confidence"].as_f64().unwrap_or(0.) < 0.95
        || !e["issues"].as_array().is_some_and(|v| v.is_empty())
    {
        return Err(invalid("Cette facture demande votre vérification."));
    }
    let n = e["netCents"]
        .as_i64()
        .ok_or_else(|| invalid("Vérifiez le montant hors taxe."))?;
    let v = e["vatCents"]
        .as_i64()
        .ok_or_else(|| invalid("Vérifiez la TVA."))?;
    let t = e["totalCents"]
        .as_i64()
        .ok_or_else(|| invalid("Vérifiez le total."))?;
    let bp = e["vatBp"]
        .as_i64()
        .ok_or_else(|| invalid("Vérifiez le taux de TVA."))?;
    if n <= 0
        || n > 1_000_000_000
        || v < 0
        || n.checked_add(v) != Some(t)
        || !(0..=10000).contains(&bp)
        || (n as i128 * bp as i128 + 5000) / 10000 != v as i128
    {
        return Err(invalid("Les montants et la TVA doivent être vérifiés."));
    }
    let db = store.connect()?;
    let name = normalized(text(e, "supplierName")?);
    let sender = text(item, "sender")?.to_lowercase();
    let suppliers = crate::database::query_all(
        &db,
        "SELECT id,name,email FROM suppliers WHERE archived_at IS NULL",
        [],
    )?;
    let matched: Vec<&Value> = suppliers
        .iter()
        .filter(|s| {
            s["email"]
                .as_str()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case(&sender))
                && s["name"].as_str().is_some_and(|v| normalized(v) == name)
        })
        .collect();
    if matched.len() != 1 {
        return Err(invalid("Choisissez le fournisseur. Le nom imprimé et l’adresse de l’expéditeur doivent correspondre à un fournisseur connu pour un import automatique."));
    }
    let supplier = text(matched[0], "id")?;
    let history=crate::database::query_all(&db,"SELECT DISTINCT l.category,l.posted_expense_account_id AS account_id FROM supplier_invoice_items l JOIN supplier_invoices i ON i.id=l.supplier_invoice_id WHERE i.supplier_id=? AND i.status='validated' AND l.posted_expense_account_id IS NOT NULL LIMIT 2",params![supplier])?;
    if history.len() != 1 {
        return Err(invalid("Validez une première facture de ce fournisseur et son compte de charges. Les prochaines pourront reprendre ce classement."));
    }
    let category = text(&history[0], "category")?;
    let expected = match e["category"].as_str().unwrap_or("") {
        "materials" => vec!["materiel", "materieletmarchandises", "marchandises"],
        "software" => vec!["logiciels"],
        "telecom" => vec!["telecommunications"],
        "rent" => vec!["loyer"],
        "insurance" => vec!["assurances"],
        "transport" => vec!["transport"],
        "services" => vec!["prestationsdeservices", "soustraitance"],
        _ => vec![],
    };
    if !expected.contains(&normalized(category).as_str()) {
        return Err(invalid("Le classement proposé diffère des achats précédents de ce fournisseur. Vérifiez le compte de charges."));
    }
    // Tax exceptions stay in the existing reviewed workflow; never infer a new tax treatment.
    let registered: bool =
        db.query_row("SELECT vat_registered FROM settings WHERE id=1", [], |r| {
            r.get(0)
        })?;
    if !registered && v > 0 {
        return Err(invalid(
            "Confirmez le traitement de la TVA pour cette entreprise non assujettie.",
        ));
    }
    Ok(SaveSupplierInvoiceDraftInput {
        id: Some(text(item, "id")?.into()),
        supplier_id: supplier.into(),
        project_id: None,
        date: text(e, "invoiceDate")?.into(),
        due_date: text(e, "dueDate")?.into(),
        reference: Some(text(e, "reference")?.into()),
        note: Some("Reçue depuis Zentra Support. Justificatif original joint.".into()),
        items: vec![SupplierInvoiceLineInput {
            id: None,
            description: format!("Facture {}", text(e, "reference")?),
            quantity_milli: 1000,
            unit: Some("forfait".into()),
            unit_price_cents: n,
            discount_bp: 0,
            vat_bp: bp,
            category: category.into(),
            expense_account_id: Some(text(&history[0], "account_id")?.into()),
            project_id: None,
        }],
    })
}

pub(crate) fn import_document(
    store: &LocalStore,
    item: &Value,
    bytes: &[u8],
    mut input: SaveSupplierInvoiceDraftInput,
    automatic: bool,
) -> AppResult<Value> {
    let id = text(item, "id")?;
    Uuid::parse_str(id).map_err(|_| invalid("La référence de réception est invalide."))?;
    let sha = text(item, "sha256")?;
    if format!("{:x}", Sha256::digest(bytes)) != sha {
        return Err(invalid("Le justificatif reçu est incomplet. Réessayez."));
    }
    input.id = Some(id.into());
    let mut db = store.connect()?;
    store.require_onboarding(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing:Option<(String,String)>=tx.query_row("SELECT i.status,p.attachment_sha256 FROM supplier_invoices i JOIN supplier_email_invoice_imports p ON p.supplier_invoice_id=i.id WHERE i.id=?",params![id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((status, proof)) = existing {
        if proof != sha {
            return Err(invalid(
                "La facture enregistrée correspond à un autre justificatif.",
            ));
        }
        return Ok(json!({"id":id,"automatic":status=="validated","idempotent":true}));
    }
    let occupied: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=?)",
        params![id],
        |r| r.get(0),
    )?;
    if occupied {
        return Err(invalid("Une facture différente utilise déjà cette référence de réception. Aucune donnée n’a été remplacée."));
    }
    let duplicate: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM supplier_email_invoice_imports WHERE attachment_sha256=?)",
        params![sha],
        |r| r.get(0),
    )?;
    if duplicate {
        return Err(invalid(
            "Ce justificatif est déjà présent dans les achats. Ouvrez la facture existante.",
        ));
    }
    let mut attachment =
        store.prepare_supplier_invoice_attachment_bytes(text(item, "fileName")?, bytes)?;
    store.save_supplier_invoice_draft_in_transaction(&tx, input, true)?;
    let inserted = store.insert_prepared_supplier_invoice_attachment(
        &tx,
        id,
        &attachment,
        "support_mailbox",
    )?;
    if inserted.created {
        attachment.install()?;
    }
    let attachment_id = text(&inserted.record, "id")?;
    // One provenance per attachment, allowing several invoices in one message.
    tx.execute("INSERT INTO supplier_email_invoice_imports(supplier_invoice_id,source_sha256,source_message_id,source_file_name,attachment_sha256,attachment_id,created_at) VALUES(?,?,?,?,?,?,?)",params![id,sha,format!("support:{id}"),text(item,"fileName")?,sha,attachment_id,now_iso()])?;
    if automatic {
        crate::supplier_invoices::validate_supplier_invoice_in_transaction(&tx, id)?;
    }
    append_audit(
        &tx,
        "import",
        "supplier_mailbox_invoice",
        id,
        &json!({"source_sha256":sha,"automatic":automatic,"attachment_id":attachment_id}),
    )?;
    tx.commit()?;
    if inserted.created {
        attachment.retain();
    }
    Ok(json!({"id":id,"automatic":automatic,"idempotent":false}))
}

#[tauri::command]
pub async fn supplier_inbox_request(
    state: State<'_, LocalStore>,
    data: Option<Value>,
) -> Result<Value, String> {
    let store = state.inner().clone();
    let _account = store.account_protected_cache.operation_lock.lock().await;
    let session = project_sync_session(&store)
        .await
        .map_err(command_error)?
        .ok_or("Connectez votre compte dans les paramètres.")?;
    crate::automation::bound(&store, &session.organization_id).map_err(command_error)?;
    let data = data.unwrap_or(Value::Null);
    if data.is_null() {
        let (_, bytes) = session
            .request(Method::GET, PATH, &[], &[], None, false)
            .await
            .map_err(command_error)?;
        return serde_json::from_slice(&bytes).map_err(|_| "La réception est indisponible.".into());
    }
    let action = data["action"].as_str().unwrap_or("");
    if session.role == "read_only" && action != "document" {
        return Err("Votre rôle permet la consultation uniquement.".into());
    }
    let id = data["id"]
        .as_str()
        .filter(|v| Uuid::parse_str(v).is_ok())
        .ok_or("Choisissez une facture reçue.")?;
    if action == "ignore" {
        let (_, bytes) = session
            .request(
                Method::POST,
                PATH,
                &[],
                &[("Content-Type", "application/json".into())],
                Some(serde_json::to_vec(&json!({"action":"ignore","id":id})).unwrap()),
                false,
            )
            .await
            .map_err(command_error)?;
        return serde_json::from_slice(&bytes).map_err(|_| "La réception est indisponible.".into());
    }
    if action == "document" {
        let (_, bytes) = session
            .request(Method::GET, PATH, &[("document", id)], &[], None, true)
            .await
            .map_err(command_error)?;
        use base64::Engine;
        return Ok(json!({"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}));
    }
    if action != "import" {
        return Err("Cette action n’est pas disponible.".into());
    }
    let automatic = data["automatic"].as_bool().unwrap_or(false);
    let (_, raw) = session
        .request(
            Method::POST,
            PATH,
            &[],
            &[("Content-Type", "application/json".into())],
            Some(
                serde_json::to_vec(&json!({"action":"claim","id":id,"automatic":automatic}))
                    .unwrap(),
            ),
            false,
        )
        .await
        .map_err(command_error)?;
    let claim: Value =
        serde_json::from_slice(&raw).map_err(|_| "La réponse de réception est invalide.")?;
    if claim["alreadyImported"] == true {
        return Ok(json!({"id":id,"alreadyImported":true}));
    }
    let item = &claim["item"];
    if item["organizationId"] != session.organization_id || item["id"] != id {
        return Err("Ce justificatif appartient à une autre réception.".into());
    }
    let (_, bytes) = session
        .request(Method::GET, PATH, &[("document", id)], &[], None, true)
        .await
        .map_err(command_error)?;
    let local_result = {
        let _guard = store.lock().map_err(command_error)?;
        store.require_write_access().map_err(command_error)?;
        crate::automation::bound(&store, &session.organization_id).map_err(command_error)?;
        match existing_import(&store, item) {
            Ok(Some(previous)) => Ok(previous),
            Err(error) => Err(error),
            Ok(None) => {
                let prepared = if automatic {
                    if claim["automaticAllowed"] != true {
                        Err(invalid("Cette facture doit être vérifiée."))
                    } else {
                        automatic_draft(&store, item)
                    }
                } else {
                    serde_json::from_value(data["invoice"].clone())
                        .map_err(|_| invalid("Complétez les informations de la facture."))
                };
                prepared.and_then(|input| import_document(&store, item, &bytes, input, automatic))
            }
        }
    };
    match local_result {
        Ok(result) => {
            let finish = json!({"action":"finish","id":id,"invoiceId":id,"claimToken":claim["claimToken"],"automatic":result["automatic"]});
            // A lost acknowledgement is retried on this device with the same invoice ID.
            let acknowledged = session
                .request(
                    Method::POST,
                    PATH,
                    &[],
                    &[("Content-Type", "application/json".into())],
                    Some(serde_json::to_vec(&finish).unwrap()),
                    false,
                )
                .await
                .is_ok();
            Ok(
                json!({"id":id,"automatic":result["automatic"],"acknowledged":acknowledged,"saved":true}),
            )
        }
        Err(error) => {
            let reason = command_error(error);
            let exists = store
                .connect()
                .ok()
                .and_then(|db| {
                    db.query_row(
                        "SELECT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=?)",
                        params![id],
                        |r| r.get::<_, bool>(0),
                    )
                    .ok()
                })
                .unwrap_or(true);
            if !exists {
                let _ = session
                    .request(
                        Method::POST,
                        PATH,
                        &[],
                        &[("Content-Type", "application/json".into())],
                        Some(
                            serde_json::to_vec(
                                &json!({"action":"release","id":id,"reason":reason}),
                            )
                            .unwrap(),
                        ),
                        false,
                    )
                    .await;
            }
            Err(reason)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (
        tempfile::TempDir,
        LocalStore,
        Value,
        Vec<u8>,
        SaveSupplierInvoiceDraftInput,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
        let db = store.connect().unwrap();
        let now = now_iso();
        db.execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise test',?,?)",params![now,now]).unwrap();
        db.execute("INSERT INTO suppliers(id,name,email,created_at,updated_at) VALUES('vendor','Acme SA','invoice@acme.example',?,?)",params![now,now]).unwrap();
        let bytes = crate::attachments::test_pdf_bytes();
        let id = Uuid::new_v4().to_string();
        let item = json!({"id":id,"fileName":"facture.pdf","sender":"invoice@acme.example","sha256":format!("{:x}",Sha256::digest(&bytes)),"extraction":{"kind":"supplier_invoice","currency":"CHF","confidence":0.99,"supplierName":"Acme SA","netCents":10000,"vatCents":0,"totalCents":10000,"vatBp":0,"reference":"A-1","invoiceDate":"2026-09-20","dueDate":"2026-10-20","category":"software","issues":[]}});
        let input = SaveSupplierInvoiceDraftInput {
            id: Some(id),
            supplier_id: "vendor".into(),
            project_id: None,
            date: "2026-09-20".into(),
            due_date: "2026-10-20".into(),
            reference: Some("A-1".into()),
            note: None,
            items: vec![SupplierInvoiceLineInput {
                id: None,
                description: "Logiciels".into(),
                quantity_milli: 1000,
                unit: None,
                unit_price_cents: 10000,
                discount_bp: 0,
                vat_bp: 0,
                category: "Logiciels".into(),
                expense_account_id: None,
                project_id: None,
            }],
        };
        (dir, store, item, bytes, input)
    }
    #[test]
    fn original_and_draft_commit_together_and_retries_preserve_edits() {
        let (_dir, store, item, bytes, input) = fixture();
        let first = import_document(&store, &item, &bytes, input.clone(), false).unwrap();
        assert_eq!(first["idempotent"], false);
        let mut edited = input.clone();
        edited.reference = Some("CORRECTED".into());
        store.save_supplier_invoice_draft(edited).unwrap();
        let again = import_document(&store, &item, &bytes, input, false).unwrap();
        assert_eq!(again["idempotent"], true);
        let db = store.connect().unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM supplier_invoices", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT reference FROM supplier_invoices", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "CORRECTED"
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM attachments", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM journal_entries", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn altered_original_never_creates_financial_data() {
        let (_dir, store, item, mut bytes, input) = fixture();
        bytes.push(1);
        assert!(import_document(&store, &item, &bytes, input, false).is_err());
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM supplier_invoices", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn failed_automatic_post_rolls_back_invoice_attachment_and_provenance() {
        let (_dir, store, item, bytes, input) = fixture();
        // No accounting setup: the normal posting engine refuses this import.
        assert!(import_document(&store, &item, &bytes, input, true).is_err());
        let db = store.connect().unwrap();
        for table in [
            "supplier_invoices",
            "supplier_email_invoice_imports",
            "attachments",
            "journal_entries",
        ] {
            assert_eq!(
                db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert!(std::fs::read_dir(&store.attachments_dir)
            .unwrap()
            .next()
            .is_none());
    }
    #[test]
    fn cannot_import_same_document_twice_under_different_ids() {
        let (_dir, store, item, bytes, input) = fixture();
        import_document(&store, &item, &bytes, input.clone(), false).unwrap();
        let mut duplicate = item.clone();
        duplicate["id"] = json!(Uuid::new_v4().to_string());
        assert!(import_document(&store, &duplicate, &bytes, input, false).is_err());
    }
    #[test]
    fn unknown_vendor_bad_totals_and_missing_history_require_review() {
        let (_dir, store, item, _bytes, _input) = fixture();
        assert!(automatic_draft(&store, &item).is_err());
        for (key, value) in [
            ("totalCents", json!(1)),
            ("currency", json!("EUR")),
            ("confidence", json!(0.9)),
            ("supplierName", json!("Different SA")),
        ] {
            let mut changed = item.clone();
            changed["extraction"][key] = value;
            assert!(automatic_draft(&store, &changed).is_err());
        }
    }
    #[test]
    fn known_supplier_posts_balanced_accounting_once_and_ack_retry_preserves_proof() {
        let (_dir, store, item, bytes, mut input) = fixture();
        store.install_swiss_accounting_starter().unwrap();
        input.id = Some(Uuid::new_v4().to_string());
        input.reference = Some("PREVIOUS-1".into());
        let previous = input.id.clone().unwrap();
        store.save_supplier_invoice_draft(input).unwrap();
        store.validate_supplier_invoice(&previous).unwrap();
        let draft = automatic_draft(&store, &item).unwrap();
        let result = import_document(&store, &item, &bytes, draft, true).unwrap();
        assert_eq!(result["automatic"], true);
        assert_eq!(
            existing_import(&store, &item).unwrap().unwrap()["automatic"],
            true
        );
        let db = store.connect().unwrap();
        let id = item["id"].as_str().unwrap();
        let totals:(i64,i64,i64)=db.query_row("SELECT SUM(l.debit_cents),SUM(l.credit_cents),COUNT(DISTINCT j.id) FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.source_type='supplier_invoice' AND j.source_id=?",params![id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(totals, (10000, 10000, 1));
        assert_eq!(
            db.query_row(
                "SELECT status FROM supplier_invoices WHERE id=?",
                params![id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "validated"
        );
    }
    #[test]
    fn unrelated_invoice_is_never_overwritten_by_an_inbox_import() {
        let (_dir, store, item, bytes, mut input) = fixture();
        input.reference = Some("KEEP-ME".into());
        store.save_supplier_invoice_draft(input.clone()).unwrap();
        input.reference = Some("REPLACE".into());
        assert!(import_document(&store, &item, &bytes, input, false).is_err());
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT reference FROM supplier_invoices", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "KEEP-ME"
        );
    }
}
