use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration as ChronoDuration, Local, NaiveDate, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::StreamExt;
use reqwest::{
    header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, RETRY_AFTER},
    redirect::Policy,
    StatusCode,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
    installation::{read_protected, write_protected_atomically},
    models::LicenseTokenPayload,
};

pub const LICENSE_PLAN: &str = "zentra-monthly-50-chf";
const LEGACY_LICENSE_PLANS: &[&str] = &["elyko-monthly-50-chf", "helvichantier-monthly-50-chf"];
pub const LICENSE_PRICE_CHF_CENTS: i64 = 5_000;
const TOKEN_VERSION: u8 = 2;
const LICENSE_KEY_ID: &str = "hc-prod-v1";
const CLOCK_ANCHOR_VERSION: u8 = 1;
const LICENSE_INSTALLATION_PROOF_VERSION: u8 = 1;
const REFRESH_ATTEMPT_VERSION: u8 = 1;
#[cfg(windows)]
const CLOCK_ANCHOR_FILE: &str = "license-clock.dpapi";
#[cfg(not(windows))]
const CLOCK_ANCHOR_FILE: &str = "license-clock.protected";
#[cfg(windows)]
const LICENSE_INSTALLATION_PROOF_FILE: &str = "license-installation.dpapi";
#[cfg(not(windows))]
const LICENSE_INSTALLATION_PROOF_FILE: &str = "license-installation.protected";
#[cfg(windows)]
const REFRESH_ATTEMPT_FILE: &str = "license-refresh-attempt.dpapi";
#[cfg(not(windows))]
const REFRESH_ATTEMPT_FILE: &str = "license-refresh-attempt.protected";
const LICENSE_REFRESH_ENDPOINT: &str = "https://elyko.alb-leart1.chatgpt.site/api/stripe/refresh";
const MAX_LICENSE_TOKEN_BYTES: usize = 8 * 1024;
const MAX_REFRESH_RESPONSE_BYTES: u64 = 16 * 1024;
const REFRESH_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REFRESH_TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
const CLOCK_TOLERANCE_SECONDS: i64 = 5 * 60;
const AUTO_REFRESH_WINDOW_DAYS: i64 = 7;
const AUTO_REFRESH_INTERVAL_HOURS: i64 = 24;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum LicenseServerAccess {
    Active,
    Inactive,
    Unrecognized,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LicenseClockAnchor {
    version: u8,
    installation_id: String,
    license_id: String,
    max_seen_utc: String,
    max_seen_date: String,
    server_access: LicenseServerAccess,
}

// Défense en profondeur contre une remise à zéro partielle de SQLite : cette
// preuve DPAPI n'est ni une DRM « incrackable », ni une identité serveur. Un
// administrateur local peut toujours supprimer toutes les données Zentra ; le
// service HTTPS reste l'autorité pour rétablir une installation déjà utilisée.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LicenseInstallationProof {
    version: u8,
    installation_id: String,
    first_license_id: String,
    established_at_utc: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LicenseRefreshAttempt {
    version: u8,
    installation_id: String,
    license_id: String,
    attempted_at_utc: String,
}

#[derive(Deserialize)]
struct LicenseRefreshResponse {
    token: String,
}

struct LicenseRefreshSnapshot {
    token: String,
}

struct LicenseInstallSnapshot {
    candidate_token: String,
    candidate_license_id: String,
    previous_token: Option<String>,
}

enum LicenseRefreshOutcome {
    Token(String),
    Inactive,
    Unrecognized,
}

#[cfg(debug_assertions)]
const EMBEDDED_PUBLIC_KEY: Option<&str> = option_env!("HELVICHANTIER_LICENSE_PUBLIC_KEY_B64URL");

#[cfg(not(debug_assertions))]
const EMBEDDED_PUBLIC_KEY: Option<&str> = Some(env!(
    "HELVICHANTIER_LICENSE_PUBLIC_KEY_B64URL",
    "La clé publique de licence est obligatoire pour une release"
));

impl LocalStore {
    pub(crate) fn install_server_issued_license(&self, token: &str) -> AppResult<Value> {
        let key=embedded_key()?.ok_or_else(||AppError::Validation("Cette installation de Zentra ne contient pas les informations de vérification de licence attendues. Réinstallez Zentra depuis le site officiel ou contactez l’assistance.".into()))?;
        let _guard = self.lock()?;
        let snapshot = self.prepare_license_install_snapshot(token, &key)?;
        self.finish_online_license_installation(
            snapshot,
            &key,
            Ok(LicenseRefreshOutcome::Token(token.trim().to_owned())),
        )?;
        self.get_license_state_with_key(&key)
    }

    pub async fn install_license_token(&self, token: &str) -> AppResult<Value> {
        let key=embedded_key()?.ok_or_else(||AppError::Validation("Cette installation de Zentra ne contient pas les informations de vérification de licence attendues. Réinstallez Zentra depuis le site officiel ou contactez l’assistance.".into()))?;
        let snapshot = {
            let _guard = self.lock()?;
            self.prepare_license_install_snapshot(token, &key)?
        };
        let outcome = request_refreshed_license(&snapshot.candidate_token).await;
        {
            let _guard = self.lock()?;
            self.finish_online_license_installation(snapshot, &key, outcome)?;
        }
        self.get_license_state_with_key(&key)
    }

    fn prepare_license_install_snapshot(
        &self,
        token: &str,
        key: &[u8; 32],
    ) -> AppResult<LicenseInstallSnapshot> {
        let payload = verify_token_with_key(token, key)?;
        self.validate_installation_binding(&payload)?;
        let connection = self.connect()?;
        let previous: Option<(String, i64)> = connection
            .query_row(
                "SELECT token,clock_anchor_version FROM license_state WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if previous
            .as_ref()
            .is_some_and(|(_, marker)| !matches!(*marker, 0 | 1))
        {
            return Err(AppError::Validation(
                "Le marqueur de sécurité de la licence locale est invalide. Contactez le support."
                    .into(),
            ));
        }
        Ok(LicenseInstallSnapshot {
            candidate_token: token.trim().to_owned(),
            candidate_license_id: payload.license_id,
            previous_token: previous.map(|(stored, _)| stored),
        })
    }

    fn finish_online_license_installation(
        &self,
        snapshot: LicenseInstallSnapshot,
        key: &[u8; 32],
        outcome: AppResult<LicenseRefreshOutcome>,
    ) -> AppResult<LicenseTokenPayload> {
        let refreshed_token = match outcome? {
            LicenseRefreshOutcome::Token(token) => token,
            LicenseRefreshOutcome::Inactive => return Err(AppError::Validation(
                "L’abonnement associé à ce jeton est inactif. Réactivez-le avant l’installation."
                    .into(),
            )),
            LicenseRefreshOutcome::Unrecognized => return Err(AppError::Validation(
                "Le service Zentra ne reconnaît pas ce jeton. Vérifiez-le ou contactez le support."
                    .into(),
            )),
        };
        let payload = verify_token_with_key(&refreshed_token, key)?;
        self.validate_installation_binding(&payload)?;
        if payload.license_id != snapshot.candidate_license_id {
            return Err(AppError::Validation(
                "Le service Zentra a retourné une autre licence que celle demandée. Aucune activation n’a été enregistrée."
                    .into(),
            ));
        }
        let current_token: Option<String> = self
            .connect()?
            .query_row("SELECT token FROM license_state WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()?;
        if current_token != snapshot.previous_token {
            return Err(AppError::Validation(
                "La licence locale a changé pendant la vérification en ligne. Relancez l’installation."
                    .into(),
            ));
        }
        let installed = self.persist_verified_license(
            &refreshed_token,
            &payload,
            snapshot.previous_token.as_deref(),
            "install_online",
        )?;
        if !installed {
            return Err(AppError::Validation(
                "La licence locale a changé pendant l’installation. Relancez la vérification."
                    .into(),
            ));
        }
        Ok(payload)
    }

    #[cfg(test)]
    fn install_server_token_with_key(
        &self,
        token: &str,
        key: &[u8; 32],
    ) -> AppResult<LicenseTokenPayload> {
        let snapshot = self.prepare_license_install_snapshot(token, key)?;
        self.finish_online_license_installation(
            snapshot,
            key,
            Ok(LicenseRefreshOutcome::Token(token.to_owned())),
        )
    }

    fn persist_verified_license(
        &self,
        token: &str,
        payload: &LicenseTokenPayload,
        expected_token: Option<&str>,
        audit_action: &str,
    ) -> AppResult<bool> {
        let mut connection = self.connect()?;
        let existing: Option<String> = connection
            .query_row("SELECT token FROM license_state WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()?;
        if existing.as_deref() != expected_token {
            return Ok(false);
        }

        let now_utc = Utc::now();
        let current_date = Local::now().date_naive();
        let anchor =
            self.prepare_anchor_from_online_verification(payload, now_utc, current_date)?;
        self.write_clock_anchor(&anchor)?;
        self.write_or_repair_license_installation_proof(payload)?;

        let verified_at = now_iso();
        let last_seen_date = anchor.max_seen_date.clone();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO license_state(id,token,license_id,customer_name,plan,price_chf_cents,issued_at,valid_from,valid_until,verified_at,last_seen_date,clock_anchor_version) VALUES(1,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET token=excluded.token,license_id=excluded.license_id,customer_name=excluded.customer_name,plan=excluded.plan,price_chf_cents=excluded.price_chf_cents,issued_at=excluded.issued_at,valid_from=excluded.valid_from,valid_until=excluded.valid_until,verified_at=excluded.verified_at,last_seen_date=excluded.last_seen_date,clock_anchor_version=1",params![token,payload.license_id,payload.customer_name,payload.plan,payload.price_chf_cents,payload.issued_at,payload.valid_from,payload.valid_until,verified_at,last_seen_date])?;
        let audit_ready: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE id=1 AND onboarding_completed=1)",
            [],
            |r| r.get(0),
        )?;
        if audit_ready {
            append_audit(
                &tx,
                audit_action,
                "license",
                "1",
                &json!({"license_id":payload.license_id,"access_role":payload.access_role,"plan":LICENSE_PLAN,"price_chf_cents":LICENSE_PRICE_CHF_CENTS,"valid_until":payload.valid_until}),
            )?;
        }
        tx.commit()?;
        Ok(true)
    }

    pub fn get_license_state(&self) -> AppResult<Value> {
        let Some(key) = embedded_key()? else {
            return Ok(
                json!({"enforcement_configured":false,"status":"not_configured","read_only":false,"can_refresh":false,"plan":LICENSE_PLAN,"price_chf_cents":LICENSE_PRICE_CHF_CENTS,"installation_id":self.installation_id,"token_version":TOKEN_VERSION,"reason":"Build de développement non soumis au contrôle de licence"}),
            );
        };
        self.get_license_state_with_key(&key)
    }

    fn get_license_state_with_key(&self, key: &[u8; 32]) -> AppResult<Value> {
        let connection = self.connect()?;
        let row=query_all(&connection,"SELECT token,license_id,customer_name,plan,price_chf_cents,issued_at,valid_from,valid_until,verified_at,last_seen_date,clock_anchor_version FROM license_state WHERE id=1",[])?.into_iter().next();
        let Some(row) = row else {
            return Ok(
                json!({"enforcement_configured":true,"status":"missing","read_only":true,"can_refresh":false,"plan":LICENSE_PLAN,"price_chf_cents":LICENSE_PRICE_CHF_CENTS,"installation_id":self.installation_id,"token_version":TOKEN_VERSION}),
            );
        };
        let token = row["token"].as_str().unwrap_or("");
        let payload = match verify_token_with_key(token, key) {
            Ok(v) => v,
            Err(error) => {
                return Ok(
                    json!({"enforcement_configured":true,"status":"invalid","read_only":true,"can_refresh":false,"plan":LICENSE_PLAN,"price_chf_cents":LICENSE_PRICE_CHF_CENTS,"installation_id":self.installation_id,"token_version":TOKEN_VERSION,"reason":error.to_string()}),
                )
            }
        };
        if let Err(error) = self.validate_installation_binding(&payload) {
            return Ok(
                json!({"enforcement_configured":true,"status":"invalid","read_only":true,"can_refresh":false,"plan":LICENSE_PLAN,"price_chf_cents":LICENSE_PRICE_CHF_CENTS,"installation_id":self.installation_id,"token_version":TOKEN_VERSION,"reason":error.to_string()}),
            );
        }

        let clock_anchor_version = row["clock_anchor_version"].as_i64().unwrap_or(-1);
        let mut anchor = match self.load_initialized_clock_anchor(&payload, clock_anchor_version) {
            Ok(anchor) => anchor,
            Err(error) => {
                return Ok(self.license_state_json(
                    &payload,
                    &row,
                    "clock_error",
                    true,
                    &error.to_string(),
                    &row["last_seen_date"],
                ))
            }
        };
        if self.validate_anchor_identity(&anchor, &payload).is_err() {
            return Ok(self.license_state_json(
                &payload,
                &row,
                "clock_error",
                true,
                "L’ancre de sécurité ne correspond pas à cette installation. Renouvelez la licence en ligne.",
                &Value::String(anchor.max_seen_date),
            ));
        }
        let now_utc = Utc::now();
        let current_date = Local::now().date_naive();
        if clock_rolled_back(&anchor, now_utc, current_date)? {
            return Ok(self.license_state_json(
                &payload,
                &row,
                "clock_error",
                true,
                "L’horloge de l’ordinateur paraît avoir reculé. Corrigez la date et l’heure, puis renouvelez la licence.",
                &Value::String(anchor.max_seen_date),
            ));
        }

        advance_anchor(&mut anchor, now_utc, current_date, &payload)?;
        if self.write_clock_anchor(&anchor).is_err() {
            return Ok(self.license_state_json(
                &payload,
                &row,
                "clock_error",
                true,
                "L’ancre de sécurité locale n’a pas pu être enregistrée. Renouvelez la licence ou contactez le support.",
                &Value::String(anchor.max_seen_date),
            ));
        }
        if row["last_seen_date"].as_str() != Some(anchor.max_seen_date.as_str()) {
            connection.execute(
                "UPDATE license_state SET last_seen_date=? WHERE id=1",
                params![anchor.max_seen_date],
            )?;
        }

        let (status, read_only, reason) = match anchor.server_access {
            LicenseServerAccess::Inactive => (
                "inactive",
                true,
                "L’abonnement Stripe est inactif. Réactivez-le puis renouvelez la licence.",
            ),
            LicenseServerAccess::Unrecognized => (
                "invalid",
                true,
                "Cette activation n’est plus reconnue par le service Zentra. Contactez le support.",
            ),
            LicenseServerAccess::Active => {
                let (status, read_only) = evaluate(
                    &payload,
                    &current_date.format("%Y-%m-%d").to_string(),
                    &anchor.max_seen_date,
                )?;
                (status, read_only, "")
            }
        };
        Ok(self.license_state_json(
            &payload,
            &row,
            status,
            read_only,
            reason,
            &Value::String(anchor.max_seen_date),
        ))
    }

    fn license_state_json(
        &self,
        payload: &LicenseTokenPayload,
        row: &Value,
        status: &str,
        read_only: bool,
        reason: &str,
        last_seen_date: &Value,
    ) -> Value {
        json!({"enforcement_configured":true,"status":status,"read_only":read_only,"can_refresh":true,"license_id":payload.license_id,"customer_name":payload.customer_name,"access_role":payload.access_role,"plan":payload.plan,"price_chf_cents":payload.price_chf_cents,"issued_at":payload.issued_at,"valid_from":payload.valid_from,"valid_until":payload.valid_until,"verified_at":row["verified_at"],"last_seen_date":last_seen_date,"installation_id":self.installation_id,"token_version":payload.token_version,"reason":reason})
    }

    pub async fn refresh_license(&self, automatic: bool) -> AppResult<Value> {
        let Some(key) = embedded_key()? else {
            return self.get_license_state();
        };
        let snapshot = {
            let _guard = self.lock()?;
            self.prepare_refresh_snapshot(&key, automatic)?
        };
        let Some(snapshot) = snapshot else {
            return self.get_license_state();
        };

        let outcome = request_refreshed_license(&snapshot.token).await?;
        let _guard = self.lock()?;
        match outcome {
            LicenseRefreshOutcome::Token(token) => {
                let payload = verify_token_with_key(&token, &key)?;
                self.validate_installation_binding(&payload)?;
                self.persist_verified_license(&token, &payload, Some(&snapshot.token), "refresh")?;
            }
            LicenseRefreshOutcome::Inactive => {
                self.mark_server_access(&snapshot.token, &key, LicenseServerAccess::Inactive)?
            }
            LicenseRefreshOutcome::Unrecognized => {
                self.mark_server_access(&snapshot.token, &key, LicenseServerAccess::Unrecognized)?
            }
        }
        self.get_license_state_with_key(&key)
    }

    fn prepare_refresh_snapshot(
        &self,
        key: &[u8; 32],
        automatic: bool,
    ) -> AppResult<Option<LicenseRefreshSnapshot>> {
        let connection = self.connect()?;
        let token: Option<String> = connection
            .query_row("SELECT token FROM license_state WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()?;
        let Some(token) = token else {
            if automatic {
                return Ok(None);
            }
            return Err(AppError::Validation(
                "Aucun jeton local ne peut être renouvelé. Installez d’abord le jeton reçu après paiement."
                    .into(),
            ));
        };
        let payload = verify_token_with_key(&token, key)?;
        self.validate_installation_binding(&payload)?;
        if automatic {
            if !self.refresh_is_due(&payload) {
                return Ok(None);
            }
            if !self.claim_automatic_refresh(&payload.license_id, Utc::now())? {
                return Ok(None);
            }
        }
        Ok(Some(LicenseRefreshSnapshot { token }))
    }

    fn refresh_is_due(&self, payload: &LicenseTokenPayload) -> bool {
        let today = Local::now().date_naive();
        let expires_soon = parse_date(&payload.valid_until, "valid_until")
            .is_ok_and(|until| until <= today + ChronoDuration::days(AUTO_REFRESH_WINDOW_DAYS));
        let anchor_requires_refresh =
            self.load_clock_anchor()
                .ok()
                .flatten()
                .is_none_or(|anchor| {
                    self.validate_anchor_identity(&anchor, payload).is_err()
                        || anchor.server_access != LicenseServerAccess::Active
                        || clock_rolled_back(&anchor, Utc::now(), today).unwrap_or(true)
                });
        // A legacy Zentra token remains valid during the product-name
        // migration, but is renewed online as soon as possible so the server
        // can reissue the canonical Zentra plan without locking out customers.
        payload.plan != LICENSE_PLAN || expires_soon || anchor_requires_refresh
    }

    fn claim_automatic_refresh(&self, license_id: &str, now_utc: DateTime<Utc>) -> AppResult<bool> {
        if let Some(attempt) = self.load_refresh_attempt()? {
            if attempt.version != REFRESH_ATTEMPT_VERSION
                || attempt.installation_id != self.installation_id
            {
                return Ok(false);
            }
            if attempt.license_id == license_id {
                let previous = parse_utc(&attempt.attempted_at_utc, "attempted_at_utc")?;
                if now_utc < previous
                    || now_utc - previous < ChronoDuration::hours(AUTO_REFRESH_INTERVAL_HOURS)
                {
                    return Ok(false);
                }
            }
        }
        let attempt = LicenseRefreshAttempt {
            version: REFRESH_ATTEMPT_VERSION,
            installation_id: self.installation_id.clone(),
            license_id: license_id.to_owned(),
            attempted_at_utc: now_utc.to_rfc3339(),
        };
        self.write_refresh_attempt(&attempt)?;
        Ok(true)
    }

    fn mark_server_access(
        &self,
        expected_token: &str,
        key: &[u8; 32],
        server_access: LicenseServerAccess,
    ) -> AppResult<()> {
        let connection = self.connect()?;
        let current: Option<String> = connection
            .query_row("SELECT token FROM license_state WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()?;
        if current.as_deref() != Some(expected_token) {
            return Ok(());
        }
        let payload = verify_token_with_key(expected_token, key)?;
        self.validate_installation_binding(&payload)?;
        let mut anchor = self.prepare_anchor_from_online_verification(
            &payload,
            Utc::now(),
            Local::now().date_naive(),
        )?;
        anchor.server_access = server_access;
        self.write_clock_anchor(&anchor)?;
        self.write_or_repair_license_installation_proof(&payload)?;
        let updated = connection.execute(
            "UPDATE license_state SET clock_anchor_version=1 WHERE id=1 AND token=?",
            params![expected_token],
        )?;
        if updated != 1 {
            return Err(AppError::Validation(
                "La licence locale a changé pendant le renouvellement. Relancez la vérification."
                    .into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn mark_current_license_unrecognized(&self) -> AppResult<()> {
        self.mark_current_license_access(LicenseServerAccess::Unrecognized)
    }

    pub(crate) fn mark_current_license_inactive(&self) -> AppResult<()> {
        self.mark_current_license_access(LicenseServerAccess::Inactive)
    }

    fn mark_current_license_access(&self, access: LicenseServerAccess) -> AppResult<()> {
        let Some(key) = embedded_key()? else {
            return Ok(());
        };
        let connection = self.connect()?;
        let token: Option<String> = connection
            .query_row("SELECT token FROM license_state WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()?;
        drop(connection);
        if let Some(token) = token {
            self.mark_server_access(&token, &key, access)?;
        }
        Ok(())
    }

    fn load_initialized_clock_anchor(
        &self,
        payload: &LicenseTokenPayload,
        clock_anchor_version: i64,
    ) -> AppResult<LicenseClockAnchor> {
        if clock_anchor_version == 0 {
            return Err(AppError::Validation(
                "Cette licence provient d’une ancienne version de Zentra. Une vérification en ligne est nécessaire une seule fois pour sécuriser cet ordinateur. Cliquez sur « Renouveler la licence »."
                    .into(),
            ));
        }
        if clock_anchor_version != 1 {
            return Err(AppError::Validation(
                "Le marqueur de sécurité de la licence locale est invalide. Renouvelez la licence en ligne."
                .into(),
            ));
        }
        let proof = self
            .load_license_installation_proof()
            .map_err(|_| installation_proof_repair_required())?
            .ok_or_else(installation_proof_repair_required)?;
        self.validate_license_installation_proof(&proof)
            .map_err(|_| installation_proof_repair_required())?;
        let anchor = self
            .load_clock_anchor()
            .map_err(|_| anchor_repair_required())?
            .ok_or_else(anchor_repair_required)?;
        self.validate_anchor_identity(&anchor, payload)?;
        Ok(anchor)
    }

    fn prepare_anchor_from_online_verification(
        &self,
        payload: &LicenseTokenPayload,
        now_utc: DateTime<Utc>,
        current_date: NaiveDate,
    ) -> AppResult<LicenseClockAnchor> {
        let mut anchor = match self.load_clock_anchor() {
            Ok(Some(anchor))
                if anchor.version == CLOCK_ANCHOR_VERSION
                    && anchor.installation_id == self.installation_id =>
            {
                anchor
            }
            Ok(Some(_)) | Ok(None) | Err(_) => {
                new_clock_anchor(self, payload, now_utc, current_date)?
            }
        };

        if anchor.license_id != payload.license_id {
            anchor.license_id = payload.license_id.clone();
        }
        anchor.server_access = LicenseServerAccess::Active;
        advance_anchor(&mut anchor, now_utc, current_date, payload)?;
        Ok(anchor)
    }

    fn validate_anchor_identity(
        &self,
        anchor: &LicenseClockAnchor,
        payload: &LicenseTokenPayload,
    ) -> AppResult<()> {
        if anchor.version != CLOCK_ANCHOR_VERSION
            || anchor.installation_id != self.installation_id
            || anchor.license_id != payload.license_id
        {
            return Err(anchor_repair_required());
        }
        parse_utc(&anchor.max_seen_utc, "max_seen_utc")?;
        parse_date(&anchor.max_seen_date, "max_seen_date")?;
        Ok(())
    }

    fn clock_anchor_path(&self) -> PathBuf {
        self.data_dir.join(CLOCK_ANCHOR_FILE)
    }

    fn license_installation_proof_path(&self) -> PathBuf {
        self.data_dir.join(LICENSE_INSTALLATION_PROOF_FILE)
    }

    fn refresh_attempt_path(&self) -> PathBuf {
        self.data_dir.join(REFRESH_ATTEMPT_FILE)
    }

    fn load_clock_anchor(&self) -> AppResult<Option<LicenseClockAnchor>> {
        read_protected_json(&self.clock_anchor_path())
    }

    fn write_clock_anchor(&self, anchor: &LicenseClockAnchor) -> AppResult<()> {
        write_protected_json(&self.clock_anchor_path(), anchor)
    }

    fn load_license_installation_proof(&self) -> AppResult<Option<LicenseInstallationProof>> {
        read_protected_json(&self.license_installation_proof_path())
    }

    fn validate_license_installation_proof(
        &self,
        proof: &LicenseInstallationProof,
    ) -> AppResult<()> {
        if proof.version != LICENSE_INSTALLATION_PROOF_VERSION
            || proof.installation_id != self.installation_id
            || proof.first_license_id.trim().is_empty()
        {
            return Err(installation_proof_repair_required());
        }
        parse_utc(&proof.established_at_utc, "established_at_utc")?;
        Ok(())
    }

    fn write_license_installation_proof(&self, payload: &LicenseTokenPayload) -> AppResult<()> {
        let proof = LicenseInstallationProof {
            version: LICENSE_INSTALLATION_PROOF_VERSION,
            installation_id: self.installation_id.clone(),
            first_license_id: payload.license_id.clone(),
            established_at_utc: Utc::now().to_rfc3339(),
        };
        write_protected_json(&self.license_installation_proof_path(), &proof)
    }

    fn write_or_repair_license_installation_proof(
        &self,
        payload: &LicenseTokenPayload,
    ) -> AppResult<()> {
        match self.load_license_installation_proof() {
            Ok(Some(proof)) if self.validate_license_installation_proof(&proof).is_ok() => Ok(()),
            Ok(Some(_)) | Ok(None) | Err(_) => self.write_license_installation_proof(payload),
        }
    }

    fn load_refresh_attempt(&self) -> AppResult<Option<LicenseRefreshAttempt>> {
        read_protected_json(&self.refresh_attempt_path())
    }

    fn write_refresh_attempt(&self, attempt: &LicenseRefreshAttempt) -> AppResult<()> {
        write_protected_json(&self.refresh_attempt_path(), attempt)
    }

    pub(crate) fn require_write_access(&self) -> AppResult<()> {
        let Some(key) = embedded_key()? else {
            return Ok(());
        };
        self.require_write_access_with_key(&key)
    }

    pub(crate) fn require_onboarding_write_access(&self) -> AppResult<()> {
        let Some(key) = embedded_key()? else {
            return Ok(());
        };
        self.require_onboarding_write_access_with_key(&key)
    }

    fn require_onboarding_write_access_with_key(&self, key: &[u8; 32]) -> AppResult<()> {
        let has_license = self
            .connect()?
            .query_row("SELECT 1 FROM license_state WHERE id=1", [], |_| Ok(()))
            .optional()?
            .is_some();
        if !has_license {
            return Ok(());
        }
        self.require_write_access_with_key(key)
    }

    fn require_write_access_with_key(&self, key: &[u8; 32]) -> AppResult<()> {
        let connection = self.connect()?;
        let row: (String, i64) = connection
            .query_row(
                "SELECT token,clock_anchor_version FROM license_state WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| {
                AppError::Validation("Licence requise : l'application est en lecture seule.".into())
            })?;
        let payload = verify_token_with_key(&row.0, key)?;
        self.validate_installation_binding(&payload)?;
        if payload.access_role == "read_only" {
            return Err(AppError::Validation(
                "Votre rôle Zentra est limité à la lecture : les modifications sont bloquées, même hors ligne."
                    .into(),
            ));
        }
        let mut anchor = self.load_initialized_clock_anchor(&payload, row.1)?;
        let now_utc = Utc::now();
        let current_date = Local::now().date_naive();
        if clock_rolled_back(&anchor, now_utc, current_date)? {
            return Err(AppError::Validation(
                "Horloge de l’ordinateur invalide : l'application est en lecture seule.".into(),
            ));
        }
        match anchor.server_access {
            LicenseServerAccess::Active => {}
            LicenseServerAccess::Inactive => {
                return Err(AppError::Validation(
                    "Abonnement Stripe inactif : l'application est en lecture seule.".into(),
                ))
            }
            LicenseServerAccess::Unrecognized => {
                return Err(AppError::Validation(
                    "Activation non reconnue : l'application est en lecture seule.".into(),
                ))
            }
        }
        let current = current_date.format("%Y-%m-%d").to_string();
        let (status, read_only) = evaluate(&payload, &current, &anchor.max_seen_date)?;
        if read_only {
            return Err(AppError::Validation(format!("Licence {status} : l'application est en lecture seule. Sauvegarde et export restent disponibles.")));
        }
        advance_anchor(&mut anchor, now_utc, current_date, &payload)?;
        self.write_clock_anchor(&anchor)
            .map_err(|_| anchor_repair_required())?;
        connection.execute(
            "UPDATE license_state SET last_seen_date=? WHERE id=1",
            params![anchor.max_seen_date],
        )?;
        Ok(())
    }

    fn validate_installation_binding(&self, payload: &LicenseTokenPayload) -> AppResult<()> {
        if payload.installation_id != self.installation_id {
            return Err(AppError::Validation(
                "Ce jeton appartient à une autre installation Zentra.".into(),
            ));
        }
        Ok(())
    }
}

fn anchor_repair_required() -> AppError {
    AppError::Validation(
        "L’ancre de sécurité locale est absente ou invalide. Renouvelez la licence en ligne."
            .into(),
    )
}

fn installation_proof_repair_required() -> AppError {
    AppError::Validation(
        "La preuve locale protégée de cette installation est absente ou invalide. Renouvelez la licence en ligne ou contactez le support."
            .into(),
    )
}

fn new_clock_anchor(
    store: &LocalStore,
    payload: &LicenseTokenPayload,
    now_utc: DateTime<Utc>,
    current_date: NaiveDate,
) -> AppResult<LicenseClockAnchor> {
    let issued_at = parse_utc(&payload.issued_at, "issued_at")?;
    let max_seen_utc = std::cmp::max(now_utc, issued_at);
    let max_seen_date = std::cmp::max(current_date, issued_at.with_timezone(&Local).date_naive());
    Ok(LicenseClockAnchor {
        version: CLOCK_ANCHOR_VERSION,
        installation_id: store.installation_id.clone(),
        license_id: payload.license_id.clone(),
        max_seen_utc: max_seen_utc.to_rfc3339(),
        max_seen_date: max_seen_date.format("%Y-%m-%d").to_string(),
        server_access: LicenseServerAccess::Active,
    })
}

fn advance_anchor(
    anchor: &mut LicenseClockAnchor,
    now_utc: DateTime<Utc>,
    current_date: NaiveDate,
    payload: &LicenseTokenPayload,
) -> AppResult<()> {
    let previous_utc = parse_utc(&anchor.max_seen_utc, "max_seen_utc")?;
    let issued_at = parse_utc(&payload.issued_at, "issued_at")?;
    anchor.max_seen_utc =
        std::cmp::max(std::cmp::max(previous_utc, now_utc), issued_at).to_rfc3339();
    let previous_date = parse_date(&anchor.max_seen_date, "max_seen_date")?;
    let issued_date = issued_at.with_timezone(&Local).date_naive();
    anchor.max_seen_date = std::cmp::max(std::cmp::max(previous_date, current_date), issued_date)
        .format("%Y-%m-%d")
        .to_string();
    Ok(())
}

fn clock_rolled_back(
    anchor: &LicenseClockAnchor,
    now_utc: DateTime<Utc>,
    current_date: NaiveDate,
) -> AppResult<bool> {
    let max_seen_utc = parse_utc(&anchor.max_seen_utc, "max_seen_utc")?;
    let max_seen_date = parse_date(&anchor.max_seen_date, "max_seen_date")?;
    Ok(
        now_utc + ChronoDuration::seconds(CLOCK_TOLERANCE_SECONDS) < max_seen_utc
            || current_date < max_seen_date,
    )
}

fn read_protected_json<T>(path: &Path) -> AppResult<Option<T>>
where
    T: for<'de> Deserialize<'de>,
{
    let clear = match read_protected(path) {
        Ok(clear) => clear,
        Err(AppError::Io(error)) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(Some(serde_json::from_slice(&clear)?))
}

fn write_protected_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    write_protected_atomically(path, &serde_json::to_vec(value)?)
}

async fn request_refreshed_license(token: &str) -> AppResult<LicenseRefreshOutcome> {
    if token.is_empty() || token.len() > MAX_LICENSE_TOKEN_BYTES {
        return Err(AppError::Validation(
            "Le jeton local a une taille invalide et ne sera pas envoyé.".into(),
        ));
    }
    crate::app_updater::ensure_rustls_crypto_provider().map_err(AppError::Validation)?;
    let endpoint = validated_refresh_endpoint()?;
    let body = serde_json::to_vec(&json!({ "token": token }))?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(Policy::none())
        .connect_timeout(REFRESH_CONNECT_TIMEOUT)
        .timeout(REFRESH_TOTAL_TIMEOUT)
        .user_agent(format!("Zentra-License/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| AppError::Validation("Le client HTTPS de licence est indisponible.".into()))?;
    let response = client
        .post(endpoint)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| {
            AppError::Validation(
                "Le service de licence est momentanément inaccessible. Le bail local existant reste inchangé."
                    .into(),
            )
        })?;
    let status = response.status();
    let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 32)
        .map(ToOwned::to_owned);
    let content_type_is_json = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(';').next().unwrap_or("").trim() == "application/json");
    let bytes = read_bounded_response(response).await?;

    if status.is_success() {
        if !content_type_is_json {
            return Err(AppError::Validation(
                "Le service de licence a retourné un format inattendu. Le bail local reste inchangé."
                    .into(),
            ));
        }
        let refreshed: LicenseRefreshResponse = serde_json::from_slice(&bytes).map_err(|_| {
            AppError::Validation(
                "La réponse signée du service de licence est invalide. Le bail local reste inchangé."
                    .into(),
            )
        })?;
        if refreshed.token.is_empty() || refreshed.token.len() > MAX_LICENSE_TOKEN_BYTES {
            return Err(AppError::Validation(
                "Le nouveau jeton a une taille invalide. Le bail local reste inchangé.".into(),
            ));
        }
        return Ok(LicenseRefreshOutcome::Token(refreshed.token));
    }
    match status {
        StatusCode::PAYMENT_REQUIRED => Ok(LicenseRefreshOutcome::Inactive),
        // Seule la réponse métier 403 de l'API Zentra signifie que le couple
        // licence/installation n'existe plus. Un 400/401 peut provenir d'une
        // évolution de protocole ou d'une configuration intermédiaire : dans
        // ce cas le bail local valable doit rester strictement inchangé.
        StatusCode::FORBIDDEN => Ok(LicenseRefreshOutcome::Unrecognized),
        StatusCode::TOO_MANY_REQUESTS => Err(AppError::Validation(format!(
            "Trop de tentatives de renouvellement. Réessayez plus tard{}.",
            retry_after
                .as_deref()
                .map(|value| format!(" (Retry-After: {value})"))
                .unwrap_or_default()
        ))),
        _ => Err(AppError::Validation(format!(
            "Le service de licence a répondu {status}. Le bail local existant reste inchangé."
        ))),
    }
}

async fn read_bounded_response(response: reqwest::Response) -> AppResult<Vec<u8>> {
    let declared = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|size| size > MAX_REFRESH_RESPONSE_BYTES) {
        return Err(AppError::Validation(
            "La réponse du service de licence est trop volumineuse.".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(declared.unwrap_or_default() as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            AppError::Validation("La réponse du service de licence a été interrompue.".into())
        })?;
        let next = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| AppError::Validation("Taille de réponse invalide.".into()))?;
        if next as u64 > MAX_REFRESH_RESPONSE_BYTES {
            return Err(AppError::Validation(
                "La réponse du service de licence est trop volumineuse.".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if declared.is_some_and(|size| size != bytes.len() as u64) {
        return Err(AppError::Validation(
            "La réponse du service de licence est incomplète.".into(),
        ));
    }
    Ok(bytes)
}

fn validated_refresh_endpoint() -> AppResult<reqwest::Url> {
    let endpoint = reqwest::Url::parse(LICENSE_REFRESH_ENDPOINT).map_err(|_| {
        AppError::Validation("L’URL de renouvellement intégrée est invalide.".into())
    })?;
    if endpoint.scheme() != "https"
        || endpoint.host_str() != Some("elyko.alb-leart1.chatgpt.site")
        || endpoint.path() != "/api/stripe/refresh"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(AppError::Validation(
            "L’URL de renouvellement intégrée ne respecte pas la politique Zentra.".into(),
        ));
    }
    Ok(endpoint)
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
    if token.trim().len() < 100 || token.trim().len() > MAX_LICENSE_TOKEN_BYTES {
        return Err(AppError::Validation(
            "Jeton de licence de longueur invalide.".into(),
        ));
    }
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
fn supported_license_plan(plan: &str) -> bool {
    plan == LICENSE_PLAN || LEGACY_LICENSE_PLANS.contains(&plan)
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
    if !supported_license_plan(&payload.plan) || payload.price_chf_cents != LICENSE_PRICE_CHF_CENTS
    {
        return Err(AppError::Validation(
            "Le jeton ne correspond pas au plan Zentra à 50 CHF/mois.".into(),
        ));
    }
    if !matches!(
        payload.access_role.as_str(),
        "owner" | "admin" | "accountant" | "member" | "read_only"
    ) {
        return Err(AppError::Validation(
            "Le rôle signé de la licence est invalide.".into(),
        ));
    }
    match (&payload.account_user_id, &payload.account_session_id) {
        (None, None) => {}
        (Some(user_id), Some(session_id)) => {
            if user_id.trim().is_empty() || user_id.len() > 255 {
                return Err(AppError::Validation(
                    "L’identifiant du compte signé est invalide.".into(),
                ));
            }
            let session_uuid = session_id
                .strip_prefix("dss_")
                .and_then(|value| uuid::Uuid::parse_str(value).ok())
                .filter(|value| value.get_version_num() == 4)
                .ok_or_else(|| {
                    AppError::Validation("L’identifiant de session signé est invalide.".into())
                })?;
            if session_uuid.is_nil() {
                return Err(AppError::Validation(
                    "L’identifiant de session signé est invalide.".into(),
                ));
            }
        }
        _ => {
            return Err(AppError::Validation(
                "La liaison signée entre le compte et la session est incomplète.".into(),
            ))
        }
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
        Ok(("valid", payload.access_role == "read_only"))
    }
}
fn parse_date(value: &str, field: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::Validation(format!("{field} doit être au format AAAA-MM-JJ.")))
}

fn parse_utc(value: &str, field: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| AppError::Validation(format!("{field} doit être RFC 3339.")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};

    fn current_token(
        store: &LocalStore,
        signing: &SigningKey,
        license_id: &str,
    ) -> (LicenseTokenPayload, String) {
        let now = Utc::now();
        let today = Local::now().date_naive();
        let payload = LicenseTokenPayload {
            token_version: TOKEN_VERSION,
            license_id: license_id.into(),
            installation_id: store.installation_id.clone(),
            jti: uuid::Uuid::new_v4().to_string(),
            kid: LICENSE_KEY_ID.into(),
            customer_name: Some("Client local".into()),
            access_role: "owner".into(),
            account_user_id: None,
            account_session_id: None,
            plan: LICENSE_PLAN.into(),
            price_chf_cents: LICENSE_PRICE_CHF_CENTS,
            issued_at: now.to_rfc3339(),
            valid_from: (today - ChronoDuration::days(1))
                .format("%Y-%m-%d")
                .to_string(),
            valid_until: (today + ChronoDuration::days(30))
                .format("%Y-%m-%d")
                .to_string(),
        };
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let token = format!(
            "{encoded}.{}",
            URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes())
        );
        (payload, token)
    }

    fn simulate_v5_license_without_protected_state(store: &LocalStore) {
        std::fs::remove_file(store.clock_anchor_path()).unwrap();
        std::fs::remove_file(store.license_installation_proof_path()).unwrap();
        store
            .connect()
            .unwrap()
            .execute_batch(
                "ALTER TABLE license_state DROP COLUMN clock_anchor_version;
                 PRAGMA user_version=5;",
            )
            .unwrap();
    }

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
            access_role: "owner".into(),
            account_user_id: None,
            account_session_id: None,
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
    fn signed_read_only_role_blocks_rust_mutations_even_offline() {
        let signing = SigningKey::from_bytes(&[31_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let (mut payload, _) = current_token(&store, &signing, "lic-read-only");
        payload.access_role = "read_only".into();
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let token = format!(
            "{encoded}.{}",
            URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes())
        );

        store.install_server_token_with_key(&token, &key).unwrap();
        let state = store.get_license_state_with_key(&key).unwrap();
        assert_eq!(state["status"], "valid");
        assert_eq!(state["access_role"], "read_only");
        assert_eq!(state["read_only"], true);
        assert!(store
            .require_write_access_with_key(&key)
            .unwrap_err()
            .to_string()
            .contains("même hors ligne"));
        assert!(store
            .require_onboarding_write_access_with_key(&key)
            .unwrap_err()
            .to_string()
            .contains("même hors ligne"));
    }

    #[test]
    fn onboarding_write_gate_allows_bootstrap_but_enforces_an_existing_license() {
        let signing = SigningKey::from_bytes(&[34_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();

        store
            .require_onboarding_write_access_with_key(&key)
            .unwrap();

        let (_payload, token) = current_token(&store, &signing, "lic-onboarding-gate");
        store.install_server_token_with_key(&token, &key).unwrap();
        store
            .require_onboarding_write_access_with_key(&key)
            .unwrap();

        store
            .mark_server_access(&token, &key, LicenseServerAccess::Inactive)
            .unwrap();
        assert!(store
            .require_onboarding_write_access_with_key(&key)
            .unwrap_err()
            .to_string()
            .contains("inactif"));

        store
            .mark_server_access(&token, &key, LicenseServerAccess::Unrecognized)
            .unwrap();
        assert!(store
            .require_onboarding_write_access_with_key(&key)
            .unwrap_err()
            .to_string()
            .contains("non reconnue"));
    }

    #[test]
    fn signed_account_identity_must_be_complete_and_well_formed() {
        let signing = SigningKey::from_bytes(&[33_u8; 32]);
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let (mut payload, _) = current_token(&store, &signing, "lic-account-binding");

        payload.account_user_id = Some("user_zentra".into());
        assert!(validate_payload(&payload).is_err());

        payload.account_session_id = Some("dss_not-a-uuid".into());
        assert!(validate_payload(&payload).is_err());

        payload.account_session_id = Some(format!("dss_{}", uuid::Uuid::new_v4()));
        assert!(validate_payload(&payload).is_ok());
    }

    #[test]
    fn legacy_signed_token_without_access_role_defaults_to_owner() {
        let signing = SigningKey::from_bytes(&[32_u8; 32]);
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let (payload, _) = current_token(&store, &signing, "lic-legacy-role");
        let mut legacy = serde_json::to_value(payload).unwrap();
        legacy.as_object_mut().unwrap().remove("access_role");
        legacy.as_object_mut().unwrap().remove("account_user_id");
        legacy.as_object_mut().unwrap().remove("account_session_id");
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&legacy).unwrap());
        let token = format!(
            "{encoded}.{}",
            URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes())
        );

        let decoded = verify_token_with_key(&token, &signing.verifying_key().to_bytes()).unwrap();
        assert_eq!(decoded.access_role, "owner");
        assert_eq!(decoded.account_user_id, None);
        assert_eq!(decoded.account_session_id, None);
        assert!(validate_payload(&decoded).is_ok());
    }

    #[test]
    fn legacy_plan_is_accepted_only_for_migration_and_refreshes_immediately() {
        let signing = SigningKey::from_bytes(&[8_u8; 32]);
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let (mut payload, _) = current_token(&store, &signing, "lic-legacy-plan");
        for legacy_plan in LEGACY_LICENSE_PLANS {
            payload.plan = (*legacy_plan).into();
            assert!(validate_payload(&payload).is_ok());
            assert!(store.refresh_is_due(&payload));
        }

        payload.plan = "another-product".into();
        assert!(validate_payload(&payload).is_err());
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
            access_role: "owner".into(),
            account_user_id: None,
            account_session_id: None,
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
            .install_server_token_with_key(&token, &signing.verifying_key().to_bytes())
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

    #[test]
    fn token_for_another_installation_reports_the_specific_error() {
        let signing = SigningKey::from_bytes(&[13_u8; 32]);
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let payload = LicenseTokenPayload {
            token_version: TOKEN_VERSION,
            license_id: "lic-wrong-installation".into(),
            installation_id: "7cd7fbdc-50f2-4a48-8214-42b5f6e67f35".into(),
            jti: "43f547b6-75d3-4aa5-8725-1f1181d1ab57".into(),
            kid: LICENSE_KEY_ID.into(),
            customer_name: Some("Client local".into()),
            access_role: "owner".into(),
            account_user_id: None,
            account_session_id: None,
            plan: LICENSE_PLAN.into(),
            price_chf_cents: LICENSE_PRICE_CHF_CENTS,
            issued_at: "2026-01-01T00:00:00Z".into(),
            valid_from: "2026-01-01".into(),
            valid_until: "2026-12-31".into(),
        };
        assert_ne!(payload.installation_id, store.installation_id);
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let token = format!(
            "{encoded}.{}",
            URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes())
        );

        let error = store
            .install_server_token_with_key(&token, &signing.verifying_key().to_bytes())
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Champ invalide : Ce jeton appartient à une autre installation Zentra."
        );
    }

    #[test]
    fn missing_or_corrupt_clock_anchor_fails_closed_until_online_refresh() {
        let signing = SigningKey::from_bytes(&[17_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let (payload, token) = current_token(&store, &signing, "lic-anchor-recovery");
        store.install_server_token_with_key(&token, &key).unwrap();
        assert_eq!(
            store.get_license_state_with_key(&key).unwrap()["status"],
            "valid"
        );

        std::fs::remove_file(store.clock_anchor_path()).unwrap();
        let missing = store.get_license_state_with_key(&key).unwrap();
        assert_eq!(missing["status"], "clock_error");
        assert_eq!(missing["read_only"], true);
        assert_eq!(missing["can_refresh"], true);
        let snapshot = store
            .prepare_license_install_snapshot(&token, &key)
            .unwrap();
        assert!(store
            .finish_online_license_installation(
                snapshot,
                &key,
                Err(AppError::Validation("réseau indisponible".into())),
            )
            .is_err());
        assert!(!store.clock_anchor_path().exists());

        assert!(store
            .persist_verified_license(&token, &payload, Some(&token), "refresh")
            .unwrap());
        assert_eq!(
            store.get_license_state_with_key(&key).unwrap()["status"],
            "valid"
        );

        std::fs::write(store.clock_anchor_path(), b"not-dpapi").unwrap();
        let corrupt = store.get_license_state_with_key(&key).unwrap();
        assert_eq!(corrupt["status"], "clock_error");
        assert!(store
            .persist_verified_license(&token, &payload, Some(&token), "refresh")
            .unwrap());
        assert_eq!(
            store.get_license_state_with_key(&key).unwrap()["status"],
            "valid"
        );
    }

    #[test]
    fn v5_same_license_stays_read_only_until_online_refresh_repairs_it() {
        let signing = SigningKey::from_bytes(&[29_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let profile = temporary.path().join("profile");
        let store = LocalStore::initialize(profile.clone()).unwrap();
        let (payload, token) = current_token(&store, &signing, "lic-v5-refresh");
        store.install_server_token_with_key(&token, &key).unwrap();

        simulate_v5_license_without_protected_state(&store);
        drop(store);

        let migrated = LocalStore::initialize(profile).unwrap();
        let marker_before: i64 = migrated
            .connect()
            .unwrap()
            .query_row(
                "SELECT clock_anchor_version FROM license_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker_before, 0);
        assert!(!migrated.clock_anchor_path().exists());

        let state = migrated.get_license_state_with_key(&key).unwrap();
        assert_eq!(state["status"], "clock_error");
        assert_eq!(state["read_only"], true);
        assert!(state["reason"]
            .as_str()
            .unwrap()
            .contains("ancienne version"));
        let failed_snapshot = migrated
            .prepare_license_install_snapshot(&token, &key)
            .unwrap();
        assert!(migrated
            .finish_online_license_installation(
                failed_snapshot,
                &key,
                Err(AppError::Validation("réseau indisponible".into())),
            )
            .is_err());
        assert!(!migrated.clock_anchor_path().exists());
        assert!(!migrated.license_installation_proof_path().exists());

        assert!(migrated
            .persist_verified_license(&token, &payload, Some(&token), "refresh")
            .unwrap());
        let refreshed = migrated.get_license_state_with_key(&key).unwrap();
        assert_eq!(refreshed["status"], "valid");
        assert_eq!(refreshed["read_only"], false);
        assert!(migrated.clock_anchor_path().is_file());
        assert!(migrated.license_installation_proof_path().is_file());
        let marker_after: i64 = migrated
            .connect()
            .unwrap()
            .query_row(
                "SELECT clock_anchor_version FROM license_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker_after, 1);
        migrated.require_write_access_with_key(&key).unwrap();
    }

    #[test]
    fn v5_snapshot_accepts_a_different_license_only_after_server_token() {
        let signing = SigningKey::from_bytes(&[31_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let profile = temporary.path().join("profile");
        let store = LocalStore::initialize(profile.clone()).unwrap();
        let (_old_payload, old_token) = current_token(&store, &signing, "lic-v5-old");
        store
            .install_server_token_with_key(&old_token, &key)
            .unwrap();
        let (_new_payload, new_token) = current_token(&store, &signing, "lic-owner-new");
        simulate_v5_license_without_protected_state(&store);
        let database_path = store.database_path.clone();
        drop(store);
        let snapshot = temporary.path().join("v5-license-snapshot.sqlite3");
        std::fs::copy(&database_path, &snapshot).unwrap();

        for attempt in 0..2 {
            if attempt == 1 {
                for suffix in ["", "-wal", "-shm"] {
                    let path = PathBuf::from(format!("{}{suffix}", database_path.display()));
                    if path.exists() {
                        std::fs::remove_file(path).unwrap();
                    }
                }
                std::fs::copy(&snapshot, &database_path).unwrap();
                for protected in [
                    profile.join(CLOCK_ANCHOR_FILE),
                    profile.join(LICENSE_INSTALLATION_PROOF_FILE),
                ] {
                    if protected.exists() {
                        std::fs::remove_file(protected).unwrap();
                    }
                }
            }
            let migrated = LocalStore::initialize(profile.clone()).unwrap();
            let candidate = migrated
                .prepare_license_install_snapshot(&new_token, &key)
                .unwrap();
            assert!(!migrated.clock_anchor_path().exists());
            migrated
                .finish_online_license_installation(
                    candidate,
                    &key,
                    Ok(LicenseRefreshOutcome::Token(new_token.clone())),
                )
                .unwrap();
            let stored: (String, i64) = migrated
                .connect()
                .unwrap()
                .query_row(
                    "SELECT license_id,clock_anchor_version FROM license_state WHERE id=1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(stored, ("lic-owner-new".into(), 1));
            assert!(migrated.clock_anchor_path().is_file());
            assert!(migrated.license_installation_proof_path().is_file());
            drop(migrated);
        }
    }

    #[test]
    fn reset_marker_and_anchor_change_only_after_a_server_token() {
        let signing = SigningKey::from_bytes(&[33_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let (_payload, token) = current_token(&store, &signing, "lic-marker-reset");
        store.install_server_token_with_key(&token, &key).unwrap();
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE license_state SET clock_anchor_version=0 WHERE id=1",
                [],
            )
            .unwrap();
        std::fs::remove_file(store.clock_anchor_path()).unwrap();

        let state = store.get_license_state_with_key(&key).unwrap();
        assert_eq!(state["status"], "clock_error");
        assert_eq!(state["read_only"], true);
        let failed = store
            .prepare_license_install_snapshot(&token, &key)
            .unwrap();
        assert!(store
            .finish_online_license_installation(
                failed,
                &key,
                Err(AppError::Validation("réseau indisponible".into())),
            )
            .is_err());
        let marker_before_server: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT clock_anchor_version FROM license_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker_before_server, 0);
        assert!(!store.clock_anchor_path().exists());

        store.install_server_token_with_key(&token, &key).unwrap();
        let marker_after_server: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT clock_anchor_version FROM license_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker_after_server, 1);
        assert!(store.clock_anchor_path().is_file());
    }

    #[test]
    fn used_profile_without_license_row_accepts_only_a_server_token() {
        let signing = SigningKey::from_bytes(&[35_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let (_payload, token) = current_token(&store, &signing, "lic-row-deleted");
        store.install_server_token_with_key(&token, &key).unwrap();
        store
            .connect()
            .unwrap()
            .execute_batch(
                "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at)
                   VALUES(1,1,'Entreprise existante','2026-09-01','2026-09-01');
                 DELETE FROM license_state;",
            )
            .unwrap();
        std::fs::remove_file(store.clock_anchor_path()).unwrap();
        std::fs::remove_file(store.license_installation_proof_path()).unwrap();

        let candidate = store
            .prepare_license_install_snapshot(&token, &key)
            .unwrap();
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM license_state", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        store
            .finish_online_license_installation(
                candidate,
                &key,
                Ok(LicenseRefreshOutcome::Token(token)),
            )
            .unwrap();
        let stored: (i64, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*),MAX(clock_anchor_version) FROM license_state",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored, (1, 1));
        assert!(store.clock_anchor_path().is_file());
        assert!(store.license_installation_proof_path().is_file());
    }

    #[test]
    fn reset_database_is_reactivated_only_by_a_server_token() {
        let signing = SigningKey::from_bytes(&[37_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let profile = temporary.path().join("profile");
        let store = LocalStore::initialize(profile.clone()).unwrap();
        let (_payload, token) = current_token(&store, &signing, "lic-db-reset");
        store.install_server_token_with_key(&token, &key).unwrap();
        let database_path = store.database_path.clone();
        drop(store);
        std::fs::remove_file(&database_path).unwrap();
        for suffix in ["-wal", "-shm"] {
            let sidecar = PathBuf::from(format!("{}{suffix}", database_path.display()));
            if sidecar.exists() {
                std::fs::remove_file(sidecar).unwrap();
            }
        }

        let reset = LocalStore::initialize(profile).unwrap();
        assert!(reset.license_installation_proof_path().is_file());
        let candidate = reset
            .prepare_license_install_snapshot(&token, &key)
            .unwrap();
        assert_eq!(
            reset
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM license_state", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        reset
            .finish_online_license_installation(
                candidate,
                &key,
                Ok(LicenseRefreshOutcome::Token(token)),
            )
            .unwrap();
        assert_eq!(
            reset
                .connect()
                .unwrap()
                .query_row(
                    "SELECT clock_anchor_version FROM license_state",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn pristine_network_failure_and_unrecognized_token_write_nothing() {
        let signing = SigningKey::from_bytes(&[39_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let (_payload, token) = current_token(&store, &signing, "lic-no-server-write");

        let offline_snapshot = store
            .prepare_license_install_snapshot(&token, &key)
            .unwrap();
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM license_state", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let network_error = store
            .finish_online_license_installation(
                offline_snapshot,
                &key,
                Err(AppError::Validation("réseau indisponible".into())),
            )
            .unwrap_err();
        assert!(network_error.to_string().contains("réseau indisponible"));

        let unrecognized_snapshot = store
            .prepare_license_install_snapshot(&token, &key)
            .unwrap();
        let unrecognized = store
            .finish_online_license_installation(
                unrecognized_snapshot,
                &key,
                Ok(LicenseRefreshOutcome::Unrecognized),
            )
            .unwrap_err();
        assert!(unrecognized.to_string().contains("ne reconnaît pas"));

        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM license_state", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(!store.clock_anchor_path().exists());
        assert!(!store.license_installation_proof_path().exists());
    }

    #[test]
    fn absent_install_snapshot_cannot_overwrite_a_concurrent_server_install() {
        let signing = SigningKey::from_bytes(&[41_u8; 32]);
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let (first_payload, first_token) = current_token(&store, &signing, "lic-first");
        let (second_payload, second_token) = current_token(&store, &signing, "lic-second");

        assert!(store
            .persist_verified_license(&first_token, &first_payload, None, "install_online")
            .unwrap());
        assert!(!store
            .persist_verified_license(&second_token, &second_payload, None, "install_online")
            .unwrap());

        let stored: String = store
            .connect()
            .unwrap()
            .query_row("SELECT token FROM license_state WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(stored, first_token);
    }

    #[test]
    fn server_token_on_a_pristine_profile_creates_proof_anchor_and_marker() {
        let signing = SigningKey::from_bytes(&[39_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        assert!(!store.license_installation_proof_path().exists());
        let (_payload, token) = current_token(&store, &signing, "lic-first-install");

        let snapshot = store
            .prepare_license_install_snapshot(&token, &key)
            .unwrap();
        store
            .finish_online_license_installation(
                snapshot,
                &key,
                Ok(LicenseRefreshOutcome::Token(token)),
            )
            .unwrap();

        assert!(store.license_installation_proof_path().is_file());
        assert!(store.clock_anchor_path().is_file());
        let marker: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT clock_anchor_version FROM license_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker, 1);
        assert_eq!(
            store.get_license_state_with_key(&key).unwrap()["status"],
            "valid"
        );
    }

    #[test]
    fn sqlite_last_seen_cannot_bypass_the_dpapi_clock_anchor() {
        let signing = SigningKey::from_bytes(&[19_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let (_payload, token) = current_token(&store, &signing, "lic-clock-rollback");
        store.install_server_token_with_key(&token, &key).unwrap();

        let tomorrow_utc = Utc::now() + ChronoDuration::days(1);
        let tomorrow_date = Local::now().date_naive() + ChronoDuration::days(1);
        let mut anchor = store.load_clock_anchor().unwrap().unwrap();
        anchor.max_seen_utc = tomorrow_utc.to_rfc3339();
        anchor.max_seen_date = tomorrow_date.format("%Y-%m-%d").to_string();
        store.write_clock_anchor(&anchor).unwrap();
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE license_state SET last_seen_date='2000-01-01' WHERE id=1",
                [],
            )
            .unwrap();

        let state = store.get_license_state_with_key(&key).unwrap();
        assert_eq!(state["status"], "clock_error");
        assert_eq!(state["read_only"], true);
        assert!(store.require_write_access_with_key(&key).is_err());
    }

    #[test]
    fn active_server_token_can_reactivate_an_inactive_local_state() {
        let signing = SigningKey::from_bytes(&[23_u8; 32]);
        let key = signing.verifying_key().to_bytes();
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let (_payload, token) = current_token(&store, &signing, "lic-inactive");
        store.install_server_token_with_key(&token, &key).unwrap();
        store
            .mark_server_access(&token, &key, LicenseServerAccess::Inactive)
            .unwrap();
        assert_eq!(
            store.get_license_state_with_key(&key).unwrap()["status"],
            "inactive"
        );

        store.install_server_token_with_key(&token, &key).unwrap();
        let state = store.get_license_state_with_key(&key).unwrap();
        assert_eq!(state["status"], "valid");
        assert_eq!(state["read_only"], false);
    }

    #[test]
    fn automatic_refresh_is_persistently_limited_to_once_per_day() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let now = Utc::now();
        assert!(store.claim_automatic_refresh("lic-rate", now).unwrap());
        assert!(!store
            .claim_automatic_refresh("lic-rate", now + ChronoDuration::hours(23))
            .unwrap());
        assert!(store
            .claim_automatic_refresh("lic-rate", now + ChronoDuration::hours(24))
            .unwrap());
    }

    #[test]
    fn refresh_endpoint_is_an_exact_immutable_https_url() {
        let endpoint = validated_refresh_endpoint().unwrap();
        assert_eq!(endpoint.as_str(), LICENSE_REFRESH_ENDPOINT);
        assert_eq!(endpoint.host_str(), Some("elyko.alb-leart1.chatgpt.site"));
        assert_eq!(endpoint.path(), "/api/stripe/refresh");
        assert!(endpoint.query().is_none());
    }

    #[test]
    #[ignore = "contacte volontairement l’endpoint public; à exécuter dans le contrôle release Windows"]
    fn live_https_refresh_client_has_a_working_rustls_provider() {
        let invalid_but_bounded_token = "A".repeat(128);
        let result =
            tauri::async_runtime::block_on(request_refreshed_license(&invalid_but_bounded_token));
        match result {
            Err(error)
                if error.to_string().contains("400 Bad Request")
                    || error.to_string().contains("404 Not Found") =>
            {
                // Prouve la négociation TLS sur un déploiement où la nouvelle
                // route n'a pas encore été publiée (404) ou refuse correctement
                // le faux jeton sans altérer le bail local (400).
            }
            Ok(_) => panic!("un faux jeton ne doit jamais produire un bail"),
            Err(error) => panic!(
                "la requête HTTPS doit atteindre le serveur sans erreur de CryptoProvider: {error}"
            ),
        }
    }
}
