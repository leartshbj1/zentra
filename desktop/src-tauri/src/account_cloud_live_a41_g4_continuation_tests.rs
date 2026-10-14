//! Distinct populated-head continuation. Never runs the virgin recipe, seeds
//! business rows, changes consent, rotates a hook or replays the old proposal.
use super::*;
#[path = "account_cloud_live_a41_g5_tests.rs"]
mod g5;
const BASE_SNAPSHOT: &str = "5ba6a352-807e-4b7f-9bc7-e216477ef7f2";
const BASE_ARCHIVE: &str = "c782d6c38685b9bae3efebf32601f265dbaae35ab3a0e6829cf339ea6469f315";
const OLD_SOURCE: &str = "6876287b-2ad0-486a-85df-95610f2d2a6d";
const OLD_PROPOSAL: &str = "c668fb83-9262-4809-8724-af6638f813e5";
const REVIEW_PATH: &str = "/api/account/automation/quote-review";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContinuationInput { format: String, sites_service_token: String, root_dir: String,
    installations: Vec<AccountBaseline>, source_sha: String, campaign_id: String }

fn admitted() -> RecipeResult<(Pipe, ContinuationInput)> {
    if option_env!("ZENTRA_ACTION_NATIVE_TEST_CONTEXT") != Some("live-sandbox-a41")
        || std::env::var("CIRCLECI").as_deref() != Ok("true")
        || std::env::var("CIRCLE_BRANCH").as_deref() != Ok("codex/action-engine-native-live-a41")
        || std::env::var("ZENTRA_RUN_LIVE_G4_CONTINUATION").as_deref() != Ok("true")
        || std::env::var("ZENTRA_RUN_LIVE_G4_RECIPE").is_ok() { return Err(()); }
    let profile = crate::native_test_profile::require().map_err(|_| ())?;
    if profile.sha256() != PROFILE_SHA || profile.site_origin() != SITE
        || profile.license_kid() != "sandbox-action-engine-a41"
        || base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(profile.license_key()) != "hLFfY6E43JD0Sz-gUOrhOHY8mxQHqyu2875H2oXPQb0" { return Err(()); }
    let challenge: Challenge = read_message(&mut std::io::stdin().lock())?;
    if challenge.challenge.len() != 43 || !challenge.challenge.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { return Err(()); }
    let name = std::env::var("ZENTRA_A41_CONTINUATION_PIPE").map_err(|_| ())?;
    let suffix = name.strip_prefix(r"\\.\pipe\zentra-a41-continuation-").ok_or(())?;
    crate::cloud_backup::validate_id(suffix).map_err(|_| ())?;
    let mut pipe = Pipe(std::fs::OpenOptions::new().read(true).write(true).open(name).map_err(|_| ())?);
    pipe.write(json!({"event":"hello","challenge":challenge.challenge}))?;
    let input: ContinuationInput = pipe.read()?;
    if input.format != "zentra-a41-continuation-private-v1" || input.installations.len() != 2
        || input.installations[0].installation_id == input.installations[1].installation_id
        || input.source_sha.len() != 40 || !input.source_sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || option_env!("CIRCLE_SHA1") != Some(input.source_sha.as_str())
        || std::env::var("CIRCLE_SHA1").as_deref() != Ok(input.source_sha.as_str()) { return Err(()); }
    crate::cloud_backup::validate_id(&input.campaign_id).map_err(|_| ())?;
    crate::native_test_profile::install_sites_access_token(&input.sites_service_token).map_err(|_| ())?;
    Ok((pipe,input))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Head { organization_id: String, user_id: String, role: String, enabled: bool, revision: u64,
    snapshot_id: String, updated_at: String, manifest: crate::cloud_backup::Manifest, content_transfer: u8, content_version: u8 }
async fn capture_head(store: &LocalStore) -> RecipeResult<collaboration::LivePublication> {
    let session = read_session_secret(store).map_err(|_| ())?.ok_or(())?;
    let (status, bytes) = account_request(Method::GET, crate::company_collaboration::PATH, None, Some(&session.session_token)).await.map_err(|_| ())?;
    if status != StatusCode::OK { return Err(()); }
    let head: Head = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if head.organization_id != ORGANIZATION || head.user_id != OWNER || head.role != "owner" || !head.enabled
        || head.revision != 1 || head.snapshot_id != BASE_SNAPSHOT || head.manifest.sha256 != BASE_ARCHIVE
        || head.content_transfer != 1 || head.content_version != 1 || head.updated_at.len() > 64 { return Err(()); }
    head.manifest.validate().map_err(|_| ())?;
    // Internal receive reference only. NEVER emit its public_proof(), which
    // would claim a historical writer fact that these new stores do not own.
    Ok(collaboration::LivePublication { snapshot_id: head.snapshot_id, base_revision: 0, revision: 1, manifest: head.manifest })
}
fn baseline_receipt(head: &collaboration::LivePublication) -> RecipeResult<Value> {
    Ok(json!({"snapshotId":head.snapshot_id,"revision":head.revision,"archiveSha256":head.manifest.sha256,
        "manifestSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&head.manifest).map_err(|_| ())?)),
        "sizeBytes":head.manifest.size_bytes,"transport":"content-v1","receivedBoth":true,
        "historicalWriterAckClaimed":false,"historicalGatewayFactClaimed":false}))
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewItem { proposal_id: String, source_id: String, created_at: u64, disposition: String,
    reasons: Vec<protocol::QuoteWorkReviewReason>, requires_human_validation: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewPage { organization_id: String, items: Vec<ReviewItem>, next_cursor: Value }
async fn historical_review(store: &LocalStore) -> RecipeResult<ReviewItem> {
    let session = read_session_secret(store).map_err(|_| ())?.ok_or(())?;
    let mut url = endpoint(REVIEW_PATH).map_err(|_| ())?; url.query_pairs_mut().append_pair("limit","50");
    let (status, bytes) = account_request_url(Method::GET,url,None,Some(&session.session_token),TOTAL_TIMEOUT).await.map_err(|_| ())?;
    if status != StatusCode::OK { return Err(()); }
    let page: ReviewPage = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if page.organization_id != ORGANIZATION || !page.next_cursor.is_null() || page.items.len() > 50 { return Err(()); }
    let mut found = page.items.into_iter().filter(|item| item.source_id == OLD_SOURCE || item.proposal_id == OLD_PROPOSAL);
    let item = found.next().ok_or(())?;
    if found.next().is_some() || item.source_id != OLD_SOURCE || item.proposal_id != OLD_PROPOSAL
        || item.created_at == 0 || item.created_at > 253402300799 || item.disposition != "needs_review"
        || item.reasons != vec![protocol::QuoteWorkReviewReason::LowConfidence] || !item.requires_human_validation { return Err(()); }
    Ok(item)
}
async fn existing_consent(store: &LocalStore) -> RecipeResult<u64> {
    let session=read_session_secret(store).map_err(|_| ())?.ok_or(())?;
    let (status,bytes)=account_request(Method::GET,CONSENT_PATH,None,Some(&session.session_token)).await.map_err(|_| ())?;
    if status!=StatusCode::OK { return Err(()); }
    let value: Consent=serde_json::from_slice(&bytes).map_err(|_| ())?;
    if value.schema_version!=1 || !value.enabled || value.revision==0 || value.revision>i32::MAX as u64
        || value.consent_version.as_deref()!=Some(CONSENT_VERSION) || value.required_consent_version!=CONSENT_VERSION { return Err(()); }
    Ok(value.revision)
}
#[derive(Clone, PartialEq)]
struct Baseline { quotes: i64, receipts: i64, resources: String, customer: String, article: String }
fn business_baseline(store: &LocalStore) -> RecipeResult<Baseline> {
    let _local = store.lock().map_err(|_| ())?; let db = store.connect().map_err(|_| ())?;
    let resources = crate::action_engine_resources::export_resources(&db).map_err(|_| ())?;
    if resources.company.country != "CH" || resources.company.currency != "CHF" || !resources.company.onboarding_complete
        || resources.company.vat_registered { return Err(()); }
    let customers = resources.customers.iter().filter(|c| c.email.as_deref() == Some("camille-a41@example.invalid") && c.name == "Camille Recette A41" && !c.archived).collect::<Vec<_>>();
    let articles = resources.articles.iter().filter(|a| a.sku.as_deref() == Some("A41-RAD-100") && a.name == "Radiateur A41" && !a.archived
        && a.unit == "pièce" && a.unit_price_cents == 19900 && a.tax_rate_bp == 0).collect::<Vec<_>>();
    if customers.len() != 1 || articles.len() != 1 || store.verify_audit_log().map_err(|_| ())?["valid"] != true { return Err(()); }
    Ok(Baseline { quotes: db.query_row("SELECT COUNT(*) FROM quotes",[],|r| r.get(0)).map_err(|_| ())?,
        receipts: db.query_row("SELECT COUNT(*) FROM action_engine_quote_receipts WHERE organization_id=?",[ORGANIZATION],|r| r.get(0)).map_err(|_| ())?,
        resources: crate::action_engine_resources::resource_hash(&resources), customer: customers[0].id.clone(), article: articles[0].id.clone() })
}
fn new_quote_proof(store: &LocalStore, source: &str, baseline: &Baseline) -> RecipeResult<Value> {
    let after = business_baseline(store)?;
    if after.quotes != baseline.quotes + 1 || after.receipts != baseline.receipts + 1
        || after.resources != baseline.resources || after.customer != baseline.customer || after.article != baseline.article { return Err(()); }
    let _local = store.lock().map_err(|_| ())?; let db = store.connect().map_err(|_| ())?;
    let rows = crate::database::query_all(&db,"SELECT source_id,proposal_id,reservation_id,fingerprint,quote_id,receipt_json,receipt_sha256 FROM action_engine_quote_receipts WHERE organization_id=? AND source_id=? LIMIT 2",[ORGANIZATION,source]).map_err(|_| ())?;
    if rows.len()!=1 { return Err(()); } let row=&rows[0];
    let receipt: ActionEngineQuoteReceipt = serde_json::from_str(row["receipt_json"].as_str().ok_or(())?).map_err(|_| ())?;
    if receipt.organization_id!=ORGANIZATION || receipt.customer_id!=baseline.customer || receipt.quote_number.is_some() || receipt.status!="draft" || !receipt.requires_human_validation { return Err(()); }
    let quote = crate::database::query_all(&db,"SELECT id,client_id,number,status,currency,subtotal_cents,discount_cents,vat_cents,total_cents FROM quotes WHERE id=?",[&receipt.quote_id]).map_err(|_| ())?;
    if quote.len()!=1 || quote[0]["client_id"]!=baseline.customer || !quote[0]["number"].is_null() || quote[0]["status"]!="brouillon" || quote[0]["currency"]!="CHF"
        || quote[0]["subtotal_cents"]!=59700 || quote[0]["discount_cents"]!=0 || quote[0]["vat_cents"]!=0 || quote[0]["total_cents"]!=59700 { return Err(()); }
    let lines=crate::database::query_all(&db,"SELECT id,catalog_item_id,position,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents FROM quote_items WHERE quote_id=? ORDER BY position",[&receipt.quote_id]).map_err(|_| ())?;
    if lines.len()!=1 || lines[0]["catalog_item_id"]!=baseline.article || lines[0]["position"]!=0 || lines[0]["quantity"].as_f64()!=Some(3.0) || lines[0]["unit"]!="pièce"
        || lines[0]["unit_price_cents"]!=19900 || lines[0]["discount_bp"]!=0 || lines[0]["vat_bp"]!=0 || lines[0]["line_net_cents"]!=59700 || lines[0]["line_vat_cents"]!=0 || lines[0]["line_total_cents"]!=59700 { return Err(()); }
    let text=|key:&str| row[key].as_str().ok_or(());
    if !crate::action_engine_quote::frozen_quote_publication_matches(&db,ORGANIZATION,text("proposal_id")?,text("reservation_id")?,text("fingerprint")?,&receipt.quote_id,text("receipt_sha256")?).map_err(|_| ())? { return Err(()); }
    Ok(json!({"sourceId":source,"proposalId":receipt.proposal_id,"reservationId":text("reservation_id")?,"fingerprint":receipt.fingerprint,
        "quoteId":receipt.quote_id,"customerId":baseline.customer,"articleId":baseline.article,"receiptSha256":text("receipt_sha256")?,
        "lineIds":lines.iter().map(|l|l["id"].clone()).collect::<Vec<_>>(),"quoteCount":1,"receiptCount":1,"quoteNumber":Value::Null,
        "status":"draft","requiresHumanValidation":true,"nativeFrozenCreationVerified":true,"auditChainValid":true}))
}
fn activity_count(store: &LocalStore, expected_quote: Option<&str>) -> RecipeResult<usize> {
    let page=store.read_action_engine_quote_activity(origin(store)?,None,50).map_err(|_| ())?;
    let expected_count=if expected_quote.is_some(){1}else{0};
    if page.next_after_proposal_id.is_some() || page.entries.len()!=expected_count
        || expected_quote.is_some_and(|id|page.entries[0].quote_id!=id) { return Err(()); }
    Ok(page.entries.len())
}
async fn execute_continuation() -> RecipeResult<()> {
    let (mut pipe,input)=admitted()?;
    pipe.checkpoint("continuation_admitted",0)?;
    let root=retained_root(&input.root_dir)?;
    let a=open_existing(&root,"device-a")?; let b=open_existing(&root,"device-b")?;
    pipe.checkpoint("new_stores_authenticated",0)?;
    strict_account(&a,&input.installations[0]).await?; strict_account(&b,&input.installations[1]).await?;
    let consent_a=existing_consent(&a).await?; let consent_b=existing_consent(&b).await?;
    let head=capture_head(&a).await?;
    collaboration::receive_exact(&a,&head,true).await.map_err(|_| ())?;
    collaboration::receive_exact(&b,&head,true).await.map_err(|_| ())?;
    if capture_head(&a).await?!=head || capture_head(&b).await?!=head { return Err(()); }
    let baseline_a=business_baseline(&a)?; let baseline_b=business_baseline(&b)?;
    if baseline_a!=baseline_b { return Err(()); }
    activity_count(&a,None)?; activity_count(&b,None)?;
    let historical=historical_review(&a).await?;
    if historical_review(&b).await?!=historical { return Err(()); }
    pipe.checkpoint("baseline_received",0)?;
    pipe.write(json!({"event":"baseline","campaignId":input.campaign_id,"baseline":baseline_receipt(&head)?,
        "historicalReview":historical,"customerId":baseline_a.customer,"articleId":baseline_a.article,
        "resourcesSha256":baseline_a.resources,"quoteBaselineCount":baseline_a.quotes,"receiptBaselineCount":baseline_a.receipts,
        "consentRevisions":[consent_a,consent_b]}))?;
    let source: SourceReady=pipe.read()?;
    if source.event!="source-ready" || source.source_id==OLD_SOURCE { return Err(()); }
    crate::cloud_backup::validate_id(&source.source_id).map_err(|_| ())?;
    let found=discovery(&a).await?;
    let mut actual=found.source_ids; actual.sort(); let mut expected=vec![OLD_SOURCE.to_string(),source.source_id.clone()]; expected.sort();
    if actual!=expected || found.next_cursor.is_some() { return Err(()); }
    pipe.checkpoint("new_source_discovered",0)?;
    let decision=action_engine::continuation_support::prepare_and_execute_new_source(&a,&source.source_id).await.map_err(|_| ())?;
    if decision.prepared.proposal_id==OLD_PROPOSAL { return Err(()); }
    if decision.prepared.disposition==protocol::QuoteWorkDisposition::NeedsReview {
        if business_baseline(&a)?!=baseline_a || capture_head(&a).await?!=head || historical_review(&a).await?!=historical { return Err(()); }
        pipe.write(json!({"event":"new-source-review","historicalReviewPreserved":true,"newSourceId":source.source_id,
            "newProposalId":decision.prepared.proposal_id,"reasons":decision.prepared.reasons,"nominalG4Passed":false}))?;
        return Err(());
    }
    if !decision.confirmed { return Err(()); }
    pipe.checkpoint("new_quote_confirmed",0)?;
    let proof_a=new_quote_proof(&a,&source.source_id,&baseline_a)?;
    if proof_a["proposalId"]!=decision.prepared.proposal_id || proof_a["fingerprint"]!=decision.prepared.fingerprint { return Err(()); }
    let quote_id=proof_a["quoteId"].as_str().ok_or(())?;
    activity_count(&a,Some(quote_id))?;
    let canonical=collaboration::acknowledged_publication(&a,proof_a["proposalId"].as_str().ok_or(())?).map_err(|_| ())?;
    if canonical.base_revision!=head.revision || canonical.revision!=head.revision+1 || canonical.snapshot_id==head.snapshot_id || canonical.manifest.sha256==head.manifest.sha256 { return Err(()); }
    collaboration::corroborate_writer(&a,&canonical).await.map_err(|_| ())?;
    collaboration::receive_exact(&b,&canonical,false).await.map_err(|_| ())?;
    if new_quote_proof(&b,&source.source_id,&baseline_b)?!=proof_a { return Err(()); }
    activity_count(&b,None)?;
    if historical_review(&a).await?!=historical || historical_review(&b).await?!=historical { return Err(()); }
    let remaining=discovery(&b).await?;
    if remaining.source_ids!=vec![OLD_SOURCE.to_string()] || remaining.next_cursor.is_some() { return Err(()); }
    pipe.checkpoint("second_store_received",1)?;
    drop(a); drop(b);
    let a=open_existing(&root,"device-a")?; let b=open_existing(&root,"device-b")?;
    strict_account(&a,&input.installations[0]).await?; strict_account(&b,&input.installations[1]).await?;
    if existing_consent(&a).await?!=consent_a || existing_consent(&b).await?!=consent_b { return Err(()); }
    if new_quote_proof(&a,&source.source_id,&baseline_a)?!=proof_a || new_quote_proof(&b,&source.source_id,&baseline_b)?!=proof_a { return Err(()); }
    activity_count(&a,Some(quote_id))?; activity_count(&b,None)?;
    if historical_review(&a).await?!=historical { return Err(()); }
    collaboration::corroborate_writer(&a,&canonical).await.map_err(|_| ())?;
    pipe.checkpoint("new_stores_reopened",0)?;
    pipe.write(json!({"event":"complete","profileSha256":PROFILE_SHA,"organizationId":ORGANIZATION,"campaignId":input.campaign_id,
        "baseline":baseline_receipt(&head)?,"historicalReview":historical,"canonicalPublication":canonical.public_proof().map_err(|_| ())?,
        "quote":proof_a,"newStores":true,"lostStoresRecovered":false,"historicalPreparationRequests":0,"writerActivityCount":1,
        "secondStoreActivityCount":0,"secondStoreExactCreation":true,"reopenedBoth":true,"g5Executed":false,"g6Executed":false,"mailExecuted":false}))
}

#[test]
#[ignore = "Explicit populated A41 continuation; real paid sessions, existing API token and new fictitious source only"]
fn populated_head_new_source_across_two_new_native_stores() {
    if tauri::async_runtime::block_on(execute_continuation()).is_err() { panic!("ZENTRA_A41_CONTINUATION_REFUSED"); }
}
