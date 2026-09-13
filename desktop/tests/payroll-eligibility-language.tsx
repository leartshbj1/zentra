// Production payslip form with synthetic payroll data; never part of the application entry.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DetailedPayslipForm } from '../src/DetailedPayslipForm';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { installPayrollFixture } from './payroll-fixture';
import { desktopApi } from '../src/bridge';
import type { Workspace, AccountingSettings } from '../src/types';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/experience.css';
import '../src/workspace-shell.css';
import '../src/clarity.css';
import '../src/language.css';
import '../src/refined.css';
import '../src/payroll-guided.css';

const original = { settings: structuredClone(initialOnboardingSettings), employees: [], payslips: [], employeePayrollTemplates: [] } as unknown as Workspace;
desktopApi.getAccountingSettings = async () => ({ enabled: true, wagesExpenseAccountId: 'expense-qa', wagesPayableAccountId: 'social-qa' } as AccountingSettings);
installPayrollFixture(original);
original.employees[0].contractualWeeklyMinutes = 2395;
original.employees[0].smallSalaryOpeningGrossCents = 123456;
original.employees[0].smallSalaryOpeningContributedBasisCents = 12345;
original.employees[0].acOpeningBasisCents = 23456;
original.settings.payroll.lppPlanEvidence!.contractNumber = 'Police-{v0}-{v2}-' + 'RéférenceLongue'.repeat(10);
function Journey() {
  const [workspace, setWorkspace] = useState(original), [busy, setBusy] = useState(false), [closed, setClosed] = useState(false);
  useEffect(() => {
    function scenario(event: Event) {
      const name = (event as CustomEvent).detail;
      const next = structuredClone(original);
      if (name === 'expired') next.settings.payroll.lppPlanEvidence!.effectiveTo = '2026-08-31';
      else if (name === 'reference-age') next.employees[0].birthDate = '1960-01-01';
      else if (name === 'missing-person') { next.employees[0].birthDate = ''; next.employees[0].contractualWeeklyMinutes = null; next.employees[0].acOpeningYear = null; }
      setWorkspace(next);
    }
    window.addEventListener('qa-eligibility-scenario', scenario);
    return () => window.removeEventListener('qa-eligibility-scenario', scenario);
  }, []);
  return closed ? <output>Saved</output> : <DetailedPayslipForm workspace={workspace} initialEmployeeId="elodie" initialPeriod="2026-09" initialPaymentDate="2026-09-30" busy={busy} close={() => setClosed(true)} act={async (action, _message, _close, onError) => { setBusy(true); try { setWorkspace(await action()); return true; } catch (error) { onError?.(error); return false; } finally { setBusy(false); } }} />;
}
createRoot(document.getElementById('root')!).render(<Journey />);
