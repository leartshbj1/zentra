//! Private, read-only Action Engine resources from one SQLite snapshot.
//! No connection, path, attachment, IPC, secret or network operation is opened
//! here. Publication/authentication remain the caller's responsibility.

use std::io::{self, Write};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

pub(crate) const MAX_RESOURCE_ROWS: usize = 5_000;
pub(crate) const MAX_SIDECAR_BYTES: usize = 4 * 1024 * 1024;
const MAX_UNIT_PRICE_CENTS: i64 = 1_000_000_000;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const SIDECAR_SCHEMA_VERSION: i64 = 62;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublishedCompany {
    pub(crate) country: String,
    pub(crate) currency: String,
    pub(crate) onboarding_complete: bool,
    pub(crate) vat_registered: bool,
    pub(crate) default_vat_bp: i64,
    pub(crate) payment_terms_days: i64,
    pub(crate) quote_validity_days: i64,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublishedCustomer {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) email: Option<String>,
    pub(crate) archived: bool,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublishedArticle {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) sku: Option<String>,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) unit: String,
    pub(crate) unit_price_cents: i64,
    pub(crate) tax_rate_bp: i64,
    pub(crate) archived: bool,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublishedResources {
    pub(crate) company: PublishedCompany,
    pub(crate) customers: Vec<PublishedCustomer>,
    pub(crate) articles: Vec<PublishedArticle>,
}

pub(crate) struct EncodedSidecar {
    pub(crate) bytes: Vec<u8>,
    pub(crate) sha256: String,
    pub(crate) resources_hash: String,
    pub(crate) customer_count: usize,
    pub(crate) article_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar<'a> {
    format: &'static str,
    version: u8,
    schema_version: i64,
    organization_id: &'a str,
    snapshot_id: &'a str,
    base_revision: i64,
    resources: &'a PublishedResources,
    resources_hash: &'a str,
}

fn invalid() -> AppError {
    AppError::Validation(
        "Le référentiel Automation ne peut pas être publié sans correction. Les données locales sont conservées."
            .into(),
    )
}

fn valid_text(value: &str, maximum: usize, required: bool) -> bool {
    value.encode_utf16().count() <= maximum
        && (!required || !value.trim_matches(javascript_whitespace).is_empty())
        && !value
            .chars()
            .any(|character| matches!(character, '\0' | '\u{000b}' | '\u{000c}' | '\u{007f}'))
}

// Match String.prototype.trim instead of Rust's slightly different Unicode
// White_Space property. Neither validation nor hashing rewrites stored text.
fn javascript_whitespace(character: char) -> bool {
    matches!(character,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn valid_email(value: &Option<String>) -> bool {
    let Some(value) = value else { return true };
    if !valid_text(value, 254, false) {
        return false;
    }
    if value.is_empty() {
        return true;
    }
    let value = value.trim_matches(javascript_whitespace);
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    if local.is_empty()
        || !local.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'.' | b'!'
                        | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'/'
                        | b'='
                        | b'?'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'{'
                        | b'|'
                        | b'}'
                        | b'~'
                        | b'-'
                )
        })
    {
        return false;
    }
    // Exact ASCII equivalent of the server codec's domain expression:
    // [A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}
    let Some((stem, suffix)) = domain.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && stem.as_bytes()[0].is_ascii_alphanumeric()
        && stem.as_bytes()[stem.len() - 1].is_ascii_alphanumeric()
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        && (2..=63).contains(&suffix.len())
        && suffix.bytes().all(|byte| byte.is_ascii_alphabetic())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, b'_' | b'.' | b':' | b'@' | b'-')
        })
}

fn valid_company(company: &PublishedCompany) -> bool {
    company.country == "CH"
        && company.currency == "CHF"
        && company.onboarding_complete
        && (0..=10_000).contains(&company.default_vat_bp)
        && (0..=365).contains(&company.payment_terms_days)
        && (0..=365).contains(&company.quote_validity_days)
        && valid_text(&company.updated_at, 128, true)
}

fn valid_customer(customer: &PublishedCustomer) -> bool {
    valid_id(&customer.id)
        && valid_text(&customer.name, 200, true)
        && valid_email(&customer.email)
        && valid_text(&customer.updated_at, 128, true)
}

