//! Bounded inspection of every captured row, including cascade/audit rows after
//! the first conflict. Images are original event before/after and received
//! canonical state, never a claim that a proposed replacement is installed.
use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RowsRequest {
    pub review_id: String,
    pub local_transaction_id: String,
    pub after_sequence: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Image {
    Base,
    Local,
    Shared,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TextRequest {
    pub review_id: String,
    pub local_transaction_id: String,
    pub sequence: String,
    pub image: Image,
    pub field: String,
    pub offset: usize,
}

fn check(
    prepared: &Prepared,
    scope: &Scope<'_>,
    expected: &str,
    transaction: &str,
) -> AppResult<()> {
    if review_id(prepared, scope)? != expected {
        return Err(invalid(
            "La comparaison a changé. Actualisez-la avant de continuer.",
        ));
    }
    if !prepared.model.connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pending_changes WHERE transaction_id=?1)",
        [transaction],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(invalid(
            "Cette opération n’appartient pas à la comparaison.",
        ));
    }
    Ok(())
}

pub(in crate::business_sync::replay) fn rows(
    prepared: &Prepared,
    scope: &Scope<'_>,
    request: RowsRequest,
) -> AppResult<Value> {
    check(
        prepared,
        scope,
        &request.review_id,
        &request.local_transaction_id,
    )?;
    let after = page_cursor(request.after_sequence.as_deref())?;
    let c = &prepared.model.connection;
    if after > 0
        && !c.query_row(
            "SELECT EXISTS(SELECT 1 FROM pending_changes WHERE transaction_id=?1 AND sequence=?2)",
            params![request.local_transaction_id, after],
            |r| r.get::<_, bool>(0),
        )?
    {
        return Err(invalid(
            "La page demandée n’appartient pas à cette opération.",
        ));
    }
    let total: i64 = c.query_row(
        "SELECT COUNT(*) FROM pending_changes WHERE transaction_id=?1",
        [&request.local_transaction_id],
        |r| r.get(0),
    )?;
    let mut query = c.prepare("SELECT p.sequence,p.table_name,p.row_key_json,p.before_json,p.after_json,s.row_json,EXISTS(SELECT 1 FROM conflicting_transactions f WHERE f.transaction_id=p.transaction_id AND f.sequence=p.sequence) FROM pending_changes p LEFT JOIN canonical_rows s ON s.table_name=p.table_name AND s.row_key_json=p.row_key_json WHERE p.transaction_id=?1 AND p.sequence>?2 ORDER BY p.sequence LIMIT 4")?;
    let mut cursor = query.query(params![request.local_transaction_id, after])?;
    let mut changes = Vec::new();
    let mut next: Option<String> = None;
    while let Some(row) = cursor.next()? {
        if changes.len() == 3 {
            next = changes
                .last()
                .and_then(|v: &Value| v["sequence"].as_str())
                .map(str::to_owned);
            break;
        }
        let before: Option<String> = row.get(3)?;
        let after: Option<String> = row.get(4)?;
        let operation = if before.is_none() {
            "insert"
        } else if after.is_none() {
            "delete"
        } else {
            "update"
        };
        changes.push(serde_json::json!({
            "sequence": row.get::<_, i64>(0)?.to_string(), "table":row.get::<_,String>(1)?,
            "key_json":row.get::<_,String>(2)?, "operation":operation,
            "base":display_image(before)?, "local":display_image(after)?, "shared":display_image(row.get(5)?)?,
            "first_conflict":row.get::<_,bool>(6)?,
        }));
    }
    Ok(
        serde_json::json!({"state":"conflict_changes","review_id":request.review_id,
        "local_transaction_id":request.local_transaction_id,"change_count":total,
        "changes":changes,"next_after_sequence":next,"shared_image_scope":"received_revision"}),
    )
}

pub(in crate::business_sync::replay) fn text(
    prepared: &Prepared,
    scope: &Scope<'_>,
    request: TextRequest,
) -> AppResult<Value> {
    check(
        prepared,
        scope,
        &request.review_id,
        &request.local_transaction_id,
    )?;
    let sequence = page_cursor(Some(&request.sequence))?;
    let column = match request.image {
        Image::Base => "p.before_json",
        Image::Local => "p.after_json",
        Image::Shared => "s.row_json",
    };
    let raw = prepared.model.connection.query_row(
        &format!("SELECT {column} FROM pending_changes p LEFT JOIN canonical_rows s ON s.table_name=p.table_name AND s.row_key_json=p.row_key_json WHERE p.transaction_id=?1 AND p.sequence=?2"),
        params![request.local_transaction_id, sequence], |r| r.get::<_,Option<String>>(0),
    ).optional()?.flatten().ok_or_else(|| invalid("Cette version de la ligne est absente."))?;
    let value: Value = serde_json::from_str(&raw)?;
    let text = value
        .get(&request.field)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Le texte demandé n’existe pas dans cette ligne."))?;
    let length = text.chars().count();
    if request.offset > length {
        return Err(invalid(
            "La position demandée dépasse la longueur du texte.",
        ));
    }
    let content: String = text.chars().skip(request.offset).take(8_000).collect();
    let end = request.offset + content.chars().count();
    Ok(
        serde_json::json!({"state":"conflict_text","review_id":request.review_id,
        "local_transaction_id":request.local_transaction_id,"sequence":request.sequence,
        "text":content,"offset":request.offset,"total_characters":length,
        "next_offset":if end < length { Some(end) } else { None }}),
    )
}
