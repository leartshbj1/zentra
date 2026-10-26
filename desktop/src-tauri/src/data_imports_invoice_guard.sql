-- v78 (suite) : la garde d'annulation des factures émises admet seulement une
-- facture reprise dont l'import est annulé (ligne de data_import_invoice_cancellations).
-- Exécutée seulement quand la table invoices existe.
DROP TRIGGER IF EXISTS invoices_issued_no_unsafe_cancel;
CREATE TRIGGER invoices_issued_no_unsafe_cancel
BEFORE UPDATE OF status ON invoices
WHEN OLD.number IS NOT NULL AND OLD.status<>'annulee' AND NEW.status='annulee'
  AND NOT EXISTS(SELECT 1 FROM data_import_invoice_cancellations c WHERE c.invoice_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'issued invoices cannot be cancelled; issue a traceable credit note'); END;
