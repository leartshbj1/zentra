-- Additive database boundary for prepaid Gestion/Complet rights. No provider
-- call, debit or entitlement is manufactured here. Only reconciled facts count.
-- Published catalogue v1 is immutable; approve a new version in a new migration.
CREATE VIEW prepaid_gestion_catalog_v1(product_key,catalog_json) AS VALUES
 ('gestion:solo','{"productKey":"gestion:solo","productKind":"gestion","planId":"solo","name":"Zentra Gestion Solo","priceChfMinor":4900,"includedProducts":["gestion"],"gestion":{"planId":"solo","licensePlan":"zentra-solo-monthly-49-chf","licensePriceChfMinor":4900,"seats":1,"ownerIncluded":true},"support":null,"automation":false,"catalogVersion":"zentra-prepaid-chf-monthly-v1","scope":"organization","currency":"CHF","billingPeriod":"P1M"}'),
 ('gestion:start','{"productKey":"gestion:start","productKind":"gestion","planId":"start","name":"Zentra Gestion Start","priceChfMinor":5900,"includedProducts":["gestion"],"gestion":{"planId":"start","licensePlan":"zentra-start-monthly-59-chf","licensePriceChfMinor":5900,"seats":3,"ownerIncluded":true},"support":null,"automation":false,"catalogVersion":"zentra-prepaid-chf-monthly-v1","scope":"organization","currency":"CHF","billingPeriod":"P1M"}'),
 ('gestion:pro','{"productKey":"gestion:pro","productKind":"gestion","planId":"pro","name":"Zentra Gestion Pro","priceChfMinor":8900,"includedProducts":["gestion"],"gestion":{"planId":"pro","licensePlan":"zentra-pro-monthly-89-chf","licensePriceChfMinor":8900,"seats":10,"ownerIncluded":true},"support":null,"automation":false,"catalogVersion":"zentra-prepaid-chf-monthly-v1","scope":"organization","currency":"CHF","billingPeriod":"P1M"}'),
 ('complet:solo','{"productKey":"complet:solo","productKind":"complete","planId":"solo","name":"Zentra Complet Solo","priceChfMinor":7900,"includedProducts":["gestion","support","automation"],"gestion":{"planId":"solo","licensePlan":"zentra-solo-monthly-49-chf","licensePriceChfMinor":4900,"seats":1,"ownerIncluded":true},"support":{"planId":"starter","analyses":2000},"automation":true,"catalogVersion":"zentra-prepaid-chf-monthly-v1","scope":"organization","currency":"CHF","billingPeriod":"P1M"}'),
 ('complet:team','{"productKey":"complet:team","productKind":"complete","planId":"team","name":"Zentra Complet Équipe","priceChfMinor":9900,"includedProducts":["gestion","support","automation"],"gestion":{"planId":"start","licensePlan":"zentra-start-monthly-59-chf","licensePriceChfMinor":5900,"seats":3,"ownerIncluded":true},"support":{"planId":"team","analyses":5000},"automation":true,"catalogVersion":"zentra-prepaid-chf-monthly-v1","scope":"organization","currency":"CHF","billingPeriod":"P1M"}'),
 ('complet:pro','{"productKey":"complet:pro","productKind":"complete","planId":"pro","name":"Zentra Complet Pro","priceChfMinor":16900,"includedProducts":["gestion","support","automation"],"gestion":{"planId":"pro","licensePlan":"zentra-pro-monthly-89-chf","licensePriceChfMinor":8900,"seats":10,"ownerIncluded":true},"support":{"planId":"business","analyses":15000},"automation":true,"catalogVersion":"zentra-prepaid-chf-monthly-v1","scope":"organization","currency":"CHF","billingPeriod":"P1M"}');
--> statement-breakpoint

