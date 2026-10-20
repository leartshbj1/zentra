-- v77 : nomenclatures (composants d'un produit fini) et ordres de production.
-- Une production sort les composants et entre le produit fini par les
-- mouvements de stock ordinaires, dans une seule transaction. Additif.
CREATE TABLE IF NOT EXISTS bills_of_materials (
  id TEXT PRIMARY KEY,
  catalog_item_id TEXT NOT NULL UNIQUE REFERENCES catalog_items(id) ON UPDATE CASCADE ON DELETE CASCADE,
  output_quantity_milli INTEGER NOT NULL CHECK(output_quantity_milli BETWEEN 1 AND 9000000000000),
  notes TEXT NOT NULL DEFAULT '' CHECK(LENGTH(notes) <= 2000),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bom_lines (
  bom_id TEXT NOT NULL REFERENCES bills_of_materials(id) ON UPDATE CASCADE ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 500),
  component_item_id TEXT NOT NULL REFERENCES catalog_items(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli BETWEEN 1 AND 9000000000000),
  PRIMARY KEY(bom_id, position)
);
CREATE TABLE IF NOT EXISTS production_orders (
  id TEXT PRIMARY KEY,
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli BETWEEN 1 AND 9000000000000),
  production_date TEXT NOT NULL CHECK(production_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reference TEXT NOT NULL DEFAULT '' CHECK(LENGTH(reference) <= 200),
  components_json TEXT NOT NULL,
  output_movement_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS production_orders_no_update BEFORE UPDATE ON production_orders
BEGIN SELECT RAISE(ABORT,'Une production enregistrée ne se modifie pas : corrigez le stock par un mouvement.'); END;
CREATE TRIGGER IF NOT EXISTS production_orders_no_delete BEFORE DELETE ON production_orders
BEGIN SELECT RAISE(ABORT,'Une production enregistrée est conservée.'); END;
PRAGMA user_version=77;
