import { ChevronRight } from 'lucide-react';
import { t } from './language';

export type SalesFlowStep = 'automation' | 'quotes' | 'invoices' | 'bank';

/** The path of a sale, always visible above the sales lists: request, quote, invoice, payment. */
export function SalesFlow({ active, showRequests, onNavigate }: { active: SalesFlowStep; showRequests: boolean; onNavigate: (step: SalesFlowStep) => void }) {
  const steps: Array<[SalesFlowStep, string]> = [
    ...(showRequests ? [['automation', 'Demande'] as [SalesFlowStep, string]] : []),
    ['quotes', 'Devis'], ['invoices', 'Facture'], ['bank', 'Paiement'],
  ];
  return <nav className="sales-flow" aria-label={t('Le parcours d’une vente')}>
    {steps.map(([id, label], index) => <span className="sales-flow__step" key={id}>
      {index > 0 && <ChevronRight size={15} aria-hidden="true" />}
      <button type="button" aria-current={active === id ? 'step' : undefined} onClick={() => onNavigate(id)}>
        <span className="sales-flow__number">{index + 1}</span>{t(label)}
      </button>
    </span>)}
  </nav>;
}
