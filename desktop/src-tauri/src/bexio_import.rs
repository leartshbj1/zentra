use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use crate::{database::LocalStore, error::AppResult};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BexioContactRow {
    pub line: usize,
    pub data: Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BexioContactImport {
    pub scope: String,
    pub entity: String,
    pub rows: Vec<BexioContactRow>,
}

pub fn scope(store: &LocalStore) -> AppResult<String> {
    let db = store.connect()?;
    store.require_onboarding(&db)?;
    let created: String = db.query_row("SELECT created_at FROM settings WHERE id=1", [], |r| r.get(0))?;
    let org: Option<String> = db.query_row("SELECT organization_id FROM company_local_identity WHERE id=1", [], |r| r.get(0)).optional()?;
    Ok(format!("{:x}", Sha256::digest(format!("{created}\n{}",org.unwrap_or_default()))))
}
