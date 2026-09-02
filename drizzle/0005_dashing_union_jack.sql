DROP INDEX `license_activations_one_device_idx`;--> statement-breakpoint
CREATE INDEX `license_activations_subscription_idx` ON `license_activations` (`subscription_id`);