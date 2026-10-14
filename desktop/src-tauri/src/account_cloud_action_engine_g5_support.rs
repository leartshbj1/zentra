//! Test-only staged composition of the unchanged private consumer primitives.
use super::super::*;
use crate::company_collaboration::live_a41_g4_support::{self as collaboration, LivePublication};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Selected { pub(crate) source_id: String, pub(crate) proposal_id: String, pub(crate) fingerprint: String }
fn selected(value: &Selected) -> AppResult<QuoteExecutionSelection> {
    if value.source_id == "6876287b-2ad0-486a-85df-95610f2d2a6d" || value.proposal_id == "c668fb83-9262-4809-8724-af6638f813e5"
        || !id(&value.source_id) || !id(&value.proposal_id) || value.fingerprint.len() != 64
        || !value.fingerprint.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(review()); }
    Ok(QuoteExecutionSelection { source_id: value.source_id.clone(), proposal_id: value.proposal_id.clone() })
}
async fn origin(store: &LocalStore) -> AppResult<ActionStamp> {
    let profile = crate::native_test_profile::require().map_err(|_| review())?;
    if profile.sha256() != "2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf"
        || profile.site_origin() != "https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site"
        || std::env::var("ZENTRA_RUN_LIVE_G5_RECIPE").as_deref() != Ok("true") { return Err(review()); }
    let stamp = capture(store).await?;
    if stamp.user_id != "1f0d9981-607b-4848-9374-587035cdfd89" || stamp.role != "owner"
        || stamp.inbox.session.organization_id != "org_trial_345a3d1f68056cf7e709d4af4fc229a4" { return Err(changed()); }
    Ok(stamp)
}
pub(crate) async fn prepare_and_write_once(store: &LocalStore, source: &str) -> AppResult<protocol::QuoteWorkPrepared> {
    if source == "6876287b-2ad0-486a-85df-95610f2d2a6d" || !id(source) { return Err(review()); }
    let original = origin(store).await?;
    publication_phase(store, &original, None).await?;
    let pending = recovery_work(store, &original).await?;
    check(store, &original).await?;
    if !pending.selections.is_empty() || pending.has_more { return Err(review()); }
    let bytes = exchange_with(store, &original, protocol::preparation_request(source)?, work_request).await?;
    let prepared = protocol::parse_preparation_response(&bytes, source)?;
    check(store, &original).await?;
    if prepared.disposition == protocol::QuoteWorkDisposition::NeedsReview { return Ok(prepared); }
    let selected = selected(&Selected { source_id: prepared.source_id.clone(), proposal_id: prepared.proposal_id.clone(), fingerprint: prepared.fingerprint.clone() })?;
    let bytes = exchange_with(store, &original, protocol::reserve_request(&selected)?, request).await?;
    let ReservationResponse::Reserved(reserved) = protocol::parse_reservation_response(&bytes, &selected)? else { return Err(review()); };
    if reserved.fingerprint != prepared.fingerprint || reserved.actor.organization_id != original.inbox.session.organization_id
        || reserved.actor.user_id != original.user_id || reserved.installation_id != original.installation_id { return Err(changed()); }
    let input = reserved.into_input(original.inbox.workspace_scope.clone(), original.member_nonce.clone())?;
    local_effect(store, &original, move |store, _| store.commit_action_engine_quote_draft_after_recovery(input)).await?;
    check(store, &original).await?;
    Ok(prepared)
}
async fn only_pending(store: &LocalStore, original: &ActionStamp, expected: &Selected) -> AppResult<ActionEngineQuoteRecoverySelection> {
    selected(expected)?;
    let work = recovery_work(store, original).await?;
    check(store, original).await?;
    if work.has_more || work.selections.len() != 1 { return Err(review()); }
    let value = &work.selections[0];
    if value.source_id != expected.source_id || value.proposal_id != expected.proposal_id || value.fingerprint != expected.fingerprint { return Err(review()); }
    Ok(recovery(original, &selected(expected)?, value.reservation_id.clone(), value.fingerprint.clone()))
}
pub(crate) async fn publish_and_lose_commit(store: &LocalStore, expected: &Selected) -> AppResult<LivePublication> {
    let original = origin(store).await?;
    let selection = only_pending(store, &original, expected).await?;
    if !candidates(store, &original, selection).await?.candidates.is_empty() { return Err(review()); }
    let account = store.account_protected_cache.operation_lock.clone().lock_owned().await;
    let owned = store.clone();
    let result = tauri::async_runtime::spawn(async move {
        let _account = account;
        let checked = owned.clone(); let before = original.clone();
        tauri::async_runtime::spawn_blocking(move || { let _local = checked.lock()?; require_stamp(&checked, &before) }).await.map_err(|_| review())??;
        let result = collaboration::g5::publish_then_lose_commit(&owned, &session(&original)).await;
        let checked = owned.clone();
        tauri::async_runtime::spawn_blocking(move || { let _local = checked.lock()?; require_stamp(&checked, &original) }).await.map_err(|_| review())??;
        result
    }).await.map_err(|_| review())?;
    result
}
pub(crate) async fn recover_and_lose_confirmation(store: &LocalStore, expected: &Selected) -> AppResult<LivePublication> {
    let original = origin(store).await?;
    let selection = only_pending(store, &original, expected).await?;
    publication_phase(store, &original, None).await?;
    let publications = candidates(store, &original, selection.clone()).await?;
    if publications.candidates.len() != 1 || publications.canonical_snapshot_id.is_some() { return Err(review()); }
    let candidate = &publications.candidates[0];
    let revision = candidate.published_revision.ok_or_else(review)?;
    let snapshot = candidate.snapshot_id.clone();
    let selected = selected(expected)?;
    let body = protocol::confirmation_request(&selected, &selection.reservation_id, &snapshot)?;
    let bytes = exchange_with(store, &original, body, |session, body| async move {
        let response = request(session, body).await?;
        if response.0 != StatusCode::OK { return Err(review()); }
        Ok(response)
    }).await?;
    let confirmation = protocol::parse_confirmation_response(&bytes, &selected, &selection.reservation_id, &snapshot)?;
    if confirmation.receipt.fingerprint != expected.fingerprint { return Err(review()); }
    // Deliberately DO NOT call acknowledge. The genuine successful response is
    // discarded; the parent kills this process after the durable checkpoint.
    check(store, &original).await?;
    Ok(LivePublication { snapshot_id: snapshot, base_revision: candidate.base_revision,
        revision, manifest: candidate.manifest.clone() })
}
pub(crate) async fn resume_exact_and_ack(store: &LocalStore, expected: &Selected) -> AppResult<()> {
    let original = origin(store).await?;
    only_pending(store, &original, expected).await?;
    let selected = selected(expected)?;
    let body = protocol::reserve_request(&selected)?;
    if !matches!(execute_quote_draft_at(store, &original, selected, body, Some(&expected.fingerprint)).await?, QuoteExecutionOutcome::Confirmed(_)) { return Err(review()); }
    check(store, &original).await
}
