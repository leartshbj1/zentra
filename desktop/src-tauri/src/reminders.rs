use chrono::{DateTime, Days, Local, NaiveDate};
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Transaction,
    TransactionBehavior,
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    accounting::validate_date,
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
    models::{
        InstallReminderCycleInput, MarkReminderInput, ReminderActionInput, ReminderFilter,
        ReminderPreviewInput, ReminderSettingsInput, ReminderTemplateInput, ScanRemindersInput,
    },
};

const MAX_PAYLOAD_BYTES: usize = 100_000;
const MAX_RESPONSE_BYTES: usize = 4_000_000;
const ALLOWED_PLACEHOLDERS: &[&str] = &[
    "balance",
    "balance_cents",
    "currency",
    "due_date",
    "payment_deadline",
    "client_name",
    "invoice_number",
    "sender_name",
];

#[derive(Debug)]
struct OperationState {
    request_id: String,
    payload_sha256: String,
    payload_json: String,
    replay: Option<Value>,
}

#[derive(Clone, Copy)]
struct DefaultTemplate {
    level: i64,
    name: &'static str,
    subject: &'static str,
    body: &'static str,
    days_after_due: i64,
    payment_deadline_days: i64,
}

const DEFAULT_CYCLE: [DefaultTemplate; 3] = [
    DefaultTemplate {
        level: 1,
        name: "Rappel amical",
        subject: "Rappel amical · facture {invoice_number}",
        body: "Bonjour {client_name},\n\nSauf erreur de notre part, le solde de {balance} relatif à la facture {invoice_number}, échue le {due_date}, reste ouvert.\n\nNous vous remercions d’effectuer le règlement d’ici au {payment_deadline} ou de nous signaler tout paiement déjà réalisé.\n\nAvec nos salutations,\n{sender_name}",
        days_after_due: 7,
        payment_deadline_days: 10,
    },
    DefaultTemplate {
        level: 2,
        name: "Première relance",
        subject: "Première relance · facture {invoice_number}",
        body: "Bonjour {client_name},\n\nNous constatons que le solde de {balance} de la facture {invoice_number}, échue le {due_date}, demeure ouvert malgré notre précédent rappel.\n\nMerci de régulariser la situation d’ici au {payment_deadline} ou de nous contacter si cette facture fait l’objet d’une contestation.\n\nAvec nos salutations,\n{sender_name}",
        days_after_due: 21,
        payment_deadline_days: 10,
    },
    DefaultTemplate {
        level: 3,
        name: "Dernière relance",
        subject: "Dernière relance · facture {invoice_number}",
        body: "Bonjour {client_name},\n\nLe solde de {balance} de la facture {invoice_number}, échue le {due_date}, reste ouvert. Nous vous invitons à régler ce montant d’ici au {payment_deadline} ou à prendre contact avec nous sans délai.\n\nToute démarche ultérieure restera soumise à une décision et à une vérification séparées. Elyko n’engage aucune poursuite automatiquement.\n\nAvec nos salutations,\n{sender_name}",
        days_after_due: 35,
        payment_deadline_days: 10,
    },
];

impl LocalStore {
    pub fn get_reminder_settings(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(query_all(
            &connection,
            "SELECT * FROM reminder_settings WHERE id=1",
            [],
        )?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
    }

    pub fn update_reminder_settings(&self, input: ReminderSettingsInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        transaction.execute(
            "INSERT INTO reminder_settings(id,enabled,sender_name,created_at,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,sender_name=excluded.sender_name,updated_at=excluded.updated_at",
            params![input.enabled as i64, clean(input.sender_name, 200), now, now],
        )?;
        let row = transaction.query_row(
            "SELECT * FROM reminder_settings WHERE id=1",
            [],
            crate::database::row_to_json_public,
        )?;
        append_audit(&transaction, "configure", "reminder_settings", "1", &row)?;
        transaction.commit()?;
        Ok(row)
    }

    pub fn install_reminder_cycle(&self, input: InstallReminderCycleInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(&transaction, &input.request_id, "install_cycle", &input)?;
        if let Some(replay) = operation.replay {
            return Ok(replay);
        }

        let existing = query_all(
            &transaction,
            "SELECT id,level,name,days_after_due,payment_deadline_days,active FROM reminder_templates ORDER BY level",
            [],
        )?;
        let mut effective = existing
            .iter()
            .filter_map(|row| {
                let level = row["level"].as_i64()?;
                let active = row["active"]
                    .as_bool()
                    .unwrap_or_else(|| row["active"].as_i64() == Some(1));
                let will_be_active =
                    active || DEFAULT_CYCLE.iter().any(|default| default.level == level);
                will_be_active.then_some((level, row["days_after_due"].as_i64()?))
            })
            .collect::<Vec<_>>();
        for default in DEFAULT_CYCLE {
            if !existing
                .iter()
                .any(|row| row["level"].as_i64() == Some(default.level))
            {
                effective.push((default.level, default.days_after_due));
            }
        }
        effective.sort_by_key(|(level, _)| *level);
        validate_increasing_delays(&effective)?;

        let now = now_iso();
        let fallback_sender: String =
            transaction.query_row("SELECT company_name FROM settings WHERE id=1", [], |row| {
                row.get(0)
            })?;
        let sender_name = clean(input.sender_name, 200).unwrap_or(fallback_sender);
        transaction.execute(
            "INSERT INTO reminder_settings(id,enabled,sender_name,created_at,updated_at) VALUES(1,1,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=1,sender_name=CASE WHEN excluded.sender_name<>'' THEN excluded.sender_name ELSE reminder_settings.sender_name END,updated_at=excluded.updated_at",
            params![sender_name, now, now],
        )?;

        let mut created_levels = Vec::new();
        let mut skipped_levels = Vec::new();
        let mut reactivated_levels = Vec::new();
        for default in DEFAULT_CYCLE {
            if let Some(row) = existing
                .iter()
                .find(|row| row["level"].as_i64() == Some(default.level))
            {
                skipped_levels.push(default.level);
                let active = row["active"]
                    .as_bool()
                    .unwrap_or_else(|| row["active"].as_i64() == Some(1));
                if !active {
                    transaction.execute(
                        "UPDATE reminder_templates SET active=1,updated_at=? WHERE id=?",
                        params![now, row["id"].as_str()],
                    )?;
                    reactivated_levels.push(default.level);
                }
                continue;
            }
            validate_template_text(default.subject, "subject", 300)?;
            validate_template_text(default.body, "body", 10_000)?;
            let id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO reminder_templates(id,level,name,subject,body,days_after_due,payment_deadline_days,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)",
                params![id,default.level,default.name,default.subject,default.body,default.days_after_due,default.payment_deadline_days,now,now],
            )?;
            created_levels.push(default.level);
        }

        let settings = transaction.query_row(
            "SELECT * FROM reminder_settings WHERE id=1",
            [],
            crate::database::row_to_json_public,
        )?;
        let templates = query_all(
            &transaction,
            "SELECT * FROM reminder_templates ORDER BY level",
            [],
        )?;
        let response = json!({
            "settings": settings,
            "templates": templates,
            "created_levels": created_levels,
            "reactivated_levels": reactivated_levels,
            "skipped_levels": skipped_levels,
            "idempotent": false
        });
        append_audit(
            &transaction,
            "install_cycle",
            "reminder_settings",
            "1",
            &json!({"created_levels":response["created_levels"],"reactivated_levels":response["reactivated_levels"],"skipped_levels":response["skipped_levels"]}),
        )?;
        finish_operation(&transaction, &operation, "install_cycle", &response)?;
        transaction.commit()?;
        Ok(response)
    }

