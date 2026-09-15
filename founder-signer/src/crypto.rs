use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, NaiveDate, Utc};
use ed25519_dalek::{pkcs8::DecodePrivateKey, Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const PUBLIC_KEY: &str = include_str!("../public-key.b64url");
pub const ENDPOINT: &str = "https://elyko.alb-leart1.chatgpt.site/api/stripe/refresh";
pub const MAX_TOKEN: usize = 8192;
pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    pub token_version: u8,
    pub license_id: String,
    pub installation_id: String,
    pub jti: String,
    pub kid: String,
    pub customer_name: Option<String>,
    #[serde(default = "owner")]
    pub access_role: String,
    #[serde(default)]
    pub account_user_id: Option<String>,
    #[serde(default)]
    pub account_session_id: Option<String>,
    pub plan: String,
    pub price_chf_cents: i64,
    pub issued_at: String,
    pub valid_from: String,
    pub valid_until: String,
}

fn owner() -> String {
    "owner".into()
}

pub fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && Uuid::parse_str(value)
            .is_ok_and(|id| id.get_version_num() == 4 && id.get_variant() == uuid::Variant::RFC4122)
}

pub fn date(value: &str) -> Result<NaiveDate> {
    if value.len() != 10 {
        return Err("Date attendue au format AAAA-MM-JJ.".into());
    }
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "Date invalide.")?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err("Date invalide.".into());
    }
    Ok(parsed)
}

pub fn validate(p: &Payload) -> Result<()> {
    if p.token_version != 2 || p.kid != "hc-prod-v1" {
        return Err("Ce format de licence n’est pas compatible avec Zentra.".into());
    }
    if !p.license_id.strip_prefix("lic_").is_some_and(valid_uuid)
        || !valid_uuid(&p.installation_id)
        || !valid_uuid(&p.jti)
    {
        return Err(
            "L’identité de licence ou d’installation est invalide (UUID v4 attendu).".into(),
        );
    }
    let price = match p.plan.as_str() {
        "zentra-monthly-50-chf" | "elyko-monthly-50-chf" | "helvichantier-monthly-50-chf" => 5000,
        "zentra-solo-monthly-49-chf" => 4900,
        "zentra-start-monthly-59-chf" => 5900,
        "zentra-pro-monthly-89-chf" => 8900,
        _ => return Err("Formule Zentra inconnue.".into()),
    };
    if p.price_chf_cents != price {
        return Err("Le prix ne correspond pas à la formule.".into());
    }
    if !["owner", "admin", "accountant", "member", "read_only"].contains(&p.access_role.as_str()) {
        return Err("Rôle de licence inconnu.".into());
    }
    match (&p.account_user_id, &p.account_session_id) {
        (None, None) => {}
        (Some(user), Some(session))
            if !user.trim().is_empty()
                && user.len() <= 255
                && session.strip_prefix("dss_").is_some_and(valid_uuid) => {}
        _ => {
            return Err(
                "La liaison entre le compte et la session est incomplète ou invalide.".into(),
            )
        }
    }
    if p.customer_name
        .as_ref()
        .is_some_and(|name| name.len() > 240 || name.chars().any(char::is_control))
    {
        return Err("Le nom doit tenir sur une ligne de 240 octets maximum.".into());
    }
    DateTime::parse_from_rfc3339(&p.issued_at).map_err(|_| "Date d’émission invalide.")?;
    if date(&p.valid_until)? < date(&p.valid_from)? {
        return Err("La fin de validité précède le début.".into());
    }
    Ok(())
}

pub fn public_key() -> Result<VerifyingKey> {
    let bytes = URL_SAFE_NO_PAD
        .decode(PUBLIC_KEY.trim())
        .map_err(|_| "Clé publique invalide.")?;
    VerifyingKey::from_bytes(&bytes.try_into().map_err(|_| "Clé publique invalide.")?)
        .map_err(|_| "Clé publique invalide.".into())
}

pub fn signing_key(clear: &[u8]) -> Result<SigningKey> {
    let text = std::str::from_utf8(clear)
        .map_err(|_| "Clé privée protégée illisible.")?
        .trim();
    let der = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(text)
            .map_err(|_| "Clé privée PKCS8 invalide.")?,
    );
    let key = SigningKey::from_pkcs8_der(&der).map_err(|_| "Clé Ed25519 PKCS8 invalide.")?;
    if key.verifying_key() != public_key()? {
        return Err("La clé privée ne correspond pas à vos applications Zentra.".into());
    }
    Ok(key)
}

pub fn verify_with(token: &str, key: &VerifyingKey) -> Result<Payload> {
    let token = token.trim();
    if !(100..=MAX_TOKEN).contains(&token.len()) {
        return Err("La taille du jeton est invalide.".into());
    }
    let (encoded, sig) = token
        .split_once('.')
        .ok_or("Jeton signé attendu : contenu.signature.")?;
    let signature = Signature::from_slice(
        &URL_SAFE_NO_PAD
            .decode(sig)
            .map_err(|_| "Signature mal formée.")?,
    )
    .map_err(|_| "Signature mal formée.")?;
    key.verify_strict(encoded.as_bytes(), &signature)
        .map_err(|_| "La signature de ce jeton est invalide. Collez le jeton original complet.")?;
    decode_payload(encoded)
}

