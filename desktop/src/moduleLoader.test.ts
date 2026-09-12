import { describe, expect, it, vi } from 'vitest';
import { createModuleLoader } from './moduleLoader';

describe('chargement des écrans locaux', () => {
  it('ne charge rien avant la première demande, puis partage le même chargement', async () => {
    const module = { name: 'test' };
    const importer = vi.fn(async () => module);
    const loader = createModuleLoader(importer);
    expect(importer).not.toHaveBeenCalled();
    expect(loader.peek()).toBeUndefined();
    const first = loader.load(), second = loader.load();
    expect(second).toBe(first);
    expect(await first).toBe(module);
    expect(loader.peek()).toBe(module);
    expect(await loader.load()).toBe(module);
    expect(importer).toHaveBeenCalledTimes(1);
  });
  it('autorise une nouvelle tentative après un refus sans dupliquer les demandes simultanées', async () => {
    const module = { name: 'recovered' };
    const importer = vi.fn().mockRejectedValueOnce(new Error('load interrupted')).mockResolvedValue(module);
    const loader = createModuleLoader(importer);
    await expect(loader.load()).rejects.toThrow('load interrupted');
    expect(loader.peek()).toBeUndefined();
    const first = loader.load(), second = loader.load();
    expect(second).toBe(first);
    expect(await second).toBe(module);
    expect(await loader.load()).toBe(module);
    expect(importer).toHaveBeenCalledTimes(2);
  });
  it('convertit aussi un refus synchrone en erreur récupérable', async () => {
    const importer = vi.fn().mockImplementationOnce(() => { throw new Error('sync'); }).mockResolvedValue({ name: 'ok' });
    const loader = createModuleLoader(importer);
    await expect(loader.load()).rejects.toThrow('sync');
    await expect(loader.load()).resolves.toEqual({ name: 'ok' });
  });
});