fn valid_article(article: &PublishedArticle) -> bool {
    valid_id(&article.id)
        && matches!(article.kind.as_str(), "product" | "service")
        && !article
            .sku
            .as_ref()
            .is_some_and(|sku| !valid_text(sku, 100, false))
        && valid_text(&article.name, 200, true)
        && valid_text(&article.description, 1_000, false)
        && valid_text(&article.unit, 40, true)
        && (0..=MAX_UNIT_PRICE_CENTS).contains(&article.unit_price_cents)
        && (0..=10_000).contains(&article.tax_rate_bp)
        && valid_text(&article.updated_at, 128, true)
}

fn validate_resources(resources: &PublishedResources) -> AppResult<()> {
    if !valid_company(&resources.company)
        || resources.customers.len() > MAX_RESOURCE_ROWS
        || resources.articles.len() > MAX_RESOURCE_ROWS
    {
        return Err(invalid());
    }
    let mut previous: Option<&str> = None;
    for customer in &resources.customers {
        if !valid_customer(customer) || previous.is_some_and(|id| id >= customer.id.as_str()) {
            return Err(invalid());
        }
        previous = Some(&customer.id);
    }
    previous = None;
    for article in &resources.articles {
        if !valid_article(article) || previous.is_some_and(|id| id >= article.id.as_str()) {
            return Err(invalid());
        }
        previous = Some(&article.id);
    }
    Ok(())
}

/// A memory-only writer which refuses overflow instead of producing a truncated
/// JSON document. The returned buffer never exceeds the transport limit.
struct BoundedJson {
    bytes: Vec<u8>,
}

impl Write for BoundedJson {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.len() > MAX_SIDECAR_BYTES.saturating_sub(self.bytes.len()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Action resources exceed the publication limit",
            ));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn bounded_json(value: &impl Serialize) -> AppResult<Vec<u8>> {
    let mut writer = BoundedJson { bytes: Vec::new() };
    serde_json::to_writer(&mut writer, value).map_err(|_| invalid())?;
    Ok(writer.bytes)
}

fn boolean(value: i64) -> AppResult<bool> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(invalid()),
    }
}

fn read_resources(connection: &Connection) -> AppResult<PublishedResources> {
    // Explicit allowlists only: no notes, bank details, purchase prices, stock,
    // attachment paths or arbitrary extra_settings_json enter this projection.
    let company = connection
        .query_row(
            "SELECT country,currency,onboarding_completed,vat_registered,default_vat_bp,payment_terms_days,quote_validity_days,updated_at FROM settings WHERE id=1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?
        .ok_or(AppError::OnboardingRequired)?;
    let company = PublishedCompany {
        country: company.0,
        currency: company.1,
        onboarding_complete: boolean(company.2)?,
        vat_registered: boolean(company.3)?,
        default_vat_bp: company.4,
        payment_terms_days: company.5,
        quote_validity_days: company.6,
        updated_at: company.7,
    };
    if !valid_company(&company) {
        return Err(invalid());
    }

    let mut customers = Vec::new();
    let mut statement = connection.prepare(
        "SELECT id,name,email,archived_at IS NOT NULL,updated_at FROM clients ORDER BY id COLLATE BINARY LIMIT 5001",
    )?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        if customers.len() == MAX_RESOURCE_ROWS {
            return Err(invalid());
        }
        let customer = PublishedCustomer {
            id: row.get(0)?,
            name: row.get(1)?,
            email: row.get(2)?,
            archived: boolean(row.get(3)?)?,
            updated_at: row.get(4)?,
        };
        if !valid_customer(&customer) {
            return Err(invalid());
        }
        customers.push(customer);
    }

    let mut articles = Vec::new();
    let mut statement = connection.prepare(
        "SELECT id,kind,sku,name,description,unit,sales_price_cents,vat_bp,archived_at IS NOT NULL,updated_at FROM catalog_items ORDER BY id COLLATE BINARY LIMIT 5001",
    )?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        if articles.len() == MAX_RESOURCE_ROWS {
            return Err(invalid());
        }
        let article = PublishedArticle {
            id: row.get(0)?,
            kind: row.get(1)?,
            sku: row.get(2)?,
            name: row.get(3)?,
            description: row.get(4)?,
            unit: row.get(5)?,
            // FromSql<i64> refuses REAL rather than rounding/coercing it.
            unit_price_cents: row.get(6)?,
            tax_rate_bp: row.get(7)?,
            archived: boolean(row.get(8)?)?,
            updated_at: row.get(9)?,
        };
        if !valid_article(&article) {
            return Err(invalid());
        }
        articles.push(article);
    }
    let resources = PublishedResources {
        company,
        customers,
        articles,
    };
    validate_resources(&resources)?;
    bounded_json(&resources)?;
    Ok(resources)
}

