use std::{fs, io::ErrorKind, path::Path, sync::{Arc, atomic::{AtomicU64, Ordering}}, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use reqwest::{
    header::{ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE},
    redirect::Policy,
    Method, StatusCode,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::State;
use url::Url;
use uuid::{Uuid, Version};

use crate::{
    database::LocalStore,
    error::{command_error, finish_async_command, AppError, AppResult},
    installation::{
        read_protected_reference, remove_protected, unprotect_protected_reference,
        write_protected_atomically_with_reference_after_server_verification, ProtectedDataCache,
    },
    models::GenerateSalesDocumentPdfInput,
};

const ACCOUNT_API_ORIGIN: &str = "https://zentraapp.ch";
const START_PATH: &str = "/api/account/device/start";
const POLL_PATH: &str = "/api/account/device/poll";
const ME_PATH: &str = "/api/account/me";
const SESSION_PATH: &str = "/api/account/session";
const ARCHIVE_PATH: &str = "/api/archive/invoices";
const TEAM_PATH: &str = "/api/account/team";
const AUTOMATION_PATH: &str = "/api/automation";
const COMPANY_MAIL_PATH: &str = "/api/company-mail";
const ACCOUNT_SESSION_FILE: &str = "cloud-account-session.protected";
const ACCOUNT_PENDING_FILE: &str = "cloud-account-link.protected";
const ACCOUNT_EXCHANGE_FILE: &str = "cloud-account-exchange.protected";
const SECRET_VERSION: u8 = 1;
const MAX_RESPONSE_BYTES: u64 = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) struct ProjectSyncSession {
    pub organization_id: String,
    pub role: String,
    token: String,
}

pub(crate) async fn project_sync_session(store: &LocalStore) -> AppResult<Option<ProjectSyncSession>> {
    // Background operations already authenticate/recheck membership on their
    // own endpoint. An additional /me round-trip per poll added no protection.
    // The account screen/license refresh continues to refresh profile/roles.
    let Some(session) = read_session_secret(store)? else {return Ok(None);};
    if CloudAccountState::from_session(&session)?.status != "connected" {return Ok(None);}
    Ok(Some(ProjectSyncSession { organization_id: session.organization_id, role: session.role, token: session.session_token }))
}

pub(crate) fn bind_new_company_to_account(store: &LocalStore) -> AppResult<()> {
    if let Some(session) = read_session_secret(store)? {
        if CloudAccountState::from_session(&session)?.status == "connected" && ["owner", "admin"].contains(&session.role.as_str()) {
            crate::company_collaboration::account::bind_new_company(store, &session.organization_id)?;
        }
    }
    Ok(())
}

fn project_transport() -> AppResult<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client)=CLIENT.get(){return Ok(client.clone());}
    crate::app_updater::ensure_rustls_crypto_provider().map_err(AppError::Validation)?;
    let client=reqwest::Client::builder().https_only(true).redirect(Policy::none()).connect_timeout(CONNECT_TIMEOUT)
        .user_agent(format!("Zentra/{}", env!("CARGO_PKG_VERSION"))).timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(4).build().map_err(|_|AppError::Validation("Connexion sécurisée indisponible.".into()))?;
    let _=CLIENT.set(client.clone());Ok(client)
}

