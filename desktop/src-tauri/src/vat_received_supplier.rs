//! A compensation settles two documents at once: the positive invoice and negative credit.
//! Reversals restore the exact original allocation. Future events never enter an earlier return.
use std::collections::{BTreeSet, HashMap};

use rusqlite::{params, Connection};

use super::{
    push_issue,
    received::{allocate_gross, proportional_vat},
    RawVatSource, VatBlockingIssue, VatReceivedPayment, VatReceivedSettlement,
};
use crate::error::{AppError, AppResult};

#[derive(Debug)]
struct Movement {
    id: String,
    date: String,
    amount: i64,
    created_at: String,
    sequence: i64,
    settlement: Option<VatReceivedSettlement>,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

/// Called within the business transaction, including bank-import payments. Today's balance
/// alone cannot validate a backdated settlement that overlaps a later, reversed credit.
pub(crate) fn validate_chronology(
    connection: &Connection,
    credit: bool,
    id: &str,
) -> AppResult<()> {
    let (header, parent) = if credit {
        ("supplier_credit_notes", "supplier_credit_note_id")
    } else {
        ("supplier_invoices", "supplier_invoice_id")
    };
    let unknown: bool = connection.query_row(&format!("SELECT EXISTS(SELECT 1 FROM supplier_credit_allocations allocation JOIN supplier_credit_notes credit ON credit.id=allocation.supplier_credit_note_id WHERE allocation.{parent}=?1 AND credit.status='validated' AND allocation.effective_date IS NULL)"), params![id], |row| row.get(0))?;
    // The existing balance guards still apply to legacy records; received returns remain
    // blocked until the unknown historical dates have documented evidence.
    if unknown {
        return Ok(());
    }
    let total: i64 = connection.query_row(
        &format!("SELECT total_cents FROM {header} WHERE id=?1"),
        params![id],
        |row| row.get(0),
    )?;
    let mut settled = 0_i128;
    let mut applied = BTreeSet::new();
    for event in movements(connection, credit, id, "9999-12-31")? {
        if let Some(original) = event
            .settlement
            .as_ref()
            .and_then(|proof| proof.reverses_allocation_id.as_ref())
        {
            if !applied.contains(original) {
                return Err(invalid("L’extourne doit suivre son imputation initiale dans l’historique des règlements."));
            }
            settled -= i128::from(event.amount);
        } else {
            settled += i128::from(event.amount);
            applied.insert(event.id);
        }
        if settled < 0 || settled > i128::from(total) {
            return Err(AppError::Validation(format!("La date du règlement rend le solde {} incohérent au {}. Vérifiez la chronologie des paiements, compensations et extournes ; aucune nouvelle opération n’a été enregistrée.", if credit { "de l’avoir" } else { "de la facture" }, event.date)));
        }
    }
    Ok(())
}

pub(super) fn load_sources(
    connection: &Connection,
    from: &str,
    to: &str,
    issues: &mut Vec<VatBlockingIssue>,
) -> AppResult<Vec<RawVatSource>> {
    let mut undated = BTreeSet::new();
    let mut statement = connection.prepare("SELECT DISTINCT credit.id,COALESCE(credit.number,credit.reference,credit.id),allocation.supplier_invoice_id FROM supplier_credit_allocations allocation JOIN supplier_credit_notes credit ON credit.id=allocation.supplier_credit_note_id WHERE credit.status='validated' AND credit.document_date<=?1 AND allocation.effective_date IS NULL ORDER BY credit.id,allocation.supplier_invoice_id")?;
    for row in statement.query_map(params![to], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })? {
        let (credit, reference, invoice) = row?;
        if undated.insert((true, credit.clone())) {
            push_issue(issues, "unsupported_supplier_credit_tax", format!("L’avoir fournisseur {reference} comporte une compensation historique sans date effective confirmée. Sa période TVA doit être documentée avant l’export."), Some("supplier_credit_note_item".into()), Some(credit));
        }
        undated.insert((false, invoice));
    }
    let mut sources = Vec::new();
    for credit in [false, true] {
        let sql = if credit {
            "SELECT document.id,document.total_cents,COALESCE(document.number,NULLIF(document.reference,''),document.id) FROM supplier_credit_notes document WHERE document.status='validated' AND EXISTS(SELECT 1 FROM supplier_credit_allocations allocation WHERE allocation.supplier_credit_note_id=document.id AND allocation.effective_date BETWEEN ?1 AND ?2) ORDER BY document.id"
        } else {
            "SELECT document.id,document.total_cents,COALESCE(NULLIF(document.reference,''),document.id) FROM supplier_invoices document WHERE document.status='validated' AND (EXISTS(SELECT 1 FROM supplier_payments payment WHERE payment.supplier_invoice_id=document.id AND payment.date BETWEEN ?1 AND ?2) OR EXISTS(SELECT 1 FROM supplier_credit_allocations allocation JOIN supplier_credit_notes credit ON credit.id=allocation.supplier_credit_note_id WHERE allocation.supplier_invoice_id=document.id AND credit.status='validated' AND allocation.effective_date BETWEEN ?1 AND ?2)) ORDER BY document.id"
        };
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map(params![from, to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (id, total, reference) = row?;
            if undated.contains(&(credit, id.clone())) {
                continue;
            }
            let originals = document_lines(connection, credit, &id, &reference)?;
            let events = movements(connection, credit, &id, to)?;
            match allocate_document(originals, total, events, credit, from) {
                Ok(lines) => sources.extend(lines),
                Err(AppError::Validation(message)) => push_issue(
                    issues,
                    "unreliable_received_allocation",
                    format!("{reference} : {message}"),
                    Some(source_type(credit).into()),
                    Some(id),
                ),
                Err(error) => return Err(error),
            }
        }
    }
    Ok(sources)
}

fn source_type(credit: bool) -> &'static str {
    if credit {
        "supplier_credit_note_item"
    } else {
        "supplier_invoice_item"
    }
}

