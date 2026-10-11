-- Migration number: 0104 	 2026-10-11T02:55:40.867Z
-- A first canonical proof cannot retrofit an already confirmed legacy receipt.
-- Existing immutable proofs remain readable/replayable after confirmation;
-- repository replay selects them and performs no INSERT.
CREATE TRIGGER action_engine_quote_evidence_before_confirmation
BEFORE INSERT ON action_engine_quote_publication_evidence
WHEN EXISTS(SELECT 1 FROM action_engine_quote_reservations r
  WHERE r.id=NEW.reservation_id AND r.organization_id=NEW.organization_id
    AND r.receipt_json IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'action_engine_quote_evidence_after_receipt');
END;
