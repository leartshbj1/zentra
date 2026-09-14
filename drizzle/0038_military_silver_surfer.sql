CREATE TABLE `company_copies` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`backup_id` text NOT NULL,
	`published_by` text NOT NULL,
	`published_at` text NOT NULL
);
