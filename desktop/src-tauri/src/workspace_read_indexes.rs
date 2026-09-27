//! Rebuildable local read indexes: no synchronized columns or business rules change.
use super::*;

pub(super) fn ensure(connection: &Connection) -> AppResult<()> {
    for (table, columns, sql) in [
        ("invoices", &["original_invoice_id", "type"][..],
         "CREATE INDEX IF NOT EXISTS idx_invoices_original_type ON invoices(original_invoice_id,type)"),
        ("journal_lines", &["journal_entry_id"][..],
         "CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(journal_entry_id)"),
    ] {
        // Some recovery/migration fixtures intentionally contain only a partial
        // historical schema. Add the index only when all its columns exist.
        let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
        let available = statement.query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        if columns.iter().all(|column| available.contains(*column)) {
            connection.execute_batch(sql)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_preserve_rows_and_are_rebuilt_without_changing_schema_version() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("PRAGMA user_version=60;
            CREATE TABLE invoices(id TEXT PRIMARY KEY,original_invoice_id TEXT,type TEXT);
            INSERT INTO invoices VALUES('issued',NULL,'standard'),('credit','issued','avoir'),('credit-2','issued','avoir');
            CREATE TABLE journal_lines(id TEXT PRIMARY KEY,journal_entry_id TEXT,debit_cents INTEGER,credit_cents INTEGER);
            INSERT INTO journal_lines VALUES('debit','entry',12300,0),('credit','entry',0,12300);").unwrap();
        let queries = ["SELECT * FROM invoices WHERE original_invoice_id='issued' AND type='avoir' ORDER BY id",
            "SELECT * FROM journal_lines WHERE journal_entry_id='entry' ORDER BY id"];
        let before: Vec<_> = queries.iter().map(|sql| query_all(&connection, sql, []).unwrap()).collect();
        for _ in 0..2 { ensure(&connection).unwrap(); }
        for (index, sql) in queries.iter().enumerate() {
            assert_eq!(before[index], query_all(&connection, sql, []).unwrap());
            let plan = query_all(&connection, &format!("EXPLAIN QUERY PLAN {sql}"), []).unwrap();
            let expected = ["idx_invoices_original_type", "idx_journal_lines_entry"][index];
            assert!(plan.iter().any(|row| row["detail"].as_str().unwrap().contains(expected)));
        }
        connection.execute_batch("DROP INDEX idx_invoices_original_type; DROP INDEX idx_journal_lines_entry;").unwrap();
        ensure(&connection).unwrap();
        assert_eq!(connection.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 60);
        assert_eq!(connection.query_row("SELECT SUM(debit_cents-credit_cents) FROM journal_lines", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn incomplete_historical_fixture_is_left_untouched() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE invoices(id TEXT);").unwrap();
        ensure(&connection).unwrap();
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
}
