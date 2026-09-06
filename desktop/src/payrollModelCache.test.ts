import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayslipModelCache } from './payrollModelCache';
afterEach(() => vi.unstubAllGlobals());
describe('cache local du modèle', () => {
  it('ne présente que les téléchargements complets et retire un flux interrompu', async () => {
    const entries = new Map<string, Response>();
    vi.stubGlobal('caches', { open: async () => ({
      match: async (key: string) => entries.get(key)?.clone(),
      delete: async (key: string) => entries.delete(key),
      keys: async () => [...entries.keys()].map(url => ({ url })),
      put: async (key: string, response: Response) => { entries.set(key, new Response(await response.arrayBuffer())); },
    }) });
    const cache = new PayslipModelCache();
    await cache.write('complete', new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1,2,3])); controller.close(); } }));
    expect(await cache.getSize('complete')).toBe(3);
    expect(new Uint8Array(await (await cache.read('complete'))!.arrayBuffer())).toEqual(new Uint8Array([1,2,3]));
    await expect(cache.write('interrupted', new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([4])); controller.error(new Error('cancelled')); } }))).rejects.toThrow('cancelled');
    expect(await cache.getSize('interrupted')).toBe(-1);
    expect(await cache.read('interrupted')).toBeNull();
    expect(await cache.list()).toEqual([{key:'complete',size:3}]);
    await cache.delete('complete');expect(await cache.list()).toEqual([]);
  });
});