-- Raw paid candidates also detect a second contract hidden by a stale projection.
CREATE VIEW prepaid_company_paid_candidates AS
 SELECT c.contract_id,c.owner_id,c.organization_id,c.workspace_id,c.api_origin,c.space_id,
  c.environment,c.product_key,c.catalog_version AS contract_catalog_version,
  c.catalog_json AS contract_catalog_json,c.anchor_start,c.cancelled_at,c.created_at AS contract_created_at,
  p.period_id,p.ordinal,p.starts_at,p.ends_at,p.currency,p.price_chf_minor,
  p.catalog_version AS period_catalog_version,p.catalog_json AS period_catalog_json,
  t.transaction_id,s.invoice_id,s.evidence_fingerprint,s.reconciled_at,
  o.subscription_id AS actual_subscription_id
 FROM prepaid_contracts c JOIN prepaid_periods p ON p.contract_id=c.contract_id
 JOIN prepaid_transactions t ON t.period_id=p.period_id AND t.api_origin=c.api_origin AND t.space_id=c.space_id
 JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id
 JOIN organizations o ON o.organization_id=c.organization_id AND o.created_by_user_id=c.owner_id
 JOIN prepaid_gestion_catalog_v1 k ON k.product_key=c.product_key
 WHERE c.environment='PRODUCTION' AND p.starts_at<=unixepoch() AND p.ends_at>unixepoch()
 AND NOT EXISTS(SELECT 1 FROM prepaid_period_revocations r WHERE r.period_id=p.period_id);
--> statement-breakpoint

