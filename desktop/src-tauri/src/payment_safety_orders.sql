-- v78 (suite) : l'IBAN payé par les ordres déjà préparés, repris une fois dans
-- la base de l'appareil. Pas dans les copies d'archive : la table y porte déjà
-- la garde d'écriture de l'entreprise, et une copie n'a pas besoin de cette reprise.
-- Ordres déjà préparés : l'IBAN de la QR-facture, sinon celui de la fiche.
INSERT OR IGNORE INTO supplier_payment_order_creditors(payment_order_id,supplier_invoice_id,supplier_id,creditor_iban,paid_on)
SELECT item.payment_order_id, item.supplier_invoice_id, invoice.supplier_id,
       COALESCE(details.creditor_iban, upper(replace(replace(COALESCE(supplier.iban,''),' ',''),char(9),''))),
       payment_order.execution_date
FROM supplier_payment_order_items item
JOIN supplier_payment_orders payment_order ON payment_order.id=item.payment_order_id
JOIN supplier_invoices invoice ON invoice.id=item.supplier_invoice_id
LEFT JOIN supplier_invoice_payment_details details ON details.supplier_invoice_id=item.supplier_invoice_id
LEFT JOIN suppliers supplier ON supplier.id=invoice.supplier_id
WHERE length(COALESCE(details.creditor_iban, upper(replace(replace(COALESCE(supplier.iban,''),' ',''),char(9),'')))) BETWEEN 15 AND 34;
