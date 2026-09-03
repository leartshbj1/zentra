import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((value: unknown) => void) | null = null;
  },
  invoke: invokeMock,
}));

import { desktopApi } from './bridge';

const input = {
  id: '39c85c22-7fc0-42d0-95f9-c1ad536fe2cf',
  isNew: true,
  expectedUpdatedAt: null,
  title: 'Visite client',
  startDate: '2026-09-08',
  endDate: '2026-09-08',
  allDay: false,
  startTime: '09:00',
  endTime: '10:00',
  kind: 'visit' as const,
  status: 'scheduled' as const,
  location: 'Lausanne',
  notes: '',
  projectId: null,
  employeeId: null,
};

describe('contrat IPC de l’agenda', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('rejoue une création avec le même id après un échec de rafraîchissement', async () => {
    let refreshAttempts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'save_agenda_event') return {};
      if (command === 'get_app_state') {
        refreshAttempts += 1;
        if (refreshAttempts === 1) throw new Error('refresh failed after commit');
        return { onboarding_completed: 0 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(desktopApi.saveAgendaEvent(input)).rejects.toThrow(
      'refresh failed after commit',
    );
    await expect(desktopApi.saveAgendaEvent(input)).resolves.toBeDefined();

    const calls = invokeMock.mock.calls.filter(
      ([command]) => command === 'save_agenda_event',
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[1]).toMatchObject({
        input: {
          id: input.id,
          create_only: true,
          expected_updated_at: null,
        },
      });
    }
  });

  it('transmet la version attendue pour modifier et supprimer sans écrasement', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'save_agenda_event' || command === 'delete_agenda_event')
        return {};
      if (command === 'get_app_state') return { onboarding_completed: 0 };
      throw new Error(`unexpected command: ${command}`);
    });
    const expectedUpdatedAt = '2026-09-03T12:00:00.000Z';

    await desktopApi.saveAgendaEvent({
      ...input,
      isNew: false,
      expectedUpdatedAt,
    });
    await desktopApi.deleteAgendaEvent(input.id, expectedUpdatedAt);

    expect(invokeMock).toHaveBeenCalledWith('save_agenda_event', {
      input: expect.objectContaining({
        id: input.id,
        create_only: false,
        expected_updated_at: expectedUpdatedAt,
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith('delete_agenda_event', {
      id: input.id,
      expectedUpdatedAt,
    });
  });
});
