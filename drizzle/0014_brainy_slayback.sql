CREATE TABLE `business_sync_file_blobs` (
	`transfer_id` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`verified_at` text,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_file_blob_identity` ON `business_sync_file_blobs` (`transfer_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `business_sync_file_entries` (
	`transfer_id` text NOT NULL,
	`path_key` text NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`page_index` integer NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_file_path_identity` ON `business_sync_file_entries` (`transfer_id`,`path_key`);--> statement-breakpoint
CREATE TABLE `business_sync_file_pages` (
	`transfer_id` text NOT NULL,
	`page_index` integer NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`file_count` integer NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_file_page_identity` ON `business_sync_file_pages` (`transfer_id`,`page_index`);--> statement-breakpoint
CREATE TABLE `business_sync_file_parts` (
	`transfer_id` text NOT NULL,
	`file_sha256` text NOT NULL,
	`part_index` integer NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`object_key` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_file_part_identity` ON `business_sync_file_parts` (`transfer_id`,`file_sha256`,`part_index`);--> statement-breakpoint
CREATE TABLE `business_sync_file_sets` (
	`transfer_id` text PRIMARY KEY NOT NULL,
	`manifest_json` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
