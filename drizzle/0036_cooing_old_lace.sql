CREATE TABLE `business_sync_retirement_cancellations` (
	`resolution_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`generation` text NOT NULL,
	`capture_generation` text NOT NULL,
	`first_sequence` text NOT NULL,
	`last_sequence` text NOT NULL,
	`base_revision` integer NOT NULL,
	`binding_json` text NOT NULL,
	`binding_sha256` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
