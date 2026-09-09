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
    #[error("Enregistrement introuvable : {0}")]
    NotFound(String),
    #[error("Le questionnaire initial doit être terminé avant cette opération.")]
    OnboardingRequired,
    #[error("Chemin refusé car il sort du dossier local autorisé : {0}")]
    UnsafePath(PathBuf),
    #[error("Cette opération n'est pas prise en charge sur ce système.")]
    UnsupportedPlatform,
    #[error("La synchronisation est suspendue. Les modifications locales sont conservées.")]
    BusinessSyncPaused,
    #[error("Les données reçues seront appliquées après la saisie en cours.")]
    BusinessInstallDeferred,
    #[error("Les numéros réservés pour {prefix}-{year} sont épuisés sur cet appareil. Reconnectez Zentra pour en obtenir de nouveaux. Le brouillon reste disponible.")]
    NumberRangeRequired {
        organization: String,
        prefix: String,
        year: i64,
        minimum: i64,
    },
}

pub type AppResult<T> = Result<T, AppError>;

pub fn command_error(error: AppError) -> String {
    error.to_string()
}
