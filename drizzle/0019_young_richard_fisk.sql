CREATE TABLE `business_sync_number_floors` (
	`organization_id` text NOT NULL,
	`prefix` text NOT NULL,
	`year` integer NOT NULL,
	`minimum` integer NOT NULL,
	`bootstrap_transfer_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bootstrap_transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_number_floor_identity` ON `business_sync_number_floors` (`organization_id`,`prefix`,`year`);