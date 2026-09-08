CREATE TABLE `business_sync_transaction_accounting_states` (
	`transfer_id` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`table_name` text NOT NULL,
	`row_key_json` text NOT NULL,
	`row_json` text,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_transaction_accounting_state` ON `business_sync_transaction_accounting_states` (`transfer_id`,`validator_sha256`,`table_name`,`row_key_json`);