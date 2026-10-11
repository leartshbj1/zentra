//! Discriminating wire tests. These perform no network, IPC or database work.
use super::*;
use serde_json::{json, Value};

const RESERVATION: &str = "efc98ca7-0913-4a53-85c6-d3d38737d9db";
const INSTALLATION: &str = "788659d9-f20e-4eae-9c0f-146057b0bfb0";
const CUSTOMER: &str = "960e994b-bbf2-4538-b58c-588112da7849";
const QUOTE: &str = "02c11008-6c2d-49b3-8d0f-50cfb6b218eb";
const SNAPSHOT: &str = "68c9d889-ecfb-4fcb-a4aa-3bed171a68aa";
const SCOPE: &str = "cb8b3c0f-ea57-4845-a31d-935a521fc6d4";
const NONCE: &str = "0123456789abcdef0123456789abcdef";

fn selected() -> QuoteExecutionSelection {
    QuoteExecutionSelection {
        source_id: "synthetic-source".into(),
        proposal_id: "synthetic-proposal".into(),
    }
}

fn reserved() -> Value {
    let source = json!({
        "id": "synthetic-source",
        "revision": "source:1",
        "organizationId": "synthetic-company",
        "senderEmail": "synthetic@example.test",
        "senderName": "Atelier Été 👩‍🔧",
        "subject": "Installation — étage 2\u{2028}\"\\",
        "body": "Installer 3 radiateurs\nMerci 👩‍🔧"
    });
    let plan = json!({
        "schemaVersion": 1,
        "engineVersion": "action-engine-quote-v1",
        "kind": "prepare_quote_draft",
        "organizationId": "synthetic-company",
        "contextRevision": "context:4",
        "sourceId": "synthetic-source",
        "sourceRevision": "source:1",
        "status": "ready",
        "reasons": [],
        "customer": {
            "kind": "new",
            "name": "Atelier Été 👩‍🔧",
            "email": "synthetic@example.test"
        },
        "title": source["subject"],
        "currency": "CHF",
        "lines": [{
            "articleId": "radiateur",
            "articleRevision": "article:1",
            "description": "Radiateur — modèle \"A\" \\ 👩‍🔧",
            "unit": "pièce",
            "quantityMilli": 3000,
            "unitPriceCents": 19901,
            "taxRateBp": 810,
            "netCents": 59703,
            "evidence": "Installer 3 radiateurs"
        }],
        "netCents": 59703,
        "confidence": 0.97,
        "requiresHumanValidation": true
    });
    let canonical = serde_json::to_string(&plan).unwrap();
    json!({
        "schemaVersion": 1,
        "state": "reserved",
        "canonicalPlanJson": canonical,
        "proposalId": "synthetic-proposal",
        "fingerprint": sha(canonical.as_bytes()),
        "reservationId": RESERVATION,
        "source": source,
        "actor": {"organizationId": "synthetic-company", "userId": "synthetic-user"},
        "installationId": INSTALLATION,
        "expectedResourcesHash": "a".repeat(64),
        "expectedContextRevision": "context:4",
        "customerId": CUSTOMER,
        "quoteId": QUOTE,
        "authorizationRevision": "authority:9"
    })
}

fn receipt() -> Value {
    json!({
        "organizationId": "synthetic-company",
        "proposalId": "synthetic-proposal",
        "fingerprint": "b".repeat(64),
        "customerId": CUSTOMER,
        "quoteId": QUOTE,
        "quoteNumber": null,
        "status": "draft",
        "requiresHumanValidation": true
    })
}

fn confirmation() -> Value {
    json!({
        "schemaVersion": 1,
        "state": "confirmed",
        "sourceId": "synthetic-source",
        "proposalId": "synthetic-proposal",
        "reservationId": RESERVATION,
        "publicationSnapshotId": SNAPSHOT,
        "receipt": receipt()
    })
}

fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

fn parsed_reserved(value: &Value) -> ReservedQuote {
    match parse_reservation_response(&bytes(value), &selected()).unwrap() {
        ReservationResponse::Reserved(value) => value,
        _ => panic!("expected a reserved synthetic quote"),
    }
}

fn edit_plan(value: &mut Value, edit: impl FnOnce(&mut Value)) {
    let mut plan: Value =
        serde_json::from_str(value["canonicalPlanJson"].as_str().unwrap()).unwrap();
    edit(&mut plan);
    let canonical = serde_json::to_string(&plan).unwrap();
    value["fingerprint"] = json!(sha(canonical.as_bytes()));
    value["canonicalPlanJson"] = json!(canonical);
}

fn rejects_reservation(value: &Value) {
    assert!(parse_reservation_response(&bytes(value), &selected()).is_err());
}

fn rejects_confirmation(value: &Value) {
    assert!(
        parse_confirmation_response(&bytes(value), &selected(), RESERVATION, SNAPSHOT).is_err()
    );
}

