use super::*;
use crate::project_documents::AddProjectDocumentInput;
use base64::{engine::general_purpose::STANDARD, Engine};

fn fixture() -> (tempfile::TempDir, LocalStore, String) {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
    store.connect().unwrap().execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Recette',?,?)",params![now_iso(),now_iso()]).unwrap();
    let project = store.create_record("projects",json!({"name":"Documents à partager"})).unwrap()["id"].as_str().unwrap().to_owned();
    (dir,store,project)
}
fn add(store: &LocalStore, project: &str, text: &str) -> Value {
    store.add_project_document(AddProjectDocumentInput { project_id:project.into(), original_name:format!("{text}.txt"), content_base64:STANDARD.encode(text.as_bytes()) }).unwrap()
}
fn failure(store: &LocalStore, id: &str, message: &str) -> AppResult<()> {
    store.connect()?.execute("UPDATE project_document_sync SET last_error=?,attempts=attempts+1 WHERE document_id=? AND state='upload'",params![message,id])?;
    Ok(())
}

#[test]
fn missing_cache_does_not_block_healthy_files_and_deletions_and_resumes_after_restart() {
    let (dir,store,project)=fixture();
    let broken=add(&store,&project,"Plan manquant");
    let healthy=add(&store,&project,"Conditions conservées");
    let deleted=add(&store,&project,"Ancien document");
    store.delete_project_document(deleted["id"].as_str().unwrap()).unwrap();
    fs::remove_file(store.safe_attachment_path(broken["stored_name"].as_str().unwrap()).unwrap()).unwrap();
    let mut queue=PendingDocuments::new(&store).unwrap();
    let deletion=queue.next(&store,|id,message|failure(&store,id,message)).unwrap().unwrap();
    assert_eq!(deletion.id,deleted["id"].as_str().unwrap());
    assert!(deletion.upload.is_none());
    store.connect().unwrap().execute("UPDATE project_document_sync SET state='deleted' WHERE document_id=?",params![deletion.id]).unwrap();
    let upload=queue.next(&store,|id,message|failure(&store,id,message)).unwrap().unwrap();
    assert_eq!(upload.id,healthy["id"].as_str().unwrap());
    assert_eq!(upload.upload.unwrap().1,"Conditions conservées".as_bytes());
    store.connect().unwrap().execute("UPDATE project_document_sync SET state='synced' WHERE document_id=?",params![upload.id]).unwrap();
    assert!(queue.next(&store,|id,message|failure(&store,id,message)).unwrap().is_none());
    assert!(queue.finish().is_err());
    let before=store.project_sync_status().unwrap();
    assert_eq!(before["pending"],1);
    assert!(before["documents"].as_array().unwrap().iter().any(|r|r["document_id"]==broken["id"] && r["last_error"].as_str().unwrap_or_default().contains("copie locale")));
    drop(store);
    let store=LocalStore::initialize(dir.path().join("profile")).unwrap();
    assert_eq!(store.project_sync_status().unwrap()["pending"],1);
    let repaired=add(&store,&project,"Plan manquant");
    assert_eq!(repaired["id"],broken["id"]);
    assert_eq!(store.get_workspace().unwrap()["attachments"].as_array().unwrap().len(),2);
    let mut queue=PendingDocuments::new(&store).unwrap();
    let restored=queue.next(&store,|id,message|failure(&store,id,message)).unwrap().unwrap();
    assert_eq!(restored.id,broken["id"].as_str().unwrap());
    assert_eq!(restored.upload.unwrap().1,b"Plan manquant");
    assert!(queue.next(&store,|id,message|failure(&store,id,message)).unwrap().is_none());
    queue.finish().unwrap();
}

#[test]
fn corrupted_content_is_never_prepared_and_a_failed_error_write_stops_the_batch() {
    let (_dir,store,project)=fixture();
    let broken=add(&store,&project,"Original");
    fs::write(store.safe_attachment_path(broken["stored_name"].as_str().unwrap()).unwrap(),b"Modified").unwrap();
    let mut queue=PendingDocuments::new(&store).unwrap();
    let result=queue.next(&store,|_,_|Err(AppError::Validation("Dossier changé".into())));
    assert!(result.err().unwrap().to_string().contains("Dossier changé"));
    assert_eq!(store.project_sync_status().unwrap()["pending"],1);
    let mut queue=PendingDocuments::new(&store).unwrap();
    assert!(queue.next(&store,|id,message|failure(&store,id,message)).unwrap().is_none());
    assert!(queue.finish().is_err());
    assert_eq!(fs::read(store.safe_attachment_path(broken["stored_name"].as_str().unwrap()).unwrap()).unwrap(),b"Modified");
    let repaired=add(&store,&project,"Original");
    assert_eq!(repaired["id"],broken["id"]);
    assert_eq!(store.read_project_document(repaired["id"].as_str().unwrap()).unwrap(),STANDARD.encode(b"Original"));
    assert!(store.project_sync_status().unwrap()["documents"][0]["last_error"].is_null());
}

#[test]
fn a_full_batch_of_broken_files_cannot_starve_a_later_healthy_file() {
    let (_dir,store,project)=fixture();
    for index in 0..50 {
        let row=add(&store,&project,&format!("Plan {index}"));
        fs::remove_file(store.safe_attachment_path(row["stored_name"].as_str().unwrap()).unwrap()).unwrap();
    }
    let healthy=add(&store,&project,"Fichier récent");
    store.connect().unwrap().execute("UPDATE project_document_sync SET updated_at='9999' WHERE document_id=?",params![healthy["id"].as_str().unwrap()]).unwrap();
    let mut queue=PendingDocuments::new(&store).unwrap();
    assert!(queue.next(&store,|id,message|failure(&store,id,message)).unwrap().is_none());
    assert!(queue.finish().is_err());
    let mut queue=PendingDocuments::new(&store).unwrap();
    let next=queue.next(&store,|id,message|failure(&store,id,message)).unwrap().unwrap();
    assert_eq!(next.id,healthy["id"].as_str().unwrap());
    assert_eq!(next.upload.unwrap().1,"Fichier récent".as_bytes());
}

#[test]
fn a_document_deleted_after_queue_loading_is_not_prepared_as_an_upload() {
    let (_dir,store,project)=fixture();
    let row=add(&store,&project,"Document retiré");
    let mut queue=PendingDocuments::new(&store).unwrap();
    store.delete_project_document(row["id"].as_str().unwrap()).unwrap();
    assert!(queue.next(&store,|_,_|panic!("Concurrent deletion must not become a cache error")).unwrap().is_none());
    queue.finish().unwrap();
    let mut queue=PendingDocuments::new(&store).unwrap();
    let next=queue.next(&store,|_,_|panic!("A deletion has no file to read")).unwrap().unwrap();
    assert_eq!(next.id,row["id"].as_str().unwrap());
    assert!(next.upload.is_none());
}
