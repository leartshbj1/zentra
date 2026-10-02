// Test-only closed SDK transport; the production App, report screen and bridge stay intact.
import { desktopApi, type CloudAccountState } from '../src/bridge';
import type { Workspace } from '../src/types';
import { companyReceiveAllowed } from '../src/companySync';
import { recentDiagnosticEvents, resolveErrorIncident } from '../src/diagnostics';

const actualExport = desktopApi.exportProjectReportPdf;
export function installReportAudit(workspace: Workspace, installIdentity: (workspace: Workspace) => void) {
  installIdentity(workspace);
  const identity = (window as any).__qaAppDraftIdentity;
  const native = (window as any).__TAURI_INTERNALS__;
  const previousInvoke = native.invoke;
  const previousResolve = desktopApi.resolveConnectedCompany;
  const template = workspace.projects[0];
  workspace.projects = [{ ...template, id: 'synthetic-shared-project', name: 'SYNTHETIC REPORT A' }];
  workspace.invoices = []; workspace.quotes = []; workspace.payments = []; workspace.timeEntries = [];
  workspace.supplierInvoices = []; workspace.supplierCreditNotes = []; workspace.expenses = [];
  let releaseDialog: ((path: string) => void) | undefined;
  let releaseNative: (() => void) | undefined;
  let mode = 'current';
  const proof = { dialogs: [] as any[], exports: [] as any[], shares: [] as any[], results: [] as any[], rejects: [] as string[], commands: [] as string[] };
  desktopApi.exportProjectReportPdf = async (...args) => {
    try { const result = await actualExport(...args); proof.results.push(result === null ? null : {path:result.path,deliveryWarning:'deliveryWarning' in result ? result.deliveryWarning : undefined}); return result; }
    catch(reason) { proof.rejects.push(String((reason as Error).message)); throw reason; }
  };
  desktopApi.resolveConnectedCompany = async (org, choice) => {
    if ((!choice || choice === 'auto') && org === 'synthetic-organization-b' && workspace.workNotesScope === 'synthetic-company-a')
      return { status: 'choose_remote', organizationId: org, changed: false };
    const result = await previousResolve(org, choice);
    if (result.changed) workspace.projects[0].name = 'SYNTHETIC REPORT B';
    return result;
  };
  native.invoke = async (command: string, args?: any, options?: unknown) => {
    proof.commands.push(command);
    if (command === 'plugin:zentra-mobile|configure_navigation') return;
    if (command === 'share_mobile_export') {
      proof.shares.push({scope:workspace.workNotesScope,path:args.path});
      if(mode === 'share-refused' && proof.shares.length === 1) throw Error('Synthetic sharing unavailable');
      return;
    }
    if (command === 'plugin:dialog|save' || command === 'prepare_mobile_export') {
      proof.dialogs.push({ scope: workspace.workNotesScope, command });
      if(mode === 'cancel')return null;
      if (mode === 'late-dialog' || mode === 'late-reception') return new Promise<string>(resolve => { releaseDialog = resolve; });
      return 'C:/Zentra-Synthetic/report.pdf';
    }
    if (command === 'export_project_report_pdf') {
      proof.exports.push({ title: args.report.title, issuerScopeAtIpc: workspace.workNotesScope, expectedScope:args.expectedWorkspaceScope??null, keys:Object.keys(args), destination: args.destinationPath });
      if(mode === 'native-refused')throw Error('Accès refusé : le dossier choisi ne permet pas cet export.');
      if (mode === 'late-native') await new Promise<void>(resolve => { releaseNative = resolve; });
      return { path: 'C:/Zentra-Synthetic/report.pdf', pages: 1 };
    }
    return previousInvoke(command, args, options);
  };
  Object.assign(window, { __qaReportsAudit: {
    proof,
    mode(value: string) { mode = value; },
    releaseDialog() { if (!releaseDialog) throw Error('No held synthetic picker'); releaseDialog('C:/Zentra-Synthetic/report.pdf'); releaseDialog = undefined; },
    releaseNative() { if (!releaseNative) throw Error('No held synthetic renderer'); releaseNative(); releaseNative = undefined; },
    async receiveSameOrganization() {
      const allowed = companyReceiveAllowed();
      if (!allowed) throw Error('Production receive guard blocked the fixture');
      workspace.projects[0].name = 'SYNTHETIC REPORT B';
      await identity.receiveScope('synthetic-company-b');
      return { allowed, organizationChanged: false };
    },
    switchVerifiedAccount() {
      const next: CloudAccountState = { status: 'connected', organizationId: 'synthetic-organization-b', organizationName: 'SYNTHETIC COMPANY B', role: 'owner' };
      identity.link(next, 'synthetic-member-b', 'synthetic-company-b');
      identity.setAccount(next, 'synthetic-member-b'); identity.identityMode('ready'); identity.releaseAccount(1);
    },
    state() { return { proof: structuredClone(proof), scope: workspace.workNotesScope, company: document.querySelector('.sidebar__company strong')?.textContent,
      diagnostics:recentDiagnosticEvents().filter(event=>event.operation==='project_report.export'), reports: document.querySelector('.project-reports')?.textContent, rootInert: document.getElementById('root')?.inert,
      dialogs: Array.from(document.querySelectorAll('[role=dialog]')).map(node => node.textContent) }; },
  } });
}

/** Standalone real SDK witness: legacy omission, exact rejection and private logging. */
export function installReportSdkContract() {
  Object.assign(window, { __qaReportSdk: async (mode: string) => {
    const report = { title: 'PRIVATE-SYNTHETIC-REPORT' };
    const scope = 'PRIVATE-SYNTHETIC-SCOPE';
    const reason = mode === 'string-rejection' ? 'PRIVATE-SYNTHETIC-REJECTION' : { message: 'PRIVATE-SYNTHETIC-REJECTION' };
    const calls: unknown[] = [];
    const before = recentDiagnosticEvents().length;
    (window as any).__TAURI_INTERNALS__ = { invoke: async function(command: string, args: any) {
      if (command === 'append_diagnostic_events') return;
      calls.push({ command, arity: arguments.length, keys: args ? Object.keys(args) : [], sameReport: args?.report === report, scope: args?.expectedWorkspaceScope });
      if (command === 'plugin:dialog|save' || command === 'prepare_mobile_export') return 'C:/PRIVATE-SYNTHETIC/report.pdf';
      if (command === 'share_mobile_export') return;
      if (command === 'export_project_report_pdf') {
        if (mode === 'object-rejection' || mode === 'string-rejection') throw reason;
        return { path: 'C:/PRIVATE-SYNTHETIC/report.pdf', pages: 2 };
      }
      throw new Error('Unexpected synthetic IPC');
    } };
    let result, rejected = false, sameReason = false;
    try { result = mode === 'legacy' ? await actualExport(report as never) : await actualExport(report as never, scope, () => true); }
    catch (error) { rejected = true; sameReason = error === reason; }
    const events = recentDiagnosticEvents().slice(before).filter(event => event.operation === 'project_report.export');
    return { mode, calls, result, rejected, sameReason, incident: rejected ? resolveErrorIncident(reason) : undefined, events };
  } });
}
