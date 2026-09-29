import { useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronLeft,
  FileCheck2,
  Landmark,
  ReceiptText,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import type {
  AccountingContinuity,
  IncomeStatementReport,
  Workspace,
} from './types';
import {
  applyBillingPreset,
  billingPresets,
  financeTotalsAvailable,
  type BillingPresetId,
} from './financeClarity';
import { desktopApi } from './bridge';
import { formatMoney, errorMessage } from './utils';
import { Button, ErrorPanel, Modal } from './ui';
import { MobileDetails, useCompactLayout } from './MobileDetails';
import { FinanceFirstStep } from './FinanceFirstStep';
import { t, useAppLanguage } from './language';

type FinanceSection =
  | 'journal'
  | 'income'
  | 'balance'
  | 'vat'
  | 'closing'
  | 'accounts'
  | 'periods';
export function FinanceOverview({
  workspace,
  income,
  continuity,
  busy,
  periodLabel,
  readOnly,
  onSection,
  onWorkspaceChange,
  onInstallStarter,
}: {
  workspace: Workspace;
  income: IncomeStatementReport | null;
  continuity: AccountingContinuity;
  busy: boolean;
  periodLabel: string;
  readOnly: boolean;
  onSection: (section: FinanceSection) => void;
  onWorkspaceChange: (workspace: Workspace) => void;
  onInstallStarter: () => Promise<void>;
}) {
  useAppLanguage();
  const [configuration, setConfiguration] = useState(false);
  const compact = useCompactLayout();
  const needsSetup = !busy && (!continuity.enabled || !continuity.mappingReady) && continuity.journalEntryCount === 0;
  const readable =
    !busy &&
    financeTotalsAvailable(income) &&
    (continuity.enabled || continuity.journalEntryCount > 0);
  const amounts = [
    {
      title: t('Revenus enregistrés'),
      value: income?.revenueCents,
      icon: ArrowDownLeft,
      text: t('Les produits de votre activité, comptabilisés sur la période.'),
    },
    {
      title: t('Charges enregistrées'),
      value: income?.expenseCents,
      icon: ArrowUpRight,
      text: t('Les achats, salaires et autres coûts comptabilisés.'),
    },
    {
      title:
        (income?.profitCents ?? 0) < 0
          ? t('Perte de la période')
          : t('Résultat de la période'),
      value: income?.profitCents,
      icon: Landmark,
      text: t('Revenus moins charges. Le détail explique chaque montant.'),
    },
  ];
  return (
    <div className="finance-overview">
      {needsSetup ? <FinanceFirstStep
        title="Préparez votre comptabilité"
        description={readOnly
          ? 'Un administrateur peut préparer les comptes. Vous pouvez consulter la configuration.'
          : 'Choisissez les comptes qui recevront vos ventes, achats et paiements. Vous vérifierez leur activation avant tout enregistrement.'}
        actionLabel={readOnly ? 'Voir la configuration' : 'Préparer les comptes'}
        onAction={() => onSection('accounts')}
        secondary={!readOnly ? <details><summary>{t('Délais de paiement et validité des devis')}</summary><Button variant="secondary" onClick={() => setConfiguration(true)}>{t('Choisir mes délais')}</Button></details> : undefined}
      /> : <>
      <header className="finance-overview__intro">
        <div>
          <details className="workspace-disclosure"><summary>{t('Vos finances, en clair.')}</summary>
          <p>
            {t('Comprenez votre résultat, préparez la TVA et avancez une étape à la fois.')}
          </p>
          </details>
          <p className="finance-overview__period">{periodLabel}</p>
        </div>
        <Button
          variant="secondary"
          disabled={readOnly || busy}
          onClick={() => setConfiguration(true)}
        >
          <Settings2 size={17} />
          {t('Configurer simplement')}
        </Button>
      </header>
      <div
        className="finance-overview__figures"
        aria-label={`${t('Résultat comptable de la période')} · ${periodLabel}`}
        aria-busy={busy}
      >
        {(compact && !readable ? amounts.slice(-1) : amounts).map((item) => (
          <article key={item.title}>
            <div>
              <item.icon size={18} />
              <h3>{item.title}</h3>
            </div>
            <strong>
              {readable
                ? formatMoney(item.value, income!.currency.baseCurrency)
                : '—'}
            </strong>
            <p>{busy ? t('Actualisation des écritures…') : item.text}</p>
            <button type="button" onClick={() => onSection('income')}>
              {t('Voir le détail')}
              <ArrowRight size={15} />
            </button>
          </article>
        ))}
      </div>
      {!busy && !readable ? (
        <p className="finance-overview__notice" role="status">
          {!continuity.enabled && !continuity.journalEntryCount
            ? t('Préparez les comptes pour commencer à suivre votre résultat. Aucun montant comptable n’est encore présenté.')
            : income &&
                !income.currency.singleCurrency &&
                !income.currency.exchangeRatesApplied
              ? t('Plusieurs devises sont présentes sans conversion : consultez le détail par devise.')
              : t('Les chiffres apparaîtront quand les états comptables seront disponibles.')}
        </p>
      ) : null}
      <section className="finance-overview__next">
        <div>
          <span className="finance-overview__step">
            {continuity.enabled && continuity.mappingReady ? (
              <Check size={21} />
            ) : (
              <ShieldCheck size={21} />
            )}
          </span>
          <div>
            <h3>
              {!continuity.enabled || !continuity.mappingReady
                ? t('Commencez par votre configuration')
                : continuity.totalAnomalies || continuity.totalMissing
                  ? t('Quelques opérations sont à vérifier')
                  : t('Votre suivi comptable est en place')}
            </h3>
            <p>
              {!continuity.enabled || !continuity.mappingReady
                ? t('Zentra peut préparer les comptes de base et leurs liaisons. Vous vérifiez le choix avant de les activer.')
                : continuity.totalAnomalies || continuity.totalMissing
                  ? t('Ouvrez les contrôles pour retrouver les pièces manquantes et les écarts à corriger.')
                  : t('Vos opérations alimentent les états. Vérifiez les pièces et les paiements avant chaque déclaration.')}
            </p>
          </div>
        </div>
        <Button variant="secondary" onClick={() => onSection('accounts')}>
          {!continuity.enabled || !continuity.mappingReady
            ? t('Préparer les comptes')
            : t('Vérifier ma configuration')}
          <ArrowRight size={16} />
        </Button>
      </section>
      <section
        className="finance-overview__paths"
        aria-label={t('Que souhaitez-vous faire ?')}
      >
        {[
          {
            id: 'vat' as const,
            title: t('Préparer ma TVA'),
            text: t('Retrouver la taxe due, les achats déductibles et les contrôles.'),
            icon: ReceiptText,
          },
          {
            id: 'balance' as const,
            title: t('Comprendre mon bilan'),
            text: t('Voir ce que l’entreprise possède et ce qu’elle doit.'),
            icon: Landmark,
          },
          {
            id: 'closing' as const,
            title: t('Préparer la fin d’année'),
            text: t('Contrôler les pièces et exporter le dossier pour la fiduciaire.'),
            icon: FileCheck2,
          },
        ].map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => onSection(item.id)}
          >
            <item.icon size={23} />
            <span>
              <strong>{item.title}</strong>
              <small>{item.text}</small>
            </span>
            <ArrowRight size={18} />
          </button>
        ))}
      </section>
      <MobileDetails title={t('Comprendre ces montants')}><aside className="finance-overview__learn">
        {compact && <dl>{amounts.map(item => <div key={item.title}><dt>{item.title}</dt><dd>{item.text}</dd></div>)}</dl>}
        <h3>{t('Résultat et argent en banque')}</h3>
        <p>
          {t('Le résultat suit les revenus et les charges. Le solde bancaire suit les paiements réellement passés. Une facture peut donc améliorer le résultat alors que son paiement reste à recevoir.')}
        </p>
        <button type="button" onClick={() => onSection('journal')}>
          {t('Consulter les opérations')}
          <ArrowRight size={15} />
        </button>
      </aside></MobileDetails>
      </>}
      {configuration ? (
        <FinanceConfiguration
          key={workspace.settings?.organization.legalName}
          workspace={workspace}
          readOnly={readOnly}
          canInstall={continuity.starterAvailable}
          onInstallStarter={onInstallStarter}
          onWorkspaceChange={onWorkspaceChange}
          onClose={() => setConfiguration(false)}
        />
      ) : null}
    </div>
  );
}

