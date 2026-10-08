-- Additive US browser admission only. No catalogue, payment or trial is invented.
-- The server-only sink must first verify the actual provider proof and catalogue.
-- This SQL binds that trusted evidence; it does not verify a provider signature.
-- No legacy organization/subscription/member/device is created or converted.
CREATE UNIQUE INDEX international_intent_ready_subscription_identity
  ON international_workspace_creation_intents(creation_id,organization_id,own_subscription_id);
--> statement-breakpoint
CREATE TABLE international_saas_authorities (
  organization_id TEXT PRIMARY KEY NOT NULL,
  creation_id TEXT NOT NULL UNIQUE REFERENCES international_workspace_creation_intents(creation_id),
  owner_user_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL CHECK(environment IN ('TEST','PRODUCTION')),
  catalog_version TEXT NOT NULL,
  country TEXT NOT NULL CHECK(country='US'),
  currency TEXT NOT NULL CHECK(currency='USD'),
  offer_json TEXT NOT NULL CHECK(json_valid(offer_json) AND json_type(offer_json)='object' AND length(CAST(offer_json AS BLOB))<=16384),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json) AND json_type(authority_json)='object' AND length(CAST(authority_json AS BLOB))<=32768),
  seat_limit INTEGER NOT NULL CHECK(typeof(seat_limit)='integer' AND seat_limit BETWEEN 1 AND 1000),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 1 AND 253402300799),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at BETWEEN updated_at AND 253402300799)),
  CHECK(length(organization_id)=36 AND organization_id GLOB '????????-????-????-????-????????????' AND length(replace(organization_id,'-',''))=32 AND replace(organization_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(organization_id,15,1) GLOB '[1-8]' AND substr(organization_id,20,1) GLOB '[89ab]'),
  CHECK(length(creation_id)=36 AND creation_id GLOB '????????-????-????-????-????????????' AND length(replace(creation_id,'-',''))=32 AND replace(creation_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(creation_id,15,1) GLOB '[1-8]' AND substr(creation_id,20,1) GLOB '[89ab]'),
  CHECK(length(owner_user_id)=36 AND owner_user_id GLOB '????????-????-????-????-????????????' AND length(replace(owner_user_id,'-',''))=32 AND replace(owner_user_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(owner_user_id,15,1) GLOB '[1-8]' AND substr(owner_user_id,20,1) GLOB '[89ab]'),
  CHECK(length(subscription_id) BETWEEN 1 AND 128 AND substr(subscription_id,1,1) GLOB '[A-Za-z0-9]' AND subscription_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  CHECK(length(catalog_version) BETWEEN 1 AND 128 AND substr(catalog_version,1,1) GLOB '[A-Za-z0-9]' AND catalog_version NOT GLOB '*[^A-Za-z0-9._:-]*'),
  CHECK(COALESCE(
    json_type(offer_json,'$.kind')='text' AND json_extract(offer_json,'$.kind')='saas_subscription'
    AND json_type(offer_json,'$.catalogVersion')='text' AND json_extract(offer_json,'$.catalogVersion')=catalog_version
    AND json_type(offer_json,'$.country')='text' AND json_extract(offer_json,'$.country')=country
    AND json_type(offer_json,'$.currency')='text' AND json_extract(offer_json,'$.currency')=currency
    AND json_type(offer_json,'$.environment')='text' AND json_extract(offer_json,'$.environment')=environment
    AND json_type(offer_json,'$.module')='text' AND json_extract(offer_json,'$.module') IN ('gestion','complet')
    AND json_type(offer_json,'$.plan')='text' AND length(json_extract(offer_json,'$.plan')) BETWEEN 1 AND 128
    AND substr(json_extract(offer_json,'$.plan'),1,1) GLOB '[A-Za-z0-9]' AND json_extract(offer_json,'$.plan') NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND json_type(offer_json,'$.priceId')='text' AND json_extract(offer_json,'$.priceId') GLOB 'price_*'
    AND length(json_extract(offer_json,'$.priceId')) BETWEEN 7 AND 128 AND json_extract(offer_json,'$.priceId') NOT GLOB '*[^A-Za-z0-9_]*'
    AND json_type(offer_json,'$.productId')='text' AND json_extract(offer_json,'$.productId') GLOB 'prod_*'
    AND length(json_extract(offer_json,'$.productId')) BETWEEN 6 AND 128 AND json_extract(offer_json,'$.productId') NOT GLOB '*[^A-Za-z0-9_]*'
    AND json_type(offer_json,'$.unitAmountMinor')='text' AND length(json_extract(offer_json,'$.unitAmountMinor')) BETWEEN 1 AND 16
    AND substr(json_extract(offer_json,'$.unitAmountMinor'),1,1) GLOB '[1-9]' AND json_extract(offer_json,'$.unitAmountMinor') NOT GLOB '*[^0-9]*'
    AND CAST(json_extract(offer_json,'$.unitAmountMinor') AS INTEGER)<=9007199254740991
    AND json_type(offer_json,'$.interval')='text' AND json_extract(offer_json,'$.interval') IN ('month','year')
    AND json_type(offer_json,'$.intervalCount')='integer' AND json_extract(offer_json,'$.intervalCount') BETWEEN 1 AND 9007199254740991
    AND json_type(offer_json,'$.taxBehavior')='text' AND json_extract(offer_json,'$.taxBehavior') IN ('inclusive','exclusive'),0)),
  CHECK(COALESCE(
    json_type(authority_json,'$.kind')='text' AND json_extract(authority_json,'$.kind')='saas_subscription_authority'
    AND json_type(authority_json,'$.organizationId')='text' AND json_extract(authority_json,'$.organizationId')=organization_id
    AND json_type(authority_json,'$.subscriptionId')='text' AND json_extract(authority_json,'$.subscriptionId')=subscription_id
    AND json_type(authority_json,'$.offer')='object' AND json_type(authority_json,'$.evidence')='object'
    AND json_type(authority_json,'$.status')='text'
    AND json_extract(authority_json,'$.evidence.kind')='verified_payment' AND json_extract(authority_json,'$.status') IN ('active','past_due','canceled')
    AND json_type(authority_json,'$.evidence.kind')='text'
    AND json_type(authority_json,'$.evidence.referenceId')='text' AND length(json_extract(authority_json,'$.evidence.referenceId')) BETWEEN 1 AND 128
    AND substr(json_extract(authority_json,'$.evidence.referenceId'),1,1) GLOB '[A-Za-z0-9]' AND json_extract(authority_json,'$.evidence.referenceId') NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND json_type(authority_json,'$.evidence.organizationId')='text' AND json_extract(authority_json,'$.evidence.organizationId')=organization_id
    AND json_type(authority_json,'$.evidence.subscriptionId')='text' AND json_extract(authority_json,'$.evidence.subscriptionId')=subscription_id
    AND json_type(authority_json,'$.evidence.environment')='text' AND json_extract(authority_json,'$.evidence.environment')=environment
    AND json_type(authority_json,'$.evidence.catalogVersion')='text' AND json_extract(authority_json,'$.evidence.catalogVersion')=catalog_version
    AND json_type(authority_json,'$.evidence.priceId')='text' AND json_extract(authority_json,'$.evidence.priceId')=json_extract(offer_json,'$.priceId')
    AND json_type(authority_json,'$.evidence.currency')='text' AND json_extract(authority_json,'$.evidence.currency')=currency
    AND json_type(authority_json,'$.evidence.startsAt')='integer' AND json_extract(authority_json,'$.evidence.startsAt') BETWEEN 0 AND 9007199254740991
    AND json_type(authority_json,'$.evidence.endsAt')='integer' AND json_extract(authority_json,'$.evidence.endsAt') BETWEEN 1 AND 9007199254740991
    AND json_extract(authority_json,'$.evidence.startsAt')<=updated_at AND json_extract(authority_json,'$.evidence.endsAt')>updated_at
    AND json_type(authority_json,'$.evidence.revoked')='false',0)),
  -- All three admission writes must commit together, not just authority+owner.
  FOREIGN KEY(creation_id,organization_id,subscription_id)
    REFERENCES international_workspace_creation_intents(creation_id,organization_id,own_subscription_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(organization_id,owner_user_id)
    REFERENCES international_workspace_members(organization_id,user_id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE international_workspace_members (
  membership_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES international_saas_authorities(organization_id) DEFERRABLE INITIALLY DEFERRED,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','accountant','member','read_only')),
  display_name TEXT CHECK(display_name IS NULL OR (typeof(display_name)='text' AND length(display_name)<=160)),
  joined_at INTEGER NOT NULL CHECK(typeof(joined_at)='integer' AND joined_at BETWEEN 1 AND 253402300799),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at BETWEEN joined_at AND 253402300799)),
  CHECK(length(membership_id) BETWEEN 1 AND 128 AND substr(membership_id,1,1) GLOB '[A-Za-z0-9]' AND membership_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  CHECK(length(user_id)=36 AND user_id GLOB '????????-????-????-????-????????????' AND length(replace(user_id,'-',''))=32 AND replace(user_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(user_id,15,1) GLOB '[1-8]' AND substr(user_id,20,1) GLOB '[89ab]'),
  UNIQUE(organization_id,user_id)
);
--> statement-breakpoint
CREATE INDEX international_workspace_members_user ON international_workspace_members(user_id,revoked_at,organization_id);
--> statement-breakpoint
CREATE TRIGGER international_saas_authority_admission BEFORE INSERT ON international_saas_authorities
BEGIN
  -- INSERT OR REPLACE must not delete history when recursive_triggers is OFF.
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_saas_authorities WHERE organization_id=NEW.organization_id OR creation_id=NEW.creation_id OR subscription_id=NEW.subscription_id)
    THEN RAISE(ABORT,'international_saas_authority_exists') END;
  SELECT CASE WHEN NEW.revoked_at IS NOT NULL OR NEW.updated_at>unixepoch() OR NEW.revision<>1
    OR EXISTS(SELECT 1 FROM organizations WHERE organization_id=NEW.organization_id OR subscription_id=NEW.subscription_id)
    OR EXISTS(SELECT 1 FROM subscriptions WHERE subscription_id=NEW.subscription_id)
    OR NOT EXISTS(SELECT 1 FROM international_workspace_creation_intents i
      WHERE i.creation_id=NEW.creation_id AND i.organization_id=NEW.organization_id AND i.actor_user_id=NEW.owner_user_id
        AND i.country_code='US' AND i.state='postgres_confirmed' AND i.own_subscription_id IS NULL
        AND COALESCE(json_type(i.pg_receipt_json)='object'
          AND json_type(i.pg_receipt_json,'$.creationId')='text' AND json_extract(i.pg_receipt_json,'$.creationId')=i.creation_id
          AND json_type(i.pg_receipt_json,'$.organizationId')='text' AND json_extract(i.pg_receipt_json,'$.organizationId')=i.organization_id
          AND json_type(i.pg_receipt_json,'$.actorUserId')='text' AND json_extract(i.pg_receipt_json,'$.actorUserId')=i.actor_user_id
          AND json_type(i.pg_receipt_json,'$.requestId')='text' AND json_extract(i.pg_receipt_json,'$.requestId')=i.request_id
          AND json_type(i.pg_receipt_json,'$.configurationFingerprint')='text' AND json_extract(i.pg_receipt_json,'$.configurationFingerprint')=i.configuration_fingerprint
          AND json_type(i.pg_receipt_json,'$.updatedBy')='text' AND json_extract(i.pg_receipt_json,'$.updatedBy')=i.actor_user_id
          AND json_type(i.pg_receipt_json,'$.revision')='integer' AND json_extract(i.pg_receipt_json,'$.revision')=1
          AND json_type(i.pg_receipt_json,'$.replayed') IN ('true','false') AND json_type(i.pg_receipt_json,'$.updatedAt')='text' AND julianday(json_extract(i.pg_receipt_json,'$.updatedAt')) IS NOT NULL
          AND json_type(i.pg_receipt_json,'$.configuration')='object',0)
        AND NOT EXISTS(SELECT fullkey,type,atom FROM json_tree(json_extract(i.pg_receipt_json,'$.configuration')) EXCEPT SELECT fullkey,type,atom FROM json_tree(i.configuration_json))
        AND NOT EXISTS(SELECT fullkey,type,atom FROM json_tree(i.configuration_json) EXCEPT SELECT fullkey,type,atom FROM json_tree(json_extract(i.pg_receipt_json,'$.configuration')))
        AND (SELECT count(*) FROM json_each(i.pg_receipt_json))=10
        AND NOT EXISTS(SELECT 1 FROM json_each(i.pg_receipt_json) WHERE key NOT IN ('creationId','organizationId','actorUserId','requestId','configurationFingerprint','configuration','revision','updatedBy','updatedAt','replayed'))
        AND NOT EXISTS(SELECT 1 FROM json_tree(i.pg_receipt_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1))
    THEN RAISE(ABORT,'international_saas_authority_scope') END;
  SELECT CASE WHEN (SELECT count(*) FROM json_each(NEW.offer_json))<>13
    OR EXISTS(SELECT 1 FROM json_each(NEW.offer_json) WHERE key NOT IN ('kind','catalogVersion','country','currency','module','plan','priceId','productId','environment','unitAmountMinor','interval','intervalCount','taxBehavior'))
    OR (SELECT count(*) FROM json_each(NEW.authority_json))<>6
    OR EXISTS(SELECT 1 FROM json_each(NEW.authority_json) WHERE key NOT IN ('kind','organizationId','subscriptionId','offer','status','evidence'))
    OR (SELECT count(*) FROM json_each(NEW.authority_json,'$.evidence'))<>11
    OR EXISTS(SELECT 1 FROM json_each(NEW.authority_json,'$.evidence') WHERE key NOT IN ('kind','referenceId','organizationId','subscriptionId','environment','catalogVersion','priceId','currency','startsAt','endsAt','revoked'))
    OR EXISTS(SELECT 1 FROM json_tree(NEW.offer_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM json_tree(NEW.authority_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
    OR EXISTS(SELECT fullkey,type,atom FROM json_tree(json_extract(NEW.authority_json,'$.offer')) EXCEPT SELECT fullkey,type,atom FROM json_tree(NEW.offer_json))
    OR EXISTS(SELECT fullkey,type,atom FROM json_tree(NEW.offer_json) EXCEPT SELECT fullkey,type,atom FROM json_tree(json_extract(NEW.authority_json,'$.offer')))
    THEN RAISE(ABORT,'international_saas_authority_json') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_saas_authority_immutable BEFORE UPDATE ON international_saas_authorities
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.creation_id IS NOT OLD.creation_id OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.subscription_id IS NOT OLD.subscription_id OR NEW.environment IS NOT OLD.environment OR NEW.catalog_version IS NOT OLD.catalog_version
  OR NEW.country IS NOT OLD.country OR NEW.currency IS NOT OLD.currency OR NEW.offer_json IS NOT OLD.offer_json OR NEW.authority_json IS NOT OLD.authority_json
  OR NEW.seat_limit IS NOT OLD.seat_limit OR NEW.revision IS NOT OLD.revision OR NEW.updated_at IS NOT OLD.updated_at
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
  OR (NEW.revoked_at IS NOT NULL AND NEW.revoked_at>unixepoch())
BEGIN SELECT RAISE(ABORT,'international_saas_authority_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_saas_authority_no_delete BEFORE DELETE ON international_saas_authorities
BEGIN SELECT RAISE(ABORT,'international_saas_authority_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_member_admission BEFORE INSERT ON international_workspace_members
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_workspace_members WHERE membership_id=NEW.membership_id OR (organization_id=NEW.organization_id AND user_id=NEW.user_id))
    THEN RAISE(ABORT,'international_us_membership_exists') END;
  SELECT CASE WHEN NEW.revoked_at IS NOT NULL OR NEW.joined_at>unixepoch()
    OR EXISTS(SELECT 1 FROM organizations WHERE organization_id=NEW.organization_id)
    OR NOT EXISTS(SELECT 1 FROM international_saas_authorities a JOIN international_workspace_creation_intents i ON i.creation_id=a.creation_id AND i.organization_id=a.organization_id
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
CREATE TRIGGER international_us_member_immutable BEFORE UPDATE ON international_workspace_members
WHEN NEW.membership_id IS NOT OLD.membership_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.role IS NOT OLD.role OR NEW.joined_at IS NOT OLD.joined_at
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
  OR (NEW.revoked_at IS NOT NULL AND NEW.revoked_at>unixepoch())
BEGIN SELECT RAISE(ABORT,'international_us_membership_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_member_no_delete BEFORE DELETE ON international_workspace_members
BEGIN SELECT RAISE(ABORT,'international_us_membership_immutable'); END;
--> statement-breakpoint
DROP TRIGGER international_intent_ready_unavailable;
--> statement-breakpoint
CREATE TRIGGER international_intent_ready_admission BEFORE UPDATE ON international_workspace_creation_intents
WHEN NEW.state='ready'
BEGIN
  SELECT CASE WHEN OLD.state<>'postgres_confirmed' OR NEW.own_subscription_id IS NULL
    OR EXISTS(SELECT 1 FROM organizations WHERE organization_id=NEW.organization_id OR subscription_id=NEW.own_subscription_id)
    OR EXISTS(SELECT 1 FROM subscriptions WHERE subscription_id=NEW.own_subscription_id)
    OR NOT EXISTS(SELECT 1 FROM international_saas_authorities a JOIN international_workspace_members m
      ON m.organization_id=a.organization_id AND m.user_id=a.owner_user_id
      WHERE a.creation_id=NEW.creation_id AND a.organization_id=NEW.organization_id AND a.owner_user_id=NEW.actor_user_id
        AND a.subscription_id=NEW.own_subscription_id AND a.country='US' AND a.currency='USD'
        AND a.revoked_at IS NULL AND m.role='owner' AND m.revoked_at IS NULL
        AND json_extract(a.authority_json,'$.evidence.startsAt')<=unixepoch() AND json_extract(a.authority_json,'$.evidence.endsAt')>unixepoch()
        AND (SELECT count(*) FROM international_workspace_members active WHERE active.organization_id=a.organization_id AND active.revoked_at IS NULL)<=a.seat_limit)
    THEN RAISE(ABORT,'international_us_ready_not_admitted') END;
END;
--> statement-breakpoint
-- Close reverse collisions as well as rejecting legacy rows at US admission.
CREATE TRIGGER international_us_no_legacy_organization_insert BEFORE INSERT ON organizations
WHEN EXISTS(SELECT 1 FROM international_saas_authorities WHERE organization_id=NEW.organization_id OR subscription_id=NEW.subscription_id)
BEGIN SELECT RAISE(ABORT,'international_us_legacy_identity_conflict'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_no_legacy_organization_update BEFORE UPDATE ON organizations
WHEN EXISTS(SELECT 1 FROM international_saas_authorities WHERE organization_id IN (OLD.organization_id,NEW.organization_id) OR subscription_id IN (OLD.subscription_id,NEW.subscription_id))
BEGIN SELECT RAISE(ABORT,'international_us_legacy_identity_conflict'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_no_legacy_subscription_insert BEFORE INSERT ON subscriptions
WHEN EXISTS(SELECT 1 FROM international_saas_authorities WHERE subscription_id=NEW.subscription_id)
BEGIN SELECT RAISE(ABORT,'international_us_legacy_identity_conflict'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_no_legacy_subscription_update BEFORE UPDATE ON subscriptions
WHEN EXISTS(SELECT 1 FROM international_saas_authorities WHERE subscription_id IN (OLD.subscription_id,NEW.subscription_id))
BEGIN SELECT RAISE(ABORT,'international_us_legacy_identity_conflict'); END;
