use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader, Limits};
use rusqlite::{params, Transaction};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    database::{now_iso, LocalStore},
    error::{AppError, AppResult},
};

const MAX_LOGO_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LOGO_EDGE: u32 = 4_096;
const MAX_LOGO_PIXELS: u64 = 16_000_000;
const MIN_LOGO_EDGE: u32 = 16;
const MAX_LOGO_DECODE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct PdfLogo {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

impl LocalStore {
    /// Copie un logo choisi par l'utilisateur dans le stockage local Zentra.
    /// Le nom est dérivé du contenu : un logo déjà importé n'est jamais dupliqué
    /// et les anciens documents continuent à référencer leur version immuable.
    pub fn stage_company_logo(&self, source_path: &str) -> AppResult<String> {
        let branding_dir = self.secure_branding_dir()?;
        let staged = stage_company_logo_file(source_path, &branding_dir)?;

        self.register_company_logo_asset(
            &staged.digest,
            staged
                .destination
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| AppError::Validation("Le nom du logo local est invalide.".into()))?,
            staged.media_type,
            staged.byte_size,
            staged.width,
            staged.height,
        )?;

        Ok(staged.destination.to_string_lossy().into_owned())
    }

    /// Vérifie un logo fourni à l'assistant sans modifier le profil. La copie
    /// dans le stockage géré est effectuée uniquement lors de la finalisation.
    pub(crate) fn validate_company_logo_source(&self, source_path: Option<&str>) -> AppResult<()> {
        let Some(source_path) = source_path.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(());
        };
        let _ = read_and_validate_logo_source(source_path)?;
        Ok(())
    }

    /// Toute nouvelle référence enregistrée est convertie en copie locale
    /// immuable. Cette méthode accepte aussi un ancien chemin externe valide et
    /// le migre sans supprimer le fichier d'origine.
    pub(crate) fn store_company_logo_reference(
        &self,
        source_path: Option<&str>,
    ) -> AppResult<Option<String>> {
        let Some(source_path) = source_path.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        self.stage_company_logo(source_path).map(Some)
    }

    fn secure_branding_dir(&self) -> AppResult<PathBuf> {
        secure_branding_dir(&self.attachments_dir)
    }

    fn register_company_logo_asset(
        &self,
        digest: &str,
        file_name: &str,
        media_type: &str,
        byte_size: i64,
        width: u32,
        height: u32,
    ) -> AppResult<()> {
        let connection = self.connect()?;
        let now = now_iso();
        connection.execute(
            "INSERT INTO company_brand_assets(sha256,file_name,media_type,byte_size,width,height,created_at,last_verified_at)
             VALUES(?,?,?,?,?,?,?,?)
             ON CONFLICT(sha256) DO UPDATE SET
               file_name=excluded.file_name,
               media_type=excluded.media_type,
               byte_size=excluded.byte_size,
               width=excluded.width,
               height=excluded.height,
               last_verified_at=excluded.last_verified_at",
            params![
                digest,
                file_name,
                media_type,
                byte_size,
                i64::from(width),
                i64::from(height),
                now,
                now,
            ],
        )?;
        Ok(())
    }
}

#[derive(Debug)]
struct StagedCompanyLogo {
    destination: PathBuf,
    digest: String,
    media_type: &'static str,
    byte_size: i64,
    width: u32,
    height: u32,
}

