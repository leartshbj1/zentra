use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

use chrono::{NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use crate::{
    accounting_closure::{
        balance_sheet_report, ensure_base_currency_for_ranges, income_statement_report,
    },
    audit::{append_audit, verify_audit_chain},
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
    models::PeriodFilter,
};

const REVIEW_SCHEMA: &str = "elyko.fiduciary-pre-closing.v1";
const EXPORT_SCHEMA: &str = "elyko.fiduciary-package-export.v1";
const FINALIZATION_SCHEMA: &str = "elyko.fiduciary-period-finalization.v1";
const SOURCE_SCHEMA: &str = "elyko.fiduciary-source.v1";
const MANIFEST_SCHEMA: &str = "elyko.fiduciary-manifest.v1";
const DISCLAIMER: &str = "Ce dossier facilite la revue et la conservation locale des données comptables. Il ne constitue ni une certification, ni une garantie de conformité légale, fiscale ou professionnelle. L'entreprise reste responsable de la clôture, de l'annexe, des décisions d'approbation, de la conservation durable et de la validation par les personnes compétentes.";

#[derive(Debug)]
struct ClosingSnapshot {
    journal: Value,
    ledger: Value,
    trial_balance: Value,
    balance_sheet: Value,
    income_statement: Value,
    piece_index: Value,
    source_sha256: String,
}

#[derive(Debug)]
struct StoredReview {
    id: String,
    period_id: String,
    status: String,
    source_sha256: String,
    checks: Value,
    report: Value,
}

#[derive(Debug)]
struct ArchiveMember {
    path: String,
    bytes: Vec<u8>,
}

impl LocalStore {
    /// Fige une revue vérifiable pour un exercice enregistré aux bornes exactes.
    ///
    /// Le verrou global de `LocalStore` doit être détenu par le wrapper Tauri, comme pour les
    /// autres commandes mutantes. Cette méthode ne prend pas elle-même le verrou afin d'éviter
    /// un interblocage avec les wrappers existants.
    pub fn prepare_fiduciary_pre_closing(&self, filter: PeriodFilter) -> AppResult<Value> {
        let (date_from, date_to) = strict_period_filter(&filter)?;
        // Le rapport de continuité réutilise volontairement l'implémentation comptable existante.
        // Le wrapper de commande tient le verrou d'opération pendant ces deux lectures.
        let continuity = self.get_accounting_continuity()?;

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let period = exact_period(&transaction, &date_from, &date_to)?;
        let snapshot = self.build_closing_snapshot(&transaction, &period, &date_from, &date_to)?;
        let audit_verification = verify_audit_chain(&transaction)?;

        let unbalanced_entries: i64 = transaction.query_row(
            r#"SELECT COUNT(*) FROM (
                 SELECT je.id FROM journal_entries je
                 JOIN journal_lines jl ON jl.journal_entry_id=je.id
                 WHERE je.entry_date BETWEEN ? AND ?
                 GROUP BY je.id HAVING SUM(jl.debit_cents)<>SUM(jl.credit_cents))"#,
            params![date_from, date_to],
            |row| row.get(0),
        )?;
        let trial_balanced = snapshot.trial_balance["balanced"] == true;
        let journal_balanced = unbalanced_entries == 0 && trial_balanced;
        let balance_sheet_balanced = snapshot.balance_sheet["balanced"] == true;
        let audit_chain_valid = audit_verification["valid"] == true;
        let attachments_total = snapshot.piece_index["attachments_total"]
            .as_i64()
            .unwrap_or(0);
        let attachments_verified = snapshot.piece_index["attachments_verified"]
            .as_i64()
            .unwrap_or(0);
        let attachment_issues = snapshot.piece_index["attachment_issues"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let continuity_ready = continuity["total_anomalies"].as_i64() == Some(0);
        let ready_for_final = journal_balanced
            && balance_sheet_balanced
            && audit_chain_valid
            && attachments_total == attachments_verified
            && attachment_issues.is_empty()
            && continuity_ready;
        let package_status = if period["status"] == "closed" && ready_for_final {
            "FINAL"
        } else {
            "DRAFT"
        };
        let summary = closing_summary(&snapshot);
        let checks = json!({
            "ready_for_final": ready_for_final,
            "journal_balanced": journal_balanced,
            "balance_sheet_balanced": balance_sheet_balanced,
            "audit_chain_valid": audit_chain_valid,
            "attachments_total": attachments_total,
            "attachments_verified": attachments_verified,
            "attachment_issues": attachment_issues,
            "continuity": continuity,
        });
        let review_id = Uuid::new_v4().to_string();
        let prepared_at = now_iso();
        let response = json!({
            "schema": REVIEW_SCHEMA,
            "review_id": review_id,
            "prepared_at": prepared_at,
            "period": period,
            "source_sha256": snapshot.source_sha256,
            "package_status_if_exported": package_status,
            "checks": checks,
            "summary": summary,
            "disclaimer": DISCLAIMER,
        });
        let checks_json = serde_json::to_string(&response["checks"])?;
        let report_json = serde_json::to_string(&response)?;
        ensure_json_column_size(&checks_json, 1_000_000, "contrôles de pré-clôture")?;
        ensure_json_column_size(&report_json, 4_000_000, "rapport de pré-clôture")?;

        transaction.execute(
            r#"INSERT INTO closing_reviews(
                 id,accounting_period_id,status,source_sha256,checks_json,report_json,created_at,consumed_at)
               VALUES(?,?,'prepared',?,?,?,?,NULL)"#,
            params![
                review_id,
                period_string(&period, "id")?,
                snapshot.source_sha256,
                checks_json,
                report_json,
                prepared_at,
            ],
        )?;
        append_audit(
            &transaction,
            "prepare",
            "closing_review",
            &review_id,
            &json!({
                "accounting_period_id": period_string(&period, "id")?,
                "source_sha256": snapshot.source_sha256,
                "ready_for_final": ready_for_final,
            }),
        )?;
        transaction.commit()?;
        Ok(response)
    }

    /// Verrouille l'exercice uniquement si la revue préparée correspond encore exactement aux
    /// données sources. La revue reste `prepared` afin de permettre l'export FINAL immédiatement
    /// après la clôture.
    pub fn finalize_accounting_period_with_review(
        &self,
        period_id: &str,
        review_id: &str,
    ) -> AppResult<Value> {
        validate_identifier(period_id, "period_id")?;
        validate_canonical_uuid(review_id, "review_id")?;
        // `source_sha256` fige les états et les pièces, mais la continuité contient aussi des
        // contrôles métier qui ne font volontairement pas partie de ces états (p. ex. les
        // opérations sans écriture ou les comptes de liaison). Ils doivent donc être rejoués au
        // moment irréversible, et non seulement faire confiance au résultat stocké dans la revue.
        let live_continuity = self.get_accounting_continuity()?;
        if live_continuity["total_anomalies"].as_i64() != Some(0) {
            return Err(AppError::Validation(
                "La continuité comptable a changé depuis la pré-clôture. Corrigez les anomalies puis préparez une nouvelle revue."
                    .into(),
            ));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let review = load_review(&transaction, review_id)?;
        ensure_review_prepared(&review)?;
        if review.period_id != period_id {
            return Err(AppError::Validation(
                "La revue de pré-clôture ne correspond pas à cet exercice.".into(),
            ));
        }
        if review.checks["ready_for_final"] != true {
            return Err(AppError::Validation(
                "La revue de pré-clôture contient encore des contrôles bloquants.".into(),
            ));
        }
        let period = period_by_id(&transaction, period_id)?;
        let date_from = period_string(&period, "date_from")?;
        let date_to = period_string(&period, "date_to")?;
        validate_strict_date(date_from, "date_from")?;
        validate_strict_date(date_to, "date_to")?;
        let snapshot = self.build_closing_snapshot(&transaction, &period, date_from, date_to)?;
        ensure_same_source(&review, &snapshot)?;
        // La chaîne d'audit est exclue de l'empreinte source afin que des événements légitimes
        // puissent être ajoutés entre la revue et la décision. Son intégrité doit néanmoins être
        // vérifiée à nouveau dans la transaction qui précède immédiatement le verrouillage.
        let audit_verification = verify_audit_chain(&transaction)?;
        if audit_verification["valid"] != true {
            return Err(AppError::Validation(
                "La chaîne d'audit n'est plus valide. La clôture définitive est bloquée.".into(),
            ));
        }
        transaction.commit()?;

        // Cette méthode existante reste l'autorité de clôture : historique fermé, concordance des
        // écritures automatiques, sources manquantes, équilibre et monnaie CHF y sont revérifiés.
        let closed_period = self.close_accounting_period(period_id)?;
        Ok(json!({
            "schema": FINALIZATION_SCHEMA,
            "review_id": review_id,
            "source_sha256": review.source_sha256,
            "period": closed_period,
        }))
    }

    /// Produit un dossier ZIP local, à création exclusive, puis consomme la revue dans SQLite.
    /// Le statut FINAL n'est émis que pour un exercice déjà verrouillé et une revue prête.
    pub fn export_fiduciary_closing_zip(
        &self,
        review_id: &str,
        app_version: &str,
    ) -> AppResult<Value> {
        validate_canonical_uuid(review_id, "review_id")?;
        let app_version = validated_app_version(app_version)?;
        // Le statut FINAL décrit l'état au moment de l'export, pas uniquement celui de la revue
        // préparée. Rejouer la continuité évite qu'un contrôle métier non couvert par
        // `source_sha256` devienne périmé entre les deux actions.
        let live_continuity = self.get_accounting_continuity()?;
        let live_continuity_ready = live_continuity["total_anomalies"].as_i64() == Some(0);
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let review = load_review(&transaction, review_id)?;
        ensure_review_prepared(&review)?;
        let period = period_by_id(&transaction, &review.period_id)?;
        let date_from = period_string(&period, "date_from")?;
        let date_to = period_string(&period, "date_to")?;
        validate_strict_date(date_from, "date_from")?;
        validate_strict_date(date_to, "date_to")?;
        let snapshot = self.build_closing_snapshot(&transaction, &period, date_from, date_to)?;
        ensure_same_source(&review, &snapshot)?;

        let ready_for_final = review.checks["ready_for_final"] == true;
        let package_status =
            if period["status"] == "closed" && ready_for_final && live_continuity_ready {
                "FINAL"
            } else {
                "DRAFT"
            };
        let audit_verification = verify_audit_chain(&transaction)?;
        let audit_entries = query_all(
            &transaction,
            r#"SELECT rowid AS sequence,id,occurred_at,actor,action,entity_type,entity_id,
                      payload_json,previous_hash,entry_hash
               FROM audit_log ORDER BY rowid"#,
            [],
        )?;
        let created_at = now_iso();
        let export_id = Uuid::new_v4().to_string();
        let mut members = build_payload_members(
            &snapshot,
            &review,
            &period,
            package_status,
            &created_at,
            &app_version,
            audit_entries,
            audit_verification,
        )?;
        let manifest = build_manifest(
            &members,
            &review,
            &period,
            package_status,
            &created_at,
            &app_version,
        );
        let manifest_bytes = pretty_json_bytes(&manifest)?;
        let manifest_sha256 = sha256_bytes(&manifest_bytes);
        let mut sums = String::new();
        for member in &members {
            sums.push_str(&format!(
                "{}  {}\n",
                sha256_bytes(&member.bytes),
                member.path
            ));
        }
        sums.push_str(&format!("{manifest_sha256}  manifest.json\n"));
        members.push(ArchiveMember {
            path: "manifest.json".into(),
            bytes: manifest_bytes,
        });
        members.push(ArchiveMember {
            path: "SHA256SUMS".into(),
            bytes: sums.into_bytes(),
        });

        fs::create_dir_all(&self.exports_dir)?;
        let file_name = format!(
            "zentra-dossier-fiduciaire-{}-{}-{}-{}-{}.zip",
            date_from,
            date_to,
            package_status.to_ascii_lowercase(),
            Utc::now().format("%Y%m%dT%H%M%SZ"),
            export_id
        );
        let destination = self.exports_dir.join(&file_name);
        write_zip_exclusive(&destination, &members)?;
        let file_count = i64::try_from(members.len())
            .map_err(|_| AppError::Validation("Le dossier contient trop de fichiers.".into()))?;

        let database_result = (|| -> AppResult<()> {
            transaction.execute(
                r#"INSERT INTO closing_package_exports(
                     id,accounting_period_id,closing_review_id,package_status,source_sha256,
                     manifest_sha256,file_name,created_at)
                   VALUES(?,?,?,?,?,?,?,?)"#,
                params![
                    export_id,
                    review.period_id,
                    review.id,
                    package_status,
                    review.source_sha256,
                    manifest_sha256,
                    file_name,
                    created_at,
                ],
            )?;
            let changed = transaction.execute(
                r#"UPDATE closing_reviews SET status='consumed',consumed_at=?
                   WHERE id=? AND status='prepared'"#,
                params![created_at, review.id],
            )?;
            if changed != 1 {
                return Err(AppError::Validation(
                    "La revue de pré-clôture a déjà été consommée.".into(),
                ));
            }
            append_audit(
                &transaction,
                "export",
                "fiduciary_closing_package",
                &export_id,
                &json!({
                    "accounting_period_id": review.period_id,
                    "closing_review_id": review.id,
                    "package_status": package_status,
                    "source_sha256": review.source_sha256,
                    "manifest_sha256": manifest_sha256,
                    "file_name": file_name,
                }),
            )?;
            transaction.commit()?;
            Ok(())
        })();
        if let Err(error) = database_result {
            let _ = fs::remove_file(&destination);
            return Err(error);
        }

        Ok(json!({
            "schema": EXPORT_SCHEMA,
            "export_id": export_id,
            "review_id": review_id,
            "created_at": created_at,
            "period": period,
            "package_status": package_status,
            "source_sha256": review.source_sha256,
            "manifest_sha256": manifest_sha256,
            "file_name": file_name,
            "path": destination.to_string_lossy(),
            "file_count": file_count,
            "disclaimer": DISCLAIMER,
        }))
    }

    fn build_closing_snapshot(
        &self,
        connection: &Connection,
        period: &Value,
        date_from: &str,
        date_to: &str,
    ) -> AppResult<ClosingSnapshot> {
        validate_strict_chf(connection, date_to)?;
        ensure_base_currency_for_ranges(connection, &[("0001-01-01", date_to)])?;
        let filter = PeriodFilter {
            date_from: Some(date_from.into()),
            date_to: Some(date_to.into()),
        };
        let company = one_value(
            connection,
            r#"SELECT company_name,legal_form,owner_name,address_line1,address_line2,postal_code,
                      city,canton,country,uid_number,vat_number,currency
               FROM settings WHERE id=1"#,
            [],
            "settings/1",
        )?;
        let entries = query_all(
            connection,
            r#"SELECT je.*,
                      EXISTS(SELECT 1 FROM journal_entries reversal WHERE reversal.reversal_of=je.id)
                      AS has_reversal
               FROM journal_entries je WHERE je.entry_date BETWEEN ? AND ?
               ORDER BY je.entry_date,je.number,je.id"#,
            params![date_from, date_to],
        )?;
        let journal_lines = query_all(
            connection,
            r#"SELECT jl.rowid AS line_sequence,jl.*,a.code AS account_code,a.name AS account_name,
                      a.account_type,a.normal_balance,a.report_section,je.number AS entry_number,
                      je.entry_date,je.description AS entry_description,je.source_type,je.source_id,
                      je.source_event,je.reversal_of
               FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id
               JOIN journal_entries je ON je.id=jl.journal_entry_id
               WHERE je.entry_date BETWEEN ? AND ?
               ORDER BY je.entry_date,je.number,jl.rowid,jl.id"#,
            params![date_from, date_to],
        )?;
        let ledger_lines = query_all(
            connection,
            r#"SELECT jl.rowid AS line_sequence,jl.*,a.code AS account_code,a.name AS account_name,
                      a.account_type,a.normal_balance,a.report_section,je.number AS entry_number,
                      je.entry_date,je.description AS entry_description,je.source_type,je.source_id,
                      je.source_event,je.reversal_of
               FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id
               JOIN journal_entries je ON je.id=jl.journal_entry_id
               WHERE je.entry_date BETWEEN ? AND ?
               ORDER BY a.code,je.entry_date,je.number,jl.rowid,jl.id"#,
            params![date_from, date_to],
        )?;
        let trial_rows = query_all(
            connection,
            r#"SELECT a.id,a.code,a.name,a.account_type,a.normal_balance,a.report_section,
                      COALESCE(SUM(jl.debit_cents),0) AS debit_cents,
                      COALESCE(SUM(jl.credit_cents),0) AS credit_cents,
                      MAX(COALESCE(SUM(jl.debit_cents),0)-COALESCE(SUM(jl.credit_cents),0),0)
                      AS debit_balance_cents,
                      MAX(COALESCE(SUM(jl.credit_cents),0)-COALESCE(SUM(jl.debit_cents),0),0)
                      AS credit_balance_cents
               FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id
               LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id
               WHERE je.entry_date BETWEEN ? AND ?
               GROUP BY a.id ORDER BY a.code,a.id"#,
            params![date_from, date_to],
        )?;
        let debit_cents: i64 = trial_rows
            .iter()
            .filter_map(|row| row["debit_cents"].as_i64())
            .sum();
        let credit_cents: i64 = trial_rows
            .iter()
            .filter_map(|row| row["credit_cents"].as_i64())
            .sum();
        let stable_period = json!({
            "id": period_string(period, "id")?,
            "name": period_string(period, "name")?,
            "date_from": date_from,
            "date_to": date_to,
        });
        let journal = json!({
            "period": stable_period,
            "currency": "CHF",
            "entries": entries,
            "lines": journal_lines,
        });
        let ledger = json!({
            "period": stable_period,
            "currency": "CHF",
            "accounts": trial_rows,
            "lines": ledger_lines,
        });
        let trial_balance = json!({
            "period": stable_period,
            "currency": "CHF",
            "rows": trial_rows,
            "debit_cents": debit_cents,
            "credit_cents": credit_cents,
            "balanced": debit_cents == credit_cents,
        });
        let income_statement = income_statement_report(connection, &filter)?;
        let balance_sheet = balance_sheet_report(connection, &filter)?;
        let piece_index = self.build_piece_index(connection, date_from, date_to)?;
        let source = json!({
            "schema": SOURCE_SCHEMA,
            "company": company,
            "period": stable_period,
            "journal": journal,
            "ledger": ledger,
            "trial_balance": trial_balance,
            "balance_sheet": balance_sheet,
            "income_statement": income_statement,
            "piece_index": piece_index,
        });
        let source_sha256 = sha256_bytes(&serde_json::to_vec(&source)?);
        Ok(ClosingSnapshot {
            journal: source["journal"].clone(),
            ledger: source["ledger"].clone(),
            trial_balance: source["trial_balance"].clone(),
            balance_sheet: source["balance_sheet"].clone(),
            income_statement: source["income_statement"].clone(),
            piece_index: source["piece_index"].clone(),
            source_sha256,
        })
    }

    fn build_piece_index(
        &self,
        connection: &Connection,
        date_from: &str,
        date_to: &str,
    ) -> AppResult<Value> {
        let attachments = query_all(
            connection,
            r#"SELECT DISTINCT a.id,a.project_id,a.entity_type,a.entity_id,a.original_name,
                      a.stored_name,a.mime_type,a.size_bytes,a.sha256,a.created_at,a.updated_at
               FROM attachments a JOIN journal_entries je
                 ON je.source_type=a.entity_type AND je.source_id=a.entity_id
               WHERE je.entry_date BETWEEN ? AND ? ORDER BY a.created_at,a.id"#,
            params![date_from, date_to],
        )?;
        let mut indexed = Vec::with_capacity(attachments.len());
        let mut issues = Vec::new();
        let mut verified = 0_i64;
        for attachment in attachments {
            let id = attachment["id"].as_str().unwrap_or("").to_owned();
            let stored_name = attachment["stored_name"].as_str().unwrap_or("");
            let expected_size = attachment["size_bytes"].as_i64();
            let expected_sha256 = attachment["sha256"].as_str();
            let mut actual_size = None;
            let mut actual_sha256 = None;
            let mut issue_code = None::<&str>;
            match self.safe_attachment_path(stored_name) {
                Err(_) => issue_code = Some("unsafe_stored_name"),
                Ok(path) => match fs::symlink_metadata(&path) {
                    Err(_) => issue_code = Some("missing_or_unreadable_file"),
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        issue_code = Some("symbolic_link_refused")
                    }
                    Ok(metadata) if !metadata.is_file() => issue_code = Some("not_a_regular_file"),
                    Ok(metadata) => {
                        actual_size = i64::try_from(metadata.len()).ok();
                        match sha256_file(&path) {
                            Ok(hash) => actual_sha256 = Some(hash),
                            Err(_) => issue_code = Some("unreadable_file"),
                        }
                    }
                },
            }
            if issue_code.is_none() && expected_size != actual_size {
                issue_code = Some("size_mismatch");
            }
            if issue_code.is_none()
                && expected_sha256.map(str::to_ascii_lowercase).as_deref()
                    != actual_sha256.as_deref()
            {
                issue_code = Some("sha256_mismatch_or_missing");
            }
            let integrity_valid = issue_code.is_none();
            if integrity_valid {
                verified += 1;
            } else {
                issues.push(json!({
                    "attachment_id": id,
                    "original_name": attachment["original_name"],
                    "issue": issue_code.unwrap_or("unknown_integrity_issue"),
                }));
            }
            indexed.push(json!({
                "id": attachment["id"],
                "project_id": attachment["project_id"],
                "entity_type": attachment["entity_type"],
                "entity_id": attachment["entity_id"],
                "original_name": attachment["original_name"],
                "stored_name": attachment["stored_name"],
                "mime_type": attachment["mime_type"],
                "expected_size_bytes": expected_size,
                "actual_size_bytes": actual_size,
                "expected_sha256": expected_sha256,
                "actual_sha256": actual_sha256,
                "integrity_valid": integrity_valid,
                "issue": issue_code,
                "created_at": attachment["created_at"],
                "updated_at": attachment["updated_at"],
            }));
        }
        Ok(json!({
            "period": {"date_from": date_from, "date_to": date_to},
            "attachments_total": indexed.len(),
            "attachments_verified": verified,
            "attachment_issues": issues,
            "attachments": indexed,
        }))
    }
}

