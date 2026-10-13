#![cfg(test)]

// Compilation input and optional in-memory service access for the isolated
// test harness only. No I/O or profile selection from the runtime environment.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::header::HeaderValue;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const REFUSED: &str = "ZENTRA_ACTION_NATIVE_TEST_PROFILE_REFUSED";
const MAX_PROFILE_BYTES: usize = 8192;
const PRODUCTION_PUBLIC_KEY: &str = "FySkIPXpEIfZ9UCBlXuhFAgFx3LpchgBFWTh65Aa040";
const PRODUCTION_KID: &str = "hc-prod-v1";
const PRODUCTION_HOSTS: [&str; 5] = [
    "zentraapp.ch",
    "www.zentraapp.ch",
    "elyko.alb-leart1.chatgpt.site",
    "xvfohjdlhlirksrvkiqu.supabase.co",
    "zgmkzsoxwlgqhjxgvcbo.supabase.co",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    format: String,
    #[serde(deserialize_with = "version_one")]
    schema_version: u8,
    profile: Profile,
    deployment_profile_sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Profile {
    #[serde(deserialize_with = "version_one")]
    schema_version: u8,
    kind: String,
    profile_id: String,
    site_origin: String,
    supabase_origin: String,
    license: License,
    identifiers: Identifiers,
    product_name: String,
    binary_name: String,
    updater: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct License {
    public_key_b64url: String,
    kid: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Identifiers {
    windows: String,
    macos: String,
    mobile: String,
}

// JSON numbers equal to 1 have the same meaning in the preparer's validator.
// Serialize the admitted version as the canonical integer used by its hash.
fn version_one<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let number = serde_json::Number::deserialize(deserializer)?;
    if number.as_f64() == Some(1.0) {
        Ok(1)
    } else {
        Err(serde::de::Error::custom(REFUSED))
    }
}

#[derive(Debug)]
pub(crate) struct NativeTestProfile {
    profile: Profile,
    license_key: [u8; 32],
    sha256: String,
}

impl NativeTestProfile {
    pub(crate) fn site_origin(&self) -> &str {
        &self.profile.site_origin
    }

    pub(crate) fn license_key(&self) -> [u8; 32] {
        self.license_key
    }

    pub(crate) fn license_kid(&self) -> &str {
        &self.profile.license.kid
    }

    pub(crate) fn sha256(&self) -> &str {
        &self.sha256
    }
}

static CONFIGURED: OnceLock<Result<Option<NativeTestProfile>, &'static str>> = OnceLock::new();

pub(crate) fn configured() -> Result<Option<&'static NativeTestProfile>, &'static str> {
    match CONFIGURED.get_or_init(|| {
        parse(
            option_env!("ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON").map(str::as_bytes),
            option_env!("ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256"),
        )
    }) {
        Ok(profile) => Ok(profile.as_ref()),
        Err(error) => Err(*error),
    }
}

pub(crate) fn require() -> Result<&'static NativeTestProfile, &'static str> {
    configured()?.ok_or(REFUSED)
}

const SITES_ACCESS_REFUSED: &str = "ZENTRA_ACTION_NATIVE_TEST_SITES_ACCESS_REFUSED";
const SITES_ACCESS_HEADER: &str = "oai-sites-authorization";
const MAX_SITES_TOKEN_BYTES: usize = 4096;

// Deliberately neither Debug nor Serialize. The secret is never part of the
// public profile, compilation environment, protected store or archive.
struct SitesAccessToken {
    value: HeaderValue,
}

impl SitesAccessToken {
    fn parse(token: &str) -> Result<Self, &'static str> {
        if token.is_empty()
            || token.len() > MAX_SITES_TOKEN_BYTES
            || !token.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        {
            return Err(SITES_ACCESS_REFUSED);
        }
        let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| SITES_ACCESS_REFUSED)?;
        value.set_sensitive(true);
        Ok(Self { value })
    }
}

static SITES_ACCESS: OnceLock<SitesAccessToken> = OnceLock::new();

fn install_sites_access_into(
    cell: &OnceLock<SitesAccessToken>,
    profile: Result<Option<&NativeTestProfile>, &'static str>,
    token: &str,
) -> Result<(), &'static str> {
    profile.map_err(|_| SITES_ACCESS_REFUSED)?.ok_or(SITES_ACCESS_REFUSED)?;
    cell.set(SitesAccessToken::parse(token)?)
        .map_err(|_| SITES_ACCESS_REFUSED)
}

