-- Private A10 confirmation only. Shared schema/user_version62 and A9 v1 stay
-- unchanged. Only the authenticated Rust composition may supply A7's success.
-- DELETE is reserved for private archive stripping/reset and local row restore;
-- confirmed without this exact marker always blocks pin cleanup/recovery.
CREATE TABLE IF NOT EXISTS company_local_action_engine_quote_confirmations (
  organization_id TEXT NOT NULL CHECK(typeof(organization_id)='text' AND length(organization_id) BETWEEN 1 AND 160),
  source_id TEXT NOT NULL CHECK(typeof(source_id)='text' AND length(source_id) BETWEEN 1 AND 160),
  action_kind TEXT NOT NULL CHECK(action_kind='prepare_quote_draft'),
  proposal_id TEXT NOT NULL CHECK(typeof(proposal_id)='text' AND length(proposal_id) BETWEEN 1 AND 160),
  reservation_id TEXT NOT NULL CHECK(typeof(reservation_id)='text' AND length(reservation_id)=36),
  fingerprint TEXT NOT NULL CHECK(typeof(fingerprint)='text' AND length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  actor_user_id TEXT NOT NULL CHECK(typeof(actor_user_id)='text' AND length(actor_user_id) BETWEEN 1 AND 160),
  installation_id TEXT NOT NULL CHECK(typeof(installation_id)='text' AND length(installation_id)=36),
  customer_id TEXT NOT NULL CHECK(typeof(customer_id)='text' AND length(customer_id) BETWEEN 1 AND 160),
  quote_id TEXT NOT NULL CHECK(typeof(quote_id)='text' AND length(quote_id)=36),
  receipt_sha256 TEXT NOT NULL CHECK(typeof(receipt_sha256)='text' AND length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  snapshot_id TEXT NOT NULL CHECK(typeof(snapshot_id)='text' AND length(snapshot_id)=36),
  confirmed_at TEXT NOT NULL CHECK(typeof(confirmed_at)='text' AND length(confirmed_at) BETWEEN 20 AND 40),
  PRIMARY KEY(organization_id,proposal_id),
  UNIQUE(organization_id,source_id,action_kind),
  UNIQUE(organization_id,reservation_id),
  UNIQUE(organization_id,quote_id),
  FOREIGN KEY(organization_id,proposal_id) REFERENCES company_local_action_engine_quote_outbox(organization_id,proposal_id),
  FOREIGN KEY(organization_id,proposal_id,snapshot_id) REFERENCES company_local_action_engine_quote_publications(organization_id,proposal_id,snapshot_id)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS company_local_action_quote_confirmation_insert
BEFORE INSERT ON company_local_action_engine_quote_confirmations BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM company_local_action_engine_quote_confirmations
    WHERE organization_id=NEW.organization_id AND (proposal_id=NEW.proposal_id
      OR (source_id=NEW.source_id AND action_kind=NEW.action_kind)
      OR reservation_id=NEW.reservation_id OR quote_id=NEW.quote_id))
    THEN RAISE(ABORT,'action_quote_confirmation_conflict') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM company_local_action_engine_quote_publications p
    JOIN action_engine_quote_receipts r ON r.organization_id=p.organization_id AND r.proposal_id=p.proposal_id
    JOIN company_local_action_engine_quote_outbox o ON o.organization_id=p.organization_id AND o.proposal_id=p.proposal_id
    WHERE p.organization_id=NEW.organization_id AND p.proposal_id=NEW.proposal_id AND p.snapshot_id=NEW.snapshot_id
      AND p.source_id=NEW.source_id AND p.action_kind=NEW.action_kind AND p.reservation_id=NEW.reservation_id
      AND p.fingerprint=NEW.fingerprint AND p.actor_user_id=NEW.actor_user_id AND p.installation_id=NEW.installation_id
      AND p.customer_id=NEW.customer_id AND p.quote_id=NEW.quote_id AND p.receipt_sha256=NEW.receipt_sha256
      AND r.source_id=p.source_id AND r.action_kind=p.action_kind AND r.reservation_id=p.reservation_id
      AND r.fingerprint=p.fingerprint AND r.actor_user_id=p.actor_user_id AND r.installation_id=p.installation_id
      AND r.customer_id=p.customer_id AND r.quote_id=p.quote_id AND r.receipt_sha256=p.receipt_sha256
      AND o.quote_id=p.quote_id AND o.fingerprint=p.fingerprint AND o.state IN ('pending','uncertain')
      AND json_extract(o.payload_json,'$.reservationId')=p.reservation_id
      AND json_extract(o.payload_json,'$.customerId')=p.customer_id
      AND json_extract(o.payload_json,'$.receiptSha256')=p.receipt_sha256
      AND NEW.confirmed_at>=p.created_at AND NEW.confirmed_at>=o.updated_at)
    THEN RAISE(ABORT,'action_quote_confirmation_invalid') END;
END;
CREATE TRIGGER IF NOT EXISTS company_local_action_quote_confirmation_update
BEFORE UPDATE ON company_local_action_engine_quote_confirmations
BEGIN SELECT RAISE(ABORT,'action_quote_confirmation_immutable'); END;
