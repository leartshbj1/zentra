//! Archive légale d'une année (GeBüV, art. 958f CO) : un ZIP qui réunit le
//! journal en CHF, le plan comptable, les factures et fiches de salaire en
//! PDF, les justificatifs enregistrés et l'historique d'audit, chaque fichier
//! avec son empreinte SHA-256. Le registre permet de revérifier l'intégrité
//! pendant les dix ans de conservation.

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
};

use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
    audit::{append_audit, verify_audit_chain},
    database::{now_iso, query_all, LocalStore},
    error::{command_error, AppError, AppResult},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Nom de fichier sûr dans une archive : lettres, chiffres, point, tiret.
fn safe_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    cleaned.trim_matches('_').chars().take(80).collect::<String>()
}

fn csv_cell(value: &Value) -> String {
    let text = match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    if text.contains([';', '"', '\n', '\r']) { format!("\"{}\"", text.replace('"', "\"\"")) } else { text }
}

fn csv(rows: &[Value], columns: &[&str]) -> Vec<u8> {
    let mut out = String::from("\u{feff}");
    out.push_str(&columns.join(";"));
    out.push_str("\r\n");
    for row in rows {
        out.push_str(&columns.iter().map(|column| csv_cell(&row[*column])).collect::<Vec<_>>().join(";"));
        out.push_str("\r\n");
    }
    out.into_bytes()
}

struct Member {
    path: String,
    bytes: Vec<u8>,
}

impl LocalStore {
    fn legal_archive_dir(&self) -> PathBuf {
        self.exports_dir.join("archive-legale")
    }

