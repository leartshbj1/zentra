CREATE TABLE `prepaid_payment_expectations` (
	`period_id` text PRIMARY KEY NOT NULL,
	`customer_reference` text NOT NULL,
	`plan_reference` text NOT NULL,
	`payment_method_configuration_id` integer NOT NULL,
	`connector_configuration_id` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `prepaid_periods`(`period_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "prepaid_payment_expectation_ids_check" CHECK("prepaid_payment_expectations"."payment_method_configuration_id">0 AND "prepaid_payment_expectations"."connector_configuration_id">0 AND "prepaid_payment_expectations"."created_at">0)
);
--> statement-breakpoint
CREATE TABLE `prepaid_provider_reversals` (
	`period_id` text PRIMARY KEY NOT NULL,
	`evidence_fingerprint` text NOT NULL,
	`reversed_at` integer NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `prepaid_transactions`(`period_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "prepaid_provider_reversal_time_check" CHECK("prepaid_provider_reversals"."reversed_at">0)
);

--> statement-breakpoint
CREATE TRIGGER prepaid_expectations_no_update BEFORE UPDATE ON prepaid_payment_expectations BEGIN SELECT RAISE(ABORT,'prepaid_expectation_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_expectations_no_delete BEFORE DELETE ON prepaid_payment_expectations BEGIN SELECT RAISE(ABORT,'prepaid_expectation_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_provider_reversals_no_update BEFORE UPDATE ON prepaid_provider_reversals BEGIN SELECT RAISE(ABORT,'prepaid_reversal_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER prepaid_provider_reversals_no_delete BEFORE DELETE ON prepaid_provider_reversals BEGIN SELECT RAISE(ABORT,'prepaid_reversal_immutable'); END;
--> statement-breakpoint
CREATE VIEW prepaid_effective_revocations AS SELECT period_id FROM prepaid_period_revocations UNION SELECT period_id FROM prepaid_provider_reversals;
--> statement-breakpoint
DROP VIEW prepaid_company_paid_candidates;
--> statement-breakpoint
CREATE VIEW prepaid_company_paid_candidates AS
 SELECT c.contract_id,c.owner_id,c.organization_id,c.workspace_id,c.api_origin,c.space_id,
  c.environment,c.product_key,c.catalog_version AS contract_catalog_version,
  c.catalog_json AS contract_catalog_json,c.anchor_start,c.cancelled_at,c.created_at AS contract_created_at,
  p.period_id,p.ordinal,p.starts_at,p.ends_at,p.currency,p.price_chf_minor,
  p.catalog_version AS period_catalog_version,p.catalog_json AS period_catalog_json,
  t.transaction_id,s.invoice_id,s.evidence_fingerprint,s.reconciled_at,
  o.subscription_id AS actual_subscription_id
 FROM prepaid_contracts c JOIN prepaid_periods p ON p.contract_id=c.contract_id
 JOIN prepaid_transactions t ON t.period_id=p.period_id AND t.api_origin=c.api_origin AND t.space_id=c.space_id
 JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id
 JOIN organizations o ON o.organization_id=c.organization_id AND o.created_by_user_id=c.owner_id
 JOIN prepaid_gestion_catalog_v1 k ON k.product_key=c.product_key
 WHERE c.environment='PRODUCTION' AND p.starts_at<=unixepoch() AND p.ends_at>unixepoch()
 AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id);
