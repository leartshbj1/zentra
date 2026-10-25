-- v78 : caisse simple (comptoir, atelier) et suivi local de la projection
-- publiée pour l'API. Additif.
-- Un ticket ne se modifie pas : une annulation est un second ticket « void »
-- qui renvoie au premier. La clôture du jour crée une facture payée de ventes
-- au comptoir (TVA, comptabilité et archive habituelles) et la relie ici.
CREATE TABLE IF NOT EXISTS pos_tickets (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE CHECK(LENGTH(number) BETWEEN 6 AND 40),
  kind TEXT NOT NULL CHECK(kind IN ('sale','void')),
  ticket_date TEXT NOT NULL CHECK(LENGTH(ticket_date)=10 AND DATE(ticket_date)=ticket_date),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','payrexx','terminal')),
  currency TEXT NOT NULL DEFAULT 'CHF' CHECK(currency IN ('CHF','EUR')),
  subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents BETWEEN 0 AND 100000000000),
  vat_cents INTEGER NOT NULL CHECK(vat_cents BETWEEN 0 AND 100000000000),
  total_cents INTEGER NOT NULL CHECK(total_cents BETWEEN 0 AND 100000000000),
  received_cents INTEGER CHECK(received_cents IS NULL OR received_cents BETWEEN 0 AND 100000000000),
  change_cents INTEGER CHECK(change_cents IS NULL OR change_cents BETWEEN 0 AND 100000000000),
  payment_reference TEXT CHECK(payment_reference IS NULL OR LENGTH(payment_reference)<=100),
  voids_ticket_id TEXT UNIQUE REFERENCES pos_tickets(id) ON DELETE RESTRICT,
  note TEXT CHECK(note IS NULL OR LENGTH(note)<=500),
  created_at TEXT NOT NULL,
  CHECK(total_cents=subtotal_cents+vat_cents),
  CHECK((kind='void')=(voids_ticket_id IS NOT NULL)),
  CHECK(payment_method<>'cash' OR kind='void' OR (received_cents IS NOT NULL AND change_cents=received_cents-total_cents))
);
CREATE INDEX IF NOT EXISTS idx_pos_tickets_date ON pos_tickets(ticket_date,created_at);
CREATE TRIGGER IF NOT EXISTS pos_tickets_no_update BEFORE UPDATE ON pos_tickets
BEGIN SELECT RAISE(ABORT,'Un ticket de caisse ne se modifie pas : annulez-le.'); END;
CREATE TRIGGER IF NOT EXISTS pos_tickets_no_delete BEFORE DELETE ON pos_tickets
BEGIN SELECT RAISE(ABORT,'Un ticket de caisse est conservé.'); END;

CREATE TABLE IF NOT EXISTS pos_ticket_lines (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES pos_tickets(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 1000),
  catalog_item_id TEXT REFERENCES catalog_items(id) ON DELETE RESTRICT,
  description TEXT NOT NULL CHECK(LENGTH(TRIM(description)) BETWEEN 1 AND 300),
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli BETWEEN 1 AND 1000000000),
  unit TEXT NOT NULL CHECK(LENGTH(TRIM(unit)) BETWEEN 1 AND 40),
  unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents BETWEEN 0 AND 100000000000),
  discount_bp INTEGER NOT NULL DEFAULT 0 CHECK(discount_bp BETWEEN 0 AND 10000),
  vat_bp INTEGER NOT NULL DEFAULT 0 CHECK(vat_bp BETWEEN 0 AND 10000),
  line_net_cents INTEGER NOT NULL,
  line_vat_cents INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL,
  stock_moved INTEGER NOT NULL DEFAULT 0 CHECK(stock_moved IN (0,1)),
  created_at TEXT NOT NULL,
  CHECK(line_total_cents=line_net_cents+line_vat_cents),
  UNIQUE(ticket_id,position)
);
CREATE INDEX IF NOT EXISTS idx_pos_ticket_lines_ticket ON pos_ticket_lines(ticket_id,position);
CREATE TRIGGER IF NOT EXISTS pos_ticket_lines_no_update BEFORE UPDATE ON pos_ticket_lines
BEGIN SELECT RAISE(ABORT,'Une ligne de ticket ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS pos_ticket_lines_no_delete BEFORE DELETE ON pos_ticket_lines
BEGIN SELECT RAISE(ABORT,'Une ligne de ticket est conservée.'); END;

CREATE TABLE IF NOT EXISTS pos_day_closings (
  id TEXT PRIMARY KEY,
  closing_date TEXT NOT NULL UNIQUE CHECK(LENGTH(closing_date)=10 AND DATE(closing_date)=closing_date),
  ticket_count INTEGER NOT NULL CHECK(ticket_count>=0),
  total_cents INTEGER NOT NULL CHECK(total_cents>=0),
  cash_cents INTEGER NOT NULL CHECK(cash_cents>=0),
  payrexx_cents INTEGER NOT NULL CHECK(payrexx_cents>=0),
  terminal_cents INTEGER NOT NULL CHECK(terminal_cents>=0),
  invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK(total_cents=cash_cents+payrexx_cents+terminal_cents),
  CHECK((total_cents=0)=(invoice_id IS NULL))
);
CREATE TRIGGER IF NOT EXISTS pos_day_closings_no_update BEFORE UPDATE ON pos_day_closings
BEGIN SELECT RAISE(ABORT,'Une clôture de caisse ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS pos_day_closings_no_delete BEFORE DELETE ON pos_day_closings
BEGIN SELECT RAISE(ABORT,'Une clôture de caisse est conservée.'); END;

-- Propre à cet appareil (jamais synchronisé) : empreinte de chaque
-- enregistrement déjà publié pour l'API, pour n'envoyer que les changements.
CREATE TABLE IF NOT EXISTS company_local_api_projection (
  entity TEXT NOT NULL CHECK(entity IN ('customers','articles','invoices','quotes','orders','payments')),
  record_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(LENGTH(sha256)=64),
  published_at TEXT NOT NULL,
  PRIMARY KEY(entity,record_id)
);
PRAGMA user_version=78;
