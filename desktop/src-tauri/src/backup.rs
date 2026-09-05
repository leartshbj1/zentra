use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

use rusqlite::{backup::Backup, params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
    fiduciary_closing::csv_from_rows,
    models::{BackupManifest, ExportEnvelope},
    schema::SCHEMA_VERSION,
};

const BACKUP_FORMAT: &str = "helvichantier-backup";
const BACKUP_FORMAT_VERSION: u32 = 1;
const DATABASE_ENTRY: &str = "database.sqlite3";
const ATTACHMENTS_PREFIX: &str = "attachments/";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_DATABASE_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES: u64 = 50 * 1024 * 1024 * 1024;
const BACKUP_STATUS_FILE: &str = "backup-status.json";
const BACKUP_STATUS_FORMAT: &str = "elyko-backup-status";
const BACKUP_STATUS_VERSION: u32 = 1;
const MAX_BACKUP_STATUS_BYTES: u64 = 16 * 1024;

/// Collections tabulaires explicitement autorisées dans l'export CSV.
///
/// L'allowlist évite qu'une future table contenant un secret, un chemin local
/// ou un document brut soit exportée automatiquement. Les fichiers binaires ne
/// sont jamais copiés dans cette archive.
const CSV_EXPORT_COLLECTIONS: &[(&str, &str)] = &[
    ("clients", "01_referentiels/clients.csv"),
    ("catalog_items", "01_referentiels/catalogue.csv"),
    ("suppliers", "01_referentiels/fournisseurs.csv"),
    ("quotes", "02_ventes/devis.csv"),
    ("quote_items", "02_ventes/lignes_devis.csv"),
    ("quote_conversions", "02_ventes/conversions_devis.csv"),
    ("sales_orders", "02_ventes/commandes_clients.csv"),
    (
        "sales_order_lines",
        "02_ventes/lignes_commandes_clients.csv",
    ),
    (
        "sales_order_cancellation_lines",
        "02_ventes/annulations_commandes_clients.csv",
    ),
    ("delivery_notes", "02_ventes/bons_livraison.csv"),
    ("delivery_note_lines", "02_ventes/lignes_bons_livraison.csv"),
    (
        "sales_order_invoice_batches",
        "02_ventes/lots_facturation_commandes.csv",
    ),
    (
        "sales_order_invoice_allocations",
        "02_ventes/allocations_facturation_commandes.csv",
    ),
    ("invoices", "02_ventes/factures.csv"),
    ("invoice_items", "02_ventes/lignes_factures.csv"),
    (
        "invoice_correction_workflows",
        "02_ventes/corrections_factures.csv",
    ),
    ("invoice_qr_bills", "02_ventes/factures_qr.csv"),
    ("payments", "02_ventes/paiements_clients.csv"),
    (
        "recurrence_schedules",
        "02_ventes/planifications_recurrentes.csv",
    ),
    (
        "recurrence_occurrences",
        "02_ventes/occurrences_recurrentes.csv",
    ),
    ("expenses", "03_achats/depenses.csv"),
    ("supplier_orders", "03_achats/commandes_fournisseurs.csv"),
    (
        "supplier_order_lines",
        "03_achats/lignes_commandes_fournisseurs.csv",
    ),
    (
        "supplier_order_cancellation_lines",
        "03_achats/annulations_commandes_fournisseurs.csv",
    ),
    ("supplier_receipts", "03_achats/receptions_fournisseurs.csv"),
    (
        "supplier_receipt_lines",
        "03_achats/lignes_receptions_fournisseurs.csv",
    ),
    ("supplier_invoices", "03_achats/factures_fournisseurs.csv"),
    (
        "supplier_email_invoice_imports",
        "03_achats/provenance_factures_email.csv",
    ),
    (
        "supplier_invoice_items",
        "03_achats/lignes_factures_fournisseurs.csv",
    ),
    (
        "supplier_invoice_matches",
        "03_achats/rapprochements_achats.csv",
    ),
    ("supplier_payments", "03_achats/paiements_fournisseurs.csv"),
    ("supplier_credit_notes", "03_achats/avoirs_fournisseurs.csv"),
    (
        "supplier_credit_note_items",
        "03_achats/lignes_avoirs_fournisseurs.csv",
    ),
    (
        "supplier_credit_allocations",
        "03_achats/allocations_avoirs_fournisseurs.csv",
    ),
    (
        "supplier_expense_reclassifications",
        "03_achats/reclassements_depenses.csv",
    ),
    (
        "supplier_expense_reclassification_lines",
        "03_achats/lignes_reclassements_depenses.csv",
    ),
    ("stock_movements", "04_stock/mouvements_stock.csv"),
    ("stock_availability", "04_stock/disponibilite_stock.csv"),
    (
        "stock_reservation_events",
        "04_stock/reservations_stock.csv",
    ),
    ("accounts", "05_comptabilite/plan_comptable.csv"),
    ("accounting_periods", "05_comptabilite/periodes.csv"),
    ("journal_entries", "05_comptabilite/journal.csv"),
    ("journal_lines", "05_comptabilite/lignes_journal.csv"),
    ("vat_profiles", "05_comptabilite/profils_tva.csv"),
    (
        "vat_source_classifications",
        "05_comptabilite/classifications_sources_tva.csv",
    ),
    ("vat_adjustments", "05_comptabilite/ajustements_tva.csv"),
    (
        "vat_return_exports",
        "05_comptabilite/declarations_tva_exportees.csv",
    ),
    ("closing_reviews", "05_comptabilite/revues_cloture.csv"),
    (
        "closing_package_exports",
        "05_comptabilite/exports_cloture.csv",
    ),
    ("bank_imports", "06_banque/imports_camt.csv"),
    ("bank_movements", "06_banque/mouvements.csv"),
    (
        "bank_reconciliations",
        "06_banque/rapprochements_clients.csv",
    ),
    (
        "bank_supplier_reconciliations",
        "06_banque/rapprochements_fournisseurs.csv",
    ),
    ("bank_movement_keys", "06_banque/cles_mouvements.csv"),
    ("bank_expense_reconciliations", "06_banque/rapprochements_depenses.csv"),
    ("bank_expense_creation_requests", "06_banque/creations_depenses.csv"),
    ("bank_account_links", "06_banque/comptes_associes.csv"),
    ("projects", "07_projets/projets.csv"),
    ("project_milestones", "07_projets/jalons.csv"),
    ("project_tasks", "07_projets/taches.csv"),
    ("agenda_events", "07_projets/agenda.csv"),
    ("time_entries", "07_projets/heures.csv"),
    (
        "time_billing_batches",
        "07_projets/lots_facturation_heures.csv",
    ),
    ("time_billing_entries", "07_projets/allocations_heures.csv"),
    ("employees", "08_equipe/collaborateurs.csv"),
    (
        "employee_small_salary_decisions",
        "08_equipe/decisions_petits_salaires.csv",
    ),
    ("payslips", "08_equipe/fiches_salaire.csv"),
    ("payslip_items", "08_equipe/lignes_fiches_salaire.csv"),
    (
        "payslip_small_salary_assessments",
        "08_equipe/evaluations_petits_salaires.csv",
    ),
    (
        "payroll_contribution_definitions",
        "08_equipe/definitions_cotisations.csv",
    ),
    (
        "payslip_contributions",
        "08_equipe/cotisations_fiches_salaire.csv",
    ),
    (
        "employee_payroll_templates",
        "08_equipe/modeles_salaire.csv",
    ),
    ("reminder_templates", "09_relances/modeles.csv"),
    ("reminders", "09_relances/relances.csv"),
    ("reminder_history", "09_relances/historique.csv"),
    ("reminder_deliveries", "09_relances/envois.csv"),
    ("attachments", "10_documents/index_pieces_jointes.csv"),
    ("audit_log", "11_audit/journal_audit.csv"),
];

