-- Additive capability4 credential family. All historical1..3 rows/tables/FKs remain untouched.
-- Same US organization, membership and entitlement authority; capability is not a grant.
-- No copy, capability bump, credential replacement, provider or production activation.
CREATE TABLE international_us_device_v4_challenges (
  device_code_hash TEXT PRIMARY KEY NOT NULL CHECK(length(device_code_hash)=43 AND device_code_hash NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(device_code_hash,43,1) GLOB '[AEIMQUYcgkosw048]'),
  user_code TEXT NOT NULL UNIQUE CHECK(length(user_code)=9 AND substr(user_code,5,1)='-' AND replace(user_code,'-','') NOT GLOB '*[^0-9ABCDEFGHJKMNPQRSTVWXYZ]*' AND length(replace(user_code,'-',''))=8),
  installation_id TEXT NOT NULL CHECK(length(installation_id)=36 AND installation_id GLOB '????????-????-4???-[89ab]???-????????????' AND length(replace(installation_id,'-',''))=32 AND replace(installation_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  session_token_hash TEXT NOT NULL UNIQUE CHECK(length(session_token_hash)=43 AND session_token_hash NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(session_token_hash,43,1) GLOB '[AEIMQUYcgkosw048]'),
  supported_schema_version INTEGER NOT NULL CHECK(typeof(supported_schema_version)='integer' AND supported_schema_version IN(4)),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 253402300799),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at=created_at+600 AND expires_at<=253402300799),
  status TEXT NOT NULL CHECK(status IN('pending','approved','consumed')),
  organization_id TEXT, approved_user_id TEXT, approved_role TEXT CHECK(approved_role IS NULL OR approved_role IN('owner','admin','accountant','member','read_only')),
  subscription_id TEXT, entitlement_valid_until INTEGER, approved_at INTEGER,
  consumed_session_id TEXT UNIQUE REFERENCES international_us_device_v4_sessions(session_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((status='pending' AND organization_id IS NULL AND approved_user_id IS NULL AND approved_role IS NULL AND subscription_id IS NULL AND entitlement_valid_until IS NULL AND approved_at IS NULL AND consumed_session_id IS NULL)
    OR (status IN('approved','consumed') AND organization_id IS NOT NULL AND approved_user_id IS NOT NULL AND approved_role IS NOT NULL AND subscription_id IS NOT NULL
      AND typeof(entitlement_valid_until)='integer' AND entitlement_valid_until>approved_at AND entitlement_valid_until<=253402300799
      AND typeof(approved_at)='integer' AND approved_at>=created_at AND approved_at<expires_at AND ((status='approved' AND consumed_session_id IS NULL) OR (status='consumed' AND consumed_session_id IS NOT NULL)))),
  UNIQUE(device_code_hash,consumed_session_id)
);
--> statement-breakpoint
CREATE TABLE international_us_device_v4_sessions (
  session_id TEXT PRIMARY KEY NOT NULL CHECK(length(session_id)=40 AND session_id GLOB 'usd_????????-????-4???-[89ab]???-????????????' AND length(replace(substr(session_id,5),'-',''))=32 AND replace(substr(session_id,5),'-','') NOT GLOB '*[^0-9a-f]*'),
  device_code_hash TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  installation_id TEXT NOT NULL,
  organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, subscription_id TEXT NOT NULL,
  supported_schema_version INTEGER NOT NULL CHECK(typeof(supported_schema_version)='integer' AND supported_schema_version IN(4)),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 253402300799),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>created_at AND expires_at<=created_at+2592000),
  entitlement_valid_until INTEGER NOT NULL CHECK(typeof(entitlement_valid_until)='integer' AND expires_at<=entitlement_valid_until AND entitlement_valid_until<=253402300799),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at BETWEEN created_at AND 253402300799)),
  FOREIGN KEY(device_code_hash,session_id) REFERENCES international_us_device_v4_challenges(device_code_hash,consumed_session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(organization_id,user_id) REFERENCES international_workspace_members(organization_id,user_id)
);
--> statement-breakpoint
CREATE INDEX international_us_device_v4_sessions_member ON international_us_device_v4_sessions(organization_id,user_id,revoked_at);
--> statement-breakpoint
CREATE TRIGGER international_us_device_v4_challenge_insert BEFORE INSERT ON international_us_device_v4_challenges
BEGIN
  SELECT CASE WHEN NEW.status<>'pending' OR NEW.created_at>unixepoch() OR NEW.expires_at<=unixepoch()
    OR EXISTS(SELECT 1 FROM international_us_device_v4_challenges WHERE device_code_hash=NEW.device_code_hash OR user_code=NEW.user_code OR session_token_hash=NEW.session_token_hash)
    OR EXISTS(SELECT 1 FROM international_us_device_challenges WHERE device_code_hash=NEW.device_code_hash OR user_code=NEW.user_code OR session_token_hash=NEW.session_token_hash)
    THEN RAISE(ABORT,'us_device_invalid_challenge') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_device_v4_challenge_update BEFORE UPDATE ON international_us_device_v4_challenges
