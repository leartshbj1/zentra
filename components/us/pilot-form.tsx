'use client';
import { useRef, useState, type SyntheticEvent } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { usMarket } from '@/lib/markets/us';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  employeeCounts,
  PilotInputError,
  validateLead,
} from '@/lib/us-pilot/validation';
import {
  pilotContext,
  pilotMeasurementAllowed,
  trackPilotEvent,
} from '@/lib/us-pilot/analytics';

export function PilotForm({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="us-pilot-dialog" lang="en-US">
        <Application />
      </DialogContent>
    </Dialog>
  );
}
function Application() {
  const [identity] = useState(() => ({
    submission_id: crypto.randomUUID(),
    started_at: Date.now(),
  }));
  const started = useRef(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const visit = pilotContext();
    const input = {
      ...values,
      ...identity,
      ...visit.attribution,
      visitor_id: visit.visitor_id,
      measurement_allowed: pilotMeasurementAllowed(),
      demo_interest:
        values.demo_interest === 'yes'
          ? true
          : values.demo_interest === 'no'
            ? false
            : undefined,
    };
    setError('');
    setErrors({});
    try {
      validateLead(input);
    } catch (error) {
      if (error instanceof PilotInputError) {
        setErrors(error.fields);
        setError(error.message);
        form
          .querySelector<HTMLElement>(
            `[name="${Object.keys(error.fields)[0]}"]`,
          )
          ?.focus();
      }
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/us-pilot/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        fields?: Record<string, string>;
        error?: string;
      };
      if (!response.ok || result.ok !== true) {
        setErrors(result.fields ?? {});
        throw new Error(
          result.error ||
            'We could not save your application. Please try again.',
        );
      }
      setDone(true);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Connection interrupted. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  const field = (
    name: string,
    label: string,
    props: {
      type?: string;
      autoComplete?: string;
      maxLength?: number;
      required?: boolean;
    } = {},
  ) => (
    <label className="us-field" htmlFor={`us-${name}`}>
      <span id={`us-label-${name}`}>
        {label}
        {props.required === false && <small>Optional</small>}
      </span>
      <Input
        id={`us-${name}`}
        name={name}
        className="us-input"
        type={props.type ?? 'text'}
        autoComplete={props.autoComplete}
        maxLength={props.maxLength ?? 160}
        required={props.required !== false}
        aria-labelledby={`us-label-${name}`}
        aria-invalid={!!errors[name]}
        aria-describedby={errors[name] ? `us-error-${name}` : undefined}
      />
      <FieldError name={name} errors={errors} />
    </label>
  );
  if (done)
    return (
      <div className="us-form-success">
        <Check aria-hidden="true" />
        <DialogTitle>You’re on our list.</DialogTitle>
        <DialogDescription>
          Your application was saved. We’ll review it and contact you at your
          work email about the next steps as Zentra comes to the US. Early
          access is subject to pilot selection.
        </DialogDescription>
        <p>
          {usMarket.pilot.promise} {usMarket.pilot.timing}
        </p>
        <p>Applying does not start your free month or create a subscription.</p>
        <p>Thank you for helping shape Zentra for US businesses.</p>
      </div>
    );
  return (
    <>
      <DialogTitle className="us-form-title">
        Get in early. Your first month is on us.
      </DialogTitle>
      <DialogDescription>
        Zentra is coming to the US. Apply for the pilot and tell us about your
        business. {usMarket.pilot.promise}
      </DialogDescription>
      <p className="us-form-offer">{usMarket.pilot.timing}</p>
      <form
        className="us-form"
        noValidate
        onSubmit={submit}
        onChange={() => {
          if (!started.current) {
            started.current = true;
            trackPilotEvent('pilot_form_started');
          }
        }}
      >
        <fieldset disabled={busy} className="us-form-fields">
          <legend className="sr-only">Your pilot application</legend>
          <div className="us-form-grid">
            {field('first_name', 'First name', {
              autoComplete: 'given-name',
              maxLength: 80,
            })}
            {field('last_name', 'Last name', {
              autoComplete: 'family-name',
              maxLength: 80,
            })}
            {field('email', 'Work email', {
              type: 'email',
              autoComplete: 'email',
              maxLength: 254,
            })}
            {field('company', 'Company', { autoComplete: 'organization' })}
            {field('website', 'Company website', {
              required: false,
              maxLength: 500,
            })}
            {field('industry', 'Industry', { maxLength: 120 })}
          </div>
          <label className="us-field" htmlFor="us-employee_count">
            <span id="us-label-employee_count">Number of employees</span>
            <select
              id="us-employee_count"
              name="employee_count"
              defaultValue=""
              required
              aria-labelledby="us-label-employee_count"
              aria-invalid={!!errors.employee_count}
              aria-describedby={
                errors.employee_count ? 'us-error-employee_count' : undefined
              }
            >
              <option value="" disabled>
                Select your team size
              </option>
              {employeeCounts.map((size) => (
                <option key={size}>{size}</option>
              ))}
            </select>
            <FieldError name="employee_count" errors={errors} />
          </label>
          <label className="us-field" htmlFor="us-pain_point">
            <span id="us-label-pain_point">
              What’s the most repetitive administrative task in your business?
            </span>
            <Textarea
              id="us-pain_point"
              name="pain_point"
              className="us-input"
              rows={3}
              maxLength={2000}
              required
              aria-labelledby="us-label-pain_point"
              aria-invalid={!!errors.pain_point}
              aria-describedby={
                errors.pain_point ? 'us-error-pain_point' : undefined
              }
            />
            <FieldError name="pain_point" errors={errors} />
          </label>
          <label className="us-field" htmlFor="us-current_tools">
            <span id="us-label-current_tools">
              What tools do you currently use to run your business?
            </span>
            <Textarea
              id="us-current_tools"
              name="current_tools"
              className="us-input"
              rows={2}
              maxLength={2000}
              required
              aria-labelledby="us-label-current_tools"
              aria-invalid={!!errors.current_tools}
              aria-describedby={
                errors.current_tools ? 'us-error-current_tools' : undefined
              }
            />
            <FieldError name="current_tools" errors={errors} />
          </label>
          <fieldset
            className="us-radio-field"
            aria-describedby={
              errors.demo_interest ? 'us-error-demo_interest' : undefined
            }
          >
            <legend>Would you be open to a 15-minute product demo?</legend>
            <label>
              <input type="radio" name="demo_interest" value="yes" required />
              Yes
            </label>
            <label>
              <input type="radio" name="demo_interest" value="no" />
              No
            </label>
            <FieldError name="demo_interest" errors={errors} />
          </fieldset>
          <div className="us-honeypot" aria-hidden="true">
            <label htmlFor="us-contact_note">
              Leave empty
              <Input
                id="us-contact_note"
                name="contact_note"
                tabIndex={-1}
                autoComplete="off"
              />
            </label>
          </div>
        </fieldset>
        {error && (
          <p className="us-form-error" role="alert">
            {error}
          </p>
        )}
        <Button
          type="submit"
          className="us-button us-button-primary"
          disabled={busy}
        >
          {busy ? 'Saving your application…' : 'Apply for Early Access'}
          {!busy && <ArrowRight aria-hidden="true" />}
        </Button>
        <p className="us-form-privacy">{usMarket.pilot.terms}</p>
        <p className="us-form-privacy">
          We use your answers to assess pilot fit and contact you about Zentra.
          No payment is required. <a href="/us/privacy">Privacy notice</a>
        </p>
      </form>
    </>
  );
}
function FieldError({
  name,
  errors,
}: {
  name: string;
  errors: Record<string, string>;
}) {
  return errors[name] ? (
    <span id={`us-error-${name}`} className="us-field-error">
      {errors[name]}
    </span>
  ) : null;
}
