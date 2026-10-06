CREATE TABLE gestion_purchase_drafts (
 owner_id TEXT NOT NULL,environment TEXT NOT NULL CHECK(environment IN ('TEST','PRODUCTION')),
 organization_id TEXT NOT NULL,original_subscription_id TEXT NOT NULL,
 referral_code TEXT,referral_claim_id TEXT,coupon_id TEXT,created_at INTEGER NOT NULL CHECK(created_at>0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX gestion_purchase_drafts_organization_id_unique ON gestion_purchase_drafts(organization_id);
--> statement-breakpoint
CREATE UNIQUE INDEX gestion_purchase_drafts_original_subscription_id_unique ON gestion_purchase_drafts(original_subscription_id);
--> statement-breakpoint
CREATE UNIQUE INDEX gestion_draft_owner_environment ON gestion_purchase_drafts(owner_id,environment);
--> statement-breakpoint
CREATE TABLE gestion_purchase_requests (
 request_id TEXT PRIMARY KEY NOT NULL,owner_id TEXT NOT NULL,organization_id TEXT NOT NULL,previous_subscription_id TEXT NOT NULL,
 environment TEXT NOT NULL CHECK(environment IN ('TEST','PRODUCTION')),provider_scope TEXT NOT NULL,plan_id TEXT NOT NULL,
 account_email TEXT NOT NULL,account_name TEXT NOT NULL,origin TEXT NOT NULL,legal_version TEXT NOT NULL,
 referral_code TEXT,referral_claim_id TEXT,coupon_id TEXT,claim_hash TEXT NOT NULL,sealed_claim TEXT NOT NULL,
 parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json) AND json_type(parameters_json)='object' AND length(CAST(parameters_json AS BLOB))<=16384),
 intent_id TEXT,session_id TEXT,session_url TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,closed_at INTEGER,
 CHECK(created_at>0 AND expires_at>created_at),
 CHECK((referral_code IS NULL AND referral_claim_id IS NULL AND coupon_id IS NULL) OR (referral_code IS NOT NULL AND referral_claim_id IS NOT NULL AND coupon_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX gestion_purchase_requests_claim_hash_unique ON gestion_purchase_requests(claim_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX gestion_purchase_requests_intent_id_unique ON gestion_purchase_requests(intent_id);
--> statement-breakpoint
CREATE UNIQUE INDEX gestion_purchase_requests_session_id_unique ON gestion_purchase_requests(session_id);
--> statement-breakpoint
CREATE UNIQUE INDEX gestion_request_current_target ON gestion_purchase_requests(organization_id,environment) WHERE closed_at IS NULL;
--> statement-breakpoint
CREATE INDEX gestion_request_owner ON gestion_purchase_requests(owner_id,created_at);
--> statement-breakpoint
CREATE TRIGGER gestion_draft_no_update BEFORE UPDATE ON gestion_purchase_drafts BEGIN SELECT RAISE(ABORT,'gestion_draft_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER gestion_draft_no_delete BEFORE DELETE ON gestion_purchase_drafts BEGIN SELECT RAISE(ABORT,'gestion_purchase_history'); END;
--> statement-breakpoint
CREATE TRIGGER gestion_request_admission BEFORE INSERT ON gestion_purchase_requests BEGIN
 SELECT CASE WHEN NEW.intent_id IS NOT NULL OR NEW.session_id IS NOT NULL OR NEW.session_url IS NOT NULL OR NEW.closed_at IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id
   WHERE o.organization_id=NEW.organization_id AND o.subscription_id=NEW.previous_subscription_id AND o.created_by_user_id=NEW.owner_id
   AND m.user_id=NEW.owner_id AND m.role='owner' AND m.revoked_at IS NULL)
  THEN RAISE(ABORT,'gestion_purchase_target') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM purchase_occupied_entitlements p WHERE p.environment=NEW.environment AND p.scope_kind='organization' AND p.scope_id=NEW.organization_id AND p.entitlement='gestion')
  THEN RAISE(ABORT,'gestion_purchase_paid') END;
 -- Legacy pack checkout has no explicit target. Until it adopts common
 -- footprints, its pending account-wide choice must fail closed in both orders.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM complete_checkouts c WHERE c.user_id=NEW.owner_id)
  THEN RAISE(ABORT,'gestion_purchase_complete') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM purchase_pending_changes c WHERE c.organization_id=NEW.organization_id AND c.environment=NEW.environment)
  THEN RAISE(ABORT,'gestion_purchase_complete') END;
END;
--> statement-breakpoint
CREATE TRIGGER gestion_legacy_complete_checkout_guard BEFORE INSERT ON complete_checkouts BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM gestion_purchase_requests r WHERE r.owner_id=NEW.user_id AND r.closed_at IS NULL)
  THEN RAISE(ABORT,'gestion_purchase_complete') END;
