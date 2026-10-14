//! Authenticated consumer, with a separately gated product IPC supervisor.
//! Real A8/A7 transport, writer and collaboration helpers; no AI/model input is
//! accepted here. Native compilation and staging remain required before use.
use super::*;
use crate::action_engine_device_protocol::{
    self as protocol, QuoteExecutionSelection, ReservationResponse,
};
use crate::action_engine_quote::{
    ActionEngineQuoteActor, ActionEngineQuoteReceipt, ActionEngineQuoteRecoverySelection,
};
use crate::action_engine_quote_publication::{
    ActionEngineQuoteConfirmation, ActionEngineQuotePublicationRecovery,
    ActionEngineQuoteRecoveryOrigin,
};
use rusqlite::OptionalExtension;
use std::collections::HashSet;

#[path = "account_cloud_quote_autopilot.rs"]
pub(crate) mod supervisor;

// Deliberately neither Debug nor Serialize: account tokens/references and local
// workspace identities must never escape through IPC or diagnostic logging.
#[derive(Clone, PartialEq, Eq)]
struct ActionStamp {
    inbox: InboxReadStamp,
    user_id: String,
    role: String,
    installation_id: String,
    member_nonce: String,
}

#[derive(Debug)]
pub(crate) enum QuoteExecutionOutcome {
    Held,
    Confirmed(ActionEngineQuoteReceipt),
}

fn changed() -> AppError {
    AppError::Validation(
        "Le compte ou l’entreprise a changé. Le devis reste dans son espace d’origine.".into(),
    )
}
fn review() -> AppError {
    AppError::Validation("Ce devis doit être vérifié. Sa préparation et ses documents sont conservés ; aucun second devis n’a été créé.".into())
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.bytes().enumerate().all(|(at, byte)| {
            byte.is_ascii_alphanumeric()
                || (at > 0 && matches!(byte, b'_' | b'.' | b':' | b'@' | b'-'))
        })
}

// Caller owns account -> LocalStore. Keep the ORIGINAL stamp across every
// stage, including HTTP errors, same-byte rewrites, logout/login and restores.
fn stamp(store: &LocalStore) -> AppResult<ActionStamp> {
    let inbox = inbox_read_stamp(store)?;
    let db = store.connect()?;
    let identity: Option<(String, String, String)> = db
        .query_row(
            "SELECT organization_id,user_id,role FROM company_local_identity WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (organization, user_id, role) = identity.ok_or_else(changed)?;
    if !id(&organization)
        || !id(&user_id)
        || organization != inbox.session.organization_id
        || role != inbox.session.role
        || inbox.session.installation_id != store.installation_id
        || !matches!(role.as_str(), "owner" | "admin" | "accountant" | "member")
    {
        return Err(changed());
    }
    Ok(ActionStamp {
        inbox,
        user_id,
        role,
        installation_id: store.installation_id.clone(),
        member_nonce: crate::member_context::read(&db)?,
    })
}
fn require_stamp(store: &LocalStore, original: &ActionStamp) -> AppResult<()> {
    if stamp(store).map_err(|_| changed())? != *original {
        return Err(changed());
    }
    Ok(())
}
async fn capture(store: &LocalStore) -> AppResult<ActionStamp> {
    let account = store
        .account_protected_cache
        .operation_lock
        .clone()
        .lock_owned()
        .await;
    let owned = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _account = account;
        let _local = owned.lock()?;
        stamp(&owned)
    })
    .await
    .map_err(|_| review())?
}

// The account guard lives INSIDE the worker. Dropping/cancelling the awaiting
// future cannot unlock the account while its detached blocking commit proceeds.
// Writer/recovery/ACK own LocalStore.lock, so release the validation lock first.
async fn local_effect<T, F>(
    store: &LocalStore,
    original: &ActionStamp,
    operation: F,
) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&LocalStore, &ActionStamp) -> AppResult<T> + Send + 'static,
{
    let account = store
        .account_protected_cache
        .operation_lock
        .clone()
        .lock_owned()
        .await;
    let owned = store.clone();
    let original = original.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _account = account;
        {
            let _local = owned.lock()?;
            require_stamp(&owned, &original)?;
        }
        operation(&owned, &original)
    })
    .await
    .map_err(|_| review())?
}
async fn check(store: &LocalStore, original: &ActionStamp) -> AppResult<()> {
    local_effect(store, original, |_, _| Ok(())).await
}
fn session(original: &ActionStamp) -> ProjectSyncSession {
    ProjectSyncSession {
        organization_id: original.inbox.session.organization_id.clone(),
        role: original.role.clone(),
        token: original.inbox.session.session_token.clone(),
    }
}