/// Registres métier volontairement absents du workspace interactif pour ne pas
/// alourdir chaque rafraîchissement, mais indispensables dans un export CSV
/// comptable complet.
const CSV_EXPORT_DIRECT_COLLECTIONS: &[(&str, &str)] = &[
    ("bank_expense_reconciliations", "SELECT * FROM bank_expense_reconciliations ORDER BY confirmed_at,id"),
    ("bank_expense_creation_requests", "SELECT * FROM bank_expense_creation_requests ORDER BY created_at,request_id"),
    (
        "employee_small_salary_decisions",
        "SELECT * FROM employee_small_salary_decisions ORDER BY employee_id,assessment_year,revision",
    ),
    (
        "payslip_small_salary_assessments",
        "SELECT * FROM payslip_small_salary_assessments ORDER BY employee_id,assessment_year,payslip_id",
    ),
    (
        "vat_profiles",
        "SELECT * FROM vat_profiles ORDER BY effective_from,id",
    ),
    (
        "vat_source_classifications",
        "SELECT * FROM vat_source_classifications ORDER BY source_type,source_id",
    ),
    (
        "vat_adjustments",
        "SELECT * FROM vat_adjustments ORDER BY adjustment_date,sequence",
    ),
    (
        "vat_return_exports",
        "SELECT * FROM vat_return_exports ORDER BY date_from,date_to,sequence",
    ),
    (
        "closing_reviews",
        "SELECT * FROM closing_reviews ORDER BY accounting_period_id,sequence",
    ),
    (
        "closing_package_exports",
        "SELECT * FROM closing_package_exports ORDER BY accounting_period_id,sequence",
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct BackupStatusProof {
    format: String,
    format_version: u32,
    last_success_at: String,
    last_path: String,
}

#[derive(Clone, Copy)]
struct ArchiveExtractionLimits {
    manifest_bytes: u64,
    database_bytes: u64,
    attachments_bytes: u64,
}

const ARCHIVE_EXTRACTION_LIMITS: ArchiveExtractionLimits = ArchiveExtractionLimits {
    manifest_bytes: MAX_MANIFEST_BYTES,
    database_bytes: MAX_DATABASE_BYTES,
    attachments_bytes: MAX_ATTACHMENTS_BYTES,
};

struct PreservedLicense {
    token_sha256: String,
    license_id: String,
    customer_name: Option<String>,
    plan: String,
    price_chf_cents: i64,
    issued_at: String,
    valid_from: String,
    valid_until: String,
    verified_at: String,
    last_seen_date: String,
    clock_anchor_version: i64,
}

struct RestoredDataSwap {
    database_path: PathBuf,
    attachments_dir: PathBuf,
    staged_database: PathBuf,
    staged_attachments: PathBuf,
    old_database: PathBuf,
    old_attachments: PathBuf,
    old_database_staged: bool,
    old_attachments_staged: bool,
    new_database_installed: bool,
    new_attachments_installed: bool,
}

impl RestoredDataSwap {
    fn rollback(self) -> AppResult<()> {
        let mut failures = Vec::new();

        if self.new_database_installed {
            if let Err(error) = remove_sqlite_sidecars(&self.database_path) {
                failures.push(format!("fichiers temporaires SQLite : {error}"));
            }
            if self.database_path.exists() {
                if let Err(error) = fs::remove_file(&self.database_path) {
                    failures.push(format!("base restaurée : {error}"));
                }
            }
        }
        if self.new_attachments_installed && self.attachments_dir.exists() {
            if let Err(error) = fs::remove_dir_all(&self.attachments_dir) {
                failures.push(format!("pièces jointes restaurées : {error}"));
            }
        }
        if self.old_database_staged && self.old_database.exists() {
            if let Err(error) = fs::rename(&self.old_database, &self.database_path) {
                failures.push(format!("ancienne base : {error}"));
            }
        }
        if self.old_attachments_staged && self.old_attachments.exists() {
            if let Err(error) = fs::rename(&self.old_attachments, &self.attachments_dir) {
                failures.push(format!("anciennes pièces jointes : {error}"));
            }
        }
        if self.staged_database.exists() {
            let _ = fs::remove_file(&self.staged_database);
        }
        if self.staged_attachments.exists() {
            let _ = fs::remove_dir_all(&self.staged_attachments);
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Validation(format!(
                "Le retour aux données précédentes est incomplet ({})",
                failures.join("; ")
            )))
        }
    }

    fn commit(self) {
        if self.old_database.exists() {
            let _ = fs::remove_file(self.old_database);
        }
        if self.old_attachments.exists() {
            let _ = fs::remove_dir_all(self.old_attachments);
        }
        if self.staged_database.exists() {
            let _ = fs::remove_file(self.staged_database);
        }
        if self.staged_attachments.exists() {
            let _ = fs::remove_dir_all(self.staged_attachments);
        }
    }
}

impl LocalStore {
    pub fn create_backup(
        &self,
        destination: Option<String>,
        app_version: &str,
    ) -> AppResult<String> {
        let destination =
            self.resolve_output_path(destination, &self.backups_dir, "sauvegarde", "zentra")?;
        self.create_backup_at(&destination, app_version)?;
        // La preuve de préparation n'est publiée qu'une fois l'archive finale
        // synchronisée puis installée atomiquement par `create_backup_at`.
        self.persist_successful_backup(&destination)?;
        Ok(destination.to_string_lossy().into_owned())
    }

    pub(crate) fn backup_status(&self) -> Value {
        let Some(proof) = self.load_backup_status() else {
            return json!({
                "last_success_at": Value::Null,
                "last_path": Value::Null,
                "next_scheduled_at": Value::Null,
            });
        };
        json!({
            "last_success_at": proof.last_success_at,
            "last_path": proof.last_path,
            "next_scheduled_at": Value::Null,
        })
    }

    fn backup_status_path(&self) -> PathBuf {
        self.data_dir.join(BACKUP_STATUS_FILE)
    }

    fn persist_successful_backup(&self, destination: &Path) -> AppResult<()> {
        let metadata = fs::metadata(destination)?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(AppError::Validation(
                "La sauvegarde finale n'est pas un fichier local valide.".into(),
            ));
        }
        let proof = BackupStatusProof {
            format: BACKUP_STATUS_FORMAT.into(),
            format_version: BACKUP_STATUS_VERSION,
            last_success_at: now_iso(),
            last_path: destination.to_string_lossy().into_owned(),
        };
        let mut temporary = tempfile::Builder::new()
            .prefix(".backup-status-")
            .suffix(".tmp")
            .tempfile_in(&self.data_dir)?;
        serde_json::to_writer_pretty(temporary.as_file_mut(), &proof)?;
        temporary.as_file_mut().write_all(b"\n")?;
        temporary.as_file_mut().sync_all()?;
        temporary
            .persist(self.backup_status_path())
            .map_err(|error| AppError::Io(error.error))?;
        Ok(())
    }

    fn load_backup_status(&self) -> Option<BackupStatusProof> {
        let path = self.backup_status_path();
        let metadata = fs::metadata(&path).ok()?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BACKUP_STATUS_BYTES {
            return None;
        }
        let file = File::open(path).ok()?;
        let mut bytes = Vec::new();
        file.take(MAX_BACKUP_STATUS_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_BACKUP_STATUS_BYTES {
            return None;
        }
        let proof: BackupStatusProof = serde_json::from_slice(&bytes).ok()?;
        if proof.format != BACKUP_STATUS_FORMAT
            || proof.format_version != BACKUP_STATUS_VERSION
            || chrono::DateTime::parse_from_rfc3339(&proof.last_success_at).is_err()
            || proof.last_path.trim().is_empty()
            || !Path::new(&proof.last_path).is_file()
        {
            return None;
        }
        Some(proof)
    }

    pub fn export_json(&self, destination: Option<String>, app_version: &str) -> AppResult<String> {
        let destination =
            self.resolve_output_path(destination, &self.exports_dir, "export", "json")?;
        let workspace = self.get_workspace()?;
        let envelope = ExportEnvelope {
            format: "helvichantier-json-export".into(),
            format_version: 1,
            exported_at: now_iso(),
            app_version: app_version.into(),
            data: workspace,
        };
        let mut file = create_new_file(&destination)?;
        serde_json::to_writer_pretty(&mut file, &envelope)?;
        file.sync_all()?;
        Ok(destination.to_string_lossy().into_owned())
    }

    pub fn export_csv_archive(
        &self,
        destination: Option<String>,
        app_version: &str,
    ) -> AppResult<String> {
        let destination =
            self.resolve_output_path(destination, &self.exports_dir, "export-listes", "zip")?;
        let mut workspace = self.get_workspace()?;
        let object = workspace.as_object_mut().ok_or_else(|| {
            AppError::Validation(
                "Les données locales ne peuvent pas être exportées en listes CSV.".into(),
            )
        })?;
        let connection = self.connect()?;
        for (collection, sql) in CSV_EXPORT_DIRECT_COLLECTIONS {
            object.insert(
                (*collection).into(),
                json!(query_all(&connection, sql, [])?),
            );
        }
        write_csv_export_archive(&destination, &workspace, app_version)?;
        Ok(destination.to_string_lossy().into_owned())
    }

    pub fn restore_backup(&self, source: &str, app_version: &str) -> AppResult<()> {
        self.restore_backup_with_limits(source, app_version, ARCHIVE_EXTRACTION_LIMITS)
    }

    fn restore_backup_with_limits(
        &self,
        source: &str,
        app_version: &str,
        limits: ArchiveExtractionLimits,
    ) -> AppResult<()> {
        let source = PathBuf::from(source);
        if !source.is_file() {
            return Err(AppError::Validation(
                "La sauvegarde sélectionnée est introuvable.".into(),
            ));
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !extension.eq_ignore_ascii_case("zentra")
            && !extension.eq_ignore_ascii_case("elyko")
            && !extension.eq_ignore_ascii_case("hchantier")
        {
            return Err(AppError::Validation(
                "La restauration exige un fichier .zentra, .elyko ou une ancienne sauvegarde .hchantier."
                    .into(),
            ));
        }

        let preserved_license = self.preserved_license()?;
        let extraction = tempfile::Builder::new()
            .prefix("restore-")
            .tempdir_in(&self.data_dir)?;
        let extracted_database = extraction.path().join(DATABASE_ENTRY);
        let extracted_attachments = extraction.path().join("attachments");
        fs::create_dir_all(&extracted_attachments)?;
        self.extract_and_validate_archive_with_limits(
            &source,
            &extracted_database,
            &extracted_attachments,
            limits,
        )?;
        validate_database(&extracted_database)?;
        strip_restored_license(&extracted_database)?;

        let safety_path = if self.database_path.is_file() {
            let safety_path =
                unique_default_path(&self.backups_dir, "avant-restauration", "zentra");
            self.create_backup_at(&safety_path, app_version)?;
            Some(safety_path)
        } else {
            None
        };

        self.install_restored_data_and_then(
            &extracted_database,
            &extracted_attachments,
            safety_path.as_deref(),
            || {
                self.migrate()?;
                self.restore_local_license(preserved_license.as_ref())?;
                validate_database(&self.database_path)?;
                Ok(())
            },
        )
    }

    fn create_backup_at(&self, destination: &Path, app_version: &str) -> AppResult<()> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        if destination.exists() {
            return Err(AppError::Validation(format!(
                "Le fichier existe déjà : {}",
                destination.display()
            )));
        }

        let snapshot_dir = tempfile::Builder::new()
            .prefix("backup-")
            .tempdir_in(&self.data_dir)?;
        let snapshot_database = snapshot_dir.path().join(DATABASE_ENTRY);
        self.snapshot_database(&snapshot_database)?;

        let manifest = BackupManifest {
            format: BACKUP_FORMAT.into(),
            format_version: BACKUP_FORMAT_VERSION,
            app_version: app_version.into(),
            created_at: now_iso(),
            database_file: DATABASE_ENTRY.into(),
            attachments_prefix: ATTACHMENTS_PREFIX.into(),
        };

        let temporary_archive = destination.with_extension(format!(
            "{}.tmp-{}",
            destination
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("zentra"),
            Uuid::new_v4()
        ));
        let archive_file = create_new_file(&temporary_archive)?;
        let mut archive = ZipWriter::new(archive_file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);

        archive.start_file("manifest.json", options)?;
        archive.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
        add_file_to_archive(&mut archive, &snapshot_database, DATABASE_ENTRY, options)?;
        for entry in WalkDir::new(&self.attachments_dir)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
        {
            let relative = entry
                .path()
                .strip_prefix(&self.attachments_dir)
                .map_err(|_| AppError::UnsafePath(entry.path().to_path_buf()))?;
            ensure_safe_relative(relative)?;
            let archive_name = format!(
                "{ATTACHMENTS_PREFIX}{}",
                relative.to_string_lossy().replace('\\', "/")
            );
            add_file_to_archive(&mut archive, entry.path(), &archive_name, options)?;
        }
        let file = archive.finish()?;
        file.sync_all()?;
        if let Err(error) = fs::rename(&temporary_archive, destination) {
            let _ = fs::remove_file(&temporary_archive);
            return Err(error.into());
        }
        Ok(())
    }

    fn snapshot_database(&self, destination: &Path) -> AppResult<()> {
        let source = self.connect()?;
        source.execute_batch("PRAGMA wal_checkpoint(FULL);")?;
        let mut target = Connection::open(destination)?;
        let backup = Backup::new(&source, &mut target)?;
        backup.run_to_completion(16, Duration::from_millis(20), None)?;
        drop(backup);
        target.execute("DELETE FROM license_state", [])?;
        target.execute_batch("PRAGMA journal_mode=DELETE;")?;
        Ok(())
    }

    fn preserved_license(&self) -> AppResult<Option<PreservedLicense>> {
        let connection = self.connect()?;
        connection
            .query_row(
                "SELECT token_sha256,license_id,customer_name,plan,price_chf_cents,issued_at,valid_from,valid_until,verified_at,last_seen_date,clock_anchor_version FROM license_state WHERE id=1",
                [],
                |row| {
                    Ok(PreservedLicense {
                        token_sha256: row.get(0)?,
                        license_id: row.get(1)?,
                        customer_name: row.get(2)?,
                        plan: row.get(3)?,
                        price_chf_cents: row.get(4)?,
                        issued_at: row.get(5)?,
                        valid_from: row.get(6)?,
                        valid_until: row.get(7)?,
                        verified_at: row.get(8)?,
                        last_seen_date: row.get(9)?,
                        clock_anchor_version: row.get(10)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    fn restore_local_license(&self, preserved: Option<&PreservedLicense>) -> AppResult<()> {
        let connection = self.connect()?;
        connection.execute("DELETE FROM license_state", [])?;
        if let Some(license) = preserved {
            connection.execute(
                "INSERT INTO license_state(id,token_sha256,license_id,customer_name,plan,price_chf_cents,issued_at,valid_from,valid_until,verified_at,last_seen_date,clock_anchor_version) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    license.token_sha256,
                    license.license_id,
                    license.customer_name,
                    license.plan,
                    license.price_chf_cents,
                    license.issued_at,
                    license.valid_from,
                    license.valid_until,
                    license.verified_at,
                    license.last_seen_date,
                    license.clock_anchor_version,
                ],
            )?;
        }
        Ok(())
    }

    fn extract_and_validate_archive_with_limits(
        &self,
        source: &Path,
        database_destination: &Path,
        attachments_destination: &Path,
        limits: ArchiveExtractionLimits,
    ) -> AppResult<()> {
        let file = File::open(source)?;
        let mut archive = ZipArchive::new(file)?;
        let manifest: BackupManifest = {
            let mut entry = archive.by_name("manifest.json").map_err(|_| {
                AppError::Validation("Le manifeste de sauvegarde est absent.".into())
            })?;
            let contents = read_utf8_limited(
                &mut entry,
                limits.manifest_bytes,
                "Le manifeste de sauvegarde",
            )?;
            serde_json::from_str(&contents)?
        };
        if manifest.format != BACKUP_FORMAT
            || manifest.format_version != BACKUP_FORMAT_VERSION
            || manifest.database_file != DATABASE_ENTRY
            || manifest.attachments_prefix != ATTACHMENTS_PREFIX
        {
            return Err(AppError::Validation(
                "Le format de cette sauvegarde n'est pas reconnu.".into(),
            ));
        }

        {
            let mut database_entry = archive.by_name(DATABASE_ENTRY).map_err(|_| {
                AppError::Validation("La base SQLite est absente de la sauvegarde.".into())
            })?;
            copy_reader_to_new_file_limited(
                &mut database_entry,
                database_destination,
                limits.database_bytes,
                "La base de données de la sauvegarde",
            )?;
        }

        let mut total_attachment_bytes: u64 = 0;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            let name = entry.name().replace('\\', "/");
            if !name.starts_with(ATTACHMENTS_PREFIX) || entry.is_dir() {
                continue;
            }
            let relative_name = name.trim_start_matches(ATTACHMENTS_PREFIX);
            let relative = Path::new(relative_name);
            ensure_safe_relative(relative)?;
            let destination = attachments_destination.join(relative);
            let remaining = limits
                .attachments_bytes
                .checked_sub(total_attachment_bytes)
                .ok_or_else(|| {
                    AppError::Validation(
                        "Les pièces jointes de la sauvegarde dépassent la limite autorisée.".into(),
                    )
                })?;
            let extracted = copy_reader_to_new_file_limited(
                &mut entry,
                &destination,
                remaining,
                "Les pièces jointes de la sauvegarde",
            )?;
            total_attachment_bytes =
                total_attachment_bytes
                    .checked_add(extracted)
                    .ok_or_else(|| {
                        AppError::Validation(
                            "La taille extraite des pièces jointes est invalide.".into(),
                        )
                    })?;
        }
        Ok(())
    }

    fn install_restored_data_and_then<F>(
        &self,
        restored_database: &Path,
        restored_attachments: &Path,
        safety_path: Option<&Path>,
        finalize: F,
    ) -> AppResult<()>
    where
        F: FnOnce() -> AppResult<()>,
    {
        let swap = self.install_restored_data(restored_database, restored_attachments)?;
        match finalize() {
            Ok(()) => {
                swap.commit();
                Ok(())
            }
            Err(error) => match swap.rollback() {
                Ok(()) => Err(AppError::Validation(format!(
                    "La restauration a été annulée et les données précédentes ont été rétablies. Cause : {error}{}",
                    safety_path
                        .map(|path| format!(" Une sauvegarde de sécurité reste disponible dans {}.", path.display()))
                        .unwrap_or_default()
                ))),
                Err(rollback_error) => Err(AppError::Validation(format!(
                    "La restauration a échoué ({error}) et le retour automatique est incomplet ({rollback_error}).{}",
                    safety_path
                        .map(|path| format!(" Récupérez la sauvegarde de sécurité : {}.", path.display()))
                        .unwrap_or_default()
                ))),
            },
        }
    }

    fn install_restored_data(
        &self,
        restored_database: &Path,
        restored_attachments: &Path,
    ) -> AppResult<RestoredDataSwap> {
        let token = Uuid::new_v4();
        let staged_database = self.data_dir.join(format!(".restore-{token}.sqlite3"));
        let old_database = self
            .data_dir
            .join(format!(".before-restore-{token}.sqlite3"));
        let staged_attachments = self.data_dir.join(format!(".restore-attachments-{token}"));
        let old_attachments = self
            .data_dir
            .join(format!(".before-restore-attachments-{token}"));

        let mut swap = RestoredDataSwap {
            database_path: self.database_path.clone(),
            attachments_dir: self.attachments_dir.clone(),
            staged_database,
            staged_attachments,
            old_database,
            old_attachments,
            old_database_staged: false,
            old_attachments_staged: false,
            new_database_installed: false,
            new_attachments_installed: false,
        };
        let staging_result = (|| -> AppResult<()> {
            fs::copy(restored_database, &swap.staged_database)?;
            copy_directory(restored_attachments, &swap.staged_attachments)?;
            Ok(())
        })();
        if let Err(error) = staging_result {
            let _ = swap.rollback();
            return Err(error);
        }
        let install_result = (|| -> AppResult<()> {
            remove_sqlite_sidecars(&self.database_path)?;
            if self.database_path.exists() {
                fs::rename(&self.database_path, &swap.old_database)?;
                swap.old_database_staged = true;
            }
            if self.attachments_dir.exists() {
                fs::rename(&self.attachments_dir, &swap.old_attachments)?;
                swap.old_attachments_staged = true;
            }
            fs::rename(&swap.staged_database, &self.database_path)?;
            swap.new_database_installed = true;
            fs::rename(&swap.staged_attachments, &self.attachments_dir)?;
            swap.new_attachments_installed = true;
            Ok(())
        })();
        if let Err(error) = install_result {
            return match swap.rollback() {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(AppError::Validation(format!(
                    "L’installation de la sauvegarde a échoué ({error}) et les données précédentes n’ont pas pu être entièrement rétablies ({rollback_error})."
                ))),
            };
        }
        Ok(swap)
    }

    fn resolve_output_path(
        &self,
        requested: Option<String>,
        default_directory: &Path,
        label: &str,
        extension: &str,
    ) -> AppResult<PathBuf> {
        let path = requested
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| unique_default_path(default_directory, label, extension));
        let path = if path.is_dir() {
            unique_default_path(&path, label, extension)
        } else if path.extension().is_none() {
            path.with_extension(extension)
        } else {
            path
        };
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        {
            return Err(AppError::Validation(format!(
                "L'extension attendue est .{extension}."
            )));
        }
        Ok(path)
    }
}

fn write_csv_export_archive(
    destination: &Path,
    workspace: &Value,
    app_version: &str,
) -> AppResult<()> {
    let object = workspace.as_object().ok_or_else(|| {
        AppError::Validation(
            "Les données locales ne peuvent pas être exportées en listes CSV.".into(),
        )
    })?;
    let file = create_new_file(destination)?;
    let result = (|| -> AppResult<()> {
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);

        archive.start_file("LISEZ-MOI.txt", options)?;
        archive.write_all(
            concat!(
                "EXPORT CSV ZENTRA\r\n",
                "=================\r\n\r\n",
                "Cette archive contient les listes métier et les registres comptables exportables au moment de l'export.\r\n",
                "Elle sert à la consultation et à l'import dans un tableur; elle ne remplace pas une sauvegarde Zentra.\r\n\r\n",
                "Format : UTF-8 avec BOM, séparateur virgule, champs entre guillemets et fins de ligne CRLF.\r\n",
                "Les textes pouvant être interprétés comme des formules sont neutralisés par une apostrophe.\r\n",
                "Les colonnes *_cents sont exprimées en centimes, *_milli en millièmes et *_bp en points de base.\r\n",
                "Les noms de colonnes restent stables et techniques pour faciliter les imports contrôlés.\r\n\r\n",
                "Aucun fichier PDF, image, sauvegarde, jeton de licence ni secret n'est inclus.\r\n",
                "Les pièces jointes apparaissent uniquement dans un index de métadonnées.\r\n",
                "Les documents de paie en cours d'analyse, leur texte extrait et les chemins locaux sont exclus.\r\n",
                "Utilisez l'export JSON si vous avez besoin de la configuration complète en clair.\r\n",
            )
            .as_bytes(),
        )?;

        let mut exported = Vec::with_capacity(CSV_EXPORT_COLLECTIONS.len());
        for (collection_name, file_name) in CSV_EXPORT_COLLECTIONS {
            let rows = object
                .get(*collection_name)
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    AppError::Validation(format!(
                        "La collection {collection_name} n'est pas disponible sous forme de liste."
                    ))
                })?;
            if rows.iter().any(|row| !row.is_object()) {
                return Err(AppError::Validation(format!(
                    "La collection {collection_name} contient une ligne non tabulaire."
                )));
            }

            let columns = rows
                .iter()
                .filter_map(Value::as_object)
                .flat_map(|row| row.keys().cloned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            if rows.is_empty() {
                exported.push(json!({
                    "collection": collection_name,
                    "file": Value::Null,
                    "rows": 0,
                    "columns": [],
                }));
                continue;
            }
            if columns.is_empty() {
                return Err(AppError::Validation(format!(
                    "La collection {collection_name} ne contient aucune colonne exportable."
                )));
            }

            let column_refs = columns
                .iter()
                .map(|column| (column.as_str(), column.as_str()))
                .collect::<Vec<_>>();
            let bytes = csv_from_rows(rows, &column_refs);
            archive.start_file(*file_name, options)?;
            archive.write_all(&bytes)?;
            exported.push(json!({
                "collection": collection_name,
                "file": file_name,
                "rows": rows.len(),
                "columns": columns,
                "size_bytes": bytes.len(),
            }));
        }

        let manifest = json!({
            "format": "zentra-csv-export",
            "format_version": 1,
            "exported_at": now_iso(),
            "app_version": app_version,
            "encoding": "UTF-8 BOM",
            "delimiter": ",",
            "collections": exported,
            "excluded": [
                {
                    "source": "settings, accounting_settings, reminder_settings, accounting_sequences",
                    "reason": "configuration singleton; disponible dans l'export JSON"
                },
                {
                    "source": "active_timers, backup_status",
                    "reason": "état local temporaire"
                },
                {
                    "source": "sales_operation_requests, recurrence_operation_requests, supplier_operation_requests, reminder_operation_requests",
                    "reason": "clés techniques d'idempotence; les opérations métier correspondantes sont exportées"
                },
                {
                    "source": "payroll_document_imports",
                    "reason": "documents de travail, texte extrait et chemins locaux sensibles"
                },
                {
                    "source": "company_brand_assets, attachment_files",
                    "reason": "fichiers binaires exclus; métadonnées seulement"
                },
                {
                    "source": "license_state",
                    "reason": "état technique de licence exclu de tout export de données métier"
                }
            ]
        });
        let mut manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
        manifest_bytes.push(b'\n');
        archive.start_file("manifest.json", options)?;
        archive.write_all(&manifest_bytes)?;

        let file = archive.finish()?;
        file.sync_all()?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

fn validate_database(path: &Path) -> AppResult<()> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Validation(format!(
            "La base restaurée échoue au contrôle d'intégrité : {integrity}"
        )));
    }
    let user_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version > SCHEMA_VERSION {
        return Err(AppError::Validation(format!(
            "La sauvegarde nécessite une version plus récente de Zentra ({user_version})."
        )));
    }
    let settings_table: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings')",
        [],
        |row| row.get(0),
    )?;
    if !settings_table {
        return Err(AppError::Validation(
            "La sauvegarde ne contient pas le schéma Zentra attendu.".into(),
        ));
    }
    let foreign_key_errors: i64 =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    if foreign_key_errors != 0 {
        return Err(AppError::Validation(
            "La sauvegarde contient des relations incohérentes.".into(),
        ));
    }
    Ok(())
}

