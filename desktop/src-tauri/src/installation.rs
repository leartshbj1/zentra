use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::Path,
};

use uuid::{Uuid, Version};

use crate::error::{AppError, AppResult};

#[cfg(windows)]
const IDENTITY_FILE: &str = "installation-identity.dpapi";
#[cfg(not(windows))]
const IDENTITY_FILE: &str = "installation-identity.protected";

#[cfg(target_os = "macos")]
const MACOS_KEYCHAIN_SERVICE: &str = "ch.zentra.desktop.protected-data";
#[cfg(target_os = "macos")]
const MACOS_KEYCHAIN_MARKER: &str = "zentra-keychain-v1:";

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

pub(crate) fn write_protected_atomically(path: &Path, clear: &[u8]) -> AppResult<()> {
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
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
        forget_protected(&protected);
    } else if let Some(previous) = previous_protected {
        forget_protected(&previous);
    }
    result
}

pub(crate) fn read_protected(path: &Path) -> AppResult<Vec<u8>> {
    const MAX_PROTECTED_BYTES: u64 = 64 * 1024;
    let metadata = fs::metadata(path)?;
    if metadata.len() == 0 || metadata.len() > MAX_PROTECTED_BYTES {
        return Err(AppError::Validation(
            "La donnée locale protégée est vide ou trop volumineuse.".into(),
        ));
    }
    unprotect_for_current_user(&fs::read(path)?)
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
    keychain_entry(&account)?
        .set_secret(clear)
        .map_err(|error| {
            AppError::Validation(format!(
                "Le Trousseau macOS a refusé l’enregistrement sécurisé ({error})."
            ))
        })?;
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
        write_protected_atomically(&path, b"second").unwrap();
        assert_eq!(read_protected(&path).unwrap(), b"second");
        assert_eq!(
            std::fs::read_dir(temporary.path()).unwrap().count(),
            1,
            "aucun fichier temporaire ne doit subsister"
        );
        remove_protected(&path).unwrap();
        assert!(!path.exists());
    }
}
