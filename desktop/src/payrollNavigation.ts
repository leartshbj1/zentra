import type { PayrollHelpTarget } from './payrollHelp';

export type PayrollSetupSection =
  | 'person'
  | 'history'
  | 'insurance'
  | 'contributions'
  | 'accounts'
  | 'advanced-contributions';

export function payrollDestination(target: PayrollHelpTarget): {
  section: PayrollSetupSection;
  selector: string;
} {
  switch (target) {
    case 'pension-person':
      return { section: 'person', selector: '[name=lppAnnualSalary]' };
    case 'pension-plan':
      return { section: 'insurance', selector: '[data-pension-plan]' };
    case 'pension-contributions':
      return { section: 'contributions', selector: '[data-pension-guide]' };
    case 'situation':
      return { section: 'person', selector: '[data-payroll-situation]' };
    case 'person':
      return { section: 'person', selector: '[name=birthDate]' };
    case 'insurance':
      return { section: 'insurance', selector: '[name=avsFund]' };
    case 'history':
      return { section: 'history', selector: '[data-payroll-history]' };
    case 'accounts':
      return { section: 'accounts', selector: '[name=wagesExpenseAccountId]' };
    case 'advanced-contributions':
      return {
        section: 'advanced-contributions',
        selector: '.payroll-definitions',
      };
    default:
      return { section: 'contributions', selector: '.payroll-contracts' };
  }
}

/** Open disclosure ancestors before focusing, including on narrow screens. */
export function revealPayrollField(root: HTMLElement | null, selector: string) {
  const field = root?.querySelector<HTMLElement>(selector);
  if (!field) return;
  let parent: HTMLElement | null = field;
  while (parent && parent !== root) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
  if (!field.matches('input, select, textarea, button, a, [tabindex]'))
    field.tabIndex = -1;
  field.focus({ preventScroll: true });
  field.scrollIntoView({ block: 'center', behavior: 'instant' });
}
