//! Offre chiffrée exportée pour un bureau d'architecte : texte à champs
//! séparés « ; » (structure NPK) préparé par l'écran depuis le devis. Ici le
//! fichier est seulement contrôlé, écrit à l'endroit choisi et journalisé.

use std::{fs, io::Write, path::PathBuf};

use rusqlite::TransactionBehavior;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

fn destination(raw: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(raw.trim());
    if raw.trim().is_empty() || !path.is_absolute() {
        return Err(invalid("Choisissez un emplacement local pour l'offre."));
    }
    if path.extension().and_then(|value| value.to_str()).is_none_or(|value| !value.eq_ignore_ascii_case("csv")) {
        return Err(invalid("L'offre chiffrée doit porter l'extension .csv."));
    }
    if !path.parent().is_some_and(|parent| parent.is_dir()) {
        return Err(invalid("Le dossier de destination n'existe pas."));
    }
    Ok(path)
}

/// L'en-tête attendu de l'offre préparée par l'écran (après la ligne de titre).
fn well_formed(content: &str) -> bool {
    content.len() <= 10_000_000
        && content.lines().nth(1).is_some_and(|header| header.trim_start_matches('\u{feff}') == "Position;Texte;Unité;Quantité;Prix unitaire;Rabais %;Montant")
}

impl LocalStore {
    pub fn export_offer_text(&self, quote_id: &str, destination_path: &str, content: &str) -> AppResult<Value> {
        let path = destination(destination_path)?;
        if !well_formed(content) {
            return Err(invalid("L'offre préparée est incomplète."));
        }
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM quotes WHERE id=?)", [quote_id], |row| row.get(0))?;
        drop(connection);
        if !exists {
            return Err(invalid("Devis introuvable."));
        }
        let mut file = fs::File::create(&path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        let sha = format!("{:x}", Sha256::digest(content.as_bytes()));
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        append_audit(&tx, "export", "quote_offer", quote_id, &json!({ "file": path.file_name().and_then(|value| value.to_str()), "sha256": sha, "at": now_iso() }))?;
        tx.commit()?;
        Ok(json!({ "path": path.to_string_lossy(), "sha256": sha }))
    }
}

#[tauri::command]
pub fn export_offer_text(state: tauri::State<'_, LocalStore>, quote_id: String, destination: String, content: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.export_offer_text(&quote_id, &destination, &content).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_priced_offer_is_written_only_where_and_as_expected() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "offer-export-test").unwrap();
        let quote = store.create_record("quotes", json!({"title":"Villa Dupont"})).unwrap()["id"].as_str().unwrap().to_owned();
        let content = "\u{feff}Offre Villa Dupont\r\nPosition;Texte;Unité;Quantité;Prix unitaire;Rabais %;Montant\r\n241.111;Enduit;m²;350;34.00;0;11900.00\r\n";
        let target = temporary.path().join("offre.csv");
        let written = store.export_offer_text(&quote, target.to_str().unwrap(), content).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), content);
        assert_eq!(written["sha256"].as_str().unwrap().len(), 64);
        assert!(store.export_offer_text(&quote, temporary.path().join("offre.txt").to_str().unwrap(), content).is_err());
        assert!(store.export_offer_text(&quote, target.to_str().unwrap(), "pas une offre").is_err());
        assert!(store.export_offer_text("inconnu", target.to_str().unwrap(), content).is_err());
        assert!(store.export_offer_text(&quote, "relatif.csv", content).is_err());
    }
}
