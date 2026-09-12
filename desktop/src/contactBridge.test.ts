import { afterEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi } from './bridge';
afterEach(() => invoke.mockReset());
it('preserves real, empty and legacy contact names without inventing a company contact', async () => {
  invoke.mockImplementation(async command => {
    if (command === 'get_app_state') return { onboarding_completed: true };
    if (command === 'get_workspace') return { clients: [
      { id: 'person', name: 'Nom historique', contact_person: null, company: null },
      { id: 'company', name: 'Entreprise', contact_person: '', company: 'Entreprise' },
      { id: 'legacy-company', name: 'Entreprise historique', contact_person: null, company: 'Entreprise historique' },
      { id: 'contact', name: 'Entreprise', contact_person: 'Camille', company: 'Entreprise' },
    ] };
    throw new Error(`Unexpected command ${command}`);
  });
  const workspace = await desktopApi.loadWorkspace();
  expect(workspace.clients.map(row => [row.id, row.contactPerson])).toEqual([['person','Nom historique'], ['company',''], ['legacy-company',''], ['contact','Camille']]);
});