#[test]
fn requests_are_flat_selector_only_and_validate_selectors_before_encoding() {
    assert_eq!(PATH, "/api/account/automation/quote-execution");
    assert_eq!(MAX_RESPONSE_BYTES, 128 * 1024);
    assert_eq!(
        serde_json::from_slice::<Value>(&reserve_request(&selected()).unwrap()).unwrap(),
        json!({"schemaVersion":1,"operation":"reserve","sourceId":"synthetic-source","proposalId":"synthetic-proposal"})
    );
    assert_eq!(
        serde_json::from_slice::<Value>(
            &confirmation_request(&selected(), RESERVATION, SNAPSHOT).unwrap()
        )
        .unwrap(),
        json!({"schemaVersion":1,"operation":"confirm","sourceId":"synthetic-source","proposalId":"synthetic-proposal","reservationId":RESERVATION,"publicationSnapshotId":SNAPSHOT})
    );
    for bad in ["", "../foreign", " space", "non-ascii-é"] {
        let mut selection = selected();
        selection.source_id = bad.into();
        assert!(reserve_request(&selection).is_err());
        assert!(confirmation_request(&selection, RESERVATION, SNAPSHOT).is_err());
    }
    assert!(confirmation_request(&selected(), "not-a-reservation", SNAPSHOT).is_err());
    assert!(
        confirmation_request(&selected(), RESERVATION, &SNAPSHOT.to_ascii_uppercase()).is_err()
    );
    assert!(serde_json::from_value::<QuoteExecutionSelection>(json!({
        "sourceId":"synthetic-source","proposalId":"synthetic-proposal","actor":{}
    }))
    .is_err());
}

#[test]
fn reserved_wire_preserves_unicode_raw_plan_and_maps_only_local_generations() {
    let fixture = reserved();
    let reserved = parsed_reserved(&fixture);
    assert_eq!(reserved.authorization_revision, "authority:9");
    let input = reserved.into_input(SCOPE.into(), NONCE.into()).unwrap();
    assert_eq!(
        input.canonical_plan_json,
        fixture["canonicalPlanJson"].as_str().unwrap()
    );
    assert_eq!(input.fingerprint, sha(input.canonical_plan_json.as_bytes()));
    assert_eq!(input.expected_context_revision, "context:4");
    assert_ne!(input.expected_context_revision, "authority:9");
    assert_eq!(input.expected_workspace_scope, SCOPE);
    assert_eq!(input.expected_member_context_nonce, NONCE);
    assert_eq!(input.actor.user_id, "synthetic-user");
    assert_eq!(input.installation_id, INSTALLATION);
    assert!(input.source.body.contains("\nMerci 👩‍🔧"));
    assert!(input.source.subject.contains('\u{2028}'));
    assert_eq!(input.expected_resources_hash, "a".repeat(64));
}

#[test]
fn held_and_recovery_responses_are_closed_and_bound_to_the_requested_proposal() {
    let held = json!({"schemaVersion":1,"state":"held","proposalId":"synthetic-proposal"});
    match parse_reservation_response(&bytes(&held), &selected()).unwrap() {
        ReservationResponse::Held { proposal_id } => assert_eq!(proposal_id, "synthetic-proposal"),
        _ => panic!("expected held"),
    }
    let recovery = json!({"schemaVersion":1,"state":"recovery_required","proposalId":"synthetic-proposal","reservationId":RESERVATION,"fingerprint":"b".repeat(64)});
    match parse_reservation_response(&bytes(&recovery), &selected()).unwrap() {
        ReservationResponse::RecoveryRequired {
            proposal_id,
            reservation_id,
            fingerprint,
        } => {
            assert_eq!(proposal_id, "synthetic-proposal");
            assert_eq!(reservation_id, RESERVATION);
            assert_eq!(fingerprint, "b".repeat(64));
        }
        _ => panic!("expected recovery required"),
    }
    for mut invalid in [held.clone(), recovery.clone()] {
        invalid["proposalId"] = json!("foreign-proposal");
        rejects_reservation(&invalid);
    }
    let mut leaking = held;
    leaking["reservationId"] = json!(RESERVATION);
    rejects_reservation(&leaking);
    let mut bad_hash = recovery;
    bad_hash["fingerprint"] = json!("B".repeat(64));
    rejects_reservation(&bad_hash);
}

#[test]
fn confirmed_reservation_requires_the_exact_a7_selector_envelope() {
    let value = confirmation();
    match parse_reservation_response(&bytes(&value), &selected()).unwrap() {
        ReservationResponse::Confirmed(confirmation) => {
            assert_eq!(confirmation.source_id, "synthetic-source");
            assert_eq!(confirmation.proposal_id, "synthetic-proposal");
            assert_eq!(confirmation.reservation_id, RESERVATION);
            assert_eq!(confirmation.publication_snapshot_id, SNAPSHOT);
            assert_eq!(confirmation.receipt.quote_number, None);
            assert!(confirmation.receipt.requires_human_validation);
        }
        _ => panic!("expected corroborated confirmation"),
    }
    rejects_reservation(&json!({"schemaVersion":1,"state":"confirmed","receipt":receipt()}));
    for key in [
        "sourceId",
        "proposalId",
        "reservationId",
        "publicationSnapshotId",
    ] {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(key);
        rejects_reservation(&missing);
        let mut wrong = value.clone();
        wrong[key] = json!("wrong-selector");
        rejects_reservation(&wrong);
    }
}

