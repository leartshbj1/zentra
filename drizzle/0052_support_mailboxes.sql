CREATE TABLE `support_mailboxes` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`since_at` integer NOT NULL,
	`scan_offset` integer DEFAULT 0 NOT NULL,
	`next_sync_at` integer DEFAULT 0 NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`lease` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `support_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_mailboxes_identity` ON `support_mailboxes` (`workspace_id`,`email`);--> statement-breakpoint
CREATE INDEX `support_mailboxes_due` ON `support_mailboxes` (`next_sync_at`,`lease_until`);