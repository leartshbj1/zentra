use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppStateInfo {
    pub onboarding_completed: bool,
    pub data_dir: String,
    pub database_path: String,
    pub app_version: String,
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
