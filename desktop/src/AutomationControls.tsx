import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Workflow } from 'lucide-react';
import { Button } from './ui';
import { t, useAppLanguage } from './language';
import {
  automationFeedback,
  automationRequest,
  automationState,
  openAutomationSettings,
  bankCategories,
  documentTypes,
  openAutomationWorkflow,
  type AutomationDecision,
  type AutomationFeature,
  type AutomationState,
} from './automation';
import './AutomationControls.css';
import { useCompanyAutomation } from './AutomationCompany';

export function useAutomation(
  feature: AutomationFeature,
  context: Record<string, unknown> | null,
  identity?: string,
) {
  const [decision, setDecision] = useState<AutomationDecision | null>(null);
  const company = useCompanyAutomation();
  const configuration = JSON.stringify([company.state?.organizationId, company.state?.active, company.state?.settings, company.state?.available]);
  const serialized = JSON.stringify(context);
  useEffect(() => {
    let live = true;
    setDecision(context ? { status: 'pending' } : null);
    if (!context) return;
    const timer = setTimeout(() => {
      void automationRequest(feature, JSON.parse(serialized), identity).then(
        (value) => {
          if (live) setDecision(value);
        },
      );
    }, 700);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [feature, serialized, identity, configuration]);
  return decision;
}
export function AutomationSetup({
  onContinue,
  onSkip,
}: {
  onContinue?: () => void;
  onSkip?: () => void;
}) {
  useAppLanguage();
  const [state, setState] = useState<AutomationState | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void automationState().then((value) => {
        if (active) setState(value);
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return (
    <section className="automation-setup">
      <Workflow size={28} />
      <p className="automation-eyebrow">Zentra Automation</p>
      <h3>{t(state?.active ? 'Automation pour toute votre équipe' : 'Disponible avec Zentra Automation')}</h3>
      <p>
        {t(
          state?.active ? 'Des suggestions pour classer vos opérations et documents. Vous validez les actions importantes.' : 'Automatisez vos tâches répétitives pour +15 CHF/mois.',
        )}
      </p>
      {!state?.active && <div className="automation-price">
        <strong>15 CHF</strong>
        <span>{t('par mois et par entreprise')}</span>
      </div>}
      <p>
        {t(
          'Option facultative. Les extraits nécessaires sont traités en ligne après votre accord. Le fichier complet n’est pas transmis au service d’analyse.',
        )}
      </p>
      {state?.active && <p role="status">{t('L’option est active pour cette entreprise. Tous ses collaborateurs en bénéficient, sans activation individuelle.')}</p>}
      <div className="automation-actions">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setError('');
            void openAutomationSettings().catch(() =>
              setError(
                'Ouvrez zentraapp.ch/compte/automation dans votre navigateur.',
              ),
            );
          }}
        >
          <ArrowUpRight size={16} />
          {t(
            state?.active ? (state.canManage ? 'Gérer Zentra Automation' : 'Voir les réglages de l’entreprise') : 'Ajouter Automation',
          )}
        </Button>
        {onSkip && (
          <Button type="button" variant="ghost" onClick={onSkip}>
            {t('Continuer sans cette option')}
          </Button>
        )}
        {onContinue && (
          <Button type="button" onClick={onContinue}>
            {t('Continuer')}
          </Button>
        )}
      </div>
      {error && <p role="status">{t(error)}</p>}
      <small>
        {t(
          'L’ouverture du compte ne déclenche aucun paiement. Le prix et les conditions sont confirmés avant activation.',
        )}
      </small>
    </section>
  );
}
export function AutomationChoice({
  decision,
  labels,
  question,
  onChoose,
  title = 'Suggestion Zentra',
  disabled: disabledProp = false,
}: {
  decision: AutomationDecision | null;
  labels: Record<string, string>;
  question: string;
  onChoose?: (key: string) => void;
  title?: string;
  disabled?: boolean;
}) {
  useAppLanguage();
  const company = useCompanyAutomation();
  const disabled = disabledProp || company.readOnly;
  const [value, setValue] = useState(''),
    [notice, setNotice] = useState(''),
    [saving, setSaving] = useState(false),
    [recorded, setRecorded] = useState(false);
  useEffect(() => {
    setValue(
      decision?.finalChoices?.[question] ??
        (decision?.status === 'suggestion' &&
        decision.band === 'high' &&
        labels[decision.choices?.[question] ?? '']
          ? decision.choices![question]
          : ''),
    );
    setNotice(decision?.feedback ? 'Choix enregistré.' : '');
    setRecorded(Boolean(decision?.feedback));
  }, [decision?.id]);
  if (
    !decision ||
    decision.status === 'disabled' ||
    decision.status === 'pending'
  )
    return null;
  const suggestion =
    decision.status === 'suggestion' ? decision.choices?.[question] : undefined;
  return (
    <div className="automation-choice">
      <div>
        <span className="automation-eyebrow">
          {t(suggestion ? title : 'Classification')}
        </span>
        {suggestion && labels[suggestion] ? (
          <strong>{t(labels[suggestion])}</strong>
        ) : (
          <small>{t('Choisissez la catégorie qui convient.')}</small>
        )}
      </div>
      <div className="automation-actions">
        <select
          aria-label={t('Catégorie à retenir')}
          value={value}
          disabled={disabled || saving || recorded}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">{t('Choisir ou corriger')}</option>
          {Object.entries(labels).map(([key, label]) => (
            <option key={key} value={key}>
              {t(label)}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="small"
          disabled={disabled || saving || !value || recorded}
          onClick={() => {
            setSaving(true);
            void automationFeedback(decision, { [question]: value })
              .then((saved) => {
                if (saved) {
                  setRecorded(true);
                  onChoose?.(value);
                  setNotice('Choix enregistré.');
                } else if (decision.status === 'manual') {
                  onChoose?.(value);
                  setNotice('Choix appliqué à cet écran.');
                } else
                  setNotice(
                    'Le choix n’a pas été enregistré. Votre travail reste disponible.',
                  );
              })
              .finally(() => setSaving(false));
          }}
        >
          <Check size={14} />
          {t('Confirmer')}
        </Button>
      </div>
      {notice && <small role="status">{t(notice)}</small>}
    </div>
  );
}
export function DocumentClassification({
  text,
  identity,
}: {
  text: string;
  identity: string;
}) {
  const decision = useAutomation(
    'document_routing',
    text.trim() ? { text: text.slice(0, 1800) } : null,
    identity,
  );
  return (
    <AutomationChoice
      decision={decision}
      labels={documentTypes}
      question="type"
      onChoose={(key) => {
        const workflows: Record<string, string> = {
          supplier_invoice: 'purchases',
          customer_invoice: 'invoices',
          quote: 'quotes',
          payslip: 'payroll',
          contract: 'projects',
          bank_statement: 'bank',
          receipt: 'purchases',
          evidence: 'projects',
          tax_document: 'accounting',
        };
        openAutomationWorkflow(workflows[key]);
      }}
    />
  );
}
export function BankClassification({
  context,
  identity,
}: {
  context: Record<string, unknown>;
  identity: string;
}) {
  const decision = useAutomation(
    'transaction_classification',
    context,
    identity,
  );
  return (
    <AutomationChoice
      decision={decision}
      labels={bankCategories}
      question="category"
    />
  );
}
export function AttentionSuggestion({
  context,
  identity,
  kind = 'priority',
}: {
  context: Record<string, unknown>;
  identity: string;
  kind?: 'priority' | 'anomaly_detection';
}) {
  const decision = useAutomation(kind, context, identity);
  const labels: Record<string, string> =
    kind === 'priority'
      ? {
          urgent: 'Urgent',
          important: 'Important',
          normal: 'Normal',
          low: 'Faible priorité',
        }
      : {
          normal: 'Opération normale',
          unusual: 'Opération inhabituelle',
          review: 'À vérifier',
        };
  return (
    <AutomationChoice
      decision={decision}
      labels={labels}
      question={kind === 'priority' ? 'priority' : 'signal'}
      title={
        kind === 'priority' ? 'Priorité suggérée' : 'À examiner, sans blocage'
      }
    />
  );
}
