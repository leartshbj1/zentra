CREATE TABLE `supplier_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`message_id` text NOT NULL,
	`source_sha256` text NOT NULL,
	`file_name` text NOT NULL,
	`media_type` text NOT NULL,
	`object_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sender` text NOT NULL,
	`subject` text NOT NULL,
	`extraction` text NOT NULL,
	`state` text DEFAULT 'review' NOT NULL,
	`claimed_installation` text,
	`claim_token` text,
	`invoice_id` text,
	`automatic` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`imported_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_inbox_document` ON `supplier_inbox` (`organization_id`,`source_sha256`);--> statement-breakpoint
CREATE INDEX `supplier_inbox_org_state` ON `supplier_inbox` (`organization_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `supplier_inbox_message` ON `supplier_inbox` (`connection_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `supplier_mail_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_gestion_links` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`auto_post` integer DEFAULT 0 NOT NULL,
	`connected_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_gestion_organization` ON `support_gestion_links` (`organization_id`);