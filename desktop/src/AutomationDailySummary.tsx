import { Workflow } from 'lucide-react';
import { type AutomationFeature, type AutomationState } from './automation';
import { useCompanyAutomation } from './AutomationCompany';
import { t, useAppLanguage } from './language';
import './AutomationDailySummary.css';

const labels: Record<AutomationFeature, string> = {
  transaction_classification: 'Opérations bancaires', document_routing: 'Documents',
  supplier_routing: 'Factures fournisseurs', agent_routing: 'Assistant Zentra',
  anomaly_detection: 'Opérations inhabituelles', priority: 'Priorités',
  email_classification: 'E-mails importés', import_mapping: 'Import de données',
};

export function AutomationDailySummary() {
  useAppLanguage();
  const { state } = useCompanyAutomation();
  if (!state?.active || !state.activity) return null;
  return <AutomationDailySummaryView state={state} />;
}

export function AutomationDailySummaryView({ state }: { state: AutomationState }) {
  useAppLanguage();
  if (!state.active || !state.activity) return null;
  const activity = state.activity;
  const { analyzed, suggestions, confirmed, needsReview, observed } = activity.totals;
  const hasActivity = analyzed > 0 || confirmed > 0;
  const paused = !state.settings.enabled || !state.settings.consent || !state.available.some(f => state.settings.flags.includes(f));
  return (
    <section className="automation-daily" aria-label={t('Votre journée avec Zentra Automation')}>
      <div className="automation-daily__heading">
        <span className="automation-daily__brand"><Workflow size={18} aria-hidden="true" /> Zentra Automation</span>
        <span className="automation-daily__period">{t('Aujourd’hui')} · {t('Toute l’équipe')}</span>
      </div>
      <h2>{activity.displayName ? t('Bonjour, {name}', { name: activity.displayName }) : t('Bonjour')}</h2>
      <p>{hasActivity ? t('Voici ce que Zentra a préparé pour votre entreprise aujourd’hui.') : paused ? t('Automation est en pause pour cette entreprise.') : t('Votre équipe est prête. Les prochaines analyses apparaîtront ici.')}</p>
      {hasActivity && <>
        <dl className="automation-daily__stats">
          <div><dd>{analyzed}</dd><dt>{t('Analyses terminées')}</dt></div>
          <div><dd>{suggestions}</dd><dt>{t('Suggestions préparées')}</dt></div>
          <div><dd>{confirmed}</dd><dt>{t('Choix validés par l’équipe')}</dt></div>
        </dl>
        <details className="automation-daily__details">
          <summary>{t('Voir le bilan de la journée')}</summary>
          <ul>{activity.features.filter(row => row.analyzed || row.confirmed).map(row => <li key={row.feature}>
            <strong>{t(labels[row.feature] ?? 'Autres analyses')}</strong>
            <span>{t('{count} analyses · {confirmed} choix validés', { count: row.analyzed, confirmed: row.confirmed })}</span>
          </li>)}</ul>
          {needsReview > 0 && <p>{t('{count} analyses du jour restent à vérifier dans leurs écrans.', { count: needsReview })}</p>}
          {observed > 0 && <p>{t('{count} analyses en observation, sans modification de vos données.', { count: observed })}</p>}
          <p>{t('Les choix validés sont des suggestions confirmées par l’équipe, pas des paiements ou des écritures automatiques.')}</p>
        </details>
        {paused && <small>{t('Automation est actuellement en pause.')}</small>}
      </>}
    </section>
  );
}
