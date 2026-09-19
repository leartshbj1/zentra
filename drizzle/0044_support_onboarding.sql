CREATE TABLE `support_checkout_acceptances` (
	`session_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`legal_version` text NOT NULL,
	`accepted_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `support_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`domain` text NOT NULL,
	`label` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `support_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
