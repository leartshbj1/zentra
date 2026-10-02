import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';

/** Closed native-response fixture for the actual App, Gate and background scans.
 * Captures real bridge methods before the mobile harness assigns its defaults.
 * No native binary, account, DB, email, filesystem or network API is used.
 */
// ESM evaluation precedes the mobile harness's default method assignments.
const actualReminderRead = desktopApi.getReminderSettings;
const actualReminderScan = desktopApi.scanDueReminders;
const actualGenerate = desktopApi.generateRecurrenceOccurrences;
const actualWorkspaceRead = desktopApi.loadWorkspace;

export function installWorkspaceBackgroundLifecycleFixture(workspace: Workspace, install: (value: Workspace) => void) {
  install(workspace);
  const scenario = new URLSearchParams(location.search).get('scanProbe') || 'reminder-settings';
  const identity = (window as any).__qaAppDraftIdentity;
  const native = (window as any).__TAURI_INTERNALS__;
  const previous = native.invoke;
  const baseResolve = desktopApi.resolveConnectedCompany;
  const baseWorkspaceRead = desktopApi.loadWorkspace;
  const held = new Map<number, { kind: string; resolve: (value: any) => void; reject: (reason: Error) => void; value: any }>();
  const proof = { calls: [] as any[], held: [] as any[], observer: [] as any[] };
  let next = 0, reminderReadsA = 0, rawReadsA = 0;
  let needsSdkFallbackRead = false;
  const recurrence = scenario.startsWith('recurrence');
  const scheduleIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  if (recurrence) workspace.recurrenceSchedules = scheduleIds.map(id => ({ id, sourceSalesOrderId: '33333333-3333-4333-8333-333333333333', frequency: 'monthly', anchorDate: '2026-09-01', anchorDay: 1, anchorIsMonthEnd: false, paymentTermsDays: 30, nextScheduledFor: '2026-09-01', endDate: null, status: 'active', reviewReason: null, sourceOrderSnapshotSha256: 'a'.repeat(64), sourceSnapshotSha256: 'b'.repeat(64), completedAt: null, createdAt: '2026-09-01', updatedAt: '2026-09-01' }));
  function keep(kind: string, value: any) {
    const id = ++next;
    proof.held.push({ id, kind, pending: true, scope: workspace.workNotesScope });
    return new Promise((resolve, reject) => held.set(id, { kind, value: structuredClone(value), resolve, reject }));
  }
  function rawWorkspace() {
    return {
      work_notes_scope: workspace.workNotesScope,
      settings: { company_name: workspace.settings!.organization.legalName, noga_section: 'M', noga_division: '68', activity_description: 'Synthetic local services', extra_settings_json: JSON.stringify(workspace.settings), payment_terms_days: 30, currency: 'CHF' },
      clients: workspace.clients.map(row => ({ id: row.id, name: row.name, company: row.company, email: '', phone: '', address_line1: 'Synthetic street', postal_code: '1000', city: 'Lausanne', country: 'CH' })),
      recurrence_schedules: workspace.recurrenceSchedules.map(row => ({ id: row.id, source_sales_order_id: row.sourceSalesOrderId, frequency: row.frequency, anchor_date: row.anchorDate, anchor_day: row.anchorDay, anchor_is_month_end: row.anchorIsMonthEnd, payment_terms_days: 30, next_scheduled_for: row.nextScheduledFor, status: row.status, created_at: row.createdAt, updated_at: row.updatedAt })),
      recurrence_occurrences: [],
    };
  }
  native.invoke = async (command: string, args: any) => {
    if (['get_reminder_settings', 'scan_due_reminders', 'generate_recurrence_occurrences', 'get_app_state', 'get_workspace'].includes(command)) {
      proof.calls.push({ command, args: structuredClone(args ?? null), scopeAtCall: workspace.workNotesScope, appVisible: !!document.querySelector('.desktop-app') });
      if (command === 'get_reminder_settings') {
        if (!recurrence && workspace.workNotesScope === 'synthetic-company-a' && ++reminderReadsA === 1) {
          const value = { enabled: 1, sender_name: 'Synthetic sender', last_scan_at: '' };
          return scenario === 'reminder-result' ? value : keep('settings-A', value);
        }
        return { enabled: 0, sender_name: '', last_scan_at: '' };
      }
      if (command === 'scan_due_reminders') {
        const value = { as_of: args.input.as_of, enabled: workspace.workNotesScope === 'synthetic-company-a', created: [], cancelled: [], promoted: [], review: [], idempotent: false };
        return scenario === 'reminder-result' ? keep('scan-A', { ...value, cancelled: ['synthetic-cancelled-A'] }) : value;
      }
      if (command === 'generate_recurrence_occurrences') {
        const schedule = workspace.recurrenceSchedules.find(row => row.id === args.input.schedule_id);
        if (!schedule) throw new Error('Synthetic old schedule unavailable in current company');
        schedule.nextScheduledFor = '2099-01-01';
        return {};
      }
      if (command === 'get_app_state') return { onboarding_completed: true, activity_profile_required: false, schema_version: 43 };
      const raw = rawWorkspace();
      if (workspace.workNotesScope === 'synthetic-company-a') {
        ++rawReadsA;
        if (scenario.startsWith('recurrence-fallback') && rawReadsA === 1) {
          needsSdkFallbackRead = true;
          throw new Error('Synthetic first committed read refusal');
        }
        if (rawReadsA === (scenario.startsWith('recurrence-fallback') ? 2 : 1)) return keep('workspace-A', raw);
      }
      return raw;
    }
    return previous(command, args);
  };
  desktopApi.getReminderSettings = actualReminderRead;
  desktopApi.scanDueReminders = actualReminderScan;
  desktopApi.generateRecurrenceOccurrences = actualGenerate;
  // Only the next read after the observed SDK rejection is restored to the
  // actual bridge. Initial App/Gate loads retain the existing closed fixture.
  desktopApi.loadWorkspace = () => {
    if (!needsSdkFallbackRead) return baseWorkspaceRead();
    needsSdkFallbackRead = false;
    return actualWorkspaceRead();
  };
  desktopApi.resolveConnectedCompany = async (organizationId, choice) => {
    if (organizationId === 'synthetic-organization-b' && workspace.workNotesScope === 'synthetic-company-a' && (!choice || choice === 'auto')) return { status: 'choose_remote', organizationId, changed: false };
    if (organizationId === 'synthetic-organization-b' && choice === 'open') { workspace.recurrenceSchedules = []; workspace.recurrenceOccurrences = []; }
    return baseResolve(organizationId, choice);
  };
  const controls = {
    proof,
    pending(kind: string) { return proof.held.filter(row => row.kind === kind && row.pending).map(row => row.id); },
    settle(id: number, failure = false) {
      const value = held.get(id); if (!value) throw new Error('No held synthetic response');
      held.delete(id); proof.held.find(row => row.id === id).pending = false;
      if (failure) value.reject(new Error('Synthetic read refusal')); else value.resolve(value.value);
    },
    switchVerifiedAccount() {
      const account = { status: 'connected', organizationId: 'synthetic-organization-b', organizationName: 'SYNTHETIC COMPANY B', role: 'owner' };
      identity.link(account, 'synthetic-member-b', 'synthetic-company-b'); identity.setAccount(account, 'synthetic-member-b'); identity.identityMode('ready'); identity.releaseAccount(1);
    },
    releaseAtUnmount(id: number) {
      const observer = new MutationObserver(() => {
        if (document.querySelector('.desktop-app')) return;
        observer.disconnect(); proof.observer.push({ id, appAbsent: true }); controls.settle(id);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    },
    database() { return { scope: workspace.workNotesScope, clients: workspace.clients.map(row => row.company) }; },
  };
  Object.assign(window, { __qaScan: controls });
}
