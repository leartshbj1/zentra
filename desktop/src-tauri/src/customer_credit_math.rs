//! One projection of dated customer settlements for ledger posting and VAT reporting.
//! Every reversal restores its own exact cents; later events cannot rewrite earlier parts.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    vat_reporting::received::{allocate_gross, allocate_signed_gross, proportional_vat},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Part {
    pub invoice_item_id: String,
    pub gross_cents: i64,
    pub vat_cents: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct Line {
    pub id: String,
    pub gross: i64,
    pub vat: i64,
    pub remaining: i64,
    pub released: i64,
}

#[derive(Debug)]
pub(crate) struct Projection {
    pub lines: Vec<Line>,
    pub parts: BTreeMap<String, Vec<Part>>,
}

#[derive(Debug)]
struct Movement {
    id: String,
    date: String,
    created_at: String,
    sequence: i64,
    amount: i64,
    reverses: Option<String>,
    stored: Option<Vec<Part>>,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

impl Projection {
    pub fn remaining(&self) -> AppResult<i64> {
        i64::try_from(
            self.lines
                .iter()
                .map(|line| i128::from(line.remaining))
                .sum::<i128>(),
        )
        .map_err(|_| invalid("Le solde du document dépasse la capacité monétaire locale."))
    }

    pub fn allocate(&self, amount: i64) -> AppResult<Vec<Part>> {
        let remaining: Vec<_> = self.lines.iter().map(|line| line.remaining).collect();
        let gross_parts = if remaining.iter().any(|value| *value < 0) {
            allocate_signed_gross(amount, &remaining)?
        } else {
            allocate_gross(amount, &remaining)?
        };
        self.lines.iter().zip(gross_parts).map(|(line,amount)| {
            let sign = if line.gross<0 { -1 } else { 1 };
            let (gross,vat,remaining,released,part)=(line.gross*sign,line.vat*sign,line.remaining*sign,line.released*sign,amount*sign);
            if part<0 || part>remaining || released<0 || released>vat || vat>gross {
                return Err(invalid("La ventilation ne respecte pas les soldes HT et TVA des lignes du document."));
            }
            let tax = if part==0 { 0 } else {
                let target=proportional_vat(vat,gross-remaining+part,gross);
                let tax_left=vat-released;
                (target-released).clamp((tax_left-(remaining-part)).max(0),tax_left.min(part))
            };
            Ok(Part { invoice_item_id:line.id.clone(),gross_cents:amount,vat_cents:tax*sign })
        }).collect()
    }

