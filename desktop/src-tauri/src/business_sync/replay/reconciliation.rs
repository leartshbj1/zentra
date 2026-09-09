//! Prepare a canonical base and replayable local overlay in isolated storage.
//! Installing it and acknowledging journal entries require separate validation.
use super::*;
use std::path::Path;
mod model;
mod native;
pub(super) use model::Acknowledgement;

pub(super) struct Prepared {
    model: model::Model,
    native: Option<native::Copy>,
    original_local_sha256: String,
}
impl Prepared {
    pub(super) fn summary(&self) -> Value {
        serde_json::json!({"state":if self.model.conflict_count>0 {"reconciliation_conflict"} else {"reconciliation_rows_prepared"},
            "pending_changes":self.model.pending_count,"conflict_count":self.model.conflict_count,"conflicts":self.model.conflicts,
            "working_state_sha256":self.model.current_sha256,"canonical_state_sha256":self.model.canonical_sha256,
            "merged_state_sha256":self.model.merged_sha256,"journal_sha256":self.model.journal_sha256,
            "local_state_sha256":self.original_local_sha256,"native_guards_validated":self.native.is_some(),
            "documents_verified":false,"installed":false,"acknowledged":false,"replication_active":false})
    }
}

pub(super) fn prepare(
    store: &LocalStore,
    context: &Context,
    capture: &str,
    acknowledgement: Option<&Acknowledgement>,
    remote: impl IntoIterator<Item = AppResult<RowChange>>,
    ensure_current: impl Fn() -> AppResult<()>,
) -> AppResult<Prepared> {
    let guard = store.lock()?;
    ensure_current()?;
    let mut connection = store.connect()?;
    let source = connection.transaction()?;
    check_binding(&source, store, context)?;
    let bound:bool=source.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_binding WHERE id=1 AND generation=?1) AND NOT EXISTS(SELECT 1 FROM business_sync_publication_intent)",[capture],|r|r.get(0))?;
    if !bound || uuid::Uuid::parse_str(&context.generation).is_err() {
        return Err(invalid("La référence locale a changé."));
    }
    let original_local_sha256 = local_fingerprint(&source)?;
    // WAL readers retain a coherent cutoff without blocking later local edits.
    // Installation must compare this cutoff again before changing the profile.
    drop(guard);
    let cache_root = store.data_dir.join("business-canonical");
    let cache_generation = cache_root.join(&context.generation);
    let cache = cache_generation.join(format!(
        "{}-{}.sqlite",
        context.base_revision, context.source_state_sha256
    ));
    for dir in [&cache_root, &cache_generation] {
        if dir.try_exists()? && !crate::business_sync::snapshot::regular_metadata(dir)?.is_dir() {
            return Err(invalid("Le cache canonique est invalide."));
        }
    }
    let exists = cache.try_exists()?;
    let model = model::prepare(
        store,
        &source,
        context,
        capture,
        exists.then_some(cache.as_path()),
        acknowledgement,
        remote,
    )?;
    ensure_current()?;
    let native = if model.conflict_count == 0 {
        Some(native::build(
            store,
            &source,
            context,
            &model,
            &original_local_sha256,
        )?)
    } else {
        None
    };
    ensure_current()?;
    Ok(Prepared {
        model,
        native,
        original_local_sha256,
    })
}

#[cfg(test)]
mod tests;
