//! Pure build-ON boundary tests; no HTTP, key, account, licence or business writes.
use super::*;

fn origin() -> Origin {
    Origin { expected_workspace_scope: "workspace-synthetic".into(), expected_member_context_nonce: "a".repeat(32), test_frontdoor: None }
}

#[test]
fn windows_product_build_admits_only_well_formed_origins() {
    assert!(PRODUCT_ENABLED);
    assert_eq!(admission(&origin()), Ok(()));
    assert!(origin().test_frontdoor.is_none());
    for (scope, nonce) in [("", "a".repeat(32)), ("https://example.invalid", "a".repeat(32)),
        ("workspace-synthetic", "A".repeat(32)), ("workspace-synthetic", "a".repeat(31))] {
        let invalid = Origin { expected_workspace_scope: scope.into(), expected_member_context_nonce: nonce, ..origin() };
        assert_eq!(admission(&invalid), Err("invalid_request"));
    }
    // Passing this pure gate is neither account capture nor paid authorization.
}

#[test]
fn windows_product_json_cannot_supply_business_authority_or_private_grant() {
    let value = json!({"expectedWorkspaceScope":"workspace-synthetic","expectedMemberContextNonce":"a".repeat(32)});
    assert!(serde_json::from_value::<Origin>(value.clone()).unwrap().test_frontdoor.is_none());
    for field in ["organizationId", "actor", "url", "plan", "enabled", "testFrontdoor", "test_frontdoor", "grant"] {
        for attempted in [json!(null), json!(true), json!({"allowed":true})] {
            let mut invalid = value.clone(); invalid[field] = attempted;
            assert!(serde_json::from_value::<Origin>(invalid).is_err());
        }
    }
}
