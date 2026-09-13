//! Read one outbound file at a time. A damaged local cache must not prevent
//! healthy files (or deletions) from reaching the other devices.
use super::*;

pub(super) struct PreparedDocument {
    pub id: String,
    pub project: String,
    pub upload: Option<(Value, Vec<u8>)>,
}

pub(super) struct PendingDocuments {
    entries: std::vec::IntoIter<Value>,
    failed: usize,
}

impl PendingDocuments {
    pub fn new(store: &LocalStore) -> AppResult<Self> {
        // Rotate failures behind untried files, even when more than a full
        // batch has a broken cache. Keep deletion tombstones first.
        let entries = query_all(&store.connect()?, "SELECT document_id,project_id,state FROM project_document_sync WHERE state IN ('upload','delete') ORDER BY CASE WHEN state='delete' THEN 0 ELSE 1 END,attempts,updated_at,document_id LIMIT 50", [])?;
        Ok(Self { entries: entries.into_iter(), failed: 0 })
    }

    pub fn next(
        &mut self,
        store: &LocalStore,
        mut record_failure: impl FnMut(&str, &str) -> AppResult<()>,
    ) -> AppResult<Option<PreparedDocument>> {
        for item in self.entries.by_ref() {
            let id = item["document_id"].as_str().unwrap_or_default().to_owned();
            let project = item["project_id"].as_str().unwrap_or_default().to_owned();
            if item["state"] == "delete" {
                return Ok(Some(PreparedDocument { id, project, upload: None }));
            }
            let row = query_all(&store.connect()?, "SELECT a.*,p.name AS project_name FROM attachments a JOIN projects p ON p.id=a.project_id JOIN project_document_sync s ON s.document_id=a.id WHERE a.id=? AND a.project_id=? AND a.entity_type='project' AND s.state='upload'", params![id, project])?.into_iter().next();
            // A concurrent deletion is kept in its own queue entry.
            let Some(row) = row else { continue; };
            let bytes = store.verified_attachment_path(&id).and_then(|path| Ok(fs::read(path)?));
            match bytes {
                Ok(bytes) => return Ok(Some(PreparedDocument { id, project, upload: Some((row, bytes)) })),
                Err(AppError::Database(error)) => return Err(AppError::Database(error)),
                Err(_) => {
                    record_failure(&id, "La copie locale de ce fichier est introuvable ou illisible. Ajoutez à nouveau le fichier original dans ce projet : sa copie sera réparée sans doublon si son contenu est identique. Les autres fichiers peuvent continuer leur envoi.")?;
                    self.failed += 1;
                }
            }
        }
        Ok(None)
    }

    pub fn finish(self) -> AppResult<()> {
        if self.failed == 0 { return Ok(()); }
        Err(AppError::Validation(format!(
            "{} fichier{} demande{} une vérification sur cet appareil. Les autres envois de cette série ont été traités ; consultez le détail dans le projet concerné.",
            self.failed, if self.failed > 1 { "s" } else { "" }, if self.failed > 1 { "nt" } else { "" }
        )))
    }
}

#[cfg(test)]
#[path = "project_sync_queue_tests.rs"]
mod tests;