CREATE VIEW prepaid_valid_company_periods AS
 WITH snapshots AS (
  SELECT a.*,k.catalog_json AS expected_json,
   CASE WHEN json_valid(a.contract_catalog_json) AND length(CAST(a.contract_catalog_json AS BLOB))<=8192 THEN a.contract_catalog_json ELSE 'null' END AS safe_contract_json,
   CASE WHEN json_valid(a.period_catalog_json) AND length(CAST(a.period_catalog_json AS BLOB))<=8192 THEN a.period_catalog_json ELSE 'null' END AS safe_period_json,
   date(a.anchor_start,'unixepoch','start of month',printf('+%d months',a.ordinal)) AS start_month,
   date(a.anchor_start,'unixepoch','start of month',printf('+%d months',a.ordinal+1)) AS end_month
  FROM prepaid_company_paid_candidates a JOIN prepaid_gestion_catalog_v1 k ON k.product_key=a.product_key
 )
 SELECT contract_id,owner_id,organization_id,workspace_id,period_id,starts_at,ends_at,
  product_key,period_catalog_version AS catalog_version,period_catalog_json AS catalog_json,
  json_extract(expected_json,'$.gestion.seats') AS seat_limit,
  json_extract(expected_json,'$.support.planId') AS support_plan_id,
  json_extract(expected_json,'$.support.analyses') AS support_analyses,
  json_extract(expected_json,'$.automation') AS automation
 FROM snapshots
 WHERE length(contract_id)=40 AND substr(contract_id,1,4)='pfp_'
 AND substr(contract_id,13,1)='-' AND substr(contract_id,18,1)='-'
 AND substr(contract_id,23,1)='-' AND substr(contract_id,28,1)='-'
 AND length(replace(substr(contract_id,5),'-',''))=32
 AND replace(substr(contract_id,5),'-','') NOT GLOB '*[^0-9a-f]*'
 AND length(owner_id) BETWEEN 1 AND 180 AND instr(owner_id,char(0))=0
 AND owner_id NOT GLOB ('*['||char(1)||'-'||char(31)||char(127)||']*')
 AND length(organization_id) BETWEEN 1 AND 180 AND instr(organization_id,char(0))=0
 AND organization_id NOT GLOB ('*['||char(1)||'-'||char(31)||char(127)||']*')
 AND length(period_id) BETWEEN 1 AND 180 AND instr(period_id,char(0))=0
 AND period_id NOT GLOB ('*['||char(1)||'-'||char(31)||char(127)||']*')
 AND actual_subscription_id=contract_id
 AND api_origin IN ('https://checkout.postfinance.ch','https://app-wallee.com')
 AND typeof(space_id)='integer' AND space_id BETWEEN 1 AND 9007199254740991
 AND typeof(transaction_id)='integer' AND transaction_id BETWEEN 1 AND 9007199254740991
 AND typeof(invoice_id)='integer' AND invoice_id BETWEEN 1 AND 9007199254740991
 AND typeof(anchor_start)='integer' AND anchor_start BETWEEN 1 AND 9007199254740991
 AND typeof(contract_created_at)='integer' AND contract_created_at>0 AND contract_created_at<=unixepoch()
 AND typeof(reconciled_at)='integer' AND reconciled_at>0 AND reconciled_at<=unixepoch()
 AND length(evidence_fingerprint)=64 AND evidence_fingerprint NOT GLOB '*[^0-9a-f]*'
 AND (cancelled_at IS NULL OR (typeof(cancelled_at)='integer' AND cancelled_at>=contract_created_at AND cancelled_at<=unixepoch()))
 AND typeof(ordinal)='integer' AND ordinal BETWEEN 0 AND 9007199254740990
 AND typeof(starts_at)='integer' AND typeof(ends_at)='integer'
 AND starts_at=CAST(strftime('%s',date(start_month,printf('+%d days',min(CAST(strftime('%d',anchor_start,'unixepoch') AS INTEGER),CAST(strftime('%d',date(start_month,'+1 month','-1 day')) AS INTEGER))-1))||' '||strftime('%H:%M:%S',anchor_start,'unixepoch')) AS INTEGER)
 AND ends_at=CAST(strftime('%s',date(end_month,printf('+%d days',min(CAST(strftime('%d',anchor_start,'unixepoch') AS INTEGER),CAST(strftime('%d',date(end_month,'+1 month','-1 day')) AS INTEGER))-1))||' '||strftime('%H:%M:%S',anchor_start,'unixepoch')) AS INTEGER)
 AND currency='CHF' AND typeof(price_chf_minor)='integer' AND price_chf_minor=json_extract(expected_json,'$.priceChfMinor')
 AND contract_catalog_version=json_extract(expected_json,'$.catalogVersion')
 AND period_catalog_version=json_extract(expected_json,'$.catalogVersion')
 AND (SELECT COUNT(*) FROM json_tree(safe_contract_json))=(SELECT COUNT(*) FROM json_tree(expected_json))
 AND NOT EXISTS(SELECT fullkey,CASE WHEN type IN ('integer','real') THEN 'number' ELSE type END,atom FROM json_tree(safe_contract_json) EXCEPT SELECT fullkey,CASE WHEN type IN ('integer','real') THEN 'number' ELSE type END,atom FROM json_tree(expected_json))
 AND NOT EXISTS(SELECT fullkey,CASE WHEN type IN ('integer','real') THEN 'number' ELSE type END,atom FROM json_tree(expected_json) EXCEPT SELECT fullkey,CASE WHEN type IN ('integer','real') THEN 'number' ELSE type END,atom FROM json_tree(safe_contract_json))
 AND (SELECT COUNT(*) FROM json_tree(safe_period_json))=(SELECT COUNT(*) FROM json_tree(expected_json))
 AND NOT EXISTS(SELECT fullkey,CASE WHEN type IN ('integer','real') THEN 'number' ELSE type END,atom FROM json_tree(safe_period_json) EXCEPT SELECT fullkey,CASE WHEN type IN ('integer','real') THEN 'number' ELSE type END,atom FROM json_tree(expected_json))
 AND NOT EXISTS(SELECT fullkey,CASE WHEN type IN ('integer','real') THEN 'number' ELSE type END,atom FROM json_tree(expected_json) EXCEPT SELECT fullkey,CASE WHEN type IN ('integer','real') THEN 'number' ELSE type END,atom FROM json_tree(safe_period_json))
 AND EXISTS(SELECT 1 FROM organization_members own WHERE own.organization_id=snapshots.organization_id AND own.user_id=snapshots.owner_id AND own.role='owner' AND own.revoked_at IS NULL)
 AND (workspace_id IS NULL OR (
  length(workspace_id) BETWEEN 1 AND 180 AND instr(workspace_id,char(0))=0
  AND workspace_id NOT GLOB ('*['||char(1)||'-'||char(31)||char(127)||']*')
  AND EXISTS(SELECT 1 FROM support_workspaces w WHERE w.id=snapshots.workspace_id AND w.owner_id=snapshots.owner_id)
 ));