impl ProjectSyncSession {
    pub async fn request(&self, method: Method, path: &str, query: &[(&str,&str)], headers: &[(&str,String)], body: Option<Vec<u8>>, file: bool) -> AppResult<(StatusCode,Vec<u8>)> {
        let mut url = endpoint(path)?;
        url.query_pairs_mut().extend_pairs(query.iter().copied());
        // Reuse TLS connections; bearer credentials remain per-request and are
        // never stored as default headers on this process-wide connection pool.
        let client = project_transport()?;
        let mut request = client.request(method,url).header(AUTHORIZATION,format!("Bearer {}",self.token));
        for (name,value) in headers { request = request.header(*name,value); }
        if let Some(body) = body {
            if !headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-type")) {
                request = request.header(CONTENT_TYPE,"application/octet-stream");
            }
            request = request.body(body);
        }
        let response = request.send().await.map_err(|_| AppError::Remote("Hors ligne ou service indisponible. Les fichiers restent sur cet appareil ; l’envoi reprendra automatiquement.".into()))?;
        let status = response.status();
        let bytes = read_response_with_limit(response,if file && status.is_success() {25*1024*1024} else {1024*1024}).await?;
        if !status.is_success() && status != StatusCode::GONE { return Err(server_response_error(status,&bytes)); }
        Ok((status,bytes))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PendingAuthorization {
    version: u8,
    installation_id: String,
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_at: String,
    interval_seconds: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CloudSession {
    version: u8,
    installation_id: String,
    session_token: String,
    session_expires_at: String,
    organization_id: String,
    organization_name: String,
    role: String,
    connected_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PendingExchange {
    version: u8,
    installation_id: String,
    session: CloudSession,
    license_token: String,
}

// A private, in-memory admission stamp. None of its credentials, references or
// workspace identity are serialized or written to the diagnostic journal.
#[derive(PartialEq, Eq)]
struct InboxReadStamp {
    session: CloudSession,
    references: [Option<Vec<u8>>; 3],
    revisions: [u64; 3],
    workspace_scope: String,
}

fn optional_account_reference(path: &Path) -> AppResult<Option<Vec<u8>>> {
    match read_protected_reference(path) {
        Ok(reference) => Ok(Some(reference)),
        Err(AppError::Io(error)) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

// The caller holds account -> LocalStore in that order. A same-organization
// restore still changes its private workspace scope. Pending/exchange reference
// changes also matter when the previous active session remains on disk.
fn inbox_read_stamp(store: &LocalStore) -> AppResult<InboxReadStamp> {
    let session = read_session_secret(store)?.ok_or_else(|| {
        AppError::Remote("Connectez votre compte dans les paramètres.".into())
    })?;
    if CloudAccountState::from_session(&session)?.status != "connected" {
        return Err(AppError::Remote("Connectez votre compte dans les paramètres.".into()));
    }
    crate::automation::bound(store, &session.organization_id)?;
    let workspace_scope = crate::work_notes::workspace_scope(&store.connect()?)?;
    let references = [
        optional_account_reference(&session_path(store))?,
        optional_account_reference(&pending_path(store))?,
        optional_account_reference(&exchange_path(store))?,
    ];
    let revisions = [
        store.account_protected_cache.session.revision.load(Ordering::Relaxed),
        store.account_protected_cache.pending.revision.load(Ordering::Relaxed),
        store.account_protected_cache.exchange.revision.load(Ordering::Relaxed),
    ];
    Ok(InboxReadStamp { session, references, revisions, workspace_scope })
}

fn inbox_read_context_changed() -> AppError {
    AppError::Validation("La connexion ou l’entreprise ouverte a changé. Rouvrez la réception.".into())
}

/// Only the two passive inbox lists use this path. Writes and document actions
/// keep their existing guards; this helper never refreshes the account, retries
/// a request, changes a license or turns an obsolete response into an empty list.
pub(crate) async fn bound_inbox_get(store: &LocalStore, path: &'static str) -> AppResult<serde_json::Value> {
    if ![crate::supplier_inbox::PATH, crate::appointment_inbox::PATH].contains(&path) {
        return Err(AppError::Validation("Cette réception n’est pas disponible.".into()));
    }
    bound_inbox_get_with(store, |session| async move {
        session.request(Method::GET, path, &[], &[], None, false).await
    }).await
}

async fn bound_inbox_get_with<F, Fut>(store: &LocalStore, request: F) -> AppResult<serde_json::Value>
where
    F: FnOnce(ProjectSyncSession) -> Fut,
    Fut: std::future::Future<Output = AppResult<(StatusCode, Vec<u8>)>>,
{
    let original = {
        let _account = store.account_protected_cache.operation_lock.lock().await;
        let owned = store.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _local = owned.lock()?;
            inbox_read_stamp(&owned)
        }).await.map_err(|_| AppError::Remote("La réception est indisponible.".into()))??
    };
    let response = request(ProjectSyncSession {
        organization_id: original.session.organization_id.clone(),
        role: original.session.role.clone(),
        token: original.session.session_token.clone(),
    }).await;
    // Neither shared lock survives the original network/header/body wait.
    // Revalidate success AND failure before letting them reach the caller.
    let _account = store.account_protected_cache.operation_lock.lock().await;
    let owned = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _local = owned.lock()?;
        let current = inbox_read_stamp(&owned).map_err(|_| inbox_read_context_changed())?;
        if current != original {
            return Err(inbox_read_context_changed());
        }
        let (_, bytes) = response?;
        serde_json::from_slice(&bytes)
            .map_err(|_| AppError::Remote("La réception est indisponible.".into()))
    }).await.map_err(|_| AppError::Remote("La réception est indisponible.".into()))?
}

#[derive(Clone, Debug, Default)]
struct AccountSecretCache {
    data: ProtectedDataCache,
    // Shared by LocalStore clones. A Keychain rewrite can preserve its opaque
    // marker; controlled writes/removals must still invalidate an old read.
    // Read/cache warm-up never advances this in-memory revision.
    revision: Arc<AtomicU64>,
}

impl std::ops::Deref for AccountSecretCache {
    type Target = ProtectedDataCache;
    fn deref(&self) -> &Self::Target { &self.data }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AccountProtectedCache {
    pending: AccountSecretCache,
    exchange: AccountSecretCache,
    session: AccountSecretCache,
    pub(crate) operation_lock: Arc<futures_util::lock::Mutex<()>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: i64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PollResponse {
    status: String,
    session_token: Option<String>,
    session_expires_at: Option<String>,
    organization: Option<PollOrganization>,
    license: Option<ServerLicense>,
}

#[derive(Debug, Deserialize)]
struct PollOrganization {
    id: String,
    name: String,
    role: String,
}

#[derive(Debug, Deserialize)]
struct ServerLicense {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    display_name: String,
    organization: PollOrganization,
    installation_id: String,
    entitlement_valid_until: String,
}

#[derive(Debug, Deserialize)]
struct ServerError {
    error: String,
}

#[derive(Debug, Deserialize)]
struct ArchiveListResponse {
    archives: Vec<RemoteInvoiceArchive>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteInvoiceArchive {
    id: String,
    revision: i64,
    content_sha256: String,
    retention_until: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveStoreResponse {
    archive: RemoteInvoiceArchive,
    already_stored: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceArchiveResult {
    archive_id: String,
    revision: i64,
    content_sha256: String,
    retention_until: String,
    already_stored: bool,
}

struct LocalInvoiceArchive {
    source_invoice_id: String,
    invoice_number: String,
    issue_date: String,
    paid_at: Option<String>,
    fiscal_year_end: Option<String>,
    pdf_bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccountState {
    status: &'static str,
    organization_id: Option<String>,
    organization_name: Option<String>,
    role: Option<String>,
    session_expires_at: Option<String>,
    user_code: Option<String>,
    verification_uri: Option<String>,
    authorization_expires_at: Option<String>,
    interval_seconds: Option<u64>,
}

impl CloudAccountState {
    fn disconnected() -> Self {
        Self {
            status: "disconnected",
            organization_id: None,
            organization_name: None,
            role: None,
            session_expires_at: None,
            user_code: None,
            verification_uri: None,
            authorization_expires_at: None,
            interval_seconds: None,
        }
    }

    fn from_session(session: &CloudSession) -> AppResult<Self> {
        validate_session(session)?;
        let expires_at = parse_future_or_past_date(&session.session_expires_at, "session")?;
        Ok(Self {
            status: if expires_at > Utc::now() {
                "connected"
            } else {
                "expired"
            },
            organization_id: Some(session.organization_id.clone()),
            organization_name: Some(session.organization_name.clone()),
            role: Some(session.role.clone()),
            session_expires_at: Some(session.session_expires_at.clone()),
            user_code: None,
            verification_uri: None,
            authorization_expires_at: None,
            interval_seconds: None,
        })
    }

    fn inactive(session: &CloudSession) -> AppResult<Self> {
        validate_session(session)?;
        Ok(Self {
            status: "inactive",
            organization_id: Some(session.organization_id.clone()),
            organization_name: Some(session.organization_name.clone()),
            role: Some(session.role.clone()),
            session_expires_at: Some(session.session_expires_at.clone()),
            user_code: None,
            verification_uri: None,
            authorization_expires_at: None,
            interval_seconds: None,
        })
    }

    fn from_pending(pending: &PendingAuthorization) -> AppResult<Self> {
        validate_pending(pending)?;
        Ok(Self {
            status: "pending",
            organization_id: None,
            organization_name: None,
            role: None,
            session_expires_at: None,
            user_code: Some(pending.user_code.clone()),
            verification_uri: Some(pending.verification_uri.clone()),
            authorization_expires_at: Some(pending.expires_at.clone()),
            interval_seconds: Some(pending.interval_seconds),
        })
    }
}

#[tauri::command]
pub async fn get_cloud_account_state(
    state: State<'_, LocalStore>,
) -> Result<CloudAccountState, String> {
    let store = state.inner().clone();
    finish_async_command(cloud_account_state(&store).await).await
}

pub(crate) struct CompanyMailSession(CloudSession);
impl CompanyMailSession {
    pub(crate) fn organization_id(&self) -> &str { &self.0.organization_id }
}
pub(crate) async fn company_mail_session(store: &LocalStore) -> AppResult<Option<CompanyMailSession>> {
    let _guard=store.account_protected_cache.operation_lock.lock().await;
    let Some(session)=read_session_secret(store)? else {return Ok(None)};
    validate_session_for_installation(&session,&store.installation_id)?;
    if parse_future_or_past_date(&session.session_expires_at,"session")?<=Utc::now(){return Err(AppError::Validation("Reconnectez votre compte Zentra pour utiliser la messagerie partagée.".into()));}
    crate::automation::bound(store,&session.organization_id)?;
    Ok(Some(CompanyMailSession(session)))
}
fn validate_mail_session(store:&LocalStore, expected:&CompanyMailSession) -> AppResult<()> {
    let current=read_session_secret(store)?.ok_or_else(||AppError::Validation("La connexion a changé. Rouvrez la messagerie.".into()))?;
    if current.organization_id!=expected.0.organization_id || current.session_token!=expected.0.session_token {
        return Err(AppError::Validation("La connexion a changé. Rouvrez la messagerie.".into()));
    }
    crate::automation::bound(store,&current.organization_id)?;
    Ok(())
}
pub(crate) async fn company_mail_request(store:&LocalStore, session:&CompanyMailSession, query:&[(&str,String)], data:Option<serde_json::Value>) -> AppResult<serde_json::Value> {
    {let _guard=store.account_protected_cache.operation_lock.lock().await;validate_mail_session(store,session)?;}
    let mut url=endpoint(COMPANY_MAIL_PATH)?;
    url.query_pairs_mut().append_pair("organizationId",session.organization_id());
    for (key,value) in query {if !matches!(*key,"entity"|"documentId"|"requestId"){return Err(AppError::Validation("Demande de messagerie invalide.".into()));}url.query_pairs_mut().append_pair(key,value);}
    let body=data.map(|mut value|{value["organizationId"]=json!(session.organization_id());serde_json::to_vec(&value)}).transpose()?;
    if body.as_ref().is_some_and(|b|b.len()>9*1024*1024){return Err(AppError::Validation("L’e-mail est trop volumineux. Le PDF doit peser moins de 6 Mo.".into()));}
    let method=if body.is_some(){Method::POST}else{Method::GET};
    let timeout=if method==Method::POST {Duration::from_secs(110)}else{Duration::from_secs(20)};
    // Never retry a POST or switch to SMTP after a transport failure.
    let (status,bytes)=account_request_url(method,url,body,Some(&session.0.session_token),timeout).await?;
    {let _guard=store.account_protected_cache.operation_lock.lock().await;validate_mail_session(store,session)?;}
    if !status.is_success(){return Err(server_response_error(status,&bytes));}
    let value:serde_json::Value=parse_json(&bytes,"messagerie partagée")?;
    if value["organizationId"].as_str()!=Some(session.organization_id()){return Err(AppError::Validation("La messagerie ne correspond pas à cette entreprise.".into()));}
    Ok(value)
}

#[tauri::command]
pub async fn get_cached_cloud_account_state(
    state: State<'_, LocalStore>,
) -> Result<CloudAccountState, String> {
    let store = state.inner().clone();
    let result = {
        let _guard = store.account_protected_cache.operation_lock.lock().await;
        cached_cloud_account_state_worker(&store).await
    };
    finish_async_command(result).await
}

// Reading the protected account cache does not acquire LocalStore.lock.
// Keep this step separate from the licence mutation which may need to wait for
// an admitted local write. Callers serialize the session with the account mutex.
fn read_cached_cloud_account_state(store: &LocalStore) -> AppResult<CloudAccountState> {
    if let Some(session) = read_session_secret(store)? {
        return CloudAccountState::from_session(&session);
    }
    if let Some(pending) = read_pending_secret(store)? {
        return CloudAccountState::from_pending(&pending);
    }
    Ok(CloudAccountState::disconnected())
}

// Synchronous callers retain the established expiry/licence behavior.
fn cached_cloud_account_state(store: &LocalStore) -> AppResult<CloudAccountState> {
    let state = read_cached_cloud_account_state(store)?;
    if state.status == "expired" {
        store.mark_current_license_unrecognized_locally()?;
    }
    Ok(state)
}

#[derive(Clone, Copy)]
enum AccountLicenseMark {
    LocalUnrecognized,
    ServerUnrecognized,
    ServerInactive,
}

// The caller retains the account operation guard while the existing licence
// guard waits on the worker. Never add a local guard around these methods: they
// acquire it themselves and validate the installed token and protected clock.
async fn mark_account_license_worker(store: &LocalStore, mark: AccountLicenseMark) -> AppResult<()> {
    let owned = store.clone();
    tauri::async_runtime::spawn_blocking(move || match mark {
        AccountLicenseMark::LocalUnrecognized => owned.mark_current_license_unrecognized_locally(),
        AccountLicenseMark::ServerUnrecognized => owned.mark_current_license_unrecognized_after_server_verification(),
        AccountLicenseMark::ServerInactive => owned.mark_current_license_inactive_after_server_verification(),
    }).await.map_err(|_| AppError::Validation("La vérification de l’accès au compte a été interrompue.".into()))?
}

async fn cached_cloud_account_state_worker(store: &LocalStore) -> AppResult<CloudAccountState> {
    let state = read_cached_cloud_account_state(store)?;
    if state.status == "expired" {
        mark_account_license_worker(store, AccountLicenseMark::LocalUnrecognized).await?;
    }
    Ok(state)
}

pub(crate) async fn team_response(store: &LocalStore, data: Option<serde_json::Value>) -> AppResult<serde_json::Value> {
    let session = read_session_secret(store)?.ok_or_else(|| AppError::Validation("Connectez cet appareil à votre entreprise.".into()))?;
    validate_session_for_installation(&session, &store.installation_id)?;
    if parse_future_or_past_date(&session.session_expires_at, "session")? <= Utc::now() {
        return Err(AppError::Validation("Votre connexion a expiré. Demandez un nouveau code.".into()));
    }
    let method = if data.is_some() { Method::POST } else { Method::GET };
    let body = data.map(|value| serde_json::to_vec(&value)).transpose()?;
    if body.as_ref().is_some_and(|bytes| bytes.len() > 32_768) {
        return Err(AppError::Validation("Les informations partagées sont trop volumineuses.".into()));
    }
    let (status, bytes) = account_request(method.clone(), TEAM_PATH, body, Some(&session.session_token)).await?;
    if !status.is_success() { return Err(server_response_error(status, &bytes)); }
    let response: serde_json::Value = parse_json(&bytes, "équipe")?;
    if method == Method::GET && response["organizationId"].as_str() != Some(&session.organization_id) {
        return Err(AppError::Validation("La réponse ne correspond pas à votre entreprise.".into()));
    }
    Ok(response)
}

#[tauri::command]
pub async fn cloud_team_request(state: State<'_, LocalStore>, data: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let store = state.inner().clone();
    let result = {
        let _guard = store.account_protected_cache.operation_lock.lock().await;
        team_response(&store, data).await
    };
    finish_async_command(result).await
}

#[tauri::command]
pub async fn automation_request(state: State<'_, LocalStore>, data: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let store = state.inner().clone();
    automation_request_with(
        &store,
        data,
        |method, url, body, bearer| async move {
            account_request_url(method, url, body, Some(&bearer), Duration::from_secs(20)).await
        },
        finish_async_command::<serde_json::Value>,
    ).await
}

// Preserve the direct, already formatted refusal strings: they did not pass
// through command_error and must not acquire a new prefix or native event.
enum AutomationCommandError {
    Native(AppError),
    Message(String),
}

impl From<AppError> for AutomationCommandError {
    fn from(error: AppError) -> Self {
        Self::Native(error)
    }
}

pub(super) async fn automation_request_with<Request, RequestFuture, Finish, FinishFuture>(
    store: &LocalStore,
    data: Option<serde_json::Value>,
    request: Request,
    finish: Finish,
) -> Result<serde_json::Value, String>
where
    Request: FnOnce(Method, Url, Option<Vec<u8>>, String) -> RequestFuture,
    RequestFuture: std::future::Future<Output = AppResult<(StatusCode, Vec<u8>)>>,
    Finish: FnOnce(AppResult<serde_json::Value>) -> FinishFuture,
    FinishFuture: std::future::Future<Output = Result<serde_json::Value, String>>,
{
    let result: Result<serde_json::Value, AutomationCommandError> = async {
        let session = {
            let _guard = store.account_protected_cache.operation_lock.lock().await;
            let session = read_session_secret(store)?.ok_or_else(|| AutomationCommandError::Message(
                "Connectez votre compte dans Paramètres → Compte et accès.".into(),
            ))?;
            validate_session_for_installation(&session, &store.installation_id)?;
            if parse_future_or_past_date(&session.session_expires_at, "session")? <= Utc::now() {
                return Err(AutomationCommandError::Message(
                    "Reconnectez votre compte Zentra pour obtenir des suggestions.".into(),
                ));
            }
            session
        };
        // Even read-only summaries must belong to the company opened locally.
        crate::automation::bound(store, &session.organization_id)?;
        let body = data
            .map(|value| crate::automation::prepare_request(store, &session.organization_id, &session.role, value))
            .transpose()?
            .map(|value| serde_json::to_vec(&value))
            .transpose()
            .map_err(|_| AutomationCommandError::Message("La demande est invalide.".into()))?;
        let method = if body.is_some() { Method::POST } else { Method::GET };
        let (status, bytes) = request(method, endpoint(AUTOMATION_PATH)?, body, session.session_token.clone()).await?;
        if !status.is_success() {
            return Err(server_response_error(status, &bytes).into());
        }
        let value: serde_json::Value = parse_json(&bytes, "suggestion")?;
        // Preserve the atomic postflight session/company/resource checks.
        let _guard = store.account_protected_cache.operation_lock.lock().await;
        let current = read_session_secret(store)?.ok_or_else(|| AutomationCommandError::Message(
            "La connexion a changé.".into(),
        ))?;
        if current.organization_id != session.organization_id || current.session_token != session.session_token {
            return Err(AutomationCommandError::Message(
                "La connexion a changé. Relancez la suggestion.".into(),
            ));
        }
        crate::automation::bound(store, &session.organization_id)?;
        crate::automation::validate_response(store, &session.organization_id, &value)?;
        Ok(value)
    }.await;
    // The inner future has ended, so neither account guard survives into the
    // awaited, best-effort log worker. No detached task or result substitution.
    match result {
        Ok(value) => Ok(value),
        Err(AutomationCommandError::Message(message)) => Err(message),
        Err(AutomationCommandError::Native(error)) => finish(Err(error)).await,
    }
}

#[tauri::command]
pub async fn subscription_overview_request(state: State<'_, LocalStore>) -> Result<serde_json::Value,String> {
    let store=state.inner().clone();
    let session={
        let _guard=store.account_protected_cache.operation_lock.lock().await;
        let session=read_session_secret(&store).map_err(command_error)?.ok_or("Connectez votre compte Zentra.")?;
        validate_session_for_installation(&session,&store.installation_id).map_err(command_error)?;
        if parse_future_or_past_date(&session.session_expires_at,"session").map_err(command_error)?<=Utc::now(){return Err("Reconnectez votre compte pour consulter l’abonnement.".into());}
        session
    };
    crate::automation::bound(&store,&session.organization_id).map_err(command_error)?;
    let (status,bytes)=account_request(Method::GET,"/api/account/subscription",None,Some(&session.session_token)).await.map_err(command_error)?;
    if !status.is_success(){return Err(command_error(server_response_error(status,&bytes)));}
    let value:serde_json::Value=parse_json(&bytes,"abonnement").map_err(command_error)?;
    let _guard=store.account_protected_cache.operation_lock.lock().await;
    let current=read_session_secret(&store).map_err(command_error)?.ok_or("La connexion a changé.")?;
    if current.organization_id!=session.organization_id || current.session_token!=session.session_token || value.get("organizationId").and_then(|v|v.as_str())!=Some(session.organization_id.as_str()){return Err("La connexion a changé. Rouvrez votre abonnement.".into());}
    crate::automation::bound(&store,&session.organization_id).map_err(command_error)?;
    Ok(value)
}

#[tauri::command]
pub async fn open_automation_settings() -> Result<String,String> {
    let uri="https://zentraapp.ch/compte/automation".to_string();
    tauri::async_runtime::spawn_blocking(move||{launch_external_url(&uri).map_err(command_error)?;Ok(uri)}).await.map_err(|error|error.to_string())?
}
#[tauri::command]
pub async fn open_supplier_inbox_settings(state: State<'_, LocalStore>, section: Option<String>, ticket_id: Option<String>) -> Result<String,String> {
    let store=state.inner().clone();
    let uri={
        let _guard=store.account_protected_cache.operation_lock.lock().await;
        let session=read_session_secret(&store).map_err(command_error)?.ok_or_else(||"Connectez votre entreprise à Zentra.".to_string())?;
        supplier_inbox_uri(&store,&session,section.as_deref(),ticket_id.as_deref()).map_err(command_error)?
    };
    tauri::async_runtime::spawn_blocking(move||{launch_external_url(&uri).map_err(command_error)?;Ok(uri)}).await.map_err(|error|error.to_string())?
}

// Navigation only: Support rechecks its own browser session, company membership
// and ticket scope. Never place a native credential in the external URL.
fn supplier_inbox_uri(store: &LocalStore, session: &CloudSession, section: Option<&str>, ticket_id: Option<&str>) -> AppResult<String> {
    validate_session_for_installation(session,&store.installation_id)?;
    if parse_future_or_past_date(&session.session_expires_at,"session")?<=Utc::now(){
        return Err(AppError::Validation("Reconnectez votre compte Zentra pour ouvrir Support.".into()));
    }
    crate::automation::bound(store,&session.organization_id)?;
    if let Some(id)=ticket_id {
        let parsed=Uuid::parse_str(id).map_err(|_|AppError::Validation("Le message reçu est invalide.".into()))?;
        if parsed.is_nil() || parsed.to_string()!=id.to_ascii_lowercase(){
            return Err(AppError::Validation("Le message reçu est invalide.".into()));
        }
    }
    let mut url=Url::parse(ACCOUNT_API_ORIGIN).map_err(|_|AppError::Validation("Adresse indisponible.".into()))?;
    url.set_path("/support/espace");
    let mut query=url.query_pairs_mut();
    query.append_pair("organizationId",&session.organization_id)
        .append_pair("section",if ticket_id.is_some() || section==Some("inbox"){"inbox"}else{"connections"});
    if let Some(id)=ticket_id {query.append_pair("ticket",id);}
    drop(query);
    Ok(url.to_string())
}

#[tauri::command]
pub async fn join_cloud_company(state: State<'_, LocalStore>) -> Result<(), String> {
    let store = state.inner().clone();
    let _account = store.account_protected_cache.operation_lock.lock().await;
    if crate::company_collaboration::join(&store).await.map_err(command_error)? {return Ok(());}
    let response = team_response(&store, None).await.map_err(command_error)?;
    let id = response["companyCopy"]["backupId"].as_str().ok_or_else(|| "Le titulaire doit partager une copie complète depuis Paramètres → Compte et équipe. Réessayez ensuite.".to_owned())?;
    crate::cloud_backup::join_company_copy(&store, id).await.map_err(command_error)
}

#[cfg(test)]
fn initialize_joined_company(store: &LocalStore, response: &serde_json::Value) -> Result<(), String> {
    let profile = response.get("profile").filter(|value| value.is_object()).ok_or_else(|| "Le titulaire doit partager les coordonnées de l’entreprise dans Paramètres → Compte et équipe.".to_owned())?;
    let mut input: crate::models::OnboardingInput = serde_json::from_value(profile.clone()).map_err(|_| "Les coordonnées partagées sont incomplètes. Demandez au titulaire de les actualiser.".to_owned())?;
    input.logo_path = None;
    input.extra_settings_json = None;
    let _local = store.lock().map_err(command_error)?;
    if store.app_state(env!("CARGO_PKG_VERSION")).map_err(command_error)?.onboarding_completed {
        return Err("Une entreprise existe déjà sur cet appareil. Elle est conservée ; rejoindre ne peut pas la remplacer.".into());
    }
    // The server-verified member may initialize an empty local identity even in
    // read-only mode. This command never overwrites an existing workspace.
    store.complete_onboarding_scoped(input, env!("CARGO_PKG_VERSION"), crate::database::OnboardingValidationScope::Essential).map_err(command_error)?;
    Ok(())
}

#[tauri::command]
pub async fn start_cloud_account_link(
    state: State<'_, LocalStore>,
) -> Result<CloudAccountState, String> {
    let store = state.inner().clone();
    let result = {
        let _guard = store.account_protected_cache.operation_lock.lock().await;
        start_link(&store).await
    };
    finish_async_command(result).await
}

#[tauri::command]
pub async fn poll_cloud_account_link(
    state: State<'_, LocalStore>,
) -> Result<CloudAccountState, String> {
    let store = state.inner().clone();
    let result = {
        let _guard = store.account_protected_cache.operation_lock.lock().await;
        poll_link(&store).await
    };
    finish_async_command(result).await
}

#[tauri::command]
pub async fn open_cloud_account_link(state: State<'_, LocalStore>) -> Result<String, String> {
    let pending = read_pending_secret(state.inner())
        .map_err(command_error)?
        .ok_or_else(|| "Aucune connexion de compte n’est en attente.".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        open_verification_uri(&pending.verification_uri).map_err(command_error)?;
        Ok(pending.verification_uri)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_cloud_account_portal(state: State<'_, LocalStore>, section: Option<String>) -> Result<String, String> {
    let organization = read_session_secret(state.inner()).map_err(command_error)?.map(|session|session.organization_id);
    let uri = account_portal_uri(section.as_deref(), organization.as_deref()).map_err(command_error)?;
    tauri::async_runtime::spawn_blocking(move || {
        launch_external_url(&uri).map_err(command_error)?;
        Ok(uri)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn account_portal_uri(section: Option<&str>, organization: Option<&str>) -> AppResult<String> {
    let section = section.unwrap_or("");
    if !["", "profil", "entreprise", "equipe", "securite", "connexions", "apparence", "abonnement", "automation", "donnees"].contains(&section) {
        return Err(AppError::Validation("Choisissez une rubrique du compte Zentra.".into()));
    }
    let path = if section.is_empty() { "/compte".to_owned() } else { format!("/compte/{section}") };
    let mut url = Url::parse(ACCOUNT_API_ORIGIN).map_err(|_|AppError::Validation("Adresse du compte indisponible.".into()))?;
    url.set_path(&path);
    if let Some(id) = organization { url.query_pairs_mut().append_pair("organizationId",id); }
    Ok(url.to_string())
}

#[tauri::command]
pub async fn disconnect_cloud_account(state: State<'_, LocalStore>) -> Result<(), String> {
    let store = state.inner().clone();
    let result = {
        let _guard = store.account_protected_cache.operation_lock.lock().await;
        disconnect(&store).await
    };
    finish_async_command(result).await
}

#[tauri::command]
pub async fn archive_invoice_to_cloud(
    state: State<'_, LocalStore>,
    invoice_id: String,
    correction_reason: Option<String>,
    expected_workspace_scope: Option<String>,
) -> Result<InvoiceArchiveResult, String> {
    let store = state.inner().clone();
    let result = {
        let _guard = store.account_protected_cache.operation_lock.lock().await;
        archive_invoice(&store, &invoice_id, correction_reason.as_deref(), expected_workspace_scope).await
    };
    finish_async_command(result).await
}

async fn cloud_account_state(store: &LocalStore) -> AppResult<CloudAccountState> {
    cloud_account_state_with(store, |token| async move {
        account_request(Method::GET, ME_PATH, None, Some(&token)).await
    }).await
}

async fn cloud_account_state_with<F, Fut>(store: &LocalStore, request: F) -> AppResult<CloudAccountState>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = AppResult<(StatusCode, Vec<u8>)>>,
{
    let original = {
        let _guard = store.account_protected_cache.operation_lock.lock().await;
        let cached = cached_cloud_account_state_worker(store).await?;
        if cached.status != "connected" { return Ok(cached); }
        read_session_secret(store)?
    };
    if let Some(mut session) = original {
        let cached = CloudAccountState::from_session(&session)?;
        if cached.status != "connected" {
            // Expiry may cross the boundary after the first account guard was
            // released. Recheck the original session under that guard before
            // invalidating the current licence, just as for a late /me result.
            let _guard = store.account_protected_cache.operation_lock.lock().await;
            let current = read_session_secret(store)?;
            if !same_account_session(current.as_ref(), &session) {
                return cached_cloud_account_state_worker(store).await;
            }
            if cached.status == "expired" {
                mark_account_license_worker(store, AccountLicenseMark::LocalUnrecognized).await?;
            }
            return Ok(cached);
        }
        let response = request(session.session_token.clone()).await;
        // Network latency must not hold the shared account lock: the already
        // bound company and Automation can open while this check is in flight.
        let _guard = store.account_protected_cache.operation_lock.lock().await;
        let current = read_session_secret(store)?;
        if !same_account_session(current.as_ref(), &session) {
            return cached_cloud_account_state_worker(store).await;
        }
        let cached = cached_cloud_account_state_worker(store).await?;
        if cached.status != "connected" { return Ok(cached); }
        let (status, bytes) = match response {
            Ok(value) => value,
            // Le travail local reste disponible pendant une panne réseau. Le
            // bail signé et son ancre protégée continuent de faire autorité.
            Err(_) => return Ok(cached),
        };
        if status.is_success() {
            let me: MeResponse = parse_json(&bytes, "vérification du compte")?;
            parse_future_or_past_date(&me.entitlement_valid_until, "abonnement")?;
            if me.installation_id != store.installation_id
                || me.organization.id != session.organization_id
            {
                invalidate_current_account_context_worker(store).await?;
                return Ok(CloudAccountState::disconnected());
            }
            let (profile_changed, role_changed) =
                session_profile_changes(&session, &me.organization);
            if profile_changed {
                session.organization_name = me.organization.name;
                session.role = me.organization.role;
                validate_session_for_installation(&session, &store.installation_id)?;
            }
            if role_changed {
                // La licence actuelle porte encore l'ancien rôle signé. Elle
                // reste bloquée jusqu'à sa réémission immédiate par App.tsx.
                mark_account_license_worker(store, AccountLicenseMark::ServerUnrecognized).await?;
            }
            if profile_changed {
                write_server_verified_secret(
                    &session_path(store),
                    &session,
                    &store.account_protected_cache.session,
                )?;
            }
            if !me.user_id.is_empty() && !me.email.is_empty() {
                let name = if me.display_name.trim().is_empty() { me.email.clone() } else { me.display_name.trim().to_owned() };
                let owned = store.clone();
                let organization = session.organization_id.clone();
                let user_id = me.user_id.clone();
                let role = session.role.clone();
                // Keep the account -> local lock order while allowing the
                // executor to continue if an admitted local write owns its lock.
                tauri::async_runtime::spawn_blocking(move || {
                    crate::company_collaboration::set_identity(&owned, &organization, &user_id, &name, &role)
                }).await.map_err(|_| AppError::Validation("La vérification de votre identité locale a été interrompue.".into()))??;
            }
            return CloudAccountState::from_session(&session);
        }
        if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            invalidate_current_account_context_worker(store).await?;
            return Ok(CloudAccountState::disconnected());
        }
        if status == StatusCode::PAYMENT_REQUIRED {
            mark_account_license_worker(store, AccountLicenseMark::ServerInactive).await?;
            return CloudAccountState::inactive(&session);
        }
        if status.is_server_error() {
            return Ok(cached);
        }
        return Err(server_response_error(status, &bytes));
    }
    if let Some(pending) = read_pending_secret(store)? {
        return CloudAccountState::from_pending(&pending);
    }
    Ok(CloudAccountState::disconnected())
}

fn same_account_session(current: Option<&CloudSession>, expected: &CloudSession) -> bool {
    current.is_some_and(|current| {
        current.session_token == expected.session_token
            && current.organization_id == expected.organization_id
            && current.role == expected.role
            && current.session_expires_at == expected.session_expires_at
    })
}

fn clear_local_member_identity(store: &LocalStore) -> AppResult<()> {
    let _local = store.lock()?;
    clear_local_member_identity_already_locked(store)
}

// Only for callers which already hold LocalStore.lock, such as reset/recovery.
// Do not reacquire the non-reentrant mutex while forgetting their account.
fn clear_local_member_identity_already_locked(store: &LocalStore) -> AppResult<()> {
    let connection = store.connect()?;
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_local_identity')",
        [], |row| row.get(0),
    )?;
    if exists {
        connection.execute("DELETE FROM company_local_identity", [])?;
    }
    // A new authorization must invalidate a local action even when there was
    // no cloud identity row yet. Do not rotate the persistent draft workspace.
    crate::member_context::rotate(&connection)?;
    Ok(())
}

async fn clear_local_member_identity_worker(store: &LocalStore) -> AppResult<()> {
    let owned = store.clone();
    tauri::async_runtime::spawn_blocking(move || clear_local_member_identity(&owned))
        .await.map_err(|_| AppError::Validation("Le changement de compte local a été interrompu.".into()))?
}


// The caller retains the account operation mutex after confirming this is still
// the original session. Both licence invalidation and identity clearing acquire
// the local mutex themselves, sequentially; do not surround them with another
// local guard. Keep their lock waits off the async executor.
async fn invalidate_current_account_context_worker(store: &LocalStore) -> AppResult<()> {
    let owned = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        owned.mark_current_license_unrecognized_after_server_verification()?;
        remove_secret(&session_path(&owned), &owned.account_protected_cache.session)?;
        clear_local_member_identity(&owned)
    }).await.map_err(|_| AppError::Validation("La déconnexion du contexte local a été interrompue.".into()))?
}

async fn start_link(store: &LocalStore) -> AppResult<CloudAccountState> {
    // A new authorization may belong to another person in the same company.
    // Drafts cannot reuse the previous person's local identity before /me has
    // verified and installed the member for the new session.
    clear_local_member_identity_worker(store).await?;
    let body = serde_json::to_vec(&json!({ "installationId": store.installation_id }))?;
    let (status, bytes) = account_request(Method::POST, START_PATH, Some(body), None).await?;
    if !status.is_success() {
        return Err(server_response_error(status, &bytes));
    }
    let response: StartResponse = parse_json(&bytes, "demande de connexion")?;
    let expires_at = Utc::now()
        .checked_add_signed(chrono::Duration::seconds(response.expires_in))
        .ok_or_else(|| AppError::Validation("Expiration de connexion invalide.".into()))?;
    let pending = PendingAuthorization {
        version: SECRET_VERSION,
        installation_id: store.installation_id.clone(),
        device_code: response.device_code,
        user_code: response.user_code,
        verification_uri: response.verification_uri,
        expires_at: expires_at.to_rfc3339(),
        interval_seconds: response.interval.clamp(3, 30),
    };
    validate_pending_for_installation(&pending, &store.installation_id)?;
    // Une nouvelle autorisation serveur rend toute réponse d'un cycle
    // précédent inutilisable, y compris si ce cycle avait déjà produit un
    // échange protégé avant une interruption locale.
    remove_secret(
        &exchange_path(store),
        &store.account_protected_cache.exchange,
    )?;
    write_server_verified_secret(
        &pending_path(store),
        &pending,
        &store.account_protected_cache.pending,
    )?;
    CloudAccountState::from_pending(&pending)
}

async fn poll_link(store: &LocalStore) -> AppResult<CloudAccountState> {
    if let Some(exchange) = read_exchange_secret(store)? {
        return finalize_exchange(store, exchange);
    }
    let pending = read_pending_secret(store)?.ok_or_else(|| {
        AppError::Validation("Relancez la connexion au compte depuis les paramètres.".into())
    })?;
    if parse_future_or_past_date(&pending.expires_at, "autorisation")? <= Utc::now() {
        return Err(AppError::Validation(
            "Le code de connexion a expiré. Demandez un nouveau code.".into(),
        ));
    }
    let body = serde_json::to_vec(&json!({ "deviceCode": pending.device_code }))?;
    let (status, bytes) = account_request(Method::POST, POLL_PATH, Some(body), None).await?;
    if status == StatusCode::ACCEPTED {
        let response: PollResponse = parse_json(&bytes, "attente d’autorisation")?;
        if response.status != "authorization_pending" {
            return Err(AppError::Validation(
                "Le serveur a retourné un état d’autorisation inattendu.".into(),
            ));
        }
        return CloudAccountState::from_pending(&pending);
    }
    if !status.is_success() {
        return Err(server_response_error(status, &bytes));
    }
    let response: PollResponse = parse_json(&bytes, "autorisation du compte")?;
    let session_token = response.session_token.ok_or_else(|| {
        AppError::Validation("Le serveur n’a pas transmis la session de cet appareil.".into())
    })?;
    let session_expires_at = response.session_expires_at.ok_or_else(|| {
        AppError::Validation("Le serveur n’a pas transmis l’expiration de la session.".into())
    })?;
    let organization = response.organization.ok_or_else(|| {
        AppError::Validation("Le serveur n’a pas transmis l’entreprise autorisée.".into())
    })?;
    let license_token = response
        .license
        .map(|license| license.token)
        .ok_or_else(|| AppError::Validation("La licence signée est absente.".into()))?;
    if response.status != "approved" {
        return Err(AppError::Validation(
            "Le serveur n’a pas confirmé l’autorisation du compte.".into(),
        ));
    }
    let session = CloudSession {
        version: SECRET_VERSION,
        installation_id: store.installation_id.clone(),
        session_token,
        session_expires_at,
        organization_id: organization.id,
        organization_name: organization.name,
        role: organization.role,
        connected_at: Utc::now().to_rfc3339(),
    };
    validate_session_for_installation(&session, &store.installation_id)?;
    if license_token.len() < 100 || license_token.len() > 8 * 1024 {
        return Err(AppError::Validation(
            "La licence signée est invalide.".into(),
        ));
    }
    let exchange = PendingExchange {
        version: SECRET_VERSION,
        installation_id: store.installation_id.clone(),
        session,
        license_token,
    };
    validate_exchange_for_installation(&exchange, &store.installation_id)?;
    write_server_verified_secret(
        &exchange_path(store),
        &exchange,
        &store.account_protected_cache.exchange,
    )?;
    // The approval response already authenticated this session and licence.
    // The normal background revalidation will fetch the latest profile.
    finalize_exchange(store, exchange)
}

fn finalize_exchange(
    store: &LocalStore,
    exchange: PendingExchange,
) -> AppResult<CloudAccountState> {
    validate_exchange_for_installation(&exchange, &store.installation_id)?;
    store.install_server_issued_license(&exchange.license_token)?;
    write_server_verified_secret(
        &session_path(store),
        &exchange.session,
        &store.account_protected_cache.session,
    )?;
    remove_secret(
        &exchange_path(store),
        &store.account_protected_cache.exchange,
    )?;
    remove_secret(&pending_path(store), &store.account_protected_cache.pending)?;
    CloudAccountState::from_session(&exchange.session)
}

fn session_for_revocation(store: &LocalStore) -> AppResult<Option<CloudSession>> {
    if let Some(session) = read_session_secret(store)? { return Ok(Some(session)); }
    // The server can have issued a session just before local license adoption
    // failed. That protected exchange still needs server revocation on logout.
    Ok(read_exchange_secret(store)?.map(|exchange| exchange.session))
}

async fn disconnect(store: &LocalStore) -> AppResult<()> {
    let revocation_confirmed_by_server = if let Some(session) = session_for_revocation(store)? {
        let (status, bytes) = account_request(
            Method::DELETE,
            SESSION_PATH,
            None,
            Some(&session.session_token),
        )
        .await?;
        if !status.is_success() && status != StatusCode::UNAUTHORIZED {
            return Err(server_response_error(status, &bytes));
        }
        true
    } else {
        false
    };
    // Une déconnexion explicite révoque aussi le droit d'écriture local. Les
    // données restent lisibles, mais une nouvelle autorisation serveur est
    // requise pour modifier ce profil.
    if revocation_confirmed_by_server {
        mark_account_license_worker(store, AccountLicenseMark::ServerUnrecognized).await?;
    } else {
        mark_account_license_worker(store, AccountLicenseMark::LocalUnrecognized).await?;
    }
    remove_secret(&session_path(store), &store.account_protected_cache.session)?;
    remove_secret(&pending_path(store), &store.account_protected_cache.pending)?;
    remove_secret(
        &exchange_path(store),
        &store.account_protected_cache.exchange,
    )?;
    clear_local_member_identity_worker(store).await?;
    Ok(())
}

async fn archive_invoice(
    store: &LocalStore,
    invoice_id: &str,
    correction_reason: Option<&str>,
    expected_workspace_scope: Option<String>,
) -> AppResult<InvoiceArchiveResult> {
    let session = read_session_secret(store)?.ok_or_else(|| {
        AppError::Validation(
            "Reliez ce poste au compte Zentra avant d’archiver une facture.".into(),
        )
    })?;
    validate_session(&session)?;
    if parse_future_or_past_date(&session.session_expires_at, "session")? <= Utc::now() {
        return Err(AppError::Validation(
            "La session du compte a expiré. Reconnectez ce poste.".into(),
        ));
    }
    if session.role == "read_only" {
        return Err(AppError::Validation(
            "Votre rôle est limité à la consultation des archives.".into(),
        ));
    }
    let (local, content_sha256) = prepare_invoice_archive_on_worker(
        store.clone(), invoice_id.to_owned(), expected_workspace_scope,
    ).await?;
    let mut list_url = endpoint(ARCHIVE_PATH)?;
    list_url
        .query_pairs_mut()
        .append_pair("sourceInvoiceId", &local.source_invoice_id);
    let (status, bytes) = account_request_url(
        Method::GET,
        list_url,
        None,
        Some(&session.session_token),
        TOTAL_TIMEOUT,
    )
    .await?;
    if !status.is_success() {
        return Err(server_response_error(status, &bytes));
    }
    let mut existing: ArchiveListResponse = parse_json(&bytes, "liste des archives")?;
    existing.archives.sort_by_key(|archive| archive.revision);
    if let Some(latest) = existing.archives.last() {
        if latest.content_sha256 == content_sha256 {
            return Ok(InvoiceArchiveResult {
                archive_id: latest.id.clone(),
                revision: latest.revision,
                content_sha256,
                retention_until: latest.retention_until.clone(),
                already_stored: true,
            });
        }
    }
    let revision = existing
        .archives
        .last()
        .map_or(1, |archive| archive.revision + 1);
    let reason = correction_reason
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if revision > 1 && reason.is_none_or(|value| !(5..=1_000).contains(&value.len())) {
        return Err(AppError::Validation(
            "Le PDF diffère de la version archivée. Indiquez un motif de correction de 5 à 1 000 caractères."
                .into(),
        ));
    }
    let body = encode_invoice_archive_on_worker(local, revision, reason.map(str::to_owned)).await?;
    let (status, bytes) = account_request_url(
        Method::POST,
        endpoint(ARCHIVE_PATH)?,
        Some(body),
        Some(&session.session_token),
        Duration::from_secs(60),
    )
    .await?;
    if !status.is_success() {
        return Err(server_response_error(status, &bytes));
    }
    let response: ArchiveStoreResponse = parse_json(&bytes, "archivage de la facture")?;
    if response.archive.content_sha256 != content_sha256 || response.archive.revision != revision {
        return Err(AppError::Validation(
            "La preuve retournée par le coffre ne correspond pas au PDF envoyé.".into(),
        ));
    }
    Ok(InvoiceArchiveResult {
        archive_id: response.archive.id,
        revision: response.archive.revision,
        content_sha256: response.archive.content_sha256,
        retention_until: response.archive.retention_until,
        already_stored: response.already_stored,
    })
}

async fn prepare_invoice_archive_on_worker(
    store: LocalStore,
    invoice_id: String,
    expected_workspace_scope: Option<String>,
) -> AppResult<(LocalInvoiceArchive, String)> {
    // prepare owns the one LocalStore lock. Do not nest the locked command
    // helper here: its std::Mutex is intentionally not reentrant.
    tauri::async_runtime::spawn_blocking(move || {
        let local = prepare_invoice_archive(&store, &invoice_id, expected_workspace_scope.as_deref())?;
        let content_sha256 = format!("{:x}", Sha256::digest(&local.pdf_bytes));
        Ok((local, content_sha256))
    }).await.map_err(|_| AppError::Remote("La préparation de l’archive a été interrompue. Réessayez.".into()))?
}

async fn encode_invoice_archive_on_worker(
    local: LocalInvoiceArchive,
    revision: i64,
    reason: Option<String>,
) -> AppResult<Vec<u8>> {
    // Encoding only uses this immutable, already prepared receipt; it does not
    // reopen the company or acquire either account or LocalStore again.
    tauri::async_runtime::spawn_blocking(move || encode_invoice_archive(local, revision, reason))
        .await.map_err(|_| AppError::Remote("La préparation de l’archive a été interrompue. Réessayez.".into()))?
}

fn encode_invoice_archive(local: LocalInvoiceArchive, revision: i64, reason: Option<String>) -> AppResult<Vec<u8>> {
    let body = serde_json::to_vec(&json!({
        "sourceInvoiceId":local.source_invoice_id,
        "revision":revision,
        "invoiceNumber":local.invoice_number,
        "issueDate":local.issue_date,
        "paidAt":local.paid_at,
        "correctionKind":if revision == 1 { "initial" } else { "correction" },
        "correctionReason":reason,
        "fiscalYearEnd":local.fiscal_year_end,
        "pdfBase64":STANDARD.encode(&local.pdf_bytes)
    }))?;
    if body.len() > 17 * 1024 * 1024 {
        return Err(AppError::Validation(
            "Le PDF encodé dépasse la limite d’archivage de 12 Mo.".into(),
        ));
    }
    Ok(body)
}

fn prepare_invoice_archive(store: &LocalStore, invoice_id: &str, expected_workspace_scope: Option<&str>) -> AppResult<LocalInvoiceArchive> {
    let invoice_id = invoice_id.trim();
    Uuid::parse_str(invoice_id)
        .map_err(|_| AppError::Validation("La référence locale de facture est invalide.".into()))?;
    let _guard = store.lock()?;
    let connection = store.connect()?;
    if let Some(expected) = expected_workspace_scope {
        if crate::work_notes::workspace_scope(&connection)? != expected {
            return Err(AppError::Validation("L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.".into()));
        }
    }
    let invoice = connection
        .query_row(
            "SELECT number,issue_date,status,
                    (SELECT MAX(date) FROM payments WHERE invoice_id=invoices.id)
               FROM invoices WHERE id=? LIMIT 1",
            rusqlite::params![invoice_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound(format!("invoices/{invoice_id}"))
            }
            other => AppError::Database(other),
        })?;
    let invoice_number = invoice
        .0
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Validation("Émettez la facture avant de l’archiver.".into()))?;
    let issue_date = invoice
        .1
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Validation("La date d’émission est absente.".into()))?;
    if !matches!(
        invoice.2.as_str(),
        "emise" | "en_retard" | "partiellement_payee" | "payee"
    ) {
        return Err(AppError::Validation(
            "Seule une facture émise et active peut être archivée.".into(),
        ));
    }
    let fiscal_year_end = connection
        .query_row(
            "SELECT date_to FROM accounting_periods
              WHERE date_from<=? AND date_to>=?
              ORDER BY date_to LIMIT 1",
            rusqlite::params![issue_date, issue_date],
            |row| row.get::<_, String>(0),
        )
        .ok();
    drop(connection);
    let temporary = tempfile::tempdir()?;
    let pdf_path = temporary.path().join("invoice.pdf");
    store.generate_sales_document_pdf(GenerateSalesDocumentPdfInput {
        entity: "invoices".into(),
        document_id: invoice_id.into(),
        destination_path: pdf_path.to_string_lossy().into_owned(),
    })?;
    let pdf_bytes = fs::read(pdf_path)?;
    if pdf_bytes.len() > 12 * 1024 * 1024 {
        return Err(AppError::Validation(
            "Le PDF dépasse la limite d’archivage de 12 Mo.".into(),
        ));
    }
    Ok(LocalInvoiceArchive {
        source_invoice_id: invoice_id.into(),
        invoice_number,
        issue_date,
        paid_at: if invoice.2 == "payee" {
            invoice.3
        } else {
            None
        },
        fiscal_year_end,
        pdf_bytes,
    })
}

fn validate_pending(pending: &PendingAuthorization) -> AppResult<()> {
    if pending.version != SECRET_VERSION {
        return Err(AppError::Validation(
            "La version de la demande de connexion est invalide.".into(),
        ));
    }
    validate_installation_id(&pending.installation_id)?;
    validate_opaque_token(&pending.device_code, "zdv_")?;
    if !is_user_code(&pending.user_code) {
        return Err(AppError::Validation(
            "Le code de connexion est invalide.".into(),
        ));
    }
    validate_verification_uri(&pending.verification_uri, &pending.user_code)?;
    parse_future_or_past_date(&pending.expires_at, "autorisation")?;
    if !(3..=30).contains(&pending.interval_seconds) {
        return Err(AppError::Validation(
            "L’intervalle de vérification est invalide.".into(),
        ));
    }
    Ok(())
}

fn validate_pending_for_installation(
    pending: &PendingAuthorization,
    installation_id: &str,
) -> AppResult<()> {
    validate_pending(pending)?;
    if pending.installation_id != installation_id {
        return Err(AppError::Validation(
            "La demande de connexion protégée ne correspond pas à cette installation.".into(),
        ));
    }
    Ok(())
}

fn validate_session(session: &CloudSession) -> AppResult<()> {
    if session.version != SECRET_VERSION {
        return Err(AppError::Validation(
            "La version de la session de compte est invalide.".into(),
        ));
    }
    validate_installation_id(&session.installation_id)?;
    validate_opaque_token(&session.session_token, "zds_")?;
    parse_future_or_past_date(&session.session_expires_at, "session")?;
    parse_future_or_past_date(&session.connected_at, "connexion")?;
    validate_prefixed_uuid(&session.organization_id, "org_")?;
    if session.organization_name.trim().is_empty() || session.organization_name.len() > 160 {
        return Err(AppError::Validation(
            "Le nom d’entreprise reçu est invalide.".into(),
        ));
    }
    if !matches!(
        session.role.as_str(),
        "owner" | "admin" | "accountant" | "member" | "read_only"
    ) {
        return Err(AppError::Validation(
            "Le rôle du compte est invalide.".into(),
        ));
    }
    Ok(())
}

fn validate_session_for_installation(
    session: &CloudSession,
    installation_id: &str,
) -> AppResult<()> {
    validate_session(session)?;
    if session.installation_id != installation_id {
        return Err(AppError::Validation(
            "La session protégée ne correspond pas à cette installation.".into(),
        ));
    }
    Ok(())
}

fn validate_exchange_for_installation(
    exchange: &PendingExchange,
    installation_id: &str,
) -> AppResult<()> {
    if exchange.version != SECRET_VERSION || exchange.installation_id != installation_id {
        return Err(AppError::Validation(
            "La réponse protégée ne correspond pas à cette installation.".into(),
        ));
    }
    validate_session_for_installation(&exchange.session, installation_id)?;
    if exchange.license_token.len() < 100 || exchange.license_token.len() > 8 * 1024 {
        return Err(AppError::Validation(
            "La licence signée protégée est invalide.".into(),
        ));
    }
    Ok(())
}

fn session_profile_changes(
    session: &CloudSession,
    organization: &PollOrganization,
) -> (bool, bool) {
    let name_changed = session.organization_name != organization.name;
    let role_changed = session.role != organization.role;
    (name_changed || role_changed, role_changed)
}

fn validate_installation_id(value: &str) -> AppResult<()> {
    let uuid = Uuid::parse_str(value)
        .map_err(|_| AppError::Validation("Identité d’installation invalide.".into()))?;
    if uuid.get_version() != Some(Version::Random) {
        return Err(AppError::Validation(
            "L’identité d’installation doit être aléatoire.".into(),
        ));
    }
    Ok(())
}

fn validate_prefixed_uuid(value: &str, prefix: &str) -> AppResult<()> {
    let raw = value
        .strip_prefix(prefix)
        .ok_or_else(|| AppError::Validation("Référence serveur invalide.".into()))?;
    Uuid::parse_str(raw)
        .map(|_| ())
        .map_err(|_| AppError::Validation("Référence serveur invalide.".into()))
}

fn validate_opaque_token(value: &str, prefix: &str) -> AppResult<()> {
    let token = value
        .strip_prefix(prefix)
        .ok_or_else(|| AppError::Validation("Jeton de compte invalide.".into()))?;
    if token.len() != 43
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(AppError::Validation("Jeton de compte invalide.".into()));
    }
    Ok(())
}

fn is_user_code(value: &str) -> bool {
    value.len() == 9
        && value.as_bytes().get(4) == Some(&b'-')
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&byte))
}

fn parse_future_or_past_date(value: &str, label: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Utc))
        .map_err(|_| AppError::Validation(format!("La date de {label} est invalide.")))
}

