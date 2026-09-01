use std::{sync::Mutex, time::Duration};

use base64::Engine;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use reqwest::{header::CONTENT_LENGTH, redirect::Policy};
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const PUBLIC_KEY_ENV: &str = "ELYKO_UPDATER_PUBLIC_KEY";
const ENDPOINT_ENV: &str = "ELYKO_UPDATER_ENDPOINT";
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_REDIRECTS: usize = 5;
const MAX_UPDATE_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone)]
struct SecureUpdaterConfiguration {
    endpoint: Option<Url>,
    public_key: Option<String>,
    reason: String,
}

impl SecureUpdaterConfiguration {
    fn enabled(&self) -> bool {
        self.endpoint.is_some() && self.public_key.is_some()
    }

    fn from_build_environment() -> Self {
        validate_configuration(
            option_env!("ELYKO_UPDATER_PUBLIC_KEY"),
            option_env!("ELYKO_UPDATER_ENDPOINT"),
        )
    }
}

pub struct SecureUpdaterState {
    configuration: SecureUpdaterConfiguration,
    pending_update: Mutex<Option<Update>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureUpdaterPolicy {
    enabled: bool,
    current_version: String,
    channel: &'static str,
    endpoint_host: Option<String>,
    signature_required: bool,
    transport: &'static str,
    automatic_install: bool,
    reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureUpdateMetadata {
    version: String,
    current_version: String,
    date: Option<String>,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum SecureUpdateEvent {
    Preparing,
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "downloadedBytes")]
        downloaded_bytes: u64,
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
        percent: Option<u8>,
    },
    Verifying,
    Installed,
}

pub fn initialize<R: Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
    ensure_rustls_crypto_provider().map_err(|error| {
        tauri::Error::Io(std::io::Error::other(format!(
            "Initialisation TLS refusée : {error}"
        )))
    })?;
    let configuration = SecureUpdaterConfiguration::from_build_environment();

    // The updater plugin is absent when the immutable build configuration is
    // incomplete. This prevents a renderer or a runtime environment variable
    // from substituting an attacker-controlled key or endpoint.
    if let Some(public_key) = configuration.public_key.clone() {
        app.handle().plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(public_key)
                .build(),
        )?;
    }

    app.manage(SecureUpdaterState {
        configuration,
        pending_update: Mutex::new(None),
    });
    Ok(())
}

pub(crate) fn ensure_rustls_crypto_provider() -> Result<(), String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // L'updater et le renouvellement utilisent tous deux reqwest avec
        // `rustls-no-provider`. Ring est déjà la primitive Tauri retenue dans
        // ce binaire; l'installer explicitement évite un panic au premier HTTPS.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        return Err("aucun fournisseur cryptographique Rustls n’est disponible".into());
    }
    Ok(())
}

#[tauri::command]
pub fn get_secure_update_policy(state: State<'_, SecureUpdaterState>) -> SecureUpdaterPolicy {
    let configuration = &state.configuration;
    SecureUpdaterPolicy {
        enabled: configuration.enabled(),
        current_version: env!("CARGO_PKG_VERSION").to_owned(),
        channel: "stable",
        endpoint_host: configuration
            .endpoint
            .as_ref()
            .and_then(Url::host_str)
            .map(ToOwned::to_owned),
        signature_required: true,
        transport: "HTTPS",
        automatic_install: false,
        reason: configuration.reason.clone(),
    }
}

#[tauri::command]
pub async fn check_secure_update(
    app: AppHandle,
    state: State<'_, SecureUpdaterState>,
) -> Result<Option<SecureUpdateMetadata>, String> {
    let endpoint = state
        .configuration
        .endpoint
        .clone()
        .ok_or_else(|| format!("Recherche désactivée : {}", state.configuration.reason))?;
    let public_key = state
        .configuration
        .public_key
        .clone()
        .ok_or_else(|| format!("Recherche désactivée : {}", state.configuration.reason))?;

    *state
        .pending_update
        .lock()
        .map_err(|_| "L’état local des mises à jour est indisponible.".to_owned())? = None;

    let updater = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| format!("Configuration du serveur de mise à jour refusée : {error}"))?
        .timeout(MANIFEST_TIMEOUT)
        .configure_client(|client| {
            client
                .https_only(true)
                .redirect(Policy::limited(MAX_REDIRECTS))
        })
        .build()
        .map_err(|error| format!("Initialisation du contrôle de mise à jour refusée : {error}"))?;

    let update = updater.check().await.map_err(|error| {
        format!("Le manifeste de mise à jour n’a pas pu être validé via HTTPS : {error}")
    })?;

    let Some(update) = update else {
        return Ok(None);
    };

    if update.download_url.scheme() != "https"
        || !update.download_url.username().is_empty()
        || update.download_url.password().is_some()
    {
        return Err(
            "Mise à jour refusée : l’archive annoncée doit utiliser une URL HTTPS sans identifiants."
                .to_owned(),
        );
    }
    if update.signature.trim().is_empty() {
        return Err(
            "Mise à jour refusée : le manifeste ne contient aucune signature Tauri/Ed25519."
                .to_owned(),
        );
    }

    let metadata = SecureUpdateMetadata {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        date: update
            .raw_json
            .get("pub_date")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        notes: update.body.clone().map(|value| truncate_notes(&value)),
    };
    *state
        .pending_update
        .lock()
        .map_err(|_| "L’état local des mises à jour est indisponible.".to_owned())? = Some(update);

    Ok(Some(metadata))
}

