// @vitest-environment jsdom
import './languageTestPacks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntegrationsSettings, integrationsApi, type IntegrationsOverview } from './IntegrationsSettings';

let root: Root, host: HTMLDivElement;
const overview = (keys: IntegrationsOverview['keys'] = []): IntegrationsOverview => ({
  apiBaseUrl: 'https://zentraapp.ch/api/v1', mcpUrl: 'https://zentraapp.ch/api/mcp', projection: null, pendingDrafts: 0,
  keys, webhooks: [], shops: [], postal: null,
});
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === label)!;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it('creates an API key from the app and shows its token only once', async () => {
  const read = vi.spyOn(integrationsApi, 'overview').mockResolvedValueOnce(overview())
    .mockResolvedValueOnce(overview([{ keyId: 'key_1', name: 'Site internet', prefix: 'zk_live_ab12', scopes: 'read', lastUsedAt: null }]));
  const action = vi.spyOn(integrationsApi, 'action').mockResolvedValue({ token: 'zk_live_secret' });
  await act(async () => root.render(<IntegrationsSettings disabled={false} />));
  expect(host.textContent).toContain('Aucune clé pour le moment.');
  const name = host.querySelector<HTMLInputElement>('input[placeholder="Par exemple : site internet"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Site internet'); name.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { button('Créer la clé').closest('form')!.requestSubmit(); });
  expect(action).toHaveBeenCalledWith({ action: 'create-key', name: 'Site internet', scopes: 'read' });
  expect(host.textContent).toContain('zk_live_secret');
  expect(host.textContent).toContain('Site internet');
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => button('C’est noté').click());
  expect(host.textContent).not.toContain('zk_live_secret');
});

it('keeps every field locked in read-only mode and shows a retry when the account cannot be read', async () => {
  vi.spyOn(integrationsApi, 'overview').mockRejectedValueOnce(new Error('Votre rôle ne permet pas cette opération.')).mockResolvedValueOnce(overview());
  await act(async () => root.render(<IntegrationsSettings disabled />));
  expect(host.textContent).toContain('Votre rôle ne permet pas cette opération.');
  await act(async () => button('Réessayer').click());
  expect([...host.querySelectorAll('input')].every(input => input.disabled || input.closest('fieldset')?.disabled)).toBe(true);
});
