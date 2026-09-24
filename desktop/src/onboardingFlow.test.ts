import { describe, it, expect } from 'vitest';
import { enabledSetupPages, parseSetupDraft, setupPageForIssue, setupPageIndex, setupPages } from './onboardingFlow';
import { initialOnboardingSettings } from './onboardingDraft';
import { validateOnboarding } from './onboardingValidation';

describe('complete first-launch journey',()=>{
  it('migrates legacy payroll drafts, preserving entered rates and bank details',()=>{
    const settings=structuredClone(initialOnboardingSettings);settings.billing.iban='CH9300762011623852957';settings.payroll.enabled=true;settings.payroll.employeeRates=[{id:'avs',label:'AVS',rateBp:530,effectiveFrom:'2026-01-01'}];
    const result=parseSetupDraft(JSON.stringify({version:1,step:4,highestStep:6,settings,privacyConfirmed:true}));
    expect(result?.step).toBe(setupPageIndex('payroll'));expect(result?.highestStep).toBe(setupPageIndex('review'));
    expect(result?.settings.billing.iban).toBe(settings.billing.iban);expect(result?.settings.payroll.employeeRates).toEqual(settings.payroll.employeeRates);expect(result?.privacyConfirmed).toBe(true);
  });
  it('skips only inactive payroll detail pages and restores them without wiping input',()=>{
    const settings=structuredClone(initialOnboardingSettings);
    expect(enabledSetupPages(settings)).not.toContain(setupPageIndex('insurance'));
    expect(enabledSetupPages(settings)).toContain(setupPageIndex('payroll'));
    settings.payroll.enabled=true;expect(enabledSetupPages(settings)).toHaveLength(setupPages.length);
    settings.payroll.enabled=false;
    expect(parseSetupDraft(JSON.stringify({version:2,step:10,highestStep:14,settings}))?.step).toBe(9);
  });
  it('routes validation by field rather than the old long page number',()=>{
    const expected={ 'organization.legalName':'identity','organization.address.street':'address','organization.vatIdentifier':'tax','business.nogaSection':'activity','billing.iban':'bank','billing.invoicePrefix':'documents','work.workWeekHours':'work','payroll.accidentInsurer':'insurance','payroll.lppPlanEvidence.effectiveTo':'contributions','payroll.employeeRates.abc.rateBp':'contributions','backup.folder':'backup'} as const;
    for(const [field,id] of Object.entries(expected)) expect(setupPageForIssue({field,step:1}),field).toBe(setupPageIndex(id));
  });
  it('keeps full financial and backup validation; no essential-only shortcut',()=>{
    const settings=structuredClone(initialOnboardingSettings);
    const issues=validateOnboarding(settings,null,false,'complete','folder');
    expect(issues.map(issue=>issue.field)).toEqual(expect.arrayContaining(['billing.iban','work.workWeekHours','backup.folder','backup.privacyConfirmed']));
    for(const issue of issues) expect(setupPageForIssue(issue)).toBeLessThan(setupPages.length);
  });
  it('ignores broken and unsupported drafts and bounds corrupt progress',()=>{
    for(const raw of [null,'bad','null','{}','{"version":9}']) expect(parseSetupDraft(raw)).toBeNull();
    const result=parseSetupDraft(JSON.stringify({version:2,step:999,highestStep:-1,settings:initialOnboardingSettings}));
    expect(result?.step).toBe(14);expect(result?.highestStep).toBe(14);
  });
});
