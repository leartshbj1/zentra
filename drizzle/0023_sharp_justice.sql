CREATE TABLE `business_sync_audit_branches` (
	`organization_id` text NOT NULL,
	`generation` text NOT NULL,
	`installation_id` text NOT NULL,
	`capture_generation` text NOT NULL,
	`last_hash` text,
	`last_sequence` text NOT NULL,
	`revision` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_audit_branch_identity` ON `business_sync_audit_branches` (`organization_id`,`generation`,`installation_id`,`capture_generation`);--> statement-breakpoint
CREATE TABLE `business_sync_candidate_order` (
	`transfer_id` text NOT NULL,
	`table_name` text NOT NULL,
	`last_value` integer NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_candidate_order_identity` ON `business_sync_candidate_order` (`transfer_id`,`table_name`);--> statement-breakpoint
CREATE TABLE `business_sync_transaction_conflicts` (
	`transfer_id` text NOT NULL,
	`attempt` text NOT NULL,
	`table_name` text NOT NULL,
	`row_key_json` text NOT NULL,
	`part_index` integer NOT NULL,
	`change_index` integer NOT NULL,
	`expected_sha256` text,
	`current_sha256` text,
	`incoming_sha256` text,
	`reason` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_transaction_conflict_identity` ON `business_sync_transaction_conflicts` (`transfer_id`,`attempt`,`table_name`,`row_key_json`);--> statement-breakpoint
CREATE TABLE `business_sync_transaction_reviews` (
	`transfer_id` text PRIMARY KEY NOT NULL,
	`attempt` text NOT NULL,
	`generation` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`source_transfer_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`state` text NOT NULL,
	`last_table` text DEFAULT '' NOT NULL,
	`last_key` text DEFAULT '' NOT NULL,
	`copied_rows` integer DEFAULT 0 NOT NULL,
	`copied_bytes` integer DEFAULT 0 NOT NULL,
	`next_chunk` integer DEFAULT 0 NOT NULL,
	`applied_changes` integer DEFAULT 0 NOT NULL,
	`base_audit_hash` text,
	`last_audit_hash` text,
	`audit_entries` integer DEFAULT 0 NOT NULL,
	`failed_rule` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
