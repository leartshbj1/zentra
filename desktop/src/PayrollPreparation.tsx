import { useEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, FileText } from 'lucide-react';
import { Button } from './ui';
import type { PayrollHelpTarget } from './payrollHelp';
import type { PayrollPreparationTask } from './payrollPreparationTasks';
import './payroll-preparation.css';

export function PayrollPreparation({
  employeeName,
  savedNotice,
  tasks,
  busy,
  unavailable = false,
  continueLabel = 'Continuer vers mon salaire',
  proposals,
  onApplyProposals,
  onSaveDraft,
  onFix,
  onBack,
  onContinue,
}: {
  employeeName: string;
  savedNotice?: string;
  tasks: PayrollPreparationTask[];
  busy: boolean;
  unavailable?: boolean;
  continueLabel?: string;
  proposals: string[];
  onApplyProposals: () => void;
  onSaveDraft?: () => void;
  onFix: (target: PayrollHelpTarget, selector?: string) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const useProfile =
    proposals.length > 0 &&
    (!tasks[0] ||
      ['contributions', 'salary', 'pension-contributions'].includes(
        tasks[0].target,
      ));
  const next = useProfile ? undefined : tasks[0];
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }, [next?.id]);
  return (
    <section
      className="payroll-preparation"
      aria-label="Préparer ma première fiche"
      aria-busy={busy}
    >
      <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
        <ArrowLeft size={16} /> Revenir à mon salaire
      </Button>
      <header>
        <span className="payroll-preparation__eyebrow">
          La paie de {employeeName}
        </span>
        <h3 ref={heading} tabIndex={-1}>
          {unavailable ? 'Reprenons la lecture des réglages.' : busy ? 'Vérification de vos réglages…' : next || useProfile
            ? 'On prépare votre fiche ensemble.'
            : 'Les informations sont prêtes.'}
        </h3>
        <p>
          {unavailable ? 'Votre saisie est conservée. Réessayez le chargement avec le bouton au-dessus.' : next || useProfile
            ? 'Complétez un point à la fois. Votre saisie reste dans cette fiche.'
            : continueLabel === 'Calculer le net'
              ? 'Le salaire saisi est conservé. Calculez maintenant les retenues et le montant à verser.'
              : 'Revenez au salaire pour contrôler le montant du mois, puis calculer le net.'}
        </p>
      </header>
      {savedNotice && <p className="payroll-preparation__saved" role="status"><CheckCircle2 size={18} aria-hidden="true" />{savedNotice}</p>}
      <div className="payroll-preparation__status" role="status">
        {unavailable ? 'Lecture des réglages à reprendre' : busy ? (
          'Actualisation des informations…'
        ) : tasks.length || useProfile ? (
          `${tasks.length || 1} point${tasks.length > 1 ? 's' : ''} repéré${tasks.length > 1 ? 's' : ''} à préparer`
        ) : (
          <>
            <CheckCircle2 size={18} /> Préparation terminée
          </>
        )}
      </div>
      {!busy && !unavailable && useProfile && (
        <article className="payroll-preparation__next">
          <span>Vos réglages sont déjà enregistrés</span>
          <h4>Reprendre les cotisations de cette personne</h4>
          <p>
            Zentra a trouvé les cotisations de vos contrats pour ce mois. Elles
            serviront à calculer les retenues et la part de l’entreprise.
          </p>
          <details>
            <summary>Voir les {proposals.length} cotisations proposées</summary>
            <ul>
              {proposals.map((label, index) => (
                <li key={`${index}-${label}`}>{label}</li>
              ))}
            </ul>
          </details>
          <Button type="button" disabled={busy || unavailable} onClick={onApplyProposals}>
            Utiliser ces cotisations
            <ArrowRight size={17} />
          </Button>
        </article>
      )}
      {!busy && !unavailable && (next ? (
        <article className="payroll-preparation__next" key={next.id}>
          <span>La prochaine action</span>
          <h4>{next.title}</h4>
          <p>{next.explanation}</p>
          <div className="payroll-preparation__document">
            <FileText size={20} />
            <div>
              <strong>À avoir sous les yeux</strong>
              <p>{next.document}</p>
            </div>
          </div>
          <Button
            type="button"
            disabled={busy || unavailable}
            onClick={() => onFix(next.target, next.selector)}
          >
            {next.action || 'Ouvrir ce point'}
            <ArrowRight size={17} />
          </Button>
          {next.steps && (
            <details>
              <summary>Comment compléter ce point</summary>
              <ol>
                {next.steps.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ol>
            </details>
          )}
          <details>
            <summary>Pourquoi ce point est demandé</summary>
            <ul>
              {next.messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </details>
          <details>
            <summary>Je n’ai pas encore cette information</summary>
            <p>
              Demandez le document indiqué à votre caisse ou à la personne qui
              prépare habituellement vos salaires.
            </p>
            {!onSaveDraft && (
              <p>
                Revenez au salaire pour continuer votre saisie. Les réglages
                déjà enregistrés sont conservés.
              </p>
            )}
          </details>
        </article>
      ) : (
        !useProfile && (
          <Button type="button" onClick={onContinue} disabled={busy || unavailable}>
            {continueLabel}
            <ArrowRight size={17} />
          </Button>
        )
      ))}
      {tasks.length > 1 && (
        <details className="payroll-preparation__remaining">
          <summary>Voir les autres points à préparer</summary>
          <ol>
            {tasks.slice(1).map((task) => (
              <li key={task.id}>
                <span>{task.title}</span>
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  disabled={busy || unavailable}
                  onClick={() => onFix(task.target, task.selector)}
                >
                  Ouvrir
                </Button>
              </li>
            ))}
          </ol>
        </details>
      )}
      {onSaveDraft && (
        <aside className="payroll-save-later" aria-label="Continuer plus tard">
          <div>
            <strong>Il vous manque un document ?</strong>
            <p>
              Enregistrez votre salaire en brouillon et reprenez cette même
              fiche quand vous aurez les informations. Les cotisations resteront
              à calculer.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onSaveDraft}
          >
            Enregistrer le salaire en brouillon
          </Button>
        </aside>
      )}
      <p className="payroll-preparation__footnote">
        Les réglages du contrat et des assurances serviront aussi aux prochaines
        fiches.
      </p>
    </section>
  );
}
