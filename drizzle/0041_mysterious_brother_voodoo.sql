CREATE TABLE `support_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`domain` text NOT NULL,
	`login` text NOT NULL,
	`secret` text NOT NULL,
	`hook_hash` text NOT NULL,
	`directory_json` text NOT NULL,
	`routes_json` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `support_connections_workspace` ON `support_connections` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `support_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`ticket_id` text,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `support_events_workspace_time` ON `support_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `support_events_ticket_time` ON `support_events` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `support_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_member_identity` ON `support_members` (`workspace_id`,`email`);--> statement-breakpoint
CREATE TABLE `support_platform_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`external_id` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`source_json` text NOT NULL,
	`fingerprint` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`decision_json` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease` text,
	`lease_until` integer,
	`automatic` integer DEFAULT 0 NOT NULL,
	`corrected` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`routed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `support_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_ticket_external` ON `support_tickets` (`connection_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `support_ticket_inbox` ON `support_tickets` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `support_ticket_pending` ON `support_tickets` (`workspace_id`,`state`);--> statement-breakpoint
CREATE TABLE `support_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`mode` text DEFAULT 'review' NOT NULL,
	`threshold` integer DEFAULT 85 NOT NULL,
	`baseline_seconds` integer DEFAULT 60 NOT NULL,
	`ai_secret` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_workspaces_owner_id_unique` ON `support_workspaces` (`owner_id`);