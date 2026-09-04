use std::{
    fmt,
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::Path,
    sync::{Arc, Mutex},
};

use uuid::{Uuid, Version};

use crate::error::{AppError, AppResult};

#[cfg(windows)]
const IDENTITY_FILE: &str = "installation-identity.dpapi";
#[cfg(not(windows))]
const IDENTITY_FILE: &str = "installation-identity.protected";
const MAX_PROTECTED_BYTES: usize = 64 * 1024;

#[cfg(target_os = "macos")]
const MACOS_KEYCHAIN_SERVICE: &str = "ch.zentra.desktop.protected-data";
#[cfg(target_os = "macos")]
const MACOS_KEYCHAIN_MARKER: &str = "zentra-keychain-v1:";

/// Cache de session d'une valeur déverrouillée du coffre système. Il n'est
/// actif qu'à la compilation macOS : DPAPI ne présente pas de dialogue sous
/// Windows et n'a pas besoin de prolonger la durée de vie du secret en RAM.
#[derive(Clone)]
pub(crate) struct ProtectedDataCache {
    record: Arc<Mutex<Option<CachedProtectedData>>>,
    enabled: bool,
}

#[derive(Clone)]
struct CachedProtectedData {
    protected_reference: Vec<u8>,
    clear: Vec<u8>,
}

impl Default for ProtectedDataCache {
    fn default() -> Self {
        Self {
            record: Arc::new(Mutex::new(None)),
            enabled: cfg!(target_os = "macos"),
        }
    }
}

impl fmt::Debug for ProtectedDataCache {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProtectedDataCache(<redacted>)")
    }
}

impl ProtectedDataCache {
    #[cfg(test)]
    pub(crate) fn enabled_for_test() -> Self {
        Self {
            record: Arc::new(Mutex::new(None)),
            enabled: true,
        }
    }

    pub(crate) fn get_or_try_init<F>(
        &self,
        protected_reference: &[u8],
        load: F,
    ) -> AppResult<Vec<u8>>
    where
        F: FnOnce() -> AppResult<Vec<u8>>,
    {
        if !self.enabled {
            return load();
        }
        // Garder le verrou pendant le premier accès évite que deux commandes
        // concurrentes affichent chacune une demande Keychain.
        let mut cached = self.record.lock().map_err(|_| cache_unavailable())?;
        if let Some(cached) = cached
            .as_ref()
            .filter(|cached| cached.protected_reference == protected_reference)
        {
            return Ok(cached.clear.clone());
        }

        // Une autre référence désigne une autre génération. Invalider
        // l'ancienne avant de tenter le déverrouillage garantit qu'un échec
        // sur la nouvelle génération ne permet jamais de ressusciter ensuite
        // l'ancien secret depuis la RAM.
        *cached = None;
        let clear = load()?;
        *cached = Some(CachedProtectedData {
            protected_reference: protected_reference.to_vec(),
            clear: clear.clone(),
        });
        Ok(clear)
    }

    pub(crate) fn replace(&self, protected_reference: Vec<u8>, clear: &[u8]) -> AppResult<()> {
        if !self.enabled {
            return Ok(());
        }
        let mut cached = self.record.lock().map_err(|_| cache_unavailable())?;
        *cached = Some(CachedProtectedData {
            protected_reference,
            clear: clear.to_vec(),
        });
        Ok(())
    }

    pub(crate) fn clear(&self) -> AppResult<()> {
        if !self.enabled {
            return Ok(());
        }
        *self.record.lock().map_err(|_| cache_unavailable())? = None;
        Ok(())
    }

    /// Après l'échec d'une écriture, ne conserve une valeur déverrouillée
    /// que si sa propre référence est toujours exactement celle du disque.
    pub(crate) fn retain_only_for_reference(
        &self,
        current_reference: Option<&[u8]>,
    ) -> AppResult<()> {
        if !self.enabled {
            return Ok(());
        }
        let mut cached = self.record.lock().map_err(|_| cache_unavailable())?;
        let still_current = cached.as_ref().is_some_and(|cached| {
            current_reference.is_some_and(|reference| cached.protected_reference == reference)
        });
        if !still_current {
            *cached = None;
        }
        Ok(())
    }
}

fn cache_unavailable() -> AppError {
    AppError::Validation(
        "Le cache en mémoire des données protégées est indisponible. Redémarrez Zentra.".into(),
    )
}

