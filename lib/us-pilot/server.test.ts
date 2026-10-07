import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '@/lib/supabase-server';
const validLead = {
  first_name: 'Alex',
  last_name: 'Taylor',
  email: 'alex@company.test',
  company: 'Example Services',
  website: 'example.com',
  industry: 'Consulting',
  employee_count: '11–30',
  pain_point: 'Copying requests into spreadsheets',
  current_tools: 'Email and spreadsheets',
  demo_interest: true,
  submission_id: '10000000-0000-4000-8000-000000000001',
};
const storage = vi.hoisted(() => ({ insert: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase-server-runtime', () => ({
  supabaseServerClient: () => storage,
}));
import { submitPilotEvent, submitPilotLead } from './server';
const base = {
  ...validLead,
  contact_note: '',
  started_at: Date.now() - 10_000,
  visitor_id: '20000000-0000-4000-8000-000000000001',
  utm_source: 'test',
};
const request = (body: unknown, headers = {}) =>
  new Request('https://zentraapp.ch/api/us-pilot/leads', {
    method: 'POST',
    headers: {
      Origin: 'https://zentraapp.ch',
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.2',
      ...headers,
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  storage.insert.mockResolvedValue([]);
  storage.rpc.mockResolvedValue(true);
});
describe('US pilot public server boundary', () => {
  it('persists a lead and records one authoritative conversion with no form PII', async () => {
    const response = await submitPilotLead(request(base));
    expect(response.status).toBe(201);
    expect(storage.insert.mock.calls[0]).toEqual([
      'us_pilot_leads',
      expect.objectContaining({
        source: 'us_landing',
        utm_source: 'test',
        offer_version: 'us-pilot-free-month-v1',
      }),
      { returning: false },
    ]);
    expect(storage.insert.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        id: base.submission_id,
        event_name: 'pilot_form_submitted',
        properties: {},
      }),
    );
    expect(storage.insert.mock.calls[1][1]).not.toHaveProperty('email');
    expect(storage.rpc.mock.calls[0][1].p_key).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects cross-origin and originless submissions without storage calls', async () => {
    expect(
      (
        await submitPilotLead(
          request(base, { Origin: 'https://attacker.test' }),
        )
      ).status,
    ).toBe(403);
    const req = request(base);
    req.headers.delete('Origin');
    expect((await submitPilotLead(req)).status).toBe(403);
    expect(storage.insert).not.toHaveBeenCalled();
  });
  it.each([
    { ...base, contact_note: 'spam' },
    { ...base, started_at: Date.now() },
    { ...base, started_at: Date.now() - 90_000_000 },
  ])('rejects honeypot and timing violations', async (body) => {
    expect((await submitPilotLead(request(body))).status).toBe(400);
    expect(storage.rpc).not.toHaveBeenCalled();
  });
  it('validates on the server and returns actionable field errors', async () => {
    const result = await submitPilotLead(
      request({ ...base, email: 'invalid' }),
    );
    expect(result.status).toBe(422);
    expect(await result.json()).toMatchObject({
      fields: { email: 'Enter a valid work email.' },
    });
    expect(storage.insert).not.toHaveBeenCalled();
  });
  it('returns 429 without saving over-limit applications', async () => {
    storage.rpc.mockResolvedValue(false);
    const result = await submitPilotLead(request(base));
    expect(result.status).toBe(429);
    expect(result.headers.get('Retry-After')).toBe('3600');
    expect(storage.insert).not.toHaveBeenCalled();
  });
  it('never confirms a failed save or leaks upstream errors', async () => {
    storage.insert.mockRejectedValue(
      new Error('private secret and database info'),
    );
    const result = await submitPilotLead(request(base));
    expect(result.status).toBe(503);
    expect(JSON.stringify(await result.json())).not.toContain('private secret');
  });
  it('retries the same opaque submission safely', async () => {
    storage.insert
      .mockRejectedValueOnce(new SupabaseServerError(409, '23505'))
      .mockResolvedValue([]);
    expect((await submitPilotLead(request(base))).status).toBe(201);
  });
  it('does not lose a lead when analytics fails', async () => {
    storage.insert.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error());
    expect((await submitPilotLead(request(base))).status).toBe(201);
  });
  it('respects measurement opt-out', async () => {
    expect(
      (await submitPilotLead(request({ ...base, measurement_allowed: false })))
        .status,
    ).toBe(201);
    expect(storage.insert).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized and non-JSON bodies', async () => {
    expect(
      (await submitPilotLead(request({ text: 'a'.repeat(12_001) }))).status,
    ).toBe(413);
    expect(
      (await submitPilotLead(request(base, { 'Content-Type': 'text/plain' })))
        .status,
    ).toBe(415);
  });
  it('allowlists analytics properties and deduplicates event IDs', async () => {
    const event = {
      id: base.submission_id,
      visitor_id: base.visitor_id,
      event_name: 'watch_demo',
      properties: {
        workflow: 'invoice',
        mode: 'manual',
        email: 'private@example.com',
        url: 'https://private.test',
      },
    };
    expect((await submitPilotEvent(request(event))).status).toBe(201);
    expect(storage.insert.mock.calls[0][1].properties).toEqual({
      workflow: 'invoice',
      mode: 'manual',
    });
    expect(storage.insert.mock.calls[0][2].query).toEqual({
      on_conflict: 'id',
    });
  });
  it('rejects arbitrary events and client-forged conversions', async () => {
    for (const event_name of ['unknown', 'pilot_form_submitted'])
      expect(
        (
          await submitPilotEvent(
            request({
              id: base.submission_id,
              visitor_id: base.visitor_id,
              event_name,
            }),
          )
        ).status,
      ).toBe(422);
    expect(storage.insert).not.toHaveBeenCalled();
  });
});
