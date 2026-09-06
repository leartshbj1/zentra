//! Explicit, dated VAT corrections for adoption of a received-basis legacy dossier.
//! Originals remain immutable. Every historical payment retains its exact new parts.
use crate::{
    accounting::{ensure_accounting_date_open, post_entry, posted_invoice_account, EntryLine},
    customer_credit_math::{project_until, Part},
    customer_credit_settlements::{journal_snapshot, PENDING_VAT},
    database::{now_iso, query_all},
    error::{AppError, AppResult},
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use uuid::Uuid;

pub(crate) const DEFERRED: &str = "TVA à régulariser · contre-prestations reçues";
pub(crate) const RELEASE: &str = "Reclassement TVA à régulariser";
pub(crate) const DUE: &str = "TVA due sur encaissement";
const RESTORE: &str = "Rétablissement TVA historique de l’avoir";
fn invalid() -> AppError {
    AppError::Validation("La preuve de reprise TVA est absente ou incohérente. Rapprochez les écritures avant de poursuivre.".into())
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}
fn n(v: &Value, key: &str) -> i64 {
    v[key].as_i64().unwrap_or_default()
}

pub(crate) fn is_received(c: &Connection, original: &str) -> AppResult<bool> {
    Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM customer_credit_recovery_tax_models WHERE original_invoice_id=?)",[original],|r|r.get(0))?)
}
pub(crate) fn original_for(c: &Connection, doc: &str) -> AppResult<Option<String>> {
    Ok(c.query_row("SELECT m.original_invoice_id FROM customer_credit_recovery_tax_models m JOIN invoices i ON i.id=? WHERE m.original_invoice_id=CASE i.type WHEN 'avoir' THEN i.original_invoice_id ELSE i.id END",[doc],|r|r.get(0)).optional()?)
}
pub(crate) fn released(c: &Connection, original: &str, through: &str) -> AppResult<i64> {
    Ok(c.query_row("SELECT COALESCE(SUM(debit_cents-credit_cents),0) FROM customer_cash_vat_lines WHERE invoice_id=? AND entry_date<=? AND memo=?",params![original,through,RELEASE],|r|r.get(0))?)
}

pub(crate) fn source(c: &Connection, kind: &str, id: &str) -> AppResult<Value> {
    let (sql, table) = if kind == "credit" {
        ("SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=? ORDER BY id","invoices")
    } else {
        ("SELECT id FROM journal_entries WHERE source_type IN ('payment','vat_cash_reclassification') AND source_id=? ORDER BY id","payments")
    };
    let row = query_all(c, &format!("SELECT * FROM {table} WHERE id=?"), [id])?
        .into_iter()
        .next()
        .ok_or_else(invalid)?;
    // Document payment status is derived during adoption; retain only immutable issue fields.
    let row = if kind == "credit" {
        json!({"id":row["id"],"number":row["number"],"issue_date":row["issue_date"],"total_cents":row["total_cents"],"vat_cents":row["vat_cents"],"currency":row["currency"],"client_id":row["client_id"],"project_id":row["project_id"],"original_invoice_id":row["original_invoice_id"]})
    } else {
        row
    };
    let mut journals = Vec::new();
    for j in query_all(c, sql, [id])? {
        let jid = s(&j, "id");
        let snapshot = journal_snapshot(c, jid)?;
        if snapshot["entry"]["status"] != "posted"
            || !snapshot["entry"]["reversal_of"].is_null()
            || c.query_row(
                "SELECT EXISTS(SELECT 1 FROM journal_entries WHERE reversal_of=?)",
                [jid],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Err(invalid());
        }
        journals.push(snapshot);
    }
    Ok(json!({"row":row,"journals":journals}))
}

