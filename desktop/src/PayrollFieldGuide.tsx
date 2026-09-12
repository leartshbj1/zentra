import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';
import { revealPayrollField } from './payrollNavigation';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Keep validation in the form, including fields inside closed disclosures. */
export function usePayrollFieldGuide() {
  const id = useId();
  const control = useRef<Control | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const [issue, setIssue] = useState<{ label: string; message: string } | null>(
    null,
  );
  useLayoutEffect(() => { if (issue) reveal(); }, [issue]);
  function clear() {
    cleanup.current?.();
    cleanup.current = null;
    control.current?.removeAttribute('aria-invalid');
    if (control.current) {
      const remaining = (control.current.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .filter((value) => value && value !== id && value !== `${id}-inline`);
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
      [field.getAttribute('aria-describedby'), field.closest('.field') ? `${id}-inline` : id].filter(Boolean).join(' '),
    );
    // Let React commit a controlled input's new value before removing the diagnostic.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const editing = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (control.current === field) clear(); }, 0);
    };
    field.addEventListener('input', editing);
    field.addEventListener('change', editing);
    cleanup.current = () => {
      field.removeEventListener('input', editing);
      field.removeEventListener('change', editing);
      clearTimeout(timer);
    };
    const label =
      field
        .closest('.field')
        ?.querySelector('.field__label')
        ?.textContent?.replace(/obligatoire\s*$/, '')
        .trim() ||
      field.getAttribute('aria-label') ||
      field.labels?.[0]?.textContent?.trim() ||
      'Ce champ';
    setIssue({ label, message });
  }
  function check(form: HTMLElement) {
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
    const dateRange =
      field instanceof HTMLInputElement &&
      field.type === 'date' &&
      (validity.rangeUnderflow || validity.rangeOverflow);
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
    guide: issue ? (<>
      <section className="payroll-field-guide" role="alert" id={id}>
        <strong>À compléter : {issue.label}</strong>
        <p>{issue.message}</p>
        <Button type="button" size="small" variant="secondary" onClick={reveal}>
          Aller au champ à corriger
        </Button>
      </section>
      {control.current?.closest('.field') && createPortal(
        <span id={`${id}-inline`} className="payroll-inline-error">{issue.message}</span>,
        control.current.closest('.field')!,
      )}
      </>
    ) : null,
  };
}
