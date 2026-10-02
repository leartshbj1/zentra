use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Erreur de base de données locale : {0}")]
    Database(#[from] rusqlite::Error),
    #[error("Erreur de fichier local : {0}")]
    Io(#[from] std::io::Error),
    #[error("Données JSON invalides : {0}")]
    Json(#[from] serde_json::Error),
    #[error("Formulaire PDF invalide : {0}")]
    Pdf(#[from] lopdf::Error),
    #[error("Archive Zentra invalide : {0}")]
    Archive(#[from] zip::result::ZipError),
    #[error("Champ invalide : {0}")]
    Validation(String),
    #[error("{0}")]
    Remote(String),
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
    crate::diagnostics::record_native_error(&error);
    error.to_string()
}

/// Called only after the asynchronous command has finished and released its
/// business guards. Log persistence must not block its async executor or
/// replace the original command result if the journal is unavailable.
pub(crate) async fn finish_async_command<T>(result: AppResult<T>) -> Result<T, String> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let message = error.to_string();
            let prepared = crate::diagnostics::prepare_native_error(&error);
            drop(error);
            crate::diagnostics::record_prepared_native_error(prepared).await;
            Err(message)
        }
    }
}
