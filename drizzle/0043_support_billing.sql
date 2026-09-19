CREATE TABLE `support_analysis_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`ticket_id` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `support_usage_period` ON `support_analysis_usage` (`workspace_id`,`period_start`,`state`);--> statement-breakpoint
CREATE TABLE `support_billing_config` (
	`id` text PRIMARY KEY NOT NULL,
	`configuration` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_checkouts` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`plan_id` text NOT NULL,
	`session_id` text,
	`session_url` text,
	`expires_at` integer NOT NULL,
	`owner_id` text NOT NULL,
	`accepted_version` text NOT NULL,
	`accepted_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `support_subscriptions` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`status` text NOT NULL,
	`paid_from` integer DEFAULT 0 NOT NULL,
	`paid_until` integer DEFAULT 0 NOT NULL,
	`paid_plan_id` text,
	`last_paid_invoice_id` text,
	`cancel_at_period_end` integer DEFAULT 0 NOT NULL,
	`livemode` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_subscriptions_subscription_id_unique` ON `support_subscriptions` (`subscription_id`);