--> statement-breakpoint

-- No LIMIT/ORDER BY winner: overlapping periods or distinct paid contracts fail closed.
-- This view covers company Gestion rights. It is NOT a standalone Support grant.
CREATE VIEW prepaid_current_company_rights AS
 SELECT v.* FROM prepaid_valid_company_periods v
 WHERE (SELECT COUNT(DISTINCT a.contract_id) FROM prepaid_company_paid_candidates a WHERE a.organization_id=v.organization_id)=1
 AND (SELECT COUNT(*) FROM prepaid_company_paid_candidates a WHERE a.organization_id=v.organization_id)=1
 AND (SELECT COUNT(*) FROM prepaid_valid_company_periods p WHERE p.organization_id=v.organization_id)=1;
--> statement-breakpoint

-- Historical guards retain their original semantics outside the reserved prefix.
DROP TRIGGER organization_members_plan_insert_guard;
--> statement-breakpoint
CREATE TRIGGER organization_members_plan_insert_guard BEFORE INSERT ON organization_members
WHEN NEW.revoked_at IS NULL AND EXISTS(
 SELECT 1 FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
 WHERE o.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)<>'pfp_' AND s.seat_limit IS NOT NULL
 AND (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL)>=s.seat_limit
) BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;
--> statement-breakpoint
DROP TRIGGER organization_members_plan_reactivate_guard;
--> statement-breakpoint
CREATE TRIGGER organization_members_plan_reactivate_guard BEFORE UPDATE OF revoked_at,organization_id ON organization_members
WHEN NEW.revoked_at IS NULL AND (OLD.revoked_at IS NOT NULL OR NEW.organization_id<>OLD.organization_id) AND EXISTS(
 SELECT 1 FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
 WHERE o.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)<>'pfp_' AND s.seat_limit IS NOT NULL
 AND (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL AND m.membership_id<>OLD.membership_id)>=s.seat_limit
) BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;
--> statement-breakpoint
DROP TRIGGER organization_invitations_plan_insert_guard;
--> statement-breakpoint
CREATE TRIGGER organization_invitations_plan_insert_guard BEFORE INSERT ON organization_invitations
WHEN NEW.revoked_at IS NULL AND NEW.accepted_at IS NULL AND EXISTS(
 SELECT 1 FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
 WHERE o.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)<>'pfp_' AND s.seat_limit IS NOT NULL AND (
 (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL)
 +(SELECT COUNT(*) FROM organization_invitations i WHERE i.organization_id=NEW.organization_id AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>=NEW.created_at)
 )>=s.seat_limit
) BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_member_insert_guard BEFORE INSERT ON organization_members
WHEN NEW.revoked_at IS NULL AND EXISTS(SELECT 1 FROM organizations o WHERE o.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)='pfp_')
 -- A provisioning replay which leaves the exact active membership unchanged
 -- is not another admission. Any ON CONFLICT UPDATE is still guarded below.
 AND NOT EXISTS(SELECT 1 FROM organization_members m
  WHERE m.membership_id=NEW.membership_id AND m.organization_id=NEW.organization_id
  AND m.user_id=NEW.user_id AND m.email IS NEW.email AND m.display_name IS NEW.display_name
  AND m.role=NEW.role AND m.joined_at=NEW.joined_at AND m.revoked_at IS NULL)
 AND NOT (NEW.role='owner' AND EXISTS(SELECT 1 FROM organizations o WHERE o.organization_id=NEW.organization_id AND o.created_by_user_id=NEW.user_id)
 AND NOT EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=NEW.organization_id)) AND NOT EXISTS(SELECT 1 FROM prepaid_current_company_rights r WHERE r.organization_id=NEW.organization_id
 AND (NEW.role<>'owner' OR NEW.user_id=r.owner_id) AND (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL)
  +(SELECT COUNT(*) FROM organization_invitations i WHERE i.organization_id=NEW.organization_id AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>=unixepoch())<r.seat_limit)
