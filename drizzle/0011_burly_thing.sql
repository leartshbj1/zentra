CREATE TABLE `workspace_backup_chunks` (
	`backup_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	FOREIGN KEY (`backup_id`) REFERENCES `workspace_backups`(`backup_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_backup_chunk_identity` ON `workspace_backup_chunks` (`backup_id`,`chunk_index`);--> statement-breakpoint
CREATE TABLE `workspace_backups` (
	`backup_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`created_by` text NOT NULL,
	`manifest_json` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`organization_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workspace_backups_org_created` ON `workspace_backups` (`organization_id`,`created_at`);