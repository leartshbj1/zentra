//! Explicit live acceptance only; this does not enable native replication.
use super::*;

async fn request(
    session: &ProjectSyncSession,
    remote: &RemoteStatus,
    method: Method,
) -> AppResult<Value> {
    let body = (method == Method::POST)
        .then(|| serde_json::to_vec(&json!({"transfer_id":remote.transfer_id})))
        .transpose()?;
    let (status, bytes) = ProjectSyncSession::request(
        session,
        method,
        "/api/sync/bootstrap/structure",
        &[("transfer_id", remote.transfer_id.as_str())],
        &[("content-type", "application/json".to_owned())],
        body,
        false,
    )
    .await?;
    if !status.is_success() {
        return Err(invalid("Live structural verification was rejected."));
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    assert_eq!(value["transfer_id"], remote.transfer_id);
    assert_eq!(value["manifest_sha256"], remote.manifest_sha256);
    assert_eq!(value["generation"], remote.generation);
    assert_eq!(value["replication_active"], false);
    assert!(value["validator_sha256"]
        .as_str()
        .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())));
    assert!(value["total_rules"]
        .as_u64()
        .is_some_and(|count| count > 500 && count < 1600));
    assert!(value["checked_rules"]
        .as_u64()
        .is_some_and(|count| count <= value["total_rules"].as_u64().unwrap()));
    Ok(value)
}

pub(super) async fn run(session: &ProjectSyncSession, remote: &RemoteStatus) -> AppResult<()> {
    let initial = request(session, remote, Method::GET).await?;
    assert_eq!(initial["state"], "pending");
    assert_eq!(initial["checked_rules"], 0);
    let mut previous = initial;
    let mut calls = 0;
    let mut skipped_empty_span = false;
    for _ in 0..100 {
        let current = request(session, remote, Method::POST).await?;
        calls += 1;
        assert_eq!(current["validator_sha256"], previous["validator_sha256"]);
        assert_eq!(current["total_rules"], previous["total_rules"]);
        assert_eq!(
            current["failed_rule"],
            Value::Null,
            "Rejected structural rule: {}",
            current["failed_rule"]
        );
        let advanced = current["checked_rules"].as_u64().unwrap()
            - previous["checked_rules"].as_u64().unwrap();
        assert!(advanced > 0);
        skipped_empty_span |= advanced > 16;
        if calls == 1 {
            // Recover the server cursor without relying on the POST response.
            assert_eq!(request(session, remote, Method::GET).await?, current);
        }
        if calls % 8 == 0 {
            println!(
                "QA_STRUCTURE_PROGRESS checked={} total={}",
                current["checked_rules"], current["total_rules"]
            );
        }
        previous = current;
        if previous["state"] == "valid" {
            break;
        }
        assert_eq!(previous["state"], "checking");
    }
    assert_eq!(previous["state"], "valid");
    assert!(skipped_empty_span);
    assert_eq!(request(session, remote, Method::GET).await?, previous);
    assert_eq!(request(session, remote, Method::POST).await?, previous);
    println!("QA_STRUCTURE_COMPLETE transfer={} rules={} requests={} cursor_recovered=true replay_stable=true replication_active=false validator={}",remote.transfer_id,previous["total_rules"],calls,previous["validator_sha256"]);
    println!("QA_STRUCTURE_SPARSE skipped_empty_spans=true");
    Ok(())
}
