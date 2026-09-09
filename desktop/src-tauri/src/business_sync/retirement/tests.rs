use super::*;

// Exact server response from native-replacement-export-02/d1-proof.json.
// It uses synthetic organization/session bindings and real D1 retirement logic.
const RECEIPT: &str = r#"{
  "format":"zentra-conflict-retirement","version":1,"organization_id":"org_first",
  "installation_id":"daef79a6-14a7-454b-9ec0-41b1abee6c59",
  "resolution_id":"fe1361b3-7237-4413-951d-06c470cd7486",
  "generation":"ea122a1c-c88c-48cc-81b3-b5b34874da78",
  "capture_generation":"dd7293d6-7ac4-4c64-bc70-1b406f080116",
  "first_sequence":"1","last_sequence":"4","base_revision":2,
  "receipt_sha256":"d1476c04f5583f431b987d34a27f492ac188691f94e48523264f413da99cfdf6",
  "review_id":"d9a5d0eb958f0c19b4011fb6e09d8bc87474c1d15144b177455b992b7b6ce287",
  "decision_sha256":"1974f9a6f8e6068af6af03cfdcaf72f2d995ad668cbd1316376a826e133929f5",
  "binding_sha256":"4db4f89142d311bbb1686ded080932cbf249db2a9f1a9530f159bc1f66d6bb5a",
  "registered_at":"2026-09-09T22:26:13.983Z","retired":true,
  "business_revision_changed":false,"transaction_acknowledged":false
}"#;

fn intent() -> Intent {
    let proof: Value = serde_json::from_str(RECEIPT).unwrap();
    let mut value = proof;
    for field in ["binding_sha256", "registered_at", "retired", "business_revision_changed", "transaction_acknowledged"] {
        value.as_object_mut().unwrap().remove(field);
    }
    value["format"] = json!("zentra-conflict-application");
    value["proposal_sha256"] = json!("a".repeat(64));
    value["source_revision"] = json!(1);
    value["replacement_capture_generation"] = json!("537addeb-e142-4883-8398-a62d370d4956");
    value["received_transaction_id"] = json!("536f8b8e-ad12-4949-a6d2-f9e42da38883");
    Intent::read(value.to_string().as_bytes()).unwrap()
}

#[test]
fn accepts_exact_d1_proof_and_recreates_the_server_binding_order() {
    let intent = intent();
    assert_eq!(intent.request().binding_sha256().unwrap(), "4db4f89142d311bbb1686ded080932cbf249db2a9f1a9530f159bc1f66d6bb5a");
    Receipt::read(RECEIPT.as_bytes(), &intent).unwrap();
    let reordered: Value = serde_json::from_str(RECEIPT).unwrap();
    Receipt::read(reordered.to_string().as_bytes(), &intent).unwrap();
}

#[test]
fn refuses_wrong_identity_range_hash_version_flags_or_unknown_proof_fields() {
    let intent = intent();
    let proof: Value = serde_json::from_str(RECEIPT).unwrap();
    for field in ["organization_id", "installation_id", "resolution_id", "generation", "capture_generation", "first_sequence", "last_sequence", "receipt_sha256", "review_id", "decision_sha256", "binding_sha256", "registered_at", "format"] {
        let mut changed = proof.clone();
        changed[field] = json!("different");
        assert!(Receipt::read(changed.to_string().as_bytes(), &intent).is_err(), "{field}");
    }
    for (field, value) in [("version", json!(2)), ("base_revision", json!(3)), ("retired", json!(false)), ("business_revision_changed", json!(true)), ("transaction_acknowledged", json!(true)), ("installed", json!(true))] {
        let mut changed = proof.clone(); changed[field] = value;
        assert!(Receipt::read(changed.to_string().as_bytes(), &intent).is_err(), "{field}");
    }
    let duplicate = RECEIPT.replacen("\"version\":1", "\"version\":1,\"version\":1", 1);
    assert!(Receipt::read(duplicate.as_bytes(), &intent).is_err());
    let mut padded = RECEIPT.to_owned(); padded.push_str(&" ".repeat(MAX_PROOF_BYTES));
    assert!(Receipt::read(padded.as_bytes(), &intent).is_err());
}

#[test]
fn validates_intent_before_any_durable_freeze_or_request() {
    let value = serde_json::to_value(intent()).unwrap();
    for (field, changed) in [
        ("first_sequence", json!("01")), ("first_sequence", json!("0")),
        ("last_sequence", json!("200001")), ("last_sequence", json!("9223372036854775808")),
        ("source_revision", json!(0)), ("source_revision", json!(2)),
        ("base_revision", json!(9_007_199_254_740_992i64)),
        ("base_revision", json!(2.0)), ("version", json!(2)), ("proposal_sha256", json!("A".repeat(64))),
        ("organization_id", json!("")), ("installation_id", json!("not-a-device")),
        ("received_transaction_id", json!("not-a-transaction")), ("extra", json!(true)),
    ] {
        let mut wrong = value.clone(); wrong[field] = changed;
        assert!(Intent::read(wrong.to_string().as_bytes()).is_err(), "{field}");
    }
    let mut exact = value;
    exact["first_sequence"] = json!("9223372036854775806");
    exact["last_sequence"] = json!("9223372036854775807");
    Intent::read(exact.to_string().as_bytes()).unwrap();
    exact["replacement_capture_generation"] = exact["capture_generation"].clone();
    assert!(Intent::read(exact.to_string().as_bytes()).is_err());
}

#[test]
fn accepts_fresh_response_order_but_never_a_rebound_decision() {
    let intent = intent();
    let mut changed: Value = serde_json::from_str(RECEIPT).unwrap();
    let mut different = intent.request(); different.last_sequence = "5".into();
    changed["last_sequence"] = json!("5");
    changed["binding_sha256"] = json!(different.binding_sha256().unwrap());
    assert!(Receipt::read(changed.to_string().as_bytes(), &intent).is_err());
}
