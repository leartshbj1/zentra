-- Explicit expressions: the generator incorrectly quotes comma-separated SQL
-- expression fragments as column identifiers. No business rows are changed.
CREATE INDEX `business_sync_journal_source` ON `business_sync_versions` (`transfer_id`,`organization_id`,json_extract(row_json,'$.source_type'),json_extract(row_json,'$.source_id')) WHERE table_name='journal_entries';--> statement-breakpoint
CREATE INDEX `business_sync_supplier_payment_parent` ON `business_sync_versions` (`transfer_id`,`organization_id`,json_extract(row_json,'$.supplier_invoice_id')) WHERE table_name='supplier_payments';--> statement-breakpoint
CREATE INDEX `business_sync_supplier_allocation_parent` ON `business_sync_versions` (`transfer_id`,`organization_id`,json_extract(row_json,'$.supplier_invoice_id')) WHERE table_name='supplier_credit_allocations';
