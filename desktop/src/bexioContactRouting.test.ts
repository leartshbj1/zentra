import { describe, expect, it } from 'vitest';
import { Workbook } from 'exceljs';
import { catalogHeaders, catalogMappingSource, previewCatalogFile } from './catalogImport';
import * as contacts from './bexioImport';

const contactScore = contacts.contactHeaderScore;
const readContacts = async (file: File) => {
  const source = await catalogMappingSource(file, contactScore);
  const header = contacts.contactHeaderIndex(source);
  return {
    source,
    rows: contacts.previewContacts(source, header, contacts.defaultContactMapping(catalogHeaders(source, header)), 'clients', []),
  };
};
const file = (text: string, name = 'contacts.csv') => ({ name, size: Buffer.byteLength(text), text: async () => text } as File);
const xlsxFile = async (book: Workbook) => {
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  return {name:'contacts.xlsx',size:bytes.byteLength,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)} as File;
};

describe('contact import chooses its actual columns and worksheet', () => {
  it.each([
    ['French company punctuation', 'Entreprise;E-mail;Notes\nAtelier, Conseil, Services, Léman;atelier@example.test;Suisse', 'Atelier, Conseil, Services, Léman'],
    ['French notes punctuation', 'Entreprise;E-mail;Notes\nAtelier du Léman;atelier@example.test;Genève, Lausanne, Berne, Zürich, Bâle', 'Atelier du Léman'],
    ['German headers', 'Firma;E-Mail;Bemerkungen\nMuster, Service, Zürich, Bern;atelier@example.test;Schweiz', 'Muster, Service, Zürich, Bern'],
    ['Italian headers', 'Azienda;E-mail;Note\nEsempio, Servizi, Lugano, Locarno;atelier@example.test;Svizzera', 'Esempio, Servizi, Lugano, Locarno'],
  ])('reads semicolon contacts despite commas in %s', async (_, text, name) => {
    const {rows} = await readContacts(file(text));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({name,email:'atelier@example.test',errors:[]});
  });
  it.each([
    ['Entreprise;E-mail\n"Atelier, Services";atelier@example.test', 'contacts.csv'],
    ['Entreprise,E-mail\nAtelier Services,atelier@example.test', 'contacts.csv'],
    ['Entreprise\tE-mail\nAtelier Services\tatelier@example.test', 'contacts.tsv'],
  ])('keeps quoted CSV, comma CSV and explicit TSV supported', async (text, name) => {
    const {rows} = await readContacts(file(text, name));
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('atelier@example.test');
    expect(rows[0].errors).toEqual([]);
  });
  it('finds contacts after a cover and preserves formatted identifiers and phone text', async () => {
    const book = new Workbook();
    book.addWorksheet('Présentation').addRow(['Export de contacts']);
    const sheet = book.addWorksheet('Contacts');
    sheet.addRow(['Entreprise','E-mail','Nº du contact','NPA','Téléphone']);
    sheet.addRow(['Atelier du Léman','atelier@example.test',42,123,'022 000 00 00']);
    sheet.getCell('C2').numFmt='00000';
    sheet.getCell('D2').numFmt='0000';
    const {source,rows} = await readContacts(await xlsxFile(book));
    expect(source.sheetName).toBe('Contacts');
    expect(rows[0].data).toMatchObject({name:'Atelier du Léman',email:'atelier@example.test',phone:'022 000 00 00',postal_code:'0123',notes:'Import bexio · contact 00042'});
    expect(rows[0].errors).toEqual([]);
  });
  it('chooses contacts even when the first readable sheet is a catalogue', async () => {
    const book = new Workbook();
    const catalogue=book.addWorksheet('Articles');
    catalogue.addRow(['Référence','Désignation','Prix de vente']);
    catalogue.addRow(['A-1','Article',12.5]);
    const sheet=book.addWorksheet('Contacts');
    sheet.addRow(['Firma','E-Mail']);
    sheet.addRow(['Muster AG','atelier@example.test']);
    const {source,rows}=await readContacts(await xlsxFile(book));
    expect(source.sheetName).toBe('Contacts');
    expect(rows[0]).toMatchObject({name:'Muster AG',email:'atelier@example.test',errors:[]});
  });
  it.each(['Entreprise','Company'])('prefers complete contact headers over a cover labelled %s', async word => {
    const book=new Workbook();
    book.addWorksheet('Présentation').addRow([word]);
    const sheet=book.addWorksheet('Contacts');
    sheet.addRow(['Entreprise','E-mail']);
    sheet.addRow(['Atelier du Léman','atelier@example.test']);
    const {source,rows}=await readContacts(await xlsxFile(book));
    expect(source.sheetName).toBe('Contacts');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({name:'Atelier du Léman',email:'atelier@example.test',errors:[]});
  });
  it('keeps a one-column company sheet usable when no more complete header exists', async () => {
    const book=new Workbook();
    const sheet=book.addWorksheet('Entreprises');
    sheet.addRow(['Entreprise']);
    sheet.addRow(['Atelier du Léman']);
    book.addWorksheet('Présentation').addRow(['Informations générales']);
    const {source,rows}=await readContacts(await xlsxFile(book));
    expect(source.sheetName).toBe('Entreprises');
    expect(rows[0]).toMatchObject({name:'Atelier du Léman',email:'',errors:[]});
  });
  it('keeps the first readable-sheet fallback available for manual mapping', async () => {
    const book=new Workbook();
    const sheet=book.addWorksheet('Fiches');
    sheet.addRow(['Libellé export spécifique']);
    sheet.addRow(['Atelier du Léman']);
    book.addWorksheet('Autre').addRow(['Informations générales']);
    const source=await catalogMappingSource(await xlsxFile(book),contactScore);
    expect(source.sheetName).toBe('Fiches');
    expect(contacts.previewContacts(source,0,['company'],'clients',[])[0]).toMatchObject({name:'Atelier du Léman',errors:[]});
  });
  it('keeps the existing catalogue reader and its price semantics unchanged', async () => {
    const book = new Workbook();
    const contactsSheet=book.addWorksheet('Contacts');
    contactsSheet.addRow(['Entreprise','E-mail']);
    contactsSheet.addRow(['Atelier','atelier@example.test']);
    const catalogue=book.addWorksheet('Articles');
    catalogue.addRow(['Référence','Désignation','Prix de vente','TVA']);
    catalogue.addRow([42,'Conseil, Services, Léman',12.5,0.081]);
    catalogue.getCell('A2').numFmt='00000';
    catalogue.getCell('D2').numFmt='0.0%';
    const preview=await previewCatalogFile(await xlsxFile(book));
    expect(preview.sheetName).toBe('Articles');
    expect(preview.rows[0]).toMatchObject({sku:'00042',name:'Conseil, Services, Léman',salesPriceCents:1250,vatBp:810,errors:[]});
  });
});
