CREATE TABLE `founder_access_events` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`action_hash` text NOT NULL,
	`operation` text NOT NULL,
	`valid_until` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `founder_access_grants` (
	`email` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`user_id` text,
	`organization_id` text,
	`valid_until` integer NOT NULL,
	`revoked_at` integer,
	`revision` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_operation_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_access_grants_grant_id_unique` ON `founder_access_grants` (`grant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `founder_access_grants_user_id_unique` ON `founder_access_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `founder_grants_organization_idx` ON `founder_access_grants` (`organization_id`);--> statement-breakpoint
CREATE TABLE `founder_account_identities` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`provider` text NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `founder_identities_email_idx` ON `founder_account_identities` (`email`);--> statement-breakpoint
CREATE TABLE `founder_admin_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `founder_nonces_expiry_idx` ON `founder_admin_nonces` (`expires_at`);
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
BEGIN SELECT RAISE(ABORT,'zentra account access revoked'); END;
--> statement-breakpoint
CREATE TRIGGER founder_access_identity_guard BEFORE UPDATE ON founder_access_grants
WHEN (OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id)
  OR (OLD.organization_id IS NOT NULL AND NEW.organization_id IS NOT OLD.organization_id)
  OR NEW.email<>OLD.email OR NEW.grant_id<>OLD.grant_id
BEGIN SELECT RAISE(ABORT,'founder access identity is immutable'); END;
