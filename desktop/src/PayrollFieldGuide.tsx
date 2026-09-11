import { useId, useRef, useState } from 'react';
import { Button } from './ui';
import { revealPayrollField } from './payrollNavigation';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Keep validation in the form, including fields inside closed disclosures. */
export function usePayrollFieldGuide() {
  const id = useId();
  const control = useRef<Control | null>(null);
  const [issue, setIssue] = useState<{ label: string; message: string } | null>(
    null,
  );
  function clear() {
    control.current?.removeAttribute('aria-invalid');
    if (control.current) {
      const remaining = (control.current.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .filter((value) => value && value !== id);
      if (remaining.length)
        control.current.setAttribute('aria-describedby', remaining.join(' '));
      else control.current.removeAttribute('aria-describedby');
    }
    control.current = null;
    setIssue(null);
  }
  function reveal() {
    const field = control.current;
    if (field) {
      field.dataset.payrollInvalid = 'true';
      revealPayrollField(field.form, '[data-payroll-invalid]');
      delete field.dataset.payrollInvalid;
    }
  }
  function reject(field: Control, message: string) {
    clear();
    control.current = field;
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute(
      'aria-describedby',
      [field.getAttribute('aria-describedby'), id].filter(Boolean).join(' '),
    );
    const label =
      field
        .closest('label')
        ?.querySelector('.field__label')
        ?.textContent?.replace(/obligatoire\s*$/, '')
        .trim() ||
      field.getAttribute('aria-label') ||
      'Ce champ';
    setIssue({ label, message });
    reveal();
  }
  function check(form: HTMLFormElement) {
    const field = form.querySelector<Control>(
      'input:invalid, select:invalid, textarea:invalid',
    );
    if (!field) {
      clear();
      return true;
    }
    const validity = field.validity;
    const value = (text: string) =>
      field instanceof HTMLInputElement && field.type === 'date'
        ? text.split('-').reverse().join('.')
        : text;
    const dateRange = field instanceof HTMLInputElement && field.type === 'date' && (validity.rangeUnderflow || validity.rangeOverflow);
    const message = dateRange
      ? `La date saisie est le ${value(field.value)}. Choisissez une date${field.min ? ` à partir du ${value(field.min)}` : ''}${field.max ? ` et au plus tard le ${value(field.max)}` : ''}.${field.name === 'decisionDate' ? ' Recopiez le jour où le choix de cotisation a été confirmé sur votre déclaration ou confirmation écrite pour cette année.' : ' Recopiez la date indiquée sur votre document.'}`
      : validity.valueMissing
      ? field instanceof HTMLSelectElement
        ? 'Choisissez une réponse dans la liste pour continuer.'
        : 'Complétez ce champ pour continuer. Les autres informations restent conservées.'
      : field instanceof HTMLInputElement &&
          (validity.rangeUnderflow || validity.rangeOverflow)
        ? `La valeur doit respecter ${field.min ? `le minimum ${value(field.min)}` : ''}${field.min && field.max ? ' et ' : ''}${field.max ? `le maximum ${value(field.max)}` : ''}. Vérifiez votre document avant de la corriger.`
        : validity.stepMismatch
          ? 'Indiquez le montant ou la valeur avec la précision demandée sous ce champ. Ne changez pas un taux de contrat pour le faire accepter.'
          : 'Vérifiez le format de cette information. Pour une date, utilisez le calendrier ; pour un montant, saisissez uniquement un nombre.';
    reject(field, message);
    return false;
  }
  return {
    check,
    reject,
    clear,
    guide: issue ? (
      <section className="payroll-field-guide" role="alert" id={id}>
        <strong>À compléter : {issue.label}</strong>
        <p>{issue.message}</p>
        <Button type="button" size="small" variant="secondary" onClick={reveal}>
          Aller au champ à corriger
        </Button>
      </section>
    ) : null,
  };
}
