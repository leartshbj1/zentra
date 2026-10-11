//! Signed synthetic licences for Action Engine fixtures only. This file is
//! included exclusively by cfg(test) modules; no production authority is used.
#![cfg(test)]

use crate::database::LocalStore;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration, Local, Utc};
use ed25519_dalek::{Signer, SigningKey};

pub(super) fn configure(store: &mut LocalStore) {
    // The public test key is scoped to this LocalStore and is not persisted.
    // Reopened stores call only this function, retaining their existing token
    // and protected clock rather than installing or repairing anything.
    store.configure_test_license_key(SigningKey::from_bytes(&[31; 32]).verifying_key().to_bytes());
}

pub(super) fn install(store: &LocalStore) {
    let signing = SigningKey::from_bytes(&[31; 32]);
    let today = Local::now().date_naive();
    let payload = crate::models::LicenseTokenPayload {
        token_version: 2,
        license_id: uuid::Uuid::new_v4().to_string(),
        installation_id: store.installation_id.clone(),
        jti: uuid::Uuid::new_v4().to_string(),
        kid: "hc-prod-v1".into(),
        customer_name: Some("Synthetic Action Engine company".into()),
        access_role: "owner".into(),
        account_user_id: None,
        account_session_id: None,
        plan: crate::license::LICENSE_PLAN.into(),
        price_chf_cents: crate::license::LICENSE_PRICE_CHF_CENTS,
        issued_at: Utc::now().to_rfc3339(),
        valid_from: (today - Duration::days(1)).format("%Y-%m-%d").to_string(),
        valid_until: (today + Duration::days(30)).format("%Y-%m-%d").to_string(),
    };
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
    let token = format!("{encoded}.{}", URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes()));
    let state = store.install_server_issued_license(&token).unwrap();
    assert_eq!(state["status"], "valid");
    assert_eq!(state["read_only"], false);
    // Exercise the real signature, installation, role and protected-clock guard.
    store.require_write_access().unwrap();
    store.clone().require_write_access().unwrap();
}