pub fn load_or_create(data_dir: &Path) -> AppResult<String> {
    let path = data_dir.join(IDENTITY_FILE);
    match fs::read(&path) {
        Ok(protected) => parse_identity(&unprotect_for_current_user(&protected)?),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let identity = Uuid::new_v4().to_string();
            let protected = protect_for_current_user(identity.as_bytes())?;
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    if let Err(error) = file.write_all(&protected).and_then(|_| file.sync_all()) {
                        forget_protected(&protected);
                        let _ = fs::remove_file(&path);
                        return Err(error.into());
                    }
                    Ok(identity)
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    forget_protected(&protected);
                    parse_identity(&unprotect_for_current_user(&fs::read(path)?)?)
                }
                Err(error) => {
                    forget_protected(&protected);
                    Err(error.into())
                }
            }
        }
        Err(error) => Err(error.into()),
    }
}

fn parse_identity(bytes: &[u8]) -> AppResult<String> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        AppError::Validation("L’identité protégée de cette installation est illisible.".into())
    })?;
    let uuid = Uuid::parse_str(text).map_err(|_| {
        AppError::Validation("L’identité protégée de cette installation est invalide.".into())
    })?;
    if uuid.get_version() != Some(Version::Random) {
        return Err(AppError::Validation(
            "L’identité protégée doit être un UUID aléatoire v4.".into(),
        ));
    }
    Ok(uuid.to_string())
}

#[cfg(test)]
pub(crate) fn write_protected_atomically(path: &Path, clear: &[u8]) -> AppResult<()> {
    write_protected_atomically_with_reference(path, clear).map(|_| ())
}

#[cfg(all(test, target_os = "macos"))]
pub(crate) fn write_protected_atomically_after_server_verification(
    path: &Path,
    clear: &[u8],
) -> AppResult<()> {
    write_protected_atomically_with_reference_after_server_verification(path, clear).map(|_| ())
}

pub(crate) fn write_protected_atomically_with_reference(
    path: &Path,
    clear: &[u8],
) -> AppResult<Vec<u8>> {
    write_protected_atomically_internal(path, clear, false)
}

pub(crate) fn write_protected_atomically_with_reference_after_server_verification(
    path: &Path,
    clear: &[u8],
) -> AppResult<Vec<u8>> {
    write_protected_atomically_internal(path, clear, true)
}

fn write_protected_atomically_internal(
    path: &Path,
    clear: &[u8],
    _recreate_missing_keychain_item: bool,
) -> AppResult<Vec<u8>> {
    const MAX_CLEAR_BYTES: usize = 16 * 1024;
    if clear.is_empty() || clear.len() > MAX_CLEAR_BYTES {
        return Err(AppError::Validation(
            "La donnée locale protégée a une taille invalide.".into(),
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        AppError::Validation("Le chemin de la donnée protégée est invalide.".into())
    })?;
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Validation("Le nom de la donnée protégée est invalide.".into()))?;

    // Un fichier macOS ne contient qu'un identifiant aléatoire de compte
    // Keychain. Conserver ce compte lors d'une mise à jour évite de créer puis
    // supprimer une entrée à chaque avancée de l'ancre de licence (opération
    // très fréquente), sans déplacer le secret hors du Trousseau.
    #[cfg(target_os = "macos")]
    match read_protected_reference(path) {
        Ok(previous_protected) => match marker_account(&previous_protected) {
            Ok(account) => match update_keychain_secret(account, clear) {
                Ok(()) => return Ok(previous_protected),
                Err(KeychainUpdateError::Missing) if _recreate_missing_keychain_item => {}
                Err(KeychainUpdateError::Missing) => {
                    return Err(AppError::Validation(
                            "Le secret protégé est absent du Trousseau macOS. Une vérification en ligne est nécessaire pour le réparer."
                                .into(),
                        ));
                }
                Err(KeychainUpdateError::Other(error)) => return Err(error),
            },
            Err(_) if _recreate_missing_keychain_item => {}
            Err(error) => return Err(error),
        },
        Err(AppError::Io(error)) if error.kind() == ErrorKind::NotFound => {}
        // Une référence malformée n'est réparable qu'à partir d'une valeur que
        // le serveur vient de vérifier. Les erreurs d'accès ne sont jamais
        // masquées.
        Err(AppError::Validation(_)) if _recreate_missing_keychain_item => {}
        Err(error) => return Err(error),
    }

    let temporary_path = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    let protected = protect_for_current_user(clear)?;
    let previous_protected = fs::read(path).ok();

    let result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)?;
        file.write_all(&protected)?;
        file.sync_all()?;
        drop(file);
        // `rename` reste dans le même dossier : Windows l'effectue avec
        // remplacement atomique du fichier cible, sans fenêtre où l'ancre
        // disparaîtrait entre deux lancements.
        fs::rename(&temporary_path, path)?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            if let Some(previous) = previous_protected {
                forget_protected(&previous);
            }
            Ok(protected)
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            forget_protected(&protected);
            Err(error)
        }
    }
}

