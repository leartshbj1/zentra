import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, BarChart3, BookOpen, CalendarDays, Check, FileCheck2, FileText, FolderKanban, Home, Landmark, ListChecks, Menu, MessageSquareWarning, Package, Receipt, Settings, SlidersHorizontal, UserRound, Users, WalletCards, Clock3, Banknote } from 'lucide-react';
import { t, useAppLanguage } from './language';
import { Button } from './ui';
import { availableShortcuts, defaultPreferences, navigationIds, quickActionIds, replaceShortcut, saveWorkspacePreferences, useWorkspacePreferences, type ShortcutId, type QuickActionId } from './workspacePreferences';

export const shortcutMeta = {
  dashboard: { label: 'Accueil', icon: Home }, agenda: { label: 'Agenda', icon: CalendarDays }, projects: { label: 'Projets', icon: FolderKanban },
  clients: { label: 'Clients', icon: UserRound }, catalog: { label: 'Catalogue', icon: Package }, quotes: { label: 'Ventes', icon: Receipt },
  invoices: { label: 'Factures', icon: FileText }, reminders: { label: 'Relances', icon: MessageSquareWarning }, time: { label: 'Temps', icon: Clock3 },
  team: { label: 'Équipe', icon: Users }, expenses: { label: 'Achats', icon: WalletCards }, bank: { label: 'Banque', icon: Banknote },
  reports: { label: 'Rapports', icon: BarChart3 }, accounting: { label: 'Comptabilité', icon: Landmark }, automation: { label: 'Automation', icon: ListChecks }, settings: { label: 'Réglages', icon: Settings },
} satisfies Record<ShortcutId, { label: string; icon: typeof Home }>;
export const quickActionMeta = {
  client: { label: 'Nouveau client', icon: UserRound }, project: { label: 'Nouveau projet', icon: FolderKanban },
  quote: { label: 'Préparer un devis', icon: FileCheck2 }, invoice: { label: 'Préparer une facture', icon: Receipt },
  purchase: { label: 'Facture fournisseur', icon: WalletCards }, employee: { label: 'Ajouter un collaborateur', icon: Users },
  agenda: { label: 'Ouvrir l’agenda', icon: CalendarDays }, clients: { label: 'Trouver un client', icon: BookOpen },
} satisfies Record<QuickActionId, { label: string; icon: typeof Home }>;

