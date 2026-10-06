CREATE TABLE purchase_intents (
 intent_id TEXT PRIMARY KEY NOT NULL,
 fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
 owner_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('TEST','PRODUCTION')),
 provider TEXT NOT NULL CHECK(provider IN ('stripe','postfinance')), provider_scope TEXT NOT NULL,
 product TEXT NOT NULL CHECK(product IN ('gestion','support','automation','complete')),
 organization_id TEXT, workspace_id TEXT, plan_id TEXT CHECK(plan_id IS NOT NULL OR product='automation'),
 parameters TEXT NOT NULL CHECK(json_valid(parameters) AND json_type(parameters)='object' AND length(CAST(parameters AS BLOB))<=32768),
 terms_version TEXT NOT NULL, consent_version TEXT, origin TEXT NOT NULL,
 accepted_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','dispatched','uncertain','settled','canceled','expired','released')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, dispatched_at INTEGER,
 provider_reference TEXT, evidence_fingerprint TEXT, finalized_at INTEGER,
 CHECK(created_at>0 AND accepted_at=created_at AND expires_at>created_at),
 CHECK((product IN ('gestion','automation') AND organization_id IS NOT NULL AND workspace_id IS NULL)
  OR (product='support' AND workspace_id IS NOT NULL)
  OR (product='complete' AND organization_id IS NOT NULL AND workspace_id IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX purchase_intents_owner_created ON purchase_intents(owner_id,created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX purchase_intents_provider_reference ON purchase_intents(environment,provider,provider_scope,provider_reference);
--> statement-breakpoint
CREATE TABLE purchase_intent_footprints (
 intent_id TEXT NOT NULL REFERENCES purchase_intents(intent_id),
 environment TEXT NOT NULL CHECK(environment IN ('TEST','PRODUCTION')),
 scope_kind TEXT NOT NULL CHECK(scope_kind IN ('organization','workspace')),
 scope_id TEXT NOT NULL, entitlement TEXT NOT NULL CHECK(entitlement IN ('gestion','support','automation')),
 released_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX purchase_footprint_identity ON purchase_intent_footprints(intent_id,scope_kind,scope_id,entitlement);
--> statement-breakpoint
CREATE UNIQUE INDEX purchase_footprint_exclusion ON purchase_intent_footprints(environment,scope_kind,scope_id,entitlement) WHERE released_at IS NULL;
--> statement-breakpoint
-- Financial occupancy, not a rights reader. Pending/nonterminal subscriptions
-- also exclude a second purchase. Cancelled paid periods retain their slot.
-- Keep each compound SELECT below the D1 parser limit. UNION remains distinct
-- at both levels, so regrouping preserves the exact financial occupancy set.
CREATE VIEW purchase_occupied_stripe_gestion_entitlements AS
 SELECT CASE s.livemode WHEN 1 THEN 'PRODUCTION' ELSE 'TEST' END AS environment,
  'organization' AS scope_kind,o.organization_id AS scope_id,'gestion' AS entitlement,s.subscription_id AS source_reference
 FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
 WHERE substr(s.subscription_id,1,4)='sub_' AND (s.entitlement_valid_until>unixepoch() OR s.status NOT IN ('canceled','incomplete_expired'))
 UNION
 SELECT CASE s.livemode WHEN 1 THEN 'PRODUCTION' ELSE 'TEST' END,'organization',o.organization_id,'automation',s.subscription_id
 FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id JOIN complete_subscriptions c ON c.subscription_id=s.subscription_id
 WHERE substr(s.subscription_id,1,4)='sub_' AND (s.entitlement_valid_until>unixepoch() OR s.status NOT IN ('canceled','incomplete_expired'))
 UNION
 SELECT CASE s.livemode WHEN 1 THEN 'PRODUCTION' ELSE 'TEST' END,'organization',o.organization_id,'support',s.subscription_id
 FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id JOIN complete_subscriptions c ON c.subscription_id=s.subscription_id
 WHERE substr(s.subscription_id,1,4)='sub_' AND (s.entitlement_valid_until>unixepoch() OR s.status NOT IN ('canceled','incomplete_expired'))
 UNION
 SELECT CASE s.livemode WHEN 1 THEN 'PRODUCTION' ELSE 'TEST' END,'workspace',l.workspace_id,'support',s.subscription_id
 FROM support_gestion_links l JOIN organizations o ON o.organization_id=l.organization_id JOIN subscriptions s ON s.subscription_id=o.subscription_id JOIN complete_subscriptions c ON c.subscription_id=s.subscription_id
 WHERE substr(s.subscription_id,1,4)='sub_' AND (s.entitlement_valid_until>unixepoch() OR s.status NOT IN ('canceled','incomplete_expired'));
--> statement-breakpoint
CREATE VIEW purchase_occupied_stripe_addon_entitlements(environment,scope_kind,scope_id,entitlement,source_reference) AS
 SELECT CASE a.livemode WHEN 1 THEN 'PRODUCTION' ELSE 'TEST' END,'organization',a.organization_id,'automation',a.subscription_id
 FROM automation_subscriptions a WHERE substr(a.subscription_id,1,4)='sub_' AND (a.paid_until>unixepoch() OR a.status NOT IN ('canceled','incomplete_expired'))
 UNION
 SELECT CASE s.livemode WHEN 1 THEN 'PRODUCTION' ELSE 'TEST' END,'workspace',s.workspace_id,'support',s.subscription_id
 FROM support_subscriptions s WHERE substr(s.subscription_id,1,4)='sub_' AND (s.paid_until>unixepoch() OR s.status NOT IN ('canceled','incomplete_expired'))
 UNION
 SELECT CASE s.livemode WHEN 1 THEN 'PRODUCTION' ELSE 'TEST' END,'organization',l.organization_id,'support',s.subscription_id
 FROM support_subscriptions s JOIN support_gestion_links l ON l.workspace_id=s.workspace_id
 WHERE substr(s.subscription_id,1,4)='sub_' AND (s.paid_until>unixepoch() OR s.status NOT IN ('canceled','incomplete_expired'));
--> statement-breakpoint
CREATE VIEW purchase_occupied_prepaid_entitlements(environment,scope_kind,scope_id,entitlement,source_reference) AS
 SELECT c.environment,'organization',c.organization_id,e.entitlement,c.contract_id
 FROM prepaid_contracts c JOIN (
  SELECT 'gestion' AS product,'gestion' AS entitlement UNION ALL SELECT 'automation','automation'
  UNION ALL SELECT 'complete','gestion' UNION ALL SELECT 'complete','automation' UNION ALL SELECT 'complete','support'
 ) e ON e.product=CASE WHEN c.product_key LIKE 'complet:%' THEN 'complete' WHEN c.product_key='automation' THEN 'automation' ELSE substr(c.product_key,1,instr(c.product_key,':')-1) END
 WHERE c.organization_id IS NOT NULL AND (c.cancelled_at IS NULL OR EXISTS(
  SELECT 1 FROM prepaid_periods p JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id WHERE p.contract_id=c.contract_id
  AND p.starts_at<=unixepoch() AND p.ends_at>unixepoch() AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)))
 UNION
 SELECT c.environment,'workspace',c.workspace_id,'support',c.contract_id
 FROM prepaid_contracts c WHERE c.workspace_id IS NOT NULL AND (c.product_key LIKE 'support:%' OR c.product_key LIKE 'complet:%')
 AND (c.cancelled_at IS NULL OR EXISTS(SELECT 1 FROM prepaid_periods p JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id WHERE p.contract_id=c.contract_id
  AND p.starts_at<=unixepoch() AND p.ends_at>unixepoch() AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)))
 UNION
 SELECT c.environment,'organization',l.organization_id,'support',c.contract_id
 FROM prepaid_contracts c JOIN support_gestion_links l ON l.workspace_id=c.workspace_id WHERE c.product_key LIKE 'support:%'
 AND (c.cancelled_at IS NULL OR EXISTS(SELECT 1 FROM prepaid_periods p JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id WHERE p.contract_id=c.contract_id
  AND p.starts_at<=unixepoch() AND p.ends_at>unixepoch() AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)));
--> statement-breakpoint
CREATE VIEW purchase_occupied_entitlements AS
 SELECT environment,scope_kind,scope_id,entitlement,source_reference FROM purchase_occupied_stripe_gestion_entitlements
 UNION
 SELECT environment,scope_kind,scope_id,entitlement,source_reference FROM purchase_occupied_stripe_addon_entitlements
 UNION
 SELECT environment,scope_kind,scope_id,entitlement,source_reference FROM purchase_occupied_prepaid_entitlements;
--> statement-breakpoint
-- Revalidated on dispatch too, since membership/linkage can change after reserve.
CREATE VIEW purchase_valid_targets AS
 SELECT i.intent_id FROM purchase_intents i WHERE
 (i.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id
   WHERE o.organization_id=i.organization_id AND o.created_by_user_id=i.owner_id AND m.user_id=i.owner_id AND m.role='owner' AND m.revoked_at IS NULL))
 AND (i.workspace_id IS NULL OR EXISTS(SELECT 1 FROM support_workspaces w WHERE w.id=i.workspace_id AND w.owner_id=i.owner_id))
 AND (i.product<>'support' OR (i.organization_id IS (SELECT organization_id FROM support_gestion_links WHERE workspace_id=i.workspace_id)))
 AND (i.product<>'complete' OR NOT EXISTS(SELECT 1 FROM support_gestion_links l WHERE
   (l.workspace_id=i.workspace_id AND l.organization_id<>i.organization_id) OR (l.organization_id=i.organization_id AND l.workspace_id<>i.workspace_id)));
