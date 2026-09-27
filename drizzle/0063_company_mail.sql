CREATE TABLE `company_mail_connections` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provider` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`from_email` text NOT NULL,
	`from_name` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`connected_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `company_mail_submissions` (
	`organization_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`connection_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`entity` text NOT NULL,
	`document_id` text NOT NULL,
	`recipient` text NOT NULL,
	`subject` text NOT NULL,
	`from_email` text NOT NULL,
	`attachment_hash` text NOT NULL,
	`state` text NOT NULL,
	`draft_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `request_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `company_mail_document_idx` ON `company_mail_submissions` (`organization_id`,`entity`,`document_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `company_mail_rate_idx` ON `company_mail_submissions` (`organization_id`,`created_at`);