fn line(doc: &Value, account: &str, amount: i64, memo: &str) -> EntryLine {
    EntryLine {
        account_id: account.into(),
        debit_cents: amount.max(0),
        credit_cents: (-amount).max(0),
        currency: s(doc, "currency").into(),
        memo: Some(memo.into()),
        project_id: doc["project_id"].as_str().map(Into::into),
        client_id: doc["client_id"].as_str().map(Into::into),
        employee_id: None,
    }
}

/// Reconstruct the only permitted correction from immutable original postings.
fn correction(
    c: &Connection,
    original: &str,
    kind: &str,
    src: &Value,
    expected: i64,
) -> AppResult<(Vec<EntryLine>, i64)> {
    let doc = query_all(c, "SELECT * FROM invoices WHERE id=?", [original])?
        .into_iter()
        .next()
        .ok_or_else(invalid)?;
    let deferred: String=c.query_row("SELECT l.account_id FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id WHERE j.source_type='invoice' AND j.source_id=? AND j.source_event='issue' AND l.memo=?",params![original,DEFERRED],|r|r.get(0))?;
    let journals = src["journals"].as_array().ok_or_else(invalid)?;
    let mut lines = Vec::new();
    if kind == "credit" {
        if journals.len() != 1 {
            return Err(invalid());
        }
        let credit = &src["row"];
        let vat = -n(credit, "vat_cents");
        if expected != vat {
            return Err(invalid());
        }
        let mut total = 0;
        let mut due = 0;
        for old in journals[0]["lines"].as_array().ok_or_else(invalid)? {
            if matches!(
                s(old, "memo"),
                "Extourne TVA à régulariser" | "Extourne TVA due encaissée"
            ) {
                let amount = n(old, "debit_cents");
                if amount <= 0 || n(old, "credit_cents") != 0 {
                    return Err(invalid());
                }
                if (s(old, "memo") == "Extourne TVA à régulariser"
                    && s(old, "account_id") != deferred)
                    || (s(old, "memo") == "Extourne TVA due encaissée"
                        && s(old, "account_id") == deferred)
                {
                    return Err(invalid());
                }
                total += amount;
                if s(old, "memo") == "Extourne TVA due encaissée" {
                    due += amount;
                }
                lines.push(line(credit, s(old, "account_id"), -amount, RESTORE));
            }
        }
        if total != vat {
            return Err(invalid());
        }
        if vat != 0 {
            lines.push(line(credit, &deferred, vat, PENDING_VAT));
        }
        Ok((lines, due))
    } else {
        let payment = &src["row"];
        let mut bank_count = 0;
        let mut vat_count = 0;
        let mut old_vat = 0;
        let mut due_account = None;
        for j in journals {
            let e = &j["entry"];
            let jl = j["lines"].as_array().ok_or_else(invalid)?;
            if e["entry_date"] != payment["date"]
                || s(e, "source_event") != format!("invoice:{original}")
            {
                return Err(invalid());
            }
            let exact = |memo: &str, debit: i64, credit: i64| {
                jl.iter().find(|l| {
                    s(l, "memo") == memo
                        && n(l, "debit_cents") == debit
                        && n(l, "credit_cents") == credit
                        && l["currency"] == doc["currency"]
                })
            };
            if e["source_type"] == "payment" {
                bank_count += 1;
                let ar = exact("Règlement créance", 0, n(payment, "amount_cents"))
                    .ok_or_else(invalid)?;
                let bank =
                    exact("Encaissement", n(payment, "amount_cents"), 0).ok_or_else(invalid)?;
                let original_ar: String=c.query_row("SELECT l.account_id FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id WHERE j.source_type='invoice' AND j.source_id=? AND j.source_event='issue' AND l.memo='Créance client'",[original],|r|r.get(0))?;
                if jl.len() != 2
                    || s(ar, "account_id") != original_ar
                    || bank["account_id"] == ar["account_id"]
                    || !c.query_row(
                        "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=? AND account_type='asset')",
                        [s(bank, "account_id")],
                        |r| r.get::<_, bool>(0),
                    )?
                {
                    return Err(invalid());
                }
            } else {
                vat_count += 1;
                let release = jl
                    .iter()
                    .find(|l| s(l, "memo") == RELEASE)
                    .ok_or_else(invalid)?;
                old_vat = n(release, "debit_cents");
                let due = exact(DUE, 0, old_vat).ok_or_else(invalid)?;
                if jl.len() != 2
                    || old_vat <= 0
                    || n(release, "credit_cents") != 0
                    || s(release, "account_id") != deferred
                    || s(due, "account_id") == deferred
                    || release["currency"] != doc["currency"]
                    || !c.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=? AND account_type='liability')",[s(due,"account_id")],|r|r.get::<_,bool>(0))?
                {
                    return Err(invalid());
                }
                due_account = Some(s(due, "account_id").to_owned());
            }
        }
        if bank_count != 1 || vat_count > 1 {
            return Err(invalid());
        }
        let delta = expected - old_vat;
        if delta != 0 {
            let due = match due_account {
                Some(account) => account,
                None => src["fallback_due_account"]
                    .as_str()
                    .ok_or_else(invalid)?
                    .to_owned(),
            };
            if due == deferred {
                return Err(invalid());
            }
            lines.push(line(&doc, &deferred, delta, RELEASE));
            lines.push(line(&doc, &due, -delta, DUE));
        }
        Ok((lines, delta))
    }
}