fn strict_period_filter(filter: &PeriodFilter) -> AppResult<(String, String)> {
    let date_from = filter.date_from.as_deref().ok_or_else(|| {
        AppError::Validation("date_from est obligatoire pour la pré-clôture.".into())
    })?;
    let date_to = filter.date_to.as_deref().ok_or_else(|| {
        AppError::Validation("date_to est obligatoire pour la pré-clôture.".into())
    })?;
    let from = validate_strict_date(date_from, "date_from")?;
    let to = validate_strict_date(date_to, "date_to")?;
    if from > to {
        return Err(AppError::Validation(
            "date_from doit précéder ou être égale à date_to.".into(),
        ));
    }
    Ok((date_from.to_owned(), date_to.to_owned()))
}

fn validate_strict_date(value: &str, field: &str) -> AppResult<NaiveDate> {
    let bytes = value.as_bytes();
    let exact_shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());
    if !exact_shape {
        return Err(AppError::Validation(format!(
            "{field} doit être une date exacte au format AAAA-MM-JJ."
        )));
    }
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
        AppError::Validation(format!(
            "{field} doit être une date civile valide au format AAAA-MM-JJ."
        ))
    })?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err(AppError::Validation(format!(
            "{field} doit être une date canonique au format AAAA-MM-JJ."
        )));
    }
    Ok(parsed)
}

