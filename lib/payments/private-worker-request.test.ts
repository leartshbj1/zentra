import { describe, expect, it } from 'vitest';
import { isPrivateWorkerRequest } from './private-worker-request';

const url = 'https://zentra.example.test/api/payments/postfinance/reconcile';
const request = (
  body?: string,
  contentType = 'application/json',
  target = url,
  method = 'POST',
) =>
  new Request(target, {
    method,
    headers: { 'Content-Type': contentType },
    ...(body === undefined ? {} : { body }),
  });
describe('private scheduler envelope', () => {
  it.each([undefined, '{}', ' \n{ }\t'])(
    'accepts a bodyless or empty JSON pg_net invocation %s',
    async (body) => {
      expect(await isPrivateWorkerRequest(request(body))).toBe(true);
    },
  );
  it.each([
    '{"company":"foreign"}',
    '{"amount":1}',
    '{"enabled":true}',
    '{"maximumJobs":4}',
    'null',
    '[]',
    'true',
    '',
    '{',
    ' '.repeat(65) + '{}',
    '{"__proto__":{}}',
  ])('rejects input %s', async (body) => {
    expect(await isPrivateWorkerRequest(request(body))).toBe(false);
  });
  it('rejects method, query, wrong type and dishonest declared size', async () => {
    expect(
      await isPrivateWorkerRequest(
        request(undefined, 'application/json', url, 'GET'),
      ),
    ).toBe(false);
    expect(
      await isPrivateWorkerRequest(
        request('{}', 'application/json', url + '?enabled=true'),
      ),
    ).toBe(false);
    expect(await isPrivateWorkerRequest(request('{}', 'text/plain'))).toBe(
      false,
    );
    expect(
      await isPrivateWorkerRequest(
        new Request(url, {
          method: 'POST',
          headers: { 'Content-Length': '100' },
        }),
      ),
    ).toBe(false);
    expect(
      await isPrivateWorkerRequest(
        new Request(url, {
          method: 'POST',
          body: '{}',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '100',
          },
        }),
      ),
    ).toBe(false);
  });
});
