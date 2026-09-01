use std::{
    collections::HashSet,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, NaiveDate};
use image::{ImageFormat, ImageReader};
use regex::Regex;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{AppError, AppResult},
    models::{
        ConfirmPayrollImportInput, PayrollAnalysisManifest, PayrollImportDraft,
        PayrollImportEmployeeDraft, PayrollImportLineDraft, StagePayrollDocumentsInput,
        UpdatePayrollImportDraftInput,
    },
};

const MAX_IMPORT_FILES: usize = 40;
const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 8_192;
const MAX_IMAGE_PIXELS: u64 = 24_000_000;
const MAX_EXTRACTED_TEXT_CHARS: usize = 80_000;
const MAX_PDF_PAGES: usize = 12;
const ENGINE_VERSION: &str = "elyko-local-parser-2";
const ANALYSIS_MANIFEST_SCHEMA_VERSION: i64 = 1;
const MAX_ANALYSIS_PASSES: i64 = 4;
const MAX_FIELD_PROVENANCE_ITEMS: usize = 256;
const MAX_LINE_PROVENANCE_ITEMS: usize = 512;
const MAX_ANALYSIS_CONFLICTS: usize = 128;
const MAX_ANALYSIS_MANIFEST_BYTES: usize = 1_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PayrollDocumentType {
    Pdf,
    Png,
    Jpeg,
    Webp,
}

impl PayrollDocumentType {
    fn from_extension(extension: &str) -> Option<Self> {
        match extension {
            "pdf" => Some(Self::Pdf),
            "png" => Some(Self::Png),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }

    fn media_kind(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Png | Self::Jpeg | Self::Webp => "image",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Pdf => "PDF",
            Self::Png => "PNG",
            Self::Jpeg => "JPEG",
            Self::Webp => "WEBP",
        }
    }

    fn mime_type(self) -> &'static str {
        match self {
            Self::Pdf => "application/pdf",
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
        }
    }
}

fn manifest_text(value: &str, label: &str, max_chars: usize) -> AppResult<String> {
    let value = value.trim();
    let count = value.chars().count();
    if count == 0 || count > max_chars || value.chars().any(char::is_control) {
        return Err(AppError::Validation(format!(
            "Le champ {label} du manifeste d'analyse est invalide."
        )));
    }
    Ok(value.to_owned())
}

fn manifest_target(value: &str, label: &str) -> AppResult<String> {
    let value = manifest_text(value, label, 160)?;
    if !value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '[' | ']')
    }) {
        return Err(AppError::Validation(format!(
            "La cible {label} du manifeste d'analyse est invalide."
        )));
    }
    Ok(value)
}

fn supported_payroll_manifest_field(field: &str) -> bool {
    matches!(
        field,
        "employee.name"
            | "employee.employee_number"
            | "employee.role"
            | "employee.address"
            | "employee.birth_date"
            | "employee.avs_number"
            | "employee.iban"
            | "employee.employment_rate"
            | "employee.salary_mode"
            | "period"
            | "payment_date"
            | "gross_cents"
            | "net_cents"
    )
}

fn payroll_manifest_field_value(draft: &PayrollImportDraft, field: &str) -> Option<String> {
    let value = match field {
        "employee.name" => draft.employee.name.trim().to_owned(),
        "employee.employee_number" => draft.employee.employee_number.trim().to_owned(),
        "employee.role" => draft.employee.role.trim().to_owned(),
        "employee.address" => draft.employee.address_line1.trim().to_owned(),
        "employee.birth_date" => draft.employee.birth_date.trim().to_owned(),
        "employee.avs_number" => draft
            .employee
            .avs_number
            .chars()
            .filter(char::is_ascii_digit)
            .collect(),
        "employee.iban" => draft
            .employee
            .iban
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>()
            .to_uppercase(),
        "employee.employment_rate" => draft.employee.employment_rate.to_string(),
        "employee.salary_mode" => draft.employee.salary_mode.clone(),
        "period" => draft.period.trim().to_owned(),
        "payment_date" => draft.payment_date.trim().to_owned(),
        "gross_cents" if draft.gross_cents > 0 => draft.gross_cents.to_string(),
        "net_cents" if draft.net_cents > 0 => draft.net_cents.to_string(),
        _ => String::new(),
    };
    (!value.is_empty()).then_some(value)
}

fn normalize_manifest_pages(
    pages: &mut Vec<i64>,
    analyzed_pages: &HashSet<i64>,
    label: &str,
) -> AppResult<()> {
    pages.sort_unstable();
    pages.dedup();
    if pages.is_empty() || pages.iter().any(|page| !analyzed_pages.contains(page)) {
        return Err(AppError::Validation(format!(
            "Les pages de provenance {label} sont absentes ou hors de l'analyse."
        )));
    }
    Ok(())
}

fn normalize_manifest_passes(
    pass_indexes: &mut Vec<i64>,
    passes: i64,
    label: &str,
) -> AppResult<()> {
    pass_indexes.sort_unstable();
    pass_indexes.dedup();
    if pass_indexes.is_empty() || pass_indexes.iter().any(|pass| !(1..=passes).contains(pass)) {
        return Err(AppError::Validation(format!(
            "Les passes de provenance {label} sont absentes ou invalides."
        )));
    }
    Ok(())
}

fn normalize_analysis_manifest(
    mut manifest: PayrollAnalysisManifest,
    expected_sha256: &str,
    media_kind: &str,
    page_count: Option<i64>,
    draft: &PayrollImportDraft,
) -> AppResult<PayrollAnalysisManifest> {
    if manifest.schema_version != ANALYSIS_MANIFEST_SCHEMA_VERSION {
        return Err(AppError::Validation(format!(
            "La version {} du manifeste d'analyse n'est pas prise en charge.",
            manifest.schema_version
        )));
    }
    manifest.model_id = manifest_text(&manifest.model_id, "model_id", 200)?;
    manifest.model_revision = manifest_text(&manifest.model_revision, "model_revision", 200)?;
    manifest.input_sha256 = manifest.input_sha256.trim().to_ascii_lowercase();
    if manifest.input_sha256.len() != 64
        || !manifest
            .input_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !manifest.input_sha256.eq_ignore_ascii_case(expected_sha256)
    {
        return Err(AppError::Validation(
            "Le hash d'entrée du manifeste ne correspond pas au document local.".into(),
        ));
    }
    if !(1..=MAX_ANALYSIS_PASSES).contains(&manifest.passes) {
        return Err(AppError::Validation(format!(
            "Le manifeste doit déclarer entre 1 et {MAX_ANALYSIS_PASSES} passes d'analyse."
        )));
    }
    let maximum_page = if media_kind == "image" {
        1
    } else {
        page_count
            .unwrap_or(MAX_PDF_PAGES as i64)
            .clamp(1, MAX_PDF_PAGES as i64)
    };
    manifest.analyzed_pages.sort_unstable();
    manifest.analyzed_pages.dedup();
    if manifest.analyzed_pages.is_empty()
        || manifest
            .analyzed_pages
            .iter()
            .any(|page| !(1..=maximum_page).contains(page))
    {
        return Err(AppError::Validation(
            "Les pages analysées du manifeste ne correspondent pas au document local.".into(),
        ));
    }
    if page_count.is_some() && manifest.analyzed_pages != (1..=maximum_page).collect::<Vec<_>>() {
        return Err(AppError::Validation(
            "Le manifeste ne couvre pas toutes les pages du document local.".into(),
        ));
    }
    let analyzed_pages = manifest
        .analyzed_pages
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    if manifest.field_provenance.len() > MAX_FIELD_PROVENANCE_ITEMS {
        return Err(AppError::Validation(
            "Le manifeste contient trop de provenances de champs.".into(),
        ));
    }
    let mut field_targets = HashSet::new();
    for provenance in &mut manifest.field_provenance {
        provenance.field = manifest_target(&provenance.field, "du champ")?;
        if !supported_payroll_manifest_field(&provenance.field) {
            return Err(AppError::Validation(format!(
                "La provenance du champ {} ne cible aucun champ de paie pris en charge.",
                provenance.field
            )));
        }
        provenance.value = manifest_text(&provenance.value, "de la valeur du champ", 500)?;
        if payroll_manifest_field_value(draft, &provenance.field).as_deref()
            != Some(provenance.value.as_str())
        {
            return Err(AppError::Validation(format!(
                "La provenance du champ {} ne correspond pas à la valeur du brouillon enregistré.",
                provenance.field
            )));
        }
        if !field_targets.insert(provenance.field.clone()) {
            return Err(AppError::Validation(format!(
                "La provenance du champ {} est déclarée plusieurs fois.",
                provenance.field
            )));
        }
        normalize_manifest_pages(&mut provenance.pages, &analyzed_pages, &provenance.field)?;
        normalize_manifest_passes(
            &mut provenance.pass_indexes,
            manifest.passes,
            &provenance.field,
        )?;
        if !(0..=10_000).contains(&provenance.confidence_bp) {
            return Err(AppError::Validation(format!(
                "La confiance du champ {} est invalide.",
                provenance.field
            )));
        }
    }
    manifest
        .field_provenance
        .sort_by(|left, right| left.field.cmp(&right.field));

    if manifest.line_provenance.len() > MAX_LINE_PROVENANCE_ITEMS {
        return Err(AppError::Validation(
            "Le manifeste contient trop de provenances de rubriques.".into(),
        ));
    }
    let mut line_indexes = HashSet::new();
    for provenance in &mut manifest.line_provenance {
        if provenance.line_index < 0 || provenance.line_index as usize >= draft.lines.len() {
            return Err(AppError::Validation(
                "Une provenance de rubrique ne correspond à aucune ligne du brouillon.".into(),
            ));
        }
        if !line_indexes.insert(provenance.line_index) {
            return Err(AppError::Validation(format!(
                "La provenance de la rubrique {} est déclarée plusieurs fois.",
                provenance.line_index + 1
            )));
        }
        provenance.label = manifest_text(&provenance.label, "label de rubrique", 200)?;
        provenance.kind = manifest_text(&provenance.kind, "type de rubrique", 30)?;
        if !matches!(
            provenance.kind.as_str(),
            "earning" | "deduction" | "reimbursement" | "employer"
        ) {
            return Err(AppError::Validation(format!(
                "Le type de la rubrique {} est invalide.",
                provenance.line_index + 1
            )));
        }
        let draft_line = &draft.lines[provenance.line_index as usize];
        if provenance.label != draft_line.label.trim()
            || provenance.kind != draft_line.kind
            || provenance.amount_cents != draft_line.amount_cents
        {
            return Err(AppError::Validation(format!(
                "La provenance de la rubrique {} ne correspond pas au brouillon enregistré.",
                provenance.line_index + 1
            )));
        }
        let label = format!("de la rubrique {}", provenance.line_index + 1);
        normalize_manifest_pages(&mut provenance.pages, &analyzed_pages, &label)?;
        normalize_manifest_passes(&mut provenance.pass_indexes, manifest.passes, &label)?;
        if !(0..=10_000).contains(&provenance.confidence_bp) {
            return Err(AppError::Validation(format!(
                "La confiance de la rubrique {} est invalide.",
                provenance.line_index + 1
            )));
        }
    }
    manifest
        .line_provenance
        .sort_by_key(|provenance| provenance.line_index);

    if manifest.conflicts.len() > MAX_ANALYSIS_CONFLICTS {
        return Err(AppError::Validation(
            "Le manifeste contient trop de conflits d'analyse.".into(),
        ));
    }
    let mut conflict_targets = HashSet::new();
    for conflict in &mut manifest.conflicts {
        conflict.target = manifest_target(&conflict.target, "du conflit")?;
        if !supported_payroll_manifest_field(&conflict.target) {
            return Err(AppError::Validation(format!(
                "Le conflit {} ne cible aucun champ de paie pris en charge.",
                conflict.target
            )));
        }
        if field_targets.contains(&conflict.target) {
            return Err(AppError::Validation(format!(
                "Le champ {} ne peut pas avoir simultanément une provenance résolue et un conflit.",
                conflict.target
            )));
        }
        if !conflict_targets.insert(conflict.target.clone()) {
            return Err(AppError::Validation(format!(
                "Le conflit {} est déclaré plusieurs fois.",
                conflict.target
            )));
        }
        if conflict.values.len() < 2 || conflict.values.len() > 8 {
            return Err(AppError::Validation(format!(
                "Le conflit {} doit conserver entre 2 et 8 valeurs distinctes.",
                conflict.target
            )));
        }
        conflict.values = conflict
            .values
            .iter()
            .map(|value| manifest_text(value, "valeur de conflit", 250))
            .collect::<AppResult<Vec<_>>>()?;
        conflict.values.sort();
        conflict.values.dedup();
        if conflict.values.len() < 2 {
            return Err(AppError::Validation(format!(
                "Le conflit {} doit conserver au moins deux valeurs distinctes.",
                conflict.target
            )));
        }
        normalize_manifest_pages(&mut conflict.pages, &analyzed_pages, &conflict.target)?;
        normalize_manifest_passes(
            &mut conflict.pass_indexes,
            manifest.passes,
            &conflict.target,
        )?;
    }
    manifest
        .conflicts
        .sort_by(|left, right| left.target.cmp(&right.target));

    manifest.analyzed_at = manifest_text(&manifest.analyzed_at, "analyzed_at", 64)?;
    DateTime::parse_from_rfc3339(&manifest.analyzed_at).map_err(|_| {
        AppError::Validation(
            "L'horodatage analyzed_at du manifeste doit être au format RFC 3339.".into(),
        )
    })?;
    if serde_json::to_vec(&manifest)?.len() > MAX_ANALYSIS_MANIFEST_BYTES {
        return Err(AppError::Validation(
            "Le manifeste d'analyse dépasse la taille locale autorisée.".into(),
        ));
    }
    Ok(manifest)
}

fn manifest_line_matches(
    line: &PayrollImportLineDraft,
    evidence: &crate::models::PayrollAnalysisLineProvenance,
) -> bool {
    line.label.trim() == evidence.label.trim()
        && line.kind == evidence.kind
        && line.amount_cents == evidence.amount_cents
}

/// Retire seulement les preuves devenues fausses après une correction. Une
/// identité de ligne connue (source OCR puis id local) interdit de transférer
/// la preuve à une autre occurrence qui aurait simplement le même contenu.
fn reconcile_analysis_manifest(
    mut manifest: PayrollAnalysisManifest,
    previous_draft: &PayrollImportDraft,
    next_draft: &PayrollImportDraft,
) -> PayrollAnalysisManifest {
    manifest.field_provenance.retain(|evidence| {
        payroll_manifest_field_value(next_draft, &evidence.field).as_deref()
            == Some(evidence.value.as_str())
    });

    let mut used_next_indexes = HashSet::new();
    manifest.line_provenance = manifest
        .line_provenance
        .into_iter()
        .filter_map(|mut evidence| {
            let previous_line = previous_draft.lines.get(evidence.line_index as usize)?;
            if !manifest_line_matches(previous_line, &evidence) {
                return None;
            }

            let identities = [
                (!previous_line.source_ref.trim().is_empty())
                    .then_some((true, previous_line.source_ref.trim())),
                (!previous_line.id.trim().is_empty()).then_some((false, previous_line.id.trim())),
            ];
            let has_source_identity = !previous_line.source_ref.trim().is_empty();
            let mut next_index = None;
            for identity in identities.into_iter().flatten() {
                let matching_indexes = next_draft
                    .lines
                    .iter()
                    .enumerate()
                    .filter_map(|(index, line)| {
                        if used_next_indexes.contains(&index) {
                            return None;
                        }
                        let matches = if identity.0 {
                            line.source_ref.trim() == identity.1
                        } else {
                            line.id.trim() == identity.1
                        };
                        matches.then_some(index)
                    })
                    .collect::<Vec<_>>();
                if matching_indexes.is_empty() {
                    continue;
                }
                if matching_indexes.len() != 1 {
                    return None;
                }
                let candidate_index = matching_indexes[0];
                if !manifest_line_matches(&next_draft.lines[candidate_index], &evidence) {
                    return None;
                }
                next_index = Some(candidate_index);
                break;
            }

            if has_source_identity && next_index.is_none() {
                // La ligne identifiée a été supprimée. Ne pas réaffecter sa
                // preuve à un ajout humain de même libellé et montant.
                return None;
            }
            if next_index.is_none() {
                let matching_indexes = next_draft
                    .lines
                    .iter()
                    .enumerate()
                    .filter_map(|(index, line)| {
                        (!used_next_indexes.contains(&index)
                            && manifest_line_matches(line, &evidence))
                        .then_some(index)
                    })
                    .collect::<Vec<_>>();
                // Compatibilité avec les anciens brouillons qui ne renvoyaient
                // pas les ids locaux, seulement si une occurrence exacte et
                // unique subsiste. Une source OCR connue reste fail-closed.
                if matching_indexes.len() != 1 {
                    return None;
                }
                next_index = matching_indexes.first().copied();
            }

            let next_index = next_index?;
            used_next_indexes.insert(next_index);
            evidence.line_index = next_index as i64;
            evidence.label = next_draft.lines[next_index].label.clone();
            Some(evidence)
        })
        .collect();
    manifest
        .line_provenance
        .sort_by_key(|evidence| evidence.line_index);

    manifest.conflicts.retain(|conflict| {
        payroll_manifest_field_value(previous_draft, &conflict.target)
            == payroll_manifest_field_value(next_draft, &conflict.target)
    });
    manifest
}

