//! Pure native unit tests for future CI. No HTTP, provider, licence fixture or
//! business rights are exercised or claimed by these tests.
use super::*;

fn synthetic_stamp() -> ActionStamp {
    ActionStamp {
        inbox: InboxReadStamp {
            session: CloudSession { version: 1, installation_id: "installation".into(),
                session_token: "private-synthetic-token".into(), session_expires_at: "2099-01-01T00:00:00Z".into(),
                organization_id: "org-synthetic".into(), organization_name: "Synthetic".into(),
                role: "owner".into(), connected_at: "2026-10-14T00:00:00Z".into() },
            references: [None, None, None], revisions: [0, 0, 0], workspace_scope: "workspace-synthetic".into(),
        },
        user_id: "user-synthetic".into(), role: "owner".into(), installation_id: "installation".into(),
        member_nonce: "a".repeat(32),
    }
}
fn origin() -> Origin { Origin { expected_workspace_scope: "workspace-synthetic".into(), expected_member_context_nonce: "a".repeat(32), #[cfg(all(test, windows))] test_frontdoor: None } }
fn round(stamp: ActionStamp) -> QuoteWorkRound { QuoteWorkRound { original: stamp, cursor: None, visited_cursors: HashSet::new(), seen_sources: HashSet::new(), complete: false } }

#[cfg(not(all(target_os = "windows", feature = "quote-autopilot-product")))]
#[test]
fn product_gate_is_closed_before_context_or_transport() {
    assert!(!PRODUCT_ENABLED);
    assert_eq!(admission(&origin()), Err("product_gate_closed"));
    assert_eq!(admission(&Origin { expected_workspace_scope: String::new(), expected_member_context_nonce: String::new(), ..origin() }), Err("product_gate_closed"));
    let value = serde_json::to_value(TickReply::refused("product_gate_closed")).unwrap();
    assert_eq!(value, json!({"schemaVersion":1,"status":"unavailable","code":"product_gate_closed","organizationId":null,"workspaceScope":null,"memberContextNonce":null,"phase":"none","counts":null,"roundComplete":false,"hasMore":false,"pendingRecovery":false}));
}

#[test]
fn ipc_origin_requires_both_exact_local_generations() {
    let stamp = synthetic_stamp(); assert!(origin().valid() && origin().matches(&stamp));
    for value in [json!({"expectedWorkspaceScope":"workspace-synthetic"}), json!({"expectedWorkspaceScope":"workspace-synthetic","expectedMemberContextNonce":"a".repeat(32),"organizationId":"other"})] {
        assert!(serde_json::from_value::<Origin>(value).is_err());
    }
    let mut old = origin(); old.expected_workspace_scope = "other".into(); assert!(!old.matches(&stamp));
    old = origin(); old.expected_member_context_nonce = "b".repeat(32); assert!(!old.matches(&stamp));
    old.expected_member_context_nonce = "A".repeat(32); assert!(!old.valid());
}

#[test]
fn retained_round_rejects_session_nonce_reference_and_role_changes() {
    let original = synthetic_stamp(); let retained = Some(round(original.clone()));
    assert!(!stale_round(&retained, &original)); assert!(!stale_round(&None, &original));
    let mut changed = original.clone(); changed.inbox.session.session_token.push('x'); assert!(stale_round(&retained, &changed));
    changed = original.clone(); changed.member_nonce = "b".repeat(32); assert!(stale_round(&retained, &changed));
    changed = original.clone(); changed.inbox.references[0] = Some(vec![1]); assert!(stale_round(&retained, &changed));
    changed = original.clone(); changed.inbox.revisions[0] = 1; assert!(stale_round(&retained, &changed));
    changed = original.clone(); changed.role = "admin".into(); assert!(stale_round(&retained, &changed));
    changed = original.clone(); changed.inbox.workspace_scope = "restored".into(); assert!(stale_round(&retained, &changed));
}

#[test]
fn physical_singleflight_survives_dropped_ipc_waiter_and_allows_consent_withdrawal() {
    tauri::async_runtime::block_on(async {
        let supervisor = Supervisor::default(); let flight = supervisor.round.try_lock_owned().unwrap();
        let (release, mut wait) = tauri::async_runtime::channel(1);
        let (done, mut finished) = tauri::async_runtime::channel(1);
        let task = tauri::async_runtime::spawn(async move {
            let flight = flight; wait.recv().await.unwrap(); drop(flight); done.send(()).await.unwrap();
        });
        drop(task); // dropping the join waiter does not abort native work
        assert!(supervisor.round.try_lock_owned().is_none());
        let withdrawal = supervisor.consent_write.try_lock_owned().unwrap();
        assert!(supervisor.consent_write.try_lock_owned().is_none()); drop(withdrawal);
        release.send(()).await.unwrap(); finished.recv().await.unwrap();
        assert!(supervisor.round.try_lock_owned().is_some());
    });
}

#[test]
fn review_and_recovery_summaries_are_distinct_from_confirmed_activity() {
    let stamp = synthetic_stamp();
    let review = TickReply::outcome(QuoteWorkBatchOutcome::Page { confirmed: 0, held: 0, review_required: 1, round_complete: true }, &stamp);
    let value = serde_json::to_value(review).unwrap(); assert_eq!(value["status"], "needs_review");
    assert_eq!(value["counts"]["confirmed"], 0); assert!(value.get("quoteId").is_none());
    let recovery = TickReply::outcome(QuoteWorkBatchOutcome::Recovery { confirmed: 0, still_pending: true, has_more: false }, &stamp);
    assert_eq!(recovery.scope.status, "held"); assert_eq!(recovery.phase, "recovery");
    assert!(!recovery.round_complete && recovery.pending_recovery);
}

#[test]
fn consent_cas_and_read_dtos_refuse_extra_fields_versions_and_revision_overflow() {
    let valid = json!({"schemaVersion":1,"enabled":true,"consentVersion":CONSENT_VERSION,"expectedRevision":0});
    assert!(serde_json::from_value::<ConsentInput>(valid.clone()).unwrap().valid());
    for (field, value) in [("schemaVersion", json!(2)), ("consentVersion", json!("automation-2026-09-20")), ("expectedRevision", json!(2147483648u64))] {
        let mut invalid = valid.clone(); invalid[field] = value; assert!(!serde_json::from_value::<ConsentInput>(invalid).unwrap().valid());
    }
    let mut invalid = valid; invalid["actor"] = json!("owner"); assert!(serde_json::from_value::<ConsentInput>(invalid).is_err());
    assert!(serde_json::from_value::<ConsentInput>(json!({"schemaVersion":1,"enabled":false,"consentVersion":null,"expectedRevision":1})).unwrap().valid());
    assert!(serde_json::from_value::<ConsentInput>(json!({"schemaVersion":1,"enabled":false,"expectedRevision":1})).is_err());
    assert!(serde_json::from_value::<PageInput>(json!({"limit":20})).is_err());
    assert!(parse_public(br#"{"schemaVersion":1,"enabled":false,"revision":0,"consentVersion":null,"requiredConsentVersion":"action-engine-quote-draft-customer-2026-10-11"}"#, CONSENT_PATH, &synthetic_stamp(), 50).is_some());
}

#[test]
fn review_pages_are_bounded_same_company_and_never_expose_decisions() {
    let stamp = synthetic_stamp(); let page = json!({"organizationId":"org-synthetic","items":[{"proposalId":"proposal","sourceId":"source","createdAt":1,"disposition":"needs_review","reasons":["low_confidence"],"requiresHumanValidation":true}],"nextCursor":null});
    let parse = |v: &serde_json::Value| parse_public(&serde_json::to_vec(v).unwrap(), REVIEW_PATH, &stamp, 1);
    assert!(parse(&page).is_some());
    let mut invalid = page.clone(); invalid["organizationId"] = json!("other"); assert!(parse(&invalid).is_none());
    invalid = page.clone(); invalid["items"][0]["plan"] = json!({}); assert!(parse(&invalid).is_none());
    invalid = page.clone(); invalid["items"][0]["reasons"] = json!(["low_confidence","low_confidence"]); assert!(parse(&invalid).is_none());
    invalid = page.clone(); invalid["items"].as_array_mut().unwrap().push(page["items"][0].clone()); assert!(parse(&invalid).is_none());
    invalid = page.clone(); invalid["nextCursor"] = json!("x".repeat(4097)); assert!(parse(&invalid).is_none());
    assert!(parse_public(&vec![b' '; 65537], REVIEW_PATH, &stamp, 1).is_none());
    // A valid draft suggestion is kept; a malformed one is dropped, never the review.
    let mut suggested = page.clone();
    suggested["items"][0]["suggestion"] = json!({"customer":{"kind":"existing","name":"Atelier"},"currency":"CHF","netCents":17800,
        "lines":[{"articleId":"article-1","description":"Zentra Gestion Pro","unit":"mois","quantityMilli":2000,"unitPriceCents":8900,"taxRateBp":0,"netCents":17800}]});
    assert_eq!(parse(&suggested).unwrap()["items"][0]["suggestion"]["lines"][0]["quantityMilli"], json!(2000));
    let mut malformed = suggested.clone(); malformed["items"][0]["suggestion"]["lines"][0]["quantityMilli"] = json!(0);
    let kept = parse(&malformed).unwrap(); assert!(kept["items"][0].get("suggestion").is_none());
    assert_eq!(kept["items"][0]["proposalId"], json!("proposal"));
    malformed = suggested.clone(); malformed["items"][0]["suggestion"]["customer"]["kind"] = json!("invented");
    assert!(parse(&malformed).unwrap()["items"][0].get("suggestion").is_none());
    malformed = suggested.clone(); malformed["items"][0]["suggestion"]["extra"] = json!(1);
    assert!(parse(&malformed).is_none());
    // details=2: request lines without an article, at most 8 of at most 200 characters.
    let mut lines = suggested.clone(); lines["items"][0]["suggestion"]["unmatched"] = json!(["3 licences Zentra Support"]);
    assert_eq!(parse(&lines).unwrap()["items"][0]["suggestion"]["unmatched"][0], json!("3 licences Zentra Support"));
    lines["items"][0]["suggestion"]["unmatched"] = json!(vec!["ligne"; 9]);
    assert!(parse(&lines).unwrap()["items"][0].get("suggestion").is_none());
    lines["items"][0]["suggestion"]["unmatched"] = json!(["x".repeat(201)]);
    assert!(parse(&lines).unwrap()["items"][0].get("suggestion").is_none());
    // details=3: who wrote the request; a malformed sender is dropped alone.
    let mut sent = suggested.clone();
    sent["items"][0]["suggestion"]["sender"] = json!({"email":"marie@rive.ch","name":"Marie Rochat","company":"Atelier Rive SA","phone":null,
        "street":"Rue du Lac 4","postcode":"1003","city":"Lausanne","source":"signature"});
    assert_eq!(parse(&sent).unwrap()["items"][0]["suggestion"]["sender"]["company"], json!("Atelier Rive SA"));
    for (field, bad) in [("email", json!("Marie@Rive.ch")), ("source", json!("guess")), ("postcode", json!("x".repeat(17))), ("name", json!(""))] {
        let mut wrong = sent.clone(); wrong["items"][0]["suggestion"]["sender"][field] = bad;
        let kept = parse(&wrong).unwrap(); let suggestion = &kept["items"][0]["suggestion"];
        assert!(suggestion.get("sender").is_none()); assert_eq!(suggestion["netCents"], json!(17800));
    }
    let mut extra = sent.clone(); extra["items"][0]["suggestion"]["sender"]["extra"] = json!(1);
    assert!(parse(&extra).unwrap()["items"][0]["suggestion"].get("sender").is_none());
    let mut missing = sent.clone(); missing["items"][0]["suggestion"]["sender"].as_object_mut().unwrap().remove("phone");
    assert!(parse(&missing).unwrap()["items"][0]["suggestion"].get("sender").is_none());
    // Quote acceptances read from client mails; a bad sender becomes null, a bad item refuses the page.
    let accept = |v: serde_json::Value| parse_public(&serde_json::to_vec(&v).unwrap(), ACCEPT_PATH, &stamp, 50);
    let accepted = json!({"organizationId":"org-synthetic","items":[{"sourceId":"ticket-1","receivedAt":1791947827,"quoteReference":"D-2026-0006",
        "evidence":"Je confirme le devis.","sender":{"email":"marie@rive.ch","name":"Marie","company":null,"phone":null,"street":null,"postcode":null,"city":null,"source":"signature"},
        "requiresHumanValidation":true}]});
    assert_eq!(accept(accepted.clone()).unwrap()["items"][0]["quoteReference"], json!("D-2026-0006"));
    let mut bad_sender = accepted.clone(); bad_sender["items"][0]["sender"]["source"] = json!("guess");
    assert!(accept(bad_sender).unwrap()["items"][0].get("sender").is_none());
    let mut no_reference = accepted.clone(); no_reference["items"][0]["quoteReference"] = json!(null);
    assert!(accept(no_reference).is_some());
    for (field, bad) in [("requiresHumanValidation", json!(false)), ("evidence", json!("")), ("receivedAt", json!(0)), ("extra", json!(1))] {
        let mut wrong = accepted.clone(); wrong["items"][0][field] = bad; assert!(accept(wrong).is_none());
    }
    let mut other = accepted.clone(); other["organizationId"] = json!("org-other"); assert!(accept(other).is_none());
    // The remembered article choice.
    let choice = |v: serde_json::Value| parse_public(&serde_json::to_vec(&v).unwrap(), ALIAS_PATH, &stamp, 50);
    assert!(choice(json!({"schemaVersion":1,"term":"licences zentra support","articleId":"article-1"})).is_some());
    assert!(choice(json!({"schemaVersion":2,"term":"licences","articleId":"article-1"})).is_none());
    assert!(choice(json!({"schemaVersion":1,"term":"licences","articleId":"../article"})).is_none());
    assert!(choice(json!({"schemaVersion":1,"term":"licences","articleId":"article-1","extra":true})).is_none());
    let mut activity = json!({"organizationId":"org-synthetic","items":[{"activityId":"activity","proposalId":"proposal","quoteId":"11111111-1111-4111-8111-111111111111","confirmedAt":1,"kind":"quote_draft_created","requiresHumanValidation":true}],"nextCursor":null});
    assert!(parse_public(&serde_json::to_vec(&activity).unwrap(), ACTIVITY_PATH, &stamp, 1).is_some());
    activity["items"][0]["quoteId"] = json!("11111111-1111-4111-7111-111111111111");
    assert!(parse_public(&serde_json::to_vec(&activity).unwrap(), ACTIVITY_PATH, &stamp, 1).is_none());
}

#[test]
fn server_failures_map_to_closed_codes_without_response_text() {
    let quota = json!({"schemaVersion":1,"state":"error","code":"quota_exhausted","message":"private-synthetic-token"});
    assert!(monthly_quota_refusal(&serde_json::to_vec(&quota).unwrap()));
    for bad in [json!({"schemaVersion":1,"state":"error","code":"quota_exhausted"}),
        json!({"schemaVersion":1,"state":"prepared","code":"quota_exhausted","message":"x"}),
        json!({"schemaVersion":1,"state":"error","code":"quota_exhausted","message":"x","token":"private"})] {
        assert!(!monthly_quota_refusal(&serde_json::to_vec(&bad).unwrap()));
    }
    assert_eq!(cycle_error_code(&AppError::Automation(crate::error::AutomationErrorCode::QuotaExhausted)),"quota_exhausted");
    assert_eq!(cycle_error_code(&AppError::Automation(crate::error::AutomationErrorCode::RateLimited)),"rate_limited");
    assert!(!serde_json::to_string(&TickReply::refused("quota_exhausted")).unwrap().contains("private-synthetic-token"));
    for (status, expected) in [(400,"invalid_request"),(401,"forbidden"),(403,"forbidden"),(404,"product_gate_closed"),(409,"conflict"),(429,"rate_limited"),(500,"service_unavailable")] {
        assert_eq!(status_code(StatusCode::from_u16(status).unwrap()), expected);
        let value = serde_json::to_string(&ReadReply::refused(expected)).unwrap();
        assert!(!value.contains("private-synthetic-token") && !value.contains("Synthetic"));
    }
}

#[test]
fn product_routes_are_fixed_first_party_https_without_sites_credentials() {
    assert_eq!(ACCOUNT_API_ORIGIN, "https://zentraapp.ch");
    // cfg(test) may use only the already validated compiled public profile.
    // This unit test neither installs a Sites token nor performs HTTP.
    let expected_origin = account_api_origin().unwrap();
    for path in [CONSENT_PATH, ACTIVITY_PATH, REVIEW_PATH, ALIAS_PATH, ACCEPT_PATH] {
        let url = endpoint(path).unwrap(); assert_eq!(url.as_str(), format!("{expected_origin}{path}"));
        assert!(url.query().is_none() && url.fragment().is_none());
        for bad in [format!("{path}/"), format!("{path}?actor=x"), format!("https://example.test{path}")] { assert!(endpoint(&bad).is_err()); }
    }
}
