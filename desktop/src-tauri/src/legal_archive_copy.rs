//! Second support de l'archive légale (GeBüV) : l'archive annuelle est
//! chiffrée sur l'appareil (ChaCha20-Poly1305, blocs de 1 Mio authentifiés,
//! dernier bloc marqué contre la troncature), puis envoyée par blocs au coffre
//! Zentra (R2). La clé est créée sur l'appareil, gardée dans le stockage
//! protégé du système et donnée une fois à l'utilisateur comme clé de
//! récupération. Le serveur ne reçoit que le chiffré et l'empreinte de la clé.

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use reqwest::Method;
use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305},
    rand::{SecureRandom, SystemRandom},
};
use rusqlite::{OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::State;
use uuid::Uuid;

use crate::{
    account_cloud::{project_sync_session, ProjectSyncSession},
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
    installation::{read_protected_reference, unprotect_protected_reference, write_protected_atomically_with_reference},
};

pub(crate) const PATH: &str = "/api/account/legal-archive-copy";
pub(crate) const CHUNK_PATH: &str = "/api/account/legal-archive-copy/chunk";
const MAGIC: &[u8; 8] = b"ZGEBUV01";
const SEGMENT: usize = 1024 * 1024;
const TAG: usize = 16;
const UPLOAD_CHUNK: usize = 8 * 1024 * 1024;
const MAX_CHUNKS: usize = 128;

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------- Clé et clé de récupération ----------

const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// 32 octets → 52 caractères base32 groupés par quatre : « ABCD-EFGH-… ».
pub(crate) fn recovery_code(key: &[u8; 32]) -> String {
    let mut out = String::new();
    let (mut buffer, mut bits) = (0_u32, 0_u32);
    for byte in key {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            out.push(ALPHABET[((buffer >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out.as_bytes().chunks(4).map(|group| String::from_utf8_lossy(group).into_owned()).collect::<Vec<_>>().join("-")
}

pub(crate) fn key_from_recovery_code(code: &str) -> AppResult<[u8; 32]> {
    let clean: Vec<u8> = code.bytes().filter(|byte| !matches!(byte, b'-' | b' ')).map(|byte| byte.to_ascii_uppercase()).collect();
    if clean.len() != 52 {
        return Err(invalid("La clé de récupération doit compter 52 caractères."));
    }
    let mut out = Vec::with_capacity(33);
    let (mut buffer, mut bits) = (0_u32, 0_u32);
    for byte in clean {
        let value = ALPHABET.iter().position(|letter| *letter == byte).ok_or_else(|| invalid("La clé de récupération contient un caractère inconnu."))? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            out.push(((buffer >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    out.truncate(32);
    out.try_into().map_err(|_| invalid("La clé de récupération est illisible."))
}

pub(crate) fn key_id(key: &[u8; 32]) -> String {
    hex(&Sha256::digest([b"zentra-gebuv-key-v1".as_slice(), key.as_slice()].concat()))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredKey {
    organization_id: String,
    key_hex: String,
    created_at: String,
}

fn key_path(store: &LocalStore, organization: &str) -> PathBuf {
    let safe: String = organization.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')).take(80).collect();
    store.data_dir.join(format!("legal-archive-key-{safe}.protected"))
}

fn read_key(store: &LocalStore, organization: &str) -> AppResult<Option<[u8; 32]>> {
    let path = key_path(store, organization);
    if !path.is_file() {
        return Ok(None);
    }
    let stored: StoredKey = serde_json::from_slice(&unprotect_protected_reference(&read_protected_reference(&path)?)?)?;
    if stored.organization_id != organization || stored.key_hex.len() != 64 {
        return Err(invalid("La clé de l'archive enregistrée sur cet appareil est illisible."));
    }
    let mut key = [0_u8; 32];
    for (index, slot) in key.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&stored.key_hex[index * 2..index * 2 + 2], 16).map_err(|_| invalid("La clé de l'archive est illisible."))?;
    }
    Ok(Some(key))
}

fn save_key(store: &LocalStore, organization: &str, key: &[u8; 32]) -> AppResult<()> {
    let stored = StoredKey { organization_id: organization.into(), key_hex: hex(key), created_at: now_iso() };
    write_protected_atomically_with_reference(&key_path(store, organization), &serde_json::to_vec(&stored)?)?;
    Ok(())
}

fn load_or_create_key(store: &LocalStore, organization: &str) -> AppResult<([u8; 32], bool)> {
    if let Some(key) = read_key(store, organization)? {
        return Ok((key, false));
    }
    let mut key = [0_u8; 32];
    SystemRandom::new().fill(&mut key).map_err(|_| invalid("Le générateur aléatoire du système est indisponible."))?;
    save_key(store, organization, &key)?;
    Ok((key, true))
}

// ---------- Chiffrement par blocs ----------

fn aead(key: &[u8; 32]) -> AppResult<LessSafeKey> {
    Ok(LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, key).map_err(|_| invalid("Clé de chiffrement invalide."))?))
}

fn nonce(base: &[u8; 8], counter: u32) -> Nonce {
    let mut bytes = [0_u8; 12];
    bytes[..8].copy_from_slice(base);
    bytes[8..].copy_from_slice(&counter.to_be_bytes());
    Nonce::assume_unique_for_key(bytes)
}

fn aad(base: &[u8; 8], counter: u32, last: bool) -> Vec<u8> {
    [MAGIC.as_slice(), base.as_slice(), &counter.to_be_bytes(), &[u8::from(last)]].concat()
}

/// Lit `source` et écrit le chiffré dans `target`. La base du nonce dérive de
/// la clé et de l'empreinte du clair : un même fichier donne le même chiffré
/// (envoi rejouable), deux fichiers différents n'ont jamais le même nonce.
pub(crate) fn encrypt_file(key: &[u8; 32], plain_sha256: &str, source: &Path, target: &Path) -> AppResult<()> {
    let sealing = aead(key)?;
    let digest = Sha256::digest([key_id(key).as_bytes(), plain_sha256.as_bytes()].concat());
    let mut base = [0_u8; 8];
    base.copy_from_slice(&digest[..8]);
    let size = fs::metadata(source)?.len() as usize;
    let mut input = File::open(source)?;
    let mut output = File::create(target)?;
    output.write_all(MAGIC)?;
    output.write_all(&base)?;
    let segments = size.div_ceil(SEGMENT).max(1);
    for counter in 0..segments {
        let length = SEGMENT.min(size - counter * SEGMENT);
        let mut buffer = vec![0_u8; length];
        input.read_exact(&mut buffer)?;
        let last = counter + 1 == segments;
        sealing
            .seal_in_place_append_tag(nonce(&base, counter as u32), Aad::from(aad(&base, counter as u32, last)), &mut buffer)
            .map_err(|_| invalid("Le chiffrement de l'archive a échoué."))?;
        output.write_all(&buffer)?;
    }
    output.sync_all()?;
    Ok(())
}

pub(crate) fn decrypt_file(key: &[u8; 32], source: &Path, target: &Path) -> AppResult<String> {
    let opening = aead(key)?;
    let size = fs::metadata(source)?.len() as usize;
    if size < 16 + TAG {
        return Err(invalid("La copie chiffrée est incomplète."));
    }
    let mut input = File::open(source)?;
    let mut header = [0_u8; 16];
    input.read_exact(&mut header)?;
    if &header[..8] != MAGIC {
        return Err(invalid("Ce fichier n'est pas une copie chiffrée d'archive Zentra."));
    }
    let mut base = [0_u8; 8];
    base.copy_from_slice(&header[8..]);
    let body = size - 16;
    let segments = body.div_ceil(SEGMENT + TAG);
    let mut output = File::create(target)?;
    let mut hasher = Sha256::new();
    for counter in 0..segments {
        let length = (SEGMENT + TAG).min(body - counter * (SEGMENT + TAG));
        let mut buffer = vec![0_u8; length];
        input.read_exact(&mut buffer)?;
        let last = counter + 1 == segments;
        let plain = opening
            .open_in_place(nonce(&base, counter as u32), Aad::from(aad(&base, counter as u32, last)), &mut buffer)
            .map_err(|_| invalid("La clé ne correspond pas à cette copie, ou la copie a été altérée."))?;
        hasher.update(&*plain);
        output.write_all(plain)?;
    }
    output.sync_all()?;
    Ok(hex(&hasher.finalize()))
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Identifiant stable d'une copie : même entreprise, même archive, même clé.
fn copy_id(organization: &str, plain_sha256: &str, key: &str) -> String {
    let digest = Sha256::digest(format!("zentra-gebuv-copy-v1\n{organization}\n{plain_sha256}\n{key}"));
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

// ---------- Coffre (serveur) ----------

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteCopy {
    pub copy_id: String,
    pub year: i64,
    pub file_name: String,
    pub plain_sha256: String,
    pub cipher_sha256: String,
    pub size_bytes: u64,
    pub chunk_count: u64,
    pub key_id: String,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CopyList {
    copies: Vec<RemoteCopy>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CopyReply {
    copy: RemoteCopy,
}

async fn session(store: &LocalStore) -> AppResult<ProjectSyncSession> {
    project_sync_session(store)
        .await?
        .ok_or_else(|| invalid("Connectez ce poste au compte Zentra de l'entreprise pour utiliser le coffre des archives."))
}

async fn remote_copies(session: &ProjectSyncSession) -> AppResult<Vec<RemoteCopy>> {
    let (_, bytes) = session.request(Method::GET, PATH, &[], &[], None, false).await?;
    Ok(serde_json::from_slice::<CopyList>(&bytes).map_err(|_| invalid("La liste du coffre est illisible."))?.copies)
}

struct Prepared {
    year: i64,
    file_name: String,
    plain_sha256: String,
    encrypted: tempfile::NamedTempFile,
}

fn prepare(store: &LocalStore, archive_id: &str, key: &[u8; 32]) -> AppResult<Prepared> {
    let connection = store.connect()?;
    store.require_onboarding(&connection)?;
    let row: Option<(i64, String, String)> = connection
        .query_row("SELECT year,file_name,sha256 FROM company_local_legal_archives WHERE id=?", [archive_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()?;
    drop(connection);
    let (year, file_name, plain_sha256) = row.ok_or_else(|| invalid("Cette archive est introuvable."))?;
    if file_name.contains(['/', '\\']) || !file_name.to_ascii_lowercase().ends_with(".zip") {
        return Err(invalid("Le nom de l'archive est invalide."));
    }
    let path = store.exports_dir.join("archive-legale").join(&file_name);
    if !path.is_file() {
        return Err(invalid("Le fichier de l'archive manque sur cet appareil : restaurez-le avant d'en faire une copie."));
    }
    if sha256_file(&path)? != plain_sha256 {
        return Err(invalid("L'archive a changé depuis sa création : vérifiez-la avant d'en faire une copie."));
    }
    let encrypted = tempfile::Builder::new().prefix("gebuv-").suffix(".enc").tempfile_in(&store.exports_dir)?;
    encrypt_file(key, &plain_sha256, &path, encrypted.path())?;
    Ok(Prepared { year, file_name, plain_sha256, encrypted })
}

fn record(store: &LocalStore, action: &str, payload: &Value) -> AppResult<()> {
    let _guard = store.lock()?;
    let mut connection = store.connect()?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    append_audit(&tx, action, "legal_archive_copy", payload["copy_id"].as_str().unwrap_or("vault"), payload)?;
    tx.commit()?;
    Ok(())
}

async fn blocking<T: Send + 'static>(operation: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(operation).await.map_err(|_| AppError::Remote("L'opération a été interrompue.".into()))?
}

#[tauri::command]
pub async fn list_legal_archive_copies(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    let result: AppResult<Value> = async move {
        let session = session(&store).await?;
        let copies = remote_copies(&session).await?;
        let organization = session.organization_id.clone();
        let local = blocking({ let store = store.clone(); move || read_key(&store, &organization) }).await?;
        Ok(json!({ "copies": copies, "local_key_id": local.map(|key| key_id(&key)) }))
    }
    .await;
    result.map_err(command_error)
}

/// La clé de récupération de l'entreprise, créée au premier besoin.
#[tauri::command]
pub async fn legal_archive_recovery_code(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    let result: AppResult<Value> = async move {
        let session = session(&store).await?;
        let organization = session.organization_id.clone();
        let (key, created) = blocking({ let store = store.clone(); move || load_or_create_key(&store, &organization) }).await?;
        Ok(json!({ "code": recovery_code(&key), "key_id": key_id(&key), "created": created }))
    }
    .await;
    result.map_err(command_error)
}

#[tauri::command]
pub async fn copy_legal_archive_to_vault(state: State<'_, LocalStore>, archive_id: String) -> Result<Value, String> {
    let store = state.inner().clone();
    let result: AppResult<Value> = async move {
        let session = session(&store).await?;
        if session.role == "read_only" {
            return Err(invalid("Votre rôle ne permet pas d'envoyer une archive au coffre."));
        }
        let organization = session.organization_id.clone();
        let (key, _) = blocking({ let store = store.clone(); let organization = organization.clone(); move || load_or_create_key(&store, &organization) }).await?;
        let prepared = blocking({ let store = store.clone(); move || prepare(&store, &archive_id, &key) }).await?;
        let bytes = fs::read(prepared.encrypted.path())?;
        let chunks: Vec<&[u8]> = bytes.chunks(UPLOAD_CHUNK).collect();
        if chunks.len() > MAX_CHUNKS {
            return Err(invalid("L'archive dépasse la taille acceptée par le coffre (1 Go)."));
        }
        let id = copy_id(&organization, &prepared.plain_sha256, &key_id(&key));
        let begin = json!({
            "copy_id": id,
            "year": prepared.year,
            "file_name": prepared.file_name,
            "plain_sha256": prepared.plain_sha256,
            "cipher_sha256": hex(&Sha256::digest(&bytes)),
            "key_id": key_id(&key),
            "chunks": chunks.iter().map(|chunk| json!({"sha256": hex(&Sha256::digest(chunk)), "size_bytes": chunk.len()})).collect::<Vec<_>>(),
        });
        let (_, reply) = session.request(Method::POST, PATH, &[], &[("Content-Type", "application/json".into())], Some(serde_json::to_vec(&begin)?), false).await?;
        let mut copy = serde_json::from_slice::<CopyReply>(&reply).map_err(|_| invalid("La réponse du coffre est illisible."))?.copy;
        if copy.completed_at.is_none() {
            for (index, chunk) in chunks.iter().enumerate() {
                let index = index.to_string();
                let (_, reply) = session
                    .request(Method::PUT, CHUNK_PATH, &[("id", id.as_str()), ("index", index.as_str())], &[("Content-Type", "application/octet-stream".into())], Some(chunk.to_vec()), false)
                    .await?;
                copy = serde_json::from_slice::<CopyReply>(&reply).map_err(|_| invalid("La réponse du coffre est illisible."))?.copy;
            }
        }
        if copy.completed_at.is_none() || copy.copy_id != id {
            return Err(invalid("Le coffre n'a pas confirmé la copie complète. Réessayez : les blocs déjà reçus sont gardés."));
        }
        let result = serde_json::to_value(&copy)?;
        blocking({ let store = store.clone(); let result = result.clone(); move || record(&store, "copy", &result) }).await?;
        Ok(result)
    }
    .await;
    result.map_err(command_error)
}

#[tauri::command]
pub async fn restore_legal_archive_copy(state: State<'_, LocalStore>, copy_id: String, destination: String, recovery_code: Option<String>) -> Result<Value, String> {
    let store = state.inner().clone();
    let result: AppResult<Value> = async move {
        let destination = PathBuf::from(destination.trim());
        if !destination.is_absolute() || destination.extension().and_then(|value| value.to_str()).is_none_or(|value| !value.eq_ignore_ascii_case("zip")) || destination.exists() {
            return Err(invalid("Choisissez un nouveau fichier .zip pour l'archive récupérée."));
        }
        let session = session(&store).await?;
        let organization = session.organization_id.clone();
        let copy = remote_copies(&session).await?.into_iter().find(|copy| copy.copy_id == copy_id && copy.completed_at.is_some()).ok_or_else(|| invalid("Cette copie est introuvable ou incomplète dans le coffre."))?;
        let key = match recovery_code.as_deref().map(str::trim).filter(|code| !code.is_empty()) {
            Some(code) => key_from_recovery_code(code)?,
            None => blocking({ let store = store.clone(); let organization = organization.clone(); move || read_key(&store, &organization) })
                .await?
                .ok_or_else(|| invalid("La clé de cette entreprise n'est pas sur cet appareil. Saisissez la clé de récupération."))?,
        };
        if key_id(&key) != copy.key_id {
            return Err(invalid("Cette clé ne correspond pas à la copie. Vérifiez la clé de récupération."));
        }
        let encrypted = tempfile::Builder::new().prefix("gebuv-").suffix(".enc").tempfile_in(&store.exports_dir)?;
        {
            let mut output = File::create(encrypted.path())?;
            for index in 0..copy.chunk_count {
                let index = index.to_string();
                let (_, bytes) = session.request(Method::GET, CHUNK_PATH, &[("id", copy.copy_id.as_str()), ("index", index.as_str())], &[], None, true).await?;
                output.write_all(&bytes)?;
            }
            output.sync_all()?;
        }
        let cipher_path = encrypted.path().to_path_buf();
        let target = destination.clone();
        let expected = copy.plain_sha256.clone();
        let cipher = copy.cipher_sha256.clone();
        let restored = blocking(move || {
            if sha256_file(&cipher_path)? != cipher {
                return Err(invalid("La copie téléchargée est incomplète ou altérée."));
            }
            let plain = decrypt_file(&key, &cipher_path, &target)?;
            if plain != expected {
                let _ = fs::remove_file(&target);
                return Err(invalid("L'archive déchiffrée ne correspond pas à son empreinte."));
            }
            Ok(plain)
        })
        .await?;
        // La clé saisie devient celle de cet appareil pour les prochaines copies.
        if recovery_code.is_some() {
            blocking({ let store = store.clone(); move || save_key(&store, &organization, &key) }).await?;
        }
        let payload = json!({ "copy_id": copy.copy_id, "year": copy.year, "sha256": restored, "path": destination.to_string_lossy() });
        blocking({ let store = store.clone(); let payload = payload.clone(); move || record(&store, "restore", &payload) }).await?;
        Ok(payload)
    }
    .await;
    result.map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_recovery_code_round_trips_and_rejects_typos() {
        let mut key = [0_u8; 32];
        for (index, byte) in key.iter_mut().enumerate() {
            *byte = (index * 7 + 3) as u8;
        }
        let code = recovery_code(&key);
        assert_eq!(code.replace('-', "").len(), 52);
        assert_eq!(key_from_recovery_code(&code).unwrap(), key);
        assert_eq!(key_from_recovery_code(&code.to_lowercase().replace('-', " ")).unwrap(), key);
        assert!(key_from_recovery_code("ABCD").is_err());
        assert!(key_from_recovery_code(&code.replace('A', "1")).is_err() || !code.contains('A'));
        assert_eq!(key_id(&key).len(), 64);
    }

    #[test]
    fn encryption_is_authenticated_deterministic_and_detects_truncation() {
        let temporary = tempfile::tempdir().unwrap();
        let plain_path = temporary.path().join("archive.zip");
        let plain: Vec<u8> = (0..(SEGMENT * 2 + 1234)).map(|index| (index % 251) as u8).collect();
        fs::write(&plain_path, &plain).unwrap();
        let plain_sha = sha256_file(&plain_path).unwrap();
        let key = [9_u8; 32];
        let first = temporary.path().join("a.enc");
        let second = temporary.path().join("b.enc");
        encrypt_file(&key, &plain_sha, &plain_path, &first).unwrap();
        encrypt_file(&key, &plain_sha, &plain_path, &second).unwrap();
        assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
        assert_eq!(fs::metadata(&first).unwrap().len() as usize, 16 + plain.len() + 3 * TAG);
        assert!(!fs::read(&first).unwrap().windows(64).any(|window| window == &plain[..64]));
        let restored = temporary.path().join("restored.zip");
        assert_eq!(decrypt_file(&key, &first, &restored).unwrap(), plain_sha);
        assert_eq!(fs::read(&restored).unwrap(), plain);
        // Mauvaise clé, octet modifié ou dernier bloc retiré : refusés.
        assert!(decrypt_file(&[1_u8; 32], &first, &temporary.path().join("x.zip")).is_err());
        let mut tampered = fs::read(&first).unwrap();
        tampered[100] ^= 1;
        fs::write(&second, &tampered).unwrap();
        assert!(decrypt_file(&key, &second, &temporary.path().join("y.zip")).is_err());
        let mut truncated = fs::read(&first).unwrap();
        truncated.truncate(16 + 2 * (SEGMENT + TAG));
        fs::write(&second, &truncated).unwrap();
        assert!(decrypt_file(&key, &second, &temporary.path().join("z.zip")).is_err());
    }

    #[test]
    fn the_copy_id_is_a_stable_v4_uuid() {
        let id = copy_id("org_a", &"a".repeat(64), &"b".repeat(64));
        assert_eq!(id, copy_id("org_a", &"a".repeat(64), &"b".repeat(64)));
        assert_ne!(id, copy_id("org_b", &"a".repeat(64), &"b".repeat(64)));
        assert_eq!(Uuid::parse_str(&id).unwrap().get_version_num(), 4);
    }

    #[test]
    fn the_vault_replies_are_read_strictly() {
        let copy = r#"{"copy_id":"0b5f6c1e-2d8a-4c3b-9f1e-7a2b3c4d5e6f","year":2025,"file_name":"a.zip","plain_sha256":"a","cipher_sha256":"b","size_bytes":10,"chunk_count":1,"key_id":"c","created_at":1,"completed_at":null}"#;
        assert!(serde_json::from_str::<CopyReply>(&format!(r#"{{"copy":{copy}}}"#)).is_ok());
        assert!(serde_json::from_str::<CopyList>(&format!(r#"{{"copies":[{copy}]}}"#)).is_ok());
        assert!(serde_json::from_str::<CopyReply>(&format!(r#"{{"copy":{copy},"key":"x"}}"#)).is_err());
    }
}
