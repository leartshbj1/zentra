//! Explicit, user-reviewed SMTP submission. Secrets never enter company snapshots.
//! SMTP acknowledgement is not a delivery receipt. Ambiguous attempts are never retried.
use crate::{
    database::{now_iso, row_to_json_public, LocalStore},
    error::{command_error, AppError, AppResult},
    installation::{
        read_protected_reference, remove_protected, unprotect_protected_reference,
        write_protected_atomically_with_reference_after_server_verification,
    },
    models::ReminderPreviewInput,
};
use base64::Engine;
use lettre::{
    message::{header::ContentType, Attachment, Mailbox, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
    Message, SmtpTransport, Transport,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::State;

static SENDING: AtomicBool = AtomicBool::new(false);
struct MailGuard;
impl MailGuard {
    fn take() -> AppResult<Self> {
        SENDING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| invalid("Un envoi ou une connexion est déjà en cours. Patientez."))?;
        Ok(Self)
    }
}
impl Drop for MailGuard {
    fn drop(&mut self) {
        SENDING.store(false, Ordering::Release);
    }
}
fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MailTemplate {
    pub subject: String,
    pub body: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MailTemplates {
    pub quotes: MailTemplate,
    pub invoices: MailTemplate,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MailSignature {
    #[serde(default)]
    pub include_company_logo: bool,
}
// Keep signature settings outside mailTemplates: older clients strictly decode that object.
fn signature(store: &LocalStore) -> AppResult<MailSignature> {
    let raw: String = store.connect()?.query_row(
        "SELECT COALESCE(extra_settings_json,'{}') FROM settings WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    let extra: Value = serde_json::from_str(&raw)?;
    if extra["mailSignature"].is_null() {
        Ok(MailSignature::default())
    } else {
        serde_json::from_value(extra["mailSignature"].clone()).map_err(Into::into)
    }
}
const LOGO_HELP: &str = "Ajoutez ou réimportez votre logo dans Paramètres → Entreprise, ou désactivez le logo dans les réglages des e-mails.";
struct MailLogo {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}
impl MailLogo {
    fn data_url(&self) -> String {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&self.bytes)
        )
    }
}
fn company_mail_logo(store: &LocalStore) -> AppResult<Option<MailLogo>> {
    let path: Option<String> =
        store
            .connect()?
            .query_row("SELECT logo_path FROM settings WHERE id=1", [], |r| {
                r.get(0)
            })?;
    let Some(path) = path.filter(|p| !p.trim().is_empty()) else {
        return Ok(None);
    };
    // Only the active company's managed, hash-verified logo can be attached. No remote image requests.
    let url = store
        .company_logo_preview(&path)
        .map_err(|_| invalid(LOGO_HELP))?;
    let (_, encoded) = url.split_once(',').ok_or_else(|| invalid(LOGO_HELP))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid(LOGO_HELP))?;
    let image = image::load_from_memory(&bytes)
        .map_err(|_| invalid(LOGO_HELP))?
        .thumbnail(360, 120);
    let scale = (image.width() as f64 / 180.0)
        .max(image.height() as f64 / 60.0)
        .max(1.0);
    let (width, height) = (
        (image.width() as f64 / scale).round() as u32,
        (image.height() as f64 / scale).round() as u32,
    );
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|_| invalid(LOGO_HELP))?;
    Ok(Some(MailLogo {
        bytes: png.into_inner(),
        width: width.max(1),
        height: height.max(1),
    }))
}
fn selected_mail_logo(store: &LocalStore) -> AppResult<Option<MailLogo>> {
    if !signature(store)?.include_company_logo {
        return Ok(None);
    }
    company_mail_logo(store)?
        .map(Some)
        .ok_or_else(|| invalid(LOGO_HELP))
}
impl Default for MailTemplates {
    fn default() -> Self {
        Self {
        quotes: MailTemplate { subject:"Votre devis {numero} — {entreprise}".into(), body:"Bonjour {client},\n\nVous trouverez en pièce jointe notre devis {numero}, d’un montant de {montant}. Il est valable jusqu’au {echeance}.\n\nNous restons à votre disposition pour toute question.\n\nAvec nos meilleures salutations,\n{entreprise}\n{email_entreprise}\n{telephone}".into() },
        invoices: MailTemplate { subject:"Votre facture {numero} — {entreprise}".into(), body:"Bonjour {client},\n\nVous trouverez en pièce jointe notre facture {numero}, d’un montant de {montant}, payable jusqu’au {echeance}.\n\nNous vous remercions de votre confiance.\n\nAvec nos meilleures salutations,\n{entreprise}\n{email_entreprise}\n{telephone}".into() }
    }
    }
}
const VARIABLES: &[&str] = &[
    "entreprise",
    "client",
    "numero",
    "montant",
    "solde",
    "echeance",
    "date",
    "email_entreprise",
    "telephone",
];
fn render(template: &str, context: &BTreeMap<String, String>) -> AppResult<String> {
    // One pass: braces occurring in a client's name can never become a second variable.
    let mut result = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        result.push_str(&rest[..start]);
        let tail = &rest[start + 1..];
        let end = tail
            .find('}')
            .ok_or_else(|| invalid("Fermez chaque variable avec }, par exemple {entreprise}."))?;
        let key = &tail[..end];
        if !VARIABLES.contains(&key) {
            return Err(invalid(&format!(
                "Variable inconnue : {{{key}}}. Utilisez les variables proposées."
            )));
        }
        result.push_str(context.get(key).map(String::as_str).unwrap_or(""));
        rest = &tail[end + 1..];
    }
    result.push_str(rest);
    Ok(result)
}
fn validate_message(subject: &str, body: &str) -> AppResult<()> {
    if subject.trim().is_empty()
        || subject.chars().count() > 250
        || subject.contains(['\r', '\n', '\0'])
    {
        return Err(invalid(
            "Indiquez un objet de 1 à 250 caractères, sur une seule ligne.",
        ));
    }
    if body.trim().is_empty() || body.len() > 24_000 || body.contains('\0') {
        return Err(invalid(
            "Le message doit contenir du texte et rester sous 24 000 caractères.",
        ));
    }
    Ok(())
}
fn address(value: &str) -> AppResult<lettre::Address> {
    if value.len() > 254 || value.contains(['\r', '\n', '\0', ',', ';', '<', '>']) {
        return Err(invalid("Indiquez une seule adresse e-mail valide."));
    }
    value
        .trim()
        .parse()
        .map_err(|_| invalid("Vérifiez l’adresse e-mail : par exemple contact@entreprise.ch."))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MailConnection {
    pub host: String,
    pub port: u16,
    pub security: String,
    pub username: String,
    pub from_email: String,
    pub from_name: String,
    pub password: String,
}
impl MailConnection {
    fn validate(&self) -> AppResult<()> {
        if self.host.is_empty()
            || self.host.len() > 253
            || !self.host.contains('.')
            || !self
                .host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        {
            return Err(invalid(
                "Indiquez le nom du serveur SMTP, sans https:// ni chemin.",
            ));
        }
        if !matches!(self.security.as_str(), "tls" | "starttls") || self.port == 0 {
            return Err(invalid(
                "Choisissez une connexion chiffrée TLS ou STARTTLS et un port valide.",
            ));
        }
        address(&self.from_email)?;
        if self.from_name.trim().is_empty()
            || self.from_name.len() > 200
            || self.from_name.contains(['\r', '\n', '\0'])
        {
            return Err(invalid(
                "Renseignez le nom de l’expéditeur, sur une seule ligne.",
            ));
        }
        if self.username.trim().is_empty()
            || self.username.len() > 320
            || self.username.contains(['\r', '\n', '\0'])
            || self.password.is_empty()
            || self.password.len() > 4096
        {
            return Err(invalid(
                "Renseignez l’identifiant SMTP et le mot de passe de la boîte mail.",
            ));
        }
        Ok(())
    }
    fn transport(&self) -> AppResult<SmtpTransport> {
        self.validate()?;
        let builder = if self.security == "tls" {
            SmtpTransport::relay(&self.host)
        } else {
            SmtpTransport::starttls_relay(&self.host)
        }
        .map_err(|_| invalid("Le serveur SMTP ou son certificat TLS est invalide."))?;
        Ok(builder
            .port(self.port)
            .credentials(Credentials::new(
                self.username.clone(),
                self.password.clone(),
            ))
            .timeout(Some(Duration::from_secs(20)))
            .build())
    }
    fn public(&self) -> Value {
        json!({"host":self.host,"port":self.port,"security":self.security,"username":self.username,"fromEmail":self.from_email,"fromName":self.from_name,"connected":true})
    }
}
fn connection_error(error: &lettre::transport::smtp::Error) -> AppError {
    // Never display raw provider replies: they may echo credentials or personal data.
    invalid(if error.is_permanent() {
        "Le serveur refuse la connexion. Vérifiez le mot de passe propre à la boîte mail et l’autorisation SMTP chez votre fournisseur."
    } else {
        "Connexion à la messagerie impossible. Vérifiez le serveur, le port, le chiffrement et votre accès à Internet, puis réessayez."
    })
}
fn scope(store: &LocalStore) -> AppResult<String> {
    let db = store.connect()?;
    store.require_onboarding(&db)?;
    // creation timestamp travels with the company; an organization change cannot reuse its secret.
    let created: String = db.query_row("SELECT created_at FROM settings WHERE id=1", [], |r| {
        r.get(0)
    })?;
    let org: Option<String> = db
        .query_row(
            "SELECT organization_id FROM company_local_identity WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(hash(
        format!("{created}\n{}", org.unwrap_or_default()).as_bytes(),
    ))
}
fn check_scope(store: &LocalStore, expected: &str) -> AppResult<()> {
    if scope(store)? != expected {
        return Err(invalid(
            "L’entreprise a changé. Fermez cette fenêtre et rouvrez l’e-mail depuis le bon espace.",
        ));
    }
    Ok(())
}
fn folder(store: &LocalStore, key: &str) -> PathBuf {
    store.data_dir.join("outgoing-mail").join(key)
}
fn secret_path(store: &LocalStore, key: &str) -> PathBuf {
    folder(store, key).join("connection.protected")
}
fn read_connection(store: &LocalStore, key: &str) -> AppResult<MailConnection> {
    let path = secret_path(store, key);
    if !path.is_file() {
        return Err(invalid(
            "Connectez votre messagerie dans Paramètres → E-mails, sur cet appareil.",
        ));
    }
    serde_json::from_slice(&unprotect_protected_reference(&read_protected_reference(
        &path,
    )?)?)
    .map_err(Into::into)
}
fn templates(store: &LocalStore) -> AppResult<MailTemplates> {
    let extra: String = store.connect()?.query_row(
        "SELECT COALESCE(extra_settings_json,'{}') FROM settings WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    let value: Value = serde_json::from_str(&extra)?;
    if value["mailTemplates"].is_null() {
        Ok(MailTemplates::default())
    } else {
        serde_json::from_value(value["mailTemplates"].clone()).map_err(Into::into)
    }
}
fn require_admin(store: &LocalStore) -> AppResult<()> {
    store.require_write_access()?;
    let role: Option<String> = store
        .connect()?
        .query_row(
            "SELECT role FROM company_local_identity WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if role.is_some_and(|r| !matches!(r.as_str(), "owner" | "admin")) {
        return Err(invalid(
            "Demandez au propriétaire ou à un administrateur de configurer la messagerie.",
        ));
    }
    Ok(())
}
fn require_sender(store: &LocalStore) -> AppResult<()> {
    store.require_write_access()?;
    let role: Option<String> = store
        .connect()?
        .query_row(
            "SELECT role FROM company_local_identity WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if role.is_some_and(|r| !matches!(r.as_str(), "owner" | "admin" | "accountant" | "member")) {
        return Err(invalid("Votre rôle permet la consultation uniquement. Demandez à un collaborateur autorisé d’envoyer ce document."));
    }
    Ok(())
}
fn history_db(store: &LocalStore, key: &str) -> AppResult<Connection> {
    std::fs::create_dir_all(folder(store, key))?;
    let db = Connection::open(folder(store, key).join("submissions.sqlite3"))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS submissions(request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, entity TEXT NOT NULL, document_id TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, message_id TEXT NOT NULL, payload_json TEXT NOT NULL);")?;
    Ok(db)
}
impl LocalStore {
    pub fn outgoing_mail_state(&self) -> AppResult<Value> {
        let key = scope(self)?;
        let connection = if secret_path(self, &key).is_file() {
            read_connection(self, &key)?.public()
        } else {
            let company: Value = self.connect()?.query_row(
                "SELECT company_name,email FROM settings WHERE id=1",
                [],
                row_to_json_public,
            )?;
            json!({"connected":false,"fromName":text(&company,"company_name"),"fromEmail":text(&company,"email"),"username":text(&company,"email")})
        };
        let (logo, logo_error) = match company_mail_logo(self) {
            Ok(logo) => (logo.map(|l| l.data_url()), None),
            Err(_) => (None, Some(LOGO_HELP)),
        };
        Ok(
            json!({"scope":key,"connection":connection,"templates":templates(self)?,"signature":signature(self)?,"companyLogoDataUrl":logo,"companyLogoError":logo_error,"canConfigure":require_admin(self).is_ok()}),
        )
    }
    pub fn save_mail_templates(
        &self,
        key: &str,
        input: MailTemplates,
        signature: Option<MailSignature>,
    ) -> AppResult<()> {
        check_scope(self, key)?;
        require_admin(self)?;
        for template in [&input.quotes, &input.invoices] {
            validate_message(&template.subject, &template.body)?;
            render(&template.subject, &BTreeMap::new())?;
            render(&template.body, &BTreeMap::new())?;
        }
        if signature.as_ref().is_some_and(|s| s.include_company_logo)
            && company_mail_logo(self)?.is_none()
        {
            return Err(invalid(LOGO_HELP));
        }
        let mut db = self.connect()?;
        let tx = db.transaction()?;
        let raw: String = tx.query_row(
            "SELECT COALESCE(extra_settings_json,'{}') FROM settings WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        let mut extra: Value = serde_json::from_str(&raw)?;
        extra["mailTemplates"] = serde_json::to_value(input)?;
        if let Some(signature) = signature {
            extra["mailSignature"] = serde_json::to_value(signature)?;
        }
        tx.execute(
            "UPDATE settings SET extra_settings_json=?,updated_at=? WHERE id=1",
            params![extra.to_string(), now_iso()],
        )?;
        crate::audit::append_audit(
            &tx,
            "configure",
            "mail_templates",
            "1",
            &json!({"updated":true}),
        )?;
        tx.commit()?;
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MailTarget {
    pub entity: String,
    pub id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendMailInput {
    pub request_id: String,
    pub scope: String,
    pub target: MailTarget,
    pub source_revision: String,
    pub recipient: String,
    pub subject: String,
    pub body: String,
}
fn money(cents: i64, currency: &str) -> String {
    format!("{}.{:02} {currency}", cents / 100, cents.abs() % 100)
}
fn display_date(date: &str) -> String {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|d| d.format("%d.%m.%Y").to_string())
        .unwrap_or_else(|_| date.into())
}
pub(crate) fn preview(store: &LocalStore, target: &MailTarget) -> AppResult<Value> {
    let key = scope(store)?;
    let db = store.connect()?;
    let reminder = if target.entity == "reminders" {
        Some(store.preview_reminder_delivery(ReminderPreviewInput {
            id: target.id.clone(),
            prepared_on: None,
        })?)
    } else {
        None
    };
    let entity = if reminder.is_some() {
        "invoices"
    } else {
        target.entity.as_str()
    };
    if !matches!(entity, "quotes" | "invoices") {
        return Err(invalid("Choisissez un devis, une facture ou une relance."));
    }
    let id = reminder
        .as_ref()
        .map(|r| text(r, "invoice_id"))
        .unwrap_or_else(|| target.id.clone());
    let doc: Value = db
        .query_row(
            &format!("SELECT * FROM {entity} WHERE id=?"),
            params![id],
            row_to_json_public,
        )
        .optional()?
        .ok_or_else(|| invalid("Ce document n’existe plus. Actualisez la liste."))?;
    if text(&doc, "number").is_empty()
        || matches!(
            text(&doc, "status").as_str(),
            "draft" | "cancelled" | "annulee"
        )
    {
        return Err(invalid(
            "Émettez d’abord le document. Seul un devis ou une facture numéroté peut être envoyé.",
        ));
    }
    let customer: Value = db.query_row(
        "SELECT * FROM clients WHERE id=?",
        params![text(&doc, "client_id")],
        row_to_json_public,
    )?;
    let company: Value =
        db.query_row("SELECT * FROM settings WHERE id=1", [], row_to_json_public)?;
    let credits: i64 = if entity == "invoices" {
        db.query_row("SELECT COALESCE(SUM(-amount_cents),0) FROM customer_invoice_credit_movements WHERE invoice_id=?",params![id],|r|r.get(0))?
    } else {
        0
    };
    let mut vars = BTreeMap::new();
    for (name, value) in [
        ("entreprise", text(&company, "company_name")),
        (
            "client",
            if text(&customer, "company").trim().is_empty() {
                text(&customer, "name")
            } else {
                text(&customer, "company")
            },
        ),
        ("numero", text(&doc, "number")),
        (
            "montant",
            money(
                doc["total_cents"].as_i64().unwrap_or(0),
                &text(&doc, "currency"),
            ),
        ),
        (
            "solde",
            money(
                doc["total_cents"].as_i64().unwrap_or(0) - doc["paid_cents"].as_i64().unwrap_or(0)
                    + credits,
                &text(&doc, "currency"),
            ),
        ),
        (
            "echeance",
            display_date(&text(
                &doc,
                if entity == "quotes" {
                    "valid_until"
                } else {
                    "due_date"
                },
            )),
        ),
        ("date", display_date(&text(&doc, "issue_date"))),
        ("email_entreprise", text(&company, "email")),
        ("telephone", text(&company, "phone")),
    ] {
        vars.insert(name.to_owned(), value);
    }
    let all = templates(store)?;
    let (logo, logo_error) = match selected_mail_logo(store) {
        Ok(logo) => (logo.map(|l| l.data_url()), None),
        Err(_) => (None, Some(LOGO_HELP)),
    };
    let template = if entity == "quotes" {
        all.quotes
    } else {
        all.invoices
    };
    let (subject, body) = if let Some(ref r) = reminder {
        (text(r, "subject"), text(r, "body"))
    } else {
        (
            render(&template.subject, &vars)?,
            render(&template.body, &vars)?,
        )
    };
    // Changes to balances, document snapshot, recipient or company invalidate an open composer.
    let revision = hash(
        serde_json::to_string(&json!([key, doc, customer, company, reminder, credits]))?.as_bytes(),
    );
    let history=crate::database::query_all(&history_db(store,&key)?,"SELECT recipient,subject,status,created_at AS createdAt FROM submissions WHERE entity=? AND document_id=? ORDER BY created_at DESC LIMIT 5",params![target.entity,target.id])?;
    Ok(
        json!({"scope":key,"target":target,"sourceRevision":revision,"recipient":text(&customer,"email"),"subject":subject,"body":body,"signatureLogoDataUrl":logo,"signatureLogoError":logo_error,"attachmentName":format!("{}-{}.pdf",if entity=="quotes"{"Devis"}else{"Facture"},text(&doc,"number")),"documentEntity":entity,"documentId":id,"history":history}),
    )
}
fn signature_html(body: &str, logo: &MailLogo) -> String {
    let escaped = body
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "<br>\n");
    format!("<!doctype html><html><body><div style=\"font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#202924\">{escaped}</div><div style=\"margin-top:20px\"><img src=\"cid:company-logo@zentra.local\" alt=\"Logo de l’entreprise\" width=\"{}\" height=\"{}\" style=\"display:block;border:0;max-width:100%;height:auto\"></div></body></html>",logo.width,logo.height)
}
fn build_message(
    connection: &MailConnection,
    input: &SendMailInput,
    pdf: Vec<u8>,
    filename: &str,
    message_id: &str,
    logo: Option<&MailLogo>,
) -> AppResult<Message> {
    validate_message(&input.subject, &input.body)?;
    if pdf.len() > 15 * 1024 * 1024 || !pdf.starts_with(b"%PDF-") {
        return Err(invalid(
            "Le PDF est invalide ou dépasse 15 Mo. Vérifiez le document avant de l’envoyer.",
        ));
    }
    let content = if let Some(logo) = logo {
        let html = signature_html(&input.body, logo);
        MultiPart::mixed().multipart(
            MultiPart::alternative()
                .singlepart(SinglePart::plain(input.body.clone()))
                .multipart(
                    MultiPart::related()
                        .singlepart(SinglePart::html(html))
                        .singlepart(
                            Attachment::new_inline("company-logo@zentra.local".into())
                                .body(logo.bytes.clone(), ContentType::parse("image/png").unwrap()),
                        ),
                ),
        )
    } else {
        MultiPart::mixed().singlepart(SinglePart::plain(input.body.clone()))
    };
    Message::builder()
        .from(Mailbox::new(
            Some(connection.from_name.clone()),
            address(&connection.from_email)?,
        ))
        .to(Mailbox::new(None, address(&input.recipient)?))
        .reply_to(Mailbox::new(None, address(&connection.from_email)?))
        .subject(&input.subject)
        .message_id(Some(message_id.to_owned()))
        .multipart(
            content.singlepart(
                Attachment::new(filename.to_owned())
                    .body(pdf, ContentType::parse("application/pdf").unwrap()),
            ),
        )
        .map_err(|_| invalid("Le message contient une adresse ou un en-tête invalide."))
}
#[derive(Clone, Copy)]
enum SubmissionFailure {
    Rejected,
    Uncertain,
}
fn send(store: &LocalStore, input: SendMailInput) -> AppResult<Value> {
    send_using(store, input, |transport, message| {
        transport.send(message).map(|_| ()).map_err(|error| {
            if error.is_permanent() || error.is_transient() {
                SubmissionFailure::Rejected
            } else {
                SubmissionFailure::Uncertain
            }
        })
    })
}
fn send_using(
    store: &LocalStore,
    input: SendMailInput,
    submit: impl FnOnce(&SmtpTransport, &Message) -> Result<(), SubmissionFailure>,
) -> AppResult<Value> {
    let _mail = MailGuard::take()?;
    uuid::Uuid::parse_str(&input.request_id)
        .map_err(|_| invalid("Rouvrez l’e-mail pour préparer un nouvel envoi."))?;
    address(&input.recipient)?;
    validate_message(&input.subject, &input.body)?;
    let payload_hash = hash(&serde_json::to_vec(&input)?);
    let (transport, message) = {
        let _local = store.lock()?;
        check_scope(store, &input.scope)?;
        require_sender(store)?;
        let db = history_db(store, &input.scope)?;
        let previous: Option<(String, String)> = db
            .query_row(
                "SELECT payload_hash,status FROM submissions WHERE request_id=?",
                params![input.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((old, status)) = previous {
            if old != payload_hash {
                return Err(invalid("Cette tentative existe déjà. Fermez puis rouvrez le message avant de préparer un autre envoi."));
            }
            if status == "accepted" {
                let recorded = record_receipt(store, &input).is_ok();
                return Ok(json!({"status":"accepted","replayed":true,"historyWarning":!recorded}));
            }
            return Err(invalid("L’envoi précédent n’a pas de confirmation certaine. Vérifiez auprès du destinataire ou de votre messagerie avant de préparer un nouvel envoi : réessayer pourrait créer un doublon."));
        }
        let current = preview(store, &input.target)?;
        if text(&current, "sourceRevision") != input.source_revision {
            return Err(invalid("Le document ou son solde a changé. Fermez puis rouvrez l’e-mail pour utiliser les informations à jour."));
        }
        let connection = read_connection(store, &input.scope)?;
        let logo = selected_mail_logo(store)?;
        let pdf = store.document_pdf_preview(
            &text(&current, "documentEntity"),
            &text(&current, "documentId"),
        )?;
        let message_id = format!(
            "<{}@{}>",
            input.request_id,
            connection
                .from_email
                .split('@')
                .next_back()
                .unwrap_or("zentra.local")
        );
        let pdf_sha256 = hash(&pdf);
        let reminder = if input.target.entity == "reminders" {
            Some(store.preview_reminder_delivery(ReminderPreviewInput {
                id: input.target.id.clone(),
                prepared_on: None,
            })?)
        } else {
            None
        };
        let payload = json!({"schema":"zentra.smtp_submission.v1","request_id":input.request_id,"channel":"smtp","recipient":input.recipient,"subject":input.subject,"body":input.body,"from_email":connection.from_email,"from_name":connection.from_name,"attachment_name":current["attachmentName"],"attachment_sha256":pdf_sha256,"reminder":reminder,"message_id":message_id});
        let message = build_message(
            &connection,
            &input,
            pdf,
            &text(&current, "attachmentName"),
            &message_id,
            logo.as_ref(),
        )?;
        let transport = connection.transport()?;
        db.execute(
            "INSERT INTO submissions VALUES(?,?,?,?,?,?,'pending',?,?,?)",
            params![
                input.request_id,
                payload_hash,
                input.target.entity,
                input.target.id,
                input.recipient,
                input.subject,
                now_iso(),
                message_id,
                payload.to_string()
            ],
        )?;
        (transport, message)
    };
    // Network I/O never holds the company lock or the GUI thread.
    let result = submit(&transport, &message);
    let status = match result {
        Ok(()) => "accepted",
        Err(SubmissionFailure::Rejected) => "rejected",
        Err(SubmissionFailure::Uncertain) => "uncertain",
    };
    let persisted = history_db(store, &input.scope)
        .and_then(|db| {
            Ok(db.execute(
                "UPDATE submissions SET status=? WHERE request_id=?",
                params![status, input.request_id],
            )?)
        })
        .is_ok();
    if result.is_err() {
        return Err(invalid(if status == "rejected" {
            "Le serveur a refusé l’e-mail. Vérifiez le destinataire, l’expéditeur autorisé et les réglages de votre messagerie avant de préparer un nouvel envoi."
        } else {
            "La connexion a été interrompue. L’e-mail a peut-être été envoyé : vérifiez auprès du destinataire avant de préparer un nouvel envoi. Aucun renvoi automatique n’aura lieu."
        }));
    }
    let _local = store.lock()?;
    let recorded = record_receipt(store, &input).is_ok();
    Ok(json!({"status":"accepted","replayed":false,"historyWarning":!persisted||!recorded}))
}
fn record_receipt(store: &LocalStore, input: &SendMailInput) -> AppResult<()> {
    check_scope(store, &input.scope)?;
    let mut connection = store.connect()?;
    let tx = connection.transaction()?;
    let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM audit_log WHERE action='smtp_accepted' AND entity_type=? AND entity_id=? AND json_extract(payload_json,'$.request_id')=?)",params![input.target.entity,input.target.id,input.request_id],|row|row.get(0))?;
    if exists {
        return Ok(());
    }
    let raw: String = history_db(store, &input.scope)?.query_row(
        "SELECT payload_json FROM submissions WHERE request_id=?",
        params![input.request_id],
        |r| r.get(0),
    )?;
    let payload: Value = serde_json::from_str(&raw)?;
    crate::audit::append_audit(
        &tx,
        "smtp_accepted",
        &input.target.entity,
        &input.target.id,
        &payload,
    )?;
    if input.target.entity == "reminders" {
        // The existing manual_sent action denotes a user-initiated submission. Its
        // immutable payload identifies SMTP and the exact message accepted by the server.
        let reminder = &payload["reminder"];
        tx.execute("INSERT INTO reminder_deliveries(id,request_id,reminder_id,action,prepared_on,recipient_email,current_balance_cents,payment_deadline_date,subject,body,payload_sha256,payload_json,created_at) VALUES(?,?,?,'manual_sent',?,?,?,?,?,?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),input.request_id,input.target.id,text(reminder,"prepared_on"),input.recipient,reminder["current_balance_cents"].as_i64(),text(reminder,"payment_deadline_date"),input.subject,input.body,hash(raw.as_bytes()),raw,now_iso()])?;
        // Preserve cancellation/payment decisions made while SMTP was in flight.
        let changed = tx.execute(
            "UPDATE reminders SET status='completed',updated_at=? WHERE id=? AND status='due'",
            params![now_iso(), input.target.id],
        )?;
        tx.execute("INSERT INTO reminder_history(id,reminder_id,action,note,occurred_at) VALUES(?,?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),input.target.id,if changed>0{"completed"}else{"note"},format!("Accepté par le serveur SMTP · {} · {}",input.recipient,input.request_id),now_iso()])?;
    }
    tx.commit()?;
    Ok(())
}

pub(crate) fn clear_local_connections(store: &LocalStore) -> AppResult<()> {
    let _mail = MailGuard::take()?;
    let root = store.data_dir.join("outgoing-mail");
    if !root.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            remove_protected(&entry.path().join("connection.protected"))?;
        }
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[tauri::command]
pub async fn outgoing_mail_state(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _g = store.lock()?;
        store.outgoing_mail_state()
    })
    .await
    .map_err(|_| "Lecture de la messagerie interrompue.".to_owned())?
    .map_err(command_error)
}
#[tauri::command]
pub async fn connect_outgoing_mail(
    state: State<'_, LocalStore>,
    scope: String,
    mut connection: MailConnection,
) -> Result<Value, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move||{
        let _mail=MailGuard::take()?;
        {let _g=store.lock()?;check_scope(&store,&scope)?;require_admin(&store)?;
            if connection.password.is_empty() {let old=read_connection(&store,&scope)?;if old.host!=connection.host || old.port!=connection.port || old.security!=connection.security || old.username!=connection.username {return Err(invalid("Saisissez de nouveau le mot de passe après un changement de serveur ou d’identifiant."));} connection.password=old.password;}
        }
        let ok=connection.transport()?.test_connection().map_err(|e|connection_error(&e))?;
        if !ok {return Err(invalid("Le serveur n’a pas confirmé la connexion. Vérifiez vos réglages."));}
        let _g=store.lock()?;check_scope(&store,&scope)?;require_admin(&store)?;
        std::fs::create_dir_all(folder(&store,&scope))?;
        write_protected_atomically_with_reference_after_server_verification(&secret_path(&store,&scope),&serde_json::to_vec(&connection)?)?;
        Ok(connection.public())
    }).await.map_err(|_|"Connexion à la messagerie interrompue.".to_owned())?.map_err(command_error)
}
#[tauri::command]
pub async fn disconnect_outgoing_mail(
    state: State<'_, LocalStore>,
    scope: String,
) -> Result<(), String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _mail = MailGuard::take()?;
        let _g = store.lock()?;
        check_scope(&store, &scope)?;
        require_admin(&store)?;
        remove_protected(&secret_path(&store, &scope))
    })
    .await
    .map_err(|_| "Déconnexion interrompue.".to_owned())?
    .map_err(command_error)
}
#[tauri::command]
pub async fn save_outgoing_mail_templates(
    state: State<'_, LocalStore>,
    scope: String,
    templates: MailTemplates,
    signature: Option<MailSignature>,
) -> Result<(), String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _g = store.lock()?;
        store.save_mail_templates(&scope, templates, signature)
    })
    .await
    .map_err(|_| "Enregistrement interrompu. Réessayez.".to_owned())?
    .map_err(command_error)
}
#[tauri::command]
pub async fn preview_outgoing_mail(
    state: State<'_, LocalStore>,
    target: MailTarget,
) -> Result<Value, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _g = store.lock()?;
        preview(&store, &target)
    })
    .await
    .map_err(|_| "Préparation du message interrompue.".to_owned())?
    .map_err(command_error)
}
#[tauri::command]
pub async fn send_outgoing_mail(
    state: State<'_, LocalStore>,
    input: SendMailInput,
) -> Result<Value, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || send(&store, input))
        .await
        .map_err(|_| {
            "Envoi interrompu. Vérifiez votre messagerie avant tout nouvel essai.".to_owned()
        })?
        .map_err(command_error)
}

