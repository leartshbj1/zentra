//! V61 changes only native update guards, never stored business rows or their
//! shared structural format. The migration runs inside LocalStore's transaction.
use crate::error::AppResult;
use rusqlite::{Connection, Transaction};

fn present(connection: &Connection, tables: &[&str]) -> AppResult<bool> {
    for table in tables {
        if !connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
            [table],
            |row| row.get::<_, bool>(0),
        )? {
            // Some old migration fixtures contain only a subset of entities.
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn migrate(transaction: &Transaction<'_>) -> AppResult<()> {
    for (child, parent, foreign_key, name, frozen, message) in [
        (
            "invoice_items",
            "invoices",
            "invoice_id",
            "invoice_items_issued_no_update",
            "number IS NOT NULL",
            "issued invoice lines are immutable",
        ),
        (
            "quote_items",
            "quotes",
            "quote_id",
            "quote_items_issued_no_update",
            "number IS NOT NULL",
            "issued quote lines are immutable",
        ),
        (
            "payslip_items",
            "payslips",
            "payslip_id",
            "payslip_items_posted_no_update",
            "status IN ('comptabilise','paye')",
            "posted payslip lines are immutable",
        ),
    ] {
        if present(transaction, &[child, parent])? {
            // All identifiers and predicates are compile-time values above.
            transaction.execute_batch(&format!(
                "DROP TRIGGER IF EXISTS {name};
                 CREATE TRIGGER {name} BEFORE UPDATE ON {child}
                 WHEN EXISTS(SELECT 1 FROM {parent}
                   WHERE id IN (OLD.{foreign_key},NEW.{foreign_key}) AND {frozen})
                 BEGIN SELECT RAISE(ABORT,'{message}'); END;"
            ))?;
        }
    }
    for (child, name, message) in [
        (
            "payslip_items",
            "payslip_items_later_posted_update_guard",
            "a later posted payslip seals earlier validated payroll lines",
        ),
        (
            "payslip_contributions",
            "payslip_contributions_later_posted_update_guard",
            "a later posted payslip seals earlier payroll contributions",
        ),
    ] {
        if present(transaction, &[child, "payslips"])? {
            transaction.execute_batch(&format!(
                "DROP TRIGGER IF EXISTS {name};
                 CREATE TRIGGER {name} BEFORE UPDATE ON {child}
                 WHEN EXISTS(SELECT 1 FROM payslips current JOIN payslips later
                   ON later.employee_id=current.employee_id
                   AND SUBSTR(later.period,1,4)=SUBSTR(current.period,1,4)
                   AND later.period>current.period AND later.status IN ('valide','comptabilise','paye')
                   WHERE current.id IN (OLD.payslip_id,NEW.payslip_id)
                     AND current.status IN ('valide','comptabilise','paye'))
                 BEGIN SELECT RAISE(ABORT,'{message}'); END;"
            ))?;
        }
    }
    transaction.pragma_update(None, "user_version", 61)?;
    Ok(())
}
