//! Demande de justificatif à un collaborateur : un message texte, relu puis
//! envoyé d'un clic. Par la messagerie de l'entreprise (serveur Zentra) quand
//! elle est connectée, sinon par la messagerie de cet appareil (SMTP). Jamais
//! de pièce jointe, jamais de renvoi automatique : une tentative sans
//! confirmation certaine reste à vérifier.
use super::*;
use crate::account_cloud::{company_mail_request, company_mail_session};

pub(crate) const NOTE_ENTITY: &str = "receipt_requests";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptRequestInput {
    pub request_id: String,
    pub scope: String,
    /// « company » : messagerie de l'entreprise ; « device » : messagerie de cet appareil.
    pub channel: String,
    #[serde(default)]
    pub connection_id: Option<String>,
    /// Le mouvement bancaire dont la pièce manque.
    pub reference: String,
    pub recipient: String,
    pub subject: String,
    pub body: String,
}

pub(crate) fn validate_note(input: &ReceiptRequestInput) -> AppResult<()> {
    uuid::Uuid::parse_str(&input.request_id)
        .map_err(|_| invalid("Rouvrez la demande pour préparer un nouvel envoi."))?;
    if !matches!(input.channel.as_str(), "company" | "device") {
        return Err(invalid("Choisissez la messagerie d’envoi."));
    }
    if input.reference.is_empty()
        || input.reference.len() > 80
        || !input.reference.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(invalid("Rouvrez la demande pour la préparer à nouveau."));
    }
    address(&input.recipient)?;
    validate_message(&input.subject, &input.body)?;
    if input.subject.chars().count() > 200 || input.body.len() > 4000 {
        return Err(invalid("Le message doit rester sous 4 000 caractères, avec un objet court."));
    }
    Ok(())
}

