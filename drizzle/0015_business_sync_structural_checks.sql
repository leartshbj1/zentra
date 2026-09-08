CREATE TABLE `business_sync_structural_checks` (
	`transfer_id` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`generation` text NOT NULL,
	`next_rule` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`failed_rule` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_structural_identity` ON `business_sync_structural_checks` (`transfer_id`,`validator_sha256`);