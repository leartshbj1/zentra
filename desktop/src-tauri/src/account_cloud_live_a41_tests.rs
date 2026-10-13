// Opt-in CI library tests only. The duplex pipe is the sole private channel;
// approval codes, tokens and profile paths never enter stdout or diagnostics.
use super::*;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const PROFILE_SHA256: &str = "2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf";
const SITE_ORIGIN: &str = "https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site";
const PUBLIC_KEY: &str = "hLFfY6E43JD0Sz-gUOrhOHY8mxQHqyu2875H2oXPQb0";
const LICENSE_KID: &str = "sandbox-action-engine-a41";
const OWNER_ID: &str = "1f0d9981-607b-4848-9374-587035cdfd89";
const ORGANIZATION_ID: &str = "org_trial_345a3d1f68056cf7e709d4af4fc229a4";
const PRIVATE_FORMAT: &str = "zentra-a41-native-private-v1";
const PIPE_PREFIX: &str = r"\\.\pipe\zentra-a41-native-";
const MAX_MESSAGE: usize = 32 * 1024;
type RecipeResult<T> = Result<T, ()>;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallationProof {
    installation_id: String,
    license_id: String,
    account_session_id: String,
    jti: String,
    license_sha256: String,
    // Private comparison only. The coordinator strips it from its report.
    session_sha256: String,
}

// No Debug/Serialize: credentials can only be consumed from the private pipe.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateInput {
    format: String,
    phase: String,
    sites_service_token: String,
    expected_owner_id: String,
    expected_organization_id: String,
    root_dir: Option<String>,
    baseline: Option<Vec<InstallationProof>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Acknowledgement {
    event: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PipeChallenge {
    challenge: String,
}

fn read_message<T: DeserializeOwned>(reader: &mut impl Read) -> RecipeResult<T> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0_u8; 1];
        reader.read_exact(&mut byte).map_err(|_| ())?;
        if byte[0] == b'\n' { break; }
        if bytes.len() == MAX_MESSAGE { return Err(()); }
        bytes.push(byte[0]);
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}

struct PrivatePipe(std::fs::File);

impl PrivatePipe {
    fn open() -> RecipeResult<Self> {
        let path = std::env::var("ZENTRA_A41_NATIVE_PRIVATE_PIPE").map_err(|_| ())?;
        let suffix = path.strip_prefix(PIPE_PREFIX).ok_or(())?;
        let uuid = Uuid::parse_str(suffix).map_err(|_| ())?;
        if uuid.get_version() != Some(Version::Random) || uuid.to_string() != suffix {
            return Err(());
        }
        let file = std::fs::OpenOptions::new().read(true).write(true).open(path).map_err(|_| ())?;
        Ok(Self(file))
    }

    fn read<T: DeserializeOwned>(&mut self) -> RecipeResult<T> {
        read_message(&mut self.0)
    }

    fn write(&mut self, value: serde_json::Value) -> RecipeResult<()> {
        let bytes = serde_json::to_vec(&value).map_err(|_| ())?;
        if bytes.len() > MAX_MESSAGE { return Err(()); }
        self.0.write_all(&bytes).map_err(|_| ())?;
        self.0.write_all(b"\n").map_err(|_| ())?;
        self.0.flush().map_err(|_| ())
    }

    fn acknowledge(&mut self, expected: &str) -> RecipeResult<()> {
        let value: Acknowledgement = self.read()?;
        if value.event != expected { return Err(()); }
        Ok(())
    }
}

fn closed_profile_guard() -> RecipeResult<()> {
    // This runs before opening even the private pipe or creating a directory.
    if !cfg!(target_os = "windows")
        || option_env!("ZENTRA_ACTION_NATIVE_TEST_CONTEXT") != Some("live-sandbox-a41")
        || std::env::var("CIRCLECI").as_deref() != Ok("true")
        || std::env::var("CIRCLE_BRANCH").as_deref() != Ok("codex/action-engine-native-live-a41")
    { return Err(()); }
    let profile = crate::native_test_profile::require().map_err(|_| ())?;
    if profile.sha256() != PROFILE_SHA256
        || profile.site_origin() != SITE_ORIGIN
        || profile.license_kid() != LICENSE_KID
        || base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(profile.license_key()) != PUBLIC_KEY
    { return Err(()); }
    Ok(())
}

