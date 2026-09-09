use super::*;
use serde_json::{json, Value};
pub(super) fn fixture() -> (Value, Vec<u8>, Vec<u8>, Vec<u8>, Expected) {
    let id = "11111111-1111-4111-8111-111111111111";
    let original=serde_json::to_vec(&json!({"version":1,"changes":[{"sequence":"9007199254740993","table":"clients","key_json":"[\"client\"]","operation":"insert",
        "before_json":null,"after_json":"{\"id\":\"client\",\"money\":9223372036854775807}","source_rowid":"1","files_before":[],"files_after":[]}]})).unwrap();
    let positions=serde_json::to_vec(&json!({"version":1,"part_index":0,"source_sha256":digest(&original),"positions":[{"table":"clients","key_json":"[\"client\"]","canonical_rowid":"9007199254740993"}]})).unwrap();
    let manifest=serde_json::to_vec(&json!({"format":"zentra-business-transaction","version":1,"schema_version":60,"contract_sha256":snapshot::contract_hash().unwrap(),"organization_id":"org",
        "installation_id":id,"generation":id,"capture_generation":id,"bootstrap_transfer_id":id,"transaction_id":id,"base_revision":1,
        "first_sequence":"9007199254740993","last_sequence":"9007199254740993","change_count":1,"size_bytes":original.len(),
        "chunks":[{"sha256":digest(&original),"size_bytes":original.len(),"change_count":1}],"files":[]})).unwrap();
    let bundle = json!({"format":"zentra-canonical-transaction-bundle","version":1,"schema_version":60,"contract_sha256":snapshot::contract_hash().unwrap(),
        "organization_id":"org","origin_installation_id":id,"generation":id,"capture_generation":id,"transaction_id":id,"source_transfer_id":id,"source_revision":1,
        "original_manifest_sha256":digest(&manifest),"review_attempt":id,"review_validator_sha256":"a".repeat(64),"validation_sha256":"b".repeat(64),
        "fingerprint_version":2,"fingerprint_contract_sha256":fingerprint_contract().unwrap(),"source_state_sha256":"c".repeat(64),"target_state_sha256":"d".repeat(64),"source_rows":1,"target_rows":2,
        "parts":[{"source_sha256":digest(&original),"source_bytes":original.len(),"positions_sha256":digest(&positions),"positions_bytes":positions.len(),"change_count":1}]});
    let expected = expectation(&receipt(&bundle)).unwrap();
    (bundle, manifest, original, positions, expected)
}
#[test]
fn decoding_uses_canonical_i64_positions_and_preserves_original_images() {
    let (bundle, manifest, original, positions, expected) = fixture();
    let mut decoder =
        Decoder::new(&serde_json::to_vec(&bundle).unwrap(), &manifest, &expected).unwrap();
    let rows = decoder.part(&original, &positions).unwrap();
    assert_eq!(rows[0].canonical_rowid, 9_007_199_254_740_993);
    assert!(rows[0]
        .after_json
        .as_ref()
        .unwrap()
        .contains("9223372036854775807"));
    decoder.finish().unwrap();
    assert!(decoder.part(&original, &positions).is_err());
}
#[test]
fn decoding_requires_bound_context_complete_parts_and_exact_bytes() {
    let (bundle, manifest, original, positions, mut expected) = fixture();
    let raw = serde_json::to_vec(&bundle).unwrap();
    for field in ["organization", "generation", "revision", "hash"] {
        match field {
            "organization" => expected.receipt.organization_id = "foreign".into(),
            "generation" => expected.receipt.generation = "foreign".into(),
            "revision" => expected.receipt.source_revision = 2,
            _ => expected.receipt.bundle_sha256 = "0".repeat(64),
        };
        assert!(Decoder::new(&raw, &manifest, &expected).is_err());
        expected = fixture().4;
    }
    assert!(Decoder::new(&raw, &manifest, &expected)
        .unwrap()
        .finish()
        .is_err());
    for changed in [true, false] {
        let mut decoder = Decoder::new(&raw, &manifest, &expected).unwrap();
        let mut a = original.clone();
        let mut b = positions.clone();
        if changed {
            a[0] ^= 1;
        } else {
            b[0] ^= 1;
        }
        assert!(decoder.part(&a, &b).is_err());
    }
    let duplicate = String::from_utf8(raw.clone())
        .unwrap()
        .replacen('{', "{\"version\":1,", 1);
    expected.receipt.bundle_sha256 = digest(duplicate.as_bytes());
    assert!(Decoder::new(duplicate.as_bytes(), &manifest, &expected).is_err());
}
#[test]
fn forged_position_catalogues_fail_even_when_their_transport_hashes_match() {
    for mode in [
        "order", "key", "table", "count", "integer", "overflow", "source",
    ] {
        let (mut bundle, manifest, original, positions, mut expected) = fixture();
        let mut p: Value = serde_json::from_slice(&positions).unwrap();
        match mode {
            "order" => p["part_index"] = json!(1),
            "key" => p["positions"][0]["key_json"] = json!("[\"other\"]"),
            "table" => p["positions"][0]["table"] = json!("invoices"),
            "count" => p["positions"] = json!([]),
            "integer" => p["positions"][0]["canonical_rowid"] = json!("01"),
            "overflow" => p["positions"][0]["canonical_rowid"] = json!("9223372036854775808"),
            _ => p["source_sha256"] = json!("e".repeat(64)),
        }
        let p = serde_json::to_vec(&p).unwrap();
        bundle["parts"][0]["positions_sha256"] = json!(digest(&p));
        bundle["parts"][0]["positions_bytes"] = json!(p.len());
        let raw = serde_json::to_vec(&bundle).unwrap();
        expected.receipt.bundle_sha256 = digest(&raw);
        assert!(
            Decoder::new(&raw, &manifest, &expected)
                .unwrap()
                .part(&original, &p)
                .is_err(),
            "{mode}"
        );
    }
}

