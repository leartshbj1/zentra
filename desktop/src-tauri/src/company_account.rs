//! Resolve an account's company before opening the local workspace. Login is
//! not a company switch: unrelated local data always requires an explicit choice.
use super::*;

#[derive(Debug, PartialEq)]
enum Decision {
    Ready,
    Receive,
    Publish,
    Choose,
    Create,
    Wait,
}

pub(crate) fn bind_new_company(store: &LocalStore, org: &str) -> AppResult<()> {
    let prefs = load(store)?;
    if prefs.organization_id.is_some() || prefs.pending.is_some() {
        return Ok(());
    }
    save(
        store,
        &Preferences {
            organization_id: Some(org.into()),
            base_clock: -1,
            ..Default::default()
        },
    )
}

fn decide(
    bound: Option<&str>,
    organization: &str,
    configured: bool,
    empty: bool,
    remote: bool,
    revision: u64,
    choice: &str,
    manager: bool,
) -> Decision {
    if configured && bound == Some(organization) && revision > 0 {
        return Decision::Ready;
    }
    if remote {
        return if empty || choice == "open" {
            Decision::Receive
        } else {
            Decision::Choose
        };
    }
    if bound.is_some_and(|id| id != organization) {
        return Decision::Wait;
    }
    if configured {
        return if manager && (choice == "publish" || bound == Some(organization)) {
            Decision::Publish
        } else if manager {
            Decision::Choose
        } else {
            Decision::Wait
        };
    }
    if empty && manager {
        Decision::Create
    } else {
        Decision::Wait
    }
}

#[tauri::command]
pub async fn resolve_connected_company(
    state: State<'_, LocalStore>,
    organization_id: String,
    choice: Option<String>,
) -> Result<Value, String> {
    let store = state.inner().clone();
    let _account = store.account_protected_cache.operation_lock.lock().await;
    resolve(
        &store,
        &organization_id,
        choice.as_deref().unwrap_or("auto"),
    )
    .await
    .map_err(command_error)
}

async fn resolve(store: &LocalStore, organization: &str, choice: &str) -> AppResult<Value> {
    if !["auto", "open", "publish"].contains(&choice) {
        return Err(invalid("Choisissez l’entreprise à ouvrir."));
    }
    let session = project_sync_session(store)
        .await?
        .ok_or_else(|| invalid("Connectez votre compte Zentra."))?;
    if session.organization_id != organization {
        return Err(invalid("Le compte a changé. Recommencez la connexion."));
    }
    let prefs = load(store)?;
    let configured = store
        .app_state(env!("CARGO_PKG_VERSION"))?
        .onboarding_completed;
    // An already-bound workspace remains usable offline. Ordinary sync rechecks
    // server membership and receives newer revisions in the background.
    if configured && prefs.organization_id.as_deref() == Some(organization) && prefs.revision > 0 {
        return Ok(json!({"status":"ready","organizationId":organization,"changed":false}));
    }
    let head = request(&session, Method::GET, &[], None).await?;
    let revision = checked_head(&session, &head)?;
    let remote = head["enabled"] == true && revision > 0;
    let empty = crate::cloud_backup::require_empty_company(store).is_ok();
    let manager = ["owner", "admin"].contains(&session.role.as_str());
    let own_first_upload = prefs.organization_id.as_deref() == Some(organization)
        && prefs
            .pending
            .as_ref()
            .is_some_and(|pending| head["snapshotId"].as_str() == Some(&pending.id));
    let decision = if own_first_upload && manager {
        Decision::Publish
    } else {
        decide(
            prefs.organization_id.as_deref(),
            organization,
            configured,
            empty,
            remote,
            prefs.revision,
            choice,
            manager,
        )
    };
    let mut result = json!({"status":"ready","organizationId":organization,"remoteAvailable":remote,"changed":false});
    match decision {
        Decision::Ready => {}
        Decision::Choose => {
            result["status"] = json!(if remote {
                "choose_remote"
            } else {
                "choose_local"
            })
        }
        Decision::Create => result["status"] = json!("create"),
        Decision::Wait => result["status"] = json!("waiting"),
        Decision::Publish => {
            // A concurrently-created remote company is rejected by the existing
            // revision-zero CAS. It can never be overwritten by this installation.
            let _transfer = crate::cloud_backup::TransferGuard::take()?;
            let _sync = crate::project_sync::pause_for_workspace_change()?;
            if !send(store, &session, true, head["contentTransfer"] == 1).await? {
                return Err(invalid("Votre entreprise vient d’être enregistrée sur un autre appareil. Réessayez pour l’ouvrir."));
            }
            crate::shared_numbering::replenish_active_series(store, &session).await?;
        }
        Decision::Receive => {
            let _transfer = crate::cloud_backup::TransferGuard::take()?;
            let _sync = crate::project_sync::pause_for_workspace_change()?;
            let expected = clock(store)?;
            let path = download(store, &session, &head).await?;
            let owned = store.clone();
            let org = organization.to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                if empty {
                    apply(&owned, &path, &org, revision, expected, true, false)
                } else {
                    open_saved_company(&owned, &path, &org, revision, expected)
                }
            })
            .await
            .map_err(|_| {
                invalid("L’ouverture a été interrompue. Vos données sont conservées.")
            })??;
            result["changed"] = json!(true);
        }
    }
    Ok(result)
}

