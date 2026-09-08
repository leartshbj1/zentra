CREATE TABLE `business_sync_credit_lines` (
	`transfer_id` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`document_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`gross` integer NOT NULL,
	`vat` integer NOT NULL,
	`remaining` integer NOT NULL,
	`released` integer DEFAULT 0 NOT NULL,
	`proposed_gross` integer,
	`proposed_vat` integer,
	`remainder` integer,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_credit_line_identity` ON `business_sync_credit_lines` (`transfer_id`,`validator_sha256`,`document_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `business_sync_credit_line_order` ON `business_sync_credit_lines` (`transfer_id`,`validator_sha256`,`document_id`,`position`,`item_id`);--> statement-breakpoint
CREATE TABLE `business_sync_credit_movements` (
	`transfer_id` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`document_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`created_at` text NOT NULL,
	`sequence` integer NOT NULL,
	`amount` integer NOT NULL,
	`reverses_id` text,
	`validated` integer DEFAULT 0 NOT NULL,
	`computed_vat` integer,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_credit_movement_identity` ON `business_sync_credit_movements` (`transfer_id`,`validator_sha256`,`document_id`,`movement_id`);--> statement-breakpoint
CREATE INDEX `business_sync_credit_movement_order` ON `business_sync_credit_movements` (`transfer_id`,`validator_sha256`,`document_id`,`date`,`created_at`,`sequence`,`movement_id`);--> statement-breakpoint
CREATE TABLE `business_sync_credit_projection` (
	`transfer_id` text NOT NULL,
	`validator_sha256` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`generation` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `business_sync_transfers`(`transfer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_sync_credit_projection_identity` ON `business_sync_credit_projection` (`transfer_id`,`validator_sha256`);