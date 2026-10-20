-- v63 : coordonnées de paiement lues sur la QR-facture d'un fournisseur et
-- ordres de paiement pain.001 préparés pour l'e-banking. Additif seulement.
CREATE TABLE IF NOT EXISTS supplier_invoice_payment_details (
  supplier_invoice_id TEXT PRIMARY KEY REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  creditor_iban TEXT NOT NULL CHECK(length(creditor_iban) BETWEEN 15 AND 34 AND creditor_iban NOT GLOB '*[^A-Z0-9]*'),
  reference_type TEXT NOT NULL CHECK(reference_type IN ('QRR','SCOR','NON')),
  reference TEXT NOT NULL DEFAULT '' CHECK(length(reference)<=27 AND (reference_type<>'NON' OR reference='')),
  creditor_name TEXT NOT NULL CHECK(length(creditor_name) BETWEEN 1 AND 70),
  creditor_street TEXT NOT NULL DEFAULT '' CHECK(length(creditor_street)<=70),
  creditor_building_number TEXT NOT NULL DEFAULT '' CHECK(length(creditor_building_number)<=16),
  creditor_postal_code TEXT NOT NULL DEFAULT '' CHECK(length(creditor_postal_code)<=16),
  creditor_city TEXT NOT NULL DEFAULT '' CHECK(length(creditor_city)<=35),
  creditor_country TEXT NOT NULL DEFAULT '' CHECK(creditor_country='' OR (length(creditor_country)=2 AND creditor_country NOT GLOB '*[^A-Z]*')),
  amount_cents INTEGER CHECK(amount_cents IS NULL OR amount_cents BETWEEN 1 AND 99999999999),
  currency TEXT NOT NULL CHECK(currency IN ('CHF','EUR')),
  message TEXT NOT NULL DEFAULT '' CHECK(length(message)<=140),
  bill_information TEXT NOT NULL DEFAULT '' CHECK(length(bill_information)<=140),
  source TEXT NOT NULL CHECK(source IN ('qr_bill','manual')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_payment_orders (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE CHECK(length(message_id) BETWEEN 1 AND 35),
  execution_date TEXT NOT NULL CHECK(execution_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  debtor_iban TEXT NOT NULL CHECK(length(debtor_iban)=21),
  transaction_count INTEGER NOT NULL CHECK(transaction_count BETWEEN 1 AND 1000),
  total_cents INTEGER NOT NULL CHECK(total_cents>0),
  xml_sha256 TEXT NOT NULL CHECK(length(xml_sha256)=64 AND xml_sha256 NOT GLOB '*[^0-9a-f]*'),
  file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 5 AND 200),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_payment_order_items (
  payment_order_id TEXT NOT NULL REFERENCES supplier_payment_orders(id) ON DELETE RESTRICT,
  supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
  end_to_end_id TEXT NOT NULL CHECK(length(end_to_end_id) BETWEEN 1 AND 35),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  PRIMARY KEY(payment_order_id, supplier_invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_payment_order_items_invoice
ON supplier_payment_order_items(supplier_invoice_id);

-- Un ordre préparé reste une trace : il ne se modifie ni ne s'efface.
CREATE TRIGGER IF NOT EXISTS supplier_payment_orders_no_update BEFORE UPDATE ON supplier_payment_orders
BEGIN SELECT RAISE(ABORT,'Un ordre de paiement préparé ne peut pas être modifié.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_payment_orders_no_delete BEFORE DELETE ON supplier_payment_orders
BEGIN SELECT RAISE(ABORT,'Un ordre de paiement préparé ne peut pas être supprimé.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_payment_order_items_no_update BEFORE UPDATE ON supplier_payment_order_items
BEGIN SELECT RAISE(ABORT,'Un ordre de paiement préparé ne peut pas être modifié.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_payment_order_items_no_delete BEFORE DELETE ON supplier_payment_order_items
BEGIN SELECT RAISE(ABORT,'Un ordre de paiement préparé ne peut pas être supprimé.'); END;
PRAGMA user_version=63;
