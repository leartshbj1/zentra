// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutomationControlCentre, type AutomationCentreState } from './AutomationControlCentre';
import { AutomationJournal } from './AutomationJournal';

const locale = vi.hoisted(() => ({ language: 'fr' }));
vi.mock('./language', () => ({ useAppLanguage: () => locale.language, t: (source: string) => source }));
const roots: { root: Root; host: HTMLDivElement }[] = [];
const centre: AutomationCentreState = {
  organizationId: 'company-a', canManage: true, canWork: true, rules: [], items: [], templates: [], members: [],
  runs: [{ id: 'run-a', title: 'Texte du client', state: 'review', revision: 4, attempts: 0,
    createdAt: 1791712800, updatedAt: 1791712800, dueAt: 0,
    definition: { trigger: 'email_classified', mode: 'suggest', threshold: .95,
      conditions: { category: '', priority: '', sender: '', attachment: false }, decision: null, actions: [] },
    result: { message: 'Contenu métier original' } }],
};
beforeEach(() => { locale.language = 'fr'; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { for (const { root, host } of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); } vi.unstubAllGlobals(); });
async function mount(element: React.ReactNode) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push({ root, host });
  await act(async () => root.render(element)); return { root, host };
}

it.each([
  ['fr', 'Activité', 'À faire', 'Règles'], ['de', 'Aktivität', 'Aufgaben', 'Regeln'],
  ['it', 'Attività', 'Da fare', 'Regole'], ['en', 'Activity', 'Tasks', 'Rules'],
])('starts with complete activity and localizes navigation in %s', async (language, activity, tasks, rules) => {
  locale.language = language;
  const request = vi.fn().mockResolvedValue(centre);
  const { host } = await mount(<AutomationControlCentre organizationId="company-a" request={request} />);
  const navigation = host.querySelector('nav')!;
  expect(navigation.querySelector('button')?.textContent).toBe(activity);
  expect(navigation.querySelector('[aria-current="page"]')?.textContent).toBe(activity);
  expect(navigation.textContent).toContain(tasks); expect(navigation.textContent).toContain(rules);
  expect(host.querySelector('.automation-journal')).not.toBeNull();
  expect(host.textContent).toContain('Texte du client');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0].action).toBe('centre');
});

it('removes prior-company rows immediately when the organization changes', async () => {
  const request = vi.fn().mockResolvedValueOnce(centre).mockImplementation(() => new Promise(() => {}));
  const { root, host } = await mount(<AutomationControlCentre organizationId="company-a" request={request} />);
  expect(host.textContent).toContain('Texte du client');
  await act(async () => root.render(<AutomationControlCentre organizationId="company-b" request={request} />));
  expect(host.textContent).not.toContain('Texte du client');
  expect(host.querySelector('.automation-journal__skeleton')).not.toBeNull();
});

it('retains readable activity after a refresh failure while removing workflow authorization controls', async () => {
  const request = vi.fn().mockResolvedValueOnce(centre).mockRejectedValueOnce(new Error('Service indisponible'));
  const { host } = await mount(<AutomationControlCentre organizationId="company-a" request={request} />);
  expect(host.textContent).toContain('Confirmer les actions');
  const refresh = host.querySelector<HTMLButtonElement>('[aria-label="Actualiser"]')!;
  await act(async () => refresh.click());
  expect(host.textContent).toContain('Texte du client');
  expect(host.textContent).toContain('Service indisponible');
  expect(host.textContent).not.toContain('Confirmer les actions');
  expect(request.mock.calls.every(([body]) => body.action === 'centre')).toBe(true);
});

it('refuses a mismatched response without claiming empty activity', async () => {
  const { host } = await mount(<AutomationControlCentre organizationId="company-a" request={vi.fn().mockResolvedValue({ ...centre, organizationId: 'company-b' })} />);
  expect(host.textContent).toContain('Le compte et l’entreprise ne correspondent pas');
  expect(host.textContent).not.toContain('Texte du client');
  expect(host.querySelector('.automation-journal__empty')).toBeNull();
});

it('does not claim that work is clear when a retained empty state cannot refresh', async () => {
  const request = vi.fn().mockResolvedValueOnce({ ...centre, runs: [] }).mockRejectedValueOnce(new Error('Service indisponible'));
  const { host } = await mount(<AutomationControlCentre organizationId="company-a" initialTab="work" request={request} />);
  expect(host.textContent).toContain('Aucune tâche à faire');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Actualiser le centre Autopilote"]')!.click());
  expect(host.textContent).toContain('Service indisponible');
  expect(host.querySelector('.ac-empty')).toBeNull();
});

it('shows a loading placeholder rather than a fictional empty history', async () => {
  const { host } = await mount(<AutomationJournal runs={[]} renderRun={() => null} loading />);
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(host.querySelector('.automation-journal__skeleton')).not.toBeNull();
  expect(host.querySelector('.automation-journal__empty')).toBeNull();
});

it('filters real supplied rows and clears the query without invoking a business action', async () => {
  const { host } = await mount(<AutomationJournal runs={[{ ...centre.runs[0], title: 'Pompe à chaleur' }]} renderRun={run => <span>{run.title}</span>} />);
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setValue.call(input, 'absent'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(host.textContent).not.toContain('Pompe à chaleur');
  expect(host.textContent).toContain('Aucun résultat');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Effacer la recherche"]')!.click());
  expect(host.textContent).toContain('Pompe à chaleur');
});
