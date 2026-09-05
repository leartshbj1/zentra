//! Allocate each cash movement to the remaining invoice lines, in stable chronological order.
//! Gross cents are conserved exactly; each line's last payment releases its remaining VAT cents.
use super::{push_issue, RawVatSource, VatBlockingIssue, VatReceivedPayment};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

fn allocate_gross(amount: i64, remaining: &[i64]) -> AppResult<Vec<i64>> {
    let total: i128 = remaining.iter().map(|value| i128::from(*value)).sum();
    if amount <= 0 || remaining.iter().any(|value| *value < 0) || i128::from(amount) > total {
        return Err(invalid(
            "Le paiement ne peut pas être ventilé sur le solde positif de la facture.",
        ));
    }
    let mut allocation = vec![0; remaining.len()];
    let mut fractions = Vec::new();
    let mut left = amount;
    for (index, weight) in remaining.iter().enumerate() {
        let product = i128::from(amount) * i128::from(*weight);
        allocation[index] = (product / total) as i64;
        left -= allocation[index];
        if allocation[index] < *weight {
            fractions.push((product % total, index));
        }
    }
    fractions.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    for (_, index) in fractions.into_iter().take(left as usize) {
        allocation[index] += 1;
    }
    if allocation.iter().sum::<i64>() != amount {
        return Err(invalid(
            "Écart dans la ventilation des centimes du paiement.",
        ));
    }
    Ok(allocation)
}

fn proportional_vat(vat: i64, paid: i64, gross: i64) -> i64 {
    ((i128::from(vat) * i128::from(paid) + i128::from(gross) / 2) / i128::from(gross)) as i64
}