#[test]
fn confirmation_parser_binds_all_four_selectors_and_rejects_transport_ack() {
    let value = confirmation();
    let parsed =
        parse_confirmation_response(&bytes(&value), &selected(), RESERVATION, SNAPSHOT).unwrap();
    assert_eq!(parsed.publication_snapshot_id, SNAPSHOT);
    assert_eq!(parsed.receipt.quote_id, QUOTE);
    for key in [
        "sourceId",
        "proposalId",
        "reservationId",
        "publicationSnapshotId",
    ] {
        let mut wrong = value.clone();
        wrong[key] = json!(if key.ends_with("Id") {
            INSTALLATION
        } else {
            "foreign"
        });
        rejects_confirmation(&wrong);
    }
    rejects_confirmation(&json!({"committed":true,"revision":2,"snapshotId":SNAPSHOT}));
    let mut unknown = value.clone();
    unknown["revision"] = json!(2);
    rejects_confirmation(&unknown);
    for version in [json!(0), json!(2), json!("1"), json!(1.0)] {
        let mut wrong = value.clone();
        wrong["schemaVersion"] = version;
        rejects_confirmation(&wrong);
    }
}

#[test]
fn original_receipt_requires_present_null_draft_and_human_validation() {
    let value = confirmation();
    let direct =
        parse_confirmation_response(&bytes(&value), &selected(), RESERVATION, SNAPSHOT).unwrap();
    assert_eq!(direct.receipt.quote_number, None);
    match parse_reservation_response(&bytes(&value), &selected()).unwrap() {
        ReservationResponse::Confirmed(buffered) => {
            assert_eq!(buffered.receipt.quote_number, direct.receipt.quote_number);
        }
        _ => panic!("expected confirmed reservation with an explicit null quoteNumber"),
    }
    let mut missing = value.clone();
    missing["receipt"]
        .as_object_mut()
        .unwrap()
        .remove("quoteNumber");
    rejects_confirmation(&missing);
    rejects_reservation(&missing);
    for number in [
        json!(""),
        json!("D-001"),
        json!(0),
        json!(false),
        json!({}),
        json!({"number": null}),
        json!([]),
        json!([null]),
    ] {
        let mut wrong = value.clone();
        wrong["receipt"]["quoteNumber"] = number;
        assert!(
            parse_confirmation_response(&bytes(&wrong), &selected(), RESERVATION, SNAPSHOT).is_err(),
            "direct receipt accepted non-null quoteNumber: {}",
            wrong["receipt"]["quoteNumber"]
        );
        assert!(
            parse_reservation_response(&bytes(&wrong), &selected()).is_err(),
            "tagged receipt accepted non-null quoteNumber: {}",
            wrong["receipt"]["quoteNumber"]
        );
    }
    for (key, replacement) in [
        ("requiresHumanValidation", json!(false)),
        ("status", json!("issued")),
        ("quoteId", json!("quote-not-uuid")),
        ("proposalId", json!("foreign-proposal")),
        ("fingerprint", json!("b".repeat(63))),
    ] {
        let mut wrong = value.clone();
        wrong["receipt"][key] = replacement;
        rejects_confirmation(&wrong);
        rejects_reservation(&wrong);
    }
}

#[test]
fn duplicate_fields_are_rejected_before_root_nested_or_plan_values_can_be_erased() {
    let raw = serde_json::to_string(&reserved()).unwrap();
    for duplicate in [
        raw.replacen(
            "\"state\":\"reserved\"",
            "\"state\":\"reserved\",\"state\":\"reserved\"",
            1,
        ),
        raw.replacen(
            "\"schemaVersion\":1",
            "\"schemaVersion\":1,\"schemaVersion\":1",
            1,
        ),
        raw.replacen(
            "\"proposalId\":\"synthetic-proposal\"",
            "\"proposalId\":\"synthetic-proposal\",\"proposal\\u0049d\":\"synthetic-proposal\"",
            1,
        ),
        raw.replacen(
            "\"userId\":\"synthetic-user\"",
            "\"userId\":\"synthetic-user\",\"userId\":\"synthetic-user\"",
            1,
        ),
        raw.replacen(
            "\"senderEmail\":\"synthetic@example.test\"",
            "\"senderEmail\":\"synthetic@example.test\",\"senderEmail\":\"synthetic@example.test\"",
            1,
        ),
    ] {
        assert_ne!(duplicate, raw);
        assert!(parse_reservation_response(duplicate.as_bytes(), &selected()).is_err());
    }
    let raw = serde_json::to_string(&confirmation()).unwrap();
    let duplicate = raw.replacen(
        "\"quoteNumber\":null",
        "\"quoteNumber\":null,\"quoteNumber\":null",
        1,
    );
    assert!(
        parse_confirmation_response(duplicate.as_bytes(), &selected(), RESERVATION, SNAPSHOT)
            .is_err()
    );
    let mut value = reserved();
    let plan = value["canonicalPlanJson"].as_str().unwrap().replacen(
        "\"netCents\":59703",
        "\"netCents\":59703,\"netCents\":59703",
        1,
    );
    value["fingerprint"] = json!(sha(plan.as_bytes()));
    value["canonicalPlanJson"] = json!(plan);
    rejects_reservation(&value);
}

