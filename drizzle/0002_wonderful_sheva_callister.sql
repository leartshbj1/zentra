ALTER TABLE `stripe_events` ADD `event_created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `stripe_events` ADD `processing_started_at` integer;--> statement-breakpoint
ALTER TABLE `stripe_events` ADD `processing_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `stripe_events_processing_idx` ON `stripe_events` (`processing_started_at`);