fn validate_strict_chf(connection: &Connection, date_to: &str) -> AppResult<()> {
    let base_currency: String =
        connection.query_row("SELECT currency FROM settings WHERE id=1", [], |row| {
            row.get(0)
        })?;
    if base_currency != "CHF" {
        return Err(AppError::Validation(
            "La pré-clôture suisse exige une monnaie de tenue exactement égale à CHF.".into(),
        ));
    }
    let non_chf_lines: i64 = connection.query_row(
        r#"SELECT COUNT(*) FROM journal_lines jl JOIN journal_entries je
             ON je.id=jl.journal_entry_id WHERE je.entry_date<=?
             AND (jl.debit_cents<>0 OR jl.credit_cents<>0) AND jl.currency<>'CHF'"#,
        params![date_to],
        |row| row.get(0),
    )?;
    if non_chf_lines != 0 {
        return Err(AppError::Validation(format!(
            "La pré-clôture est bloquée : {non_chf_lines} ligne(s) historique(s) ne portent pas exactement la monnaie CHF."
        )));
    }
    Ok(())
}

fn exact_period(connection: &Connection, date_from: &str, date_to: &str) -> AppResult<Value> {
    let mut periods = query_all(
        connection,
        "SELECT * FROM accounting_periods WHERE date_from=? AND date_to=? ORDER BY id",
        params![date_from, date_to],
    )?;
    match periods.len() {
        0 => Err(AppError::NotFound(format!(
            "accounting_periods/{date_from}/{date_to}"
        ))),
        1 => Ok(periods.remove(0)),
        _ => Err(AppError::Validation(
            "Plusieurs exercices possèdent exactement les mêmes bornes; corrigez les périodes avant la pré-clôture."
                .into(),
        )),
    }
}

