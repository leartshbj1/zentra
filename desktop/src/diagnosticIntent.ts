// Client intent only: these names never authorize or inspect an IPC payload.
const operations = {
  create_record: {
    clients: 'record.client.create',
    catalog_items: 'record.catalog_item.create',
    suppliers: 'record.supplier.create',
    projects: 'record.project.create',
    quotes: 'record.quote.create',
    invoices: 'record.invoice.create',
    employees: 'record.employee.create',
    time_entries: 'record.time_entry.create',
    expenses: 'record.expense.create',
    payslips: 'record.payslip.create',
    payslip_items: 'record.payslip_item.create',
  },
  update_record: {
    clients: 'record.client.update',
    catalog_items: 'record.catalog_item.update',
    suppliers: 'record.supplier.update',
    projects: 'record.project.update',
    quotes: 'record.quote.update',
    invoices: 'record.invoice.update',
    employees: 'record.employee.update',
    time_entries: 'record.time_entry.update',
    expenses: 'record.expense.update',
    payslips: 'record.payslip.update',
    payslip_items: 'record.payslip_item.update',
  },
  delete_record: {
    clients: 'record.client.delete',
    catalog_items: 'record.catalog_item.delete',
    suppliers: 'record.supplier.delete',
    projects: 'record.project.delete',
    quotes: 'record.quote.delete',
    invoices: 'record.invoice.delete',
    employees: 'record.employee.delete',
    time_entries: 'record.time_entry.delete',
    expenses: 'record.expense.delete',
    payslips: 'record.payslip.delete',
    payslip_items: 'record.payslip_item.delete',
  },
  save_document_with_items: {
    quotes: 'document.quote.save',
    invoices: 'document.invoice.save',
  },

  automation_request: {
    state: 'automation.state',
    decide: 'automation.decide',
    feedback: 'automation.feedback',
    settings: 'automation.settings',
    centre: 'automation.centre',
    workflow_save: 'automation.workflow_save',
    workflow_preview: 'automation.workflow_preview',
    workflow_confirm: 'automation.workflow_confirm',
    workflow_cancel: 'automation.workflow_cancel',
    workflow_retry: 'automation.workflow_retry',
    workflow_undo: 'automation.workflow_undo',
    work_item_update: 'automation.work_item_update',
    invoice_scan: 'automation.invoice_scan',
  },
  supplier_inbox_request: {
    state: 'supplier_inbox.state',
    forgetHabit: 'supplier_inbox.forget_habit',
    prepareSupplier: 'supplier_inbox.prepare_supplier',
    prepareSuppliers: 'supplier_inbox.prepare_suppliers',
    remember: 'supplier_inbox.remember',
    ignore: 'supplier_inbox.ignore',
    document: 'supplier_inbox.document',
    import: 'supplier_inbox.import',
  },
  appointment_inbox_request: {
    state: 'appointment_inbox.state',
    ignore: 'appointment_inbox.ignore',
    import: 'appointment_inbox.import',
  },
} as const;

export type DiagnosticIntentCommand = keyof typeof operations;
export type DiagnosticIntentAction = {
  [C in DiagnosticIntentCommand]: keyof typeof operations[C]
}[DiagnosticIntentCommand];
type Intent = { command: DiagnosticIntentCommand; operation: string };
const intents = new WeakMap<object, Intent>();
const isReference = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

/** Tags the same body/arguments by identity, without adding or reading properties. */
export function withDiagnosticIntent<T>(value: T, command: DiagnosticIntentCommand, action: DiagnosticIntentAction): T {
  if (!isReference(value)) return value;
  intents.delete(value);
  if (typeof command !== 'string' || typeof action !== 'string'
    || !Object.hasOwn(operations, command)) return value;
  const names = operations[command];
  if (Object.hasOwn(names, action)) {
    intents.set(value, { command, operation: (names as Record<string, string>)[action] });
  }
  return value;
}

/** Copies only trusted intent metadata; request(body) retains its business API. */
export function copyDiagnosticIntent<T>(body: unknown, args: T, command: string): T {
  const intent = isReference(body) ? intents.get(body) : undefined;
  if (isReference(args)) {
    intents.delete(args);
    if (intent?.command === command) intents.set(args, intent);
  }
  return args;
}

/** The transport looks up arguments by reference, never args.data or data.action. */
export function diagnosticIntentOperation(command: string, args: unknown): string | undefined {
  const intent = isReference(args) ? intents.get(args) : undefined;
  return intent?.command === command ? intent.operation : undefined;
}

export type DiagnosticEntityCommand = 'create_record'|'update_record'|'delete_record'|'save_document_with_items';
/** The bridge supplies a closed entity name explicitly; never infer it from args.
 * Invalid/hostile annotations are removed without inspecting or coercing them.
 * Intent metadata describes client activity only and grants no write permission. */
export function withEntityDiagnosticIntent<T>(value:T,command:DiagnosticEntityCommand,entity:unknown):T {
  if(typeof command!=='string'||!['create_record','update_record','delete_record','save_document_with_items'].includes(command)){
    if(isReference(value))intents.delete(value);
    return value;
  }
  return withDiagnosticIntent(value,command,entity as DiagnosticIntentAction);
}
