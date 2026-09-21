import { t, useAppLanguage } from './language';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CalendarDays, Check, ChevronRight } from 'lucide-react';
import type { Workspace } from './types';
import { desktopApi } from './bridge';
import { Button, Field, Modal } from './ui';
import { formatDate } from './utils';
type Extraction = {
  title: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  location: string;
  notes: string;
  status: string;
  issues: string[];
};
type Item = {
  id: string;
  organizationId: string;
  sender: string;
  subject: string;
  extraction: Extraction;
  state: string;
  otherDevice: boolean;
  importedAt: number | null;
};
type State = {
  organizationId: string;
  active: boolean;
  automatic: boolean;
  items: Item[];
};
const request = <T,>(data: unknown = null) =>
  invoke<T>('appointment_inbox_request', { data });
export function useAppointmentInbox(
  org: string | null,
  readOnly: boolean,
  blocked: () => boolean,
  onWorkspace: (w: Workspace) => void,
) {
  const [state, setState] = useState<State | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const context = useRef({ org, readOnly, blocked, onWorkspace });
  context.current = { org, readOnly, blocked, onWorkspace };
  const running = useRef(false);
  const refresh = useCallback(async () => {
    if (
      !org ||
      running.current ||
      !navigator.onLine ||
      document.visibilityState === 'hidden'
    )
      return;
    running.current = true;
    try {
      const next = await request<State>();
      if (context.current.org !== org || next.organizationId !== org) return;
      setState(next);
      setError('');
      let changed = false;
      for (const item of next.items
        .filter(
          (i) =>
            !i.otherDevice &&
            (i.state === 'processing' ||
              (next.automatic && i.state === 'ready')),
        )
        .slice(0, 10)) {
        if (
          context.current.org !== org ||
          context.current.readOnly ||
          context.current.blocked()
        )
          break;
        try {
          const r = await request<{ saved?: boolean }>({
            action: 'import',
            id: item.id,
            automatic: item.state === 'ready',
          });
          changed = changed || !!r.saved;
        } catch (e) {
          if (context.current.org === org) setError(String(e));
        }
      }
      if (changed && context.current.org === org) {
        const w = await desktopApi.loadWorkspace();
        if (context.current.org === org) {
          context.current.onWorkspace(w);
          window.dispatchEvent(new Event('zentra-automation-updated'));
          const latest = await request<State>();
          if (context.current.org === org && latest.organizationId === org)
            setState(latest);
        }
      }
    } catch (e) {
      if (context.current.org === org) setError(String(e));
    } finally {
      running.current = false;
    }
  }, [org]);
  useEffect(() => {
    setState(null);
    setError('');
    void refresh();
    const f = () => void refresh(),
      timer = setInterval(f, 15000);
    window.addEventListener('focus', f);
    window.addEventListener('online', f);
    document.addEventListener('visibilitychange', f);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', f);
      window.removeEventListener('online', f);
      document.removeEventListener('visibilitychange', f);
    };
  }, [refresh]);
  async function act(data: unknown) {
    if (!org || running.current || context.current.readOnly)
      throw Error('Attendez la fin de la réception en cours.');
    running.current = true;
    setBusy(true);
    try {
      await request(data);
      const w = await desktopApi.loadWorkspace();
      if (context.current.org !== org) return;
      context.current.onWorkspace(w);
      window.dispatchEvent(new Event('zentra-automation-updated'));
    } finally {
      running.current = false;
      setBusy(false);
      void refresh();
    }
  }
  return { state, error, busy, act };
}
export function AppointmentInbox({
  inbox,
  workspace,
  readOnly,
  onAgenda,
}: {
  inbox: ReturnType<typeof useAppointmentInbox>;
  workspace: Workspace;
  readOnly: boolean;
  onAgenda: () => void;
}) {
  useAppLanguage();
  const [selected, setSelected] = useState<Item | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    setSelected(null);
    setError('');
  }, [inbox.state?.organizationId]);
  if (!inbox.state?.active) return null;
  const pending = inbox.state.items.filter(
    (i) => !['imported', 'ignored'].includes(i.state),
  );
  const imported = inbox.state.items.filter((i) => i.state === 'imported');
  return (
    <section className="automation-appointments">
      <header>
        <CalendarDays size={22} />
        <div>
          <h2>{t('Rendez-vous')}</h2>
          <p>
            {pending.length
              ? t('{count} à vérifier', { count: pending.length })
              : t('Votre agenda reste à jour.')}
          </p>
        </div>
        <Button variant="ghost" onClick={onAgenda}>
          {t('Agenda')}
          <ChevronRight size={16} />
        </Button>
      </header>
      {inbox.error && <p role="status">{inbox.error}</p>}
      {pending.map((i) => (
        <article key={i.id}>
          <div>
            <strong>{i.extraction.title || i.subject}</strong>
            <span>
              {i.extraction.startDate
                ? formatDate(i.extraction.startDate)
                : t('Date à préciser')}{' '}
              {i.extraction.startTime} {t('·')}
              {i.extraction.location || i.sender}
            </span>
          </div>
          <Button
            variant="secondary"
            disabled={inbox.busy || readOnly || i.otherDevice}
            onClick={() => {
              setSelected(i);
              setError('');
            }}
          >
            {t(i.otherDevice ? 'En cours' : 'Vérifier')}
          </Button>
        </article>
      ))}
      {!pending.length && (
        <div className="automation-appointments__empty">
          <Check size={18} />
          <span>
            {t(
              'Les confirmations complètes reçues par Support sont ajoutées ici et dans l’agenda.',
            )}
          </span>
        </div>
      )}
      {!!imported.length && (
        <details>
          <summary>{t('Derniers rendez-vous ajoutés')}</summary>
          {imported.slice(0, 5).map((i) => (
            <article key={i.id}>
              <div>
                <strong>{i.extraction.title}</strong>
                <span>
                  {formatDate(i.extraction.startDate)} {t('·')}
                  {i.extraction.startTime}
                </span>
              </div>
              <Check size={18} />
            </article>
          ))}
        </details>
      )}
      {selected && (
        <AppointmentReview
          key={selected.id}
          item={selected}
          workspace={workspace}
          busy={inbox.busy}
          error={error}
          onClose={() => setSelected(null)}
          onSave={async (event) => {
            try {
              await inbox.act({
                action: 'import',
                id: selected.id,
                event,
                automatic: false,
              });
              setSelected(null);
            } catch (e) {
              setError(String(e));
            }
          }}
          onIgnore={async () => {
            try {
              await inbox.act({ action: 'ignore', id: selected.id });
              setSelected(null);
            } catch (e) {
              setError(String(e));
            }
          }}
        />
      )}
    </section>
  );
}
function AppointmentReview({
  item,
  workspace,
  busy,
  error,
  onClose,
  onSave,
  onIgnore,
}: {
  item: Item;
  workspace: Workspace;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (event: unknown) => Promise<void>;
  onIgnore: () => Promise<void>;
}) {
  const existing = workspace.agendaEvents.find((e) => e.id === item.id);
  const [v, set] = useState(item.extraction),
    [project, setProject] = useState(existing?.projectId || '');
  return (
    <Modal
      title={t('Vérifier le rendez-vous')}
      onClose={onClose}
      dismissible={!busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({
            id: item.id,
            create_only: !existing,
            expected_updated_at: existing?.updatedAt || null,
            title: v.title,
            start_date: v.startDate,
            end_date: v.endDate,
            start_time: v.startTime,
            end_time: v.endTime,
            all_day: v.allDay,
            location: v.location,
            notes: `Reçu depuis Zentra Support · ${item.sender}\n${v.notes}`,
            kind: 'appointment',
            status: v.status,
            project_id: project || null,
            employee_id: existing?.employeeId || null,
          });
        }}
      >
        <p>{t('Heures de Suisse · Europe/Zurich')}</p>
        <fieldset disabled={busy} className="appointment-review-fields">
          <Field label={t('Objet')}>
            <input
              required
              maxLength={200}
              value={v.title}
              onChange={(e) => set({ ...v, title: e.target.value })}
            />
          </Field>
          <Field label={t('Début')}>
            <input
              type="date"
              required
              value={v.startDate}
              onChange={(e) =>
                set({
                  ...v,
                  startDate: e.target.value,
                  endDate: v.endDate || e.target.value,
                })
              }
            />
          </Field>
          <Field label={t('Fin')}>
            <input
              type="date"
              required
              min={v.startDate}
              value={v.endDate}
              onChange={(e) => set({ ...v, endDate: e.target.value })}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={v.allDay}
              onChange={(e) => set({ ...v, allDay: e.target.checked })}
            />{' '}
            {t('Toute la journée')}
          </label>
          {!v.allDay && (
            <>
              <Field label={t('Heure de début')}>
                <input
                  type="time"
                  required
                  value={v.startTime}
                  onChange={(e) => set({ ...v, startTime: e.target.value })}
                />
              </Field>
              <Field label={t('Heure de fin')}>
                <input
                  type="time"
                  required
                  value={v.endTime}
                  onChange={(e) => set({ ...v, endTime: e.target.value })}
                />
              </Field>
            </>
          )}
          <Field label={t('Lieu ou lien de réunion')}>
            <input
              maxLength={500}
              value={v.location}
              onChange={(e) => set({ ...v, location: e.target.value })}
            />
          </Field>
          <Field label={t('Projet')}>
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">{t('Sans projet')}</option>
              {workspace.projects
                .filter((p) => !p.archivedAt)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('Statut')}>
            <select
              value={v.status}
              onChange={(e) => set({ ...v, status: e.target.value })}
            >
              <option value="scheduled">{t('Confirmé')}</option>
              <option value="cancelled">{t('Annulé')}</option>
            </select>
          </Field>
          <details>
            <summary>{t('Message et points à vérifier')}</summary>
            <ul>
              {v.issues.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            <p style={{ whiteSpace: 'pre-wrap' }}>{v.notes}</p>
          </details>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <footer className="appointment-review-actions">
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => void onIgnore()}
          >
            {t('Écarter')}
          </Button>
          <Button type="submit" disabled={busy}>
            {t(
              existing ? 'Mettre à jour le rendez-vous' : 'Ajouter à l’agenda',
            )}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