BEGIN SELECT RAISE(ABORT,'zentra prepaid member access unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_member_update_guard BEFORE UPDATE OF revoked_at,organization_id,user_id,role,joined_at ON organization_members
WHEN NEW.revoked_at IS NULL AND EXISTS(SELECT 1 FROM organizations o WHERE o.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)='pfp_')
 -- Removing the owner's role can only remove company rights, never grant them.
 AND NOT (OLD.role='owner' AND NEW.role<>'owner' AND OLD.revoked_at IS NULL
  AND NEW.organization_id=OLD.organization_id AND NEW.user_id=OLD.user_id
  AND NEW.membership_id=OLD.membership_id AND NEW.joined_at=OLD.joined_at)
 AND NOT EXISTS(SELECT 1 FROM prepaid_current_company_rights r WHERE r.organization_id=NEW.organization_id
 AND (NEW.role<>'owner' OR NEW.user_id=r.owner_id) AND (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL AND m.membership_id<>OLD.membership_id)
  +(SELECT COUNT(*) FROM organization_invitations i WHERE i.organization_id=NEW.organization_id AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>=unixepoch())<r.seat_limit)
BEGIN SELECT RAISE(ABORT,'zentra prepaid member access unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_invitation_insert_guard BEFORE INSERT ON organization_invitations
WHEN NEW.revoked_at IS NULL AND NEW.accepted_at IS NULL AND NEW.expires_at>=unixepoch() AND EXISTS(SELECT 1 FROM organizations o WHERE o.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)='pfp_')
 AND NOT EXISTS(SELECT 1 FROM prepaid_current_company_rights r WHERE r.organization_id=NEW.organization_id
 AND NEW.role<>'owner' AND (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL)
  +(SELECT COUNT(*) FROM organization_invitations i WHERE i.organization_id=NEW.organization_id AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>=unixepoch())<r.seat_limit)
BEGIN SELECT RAISE(ABORT,'zentra prepaid invitation access unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_invitation_update_guard BEFORE UPDATE OF revoked_at,accepted_at,organization_id,expires_at,role ON organization_invitations
WHEN NEW.revoked_at IS NULL AND NEW.accepted_at IS NULL AND NEW.expires_at>=unixepoch() AND EXISTS(SELECT 1 FROM organizations o WHERE o.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)='pfp_')
 AND NOT EXISTS(SELECT 1 FROM prepaid_current_company_rights r WHERE r.organization_id=NEW.organization_id
 AND NEW.role<>'owner' AND (
 (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL)
 +(SELECT COUNT(*) FROM organization_invitations i WHERE i.organization_id=NEW.organization_id AND i.invitation_id<>OLD.invitation_id AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>=unixepoch())
 )<r.seat_limit)