// Dedicated fixed-origin budget; the ordinary account response limit remains
// 64 KiB. No caller chooses the URL, timeout, redirects or bearer identity.
async fn request(session: CloudSession, body: Vec<u8>) -> AppResult<(StatusCode, Vec<u8>)> {
    request_limited(session, body, false).await
}
async fn work_request(session: CloudSession, body: Vec<u8>) -> AppResult<(StatusCode, Vec<u8>)> {
    request_limited(session, body, true).await
}
// The private boolean selects two compile-time routes/budgets only. No URL,
// timeout, account identity or transport option ever comes from the WebView.
async fn request_limited(
    session: CloudSession,
    body: Vec<u8>,
    work: bool,
) -> AppResult<(StatusCode, Vec<u8>)> {
    let (path, request_limit, response_limit) = if work {
        (
            protocol::WORK_PATH,
            protocol::MAX_WORK_REQUEST_BYTES,
            protocol::MAX_WORK_RESPONSE_BYTES,
        )
    } else {
        (protocol::PATH, 2048, protocol::MAX_RESPONSE_BYTES)
    };
    if body.len() > request_limit {
        return Err(review());
    }
    validate_opaque_token(&session.session_token, "zds_")?;
    let request = account_transport()?.post(endpoint(path)?)
        .header(ACCEPT,"application/json").header(CONTENT_TYPE,"application/json")
        .header(AUTHORIZATION,format!("Bearer {}",session.session_token))
        .body(body);
    #[cfg(test)]
    let request = crate::native_test_profile::with_sites_authorization(request)
        .map_err(|error| AppError::Validation(error.into()))?;
    let response = request.send().await.map_err(|_| AppError::Remote(
            "Automation est momentanément inaccessible. Le devis et sa reprise restent conservés.".into()))?;
    let json = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        });
    let status = response.status();
    let bytes = read_response_with_limit(response, response_limit as u64).await?;
    if !json {
        return Err(review());
    }
    Ok((status, bytes))
}

async fn exchange_with<F, Fut>(
    store: &LocalStore,
    original: &ActionStamp,
    body: Vec<u8>,
    transport: F,
) -> AppResult<Vec<u8>>
where
    F: FnOnce(CloudSession, Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = AppResult<(StatusCode, Vec<u8>)>>,
{
    check(store, original).await?;
    // Neither lock survives any network/header/body wait. A stale failure is
    // rejected just like a stale success before interpreting its status/body.
    let response = transport(original.inbox.session.clone(), body).await;
    let account = store
        .account_protected_cache
        .operation_lock
        .clone()
        .lock_owned()
        .await;
    let owned = store.clone();
    let original = original.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _account = account;
        let _local = owned.lock()?;
        require_stamp(&owned, &original)?;
        let (status, bytes) = response?;
        if bytes.len() > protocol::MAX_RESPONSE_BYTES {
            return Err(review());
        }
        if !status.is_success() {
            // Never display a remote raw message or turn a refusal into an
            // empty result / permission to create. No automatic POST retry.
            return Err(if matches!(status.as_u16(), 401 | 402 | 403) {
                changed()
            } else if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
                AppError::Remote(
                    "Automation est momentanément indisponible. Votre préparation est conservée."
                        .into(),
                )
            } else {
                review()
            });
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| review())?
}

// Own the account guard in a detached async task too: cancelling the outer
// caller cannot drop it while the collaboration helper's blocking worker runs.
// These helpers take transfer/sync gates themselves and never enable sharing.
async fn publication_phase(
    store: &LocalStore,
    original: &ActionStamp,
    selection: Option<ActionEngineQuoteRecoverySelection>,
) -> AppResult<()> {
    let account = store
        .account_protected_cache
        .operation_lock
        .clone()
        .lock_owned()
        .await;
    let owned = store.clone();
    let original = original.clone();
    tauri::async_runtime::spawn(async move {
        let _account = account;
        let checked = owned.clone();
        let before = original.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _local = checked.lock()?;
            require_stamp(&checked, &before)
        })
        .await
        .map_err(|_| review())??;
        if let Some(selection) = selection.as_ref() {
            // Another consumer may have published while this task waited for
            // the account guard. Recheck under that same guard before creating
            // an archive; the reader takes its own LocalStore lock.
            let checked = owned.clone();
            let selection = selection.clone();
            let existing = tauri::async_runtime::spawn_blocking(move || {
                checked.read_action_engine_quote_publication_candidates(selection)
            })
            .await
            .map_err(|_| review())??;
            if !existing.candidates.is_empty() {
                return Ok(());
            }
        }
        let active = session(&original);
        let result = if selection.is_some() {
            crate::company_collaboration::publish_action_engine_quote(&owned, &active).await
        } else {
            crate::company_collaboration::recover_action_engine_publication(&owned, &active).await
        };
        let checked = owned.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _local = checked.lock()?;
            require_stamp(&checked, &original)
        })
        .await
        .map_err(|_| review())??;
        result
    })
    .await
    .map_err(|_| review())?
}