    fn apply(&mut self, parts: &[Part]) -> AppResult<()> {
        if parts.len() != self.lines.len() {
            return Err(invalid(
                "La ventilation du règlement omet une ligne du document.",
            ));
        }
        for (line, part) in self.lines.iter_mut().zip(parts) {
            if line.id != part.invoice_item_id {
                return Err(invalid(
                    "Les lignes du règlement ne correspondent pas au document.",
                ));
            }
            line.remaining = line
                .remaining
                .checked_sub(part.gross_cents)
                .ok_or_else(|| invalid("Ventilation hors capacité."))?;
            line.released = line
                .released
                .checked_add(part.vat_cents)
                .ok_or_else(|| invalid("TVA ventilée hors capacité."))?;
            let sign = if line.gross < 0 { -1 } else { 1 };
            if !(0..=line.gross * sign).contains(&(line.remaining * sign))
                || !(0..=line.vat * sign).contains(&(line.released * sign))
                || (line.vat - line.released) * sign > line.remaining * sign
            {
                return Err(invalid(
                    "La chronologie dépasse le solde TTC ou TVA d’une ligne du document.",
                ));
            }
        }
        Ok(())
    }
}

pub(crate) fn project(
    connection: &Connection,
    document_id: &str,
    through: &str,
) -> AppResult<Projection> {
    project_until(connection, document_id, through, None)
}

pub(crate) fn project_until(
    connection: &Connection,
    document_id: &str,
    through: &str,
    stop_after: Option<&str>,
) -> AppResult<Projection> {
    let (credit, total): (bool, i64) = connection.query_row(
        "SELECT type='avoir',total_cents FROM invoices WHERE id=?",
        [document_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let sign = if credit { -1 } else { 1 };
    let lines = {
        let mut statement=connection.prepare("SELECT id,line_net_cents,line_vat_cents,line_total_cents FROM invoice_items WHERE invoice_id=? ORDER BY position,id")?;
        let rows = statement.query_map([document_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        let mut lines = Vec::new();
        for row in rows {
            let (id, net, vat, gross) = row?;
            if i128::from(net) + i128::from(vat) != i128::from(gross)
                || net.signum() * vat.signum() < 0
            {
                return Err(invalid(
                    "Les montants des lignes ne correspondent plus au document émis.",
                ));
            }
            lines.push(Line {
                id,
                gross: gross * sign,
                vat: vat * sign,
                remaining: gross * sign,
                released: 0,
            });
        }
        lines
    };
    if lines.is_empty()
        || total.checked_mul(sign).is_none_or(|value| value <= 0)
        || lines
            .iter()
            .map(|line| i128::from(line.gross))
            .sum::<i128>()
            != i128::from(total) * i128::from(sign)
    {
        return Err(invalid(
            "Le total du document ne permet pas une ventilation fiable du règlement.",
        ));
    }
    let mut movements = Vec::new();
    if !credit {
        let legacy: bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM invoices c WHERE c.type='avoir' AND c.original_invoice_id=? AND c.number IS NOT NULL AND c.status<>'annulee' AND NOT EXISTS(SELECT 1 FROM customer_credit_documents d WHERE d.credit_note_id=c.id))",[document_id],|r|r.get(0))?;
        if legacy {
            return Err(invalid("Cette facture comporte un avoir historique sans règlement daté. Documentez sa reprise avant une nouvelle imputation."));
        }
        let mut statement = connection.prepare(
            "SELECT id,date,created_at,amount_cents FROM payments WHERE invoice_id=?1 AND date<=?2",
        )?;
        for row in statement.query_map(params![document_id, through], |r| {
            Ok(Movement {
                id: r.get(0)?,
                date: r.get(1)?,
                created_at: r.get(2)?,
                amount: r.get(3)?,
                sequence: 0,
                reverses: None,
                stored: None,
            })
        })? {
            movements.push(row?);
        }
    }
    let side = if credit { "credit" } else { "invoice" };
    let column = if credit {
        "credit_note_id"
    } else {
        "invoice_id"
    };
    let sql=format!("SELECT id,date,created_at,amount_cents,sequence,reverses_id FROM customer_credit_settlements WHERE {column}=?1 AND date<=?2");
    let mut statement = connection.prepare(&sql)?;
    for row in statement.query_map(params![document_id, through], |r| {
        Ok(Movement {
            id: r.get(0)?,
            date: r.get(1)?,
            created_at: r.get(2)?,
            amount: r.get(3)?,
            sequence: r.get(4)?,
            reverses: r.get(5)?,
            stored: None,
        })
    })? {
        let mut movement = row?;
        let mut parts=connection.prepare("SELECT p.invoice_item_id,p.gross_cents,p.vat_cents FROM customer_credit_settlement_lines p JOIN invoice_items i ON i.id=p.invoice_item_id WHERE p.settlement_id=?1 AND p.side=?2 ORDER BY i.position,i.id")?;
        movement.stored = Some(
            parts
                .query_map(params![movement.id, side], |r| {
                    Ok(Part {
                        invoice_item_id: r.get(0)?,
                        gross_cents: r.get(1)?,
                        vat_cents: r.get(2)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?,
        );
        movements.push(movement);
    }
    movements.sort_by(|a, b| {
        (&a.date, &a.created_at, a.sequence, &a.id).cmp(&(
            &b.date,
            &b.created_at,
            b.sequence,
            &b.id,
        ))
    });
    let mut projection = Projection {
        lines,
        parts: BTreeMap::new(),
    };
    let mut reversed = BTreeSet::new();
    for movement in movements {
        if movement.amount <= 0 {
            return Err(invalid(
                "Le règlement client doit avoir un montant positif.",
            ));
        }
        let parts = if let Some(original) = movement.reverses.as_ref() {
            if !reversed.insert(original.clone()) {
                return Err(invalid("Un règlement client est extourné plusieurs fois."));
            }
            let original = projection
                .parts
                .get(original)
                .ok_or_else(|| invalid("L’extourne précède le règlement qu’elle corrige."))?;
            if original
                .iter()
                .map(|part| i128::from(part.gross_cents))
                .sum::<i128>()
                != i128::from(movement.amount)
            {
                return Err(invalid(
                    "L’extourne ne reprend pas le montant du règlement d’origine.",
                ));
            }
            original
                .iter()
                .map(|part| Part {
                    invoice_item_id: part.invoice_item_id.clone(),
                    gross_cents: -part.gross_cents,
                    vat_cents: -part.vat_cents,
                })
                .collect::<Vec<_>>()
        } else {
            projection.allocate(movement.amount)?
        };
        if movement
            .stored
            .as_ref()
            .is_some_and(|stored| *stored != parts)
        {
            return Err(invalid("La ventilation enregistrée du règlement client ne concorde plus avec sa chronologie."));
        }
        projection.apply(&parts)?;
        let stop = stop_after == Some(movement.id.as_str());
        projection.parts.insert(movement.id, parts);
        if stop {
            break;
        }
    }
    if stop_after.is_some_and(|id| !projection.parts.contains_key(id)) {
        return Err(invalid(
            "Le règlement demandé est absent de la chronologie.",
        ));
    }
    Ok(projection)
}
