CREATE TABLE `business_sync_row_order` (
	`transfer_id` text NOT NULL,
	`table_name` text NOT NULL,
	`row_key_json` text NOT NULL,
	`source_rowid` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_source_order_key` ON `business_sync_row_order` (`transfer_id`,`table_name`,`row_key_json`);--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_source_order_position` ON `business_sync_row_order` (`transfer_id`,`table_name`,`source_rowid`);