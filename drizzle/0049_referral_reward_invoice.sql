ALTER TABLE `referral_claims` ADD `reward_invoice_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `referral_claims_reward_invoice_id_unique` ON `referral_claims` (`reward_invoice_id`);