#[tauri::command]
pub async fn install_secure_update(
    state: State<'_, SecureUpdaterState>,
    on_event: Channel<SecureUpdateEvent>,
) -> Result<(), String> {
    if !state.configuration.enabled() {
        return Err(format!(
            "Installation désactivée : {}",
            state.configuration.reason
        ));
    }

    let update = state
        .pending_update
        .lock()
        .map_err(|_| "L’état local des mises à jour est indisponible.".to_owned())?
        .take()
        .ok_or_else(|| {
            "Aucune mise à jour contrôlée n’est prête. Lancez d’abord une nouvelle recherche."
                .to_owned()
        })?;

    let installation = async {
        let _ = on_event.send(SecureUpdateEvent::Preparing);
        let public_key = state.configuration.public_key.as_deref().ok_or_else(|| {
            "Installation désactivée : clé publique absente de ce build.".to_owned()
        })?;
        let artifact = download_update_artifact(&update, &on_event).await?;
        let _ = on_event.send(SecureUpdateEvent::Verifying);
        verify_update_signature(&artifact, &update.signature, public_key)?;
        update.install(&artifact).map_err(|error| {
            format!("Mise à jour refusée : l’installateur signé n’a pas pu être lancé ({error}).")
        })?;

        // On Windows the updater normally closes the application while launching
        // the NSIS installer. This event is still useful on other desktop targets.
        let _ = on_event.send(SecureUpdateEvent::Installed);
        Ok(())
    }
    .await;

    restore_pending_update_after_error(&state.pending_update, update, installation)
}

fn restore_pending_update_after_error<T>(
    pending_update: &Mutex<Option<T>>,
    update: T,
    result: Result<(), String>,
) -> Result<(), String> {
    if result.is_ok() {
        return result;
    }

    let mut pending = pending_update
        .lock()
        .map_err(|_| "L’état local des mises à jour est indisponible.".to_owned())?;
    if pending.is_none() {
        *pending = Some(update);
    }
    result
}

async fn download_update_artifact(
    update: &Update,
    on_event: &Channel<SecureUpdateEvent>,
) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("Zentra-Updater/{}", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .redirect(Policy::limited(MAX_REDIRECTS))
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|error| format!("Client HTTPS de mise à jour indisponible : {error}"))?;
    let response = client
        .get(update.download_url.clone())
        .send()
        .await
        .map_err(|error| format!("Téléchargement HTTPS impossible : {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Téléchargement refusé : le serveur a répondu {}.",
            response.status()
        ));
    }
    if response.url().scheme() != "https" {
        return Err("Téléchargement refusé : une redirection a quitté HTTPS.".to_owned());
    }

    let content_length = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if let Some(length) = content_length {
        validate_update_size(length, true)?;
    }

    let _ = on_event.send(SecureUpdateEvent::Started { content_length });
    let initial_capacity = content_length
        .unwrap_or_default()
        .min(MAX_UPDATE_ARTIFACT_BYTES)
        .try_into()
        .unwrap_or(0);
    let mut artifact = Vec::with_capacity(initial_capacity);
    let mut downloaded_bytes = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Téléchargement interrompu : {error}"))?;
        downloaded_bytes = downloaded_bytes
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| "Téléchargement refusé : taille d’artefact invalide.".to_owned())?;
        validate_update_size(downloaded_bytes, false)?;
        artifact.extend_from_slice(&chunk);
        let percent = content_length
            .filter(|total| *total > 0)
            .map(|total| ((downloaded_bytes.saturating_mul(100) / total).min(100)) as u8);
        let _ = on_event.send(SecureUpdateEvent::Progress {
            downloaded_bytes,
            content_length,
            percent,
        });
    }
    if content_length.is_some_and(|expected| expected != downloaded_bytes) {
        return Err(format!(
            "Téléchargement refusé : {} octets reçus au lieu des {} annoncés.",
            downloaded_bytes,
            content_length.unwrap_or_default()
        ));
    }
    if artifact.is_empty() {
        return Err("Téléchargement refusé : l’artefact est vide.".to_owned());
    }
    Ok(artifact)
}