fn validate_verification_uri(value: &str, user_code: &str) -> AppResult<Url> {
    let mut url = Url::parse(value)
        .map_err(|_| AppError::Validation("Le lien de connexion est invalide.".into()))?;
    let expected = Url::parse(ACCOUNT_API_ORIGIN)
        .map_err(|_| AppError::Validation("L’origine Zentra intégrée est invalide.".into()))?;
    let code_matches = url
        .query_pairs()
        .any(|(key, value)| key == "code" && value == user_code);
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("zentraapp.ch" | "elyko.alb-leart1.chatgpt.site"))
        || url.port_or_known_default() != expected.port_or_known_default()
        || url.path() != "/appareil"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !code_matches
    {
        return Err(AppError::Validation(
            "Le lien de connexion ne respecte pas la politique Zentra.".into(),
        ));
    }
    // Pending authorizations created before the domain migration keep their code.
    // Only the exact former first-party host is accepted, and never opened again.
    url.set_host(expected.host_str())
        .map_err(|_| AppError::Validation("Le lien de connexion est invalide.".into()))?;
    Ok(url)
}

fn endpoint(path: &str) -> AppResult<Url> {
    if !matches!(
        path,
        START_PATH | POLL_PATH | ME_PATH | SESSION_PATH | ARCHIVE_PATH | TEAM_PATH | AUTOMATION_PATH | COMPANY_MAIL_PATH
            | "/api/projects/sync" | "/api/projects/sync/file"
            | "/api/backups" | "/api/backups/item" | "/api/backups/chunk"
            | "/api/sync/numbers" | "/api/account/subscription"
            | crate::company_collaboration::PATH
            | crate::supplier_inbox::PATH
            | crate::appointment_inbox::PATH
    ) {
        return Err(AppError::Validation("Route de compte refusée.".into()));
    }
    let mut url = Url::parse(ACCOUNT_API_ORIGIN)
        .map_err(|_| AppError::Validation("L’origine Zentra intégrée est invalide.".into()))?;
    url.set_path(path);
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return Err(AppError::Validation(
            "L’origine Zentra intégrée est invalide.".into(),
        ));
    }
    Ok(url)
}

