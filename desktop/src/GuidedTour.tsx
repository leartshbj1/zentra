import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Sparkles, X } from 'lucide-react';
import { BrandMark } from './BrandMark';
import { Button } from './ui';

export type TourView =
  | 'dashboard'
  | 'projects'
  | 'clients'
  | 'catalog'
  | 'quotes'
  | 'orders'
  | 'invoices'
  | 'reminders'
  | 'time'
  | 'team'
  | 'expenses'
  | 'bank'
  | 'reports'
  | 'accounting'
  | 'settings';

export type GuidedTourStep = {
  id: string;
  view: TourView;
  eyebrow: string;
  title: string;
  text: string;
  target: string;
};

export type GuidedTourMode = 'automatic' | 'complete';

const TOUR_STORAGE_KEY = 'elyko-guided-tour-v3';
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export const guidedTourSteps: readonly GuidedTourStep[] = [
  {
    id: 'overview',
    view: 'dashboard',
    eyebrow: 'Bienvenue',
    title: 'Votre activité réelle, au même endroit',
    text: 'Zentra démarre vide. Les indicateurs se construisent uniquement à partir de vos clients, projets, heures, documents et paiements. Commencez par l’action utile à votre entreprise.',
    target: '.topbar__title',
  },
  {
    id: 'clients',
    view: 'clients',
    eyebrow: 'Relations clients',
    title: 'Centralisez chaque contact réel',
    text: 'Créez la fiche du client avant le premier devis. Ses coordonnées suivent ensuite le projet et les documents, sans devoir être ressaisies.',
    target: '.page-header',
  },
  {
    id: 'catalog',
    view: 'catalog',
    eyebrow: 'Catalogue',
    title: 'Réutilisez produits, services et prix',
    text: 'Préparez vos prestations et articles une fois. Pour les produits suivis, le stock repose sur des mouvements traçables et non sur une quantité fictive.',
    target: '.catalog-panel',
  },
  {
    id: 'projects',
    view: 'projects',
    eyebrow: 'Activité',
    title: 'Pilotez chaque projet',
    text: 'Suivez budget, durée, tâches, heures, dépenses, facturation et marge. Les termes s’adaptent au domaine choisi lors de la configuration.',
    target: '.page-header',
  },
  {
    id: 'quotes',
    view: 'quotes',
    eyebrow: 'Vente',
    title: 'Passez du devis accepté à la facture',
    text: 'Émettez le devis, enregistrez son acceptation puis convertissez-le. Zentra conserve la liaison et empêche une double conversion.',
    target: '.page-header',
  },
  {
    id: 'recurring-documents',
    view: 'orders',
    eyebrow: 'Facturation récurrente',
    title: 'Planifiez, puis contrôlez chaque brouillon',
    text: 'Ouvrez une commande confirmée en CHF composée de prestations directes, choisissez son rythme et son délai de paiement. Zentra prépare les échéances localement quand l’application est ouverte, sans jamais les émettre, les envoyer ou les comptabiliser seul.',
    target: '.page-header',
  },
  {
    id: 'invoices',
    view: 'invoices',
    eyebrow: 'Encaissements',
    title: 'Facturez puis suivez le solde',
    text: 'La facture émise peut inclure sa QR-facture suisse. Chaque paiement confirmé réduit le solde et alimente la comptabilité lorsqu’elle est activée.',
    target: '.page-header',
  },
  {
    id: 'reminders',
    view: 'reminders',
    eyebrow: 'Relances',
    title: 'Traitez les échéances sans perdre le contrôle',
    text: 'Zentra identifie les factures concernées selon vos niveaux de relance. Vérifiez les montants, dates et destinataires avant l’envoi.',
    target: '.reminder-toolbar',
  },
  {
    id: 'time',
    view: 'time',
    eyebrow: 'Temps',
    title: 'Transformez les heures saisies en suivi utile',
    text: 'Lancez le minuteur ou saisissez une durée, rattachez-la au bon projet puis distinguez les heures facturables des heures internes.',
    target: '.time-hero',
  },
  {
    id: 'payroll',
    view: 'team',
    eyebrow: 'Équipe et paie',
    title: 'Importez, contrôlez puis confirmez',
    text: 'La lecture documentaire fonctionne sur cet ordinateur et prépare un brouillon. Zentra signale les incohérences ; vous confirmez la personne, la période et chaque montant avant l’enregistrement.',
    target: '.payroll-panel',
  },
  {
    id: 'purchases',
    view: 'expenses',
    eyebrow: 'Achats',
    title: 'Suivez fournisseurs et pièces justificatives',
    text: 'Rapprochez commandes, réceptions, factures et avoirs. Les écarts restent visibles afin de ne jamais valider silencieusement un montant incertain.',
    target: '.purchase-workflow',
  },
  {
    id: 'bank',
    view: 'bank',
    eyebrow: 'Banque locale',
    title: 'Importez un CAMT, puis confirmez',
    text: 'Zentra lit le relevé XML sur cet ordinateur et propose des rapprochements. Associez explicitement le compte et confirmez chaque opération.',
    target: '.bank-hero',
  },
  {
    id: 'reports',
    view: 'reports',
    eyebrow: 'Pilotage',
    title: 'Lisez des rapports issus de vos saisies',
    text: 'Les marges et durées apparaissent seulement lorsque des données réelles existent. Zentra affiche les bases de calcul pour faciliter le contrôle.',
    target: '.page-header',
  },
  {
    id: 'accounting',
    view: 'accounting',
    eyebrow: 'Comptabilité',
    title: 'Contrôlez journal, TVA et clôture',
    text: 'Explorez le journal, le grand livre, la balance et les états financiers. Les assistants TVA et clôture montrent les contrôles à résoudre avant validation.',
    target: '.accounting-toolbar',
  },
  {
    id: 'settings',
    view: 'settings',
    eyebrow: 'Sécurité et maintenance',
    title: 'Sauvegardez et maintenez Zentra',
    text: 'Réglez l’identité de l’entreprise, les paramètres métier et les sauvegardes. Le bloc de maintenance recherche et installe les mises à jour signées sans désinstallation manuelle.',
    target: '.app-updater',
  },
];

