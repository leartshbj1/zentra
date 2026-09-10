//! A stopped timer can outlive its original project without losing its evidence.
//! The caller holds the LocalStore gate; no shared row changes when it is parked.
use crate::{
    database::LocalStore,
    error::{AppError, AppResult},
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub(crate) const MIGRATION_SQL: &str = include_str!("../timer_recoveries.sql");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Timer {
    id: i64,
    project_id: String,
    task_id: Option<String>,
    employee_id: Option<String>,
    started_at: String,
    note: Option<String>,
    billable: i64,
    billing_rate_cents: i64,
    cost_rate_cents: i64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u32,
    timer: Timer,
    project_name: String,
    task_title: Option<String>,
    employee_name: Option<String>,
    ended_at: String,
    elapsed_seconds: i64,
    minutes: i64,
    break_minutes: i64,
    rounding_minutes: i64,
    configured_break_minutes: i64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Assignment {
    pub project_id: String,
    pub task_id: Option<String>,
    pub employee_id: Option<String>,
}
struct Retained {
    snapshot: Snapshot,
    timer_sha256: String,
    entry_id: Option<String>,
    assignment_json: Option<String>,
}
type StoredRecoveryRow = (String, String, String, Option<String>, Option<String>);
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn timer(c: &Connection) -> AppResult<Option<Timer>> {
    c.query_row("SELECT id,project_id,task_id,employee_id,started_at,note,billable,billing_rate_cents,cost_rate_cents FROM active_timers WHERE id=1", [], |r| Ok(Timer {
        id:r.get(0)?, project_id:r.get(1)?, task_id:r.get(2)?, employee_id:r.get(3)?,
        started_at:r.get(4)?, note:r.get(5)?, billable:r.get(6)?, billing_rate_cents:r.get(7)?, cost_rate_cents:r.get(8)?,
    })).optional().map_err(Into::into)
}
fn digest(timer: &Timer) -> AppResult<String> {
    Ok(hash(&serde_json::to_string(timer)?))
}
fn totals(seconds: i64, rounding: i64, configured_break: i64) -> AppResult<(i64, i64)> {
    if seconds < 0 || !(0..=1440).contains(&rounding) || !(0..=1440).contains(&configured_break) {
        return Err(invalid("L’horloge ou les règles d’arrondi et de pause du pointage sont invalides. Le chronomètre est conservé."));
    }
    let elapsed = (seconds.saturating_add(59) / 60).max(1);
    let pause = configured_break.min(elapsed - 1);
    let worked = elapsed - pause;
    let minutes = if rounding > 1 {
        worked.saturating_add(rounding - 1) / rounding * rounding
    } else {
        worked
    };
    Ok((minutes, pause))
}
fn retained(c: &Connection, id: &str) -> AppResult<Option<Retained>> {
    let row: Option<StoredRecoveryRow> = c.query_row(
        "SELECT snapshot_json,snapshot_sha256,timer_sha256,entry_id,assignment_json FROM timer_recoveries WHERE id=?1", [id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
    ).optional()?;
    let Some((raw, expected, timer_sha256, entry_id, assignment_json)) = row else {
        return Ok(None);
    };
    if raw.len() > 64 * 1024 || hash(&raw) != expected {
        return Err(invalid("La copie conservée du pointage est altérée."));
    }
    let s: Snapshot = serde_json::from_str(&raw)?;
    let start = DateTime::parse_from_rfc3339(&s.timer.started_at)
        .map_err(|_| invalid("Le début du pointage conservé est invalide."))?;
    let end = DateTime::parse_from_rfc3339(&s.ended_at)
        .map_err(|_| invalid("La fin du pointage conservé est invalide."))?;
    let actual_seconds = end.signed_duration_since(start).num_seconds();
    if s.version != 1
        || s.timer.id != 1
        || digest(&s.timer)? != timer_sha256
        || actual_seconds != s.elapsed_seconds
        || (s.minutes, s.break_minutes)
            != totals(
                actual_seconds,
                s.rounding_minutes,
                s.configured_break_minutes,
            )?
        || !matches!(s.timer.billable, 0 | 1)
        || s.timer.billing_rate_cents < 0
        || s.timer.cost_rate_cents < 0
    {
        return Err(invalid(
            "Les informations du pointage conservé sont incohérentes.",
        ));
    }
    Ok(Some(Retained {
        snapshot: s,
        timer_sha256,
        entry_id,
        assignment_json,
    }))
}

pub(crate) fn state(store: &LocalStore) -> AppResult<Value> {
    let c = store.connect()?;
    let tx = c.unchecked_transaction()?;
    let c = &tx;
    store.require_onboarding(c)?;
    let active = timer(c)?
        .map(|t| digest(&t).map(|sha| json!({"timer":t,"sha256":sha})))
        .transpose()?;
    let ids = c
        .prepare("SELECT id FROM timer_recoveries WHERE entry_id IS NULL ORDER BY rowid")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut pending = Vec::new();
    for id in ids {
        let r =
            retained(c, &id)?.ok_or_else(|| invalid("Le pointage conservé est introuvable."))?;
        pending.push(json!({"id":id,"snapshot":r.snapshot}));
    }
    let resolution_pending: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_resolution_intent)",
        [],
        |r| r.get(0),
    )?;
    Ok(json!({"active":active,"pending":pending,"resolution_pending":resolution_pending}))
}

pub(crate) fn park(store: &LocalStore, id: &str, expected_timer_sha256: &str) -> AppResult<Value> {
    park_at(store, id, expected_timer_sha256, Utc::now())
}
fn park_at(store: &LocalStore, id: &str, expected: &str, ended: DateTime<Utc>) -> AppResult<Value> {
    Uuid::parse_str(id)
        .map_err(|_| invalid("L’identifiant de conservation du pointage est invalide."))?;
    store.require_write_access()?;
    let mut c = store.connect()?;
    store.require_onboarding(&c)?;
    c.pragma_update(None, "synchronous", "FULL")?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(saved) = retained(&tx, id)? {
        if saved.timer_sha256 != expected {
            return Err(invalid("Cet identifiant appartient à un autre pointage."));
        }
        return Ok(json!({"id":id,"already_preserved":true,"entry_id":saved.entry_id}));
    }
    let active = timer(&tx)?.ok_or_else(|| invalid("Aucun chronomètre actif à conserver."))?;
    if digest(&active)? != expected {
        return Err(invalid(
            "Le chronomètre a changé. Relisez le pointage avant de le conserver.",
        ));
    }
    let started = DateTime::parse_from_rfc3339(&active.started_at)
        .map_err(|_| invalid("Le début du chronomètre est invalide."))?;
    // A clock rollback must not turn a running timer into an invented one-minute entry.
    if ended < started {
        return Err(invalid(
            "L’heure de l’appareil précède le début du pointage. Le chronomètre est conservé.",
        ));
    }
    let seconds = ended.signed_duration_since(started).num_seconds();
    let raw: String = tx.query_row(
        "SELECT extra_settings_json FROM settings WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    let settings: Value = serde_json::from_str(&raw)?;
    let rounding = settings
        .pointer("/work/roundingMinutes")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let configured_break = settings
        .pointer("/work/breakMinutes")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let (minutes, pause) = totals(seconds, rounding, configured_break)?;
    let snapshot = Snapshot {
        version: 1,
        project_name: tx.query_row(
            "SELECT name FROM projects WHERE id=?1",
            [&active.project_id],
            |r| r.get(0),
        )?,
        task_title: tx
            .query_row(
                "SELECT title FROM project_tasks WHERE id=?1",
                [&active.task_id],
                |r| r.get(0),
            )
            .optional()?,
        employee_name: tx
            .query_row(
                "SELECT name FROM employees WHERE id=?1",
                [&active.employee_id],
                |r| r.get(0),
            )
            .optional()?,
        timer: active,
        ended_at: ended.to_rfc3339(),
        elapsed_seconds: seconds,
        minutes,
        break_minutes: pause,
        rounding_minutes: rounding,
        configured_break_minutes: configured_break,
    };
    let raw = serde_json::to_string(&snapshot)?;
    tx.execute("INSERT INTO timer_recoveries(id,timer_sha256,snapshot_json,snapshot_sha256) VALUES(?1,?2,?3,?4)", params![id,expected,raw,hash(&raw)])?;
    tx.execute("DELETE FROM active_timers WHERE id=1", [])?;
    tx.commit()?;
    Ok(json!({"id":id,"already_preserved":false,"entry_id":null}))
}

pub(crate) fn assign(store: &LocalStore, id: &str, assignment: Assignment) -> AppResult<Value> {
    store.require_write_access()?;
    let mut c = store.connect()?;
    store.require_onboarding(&c)?;
    c.pragma_update(None, "synchronous", "FULL")?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let saved =
        retained(&tx, id)?.ok_or_else(|| invalid("Le pointage conservé est introuvable."))?;
    let raw_assignment = serde_json::to_string(&assignment)?;
    if let Some(entry_id) = saved.entry_id {
        if saved.assignment_json.as_deref() != Some(&raw_assignment) {
            return Err(invalid(
                "Ce pointage a déjà été affecté à une autre saisie.",
            ));
        }
        return Ok(json!({"entry_id":entry_id,"already_saved":true}));
    }
    let frozen: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM business_sync_resolution_intent)",
        [],
        |r| r.get(0),
    )?;
    if frozen {
        return Err(invalid(
            "Terminez la résolution protégée avant d’affecter ce pointage.",
        ));
    }
    let open: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND status IN ('planifie','en_cours','en_pause','termine'))",
        [&assignment.project_id],
        |r| r.get(0),
    )?;
    if !open {
        return Err(invalid(
            "Choisissez un projet existant et ouvert pour ce pointage.",
        ));
    }
    let s = saved.snapshot;
    let id_entry = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    // Task/project and employee foreign keys, audit and capture guards all remain enabled.
    tx.execute("INSERT INTO time_entries(id,project_id,task_id,employee_id,date,started_at,ended_at,minutes,break_minutes,billable,billing_rate_cents,cost_rate_cents,note,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'approuve',?14,?14)",
        params![id_entry,assignment.project_id,assignment.task_id,assignment.employee_id,&s.timer.started_at[..10],s.timer.started_at,s.ended_at,s.minutes,s.break_minutes,s.timer.billable,s.timer.billing_rate_cents,s.timer.cost_rate_cents,s.timer.note,now])?;
    tx.execute("UPDATE timer_recoveries SET entry_id=?1,assignment_json=?2,resolved_at=?3 WHERE id=?4 AND entry_id IS NULL",params![id_entry,raw_assignment,now,id])?;
    tx.commit()?;
    Ok(json!({"entry_id":id_entry,"already_saved":false}))
}

#[cfg(test)]
mod tests;
