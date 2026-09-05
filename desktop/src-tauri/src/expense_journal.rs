//! Inspect immutable expense reversal chains without inferring a refund or a tax date.
use crate::{database::query_all, error::AppResult};
use rusqlite::{params, Connection};
use std::collections::BTreeMap;

pub(crate) struct ChainState {
    pub active: bool,
    pub restorable: bool,
    pub tip_id: String,
    pub tip_number: String,
}

pub(crate) fn state(connection: &Connection, root: &str, through: &str) -> AppResult<ChainState> {
    let chain = query_all(connection, "WITH RECURSIVE chain(id,number,entry_date,reversal_of,source_type,source_event,depth) AS (
        SELECT id,number,entry_date,reversal_of,source_type,source_event,0 FROM journal_entries WHERE id=?1 AND entry_date<=?2
        UNION ALL SELECT e.id,e.number,e.entry_date,e.reversal_of,e.source_type,e.source_event,c.depth+1 FROM chain c JOIN journal_entries e ON e.reversal_of=c.id WHERE e.entry_date<=?2 AND c.depth<256
        ) SELECT * FROM chain ORDER BY depth,id", params![root,through])?;
    let mut balances: BTreeMap<String, i128> = BTreeMap::new();
    let mut valid = !chain.is_empty() && chain.len() <= 256;
    for (index, entry) in chain.iter().enumerate() {
        let id = entry["id"].as_str().unwrap_or_default();
        valid &= entry["depth"].as_u64() == Some(index as u64);
        let rows = query_all(connection,"SELECT account_id,currency,project_id,client_id,employee_id,SUM(debit_cents-credit_cents) AS amount FROM journal_lines WHERE journal_entry_id=? GROUP BY account_id,currency,project_id,client_id,employee_id",params![id])?;
        let mut balance = BTreeMap::new();
        for row in rows {
            let amount = i128::from(row["amount"].as_i64().unwrap_or_default());
            if amount != 0 {
                let key = serde_json::to_string(&(
                    &row["account_id"],
                    &row["currency"],
                    &row["project_id"],
                    &row["client_id"],
                    &row["employee_id"],
                ))?;
                balance.insert(key, amount);
            }
        }
        valid &= !balance.is_empty();
        if index > 0 {
            valid &=
                entry["source_type"] == "journal_reversal" && entry["source_event"] == "reverse";
            let previous = &chain[index - 1];
            valid &= entry["reversal_of"] == previous["id"]
                && entry["entry_date"].as_str() >= previous["entry_date"].as_str();
            let inverse: BTreeMap<_, _> = balances
                .iter()
                .map(|(key, amount)| (key.clone(), -amount))
                .collect();
            valid &= balance == inverse;
        }
        balances = balance;
    }
    let tip = chain.last();
    Ok(ChainState {
        active: valid && chain.len() % 2 == 1,
        restorable: valid && chain.len() % 2 == 0,
        tip_id: tip.and_then(|v| v["id"].as_str()).unwrap_or(root).into(),
        tip_number: tip
            .and_then(|v| v["number"].as_str())
            .unwrap_or(root)
            .into(),
    })
}

pub(crate) fn reversal_action(
    connection: &Connection,
    entry: &str,
) -> AppResult<Option<&'static str>> {
    let roots = query_all(connection,"WITH RECURSIVE ancestry(id,source_type,reversal_of,depth) AS (SELECT id,source_type,reversal_of,0 FROM journal_entries WHERE id=? UNION ALL SELECT p.id,p.source_type,p.reversal_of,a.depth+1 FROM ancestry a JOIN journal_entries p ON p.id=a.reversal_of WHERE a.depth<256) SELECT id FROM ancestry WHERE source_type='expense' AND reversal_of IS NULL",params![entry])?;
    let Some(root) = roots.first().and_then(|v| v["id"].as_str()) else {
        return Ok(None);
    };
    let chain = state(connection, root, "9999-12-31")?;
    Ok(Some(if chain.restorable && chain.tip_id == entry {
        "restore_expense"
    } else {
        "blocked_expense"
    }))
}

pub(crate) fn append_vat_issues(
    connection: &Connection,
    through: &str,
    issues: &mut Vec<crate::vat_reporting::VatBlockingIssue>,
) -> AppResult<()> {
    let roots = query_all(connection,"SELECT j.id,e.reference,e.supplier FROM expenses e JOIN journal_entries j ON j.source_type='expense' AND j.source_id=e.id AND j.source_event='create' AND j.reversal_of IS NULL WHERE e.vat_cents<>0 AND e.payment_status='paid' AND j.entry_date<=?1 AND EXISTS(SELECT 1 FROM journal_entries r WHERE r.reversal_of=j.id AND r.entry_date<=?1)",params![through])?;
    for root in roots {
        let chain = state(connection, root["id"].as_str().unwrap_or_default(), through)?;
        if !chain.active {
            issues.push(crate::vat_reporting::VatBlockingIssue {
                code: "expense_journal_inactive".into(),
                message: format!("La dépense {} ({}) reste payée, mais son écriture est annulée ou incohérente au {}. Contrôlez {} dans le journal et rétablissez l’écriture si l’extourne était une erreur. Aucun remboursement ni ajustement TVA n’est déduit de cette extourne isolée.",root["reference"].as_str().unwrap_or("sans référence"),root["supplier"].as_str().unwrap_or("fournisseur"),through,chain.tip_number),
                source_type: Some("journal_entry".into()),
                source_id: Some(chain.tip_id),
            });
        }
    }
    Ok(())
}
