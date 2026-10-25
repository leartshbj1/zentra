-- v78 : terrain et clients. Parc installé chez les clients et entretiens
-- planifiés, réglages client (avis, prise de rendez-vous, acompte), journal
-- des SMS, acomptes Payrexx des devis et demandes de rendez-vous du portail.
-- Additif : aucune table existante n'est modifiée.
CREATE TABLE IF NOT EXISTS installed_equipment (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(LENGTH(TRIM(kind)) BETWEEN 1 AND 120),
  brand TEXT NOT NULL DEFAULT '' CHECK(LENGTH(brand) <= 120),
  model TEXT NOT NULL DEFAULT '' CHECK(LENGTH(model) <= 120),
  serial_number TEXT NOT NULL DEFAULT '' CHECK(LENGTH(serial_number) <= 120),
  installed_on TEXT CHECK(installed_on IS NULL OR (LENGTH(installed_on)=10 AND DATE(installed_on)=installed_on)),
  warranty_until TEXT CHECK(warranty_until IS NULL OR (LENGTH(warranty_until)=10 AND DATE(warranty_until)=warranty_until)),
  location TEXT NOT NULL DEFAULT '' CHECK(LENGTH(location) <= 300),
  -- Entretien périodique : intervalle en mois, puis date du dernier entretien fait.
  service_interval_months INTEGER CHECK(service_interval_months IS NULL OR service_interval_months BETWEEN 1 AND 120),
  last_service_on TEXT CHECK(last_service_on IS NULL OR (LENGTH(last_service_on)=10 AND DATE(last_service_on)=last_service_on)),
  notes TEXT NOT NULL DEFAULT '' CHECK(LENGTH(notes) <= 4000),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_installed_equipment_client ON installed_equipment(client_id);

-- Un entretien planifié pointe vers son rendez-vous d'agenda ; fait, il garde sa date.
CREATE TABLE IF NOT EXISTS equipment_services (
  id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES installed_equipment(id) ON UPDATE CASCADE ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('planned','done')),
  service_date TEXT NOT NULL CHECK(LENGTH(service_date)=10 AND DATE(service_date)=service_date),
  agenda_event_id TEXT REFERENCES agenda_events(id) ON UPDATE CASCADE ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '' CHECK(LENGTH(notes) <= 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equipment_services_equipment ON equipment_services(equipment_id,service_date);

-- Réglages client : lien d'avis Google, prise de rendez-vous en ligne, acompte.
CREATE TABLE IF NOT EXISTS customer_engagement_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  review_url TEXT CHECK(review_url IS NULL OR (LENGTH(review_url) BETWEEN 12 AND 500 AND review_url GLOB 'https://*')),
  review_cooldown_days INTEGER NOT NULL DEFAULT 365 CHECK(review_cooldown_days BETWEEN 30 AND 1095),
  review_auto INTEGER NOT NULL DEFAULT 0 CHECK(review_auto IN (0,1)),
  booking_enabled INTEGER NOT NULL DEFAULT 0 CHECK(booking_enabled IN (0,1)),
  -- Jours ouverts : bit 0 = lundi … bit 6 = dimanche.
  booking_days INTEGER NOT NULL DEFAULT 31 CHECK(booking_days BETWEEN 1 AND 127),
  booking_start TEXT NOT NULL DEFAULT '08:00' CHECK(LENGTH(booking_start)=5 AND TIME(booking_start) IS NOT NULL),
  booking_end TEXT NOT NULL DEFAULT '17:00' CHECK(LENGTH(booking_end)=5 AND TIME(booking_end) IS NOT NULL AND booking_end>booking_start),
  booking_minutes INTEGER NOT NULL DEFAULT 60 CHECK(booking_minutes IN (30,45,60,90,120)),
  booking_weeks INTEGER NOT NULL DEFAULT 3 CHECK(booking_weeks BETWEEN 1 AND 8),
  deposit_percent_bp INTEGER NOT NULL DEFAULT 0 CHECK(deposit_percent_bp BETWEEN 0 AND 10000),
  updated_at TEXT NOT NULL
);

-- SMS : réglages du compte de l'entreprise (le secret reste dans un fichier
-- de l'appareil) et journal de chaque envoi, validé à la main ou par règle.
CREATE TABLE IF NOT EXISTS sms_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  provider TEXT NOT NULL CHECK(provider IN ('aspsms','swisscom','generic')),
  sender TEXT NOT NULL CHECK(LENGTH(TRIM(sender)) BETWEEN 1 AND 16),
  account TEXT NOT NULL DEFAULT '' CHECK(LENGTH(account) <= 200),
  endpoint TEXT CHECK(endpoint IS NULL OR (LENGTH(endpoint) <= 300 AND endpoint GLOB 'https://*')),
  appointment_reminders_auto INTEGER NOT NULL DEFAULT 0 CHECK(appointment_reminders_auto IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sms_messages (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK(purpose IN ('appointment_reminder','payment_reminder','review_request','booking','other')),
  origin TEXT NOT NULL CHECK(origin IN ('validated','rule')),
  recipient TEXT NOT NULL CHECK(recipient GLOB '+[1-9]*' AND LENGTH(recipient) BETWEEN 8 AND 16),
  body TEXT NOT NULL CHECK(LENGTH(TRIM(body)) BETWEEN 1 AND 640),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sent','failed')),
  provider_reference TEXT,
  error TEXT,
  related_type TEXT,
  related_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_messages_related ON sms_messages(related_type,related_id);

-- Demandes d'avis : une par client et par période, quel que soit le canal.
CREATE TABLE IF NOT EXISTS review_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  invoice_id TEXT REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK(channel IN ('email','sms','copy')),
  origin TEXT NOT NULL CHECK(origin IN ('validated','rule')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_requests_client ON review_requests(client_id,created_at);

-- Acompte payé en ligne à l'acceptation du devis : lien Payrexx de l'entreprise.
CREATE TABLE IF NOT EXISTS quote_deposit_links (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider='payrexx'),
  provider_reference TEXT NOT NULL,
  url TEXT NOT NULL CHECK(url GLOB 'https://*'),
  percent_bp INTEGER NOT NULL CHECK(percent_bp BETWEEN 1 AND 10000),
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000000),
  currency TEXT NOT NULL CHECK(currency IN ('CHF','EUR')),
  status TEXT NOT NULL CHECK(status IN ('open','paid','failed','cancelled')),
  invoice_id TEXT REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE SET NULL,
  payment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quote_deposit_links_quote ON quote_deposit_links(quote_id,status);

-- Demandes de rendez-vous reçues du portail client, à valider dans l'app.
CREATE TABLE IF NOT EXISTS portal_booking_requests (
  id TEXT PRIMARY KEY CHECK(LENGTH(id) BETWEEN 1 AND 80),
  client_id TEXT REFERENCES clients(id) ON UPDATE CASCADE ON DELETE SET NULL,
  start_at TEXT NOT NULL CHECK(LENGTH(start_at)=16 AND start_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]'),
  minutes INTEGER NOT NULL CHECK(minutes BETWEEN 15 AND 240),
  contact_name TEXT NOT NULL CHECK(LENGTH(TRIM(contact_name)) BETWEEN 1 AND 200),
  phone TEXT NOT NULL DEFAULT '' CHECK(LENGTH(phone) <= 40),
  message TEXT NOT NULL DEFAULT '' CHECK(LENGTH(message) <= 2000),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined')),
  agenda_event_id TEXT REFERENCES agenda_events(id) ON UPDATE CASCADE ON DELETE SET NULL,
  received_at TEXT NOT NULL,
  decided_at TEXT
);
PRAGMA user_version=78;