#[test]
fn unknown_fields_remain_errors_in_every_wire_level() {
    for path in ["root", "actor", "source", "plan", "line", "customer"] {
        let mut value = reserved();
        match path {
            "root" => value["permission"] = json!(true),
            "actor" => value["actor"]["role"] = json!("owner"),
            "source" => value["source"]["privateNotes"] = json!("synthetic"),
            "plan" => edit_plan(&mut value, |plan| plan["permission"] = json!(true)),
            "line" => edit_plan(&mut value, |plan| {
                plan["lines"][0]["purchasePrice"] = json!(1)
            }),
            "customer" => edit_plan(&mut value, |plan| plan["customer"]["role"] = json!("owner")),
            _ => unreachable!(),
        }
        rejects_reservation(&value);
    }
    let mut value = confirmation();
    value["receipt"]["permission"] = json!(true);
    rejects_confirmation(&value);
}

#[test]
fn byte_budget_utf8_trailing_values_and_error_messages_are_bounded() {
    let valid = bytes(&reserved());
    for invalid in [
        Vec::new(),
        vec![b' '; MAX_RESPONSE_BYTES + 1],
        vec![0xff, 0xfe],
        b"null".to_vec(),
    ] {
        assert!(parse_reservation_response(&invalid, &selected()).is_err());
    }
    let mut trailing = valid.clone();
    trailing.extend_from_slice(b" {}");
    assert!(parse_reservation_response(&trailing, &selected()).is_err());
    let mut whitespace = valid;
    whitespace.extend_from_slice(b" \r\n\t");
    assert!(parse_reservation_response(&whitespace, &selected()).is_ok());
    let error = parse_reservation_response(b"{\"secret-mail-body\":", &selected()).unwrap_err();
    let rendered = format!("{error:?}");
    assert!(!rendered.contains("secret-mail-body"));
    assert!(rendered.contains("action_engine:invalid_record"));
}

#[test]
fn reserved_identity_hash_context_and_authorization_facts_must_be_coherent() {
    for (key, bad) in [
        ("proposalId", json!("foreign-proposal")),
        ("fingerprint", json!("c".repeat(64))),
        ("expectedResourcesHash", json!("A".repeat(64))),
        ("expectedContextRevision", json!("context:foreign")),
        ("authorizationRevision", json!("not an identifier")),
        ("reservationId", json!("not-uuid")),
        ("installationId", json!(INSTALLATION.to_ascii_uppercase())),
        ("quoteId", json!("00000000-0000-0000-0000-000000000000")),
    ] {
        let mut value = reserved();
        value[key] = bad;
        rejects_reservation(&value);
    }
    for (container, key, bad) in [
        ("actor", "organizationId", "foreign-company"),
        ("source", "id", "foreign-source"),
        ("source", "revision", "source:foreign"),
        ("source", "organizationId", "foreign-company"),
        ("source", "senderEmail", "Synthetic@example.test"),
    ] {
        let mut value = reserved();
        value[container][key] = json!(bad);
        rejects_reservation(&value);
    }
}

#[test]
fn plan_ready_contract_rejects_tax_currency_status_customer_and_source_mismatch() {
    for (key, bad) in [
        ("currency", json!("USD")),
        ("status", json!("needs_review")),
        ("requiresHumanValidation", json!(false)),
        ("contextRevision", json!("context:foreign")),
        ("sourceRevision", json!("source:foreign")),
        ("organizationId", json!("foreign-company")),
        ("title", json!("a different title")),
        ("confidence", json!(0.94)),
        ("confidence", json!(1.01)),
        ("reasons", json!(["low_confidence"])),
    ] {
        let mut value = reserved();
        edit_plan(&mut value, |plan| plan[key] = bad);
        rejects_reservation(&value);
    }
    for (key, bad) in [("name", "Someone else"), ("email", "other@example.test")] {
        let mut value = reserved();
        edit_plan(&mut value, |plan| plan["customer"][key] = json!(bad));
        rejects_reservation(&value);
    }
}

