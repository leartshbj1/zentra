use std::{fs, io::ErrorKind, path::Path, time::Duration};

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
    error::{command_error, AppError, AppResult},
    installation::{read_protected, remove_protected, write_protected_atomically},
    models::GenerateSalesDocumentPdfInput,
};

const ACCOUNT_API_ORIGIN: &str = "https://elyko.alb-leart1.chatgpt.site";
const START_PATH: &str = "/api/account/device/start";
const POLL_PATH: &str = "/api/account/device/poll";
const ME_PATH: &str = "/api/account/me";
const SESSION_PATH: &str = "/api/account/session";
const ARCHIVE_PATH: &str = "/api/archive/invoices";
const ACCOUNT_SESSION_FILE: &str = "cloud-account-session.protected";
const ACCOUNT_PENDING_FILE: &str = "cloud-account-link.protected";
const ACCOUNT_EXCHANGE_FILE: &str = "cloud-account-exchange.protected";
const SECRET_VERSION: u8 = 1;
const MAX_RESPONSE_BYTES: u64 = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(30);

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

#[derive(Clone, Debug, Deserialize, Serialize)]
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
    cloud_account_state(&store).await.map_err(command_error)
}

#[tauri::command]
pub async fn start_cloud_account_link(
    state: State<'_, LocalStore>,
) -> Result<CloudAccountState, String> {
    let store = state.inner().clone();
    start_link(&store).await.map_err(command_error)
}

#[tauri::command]
pub async fn poll_cloud_account_link(
    state: State<'_, LocalStore>,
) -> Result<CloudAccountState, String> {
    let store = state.inner().clone();
    poll_link(&store).await.map_err(command_error)
}

#[tauri::command]
pub fn open_cloud_account_link(state: State<'_, LocalStore>) -> Result<String, String> {
    let pending = read_secret::<PendingAuthorization>(&pending_path(state.inner()))
        .map_err(command_error)?
        .ok_or_else(|| "Aucune connexion de compte n’est en attente.".to_owned())?;
    validate_pending(&pending).map_err(command_error)?;
    open_verification_uri(&pending.verification_uri).map_err(command_error)?;
    Ok(pending.verification_uri)
}

#[tauri::command]
pub fn open_cloud_account_portal() -> Result<String, String> {
    let uri = format!("{ACCOUNT_API_ORIGIN}/compte");
    let url =
        Url::parse(&uri).map_err(|_| "L’adresse du compte Zentra est invalide.".to_owned())?;
    if url.scheme() != "https"
        || url.host_str() != Some("elyko.alb-leart1.chatgpt.site")
        || url.path() != "/compte"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("L’adresse du compte Zentra est refusée.".to_owned());
    }
    launch_external_url(&uri).map_err(command_error)?;
    Ok(uri)
}

#[tauri::command]
pub async fn disconnect_cloud_account(state: State<'_, LocalStore>) -> Result<(), String> {
    let store = state.inner().clone();
    disconnect(&store).await.map_err(command_error)
}

#[tauri::command]
pub async fn archive_invoice_to_cloud(
    state: State<'_, LocalStore>,
    invoice_id: String,
    correction_reason: Option<String>,
) -> Result<InvoiceArchiveResult, String> {
    let store = state.inner().clone();
    archive_invoice(&store, &invoice_id, correction_reason.as_deref())
        .await
        .map_err(command_error)
}

async fn cloud_account_state(store: &LocalStore) -> AppResult<CloudAccountState> {
    if let Some(mut session) = read_secret::<CloudSession>(&session_path(store))? {
        let cached = CloudAccountState::from_session(&session)?;
        if cached.status != "connected" {
            if cached.status == "expired" {
                store.mark_current_license_unrecognized()?;
            }
            return Ok(cached);
        }
        let response =
            account_request(Method::GET, ME_PATH, None, Some(&session.session_token)).await;
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
                store.mark_current_license_unrecognized()?;
                remove_protected(&session_path(store))?;
                return Ok(CloudAccountState::disconnected());
            }
            let role_changed = session.role != me.organization.role;
            session.organization_name = me.organization.name;
            session.role = me.organization.role;
            validate_session(&session)?;
            if role_changed {
                // La licence actuelle porte encore l'ancien rôle signé. Elle
                // reste bloquée jusqu'à sa réémission immédiate par App.tsx.
                store.mark_current_license_unrecognized()?;
            }
            write_secret(&session_path(store), &session)?;
            return CloudAccountState::from_session(&session);
        }
        if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            store.mark_current_license_unrecognized()?;
            remove_protected(&session_path(store))?;
            return Ok(CloudAccountState::disconnected());
        }
        if status == StatusCode::PAYMENT_REQUIRED {
            store.mark_current_license_inactive()?;
            return CloudAccountState::inactive(&session);
        }
        if status.is_server_error() {
            return Ok(cached);
        }
        return Err(server_response_error(status, &bytes));
    }
    if let Some(pending) = read_secret::<PendingAuthorization>(&pending_path(store))? {
        return CloudAccountState::from_pending(&pending);
    }
    Ok(CloudAccountState::disconnected())
}

