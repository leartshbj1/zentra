use super::*;
use crate::error::AppError;
use crate::business_sync::retirement::{
    cancellation::durable as cancellation, Request as RetirementRequest,
};
use reqwest::StatusCode;
impl cancellation::Transport for Server {
    async fn cancellation_get(&self, _: &str) -> AppResult<(StatusCode, Vec<u8>)> {
        self.calls.lock().unwrap().push("cancellation_get".into());
        Ok((StatusCode::NOT_FOUND, vec![]))
    }
    async fn cancellation_post(&self, body: Vec<u8>) -> AppResult<(StatusCode, Vec<u8>)> {
        self.calls.lock().unwrap().push("cancellation_post".into());
        let request: RetirementRequest = serde_json::from_slice(&body).unwrap();
        let mut proof = serde_json::to_value(&request).unwrap();
        proof["format"] = json!("zentra-conflict-retirement-cancellation");
        proof["version"] = json!(1);
        proof["organization_id"] = json!(self.header.binding.organization);
        proof["installation_id"] = json!(self.header.binding.installation);
        proof["binding_sha256"] = json!(request.binding_sha256().unwrap());
        proof["registered_at"] = json!("2026-09-10T00:00:00Z");
        proof["cancelled"] = json!(true);
        proof["retired"] = json!(false);
        proof["business_revision_changed"] = json!(false);
        proof["transaction_acknowledged"] = json!(false);
        Ok((StatusCode::OK, serde_json::to_vec(&proof).unwrap()))
    }
}

#[test]
fn coordinated_cancellation_releases_only_exact_proof_and_keeps_accepted_choice_installable() {
    tauri::async_runtime::block_on(async {
        for accepted in [false, true] {
            let f = prepared_with_mode(Choice::Shared, false, accepted).await;
            let id = f.frozen.intent.resolution_id.clone();
            let transaction = f.frozen.intent.received_transaction_id.clone();
            let capture = f.frozen.intent.capture_generation.clone();
            let original = evidence(&f.local, &capture);
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let count = calls.clone();
            let pending = cycle::pass(f.local.clone(), f.transport.clone(), true)
                .await
                .unwrap();
            assert_eq!(pending["state"], "conflict");
            assert_eq!(pending["detail"]["state"], "resolution_pending");
            assert_eq!(pending["detail"]["resolution"]["resolution_id"], id);
            assert_eq!(pending["detail"]["resolution"]["accepted"], accepted);
            assert!(application::cancel_saved(
                f.local.clone(),
                f.transport.clone(),
                "other".into(),
                id.clone(),
                Arc::new(|| panic!("Wrong transaction permission"))
            )
            .await
            .is_err());
            assert!(application::cancel_saved(
                f.local.clone(),
                f.transport.clone(),
                transaction.clone(),
                id.clone(),
                Arc::new(|| Err(AppError::BusinessInstallDeferred))
            )
            .await
            .is_err());
            assert!(durable::load(&f.local.connect().unwrap(), &f.local)
                .unwrap()
                .is_some());
            let result = application::cancel_saved(
                f.local.clone(),
                f.transport.clone(),
                transaction.clone(),
                id.clone(),
                Arc::new(move || {
                    count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
            .unwrap();
            assert_eq!(result["workspace_changed"], accepted);
            assert_eq!(
                result[if accepted { "installed" } else { "cancelled" }],
                true
            );
            assert_eq!(evidence(&f.local, &capture), original);
            assert_eq!(acknowledged(&f.local), 0);
            assert!(durable::load(&f.local.connect().unwrap(), &f.local)
                .unwrap()
                .is_none());
            assert_eq!(
                fs::read(f.local.attachments_dir.join("drawing.txt")).unwrap(),
                if accepted {
                    b"shared version".as_slice()
                } else {
                    b"local version".as_slice()
                }
            );
            assert_eq!(
                calls.load(std::sync::atomic::Ordering::SeqCst),
                if accepted { 2 } else { 1 }
            );
            if !accepted {
                let before_calls = f.transport.transport.calls.lock().unwrap().len();
                let retry = application::cancel_saved(
                    f.local.clone(),
                    f.transport.clone(),
                    transaction,
                    id,
                    Arc::new(|| Ok(())),
                )
                .await
                .unwrap();
                assert_eq!(retry["already_cancelled"], true);
                assert_eq!(
                    f.transport.transport.calls.lock().unwrap().len(),
                    before_calls
                );
                f.local
                    .connect()
                    .unwrap()
                    .execute("UPDATE clients SET name='After cancellation'", [])
                    .unwrap();
            }
        }
    });
}
