ALTER TABLE `subscriptions` ADD `entitlement_valid_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `last_paid_invoice_id` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `last_paid_at` integer;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `last_payment_failure_invoice_id` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `last_payment_failure_at` integer;