pub(super) fn load_sources(
    connection: &Connection,
    source_type: &str,
    from: &str,
    to: &str,
    issues: &mut Vec<VatBlockingIssue>,
) -> AppResult<Vec<RawVatSource>> {
    let (headers, lines_table, payments_table, parent_key, status, reference, credit_check) = match source_type {
        "invoice_item" => ("invoices", "invoice_items", "payments", "invoice_id", "document.number IS NOT NULL AND document.status IN ('emise','partiellement_payee','payee') AND document.type<>'avoir'", "document.number", "(SELECT COUNT(*) FROM invoices credit WHERE credit.original_invoice_id=document.id AND credit.type='avoir' AND credit.number IS NOT NULL AND credit.status<>'annulee' AND credit.issue_date<=?2)"),
        "supplier_invoice_item" => ("supplier_invoices", "supplier_invoice_items", "supplier_payments", "supplier_invoice_id", "document.status='validated'", "NULLIF(document.reference,'')", "(SELECT COUNT(*) FROM supplier_credit_allocations allocation JOIN supplier_credit_notes credit ON credit.id=allocation.supplier_credit_note_id WHERE allocation.supplier_invoice_id=document.id AND credit.status='validated' AND credit.document_date<=?2)"),
        _ => return Err(invalid("Type d'achat ou de vente reçu inconnu.")),
    };
    // Only documents with movements in this period. Later payments never affect an earlier preview.
    let sql = format!("SELECT document.id,document.total_cents,COALESCE({reference},document.id),{credit_check} FROM {headers} document WHERE {status} AND EXISTS(SELECT 1 FROM {payments_table} payment WHERE payment.{parent_key}=document.id AND payment.date BETWEEN ?1 AND ?2) ORDER BY document.id");
    let documents = {
        let mut statement = connection.prepare(&sql)?;
        let rows = statement
            .query_map(params![from, to], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut sources = Vec::new();
    for (parent_id, total, document_reference, credits) in documents {
        if total <= 0 || credits != 0 {
            push_issue(issues, "unreliable_received_allocation", format!("La facture {document_reference} comporte un avoir ou une base non positive. Sa ventilation exige une imputation fiscale documentée."), Some(source_type.into()), Some(parent_id));
            continue;
        }
        let sql = format!("SELECT item.id,item.description,UPPER(TRIM(document.currency)),item.line_net_cents,item.line_vat_cents,item.line_total_cents,item.vat_bp,classification.id,classification.treatment,classification.note,classification.updated_at FROM {lines_table} item JOIN {headers} document ON document.id=item.{parent_key} LEFT JOIN vat_source_classifications classification ON classification.source_type=?1 AND classification.source_id=item.id WHERE document.id=?2 ORDER BY item.position,item.id");
        let mut originals = {
            let mut statement = connection.prepare(&sql)?;
            let rows = statement
                .query_map(params![source_type, parent_id], |row| {
                    Ok(RawVatSource {
                        source_type: source_type.into(),
                        source_id: row.get(0)?,
                        parent_id: parent_id.clone(),
                        occurrence_date: String::new(),
                        description: format!("{document_reference} · {}", row.get::<_, String>(1)?),
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
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let valid_lines = originals.iter().all(|line| {
            line.net_cents >= 0
                && line.vat_cents >= 0
                && i128::from(line.net_cents) + i128::from(line.vat_cents)
                    == i128::from(line.total_cents)
        });
        if !valid_lines
            || originals
                .iter()
                .map(|line| i128::from(line.total_cents))
                .sum::<i128>()
                != i128::from(total)
        {
            push_issue(issues, "unreliable_received_allocation", format!("Les lignes de {document_reference} ne concordent pas avec son total. La TVA reçue n'a pas été estimée."), Some(source_type.into()), Some(parent_id));
            continue;
        }
        let sql = format!("SELECT id,date,amount_cents FROM {payments_table} WHERE {parent_key}=?1 AND date<=?2 ORDER BY date,created_at,id");
        let payments = {
            let mut statement = connection.prepare(&sql)?;
            let rows = statement
                .query_map(params![parent_id, to], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        if payments.iter().any(|(_, _, amount)| *amount <= 0)
            || payments
                .iter()
                .map(|(_, _, amount)| i128::from(*amount))
                .sum::<i128>()
                > i128::from(total)
        {
            push_issue(issues, "unreliable_received_allocation", format!("Les paiements de {document_reference} dépassent le montant facturé ou contiennent une valeur non positive."), Some(source_type.into()), Some(parent_id));
            continue;
        }
        let gross: Vec<i64> = originals.iter().map(|line| line.total_cents).collect();
        let vat: Vec<i64> = originals.iter().map(|line| line.vat_cents).collect();
        let mut remaining = gross.clone();
        let mut vat_released = vec![0; originals.len()];
        for source in &mut originals {
            source.total_cents = 0;
            source.net_cents = 0;
            source.vat_cents = 0;
        }
        for (payment_id, date, amount) in payments {
            let allocation = allocate_gross(amount, &remaining)?;
            for (index, paid) in allocation.into_iter().enumerate() {
                if paid == 0 {
                    continue;
                }
                remaining[index] -= paid;
                let target_vat =
                    proportional_vat(vat[index], gross[index] - remaining[index], gross[index]);
                let paid_vat = target_vat - vat_released[index];
                vat_released[index] = target_vat;
                if date.as_str() < from {
                    continue;
                }
                let source = &mut originals[index];
                source.occurrence_date = date.clone();
                source.total_cents += paid;
                source.vat_cents += paid_vat;
                source.net_cents += paid - paid_vat;
                source.received_payments.push(VatReceivedPayment {
                    payment_id: payment_id.clone(),
                    date: date.clone(),
                    gross_cents: paid,
                    net_cents: paid - paid_vat,
                    vat_cents: paid_vat,
                });
            }
        }
        sources.extend(
            originals
                .into_iter()
                .filter(|source| source.total_cents != 0),
        );
    }
    Ok(sources)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gross_allocation_conserves_every_cent_and_finishes_without_residue() {
        let original = vec![10810, 10260, 10380, 1, 0];
        let mut remaining = original.clone();
        for amount in [1, 17, 10000, 7, 9000, 12426] {
            let allocated = allocate_gross(amount, &remaining).unwrap();
            assert_eq!(allocated.iter().sum::<i64>(), amount);
            for (rest, paid) in remaining.iter_mut().zip(allocated) {
                assert!(paid >= 0 && paid <= *rest);
                *rest -= paid;
            }
        }
        assert_eq!(remaining, vec![0; original.len()]);
        assert!(allocate_gross(1, &remaining).is_err());
    }

    #[test]
    fn cent_payments_never_release_negative_net_or_vat_and_recover_all_rounding() {
        let gross = [13, 15, 17, 1, 1081];
        let vat = [1, 1, 1, 0, 81];
        let mut remaining = gross.to_vec();
        let mut released = vec![0; gross.len()];
        for _ in 0..gross.iter().sum::<i64>() {
            let allocation = allocate_gross(1, &remaining).unwrap();
            for (index, paid) in allocation.into_iter().enumerate() {
                remaining[index] -= paid;
                let target =
                    proportional_vat(vat[index], gross[index] - remaining[index], gross[index]);
                let paid_vat = target - released[index];
                assert!(paid_vat >= 0 && paid_vat <= paid);
                released[index] = target;
            }
        }
        assert_eq!(remaining, vec![0; gross.len()]);
        assert_eq!(released, vat);
        assert!(allocate_gross(0, &gross).is_err());
        assert!(allocate_gross(-1, &gross).is_err());
        assert!(allocate_gross(1, &[-1, 3]).is_err());
    }
}
