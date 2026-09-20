CREATE TABLE `founder_automation_events` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`action_hash` text NOT NULL,
	`operation` text NOT NULL,
	`valid_until` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `founder_automation_grants` (
	`email` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`user_id` text,
	`organization_id` text,
	`valid_from` integer NOT NULL,
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
CREATE UNIQUE INDEX `founder_automation_grants_grant_id_unique` ON `founder_automation_grants` (`grant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `founder_automation_grants_user_id_unique` ON `founder_automation_grants` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `founder_automation_grants_organization_id_unique` ON `founder_automation_grants` (`organization_id`);
--> statement-breakpoint
CREATE TRIGGER founder_automation_identity_guard BEFORE UPDATE ON founder_automation_grants
WHEN (OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id)
 OR (OLD.organization_id IS NOT NULL AND NEW.organization_id IS NOT OLD.organization_id)
 OR NEW.email<>OLD.email OR NEW.grant_id<>OLD.grant_id OR NEW.valid_from<>OLD.valid_from
BEGIN SELECT RAISE(ABORT,'founder automation identity is immutable'); END;