BEGIN
  SELECT CASE WHEN NEW.device_code_hash IS NOT OLD.device_code_hash OR NEW.user_code IS NOT OLD.user_code OR NEW.installation_id IS NOT OLD.installation_id OR NEW.session_token_hash IS NOT OLD.session_token_hash
    OR NEW.supported_schema_version IS NOT OLD.supported_schema_version OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR NOT ((OLD.status='pending' AND NEW.status='approved' AND NEW.consumed_session_id IS NULL AND NEW.approved_at<=unixepoch() AND NEW.expires_at>unixepoch())
      OR (OLD.status='approved' AND NEW.status='consumed' AND NEW.organization_id IS OLD.organization_id AND NEW.approved_user_id IS OLD.approved_user_id AND NEW.approved_role IS OLD.approved_role
        AND NEW.subscription_id IS OLD.subscription_id AND NEW.entitlement_valid_until IS OLD.entitlement_valid_until AND NEW.approved_at IS OLD.approved_at AND NEW.expires_at>unixepoch()))
    OR NOT EXISTS(SELECT 1 FROM international_us_device_admissible a WHERE a.organization_id=NEW.organization_id AND a.user_id=NEW.approved_user_id AND a.role=NEW.approved_role AND a.subscription_id=NEW.subscription_id AND a.entitlement_valid_until=NEW.entitlement_valid_until)
    THEN RAISE(ABORT,'us_device_admission_required') END;
  SELECT CASE WHEN NEW.status='consumed' AND NOT EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=NEW.consumed_session_id AND s.device_code_hash=NEW.device_code_hash AND s.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_device_consumption_required') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_device_v4_session_insert BEFORE INSERT ON international_us_device_v4_sessions
BEGIN
  SELECT CASE WHEN NEW.revoked_at IS NOT NULL OR NEW.created_at>unixepoch()
    OR EXISTS(SELECT 1 FROM international_us_device_v4_sessions WHERE session_id=NEW.session_id OR token_hash=NEW.token_hash OR device_code_hash=NEW.device_code_hash)
    OR EXISTS(SELECT 1 FROM international_us_device_sessions WHERE session_id=NEW.session_id OR token_hash=NEW.token_hash OR device_code_hash=NEW.device_code_hash)
    OR NOT EXISTS(SELECT 1 FROM international_us_device_v4_challenges c JOIN international_us_device_admissible a ON a.organization_id=c.organization_id AND a.user_id=c.approved_user_id
      WHERE c.device_code_hash=NEW.device_code_hash AND c.status='approved' AND c.expires_at>unixepoch() AND c.session_token_hash=NEW.token_hash AND c.installation_id=NEW.installation_id
        AND c.organization_id=NEW.organization_id AND c.approved_user_id=NEW.user_id AND c.approved_role=NEW.role AND c.subscription_id=NEW.subscription_id AND c.entitlement_valid_until=NEW.entitlement_valid_until
        AND a.role=NEW.role AND a.subscription_id=NEW.subscription_id AND a.entitlement_valid_until=NEW.entitlement_valid_until AND c.supported_schema_version=NEW.supported_schema_version
        AND NEW.created_at>=c.approved_at AND NEW.expires_at>unixepoch() AND NEW.expires_at=min(NEW.created_at+2592000,c.entitlement_valid_until))
    THEN RAISE(ABORT,'us_device_admission_required') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_device_v4_session_update BEFORE UPDATE ON international_us_device_v4_sessions
WHEN NEW.session_id IS NOT OLD.session_id OR NEW.device_code_hash IS NOT OLD.device_code_hash OR NEW.token_hash IS NOT OLD.token_hash OR NEW.installation_id IS NOT OLD.installation_id OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.user_id IS NOT OLD.user_id OR NEW.role IS NOT OLD.role OR NEW.subscription_id IS NOT OLD.subscription_id OR NEW.supported_schema_version IS NOT OLD.supported_schema_version
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.entitlement_valid_until IS NOT OLD.entitlement_valid_until
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at) OR (NEW.revoked_at IS NOT NULL AND NEW.revoked_at>unixepoch())
BEGIN SELECT RAISE(ABORT,'us_device_session_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_device_v4_challenge_no_delete BEFORE DELETE ON international_us_device_v4_challenges BEGIN SELECT RAISE(ABORT,'us_device_challenge_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_device_v4_session_no_delete BEFORE DELETE ON international_us_device_v4_sessions BEGIN SELECT RAISE(ABORT,'us_device_session_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_device_legacy_challenge_v4_collision BEFORE INSERT ON international_us_device_challenges
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_device_v4_challenges WHERE device_code_hash=NEW.device_code_hash OR user_code=NEW.user_code OR session_token_hash=NEW.session_token_hash)
    THEN RAISE(ABORT,'us_device_cross_family_collision') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_device_legacy_session_v4_collision BEFORE INSERT ON international_us_device_sessions
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_device_v4_sessions WHERE session_id=NEW.session_id OR token_hash=NEW.token_hash OR device_code_hash=NEW.device_code_hash)
    THEN RAISE(ABORT,'us_device_cross_family_collision') END;
END;