    pub fn list_reminder_templates(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(Value::Array(query_all(
            &connection,
            "SELECT * FROM reminder_templates ORDER BY level",
            [],
        )?))
    }

    pub fn upsert_reminder_template(&self, input: ReminderTemplateInput) -> AppResult<Value> {
        validate_template_input(&input)?;
        let id = input
            .id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .map(|value| normalized_uuid(&value, "id"))
            .transpose()?
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let conflicting: Option<String> = transaction
            .query_row(
                "SELECT id FROM reminder_templates WHERE level=? AND id<>?",
                params![input.level, id],
                |row| row.get(0),
            )
            .optional()?;
        if conflicting.is_some() {
            return Err(AppError::Validation(format!(
                "Le niveau {} existe déjà. Modifiez ce modèle au lieu d’en créer un second.",
                input.level
            )));
        }
        let mut active_delays = query_all(
            &transaction,
            "SELECT level,days_after_due FROM reminder_templates WHERE active=1 AND id<>? ORDER BY level",
            params![id],
        )?
        .into_iter()
        .filter_map(|row| Some((row["level"].as_i64()?, row["days_after_due"].as_i64()?)))
        .collect::<Vec<_>>();
        if input.active {
            active_delays.push((input.level, input.days_after_due));
        }
        active_delays.sort_by_key(|(level, _)| *level);
        validate_increasing_delays(&active_delays)?;

        let now = now_iso();
        transaction.execute(
            "INSERT INTO reminder_templates(id,level,name,subject,body,days_after_due,payment_deadline_days,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET level=excluded.level,name=excluded.name,subject=excluded.subject,body=excluded.body,days_after_due=excluded.days_after_due,payment_deadline_days=excluded.payment_deadline_days,active=excluded.active,updated_at=excluded.updated_at",
            params![id,input.level,input.name.trim(),input.subject.trim(),input.body.trim(),input.days_after_due,input.payment_deadline_days,input.active as i64,now,now],
        )?;
        let row = transaction.query_row(
            "SELECT * FROM reminder_templates WHERE id=?",
            params![id],
            crate::database::row_to_json_public,
        )?;
        append_audit(&transaction, "upsert", "reminder_template", &id, &row)?;
        transaction.commit()?;
        Ok(row)
    }

