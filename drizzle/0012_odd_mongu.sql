CREATE TABLE `document_number_reservations` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organization_id` text NOT NULL,
	`request_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`created_by` text NOT NULL,
	`prefix` text NOT NULL,
	`year` integer NOT NULL,
	`minimum` integer NOT NULL,
	`count` integer NOT NULL,
	`start_value` integer NOT NULL,
	`end_value` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_number_reservations_request` ON `document_number_reservations` (`organization_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `document_number_reservations_range` ON `document_number_reservations` (`organization_id`,`prefix`,`year`,`end_value`);