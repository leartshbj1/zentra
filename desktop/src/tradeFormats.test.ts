// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { type XmlNode, detectTradeFormat, npkCatalog, offerExport, parseBmecat, parseDatanorm, parseNpkText, submissionLines, tradeUnit } from './tradeFormats';

// Fichiers d'exemple fabriqués pour les tests : aucun catalogue réel ni sous licence.
const DATANORM = [
  'V 050;Grossiste Fictif SA;Catalogue test;CHF;',
  'A;N;100200;00;Tube cuivre 15 mm;barre 5 m;1;0;M;1590;R1;SAN;T1;',
  'B;N;100200;TUBECU15;;12;;;7610000000017;;SAN;;1;;;',
  'A;N;100300;00;Raccord coudé 90°;15 mm;1;2;STCK;24500;R1;SAN;;',
  'P;A;100300;2;19800;;;;;100200;2;1190;;;;;',
  'A;N;100400;00;;;1;0;STCK;100;;;;',
  'T;N;T1;1;Tube cuivre écroui;selon SN EN 1057;',
  'A;L;999999;00;Article supprimé;;1;0;STCK;100;;;;',
].join('\r\n');

const BMECAT = `<?xml version="1.0" encoding="UTF-8"?>
<BMECAT version="2005" xmlns="http://www.bmecat.org/bmecat/2005">
  <HEADER><CATALOG><LANGUAGE>fre</LANGUAGE><CATALOG_ID>TEST</CATALOG_ID><CURRENCY>CHF</CURRENCY></CATALOG></HEADER>
  <T_NEW_CATALOG>
    <PRODUCT>
      <SUPPLIER_PID>EL-2040</SUPPLIER_PID>
      <PRODUCT_DETAILS><DESCRIPTION_SHORT>Prise T13 encastrée</DESCRIPTION_SHORT><DESCRIPTION_LONG>Blanc, 3 pôles</DESCRIPTION_LONG><INTERNATIONAL_PID type="gtin">7610000000024</INTERNATIONAL_PID></PRODUCT_DETAILS>
      <PRODUCT_ORDER_DETAILS><ORDER_UNIT>C62</ORDER_UNIT><PRICE_QUANTITY>10</PRICE_QUANTITY></PRODUCT_ORDER_DETAILS>
      <PRODUCT_PRICE_DETAILS>
        <PRODUCT_PRICE price_type="gros_list"><PRICE_AMOUNT>125.00</PRICE_AMOUNT><PRICE_CURRENCY>CHF</PRICE_CURRENCY><TAX>0.081</TAX></PRODUCT_PRICE>
        <PRODUCT_PRICE price_type="net_customer"><PRICE_AMOUNT>87.50</PRICE_AMOUNT><PRICE_CURRENCY>CHF</PRICE_CURRENCY></PRODUCT_PRICE>
      </PRODUCT_PRICE_DETAILS>
    </PRODUCT>
    <PRODUCT>
      <SUPPLIER_PID>EL-9999</SUPPLIER_PID>
      <PRODUCT_DETAILS><DESCRIPTION_SHORT>Article en euros</DESCRIPTION_SHORT></PRODUCT_DETAILS>
      <PRODUCT_PRICE_DETAILS><PRODUCT_PRICE price_type="net_list"><PRICE_AMOUNT>10</PRICE_AMOUNT><PRICE_CURRENCY>EUR</PRICE_CURRENCY></PRODUCT_PRICE></PRODUCT_PRICE_DETAILS>
    </PRODUCT>
  </T_NEW_CATALOG>
</BMECAT>`;
const BMECAT_12 = `<BMECAT version="1.2"><HEADER><CATALOG><CURRENCY>CHF</CURRENCY></CATALOG></HEADER><T_NEW_CATALOG>
  <ARTICLE><SUPPLIER_AID>PE-10</SUPPLIER_AID><ARTICLE_DETAILS><DESCRIPTION_SHORT>Peinture façade 10 l</DESCRIPTION_SHORT><EAN>7610000000031</EAN></ARTICLE_DETAILS>
  <ARTICLE_ORDER_DETAILS><ORDER_UNIT>PCE</ORDER_UNIT></ARTICLE_ORDER_DETAILS>
  <ARTICLE_PRICE_DETAILS><ARTICLE_PRICE price_type="net_list"><PRICE_AMOUNT>89,90</PRICE_AMOUNT></ARTICLE_PRICE></ARTICLE_PRICE_DETAILS></ARTICLE>
</T_NEW_CATALOG></BMECAT>`;
const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml').documentElement as unknown as XmlNode;

const SUBMISSION_COLUMNS = [
  '211     Fouilles et terrassements',
  '211.100 Décapage',
  '211.111  Décapage de la terre végétale, épaisseur 20 cm    m2   420',
  '211.112  Évacuation en décharge                            m3   84.5',
  '314     Peinture',
  '314.211  Dispersion intérieure, 2 couches                  m2   1\'250   18.50',
].join('\n');
const SUBMISSION_CSV = [
  'Position;Texte;Unité;Quantité;Prix unitaire',
  '241;Plâtrerie;;;',
  '241.111;Enduit au plâtre sur maçonnerie;m2;350;',
  '241.212;Faux plafond plaques de plâtre;m2;80;62.00',
].join('\r\n');

