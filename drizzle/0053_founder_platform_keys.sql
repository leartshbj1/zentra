CREATE TABLE `founder_platform_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`action_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer NOT NULL
);
