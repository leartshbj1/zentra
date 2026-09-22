CREATE TABLE `automation_refunds` (
	`invoice_id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`livemode` integer NOT NULL,
	`verified_at` integer NOT NULL
);
