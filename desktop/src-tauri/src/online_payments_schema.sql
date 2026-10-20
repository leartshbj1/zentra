-- v66 : lien de paiement en ligne (TWINT, cartes) par le compte Payrexx de
-- l'entreprise, désactivé par défaut. La clé API reste sur l'appareil, dans
-- le coffre protégé du système, jamais dans cette base. Puis le modèle de
-- données eBill, sans envoi : destinataires et livraisons. Additif.
CREATE TABLE IF NOT EXISTS online_payment_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  provider TEXT NOT NULL DEFAULT 'payrexx' CHECK(provider IN ('payrexx')),
  instance TEXT CHECK(instance IS NULL OR (LENGTH(instance) BETWEEN 1 AND 63 AND instance NOT GLOB '*[^a-z0-9-]*')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(enabled=0 OR instance IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS invoice_payment_links (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK(provider IN ('payrexx')),
  provider_reference TEXT NOT NULL CHECK(LENGTH(provider_reference) BETWEEN 1 AND 64),
  url TEXT NOT NULL CHECK(url LIKE 'https://%' AND LENGTH(url)<=500),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  currency TEXT NOT NULL CHECK(currency IN ('CHF','EUR')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','failed','cancelled')),
  paid_at TEXT,
  payment_id TEXT REFERENCES payments(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_reference),
  CHECK(payment_id IS NULL OR status='paid')
);
CREATE INDEX IF NOT EXISTS idx_invoice_payment_links_invoice ON invoice_payment_links(invoice_id,created_at);
CREATE TRIGGER IF NOT EXISTS invoice_payment_links_frozen BEFORE UPDATE ON invoice_payment_links
WHEN NEW.invoice_id IS NOT OLD.invoice_id OR NEW.provider IS NOT OLD.provider OR NEW.provider_reference IS NOT OLD.provider_reference
  OR NEW.url IS NOT OLD.url OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.currency IS NOT OLD.currency
  OR (OLD.payment_id IS NOT NULL AND NEW.payment_id IS NOT OLD.payment_id)
  OR (OLD.status='paid' AND NEW.status<>'paid')
BEGIN SELECT RAISE(ABORT,'Un lien de paiement créé ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS invoice_payment_links_no_delete BEFORE DELETE ON invoice_payment_links
BEGIN SELECT RAISE(ABORT,'Un lien de paiement ne se supprime pas.'); END;

-- eBill : modèle de données seulement. L'envoi passera par un prestataire
-- réseau eBill (banque ou intermédiaire) une fois le contrat conclu.
CREATE TABLE IF NOT EXISTS client_ebill_recipients (
  client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('business','private')),
  -- Entreprise : identifiant eBill à 17 chiffres. Particulier : adresse e-mail eBill.
  recipient_id TEXT NOT NULL CHECK(
    (recipient_kind='business' AND LENGTH(recipient_id)=17 AND recipient_id NOT GLOB '*[^0-9]*')
    OR (recipient_kind='private' AND LENGTH(recipient_id) BETWEEN 3 AND 254 AND recipient_id LIKE '%_@_%')
  ),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_ebill_deliveries (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('business','private')),
  recipient_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','submitted','delivered','accepted','rejected','failed')),
  provider_reference TEXT,
  status_detail TEXT CHECK(status_detail IS NULL OR LENGTH(status_detail)<=500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_ebill_deliveries_invoice ON invoice_ebill_deliveries(invoice_id,created_at);
CREATE TRIGGER IF NOT EXISTS invoice_ebill_deliveries_frozen BEFORE UPDATE ON invoice_ebill_deliveries
WHEN NEW.invoice_id IS NOT OLD.invoice_id OR NEW.recipient_id IS NOT OLD.recipient_id OR NEW.recipient_kind IS NOT OLD.recipient_kind
BEGIN SELECT RAISE(ABORT,'Le destinataire d''une livraison eBill ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS invoice_ebill_deliveries_no_delete BEFORE DELETE ON invoice_ebill_deliveries
BEGIN SELECT RAISE(ABORT,'Une livraison eBill ne se supprime pas.'); END;
PRAGMA user_version=66;
