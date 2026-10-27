//! Ouverture de Zentra (lot 5) : l'app publie une projection de lecture pour
//! l'API et MCP de l'entreprise, tire la boîte d'entrée des brouillons venus de
//! l'extérieur (API, MCP, Shopify, WooCommerce) et envoie une facture émise par
//! la poste avec le compte Pingen de l'entreprise.
//! Les montants publiés sont ceux calculés par l'app ; un brouillon ne devient
//! un document qu'après le clic d'une personne dans l'app.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use base64::Engine;
use futures_util::lock::Mutex;
use reqwest::Method;
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::{
    account_cloud::{project_sync_session, ProjectSyncSession},
    database::{now_iso, query_all, LocalStore},
    error::{command_error, AppError, AppResult},
};

pub(crate) const STATUS_PATH: &str = "/api/account/api/status";
pub(crate) const PROJECTION_PATH: &str = "/api/account/api/projection";
pub(crate) const INBOX_PATH: &str = "/api/account/inbox";
pub(crate) const INBOX_ACK_PATH: &str = "/api/account/inbox/ack";
pub(crate) const POSTAL_PATH: &str = "/api/account/postal/letters";
pub(crate) const INTEGRATIONS_PATH: &str = "/api/account/integrations/device";
pub(crate) const BACKGROUND_PATH: &str = "/api/account/automation/background";
pub(crate) const SCHEDULE_PATH: &str = "/api/account/automation/schedule";
pub(crate) const TASKS_PATH: &str = "/api/account/api/tasks";
const BACKGROUND_CONSENT_VERSION: &str = "autopilot-background-2026-10-26";
const INTEGRATION_ACTIONS: [&str; 10] = ["create-key", "revoke-key", "create-webhook", "delete-webhook", "resume-webhook", "test-webhook",
    "create-shop", "delete-shop", "save-postal", "delete-postal"];

const PAGE_OPERATIONS: usize = 300;
const PAGE_BYTES: usize = 700_000;
const MAX_PAGES_PER_RUN: usize = 20;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// Texte publié : sans caractère de contrôle (sauf saut de ligne et tabulation)
/// et borné à la longueur admise par le serveur.
fn clip(value: Option<&str>, max: usize) -> Value {
    match value.map(|text| text.chars().map(|c| if c.is_control() && !matches!(c, '\n' | '\r' | '\t') { ' ' } else { c }).take(max).collect::<String>()) {
        Some(text) if !text.trim().is_empty() => Value::String(text),
        _ => Value::Null,
    }
}

fn required(value: Option<&str>, max: usize, fallback: &str) -> Value {
    match clip(value, max) {
        Value::Null => Value::String(fallback.into()),
        text => text,
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

fn date(value: &Value) -> Value {
    match value.as_str() {
        Some(text) if text.len() >= 10 && text.is_char_boundary(10) && chrono::NaiveDate::parse_from_str(&text[..10], "%Y-%m-%d").is_ok() => Value::String(text[..10].to_owned()),
        _ => Value::Null,
    }
}

fn int(value: &Value) -> i64 {
    value.as_i64().or_else(|| value.as_f64().map(|v| v.round() as i64)).unwrap_or(0)
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn currency(row: &Value) -> Option<Value> {
    match text(row, "currency").map(str::to_uppercase).as_deref() {
        Some("CHF") => Some(json!("CHF")),
        Some("EUR") => Some(json!("EUR")),
        _ => None,
    }
}

/// Statuts stockés (souvent en français) vers les codes publics, comme dans l'app.
pub(crate) fn invoice_status(raw: &str) -> &'static str {
    match raw {
        "emise" | "en_retard" | "issued" => "issued",
        "partiellement_payee" | "partially_paid" => "partially_paid",
        "payee" | "paid" => "paid",
        "annulee" | "cancelled" => "cancelled",
        _ => "draft",
    }
}

pub(crate) fn quote_status(raw: &str) -> &'static str {
    match raw {
        "emis" | "issued" => "issued",
        "accepte" | "accepted" => "accepted",
        "refuse" | "refused" => "refused",
        "expire" | "expired" => "expired",
        "annulee" | "cancelled" => "cancelled",
        _ => "draft",
    }
}

pub(crate) fn order_status(raw: &str) -> &'static str {
    match raw {
        "confirmed" | "confirme" | "confirmee" | "partially_delivered" | "partiellement_livree" | "delivered" | "livree" => "confirmed",
        "closed" | "cloture" | "cloturee" => "closed",
        "cancelled" | "annule" | "annulee" => "cancelled",
        _ => "draft",
    }
}

fn code(raw: Option<&str>, fallback: &str) -> Value {
    match raw {
        Some(value) if !value.is_empty() && value.len() <= 32 && value.chars().next().is_some_and(|c| c.is_ascii_lowercase()) && value.chars().all(|c| c.is_ascii_lowercase() || c == '_') => json!(value),
        _ => json!(fallback),
    }
}

