CREATE TABLE `complete_checkouts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`plan_id` text NOT NULL,
	`parameters` text NOT NULL,
	`expires_at` integer NOT NULL,
	`session_id` text,
	`session_url` text
);
--> statement-breakpoint
CREATE TABLE `complete_refunds` (
	`invoice_id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`livemode` integer NOT NULL,
	`verified_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `complete_subscriptions` (
	`subscription_id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`paid_plan_id` text,
	`paid_from` integer DEFAULT 0 NOT NULL,
	`paid_until` integer DEFAULT 0 NOT NULL,
	`last_paid_invoice_id` text
);
