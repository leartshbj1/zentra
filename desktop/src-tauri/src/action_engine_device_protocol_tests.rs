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
    let mut missing = value.clone();
    missing["receipt"]
        .as_object_mut()
        .unwrap()
        .remove("quoteNumber");
    rejects_confirmation(&missing);
    rejects_reservation(&missing);
    for number in [json!(""), json!("D-001"), json!(0), json!(false), json!({})] {
        let mut wrong = value.clone();
        wrong["receipt"]["quoteNumber"] = number;
        rejects_confirmation(&wrong);
        rejects_reservation(&wrong);
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
