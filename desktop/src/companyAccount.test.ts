import { expect, it, vi } from 'vitest';
import { singleFlightCompanyResolver } from './companyAccount';

it('coalesces mount retries but checks a company again after a completed operation', async () => {
  const backend = vi.fn(async () => ({ status: 'ready' }));
  const resolve = singleFlightCompanyResolver(backend);
  const first = resolve('windows-company', 'auto');
  expect(resolve('windows-company', 'auto')).toBe(first);
  await first;
  expect(backend).toHaveBeenCalledTimes(1);
  await resolve('windows-company', 'auto');
  expect(backend).toHaveBeenCalledTimes(2);
});
it('does not reuse another account or an earlier company choice', async () => {
  const backend = vi.fn(async (org: string) => org);
  const resolve = singleFlightCompanyResolver(backend);
  const a = resolve('a', 'auto'), b = resolve('b', 'auto'), open = resolve('a', 'open');
  expect(a).not.toBe(b); expect(a).not.toBe(open);
  expect(await Promise.all([a, b, open])).toEqual(['a', 'b', 'a']);
});
it('retries after a failed first upload instead of caching the network failure', async () => {
  const backend = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ status: 'ready' });
  const resolve = singleFlightCompanyResolver(backend);
  await expect(resolve('a', 'publish')).rejects.toThrow('offline');
  await expect(resolve('a', 'publish')).resolves.toEqual({ status: 'ready' });
});