describe('formats d’échange du bâtiment', () => {
  it('lit Datanorm : articles, EAN, prix nets, unité de prix, textes longs et suppressions', () => {
    const catalog = parseDatanorm(DATANORM);
    expect(catalog.articles.map(article => article.sku)).toEqual(['100200', '100300']);
    expect(catalog.articles[0]).toMatchObject({ name: 'Tube cuivre 15 mm barre 5 m', unit: 'm', salesPriceCents: 1_590, purchaseCostCents: 1_190, ean: '7610000000017', description: 'Tube cuivre écroui selon SN EN 1057' });
    // Preiseinheit 2 = prix pour 100 pièces.
    expect(catalog.articles[1]).toMatchObject({ unit: 'pièce', salesPriceCents: 245, purchaseCostCents: 19_800 });
    expect(catalog.warnings.join(' ')).toContain('1 article(s)');
    expect(() => parseDatanorm('rien;de;tel')).toThrow();
  });

  it('lit BMEcat 2005 et 1.2, ignore les autres devises', () => {
    const catalog = parseBmecat(BMECAT, parseXml);
    expect(catalog.articles).toEqual([{ sku: 'EL-2040', name: 'Prise T13 encastrée', description: 'Blanc, 3 pôles', unit: 'pièce', salesPriceCents: 1_250, purchaseCostCents: 875, ean: '7610000000024', vatBp: 810 }]);
    expect(catalog.warnings[0]).toContain('autre devise');
    expect(parseBmecat(BMECAT_12, parseXml).articles[0]).toMatchObject({ sku: 'PE-10', salesPriceCents: 8_990, purchaseCostCents: 8_990, ean: '7610000000031' });
    expect(() => parseBmecat('<catalogue/>', parseXml)).toThrow();
  });

  it('lit une soumission NPK en colonnes et en CSV, avec chapitres et titres', () => {
    const columns = parseNpkText(SUBMISSION_COLUMNS);
    expect(columns.chapters.get('211')).toBe('Fouilles et terrassements');
    expect(columns.chapters.get('211.100')).toBe('Décapage');
    expect(columns.positions).toEqual([
      { number: '211.111', chapter: '211', text: 'Décapage de la terre végétale, épaisseur 20 cm', unit: 'm²', quantity: 420, unitPriceCents: null },
      { number: '211.112', chapter: '211', text: 'Évacuation en décharge', unit: 'm³', quantity: 84.5, unitPriceCents: null },
      { number: '314.211', chapter: '314', text: 'Dispersion intérieure, 2 couches', unit: 'm²', quantity: 1_250, unitPriceCents: 1_850 },
    ]);
    const csv = parseNpkText(SUBMISSION_CSV);
    expect(csv.chapters.get('241')).toBe('Plâtrerie');
    expect(csv.positions[1]).toMatchObject({ number: '241.212', quantity: 80, unitPriceCents: 6_200 });
    const lines = submissionLines(csv);
    expect(lines[0]).toEqual({ sectionTitle: '241 Plâtrerie', description: '241.111 Enduit au plâtre sur maçonnerie', quantity: 350, unit: 'm²', unitPriceCents: 0 });
    expect(npkCatalog(csv).articles[1]).toMatchObject({ sku: '241.212', name: 'Faux plafond plaques de plâtre', unit: 'm²', salesPriceCents: 6_200 });
    expect(() => parseNpkText('pas de position ici')).toThrow();
  });

  it('exporte l’offre chiffrée dans l’ordre du devis, chapitres compris', () => {
    const text = offerExport([
      { sectionTitle: '241 Plâtrerie', description: '241.111 Enduit au plâtre sur maçonnerie', quantity: 350, unit: 'm²', unitPriceCents: 3_400 },
      { sectionTitle: '241 Plâtrerie', description: '241.212 Faux plafond; plaques', quantity: 80, unit: 'm²', unitPriceCents: 6_200, discountBp: 500 },
      { sectionTitle: null, description: 'Nettoyage final', quantity: 1, unit: 'forfait', unitPriceCents: 45_000 },
    ], 'Offre Villa Dupont');
    const rows = text.replace('﻿', '').split('\r\n');
    expect(rows[0]).toBe('Offre Villa Dupont');
    expect(rows[2]).toBe('241;Plâtrerie;;;;;');
    expect(rows[3]).toBe('241.111;Enduit au plâtre sur maçonnerie;m²;350;34.00;0;11900.00');
    expect(rows[4]).toBe('241.212;"Faux plafond; plaques";m²;80;62.00;5;4712.00');
    expect(rows[5]).toBe(';Nettoyage final;forfait;1;450.00;0;450.00');
  });

  it('reconnaît le format et les unités', () => {
    expect(detectTradeFormat('cat.001', DATANORM)).toBe('datanorm');
    expect(detectTradeFormat('catalogue.xml', BMECAT)).toBe('bmecat');
    expect(detectTradeFormat('soumission.01s', 'x')).toBe('npk');
    expect(detectTradeFormat('lv.txt', SUBMISSION_COLUMNS)).toBe('npk');
    expect(detectTradeFormat('liste.csv', 'Référence;Désignation;Prix')).toBeNull();
    expect(['Stck', 'M2', 'MTQ', 'KGM', 'Std', 'psch', 'Zz'].map(tradeUnit)).toEqual(['pièce', 'm²', 'm³', 'kg', 'h', 'forfait', 'zz']);
  });
});
