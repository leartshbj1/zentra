CREATE TABLE `business_sync_spaces` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`bootstrap_transfer_id` text NOT NULL,
	`state` text NOT NULL,
	`head_revision` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `business_sync_transfer_chunks` (
	`transfer_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`row_count` integer NOT NULL,
	`object_key` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_chunk_identity` ON `business_sync_transfer_chunks` (`transfer_id`,`chunk_index`);--> statement-breakpoint
CREATE TABLE `business_sync_transfers` (
	`transfer_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`created_by` text NOT NULL,
	`generation` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`base_revision` integer NOT NULL,
	`revision` integer,
	`manifest_json` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	`committed_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_transfer_revision` ON `business_sync_transfers` (`organization_id`,`revision`);--> statement-breakpoint
CREATE INDEX `business_sync_transfer_org_state` ON `business_sync_transfers` (`organization_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `business_sync_versions` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transfer_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`table_name` text NOT NULL,
	`row_key_json` text NOT NULL,
	`row_json` text,
	`row_sha256` text,
	`before_sha256` text,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_transfer_row` ON `business_sync_versions` (`transfer_id`,`table_name`,`row_key_json`);--> statement-breakpoint
CREATE INDEX `business_sync_row_history` ON `business_sync_versions` (`organization_id`,`table_name`,`row_key_json`,`sequence`);