fn recovery(
    original: &ActionStamp,
    selected: &QuoteExecutionSelection,
    reservation_id: String,
    fingerprint: String,
) -> ActionEngineQuoteRecoverySelection {
    ActionEngineQuoteRecoverySelection {
        source_id: selected.source_id.clone(),
        proposal_id: selected.proposal_id.clone(),
        reservation_id,
        fingerprint,
        actor: ActionEngineQuoteActor {
            organization_id: original.inbox.session.organization_id.clone(),
            user_id: original.user_id.clone(),
        },
        installation_id: original.installation_id.clone(),
        expected_workspace_scope: original.inbox.workspace_scope.clone(),
        expected_member_context_nonce: original.member_nonce.clone(),
    }
}
async fn candidates(
    store: &LocalStore,
    original: &ActionStamp,
    selection: ActionEngineQuoteRecoverySelection,
) -> AppResult<ActionEngineQuotePublicationRecovery> {
    local_effect(store, original, move |store, _| {
        store.read_action_engine_quote_publication_candidates(selection)
    })
    .await
}
async fn acknowledge(
    store: &LocalStore,
    original: &ActionStamp,
    selected: QuoteExecutionSelection,
    confirmation: ActionEngineQuoteConfirmation,
) -> AppResult<QuoteExecutionOutcome> {
    let selection = recovery(
        original,
        &selected,
        confirmation.reservation_id.clone(),
        confirmation.receipt.fingerprint.clone(),
    );
    let confirmed = local_effect(store, original, move |store, _| {
        store.acknowledge_action_engine_quote_confirmation(selection, confirmation)
    })
    .await?;
    Ok(QuoteExecutionOutcome::Confirmed(confirmed.receipt))
}

/// Full private consumer using actual HTTPS A8/A7, the actual native writer and
/// actual collaboration pipeline. Not registered as IPC or called by a timer.
/// The server route intentionally remains unexposed pending native/staging QA.
pub(crate) async fn execute_quote_draft(
    store: &LocalStore,
    selected: QuoteExecutionSelection,
) -> AppResult<QuoteExecutionOutcome> {
    let body = protocol::reserve_request(&selected)?;
    let original = capture(store).await?;
    execute_quote_draft_at(store, &original, selected, body, None).await
}