    pub fn delete_reminder_template(&self, id: &str) -> AppResult<Value> {
        let id = normalized_uuid(id, "id")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = transaction
            .query_row(
                "SELECT * FROM reminder_templates WHERE id=?",
                params![id],
                crate::database::row_to_json_public,
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("reminder_templates/{id}")))?;
        transaction.execute("DELETE FROM reminder_templates WHERE id=?", params![id])?;
        append_audit(&transaction, "delete", "reminder_template", &id, &row)?;
        transaction.commit()?;
        Ok(json!({"deleted":true,"id":id}))
    }

    pub fn scan_due_reminders(&self, input: ScanRemindersInput) -> AppResult<Value> {
        let date = not_future_date(input.as_of.clone(), "as_of")?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(&transaction, &input.request_id, "scan", &input)?;
        if let Some(replay) = operation.replay {
            return Ok(replay);
        }

        let enabled = transaction
            .query_row(
                "SELECT enabled FROM reminder_settings WHERE id=1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            == 1;
        if !enabled {
            let response = json!({"as_of":date,"enabled":false,"created":[],"cancelled":[],"review":[],"idempotent":false});
            finish_operation(&transaction, &operation, "scan", &response)?;
            transaction.commit()?;
            return Ok(response);
        }

        let planned_due = query_all(
            &transaction,
            "SELECT id FROM reminders WHERE status='planned' AND scheduled_date<=? ORDER BY scheduled_date,id",
            params![date],
        )?;
        let mut promoted = Vec::new();
        for reminder in planned_due {
            let id = required_json_string(&reminder, "id", "Relance planifiée sans identifiant.")?;
            transaction.execute(
                "UPDATE reminders SET status='due',updated_at=? WHERE id=? AND status='planned'",
                params![now_iso(), id],
            )?;
            history(
                &transaction,
                id,
                "due",
                Some("Arrivée à échéance lors du contrôle local"),
            )?;
            promoted.push(id.to_owned());
        }

        let templates = query_all(
            &transaction,
            "SELECT * FROM reminder_templates WHERE active=1 ORDER BY level",
            [],
        )?;
        validate_increasing_delays(
            &templates
                .iter()
                .filter_map(|row| Some((row["level"].as_i64()?, row["days_after_due"].as_i64()?)))
                .collect::<Vec<_>>(),
        )?;
        let cancelled = cancel_all_settled(&transaction)?;
        let invoices = query_all(
            &transaction,
            r#"SELECT i.id,i.number,i.due_date,i.total_cents,i.paid_cents,i.currency,i.client_id,
                      COALESCE(NULLIF(TRIM(c.company),''),c.name,'') AS client_name,
                      c.email AS client_email,c.address_line1,c.address_line2,c.postal_code,c.city,c.canton,c.country,
                      s.company_name AS sender_company,s.legal_form AS sender_legal_form,s.owner_name AS sender_owner,
                      s.email AS sender_email,s.phone AS sender_phone,s.address_line1 AS sender_address_line1,
                      s.address_line2 AS sender_address_line2,s.postal_code AS sender_postal_code,s.city AS sender_city,
                      s.canton AS sender_canton,s.country AS sender_country,s.uid_number AS sender_uid_number,
                      s.logo_path AS sender_logo_path,rs.sender_name,
                      i.total_cents-i.paid_cents+COALESCE((SELECT SUM(cn.total_cents) FROM invoices cn WHERE cn.original_invoice_id=i.id AND cn.type='avoir' AND cn.number IS NOT NULL AND cn.status<>'annulee'),0) AS balance_cents
                 FROM invoices i
                 LEFT JOIN clients c ON c.id=i.client_id
                 JOIN settings s ON s.id=1
                 JOIN reminder_settings rs ON rs.id=1
                WHERE i.type<>'avoir' AND i.number IS NOT NULL
                  AND i.status IN('emise','partiellement_payee')
                  AND i.due_date IS NOT NULL AND i.due_date<=?
                  AND i.total_cents-i.paid_cents+COALESCE((SELECT SUM(cn.total_cents) FROM invoices cn WHERE cn.original_invoice_id=i.id AND cn.type='avoir' AND cn.number IS NOT NULL AND cn.status<>'annulee'),0)>0
                ORDER BY i.due_date,i.number"#,
            params![date],
        )?;

        let as_of_date = parse_date(&date, "as_of")?;
        let mut created = Vec::new();
        let mut review = Vec::new();
        for invoice in invoices {
            let invoice_id = required_json_string(&invoice, "id", "Facture sans identifiant.")?;
            let due_date = parse_date(
                invoice["due_date"].as_str().unwrap_or_default(),
                "Échéance de facture",
            )?;
            let latest: Option<(
                i64,
                String,
                String,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                i64,
            )> = transaction
                .query_row(
                    "SELECT r.level,r.status,r.id,r.snapshot_json,
                            (SELECT d.prepared_on FROM reminder_deliveries d WHERE d.reminder_id=r.id AND d.action='manual_sent' ORDER BY d.sequence DESC LIMIT 1),
                            (SELECT MAX(h.occurred_at) FROM reminder_history h WHERE h.reminder_id=r.id AND h.action='completed'),
                            (SELECT MAX(h.occurred_at) FROM reminder_history h WHERE h.reminder_id=r.id AND h.action='sent_manually'),
                            (EXISTS(SELECT 1 FROM reminder_history h WHERE h.reminder_id=r.id AND h.action='sent_manually')
                             OR EXISTS(SELECT 1 FROM reminder_deliveries d WHERE d.reminder_id=r.id AND d.action='manual_sent'))
                       FROM reminders r WHERE r.invoice_id=? ORDER BY r.level DESC,r.created_at DESC LIMIT 1",
                    params![invoice_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
                )
                .optional()?;
            let (minimum_level, previous_completed) = match latest {
                None => (0, None),
                Some((
                    level,
                    status,
                    id,
                    snapshot_json,
                    delivery_date,
                    completed_at,
                    sent_at,
                    sent_evidence,
                )) if status == "completed" => {
                    if sent_evidence != 1 {
                        review.push(json!({"invoice_id":invoice_id,"reminder_id":id,"reason":"previous_send_unverified"}));
                        continue;
                    }
                    let snapshot: Value =
                        serde_json::from_str(&snapshot_json).unwrap_or_else(|_| json!({}));
                    let previous_days = snapshot["days_after_due"].as_i64();
                    let Some(previous_days) = previous_days else {
                        review.push(json!({"invoice_id":invoice_id,"reminder_id":id,"reason":"previous_delay_unknown"}));
                        continue;
                    };
                    let completed_on = if let Some(delivery_date) = delivery_date {
                        Some(parse_date(&delivery_date, "Date locale de l’envoi")?)
                    } else {
                        let completed_on = completed_at
                            .as_deref()
                            .map(history_timestamp_local_date)
                            .transpose()?;
                        let sent_on = sent_at
                            .as_deref()
                            .map(history_timestamp_local_date)
                            .transpose()?;
                        match (completed_on, sent_on) {
                            (Some(completed_on), Some(sent_on)) => Some(completed_on.max(sent_on)),
                            (completed_on, sent_on) => completed_on.or(sent_on),
                        }
                    };
                    let Some(completed_on) = completed_on else {
                        review.push(json!({"invoice_id":invoice_id,"reminder_id":id,"reason":"previous_completion_unknown"}));
                        continue;
                    };
                    (level, Some((completed_on, previous_days, id)))
                }
                Some((_, status, id, _, _, _, _, _)) if status == "planned" || status == "due" => {
                    review.push(
                        json!({"invoice_id":invoice_id,"reminder_id":id,"reason":"already_open"}),
                    );
                    continue;
                }
                Some((_, _, id, _, _, _, _, _)) => {
                    review.push(
                        json!({"invoice_id":invoice_id,"reminder_id":id,"reason":"cycle_stopped"}),
                    );
                    continue;
                }
            };
            let Some(template) = templates
                .iter()
                .find(|template| template["level"].as_i64().unwrap_or(0) > minimum_level)
            else {
                continue;
            };
            let mut scheduled_date = due_date
                .checked_add_days(Days::new(
                    template["days_after_due"].as_i64().unwrap_or(0) as u64
                ))
                .ok_or_else(|| AppError::Validation("Date de relance hors limites.".into()))?;
            if let Some((completed_on, previous_days, previous_reminder_id)) = previous_completed {
                let current_days = template["days_after_due"].as_i64().unwrap_or(0);
                if current_days <= previous_days {
                    review.push(json!({
                        "invoice_id": invoice_id,
                        "reminder_id": previous_reminder_id,
                        "reason": "non_increasing_historical_delay"
                    }));
                    continue;
                }
                let gap_days = (current_days - previous_days) as u64;
                let next_after_completion = completed_on
                    .checked_add_days(Days::new(gap_days))
                    .ok_or_else(|| AppError::Validation("Date de relance hors limites.".into()))?;
                scheduled_date = scheduled_date.max(next_after_completion);
            }
            if scheduled_date > as_of_date {
                continue;
            }
            let payment_deadline_days = template["payment_deadline_days"].as_i64().unwrap_or(10);
            let payment_deadline = as_of_date
                .checked_add_days(Days::new(payment_deadline_days as u64))
                .ok_or_else(|| {
                    AppError::Validation("Nouveau délai de paiement hors limites.".into())
                })?
                .format("%Y-%m-%d")
                .to_string();
            let render_context = render_context(&invoice, &payment_deadline);
            let subject = render_template(
                template["subject"].as_str().unwrap_or_default(),
                &render_context,
            );
            let body = render_template(
                template["body"].as_str().unwrap_or_default(),
                &render_context,
            );
            let snapshot = json!({
                "schema":"elyko.reminder_snapshot.v2",
                "invoice_id":invoice["id"],"invoice_number":invoice["number"],"due_date":invoice["due_date"],
                "invoice_total_cents":invoice["total_cents"],"paid_cents":invoice["paid_cents"],
                "balance_cents":invoice["balance_cents"],"currency":invoice["currency"],
                "client":{"id":invoice["client_id"],"name":invoice["client_name"],"email":invoice["client_email"],
                    "address_line1":invoice["address_line1"],"address_line2":invoice["address_line2"],
                    "postal_code":invoice["postal_code"],"city":invoice["city"],"canton":invoice["canton"],"country":invoice["country"]},
                "sender":{"name":invoice["sender_name"],"company":invoice["sender_company"],"legal_form":invoice["sender_legal_form"],
                    "owner":invoice["sender_owner"],"email":invoice["sender_email"],"phone":invoice["sender_phone"],
                    "address_line1":invoice["sender_address_line1"],"address_line2":invoice["sender_address_line2"],
                    "postal_code":invoice["sender_postal_code"],"city":invoice["sender_city"],"canton":invoice["sender_canton"],
                    "country":invoice["sender_country"],"uid_number":invoice["sender_uid_number"],"logo_path":invoice["sender_logo_path"]},
                "template_id":template["id"],"template_level":template["level"],
                "template_subject":template["subject"],"template_body":template["body"],
                "days_after_due":template["days_after_due"],
                "payment_deadline_days":payment_deadline_days,"prepared_on":date
            });
            let id = Uuid::new_v4().to_string();
            let now = now_iso();
            transaction.execute(
                "INSERT INTO reminders(id,invoice_id,template_id,level,scheduled_date,status,subject,body,invoice_number,currency,invoice_total_cents,balance_cents,payment_deadline_days,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,'due',?,?,?,?,?,?,?,?,?,?)",
                params![id,invoice_id,template["id"].as_str(),template["level"].as_i64(),scheduled_date.format("%Y-%m-%d").to_string(),subject,body,invoice["number"].as_str(),invoice["currency"].as_str(),invoice["total_cents"].as_i64(),invoice["balance_cents"].as_i64(),payment_deadline_days,serde_json::to_string(&snapshot)?,now,now],
            )?;
            history(
                &transaction,
                &id,
                "created",
                Some("Créée par l’analyse locale supervisée"),
            )?;
            history(&transaction, &id, "due", None)?;
            created.push(reminder_row(&transaction, &id)?);
        }
        let scan_time = now_iso();
        transaction.execute(
            "UPDATE reminder_settings SET last_scan_at=?,updated_at=? WHERE id=1",
            params![scan_time, scan_time],
        )?;
        let response = json!({
            "as_of":date,"enabled":true,"created":created,"cancelled":cancelled,"promoted":promoted,
            "review":review,"idempotent":false
        });
        let created_count = response["created"].as_array().map_or(0, Vec::len);
        let cancelled_count = response["cancelled"].as_array().map_or(0, Vec::len);
        if created_count > 0 || cancelled_count > 0 {
            append_audit(
                &transaction,
                "scan",
                "reminders",
                &date,
                &json!({"created":created_count,"cancelled":cancelled_count}),
            )?;
        }
        finish_operation(&transaction, &operation, "scan", &response)?;
        transaction.commit()?;
        Ok(response)
    }

    /// Compatibilité interne pour les anciennes vues et sauvegardes de tests.
    pub fn generate_due_reminders(&self, as_of: Option<String>) -> AppResult<Value> {
        self.scan_due_reminders(ScanRemindersInput {
            request_id: Uuid::new_v4().to_string(),
            as_of,
        })
    }

    pub fn list_reminders(&self, filter: ReminderFilter) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut clauses = Vec::new();
        let mut values = Vec::new();
        if let Some(status) = filter.status {
            if !matches!(
                status.as_str(),
                "planned" | "due" | "completed" | "cancelled"
            ) {
                return Err(AppError::Validation("status de relance invalide.".into()));
            }
            clauses.push("r.status=?");
            values.push(SqlValue::Text(status));
        }
        if let Some(invoice_id) = filter.invoice_id {
            clauses.push("r.invoice_id=?");
            values.push(SqlValue::Text(invoice_id));
        }
        if let Some(date_from) = filter.date_from {
            validate_date(&date_from, "date_from")?;
            clauses.push("r.scheduled_date>=?");
            values.push(SqlValue::Text(date_from));
        }
        if let Some(date_to) = filter.date_to {
            validate_date(&date_to, "date_to")?;
            clauses.push("r.scheduled_date<=?");
            values.push(SqlValue::Text(date_to));
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let sql = format!(
            r#"SELECT r.*,i.due_date,i.title AS invoice_title,i.status AS invoice_status,
                      COALESCE(NULLIF(TRIM(c.company),''),c.name,'') AS client_name,c.email AS client_email,
                      c.address_line1 AS client_address_line1,c.address_line2 AS client_address_line2,
                      c.postal_code AS client_postal_code,c.city AS client_city,c.country AS client_country,
                      i.total_cents-i.paid_cents+COALESCE((SELECT SUM(cn.total_cents) FROM invoices cn WHERE cn.original_invoice_id=i.id AND cn.type='avoir' AND cn.number IS NOT NULL AND cn.status<>'annulee'),0) AS live_balance_cents,
                      CASE WHEN r.balance_cents<>(i.total_cents-i.paid_cents+COALESCE((SELECT SUM(cn.total_cents) FROM invoices cn WHERE cn.original_invoice_id=i.id AND cn.type='avoir' AND cn.number IS NOT NULL AND cn.status<>'annulee'),0)) THEN 1 ELSE 0 END AS snapshot_stale,
                      (SELECT d.action FROM reminder_deliveries d WHERE d.reminder_id=r.id ORDER BY d.sequence DESC LIMIT 1) AS last_delivery_action,
                      (SELECT d.created_at FROM reminder_deliveries d WHERE d.reminder_id=r.id ORDER BY d.sequence DESC LIMIT 1) AS last_delivery_at
                 FROM reminders r JOIN invoices i ON i.id=r.invoice_id LEFT JOIN clients c ON c.id=i.client_id
                 {where_sql}
                ORDER BY CASE r.status WHEN 'due' THEN 0 WHEN 'planned' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
                         r.scheduled_date,r.level"#
        );
        Ok(Value::Array(query_all(
            &connection,
            &sql,
            params_from_iter(values),
        )?))
    }

    pub fn preview_reminder_delivery(&self, input: ReminderPreviewInput) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let prepared_on = not_future_date(input.prepared_on, "prepared_on")?;
        build_preview(&connection, &input.id, &prepared_on)
    }

    pub fn get_reminder_history(&self, reminder_id: &str) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(Value::Array(query_all(
            &connection,
            "SELECT * FROM reminder_history WHERE reminder_id=? ORDER BY occurred_at,rowid",
            params![reminder_id],
        )?))
    }

    pub fn mark_reminder(&self, input: MarkReminderInput) -> AppResult<Value> {
        if input.status != "cancelled" {
            return Err(AppError::Validation(
                "Une clôture sans envoi doit être enregistrée comme annulée. Un envoi ne peut être clôturé qu’après sa confirmation.".into(),
            ));
        }
        let note = clean(input.note, 5000);
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<String> = transaction
            .query_row(
                "SELECT status FROM reminders WHERE id=?",
                params![input.id],
                |row| row.get(0),
            )
            .optional()?;
        let current =
            current.ok_or_else(|| AppError::NotFound(format!("reminders/{}", input.id)))?;
        if current == input.status {
            return reminder_row(&transaction, &input.id);
        }
        if !matches!(current.as_str(), "planned" | "due") {
            return Err(AppError::Validation(
                "Cette relance est déjà clôturée et son historique est immuable.".into(),
            ));
        }
        if note
            .as_deref()
            .map_or(true, |value| value.chars().count() < 3)
        {
            return Err(AppError::Validation(
                "Indiquez une raison claire (paiement promis, litige, accord téléphonique, etc.)."
                    .into(),
            ));
        }
        transaction.execute(
            "UPDATE reminders SET status=?,notes=?,updated_at=? WHERE id=?",
            params![input.status, note, now_iso(), input.id],
        )?;
        history(&transaction, &input.id, &input.status, note.as_deref())?;
        let row = reminder_row(&transaction, &input.id)?;
        append_audit(&transaction, "status", "reminder", &input.id, &row)?;
        transaction.commit()?;
        Ok(row)
    }

    pub fn record_reminder_action(&self, input: ReminderActionInput) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = begin_operation(&transaction, &input.request_id, "record_action", &input)?;
        if let Some(replay) = operation.replay {
            return Ok(replay);
        }
        if !matches!(
            input.action.as_str(),
            "print_confirmed" | "exported" | "mail_draft_created" | "manual_sent"
        ) {
            return Err(AppError::Validation(
                "Action locale de relance invalide.".into(),
            ));
        }
        let prepared_on = not_future_date(input.prepared_on.clone(), "prepared_on")?;
        let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
        if prepared_on != today {
            return Err(AppError::Validation(
                "L’aperçu date d’un autre jour. Régénérez-le avant toute action.".into(),
            ));
        }
        let expected_preview_sha = input
            .preview_sha256
            .as_deref()
            .filter(|value| {
                value.len() == 64
                    && value
                        .chars()
                        .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
            })
            .ok_or_else(|| {
                AppError::Validation("L’aperçu doit être régénéré avant cette action.".into())
            })?;
        let reminder: Option<(String, String)> = transaction
            .query_row(
                "SELECT invoice_id,status FROM reminders WHERE id=?",
                params![input.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (invoice_id, status) =
            reminder.ok_or_else(|| AppError::NotFound(format!("reminders/{}", input.id)))?;
        if status != "due" {
            return Err(AppError::Validation(
                "Seule une relance arrivée à échéance peut être préparée ou envoyée.".into(),
            ));
        }
        let balance = effective_balance(&transaction, &invoice_id)?;
        if balance <= 0 {
            transaction.execute(
                "UPDATE reminders SET status='cancelled',updated_at=? WHERE id=?",
                params![now_iso(), input.id],
            )?;
            history(
                &transaction,
                &input.id,
                "cancelled",
                Some("Facture soldée avant l’action"),
            )?;
            let response = json!({"blocked":true,"reason":"settled","reminder":reminder_row(&transaction,&input.id)?,"idempotent":false});
            finish_operation(&transaction, &operation, "record_action", &response)?;
            append_audit(
                &transaction,
                "cancelled_settled",
                "reminder",
                &input.id,
                &response,
            )?;
            transaction.commit()?;
            return Ok(response);
        }
        let preview = build_preview(&transaction, &input.id, &prepared_on)?;
        let actual_preview_sha = preview["preview_sha256"].as_str().unwrap_or_default();
        if actual_preview_sha != expected_preview_sha {
            return Err(AppError::Validation(
                "Le solde ou les coordonnées ont changé. Actualisez l’aperçu avant de continuer."
                    .into(),
            ));
        }
        if input.action == "mail_draft_created"
            && preview["recipient_email"]
                .as_str()
                .map_or(true, |email| email.trim().is_empty())
        {
            return Err(AppError::Validation(
                "Ajoutez une adresse e-mail au client avant de préparer le brouillon.".into(),
            ));
        }
        let delivery_action = input.action.as_str();
        let note = clean(input.note, 5000);
        if delivery_action == "manual_sent"
            && note
                .as_deref()
                .map_or(true, |value| value.chars().count() < 3)
        {
            return Err(AppError::Validation(
                "Indiquez le canal ou une référence avant de confirmer l’envoi réel.".into(),
            ));
        }
        let delivery_payload = json!({
            "schema":"elyko.reminder_delivery.v1",
            "action":delivery_action,
            "preview":preview,
            "note":note
        });
        let payload_json = serde_json::to_string(&delivery_payload)?;
        if payload_json.len() > MAX_RESPONSE_BYTES {
            return Err(AppError::Validation(
                "Le document de relance dépasse la taille autorisée.".into(),
            ));
        }
        let payload_sha256 = sha256_text(&payload_json);
        let delivery_id = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO reminder_deliveries(id,request_id,reminder_id,action,prepared_on,recipient_email,current_balance_cents,payment_deadline_date,subject,body,payload_sha256,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![delivery_id,operation.request_id,input.id,delivery_action,preview["prepared_on"].as_str(),preview["recipient_email"].as_str(),preview["current_balance_cents"].as_i64(),preview["payment_deadline_date"].as_str(),preview["subject"].as_str(),preview["body"].as_str(),payload_sha256,payload_json,now_iso()],
        )?;
        let history_action = match delivery_action {
            "print_confirmed" => "printed",
            "exported" => "exported",
            "mail_draft_created" => "mail_draft_created",
            "manual_sent" => "sent_manually",
            _ => unreachable!(),
        };
        let history_note = if delivery_action == "mail_draft_created" {
            Some(
                "Ouverture du client e-mail demandée ; la création d’un brouillon n’est pas vérifiable par Elyko.",
            )
        } else {
            note.as_deref()
        };
        history(&transaction, &input.id, history_action, history_note)?;
        if delivery_action == "manual_sent" {
            transaction.execute(
                "UPDATE reminders SET status='completed',updated_at=? WHERE id=?",
                params![now_iso(), input.id],
            )?;
            history(
                &transaction,
                &input.id,
                "completed",
                Some("Envoi confirmé manuellement"),
            )?;
        }
        let delivery = transaction.query_row(
            "SELECT * FROM reminder_deliveries WHERE id=?",
            params![delivery_id],
            crate::database::row_to_json_public,
        )?;
        let response = json!({
            "blocked":false,"delivery":delivery,"reminder":reminder_row(&transaction,&input.id)?,"idempotent":false
        });
        finish_operation(&transaction, &operation, "record_action", &response)?;
        append_audit(
            &transaction,
            delivery_action,
            "reminder",
            &input.id,
            &json!({"delivery_id":delivery_id,"payload_sha256":payload_sha256}),
        )?;
        transaction.commit()?;
        Ok(response)
    }
}