#[test]
fn integer_money_rounding_bounds_and_evidence_are_checked_without_float_coercion() {
    for (key, bad) in [
        ("quantityMilli", json!(0)),
        ("quantityMilli", json!(1_000_001)),
        ("quantityMilli", json!(3000.0)),
        ("unitPriceCents", json!(-1)),
        ("unitPriceCents", json!(1_000_000_001_i64)),
        ("taxRateBp", json!(10_001)),
        ("netCents", json!(59704)),
        ("evidence", json!("An absent sentence")),
        ("evidence", json!("x".repeat(601))),
    ] {
        let mut value = reserved();
        edit_plan(&mut value, |plan| plan["lines"][0][key] = bad);
        rejects_reservation(&value);
    }
    let mut duplicated = reserved();
    edit_plan(&mut duplicated, |plan| {
        let line = plan["lines"][0].clone();
        plan["lines"].as_array_mut().unwrap().push(line);
        plan["netCents"] = json!(119406);
    });
    rejects_reservation(&duplicated);
    let mut rounded = reserved();
    edit_plan(&mut rounded, |plan| {
        plan["lines"][0]["quantityMilli"] = json!(1500);
        plan["lines"][0]["unitPriceCents"] = json!(101);
        plan["lines"][0]["netCents"] = json!(152);
        plan["netCents"] = json!(152);
    });
    // The wire checks exact integer rounding, not the native writer's quantity
    // evidence/catalogue authority; that writer will separately reject 1.5 here.
    assert!(parse_reservation_response(&bytes(&rounded), &selected()).is_ok());
}

#[test]
fn utf16_caps_plan_budget_and_unpaired_surrogates_are_not_silently_truncated() {
    let mut value = reserved();
    value["source"]["body"] = json!("👩".repeat(1501));
    rejects_reservation(&value);
    let mut value = reserved();
    value["canonicalPlanJson"] = json!(" ".repeat(MAX_PLAN_BYTES + 1));
    value["fingerprint"] = json!(sha(value["canonicalPlanJson"].as_str().unwrap().as_bytes()));
    rejects_reservation(&value);
    let raw = serde_json::to_string(&reserved()).unwrap();
    let invalid_unicode = raw.replacen("Atelier Été 👩‍🔧", "\\ud800", 1);
    assert!(parse_reservation_response(invalid_unicode.as_bytes(), &selected()).is_err());
    let mut split_surrogate_title = reserved();
    split_surrogate_title["source"]["subject"] = json!(format!("{}👩", "a".repeat(159)));
    rejects_reservation(&split_surrogate_title);
}

#[test]
fn existing_customer_ids_are_not_replaced_with_generated_new_customer_ids() {
    let mut value = reserved();
    value["customerId"] = json!("existing-customer:1");
    edit_plan(&mut value, |plan| {
        plan["customer"] = json!({"kind":"existing","id":"existing-customer:1","revision":"customer:7","name":"Existing customer"});
    });
    assert_eq!(parsed_reserved(&value).customer_id, "existing-customer:1");
    let mut mismatch = value.clone();
    mismatch["customerId"] = json!(CUSTOMER);
    rejects_reservation(&mismatch);
    let mut new_without_uuid = reserved();
    new_without_uuid["customerId"] = json!("existing-customer:1");
    rejects_reservation(&new_without_uuid);
}

#[test]
fn into_input_revalidates_owned_fields_and_never_accepts_server_local_origin_fields() {
    for (scope, nonce) in [
        ("not-a-workspace".to_string(), NONCE.to_string()),
        (SCOPE.to_string(), "nonce".to_string()),
        (SCOPE.to_string(), "A".repeat(32)),
    ] {
        assert!(parsed_reserved(&reserved())
            .into_input(scope, nonce)
            .is_err());
    }
    let mut changed = parsed_reserved(&reserved());
    changed.authorization_revision = "authority with spaces".into();
    assert!(changed.into_input(SCOPE.into(), NONCE.into()).is_err());
    for key in [
        "expectedWorkspaceScope",
        "expectedMemberContextNonce",
        "permission",
        "plan",
    ] {
        let mut supplied = reserved();
        supplied[key] = json!("server-must-not-supply-this");
        rejects_reservation(&supplied);
    }
}

// A14 work summaries are closed selectors, not executable plans. These tests
// are written for Rust's real codec and perform no HTTP or native execution.
fn work_selected(limit: u32) -> WorkDiscoverySelection {
    WorkDiscoverySelection {
        limit,
        cursor: None,
    }
}

fn discovered() -> Value {
    json!({
        "schemaVersion": 1,
        "state": "discovered",
        "sourceIds": ["source:1", "source:2"],
        "nextCursor": null
    })
}

fn prepared() -> Value {
    json!({
        "schemaVersion": 1,
        "state": "prepared",
        "sourceId": "source:1",
        "proposalId": "proposal:1",
        "fingerprint": "a".repeat(64),
        "disposition": "ready",
        "reasons": [],
        "requiresHumanValidation": true
    })
}