fn admitted_pipe(phase: &str) -> RecipeResult<(PrivatePipe, PrivateInput)> {
    closed_profile_guard()?;
    // Authenticate this pipe client with a nonce delivered only to this child
    // over its inherited private stdin, before the coordinator sends a token.
    let challenge: PipeChallenge = read_message(&mut std::io::stdin().lock())?;
    if challenge.challenge.len() != 43
        || !challenge.challenge.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    { return Err(()); }
    let mut pipe = PrivatePipe::open()?;
    pipe.write(json!({"event":"hello","challenge":challenge.challenge}))?;
    let input: PrivateInput = pipe.read()?;
    if input.format != PRIVATE_FORMAT || input.phase != phase
        || input.expected_owner_id != OWNER_ID || input.expected_organization_id != ORGANIZATION_ID
        || (phase == "enroll" && (input.root_dir.is_some() || input.baseline.is_some()))
        || (phase == "reopen" && (input.root_dir.is_none() || input.baseline.as_ref().map(Vec::len) != Some(2)))
    { return Err(()); }
    crate::native_test_profile::install_sites_access_token(&input.sites_service_token).map_err(|_| ())?;
    pipe.write(json!({"event":"admitted","phase":phase,"profileSha256":PROFILE_SHA256}))?;
    // The coordinator verifies the real browser owner/workspace before this.
    pipe.acknowledge("continue")?;
    Ok((pipe, input))
}

fn installation_uuid(value: &str) -> RecipeResult<()> {
    let uuid = Uuid::parse_str(value).map_err(|_| ())?;
    if uuid.get_version() != Some(Version::Random) || uuid.to_string() != value { return Err(()); }
    Ok(())
}

fn native_proof(store: &LocalStore) -> RecipeResult<InstallationProof> {
    let session = read_session_secret(store).map_err(|_| ())?.ok_or(())?;
    validate_session_for_installation(&session, &store.installation_id).map_err(|_| ())?;
    if session.organization_id != ORGANIZATION_ID || session.role != "owner" { return Err(()); }
    // The ordinary account screen tolerates offline cached state. This proof
    // independently requires a real HTTP 200, never that offline fallback.
    let (status, bytes) = tauri::async_runtime::block_on(account_request(
        Method::GET, ME_PATH, None, Some(&session.session_token),
    )).map_err(|_| ())?;
    if status != StatusCode::OK { return Err(()); }
    let me: MeResponse = parse_json(&bytes, "recette").map_err(|_| ())?;
    if me.user_id != OWNER_ID || me.organization.id != ORGANIZATION_ID
        || me.organization.role != "owner" || me.installation_id != store.installation_id
        || parse_future_or_past_date(&me.entitlement_valid_until, "recette").map_err(|_| ())? <= Utc::now()
    { return Err(()); }
    let connected = tauri::async_runtime::block_on(cloud_account_state(store)).map_err(|_| ())?;
    if connected.status != "connected" || connected.organization_id.as_deref() != Some(ORGANIZATION_ID)
        || connected.role.as_deref() != Some("owner")
    { return Err(()); }

    let _guard = store.lock().map_err(|_| ())?;
    let state = store.get_license_state().map_err(|_| ())?;
    if state["enforcement_configured"] != true || state["status"] != "valid"
        || state["read_only"] != false || state["installation_id"] != store.installation_id
    { return Err(()); }
    // This reader only decrypts the ordinary protected token; it never writes
    // a fixture. get_license_state above verifies its signature/key/kid/binding.
    let token = store.read_test_protected_license_token().map_err(|_| ())?.ok_or(())?;
    let license_sha256 = format!("{:x}", Sha256::digest(token.trim().as_bytes()));
    let recorded: String = store.connect().map_err(|_| ())?.query_row(
        "SELECT token_sha256 FROM license_state WHERE id=1", [], |row| row.get(0),
    ).map_err(|_| ())?;
    if recorded != license_sha256 { return Err(()); }
    let payload_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.split('.').next().ok_or(())?).map_err(|_| ())?;
    let payload: crate::models::LicenseTokenPayload = serde_json::from_slice(&payload_bytes).map_err(|_| ())?;
    let account_session_id = payload.account_session_id.ok_or(())?;
    installation_uuid(account_session_id.strip_prefix("dss_").ok_or(())?)?;
    if payload.kid != LICENSE_KID || payload.installation_id != store.installation_id
        || payload.account_user_id.as_deref() != Some(OWNER_ID)
        || payload.access_role != "owner" || state["license_id"] != payload.license_id
    { return Err(()); }
    let session_sha256 = format!("{:x}", Sha256::digest(session.session_token.as_bytes()));
    Ok(InstallationProof { installation_id: store.installation_id.clone(),
        license_id: payload.license_id, account_session_id, jti: payload.jti, license_sha256, session_sha256 })
}

fn complete(pipe: &mut PrivatePipe, phase: &str, proofs: &[InstallationProof]) -> RecipeResult<()> {
    if proofs.len() != 2 || proofs[0].installation_id == proofs[1].installation_id
        || proofs[0].account_session_id == proofs[1].account_session_id
        || proofs[0].license_id == proofs[1].license_id
    { return Err(()); }
    pipe.write(json!({"event":"complete","phase":phase,"profileSha256":PROFILE_SHA256,
        "ownerId":OWNER_ID,"organizationId":ORGANIZATION_ID,"strictMeHttp200":true,
        "nativeLicenseValidated":true,"installations":proofs}))
}