/// Convertit, dans la transaction d'émission, l'éventuel chemin historique
/// encore actif en référence locale adressée par son contenu. La mise à jour
/// vise uniquement `settings`: les snapshots déjà émis restent inchangés.
pub(crate) fn stage_active_company_logo_for_snapshot(
    transaction: &Transaction<'_>,
    source_path: &str,
) -> AppResult<String> {
    let source_path = source_path.trim();
    if source_path.is_empty() {
        return Err(AppError::Validation(
            "La référence du logo actif est vide.".into(),
        ));
    }
    let database_path: String = transaction.query_row(
        "SELECT file FROM pragma_database_list WHERE name='main'",
        [],
        |row| row.get(0),
    )?;
    let database_path = PathBuf::from(database_path);
    let data_dir = database_path.parent().filter(|_| database_path.is_absolute()).ok_or_else(|| {
        AppError::Validation(
            "Le profil local du logo est introuvable; l'émission est bloquée pour ne pas figer une référence externe mutable."
                .into(),
        )
    })?;
    let branding_dir = secure_branding_dir(&data_dir.join("attachments"))?;
    let effective_source = if is_managed_logo_reference(source_path) {
        resolve_managed_logo_source(source_path, &branding_dir).ok_or_else(|| {
            AppError::Validation(
                "La copie locale immuable du logo est introuvable, illisible ou altérée. Réimportez le logo avant d'émettre le document."
                    .into(),
            )
        })?
    } else {
        PathBuf::from(source_path)
    };
    let staged = stage_company_logo_file(
        effective_source.to_str().ok_or_else(|| {
            AppError::Validation(
                "Le chemin du logo actif n'est pas un texte Windows valide.".into(),
            )
        })?,
        &branding_dir,
    )?;
    let file_name = staged
        .destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Validation("Le nom du logo local est invalide.".into()))?;
    let now = now_iso();
    transaction.execute(
        "INSERT INTO company_brand_assets(sha256,file_name,media_type,byte_size,width,height,created_at,last_verified_at)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(sha256) DO UPDATE SET
           file_name=excluded.file_name,
           media_type=excluded.media_type,
           byte_size=excluded.byte_size,
           width=excluded.width,
           height=excluded.height,
           last_verified_at=excluded.last_verified_at",
        params![
            staged.digest,
            file_name,
            staged.media_type,
            staged.byte_size,
            i64::from(staged.width),
            i64::from(staged.height),
            now,
            now,
        ],
    )?;
    let managed_path = staged.destination.to_string_lossy().into_owned();
    if managed_path != source_path {
        transaction.execute(
            "UPDATE settings SET logo_path=?,updated_at=? WHERE id=1 AND logo_path=?",
            params![managed_path, now_iso(), source_path],
        )?;
    }
    Ok(managed_path)
}

fn secure_branding_dir(attachments_dir: &Path) -> AppResult<PathBuf> {
    fs::create_dir_all(attachments_dir)?;
    let canonical_attachments = fs::canonicalize(attachments_dir)?;
    let requested = attachments_dir.join("branding");
    fs::create_dir_all(&requested)?;
    let branding_dir = fs::canonicalize(&requested)?;
    if branding_dir.parent() != Some(canonical_attachments.as_path()) {
        return Err(AppError::Validation(
            "Le dossier local des logos pointe hors du profil Zentra. Restaurez un dossier de données local valide avant de continuer."
                .into(),
        ));
    }
    // Conserver le chemin Windows usuel dans la base et les snapshots. Le
    // préfixe canonique `\\?\` est utile au contrôle ci-dessus mais fragile
    // pour les aperçus WebView et rendrait les anciens chemins inutilement
    // différents.
    Ok(requested)
}

fn stage_company_logo_file(source_path: &str, branding_dir: &Path) -> AppResult<StagedCompanyLogo> {
    let (_source, bytes, format, width, height) = read_and_validate_logo_source(source_path)?;
    let extension = format_extension(format)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let destination = branding_dir.join(format!("logo-{digest}.{extension}"));

    match fs::symlink_metadata(&destination) {
        Ok(metadata)
            if metadata.is_file() && fs::read(&destination).ok().as_deref() == Some(&bytes) =>
        {
            validate_managed_logo_path(&destination, branding_dir)?;
        }
        Ok(_) => {
            replace_corrupted_managed_logo(branding_dir, &destination, &bytes)?;
            validate_managed_logo_path(&destination, branding_dir)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            write_new_managed_logo(branding_dir, &destination, &bytes)?;
            validate_managed_logo_path(&destination, branding_dir)?;
        }
        Err(error) => return Err(error.into()),
    }

    Ok(StagedCompanyLogo {
        destination,
        digest,
        media_type: logo_media_type(format)?,
        byte_size: bytes.len() as i64,
        width,
        height,
    })
}

