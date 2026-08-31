use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use image::{DynamicImage, GenericImageView, ImageFormat};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    database::LocalStore,
    error::{AppError, AppResult},
};

const MAX_LOGO_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LOGO_EDGE: u32 = 4_096;
const MAX_LOGO_PIXELS: u64 = 16_000_000;
const MIN_LOGO_EDGE: u32 = 16;

#[derive(Debug, Clone)]
pub(crate) struct PdfLogo {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

impl LocalStore {
    /// Copie un logo choisi par l'utilisateur dans le stockage local Elyko.
    /// Le nom est dérivé du contenu : un logo déjà importé n'est jamais dupliqué
    /// et les anciens documents continuent à référencer leur version immuable.
    pub fn stage_company_logo(&self, source_path: &str) -> AppResult<String> {
        let source = absolute_file(source_path)?;
        let metadata = fs::metadata(&source)?;
        if metadata.len() == 0 || metadata.len() > MAX_LOGO_BYTES {
            return Err(AppError::Validation(
                "Le logo doit être une image non vide de 8 Mo au maximum.".into(),
            ));
        }
        let bytes = fs::read(&source)?;
        let (format, _) = decode_and_validate(&bytes)?;
        let extension = format_extension(format)?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let branding_dir = self.attachments_dir.join("branding");
        fs::create_dir_all(&branding_dir)?;
        let destination = branding_dir.join(format!("logo-{digest}.{extension}"));

        if !destination.exists() {
            let temporary = branding_dir.join(format!(".logo-{}.tmp", Uuid::new_v4()));
            let result = (|| -> AppResult<()> {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                fs::rename(&temporary, &destination)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            result?;
        }

        Ok(destination.to_string_lossy().into_owned())
    }
}

pub(crate) fn load_pdf_logo(raw_path: &str) -> Option<PdfLogo> {
    let path = Path::new(raw_path.trim());
    if raw_path.trim().is_empty() || !path.is_absolute() {
        return None;
    }
    load_pdf_logo_path(path)
}

/// Recharge une référence immuable après restauration d'une sauvegarde dans un
/// autre profil Windows. Le repli est volontairement limité aux noms produits
/// par `stage_company_logo` et le condensat du fichier est revérifié avant usage.
pub(crate) fn load_pdf_logo_with_fallback(raw_path: &str, branding_dir: &Path) -> Option<PdfLogo> {
    let original = Path::new(raw_path.trim());
    if raw_path.trim().is_empty() || !original.is_absolute() {
        return None;
    }
    let file_name = original.file_name()?.to_str()?;
    let Some(expected_digest) = immutable_logo_digest(file_name) else {
        return load_pdf_logo(raw_path);
    };

    for candidate in [original.to_path_buf(), branding_dir.join(file_name)] {
        let Some(bytes) = read_valid_logo_bytes(&candidate) else {
            continue;
        };
        let actual_digest = format!("{:x}", Sha256::digest(&bytes));
        if actual_digest.eq_ignore_ascii_case(expected_digest) {
            return pdf_logo_from_bytes(&bytes);
        }
    }
    None
}

fn immutable_logo_digest(file_name: &str) -> Option<&str> {
    let (stem, extension) = file_name.rsplit_once('.')?;
    if !matches!(
        extension.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "webp"
    ) {
        return None;
    }
    let digest = stem.strip_prefix("logo-")?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(digest)
}

fn read_valid_logo_bytes(path: &Path) -> Option<Vec<u8>> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_LOGO_BYTES {
        return None;
    }
    fs::read(path).ok()
}

fn load_pdf_logo_path(path: &Path) -> Option<PdfLogo> {
    let bytes = read_valid_logo_bytes(path)?;
    pdf_logo_from_bytes(&bytes)
}

fn pdf_logo_from_bytes(bytes: &[u8]) -> Option<PdfLogo> {
    let (_, decoded) = decode_and_validate(bytes).ok()?;
    let thumbnail = decoded.thumbnail(1_200, 400).to_rgba8();
    let (width, height) = thumbnail.dimensions();
    let mut rgb = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for pixel in thumbnail.pixels() {
        let [red, green, blue, alpha] = pixel.0;
        let alpha = u16::from(alpha);
        for channel in [red, green, blue] {
            let composited = (u16::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255;
            rgb.push(composited as u8);
        }
    }
    Some(PdfLogo { width, height, rgb })
}

fn absolute_file(raw_path: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(raw_path.trim());
    if raw_path.trim().is_empty() || !path.is_absolute() {
        return Err(AppError::Validation(
            "Choisissez un fichier image local avec un chemin absolu.".into(),
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|_| {
        AppError::Validation("Le fichier du logo est introuvable ou inaccessible.".into())
    })?;
    if !canonical.is_file() {
        return Err(AppError::Validation(
            "Le logo sélectionné n'est pas un fichier.".into(),
        ));
    }
    Ok(canonical)
}

fn decode_and_validate(bytes: &[u8]) -> AppResult<(ImageFormat, DynamicImage)> {
    let format = image::guess_format(bytes).map_err(|_| {
        AppError::Validation(
            "Format de logo non reconnu. Utilisez une image PNG, JPEG ou WebP.".into(),
        )
    })?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err(AppError::Validation(
            "Format de logo refusé. Utilisez une image PNG, JPEG ou WebP.".into(),
        ));
    }
    let decoded = image::load_from_memory_with_format(bytes, format).map_err(|_| {
        AppError::Validation(
            "Le fichier ressemble à une image mais son contenu est invalide ou corrompu.".into(),
        )
    })?;
    let (width, height) = decoded.dimensions();
    if width < MIN_LOGO_EDGE || height < MIN_LOGO_EDGE {
        return Err(AppError::Validation(
            "Le logo doit mesurer au moins 16 × 16 pixels.".into(),
        ));
    }
    if width > MAX_LOGO_EDGE
        || height > MAX_LOGO_EDGE
        || u64::from(width) * u64::from(height) > MAX_LOGO_PIXELS
    {
        return Err(AppError::Validation(
            "Le logo est trop grand. La limite est de 4096 pixels par côté et 16 mégapixels."
                .into(),
        ));
    }
    Ok((format, decoded))
}

fn format_extension(format: ImageFormat) -> AppResult<&'static str> {
    match format {
        ImageFormat::Png => Ok("png"),
        ImageFormat::Jpeg => Ok("jpg"),
        ImageFormat::WebP => Ok("webp"),
        _ => Err(AppError::Validation(
            "Format de logo non pris en charge.".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stages_a_valid_logo_once_inside_the_local_backup_tree() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile")).expect("store");
        let source = temporary.path().join("logo.png");
        DynamicImage::new_rgba8(64, 32)
            .save_with_format(&source, ImageFormat::Png)
            .expect("write test logo");

        let first = store
            .stage_company_logo(source.to_str().expect("source path"))
            .expect("stage logo");
        let second = store
            .stage_company_logo(source.to_str().expect("source path"))
            .expect("stage same logo");

        assert_eq!(first, second);
        assert!(Path::new(&first).starts_with(store.attachments_dir.join("branding")));
        assert!(Path::new(&first).is_file());
        assert!(load_pdf_logo(&first).is_some());
    }

    #[test]
    fn rejects_extension_spoofing_and_oversized_dimensions() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile")).expect("store");
        let fake = temporary.path().join("fake.png");
        fs::write(&fake, b"not an image").expect("write fake logo");
        assert!(store
            .stage_company_logo(fake.to_str().expect("fake path"))
            .unwrap_err()
            .to_string()
            .contains("Format"));

        let huge = DynamicImage::new_rgba8(MAX_LOGO_EDGE + 1, MIN_LOGO_EDGE);
        let huge_path = temporary.path().join("huge.png");
        huge.save_with_format(&huge_path, ImageFormat::Png)
            .expect("write huge logo");
        assert!(store
            .stage_company_logo(huge_path.to_str().expect("huge path"))
            .unwrap_err()
            .to_string()
            .contains("trop grand"));
    }

    #[test]
    fn reloads_an_immutable_logo_after_restore_in_another_profile() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let original_store =
            LocalStore::initialize(temporary.path().join("original-profile")).expect("store");
        let source = temporary.path().join("logo.png");
        DynamicImage::new_rgba8(64, 32)
            .save_with_format(&source, ImageFormat::Png)
            .expect("write test logo");
        let original_path = original_store
            .stage_company_logo(source.to_str().expect("source path"))
            .expect("stage logo");

        let restored_branding_dir = temporary
            .path()
            .join("restored-profile")
            .join("attachments")
            .join("branding");
        fs::create_dir_all(&restored_branding_dir).expect("create restored branding directory");
        let file_name = Path::new(&original_path)
            .file_name()
            .expect("immutable file name");
        fs::copy(&original_path, restored_branding_dir.join(file_name)).expect("restore logo file");
        let missing_old_path = temporary
            .path()
            .join("missing-old-profile")
            .join("attachments")
            .join("branding")
            .join(file_name);

        assert!(load_pdf_logo(missing_old_path.to_str().expect("old path")).is_none());
        assert!(load_pdf_logo_with_fallback(
            missing_old_path.to_str().expect("old path"),
            &restored_branding_dir,
        )
        .is_some());

        fs::write(restored_branding_dir.join(file_name), b"tampered")
            .expect("tamper restored logo");
        assert!(load_pdf_logo_with_fallback(
            missing_old_path.to_str().expect("old path"),
            &restored_branding_dir,
        )
        .is_none());
    }
}
