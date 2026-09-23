CREATE TABLE `complete_onboarding` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`skipped_json` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `complete_plan_changes` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`target_plan` text NOT NULL,
	`effective_at` integer NOT NULL,
	`state` text NOT NULL,
	`source_json` text NOT NULL,
	`schedule_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `complete_plan_changes_operation_id_unique` ON `complete_plan_changes` (`operation_id`);--> statement-breakpoint
CREATE TABLE `complete_trials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`analyses` integer DEFAULT 250 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `complete_trials_organization_id_unique` ON `complete_trials` (`organization_id`);
--> statement-breakpoint
-- Reserve seats against the future pack as well, at the database boundary.
CREATE TRIGGER complete_change_capacity_guard BEFORE INSERT ON complete_plan_changes
WHEN (SELECT COUNT(*) FROM organization_members WHERE organization_id=NEW.organization_id AND revoked_at IS NULL)
   + (SELECT COUNT(*) FROM organization_invitations WHERE organization_id=NEW.organization_id AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>=unixepoch())
   > CASE NEW.target_plan WHEN 'solo' THEN 1 WHEN 'team' THEN 3 WHEN 'pro' THEN 10 ELSE 0 END
BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;
--> statement-breakpoint
CREATE TRIGGER complete_invitation_capacity_guard BEFORE INSERT ON organization_invitations
WHEN NEW.revoked_at IS NULL AND NEW.accepted_at IS NULL AND NEW.expires_at>=unixepoch() AND EXISTS (
 SELECT 1 FROM complete_plan_changes c WHERE c.organization_id=NEW.organization_id AND c.state IN ('preparing','scheduled') AND
 (SELECT COUNT(*) FROM organization_members WHERE organization_id=NEW.organization_id AND revoked_at IS NULL)
 + (SELECT COUNT(*) FROM organization_invitations WHERE organization_id=NEW.organization_id AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>=unixepoch())
 >= CASE c.target_plan WHEN 'solo' THEN 1 WHEN 'team' THEN 3 WHEN 'pro' THEN 10 ELSE 0 END
) BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;
--> statement-breakpoint
CREATE TRIGGER complete_member_capacity_guard BEFORE INSERT ON organization_members
WHEN NEW.revoked_at IS NULL AND EXISTS (
 SELECT 1 FROM complete_plan_changes c WHERE c.organization_id=NEW.organization_id AND c.state IN ('preparing','scheduled') AND
 (SELECT COUNT(*) FROM organization_members WHERE organization_id=NEW.organization_id AND revoked_at IS NULL)
 + (SELECT COUNT(*) FROM organization_invitations WHERE organization_id=NEW.organization_id AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>=unixepoch())
 >= CASE c.target_plan WHEN 'solo' THEN 1 WHEN 'team' THEN 3 WHEN 'pro' THEN 10 ELSE 0 END
) BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;
--> statement-breakpoint
CREATE TRIGGER complete_member_reactivate_guard BEFORE UPDATE OF revoked_at,organization_id ON organization_members
WHEN NEW.revoked_at IS NULL AND (OLD.revoked_at IS NOT NULL OR NEW.organization_id<>OLD.organization_id) AND EXISTS (
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
    WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL
  ) ranked
  WHERE user_id=NEW.user_id AND entitlement_valid_until>=NEW.created_at
    AND (seat_limit IS NULL OR seat<=seat_limit)
) AND NOT EXISTS (
  SELECT 1 FROM founder_access_grants g
  JOIN organizations o ON o.organization_id=g.organization_id AND o.created_by_user_id=g.user_id
  JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=g.user_id
  WHERE g.organization_id=NEW.organization_id AND g.user_id=NEW.user_id
    AND g.revoked_at IS NULL AND g.valid_until>NEW.created_at
    AND m.revoked_at IS NULL AND m.role='owner'
)
AND NOT EXISTS (
 SELECT 1 FROM complete_plan_changes c JOIN organizations o ON o.organization_id=c.organization_id AND o.created_by_user_id=c.user_id
 JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=NEW.user_id AND m.revoked_at IS NULL
 WHERE c.organization_id=NEW.organization_id AND c.state='scheduled' AND c.effective_at>NEW.created_at
 AND (SELECT COUNT(*) FROM organization_members m2 WHERE m2.organization_id=c.organization_id AND m2.revoked_at IS NULL)<=json_extract(c.source_json,'$.seats')
 AND NOT EXISTS (
  SELECT 1 FROM json_each(c.source_json,'$.sources') j
  LEFT JOIN (
   SELECT subscription_id,customer_id,last_paid_invoice_id,entitlement_valid_until AS until,status,livemode,'gestion' AS kind FROM subscriptions
   UNION ALL SELECT subscription_id,customer_id,last_paid_invoice_id,paid_until,status,livemode,'support' FROM support_subscriptions
   UNION ALL SELECT subscription_id,customer_id,last_paid_invoice_id,paid_until,status,livemode,'automation' FROM automation_subscriptions
  ) s ON s.subscription_id=json_extract(j.value,'$.id') AND s.kind=json_extract(j.value,'$.kind')
  WHERE s.subscription_id IS NULL OR s.customer_id<>json_extract(j.value,'$.customer') OR s.last_paid_invoice_id IS NOT json_extract(j.value,'$.invoice') OR s.until<=0 OR s.livemode<>json_extract(c.source_json,'$.live') OR (s.subscription_id=c.subscription_id AND s.status='canceled')
 )
)
BEGIN SELECT RAISE(ABORT,'zentra account access revoked'); END;
