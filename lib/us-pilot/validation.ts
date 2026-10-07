import { usMarket } from '../markets/us';

export const employeeCounts = [
  '1–4',
  '5–10',
  '11–30',
  '31–100',
  '100+',
] as const;
export const eventNames = [
  'page_view',
  'watch_demo',
  'demo_completed',
  'pilot_cta_clicked',
  'pilot_form_started',
  'pilot_form_submitted',
] as const;
export type PilotEventName = (typeof eventNames)[number];
export type Attribution = {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
};
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isPilotUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}
export class PilotInputError extends Error {
  constructor(public readonly fields: Record<string, string>) {
    super('Please check the highlighted fields.');
  }
}
export function attribution(input: Record<string, unknown>): Attribution {
  const clean = (name: string) =>
    typeof input[name] === 'string'
      ? (input[name] as string)
          .split('')
          .filter(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          )
          .join('')
          .trim()
          .slice(0, 120) || null
      : null;
  return {
    utm_source: clean('utm_source'),
    utm_medium: clean('utm_medium'),
    utm_campaign: clean('utm_campaign'),
  };
}
export function validateLead(input: Record<string, unknown>) {
  const fields: Record<string, string> = {};
  const text = (name: string, label: string, max: number, required = true) => {
    const value = typeof input[name] === 'string' ? input[name].trim() : '';
    if (
      (required && !value) ||
      value.length > max ||
      value.split('').some((character) => {
        const code = character.charCodeAt(0);
        return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
      })
    )
      fields[name] =
        `Enter ${label}${max > 500 ? ` (up to ${max} characters)` : ''}.`;
    return value;
  };
  const first_name = text('first_name', 'your first name', 80);
  const last_name = text('last_name', 'your last name', 80);
  const email = text('email', 'a valid work email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    fields.email = 'Enter a valid work email.';
  const company = text('company', 'your company name', 160);
  let website = text('website', 'a valid company website', 500, false);
  if (website) {
    try {
      const url = new URL(
        /^https?:\/\//i.test(website) ? website : `https://${website}`,
      );
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        !url.hostname.includes('.')
      )
        throw new Error();
      website = url.toString();
    } catch {
      fields.website = 'Enter a valid company website, such as example.com.';
    }
  }
  const industry = text('industry', 'your industry', 120);
  const employee_count = text('employee_count', 'your team size', 20);
  if (!(employeeCounts as readonly string[]).includes(employee_count))
    fields.employee_count = 'Choose your team size.';
  const pain_point = text('pain_point', 'your most repetitive task', 2000);
  const current_tools = text(
    'current_tools',
    'the tools you currently use',
    2000,
  );
  if (typeof input.demo_interest !== 'boolean')
    fields.demo_interest = 'Choose Yes or No.';
  if (!isPilotUuid(input.submission_id))
    fields.form = 'Please reopen the form and try again.';
  if (Object.keys(fields).length) throw new PilotInputError(fields);
  return {
    first_name,
    last_name,
    email,
    company,
    website: website || null,
    industry,
    employee_count,
    pain_point,
    current_tools,
    demo_interest: input.demo_interest as boolean,
    submission_id: input.submission_id as string,
    source: 'us_landing',
    offer_version: usMarket.pilot.offerId,
    ...attribution(input),
  };
}
