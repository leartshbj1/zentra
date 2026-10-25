//! Fichier d'écritures pour le logiciel de la fiduciaire (Banana, Crésus,
//! Abacus, WinBIZ, CSV). L'app calcule le contenu depuis le journal ; cette
//! commande vérifie la destination, écrit le fichier choisi par l'utilisateur
//! et garde la trace de l'export (période, format, empreinte) dans l'audit.

use std::{fs, io::Write, path::PathBuf};

use rusqlite::TransactionBehavior;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    accounting::validate_date,
    audit::append_audit,
    database::{now_iso, LocalStore},
    error::{command_error, AppError, AppResult},
};

const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountingExportInput {
    pub destination: String,
    pub format: String,
    pub date_from: String,
    pub date_to: String,
    pub entries: i64,
    pub content: String,
}

fn extension_for(format: &str) -> AppResult<&'static str> {
    Ok(match format {
        "banana" | "cresus" => "txt",
        "abacus" | "winbiz" | "csv" => "csv",
        _ => return Err(invalid("Choisissez le logiciel de la fiduciaire.")),
    })
}

fn destination(raw: &str, extension: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(raw.trim());
    if raw.trim().is_empty() || !path.is_absolute() {
        return Err(invalid("Choisissez un emplacement local pour le fichier d'écritures."));
    }
    if path.extension().and_then(|value| value.to_str()).is_none_or(|value| !value.eq_ignore_ascii_case(extension)) {
        return Err(invalid(format!("Le fichier d'écritures doit porter l'extension .{extension}.")));
    }
    let parent = path.parent().ok_or_else(|| invalid("Le dossier de destination est invalide."))?;
    if !parent.is_dir() {
        return Err(invalid("Le dossier de destination n'existe pas."));
    }
    Ok(path)
}

impl LocalStore {
    pub fn save_accounting_export(&self, input: AccountingExportInput) -> AppResult<Value> {
        let extension = extension_for(&input.format)?;
        let path = destination(&input.destination, extension)?;
        validate_date(&input.date_from, "date_from")?;
        validate_date(&input.date_to, "date_to")?;
        if input.date_from > input.date_to {
            return Err(invalid("La période commence après sa fin."));
        }
        if input.content.is_empty() || input.content.len() > MAX_EXPORT_BYTES || input.content.contains('\0') {
            return Err(invalid("Le fichier d'écritures préparé est vide ou trop grand."));
        }
        if !(0..=1_000_000).contains(&input.entries) {
            return Err(invalid("Le nombre d'écritures est invalide."));
        }
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        drop(connection);
        let mut file = fs::File::create(&path)?;
        file.write_all(input.content.as_bytes())?;
        file.sync_all()?;
        let sha256 = format!("{:x}", Sha256::digest(input.content.as_bytes()));
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        append_audit(
            &tx,
            "export",
            "accounting_export",
            &format!("{}:{}:{}", input.format, input.date_from, input.date_to),
            &json!({
                "format": input.format,
                "date_from": input.date_from,
                "date_to": input.date_to,
                "entries": input.entries,
                "file": path.file_name().and_then(|value| value.to_str()),
                "sha256": sha256,
                "at": now_iso(),
            }),
        )?;
        tx.commit()?;
        Ok(json!({ "path": path.to_string_lossy(), "sha256": sha256 }))
    }
}

#[tauri::command]
pub fn save_accounting_export(state: tauri::State<'_, LocalStore>, input: AccountingExportInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.save_accounting_export(input).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(destination: &str, format: &str) -> AccountingExportInput {
        AccountingExportInput {
            destination: destination.into(),
            format: format.into(),
            date_from: "2026-01-01".into(),
            date_to: "2026-12-31".into(),
            entries: 2,
            content: "Date\tDoc\r\n2026-03-20\tJ-1\r\n".into(),
        }
    }

    #[test]
    fn writes_the_file_and_records_the_export() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "accounting-export-test").unwrap();
        let path = temporary.path().join("ecritures.txt");
        let saved = store.save_accounting_export(input(path.to_str().unwrap(), "banana")).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "Date\tDoc\r\n2026-03-20\tJ-1\r\n");
        assert_eq!(saved["sha256"].as_str().map(str::len), Some(64));
        let audits: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM audit_log WHERE entity_type='accounting_export' AND action='export'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(audits, 1);
    }

    #[test]
    fn refuses_a_wrong_extension_format_or_period() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "accounting-export-test").unwrap();
        let csv = temporary.path().join("ecritures.csv");
        assert!(store.save_accounting_export(input(csv.to_str().unwrap(), "banana")).is_err());
        assert!(store.save_accounting_export(input(csv.to_str().unwrap(), "sage")).is_err());
        let mut late = input(csv.to_str().unwrap(), "csv");
        late.date_from = "2027-01-01".into();
        assert!(store.save_accounting_export(late).is_err());
        assert!(store.save_accounting_export(input("relative.csv", "csv")).is_err());
        assert!(!csv.exists());
    }
}
