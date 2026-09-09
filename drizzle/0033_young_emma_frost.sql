CREATE TABLE `business_sync_transaction_delivery_parts` (
	`transfer_id` text NOT NULL,
	`attempt` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`algorithm_version` integer NOT NULL,
	`part_index` integer NOT NULL,
	`source_sha256` text NOT NULL,
	`positions_sha256` text NOT NULL,
	`positions_bytes` integer NOT NULL,
	`change_count` integer NOT NULL,
	`object_key` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_transaction_delivery_part` ON `business_sync_transaction_delivery_parts` (`transfer_id`,`attempt`,`part_index`);