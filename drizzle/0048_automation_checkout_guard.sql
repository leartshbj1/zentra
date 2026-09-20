CREATE TABLE `automation_checkouts` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`session_id` text,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_checkouts_session_id_unique` ON `automation_checkouts` (`session_id`);