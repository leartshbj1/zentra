-- Migration number: 0105  2026-10-11
-- Additive only. Supports tenant-scoped creation-order discovery of durable
-- Support work. No data, permission, consent or workflow state is changed.
CREATE INDEX support_ticket_work_discovery
ON support_tickets(workspace_id,created_at,id);
