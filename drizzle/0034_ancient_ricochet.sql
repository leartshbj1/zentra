CREATE TABLE `business_sync_transaction_commits` (
	`transfer_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`generation` text NOT NULL,
	`source_transfer_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`revision` integer NOT NULL,
	`bundle_json` text NOT NULL,
	`bundle_sha256` text NOT NULL,
	`receipt_json` text NOT NULL,
	`receipt_sha256` text NOT NULL,
	`committed_at` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_transaction_commit_revision` ON `business_sync_transaction_commits` (`organization_id`,`revision`);