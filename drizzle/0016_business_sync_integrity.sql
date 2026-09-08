CREATE TABLE `business_sync_audit_nodes` (
	`transfer_id` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`row_key` text NOT NULL,
	`entry_hash` text NOT NULL,
	`previous_hash` text,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_audit_row` ON `business_sync_audit_nodes` (`transfer_id`,`validator_sha256`,`row_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_audit_hash` ON `business_sync_audit_nodes` (`transfer_id`,`validator_sha256`,`entry_hash`);--> statement-breakpoint
CREATE INDEX `business_sync_audit_previous` ON `business_sync_audit_nodes` (`transfer_id`,`validator_sha256`,`previous_hash`);--> statement-breakpoint
CREATE TABLE `business_sync_integrity_checks` (
	`transfer_id` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`generation` text NOT NULL,
	`state` text NOT NULL,
	`last_row_key` text,
	`indexed_entries` integer DEFAULT 0 NOT NULL,
	`walked_entries` integer DEFAULT 0 NOT NULL,
	`last_hash` text,
	`failed_rule` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_integrity_identity` ON `business_sync_integrity_checks` (`transfer_id`,`validator_sha256`);