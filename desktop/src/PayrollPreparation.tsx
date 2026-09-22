import { t, useAppLanguage } from './language';
import { useEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, FileText } from 'lucide-react';
import { Button } from './ui';
import type { PayrollHelpTarget } from './payrollHelp';
import type { PayrollPreparationTask } from './payrollPreparationTasks';
import './payroll-preparation.css';
import './workflow-clarity.css';

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
  useAppLanguage();
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
      aria-label={t("Préparer ma première fiche")}
      aria-busy={busy}
    >
      <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
        <ArrowLeft size={16} />{t(" Revenir à mon salaire")}</Button>
      <header>
        <span className="payroll-preparation__eyebrow">{t('La paie de {name}', { name: employeeName })}
        </span>
        <h3 ref={heading} tabIndex={-1}>
          {unavailable ? t("Reprenons la lecture des réglages.") : busy ? t("Vérification de vos réglages…") : next || useProfile
            ? t("On prépare votre fiche ensemble.")
            : t("Les informations sont prêtes.")}
        </h3>
        <p>
          {unavailable ? t("Votre saisie est conservée. Réessayez le chargement avec le bouton au-dessus.") : next || useProfile
            ? t("Complétez un point à la fois. Votre saisie reste dans cette fiche.")
            : continueLabel === 'Calculer le net'
              ? t("Le salaire saisi est conservé. Calculez maintenant les retenues et le montant à verser.")
              : t("Revenez au salaire pour contrôler le montant du mois, puis calculer le net.")}
        </p>
      </header>
      {savedNotice && <p className="payroll-preparation__saved" role="status"><CheckCircle2 size={18} aria-hidden="true" />{t(savedNotice)}</p>}
      <div className="payroll-preparation__status" role="status">
        {unavailable ? t("Lecture des réglages à reprendre") : busy ? (
          t("Actualisation des informations…")
        ) : tasks.length || useProfile ? (
          t(tasks.length > 1 ? '{count} points repérés à préparer' : '{count} point repéré à préparer', { count: tasks.length || 1 })
        ) : (
          <>
            <CheckCircle2 size={18} />{t(" Préparation terminée")}</>
        )}
      </div>
      {!busy && !unavailable && useProfile && (
        <article className="payroll-preparation__next">
          <span>{t("Vos réglages sont déjà enregistrés")}</span>
          <h4>{t("Reprendre les cotisations de cette personne")}</h4>
          <p>{t("Zentra a trouvé les cotisations de vos contrats pour ce mois. Elles serviront à calculer les retenues et la part de l’entreprise.")}</p>
          <details>
            <summary>{t(proposals.length === 1 ? 'Voir la cotisation proposée' : 'Voir les {count} cotisations proposées', { count: proposals.length })}</summary>
            <ul>
              {proposals.map((label, index) => (
                <li key={`${index}-${label}`}>{label}</li>
              ))}
            </ul>
          </details>
          <Button type="button" disabled={busy || unavailable} onClick={onApplyProposals}>{t("Utiliser ces cotisations")}<ArrowRight size={17} />
          </Button>
        </article>
      )}
      {!busy && !unavailable && (next ? (
        <article className="payroll-preparation__next" key={next.id}>
          <h4>{t(next.title)}</h4>
          <p>{t(next.explanation)}</p>
          <details className="workflow-options"><summary>{t('Document nécessaire')}</summary><div className="payroll-preparation__document">
            <FileText size={20} />
            <div>
              <strong>{t("À avoir sous les yeux")}</strong>
              <p>{t(next.document)}</p>
            </div>
          </div></details>
          <Button
            type="button"
            disabled={busy || unavailable}
            onClick={() => onFix(next.target, next.selector)}
          >
            {t(next.action || 'Ouvrir ce point')}
            <ArrowRight size={17} />
          </Button>
          {next.steps && (
            <details>
              <summary>{t("Comment compléter ce point")}</summary>
              <ol>
                {next.steps.map((text) => (
                  <li key={text}>{t(text)}</li>
                ))}
              </ol>
            </details>
          )}
          <details>
            <summary>{t("Pourquoi ce point est demandé")}</summary>
            <ul>
              {next.messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </details>
          <details>
            <summary>{t("Je n’ai pas encore cette information")}</summary>
            <p>{t("Demandez le document indiqué à votre caisse ou à la personne qui prépare habituellement vos salaires.")}</p>
            {!onSaveDraft && (
              <p>{t("Revenez au salaire pour continuer votre saisie. Les réglages déjà enregistrés sont conservés.")}</p>
            )}
          </details>
        </article>
      ) : (
        !useProfile && (
          <Button type="button" onClick={onContinue} disabled={busy || unavailable}>
            {t(continueLabel)}
            <ArrowRight size={17} />
          </Button>
        )
      ))}
      {tasks.length > 1 && (
        <details className="payroll-preparation__remaining">
          <summary>{t("Voir les autres points à préparer")}</summary>
          <ol>
            {tasks.slice(1).map((task) => (
              <li key={task.id}>
                <span>{t(task.title)}</span>
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  disabled={busy || unavailable}
                  onClick={() => onFix(task.target, task.selector)}
                >{t("Ouvrir")}</Button>
              </li>
            ))}
          </ol>
        </details>
      )}
      {onSaveDraft && (
        <aside className="payroll-save-later" aria-label={t("Continuer plus tard")}>
          <div>
            <strong>{t("Il vous manque un document ?")}</strong>
            <p>{t('Enregistrez un brouillon et complétez-le plus tard.')}</p>
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onSaveDraft}
          >{t("Enregistrer le salaire en brouillon")}</Button>
        </aside>
      )}
    </section>
  );
}