function FinanceConfiguration({
  workspace,
  readOnly,
  canInstall,
  onInstallStarter,
  onWorkspaceChange,
  onClose,
}: {
  workspace: Workspace;
  readOnly: boolean;
  canInstall: boolean;
  onInstallStarter: () => Promise<void>;
  onWorkspaceChange: (workspace: Workspace) => void;
  onClose: () => void;
}) {
  useAppLanguage();
  const [step, setStep] = useState(0),
    [preset, setPreset] = useState<BillingPresetId | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const inFlight = useRef(false);
  const chosen = billingPresets.find((p) => p.id === preset),
    settings = workspace.settings!;
  async function save() {
    if (readOnly || inFlight.current || !preset || saved) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      // Re-read first so a setting changed elsewhere while the review was open
      // is preserved. Only these two commercial defaults are replaced.
      const latest = await desktopApi.loadWorkspace();
      if (!latest.settings)
        throw new Error('La configuration de l’entreprise est indisponible.');
      const next = await desktopApi.saveSettings(
        applyBillingPreset(latest.settings, preset),
      );
      setSaved(true);
      onWorkspaceChange(next);
    } catch (reason) {
      setError(
        errorMessage(
          reason,
          'La configuration n’a pas pu être enregistrée. Vos choix sont conservés.',
        ),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        saved
          ? t('Votre configuration est enregistrée')
          : t('Configurer mes finances')
      }
      description={
        saved
          ? t('Ces délais seront proposés sur vos prochains documents.')
          : t('Choisissez des réglages de départ, puis vérifiez leur effet.')
      }
      onClose={onClose}
      dismissible={!busy}
      className="finance-configuration"
    >
      {!saved ? (
        <>
          <ol
            className="finance-configuration__progress"
            aria-label={t('Étapes de configuration')}
          >
            {['Choisir', 'Vérifier'].map((label, i) => (
              <li key={label} aria-current={step === i ? 'step' : undefined}>
                <span>{i + 1}</span>
                {t(label)}
              </li>
            ))}
          </ol>
          {step === 0 ? (
            <section>
              <h3>{t('Quel délai proposez-vous à vos clients ?')}</h3>
              <p>
                {t('Il s’agit de conditions commerciales que vous choisissez, à convenir avec vos clients.')}
              </p>
              <div className="finance-configuration__choices">
                {billingPresets.map((p) => (
                  <label
                    key={p.id}
                    className={preset === p.id ? 'is-selected' : ''}
                  >
                    <input
                      type="radio"
                      name="billing-preset"
                      value={p.id}
                      checked={preset === p.id}
                      onChange={() => setPreset(p.id)}
                    />
                    <span>
                      <strong>{t(p.name)}</strong>
                      <small>{t(p.text)}</small>
                    </span>
                    <b>
                      {p.days}
                      <small>{t('jours')}</small>
                    </b>
                  </label>
                ))}
              </div>
            </section>
          ) : (
            <section>
              <h3>{t('Vérifiez les réglages proposés')}</h3>
              <dl className="finance-configuration__review">
                <div>
                  <dt>{t('Délai de paiement des factures')}</dt>
                  <dd>
                    {settings.billing.paymentTermsDays} {t('jours')}{' '}
                    <ArrowRight size={15} />
                    <strong>{chosen!.days} {t('jours')}</strong>
                  </dd>
                </div>
                <div>
                  <dt>{t('Validité des devis')}</dt>
                  <dd>
                    {settings.billing.quoteValidityDays} {t('jours')}{' '}
                    <ArrowRight size={15} />
                    <strong>{chosen!.validity} {t('jours')}</strong>
                  </dd>
                </div>
              </dl>
              <p>
                {t('Les documents déjà créés gardent leurs conditions. La TVA, les coordonnées bancaires et les salaires conservent leurs réglages.')}
              </p>
            </section>
          )}
          {error ? <ErrorPanel message={error} /> : null}
          <div className="form-actions">
            {step === 1 ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setStep(0)}
              >
                <ChevronLeft size={16} />
                {t('Retour')}
              </Button>
            ) : null}
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              {t('Plus tard')}
            </Button>
            <Button
              disabled={readOnly || busy || !preset}
              onClick={() => (step === 0 ? setStep(1) : void save())}
            >
              {busy
                ? t('Enregistrement…')
                : step === 0
                  ? t('Vérifier mes choix')
                  : t('Appliquer ces réglages')}
              <ArrowRight size={16} />
            </Button>
          </div>
        </>
      ) : (
        <section className="finance-configuration__done">
          <Check size={35} />
          <h3>{t('Vous pouvez préparer vos documents')}</h3>
          <p>
            {t('{paymentDays} jours pour régler une facture, {validityDays} jours pour accepter un devis.', { paymentDays: chosen!.days, validityDays: chosen!.validity })}
          </p>
          {canInstall ? (
            <div>
              <h4>{t('Prochaine étape : les comptes de base')}</h4>
              <p>
                {t('Préparez les comptes essentiels pour relier les ventes, achats et paiements à la comptabilité. Une confirmation présente leur activation.')}
              </p>
              <Button
                variant="secondary"
                disabled={readOnly || busy}
                onClick={() => {
                  setBusy(true);
                  void onInstallStarter().finally(() => setBusy(false));
                }}
              >
                {t('Préparer les comptes suisses')}
              </Button>
            </div>
          ) : null}
          <Button onClick={onClose} disabled={busy}>
            {t('Terminer')}
          </Button>
        </section>
      )}
    </Modal>
  );
}