    /// Crée l'archive de l'année. « final » si l'exercice qui couvre l'année est clôturé.
    pub fn create_legal_archive(&self, year: i64) -> AppResult<Value> {
        if !(2000..=2100).contains(&year) {
            return Err(invalid("Année invalide."));
        }
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let (from, to) = (format!("{year}-01-01"), format!("{year}-12-31"));
        let closed: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM accounting_periods WHERE status='closed' AND date_from<=? AND date_to>=?)",
            params![from, to],
            |row| row.get(0),
        )?;
        let status = if closed { "final" } else { "provisional" };
        let mut members = Vec::<Member>::new();
        let mut missing = Vec::<Value>::new();

        let journal = query_all(
            &connection,
            "SELECT je.number AS entry_number,je.entry_date,je.description,je.source_type,a.code AS account_code,a.name AS account_name,
                    jl.debit_cents,jl.credit_cents,jl.currency,c.currency AS original_currency,o.debit_cents AS original_debit_cents,
                    o.credit_cents AS original_credit_cents,c.chf_per_unit_micro AS exchange_rate_micro,jl.memo
               FROM journal_lines_chf jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN accounts a ON a.id=jl.account_id
               LEFT JOIN journal_line_conversions c ON c.journal_line_id=jl.id LEFT JOIN journal_lines o ON o.id=c.journal_line_id
              WHERE je.entry_date BETWEEN ? AND ? ORDER BY je.entry_date,je.number,jl.line_order",
            params![from, to],
        )?;
        members.push(Member { path: "01_comptabilite/journal.csv".into(), bytes: csv(&journal, &["entry_number", "entry_date", "description", "source_type", "account_code", "account_name", "debit_cents", "credit_cents", "currency", "original_currency", "original_debit_cents", "original_credit_cents", "exchange_rate_micro", "memo"]) });
        let accounts = query_all(&connection, "SELECT code,name,account_type,normal_balance,report_section,active FROM accounts ORDER BY code", [])?;
        members.push(Member { path: "01_comptabilite/plan_comptable.csv".into(), bytes: csv(&accounts, &["code", "name", "account_type", "normal_balance", "report_section", "active"]) });
        let balance = query_all(
            &connection,
            "SELECT a.code,a.name,COALESCE(SUM(jl.debit_cents),0) AS debit_cents,COALESCE(SUM(jl.credit_cents),0) AS credit_cents
               FROM accounts a JOIN journal_lines_chf jl ON jl.account_id=a.id JOIN journal_entries je ON je.id=jl.journal_entry_id
              WHERE je.entry_date BETWEEN ? AND ? GROUP BY a.id ORDER BY a.code",
            params![from, to],
        )?;
        members.push(Member { path: "01_comptabilite/balance.csv".into(), bytes: csv(&balance, &["code", "name", "debit_cents", "credit_cents"]) });

        // Factures et avoirs émis dans l'année, tels que produits par Zentra.
        let invoices = query_all(&connection, "SELECT id,number,type FROM invoices WHERE number IS NOT NULL AND issue_date BETWEEN ? AND ? ORDER BY issue_date,number", params![from, to])?;
        let payslips = query_all(&connection, "SELECT id,period FROM payslips WHERE status IN ('valide','paye') AND period LIKE ? ORDER BY period,id", [format!("{year}-%")])?;
        let attachments = query_all(&connection, "SELECT id,entity_type,original_name FROM attachments WHERE created_at BETWEEN ? AND ? ORDER BY created_at,id", params![from, format!("{to}T23:59:59.999999999Z")])?;
        let audit = query_all(&connection, "SELECT rowid AS sequence,occurred_at,actor,action,entity_type,entity_id,previous_hash,entry_hash FROM audit_log WHERE occurred_at BETWEEN ? AND ? ORDER BY rowid", params![from, format!("{to}T23:59:59.999999999Z")])?;
        let chain = verify_audit_chain(&connection)?;
        drop(connection);

        for invoice in &invoices {
            let id = invoice["id"].as_str().unwrap_or_default();
            let number = invoice["number"].as_str().unwrap_or_default();
            match self.document_pdf_preview("invoices", id) {
                Ok(bytes) => members.push(Member { path: format!("02_documents/factures/{}.pdf", safe_name(number)), bytes }),
                Err(error) => missing.push(json!({ "document": format!("facture {number}"), "reason": error.to_string() })),
            }
        }
        for payslip in &payslips {
            let id = payslip["id"].as_str().unwrap_or_default();
            match self.document_pdf_preview("payslips", id) {
                Ok(bytes) => members.push(Member { path: format!("02_documents/salaires/{}-{}.pdf", safe_name(payslip["period"].as_str().unwrap_or_default()), &id[..8.min(id.len())]), bytes }),
                Err(error) => missing.push(json!({ "document": format!("fiche de salaire {}", payslip["period"].as_str().unwrap_or_default()), "reason": error.to_string() })),
            }
        }
        for attachment in &attachments {
            let id = attachment["id"].as_str().unwrap_or_default();
            let name = attachment["original_name"].as_str().unwrap_or_default();
            let read = self.verified_attachment_path(id).and_then(|path| Ok(fs::read(path)?));
            match read {
                Ok(bytes) => members.push(Member { path: format!("03_justificatifs/{}/{}-{}", safe_name(attachment["entity_type"].as_str().unwrap_or("autre")), &id[..8.min(id.len())], safe_name(name)), bytes }),
                Err(error) => missing.push(json!({ "document": format!("justificatif {name}"), "reason": error.to_string() })),
            }
        }
        members.push(Member { path: "04_audit/historique.csv".into(), bytes: csv(&audit, &["sequence", "occurred_at", "actor", "action", "entity_type", "entity_id", "previous_hash", "entry_hash"]) });
        members.push(Member { path: "04_audit/verification_chaine.json".into(), bytes: serde_json::to_vec_pretty(&chain)? });
        if !missing.is_empty() {
            members.push(Member { path: "05_a_completer.csv".into(), bytes: csv(&missing, &["document", "reason"]) });
        }

        let created_at = now_iso();
        let retain_until = format!("{}-12-31", year + 10);
        let readme = format!(
            "Archive légale Zentra — année {year}\r\n\r\n\
             Statut : {}\r\n\
             Créée le : {created_at}\r\n\
             À conserver jusqu'au : {retain_until} (10 ans, art. 958f CO et ordonnance concernant la tenue et la conservation des livres de comptes, Olico/GeBüV).\r\n\r\n\
             Contenu :\r\n\
             01_comptabilite : journal (montants en CHF, devise et cours d'origine), plan comptable, balance.\r\n\
             02_documents : factures, avoirs et fiches de salaire, tels que Zentra les produit.\r\n\
             03_justificatifs : pièces enregistrées pendant l'année, vérifiées contre leur empreinte d'origine.\r\n\
             04_audit : historique des modifications et vérification de sa chaîne d'empreintes.\r\n\
             05_a_completer.csv : documents qui n'ont pas pu être inclus, s'il y en a.\r\n\r\n\
             Vérification : chaque fichier figure dans SHA256SUMS avec son empreinte SHA-256. Zentra revérifie l'archive\r\n\
             depuis Comptabilité > Archive légale ; tout autre outil SHA-256 donne le même résultat.\r\n\
             Conservez une copie sur un second support (disque externe ou stockage en ligne). Un archivage est\r\n\
             « final » lorsque l'exercice qui couvre l'année est clôturé ; sinon il est provisoire.\r\n",
            if closed { "final (exercice clôturé)" } else { "provisoire (exercice encore ouvert)" }
        );
        members.insert(0, Member { path: "LISEZMOI.txt".into(), bytes: readme.into_bytes() });
        let manifest = json!({
            "schema": "zentra-legal-archive-v1", "year": year, "status": status, "created_at": created_at, "retain_until": retain_until,
            "counts": { "journal_lines": journal.len(), "invoices": invoices.len(), "payslips": payslips.len(), "attachments": attachments.len(), "audit_entries": audit.len(), "missing": missing.len() },
            "audit_chain_valid": chain["valid"],
        });
        members.push(Member { path: "manifest.json".into(), bytes: serde_json::to_vec_pretty(&manifest)? });
        let sums: String = members.iter().map(|member| format!("{}  {}\n", sha256(&member.bytes), member.path)).collect();
        members.push(Member { path: "SHA256SUMS".into(), bytes: sums.into_bytes() });

        let directory = self.legal_archive_dir();
        fs::create_dir_all(&directory)?;
        let file_name = format!("zentra-archive-legale-{year}-{}-{}.zip", Utc::now().format("%Y%m%dT%H%M%SZ"), &Uuid::new_v4().to_string()[..8]);
        let destination = directory.join(&file_name);
        let file = OpenOptions::new().write(true).create_new(true).open(&destination)?;
        let written = (|| -> AppResult<()> {
            let mut archive = ZipWriter::new(file);
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).unix_permissions(0o600);
            for member in &members {
                archive.start_file(&member.path, options)?;
                archive.write_all(&member.bytes)?;
            }
            archive.finish()?.sync_all()?;
            Ok(())
        })();
        if let Err(error) = written {
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
        let bytes = fs::read(&destination)?;
        let id = Uuid::new_v4().to_string();
        let mut connection = self.connect()?;
        let tx = connection.transaction()?;
        let recorded = (|| -> AppResult<()> {
            tx.execute(
                "INSERT INTO company_local_legal_archives(id,year,status,file_name,sha256,size_bytes,files_count,missing_count,retain_until,created_at,last_verified_at,last_verified_ok)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,1)",
                params![id, year, status, file_name, sha256(&bytes), bytes.len() as i64, members.len() as i64, missing.len() as i64, retain_until, created_at, created_at],
            )?;
            append_audit(&tx, "create", "legal_archive", &id, &json!({ "year": year, "status": status, "file_name": file_name, "sha256": sha256(&bytes), "missing": missing.len() }))?;
            Ok(())
        })();
        if let Err(error) = recorded {
            drop(tx);
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
        tx.commit()?;
        Ok(json!({ "id": id, "status": status, "path": destination.to_string_lossy(), "files": members.len(), "missing": missing.len() }))
    }

    pub fn list_legal_archives(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let mut rows = query_all(&connection, "SELECT * FROM company_local_legal_archives ORDER BY year DESC,created_at DESC", [])?;
        for row in &mut rows {
            let path = self.legal_archive_dir().join(row["file_name"].as_str().unwrap_or_default());
            row["present"] = json!(path.is_file());
            row["path"] = json!(path.to_string_lossy());
        }
        let years = query_all(&connection, "SELECT DISTINCT CAST(strftime('%Y',entry_date) AS INTEGER) AS year FROM journal_entries ORDER BY 1 DESC LIMIT 12", [])?;
        Ok(json!({ "archives": rows, "yearsWithEntries": years.iter().filter_map(|row| row["year"].as_i64()).collect::<Vec<_>>() }))
    }

    /// Revérifie l'empreinte du ZIP et celle de chaque fichier listé dans SHA256SUMS.
    pub fn verify_legal_archive(&self, id: &str) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let (file_name, expected): (String, String) = connection
            .query_row("SELECT file_name,sha256 FROM company_local_legal_archives WHERE id=?", [id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?
            .ok_or_else(|| invalid("Archive introuvable."))?;
        let path = self.legal_archive_dir().join(&file_name);
        let outcome = (|| -> AppResult<(bool, String)> {
            let bytes = fs::read(&path).map_err(|_| invalid("Le fichier de l’archive est introuvable sur cet appareil."))?;
            if sha256(&bytes) != expected {
                return Ok((false, "L’empreinte du fichier ne correspond plus : l’archive a été modifiée.".into()));
            }
            let mut archive = ZipArchive::new(std::io::Cursor::new(bytes))?;
            let mut sums = String::new();
            archive.by_name("SHA256SUMS")?.read_to_string(&mut sums)?;
            for line in sums.lines().filter(|line| !line.is_empty()) {
                let (hash, name) = line.split_once("  ").ok_or_else(|| invalid("SHA256SUMS illisible."))?;
                let mut content = Vec::new();
                archive.by_name(name)?.read_to_end(&mut content)?;
                if sha256(&content) != hash {
                    return Ok((false, format!("Le fichier {name} ne correspond plus à son empreinte.")));
                }
            }
            Ok((true, String::new()))
        })();
        let (ok, detail) = match outcome {
            Ok(result) => result,
            Err(error) => (false, error.to_string()),
        };
        drop(connection);
        let mut connection = self.connect()?;
        let tx = connection.transaction()?;
        let now = now_iso();
        tx.execute("UPDATE company_local_legal_archives SET last_verified_at=?,last_verified_ok=? WHERE id=?", params![now, ok, id])?;
        append_audit(&tx, "verify", "legal_archive", id, &json!({ "ok": ok, "detail": detail }))?;
        tx.commit()?;
        Ok(json!({ "ok": ok, "detail": detail, "verifiedAt": now }))
    }
}

#[tauri::command]
pub async fn create_legal_archive(state: tauri::State<'_, LocalStore>, year: i64) -> Result<Value, String> {
    crate::commands::run_locked_local_operation(state.inner().clone(), move |store| {
        store.require_write_access()?;
        store.create_legal_archive(year)
    })
    .await
}

#[tauri::command]
pub fn list_legal_archives(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_legal_archives().map_err(command_error)
}

#[tauri::command]
pub async fn verify_legal_archive(state: tauri::State<'_, LocalStore>, id: String) -> Result<Value, String> {
    crate::commands::run_locked_local_operation(state.inner().clone(), move |store| store.verify_legal_archive(&id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_cells_are_safe() {
        assert_eq!(safe_name("F-2026/014 été.pdf"), "F-2026_014_été.pdf");
        assert_eq!(safe_name("../../etc"), ".._.._etc");
        assert_eq!(csv_cell(&json!("a;b")), "\"a;b\"");
        assert_eq!(csv_cell(&json!(12)), "12");
    }

    #[test]
    fn an_archive_lists_every_file_and_detects_a_change() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "legal-archive-test").unwrap();
        let created = store.create_legal_archive(2026).unwrap();
        assert_eq!(created["status"], "provisional");
        let path = PathBuf::from(created["path"].as_str().unwrap());
        let mut archive = ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
        let mut sums = String::new();
        archive.by_name("SHA256SUMS").unwrap().read_to_string(&mut sums).unwrap();
        for name in ["LISEZMOI.txt", "01_comptabilite/journal.csv", "04_audit/historique.csv", "manifest.json"] {
            assert!(sums.contains(&format!("  {name}\n")), "{name}");
        }
        drop(archive);
        let list = store.list_legal_archives().unwrap();
        let id = list["archives"][0]["id"].as_str().unwrap().to_owned();
        assert_eq!(list["archives"][0]["retain_until"], "2036-12-31");
        assert_eq!(list["archives"][0]["present"], true);
        assert_eq!(store.verify_legal_archive(&id).unwrap()["ok"], true);
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        fs::write(&path, bytes).unwrap();
        assert_eq!(store.verify_legal_archive(&id).unwrap()["ok"], false);
        fs::remove_file(&path).unwrap();
        let missing = store.verify_legal_archive(&id).unwrap();
        assert_eq!(missing["ok"], false);
        assert!(missing["detail"].as_str().unwrap().contains("introuvable"));
    }
}
