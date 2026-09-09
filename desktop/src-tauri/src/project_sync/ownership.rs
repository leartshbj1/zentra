//! A prepared/shared business history owns project documents. The legacy file
//! feed must never write the same files or manufacture a second local change.
use super::*;
use crate::{account_cloud::ProjectSyncSession, business_sync::cycle};
use rusqlite::{Connection, Transaction};
use std::{future::Future, sync::Arc};

pub(super) fn legacy_allowed(c: &Connection) -> AppResult<()> {
    let owned: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_binding) OR EXISTS(SELECT 1 FROM business_sync_baseline) OR EXISTS(SELECT 1 FROM business_sync_publication_intent)", [], |r| r.get(0))?;
    if owned {
        return Err(AppError::Validation(
            "Les documents sont maintenant gérés avec le dossier partagé de l’entreprise.".into(),
        ));
    }
    Ok(())
}

pub(super) fn business_status(store: &LocalStore, c: &Connection) -> AppResult<Option<Value>> {
    let org: Option<String> = c.query_row("SELECT organization_id FROM business_sync_baseline UNION ALL SELECT organization_id FROM business_sync_binding UNION ALL SELECT organization_id FROM business_sync_publication_intent LIMIT 1", [], |r| r.get(0)).optional()?;
    let Some(org) = org else {
        return Ok(None);
    };
    let ready: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_baseline a JOIN business_sync_binding b ON a.id=b.id WHERE a.organization_id=? AND b.organization_id=a.organization_id AND b.installation_id=? AND b.capture_enabled=1)", params![org,store.installation_id], |r|r.get(0))?;
    let documents = query_all(c, include_str!("business_documents.sql"), params![ready])?;
    let pending = documents
        .iter()
        .filter(|row| row["state"] != "synced")
        .count();
    let last: Option<String> = c.query_row("SELECT MAX(stamp) FROM (SELECT installed_at AS stamp FROM business_sync_baseline UNION ALL SELECT installed_at FROM business_sync_installed_revisions)", [], |r|r.get(0))?;
    Ok(Some(
        json!({"mode":if ready {"business"}else{"preparing"},"organizationId":org,"lastSyncedAt":last,
        "pending":pending,"documents":documents,"syncing":false,"connected":true,"changed":false}),
    ))
}

pub(super) async fn checked_response<F>(
    store: &LocalStore,
    run: &cycle::Run,
    current: impl Fn() -> AppResult<()>,
    request: F,
) -> AppResult<(StatusCode, Vec<u8>)>
where
    F: Future<Output = AppResult<(StatusCode, Vec<u8>)>>,
{
    let check = || {
        run.ensure_running()?;
        current()?;
        if crate::cloud_backup::is_restoring() {
            return Err(AppError::BusinessSyncPaused);
        }
        legacy_allowed(&store.connect()?)
    };
    check()?;
    let response = request.await;
    check()?;
    response
}

pub(super) struct Legacy<'a> {
    pub store: &'a LocalStore,
    pub session: ProjectSyncSession,
    pub run: Arc<cycle::Run>,
}
impl Legacy<'_> {
    pub fn check(&self) -> AppResult<()> {
        self.run.ensure_running()?;
        self.session.ensure_current_for(self.store)?;
        if crate::cloud_backup::is_restoring() {
            return Err(AppError::BusinessSyncPaused);
        }
        legacy_allowed(&self.store.connect()?)
    }
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        headers: &[(&str, String)],
        body: Option<Vec<u8>>,
        file: bool,
    ) -> AppResult<(StatusCode, Vec<u8>)> {
        checked_response(
            self.store,
            &self.run,
            || self.session.ensure_current_for(self.store),
            self.session
                .request(method, path, query, headers, body, file),
        )
        .await
    }
    pub fn write(&self, action: impl FnOnce(&Transaction<'_>) -> AppResult<()>) -> AppResult<()> {
        let _lock = self.store.lock()?;
        self.check()?;
        let mut c = self.store.connect()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        legacy_allowed(&tx)?;
        action(&tx)?;
        self.check()?;
        tx.commit()?;
        Ok(())
    }
    pub fn apply(&self, remote: &RemoteDocument, bytes: Option<&[u8]>) -> AppResult<bool> {
        self.store
            .apply_remote_document_checked(remote, bytes, || self.check())
    }
}

#[cfg(test)]
mod tests;