fn lines_by_parent(connection: &Connection, sql: &str, parent: &str) -> AppResult<BTreeMap<String, Vec<Value>>> {
    let mut map: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for row in query_all(connection, sql, [])? {
        let Some(owner) = text(&row, parent).map(str::to_owned) else { continue };
        let quantity_milli = if row.get("quantity_milli").is_some() { int(&row["quantity_milli"]) } else { (row["quantity"].as_f64().unwrap_or(0.0) * 1000.0).round() as i64 };
        let article = text(&row, "catalog_item_id").filter(|id| valid_id(id));
        let lines = map.entry(owner).or_default();
        if lines.len() >= 500 {
            continue;
        }
        lines.push(json!({
            "position": int(&row["position"]),
            "articleId": article,
            "description": required(text(&row, "description"), 2000, "—"),
            "quantityMilli": quantity_milli,
            "unit": clip(text(&row, "unit"), 32),
            "unitPriceCents": int(&row["unit_price_cents"]),
            "discountBp": int(&row["discount_bp"]),
            "vatBp": int(&row["vat_bp"]),
            "totalCents": int(&row["line_total_cents"]),
        }));
    }
    Ok(map)
}

/// Projection complète, enregistrement par enregistrement, dans la forme fermée
/// attendue par le serveur (`schemaVersion` 1).
pub(crate) fn export_projection(connection: &Connection) -> AppResult<BTreeMap<(String, String), Value>> {
    let mut out = BTreeMap::new();
    let mut put = |entity: &str, record: Value| {
        if let Some(id) = record["id"].as_str().filter(|id| valid_id(id)) {
            out.insert((entity.to_owned(), id.to_owned()), record);
        }
    };
    for row in query_all(connection, "SELECT * FROM clients", [])? {
        put("customers", json!({
            "id": row["id"], "number": Value::Null,
            "name": required(text(&row, "name"), 300, "—"),
            "company": clip(text(&row, "company"), 300), "contactPerson": clip(text(&row, "contact_person"), 300),
            "email": clip(text(&row, "email"), 254), "phone": clip(text(&row, "phone"), 64),
            "addressLine1": clip(text(&row, "address_line1"), 300), "addressLine2": clip(text(&row, "address_line2"), 300),
            "postalCode": clip(text(&row, "postal_code"), 32), "city": clip(text(&row, "city"), 120), "country": clip(text(&row, "country"), 64),
            "archived": !row["archived_at"].is_null(),
            "updatedAt": required(text(&row, "updated_at"), 40, "—"),
        }));
    }
    for row in query_all(connection, "SELECT * FROM catalog_items", [])? {
        put("articles", json!({
            "id": row["id"], "kind": code(text(&row, "kind"), "product"),
            "sku": clip(text(&row, "sku"), 80), "name": required(text(&row, "name"), 300, "—"),
            "description": clip(text(&row, "description"), 4000), "unit": clip(text(&row, "unit"), 32),
            "unitPriceCents": int(&row["sales_price_cents"]), "vatBp": int(&row["vat_bp"]),
            "trackStock": int(&row["track_stock"]) == 1,
            "stockQuantityMilli": if int(&row["track_stock"]) == 1 { json!(int(&row["stock_quantity_milli"])) } else { Value::Null },
            "archived": !row["archived_at"].is_null(),
            "updatedAt": required(text(&row, "updated_at"), 40, "—"),
        }));
    }
    let invoice_lines = lines_by_parent(connection, "SELECT * FROM invoice_items ORDER BY invoice_id,position,rowid", "invoice_id")?;
    let mut invoice_currency = BTreeMap::new();
    for row in query_all(connection, "SELECT * FROM invoices", [])? {
        let Some(money) = currency(&row) else { continue };
        let id = text(&row, "id").unwrap_or_default().to_owned();
        invoice_currency.insert(id.clone(), money.clone());
        let status = invoice_status(text(&row, "status").unwrap_or_default());
        let kind = text(&row, "type").unwrap_or("standard");
        let total = int(&row["total_cents"]);
        let paid = int(&row["paid_cents"]);
        let open = if matches!(status, "draft" | "cancelled") || kind == "avoir" { 0 } else { (total - paid).max(0) };
        put("invoices", json!({
            "id": &id, "number": clip(text(&row, "number"), 64),
            "customerId": text(&row, "client_id").filter(|v| valid_id(v)), "title": clip(text(&row, "title"), 300),
            "status": status, "currency": money, "type": code(Some(kind), "standard"),
            "issueDate": date(&row["issue_date"]), "dueDate": date(&row["due_date"]),
            "subtotalCents": int(&row["subtotal_cents"]), "discountCents": int(&row["discount_cents"]),
            "vatCents": int(&row["vat_cents"]), "totalCents": total, "paidCents": paid, "openCents": open,
            "lines": invoice_lines.get(&id).cloned().unwrap_or_default(),
            "updatedAt": required(text(&row, "updated_at"), 40, "—"),
        }));
    }
    let quote_lines = lines_by_parent(connection, "SELECT * FROM quote_items ORDER BY quote_id,position,rowid", "quote_id")?;
    for row in query_all(connection, "SELECT * FROM quotes", [])? {
        let Some(money) = currency(&row) else { continue };
        let id = text(&row, "id").unwrap_or_default().to_owned();
        put("quotes", json!({
            "id": &id, "number": clip(text(&row, "number"), 64),
            "customerId": text(&row, "client_id").filter(|v| valid_id(v)), "title": clip(text(&row, "title"), 300),
            "status": quote_status(text(&row, "status").unwrap_or_default()), "currency": money,
            "issueDate": date(&row["issue_date"]), "validUntil": date(&row["valid_until"]),
            "subtotalCents": int(&row["subtotal_cents"]), "discountCents": int(&row["discount_cents"]),
            "vatCents": int(&row["vat_cents"]), "totalCents": int(&row["total_cents"]),
            "lines": quote_lines.get(&id).cloned().unwrap_or_default(),
            "updatedAt": required(text(&row, "updated_at"), 40, "—"),
        }));
    }
    let order_lines = lines_by_parent(connection, "SELECT * FROM sales_order_lines ORDER BY sales_order_id,position,rowid", "sales_order_id")?;
    for row in query_all(connection, "SELECT * FROM sales_orders", [])? {
        let Some(money) = currency(&row) else { continue };
        let id = text(&row, "id").unwrap_or_default().to_owned();
        put("orders", json!({
            "id": &id, "number": clip(text(&row, "number"), 64),
            "customerId": text(&row, "client_id").filter(|v| valid_id(v)), "title": clip(text(&row, "title"), 300),
            "status": order_status(text(&row, "status").unwrap_or_default()), "currency": money,
            "orderDate": date(&row["order_date"]), "externalReference": Value::Null,
            "totalCents": int(&row["total_cents"]),
            "lines": order_lines.get(&id).cloned().unwrap_or_default(),
            "updatedAt": required(text(&row, "updated_at"), 40, "—"),
        }));
    }
    for row in query_all(connection, "SELECT * FROM payments", [])? {
        let invoice = text(&row, "invoice_id").unwrap_or_default();
        let (Some(money), Value::String(day)) = (invoice_currency.get(invoice).cloned(), date(&row["date"])) else { continue };
        if !valid_id(invoice) {
            continue;
        }
        put("payments", json!({
            "id": row["id"], "invoiceId": invoice, "date": day,
            "amountCents": int(&row["amount_cents"]), "currency": money,
            "method": clip(text(&row, "method"), 80), "reference": clip(text(&row, "reference"), 120),
            "updatedAt": required(text(&row, "updated_at"), 40, "—"),
        }));
    }
    Ok(out)
}

