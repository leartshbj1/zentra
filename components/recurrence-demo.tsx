'use client';

import {
  CalendarClock,
  CheckCircle2,
  FileText,
  ShieldCheck,
} from 'lucide-react';
import { useMemo, useState } from 'react';

type Frequency = 'monthly' | 'quarterly' | 'yearly';

const frequencyOptions: Array<{
  value: Frequency;
  label: string;
  detail: string;
}> = [
  { value: 'monthly', label: 'Mensuelle', detail: 'Chaque mois' },
  { value: 'quarterly', label: 'Trimestrielle', detail: 'Tous les 3 mois' },
  { value: 'yearly', label: 'Annuelle', detail: 'Chaque année' },
];

function validDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

function iso(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number) {
  const date = validDate(value);
  if (!date) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

function nextDate(
  value: string,
  frequency: Frequency,
  monthEnd: boolean,
  anchorDay: number,
) {
  const date = validDate(value);
  if (!date) return value;
  const months =
    frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12;
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(monthEnd ? lastDay : Math.min(anchorDay, lastDay));
  return iso(target);
}

function formatDate(value: string) {
  const date = validDate(value);
  if (!date) return 'Date invalide';
  return new Intl.DateTimeFormat('fr-CH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function isMonthEnd(date: Date) {
  return (
    date.getUTCDate() ===
    new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    ).getUTCDate()
  );
}

export function RecurrenceDemo() {
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [startDate, setStartDate] = useState('2026-09-30');
  const [paymentTermsDays, setPaymentTermsDays] = useState(30);
  const occurrences = useMemo(() => {
    const first = validDate(startDate);
    if (!first) return [];
    const monthEnd = isMonthEnd(first);
    const dates = [startDate];
    while (dates.length < 3) {
      dates.push(
        nextDate(dates.at(-1)!, frequency, monthEnd, first.getUTCDate()),
      );
    }
    return dates.map((scheduledFor, index) => ({
      id: `${scheduledFor}-${index}`,
      scheduledFor,
      dueDate: addDays(scheduledFor, paymentTermsDays),
    }));
  }, [frequency, paymentTermsDays, startDate]);

  return (
    <div className="mt-8 overflow-hidden rounded-[28px] border border-[#cfd9d1] bg-white shadow-[0_24px_65px_rgba(41,67,50,.09)]">
      <div className="grid lg:grid-cols-[.82fr_1.18fr]">
        <div className="border-b border-[#dfe5df] bg-[#173d2c] p-6 text-white sm:p-8 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-2xl bg-white/10 text-[#efb157]">
              <CalendarClock className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[.13em] text-white/55">
                Exemple interactif
              </p>
              <h3 className="mt-1 text-xl font-semibold">
                Planifier une facturation
              </h3>
            </div>
          </div>

          <fieldset className="mt-7">
            <legend className="text-xs font-semibold text-white/70">
              Rythme
            </legend>
            <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
              {frequencyOptions.map((option) => (
                <label key={option.value} className="cursor-pointer">
                  <input
                    type="radio"
                    name="site-recurrence-frequency"
                    aria-label={`${option.label} — ${option.detail}`}
                    className="peer sr-only"
                    checked={frequency === option.value}
                    onChange={() => setFrequency(option.value)}
                  />
                  <span className="grid min-h-16 rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 transition peer-checked:border-[#efb157] peer-checked:bg-[#efb157]/12 peer-focus-visible:ring-2 peer-focus-visible:ring-[#efb157]">
                    <strong className="text-xs">{option.label}</strong>
                    <small className="mt-1 text-[10px] text-white/55">
                      {option.detail}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <label className="grid gap-2 text-xs font-semibold text-white/70">
              Premier brouillon prévu
              <input
                type="date"
                required
                value={startDate}
                min="2026-01-01"
                onChange={(event) => setStartDate(event.target.value)}
                className="min-h-11 w-full min-w-0 rounded-xl border border-white/15 bg-white/10 px-3 text-sm font-medium text-white outline-none [color-scheme:dark] focus:border-[#efb157] focus:ring-2 focus:ring-[#efb157]/25"
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-white/70">
              Délai de paiement
              <span className="flex min-h-11 items-center rounded-xl border border-white/15 bg-white/10 px-3 focus-within:border-[#efb157] focus-within:ring-2 focus-within:ring-[#efb157]/25">
                <input
                  type="number"
                  min="0"
                  max="365"
                  value={paymentTermsDays}
                  onChange={(event) =>
                    setPaymentTermsDays(
                      Math.min(
                        365,
                        Math.max(0, Number(event.target.value) || 0),
                      ),
                    )
                  }
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium text-white outline-none"
                />
                <span className="text-[11px] text-white/55">jours</span>
              </span>
            </label>
          </div>

          <p className="mt-6 flex gap-2 text-xs leading-5 text-white/60">
            <ShieldCheck
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            Démonstration du site : aucune donnée n’est enregistrée et aucune
            facture réelle n’est créée.
          </p>
        </div>

        <div className="p-6 sm:p-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[.13em] text-[#7a866f]">
                Trois prochaines occurrences
              </p>
              <h3 className="mt-2 text-2xl font-semibold tracking-[-.035em] text-[#243c2f]">
                Des brouillons, jamais des envois surprises.
              </h3>
            </div>
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-[#edf6ef] px-3 py-1.5 text-[11px] font-semibold text-[#37684b]">
              <CheckCircle2 className="size-3.5" aria-hidden="true" /> Contrôle
              humain
            </span>
          </div>

          {occurrences.length ? (
            <ol className="mt-6 grid gap-3" aria-live="polite">
              {occurrences.map((occurrence, index) => (
                <li
                  key={occurrence.id}
                  className="grid gap-3 rounded-2xl border border-[#dfe5df] bg-[#fafbf9] p-4 sm:grid-cols-[auto_1fr_auto] sm:items-center"
                >
                  <span className="grid size-10 place-items-center rounded-xl bg-[#edf4ee] text-[#427057]">
                    <FileText className="size-4" aria-hidden="true" />
                  </span>
                  <div>
                    <strong className="text-sm text-[#2d4939]">
                      Brouillon {index + 1} ·{' '}
                      {formatDate(occurrence.scheduledFor)}
                    </strong>
                    <p className="mt-1 text-xs text-[#748078]">
                      Échéance de paiement&nbsp;:{' '}
                      {formatDate(occurrence.dueDate)}
                    </p>
                  </div>
                  <span className="w-fit rounded-full bg-[#fff0d9] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[.05em] text-[#8b5c21]">
                    À contrôler
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <output className="mt-6 block rounded-2xl border border-[#e3d8c6] bg-[#fff8ed] p-4 text-sm text-[#765b33]">
              Choisissez une date valide pour afficher le planning.
            </output>
          )}

          <p className="mt-5 text-sm leading-6 text-[#647168]">
            Dans Elyko, le contenu et le délai sont figés avec le modèle. Le QR,
            l’émission, l’envoi et l’écriture comptable restent des actions
            séparées et vérifiables.
          </p>
        </div>
      </div>
    </div>
  );
}