fn save(
    tx: &Transaction<'_>,
    recovery: &str,
    original: &str,
    kind: &str,
    id: &str,
    parts: &[Part],
    expected: i64,
) -> AppResult<()> {
    let mut src = source(tx, kind, id)?;
    if kind == "payment" {
        src["fallback_due_account"] = json!(tx.query_row(
            "SELECT vat_payable_account_id FROM accounting_settings WHERE id=1",
            [],
            |r| r.get::<_, Option<String>>(0)
        )?);
    }
    let date = s(
        &src["row"],
        if kind == "credit" {
            "issue_date"
        } else {
            "date"
        },
    );
    ensure_accounting_date_open(tx, date)?;
    let (lines, due) = correction(tx, original, kind, &src, expected)?;
    let proof_id = Uuid::new_v4().to_string();
    let journal = if lines.is_empty() {
        None
    } else {
        Some(post_entry(
            tx,
            date,
            "Reprise documentée de la TVA des avoirs",
            "customer_credit_recovery",
            &proof_id,
            kind,
            lines,
        )?)
    };
    let jid = journal.as_ref().and_then(|j| j["id"].as_str());
    let snap = jid
        .map(|j| journal_snapshot(tx, j))
        .transpose()?
        .unwrap_or(Value::Null);
    tx.execute("INSERT INTO customer_credit_recovery_postings(id,recovery_id,original_invoice_id,source_type,source_id,date,source_json,parts_json,expected_vat_cents,due_change_cents,journal_entry_id,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",params![proof_id,recovery,original,kind,id,date,serde_json::to_string(&src)?,serde_json::to_string(parts)?,expected,due,jid,serde_json::to_string(&snap)?,now_iso()])?;
    Ok(())
}
pub(crate) fn begin(
    tx: &Transaction<'_>,
    recovery: &str,
    original: &str,
    credits: &[Value],
) -> AppResult<()> {
    tx.execute(
        "INSERT INTO customer_credit_recovery_tax_models VALUES(?,?,'received_v1',?)",
        params![original, recovery, now_iso()],
    )?;
    for credit in credits {
        save(
            tx,
            recovery,
            original,
            "credit",
            s(credit, "id"),
            &[],
            -n(credit, "vat_cents"),
        )?;
    }
    Ok(())
}
pub(crate) fn payments_through(
    tx: &Transaction<'_>,
    recovery: &str,
    original: &str,
    through: &str,
) -> AppResult<()> {
    for p in query_all(tx,"SELECT id,date FROM payments WHERE invoice_id=?1 AND date<=?2 AND NOT EXISTS(SELECT 1 FROM customer_credit_recovery_postings r WHERE r.source_type='payment' AND r.source_id=payments.id) ORDER BY date,created_at,id",params![original,through])? {
        let id=s(&p,"id");let projection=project_until(tx,original,s(&p,"date"),Some(id))?;
        let parts=projection.parts.get(id).ok_or_else(invalid)?;
        save(tx,recovery,original,"payment",id,parts,parts.iter().map(|p|p.vat_cents).sum())?;
    }
    Ok(())
}

