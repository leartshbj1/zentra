CREATE TABLE `business_sync_transaction_changes` (
	`transaction_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`capture_generation` text NOT NULL,
	`sequence` text NOT NULL,
	`part_index` integer NOT NULL,
	`change_index` integer NOT NULL,
	`table_name` text NOT NULL,
	`row_key_json` text NOT NULL,
	`operation` text NOT NULL,
	`before_sha256` text,
	`after_sha256` text,
	`source_rowid` text NOT NULL,
	`files_json` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_transaction_sequence` ON `business_sync_transaction_changes` (`organization_id`,`installation_id`,`capture_generation`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_transaction_change_index` ON `business_sync_transaction_changes` (`transaction_id`,`part_index`,`change_index`);--> statement-breakpoint
CREATE INDEX `business_sync_transaction_row_chain` ON `business_sync_transaction_changes` (`transaction_id`,`table_name`,`row_key_json`);--> statement-breakpoint
CREATE TABLE `business_sync_transaction_parts` (
	`transaction_id` text NOT NULL,
	`part_index` integer NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`change_count` integer NOT NULL,
	`first_sequence` text NOT NULL,
	`last_sequence` text NOT NULL,
	`object_key` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_transaction_part_identity` ON `business_sync_transaction_parts` (`transaction_id`,`part_index`);