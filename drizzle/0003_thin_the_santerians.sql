CREATE TABLE `stripe_webhook_proofs` (
	`endpoint_id` text PRIMARY KEY NOT NULL,
	`secret_sha256` text NOT NULL,
	`livemode` integer NOT NULL,
	`api_version` text NOT NULL,
	`last_verified_event_id` text NOT NULL,
	`verified_at` integer NOT NULL
);
