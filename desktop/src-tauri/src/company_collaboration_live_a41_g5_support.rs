//! cfg(test, windows) descendant. Actual HTTPS only; never a fabricated PG fact.
use super::super::*;
use super::LivePublication;
use reqwest::StatusCode;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) async fn publish_then_lose_commit(store: &LocalStore, session: &ProjectSyncSession) -> AppResult<LivePublication> {
    let profile = crate::native_test_profile::require().map_err(|_| invalid("G5 admission refused"))?;
    if profile.sha256() != "2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf"
        || session.organization_id != "org_trial_345a3d1f68056cf7e709d4af4fc229a4" || session.role != "owner"
        || std::env::var("ZENTRA_RUN_LIVE_G5_RECIPE").as_deref() != Ok("true") { return Err(invalid("G5 admission refused")); }
    let _transfer = crate::cloud_backup::TransferGuard::take()?;
    let _sync = crate::project_sync::pause_for_workspace_change()?;
    let dropped = AtomicBool::new(false);
    let result = publish_action_engine_quote_with(store, &session.organization_id, &session.role, |packet| {
        let dropped = &dropped;
        async move {
            let commit = packet.method == Method::POST && packet.body.as_deref()
                .map(serde_json::from_slice::<Value>).transpose()?.is_some_and(|v| v["action"] == "commit");
            if !commit { return action_publication_transport(store, session, packet).await; }
            if dropped.load(Ordering::SeqCst) || !packet.query.is_empty() { return Err(invalid("G5 commit refused")); }
            let current = project_sync_session(store).await?.ok_or_else(|| invalid("G5 session refused"))?;
            if current.organization_id != session.organization_id || current.role != session.role { return Err(invalid("G5 session refused")); }
            let pending = load(store)?.pending.ok_or_else(|| invalid("G5 pending refused"))?;
            let body: Value = serde_json::from_slice(packet.body.as_deref().ok_or_else(|| invalid("G5 body refused"))?)?;
            if body.as_object().map(|v| v.len()) != Some(2) || body["id"] != pending.id { return Err(invalid("G5 candidate refused")); }
            // Same native session transport and fresh commit-session check as
            // action_publication_transport; preserve status instead of discarding it.
            let (status, bytes) = current.request(Method::POST, PATH, &[], &[("Content-Type", "application/json".into())], packet.body, false).await?;
            let reply: Value = serde_json::from_slice(&bytes)?;
            if status != StatusCode::OK || reply["committed"] != true || reply["snapshotId"] != pending.id
                || reply["revision"].as_u64() != pending.base_revision.checked_add(1) { return Err(invalid("G5 committed response refused")); }
            dropped.store(true, Ordering::SeqCst);
            Err(invalid("G5 injected response loss"))
        }
    }).await;
    if result.is_ok() || !dropped.load(Ordering::SeqCst) { return Err(invalid("G5 response loss not observed")); }
    let pending = load(store)?.pending.ok_or_else(|| invalid("G5 retained pending refused"))?;
    require_archive_content(&file_path(store, &pending.id)?, &pending.manifest, "G5 retained archive refused")?;
    Ok(LivePublication { snapshot_id: pending.id, base_revision: pending.base_revision,
        revision: pending.base_revision.checked_add(1).ok_or_else(|| invalid("G5 revision refused"))?, manifest: pending.manifest })
}
