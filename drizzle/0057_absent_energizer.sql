CREATE TABLE `automation_appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`source_key` text NOT NULL,
	`source_hash` text NOT NULL,
	`subject` text NOT NULL,
	`sender` text NOT NULL,
	`extraction` text NOT NULL,
	`state` text DEFAULT 'review' NOT NULL,
	`claimed_installation` text,
	`claim_token` text,
	`automatic` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`imported_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_appointments_source` ON `automation_appointments` (`organization_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `automation_appointments_pending` ON `automation_appointments` (`organization_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `automation_supplier_habits` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`sender` text NOT NULL,
	`supplier_name` text NOT NULL,
	`supplier_id` text NOT NULL,
	`category` text NOT NULL,
	`account_id` text,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_supplier_habits_source` ON `automation_supplier_habits` (`organization_id`,`sender`,`supplier_name`);--> statement-breakpoint