END;
--> statement-breakpoint
CREATE TRIGGER gestion_request_immutable BEFORE UPDATE ON gestion_purchase_requests WHEN
 NEW.request_id IS NOT OLD.request_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.previous_subscription_id IS NOT OLD.previous_subscription_id
 OR NEW.environment IS NOT OLD.environment OR NEW.provider_scope IS NOT OLD.provider_scope OR NEW.plan_id IS NOT OLD.plan_id
 OR NEW.account_email IS NOT OLD.account_email OR NEW.account_name IS NOT OLD.account_name OR NEW.origin IS NOT OLD.origin OR NEW.legal_version IS NOT OLD.legal_version
 OR NEW.referral_code IS NOT OLD.referral_code OR NEW.referral_claim_id IS NOT OLD.referral_claim_id OR NEW.coupon_id IS NOT OLD.coupon_id
 OR NEW.claim_hash IS NOT OLD.claim_hash OR NEW.sealed_claim IS NOT OLD.sealed_claim OR NEW.parameters_json IS NOT OLD.parameters_json
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT,'gestion_purchase_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER gestion_request_binding BEFORE UPDATE ON gestion_purchase_requests BEGIN
 SELECT CASE WHEN OLD.intent_id IS NOT NULL AND NEW.intent_id IS NOT OLD.intent_id THEN RAISE(ABORT,'gestion_purchase_binding') END;
 SELECT CASE WHEN NEW.intent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM purchase_intents i WHERE i.intent_id=NEW.intent_id
  AND i.owner_id=NEW.owner_id AND i.organization_id=NEW.organization_id AND i.workspace_id IS NULL AND i.environment=NEW.environment
  AND i.provider='stripe' AND i.provider_scope=NEW.provider_scope AND i.product='gestion' AND i.plan_id=NEW.plan_id
  AND i.terms_version=NEW.legal_version AND i.origin=NEW.origin AND json_extract(i.parameters,'$.requestId')=NEW.request_id
  AND NOT EXISTS(SELECT fullkey,type,atom FROM json_tree(NEW.parameters_json) EXCEPT SELECT replace(fullkey,'$.stripeParameters','$'),type,atom FROM json_tree(i.parameters,'$.stripeParameters'))
  AND NOT EXISTS(SELECT replace(fullkey,'$.stripeParameters','$'),type,atom FROM json_tree(i.parameters,'$.stripeParameters') EXCEPT SELECT fullkey,type,atom FROM json_tree(NEW.parameters_json)))
  THEN RAISE(ABORT,'gestion_purchase_binding') END;
 SELECT CASE WHEN OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id THEN RAISE(ABORT,'gestion_purchase_binding') END;
 SELECT CASE WHEN NEW.session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM purchase_intents i WHERE i.intent_id=NEW.intent_id AND i.provider_reference=NEW.session_id)
  THEN RAISE(ABORT,'gestion_purchase_binding') END;
 SELECT CASE WHEN OLD.closed_at IS NOT NULL AND NEW.closed_at IS NOT OLD.closed_at THEN RAISE(ABORT,'gestion_purchase_immutable') END;
 SELECT CASE WHEN NEW.closed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM purchase_intents i WHERE i.intent_id=NEW.intent_id
  AND i.state IN ('released','expired','canceled','settled') AND NEW.closed_at>=NEW.created_at)
  THEN RAISE(ABORT,'gestion_purchase_state') END;