fn resolve_managed_logo_source(raw_path: &str, branding_dir: &Path) -> Option<PathBuf> {
    let original = Path::new(raw_path);
    let file_name = original.file_name()?.to_str()?;
    let expected_digest = immutable_logo_digest(file_name)?;
    for candidate in [original.to_path_buf(), branding_dir.join(file_name)] {
        let Some(bytes) = read_valid_logo_bytes(&candidate) else {
            continue;
        };
        let actual_digest = format!("{:x}", Sha256::digest(&bytes));
        if actual_digest.eq_ignore_ascii_case(expected_digest)
            && decode_and_validate(&bytes).is_ok()
        {
            return Some(candidate);
        }
    }
    None
}

fn read_and_validate_logo_source(
    source_path: &str,
) -> AppResult<(PathBuf, Vec<u8>, ImageFormat, u32, u32)> {
    let source = absolute_file(source_path)?;
    let metadata = fs::metadata(&source)?;
    if metadata.len() == 0 || metadata.len() > MAX_LOGO_BYTES {
        return Err(AppError::Validation(
            "Le logo doit être une image non vide de 8 Mo au maximum.".into(),
        ));
    }
    let bytes = fs::read(&source)?;
    let (format, decoded) = decode_and_validate(&bytes)?;
    let (width, height) = decoded.dimensions();
    Ok((source, bytes, format, width, height))
}

fn write_logo_temporary(branding_dir: &Path, bytes: &[u8]) -> AppResult<PathBuf> {
    let temporary = branding_dir.join(format!(".logo-{}.tmp", Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(temporary)
}

fn write_new_managed_logo(branding_dir: &Path, destination: &Path, bytes: &[u8]) -> AppResult<()> {
    let temporary = write_logo_temporary(branding_dir, bytes)?;
    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

/// Répare une copie locale altérée tout en gardant une possibilité de retour
/// immédiat si l'installation du fichier sain échoue.
fn replace_corrupted_managed_logo(
    branding_dir: &Path,
    destination: &Path,
    bytes: &[u8],
) -> AppResult<()> {
    let temporary = write_logo_temporary(branding_dir, bytes)?;
    let quarantine = branding_dir.join(format!(".logo-corrupted-{}.bak", Uuid::new_v4()));
    if let Err(error) = fs::rename(destination, &quarantine) {
        let _ = fs::remove_file(&temporary);
        return Err(AppError::Validation(format!(
            "La copie locale existante du logo est altérée et n'a pas pu être isolée : {error}"
        )));
    }
    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::rename(&quarantine, destination);
        let _ = fs::remove_file(&temporary);
        return Err(AppError::Validation(format!(
            "La copie locale altérée du logo n'a pas pu être réparée : {error}"
        )));
    }
    let _ = fs::remove_file(quarantine);
    Ok(())
}

fn validate_managed_logo_path(path: &Path, branding_dir: &Path) -> AppResult<()> {
    let canonical_branding_dir = fs::canonicalize(branding_dir)
        .map_err(|_| AppError::Validation("Le dossier local des logos est introuvable.".into()))?;
    let canonical = fs::canonicalize(path).map_err(|_| {
        AppError::Validation("La copie locale du logo est introuvable ou inaccessible.".into())
    })?;
    if canonical.parent() != Some(canonical_branding_dir.as_path()) {
        return Err(AppError::Validation(
            "Le logo doit rester directement dans le stockage local géré par Zentra.".into(),
        ));
    }
    let file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Validation("Le nom du logo local est invalide.".into()))?;
    let expected_digest = immutable_logo_digest(file_name).ok_or_else(|| {
        AppError::Validation("La référence locale du logo n'est pas immuable.".into())
    })?;
    let bytes = read_valid_logo_bytes(&canonical).ok_or_else(|| {
        AppError::Validation("La copie locale du logo est vide, trop grande ou illisible.".into())
    })?;
    let actual_digest = format!("{:x}", Sha256::digest(&bytes));
    if !actual_digest.eq_ignore_ascii_case(expected_digest) {
        return Err(AppError::Validation(
            "La copie locale du logo a été altérée depuis son import.".into(),
        ));
    }
    let (format, _) = decode_and_validate(&bytes)?;
    let actual_extension = format_extension(format)?;
    let stored_extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !stored_extension.eq_ignore_ascii_case(actual_extension) {
        return Err(AppError::Validation(
            "Le type réel du logo ne correspond pas à sa copie locale.".into(),
        ));
    }
    Ok(())
}

pub(crate) fn load_pdf_logo(raw_path: &str) -> Option<PdfLogo> {
    let path = Path::new(raw_path.trim());
    if raw_path.trim().is_empty() || !path.is_absolute() {
        return None;
    }
    load_pdf_logo_path(path)
}

pub(crate) fn is_managed_logo_reference(raw_path: &str) -> bool {
    Path::new(raw_path.trim())
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(immutable_logo_digest)
        .is_some()
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
    // `DynamicImage::thumbnail` peut agrandir les petites images. Garder leur
    // définition native évite de gonfler inutilement chaque PDF; seules les
    // grandes images sont réduites avant incorporation.
    let thumbnail = if decoded.width() > 1_200 || decoded.height() > 400 {
        decoded.thumbnail(1_200, 400).to_rgba8()
    } else {
        decoded.to_rgba8()
    };
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

    // Contrôler l'en-tête avant le décodage évite qu'une petite image
    // compressée annonçant une surface gigantesque ne réserve la mémoire du PC.
    let (declared_width, declared_height) = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| {
            AppError::Validation(
                "Le fichier ressemble à une image mais son en-tête est invalide ou corrompu."
                    .into(),
            )
        })?;
    validate_logo_dimensions(declared_width, declared_height)?;

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_LOGO_EDGE);
    limits.max_image_height = Some(MAX_LOGO_EDGE);
    limits.max_alloc = Some(MAX_LOGO_DECODE_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| {
        AppError::Validation(
            "Le fichier ressemble à une image mais son contenu est invalide ou corrompu.".into(),
        )
    })?;
    let (width, height) = decoded.dimensions();
    validate_logo_dimensions(width, height)?;
    if (width, height) != (declared_width, declared_height) {
        return Err(AppError::Validation(
            "Les dimensions déclarées du logo ne correspondent pas à son contenu décodé.".into(),
        ));
    }
    Ok((format, decoded))
}

