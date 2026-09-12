import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';

// Capture production functions before the harness replaces its default APIs.
const nativeCreate = desktopApi.createEntity;
const nativeLoad = desktopApi.loadWorkspace;
export function installCreationOutcomeFixture(data: Workspace) {
  const stored = JSON.parse(sessionStorage.getItem('qa-creation-store') || '{"clients":[],"suppliers":[]}');
  stored.settings = { company_name: 'Atelier de recette', owner_name: 'Compte de test', country: 'CH', canton: 'VD', currency: 'CHF', noga_section: 'M', noga_division: '68', activity_description: 'Services professionnels', extra_settings_json: JSON.stringify(data.settings) };
  data.clients = stored.clients;
  data.suppliers = stored.suppliers;
  const record = (key: string, item: unknown) => sessionStorage.setItem(`qa-creation-${key}`, JSON.stringify([...JSON.parse(sessionStorage.getItem(`qa-creation-${key}`) || '[]'), item]));
  const persist = () => sessionStorage.setItem('qa-creation-store', JSON.stringify(stored)); persist();
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { entity: string; data: Record<string, unknown> }) => {
    if (command === 'get_app_state' || command === 'get_workspace') {
      record('reads', command);
      if (sessionStorage.getItem('qa-creation-block-reads')) throw new Error('Lecture momentanément interrompue.');
      if (command === 'get_app_state') return { onboarding_completed: !sessionStorage.getItem('qa-creation-empty-onboarding') };
      return structuredClone(stored);
    }
    if (command !== 'create_record' || !['clients','suppliers'].includes(args.entity)) throw new Error(`Commande hors de cette recette : ${command}`);
    record('attempts', args);
    const mode = sessionStorage.getItem('qa-creation-failure'); sessionStorage.removeItem('qa-creation-failure');
    if (mode === 'refused-unreadable') { sessionStorage.setItem('qa-creation-block-reads','1'); throw new Error('iban doit être un IBAN CH ou LI ou null.'); }
    if (mode === 'refused') throw new Error('Enregistrement refusé. Votre saisie est conservée.');
    if (!args.data.id) throw new Error('La création doit fournir son identifiant.');
    if (stored[args.entity].some((row: { id: string }) => row.id === args.data.id)) throw new Error('Identifiant déjà présent.');
    stored[args.entity].push({ ...args.data, created_at: new Date().toISOString() });
    record('writes', args); persist();
    if (mode === 'lost-unreadable' || mode === 'confirmed-unreadable') sessionStorage.setItem('qa-creation-block-reads','1');
    if (mode === 'lost' || mode === 'lost-unreadable') throw new Error('Réponse de création perdue.');
    return structuredClone(args.data);
  } } });
  desktopApi.createEntity = nativeCreate;
  desktopApi.loadWorkspace = nativeLoad;
}
