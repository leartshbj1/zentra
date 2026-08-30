use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, NaiveDate};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
    models::LicenseTokenPayload,
};

pub const LICENSE_PLAN: &str = "helvichantier-monthly-50-chf";
pub const LICENSE_PRICE_CHF_CENTS: i64 = 5_000;
const TOKEN_VERSION: u8 = 2;
const LICENSE_KEY_ID: &str = "hc-prod-v1";

#[cfg(debug_assertions)]
const EMBEDDED_PUBLIC_KEY: Option<&str> = option_env!("HELVICHANTIER_LICENSE_PUBLIC_KEY_B64URL");

#[cfg(not(debug_assertions))]
const EMBEDDED_PUBLIC_KEY: Option<&str> = Some(env!(
    "HELVICHANTIER_LICENSE_PUBLIC_KEY_B64URL",
    "La clé publique de licence est obligatoire pour une release"
));

impl LocalStore {
    pub fn install_license_token(&self, token: &str) -> AppResult<Value> {
        let key=embedded_key()?.ok_or_else(||AppError::Validation("Cette compilation ne contient aucune clé publique de licence. Définissez HELVICHANTIER_LICENSE_PUBLIC_KEY_B64URL au build de production.".into()))?;
        self.install_license_token_with_key(token, &key)?;
        self.get_license_state()
    }

    fn install_license_token_with_key(
        &self,
        token: &str,
        key: &[u8; 32],
    ) -> AppResult<LicenseTokenPayload> {
        let payload = verify_token_with_key(token, key)?;
        validate_payload(&payload)?;
        self.validate_installation_binding(&payload)?;
        let today = today();
        let now = now_iso();
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO license_state(id,token,license_id,customer_name,plan,price_chf_cents,issued_at,valid_from,valid_until,verified_at,last_seen_date) VALUES(1,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,license_id=excluded.license_id,customer_name=excluded.customer_name,plan=excluded.plan,price_chf_cents=excluded.price_chf_cents,issued_at=excluded.issued_at,valid_from=excluded.valid_from,valid_until=excluded.valid_until,verified_at=excluded.verified_at,last_seen_date=excluded.last_seen_date",params![token,payload.license_id,payload.customer_name,payload.plan,payload.price_chf_cents,payload.issued_at,payload.valid_from,payload.valid_until,now,today])?;
        let audit_ready: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE id=1 AND onboarding_completed=1)",
            [],
            |r| r.get(0),
        )?;
        if audit_ready {
            append_audit(
                &tx,
                "install",
                "license",
                "1",
                &json!({"license_id":payload.license_id,"plan":LICENSE_PLAN,"price_chf_cents":LICENSE_PRICE_CHF_CENTS,"valid_until":payload.valid_until}),
            )?;
        }
        tx.commit()?;
        Ok(payload)
    }

    pub fn get_license_state(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        let Some(key) = embedded_key()? else {
            return Ok(
                json!({"enforcement_configured":false,"status":"not_configured","read_only":false,"plan":LICENSE_PLAN,"price_chf_cents":LICENSE_PRICE_CHF_CENTS,"installation_id":self.installation_id,"token_version":TOKEN_VERSION,"reason":"Build de développement non soumis au contrôle de licence"}),
            );
        };
        let row=query_all(&connection,"SELECT token,license_id,customer_name,plan,price_chf_cents,issued_at,valid_from,valid_until,verified_at,last_seen_date FROM license_state WHERE id=1",[])?.into_iter().next();
        let Some(row) = row else {
            return Ok(
                json!({"enforcement_configured":true,"status":"missing","read_only":true,"plan":LICENSE_PLAN,"price_chf_cents":LICENSE_PRICE_CHF_CENTS,"installation_id":self.installation_id,"token_version":TOKEN_VERSION}),
            );
        };
        let token = row["token"].as_str().unwrap_or("");
        let payload = match verify_token_with_key(token, &key) {
            Ok(v) => v,
            Err(error) => {
                return Ok(
                    json!({"enforcement_configured":true,"status":"invalid","read_only":true,"plan":LICENSE_PLAN,"price_chf_cents":LICENSE_PRICE_CHF_CENTS,"installation_id":self.installation_id,"token_version":TOKEN_VERSION,"reason":error.to_string()}),
                )
            }
        };
        if let Err(error) = self.validate_installation_binding(&payload) {
            return Ok(
                json!({"enforcement_configured":true,"status":"invalid","read_only":true,"plan":LICENSE_PLAN,"price_chf_cents":LICENSE_PRICE_CHF_CENTS,"installation_id":self.installation_id,"token_version":TOKEN_VERSION,"reason":error.to_string()}),
            );
        }
        let (status, read_only) = evaluate(
            &payload,
            &today(),
            row["last_seen_date"].as_str().unwrap_or(""),
        )?;
        Ok(
            json!({"enforcement_configured":true,"status":status,"read_only":read_only,"license_id":payload.license_id,"customer_name":payload.customer_name,"plan":payload.plan,"price_chf_cents":payload.price_chf_cents,"issued_at":payload.issued_at,"valid_from":payload.valid_from,"valid_until":payload.valid_until,"verified_at":row["verified_at"],"last_seen_date":row["last_seen_date"],"installation_id":self.installation_id,"token_version":payload.token_version}),
        )
    }

    pub(crate) fn require_write_access(&self) -> AppResult<()> {
        let Some(key) = embedded_key()? else {
            return Ok(());
        };
        let connection = self.connect()?;
        let row: (String, String) = connection
            .query_row(
                "SELECT token,last_seen_date FROM license_state WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| {
                AppError::Validation("Licence requise : l'application est en lecture seule.".into())
            })?;
        let payload = verify_token_with_key(&row.0, &key)?;
        self.validate_installation_binding(&payload)?;
        let current = today();
        let (status, read_only) = evaluate(&payload, &current, &row.1)?;
        if read_only {
            return Err(AppError::Validation(format!("Licence {status} : l'application est en lecture seule. Sauvegarde et export restent disponibles.")));
        }
        if current > row.1 {
            connection.execute(
                "UPDATE license_state SET last_seen_date=? WHERE id=1",
                params![current],
            )?;
        }
        Ok(())
    }

    fn validate_installation_binding(&self, payload: &LicenseTokenPayload) -> AppResult<()> {
        if payload.installation_id != self.installation_id {
            return Err(AppError::Validation(
                "Ce jeton appartient à une autre installation Windows.".into(),
            ));
        }
        Ok(())
    }
}

