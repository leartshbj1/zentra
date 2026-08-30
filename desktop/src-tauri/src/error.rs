use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Erreur de base de données locale : {0}")]
    Database(#[from] rusqlite::Error),
    #[error("Erreur de fichier local : {0}")]
    Io(#[from] std::io::Error),
    #[error("Données JSON invalides : {0}")]
    Json(#[from] serde_json::Error),
    #[error("Archive Elyko invalide : {0}")]
    Archive(#[from] zip::result::ZipError),
    #[error("Champ invalide : {0}")]
    Validation(String),
    #[error("Enregistrement introuvable : {0}")]
    NotFound(String),
    #[error("Le questionnaire initial doit être terminé avant cette opération.")]
    OnboardingRequired,
    #[error("Chemin refusé car il sort du dossier local autorisé : {0}")]
    UnsafePath(PathBuf),
    #[error("Cette opération n'est pas prise en charge sur ce système.")]
    UnsupportedPlatform,
}

pub type AppResult<T> = Result<T, AppError>;

pub fn command_error(error: AppError) -> String {
    error.to_string()
}
