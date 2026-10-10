-- Migration number: 0092 	 2026-10-10T00:24:58.011Z
-- TEST lifecycle is an append-only extension of admitted 0091 purchases.
-- No historical authority, receipt, CH row, offer or seat contract is rewritten.
-- These guards corroborate private gateway attestations; they do not verify Stripe.
CREATE UNIQUE INDEX international_us_saas_revocation_identity ON international_saas_authorities(organization_id,revoked_at);
--> statement-breakpoint
CREATE TABLE international_us_saas_test_lifecycle_receipts (
  receipt_hash TEXT PRIMARY KEY NOT NULL CHECK(length(receipt_hash)=64 AND receipt_hash NOT GLOB '*[^0-9a-f]*'),
  purchase_id TEXT NOT NULL REFERENCES international_us_saas_test_paid_proofs(purchase_id),
  organization_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 5 AND 128 AND substr(event_id,1,4)='evt_' AND event_id NOT GLOB '*[^A-Za-z0-9_]*'),
  source_type TEXT NOT NULL CHECK(source_type IN('invoice','subscription','charge','dispute')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 4 AND 128 AND source_id NOT GLOB '*[^A-Za-z0-9_]*'),
  action TEXT NOT NULL CHECK(action IN('paid_period','observe','revoke')),
  reason TEXT NOT NULL,
  invoice_id TEXT CHECK(invoice_id IS NULL OR (length(invoice_id) BETWEEN 4 AND 128 AND substr(invoice_id,1,3)='in_' AND invoice_id NOT GLOB '*[^A-Za-z0-9_]*')),
  material_json TEXT NOT NULL CHECK(json_valid(material_json) AND json_type(material_json)='object' AND length(CAST(material_json AS BLOB))<=65536),
  observed_at INTEGER NOT NULL CHECK(typeof(observed_at)='integer' AND observed_at BETWEEN 1 AND 253402300799),
  period_invoice_id TEXT,
  applied_revoked_at INTEGER,
  CHECK((action='paid_period' AND reason='paid' AND invoice_id IS NOT NULL AND period_invoice_id IS NOT NULL AND period_invoice_id=invoice_id AND applied_revoked_at IS NULL)
    OR (action='observe' AND reason IN('payment_pending','canceled_paid_through') AND period_invoice_id IS NULL AND applied_revoked_at IS NULL)
    OR (action='revoke' AND reason IN('refunded','disputed','restricted') AND invoice_id IS NOT NULL AND period_invoice_id IS NULL AND typeof(applied_revoked_at)='integer' AND applied_revoked_at>0)),
  FOREIGN KEY(organization_id,provider_account_id,period_invoice_id) REFERENCES international_us_saas_test_periods(organization_id,provider_account_id,invoice_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(organization_id,applied_revoked_at) REFERENCES international_saas_authorities(organization_id,revoked_at) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE international_us_saas_test_periods (
  provider_account_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  purchase_id TEXT NOT NULL REFERENCES international_us_saas_test_paid_proofs(purchase_id),
  subscription_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL CHECK(typeof(starts_at)='integer' AND starts_at BETWEEN 1 AND 253402300798),
  ends_at INTEGER NOT NULL CHECK(typeof(ends_at)='integer' AND ends_at>starts_at AND ends_at<=253402300799),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json) AND json_type(authority_json)='object' AND length(CAST(authority_json AS BLOB))<=32768),
  observed_at INTEGER NOT NULL CHECK(typeof(observed_at)='integer' AND observed_at BETWEEN starts_at AND ends_at-1),
  receipt_hash TEXT NOT NULL UNIQUE REFERENCES international_us_saas_test_lifecycle_receipts(receipt_hash) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY(provider_account_id,invoice_id),
  UNIQUE(organization_id,provider_account_id,invoice_id),
  UNIQUE(organization_id,starts_at,ends_at)
);
--> statement-breakpoint
CREATE INDEX international_us_saas_test_period_lookup ON international_us_saas_test_periods(organization_id,ends_at DESC,starts_at);
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_lifecycle_receipt_insert BEFORE INSERT ON international_us_saas_test_lifecycle_receipts
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_saas_test_lifecycle_receipts WHERE receipt_hash=NEW.receipt_hash)
    THEN RAISE(ABORT,'us_lifecycle_receipt_exists') END;
  SELECT CASE WHEN NEW.observed_at>unixepoch() OR NEW.observed_at<unixepoch()-60 OR NOT EXISTS(
    SELECT 1 FROM international_us_saas_test_paid_proofs proof JOIN international_us_saas_test_purchases p ON p.purchase_id=proof.purchase_id
    JOIN international_us_saas_test_sessions s ON s.purchase_id=p.purchase_id AND s.session_id=proof.session_id
    JOIN international_saas_authorities a ON a.organization_id=proof.organization_id AND a.creation_id=proof.creation_id AND a.owner_user_id=proof.actor_user_id AND a.subscription_id=proof.subscription_id
    JOIN international_workspace_creation_intents i ON i.creation_id=p.creation_id AND i.organization_id=p.organization_id
    WHERE p.purchase_id=NEW.purchase_id AND proof.organization_id=NEW.organization_id AND proof.subscription_id=NEW.subscription_id
      AND proof.customer_id=NEW.customer_id AND proof.provider_account_id=NEW.provider_account_id AND p.provider_account_id=NEW.provider_account_id
      AND a.environment='TEST' AND a.country='US' AND a.currency='USD' AND a.authority_json=proof.authority_json AND a.offer_json=p.offer_json AND a.seat_limit=p.seat_limit
      AND i.state='ready' AND i.own_subscription_id=a.subscription_id AND i.actor_user_id=p.actor_user_id AND i.configuration_fingerprint=p.configuration_fingerprint AND i.pg_receipt_json=p.receipt_json
      AND NEW.observed_at>=proof.verified_at AND (NEW.action<>'paid_period' OR a.revoked_at IS NULL)
      AND (NEW.action<>'revoke' OR NEW.applied_revoked_at=COALESCE(a.revoked_at,NEW.observed_at))
      AND NOT EXISTS(SELECT 1 FROM organizations WHERE organization_id=a.organization_id OR subscription_id=a.subscription_id)
      AND NOT EXISTS(SELECT 1 FROM subscriptions WHERE subscription_id=a.subscription_id))
    THEN RAISE(ABORT,'us_lifecycle_scope') END;
  SELECT CASE WHEN NOT COALESCE((SELECT count(*) FROM json_each(NEW.material_json))=13
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.material_json) WHERE key NOT IN('eventId','subscriptionId','sourceType','sourceId','purchaseId','organizationId','customerId','providerAccountId','action','reason','invoiceId','authority','serverPrice'))
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.material_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
    AND json_extract(NEW.material_json,'$.eventId')=NEW.event_id AND json_extract(NEW.material_json,'$.subscriptionId')=NEW.subscription_id
    AND json_extract(NEW.material_json,'$.sourceType')=NEW.source_type AND json_extract(NEW.material_json,'$.sourceId')=NEW.source_id
    AND json_extract(NEW.material_json,'$.purchaseId')=NEW.purchase_id AND json_extract(NEW.material_json,'$.organizationId')=NEW.organization_id
    AND json_extract(NEW.material_json,'$.customerId')=NEW.customer_id AND json_extract(NEW.material_json,'$.providerAccountId')=NEW.provider_account_id
    AND json_extract(NEW.material_json,'$.action')=NEW.action AND json_extract(NEW.material_json,'$.reason')=NEW.reason
    AND json_extract(NEW.material_json,'$.invoiceId') IS NEW.invoice_id
    AND ((NEW.source_type='invoice' AND substr(NEW.source_id,1,3)='in_') OR (NEW.source_type='subscription' AND substr(NEW.source_id,1,4)='sub_')
      OR (NEW.source_type='charge' AND substr(NEW.source_id,1,3)='ch_') OR (NEW.source_type='dispute' AND substr(NEW.source_id,1,3)='dp_'))
    AND ((NEW.action='paid_period' AND json_type(NEW.material_json,'$.authority')='object' AND json_type(NEW.material_json,'$.serverPrice')='object')
      OR (NEW.action<>'paid_period' AND json_type(NEW.material_json,'$.authority')='null' AND json_type(NEW.material_json,'$.serverPrice')='null')),0)
    THEN RAISE(ABORT,'us_lifecycle_invalid_receipt') END;
  SELECT CASE WHEN NEW.action='paid_period' AND EXISTS(SELECT 1 FROM international_us_saas_test_periods p
    WHERE p.provider_account_id=NEW.provider_account_id AND p.invoice_id=NEW.invoice_id AND (p.organization_id<>NEW.organization_id OR p.purchase_id<>NEW.purchase_id
      OR p.subscription_id<>NEW.subscription_id OR p.customer_id<>NEW.customer_id OR p.authority_json<>json_extract(NEW.material_json,'$.authority')))
    THEN RAISE(ABORT,'us_lifecycle_period_conflict') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_period_insert BEFORE INSERT ON international_us_saas_test_periods
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_saas_test_periods WHERE (provider_account_id=NEW.provider_account_id AND invoice_id=NEW.invoice_id) OR (organization_id=NEW.organization_id AND starts_at=NEW.starts_at AND ends_at=NEW.ends_at))
    THEN RAISE(ABORT,'us_lifecycle_period_exists') END;
  SELECT CASE WHEN NEW.observed_at>unixepoch() OR NEW.observed_at<unixepoch()-60 OR NOT EXISTS(
    SELECT 1 FROM international_us_saas_test_lifecycle_receipts r JOIN international_us_saas_test_paid_proofs proof ON proof.purchase_id=r.purchase_id
    JOIN international_us_saas_test_purchases p ON p.purchase_id=proof.purchase_id JOIN international_saas_authorities a ON a.organization_id=proof.organization_id
    WHERE r.receipt_hash=NEW.receipt_hash AND r.action='paid_period' AND r.purchase_id=NEW.purchase_id AND r.organization_id=NEW.organization_id
      AND r.provider_account_id=NEW.provider_account_id AND r.invoice_id=NEW.invoice_id AND r.subscription_id=NEW.subscription_id AND r.customer_id=NEW.customer_id
      AND r.observed_at=NEW.observed_at AND json_extract(r.material_json,'$.authority')=NEW.authority_json
      AND a.revoked_at IS NULL AND a.environment='TEST' AND p.provider_account_id=NEW.provider_account_id AND NEW.starts_at>=p.created_at
      AND json_type(NEW.authority_json,'$.evidence.startsAt')='integer' AND json_extract(NEW.authority_json,'$.evidence.startsAt')=NEW.starts_at
      AND json_type(NEW.authority_json,'$.evidence.endsAt')='integer' AND json_extract(NEW.authority_json,'$.evidence.endsAt')=NEW.ends_at
      AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.authority_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
      AND NOT EXISTS(SELECT fullkey,type,atom FROM json_tree(NEW.authority_json) EXCEPT SELECT fullkey,type,atom FROM json_tree(json_set(a.authority_json,'$.evidence.referenceId',NEW.invoice_id,'$.evidence.startsAt',NEW.starts_at,'$.evidence.endsAt',NEW.ends_at)))
      AND NOT EXISTS(SELECT fullkey,type,atom FROM json_tree(json_set(a.authority_json,'$.evidence.referenceId',NEW.invoice_id,'$.evidence.startsAt',NEW.starts_at,'$.evidence.endsAt',NEW.ends_at)) EXCEPT SELECT fullkey,type,atom FROM json_tree(NEW.authority_json))
      AND (NEW.invoice_id<>proof.invoice_id OR NEW.authority_json=proof.authority_json))
    THEN RAISE(ABORT,'us_lifecycle_period_scope') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_lifecycle_receipt_no_update BEFORE UPDATE ON international_us_saas_test_lifecycle_receipts BEGIN SELECT RAISE(ABORT,'us_lifecycle_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_lifecycle_receipt_no_delete BEFORE DELETE ON international_us_saas_test_lifecycle_receipts BEGIN SELECT RAISE(ABORT,'us_lifecycle_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_period_no_update BEFORE UPDATE ON international_us_saas_test_periods BEGIN SELECT RAISE(ABORT,'us_lifecycle_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_period_no_delete BEFORE DELETE ON international_us_saas_test_periods BEGIN SELECT RAISE(ABORT,'us_lifecycle_immutable'); END;
--> statement-breakpoint
CREATE VIEW international_effective_saas_authorities AS
SELECT a.organization_id,a.creation_id,a.owner_user_id,a.subscription_id,a.environment,a.catalog_version,a.country,a.currency,a.offer_json,
  COALESCE((SELECT p.authority_json FROM international_us_saas_test_periods p WHERE p.organization_id=a.organization_id AND p.starts_at<=unixepoch()
    AND p.ends_at>json_extract(a.authority_json,'$.evidence.endsAt') ORDER BY p.ends_at DESC,p.starts_at DESC,p.invoice_id LIMIT 1),a.authority_json) AS authority_json,
  a.seat_limit,a.revision,a.updated_at,a.revoked_at
FROM international_saas_authorities a;

--> statement-breakpoint
DROP TRIGGER international_us_member_admission;
--> statement-breakpoint
CREATE TRIGGER international_us_member_admission BEFORE INSERT ON international_workspace_members
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_workspace_members WHERE membership_id=NEW.membership_id OR (organization_id=NEW.organization_id AND user_id=NEW.user_id))
    THEN RAISE(ABORT,'international_us_membership_exists') END;
  SELECT CASE WHEN NEW.revoked_at IS NOT NULL OR NEW.joined_at>unixepoch()
    OR EXISTS(SELECT 1 FROM organizations WHERE organization_id=NEW.organization_id)
    OR NOT EXISTS(SELECT 1 FROM international_effective_saas_authorities a JOIN international_workspace_creation_intents i ON i.creation_id=a.creation_id AND i.organization_id=a.organization_id
      WHERE a.organization_id=NEW.organization_id AND a.revoked_at IS NULL
        AND json_extract(a.authority_json,'$.evidence.startsAt')<=unixepoch() AND json_extract(a.authority_json,'$.evidence.endsAt')>unixepoch()
        AND ((i.state='postgres_confirmed' AND NEW.role='owner' AND NEW.user_id=a.owner_user_id AND NEW.user_id=i.actor_user_id)
          OR (i.state='ready' AND i.own_subscription_id=a.subscription_id AND NEW.role<>'owner' AND NEW.user_id<>a.owner_user_id
            AND EXISTS(SELECT 1 FROM international_workspace_members owner WHERE owner.organization_id=a.organization_id AND owner.user_id=a.owner_user_id AND owner.role='owner' AND owner.revoked_at IS NULL))))
    THEN RAISE(ABORT,'international_us_membership_scope') END;
  SELECT CASE WHEN (SELECT count(*) FROM international_workspace_members WHERE organization_id=NEW.organization_id AND revoked_at IS NULL)>=(SELECT seat_limit FROM international_saas_authorities WHERE organization_id=NEW.organization_id)
    THEN RAISE(ABORT,'international_us_seat_limit') END;
END;

--> statement-breakpoint
DROP TRIGGER international_us_team_command_insert;
--> statement-breakpoint
CREATE TRIGGER international_us_team_command_insert BEFORE INSERT ON international_us_team_commands
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_team_commands WHERE command_id=NEW.command_id OR (organization_id=NEW.organization_id AND actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id)) THEN RAISE(ABORT,'us_team_idempotency_conflict') END;
 SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(SELECT 1 FROM international_us_team_heads WHERE organization_id=NEW.organization_id AND revision=NEW.expected_revision) THEN RAISE(ABORT,'us_team_revision_conflict') END;
 SELECT CASE WHEN NOT COALESCE(json_extract(NEW.command_json,'$.schemaVersion')=1 AND json_extract(NEW.command_json,'$.requestId')=NEW.request_id
 AND json_extract(NEW.command_json,'$.expectedTeamRevision')=NEW.expected_revision AND json_extract(NEW.command_json,'$.action')=NEW.action
 AND json_extract(NEW.context_json,'$.schemaVersion')=1 AND json_extract(NEW.context_json,'$.organizationId')=NEW.organization_id
 AND json_extract(NEW.context_json,'$.user.userId')=NEW.actor_user_id AND json_extract(NEW.context_json,'$.checkedAt')=NEW.created_at
 AND json_extract(NEW.receipt_json,'$.schemaVersion')=1 AND json_extract(NEW.receipt_json,'$.organizationId')=NEW.organization_id
 AND json_extract(NEW.receipt_json,'$.requestId')=NEW.request_id AND json_extract(NEW.receipt_json,'$.action')=NEW.action
 AND json_extract(NEW.receipt_json,'$.entityId')=NEW.entity_id AND json_extract(NEW.receipt_json,'$.revision')=NEW.revision,0)
 OR (SELECT count(*) FROM json_each(NEW.receipt_json))<>6
 OR (SELECT count(*) FROM json_each(NEW.context_json))<>13+(CASE WHEN json_type(NEW.context_json,'$.credential') IS NULL THEN 0 ELSE 1 END)
 OR EXISTS(SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN('schemaVersion','organizationId','mode','role','user','subscriptionId','environment','catalogVersion','priceId','seatLimit','checkedAt','validStartsAt','validEndsAt','credential'))
 OR (SELECT count(*) FROM json_each(NEW.context_json,'$.user'))<>3 OR EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.user') WHERE key NOT IN('userId','email','emailConfirmed'))
 OR (SELECT count(*) FROM json_each(NEW.command_json))<>(CASE NEW.action WHEN 'create_invitation' THEN 9 WHEN 'regenerate_invitation' THEN 8 WHEN 'revoke_invitation' THEN 5 WHEN 'accept_invitation' THEN 10 WHEN 'revoke_member' THEN 5 END)
 OR EXISTS(SELECT 1 FROM json_each(NEW.command_json) WHERE key NOT IN('schemaVersion','requestId','expectedTeamRevision','action','email','role','invitationId','newInvitationId','tokenHash','expiresAt','membershipId','firstName','lastName','displayName'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.command_json) WHERE key NOT IN('schemaVersion','requestId','expectedTeamRevision','action') AND NOT
 ((NEW.action='create_invitation' AND key IN('email','role','invitationId','tokenHash','expiresAt'))
 OR (NEW.action='regenerate_invitation' AND key IN('invitationId','newInvitationId','tokenHash','expiresAt'))
 OR (NEW.action='revoke_invitation' AND key='invitationId') OR (NEW.action='revoke_member' AND key='membershipId')
 OR (NEW.action='accept_invitation' AND key IN('invitationId','tokenHash','membershipId','firstName','lastName','displayName'))))
 OR json_type(NEW.command_json,'$.schemaVersion')<>'integer' OR json_type(NEW.command_json,'$.expectedTeamRevision')<>'integer'
 OR json_type(NEW.context_json,'$.schemaVersion')<>'integer' OR json_type(NEW.context_json,'$.checkedAt')<>'integer'
 OR json_type(NEW.context_json,'$.seatLimit')<>'integer' OR json_type(NEW.context_json,'$.validStartsAt')<>'integer' OR json_type(NEW.context_json,'$.validEndsAt')<>'integer'
 OR json_type(NEW.context_json,'$.user.emailConfirmed') NOT IN('true','false') OR json_type(NEW.context_json,'$.user.email') NOT IN('null','text')
 OR json_type(NEW.receipt_json,'$.schemaVersion')<>'integer' OR json_type(NEW.receipt_json,'$.revision')<>'integer'
 OR EXISTS(SELECT 1 FROM json_tree(NEW.context_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM json_tree(NEW.command_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM json_tree(NEW.receipt_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
 THEN RAISE(ABORT,'us_team_invalid_record') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_effective_saas_authorities a JOIN international_workspace_creation_intents i ON i.creation_id=a.creation_id
 JOIN international_workspace_members owner ON owner.organization_id=a.organization_id AND owner.user_id=a.owner_user_id AND owner.role='owner' AND owner.revoked_at IS NULL
 WHERE a.organization_id=NEW.organization_id AND a.revoked_at IS NULL AND i.state='ready' AND i.own_subscription_id=a.subscription_id
 AND a.country='US' AND a.currency='USD' AND a.subscription_id=json_extract(NEW.context_json,'$.subscriptionId')
 AND a.environment=json_extract(NEW.context_json,'$.environment') AND a.catalog_version=json_extract(NEW.context_json,'$.catalogVersion')
 AND json_extract(a.offer_json,'$.priceId')=json_extract(NEW.context_json,'$.priceId') AND a.seat_limit=json_extract(NEW.context_json,'$.seatLimit')
 AND json_extract(a.authority_json,'$.evidence.startsAt')=json_extract(NEW.context_json,'$.validStartsAt') AND json_extract(a.authority_json,'$.evidence.endsAt')=json_extract(NEW.context_json,'$.validEndsAt')
 AND json_extract(a.authority_json,'$.evidence.startsAt')<=unixepoch() AND json_extract(a.authority_json,'$.evidence.endsAt')>unixepoch()
 AND json_extract(a.authority_json,'$.status')='active' AND json_extract(a.authority_json,'$.evidence.revoked')=0)
 THEN RAISE(ABORT,'us_team_subscription_required') END;
 SELECT CASE WHEN NEW.action<>'accept_invitation' AND (json_extract(NEW.context_json,'$.mode')<>'member' OR NOT EXISTS(SELECT 1 FROM international_workspace_members m
 WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id AND m.revoked_at IS NULL AND m.role=json_extract(NEW.context_json,'$.role') AND m.role IN('owner','admin')))
 THEN RAISE(ABORT,'us_team_management_required') END;
 SELECT CASE WHEN NEW.action='create_invitation' AND (json_extract(NEW.command_json,'$.invitationId')<>NEW.entity_id OR (json_extract(NEW.context_json,'$.role')='admin' AND json_extract(NEW.command_json,'$.role') NOT IN('member','read_only'))) THEN RAISE(ABORT,'us_team_management_required') END;
 SELECT CASE WHEN NEW.action IN('regenerate_invitation','revoke_invitation') AND NOT EXISTS(SELECT 1 FROM international_us_team_invitations v WHERE v.organization_id=NEW.organization_id
 AND v.invitation_id=json_extract(NEW.command_json,'$.invitationId') AND v.status='pending' AND (json_extract(NEW.context_json,'$.role')='owner' OR v.role IN('member','read_only')))
 THEN RAISE(ABORT,'us_team_invitation_unavailable') END;
 SELECT CASE WHEN NEW.action='regenerate_invitation' AND json_extract(NEW.command_json,'$.newInvitationId')<>NEW.entity_id THEN RAISE(ABORT,'us_team_invalid_record') END;
 SELECT CASE WHEN NEW.action='revoke_invitation' AND json_extract(NEW.command_json,'$.invitationId')<>NEW.entity_id THEN RAISE(ABORT,'us_team_invalid_record') END;
 SELECT CASE WHEN NEW.action='accept_invitation' AND (json_extract(NEW.context_json,'$.mode')<>'recipient' OR json_type(NEW.context_json,'$.user.emailConfirmed')<>'true'
 OR json_extract(NEW.command_json,'$.membershipId')<>NEW.entity_id OR NOT EXISTS(SELECT 1 FROM international_us_team_invitations v WHERE v.organization_id=NEW.organization_id
 AND v.invitation_id=json_extract(NEW.command_json,'$.invitationId') AND v.token_hash=json_extract(NEW.command_json,'$.tokenHash') AND v.email=json_extract(NEW.context_json,'$.user.email')
 AND v.role=json_extract(NEW.context_json,'$.role') AND v.status='pending' AND v.expires_at>unixepoch())
 OR EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id)) THEN RAISE(ABORT,'us_team_invitation_unavailable') END;
 SELECT CASE WHEN NEW.action='revoke_member' AND (json_extract(NEW.command_json,'$.membershipId')<>NEW.entity_id OR NOT EXISTS(SELECT 1 FROM international_workspace_members m
 WHERE m.organization_id=NEW.organization_id AND m.membership_id=NEW.entity_id AND m.revoked_at IS NULL AND m.role<>'owner' AND m.user_id<>NEW.actor_user_id
 AND (json_extract(NEW.context_json,'$.role')='owner' OR m.role IN('member','read_only')))) THEN RAISE(ABORT,'us_team_member_protected') END;
END;

--> statement-breakpoint
DROP VIEW international_us_device_admissible;
--> statement-breakpoint
-- US credentials only. No organization, entitlement, CH licence or book is minted.
CREATE VIEW international_us_device_admissible AS
SELECT i.organization_id,i.company_name,m.user_id,m.role,a.subscription_id,
  json_extract(a.authority_json,'$.evidence.endsAt') AS entitlement_valid_until
FROM international_workspace_creation_intents i
JOIN international_effective_saas_authorities a ON a.creation_id=i.creation_id AND a.organization_id=i.organization_id AND a.subscription_id=i.own_subscription_id
JOIN international_workspace_members m ON m.organization_id=a.organization_id AND m.revoked_at IS NULL
JOIN international_workspace_members owner ON owner.organization_id=a.organization_id AND owner.user_id=a.owner_user_id AND owner.role='owner' AND owner.revoked_at IS NULL
WHERE i.state='ready' AND a.country='US' AND a.currency='USD' AND a.revoked_at IS NULL
  AND json_extract(a.authority_json,'$.status')='active'
  AND json_extract(a.authority_json,'$.evidence.kind')='verified_payment'
  AND json_extract(a.authority_json,'$.evidence.revoked')=0
  AND json_extract(a.authority_json,'$.evidence.startsAt')<=unixepoch()
  AND json_extract(a.authority_json,'$.evidence.endsAt')>unixepoch()
  AND (SELECT count(*) FROM international_workspace_members seats WHERE seats.organization_id=a.organization_id AND seats.revoked_at IS NULL)<=a.seat_limit
  AND NOT EXISTS(SELECT 1 FROM organizations legacy WHERE legacy.organization_id=a.organization_id);

--> statement-breakpoint
DROP TRIGGER international_us_device_challenge_update;
--> statement-breakpoint
CREATE TRIGGER international_us_device_challenge_update BEFORE UPDATE ON international_us_device_challenges
BEGIN
  SELECT CASE WHEN NEW.device_code_hash IS NOT OLD.device_code_hash OR NEW.user_code IS NOT OLD.user_code OR NEW.installation_id IS NOT OLD.installation_id OR NEW.session_token_hash IS NOT OLD.session_token_hash
    OR NEW.supported_schema_version IS NOT OLD.supported_schema_version OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR NOT ((OLD.status='pending' AND NEW.status='approved' AND NEW.consumed_session_id IS NULL AND NEW.approved_at<=unixepoch() AND NEW.expires_at>unixepoch())
      OR (OLD.status='approved' AND NEW.status='consumed' AND NEW.organization_id IS OLD.organization_id AND NEW.approved_user_id IS OLD.approved_user_id AND NEW.approved_role IS OLD.approved_role
        AND NEW.subscription_id IS OLD.subscription_id AND NEW.entitlement_valid_until IS OLD.entitlement_valid_until AND NEW.approved_at IS OLD.approved_at AND NEW.expires_at>unixepoch()))
    OR NOT EXISTS(SELECT 1 FROM international_us_device_admissible a WHERE a.organization_id=NEW.organization_id AND a.user_id=NEW.approved_user_id AND a.role=NEW.approved_role AND a.subscription_id=NEW.subscription_id AND a.entitlement_valid_until>=NEW.entitlement_valid_until)
    THEN RAISE(ABORT,'us_device_admission_required') END;
  SELECT CASE WHEN NEW.status='consumed' AND NOT EXISTS(SELECT 1 FROM international_us_device_sessions s WHERE s.session_id=NEW.consumed_session_id AND s.device_code_hash=NEW.device_code_hash AND s.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_device_consumption_required') END;
END;

--> statement-breakpoint
DROP TRIGGER international_us_device_session_insert;
--> statement-breakpoint
CREATE TRIGGER international_us_device_session_insert BEFORE INSERT ON international_us_device_sessions
BEGIN
  SELECT CASE WHEN NEW.revoked_at IS NOT NULL OR NEW.created_at>unixepoch()
    OR EXISTS(SELECT 1 FROM international_us_device_sessions WHERE session_id=NEW.session_id OR token_hash=NEW.token_hash OR device_code_hash=NEW.device_code_hash)
    OR NOT EXISTS(SELECT 1 FROM international_us_device_challenges c JOIN international_us_device_admissible a ON a.organization_id=c.organization_id AND a.user_id=c.approved_user_id
      WHERE c.device_code_hash=NEW.device_code_hash AND c.status='approved' AND c.expires_at>unixepoch() AND c.session_token_hash=NEW.token_hash AND c.installation_id=NEW.installation_id
        AND c.organization_id=NEW.organization_id AND c.approved_user_id=NEW.user_id AND c.approved_role=NEW.role AND c.subscription_id=NEW.subscription_id AND c.entitlement_valid_until=NEW.entitlement_valid_until
        AND a.role=NEW.role AND a.subscription_id=NEW.subscription_id AND a.entitlement_valid_until>=NEW.entitlement_valid_until AND c.supported_schema_version=NEW.supported_schema_version
        AND NEW.created_at>=c.approved_at AND NEW.expires_at>unixepoch() AND NEW.expires_at=min(NEW.created_at+2592000,c.entitlement_valid_until))
    THEN RAISE(ABORT,'us_device_admission_required') END;
END;

--> statement-breakpoint
DROP TRIGGER international_us_device_v4_challenge_update;
--> statement-breakpoint
CREATE TRIGGER international_us_device_v4_challenge_update BEFORE UPDATE ON international_us_device_v4_challenges
BEGIN
  SELECT CASE WHEN NEW.device_code_hash IS NOT OLD.device_code_hash OR NEW.user_code IS NOT OLD.user_code OR NEW.installation_id IS NOT OLD.installation_id OR NEW.session_token_hash IS NOT OLD.session_token_hash
    OR NEW.supported_schema_version IS NOT OLD.supported_schema_version OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR NOT ((OLD.status='pending' AND NEW.status='approved' AND NEW.consumed_session_id IS NULL AND NEW.approved_at<=unixepoch() AND NEW.expires_at>unixepoch())
      OR (OLD.status='approved' AND NEW.status='consumed' AND NEW.organization_id IS OLD.organization_id AND NEW.approved_user_id IS OLD.approved_user_id AND NEW.approved_role IS OLD.approved_role
        AND NEW.subscription_id IS OLD.subscription_id AND NEW.entitlement_valid_until IS OLD.entitlement_valid_until AND NEW.approved_at IS OLD.approved_at AND NEW.expires_at>unixepoch()))
    OR NOT EXISTS(SELECT 1 FROM international_us_device_admissible a WHERE a.organization_id=NEW.organization_id AND a.user_id=NEW.approved_user_id AND a.role=NEW.approved_role AND a.subscription_id=NEW.subscription_id AND a.entitlement_valid_until>=NEW.entitlement_valid_until)
    THEN RAISE(ABORT,'us_device_admission_required') END;
  SELECT CASE WHEN NEW.status='consumed' AND NOT EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=NEW.consumed_session_id AND s.device_code_hash=NEW.device_code_hash AND s.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_device_consumption_required') END;
END;

--> statement-breakpoint
DROP TRIGGER international_us_device_v4_session_insert;
--> statement-breakpoint
CREATE TRIGGER international_us_device_v4_session_insert BEFORE INSERT ON international_us_device_v4_sessions
BEGIN
  SELECT CASE WHEN NEW.revoked_at IS NOT NULL OR NEW.created_at>unixepoch()
    OR EXISTS(SELECT 1 FROM international_us_device_v4_sessions WHERE session_id=NEW.session_id OR token_hash=NEW.token_hash OR device_code_hash=NEW.device_code_hash)
    OR EXISTS(SELECT 1 FROM international_us_device_sessions WHERE session_id=NEW.session_id OR token_hash=NEW.token_hash OR device_code_hash=NEW.device_code_hash)
    OR NOT EXISTS(SELECT 1 FROM international_us_device_v4_challenges c JOIN international_us_device_admissible a ON a.organization_id=c.organization_id AND a.user_id=c.approved_user_id
      WHERE c.device_code_hash=NEW.device_code_hash AND c.status='approved' AND c.expires_at>unixepoch() AND c.session_token_hash=NEW.token_hash AND c.installation_id=NEW.installation_id
        AND c.organization_id=NEW.organization_id AND c.approved_user_id=NEW.user_id AND c.approved_role=NEW.role AND c.subscription_id=NEW.subscription_id AND c.entitlement_valid_until=NEW.entitlement_valid_until
        AND a.role=NEW.role AND a.subscription_id=NEW.subscription_id AND a.entitlement_valid_until>=NEW.entitlement_valid_until AND c.supported_schema_version=NEW.supported_schema_version
        AND NEW.created_at>=c.approved_at AND NEW.expires_at>unixepoch() AND NEW.expires_at=min(NEW.created_at+2592000,c.entitlement_valid_until))
    THEN RAISE(ABORT,'us_device_admission_required') END;
END;