fn strip_restored_license(path: &Path) -> AppResult<()> {
    let connection = Connection::open(path)?;
    let has_license_table: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='license_state')",
        [],
        |row| row.get(0),
    )?;
    if !has_license_table {
        return Ok(());
    }
    // Une archive peut provenir d'une très ancienne version qui transportait
    // encore le jeton. La copie extraite est assainie avant de devenir la base
    // active, afin que sa migration ne puisse jamais remplacer le coffre de la
    // machine destinataire.
    connection.execute_batch(
        "PRAGMA secure_delete=ON;
         DELETE FROM license_state;
         VACUUM;",
    )?;
    Ok(())
}

fn create_new_file(path: &Path) -> AppResult<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(Into::into)
}

fn copy_reader_limited<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    max_bytes: u64,
    label: &str,
) -> AppResult<u64> {
    let read_limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| AppError::Validation(format!("{label} a une limite invalide.")))?;
    let mut limited = reader.take(read_limit);
    let extracted_bytes = io::copy(&mut limited, writer)?;
    if extracted_bytes > max_bytes {
        return Err(AppError::Validation(format!(
            "{label} dépasse la limite autorisée de {max_bytes} octets."
        )));
    }
    Ok(extracted_bytes)
}

fn read_utf8_limited<R: Read>(reader: &mut R, max_bytes: u64, label: &str) -> AppResult<String> {
    let mut contents = Vec::new();
    copy_reader_limited(reader, &mut contents, max_bytes, label)?;
    String::from_utf8(contents)
        .map_err(|_| AppError::Validation(format!("{label} n'est pas un texte UTF-8 valide.")))
}

