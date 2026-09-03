import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((value: unknown) => void) | null = null;
  },
  invoke: invokeMock,
}));

import { desktopApi } from './bridge';

describe('exports de portabilité', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('conserve la commande JSON existante', async () => {
    invokeMock.mockResolvedValue('C:\\exports\\Zentra-export.json');

    await expect(desktopApi.exportData('json')).resolves.toEqual({
      path: 'C:\\exports\\Zentra-export.json',
    });
    expect(invokeMock).toHaveBeenCalledWith('export_json', {});
  });

  it('appelle la vraie commande d’archive CSV', async () => {
    invokeMock.mockResolvedValue('C:\\exports\\Zentra-listes.zip');

    await expect(desktopApi.exportData('csv')).resolves.toEqual({
      path: 'C:\\exports\\Zentra-listes.zip',
    });
    expect(invokeMock).toHaveBeenCalledWith('export_csv_archive', {});
  });
});