fn document_lines(
    connection: &Connection,
    credit: bool,
    id: &str,
    reference: &str,
) -> AppResult<Vec<RawVatSource>> {
    let (headers, lines, parent) = if credit {
        (
            "supplier_credit_notes",
            "supplier_credit_note_items",
            "supplier_credit_note_id",
        )
    } else {
        (
            "supplier_invoices",
            "supplier_invoice_items",
            "supplier_invoice_id",
        )
    };
    let sql = format!("SELECT item.id,item.description,UPPER(TRIM(document.currency)),item.line_net_cents,item.line_vat_cents,item.line_total_cents,item.vat_bp,classification.id,classification.treatment,classification.note,classification.updated_at FROM {lines} item JOIN {headers} document ON document.id=item.{parent} LEFT JOIN vat_source_classifications classification ON classification.source_type=?1 AND classification.source_id=item.id WHERE document.id=?2 ORDER BY item.position,item.id");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params![source_type(credit), id], |row| {
        Ok(RawVatSource {
            source_type: source_type(credit).into(),
            source_id: row.get(0)?,
            parent_id: id.into(),
            occurrence_date: String::new(),
            description: format!("{reference} · {}", row.get::<_, String>(1)?),
            currency: row.get(2)?,
            net_cents: row.get(3)?,
            vat_cents: row.get(4)?,
            total_cents: row.get(5)?,
            vat_rate_bp: Some(row.get(6)?),
            classification_id: row.get(7)?,
            treatment: row.get(8)?,
            classification_note: row.get(9)?,
            classification_updated_at: row.get(10)?,
            reliable: true,
            reliability_detail: None,
            received_payments: Vec::new(),
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn movements(
    connection: &Connection,
    credit: bool,
    id: &str,
    to: &str,
) -> AppResult<Vec<Movement>> {
    let mut events = Vec::new();
    if !credit {
        let mut statement = connection.prepare("SELECT id,date,amount_cents,created_at FROM supplier_payments WHERE supplier_invoice_id=?1 AND date<=?2 ORDER BY date,created_at,id")?;
        for row in statement.query_map(params![id, to], |row| {
            Ok(Movement {
                id: row.get(0)?,
                date: row.get(1)?,
                amount: row.get(2)?,
                created_at: row.get(3)?,
                sequence: 0,
                settlement: None,
            })
        })? {
            events.push(row?);
        }
    }
    let (parent, counterpart, reference) = if credit {
        (
            "allocation.supplier_credit_note_id",
            "invoice.id",
            "COALESCE(NULLIF(invoice.reference,''),invoice.id)",
        )
    } else {
        (
            "allocation.supplier_invoice_id",
            "credit.id",
            "COALESCE(credit.number,NULLIF(credit.reference,''),credit.id)",
        )
    };
    let sql = format!("SELECT allocation.id,allocation.effective_date,allocation.amount_cents,allocation.created_at,allocation.sequence,allocation.event_type,allocation.reverses_allocation_id,{counterpart},{reference} FROM supplier_credit_allocations allocation JOIN supplier_credit_notes credit ON credit.id=allocation.supplier_credit_note_id JOIN supplier_invoices invoice ON invoice.id=allocation.supplier_invoice_id WHERE {parent}=?1 AND credit.status='validated' AND invoice.status='validated' AND allocation.effective_date<=?2 ORDER BY allocation.sequence");
    let mut statement = connection.prepare(&sql)?;
    for row in statement.query_map(params![id, to], |row| {
        Ok(Movement {
            id: row.get(0)?,
            date: row.get(1)?,
            amount: row.get(2)?,
            created_at: row.get(3)?,
            sequence: row.get(4)?,
            settlement: Some(VatReceivedSettlement {
                kind: if row.get::<_, String>(5)? == "reverse" {
                    "credit_reversal"
                } else {
                    "credit_application"
                }
                .into(),
                reverses_allocation_id: row.get(6)?,
                counterpart_id: row.get(7)?,
                counterpart_reference: row.get(8)?,
            }),
        })
    })? {
        events.push(row?);
    }
    events.sort_by(|left, right| {
        (&left.date, &left.created_at, left.sequence, &left.id).cmp(&(
            &right.date,
            &right.created_at,
            right.sequence,
            &right.id,
        ))
    });
    Ok(events)
}

fn allocate_document(
    mut lines: Vec<RawVatSource>,
    total: i64,
    events: Vec<Movement>,
    credit: bool,
    from: &str,
) -> AppResult<Vec<RawVatSource>> {
    if total <= 0
        || lines.is_empty()
        || lines.iter().any(|line| {
            line.net_cents < 0
                || line.vat_cents < 0
                || i128::from(line.net_cents) + i128::from(line.vat_cents)
                    != i128::from(line.total_cents)
        })
        || lines
            .iter()
            .map(|line| i128::from(line.total_cents))
            .sum::<i128>()
            != i128::from(total)
    {
        return Err(invalid("Les lignes ne concordent pas avec le total positif du document. La TVA reçue n’a pas été estimée."));
    }
    let gross: Vec<i64> = lines.iter().map(|line| line.total_cents).collect();
    let vat: Vec<i64> = lines.iter().map(|line| line.vat_cents).collect();
    let mut remaining = gross.clone();
    let mut released = vec![0; lines.len()];
    let mut applications: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
    let mut reversed = BTreeSet::new();
    for line in &mut lines {
        line.net_cents = 0;
        line.vat_cents = 0;
        line.total_cents = 0;
    }
    for event in events {
        if event.amount <= 0 {
            return Err(invalid(
                "Le règlement doit être positif avant sa ventilation.",
            ));
        }
        let reversing = event
            .settlement
            .as_ref()
            .and_then(|proof| proof.reverses_allocation_id.as_deref());
        let parts = if let Some(original) = reversing {
            if !reversed.insert(original.to_owned()) {
                return Err(invalid("Une imputation est extournée plusieurs fois."));
            }
            let original_parts = applications.get(original).ok_or_else(|| {
                invalid("L’extourne ne dispose pas de l’imputation datée qui la précède.")
            })?;
            if original_parts.iter().map(|part| part.0).sum::<i64>() != event.amount {
                return Err(invalid(
                    "L’extourne diffère du montant imputé initialement.",
                ));
            }
            original_parts
                .iter()
                .map(|(amount, tax)| (-amount, -tax))
                .collect::<Vec<_>>()
        } else {
            let allocated = allocate_gross(event.amount, &remaining)?;
            allocated
                .iter()
                .enumerate()
                .map(|(index, amount)| {
                    let tax = if *amount == 0 {
                        0
                    } else {
                        let target = proportional_vat(
                            vat[index],
                            gross[index] - remaining[index] + amount,
                            gross[index],
                        );
                        // An exact reversal can move rounding cents away from the original cumulative ratio.
                        // Keep the cash part nonnegative, conserve both pools, and release the final residue.
                        let tax_remaining = vat[index] - released[index];
                        (target - released[index]).clamp(
                            (tax_remaining - (remaining[index] - amount)).max(0),
                            tax_remaining.min(*amount),
                        )
                    };
                    (*amount, tax)
                })
                .collect::<Vec<_>>()
        };
        if event
            .settlement
            .as_ref()
            .is_some_and(|proof| proof.kind == "credit_application")
        {
            applications.insert(event.id.clone(), parts.clone());
        }
        for (index, (amount, tax)) in parts.into_iter().enumerate() {
            if amount == 0 {
                continue;
            }
            remaining[index] -= amount;
            released[index] += tax;
            if remaining[index] < 0
                || remaining[index] > gross[index]
                || released[index] < 0
                || released[index] > vat[index]
            {
                return Err(invalid(
                    "La chronologie des règlements et des extournes dépasse le solde du document.",
                ));
            }
            if event.date.as_str() < from {
                continue;
            }
            let sign = if credit { -1 } else { 1 };
            let line = &mut lines[index];
            line.occurrence_date = event.date.clone();
            line.total_cents += sign * amount;
            line.vat_cents += sign * tax;
            line.net_cents += sign * (amount - tax);
            line.received_payments.push(VatReceivedPayment {
                payment_id: event.id.clone(),
                date: event.date.clone(),
                gross_cents: sign * amount,
                net_cents: sign * (amount - tax),
                vat_cents: sign * tax,
                settlement: event.settlement.clone(),
            });
        }
    }
    // Keep a compensation and its exact reversal even when their period net amount is zero.
    Ok(lines
        .into_iter()
        .filter(|line| !line.received_payments.is_empty())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line() -> RawVatSource {
        RawVatSource {
            source_type: "supplier_invoice_item".into(),
            source_id: "line".into(),
            parent_id: "invoice".into(),
            occurrence_date: String::new(),
            description: "Arrondis".into(),
            currency: "CHF".into(),
            net_cents: 919,
            vat_cents: 81,
            total_cents: 1000,
            vat_rate_bp: Some(810),
            classification_id: None,
            treatment: Some("input_materials".into()),
            classification_note: None,
            classification_updated_at: None,
            reliable: true,
            reliability_detail: None,
            received_payments: Vec::new(),
        }
    }

    fn event(id: &str, amount: i64, kind: Option<&str>, original: Option<&str>) -> Movement {
        Movement {
            id: id.into(),
            date: "2026-03-31".into(),
            amount,
            created_at: String::new(),
            sequence: 0,
            settlement: kind.map(|kind| VatReceivedSettlement {
                kind: kind.into(),
                counterpart_id: "credit".into(),
                counterpart_reference: "AV-1".into(),
                reverses_allocation_id: original.map(str::to_owned),
            }),
        }
    }

    #[test]
    fn received_credit_rounding_survives_reversal_after_an_intervening_cent_payment() {
        // The six-cent application releases zero VAT, the next cash cent releases one.
        // Reversing the application must not remove that cash VAT or release negative VAT later.
        let sources = allocate_document(
            vec![line()],
            1000,
            vec![
                event("apply", 6, Some("credit_application"), None),
                event("cash1", 1, None, None),
                event("reverse", 6, Some("credit_reversal"), Some("apply")),
                event("cash2", 1, None, None),
                event("cash3", 998, None, None),
            ],
            false,
            "2026-01-01",
        )
        .unwrap();
        let source = &sources[0];
        assert_eq!(
            (source.net_cents, source.vat_cents, source.total_cents),
            (919, 81, 1000)
        );
        assert_eq!(source.received_payments[0].vat_cents, 0);
        assert_eq!(source.received_payments[1].vat_cents, 1);
        assert_eq!(source.received_payments[2].vat_cents, 0);
        for payment in source
            .received_payments
            .iter()
            .filter(|row| row.settlement.is_none())
        {
            assert!(payment.vat_cents >= 0 && payment.net_cents >= 0);
            assert_eq!(payment.net_cents + payment.vat_cents, payment.gross_cents);
        }
    }

    #[test]
    fn received_credit_net_zero_period_keeps_both_settlement_proofs() {
        let sources = allocate_document(
            vec![line()],
            1000,
            vec![
                event("apply", 501, Some("credit_application"), None),
                event("reverse", 501, Some("credit_reversal"), Some("apply")),
            ],
            true,
            "2026-01-01",
        )
        .unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(
            (
                sources[0].net_cents,
                sources[0].vat_cents,
                sources[0].total_cents
            ),
            (0, 0, 0)
        );
        assert_eq!(sources[0].received_payments.len(), 2);
        assert_eq!(
            sources[0].received_payments[0].vat_cents,
            -sources[0].received_payments[1].vat_cents
        );
    }
}
