//! Private cfg(test, windows) admission for the actual native frontdoor recipe.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

const FLAG: &str = "ZENTRA_RUN_LIVE_PRODUCT_FRONTDOOR_RECIPE";
const PROFILE: &str = "2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf";
const SITE: &str = "https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site";
const OWNER: &str = "1f0d9981-607b-4848-9374-587035cdfd89";
const ORGANIZATION: &str = "org_trial_345a3d1f68056cf7e709d4af4fc229a4";

// This is not Deserialize/Serialize/Debug, an IPC argument, or a global switch.
// Retaining the actual Arc also prevents pointer reuse after a store is dropped.
pub(super) struct Grant {
    active: AtomicBool,
    store_identity: Arc<Mutex<()>>,
    original: ActionStamp,
}
pub(crate) struct Context { grant: Arc<Grant> }

pub(crate) fn require_recipe_environment() -> AppResult<()> {
    let profile = crate::native_test_profile::require().map_err(|_| review())?;
    let source = option_env!("CIRCLE_SHA1").ok_or_else(review)?;
    if option_env!("ZENTRA_ACTION_NATIVE_TEST_CONTEXT") != Some("live-sandbox-a41")
        || profile.sha256() != PROFILE || profile.site_origin() != SITE
        || profile.license_kid() != "sandbox-action-engine-a41"
        || source.len() != 40 || !source.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || std::env::var("CIRCLE_SHA1").as_deref() != Ok(source)
        || std::env::var("CIRCLECI").as_deref() != Ok("true")
        || std::env::var("OS").as_deref() != Ok("Windows_NT")
        || std::env::var("CIRCLE_BRANCH").as_deref() != Ok("codex/action-engine-native-live-a41")
        || std::env::var("CIRCLE_JOB").as_deref() != Ok("windows-action-live-account-tests")
        || std::env::var("CIRCLE_NODE_INDEX").as_deref() != Ok("0")
        || std::env::var("CIRCLE_NODE_TOTAL").as_deref() != Ok("1")
        || std::env::var(FLAG).as_deref() != Ok("true")
        || std::env::var("ZENTRA_VERIFY_DIAGNOSTICS_ONLY").as_deref() != Ok("true")
        || std::env::var("ZENTRA_VERIFY_ONLY").as_deref() != Ok("true")
        || std::env::var("ZENTRA_VERIFY_LIVE_ACCOUNT_ONLY").as_deref() != Ok("true")
        || std::env::var("ZENTRA_LIVE_PROFILE_RELEASE").as_deref() != Ok("false")
        || ["ZENTRA_RUN_LIVE_G4_RECIPE", "ZENTRA_RUN_LIVE_G4_CONTINUATION", "ZENTRA_RUN_LIVE_G5_RECIPE"]
            .iter().any(|name| std::env::var(name).is_ok()) { return Err(review()); }
    Ok(())
}
impl Context {
    pub(crate) async fn admit(store: &LocalStore) -> AppResult<Self> {
        require_recipe_environment()?; // before any LocalStore capture or HTTP
        let original = capture(store).await?;
        if original.user_id != OWNER || original.role != "owner"
            || original.inbox.session.organization_id != ORGANIZATION { return Err(changed()); }
        check(store, &original).await?;
        Ok(Self { grant: Arc::new(Grant { active: AtomicBool::new(true),
            store_identity: store.account_protected_cache.operation_lock.clone(), original }) })
    }
    pub(crate) fn origin(&self) -> Origin {
        Origin { expected_workspace_scope: self.grant.original.inbox.workspace_scope.clone(),
            expected_member_context_nonce: self.grant.original.member_nonce.clone(),
            test_frontdoor: Some(self.grant.clone()) }
    }
}
impl Drop for Context {
    fn drop(&mut self) { self.grant.active.store(false, Ordering::Release); }
}
pub(super) fn allows(origin: &Origin) -> bool {
    origin.test_frontdoor.as_ref().is_some_and(|grant|
        grant.active.load(Ordering::Acquire) && origin.matches(&grant.original))
}
pub(super) fn require_store(origin: &Origin, store: &LocalStore) -> Result<(), &'static str> {
    match &origin.test_frontdoor {
        Some(grant) if !allows(origin) || !Arc::ptr_eq(&grant.store_identity, &store.account_protected_cache.operation_lock)
            => Err("context_changed"),
        _ => Ok(()),
    }
}
pub(super) fn require_stamp(origin: &Origin, stamp: &ActionStamp) -> Result<(), &'static str> {
    match &origin.test_frontdoor {
        Some(grant) if !allows(origin) || grant.original != *stamp => Err("context_changed"),
        _ => Ok(()),
    }
}
pub(super) fn current(origin: &Origin, store: &LocalStore, stamp: &ActionStamp) -> bool {
    require_store(origin, store).is_ok() && require_stamp(origin, stamp).is_ok()
}

