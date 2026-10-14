//! Explicit future campaign only. Existing A41 history is never re-prepared.
use super::*;
use crate::account_cloud::action_engine::continuation_support::g5 as staged;

#[path = "account_cloud_live_a41_product_frontdoor_tests.rs"]
mod product_frontdoor;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pin { revision: u64, snapshot_id: String, archive_sha256: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved { quotes: i64, receipts: i64, resources: String, customer: String, article: String }
impl Saved {
    fn capture(v: Baseline) -> Self { Self { quotes:v.quotes,receipts:v.receipts,resources:v.resources,customer:v.customer,article:v.article } }
    fn value(&self) -> Baseline { Baseline { quotes:self.quotes,receipts:self.receipts,resources:self.resources.clone(),customer:self.customer.clone(),article:self.article.clone() } }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input { format: String, sites_service_token: String, root_dir: String, installations: Vec<AccountBaseline>,
    source_sha: String, campaign_id: String, expected_baseline: Pin, phase: u8, selected: Option<staged::Selected>, saved: Option<Saved>,
    reviews: Option<Vec<ReviewItem>>, consent_revisions: Option<Vec<u64>> }

fn admitted(phase:u8) -> RecipeResult<(Pipe,Input)> {
    if option_env!("ZENTRA_ACTION_NATIVE_TEST_CONTEXT")!=Some("live-sandbox-a41")
        || std::env::var("CIRCLECI").as_deref()!=Ok("true") || std::env::var("CIRCLE_BRANCH").as_deref()!=Ok("codex/action-engine-native-live-a41")
        || std::env::var("ZENTRA_RUN_LIVE_G5_RECIPE").as_deref()!=Ok("true")
        || std::env::var("ZENTRA_RUN_LIVE_G4_RECIPE").is_ok() || std::env::var("ZENTRA_RUN_LIVE_G4_CONTINUATION").is_ok() { return Err(()); }
    let profile=crate::native_test_profile::require().map_err(|_| ())?;
    if profile.sha256()!=PROFILE_SHA || profile.site_origin()!=SITE || profile.license_kid()!="sandbox-action-engine-a41"
        || base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(profile.license_key())!="hLFfY6E43JD0Sz-gUOrhOHY8mxQHqyu2875H2oXPQb0" { return Err(()); }
    let challenge:Challenge=read_message(&mut std::io::stdin().lock())?;
    if challenge.challenge.len()!=43 || !challenge.challenge.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_') { return Err(()); }
    let name=std::env::var("ZENTRA_A41_G5_PIPE").map_err(|_| ())?;
    crate::cloud_backup::validate_id(name.strip_prefix(r"\\.\pipe\zentra-a41-g5-").ok_or(())?).map_err(|_| ())?;
    let mut pipe=Pipe(std::fs::OpenOptions::new().read(true).write(true).open(name).map_err(|_| ())?);
    pipe.write(json!({"event":"hello","challenge":challenge.challenge}))?;
    let input:Input=pipe.read()?;
    if input.format!="zentra-a41-g5-private-v1" || input.phase!=phase || input.installations.len()!=2
        || input.installations[0].installation_id==input.installations[1].installation_id
        || input.source_sha.len()!=40 || !input.source_sha.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))
        || option_env!("CIRCLE_SHA1")!=Some(input.source_sha.as_str()) || std::env::var("CIRCLE_SHA1").as_deref()!=Ok(input.source_sha.as_str())
        || input.expected_baseline.revision<1 || input.expected_baseline.revision>9_007_199_254_740_990 { return Err(()); }
    crate::cloud_backup::validate_id(&input.campaign_id).map_err(|_| ())?;
    crate::cloud_backup::validate_id(&input.expected_baseline.snapshot_id).map_err(|_| ())?;
    if input.expected_baseline.archive_sha256.len()!=64 || !input.expected_baseline.archive_sha256.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)) { return Err(()); }
    if (phase==0 && (input.selected.is_some() || input.saved.is_some() || input.reviews.is_some() || input.consent_revisions.is_some()))
        || (phase>0 && (input.selected.is_none() || input.saved.is_none() || input.reviews.is_none() || input.consent_revisions.is_none())) { return Err(()); }
    crate::native_test_profile::install_sites_access_token(&input.sites_service_token).map_err(|_| ())?;
    Ok((pipe,input))
}
async fn baseline_head(store:&LocalStore,pin:&Pin)->RecipeResult<collaboration::LivePublication> {
    let session=read_session_secret(store).map_err(|_| ())?.ok_or(())?;
    let(status,bytes)=account_request(Method::GET,crate::company_collaboration::PATH,None,Some(&session.session_token)).await.map_err(|_| ())?;
    if status!=StatusCode::OK { return Err(()); }
    let head:Head=serde_json::from_slice(&bytes).map_err(|_| ())?;
    if head.organization_id!=ORGANIZATION || head.user_id!=OWNER || head.role!="owner" || !head.enabled
        || head.revision!=pin.revision || head.snapshot_id!=pin.snapshot_id || head.manifest.sha256!=pin.archive_sha256
        || head.content_transfer!=1 || head.content_version!=1 { return Err(()); }
    head.manifest.validate().map_err(|_| ())?;
    Ok(collaboration::LivePublication{snapshot_id:head.snapshot_id,base_revision:head.revision-1,revision:head.revision,manifest:head.manifest})
}
fn pending_activity_absent(store:&LocalStore)->RecipeResult<()> { activity_count(store,None).map(|_|()) }
async fn review_inventory(store:&LocalStore)->RecipeResult<Vec<ReviewItem>> {
    let session=read_session_secret(store).map_err(|_| ())?.ok_or(())?;
    let mut url=endpoint(REVIEW_PATH).map_err(|_| ())?;url.query_pairs_mut().append_pair("limit","50");
    let(status,bytes)=account_request_url(Method::GET,url,None,Some(&session.session_token),TOTAL_TIMEOUT).await.map_err(|_| ())?;
    if status!=StatusCode::OK { return Err(()); }
    let page:ReviewPage=serde_json::from_slice(&bytes).map_err(|_| ())?;
    if page.organization_id!=ORGANIZATION || !page.next_cursor.is_null() || page.items.len()<2 || page.items.len()>50 { return Err(()); }
    for(index,item)in page.items.iter().enumerate(){
        crate::cloud_backup::validate_id(&item.proposal_id).map_err(|_| ())?;crate::cloud_backup::validate_id(&item.source_id).map_err(|_| ())?;
        if item.created_at==0 || item.created_at>253402300799 || item.disposition!="needs_review" || !item.requires_human_validation
            || item.reasons.is_empty() || item.reasons.len()>13 || item.reasons.iter().enumerate().any(|(at,r)|item.reasons[..at].contains(r))
            || page.items[..index].iter().any(|old|old.proposal_id==item.proposal_id || old.source_id==item.source_id) { return Err(()); }
    }
    Ok(page.items)
}
fn stop_at(pipe:&mut Pipe,event:Value)->RecipeResult<()> {
    pipe.write(event)?;
    // No in-process restart/continuation. Node must kill/reap this OS process.
    let _:Challenge=pipe.read()?;
    Err(())
}
async fn execute_phase(phase:u8)->RecipeResult<()> {
    let(mut pipe,input)=admitted(phase)?;
    let root=retained_root(&input.root_dir)?;
    let a=open_existing(&root,"device-a")?;let b=open_existing(&root,"device-b")?;
    strict_account(&a,&input.installations[0]).await?;strict_account(&b,&input.installations[1]).await?;
    let consents=vec![existing_consent(&a).await?,existing_consent(&b).await?];
    let history=historical_review(&a).await?;
    if historical_review(&b).await?!=history { return Err(()); }
    let reviews=review_inventory(&a).await?;
    if review_inventory(&b).await?!=reviews || (phase>0 && (input.reviews.as_ref()!=Some(&reviews) || input.consent_revisions.as_ref()!=Some(&consents))) { return Err(()); }
    if phase==0 {
        let head=baseline_head(&a,&input.expected_baseline).await?;
        collaboration::receive_exact(&a,&head,true).await.map_err(|_| ())?;
        collaboration::receive_exact(&b,&head,true).await.map_err(|_| ())?;
        if baseline_head(&a,&input.expected_baseline).await?!=head || baseline_head(&b,&input.expected_baseline).await?!=head { return Err(()); }
        let saved=Saved::capture(business_baseline(&a)?);
        if business_baseline(&b)?!=saved.value() { return Err(()); }
        pending_activity_absent(&a)?;pending_activity_absent(&b)?;
        pipe.write(json!({"event":"g5-baseline","campaignId":input.campaign_id,"baseline":baseline_receipt(&head)?,"historicalReview":history,
            "saved":saved,"consentRevisions":consents,"preexistingReviews":reviews}))?;
        let source:SourceReady=pipe.read()?;
        if source.event!="source-ready" || source.source_id==OLD_SOURCE { return Err(()); }
        crate::cloud_backup::validate_id(&source.source_id).map_err(|_| ())?;
        let prepared=staged::prepare_and_write_once(&a,&source.source_id).await.map_err(|_| ())?;
        if prepared.disposition==protocol::QuoteWorkDisposition::NeedsReview {
            let after=review_inventory(&a).await?;
            if business_baseline(&a)?!=saved.value() || historical_review(&a).await?!=history || after.len()!=reviews.len()+1
                || !reviews.iter().all(|prior|after.contains(prior)) { return Err(()); }
            pipe.write(json!({"event":"new-source-review","historicalReviewPreserved":true,"newSourceId":source.source_id,
                "newProposalId":prepared.proposal_id,"reasons":prepared.reasons,"nominalG4Passed":false}))?;
            return Err(());
        }
        let after=business_baseline(&a)?;
        if after.quotes!=saved.quotes+1 || after.receipts!=saved.receipts+1 || after.resources!=saved.resources { return Err(()); }
        pending_activity_absent(&a)?;
        return stop_at(&mut pipe,json!({"event":"writer-durable","selected":staged::Selected{source_id:prepared.source_id,proposal_id:prepared.proposal_id,fingerprint:prepared.fingerprint},"saved":saved,"localAck":false}));
    }
    let selected=input.selected.as_ref().ok_or(())?;let saved=input.saved.as_ref().ok_or(())?;
    if phase==1 {
        baseline_head(&a,&input.expected_baseline).await?;
        let publication=staged::publish_and_lose_commit(&a,selected).await.map_err(|_| ())?;
        if publication.base_revision!=input.expected_baseline.revision || publication.revision!=publication.base_revision+1 { return Err(()); }
        pending_activity_absent(&a)?;
        return stop_at(&mut pipe,json!({"event":"commit-response-discarded","publication":publication.public_proof().map_err(|_| ())?,"httpStatus":200,"localAck":false}));
    }
    if phase==2 {
        let publication=staged::recover_and_lose_confirmation(&a,selected).await.map_err(|_| ())?;
        pending_activity_absent(&a)?;
        return stop_at(&mut pipe,json!({"event":"confirmation-response-discarded","publication":publication.public_proof().map_err(|_| ())?,"httpStatus":200,"localAck":false}));
    }
    if phase==3 {
        staged::resume_exact_and_ack(&a,selected).await.map_err(|_| ())?;
        let proof=new_quote_proof(&a,&selected.source_id,&saved.value())?;
        if proof["proposalId"]!=selected.proposal_id || proof["fingerprint"]!=selected.fingerprint { return Err(()); }
        let canonical=collaboration::acknowledged_publication(&a,&selected.proposal_id).map_err(|_| ())?;
        collaboration::corroborate_writer(&a,&canonical).await.map_err(|_| ())?;
        collaboration::receive_exact(&b,&canonical,false).await.map_err(|_| ())?;
        if new_quote_proof(&b,&selected.source_id,&saved.value())?!=proof { return Err(()); }
        return pipe.write(json!({"event":"ack-and-receive","publication":canonical.public_proof().map_err(|_| ())?,"quote":proof,"localAck":true,"secondStoreExactCreation":true}));
    }
    if phase!=4 { return Err(()); }
    let proof=new_quote_proof(&a,&selected.source_id,&saved.value())?;
    if proof["proposalId"]!=selected.proposal_id || proof["fingerprint"]!=selected.fingerprint
        || new_quote_proof(&b,&selected.source_id,&saved.value())?!=proof { return Err(()); }
    let quote=proof["quoteId"].as_str().ok_or(())?;
    activity_count(&a,Some(quote))?;activity_count(&b,None)?;
    let canonical=collaboration::acknowledged_publication(&a,&selected.proposal_id).map_err(|_| ())?;
    collaboration::corroborate_writer(&a,&canonical).await.map_err(|_| ())?;
    if canonical.base_revision!=input.expected_baseline.revision || historical_review(&a).await?!=history { return Err(()); }
    pipe.write(json!({"event":"g5-complete","publication":canonical.public_proof().map_err(|_| ())?,"quote":proof,"historicalReview":history,
        "writerActivityCount":1,"secondStoreActivityCount":0,"bothReopenedInNewProcess":true,"historicalPreparationRequests":0,
        "freshPreparationRequests":1,"preexistingReviewCount":reviews.len(),"preexistingReviewProjectionPreserved":true,
        "fullG5Passed":false,"g6Passed":false,"mailExecuted":false,"schedulerExecuted":false}))
}
macro_rules! phase_test { ($name:ident,$phase:expr)=>{
    #[test]
    #[ignore="Explicit future A41 G5 campaign, real HTTPS and same-job private stores only"]
    fn $name(){if tauri::async_runtime::block_on(execute_phase($phase)).is_err(){panic!("ZENTRA_A41_G5_PHASE_REFUSED");}}
}; }
phase_test!(fresh_source_writer_durable_before_process_stop,0);
phase_test!(real_publication_commit_response_loss_before_process_stop,1);
phase_test!(real_confirmation_response_loss_before_local_ack_and_process_stop,2);
phase_test!(recover_exact_confirmation_ack_and_receive_second_store,3);
phase_test!(reopen_both_stores_after_ack_without_new_preparation,4);
