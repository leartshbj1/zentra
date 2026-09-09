CREATE TABLE `business_sync_transaction_fingerprints` (
	`transfer_id` text PRIMARY KEY NOT NULL,
	`attempt` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`algorithm_version` integer NOT NULL,
	`fingerprint_contract_sha256` text NOT NULL,
	`phase` text NOT NULL,
	`last_table` text DEFAULT '' NOT NULL,
	`last_key` text DEFAULT '' NOT NULL,
	`rows` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`sha256` text NOT NULL,
	`source_sha256` text,
	`source_rows` integer,
	`source_bytes` integer,
	`target_sha256` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
