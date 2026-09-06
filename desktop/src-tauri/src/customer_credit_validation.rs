//! Validate the original taxable sale before credit issuance changes any ledger.
//! The invoice-wide gross ceiling alone cannot protect a mixed-rate invoice.
use std::collections::BTreeMap;

use rusqlite::{params, Transaction};

use crate::error::{AppError, AppResult};

#[derive(Default)]
struct TaxBucket {
    net: i128,
    vat: i128,
    gross: i128,
}

pub(crate) fn validate_issue_basis(
    tx: &Transaction<'_>,
    original_id: &str,
    credit_id: &str,
    issue_date: &str,
) -> AppResult<()> {
    let original_date: String = tx.query_row(
        "SELECT issue_date FROM invoices WHERE id=?",
        [original_id],
        |row| row.get(0),
    )?;
    if issue_date < original_date.as_str() {
        return Err(AppError::Validation(format!(
            "La date de l’avoir ne peut pas précéder celle de la facture originale ({original_date})."
        )));
    }

    let mut originals: BTreeMap<i64, TaxBucket> = BTreeMap::new();
    let mut credits: BTreeMap<i64, TaxBucket> = BTreeMap::new();
    let mut statement = tx.prepare(
        "SELECT item.vat_bp,item.line_net_cents,item.line_vat_cents,item.line_total_cents,
                invoice.id=?1
           FROM invoice_items item JOIN invoices invoice ON invoice.id=item.invoice_id
          WHERE invoice.id=?1 OR invoice.id=?2
             OR (invoice.type='avoir' AND invoice.original_invoice_id=?1
                 AND invoice.number IS NOT NULL AND invoice.status<>'annulee')",
    )?;
    let rows = statement.query_map(params![original_id, credit_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, bool>(4)?,
        ))
    })?;
    for row in rows {
        let (rate, net, vat, gross, original) = row?;
        if i128::from(net) + i128::from(vat) != i128::from(gross) {
            return Err(AppError::Validation(
                "Les lignes de la facture ou de ses avoirs ne concordent plus avec leurs montants. Vérifiez les documents avant d’émettre cet avoir.".into(),
            ));
        }
        let (buckets, sign) = if original {
            (&mut originals, 1_i128)
        } else {
            (&mut credits, -1_i128)
        };
        let bucket = buckets.entry(rate).or_default();
        bucket.net += i128::from(net) * sign;
        bucket.vat += i128::from(vat) * sign;
        bucket.gross += i128::from(gross) * sign;
    }
    // Sum signed original lines: an already deducted deposit must not become
    // available again just because its positive lines share the same VAT rate.
    for (rate, credit) in credits {
        if credit.net == 0 && credit.vat == 0 && credit.gross == 0 {
            continue;
        }
        let original = originals.get(&rate);
        if credit.net < 0
            || credit.vat < 0
            || credit.gross < 0
            || original.is_none_or(|original| {
                credit.net > original.net
                    || credit.vat > original.vat
                    || credit.gross > original.gross
            })
        {
            let formatted_rate = format!("{},{:02}", rate / 100, rate % 100);
            return Err(AppError::Validation(format!(
                "Le cumul des avoirs dépasse le montant hors taxe, la TVA ou le total de la facture originale au taux de {formatted_rate} %. Reprenez ses taux et les montants encore créditables ; une correction de taux exige un avoir au taux d’origine puis une facture corrigée."
            )));
        }
    }
    Ok(())
}
