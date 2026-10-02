import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { AppLanguage } from './language';

// Execute the actual component and its handlers while retaining one hook state
// across renders. Clipboard is a deferred local fixture, never the real OS API.
const host = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, language: 'fr' as AppLanguage }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState(initial: unknown) {
    const index = host.cursor++;
    if (!(index in host.values)) host.values[index] = typeof initial === 'function' ? initial() : initial;
    return [host.values[index], (next: unknown) => {
      host.values[index] = typeof next === 'function' ? next(host.values[index]) : next;
    }];
  },
}));
vi.mock('./language', async original => ({ ...await original<typeof import('./language')>(), useAppLanguage: () => host.language }));
import { ErrorDetails } from './ErrorGuidance';
import { appLanguages } from './language';
import { userErrorCopy } from './userErrors';

const first = 'ZT-synthetic-first', next = 'ZT-synthetic-next';
const writeText = vi.fn<(text: string) => Promise<void>>();
function render(incidentCode = first) { host.cursor = 0; return ErrorDetails({ error: 'Synthetic error', incidentCode }); }
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node && typeof node === 'object' && 'props' in node) return text((node as ReactElement<{ children?: ReactNode }>).props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function copyButton(node: ReactNode): ReactElement<{ children?: ReactNode; onClick: () => void }> {
  if (Array.isArray(node)) {
    for (const child of node) { const found = findButton(child); if (found) return found; }
  }
  const found = findButton(node);
  if (!found) throw new Error('Fixture did not find the real copy control');
  return found;
}
function findButton(node: ReactNode): ReturnType<typeof copyButton> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = findButton(child); if (found) return found; } return; }
  if (node && typeof node === 'object' && 'props' in node) {
    const element = node as ReturnType<typeof copyButton>;
    return element.type === 'button' ? element : findButton(element.props.children);
  }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => { host.values = []; host.cursor = 0; host.language = 'fr'; writeText.mockReset().mockResolvedValue(); vi.stubGlobal('navigator', { clipboard: { writeText } }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('copy feedback belongs to the displayed incident', () => {
  it.each(appLanguages)('does not carry a confirmed copy into another incident in %s', async language => {
    host.language = language; const labels = userErrorCopy(language);
    copyButton(render()).props.onClick(); await settle();
    expect(text(copyButton(render()))).toBe(labels.copied);
    expect(text(copyButton(render(next)))).toBe(labels.copy);
    expect(writeText.mock.calls).toEqual([[first]]);
  });

  it.each(appLanguages.flatMap(language => ['resolve', 'reject'].map(result => ({ language, result }))))('ignores old clipboard $result after a new $language incident', async ({ language, result }) => {
    host.language = language; const labels = userErrorCopy(language);
    let resolve!: () => void, reject!: (reason: unknown) => void;
    writeText.mockReturnValueOnce(new Promise<void>((ok, no) => { resolve = ok; reject = no; }));
    copyButton(render()).props.onClick();
    expect(text(copyButton(render(next)))).toBe(labels.copy);
    if (result === 'resolve') resolve(); else reject(new Error('Synthetic clipboard refused'));
    await settle(); const tree = render(next);
    expect(text(copyButton(tree))).toBe(labels.copy);
    expect(text(tree)).not.toContain(labels.copyFailed);
    expect(writeText.mock.calls).toEqual([[first]]);
  });

  it.each(appLanguages.flatMap(language => ['resolve', 'reject'].map(result => ({ language, result }))))('preserves current clipboard $result in $language', async ({ language, result }) => {
    host.language = language; const labels = userErrorCopy(language);
    if (result === 'reject') writeText.mockRejectedValueOnce(new Error('Synthetic clipboard refused'));
    copyButton(render(next)).props.onClick(); await settle(); const tree = render(next);
    expect(text(copyButton(tree))).toBe(result === 'resolve' ? labels.copied : labels.copy);
    expect(text(tree).includes(labels.copyFailed)).toBe(result === 'reject');
    expect(writeText.mock.calls).toEqual([[next]]);
  });

  it('retains the confirmed same-incident feedback when only the language changes', async () => {
    copyButton(render()).props.onClick(); await settle(); host.language = 'de';
    expect(text(copyButton(render()))).toBe(userErrorCopy('de').copied);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it.each([false, true].flatMap(sameIncident => ['resolve', 'reject'].flatMap(oldResult => ['resolve', 'reject'].map(latestResult => ({ sameIncident, oldResult, latestResult })))))('keeps the latest $latestResult after old $oldResult, same incident=$sameIncident', async ({ sameIncident, oldResult, latestResult }) => {
    let resolve!: () => void, reject!: (reason: unknown) => void;
    writeText.mockReturnValueOnce(new Promise<void>((ok, no) => { resolve = ok; reject = no; }));
    copyButton(render()).props.onClick();
    if (latestResult === 'reject') writeText.mockRejectedValueOnce(new Error('Synthetic second copy refused'));
    const current = sameIncident ? first : next;
    copyButton(render(current)).props.onClick(); await settle();
    if (oldResult === 'resolve') resolve(); else reject(new Error('Synthetic first copy refused'));
    await settle(); const tree = render(current), labels = userErrorCopy('fr');
    expect(text(copyButton(tree))).toBe(latestResult === 'resolve' ? labels.copied : labels.copy);
    expect(text(tree).includes(labels.copyFailed)).toBe(latestResult === 'reject');
    expect(writeText.mock.calls).toEqual([[first], [current]]);
  });
});
