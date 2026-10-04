CREATE TABLE `supplier_capture_analyses` (
	`workspace_id` text NOT NULL,
	`source_sha256` text NOT NULL,
	`organization_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`owner_token` text NOT NULL,
	`owner_until` integer NOT NULL,
	`state` text NOT NULL,
	`reservation` text,
	`extraction` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_capture_identity` ON `supplier_capture_analyses` (`workspace_id`,`source_sha256`);