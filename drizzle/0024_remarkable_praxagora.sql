CREATE TABLE `business_sync_transaction_validations` (
	`transfer_id` text PRIMARY KEY NOT NULL,
	`attempt` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`phase` text NOT NULL,
	`table_counts_json` text NOT NULL,
	`next_structural_rule` integer DEFAULT 0 NOT NULL,
	`next_accounting_rule` integer DEFAULT 0 NOT NULL,
	`failed_rule` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