--> statement-breakpoint
-- Malformed historical environment snapshots fail closed in both environments.
CREATE VIEW purchase_pending_changes AS
 SELECT organization_id,'PRODUCTION' AS environment FROM complete_plan_changes WHERE state IN ('preparing','scheduled')
 AND coalesce(json_type(CASE WHEN json_valid(source_json) THEN source_json ELSE '{}' END,'$.live'),'null')<>'false'
 UNION
 SELECT organization_id,'TEST' FROM complete_plan_changes WHERE state IN ('preparing','scheduled')
 AND coalesce(json_type(CASE WHEN json_valid(source_json) THEN source_json ELSE '{}' END,'$.live'),'null')<>'true';
--> statement-breakpoint
CREATE TRIGGER purchase_intent_insert_shape BEFORE INSERT ON purchase_intents
WHEN NEW.state<>'reserved' OR NEW.dispatched_at IS NOT NULL OR NEW.provider_reference IS NOT NULL OR NEW.evidence_fingerprint IS NOT NULL OR NEW.finalized_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'purchase_state'); END;
--> statement-breakpoint
CREATE TRIGGER purchase_footprint_admission BEFORE INSERT ON purchase_intent_footprints BEGIN
 SELECT CASE WHEN NEW.released_at IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM purchase_intents i JOIN purchase_valid_targets t ON t.intent_id=i.intent_id
  WHERE i.intent_id=NEW.intent_id AND i.state='reserved' AND i.environment=NEW.environment
  AND ((NEW.scope_kind='organization' AND NEW.scope_id=i.organization_id AND
   ((i.product='complete') OR (i.product=NEW.entitlement AND i.product IN ('gestion','automation')) OR (i.product='support' AND NEW.entitlement='support')))
   OR (NEW.scope_kind='workspace' AND NEW.scope_id=i.workspace_id AND NEW.entitlement='support' AND i.product IN ('support','complete')))
 ) THEN RAISE(ABORT,'purchase_target') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM purchase_occupied_entitlements a WHERE a.environment=NEW.environment AND a.scope_kind=NEW.scope_kind AND a.scope_id=NEW.scope_id AND a.entitlement=NEW.entitlement)
  THEN RAISE(ABORT,'purchase_rights') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM purchase_pending_changes c WHERE c.environment=NEW.environment
  AND ((NEW.scope_kind='organization' AND c.organization_id=NEW.scope_id) OR
   (NEW.scope_kind='workspace' AND EXISTS(SELECT 1 FROM support_gestion_links l WHERE l.workspace_id=NEW.scope_id AND l.organization_id=c.organization_id))))
  THEN RAISE(ABORT,'purchase_change') END;