fn reconcile_stored_analysis_manifest(
    stored_manifest_json: Option<&str>,
    stored_draft_json: &str,
    next_draft: &PayrollImportDraft,
    expected_sha256: &str,
    media_kind: &str,
    page_count: Option<i64>,
) -> Option<String> {
    let previous_draft = serde_json::from_str::<PayrollImportDraft>(stored_draft_json).ok()?;
    let manifest = serde_json::from_str::<PayrollAnalysisManifest>(stored_manifest_json?).ok()?;
    let reconciled = reconcile_analysis_manifest(manifest, &previous_draft, next_draft);
    let normalized = normalize_analysis_manifest(
        reconciled,
        expected_sha256,
        media_kind,
        page_count,
        next_draft,
    )
    .ok()?;
    serde_json::to_string(&normalized).ok()
}

fn verify_document_content_hash(bytes: &[u8], expected_sha256: &str) -> AppResult<()> {
    let expected = expected_sha256.trim().to_ascii_lowercase();
    let actual = format!("{:x}", Sha256::digest(bytes));
    if expected.len() != 64
        || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
        || actual != expected
    {
        return Err(AppError::Validation(
            "La copie locale du document a changé depuis son import. Réimportez le fichier original avant de poursuivre l’analyse.".into(),
        ));
    }
    Ok(())
}

fn read_verified_managed_payroll_copy(
    attachments_dir: &Path,
    stored_path: &str,
    expected_sha256: &str,
) -> AppResult<(PathBuf, Vec<u8>)> {
    let canonical_path = fs::canonicalize(PathBuf::from(stored_path))?;
    let canonical_root = fs::canonicalize(attachments_dir)?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(AppError::UnsafePath(canonical_path));
    }
    let bytes = fs::read(&canonical_path)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(AppError::Validation(
            "Le document local est vide ou dépasse la limite de 25 Mo.".into(),
        ));
    }
    verify_document_content_hash(&bytes, expected_sha256)?;
    Ok((canonical_path, bytes))
}

fn stored_draft_matches(stored_json: &str, expected_json: &str) -> bool {
    let Ok(mut stored) = serde_json::from_str::<PayrollImportDraft>(stored_json) else {
        return false;
    };
    let Ok(mut expected) = serde_json::from_str::<PayrollImportDraft>(expected_json) else {
        return false;
    };
    if normalize_draft(&mut stored, false).is_err() {
        return false;
    }
    if normalize_draft(&mut expected, false).is_err() {
        return false;
    }
    let evidence_payload = |draft: &PayrollImportDraft| {
        json!({
            "employee": draft.employee,
            "period": draft.period,
            "payment_date": draft.payment_date,
            "gross_cents": draft.gross_cents,
            "net_cents": draft.net_cents,
            "lines": draft.lines.iter().map(|line| json!({
                "label": line.label,
                "kind": line.kind,
                "amount_cents": line.amount_cents,
            })).collect::<Vec<_>>(),
        })
    };
    evidence_payload(&stored) == evidence_payload(&expected)
}

struct CreatedPayrollFiles {
    paths: Vec<PathBuf>,
    committed: bool,
}

impl CreatedPayrollFiles {
    fn new() -> Self {
        Self {
            paths: Vec::new(),
            committed: false,
        }
    }

    fn track(&mut self, path: PathBuf) {
        self.paths.push(path);
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for CreatedPayrollFiles {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        for path in self.paths.iter().rev() {
            let _ = fs::remove_file(path);
        }
    }
}

fn write_payroll_copy_atomic(target: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::UnsafePath(target.to_path_buf()))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".payroll-write-{}.tmp", Uuid::new_v4()));
    if let Err(error) = fs::write(&temporary, bytes) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    if !target.exists() {
        if let Err(error) = fs::rename(&temporary, target) {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        return Ok(());
    }

    // Windows ne garantit pas le remplacement d'une destination existante
    // avec rename. Garder l'ancienne copie permet un rollback si le second
    // déplacement échoue, sans jamais écrire partiellement le salaire cible.
    let backup = parent.join(format!(".payroll-backup-{}.tmp", Uuid::new_v4()));
    if let Err(error) = fs::rename(target, &backup) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    if let Err(error) = fs::rename(&temporary, target) {
        let _ = fs::rename(&backup, target);
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    if let Err(error) = fs::remove_file(&backup) {
        let _ = fs::remove_file(target);
        let _ = fs::rename(&backup, target);
        return Err(error.into());
    }
    Ok(())
}

fn stored_payroll_copy_matches(path: &Path, expected_sha256: &str) -> bool {
    fs::read(path)
        .ok()
        .is_some_and(|bytes| verify_document_content_hash(&bytes, expected_sha256).is_ok())
}

impl LocalStore {
    pub fn stage_payroll_documents(&self, input: StagePayrollDocumentsInput) -> AppResult<Value> {
        if input.paths.is_empty() {
            return Err(AppError::Validation(
                "Sélectionnez au moins une fiche de salaire PDF, PNG, JPG ou WEBP.".into(),
            ));
        }
        if input.paths.len() > MAX_IMPORT_FILES {
            return Err(AppError::Validation(format!(
                "Importez au maximum {MAX_IMPORT_FILES} documents par lot."
            )));
        }

        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let import_dir = self.attachments_dir.join("payroll-imports");
        fs::create_dir_all(&import_dir)?;
        let mut staged = Vec::new();
        let mut created_files = CreatedPayrollFiles::new();

        for raw_path in input.paths {
            let source = canonical_source_file(&raw_path)?;
            let metadata = fs::metadata(&source)?;
            if metadata.len() == 0 || metadata.len() > MAX_FILE_BYTES {
                return Err(AppError::Validation(format!(
                    "{} doit peser entre 1 octet et 25 Mo.",
                    source
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Le document")
                )));
            }
            let extension = source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let document_type =
                PayrollDocumentType::from_extension(&extension).ok_or_else(|| {
                    AppError::Validation(format!(
                        "{} n'est pas un PDF ou une image pris en charge.",
                        source.display()
                    ))
                })?;
            let bytes = fs::read(&source)?;
            if bytes.is_empty() || bytes.len() as u64 > MAX_FILE_BYTES {
                return Err(AppError::Validation(format!(
                    "{} a changé pendant sa lecture et dépasse maintenant la limite de 25 Mo.",
                    source
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Le document")
                )));
            }
            validate_document_signature(&source, &bytes, document_type)?;
            validate_image_dimensions(&source, &bytes, document_type)?;
            let page_count = document_page_count(&source, &bytes, document_type)?;
            let media_kind = document_type.media_kind();
            let hash = format!("{:x}", Sha256::digest(&bytes));
            if let Some((existing_id, previous_stored_path)) = transaction
                .query_row(
                    "SELECT id,stored_path FROM payroll_document_imports WHERE file_sha256=?",
                    params![hash],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
            {
                // Le chemin de récupération est toujours reconstruit sous le
                // dossier géré; aucune valeur de chemin provenant de SQLite
                // n'est utilisée comme cible d'écriture.
                let canonical_id = Uuid::parse_str(&existing_id).map_err(|_| {
                    AppError::Validation(
                        "L'identifiant local du document existant est invalide; aucune copie n'a été écrite."
                            .into(),
                    )
                })?;
                let canonical_stored_path = import_dir.join(format!("{canonical_id}.{extension}"));
                let copy_already_existed = canonical_stored_path.exists();
                if previous_stored_path != canonical_stored_path.to_string_lossy()
                    || !stored_payroll_copy_matches(&canonical_stored_path, &hash)
                {
                    write_payroll_copy_atomic(&canonical_stored_path, &bytes)?;
                    if !copy_already_existed {
                        created_files.track(canonical_stored_path.clone());
                    }
                }
                let now = now_iso();
                transaction.execute(
                    "UPDATE payroll_document_imports SET stored_path=?,file_size=?,media_kind=?,page_count=?,status=CASE WHEN status IN ('rejected','error') THEN 'needs_review' ELSE status END,error_message=CASE WHEN status IN ('rejected','error') THEN NULL ELSE error_message END,reviewed_at=CASE WHEN status IN ('rejected','error') THEN NULL ELSE reviewed_at END,updated_at=? WHERE id=?",
                    params![
                        canonical_stored_path.to_string_lossy(),
                        bytes.len() as i64,
                        media_kind,
                        page_count as i64,
                        now,
                        existing_id,
                    ],
                )?;
                let existing = transaction.query_row(
                    "SELECT * FROM payroll_document_imports WHERE id=?",
                    params![existing_id],
                    crate::database::row_to_json_public,
                )?;
                staged.push(existing);
                continue;
            }

            let id = Uuid::new_v4().to_string();
            let stored_name = format!("{id}.{extension}");
            let stored_path = import_dir.join(stored_name);
            let source_name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("fiche-salaire")
                .to_owned();

            let (extracted_text, extraction_engine, mut draft, extraction_error) = if media_kind
                == "pdf"
            {
                match pdf_extract::extract_text_from_mem(&bytes) {
                    Ok(text) => {
                        let clean =
                            limit_chars(normalize_extracted_text(&text), MAX_EXTRACTED_TEXT_CHARS);
                        if clean.trim().is_empty() {
                            let mut empty = empty_draft();
                            empty.warnings.push(
                                    "Ce PDF semble être un scan sans couche texte. Lancez SmolVLM local puis contrôlez chaque champ."
                                        .into(),
                                );
                            (String::new(), "pdf_scan_pending", empty, None)
                        } else {
                            let parsed = draft_from_text(&clean);
                            (clean, "pdf_text", parsed, None)
                        }
                    }
                    Err(error) => {
                        let mut empty = empty_draft();
                        empty.warnings.push(
                                "La couche texte du PDF n'a pas pu être lue. Le document est conservé localement pour l'analyse visuelle."
                                    .into(),
                            );
                        (
                            String::new(),
                            "pdf_scan_pending",
                            empty,
                            Some(format!("Extraction PDF locale: {error}")),
                        )
                    }
                }
            } else {
                let mut empty = empty_draft();
                empty.warnings.push(
                        "Image prête pour SmolVLM local. Aucun champ ne sera créé avant votre contrôle."
                            .into(),
                    );
                (String::new(), "image_pending", empty, None)
            };
            if has_semantic_text_duplicate(&transaction, &extracted_text)? {
                draft.warnings.push(
                    "Un document au texte très proche existe déjà, mais les octets diffèrent : les deux fichiers sont conservés séparément pour éviter une déduplication silencieuse."
                        .into(),
                );
            }
            normalize_draft(&mut draft, false)?;
            let confidence_bp = draft_confidence(&draft);
            let now = now_iso();
            let draft_json = serde_json::to_string(&draft)?;
            // Écrire la copie immuable seulement après les détections de
            // doublon évite de laisser un fichier orphelin dans la sauvegarde.
            write_payroll_copy_atomic(&stored_path, &bytes)?;
            created_files.track(stored_path.clone());
            transaction.execute(
                "INSERT INTO payroll_document_imports(id,source_name,stored_path,file_sha256,media_kind,file_size,page_count,extraction_engine,engine_version,extracted_text,draft_json,confidence_bp,status,error_message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'needs_review',?,?,?)",
                params![
                    id,
                    source_name,
                    stored_path.to_string_lossy(),
                    hash,
                    media_kind,
                    bytes.len() as i64,
                    page_count as i64,
                    extraction_engine,
                    ENGINE_VERSION,
                    if extracted_text.is_empty() { None::<String> } else { Some(extracted_text) },
                    draft_json,
                    confidence_bp,
                    extraction_error,
                    now,
                    now,
                ],
            )?;
            let row = transaction.query_row(
                "SELECT * FROM payroll_document_imports WHERE id=?",
                params![id],
                crate::database::row_to_json_public,
            )?;
            staged.push(row);
        }
        transaction.commit()?;
        created_files.commit();
        Ok(json!({"imports": staged}))
    }

    pub fn list_payroll_document_imports(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        Ok(json!({
            "imports": query_all(
                &connection,
                "SELECT * FROM payroll_document_imports ORDER BY CASE status WHEN 'needs_review' THEN 0 ELSE 1 END, created_at DESC",
                [],
            )?
        }))
    }

    pub fn payroll_document_preview(&self, id: &str) -> AppResult<Value> {
        let id = id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "L'identifiant du document est obligatoire.".into(),
            ));
        }
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let stored: Option<(String, String)> = connection
            .query_row(
                "SELECT stored_path,file_sha256 FROM payroll_document_imports WHERE id=?",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (stored_path, expected_sha256) =
            stored.ok_or_else(|| AppError::NotFound(format!("payroll_document_imports/{id}")))?;
        let (canonical_path, bytes) = read_verified_managed_payroll_copy(
            &self.attachments_dir,
            &stored_path,
            &expected_sha256,
        )?;
        let extension = canonical_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let document_type = PayrollDocumentType::from_extension(&extension).ok_or_else(|| {
            AppError::Validation("Le format du document local n'est plus pris en charge.".into())
        })?;
        validate_document_signature(&canonical_path, &bytes, document_type)?;
        validate_image_dimensions(&canonical_path, &bytes, document_type)?;
        Ok(json!({
            "mime_type": document_type.mime_type(),
            "data_base64": STANDARD.encode(bytes),
        }))
    }

    pub fn update_payroll_import_draft(
        &self,
        input: UpdatePayrollImportDraftInput,
    ) -> AppResult<Value> {
        let UpdatePayrollImportDraftInput {
            id,
            draft,
            extraction_engine,
            engine_version,
            confidence_bp,
            analysis_manifest,
            clear_analysis_manifest,
        } = input;
        let id = id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "L'identifiant de l'import est obligatoire.".into(),
            ));
        }
        let mut draft = draft;
        normalize_draft(&mut draft, false)?;
        let confidence_bp = confidence_bp.clamp(0, 10_000);
        let engine = extraction_engine.trim();
        if engine.is_empty() || engine.chars().count() > 100 {
            return Err(AppError::Validation(
                "Le nom du moteur d'extraction est invalide.".into(),
            ));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if clear_analysis_manifest && analysis_manifest.is_some() {
            return Err(AppError::Validation(
                "Une mise à jour ne peut pas enregistrer et effacer le manifeste d'analyse en même temps."
                    .into(),
            ));
        }
        let import_state: Option<(
            String,
            String,
            String,
            Option<i64>,
            String,
            String,
            Option<String>,
        )> = transaction
            .query_row(
                "SELECT status,file_sha256,media_kind,page_count,draft_json,stored_path,analysis_manifest_json FROM payroll_document_imports WHERE id=?",
                params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()?;
        let (
            _status,
            file_sha256,
            media_kind,
            page_count,
            stored_draft_json,
            stored_path,
            stored_manifest_json,
        ) = match import_state {
            None => return Err(AppError::NotFound(format!("payroll_document_imports/{id}"))),
            Some((status, _, _, _, _, _, _)) if status == "confirmed" => {
                return Err(AppError::Validation(
                    "Un import déjà confirmé ne peut plus être remplacé par une analyse IA.".into(),
                ))
            }
            Some(state) => state,
        };
        if analysis_manifest.is_some() {
            read_verified_managed_payroll_copy(&self.attachments_dir, &stored_path, &file_sha256)?;
        }
        let manifest_json = analysis_manifest
            .map(|manifest| {
                normalize_analysis_manifest(manifest, &file_sha256, &media_kind, page_count, &draft)
            })
            .transpose()?
            .map(|manifest| serde_json::to_string(&manifest))
            .transpose()?;
        let engine_version = engine_version
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let draft_json = serde_json::to_string(&draft)?;
        let draft_changed = !stored_draft_matches(&stored_draft_json, &draft_json);
        let reconciled_manifest_json = draft_changed
            .then(|| {
                reconcile_stored_analysis_manifest(
                    stored_manifest_json.as_deref(),
                    &stored_draft_json,
                    &draft,
                    &file_sha256,
                    &media_kind,
                    page_count,
                )
            })
            .flatten();
        let updated_at = now_iso();
        if let Some(manifest_json) = manifest_json {
            transaction.execute(
                "UPDATE payroll_document_imports SET draft_json=?,analysis_manifest_json=?,extraction_engine=?,engine_version=?,confidence_bp=?,error_message=NULL,updated_at=? WHERE id=?",
                params![
                    draft_json,
                    manifest_json,
                    engine,
                    engine_version,
                    confidence_bp,
                    updated_at,
                    id,
                ],
            )?;
        } else if clear_analysis_manifest {
            transaction.execute(
                "UPDATE payroll_document_imports SET draft_json=?,analysis_manifest_json=NULL,extraction_engine=?,engine_version=?,confidence_bp=?,error_message=NULL,updated_at=? WHERE id=?",
                params![
                    draft_json,
                    engine,
                    engine_version,
                    confidence_bp,
                    updated_at,
                    id,
                ],
            )?;
        } else if draft_changed {
            transaction.execute(
                "UPDATE payroll_document_imports SET draft_json=?,analysis_manifest_json=?,extraction_engine=?,engine_version=?,confidence_bp=?,error_message=NULL,updated_at=? WHERE id=?",
                params![
                    draft_json,
                    reconciled_manifest_json,
                    engine,
                    engine_version,
                    confidence_bp,
                    updated_at,
                    id,
                ],
            )?;
        } else {
            // Compatibilité avec les anciens frontends: une propriété absente
            // préserve la trace lorsque le brouillon est identique. Si son
            // contenu change, la branche précédente filtre la trace au lieu de
            // l'effacer globalement.
            transaction.execute(
                "UPDATE payroll_document_imports SET draft_json=?,extraction_engine=?,engine_version=?,confidence_bp=?,error_message=NULL,updated_at=? WHERE id=?",
                params![
                    draft_json,
                    engine,
                    engine_version,
                    confidence_bp,
                    updated_at,
                    id,
                ],
            )?;
        }
        let result = transaction.query_row(
            "SELECT * FROM payroll_document_imports WHERE id=?",
            params![id],
            crate::database::row_to_json_public,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn reject_payroll_document_import(&self, id: &str) -> AppResult<Value> {
        let id = id.trim();
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE payroll_document_imports SET status='rejected',reviewed_at=?,updated_at=? WHERE id=? AND status='needs_review'",
            params![now_iso(), now_iso(), id],
        )?;
        if changed == 0 {
            return Err(AppError::Validation(
                "Cet import est introuvable ou a déjà été traité.".into(),
            ));
        }
        append_audit(
            &transaction,
            "reject",
            "payroll_document_import",
            id,
            &json!({"status":"rejected"}),
        )?;
        transaction.commit()?;
        Ok(json!({"id":id,"status":"rejected"}))
    }

    pub fn confirm_payroll_document_import(
        &self,
        input: ConfirmPayrollImportInput,
    ) -> AppResult<Value> {
        let ConfirmPayrollImportInput {
            id,
            employee_id,
            replace_existing_template,
            mut draft,
        } = input;
        let import_id = id.trim();
        normalize_draft(&mut draft, true)?;
        validate_confirmable_draft(&draft)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let import_state: Option<(
            String,
            String,
            String,
            String,
            String,
            Option<i64>,
            Option<String>,
        )> = transaction
            .query_row(
                "SELECT status,draft_json,stored_path,file_sha256,media_kind,page_count,analysis_manifest_json FROM payroll_document_imports WHERE id=?",
                params![import_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()?;
        let (
            _status,
            stored_draft_json,
            stored_path,
            file_sha256,
            media_kind,
            page_count,
            stored_manifest_json,
        ) = match import_state {
            None => {
                return Err(AppError::NotFound(format!(
                    "payroll_document_imports/{import_id}"
                )))
            }
            Some((status, _, _, _, _, _, _)) if status == "confirmed" => {
                return Err(AppError::Validation(
                    "Cette fiche a déjà été confirmée et importée.".into(),
                ))
            }
            Some((status, _, _, _, _, _, _)) if status == "rejected" => {
                return Err(AppError::Validation(
                    "Cette fiche a été rejetée. Réimportez le document pour recommencer.".into(),
                ))
            }
            Some(state) => state,
        };
        read_verified_managed_payroll_copy(&self.attachments_dir, &stored_path, &file_sha256)?;
        let draft_json = serde_json::to_string(&draft)?;
        let draft_changed = !stored_draft_matches(&stored_draft_json, &draft_json);
        let retained_manifest_json = if draft_changed {
            reconcile_stored_analysis_manifest(
                stored_manifest_json.as_deref(),
                &stored_draft_json,
                &draft,
                &file_sha256,
                &media_kind,
                page_count,
            )
        } else {
            stored_manifest_json
        };

        // Un bulletin historique ne doit jamais devenir implicitement le
        // salaire contractuel courant. Seuls les gains que la personne a
        // explicitement marqués « récurrents » peuvent alimenter le modèle.
        let (recurring, recurring_base_salary_cents) = reviewed_recurring_earnings(&draft);

        let employee_id = match employee_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(existing_id) => {
                let existing_identity: (
                    Option<String>,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                ) = transaction
                    .query_row(
                        "SELECT social_security_number,employee_number,birth_date,iban FROM employees WHERE id=?",
                        params![existing_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?
                    .ok_or_else(|| AppError::NotFound(format!("employees/{existing_id}")))?;
                validate_linked_employee_identity(
                    existing_identity.0.as_deref(),
                    existing_identity.1.as_deref(),
                    existing_identity.2.as_deref(),
                    existing_identity.3.as_deref(),
                    &draft.employee,
                )?;
                existing_id.to_owned()
            }
            None => {
                ensure_new_employee_identity_available(&transaction, &draft.employee)?;
                insert_employee_from_draft(
                    &transaction,
                    &draft.employee,
                    recurring_base_salary_cents,
                )?
            }
        };
        if replace_existing_template {
            let template_exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM employee_payroll_templates WHERE employee_id=?)",
                params![employee_id],
                |row| row.get(0),
            )?;
            if !template_exists {
                return Err(AppError::Validation(
                    "Aucun modèle salarial actuel n'existe pour ce collaborateur; il n'y a donc rien à remplacer.".into(),
                ));
            }
        }

        let duplicate: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM payslips WHERE employee_id=? AND period=?)",
            params![employee_id, draft.period],
            |row| row.get(0),
        )?;
        if duplicate {
            return Err(AppError::Validation(format!(
                "Une fiche existe déjà pour ce collaborateur et la période {}. Corrigez la période ou rattachez le document autrement.",
                draft.period
            )));
        }

        let payslip_id = Uuid::new_v4().to_string();
        let totals = draft_totals(&draft.lines);
        let now = now_iso();
        transaction.execute(
            "INSERT INTO payslips(id,employee_id,period,status,gross_cents,deductions_cents,net_cents,employer_costs_cents,payment_date,notes,created_at,updated_at) VALUES(?,?,?,'a_controler',?,?,?,?,?,'Import documentaire local à contrôler avant validation.',?,?)",
            params![
                payslip_id,
                employee_id,
                draft.period,
                totals.0,
                totals.1,
                totals.0.saturating_add(totals.3).saturating_sub(totals.1),
                totals.2,
                optional_text(&draft.payment_date),
                now,
                now,
            ],
        )?;
        for (position, line) in draft.lines.iter().enumerate() {
            transaction.execute(
                "INSERT INTO payslip_items(id,payslip_id,position,label,kind,amount_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                params![
                    Uuid::new_v4().to_string(),
                    payslip_id,
                    position as i64,
                    line.label,
                    line.kind,
                    line.amount_cents,
                    now,
                    now,
                ],
            )?;
        }

        if replace_existing_template && recurring.is_empty() {
            return Err(AppError::Validation(
                "Le modèle salarial actuel ne peut être remplacé que si au moins un gain récurrent a été contrôlé dans la fiche importée.".into(),
            ));
        }
        if !recurring.is_empty() {
            transaction.execute(
                employee_template_upsert_sql(replace_existing_template),
                params![
                    employee_id,
                    draft.employee.salary_mode,
                    recurring_base_salary_cents,
                    serde_json::to_string(&recurring)?,
                    import_id,
                    now,
                    now,
                    now,
                ],
            )?;
        }
        transaction.execute(
            "UPDATE payroll_document_imports SET draft_json=?,analysis_manifest_json=?,confidence_bp=?,status='confirmed',employee_id=?,payslip_id=?,reviewed_at=?,updated_at=? WHERE id=?",
            params![
                draft_json,
                retained_manifest_json,
                draft_confidence(&draft),
                employee_id,
                payslip_id,
                now,
                now,
                import_id,
            ],
        )?;
        append_audit(
            &transaction,
            "confirm",
            "payroll_document_import",
            import_id,
            &json!({
                "employee_id":employee_id,
                "payslip_id":payslip_id,
                "period":draft.period,
                "line_count":draft.lines.len(),
                "replace_existing_template":replace_existing_template,
                "status":"a_controler"
            }),
        )?;
        transaction.commit()?;
        Ok(json!({
            "import_id":import_id,
            "employee_id":employee_id,
            "payslip_id":payslip_id,
            "status":"confirmed"
        }))
    }
}

