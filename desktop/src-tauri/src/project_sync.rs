use crate::{
    account_cloud::project_sync_session,
    database::{now_iso, query_all, LocalStore},
    error::{command_error, AppError, AppResult},
};
use reqwest::{Method, StatusCode};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::State;
use uuid::Uuid;

mod ownership;

static SYNCING: AtomicBool = AtomicBool::new(false);
struct SyncGuard;
impl Drop for SyncGuard {
    fn drop(&mut self) {
        SYNCING.store(false, Ordering::Release);
    }
}

#[derive(Debug, Deserialize)]
struct RemoteDocument {
    sequence: i64,
    document_id: String,
    project_id: String,
    project_name: String,
    action: String,
    original_name: String,
    media_type: String,
    size_bytes: i64,
    sha256: String,
    created_at: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Feed {
    events: Vec<RemoteDocument>,
    cursor: i64,
    has_more: bool,
}

#[tauri::command]
pub fn get_project_sync_status(state: State<'_, LocalStore>) -> Result<Value, String> {
    state.project_sync_status().map_err(command_error)
}

#[tauri::command]
pub async fn sync_project_documents(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner().clone();
    if let Some(status) =
        ownership::business_status(&store, &store.connect().map_err(command_error)?)
            .map_err(command_error)?
    {
        return Ok(status);
    }
    if crate::cloud_backup::is_restoring() {
        return store.project_sync_status().map_err(command_error);
    }
    if SYNCING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return store.project_sync_status().map_err(command_error);
    }
    let _guard = SyncGuard;
    let Some(lease) = crate::business_sync::cycle::try_acquire(&store).map_err(command_error)?
    else {
        let mut status = store.project_sync_status().map_err(command_error)?;
        status["busy"] = json!(true);
        return Ok(status);
    };
    let result = synchronize(&store, lease).await;
    let mut status = store.project_sync_status().map_err(command_error)?;
    match result {
        Ok((connected, changed)) => {
            status["connected"] = json!(connected);
            status["changed"] = json!(changed);
        }
        Err(error) => {
            status["error"] = json!(error.to_string());
            status["changed"] = json!(true);
        }
    }
    status["syncing"] = json!(false);
    Ok(status)
}

impl LocalStore {
    pub fn project_sync_status(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        if let Some(status) = ownership::business_status(self, &connection)? {
            return Ok(status);
        }
        let binding = query_all(
            &connection,
            "SELECT organization_id,last_synced_at FROM project_sync_binding WHERE id=1",
            [],
        )?;
        let documents=query_all(&connection,"SELECT document_id,project_id,state,last_error FROM project_document_sync WHERE state<>'deleted'",[])?;
        let pending = documents
            .iter()
            .filter(|row| matches!(row["state"].as_str(), Some("upload" | "delete")))
            .count();
        Ok(
            json!({"mode":"legacy","organizationId":binding.first().map(|row|&row["organization_id"]),"lastSyncedAt":binding.first().map(|row|&row["last_synced_at"]),"pending":pending,"documents":documents,"syncing":SYNCING.load(Ordering::Acquire)}),
        )
    }

    fn bind_project_sync(&self, organization: &str) -> AppResult<i64> {
        let _guard = self.lock()?;
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ownership::legacy_allowed(&tx)?;
        tx.execute(
            "INSERT OR IGNORE INTO project_sync_binding(id,organization_id) VALUES(1,?)",
            params![organization],
        )?;
        let (bound, cursor): (String, i64) = tx.query_row(
            "SELECT organization_id,cursor FROM project_sync_binding WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if bound != organization {
            return Err(AppError::Validation("Ces fichiers appartiennent à une autre entreprise. Reconnectez le compte d’origine pour reprendre leur synchronisation.".into()));
        }
        tx.commit()?;
        Ok(cursor)
    }

    #[cfg(test)]
    fn apply_remote_document(
        &self,
        remote: &RemoteDocument,
        bytes: Option<&[u8]>,
    ) -> AppResult<bool> {
        self.apply_remote_document_checked(remote, bytes, || Ok(()))
    }

