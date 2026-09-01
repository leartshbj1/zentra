use chrono::NaiveDate;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, query_record_tx, recompute_invoice, LocalStore},
    error::{AppError, AppResult},
    models::CreateInvoiceFromTimeEntriesInput,
};

const MAX_TIME_ENTRIES_PER_INVOICE: usize = 500;
const MAX_MINUTES_PER_ENTRY: i64 = 5_256_000;
const MAX_HOURLY_RATE_CENTS: i64 = 100_000_000;

#[derive(Debug)]
struct TimeSnapshot {
    id: String,
    date: String,
    minutes: i64,
    rate_cents: i64,
    amount_cents: i64,
    employee_name: String,
    note: String,
}

fn optional_text(value: Option<String>, field: &str, max: usize) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > max {
        return Err(AppError::Validation(format!(
            "{field} ne peut pas dépasser {max} caractères."
        )));
    }
    Ok(Some(value.to_owned()))
}

fn optional_date(value: Option<String>, field: &str) -> AppResult<Option<String>> {
    let value = optional_text(value, field, 10)?;
    value
        .map(|value| {
            NaiveDate::parse_from_str(&value, "%Y-%m-%d")
                .map(|_| value)
                .map_err(|_| {
                    AppError::Validation(format!(
                        "{field} doit être une date valide au format AAAA-MM-JJ."
                    ))
                })
        })
        .transpose()
}

fn rounded_positive_ratio(numerator: i128, denominator: i128) -> AppResult<i64> {
    let rounded = numerator
        .checked_add(denominator / 2)
        .ok_or_else(|| AppError::Validation("Le montant horaire est trop élevé.".into()))?
        / denominator;
    i64::try_from(rounded)
        .map_err(|_| AppError::Validation("Le montant horaire est trop élevé.".into()))
}

fn minute_amount(minutes: i64, hourly_rate_cents: i64) -> AppResult<i64> {
    if !(1..=MAX_MINUTES_PER_ENTRY).contains(&minutes) {
        return Err(AppError::Validation(format!(
            "Chaque temps doit contenir entre 1 et {MAX_MINUTES_PER_ENTRY} minutes."
        )));
    }
    if !(1..=MAX_HOURLY_RATE_CENTS).contains(&hourly_rate_cents) {
        return Err(AppError::Validation(format!(
            "Chaque temps doit avoir un taux horaire compris entre 1 et {MAX_HOURLY_RATE_CENTS} centimes."
        )));
    }
    let exact = rounded_positive_ratio(minutes as i128 * hourly_rate_cents as i128, 60)?;
    let document_invariant = ((minutes as f64 / 60.0) * hourly_rate_cents as f64).round() as i64;
    if document_invariant != exact {
        return Err(AppError::Validation(
            "Ce temps dépasse la précision monétaire prise en charge par les factures locales."
                .into(),
        ));
    }
    Ok(exact)
}

fn vat_amount(net_cents: i64, vat_bp: i64) -> AppResult<i64> {
    rounded_positive_ratio(net_cents as i128 * vat_bp as i128, 10_000)
}

