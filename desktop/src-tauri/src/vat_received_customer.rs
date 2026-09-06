//! Received VAT follows the same immutable line allocations as the customer ledger.
use rusqlite::{params, Connection};

use super::{
    push_issue, RawVatSource, VatBlockingIssue, VatReceivedPayment, VatReceivedSettlement,
};
use crate::{
    customer_credit_math::project, customer_credit_settlements::journal_proof_valid,
    error::AppResult,
};

pub(super) fn load_sources(
    connection: &Connection,
    from: &str,
    to: &str,
    issues: &mut Vec<VatBlockingIssue>,
) -> AppResult<Vec<RawVatSource>> {
    let mut statement = connection.prepare("SELECT i.id,i.type='avoir',i.number FROM invoices i WHERE i.number IS NOT NULL AND i.status NOT IN ('brouillon','annulee') AND (EXISTS(SELECT 1 FROM customer_credit_settlements e WHERE (e.credit_note_id=i.id OR e.invoice_id=i.id) AND e.date<=?2) OR EXISTS(SELECT 1 FROM customer_credit_recovery_tax_models r WHERE r.original_invoice_id=i.id)) AND (EXISTS(SELECT 1 FROM customer_credit_settlements e WHERE (e.credit_note_id=i.id OR e.invoice_id=i.id) AND e.date BETWEEN ?1 AND ?2) OR EXISTS(SELECT 1 FROM payments p WHERE p.invoice_id=i.id AND p.date BETWEEN ?1 AND ?2)) ORDER BY i.id")?;
    let documents = statement
        .query_map(params![from, to], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut sources = Vec::new();
    for (id, credit, reference) in documents {
        if let Err(error)=crate::customer_credit_recovery_vat::ensure_proof(connection,&id) {
            push_issue(issues,"customer_credit_recovery_posting_mismatch",format!("La reprise de {reference} exige une preuve TVA concordante : {error}"),Some("invoice_item".into()),Some(id));continue;
        }
        let projection = match project(connection, &id, to) {
            Ok(value) => value,
            Err(error) => {
                push_issue(
                    issues,
                    "unreliable_received_allocation",
                    format!(
                        "La ventilation datée de {reference} ne peut pas être vérifiée : {error}"
                    ),
                    Some("invoice_item".into()),
                    Some(id),
                );
                continue;
            }
        };
        // Validate the entire history used for this period; future events are irrelevant.
        let mut statement = connection.prepare("SELECT e.id,e.date,e.event_type,e.reverses_id,CASE WHEN e.credit_note_id=?1 THEN COALESCE(e.invoice_id,e.bank_account_id) ELSE e.credit_note_id END,COALESCE(i.number,a.name,c.number,e.reference) FROM customer_credit_settlements e LEFT JOIN invoices i ON i.id=e.invoice_id AND e.credit_note_id=?1 LEFT JOIN accounts a ON a.id=e.bank_account_id LEFT JOIN invoices c ON c.id=e.credit_note_id AND e.invoice_id=?1 WHERE (e.credit_note_id=?1 OR e.invoice_id=?1) AND e.date<=?2 ORDER BY e.date,e.created_at,e.sequence,e.id")?;
        let events = statement
            .query_map(params![id, to], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut movements = Vec::new();
        let mut valid = true;
        for (event, date, kind, reverses, counterpart, counterpart_reference) in events {
            if !journal_proof_valid(connection, &event)? {
                push_issue(issues,"customer_credit_settlement_posting_mismatch",format!("Le règlement de {reference} du {date} exige une preuve comptable concordante avant l’export TVA."),Some("customer_credit_settlement".into()),Some(event.clone()));
                valid = false;
            }
            if date.as_str() >= from {
                movements.push((
                    event,
                    date,
                    Some(VatReceivedSettlement {
                        kind: format!("customer_credit_{kind}"),
                        counterpart_id: counterpart,
                        counterpart_reference,
                        reverses_allocation_id: reverses,
                    }),
                ));
            }
        }
        if !valid {
            continue;
        }
        if !credit {
            let mut statement=connection.prepare("SELECT id,date FROM payments WHERE invoice_id=?1 AND date BETWEEN ?2 AND ?3 ORDER BY date,created_at,id")?;
            for row in statement.query_map(params![id, from, to], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })? {
                let (payment, date) = row?;
                movements.push((payment, date, None));
            }
        }
        movements.sort_by(|a, b| (&a.1, &a.0).cmp(&(&b.1, &b.0)));
        let mut statement=connection.prepare("SELECT item.id,item.description,UPPER(TRIM(i.currency)),item.vat_bp,c.id,c.treatment,c.note,c.updated_at FROM invoice_items item JOIN invoices i ON i.id=item.invoice_id LEFT JOIN vat_source_classifications c ON c.source_type='invoice_item' AND c.source_id=item.id WHERE item.invoice_id=? ORDER BY item.position,item.id")?;
        let originals = statement
            .query_map([&id], |r| {
                Ok(RawVatSource {
                    source_type: "invoice_item".into(),
                    source_id: r.get(0)?,
                    parent_id: id.clone(),
                    occurrence_date: String::new(),
                    description: format!("{reference} · {}", r.get::<_, String>(1)?),
                    currency: r.get(2)?,
                    net_cents: 0,
                    vat_cents: 0,
                    total_cents: 0,
                    vat_rate_bp: Some(r.get(3)?),
                    classification_id: r.get(4)?,
                    treatment: r.get(5)?,
                    classification_note: r.get(6)?,
                    classification_updated_at: r.get(7)?,
                    reliable: true,
                    reliability_detail: None,
                    received_payments: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let sign = if credit { -1 } else { 1 };
        for mut source in originals {
            for (event, date, settlement) in &movements {
                let part = projection.parts.get(event).and_then(|parts| {
                    parts
                        .iter()
                        .find(|part| part.invoice_item_id == source.source_id)
                });
                let Some(part) = part else {
                    continue;
                };
                if part.gross_cents == 0 && part.vat_cents == 0 {
                    continue;
                }
                let gross = part.gross_cents * sign;
                let vat = part.vat_cents * sign;
                source.total_cents += gross;
                source.vat_cents += vat;
                source.net_cents += gross - vat;
                source.occurrence_date = date.clone();
                source.received_payments.push(VatReceivedPayment {
                    payment_id: event.clone(),
                    date: date.clone(),
                    gross_cents: gross,
                    net_cents: gross - vat,
                    vat_cents: vat,
                    settlement: settlement.clone(),
                });
            }
            // Preserve a zero-net refund/reversal pair and its supporting evidence.
            if !source.received_payments.is_empty() {
                sources.push(source);
            }
        }
    }
    Ok(sources)
}
