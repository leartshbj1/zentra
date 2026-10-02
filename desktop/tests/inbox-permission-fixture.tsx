/** Verification fixture only: real React hooks, synthetic SDK IPC, no server. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useSupplierInbox, type SupplierInboxState } from '../src/supplierInbox';
import { useAppointmentInbox, type AppointmentInboxState } from '../src/AppointmentInbox';
import { desktopApi } from '../src/bridge';

const query = new URLSearchParams(location.search);
const supplier = query.get('type') !== 'appointment';
const step = query.get('step') || 'get';
const scenario = query.get('scenario') || 'prepare';
const manual = query.has('manual');
const proof = {
  calls: [] as { command: string; action: string|null; id?: string }[],
  workspaceReads: 0, publications: 0, renderReadOnly: false,
  pending: false, pendingStage: '',
};
let finish = () => {};
let first = true, held = false;
const mailItem = {
  id: 'synthetic-item-1', organizationId: 'synthetic-org', state: 'ready', otherDevice: false,
  fileName: 'synthetic.pdf', mediaType: 'application/pdf', sha256: 'synthetic',
  sender: 'supplier@example.invalid', subject: 'Synthetic invoice', invoiceId: null,
  automatic: true, createdAt: 1,
  extraction: {
    supplierName: 'Supplier fictional', reference: 'SYNTHETIC',
    invoiceDate: '2026-10-02', dueDate: '2026-11-01', currency: 'CHF',
    netCents: 10000, vatCents: 810, totalCents: 10810, vatBp: 810,
    category: 'materials', confidence: manual ? .5 : .99, fieldConfidence: {supplierName:manual ? .5 : .99}, issues: [], evidence: {},
  },
};
const appointment = {
  id: 'synthetic-item-1', organizationId: 'synthetic-org', state: 'ready', otherDevice: false,
  sender: 'customer@example.invalid', subject: 'Synthetic appointment', importedAt: null,
  extraction: {
    title: 'Synthetic appointment', startDate: '2026-10-02', endDate: '2026-10-02',
    startTime: '09:00', endTime: '10:00', allDay: false,
    location: 'Synthetic office', notes: '', status: 'scheduled', issues: [],
  },
};
const state: SupplierInboxState|AppointmentInboxState = supplier ? {
  organizationId: 'synthetic-org', linked: true, autoPost: scenario !== 'prepare',
  prepareEnabled: scenario !== 'import', automationActive: true,
  items: [mailItem, {...mailItem,id:'synthetic-item-2'}],
} : {
  organizationId: 'synthetic-org', active: true, automatic: true,
  items: [appointment, {...appointment,id:'synthetic-item-2'}],
};
Object.assign(window, {__TAURI_INTERNALS__: {invoke: async (command: string, args?: {data?: {action?: string;id?: string}}) => {
  if (command === 'append_diagnostic_events') return;
  const action = args?.data?.action ?? null;
  proof.calls.push({command,action,id:args?.data?.id});
  const value = action === 'prepareSuppliers'
    ? {results:state.items.map(row=>({id:row.id,supplierId:'synthetic-supplier',created:true}))}
    : action === 'import' ? {id:args?.data?.id,saved:true} : structuredClone(state);
  const isFirstGet = !action && first;
  if (isFirstGet) first = false;
  if (!held && (step === 'get' && (manual ? proof.calls.filter(row => !row.action).length === 2 : isFirstGet) || step === 'prepare' && action === 'prepareSuppliers' || step === 'import' && action === 'import')) {
    held = true; proof.pending = true; proof.pendingStage = step;
    return new Promise(resolve=>{finish=()=>{proof.pending=false;resolve(value);};});
  }
  return value;
}}});
desktopApi.loadWorkspace = async () => {
  proof.workspaceReads++;
  return {supplierInvoices:[],agendaEvents:[],accounts:[],suppliers:[{id:'synthetic-supplier',name:'Supplier fictional',email:'supplier@example.invalid',archivedAt:null}]} as never;
};
let setReadOnly = (_value: boolean) => {};
let blocked = false;
let prepare = async () => {};
function Fixture() {
  const [readOnly,setValue] = useState(query.has('initialReadOnly'));
  setReadOnly = value => flushSync(()=>setValue(value));
  proof.renderReadOnly = readOnly;
  const onWorkspace = () => {proof.publications++;};
  // The product under test is fixed before mounting; it never changes hook order.
  const inbox = supplier
    ? useSupplierInbox('synthetic-org',readOnly,()=>blocked,onWorkspace)
    : useAppointmentInbox('synthetic-org',readOnly,()=>blocked,onWorkspace);
  if (supplier) prepare = () => (inbox as ReturnType<typeof useSupplierInbox>).prepareAll();
  return <output data-ready="true" data-items={inbox.state?.items.length ?? -1} data-busy={inbox.busy}>{readOnly ? 'read-only' : 'editable'} {inbox.error}</output>;
}
Object.assign(window, {__qaInbox: {proof,makeReadOnly:()=>setReadOnly(true),block:()=>{blocked=true;},release:()=>finish(),prepare:()=>prepare()}});
createRoot(document.getElementById('root')!).render(<Fixture/>);
