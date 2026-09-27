import { beforeEach, expect, it, vi } from 'vitest';
import { runtimeVolumeFixture } from '../tests/runtime-volume-fixture';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi } from './bridge';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

beforeEach(() => { invoke.mockReset(); });
for (const cloud of [false, true]) {
  const command = cloud ? 'restore_cloud_backup' : 'restore_backup';
  const restore = () => cloud ? desktopApi.restoreCloudBackup('backup-id') : desktopApi.restoreBackup('C:\\copies\\entreprise.zentra');
  it(`${command}: distinguishes a completed restore from a failed read and never repeats it`, async () => {
    let failed = true;
    invoke.mockImplementation(async name => {
      if (name === command) return {};
      if (failed) throw new Error('Lecture interrompue');
      return name === 'get_app_state' ? { onboarding_completed: true } : runtimeVolumeFixture(1);
    });
    await expect(restore()).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    failed = false;
    const workspace = await desktopApi.loadWorkspace();
    expect(workspace.invoices).toHaveLength(1);
    expect(invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(1);
  });
  it(`${command}: preserves a genuine native failure without reading a different company`, async () => {
    invoke.mockRejectedValue(new Error('Sauvegarde incomplète'));
    await expect(restore()).rejects.toThrow('Sauvegarde incomplète');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe(command);
  });
}