#[cfg(test)]
pub(crate) fn read_protected(path: &Path) -> AppResult<Vec<u8>> {
    let protected = read_protected_reference(path)?;
    unprotect_protected_reference(&protected)
}

/// Lit seulement la référence persistée du coffre. Sous macOS, elle contient
/// un identifiant aléatoire de compte Keychain, jamais le secret en clair.
pub(crate) fn read_protected_reference(path: &Path) -> AppResult<Vec<u8>> {
    let metadata = fs::metadata(path)?;
    if metadata.len() == 0 || metadata.len() > MAX_PROTECTED_BYTES as u64 {
        return Err(AppError::Validation(
            "La donnée locale protégée est vide ou trop volumineuse.".into(),
        ));
    }
    let protected = fs::read(path)?;
    if protected.is_empty() || protected.len() > MAX_PROTECTED_BYTES {
        return Err(AppError::Validation(
            "La donnée locale protégée est vide ou trop volumineuse.".into(),
        ));
    }
    Ok(protected)
}

pub(crate) fn unprotect_protected_reference(protected: &[u8]) -> AppResult<Vec<u8>> {
    if protected.is_empty() || protected.len() > MAX_PROTECTED_BYTES {
        return Err(AppError::Validation(
            "La donnée locale protégée est vide ou trop volumineuse.".into(),
        ));
    }
    unprotect_for_current_user(protected)
}

pub(crate) fn remove_protected(path: &Path) -> AppResult<()> {
    let protected = match fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    fs::remove_file(path)?;
    forget_protected(&protected);
    Ok(())
}

#[cfg(windows)]
fn protect_for_current_user(clear: &[u8]) -> AppResult<Vec<u8>> {
    use std::ptr::null;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };

    let mut input = clear.to_vec();
    let input_length = u32::try_from(input.len())
        .map_err(|_| AppError::Validation("L’identité d’installation est trop longue.".into()))?;
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: input.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        CryptProtectData(
            &input_blob,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let protected = unsafe {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        bytes
    };
    Ok(protected)
}