#[test]
fn work_paths_and_selector_only_requests_are_exact_without_a10_changes() {
    assert_eq!(WORK_PATH, "/api/account/automation/quote-work");
    assert_eq!(PATH, "/api/account/automation/quote-execution");
    assert_eq!(MAX_RESPONSE_BYTES, 128 * 1024);
    let request = discovery_request(&work_selected(20)).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&request).unwrap(),
        json!({"schemaVersion":1,"operation":"discover","limit":20,"cursor":null})
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&preparation_request("source:1").unwrap()).unwrap(),
        json!({"schemaVersion":1,"operation":"prepare","sourceId":"source:1"})
    );
    assert!(request.len() <= MAX_WORK_REQUEST_BYTES);
}

#[test]
fn work_request_limits_and_cursor_character_bounds_are_enforced() {
    for limit in [0, 51, u32::MAX] {
        let selection = work_selected(limit);
        assert!(discovery_request(&selection).is_err());
        assert!(parse_discovery_response(&bytes(&discovered()), &selection).is_err());
    }
    for cursor in ["", "a=", "a/b", "a+b", "a b", "é", "a\n", "a."] {
        let selection = WorkDiscoverySelection {
            limit: 1,
            cursor: Some(cursor.into()),
        };
        assert!(discovery_request(&selection).is_err());
        assert!(parse_discovery_response(&bytes(&discovered()), &selection).is_err());
    }
    let mut selection = WorkDiscoverySelection {
        limit: 50,
        cursor: Some("aZ0_-".repeat(819)[..4095].into()),
    };
    selection.cursor.as_mut().unwrap().push('A');
    let encoded = discovery_request(&selection).unwrap();
    assert!(encoded.len() <= MAX_WORK_REQUEST_BYTES);
    assert_eq!(
        serde_json::from_slice::<Value>(&encoded).unwrap()["cursor"],
        json!(selection.cursor)
    );
    selection.cursor.as_mut().unwrap().push('A');
    assert!(discovery_request(&selection).is_err());
}

#[test]
fn work_source_selectors_use_ascii_ids_and_do_not_require_uuids() {
    for source in ["s", "source_.:@-9", &"s".repeat(160)] {
        assert!(preparation_request(source).is_ok());
    }
    for source in ["", "_source", "source/path", "source space", "é", &"s".repeat(161)] {
        assert!(preparation_request(source).is_err());
        assert!(parse_preparation_response(&bytes(&prepared()), source).is_err());
    }
    let value = parse_preparation_response(&bytes(&prepared()), "source:1").unwrap();
    assert_eq!(value.proposal_id, "proposal:1");
    assert_eq!(value.disposition, QuoteWorkDisposition::Ready);
    assert!(value.requires_human_validation);
}

#[test]
fn work_discovery_accepts_empty_partial_and_complete_pages() {
    let page = parse_discovery_response(&bytes(&discovered()), &work_selected(2)).unwrap();
    assert_eq!(page.source_ids, vec!["source:1", "source:2"]);
    assert_eq!(page.next_cursor, None);
    let mut empty = discovered();
    empty["sourceIds"] = json!([]);
    assert!(parse_discovery_response(&bytes(&empty), &work_selected(1)).is_ok());
    assert!(parse_discovery_response(&bytes(&discovered()), &work_selected(3)).is_ok());
    let mut full = discovered();
    full["nextCursor"] = json!("aZ0_-");
    assert_eq!(
        parse_discovery_response(&bytes(&full), &work_selected(2)).unwrap().next_cursor,
        Some("aZ0_-".into())
    );
}

#[test]
fn work_discovery_largest_valid_page_fits_its_separate_response_budget() {
    let ids: Vec<String> = (0..50).map(|index| format!("s{index:02}{}", "x".repeat(157))).collect();
    assert!(ids.iter().all(|id| id.len() == 160));
    let value = json!({
        "schemaVersion":1,"state":"discovered","sourceIds":ids,"nextCursor":"a".repeat(4096)
    });
    let encoded = bytes(&value);
    assert!(encoded.len() > MAX_WORK_REQUEST_BYTES);
    assert!(encoded.len() <= MAX_WORK_RESPONSE_BYTES);
    let page = parse_discovery_response(&encoded, &work_selected(50)).unwrap();
    assert_eq!(page.source_ids.len(), 50);
    assert_eq!(page.next_cursor.unwrap().len(), 4096);
}

#[test]
fn work_discovery_requires_explicit_next_cursor_and_every_closed_field() {
    for key in ["schemaVersion", "state", "sourceIds", "nextCursor"] {
        let mut value = discovered();
        value.as_object_mut().unwrap().remove(key);
        assert!(parse_discovery_response(&bytes(&value), &work_selected(2)).is_err());
    }
    for key in ["organizationId", "installationId", "permission", "plan", "cursor", "limit"] {
        let mut value = discovered();
        value[key] = json!("not-a-wire-field");
        assert!(parse_discovery_response(&bytes(&value), &work_selected(2)).is_err());
    }
}

