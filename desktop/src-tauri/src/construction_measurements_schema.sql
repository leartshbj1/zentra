-- v78 : métré et chapitres des devis et factures (Pack bâtiment). Additif :
-- une ligne garde sa quantité ; le métré, s'il existe, la recalcule à
-- l'enregistrement. Le chapitre regroupe les lignes consécutives de même titre.
ALTER TABLE quote_items ADD COLUMN section_title TEXT CHECK(section_title IS NULL OR LENGTH(section_title) BETWEEN 1 AND 120);
ALTER TABLE quote_items ADD COLUMN measurements_json TEXT CHECK(measurements_json IS NULL OR json_valid(measurements_json));
ALTER TABLE invoice_items ADD COLUMN section_title TEXT CHECK(section_title IS NULL OR LENGTH(section_title) BETWEEN 1 AND 120);
ALTER TABLE invoice_items ADD COLUMN measurements_json TEXT CHECK(measurements_json IS NULL OR json_valid(measurements_json));
ALTER TABLE quotes ADD COLUMN show_measurements INTEGER NOT NULL DEFAULT 0 CHECK(show_measurements IN (0,1));
ALTER TABLE invoices ADD COLUMN show_measurements INTEGER NOT NULL DEFAULT 0 CHECK(show_measurements IN (0,1));
PRAGMA user_version=78;
