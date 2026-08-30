use chrono::{Days, NaiveDate};
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, OptionalExtension, Transaction,
    TransactionBehavior,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    accounting::validate_date,
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
    models::{
        MarkReminderInput, ReminderActionInput, ReminderFilter, ReminderSettingsInput,
        ReminderTemplateInput,
    },
};

impl LocalStore {
    pub fn get_reminder_settings(&self) -> AppResult<Value> {
        let c = self.connect()?;
        self.require_onboarding(&c)?;
        Ok(
            query_all(&c, "SELECT * FROM reminder_settings WHERE id=1", [])?
                .into_iter()
                .next()
                .unwrap_or(Value::Null),
        )
    }

    pub fn update_reminder_settings(&self, input: ReminderSettingsInput) -> AppResult<Value> {
        let mut c = self.connect()?;
        self.require_onboarding(&c)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_iso();
        tx.execute("INSERT INTO reminder_settings(id,enabled,sender_name,created_at,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,sender_name=excluded.sender_name,updated_at=excluded.updated_at",params![input.enabled as i64,clean(input.sender_name,200),now,now])?;
        let row = tx.query_row(
            "SELECT * FROM reminder_settings WHERE id=1",
            [],
            crate::database::row_to_json_public,
        )?;
        append_audit(&tx, "configure", "reminder_settings", "1", &row)?;
        tx.commit()?;
        Ok(row)
    }

    pub fn list_reminder_templates(&self) -> AppResult<Value> {
        let c = self.connect()?;
        self.require_onboarding(&c)?;
        Ok(Value::Array(query_all(
            &c,
            "SELECT * FROM reminder_templates ORDER BY level",
            [],
        )?))
    }

    pub fn upsert_reminder_template(&self, input: ReminderTemplateInput) -> AppResult<Value> {
        if !(1..=10).contains(&input.level) || input.days_after_due < 0 {
            return Err(AppError::Validation(
                "level doit être entre 1 et 10 et days_after_due positif ou nul.".into(),
            ));
        }
        for (name, value, max) in [
            ("name", &input.name, 120),
            ("subject", &input.subject, 300),
            ("body", &input.body, 10_000),
        ] {
            if value.trim().is_empty() || value.chars().count() > max {
                return Err(AppError::Validation(format!(
                    "{name} est obligatoire et limité à {max} caractères."
                )));
            }
        }
        let id = input
            .id
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = now_iso();
        let mut c = self.connect()?;
        self.require_onboarding(&c)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO reminder_templates(id,level,name,subject,body,days_after_due,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET level=excluded.level,name=excluded.name,subject=excluded.subject,body=excluded.body,days_after_due=excluded.days_after_due,active=excluded.active,updated_at=excluded.updated_at",params![id,input.level,input.name.trim(),input.subject.trim(),input.body.trim(),input.days_after_due,input.active as i64,now,now])?;
        let row = tx.query_row(
            "SELECT * FROM reminder_templates WHERE id=?",
            params![id],
            crate::database::row_to_json_public,
        )?;
        append_audit(&tx, "upsert", "reminder_template", &id, &row)?;
        tx.commit()?;
        Ok(row)
    }

    pub fn delete_reminder_template(&self, id: &str) -> AppResult<Value> {
        let mut c = self.connect()?;
        self.require_onboarding(&c)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = tx
            .query_row(
                "SELECT * FROM reminder_templates WHERE id=?",
                params![id],
                crate::database::row_to_json_public,
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("reminder_templates/{id}")))?;
        tx.execute("DELETE FROM reminder_templates WHERE id=?", params![id])?;
        append_audit(&tx, "delete", "reminder_template", id, &row)?;
        tx.commit()?;
        Ok(json!({"deleted":true,"id":id}))
    }