pub(crate) fn cancel_settled_reminders(
    transaction: &Transaction<'_>,
    invoice_id: &str,
) -> AppResult<Vec<String>> {
    let balance = effective_balance(transaction, invoice_id)?;
    if balance > 0 {
        return Ok(Vec::new());
    }
    let rows = query_all(
        transaction,
        "SELECT id FROM reminders WHERE invoice_id=? AND status IN('planned','due')",
        params![invoice_id],
    )?;
    let mut cancelled = Vec::new();
    for row in rows {
        if let Some(id) = row["id"].as_str() {
            transaction.execute(
                "UPDATE reminders SET status='cancelled',updated_at=? WHERE id=?",
                params![now_iso(), id],
            )?;
            history(
                transaction,
                id,
                "cancelled",
                Some("Solde de la facture nul"),
            )?;
            cancelled.push(id.to_owned());
        }
    }
    Ok(cancelled)
}

fn cancel_all_settled(transaction: &Transaction<'_>) -> AppResult<Vec<String>> {
    let invoices = query_all(
        transaction,
        "SELECT DISTINCT invoice_id FROM reminders WHERE status IN('planned','due')",
        [],
    )?;
    let mut ids = Vec::new();
    for row in invoices {
        if let Some(id) = row["invoice_id"].as_str() {
            ids.extend(cancel_settled_reminders(transaction, id)?);
        }
    }
    Ok(ids)
}

