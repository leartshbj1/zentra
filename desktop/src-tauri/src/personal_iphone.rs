//! Provisioning exists only in the owner's private iPhone variant.
//! It never changes an existing installation identity or replaces a saved license.
use crate::error::AppResult;

pub(crate) fn initial_identity() -> AppResult<Option<String>> {
    #[cfg(all(target_os = "ios", feature = "personal-iphone"))]
    {
        let key = crate::license::embedded_key()?.ok_or_else(|| crate::error::AppError::Validation("La clé de vérification de votre exemplaire personnel manque.".into()))?;
        return validated_identity(compiled_token(), &key).map(Some);
    }
    #[cfg(not(all(target_os = "ios", feature = "personal-iphone")))]
    Ok(None)
}

#[cfg(any(test, all(target_os = "ios", feature = "personal-iphone")))]
fn validated_identity(token: &str, key: &[u8; 32]) -> AppResult<String> {
    let payload = crate::license::verify_token_with_key(token, key)?;
    let uuid = uuid::Uuid::parse_str(&payload.installation_id).ok();
    if payload.access_role != "owner" || payload.account_user_id.is_some() || payload.account_session_id.is_some()
        || uuid.as_ref().and_then(uuid::Uuid::get_version) != Some(uuid::Version::Random)
    {
        return Err(crate::error::AppError::Validation("La licence fournie ne correspond pas à un exemplaire propriétaire.".into()));
    }
    Ok(uuid.unwrap().to_string())
}

#[cfg(all(target_os = "ios", feature = "personal-iphone"))]
fn compiled_token() -> &'static str {
    include_str!(concat!(env!("OUT_DIR"), "/personal-iphone-license"))
}

#[cfg(all(target_os = "ios", feature = "personal-iphone"))]
pub(crate) async fn activate(store: &crate::database::LocalStore) -> AppResult<()> {
    static ACTIVATION: std::sync::OnceLock<tauri::async_runtime::Mutex<()>> = std::sync::OnceLock::new();
    let _activation = ACTIVATION.get_or_init(|| tauri::async_runtime::Mutex::new(())).lock().await;
    {
        let _guard = store.lock()?;
        let connection = store.connect()?;
        let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM license_state WHERE id=1)", [], |row| row.get(0))?;
        if exists { return Ok(()); }
    }
    // The normal installation path verifies signature, installation binding,
    // server recognition and protected storage before enabling the license.
    store.install_license_token(compiled_token()).await?;
    Ok(())
}

#[cfg(any(test, all(target_os = "ios", feature = "personal-iphone")))]
pub(crate) fn activation_error_state(mut state: serde_json::Value, error: crate::error::AppError) -> serde_json::Value {
    let reason = match error {
        crate::error::AppError::Validation(message) if message.contains("autre installation") =>
            "Cet iPhone possède déjà une identité Zentra différente de celle de la licence intégrée. Copiez l’identifiant affiché ci-dessous et transmettez-le à l’assistance pour activer cet appareil. Vos données sont conservées.".to_owned(),
        crate::error::AppError::Validation(message) => message,
        other => other.to_string(),
    };
    // Keep the actual native entitlement and write restrictions. A failed
    // activation must not prevent setup, recovery or copying the device ID.
    state["personal_activation_pending"] = serde_json::Value::Bool(true);
    state["reason"] = serde_json::Value::String(reason);
    state
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer, SigningKey};
    fn token(role: &str, installation: &str, account: Option<&str>) -> (String,[u8;32]) {
        let key=SigningKey::from_bytes(&[47;32]);
        let payload=serde_json::json!({"token_version":2,"license_id":"lic_personal_test","installation_id":installation,"jti":uuid::Uuid::new_v4().to_string(),"kid":"hc-prod-v1","customer_name":"Owner test","access_role":role,"account_user_id":account,"account_session_id":null,"plan":"zentra-monthly-50-chf","price_chf_cents":5000,"issued_at":"2026-01-01T00:00:00Z","valid_from":"2026-01-01","valid_until":"2036-12-31"});
        let encoded=URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signature=URL_SAFE_NO_PAD.encode(key.sign(encoded.as_bytes()).to_bytes());
        (format!("{encoded}.{signature}"),key.verifying_key().to_bytes())
    }
    #[test] fn public_build_does_not_provision_identity() { assert_eq!(initial_identity().unwrap(),None); }
    #[test] fn failed_activation_keeps_write_restrictions_and_reveals_the_actionable_cause() {
        let state=serde_json::json!({"status":"missing","read_only":true,"can_refresh":false,"installation_id":"existing-device"});
        let next=activation_error_state(state.clone(),crate::error::AppError::Validation("Le service de licence a répondu 503.".into()));
        assert_eq!(next["status"],"missing");
        assert_eq!(next["read_only"],true);
        assert_eq!(next["can_refresh"],false);
        assert_eq!(next["installation_id"],"existing-device");
        assert_eq!(next["personal_activation_pending"],true);
        assert!(next["reason"].as_str().unwrap().contains("503"));
        let mismatch=activation_error_state(state,crate::error::AppError::Validation("Ce jeton appartient à une autre installation Zentra.".into()));
        assert!(mismatch["reason"].as_str().unwrap().contains("Copiez l’identifiant"));
        assert!(!mismatch["reason"].as_str().unwrap().contains("Internet"));
    }
    #[test] fn signed_personal_identity_is_exact_and_invalid_entitlements_fail() {
        let id=uuid::Uuid::new_v4().to_string();
        let (token,key)=token("owner",&id,None);
        assert_eq!(validated_identity(&token,&key).unwrap(),id);
        assert!(validated_identity(&(token+"corrupt"),&key).is_err());
        for (role,id,account) in [("member",id.as_str(),None),("owner","not-an-id",None),("owner",id.as_str(),Some("someone"))] {
            let (token,key)=self::token(role,id,account); assert!(validated_identity(&token,&key).is_err());
        }
    }
}
