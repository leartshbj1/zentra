-- v82 : catalogues professionnels et kits de prestations (Pack bâtiment).
-- catalog_items.ean et catalog_items.trade_source sont ajoutés par
-- database::ensure_shared_step_columns. Un kit est une prestation du
-- catalogue composée de matériel et de main-d'œuvre ; son prix se calcule
-- depuis ses lignes. Additif.
CREATE TABLE IF NOT EXISTS service_kits (
  catalog_item_id TEXT PRIMARY KEY REFERENCES catalog_items(id) ON UPDATE CASCADE ON DELETE CASCADE,
  notes TEXT CHECK(notes IS NULL OR LENGTH(notes) <= 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_kit_lines (
  id TEXT PRIMARY KEY,
  kit_item_id TEXT NOT NULL REFERENCES service_kits(catalog_item_id) ON UPDATE CASCADE ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK(kind IN ('material','labor')),
  component_item_id TEXT REFERENCES catalog_items(id) ON UPDATE CASCADE ON DELETE SET NULL,
  description TEXT NOT NULL CHECK(LENGTH(description) BETWEEN 1 AND 200),
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli BETWEEN 1 AND 1000000000),
  unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents BETWEEN 0 AND 100000000),
  unit_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(unit_cost_cents BETWEEN 0 AND 100000000)
);
CREATE INDEX IF NOT EXISTS idx_service_kit_lines_kit ON service_kit_lines(kit_item_id, position);
PRAGMA user_version=82;