#[cfg(test)]
#[path = "outgoing_mail_tests.rs"]
mod integration_tests;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn templates_are_single_pass_and_reject_unknown_variables() {
        let vars = BTreeMap::from([
            ("client".into(), "Client {entreprise}".into()),
            ("entreprise".into(), "Zentra".into()),
        ]);
        assert_eq!(
            render("Bonjour {client}, {entreprise}", &vars).unwrap(),
            "Bonjour Client {entreprise}, Zentra"
        );
        assert!(render("{inconnu}", &vars).is_err());
        assert!(render("{client", &vars).is_err());
    }
    #[test]
    fn headers_cannot_add_recipients() {
        assert!(address("a@example.com\r\nBcc: b@example.com").is_err());
        assert!(address("a@example.com,b@example.com").is_err());
        assert!(validate_message("Sujet\nBcc: a@example.com", "Bonjour").is_err());
        assert!(validate_message("Facture", "Bonjour\n\nMerci").is_ok());
    }
    #[test]
    fn connection_requires_tls_and_secret() {
        let mut c = MailConnection {
            host: "mail.infomaniak.com".into(),
            port: 465,
            security: "tls".into(),
            username: "a@example.com".into(),
            from_email: "a@example.com".into(),
            from_name: "Atelier".into(),
            password: "secret".into(),
        };
        assert!(c.validate().is_ok());
        assert!(!c.public().to_string().contains("secret"));
        c.security = "none".into();
        assert!(c.validate().is_err());
        c.security = "tls".into();
        c.host = "https://example.com/password".into();
        assert!(c.validate().is_err());
    }
}
