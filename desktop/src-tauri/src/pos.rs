//! Caisse simple (comptoir, atelier). Un ticket est calculé ici, ligne par
//! ligne, avec exactement la règle des factures : la clôture du jour reprend
//! les lignes dans une facture payée et retrouve les mêmes totaux au centime.
//! Paiements : espèces, TWINT ou carte par Payrexx (vérifié avant d'enregistrer)
//! ou terminal de carte séparé. Les articles suivis sortent du stock au ticket.
//! Rien n'est réécrit : une annulation est un ticket « void » lié au premier.

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    accounting::validate_date,
    audit::append_audit,
    database::{now_iso, query_all, query_record_tx, round_basis_points, LocalStore},
    error::{command_error, AppError, AppResult},
    stock::{record_manual_stock_movement_in, ManualMovement, ManualMovementType},
};

const MAX_CENTS: i64 = 100_000_000_000;
const MAX_LINES: usize = 200;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PosLineInput {
    #[serde(default)]
    pub catalog_item_id: Option<String>,
    pub description: String,
    pub quantity_milli: i64,
    #[serde(default)]
    pub unit: Option<String>,
    pub unit_price_cents: i64,
    #[serde(default)]
    pub discount_bp: i64,
    pub vat_bp: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PosTicketInput {
    /// Identifiant du ticket choisi par l'app : un second envoi est sans effet.
    pub request_id: String,
    pub ticket_date: String,
    pub payment_method: String,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub received_cents: Option<i64>,
    #[serde(default)]
    pub payment_reference: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    pub lines: Vec<PosLineInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PosVoidInput {
    pub request_id: String,
    pub ticket_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PosLineAmounts {
    pub net: i64,
    pub vat: i64,
    pub total: i64,
}

/// Même calcul que `recompute_all_invoice_lines` : quantité × prix arrondi,
/// remise puis TVA en points de base, arrondies au centime.
pub(crate) fn line_amounts(quantity_milli: i64, unit_price_cents: i64, discount_bp: i64, vat_bp: i64) -> PosLineAmounts {
    let quantity = quantity_milli as f64 / 1000.0;
    let base = (quantity * unit_price_cents as f64).round() as i64;
    let discount = round_basis_points(base, discount_bp);
    let net = base - discount;
    let vat = round_basis_points(net, vat_bp);
    PosLineAmounts { net, vat, total: net + vat }
}

fn optional_text(value: Option<String>, max: usize, label: &str) -> AppResult<Option<String>> {
    let value = value.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
    if value.as_ref().is_some_and(|text| text.chars().count() > max || text.chars().any(char::is_control)) {
        return Err(invalid(format!("{label} : {max} caractères au maximum.")));
    }
    Ok(value)
}

fn normalized_uuid(value: &str, label: &str) -> AppResult<String> {
    Uuid::parse_str(value.trim()).map(|id| id.to_string()).map_err(|_| invalid(format!("{label} invalide.")))
}

fn day_closed(tx: &Transaction<'_>, date: &str) -> AppResult<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM pos_day_closings WHERE closing_date=?)", [date], |row| row.get(0))?)
}

fn next_number(tx: &Transaction<'_>, date: &str, id: &str) -> AppResult<String> {
    let year = &date[..4];
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM pos_tickets WHERE substr(ticket_date,1,4)=?", [year], |row| row.get(0))?;
    // Le suffixe évite qu'un ticket créé hors ligne sur un autre poste prenne le même numéro.
    Ok(format!("T-{year}-{:05}-{}", count + 1, &id[..4].to_uppercase()))
}

fn ticket_with_lines(tx: &Transaction<'_>, id: &str) -> AppResult<Value> {
    let mut ticket = query_record_tx(tx, "pos_tickets", id)?;
    ticket["lines"] = Value::Array(query_all(tx, "SELECT * FROM pos_ticket_lines WHERE ticket_id=? ORDER BY position", params![id])?);
    Ok(ticket)
}

/// Totaux nets d'une journée : ventes moins annulations, par moyen de paiement.
pub(crate) fn day_totals(tx: &Transaction<'_>, date: &str) -> AppResult<Value> {
    let rows = query_all(
        tx,
        "SELECT payment_method,
                SUM(CASE WHEN kind='sale' THEN total_cents ELSE -total_cents END) AS total,
                SUM(CASE WHEN kind='sale' THEN 1 ELSE -1 END) AS tickets
           FROM pos_tickets WHERE ticket_date=? GROUP BY payment_method",
        params![date],
    )?;
    let mut totals = json!({ "date": date, "cash_cents": 0, "payrexx_cents": 0, "terminal_cents": 0, "total_cents": 0, "ticket_count": 0 });
    for row in rows {
        let method = row["payment_method"].as_str().unwrap_or_default().to_owned();
        let total = row["total"].as_i64().unwrap_or(0);
        totals[format!("{method}_cents")] = json!(total);
        totals["total_cents"] = json!(totals["total_cents"].as_i64().unwrap_or(0) + total);
        totals["ticket_count"] = json!(totals["ticket_count"].as_i64().unwrap_or(0) + row["tickets"].as_i64().unwrap_or(0));
    }
    Ok(totals)
}

impl LocalStore {
    pub fn record_pos_ticket(&self, input: PosTicketInput) -> AppResult<Value> {
        let id = normalized_uuid(&input.request_id, "Ticket")?;
        validate_date(&input.ticket_date, "ticket_date")?;
        if !matches!(input.payment_method.as_str(), "cash" | "payrexx" | "terminal") {
            return Err(invalid("Choisissez espèces, TWINT ou carte."));
        }
        let currency = input.currency.clone().unwrap_or_else(|| "CHF".into());
        if !matches!(currency.as_str(), "CHF" | "EUR") {
            return Err(invalid("La caisse encaisse en CHF ou en EUR."));
        }
        if input.lines.is_empty() || input.lines.len() > MAX_LINES {
            return Err(invalid("Un ticket compte de 1 à 200 lignes."));
        }
        let reference = optional_text(input.payment_reference.clone(), 100, "Référence de paiement")?;
        if input.payment_method == "payrexx" && reference.is_none() {
            return Err(invalid("Le paiement TWINT ou carte n'est pas confirmé."));
        }
        let note = optional_text(input.note.clone(), 500, "Note")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM pos_tickets WHERE id=?)", [&id], |row| row.get::<_, bool>(0))? {
            let ticket = ticket_with_lines(&tx, &id)?;
            tx.commit()?;
            return Ok(ticket);
        }
        if day_closed(&tx, &input.ticket_date)? {
            return Err(invalid("La caisse de ce jour est clôturée. Choisissez la date d'aujourd'hui."));
        }
        let mut lines = Vec::with_capacity(input.lines.len());
        let (mut subtotal, mut vat) = (0_i64, 0_i64);
        for (position, line) in input.lines.iter().enumerate() {
            let description = line.description.trim().to_owned();
            if description.is_empty() || description.chars().count() > 300 {
                return Err(invalid("Chaque ligne a besoin d'un libellé de 300 caractères au plus."));
            }
            if !(1..=1_000_000_000).contains(&line.quantity_milli)
                || !(0..=MAX_CENTS).contains(&line.unit_price_cents)
                || !(0..=10_000).contains(&line.discount_bp)
                || !(0..=10_000).contains(&line.vat_bp)
            {
                return Err(invalid("Vérifiez la quantité, le prix, la remise et la TVA des lignes."));
            }
            let unit = optional_text(line.unit.clone(), 40, "Unité")?.unwrap_or_else(|| "pce".into());
            let catalog = match line.catalog_item_id.as_deref().filter(|value| !value.is_empty()) {
                Some(item) => {
                    let row: Option<(i64, i64, Option<String>)> = tx
                        .query_row("SELECT track_stock,stock_quantity_milli,archived_at FROM catalog_items WHERE id=?", [item], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                        .optional()?;
                    let (track, stock, archived) = row.ok_or_else(|| invalid("Un article du ticket est introuvable dans le catalogue."))?;
                    if archived.is_some() {
                        return Err(invalid("Un article du ticket est archivé."));
                    }
                    Some((item.to_owned(), track == 1, stock))
                }
                None => None,
            };
            let amounts = line_amounts(line.quantity_milli, line.unit_price_cents, line.discount_bp, line.vat_bp);
            subtotal += amounts.net;
            vat += amounts.vat;
            lines.push((position, description, unit, catalog, line.clone(), amounts));
        }
        let total = subtotal + vat;
        if !(0..=MAX_CENTS).contains(&total) || subtotal < 0 || vat < 0 {
            return Err(invalid("Le total du ticket est hors des limites."));
        }
        let (received, change) = if input.payment_method == "cash" {
            let received = input.received_cents.unwrap_or(total);
            if received < total || received > MAX_CENTS {
                return Err(invalid("Le montant reçu est inférieur au total."));
            }
            (Some(received), Some(received - total))
        } else {
            (None, None)
        };
        let number = next_number(&tx, &input.ticket_date, &id)?;
        let now = now_iso();
        tx.execute(
            "INSERT INTO pos_tickets(id,number,kind,ticket_date,payment_method,currency,subtotal_cents,vat_cents,total_cents,received_cents,change_cents,payment_reference,note,created_at) VALUES(?,?,'sale',?,?,?,?,?,?,?,?,?,?,?)",
            params![id, number, input.ticket_date, input.payment_method, currency, subtotal, vat, total, received, change, reference, note, now],
        )?;
        let mut shortfalls = Vec::new();
        for (position, description, unit, catalog, line, amounts) in lines {
            let mut moved = false;
            if let Some((item, true, stock)) = &catalog {
                // Une vente ne s'arrête pas pour un stock mal compté : la sortie est
                // sautée et l'article est signalé pour l'inventaire.
                if *stock >= line.quantity_milli {
                    record_manual_stock_movement_in(&tx, ManualMovement {
                        request_id: Uuid::new_v4().to_string(),
                        catalog_item_id: item.clone(),
                        movement_type: ManualMovementType::Exit,
                        quantity_delta_milli: -line.quantity_milli,
                        reason: "Vente au comptoir".into(),
                        reference: Some(number.clone()),
                        requested_date: Some(input.ticket_date.clone()),
                        expected_balance: None,
                    })?;
                    moved = true;
                } else {
                    shortfalls.push(description.clone());
                }
            }
            tx.execute(
                "INSERT INTO pos_ticket_lines(id,ticket_id,position,catalog_item_id,description,quantity_milli,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,stock_moved,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![Uuid::new_v4().to_string(), id, position as i64, catalog.as_ref().map(|c| c.0.clone()), description, line.quantity_milli, unit, line.unit_price_cents, line.discount_bp, line.vat_bp, amounts.net, amounts.vat, amounts.total, moved, now],
            )?;
        }
        let mut ticket = ticket_with_lines(&tx, &id)?;
        append_audit(&tx, "create", "pos_ticket", &id, &json!({"number": number, "total_cents": total, "payment_method": input.payment_method}))?;
        tx.commit()?;
        ticket["stock_shortfalls"] = json!(shortfalls);
        Ok(ticket)
    }

    /// Annule un ticket d'une journée encore ouverte : ticket inverse et retour
    /// en stock. Un paiement Payrexx se rembourse dans le compte Payrexx.
    pub fn void_pos_ticket(&self, input: PosVoidInput) -> AppResult<Value> {
        let id = normalized_uuid(&input.request_id, "Annulation")?;
        let reason = optional_text(input.reason.clone(), 500, "Motif")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM pos_tickets WHERE id=?)", [&id], |row| row.get::<_, bool>(0))? {
            let ticket = ticket_with_lines(&tx, &id)?;
            tx.commit()?;
            return Ok(ticket);
        }
        let original: Option<(String, String, String, String, i64, i64, i64)> = tx
            .query_row(
                "SELECT kind,number,ticket_date,payment_method,subtotal_cents,vat_cents,total_cents FROM pos_tickets WHERE id=?",
                [&input.ticket_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            )
            .optional()?;
        let (kind, number, date, method, subtotal, vat, total) = original.ok_or_else(|| invalid("Ticket introuvable."))?;
        if kind != "sale" {
            return Err(invalid("Une annulation ne s'annule pas."));
        }
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM pos_tickets WHERE voids_ticket_id=?)", [&input.ticket_id], |row| row.get::<_, bool>(0))? {
            return Err(invalid("Ce ticket est déjà annulé."));
        }
        if day_closed(&tx, &date)? {
            return Err(invalid("La caisse de ce jour est clôturée : établissez un avoir sur la facture des ventes au comptoir."));
        }
        let void_number = format!("A-{}", number.trim_start_matches("T-"));
        let now = now_iso();
        tx.execute(
            "INSERT INTO pos_tickets(id,number,kind,ticket_date,payment_method,currency,subtotal_cents,vat_cents,total_cents,voids_ticket_id,note,created_at) SELECT ?,?,'void',ticket_date,payment_method,currency,subtotal_cents,vat_cents,total_cents,id,?,? FROM pos_tickets WHERE id=?",
            params![id, void_number, reason, now, input.ticket_id],
        )?;
        let lines = query_all(&tx, "SELECT * FROM pos_ticket_lines WHERE ticket_id=? ORDER BY position", params![input.ticket_id])?;
        for line in &lines {
            let moved = line["stock_moved"].as_i64() == Some(1);
            if moved {
                record_manual_stock_movement_in(&tx, ManualMovement {
                    request_id: Uuid::new_v4().to_string(),
                    catalog_item_id: line["catalog_item_id"].as_str().unwrap_or_default().to_owned(),
                    movement_type: ManualMovementType::Entry,
                    quantity_delta_milli: line["quantity_milli"].as_i64().unwrap_or(0),
                    reason: "Annulation d'une vente au comptoir".into(),
                    reference: Some(void_number.clone()),
                    requested_date: Some(date.clone()),
                    expected_balance: None,
                })?;
            }
            tx.execute(
                "INSERT INTO pos_ticket_lines(id,ticket_id,position,catalog_item_id,description,quantity_milli,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,stock_moved,created_at) SELECT ?,?,position,catalog_item_id,description,quantity_milli,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,?,? FROM pos_ticket_lines WHERE id=?",
                params![Uuid::new_v4().to_string(), id, moved, now, line["id"].as_str().unwrap_or_default()],
            )?;
        }
        append_audit(&tx, "void", "pos_ticket", &input.ticket_id, &json!({"void_ticket_id": id, "subtotal_cents": subtotal, "vat_cents": vat, "total_cents": total, "payment_method": method}))?;
        let ticket = ticket_with_lines(&tx, &id)?;
        tx.commit()?;
        Ok(ticket)
    }

    pub fn pos_day(&self, date: &str) -> AppResult<Value> {
        validate_date(date, "date")?;
        let mut connection = self.connect()?;
        let tx = connection.transaction()?;
        let tickets = query_all(&tx, "SELECT * FROM pos_tickets WHERE ticket_date=? ORDER BY created_at", params![date])?;
        let lines = query_all(&tx, "SELECT l.* FROM pos_ticket_lines l JOIN pos_tickets t ON t.id=l.ticket_id WHERE t.ticket_date=? ORDER BY t.created_at,l.position", params![date])?;
        let closing = tx.query_row("SELECT id FROM pos_day_closings WHERE closing_date=?", [date], |row| row.get::<_, String>(0)).optional()?;
        let closing = match closing {
            Some(id) => query_record_tx(&tx, "pos_day_closings", &id)?,
            None => Value::Null,
        };
        let totals = day_totals(&tx, date)?;
        tx.commit()?;
        Ok(json!({ "date": date, "tickets": tickets, "lines": lines, "totals": totals, "closing": closing }))
    }

    /// Relie la journée à la facture payée des ventes au comptoir, après le
    /// clic de clôture. La facture doit reprendre exactement le total du jour.
    pub fn record_pos_closing(&self, date: &str, invoice_id: Option<&str>) -> AppResult<Value> {
        validate_date(date, "date")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = tx.query_row("SELECT id FROM pos_day_closings WHERE closing_date=?", [date], |row| row.get::<_, String>(0)).optional()? {
            let record = query_record_tx(&tx, "pos_day_closings", &existing)?;
            tx.commit()?;
            return Ok(record);
        }
        let totals = day_totals(&tx, date)?;
        let total = totals["total_cents"].as_i64().unwrap_or(0);
        let invoice = invoice_id.filter(|value| !value.is_empty());
        match (total, invoice) {
            (0, None) => {}
            (0, Some(_)) => return Err(invalid("Cette journée n'a aucune vente à facturer.")),
            (_, None) => return Err(invalid("Créez d'abord la facture des ventes au comptoir.")),
            (_, Some(invoice)) => {
                let row: Option<(String, i64, i64, String)> = tx
                    .query_row("SELECT status,total_cents,paid_cents,COALESCE(issue_date,'') FROM invoices WHERE id=?", [invoice], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
                    .optional()?;
                let (status, invoice_total, paid, issue_date) = row.ok_or_else(|| invalid("Facture introuvable."))?;
                if matches!(status.as_str(), "brouillon" | "annulee") || issue_date != date {
                    return Err(invalid("La facture des ventes au comptoir doit être émise à la date du jour clôturé."));
                }
                if invoice_total != total || paid != total {
                    return Err(invalid("La facture ne reprend pas exactement les tickets du jour. Vérifiez-la avant de clôturer."));
                }
            }
        }
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO pos_day_closings(id,closing_date,ticket_count,total_cents,cash_cents,payrexx_cents,terminal_cents,invoice_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            params![
                id,
                date,
                totals["ticket_count"].as_i64().unwrap_or(0).max(0),
                total,
                totals["cash_cents"].as_i64().unwrap_or(0),
                totals["payrexx_cents"].as_i64().unwrap_or(0),
                totals["terminal_cents"].as_i64().unwrap_or(0),
                invoice,
                now_iso()
            ],
        )?;
        let record = query_record_tx(&tx, "pos_day_closings", &id)?;
        append_audit(&tx, "close", "pos_day", &id, &record)?;
        tx.commit()?;
        Ok(record)
    }
}

