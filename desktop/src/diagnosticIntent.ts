// Client intent only: these names never authorize or inspect an IPC payload.
const operations = {
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
export function copyDiagnosticIntent<T>(body: unknown, args: T, command: DiagnosticIntentCommand): T {
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
