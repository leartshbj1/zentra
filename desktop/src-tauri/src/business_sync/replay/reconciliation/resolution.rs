//! Review and validate conflict decisions against a freshly authenticated
//! revision. This produces disposable previews, never an installable Prepared.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Choice {
    Local,
    Shared,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Decision {
    pub transaction_id: String,
    pub choice: Choice,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub review_id: String,
    pub decisions: Vec<Decision>,
    pub after_sequence: Option<String>,
}

#[derive(Serialize)]
pub(in crate::business_sync::replay) struct DocumentReview {
    pub final_count: usize,
    pub files_to_replace: usize,
    pub total_size_bytes: u64,
    pub plan_sha256: String,
}

pub(in crate::business_sync::replay) struct Scope<'a> {
    pub store: &'a LocalStore,
    pub context: &'a Context,
    pub capture: &'a str,
    pub receipt_sha256: &'a str,
    pub role: &'a str,
    pub account_binding: &'a str,
    pub acknowledgement: Option<&'a Acknowledgement>,
}

fn review_id(prepared: &Prepared, scope: &Scope<'_>) -> AppResult<String> {
    let Scope {
        store,
        context,
        capture,
        receipt_sha256,
        role,
        account_binding,
        ..
    } = scope;
    if [receipt_sha256, account_binding].iter().any(|value| {
        value.len() != 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err(invalid("La référence du reçu à comparer est invalide."));
    }
    let mut hash = Sha256::new();
    hash.update(b"zentra-business-conflict-review-v1\0");
    for value in [
        context.organization.as_str(),
        store.installation_id.as_str(),
        capture,
        context.generation.as_str(),
        &context.base_revision.to_string(),
        context.source_state_sha256.as_str(),
        context.target_state_sha256.as_str(),
        prepared.model.current_sha256.as_str(),
        prepared.model.journal_sha256.as_str(),
        prepared.original_local_sha256.as_str(),
        prepared.original_internal_sha256.as_str(),
        receipt_sha256,
        role,
        account_binding,
    ] {
        frame(&mut hash, value.as_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn page_cursor(value: Option<&str>) -> AppResult<i64> {
    match value {
        None => Ok(0),
        Some(value) => value
            .parse::<i64>()
            .ok()
            .filter(|n| *n > 0 && n.to_string() == value)
            .ok_or_else(|| invalid("La page de comparaison est invalide.")),
    }
}

// Comparison pages contain only explicitly requested row details. Bound both
// the page and individual cells so long notes cannot freeze the interface.
fn display_image(raw: Option<String>) -> AppResult<Value> {
    let Some(raw) = raw else {
        return Ok(Value::Null);
    };
    let value: Value = serde_json::from_str(&raw)?;
    let mut clipped = false;
    let fields = value
        .as_object()
        .ok_or_else(|| invalid("Une ligne à comparer est illisible."))?
        .iter()
        .map(|(key, value)| {
            let value = if let Some(text) = value.as_str() {
                let shortened: String = text.chars().take(2_000).collect();
                let truncated = shortened.len() < text.len();
                clipped |= truncated;
                serde_json::json!({"value":shortened,"truncated":truncated,"exact_integer":false})
            } else if value.as_i64().is_some_and(|n| !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n))
                || value.as_u64().is_some_and(|n| n > 9_007_199_254_740_991)
            {
                serde_json::json!({"value":value.to_string(),"truncated":false,"exact_integer":true})
            } else {
                serde_json::json!({"value":value,"truncated":false,"exact_integer":false})
            };
            (key.clone(), value)
        })
        .collect::<serde_json::Map<_, _>>();
    Ok(serde_json::json!({"fields":fields,"truncated":clipped}))
}

fn review(prepared: &Prepared, review_id: &str, after_sequence: Option<&str>) -> AppResult<Value> {
    let after = page_cursor(after_sequence)?;
    let c = &prepared.model.connection;
    let mut query = c.prepare("SELECT p.transaction_id,MIN(p.sequence),MAX(p.sequence),COUNT(*),f.sequence,f.table_name,f.row_key_json,f.expected_json,f.current_json,f.incoming_json FROM pending_changes p LEFT JOIN conflicting_transactions f ON f.transaction_id=p.transaction_id GROUP BY p.transaction_id HAVING MIN(p.sequence)>?1 ORDER BY MIN(p.sequence) LIMIT 5")?;
    let mut rows = query.query([after])?;
    let mut transactions = vec![];
    let mut next = None;
    while let Some(row) = rows.next()? {
        if transactions.len() == 4 {
            next = transactions
                .last()
                .and_then(|v: &Value| v["first_sequence"].as_str())
                .map(str::to_owned);
            break;
        }
        let id: String = row.get(0)?;
        let tables = c.prepare("SELECT table_name,COUNT(*) FROM pending_changes WHERE transaction_id=?1 GROUP BY table_name ORDER BY table_name")?
            .query_map([&id], |r| Ok(serde_json::json!({"table":r.get::<_,String>(0)?,"change_count":r.get::<_,i64>(1)?})))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let conflict = if let Some(sequence) = row.get::<_, Option<i64>>(4)? {
            serde_json::json!({"sequence":sequence.to_string(),"table":row.get::<_,String>(5)?,"key_json":row.get::<_,String>(6)?,
                "base":display_image(row.get(7)?)?,"shared":display_image(row.get(8)?)?,"local":display_image(row.get(9)?)?})
        } else {
            Value::Null
        };
        transactions.push(serde_json::json!({"transaction_id":id,"first_sequence":row.get::<_,i64>(1)?.to_string(),"last_sequence":row.get::<_,i64>(2)?.to_string(),"change_count":row.get::<_,i64>(3)?,"tables":tables,"conflict":conflict}));
    }
    Ok(
        serde_json::json!({"state":"conflict_review","review_id":review_id,"conflict_count":prepared.model.conflict_count,
        "pending_changes":prepared.model.pending_count,"transactions":transactions,"next_after_sequence":next,
        "decision_scope":"whole_transaction","installed":false,"acknowledged":false,"replication_active":false}),
    )
}

pub(in crate::business_sync::replay) fn inspect(
    prepared: &Prepared,
    scope: &Scope<'_>,
    after_sequence: Option<&str>,
    expected_review: Option<&str>,
) -> AppResult<Value> {
    let current = review_id(prepared, scope)?;
    if (after_sequence.is_some() && expected_review.is_none())
        || expected_review.is_some_and(|expected| expected != current)
    {
        return Err(invalid(
            "La comparaison a changé. Actualisez-la avant de consulter la page suivante.",
        ));
    }
    let mut result = review(prepared, &current, after_sequence)?;
    result["organization_id"] = serde_json::json!(scope.context.organization);
    result["revision"] = serde_json::json!(scope.context.base_revision + 1);
    result["receipt_sha256"] = serde_json::json!(scope.receipt_sha256);
    result["confirmed_transaction_id"] =
        serde_json::json!(scope.acknowledgement.map(|a| a.transaction_id.as_str()));
    Ok(result)
}

fn choices(request: Request, expected_review: &str) -> AppResult<BTreeMap<String, Choice>> {
    if request.review_id != expected_review {
        return Err(invalid(
            "Le dossier ou la révision a changé. Actualisez la comparaison avant de choisir.",
        ));
    }
    if request.decisions.is_empty() || request.decisions.len() > MAX_ROWS {
        return Err(invalid("Choisissez les opérations à rapprocher."));
    }
    let mut result = BTreeMap::new();
    for decision in request.decisions {
        if result
            .insert(decision.transaction_id, decision.choice)
            .is_some()
        {
            return Err(invalid(
                "Une opération ne peut pas recevoir deux choix différents.",
            ));
        }
    }
    Ok(result)
}

pub(in crate::business_sync::replay) fn preview(
    prepared: &Prepared,
    scope: &Scope<'_>,
    request: Request,
    ensure_current: impl Fn() -> AppResult<()>,
    documents: impl FnOnce(&Prepared) -> AppResult<DocumentReview>,
) -> AppResult<Value> {
    preview_impl(prepared, scope, request, ensure_current, |candidate| {
        documents(candidate).map(Some)
    })
}

fn preview_impl(
    prepared: &Prepared,
    scope: &Scope<'_>,
    request: Request,
    ensure_current: impl Fn() -> AppResult<()>,
    documents: impl FnOnce(&Prepared) -> AppResult<Option<DocumentReview>>,
) -> AppResult<Value> {
    if !matches!(scope.role, "owner" | "admin" | "member" | "accountant") {
        return Err(invalid("Votre accès permet de consulter les modifications, mais pas de préparer leur résolution."));
    }
    let expected_review = review_id(prepared, scope)?;
    let after_sequence = request.after_sequence.clone();
    page_cursor(after_sequence.as_deref())?;
    let decisions = choices(request, &expected_review)?;
    let mut decision_hash = Sha256::new();
    decision_hash.update(b"zentra-business-conflict-decisions-v1\0");
    frame(&mut decision_hash, expected_review.as_bytes());
    frame(&mut decision_hash, &serde_json::to_vec(&decisions)?);

    let guard = scope.store.lock()?;
    ensure_current()?;
    let mut connection = scope.store.connect()?;
    let source = connection.transaction()?;
    prepared.verify_live(&source, scope.store, scope.context)?;
    drop(guard);
    let path = cache::path(
        scope.store,
        &scope.context.generation,
        scope.context.base_revision,
        &scope.context.source_state_sha256,
        false,
    )?;
    let exists = path.try_exists()?;
    let mut remote = prepared.model.connection.prepare("SELECT table_name,row_key_json,canonical_rowid,before_json,after_json FROM remote_changes ORDER BY position")?;
    let changes = remote
        .query_map([], |r| {
            Ok(RowChange {
                table: r.get(0)?,
                key_json: r.get(1)?,
                canonical_rowid: r.get(2)?,
                before_json: r.get(3)?,
                after_json: r.get(4)?,
            })
        })?
        .map(|r| r.map_err(Into::into));
    let model = model::prepare_with_choices(
        scope.store,
        &source,
        scope.context,
        scope.capture,
        exists.then_some(path.as_path()),
        scope.acknowledgement,
        changes,
        Some(&decisions),
    )?;
    ensure_current()?;
    let native = if model.conflict_count == 0 {
        Some(native::build(
            scope.store,
            &source,
            scope.context,
            &model,
            &prepared.original_local_sha256,
        )?)
    } else {
        None
    };
    let preview = Prepared {
        model,
        native,
        original_local_sha256: prepared.original_local_sha256.clone(),
        original_internal_sha256: prepared.original_internal_sha256.clone(),
    };
    let mut result = inspect(
        &preview,
        scope,
        after_sequence.as_deref(),
        Some(&expected_review),
    )?;
    let documents = if preview.native.is_some() {
        ensure_current()?;
        documents(&preview)?
    } else {
        None
    };
    if let Some(documents) = &documents {
        frame(&mut decision_hash, documents.plan_sha256.as_bytes());
    }
    result["state"] = serde_json::json!(if preview.native.is_some() {
        "resolution_preview"
    } else {
        "resolution_needs_review"
    });
    result["native_guards_validated"] = serde_json::json!(preview.native.is_some());
    result["proposed_state_sha256"] = serde_json::json!(preview.model.merged_sha256);
    result["decision_sha256"] = serde_json::json!(format!("{:x}", decision_hash.finalize()));
    result["decisions"] = serde_json::to_value(&decisions)?;
    // This separate API deliberately cannot pass its candidate to the ordinary
    // installer: resolved changes require their own durable original-to-new
    // transaction mapping and server acknowledgement lifecycle.
    result["can_install"] = serde_json::json!(false);
    result["documents_verified"] = serde_json::json!(documents.is_some());
    result["documents"] = serde_json::to_value(documents)?;
    drop(source);
    let _guard = scope.store.lock()?;
    ensure_current()?;
    prepared.verify_live(&scope.store.connect()?, scope.store, scope.context)?;
    Ok(result)
}

#[cfg(test)]
mod tests;
