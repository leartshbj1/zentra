CREATE UNIQUE INDEX international_us_membership_org_identity ON international_workspace_members(organization_id,membership_id);
--> statement-breakpoint
CREATE TABLE international_us_team_heads (
 organization_id TEXT PRIMARY KEY NOT NULL REFERENCES international_saas_authorities(organization_id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740990), last_command_id TEXT,
 CHECK((revision=0 AND last_command_id IS NULL) OR (revision>0 AND last_command_id IS NOT NULL)),
 FOREIGN KEY(organization_id,revision,last_command_id) REFERENCES international_us_team_commands(organization_id,revision,command_id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE international_us_team_commands (
 command_id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES international_saas_authorities(organization_id), actor_user_id TEXT NOT NULL, request_id TEXT NOT NULL,
 expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740989),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision=expected_revision+1),
 action TEXT NOT NULL CHECK(action IN('create_invitation','regenerate_invitation','revoke_invitation','accept_invitation','revoke_member')), entity_id TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 command_json TEXT NOT NULL CHECK(json_valid(command_json) AND json_type(command_json)='object' AND length(CAST(command_json AS BLOB))<=8192),
 context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json)='object' AND length(CAST(context_json AS BLOB))<=8192),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object' AND length(CAST(receipt_json AS BLOB))<=2048),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
 UNIQUE(organization_id,actor_user_id,request_id), UNIQUE(organization_id,revision), UNIQUE(organization_id,revision,command_id), UNIQUE(organization_id,command_id),
 FOREIGN KEY(organization_id,command_id) REFERENCES international_us_team_audit(organization_id,command_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(length(command_id)=36 AND command_id GLOB '????????-????-4???-[89ab]???-????????????' AND replace(command_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(actor_user_id)=36 AND actor_user_id GLOB '????????-????-[1-8]???-[89ab]???-????????????' AND replace(actor_user_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_id)=36 AND request_id GLOB '????????-????-[1-8]???-[89ab]???-????????????' AND replace(request_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(entity_id)=36 AND entity_id GLOB '????????-????-[1-8]???-[89ab]???-????????????' AND replace(entity_id,'-','') NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE international_us_team_invitations (
 invitation_id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES international_saas_authorities(organization_id),
 email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 254 AND email=lower(trim(email)) AND instr(email,'@')>1 AND instr(email,' ')=0), role TEXT NOT NULL CHECK(role IN('admin','accountant','member','read_only')),
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'), created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253401695999), expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>created_at AND expires_at<=created_at+604800),
 status TEXT NOT NULL CHECK(status IN('pending','revoked','accepted')), revoked_at INTEGER, accepted_by TEXT, accepted_at INTEGER, membership_id TEXT,
 created_command_id TEXT NOT NULL, changed_command_id TEXT, UNIQUE(organization_id,invitation_id),
 FOREIGN KEY(organization_id,created_command_id) REFERENCES international_us_team_commands(organization_id,command_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(organization_id,changed_command_id) REFERENCES international_us_team_commands(organization_id,command_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(organization_id,membership_id) REFERENCES international_workspace_members(organization_id,membership_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(length(invitation_id)=36 AND invitation_id GLOB '????????-????-[1-8]???-[89ab]???-????????????' AND replace(invitation_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 CHECK((status='pending' AND revoked_at IS NULL AND accepted_by IS NULL AND accepted_at IS NULL AND membership_id IS NULL AND changed_command_id IS NULL)
 OR (status='revoked' AND typeof(revoked_at)='integer' AND revoked_at>=created_at AND accepted_by IS NULL AND accepted_at IS NULL AND membership_id IS NULL AND changed_command_id IS NOT NULL)
 OR (status='accepted' AND revoked_at IS NULL AND accepted_by IS NOT NULL AND typeof(accepted_at)='integer' AND accepted_at>=created_at AND accepted_at<expires_at AND membership_id IS NOT NULL AND changed_command_id IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX international_us_team_invitation_reservations ON international_us_team_invitations(organization_id,status,expires_at);
--> statement-breakpoint
CREATE TABLE international_us_team_profiles (
 organization_id TEXT NOT NULL, membership_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 254 AND email=lower(trim(email))),
 first_name TEXT NOT NULL CHECK(length(first_name) BETWEEN 1 AND 70), last_name TEXT NOT NULL CHECK(length(last_name) BETWEEN 1 AND 70), display_name TEXT NOT NULL CHECK(display_name=first_name||' '||last_name AND length(display_name)<=160),
 accepted_command_id TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
 PRIMARY KEY(organization_id,membership_id), UNIQUE(organization_id,user_id), UNIQUE(organization_id,email),
 FOREIGN KEY(organization_id,membership_id) REFERENCES international_workspace_members(organization_id,membership_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(organization_id,accepted_command_id) REFERENCES international_us_team_commands(organization_id,command_id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE international_us_team_audit (
 organization_id TEXT NOT NULL, command_id TEXT NOT NULL, revision INTEGER NOT NULL, actor_user_id TEXT NOT NULL, action TEXT NOT NULL, entity_id TEXT NOT NULL, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,command_id), FOREIGN KEY(organization_id,revision,command_id) REFERENCES international_us_team_commands(organization_id,revision,command_id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
-- Migration number: 0090 	 2026-10-08T22:45:16.677Z
-- Additive US team admission only. Generated by local Wrangler CLI.
CREATE TRIGGER international_us_team_head_insert BEFORE INSERT ON international_us_team_heads
WHEN EXISTS(SELECT 1 FROM international_us_team_heads WHERE organization_id=NEW.organization_id) OR NEW.revision<>0 OR NEW.last_command_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'us_team_invalid_record'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_head_update BEFORE UPDATE ON international_us_team_heads
BEGIN
 SELECT CASE WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.revision<>OLD.revision+1 OR NOT EXISTS(
 SELECT 1 FROM international_us_team_commands c JOIN international_us_team_audit a ON a.organization_id=c.organization_id AND a.command_id=c.command_id
 WHERE c.organization_id=OLD.organization_id AND c.command_id=NEW.last_command_id AND c.expected_revision=OLD.revision AND c.revision=NEW.revision)
 THEN RAISE(ABORT,'us_team_revision_conflict') END;
END;
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
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_saas_authorities a JOIN international_workspace_creation_intents i ON i.creation_id=a.creation_id
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
CREATE TRIGGER international_us_team_invitation_insert BEFORE INSERT ON international_us_team_invitations
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_team_invitations WHERE invitation_id=NEW.invitation_id OR token_hash=NEW.token_hash) OR NEW.status<>'pending' OR NEW.created_at>unixepoch() OR NEW.expires_at<=unixepoch()
 OR NOT EXISTS(SELECT 1 FROM international_us_team_commands c WHERE c.organization_id=NEW.organization_id AND c.command_id=NEW.created_command_id AND c.action IN('create_invitation','regenerate_invitation')
 AND c.entity_id=NEW.invitation_id AND c.actor_user_id=NEW.created_by AND c.created_at=NEW.created_at AND json_extract(c.command_json,'$.tokenHash')=NEW.token_hash AND json_extract(c.command_json,'$.expiresAt')=NEW.expires_at
 AND ((c.action='create_invitation' AND json_extract(c.command_json,'$.email')=NEW.email AND json_extract(c.command_json,'$.role')=NEW.role)
 OR (c.action='regenerate_invitation' AND EXISTS(SELECT 1 FROM international_us_team_invitations old WHERE old.organization_id=NEW.organization_id AND old.invitation_id=json_extract(c.command_json,'$.invitationId')
 AND old.status='revoked' AND old.changed_command_id=c.command_id AND old.email=NEW.email AND old.role=NEW.role)))) THEN RAISE(ABORT,'us_team_invalid_record') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_team_invitations v WHERE v.organization_id=NEW.organization_id AND v.email=NEW.email AND v.status='pending' AND v.expires_at>unixepoch())
 OR EXISTS(SELECT 1 FROM international_us_team_profiles p WHERE p.organization_id=NEW.organization_id AND p.email=NEW.email) THEN RAISE(ABORT,'us_team_invitation_unavailable') END;
 SELECT CASE WHEN (SELECT count(*) FROM international_workspace_members WHERE organization_id=NEW.organization_id AND revoked_at IS NULL)
 +(SELECT count(*) FROM international_us_team_invitations WHERE organization_id=NEW.organization_id AND status='pending' AND expires_at>unixepoch()) >=(SELECT seat_limit FROM international_saas_authorities WHERE organization_id=NEW.organization_id)
 THEN RAISE(ABORT,'us_team_seat_limit_reached') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_invitation_update BEFORE UPDATE ON international_us_team_invitations
BEGIN
 SELECT CASE WHEN NEW.invitation_id IS NOT OLD.invitation_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.email IS NOT OLD.email OR NEW.role IS NOT OLD.role OR NEW.token_hash IS NOT OLD.token_hash
 OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_command_id IS NOT OLD.created_command_id OR OLD.status<>'pending' OR NEW.status NOT IN('revoked','accepted')
 OR NOT EXISTS(SELECT 1 FROM international_us_team_commands c WHERE c.organization_id=OLD.organization_id AND c.command_id=NEW.changed_command_id AND json_extract(c.command_json,'$.invitationId')=OLD.invitation_id
 AND c.expected_revision=(SELECT revision FROM international_us_team_heads WHERE organization_id=OLD.organization_id)
 AND ((NEW.status='revoked' AND c.action IN('regenerate_invitation','revoke_invitation') AND NEW.revoked_at=c.created_at)
 OR (NEW.status='accepted' AND c.action='accept_invitation' AND NEW.accepted_by=c.actor_user_id AND NEW.accepted_at=c.created_at AND NEW.membership_id=c.entity_id))) THEN RAISE(ABORT,'us_team_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_member_insert BEFORE INSERT ON international_workspace_members WHEN NEW.role<>'owner'
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_team_commands c JOIN international_us_team_invitations v ON v.organization_id=c.organization_id AND v.invitation_id=json_extract(c.command_json,'$.invitationId')
 WHERE c.organization_id=NEW.organization_id AND c.action='accept_invitation' AND c.entity_id=NEW.membership_id AND c.actor_user_id=NEW.user_id AND c.created_at=NEW.joined_at
 AND c.expected_revision=(SELECT revision FROM international_us_team_heads WHERE organization_id=NEW.organization_id) AND v.status='accepted' AND v.changed_command_id=c.command_id
 AND v.accepted_by=NEW.user_id AND v.membership_id=NEW.membership_id AND v.role=NEW.role AND NEW.display_name=json_extract(c.command_json,'$.displayName')) THEN RAISE(ABORT,'us_team_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_owner_protected BEFORE UPDATE ON international_workspace_members WHEN OLD.role='owner' AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN SELECT RAISE(ABORT,'us_team_owner_protected'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_member_update BEFORE UPDATE ON international_workspace_members WHEN NEW.display_name IS NOT OLD.display_name OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
 SELECT CASE WHEN NEW.display_name IS NOT OLD.display_name OR NOT EXISTS(SELECT 1 FROM international_us_team_commands c WHERE c.organization_id=OLD.organization_id AND c.action='revoke_member'
 AND c.entity_id=OLD.membership_id AND c.created_at=NEW.revoked_at AND c.expected_revision=(SELECT revision FROM international_us_team_heads WHERE organization_id=OLD.organization_id)) THEN RAISE(ABORT,'us_team_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_profile_insert BEFORE INSERT ON international_us_team_profiles
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_team_profiles WHERE organization_id=NEW.organization_id AND (membership_id=NEW.membership_id OR user_id=NEW.user_id OR email=NEW.email))
 OR NOT EXISTS(SELECT 1 FROM international_us_team_commands c JOIN international_workspace_members m ON m.organization_id=c.organization_id AND m.membership_id=c.entity_id
 WHERE c.organization_id=NEW.organization_id AND c.command_id=NEW.accepted_command_id AND c.action='accept_invitation' AND c.entity_id=NEW.membership_id AND c.actor_user_id=NEW.user_id
 AND c.created_at=NEW.created_at AND json_extract(c.context_json,'$.user.email')=NEW.email AND json_extract(c.command_json,'$.firstName')=NEW.first_name AND json_extract(c.command_json,'$.lastName')=NEW.last_name
 AND json_extract(c.command_json,'$.displayName')=NEW.display_name AND m.display_name=NEW.display_name AND m.user_id=NEW.user_id AND m.revoked_at IS NULL) THEN RAISE(ABORT,'us_team_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_audit_insert BEFORE INSERT ON international_us_team_audit
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_team_audit WHERE organization_id=NEW.organization_id AND command_id=NEW.command_id)
 OR NOT EXISTS(SELECT 1 FROM international_us_team_commands c WHERE c.organization_id=NEW.organization_id AND c.command_id=NEW.command_id AND c.revision=NEW.revision
 AND c.actor_user_id=NEW.actor_user_id AND c.action=NEW.action AND c.entity_id=NEW.entity_id AND c.request_hash=NEW.request_hash AND c.created_at=NEW.created_at
 AND c.expected_revision=(SELECT revision FROM international_us_team_heads WHERE organization_id=NEW.organization_id)) THEN RAISE(ABORT,'us_team_invalid_record') END;
 SELECT CASE WHEN NEW.action IN('create_invitation','regenerate_invitation') AND NOT EXISTS(SELECT 1 FROM international_us_team_invitations WHERE organization_id=NEW.organization_id AND invitation_id=NEW.entity_id AND created_command_id=NEW.command_id AND status='pending') THEN RAISE(ABORT,'us_team_invalid_record') END;
 SELECT CASE WHEN NEW.action='revoke_invitation' AND NOT EXISTS(SELECT 1 FROM international_us_team_invitations WHERE organization_id=NEW.organization_id AND invitation_id=NEW.entity_id AND changed_command_id=NEW.command_id AND status='revoked') THEN RAISE(ABORT,'us_team_invalid_record') END;
 SELECT CASE WHEN NEW.action='accept_invitation' AND NOT EXISTS(SELECT 1 FROM international_us_team_profiles p JOIN international_workspace_members m ON m.organization_id=p.organization_id AND m.membership_id=p.membership_id
 WHERE p.organization_id=NEW.organization_id AND p.membership_id=NEW.entity_id AND p.accepted_command_id=NEW.command_id AND m.user_id=NEW.actor_user_id AND m.revoked_at IS NULL) THEN RAISE(ABORT,'us_team_invalid_record') END;
 SELECT CASE WHEN NEW.action='revoke_member' AND (NOT EXISTS(SELECT 1 FROM international_workspace_members WHERE organization_id=NEW.organization_id AND membership_id=NEW.entity_id AND revoked_at=NEW.created_at)
 OR EXISTS(SELECT 1 FROM international_us_device_sessions s JOIN international_workspace_members m ON m.organization_id=s.organization_id AND m.user_id=s.user_id WHERE m.organization_id=NEW.organization_id AND m.membership_id=NEW.entity_id AND s.revoked_at IS NULL)
 OR EXISTS(SELECT 1 FROM international_us_device_v4_sessions s JOIN international_workspace_members m ON m.organization_id=s.organization_id AND m.user_id=s.user_id WHERE m.organization_id=NEW.organization_id AND m.membership_id=NEW.entity_id AND s.revoked_at IS NULL)) THEN RAISE(ABORT,'us_team_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_heads_no_delete BEFORE DELETE ON international_us_team_heads BEGIN SELECT RAISE(ABORT,'us_team_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_commands_no_update BEFORE UPDATE ON international_us_team_commands BEGIN SELECT RAISE(ABORT,'us_team_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_commands_no_delete BEFORE DELETE ON international_us_team_commands BEGIN SELECT RAISE(ABORT,'us_team_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_invitations_no_delete BEFORE DELETE ON international_us_team_invitations BEGIN SELECT RAISE(ABORT,'us_team_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_profiles_no_update BEFORE UPDATE ON international_us_team_profiles BEGIN SELECT RAISE(ABORT,'us_team_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_profiles_no_delete BEFORE DELETE ON international_us_team_profiles BEGIN SELECT RAISE(ABORT,'us_team_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_audit_no_update BEFORE UPDATE ON international_us_team_audit BEGIN SELECT RAISE(ABORT,'us_team_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_audit_no_delete BEFORE DELETE ON international_us_team_audit BEGIN SELECT RAISE(ABORT,'us_team_immutable'); END;
--> statement-breakpoint
-- Finalization cannot be omitted by a partial privileged batch. The immutable
-- audit is inserted last, after its correlated effects, and advances the head.
CREATE TRIGGER international_us_team_audit_finalize AFTER INSERT ON international_us_team_audit
BEGIN UPDATE international_us_team_heads SET revision=NEW.revision,last_command_id=NEW.command_id WHERE organization_id=NEW.organization_id; END;
--> statement-breakpoint
CREATE TRIGGER international_us_team_command_credential BEFORE INSERT ON international_us_team_commands
WHEN json_type(NEW.context_json,'$.credential') IS NOT NULL
BEGIN
 SELECT CASE WHEN json_extract(NEW.context_json,'$.credential.kind') NOT IN('browser','device')
 OR (json_extract(NEW.context_json,'$.credential.kind')='browser' AND (SELECT count(*) FROM json_each(NEW.context_json,'$.credential'))<>1)
 OR (json_extract(NEW.context_json,'$.credential.kind')='device' AND ((SELECT count(*) FROM json_each(NEW.context_json,'$.credential'))<>3 OR EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))))
 OR (NEW.action='accept_invitation' AND json_extract(NEW.context_json,'$.credential.kind')<>'browser')
 OR (json_extract(NEW.context_json,'$.credential.kind')='device' AND NOT EXISTS(
 SELECT 1 FROM international_us_device_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.credential.sessionId')
 AND s.supported_schema_version=json_extract(NEW.context_json,'$.credential.supportedSchemaVersion') AND s.organization_id=NEW.organization_id
 AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.role') AND s.subscription_id=json_extract(NEW.context_json,'$.subscriptionId')
 AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch()
 UNION ALL SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.credential.sessionId')
 AND s.supported_schema_version=json_extract(NEW.context_json,'$.credential.supportedSchemaVersion') AND s.organization_id=NEW.organization_id
 AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.role') AND s.subscription_id=json_extract(NEW.context_json,'$.subscriptionId')
 AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())) THEN RAISE(ABORT,'us_team_management_required') END;
END;