fn effective_balance(transaction: &Transaction<'_>, invoice_id: &str) -> AppResult<i64> {
    transaction
        .query_row(
            "SELECT i.total_cents-i.paid_cents+COALESCE((SELECT SUM(c.total_cents) FROM invoices c WHERE c.original_invoice_id=i.id AND c.type='avoir' AND c.number IS NOT NULL AND c.status<>'annulee'),0) FROM invoices i WHERE i.id=?",
            params![invoice_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("invoices/{invoice_id}")))
}

fn reminder_row(connection: &Connection, id: &str) -> AppResult<Value> {
    connection
        .query_row(
            "SELECT * FROM reminders WHERE id=?",
            params![id],
            crate::database::row_to_json_public,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("reminders/{id}")))
}

fn build_preview(connection: &Connection, id: &str, prepared_on: &str) -> AppResult<Value> {
    let id = normalized_uuid(id, "id")?;
    let prepared_date = parse_date(prepared_on, "prepared_on")?;
    let row = query_all(
        connection,
        r#"SELECT r.*,i.due_date,i.status AS invoice_status,i.client_id,
                  i.total_cents-i.paid_cents+COALESCE((SELECT SUM(cn.total_cents) FROM invoices cn WHERE cn.original_invoice_id=i.id AND cn.type='avoir' AND cn.number IS NOT NULL AND cn.status<>'annulee'),0) AS live_balance_cents,
                  COALESCE(NULLIF(TRIM(c.company),''),c.name,'') AS live_client_name,c.email AS live_client_email,
                  c.address_line1 AS live_address_line1,c.address_line2 AS live_address_line2,
                  c.postal_code AS live_postal_code,c.city AS live_city,c.canton AS live_canton,c.country AS live_country,
                  rs.sender_name AS live_sender_name,s.company_name AS live_sender_company,s.legal_form AS live_sender_legal_form,
                  s.owner_name AS live_sender_owner,s.email AS live_sender_email,s.phone AS live_sender_phone,
                  s.address_line1 AS live_sender_address_line1,s.address_line2 AS live_sender_address_line2,
                  s.postal_code AS live_sender_postal_code,s.city AS live_sender_city,s.canton AS live_sender_canton,
                  s.country AS live_sender_country,s.uid_number AS live_sender_uid_number,s.logo_path AS live_sender_logo_path
             FROM reminders r JOIN invoices i ON i.id=r.invoice_id LEFT JOIN clients c ON c.id=i.client_id
             JOIN settings s ON s.id=1 LEFT JOIN reminder_settings rs ON rs.id=1 WHERE r.id=?"#,
        params![id],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| AppError::NotFound(format!("reminders/{id}")))?;
    if row["status"].as_str() != Some("due") {
        if row["status"].as_str() == Some("planned") {
            return Err(AppError::Validation(
                "Cette relance est encore planifiée. Lancez le contrôle à sa date avant de préparer une action.".into(),
            ));
        }
        return Err(AppError::Validation(
            "Cette relance est clôturée et ne peut plus être préparée.".into(),
        ));
    }
    if !matches!(
        row["invoice_status"].as_str(),
        Some("emise" | "partiellement_payee")
    ) {
        return Err(AppError::Validation(
            "La facture n’est plus ouverte. Actualisez la file de relances.".into(),
        ));
    }
    let current_balance = row["live_balance_cents"].as_i64().unwrap_or(0);
    if current_balance <= 0 {
        return Err(AppError::Validation(
            "La facture est soldée. Actualisez la file : aucune relance ne doit partir.".into(),
        ));
    }
    let payment_deadline_days = row["payment_deadline_days"].as_i64().unwrap_or(10);
    let payment_deadline_date = prepared_date
        .checked_add_days(Days::new(payment_deadline_days as u64))
        .ok_or_else(|| AppError::Validation("Nouveau délai de paiement hors limites.".into()))?
        .format("%Y-%m-%d")
        .to_string();
    let snapshot: Value = serde_json::from_str(row["snapshot_json"].as_str().unwrap_or("{}"))
        .unwrap_or_else(|_| json!({}));
    let client_name = current_string(row.get("live_client_name"));
    let sender_name = first_string(&[row.get("live_sender_name"), row.get("live_sender_company")]);
    let template_subject = snapshot
        .get("template_subject")
        .and_then(Value::as_str)
        .unwrap_or_else(|| row["subject"].as_str().unwrap_or_default());
    let template_body = snapshot
        .get("template_body")
        .and_then(Value::as_str)
        .unwrap_or_else(|| row["body"].as_str().unwrap_or_default());
    let context = json!({
        "number":row["invoice_number"],"due_date":row["due_date"],"balance_cents":current_balance,
        "currency":row["currency"],"client_name":client_name,"sender_name":sender_name,
        "payment_deadline":payment_deadline_date
    });
    let client = json!({
        "name":client_name,
        "address_line1":current_string(row.get("live_address_line1")),
        "address_line2":current_string(row.get("live_address_line2")),
        "postal_code":current_string(row.get("live_postal_code")),
        "city":current_string(row.get("live_city")),
        "canton":current_string(row.get("live_canton")),
        "country":current_string(row.get("live_country"))
    });
    let sender = json!({
        "name":sender_name,
        "company":current_string(row.get("live_sender_company")),
        "legal_form":current_string(row.get("live_sender_legal_form")),
        "owner":current_string(row.get("live_sender_owner")),
        "email":current_string(row.get("live_sender_email")),
        "phone":current_string(row.get("live_sender_phone")),
        "address_line1":current_string(row.get("live_sender_address_line1")),
        "address_line2":current_string(row.get("live_sender_address_line2")),
        "postal_code":current_string(row.get("live_sender_postal_code")),
        "city":current_string(row.get("live_sender_city")),
        "canton":current_string(row.get("live_sender_canton")),
        "country":current_string(row.get("live_sender_country")),
        "uid_number":current_string(row.get("live_sender_uid_number")),
        "logo_path":current_string(row.get("live_sender_logo_path"))
    });
    let payload = json!({
        "schema":"elyko.reminder_preview.v1","reminder_id":id,"invoice_id":row["invoice_id"],
        "invoice_number":row["invoice_number"],"level":row["level"],"due_date":row["due_date"],
        "scheduled_date":row["scheduled_date"],"prepared_on":prepared_on,
        "payment_deadline_date":payment_deadline_date,"payment_deadline_days":payment_deadline_days,
        "currency":row["currency"],"snapshot_balance_cents":row["balance_cents"],
        "current_balance_cents":current_balance,"snapshot_stale":row["balance_cents"].as_i64()!=Some(current_balance),
        "template_review_required":snapshot["template_recovered_during_v24_migration"].as_bool().unwrap_or(false),
        "recipient_email":row["live_client_email"],"client":client,"sender":sender,
        "subject":render_template(template_subject,&context),"body":render_template(template_body,&context)
    });
    let canonical = serde_json::to_string(&payload)?;
    let mut result = payload;
    result
        .as_object_mut()
        .ok_or_else(|| AppError::Validation("Aperçu de relance invalide.".into()))?
        .insert(
            "preview_sha256".into(),
            Value::String(sha256_text(&canonical)),
        );
    Ok(result)
}

