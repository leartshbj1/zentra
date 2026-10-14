//! TEST-ONLY Windows child of company_collaboration for the isolated A41 recipe.
//! A50/91a and b502 do not compile or prove this subsequent G4 work.
//! No substitute transport, server fact, licence or local publication metadata.
use super::*;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LivePublication {
    pub(crate) snapshot_id: String,
    pub(crate) base_revision: u64,
    pub(crate) revision: u64,
    pub(crate) manifest: crate::cloud_backup::Manifest,
}

impl LivePublication {
    pub(crate) fn public_proof(&self) -> AppResult<Value> {
        Ok(json!({"snapshotId":self.snapshot_id,"baseRevision":self.base_revision,
            "revision":self.revision,"archiveSha256":self.manifest.sha256,
            "manifestSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&self.manifest)?)),
            "sizeBytes":self.manifest.size_bytes,"transport":"content-v1",
            "gatewayPgFactAndD1Committed":true}))
    }
}

fn refuse() -> AppError { invalid("Recette native G4 A41 refusée.") }

async fn session(store: &LocalStore) -> AppResult<ProjectSyncSession> {
    let session = project_sync_session(store).await?.ok_or_else(refuse)?;
    if session.organization_id != "org_trial_345a3d1f68056cf7e709d4af4fc229a4" || session.role != "owner" {
        return Err(refuse());
    }
    Ok(session)
}

fn check_reference(store: &LocalStore, expected: &LivePublication) -> AppResult<()> {
    let prefs = load(store)?;
    if prefs.revision != expected.revision || prefs.pending.is_some() || prefs.received.is_some()
        || prefs.conflict || prefs.base_clock != clock(store)? {
        return Err(refuse());
    }
    // The ordinary sender/receiver created this reference from the actual ZIP.
    let reference = store.data_dir.join("company-sync-reference.zentra");
    require_archive_content(&reference, &expected.manifest, "Recette native G4 A41 refusée.")
}

fn head_matches(session: &ProjectSyncSession, head: &Value, expected: &LivePublication) -> AppResult<()> {
    let manifest: crate::cloud_backup::Manifest = serde_json::from_value(head["manifest"].clone())?;
    if checked_head(session, head)? != expected.revision || head["enabled"] != true
        || head["snapshotId"] != expected.snapshot_id || head["contentVersion"] != 1
        || manifest != expected.manifest || expected.revision != expected.base_revision.checked_add(1).ok_or_else(refuse)? {
        return Err(refuse());
    }
    Ok(())
}

fn fresh_head(session: &ProjectSyncSession, head: &Value) -> AppResult<()> {
    if checked_head(session, head)? != 0 || head["enabled"] != false || head["contentTransfer"] != 1
        || head["contentVersion"] != 0 || !head.get("snapshotId").is_some_and(Value::is_null)
        || !head.get("manifest").is_some_and(Value::is_null) { return Err(refuse()); }
    Ok(())
}

/// Audit the actual remote head before creating even the fictitious client.
/// publish_initial repeats this check at its own prepare boundary.
pub(crate) async fn require_fresh_remote(store: &LocalStore) -> AppResult<()> {
    let _account = store.account_protected_cache.operation_lock.lock().await;
    let session = session(store).await?;
    fresh_head(&session, &request(&session, Method::GET, &[], None).await?)
}

/// Requires the WRITER installation: recovery binds the actor, installation,
/// original base, manifest and exact snapshot. A current head alone is not proof.
pub(crate) async fn corroborate_writer(store: &LocalStore, expected: &LivePublication) -> AppResult<()> {
    let session = session(store).await?;
    let head = request(&session, Method::GET, &[], None).await?;
    head_matches(&session, &head, expected)?;
    let reply = request(&session, Method::POST, &[], Some(json!({"action":"recover-publication",
        "id":expected.snapshot_id,"baseRevision":expected.base_revision,"manifest":expected.manifest}))).await?;
    // This real gateway reads/verifies the historical PG operation and the D1
    // attempt; unknown/pending, legacy-only ACK, denial and outage all refuse.
    if reply.as_object().map(|fields| fields.len()) != Some(4) || reply["known"] != true
        || reply["committed"] != true || reply["revision"] != expected.revision
        || reply["snapshotId"] != expected.snapshot_id { return Err(refuse()); }
    check_reference(store, expected)
}

