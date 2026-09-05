//! Project purchase costs use recorded VAT decisions; invoices and payments stay immutable.
use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::error::{AppError, AppResult};

pub(crate) fn enrich(connection: &Connection, kind: &str, records: &mut [Value]) -> AppResult<()> {
    if records.is_empty() {
        return Ok(());
    }
    let (sources, sign, net_field, vat_field) = match kind {
        "expense" => (
            "SELECT e.id,COALESCE(j.entry_date,NULLIF(e.paid_at,''),e.date) AS date,j.id AS journal_id,e.payment_status='paid' AS expected_posting
             FROM expenses e LEFT JOIN journal_entries j ON j.source_type='expense' AND j.source_id=e.id AND j.source_event='create'",
            1_i64, "net_cents", "vat_cents",
        ),
        "supplier_invoice_item" => (
            "SELECT l.id,COALESCE(j.entry_date,h.document_date) AS date,j.id AS journal_id,h.status='validated' AS expected_posting
             FROM supplier_invoice_items l JOIN supplier_invoices h ON h.id=l.supplier_invoice_id LEFT JOIN journal_entries j ON j.id=h.validation_journal_entry_id",
            1, "line_net_cents", "line_vat_cents",
        ),
        "supplier_credit_note_item" => (
            "SELECT l.id,COALESCE(j.entry_date,h.document_date) AS date,j.id AS journal_id,h.status='validated' AS expected_posting
             FROM supplier_credit_note_items l JOIN supplier_credit_notes h ON h.id=l.supplier_credit_note_id LEFT JOIN journal_entries j ON j.id=h.validation_journal_entry_id",
            -1, "line_net_cents", "line_vat_cents",
        ),
        _ => return Err(AppError::Validation("Source de coût d’achat inconnue.".into())),
    };
    // Read all decisions and corrections for this source type together. No per-line workspace RPC.
    let sql = format!("WITH sources AS ({sources}), corrections AS (
        SELECT j.source_id,SUM(l.debit_cents-l.credit_cents) AS cost
        FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id
        JOIN accounts a ON a.id=l.account_id WHERE j.source_type='vat_input_reclassification' AND a.account_type='expense'
        GROUP BY j.source_id
    ) SELECT s.id,s.journal_id,s.expected_posting,c.treatment,
        COALESCE((SELECT vat_registered FROM settings WHERE id=1),0) OR EXISTS(SELECT 1 FROM vat_profiles p WHERE p.effective_from<=s.date AND COALESCE(p.effective_to,'9999-12-31')>=s.date),
        EXISTS(SELECT 1 FROM vat_profiles p WHERE p.effective_from<=s.date AND COALESCE(p.effective_to,'9999-12-31')>=s.date AND p.reporting_method='simple_tax_rate'),
        COALESCE(v.cost,0),EXISTS(SELECT 1 FROM journal_entries r WHERE r.reversal_of=s.journal_id)
        FROM sources s LEFT JOIN vat_source_classifications c ON c.source_type=?1 AND c.source_id=s.id
        LEFT JOIN corrections v ON v.source_id=?1||':'||s.id");
    let mut statement = connection.prepare(&sql)?;
    let metadata = statement
        .query_map(params![kind], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, bool>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, bool>(7)?,
                ),
            ))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;
    let mut reversal_states = HashMap::new();
    for record in records {
        let id = record["id"].as_str().unwrap_or_default();
        let Some((journal, expected_posting, treatment, registered, simple, correction, reversed)) =
            metadata.get(id)
        else {
            return Err(AppError::Validation(
                "La preuve du coût d’achat est introuvable.".into(),
            ));
        };
        let net = record[net_field].as_i64().unwrap_or_default();
        let vat = record[vat_field].as_i64().unwrap_or_default();
        let non_deductible =
            treatment.as_deref() == Some("non_deductible") || *simple || !registered;
        let classified = vat == 0
            || non_deductible
            || matches!(
                treatment.as_deref(),
                Some("input_materials" | "input_investments")
            );
        let expected_vat_cost = if non_deductible { vat } else { 0 };
        let actual_vat_cost = if journal.is_some() {
            correction.checked_mul(sign)
        } else {
            Some(expected_vat_cost)
        }
        .ok_or_else(|| {
            AppError::Validation("Le coût TVA de l’achat dépasse la capacité monétaire.".into())
        })?;
        let cost = net.checked_add(actual_vat_cost).ok_or_else(|| {
            AppError::Validation("Le coût de l’achat dépasse la capacité monétaire.".into())
        })?;
        let mut review = !classified
            || (*expected_posting && journal.is_none())
            || (classified && actual_vat_cost != expected_vat_cost);
        if *reversed {
            if let Some(root) = journal {
                let active = match reversal_states.get(root) {
                    Some(active) => *active,
                    None => {
                        let active =
                            crate::expense_journal::state(connection, root, "9999-12-31")?.active;
                        reversal_states.insert(root.clone(), active);
                        active
                    }
                };
                review |= !active;
            }
        }
        record["cost_cents"] = cost.into();
        record["cost_review_required"] = review.into();
        record["cost_basis"] = if review {
            "review"
        } else if journal.is_some() {
            "accounted"
        } else {
            "estimated"
        }
        .into();
    }
    Ok(())
}
