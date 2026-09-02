CREATE TABLE `device_authorizations` (
	`device_code_hash` text PRIMARY KEY NOT NULL,
	`user_code` text NOT NULL,
	`installation_id` text NOT NULL,
	`status` text NOT NULL,
	`organization_id` text,
	`approved_by_user_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_at` integer,
	`consumed_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_authorizations_user_code_idx` ON `device_authorizations` (`user_code`);--> statement-breakpoint
CREATE INDEX `device_authorizations_expiry_idx` ON `device_authorizations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `device_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_sessions_token_idx` ON `device_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `device_sessions_organization_idx` ON `device_sessions` (`organization_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `device_sessions_user_idx` ON `device_sessions` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `invoice_archives` (
	`archive_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`source_invoice_id` text NOT NULL,
	`revision` integer NOT NULL,
	`invoice_number` text NOT NULL,
	`issue_date` text NOT NULL,
	`paid_at` text,
	`correction_kind` text NOT NULL,
	`correction_reason` text,
	`supersedes_archive_id` text,
	`object_key` text NOT NULL,
	`content_sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`media_type` text NOT NULL,
	`previous_chain_sha256` text,
	`chain_sha256` text NOT NULL,
	`retention_until` text NOT NULL,
	`stored_by_session_id` text NOT NULL,
	`stored_at` integer NOT NULL,
	`storage_status` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_archives_revision_idx` ON `invoice_archives` (`organization_id`,`source_invoice_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_archives_object_idx` ON `invoice_archives` (`object_key`);--> statement-breakpoint
CREATE INDEX `invoice_archives_number_idx` ON `invoice_archives` (`organization_id`,`invoice_number`);--> statement-breakpoint
CREATE INDEX `invoice_archives_retention_idx` ON `invoice_archives` (`retention_until`);--> statement-breakpoint
CREATE TABLE `organization_invitations` (
	`invitation_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_email` text,
	`role` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_by_user_id` text,
	`accepted_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitations_token_idx` ON `organization_invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `organization_invitations_expiry_idx` ON `organization_invitations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `organization_members` (
	`membership_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`role` text NOT NULL,
	`joined_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_members_user_idx` ON `organization_members` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `organization_members_email_idx` ON `organization_members` (`email`);--> statement-breakpoint
CREATE INDEX `organization_members_active_idx` ON `organization_members` (`organization_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`subscription_id` text NOT NULL,
	`seat_limit` integer DEFAULT 5 NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`subscription_id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_subscription_idx` ON `organizations` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `organizations_creator_idx` ON `organizations` (`created_by_user_id`);