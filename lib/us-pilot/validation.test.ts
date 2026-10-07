import { describe, expect, it } from 'vitest';
import { attribution, PilotInputError, validateLead } from './validation';
export const validLead = {
  first_name: 'Alex',
  last_name: 'Taylor',
  email: 'Alex@company.test',
  company: 'Example Services',
  website: 'example.com',
  industry: 'Consulting',
  employee_count: '11–30',
  pain_point: 'Copying customer requests into spreadsheets',
  current_tools: 'Email and spreadsheets',
  demo_interest: true,
  submission_id: '10000000-0000-4000-8000-000000000001',
};
describe('US pilot validation', () => {
  it('normalizes lead values and never accepts visitor-controlled status/source/offer', () => {
    const lead = validateLead({
      ...validLead,
      status: 'converted',
      source: 'fake',
      offer_version: 'unlimited-free-forever',
      first_name: ' Alex ',
      utm_source: 'campaign',
    });
    expect(lead.email).toBe('alex@company.test');
    expect(lead.first_name).toBe('Alex');
    expect(lead.website).toBe('https://example.com/');
    expect(lead.source).toBe('us_landing');
    expect(lead.offer_version).toBe('us-pilot-free-month-v1');
    expect(lead).not.toHaveProperty('status');
  });
  it.each([
    'email',
    'first_name',
    'last_name',
    'company',
    'industry',
    'employee_count',
    'pain_point',
    'current_tools',
    'demo_interest',
    'submission_id',
  ])('rejects missing %s', (field) => {
    expect(() => validateLead({ ...validLead, [field]: undefined })).toThrow(
      PilotInputError,
    );
  });
  it.each([
    'javascript:alert(1)',
    'https://user:password@example.com',
    'not-a-website',
  ])('rejects unsafe website %s', (website) => {
    expect(() => validateLead({ ...validLead, website })).toThrow(
      PilotInputError,
    );
  });
  it('accepts no website and a no-demo preference', () => {
    expect(
      validateLead({ ...validLead, website: '', demo_interest: false }),
    ).toMatchObject({ website: null, demo_interest: false });
  });
  it('rejects oversized input', () => {
    expect(() =>
      validateLead({ ...validLead, pain_point: 'a'.repeat(2001) }),
    ).toThrow(PilotInputError);
  });
  it('bounds and cleans UTM values', () => {
    expect(
      attribution({
        utm_source: ' test\u0000 ',
        utm_campaign: 'a'.repeat(200),
        utm_medium: {},
      }),
    ).toEqual({
      utm_source: 'test',
      utm_campaign: 'a'.repeat(120),
      utm_medium: null,
    });
  });
});