#[tauri::command]
pub async fn record_pos_ticket(state: tauri::State<'_, LocalStore>, input: PosTicketInput) -> Result<Value, String> {
    let store = state.inner().clone();
    if input.payment_method == "payrexx" {
        // Le paiement doit être confirmé par Payrexx pour le montant exact du ticket.
        let reference = input.payment_reference.clone().unwrap_or_default();
        let total: i64 = input.lines.iter().map(|line| line_amounts(line.quantity_milli, line.unit_price_cents, line.discount_bp, line.vat_bp).total).sum();
        crate::online_payments::require_confirmed_gateway(&store, &reference, total).await.map_err(command_error)?;
    }
    let _guard = store.lock().map_err(command_error)?;
    store.require_write_access().map_err(command_error)?;
    store.record_pos_ticket(input).map_err(command_error)
}

#[tauri::command]
pub fn void_pos_ticket(state: tauri::State<'_, LocalStore>, input: PosVoidInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.void_pos_ticket(input).map_err(command_error)
}

#[tauri::command]
pub fn pos_day(state: tauri::State<'_, LocalStore>, date: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.pos_day(&date).map_err(command_error)
}

#[tauri::command]
pub fn record_pos_closing(state: tauri::State<'_, LocalStore>, date: String, invoice_id: Option<String>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.record_pos_closing(&date, invoice_id.as_deref()).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, LocalStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
        let now = now_iso();
        let mut connection = store.connect().unwrap();
        connection.execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Caisse test',?,?)", params![now, now]).unwrap();
        // Un article suivi commence à zéro : le stock entre par un mouvement.
        connection.execute("INSERT INTO catalog_items(id,kind,sku,name,unit,sales_price_cents,vat_bp,track_stock,stock_quantity_milli,created_at,updated_at) VALUES('cafe','product','CAF','Café en grains','pce',1850,260,1,0,?,?)", params![now, now]).unwrap();
        let tx = connection.transaction().unwrap();
        record_manual_stock_movement_in(&tx, ManualMovement {
            request_id: Uuid::new_v4().to_string(),
            catalog_item_id: "cafe".into(),
            movement_type: ManualMovementType::Entry,
            quantity_delta_milli: 5000,
            reason: "Stock initial".into(),
            reference: None,
            requested_date: Some("2026-10-01".into()),
            expected_balance: None,
        })
        .unwrap();
        tx.commit().unwrap();
        (dir, store)
    }

    fn line(item: Option<&str>, quantity_milli: i64, price: i64, vat_bp: i64) -> PosLineInput {
        PosLineInput { catalog_item_id: item.map(str::to_owned), description: "Café en grains".into(), quantity_milli, unit: None, unit_price_cents: price, discount_bp: 0, vat_bp }
    }

    fn ticket(id: &str, method: &str, lines: Vec<PosLineInput>, received: Option<i64>) -> PosTicketInput {
        PosTicketInput { request_id: id.into(), ticket_date: "2026-10-25".into(), payment_method: method.into(), currency: None, received_cents: received, payment_reference: None, note: None, lines }
    }

    #[test]
    fn line_amounts_follow_the_invoice_rule() {
        assert_eq!(line_amounts(2000, 1850, 0, 260), PosLineAmounts { net: 3700, vat: 96, total: 3796 });
        assert_eq!(line_amounts(1500, 333, 1000, 810), PosLineAmounts { net: 450, vat: 36, total: 486 });
    }

    #[test]
    fn cash_ticket_records_change_and_leaves_stock_once() {
        let (_dir, store) = fixture();
        let id = Uuid::new_v4().to_string();
        let saved = store.record_pos_ticket(ticket(&id, "cash", vec![line(Some("cafe"), 2000, 1850, 260)], Some(5000))).unwrap();
        assert_eq!(saved["total_cents"], 3796);
        assert_eq!(saved["change_cents"], 1204);
        assert_eq!(saved["lines"][0]["stock_moved"], 1);
        let again = store.record_pos_ticket(ticket(&id, "cash", vec![line(Some("cafe"), 2000, 1850, 260)], Some(5000))).unwrap();
        assert_eq!(again["number"], saved["number"]);
        let stock: i64 = store.connect().unwrap().query_row("SELECT stock_quantity_milli FROM catalog_items WHERE id='cafe'", [], |row| row.get(0)).unwrap();
        assert_eq!(stock, 3000);
    }

    #[test]
    fn short_stock_does_not_block_the_sale() {
        let (_dir, store) = fixture();
        let saved = store.record_pos_ticket(ticket(&Uuid::new_v4().to_string(), "terminal", vec![line(Some("cafe"), 9000, 1850, 260)], None)).unwrap();
        assert_eq!(saved["lines"][0]["stock_moved"], 0);
        assert_eq!(saved["stock_shortfalls"][0], "Café en grains");
    }

    #[test]
    fn cash_received_must_cover_the_total() {
        let (_dir, store) = fixture();
        let error = store.record_pos_ticket(ticket(&Uuid::new_v4().to_string(), "cash", vec![line(None, 1000, 1000, 810)], Some(500))).unwrap_err();
        assert!(error.to_string().contains("reçu"));
    }

    #[test]
    fn void_returns_stock_and_nets_the_day() {
        let (_dir, store) = fixture();
        let sale = store.record_pos_ticket(ticket(&Uuid::new_v4().to_string(), "cash", vec![line(Some("cafe"), 1000, 1850, 260)], Some(2000))).unwrap();
        store.record_pos_ticket(ticket(&Uuid::new_v4().to_string(), "terminal", vec![line(None, 1000, 1000, 810)], None)).unwrap();
        let void = store.void_pos_ticket(PosVoidInput { request_id: Uuid::new_v4().to_string(), ticket_id: sale["id"].as_str().unwrap().into(), reason: None }).unwrap();
        assert_eq!(void["kind"], "void");
        assert!(store.void_pos_ticket(PosVoidInput { request_id: Uuid::new_v4().to_string(), ticket_id: sale["id"].as_str().unwrap().into(), reason: None }).is_err());
        let day = store.pos_day("2026-10-25").unwrap();
        assert_eq!(day["totals"]["total_cents"], 1081);
        assert_eq!(day["totals"]["cash_cents"], 0);
        assert_eq!(day["totals"]["ticket_count"], 1);
        let stock: i64 = store.connect().unwrap().query_row("SELECT stock_quantity_milli FROM catalog_items WHERE id='cafe'", [], |row| row.get(0)).unwrap();
        assert_eq!(stock, 5000);
    }

    #[test]
    fn closing_requires_the_matching_invoice_and_locks_the_day() {
        let (_dir, store) = fixture();
        store.record_pos_ticket(ticket(&Uuid::new_v4().to_string(), "terminal", vec![line(None, 1000, 1000, 810)], None)).unwrap();
        assert!(store.record_pos_closing("2026-10-25", None).is_err());
        let empty = store.record_pos_closing("2026-10-24", None).unwrap();
        assert_eq!(empty["total_cents"], 0);
        let error = store.record_pos_ticket(ticket(&Uuid::new_v4().to_string(), "terminal", vec![line(None, 1000, 1000, 810)], None).with_date("2026-10-24")).unwrap_err();
        assert!(error.to_string().contains("clôturée"));
    }

    impl PosTicketInput {
        fn with_date(mut self, date: &str) -> Self {
            self.ticket_date = date.into();
            self
        }
    }
}
