CREATE TABLE `project_document_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organization_id` text NOT NULL,
	`document_id` text NOT NULL,
	`project_id` text NOT NULL,
	`project_name` text NOT NULL,
	`action` text NOT NULL,
	`original_name` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_document_event_identity` ON `project_document_events` (`organization_id`,`document_id`,`action`);--> statement-breakpoint
CREATE INDEX `project_document_event_feed` ON `project_document_events` (`organization_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `project_document_event_project` ON `project_document_events` (`organization_id`,`project_id`);