fn canonical_source_file(raw_path: &str) -> AppResult<PathBuf> {
    let path = Path::new(raw_path.trim());
    if raw_path.trim().is_empty() || !path.is_file() {
        return Err(AppError::Validation(format!(
            "Le document local est introuvable : {}",
            path.display()
        )));
    }
    Ok(fs::canonicalize(path)?)
}

fn detect_document_type(bytes: &[u8]) -> Option<PayrollDocumentType> {
    if bytes.starts_with(b"%PDF-") {
        return Some(PayrollDocumentType::Pdf);
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some(PayrollDocumentType::Png);
    }
    if bytes.len() >= 4 && bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes[3] != 0x00 {
        return Some(PayrollDocumentType::Jpeg);
    }
    if bytes.len() >= 16
        && &bytes[0..4] == b"RIFF"
        && &bytes[8..12] == b"WEBP"
        && (&bytes[12..16] == b"VP8 " || &bytes[12..16] == b"VP8L" || &bytes[12..16] == b"VP8X")
    {
        return Some(PayrollDocumentType::Webp);
    }
    None
}

fn validate_document_signature(
    source: &Path,
    bytes: &[u8],
    expected: PayrollDocumentType,
) -> AppResult<()> {
    let source_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Le document");
    match detect_document_type(bytes) {
        Some(actual) if actual == expected => Ok(()),
        Some(actual) => Err(AppError::Validation(format!(
            "{source_name} porte une extension {} mais son contenu est {}. Exportez le document dans le bon format avant de l'importer.",
            expected.label(),
            actual.label(),
        ))),
        None => Err(AppError::Validation(format!(
            "La signature binaire de {source_name} ne correspond pas à un fichier {} valide. Le document a été refusé par sécurité.",
            expected.label(),
        ))),
    }
}

fn document_page_count(
    source: &Path,
    bytes: &[u8],
    document_type: PayrollDocumentType,
) -> AppResult<usize> {
    if document_type != PayrollDocumentType::Pdf {
        return Ok(1);
    }
    let document = lopdf::Document::load_mem(bytes).map_err(|_| {
        AppError::Validation(format!(
            "{} n'est pas un PDF structurellement lisible.",
            source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Le document")
        ))
    })?;
    let page_count = document.get_pages().len();
    if page_count == 0 {
        return Err(AppError::Validation(
            "Le PDF ne contient aucune page exploitable.".into(),
        ));
    }
    if page_count > MAX_PDF_PAGES {
        return Err(AppError::Validation(format!(
            "Le PDF contient {page_count} pages. Pour garantir qu'aucune page de salaire n'est ignorée, importez au maximum {MAX_PDF_PAGES} pages par fichier et séparez les fiches de collaborateurs différents."
        )));
    }
    Ok(page_count)
}

/// Lit uniquement les métadonnées du décodeur : une image compressée qui
/// annonce une surface démesurée est refusée avant tout passage au navigateur,
/// où son décodage complet pourrait épuiser la mémoire du poste.
fn validate_image_dimensions(
    source: &Path,
    bytes: &[u8],
    document_type: PayrollDocumentType,
) -> AppResult<()> {
    let format = match document_type {
        PayrollDocumentType::Pdf => return Ok(()),
        PayrollDocumentType::Png => ImageFormat::Png,
        PayrollDocumentType::Jpeg => ImageFormat::Jpeg,
        PayrollDocumentType::Webp => ImageFormat::WebP,
    };
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| {
            AppError::Validation(format!(
                "{} contient un en-tête d’image invalide ou incomplet.",
                source
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Le document")
            ))
        })?;
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if width == 0
        || height == 0
        || width > MAX_IMAGE_EDGE
        || height > MAX_IMAGE_EDGE
        || pixels > MAX_IMAGE_PIXELS
    {
        return Err(AppError::Validation(format!(
            "{} annonce une image de {width} × {height} pixels. La limite locale est de {MAX_IMAGE_EDGE} pixels par côté et {} mégapixels.",
            source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Le document"),
            MAX_IMAGE_PIXELS / 1_000_000,
        )));
    }
    Ok(())
}

