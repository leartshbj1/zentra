CREATE TRIGGER invoice_archives_immutable_update_guard
BEFORE UPDATE ON invoice_archives
WHEN NOT (
  OLD.storage_status='pending' AND NEW.storage_status='stored'
  AND NEW.archive_id=OLD.archive_id
  AND NEW.organization_id=OLD.organization_id
  AND NEW.source_invoice_id=OLD.source_invoice_id
  AND NEW.revision=OLD.revision
  AND NEW.invoice_number=OLD.invoice_number
  AND NEW.issue_date=OLD.issue_date
  AND NEW.paid_at IS OLD.paid_at
  AND NEW.correction_kind=OLD.correction_kind
  AND NEW.correction_reason IS OLD.correction_reason
  AND NEW.supersedes_archive_id IS OLD.supersedes_archive_id
  AND NEW.object_key=OLD.object_key
  AND NEW.content_sha256=OLD.content_sha256
  AND NEW.size_bytes=OLD.size_bytes
  AND NEW.media_type=OLD.media_type
  AND NEW.previous_chain_sha256 IS OLD.previous_chain_sha256
  AND NEW.chain_sha256=OLD.chain_sha256
  AND NEW.retention_until=OLD.retention_until
  AND NEW.stored_by_session_id=OLD.stored_by_session_id
  AND NEW.stored_at=OLD.stored_at
)
BEGIN SELECT RAISE(ABORT,'invoice archive metadata is immutable'); END;

CREATE TRIGGER invoice_archives_immutable_delete_guard
BEFORE DELETE ON invoice_archives
WHEN OLD.storage_status<>'pending'
BEGIN SELECT RAISE(ABORT,'invoice archives cannot be deleted'); END;
