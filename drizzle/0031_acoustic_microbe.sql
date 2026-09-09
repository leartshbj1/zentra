CREATE TABLE `business_sync_transaction_canonical_order` (
	`transfer_id` text NOT NULL,
	`attempt` text NOT NULL,
	`part_index` integer NOT NULL,
	`change_index` integer NOT NULL,
	`table_name` text NOT NULL,
	`row_key_json` text NOT NULL,
	`canonical_rowid` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_transaction_canonical_position` ON `business_sync_transaction_canonical_order` (`transfer_id`,`attempt`,`part_index`,`change_index`);--> statement-breakpoint
ALTER TABLE `business_sync_transaction_reviews` ADD `algorithm_version` integer DEFAULT 1 NOT NULL;