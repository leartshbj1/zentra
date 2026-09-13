import { t, useAppLanguage } from './language';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button, Field } from './ui';
import { formatMoney } from './utils';
import { missingPayrollBasis, payrollBasisNames, payrollDecimal, type PayrollBasisQuestion } from './payrollSalaryEntry';
import './payroll-preparation.css';

export function PayrollBasisGuide({ questions, grossCents, busy, onConfirm, onBack, onComplete, reviewing }: {
  questions: PayrollBasisQuestion[];
  grossCents: number;
  busy: boolean;
  onConfirm: (id: string, patch: { basisCents?: number; yearToDateBasisCents?: number }) => void;
  onBack: () => void;
  onComplete: () => void;
  reviewing: boolean;
}) {
  useAppLanguage();
  // Keep the question order stable while answers update the parent form.
  const [order] = useState(() => questions.map(question => question.id));
  const [index, setIndex] = useState(() => Math.max(0, questions.findIndex(missingPayrollBasis)));
  const [finished, setFinished] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const heading = useRef<HTMLHeadingElement>(null);
  const question = questions.find(item => item.id === order[index]);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'start' }); }, [index, finished]);
  const remaining = questions.filter(missingPayrollBasis);
  return <section className="payroll-preparation payroll-basis-guide" aria-label={t("Comprendre les montants soumis aux assurances")}>
    <Button type="button" variant="ghost" disabled={busy} onClick={onBack}><ArrowLeft size={16} />{t(" Revenir à mon salaire")}</Button>
    <header>
      <h3 ref={heading} tabIndex={-1}>{finished ? t("Vos montants sont renseignés.") : reviewing ? t("Le salaire a changé. Vérifions les montants.") : t("Quel montant sert au calcul ?")}</h3>
      <p>{t("Une assurance à la fois. Vous confirmez le montant du salaire auquel son taux s’applique. Zentra calcule ensuite la retenue.")}</p>
    </header>
    {finished ? <>
      <p role="status">{remaining.length ? t("Il reste un montant à vérifier.") : t("Les montants confirmés sont conservés dans cette fiche. Revenez au salaire pour vérifier le net.")}</p>
      <Button type="button" disabled={busy} onClick={() => {
        if (remaining[0]) { setIndex(order.indexOf(remaining[0].id)); setFinished(false); }
        else onComplete();
      }}>{remaining.length ? t("Compléter le montant manquant") : t("Continuer vers mon salaire")}<ArrowRight size={16} /></Button>
    </> : question ? <BasisQuestion key={question.id} question={question} grossCents={grossCents} busy={busy}
      draft={drafts[question.id]} onDraft={amount => setDrafts(previous => ({ ...previous, [question.id]: amount }))}
      index={index} count={order.length} onPrevious={index > 0 ? () => setIndex(index - 1) : undefined}
      onConfirm={amount => {
        onConfirm(question.definitionId, { [question.field]: amount });
        if (index + 1 < order.length) setIndex(index + 1); else setFinished(true);
      }} /> : <p role="status">{t("Les réglages de cette assurance ont changé. Revenez au salaire pour reprendre la vérification avec les informations actualisées.")}</p>}
    <p className="payroll-preparation__footnote">{t("Un montant inconnu peut être complété plus tard : revenez au salaire pour enregistrer un brouillon.")}</p>
  </section>;
}

function BasisQuestion({ question, grossCents, busy, index, count, onConfirm, onPrevious, draft, onDraft }: {
  question: PayrollBasisQuestion; grossCents: number; busy: boolean; index: number; count: number;
  onConfirm: (amount: number) => void; onPrevious?: () => void;
  draft?: string; onDraft: (amount: string) => void;
}) {
  useAppLanguage();
  const [amount, setAmount] = useState(draft ?? (question.amountCents === undefined ? '' : (question.amountCents / 100).toFixed(2)));
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const annual = question.field === 'yearToDateBasisCents';
  return <form className="payroll-preparation__next" noValidate onSubmit={event => {
    event.preventDefault();
    if (busy) return;
    const parsed = payrollDecimal(amount);
    if (parsed === undefined) { setError('Recopiez le montant confirmé, avec deux décimales au maximum. Laissez cette étape pour plus tard si vous ne le connaissez pas.'); field.current?.focus(); return; }
    onConfirm(parsed);
  }}>
    <span>{t('Montant {index} sur {count}', { index: index + 1, count })}</span>
    <h4>{question.definitions[0] && payrollBasisNames[question.definitions[0].category] ? t(payrollBasisNames[question.definitions[0].category]!) : question.label}</h4>
    <p>{annual
      ? t("Additionnez les montants déjà soumis à cette assurance avant ce mois, pour cette année. Ne comptez pas le salaire de ce mois.")
      : t("Recopiez le salaire soumis à cette assurance, avant de déduire les cotisations. Cette information figure dans votre décompte de paie ou peut être confirmée par votre fiduciaire.")}</p>
    {!annual && <div className="payroll-basis-example"><strong>{t("Exemple pour comprendre")}</strong><p>{t("Si le montant soumis est 5’000 CHF et le taux de 1 %, la retenue est 50 CHF. Vous saisissez 5’000, pas 50. Cet exemple ne fixe pas votre taux.")}</p></div>}
    <Field label={annual ? t("Montant déjà soumis avant ce mois (CHF)") : t("Salaire soumis à cette assurance (CHF)")} error={t(error)}
      hint={annual ? t("Saisissez 0 uniquement si aucun montant n’a déjà été soumis cette année.") : t("Votre brut du mois est {v0}. Les allocations, indemnités et frais peuvent avoir un traitement différent.", { v0: formatMoney(grossCents) })}>
      <input ref={field} aria-label={annual ? t("Montant déjà soumis avant ce mois (CHF)") : t("Salaire soumis à cette assurance (CHF)")}
        type="text" inputMode="decimal" value={amount} disabled={busy} onChange={event => { setAmount(event.target.value); onDraft(event.target.value); setError(''); }} />
    </Field>
    <details><summary>{t("Voir les cotisations concernées")}</summary><ul>{question.definitions.map(definition =>
      <li key={definition.id}>{definition.label} · {definition.side === 'employee' ? t("part du salarié") : t("part de l’entreprise")}<br />{definition.source}</li>)}</ul></details>
    <div className="payroll-basis-guide__actions">
      {onPrevious && <Button type="button" variant="ghost" disabled={busy} onClick={onPrevious}>{t("Précédent")}</Button>}
      <Button type="submit" disabled={busy}>{t("Confirmer ce montant ")}<ArrowRight size={16} /></Button>
    </div>
  </form>;
}
