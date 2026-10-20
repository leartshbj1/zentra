-- v73 : listes de prix par client. Une liste donne un rabais sur tout le
-- catalogue et, si besoin, un prix fixe pour certains articles. Additif.
CREATE TABLE IF NOT EXISTS price_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(LENGTH(name) BETWEEN 1 AND 80),
  discount_bp INTEGER NOT NULL DEFAULT 0 CHECK(discount_bp BETWEEN 0 AND 10000),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS price_list_items (
  price_list_id TEXT NOT NULL REFERENCES price_lists(id) ON UPDATE CASCADE ON DELETE CASCADE,
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id) ON UPDATE CASCADE ON DELETE CASCADE,
  unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents BETWEEN 0 AND 100000000000),
  PRIMARY KEY(price_list_id, catalog_item_id)
);
CREATE TABLE IF NOT EXISTS client_price_lists (
  client_id TEXT PRIMARY KEY REFERENCES clients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  price_list_id TEXT NOT NULL REFERENCES price_lists(id) ON UPDATE CASCADE ON DELETE CASCADE,
  updated_at TEXT NOT NULL
);
PRAGMA user_version=73;