async fn start_link(store: &LocalStore) -> AppResult<CloudAccountState> {
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
    validate_pending(&pending)?;
    write_secret(&pending_path(store), &pending)?;
    CloudAccountState::from_pending(&pending)
}

async fn poll_link(store: &LocalStore) -> AppResult<CloudAccountState> {
    if let Some(exchange) = read_secret::<PendingExchange>(&exchange_path(store))? {
        return finalize_exchange(store, exchange);
    }
    let pending = read_secret::<PendingAuthorization>(&pending_path(store))?.ok_or_else(|| {
        AppError::Validation("Relancez la connexion au compte depuis les paramètres.".into())
    })?;
    validate_pending(&pending)?;
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
    validate_session(&session)?;
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
    write_secret(&exchange_path(store), &exchange)?;
    finalize_exchange(store, exchange)
}

fn finalize_exchange(
    store: &LocalStore,
    exchange: PendingExchange,
) -> AppResult<CloudAccountState> {
    if exchange.version != SECRET_VERSION || exchange.installation_id != store.installation_id {
        return Err(AppError::Validation(
            "La réponse protégée ne correspond pas à cette installation.".into(),
        ));
    }
    validate_session(&exchange.session)?;
    store.install_server_issued_license(&exchange.license_token)?;
    write_secret(&session_path(store), &exchange.session)?;
    remove_protected(&exchange_path(store))?;
    remove_protected(&pending_path(store))?;
    CloudAccountState::from_session(&exchange.session)
}

async fn disconnect(store: &LocalStore) -> AppResult<()> {
    if let Some(session) = read_secret::<CloudSession>(&session_path(store))? {
        validate_session(&session)?;
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
    }
    // Une déconnexion explicite révoque aussi le droit d'écriture local. Les
    // données restent lisibles, mais une nouvelle autorisation serveur est
    // requise pour modifier ce profil.
    store.mark_current_license_unrecognized()?;
    remove_protected(&session_path(store))?;
    remove_protected(&pending_path(store))?;
    remove_protected(&exchange_path(store))?;
    Ok(())
}

async fn archive_invoice(
    store: &LocalStore,
    invoice_id: &str,
    correction_reason: Option<&str>,
) -> AppResult<InvoiceArchiveResult> {
    let session = read_secret::<CloudSession>(&session_path(store))?.ok_or_else(|| {
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
    let local = prepare_invoice_archive(store, invoice_id)?;
    let content_sha256 = format!("{:x}", Sha256::digest(&local.pdf_bytes));
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

fn prepare_invoice_archive(store: &LocalStore, invoice_id: &str) -> AppResult<LocalInvoiceArchive> {
    let invoice_id = invoice_id.trim();
    Uuid::parse_str(invoice_id)
        .map_err(|_| AppError::Validation("La référence locale de facture est invalide.".into()))?;
    let _guard = store.lock()?;
    let connection = store.connect()?;
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
    let url = Url::parse(value)
        .map_err(|_| AppError::Validation("Le lien de connexion est invalide.".into()))?;
    let expected = Url::parse(ACCOUNT_API_ORIGIN)
        .map_err(|_| AppError::Validation("L’origine Zentra intégrée est invalide.".into()))?;
    let code_matches = url
        .query_pairs()
        .any(|(key, value)| key == "code" && value == user_code);
    if url.scheme() != "https"
        || url.host_str() != expected.host_str()
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
    Ok(url)
}

fn endpoint(path: &str) -> AppResult<Url> {
    if !matches!(
        path,
        START_PATH | POLL_PATH | ME_PATH | SESSION_PATH | ARCHIVE_PATH
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
    crate::app_updater::ensure_rustls_crypto_provider().map_err(AppError::Validation)?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .user_agent(format!("Zentra-Account/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| AppError::Validation("Le client HTTPS Zentra est indisponible.".into()))?;
    let mut request = client
        .request(method, url)
        .header(ACCEPT, "application/json");
    if let Some(body) = body {
        request = request.header(CONTENT_TYPE, "application/json").body(body);
    }
    if let Some(token) = bearer {
        validate_opaque_token(token, "zds_")?;
        request = request.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = request.send().await.map_err(|_| {
        AppError::Validation("Le service de compte Zentra est momentanément inaccessible.".into())
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

async fn read_bounded_response(response: reqwest::Response) -> AppResult<Vec<u8>> {
    let declared = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|size| size > MAX_RESPONSE_BYTES) {
        return Err(AppError::Validation(
            "La réponse Zentra est trop volumineuse.".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(declared.unwrap_or_default() as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|_| AppError::Validation("La réponse Zentra a été interrompue.".into()))?;
        if bytes.len().saturating_add(chunk.len()) as u64 > MAX_RESPONSE_BYTES {
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
    AppError::Validation(message)
}

fn write_secret<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    write_protected_atomically(path, &serde_json::to_vec(value)?)
}

fn read_secret<T: DeserializeOwned>(path: &Path) -> AppResult<Option<T>> {
    let bytes = match read_protected(path) {
        Ok(bytes) => bytes,
        Err(AppError::Io(error)) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(Some(serde_json::from_slice(&bytes)?))
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
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(uri).spawn()?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(AppError::UnsupportedPlatform)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