/// Reuses a caller's transaction (including native receipt-first commits).
/// Otherwise begins one read snapshot on the SAME supplied connection so the
/// settings, customers and articles cannot originate from different revisions.
pub(crate) fn export_resources(connection: &Connection) -> AppResult<PublishedResources> {
    if connection.is_autocommit() {
        let transaction = connection.unchecked_transaction()?;
        let resources = read_resources(&transaction)?;
        transaction.commit()?;
        Ok(resources)
    } else {
        read_resources(connection)
    }
}

fn customer_tuple(customer: &PublishedCustomer) -> (&str, &str, &Option<String>, bool, &str) {
    (
        &customer.id,
        &customer.name,
        &customer.email,
        customer.archived,
        &customer.updated_at,
    )
}

fn article_tuple(
    article: &PublishedArticle,
) -> (
    &str,
    &str,
    &Option<String>,
    &str,
    &str,
    &str,
    i64,
    i64,
    bool,
    &str,
) {
    (
        &article.id,
        &article.kind,
        &article.sku,
        &article.name,
        &article.description,
        &article.unit,
        article.unit_price_cents,
        article.tax_rate_bp,
        article.archived,
        &article.updated_at,
    )
}

fn digest(value: &impl Serialize) -> String {
    // These closed primitive tuples cannot fail JSON serialization. No generic
    // user-supplied serializer is accepted by the public module functions.
    let bytes = serde_json::to_vec(value).expect("primitive resource tuples serialize");
    format!("{:x}", Sha256::digest(bytes))
}

/// Hashes validated resources using the TS/Rust fixed-position tuple contract,
/// not object-map order. Strings are preserved byte-for-byte (no normalization).
pub(crate) fn resource_hash(resources: &PublishedResources) -> String {
    let company = &resources.company;
    digest(&(
        1,
        (
            &company.country,
            &company.currency,
            company.onboarding_complete,
            company.vat_registered,
            company.default_vat_bp,
            company.payment_terms_days,
            company.quote_validity_days,
            &company.updated_at,
        ),
        resources
            .customers
            .iter()
            .map(customer_tuple)
            .collect::<Vec<_>>(),
        resources
            .articles
            .iter()
            .map(article_tuple)
            .collect::<Vec<_>>(),
    ))
}

pub(crate) fn customer_revision(customer: &PublishedCustomer) -> String {
    digest(&(
        "customer",
        &customer.id,
        &customer.name,
        &customer.email,
        customer.archived,
        &customer.updated_at,
    ))
}

pub(crate) fn article_revision(article: &PublishedArticle) -> String {
    digest(&(
        "article",
        &article.id,
        &article.kind,
        &article.sku,
        &article.name,
        &article.description,
        &article.unit,
        article.unit_price_cents,
        article.tax_rate_bp,
        article.archived,
        &article.updated_at,
    ))
}

pub(crate) fn encode_sidecar(
    resources: &PublishedResources,
    organization_id: &str,
    snapshot_id: &str,
    base_revision: i64,
) -> AppResult<EncodedSidecar> {
    validate_resources(resources)?;
    if !valid_id(organization_id)
        || !valid_id(snapshot_id)
        || !(0..=MAX_SAFE_INTEGER).contains(&base_revision)
    {
        return Err(invalid());
    }
    let resources_hash = resource_hash(resources);
    let envelope = Sidecar {
        format: "zentra-action-resources",
        version: 1,
        schema_version: SIDECAR_SCHEMA_VERSION,
        organization_id,
        snapshot_id,
        base_revision,
        resources,
        resources_hash: &resources_hash,
    };
    let bytes = bounded_json(&envelope)?;
    Ok(EncodedSidecar {
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        resources_hash,
        customer_count: resources.customers.len(),
        article_count: resources.articles.len(),
        bytes,
    })
}

#[cfg(test)]
#[path = "action_engine_resources_tests.rs"]
mod tests;
