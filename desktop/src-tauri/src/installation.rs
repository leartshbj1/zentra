use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::Path,
};

use uuid::{Uuid, Version};

use crate::error::{AppError, AppResult};

const IDENTITY_FILE: &str = "installation-identity.dpapi";

pub fn load_or_create(data_dir: &Path) -> AppResult<String> {
    let path = data_dir.join(IDENTITY_FILE);
    match fs::read(&path) {
        Ok(protected) => parse_identity(&unprotect(&protected)?),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let identity = Uuid::new_v4().to_string();
            let protected = protect(identity.as_bytes())?;
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    file.write_all(&protected)?;
                    file.sync_all()?;
                    Ok(identity)
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    parse_identity(&unprotect(&fs::read(path)?)?)
                }
                Err(error) => Err(error.into()),
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

#[cfg(windows)]
fn protect(clear: &[u8]) -> AppResult<Vec<u8>> {
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
fn unprotect(protected: &[u8]) -> AppResult<Vec<u8>> {
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

#[cfg(not(windows))]
fn protect(clear: &[u8]) -> AppResult<Vec<u8>> {
    Ok(clear.to_vec())
}

#[cfg(not(windows))]
fn unprotect(protected: &[u8]) -> AppResult<Vec<u8>> {
    Ok(protected.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        #[cfg(windows)]
        assert_ne!(stored, first.as_bytes());
    }
}