fn validate_update_size(bytes: u64, announced: bool) -> Result<(), String> {
    if bytes <= MAX_UPDATE_ARTIFACT_BYTES {
        return Ok(());
    }
    let qualifier = if announced { " annoncé" } else { "" };
    Err(format!(
        "Téléchargement refusé : l’artefact{qualifier} dépasse la limite de {} Mio.",
        MAX_UPDATE_ARTIFACT_BYTES / 1024 / 1024
    ))
}

fn verify_update_signature(
    artifact: &[u8],
    release_signature: &str,
    public_key: &str,
) -> Result<(), String> {
    let public_key_document = decode_base64_document(public_key, "clé publique")?;
    let public_key = PublicKey::decode(&public_key_document)
        .map_err(|error| format!("Clé publique de mise à jour refusée : {error}"))?;
    let signature_document = decode_base64_document(release_signature, "signature")?;
    let signature = Signature::decode(&signature_document)
        .map_err(|error| format!("Signature de mise à jour refusée : {error}"))?;
    public_key
        .verify(artifact, &signature, true)
        .map_err(|error| format!("Signature Tauri/Ed25519 invalide : {error}"))
}

fn decode_base64_document(value: &str, label: &str) -> Result<String, String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| format!("La {label} n’est pas en base64 valide."))?;
    String::from_utf8(decoded).map_err(|_| format!("La {label} n’est pas un document UTF-8."))
}

fn validate_configuration(
    public_key: Option<&str>,
    endpoint: Option<&str>,
) -> SecureUpdaterConfiguration {
    let public_key = public_key.map(str::trim).filter(|value| !value.is_empty());
    let endpoint = endpoint.map(str::trim).filter(|value| !value.is_empty());

    let (Some(public_key), Some(endpoint)) = (public_key, endpoint) else {
        let missing = match (public_key, endpoint) {
            (None, None) => format!("{PUBLIC_KEY_ENV} et {ENDPOINT_ENV} manquent dans ce build"),
            (None, Some(_)) => format!("{PUBLIC_KEY_ENV} manque dans ce build"),
            (Some(_), None) => format!("{ENDPOINT_ENV} manque dans ce build"),
            (Some(_), Some(_)) => unreachable!(),
        };
        return SecureUpdaterConfiguration {
            endpoint: None,
            public_key: None,
            reason: format!(
                "Mises à jour intégrées inactives : {missing}. Aucune source réseau ne sera contactée."
            ),
        };
    };

    let decoded_public_key = match base64::engine::general_purpose::STANDARD.decode(public_key) {
        Ok(value) => value,
        Err(_) => {
            return SecureUpdaterConfiguration {
                endpoint: None,
                public_key: None,
                reason: "Configuration refusée : la clé publique Tauri n’est pas en base64 valide."
                    .to_owned(),
            };
        }
    };
    let decoded_public_key = match std::str::from_utf8(&decoded_public_key) {
        Ok(value) => value,
        Err(_) => {
            return SecureUpdaterConfiguration {
                endpoint: None,
                public_key: None,
                reason: "Configuration refusée : la clé publique Tauri n’est pas un document UTF-8 valide."
                    .to_owned(),
            };
        }
    };
    let normalized_public_key = decoded_public_key.to_ascii_lowercase();
    if normalized_public_key.contains("private key") {
        return SecureUpdaterConfiguration {
            endpoint: None,
            public_key: None,
            reason: "Configuration refusée : une clé privée ne doit jamais être intégrée à l’application."
                .to_owned(),
        };
    }
    let mut public_key_lines = decoded_public_key.lines();
    let public_key_comment = public_key_lines.next().unwrap_or_default().trim();
    let encoded_key = public_key_lines.next().unwrap_or_default().trim();
    let has_unexpected_content = public_key_lines.any(|line| !line.trim().is_empty());
    let decoded_key = base64::engine::general_purpose::STANDARD.decode(encoded_key);
    let valid_key_bytes = decoded_key.as_deref().is_ok_and(|bytes| {
        bytes.len() == 42 && matches!((bytes[0], bytes[1]), (0x45, 0x64) | (0x45, 0x44))
    });
    if !public_key_comment
        .to_ascii_lowercase()
        .contains("minisign public key")
        || has_unexpected_content
        || !valid_key_bytes
    {
        return SecureUpdaterConfiguration {
            endpoint: None,
            public_key: None,
            reason: "Configuration refusée : utilisez la clé publique produite par `tauri signer generate`."
                .to_owned(),
        };
    }

    let parsed = match Url::parse(endpoint) {
        Ok(value) => value,
        Err(error) => {
            return SecureUpdaterConfiguration {
                endpoint: None,
                public_key: None,
                reason: format!("Configuration refusée : URL de mise à jour invalide ({error})."),
            };
        }
    };
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return SecureUpdaterConfiguration {
            endpoint: None,
            public_key: None,
            reason: "Configuration refusée : le manifeste doit utiliser une URL HTTPS sans identifiants ni fragment."
                .to_owned(),
        };
    }

    SecureUpdaterConfiguration {
        endpoint: Some(parsed),
        public_key: Some(public_key.to_owned()),
        reason:
            "Canal stable activé : manifeste HTTPS et signature Tauri/Ed25519 obligatoires avant installation."
                .to_owned(),
    }
}