fn copy_reader_to_new_file_limited<R: Read>(
    reader: &mut R,
    destination: &Path,
    max_bytes: u64,
    label: &str,
) -> AppResult<u64> {
    let mut destination_file = create_new_file(destination)?;
    let result =
        copy_reader_limited(reader, &mut destination_file, max_bytes, label).and_then(|written| {
            destination_file.sync_all()?;
            Ok(written)
        });
    drop(destination_file);

    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

fn add_file_to_archive(
    archive: &mut ZipWriter<File>,
    source: &Path,
    name: &str,
    options: SimpleFileOptions,
) -> AppResult<()> {
    archive.start_file(name, options)?;
    let mut file = File::open(source)?;
    io::copy(&mut file, archive)?;
    Ok(())
}

fn ensure_safe_relative(path: &Path) -> AppResult<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AppError::UnsafePath(path.to_path_buf()));
    }
    Ok(())
}

fn unique_default_path(directory: &Path, label: &str, extension: &str) -> PathBuf {
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let preferred = directory.join(format!("Zentra-{label}-{timestamp}.{extension}"));
    if !preferred.exists() {
        return preferred;
    }
    directory.join(format!(
        "Zentra-{label}-{timestamp}-{}.{}",
        Uuid::new_v4(),
        extension
    ))
}