pub fn decode_payload(encoded: &str) -> Result<Payload> {
    if encoded.len() > MAX_TOKEN {
        return Err("Contenu trop volumineux.".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "Contenu Base64URL invalide.")?;
    let p: Payload = serde_json::from_slice(&bytes)
        .map_err(|_| "Le contenu n’est pas une licence Zentra complète.")?;
    validate(&p)?;
    Ok(p)
}

pub fn parse_source(source: &str) -> Result<Option<Payload>> {
    let source = source.trim();
    if source.len() > MAX_TOKEN {
        return Err("Le contenu dépasse 8 Ko.".into());
    }
    if valid_uuid(source) {
        return Ok(None);
    }
    if source.starts_with('{') {
        let p: Payload =
            serde_json::from_str(source).map_err(|_| "JSON de licence invalide ou incomplet.")?;
        validate(&p)?;
        return Ok(Some(p));
    }
    if source.contains('.') {
        return verify_with(source, &public_key()?).map(Some);
    }
    decode_payload(source).map(Some).map_err(|_| "Collez un identifiant d’installation UUID v4, un jeton complet ou son contenu JSON/Base64URL.".into())
}

pub fn sign_with(p: &Payload, key: &SigningKey) -> Result<String> {
    validate(p)?;
    let encoded = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(p).map_err(|_| "Impossible de préparer le jeton.")?);
    let token = format!(
        "{}.{}",
        encoded,
        URL_SAFE_NO_PAD.encode(key.sign(encoded.as_bytes()).to_bytes())
    );
    if verify_with(&token, &key.verifying_key())? != *p {
        return Err("La vérification après signature a échoué.".into());
    }
    Ok(token)
}

pub fn owner_payload(id: &str) -> Payload {
    let now = Utc::now();
    Payload {
        token_version: 2,
        license_id: format!("lic_{}", Uuid::new_v4()),
        installation_id: id.into(),
        jti: Uuid::new_v4().to_string(),
        kid: "hc-prod-v1".into(),
        customer_name: Some("Licence propriétaire Zentra".into()),
        access_role: owner(),
        account_user_id: None,
        account_session_id: None,
        plan: "zentra-monthly-50-chf".into(),
        price_chf_cents: 5000,
        issued_at: now.to_rfc3339(),
        valid_from: (now.date_naive() - chrono::Duration::days(1)).to_string(),
        valid_until: "2036-12-31".into(),
    }
}

pub fn binding(p: &Payload) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{}:{}", p.license_id, p.installation_id).as_bytes())
    )
}

pub fn fingerprint(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub fn validate_reply(candidate: &Payload, token: &str) -> Result<Payload> {
    let p = verify_with(token, &public_key()?)?;
    if p.license_id != candidate.license_id || p.installation_id != candidate.installation_id {
        return Err("Le serveur a renvoyé une autre licence ou un autre appareil.".into());
    }
    let today = Utc::now().date_naive();
    if today < date(&p.valid_from)? || today > date(&p.valid_until)? {
        return Err("Le jeton renvoyé par le serveur n’est pas valide aujourd’hui.".into());
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> Payload {
        owner_payload("67977efd-492e-4e01-b719-5fe42b7c3d2d")
    }
    #[test]
    fn signature_roundtrip_and_tampering() {
        let key = SigningKey::from_bytes(&[42; 32]);
        let p = payload();
        let token = sign_with(&p, &key).unwrap();
        assert_eq!(verify_with(&token, &key.verifying_key()).unwrap(), p);
        let (_, signature) = token.split_once('.').unwrap();
        let mut modified = p.clone();
        modified.installation_id = Uuid::new_v4().to_string();
        let tampered = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&modified).unwrap()),
            signature
        );
        assert!(verify_with(&tampered, &key.verifying_key()).is_err());
        assert!(verify_with(&token, &SigningKey::from_bytes(&[43; 32]).verifying_key()).is_err());
        assert!(verify_with(&format!("{token}.extra"), &key.verifying_key()).is_err());
    }
    #[test]
    fn rejects_malformed_contracts() {
        for change in 0..9 {
            let mut p = payload();
            match change {
                0 => p.installation_id = "../escape".into(),
                1 => p.kid = "unknown".into(),
                2 => p.token_version = 1,
                3 => p.price_chf_cents = 0,
                4 => p.account_user_id = Some("user".into()),
                5 => p.valid_until = "2026-02-30".into(),
                6 => p.access_role = "root".into(),
                7 => p.valid_from = "2037-01-01".into(),
                _ => p.license_id = "lic_invalid".into(),
            }
            assert!(validate(&p).is_err(), "change {change}");
        }
    }
    #[test]
    fn accepts_payload_and_uuid_and_rejects_incomplete_data() {
        let p = payload();
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(parse_source(&json).unwrap().unwrap(), p);
        assert_eq!(
            parse_source(&URL_SAFE_NO_PAD.encode(json))
                .unwrap()
                .unwrap(),
            p
        );
        assert!(parse_source(&p.installation_id).unwrap().is_none());
        assert!(parse_source("{\"installation_id\":\"x\"}").is_err());
        assert!(parse_source(&"a".repeat(8193)).is_err());
        assert!(!valid_uuid("67977efd-492e-1e01-b719-5fe42b7c3d2d"));
    }
    #[test]
    fn refuses_unrelated_private_key() {
        use ed25519_dalek::pkcs8::EncodePrivateKey;
        let key = SigningKey::from_bytes(&[42; 32]);
        let der = key.to_pkcs8_der().unwrap();
        assert!(signing_key(URL_SAFE_NO_PAD.encode(der.as_bytes()).as_bytes()).is_err());
    }
    #[test]
    fn binding_depends_on_exact_license_and_installation() {
        let p = payload();
        let mut other = p.clone();
        other.license_id = format!("lic_{}", Uuid::new_v4());
        assert_ne!(binding(&p), binding(&other));
        other = p.clone();
        other.installation_id = Uuid::new_v4().to_string();
        assert_ne!(binding(&p), binding(&other));
        assert_eq!(binding(&p).len(), 64);
    }
}
