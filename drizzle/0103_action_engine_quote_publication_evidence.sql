-- Migration number: 0103 	 2026-10-11T02:15:06.367Z
-- Private A6 provenance. No route, permission mirror or confirmation activation.
CREATE TABLE action_engine_quote_reservation_bindings (
  reservation_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  resources_sha256 TEXT NOT NULL CHECK(length(resources_sha256)=64 AND resources_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_canonical_sha256 TEXT NOT NULL CHECK(length(source_canonical_sha256)=64 AND source_canonical_sha256 NOT GLOB '*[^0-9a-f]*'),
  planning_snapshot_id TEXT NOT NULL,
  planning_revision INTEGER NOT NULL CHECK(typeof(planning_revision)='integer' AND planning_revision BETWEEN 1 AND 9007199254740991),
  planning_base_revision INTEGER NOT NULL CHECK(typeof(planning_base_revision)='integer' AND planning_base_revision BETWEEN 0 AND 9007199254740990),
  planning_archive_sha256 TEXT NOT NULL CHECK(length(planning_archive_sha256)=64 AND planning_archive_sha256 NOT GLOB '*[^0-9a-f]*'),
  planning_manifest_sha256 TEXT NOT NULL CHECK(length(planning_manifest_sha256)=64 AND planning_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  CHECK(planning_revision=planning_base_revision+1),
  FOREIGN KEY(reservation_id,organization_id,proposal_id) REFERENCES action_engine_quote_reservations(id,organization_id,proposal_id),
  FOREIGN KEY(proposal_id,organization_id,fingerprint) REFERENCES action_engine_quote_proposals(id,organization_id,fingerprint),
  FOREIGN KEY(organization_id,planning_snapshot_id) REFERENCES action_engine_publication_attempts(organization_id,snapshot_id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TRIGGER action_engine_quote_binding_insert BEFORE INSERT ON action_engine_quote_reservation_bindings BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM action_engine_quote_reservation_bindings WHERE reservation_id=NEW.reservation_id)
    THEN RAISE(ABORT,'action_engine_quote_binding_immutable') END;
  -- The repository inserts this before execution_reserved in the SAME batch.
  -- A previously audited unbound reservation cannot be retroactively repaired.
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM action_engine_quote_reservations r
      JOIN action_engine_quote_proposals q ON q.id=r.proposal_id AND q.organization_id=r.organization_id AND q.fingerprint=r.fingerprint
      JOIN action_engine_publication_attempts p ON p.organization_id=r.organization_id AND p.snapshot_id=NEW.planning_snapshot_id
      WHERE r.id=NEW.reservation_id AND r.organization_id=NEW.organization_id AND r.proposal_id=NEW.proposal_id AND r.fingerprint=NEW.fingerprint
        AND r.created_at=NEW.created_at AND r.receipt_json IS NULL AND json_extract(q.plan_json,'$.status')='ready'
        AND p.base_revision=NEW.planning_base_revision AND p.archive_sha256=NEW.planning_archive_sha256 AND p.manifest_sha256=NEW.planning_manifest_sha256
        AND p.state='committed' AND json_extract(p.result_json,'$.committed')=1
        AND json_extract(p.result_json,'$.revision')=NEW.planning_revision AND json_extract(p.result_json,'$.snapshotId')=p.snapshot_id)
    OR EXISTS(SELECT 1 FROM action_engine_quote_events WHERE proposal_id=NEW.proposal_id AND event_type='execution_reserved')
    THEN RAISE(ABORT,'action_engine_quote_binding_invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER action_engine_quote_binding_update BEFORE UPDATE ON action_engine_quote_reservation_bindings BEGIN SELECT RAISE(ABORT,'action_engine_quote_binding_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_quote_binding_delete BEFORE DELETE ON action_engine_quote_reservation_bindings BEGIN SELECT RAISE(ABORT,'action_engine_quote_binding_immutable'); END;
--> statement-breakpoint
CREATE TABLE action_engine_quote_publication_evidence (
  organization_id TEXT NOT NULL CHECK(length(organization_id) BETWEEN 1 AND 160),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 160),
  proposal_id TEXT NOT NULL CHECK(length(proposal_id) BETWEEN 1 AND 160),
  reservation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 160),
  installation_id TEXT NOT NULL CHECK(length(installation_id) BETWEEN 1 AND 160),
  customer_id TEXT NOT NULL CHECK(length(customer_id) BETWEEN 1 AND 160),
  quote_id TEXT NOT NULL CHECK(length(quote_id)=36 AND quote_id NOT GLOB '*[^0-9a-f-]*'),
  publication_attempt_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL CHECK(typeof(base_revision)='integer' AND base_revision BETWEEN 0 AND 9007199254740990),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision=base_revision+1 AND revision<=9007199254740991),
  archive_sha256 TEXT NOT NULL CHECK(length(archive_sha256)=64 AND archive_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  sqlite_sha256 TEXT NOT NULL CHECK(length(sqlite_sha256)=64 AND sqlite_sha256 NOT GLOB '*[^0-9a-f]*'),
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  canonical_facts_sha256 TEXT NOT NULL CHECK(length(canonical_facts_sha256)=64 AND canonical_facts_sha256 NOT GLOB '*[^0-9a-f]*'),
  validator_version TEXT NOT NULL CHECK(validator_version='quote-canonical-v1'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object' AND length(CAST(receipt_json AS BLOB))<=4096),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  PRIMARY KEY(organization_id,reservation_id),
  UNIQUE(organization_id,proposal_id), UNIQUE(organization_id,source_id), UNIQUE(organization_id,quote_id),
  FOREIGN KEY(reservation_id,organization_id,proposal_id) REFERENCES action_engine_quote_reservations(id,organization_id,proposal_id),
  FOREIGN KEY(proposal_id,organization_id,fingerprint) REFERENCES action_engine_quote_proposals(id,organization_id,fingerprint),
  FOREIGN KEY(reservation_id) REFERENCES action_engine_quote_reservation_bindings(reservation_id),
  FOREIGN KEY(publication_attempt_id) REFERENCES action_engine_publication_attempts(id),
  CHECK(COALESCE(json_extract(receipt_json,'$.organizationId')=organization_id AND json_extract(receipt_json,'$.proposalId')=proposal_id
    AND json_extract(receipt_json,'$.fingerprint')=fingerprint AND json_extract(receipt_json,'$.customerId')=customer_id
    AND json_extract(receipt_json,'$.quoteId')=quote_id AND json_type(receipt_json,'$.quoteNumber')='null'
    AND json_extract(receipt_json,'$.status')='draft' AND json_type(receipt_json,'$.requiresHumanValidation')='true'
    AND json_remove(receipt_json,'$.organizationId','$.proposalId','$.fingerprint','$.customerId','$.quoteId','$.quoteNumber','$.status','$.requiresHumanValidation')='{}',0))
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TRIGGER action_engine_quote_evidence_insert BEFORE INSERT ON action_engine_quote_publication_evidence BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM json_each(NEW.receipt_json))<>8
    OR (SELECT count(DISTINCT key) FROM json_each(NEW.receipt_json))<>8
    THEN RAISE(ABORT,'action_engine_quote_evidence_invalid') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM action_engine_quote_publication_evidence WHERE organization_id=NEW.organization_id
    AND (reservation_id=NEW.reservation_id OR proposal_id=NEW.proposal_id OR source_id=NEW.source_id OR quote_id=NEW.quote_id))
    THEN RAISE(ABORT,'action_engine_quote_evidence_immutable') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM action_engine_quote_reservations r
    JOIN action_engine_quote_proposals q ON q.id=r.proposal_id AND q.organization_id=r.organization_id AND q.fingerprint=r.fingerprint
    JOIN action_engine_quote_reservation_bindings b ON b.reservation_id=r.id AND b.organization_id=r.organization_id AND b.proposal_id=r.proposal_id AND b.fingerprint=r.fingerprint
    JOIN action_engine_publication_attempts p ON p.id=NEW.publication_attempt_id AND p.organization_id=r.organization_id
    JOIN action_engine_publication_attempts h ON h.organization_id=b.organization_id AND h.snapshot_id=b.planning_snapshot_id
      AND h.base_revision=b.planning_base_revision AND h.archive_sha256=b.planning_archive_sha256 AND h.manifest_sha256=b.planning_manifest_sha256
      AND h.state='committed' AND json_extract(h.result_json,'$.committed')=1 AND json_extract(h.result_json,'$.revision')=b.planning_revision
      AND json_extract(h.result_json,'$.snapshotId')=h.snapshot_id
    WHERE r.id=NEW.reservation_id AND r.organization_id=NEW.organization_id AND r.proposal_id=NEW.proposal_id AND r.fingerprint=NEW.fingerprint
      AND r.user_id=NEW.user_id AND r.installation_id=NEW.installation_id AND r.customer_id=NEW.customer_id AND r.quote_id=NEW.quote_id
      AND p.user_id=NEW.user_id AND p.installation_id=NEW.installation_id
      AND q.source_id=NEW.source_id AND r.created_at<=NEW.created_at AND p.created_at>=r.created_at AND p.settled_at<=NEW.created_at
      AND NEW.revision>b.planning_revision AND json_extract(q.plan_json,'$.status')='ready'
      AND p.snapshot_id=NEW.snapshot_id AND p.base_revision=NEW.base_revision AND p.archive_sha256=NEW.archive_sha256 AND p.manifest_sha256=NEW.manifest_sha256
      AND p.state='committed' AND json_extract(p.result_json,'$.committed')=1 AND json_extract(p.result_json,'$.revision')=NEW.revision
      AND json_extract(p.result_json,'$.snapshotId')=p.snapshot_id)
    THEN RAISE(ABORT,'action_engine_quote_evidence_invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER action_engine_quote_evidence_update BEFORE UPDATE ON action_engine_quote_publication_evidence BEGIN SELECT RAISE(ABORT,'action_engine_quote_evidence_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_quote_evidence_delete BEFORE DELETE ON action_engine_quote_publication_evidence BEGIN SELECT RAISE(ABORT,'action_engine_quote_evidence_immutable'); END;