fn copy_directory(source: &Path, destination: &Path) -> AppResult<()> {
    fs::create_dir_all(destination)?;
    for entry in WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|_| AppError::UnsafePath(entry.path().to_path_buf()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        ensure_safe_relative(relative)?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn remove_sqlite_sidecars(database_path: &Path) -> AppResult<()> {
    for suffix in ["-wal", "-shm"] {
        let path = PathBuf::from(format!("{}{}", database_path.display(), suffix));
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn seed_license(store: &LocalStore, license_id: &str) -> String {
        let token = format!("test-protected-{license_id}-{}", "x".repeat(128));
        let token_sha256 = store.install_test_protected_license_token(&token).unwrap();
        store
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO license_state(id,token_sha256,license_id,customer_name,plan,price_chf_cents,issued_at,valid_from,valid_until,verified_at,last_seen_date,clock_anchor_version) VALUES(1,?,?,?,?,?,?,?,?,?,?,1)",
                params![
                    token_sha256,
                    license_id,
                    "Entreprise test",
                    crate::license::LICENSE_PLAN,
                    5_000,
                    "2026-08-30T00:00:00Z",
                    "2026-08-30",
                    "2026-09-30",
                    "2026-08-30T00:00:00Z",
                    "2026-08-30",
                ],
            )
            .unwrap();
        token
    }

    fn stored_license_id(store: &LocalStore) -> Option<String> {
        store
            .connect()
            .unwrap()
            .query_row(
                "SELECT license_id FROM license_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
    }

    fn stored_clock_anchor_version(store: &LocalStore) -> Option<i64> {
        store
            .connect()
            .unwrap()
            .query_row(
                "SELECT clock_anchor_version FROM license_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
    }

    #[test]
    fn database_snapshot_excludes_the_license() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        seed_license(&store, "lic-local-only");
        let snapshot = temporary.path().join("snapshot.sqlite3");

        store.snapshot_database(&snapshot).unwrap();

        let snapshot_connection = Connection::open(snapshot).unwrap();
        let snapshot_count: i64 = snapshot_connection
            .query_row("SELECT COUNT(*) FROM license_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(snapshot_count, 0);
        assert_eq!(stored_license_id(&store).as_deref(), Some("lic-local-only"));
    }

    #[test]
    fn restored_legacy_database_is_scrubbed_before_it_can_replace_the_local_vault() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("legacy.sqlite3");
        let legacy_token = format!("legacy-secret-token-{}", "z".repeat(192));
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE license_state(id INTEGER PRIMARY KEY,token TEXT NOT NULL);",
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO license_state(id,token) VALUES(1,?1)",
                    params![legacy_token],
                )
                .unwrap();
        }

        strip_restored_license(&path).unwrap();

        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM license_state", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(connection);
        let bytes = fs::read(path).unwrap();
        assert!(!bytes
            .windows(legacy_token.len())
            .any(|window| window == legacy_token.as_bytes()));
    }

    #[test]
    fn csv_archive_exports_only_allowlisted_tabular_data_safely() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("listes.zip");
        let mut workspace = serde_json::Map::new();
        for (collection, _) in CSV_EXPORT_COLLECTIONS {
            workspace.insert((*collection).into(), Value::Array(Vec::new()));
        }
        workspace.insert(
            "clients".into(),
            json!([{
                "id": "client-1",
                "name": "=HYPERLINK(\"https://example.invalid\")",
                "notes": "Ligne 1\nLigne \"2\"",
                "balance_cents": 12345
            }]),
        );
        workspace.insert(
            "payroll_document_imports".into(),
            json!([{
                "stored_path": "C:\\\\Users\\\\Alice\\\\sensible.pdf",
                "extracted_text": "contenu confidentiel"
            }]),
        );

        write_csv_export_archive(&destination, &Value::Object(workspace), "1.21.0").unwrap();

        let mut archive = ZipArchive::new(File::open(destination).unwrap()).unwrap();
        let names = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_owned())
            .collect::<Vec<_>>();
        assert!(names.contains(&"LISEZ-MOI.txt".to_owned()));
        assert!(names.contains(&"01_referentiels/clients.csv".to_owned()));
        assert!(names.contains(&"manifest.json".to_owned()));
        assert!(CSV_EXPORT_COLLECTIONS
            .iter()
            .any(|(collection, _)| *collection == "vat_return_exports"));
        assert!(CSV_EXPORT_COLLECTIONS
            .iter()
            .any(|(collection, _)| *collection == "payslip_small_salary_assessments"));
        assert!(!names
            .iter()
            .any(|name| name.contains("payroll_document_imports")));

        let mut clients_csv = String::new();
        archive
            .by_name("01_referentiels/clients.csv")
            .unwrap()
            .read_to_string(&mut clients_csv)
            .unwrap();
        assert!(clients_csv.starts_with('\u{feff}'));
        assert!(clients_csv.contains("\"'=HYPERLINK(\"\"https://example.invalid\"\")\""));
        assert!(clients_csv.contains("\"12345\""));
        assert!(clients_csv.contains("\"Ligne 1\nLigne \"\"2\"\"\""));

        let mut manifest_json = String::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut manifest_json)
            .unwrap();
        let manifest: Value = serde_json::from_str(&manifest_json).unwrap();
        assert_eq!(manifest["format"], "zentra-csv-export");
        assert_eq!(manifest["app_version"], "1.21.0");
        assert!(manifest["collections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["collection"] == "clients" && item["rows"] == 1));
        assert!(manifest["excluded"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["source"]
                .as_str()
                .is_some_and(|source| source.contains("operation_requests"))));
    }

    #[test]
    fn csv_archive_never_overwrites_an_existing_file() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("listes.zip");
        fs::write(&destination, b"a conserver").unwrap();
        let workspace = Value::Object(
            CSV_EXPORT_COLLECTIONS
                .iter()
                .map(|(collection, _)| ((*collection).into(), Value::Array(Vec::new())))
                .collect(),
        );

        assert!(write_csv_export_archive(&destination, &workspace, "1.21.0").is_err());
        assert_eq!(fs::read(destination).unwrap(), b"a conserver");
    }

    #[test]
    fn csv_archive_includes_regulatory_registers_outside_the_live_workspace() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let connection = store.connect().unwrap();
        connection
            .execute(
                "INSERT INTO settings(
                   id,onboarding_completed,company_name,created_at,updated_at
                 ) VALUES(1,1,'Entreprise export','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO vat_profiles(
                   id,effective_from,reporting_method,form_of_reporting,periodicity,
                   gross_or_net,afc_authorization_confirmed,created_at,updated_at
                 ) VALUES('vat-profile-export','2026-01-01','effective','agreed',
                          'quarterly','net',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);

        let destination = temporary.path().join("registres.zip");
        store
            .export_csv_archive(Some(destination.to_string_lossy().into_owned()), "1.22.0")
            .unwrap();

        let mut archive = ZipArchive::new(File::open(destination).unwrap()).unwrap();
        let mut vat_profiles = String::new();
        archive
            .by_name("05_comptabilite/profils_tva.csv")
            .unwrap()
            .read_to_string(&mut vat_profiles)
            .unwrap();
        assert!(vat_profiles.contains("vat-profile-export"));
    }

    #[test]
    fn new_backups_use_zentra_extension_and_legacy_extensions_remain_readable() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();

        let current = PathBuf::from(store.create_backup(None, "1.13.0").unwrap());
        assert_eq!(
            current.extension().and_then(|value| value.to_str()),
            Some("zentra")
        );
        store
            .restore_backup(current.to_str().unwrap(), "1.13.0")
            .unwrap();

        for extension in ["elyko", "hchantier"] {
            let legacy = temporary.path().join(format!("legacy.{extension}"));
            fs::copy(&current, &legacy).unwrap();
            store
                .restore_backup(legacy.to_str().unwrap(), "1.13.0")
                .unwrap();
        }
    }

    #[test]
    fn failed_backup_never_publishes_or_replaces_a_success_proof() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        let failed_destination = temporary.path().join("deja-present.zentra");
        fs::write(&failed_destination, b"ne pas remplacer").unwrap();

        assert!(store
            .create_backup(
                Some(failed_destination.to_string_lossy().into_owned()),
                "1.13.0",
            )
            .is_err());
        assert_eq!(store.backup_status()["last_success_at"], Value::Null);

        let successful_destination = temporary.path().join("valide.zentra");
        store
            .create_backup(
                Some(successful_destination.to_string_lossy().into_owned()),
                "1.13.0",
            )
            .unwrap();
        let replacement_destination = temporary.path().join("valide-2.zentra");
        store
            .create_backup(
                Some(replacement_destination.to_string_lossy().into_owned()),
                "1.13.0",
            )
            .expect("atomically replace the previous success proof");
        let successful_status = store.backup_status();
        assert_eq!(
            successful_status["last_path"],
            replacement_destination.to_string_lossy().as_ref()
        );

        assert!(store
            .create_backup(
                Some(failed_destination.to_string_lossy().into_owned()),
                "1.13.0",
            )
            .is_err());
        assert_eq!(store.backup_status(), successful_status);
    }

    #[test]
    fn restore_keeps_the_destination_machine_license() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
        let source_token = seed_license(&source, "lic-source-must-not-travel");
        let archive = temporary.path().join("source.hchantier");
        source.create_backup_at(&archive, "1.0.0").unwrap();

        let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
        let destination_token = seed_license(&destination, "lic-destination");
        destination
            .restore_backup(archive.to_str().unwrap(), "1.0.0")
            .unwrap();

        assert_eq!(
            stored_license_id(&destination).as_deref(),
            Some("lic-destination")
        );
        assert_eq!(stored_clock_anchor_version(&destination), Some(1));
        assert_eq!(
            destination
                .read_test_protected_license_token()
                .unwrap()
                .as_deref(),
            Some(destination_token.as_str())
        );
        assert_ne!(destination_token, source_token);
        assert!(fs::read_dir(&destination.backups_dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("avant-restauration")));
    }

    #[test]
    fn post_install_failure_rolls_back_database_and_attachments() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
        seed_license(&destination, "lic-original");
        fs::write(
            destination.attachments_dir.join("original.txt"),
            b"original",
        )
        .unwrap();

        let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
        fs::write(source.attachments_dir.join("restored.txt"), b"restored").unwrap();
        let restored_database = temporary.path().join("restored.sqlite3");
        source.snapshot_database(&restored_database).unwrap();

        let error = destination
            .install_restored_data_and_then(
                &restored_database,
                &source.attachments_dir,
                None,
                || {
                    Err(AppError::Validation(
                        "échec final simulé après installation".into(),
                    ))
                },
            )
            .expect_err("the simulated finalization must fail");

        assert!(error
            .to_string()
            .contains("données précédentes ont été rétablies"));
        assert_eq!(
            stored_license_id(&destination).as_deref(),
            Some("lic-original")
        );
        assert!(destination.attachments_dir.join("original.txt").is_file());
        assert!(!destination.attachments_dir.join("restored.txt").exists());
    }

    #[test]
    fn limited_file_copy_counts_streamed_bytes_and_removes_partial_output() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("oversized.bin");
        let mut source = Cursor::new(vec![0x41; 65]);

        let error =
            copy_reader_to_new_file_limited(&mut source, &destination, 32, "Le fichier de test")
                .expect_err("the streamed content is larger than the runtime limit");

        assert!(error.to_string().contains("dépasse la limite"));
        assert!(!destination.exists());
    }

    #[test]
    fn forged_zip_size_metadata_cannot_bypass_the_stream_limit() {
        let temporary = tempfile::tempdir().unwrap();
        let archive_path = temporary.path().join("forged-size.zip");
        let archive_file = File::create(&archive_path).unwrap();
        let mut writer = ZipWriter::new(archive_file);
        writer
            .start_file(
                "oversized.bin",
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(&[0x41; 65]).unwrap();
        writer.finish().unwrap();

        let mut archive_bytes = fs::read(&archive_path).unwrap();
        let local_header = archive_bytes
            .windows(4)
            .position(|window| window == b"PK\x03\x04")
            .unwrap();
        let central_header = archive_bytes
            .windows(4)
            .position(|window| window == b"PK\x01\x02")
            .unwrap();
        archive_bytes[local_header + 22..local_header + 26].copy_from_slice(&1_u32.to_le_bytes());
        archive_bytes[central_header + 24..central_header + 28]
            .copy_from_slice(&1_u32.to_le_bytes());
        fs::write(&archive_path, archive_bytes).unwrap();

        let mut archive = ZipArchive::new(File::open(&archive_path).unwrap()).unwrap();
        let mut entry = archive.by_name("oversized.bin").unwrap();
        assert_eq!(entry.size(), 1, "the forged metadata must look harmless");
        let destination = temporary.path().join("extracted.bin");

        let error = copy_reader_to_new_file_limited(
            &mut entry,
            &destination,
            32,
            "Le fichier ZIP falsifié",
        )
        .expect_err("actual decompressed bytes must enforce the limit");

        assert!(error.to_string().contains("dépasse la limite"));
        assert!(!destination.exists());
    }

    #[test]
    fn oversized_attachment_aborts_restore_without_touching_active_data() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
        fs::write(source.attachments_dir.join("oversized.bin"), vec![0x41; 65]).unwrap();
        let archive = temporary.path().join("oversized.elyko");
        source.create_backup_at(&archive, "1.0.0").unwrap();

        let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
        seed_license(&destination, "lic-must-survive");
        fs::write(
            destination.attachments_dir.join("original.txt"),
            b"original",
        )
        .unwrap();

        let error = destination
            .restore_backup_with_limits(
                archive.to_str().unwrap(),
                "1.0.0",
                ArchiveExtractionLimits {
                    manifest_bytes: MAX_MANIFEST_BYTES,
                    database_bytes: MAX_DATABASE_BYTES,
                    attachments_bytes: 32,
                },
            )
            .expect_err("the actual attachment bytes exceed the test limit");

        assert!(error.to_string().contains("dépasse la limite"));
        assert_eq!(
            stored_license_id(&destination).as_deref(),
            Some("lic-must-survive")
        );
        assert_eq!(
            fs::read(destination.attachments_dir.join("original.txt")).unwrap(),
            b"original"
        );
        assert!(!destination.attachments_dir.join("oversized.bin").exists());
        assert!(!fs::read_dir(&destination.backups_dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("avant-restauration")));
        assert!(!fs::read_dir(&destination.data_dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with("restore-")));
    }
}
