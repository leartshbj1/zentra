import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Sparkles, X } from 'lucide-react';
import { BrandMark } from './BrandMark';
import { Button } from './ui';

export type TourView = 'dashboard' | 'projects' | 'clients' | 'quotes' | 'invoices' | 'reminders' | 'time' | 'team' | 'expenses' | 'reports' | 'accounting' | 'settings';

const TOUR_STORAGE_KEY = 'elyko-guided-tour-v2';

const steps: Array<{ view: TourView; eyebrow: string; title: string; text: string; target: string }> = [
  { view: 'dashboard', eyebrow: 'Bienvenue', title: 'Votre entreprise, sans données fictives', text: 'Elyko démarre vide et construit les indicateurs uniquement à partir de vos clients, projets, heures, documents et paiements réels.', target: '.topbar__title' },
  { view: 'dashboard', eyebrow: 'Vue d’ensemble', title: 'Commencez par une action concrète', text: 'Créez un client ou un projet, puis lancez un pointage. Le tableau de bord se remplit automatiquement sans aucune donnée de démonstration.', target: '.page-content' },
  { view: 'projects', eyebrow: 'Activité', title: 'Suivez chaque chantier ou projet', text: 'Budget, durée, heures, dépenses, facturation, encaissements et marge sont réunis dans la même fiche.', target: '.page-header' },
  { view: 'quotes', eyebrow: 'Vente', title: 'Du devis à la facture en un clic', text: 'Émettez le devis, marquez-le accepté puis convertissez-le. Elyko empêche les doubles conversions et fige les documents émis.', target: '.page-header' },
  { view: 'invoices', eyebrow: 'Encaissements', title: 'Factures, QR-facture et comptabilité', text: 'Enregistrez un paiement réel : le solde de la facture et l’écriture de banque sont mis à jour ensemble lorsque la comptabilité est activée.', target: '.page-header' },
  { view: 'team', eyebrow: 'Paie locale', title: 'Importez puis contrôlez les fiches', text: 'La couche texte et SmolVLM fonctionnent sur ce PC. Elyko signale les incohérences; vous restez la personne qui confirme chaque montant.', target: '.payroll-panel' },
  { view: 'accounting', eyebrow: 'Comptabilité', title: 'Journal, grand livre et états financiers', text: 'Les écritures validées sont immuables. Une correction passe par une extourne traçable, avec balance et rapports recalculés.', target: '.page-header' },
  { view: 'settings', eyebrow: 'Sécurité', title: 'Configurez, sauvegardez et mettez à jour', text: 'Ajoutez votre logo, contrôlez les cotisations avec votre fiduciaire, choisissez vos sauvegardes et vérifiez les mises à jour signées.', target: '.page-header' },
];

function initialOpen() {
  try { return window.localStorage.getItem(TOUR_STORAGE_KEY) !== 'completed'; }
  catch { return true; }
}

export function useGuidedTour() {
  const [open, setOpen] = useState(initialOpen);
  return { open, start: () => setOpen(true), close: () => setOpen(false) };
}

export function GuidedTour({ open, onClose, onNavigate }: { open: boolean; onClose: () => void; onNavigate: (view: TourView) => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[index];

  useEffect(() => {
    if (!open) return;
    setIndex(0);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    onNavigate(step.view);
    let frame = 0;
    let settle = 0;
    const update = () => {
      const target = document.querySelector(step.target);
      const next = target?.getBoundingClientRect() ?? null;
      setRect(next && next.width > 0 && next.height > 0 && next.bottom > 0 && next.right > 0 ? next : null);
    };
    frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(step.target);
      target?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      update();
      settle = window.setTimeout(update, 320);
      document.querySelector<HTMLButtonElement>('.guided-tour__card footer .button:last-child')?.focus();
    });
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(settle); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [index, onNavigate, open, step.target, step.view]);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(false);
      if (event.key === 'ArrowRight') { event.preventDefault(); next(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); setIndex((current) => Math.max(0, current - 1)); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  function finish(completed: boolean) {
    if (completed) {
      try { window.localStorage.setItem(TOUR_STORAGE_KEY, 'completed'); } catch { /* Le guide reste simplement non mémorisé. */ }
    }
    onClose();
  }

  function next() {
    if (index === steps.length - 1) finish(true);
    else setIndex((current) => Math.min(steps.length - 1, current + 1));
  }

  if (!open) return null;
  const highlightStyle: CSSProperties | undefined = rect ? {
    left: Math.max(8, rect.left - 7),
    top: Math.max(8, rect.top - 7),
    width: Math.min(window.innerWidth - 16, rect.width + 14),
    height: Math.min(window.innerHeight - 16, rect.height + 14),
  } : undefined;

  return <div className="guided-tour" role="dialog" aria-modal="true" aria-labelledby="guided-tour-title">
    {rect ? <div className="guided-tour__highlight" style={highlightStyle} /> : <div className="guided-tour__veil" />}
    <section className="guided-tour__card">
      <header><span><BrandMark size={34} /></span><div><p>{step.eyebrow}</p><strong id="guided-tour-title">{step.title}</strong></div><button type="button" onClick={() => finish(false)} aria-label="Fermer le guide"><X size={18} /></button></header>
      <p className="guided-tour__text">{step.text}</p>
      <div className="guided-tour__progress" aria-label={`Étape ${index + 1} sur ${steps.length}`}>{steps.map((_, stepIndex) => <i key={stepIndex} className={stepIndex <= index ? 'is-active' : ''} />)}</div>
      <footer><Button type="button" variant="ghost" size="small" onClick={() => finish(true)}>Ne plus afficher</Button><span /><Button type="button" variant="secondary" size="small" disabled={index === 0} onClick={() => setIndex((current) => Math.max(0, current - 1))}><ArrowLeft size={15} /> Retour</Button><Button type="button" size="small" onClick={next}>{index === steps.length - 1 ? <><CheckCircle2 size={15} /> Terminer</> : <>{index === 0 ? <Sparkles size={15} /> : null} Suivant <ArrowRight size={15} /></>}</Button></footer>
    </section>
  </div>;
}
