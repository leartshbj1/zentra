import { describe, expect, it } from 'vitest';
import {
  readJsonObjectWithinLimit,
  readTextBodyWithinLimit,
  RequestBodyError,
} from './request-body';

describe('bounded Stripe request bodies', () => {
  it('reads a small JSON object with an explicit media type', async () => {
    const request = new Request('https://elyko.example/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ sessionId: 'cs_test' }),
    });
    await expect(readJsonObjectWithinLimit(request, 1_024)).resolves.toEqual({
      sessionId: 'cs_test',
    });
  });

  it('rejects a declared or actual body above the route limit', async () => {
    const declared = new Request('https://elyko.example/api', {
      method: 'POST',
      headers: { 'Content-Length': '2048' },
      body: 'small',
    });
    await expect(
      readTextBodyWithinLimit(declared, 1_024),
    ).rejects.toMatchObject({ status: 413 });

    const actual = new Request('https://elyko.example/api', {
      method: 'POST',
      body: 'é'.repeat(600),
    });
    await expect(readTextBodyWithinLimit(actual, 1_024)).rejects.toBeInstanceOf(
      RequestBodyError,
    );
  });

  it('rejects missing JSON media type, arrays and malformed JSON', async () => {
    const cases = [
      new Request('https://elyko.example/api', { method: 'POST', body: '{}' }),
      new Request('https://elyko.example/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '[]',
      }),
      new Request('https://elyko.example/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
    ];
    await expect(
      readJsonObjectWithinLimit(cases[0], 1_024),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readJsonObjectWithinLimit(cases[1], 1_024),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readJsonObjectWithinLimit(cases[2], 1_024),
    ).rejects.toMatchObject({ status: 400 });
  });
});
