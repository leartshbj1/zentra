use std::{
    fs,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
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
        ConfirmPayrollImportInput, PayrollImportDraft, PayrollImportEmployeeDraft,
        PayrollImportLineDraft, StagePayrollDocumentsInput, UpdatePayrollImportDraftInput,
    },
};

const MAX_IMPORT_FILES: usize = 40;
const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS: usize = 80_000;
const ENGINE_VERSION: &str = "elyko-local-parser-1";

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
            validate_document_signature(&source, &bytes, document_type)?;
            let media_kind = document_type.media_kind();
            let hash = format!("{:x}", Sha256::digest(&bytes));
            if let Some(mut existing) = transaction
                .query_row(
                    "SELECT * FROM payroll_document_imports WHERE file_sha256=?",
                    params![hash],
                    crate::database::row_to_json_public,
                )
                .optional()?
            {
                if matches!(
                    existing.get("status").and_then(Value::as_str),
                    Some("rejected" | "error")
                ) {
                    let now = now_iso();
                    transaction.execute(
                        "UPDATE payroll_document_imports SET status='needs_review',error_message=NULL,reviewed_at=NULL,updated_at=? WHERE file_sha256=?",
                        params![now, hash],
                    )?;
                    existing = transaction.query_row(
                        "SELECT * FROM payroll_document_imports WHERE file_sha256=?",
                        params![hash],
                        crate::database::row_to_json_public,
                    )?;
                }
                staged.push(existing);
                continue;
            }

            let id = Uuid::new_v4().to_string();
            let stored_name = format!("{id}.{extension}");
            let stored_path = import_dir.join(stored_name);
            fs::write(&stored_path, &bytes)?;
            let source_name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("fiche-salaire")
                .to_owned();

            let (extracted_text, extraction_engine, mut draft, extraction_error) = if media_kind
                == "pdf"
            {
                match pdf_extract::extract_text(&source) {
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
            normalize_draft(&mut draft, false)?;
            let confidence_bp = draft_confidence(&draft);
            let now = now_iso();
            let draft_json = serde_json::to_string(&draft)?;
            transaction.execute(
                "INSERT INTO payroll_document_imports(id,source_name,stored_path,file_sha256,media_kind,file_size,page_count,extraction_engine,engine_version,extracted_text,draft_json,confidence_bp,status,error_message,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?,'needs_review',?,?,?)",
                params![
                    id,
                    source_name,
                    stored_path.to_string_lossy(),
                    hash,
                    media_kind,
                    metadata.len() as i64,
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
        let stored_path: Option<String> = connection
            .query_row(
                "SELECT stored_path FROM payroll_document_imports WHERE id=?",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let stored_path = stored_path
            .ok_or_else(|| AppError::NotFound(format!("payroll_document_imports/{id}")))?;
        let canonical_path = fs::canonicalize(PathBuf::from(stored_path))?;
        let canonical_root = fs::canonicalize(&self.attachments_dir)?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err(AppError::UnsafePath(canonical_path));
        }
        let metadata = fs::metadata(&canonical_path)?;
        if metadata.len() == 0 || metadata.len() > MAX_FILE_BYTES {
            return Err(AppError::Validation(
                "Le document local est vide ou dépasse la limite de 25 Mo.".into(),
            ));
        }
        let extension = canonical_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let document_type = PayrollDocumentType::from_extension(&extension).ok_or_else(|| {
            AppError::Validation("Le format du document local n'est plus pris en charge.".into())
        })?;
        let bytes = fs::read(&canonical_path)?;
        validate_document_signature(&canonical_path, &bytes, document_type)?;
        Ok(json!({
            "mime_type": document_type.mime_type(),
            "data_base64": STANDARD.encode(bytes),
        }))
    }

    pub fn update_payroll_import_draft(
        &self,
        input: UpdatePayrollImportDraftInput,
    ) -> AppResult<Value> {
        let id = input.id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "L'identifiant de l'import est obligatoire.".into(),
            ));
        }
        let mut draft = input.draft;
        normalize_draft(&mut draft, false)?;
        let confidence_bp = input.confidence_bp.clamp(0, 10_000);
        let engine = input.extraction_engine.trim();
        if engine.is_empty() || engine.chars().count() > 100 {
            return Err(AppError::Validation(
                "Le nom du moteur d'extraction est invalide.".into(),
            ));
        }
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let status: Option<String> = transaction
            .query_row(
                "SELECT status FROM payroll_document_imports WHERE id=?",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        match status.as_deref() {
            None => return Err(AppError::NotFound(format!("payroll_document_imports/{id}"))),
            Some("confirmed") => {
                return Err(AppError::Validation(
                    "Un import déjà confirmé ne peut plus être remplacé par une analyse IA.".into(),
                ))
            }
            _ => {}
        }
        transaction.execute(
            "UPDATE payroll_document_imports SET draft_json=?,extraction_engine=?,engine_version=?,confidence_bp=?,error_message=NULL,updated_at=? WHERE id=?",
            params![
                serde_json::to_string(&draft)?,
                engine,
                input.engine_version.as_deref().map(str::trim).filter(|value| !value.is_empty()),
                confidence_bp,
                now_iso(),
                id,
            ],
        )?;
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
        let import_id = input.id.trim();
        let mut draft = input.draft;
        normalize_draft(&mut draft, true)?;
        validate_confirmable_draft(&draft)?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let status: Option<String> = transaction
            .query_row(
                "SELECT status FROM payroll_document_imports WHERE id=?",
                params![import_id],
                |row| row.get(0),
            )
            .optional()?;
        match status.as_deref() {
            None => {
                return Err(AppError::NotFound(format!(
                    "payroll_document_imports/{import_id}"
                )))
            }
            Some("confirmed") => {
                return Err(AppError::Validation(
                    "Cette fiche a déjà été confirmée et importée.".into(),
                ))
            }
            Some("rejected") => {
                return Err(AppError::Validation(
                    "Cette fiche a été rejetée. Réimportez le document pour recommencer.".into(),
                ))
            }
            _ => {}
        }

        let employee_id = match input
            .employee_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(existing_id) => {
                let exists: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM employees WHERE id=?)",
                    params![existing_id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(AppError::NotFound(format!("employees/{existing_id}")));
                }
                existing_id.to_owned()
            }
            None => insert_employee_from_draft(&transaction, &draft.employee, draft.gross_cents)?,
        };

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
                totals.0.saturating_sub(totals.1),
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

        let recurring: Vec<Value> = draft
            .lines
            .iter()
            .filter(|line| line.kind == "earning" && line.recurring)
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
            .sum::<i64>()
            .max(if recurring.is_empty() {
                draft.gross_cents
            } else {
                0
            });
        transaction.execute(
            "INSERT INTO employee_payroll_templates(employee_id,salary_mode,base_salary_cents,recurring_earnings_json,suggested_contribution_codes_json,source_import_id,reviewed_at,created_at,updated_at) VALUES(?,?,?,?, '[]',?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET salary_mode=excluded.salary_mode,base_salary_cents=excluded.base_salary_cents,recurring_earnings_json=excluded.recurring_earnings_json,source_import_id=excluded.source_import_id,reviewed_at=excluded.reviewed_at,updated_at=excluded.updated_at",
            params![
                employee_id,
                draft.employee.salary_mode,
                base_salary_cents,
                serde_json::to_string(&recurring)?,
                import_id,
                now,
                now,
                now,
            ],
        )?;
        transaction.execute(
            "UPDATE payroll_document_imports SET draft_json=?,confidence_bp=?,status='confirmed',employee_id=?,payslip_id=?,reviewed_at=?,updated_at=? WHERE id=?",
            params![
                serde_json::to_string(&draft)?,
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

    let totals = draft_totals(&draft.lines);
    if draft.gross_cents == 0 && totals.0 > 0 {
        draft.gross_cents = totals.0;
    }
    if !draft.lines.iter().any(|line| line.kind == "earning") && draft.gross_cents > 0 {
        draft.lines.insert(
            0,
            PayrollImportLineDraft {
                label: "Salaire brut détecté".into(),
                kind: "earning".into(),
                amount_cents: draft.gross_cents,
                recurring: true,
                confidence_bp: 5_500,
            },
        );
    }
    let totals = draft_totals(&draft.lines);
    if !draft.lines.iter().any(|line| line.kind == "deduction")
        && draft.gross_cents > 0
        && draft.net_cents > 0
        && draft.gross_cents >= draft.net_cents
    {
        let difference = draft.gross_cents - draft.net_cents;
        if difference > 0 {
            draft.lines.push(PayrollImportLineDraft {
                label: "Retenues détectées — détail à contrôler".into(),
                kind: "deduction".into(),
                amount_cents: difference,
                recurring: false,
                confidence_bp: 3_500,
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
        if !lines.iter().any(|line: &PayrollImportLineDraft| {
            line.label.eq_ignore_ascii_case(label) && line.amount_cents == amount_cents
        }) {
            lines.push(PayrollImportLineDraft {
                label: label.to_owned(),
                kind: kind.into(),
                amount_cents,
                recurring,
                confidence_bp: 6_500,
            });
        }
        if lines.len() >= 40 {
            break;
        }
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
    for line in &mut draft.lines {
        line.label = clean_text(&line.label, 200);
        line.kind = match line.kind.trim() {
            "earning" | "gain" => "earning".into(),
            "deduction" | "retenue" => "deduction".into(),
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
        line.confidence_bp = line.confidence_bp.clamp(0, 10_000);
    }
    draft.warnings = draft
        .warnings
        .iter()
        .map(|warning| clean_text(warning, 500))
        .filter(|warning| !warning.is_empty())
        .take(30)
        .collect();
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
    let totals = draft_totals(&draft.lines);
    if draft.gross_cents > 0 && (draft.gross_cents - totals.0).abs() > 2 {
        return Err(AppError::Validation(format!(
            "Le brut confirmé ({:.2} CHF) ne correspond pas à la somme des gains ({:.2} CHF). Corrigez les lignes avant l'import.",
            draft.gross_cents as f64 / 100.0,
            totals.0 as f64 / 100.0
        )));
    }
    if draft.net_cents > 0 && (draft.net_cents - totals.0.saturating_sub(totals.1)).abs() > 2 {
        return Err(AppError::Validation(format!(
            "Le net confirmé ({:.2} CHF) ne correspond pas au brut moins les retenues ({:.2} CHF). Corrigez les lignes avant l'import.",
            draft.net_cents as f64 / 100.0,
            totals.0.saturating_sub(totals.1) as f64 / 100.0
        )));
    }
    Ok(())
}

fn insert_employee_from_draft(
    transaction: &rusqlite::Transaction<'_>,
    employee: &PayrollImportEmployeeDraft,
    gross_cents: i64,
) -> AppResult<String> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let monthly_salary = if employee.salary_mode == "monthly" {
        gross_cents.max(0)
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

fn optional_text(value: &str) -> Option<&str> {
    let clean = value.trim();
    (!clean.is_empty()).then_some(clean)
}

fn draft_totals(lines: &[PayrollImportLineDraft]) -> (i64, i64, i64) {
    lines
        .iter()
        .fold((0_i64, 0_i64, 0_i64), |mut totals, line| {
            match line.kind.as_str() {
                "earning" => totals.0 = totals.0.saturating_add(line.amount_cents),
                "deduction" => totals.1 = totals.1.saturating_add(line.amount_cents),
                "employer" => totals.2 = totals.2.saturating_add(line.amount_cents),
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
    for line in text.lines() {
        let lower = line.to_lowercase();
        if labels.iter().any(|label| lower.contains(label)) {
            let captures =
                Regex::new(r"(-?\d{1,3}(?:[ '\u{2019}]\d{3})*(?:[.,]\d{2})|-?\d+(?:[.,]\d{2}))")
                    .ok()?
                    .captures_iter(line)
                    .last();
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
    fn parses_a_french_swiss_payslip_without_inventing_unknown_fields() {
        let draft = draft_from_text(
            "Décompte de salaire\nPériode: août 2026\nCollaborateur: Alex Exemple\nN° AVS 756.1234.5678.90\nSalaire mensuel 5'000.00\nCotisation AVS/AI/APG 265.00\nCotisation AC 55.00\nSalaire brut 5'000.00\nSalaire net 4'680.00",
        );
        assert_eq!(draft.employee.name, "Alex Exemple");
        assert_eq!(draft.employee.avs_number, "756.1234.5678.90");
        assert_eq!(draft.period, "2026-08");
        assert_eq!(draft.gross_cents, 500_000);
        assert_eq!(draft.net_cents, 468_000);
        assert_eq!(draft_totals(&draft.lines), (500_000, 32_000, 0));
    }

    #[test]
    fn ignores_printed_summary_rows_instead_of_counting_them_twice() {
        let lines = extract_payroll_lines(
            "Salaire mensuel 6'500.00\nAVS / AI / APG 344.50\nAssurance-chômage 71.50\nPart AVS employeur 344.50\nRetenues employé CHF 416.00\nCharges employeur CHF 344.50\nSalaire net CHF 6'084.00",
        );
        assert_eq!(draft_totals(&lines), (650_000, 41_600, 34_450));
        assert!(!lines
            .iter()
            .any(|line| line.label.to_lowercase().contains("retenues employ")));
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
        });
        assert!(validate_confirmable_draft(&draft).is_err());
    }
}
