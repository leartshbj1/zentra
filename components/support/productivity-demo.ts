import type { SupportState } from './model';
import { solicitationDraft } from '@/lib/support/solicitation';
import type { Workspace, Decision } from '@/lib/support/types';
export function productivityDemo(
  data: SupportState,
  raw: Record<string, unknown>,
): { data: SupportState; result: Record<string, unknown> } | null {
  const action = raw.action,
    p = data.productivity!;
  if (action === 'saveSenderPolicy') {
    const id = String(raw.id || crypto.randomUUID()),
      policy = {
        id,
        sender: String(raw.sender),
        subject: String(raw.subject || ''),
        category: String(raw.category),
        enabled: raw.enabled === false ? 0 : 1,
        revision: Number(raw.revision || 0) + 1,
      };
    return {
      data: {
        ...data,
        productivity: {
          ...p,
          policies: [...p.policies.filter((v) => v.id !== id), policy],
        },
      },
      result: { saved: true },
    };
  }
  if (action === 'deleteSenderPolicy')
    return {
      data: {
        ...data,
        productivity: {
          ...p,
          policies: p.policies.filter((v) => v.id !== raw.id),
        },
      },
      result: { saved: true },
    };
  if (action === 'checkConnection')
    return {
      data: {
        ...data,
        productivity: {
          ...p,
          health: p.health.map((h) =>
            h.id === raw.connectionId
              ? { ...h, checkedAt: Date.now() / 1000, checkError: null }
              : h,
          ),
        },
      },
      result: { saved: true },
    };
  if (action === 'notSolicitation')
    return {
      data: {
        ...data,
        tickets: data.tickets.map((t) =>
          t.id === raw.ticketId
            ? {
                ...t,
                state: 'review',
                revision: t.revision + 1,
                decision: {
                  ...t.decision,
                  category: 'other',
                  priority: 'normal',
                  confidence: 0,
                  reason: 'Correction simulée.',
                } as Decision,
              }
            : t,
        ),
      },
      result: { saved: true },
    };
  if (action === 'createFollowup')
    return {
      data: {
        ...data,
        productivity: {
          ...p,
          followups: [
            ...p.followups,
            {
              id: crypto.randomUUID(),
              ticketId: String(raw.ticketId),
              title: String(raw.title),
              assignedTo: String(raw.assignedTo),
              dueAt: Number(raw.dueAt),
              state: 'open',
              revision: 1,
              organizationId: null,
              taskId: null,
            },
          ],
        },
      },
      result: { saved: true },
    };
  if (action === 'completeFollowup')
    return {
      data: {
        ...data,
        productivity: {
          ...p,
          followups: p.followups.map((f) =>
            f.id === raw.id
              ? { ...f, state: 'done', revision: f.revision + 1 }
              : f,
          ),
        },
      },
      result: { saved: true },
    };
  if (
    [
      'previewSolicitationBatch',
      'ignoreSolicitationBatch',
      'sendSolicitationBatch',
    ].includes(String(action))
  ) {
    const items = raw.items as Record<string, unknown>[];
    const results = items.map((item) => {
      const t = data.tickets.find((t) => t.id === item.ticketId)!;
      if (action === 'previewSolicitationBatch')
        return {
          ticketId: t.id,
          result: {
            draft: {
              ...solicitationDraft(
                {
                  name: data.workspace!.name,
                  solicitation_settings_json: JSON.stringify(
                    data.workspace!.solicitationSettings || {},
                  ),
                } as Workspace,
                t.subject,
                t.decision!,
                'stop',
              ),
              fingerprint: 'demo',
              target: {
                recipient: t.senderEmail,
                from: 'bonjour@atelier.example',
                name: 'Atelier',
                sourceVersion: 'demo',
              },
              enabled: data.workspace!.repliesEnabled,
              unavailable: '',
              status: t.solicitation,
            },
          },
        };
      return {
        ticketId: t.id,
        result:
          action === 'ignoreSolicitationBatch'
            ? { disposition: 'ignored' }
            : { reply: { intent: 'stop', state: 'accepted' } },
      };
    });
    return {
      data:
        action === 'previewSolicitationBatch'
          ? data
          : {
              ...data,
              tickets: data.tickets.map((t) =>
                items.some((i) => i.ticketId === t.id)
                  ? {
                      ...t,
                      solicitation:
                        action === 'ignoreSolicitationBatch'
                          ? { intent: 'ignore', state: 'ignored' }
                          : { intent: 'stop', state: 'accepted' },
                    }
                  : t,
              ),
            },
      result: { results },
    };
  }
  return null;
}
