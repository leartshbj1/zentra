CREATE TABLE `founder_support_events` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`action_hash` text NOT NULL,
	`operation` text NOT NULL,
	`valid_until` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `founder_support_grants` (
	`email` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`user_id` text,
	`workspace_id` text,
	`plan_id` text NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_until` integer NOT NULL,
	`revoked_at` integer,
	`revision` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_operation_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_support_grants_grant_id_unique` ON `founder_support_grants` (`grant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `founder_support_grants_user_id_unique` ON `founder_support_grants` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `founder_support_grants_workspace_id_unique` ON `founder_support_grants` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `founder_support_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`ticket_id` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `founder_support_usage_period` ON `founder_support_usage` (`workspace_id`,`period_start`,`state`);
--> statement-breakpoint
CREATE TRIGGER founder_support_identity_guard BEFORE UPDATE ON founder_support_grants
WHEN (OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id)
  OR (OLD.workspace_id IS NOT NULL AND NEW.workspace_id IS NOT OLD.workspace_id)
  OR NEW.email<>OLD.email OR NEW.grant_id<>OLD.grant_id OR NEW.valid_from<>OLD.valid_from
BEGIN SELECT RAISE(ABORT,'founder support identity is immutable'); END;