pub(super) fn receipt(bundle: &Value) -> Value {
    json!({"format":"zentra-canonical-transaction-receipt","version":1,
        "transaction_id":bundle["transaction_id"],"organization_id":bundle["organization_id"],
        "generation":bundle["generation"],"origin_installation_id":bundle["origin_installation_id"],
        "capture_generation":bundle["capture_generation"],"source_transfer_id":bundle["source_transfer_id"],
        "source_revision":bundle["source_revision"],"revision":bundle["source_revision"].as_i64().unwrap()+1,
        "manifest_sha256":bundle["original_manifest_sha256"],"bundle_sha256":digest(&serde_json::to_vec(bundle).unwrap()),
        "fingerprint_version":2,"fingerprint_contract_sha256":bundle["fingerprint_contract_sha256"],
        "source_state_sha256":bundle["source_state_sha256"],"target_state_sha256":bundle["target_state_sha256"],
        "validation_sha256":bundle["validation_sha256"],"committed_at":"2026-09-09T12:00:00.000Z"})
}
fn expectation(receipt: &Value) -> AppResult<Expected> {
    let raw = serde_json::to_vec(receipt).unwrap();
    let id = "11111111-1111-4111-8111-111111111111";
    Expected::from_authenticated_receipt(
        &raw,
        ReceiptRequest {
            organization: "org",
            generation: id,
            transaction_id: id,
            source_revision: 1,
            receipt_sha256: &digest(&raw),
        },
    )
}
#[test]
fn receipt_requires_the_discovered_revision_and_supported_contract() {
    let (bundle, _, _, _, _) = fixture();
    let original = receipt(&bundle);
    for (key, value) in [
        ("organization_id", json!("other")),
        ("generation", json!(Uuid::new_v4().to_string())),
        ("transaction_id", json!(Uuid::new_v4().to_string())),
        ("source_revision", json!(2)),
        ("revision", json!(3)),
        ("revision", json!(2.5)),
        ("source_revision", json!(i64::MAX)),
        ("format", json!("prepared")),
        ("version", json!(2)),
        ("fingerprint_version", json!(1)),
        ("fingerprint_contract_sha256", json!("a".repeat(64))),
        ("bundle_sha256", json!("A".repeat(64))),
        ("manifest_sha256", json!("bad")),
        ("source_transfer_id", json!("../other")),
        ("origin_installation_id", json!("bad")),
        ("capture_generation", json!(null)),
        ("source_state_sha256", json!("bad")),
        ("target_state_sha256", json!("bad")),
        ("validation_sha256", json!("bad")),
        ("committed_at", json!("2026-02-30T12:00:00.000Z")),
        ("unexpected", json!(true)),
    ] {
        let mut changed = original.clone();
        changed[key] = value;
        assert!(expectation(&changed).is_err(), "{key}");
    }
    let original = serde_json::to_string(&original).unwrap();
    for raw in [
        original.replacen('{', "{\"version\":1,", 1),
        format!("{original}{}", " ".repeat(16 * 1024)),
    ] {
        assert!(Expected::from_authenticated_receipt(
            raw.as_bytes(),
            ReceiptRequest {
                organization: "org",
                generation: bundle["generation"].as_str().unwrap(),
                transaction_id: bundle["transaction_id"].as_str().unwrap(),
                source_revision: 1,
                receipt_sha256: &digest(raw.as_bytes()),
            }
        )
        .is_err());
    }
    assert!(Expected::from_authenticated_receipt(
        original.as_bytes(),
        ReceiptRequest {
            organization: "org",
            generation: bundle["generation"].as_str().unwrap(),
            transaction_id: bundle["transaction_id"].as_str().unwrap(),
            source_revision: 1,
            receipt_sha256: &"0".repeat(64),
        }
    )
    .is_err());
}
#[test]
fn bundle_cannot_substitute_another_valid_receipt_context() {
    let (bundle, manifest, _, _, _) = fixture();
    for key in [
        "transaction_id",
        "origin_installation_id",
        "capture_generation",
        "source_transfer_id",
        "validation_sha256",
        "source_state_sha256",
        "target_state_sha256",
        "manifest_sha256",
    ] {
        let mut r = receipt(&bundle);
        r[key] = if key.ends_with("sha256") {
            json!("e".repeat(64))
        } else {
            json!(Uuid::new_v4().to_string())
        };
        // The mismatch must fail in the bundle, even for otherwise valid receipts.
        let raw = serde_json::to_vec(&r).unwrap();
        let expected = Expected::from_authenticated_receipt(
            &raw,
            ReceiptRequest {
                organization: "org",
                generation: r["generation"].as_str().unwrap(),
                transaction_id: r["transaction_id"].as_str().unwrap(),
                source_revision: 1,
                receipt_sha256: &digest(&raw),
            },
        )
        .unwrap();
        assert!(
            Decoder::new(&serde_json::to_vec(&bundle).unwrap(), &manifest, &expected).is_err(),
            "{key}"
        );
    }
}
