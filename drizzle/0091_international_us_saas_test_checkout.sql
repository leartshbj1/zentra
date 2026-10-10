-- Migration number: 0091 	 2026-10-09T23:48:03.623Z
-- Dedicated initial US/USD TEST activation. No legacy purchase, organization,
-- subscription or authority is adopted, replaced or backfilled. These guards
-- bind trusted gateway attestations; SQL does not verify Stripe signatures.
CREATE TABLE international_us_saas_test_purchases (
  purchase_id TEXT PRIMARY KEY NOT NULL,
  creation_id TEXT NOT NULL UNIQUE REFERENCES international_workspace_creation_intents(creation_id),
  organization_id TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  configuration_fingerprint TEXT NOT NULL CHECK(length(configuration_fingerprint)=64 AND configuration_fingerprint NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object' AND length(CAST(receipt_json AS BLOB))<=32768),
  offer_json TEXT NOT NULL CHECK(json_valid(offer_json) AND json_type(offer_json)='object' AND length(CAST(offer_json AS BLOB))<=16384),
  seat_limit INTEGER NOT NULL CHECK(typeof(seat_limit)='integer' AND seat_limit BETWEEN 1 AND 1000),
  provider_account_id TEXT NOT NULL CHECK(length(provider_account_id) BETWEEN 6 AND 128 AND substr(provider_account_id,1,5)='acct_' AND substr(provider_account_id,6) NOT GLOB '*[^A-Za-z0-9]*'),
  site_origin TEXT NOT NULL CHECK(length(site_origin) BETWEEN 8 AND 2048 AND (site_origin GLOB 'https://?*' OR site_origin='http://localhost' OR site_origin GLOB 'http://localhost:[0-9]*' OR site_origin='http://127.0.0.1' OR site_origin GLOB 'http://127.0.0.1:[0-9]*') AND site_origin NOT GLOB '*[?#@]*' AND instr(substr(site_origin,instr(site_origin,'://')+3),'/')=0),
  integration_identifier TEXT NOT NULL CHECK(length(integration_identifier)=23 AND substr(integration_identifier,1,15)='zentra_us_test_' AND substr(integration_identifier,16) NOT GLOB '*[^a-z]*'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402297199),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at=created_at+3600),
  UNIQUE(actor_user_id,request_id),
  CHECK(length(purchase_id)=36 AND purchase_id GLOB '????????-????-????-????-????????????' AND length(replace(purchase_id,'-',''))=32 AND replace(purchase_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(purchase_id,15,1) GLOB '[1-8]' AND substr(purchase_id,20,1) GLOB '[89ab]'),
  CHECK(length(creation_id)=36 AND creation_id GLOB '????????-????-????-????-????????????' AND length(replace(creation_id,'-',''))=32 AND replace(creation_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(creation_id,15,1) GLOB '[1-8]' AND substr(creation_id,20,1) GLOB '[89ab]'),
  CHECK(length(organization_id)=36 AND organization_id GLOB '????????-????-????-????-????????????' AND length(replace(organization_id,'-',''))=32 AND replace(organization_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(organization_id,15,1) GLOB '[1-8]' AND substr(organization_id,20,1) GLOB '[89ab]'),
  CHECK(length(actor_user_id)=36 AND actor_user_id GLOB '????????-????-????-????-????????????' AND length(replace(actor_user_id,'-',''))=32 AND replace(actor_user_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(actor_user_id,15,1) GLOB '[1-8]' AND substr(actor_user_id,20,1) GLOB '[89ab]'),
  CHECK(length(request_id)=36 AND request_id GLOB '????????-????-????-????-????????????' AND length(replace(request_id,'-',''))=32 AND replace(request_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(request_id,15,1) GLOB '[1-8]' AND substr(request_id,20,1) GLOB '[89ab]'),
  CHECK(COALESCE(json_extract(offer_json,'$.kind')='saas_subscription' AND json_extract(offer_json,'$.country')='US' AND json_extract(offer_json,'$.currency')='USD' AND json_extract(offer_json,'$.environment')='TEST'
    AND json_type(offer_json,'$.catalogVersion')='text' AND length(json_extract(offer_json,'$.catalogVersion')) BETWEEN 1 AND 128 AND substr(json_extract(offer_json,'$.catalogVersion'),1,1) GLOB '[A-Za-z0-9]' AND json_extract(offer_json,'$.catalogVersion') NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND json_extract(offer_json,'$.module') IN ('gestion','complet') AND json_type(offer_json,'$.plan')='text' AND length(json_extract(offer_json,'$.plan')) BETWEEN 1 AND 128 AND substr(json_extract(offer_json,'$.plan'),1,1) GLOB '[A-Za-z0-9]' AND json_extract(offer_json,'$.plan') NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND json_type(offer_json,'$.priceId')='text' AND json_extract(offer_json,'$.priceId') GLOB 'price_?*' AND json_extract(offer_json,'$.priceId') NOT GLOB '*[^A-Za-z0-9_]*' AND length(json_extract(offer_json,'$.priceId'))<=128
    AND json_type(offer_json,'$.productId')='text' AND json_extract(offer_json,'$.productId') GLOB 'prod_?*' AND json_extract(offer_json,'$.productId') NOT GLOB '*[^A-Za-z0-9_]*' AND length(json_extract(offer_json,'$.productId'))<=128
    AND json_type(offer_json,'$.unitAmountMinor')='text' AND length(json_extract(offer_json,'$.unitAmountMinor')) BETWEEN 1 AND 16 AND substr(json_extract(offer_json,'$.unitAmountMinor'),1,1) GLOB '[1-9]' AND json_extract(offer_json,'$.unitAmountMinor') NOT GLOB '*[^0-9]*' AND CAST(json_extract(offer_json,'$.unitAmountMinor') AS INTEGER)<=9007199254740991
    AND json_extract(offer_json,'$.interval') IN ('month','year') AND json_type(offer_json,'$.intervalCount')='integer' AND json_extract(offer_json,'$.intervalCount') BETWEEN 1 AND 9007199254740991 AND json_extract(offer_json,'$.taxBehavior') IN ('inclusive','exclusive'),0))
);
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_purchase_admission BEFORE INSERT ON international_us_saas_test_purchases
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_saas_test_purchases WHERE purchase_id=NEW.purchase_id OR creation_id=NEW.creation_id OR organization_id=NEW.organization_id OR (actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id)) THEN RAISE(ABORT,'international_us_test_purchase_exists') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.expires_at<=unixepoch()
    OR EXISTS(SELECT 1 FROM organizations WHERE organization_id=NEW.organization_id)
    OR EXISTS(SELECT 1 FROM international_saas_authorities WHERE organization_id=NEW.organization_id OR creation_id=NEW.creation_id)
    OR NOT EXISTS(SELECT 1 FROM international_workspace_creation_intents i WHERE i.creation_id=NEW.creation_id AND i.organization_id=NEW.organization_id AND i.actor_user_id=NEW.actor_user_id AND i.request_id=NEW.request_id AND i.configuration_fingerprint=NEW.configuration_fingerprint AND i.country_code='US' AND i.state='postgres_confirmed' AND i.own_subscription_id IS NULL AND i.pg_receipt_json=NEW.receipt_json)
    THEN RAISE(ABORT,'international_us_test_purchase_scope') END;
  SELECT CASE WHEN (SELECT count(*) FROM json_each(NEW.offer_json))<>13 OR EXISTS(SELECT 1 FROM json_each(NEW.offer_json) WHERE key NOT IN ('kind','catalogVersion','country','currency','module','plan','priceId','productId','environment','unitAmountMinor','interval','intervalCount','taxBehavior'))
    OR EXISTS(SELECT 1 FROM json_tree(NEW.offer_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM json_tree(NEW.receipt_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
    THEN RAISE(ABORT,'international_us_test_purchase_json') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_purchase_immutable BEFORE UPDATE ON international_us_saas_test_purchases
BEGIN SELECT RAISE(ABORT,'international_us_test_purchase_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_purchase_no_delete BEFORE DELETE ON international_us_saas_test_purchases
BEGIN SELECT RAISE(ABORT,'international_us_test_purchase_immutable'); END;
--> statement-breakpoint
CREATE TABLE international_us_saas_test_sessions (
  purchase_id TEXT PRIMARY KEY NOT NULL REFERENCES international_us_saas_test_purchases(purchase_id),
  session_id TEXT NOT NULL UNIQUE CHECK(length(session_id) BETWEEN 9 AND 255 AND substr(session_id,1,8)='cs_test_' AND session_id NOT GLOB '*[^A-Za-z0-9_]*'),
  customer_id TEXT CHECK(customer_id IS NULL OR (length(customer_id) BETWEEN 5 AND 255 AND substr(customer_id,1,4)='cus_' AND customer_id NOT GLOB '*[^A-Za-z0-9_]*')),
  subscription_id TEXT CHECK(subscription_id IS NULL OR (length(subscription_id) BETWEEN 5 AND 128 AND substr(subscription_id,1,4)='sub_' AND subscription_id NOT GLOB '*[^A-Za-z0-9_]*')),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>created_at),
  UNIQUE(purchase_id,session_id)
);
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_session_admission BEFORE INSERT ON international_us_saas_test_sessions
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_saas_test_sessions WHERE purchase_id=NEW.purchase_id OR session_id=NEW.session_id) THEN RAISE(ABORT,'international_us_test_session_exists') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_saas_test_purchases p WHERE p.purchase_id=NEW.purchase_id AND NEW.created_at>=p.created_at AND NEW.created_at<p.expires_at AND NEW.expires_at=p.expires_at) THEN RAISE(ABORT,'international_us_test_session_scope') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_session_immutable BEFORE UPDATE ON international_us_saas_test_sessions
BEGIN SELECT RAISE(ABORT,'international_us_test_session_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_session_no_delete BEFORE DELETE ON international_us_saas_test_sessions
BEGIN SELECT RAISE(ABORT,'international_us_test_session_immutable'); END;
--> statement-breakpoint
CREATE UNIQUE INDEX international_us_saas_test_authority_scope ON international_saas_authorities(organization_id,creation_id,owner_user_id,subscription_id);
--> statement-breakpoint
CREATE TABLE international_us_saas_test_paid_proofs (
  purchase_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL UNIQUE,
  creation_id TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL,
  customer_id TEXT NOT NULL CHECK(length(customer_id) BETWEEN 5 AND 255 AND substr(customer_id,1,4)='cus_' AND customer_id NOT GLOB '*[^A-Za-z0-9_]*'),
  subscription_id TEXT NOT NULL UNIQUE CHECK(length(subscription_id) BETWEEN 5 AND 128 AND substr(subscription_id,1,4)='sub_' AND subscription_id NOT GLOB '*[^A-Za-z0-9_]*'),
  invoice_id TEXT NOT NULL UNIQUE CHECK(length(invoice_id) BETWEEN 4 AND 128 AND substr(invoice_id,1,3)='in_' AND invoice_id NOT GLOB '*[^A-Za-z0-9_]*'),
  event_id TEXT NOT NULL CHECK(event_id='recovery' OR (length(event_id) BETWEEN 5 AND 255 AND substr(event_id,1,4)='evt_' AND event_id NOT GLOB '*[^A-Za-z0-9_]*')),
  provider_account_id TEXT NOT NULL,
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json) AND json_type(authority_json)='object' AND length(CAST(authority_json AS BLOB))<=32768),
  seat_limit INTEGER NOT NULL CHECK(typeof(seat_limit)='integer' AND seat_limit BETWEEN 1 AND 1000),
  verified_at INTEGER NOT NULL CHECK(typeof(verified_at)='integer' AND verified_at BETWEEN 1 AND 253402300799),
  FOREIGN KEY(purchase_id,session_id) REFERENCES international_us_saas_test_sessions(purchase_id,session_id),
  -- A proof alone, proof+authority or zero-row finalization cannot commit.
  FOREIGN KEY(organization_id,creation_id,actor_user_id,subscription_id) REFERENCES international_saas_authorities(organization_id,creation_id,owner_user_id,subscription_id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_proof_admission BEFORE INSERT ON international_us_saas_test_paid_proofs
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_saas_test_paid_proofs WHERE purchase_id=NEW.purchase_id OR session_id=NEW.session_id OR organization_id=NEW.organization_id OR creation_id=NEW.creation_id OR subscription_id=NEW.subscription_id OR invoice_id=NEW.invoice_id) THEN RAISE(ABORT,'international_us_test_proof_exists') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM organizations WHERE organization_id=NEW.organization_id OR subscription_id=NEW.subscription_id) OR EXISTS(SELECT 1 FROM subscriptions WHERE subscription_id=NEW.subscription_id)
    OR NOT EXISTS(SELECT 1 FROM international_us_saas_test_purchases p JOIN international_us_saas_test_sessions s ON s.purchase_id=p.purchase_id JOIN international_workspace_creation_intents i ON i.creation_id=p.creation_id AND i.organization_id=p.organization_id
      WHERE p.purchase_id=NEW.purchase_id AND s.session_id=NEW.session_id AND p.organization_id=NEW.organization_id AND p.creation_id=NEW.creation_id AND p.actor_user_id=NEW.actor_user_id AND p.provider_account_id=NEW.provider_account_id AND p.seat_limit=NEW.seat_limit
        AND (s.customer_id IS NULL OR s.customer_id=NEW.customer_id) AND (s.subscription_id IS NULL OR s.subscription_id=NEW.subscription_id) AND NEW.verified_at>=s.created_at
        AND i.state='postgres_confirmed' AND i.own_subscription_id IS NULL AND i.pg_receipt_json=p.receipt_json AND i.configuration_fingerprint=p.configuration_fingerprint
        AND COALESCE(json_type(NEW.authority_json,'$.offer')='object' AND json_extract(NEW.authority_json,'$.offer')=json(p.offer_json)
          AND json_extract(NEW.authority_json,'$.organizationId')=p.organization_id AND json_extract(NEW.authority_json,'$.subscriptionId')=NEW.subscription_id
          AND json_extract(NEW.authority_json,'$.status')='active' AND json_extract(NEW.authority_json,'$.evidence.kind')='verified_payment'
          AND json_extract(NEW.authority_json,'$.evidence.referenceId')=NEW.invoice_id AND json_extract(NEW.authority_json,'$.evidence.startsAt')<=NEW.verified_at AND json_extract(NEW.authority_json,'$.evidence.endsAt')>NEW.verified_at,0))
    THEN RAISE(ABORT,'international_us_test_proof_scope') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_proof_immutable BEFORE UPDATE ON international_us_saas_test_paid_proofs
BEGIN SELECT RAISE(ABORT,'international_us_test_proof_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_saas_test_proof_no_delete BEFORE DELETE ON international_us_saas_test_paid_proofs
BEGIN SELECT RAISE(ABORT,'international_us_test_proof_immutable'); END;
--> statement-breakpoint
-- Conditional only for the newly persisted TEST purchase. Historical trusted
-- admissions/fixtures without one keep their existing 0087 semantics. Every new
-- public US TEST path must reserve a purchase before reaching this private sink.
CREATE TRIGGER international_us_saas_test_authority_requires_proof BEFORE INSERT ON international_saas_authorities
WHEN EXISTS(SELECT 1 FROM international_us_saas_test_purchases WHERE organization_id=NEW.organization_id OR creation_id=NEW.creation_id)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_saas_test_paid_proofs proof JOIN international_us_saas_test_purchases p ON p.purchase_id=proof.purchase_id JOIN international_us_saas_test_sessions s ON s.purchase_id=p.purchase_id AND s.session_id=proof.session_id
    WHERE proof.organization_id=NEW.organization_id AND proof.creation_id=NEW.creation_id AND proof.actor_user_id=NEW.owner_user_id AND proof.subscription_id=NEW.subscription_id
      AND NEW.environment='TEST' AND NEW.country='US' AND NEW.currency='USD' AND NEW.offer_json=p.offer_json AND NEW.authority_json=proof.authority_json AND NEW.seat_limit=proof.seat_limit)
    THEN RAISE(ABORT,'international_us_test_proof_required') END;
END;
