// Synthetic UI only. No user workspace, native calls or remote mutations.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CatalogItemForm } from '../src/CatalogItemForm';
import { TimeForm } from '../src/WorkTimeForms';
import { DocumentEditor } from '../src/DocumentEditor';
import { ClientForm } from '../src/ContactForms';
import { FormDraftIdentityProvider } from '../src/useFormDraft';
import { desktopApi } from '../src/bridge';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { setAppLanguage } from '../src/language';
import type { Workspace } from '../src/types';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/apple-workspace.css';
import '../src/apple-business.css';
import '../src/apple-operational.css';
import '../src/apple-secondary.css';

const query = new URLSearchParams(location.search), companyId = query.get('company') || 'qa-drafts-company', memberId = query.get('member') || 'qa-drafts-member';
await setAppLanguage((query.get('language') || 'fr') as 'fr' | 'de' | 'it' | 'en');
const collections = ['clients', 'catalogItems', 'stockMovements', 'suppliers', 'projects', 'projectMilestones', 'projectTasks', 'agendaEvents', 'quotes', 'invoices', 'payments', 'employees', 'timeEntries', 'timeBillingEntries', 'timeBillingBatches', 'accounts', 'expenses'];
let data = JSON.parse(sessionStorage.getItem(`form-fixture.${companyId}`) || 'null') || {
  ...Object.fromEntries(collections.map(key => [key, []])), settings: structuredClone(initialOnboardingSettings), workNotesScope: companyId,
  clients: [{ id: 'client-1', name: 'Client de test', company: 'Client de test', email: '', phone: '', address: 'Rue du Test 1', addressLine1: 'Rue du Test', postalCode: '1000', city: 'Lausanne', country: 'CH', notes: '' }],
  projects: [{ id: 'project-1', clientId: 'client-1', name: 'Projet de test', status: 'planned' }],
  employees: [{ id: 'employee-1', name: 'Collaborateur de test', active: true, hourlyCostCents: 4500 }],
} as Workspace;
data.settings!.organization.legalName = 'Entreprise de test';
const fixture = { attempts: 0, writes: 0, fail: false, patch: (_patch: Partial<Workspace>) => {} };
Object.assign(window, { formDraftsFixture: fixture });
const persist = () => sessionStorage.setItem(`form-fixture.${companyId}`, JSON.stringify(data));
const save = () => { fixture.attempts++; if (fixture.fail) throw new Error('Network connection lost'); fixture.writes++; persist(); return structuredClone(data); };
desktopApi.saveCatalogItem = async (id, input) => { if (!fixture.fail) data.catalogItems.push({ id, ...input, archivedAt: null, stockQuantityMilli: 0, createdAt: '2026-10-01', updatedAt: '2026-10-01' } as never); return save(); };
desktopApi.saveDocument = async (entity, input, lines, item) => { if (!fixture.fail) data[entity].push({ id: item?.id || crypto.randomUUID(), ...input, lines, number: '', createdAt: '2026-10-01' } as never); return save(); };
desktopApi.createEntity = async (entity, input) => { if (!fixture.fail) (data[entity as keyof Workspace] as unknown[]).push({ id: crypto.randomUUID(), ...input }); return save(); };
desktopApi.loadWorkspace = async () => structuredClone(data);

function Fixture() {
  const [workspace, setWorkspace] = useState<Workspace>(data), [form, setForm] = useState('');
  fixture.patch = patch => { data = { ...data, ...patch }; persist(); setWorkspace(structuredClone(data)); };
  const close = () => setForm('');
  const act = async (action: () => Promise<Workspace>, _message: string, shouldClose?: boolean, onError?: (reason: unknown) => void) => {
    try { const next = await action(); setWorkspace(next); if (shouldClose) close(); return true; }
    catch (reason) { onError?.(reason); return false; }
  };
  return <FormDraftIdentityProvider companyId={companyId} memberId={memberId} ready><main className="desktop-app workspace-app" style={{ padding: 20 }}><h1>Form recovery fixture</h1>{['catalog', 'time', 'document', 'client'].map(kind => <button key={kind} className="button button--secondary" onClick={() => setForm(kind)}>{kind}</button>)}
    {form === 'catalog' && <CatalogItemForm workspace={workspace} busy={false} readOnly={false} close={close} act={act} onReadWorkspace={desktopApi.loadWorkspace} />}
    {form === 'time' && <TimeForm workspace={workspace} busy={false} close={close} act={act} />}
    {form === 'document' && <DocumentEditor entity="quotes" workspace={workspace} busy={false} close={close} act={act} />}
    {form === 'client' && <ClientForm workspace={workspace} busy={false} close={close} act={act} />}
  </main></FormDraftIdentityProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