fn render_context(invoice: &Value, payment_deadline: &str) -> Value {
    json!({
        "number":invoice["number"],"due_date":invoice["due_date"],"balance_cents":invoice["balance_cents"],
        "currency":invoice["currency"],"client_name":invoice["client_name"],
        "sender_name":invoice["sender_name"],"payment_deadline":payment_deadline
    })
}

fn render_template(template: &str, context: &Value) -> String {
    let currency = context["currency"].as_str().unwrap_or("CHF");
    let cents = context["balance_cents"].as_i64().unwrap_or(0);
    template
        .replace(
            "{invoice_number}",
            context["number"].as_str().unwrap_or_default(),
        )
        .replace(
            "{due_date}",
            context["due_date"].as_str().unwrap_or_default(),
        )
        .replace(
            "{payment_deadline}",
            context["payment_deadline"].as_str().unwrap_or_default(),
        )
        .replace("{balance}", &format_money(cents, currency))
        .replace("{balance_cents}", &cents.to_string())
        .replace("{currency}", currency)
        .replace(
            "{client_name}",
            context["client_name"].as_str().unwrap_or_default(),
        )
        .replace(
            "{sender_name}",
            context["sender_name"].as_str().unwrap_or_default(),
        )
}

fn format_money(cents: i64, currency: &str) -> String {
    let sign = if cents < 0 { "−" } else { "" };
    let absolute = cents.unsigned_abs();
    let integer = absolute / 100;
    let decimals = absolute % 100;
    let digits = integer.to_string();
    let mut grouped = String::new();
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push('’');
        }
        grouped.push(character);
    }
    format!("{currency} {sign}{grouped}.{decimals:02}")
}

