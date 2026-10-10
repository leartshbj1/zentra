import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsTestOnboarding } from '../../components/account/us-test-onboarding';
import { usTestOnboardingCopy } from './us-test-onboarding-copy';
import { onboardingActor } from './us-test-onboarding.test-fixtures';

describe('localized explicit US TEST onboarding form', () => {
  for (const language of ['fr', 'de', 'it', 'en'] as const) it(`renders ${language} with explicit settings and no default business facts`, () => {
    const html = renderToStaticMarkup(createElement(UsTestOnboarding, { expectedUserId: onboardingActor, language })), c = usTestOnboardingCopy[language];
    expect(html).toContain(c.title); expect(html).toContain(c.confirmCompany); expect(html).toContain(c.storage); expect(html).toContain('aria-current="step"');
    for (const name of ['subdivision', 'timeZone', 'accountingBasis']) expect(html).toMatch(new RegExp(`name="${name}"[^>]*><option value="" selected=""`));
    expect(html).not.toContain('Fictitious'); expect(html).not.toContain('name="ein"'); expect(html).not.toContain('checkout.stripe.com'); expect(html).not.toContain('checked=""');
  });
  it('keeps return information separate from confirmed payment', () => { const html = renderToStaticMarkup(createElement(UsTestOnboarding, { expectedUserId: onboardingActor, language: 'en', checkoutReturn: 'returned' })); expect(html).toContain(usTestOnboardingCopy.en.returned); expect(html).not.toContain(usTestOnboardingCopy.en.open); expect(html).not.toContain(usTestOnboardingCopy.en.readyDetail); });
});
