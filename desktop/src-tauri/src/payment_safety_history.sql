-- v78 (suite) : historique des IBAN, repris des fiches et des QR-factures
-- déjà enregistrées, puis tenu à jour par déclencheurs. Lancé seulement quand les
-- tables d'achat existent (toujours le cas d'une vraie base ; pas des bases
-- partielles des anciens tests de migration).
INSERT OR IGNORE INTO company_local_supplier_iban_seen(supplier_id,iban,first_seen_at,source)
SELECT id, upper(replace(replace(iban,' ',''),char(9),'')), updated_at, 'migration'
FROM suppliers WHERE trim(COALESCE(iban,''))<>'';
INSERT OR IGNORE INTO company_local_supplier_iban_seen(supplier_id,iban,first_seen_at,source)
SELECT invoice.supplier_id, details.creditor_iban, MIN(details.created_at), 'migration'
FROM supplier_invoice_payment_details details
JOIN supplier_invoices invoice ON invoice.id=details.supplier_invoice_id
GROUP BY invoice.supplier_id, details.creditor_iban;

CREATE TRIGGER IF NOT EXISTS payment_safety_supplier_iban_insert AFTER INSERT ON suppliers
WHEN trim(COALESCE(new.iban,''))<>''
BEGIN
  INSERT OR IGNORE INTO company_local_supplier_iban_seen(supplier_id,iban,first_seen_at,source)
  VALUES(new.id, upper(replace(replace(new.iban,' ',''),char(9),'')), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'supplier');
END;
CREATE TRIGGER IF NOT EXISTS payment_safety_supplier_iban_update AFTER UPDATE OF iban ON suppliers
WHEN trim(COALESCE(new.iban,''))<>'' AND new.iban IS NOT old.iban
BEGIN
  INSERT OR IGNORE INTO company_local_supplier_iban_seen(supplier_id,iban,first_seen_at,source)
  VALUES(new.id, upper(replace(replace(new.iban,' ',''),char(9),'')), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'supplier');
END;
CREATE TRIGGER IF NOT EXISTS payment_safety_qr_iban_insert AFTER INSERT ON supplier_invoice_payment_details
BEGIN
  INSERT OR IGNORE INTO company_local_supplier_iban_seen(supplier_id,iban,first_seen_at,source)
  SELECT supplier_id, new.creditor_iban, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'qr_bill'
  FROM supplier_invoices WHERE id=new.supplier_invoice_id;
END;
CREATE TRIGGER IF NOT EXISTS payment_safety_qr_iban_update AFTER UPDATE OF creditor_iban ON supplier_invoice_payment_details
WHEN new.creditor_iban IS NOT old.creditor_iban
BEGIN
  INSERT OR IGNORE INTO company_local_supplier_iban_seen(supplier_id,iban,first_seen_at,source)
  SELECT supplier_id, new.creditor_iban, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'qr_bill'
  FROM supplier_invoices WHERE id=new.supplier_invoice_id;
END;
