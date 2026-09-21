import { it, expect } from 'vitest';
import {
  calendarAppointment,
  extractAppointment,
  validDate,
} from './extraction';
import type { DecisionProvider, DecisionInput } from '@/lib/automation/types';
const ics = (
  start = 'DTSTART;TZID=Europe/Zurich:20260922T090000',
  end = 'DTEND;TZID=Europe/Zurich:20260922T100000',
  extra = '',
) =>
  `BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:test-unique\r\nSUMMARY:Réunion client\r\n${start}\r\n${end}\r\nLOCATION:Genève\\, salle 2\r\n${extra}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
it('preserves calendar facts, escaped locations and stable UID', () => {
  const a = calendarAppointment(ics(), 'Confirmation')!;
  expect(a).toMatchObject({
    uid: 'test-unique',
    startDate: '2026-09-22',
    startTime: '09:00',
    endTime: '10:00',
    location: 'Genève, salle 2',
    issues: [],
  });
});
it('converts UTC and handles exclusive all-day end dates', () => {
  expect(
    calendarAppointment(
      ics('DTSTART:20260922T070000Z', 'DTEND:20260922T080000Z'),
      '',
    )?.startTime,
  ).toBe('09:00');
  expect(
    calendarAppointment(
      ics('DTSTART;VALUE=DATE:20260922', 'DTEND;VALUE=DATE:20260923'),
      '',
    ),
  ).toMatchObject({
    allDay: true,
    startDate: '2026-09-22',
    endDate: '2026-09-22',
    issues: [],
  });
});
it.each([
  'DTSTART;TZID=Europe/Zurich:20260329T023000',
  'DTSTART;TZID=Europe/Zurich:20261025T023000',
  'DTSTART;TZID=Mystery/Zone:20260922T090000',
  'DTSTART:20260230T090000Z',
])('requires review for impossible, ambiguous or unknown time %s', (start) => {
  expect(calendarAppointment(ics(start), '')?.issues.length).toBeGreaterThan(0);
});
it('does not silently import recurring meetings or cancellations', () => {
  expect(
    calendarAppointment(ics(undefined, undefined, 'RRULE:FREQ=WEEKLY'), '')
      ?.issues.length,
  ).toBeGreaterThan(0);
  expect(
    calendarAppointment(ics(undefined, undefined, 'STATUS:CANCELLED'), ''),
  ).toMatchObject({ status: 'cancelled' });
  expect(
    calendarAppointment(ics(undefined, undefined, 'STATUS:CANCELLED'), '')
      ?.issues.length,
  ).toBeGreaterThan(0);
  expect(calendarAppointment(ics() + ics(), '')).toBeNull();
});
function provider(choices: Record<string, string>): DecisionProvider {
  return {
    async decide(input: DecisionInput) {
      return {
        answers: Object.fromEntries(
          Object.entries(input.questions).map(([key, q]) => {
            expect(Object.keys(q.options).length).toBeGreaterThan(1);
            return [
              key,
              {
                choice: choices[key] || 'absent',
                confidence: 0.99,
                probabilities: {},
              },
            ];
          }),
        ),
        provider: 'typesafe',
        model: 'test',
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      };
    },
  };
}
it('extracts only offered literal facts and does not invent an end time', async () => {
  const p = provider({
    confirmation: 'confirmed',
    date: 'v0',
    start: 'v0',
    end: 'v1',
    location: 'v0',
  });
  expect(
    await extractAppointment(
      p,
      'Rendez-vous confirmé',
      'Le 22.09.2026 de 09h00 à 10h00\nLieu : Genève',
    ),
  ).toMatchObject({
    startDate: '2026-09-22',
    startTime: '09:00',
    endTime: '10:00',
    location: 'Genève',
    issues: [],
  });
  const a = await extractAppointment(
    provider({ confirmation: 'confirmed', date: 'v0', start: 'v0' }),
    'Confirmé',
    '22.09.2026 à 09h00',
  );
  expect(a.endTime).toBe('');
  expect(a.issues.length).toBeGreaterThan(0);
});
it('does not let a structured invitation bypass confirmation', async () => {
  const a = await extractAppointment(
    provider({ confirmation: 'review' }),
    'Invitation',
    'Êtes-vous disponible ?',
    ics(),
  );
  expect(a.issues.length).toBeGreaterThan(0);
});
it('rejects overflow dates', () => {
  expect(validDate('2026-02-30')).toBe(false);
  expect(validDate('2028-02-29')).toBe(true);
});
it.each([
  '22 septembre 2026',
  '22. September 2026',
  '22 settembre 2026',
  'September 22, 2026',
])('understands written dates without inventing a year: %s', async (date) => {
  const a = await extractAppointment(
    provider({ confirmation: 'confirmed', date: 'v0', start: 'v0', end: 'v1' }),
    'Confirmation',
    `${date}, de 9h à 10h`,
  );
  expect(a).toMatchObject({
    startDate: '2026-09-22',
    startTime: '09:00',
    endTime: '10:00',
    issues: [],
  });
});
it('requires review when the ending hour falls in a DST fold', async () => {
  const a = await extractAppointment(
    provider({ confirmation: 'confirmed', date: 'v0', start: 'v0', end: 'v1' }),
    'Confirmé',
    '25 octobre 2026, 01:30 à 02:30',
  );
  expect(a.issues).toContain(
    'Cette heure est ambiguë ou inexistante lors du changement d’heure.',
  );
});

it('keeps an uncertain location for review even when times are certain', async () => {
  const p = provider({
    confirmation: 'confirmed',
    date: 'v0',
    start: 'v0',
    end: 'v1',
    location: 'v0',
  });
  const original = p.decide.bind(p);
  p.decide = async (input) => {
    const result = await original(input);
    result.answers.location.confidence = 0.6;
    return result;
  };
  expect(
    (
      await extractAppointment(
        p,
        'Confirmation',
        '22 septembre 2026 de 9h à 10h\nLieu : Genève',
      )
    ).issues,
  ).toContain('Vérifiez le lieu du rendez-vous.');
});