END;
--> statement-breakpoint
CREATE TRIGGER purchase_intent_immutable BEFORE UPDATE ON purchase_intents WHEN
 NEW.intent_id IS NOT OLD.intent_id OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.owner_id IS NOT OLD.owner_id
 OR NEW.environment IS NOT OLD.environment OR NEW.provider IS NOT OLD.provider OR NEW.provider_scope IS NOT OLD.provider_scope
 OR NEW.product IS NOT OLD.product OR NEW.organization_id IS NOT OLD.organization_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.plan_id IS NOT OLD.plan_id OR NEW.parameters IS NOT OLD.parameters OR NEW.terms_version IS NOT OLD.terms_version
 OR NEW.consent_version IS NOT OLD.consent_version OR NEW.origin IS NOT OLD.origin OR NEW.accepted_at IS NOT OLD.accepted_at
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT,'purchase_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER purchase_intent_transition BEFORE UPDATE ON purchase_intents BEGIN
 SELECT CASE WHEN NOT (
  (NEW.state=OLD.state) OR (OLD.state='reserved' AND NEW.state IN ('dispatched','released'))
  OR (OLD.state='dispatched' AND NEW.state IN ('uncertain','settled','canceled','expired'))
  OR (OLD.state='uncertain' AND NEW.state IN ('settled','canceled','expired'))
 ) THEN RAISE(ABORT,'purchase_state') END;
 SELECT CASE WHEN OLD.state IN ('released','settled','canceled','expired') AND
  (NEW.state IS NOT OLD.state OR NEW.dispatched_at IS NOT OLD.dispatched_at OR NEW.provider_reference IS NOT OLD.provider_reference
   OR NEW.evidence_fingerprint IS NOT OLD.evidence_fingerprint OR NEW.finalized_at IS NOT OLD.finalized_at) THEN RAISE(ABORT,'purchase_state') END;
 SELECT CASE WHEN OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at THEN RAISE(ABORT,'purchase_state') END;
 SELECT CASE WHEN OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS NOT OLD.provider_reference THEN RAISE(ABORT,'purchase_binding') END;
 SELECT CASE WHEN NEW.state='reserved' AND (NEW.dispatched_at IS NOT NULL OR NEW.provider_reference IS NOT NULL OR NEW.evidence_fingerprint IS NOT NULL OR NEW.finalized_at IS NOT NULL) THEN RAISE(ABORT,'purchase_state') END;
 SELECT CASE WHEN NEW.state IN ('dispatched','uncertain') AND (NEW.dispatched_at IS NULL OR NEW.dispatched_at<NEW.created_at OR NEW.evidence_fingerprint IS NOT NULL OR NEW.finalized_at IS NOT NULL) THEN RAISE(ABORT,'purchase_state') END;
 SELECT CASE WHEN NEW.state='released' AND (OLD.dispatched_at IS NOT NULL OR NEW.provider_reference IS NOT NULL OR NEW.evidence_fingerprint IS NOT NULL OR NEW.finalized_at IS NULL OR NEW.finalized_at<NEW.created_at) THEN RAISE(ABORT,'purchase_state') END;
 SELECT CASE WHEN NEW.state IN ('settled','canceled','expired') AND (NEW.dispatched_at IS NULL OR NEW.provider_reference IS NULL OR NEW.evidence_fingerprint IS NULL
  OR length(NEW.evidence_fingerprint)<>64 OR NEW.evidence_fingerprint GLOB '*[^a-f0-9]*' OR NEW.finalized_at IS NULL OR NEW.finalized_at<NEW.dispatched_at) THEN RAISE(ABORT,'purchase_state') END;