#[test]
fn work_discovery_rejects_duplicate_ids_overfull_pages_and_bad_ids() {
    for ids in [
        json!(["source:1", "source:1"]),
        json!(["source:1", "source:2", "source:3"]),
        json!([""]),
        json!(["source/path"]),
        json!(["é"]),
        json!(["s".repeat(161)]),
        json!([1]),
        json!([null]),
        json!([["source:1"]]),
    ] {
        let mut value = discovered();
        value["sourceIds"] = ids;
        assert!(parse_discovery_response(&bytes(&value), &work_selected(2)).is_err());
    }
}

#[test]
fn work_discovery_cursor_requires_full_page_and_bounded_base64url_characters() {
    let mut value = discovered();
    value["nextCursor"] = json!("cursor");
    assert!(parse_discovery_response(&bytes(&value), &work_selected(3)).is_err());
    for next in [json!(""), json!("a="), json!("a/b"), json!("é"), json!("a".repeat(4097)), json!(0), json!(false), json!({}), json!([])] {
        value["nextCursor"] = next;
        assert!(parse_discovery_response(&bytes(&value), &work_selected(2)).is_err());
    }
}

#[test]
fn work_discovery_rejects_duplicate_json_keys_including_escaped_names() {
    for raw in [
        r#"{"schemaVersion":1,"schemaVersion":1,"state":"discovered","sourceIds":[],"nextCursor":null}"#,
        r#"{"schemaVersion":1,"state":"discovered","state":"discovered","sourceIds":[],"nextCursor":null}"#,
        r#"{"schemaVersion":1,"state":"discovered","sourceIds":[],"source\u0049ds":[],"nextCursor":null}"#,
        r#"{"schemaVersion":1,"state":"discovered","sourceIds":[],"nextCursor":null,"next\u0043ursor":null}"#,
    ] {
        assert!(parse_discovery_response(raw.as_bytes(), &work_selected(2)).is_err());
    }
}

#[test]
fn work_summary_decoders_reject_bad_utf8_json_extra_data_and_oversized_responses() {
    let too_long = vec![b' '; MAX_WORK_RESPONSE_BYTES + 1];
    for raw in [&[][..], &[0xff][..], b"null", b"[]", b"{}", b"{}{}", &too_long] {
        assert!(parse_discovery_response(raw, &work_selected(2)).is_err());
        assert!(parse_preparation_response(raw, "source:1").is_err());
    }
    let mut discovery = bytes(&discovered());
    discovery.extend_from_slice(b" null");
    assert!(parse_discovery_response(&discovery, &work_selected(2)).is_err());
    let mut preparation = bytes(&prepared());
    preparation.push(0xff);
    assert!(parse_preparation_response(&preparation, "source:1").is_err());
    let bad_surrogate = r#"{"schemaVersion":1,"state":"discovered","sourceIds":["\ud800"],"nextCursor":null}"#;
    assert!(parse_discovery_response(bad_surrogate.as_bytes(), &work_selected(2)).is_err());
}

#[test]
fn work_summary_schema_and_state_are_not_coerced_or_cross_decoded() {
    for version in [json!(0), json!(2), json!(1.0), json!("1"), json!(true), json!(null)] {
        let mut discovery = discovered();
        discovery["schemaVersion"] = version.clone();
        assert!(parse_discovery_response(&bytes(&discovery), &work_selected(2)).is_err());
        let mut preparation = prepared();
        preparation["schemaVersion"] = version;
        assert!(parse_preparation_response(&bytes(&preparation), "source:1").is_err());
    }
    assert!(parse_discovery_response(&bytes(&prepared()), &work_selected(2)).is_err());
    assert!(parse_preparation_response(&bytes(&discovered()), "source:1").is_err());
    for state in ["error", "reserved", "confirmed", "Prepared", "discovered"] {
        let mut value = prepared();
        value["state"] = json!(state);
        assert!(parse_preparation_response(&bytes(&value), "source:1").is_err());
    }
}

#[test]
fn work_prepared_is_correlated_to_source_and_lowercase_plan_fingerprint() {
    assert!(parse_preparation_response(&bytes(&prepared()), "another-source").is_err());
    for (key, value) in [
        ("sourceId", json!("another-source")),
        ("proposalId", json!("_proposal")),
        ("proposalId", json!("p".repeat(161))),
        ("proposalId", json!("proposal path")),
        ("fingerprint", json!("A".repeat(64))),
        ("fingerprint", json!("g".repeat(64))),
        ("fingerprint", json!("a".repeat(63))),
        ("fingerprint", json!("a".repeat(65))),
        ("fingerprint", json!(null)),
    ] {
        let mut summary = prepared();
        summary[key] = value;
        assert!(parse_preparation_response(&bytes(&summary), "source:1").is_err());
    }
    let parsed = parse_preparation_response(&bytes(&prepared()), "source:1").unwrap();
    assert_eq!(parsed.source_id, "source:1");
    assert_eq!(parsed.fingerprint, "a".repeat(64));
    assert!(parsed.reasons.is_empty());
}