fn empty_draft() -> PayrollImportDraft {
    PayrollImportDraft {
        employee: PayrollImportEmployeeDraft {
            employment_rate: 100,
            salary_mode: "monthly".into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn normalize_extracted_text(text: &str) -> String {
    text.replace('\0', "")
        .replace('\u{00a0}', " ")
        .replace('\r', "\n")
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn semantic_text_fingerprint(text: &str) -> Option<String> {
    let normalized = text
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect::<String>();
    // Un en-tête très court (nom d'entreprise, titre générique) n'est pas une
    // preuve suffisante pour déclarer deux bulletins identiques.
    if normalized.chars().count() < 120 {
        return None;
    }
    Some(format!("{:x}", Sha256::digest(normalized.as_bytes())))
}

fn has_semantic_text_duplicate(
    transaction: &rusqlite::Transaction<'_>,
    extracted_text: &str,
) -> AppResult<bool> {
    let Some(candidate_fingerprint) = semantic_text_fingerprint(extracted_text) else {
        return Ok(false);
    };
    let mut statement = transaction.prepare(
        "SELECT extracted_text FROM payroll_document_imports WHERE extracted_text IS NOT NULL",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        let text = row?;
        if semantic_text_fingerprint(&text).as_deref() == Some(candidate_fingerprint.as_str()) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn limit_chars(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    value.chars().take(max_chars).collect()
}

fn draft_from_text(text: &str) -> PayrollImportDraft {
    let mut draft = empty_draft();
    draft.employee.avs_number =
        capture_first(text, r"(?i)\b(756[.\s-]?\d{4}[.\s-]?\d{4}[.\s-]?\d{2})\b")
            .map(|value| normalize_avs(&value))
            .unwrap_or_default();
    draft.employee.iban = capture_first(text, r"(?i)\b(CH\d{2}(?:[\s']?[A-Z0-9]){17})\b")
        .map(|value| value.replace([' ', '\''], "").to_uppercase())
        .unwrap_or_default();
    draft.employee.name = capture_first(
        text,
        r"(?im)^(?:collaborat(?:eur|rice)|employ[ée]e?|mitarbeiter(?:in)?|dipendente|name|nom)\s*[:\-]\s*([^\n]{3,80})$",
    )
    .map(|value| clean_person_name(&value))
    .unwrap_or_default();
    draft.period = find_period(text).unwrap_or_default();
    draft.gross_cents = find_labeled_amount(
        text,
        &[
            "salaire brut",
            "total brut",
            "bruttolohn",
            "brutto",
            "salario lordo",
        ],
    )
    .unwrap_or(0);
    draft.net_cents = find_labeled_amount(
        text,
        &[
            "salaire net",
            "net à payer",
            "netto lohn",
            "nettolohn",
            "salario netto",
        ],
    )
    .unwrap_or(0);
    draft.lines = extract_payroll_lines(text);

    if !draft.lines.iter().any(|line| line.kind == "earning") && draft.gross_cents > 0 {
        draft.lines.insert(
            0,
            PayrollImportLineDraft {
                label: "Salaire brut détecté".into(),
                kind: "earning".into(),
                amount_cents: draft.gross_cents,
                recurring: true,
                confidence_bp: 5_500,
                ..PayrollImportLineDraft::default()
            },
        );
    }
    let totals = draft_totals(&draft.lines);
    if !draft.lines.iter().any(|line| line.kind == "deduction")
        && draft.gross_cents > 0
        && draft.net_cents > 0
        && draft.gross_cents.saturating_add(totals.3) >= draft.net_cents
    {
        let difference = draft
            .gross_cents
            .saturating_add(totals.3)
            .saturating_sub(draft.net_cents);
        if difference > 0 {
            draft.lines.push(PayrollImportLineDraft {
                label: "Retenues détectées — détail à contrôler".into(),
                kind: "deduction".into(),
                amount_cents: difference,
                recurring: false,
                confidence_bp: 3_500,
                ..PayrollImportLineDraft::default()
            });
            draft.warnings.push(
                "Le total des retenues a été déduit du brut et du net, sans inventer leur ventilation. Détaillez-les avant validation."
                    .into(),
            );
        }
    } else if draft.gross_cents > 0 && totals.0 > 0 && (draft.gross_cents - totals.0).abs() > 2 {
        draft.warnings.push(
            "La somme des gains détectés ne correspond pas exactement au salaire brut imprimé."
                .into(),
        );
    }
    if draft.employee.name.is_empty() {
        draft
            .warnings
            .push("Le nom du collaborateur n'a pas été identifié avec certitude.".into());
    }
    if draft.period.is_empty() {
        draft
            .warnings
            .push("La période de salaire doit être confirmée manuellement.".into());
    }
    if draft.gross_cents == 0 {
        draft
            .warnings
            .push("Le salaire brut n'a pas été identifié avec certitude.".into());
    }
    draft
}

fn extract_payroll_lines(text: &str) -> Vec<PayrollImportLineDraft> {
    let amount_at_end = Regex::new(
        r"(?i)^(.{2,120}?)\s+(-?\d{1,3}(?:[ '\u{2019}]\d{3})*(?:[.,]\d{2})|-?\d+(?:[.,]\d{2}))\s*(?:CHF)?$",
    )
    .expect("amount regex");
    let mut lines = Vec::new();
    for raw in text.lines() {
        let Some(captures) = amount_at_end.captures(raw.trim()) else {
            continue;
        };
        let label = captures
            .get(1)
            .map(|value| value.as_str().trim().trim_matches(['-', ':']))
            .unwrap_or_default();
        if label.len() < 2 || is_total_label(label) {
            continue;
        }
        let Some(mut amount_cents) = captures
            .get(2)
            .and_then(|value| parse_amount_to_cents(value.as_str()))
        else {
            continue;
        };
        let lower = label.to_lowercase();
        let kind = if contains_any(
            &lower,
            &[
                "remboursement",
                "frais rembours",
                "expense reimbursement",
                "expenses reimbursed",
                "non-gross payment",
                "non gross payment",
                "spesenvergütung",
                "spesenvergutung",
                "spesenrückerstattung",
                "spesenruckerstattung",
                "rimborso spese",
                "rimborsi spese",
            ],
        ) {
            "reimbursement"
        } else if contains_any(
            &lower,
            &[
                "employeur",
                "part patronale",
                "arbeitgeber",
                "datore di lavoro",
            ],
        ) {
            "employer"
        } else if contains_any(
            &lower,
            &[
                "avs",
                " ai ",
                "apg",
                " ac ",
                "chômage",
                "chomage",
                "arbeitslosen",
                "disoccupazione",
                "lpp",
                "aanp",
                "aap",
                "ijm",
                "impôt",
                "impot",
                "source",
                "retenue",
                "cotisation",
                "abzug",
                "beitrag",
                "quellensteuer",
                "deduzione",
            ],
        ) {
            "deduction"
        } else if contains_any(
            &lower,
            &[
                "salaire",
                "lohn",
                "salario",
                "heure",
                "stunde",
                "indemn",
                "allocation",
                "zulage",
                "bonus",
                "commission",
                "gratification",
                "13e",
                "13ème",
                "13. monats",
                "vacances",
                "ferien",
            ],
        ) {
            "earning"
        } else {
            continue;
        };
        if amount_cents < 0 {
            amount_cents = amount_cents.saturating_abs();
        }
        if amount_cents == 0 {
            continue;
        }
        let recurring = kind == "earning"
            && contains_any(
                &lower,
                &[
                    "salaire mensuel",
                    "salaire de base",
                    "monatslohn",
                    "grundlohn",
                    "salario mensile",
                ],
            );
        // Deux occurrences imprimées identiques peuvent être légitimes
        // (heures, indemnités, rappels). Les conserver toutes; normalize_draft
        // refusera explicitement un document au-delà de 80 lignes.
        lines.push(PayrollImportLineDraft {
            label: label.to_owned(),
            kind: kind.into(),
            amount_cents,
            recurring,
            confidence_bp: 6_500,
            ..PayrollImportLineDraft::default()
        });
    }
    lines
}

fn normalize_draft(draft: &mut PayrollImportDraft, strict: bool) -> AppResult<()> {
    draft.employee.employee_number = clean_text(&draft.employee.employee_number, 80);
    draft.employee.name = clean_text(&draft.employee.name, 200);
    draft.employee.role = clean_text(&draft.employee.role, 200);
    draft.employee.address_line1 = clean_text(&draft.employee.address_line1, 300);
    draft.employee.address_line2 = clean_text(&draft.employee.address_line2, 300);
    draft.employee.postal_code = clean_text(&draft.employee.postal_code, 20);
    draft.employee.city = clean_text(&draft.employee.city, 120);
    draft.employee.canton = clean_text(&draft.employee.canton, 40).to_uppercase();
    draft.employee.birth_date = clean_text(&draft.employee.birth_date, 10);
    draft.employee.avs_number = normalize_avs(&draft.employee.avs_number);
    draft.employee.iban = draft
        .employee
        .iban
        .chars()
        .filter(|value| !value.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    draft.employee.employment_rate = draft.employee.employment_rate.clamp(1, 100);
    draft.employee.salary_mode = match draft.employee.salary_mode.trim() {
        "hourly" => "hourly".into(),
        _ => "monthly".into(),
    };
    draft.period = normalize_period(&draft.period).unwrap_or_else(|| clean_text(&draft.period, 10));
    draft.payment_date = clean_text(&draft.payment_date, 10);
    draft.gross_cents = draft.gross_cents.max(0);
    draft.net_cents = draft.net_cents.max(0);
    if draft.lines.len() > 80 {
        return Err(AppError::Validation(
            "Une fiche ne peut pas contenir plus de 80 lignes importées.".into(),
        ));
    }
    draft
        .lines
        .retain(|line| !line.label.trim().is_empty() || line.amount_cents != 0);
    let mut line_ids = HashSet::new();
    let mut source_refs = HashSet::new();
    for line in &mut draft.lines {
        line.id = clean_text(&line.id, 100);
        if line.id.is_empty()
            || !line
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || !line_ids.insert(line.id.clone())
        {
            line.id = Uuid::new_v4().to_string();
            line_ids.insert(line.id.clone());
        }
        line.source_ref = clean_text(&line.source_ref, 160);
        if !line
            .source_ref
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-'))
            || (!line.source_ref.is_empty() && !source_refs.insert(line.source_ref.clone()))
        {
            line.source_ref.clear();
        }
        line.label = clean_text(&line.label, 200);
        line.kind = match line.kind.trim() {
            "earning" | "gain" => "earning".into(),
            "deduction" | "retenue" => "deduction".into(),
            "reimbursement" | "expense_reimbursement" | "non_gross_payment" => {
                "reimbursement".into()
            }
            "employer" | "employer_cost" => "employer".into(),
            _ if strict => {
                return Err(AppError::Validation(format!(
                    "Le type de ligne « {} » n'est pas accepté.",
                    line.kind
                )))
            }
            _ => "earning".into(),
        };
        line.amount_cents = line.amount_cents.max(0);
        if line.kind != "earning" {
            line.recurring = false;
        }
        line.confidence_bp = line.confidence_bp.clamp(0, 10_000);
    }
    draft.warnings = draft
        .warnings
        .iter()
        .map(|warning| clean_text(warning, 500))
        .filter(|warning| !warning.is_empty())
        .take(30)
        .collect();
    if let Some(review) = &mut draft.review {
        review.employee_id = clean_text(&review.employee_id, 100);
        review.employee_link_source = match review.employee_link_source.trim() {
            "auto" => "auto".into(),
            "manual" => "manual".into(),
            _ => String::new(),
        };
        if let Some(evidence) = &mut review.ai_identity_evidence {
            evidence.passes = evidence.passes.clamp(0, 2);
            evidence.employee_number = clean_text(&evidence.employee_number, 80);
            evidence.avs_number = normalize_avs(&evidence.avs_number);
            evidence.birth_date = clean_text(&evidence.birth_date, 10);
            evidence.iban = evidence
                .iban
                .chars()
                .filter(|value| !value.is_whitespace())
                .collect::<String>()
                .to_uppercase();
            evidence.conflicts = evidence
                .conflicts
                .iter()
                .map(|conflict| clean_text(conflict, 100))
                .filter(|conflict| !conflict.is_empty())
                .take(10)
                .collect();
        }
        const REVIEW_FIELDS: &[&str] = &[
            "employee.employeeNumber",
            "employee.name",
            "employee.role",
            "employee.addressLine1",
            "employee.addressLine2",
            "employee.postalCode",
            "employee.city",
            "employee.canton",
            "employee.birthDate",
            "employee.avsNumber",
            "employee.iban",
            "employee.employmentRate",
            "employee.salaryMode",
            "period",
            "paymentDate",
            "grossCents",
            "netCents",
        ];
        let normalize_field_list = |values: &mut Vec<String>| {
            values.retain(|value| REVIEW_FIELDS.contains(&value.trim()));
            values
                .iter_mut()
                .for_each(|value| *value = value.trim().to_owned());
            values.sort();
            values.dedup();
        };
        normalize_field_list(&mut review.ai_fields);
        normalize_field_list(&mut review.manual_fields);

        let normalize_line_keys = |values: &mut Vec<String>| {
            values.retain(|value| {
                let value = value.trim();
                !value.is_empty()
                    && value.len() <= 240
                    && value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-')
                    })
            });
            values
                .iter_mut()
                .for_each(|value| *value = value.trim().to_owned());
            values.sort();
            values.dedup();
            values.truncate(80);
        };
        normalize_line_keys(&mut review.ai_line_keys);
        normalize_line_keys(&mut review.manual_line_keys);
        normalize_line_keys(&mut review.suppressed_line_keys);
        review.ai_warnings = review
            .ai_warnings
            .iter()
            .map(|warning| clean_text(warning, 500))
            .filter(|warning| !warning.is_empty())
            .take(30)
            .collect();
        review.confirmed_recurring_lines = review
            .confirmed_recurring_lines
            .iter()
            .filter_map(|line| {
                let line_id = clean_text(&line.line_id, 100);
                if !line_id.is_empty() && !line_ids.contains(&line_id) {
                    return None;
                }
                let label = clean_text(&line.label, 200);
                (line.kind.trim() == "earning" && !label.is_empty() && line.amount_cents > 0)
                    .then_some(crate::models::PayrollConfirmedRecurringLine {
                        line_id,
                        label,
                        kind: "earning".into(),
                        amount_cents: line.amount_cents,
                    })
            })
            .take(80)
            .collect();
        review.confirmed_recurring_lines.sort_by(|left, right| {
            (&left.line_id, &left.label, left.amount_cents).cmp(&(
                &right.line_id,
                &right.label,
                right.amount_cents,
            ))
        });
        review.confirmed_recurring_lines.dedup_by(|left, right| {
            left.line_id == right.line_id
                && left.label == right.label
                && left.amount_cents == right.amount_cents
        });
    }
    Ok(())
}

fn validate_confirmable_draft(draft: &PayrollImportDraft) -> AppResult<()> {
    if draft.employee.name.is_empty() {
        return Err(AppError::Validation(
            "Confirmez le nom du collaborateur avant l'import.".into(),
        ));
    }
    if normalize_period(&draft.period).is_none() {
        return Err(AppError::Validation(
            "La période doit être au format AAAA-MM.".into(),
        ));
    }
    if !draft.payment_date.is_empty()
        && NaiveDate::parse_from_str(&draft.payment_date, "%Y-%m-%d").is_err()
    {
        return Err(AppError::Validation(
            "La date de paiement détectée n'est pas une date civile valide.".into(),
        ));
    }
    if !draft.employee.birth_date.is_empty()
        && NaiveDate::parse_from_str(&draft.employee.birth_date, "%Y-%m-%d").is_err()
    {
        return Err(AppError::Validation(
            "La date de naissance détectée n'est pas une date civile valide.".into(),
        ));
    }
    if !draft.employee.avs_number.is_empty() && !is_valid_avs(&draft.employee.avs_number) {
        return Err(AppError::Validation(
            "Le numéro AVS ne passe pas le contrôle EAN-13 suisse. Corrigez-le ou laissez le champ vide.".into(),
        ));
    }
    if !draft.employee.iban.is_empty() && !is_valid_iban(&draft.employee.iban) {
        return Err(AppError::Validation(
            "L'IBAN de l'employé ne passe pas le contrôle international MOD-97. Corrigez-le ou laissez le champ vide.".into(),
        ));
    }
    if draft.lines.is_empty()
        || !draft
            .lines
            .iter()
            .any(|line| line.kind == "earning" && line.amount_cents > 0)
    {
        return Err(AppError::Validation(
            "Ajoutez au moins un gain positif confirmé.".into(),
        ));
    }
    if draft.lines.iter().any(|line| line.label.is_empty()) {
        return Err(AppError::Validation(
            "Chaque ligne de salaire doit avoir un libellé.".into(),
        ));
    }
    if draft.lines.iter().any(|line| line.amount_cents <= 0) {
        return Err(AppError::Validation(
            "Chaque rubrique confirmée doit avoir un montant strictement positif.".into(),
        ));
    }
    let totals = draft_totals(&draft.lines);
    if draft.gross_cents <= 0 {
        return Err(AppError::Validation(
            "Saisissez le total brut exactement comme il est imprimé sur la fiche.".into(),
        ));
    }
    if draft.net_cents <= 0 {
        return Err(AppError::Validation(
            "Saisissez le net à payer exactement comme il est imprimé sur la fiche.".into(),
        ));
    }
    if (draft.gross_cents - totals.0).abs() > 2 {
        return Err(AppError::Validation(format!(
            "Le brut confirmé ({:.2} CHF) ne correspond pas à la somme des gains ({:.2} CHF). Corrigez les lignes avant l'import.",
            draft.gross_cents as f64 / 100.0,
            totals.0 as f64 / 100.0
        )));
    }
    let calculated_net = totals.0.saturating_add(totals.3).saturating_sub(totals.1);
    if (draft.net_cents - calculated_net).abs() > 2 {
        return Err(AppError::Validation(format!(
            "Le net confirmé ({:.2} CHF) ne correspond pas au brut moins les retenues plus les remboursements hors brut ({:.2} CHF). Corrigez les lignes avant l'import.",
            draft.net_cents as f64 / 100.0,
            calculated_net as f64 / 100.0
        )));
    }
    Ok(())
}

fn insert_employee_from_draft(
    transaction: &rusqlite::Transaction<'_>,
    employee: &PayrollImportEmployeeDraft,
    recurring_base_salary_cents: i64,
) -> AppResult<String> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let monthly_salary = if employee.salary_mode == "monthly" {
        recurring_base_salary_cents.max(0)
    } else {
        0
    };
    transaction.execute(
        "INSERT INTO employees(id,employee_number,name,role,address_line1,address_line2,postal_code,city,canton,birth_date,social_security_number,iban,employment_rate,hourly_rate_cents,monthly_salary_cents,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,'actif','Créé depuis une fiche de salaire importée et confirmée.',?,?)",
        params![
            id,
            optional_text(&employee.employee_number),
            employee.name,
            optional_text(&employee.role),
            optional_text(&employee.address_line1),
            optional_text(&employee.address_line2),
            optional_text(&employee.postal_code),
            optional_text(&employee.city),
            optional_text(&employee.canton),
            optional_text(&employee.birth_date),
            optional_text(&employee.avs_number),
            optional_text(&employee.iban),
            employee.employment_rate,
            monthly_salary,
            now,
            now,
        ],
    )?;
    Ok(id)
}

fn ensure_new_employee_identity_available(
    transaction: &rusqlite::Transaction<'_>,
    employee: &PayrollImportEmployeeDraft,
) -> AppResult<()> {
    let imported_avs = employee
        .avs_number
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>();
    let imported_number = employee
        .employee_number
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if imported_avs.is_empty() && imported_number.is_empty() {
        return Ok(());
    }
    let mut statement = transaction
        .prepare("SELECT id,name,employee_number,social_security_number FROM employees")?;
    let existing = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, name, employee_number, avs_number) in existing {
        let same_avs = !imported_avs.is_empty()
            && avs_number
                .chars()
                .filter(char::is_ascii_digit)
                .eq(imported_avs.chars());
        let same_number = !imported_number.is_empty()
            && employee_number
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .flat_map(char::to_lowercase)
                .eq(imported_number.chars());
        if same_avs || same_number {
            return Err(AppError::Validation(format!(
                "Un collaborateur existant ({name}, identifiant {id}) possède déjà {}. Rattachez explicitement la fiche à ce profil au lieu d'en créer un nouveau.",
                if same_avs { "ce numéro AVS" } else { "ce numéro employé" }
            )));
        }
    }
    Ok(())
}

fn validate_linked_employee_identity(
    stored_avs_number: Option<&str>,
    stored_employee_number: Option<&str>,
    stored_birth_date: Option<&str>,
    stored_iban: Option<&str>,
    imported: &PayrollImportEmployeeDraft,
) -> AppResult<()> {
    let normalized_avs = |value: &str| {
        value
            .chars()
            .filter(char::is_ascii_digit)
            .collect::<String>()
    };
    let normalized_employee_number = |value: &str| {
        value
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let stored_avs = stored_avs_number.map(normalized_avs).unwrap_or_default();
    let imported_avs = normalized_avs(&imported.avs_number);
    if !stored_avs.is_empty() && !imported_avs.is_empty() && stored_avs != imported_avs {
        return Err(AppError::Validation(
            "Le numéro AVS du document ne correspond pas au collaborateur sélectionné. Corrigez le rattachement avant de confirmer.".into(),
        ));
    }
    let stored_number = stored_employee_number
        .map(normalized_employee_number)
        .unwrap_or_default();
    let imported_number = normalized_employee_number(&imported.employee_number);
    if !stored_number.is_empty() && !imported_number.is_empty() && stored_number != imported_number
    {
        return Err(AppError::Validation(
            "Le numéro employé du document ne correspond pas au collaborateur sélectionné. Corrigez le rattachement avant de confirmer.".into(),
        ));
    }
    let stored_birth = stored_birth_date.unwrap_or_default().trim();
    let imported_birth = imported.birth_date.trim();
    if !stored_birth.is_empty() && !imported_birth.is_empty() && stored_birth != imported_birth {
        return Err(AppError::Validation(
            "La date de naissance du document ne correspond pas au collaborateur sélectionné. Corrigez le rattachement avant de confirmer.".into(),
        ));
    }
    let normalized_iban = |value: &str| {
        value
            .chars()
            .filter(|character| !character.is_whitespace())
            .flat_map(char::to_uppercase)
            .collect::<String>()
    };
    let stored_iban = stored_iban.map(normalized_iban).unwrap_or_default();
    let imported_iban = normalized_iban(&imported.iban);
    if !stored_iban.is_empty() && !imported_iban.is_empty() && stored_iban != imported_iban {
        return Err(AppError::Validation(
            "L'IBAN du document ne correspond pas au collaborateur sélectionné. Corrigez le rattachement avant de confirmer.".into(),
        ));
    }
    Ok(())
}

fn optional_text(value: &str) -> Option<&str> {
    let clean = value.trim();
    (!clean.is_empty()).then_some(clean)
}

fn employee_template_upsert_sql(replace_existing: bool) -> &'static str {
    if replace_existing {
        "INSERT INTO employee_payroll_templates(employee_id,salary_mode,base_salary_cents,recurring_earnings_json,suggested_contribution_codes_json,source_import_id,reviewed_at,created_at,updated_at) VALUES(?,?,?,?, '[]',?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET salary_mode=excluded.salary_mode,base_salary_cents=excluded.base_salary_cents,recurring_earnings_json=excluded.recurring_earnings_json,source_import_id=excluded.source_import_id,reviewed_at=excluded.reviewed_at,updated_at=excluded.updated_at"
    } else {
        "INSERT INTO employee_payroll_templates(employee_id,salary_mode,base_salary_cents,recurring_earnings_json,suggested_contribution_codes_json,source_import_id,reviewed_at,created_at,updated_at) VALUES(?,?,?,?, '[]',?,?,?,?) ON CONFLICT(employee_id) DO NOTHING"
    }
}

fn reviewed_recurring_earnings(draft: &PayrollImportDraft) -> (Vec<Value>, i64) {
    let confirmed = draft
        .review
        .as_ref()
        .map(|review| review.confirmed_recurring_lines.as_slice())
        .unwrap_or_default();
    let recurring: Vec<Value> = draft
        .lines
        .iter()
        .filter(|line| {
            line.kind == "earning"
                && line.recurring
                && line.amount_cents > 0
                && confirmed.iter().any(|item| {
                    let same_value = item.kind == "earning"
                        && item.label == line.label
                        && item.amount_cents == line.amount_cents;
                    if !same_value {
                        return false;
                    }
                    if !item.line_id.is_empty() {
                        return item.line_id == line.id;
                    }
                    // Les anciens états ne contenaient pas d'identifiant de
                    // ligne. Ils restent compatibles seulement si la valeur
                    // désigne une occurrence unique; un doublon est refusé.
                    draft
                        .lines
                        .iter()
                        .filter(|candidate| {
                            candidate.kind == "earning"
                                && candidate.label == line.label
                                && candidate.amount_cents == line.amount_cents
                        })
                        .count()
                        == 1
                })
        })
        .map(|line| {
            json!({
                "label":line.label,
                "kind":"earning",
                "amount_cents":line.amount_cents
            })
        })
        .collect();
    let base_salary_cents = recurring
        .iter()
        .filter_map(|line| line["amount_cents"].as_i64())
        .fold(0_i64, i64::saturating_add);
    (recurring, base_salary_cents)
}

fn draft_totals(lines: &[PayrollImportLineDraft]) -> (i64, i64, i64, i64) {
    lines
        .iter()
        .fold((0_i64, 0_i64, 0_i64, 0_i64), |mut totals, line| {
            match line.kind.as_str() {
                "earning" => totals.0 = totals.0.saturating_add(line.amount_cents),
                "deduction" => totals.1 = totals.1.saturating_add(line.amount_cents),
                "employer" => totals.2 = totals.2.saturating_add(line.amount_cents),
                "reimbursement" => totals.3 = totals.3.saturating_add(line.amount_cents),
                _ => {}
            }
            totals
        })
}

fn draft_confidence(draft: &PayrollImportDraft) -> i64 {
    let mut score = 500_i64;
    if !draft.employee.name.is_empty() {
        score += 1_500;
    }
    if !draft.period.is_empty() {
        score += 1_500;
    }
    if !draft.employee.avs_number.is_empty() {
        score += 700;
    }
    if draft.gross_cents > 0 {
        score += 2_000;
    }
    if draft.net_cents > 0 {
        score += 1_300;
    }
    if !draft.lines.is_empty() {
        score += 1_500;
    }
    score
        .saturating_sub((draft.warnings.len() as i64).saturating_mul(250))
        .clamp(0, 9_500)
}

fn capture_first(text: &str, pattern: &str) -> Option<String> {
    Regex::new(pattern)
        .ok()?
        .captures(text)?
        .get(1)
        .map(|value| value.as_str().trim().to_owned())
}

fn normalize_avs(value: &str) -> String {
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    if digits.len() == 13 && digits.starts_with("756") {
        format!(
            "{}.{}.{}.{}",
            &digits[0..3],
            &digits[3..7],
            &digits[7..11],
            &digits[11..13]
        )
    } else {
        clean_text(value, 32)
    }
}

fn is_valid_avs(value: &str) -> bool {
    let digits: Vec<u32> = value
        .chars()
        .filter_map(|character| character.to_digit(10))
        .collect();
    if digits.len() != 13 || digits[..3] != [7, 5, 6] {
        return false;
    }
    let sum: u32 = digits[..12]
        .iter()
        .enumerate()
        .map(|(index, digit)| digit * if index % 2 == 0 { 1 } else { 3 })
        .sum();
    (10 - (sum % 10)) % 10 == digits[12]
}

fn is_valid_iban(value: &str) -> bool {
    let compact: String = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .map(|character| character.to_ascii_uppercase())
        .collect();
    if !(15..=34).contains(&compact.len()) || !compact.is_ascii() {
        return false;
    }
    let bytes = compact.as_bytes();
    if !bytes[..2].iter().all(u8::is_ascii_alphabetic)
        || !bytes[2..4].iter().all(u8::is_ascii_digit)
        || !bytes[4..].iter().all(u8::is_ascii_alphanumeric)
    {
        return false;
    }
    let rearranged = format!("{}{}", &compact[4..], &compact[..4]);
    let mut remainder = 0_u32;
    for character in rearranged.chars() {
        let encoded = if character.is_ascii_digit() {
            character.to_string()
        } else {
            (character as u32 - 'A' as u32 + 10).to_string()
        };
        for digit in encoded.bytes() {
            remainder = (remainder * 10 + u32::from(digit - b'0')) % 97;
        }
    }
    remainder == 1
}

fn clean_person_name(value: &str) -> String {
    clean_text(value.split(['|', ';']).next().unwrap_or(value).trim(), 200)
}

fn clean_text(value: &str, max_chars: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

fn find_period(text: &str) -> Option<String> {
    let numeric = Regex::new(r"\b(20\d{2})[-./](0?[1-9]|1[0-2])\b").ok()?;
    if let Some(captures) = numeric.captures(text) {
        let year = captures.get(1)?.as_str();
        let month: u32 = captures.get(2)?.as_str().parse().ok()?;
        return Some(format!("{year}-{month:02}"));
    }
    let month_names = [
        (1, &["janvier", "januar", "gennaio", "january"][..]),
        (
            2,
            &["février", "fevrier", "februar", "febbraio", "february"],
        ),
        (3, &["mars", "märz", "maerz", "marzo", "march"]),
        (4, &["avril", "april", "aprile"]),
        (5, &["mai", "maggio", "may"]),
        (6, &["juin", "juni", "giugno", "june"]),
        (7, &["juillet", "juli", "luglio", "july"]),
        (8, &["août", "aout", "august", "agosto"]),
        (9, &["septembre", "september", "settembre"]),
        (10, &["octobre", "oktober", "ottobre", "october"]),
        (11, &["novembre", "november"]),
        (
            12,
            &["décembre", "decembre", "dezember", "dicembre", "december"],
        ),
    ];
    let lower = text.to_lowercase();
    for (month, names) in month_names {
        for name in names {
            let pattern = format!(r"\b{}\s+(20\d{{2}})\b", regex::escape(name));
            if let Some(captures) = Regex::new(&pattern).ok()?.captures(&lower) {
                return Some(format!("{}-{month:02}", captures.get(1)?.as_str()));
            }
        }
    }
    None
}

fn normalize_period(value: &str) -> Option<String> {
    let captures = Regex::new(r"^(20\d{2})-(0[1-9]|1[0-2])$")
        .ok()?
        .captures(value.trim())?;
    Some(format!(
        "{}-{}",
        captures.get(1)?.as_str(),
        captures.get(2)?.as_str()
    ))
}

fn find_labeled_amount(text: &str, labels: &[&str]) -> Option<i64> {
    let amount_pattern =
        Regex::new(r"(-?\d{1,3}(?:[ '\u{2019}]\d{3})*(?:[.,]\d{2})|-?\d+(?:[.,]\d{2}))").ok()?;
    for line in text.lines() {
        let lower = line.to_lowercase();
        if labels.iter().any(|label| lower.contains(label)) {
            let captures = amount_pattern.captures_iter(line).last();
            if let Some(amount) = captures
                .and_then(|capture| capture.get(1))
                .and_then(|value| parse_amount_to_cents(value.as_str()))
            {
                return Some(amount.saturating_abs());
            }
        }
    }
    None
}

fn parse_amount_to_cents(value: &str) -> Option<i64> {
    let mut normalized = value
        .trim()
        .replace([' ', '\'', '\u{2019}'], "")
        .replace(',', ".");
    let negative = normalized.starts_with('-');
    if negative {
        normalized.remove(0);
    }
    let amount = if let Some((whole, decimal)) = normalized.rsplit_once('.') {
        if decimal.len() == 2 {
            whole.parse::<i64>().ok()?.saturating_mul(100) + decimal.parse::<i64>().ok()?
        } else {
            normalized
                .parse::<f64>()
                .ok()
                .map(|value| (value * 100.0).round() as i64)?
        }
    } else {
        normalized.parse::<i64>().ok()?.saturating_mul(100)
    };
    Some(if negative { -amount } else { amount })
}

fn is_total_label(label: &str) -> bool {
    let lower = label.to_lowercase();
    contains_any(
        &lower,
        &[
            "salaire brut",
            "total brut",
            "bruttolohn",
            "salaire net",
            "net à payer",
            "netto",
            "salario lordo",
            "salario netto",
            "total reten",
            "total cotis",
            "retenues employé",
            "retenues employe",
            "charges employeur",
        ],
    )
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        PayrollAnalysisConflict, PayrollAnalysisFieldProvenance, PayrollAnalysisLineProvenance,
        PayrollConfirmedRecurringLine, PayrollImportReviewState,
    };
    use lopdf::dictionary;

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = u32::MAX;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn png_with_declared_dimensions(width: u32, height: u32) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1)
            .write_to(&mut cursor, ImageFormat::Png)
            .expect("encode tiny PNG");
        let mut bytes = cursor.into_inner();
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        let checksum = crc32(&bytes[12..29]);
        bytes[29..33].copy_from_slice(&checksum.to_be_bytes());
        bytes
    }

    fn pdf_with_page_count(page_count: usize) -> Vec<u8> {
        let mut document = lopdf::Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let kids = (0..page_count)
            .map(|_| {
                let page_id = document.add_object(lopdf::dictionary! {
                    "Type" => "Page",
                    "Parent" => pages_id,
                });
                lopdf::Object::Reference(page_id)
            })
            .collect::<Vec<_>>();
        document.objects.insert(
            pages_id,
            lopdf::Object::Dictionary(lopdf::dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => page_count as i64,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            }),
        );
        let catalog_id = document.add_object(lopdf::dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).expect("serialize test PDF");
        bytes
    }

    fn pdf_with_text(text: &str, marker: &str) -> Vec<u8> {
        use lopdf::{
            content::{Content, Operation},
            Object, Stream,
        };

        let mut document = lopdf::Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(lopdf::dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources_id = document.add_object(lopdf::dictionary! {
            "Font" => lopdf::dictionary! { "F1" => font_id },
        });
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), 12.into()]),
                Operation::new("Td", vec![40.into(), 760.into()]),
                Operation::new("Tj", vec![Object::string_literal(text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let content_id = document.add_object(Stream::new(
            lopdf::dictionary! {},
            content.encode().expect("encode PDF text content"),
        ));
        let page_id = document.add_object(lopdf::dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            "Resources" => resources_id,
            "Contents" => content_id,
        });
        document.objects.insert(
            pages_id,
            lopdf::Object::Dictionary(lopdf::dictionary! {
                "Type" => "Pages",
                "Kids" => vec![lopdf::Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let catalog_id = document.add_object(lopdf::dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        let info_id = document.add_object(lopdf::dictionary! {
            "Producer" => Object::string_literal(marker),
        });
        document.trailer.set("Root", catalog_id);
        document.trailer.set("Info", info_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).expect("serialize text PDF");
        bytes
    }

    fn manifest_draft() -> PayrollImportDraft {
        let mut draft = empty_draft();
        draft.employee.name = "Alex Exemple".into();
        draft.period = "2026-08".into();
        draft.gross_cents = 500_000;
        draft.net_cents = 500_000;
        draft.lines.push(PayrollImportLineDraft {
            label: "Salaire mensuel".into(),
            kind: "earning".into(),
            amount_cents: 500_000,
            recurring: true,
            confidence_bp: 9_000,
            ..PayrollImportLineDraft::default()
        });
        draft
    }

    fn analysis_manifest(input_sha256: &str) -> PayrollAnalysisManifest {
        PayrollAnalysisManifest {
            schema_version: ANALYSIS_MANIFEST_SCHEMA_VERSION,
            model_id: "HuggingFaceTB/SmolVLM-500M-Instruct".into(),
            model_revision: "revision-locale-figee".into(),
            input_sha256: input_sha256.into(),
            analyzed_pages: vec![2, 1, 2],
            passes: 2,
            field_provenance: vec![
                PayrollAnalysisFieldProvenance {
                    field: "employee.name".into(),
                    value: "Alex Exemple".into(),
                    pages: vec![1],
                    pass_indexes: vec![2, 1, 2],
                    confidence_bp: 9_250,
                },
                PayrollAnalysisFieldProvenance {
                    field: "period".into(),
                    value: "2026-08".into(),
                    pages: vec![2],
                    pass_indexes: vec![1, 2],
                    confidence_bp: 9_000,
                },
            ],
            line_provenance: vec![PayrollAnalysisLineProvenance {
                line_index: 0,
                label: "Salaire mensuel".into(),
                kind: "earning".into(),
                amount_cents: 500_000,
                pages: vec![2],
                pass_indexes: vec![2, 1],
                confidence_bp: 9_000,
            }],
            conflicts: vec![PayrollAnalysisConflict {
                target: "employee.avs_number".into(),
                values: vec!["valeur B".into(), "valeur A".into()],
                pages: vec![1, 2],
                pass_indexes: vec![1, 2],
            }],
            analyzed_at: "2026-09-01T10:15:30Z".into(),
        }
    }

    #[test]
    fn normalizes_manifest_evidence_and_rejects_document_or_line_tampering() {
        let hash = "a".repeat(64);
        let draft = manifest_draft();
        let normalized =
            normalize_analysis_manifest(analysis_manifest(&hash), &hash, "pdf", Some(2), &draft)
                .expect("valid local analysis manifest");
        assert_eq!(normalized.analyzed_pages, vec![1, 2]);
        assert_eq!(normalized.field_provenance[0].pass_indexes, vec![1, 2]);
        assert_eq!(normalized.conflicts[0].values, vec!["valeur A", "valeur B"]);

        let mut wrong_hash = analysis_manifest(&"b".repeat(64));
        assert!(
            normalize_analysis_manifest(wrong_hash.clone(), &hash, "pdf", Some(2), &draft,)
                .expect_err("the evidence must be bound to the stored bytes")
                .to_string()
                .contains("hash d'entrée")
        );

        wrong_hash.input_sha256 = hash.clone();
        wrong_hash.line_provenance[0].amount_cents = 499_999;
        assert!(
            normalize_analysis_manifest(wrong_hash, &hash, "pdf", Some(2), &draft,)
                .expect_err("line evidence must match the saved draft")
                .to_string()
                .contains("ne correspond pas au brouillon")
        );

        let mut missing_page = analysis_manifest(&hash);
        missing_page.analyzed_pages = vec![3];
        assert!(
            normalize_analysis_manifest(missing_page, &hash, "pdf", Some(2), &draft,)
                .expect_err("pages beyond the local document must be refused")
                .to_string()
                .contains("pages analysées")
        );
        let mut partial_coverage = analysis_manifest(&hash);
        partial_coverage.analyzed_pages = vec![1];
        assert!(
            normalize_analysis_manifest(partial_coverage, &hash, "pdf", Some(2), &draft,)
                .expect_err("every stored page must be covered")
                .to_string()
                .contains("toutes les pages")
        );
        let mut unknown_field = analysis_manifest(&hash);
        unknown_field.field_provenance[0].field = "employee.untrusted_field".into();
        assert!(
            normalize_analysis_manifest(unknown_field, &hash, "pdf", Some(2), &draft,)
                .expect_err("unknown scalar targets must not acquire page provenance")
                .to_string()
                .contains("aucun champ de paie")
        );
        let mut wrong_field_value = analysis_manifest(&hash);
        wrong_field_value.field_provenance[0].value = "Une autre personne".into();
        assert!(
            normalize_analysis_manifest(wrong_field_value, &hash, "pdf", Some(2), &draft,)
                .expect_err("scalar evidence must be bound to the saved value")
                .to_string()
                .contains("valeur du brouillon")
        );
        let mut unknown_conflict = analysis_manifest(&hash);
        unknown_conflict.conflicts[0].target = "employee.untrusted_field".into();
        assert!(
            normalize_analysis_manifest(unknown_conflict, &hash, "pdf", Some(2), &draft,)
                .expect_err("unknown conflict targets must fail closed")
                .to_string()
                .contains("aucun champ de paie")
        );
        let mut overlapping_conflict = analysis_manifest(&hash);
        overlapping_conflict.conflicts[0].target = "employee.name".into();
        assert!(
            normalize_analysis_manifest(overlapping_conflict, &hash, "pdf", Some(2), &draft,)
                .expect_err("resolved provenance and conflicts must be mutually exclusive")
                .to_string()
                .contains("simultanément")
        );
    }

    #[test]
    fn reconciles_a_partial_human_field_correction_without_erasing_unchanged_evidence() {
        let hash = "a".repeat(64);
        let previous = manifest_draft();
        let mut corrected = previous.clone();
        corrected.employee.name = "Alex Corrigé".into();
        corrected.review = Some(PayrollImportReviewState {
            manual_fields: vec!["employee.name".into()],
            ..PayrollImportReviewState::default()
        });

        let reconciled =
            reconcile_analysis_manifest(analysis_manifest(&hash), &previous, &corrected);

        assert_eq!(
            reconciled
                .field_provenance
                .iter()
                .map(|evidence| evidence.field.as_str())
                .collect::<Vec<_>>(),
            vec!["period"],
        );
        assert_eq!(reconciled.line_provenance.len(), 1);
        assert_eq!(reconciled.line_provenance[0].label, "Salaire mensuel");
        assert_eq!(reconciled.conflicts.len(), 1);
        assert_eq!(
            corrected.review.unwrap().manual_fields,
            vec!["employee.name"]
        );
    }

    #[test]
    fn reconciles_line_deletion_and_addition_without_transferring_evidence() {
        let hash = "b".repeat(64);
        let mut previous = manifest_draft();
        previous.lines[0].id = "ai-salary".into();
        previous.lines[0].source_ref = "ai:p1-1:kearning:hsalary:a500000:o1".into();
        previous.lines.push(PayrollImportLineDraft {
            id: "ai-deduction".into(),
            source_ref: "ai:p2-2:kdeduction:havs:a50000:o1".into(),
            label: "Cotisation AVS".into(),
            kind: "deduction".into(),
            amount_cents: 50_000,
            recurring: false,
            confidence_bp: 9_000,
        });
        let mut manifest = analysis_manifest(&hash);
        manifest
            .line_provenance
            .push(PayrollAnalysisLineProvenance {
                line_index: 1,
                label: "Cotisation AVS".into(),
                kind: "deduction".into(),
                amount_cents: 50_000,
                pages: vec![2],
                pass_indexes: vec![1, 2],
                confidence_bp: 9_000,
            });
        let next = PayrollImportDraft {
            lines: vec![
                previous.lines[1].clone(),
                PayrollImportLineDraft {
                    id: "human-replacement".into(),
                    label: "Salaire mensuel".into(),
                    kind: "earning".into(),
                    amount_cents: 500_000,
                    recurring: false,
                    confidence_bp: 10_000,
                    ..PayrollImportLineDraft::default()
                },
            ],
            ..previous.clone()
        };

        let reconciled = reconcile_analysis_manifest(manifest, &previous, &next);

        assert_eq!(reconciled.line_provenance.len(), 1);
        assert_eq!(reconciled.line_provenance[0].line_index, 0);
        assert_eq!(reconciled.line_provenance[0].label, "Cotisation AVS");
    }

    #[test]
    fn reconciles_a_unique_legacy_line_without_id_or_source_reference() {
        let hash = "c".repeat(64);
        let previous = manifest_draft();
        assert!(previous.lines[0].id.is_empty());
        assert!(previous.lines[0].source_ref.is_empty());
        let next = PayrollImportDraft {
            lines: vec![
                PayrollImportLineDraft {
                    label: "Ajout humain".into(),
                    kind: "earning".into(),
                    amount_cents: 1_000,
                    confidence_bp: 10_000,
                    ..PayrollImportLineDraft::default()
                },
                previous.lines[0].clone(),
            ],
            ..previous.clone()
        };

        let reconciled = reconcile_analysis_manifest(analysis_manifest(&hash), &previous, &next);

        assert_eq!(reconciled.line_provenance.len(), 1);
        assert_eq!(reconciled.line_provenance[0].line_index, 1);
        assert_eq!(reconciled.line_provenance[0].pages, vec![2]);
    }

    #[test]
    fn legacy_draft_update_deserializes_without_an_analysis_manifest() {
        let input: UpdatePayrollImportDraftInput = serde_json::from_value(json!({
            "id": "import-legacy",
            "draft": {},
            "extraction_engine": "manuel",
            "engine_version": null,
            "confidence_bp": 5000
        }))
        .expect("old frontend payload remains valid");
        assert!(input.analysis_manifest.is_none());
        assert!(!input.clear_analysis_manifest);
    }

    #[test]
    fn update_persists_a_manifest_and_a_legacy_update_does_not_erase_it() {
        let temporary = tempfile::tempdir().expect("temporary Zentra profile");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local store");
        let document_bytes = b"local payslip evidence";
        let hash = format!("{:x}", Sha256::digest(document_bytes));
        let draft = manifest_draft();
        let stored_path = store
            .attachments_dir
            .join("payroll-imports")
            .join("import-proof.pdf");
        fs::create_dir_all(stored_path.parent().expect("payroll import parent"))
            .expect("create payroll import parent");
        fs::write(&stored_path, document_bytes).expect("managed document copy");
        {
            let connection = store.connect().expect("open test database");
            connection
                .execute(
                    "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise locale','2026-09-01T10:00:00Z','2026-09-01T10:00:00Z')",
                    [],
                )
                .expect("completed onboarding marker");
            connection
                .execute(
                    "INSERT INTO payroll_document_imports(id,source_name,stored_path,file_sha256,media_kind,file_size,page_count,extraction_engine,engine_version,draft_json,confidence_bp,status,created_at,updated_at) VALUES('import-proof','fiche.pdf',?1,?2,'pdf',?3,2,'pdf_text','legacy',?4,6500,'needs_review','2026-09-01T10:00:00Z','2026-09-01T10:00:00Z')",
                    params![stored_path.to_string_lossy(), hash, document_bytes.len() as i64, serde_json::to_string(&draft).unwrap()],
                )
                .expect("legacy import row");
        }

        let saved = store
            .update_payroll_import_draft(UpdatePayrollImportDraftInput {
                id: "import-proof".into(),
                draft: draft.clone(),
                extraction_engine: "smolvlm-local-double-read".into(),
                engine_version: Some("revision-locale-figee".into()),
                confidence_bp: 9_000,
                analysis_manifest: Some(analysis_manifest(&hash)),
                clear_analysis_manifest: false,
            })
            .expect("persist manifest");
        let stored_json = saved["analysis_manifest_json"]
            .as_str()
            .expect("manifest returned with import")
            .to_owned();
        let stored: PayrollAnalysisManifest =
            serde_json::from_str(&stored_json).expect("stored typed manifest");
        assert_eq!(stored.analyzed_pages, vec![1, 2]);
        assert_eq!(stored.input_sha256, hash);

        let mut linked_draft = draft.clone();
        linked_draft.review = Some(PayrollImportReviewState {
            employee_id: "employee-selected-manually".into(),
            employee_link_source: "manual".into(),
            ..PayrollImportReviewState::default()
        });
        let link_only_input: UpdatePayrollImportDraftInput = serde_json::from_value(json!({
            "id": "import-proof",
            "draft": linked_draft,
            "extraction_engine": "smolvlm-local-double-read",
            "engine_version": "revision-locale-figee",
            "confidence_bp": 9000
        }))
        .expect("link-only legacy payload");
        let after_link = store
            .update_payroll_import_draft(link_only_input)
            .expect("link-only update");
        assert_eq!(
            after_link["analysis_manifest_json"].as_str(),
            Some(stored_json.as_str()),
            "employee linkage metadata must not invalidate document provenance",
        );

        fs::write(&stored_path, b"modified after preview").expect("tamper managed copy");
        let tampered_error = store
            .update_payroll_import_draft(UpdatePayrollImportDraftInput {
                id: "import-proof".into(),
                draft: draft.clone(),
                extraction_engine: "smolvlm-local-double-read".into(),
                engine_version: Some("revision-locale-figee".into()),
                confidence_bp: 9_000,
                analysis_manifest: Some(analysis_manifest(&hash)),
                clear_analysis_manifest: false,
            })
            .expect_err("a manifest must not be attached after the managed bytes change");
        assert!(tampered_error
            .to_string()
            .contains("a changé depuis son import"));
        fs::write(&stored_path, document_bytes).expect("restore managed copy");

        let legacy_input: UpdatePayrollImportDraftInput = serde_json::from_value(json!({
            "id": "import-proof",
            "draft": draft.clone(),
            "extraction_engine": "manuel-apres-controle",
            "engine_version": null,
            "confidence_bp": 9500
        }))
        .expect("legacy update payload");
        let after_legacy = store
            .update_payroll_import_draft(legacy_input)
            .expect("legacy update remains accepted");
        assert_eq!(
            after_legacy["analysis_manifest_json"].as_str(),
            Some(stored_json.as_str()),
            "an omitted manifest must preserve the prior evidence"
        );

        let mut changed_draft = draft.clone();
        changed_draft.employee.role = "Correction humaine".into();
        let changed_legacy: UpdatePayrollImportDraftInput = serde_json::from_value(json!({
            "id": "import-proof",
            "draft": changed_draft,
            "extraction_engine": "manuel-apres-controle",
            "engine_version": null,
            "confidence_bp": 9500
        }))
        .expect("legacy changed payload");
        let after_change = store
            .update_payroll_import_draft(changed_legacy)
            .expect("changed legacy update remains accepted");
        let after_unrelated_change: PayrollAnalysisManifest = serde_json::from_str(
            after_change["analysis_manifest_json"]
                .as_str()
                .expect("unrelated field keeps prior evidence"),
        )
        .expect("reconciled manifest");
        assert_eq!(after_unrelated_change.field_provenance.len(), 2);
        assert_eq!(after_unrelated_change.line_provenance.len(), 1);

        changed_draft.employee.name = "Alex Corrigé".into();
        changed_draft.review = Some(PayrollImportReviewState {
            manual_fields: vec!["employee.name".into()],
            ..PayrollImportReviewState::default()
        });
        let partial_correction: UpdatePayrollImportDraftInput = serde_json::from_value(json!({
            "id": "import-proof",
            "draft": changed_draft,
            "extraction_engine": "manuel-apres-controle",
            "engine_version": null,
            "confidence_bp": 9500
        }))
        .expect("legacy-compatible partial correction payload");
        let after_partial = store
            .update_payroll_import_draft(partial_correction)
            .expect("partial correction keeps unrelated evidence");
        let reconciled: PayrollAnalysisManifest = serde_json::from_str(
            after_partial["analysis_manifest_json"]
                .as_str()
                .expect("partial manifest remains stored"),
        )
        .expect("typed partial manifest");
        assert_eq!(
            reconciled
                .field_provenance
                .iter()
                .map(|evidence| evidence.field.as_str())
                .collect::<Vec<_>>(),
            vec!["period"],
        );
        assert_eq!(reconciled.line_provenance.len(), 1);
        let persisted_draft: PayrollImportDraft = serde_json::from_str(
            after_partial["draft_json"]
                .as_str()
                .expect("corrected draft remains stored"),
        )
        .expect("typed corrected draft");
        assert_eq!(
            persisted_draft
                .review
                .as_ref()
                .expect("human review trace")
                .manual_fields,
            vec!["employee.name"]
        );

        store
            .confirm_payroll_document_import(ConfirmPayrollImportInput {
                id: "import-proof".into(),
                employee_id: None,
                replace_existing_template: false,
                draft: persisted_draft,
            })
            .expect("confirmation keeps reconciled evidence");
        let confirmed_manifest_json: Option<String> = store
            .connect()
            .expect("open confirmed import")
            .query_row(
                "SELECT analysis_manifest_json FROM payroll_document_imports WHERE id='import-proof'",
                [],
                |row| row.get(0),
            )
            .expect("confirmed import manifest");
        let confirmed_manifest: PayrollAnalysisManifest = serde_json::from_str(
            confirmed_manifest_json
                .as_deref()
                .expect("confirmation must retain partial evidence"),
        )
        .expect("typed confirmed manifest");
        assert_eq!(confirmed_manifest.field_provenance[0].field, "period");
        assert_eq!(confirmed_manifest.line_provenance.len(), 1);
    }

    #[test]
    fn verifies_the_document_bytes_against_the_stored_hash() {
        let bytes = b"document local immuable";
        let hash = format!("{:x}", Sha256::digest(bytes));
        verify_document_content_hash(bytes, &hash).expect("matching bytes");
        let error = verify_document_content_hash(b"document modifie", &hash)
            .expect_err("changed bytes must be refused");
        assert!(error.to_string().contains("a changé depuis son import"));
    }

    #[test]
    fn batch_failure_rolls_back_rows_and_removes_new_salary_copies() {
        let temporary = tempfile::tempdir().expect("temporary Zentra profile");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local store");
        {
            let connection = store.connect().expect("open test database");
            connection.execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise locale','2026-09-01T10:00:00Z','2026-09-01T10:00:00Z')",
                [],
            ).expect("completed onboarding marker");
        }
        let valid_path = temporary.path().join("premiere.png");
        let invalid_path = temporary.path().join("seconde.png");
        fs::write(&valid_path, png_with_declared_dimensions(1, 1)).expect("valid PNG");
        fs::write(&invalid_path, b"not a PNG").expect("invalid PNG fixture");

        store
            .stage_payroll_documents(StagePayrollDocumentsInput {
                paths: vec![
                    valid_path.to_string_lossy().into_owned(),
                    invalid_path.to_string_lossy().into_owned(),
                ],
            })
            .expect_err("the invalid second document must roll the whole batch back");

        let import_dir = store.attachments_dir.join("payroll-imports");
        let remaining_files = fs::read_dir(&import_dir)
            .expect("payroll import directory")
            .count();
        assert_eq!(
            remaining_files, 0,
            "no salary copy may survive a rolled-back batch"
        );
        let connection = store.connect().expect("reopen test database");
        let row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM payroll_document_imports", [], |row| {
                row.get(0)
            })
            .expect("count staged imports");
        assert_eq!(row_count, 0);
    }

    #[test]
    fn exact_reimport_refuses_a_non_uuid_database_id_before_writing() {
        let temporary = tempfile::tempdir().expect("temporary Zentra profile");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local store");
        {
            let connection = store.connect().expect("open test database");
            connection.execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise locale','2026-09-01T10:00:00Z','2026-09-01T10:00:00Z')",
                [],
            ).expect("completed onboarding marker");
        }
        let source_path = temporary.path().join("fiche.png");
        fs::write(&source_path, png_with_declared_dimensions(1, 1)).expect("source PNG");
        let input = || StagePayrollDocumentsInput {
            paths: vec![source_path.to_string_lossy().into_owned()],
        };
        let first = store
            .stage_payroll_documents(input())
            .expect("first import");
        let original_id = first["imports"][0]["id"]
            .as_str()
            .expect("import id")
            .to_owned();
        {
            let connection = store
                .connect()
                .expect("open database for corruption fixture");
            connection
                .execute(
                    "UPDATE payroll_document_imports SET id=? WHERE id=?",
                    params![r"..\escape", original_id],
                )
                .expect("simulate a locally corrupted identifier");
        }
        let escaped_target = store.attachments_dir.join("escape.png");

        let error = store
            .stage_payroll_documents(input())
            .expect_err("a database value must never become a managed path component");

        assert!(error.to_string().contains("identifiant local"));
        assert!(!escaped_target.exists());
    }

    #[test]
    fn exact_reimport_repairs_a_missing_or_corrupted_managed_copy() {
        let temporary = tempfile::tempdir().expect("temporary Zentra profile");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local store");
        {
            let connection = store.connect().expect("open test database");
            connection.execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise locale','2026-09-01T10:00:00Z','2026-09-01T10:00:00Z')",
                [],
            ).expect("completed onboarding marker");
        }
        let source_path = temporary.path().join("fiche.png");
        let source_bytes = png_with_declared_dimensions(1, 1);
        fs::write(&source_path, &source_bytes).expect("source PNG");
        let input = || StagePayrollDocumentsInput {
            paths: vec![source_path.to_string_lossy().into_owned()],
        };
        let first = store
            .stage_payroll_documents(input())
            .expect("first import");
        let first_row = &first["imports"][0];
        let import_id = first_row["id"].as_str().expect("import id").to_owned();
        let stored_path = PathBuf::from(first_row["stored_path"].as_str().expect("stored path"));
        let preserved_manifest = r#"{"schema_version":1,"marker":"exact-sha-history"}"#;
        {
            let connection = store.connect().expect("open database for manifest marker");
            connection
                .execute(
                    "UPDATE payroll_document_imports SET analysis_manifest_json=? WHERE id=?",
                    params![preserved_manifest, import_id],
                )
                .expect("store exact-hash history marker");
        }

        fs::remove_file(&stored_path).expect("remove managed copy");
        let repaired_missing = store
            .stage_payroll_documents(input())
            .expect("repair missing copy");
        assert_eq!(
            repaired_missing["imports"][0]["id"].as_str(),
            Some(import_id.as_str())
        );
        assert_eq!(fs::read(&stored_path).expect("restored copy"), source_bytes);

        fs::write(&stored_path, png_with_declared_dimensions(2, 1)).expect("corrupt managed copy");
        let preview_error = store
            .payroll_document_preview(&import_id)
            .expect_err("preview must refuse bytes that no longer match the stored hash");
        assert!(preview_error
            .to_string()
            .contains("a changé depuis son import"));
        let repaired_corrupt = store
            .stage_payroll_documents(input())
            .expect("repair corrupted copy");
        assert_eq!(
            repaired_corrupt["imports"][0]["id"].as_str(),
            Some(import_id.as_str())
        );
        assert_eq!(fs::read(&stored_path).expect("repaired copy"), source_bytes);
        store
            .payroll_document_preview(&import_id)
            .expect("preview after exact repair");
        let connection = store.connect().expect("reopen database after repairs");
        let manifest_after_repairs: Option<String> = connection
            .query_row(
                "SELECT analysis_manifest_json FROM payroll_document_imports WHERE id=?",
                params![import_id],
                |row| row.get(0),
            )
            .expect("manifest after repairs");
        assert_eq!(manifest_after_repairs.as_deref(), Some(preserved_manifest));
    }

    #[test]
    fn same_extracted_text_with_different_sha_keeps_both_documents() {
        let temporary = tempfile::tempdir().expect("temporary Zentra profile");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local store");
        {
            let connection = store.connect().expect("open test database");
            connection.execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise locale','2026-09-01T10:00:00Z','2026-09-01T10:00:00Z')",
                [],
            ).expect("completed onboarding marker");
        }
        let visible_text = "Décompte de salaire Collaborateur Alex Exemple Période 2026-08 Salaire brut 5000.00 Salaire net 4700.00 Cotisation AVS AI APG 265.00 Assurance chômage 55.00 Assurance accident non professionnel 35.00 Versement bancaire en francs suisses";
        let first_bytes = pdf_with_text(visible_text, "producer-a");
        let second_bytes = pdf_with_text(visible_text, "producer-b");
        assert_ne!(Sha256::digest(&first_bytes), Sha256::digest(&second_bytes));
        let first_text =
            pdf_extract::extract_text_from_mem(&first_bytes).expect("extract first PDF");
        let second_text =
            pdf_extract::extract_text_from_mem(&second_bytes).expect("extract second PDF");
        let first_fingerprint = semantic_text_fingerprint(&first_text)
            .expect("the visible salary text must be long enough for semantic comparison");
        assert_eq!(
            Some(first_fingerprint),
            semantic_text_fingerprint(&second_text),
        );
        let first_path = temporary.path().join("fiche-a.pdf");
        let second_path = temporary.path().join("fiche-b.pdf");
        fs::write(&first_path, first_bytes).expect("first source PDF");
        fs::write(&second_path, second_bytes).expect("second source PDF");

        let staged = store
            .stage_payroll_documents(StagePayrollDocumentsInput {
                paths: vec![
                    first_path.to_string_lossy().into_owned(),
                    second_path.to_string_lossy().into_owned(),
                ],
            })
            .expect("both distinct documents must be staged");
        let rows = staged["imports"].as_array().expect("staged imports");
        assert_eq!(rows.len(), 2);
        assert_ne!(rows[0]["id"], rows[1]["id"]);
        assert_ne!(rows[0]["file_sha256"], rows[1]["file_sha256"]);
        let second_draft: PayrollImportDraft =
            serde_json::from_str(rows[1]["draft_json"].as_str().expect("second draft JSON"))
                .expect("typed second draft");
        assert!(second_draft
            .warnings
            .iter()
            .any(|warning| warning.contains("octets diffèrent")));
    }

    #[test]
    fn confirmation_refuses_a_document_changed_after_preview() {
        let temporary = tempfile::tempdir().expect("temporary Zentra profile");
        let store = LocalStore::initialize(temporary.path().join("profile"))
            .expect("initialize local store");
        {
            let connection = store.connect().expect("open test database");
            connection.execute(
                "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise locale','2026-09-01T10:00:00Z','2026-09-01T10:00:00Z')",
                [],
            ).expect("completed onboarding marker");
        }
        let source_path = temporary.path().join("fiche.png");
        fs::write(&source_path, png_with_declared_dimensions(1, 1)).expect("source PNG");
        let staged = store
            .stage_payroll_documents(StagePayrollDocumentsInput {
                paths: vec![source_path.to_string_lossy().into_owned()],
            })
            .expect("stage document");
        let row = &staged["imports"][0];
        let import_id = row["id"].as_str().expect("import id").to_owned();
        let stored_path = row["stored_path"].as_str().expect("stored path");
        store
            .payroll_document_preview(&import_id)
            .expect("initial verified preview");
        fs::write(stored_path, png_with_declared_dimensions(2, 1)).expect("tamper after preview");

        let error = store
            .confirm_payroll_document_import(ConfirmPayrollImportInput {
                id: import_id.clone(),
                employee_id: None,
                replace_existing_template: false,
                draft: manifest_draft(),
            })
            .expect_err("confirmation must re-read the managed bytes");
        assert!(error.to_string().contains("a changé depuis son import"));
        let connection = store.connect().expect("reopen database");
        let status: String = connection
            .query_row(
                "SELECT status FROM payroll_document_imports WHERE id=?",
                params![import_id],
                |row| row.get(0),
            )
            .expect("import status");
        assert_eq!(status, "needs_review");
        let employee_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM employees", [], |row| row.get(0))
            .expect("employee count");
        assert_eq!(employee_count, 0);
    }

    #[test]
    fn accepts_supported_binary_signatures() {
        let fixtures: &[(&str, &[u8], PayrollDocumentType)] = &[
            ("fiche.pdf", b"%PDF-1.7\n%local", PayrollDocumentType::Pdf),
            (
                "fiche.png",
                &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
                PayrollDocumentType::Png,
            ),
            (
                "fiche.jpeg",
                &[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10],
                PayrollDocumentType::Jpeg,
            ),
            (
                "fiche.webp",
                b"RIFF\x10\x00\x00\x00WEBPVP8X",
                PayrollDocumentType::Webp,
            ),
        ];

        for (name, bytes, expected) in fixtures {
            assert!(validate_document_signature(Path::new(name), bytes, *expected).is_ok());
        }
    }

    #[test]
    fn rejects_a_pdf_disguised_with_an_image_extension() {
        let error = validate_document_signature(
            Path::new("fiche.png"),
            b"%PDF-1.7\n%local",
            PayrollDocumentType::Png,
        )
        .expect_err("a mismatched extension must be rejected");

        let message = error.to_string();
        assert!(message.contains("extension PNG"));
        assert!(message.contains("contenu est PDF"));
    }

    #[test]
    fn rejects_unknown_or_incomplete_magic_bytes() {
        assert!(validate_document_signature(
            Path::new("fiche.pdf"),
            b"not-a-document",
            PayrollDocumentType::Pdf,
        )
        .is_err());
        assert!(validate_document_signature(
            Path::new("fiche.webp"),
            b"RIFF\x08\x00\x00\x00WEBPNOPE",
            PayrollDocumentType::Webp,
        )
        .is_err());
    }

    #[test]
    fn maps_jpg_and_jpeg_to_the_same_expected_signature() {
        assert_eq!(
            PayrollDocumentType::from_extension("jpg"),
            Some(PayrollDocumentType::Jpeg)
        );
        assert_eq!(
            PayrollDocumentType::from_extension("jpeg"),
            Some(PayrollDocumentType::Jpeg)
        );
    }

    #[test]
    fn counts_every_pdf_page_and_refuses_silent_visual_truncation() {
        let accepted = pdf_with_page_count(MAX_PDF_PAGES);
        assert_eq!(
            document_page_count(Path::new("fiche.pdf"), &accepted, PayrollDocumentType::Pdf)
                .expect("all accepted pages must be counted"),
            MAX_PDF_PAGES
        );

        let oversized = pdf_with_page_count(MAX_PDF_PAGES + 1);
        assert!(
            document_page_count(Path::new("lot.pdf"), &oversized, PayrollDocumentType::Pdf)
                .expect_err("a document must never be silently truncated")
                .to_string()
                .contains("13 pages")
        );
    }

    #[test]
    fn historical_import_preserves_a_template_unless_replacement_is_explicit() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE employee_payroll_templates(
                    employee_id TEXT PRIMARY KEY,
                    salary_mode TEXT NOT NULL,
                    base_salary_cents INTEGER NOT NULL,
                    recurring_earnings_json TEXT NOT NULL,
                    suggested_contribution_codes_json TEXT NOT NULL,
                    source_import_id TEXT,
                    reviewed_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );",
            )
            .expect("template table");
        let insert = |replace: bool, base: i64, source: &str| {
            connection
                .execute(
                    employee_template_upsert_sql(replace),
                    rusqlite::params![
                        "employee-1",
                        "monthly",
                        base,
                        format!(
                            r#"[{{"label":"Salaire","kind":"earning","amount_cents":{base}}}]"#
                        ),
                        source,
                        "2026-08-31T12:00:00Z",
                        "2026-08-31T12:00:00Z",
                        "2026-08-31T12:00:00Z",
                    ],
                )
                .expect("upsert template");
        };
        insert(false, 500_000, "current-template");
        insert(false, 420_000, "historical-import");
        let preserved: (i64, String) = connection
            .query_row(
                "SELECT base_salary_cents,source_import_id FROM employee_payroll_templates WHERE employee_id='employee-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("preserved template");
        assert_eq!(preserved, (500_000, "current-template".into()));

        insert(true, 420_000, "explicit-replacement");
        let replaced: (i64, String) = connection
            .query_row(
                "SELECT base_salary_cents,source_import_id FROM employee_payroll_templates WHERE employee_id='employee-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("replaced template");
        assert_eq!(replaced, (420_000, "explicit-replacement".into()));
    }

    #[test]
    fn historical_gross_never_becomes_a_salary_template_without_a_reviewed_recurring_gain() {
        let mut draft = empty_draft();
        draft.gross_cents = 780_000;
        draft.lines.push(PayrollImportLineDraft {
            label: "Salaire, bonus et indemnités".into(),
            kind: "earning".into(),
            amount_cents: 780_000,
            recurring: false,
            confidence_bp: 9_000,
            ..PayrollImportLineDraft::default()
        });

        let (recurring, base_salary_cents) = reviewed_recurring_earnings(&draft);
        assert!(recurring.is_empty());
        assert_eq!(base_salary_cents, 0);

        draft.lines.push(PayrollImportLineDraft {
            label: "Salaire mensuel contrôlé".into(),
            kind: "earning".into(),
            amount_cents: 600_000,
            recurring: true,
            confidence_bp: 9_500,
            ..PayrollImportLineDraft::default()
        });
        let (unconfirmed, unconfirmed_base) = reviewed_recurring_earnings(&draft);
        assert!(unconfirmed.is_empty());
        assert_eq!(
            unconfirmed_base, 0,
            "an automatic suggestion must not create a salary template"
        );
        draft.review = Some(PayrollImportReviewState {
            confirmed_recurring_lines: vec![PayrollConfirmedRecurringLine {
                label: "Salaire mensuel contrôlé".into(),
                kind: "earning".into(),
                amount_cents: 600_000,
                ..PayrollConfirmedRecurringLine::default()
            }],
            ..PayrollImportReviewState::default()
        });
        let (recurring, base_salary_cents) = reviewed_recurring_earnings(&draft);
        assert_eq!(recurring.len(), 1);
        assert_eq!(base_salary_cents, 600_000);
    }

    #[test]
    fn recurring_confirmation_is_scoped_to_one_exact_duplicate_occurrence() {
        let mut draft = empty_draft();
        for id in ["line-a", "line-b"] {
            draft.lines.push(PayrollImportLineDraft {
                id: id.into(),
                label: "Indemnité récurrente".into(),
                kind: "earning".into(),
                amount_cents: 20_000,
                recurring: true,
                confidence_bp: 9_000,
                ..PayrollImportLineDraft::default()
            });
        }
        draft.review = Some(PayrollImportReviewState {
            confirmed_recurring_lines: vec![PayrollConfirmedRecurringLine {
                line_id: "line-a".into(),
                label: "Indemnité récurrente".into(),
                kind: "earning".into(),
                amount_cents: 20_000,
            }],
            ..PayrollImportReviewState::default()
        });

        let (confirmed, base_salary_cents) = reviewed_recurring_earnings(&draft);
        assert_eq!(confirmed.len(), 1);
        assert_eq!(base_salary_cents, 20_000);

        draft
            .review
            .as_mut()
            .expect("review")
            .confirmed_recurring_lines[0]
            .line_id
            .clear();
        let (ambiguous_legacy, ambiguous_base) = reviewed_recurring_earnings(&draft);
        assert!(ambiguous_legacy.is_empty());
        assert_eq!(
            ambiguous_base, 0,
            "legacy duplicate confirmations fail closed"
        );
    }

    #[test]
    fn normalization_keeps_line_ids_unique_and_clears_duplicate_source_refs() {
        let mut draft = empty_draft();
        for amount_cents in [20_000, 21_000] {
            draft.lines.push(PayrollImportLineDraft {
                id: "duplicate-id".into(),
                source_ref: "ai:p1-1:kearning:h12345678:a20000:o1".into(),
                label: "Indemnité".into(),
                kind: "earning".into(),
                amount_cents,
                recurring: false,
                confidence_bp: 9_000,
            });
        }

        normalize_draft(&mut draft, false).expect("normalize line tracking metadata");

        assert_ne!(draft.lines[0].id, draft.lines[1].id);
        assert_eq!(
            draft.lines[0].source_ref,
            "ai:p1-1:kearning:h12345678:a20000:o1"
        );
        assert!(draft.lines[1].source_ref.is_empty());
    }

    #[test]
    fn refuses_to_link_a_document_to_a_conflicting_avs_identity() {
        let mut imported = empty_draft().employee;
        imported.avs_number = "756 9217 0769 85".into();
        validate_linked_employee_identity(Some("756.9217.0769.85"), None, None, None, &imported)
            .expect("formatting differences are harmless");
        validate_linked_employee_identity(None, None, None, None, &imported)
            .expect("an empty stored AVS cannot contradict the document");

        imported.avs_number = "756.1234.5678.97".into();
        let error = validate_linked_employee_identity(
            Some("756.9217.0769.85"),
            None,
            None,
            None,
            &imported,
        )
        .expect_err("different identities must be blocked");
        assert!(error.to_string().contains("ne correspond pas"));

        imported.avs_number.clear();
        imported.employee_number = "E-002".into();
        let error = validate_linked_employee_identity(None, Some("E-001"), None, None, &imported)
            .expect_err("different employee numbers must be blocked");
        assert!(error.to_string().contains("numéro employé"));

        imported.employee_number.clear();
        imported.birth_date = "1991-01-01".into();
        let error =
            validate_linked_employee_identity(None, None, Some("1990-01-01"), None, &imported)
                .expect_err("different birth dates must be blocked");
        assert!(error.to_string().contains("naissance"));

        imported.birth_date.clear();
        imported.iban = "CH93 0076 2011 6238 5295 8".into();
        validate_linked_employee_identity(
            None,
            None,
            None,
            Some("ch9300762011623852958"),
            &imported,
        )
        .expect("IBAN whitespace and casing differences are harmless");
        let error = validate_linked_employee_identity(
            None,
            None,
            None,
            Some("CH56 0483 5012 3456 7800 9"),
            &imported,
        )
        .expect_err("different IBANs must be blocked");
        assert!(error.to_string().contains("IBAN"));
    }

    #[test]
    fn rejects_a_compressed_image_with_a_dimension_bomb_before_decoding() {
        let normal = png_with_declared_dimensions(1, 1);
        assert!(validate_image_dimensions(
            Path::new("normal.png"),
            &normal,
            PayrollDocumentType::Png,
        )
        .is_ok());

        // Le fichier reste minuscule, mais son en-tête annonce 30 millions de
        // pixels. Le contrôle ne doit jamais allouer cette surface.
        let bomb = png_with_declared_dimensions(6_000, 5_000);
        let error =
            validate_image_dimensions(Path::new("bombe.png"), &bomb, PayrollDocumentType::Png)
                .expect_err("oversized declared dimensions must be rejected");
        assert!(error.to_string().contains("24 mégapixels"));
    }

    #[test]
    fn parses_a_french_swiss_payslip_without_inventing_unknown_fields() {
        let draft = draft_from_text(
            "Décompte de salaire\nPériode: août 2026\nCollaborateur: Alex Exemple\nN° AVS 756.1234.5678.90\nSalaire mensuel 5'000.00\nCotisation AVS/AI/APG 265.00\nCotisation AC 55.00\nSalaire brut 5'000.00\nSalaire net 4'680.00",
        );
        assert_eq!(draft.employee.name, "Alex Exemple");
        assert_eq!(draft.employee.avs_number, "756.1234.5678.90");
        assert_eq!(draft.period, "2026-08");
        assert_eq!(draft.gross_cents, 500_000);
        assert_eq!(draft.net_cents, 468_000);
        assert_eq!(draft_totals(&draft.lines), (500_000, 32_000, 0, 0));
    }

    #[test]
    fn ignores_printed_summary_rows_instead_of_counting_them_twice() {
        let lines = extract_payroll_lines(
            "Salaire mensuel 6'500.00\nAVS / AI / APG 344.50\nAssurance-chômage 71.50\nPart AVS employeur 344.50\nRetenues employé CHF 416.00\nCharges employeur CHF 344.50\nSalaire net CHF 6'084.00",
        );
        assert_eq!(draft_totals(&lines), (650_000, 41_600, 34_450, 0));
        assert!(!lines
            .iter()
            .any(|line| line.label.to_lowercase().contains("retenues employ")));
    }

    #[test]
    fn preserves_identical_printed_occurrences_and_refuses_more_than_eighty_explicitly() {
        let lines = extract_payroll_lines("Indemnité repas 20.00\nIndemnité repas 20.00");
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|line| line.amount_cents == 2_000));

        let mut oversized = empty_draft();
        oversized.lines = (0..81)
            .map(|index| PayrollImportLineDraft {
                label: format!("Rubrique {index}"),
                kind: "earning".into(),
                amount_cents: 100,
                ..PayrollImportLineDraft::default()
            })
            .collect();
        assert!(normalize_draft(&mut oversized, false)
            .expect_err("81 lines must be refused instead of truncated")
            .to_string()
            .contains("80 lignes"));
    }

    #[test]
    fn blocks_confirmation_when_the_detected_totals_do_not_reconcile() {
        let mut draft = empty_draft();
        draft.employee.name = "Alex Exemple".into();
        draft.period = "2026-08".into();
        draft.gross_cents = 500_000;
        draft.net_cents = 480_000;
        draft.lines.push(PayrollImportLineDraft {
            label: "Salaire mensuel".into(),
            kind: "earning".into(),
            amount_cents: 450_000,
            recurring: true,
            confidence_bp: 8_000,
            ..PayrollImportLineDraft::default()
        });
        assert!(validate_confirmable_draft(&draft).is_err());
    }

    #[test]
    fn keeps_expense_reimbursements_out_of_gross_and_adds_them_to_net() {
        let mut draft = draft_from_text(
            "Décompte de salaire\nPériode: août 2026\nCollaborateur: Alex Exemple\nSalaire mensuel 5'000.00\nCotisation AVS/AI/APG 500.00\nRemboursement de frais 200.00\nSalaire brut 5'000.00\nSalaire net 4'700.00",
        );
        normalize_draft(&mut draft, true).expect("normalize reimbursement draft");
        assert_eq!(draft_totals(&draft.lines), (500_000, 50_000, 0, 20_000));
        assert!(draft
            .lines
            .iter()
            .any(|line| line.kind == "reimbursement" && !line.recurring));
        validate_confirmable_draft(&draft)
            .expect("gross - deductions + reimbursements must reconcile");
    }

    #[test]
    fn validates_avs_and_international_iban_checksums() {
        assert!(is_valid_avs("756.9217.0769.85"));
        assert!(!is_valid_avs("756.9217.0769.84"));
        assert!(is_valid_iban("CH93 0076 2011 6238 5295 7"));
        assert!(is_valid_iban("DE89 3704 0044 0532 0130 00"));
        assert!(!is_valid_iban("CH93 0076 2011 6238 5295 6"));
        assert!(!is_valid_iban("Aé12 3456 7890 1234"));
        assert!(!is_valid_iban("ＣＨ93 0076 2011 6238 5295 7"));
    }

    #[test]
    fn blocks_confirmation_with_invalid_identity_checksums() {
        let mut draft = empty_draft();
        draft.employee.name = "Alex Exemple".into();
        draft.employee.avs_number = "756.9217.0769.84".into();
        draft.period = "2026-08".into();
        draft.lines.push(PayrollImportLineDraft {
            label: "Salaire mensuel".into(),
            kind: "earning".into(),
            amount_cents: 500_000,
            recurring: true,
            confidence_bp: 9_000,
            ..PayrollImportLineDraft::default()
        });
        assert!(validate_confirmable_draft(&draft)
            .expect_err("invalid AVS must block confirmation")
            .to_string()
            .contains("EAN-13"));
    }

    #[test]
    fn blocks_confirmation_with_an_invalid_birth_date() {
        let mut draft = empty_draft();
        draft.employee.name = "Alex Exemple".into();
        draft.employee.birth_date = "2026-02-30".into();
        draft.period = "2026-08".into();
        draft.lines.push(PayrollImportLineDraft {
            label: "Salaire mensuel".into(),
            kind: "earning".into(),
            amount_cents: 500_000,
            recurring: true,
            confidence_bp: 9_000,
            ..PayrollImportLineDraft::default()
        });

        assert!(validate_confirmable_draft(&draft)
            .expect_err("an impossible calendar date must be blocked")
            .to_string()
            .contains("date de naissance"));
    }

    #[test]
    fn semantic_fingerprint_detects_layout_only_pdf_duplicates_but_ignores_short_headers() {
        let first = "Décompte de salaire Alex Exemple période août 2026 salaire mensuel 5000.00 AVS AI APG 265.00 AC 55.00 LPP 350.00 brut 5000.00 net à payer 4330.00 adresse Rue du Test 1 1000 Lausanne";
        let second = "DÉCOMPTE   DE SALAIRE\nAlex Exemple\nPériode: août 2026\nSalaire mensuel: 5'000.00\nAVS/AI/APG 265.00\nAC 55.00\nLPP 350.00\nBrut 5'000.00\nNet à payer 4'330.00\nAdresse: Rue du Test 1, 1000 Lausanne";
        assert_eq!(
            semantic_text_fingerprint(first),
            semantic_text_fingerprint(second)
        );
        assert_eq!(semantic_text_fingerprint("Décompte de salaire"), None);
    }

    #[test]
    fn confirmation_requires_printed_totals_instead_of_inventing_them_from_lines() {
        let draft = draft_from_text(
            "Décompte de salaire\nPériode: août 2026\nCollaborateur: Alex Exemple\nSalaire mensuel 5'000.00\nCotisation AVS 265.00",
        );
        assert_eq!(
            draft.gross_cents, 0,
            "a missing printed total must remain missing"
        );
        assert!(validate_confirmable_draft(&draft)
            .expect_err("the printed gross and net are mandatory")
            .to_string()
            .contains("total brut"));
    }

    #[test]
    fn confirmation_accepts_two_reviewed_identical_occurrences_when_totals_match() {
        let mut draft = empty_draft();
        draft.employee.name = "Alex Exemple".into();
        draft.period = "2026-08".into();
        draft.gross_cents = 1_000_000;
        draft.net_cents = 1_000_000;
        for label in ["Salaire mensuel", "SALAIRE  MENSUEL"] {
            draft.lines.push(PayrollImportLineDraft {
                label: label.into(),
                kind: "earning".into(),
                amount_cents: 500_000,
                recurring: true,
                confidence_bp: 9_000,
                ..PayrollImportLineDraft::default()
            });
        }
        validate_confirmable_draft(&draft)
            .expect("two occurrences printed and reviewed separately are legitimate");
    }
}