END;
--> statement-breakpoint
CREATE TRIGGER purchase_intent_dispatch_guard BEFORE UPDATE OF state ON purchase_intents WHEN OLD.state='reserved' AND NEW.state='dispatched' BEGIN
 SELECT CASE WHEN NEW.expires_at<=unixepoch() OR NOT EXISTS(SELECT 1 FROM purchase_valid_targets WHERE intent_id=NEW.intent_id)
  THEN RAISE(ABORT,'purchase_target') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM purchase_intent_footprints f WHERE f.intent_id=NEW.intent_id AND f.released_at IS NULL)
  <> CASE NEW.product WHEN 'complete' THEN 4 WHEN 'support' THEN CASE WHEN NEW.organization_id IS NULL THEN 1 ELSE 2 END ELSE 1 END
  THEN RAISE(ABORT,'purchase_footprint') END;
 SELECT CASE WHEN NEW.provider='postfinance' AND EXISTS(SELECT 1 FROM prepaid_contracts own WHERE own.contract_id=('pfp_'||substr(NEW.intent_id,10)))
  AND NOT EXISTS(SELECT 1 FROM prepaid_contracts own WHERE own.contract_id=('pfp_'||substr(NEW.intent_id,10))
   AND own.owner_id=NEW.owner_id AND own.environment=NEW.environment AND (own.api_origin||'|'||own.space_id)=NEW.provider_scope
   AND own.organization_id IS NEW.organization_id AND own.workspace_id IS NEW.workspace_id AND own.cancelled_at IS NULL
   AND CASE WHEN own.product_key LIKE 'complet:%' THEN 'complete' WHEN own.product_key='automation' THEN 'automation' ELSE substr(own.product_key,1,instr(own.product_key,':')-1) END=NEW.product
   AND json_extract(own.catalog_json,'$.planId') IS NEW.plan_id
   AND (json_type(NEW.parameters,'$.productKey') IS NULL OR json_extract(NEW.parameters,'$.productKey')=own.product_key))
  THEN RAISE(ABORT,'purchase_binding') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM purchase_intent_footprints f JOIN purchase_occupied_entitlements a
  ON a.environment=f.environment AND a.scope_kind=f.scope_kind AND a.scope_id=f.scope_id AND a.entitlement=f.entitlement
  WHERE f.intent_id=NEW.intent_id AND f.released_at IS NULL AND NOT (
   NEW.provider='postfinance' AND a.source_reference=('pfp_'||substr(NEW.intent_id,10)) AND EXISTS(
    SELECT 1 FROM prepaid_contracts own WHERE own.contract_id=a.source_reference AND own.owner_id=NEW.owner_id
    AND own.environment=NEW.environment AND (own.api_origin||'|'||own.space_id)=NEW.provider_scope
    AND own.organization_id IS NEW.organization_id AND own.workspace_id IS NEW.workspace_id AND own.cancelled_at IS NULL
    AND CASE WHEN own.product_key LIKE 'complet:%' THEN 'complete' WHEN own.product_key='automation' THEN 'automation' ELSE substr(own.product_key,1,instr(own.product_key,':')-1) END=NEW.product
    AND json_extract(own.catalog_json,'$.planId') IS NEW.plan_id
    AND NOT EXISTS(SELECT 1 FROM prepaid_periods period JOIN prepaid_settlement_proofs proof ON proof.period_id=period.period_id WHERE period.contract_id=own.contract_id)
   )))
  THEN RAISE(ABORT,'purchase_rights') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM purchase_pending_changes c JOIN purchase_intent_footprints f ON
  (f.scope_kind='organization' AND f.scope_id=c.organization_id) OR
  (f.scope_kind='workspace' AND EXISTS(SELECT 1 FROM support_gestion_links l WHERE l.workspace_id=f.scope_id AND l.organization_id=c.organization_id))
  WHERE c.environment=f.environment AND f.intent_id=NEW.intent_id AND f.released_at IS NULL)
  THEN RAISE(ABORT,'purchase_change') END;
