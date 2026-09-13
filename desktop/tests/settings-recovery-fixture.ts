import { desktopApi } from '../src/bridge';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import type { Workspace } from '../src/types';

export function installSettingsRecoveryFixture(workspace: Workspace) {
  let stored = JSON.parse(sessionStorage.getItem('settings-recovery-stored') || 'null') as Workspace | null;
  if (stored) Object.assign(workspace, structuredClone(stored)); else stored = structuredClone(workspace);
  let readsLeft = 0;
  const persist = () => sessionStorage.setItem('settings-recovery-stored', JSON.stringify(stored));
  const count = (key: string) => sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1));
  desktopApi.loadWorkspace = async () => {
    count('settings-recovery-reads');
    if (readsLeft > 0) { readsLeft--; throw new Error('La lecture des réglages est momentanément indisponible.'); }
    if (sessionStorage.getItem('settings-recovery-empty') === '1') return { ...structuredClone(stored!), onboardingCompleted:false, settings:null } as Workspace;
    return structuredClone(stored!);
  };
  desktopApi.saveSettings = async settings => {
    count('settings-recovery-attempts');
    if (sessionStorage.getItem('settings-recovery-mode') === 'refuse') throw new Error('Vérifiez les coordonnées de l’entreprise avant d’enregistrer.');
    if (sessionStorage.getItem('settings-recovery-mode') === 'hold') await new Promise<void>(resolve => window.addEventListener('settings-recovery-release', () => resolve(), { once:true }));
    stored!.settings = structuredClone(settings); persist(); count('settings-recovery-writes');
    if (sessionStorage.getItem('settings-recovery-mode') === 'refresh') readsLeft = 3;
    return refreshWorkspaceAfterMutation(() => desktopApi.loadWorkspace());
  };
  desktopApi.documentDesignExample = async input => {
    if (input.kind === 'invoices' && sessionStorage.getItem('settings-recovery-logo') === '1') throw new Error('Le logo du document est introuvable. Réimportez-le dans les paramètres.');
    const response = await fetch(`/native-design-fixture/${input.kind}-${input.style.composition?.fontFamily || input.style.layout}.pdf`);
    if (!response.ok) throw new Error('Exemple de recette indisponible.');
    return [...new Uint8Array(await response.arrayBuffer())];
  };
  desktopApi.exportData = async () => { count('settings-recovery-exports'); return { path:'recette-parametres.json' }; };
  Object.assign(window, { __qaSettingsRecovery: { clearReads: () => { readsLeft = 0; }, stored: () => structuredClone(stored) } });
}
