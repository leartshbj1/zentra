// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppLanguage } from './language';
const fixture = vi.hoisted(() => ({ language: 'fr' as AppLanguage, state: {} as Record<string, unknown> }));
vi.mock('./language', async importOriginal => ({ ...await importOriginal<typeof import('./language')>(), useAppLanguage: () => fixture.language }));
vi.mock('./diagnostics', () => ({ resolveErrorIncident: () => ({ code: 'ZT-cloud-restore-incident' }) }));
vi.mock('./bridge', () => ({ desktopApi: { getCloudBackupState: vi.fn(async () => fixture.state) } }));
import { CloudBackupPanel } from './CloudBackupPanel';
import { appLanguages } from './language';
import { userErrorCopy } from './userErrors';

let root: Root | undefined;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); fixture.language = 'fr'; vi.clearAllMocks(); });
async function mount(onRestore: (backupId: string) => Promise<void> = vi.fn(async () => {})) {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root?.render(<CloudBackupPanel onRestore={onRestore} />));
  return host;
}
const pending = 'Une restauration doit être reprise avant de rouvrir l’entreprise. Les fichiers disponibles sont conservés. Fermez puis rouvrez Zentra. Si le problème persiste, contactez le support sans supprimer le dossier local.';
const committed = 'La restauration est terminée et les données sont enregistrées. Le nettoyage des anciennes copies n’a pas pu se terminer. Fermez puis rouvrez Zentra pour le reprendre. Si ce message revient, contactez le support.';
describe('cloud restore error presentation', () => {
  it.each(appLanguages)('presents error and last_error in %s without native replay', async language => {
    fixture.language = language;
    const expected = { fr: ['Restauration à reprendre', 'Restauration terminée'], de: ['Wiederherstellung fortsetzen', 'Wiederherstellung abgeschlossen'], it: ['Ripristino da riprendere', 'Ripristino completato'], en: ['Restore needs to resume', 'Restore completed'] };
    for (const [index, field] of ['error', 'last_error'].entries()) {
      fixture.state = { connected: false, backups: [], [field]: index === 0 ? pending : committed };
      const host = await mount();
      const alert = host.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(expected[language][index]);
      expect(alert?.textContent).not.toContain(userErrorCopy(language).validation.action);
      expect(alert?.textContent).not.toContain(userErrorCopy(language).uncertain);
      if (language !== 'fr') expect(alert?.textContent).not.toContain(index === 0 ? pending : committed);
      expect(host.querySelector('details')?.open).toBe(false);
      expect(host.textContent).toContain('ZT-cloud-restore-incident');
      expect(host.querySelector('.error-guidance__actions')).toBeNull();
      await act(async () => root?.unmount()); root = undefined; host.remove();
    }
  });
  it('keeps the existing error priority and unrelated error presentation', async () => {
    fixture.state = { connected: false, backups: [], error: 'Unrelated cloud error', last_error: committed };
    const host = await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Unrelated cloud error');
    expect(host.querySelector('.error-guidance')).toBeNull();
  });
  it.each(appLanguages)('presents the actual confirmed restore rejection in %s and never replays it', async language => {
    fixture.language = language;
    fixture.state = { connected: true, running: false, backups: [{ backup_id: 'closed-backup-id', state: 'complete', created_at: '2026-10-04T12:00:00Z', size_bytes: 2048, app_version: '1.90.13', installation_id: 'fixture-device' }] };
    const onRestore = vi.fn(async () => { throw committed; });
    const host = await mount(onRestore);
    const choose = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Restaurer');
    expect(choose).toBeDefined();
    await act(async () => { choose?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent?.trim() === 'Restaurer cette copie');
    expect(confirm).toBeDefined();
    await act(async () => { confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const expected = { fr: 'Restauration terminée', de: 'Wiederherstellung abgeschlossen', it: 'Ripristino completato', en: 'Restore completed' };
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(expected[language]);
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain(userErrorCopy(language).uncertain);
    expect(host.querySelector('details')?.textContent).toContain(committed);
    expect(host.textContent).toContain('ZT-cloud-restore-incident');
    expect(host.querySelector('.error-guidance__actions')).toBeNull();
    expect(onRestore).toHaveBeenCalledTimes(1); expect(onRestore).toHaveBeenCalledWith('closed-backup-id');
  });
});