END;
--> statement-breakpoint
CREATE TRIGGER gestion_request_no_delete BEFORE DELETE ON gestion_purchase_requests BEGIN SELECT RAISE(ABORT,'gestion_purchase_history'); END;
--> statement-breakpoint
-- These fields are populated only by the existing validated Stripe paid-invoice
-- pipeline. Checkout status never supplies last_paid_invoice_id/last_paid_at.
CREATE VIEW gestion_paid_purchase_bindings AS
 SELECT r.request_id,r.intent_id,r.owner_id,r.organization_id,r.claim_hash,r.session_id,
  s.subscription_id,s.last_paid_invoice_id,s.last_paid_at,s.entitlement_valid_until,s.price_id,s.entitlement_plan_id,s.livemode,s.current_period_end,s.seat_limit
 FROM gestion_purchase_requests r JOIN purchase_intents i ON i.intent_id=r.intent_id
 JOIN subscriptions s ON s.checkout_session_id=coalesce(r.session_id,i.provider_reference)
 JOIN organizations o ON o.organization_id=r.organization_id AND (o.subscription_id=r.previous_subscription_id OR o.subscription_id=s.subscription_id) AND o.created_by_user_id=r.owner_id
 JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=r.owner_id AND m.role='owner' AND m.revoked_at IS NULL
 WHERE i.state IN ('dispatched','uncertain','settled') AND i.provider='stripe' AND i.owner_id=r.owner_id AND i.organization_id=r.organization_id AND i.workspace_id IS NULL
 AND i.environment=r.environment AND i.provider_scope=r.provider_scope AND i.product='gestion' AND i.plan_id=r.plan_id
 AND i.provider_reference=s.checkout_session_id AND i.origin=r.origin AND i.terms_version=r.legal_version
 AND json_extract(i.parameters,'$.requestId')=r.request_id
 AND json_extract(i.parameters,'$.stripeParameters.metadata.activation_claim_hash')=r.claim_hash
 AND json_extract(r.parameters_json,'$.metadata.account_user_id')=r.owner_id
 AND json_extract(r.parameters_json,'$.metadata.organization_id')=r.organization_id
 AND json_extract(r.parameters_json,'$.metadata.gestion_request_id')=r.request_id
 AND json_extract(r.parameters_json,'$.metadata.activation_claim_hash')=r.claim_hash
 AND s.price_id=json_extract(r.parameters_json,'$.line_items[0].price')
 AND s.entitlement_plan_id=json_extract(r.parameters_json,'$.metadata.plan')
 AND s.livemode=CASE r.environment WHEN 'PRODUCTION' THEN 1 ELSE 0 END
 AND substr(s.subscription_id,1,4)='sub_' AND substr(s.last_paid_invoice_id,1,3)='in_'
 AND s.last_paid_at IS NOT NULL AND s.last_paid_at>=r.created_at-60 AND s.last_paid_at<=unixepoch()+60
 AND s.entitlement_valid_until>unixepoch() AND s.current_period_end>=s.entitlement_valid_until
 AND s.seat_limit=CASE r.plan_id WHEN 'solo' THEN 1 WHEN 'start' THEN 3 WHEN 'pro' THEN 10 ELSE -1 END;
--> statement-breakpoint
CREATE VIEW gestion_paid_purchase_projections AS
 SELECT p.* FROM gestion_paid_purchase_bindings p JOIN organizations o ON o.organization_id=p.organization_id
 AND o.subscription_id=p.subscription_id AND o.created_by_user_id=p.owner_id;
--> statement-breakpoint
-- The first handoff is part of the same transaction as the exact company
-- projection. Once released, paid financial occupancy protects new purchases.
DROP TRIGGER purchase_footprint_immutable;
--> statement-breakpoint
CREATE TRIGGER purchase_footprint_immutable BEFORE UPDATE ON purchase_intent_footprints WHEN
 NEW.intent_id IS NOT OLD.intent_id OR NEW.environment IS NOT OLD.environment OR NEW.scope_kind IS NOT OLD.scope_kind
 OR NEW.scope_id IS NOT OLD.scope_id OR NEW.entitlement IS NOT OLD.entitlement OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
 OR NOT EXISTS(SELECT 1 FROM purchase_intents i WHERE i.intent_id=NEW.intent_id AND i.finalized_at=NEW.released_at AND
  (i.state IN ('released','canceled','expired') OR (i.state='settled' AND EXISTS(SELECT 1 FROM gestion_paid_purchase_projections p WHERE p.intent_id=i.intent_id
   AND p.organization_id=NEW.scope_id AND NEW.scope_kind='organization' AND NEW.entitlement='gestion'))))
BEGIN SELECT RAISE(ABORT,'purchase_footprint_immutable'); END;
