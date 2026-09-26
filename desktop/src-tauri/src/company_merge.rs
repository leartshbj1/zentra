//! Three-way integration of independent company changes, on disposable copies.
//! Neither branch wins a concurrent edit. Financial documents are compared as
//! aggregates, so merging different payment ids cannot silently double a receipt.
use crate::{
    database::LocalStore,
    error::{AppError, AppResult},
};
use rusqlite::{params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};

type Row = Vec<Value>;
#[derive(Clone)]
struct Table {
    columns: Vec<String>,
    pk: Vec<usize>,
    rows: BTreeMap<String, Row>,
}
type Data = BTreeMap<String, Table>;
pub(crate) fn payment_request(db: &Connection, original: &str) -> AppResult<(String, bool)> {
    let mut id = original.to_owned();
    let mut seen = BTreeSet::new();
    loop {
        if !seen.insert(id.clone()) || seen.len() > 32 {
            return Err(invalid("L’historique de cet encaissement doit être vérifié. Aucun paiement supplémentaire n’a été créé."));
        }
        let mut q=db.prepare("SELECT DISTINCT json_extract(payload_json,'$.confirmed_duplicate_receipt.remoteId') FROM audit_log WHERE action='company.merge_branch' AND json_valid(payload_json)=1 AND json_extract(payload_json,'$.confirmed_duplicate_receipt.localId')=?")?;
        let aliases = q
            .query_map([&id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        match aliases.as_slice() {
            []=>return Ok((id,seen.len()>1)),
            [next] if uuid::Uuid::parse_str(next).is_ok()=>id=next.clone(),
            _=>return Err(invalid("Les références de cet encaissement doivent être vérifiées. Aucun paiement supplémentaire n’a été créé.")),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DuplicateReceipt {
    pub local_id: String,
    pub remote_id: String,
    pub invoice_id: String,
    pub invoice_number: String,
    pub amount_cents: i64,
    pub currency: String,
    pub date: String,
    pub fingerprint: String,
}

fn candidate(base: &Data, local: &Data, remote: &Data) -> Option<DuplicateReceipt> {
    let a = local.get("payments")?;
    let b = remote.get("payments")?;
    let reference = base.get("payments")?;
    let mut candidates = Vec::new();
    for (local_key, l) in &a.rows {
        if reference.rows.contains_key(local_key) || b.rows.contains_key(local_key) {
            continue;
        }
        let matched = b
            .rows
            .iter()
            .filter(|(k, r)| {
                !reference.rows.contains_key(*k)
                    && !a.rows.contains_key(*k)
                    && a.columns.iter().enumerate().all(|(i, c)| {
                        matches!(c.as_str(), "id" | "created_at" | "updated_at") || l[i] == r[i]
                    })
            })
            .collect::<Vec<_>>();
        if matched.len() != 1 {
            continue;
        }
        let r = matched[0].1;
        let invoice_id = text(l, a, "invoice_id")?;
        let invoices = remote.get("invoices")?;
        let invoice = invoices
            .rows
            .values()
            .find(|r| text(r, invoices, "id").as_deref() == Some(&invoice_id))?;
        let amount = match &l[a.columns.iter().position(|c| c == "amount_cents")?] {
            Value::Integer(n) => *n,
            _ => return None,
        };
        let local_id = text(l, a, "id")?;
        // Bank matches or downstream allocations need their own review. Never
        // leave an indirect reference pointing to the discarded duplicate id.
        if local
            .iter()
            .filter(|(n, _)| !matches!(n.as_str(), "payments" | "journal_entries" | "audit_log"))
            .any(|(_, t)| {
                t.rows
                    .values()
                    .flatten()
                    .any(|v| matches!(v,Value::Text(s) if s.contains(&local_id)))
            })
        {
            continue;
        }
        candidates.push(DuplicateReceipt {
            local_id,
            remote_id: text(r, b, "id")?,
            invoice_number: text(invoice, invoices, "number").unwrap_or_default(),
            invoice_id,
            amount_cents: amount,
            currency: text(invoice, invoices, "currency")?,
            date: text(l, a, "date")?,
            fingerprint: format!("{:x}", Sha256::digest(format!("{l:?}\n{r:?}").as_bytes())),
        });
    }
    if candidates.len() == 1 {
        candidates.pop()
    } else {
        None
    }
}

fn normalize_duplicate(
    base: &Data,
    local: &mut Data,
    remote: &Data,
    choice: &DuplicateReceipt,
) -> AppResult<()> {
    if candidate(base, local, remote).as_ref() != Some(choice) {
        return Err(invalid("Cet encaissement a changé depuis la vérification. Les deux saisies sont conservées. Vérifiez à nouveau le montant."));
    }
    let journals = local
        .get("journal_entries")
        .ok_or_else(|| invalid("Écritures du paiement absentes."))?;
    let remote_journals = &remote["journal_entries"];
    let l = journals
        .rows
        .iter()
        .filter(|(_, r)| {
            text(r, journals, "source_type").as_deref() == Some("payment")
                && text(r, journals, "source_id").as_deref() == Some(&choice.local_id)
        })
        .collect::<Vec<_>>();
    let r = remote_journals
        .rows
        .iter()
        .filter(|(_, r)| {
            text(r, remote_journals, "source_type").as_deref() == Some("payment")
                && text(r, remote_journals, "source_id").as_deref() == Some(&choice.remote_id)
        })
        .collect::<Vec<_>>();
    if l.len() != 1 || r.len() != 1 {
        return Err(invalid("Les écritures de ces paiements nécessitent une vérification comptable. Les deux copies sont conservées."));
    }
    let (lk, lr) = (l[0].0.clone(), l[0].1.clone());
    let (rk, rr) = (r[0].0.clone(), r[0].1.clone());
    if journals.columns.iter().enumerate().any(|(i, c)| {
        !matches!(c.as_str(), "id" | "number" | "source_id" | "created_at") && lr[i] != rr[i]
    }) {
        return Err(invalid("Ces deux encaissements ont des écritures différentes. Ils sont conservés pour vérification."));
    }
    let lid = text(&lr, journals, "id").unwrap();
    let rid = text(&rr, remote_journals, "id").unwrap();
    let lines = &local["journal_lines"];
    let remote_lines = &remote["journal_lines"];
    let selected = |t: &Table, id: &str| {
        t.rows
            .iter()
            .filter(|(_, r)| text(r, t, "journal_entry_id").as_deref() == Some(id))
            .map(|(k, r)| (k.clone(), r.clone()))
            .collect::<Vec<_>>()
    };
    let ll = selected(lines, &lid);
    let rl = selected(remote_lines, &rid);
    let canonical = |rows: &Vec<(String, Row)>| {
        let mut result = rows
            .iter()
            .map(|(_, r)| {
                format!(
                    "{:?}",
                    r.iter()
                        .zip(&lines.columns)
                        .filter(|(_, c)| !matches!(
                            c.as_str(),
                            "id" | "journal_entry_id" | "created_at"
                        ))
                        .map(|(v, _)| v)
                        .collect::<Vec<_>>()
                )
            })
            .collect::<Vec<_>>();
        result.sort();
        result
    };
    if canonical(&ll) != canonical(&rl) {
        return Err(invalid(
            "Les montants comptabilisés diffèrent. Les deux saisies sont conservées.",
        ));
    }
    let payments = local.get_mut("payments").unwrap();
    payments
        .rows
        .retain(|_, r| r[0] != Value::Text(choice.local_id.clone()));
    let remote_payment = remote["payments"]
        .rows
        .values()
        .find(|r| text(r, &remote["payments"], "id").as_deref() == Some(&choice.remote_id))
        .unwrap()
        .clone();
    payments
        .rows
        .insert(key(&remote_payment, &payments.pk), remote_payment);
    let entries = local.get_mut("journal_entries").unwrap();
    entries.rows.remove(&lk);
    entries.rows.insert(rk, rr);
    let lines = local.get_mut("journal_lines").unwrap();
    for (k, _) in ll {
        lines.rows.remove(&k);
    }
    for (k, r) in rl {
        lines.rows.insert(k, r);
    }
    Ok(())
}

pub(crate) fn duplicate_preview(
    store: &LocalStore,
    base: &Path,
    local: &Path,
    remote: &Path,
) -> AppResult<Option<DuplicateReceipt>> {
    let temp = tempfile::tempdir_in(&store.data_dir)?;
    let mut data = Vec::new();
    for (index, path) in [base, local, remote].iter().enumerate() {
        let dir = temp.path().join(index.to_string());
        store.extract_company_copy(path, &dir)?;
        data.push(read(&Connection::open(dir.join("database.sqlite3"))?)?);
    }
    schema(&data[0], &data[1])?;
    schema(&data[0], &data[2])?;
    let Some(choice) = candidate(&data[0], &data[1], &data[2]) else {
        return Ok(None);
    };
    let mut resolved = data[1].clone();
    if normalize_duplicate(&data[0], &mut resolved, &data[2], &choice).is_err()
        || merge_rows(&data[0], &resolved, &data[2]).is_err()
    {
        return Ok(None);
    }
    Ok(Some(choice))
}
fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn key(row: &Row, pk: &[usize]) -> String {
    format!("{:?}", pk.iter().map(|i| &row[*i]).collect::<Vec<_>>())
}
fn text(row: &Row, table: &Table, column: &str) -> Option<String> {
    table
        .columns
        .iter()
        .position(|c| c == column)
        .and_then(|i| match &row[i] {
            Value::Text(s) => Some(s.clone()),
            _ => None,
        })
}
fn read(db: &Connection) -> AppResult<Data> {
    let mut result = Data::new();
    let mut q = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?;
    let names = q
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for name in names {
        if crate::company_collaboration::local_table(&name) {
            continue;
        }
        let mut info = db.prepare(&format!("PRAGMA table_info({})", quoted(&name)))?;
        let columns = info
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, usize>(5)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut pk = columns
            .iter()
            .enumerate()
            .filter(|(_, c)| c.1 > 0)
            .map(|(i, c)| (c.1, i))
            .collect::<Vec<_>>();
        pk.sort();
        if pk.is_empty() {
            return Err(invalid(
                "Une table nécessite une mise à jour avant de réunir les changements.",
            ));
        }
        let mut table = Table {
            columns: columns.into_iter().map(|c| c.0).collect(),
            pk: pk.into_iter().map(|p| p.1).collect(),
            rows: BTreeMap::new(),
        };
        let filter = if name == "reminder_operation_requests" {
            format!(
                " WHERE NOT COALESCE(({}),0)",
                crate::company_sync_digest::noop_scan_sql("")
            )
        } else {
            String::new()
        };
        let mut statement = db.prepare(&format!(
            "SELECT {} FROM {}{filter}",
            table
                .columns
                .iter()
                .map(|c| quoted(c))
                .collect::<Vec<_>>()
                .join(","),
            quoted(&name)
        ))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let values = (0..table.columns.len())
                .map(|i| row.get(i))
                .collect::<Result<Row, _>>()?;
            table.rows.insert(key(&values, &table.pk), values);
        }
        result.insert(name, table);
    }
    Ok(result)
}
fn same(table: &str, columns: &[String], a: Option<&Row>, b: Option<&Row>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => columns.iter().enumerate().all(|(i, c)| {
            crate::company_sync_digest::ignored_column(table, c)
                || match (&a[i], &b[i]) {
                    (Value::Text(a), Value::Text(b)) => {
                        crate::company_sync_digest::shared_text(table, c, a)
                            == crate::company_sync_digest::shared_text(table, c, b)
                    }
                    (a, b) => a == b,
                }
        }),
        _ => false,
    }
}
fn schema(base: &Data, branch: &Data) -> AppResult<()> {
    if base.len() != branch.len()
        || base.iter().any(|(name, t)| {
            branch
                .get(name)
                .is_none_or(|b| t.columns != b.columns || t.pk != b.pk)
        })
    {
        return Err(invalid(
            "Mettez Zentra à jour sur les appareils de l’entreprise pour réunir leurs changements.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Diagnostic of explicitly supplied exported copies; never reads or writes a live profile"]
    fn preview_exported_company_copies_without_touching_originals() {
        let paths = ["ZENTRA_QA_BASE", "ZENTRA_QA_LOCAL", "ZENTRA_QA_REMOTE"].map(|k| {
            std::path::PathBuf::from(
                std::env::var(k).expect("Explicit diagnostic archive paths required"),
            )
        });
        let output = std::path::PathBuf::from(
            std::env::var("ZENTRA_QA_OUTPUT").expect("Explicit NEW preview directory required"),
        );
        assert!(
            !output.exists(),
            "Refusing to overwrite a previous diagnostic"
        );
        let before = paths
            .iter()
            .map(|p| crate::cloud_backup::file_manifest(p).unwrap())
            .collect::<Vec<_>>();
        let store = LocalStore::initialize(output.join("disposable-profile")).unwrap();
        let choice = duplicate_preview(&store, &paths[0], &paths[1], &paths[2])
            .unwrap()
            .expect("A uniquely matching receipt must be reviewable");
        let merged = output.join("PREVIEW-ONLY-DO-NOT-RESTORE.zentra");
        merge_confirmed(
            &store,
            &paths[0],
            &paths[1],
            &paths[2],
            &merged,
            Some(&choice),
        )
        .unwrap();
        let extracted = output.join("preview-data");
        store.extract_company_copy(&merged, &extracted).unwrap();
        let db = Connection::open(extracted.join("database.sqlite3")).unwrap();
        let due:i64=db.query_row("SELECT SUM(total_cents-paid_cents) FROM invoices WHERE number IS NOT NULL AND status<>'annulee'",[],|r|r.get(0)).unwrap();
        let payment_count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM payments WHERE invoice_id=?",
                [&choice.invoice_id],
                |r| r.get(0),
            )
            .unwrap();
        let report = json!({"previewOnly":true,"liveDataChanged":false,"requiresUserConfirmationBeforeLiveUse":true,"duplicateReceipt":choice,"resultDueCents":due,"paymentsForReviewedInvoice":payment_count,"audit":crate::audit::verify_audit_chain(&db).unwrap()});
        fs::write(
            output.join("preview-report.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        assert_eq!(
            paths
                .iter()
                .map(|p| crate::cloud_backup::file_manifest(p).unwrap())
                .collect::<Vec<_>>(),
            before
        );
        println!("Preview only: due cents {due}, payments for reviewed invoice {payment_count}; originals unchanged.");
    }
    fn data() -> Data {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE clients(id TEXT PRIMARY KEY,name TEXT,value BLOB,updated_at TEXT); INSERT INTO clients VALUES('a','Initial',X'0001','base'),('b','Second',X'0203','base');").unwrap();
        read(&db).unwrap()
    }
    fn row<'a>(data: &'a mut Data, id: &str) -> &'a mut Row {
        data.get_mut("clients")
            .unwrap()
            .rows
            .values_mut()
            .find(|r| r[0] == Value::Text(id.into()))
            .unwrap()
    }
    #[test]
    fn disjoint_records_keep_types_and_deletions_but_concurrent_record_edits_are_rejected() {
        let base = data();
        let mut local = base.clone();
        let mut remote = base.clone();
        row(&mut local, "a")[1] = Value::Text("Local".into());
        row(&mut remote, "b")[2] = Value::Blob(vec![9, 0, 255]);
        let mut merged = merge_rows(&base, &local, &remote).unwrap();
        assert_eq!(row(&mut merged, "a")[1], Value::Text("Local".into()));
        assert_eq!(row(&mut merged, "b")[2], Value::Blob(vec![9, 0, 255]));
        assert!(same(
            "clients",
            &base["clients"].columns,
            Some(row(&mut local, "a")),
            Some(row(&mut merged, "a"))
        ));
        row(&mut remote, "a")[1] = Value::Text("Remote".into());
        assert!(merge_rows(&base, &local, &remote).is_err());
        local
            .get_mut("clients")
            .unwrap()
            .rows
            .retain(|_, r| r[0] != Value::Text("a".into()));
        assert!(
            merge_rows(&base, &local, &remote).is_err(),
            "a deletion cannot hide a concurrent edit"
        );
        let deleted = merge_rows(&base, &local, &base).unwrap();
        assert_eq!(deleted["clients"].rows.len(), 1);
    }
    #[test]
    fn competing_attachment_edits_leave_all_original_archives_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let a = LocalStore::initialize(dir.path().join("a")).unwrap();
        let b = LocalStore::initialize(dir.path().join("b")).unwrap();
        fs::write(a.attachments_dir.join("plan.txt"), b"base").unwrap();
        let base = dir.path().join("base.zentra");
        a.create_backup_at(&base, env!("CARGO_PKG_VERSION"))
            .unwrap();
        b.restore_company_snapshot(&base.to_string_lossy(), || Ok(()))
            .unwrap();
        fs::write(a.attachments_dir.join("plan.txt"), b"local").unwrap();
        fs::write(b.attachments_dir.join("plan.txt"), b"remote").unwrap();
        let local = dir.path().join("local.zentra");
        let remote = dir.path().join("remote.zentra");
        a.create_backup_at(&local, env!("CARGO_PKG_VERSION"))
            .unwrap();
        b.create_backup_at(&remote, env!("CARGO_PKG_VERSION"))
            .unwrap();
        let before = crate::company_sync_digest::local(&a).unwrap();
        let output = dir.path().join("merged.zentra");
        assert!(merge(&a, &base, &local, &remote, &output)
            .unwrap_err()
            .to_string()
            .contains("plan.txt"));
        assert!(!output.exists());
        assert_eq!(crate::company_sync_digest::local(&a).unwrap(), before);
        assert_eq!(
            fs::read(b.attachments_dir.join("plan.txt")).unwrap(),
            b"remote"
        );
    }
}
fn changes(base: &Data, branch: &Data) -> BTreeSet<(String, String)> {
    let mut result = BTreeSet::new();
    for (name, t) in base {
        if name == "audit_log" {
            continue;
        }
        let other = &branch[name];
        for k in t.rows.keys().chain(other.rows.keys()) {
            if !same(name, &t.columns, t.rows.get(k), other.rows.get(k)) {
                result.insert((name.clone(), k.clone()));
            }
        }
    }
    result
}
const ROOTS: &[(&str, &str)] = &[
    ("invoices", "invoice_id"),
    ("quotes", "quote_id"),
    ("supplier_invoices", "supplier_invoice_id"),
    ("supplier_credit_notes", "supplier_credit_note_id"),
    ("payslips", "payslip_id"),
    ("sales_orders", "sales_order_id"),
    ("delivery_notes", "delivery_note_id"),
    ("supplier_orders", "supplier_order_id"),
    ("supplier_receipts", "supplier_receipt_id"),
    ("expenses", "expense_id"),
    ("journal_entries", "journal_entry_id"),
];
// Follow document-owned rows, not clients or projects: two colleagues may
// legitimately create different invoices for the same client at the same time.
fn roots(data: &Data, table: &str, row: &Row) -> BTreeSet<(String, String)> {
    let mut result = BTreeSet::new();
    let t = &data[table];
    if table == "catalog_items" {
        if let Some(id) = text(row, t, "id") {
            result.insert(("catalog_items".into(), id));
        }
    }
    if matches!(table, "stock_movements" | "stock_reservation_events") {
        if let Some(id) = text(row, t, "catalog_item_id") {
            result.insert(("catalog_items".into(), id));
        }
    }
    if table.starts_with("customer_") {
        if let Some(id) = text(row, t, "credit_note_id") {
            result.insert(("invoices".into(), id));
        }
    }
    for (root, column) in ROOTS {
        if !data.contains_key(*root) {
            continue;
        }
        if table == *root {
            if let Some(id) = text(row, t, "id") {
                result.insert((root.to_string(), id));
            }
        }
        if let Some(id) = text(row, t, column) {
            result.insert((root.to_string(), id));
        }
    }
    if table == "journal_entries" {
        if text(row, t, "source_type").as_deref() == Some("fixed_asset") {
            if let Some(id) = text(row, t, "source_id") {
                result.insert(("fixed_asset".into(), id));
            }
        }
        if let (Some(kind), Some(id)) = (text(row, t, "source_type"), text(row, t, "source_id")) {
            let target = match kind.as_str() {
                "invoice" => Some("invoices"),
                "payment" => Some("payments"),
                "supplier_invoice" => Some("supplier_invoices"),
                "supplier_payment" => Some("supplier_payments"),
                "payslip" => Some("payslips"),
                "expense" => Some("expenses"),
                _ => None,
            };
            if let Some(target) = target.and_then(|n| data.get(n).map(|t| (n, t))) {
                for r in target
                    .1
                    .rows
                    .values()
                    .filter(|r| text(r, target.1, "id").as_deref() == Some(&id))
                {
                    result.extend(roots(data, target.0, r));
                }
            }
        }
    }
    if let Some(id) = text(row, t, "journal_entry_id") {
        if let Some(entries) = data.get("journal_entries") {
            for r in entries
                .rows
                .values()
                .filter(|r| text(r, entries, "id").as_deref() == Some(&id))
            {
                result.extend(roots(data, "journal_entries", r));
            }
        }
    }
    result
}
fn aggregate_changes(
    base: &Data,
    branch: &Data,
) -> BTreeMap<(String, String), BTreeSet<(String, String)>> {
    let mut result = BTreeMap::<_, BTreeSet<_>>::new();
    for (name, k) in changes(base, branch) {
        let mut owned = BTreeSet::new();
        if let Some(row) = base[&name].rows.get(&k) {
            owned.extend(roots(base, &name, row));
        }
        if let Some(row) = branch[&name].rows.get(&k) {
            owned.extend(roots(branch, &name, row));
        }
        for root in owned {
            result
                .entry(root)
                .or_default()
                .insert((name.clone(), k.clone()));
        }
    }
    result
}
fn check_documents(base: &Data, local: &Data, remote: &Data) -> AppResult<()> {
    let a = aggregate_changes(base, local);
    let b = aggregate_changes(base, remote);
    for (root, rows) in a {
        let Some(other) = b.get(&root) else { continue };
        if rows.iter().chain(other).all(|(t, k)| {
            same(
                t,
                &base[t].columns,
                local[t].rows.get(k),
                remote[t].rows.get(k),
            )
        }) {
            continue;
        }
        if root.0 == "fixed_asset" {
            return Err(invalid("Ce bien a été modifié sur deux appareils avant leur échange. Les deux versions sont conservées. Vérifiez ses amortissements avant de choisir la version à conserver pour éviter une double écriture."));
        }
        let kind = match root.0.as_str() {
            "invoices" => "La facture",
            "quotes" => "Le devis",
            _ => "Le document",
        };
        let number = remote
            .get(&root.0)
            .and_then(|table| {
                table
                    .rows
                    .values()
                    .find(|r| text(r, table, "id").as_deref() == Some(&root.1))
                    .and_then(|r| text(r, table, "number"))
            })
            .unwrap_or_default();
        return Err(invalid(format!("{kind} {number} a été modifié sur deux appareils avant leur échange. Les deux versions sont conservées. Vérifiez les encaissements de ce document pour éviter de compter un paiement deux fois.")));
    }
    Ok(())
}
fn counter(table: &str, columns: &[String], local: &Row, remote: &Row) -> Option<Row> {
    if !matches!(table, "number_sequences" | "accounting_sequences") {
        return None;
    }
    let mut row = remote.clone();
    for (i, c) in columns.iter().enumerate() {
        if local[i] == remote[i] || crate::company_sync_digest::ignored_column(table, c) {
            continue;
        }
        if c != "next_value" {
            return None;
        }
        let (Value::Integer(a), Value::Integer(b)) = (&local[i], &remote[i]) else {
            return None;
        };
        row[i] = Value::Integer(*a.max(b));
    }
    Some(row)
}
fn merge_rows(base: &Data, local: &Data, remote: &Data) -> AppResult<Data> {
    schema(base, local)?;
    schema(base, remote)?;
    let local_changes = changes(base, local);
    let remote_changes = changes(base, remote);
    let closes = |data: &Data, changed: &BTreeSet<(String, String)>| {
        changed.iter().any(|(table, k)| match table.as_str() {
            "accounting_periods" => data[table]
                .rows
                .get(k)
                .is_some_and(|r| text(r, &data[table], "status").as_deref() == Some("closed")),
            "closing_reviews" | "closing_package_exports" => true,
            _ => false,
        })
    };
    let financial = |changed: &BTreeSet<(String, String)>| {
        changed.iter().any(|(table, _)| {
            ROOTS.iter().any(|(root, _)| table == root)
                || table.contains("payment")
                || table.starts_with("stock_")
                || table.contains("credit")
                || table.starts_with("journal_")
        })
    };
    if (closes(local, &local_changes) && financial(&remote_changes))
        || (closes(remote, &remote_changes) && financial(&local_changes))
    {
        return Err(invalid("Une clôture comptable et des opérations financières ont été préparées sur deux appareils. Les copies sont conservées ; faites vérifier la clôture avant de réunir ces opérations."));
    }
    check_documents(base, local, remote)?;
    let mut result = remote.clone();
    for (name, k) in changes(base, local) {
        let t = &base[&name];
        let a = local[&name].rows.get(&k);
        let b = remote[&name].rows.get(&k);
        if same(&name, &t.columns, a, b) {
            continue;
        }
        let selected = if same(&name, &t.columns, t.rows.get(&k), b) {
            a.cloned()
        } else if let Some(row) = a.zip(b).and_then(|(a, b)| counter(&name, &t.columns, a, b)) {
            Some(row)
        } else {
            return Err(invalid(format!("Deux personnes ont modifié la même information ({name}). Les deux versions sont conservées ; vérifiez cette modification avant de les réunir.")));
        };
        if let Some(row) = selected {
            result.get_mut(&name).unwrap().rows.insert(k, row);
        } else {
            result.get_mut(&name).unwrap().rows.remove(&k);
        }
    }
    Ok(result)
}
fn audit_value(row: &Row, t: &Table) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    for (c, v) in t.columns.iter().zip(row) {
        object.insert(
            c.clone(),
            match v {
                Value::Text(s) => json!(s),
                Value::Null => serde_json::Value::Null,
                _ => json!(format!("{v:?}")),
            },
        );
    }
    object.into()
}
fn append_branch(
    tx: &rusqlite::Transaction<'_>,
    local_db: &Connection,
    base: &Data,
    local: &Data,
    remote: &Data,
    receipt_resolution: Option<&DuplicateReceipt>,
) -> AppResult<()> {
    let table = &local["audit_log"];
    // An existing audit identity can only be rebased, never have its event edited.
    for (id, row) in &table.rows {
        if let Some(other) = remote["audit_log"].rows.get(id) {
            if table.columns.iter().enumerate().any(|(i, c)| {
                !matches!(c.as_str(), "previous_hash" | "entry_hash") && row[i] != other[i]
            }) {
                return Err(invalid("Les historiques d’intégrité ne correspondent pas. Les copies originales sont conservées."));
            }
        }
    }
    if base["audit_log"]
        .rows
        .keys()
        .any(|id| !table.rows.contains_key(id) || !remote["audit_log"].rows.contains_key(id))
    {
        return Err(invalid(
            "Une partie de l’historique partagé est absente. Les copies sont conservées.",
        ));
    }
    let mut q = local_db.prepare("SELECT id FROM audit_log ORDER BY rowid")?;
    let ids = q
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let additions = ids
        .iter()
        .filter_map(|id| {
            let key = format!("{:?}", vec![&Value::Text(id.clone())]);
            if remote["audit_log"].rows.contains_key(&key) {
                None
            } else {
                table.rows.get(&key)
            }
        })
        .collect::<Vec<_>>();
    if additions.is_empty() {
        return Ok(());
    }
    // Preserve the complete original branch and its hashes IN the new chain
    // before rebasing event hashes. The remote canonical prefix is untouched.
    crate::audit::append_audit(
        tx,
        "company.merge_branch",
        "company",
        "shared",
        &json!({"format":1,"confirmed_duplicate_receipt":receipt_resolution,"original_entries":additions.iter().map(|r|audit_value(r,table)).collect::<Vec<_>>()}),
    )?;
    for row in additions {
        let mut value = audit_value(row, table);
        let previous: String = tx.query_row(
            "SELECT entry_hash FROM audit_log ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )?;
        value["previous_hash"] = json!(previous);
        let material = format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            previous,
            value["id"].as_str().unwrap(),
            value["occurred_at"].as_str().unwrap(),
            value["actor"].as_str().unwrap(),
            value["action"].as_str().unwrap(),
            value["entity_type"].as_str().unwrap(),
            value["entity_id"].as_str().unwrap(),
            value["payload_json"].as_str().unwrap()
        );
        value["entry_hash"] = json!(format!("{:x}", Sha256::digest(material.as_bytes())));
        let values = table
            .columns
            .iter()
            .map(|c| {
                value[c]
                    .as_str()
                    .map(|s| Value::Text(s.into()))
                    .unwrap_or(Value::Null)
            })
            .collect::<Row>();
        tx.execute(
            &format!(
                "INSERT INTO audit_log ({}) VALUES ({})",
                table
                    .columns
                    .iter()
                    .map(|c| quoted(c))
                    .collect::<Vec<_>>()
                    .join(","),
                vec!["?"; values.len()].join(",")
            ),
            params_from_iter(values),
        )?;
    }
    Ok(())
}
fn install_rows(
    db: &mut Connection,
    local_db: &Connection,
    base: &Data,
    local: &Data,
    remote: &Data,
    merged: &Data,
    receipt_resolution: Option<&DuplicateReceipt>,
) -> AppResult<()> {
    // Trigger side effects have already happened in each validated branch.
    // Suppress them ONLY in the disposable integration copy, restore their exact
    // definitions in the same transaction, then validate before any live swap.
    db.pragma_update(None, "foreign_keys", "OFF")?;
    let triggers = {
        let mut q = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let tx = db.transaction()?;
    for (name, _) in &triggers {
        tx.execute_batch(&format!("DROP TRIGGER {}", quoted(name)))?;
    }
    for (name, t) in merged {
        if name == "audit_log" {
            continue;
        }
        let old = &remote[name];
        let where_pk =
            t.pk.iter()
                .map(|i| format!("{} IS ?", quoted(&t.columns[*i])))
                .collect::<Vec<_>>()
                .join(" AND ");
        for (k, row) in &old.rows {
            if t.rows.get(k) == Some(row) {
                continue;
            }
            tx.execute(
                &format!("DELETE FROM {} WHERE {where_pk}", quoted(name)),
                params_from_iter(t.pk.iter().map(|i| &row[*i])),
            )?;
        }
        for (k, row) in &t.rows {
            if old.rows.get(k) == Some(row) {
                continue;
            }
            tx.execute(
                &format!(
                    "INSERT INTO {} ({}) VALUES ({})",
                    quoted(name),
                    t.columns
                        .iter()
                        .map(|c| quoted(c))
                        .collect::<Vec<_>>()
                        .join(","),
                    vec!["?"; row.len()].join(",")
                ),
                params_from_iter(row),
            )?;
        }
    }
    append_branch(&tx, local_db, base, local, remote, receipt_resolution)?;
    for (_, sql) in triggers {
        tx.execute_batch(&sql)?;
    }
    tx.commit()?;
    db.pragma_update(None, "foreign_keys", "ON")?;
    let invalid_payments:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM invoices i WHERE i.paid_cents<>COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id=i.id),0))",[],|r|r.get(0))?;
    if invalid_payments {
        return Err(invalid("Les encaissements ne correspondent pas au solde d’une facture. Les copies originales sont conservées."));
    }
    Ok(())
}
fn files(path: &Path) -> AppResult<BTreeMap<String, String>> {
    let mut result = BTreeMap::new();
    for entry in walkdir::WalkDir::new(path).follow_links(false) {
        let entry = entry.map_err(|_| invalid("Un document ne peut pas être lu."))?;
        if entry.file_type().is_symlink() {
            return Err(invalid("Un document contient un lien non pris en charge."));
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let mut hash = Sha256::new();
        let mut f = File::open(entry.path())?;
        let mut buffer = [0; 65536];
        loop {
            let n = f.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        let relative = entry
            .path()
            .strip_prefix(path)
            .map_err(|_| invalid("Chemin de document invalide."))?
            .to_string_lossy()
            .replace('\\', "/");
        result.insert(relative, format!("{:x}", hash.finalize()));
    }
    Ok(result)
}
/// All inputs are immutable, authenticated transport copies from ONE company.
pub(crate) fn merge(
    store: &LocalStore,
    base_path: &Path,
    local_path: &Path,
    remote_path: &Path,
    output: &Path,
) -> AppResult<()> {
    merge_confirmed(store, base_path, local_path, remote_path, output, None)
}
pub(crate) fn merge_confirmed(
    store: &LocalStore,
    base_path: &Path,
    local_path: &Path,
    remote_path: &Path,
    output: &Path,
    receipt_resolution: Option<&DuplicateReceipt>,
) -> AppResult<()> {
    let temp = tempfile::tempdir_in(&store.data_dir)?;
    let paths = [
        temp.path().join("base"),
        temp.path().join("local"),
        temp.path().join("remote"),
    ];
    for (archive, dir) in [base_path, local_path, remote_path].iter().zip(&paths) {
        store.extract_company_copy(archive, dir)?;
    }
    let base_db = Connection::open(paths[0].join("database.sqlite3"))?;
    let local_db = Connection::open(paths[1].join("database.sqlite3"))?;
    let mut remote_db = Connection::open(paths[2].join("database.sqlite3"))?;
    let base = read(&base_db)?;
    let mut local = read(&local_db)?;
    let remote = read(&remote_db)?;
    schema(&base, &local)?;
    schema(&base, &remote)?;
    if let Some(choice) = receipt_resolution {
        normalize_duplicate(&base, &mut local, &remote, choice)?;
    }
    let merged = merge_rows(&base, &local, &remote)?;
    install_rows(&mut remote_db,&local_db,&base,&local,&remote,&merged,receipt_resolution).map_err(|e|match e {
        AppError::Database(rusqlite::Error::SqliteFailure(ref code,_)) if code.code==rusqlite::ErrorCode::ConstraintViolation => invalid("Deux changements utilisent une même référence ou une relation incompatible. Les copies originales sont conservées ; vérifiez ce document avant de réunir les changements."),
        e=>e,
    })?;
    drop(remote_db);
    crate::backup::validate_database(&paths[2].join("database.sqlite3"))?;
    let a = files(&paths[0].join("attachments"))?;
    let b = files(&paths[1].join("attachments"))?;
    let c = files(&paths[2].join("attachments"))?;
    for k in a.keys().chain(b.keys()).collect::<BTreeSet<_>>() {
        if a.get(k) == b.get(k) || b.get(k) == c.get(k) {
            continue;
        }
        if a.get(k) != c.get(k) {
            return Err(invalid(format!("Le document {k} a été modifié sur deux appareils. Les deux fichiers sont conservés.")));
        }
        let dest = paths[2].join("attachments").join(k);
        if b.contains_key(k) {
            fs::create_dir_all(dest.parent().unwrap())?;
            fs::copy(paths[1].join("attachments").join(k), dest)?;
        } else if dest.exists() {
            fs::remove_file(dest)?;
        }
    }
    let mut original = zip::ZipArchive::new(File::open(remote_path)?)?;
    let mut manifest = Vec::new();
    original
        .by_name("manifest.json")?
        .read_to_end(&mut manifest)?;
    let mut out = zip::ZipWriter::new(
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)?,
    );
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    out.start_file("manifest.json", options)?;
    out.write_all(&manifest)?;
    out.start_file("database.sqlite3", options)?;
    std::io::copy(
        &mut File::open(paths[2].join("database.sqlite3"))?,
        &mut out,
    )?;
    for k in files(&paths[2].join("attachments"))?.keys() {
        out.start_file(format!("attachments/{k}"), options)?;
        std::io::copy(
            &mut File::open(paths[2].join("attachments").join(k))?,
            &mut out,
        )?;
    }
    out.finish()?.sync_all()?;
    Ok(())
}
