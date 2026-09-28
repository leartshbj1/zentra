CREATE TABLE `support_solicitation_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`intent` text NOT NULL,
	`state` text NOT NULL,
	`recipient` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`payload_hash` text DEFAULT '' NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_solicitation_once` ON `support_solicitation_replies` (`ticket_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `support_solicitation_workspace` ON `support_solicitation_replies` (`workspace_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `support_workspaces` ADD `solicitation_notifications` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `support_workspaces` ADD `solicitation_settings_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `support_workspaces` ADD `replies_enabled` integer DEFAULT 0 NOT NULL;