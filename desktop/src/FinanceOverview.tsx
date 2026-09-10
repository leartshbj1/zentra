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
  const [configuration, setConfiguration] = useState(false);
  const readable =
    !busy &&
    financeTotalsAvailable(income) &&
    (continuity.enabled || continuity.journalEntryCount > 0);
  const amounts = [
    {
      title: 'Revenus enregistrés',
      value: income?.revenueCents,
      icon: ArrowDownLeft,
      text: 'Les produits de votre activité, comptabilisés sur la période.',
    },
    {
      title: 'Charges enregistrées',
      value: income?.expenseCents,
      icon: ArrowUpRight,
      text: 'Les achats, salaires et autres coûts comptabilisés.',
    },
    {
      title:
        (income?.profitCents ?? 0) < 0
          ? 'Perte de la période'
          : 'Résultat de la période',
      value: income?.profitCents,
      icon: Landmark,
      text: 'Revenus moins charges. Le détail explique chaque montant.',
    },
  ];
  return (
    <div className="finance-overview">
      <header className="finance-overview__intro">
        <div>
          <p className="finance-overview__eyebrow">{periodLabel}</p>
          <h2>Vos finances, en clair.</h2>
          <p>
            Comprenez votre résultat, préparez la TVA et avancez une étape à la
            fois.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={readOnly || busy}
          onClick={() => setConfiguration(true)}
        >
          <Settings2 size={17} />
          Configurer simplement
        </Button>
      </header>
      <div
        className="finance-overview__figures"
        aria-label="Résultat comptable de la période"
      >
        {amounts.map((item) => (
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
            <p>{busy ? 'Actualisation des écritures…' : item.text}</p>
            <button type="button" onClick={() => onSection('income')}>
              Voir le détail
              <ArrowRight size={15} />
            </button>
          </article>
        ))}
      </div>
      {!busy && !readable ? (
        <p className="finance-overview__notice" role="status">
          {!continuity.enabled && !continuity.journalEntryCount
            ? 'Préparez les comptes pour commencer à suivre votre résultat. Aucun montant comptable n’est encore présenté.'
            : income &&
                !income.currency.singleCurrency &&
                !income.currency.exchangeRatesApplied
              ? 'Plusieurs devises sont présentes sans conversion : consultez le détail par devise.'
              : 'Les chiffres apparaîtront quand les états comptables seront disponibles.'}
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
                ? 'Commencez par votre configuration'
                : continuity.totalAnomalies || continuity.totalMissing
                  ? 'Quelques opérations sont à vérifier'
                  : 'Votre suivi comptable est en place'}
            </h3>
            <p>
              {!continuity.enabled || !continuity.mappingReady
                ? 'Zentra peut préparer les comptes de base et leurs liaisons. Vous vérifiez le choix avant de les activer.'
                : continuity.totalAnomalies || continuity.totalMissing
                  ? 'Ouvrez les contrôles pour retrouver les pièces manquantes et les écarts à corriger.'
                  : 'Vos opérations alimentent les états. Vérifiez les pièces et les paiements avant chaque déclaration.'}
            </p>
          </div>
        </div>
        <Button variant="secondary" onClick={() => onSection('accounts')}>
          {!continuity.enabled || !continuity.mappingReady
            ? 'Préparer les comptes'
            : 'Vérifier ma configuration'}
          <ArrowRight size={16} />
        </Button>
      </section>
      <section
        className="finance-overview__paths"
        aria-label="Que souhaitez-vous faire ?"
      >
        {[
          {
            id: 'vat' as const,
            title: 'Préparer ma TVA',
            text: 'Retrouver la taxe due, les achats déductibles et les contrôles.',
            icon: ReceiptText,
          },
          {
            id: 'balance' as const,
            title: 'Comprendre mon bilan',
            text: 'Voir ce que l’entreprise possède et ce qu’elle doit.',
            icon: Landmark,
          },
          {
            id: 'closing' as const,
            title: 'Préparer la fin d’année',
            text: 'Contrôler les pièces et exporter le dossier pour la fiduciaire.',
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
      <aside className="finance-overview__learn">
        <h3>Résultat et argent en banque</h3>
        <p>
          Le résultat suit les revenus et les charges. Le solde bancaire suit
          les paiements réellement passés. Une facture peut donc améliorer le
          résultat alors que son paiement reste à recevoir.
        </p>
        <button type="button" onClick={() => onSection('journal')}>
          Consulter les opérations
          <ArrowRight size={15} />
        </button>
      </aside>
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
          ? 'Votre configuration est enregistrée'
          : 'Configurer mes finances'
      }
      description={
        saved
          ? 'Ces délais seront proposés sur vos prochains documents.'
          : 'Choisissez des réglages de départ, puis vérifiez leur effet.'
      }
      onClose={onClose}
      dismissible={!busy}
      className="finance-configuration"
    >
      {!saved ? (
        <>
          <ol
            className="finance-configuration__progress"
            aria-label="Étapes de configuration"
          >
            {['Choisir', 'Vérifier'].map((label, i) => (
              <li key={label} aria-current={step === i ? 'step' : undefined}>
                <span>{i + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          {step === 0 ? (
            <section>
              <h3>Quel délai proposez-vous à vos clients ?</h3>
              <p>
                Il s’agit de conditions commerciales que vous choisissez, à
                convenir avec vos clients.
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
                      <strong>{p.name}</strong>
                      <small>{p.text}</small>
                    </span>
                    <b>
                      {p.days}
                      <small>jours</small>
                    </b>
                  </label>
                ))}
              </div>
            </section>
          ) : (
            <section>
              <h3>Vérifiez les réglages proposés</h3>
              <dl className="finance-configuration__review">
                <div>
                  <dt>Délai de paiement des factures</dt>
                  <dd>
                    {settings.billing.paymentTermsDays} jours{' '}
                    <ArrowRight size={15} />
                    <strong>{chosen!.days} jours</strong>
                  </dd>
                </div>
                <div>
                  <dt>Validité des devis</dt>
                  <dd>
                    {settings.billing.quoteValidityDays} jours{' '}
                    <ArrowRight size={15} />
                    <strong>{chosen!.validity} jours</strong>
                  </dd>
                </div>
              </dl>
              <p>
                Les documents déjà créés gardent leurs conditions. La TVA, les
                coordonnées bancaires et les salaires conservent leurs réglages.
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
                Retour
              </Button>
            ) : null}
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Plus tard
            </Button>
            <Button
              disabled={readOnly || busy || !preset}
              onClick={() => (step === 0 ? setStep(1) : void save())}
            >
              {busy
                ? 'Enregistrement…'
                : step === 0
                  ? 'Vérifier mes choix'
                  : 'Appliquer ces réglages'}
              <ArrowRight size={16} />
            </Button>
          </div>
        </>
      ) : (
        <section className="finance-configuration__done">
          <Check size={35} />
          <h3>Vous pouvez préparer vos documents</h3>
          <p>
            {chosen!.days} jours pour régler une facture, {chosen!.validity}{' '}
            jours pour accepter un devis.
          </p>
          {canInstall ? (
            <div>
              <h4>Prochaine étape : les comptes de base</h4>
              <p>
                Préparez les comptes essentiels pour relier les ventes, achats
                et paiements à la comptabilité. Une confirmation présente leur
                activation.
              </p>
              <Button
                variant="secondary"
                disabled={readOnly || busy}
                onClick={() => {
                  setBusy(true);
                  void onInstallStarter().finally(() => setBusy(false));
                }}
              >
                Préparer les comptes suisses
              </Button>
            </div>
          ) : null}
          <Button onClick={onClose} disabled={busy}>
            Terminer
          </Button>
        </section>
      )}
    </Modal>
  );
}
