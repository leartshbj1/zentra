//! Normalize an old native schema only after verifying its sealed artifact.
//! Never rewrite the saved proposal or run profile initialization on its copy.
use super::*;

pub(super) struct Snapshot {
    pub connection: Connection,
    // Drop the connection before removing its exclusively owned directory.
    _copy: Option<merge::native::Copy>,
}
impl Snapshot {
    pub(super) fn read(store: &LocalStore, path: &Path) -> AppResult<Self> {
        let original = readonly(path)?;
        let version = original.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))?;
        if version == crate::schema::SCHEMA_VERSION {
            return Ok(Self {
                connection: original,
                _copy: None,
            });
        }
        if version != 63 || crate::schema::SCHEMA_VERSION != 64 {
            return Err(invalid(
                "La version de cette proposition ne peut pas être reprise par cette application.",
            ));
        }
        let copy = merge::native::copy_source(store, &original)?;
        let mut connection = copy.store.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(crate::business_sync::retirement::cancellation::MIGRATION_SQL)?;
        private::verify_migration(&original, &tx)?;
        tx.commit()?;
        drop(connection);
        let connection = readonly(&copy.store.database_path)?;
        Ok(Self {
            connection,
            _copy: Some(copy),
        })
    }
}