fn embedded_key() -> AppResult<Option<[u8; 32]>> {
    let Some(encoded) = EMBEDDED_PUBLIC_KEY else {
        return Ok(None);
    };
    let decoded = URL_SAFE_NO_PAD.decode(encoded.trim()).map_err(|_| {
        AppError::Validation("Clé publique de licence encodée incorrectement.".into())
    })?;
    let key: [u8; 32] = decoded.try_into().map_err(|_| {
        AppError::Validation("La clé publique Ed25519 doit contenir 32 octets.".into())
    })?;
    Ok(Some(key))
}
fn verify_token_with_key(token: &str, key: &[u8; 32]) -> AppResult<LicenseTokenPayload> {
    let mut parts = token.trim().split('.');
    let encoded = parts.next().unwrap_or("");
    let signature_text = parts.next().unwrap_or("");
    if encoded.is_empty() || signature_text.is_empty() || parts.next().is_some() {
        return Err(AppError::Validation("Jeton de licence mal formé.".into()));
    }
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| AppError::Validation("Payload de licence Base64URL invalide.".into()))?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature_text)
        .map_err(|_| AppError::Validation("Signature de licence Base64URL invalide.".into()))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| AppError::Validation("Signature Ed25519 de longueur invalide.".into()))?;
    let verifier = VerifyingKey::from_bytes(key)
        .map_err(|_| AppError::Validation("Clé publique Ed25519 invalide.".into()))?;
    verifier
        .verify(encoded.as_bytes(), &signature)
        .map_err(|_| AppError::Validation("Signature de licence invalide.".into()))?;
    let payload: LicenseTokenPayload = serde_json::from_slice(&payload_bytes)?;
    validate_payload(&payload)?;
    Ok(payload)
}
fn validate_payload(payload: &LicenseTokenPayload) -> AppResult<()> {
    if payload.token_version != TOKEN_VERSION {
        return Err(AppError::Validation(
            "Version de jeton de licence non prise en charge.".into(),
        ));
    }
    if payload.license_id.trim().is_empty() {
        return Err(AppError::Validation("license_id est obligatoire.".into()));
    }
    if payload.plan != LICENSE_PLAN || payload.price_chf_cents != LICENSE_PRICE_CHF_CENTS {
        return Err(AppError::Validation(
            "Le jeton ne correspond pas au plan Elyko à 50 CHF/mois.".into(),
        ));
    }
    let installation_id = uuid::Uuid::parse_str(&payload.installation_id)
        .map_err(|_| AppError::Validation("installation_id doit être un UUID valide.".into()))?;
    if installation_id.get_version_num() != 4 {
        return Err(AppError::Validation(
            "installation_id doit être un UUID v4.".into(),
        ));
    }
    uuid::Uuid::parse_str(&payload.jti)
        .map_err(|_| AppError::Validation("jti doit être un UUID valide.".into()))?;
    if payload.kid != LICENSE_KEY_ID {
        return Err(AppError::Validation(
            "Identifiant de clé de licence inconnu.".into(),
        ));
    }
    DateTime::parse_from_rfc3339(&payload.issued_at)
        .map_err(|_| AppError::Validation("issued_at doit être RFC 3339.".into()))?;
    let from = parse_date(&payload.valid_from, "valid_from")?;
    let until = parse_date(&payload.valid_until, "valid_until")?;
    if until < from {
        return Err(AppError::Validation(
            "valid_until précède valid_from.".into(),
        ));
    }
    Ok(())
}
fn evaluate(
    payload: &LicenseTokenPayload,
    current: &str,
    last_seen: &str,
) -> AppResult<(&'static str, bool)> {
    validate_payload(payload)?;
    if !last_seen.is_empty() {
        parse_date(last_seen, "last_seen_date")?;
        if current < last_seen {
            return Ok(("clock_error", true));
        }
    }
    if current < payload.valid_from.as_str() {
        Ok(("not_yet_valid", true))
    } else if current > payload.valid_until.as_str() {
        Ok(("expired", true))
    } else {
        Ok(("valid", false))
    }
}
fn parse_date(value: &str, field: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::Validation(format!("{field} doit être au format AAAA-MM-JJ.")))
}
fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};
    #[test]
    fn signed_offline_token_and_expiry_are_verified() {
        let signing = SigningKey::from_bytes(&[7_u8; 32]);
        let payload = LicenseTokenPayload {
            token_version: TOKEN_VERSION,
            license_id: "lic-test".into(),
            installation_id: "2e4cab71-1193-4b19-a4a2-a49f273aef13".into(),
            jti: "32b29162-dcd2-43c7-afc3-84a85a0df297".into(),
            kid: LICENSE_KEY_ID.into(),
            customer_name: Some("Client".into()),
            plan: LICENSE_PLAN.into(),
            price_chf_cents: LICENSE_PRICE_CHF_CENTS,
            issued_at: "2026-01-01T00:00:00Z".into(),
            valid_from: "2026-01-01".into(),
            valid_until: "2026-01-31".into(),
        };
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signature = signing.sign(encoded.as_bytes());
        let token = format!("{encoded}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()));
        assert_eq!(
            verify_token_with_key(&token, &signing.verifying_key().to_bytes()).unwrap(),
            payload
        );
        assert_eq!(
            evaluate(&payload, "2026-02-01", "2026-01-20").unwrap(),
            ("expired", true)
        );
        let mut tampered = token;
        tampered.push('A');
        assert!(verify_token_with_key(&tampered, &signing.verifying_key().to_bytes()).is_err());
    }

    #[test]
    fn signed_token_can_be_installed_before_onboarding() {
        let signing = SigningKey::from_bytes(&[11_u8; 32]);
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let payload = LicenseTokenPayload {
            token_version: TOKEN_VERSION,
            license_id: "lic-before-onboarding".into(),
            installation_id: store.installation_id.clone(),
            jti: "b7eae268-6f42-4e66-8460-a3e02eb8f98e".into(),
            kid: LICENSE_KEY_ID.into(),
            customer_name: Some("Client local".into()),
            plan: LICENSE_PLAN.into(),
            price_chf_cents: LICENSE_PRICE_CHF_CENTS,
            issued_at: "2026-01-01T00:00:00Z".into(),
            valid_from: "2026-01-01".into(),
            valid_until: "2026-12-31".into(),
        };
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let token = format!(
            "{encoded}.{}",
            URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes())
        );
        assert!(!store.app_state("1.0.0").unwrap().onboarding_completed);
        let installed = store
            .install_license_token_with_key(&token, &signing.verifying_key().to_bytes())
            .unwrap();
        assert_eq!(installed.license_id, "lic-before-onboarding");
        let count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM license_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert!(!store.app_state("1.0.0").unwrap().onboarding_completed);
    }
}
