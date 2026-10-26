-- v78 : paiements sûrs. Réglages de la double validation et de la relance des
-- justificatifs, circuit préparé → approuvé des paiements fournisseurs, IBAN
-- réellement payé par chaque ordre, et IBAN vus par fournisseur sur cet
-- appareil. Additif seulement.
CREATE TABLE IF NOT EXISTS payment_safety_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  approval_enabled INTEGER NOT NULL DEFAULT 1 CHECK(approval_enabled IN (0,1)),
  approval_threshold_cents INTEGER NOT NULL DEFAULT 500000 CHECK(approval_threshold_cents BETWEEN 100 AND 99999999999),
  receipt_reminder_days INTEGER NOT NULL DEFAULT 10 CHECK(receipt_reminder_days BETWEEN 1 AND 90),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Une ligne par facture dont le paiement a été préparé. « Payé » se lit sur la
-- facture (solde) et dans les ordres : il n'est pas recopié ici.
CREATE TABLE IF NOT EXISTS supplier_payment_approvals (
  supplier_invoice_id TEXT PRIMARY KEY REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('prepared','approved')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  creditor_iban TEXT NOT NULL DEFAULT '' CHECK(length(creditor_iban)<=34),
  prepared_by_user_id TEXT NOT NULL CHECK(length(prepared_by_user_id) BETWEEN 1 AND 200),
  prepared_by_name TEXT NOT NULL CHECK(length(prepared_by_name) BETWEEN 1 AND 200),
  prepared_at TEXT NOT NULL,
  approved_by_user_id TEXT,
  approved_by_name TEXT,
  approved_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK((status='prepared' AND approved_by_user_id IS NULL AND approved_by_name IS NULL AND approved_at IS NULL)
    OR (status='approved' AND approved_by_user_id IS NOT NULL AND approved_by_name IS NOT NULL AND approved_at IS NOT NULL))
);

-- L'IBAN effectivement écrit dans chaque ordre : c'est lui qui dira, au
-- prochain paiement, si les coordonnées du fournisseur ont changé.
CREATE TABLE IF NOT EXISTS supplier_payment_order_creditors (
  payment_order_id TEXT NOT NULL REFERENCES supplier_payment_orders(id) ON DELETE RESTRICT,
  supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
  supplier_id TEXT NOT NULL,
  creditor_iban TEXT NOT NULL CHECK(length(creditor_iban) BETWEEN 15 AND 34),
  paid_on TEXT NOT NULL CHECK(paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY(payment_order_id, supplier_invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_payment_order_creditors_supplier
ON supplier_payment_order_creditors(supplier_id, paid_on);

CREATE TRIGGER IF NOT EXISTS supplier_payment_order_creditors_no_update BEFORE UPDATE ON supplier_payment_order_creditors
BEGIN SELECT RAISE(ABORT,'Un ordre de paiement préparé ne peut pas être modifié.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_payment_order_creditors_no_delete BEFORE DELETE ON supplier_payment_order_creditors
BEGIN SELECT RAISE(ABORT,'Un ordre de paiement préparé ne peut pas être supprimé.'); END;

-- Propre à cet appareil (espace company_local_) : la date à laquelle chaque
-- IBAN d'un fournisseur a été vu pour la première fois ici.
CREATE TABLE IF NOT EXISTS company_local_supplier_iban_seen (
  supplier_id TEXT NOT NULL,
  iban TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('supplier','qr_bill','migration')),
  PRIMARY KEY(supplier_id, iban)
);

-- Nombre de membres de l'équipe, lu la dernière fois sur le compte Zentra.
-- Une entreprise d'une seule personne n'est jamais bloquée par la double validation.
CREATE TABLE IF NOT EXISTS company_local_team_size (
  id INTEGER PRIMARY KEY CHECK(id=1),
  members INTEGER NOT NULL CHECK(members BETWEEN 0 AND 100000),
  updated_at TEXT NOT NULL
);
PRAGMA user_version=78;