#[cfg(windows)]
fn unprotect_for_current_user(protected: &[u8]) -> AppResult<Vec<u8>> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let mut input = protected.to_vec();
    let input_length = u32::try_from(input.len())
        .map_err(|_| AppError::Validation("L’identité protégée est trop longue.".into()))?;
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: input.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let mut description = null_mut();
    let success = unsafe {
        CryptUnprotectData(
            &input_blob,
            &mut description,
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let clear = unsafe {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        if !description.is_null() {
            LocalFree(description.cast());
        }
        bytes
    };
    Ok(clear)
}

#[cfg(target_os = "macos")]
fn keychain_entry(account: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(MACOS_KEYCHAIN_SERVICE, account).map_err(|error| {
        AppError::Validation(format!(
            "Le Trousseau macOS n’a pas pu préparer le stockage sécurisé ({error})."
        ))
    })
}

#[cfg(target_os = "macos")]
fn create_keychain_secret(account: &str, clear: &[u8]) -> AppResult<()> {
    security_framework::passwords::set_generic_password(MACOS_KEYCHAIN_SERVICE, account, clear)
        .map_err(|error| {
            AppError::Validation(format!(
                "Le Trousseau macOS a refusé l’enregistrement sécurisé ({error})."
            ))
        })
}

#[cfg(target_os = "macos")]
enum KeychainUpdateError {
    Missing,
    Other(AppError),
}

#[cfg(target_os = "macos")]
fn update_keychain_secret(account: &str, clear: &[u8]) -> Result<(), KeychainUpdateError> {
    use core_foundation::data::CFData;
    use security_framework::{
        item::{update_item, ItemClass, ItemSearchOptions, ItemUpdateOptions, ItemUpdateValue},
        os::macos::keychain::{SecKeychain, SecPreferencesDomain},
    };

    // Construire une requête sans kSecReturnData puis appeler directement
    // SecItemUpdate : la valeur existante n'est jamais lue. Si l'entrée a été
    // supprimée du Trousseau, l'update échoue au lieu de la recréer depuis une
    // copie en mémoire.
    let keychain =
        SecKeychain::default_for_domain(SecPreferencesDomain::User).map_err(|error| {
            KeychainUpdateError::Other(AppError::Validation(format!(
                "Le Trousseau macOS est indisponible ({error})."
            )))
        })?;
    let mut search = ItemSearchOptions::new();
    search
        .keychains(std::slice::from_ref(&keychain))
        .class(ItemClass::generic_password())
        .service(MACOS_KEYCHAIN_SERVICE)
        .account(account);
    let mut update = ItemUpdateOptions::new();
    update.set_value(ItemUpdateValue::Data(CFData::from_buffer(clear)));
    match update_item(&search, &update) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == security_framework_sys::base::errSecItemNotFound => {
            Err(KeychainUpdateError::Missing)
        }
        Err(error) => Err(KeychainUpdateError::Other(AppError::Validation(format!(
            "Le Trousseau macOS a refusé la mise à jour sécurisée ({error})."
        )))),
    }
}

#[cfg(target_os = "macos")]
fn marker_account(protected: &[u8]) -> AppResult<&str> {
    let marker = std::str::from_utf8(protected).map_err(|_| {
        AppError::Validation("La référence protégée du Trousseau macOS est illisible.".into())
    })?;
    let account = marker.strip_prefix(MACOS_KEYCHAIN_MARKER).ok_or_else(|| {
        AppError::Validation("La référence protégée du Trousseau macOS est invalide.".into())
    })?;
    let identifier = Uuid::parse_str(account).map_err(|_| {
        AppError::Validation("La référence protégée du Trousseau macOS est invalide.".into())
    })?;
    if identifier.get_version() != Some(Version::Random) {
        return Err(AppError::Validation(
            "La référence protégée du Trousseau macOS doit être aléatoire.".into(),
        ));
    }
    Ok(account)
}

#[cfg(target_os = "macos")]
fn protect_for_current_user(clear: &[u8]) -> AppResult<Vec<u8>> {
    let account = Uuid::new_v4().to_string();
    create_keychain_secret(&account, clear)?;
    Ok(format!("{MACOS_KEYCHAIN_MARKER}{account}").into_bytes())
}

#[cfg(target_os = "macos")]
fn unprotect_for_current_user(protected: &[u8]) -> AppResult<Vec<u8>> {
    let account = marker_account(protected)?;
    keychain_entry(account)?.get_secret().map_err(|error| {
        AppError::Validation(format!(
            "Le secret de cette installation est absent ou inaccessible dans le Trousseau macOS ({error})."
        ))
    })
}

#[cfg(target_os = "macos")]
fn forget_protected(protected: &[u8]) {
    let Ok(account) = marker_account(protected) else {
        return;
    };
    let Ok(entry) = keychain_entry(account) else {
        return;
    };
    let _ = entry.delete_credential();
}

#[cfg(windows)]
fn forget_protected(_protected: &[u8]) {}

