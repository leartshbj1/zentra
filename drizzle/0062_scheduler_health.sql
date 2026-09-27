CREATE TABLE `service_scheduler_health` (
	`job` text PRIMARY KEY NOT NULL,
	`last_started_at` integer NOT NULL,
	`last_finished_at` integer,
	`last_success_at` integer,
	`last_failure_at` integer,
	`last_outcome` text,
	`last_reference` text
);
