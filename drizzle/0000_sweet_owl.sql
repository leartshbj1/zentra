CREATE TABLE `checkout_attempts` (
	`claim_hash` text PRIMARY KEY NOT NULL,
	`checkout_session_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_attempts_session_idx` ON `checkout_attempts` (`checkout_session_id`);--> statement-breakpoint
CREATE INDEX `checkout_attempts_expiry_idx` ON `checkout_attempts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `checkout_rate_limits` (
	`rate_key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`window_started_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `checkout_rate_limits_expiry_idx` ON `checkout_rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `license_activations` (
	`license_id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`activated_at` integer NOT NULL,
	`last_issued_at` integer NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`subscription_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `license_activations_subscription_installation_idx` ON `license_activations` (`subscription_id`,`installation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `license_activations_one_device_idx` ON `license_activations` (`subscription_id`);--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`livemode` integer NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE INDEX `stripe_events_processed_idx` ON `stripe_events` (`processed_at`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`subscription_id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`checkout_session_id` text,
	`customer_email` text,
	`customer_name` text,
	`price_id` text NOT NULL,
	`status` text NOT NULL,
	`current_period_end` integer NOT NULL,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`livemode` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_checkout_session_idx` ON `subscriptions` (`checkout_session_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_customer_idx` ON `subscriptions` (`customer_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_status_idx` ON `subscriptions` (`status`,`current_period_end`);