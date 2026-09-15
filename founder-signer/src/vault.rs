use crate::crypto::{self, Payload, Result};
use ed25519_dalek::SigningKey;
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use zeroize::{Zeroize, Zeroizing};

pub struct Vault {
    pub root: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub reference: String,
    pub payload: Payload,
}

pub fn unprotect(protected: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    if protected.is_empty() || protected.len() > 32768 {
        return Err("Fichier protégé vide ou trop volumineux.".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: protected.len() as u32,
        pbData: protected.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("Le coffre ne peut pas être ouvert par ce compte Windows.".into());
    }
    if output.pbData.is_null() || output.cbData == 0 {
        if !output.pbData.is_null() {
            unsafe {
                LocalFree(output.pbData.cast());
            }
        }
        return Err("Le fichier protégé ne contient aucune donnée.".into());
    }
    let clear = unsafe {
        let bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let clear = Zeroizing::new(bytes.to_vec());
        bytes.zeroize();
        LocalFree(output.pbData.cast());
        clear
    };
    Ok(clear)
}

pub(crate) fn protect(clear: &[u8]) -> Result<Vec<u8>> {
    use std::ptr::null;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };
    if clear.is_empty() || clear.len() > 16384 {
        return Err("Contenu à protéger trop volumineux.".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: clear.len() as u32,
        pbData: clear.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptProtectData(
            &input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("Windows n’a pas pu protéger ce jeton.".into());
    }
    Ok(unsafe {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        bytes
    })
}

fn read_limited(path: &Path) -> Result<Vec<u8>> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|_| "Fichier du coffre introuvable.")?;
    let mut bytes = Vec::new();
    file.take(32769)
        .read_to_end(&mut bytes)
        .map_err(|_| "Fichier du coffre illisible.")?;
    if bytes.len() > 32768 {
        return Err("Fichier du coffre trop volumineux.".into());
    }
    Ok(bytes)
}

impl Vault {
    pub fn default_root() -> Result<PathBuf> {
        let local = std::env::var_os("LOCALAPPDATA")
            .ok_or("Le dossier personnel Windows est indisponible.")?;
        Ok(PathBuf::from(local).join("ZentraFondateur").join("vault"))
    }
    pub fn key(&self) -> Result<SigningKey> {
        let path = self.root.join("license-signing-key.dpapi");
        if !path.is_file() {
            return Err(
                "Clé absente. Exécutez installer-local.ps1 depuis le projet pour préparer ce PC."
                    .into(),
            );
        }
        crypto::signing_key(&unprotect(&read_limited(&path)?)?)
    }
    pub fn devices(&self) -> Result<(Vec<Device>, usize)> {
        if !self.root.is_dir() {
            return Ok((vec![], 0));
        }
        let mut devices: Vec<Device> = Vec::new();
        let mut unreadable = 0;
        for entry in fs::read_dir(&self.root).map_err(|_| "Le coffre est inaccessible.")? {
            let entry = entry.map_err(|_| "Le coffre est inaccessible.")?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !((name.starts_with("owner-license-token") || name.starts_with("signed-"))
                && name.ends_with(".dpapi"))
            {
                continue;
            }
            match self
                .token(&name)
                .and_then(|token| crypto::verify_with(&token, &crypto::public_key()?))
            {
                Ok(payload) => {
                    let duplicate = devices.iter().position(|d| {
                        d.payload.license_id == payload.license_id
                            && d.payload.installation_id == payload.installation_id
                    });
                    let device = Device {
                        reference: name,
                        payload,
                    };
                    if let Some(index) = duplicate {
                        if device.payload.issued_at > devices[index].payload.issued_at {
                            devices[index] = device;
                        }
                    } else {
                        devices.push(device);
                    }
                }
                Err(_) => unreadable += 1,
            }
        }
        devices.sort_by(|a, b| b.payload.issued_at.cmp(&a.payload.issued_at));
        Ok((devices, unreadable))
    }
    pub fn token(&self, reference: &str) -> Result<String> {
        if reference.len() > 160
            || !reference
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
            || reference.contains("..")
            || !reference.ends_with(".dpapi")
            || !(reference.starts_with("owner-license-token") || reference.starts_with("signed-"))
        {
            return Err("Référence de jeton invalide.".into());
        }
        let clear = unprotect(&read_limited(&self.root.join(reference))?)?;
        let token = std::str::from_utf8(&clear)
            .map_err(|_| "Jeton protégé illisible.")?
            .trim()
            .to_owned();
        crypto::verify_with(&token, &crypto::public_key()?)?;
        Ok(token)
    }
    pub fn save(&self, token: &str, payload: &Payload) -> Result<()> {
        let protected = protect(token.as_bytes())?;
        fs::create_dir_all(&self.root).map_err(|_| "Impossible de créer le coffre.")?;
        let destination = self
            .root
            .join(format!("signed-{}.dpapi", crypto::binding(payload)));
        let temporary = self
            .root
            .join(format!("pending-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| "Impossible d’enregistrer le jeton protégé.")?;
            file.write_all(&protected)
                .and_then(|_| file.sync_all())
                .map_err(|_| "Impossible d’enregistrer le jeton protégé.")?;
            drop(file);
            fs::rename(&temporary, &destination)
                .map_err(|_| "Impossible de finaliser le jeton protégé.")?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dpapi_roundtrip_and_corruption() {
        let clear = b"fixture - this is not a production secret";
        let mut encrypted = protect(clear).unwrap();
        assert!(!encrypted.windows(clear.len()).any(|w| w == clear));
        assert_eq!(unprotect(&encrypted).unwrap().as_slice(), clear);
        let last = encrypted.len() - 1;
        encrypted[last] ^= 1;
        assert!(unprotect(&encrypted).is_err());
    }
    #[test]
    fn cannot_read_key_or_escape_vault() {
        let temp = tempfile::tempdir().unwrap();
        let vault = Vault {
            root: temp.path().to_owned(),
        };
        for name in [
            "../license-signing-key.dpapi",
            "license-signing-key.dpapi",
            "owner-license-token/../../x.dpapi",
            "C:\\private.dpapi",
        ] {
            assert!(vault.token(name).is_err());
        }
    }
    #[test]
    fn encrypted_replacement_is_atomic_and_no_cleartext_remains() {
        let temp = tempfile::tempdir().unwrap();
        let vault = Vault {
            root: temp.path().to_owned(),
        };
        let payload = crypto::owner_payload("67977efd-492e-4e01-b719-5fe42b7c3d2d");
        vault.save("first private token", &payload).unwrap();
        vault.save("replacement private token", &payload).unwrap();
        let files = fs::read_dir(temp.path())
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(files.len(), 1);
        let bytes = fs::read(files[0].path()).unwrap();
        assert_eq!(
            unprotect(&bytes).unwrap().as_slice(),
            b"replacement private token"
        );
    }
}