pub(crate) fn fingerprint(record: &Value) -> String {
    let bytes = serde_json::to_vec(record).unwrap_or_default();
    Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Debug, Default)]
pub(crate) struct ProjectionPlan {
    pub initial: bool,
    pub upserts: Vec<(String, String, String, Value)>,
    pub deletes: Vec<(String, String)>,
}

/// Différence entre la projection actuelle et ce que cet appareil a déjà publié.
pub(crate) fn plan_projection(connection: &Connection, reset: bool) -> AppResult<ProjectionPlan> {
    let current = export_projection(connection)?;
    let published: BTreeMap<(String, String), String> = if reset {
        BTreeMap::new()
    } else {
        query_all(connection, "SELECT entity,record_id,sha256 FROM company_local_api_projection", [])?
            .into_iter()
            .filter_map(|row| Some(((text(&row, "entity")?.to_owned(), text(&row, "record_id")?.to_owned()), text(&row, "sha256")?.to_owned())))
            .collect()
    };
    let mut plan = ProjectionPlan { initial: published.is_empty(), ..Default::default() };
    for ((entity, id), record) in current.iter() {
        let sha = fingerprint(record);
        if published.get(&(entity.clone(), id.clone())) != Some(&sha) {
            plan.upserts.push((entity.clone(), id.clone(), sha, record.clone()));
        }
    }
    let present: BTreeSet<&(String, String)> = current.keys().collect();
    for key in published.keys() {
        if !present.contains(key) {
            plan.deletes.push(key.clone());
        }
    }
    Ok(plan)
}

