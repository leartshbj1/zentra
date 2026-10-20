-- v76 : dépôts, transferts entre dépôts, lots et numéros de série. Additif :
-- les mouvements de stock existants restent la référence de la quantité
-- totale ; un mouvement sans dépôt appartient au dépôt principal.
CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK(LENGTH(code) BETWEEN 1 AND 12),
  name TEXT NOT NULL CHECK(LENGTH(name) BETWEEN 1 AND 80),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS warehouses_single_default ON warehouses(is_default) WHERE is_default=1;
CREATE TABLE IF NOT EXISTS stock_movement_warehouses (
  stock_movement_id TEXT PRIMARY KEY REFERENCES stock_movements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_transfers (
  id TEXT PRIMARY KEY,
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  from_warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  to_warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli BETWEEN 1 AND 9000000000000000),
  transfer_date TEXT NOT NULL CHECK(transfer_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  note TEXT NOT NULL DEFAULT '' CHECK(LENGTH(note) <= 500),
  created_at TEXT NOT NULL,
  CHECK(from_warehouse_id <> to_warehouse_id)
);
CREATE TRIGGER IF NOT EXISTS stock_transfers_no_update BEFORE UPDATE ON stock_transfers
BEGIN SELECT RAISE(ABORT,'Un transfert de stock enregistré ne se modifie pas : faites un transfert inverse.'); END;
CREATE TRIGGER IF NOT EXISTS stock_transfers_no_delete BEFORE DELETE ON stock_transfers
BEGIN SELECT RAISE(ABORT,'Un transfert de stock enregistré est conservé : faites un transfert inverse.'); END;
CREATE TABLE IF NOT EXISTS catalog_item_tracking (
  catalog_item_id TEXT PRIMARY KEY REFERENCES catalog_items(id) ON UPDATE CASCADE ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('lot','serial')),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_lots (
  id TEXT PRIMARY KEY,
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK(mode IN ('lot','serial')),
  code TEXT NOT NULL CHECK(LENGTH(code) BETWEEN 1 AND 80),
  expiry_date TEXT,
  warehouse_id TEXT REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(catalog_item_id, code)
);
CREATE TABLE IF NOT EXISTS stock_lot_movements (
  id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL REFERENCES stock_lots(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli <> 0 AND quantity_milli BETWEEN -9000000000000000 AND 9000000000000000),
  movement_date TEXT NOT NULL CHECK(movement_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source_type TEXT NOT NULL CHECK(source_type IN ('entry','exit','receipt','delivery')),
  source_id TEXT,
  reference TEXT NOT NULL DEFAULT '' CHECK(LENGTH(reference) <= 200),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stock_lot_movements_lot ON stock_lot_movements(lot_id);
CREATE TRIGGER IF NOT EXISTS stock_lot_movements_no_update BEFORE UPDATE ON stock_lot_movements
BEGIN SELECT RAISE(ABORT,'Un mouvement de lot enregistré ne se modifie pas : enregistrez une correction.'); END;
CREATE TRIGGER IF NOT EXISTS stock_lot_movements_no_delete BEFORE DELETE ON stock_lot_movements
BEGIN SELECT RAISE(ABORT,'Un mouvement de lot enregistré est conservé : enregistrez une correction.'); END;
PRAGMA user_version=76;