pub(crate) fn pending_account(tx: &Transaction<'_>, credit: &str) -> AppResult<Option<String>> {
    if let Some(account) = posted_invoice_account(tx, credit, PENDING_VAT, "liability")? {
        return Ok(Some(account));
    }
    Ok(tx.query_row("SELECT l.account_id FROM customer_credit_recovery_postings r JOIN journal_lines l ON l.journal_entry_id=r.journal_entry_id WHERE r.source_type='credit' AND r.source_id=? AND l.memo=?",params![credit,PENDING_VAT],|r|r.get(0)).optional()?)
}

pub(crate) fn proof_valid(c: &Connection, original: &str) -> AppResult<bool> {
    let result = validate_proof(c, original);
    match result {
        Ok(()) => Ok(true),
        Err(
            AppError::Validation(_)
            | AppError::Json(_)
            | AppError::Database(rusqlite::Error::QueryReturnedNoRows),
        ) => Ok(false),
        Err(e) => Err(e),
    }
}
fn validate_proof(c: &Connection, original: &str) -> AppResult<()> {
    if !is_received(c, original)? {
        return Ok(());
    }
    let recovery=query_all(c,"SELECT r.* FROM customer_credit_recovery_tax_models m JOIN customer_credit_recoveries r ON r.id=m.recovery_id WHERE m.original_invoice_id=?",[original])?.into_iter().next().ok_or_else(invalid)?;
    let request: Value = serde_json::from_str(s(&recovery, "request_json"))?;
    if request["confirm_vat_reconciliation"] != true {
        return Err(invalid());
    }
    let proofs=query_all(c,"SELECT * FROM customer_credit_recovery_postings WHERE original_invoice_id=? ORDER BY source_type,source_id",[original])?;
    let history: Value = serde_json::from_str(s(&recovery, "source_json"))?;
    for journal in history["journals"].as_array().ok_or_else(invalid)? {
        let jid = s(&journal["entry"], "id");
        if journal_snapshot(c, jid)? != *journal
            || c.query_row(
                "SELECT EXISTS(SELECT 1 FROM journal_entries WHERE reversal_of=?)",
                [jid],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Err(invalid());
        }
    }
    let expected_count = request["credits"].as_array().ok_or_else(invalid)?.len()
        + history["payments"].as_array().ok_or_else(invalid)?.len();
    if expected_count != proofs.len() {
        return Err(invalid());
    }
    for proof in &proofs {
        let kind = s(proof, "source_type");
        let id = s(proof, "source_id");
        let saved_source: Value = serde_json::from_str(s(proof, "source_json"))?;
        let mut src = source(c, kind, id)?;
        if kind == "payment" {
            src["fallback_due_account"] = saved_source["fallback_due_account"].clone();
        }
        if saved_source != src || proof["recovery_id"] != recovery["id"] {
            return Err(invalid());
        }
        let permitted = if kind == "payment" {
            history["payments"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .any(|p| p["id"] == id)
        } else {
            request["credits"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .any(|p| p["credit_note_id"] == id)
        };
        if !permitted {
            return Err(invalid());
        }
        let parts: Vec<Part> = serde_json::from_str(s(proof, "parts_json"))?;
        if kind == "payment" {
            let projection = project_until(c, original, s(proof, "date"), Some(id))?;
            if projection.parts.get(id) != Some(&parts)
                || parts.iter().map(|p| p.vat_cents).sum::<i64>() != n(proof, "expected_vat_cents")
            {
                return Err(invalid());
            }
        } else if !parts.is_empty() {
            return Err(invalid());
        }
        let (lines, due) = correction(c, original, kind, &src, n(proof, "expected_vat_cents"))?;
        for line in &lines {
            if !c.query_row(
                "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=? AND account_type='liability')",
                [&line.account_id],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(invalid());
            }
        }
        if due != n(proof, "due_change_cents") {
            return Err(invalid());
        }
        let Some(jid) = proof["journal_entry_id"].as_str() else {
            if !lines.is_empty() || s(proof, "snapshot_json") != "null" {
                return Err(invalid());
            }
            continue;
        };
        let live = journal_snapshot(c, jid)?;
        let entry = &live["entry"];
        if serde_json::from_str::<Value>(s(proof, "snapshot_json"))? != live
            || entry["source_type"] != "customer_credit_recovery"
            || entry["source_id"] != proof["id"]
            || entry["source_event"] != kind
            || entry["entry_date"] != proof["date"]
            || entry["status"] != "posted"
            || !entry["reversal_of"].is_null()
            || c.query_row(
                "SELECT EXISTS(SELECT 1 FROM journal_entries WHERE reversal_of=?)",
                [jid],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Err(invalid());
        }
        let actual = live["lines"].as_array().ok_or_else(invalid)?;
        if lines.len() != actual.len()
            || !lines.iter().zip(actual).all(|(a, b)| {
                a.account_id == s(b, "account_id")
                    && a.debit_cents == n(b, "debit_cents")
                    && a.credit_cents == n(b, "credit_cents")
                    && a.currency == s(b, "currency")
                    && a.memo.as_deref() == b["memo"].as_str()
            })
        {
            return Err(invalid());
        }
    }
    let orphan:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM journal_entries j WHERE j.source_type='customer_credit_recovery' AND NOT EXISTS(SELECT 1 FROM customer_credit_recovery_postings p WHERE p.journal_entry_id=j.id AND p.id=j.source_id))",[],|r|r.get(0))?;
    if orphan {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn ensure_proof(c: &Connection, doc: &str) -> AppResult<()> {
    if let Some(original) = original_for(c, doc)? {
        if !proof_valid(c, &original)? {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(crate) fn accounting_issues(c: &Connection, from: &str, to: &str) -> AppResult<Vec<Value>> {
    let mut issues = Vec::new();
    for mut row in query_all(c,"SELECT r.original_invoice_id AS credit_note_id,i.number AS credit_note_number,i.issue_date AS date,i.number AS reference,EXISTS(SELECT 1 FROM accounting_periods a WHERE a.status='closed' AND i.issue_date<=a.date_to) AS closed_period FROM customer_credit_recovery_tax_models r JOIN invoices i ON i.id=r.original_invoice_id WHERE i.issue_date<=?",[to])? {
        if !proof_valid(c,s(&row,"credit_note_id"))? {row["kind"]=json!("invalid_posting");row["reason"]=json!("La reprise historique de la TVA de ce dossier ne concorde plus avec ses preuves. Vérifiez les corrections conservées.");issues.push(row);}
    }
    for mut row in query_all(c,"SELECT j.id AS journal_entry_id,1 AS journal_available,j.number AS journal_number,j.entry_date AS date,j.description AS reference FROM journal_entries j WHERE j.source_type='customer_credit_recovery' AND j.entry_date BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM customer_credit_recovery_postings p WHERE p.journal_entry_id=j.id AND p.id=j.source_id)",params![from,to])? {
        row["kind"]=json!("orphan_journal");row["reason"]=json!("Cette correction TVA n’est reliée à aucune preuve de reprise historique.");issues.push(row);
    }
    Ok(issues)
}
