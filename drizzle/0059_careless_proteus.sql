CREATE TABLE `automation_work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`assigned_to` text,
	`due_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `automation_workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `automation_work_items_company` ON `automation_work_items` (`organization_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `automation_workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_revision` integer NOT NULL,
	`source_id` text NOT NULL,
	`source_version` text NOT NULL,
	`title` text NOT NULL,
	`definition` text NOT NULL,
	`state` text NOT NULL,
	`result` text DEFAULT '{}' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`lease` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`due_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_id`) REFERENCES `automation_workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_workflow_run_source` ON `automation_workflow_runs` (`workflow_id`,`workflow_revision`,`source_id`,`source_version`);--> statement-breakpoint
CREATE INDEX `automation_workflow_runs_company` ON `automation_workflow_runs` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `automation_workflow_runs_due` ON `automation_workflow_runs` (`state`,`due_at`);--> statement-breakpoint
CREATE TABLE `automation_workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`definition` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `automation_workflows_company` ON `automation_workflows` (`organization_id`,`enabled`);