#[cfg(not(any(windows, target_os = "macos")))]
fn protect_for_current_user(_clear: &[u8]) -> AppResult<Vec<u8>> {
    Err(AppError::Validation(
        "Cette plateforme ne fournit pas encore de coffre système pris en charge par Zentra."
            .into(),
    ))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn unprotect_for_current_user(_protected: &[u8]) -> AppResult<Vec<u8>> {
    Err(AppError::Validation(
        "Cette plateforme ne fournit pas encore de coffre système pris en charge par Zentra."
            .into(),
    ))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn forget_protected(_protected: &[u8]) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_cache_invalidates_old_generation_before_failed_reload() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cache = ProtectedDataCache::enabled_for_test();
        cache
            .get_or_try_init(b"generation-a", || Ok(b"secret-a".to_vec()))
            .unwrap();

        assert!(cache
            .get_or_try_init(b"generation-b", || {
                Err(AppError::Validation("nouvelle génération illisible".into()))
            })
            .is_err());

        let reloads = AtomicUsize::new(0);
        let reloaded = cache
            .get_or_try_init(b"generation-a", || {
                reloads.fetch_add(1, Ordering::SeqCst);
                Ok(b"secret-a-relu".to_vec())
            })
            .unwrap();
        assert_eq!(reloaded, b"secret-a-relu");
        assert_eq!(reloads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn protected_cache_serializes_the_first_unlock() {
        use std::{
            sync::{
                atomic::{AtomicUsize, Ordering},
                Arc, Barrier,
            },
            thread,
        };

        let cache = ProtectedDataCache::enabled_for_test();
        let starts = Arc::new(Barrier::new(8));
        let unlocks = Arc::new(AtomicUsize::new(0));
        let threads = (0..8)
            .map(|_| {
                let cache = cache.clone();
                let starts = Arc::clone(&starts);
                let unlocks = Arc::clone(&unlocks);
                thread::spawn(move || {
                    starts.wait();
                    cache
                        .get_or_try_init(b"shared-generation", || {
                            unlocks.fetch_add(1, Ordering::SeqCst);
                            Ok(b"shared-secret".to_vec())
                        })
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();

        for thread in threads {
            assert_eq!(thread.join().unwrap(), b"shared-secret");
        }
        assert_eq!(unlocks.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn protected_cache_is_retained_only_while_its_marker_is_current() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cache = ProtectedDataCache::enabled_for_test();
        cache
            .get_or_try_init(b"generation-a", || Ok(b"secret-a".to_vec()))
            .unwrap();
        cache
            .retain_only_for_reference(Some(b"generation-a"))
            .unwrap();
        cache
            .get_or_try_init(b"generation-a", || panic!("cache attendu"))
            .unwrap();

        cache
            .retain_only_for_reference(Some(b"generation-b"))
            .unwrap();
        let reloads = AtomicUsize::new(0);
        cache
            .get_or_try_init(b"generation-a", || {
                reloads.fetch_add(1, Ordering::SeqCst);
                Ok(b"secret-a-relu".to_vec())
            })
            .unwrap();
        assert_eq!(reloads.load(Ordering::SeqCst), 1);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn installation_identity_is_stable_and_not_plaintext() {
        let temporary = tempfile::tempdir().unwrap();
        let first = load_or_create(temporary.path()).unwrap();
        let second = load_or_create(temporary.path()).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            Uuid::parse_str(&first).unwrap().get_version(),
            Some(Version::Random)
        );
        let stored = fs::read(temporary.path().join(IDENTITY_FILE)).unwrap();
        assert_ne!(stored, first.as_bytes());
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn protected_file_updates_replace_the_previous_value() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("anchor.dpapi");
        write_protected_atomically(&path, b"first").unwrap();
        #[cfg(target_os = "macos")]
        let first_reference = read_protected_reference(&path).unwrap();
        write_protected_atomically(&path, b"second").unwrap();
        assert_eq!(read_protected(&path).unwrap(), b"second");
        #[cfg(target_os = "macos")]
        assert_eq!(
            read_protected_reference(&path).unwrap(),
            first_reference,
            "une mise à jour doit réutiliser l'entrée Keychain existante"
        );
        assert_eq!(
            std::fs::read_dir(temporary.path()).unwrap().count(),
            1,
            "aucun fichier temporaire ne doit subsister"
        );
        remove_protected(&path).unwrap();
        assert!(!path.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_server_verified_write_recreates_a_missing_keychain_item() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("anchor.protected");
        write_protected_atomically(&path, b"first").unwrap();
        let reference = read_protected_reference(&path).unwrap();
        forget_protected(&reference);

        assert!(write_protected_atomically(&path, b"second").is_err());
        assert!(unprotect_protected_reference(&reference).is_err());
        write_protected_atomically_after_server_verification(&path, b"second").unwrap();
        let repaired_reference = read_protected_reference(&path).unwrap();
        assert_ne!(repaired_reference, reference);
        assert_eq!(
            unprotect_protected_reference(&repaired_reference).unwrap(),
            b"second"
        );
        remove_protected(&path).unwrap();
    }
}