fn period_by_id(connection: &Connection, id: &str) -> AppResult<Value> {
    one_value(
        connection,
        "SELECT * FROM accounting_periods WHERE id=?",
        params![id],
        &format!("accounting_periods/{id}"),
    )
}

fn one_value<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    parameters: P,
    not_found: &str,
) -> AppResult<Value> {
    query_all(connection, sql, parameters)?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound(not_found.into()))
}

fn period_string<'a>(period: &'a Value, field: &str) -> AppResult<&'a str> {
    period[field].as_str().ok_or_else(|| {
        AppError::Validation(format!(
            "La période comptable ne contient pas un champ {field} valide."
        ))
    })
}

fn validate_identifier(value: &str, field: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 255
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(AppError::Validation(format!(
            "{field} est un identifiant invalide."
        )));
    }
    Ok(())
}

fn validate_canonical_uuid(value: &str, field: &str) -> AppResult<()> {
    validate_identifier(value, field)?;
    let parsed = Uuid::parse_str(value)
        .map_err(|_| AppError::Validation(format!("{field} doit être un UUID valide.")))?;
    if parsed.to_string() != value {
        return Err(AppError::Validation(format!(
            "{field} doit être un UUID canonique en minuscules."
        )));
    }
    Ok(())
}

fn validated_app_version(value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > 64
        || trimmed != value
        || trimmed.chars().any(char::is_control)
    {
        return Err(AppError::Validation(
            "La version de l'application est invalide.".into(),
        ));
    }
    Ok(trimmed.into())
}

