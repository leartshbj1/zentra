ALTER TABLE `support_connections` ADD `refresh_lease` text;--> statement-breakpoint
ALTER TABLE `support_connections` ADD `refresh_lease_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `support_oauth_states` ADD `verifier` text NOT NULL;