// A work round MUST reuse its original stamp. Recapturing inside execution
// would let a completed preparation cross a logout/company/member transition.
// The optional digest binds A13's summary or the local recovery selection to
// the exact A8 result before any native write or canonical acknowledgement.
async fn execute_quote_draft_at(
    store: &LocalStore,
    original: &ActionStamp,
    selected: QuoteExecutionSelection,
    body: Vec<u8>,
    expected_fingerprint: Option<&str>,
) -> AppResult<QuoteExecutionOutcome> {
    publication_phase(store, original, None).await?;
    let bytes = exchange_with(store, original, body, request).await?;
    let reserved = protocol::parse_reservation_response(&bytes, &selected)?;
    if let Some(expected) = expected_fingerprint {
        let actual = match &reserved {
            ReservationResponse::Held { .. } => None,
            ReservationResponse::Reserved(value) => Some(value.fingerprint.as_str()),
            ReservationResponse::RecoveryRequired { fingerprint, .. } => Some(fingerprint.as_str()),
            ReservationResponse::Confirmed(value) => Some(value.receipt.fingerprint.as_str()),
        };
        if actual.is_some_and(|actual| actual != expected) {
            return Err(review());
        }
    }
    let selection = match reserved {
        ReservationResponse::Held { .. } => return Ok(QuoteExecutionOutcome::Held),
        ReservationResponse::Confirmed(confirmation) => {
            // A11 A8 carries the exact selectors of its REAL completed A7 call.
            // A legacy receipt-only response cannot reach this branch.
            return acknowledge(store, original, selected, confirmation).await;
        }
        ReservationResponse::RecoveryRequired {
            reservation_id,
            fingerprint,
            ..
        } => recovery(original, &selected, reservation_id, fingerprint),
        ReservationResponse::Reserved(reserved) => {
            if reserved.actor.organization_id != original.inbox.session.organization_id
                || reserved.actor.user_id != original.user_id
                || reserved.installation_id != original.installation_id
            {
                return Err(changed());
            }
            let selection = recovery(
                original,
                &selected,
                reserved.reservation_id.clone(),
                reserved.fingerprint.clone(),
            );
            let input = reserved.into_input(
                original.inbox.workspace_scope.clone(),
                original.member_nonce.clone(),
            )?;
            local_effect(store, original, move |store, _| {
                store.commit_action_engine_quote_draft_after_recovery(input)
            })
            .await?;
            selection
        }
    };
    // Re-read even after a writer replay: another consumer may already have
    // published/confirmed this same creation during the reservation HTTP wait.
    let mut publications = candidates(store, original, selection.clone()).await?;
    if publications.candidates.is_empty() {
        publication_phase(store, original, Some(selection.clone())).await?;
        publications = candidates(store, original, selection.clone()).await?;
    }
    let canonical = publications.canonical_snapshot_id.as_deref();
    let candidate = publications
        .candidates
        .iter()
        .filter(|candidate| {
            canonical.is_some_and(|id| id == candidate.snapshot_id)
                || (canonical.is_none() && candidate.published_revision.is_some())
        })
        .min_by(|a, b| {
            (a.base_revision, a.local_clock, &a.snapshot_id).cmp(&(
                b.base_revision,
                b.local_clock,
                &b.snapshot_id,
            ))
        })
        .ok_or_else(review)?;
    let snapshot = candidate.snapshot_id.clone();
    let body = protocol::confirmation_request(&selected, &selection.reservation_id, &snapshot)?;
    let bytes = exchange_with(store, original, body, request).await?;
    let confirmation = protocol::parse_confirmation_response(
        &bytes,
        &selected,
        &selection.reservation_id,
        &snapshot,
    )?;
    acknowledge(store, original, selected, confirmation).await
}

const WORK_PAGE_SIZE: u32 = 20;
const MAX_ROUND_SOURCES: usize = 10_000;

// Opaque, memory-only continuation. Deliberately not Debug/Serialize/IPC.
// A fresh round starts without a cursor; an unfinished round resumes this same
// stamp, never a permanent watermark or a new account captured mid-operation.
pub(crate) struct QuoteWorkRound {
    original: ActionStamp,
    cursor: Option<String>,
    visited_cursors: HashSet<String>,
    seen_sources: HashSet<String>,
    complete: bool,
}

/// Volatile progress only. These counts are NOT a notification or durable
/// activity feed; those must derive from the canonical marker + local ACK.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum QuoteWorkBatchOutcome {
    Recovery {
        confirmed: usize,
        still_pending: bool,
        has_more: bool,
    },
    Page {
        confirmed: usize,
        held: usize,
        review_required: usize,
        round_complete: bool,
    },
}

pub(crate) async fn begin_quote_work_round(store: &LocalStore) -> AppResult<QuoteWorkRound> {
    Ok(QuoteWorkRound {
        original: capture(store).await?,
        cursor: None,
        visited_cursors: HashSet::new(),
        seen_sources: HashSet::new(),
        complete: false,
    })
}

fn recovery_origin(original: &ActionStamp) -> ActionEngineQuoteRecoveryOrigin {
    ActionEngineQuoteRecoveryOrigin {
        actor: ActionEngineQuoteActor {
            organization_id: original.inbox.session.organization_id.clone(),
            user_id: original.user_id.clone(),
        },
        installation_id: original.installation_id.clone(),
        expected_workspace_scope: original.inbox.workspace_scope.clone(),
        expected_member_context_nonce: original.member_nonce.clone(),
    }
}

// All real local recovery reads still go through local_effect's retained
// account guard and the reader's own mutex + IMMEDIATE transaction.
async fn recovery_work(
    store: &LocalStore,
    original: &ActionStamp,
) -> AppResult<crate::action_engine_quote_publication::ActionEngineQuoteRecoveryWork> {
    local_effect(store, original, |store, original| {
        store.read_action_engine_quote_recovery_work(
            recovery_origin(original),
            WORK_PAGE_SIZE as usize,
        )
    })
    .await
}

/// One bounded local-recovery batch OR one discovery page; never a background
/// loop or automatic retry. Caller must retain this opaque round until complete
/// and then start a new cursor-less round. The supervisor retains it natively.
pub(crate) async fn advance_quote_work_round(
    store: &LocalStore,
    round: &mut QuoteWorkRound,
) -> AppResult<QuoteWorkBatchOutcome> {
    check(store, &round.original).await?;
    if round.complete {
        return Err(review());
    }
    publication_phase(store, &round.original, None).await?;
    let owned = store.clone();
    advance_quote_work_round_with(
        store,
        round,
        work_request,
        move |original, selected, fingerprint| {
            let owned = owned.clone();
            async move {
                let body = protocol::reserve_request(&selected)?;
                execute_quote_draft_at(&owned, &original, selected, body, Some(&fingerprint)).await
            }
        },
    )
    .await
}