fn validate_template_input(input: &ReminderTemplateInput) -> AppResult<()> {
    if !(1..=10).contains(&input.level) {
        return Err(AppError::Validation(
            "Le niveau doit être compris entre 1 et 10.".into(),
        ));
    }
    if !(0..=3650).contains(&input.days_after_due) {
        return Err(AppError::Validation(
            "Le délai après échéance doit être compris entre 0 et 3650 jours.".into(),
        ));
    }
    if !(1..=90).contains(&input.payment_deadline_days) {
        return Err(AppError::Validation(
            "Le nouveau délai de paiement doit être compris entre 1 et 90 jours.".into(),
        ));
    }
    for (field, value, max) in [
        ("name", input.name.as_str(), 120),
        ("subject", input.subject.as_str(), 300),
        ("body", input.body.as_str(), 10_000),
    ] {
        if value.trim().is_empty() || value.chars().count() > max {
            return Err(AppError::Validation(format!(
                "{field} est obligatoire et limité à {max} caractères."
            )));
        }
    }
    validate_template_text(&input.subject, "subject", 300)?;
    validate_template_text(&input.body, "body", 10_000)
}

fn validate_template_text(value: &str, field: &str, max: usize) -> AppResult<()> {
    if value.trim().is_empty() || value.chars().count() > max {
        return Err(AppError::Validation(format!(
            "{field} est obligatoire et limité à {max} caractères."
        )));
    }
    for fragment in value.split('{').skip(1) {
        let Some((placeholder, _)) = fragment.split_once('}') else {
            return Err(AppError::Validation(format!(
                "Le champ {field} contient une accolade non refermée."
            )));
        };
        if !ALLOWED_PLACEHOLDERS.contains(&placeholder) {
            return Err(AppError::Validation(format!(
                "Le champ {field} contient la variable inconnue {{{placeholder}}}."
            )));
        }
    }
    Ok(())
}