export function WorkspacePersonalization({ automationActive }: { automationActive: boolean }) {
  useAppLanguage();
  const saved = useWorkspacePreferences();
  const [draft, setDraft] = useState(saved);
  const [section, setSection] = useState<'shortcuts' | 'actions'>('shortcuts');
  const [feedback, setFeedback] = useState<string | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const animations: Animation[] = [];
    const origin = preview.current?.getBoundingClientRect();
    preview.current?.querySelectorAll<HTMLElement>('[data-preview-id]').forEach(node => {
      const id = `${section}:${node.dataset.previewId}`, rect = node.getBoundingClientRect(), previous = positions.current.get(id);
      if (previous && origin && typeof node.animate === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const x = previous.x - (rect.x - origin.x), y = previous.y - (rect.y - origin.y);
        if (x || y) animations.push(node.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' }));
      }
    });
    positions.current.clear();
    return () => animations.forEach(animation => animation.cancel());
  }, [draft, section]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const items = draft[section];
  const labels = section === 'shortcuts' ? shortcutMeta : quickActionMeta;
  const labelFor = (id: string) => (labels as Record<string, { label: string }>)[id].label;
  function select(index: number, id: string) {
    // Measure immediately before changing order, relative to the preview. An
    // accordion opening or keyboard scrolling must never become an item move.
    const origin = preview.current?.getBoundingClientRect();
    positions.current.clear();
    if (origin) preview.current?.querySelectorAll<HTMLElement>('[data-preview-id]').forEach(node => {
      const rect = node.getBoundingClientRect();
      positions.current.set(`${section}:${node.dataset.previewId}`, { x: rect.x - origin.x, y: rect.y - origin.y });
    });
    setDraft(current => section === 'shortcuts'
      ? { ...current, shortcuts: replaceShortcut(current.shortcuts, index, id as ShortcutId) }
      : { ...current, actions: replaceShortcut(current.actions, index, id as QuickActionId) });
    setFeedback(null);
  }
  return <section className="workspace-personalization" id="workspace-personalization" tabIndex={-1} aria-labelledby="personalization-title">
    <header><SlidersHorizontal size={22} aria-hidden="true" /><h2 id="personalization-title">{t('Zentra, à votre façon')}</h2><p>{t('Vos raccourcis sur cet appareil. Votre équipe garde les siens.')}</p></header>
    <div className="personalization-switch" role="group" aria-label={t('Personnaliser')}>
      <button type="button" aria-pressed={section === 'shortcuts'} onClick={() => setSection('shortcuts')}>{t('Barre du bas')}</button>
      <button type="button" aria-pressed={section === 'actions'} onClick={() => setSection('actions')}>{t('Actions de l’accueil')}</button>
    </div>
    <div ref={preview} className="personalization-preview" aria-label={t('Aperçu')}>
      <span>{t('Aperçu')}</span>
      {section === 'shortcuts' ? <div className="personalization-preview__dock">{availableShortcuts(draft, automationActive).map(id => {
        const { label, icon: Icon } = shortcutMeta[id]; return <div key={id} data-preview-id={id}><Icon size={21} aria-hidden="true" /><span title={t(label)}>{t(label)}</span></div>;
      })}<div className="personalization-preview__menu"><Menu size={21} aria-hidden="true" /><span>{t('Menu')}</span></div></div> : <div className="personalization-preview__actions">{draft.actions.map(id => {
        const { label, icon: Icon } = quickActionMeta[id]; return <div key={id} data-preview-id={id}><Icon size={22} aria-hidden="true" /><span>{t(label)}</span></div>;
      })}</div>}
    </div>
    <p className="personalization-hint">{t(section === 'shortcuts' ? 'Choisissez quatre raccourcis. Menu reste toujours accessible.' : 'Choisissez les quatre actions que vous utilisez le plus.')}</p>
    <ol className="personalization-choices">{items.map((id, index) => <li key={`${section}-${index}`}>
      <span className="personalization-number" aria-hidden="true">{index + 1}</span>
      <select aria-label={t('Raccourci {number}', { number: index + 1 })} value={id} onChange={event => select(index, event.target.value)}>
        {(section === 'shortcuts' ? navigationIds.filter(item => item !== 'automation' || automationActive || id === 'automation') : quickActionIds).map(option => <option key={option} value={option}>{t(labelFor(option))}</option>)}
      </select>
      <button type="button" disabled={index === 0} aria-label={t('Monter {label}', { label: t(labelFor(id)) })} onClick={() => select(index, items[index - 1])}><ArrowUp size={18} aria-hidden="true" /></button>
      <button type="button" disabled={index === items.length - 1} aria-label={t('Descendre {label}', { label: t(labelFor(id)) })} onClick={() => select(index, items[index + 1])}><ArrowDown size={18} aria-hidden="true" /></button>
    </li>)}</ol>
    {draft.shortcuts.includes('automation') && !automationActive && <p>{t('Le raccourci Automation apparaîtra lorsque ce produit sera actif dans cet espace.')}</p>}
    <div className="personalization-footer"><button className="personalization-reset" type="button" onClick={() => { setDraft({ ...defaultPreferences, shortcuts: [...defaultPreferences.shortcuts], actions: [...defaultPreferences.actions] }); setFeedback(null); }}>{t('Réglages par défaut')}</button>
      <div><Button variant="secondary" disabled={!dirty} onClick={() => { setDraft(saved); setFeedback(null); }}>{t('Annuler')}</Button><Button disabled={!dirty} onClick={() => { const persisted = saveWorkspacePreferences(draft); setFeedback(persisted ? 'Vos raccourcis sont enregistrés.' : 'Appliqué pour cette session. Le stockage de cet appareil est indisponible.'); }}><Check size={17} aria-hidden="true" />{t('Enregistrer')}</Button></div>
    </div>
    {feedback && <p role="status" className="personalization-feedback">{t(feedback)}</p>}
  </section>;
}
