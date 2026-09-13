import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { t, useAppLanguage, type InterfaceMessage } from './language';
import { payrollDateValidity, payrollFieldMessage, type PayrollFieldValidation } from './payrollFieldLanguage';
import { createPortal } from 'react-dom';
import { Button } from './ui';
import { revealPayrollField } from './payrollNavigation';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function dateFallback(field: Control) {
  return field instanceof HTMLInputElement && field.getAttribute('type') === 'date' && field.type !== 'date'
    ? payrollDateValidity(field.value, field.min, field.max) : null;
}

/** Keep validation in the form, including fields inside closed disclosures. */
export function usePayrollFieldGuide() {
  const language = useAppLanguage();
  const id = useId();
  const [label, setLabel] = useState('');
  const control = useRef<Control | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const [issue, setIssue] = useState<{ message: string; validation?: PayrollFieldValidation; presentation?: InterfaceMessage } | null>(
    null,
  );
  useLayoutEffect(() => { if (issue) reveal(); }, [issue]);
  useLayoutEffect(() => {
    if (!issue || !control.current) return;
    const field = control.current;
    const labelNode = (field.closest('.field')?.querySelector('.field__label') ?? field.labels?.[0])?.cloneNode(true) as Element | undefined;
    // Required markers are interface copy too; remove them structurally in every language.
    labelNode?.querySelectorAll('em, input, select, textarea, .field__hint, .field__error, .payroll-inline-error').forEach(node => node.remove());
    setLabel(labelNode?.textContent?.trim() || field.getAttribute('aria-label') || t('Ce champ'));
  }, [issue, language]);
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
      // Keep the explanation beside the input visible in a scrolling mobile sheet.
      const group = field.closest<HTMLElement>('.field');
      const body = field.closest<HTMLElement>('.modal__body');
      if (group?.querySelector('.payroll-inline-error') && body && body.scrollHeight > body.clientHeight) {
        const bounds = body.getBoundingClientRect();
        const top = Math.max(0, bounds.top) + 12;
        const available = Math.min(window.innerHeight, bounds.bottom) - top - 12;
        const content = group.getBoundingClientRect();
        body.scrollTop += content.top - top - Math.max(0, (available - content.height) / 2);
      }
    }
  }
  function showIssue(field: Control, message: string, validation?: PayrollFieldValidation, presentation?: InterfaceMessage) {
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
    setIssue({ message, validation, presentation });
  }
  function firstInvalid(form: HTMLElement) {
    return [...form.querySelectorAll<Control>('input, select, textarea')].find(candidate => {
      if (!candidate.willValidate) return false;
      const fallback = dateFallback(candidate);
      return !candidate.validity.valid || fallback && (fallback.typeMismatch || fallback.rangeUnderflow || fallback.rangeOverflow);
    });
  }
  function check(form: HTMLElement) {
    const field = firstInvalid(form);
    if (!field) {
      clear();
      return true;
    }
    const validity = field.validity;
    const input = field instanceof HTMLInputElement ? field : null;
    const validation: PayrollFieldValidation = {
      type: input?.getAttribute('type') ?? input?.type ?? '', name: field.name, value: field.value,
      min: input?.min ?? '', max: input?.max ?? '', required: field.required,
      select: field instanceof HTMLSelectElement,
      typeMismatch: validity.typeMismatch, valueMissing: validity.valueMissing,
      rangeUnderflow: validity.rangeUnderflow, rangeOverflow: validity.rangeOverflow,
      stepMismatch: validity.stepMismatch,
      ...dateFallback(field),
    };
    // Raw French stays available to existing routing and assistant classifiers.
    showIssue(field, payrollFieldMessage(validation, 'fr'), validation);
    return false;
  }
  const explanation = issue ? issue.validation ? payrollFieldMessage(issue.validation, language)
    : issue.presentation ? t(issue.presentation.source, issue.presentation.values) : t(issue.message) : '';
  return {
    check,
    firstInvalid,
    reject: (field: Control, message: string, presentation?: InterfaceMessage) => showIssue(field, message, undefined, presentation),
    clear,
    message: issue?.message ?? '',
    guide: issue ? (<>
      <section className="payroll-field-guide" role="alert" id={id}>
        <strong>{t('À compléter : {field}', { field: label })}</strong>
        <p>{explanation}</p>
        <Button type="button" size="small" variant="secondary" onClick={reveal}>
          {t('Aller au champ à corriger')}
        </Button>
      </section>
      {control.current?.closest('.field') && createPortal(
        <span id={`${id}-inline`} className="payroll-inline-error">{explanation}</span>,
        control.current.closest('.field')!,
      )}
      </>
    ) : null,
  };
}
