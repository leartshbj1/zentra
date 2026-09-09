import { describe, expect, it } from 'vitest';
import { projectSyncPresentation } from './projectSyncPresentation';
import type { ProjectSyncStatus } from './projectSync';
const status: ProjectSyncStatus = { pending: 0, syncing: false, documents: [], connected: true };
describe('project file sharing status', () => {
  it('offers the legacy action only for files using that feed', () => {
    expect(projectSyncPresentation(status, 1).canSynchronize).toBe(true);
    expect(projectSyncPresentation({ ...status, mode: 'business' }, 1).canSynchronize).toBe(false);
    expect(projectSyncPresentation({ ...status, mode: 'preparing' }, 1).canSynchronize).toBe(false);
  });
  it('distinguishes confirmed files from retained pending changes', () => {
    expect(projectSyncPresentation({ ...status, mode: 'business' }, 2).title).toBe('2 modifications en attente');
    expect(projectSyncPresentation({ ...status, mode: 'business' }, 0).description).toContain('confirmés');
    expect(projectSyncPresentation({ ...status, mode: 'preparing' }, 0).description).not.toContain('confirmés');
  });
  it('keeps network failures visible alongside cached files', () => {
    expect(projectSyncPresentation({ ...status, mode: 'business', error: 'Hors ligne' }, 0).description).toBe('Hors ligne');
  });
});