fn validate_logo_dimensions(width: u32, height: u32) -> AppResult<()> {
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
    Ok(())
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

fn logo_media_type(format: ImageFormat) -> AppResult<&'static str> {
    match format {
        ImageFormat::Png => Ok("image/png"),
        ImageFormat::Jpeg => Ok("image/jpeg"),
        ImageFormat::WebP => Ok("image/webp"),
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
    fn rejects_relative_empty_tiny_and_oversized_files_before_storage() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile")).expect("store");

        let relative = store.stage_company_logo("logo.png").unwrap_err();
        assert!(relative.to_string().contains("chemin absolu"));

        let empty = temporary.path().join("empty.png");
        fs::write(&empty, []).expect("write empty file");
        assert!(store
            .stage_company_logo(empty.to_str().expect("empty path"))
            .unwrap_err()
            .to_string()
            .contains("non vide"));

        let tiny = temporary.path().join("tiny.png");
        DynamicImage::new_rgba8(MIN_LOGO_EDGE - 1, MIN_LOGO_EDGE)
            .save_with_format(&tiny, ImageFormat::Png)
            .expect("write tiny image");
        assert!(store
            .stage_company_logo(tiny.to_str().expect("tiny path"))
            .unwrap_err()
            .to_string()
            .contains("au moins 16"));

        let oversized = temporary.path().join("oversized.png");
        let file = fs::File::create(&oversized).expect("create oversized file");
        file.set_len(MAX_LOGO_BYTES + 1)
            .expect("extend oversized file");
        assert!(store
            .stage_company_logo(oversized.to_str().expect("oversized path"))
            .unwrap_err()
            .to_string()
            .contains("8 Mo"));
    }

    #[test]
    fn repairs_a_tampered_content_addressed_copy_from_the_selected_source() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile")).expect("store");
        let source = temporary.path().join("logo-source.png");
        DynamicImage::new_rgba8(96, 48)
            .save_with_format(&source, ImageFormat::Png)
            .expect("write original logo");
        let expected = fs::read(&source).expect("read original logo");
        let staged = store
            .stage_company_logo(source.to_str().expect("source path"))
            .expect("stage logo");

        DynamicImage::new_rgb8(96, 48)
            .save_with_format(&staged, ImageFormat::Png)
            .expect("tamper staged logo with another valid image");
        assert!(load_pdf_logo_with_fallback(
            &staged,
            Path::new(&staged).parent().expect("branding directory")
        )
        .is_none());

        let repaired = store
            .stage_company_logo(source.to_str().expect("source path"))
            .expect("repair staged logo");
        assert_eq!(repaired, staged);
        assert_eq!(fs::read(&repaired).expect("read repaired logo"), expected);
        assert!(load_pdf_logo(&repaired).is_some());
    }

    #[test]
    fn stores_an_external_legacy_source_as_a_managed_local_reference() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile")).expect("store");
        let legacy = temporary.path().join("ancien logo client.jpeg");
        DynamicImage::new_rgb8(80, 40)
            .save_with_format(&legacy, ImageFormat::Jpeg)
            .expect("write legacy logo");

        store
            .validate_company_logo_source(Some(legacy.to_str().expect("legacy path")))
            .expect("validate legacy source without writing");
        let stored = store
            .store_company_logo_reference(Some(legacy.to_str().expect("legacy path")))
            .expect("store legacy source")
            .expect("stored reference");

        assert!(is_managed_logo_reference(&stored));
        assert!(Path::new(&stored).starts_with(store.attachments_dir.join("branding")));
        assert_eq!(
            Path::new(&stored)
                .extension()
                .and_then(|value| value.to_str()),
            Some("jpg")
        );
        assert!(load_pdf_logo(&stored).is_some());
        assert_eq!(
            store.store_company_logo_reference(Some("   ")).unwrap(),
            None
        );
    }

    #[test]
    fn settings_only_persist_registered_local_logos_and_allow_removal() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let store = LocalStore::initialize(temporary.path().join("profile")).expect("store");
        store
            .connect()
            .expect("database")
            .execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,noga_section,noga_division,activity_description,created_at,updated_at) VALUES(1,1,'Entreprise logo','F','43','Travaux spécialisés','2026-09-02T10:00:00Z','2026-09-02T10:00:00Z')",
                [],
            )
            .expect("insert minimal settings");
        let source = temporary.path().join("logo-client.png");
        DynamicImage::new_rgba8(128, 64)
            .save_with_format(&source, ImageFormat::Png)
            .expect("write company logo");

        let updated = store
            .update_settings(serde_json::json!({
                "logo_path": source.to_string_lossy()
            }))
            .expect("persist managed logo");
        let stored = updated["logo_path"]
            .as_str()
            .expect("stored logo path")
            .to_owned();
        assert!(stored.contains("attachments"));
        assert!(stored.contains("branding"));
        assert!(is_managed_logo_reference(&stored));
        let registered: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM company_brand_assets", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(registered, 1);

        let rejected = store.update_settings(serde_json::json!({
            "logo_path": temporary.path().join("missing.png").to_string_lossy()
        }));
        assert!(rejected.unwrap_err().to_string().contains("introuvable"));
        let unchanged: String = store
            .connect()
            .unwrap()
            .query_row("SELECT logo_path FROM settings WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(unchanged, stored);

        let removed = store
            .update_settings(serde_json::json!({"logo_path": null}))
            .expect("remove active logo");
        assert!(removed["logo_path"].is_null());
        let retained_assets: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM company_brand_assets", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            retained_assets, 1,
            "issued documents may still reference the immutable file"
        );
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
