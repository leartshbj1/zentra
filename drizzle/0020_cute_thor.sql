CREATE TABLE `business_sync_publications` (
	`transfer_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`generation` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`files_manifest_sha256` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`receipt_json` text NOT NULL,
	`committed_at` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
