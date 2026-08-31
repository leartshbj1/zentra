use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppStateInfo {
    pub onboarding_completed: bool,
    pub activity_profile_required: bool,
    pub data_dir: String,
    pub database_path: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OnboardingIssue {
    pub step: u8,
    pub field: String,
    pub label: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OnboardingValidation {
    pub valid: bool,
    pub issues: Vec<OnboardingIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompleteOnboardingResult {
    pub app_state: AppStateInfo,
    pub workspace: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnboardingInput {
    pub company_name: String,
    #[serde(default)]
    pub legal_form: Option<String>,
    #[serde(default)]
    pub owner_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub address_line1: Option<String>,
    #[serde(default)]
    pub address_line2: Option<String>,
    #[serde(default)]
    pub postal_code: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub canton: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    pub noga_section: String,
    pub noga_division: String,
    pub activity_description: String,
    #[serde(default)]
    pub noga_detailed_code: Option<String>,
    #[serde(default)]
    pub uid_number: Option<String>,
    #[serde(default)]
    pub vat_number: Option<String>,
    #[serde(default)]
    pub vat_registered: bool,
    #[serde(default)]
    pub default_vat_bp: Option<i64>,
    #[serde(default)]
    pub iban: Option<String>,
    #[serde(default)]
    pub bank_name: Option<String>,
    #[serde(default = "default_currency")]
    pub currency: String,
    #[serde(default = "default_quote_prefix")]
    pub quote_prefix: String,
    #[serde(default = "default_invoice_prefix")]
    pub invoice_prefix: String,
    #[serde(default)]
    pub credit_note_prefix: Option<String>,
    #[serde(default)]
    pub quote_start_number: Option<i64>,
    #[serde(default)]
    pub invoice_start_number: Option<i64>,
    #[serde(default)]
    pub credit_note_start_number: Option<i64>,
    #[serde(default = "default_payment_terms_days")]
    pub payment_terms_days: i64,
    #[serde(default = "default_quote_validity_days")]
    pub quote_validity_days: i64,
    #[serde(default)]
    pub default_hourly_rate_cents: i64,
    #[serde(default)]
    pub logo_path: Option<String>,
    #[serde(default)]
    pub extra_settings_json: Option<Value>,
}

fn default_currency() -> String {
    "CHF".to_owned()
}

fn default_quote_prefix() -> String {
    "D".to_owned()
}

fn default_invoice_prefix() -> String {
    "F".to_owned()
}

fn default_payment_terms_days() -> i64 {
    30
}

fn default_quote_validity_days() -> i64 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimerInput {
    pub project_id: String,
    #[serde(default)]
    pub employee_id: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default = "default_true")]
    pub billable: bool,
    #[serde(default)]
    pub billing_rate_cents: i64,
    #[serde(default)]
    pub cost_rate_cents: i64,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordPaymentInput {
    pub invoice_id: String,
    pub amount_cents: i64,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeleteResult {
    pub deleted: bool,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub created_at: String,
    pub database_file: String,
    pub attachments_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportEnvelope {
    pub format: String,
    pub format_version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertQuoteInput {
    pub quote_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub issue_date: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub service_date_from: Option<String>,
    #[serde(default)]
    pub service_date_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInput {
    #[serde(default)]
    pub id: Option<String>,
    pub code: String,
    pub name: String,
    pub account_type: String,
    pub normal_balance: String,
    pub report_section: String,
    #[serde(default = "default_true")]
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountingSettingsInput {
    pub enabled: bool,
    #[serde(default)]
    pub ar_account_id: Option<String>,
    #[serde(default)]
    pub revenue_account_id: Option<String>,
    #[serde(default)]
    pub vat_payable_account_id: Option<String>,
    #[serde(default)]
    pub bank_account_id: Option<String>,
    #[serde(default)]
    pub expense_account_id: Option<String>,
    #[serde(default)]
    pub vat_receivable_account_id: Option<String>,
    #[serde(default)]
    pub wages_expense_account_id: Option<String>,
    #[serde(default)]
    pub wages_payable_account_id: Option<String>,
    #[serde(default)]
    pub social_expense_account_id: Option<String>,
    #[serde(default)]
    pub social_payable_account_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PeriodFilter {
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountingPeriodInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub date_from: String,
    pub date_to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerInput {
    pub account_id: String,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualJournalLineInput {
    pub account_id: String,
    #[serde(default)]
    pub debit_cents: i64,
    #[serde(default)]
    pub credit_cents: i64,
    #[serde(default)]
    pub memo: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub employee_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualJournalInput {
    pub entry_date: String,
    pub description: String,
    #[serde(default = "default_currency")]
    pub currency: String,
    pub lines: Vec<ManualJournalLineInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderSettingsInput {
    pub enabled: bool,
    #[serde(default)]
    pub sender_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderTemplateInput {
    #[serde(default)]
    pub id: Option<String>,
    pub level: i64,
    pub name: String,
    pub subject: String,
    pub body: String,
    pub days_after_due: i64,
    #[serde(default = "default_true")]
    pub active: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReminderFilter {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub invoice_id: Option<String>,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkReminderInput {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderActionInput {
    pub id: String,
    pub action: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContributionDefinitionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub code: String,
    pub label: String,
    pub category: String,
    pub side: String,
    pub calculation_kind: String,
    #[serde(default)]
    pub rate_bp: Option<i64>,
    #[serde(default)]
    pub fixed_amount_cents: Option<i64>,
    #[serde(default)]
    pub annual_ceiling_cents: Option<i64>,
    pub basis_kind: String,
    pub source: String,
    pub effective_from: String,
    #[serde(default)]
    pub effective_to: Option<String>,
    #[serde(default = "default_true")]
    pub active: bool,
    #[serde(default)]
    pub liability_account_id: Option<String>,
    #[serde(default)]
    pub expense_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContributionSelectionInput {
    pub definition_id: String,
    #[serde(default)]
    pub basis_cents: Option<i64>,
    #[serde(default)]
    pub year_to_date_basis_cents: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalculatePayrollInput {
    pub period: String,
    pub gross_cents: i64,
    pub items: Vec<ContributionSelectionInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyPayrollInput {
    pub payslip_id: String,
    pub period: String,
    pub items: Vec<ContributionSelectionInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayslipManualLineInput {
    #[serde(default)]
    pub id: Option<String>,
    pub label: String,
    pub kind: String,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavePayslipWithContributionsInput {
    #[serde(default)]
    pub id: Option<String>,
    pub employee_id: String,
    pub period: String,
    pub status: String,
    #[serde(default)]
    pub payment_date: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    pub lines: Vec<PayslipManualLineInput>,
    #[serde(default)]
    pub contributions: Vec<ContributionSelectionInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostPayslipInput {
    pub payslip_id: String,
    #[serde(default)]
    pub entry_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratePayslipPdfInput {
    pub payslip_id: String,
    pub destination_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PayrollImportEmployeeDraft {
    #[serde(default)]
    pub employee_number: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub address_line1: String,
    #[serde(default)]
    pub address_line2: String,
    #[serde(default)]
    pub postal_code: String,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub canton: String,
    #[serde(default)]
    pub birth_date: String,
    #[serde(default)]
    pub avs_number: String,
    #[serde(default)]
    pub iban: String,
    #[serde(default = "default_employment_rate")]
    pub employment_rate: i64,
    #[serde(default = "default_salary_mode")]
    pub salary_mode: String,
}

fn default_employment_rate() -> i64 {
    100
}

fn default_salary_mode() -> String {
    "monthly".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PayrollImportLineDraft {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub amount_cents: i64,
    #[serde(default)]
    pub recurring: bool,
    #[serde(default)]
    pub confidence_bp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PayrollImportDraft {
    #[serde(default)]
    pub employee: PayrollImportEmployeeDraft,
    #[serde(default)]
    pub period: String,
    #[serde(default)]
    pub payment_date: String,
    #[serde(default)]
    pub gross_cents: i64,
    #[serde(default)]
    pub net_cents: i64,
    #[serde(default)]
    pub lines: Vec<PayrollImportLineDraft>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StagePayrollDocumentsInput {
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePayrollImportDraftInput {
    pub id: String,
    pub draft: PayrollImportDraft,
    pub extraction_engine: String,
    #[serde(default)]
    pub engine_version: Option<String>,
    #[serde(default)]
    pub confidence_bp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmPayrollImportInput {
    pub id: String,
    #[serde(default)]
    pub employee_id: Option<String>,
    pub draft: PayrollImportDraft,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SwissQrParty {
    pub name: String,
    #[serde(default)]
    pub street: String,
    #[serde(default)]
    pub building_number: String,
    pub postal_code: String,
    pub city: String,
    pub country: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwissQrBillInput {
    pub iban: String,
    pub creditor: SwissQrParty,
    #[serde(default)]
    pub amount_cents: Option<i64>,
    pub currency: String,
    #[serde(default)]
    pub debtor: Option<SwissQrParty>,
    pub reference_type: String,
    #[serde(default)]
    pub reference: String,
    #[serde(default)]
    pub unstructured_message: String,
    #[serde(default)]
    pub bill_information: String,
    #[serde(default)]
    pub alternative_procedures: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveInvoiceQrBillInput {
    pub invoice_id: String,
    pub bill: SwissQrBillInput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveDocumentWithItemsInput {
    pub entity: String,
    #[serde(default)]
    pub id: Option<String>,
    pub data: Value,
    pub items: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwissQrValidation {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub normalized: SwissQrBillInput,
    pub is_qr_iban: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwissQrPayload {
    pub payload: String,
    pub lines: Vec<String>,
    pub reference_type: String,
    pub is_qr_iban: bool,
    pub character_count: usize,
    pub byte_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LicenseTokenPayload {
    pub token_version: u8,
    pub license_id: String,
    pub installation_id: String,
    pub jti: String,
    pub kid: String,
    #[serde(default)]
    pub customer_name: Option<String>,
    pub plan: String,
    pub price_chf_cents: i64,
    pub issued_at: String,
    pub valid_from: String,
    pub valid_until: String,
}