export const automaticGuidedTourSteps: readonly GuidedTourStep[] = [
  guidedTourSteps[0],
  guidedTourSteps[1],
  {
    id: 'readiness',
    view: 'settings',
    eyebrow: 'À votre rythme',
    title: 'Finalisez seulement les réglages utiles',
    text: 'Le centre de préparation indique précisément ce qui manque pour la facturation, le temps, la comptabilité et les sauvegardes. Vos données réelles restent vides tant que vous ne les saisissez pas.',
    target: '.setup-readiness',
  },
];

function initialOpen() {
  try {
    if (window.matchMedia?.('(max-width: 700px)').matches) return false;
    return window.localStorage.getItem(TOUR_STORAGE_KEY) !== 'completed';
  } catch {
    return true;
  }
}

function rememberCompletion() {
  try {
    window.localStorage.setItem(TOUR_STORAGE_KEY, 'completed');
  } catch {
    // Le guide reste simplement non mémorisé.
  }
}

export function useGuidedTour() {
  const [state, setState] = useState(() => ({
    open: initialOpen(),
    mode: 'automatic' as GuidedTourMode,
  }));
  return {
    open: state.open,
    mode: state.mode,
    start: () => setState({ open: true, mode: 'complete' }),
    close: () => setState((current) => ({ ...current, open: false })),
  };
}

export function GuidedTour({
  open,
  mode,
  onClose,
  onNavigate,
}: {
  open: boolean;
  mode: GuidedTourMode;
  onClose: () => void;
  onNavigate: (view: TourView) => void;
}) {
  if (!open) return null;
  return <GuidedTourDialog mode={mode} onClose={onClose} onNavigate={onNavigate} />;
}

