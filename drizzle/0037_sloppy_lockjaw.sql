CREATE TABLE `legal_acceptances` (
	`acceptance_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`document_version` text NOT NULL,
	`context` text NOT NULL,
	`plan_id` text NOT NULL,
	`checkout_session_id` text NOT NULL,
	`origin` text NOT NULL,
	`accepted_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legal_acceptance_checkout` ON `legal_acceptances` (`checkout_session_id`);--> statement-breakpoint
CREATE INDEX `legal_acceptance_user_date` ON `legal_acceptances` (`user_id`,`accepted_at`);