const LINK_FILES: &[&str] = &[
    STATE,
    "company-sync-baseline.json",
    "company-sync-reference.zentra",
    "cloud-backup-state.json",
    "backup-status.json",
    "joined-company-copy.json",
];

fn open_saved_company(
    store: &LocalStore,
    path: &Path,
    org: &str,
    revision: u64,
    expected: i64,
) -> AppResult<()> {
    let _local = store.lock()?;
    let _gate = WriteGate::take(store)?;
    if clock(store)? != expected {
        return Err(invalid(
            "Une modification vient d’être enregistrée. Réessayez ; elle est conservée.",
        ));
    }
    let recovery = store.backups_dir.join(format!(
        "avant-changement-entreprise-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&recovery)?;
    store.create_backup_at(
        &recovery.join("entreprise.zentra"),
        env!("CARGO_PKG_VERSION"),
    )?;
    let previous: Vec<_> = LINK_FILES
        .iter()
        .map(|name| {
            let path = store.data_dir.join(name);
            let bytes = if path.exists() {
                Some(fs::read(path)?)
            } else {
                None
            };
            if let Some(bytes) = &bytes {
                fs::write(recovery.join(name), bytes)?;
            }
            Ok((*name, bytes))
        })
        .collect::<AppResult<_>>()?;
    // The current device identity belongs to the selected account. Number
    // reservations, timers and project sync bindings belong to the old company.
    let private: Vec<_> = private_rows(store)?
        .into_iter()
        .map(|(table, rows)| {
            let rows = if table == "company_local_identity" {
                rows.into_iter()
                    .filter(|row| row["organization_id"] == org)
                    .collect()
            } else {
                vec![]
            };
            (table, rows)
        })
        .collect();
    let result = store.restore_company_snapshot(&path.to_string_lossy(), || {
        restore_private(store, &private)?;
        for name in LINK_FILES {
            let file = store.data_dir.join(name);
            if file.exists() {
                fs::remove_file(file)?;
            }
        }
        remember_reference(store, path, org, revision)?;
        save(
            store,
            &Preferences {
                organization_id: Some(org.into()),
                revision,
                base_clock: clock(store)?,
                last_synced_at: Some(now_iso()),
                ..Default::default()
            },
        )
    });
    if result.is_err() {
        for (name, bytes) in previous {
            let file = store.data_dir.join(name);
            if let Some(bytes) = bytes {
                fs::write(file, bytes)?;
            } else if file.exists() {
                fs::remove_file(file)?;
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_new_company_keeps_its_account_binding_after_an_offline_restart() {
        let temp = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temp.path().into()).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION")).unwrap();
        bind_new_company(&store, "windows-account").unwrap();
        let reopened = LocalStore::initialize(temp.path().into()).unwrap();
        let prefs = load(&reopened).unwrap();
        assert_eq!(prefs.organization_id.as_deref(), Some("windows-account"));
        assert_eq!(decide(prefs.organization_id.as_deref(), "windows-account", true, false, false, 0, "auto", true), Decision::Publish);
        bind_new_company(&reopened, "different-account").unwrap();
        assert_eq!(load(&reopened).unwrap().organization_id.as_deref(), Some("windows-account"));
    }
    #[test]
    fn same_account_opens_a_new_device_but_never_merges_an_old_company() {
        assert_eq!(
            decide(None, "a", false, true, true, 0, "auto", true),
            Decision::Receive
        );
        assert_eq!(
            decide(None, "a", true, false, true, 0, "auto", true),
            Decision::Choose
        );
        assert_eq!(
            decide(Some("old"), "a", true, false, true, 4, "auto", true),
            Decision::Choose
        );
        assert_eq!(
            decide(Some("old"), "a", true, false, true, 4, "open", true),
            Decision::Receive
        );
        assert_eq!(
            decide(Some("old"), "a", true, false, false, 4, "publish", true),
            Decision::Wait
        );
        assert_eq!(
            decide(None, "a", true, false, false, 0, "publish", false),
            Decision::Wait
        );
        assert_eq!(
            decide(None, "a", true, false, false, 0, "publish", true),
            Decision::Publish
        );
        assert_eq!(
            decide(Some("a"), "a", true, false, false, 0, "auto", true),
            Decision::Publish
        );
        assert_eq!(
            decide(Some("a"), "a", true, false, false, 3, "auto", true),
            Decision::Ready
        );
    }
    #[test]
    fn opening_preserves_the_previous_company_and_does_not_keep_its_sync_bindings() {
        let temp = tempfile::tempdir().unwrap();
        let windows = LocalStore::initialize(temp.path().join("windows")).unwrap();
        windows
            .complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        windows
            .create_record("clients", json!({"name":"Client Windows"}))
            .unwrap();
        fs::write(
            windows.attachments_dir.join("logo-test.txt"),
            b"shared document",
        )
        .unwrap();
        let published = prepare(&windows, "a", true).unwrap();
        let mac = LocalStore::initialize(temp.path().join("mac")).unwrap();
        mac.complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))
            .unwrap();
        mac.create_record("clients", json!({"name":"Ancien client Mac"}))
            .unwrap();
        let old = prepare(&mac, "old", true).unwrap();
        confirm_sent(&mac, &old.id, 1).unwrap();
        fs::write(mac.data_dir.join("cloud-backup-state.json"), b"old company").unwrap();
        open_saved_company(
            &mac,
            &file_path(&windows, &published.id).unwrap(),
            "a",
            1,
            clock(&mac).unwrap(),
        )
        .unwrap();
        let db = mac.connect().unwrap();
        let names = query_all(&db, "SELECT name FROM clients", []).unwrap();
        assert_eq!(names, vec![json!({"name":"Client Windows"})]);
        assert_eq!(
            fs::read(mac.attachments_dir.join("logo-test.txt")).unwrap(),
            b"shared document"
        );
        assert_eq!(status(&mac).unwrap()["organizationId"], "a");
        assert!(!mac.data_dir.join("cloud-backup-state.json").exists());
        let recovery = fs::read_dir(&mac.backups_dir)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("avant-changement-entreprise-")
            })
            .unwrap();
        assert!(recovery.path().join("entreprise.zentra").is_file());
        let restored = LocalStore::initialize(temp.path().join("recovery")).unwrap();
        restored
            .restore_backup(
                &recovery.path().join("entreprise.zentra").to_string_lossy(),
                env!("CARGO_PKG_VERSION"),
            )
            .unwrap();
        assert_eq!(
            query_all(&restored.connect().unwrap(), "SELECT name FROM clients", []).unwrap(),
            vec![json!({"name":"Ancien client Mac"})]
        );
        assert!(open_saved_company(
            &mac,
            &file_path(&windows, &published.id).unwrap(),
            "a",
            1,
            -100
        )
        .is_err());
    }
}