fn payload_hash(payload_json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(payload_json.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn load_result(
    transaction: &Transaction<'_>,
    batch_id: &str,
    idempotent: bool,
) -> AppResult<Value> {
    let batch = query_record_tx(transaction, "time_billing_batches", batch_id)?;
    let invoice_id = batch
        .get("invoice_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Validation("Le lot de facturation est incomplet.".into()))?;
    let invoice = query_record_tx(transaction, "invoices", invoice_id)?;
    let items = query_all(
        transaction,
        "SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY position,rowid",
        params![invoice_id],
    )?;
    let entries = query_all(
        transaction,
        "SELECT * FROM time_billing_entries WHERE batch_id=? ORDER BY entry_date_snapshot,time_entry_id",
        params![batch_id],
    )?;
    Ok(json!({
        "batch": batch,
        "invoice": invoice,
        "items": items,
        "time_billing_entries": entries,
        "idempotent": idempotent,
    }))
}

impl LocalStore {
    /// Réserve des temps approuvés et crée leur facture brouillon dans une seule
    /// transaction `IMMEDIATE`. Aucun numéro n'est attribué ici : l'émission
    /// reste une décision humaine distincte.
    pub fn create_invoice_from_time_entries(
        &self,
        input: CreateInvoiceFromTimeEntriesInput,
    ) -> AppResult<Value> {
        let request_id = Uuid::parse_str(input.request_id.trim())
            .map_err(|_| AppError::Validation("request_id doit être un UUID valide.".into()))?
            .to_string();
        let project_id = input.project_id.trim().to_owned();
        if project_id.is_empty() {
            return Err(AppError::Validation("project_id est obligatoire.".into()));
        }

        let mut time_entry_ids = input
            .time_entry_ids
            .into_iter()
            .map(|id| id.trim().to_owned())
            .collect::<Vec<_>>();
        if time_entry_ids.is_empty() {
            return Err(AppError::Validation(
                "Sélectionnez au moins un temps à facturer.".into(),
            ));
        }
        if time_entry_ids.len() > MAX_TIME_ENTRIES_PER_INVOICE {
            return Err(AppError::Validation(format!(
                "Une facture peut regrouper au maximum {MAX_TIME_ENTRIES_PER_INVOICE} temps."
            )));
        }
        if time_entry_ids.iter().any(|id| id.is_empty()) {
            return Err(AppError::Validation(
                "Chaque identifiant de temps doit être renseigné.".into(),
            ));
        }
        time_entry_ids.sort();
        if time_entry_ids.windows(2).any(|ids| ids[0] == ids[1]) {
            return Err(AppError::Validation(
                "Un même temps ne peut apparaître qu'une fois dans la sélection.".into(),
            ));
        }

        let title = optional_text(input.title, "title", 200)?;
        let service_date_from = optional_date(input.service_date_from, "service_date_from")?;
        let service_date_to = optional_date(input.service_date_to, "service_date_to")?;
        if service_date_from
            .as_ref()
            .zip(service_date_to.as_ref())
            .is_some_and(|(from, to)| to < from)
        {
            return Err(AppError::Validation(
                "service_date_to précède service_date_from.".into(),
            ));
        }
        let notes = optional_text(input.notes, "notes", 5_000)?;
        if input.vat_bp.is_some_and(|vat| !(0..=10_000).contains(&vat)) {
            return Err(AppError::Validation(
                "vat_bp doit être compris entre 0 et 10000.".into(),
            ));
        }

        // Le JSON canonique représente la requête de l'appelant (identifiants
        // triés et textes normalisés), pas les valeurs par défaut susceptibles
        // de changer. Il rend donc une reprise réellement idempotente.
        let request_payload = json!({
            "project_id": project_id,
            "time_entry_ids": time_entry_ids,
            "title": title,
            "service_date_from": service_date_from,
            "service_date_to": service_date_to,
            "vat_bp": input.vat_bp,
            "notes": notes,
        });
        let request_json = serde_json::to_string(&request_payload)?;
        let request_sha256 = payload_hash(&request_json);

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let existing: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT id,request_sha256,request_json FROM time_billing_batches WHERE request_id=?",
                params![request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((batch_id, existing_sha256, existing_json)) = existing {
            if existing_sha256 != request_sha256 || existing_json != request_json {
                return Err(AppError::Validation(
                    "Ce request_id a déjà été utilisé avec une autre sélection ou d'autres paramètres."
                        .into(),
                ));
            }
            let result = load_result(&transaction, &batch_id, true)?;
            transaction.commit()?;
            return Ok(result);
        }

        let (project_name, client_id): (String, Option<String>) = transaction
            .query_row(
                "SELECT name,client_id FROM projects WHERE id=?",
                params![project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("projects/{project_id}")))?;
        let client_id = client_id
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| {
                AppError::Validation(
                    "Le projet doit être rattaché à un client avant de facturer ses heures.".into(),
                )
            })?;
        let client_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM clients WHERE id=?)",
            params![client_id],
            |row| row.get(0),
        )?;
        if !client_exists {
            return Err(AppError::Validation(
                "Le client rattaché au projet est introuvable.".into(),
            ));
        }

        let (vat_registered, default_vat_bp): (bool, i64) = transaction.query_row(
            "SELECT vat_registered,default_vat_bp FROM settings WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let vat_bp = input.vat_bp.unwrap_or(default_vat_bp);
        match (vat_registered, vat_bp) {
            (true, 1..=10_000) | (false, 0) => {}
            (true, _) => {
                return Err(AppError::Validation(
                    "Un taux de TVA positif est obligatoire pour une entreprise assujettie.".into(),
                ))
            }
            (false, _) => {
                return Err(AppError::Validation(
                    "Le taux de TVA doit être 0 pour une entreprise non assujettie.".into(),
                ))
            }
        }

        let mut snapshots = Vec::with_capacity(time_entry_ids.len());
        for time_entry_id in &time_entry_ids {
            let source: Option<(String, String, i64, i64, i64, String, String)> = transaction
                .query_row(
                    "SELECT entry.project_id,entry.date,entry.minutes,entry.billable,
                            entry.billing_rate_cents,entry.status,
                            COALESCE(NULLIF(TRIM(employee.name),''),'Non attribué')
                     FROM time_entries entry
                     LEFT JOIN employees employee ON employee.id=entry.employee_id
                     WHERE entry.id=?",
                    params![time_entry_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    },
                )
                .optional()?;
            let (source_project, date, minutes, billable, rate_cents, status, employee_name) =
                source
                    .ok_or_else(|| AppError::NotFound(format!("time_entries/{time_entry_id}")))?;
            if source_project != project_id {
                return Err(AppError::Validation(
                    "Tous les temps sélectionnés doivent appartenir au même projet.".into(),
                ));
            }
            if billable != 1 {
                return Err(AppError::Validation(format!(
                    "Le temps {time_entry_id} n'est pas facturable."
                )));
            }
            if status != "approuve" {
                return Err(AppError::Validation(format!(
                    "Le temps {time_entry_id} doit être approuvé avant facturation."
                )));
            }
            NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| {
                AppError::Validation(format!(
                    "Le temps {time_entry_id} contient une date invalide."
                ))
            })?;
            let already_linked: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM time_billing_entries WHERE time_entry_id=?)",
                params![time_entry_id],
                |row| row.get(0),
            )?;
            if already_linked {
                return Err(AppError::Validation(format!(
                    "Le temps {time_entry_id} est déjà réservé ou facturé."
                )));
            }
            let note: Option<String> = transaction.query_row(
                "SELECT note FROM time_entries WHERE id=?",
                params![time_entry_id],
                |row| row.get(0),
            )?;
            snapshots.push(TimeSnapshot {
                id: time_entry_id.clone(),
                date,
                minutes,
                rate_cents,
                amount_cents: minute_amount(minutes, rate_cents)?,
                employee_name,
                note: note.unwrap_or_default(),
            });
        }
        snapshots.sort_by(|left, right| left.date.cmp(&right.date).then(left.id.cmp(&right.id)));

        let first_date = snapshots
            .first()
            .map(|entry| entry.date.clone())
            .expect("selection validated as non-empty");
        let last_date = snapshots
            .last()
            .map(|entry| entry.date.clone())
            .expect("selection validated as non-empty");
        let effective_from = service_date_from.unwrap_or_else(|| first_date.clone());
        let effective_to = service_date_to.unwrap_or_else(|| last_date.clone());
        if effective_from > first_date || effective_to < last_date {
            return Err(AppError::Validation(
                "La période de prestation doit couvrir tous les temps sélectionnés.".into(),
            ));
        }

        let mut total_cents = 0_i64;
        for snapshot in &snapshots {
            let line_total = snapshot
                .amount_cents
                .checked_add(vat_amount(snapshot.amount_cents, vat_bp)?)
                .ok_or_else(|| {
                    AppError::Validation("Le total de la facture est trop élevé.".into())
                })?;
            total_cents = total_cents.checked_add(line_total).ok_or_else(|| {
                AppError::Validation("Le total de la facture est trop élevé.".into())
            })?;
        }
        if total_cents <= 0 {
            return Err(AppError::Validation(
                "Les temps sélectionnés produisent un montant nul après arrondi.".into(),
            ));
        }

        let invoice_id = Uuid::new_v4().to_string();
        let batch_id = Uuid::new_v4().to_string();
        let now = now_iso();
        let invoice_title = title.unwrap_or_else(|| format!("Heures — {project_name}"));
        transaction.execute(
            "INSERT INTO invoices (
               id,client_id,project_id,quote_id,original_invoice_id,number,title,type,status,
               issue_date,due_date,service_date_from,service_date_to,currency,
               subtotal_cents,discount_cents,vat_cents,total_cents,paid_cents,
               notes,terms,snapshot_json,created_at,updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                invoice_id,
                client_id,
                project_id,
                Option::<String>::None,
                Option::<String>::None,
                Option::<String>::None,
                invoice_title,
                "standard",
                "brouillon",
                Option::<String>::None,
                Option::<String>::None,
                effective_from,
                effective_to,
                "CHF",
                0_i64,
                0_i64,
                0_i64,
                0_i64,
                0_i64,
                notes,
                Option::<String>::None,
                Option::<String>::None,
                now,
                now,
            ],
        )?;

        let mut links = Vec::with_capacity(snapshots.len());
        for (position, snapshot) in snapshots.iter().enumerate() {
            let invoice_item_id = Uuid::new_v4().to_string();
            let description = if snapshot.note.trim().is_empty() {
                format!("{} — {}", snapshot.date, snapshot.employee_name)
            } else {
                format!(
                    "{} — {} — {}",
                    snapshot.date,
                    snapshot.employee_name,
                    snapshot.note.trim()
                )
            };
            let line_vat_cents = vat_amount(snapshot.amount_cents, vat_bp)?;
            let line_total_cents = snapshot
                .amount_cents
                .checked_add(line_vat_cents)
                .ok_or_else(|| {
                    AppError::Validation("Le total d'une ligne est trop élevé.".into())
                })?;
            transaction.execute(
                "INSERT INTO invoice_items (
                   id,invoice_id,catalog_item_id,position,description,quantity,unit,
                   unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,
                   line_total_cents,created_at,updated_at
                 ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    invoice_item_id,
                    invoice_id,
                    Option::<String>::None,
                    position as i64,
                    description,
                    snapshot.minutes as f64 / 60.0,
                    "heure",
                    snapshot.rate_cents,
                    0_i64,
                    vat_bp,
                    snapshot.amount_cents,
                    line_vat_cents,
                    line_total_cents,
                    now,
                    now,
                ],
            )?;
            links.push((snapshot, invoice_item_id));
        }
        recompute_invoice(&transaction, &invoice_id)?;

        transaction.execute(
            "INSERT INTO time_billing_batches (
               id,request_id,request_sha256,request_json,invoice_id,project_id,client_id,vat_bp,created_at
             ) VALUES (?,?,?,?,?,?,?,?,?)",
            params![
                batch_id,
                request_id,
                request_sha256,
                request_json,
                invoice_id,
                project_id,
                client_id,
                vat_bp,
                now,
            ],
        )?;
        for (snapshot, invoice_item_id) in links {
            transaction.execute(
                "INSERT INTO time_billing_entries (
                   id,batch_id,time_entry_id,invoice_item_id,entry_date_snapshot,
                   minutes_snapshot,billing_rate_cents_snapshot,amount_cents_snapshot,
                   employee_name_snapshot,note_snapshot,created_at
                 ) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    Uuid::new_v4().to_string(),
                    batch_id,
                    snapshot.id,
                    invoice_item_id,
                    snapshot.date,
                    snapshot.minutes,
                    snapshot.rate_cents,
                    snapshot.amount_cents,
                    snapshot.employee_name,
                    snapshot.note,
                    now,
                ],
            )?;
        }

        let result = load_result(&transaction, &batch_id, false)?;
        append_audit(
            &transaction,
            "create_from_time_entries",
            "time_billing_batch",
            &batch_id,
            &json!({
                "request_id": request_id,
                "request_sha256": request_sha256,
                "invoice_id": invoice_id,
                "project_id": project_id,
                "client_id": client_id,
                "result": result,
            }),
        )?;
        transaction.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::minute_amount;

    #[test]
    fn minute_amount_rounds_each_line_half_up() {
        assert_eq!(minute_amount(1, 30).unwrap(), 1);
        assert_eq!(minute_amount(61, 10_001).unwrap(), 10_168);
        assert_eq!(minute_amount(1, 1).unwrap(), 0);
    }
}
