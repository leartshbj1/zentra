import { desktopApi } from '../src/bridge';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import type { Workspace } from '../src/types';

export function installContactFolderFixture(data: Workspace) {
  const previous = sessionStorage.getItem('qa-contact-store');
  if (previous) Object.assign(data, JSON.parse(previous));
  else {
    data.clients = [{ id: 'client-folder', name: 'Camille Exemple', contactPerson: 'Camille Exemple', company: 'Atelier du Lac', email: 'camille@example.invalid', phone: '', address: 'Rue du Lac 7, Lausanne', addressLine1: 'Rue du Lac', buildingNumber: '7', postalCode: '1000', city: 'Lausanne', country: 'CH', canton: 'VD', uidNumber: '', notes: 'Première ligne\nDeuxième ligne', archivedAt: null }, { ...data.clients[0], id: 'other', name: 'Autre client', company: 'Entreprise distincte' }];
    data.projects = [{ id: 'contact-project', clientId: 'client-folder', name: 'Projet du Lac', status: 'planned', address: '', plannedStart: '', plannedEnd: '', actualStart: '', actualEnd: '', plannedMinutes: 0, budgetCents: 0, notes: '', hourlyRateCents: 0 }] as Workspace['projects'];
    const line = { id: 'line', description: 'Prestation de recette', quantity: 1, unit: 'h', unitPriceCents: 10000, vatRateBp: 810, discountBp: 0 };
    const base = { clientId: 'client-folder', projectId: null, title: 'Étude du dossier', status: 'draft', currency: 'CHF', issueDate: '2026-09-01', notes: '', footer: '', lines: [line], updatedAt: '2026-09-12T00:00:00Z' };
    data.quotes = Array.from({ length: 12 }, (_, index) => ({ ...base, id: `contact-quote-${index}`, number: `D-${index}`, validUntil: '2026-09-30', createdAt: `2026-09-${String(20-index).padStart(2,'0')}T10:00:00Z`, issueDate: index === 0 ? '2026-01-01' : '2026-09-01', title: index === 11 ? 'Devis ancien à retrouver' : 'Étude du dossier' })) as Workspace['quotes'];
    data.invoices = [{ ...base, id: 'contact-invoice', number: 'F-1', type: 'standard', dueDate: '2026-09-30', createdAt: '2026-09-21T10:00:00Z', quoteId: null }, { ...base, id: 'contact-pair', number: 'F-LIEE', type: 'deposit', dueDate: '2026-09-30', createdAt: '2026-09-22T10:00:00Z', quoteId: 'contact-quote-1', depositPercentageBp: 3000 }] as Workspace['invoices'];
    data.quotes.push({ ...data.quotes[0], id: 'other-quote', number: 'AUTRE-CLIENT', clientId: 'other' });
    data.suppliers = [];
  }
  const stored = structuredClone(data);
  const record = (key: string, value: unknown) => sessionStorage.setItem(`qa-contact-${key}`, JSON.stringify([...JSON.parse(sessionStorage.getItem(`qa-contact-${key}`) || '[]'), value]));
  const persist = () => sessionStorage.setItem('qa-contact-store', JSON.stringify(stored)); persist();
  desktopApi.loadWorkspace = async () => {
    if (sessionStorage.getItem('qa-contact-block-reads')) throw new Error('Lecture momentanément interrompue.');
    return structuredClone(stored);
  };
  async function write(entity: string, input: Record<string, unknown>, id?: string) {
    if (!['clients', 'suppliers'].includes(entity)) throw new Error('Only synthetic contacts are writable here.');
    record('attempts', { entity, id, input });
    const mode = sessionStorage.getItem('qa-contact-failure'); sessionStorage.removeItem('qa-contact-failure');
    if (mode === 'reject') throw new Error('Enregistrement momentanément indisponible.');
    if (mode === 'iban') throw new Error('iban doit être un IBAN CH ou LI ou null.');
    const rows = entity === 'clients' ? stored.clients : stored.suppliers;
    const existing = rows.find(row => row.id === id);
    const values = entity === 'clients' && Object.hasOwn(input, 'contactPerson') ? { ...input, name: input.contactPerson || input.name, contactPerson: input.contactPerson, address: [input.addressLine1, input.addressLine2, input.postalCode, input.city, input.country].filter(Boolean).join(' '), buildingNumber: input.addressLine2 } : input;
    if (existing) Object.assign(existing, values);
    else rows.push({ ...values, id: crypto.randomUUID(), archivedAt: null } as never);
    record('writes', { entity, id, input }); persist();
    if (mode === 'refresh') sessionStorage.setItem('qa-contact-block-reads', '1');
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  }
  desktopApi.createEntity = (entity, input) => write(entity, input);
  desktopApi.updateEntity = (entity, id, input) => write(entity, input, id);
  desktopApi.archiveEntity = (entity, id) => write(entity, { archivedAt: '2026-09-12T10:00:00Z' }, id);
}