fn truncate_notes(value: &str) -> String {
    const MAX_CHARS: usize = 4_000;
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use base64::Engine;

    use super::{
        restore_pending_update_after_error, validate_configuration, validate_update_size,
        MAX_UPDATE_ARTIFACT_BYTES,
    };

    fn public_key() -> String {
        base64::engine::general_purpose::STANDARD
            .encode("untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3")
    }

    #[test]
    fn updater_is_closed_when_build_values_are_missing() {
        let configuration = validate_configuration(None, None);
        assert!(!configuration.enabled());
        assert!(configuration.reason.contains("Aucune source réseau"));
    }

    #[test]
    fn updater_rejects_plain_http_and_embedded_credentials() {
        let public_key = public_key();
        let http =
            validate_configuration(Some(&public_key), Some("http://updates.test/latest.json"));
        assert!(!http.enabled());

        let credentials = validate_configuration(
            Some(&public_key),
            Some("https://user:secret@updates.test/latest.json"),
        );
        assert!(!credentials.enabled());

        let fragment = validate_configuration(
            Some(&public_key),
            Some("https://updates.test/latest.json#autre-source"),
        );
        assert!(!fragment.enabled());
    }

    #[test]
    fn updater_rejects_a_private_key_in_the_binary() {
        let private_key = base64::engine::general_purpose::STANDARD
            .encode("untrusted comment: minisign PRIVATE KEY\nRWRexample");
        let configuration =
            validate_configuration(Some(&private_key), Some("https://updates.test/latest.json"));
        assert!(!configuration.enabled());
        assert!(configuration.reason.contains("clé privée"));
    }

    #[test]
    fn updater_accepts_only_the_immutable_https_policy() {
        let public_key = public_key();
        let configuration =
            validate_configuration(Some(&public_key), Some("https://updates.test/latest.json"));
        assert!(configuration.enabled());
        assert_eq!(
            configuration.endpoint.as_ref().and_then(url::Url::host_str),
            Some("updates.test")
        );
    }

    #[test]
    fn updater_artifact_limit_is_enforced_before_and_during_download() {
        assert!(validate_update_size(MAX_UPDATE_ARTIFACT_BYTES, true).is_ok());
        assert!(validate_update_size(MAX_UPDATE_ARTIFACT_BYTES, false).is_ok());
        assert!(validate_update_size(MAX_UPDATE_ARTIFACT_BYTES + 1, true)
            .unwrap_err()
            .contains("annoncé"));
        assert!(validate_update_size(MAX_UPDATE_ARTIFACT_BYTES + 1, false)
            .unwrap_err()
            .contains("256 Mio"));
    }

    #[test]
    fn failed_installation_restores_the_checked_update_for_retry() {
        let pending = Mutex::new(None);

        let failure = restore_pending_update_after_error(
            &pending,
            "update-1".to_owned(),
            Err("network interrupted".to_owned()),
        );

        assert_eq!(failure.unwrap_err(), "network interrupted");
        assert_eq!(pending.lock().unwrap().as_deref(), Some("update-1"));
    }

    #[test]
    fn successful_installation_does_not_restore_the_consumed_update() {
        let pending = Mutex::new(None);

        restore_pending_update_after_error(&pending, "update-1".to_owned(), Ok(())).unwrap();

        assert!(pending.lock().unwrap().is_none());
    }
}