BEGIN SELECT RAISE(ABORT,'zentra prepaid invitation access unavailable'); END;
--> statement-breakpoint
DROP TRIGGER complete_invitation_capacity_guard;
--> statement-breakpoint
CREATE TRIGGER complete_invitation_capacity_guard BEFORE INSERT ON organization_invitations
WHEN NOT EXISTS(SELECT 1 FROM organizations o WHERE o.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)='pfp_') AND NEW.revoked_at IS NULL AND NEW.accepted_at IS NULL AND NEW.expires_at>=unixepoch() AND EXISTS (
 SELECT 1 FROM complete_plan_changes c WHERE c.organization_id=NEW.organization_id AND c.state IN ('preparing','scheduled') AND
 (SELECT COUNT(*) FROM organization_members WHERE organization_id=NEW.organization_id AND revoked_at IS NULL)
 + (SELECT COUNT(*) FROM organization_invitations WHERE organization_id=NEW.organization_id AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>=unixepoch())
 >= CASE c.target_plan WHEN 'solo' THEN 1 WHEN 'team' THEN 3 WHEN 'pro' THEN 10 ELSE 0 END
) BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;
--> statement-breakpoint
DROP TRIGGER complete_member_capacity_guard;
--> statement-breakpoint
CREATE TRIGGER complete_member_capacity_guard BEFORE INSERT ON organization_members
WHEN NOT EXISTS(SELECT 1 FROM organizations o WHERE o.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)='pfp_') AND NEW.revoked_at IS NULL AND EXISTS (
 SELECT 1 FROM complete_plan_changes c WHERE c.organization_id=NEW.organization_id AND c.state IN ('preparing','scheduled') AND
 (SELECT COUNT(*) FROM organization_members WHERE organization_id=NEW.organization_id AND revoked_at IS NULL)
 + (SELECT COUNT(*) FROM organization_invitations WHERE organization_id=NEW.organization_id AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>=unixepoch())
 >= CASE c.target_plan WHEN 'solo' THEN 1 WHEN 'team' THEN 3 WHEN 'pro' THEN 10 ELSE 0 END
) BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;
--> statement-breakpoint
DROP TRIGGER complete_member_reactivate_guard;
--> statement-breakpoint
CREATE TRIGGER complete_member_reactivate_guard BEFORE UPDATE OF revoked_at,organization_id ON organization_members
WHEN NOT EXISTS(SELECT 1 FROM organizations o WHERE o.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)='pfp_') AND NEW.revoked_at IS NULL AND (OLD.revoked_at IS NOT NULL OR NEW.organization_id<>OLD.organization_id) AND EXISTS (
 SELECT 1 FROM complete_plan_changes c WHERE c.organization_id=NEW.organization_id AND c.state IN ('preparing','scheduled') AND
 (SELECT COUNT(*) FROM organization_members WHERE organization_id=NEW.organization_id AND revoked_at IS NULL AND membership_id<>OLD.membership_id)
 + (SELECT COUNT(*) FROM organization_invitations WHERE organization_id=NEW.organization_id AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>=unixepoch())
 >= CASE c.target_plan WHEN 'solo' THEN 1 WHEN 'team' THEN 3 WHEN 'pro' THEN 10 ELSE 0 END
) BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;
--> statement-breakpoint
DROP TRIGGER device_sessions_member_seat_insert_guard;
--> statement-breakpoint
CREATE TRIGGER device_sessions_member_seat_insert_guard
BEFORE INSERT ON device_sessions
WHEN NEW.revoked_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM (
    SELECT m.user_id,s.seat_limit,s.entitlement_valid_until,
      ROW_NUMBER() OVER (ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END,m.joined_at,m.membership_id) AS seat
    FROM organization_members m
    JOIN organizations o ON o.organization_id=m.organization_id
    JOIN subscriptions s ON s.subscription_id=o.subscription_id
    WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL AND substr(o.subscription_id,1,4)<>'pfp_'
  ) ranked
  WHERE user_id=NEW.user_id AND entitlement_valid_until>=NEW.created_at
    AND (seat_limit IS NULL OR seat<=seat_limit)
) AND NOT EXISTS (
  SELECT 1 FROM founder_access_grants g
  JOIN organizations o ON o.organization_id=g.organization_id AND o.created_by_user_id=g.user_id
  JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=g.user_id
  WHERE g.organization_id=NEW.organization_id AND g.user_id=NEW.user_id AND substr(o.subscription_id,1,4)<>'pfp_'
    AND g.revoked_at IS NULL AND g.valid_until>NEW.created_at
    AND m.revoked_at IS NULL AND m.role='owner'
)
AND NOT EXISTS (
 SELECT 1 FROM complete_plan_changes c JOIN organizations o ON o.organization_id=c.organization_id AND o.created_by_user_id=c.user_id
 JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=NEW.user_id AND m.revoked_at IS NULL
 WHERE c.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)<>'pfp_' AND substr(c.subscription_id,1,4)<>'pfp_' AND c.state='scheduled' AND c.effective_at>NEW.created_at
 AND (SELECT COUNT(*) FROM organization_members m2 WHERE m2.organization_id=c.organization_id AND m2.revoked_at IS NULL)<=json_extract(c.source_json,'$.seats')
 AND NOT EXISTS (
  SELECT 1 FROM json_each(c.source_json,'$.sources') j
  LEFT JOIN (
   SELECT subscription_id,customer_id,last_paid_invoice_id,entitlement_valid_until AS until,status,livemode,'gestion' AS kind FROM subscriptions
   UNION ALL SELECT subscription_id,customer_id,last_paid_invoice_id,paid_until,status,livemode,'support' FROM support_subscriptions
   UNION ALL SELECT subscription_id,customer_id,last_paid_invoice_id,paid_until,status,livemode,'automation' FROM automation_subscriptions
  ) s ON s.subscription_id=json_extract(j.value,'$.id') AND s.kind=json_extract(j.value,'$.kind')
  WHERE substr(json_extract(j.value,'$.id'),1,4)='pfp_' OR s.subscription_id IS NULL OR s.customer_id<>json_extract(j.value,'$.customer') OR s.last_paid_invoice_id IS NOT json_extract(j.value,'$.invoice') OR s.until<=0 OR s.livemode<>json_extract(c.source_json,'$.live') OR (s.subscription_id=c.subscription_id AND s.status='canceled')
 )
)
AND NOT EXISTS(SELECT 1 FROM prepaid_current_company_rights r JOIN (
 SELECT m.organization_id,m.user_id,ROW_NUMBER() OVER(PARTITION BY m.organization_id ORDER BY CASE WHEN m.role='owner' AND m.user_id=o.created_by_user_id THEN 0 ELSE 1 END,m.joined_at,m.membership_id) AS seat
 FROM organization_members m JOIN organizations o ON o.organization_id=m.organization_id WHERE m.revoked_at IS NULL
 ) ranked ON ranked.organization_id=r.organization_id AND ranked.user_id=NEW.user_id
 WHERE r.organization_id=NEW.organization_id AND ranked.seat<=r.seat_limit
 AND NEW.created_at>=r.starts_at AND NEW.created_at<r.ends_at)
