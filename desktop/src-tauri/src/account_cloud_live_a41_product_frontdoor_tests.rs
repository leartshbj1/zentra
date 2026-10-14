//! One future campaign through the six real native handlers, not WebView IPC.
use super::*;
use crate::account_cloud::action_engine::supervisor::live_frontdoor as frontdoor;

const SNAPSHOT: &str = "5da31610-80c6-4b34-ba76-bbb7d555ee79";
const ARCHIVE: &str = "43c43667109f82f9eda395de658eaa5049f30aecd4eb9ffd240f34103afb7236";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input { format: String, sites_service_token: String, root_dir: String, installations: Vec<AccountBaseline>,
    source_sha: String, campaign_id: String, expected_baseline: Pin }

fn admitted() -> RecipeResult<(Pipe,Input)> {
    frontdoor::require_recipe_environment().map_err(|_| ())?;
    let challenge: Challenge = read_message(&mut std::io::stdin().lock())?;
    if challenge.challenge.len()!=43 || !challenge.challenge.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_') { return Err(()); }
    let name=std::env::var("ZENTRA_A41_PRODUCT_FRONTDOOR_PIPE").map_err(|_| ())?;
    crate::cloud_backup::validate_id(name.strip_prefix(r"\\.\pipe\zentra-a41-product-frontdoor-").ok_or(())?).map_err(|_| ())?;
    let mut pipe=Pipe(std::fs::OpenOptions::new().read(true).write(true).open(name).map_err(|_| ())?);
    pipe.write(json!({"event":"hello","challenge":challenge.challenge}))?;
    let input: Input=pipe.read()?;
    if input.format!="zentra-a41-product-frontdoor-private-v1" || input.installations.len()!=2
        || input.installations[0].installation_id==input.installations[1].installation_id
        || input.source_sha.len()!=40 || !input.source_sha.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))
        || option_env!("CIRCLE_SHA1")!=Some(input.source_sha.as_str()) || std::env::var("CIRCLE_SHA1").as_deref()!=Ok(input.source_sha.as_str())
        || input.expected_baseline.revision!=2 || input.expected_baseline.snapshot_id!=SNAPSHOT || input.expected_baseline.archive_sha256!=ARCHIVE { return Err(()); }
    crate::cloud_backup::validate_id(&input.campaign_id).map_err(|_| ())?;
    crate::native_test_profile::install_sites_access_token(&input.sites_service_token).map_err(|_| ())?;
    Ok((pipe,input))
}
fn public_page(value:&Value,field:&str)->RecipeResult<Vec<Value>> {
    if value["status"]!="available" || value["organizationId"]!=ORGANIZATION || value["data"]["organizationId"]!=ORGANIZATION
        || !value["data"]["nextCursor"].is_null() { return Err(()); }
    let rows=value["data"]["items"].as_array().ok_or(())?;
    if rows.len()>50 || rows.iter().any(|row|row[field].as_str().is_none()) { return Err(()); }
    Ok(rows.clone())
}
async fn execute() -> RecipeResult<()> {
    let(mut pipe,input)=admitted()?;
    let root=retained_root(&input.root_dir)?;
    let a=open_existing(&root,"device-a")?;let b=open_existing(&root,"device-b")?;
    strict_account(&a,&input.installations[0]).await?;strict_account(&b,&input.installations[1]).await?;
    let consents=vec![existing_consent(&a).await?,existing_consent(&b).await?];
    let history=historical_review(&a).await?;let reviews=review_inventory(&a).await?;
    if reviews.len()>19 || historical_review(&b).await?!=history || review_inventory(&b).await?!=reviews { return Err(()); }
    let head=baseline_head(&a,&input.expected_baseline).await?;
    collaboration::receive_exact(&a,&head,true).await.map_err(|_| ())?;
    collaboration::receive_exact(&b,&head,true).await.map_err(|_| ())?;
    if baseline_head(&a,&input.expected_baseline).await?!=head || baseline_head(&b,&input.expected_baseline).await?!=head { return Err(()); }
    let saved=Saved::capture(business_baseline(&a)?);
    if saved.quotes<1 || saved.receipts<1 || business_baseline(&b)?!=saved.value() { return Err(()); }
    pending_activity_absent(&a)?;pending_activity_absent(&b)?;
    pipe.write(json!({"event":"frontdoor-baseline","campaignId":input.campaign_id,"baseline":baseline_receipt(&head)?,"historicalReview":history,
        "saved":saved,"consentRevisions":consents,"preexistingReviews":reviews}))?;
    let source:SourceReady=pipe.read()?;
    if source.event!="source-ready" || source.source_id==OLD_SOURCE || reviews.iter().any(|row|row.source_id==source.source_id) { return Err(()); }
    crate::cloud_backup::validate_id(&source.source_id).map_err(|_| ())?;
    let observed=frontdoor::exercise_once(&a).await.map_err(|_| ())?;
    let observations=observed.as_array().filter(|rows|rows.len()==8).ok_or(())?;
    let before=public_page(&observations[3],"proposalId")?;
    if before!=serde_json::to_value(&reviews).map_err(|_| ())?.as_array().ok_or(())?.clone() { return Err(()); }
    let activity_before=public_page(&observations[4],"activityId")?;
    let tick=&observations[5];
    let after=public_page(&observations[6],"proposalId")?;
    let activity_after=public_page(&observations[7],"activityId")?;
    if tick["phase"]!="page" || tick["roundComplete"]!=true || tick["hasMore"]!=false || tick["pendingRecovery"]!=false {
        let code=tick["code"].as_str().filter(|v|matches!(*v,"forbidden"|"conflict"|"context_changed"|"busy"|"rate_limited"|"quota_exhausted"|"service_unavailable")).unwrap_or("service_unavailable");
        pipe.write(json!({"event":"frontdoor-refused","code":code,"nominalPassed":false}))?;return Err(());
    }
    if tick["counts"]["confirmed"]==0 {
        let fresh=after.iter().find(|row|row["sourceId"]==source.source_id).ok_or(())?;
        if business_baseline(&a)?!=saved.value() || !before.iter().all(|row|after.contains(row)) || after.len()!=before.len()+1 { return Err(()); }
        pipe.write(json!({"event":"new-source-review","historicalReviewPreserved":true,"newSourceId":source.source_id,
            "newProposalId":fresh["proposalId"],"reasons":fresh["reasons"],"nominalG4Passed":false}))?;return Err(());
    }
    if tick["counts"]["confirmed"]!=1 || tick["counts"]["held"]!=0 || tick["counts"]["reviewRequired"]!=reviews.len()
        || tick["status"]!="needs_review" || after!=before || activity_after.len()!=activity_before.len()+1
        || !activity_before.iter().all(|row|activity_after.contains(row)) { return Err(()); }
    let proof=new_quote_proof(&a,&source.source_id,&saved.value())?;
    let quote=proof["quoteId"].as_str().ok_or(())?;let proposal=proof["proposalId"].as_str().ok_or(())?;
    if activity_after.iter().filter(|row|row["quoteId"]==quote && row["proposalId"]==proposal).count()!=1 { return Err(()); }
    activity_count(&a,Some(quote))?;activity_count(&b,None)?;
    let canonical=collaboration::acknowledged_publication(&a,proposal).map_err(|_| ())?;
    if canonical.base_revision!=2 || canonical.revision!=3 { return Err(()); }
    collaboration::corroborate_writer(&a,&canonical).await.map_err(|_| ())?;
    collaboration::receive_exact(&b,&canonical,false).await.map_err(|_| ())?;
    if new_quote_proof(&b,&source.source_id,&saved.value())?!=proof { return Err(()); }
    drop(a);drop(b);
    let a=open_existing(&root,"device-a")?;let b=open_existing(&root,"device-b")?;
    strict_account(&a,&input.installations[0]).await?;strict_account(&b,&input.installations[1]).await?;
    if new_quote_proof(&a,&source.source_id,&saved.value())?!=proof || new_quote_proof(&b,&source.source_id,&saved.value())?!=proof
        || review_inventory(&a).await?!=reviews || review_inventory(&b).await?!=reviews
        || vec![existing_consent(&a).await?,existing_consent(&b).await?]!=consents
        || collaboration::acknowledged_publication(&a,proposal).map_err(|_| ())?!=canonical { return Err(()); }
    activity_count(&a,Some(quote))?;activity_count(&b,None)?;
    collaboration::corroborate_writer(&a,&canonical).await.map_err(|_| ())?;
    pipe.write(json!({"event":"frontdoor-complete","campaignId":input.campaign_id,"publication":canonical.public_proof().map_err(|_| ())?,"quote":proof,
        "actualHandlers":6,"ticks":1,"confirmed":1,"historicalReviewCount":reviews.len(),"historicalReviewProjectionPreserved":true,
        "consentCas":"stale_conflict","consentRevisionsUnchanged":true,"activityDelta":1,"localWriterAck":true,"secondStoreExactCreation":true,
        "bothStoresReopened":true,"separateBusinessProcesses":false,"webviewInvocationProved":false,"distributedProductGateOpened":false,
        "successfulConsentWriteProved":false,"realDecisionProviderDirectlyAttested":false,"g5Passed":false,"g6Passed":false,"mailExecuted":false,"schedulerExecuted":false}))
}
#[test]
#[ignore="Explicit future A41 native product frontdoor, real HTTPS, one fresh source only"]
fn actual_six_handlers_process_one_fresh_source_on_current_head() {
    if tauri::async_runtime::block_on(execute()).is_err() { panic!("ZENTRA_A41_PRODUCT_FRONTDOOR_REFUSED"); }
}