#[test]
fn work_prepared_requires_all_fields_and_rejects_plan_price_and_authority_leaks() {
    for key in ["schemaVersion", "state", "sourceId", "proposalId", "fingerprint", "disposition", "reasons", "requiresHumanValidation"] {
        let mut value = prepared();
        value.as_object_mut().unwrap().remove(key);
        assert!(parse_preparation_response(&bytes(&value), "source:1").is_err());
    }
    for key in ["plan", "canonicalPlanJson", "customer", "netCents", "currency", "confidence", "actor", "organizationId", "installationId", "authorizationRevision", "permission"] {
        let mut value = prepared();
        value[key] = json!("not-a-summary-field");
        assert!(parse_preparation_response(&bytes(&value), "source:1").is_err());
    }
}

#[test]
fn work_prepared_requires_literal_human_validation_and_closed_disposition() {
    for human in [json!(false), json!("true"), json!(1), json!(null)] {
        let mut value = prepared();
        value["requiresHumanValidation"] = human;
        assert!(parse_preparation_response(&bytes(&value), "source:1").is_err());
    }
    for disposition in [json!("Ready"), json!("confirmed"), json!("needsReview"), json!(null), json!({})] {
        let mut value = prepared();
        value["disposition"] = disposition;
        assert!(parse_preparation_response(&bytes(&value), "source:1").is_err());
    }
}

#[test]
fn work_prepared_review_reasons_match_all_thirteen_server_literals_in_order() {
    let reasons = [
        "missing_customer_name", "ambiguous_customer", "archived_customer",
        "missing_quantity", "ambiguous_quantity", "unsupported_quantity",
        "missing_article", "too_many_candidates", "source_too_long", "low_confidence",
        "not_quote_request", "invalid_decision", "provider_unavailable",
    ];
    let mut value = prepared();
    value["disposition"] = json!("needs_review");
    value["reasons"] = json!(reasons);
    let summary = parse_preparation_response(&bytes(&value), "source:1").unwrap();
    assert_eq!(summary.disposition, QuoteWorkDisposition::NeedsReview);
    assert_eq!(serde_json::to_value(&summary.reasons).unwrap(), json!(reasons));
    assert_eq!(summary.reasons.len(), 13);
    assert!(summary.requires_human_validation);
}

#[test]
fn work_prepared_rejects_empty_review_duplicate_unknown_or_inconsistent_reasons() {
    let mut value = prepared();
    value["reasons"] = json!(["missing_article"]);
    assert!(parse_preparation_response(&bytes(&value), "source:1").is_err());
    value["disposition"] = json!("needs_review");
    for reasons in [
        json!([]), json!(["missing_article", "missing_article"]),
        json!(["too_many_lines"]), json!(["MissingArticle"]),
        json!(vec!["missing_article"; 14]), json!([null]), json!([1]),
        json!([{}]), json!([["missing_article"]]), json!(null),
    ] {
        value["reasons"] = reasons;
        assert!(parse_preparation_response(&bytes(&value), "source:1").is_err());
    }
}

#[test]
fn work_prepared_rejects_duplicate_json_keys_even_when_identical_or_escaped() {
    let normal = serde_json::to_string(&prepared()).unwrap();
    for (key, literal, escaped) in [
        ("schemaVersion", "1".to_string(), "schema\\u0056ersion"),
        ("state", "\"prepared\"".to_string(), "sta\\u0074e"),
        ("sourceId", "\"source:1\"".to_string(), "source\\u0049d"),
        ("proposalId", "\"proposal:1\"".to_string(), "proposal\\u0049d"),
        ("fingerprint", format!("\"{}\"", "a".repeat(64)), "finger\\u0070rint"),
        ("disposition", "\"ready\"".to_string(), "dis\\u0070osition"),
        ("reasons", "[]".to_string(), "rea\\u0073ons"),
        ("requiresHumanValidation", "true".to_string(), "requiresHuman\\u0056alidation"),
    ] {
        for duplicate_key in [key, escaped] {
            let duplicate = format!("{{\"{duplicate_key}\":{literal},{}", &normal[1..]);
            assert!(parse_preparation_response(duplicate.as_bytes(), "source:1").is_err());
        }
    }
}

#[test]
fn work_error_responses_never_become_empty_discovery_or_prepared_success() {
    for code in ["invalid_request", "forbidden", "stale_plan", "review_required", "busy", "uncertain", "service_unavailable"] {
        let error = bytes(&json!({"schemaVersion":1,"state":"error","code":code,"message":"Private service unavailable"}));
        assert!(parse_discovery_response(&error, &work_selected(2)).is_err());
        assert!(parse_preparation_response(&error, "source:1").is_err());
    }
}
