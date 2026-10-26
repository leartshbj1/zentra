//! Acompte payé en ligne à l'acceptation d'un devis. Zentra calcule le montant
//! (pourcentage des réglages client, arrondi au centime), crée la page de
//! paiement sur le compte Payrexx de l'entreprise et la joint au devis publié.
//! Quand Payrexx confirme le paiement, Autopilote propose de le rapprocher de
//! la facture d'acompte du devis, en un clic.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, record_payment_in_transaction, LocalStore},
    error::{command_error, AppError, AppResult},
    models::RecordPaymentInput,
    online_payments::{gateway_from_response, gateway_pairs, link_status, payrexx, php_urlencode, read_secret, settings_row, valid_link},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// Acompte en centimes : pourcentage (points de base) du total TTC, arrondi au centime le plus proche.
pub(crate) fn deposit_amount(total_cents: i64, percent_bp: i64) -> i64 {
    (total_cents * percent_bp + 5_000) / 10_000
}

#[derive(Debug)]
struct DepositRequest {
    quote_id: String,
    instance: String,
    percent_bp: i64,
    amount_cents: i64,
    currency: String,
    pairs: Vec<(String, String)>,
}

enum Prepared {
    Existing(Value),
    New(DepositRequest),
}

impl LocalStore {
    fn prepare_quote_deposit(&self, quote_id: &str) -> AppResult<Prepared> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let (enabled, instance) = settings_row(&connection)?;
        let instance = instance.filter(|_| enabled).ok_or_else(|| invalid("Le paiement en ligne Payrexx est désactivé."))?;
        let percent_bp: i64 = connection
            .query_row("SELECT deposit_percent_bp FROM customer_engagement_settings WHERE id=1", [], |row| row.get(0))
            .optional()?
            .unwrap_or(0);
        if percent_bp <= 0 {
            return Err(invalid("Aucun acompte n’est demandé dans les réglages clients."));
        }
        let quote: Option<(Option<String>, String, i64, String)> = connection
            .query_row("SELECT number,status,total_cents,UPPER(currency) FROM quotes WHERE id=?", [quote_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .optional()?;
        let (number, status, total, currency) = quote.ok_or_else(|| invalid("Devis introuvable."))?;
        let number = number.filter(|value| !value.is_empty()).ok_or_else(|| invalid("Émettez d’abord le devis."))?;
        if status != "emis" || total <= 0 || !matches!(currency.as_str(), "CHF" | "EUR") {
            return Err(invalid("L’acompte en ligne se demande sur un devis émis, en CHF ou en EUR."));
        }
        let amount = deposit_amount(total, percent_bp);
        if amount <= 0 {
            return Err(invalid("Le montant de l’acompte est nul."));
        }
        let existing = query_all(
            &connection,
            "SELECT id,url,amount_cents,currency FROM quote_deposit_links WHERE quote_id=? AND status IN ('open','paid') AND amount_cents=? ORDER BY created_at DESC LIMIT 1",
            params![quote_id, amount],
        )?;
        if let Some(row) = existing.into_iter().next() {
            return Ok(Prepared::Existing(json!({ "id": row["id"], "quote_id": quote_id, "url": row["url"], "amount_cents": row["amount_cents"], "currency": row["currency"] })));
        }
        let company: String = connection.query_row("SELECT company_name FROM settings WHERE id=1", [], |row| row.get(0))?;
        let mut pairs = gateway_pairs(amount, &currency, &number, &company);
        if let Some(purpose) = pairs.iter_mut().find(|(key, _)| key == "purpose") {
            purpose.1 = format!("Acompte devis {number} · {company}").chars().take(200).collect();
        }
        Ok(Prepared::New(DepositRequest { quote_id: quote_id.into(), instance, percent_bp, amount_cents: amount, currency, pairs }))
    }

    fn save_quote_deposit(&self, request: &DepositRequest, response: &Value) -> AppResult<Value> {
        let (reference, link, _status) = gateway_from_response(response)?;
        let link = link.filter(|link| valid_link(link)).ok_or_else(|| invalid("Payrexx a renvoyé un lien inattendu ; il n'a pas été utilisé."))?;
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = Uuid::new_v4().to_string();
        let now = now_iso();
        tx.execute(
            "INSERT INTO quote_deposit_links(id,quote_id,provider,provider_reference,url,percent_bp,amount_cents,currency,status,invoice_id,payment_id,created_at,updated_at)
             VALUES(?,?,'payrexx',?,?,?,?,?,'open',NULL,NULL,?,?)",
            params![id, request.quote_id, reference, link, request.percent_bp, request.amount_cents, request.currency, now, now],
        )?;
        append_audit(&tx, "create", "quote_deposit_link", &id, &json!({ "quote_id": request.quote_id, "provider_reference": reference, "amount_cents": request.amount_cents }))?;
        tx.commit()?;
        Ok(json!({ "id": id, "quote_id": request.quote_id, "url": link, "amount_cents": request.amount_cents, "currency": request.currency }))
    }

    fn open_quote_deposits(&self) -> AppResult<Vec<(String, String)>> {
        let connection = self.connect()?;
        let rows = query_all(&connection, "SELECT id,provider_reference FROM quote_deposit_links WHERE status='open' ORDER BY created_at DESC LIMIT 25", [])?;
        Ok(rows.into_iter().map(|row| (row["id"].as_str().unwrap_or_default().to_owned(), row["provider_reference"].as_str().unwrap_or_default().to_owned())).collect())
    }

    pub(crate) fn update_quote_deposit_status(&self, id: &str, provider_status: &str) -> AppResult<()> {
        let status = link_status(provider_status);
        if status == "open" {
            return Ok(());
        }
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.execute("UPDATE quote_deposit_links SET status=?,updated_at=? WHERE id=? AND status='open'", params![status, now_iso(), id])? == 1 {
            append_audit(&tx, "status", "quote_deposit_link", id, &json!({ "status": status, "provider_status": provider_status }))?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Rapproche l'acompte payé de la facture d'acompte du devis : un seul encaissement par lien.
    pub fn record_quote_deposit(&self, link_id: &str, invoice_id: &str) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let link: Option<(String, String, i64, String, String, Option<String>)> = tx
            .query_row("SELECT quote_id,provider_reference,amount_cents,currency,status,payment_id FROM quote_deposit_links WHERE id=?", [link_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))
            })
            .optional()?;
        let (quote_id, reference, amount, currency, status, payment_id) = link.ok_or_else(|| invalid("Acompte introuvable."))?;
        if let Some(payment_id) = payment_id {
            tx.commit()?;
            return Ok(json!({ "payment_id": payment_id, "already_recorded": true }));
        }
        if status != "paid" {
            return Err(invalid("Payrexx n’a pas encore confirmé cet acompte."));
        }
        let invoice: Option<(Option<String>, String, String, String, i64)> = tx
            .query_row(
                "SELECT quote_id,type,status,UPPER(currency),total_cents-paid_cents-COALESCE((SELECT SUM(c.amount_cents) FROM customer_invoice_credit_movements c WHERE c.invoice_id=invoices.id),0) FROM invoices WHERE id=?",
                [invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;
        let (invoice_quote, kind, invoice_status, invoice_currency, open) = invoice.ok_or_else(|| invalid("Facture introuvable."))?;
        if invoice_quote.as_deref() != Some(quote_id.as_str()) || kind != "acompte" || matches!(invoice_status.as_str(), "brouillon" | "annulee" | "payee") {
            return Err(invalid("Émettez d’abord la facture d’acompte de ce devis."));
        }
        if invoice_currency != currency || open < amount {
            return Err(invalid("Le solde de la facture d’acompte ne correspond pas au montant payé en ligne."));
        }
        let payment = record_payment_in_transaction(
            &tx,
            RecordPaymentInput {
                request_id: link_id.into(),
                invoice_id: invoice_id.into(),
                amount_cents: amount,
                date: Some(now_iso()[..10].to_owned()),
                method: Some("TWINT / carte (Payrexx)".into()),
                reference: Some(format!("Payrexx {reference}")),
                notes: Some("Acompte payé en ligne à l’acceptation du devis. Les frais Payrexx sont déduits du versement.".into()),
            },
        )?;
        let payment_id = payment["id"].as_str().ok_or_else(|| invalid("Le paiement n'a pas pu être enregistré."))?.to_owned();
        tx.execute("UPDATE quote_deposit_links SET invoice_id=?,payment_id=?,updated_at=? WHERE id=?", params![invoice_id, payment_id, now_iso(), link_id])?;
        append_audit(&tx, "record_payment", "quote_deposit_link", link_id, &json!({ "payment_id": payment_id, "invoice_id": invoice_id }))?;
        tx.commit()?;
        Ok(json!({ "payment_id": payment_id, "already_recorded": false }))
    }
}

/// Crée (ou retrouve) la page Payrexx de l'acompte d'un devis émis.
#[tauri::command]
pub async fn create_quote_deposit_link(state: tauri::State<'_, LocalStore>, quote_id: String) -> Result<Value, String> {
    let store = state.inner().clone();
    let (request, secret) = {
        let _guard = store.lock().map_err(command_error)?;
        store.require_write_access().map_err(command_error)?;
        match store.prepare_quote_deposit(&quote_id).map_err(command_error)? {
            Prepared::Existing(value) => return Ok(value),
            Prepared::New(request) => {
                let secret = read_secret(&store).map_err(command_error)?.ok_or_else(|| command_error(invalid("La clé API Payrexx manque sur cet appareil.")))?;
                (request, secret)
            }
        }
    };
    let response = payrexx(reqwest::Method::POST, "Gateway", &request.instance, &secret, request.pairs.clone()).await.map_err(command_error)?;
    let _guard = store.lock().map_err(command_error)?;
    store.save_quote_deposit(&request, &response).map_err(command_error)
}

/// Relit l'état des acomptes ouverts ; un acompte payé devient une carte Autopilote.
#[tauri::command]
pub async fn refresh_quote_deposit_links(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    let (links, instance, secret) = {
        let _guard = store.lock().map_err(command_error)?;
        let connection = store.connect().map_err(command_error)?;
        let (enabled, instance) = settings_row(&connection).map_err(command_error)?;
        let secret = read_secret(&store).map_err(command_error)?;
        match (enabled, instance, secret) {
            (true, Some(instance), Some(secret)) => (store.open_quote_deposits().map_err(command_error)?, instance, secret),
            _ => return Ok(json!({ "checked": 0 })),
        }
    };
    let mut checked = 0;
    for (id, reference) in links {
        let Ok(body) = payrexx(reqwest::Method::GET, &format!("Gateway/{}", php_urlencode(&reference)), &instance, &secret, Vec::new()).await else { continue };
        let Ok((_, _, status)) = gateway_from_response(&body) else { continue };
        let _guard = store.lock().map_err(command_error)?;
        store.update_quote_deposit_status(&id, &status).map_err(command_error)?;
        checked += 1;
    }
    Ok(json!({ "checked": checked }))
}

#[tauri::command]
pub fn record_quote_deposit(state: tauri::State<'_, LocalStore>, link_id: String, invoice_id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.record_quote_deposit(&link_id, &invoice_id).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_deposit_is_a_rounded_share_of_the_total() {
        assert_eq!(deposit_amount(1_200_000, 3_000), 360_000);
        assert_eq!(deposit_amount(123_457, 3_000), 37_037);
        assert_eq!(deposit_amount(100, 5_000), 50);
        assert_eq!(deposit_amount(1, 3_000), 0);
    }

    #[test]
    fn a_deposit_needs_payrexx_a_percentage_and_an_issued_quote() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "quote-deposits-test").unwrap();
        assert!(matches!(store.prepare_quote_deposit("missing"), Err(error) if error.to_string().contains("désactivé")));
        let connection = store.connect().unwrap();
        connection.execute("INSERT INTO online_payment_settings(id,enabled,provider,instance,created_at,updated_at) VALUES(1,1,'payrexx','atelier','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", []).unwrap();
        drop(connection);
        assert!(matches!(store.prepare_quote_deposit("missing"), Err(error) if error.to_string().contains("Aucun acompte")));
        assert!(store.record_quote_deposit("missing", "missing").is_err());
        let rows: i64 = store.connect().unwrap().query_row("SELECT COUNT(*) FROM quote_deposit_links", [], |row| row.get(0)).unwrap();
        assert_eq!(rows, 0);
    }
}