// Synthetic transports/executor are test-only ports at this private boundary;
// production above always uses the real fixed HTTPS/native writer/publication.
async fn advance_quote_work_round_with<W, WF, E, EF>(
    store: &LocalStore,
    round: &mut QuoteWorkRound,
    mut work: W,
    mut execute: E,
) -> AppResult<QuoteWorkBatchOutcome>
where
    W: FnMut(CloudSession, Vec<u8>) -> WF,
    WF: std::future::Future<Output = AppResult<(StatusCode, Vec<u8>)>>,
    E: FnMut(ActionStamp, QuoteExecutionSelection, String) -> EF,
    EF: std::future::Future<Output = AppResult<QuoteExecutionOutcome>>,
{
    check(store, &round.original).await?;
    if round.complete {
        return Err(review());
    }
    let local = recovery_work(store, &round.original).await?;
    if !local.selections.is_empty() {
        let mut confirmed = 0;
        for selected in local.selections {
            check(store, &round.original).await?;
            let result = execute(
                round.original.clone(),
                QuoteExecutionSelection {
                    source_id: selected.source_id,
                    proposal_id: selected.proposal_id,
                },
                selected.fingerprint,
            )
            .await;
            check(store, &round.original).await?;
            if matches!(result?, QuoteExecutionOutcome::Confirmed(_)) {
                confirmed += 1;
            }
        }
        // Re-read after effects/cancellation-safe ACK; a held or newly arrived
        // local intent must prevent fresh discovery even if the first page fit.
        let remaining = recovery_work(store, &round.original).await?;
        return Ok(QuoteWorkBatchOutcome::Recovery {
            confirmed,
            still_pending: !remaining.selections.is_empty(),
            has_more: remaining.has_more,
        });
    }
    if local.has_more {
        return Err(review());
    }
    let selected = protocol::WorkDiscoverySelection {
        limit: WORK_PAGE_SIZE,
        cursor: round.cursor.clone(),
    };
    let bytes = exchange_with(
        store,
        &round.original,
        protocol::discovery_request(&selected)?,
        |session, body| work(session, body),
    )
    .await?;
    let page = protocol::parse_discovery_response(&bytes, &selected)?;
    if page
        .next_cursor
        .as_ref()
        .is_some_and(|cursor| round.visited_cursors.contains(cursor))
        || page
            .source_ids
            .iter()
            .any(|source| round.seen_sources.contains(source))
        || round
            .seen_sources
            .len()
            .checked_add(page.source_ids.len())
            .is_none_or(|n| n > MAX_ROUND_SOURCES)
    {
        return Err(review());
    }
    let (mut confirmed, mut held, mut review_required) = (0, 0, 0);
    for source in &page.source_ids {
        let bytes = exchange_with(
            store,
            &round.original,
            protocol::preparation_request(source)?,
            |session, body| work(session, body),
        )
        .await?;
        let prepared = protocol::parse_preparation_response(&bytes, source)?;
        if prepared.disposition == protocol::QuoteWorkDisposition::NeedsReview {
            review_required += 1;
            continue;
        }
        check(store, &round.original).await?;
        let result = execute(
            round.original.clone(),
            QuoteExecutionSelection {
                source_id: prepared.source_id,
                proposal_id: prepared.proposal_id,
            },
            prepared.fingerprint,
        )
        .await;
        check(store, &round.original).await?;
        match result? {
            QuoteExecutionOutcome::Held => held += 1,
            QuoteExecutionOutcome::Confirmed(_) => confirmed += 1,
        }
    }
    // Do not advance the continuation on any failed await or partial page.
    // Already performed effects recover from their durable journal on retry.
    check(store, &round.original).await?;
    if let Some(cursor) = page.next_cursor.as_ref() {
        round.visited_cursors.insert(cursor.clone());
    }
    round.seen_sources.extend(page.source_ids);
    round.complete = page.next_cursor.is_none();
    round.cursor = page.next_cursor;
    Ok(QuoteWorkBatchOutcome::Page {
        confirmed,
        held,
        review_required,
        round_complete: round.complete,
    })
}

#[cfg(test)]
#[path = "account_cloud_action_engine_tests.rs"]
mod tests;