    fn apply_remote_document_checked(
        &self,
        remote: &RemoteDocument,
        bytes: Option<&[u8]>,
        current: impl Fn() -> AppResult<()>,
    ) -> AppResult<bool> {
        Uuid::parse_str(&remote.document_id)
            .map_err(|_| AppError::Validation("Référence de fichier reçue invalide.".into()))?;
        Uuid::parse_str(&remote.project_id)
            .map_err(|_| AppError::Validation("Référence de projet reçue invalide.".into()))?;
        let _guard = self.lock()?;
        current()?;
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ownership::legacy_allowed(&tx)?;
        let local_state: Option<String> = tx
            .query_row(
                "SELECT state FROM project_document_sync WHERE document_id=?",
                params![remote.document_id],
                |row| row.get(0),
            )
            .optional()?;
        let identity: Option<(Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT project_id,entity_type FROM attachments WHERE id=?",
                params![remote.document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if identity.is_some_and(|(project, kind)| {
            project.as_deref() != Some(&remote.project_id) || kind.as_deref() != Some("project")
        }) {
            return Err(AppError::Validation(
                "Une autre pièce locale utilise cette référence. Elle a été conservée.".into(),
            ));
        }
        if remote.action == "deleted" {
            let path:Option<String>=tx.query_row("SELECT stored_name FROM attachments WHERE id=? AND entity_type='project' AND project_id=?",params![remote.document_id,remote.project_id],|row|row.get(0)).optional()?;
            tx.execute(
                "DELETE FROM attachments WHERE id=? AND entity_type='project' AND project_id=?",
                params![remote.document_id, remote.project_id],
            )?;
            tx.execute("INSERT INTO project_document_sync(document_id,project_id,state,updated_at) VALUES(?,?,'deleted',?) ON CONFLICT(document_id) DO UPDATE SET state='deleted',last_error=NULL,updated_at=excluded.updated_at",params![remote.document_id,remote.project_id,now_iso()])?;
            current()?;
            tx.commit()?;
            if let Some(name) = &path {
                let _ = fs::remove_file(self.safe_attachment_path(name)?);
            }
            return Ok(path.is_some());
        }
        if remote.action != "stored" {
            return Err(AppError::Validation(
                "Événement de synchronisation inconnu.".into(),
            ));
        }
        if matches!(local_state.as_deref(), Some("delete" | "deleted")) {
            return Ok(false);
        }
        let bytes =
            bytes.ok_or_else(|| AppError::Validation("Le fichier reçu est incomplet.".into()))?;
        if bytes.is_empty()
            || bytes.len() > 25 * 1024 * 1024
            || bytes.len() as i64 != remote.size_bytes
            || format!("{:x}", Sha256::digest(bytes)) != remote.sha256
        {
            return Err(AppError::Validation(
                "Le fichier reçu est incomplet ou altéré. La copie locale est conservée.".into(),
            ));
        }
        if remote.original_name.is_empty()
            || remote.original_name.chars().count() > 255
            || remote.original_name.contains(['/', '\\'])
            || remote.original_name.chars().any(char::is_control)
            || remote.project_name.trim().is_empty()
            || remote.project_name.chars().count() > 255
            || remote.project_name.chars().any(char::is_control)
        {
            return Err(AppError::Validation(
                "Nom de projet ou de fichier reçu invalide.".into(),
            ));
        }
        chrono::DateTime::parse_from_rfc3339(&remote.created_at)
            .map_err(|_| AppError::Validation("Date du fichier reçue invalide.".into()))?;
        let (mime, extension) =
            crate::project_documents::document_format(&remote.original_name, bytes)?;
        if mime != remote.media_type {
            return Err(AppError::Validation(
                "Le format du fichier reçu ne correspond pas à sa description.".into(),
            ));
        }
        let existing: Option<(String, String, String)> = tx
            .query_row(
                "SELECT project_id,sha256,stored_name FROM attachments WHERE id=?",
                params![remote.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((project, hash, name)) = &existing {
            if project != &remote.project_id || hash != &remote.sha256 {
                return Err(AppError::Validation("Un autre document local utilise cette référence. Aucun fichier n’a été remplacé.".into()));
            }
            // Check the real cache before trusting metadata after an interrupted disk write.
            if fs::read(self.safe_attachment_path(name)?)
                .is_ok_and(|local| format!("{:x}", Sha256::digest(&local)) == remote.sha256)
            {
                tx.execute("UPDATE project_document_sync SET state='synced',last_error=NULL WHERE document_id=? AND state='upload'",params![remote.document_id])?;
                current()?;
                tx.commit()?;
                return Ok(false);
            }
        }
        let now = now_iso();
        tx.execute(
            "INSERT OR IGNORE INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)",
            params![remote.project_id, remote.project_name, now, now],
        )?;
        let stored_name = existing
            .as_ref()
            .map(|row| row.2.clone())
            .unwrap_or_else(|| format!("{}.{extension}", remote.document_id));
        let path = self.safe_attachment_path(&stored_name)?;
        let path_existed = path.try_exists()?;
        if existing.is_none()
            && path_existed
            && format!("{:x}", Sha256::digest(fs::read(&path)?)) != remote.sha256
        {
            return Err(AppError::Validation(
                "Un fichier local utilise déjà ce chemin. Il a été conservé.".into(),
            ));
        }
        let mut staged = tempfile::NamedTempFile::new_in(&self.attachments_dir)?;
        staged.write_all(bytes)?;
        staged.as_file().sync_all()?;
        // Replace only a missing/corrupt cache whose DB identity already matches this exact hash.
        staged
            .persist(&path)
            .map_err(|error| AppError::Io(error.error))?;
        let result = (|| -> AppResult<()> {
            tx.execute("INSERT OR IGNORE INTO attachments(id,project_id,entity_type,entity_id,original_name,stored_name,mime_type,size_bytes,sha256,created_at,updated_at) VALUES(?,?,'project',?,?,?,?,?,?,?,?)",params![remote.document_id,remote.project_id,remote.project_id,remote.original_name,stored_name,mime,remote.size_bytes,remote.sha256,remote.created_at,now])?;
            tx.execute("INSERT INTO project_document_sync(document_id,project_id,state,updated_at) VALUES(?,?,'synced',?) ON CONFLICT(document_id) DO UPDATE SET state='synced',last_error=NULL,updated_at=excluded.updated_at",params![remote.document_id,remote.project_id,now])?;
            current()?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(error) = result {
            if !path_existed {
                fs::remove_file(&path)?;
            }
            return Err(error);
        }
        Ok(true)
    }
}

async fn synchronize(
    store: &LocalStore,
    run: std::sync::Arc<crate::business_sync::cycle::Run>,
) -> AppResult<(bool, bool)> {
    if ownership::business_status(store, &store.connect()?)?.is_some() {
        return Ok((true, false));
    }
    let Some(session) = project_sync_session(store).await? else {
        return Ok((false, false));
    };
    let network = ownership::Legacy {
        store,
        session,
        run,
    };
    network.check()?;
    let session = &network.session;
    let mut cursor = store.bind_project_sync(&session.organization_id)?;
    let mut changed = false;
    // Bound each pass. The persisted cursor resumes remaining pages on the next pass.
    for _ in 0..20 {
        let after = cursor.to_string();
        let (_, bytes) = network
            .request(
                Method::GET,
                "/api/projects/sync",
                &[("after", &after)],
                &[],
                None,
                false,
            )
            .await?;
        let feed: Feed = serde_json::from_slice(&bytes)?;
        if feed.events.len() > 50
            || feed.cursor < cursor
            || feed
                .events
                .last()
                .is_some_and(|event| event.sequence != feed.cursor)
        {
            return Err(AppError::Validation(
                "Ordre des fichiers reçus invalide.".into(),
            ));
        }
        for mut remote in feed.events {
            if remote.sequence <= cursor {
                return Err(AppError::Validation(
                    "Ordre de synchronisation invalide.".into(),
                ));
            }
            let cached = store
                .verified_attachment_path(&remote.document_id)
                .ok()
                .and_then(|path| fs::read(path).ok())
                .filter(|bytes| {
                    bytes.len() as i64 == remote.size_bytes
                        && format!("{:x}", Sha256::digest(bytes)) == remote.sha256
                });
            let locally_deleted:bool=store.connect()?.query_row("SELECT EXISTS(SELECT 1 FROM project_document_sync WHERE document_id=? AND state IN ('delete','deleted'))",params![remote.document_id],|row|row.get(0))?;
            let bytes = if remote.action == "stored" && cached.is_none() && !locally_deleted {
                let (status, bytes) = network
                    .request(
                        Method::GET,
                        "/api/projects/sync/file",
                        &[("id", &remote.document_id)],
                        &[],
                        None,
                        true,
                    )
                    .await?;
                if status == StatusCode::GONE {
                    remote.action = "deleted".into();
                    None
                } else {
                    Some(bytes)
                }
            } else {
                cached
            };
            changed |= network.apply(&remote, bytes.as_deref())?;
            cursor = remote.sequence;
            network.write(|tx| {
                tx.execute(
                    "UPDATE project_sync_binding SET cursor=? WHERE id=1 AND organization_id=?",
                    params![cursor, session.organization_id],
                )?;
                Ok(())
            })?;
        }
        if !feed.has_more {
            break;
        }
    }
    if session.role != "read_only" {
        let pending=query_all(&store.connect()?,"SELECT document_id,project_id,state FROM project_document_sync WHERE state IN ('upload','delete') ORDER BY updated_at,document_id LIMIT 50",[])?;
        for item in pending {
            let id = item["document_id"].as_str().unwrap_or_default();
            let project = item["project_id"].as_str().unwrap_or_default();
            let state = item["state"].as_str().unwrap_or_default();
            let result=async {
                let query=[("id",id),("projectId",project)];
                if state=="delete" {
                    network.request(Method::DELETE,"/api/projects/sync",&query,&[],None,false).await?;
                    network.write(|tx| {tx.execute("UPDATE project_document_sync SET state='deleted',last_error=NULL WHERE document_id=? AND state='delete'",params![id])?;Ok(())})?;
                } else {
                    let row=query_all(&store.connect()?,"SELECT a.*,p.name AS project_name FROM attachments a JOIN projects p ON p.id=a.project_id WHERE a.id=? AND a.entity_type='project'",params![id])?.into_iter().next();
                    let Some(row)=row else {return Ok::<(),AppError>(());}; // A concurrent local deletion is already queued.
                    let bytes=fs::read(store.verified_attachment_path(id)?)?;
                    let encode=|value:&str|url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>().replace('+',"%20");
                    let headers=[("X-Zentra-Name",encode(row["original_name"].as_str().unwrap_or_default())),("X-Zentra-Project",encode(row["project_name"].as_str().unwrap_or_default())),("X-Zentra-Sha256",row["sha256"].as_str().unwrap_or_default().to_owned())];
                    let (_,response)=network.request(Method::PUT,"/api/projects/sync",&query,&headers,Some(bytes),false).await?;
                    let response:Value=serde_json::from_slice(&response)?;
                    if response["deleted"]==true {
                        let remote=RemoteDocument {sequence:0,document_id:id.into(),project_id:project.into(),project_name:String::new(),action:"deleted".into(),original_name:String::new(),media_type:String::new(),size_bytes:0,sha256:String::new(),created_at:String::new()};
                        changed|=network.apply(&remote,None)?;
                    } else {
                        if response["document"]["document_id"]!=id || response["document"]["sha256"]!=row["sha256"] || response["document"]["project_id"]!=project {
                            return Err(AppError::Validation("La confirmation ne correspond pas au document envoyé.".into()));
                        }
                        network.write(|tx| {tx.execute("UPDATE project_document_sync SET state='synced',last_error=NULL WHERE document_id=? AND state='upload'",params![id])?;Ok(())})?;
                    }
                }
                Ok(())
            }.await;
            if let Err(error) = result {
                network.write(|tx| {tx.execute("UPDATE project_document_sync SET last_error=?,attempts=attempts+1 WHERE document_id=? AND state IN ('upload','delete')",params![error.to_string(),id])?;Ok(())})?;
                return Err(error);
            }
        }
    }
    network.write(|tx| {
        tx.execute(
            "UPDATE project_sync_binding SET last_synced_at=? WHERE id=1",
            params![now_iso()],
        )?;
        Ok(())
    })?;
    Ok((true, changed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_documents::AddProjectDocumentInput;
    use base64::{engine::general_purpose::STANDARD, Engine};
    fn fixture() -> (tempfile::TempDir, LocalStore, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
        store.connect().unwrap().execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Test',?,?)",params![now_iso(),now_iso()]).unwrap();
        let project = store
            .create_record("projects", json!({"name":"Projet local"}))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        (dir, store, project)
    }
    fn remote(project: &str) -> RemoteDocument {
        RemoteDocument {
            sequence: 1,
            document_id: Uuid::new_v4().to_string(),
            project_id: project.into(),
            project_name: "Projet partagé".into(),
            action: "stored".into(),
            original_name: "Plan général.txt".into(),
            media_type: "text/plain".into(),
            size_bytes: 5,
            sha256: format!("{:x}", Sha256::digest(b"plans")),
            created_at: now_iso(),
        }
    }
    #[test]
    fn upload_and_deletion_survive_restart_and_backup_without_a_network() {
        let (dir, store, project) = fixture();
        let added = store
            .add_project_document(AddProjectDocumentInput {
                project_id: project,
                original_name: "Plan.txt".into(),
                content_base64: STANDARD.encode(b"plans"),
            })
            .unwrap();
        let id = added["id"].as_str().unwrap();
        assert_eq!(store.project_sync_status().unwrap()["pending"], 1);
        drop(store);
        let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
        assert_eq!(
            store.read_project_document(id).unwrap(),
            STANDARD.encode(b"plans")
        );
        assert_eq!(
            store.project_sync_status().unwrap()["documents"][0]["state"],
            "upload"
        );
        let backup = store.create_backup(None, "1.45.0").unwrap();
        store.delete_project_document(id).unwrap();
        assert_eq!(
            store.project_sync_status().unwrap()["documents"][0]["state"],
            "delete"
        );
        store.restore_backup(&backup, "1.45.0").unwrap();
        assert_eq!(
            store.project_sync_status().unwrap()["documents"][0]["state"],
            "upload"
        );
        assert_eq!(
            store.read_project_document(id).unwrap(),
            STANDARD.encode(b"plans")
        );
    }
    #[test]
    fn cached_remote_files_create_their_folder_and_remain_readable_after_restart() {
        let (dir, store, _) = fixture();
        let remote = remote(&Uuid::new_v4().to_string());
        assert!(store
            .apply_remote_document(&remote, Some(b"plans"))
            .unwrap());
        assert!(!store
            .apply_remote_document(&remote, Some(b"plans"))
            .unwrap());
        assert_eq!(store.project_sync_status().unwrap()["pending"], 0);
        drop(store);
        let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
        assert_eq!(
            store.read_project_document(&remote.document_id).unwrap(),
            STANDARD.encode(b"plans")
        );
        assert!(store.get_workspace().unwrap()["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|project| project["id"] == remote.project_id));
    }
    #[test]
    fn failed_or_corrupt_download_never_replaces_the_local_file() {
        let (_dir, store, project) = fixture();
        let mut remote = remote(&project);
        assert!(store.apply_remote_document(&remote, Some(b"bad")).is_err());
        assert_eq!(
            store.get_workspace().unwrap()["attachments"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        store
            .apply_remote_document(&remote, Some(b"plans"))
            .unwrap();
        remote.sha256 = format!("{:x}", Sha256::digest(b"other"));
        assert!(store
            .apply_remote_document(&remote, Some(b"other"))
            .is_err());
        assert_eq!(
            store.read_project_document(&remote.document_id).unwrap(),
            STANDARD.encode(b"plans")
        );
    }
    #[test]
    fn pending_and_acknowledged_deletions_win_over_a_late_remote_upload() {
        let (_dir, store, project) = fixture();
        let mut remote = remote(&project);
        store
            .apply_remote_document(&remote, Some(b"plans"))
            .unwrap();
        store.delete_project_document(&remote.document_id).unwrap();
        assert!(!store
            .apply_remote_document(&remote, Some(b"plans"))
            .unwrap());
        assert!(store.read_project_document(&remote.document_id).is_err());
        remote.action = "deleted".into();
        store.apply_remote_document(&remote, None).unwrap();
        remote.action = "stored".into();
        assert!(!store
            .apply_remote_document(&remote, Some(b"plans"))
            .unwrap());
        assert_eq!(store.project_sync_status().unwrap()["pending"], 0);
    }
    #[test]
    fn local_profile_cannot_upload_its_documents_into_another_company() {
        let (_dir, store, _) = fixture();
        assert_eq!(store.bind_project_sync("org_first").unwrap(), 0);
        store
            .connect()
            .unwrap()
            .execute("UPDATE project_sync_binding SET cursor=12", [])
            .unwrap();
        assert_eq!(store.bind_project_sync("org_first").unwrap(), 12);
        assert!(store.bind_project_sync("org_other").is_err());
        assert_eq!(store.bind_project_sync("org_first").unwrap(), 12);
    }
    #[test]
    fn migration_enqueues_existing_files_without_changing_their_bytes() {
        let (dir, store, project) = fixture();
        let added = store
            .add_project_document(AddProjectDocumentInput {
                project_id: project,
                original_name: "Plan.txt".into(),
                content_base64: STANDARD.encode(b"plans"),
            })
            .unwrap();
        store.connect().unwrap().execute_batch("DROP TRIGGER project_document_queue_insert; DROP TRIGGER project_document_queue_delete; DROP TABLE project_document_sync; DROP TABLE project_sync_binding; PRAGMA user_version=57;").unwrap();
        drop(store);
        let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
        assert_eq!(store.project_sync_status().unwrap()["pending"], 1);
        assert_eq!(
            store
                .read_project_document(added["id"].as_str().unwrap())
                .unwrap(),
            STANDARD.encode(b"plans")
        );
    }
}
