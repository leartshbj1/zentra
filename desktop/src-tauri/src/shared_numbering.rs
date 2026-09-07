use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

// No binding is created automatically. Company bootstrap must first publish
// its historical numbering floors before enabling this mode on any device.
pub(crate) fn consume(
    tx: &Transaction<'_>, prefix: &str, year: i64, minimum: i64,
) -> AppResult<Option<i64>> {
    let organization: Option<String> = tx.query_row(
        "SELECT organization_id FROM shared_numbering_binding WHERE id=1", [], |row| row.get(0),
    ).optional()?;
    let Some(organization) = organization else { return Ok(None); };
    let installation: String = tx.query_row("SELECT zentra_installation_id()", [], |row| row.get(0))?;
    let range: Option<(String, i64, i64)> = tx.query_row(
        "SELECT request_id,next_value,MAX(next_value,?) FROM device_number_ranges
         WHERE organization_id=? AND installation_id=? AND prefix=? AND year=?
           AND start_value IS NOT NULL AND end_value>=MAX(next_value,?)
         ORDER BY start_value,request_id LIMIT 1",
        params![minimum,organization,installation,prefix,year,minimum],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).optional()?;
    let Some((request, previous, next)) = range else {
        return Err(AppError::Validation(format!("Les numéros réservés pour {prefix}-{year} sont épuisés sur cet appareil. Reconnectez Zentra pour en obtenir de nouveaux. Le brouillon reste disponible.")));
    };
    let updated = tx.execute("UPDATE device_number_ranges SET next_value=? WHERE request_id=? AND next_value=?", params![next+1,request,previous])?;
    if updated != 1 { return Err(AppError::Validation("La réservation du numéro a changé. Relancez l’opération.".into())); }
    Ok(Some(next))
}

// A backup may preserve the shared-company binding, never a device's unused
// numbers or its in-flight request. Replaying an old backup must acquire a new
// server reservation even when it is restored to the original installation.
pub(crate) fn strip_device_ranges(connection: &Connection) -> AppResult<()> {
    let present: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='device_number_ranges')", [], |row| row.get(0))?;
    if present { connection.execute("DELETE FROM device_number_ranges", [])?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::LocalStore;

    fn reserve(store: &LocalStore, start: i64, count: i64) {
        let connection = store.connect().unwrap();
        connection.execute("INSERT OR IGNORE INTO shared_numbering_binding VALUES(1,'org','2026-09-08')", []).unwrap();
        connection.execute("INSERT INTO device_number_ranges(request_id,organization_id,installation_id,prefix,year,minimum,count,start_value,end_value,next_value) VALUES(?,'org',?,'F',2026,1,?,?,?,?)", params![uuid::Uuid::new_v4().to_string(),store.installation_id,count,start,start+count-1,start]).unwrap();
    }

    #[test]
    fn only_committed_documents_consume_device_numbers_and_exhaustion_never_falls_back() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        reserve(&store, 101, 2);
        let mut connection = store.connect().unwrap();
        {
            let tx = connection.transaction().unwrap();
            assert_eq!(consume(&tx, "F", 2026, 1).unwrap(), Some(101));
            // Roll back the document and its consumption together.
        }
        let tx = connection.transaction().unwrap();
        assert_eq!(consume(&tx, "F", 2026, 1).unwrap(), Some(101));
        tx.commit().unwrap();
        let tx = connection.transaction().unwrap();
        assert_eq!(consume(&tx, "F", 2026, 1).unwrap(), Some(102));
        tx.commit().unwrap();
        let tx = connection.transaction().unwrap();
        assert!(consume(&tx, "F", 2026, 1).unwrap_err().to_string().contains("épuisés"));
        assert!(consume(&tx, "D", 2026, 1).is_err());
        assert!(consume(&tx, "F", 2027, 1).is_err());
    }

    #[test]
    fn restoration_cannot_reuse_a_reserved_range_on_the_same_or_another_computer() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
        reserve(&source, 201, 100);
        let archive = source.create_backup(None, env!("CARGO_PKG_VERSION")).unwrap();
        let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
        for store in [&source, &destination] {
            store.restore_backup(&archive, env!("CARGO_PKG_VERSION")).unwrap();
            let mut connection = store.connect().unwrap();
            let tx = connection.transaction().unwrap();
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM device_number_ranges", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
            assert!(consume(&tx, "F", 2026, 1).is_err());
        }
    }

    #[test]
    fn ranges_are_bound_to_the_company_device_prefix_and_floor() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        reserve(&store, 101, 100);
        let mut connection = store.connect().unwrap();
        connection.execute("UPDATE device_number_ranges SET installation_id='another-device'", []).unwrap();
        assert!(consume(&connection.transaction().unwrap(), "F", 2026, 1).is_err());
        connection.execute("UPDATE device_number_ranges SET installation_id=?,organization_id='another-company'", params![store.installation_id]).unwrap();
        assert!(consume(&connection.transaction().unwrap(), "F", 2026, 1).is_err());
        connection.execute("UPDATE device_number_ranges SET organization_id='org'", []).unwrap();
        let tx = connection.transaction().unwrap();
        assert_eq!(consume(&tx, "F", 2026, 180).unwrap(), Some(180));
        tx.commit().unwrap();
        assert_eq!(consume(&connection.transaction().unwrap(), "F", 2026, 1).unwrap(), Some(181));
    }

    #[test]
    fn an_unshared_company_keeps_its_existing_numbering_behavior() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let mut connection = store.connect().unwrap();
        assert_eq!(consume(&connection.transaction().unwrap(), "F", 2026, 1).unwrap(), None);
    }
}
