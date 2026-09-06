ALTER TABLE `subscriptions` ADD `plan_id` text DEFAULT 'zentra-monthly-50-chf' NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `entitlement_plan_id` text DEFAULT 'zentra-monthly-50-chf' NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `seat_limit` integer;--> statement-breakpoint

-- Existing paid subscriptions keep their former terms. New plans get a limit
-- only from a verified paid invoice, never from a browser-supplied quantity.
CREATE TRIGGER organization_members_plan_insert_guard
BEFORE INSERT ON organization_members
WHEN NEW.revoked_at IS NULL AND EXISTS (
  SELECT 1 FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
  WHERE o.organization_id=NEW.organization_id AND s.seat_limit IS NOT NULL
    AND (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL)>=s.seat_limit
)
BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;--> statement-breakpoint

CREATE TRIGGER organization_members_plan_reactivate_guard
BEFORE UPDATE OF revoked_at,organization_id ON organization_members
WHEN NEW.revoked_at IS NULL AND (OLD.revoked_at IS NOT NULL OR NEW.organization_id<>OLD.organization_id)
AND EXISTS (
  SELECT 1 FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
  WHERE o.organization_id=NEW.organization_id AND s.seat_limit IS NOT NULL
    AND (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL AND m.membership_id<>OLD.membership_id)>=s.seat_limit
)
BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;--> statement-breakpoint

CREATE TRIGGER organization_invitations_plan_insert_guard
BEFORE INSERT ON organization_invitations
WHEN NEW.revoked_at IS NULL AND NEW.accepted_at IS NULL AND EXISTS (
  SELECT 1 FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id
  WHERE o.organization_id=NEW.organization_id AND s.seat_limit IS NOT NULL AND (
    (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id=NEW.organization_id AND m.revoked_at IS NULL)
    + (SELECT COUNT(*) FROM organization_invitations i WHERE i.organization_id=NEW.organization_id AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>=NEW.created_at)
  )>=s.seat_limit
)
BEGIN SELECT RAISE(ABORT,'zentra seat limit reached'); END;--> statement-breakpoint

-- An approval must still be valid when the device session is actually created.
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
)
BEGIN SELECT RAISE(ABORT,'zentra account access revoked'); END;
