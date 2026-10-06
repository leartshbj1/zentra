CREATE TABLE `postfinance_mutations` (
	`scope_hash` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`claim_token` text,
	`response_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "postfinance_mutations_state_check" CHECK("postfinance_mutations"."state" IN ('claimed','completed','uncertain')),
	CONSTRAINT "postfinance_mutations_result_check" CHECK(("postfinance_mutations"."state"='completed' AND "postfinance_mutations"."response_json" IS NOT NULL AND "postfinance_mutations"."claim_token" IS NULL) OR ("postfinance_mutations"."state" IN ('claimed','uncertain') AND "postfinance_mutations"."response_json" IS NULL AND "postfinance_mutations"."claim_token" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `postfinance_mutations_state_idx` ON `postfinance_mutations` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `postfinance_webhook_inbox` (
	`scope_hash` text PRIMARY KEY NOT NULL,
	`environment_hash` text NOT NULL,
	`listener_id` integer NOT NULL,
	`event_fingerprint` text NOT NULL,
	`event_json` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`due_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`last_error_code` text,
	CONSTRAINT "postfinance_webhook_state_check" CHECK("postfinance_webhook_inbox"."state" IN ('pending','processing','completed','failed')),
	CONSTRAINT "postfinance_webhook_attempts_check" CHECK("postfinance_webhook_inbox"."attempts" >= 0 AND "postfinance_webhook_inbox"."attempts" <= 8),
	CONSTRAINT "postfinance_webhook_lease_check" CHECK(("postfinance_webhook_inbox"."state"='processing' AND "postfinance_webhook_inbox"."lease" IS NOT NULL AND "postfinance_webhook_inbox"."lease_until">0) OR ("postfinance_webhook_inbox"."state"<>'processing' AND "postfinance_webhook_inbox"."lease" IS NULL AND "postfinance_webhook_inbox"."lease_until"=0))
);
--> statement-breakpoint
CREATE INDEX `postfinance_webhook_work_idx` ON `postfinance_webhook_inbox` (`environment_hash`,`state`,`due_at`,`lease_until`);