    pub fn generate_due_reminders(&self, as_of: Option<String>) -> AppResult<Value> {
        let date = as_of.unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
        validate_date(&date, "as_of")?;
        let mut c = self.connect()?;
        self.require_onboarding(&c)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let enabled: bool = tx
            .query_row(
                "SELECT enabled FROM reminder_settings WHERE id=1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            == 1;
        if !enabled {
            return Ok(json!({"as_of":date,"enabled":false,"created":[],"cancelled":[]}));
        }
        let templates = query_all(
            &tx,
            "SELECT * FROM reminder_templates WHERE active=1 ORDER BY level",
            [],
        )?;
        let invoices=query_all(&tx,"SELECT i.id,i.number,i.due_date,i.total_cents,i.paid_cents,i.currency,i.client_id,COALESCE(c.name,c.company,'') AS client_name,i.total_cents-i.paid_cents+COALESCE(SUM(cn.total_cents),0) AS balance_cents FROM invoices i LEFT JOIN clients c ON c.id=i.client_id LEFT JOIN invoices cn ON cn.original_invoice_id=i.id AND cn.type='avoir' AND cn.number IS NOT NULL AND cn.status<>'annulee' WHERE i.type<>'avoir' AND i.number IS NOT NULL AND i.status IN('emise','partiellement_payee') AND i.due_date IS NOT NULL AND i.due_date<? GROUP BY i.id HAVING balance_cents>0 ORDER BY i.due_date",params![date])?;
        let mut created = Vec::new();
        for invoice in invoices {
            let due =
                NaiveDate::parse_from_str(invoice["due_date"].as_str().unwrap_or(""), "%Y-%m-%d")
                    .map_err(|_| AppError::Validation("Échéance de facture invalide.".into()))?;
            let last: Option<(i64, String)> = tx
                .query_row(
                    "SELECT level,status FROM reminders WHERE invoice_id=? ORDER BY level DESC LIMIT 1",
                    params![invoice["id"].as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let minimum_level = match last {
                None => i64::MIN,
                Some((level, status)) if status == "completed" => level,
                Some(_) => continue,
            };
            let Some(template) = templates
                .iter()
                .find(|template| template["level"].as_i64().unwrap_or(0) > minimum_level)
            else {
                continue;
            };
            let scheduled = due
                .checked_add_days(Days::new(
                    template["days_after_due"].as_i64().unwrap_or(0) as u64
                ))
                .ok_or_else(|| AppError::Validation("Date de relance hors limites.".into()))?
                .format("%Y-%m-%d")
                .to_string();
            if scheduled > date {
                continue;
            }
            let id = Uuid::new_v4().to_string();
            let subject = render(template["subject"].as_str().unwrap_or(""), &invoice);
            let body = render(template["body"].as_str().unwrap_or(""), &invoice);
            let snapshot = json!({"invoice_id":invoice["id"],"invoice_number":invoice["number"],"due_date":invoice["due_date"],"invoice_total_cents":invoice["total_cents"],"paid_cents":invoice["paid_cents"],"balance_cents":invoice["balance_cents"],"currency":invoice["currency"],"client_id":invoice["client_id"],"client_name":invoice["client_name"],"template_id":template["id"],"template_level":template["level"]});
            let now = now_iso();
            tx.execute("INSERT INTO reminders(id,invoice_id,template_id,level,scheduled_date,status,subject,body,invoice_number,currency,invoice_total_cents,balance_cents,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,'due',?,?,?,?,?,?,?,?,?)",params![id,invoice["id"].as_str(),template["id"].as_str(),template["level"].as_i64(),scheduled,subject,body,invoice["number"].as_str(),invoice["currency"].as_str(),invoice["total_cents"].as_i64(),invoice["balance_cents"].as_i64(),serde_json::to_string(&snapshot)?,now,now])?;
            history(&tx, &id, "created", None)?;
            history(&tx, &id, "due", None)?;
            created.push(tx.query_row(
                "SELECT * FROM reminders WHERE id=?",
                params![id],
                crate::database::row_to_json_public,
            )?);
        }
        let cancelled = cancel_all_settled(&tx)?;
        append_audit(
            &tx,
            "generate",
            "reminders",
            &date,
            &json!({"created":created.len(),"cancelled":cancelled.len()}),
        )?;
        tx.commit()?;
        Ok(json!({"as_of":date,"enabled":true,"created":created,"cancelled":cancelled}))
    }

    pub fn list_reminders(&self, filter: ReminderFilter) -> AppResult<Value> {
        let c = self.connect()?;
        self.require_onboarding(&c)?;
        let mut clauses = Vec::new();
        let mut values = Vec::new();
        if let Some(v) = filter.status {
            if !matches!(v.as_str(), "planned" | "due" | "completed" | "cancelled") {
                return Err(AppError::Validation("status de relance invalide.".into()));
            }
            clauses.push("r.status=?");
            values.push(SqlValue::Text(v));
        }
        if let Some(v) = filter.invoice_id {
            clauses.push("r.invoice_id=?");
            values.push(SqlValue::Text(v));
        }
        if let Some(v) = filter.date_from {
            validate_date(&v, "date_from")?;
            clauses.push("r.scheduled_date>=?");
            values.push(SqlValue::Text(v));
        }
        if let Some(v) = filter.date_to {
            validate_date(&v, "date_to")?;
            clauses.push("r.scheduled_date<=?");
            values.push(SqlValue::Text(v));
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        Ok(Value::Array(query_all(&c,&format!("SELECT r.* FROM reminders r {where_sql} ORDER BY r.scheduled_date DESC,r.level DESC"),params_from_iter(values))?))
    }
    pub fn get_reminder_history(&self, reminder_id: &str) -> AppResult<Value> {
        let c = self.connect()?;
        self.require_onboarding(&c)?;
        Ok(Value::Array(query_all(
            &c,
            "SELECT * FROM reminder_history WHERE reminder_id=? ORDER BY occurred_at,rowid",
            params![reminder_id],
        )?))
    }
    pub fn mark_reminder(&self, input: MarkReminderInput) -> AppResult<Value> {
        if !matches!(
            input.status.as_str(),
            "planned" | "due" | "completed" | "cancelled"
        ) {
            return Err(AppError::Validation("status de relance invalide.".into()));
        }
        let mut c = self.connect()?;
        self.require_onboarding(&c)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.execute(
            "UPDATE reminders SET status=?,notes=COALESCE(?,notes),updated_at=? WHERE id=?",
            params![
                input.status,
                clean(input.note.clone(), 5000),
                now_iso(),
                input.id
            ],
        )? != 1
        {
            return Err(AppError::NotFound(format!("reminders/{}", input.id)));
        }
        history(
            &tx,
            &input.id,
            &input.status,
            clean(input.note, 5000).as_deref(),
        )?;
        let row = tx.query_row(
            "SELECT * FROM reminders WHERE id=?",
            params![input.id],
            crate::database::row_to_json_public,
        )?;
        append_audit(&tx, "status", "reminder", &input.id, &row)?;
        tx.commit()?;
        Ok(row)
    }
    pub fn record_reminder_action(&self, input: ReminderActionInput) -> AppResult<Value> {
        if !matches!(
            input.action.as_str(),
            "printed" | "exported" | "sent_manually" | "note"
        ) {
            return Err(AppError::Validation(
                "action locale de relance invalide.".into(),
            ));
        }
        let mut c = self.connect()?;
        self.require_onboarding(&c)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM reminders WHERE id=?)",
            params![input.id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(AppError::NotFound(format!("reminders/{}", input.id)));
        }
        let row = history(
            &tx,
            &input.id,
            &input.action,
            clean(input.note, 5000).as_deref(),
        )?;
        append_audit(&tx, &input.action, "reminder", &input.id, &row)?;
        tx.commit()?;
        Ok(row)
    }
}

pub(crate) fn cancel_settled_reminders(
    tx: &Transaction<'_>,
    invoice_id: &str,
) -> AppResult<Vec<String>> {
    let balance = effective_balance(tx, invoice_id)?;
    if balance > 0 {
        return Ok(Vec::new());
    }
    let ids = query_all(
        tx,
        "SELECT id FROM reminders WHERE invoice_id=? AND status IN('planned','due')",
        params![invoice_id],
    )?;
    let mut cancelled = Vec::new();
    for row in ids {
        if let Some(id) = row["id"].as_str() {
            tx.execute(
                "UPDATE reminders SET status='cancelled',updated_at=? WHERE id=?",
                params![now_iso(), id],
            )?;
            history(tx, id, "cancelled", Some("Solde de la facture nul"))?;
            cancelled.push(id.to_owned());
        }
    }
    Ok(cancelled)
}
fn cancel_all_settled(tx: &Transaction<'_>) -> AppResult<Vec<String>> {
    let invoices = query_all(
        tx,
        "SELECT DISTINCT invoice_id FROM reminders WHERE status IN('planned','due')",
        [],
    )?;
    let mut ids = Vec::new();
    for row in invoices {
        if let Some(id) = row["invoice_id"].as_str() {
            ids.extend(cancel_settled_reminders(tx, id)?);
        }
    }
    Ok(ids)
}
fn effective_balance(tx: &Transaction<'_>, invoice_id: &str) -> AppResult<i64> {
    tx.query_row("SELECT i.total_cents-i.paid_cents+COALESCE((SELECT SUM(c.total_cents) FROM invoices c WHERE c.original_invoice_id=i.id AND c.type='avoir' AND c.number IS NOT NULL AND c.status<>'annulee'),0) FROM invoices i WHERE i.id=?",params![invoice_id],|r|r.get(0)).optional()?.ok_or_else(||AppError::NotFound(format!("invoices/{invoice_id}")))
}
fn history(tx: &Transaction<'_>, id: &str, action: &str, note: Option<&str>) -> AppResult<Value> {
    let hid = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO reminder_history(id,reminder_id,action,occurred_at,note) VALUES(?,?,?,?,?)",
        params![hid, id, action, now_iso(), note],
    )?;
    Ok(tx.query_row(
        "SELECT * FROM reminder_history WHERE id=?",
        params![hid],
        crate::database::row_to_json_public,
    )?)
}
fn render(template: &str, invoice: &Value) -> String {
    template
        .replace("{invoice_number}", invoice["number"].as_str().unwrap_or(""))
        .replace("{due_date}", invoice["due_date"].as_str().unwrap_or(""))
        .replace(
            "{balance_cents}",
            &invoice["balance_cents"].as_i64().unwrap_or(0).to_string(),
        )
        .replace(
            "{client_name}",
            invoice["client_name"].as_str().unwrap_or(""),
        )
}
fn clean(value: Option<String>, max: usize) -> Option<String> {
    value
        .map(|v| v.trim().chars().take(max).collect::<String>())
        .filter(|v| !v.is_empty())
}
