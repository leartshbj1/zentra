CREATE TABLE `automation_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`feature` text NOT NULL,
	`mode` text NOT NULL,
	`context_hash` text NOT NULL,
	`options` text NOT NULL,
	`result` text,
	`confidence` real,
	`provider` text,
	`model` text,
	`policy_version` text NOT NULL,
	`error_code` text,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost` real,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`feedback` text,
	`final_choices` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_request_identity` ON `automation_decisions` (`organization_id`,`user_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `automation_org_created` ON `automation_decisions` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `automation_decision_created` ON `automation_decisions` (`created_at`);--> statement-breakpoint
CREATE TABLE `automation_platform` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `automation_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`mode` text DEFAULT 'shadow' NOT NULL,
	`flags` text DEFAULT '[]' NOT NULL,
	`medium_threshold` real DEFAULT 0.65 NOT NULL,
	`high_threshold` real DEFAULT 0.9 NOT NULL,
	`consent_version` text,
	`consent_by` text,
	`consent_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `automation_subscriptions` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text NOT NULL,
	`paid_from` integer DEFAULT 0 NOT NULL,
	`paid_until` integer DEFAULT 0 NOT NULL,
	`last_paid_invoice_id` text,
	`cancel_at_period_end` integer DEFAULT 0 NOT NULL,
	`livemode` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_subscriptions_subscription_id_unique` ON `automation_subscriptions` (`subscription_id`);--> statement-breakpoint
CREATE TABLE `referral_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`referrer_organization_id` text NOT NULL,
	`referred_user_id` text NOT NULL,
	`referred_organization_id` text,
	`checkout_session_id` text,
	`subscription_id` text,
	`state` text NOT NULL,
	`first_invoice_id` text,
	`reward_coupon_id` text,
	`reward_subscription_id` text,
	`reward_applied_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`referrer_organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`referred_organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referral_claims_referred_user_id_unique` ON `referral_claims` (`referred_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `referral_claims_referred_organization_id_unique` ON `referral_claims` (`referred_organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `referral_claims_checkout_session_id_unique` ON `referral_claims` (`checkout_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `referral_claims_subscription_id_unique` ON `referral_claims` (`subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `referral_claims_first_invoice_id_unique` ON `referral_claims` (`first_invoice_id`);--> statement-breakpoint
CREATE INDEX `referral_referrer_state` ON `referral_claims` (`referrer_organization_id`,`state`);--> statement-breakpoint
CREATE TABLE `referral_codes` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referral_codes_code_unique` ON `referral_codes` (`code`);