/// Découpe en pages bornées en nombre d'opérations et en octets.
pub(crate) fn pages(plan: &ProjectionPlan) -> Vec<(Vec<usize>, Vec<usize>)> {
    let mut out = Vec::new();
    let (mut upserts, mut deletes, mut bytes) = (Vec::new(), Vec::new(), 0usize);
    for (index, item) in plan.upserts.iter().enumerate() {
        let size = serde_json::to_vec(&item.3).map(|v| v.len()).unwrap_or(0) + 64;
        if !upserts.is_empty() && (upserts.len() >= PAGE_OPERATIONS || bytes + size > PAGE_BYTES) {
            out.push((std::mem::take(&mut upserts), Vec::new()));
            bytes = 0;
        }
        upserts.push(index);
        bytes += size;
    }
    for index in 0..plan.deletes.len() {
        if upserts.len() + deletes.len() >= PAGE_OPERATIONS {
            out.push((std::mem::take(&mut upserts), std::mem::take(&mut deletes)));
        }
        deletes.push(index);
    }
    if !upserts.is_empty() || !deletes.is_empty() {
        out.push((upserts, deletes));
    }
    out
}

fn publish_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

async fn blocking<T: Send + 'static>(task: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(task).await.map_err(|_| invalid("L'opération locale a été interrompue."))?
}

async fn session_for(store: &LocalStore, write: bool) -> AppResult<ProjectSyncSession> {
    let session = project_sync_session(store).await?.ok_or_else(|| invalid("Connectez votre compte dans les paramètres."))?;
    crate::automation::bound(store, &session.organization_id)?;
    if write && session.role == "read_only" {
        return Err(invalid("Votre rôle permet la consultation uniquement."));
    }
    Ok(session)
}

/// Réponse de compte du lot 5 : version 1 et même entreprise que la session.
fn checked_reply(bytes: &[u8], organization_id: &str) -> AppResult<Value> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid("Réponse du service Zentra illisible."))?;
    if value["schemaVersion"] != 1 || value["organizationId"] != organization_id {
        return Err(invalid("Réponse du service Zentra inattendue pour cette entreprise."));
    }
    Ok(value)
}

async fn post_json(session: &ProjectSyncSession, path: &str, body: &Value) -> AppResult<Value> {
    let (_, bytes) = session
        .request(Method::POST, path, &[], &[("Content-Type", "application/json".into())], Some(serde_json::to_vec(body)?), false)
        .await?;
    checked_reply(&bytes, &session.organization_id)
}

