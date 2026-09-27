//! Explicit company-owned mail. PDF generation and immutable local evidence stay
//! native; the HTTPS server owns credentials, authorization and send idempotency.
use super::*;
use crate::account_cloud::{company_mail_request, company_mail_session, CompanyMailSession};

async fn session(store: &LocalStore) -> AppResult<CompanyMailSession> {
    company_mail_session(store).await?.ok_or_else(|| {
        invalid("Connectez votre compte Zentra pour utiliser la messagerie partagée.")
    })
}
fn guard_scope(store: &LocalStore, key: &str, manage: bool) -> AppResult<()> {
    let _guard = store.lock()?;
    check_scope(store, key)?;
    if manage {
        require_admin(store)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn shared_mail_state(
    state: State<'_, LocalStore>,
    scope: String,
    target: Option<MailTarget>,
) -> Result<Value, String> {
    let store = state.inner().clone();
    async {
        guard_scope(&store,&scope,false)?;
        let Some(session)=company_mail_session(&store).await? else{return Ok(json!({"available":false,"scope":scope,"connection":{"connected":false},"history":[]}))};
        let query=match target {Some(target)=>vec![("entity",target.entity),("documentId",target.id)],None=>vec![]};
        let mut value=company_mail_request(&store,&session,&query,None).await?;
        guard_scope(&store,&scope,false)?;value["scope"]=json!(scope);value["available"]=json!(true);Ok(value)
    }.await.map_err(command_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedConnection {
    token: String,
    from_email: String,
    from_name: String,
}
#[tauri::command]
pub async fn connect_shared_mail(
    state: State<'_, LocalStore>,
    scope: String,
    connection: SharedConnection,
) -> Result<Value, String> {
    let store = state.inner().clone();
    async {
        let _mail=MailGuard::take()?;guard_scope(&store,&scope,true)?;
        if connection.token.is_empty() || connection.token.len()>8192 || connection.from_name.len()>480 {return Err(invalid("Vérifiez la clé et le nom de l’expéditeur."));}
        address(&connection.from_email)?;
        let session=session(&store).await?;
        let mut value=company_mail_request(&store,&session,&[],Some(json!({"action":"connect","token":connection.token,"fromEmail":connection.from_email,"fromName":connection.from_name}))).await?;
        guard_scope(&store,&scope,true)?;value["scope"]=json!(scope);value["available"]=json!(true);Ok(value)
    }.await.map_err(command_error)
}
#[tauri::command]
pub async fn disconnect_shared_mail(
    state: State<'_, LocalStore>,
    scope: String,
) -> Result<(), String> {
    let store = state.inner().clone();
    async {
        let _mail = MailGuard::take()?;
        guard_scope(&store, &scope, true)?;
        company_mail_request(
            &store,
            &session(&store).await?,
            &[],
            Some(json!({"action":"disconnect"})),
        )
        .await?;
        guard_scope(&store, &scope, true)?;
        Ok(())
    }
    .await
    .map_err(command_error)
}

pub(super) fn prepare(
    store: &LocalStore,
    input: &SendMailInput,
    org: &str,
    connection: &Value,
    connection_id: &str,
) -> AppResult<Value> {
    check_scope(store, &input.scope)?;
    require_sender(store)?;
    uuid::Uuid::parse_str(&input.request_id)
        .map_err(|_| invalid("Rouvrez l’e-mail pour préparer un nouvel envoi."))?;
    address(&input.recipient)?;
    validate_message(&input.subject, &input.body)?;
    let fingerprint = hash(format!("company-mail-v1:{}", serde_json::to_string(input)?).as_bytes());
    let db = history_db(store, &input.scope)?;
    let previous: Option<(String, String)> = db
        .query_row(
            "SELECT payload_hash,status FROM submissions WHERE request_id=?",
            params![input.request_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((old, status)) = previous {
        if old != fingerprint {
            return Err(invalid(
                "Cette tentative concerne un autre message. Fermez puis rouvrez l’e-mail.",
            ));
        }
        if status == "accepted" {
            let recorded = record_receipt(store, input).is_ok();
            return Ok(json!({"replayed":true,"status":"accepted","historyWarning":!recorded}));
        }
        return Err(invalid("Vérifiez l’état de cet envoi avant de préparer un nouveau message. Aucun renvoi automatique n’aura lieu."));
    }
    if connection["connected"] != true || text(connection, "connectionId") != connection_id {
        return Err(invalid(
            "L’adresse d’envoi a changé. Rouvrez l’e-mail pour vérifier l’expéditeur.",
        ));
    }
    let current = preview(store, &input.target)?;
    if text(&current, "sourceRevision") != input.source_revision {
        return Err(invalid("Le document ou son solde a changé. Fermez puis rouvrez l’e-mail pour utiliser les informations à jour."));
    }
    let pdf = store.document_pdf_preview(
        &text(&current, "documentEntity"),
        &text(&current, "documentId"),
    )?;
    if pdf.len() > 6 * 1024 * 1024 {
        return Err(invalid(
            "Le PDF doit peser moins de 6 Mo pour l’envoi partagé.",
        ));
    }
    let logo = selected_mail_logo(store)?;
    if logo.as_ref().is_some_and(|v| v.bytes.len() > 256 * 1024) {
        return Err(invalid("Réduisez le logo de l’entreprise avant l’envoi."));
    }
    let reminder = if input.target.entity == "reminders" {
        Some(store.preview_reminder_delivery(ReminderPreviewInput {
            id: input.target.id.clone(),
            prepared_on: None,
        })?)
    } else {
        None
    };
    let message_id = format!("company-mail:{}", input.request_id);
    let payload = json!({"schema":"zentra.company_mail_submission.v1","channel":"company_mail","request_id":input.request_id,"organization_id":org,"input":input,"recipient":input.recipient.trim().to_lowercase(),"subject":input.subject.trim(),"body":input.body,"from_email":connection["fromEmail"],"from_name":connection["fromName"],"attachment_name":current["attachmentName"],"attachment_sha256":hash(&pdf),"reminder":reminder,"message_id":message_id});
    let request = json!({"action":"send","connectionId":connection_id,"requestId":input.request_id,"confirmed":true,"entity":input.target.entity,"documentId":input.target.id,"sourceRevision":input.source_revision,"recipient":input.recipient,"subject":input.subject,"body":input.body,"attachmentName":current["attachmentName"],"pdfBase64":base64::engine::general_purpose::STANDARD.encode(pdf),"signatureLogoDataUrl":logo.map(|v|v.data_url())});
    // Reserve locally before any irreversible HTTP submission. The PDF and key
    // are not persisted here. Recovery only queries a receipt; it cannot resend.
    db.execute(
        "INSERT INTO submissions VALUES(?,?,?,?,?,?,'pending',?,?,?)",
        params![
            input.request_id,
            fingerprint,
            input.target.entity,
            input.target.id,
            input.recipient,
            input.subject,
            now_iso(),
            message_id,
            payload.to_string()
        ],
    )?;
    Ok(request)
}

pub(super) fn accept_receipt(
    store: &LocalStore,
    key: &str,
    request_id: &str,
    org: &str,
    receipt: &Value,
) -> AppResult<Value> {
    check_scope(store, key)?;
    let db = history_db(store, key)?;
    let raw: Option<String> = db
        .query_row(
            "SELECT payload_json FROM submissions WHERE request_id=?",
            params![request_id],
            |r| r.get(0),
        )
        .optional()?;
    let raw=raw.ok_or_else(||invalid("Aucun envoi n’a été préparé sur cet appareil. Fermez puis rouvrez le message pour recommencer."))?;
    let payload: Value = serde_json::from_str(&raw)?;
    let input: SendMailInput = serde_json::from_value(payload["input"].clone())?;
    if text(&payload, "channel") != "company_mail"
        || text(&payload, "organization_id") != org
        || text(receipt, "requestId") != request_id
        || text(receipt, "entity") != input.target.entity
        || text(receipt, "documentId") != input.target.id
        || text(receipt, "recipient") != text(&payload, "recipient")
        || text(receipt, "subject") != text(&payload, "subject")
        || text(receipt, "attachmentHash") != text(&payload, "attachment_sha256")
        || text(receipt, "fromEmail") != text(&payload, "from_email")
    {
        return Err(invalid(
            "La confirmation ne correspond pas à cet e-mail. Aucun renvoi n’a été effectué.",
        ));
    }
    let status = text(receipt, "status");
    if !matches!(
        status.as_str(),
        "pending" | "accepted" | "rejected" | "uncertain"
    ) {
        return Err(invalid(
            "L’état de l’envoi est illisible. Aucun renvoi n’a été effectué.",
        ));
    }
    // Keep an already accepted local receipt if an earlier response arrives late.
    db.execute(
        "UPDATE submissions SET status=? WHERE request_id=? AND status<>'accepted'",
        params![status, request_id],
    )?;
    let accepted: String = db.query_row(
        "SELECT status FROM submissions WHERE request_id=?",
        params![request_id],
        |r| r.get(0),
    )?;
    let recorded = accepted != "accepted" || record_receipt(store, &input).is_ok();
    Ok(json!({"status":accepted,"replayed":true,"historyWarning":!recorded}))
}

async fn recover(
    store: &LocalStore,
    key: &str,
    request_id: &str,
    session: &CompanyMailSession,
) -> AppResult<Value> {
    {
        let _local = store.lock()?;
        check_scope(store, key)?;
    }
    let result =
        company_mail_request(store, session, &[("requestId", request_id.into())], None).await?;
    if result["receipt"].is_null() {
        return Err(invalid("Le serveur ne confirme pas encore cet envoi. Vérifiez à nouveau son état ou votre messagerie avant tout nouvel envoi."));
    }
    let _local = store.lock()?;
    accept_receipt(
        store,
        key,
        request_id,
        session.organization_id(),
        &result["receipt"],
    )
}
#[tauri::command]
pub async fn recover_shared_mail(
    state: State<'_, LocalStore>,
    scope: String,
    request_id: String,
) -> Result<Value, String> {
    let store = state.inner().clone();
    async {
        let _mail = MailGuard::take()?;
        guard_scope(&store, &scope, false)?;
        let request_id = uuid::Uuid::parse_str(&request_id)
            .map_err(|_| invalid("Rouvrez l’historique du document."))?
            .to_string();
        recover(&store, &scope, &request_id, &session(&store).await?).await
    }
    .await
    .map_err(command_error)
}
#[tauri::command]
pub async fn send_shared_mail(
    state: State<'_, LocalStore>,
    mut input: SendMailInput,
    connection_id: String,
) -> Result<Value, String> {
    let store = state.inner().clone();
    async {
        let _mail = MailGuard::take()?;
        guard_scope(&store, &input.scope, false)?;
        input.request_id = uuid::Uuid::parse_str(&input.request_id)
            .map_err(|_| invalid("Rouvrez l’e-mail pour préparer un nouvel envoi."))?
            .to_string();
        let session = session(&store).await?;
        let state = company_mail_request(&store, &session, &[], None).await?;
        let org = session.organization_id().to_owned();
        let key = input.scope.clone();
        let request_id = input.request_id.clone();
        let preparation_store = store.clone();
        let request = tauri::async_runtime::spawn_blocking(move || {
            let _local = preparation_store.lock()?;
            prepare(
                &preparation_store,
                &input,
                &org,
                &state["connection"],
                &connection_id,
            )
        })
        .await
        .map_err(|_| invalid("La préparation de l’e-mail a été interrompue."))??;
        if request["status"] == "accepted" {
            return Ok(request);
        }
        // Ignore an ambiguous submit result until a read-only receipt query has
        // attempted recovery. This never falls back to SMTP or retries the POST.
        let submitted = company_mail_request(&store, &session, &[], Some(request)).await;
        match recover(&store, &key, &request_id, &session).await {
            Ok(mut value) => {
                if value["status"] == "rejected" {
                    if let Err(error) = submitted {
                        value["message"] = json!(command_error(error));
                    }
                }
                Ok(value)
            }
            Err(_) if submitted.as_ref().is_ok_and(|v| v["status"] == "accepted") => {
                Ok(json!({"status":"accepted","replayed":false,"historyWarning":true}))
            }
            Err(error) => match submitted {
                Err(submission_error) => Err(submission_error),
                Ok(_) => Err(error),
            },
        }
    }
    .await
    .map_err(command_error)
}
