CREATE TABLE `support_followups` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`assigned_to` text NOT NULL,
	`due_at` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`organization_id` text,
	`task_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_followup_source` ON `support_followups` (`ticket_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `support_followup_due` ON `support_followups` (`workspace_id`,`state`,`due_at`);--> statement-breakpoint
CREATE TABLE `support_sender_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`sender` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`category` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_sender_policy_identity` ON `support_sender_policies` (`workspace_id`,`sender`,`subject`);--> statement-breakpoint
CREATE INDEX `support_sender_policy_workspace` ON `support_sender_policies` (`workspace_id`,`enabled`);--> statement-breakpoint
ALTER TABLE `support_connections` ADD `checked_at` integer;--> statement-breakpoint
ALTER TABLE `support_connections` ADD `check_error` text;