/// Same prepare/upload/commit functions as enable_company_sync, without an IPC
/// command or Tauri State. Only an actually empty remote head may be initialized.
pub(crate) async fn publish_initial(store: &LocalStore) -> AppResult<LivePublication> {
    let _account = store.account_protected_cache.operation_lock.lock().await;
    let _transfer = crate::cloud_backup::TransferGuard::take()?;
    let _sync = crate::project_sync::pause_for_workspace_change()?;
    let session = session(store).await?;
    let head = request(&session, Method::GET, &[], None).await?;
    let prefs = load(store)?;
    fresh_head(&session, &head)?;
    if prefs.revision != 0 || prefs.pending.is_some() || prefs.received.is_some() || prefs.conflict
        || !store.app_state(env!("CARGO_PKG_VERSION"))?.onboarding_completed { return Err(refuse()); }
    store.require_write_access()?;
    let (prepared, _) = prepare_for_send_worker(store, &session.organization_id, true).await?;
    if prepared.base_revision != 0 { return Err(refuse()); }
    if !send(store, &session, true, true).await? { return Err(refuse()); }
    crate::shared_numbering::replenish_active_series(store, &session).await?;
    let expected = LivePublication { snapshot_id:prepared.id, base_revision:prepared.base_revision,
        revision:1, manifest:prepared.manifest };
    corroborate_writer(store, &expected).await?;
    Ok(expected)
}

/// Extract the actual ACK's retained publication, never a new manifest or a
/// snapshot guessed from the current head. The activity reader separately
/// verifies the receipt/candidate/confirmation/outbox atomic relation.
pub(crate) fn acknowledged_publication(store: &LocalStore, proposal: &str) -> AppResult<LivePublication> {
    let _local = store.lock()?;
    let db = store.connect()?;
    let rows = query_all(&db, "SELECT p.snapshot_id,p.base_revision,p.published_revision,p.manifest_json
        FROM company_local_action_engine_quote_publications p
        JOIN company_local_action_engine_quote_confirmations c
          ON c.organization_id=p.organization_id AND c.proposal_id=p.proposal_id AND c.snapshot_id=p.snapshot_id
        WHERE p.organization_id=? AND p.proposal_id=? LIMIT 2",
        params!["org_trial_345a3d1f68056cf7e709d4af4fc229a4",proposal])?;
    if rows.len() != 1 { return Err(refuse()); }
    let row = &rows[0];
    Ok(LivePublication { snapshot_id:row["snapshot_id"].as_str().ok_or_else(refuse)?.into(),
        base_revision:row["base_revision"].as_u64().ok_or_else(refuse)?,
        revision:row["published_revision"].as_u64().ok_or_else(refuse)?,
        manifest:serde_json::from_str(row["manifest_json"].as_str().ok_or_else(refuse)?)? })
}

/// Real second-device download, archive verification and ordinary guarded apply.
/// Writer-private markers are not copied into a fake ACK on this installation.
pub(crate) async fn receive_exact(store: &LocalStore, expected: &LivePublication, joining: bool) -> AppResult<()> {
    let _account = store.account_protected_cache.operation_lock.lock().await;
    let _transfer = crate::cloud_backup::TransferGuard::take()?;
    let _sync = crate::project_sync::pause_for_workspace_change()?;
    let session = session(store).await?;
    let head = request(&session, Method::GET, &[], None).await?;
    head_matches(&session, &head, expected)?;
    let prefs = load(store)?;
    if prefs.pending.is_some() || prefs.received.is_some() || prefs.conflict { return Err(refuse()); }
    if joining { crate::cloud_backup::require_empty_company(store)?; }
    else if prefs.base_clock != clock(store)? || prefs.revision >= expected.revision { return Err(refuse()); }
    let expected_clock = clock(store)?;
    let path = download(store, &session, &head).await?;
    let owned = store.clone();
    let organization = session.organization_id;
    let revision = expected.revision;
    tauri::async_runtime::spawn_blocking(move || apply(&owned, &path, &organization, revision, expected_clock, joining, false))
        .await.map_err(|_| refuse())??;
    check_reference(store, expected)
}
