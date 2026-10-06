CREATE TABLE `prepaid_contracts` (
	`contract_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`organization_id` text,
	`workspace_id` text,
	`api_origin` text NOT NULL,
	`space_id` integer NOT NULL,
	`environment` text NOT NULL,
	`product_key` text NOT NULL,
	`catalog_version` text NOT NULL,
	`catalog_json` text NOT NULL,
	`anchor_start` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`cancelled_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "prepaid_contracts_environment_check" CHECK("prepaid_contracts"."environment" IN ('TEST','PRODUCTION')),
	CONSTRAINT "prepaid_contracts_space_check" CHECK("prepaid_contracts"."space_id">0),
	CONSTRAINT "prepaid_contracts_anchor_check" CHECK("prepaid_contracts"."anchor_start">0 AND ("prepaid_contracts"."cancelled_at" IS NULL OR "prepaid_contracts"."cancelled_at">="prepaid_contracts"."created_at"))
);
--> statement-breakpoint
CREATE INDEX `prepaid_contracts_owner_idx` ON `prepaid_contracts` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `prepaid_contracts_organization_idx` ON `prepaid_contracts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `prepaid_contracts_workspace_idx` ON `prepaid_contracts` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `prepaid_period_revocations` (
	`period_id` text PRIMARY KEY NOT NULL,
	`evidence_fingerprint` text NOT NULL,
	`revoked_at` integer NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `prepaid_settlement_proofs`(`period_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `prepaid_periods` (
	`period_id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`currency` text NOT NULL,
	`price_chf_minor` integer NOT NULL,
	`catalog_version` text NOT NULL,
	`catalog_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `prepaid_contracts`(`contract_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "prepaid_periods_dates_check" CHECK("prepaid_periods"."starts_at">0 AND "prepaid_periods"."ends_at">"prepaid_periods"."starts_at" AND "prepaid_periods"."ordinal">=0),
	CONSTRAINT "prepaid_periods_amount_check" CHECK("prepaid_periods"."currency"='CHF' AND "prepaid_periods"."price_chf_minor">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prepaid_periods_ordinal_idx` ON `prepaid_periods` (`contract_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `prepaid_periods_coverage_idx` ON `prepaid_periods` (`contract_id`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE TABLE `prepaid_settlement_proofs` (
	`period_id` text PRIMARY KEY NOT NULL,
	`invoice_id` integer NOT NULL,
	`evidence_fingerprint` text NOT NULL,
	`reconciled_at` integer NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `prepaid_transactions`(`period_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "prepaid_settlement_invoice_check" CHECK("prepaid_settlement_proofs"."invoice_id">0 AND "prepaid_settlement_proofs"."reconciled_at">0)
);
--> statement-breakpoint
CREATE TABLE `prepaid_transactions` (
	`period_id` text PRIMARY KEY NOT NULL,
	`api_origin` text NOT NULL,
	`space_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `prepaid_periods`(`period_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "prepaid_transactions_ids_check" CHECK("prepaid_transactions"."space_id">0 AND "prepaid_transactions"."transaction_id">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prepaid_transactions_provider_idx` ON `prepaid_transactions` (`api_origin`,`space_id`,`transaction_id`);
--> statement-breakpoint
-- Audit facts are append-only. A cancellation is the sole mutable contract field.
CREATE TRIGGER prepaid_contracts_immutable BEFORE UPDATE ON prepaid_contracts
WHEN NEW.contract_id IS NOT OLD.contract_id OR NEW.owner_id IS NOT OLD.owner_id
 OR NEW.organization_id IS NOT OLD.organization_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.api_origin IS NOT OLD.api_origin OR NEW.space_id IS NOT OLD.space_id
 OR NEW.environment IS NOT OLD.environment OR NEW.product_key IS NOT OLD.product_key
 OR NEW.catalog_version IS NOT OLD.catalog_version OR NEW.catalog_json IS NOT OLD.catalog_json
 OR NEW.anchor_start IS NOT OLD.anchor_start OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NOT OLD.cancelled_at)
BEGIN SELECT RAISE(ABORT,'prepaid_contract_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_contracts_no_delete BEFORE DELETE ON prepaid_contracts
BEGIN SELECT RAISE(ABORT,'prepaid_contract_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_periods_no_update BEFORE UPDATE ON prepaid_periods
BEGIN SELECT RAISE(ABORT,'prepaid_period_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_periods_no_delete BEFORE DELETE ON prepaid_periods
BEGIN SELECT RAISE(ABORT,'prepaid_period_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_transactions_no_update BEFORE UPDATE ON prepaid_transactions
BEGIN SELECT RAISE(ABORT,'prepaid_transaction_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_transactions_no_delete BEFORE DELETE ON prepaid_transactions
BEGIN SELECT RAISE(ABORT,'prepaid_transaction_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_settlements_no_update BEFORE UPDATE ON prepaid_settlement_proofs
BEGIN SELECT RAISE(ABORT,'prepaid_settlement_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_settlements_no_delete BEFORE DELETE ON prepaid_settlement_proofs
BEGIN SELECT RAISE(ABORT,'prepaid_settlement_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_revocations_no_update BEFORE UPDATE ON prepaid_period_revocations
BEGIN SELECT RAISE(ABORT,'prepaid_revocation_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_revocations_no_delete BEFORE DELETE ON prepaid_period_revocations
BEGIN SELECT RAISE(ABORT,'prepaid_revocation_immutable'); END;
