use super::*;
use serde_json::{json, Value};

// Synthetic identities, exact bytes emitted by the real local D1 test. The
// producer first rereads the proof and verifies that late retirement is fenced.
const PROOF: &str = include_str!("d1-cancellation.fixture.json");
fn intent() -> Intent {
    let mut value: Value = serde_json::from_str(PROOF).unwrap();
    for field in [
        "registered_at",
        "binding_sha256",
        "cancelled",
        "retired",
        "business_revision_changed",
        "transaction_acknowledged",
    ] {
        value.as_object_mut().unwrap().remove(field);
    }
    value["format"] = json!("zentra-conflict-application");
    value["proposal_sha256"] = json!("a".repeat(64));
    value["source_revision"] = json!(value["base_revision"].as_i64().unwrap() - 1);
    value["replacement_capture_generation"] = json!("537addeb-e142-4883-8398-a62d370d4956");
    value["received_transaction_id"] = json!("536f8b8e-ad12-4949-a6d2-f9e42da38883");
    Intent::read(value.to_string().as_bytes()).unwrap()
}
#[test]
fn exact_d1_cancellation_wire_proof_preserves_the_request_binding_order() {
    let expected = intent();
    Receipt::read(PROOF.as_bytes(), &expected).unwrap();
    let reordered: Value = serde_json::from_str(PROOF).unwrap();
    Receipt::read(reordered.to_string().as_bytes(), &expected).unwrap();
    assert_eq!(
        expected.request().binding_sha256().unwrap(),
        reordered["binding_sha256"]
    );
}
#[test]
fn malformed_or_rebound_cancellation_can_never_authorize_release() {
    let expected = intent();
    let proof: Value = serde_json::from_str(PROOF).unwrap();
    for field in [
        "organization_id",
        "installation_id",
        "resolution_id",
        "generation",
        "capture_generation",
        "first_sequence",
        "last_sequence",
        "receipt_sha256",
        "review_id",
        "decision_sha256",
        "binding_sha256",
        "registered_at",
        "format",
    ] {
        let mut changed = proof.clone();
        changed[field] = json!("different");
        assert!(
            Receipt::read(changed.to_string().as_bytes(), &expected).is_err(),
            "{field}"
        );
    }
    for (field, value) in [
        ("version", json!(2)),
        ("base_revision", json!(3)),
        ("retired", json!(true)),
        ("cancelled", json!(false)),
        ("business_revision_changed", json!(true)),
        ("transaction_acknowledged", json!(true)),
        ("revision", json!(3)),
    ] {
        let mut changed = proof.clone();
        changed[field] = value;
        assert!(
            Receipt::read(changed.to_string().as_bytes(), &expected).is_err(),
            "{field}"
        );
    }
    let duplicate = PROOF.replacen("\"version\": 1", "\"version\": 1, \"version\": 1", 1);
    assert_ne!(duplicate, PROOF);
    assert!(Receipt::read(duplicate.as_bytes(), &expected).is_err());
    assert!(Receipt::read(
        format!("{PROOF}{}", " ".repeat(MAX_PROOF_BYTES)).as_bytes(),
        &expected
    )
    .is_err());
    let mut altered = expected.request();
    altered.last_sequence = "9".into();
    let mut rebound = proof;
    rebound["last_sequence"] = json!(altered.last_sequence);
    rebound["binding_sha256"] = json!(altered.binding_sha256().unwrap());
    assert!(Receipt::read(rebound.to_string().as_bytes(), &expected).is_err());
}
