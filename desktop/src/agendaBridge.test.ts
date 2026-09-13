import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((value: unknown) => void) | null = null;
  },
  invoke: invokeMock,
}));

import { desktopApi } from './bridge';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

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

  it.each(['save', 'delete'])('distingue %s acquitté de la lecture interrompue sans répéter l’écriture', async operation => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'save_agenda_event' || command === 'delete_agenda_event') return {};
      throw new Error('Lecture après enregistrement interrompue');
    });
    const action = operation === 'save' ? desktopApi.saveAgendaEvent(input) : desktopApi.deleteAgendaEvent(input.id,'version');
    await expect(action).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(invokeMock.mock.calls.filter(([command])=>command === 'save_agenda_event' || command === 'delete_agenda_event')).toHaveLength(1);
    if (operation === 'save') expect(invokeMock).toHaveBeenCalledWith('save_agenda_event', {input:expect.objectContaining({id:input.id,create_only:true,expected_updated_at:null})});
  });
  it('ne confirme pas une configuration vide après une écriture acquittée', async () => {
    invokeMock.mockImplementation(async command => command === 'save_agenda_event' ? {} : {onboarding_completed:0});
    await expect(desktopApi.saveAgendaEvent(input)).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
  });
  it('laisse un refus natif distinct d’une opération enregistrée', async () => {
    const reason=new Error('end_time doit être une heure HH:MM valide.'); invokeMock.mockRejectedValue(reason);
    await expect(desktopApi.saveAgendaEvent(input)).rejects.toBe(reason);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('transmet la version attendue pour modifier et supprimer sans écrasement', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'save_agenda_event' || command === 'delete_agenda_event')
        return {};
      if (command === 'get_app_state') return { onboarding_completed: true };
      if (command === 'get_workspace') return { settings: {company_name:'Agenda',extra_settings_json:'{}'},agenda_events:[] };
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