async fn account_request(
    method: Method,
    path: &str,
    body: Option<Vec<u8>>,
    bearer: Option<&str>,
) -> AppResult<(StatusCode, Vec<u8>)> {
    account_request_url(method, endpoint(path)?, body, bearer, TOTAL_TIMEOUT).await
}

async fn account_request_url(
    method: Method,
    url: Url,
    body: Option<Vec<u8>>,
    bearer: Option<&str>,
    timeout: Duration,
) -> AppResult<(StatusCode, Vec<u8>)> {
    let client = account_transport()?;
    let mut request = client
        .request(method, url)
        .timeout(timeout)
        .header(ACCEPT, "application/json");
    if let Some(body) = body {
        request = request.header(CONTENT_TYPE, "application/json").body(body);
    }
    if let Some(token) = bearer {
        validate_opaque_token(token, "zds_")?;
        request = request.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = request.send().await.map_err(|_| {
        AppError::Remote("Le service de compte Zentra est momentanément inaccessible.".into())
    })?;
    let content_type_is_json = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(';').next().unwrap_or("").trim() == "application/json");
    let status = response.status();
    let bytes = read_bounded_response(response).await?;
    if !content_type_is_json {
        return Err(AppError::Validation(
            "Le service de compte Zentra a retourné un format inattendu.".into(),
        ));
    }
    Ok((status, bytes))
}