pub(crate) async fn publish(store: &LocalStore, reset: bool) -> AppResult<Value> {
    let _single = publish_lock().lock().await;
    let session = session_for(store, true).await?;
    let owned = store.clone();
    let plan = blocking(move || {
        let _guard = owned.lock()?;
        plan_projection(&owned.connect()?, reset)
    })
    .await?;
    let batches = pages(&plan);
    let (mut published, mut deleted, mut revision) = (0usize, 0usize, Value::Null);
    let mut first = true;
    for (upserts, deletes) in batches.iter().take(MAX_PAGES_PER_RUN) {
        let body = json!({
            "schemaVersion": 1,
            "reset": reset && first,
            "initial": plan.initial,
            "upserts": upserts.iter().map(|&i| json!({ "entity": plan.upserts[i].0, "record": plan.upserts[i].3 })).collect::<Vec<_>>(),
            "deletes": deletes.iter().map(|&i| json!({ "entity": plan.deletes[i].0, "id": plan.deletes[i].1 })).collect::<Vec<_>>(),
        });
        let reply = post_json(&session, PROJECTION_PATH, &body).await?;
        revision = reply["revision"].clone();
        let done_upserts: Vec<(String, String, String)> = upserts.iter().map(|&i| (plan.upserts[i].0.clone(), plan.upserts[i].1.clone(), plan.upserts[i].2.clone())).collect();
        let done_deletes: Vec<(String, String)> = deletes.iter().map(|&i| plan.deletes[i].clone()).collect();
        let clear = reset && first;
        let owned = store.clone();
        blocking(move || {
            let _guard = owned.lock()?;
            let mut connection = owned.connect()?;
            let tx = connection.transaction()?;
            if clear {
                tx.execute("DELETE FROM company_local_api_projection", [])?;
            }
            let now = now_iso();
            for (entity, id, sha) in &done_upserts {
                tx.execute(
                    "INSERT INTO company_local_api_projection(entity,record_id,sha256,published_at) VALUES(?,?,?,?) ON CONFLICT(entity,record_id) DO UPDATE SET sha256=excluded.sha256,published_at=excluded.published_at",
                    params![entity, id, sha, now],
                )?;
            }
            for (entity, id) in &done_deletes {
                tx.execute("DELETE FROM company_local_api_projection WHERE entity=? AND record_id=?", params![entity, id])?;
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
        published += upserts.len();
        deleted += deletes.len();
        first = false;
    }
    Ok(json!({ "published": published, "deleted": deleted, "remaining": batches.len().saturating_sub(MAX_PAGES_PER_RUN), "revision": revision }))
}

#[tauri::command]
pub async fn public_api_status(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    let session = session_for(&store, false).await.map_err(command_error)?;
    let value = crate::account_cloud::bound_inbox_get(&store, STATUS_PATH).await.map_err(command_error)?;
    checked_reply(&serde_json::to_vec(&value).unwrap_or_default(), &session.organization_id).map_err(command_error)
}

#[tauri::command]
pub async fn public_api_publish(state: State<'_, LocalStore>, reset: Option<bool>) -> Result<Value, String> {
    let store = state.inner().clone();
    publish(&store, reset.unwrap_or(false)).await.map_err(command_error)
}

#[tauri::command]
pub async fn public_api_inbox(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    let session = session_for(&store, false).await.map_err(command_error)?;
    let value = crate::account_cloud::bound_inbox_get(&store, INBOX_PATH).await.map_err(command_error)?;
    checked_reply(&serde_json::to_vec(&value).unwrap_or_default(), &session.organization_id).map_err(command_error)
}

#[tauri::command]
pub async fn public_api_inbox_decide(state: State<'_, LocalStore>, item_id: String, decision: String, reference: Option<String>) -> Result<Value, String> {
    let store = state.inner().clone();
    if !matches!(decision.as_str(), "imported" | "rejected") {
        return Err("Décision inconnue.".into());
    }
    let valid_item = item_id.len() == 39 && item_id.starts_with("in_") && uuid::Uuid::parse_str(&item_id[3..]).is_ok();
    if !valid_item {
        return Err("Brouillon inconnu.".into());
    }
    let reference = reference.map(|value| value.chars().take(80).collect::<String>()).filter(|value| !value.trim().is_empty());
    let session = session_for(&store, true).await.map_err(command_error)?;
    post_json(&session, INBOX_ACK_PATH, &json!({ "schemaVersion": 1, "itemId": item_id, "state": decision, "reference": reference }))
        .await
        .map_err(command_error)
}

/// Réglages « API, boutiques et courrier » de l'entreprise (titulaire et administrateurs).
#[tauri::command]
pub async fn integrations_overview(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    let session = session_for(&store, true).await.map_err(command_error)?;
    let (_, bytes) = session.request(Method::GET, INTEGRATIONS_PATH, &[], &[], None, false).await.map_err(command_error)?;
    checked_reply(&bytes, &session.organization_id).map_err(command_error)
}

/// Crée ou retire une clé API, un webhook, une boutique ou le compte Pingen. Les
/// jetons et secrets reviennent une seule fois, dans cette réponse.
#[tauri::command]
pub async fn integrations_action(state: State<'_, LocalStore>, input: Value) -> Result<Value, String> {
    let store = state.inner().clone();
    let mut body = match input { Value::Object(map) => map, _ => return Err("Réglage illisible.".into()) };
    let action = body.get("action").and_then(Value::as_str).unwrap_or_default().to_string();
    if !INTEGRATION_ACTIONS.contains(&action.as_str()) {
        return Err("Action inconnue.".into());
    }
    if serde_json::to_vec(&body).map(|v| v.len()).unwrap_or(usize::MAX) > 12_000 {
        return Err("Réglage trop long.".into());
    }
    body.insert("schemaVersion".into(), json!(1));
    let session = session_for(&store, true).await.map_err(command_error)?;
    post_json(&session, INTEGRATIONS_PATH, &Value::Object(body)).await.map_err(command_error)
}

/// État d'Autopilote quand les ordinateurs sont éteints, avec exactement ces clés.
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackgroundStatus {
    schema_version: u8,
    organization_id: String,
    consent_version: Option<String>,
    enabled: bool,
    granted_at: Option<u64>,
    expires_at: Option<u64>,
    last_run_at: Option<u64>,
    last_state: Option<String>,
    waiting: u32,
}

fn background_reply(bytes: &[u8], organization_id: &str) -> AppResult<Value> {
    let status: BackgroundStatus = serde_json::from_slice(bytes).map_err(|_| invalid("Réponse du service Zentra illisible."))?;
    let known = status.last_state.as_deref().is_none_or(|state| matches!(state, "idle" | "prepared" | "paused" | "renewal_needed" | "unavailable"));
    if status.schema_version != 1 || status.organization_id != organization_id || !known {
        return Err(invalid("Réponse du service Zentra illisible."));
    }
    Ok(serde_json::to_value(status)?)
}

/// Lit, active ou arrête Autopilote quand les ordinateurs sont éteints.
#[tauri::command]
pub async fn autopilot_background(state: State<'_, LocalStore>, operation: String) -> Result<Value, String> {
    let store = state.inner().clone();
    let body = match operation.as_str() {
        "status" => json!({ "schemaVersion": 1, "operation": "status" }),
        "enable" => json!({ "schemaVersion": 1, "operation": "enable", "consentVersion": BACKGROUND_CONSENT_VERSION }),
        "disable" => json!({ "schemaVersion": 1, "operation": "disable" }),
        _ => return Err("Action inconnue.".into()),
    };
    let session = session_for(&store, operation != "status").await.map_err(command_error)?;
    let (_, bytes) = session
        .request(Method::POST, BACKGROUND_PATH, &[], &[("Content-Type", "application/json".into())], Some(serde_json::to_vec(&body).map_err(|e| e.to_string())?), false)
        .await
        .map_err(command_error)?;
    background_reply(&bytes, &session.organization_id).map_err(command_error)
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduleItem {
    kind: String,
    id: String,
    due_on: String,
    party: String,
    reference: String,
    amount_cents: Option<i64>,
}

fn schedule_item_valid(item: &ScheduleItem) -> bool {
    let date = item.due_on.len() == 10 && item.due_on.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    let text = |value: &str, max: usize| value.chars().count() <= max && !value.chars().any(char::is_control);
    matches!(item.kind.as_str(), "invoice_overdue" | "quote_follow_up" | "supplier_due" | "vat_due")
        && (1..=80).contains(&item.id.len())
        && item.id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
        && date && text(&item.party, 80) && text(&item.reference, 40)
        && item.amount_cents.is_none_or(|cents| cents >= 0)
}

/// Remplace l'échéancier que le serveur rappelle sur le téléphone, ordinateurs éteints.
#[tauri::command]
pub async fn autopilot_schedule(state: State<'_, LocalStore>, items: Vec<Value>) -> Result<Value, String> {
    let store = state.inner().clone();
    if items.len() > 200 { return Err("Échéancier trop long.".into()); }
    let mut parsed = Vec::with_capacity(items.len());
    let mut ids = BTreeSet::new();
    for item in items {
        let item: ScheduleItem = serde_json::from_value(item).map_err(|_| "Échéancier illisible.".to_string())?;
        if !schedule_item_valid(&item) || !ids.insert(item.id.clone()) { return Err("Échéancier illisible.".into()); }
        parsed.push(item);
    }
    let session = session_for(&store, true).await.map_err(command_error)?;
    let reply = post_json(&session, SCHEDULE_PATH, &json!({ "schemaVersion": 1, "items": parsed })).await.map_err(command_error)?;
    let stored = reply.get("stored").and_then(Value::as_u64).ok_or_else(|| "Réponse du service Zentra illisible.".to_string())?;
    Ok(json!({ "stored": stored }))
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskAction {
    id: String,
    label: String,
}

/// Carte Autopilote lue par un assistant connecté (MCP), avec exactement ces clés.
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublishedTask {
    key: String,
    kind: String,
    title: String,
    detail: String,
    why: String,
    actions: Vec<TaskAction>,
    assistant_actions: Vec<String>,
}

fn task_valid(task: &PublishedTask) -> bool {
    let printable = |value: &str| (1..=160).contains(&value.len()) && value.bytes().all(|b| (0x21..=0x7e).contains(&b));
    let action_id = |value: &str| {
        (1..=40).contains(&value.len())
            && value.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
            && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    let text = |value: &str, max: usize| value.encode_utf16().count() <= max;
    printable(&task.key)
        && text(&task.kind, 60)
        && !task.title.trim().is_empty()
        && text(&task.title, 300)
        && text(&task.detail, 600)
        && text(&task.why, 600)
        && task.actions.len() <= 8
        && task.assistant_actions.len() <= 8
        && task.actions.iter().all(|action| action_id(&action.id) && !action.label.trim().is_empty() && text(&action.label, 80))
        && task.assistant_actions.iter().all(|id| task.actions.iter().any(|action| &action.id == id))
}

/// Remplace les tâches Autopilote que lit l'assistant connecté de l'entreprise.
/// Le serveur ne garde la liste que si l'API est ouverte et revérifie chaque clé.
#[tauri::command]
pub async fn public_api_tasks(state: State<'_, LocalStore>, items: Vec<Value>) -> Result<Value, String> {
    let store = state.inner().clone();
    if items.len() > 100 { return Err("Trop de tâches.".into()); }
    let mut parsed = Vec::with_capacity(items.len());
    let mut keys = BTreeSet::new();
    for item in items {
        let task: PublishedTask = serde_json::from_value(item).map_err(|_| "Tâches illisibles.".to_string())?;
        if !task_valid(&task) || !keys.insert(task.key.clone()) { return Err("Tâches illisibles.".into()); }
        parsed.push(task);
    }
    let session = session_for(&store, true).await.map_err(command_error)?;
    let reply = post_json(&session, TASKS_PATH, &json!({ "schemaVersion": 1, "items": parsed })).await.map_err(command_error)?;
    let stored = reply.get("stored").and_then(Value::as_u64).ok_or_else(|| "Réponse du service Zentra illisible.".to_string())?;
    Ok(json!({ "stored": stored }))
}

/// Envoie par la poste le PDF d'une facture émise (compte Pingen de l'entreprise).
#[tauri::command]
pub async fn postal_send_invoice(state: State<'_, LocalStore>, invoice_id: String, delivery: String, color: bool) -> Result<Value, String> {
    let store = state.inner().clone();
    if !matches!(delivery.as_str(), "economy" | "priority") {
        return Err("Choisissez Courrier B ou Courrier A.".into());
    }
    let session = session_for(&store, true).await.map_err(command_error)?;
    let owned = store.clone();
    let id = invoice_id.clone();
    let (number, pdf) = blocking(move || {
        let _guard = owned.lock()?;
        let connection = owned.connect()?;
        let (number, status, kind): (Option<String>, String, String) = connection.query_row("SELECT number,status,type FROM invoices WHERE id=?", [&id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        let number = number.filter(|value| !value.is_empty()).ok_or_else(|| invalid("Émettez d'abord la facture."))?;
        if matches!(status.as_str(), "brouillon" | "annulee") || kind == "avoir" {
            return Err(invalid("Seule une facture émise s'envoie par la poste."));
        }
        let pdf = owned.document_pdf_preview("invoices", &id)?;
        Ok((number, pdf))
    })
    .await
    .map_err(command_error)?;
    let mut body = Map::new();
    body.insert("schemaVersion".into(), json!(1));
    body.insert("documentId".into(), json!(invoice_id));
    body.insert("number".into(), json!(number));
    body.insert("pdfBase64".into(), json!(base64::engine::general_purpose::STANDARD.encode(pdf)));
    body.insert("delivery".into(), json!(delivery));
    body.insert("color".into(), json!(color));
    post_json(&session, POSTAL_PATH, &Value::Object(body)).await.map_err(command_error)
}

#[tauri::command]
pub async fn postal_letters(state: State<'_, LocalStore>, document_id: String) -> Result<Value, String> {
    let store = state.inner().clone();
    if !valid_id(&document_id) {
        return Err("Document inconnu.".into());
    }
    let session = session_for(&store, false).await.map_err(command_error)?;
    let (_, bytes) = session
        .request(Method::GET, POSTAL_PATH, &[("documentId", document_id.as_str())], &[], None, false)
        .await
        .map_err(command_error)?;
    checked_reply(&bytes, &session.organization_id).map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, LocalStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
        let now = now_iso();
        let connection = store.connect().unwrap();
        connection.execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'API test',?,?)", params![now, now]).unwrap();
        connection.execute("INSERT INTO clients(id,name,email,country,created_at,updated_at) VALUES('c1','Dupont SA','info@dupont.test','CH',?,?)", params![now, now]).unwrap();
        connection.execute("INSERT INTO invoices(id,client_id,number,title,status,issue_date,due_date,currency,subtotal_cents,vat_cents,total_cents,paid_cents,created_at,updated_at) VALUES('i1','c1','F-1','Pose','emise','2026-10-01','2026-10-31','CHF',10000,810,10810,810,?,?)", params![now, now]).unwrap();
        connection.execute("INSERT INTO invoices(id,client_id,title,status,currency,created_at,updated_at) VALUES('i2','c1','Brouillon','brouillon','CHF',?,?)", params![now, now]).unwrap();
        (dir, store)
    }

    #[test]
    fn exports_closed_records_with_app_amounts() {
        let (_dir, store) = store();
        let records = export_projection(&store.connect().unwrap()).unwrap();
        let invoice = &records[&("invoices".to_owned(), "i1".to_owned())];
        assert_eq!(invoice["status"], "issued");
        assert_eq!(invoice["openCents"], 10000);
        assert_eq!(invoice["issueDate"], "2026-10-01");
        assert_eq!(records[&("invoices".to_owned(), "i2".to_owned())]["openCents"], 0);
        let customer = &records[&("customers".to_owned(), "c1".to_owned())];
        assert_eq!(customer["archived"], false);
        assert_eq!(customer.as_object().unwrap().len(), 14);
    }

    #[test]
    fn plans_only_changes_after_a_publication() {
        let (_dir, store) = store();
        let connection = store.connect().unwrap();
        let plan = plan_projection(&connection, false).unwrap();
        assert!(plan.initial);
        assert_eq!(plan.upserts.len(), 3);
        for (entity, id, sha, _) in &plan.upserts {
            connection.execute("INSERT INTO company_local_api_projection VALUES(?,?,?,?)", params![entity, id, sha, now_iso()]).unwrap();
        }
        connection.execute("INSERT INTO company_local_api_projection VALUES('customers','gone',?,?)", params!["0".repeat(64), now_iso()]).unwrap();
        connection.execute("UPDATE clients SET phone='+41 22 000 00 00' WHERE id='c1'", []).unwrap();
        let next = plan_projection(&connection, false).unwrap();
        assert!(!next.initial);
        assert_eq!(next.upserts.iter().map(|u| u.1.as_str()).collect::<Vec<_>>(), vec!["c1"]);
        assert_eq!(next.deletes, vec![("customers".to_owned(), "gone".to_owned())]);
    }

    #[test]
    fn pages_respect_the_operation_bound() {
        let plan = ProjectionPlan {
            initial: true,
            upserts: (0..650).map(|i| ("customers".to_owned(), format!("c{i}"), String::new(), json!({"id": format!("c{i}")}))).collect(),
            deletes: vec![("customers".to_owned(), "x".to_owned())],
        };
        let batches = pages(&plan);
        assert_eq!(batches.iter().map(|(u, d)| u.len() + d.len()).sum::<usize>(), 651);
        assert!(batches.iter().all(|(u, d)| u.len() + d.len() <= PAGE_OPERATIONS));
    }

    #[test]
    fn maps_stored_statuses_like_the_app() {
        assert_eq!(invoice_status("partiellement_payee"), "partially_paid");
        assert_eq!(invoice_status("en_retard"), "issued");
        assert_eq!(quote_status("accepte"), "accepted");
        assert_eq!(order_status("livree"), "confirmed");
        assert_eq!(clip(Some("a\u{0}b"), 10), json!("a b"));
        assert!(!valid_id("-x"));
    }

    #[test]
    fn background_status_is_read_with_exact_keys_only() {
        let ok = br#"{"schemaVersion":1,"organizationId":"org_a","consentVersion":"autopilot-background-2026-10-26","enabled":true,"grantedAt":1,"expiresAt":2,"lastRunAt":null,"lastState":"renewal_needed","waiting":0}"#;
        assert_eq!(background_reply(ok, "org_a").unwrap()["lastState"], json!("renewal_needed"));
        assert!(background_reply(ok, "org_b").is_err());
        let extra = br#"{"schemaVersion":1,"organizationId":"org_a","consentVersion":null,"enabled":false,"grantedAt":null,"expiresAt":null,"lastRunAt":null,"lastState":null,"waiting":0,"device":"x"}"#;
        assert!(background_reply(extra, "org_a").is_err());
        let unknown = br#"{"schemaVersion":1,"organizationId":"org_a","consentVersion":null,"enabled":false,"grantedAt":null,"expiresAt":null,"lastRunAt":null,"lastState":"guess","waiting":0}"#;
        assert!(background_reply(unknown, "org_a").is_err());
    }

    #[test]
    fn schedule_items_keep_the_server_limits() {
        let item = |id: &str, due: &str, party: &str| ScheduleItem { kind: "invoice_overdue".into(), id: id.into(), due_on: due.into(), party: party.into(), reference: "F-1".into(), amount_cents: Some(100) };
        assert!(schedule_item_valid(&item("inv:i1", "2026-11-03", "Dupont SA")));
        assert!(!schedule_item_valid(&item("inv i1", "2026-11-03", "Dupont SA")));
        assert!(!schedule_item_valid(&item("inv:i1", "03.11.2026", "Dupont SA")));
        assert!(!schedule_item_valid(&item("inv:i1", "2026-11-03", "Dupont\nSA")));
        assert!(!schedule_item_valid(&item("inv:i1", "2026-11-03", &"x".repeat(81))));
    }

    #[test]
    fn published_tasks_keep_the_server_contract() {
        let task = |key: &str, assistant: &[&str]| PublishedTask {
            key: key.into(), kind: "Relance".into(), title: "Relance 1".into(), detail: "Dupont SA".into(), why: String::new(),
            actions: vec![TaskAction { id: "send".into(), label: "Envoyer".into() }, TaskAction { id: "postpone".into(), label: "Reporter".into() }],
            assistant_actions: assistant.iter().map(|id| id.to_string()).collect(),
        };
        assert!(task_valid(&task("reminder:r1", &["postpone"])));
        assert!(!task_valid(&task("reminder r1", &[])));
        assert!(!task_valid(&task("reminder:r1", &["pay"])));
        let extra = json!({ "key": "k", "kind": "", "title": "T", "detail": "", "why": "", "actions": [], "assistantActions": [], "more": 1 });
        assert!(serde_json::from_value::<PublishedTask>(extra).is_err());
    }
}