function GuidedTourDialog({
  mode,
  onClose,
  onNavigate,
}: {
  mode: GuidedTourMode;
  onClose: () => void;
  onNavigate: (view: TourView) => void;
}) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const steps = mode === 'automatic' ? automaticGuidedTourSteps : guidedTourSteps;
  const step = steps[index];

  const finish = useCallback((completed: boolean) => {
    if (mode === 'automatic' && completed) rememberCompletion();
    onClose();
  }, [mode, onClose]);

  const next = useCallback(() => {
    if (index === steps.length - 1) finish(true);
    else setIndex((current) => Math.min(steps.length - 1, current + 1));
  }, [finish, index, steps.length]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    return () => {
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    onNavigate(step.view);
    let frame = 0;
    let settle = 0;
    const update = () => {
      const target = document.querySelector(step.target)
        ?? document.querySelector('.page-header');
      const nextRect = target?.getBoundingClientRect() ?? null;
      setRect(
        nextRect
          && nextRect.width > 0
          && nextRect.height > 0
          && nextRect.bottom > 0
          && nextRect.right > 0
          ? nextRect
          : null,
      );
    };
    frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(step.target)
        ?? document.querySelector<HTMLElement>('.page-header');
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target?.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
      update();
      settle = window.setTimeout(update, reducedMotion ? 0 : 320);
      titleRef.current?.focus({ preventScroll: true });
    });
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [index, onNavigate, step.target, step.view]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
        return;
      }
      if (event.key === 'Tab') {
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
        ).filter((element) => !element.hidden && element.getClientRects().length > 0);
        if (!focusable.length) {
          event.preventDefault();
          dialogRef.current?.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        const focusIndex = focusable.indexOf(active as HTMLElement);
        if (focusIndex === -1) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.matches('input, select, textarea')
        || target.isContentEditable
      )) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        next();
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setIndex((current) => Math.max(0, current - 1));
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [finish, next]);

  const highlightStyle: CSSProperties | undefined = rect
    ? highlightBounds(rect)
    : undefined;
  const percent = ((index + 1) / steps.length) * 100;

  return <div className="guided-tour">
    {rect
      ? <div className="guided-tour__highlight" style={highlightStyle} />
      : <div className="guided-tour__veil" />}
    <section
      ref={dialogRef}
      className="guided-tour__card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="guided-tour-title"
      aria-describedby="guided-tour-description"
      tabIndex={-1}
    >
      <header>
        <span><BrandMark size={34} /></span>
        <div>
          <p>{step.eyebrow}</p>
          <strong id="guided-tour-title" ref={titleRef} tabIndex={-1}>{step.title}</strong>
        </div>
        <button type="button" onClick={() => finish(mode === 'automatic')} aria-label={mode === 'automatic' ? 'Fermer le guide automatique' : 'Fermer le guide complet'}>
          <X size={18} />
        </button>
      </header>
      <p className="guided-tour__text" id="guided-tour-description">{step.text}</p>
      <div
        className="guided-tour__progress"
        role="progressbar"
        aria-label="Progression du guide"
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={index + 1}
        aria-valuetext={`Étape ${index + 1} sur ${steps.length}`}
      >
        <span><i style={{ width: `${percent}%` }} /></span>
        <strong>{index + 1} / {steps.length}</strong>
      </div>
      <footer>
        <Button type="button" variant="ghost" size="small" onClick={() => finish(mode === 'automatic')}>
          {mode === 'automatic' ? 'Ne plus afficher automatiquement' : 'Fermer le guide'}
        </Button>
        <span />
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={index === 0}
          onClick={() => setIndex((current) => Math.max(0, current - 1))}
        >
          <ArrowLeft size={15} /> Retour
        </Button>
        <Button type="button" size="small" onClick={next}>
          {index === steps.length - 1
            ? <><CheckCircle2 size={15} /> Terminer</>
            : <>{index === 0 ? <Sparkles size={15} /> : null} Suivant <ArrowRight size={15} /></>}
        </Button>
      </footer>
    </section>
  </div>;
}

function highlightBounds(rect: DOMRect): CSSProperties {
  const left = Math.max(8, rect.left - 7);
  const top = Math.max(8, rect.top - 7);
  return {
    left,
    top,
    width: Math.max(0, Math.min(rect.width + 14, window.innerWidth - left - 8)),
    height: Math.max(0, Math.min(rect.height + 14, window.innerHeight - top - 8)),
  };
}
