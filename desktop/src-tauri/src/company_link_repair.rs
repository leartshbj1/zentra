//! Operator-only repair of a stale company link on an otherwise empty installation.
//! It uses the existing snapshot publication protocol, including CAS and numbering.
use super::*;

fn require_empty_records(store: &LocalStore, previous_org: &str) -> AppResult<()> {
    let prefs = load(store)?;
    if previous_org.is_empty() || prefs.organization_id.as_deref() != Some(previous_org)
        || prefs.pending.is_some() || prefs.received.is_some() || prefs.conflict
        || prefs.duplicate_receipt.is_some() {
        return Err(invalid("Le lien ou les données ont changé. La réparation est arrêtée."));
    }
    let db = store.connect()?;
    for row in query_all(&db, "SELECT name FROM sqlite_master WHERE type='table'", [])? {
        let name = row["name"].as_str().ok_or_else(|| invalid("Table inconnue."))?;
        // Preserve configuration and logos. Everything else must be empty, including
        // document number reservations and per-project synchronization bindings.
        if name.starts_with("sqlite_") || name.starts_with("company_local_")
            || ["settings", "company_brand_assets", "license_state"].contains(&name) { continue; }
        if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            return Err(invalid("Table inconnue."));
        }
        let occupied: bool = db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM \"{name}\")"), [], |r| r.get(0))?;
        if occupied { return Err(invalid("Cette entreprise contient des données. La réparation automatique est refusée.")); }
    }
    Ok(())
}

#[cfg(feature = "maintenance")]
pub(crate) async fn run(store: &LocalStore, email: &str, previous_org: &str) -> AppResult<Value> {
    let _account = store.account_protected_cache.operation_lock.lock().await;
    let _transfer = crate::cloud_backup::TransferGuard::take()?;
    let _sync = crate::project_sync::pause_for_workspace_change()?;
    require_empty_records(store, previous_org)?;
    let session = project_sync_session(store).await?.ok_or_else(|| invalid("Reconnectez le compte propriétaire."))?;
    if session.role != "owner" || session.organization_id == previous_org {
        return Err(invalid("Le compte propriétaire de destination doit être vérifié."));
    }
    let (_, bytes) = session.request(Method::GET, "/api/account/me", &[], &[], None, false).await?;
    let me: Value = serde_json::from_slice(&bytes)?;
    if !me["email"].as_str().is_some_and(|value| value.eq_ignore_ascii_case(email))
        || me["organization"]["id"].as_str() != Some(&session.organization_id)
        || me["organization"]["role"] != "owner"
        || me["installationId"].as_str() != Some(&store.installation_id) {
        return Err(invalid("Le compte ne correspond pas au propriétaire attendu."));
    }
    let head = request(&session, Method::GET, &[], None).await?;
    if checked_head(&session, &head)? != 0 || head["snapshotId"].is_string() || head["enabled"] == true {
        return Err(invalid("Une entreprise est déjà partagée sur ce compte. Aucun remplacement n’est autorisé."));
    }
    if !store.app_state(env!("CARGO_PKG_VERSION"))?.onboarding_completed {
        return Err(invalid("Terminez la configuration de l’entreprise."));
    }
    {
        let _local = store.lock()?;
        require_empty_records(store, previous_org)?;
        let backup_dir = store.backups_dir.join(format!("avant-rattachement-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&backup_dir)?;
        store.create_backup_at(&backup_dir.join("entreprise.zentra"), env!("CARGO_PKG_VERSION"))?;
        for name in [STATE, "company-sync-baseline.json", "company-sync-reference.zentra"] {
            let source = store.data_dir.join(name);
            if source.is_file() { fs::copy(source, backup_dir.join(name))?; }
        }
        save(store, &Preferences::default())?;
    }
    // From here on, an interrupted request keeps a resumable pending snapshot for
    // the verified account. Never restore the old link after an uncertain commit.
    if !send(store, &session, true, head["contentTransfer"] == 1).await? {
        return Err(invalid("La destination a changé. Comparez les versions avant de continuer."));
    }
    crate::shared_numbering::replenish_active_series(store, &session).await?;
    let head = request(&session, Method::GET, &[], None).await?;
    let local = status(store)?;
    if checked_head(&session, &head)? == 0 || head["revision"] != local["revision"]
        || local["pending"] == true || local["conflict"] == true {
        return Err(invalid("La confirmation finale de synchronisation doit être vérifiée."));
    }
    crate::automation::bound(store, &session.organization_id)?;
    let (_, bytes) = session.request(Method::GET, "/api/automation", &[], &[], None, false).await?;
    let automation: Value = serde_json::from_slice(&bytes)?;
    crate::automation::validate_response(store, &session.organization_id, &automation)?;
    Ok(json!({"repaired":true,"revision":local["revision"],"pending":false,"automationActive":automation["active"],"organizationName":me["organization"]["name"],"backupPreserved":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repair_refuses_records_number_binding_and_inflight_changes() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().into()).unwrap();
        let mut prefs = Preferences { organization_id: Some("old".into()), base_clock: clock(&store).unwrap(), ..Default::default() };
        save(&store, &prefs).unwrap();
        assert!(require_empty_records(&store, "old").is_ok());
        // An old synchronization clock can survive a reset. Empty tables, not
        // counters from different database lifetimes, decide eligibility.
        prefs.base_clock = 442; save(&store, &prefs).unwrap();
        assert!(require_empty_records(&store, "old").is_ok());
        assert!(require_empty_records(&store, "other").is_err());
        prefs.conflict = true; save(&store, &prefs).unwrap();
        assert!(require_empty_records(&store, "old").is_err());
        prefs.conflict = false; save(&store, &prefs).unwrap();
        store.connect().unwrap().execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('c','Client','now','now')", []).unwrap();
        prefs.base_clock = clock(&store).unwrap(); save(&store, &prefs).unwrap();
        assert!(require_empty_records(&store, "old").is_err());
        store.connect().unwrap().execute("DELETE FROM clients", []).unwrap();
        store.connect().unwrap().execute("INSERT INTO shared_numbering_binding VALUES(1,'old','now')", []).unwrap();
        prefs.base_clock = clock(&store).unwrap(); save(&store, &prefs).unwrap();
        assert!(require_empty_records(&store, "old").is_err());
    }
}