/// Réserve la tentative avant tout envoi. Rend la réponse déjà connue quand la
/// même demande a été acceptée ; refuse une autre demande sous le même identifiant.
pub(crate) fn reserve(store: &LocalStore, input: &ReceiptRequestInput, message_id: &str, channel: Value) -> AppResult<Option<Value>> {
    let fingerprint = hash(format!("receipt-request-v1:{}", serde_json::to_string(input)?).as_bytes());
    let db = history_db(store, &input.scope)?;
    let previous: Option<(String, String)> = db
        .query_row("SELECT payload_hash,status FROM submissions WHERE request_id=?", params![input.request_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    if let Some((old, status)) = previous {
        if old != fingerprint {
            return Err(invalid("Cette tentative concerne un autre message. Fermez puis rouvrez la demande."));
        }
        if status == "accepted" {
            return Ok(Some(json!({"status":"accepted","replayed":true,"historyWarning":false})));
        }
        return Err(invalid("Vérifiez l’état de cet envoi avant de préparer un nouveau message. Aucun renvoi automatique n’aura lieu."));
    }
    let payload = json!({"schema":"zentra.receipt_request.v1","request_id":input.request_id,"channel":channel,"reference":input.reference,"recipient":input.recipient.trim().to_lowercase(),"subject":input.subject,"message_id":message_id});
    db.execute(
        "INSERT INTO submissions VALUES(?,?,?,?,?,?,'pending',?,?,?)",
        params![input.request_id, fingerprint, NOTE_ENTITY, input.reference, input.recipient, input.subject, now_iso(), message_id, payload.to_string()],
    )?;
    Ok(None)
}

/// Garde l'issue ; une demande acceptée entre une seule fois au journal d'audit.
pub(crate) fn finish(store: &LocalStore, input: &ReceiptRequestInput, status: &str) -> AppResult<()> {
    check_scope(store, &input.scope)?;
    history_db(store, &input.scope)?.execute(
        "UPDATE submissions SET status=? WHERE request_id=? AND status<>'accepted'",
        params![status, input.request_id],
    )?;
    if status != "accepted" {
        return Ok(());
    }
    let mut connection = store.connect()?;
    let tx = connection.transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM audit_log WHERE action='receipt_request.sent' AND entity_id=? AND json_extract(payload_json,'$.request_id')=?)",
        params![input.reference, input.request_id],
        |row| row.get(0),
    )?;
    if !exists {
        crate::audit::append_audit(
            &tx,
            "receipt_request.sent",
            "bank_movement",
            &input.reference,
            &json!({"request_id": input.request_id, "channel": input.channel, "recipient": input.recipient.trim().to_lowercase(), "subject": input.subject}),
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn send_device(store: &LocalStore, input: ReceiptRequestInput) -> AppResult<Value> {
    let _mail = MailGuard::take()?;
    validate_note(&input)?;
    let (transport, message) = {
        let _local = store.lock()?;
        check_scope(store, &input.scope)?;
        require_sender(store)?;
        let connection = read_connection(store, &input.scope)?;
        let message_id = format!("<{}@{}>", input.request_id, connection.from_email.split('@').next_back().unwrap_or("zentra.local"));
        let message = Message::builder()
            .from(Mailbox::new(Some(connection.from_name.clone()), address(&connection.from_email)?))
            .to(Mailbox::new(None, address(&input.recipient)?))
            .reply_to(Mailbox::new(None, address(&connection.from_email)?))
            .subject(&input.subject)
            .message_id(Some(message_id.clone()))
            .singlepart(SinglePart::plain(input.body.clone()))
            .map_err(|_| invalid("Le message contient une adresse ou un en-tête invalide."))?;
        let transport = connection.transport()?;
        if let Some(done) = reserve(store, &input, &message_id, json!("smtp"))? {
            return Ok(done);
        }
        (transport, message)
    };
    // Network I/O never holds the company lock or the GUI thread.
    let status = match transport.send(&message) {
        Ok(_) => "accepted",
        Err(error) if error.is_permanent() || error.is_transient() => "rejected",
        Err(_) => "uncertain",
    };
    let recorded = (|| {
        let _local = store.lock()?;
        finish(store, &input, status)
    })();
    drop(_mail);
    match status {
        "accepted" => Ok(json!({"status":"accepted","replayed":false,"historyWarning":recorded.is_err()})),
        "rejected" => Err(invalid("Le serveur a refusé l’e-mail. Vérifiez l’adresse du collaborateur et les réglages de votre messagerie.")),
        _ => Err(invalid("La connexion a été interrompue. L’e-mail a peut-être été envoyé : vérifiez vos messages envoyés avant de recommencer.")),
    }
}

async fn send_company(store: &LocalStore, input: ReceiptRequestInput) -> AppResult<Value> {
    let _mail = MailGuard::take()?;
    validate_note(&input)?;
    let connection_id = input
        .connection_id
        .clone()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or_else(|| invalid("Choisissez la messagerie d’envoi."))?;
    {
        let _local = store.lock()?;
        check_scope(store, &input.scope)?;
        require_sender(store)?;
    }
    let session = company_mail_session(store)
        .await?
        .ok_or_else(|| invalid("Connectez votre compte Zentra pour utiliser la messagerie de l’entreprise."))?;
    let message_id = format!("company-mail:{}", input.request_id);
    let replayed = {
        let _local = store.lock()?;
        check_scope(store, &input.scope)?;
        reserve(store, &input, &message_id, json!({"company_mail": session.organization_id()}))?
    };
    if let Some(done) = replayed {
        return Ok(done);
    }
    let request = json!({"action":"send_note","connectionId":connection_id,"requestId":input.request_id,"confirmed":true,"reference":input.reference,"recipient":input.recipient,"subject":input.subject,"body":input.body});
    let submitted = company_mail_request(store, &session, &[], Some(request)).await;
    // A lost answer is checked with a read-only receipt query. It never sends again.
    let status = match &submitted {
        Ok(value) if matches!(value["status"].as_str(), Some("accepted" | "pending" | "rejected" | "uncertain")) => text(value, "status"),
        _ => match company_mail_request(store, &session, &[("requestId", input.request_id.clone())], None).await {
            Ok(value) if !value["receipt"].is_null() => text(&value["receipt"], "status"),
            _ if submitted.is_err() => "rejected".to_owned(),
            _ => "uncertain".to_owned(),
        },
    };
    let recorded = (|| {
        let _local = store.lock()?;
        finish(store, &input, &status)
    })();
    match status.as_str() {
        "accepted" => Ok(json!({"status":"accepted","replayed":false,"historyWarning":recorded.is_err()})),
        "pending" => Ok(json!({"status":"pending","replayed":false,"historyWarning":recorded.is_err()})),
        "rejected" => Err(submitted.err().unwrap_or_else(|| invalid("La messagerie de l’entreprise a refusé ce message. Aucun envoi n’a eu lieu."))),
        _ => Err(invalid("L’envoi n’a pas de confirmation certaine. Vérifiez les messages envoyés de l’entreprise avant de recommencer.")),
    }
}

#[tauri::command]
pub async fn send_receipt_request(state: State<'_, LocalStore>, input: ReceiptRequestInput) -> Result<Value, String> {
    let store = state.inner().clone();
    if input.channel == "company" {
        return send_company(&store, input).await.map_err(command_error);
    }
    tauri::async_runtime::spawn_blocking(move || send_device(&store, input))
        .await
        .map_err(|_| "Envoi interrompu. Vérifiez votre messagerie avant tout nouvel essai.".to_owned())?
        .map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note() -> ReceiptRequestInput {
        ReceiptRequestInput {
            request_id: "6f1c1b2e-1111-4111-8111-111111111111".into(),
            scope: String::new(),
            channel: "device".into(),
            connection_id: None,
            reference: "movement-42".into(),
            recipient: "luca.rossi@example.invalid".into(),
            subject: "Justificatif à transmettre : 84.50 CHF du 03.10.2026".into(),
            body: "Bonjour Luca,\n\nIl nous manque le justificatif de cette dépense.\n\nMerci".into(),
        }
    }

    #[test]
    fn a_receipt_request_is_short_plain_text_to_one_address() {
        assert!(validate_note(&note()).is_ok());
        for broken in [
            ReceiptRequestInput { channel: "fax".into(), ..note() },
            ReceiptRequestInput { request_id: "not-a-uuid".into(), ..note() },
            ReceiptRequestInput { reference: "../movement".into(), ..note() },
            ReceiptRequestInput { recipient: "a@example.invalid, b@example.invalid".into(), ..note() },
            ReceiptRequestInput { subject: "Objet\nBcc: x@example.invalid".into(), ..note() },
            ReceiptRequestInput { body: "x".repeat(4001), ..note() },
        ] {
            assert!(validate_note(&broken).is_err());
        }
    }

    #[test]
    fn a_receipt_request_is_reserved_once_journaled_once_and_never_sent_twice() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "receipt-request-test").unwrap();
        let input = ReceiptRequestInput { scope: scope(&store).unwrap(), ..note() };
        assert!(reserve(&store, &input, "<id@example.invalid>", json!("smtp")).unwrap().is_none());
        // Pending: the same attempt is not sent again, another message under the same id is refused.
        assert!(reserve(&store, &input, "<id@example.invalid>", json!("smtp")).unwrap_err().to_string().contains("Aucun renvoi"));
        let changed = ReceiptRequestInput { body: "Autre texte".into(), ..input.clone() };
        assert!(reserve(&store, &changed, "<id@example.invalid>", json!("smtp")).unwrap_err().to_string().contains("autre message"));
        finish(&store, &input, "accepted").unwrap();
        finish(&store, &input, "accepted").unwrap();
        assert_eq!(reserve(&store, &input, "<id@example.invalid>", json!("smtp")).unwrap().unwrap()["replayed"], true);
        let journaled: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM audit_log WHERE action='receipt_request.sent' AND entity_id='movement-42'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journaled, 1);
        // A late « rejected » never downgrades an accepted request.
        finish(&store, &input, "rejected").unwrap();
        let status: String = history_db(&store, &input.scope)
            .unwrap()
            .query_row("SELECT status FROM submissions WHERE request_id=?", [&input.request_id], |row| row.get(0))
            .unwrap();
        assert_eq!(status, "accepted");
    }
}
