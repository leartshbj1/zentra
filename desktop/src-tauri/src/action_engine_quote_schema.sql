-- Private, non-routed Action Engine native draft repository. The creation
-- receipt is shared company evidence; only its recovery outbox stays local.
CREATE TABLE IF NOT EXISTS action_engine_quote_receipts (
  organization_id TEXT NOT NULL CHECK(length(organization_id) BETWEEN 1 AND 160),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 160),
  action_kind TEXT NOT NULL CHECK(action_kind='prepare_quote_draft'),
  proposal_id TEXT NOT NULL CHECK(length(proposal_id) BETWEEN 1 AND 160),
  reservation_id TEXT NOT NULL CHECK(length(reservation_id)=36),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  resources_sha256 TEXT NOT NULL CHECK(length(resources_sha256)=64 AND resources_sha256 NOT GLOB '*[^0-9a-f]*'),
  context_revision TEXT NOT NULL CHECK(length(context_revision) BETWEEN 1 AND 160),
  actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) BETWEEN 1 AND 160),
  installation_id TEXT NOT NULL CHECK(length(installation_id)=36),
  customer_id TEXT NOT NULL CHECK(length(customer_id) BETWEEN 1 AND 160),
  quote_id TEXT NOT NULL CHECK(length(quote_id)=36),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND json_type(plan_json)='object' AND length(CAST(plan_json AS BLOB))<=65536),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object' AND length(CAST(receipt_json AS BLOB))<=4096),
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,source_id,action_kind),
  UNIQUE(organization_id,proposal_id), UNIQUE(organization_id,reservation_id), UNIQUE(organization_id,quote_id),
  CHECK(COALESCE(json_extract(plan_json,'$.schemaVersion')=1
    AND json_extract(plan_json,'$.engineVersion')='action-engine-quote-v1'
    AND json_extract(plan_json,'$.kind')=action_kind AND json_extract(plan_json,'$.organizationId')=organization_id
    AND json_extract(plan_json,'$.sourceId')=source_id AND json_extract(plan_json,'$.contextRevision')=context_revision
    AND json_extract(plan_json,'$.status')='ready' AND json_array_length(plan_json,'$.reasons')=0
    AND json_type(plan_json,'$.requiresHumanValidation')='true',0)),
  CHECK(COALESCE(json_extract(receipt_json,'$.organizationId')=organization_id
    AND json_extract(receipt_json,'$.proposalId')=proposal_id AND json_extract(receipt_json,'$.fingerprint')=fingerprint
    AND json_extract(receipt_json,'$.customerId')=customer_id AND json_extract(receipt_json,'$.quoteId')=quote_id
    AND json_type(receipt_json,'$.quoteNumber')='null' AND json_extract(receipt_json,'$.status')='draft'
    AND json_type(receipt_json,'$.requiresHumanValidation')='true'
    AND json_remove(receipt_json,'$.organizationId','$.proposalId','$.fingerprint','$.customerId','$.quoteId','$.quoteNumber','$.status','$.requiresHumanValidation')='{}',0))
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS action_engine_quote_receipt_existing BEFORE INSERT ON action_engine_quote_receipts
WHEN EXISTS(SELECT 1 FROM action_engine_quote_receipts WHERE
  (organization_id=NEW.organization_id AND (source_id=NEW.source_id OR proposal_id=NEW.proposal_id OR reservation_id=NEW.reservation_id OR quote_id=NEW.quote_id)))
BEGIN SELECT RAISE(ABORT,'action_engine_quote_receipt_conflict'); END;
CREATE TRIGGER IF NOT EXISTS action_engine_quote_receipt_update BEFORE UPDATE ON action_engine_quote_receipts
BEGIN SELECT RAISE(ABORT,'action_engine_quote_receipt_immutable'); END;
CREATE TRIGGER IF NOT EXISTS action_engine_quote_receipt_delete BEFORE DELETE ON action_engine_quote_receipts
BEGIN SELECT RAISE(ABORT,'action_engine_quote_receipt_immutable'); END;

CREATE TABLE IF NOT EXISTS company_local_action_engine_quote_outbox (
  organization_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object' AND length(CAST(payload_json AS BLOB))<=4096),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('pending','confirmed','uncertain')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempt_count)='integer' AND attempt_count BETWEEN 0 AND 1000000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,proposal_id), UNIQUE(organization_id,quote_id),
  FOREIGN KEY(organization_id,proposal_id) REFERENCES action_engine_quote_receipts(organization_id,proposal_id),
  CHECK(COALESCE(json_extract(payload_json,'$.organizationId')=organization_id
    AND json_extract(payload_json,'$.proposalId')=proposal_id AND json_extract(payload_json,'$.quoteId')=quote_id
    AND json_extract(payload_json,'$.fingerprint')=fingerprint
    AND json_remove(payload_json,'$.organizationId','$.proposalId','$.reservationId','$.fingerprint','$.customerId','$.quoteId','$.receiptSha256')='{}',0))
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS action_engine_quote_outbox_existing BEFORE INSERT ON company_local_action_engine_quote_outbox
WHEN EXISTS(SELECT 1 FROM company_local_action_engine_quote_outbox WHERE organization_id=NEW.organization_id
  AND (proposal_id=NEW.proposal_id OR quote_id=NEW.quote_id))
BEGIN SELECT RAISE(ABORT,'action_engine_quote_outbox_conflict'); END;
CREATE TRIGGER IF NOT EXISTS action_engine_quote_outbox_receipt BEFORE INSERT ON company_local_action_engine_quote_outbox
WHEN NOT EXISTS(SELECT 1 FROM action_engine_quote_receipts r WHERE r.organization_id=NEW.organization_id
  AND r.proposal_id=NEW.proposal_id AND r.quote_id=NEW.quote_id AND r.fingerprint=NEW.fingerprint
  AND r.reservation_id=json_extract(NEW.payload_json,'$.reservationId')
  AND r.customer_id=json_extract(NEW.payload_json,'$.customerId')
  AND r.receipt_sha256=json_extract(NEW.payload_json,'$.receiptSha256'))
BEGIN SELECT RAISE(ABORT,'action_engine_quote_outbox_receipt'); END;
CREATE TRIGGER IF NOT EXISTS action_engine_quote_outbox_update BEFORE UPDATE ON company_local_action_engine_quote_outbox
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.proposal_id IS NOT OLD.proposal_id
  OR NEW.quote_id IS NOT OLD.quote_id OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.payload_json IS NOT OLD.payload_json OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at<OLD.updated_at OR NEW.attempt_count<OLD.attempt_count
  OR (OLD.state='confirmed' AND NEW.state<>'confirmed')
BEGIN SELECT RAISE(ABORT,'action_engine_quote_outbox_immutable'); END;
PRAGMA user_version=62;
