import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkNoteDraft } from './types';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class { onmessage: ((value: unknown) => void) | null = null; },
  invoke: invokeMock,
}));

import { desktopApi, workNoteFromRaw } from './bridge';

const id = '39c85c22-7fc0-42d0-95f9-c1ad536fe2cf';
const projectId = '6bc78174-7e62-4aab-8fe8-30e3fe80f9f8';
const scope = '60a6f018-76e6-4e86-9a7e-eb78f5b0c3c2';
const createdAt = '2026-09-30T08:00:00.000Z';
const updatedAt = '2026-09-30T08:01:00.000Z';
const body = 'Mesures\n  ☐ Vérifier la fenêtre\n\t☑ Relever la hauteur\n';
const rawNote = { id, title: 'Relevé du projet', body, project_id: projectId, pinned: 1,
  author_name: 'Élodie', created_by_member_id: 'member-1', created_at: createdAt, updated_at: updatedAt };
const mappedNote = { id, title: 'Relevé du projet', body, projectId, pinned: true,
  authorName: 'Élodie', createdByMemberId: 'member-1', createdAt, updatedAt };
const input: WorkNoteDraft = { id, title: 'Relevé du projet', body, projectId, pinned: true,
  expectedUpdatedAt: createdAt, expectedWorkspaceScope: scope };

describe('native work note bridge', () => {
  beforeEach(() => { invokeMock.mockReset(); });

  it('sends note data, optimistic revision and workspace identity and returns the full camelCase saved record', async () => {
    invokeMock.mockResolvedValue(rawNote);
    expect(await desktopApi.saveWorkNote(input)).toEqual(mappedNote);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('save_work_note', { input: {
      id, title: input.title, body, project_id: projectId, pinned: true,
      expected_updated_at: createdAt, expected_workspace_scope: scope,
    } });
  });

  it('keeps a null creation baseline and no project association in the native payload', async () => {
    invokeMock.mockResolvedValue({ ...rawNote, project_id: null, pinned: 0 });
    const saved = await desktopApi.saveWorkNote({ ...input, projectId: null, pinned: false, expectedUpdatedAt: null });
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('save_work_note', { input: {
      id, title: input.title, body, project_id: null, pinned: false,
      expected_updated_at: null, expected_workspace_scope: scope,
    } });
    expect(saved).toEqual({ ...mappedNote, projectId: null, pinned: false });
  });

  it('sends both optimistic revision and workspace identity for deletion', async () => {
    const response = { deleted: true, id };
    invokeMock.mockResolvedValue(response);
    expect(await desktopApi.deleteWorkNote(id, updatedAt, scope)).toEqual(response);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('delete_work_note', { id, expectedUpdatedAt: updatedAt, expectedWorkspaceScope: scope });
  });

  it.each(['save', 'delete'] as const)('keeps a native %s refusal distinct and does not repeat the write or refresh', async operation => {
    const failure = new Error('L’espace de travail a changé. Votre note est conservée.');
    invokeMock.mockRejectedValue(failure);
    const action = operation === 'save' ? desktopApi.saveWorkNote(input) : desktopApi.deleteWorkNote(id, updatedAt, scope);
    await expect(action).rejects.toBe(failure);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe(operation === 'save' ? 'save_work_note' : 'delete_work_note');
  });

  it.each([{ pinned: 0, expected: false }, { pinned: 1, expected: true }])('maps SQLite pinned=$pinned and all author/revision fields', ({ pinned, expected }) => {
    expect(workNoteFromRaw({ ...rawNote, pinned })).toEqual({ ...mappedNote, pinned: expected });
  });

  it('preserves null project and creator fields from a locally created note', () => {
    expect(workNoteFromRaw({ ...rawNote, project_id: null, created_by_member_id: null,
      author_name: 'Créé sur cet appareil' })).toEqual({ ...mappedNote, projectId: null,
      createdByMemberId: null, authorName: 'Créé sur cet appareil' });
  });

  it('loads shared notes and the private draft scope without mutating native records', async () => {
    const raw = { settings: { company_name: 'Projet', extra_settings_json: '{}' }, work_notes: [rawNote], work_notes_scope: scope };
    const before = structuredClone(raw);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_app_state') return { onboarding_completed: true };
      if (command === 'get_workspace') return raw;
      throw new Error(`Unexpected command: ${command}`);
    });
    const workspace = await desktopApi.loadWorkspace();
    expect(workspace.workNotes).toEqual([mappedNote]);
    expect(workspace.workNotesScope).toBe(scope);
    expect(raw).toEqual(before);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('does not keep notes or their draft scope after loading a different workspace', async () => {
    let raw: { settings: { company_name: string; extra_settings_json: string }; work_notes?: typeof rawNote[]; work_notes_scope?: string } = {
      settings: { company_name: 'Premier espace', extra_settings_json: '{}' }, work_notes: [rawNote], work_notes_scope: scope,
    };
    invokeMock.mockImplementation(async (command: string) => command === 'get_app_state' ? { onboarding_completed: true } : raw);
    const first = await desktopApi.loadWorkspace();
    raw = { settings: { company_name: 'Deuxième espace', extra_settings_json: '{}' } };
    const second = await desktopApi.loadWorkspace();
    expect(first.workNotes).toEqual([mappedNote]);
    expect(first.workNotesScope).toBe(scope);
    expect(second.workNotes).toEqual([]);
    expect(second.workNotesScope).toBe('');
  });
});