fn load_review(connection: &Connection, review_id: &str) -> AppResult<StoredReview> {
    let record: Option<(String, String, String, String, String, String)> = connection
        .query_row(
            r#"SELECT id,accounting_period_id,status,source_sha256,checks_json,report_json
               FROM closing_reviews WHERE id=?"#,
            params![review_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    let (id, period_id, status, source_sha256, checks_json, report_json) =
        record.ok_or_else(|| AppError::NotFound(format!("closing_reviews/{review_id}")))?;
    let checks: Value = serde_json::from_str(&checks_json)?;
    let report: Value = serde_json::from_str(&report_json)?;
    if !checks.is_object() || !report.is_object() {
        return Err(AppError::Validation(
            "La revue de pré-clôture enregistrée est invalide.".into(),
        ));
    }
    Ok(StoredReview {
        id,
        period_id,
        status,
        source_sha256,
        checks,
        report,
    })
}

fn ensure_review_prepared(review: &StoredReview) -> AppResult<()> {
    if review.status != "prepared" {
        return Err(AppError::Validation(
            "La revue de pré-clôture a déjà été consommée par un export.".into(),
        ));
    }
    Ok(())
}

fn ensure_same_source(review: &StoredReview, snapshot: &ClosingSnapshot) -> AppResult<()> {
    if review.source_sha256 != snapshot.source_sha256 {
        return Err(AppError::Validation(
            "Les données comptables ou les pièces ont changé depuis la pré-clôture. Préparez une nouvelle revue.".into(),
        ));
    }
    Ok(())
}

fn ensure_json_column_size(value: &str, maximum: usize, label: &str) -> AppResult<()> {
    if value.len() > maximum {
        return Err(AppError::Validation(format!(
            "Le {label} dépasse la taille locale autorisée. Réduisez le nombre d'anomalies puis recommencez."
        )));
    }
    Ok(())
}

fn closing_summary(snapshot: &ClosingSnapshot) -> Value {
    json!({
        "journal_entries": array_len(&snapshot.journal["entries"]),
        "journal_lines": array_len(&snapshot.journal["lines"]),
        "accounts_with_activity": array_len(&snapshot.trial_balance["rows"]),
        "debit_cents": snapshot.trial_balance["debit_cents"].as_i64().unwrap_or(0),
        "credit_cents": snapshot.trial_balance["credit_cents"].as_i64().unwrap_or(0),
        "profit_cents": snapshot.income_statement["profit_cents"].as_i64().unwrap_or(0),
        "assets_cents": snapshot.balance_sheet["assets_cents"].as_i64().unwrap_or(0),
        "liabilities_cents": snapshot.balance_sheet["liabilities_cents"].as_i64().unwrap_or(0),
        "equity_cents": snapshot.balance_sheet["equity_cents"].as_i64().unwrap_or(0),
    })
}

fn array_len(value: &Value) -> i64 {
    value
        .as_array()
        .and_then(|rows| i64::try_from(rows.len()).ok())
        .unwrap_or(0)
}

#[allow(clippy::too_many_arguments)]
fn build_payload_members(
    snapshot: &ClosingSnapshot,
    review: &StoredReview,
    period: &Value,
    package_status: &str,
    created_at: &str,
    app_version: &str,
    audit_entries: Vec<Value>,
    audit_verification: Value,
) -> AppResult<Vec<ArchiveMember>> {
    let period_name = single_line(period["name"].as_str().unwrap_or("Exercice"));
    let date_from = period["date_from"].as_str().unwrap_or("");
    let date_to = period["date_to"].as_str().unwrap_or("");
    let readme = format!(
        "DOSSIER DE CLÔTURE FIDUCIAIRE ZENTRA\r\n\
         =====================================\r\n\r\n\
         Statut du paquet : {package_status}\r\n\
         Exercice : {period_name} ({date_from} au {date_to})\r\n\
         Créé le : {created_at}\r\n\
         Version Zentra : {app_version}\r\n\
         Empreinte source SHA-256 : {}\r\n\r\n\
         PORTÉE DU STATUT\r\n\
         DRAFT signifie que l'exercice n'est pas verrouillé ou que la revue comporte un blocage.\r\n\
         FINAL signifie uniquement que l'exercice local était verrouillé et que les contrôles\r\n\
         techniques figés étaient prêts lors de l'export.\r\n\r\n\
         INTÉGRITÉ\r\n\
         manifest.json contient la taille et l'empreinte exacte de chaque fichier de données.\r\n\
         SHA256SUMS ajoute l'empreinte exacte du manifeste. Il s'exclut lui-même afin d'éviter\r\n\
         une dépendance circulaire. Les CSV sont UTF-8 avec BOM, séparés par des virgules et\r\n\
         protègent les cellules textuelles commençant comme une formule de tableur. Les montants\r\n\
         sont des centimes entiers en CHF.\r\n\r\n\
         L'audit contenu dans le ZIP est l'instantané vérifié juste avant l'enregistrement de\r\n\
         cet export; l'événement d'export est ajouté à la base locale après fixation des octets.\r\n\r\n\
         LIMITES\r\n\
         {DISCLAIMER}\r\n",
        review.source_sha256,
    );
    let mut members = vec![ArchiveMember {
        path: "README.txt".into(),
        bytes: readme.into_bytes(),
    }];

    push_json_member(
        &mut members,
        "01_comptabilite/journal.json",
        &snapshot.journal,
    )?;
    members.push(ArchiveMember {
        path: "01_comptabilite/journal.csv".into(),
        bytes: csv_from_rows(
            rows(&snapshot.journal["lines"]),
            &[
                ("line_sequence", "line_sequence"),
                ("entry_number", "entry_number"),
                ("entry_date", "entry_date"),
                ("entry_description", "entry_description"),
                ("source_type", "source_type"),
                ("source_id", "source_id"),
                ("source_event", "source_event"),
                ("reversal_of", "reversal_of"),
                ("id", "line_id"),
                ("journal_entry_id", "journal_entry_id"),
                ("account_id", "account_id"),
                ("account_code", "account_code"),
                ("account_name", "account_name"),
                ("debit_cents", "debit_cents"),
                ("credit_cents", "credit_cents"),
                ("currency", "currency"),
                ("memo", "memo"),
                ("project_id", "project_id"),
                ("client_id", "client_id"),
                ("employee_id", "employee_id"),
                ("created_at", "created_at"),
            ],
        ),
    });
    push_json_member(
        &mut members,
        "01_comptabilite/grand_livre.json",
        &snapshot.ledger,
    )?;
    members.push(ArchiveMember {
        path: "01_comptabilite/grand_livre.csv".into(),
        bytes: csv_from_rows(
            rows(&snapshot.ledger["lines"]),
            &[
                ("account_code", "account_code"),
                ("account_name", "account_name"),
                ("account_type", "account_type"),
                ("report_section", "report_section"),
                ("entry_date", "entry_date"),
                ("entry_number", "entry_number"),
                ("entry_description", "entry_description"),
                ("source_type", "source_type"),
                ("source_id", "source_id"),
                ("source_event", "source_event"),
                ("line_sequence", "line_sequence"),
                ("id", "line_id"),
                ("debit_cents", "debit_cents"),
                ("credit_cents", "credit_cents"),
                ("currency", "currency"),
                ("memo", "memo"),
            ],
        ),
    });
    push_json_member(
        &mut members,
        "01_comptabilite/balance.json",
        &snapshot.trial_balance,
    )?;
    members.push(ArchiveMember {
        path: "01_comptabilite/balance.csv".into(),
        bytes: csv_from_rows(
            rows(&snapshot.trial_balance["rows"]),
            statement_columns(false),
        ),
    });
    push_json_member(
        &mut members,
        "01_comptabilite/bilan.json",
        &snapshot.balance_sheet,
    )?;
    members.push(ArchiveMember {
        path: "01_comptabilite/bilan.csv".into(),
        bytes: csv_from_rows(
            rows(&snapshot.balance_sheet["rows"]),
            statement_columns(true),
        ),
    });
    push_json_member(
        &mut members,
        "01_comptabilite/resultat.json",
        &snapshot.income_statement,
    )?;
    members.push(ArchiveMember {
        path: "01_comptabilite/resultat.csv".into(),
        bytes: csv_from_rows(
            rows(&snapshot.income_statement["rows"]),
            statement_columns(true),
        ),
    });
    push_json_member(
        &mut members,
        "02_pieces/index_pieces.json",
        &snapshot.piece_index,
    )?;
    members.push(ArchiveMember {
        path: "02_pieces/index_pieces.csv".into(),
        bytes: csv_from_rows(
            rows(&snapshot.piece_index["attachments"]),
            &[
                ("id", "attachment_id"),
                ("entity_type", "entity_type"),
                ("entity_id", "entity_id"),
                ("project_id", "project_id"),
                ("original_name", "original_name"),
                ("stored_name", "stored_name"),
                ("mime_type", "mime_type"),
                ("expected_size_bytes", "expected_size_bytes"),
                ("actual_size_bytes", "actual_size_bytes"),
                ("expected_sha256", "expected_sha256"),
                ("actual_sha256", "actual_sha256"),
                ("integrity_valid", "integrity_valid"),
                ("issue", "issue"),
                ("created_at", "created_at"),
                ("updated_at", "updated_at"),
            ],
        ),
    });
    let audit = json!({
        "schema": "elyko.audit-export.v1",
        "snapshot_timing": "immediately_before_export_registration",
        "verification": audit_verification,
        "entries": audit_entries,
    });
    push_json_member(&mut members, "03_audit/audit.json", &audit)?;
    members.push(ArchiveMember {
        path: "03_audit/audit.csv".into(),
        bytes: csv_from_rows(
            rows(&audit["entries"]),
            &[
                ("sequence", "sequence"),
                ("id", "id"),
                ("occurred_at", "occurred_at"),
                ("actor", "actor"),
                ("action", "action"),
                ("entity_type", "entity_type"),
                ("entity_id", "entity_id"),
                ("payload_json", "payload_json"),
                ("previous_hash", "previous_hash"),
                ("entry_hash", "entry_hash"),
            ],
        ),
    });
    push_json_member(
        &mut members,
        "03_audit/verification_audit.json",
        &audit["verification"],
    )?;
    push_json_member(&mut members, "04_revue/pre_cloture.json", &review.report)?;
    Ok(members)
}

fn statement_columns(comparative: bool) -> &'static [(&'static str, &'static str)] {
    if comparative {
        &[
            ("id", "account_id"),
            ("code", "account_code"),
            ("name", "account_name"),
            ("account_type", "account_type"),
            ("normal_balance", "normal_balance"),
            ("report_section", "report_section"),
            ("debit_cents", "debit_cents"),
            ("credit_cents", "credit_cents"),
            ("amount_cents", "amount_cents"),
            ("previous_debit_cents", "previous_debit_cents"),
            ("previous_credit_cents", "previous_credit_cents"),
            ("previous_amount_cents", "previous_amount_cents"),
        ]
    } else {
        &[
            ("id", "account_id"),
            ("code", "account_code"),
            ("name", "account_name"),
            ("account_type", "account_type"),
            ("normal_balance", "normal_balance"),
            ("report_section", "report_section"),
            ("debit_cents", "debit_cents"),
            ("credit_cents", "credit_cents"),
            ("debit_balance_cents", "debit_balance_cents"),
            ("credit_balance_cents", "credit_balance_cents"),
        ]
    }
}

fn build_manifest(
    members: &[ArchiveMember],
    review: &StoredReview,
    period: &Value,
    package_status: &str,
    created_at: &str,
    app_version: &str,
) -> Value {
    let files = members
        .iter()
        .map(|member| {
            json!({
                "path": member.path,
                "size_bytes": member.bytes.len(),
                "sha256": sha256_bytes(&member.bytes),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "schema": MANIFEST_SCHEMA,
        "created_at": created_at,
        "app_version": app_version,
        "package_status": package_status,
        "review_id": review.id,
        "accounting_period_id": review.period_id,
        "period": {
            "name": period["name"],
            "date_from": period["date_from"],
            "date_to": period["date_to"],
        },
        "currency": "CHF",
        "source_sha256": review.source_sha256,
        "hash_algorithm": "SHA-256",
        "hash_scope": "Exact stored bytes of every listed data file; manifest.json is hashed in SHA256SUMS; SHA256SUMS excludes itself.",
        "files": files,
        "disclaimer": DISCLAIMER,
    })
}

fn push_json_member(members: &mut Vec<ArchiveMember>, path: &str, value: &Value) -> AppResult<()> {
    members.push(ArchiveMember {
        path: path.into(),
        bytes: pretty_json_bytes(value)?,
    });
    Ok(())
}

fn pretty_json_bytes(value: &Value) -> AppResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn rows(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

pub(crate) fn csv_from_rows(rows: &[Value], columns: &[(&str, &str)]) -> Vec<u8> {
    let mut csv = String::from("\u{feff}");
    csv.push_str(
        &columns
            .iter()
            .map(|(_, heading)| csv_quote(heading))
            .collect::<Vec<_>>()
            .join(","),
    );
    csv.push_str("\r\n");
    for row in rows {
        csv.push_str(
            &columns
                .iter()
                .map(|(key, _)| csv_value(row.get(*key).unwrap_or(&Value::Null)))
                .collect::<Vec<_>>()
                .join(","),
        );
        csv.push_str("\r\n");
    }
    csv.into_bytes()
}

fn csv_value(value: &Value) -> String {
    let (mut text, is_text) = match value {
        Value::Null => (String::new(), false),
        Value::Bool(value) => (value.to_string(), false),
        Value::Number(value) => (value.to_string(), false),
        Value::String(value) => (value.clone(), true),
        Value::Array(_) | Value::Object(_) => (
            serde_json::to_string(value).unwrap_or_else(|_| "null".into()),
            true,
        ),
    };
    if is_text
        && text
            .chars()
            .next()
            .is_some_and(|first| matches!(first, '=' | '+' | '-' | '@' | '\t' | '\r'))
    {
        text.insert(0, '\'');
    }
    csv_quote(&text)
}

fn csv_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn single_line(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn write_zip_exclusive(destination: &Path, members: &[ArchiveMember]) -> AppResult<()> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let result = (|| -> AppResult<()> {
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        for member in members {
            archive.start_file(&member.path, options)?;
            archive.write_all(&member.bytes)?;
        }
        let file = archive.finish()?;
        file.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, io::Read, path::PathBuf};

    use tempfile::TempDir;
    use zip::ZipArchive;

    use super::*;

    #[test]
    fn strict_dates_require_both_canonical_valid_bounds() {
        for filter in [
            PeriodFilter::default(),
            PeriodFilter {
                date_from: Some("2026-1-01".into()),
                date_to: Some("2026-12-31".into()),
            },
            PeriodFilter {
                date_from: Some("2026-02-30".into()),
                date_to: Some("2026-12-31".into()),
            },
            PeriodFilter {
                date_from: Some("2026-12-31".into()),
                date_to: Some("2026-01-01".into()),
            },
            PeriodFilter {
                date_from: Some(" 2026-01-01".into()),
                date_to: Some("2026-12-31".into()),
            },
        ] {
            assert!(strict_period_filter(&filter).is_err());
        }
        assert_eq!(
            strict_period_filter(&PeriodFilter {
                date_from: Some("2026-01-01".into()),
                date_to: Some("2026-12-31".into()),
            })
            .unwrap(),
            ("2026-01-01".into(), "2026-12-31".into())
        );
    }

    #[test]
    fn csv_is_rfc4180_like_and_neutralizes_spreadsheet_formulas() {
        let bytes = csv_from_rows(
            &[json!({"label":"=2+2","amount":-42,"quote":"a\"b"})],
            &[("label", "label"), ("amount", "amount"), ("quote", "quote")],
        );
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("\u{feff}\"label\",\"amount\",\"quote\"\r\n"));
        assert!(text.contains("\"'=2+2\",\"-42\",\"a\"\"b\""));
    }

    #[test]
    fn zip_creation_is_exclusive_and_hashes_match_exact_members() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("package.zip");
        let payload = ArchiveMember {
            path: "payload.json".into(),
            bytes: b"{\"ok\":true}\n".to_vec(),
        };
        let payload_hash = sha256_bytes(&payload.bytes);
        let manifest_value = json!({
            "files": [{"path":"payload.json","sha256":payload_hash}]
        });
        let manifest_bytes = pretty_json_bytes(&manifest_value).unwrap();
        let manifest_hash = sha256_bytes(&manifest_bytes);
        let members = vec![
            payload,
            ArchiveMember {
                path: "manifest.json".into(),
                bytes: manifest_bytes,
            },
            ArchiveMember {
                path: "SHA256SUMS".into(),
                bytes: format!("{payload_hash}  payload.json\n{manifest_hash}  manifest.json\n")
                    .into_bytes(),
            },
        ];
        write_zip_exclusive(&destination, &members).unwrap();
        assert!(write_zip_exclusive(&destination, &members).is_err());

        let file = File::open(&destination).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let mut sums = String::new();
        archive
            .by_name("SHA256SUMS")
            .unwrap()
            .read_to_string(&mut sums)
            .unwrap();
        for line in sums.lines() {
            let (expected, name) = line.split_once("  ").unwrap();
            let mut bytes = Vec::new();
            archive
                .by_name(name)
                .unwrap()
                .read_to_end(&mut bytes)
                .unwrap();
            assert_eq!(expected, sha256_bytes(&bytes));
        }
    }

    #[test]
    fn full_review_finalize_and_final_export_are_verifiable() {
        let (_temporary, store, period_id) = seeded_store("CHF");
        let filter = test_filter();
        let review = store.prepare_fiduciary_pre_closing(filter).unwrap();
        assert_eq!(review["schema"], REVIEW_SCHEMA);
        assert_eq!(review["checks"]["ready_for_final"], true);
        assert_eq!(review["package_status_if_exported"], "DRAFT");
        assert_eq!(review["source_sha256"].as_str().unwrap().len(), 64);
        let review_id = review["review_id"].as_str().unwrap();

        let finalization = store
            .finalize_accounting_period_with_review(&period_id, review_id)
            .unwrap();
        assert_eq!(finalization["schema"], FINALIZATION_SCHEMA);
        assert_eq!(finalization["period"]["status"], "closed");
        assert_eq!(finalization["source_sha256"], review["source_sha256"]);
        let connection = store.connect().unwrap();
        let review_status: String = connection
            .query_row(
                "SELECT status FROM closing_reviews WHERE id=?",
                params![review_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(review_status, "prepared");
        drop(connection);

        let exported = store
            .export_fiduciary_closing_zip(review_id, "1.8.0-test")
            .unwrap();
        assert_eq!(exported["schema"], EXPORT_SCHEMA);
        assert_eq!(exported["package_status"], "FINAL");
        assert_eq!(exported["source_sha256"], review["source_sha256"]);
        assert!(exported["file_count"].as_i64().unwrap() >= 19);
        let destination = PathBuf::from(exported["path"].as_str().unwrap());
        assert!(destination.starts_with(&store.exports_dir));
        assert!(destination.is_file());
        verify_exported_archive(&destination, &exported["manifest_sha256"]);

        let connection = store.connect().unwrap();
        let (status, export_rows): (String, i64) = (
            connection
                .query_row(
                    "SELECT status FROM closing_reviews WHERE id=?",
                    params![review_id],
                    |row| row.get(0),
                )
                .unwrap(),
            connection
                .query_row(
                    "SELECT COUNT(*) FROM closing_package_exports WHERE closing_review_id=?",
                    params![review_id],
                    |row| row.get(0),
                )
                .unwrap(),
        );
        assert_eq!(status, "consumed");
        assert_eq!(export_rows, 1);
    }

    #[test]
    fn blocked_retroactive_writes_leave_final_hash_reports_and_database_unchanged() {
        let (_temporary, store, period_id) = seeded_store("CHF");
        let review = store.prepare_fiduciary_pre_closing(test_filter()).unwrap();
        let review_id = review["review_id"].as_str().unwrap();
        store
            .finalize_accounting_period_with_review(&period_id, review_id)
            .unwrap();
        let exported = store
            .export_fiduciary_closing_zip(review_id, "1.17.0-test")
            .unwrap();
        assert_eq!(exported["package_status"], "FINAL");
        let archive_path = PathBuf::from(exported["path"].as_str().unwrap());
        let archive_sha256_before = sha256_file(&archive_path).unwrap();

        let connection = store.connect().unwrap();
        let period = period_by_id(&connection, &period_id).unwrap();
        let snapshot_before = store
            .build_closing_snapshot(&connection, &period, "2026-01-01", "2026-12-31")
            .unwrap();
        assert_eq!(snapshot_before.source_sha256, exported["source_sha256"]);
        let bank_id: String = connection
            .query_row("SELECT id FROM accounts WHERE code='1020'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let revenue_id: String = connection
            .query_row("SELECT id FROM accounts WHERE code='3200'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let state_before: (i64, i64, i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM journal_entries),
                   (SELECT COUNT(*) FROM journal_lines),
                   (SELECT COUNT(*) FROM accounting_sequences),
                   (SELECT COUNT(*) FROM vat_adjustments),
                   (SELECT COUNT(*) FROM audit_log)",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        let export_evidence_before: (String, String, String) = connection
            .query_row(
                "SELECT source_sha256,manifest_sha256,file_name
                 FROM closing_package_exports WHERE closing_review_id=?",
                params![review_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        drop(connection);

        let journal_error = store
            .post_manual_journal_entry(crate::models::ManualJournalInput {
                entry_date: "2025-06-30".into(),
                description: "Tentative rétroactive hors exercice explicite".into(),
                currency: "CHF".into(),
                lines: vec![
                    crate::models::ManualJournalLineInput {
                        account_id: bank_id,
                        debit_cents: 100,
                        credit_cents: 0,
                        memo: None,
                        project_id: None,
                        client_id: None,
                        employee_id: None,
                    },
                    crate::models::ManualJournalLineInput {
                        account_id: revenue_id,
                        debit_cents: 0,
                        credit_cents: 100,
                        memo: None,
                        project_id: None,
                        client_id: None,
                        employee_id: None,
                    },
                ],
            })
            .unwrap_err()
            .to_string();
        assert!(
            journal_error.contains("cumulativement jusqu'au 2026-12-31"),
            "erreur de journal inattendue: {journal_error}"
        );

        let vat_error = store
            .create_vat_adjustment(crate::vat_reporting::VatAdjustmentInput {
                request_id: "12121212-1212-4212-8212-121212121212".into(),
                adjustment_date: "2026-12-31".into(),
                category: "input_materials".into(),
                amount_cents: 25,
                tax_rate_bp: None,
                description: "Tentative TVA après FINAL".into(),
                evidence_reference: Some("FINAL-2026".into()),
                created_by: "test".into(),
            })
            .unwrap_err()
            .to_string();
        assert!(
            vat_error.contains("cumulative jusqu'au 2026-12-31"),
            "erreur de TVA inattendue: {vat_error}"
        );

        let connection = store.connect().unwrap();
        let period = period_by_id(&connection, &period_id).unwrap();
        let snapshot_after = store
            .build_closing_snapshot(&connection, &period, "2026-01-01", "2026-12-31")
            .unwrap();
        assert_eq!(snapshot_after.source_sha256, snapshot_before.source_sha256);
        assert_eq!(snapshot_after.journal, snapshot_before.journal);
        assert_eq!(snapshot_after.ledger, snapshot_before.ledger);
        assert_eq!(snapshot_after.trial_balance, snapshot_before.trial_balance);
        assert_eq!(snapshot_after.balance_sheet, snapshot_before.balance_sheet);
        assert_eq!(
            snapshot_after.income_statement,
            snapshot_before.income_statement
        );
        assert_eq!(snapshot_after.piece_index, snapshot_before.piece_index);
        let state_after: (i64, i64, i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM journal_entries),
                   (SELECT COUNT(*) FROM journal_lines),
                   (SELECT COUNT(*) FROM accounting_sequences),
                   (SELECT COUNT(*) FROM vat_adjustments),
                   (SELECT COUNT(*) FROM audit_log)",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            state_after, state_before,
            "les rejets doivent être atomiques"
        );
        let export_evidence_after: (String, String, String) = connection
            .query_row(
                "SELECT source_sha256,manifest_sha256,file_name
                 FROM closing_package_exports WHERE closing_review_id=?",
                params![review_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(export_evidence_after, export_evidence_before);
        drop(connection);
        assert_eq!(sha256_file(&archive_path).unwrap(), archive_sha256_before);
    }

    #[test]
    fn open_period_exports_only_as_draft_and_consumes_review() {
        let (_temporary, store, _period_id) = seeded_store("CHF");
        let review = store.prepare_fiduciary_pre_closing(test_filter()).unwrap();
        let exported = store
            .export_fiduciary_closing_zip(review["review_id"].as_str().unwrap(), "1.8.0-test")
            .unwrap();
        assert_eq!(exported["package_status"], "DRAFT");
        assert!(store
            .export_fiduciary_closing_zip(review["review_id"].as_str().unwrap(), "1.8.0-test",)
            .is_err());
    }

    #[test]
    fn finalization_rechecks_live_continuity_instead_of_trusting_stored_checks() {
        let (_temporary, store, period_id) = seeded_store("CHF");
        let review = store.prepare_fiduciary_pre_closing(test_filter()).unwrap();
        assert_eq!(review["checks"]["ready_for_final"], true);

        // This setting is intentionally outside the source snapshot. It makes the current
        // accounting continuity invalid without changing the journal, statements or pieces.
        let connection = store.connect().unwrap();
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO accounting_settings(id,enabled,created_at,updated_at) VALUES(1,1,?,?)",
                params![now, now],
            )
            .unwrap();
        drop(connection);

        let error = store
            .finalize_accounting_period_with_review(
                &period_id,
                review["review_id"].as_str().unwrap(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("continuité comptable a changé"));
        let connection = store.connect().unwrap();
        let status: String = connection
            .query_row(
                "SELECT status FROM accounting_periods WHERE id=?",
                params![period_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "open");
    }

    #[test]
    fn finalization_rechecks_audit_integrity_after_review() {
        let (_temporary, store, period_id) = seeded_store("CHF");
        let review = store.prepare_fiduciary_pre_closing(test_filter()).unwrap();
        assert_eq!(review["checks"]["ready_for_final"], true);

        // Simulate corruption or an out-of-band writer appending an entry whose declared hash
        // does not match its bytes. Audit rows are not part of source_sha256 by design.
        let connection = store.connect().unwrap();
        let previous_hash: String = connection
            .query_row(
                "SELECT entry_hash FROM audit_log ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO audit_log(id,occurred_at,actor,action,entity_type,entity_id,payload_json,previous_hash,entry_hash) VALUES(?,?,?,?,?,?,?,?,?)",
                params![
                    Uuid::new_v4().to_string(),
                    now_iso(),
                    "out_of_band",
                    "corrupt",
                    "test",
                    "test",
                    "{}",
                    previous_hash,
                    "0".repeat(64),
                ],
            )
            .unwrap();
        drop(connection);

        let error = store
            .finalize_accounting_period_with_review(
                &period_id,
                review["review_id"].as_str().unwrap(),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("contenu d'audit"));
        let connection = store.connect().unwrap();
        let status: String = connection
            .query_row(
                "SELECT status FROM accounting_periods WHERE id=?",
                params![period_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "open");
    }

    #[test]
    fn final_export_is_downgraded_when_live_continuity_changed() {
        let (_temporary, store, period_id) = seeded_store("CHF");
        let review = store.prepare_fiduciary_pre_closing(test_filter()).unwrap();
        let review_id = review["review_id"].as_str().unwrap();
        store
            .finalize_accounting_period_with_review(&period_id, review_id)
            .unwrap();

        let connection = store.connect().unwrap();
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO accounting_settings(id,enabled,created_at,updated_at) VALUES(1,1,?,?)",
                params![now, now],
            )
            .unwrap();
        drop(connection);

        let exported = store
            .export_fiduciary_closing_zip(review_id, "1.8.0-test")
            .unwrap();
        assert_eq!(exported["package_status"], "DRAFT");
    }

    #[test]
    fn strict_chf_rejects_normalized_but_non_exact_setting() {
        let (_temporary, store, _period_id) = seeded_store("chf");
        let error = store
            .prepare_fiduciary_pre_closing(test_filter())
            .unwrap_err()
            .to_string();
        assert!(error.contains("exactement égale à CHF"));
        let connection = store.connect().unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM closing_reviews", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    fn test_filter() -> PeriodFilter {
        PeriodFilter {
            date_from: Some("2026-01-01".into()),
            date_to: Some("2026-12-31".into()),
        }
    }

    fn seeded_store(currency: &str) -> (TempDir, LocalStore, String) {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("elyko-data")).unwrap();
        let connection = store.connect().unwrap();
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO settings(\
                 id,onboarding_completed,company_name,currency,created_at,updated_at)\
                 VALUES(1,1,'Entreprise Test',?,?,?)",
                params![currency, now, now],
            )
            .unwrap();
        let period_id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO accounting_periods(\
                 id,name,date_from,date_to,status,created_at,updated_at)\
                 VALUES(?,'Exercice 2026','2026-01-01','2026-12-31','open',?,?)",
                params![period_id, now, now],
            )
            .unwrap();
        let bank_id = Uuid::new_v4().to_string();
        let revenue_id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO accounts(\
                 id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at)\
                 VALUES(?,'1020','Banque','asset','debit','current_assets',1,?,?)",
                params![bank_id, now, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO accounts(\
                 id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at)\
                 VALUES(?,'3200','Produits','revenue','credit','net_revenue',1,?,?)",
                params![revenue_id, now, now],
            )
            .unwrap();
        let entry_id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO journal_entries(\
                 id,number,entry_date,description,source_type,source_id,source_event,status,created_at)\
                 VALUES(?,'J-2026-000001','2026-06-15','Vente test','manual',?,'post','posted',?)",
                params![entry_id, Uuid::new_v4().to_string(), now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO journal_lines(\
                 id,journal_entry_id,account_id,debit_cents,credit_cents,currency,memo,created_at)\
                 VALUES(?,?,?,100000,0,'CHF','Banque',?)",
                params![Uuid::new_v4().to_string(), entry_id, bank_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO journal_lines(\
                 id,journal_entry_id,account_id,debit_cents,credit_cents,currency,memo,created_at)\
                 VALUES(?,?,?,0,100000,'CHF','Vente',?)",
                params![Uuid::new_v4().to_string(), entry_id, revenue_id, now],
            )
            .unwrap();
        drop(connection);
        (temporary, store, period_id)
    }

    fn verify_exported_archive(destination: &Path, manifest_sha256: &Value) {
        let file = File::open(destination).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let names = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_owned())
            .collect::<BTreeSet<_>>();
        for required in [
            "README.txt",
            "01_comptabilite/journal.json",
            "01_comptabilite/journal.csv",
            "01_comptabilite/grand_livre.json",
            "01_comptabilite/grand_livre.csv",
            "01_comptabilite/balance.json",
            "01_comptabilite/balance.csv",
            "01_comptabilite/bilan.json",
            "01_comptabilite/bilan.csv",
            "01_comptabilite/resultat.json",
            "01_comptabilite/resultat.csv",
            "02_pieces/index_pieces.json",
            "02_pieces/index_pieces.csv",
            "03_audit/audit.json",
            "03_audit/audit.csv",
            "03_audit/verification_audit.json",
            "04_revue/pre_cloture.json",
            "manifest.json",
            "SHA256SUMS",
        ] {
            assert!(names.contains(required), "missing ZIP member {required}");
        }

        let mut sums = String::new();
        archive
            .by_name("SHA256SUMS")
            .unwrap()
            .read_to_string(&mut sums)
            .unwrap();
        for line in sums.lines() {
            let (expected, name) = line.split_once("  ").unwrap();
            let mut bytes = Vec::new();
            archive
                .by_name(name)
                .unwrap()
                .read_to_end(&mut bytes)
                .unwrap();
            assert_eq!(expected, sha256_bytes(&bytes), "hash mismatch for {name}");
            if name == "manifest.json" {
                assert_eq!(Some(expected), manifest_sha256.as_str());
            }
        }
        let mut readme = String::new();
        archive
            .by_name("README.txt")
            .unwrap()
            .read_to_string(&mut readme)
            .unwrap();
        assert!(!readme.contains("Olico"));
    }
}
