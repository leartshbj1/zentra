//! Only the ignored A41 continuation test can reach this boundary. It uses the
//! real provider/HTTPS/writer/publication; an old source can never be prepared.
use super::*;
const HISTORICAL_SOURCE: &str = "6876287b-2ad0-486a-85df-95610f2d2a6d";

pub(crate) struct NewSourceResult {
    pub(crate) prepared: protocol::QuoteWorkPrepared,
    pub(crate) confirmed: bool,
}

pub(crate) async fn prepare_and_execute_new_source(store: &LocalStore, source: &str) -> AppResult<NewSourceResult> {
    let profile = crate::native_test_profile::require().map_err(|_| review())?;
    if profile.sha256() != "2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf"
        || profile.site_origin() != "https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site"
        || std::env::var("ZENTRA_RUN_LIVE_G4_CONTINUATION").as_deref() != Ok("true")
        || source == HISTORICAL_SOURCE || !id(source) { return Err(review()); }
    let original = capture(store).await?;
    if original.user_id != "1f0d9981-607b-4848-9374-587035cdfd89"
        || original.inbox.session.organization_id != "org_trial_345a3d1f68056cf7e709d4af4fc229a4"
        || original.role != "owner" { return Err(changed()); }
    publication_phase(store, &original, None).await?;
    check(store, &original).await?;
    let pending = recovery_work(store, &original).await?;
    check(store, &original).await?;
    // This scenario starts from two newly received stores. An unexpected local
    // pending is a refusal, never permission to discard/replan old work.
    if !pending.selections.is_empty() || pending.has_more { return Err(review()); }
    let bytes = exchange_with(store, &original, protocol::preparation_request(source)?, work_request).await?;
    let prepared = protocol::parse_preparation_response(&bytes, source)?;
    check(store, &original).await?;
    if prepared.disposition == protocol::QuoteWorkDisposition::NeedsReview {
        return Ok(NewSourceResult { prepared, confirmed: false });
    }
    let selected = QuoteExecutionSelection { source_id: prepared.source_id.clone(), proposal_id: prepared.proposal_id.clone() };
    let body = protocol::reserve_request(&selected)?;
    let result = execute_quote_draft_at(store, &original, selected, body, Some(&prepared.fingerprint)).await;
    check(store, &original).await?;
    Ok(NewSourceResult { prepared, confirmed: matches!(result?, QuoteExecutionOutcome::Confirmed(_)) })
}