fn validate_increasing_delays(values: &[(i64, i64)]) -> AppResult<()> {
    for pair in values.windows(2) {
        if pair[0].0 >= pair[1].0 || pair[0].1 >= pair[1].1 {
            return Err(AppError::Validation(
                "Les niveaux actifs doivent être uniques et leurs délais strictement croissants."
                    .into(),
            ));
        }
    }
    Ok(())
}

fn history(
    transaction: &Transaction<'_>,
    id: &str,
    action: &str,
    note: Option<&str>,
) -> AppResult<Value> {
    let history_id = Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO reminder_history(id,reminder_id,action,occurred_at,note) VALUES(?,?,?,?,?)",
        params![history_id, id, action, now_iso(), note],
    )?;
    Ok(transaction.query_row(
        "SELECT * FROM reminder_history WHERE id=?",
        params![history_id],
        crate::database::row_to_json_public,
    )?)
}

fn begin_operation<T: Serialize>(
    transaction: &Transaction<'_>,
    request_id: &str,
    operation: &str,
    payload: &T,
) -> AppResult<OperationState> {
    let request_id = normalized_uuid(request_id, "request_id")?;
    let mut payload_value = serde_json::to_value(payload)?;
    payload_value
        .as_object_mut()
        .ok_or_else(|| {
            AppError::Validation("La requête de relance doit être un objet JSON.".into())
        })?
        .remove("request_id");
    let payload_json = serde_json::to_string(&payload_value)?;
    if payload_json.len() > MAX_PAYLOAD_BYTES {
        return Err(AppError::Validation(
            "La requête de relance dépasse la taille autorisée.".into(),
        ));
    }
    let payload_sha256 = sha256_text(&payload_json);
    let existing: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT operation,payload_sha256,response_json FROM reminder_operation_requests WHERE request_id=?",
            params![request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((stored_operation, stored_hash, stored_response)) = existing {
        if stored_operation != operation || stored_hash != payload_sha256 {
            return Err(AppError::Validation(
                "Ce request_id a déjà été utilisé avec une autre opération de relance.".into(),
            ));
        }
        let mut replay: Value = serde_json::from_str(&stored_response)?;
        replay
            .as_object_mut()
            .ok_or_else(|| AppError::Validation("La reprise de relance est invalide.".into()))?
            .insert("idempotent".into(), Value::Bool(true));
        return Ok(OperationState {
            request_id,
            payload_sha256,
            payload_json,
            replay: Some(replay),
        });
    }
    Ok(OperationState {
        request_id,
        payload_sha256,
        payload_json,
        replay: None,
    })
}

fn finish_operation(
    transaction: &Transaction<'_>,
    state: &OperationState,
    operation: &str,
    response: &Value,
) -> AppResult<()> {
    let response_json = serde_json::to_string(response)?;
    if response_json.len() > MAX_RESPONSE_BYTES {
        return Err(AppError::Validation(
            "La réponse de relance dépasse la taille autorisée.".into(),
        ));
    }
    transaction.execute(
        "INSERT INTO reminder_operation_requests(request_id,operation,payload_sha256,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?)",
        params![state.request_id,operation,state.payload_sha256,state.payload_json,response_json,now_iso()],
    )?;
    Ok(())
}

fn sha256_text(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn normalized_uuid(value: &str, field: &str) -> AppResult<String> {
    Uuid::parse_str(value.trim())
        .map(|value| value.to_string())
        .map_err(|_| AppError::Validation(format!("{field} doit être un UUID valide.")))
}

fn not_future_date(value: Option<String>, field: &str) -> AppResult<String> {
    let value = value
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    validate_date(&value, field)?;
    let parsed = parse_date(&value, field)?;
    if parsed > Local::now().date_naive() {
        return Err(AppError::Validation(format!(
            "{field} ne peut pas être dans le futur."
        )));
    }
    Ok(value)
}

fn parse_date(value: &str, field: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
        AppError::Validation(format!(
            "{field} doit être une date valide au format AAAA-MM-JJ."
        ))
    })
}

fn history_timestamp_local_date(value: &str) -> AppResult<NaiveDate> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Local).date_naive())
        .map_err(|_| AppError::Validation("Horodatage historique de relance invalide.".into()))
}

fn required_json_string<'a>(value: &'a Value, key: &str, message: &str) -> AppResult<&'a str> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Validation(message.into()))
}

fn first_string(values: &[Option<&Value>]) -> String {
    values
        .iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_owned()
}

fn current_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned()
}

fn clean(value: Option<String>, max: usize) -> Option<String> {
    value
        .map(|value| value.trim().chars().take(max).collect::<String>())
        .filter(|value| !value.is_empty())
}
