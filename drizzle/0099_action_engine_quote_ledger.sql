-- Migration number: 0099 	 2026-10-10T23:35:50.594Z
-- Additive, non-routed Action Engine ledger. No business document is written here.
-- Gates are supplied by trusted server composition and checked inside a D1 batch.
CREATE TABLE action_engine_atomic_assertions (
  operation_id TEXT PRIMARY KEY NOT NULL,
  allowed INTEGER NOT NULL CONSTRAINT action_engine_denied CHECK(typeof(allowed)='integer' AND allowed=1)
);
--> statement-breakpoint
CREATE TABLE action_engine_quote_proposals (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 160),
  organization_id TEXT NOT NULL CHECK(length(organization_id) BETWEEN 1 AND 160),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 160),
  action_kind TEXT NOT NULL CHECK(action_kind='prepare_quote_draft'),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 160),
  context_revision TEXT NOT NULL CHECK(length(context_revision) BETWEEN 1 AND 160),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND json_type(plan_json)='object' AND length(CAST(plan_json AS BLOB))<=65536),
  created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 160),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  CHECK(COALESCE(json_extract(plan_json,'$.schemaVersion')=1
    AND json_extract(plan_json,'$.engineVersion')='action-engine-quote-v1'
    AND json_extract(plan_json,'$.kind')=action_kind
    AND json_extract(plan_json,'$.organizationId')=organization_id
    AND json_extract(plan_json,'$.sourceId')=source_id
    AND json_extract(plan_json,'$.sourceRevision')=source_revision
    AND json_extract(plan_json,'$.contextRevision')=context_revision
    AND json_extract(plan_json,'$.status') IN ('ready','needs_review')
    AND json_type(plan_json,'$.requiresHumanValidation')='true',0)),
  UNIQUE(organization_id,source_id,action_kind),
  UNIQUE(id,organization_id,fingerprint)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE action_engine_quote_reservations (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 160),
  organization_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 160),
  installation_id TEXT NOT NULL CHECK(length(installation_id) BETWEEN 1 AND 160),
  customer_id TEXT NOT NULL CHECK(length(customer_id) BETWEEN 1 AND 160),
  quote_id TEXT NOT NULL CHECK(length(quote_id)=36 AND quote_id NOT GLOB '*[^0-9a-f-]*'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json)='object' AND length(CAST(receipt_json AS BLOB))<=4096)),
  confirmed_at INTEGER CHECK(confirmed_at IS NULL OR (typeof(confirmed_at)='integer' AND confirmed_at BETWEEN created_at AND 253402300799)),
  CHECK((receipt_json IS NULL)=(confirmed_at IS NULL)),
  CHECK(receipt_json IS NULL OR COALESCE(
    json_extract(receipt_json,'$.organizationId')=organization_id
    AND json_extract(receipt_json,'$.proposalId')=proposal_id
    AND json_extract(receipt_json,'$.fingerprint')=fingerprint
    AND json_extract(receipt_json,'$.customerId')=customer_id
    AND json_extract(receipt_json,'$.quoteId')=quote_id
    AND json_type(receipt_json,'$.quoteNumber')='null'
    AND json_extract(receipt_json,'$.status')='draft'
    AND json_type(receipt_json,'$.requiresHumanValidation')='true',0)),
  FOREIGN KEY(proposal_id,organization_id,fingerprint) REFERENCES action_engine_quote_proposals(id,organization_id,fingerprint),
  UNIQUE(organization_id,quote_id),
  UNIQUE(id,organization_id,proposal_id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE action_engine_quote_events (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 160),
  organization_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('proposal_saved','execution_reserved','receipt_confirmed')),
  actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) BETWEEN 1 AND 160),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  FOREIGN KEY(proposal_id,organization_id,fingerprint) REFERENCES action_engine_quote_proposals(id,organization_id,fingerprint),
  UNIQUE(proposal_id,event_type)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX action_engine_quote_events_company ON action_engine_quote_events(organization_id,created_at);
--> statement-breakpoint
-- These INSERT guards also block INSERT OR REPLACE with recursive_triggers OFF.
-- Repository replays use INSERT ... SELECT WHERE NOT EXISTS, not REPLACE/upsert.
CREATE TRIGGER action_engine_proposal_existing BEFORE INSERT ON action_engine_quote_proposals
WHEN EXISTS(SELECT 1 FROM action_engine_quote_proposals WHERE id=NEW.id OR
  (organization_id=NEW.organization_id AND source_id=NEW.source_id AND action_kind=NEW.action_kind))
BEGIN SELECT RAISE(ABORT,'action_engine_proposal_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_proposal_update BEFORE UPDATE ON action_engine_quote_proposals
BEGIN SELECT RAISE(ABORT,'action_engine_proposal_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_proposal_delete BEFORE DELETE ON action_engine_quote_proposals
BEGIN SELECT RAISE(ABORT,'action_engine_proposal_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_reservation_existing BEFORE INSERT ON action_engine_quote_reservations
WHEN EXISTS(SELECT 1 FROM action_engine_quote_reservations WHERE id=NEW.id OR proposal_id=NEW.proposal_id
  OR (organization_id=NEW.organization_id AND quote_id=NEW.quote_id))
BEGIN SELECT RAISE(ABORT,'action_engine_reservation_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_reservation_ready BEFORE INSERT ON action_engine_quote_reservations
WHEN NOT EXISTS(SELECT 1 FROM action_engine_quote_proposals p WHERE p.id=NEW.proposal_id AND p.organization_id=NEW.organization_id AND p.fingerprint=NEW.fingerprint AND json_extract(p.plan_json,'$.status')='ready')
BEGIN SELECT RAISE(ABORT,'action_engine_reservation_not_ready'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_reservation_update BEFORE UPDATE ON action_engine_quote_reservations
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.user_id IS NOT OLD.user_id OR NEW.installation_id IS NOT OLD.installation_id
  OR NEW.customer_id IS NOT OLD.customer_id OR NEW.quote_id IS NOT OLD.quote_id
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.receipt_json IS NOT NULL AND (NEW.receipt_json IS NOT OLD.receipt_json OR NEW.confirmed_at IS NOT OLD.confirmed_at))
BEGIN SELECT RAISE(ABORT,'action_engine_reservation_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_reservation_delete BEFORE DELETE ON action_engine_quote_reservations
BEGIN SELECT RAISE(ABORT,'action_engine_reservation_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_event_existing BEFORE INSERT ON action_engine_quote_events
WHEN EXISTS(SELECT 1 FROM action_engine_quote_events WHERE id=NEW.id OR (proposal_id=NEW.proposal_id AND event_type=NEW.event_type))
BEGIN SELECT RAISE(ABORT,'action_engine_event_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_event_update BEFORE UPDATE ON action_engine_quote_events
BEGIN SELECT RAISE(ABORT,'action_engine_event_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_event_delete BEFORE DELETE ON action_engine_quote_events
BEGIN SELECT RAISE(ABORT,'action_engine_event_immutable'); END;