fn enroll() -> RecipeResult<()> {
    let (mut pipe, _input) = admitted_pipe("enroll")?;
    let root = tempfile::Builder::new().prefix("zentra-a41-native-").tempdir().map_err(|_| ())?.keep();
    let root_text = root.to_str().ok_or(())?;
    // Private path is retained for the second process, never an artifact.
    pipe.write(json!({"event":"workspace","rootDir":root_text}))?;
    let mut stores = Vec::new();
    for (index, name) in ["device-a", "device-b"].iter().enumerate() {
        let store = LocalStore::initialize(root.join(name)).map_err(|_| ())?;
        installation_uuid(&store.installation_id)?;
        if stores.iter().any(|other: &LocalStore| other.installation_id == store.installation_id) { return Err(()); }
        let pending = tauri::async_runtime::block_on(start_link(&store)).map_err(|_| ())?;
        if pending.status != "pending" { return Err(()); }
        let interval = pending.interval_seconds.ok_or(())?;
        std::thread::sleep(Duration::from_secs(interval));
        if tauri::async_runtime::block_on(poll_link(&store)).map_err(|_| ())?.status != "pending" { return Err(()); }
        pipe.write(json!({"event":"approve","index":index,"installationId":store.installation_id,
            "userCode":pending.user_code.ok_or(())?}))?;
        pipe.acknowledge("approved")?;
        let mut connected = false;
        for _ in 0..6 {
            std::thread::sleep(Duration::from_secs(interval));
            let state = tauri::async_runtime::block_on(poll_link(&store)).map_err(|_| ())?;
            if state.status == "connected" { connected = true; break; }
            if state.status != "pending" { return Err(()); }
        }
        if !connected { return Err(()); }
        stores.push(store);
    }
    // Recheck BOTH after the second authorization, not only its latest device.
    let proofs = stores.iter().map(native_proof).collect::<RecipeResult<Vec<_>>>()?;
    drop(stores);
    complete(&mut pipe, "enroll", &proofs)
}

fn retained_root(value: &str) -> RecipeResult<PathBuf> {
    let root = Path::new(value);
    if !root.is_absolute() || std::fs::symlink_metadata(root).map_err(|_| ())?.file_type().is_symlink() { return Err(()); }
    let root = std::fs::canonicalize(root).map_err(|_| ())?;
    let temporary = std::fs::canonicalize(std::env::temp_dir()).map_err(|_| ())?;
    if root.parent() != Some(temporary.as_path())
        || !root.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("zentra-a41-native-"))
    { return Err(()); }
    Ok(root)
}

fn reopen() -> RecipeResult<()> {
    let (mut pipe, input) = admitted_pipe("reopen")?;
    let root = retained_root(input.root_dir.as_deref().ok_or(())?)?;
    let baseline = input.baseline.ok_or(())?;
    let mut proofs = Vec::new();
    for (index, name) in ["device-a", "device-b"].iter().enumerate() {
        let directory = root.join(name);
        let metadata = std::fs::symlink_metadata(&directory).map_err(|_| ())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink()
            || std::fs::canonicalize(&directory).map_err(|_| ())?.parent() != Some(root.as_path())
        { return Err(()); }
        for file in ["helvichantier.sqlite3", "installation-identity.dpapi", "cloud-account-session.protected",
            "license-token.dpapi", "license-clock.dpapi", "license-installation.dpapi"] {
            let metadata = std::fs::symlink_metadata(directory.join(file)).map_err(|_| ())?;
            if !metadata.is_file() || metadata.file_type().is_symlink() { return Err(()); }
        }
        // Refuse a partial exchange; initialize must reuse the persisted state.
        for file in ["cloud-account-link.protected", "cloud-account-exchange.protected", "license-clock-pending.dpapi"] {
            if directory.join(file).try_exists().map_err(|_| ())? { return Err(()); }
        }
        let store = LocalStore::initialize(directory).map_err(|_| ())?;
        let proof = native_proof(&store)?;
        if proof != baseline[index] { return Err(()); }
        proofs.push(proof);
        drop(store);
    }
    complete(&mut pipe, "reopen", &proofs)
}

#[test]
#[ignore = "Requires explicit A41 CI admission and a private duplex pipe; never ordinary tests"]
fn enroll_two_native_stores() {
    if enroll().is_err() { panic!("ZENTRA_A41_NATIVE_ENROLL_REFUSED"); }
}

#[test]
#[ignore = "Requires the same A41 CI binary and retained protected state from enrollment"]
fn reopen_two_native_stores() {
    if reopen().is_err() { panic!("ZENTRA_A41_NATIVE_REOPEN_REFUSED"); }
}
