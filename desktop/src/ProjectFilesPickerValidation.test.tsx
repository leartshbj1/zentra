// @vitest-environment jsdom
import './languageTestPacks';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectFilesPicker } from './ProjectFilesPicker';
import { setAppLanguage, t, type AppLanguage } from './language';
import { getUserError, userErrorCopy } from './userErrors';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => false }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); native.invoke.mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await setAppLanguage('fr'); vi.unstubAllGlobals(); });
const languages = ['fr', 'de', 'it', 'en'] as const;
async function choose(files: File[]) { const input = host.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(input, 'files', { configurable: true, value: files }); await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function mount(language: AppLanguage, change = vi.fn()) { await act(async () => { await setAppLanguage(language); root.render(<ProjectFilesPicker files={[]} onChange={change} />); }); return change; }
const cases = [
  ['empty', () => new File([], 'Client – été {name}.pdf'), '{name} est vide. Choisissez un fichier non vide.'],
  ['large', () => { const file = new File(['x'], 'Client – été {name}.pdf'); Object.defineProperty(file, 'size', { value: 25 * 1024 * 1024 + 1 }); return file; }, '{name} dépasse 25 Mo. Choisissez un fichier de 25 Mo ou moins.'],
  ['unsupported', () => new File(['x'], 'Client – été {name}.exe'), 'Le format de {name} n’est pas pris en charge. Choisissez un format indiqué ci-dessus.'],
  ['invalid name', () => new File(['x'], 'bad/name.pdf'), 'Renommez le fichier avec un nom simple avant de l’ajouter.'],
  ['long name', () => new File(['x'], 'é'.repeat(256) + '.pdf'), 'Le nom du fichier est trop long. Raccourcissez-le avant de l’ajouter.'],
] as const;
describe('real project file preflight and trustworthy local guidance', () => {
  for (const [kind, fileFactory, message] of cases) it.each(languages)(`shows actionable ${kind} guidance before reading/uploading in %s`, async language => {
    const change = await mount(language); const file = fileFactory(); await choose([file]);
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(t(message, { name: file.name }));
    expect(alert.textContent).not.toContain(userErrorCopy(language).unknown.message);
    expect(alert.textContent).not.toContain(userErrorCopy(language).uncertain);
    expect(host.querySelector('.error-guidance__support')).toBeNull();
    expect(change).toHaveBeenCalledExactlyOnceWith([]);
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('updates an outstanding file instruction in every language while retaining the literal filename', async () => {
    await mount('fr'); const file = new File([], 'Client – été {name}.pdf'); await choose([file]);
    const expected = { fr: 'est vide. Choisissez un fichier non vide.', de: 'ist leer. Wählen Sie eine nicht leere Datei.', it: 'è vuoto. Scegli un file non vuoto.', en: 'is empty. Choose a non-empty file.' };
    for (const language of languages) {
      await act(async () => { await setAppLanguage(language); });
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(`${file.name} ${expected[language]}`);
      expect(native.invoke).not.toHaveBeenCalled();
    }
  });
  it('accepts valid files unchanged, deduplicates within selection, and leaves similar native failures uncertain', async () => {
    const change = await mount('en'); const file = new File(['pdf-content'], 'Client – été {name}.pdf');
    await choose([file, file]); expect(change).toHaveBeenCalledExactlyOnceWith([file]);
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(native.invoke).not.toHaveBeenCalled();
    const transport = getUserError(new Error('Client – été {name}.pdf est vide.'), { language: 'en', operation: 'mutation' });
    expect(transport.kind).toBe('unknown'); expect(transport.action).toContain(userErrorCopy('en').uncertain);
  });
});
