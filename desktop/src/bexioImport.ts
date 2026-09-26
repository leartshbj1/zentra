import { catalogHeaders, type CatalogMappingSource } from './catalogImport';

export const contactFields = {
  reference: 'N° du contact',
  company: 'Entreprise',
  lastName: 'Nom',
  firstName: 'Prénom',
  contact: 'Interlocuteur',
  email: 'E-mail',
  phone: 'Téléphone',
  street: 'Rue',
  streetNumber: 'Numéro de rue',
  addressExtra: 'Complément d’adresse',
  postalCode: 'Code postal',
  city: 'Ville',
  country: 'Pays',
  notes: 'Notes',
  primary: 'Adresse principale',
} as const;
export type ContactField = keyof typeof contactFields;
export type ContactTarget = 'clients' | 'suppliers';
export type BexioContactRow = {
  line: number;
  name: string;
  email: string;
  address: string;
  data: Record<string, string>;
  errors: string[];
  duplicate: boolean;
};
export type BexioReceipt = {
  created: number;
  skipped: number;
  rows: { line: number; name: string; status: 'created' | 'skipped' }[];
};
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const aliases: Record<ContactField, string[]> = {
  reference: [
    'no du contact',
    'n du contact',
    'numero du contact',
    'contact number',
    'kontaktnummer',
    'nr',
    'no contact',
  ],
  company: [
    'entreprise',
    'societe',
    'company',
    'firma',
    'unternehmen',
    'azienda',
  ],
  lastName: ['nom', 'name', 'last name', 'nachname', 'cognome'],
  firstName: ['prenom', 'first name', 'vorname', 'nome'],
  contact: [
    'interlocuteur',
    'contact person',
    'ansprechpartner',
    'persona di contatto',
  ],
  email: ['e mail', 'email', 'mail', 'e mail 1'],
  phone: ['telephone', 'telephone fixe', 'phone', 'telefon', 'telefono'],
  street: ['rue', 'adresse', 'address', 'street', 'strasse', 'indirizzo'],
  streetNumber: ['numero de rue', 'house number', 'hausnummer'],
  addressExtra: ['complement d adresse', 'address addition', 'adresszusatz'],
  postalCode: ['npa', 'code postal', 'postal code', 'postcode', 'plz', 'cap'],
  city: ['ville', 'city', 'ort', 'citta'],
  country: ['pays', 'country', 'land', 'paese'],
  notes: ['notes', 'remarques', 'bemerkungen', 'note'],
  primary: ['adresse principale', 'main address', 'hauptadresse'],
};
export function defaultContactMapping(headers: string[]): string[] {
  const used = new Set<string>();
  return headers.map((header) => {
    const key = normalize(header);
    const match = (Object.keys(aliases) as ContactField[]).find(
      (field) => !used.has(field) && aliases[field].includes(key),
    );
    if (match) used.add(match);
    return match ?? 'ignore';
  });
}
export function contactHeaderIndex(source: CatalogMappingSource) {
  let best = 0,
    score = 0;
  source.rows.slice(0, 20).forEach((_, index) => {
    const next = defaultContactMapping(catalogHeaders(source, index)).filter(
      (key) => key !== 'ignore',
    ).length;
    if (next > score) {
      best = index;
      score = next;
    }
  });
  return best;
}
function text(
  cell: CatalogMappingSource['rows'][number][number] | undefined,
): string {
  if (!cell) return '';
  if (typeof cell.value === 'string') return cell.value.trim();
  if (cell.displayText) return cell.displayText.trim();
  if (typeof cell.value === 'number') return String(cell.value);
  if (cell.value && typeof cell.value === 'object') {
    const value = cell.value as {
      text?: string;
      result?: unknown;
      richText?: { text: string }[];
    };
    if (value.text) return value.text.trim();
    if (value.richText)
      return value.richText
        .map((p) => p.text)
        .join('')
        .trim();
    if (typeof value.result === 'number' || typeof value.result === 'string')
      return String(value.result).trim();
  }
  return '';
}
export function previewContacts(
  source: CatalogMappingSource,
  header: number,
  mapping: string[],
  target: ContactTarget,
  existingNames: string[],
): BexioContactRow[] {
  const headers = catalogHeaders(source, header),
    mapped = mapping.filter((value) => value !== 'ignore');
  if (
    mapping.length !== headers.length ||
    new Set(mapped).size !== mapped.length ||
    mapped.some((key) => !Object.hasOwn(contactFields, key))
  )
    throw Error('Chaque champ doit correspondre à une seule colonne.');
  if (!mapped.includes('company') && !mapped.includes('lastName'))
    throw Error('Choisissez la colonne Entreprise ou Nom.');
  const seen = new Set(
    existingNames.map((value) =>
      value.trim().replace(/\s+/g, ' ').toLowerCase(),
    ),
  );
  const prepared = source.rows
    .slice(header + 1)
    .map((cells, index) => ({ cells, line: header + index + 2 }))
    .filter(({ cells }) => cells.some((cell) => text(cell) !== ''));
  if (prepared.length > 5000)
    throw Error('Importez au maximum 5 000 contacts à la fois.');
  const column = (cells: (typeof source.rows)[number], key: ContactField) =>
    text(cells[mapping.indexOf(key)]);
  // The main address wins only inside this reviewed import, never over an existing fiche.
  prepared.sort(
    (a, b) =>
      Number(column(b.cells, 'primary') === '1') -
      Number(column(a.cells, 'primary') === '1'),
  );
  return prepared.map(({ cells, line }) => {
    const value = (key: ContactField) => column(cells, key),
      person = [value('firstName'), value('lastName')]
        .filter(Boolean)
        .join(' ');
    const name = value('company') || person,
      email = value('email'),
      street = [value('street'), value('streetNumber')]
        .filter(Boolean)
        .join(' ');
    const address = [
      street,
      value('addressExtra'),
      [value('postalCode'), value('city')].filter(Boolean).join(' '),
      value('country'),
    ]
      .filter(Boolean)
      .join('\n');
    const notes = [
      value('reference')
        ? `Import bexio · contact ${value('reference')}`
        : 'Import bexio',
      value('notes'),
    ]
      .filter(Boolean)
      .join('\n');
    const contact = value('contact') || (value('company') ? person : '');
    const common = { name, email, phone: value('phone'), notes };
    const data: Record<string, string> =
      target === 'clients'
        ? {
            ...common,
            company: value('company'),
            contact_person: contact,
            address_line1: street,
            address_line2: value('addressExtra'),
            postal_code: value('postalCode'),
            city: value('city'),
            country: value('country'),
          }
        : { ...common, contact_name: contact, address };
    const errors: string[] = [];
    if (!name || name.length > 200) errors.push('Nom manquant ou trop long');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      errors.push('E-mail à corriger');
    if (
      email.length > 254 ||
      value('phone').length > 80 ||
      address.length > 1000 ||
      Object.values(data).some((v) => v.length > 10000 || v.includes('\0'))
    )
      errors.push('Une coordonnée dépasse la taille acceptée');
    const key = name.trim().replace(/\s+/g, ' ').toLowerCase(),
      duplicate = seen.has(key);
    if (!errors.length) seen.add(key);
    return { line, name, email, address, data, errors, duplicate };
  });
}