END;
--> statement-breakpoint
CREATE TRIGGER purchase_intent_release AFTER UPDATE OF state ON purchase_intents WHEN NEW.state IN ('released','canceled','expired') AND NEW.state<>OLD.state BEGIN
 UPDATE purchase_intent_footprints SET released_at=NEW.finalized_at WHERE intent_id=NEW.intent_id AND released_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER purchase_footprint_immutable BEFORE UPDATE ON purchase_intent_footprints WHEN
 NEW.intent_id IS NOT OLD.intent_id OR NEW.environment IS NOT OLD.environment OR NEW.scope_kind IS NOT OLD.scope_kind
 OR NEW.scope_id IS NOT OLD.scope_id OR NEW.entitlement IS NOT OLD.entitlement OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
 OR NOT EXISTS(SELECT 1 FROM purchase_intents i WHERE i.intent_id=NEW.intent_id AND i.state IN ('released','canceled','expired') AND i.finalized_at=NEW.released_at)
BEGIN SELECT RAISE(ABORT,'purchase_footprint_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER purchase_intent_no_delete BEFORE DELETE ON purchase_intents BEGIN SELECT RAISE(ABORT,'purchase_history'); END;
--> statement-breakpoint
CREATE TRIGGER purchase_footprint_no_delete BEFORE DELETE ON purchase_intent_footprints BEGIN SELECT RAISE(ABORT,'purchase_history'); END;
--> statement-breakpoint
-- Also close the reverse-order race: a plan change cannot begin after an
-- overlapping intent took its slots. Different companies remain independent.
CREATE TRIGGER purchase_complete_change_insert BEFORE INSERT ON complete_plan_changes WHEN NEW.state IN ('preparing','scheduled') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM purchase_intent_footprints f WHERE f.released_at IS NULL
  AND (coalesce(json_type(CASE WHEN json_valid(NEW.source_json) THEN NEW.source_json ELSE '{}' END,'$.live'),'null') NOT IN ('true','false')
    OR f.environment=CASE json_type(CASE WHEN json_valid(NEW.source_json) THEN NEW.source_json ELSE '{}' END,'$.live') WHEN 'true' THEN 'PRODUCTION' ELSE 'TEST' END) AND
  ((f.scope_kind='organization' AND f.scope_id=NEW.organization_id) OR
   (f.scope_kind='workspace' AND EXISTS(SELECT 1 FROM support_gestion_links l WHERE l.workspace_id=f.scope_id AND l.organization_id=NEW.organization_id))))
  THEN RAISE(ABORT,'purchase_change') END;
END;
--> statement-breakpoint
CREATE TRIGGER purchase_complete_change_update BEFORE UPDATE ON complete_plan_changes WHEN NEW.state IN ('preparing','scheduled') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM purchase_intent_footprints f WHERE f.released_at IS NULL
  AND (coalesce(json_type(CASE WHEN json_valid(NEW.source_json) THEN NEW.source_json ELSE '{}' END,'$.live'),'null') NOT IN ('true','false')
    OR f.environment=CASE json_type(CASE WHEN json_valid(NEW.source_json) THEN NEW.source_json ELSE '{}' END,'$.live') WHEN 'true' THEN 'PRODUCTION' ELSE 'TEST' END) AND
  ((f.scope_kind='organization' AND f.scope_id=NEW.organization_id) OR
   (f.scope_kind='workspace' AND EXISTS(SELECT 1 FROM support_gestion_links l WHERE l.workspace_id=f.scope_id AND l.organization_id=NEW.organization_id))))
  THEN RAISE(ABORT,'purchase_change') END;
END;
