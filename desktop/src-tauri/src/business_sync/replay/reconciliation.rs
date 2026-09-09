//! Prepare a canonical base and replayable local overlay in isolated storage.
//! Installing it and acknowledging journal entries require separate validation.
use super::*;
use std::path::Path;
mod cache;
mod model;
mod native;
pub(crate) mod resolution;
pub(super) use model::Acknowledgement;
pub(super) use native::internal_fingerprint;

pub(super) struct Prepared {
    model: model::Model,
    native: Option<native::Copy>,
    original_local_sha256: String,
    original_internal_sha256: String,
}
impl Prepared {
    pub(super) fn rows(&self) -> &Connection {
        &self.model.connection
    }
    pub(super) fn candidate(&self) -> AppResult<&LocalStore> {
        self.native
            .as_ref()
            .map(|c| &c.store)
            .ok_or_else(|| invalid("Résolvez les conflits avant d’installer cette révision."))
    }
    pub(super) fn verify_live(
        &self,
        c: &Connection,
        store: &LocalStore,
        context: &Context,
    ) -> AppResult<()> {
        check_binding(c, store, context)?;
        if state_fingerprint(c)? != self.model.current_sha256
            || local_fingerprint(c)? != self.original_local_sha256
            || native::internal_fingerprint(c)? != self.original_internal_sha256
        {
            return Err(invalid("Le dossier a changé pendant la préparation. Relancez la fusion pour conserver ces nouvelles écritures."));
        }
        Ok(())
    }
    pub(super) fn verify_candidate(&self, c: &Connection) -> AppResult<()> {
        self.verify_finalized(c, &self.original_internal_sha256)
    }
    pub(super) fn verify_finalized(&self, c: &Connection, internal_sha256: &str) -> AppResult<()> {
        if Some(state_fingerprint(c)?) != self.model.merged_sha256
            || local_fingerprint(c)? != self.original_local_sha256
            || native::internal_fingerprint(c)? != internal_sha256
        {
            return Err(invalid(
                "La copie préparée a changé avant son installation.",
            ));
        }
        Ok(())
    }
    pub(super) fn persist_cache(&self, store: &LocalStore, context: &Context) -> AppResult<()> {
        self.candidate()?;
        cache::write(&self.model, store, context)
    }
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
    crate::business_sync::workspace::cleanup(store)?;
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
    let original_internal_sha256 = native::internal_fingerprint(&source)?;
    // WAL readers retain a coherent cutoff without blocking later local edits.
    // Installation must compare this cutoff again before changing the profile.
    drop(guard);
    let cache = cache::path(
        store,
        &context.generation,
        context.base_revision,
        &context.source_state_sha256,
        false,
    )?;
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
        original_internal_sha256,
    })
}

#[cfg(test)]
mod tests;