fn account_transport() -> AppResult<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() { return Ok(client.clone()); }
    crate::app_updater::ensure_rustls_crypto_provider().map_err(AppError::Validation)?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        .pool_max_idle_per_host(8)
        .user_agent(format!("Zentra-Account/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| AppError::Validation("Le client HTTPS Zentra est indisponible.".into()))?;
    // Only connections are pooled. Authorization remains per request.
    let _ = CLIENT.set(client.clone());
    Ok(client)
}

async fn read_bounded_response(response: reqwest::Response) -> AppResult<Vec<u8>> {
    read_response_with_limit(response, MAX_RESPONSE_BYTES).await
}

async fn read_response_with_limit(response: reqwest::Response, limit: u64) -> AppResult<Vec<u8>> {
    let declared = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|size| size > limit) {
        return Err(AppError::Validation(
            "La réponse Zentra est trop volumineuse.".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(declared.unwrap_or_default() as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|_| AppError::Validation("La réponse Zentra a été interrompue.".into()))?;
        if bytes.len().saturating_add(chunk.len()) as u64 > limit {
            return Err(AppError::Validation(
                "La réponse Zentra est trop volumineuse.".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if declared.is_some_and(|size| size != bytes.len() as u64) {
        return Err(AppError::Validation(
            "La réponse Zentra est incomplète.".into(),
        ));
    }
    Ok(bytes)
}

fn parse_json<T: DeserializeOwned>(bytes: &[u8], label: &str) -> AppResult<T> {
    serde_json::from_slice(bytes).map_err(|_| {
        AppError::Validation(format!("La réponse du serveur pour {label} est invalide."))
    })
}

fn server_response_error(status: StatusCode, bytes: &[u8]) -> AppError {
    let message = serde_json::from_slice::<ServerError>(bytes)
        .ok()
        .map(|response| response.error.trim().to_owned())
        .filter(|message| !message.is_empty() && message.len() <= 500)
        .unwrap_or_else(|| format!("Le service de compte a répondu {status}."));
    AppError::Remote(message)
}

fn write_server_verified_secret<T: Serialize>(
    path: &Path,
    value: &T,
    cache: &AccountSecretCache,
) -> AppResult<()> {
    let clear = serde_json::to_vec(value)?;
    cache.revision.fetch_add(1, Ordering::Relaxed);
    match write_protected_atomically_with_reference_after_server_verification(path, &clear) {
        Ok(protected_reference) => cache.replace(protected_reference, &clear),
        Err(error) => {
            let current_reference = read_protected_reference(path).ok();
            cache.retain_only_for_reference(current_reference.as_deref())?;
            Err(error)
        }
    }
}

// Fixtures must use the same controlled cache update as an authenticated
// account replacement. A macOS Keychain update retains its opaque marker.
#[cfg(test)]
pub(super) fn write_automation_session_for_test(
    store: &LocalStore,
    value: &serde_json::Value,
) -> AppResult<()> {
    write_server_verified_secret(
        &session_path(store),
        value,
        &store.account_protected_cache.session,
    )
}

fn read_pending_secret(store: &LocalStore) -> AppResult<Option<PendingAuthorization>> {
    let pending: Option<PendingAuthorization> = read_secret(
        &pending_path(store),
        &store.account_protected_cache.pending,
        |pending| validate_pending_for_installation(pending, &store.installation_id),
    )?;
    pending.map(|mut pending| {
        pending.verification_uri = validate_verification_uri(&pending.verification_uri, &pending.user_code)?.to_string();
        Ok(pending)
    }).transpose()
}

fn read_exchange_secret(store: &LocalStore) -> AppResult<Option<PendingExchange>> {
    read_secret(
        &exchange_path(store),
        &store.account_protected_cache.exchange,
        |exchange| validate_exchange_for_installation(exchange, &store.installation_id),
    )
}

fn read_session_secret(store: &LocalStore) -> AppResult<Option<CloudSession>> {
    read_secret(
        &session_path(store),
        &store.account_protected_cache.session,
        |session| validate_session_for_installation(session, &store.installation_id),
    )
}

fn read_secret<T, V>(path: &Path, cache: &ProtectedDataCache, validate: V) -> AppResult<Option<T>>
where
    T: DeserializeOwned,
    V: FnOnce(&T) -> AppResult<()>,
{
    let protected_reference = match read_protected_reference(path) {
        Ok(reference) => reference,
        Err(AppError::Io(error)) if error.kind() == ErrorKind::NotFound => {
            cache.clear()?;
            return Ok(None);
        }
        Err(error) => {
            cache.clear()?;
            return Err(error);
        }
    };
    decode_cached_secret(
        &protected_reference,
        cache,
        || unprotect_protected_reference(&protected_reference),
        validate,
    )
    .map(Some)
}

fn decode_cached_secret<T, L, V>(
    protected_reference: &[u8],
    cache: &ProtectedDataCache,
    load: L,
    validate: V,
) -> AppResult<T>
where
    T: DeserializeOwned,
    L: FnOnce() -> AppResult<Vec<u8>>,
    V: FnOnce(&T) -> AppResult<()>,
{
    let clear = cache.get_or_try_init(protected_reference, load)?;
    let value = match serde_json::from_slice(&clear) {
        Ok(value) => value,
        Err(error) => {
            cache.clear()?;
            return Err(error.into());
        }
    };
    if let Err(error) = validate(&value) {
        cache.clear()?;
        return Err(error);
    }
    Ok(value)
}

// Reset/recovery callers hold account operation mutex then LocalStore.lock.
// Invalidate the local context before secret removal or replacement can fail.
pub(crate) fn forget_local_account(store: &LocalStore) -> AppResult<()> {
    clear_local_member_identity_already_locked(store)?;
    remove_secret(&session_path(store), &store.account_protected_cache.session)?;
    remove_secret(&pending_path(store), &store.account_protected_cache.pending)?;
    remove_secret(&exchange_path(store), &store.account_protected_cache.exchange)
}

fn remove_secret(path: &Path, cache: &AccountSecretCache) -> AppResult<()> {
    cache.revision.fetch_add(1, Ordering::Relaxed);
    remove_protected(path)?;
    cache.clear()
}

fn pending_path(store: &LocalStore) -> std::path::PathBuf {
    store.data_dir.join(ACCOUNT_PENDING_FILE)
}

fn exchange_path(store: &LocalStore) -> std::path::PathBuf {
    store.data_dir.join(ACCOUNT_EXCHANGE_FILE)
}

fn session_path(store: &LocalStore) -> std::path::PathBuf {
    store.data_dir.join(ACCOUNT_SESSION_FILE)
}

fn open_verification_uri(uri: &str) -> AppResult<()> {
    validate_verification_uri(
        uri,
        Url::parse(uri)
            .ok()
            .and_then(|url| {
                url.query_pairs()
                    .find(|(key, _)| key == "code")
                    .map(|(_, value)| value.into_owned())
            })
            .as_deref()
            .unwrap_or(""),
    )?;
    launch_external_url(uri)
}

fn launch_external_url(uri: &str) -> AppResult<()> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return tauri_plugin_zentra_mobile::open_url(uri).map_err(AppError::Validation);
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(uri)
            .spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(uri).spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(uri).spawn()?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(AppError::UnsupportedPlatform)
}

#[cfg(test)]
pub(crate) async fn connect_live_qa_profile(store: &LocalStore, label: &str) -> AppResult<()> {
    if option_env!("HELVICHANTIER_LICENSE_PUBLIC_KEY_B64URL").is_none() {
        return Err(AppError::Validation("Compilez cette recette avec la clé publique de licence du fichier license-public-key.b64url avant toute autorisation serveur.".into()));
    }
    let pending = start_link(store).await?;
    // Only the public, short-lived approval link is printed. Session and license
    // tokens stay in the ordinary protected files of the isolated test profile.
    println!("QA_APPROVAL {label} {}", pending.verification_uri.as_deref().unwrap_or(""));
    for _ in 0..100 {
        let interval = pending.interval_seconds.unwrap_or(5);
        tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_secs(interval)))
            .await.map_err(|_| AppError::Validation("Attente de recette interrompue.".into()))?;
        let state = poll_link(store).await?;
        if state.status == "connected" { return Ok(()); }
    }
    Err(AppError::Validation("L’autorisation du profil de recette n’a pas été donnée à temps.".into()))
}

#[cfg(test)]
pub(crate) async fn disconnect_live_qa_profile(store: &LocalStore) -> AppResult<()> {
    disconnect(store).await
}

#[cfg(test)]
#[path = "account_inbox_read_tests.rs"]
mod inbox_read_tests;

#[cfg(test)]
#[path = "account_archive_worker_tests.rs"]
mod archive_worker_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switching_members_in_the_same_company_cannot_reuse_the_old_local_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let organization = "org_369d3fcf-b05b-4d78-9f2a-3c4141aed7fd";
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        crate::company_collaboration::set_identity(&store, organization, &first, "First Member", "owner").unwrap();
        let previous: String = store.connect().unwrap().query_row("SELECT user_id FROM company_local_identity WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(previous, first);
        clear_local_member_identity(&store).unwrap();
        let remaining: i64 = store.connect().unwrap().query_row("SELECT COUNT(*) FROM company_local_identity", [], |row| row.get(0)).unwrap();
        assert_eq!(remaining, 0);
        // Only a newly verified account/member installs the next identity.
        crate::company_collaboration::set_identity(&store, organization, &second, "Second Member", "owner").unwrap();
        let current: String = store.connect().unwrap().query_row("SELECT user_id FROM company_local_identity WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(current, second);
        assert_ne!(current, first);
    }

    #[test]
    fn clearing_member_identity_preserves_company_data_and_workspace_scope() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let connection = store.connect().unwrap();
        let inserted = connection.execute(
            "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at)
             VALUES(1,0,'Preserved Company','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')",
            [],
        ).unwrap();
        assert_eq!(inserted, 1);
        let scope = crate::work_notes::workspace_scope(&connection).unwrap();
        crate::company_collaboration::set_identity(&store, "org-a", &Uuid::new_v4().to_string(), "Member", "owner").unwrap();
        clear_local_member_identity(&store).unwrap();
        let connection = store.connect().unwrap();
        assert_eq!(crate::work_notes::workspace_scope(&connection).unwrap(), scope);
        assert_eq!(connection.query_row("SELECT company_name FROM settings WHERE id=1", [], |row| row.get::<_, String>(0)).unwrap(), "Preserved Company");
        clear_local_member_identity(&store).unwrap();
    }

    #[test]
    fn clearing_member_identity_supports_a_profile_without_the_private_table() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        store.connect().unwrap().execute("DROP TABLE company_local_identity", []).unwrap();
        clear_local_member_identity(&store).unwrap();
    }

    #[test]
    fn account_settings_links_preserve_the_company_and_reject_arbitrary_destinations() {
        let uri=account_portal_uri(Some("abonnement"),Some("org_a&other=b")).unwrap();
        let url=Url::parse(&uri).unwrap();
        assert_eq!(url.host_str(),Some("zentraapp.ch"));
        assert_eq!(url.path(),"/compte/abonnement");
        assert_eq!(url.query_pairs().collect::<Vec<_>>(),vec![("organizationId".into(),"org_a&other=b".into())]);
        assert!(account_portal_uri(Some("https://other.example"),None).is_err());
        assert!(account_portal_uri(Some("../admin"),None).is_err());
        assert_eq!(account_portal_uri(None,None).unwrap(),"https://zentraapp.ch/compte");
    }

    fn supplier_message_session(store: &LocalStore) -> CloudSession {
        let mut session=session_for(&store.installation_id);
        session.session_expires_at=(Utc::now()+chrono::Duration::days(1)).to_rfc3339();
        fs::write(store.data_dir.join("company-collaboration.json"),serde_json::to_vec(&json!({"organization_id":session.organization_id})).unwrap()).unwrap();
        session
    }

    #[test]
    fn supplier_message_navigation_is_canonical_company_scoped_and_credential_free() {
        let temporary=tempfile::tempdir().unwrap();
        let store=LocalStore::initialize(temporary.path().into()).unwrap();
        let session=supplier_message_session(&store);
        let ticket="7418f947-06af-4dfb-84d0-0f2eae5fb946";
        let uri=supplier_inbox_uri(&store,&session,Some("inbox"),Some(ticket)).unwrap();
        assert_eq!(uri,format!("{ACCOUNT_API_ORIGIN}/support/espace?organizationId={}&section=inbox&ticket={ticket}",session.organization_id));
        assert!(!uri.contains(&session.session_token));
        let url=Url::parse(&uri).unwrap();
        assert_eq!(url.scheme(),"https");
        assert_eq!(url.host_str(),Some("zentraapp.ch"));
        assert_eq!(url.path(),"/support/espace");
        assert_eq!(url.query_pairs().count(),3);
        // A ticket can only target the inbox, never arbitrary sections/URLs.
        assert_eq!(supplier_inbox_uri(&store,&session,Some("https://other.example"),Some(ticket)).unwrap(),uri);
        assert_eq!(supplier_inbox_uri(&store,&session,None,None).unwrap(),format!("{ACCOUNT_API_ORIGIN}/support/espace?organizationId={}&section=connections",session.organization_id));
        assert_eq!(supplier_inbox_uri(&store,&session,Some("inbox"),None).unwrap(),format!("{ACCOUNT_API_ORIGIN}/support/espace?organizationId={}&section=inbox",session.organization_id));
    }

    #[test]
    fn supplier_message_navigation_rejects_invalid_ids_without_an_external_launch() {
        let temporary=tempfile::tempdir().unwrap();
        let store=LocalStore::initialize(temporary.path().into()).unwrap();
        let session=supplier_message_session(&store);
        for invalid in ["", "ticket-other", "7418f94706af4dfb84d00f2eae5fb946", "urn:uuid:7418f947-06af-4dfb-84d0-0f2eae5fb946", "7418f947-06af-4dfb-84d0-0f2eae5fb946&organizationId=other", " 7418f947-06af-4dfb-84d0-0f2eae5fb946", "00000000-0000-0000-0000-000000000000"] {
            assert!(supplier_inbox_uri(&store,&session,Some("inbox"),Some(invalid)).is_err(),"{invalid}");
        }
    }

    #[test]
    fn supplier_message_navigation_refuses_wrong_installation_expired_or_unlinked_company() {
        let temporary=tempfile::tempdir().unwrap();
        let store=LocalStore::initialize(temporary.path().into()).unwrap();
        let mut session=supplier_message_session(&store);
        let ticket="7418f947-06af-4dfb-84d0-0f2eae5fb946";
        session.installation_id=Uuid::new_v4().to_string();
        assert!(supplier_inbox_uri(&store,&session,Some("inbox"),Some(ticket)).is_err());
        session.installation_id=store.installation_id.clone();
        session.session_expires_at=(Utc::now()-chrono::Duration::seconds(1)).to_rfc3339();
        assert!(supplier_inbox_uri(&store,&session,Some("inbox"),Some(ticket)).is_err());
        session.session_expires_at=(Utc::now()+chrono::Duration::days(1)).to_rfc3339();
        fs::write(store.data_dir.join("company-collaboration.json"),serde_json::to_vec(&json!({"organization_id":"org_0991a2ee-056b-41c3-b9ad-45335923ab40"})).unwrap()).unwrap();
        assert!(supplier_inbox_uri(&store,&session,Some("inbox"),Some(ticket)).is_err());
        fs::remove_file(store.data_dir.join("company-collaboration.json")).unwrap();
        assert!(supplier_inbox_uri(&store,&session,Some("inbox"),Some(ticket)).is_err());
    }

    #[test]
    fn joining_initializes_only_an_empty_workspace_and_ignores_local_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        assert!(initialize_joined_company(&store, &json!({"profile":null})).is_err());
        let profile = json!({"profile":{"company_name":"Entreprise partagée","noga_section":"F","noga_division":"43","activity_description":"Travaux de peinture","logo_path":"/private/other-device/logo.png","extra_settings_json":{"unsafe":true}}});
        initialize_joined_company(&store,&profile).unwrap();
        assert!(store.app_state(env!("CARGO_PKG_VERSION")).unwrap().onboarding_completed);
        assert!(initialize_joined_company(&store,&json!({"profile":{"company_name":"Remplacement","noga_section":"F","noga_division":"43","activity_description":"Autre"}})).unwrap_err().contains("déjà"));
        let state=store.get_workspace().unwrap();
        assert_eq!(state["settings"]["company_name"],"Entreprise partagée");
        assert!(state["settings"]["logo_path"].is_null());
    }

    #[test]
    fn unfinished_license_adoption_still_exposes_its_session_for_revocation() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let session = session_for(&store.installation_id);
        let exchange = PendingExchange { version:SECRET_VERSION,installation_id:store.installation_id.clone(),
            session:session.clone(),license_token:"a".repeat(200) };
        write_server_verified_secret(&exchange_path(&store),&exchange,&store.account_protected_cache.exchange).unwrap();
        assert!(read_session_secret(&store).unwrap().is_none());
        assert_eq!(session_for_revocation(&store).unwrap().unwrap().session_token,session.session_token);
        remove_secret(&exchange_path(&store),&store.account_protected_cache.exchange).unwrap();
        assert!(session_for_revocation(&store).unwrap().is_none());
    }

    #[test]
    fn project_and_backup_transfer_routes_use_the_fixed_authenticated_origin() {
        for path in ["/api/account/subscription", "/api/projects/sync", "/api/projects/sync/file", "/api/backups", "/api/backups/item", "/api/backups/chunk", "/api/sync/numbers"] {
            let url = endpoint(path).unwrap();
            assert_eq!(url.as_str(), format!("{ACCOUNT_API_ORIGIN}{path}"));
        }
        for path in ["/api/account/subscription?organizationId=other", "/api/account/subscription/../stripe", "https://example.com/api/projects/sync", "//example.com", "/api/projects/sync/../stripe", "/api/projects/sync?token=x"] {
            assert!(endpoint(path).is_err());
        }
    }

    const TEST_INSTALLATION_ID: &str = "55af29dd-fdaa-4993-ae78-17f9ca220e51";

    #[test]
    fn company_sharing_uses_the_trusted_route_without_allowing_arbitrary_account_routes() {
        let url = endpoint(crate::company_collaboration::PATH).unwrap();
        assert_eq!(url.as_str(), format!("{ACCOUNT_API_ORIGIN}/api/account/collaboration"));
        for refused in ["/api/account/collaboration/", "/api/account/collaboration?token=secret", "/api/account/collaboration/../team", "/api/account/anything", "https://example.test/api/account/collaboration"] {
            assert!(endpoint(refused).is_err());
        }
    }

    #[test]
    fn remote_account_failures_are_not_reported_as_invalid_form_fields() {
        for status in [StatusCode::BAD_REQUEST, StatusCode::SERVICE_UNAVAILABLE] {
            let error = server_response_error(status, br#"{"error":"Service indisponible. Reessayez."}"#);
            assert!(matches!(error, AppError::Remote(_)));
            assert_eq!(command_error(error), "Service indisponible. Reessayez.");
        }
    }

    fn pending_for(installation_id: &str) -> PendingAuthorization {
        PendingAuthorization {
            version: SECRET_VERSION,
            installation_id: installation_id.into(),
            device_code: format!("zdv_{}", "A".repeat(43)),
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://elyko.alb-leart1.chatgpt.site/appareil?code=ABCD-EFGH"
                .into(),
            expires_at: "2026-09-05T12:00:00Z".into(),
            interval_seconds: 3,
        }
    }

    fn session_for(installation_id: &str) -> CloudSession {
        CloudSession {
            version: SECRET_VERSION,
            installation_id: installation_id.into(),
            session_token: format!("zds_{}", "B".repeat(43)),
            session_expires_at: "2026-10-05T12:00:00Z".into(),
            organization_id: "org_369d3fcf-b05b-4d78-9f2a-3c4141aed7fd".into(),
            organization_name: "Atelier Zentra".into(),
            role: "owner".into(),
            connected_at: "2026-09-04T12:00:00Z".into(),
        }
    }

    #[test]
    fn former_verification_links_are_normalized_without_changing_the_code() {
        for host in ["zentraapp.ch", "elyko.alb-leart1.chatgpt.site"] {
            let url = validate_verification_uri(&format!("https://{host}/appareil?code=ABCD-EFGH"), "ABCD-EFGH").unwrap();
            assert_eq!(url.as_str(), "https://zentraapp.ch/appareil?code=ABCD-EFGH");
        }
        for value in [
            "https://zentraapp.ch.evil.example/appareil?code=ABCD-EFGH",
            "https://zentraapp.ch:444/appareil?code=ABCD-EFGH",
            "https://user@zentraapp.ch/appareil?code=ABCD-EFGH",
            "http://zentraapp.ch/appareil?code=ABCD-EFGH",
            "https://zentraapp.ch/appareil?code=WRONG",
        ] { assert!(validate_verification_uri(value, "ABCD-EFGH").is_err()); }
    }

    #[test]
    fn validates_server_credentials_and_fixed_verification_origin() {
        validate_opaque_token("zds_0123456789abcdefghijklmnopqrstuvwxyz_ABCD-E", "zds_").unwrap();
        assert!(validate_opaque_token("zds_short", "zds_").is_err());
        assert!(is_user_code("ABCD-EFGH"));
        assert!(!is_user_code("ABCI-EFGH"));
        validate_verification_uri(
            "https://elyko.alb-leart1.chatgpt.site/appareil?code=ABCD-EFGH",
            "ABCD-EFGH",
        )
        .unwrap();
        assert!(validate_verification_uri(
            "https://example.com/appareil?code=ABCD-EFGH",
            "ABCD-EFGH"
        )
        .is_err());
    }

    #[test]
    fn two_minutes_of_pending_polls_unlock_the_same_generation_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cache = ProtectedDataCache::enabled_for_test();
        let pending = pending_for(TEST_INSTALLATION_ID);
        let clear = serde_json::to_vec(&pending).unwrap();
        let unlocks = AtomicUsize::new(0);

        // Le frontend accepte un intervalle minimal de trois secondes :
        // quarante lectures couvrent exactement les deux minutes du bug
        // macOS signalé et ne doivent déverrouiller le Trousseau qu'une fois.
        for _ in 0..40 {
            let decoded: PendingAuthorization = decode_cached_secret(
                b"pending-generation",
                &cache,
                || {
                    unlocks.fetch_add(1, Ordering::SeqCst);
                    Ok(clear.clone())
                },
                |value| validate_pending_for_installation(value, TEST_INSTALLATION_ID),
            )
            .unwrap();
            assert_eq!(decoded.user_code, "ABCD-EFGH");
        }

        assert_eq!(unlocks.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn active_session_checks_unlock_the_same_generation_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cache = ProtectedDataCache::enabled_for_test();
        let session = session_for(TEST_INSTALLATION_ID);
        let clear = serde_json::to_vec(&session).unwrap();
        let unlocks = AtomicUsize::new(0);

        // Quarante contrôles représentent deux minutes au rythme minimal du
        // poll cloud. Une session déjà active doit rester servie par le cache.
        for _ in 0..40 {
            let decoded: CloudSession = decode_cached_secret(
                b"session-generation",
                &cache,
                || {
                    unlocks.fetch_add(1, Ordering::SeqCst);
                    Ok(clear.clone())
                },
                |value| validate_session_for_installation(value, TEST_INSTALLATION_ID),
            )
            .unwrap();
            assert_eq!(decoded.session_token, session.session_token);
        }

        assert_eq!(unlocks.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn invalid_rotated_pending_generation_cannot_restore_the_old_cache() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cache = ProtectedDataCache::enabled_for_test();
        let valid_clear = serde_json::to_vec(&pending_for(TEST_INSTALLATION_ID)).unwrap();
        let invalid_clear =
            serde_json::to_vec(&pending_for("5bf79bcc-921e-4822-86fc-c773ea2cf7bb")).unwrap();
        let unlocks = AtomicUsize::new(0);

        let _: PendingAuthorization = decode_cached_secret(
            b"generation-a",
            &cache,
            || {
                unlocks.fetch_add(1, Ordering::SeqCst);
                Ok(valid_clear.clone())
            },
            |value| validate_pending_for_installation(value, TEST_INSTALLATION_ID),
        )
        .unwrap();
        assert!(decode_cached_secret::<PendingAuthorization, _, _>(
            b"generation-b",
            &cache,
            || {
                unlocks.fetch_add(1, Ordering::SeqCst);
                Ok(invalid_clear)
            },
            |value| validate_pending_for_installation(value, TEST_INSTALLATION_ID),
        )
        .is_err());

        let _: PendingAuthorization = decode_cached_secret(
            b"generation-a",
            &cache,
            || {
                unlocks.fetch_add(1, Ordering::SeqCst);
                Ok(valid_clear)
            },
            |value| validate_pending_for_installation(value, TEST_INSTALLATION_ID),
        )
        .unwrap();
        assert_eq!(unlocks.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn removed_secret_cannot_be_resurrected_from_memory() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("pending.protected");
        let marker = b"synthetic-marker";
        let clear = serde_json::to_vec(&pending_for(TEST_INSTALLATION_ID)).unwrap();
        let cache = AccountSecretCache {
            data: ProtectedDataCache::enabled_for_test(),
            ..Default::default()
        };
        fs::write(&path, marker).unwrap();
        cache.replace(marker.to_vec(), &clear).unwrap();

        remove_secret(&path, &cache).unwrap();
        fs::write(&path, marker).unwrap();
        let reloads = AtomicUsize::new(0);
        let _: PendingAuthorization = decode_cached_secret(
            marker,
            &cache,
            || {
                reloads.fetch_add(1, Ordering::SeqCst);
                Ok(clear)
            },
            |value| validate_pending_for_installation(value, TEST_INSTALLATION_ID),
        )
        .unwrap();
        assert_eq!(reloads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn account_operations_share_one_async_mutex() {
        let cache = AccountProtectedCache::default();
        let shared = cache.clone();
        let guard = cache.operation_lock.try_lock().unwrap();
        assert!(shared.operation_lock.try_lock().is_none());
        drop(guard);
        assert!(shared.operation_lock.try_lock().is_some());
    }

    #[test]
    fn account_network_check_leaves_local_session_and_automation_lock_available() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let mut session = session_for(&store.installation_id);
        session.session_expires_at = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
        let state = tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async {
            let _other_operation = store.account_protected_cache.operation_lock.try_lock()
                .expect("A slow account request must not block Automation or company opening");
            assert_eq!(cached_cloud_account_state(&store).unwrap().status, "connected");
            Err(AppError::Remote("simulated network outage".into()))
        })).unwrap();
        assert_eq!(state.status, "connected");
    }

    #[test]
    fn late_account_rejection_cannot_disconnect_a_new_session() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let mut session = session_for(&store.installation_id);
        session.session_expires_at = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
        let state = tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async {
            let _guard = store.account_protected_cache.operation_lock.try_lock().unwrap();
            let mut newer = session.clone();
            newer.session_token = format!("zds_{}", "C".repeat(43));
            newer.organization_id = "org_3fc0b9a4-c393-4aaa-95ec-6673cd896482".into();
            write_server_verified_secret(&session_path(&store), &newer, &store.account_protected_cache.session).unwrap();
            Ok((StatusCode::UNAUTHORIZED, br#"{"error":"expired"}"#.to_vec()))
        })).unwrap();
        assert_eq!(state.organization_id.as_deref(), Some("org_3fc0b9a4-c393-4aaa-95ec-6673cd896482"));
        assert_eq!(state.status, "connected");
    }

    #[test]
    fn local_opening_does_not_reconnect_an_expired_or_removed_session() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let mut session = session_for(&store.installation_id);
        session.session_expires_at = (Utc::now() - chrono::Duration::seconds(1)).to_rfc3339();
        write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
        assert_eq!(cached_cloud_account_state(&store).unwrap().status, "expired");
        remove_secret(&session_path(&store), &store.account_protected_cache.session).unwrap();
        assert_eq!(cached_cloud_account_state(&store).unwrap().status, "disconnected");
    }

    #[test]
    fn background_verification_still_applies_current_account_revocation() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let mut session = session_for(&store.installation_id);
        session.session_expires_at = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
        let state = tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async {
            Ok((StatusCode::UNAUTHORIZED, br#"{"error":"revoked"}"#.to_vec()))
        })).unwrap();
        assert_eq!(state.status, "disconnected");
        assert!(read_session_secret(&store).unwrap().is_none());
    }

    #[test]
    fn successful_late_verification_cannot_restore_a_logged_out_session() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let mut session = session_for(&store.installation_id);
        session.session_expires_at = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
        let state = tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async {
            let _guard = store.account_protected_cache.operation_lock.try_lock().unwrap();
            remove_secret(&session_path(&store), &store.account_protected_cache.session).unwrap();
            Ok((StatusCode::OK, b"{}".to_vec()))
        })).unwrap();
        assert_eq!(state.status, "disconnected");
        assert!(read_session_secret(&store).unwrap().is_none());
    }

    #[test]
    fn actual_me_revocation_clears_identity_and_nonce_before_reporting_disconnected() {
        for status in [StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN] {
            let temporary = tempfile::tempdir().unwrap();
            let store = LocalStore::initialize(temporary.path().into()).unwrap();
            let mut session = session_for(&store.installation_id);
            session.session_expires_at = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
            write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
            crate::company_collaboration::set_identity(&store, &session.organization_id, &Uuid::new_v4().to_string(), "Alice", "owner").unwrap();
            let original = crate::member_context::read(&store.connect().unwrap()).unwrap();
            let scope = crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();
            // Exercise the real /me response handler with a synthetic response;
            // no remote call and no bypass of its current-session comparison.
            let state = tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async move {
                Ok((status, br#"{"error":"revoked"}"#.to_vec()))
            })).unwrap();
            assert_eq!(state.status, "disconnected");
            assert!(read_session_secret(&store).unwrap().is_none());
            assert_eq!(store.connect().unwrap().query_row::<i64, _, _>("SELECT COUNT(*) FROM company_local_identity", [], |row| row.get(0)).unwrap(), 0);
            assert!(crate::member_context::require_unchanged(&store.connect().unwrap(), Some(&original)).is_err());
            assert_eq!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(), scope);
        }
    }

    #[test]
    fn actual_me_installation_or_organization_mismatch_invalidates_previous_read_context() {
        for wrong_installation in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let store = LocalStore::initialize(temporary.path().into()).unwrap();
            let mut session = session_for(&store.installation_id);
            session.session_expires_at = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
            write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
            let member = Uuid::new_v4().to_string();
            crate::company_collaboration::set_identity(&store, &session.organization_id, &member, "Alice", "owner").unwrap();
            let original = crate::member_context::read(&store.connect().unwrap()).unwrap();
            let scope = crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();
            let response = serde_json::to_vec(&json!({
                "userId":member,"email":"synthetic@example.invalid","displayName":"Alice",
                "installationId":if wrong_installation { Uuid::new_v4().to_string() } else { store.installation_id.clone() },
                "organization":{"id":if wrong_installation { session.organization_id.clone() } else { format!("org_{}", Uuid::new_v4()) },"name":"Synthetic company","role":"owner"},
                "entitlementValidUntil":(Utc::now() + chrono::Duration::days(30)).to_rfc3339(),
            })).unwrap();
            let state = tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async move {
                Ok((StatusCode::OK, response))
            })).unwrap();
            assert_eq!(state.status, "disconnected");
            assert!(read_session_secret(&store).unwrap().is_none());
            assert_eq!(store.connect().unwrap().query_row::<i64, _, _>("SELECT COUNT(*) FROM company_local_identity", [], |row| row.get(0)).unwrap(), 0);
            assert!(crate::member_context::require_unchanged(&store.connect().unwrap(), Some(&original)).is_err());
            assert_eq!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(), scope);
        }
    }

    #[test]
    fn actual_late_me_revocation_preserves_the_newer_members_context() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let mut session = session_for(&store.installation_id);
        session.session_expires_at = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
        crate::company_collaboration::set_identity(&store, &session.organization_id, &Uuid::new_v4().to_string(), "Alice", "owner").unwrap();
        let bob = Uuid::new_v4().to_string();
        let state = tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async {
            let _account = store.account_protected_cache.operation_lock.try_lock().unwrap();
            let mut newer = session.clone();
            newer.session_token = format!("zds_{}", "C".repeat(43));
            write_server_verified_secret(&session_path(&store), &newer, &store.account_protected_cache.session).unwrap();
            crate::company_collaboration::set_identity(&store, &session.organization_id, &bob, "Bob", "owner").unwrap();
            Ok((StatusCode::UNAUTHORIZED, br#"{"error":"late alice rejection"}"#.to_vec()))
        })).unwrap();
        assert_eq!(state.status, "connected");
        assert_eq!(store.connect().unwrap().query_row::<String, _, _>("SELECT user_id FROM company_local_identity", [], |row| row.get(0)).unwrap(), bob);
        let installed = crate::member_context::read(&store.connect().unwrap()).unwrap();
        assert!(read_session_secret(&store).unwrap().is_some());
        // A second identical cached verification must not rotate this context.
        let next = tauri::async_runtime::block_on(cloud_account_state_with(&store, |_| async {
            Err(AppError::Remote("synthetic network outage".into()))
        })).unwrap();
        assert_eq!(next.status, "connected");
        assert_eq!(crate::member_context::read(&store.connect().unwrap()).unwrap(), installed);
    }

    #[test]
    fn actual_me_revocation_waits_off_executor_for_local_lock_before_clearing_context() {
        use futures_util::future::join;
        use std::{sync::mpsc, thread, time::Duration};
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let mut session = session_for(&store.installation_id);
        session.session_expires_at = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        write_server_verified_secret(&session_path(&store), &session, &store.account_protected_cache.session).unwrap();
        crate::company_collaboration::set_identity(&store, &session.organization_id, &Uuid::new_v4().to_string(), "Alice", "owner").unwrap();
        let original = crate::member_context::read(&store.connect().unwrap()).unwrap();
        let locked = store.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let holder = thread::spawn(move || {
            let _guard = locked.lock().unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (result, ()) = tauri::async_runtime::block_on(join(
            cloud_account_state_with(&store, |_| async { Ok((StatusCode::UNAUTHORIZED, br#"{"error":"revoked"}"#.to_vec())) }),
            async move { let _ = release_tx.send(()); },
        ));
        assert!(holder.join().unwrap(), "revocation must not block the releasing executor");
        assert_eq!(result.unwrap().status, "disconnected");
        assert!(crate::member_context::require_unchanged(&store.connect().unwrap(), Some(&original)).is_err());
    }

    #[test]
    fn unchanged_server_profile_does_not_require_a_session_write() {
        let session = session_for(TEST_INSTALLATION_ID);
        let unchanged = PollOrganization {
            id: session.organization_id.clone(),
            name: session.organization_name.clone(),
            role: session.role.clone(),
        };
        assert_eq!(
            session_profile_changes(&session, &unchanged),
            (false, false)
        );

        let role_changed = PollOrganization {
            role: "accountant".into(),
            ..unchanged
        };
        assert_eq!(
            session_profile_changes(&session, &role_changed),
            (true, true)
        );
    }
}

#[cfg(test)]
mod member_context_clear_tests {
    use super::*;
    use futures_util::future::join;
    use std::{sync::mpsc, thread, time::Duration};

    fn fixture() -> (tempfile::TempDir, LocalStore) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        (temporary, store)
    }
    fn nonce(store: &LocalStore) -> String { crate::member_context::read(&store.connect().unwrap()).unwrap() }

    #[test]
    fn actual_clear_invalidates_member_context_without_rotating_draft_workspace() {
        let (_temporary, store) = fixture();
        let scope = crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap();
        crate::company_collaboration::set_identity(&store, "org-a", &Uuid::new_v4().to_string(), "Alice", "owner").unwrap();
        let original = nonce(&store);
        clear_local_member_identity(&store).unwrap();
        assert_ne!(nonce(&store), original);
        assert_eq!(crate::work_notes::workspace_scope(&store.connect().unwrap()).unwrap(), scope);
        assert_eq!(store.connect().unwrap().query_row::<i64,_,_>("SELECT COUNT(*) FROM company_local_identity", [], |row|row.get(0)).unwrap(), 0);
    }

    #[test]
    fn actual_clear_rotates_each_new_authorization_even_when_identity_already_empty() {
        let (_temporary, store) = fixture();
        let first = nonce(&store);
        clear_local_member_identity(&store).unwrap();
        let second = nonce(&store);
        clear_local_member_identity(&store).unwrap();
        assert_ne!(second, first);
        assert_ne!(nonce(&store), second);
    }

    #[test]
    fn actual_clear_worker_leaves_executor_responsive_while_local_write_lock_is_held() {
        let (_temporary, store) = fixture();
        let locked = store.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let holder = thread::spawn(move || {
            let _guard = locked.lock().unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).is_ok()
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (result, ()) = tauri::async_runtime::block_on(join(
            clear_local_member_identity_worker(&store), async move { let _ = release_tx.send(()); },
        ));
        assert!(holder.join().unwrap(), "member clearing blocked the releasing executor");
        result.unwrap();
    }
}

#[cfg(test)]
#[path = "account_cloud_nonblocking_state_tests.rs"]
mod nonblocking_state_tests;