// The future harness supplies the credential directly in memory, after its
// admission guard and before any LocalStore initialization. No rotation/reset.
pub(crate) fn install_sites_access_token(token: &str) -> Result<(), &'static str> {
    let profile = require().map_err(|_| SITES_ACCESS_REFUSED)?;
    install_sites_access_into(&SITES_ACCESS, Ok(Some(profile)), token)
}

fn attach_sites_access(
    request: &mut reqwest::Request,
    profile: Result<Option<&NativeTestProfile>, &'static str>,
    access: Option<&SitesAccessToken>,
) -> Result<(), &'static str> {
    let profile = profile.map_err(|_| SITES_ACCESS_REFUSED)?;
    if request.headers().contains_key(SITES_ACCESS_HEADER) {
        return Err(SITES_ACCESS_REFUSED);
    }
    if profile.is_none() && access.is_none() {
        return Ok(());
    }
    let profile = profile.ok_or(SITES_ACCESS_REFUSED)?;
    let url = request.url();
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.origin().ascii_serialization() != profile.site_origin()
    {
        return Err(SITES_ACCESS_REFUSED);
    }
    if let Some(access) = access {
        request.headers_mut().insert(SITES_ACCESS_HEADER, access.value.clone());
    }
    Ok(())
}

pub(crate) fn with_sites_authorization(
    builder: reqwest::RequestBuilder,
) -> Result<reqwest::RequestBuilder, &'static str> {
    let profile = configured().map_err(|_| SITES_ACCESS_REFUSED)?;
    // Inspect the actual destination and preserve the same client, body,
    // timeout and Authorization. Never put a secret in client default headers.
    let (client, request) = builder.build_split();
    let mut request = request.map_err(|_| SITES_ACCESS_REFUSED)?;
    attach_sites_access(&mut request, Ok(profile), SITES_ACCESS.get())?;
    Ok(reqwest::RequestBuilder::from_parts(client, request))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sandbox_id(value: &str, maximum: usize) -> bool {
    value.len() <= maximum
        && value.strip_prefix("sandbox-").is_some_and(|suffix| {
            suffix.split('-').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            })
        })
}

fn canonical_host(origin: &str) -> Result<String, &'static str> {
    if origin.len() > 253 {
        return Err(REFUSED);
    }
    let parsed = url::Url::parse(origin).map_err(|_| REFUSED)?;
    let host = parsed.host_str().ok_or(REFUSED)?;
    let alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.origin().ascii_serialization() != origin
        || !host.as_bytes().first().copied().is_some_and(alphanumeric)
        || !host.as_bytes().last().copied().is_some_and(alphanumeric)
        || !host
            .bytes()
            .all(|byte| alphanumeric(byte) || byte == b'.' || byte == b'-')
        || !host.contains('.')
        || host.contains("..")
    {
        return Err(REFUSED);
    }
    Ok(host.to_owned())
}

// The preparer hashes the complete profile, recursively sorting object keys.
// The admitted manifest has only ASCII field names and strings, integer 1,
// and objects; its JSON string bytes match JSON.stringify without coercion.
fn canonical_json(value: &serde_json::Value) -> Result<String, &'static str> {
    if let Some(object) = value.as_object() {
        let mut keys: Vec<_> = object.keys().collect();
        keys.sort_unstable();
        let mut fields = Vec::with_capacity(keys.len());
        for key in keys {
            fields.push(format!(
                "{}:{}",
                serde_json::to_string(key).map_err(|_| REFUSED)?,
                canonical_json(&object[key])?
            ));
        }
        Ok(format!("{{{}}}", fields.join(",")))
    } else {
        serde_json::to_string(value).map_err(|_| REFUSED)
    }
}