// Actual six handlers, inferred MockRuntime, same actual LocalStore and owned
// Supervisor. The caller must already have received the current real head and
// provisioned exactly one NEW source through the ordinary existing API hook.
// This function never calls staged::prepare or changes a consent setting.
pub(crate) async fn exercise_once(store: &LocalStore) -> AppResult<serde_json::Value> {
    let context = Context::admit(store).await?;
    let app = tauri::test::mock_builder().manage(store.clone()).manage(Supervisor::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).map_err(|_| review())?;
    let origin = context.origin();
    let state = quote_autopilot_state(app.state(), origin.clone()).await.map_err(|_| review())?;
    if state.scope.status != "available" || !state.can_manage { return Err(review()); }
    let consent = quote_autopilot_consent(app.state(), origin.clone()).await.map_err(|_| review())?;
    let before: Consent = serde_json::from_value(consent.data.clone().ok_or_else(review)?).map_err(|_| review())?;
    if consent.scope.status != "available" || !before.valid() || !before.enabled || before.revision < 1 { return Err(review()); }
    // Exercise the real POST/CAS refusal, never ON/OFF or a same-value revision bump.
    let stale = set_quote_autopilot_consent(app.state(), app.state(), origin.clone(), ConsentInput {
        schema_version: 1, enabled: true, consent_version: Some(CONSENT_VERSION.into()), expected_revision: before.revision - 1,
    }).await.map_err(|_| review())?;
    if stale.scope.code != "revision_conflict" || stale.data.is_some() { return Err(review()); }
    let after = quote_autopilot_consent(app.state(), origin.clone()).await.map_err(|_| review())?;
    if after.scope.status != "available" || after.data != consent.data { return Err(review()); }
    let review_before = quote_autopilot_review(app.state(), origin.clone(), PageInput { limit: 50, cursor: None }).await.map_err(|_| review())?;
    let activity_before = quote_autopilot_activity(app.state(), origin.clone(), PageInput { limit: 50, cursor: None }).await.map_err(|_| review())?;
    if review_before.scope.status != "available" || activity_before.scope.status != "available" { return Err(review()); }
    let tick = quote_autopilot_tick(app.state(), app.state(), origin.clone()).await.map_err(|_| review())?;
    let review_after = quote_autopilot_review(app.state(), origin.clone(), PageInput { limit: 50, cursor: None }).await.map_err(|_| review())?;
    let activity_after = quote_autopilot_activity(app.state(), origin, PageInput { limit: 50, cursor: None }).await.map_err(|_| review())?;
    // Private observation only. The outer future recipe must corroborate actual
    // canonical publication + local ACK + B receive; these DTOs alone are not G4.
    serde_json::to_value((state, consent, stale, review_before, activity_before, tick, review_after, activity_after))
        .map_err(|_| review())
}

#[test]
fn webview_json_cannot_supply_a_native_test_grant() {
    let value = json!({"expectedWorkspaceScope":"scope","expectedMemberContextNonce":"a".repeat(32)});
    let origin: Origin = serde_json::from_value(value.clone()).unwrap();
    assert!(origin.test_frontdoor.is_none());
    assert_eq!(admission(&origin), Err("product_gate_closed"));
    for field in ["testFrontdoor", "test_frontdoor", "grant", "enabled"] {
        for attempted in [json!(null), json!(true), json!({"active":true})] {
            let mut invalid = value.clone(); invalid[field] = attempted;
            assert!(serde_json::from_value::<Origin>(invalid).is_err());
        }
    }
}