BEGIN SELECT RAISE(ABORT,'zentra account access revoked'); END;
--> statement-breakpoint
-- PFP sessions cannot bypass the insert boundary by reactivating, rebinding or extending an old row.
CREATE TRIGGER prepaid_device_session_update_guard
 BEFORE UPDATE OF revoked_at,organization_id,user_id,created_at,expires_at ON device_sessions
 WHEN NEW.revoked_at IS NULL AND EXISTS(SELECT 1 FROM organizations o WHERE o.organization_id=NEW.organization_id AND substr(o.subscription_id,1,4)='pfp_')
 AND (OLD.revoked_at IS NOT NULL OR NEW.organization_id<>OLD.organization_id OR NEW.user_id<>OLD.user_id OR NEW.created_at<>OLD.created_at OR NEW.expires_at>OLD.expires_at)
 AND NOT EXISTS(SELECT 1 FROM prepaid_current_company_rights r JOIN (
 SELECT m.organization_id,m.user_id,ROW_NUMBER() OVER(PARTITION BY m.organization_id ORDER BY CASE WHEN m.role='owner' AND m.user_id=o.created_by_user_id THEN 0 ELSE 1 END,m.joined_at,m.membership_id) AS seat
 FROM organization_members m JOIN organizations o ON o.organization_id=m.organization_id WHERE m.revoked_at IS NULL
 ) ranked ON ranked.organization_id=r.organization_id AND ranked.user_id=NEW.user_id
 WHERE r.organization_id=NEW.organization_id AND ranked.seat<=r.seat_limit
 AND NEW.created_at>=r.starts_at AND NEW.created_at<r.ends_at)
 BEGIN SELECT RAISE(ABORT,'zentra account access revoked'); END;