pub(crate) fn parse(
    json: Option<&[u8]>,
    expected_sha256: Option<&str>,
) -> Result<Option<NativeTestProfile>, &'static str> {
    let (bytes, expected) = match (json, expected_sha256) {
        (None, None) => return Ok(None),
        (Some(bytes), Some(expected)) => (bytes, expected),
        _ => return Err(REFUSED),
    };
    if bytes.len() > MAX_PROFILE_BYTES || !valid_sha256(expected) {
        return Err(REFUSED);
    }
    std::str::from_utf8(bytes).map_err(|_| REFUSED)?;
    let shape: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| REFUSED)?;
    // Derived Serde structs also accept positional arrays. Check all four
    // structural objects, then preserve the original bytes for duplicate,
    // required-field, type and unknown-field rejection at every level.
    if !shape.is_object()
        || !shape.get("profile").is_some_and(serde_json::Value::is_object)
        || !shape["profile"]
            .get("license")
            .is_some_and(serde_json::Value::is_object)
        || !shape["profile"]
            .get("identifiers")
            .is_some_and(serde_json::Value::is_object)
    {
        return Err(REFUSED);
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| REFUSED)?;
    let profile = envelope.profile;
    if envelope.format != "zentra-action-native-test-profile"
        || envelope.schema_version != 1
        || profile.schema_version != 1
        || profile.kind != "sandbox"
        || !sandbox_id(&profile.profile_id, 48)
        || !sandbox_id(&profile.license.kid, 64)
        || profile.license.kid == PRODUCTION_KID
        || profile.product_name != "Zentra Sandbox"
        || profile.binary_name != "ZentraSandbox"
        || profile.updater != "disabled"
        || profile.identifiers.windows != "ch.zentra.sandbox.windows"
        || profile.identifiers.macos != "ch.zentra.sandbox.macos"
        || profile.identifiers.mobile != "ch.zentra.sandbox.mobile"
        || envelope.deployment_profile_sha256 != expected
    {
        return Err(REFUSED);
    }
    let site = canonical_host(&profile.site_origin)?;
    let supabase = canonical_host(&profile.supabase_origin)?;
    let reference = supabase.strip_suffix(".supabase.co").ok_or(REFUSED)?;
    if PRODUCTION_HOSTS.contains(&site.as_str())
        || PRODUCTION_HOSTS.contains(&supabase.as_str())
        || reference.len() != 20
        || !reference.bytes().all(|byte| byte.is_ascii_lowercase())
        || profile.site_origin == profile.supabase_origin
    {
        return Err(REFUSED);
    }
    let key = &profile.license.public_key_b64url;
    if key.len() != 43 || key == PRODUCTION_PUBLIC_KEY {
        return Err(REFUSED);
    }
    let decoded = URL_SAFE_NO_PAD.decode(key).map_err(|_| REFUSED)?;
    let license_key: [u8; 32] = decoded.try_into().map_err(|_| REFUSED)?;
    if URL_SAFE_NO_PAD.encode(license_key) != *key {
        return Err(REFUSED);
    }
    let canonical = canonical_json(&serde_json::to_value(&profile).map_err(|_| REFUSED)?)?;
    let sha256 = format!("{:x}", Sha256::digest(canonical.as_bytes()));
    if sha256 != expected {
        return Err(REFUSED);
    }
    Ok(Some(NativeTestProfile {
        profile,
        license_key,
        sha256,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    // Public, non-provisioned fixture emitted by the actual TS preparer.
    const PREPARED: &[u8] = include_bytes!("../../tests/fixtures/action-native-test-profile.public.json");
    const PREPARED_SHA256: &str =
        include_str!("../../tests/fixtures/action-native-test-profile.public.sha256");

    fn fixture() -> Value {
        serde_json::from_slice(PREPARED).unwrap()
    }

    fn fixture_sha256() -> &'static str {
        PREPARED_SHA256.trim_end()
    }

    fn fingerprint(profile: &Value) -> String {
        format!(
            "{:x}",
            Sha256::digest(canonical_json(profile).unwrap().as_bytes())
        )
    }

    fn coherent(mut envelope: Value) -> (Vec<u8>, String) {
        let expected = fingerprint(&envelope["profile"]);
        envelope["deploymentProfileSha256"] = json!(expected);
        (serde_json::to_vec(&envelope).unwrap(), expected)
    }

    fn refuses(bytes: &[u8], expected: &str) {
        assert_eq!(parse(Some(bytes), Some(expected)).unwrap_err(), REFUSED);
    }

    fn refuses_coherent(envelope: Value) {
        let (bytes, expected) = coherent(envelope);
        refuses(&bytes, &expected);
    }

    #[test]
    fn actual_server_preparer_fixture_and_complete_hash_are_accepted() {
        let profile = parse(Some(PREPARED), Some(fixture_sha256()))
            .unwrap()
            .unwrap();
        let expected = fixture();
        assert_eq!(profile.site_origin(), expected["profile"]["siteOrigin"]);
        assert_eq!(profile.license_kid(), expected["profile"]["license"]["kid"]);
        assert_eq!(profile.sha256(), fixture_sha256());
        assert_eq!(
            URL_SAFE_NO_PAD.encode(profile.license_key()),
            expected["profile"]["license"]["publicKeyB64url"]
        );
        assert_eq!(fingerprint(&expected["profile"]), fixture_sha256());
    }

    #[test]
    fn absent_compilation_inputs_are_unconfigured_and_partial_inputs_refuse() {
        assert!(parse(None, None).unwrap().is_none());
        assert_eq!(parse(Some(PREPARED), None).unwrap_err(), REFUSED);
        assert_eq!(parse(None, Some(fixture_sha256())).unwrap_err(), REFUSED);
        assert_eq!(parse(Some(b""), Some("")).unwrap_err(), REFUSED);
        // Assert each CI compilation context independently of the consumer
        // tests, which must also exercise the closed error branch. No global
        // environment or OnceLock state is replaced between these contexts.
        match (
            option_env!("ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON"),
            option_env!("ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256"),
        ) {
            (None, None) => {
                assert!(configured().unwrap().is_none());
                assert_eq!(require().unwrap_err(), REFUSED);
            }
            (Some(_), Some(expected_sha256)) => {
                assert_eq!(expected_sha256, fixture_sha256());
                let expected = parse(Some(PREPARED), Some(fixture_sha256()))
                    .unwrap()
                    .unwrap();
                let actual = configured().unwrap().unwrap();
                assert_eq!(actual.site_origin(), expected.site_origin());
                assert_eq!(actual.license_key(), expected.license_key());
                assert_eq!(actual.license_kid(), expected.license_kid());
                assert_eq!(actual.sha256(), expected.sha256());
                assert!(std::ptr::eq(require().unwrap(), actual));
            }
            _ => {
                assert_eq!(configured().unwrap_err(), REFUSED);
                assert_eq!(require().unwrap_err(), REFUSED);
            }
        }
    }

    #[test]
    fn profile_hash_is_independent_of_recursive_object_order_and_whitespace() {
        fn reverse(value: &Value) -> String {
            if let Some(object) = value.as_object() {
                let mut keys: Vec<_> = object.keys().collect();
                keys.sort_unstable();
                keys.reverse();
                format!(
                    "{{ {} }}",
                    keys.into_iter()
                        .map(|key| format!(
                            "{} : {}",
                            serde_json::to_string(key).unwrap(),
                            reverse(&object[key])
                        ))
                        .collect::<Vec<_>>()
                        .join(",\n")
                )
            } else {
                serde_json::to_string(value).unwrap()
            }
        }
        let bytes = reverse(&fixture()).into_bytes();
        assert_eq!(
            parse(Some(&bytes), Some(fixture_sha256()))
                .unwrap()
                .unwrap()
                .sha256(),
            fixture_sha256()
        );
    }

    #[test]
    fn utf8_and_exact_8192_byte_limit_are_enforced_without_truncation() {
        let mut bytes = serde_json::to_vec(&fixture()).unwrap();
        assert!(bytes.len() < MAX_PROFILE_BYTES);
        bytes.resize(MAX_PROFILE_BYTES, b' ');
        assert!(parse(Some(&bytes), Some(fixture_sha256())).unwrap().is_some());
        bytes.push(b' ');
        refuses(&bytes, fixture_sha256());
        refuses(&[0xff, 0xfe], fixture_sha256());
        refuses(b"\xef\xbb\xbf{}", fixture_sha256());
    }

    #[test]
    fn expected_and_embedded_hashes_are_separate_exact_lowercase_full_values() {
        for expected in ["".to_owned(), "a".repeat(63), "A".repeat(64), "g".repeat(64), "0".repeat(64), format!("{}\n", fixture_sha256())] {
            refuses(PREPARED, &expected);
        }
        let mut value = fixture();
        value["deploymentProfileSha256"] = json!("0".repeat(64));
        refuses(&serde_json::to_vec(&value).unwrap(), fixture_sha256());
        for (path, replacement) in [
            (vec!["profileId"], json!("sandbox-other")),
            (vec!["siteOrigin"], json!("https://other.example")),
            (vec!["supabaseOrigin"], json!("https://bbbbbbbbbbbbbbbbbbbb.supabase.co")),
            (vec!["license", "kid"], json!("sandbox-other-v1")),
            (vec!["license", "publicKeyB64url"], json!(URL_SAFE_NO_PAD.encode([1_u8; 32]))),
        ] {
            let mut value = fixture();
            let mut field = &mut value["profile"];
            for name in path { field = &mut field[name]; }
            *field = replacement;
            refuses(&serde_json::to_vec(&value).unwrap(), fixture_sha256());
            let (bytes, expected) = coherent(value);
            assert!(parse(Some(&bytes), Some(&expected)).unwrap().is_some());
        }
    }

    #[test]
    fn complete_manifest_is_closed_and_requires_every_field_at_every_level() {
        for path in [vec![], vec!["profile"], vec!["profile", "license"], vec!["profile", "identifiers"]] {
            let value = fixture();
            let mut object = &value;
            for field in &path { object = &object[*field]; }
            let keys: Vec<_> = object.as_object().unwrap().keys().cloned().collect();
            for key in keys {
                let mut changed = fixture();
                let mut object = &mut changed;
                for field in &path { object = &mut object[*field]; }
                object.as_object_mut().unwrap().remove(&key);
                let expected = fingerprint(&changed["profile"]);
                if !(path.is_empty() && key == "deploymentProfileSha256") {
                    changed["deploymentProfileSha256"] = json!(expected);
                }
                refuses(&serde_json::to_vec(&changed).unwrap(), &expected);
            }
            let mut changed = fixture();
            let mut object = &mut changed;
            for field in &path { object = &mut object[*field]; }
            object.as_object_mut().unwrap().insert("unexpected".into(), json!("synthetic-private-input"));
            refuses_coherent(changed);
        }
    }

    #[test]
    fn all_four_wire_structures_refuse_coherent_positional_arrays() {
        let base = fixture();
        let positional = |value: &Value, fields: &[&str]| {
            Value::Array(fields.iter().map(|field| value[*field].clone()).collect())
        };
        let root = positional(&base, &["format", "schemaVersion", "profile", "deploymentProfileSha256"]);
        refuses(&serde_json::to_vec(&root).unwrap(), fixture_sha256());
        for (path, fields) in [
            (vec!["profile"], vec!["schemaVersion", "kind", "profileId", "siteOrigin", "supabaseOrigin", "license", "identifiers", "productName", "binaryName", "updater"]),
            (vec!["profile", "license"], vec!["publicKeyB64url", "kid"]),
            (vec!["profile", "identifiers"], vec!["windows", "macos", "mobile"]),
        ] {
            let mut value = base.clone();
            let mut object = &mut value;
            for field in path { object = &mut object[field]; }
            *object = positional(object, &fields);
            // The original valid hash is intentional: positional Serde would
            // reconstruct exactly the admitted profile without the shape guard.
            refuses(&serde_json::to_vec(&value).unwrap(), fixture_sha256());
        }
    }

    #[test]
    fn duplicate_and_escaped_equivalent_fields_refuse_from_original_bytes() {
        let base = fixture();
        let text = serde_json::to_string(&base).unwrap();
        for (object, field, escaped) in [
            (&base, "format", "for\\u006dat"),
            (&base["profile"], "kind", "k\\u0069nd"),
            (&base["profile"]["license"], "kid", "k\\u0069d"),
            (&base["profile"]["identifiers"], "windows", "wind\\u006fws"),
        ] {
            let value = serde_json::to_string(&object[field]).unwrap();
            let original = format!("\"{field}\":{value}");
            assert!(text.contains(&original));
            for name in [field, escaped] {
                let duplicate = text.replacen(&original, &format!("{original},\"{name}\":{value}"), 1);
                refuses(duplicate.as_bytes(), fixture_sha256());
            }
        }
    }

    #[test]
    fn every_production_host_is_refused_in_both_origin_positions_with_coherent_hash() {
        for host in PRODUCTION_HOSTS {
            for field in ["siteOrigin", "supabaseOrigin"] {
                let mut value = fixture();
                value["profile"][field] = json!(format!("https://{host}"));
                refuses_coherent(value);
            }
        }
    }

    #[test]
    fn origins_require_canonical_https_hosts_without_aliases_or_url_components() {
        for origin in [
            "http://sandbox.example", "https://Sandbox.example", "HTTPS://sandbox.example",
            "https://sandbox.example/", "https://sandbox.example/path", "https://sandbox.example:443",
            "https://sandbox.example:8443", "https://user@sandbox.example", "https://user:pass@sandbox.example",
            "https://sandbox.example?x=1", "https://sandbox.example#x", "https://sandbox.example.",
            "https://sandbox..example", "https://-sandbox.example", "https://sandbox.example-",
            "https://sandbox_example.test", "https://localhost", "https://[::1]", "https://sàndbox.example",
            " https://sandbox.example", "https://sandbox.example\n", "https://sandbox.example\\path",
        ] {
            let mut value = fixture();
            value["profile"]["siteOrigin"] = json!(origin);
            refuses_coherent(value);
        }
        let mut value = fixture();
        value["profile"]["siteOrigin"] = json!(format!("https://{}.test", "a".repeat(240)));
        let (bytes, expected) = coherent(value);
        assert!(parse(Some(&bytes), Some(&expected)).unwrap().is_some());
        let mut value = fixture();
        value["profile"]["siteOrigin"] = json!(format!("https://{}.test", "a".repeat(241)));
        refuses_coherent(value);
    }

    #[test]
    fn site_and_supabase_origins_must_be_distinct() {
        let mut value = fixture();
        value["profile"]["siteOrigin"] = value["profile"]["supabaseOrigin"].clone();
        refuses_coherent(value);
    }

    #[test]
    fn supabase_requires_exactly_twenty_lowercase_ascii_reference_letters() {
        for origin in [
            "https://aaaaaaaaaaaaaaaaaaa.supabase.co",
            "https://aaaaaaaaaaaaaaaaaaaaa.supabase.co",
            "https://Aaaaaaaaaaaaaaaaaaaa.supabase.co",
            "https://0aaaaaaaaaaaaaaaaaaa.supabase.co",
            "https://a-aaaaaaaaaaaaaaaaaa.supabase.co",
            "https://aaaaaaaaaaaaaaaaaaaa.example",
            "https://aaaaaaaaaaaaaaaaaaaa.supabase.co.example",
        ] {
            let mut value = fixture();
            value["profile"]["supabaseOrigin"] = json!(origin);
            refuses_coherent(value);
        }
    }

    #[test]
    fn production_key_and_kid_are_refused_with_coherent_hashes() {
        for (field, forbidden) in [("publicKeyB64url", PRODUCTION_PUBLIC_KEY), ("kid", PRODUCTION_KID)] {
            let mut value = fixture();
            value["profile"]["license"][field] = json!(forbidden);
            refuses_coherent(value);
        }
    }

    #[test]
    fn license_key_requires_exact_canonical_unpadded_32_byte_base64url() {
        for key in ["".to_owned(), "A".repeat(42), "A".repeat(44), format!("{}=", "A".repeat(43)), format!("{}B", "A".repeat(42)), format!("{}+", "A".repeat(42)), format!("{}/", "A".repeat(42)), "é".repeat(43)] {
            let mut value = fixture();
            value["profile"]["license"]["publicKeyB64url"] = json!(key);
            refuses_coherent(value);
        }
        let mut value = fixture();
        value["profile"]["license"]["publicKeyB64url"] = json!(URL_SAFE_NO_PAD.encode([1_u8; 32]));
        let (bytes, expected) = coherent(value);
        assert_eq!(parse(Some(&bytes), Some(&expected)).unwrap().unwrap().license_key(), [1_u8; 32]);
    }

    #[test]
    fn sandbox_identifiers_names_updater_and_kind_are_exact() {
        for (field, invalid) in [("kind", "production"), ("productName", "Zentra"), ("binaryName", "Zentra"), ("updater", "production")] {
            let mut value = fixture();
            value["profile"][field] = json!(invalid);
            refuses_coherent(value);
        }
        for field in ["windows", "macos", "mobile"] {
            for invalid in ["ch.zentra.desktop", "ch.zentra.sandbox", "ch.zentra.sandbox.windows.extra"] {
                let mut value = fixture();
                value["profile"]["identifiers"][field] = json!(invalid);
                refuses_coherent(value);
            }
        }
    }

    #[test]
    fn sandbox_profile_id_and_kid_grammar_and_bounds_match_the_preparer() {
        for (path, maximum) in [(vec!["profile", "profileId"], 48), (vec!["profile", "license", "kid"], 64)] {
            for invalid in ["".to_owned(), "production".to_owned(), "sandbox-".to_owned(), "sandbox--a".to_owned(), "sandbox-a-".to_owned(), "sandbox-A".to_owned(), "sandbox-é".to_owned(), "sandbox-a_b".to_owned(), format!("sandbox-{}", "a".repeat(maximum - 7))] {
                let mut value = fixture();
                let mut field = &mut value;
                for name in &path { field = &mut field[*name]; }
                *field = json!(invalid);
                refuses_coherent(value);
            }
            let mut value = fixture();
            let mut field = &mut value;
            for name in path { field = &mut field[name]; }
            *field = json!(format!("sandbox-{}", "a".repeat(maximum - 8)));
            let (bytes, expected) = coherent(value);
            assert!(parse(Some(&bytes), Some(&expected)).unwrap().is_some());
        }
    }

    #[test]
    fn schema_versions_match_numeric_one_and_discriminators_are_literal() {
        let text = serde_json::to_string(&fixture()).unwrap();
        for one in ["1.0", "1e0"] {
            let variant = text.replace("\"schemaVersion\":1", &format!("\"schemaVersion\":{one}"));
            assert!(parse(Some(variant.as_bytes()), Some(fixture_sha256())).unwrap().is_some());
        }
        for invalid in [json!(0), json!(2), json!(-1), json!("1"), Value::Null, json!(true)] {
            for path in [vec!["schemaVersion"], vec!["profile", "schemaVersion"]] {
                let mut value = fixture();
                let mut field = &mut value;
                for name in path { field = &mut field[name]; }
                *field = invalid.clone();
                refuses_coherent(value);
            }
        }
        let mut value = fixture();
        value["format"] = json!("zentra-deployment-profile");
        refuses_coherent(value);
    }

    #[test]
    fn malformed_json_and_wrong_types_return_only_the_fixed_redacted_error() {
        for bytes in [b"".as_slice(), b"null", b"[]", b"{}", b"true", b"{}{}", b"{", b"NaN", b"{\"sensitive-secret-input\":\"private-value\"}"] {
            refuses(bytes, fixture_sha256());
        }
        for field in ["kind", "profileId", "siteOrigin", "supabaseOrigin", "productName", "binaryName", "updater"] {
            for invalid in [Value::Null, json!(1), json!(true), json!([]), json!({})] {
                let mut value = fixture();
                value["profile"][field] = invalid;
                refuses_coherent(value);
            }
        }
    }

    #[test]
    fn sites_access_header_is_sensitive_and_preserves_device_authorization_and_body() {
        let profile = parse(Some(PREPARED), Some(fixture_sha256())).unwrap().unwrap();
        let access = SitesAccessToken::parse("synthetic-sites-access-token").unwrap();
        let url = url::Url::parse(&format!("{}/api/account/collaboration?id=fixture", profile.site_origin())).unwrap();
        let mut request = reqwest::Request::new(reqwest::Method::POST, url.clone());
        request.headers_mut().insert(reqwest::header::AUTHORIZATION, HeaderValue::from_static("Bearer zds_synthetic_device_token"));
        *request.body_mut() = Some(Vec::from(b"synthetic-body".as_slice()).into());
        attach_sites_access(&mut request, Ok(Some(&profile)), Some(&access)).unwrap();
        let header = request.headers().get(SITES_ACCESS_HEADER).unwrap();
        assert!(header.is_sensitive());
        assert_eq!(header.as_bytes(), b"Bearer synthetic-sites-access-token");
        assert!(!format!("{header:?}").contains("synthetic-sites-access-token"));
        assert_eq!(request.headers()[reqwest::header::AUTHORIZATION], "Bearer zds_synthetic_device_token");
        assert_eq!(request.url(), &url);
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.body().unwrap().as_bytes().unwrap(), b"synthetic-body");
    }

    #[test]
    fn sites_access_rejects_invalid_tokens_without_retaining_them() {
        let profile = parse(Some(PREPARED), Some(fixture_sha256())).unwrap().unwrap();
        let too_long = "x".repeat(MAX_SITES_TOKEN_BYTES + 1);
        for token in ["", "Bearer token", "has space", "tab\there", "line\r\nbreak", "nul\0byte", "non-ascii-é", too_long.as_str()] {
            let cell = OnceLock::new();
            assert_eq!(install_sites_access_into(&cell, Ok(Some(&profile)), token), Err(SITES_ACCESS_REFUSED));
            assert!(cell.get().is_none());
        }
        let boundary = SitesAccessToken::parse(&"x".repeat(MAX_SITES_TOKEN_BYTES)).unwrap();
        assert!(boundary.value.is_sensitive());
    }

    #[test]
    fn sites_access_installation_requires_a_valid_manifest_and_is_immutable() {
        let profile = parse(Some(PREPARED), Some(fixture_sha256())).unwrap().unwrap();
        let cell = OnceLock::new();
        for configuration in [Ok(None), Err(REFUSED)] {
            assert_eq!(install_sites_access_into(&cell, configuration, "first-token"), Err(SITES_ACCESS_REFUSED));
            assert!(cell.get().is_none());
        }
        let invalid = parse(Some(PREPARED), Some(&"0".repeat(64)));
        let invalid = invalid.as_ref().map(|profile| profile.as_ref()).map_err(|error| *error);
        assert_eq!(install_sites_access_into(&cell, invalid, "first-token"), Err(SITES_ACCESS_REFUSED));
        assert!(cell.get().is_none());
        install_sites_access_into(&cell, Ok(Some(&profile)), "first-token").unwrap();
        assert_eq!(install_sites_access_into(&cell, Ok(Some(&profile)), "replacement-token"), Err(SITES_ACCESS_REFUSED));
        assert_eq!(cell.get().unwrap().value.as_bytes(), b"Bearer first-token");
        assert!(cell.get().unwrap().value.is_sensitive());
    }

    #[test]
    fn sites_access_refuses_foreign_production_and_non_https_destinations() {
        let profile = parse(Some(PREPARED), Some(fixture_sha256())).unwrap().unwrap();
        let access = SitesAccessToken::parse("synthetic-sites-access-token").unwrap();
        let mut refused = vec![
            "http://sandbox.example/api/account/me".to_owned(),
            "https://sandbox.example:8443/api/account/me".to_owned(),
            "https://sandbox.example.evil.test/api/account/me".to_owned(),
            "https://other.example/api/account/me".to_owned(),
            "https://user:password@sandbox.example/api/account/me".to_owned(),
            "https://sandbox.example/api/account/me#fragment".to_owned(),
            format!("{}/api/account/me", profile.profile.supabase_origin),
        ];
        refused.extend(PRODUCTION_HOSTS.iter().map(|host| format!("https://{host}/api/account/me")));
        for target in refused {
            let mut request = reqwest::Request::new(reqwest::Method::GET, url::Url::parse(&target).unwrap());
            assert_eq!(attach_sites_access(&mut request, Ok(Some(&profile)), Some(&access)), Err(SITES_ACCESS_REFUSED));
            assert!(!request.headers().contains_key(SITES_ACCESS_HEADER));
        }
    }

    #[test]
    fn sites_access_refuses_invalid_missing_profiles_and_preexisting_header() {
        let profile = parse(Some(PREPARED), Some(fixture_sha256())).unwrap().unwrap();
        let access = SitesAccessToken::parse("synthetic-sites-access-token").unwrap();
        let target = url::Url::parse(&format!("{}/api/account/me", profile.site_origin())).unwrap();
        for configuration in [Ok(None), Err(REFUSED)] {
            let mut request = reqwest::Request::new(reqwest::Method::GET, target.clone());
            assert_eq!(attach_sites_access(&mut request, configuration, Some(&access)), Err(SITES_ACCESS_REFUSED));
            assert!(!request.headers().contains_key(SITES_ACCESS_HEADER));
        }
        let mut request = reqwest::Request::new(reqwest::Method::GET, target);
        assert_eq!(attach_sites_access(&mut request, Err(REFUSED), None), Err(SITES_ACCESS_REFUSED));
        request.headers_mut().insert(SITES_ACCESS_HEADER, HeaderValue::from_static("Bearer caller-token"));
        assert_eq!(attach_sites_access(&mut request, Ok(Some(&profile)), Some(&access)), Err(SITES_ACCESS_REFUSED));
        assert_eq!(request.headers()[SITES_ACCESS_HEADER], "Bearer caller-token");
    }

    #[test]
    fn sites_access_preserves_site_paths_and_ordinary_tests_without_a_token() {
        let profile = parse(Some(PREPARED), Some(fixture_sha256())).unwrap().unwrap();
        let access = SitesAccessToken::parse("synthetic-sites-access-token").unwrap();
        for path in ["/api/account/device/start", "/api/account/device/poll", "/api/account/collaboration?id=fixture&content=1", crate::action_engine_device_protocol::PATH, crate::action_engine_device_protocol::WORK_PATH, "/api/stripe/refresh"] {
            let target = url::Url::parse(&format!("{}{path}", profile.site_origin())).unwrap();
            let mut request = reqwest::Request::new(reqwest::Method::POST, target.clone());
            attach_sites_access(&mut request, Ok(Some(&profile)), None).unwrap();
            assert!(!request.headers().contains_key(SITES_ACCESS_HEADER));
            attach_sites_access(&mut request, Ok(Some(&profile)), Some(&access)).unwrap();
            assert_eq!(request.url(), &target);
            assert!(request.headers().get(SITES_ACCESS_HEADER).unwrap().is_sensitive());
        }
        let mut ordinary = reqwest::Request::new(reqwest::Method::GET, url::Url::parse("https://zentraapp.ch/api/account/me").unwrap());
        attach_sites_access(&mut ordinary, Ok(None), None).unwrap();
        assert!(!ordinary.headers().contains_key(SITES_ACCESS_HEADER));
    }
}
