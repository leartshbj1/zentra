export type Identifier = string;

export type EntityKind =
  | 'clients'
  | 'catalogItems'
  | 'suppliers'
  | 'projects'
  | 'quotes'
  | 'invoices'
  | 'employees'
  | 'timeEntries'
  | 'expenses'
  | 'payslips';

export type Address = {
  street: string;
  buildingNumber?: string;
  postalCode: string;
  city: string;
  canton: string;
  country: string;
};

export type Organization = {
  legalName: string;
  legalForm: string;
  contactName: string;
  email: string;
  phone: string;
  website: string;
  uidNumber: string;
  vatNumber: string;
  vatRegistered: boolean;
  address: Address;
  logoPath?: string;
};

export type BillingSettings = {
  currency: 'CHF';
  iban: string;
  accountHolder: string;
  quotePrefix: string;
  invoicePrefix: string;
  creditNotePrefix: string;
  nextQuoteNumber: number;
  nextInvoiceNumber: number;
  nextCreditNoteNumber: number;
  paymentTermsDays: number;
  quoteValidityDays: number;
  vatRatesBp: number[];
  defaultFooter: string;
};

export type WorkSettings = {
  workWeekHours: number;
  dailyHours: number;
  roundingMinutes: number;
  breakMinutes: number;
  costCategories: string[];
};

export type PayrollSettings = {
  enabled: boolean;
  fiduciaryValidated: boolean;
  avsFund: string;
  accidentInsurer: string;
  pensionFund: string;
  dailyAllowanceInsurer: string;
  familyAllowanceFund: string;
  payrollCanton: string;
  employeeRates: PayrollRate[];
  employerRates: PayrollRate[];
};

export type PayrollRate = {
  id: Identifier;
  code?: string;
  label: string;
  rateBp: number;
  effectiveFrom: string;
  annualCeilingCents?: number | null;
  sourceLabel?: string;
  sourceUrl?: string;
};

export type BackupSettings = {
  automatic: boolean;
  folder: string;
  frequency: 'daily' | 'weekly' | 'manual';
  retentionDaily: number;
  retentionWeekly: number;
  retentionMonthly: number;
  recoveryConfirmed: boolean;
};

export type NogaSectionCode =
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V';

export type BusinessProfile = {
  nogaSection: NogaSectionCode | '';
  nogaDivision: string;
  activityDescription: string;
  nogaDetailedCode: string;
};

export type NogaDivision = { code: string; label: string };
export type NogaSection = {
  code: NogaSectionCode;
  label: string;
  divisions: NogaDivision[];
};
export type NogaCatalog = {
  version: string;
  source: string;
  sections: NogaSection[];
};

export type AppSettings = {
  organization: Organization;
  business: BusinessProfile;
  billing: BillingSettings;
  work: WorkSettings;
  payroll: PayrollSettings;
  backup: BackupSettings;
};

export type Client = {
  id: Identifier;
  name: string;
  company: string;
  email: string;
  phone: string;
  address: string;
  addressLine1?: string;
  addressLine2?: string;
  buildingNumber?: string;
  postalCode?: string;
  city?: string;
  canton?: string;
  country?: string;
  uidNumber: string;
  notes: string;
  archivedAt?: string | null;
};

export type ProjectStatus =
  | 'planned'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'closed';

export type Project = {
  id: Identifier;
  clientId: Identifier;
  name: string;
  address: string;
  status: ProjectStatus;
  plannedStart: string;
  plannedEnd: string;
  actualStart: string;
  actualEnd: string;
  budgetCents: number;
  plannedMinutes: number;
  notes: string;
  archivedAt?: string | null;
};

export type ProjectPlanningStatus =
  | 'todo'
  | 'in_progress'
  | 'done'
  | 'cancelled';
export type ProjectPlanningPriority = 'low' | 'normal' | 'high' | 'urgent';

export type ProjectMilestone = {
  id: Identifier;
  projectId: Identifier;
  title: string;
  description: string;
  dueDate: string;
  status: ProjectPlanningStatus;
  priority: ProjectPlanningPriority;
  sortOrder: number;
  employeeId: Identifier | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectTask = {
  id: Identifier;
  projectId: Identifier;
  milestoneId: Identifier | null;
  title: string;
  description: string;
  dueDate: string;
  status: ProjectPlanningStatus;
  priority: ProjectPlanningPriority;
  sortOrder: number;
  employeeId: Identifier | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CatalogItem = {
  id: Identifier;
  kind: 'product' | 'service';
  sku?: string | null;
  name: string;
  description: string;
  unit: string;
  salesPriceCents: number;
  purchaseCostCents: number;
  vatBp: number;
  trackStock: boolean;
  stockQuantityMilli: number;
  reorderLevelMilli: number;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StockMovementType = 'entry' | 'exit' | 'correction';
export type StockMovementSource =
  | 'manual'
  | 'invoice'
  | 'opening'
  | 'delivery'
  | 'delivery_reversal'
  | 'receipt'
  | 'receipt_reversal';

export type StockMovement = {
  sequence: number;
  id: Identifier;
  sourceKey: string;
  requestId: Identifier | null;
  catalogItemId: Identifier;
  movementType: StockMovementType;
  quantityDeltaMilli: number;
  balanceAfterMilli: number;
  reason: string;
  reference: string | null;
  movementDate: string;
  sourceType: StockMovementSource;
  invoiceId: Identifier | null;
  invoiceItemId: Identifier | null;
  deliveryNoteId?: Identifier | null;
  deliveryNoteLineId?: Identifier | null;
  stockReceiptId?: Identifier | null;
  stockReceiptLineId?: Identifier | null;
  createdAt: string;
};

export type DocumentLine = {
  id: Identifier;
  catalogItemId?: Identifier | null;
  description: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  discountBp?: number;
  vatRateBp: number;
};

export type FrozenIssuer = {
  companyName: string;
  legalForm: string;
  ownerName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  buildingNumber: string;
  postalCode: string;
  city: string;
  canton: string;
  country: string;
  uidNumber: string;
  vatNumber: string;
  vatRegistered: boolean;
  iban: string;
  bankName: string;
  currency: string;
  logoPath: string;
};

export type FrozenCustomer = {
  id: Identifier;
  name: string;
  company: string;
  contactPerson: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  canton: string;
  country: string;
};

export type FrozenDocumentRecord = {
  id: Identifier;
  number: string;
  clientId: Identifier;
  projectId: Identifier | null;
  quoteId: Identifier | null;
  originalInvoiceId: Identifier | null;
  title: string;
  type: string;
  issueDate: string;
  validUntil: string;
  dueDate: string;
  serviceDateFrom: string;
  serviceDateTo: string;
  currency: string;
  notes: string;
  terms: string;
};

export type FrozenDocumentSnapshot = {
  capturedAt: string;
  issuer: FrozenIssuer;
  customer: FrozenCustomer;
  document: FrozenDocumentRecord;
  items: DocumentLine[];
  qrBill?: StoredSwissQrBill | null;
};

export type QuoteStatus =
  | 'draft'
  | 'issued'
  | 'accepted'
  | 'refused'
  | 'expired';

export type Quote = {
  id: Identifier;
  number: string;
  clientId: Identifier;
  projectId: Identifier | null;
  title: string;
  issueDate: string;
  validUntil: string;
  status: QuoteStatus;
  lines: DocumentLine[];
  notes: string;
  createdAt: string;
  snapshot?: FrozenDocumentSnapshot | null;
};

export type InvoiceStatus =
  | 'draft'
  | 'issued'
  | 'partially_paid'
  | 'paid'
  | 'cancelled';
export type InvoiceType =
  | 'standard'
  | 'deposit'
  | 'progress'
  | 'final'
  | 'credit_note';

export type Invoice = {
  id: Identifier;
  number: string;
  clientId: Identifier;
  projectId: Identifier | null;
  quoteId: Identifier | null;
  originalInvoiceId: Identifier | null;
  title: string;
  type: InvoiceType;
  issueDate: string;
  dueDate: string;
  serviceDateFrom: string;
  serviceDateTo: string;
  status: InvoiceStatus;
  lines: DocumentLine[];
  notes: string;
  createdAt: string;
  snapshot?: FrozenDocumentSnapshot | null;
  qrBill?: StoredSwissQrBill | null;
};

export type SalesOrderStatus = 'draft' | 'confirmed' | 'closed' | 'cancelled';
export type SalesOrderFulfillmentMode =
  | 'stocked_delivery'
  | 'untracked_delivery'
  | 'direct';

export type SalesOrderLine = {
  id: Identifier;
  salesOrderId: Identifier;
  catalogItemId: Identifier | null;
  position: number;
  description: string;
  quantityMilli: number;
  cancelledQuantityMilli: number;
  unit: string;
  unitPriceCents: number;
  discountBp: number;
  vatBp: number;
  lineGrossCents: number;
  lineNetCents: number;
  lineVatCents: number;
  lineTotalCents: number;
  fulfillmentMode: SalesOrderFulfillmentMode;
};

export type SalesOrder = {
  id: Identifier;
  clientId: Identifier;
  projectId: Identifier | null;
  quoteId: Identifier | null;
  number: string;
  title: string;
  status: SalesOrderStatus;
  orderDate: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  vatCents: number;
  totalCents: number;
  notes: string;
  terms: string;
  confirmedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: SalesOrderLine[];
};

export type DeliveryNoteStatus = 'draft' | 'issued' | 'reversed';

export type DeliveryNoteLine = {
  id: Identifier;
  deliveryNoteId: Identifier;
  salesOrderLineId: Identifier;
  position: number;
  quantityMilli: number;
  description: string;
  unit: string;
};

export type DeliveryNote = {
  id: Identifier;
  salesOrderId: Identifier;
  number: string;
  status: DeliveryNoteStatus;
  deliveryDate: string;
  reference: string;
  notes: string;
  issuedAt: string | null;
  reversedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: DeliveryNoteLine[];
};

export type StockReservationEventType =
  | 'reserve'
  | 'delivery'
  | 'release'
  | 'restore';

export type StockReservationEvent = {
  sequence: number;
  id: Identifier;
  catalogItemId: Identifier;
  salesOrderId: Identifier;
  salesOrderLineId: Identifier;
  deliveryNoteLineId: Identifier | null;
  eventType: StockReservationEventType;
  quantityDeltaMilli: number;
  lineReservedAfterMilli: number;
  catalogReservedAfterMilli: number;
  reason: string;
  createdAt: string;
};

export type SalesOrderInvoiceRole = 'partial' | 'final';

export type SalesOrderInvoiceBatch = {
  id: Identifier;
  salesOrderId: Identifier;
  invoiceId: Identifier;
  role: SalesOrderInvoiceRole;
  createdAt: string;
};

export type SalesOrderInvoiceAllocation = {
  id: Identifier;
  batchId: Identifier;
  salesOrderLineId: Identifier;
  deliveryNoteLineId: Identifier | null;
  invoiceItemId: Identifier | null;
  quantityMilli: number;
  grossCentsSnapshot: number;
  netCentsSnapshot: number;
  vatCentsSnapshot: number;
  totalCentsSnapshot: number;
  createdAt: string;
};

export type StockAvailability = {
  catalogItemId: Identifier;
  onHandMilli: number;
  reservedMilli: number;
  availableMilli: number;
};

export type SalesOrderInvoicePreview = {
  role: SalesOrderInvoiceRole;
  subtotalCents: number;
  discountCents: number;
  vatCents: number;
  totalCents: number;
  blockers: string[];
};

export type Payment = {
  id: Identifier;
  invoiceId: Identifier;
  date: string;
  amountCents: number;
  method: string;
  reference: string;
};

export type Employee = {
  id: Identifier;
  employeeNumber: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  address: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  canton: string;
  country: string;
  birthDate: string;
  avsNumber: string;
  employmentStart: string;
  employmentEnd: string;
  /** Date confirmée par la caisse/fiduciaire; jamais déduite du sexe. */
  referenceAgeDate: string;
  /** true = renonciation confirmée, false = franchise conservée, null = à confirmer. */
  avsAllowanceWaived: boolean | null;
  employmentRate: number;
  /** Horaire contractuel explicite; utilisé pour la décision AANP de 8 h/semaine. */
  contractualWeeklyMinutes: number | null;
  /** Année pour laquelle la base AC antérieure à Elyko a été confirmée. */
  acOpeningYear: number | null;
  /** Base AC déjà acquise hors Elyko au début de l'année, y compris zéro confirmé. */
  acOpeningBasisCents: number | null;
  salaryMode: 'hourly' | 'monthly';
  grossSalaryCents: number;
  hourlyCostCents: number;
  iban: string;
  active: boolean;
  notes: string;
  archivedAt?: string | null;
};

export type TimeEntry = {
  id: Identifier;
  projectId: Identifier;
  taskId: Identifier | null;
  employeeId: Identifier;
  date: string;
  minutes: number;
  breakMinutes?: number;
  billable?: boolean;
  billingRateCents?: number;
  hourlyCostCents: number;
  note: string;
  status: 'entered' | 'approved' | 'locked';
  /** Cycle de facturation indépendant du statut de validation du temps. */
  billingStatus: 'unbilled' | 'reserved' | 'billed';
  billingBatchId: Identifier | null;
  billingInvoiceId: Identifier | null;
  billingInvoiceNumber: string | null;
  createdAt: string;
};

export type TimeBillingBatch = {
  id: Identifier;
  requestId: Identifier;
  invoiceId: Identifier;
  projectId: Identifier;
  clientId: Identifier;
  vatBp: number;
  createdAt: string;
};

export type TimeBillingEntry = {
  id: Identifier;
  batchId: Identifier;
  timeEntryId: Identifier;
  invoiceItemId: Identifier;
  entryDate: string;
  minutes: number;
  billingRateCents: number;
  amountCents: number;
  employeeName: string;
  note: string;
  createdAt: string;
};

export type ActiveTimer = {
  projectId: Identifier;
  taskId: Identifier | null;
  employeeId: Identifier;
  startedAt: string;
  note: string;
  billable?: boolean;
  billingRateCents?: number;
  hourlyCostCents?: number;
} | null;

export type Expense = {
  id: Identifier;
  projectId: Identifier | null;
  supplierId?: Identifier | null;
  date: string;
  dueDate?: string | null;
  supplier: string;
  category: string;
  reference: string;
  netCents: number;
  vatCents: number;
  totalCents: number;
  paymentStatus: 'pending' | 'paid';
  paidAt?: string | null;
  reimbursable?: boolean;
  note: string;
  receiptPath?: string;
  archivedAt?: string | null;
};

export type SupplierInvoiceItem = {
  id: Identifier;
  supplierInvoiceId: Identifier;
  position: number;
  description: string;
  quantityMilli: number;
  unit: string;
  unitPriceCents: number;
  discountBp: number;
  vatBp: number;
  netCents: number;
  vatCents: number;
  totalCents: number;
  category: string;
  expenseAccountId: Identifier | null;
  postedExpenseAccountId?: Identifier | null;
  projectId: Identifier | null;
};

export type SupplierInvoicePayment = {
  id: Identifier;
  supplierInvoiceId: Identifier;
  requestId: string;
  date: string;
  amountCents: number;
  method: string;
  reference: string;
  notes: string;
  journalEntryId: Identifier;
  createdAt: string;
};

export type Attachment = {
  id: Identifier;
  projectId: Identifier | null;
  entityType: string;
  entityId: Identifier | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
};

export type SupplierInvoice = {
  id: Identifier;
  supplierId: Identifier;
  projectId: Identifier | null;
  documentDate: string;
  dueDate: string;
  supplierName: string;
  reference: string;
  currency: 'CHF';
  documentStatus: 'draft' | 'validated';
  paymentStatus: 'pending' | 'partial' | 'paid' | null;
  netCents: number;
  vatCents: number;
  totalCents: number;
  paidCents: number;
  creditedCents: number;
  balanceCents: number;
  matchStatus: 'unmatched' | 'partial' | 'matched' | 'mismatch';
  validatedAt: string | null;
  validationJournalEntryId: Identifier | null;
  note: string;
  lines: SupplierInvoiceItem[];
  payments: SupplierInvoicePayment[];
  attachments: Attachment[];
  createdAt: string;
  updatedAt: string;
};

export type SupplierOrderStatus =
  | 'draft'
  | 'confirmed'
  | 'closed'
  | 'cancelled';
export type SupplierOrderFulfillmentMode =
  | 'stocked_receipt'
  | 'untracked_receipt'
  | 'direct';

export type SupplierOrderLine = {
  id: Identifier;
  supplierOrderId: Identifier;
  catalogItemId: Identifier | null;
  position: number;
  description: string;
  quantityMilli: number;
  cancelledQuantityMilli: number;
  receivedQuantityMilli: number;
  matchedQuantityMilli: number;
  remainingReceivableMilli: number;
  remainingMatchableMilli: number;
  unit: string;
  unitPriceCents: number;
  discountBp: number;
  vatBp: number;
  lineNetCents: number;
  lineVatCents: number;
  lineTotalCents: number;
  category: string;
  expenseAccountId: Identifier | null;
  projectId: Identifier | null;
  fulfillmentMode: SupplierOrderFulfillmentMode;
};

export type SupplierOrder = {
  id: Identifier;
  supplierId: Identifier;
  projectId: Identifier | null;
  number: string;
  title: string;
  status: SupplierOrderStatus;
  orderDate: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  vatCents: number;
  totalCents: number;
  notes: string;
  terms: string;
  confirmedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string;
  createdAt: string;
  updatedAt: string;
  lines: SupplierOrderLine[];
};

export type SupplierOrderCancellationLine = {
  id: Identifier;
  requestId: string;
  supplierOrderId: Identifier;
  supplierOrderLineId: Identifier;
  quantityMilli: number;
  reason: string;
  createdAt: string;
};

export type SupplierReceiptStatus = 'draft' | 'issued' | 'reversed';

export type SupplierReceiptLine = {
  id: Identifier;
  supplierReceiptId: Identifier;
  supplierOrderLineId: Identifier;
  position: number;
  quantityMilli: number;
  description: string;
  unit: string;
};

export type SupplierReceipt = {
  id: Identifier;
  supplierOrderId: Identifier;
  number: string;
  status: SupplierReceiptStatus;
  receiptDate: string;
  reference: string;
  notes: string;
  issuedAt: string | null;
  reversedAt: string | null;
  reversalReason: string;
  createdAt: string;
  updatedAt: string;
  lines: SupplierReceiptLine[];
};

export type SupplierInvoiceMatch = {
  id: Identifier;
  requestId: string;
  supplierInvoiceId: Identifier;
  supplierInvoiceItemId: Identifier;
  supplierOrderId: Identifier;
  supplierOrderLineId: Identifier;
  supplierReceiptLineId: Identifier | null;
  quantityMilli: number;
  netCents: number;
  vatCents: number;
  totalCents: number;
  createdAt: string;
};

export type SupplierCreditNoteItem = Omit<
  SupplierInvoiceItem,
  'supplierInvoiceId'
> & {
  supplierCreditNoteId: Identifier;
};

export type SupplierCreditAllocation = {
  id: Identifier;
  sequence: number;
  requestId: string;
  supplierCreditNoteId: Identifier;
  supplierInvoiceId: Identifier;
  eventType: 'apply' | 'reverse';
  reversesAllocationId: Identifier | null;
  amountCents: number;
  reason: string;
  createdAt: string;
};

export type SupplierCreditNote = {
  id: Identifier;
  supplierId: Identifier;
  number: string;
  documentDate: string;
  supplierName: string;
  reference: string;
  currency: string;
  status: 'draft' | 'validated';
  netCents: number;
  vatCents: number;
  totalCents: number;
  allocatedCents: number;
  note: string;
  validatedAt: string | null;
  validationJournalEntryId: Identifier | null;
  items: SupplierCreditNoteItem[];
  allocations: SupplierCreditAllocation[];
  createdAt: string;
  updatedAt: string;
};

export type SupplierExpenseReclassificationLine = {
  id: Identifier;
  reclassificationId: Identifier;
  supplierInvoiceItemId: Identifier;
  oldExpenseAccountId: Identifier | null;
  newExpenseAccountId: Identifier;
  amountCents: number;
  projectId: Identifier | null;
  createdAt: string;
};

export type SupplierExpenseReclassification = {
  id: Identifier;
  supplierInvoiceId: Identifier;
  requestId: string;
  effectiveDate: string;
  reason: string;
  journalEntryId: Identifier;
  createdAt: string;
  lines: SupplierExpenseReclassificationLine[];
};

export type Supplier = {
  id: Identifier;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  uidNumber: string;
  iban: string;
  currency: string;
  paymentTermsDays: number;
  notes: string;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BankSuggestionKind =
  | 'automatic_exact'
  | 'automatic_partial'
  | 'manual'
  | 'review'
  | 'none';

export type BankReconciliationCandidate = {
  invoiceId: Identifier;
  invoiceNumber: string;
  remainingCents: number;
  amountRelation: string;
  reason: string;
  confirmable: boolean;
};

export type BankReconciliationSuggestion = {
  kind: BankSuggestionKind;
  invoiceId: Identifier | null;
  invoiceNumber: string | null;
  reason: string;
  confirmable: boolean;
  candidates: BankReconciliationCandidate[];
};

export type BankReconciliation = {
  id: Identifier;
  movementId: Identifier;
  invoiceId: Identifier;
  paymentId: Identifier;
  amountCents: number;
  confirmedAt: string;
  createdAt: string;
};

export type BankSupplierSuggestionKind =
  | 'supplier_match'
  | 'supplier_manual'
  | 'review'
  | 'none';

export type BankSupplierReconciliationCandidate = {
  supplierInvoiceId: Identifier;
  supplierId: Identifier;
  supplierName: string;
  supplierIban: string;
  reference: string;
  documentDate: string;
  remainingCents: number;
  amountRelation: string;
  matchKind: string;
  reason: string;
  confirmable: boolean;
};

export type BankSupplierReconciliationSuggestion = {
  entityType: 'supplier_invoice';
  kind: BankSupplierSuggestionKind;
  supplierInvoiceId: Identifier | null;
  reason: string;
  confirmable: boolean;
  requiresConfirmation: boolean;
  candidates: BankSupplierReconciliationCandidate[];
};

export type BankSupplierReconciliation = {
  id: Identifier;
  movementId: Identifier;
  supplierInvoiceId: Identifier;
  supplierPaymentId: Identifier;
  amountCents: number;
  confirmedAt: string;
  createdAt: string;
};

export type BankMovement = {
  id: Identifier;
  importId: Identifier;
  accountId: string;
  accountCurrency: string;
  amountCents: number;
  currency: string;
  creditDebit: string;
  status: string;
  reversal: boolean;
  bookingDate: string;
  valueDate: string;
  accountServicerRef: string;
  endToEndId: string;
  transactionId: string;
  referenceType: string;
  referenceLevel: string;
  reference: string;
  unstructured: string;
  counterpartyName: string;
  counterpartyIban: string;
  strongKey: string;
  createdAt: string;
  reconciliation: BankReconciliation | null;
  supplierReconciliation: BankSupplierReconciliation | null;
  suggestion: BankReconciliationSuggestion;
  supplierSuggestion: BankSupplierReconciliationSuggestion;
};

export type BankImport = {
  id: Identifier;
  sourceName: string;
  fileSha256: string;
  fileSize: number;
  messageType: string;
  namespaceVersion: string;
  accountId: string;
  accountCurrency: string;
  entryCount: number;
  importedCount: number;
  ignoredCount: number;
  createdAt: string;
};

export type BankAccountLink = {
  accountId: string;
  currency: string;
  linked: boolean;
  linkSource: 'settings_iban' | 'explicit' | 'unlinked';
  movementCount: number;
};

export type BankWorkspace = {
  summary: {
    importCount: number;
    movementCount: number;
    unreconciledCount: number;
    unreconciledSupplierCount: number;
    pendingCount: number;
    bookedCreditCount: number;
    bookedDebitCount: number;
  };
  accounts: BankAccountLink[];
  imports: BankImport[];
  movements: BankMovement[];
  reconciliations: BankReconciliation[];
  supplierReconciliations: BankSupplierReconciliation[];
};

export type CamtImportResult = {
  duplicate: boolean;
  import: BankImport;
  importedCount: number;
  skippedDuplicateCount: number;
  ignoredCount: number;
  warnings: string[];
};

export type BankReconciliationResult = {
  movement: BankMovement;
  reconciliation: BankReconciliation;
  payment: Payment;
  invoice: Pick<Invoice, 'id' | 'number' | 'status'>;
};

export type BankSupplierReconciliationResult = {
  movement: BankMovement;
  supplierReconciliation: BankSupplierReconciliation;
  payment: SupplierInvoicePayment;
  supplierInvoice: Pick<
    SupplierInvoice,
    | 'id'
    | 'supplierId'
    | 'reference'
    | 'documentStatus'
    | 'totalCents'
    | 'paidCents'
    | 'balanceCents'
  >;
  idempotent: boolean;
};

export type PayslipLine = {
  id: Identifier;
  label: string;
  kind: 'earning' | 'deduction' | 'reimbursement' | 'employer';
  amountCents: number;
  postingAccountId?: string;
  expenseAccountId?: string;
};

export type Payslip = {
  id: Identifier;
  employeeId: Identifier;
  period: string;
  status: 'incomplete' | 'draft' | 'validated' | 'posted' | 'paid';
  lines: PayslipLine[];
  paymentDate: string;
  paymentReference?: string;
  paymentJournalEntryId?: string;
  notes: string;
  createdAt: string;
  snapshot?: FrozenPayslipSnapshot | null;
};

export type FrozenEmployee = {
  id: Identifier;
  employeeNumber: string;
  name: string;
  role: string;
  address: string;
  avsNumber: string;
  iban: string;
  employmentRate: number;
};

export type FrozenPayslipSnapshot = {
  capturedAt: string;
  issuer: FrozenIssuer;
  employee: FrozenEmployee;
  period: string;
  paymentDate: string;
  notes: string;
  items: PayslipLine[];
  contributions: PayslipContributionSnapshot[];
};

export type PayrollImportEmployeeDraft = {
  employeeNumber: string;
  name: string;
  role: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  canton: string;
  birthDate: string;
  avsNumber: string;
  iban: string;
  employmentRate: number;
  salaryMode: 'monthly' | 'hourly';
};

export type PayrollImportLineDraft = {
  id: Identifier;
  label: string;
  kind: PayslipLine['kind'];
  amountCents: number;
  recurring: boolean;
  confidenceBp: number;
};

export type PayrollImportDraft = {
  employee: PayrollImportEmployeeDraft;
  period: string;
  paymentDate: string;
  grossCents: number;
  netCents: number;
  lines: PayrollImportLineDraft[];
  warnings: string[];
  review?: PayrollImportReviewState;
};

export type PayrollAiIdentityEvidence = {
  passes: number;
  employeeNumber: string;
  avsNumber: string;
  birthDate: string;
  iban: string;
  conflicts: string[];
};

export type PayrollImportReviewState = {
  aiIdentityEvidence?: PayrollAiIdentityEvidence;
  employeeId: Identifier;
  employeeLinkSource: 'auto' | 'manual' | '';
};

export type PayrollDocumentImport = {
  id: Identifier;
  sourceName: string;
  storedPath: string;
  fileSha256: string;
  mediaKind: 'pdf' | 'image';
  fileSize: number;
  extractionEngine: string;
  engineVersion: string;
  extractedText: string;
  draft: PayrollImportDraft;
  confidenceBp: number;
  status: 'needs_review' | 'confirmed' | 'rejected' | 'error';
  errorMessage: string;
  employeeId: Identifier;
  payslipId: Identifier;
  reviewedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type EmployeePayrollTemplate = {
  employeeId: Identifier;
  salaryMode: 'monthly' | 'hourly';
  baseSalaryCents: number;
  recurringEarnings: Array<{
    label: string;
    kind: 'earning';
    amountCents: number;
  }>;
  suggestedContributionCodes: string[];
  sourceImportId: Identifier;
  reviewedAt: string;
};

export type BackupStatus = {
  lastSuccessAt: string | null;
  lastPath: string | null;
  nextScheduledAt: string | null;
};

export type LicenseState = {
  enforcementConfigured: boolean;
  status:
    | 'not_configured'
    | 'missing'
    | 'invalid'
    | 'clock_error'
    | 'not_yet_valid'
    | 'inactive'
    | 'expired'
    | 'valid';
  readOnly: boolean;
  canRefresh: boolean;
  plan: string;
  priceChfCents: number;
  licenseId: string;
  customerName: string;
  validFrom: string;
  validUntil: string;
  verifiedAt: string;
  lastSeenDate: string;
  reason: string;
  installationId: string;
  tokenVersion: number;
};

export type Workspace = {
  schemaVersion: number;
  onboardingCompleted: boolean;
  activityProfileRequired: boolean;
  settings: AppSettings | null;
  clients: Client[];
  catalogItems: CatalogItem[];
  stockMovements: StockMovement[];
  suppliers: Supplier[];
  projects: Project[];
  projectMilestones: ProjectMilestone[];
  projectTasks: ProjectTask[];
  quotes: Quote[];
  salesOrders: SalesOrder[];
  deliveryNotes: DeliveryNote[];
  stockReservationEvents: StockReservationEvent[];
  stockAvailability: StockAvailability[];
  salesOrderInvoiceBatches: SalesOrderInvoiceBatch[];
  salesOrderInvoiceAllocations: SalesOrderInvoiceAllocation[];
  invoices: Invoice[];
  payments: Payment[];
  employees: Employee[];
  timeEntries: TimeEntry[];
  timeBillingBatches: TimeBillingBatch[];
  timeBillingEntries: TimeBillingEntry[];
  activeTimer: ActiveTimer;
  expenses: Expense[];
  supplierOrders: SupplierOrder[];
  supplierOrderCancellationLines: SupplierOrderCancellationLine[];
  supplierReceipts: SupplierReceipt[];
  supplierInvoices: SupplierInvoice[];
  supplierInvoicePayments: SupplierInvoicePayment[];
  supplierInvoiceMatches: SupplierInvoiceMatch[];
  supplierCreditNotes: SupplierCreditNote[];
  supplierExpenseReclassifications: SupplierExpenseReclassification[];
  payslips: Payslip[];
  payrollImports: PayrollDocumentImport[];
  employeePayrollTemplates: EmployeePayrollTemplate[];
  accountingSettings: AccountingSettings | null;
  backupStatus: BackupStatus;
};

export type OnboardingPayload = AppSettings;

export type MutationResponse = {
  workspace: Workspace;
  message?: string;
};

export type RestorePreview = {
  path: string;
  organizationName: string;
  createdAt: string;
  clientsCount: number;
  projectsCount: number;
  documentsCount: number;
};

export type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'expense';
export type NormalBalance = 'debit' | 'credit';
export type ReportSection =
  | 'current_assets'
  | 'fixed_assets'
  | 'short_term_liabilities'
  | 'long_term_liabilities'
  | 'equity'
  | 'net_revenue'
  | 'cost_of_goods'
  | 'personnel_expense'
  | 'other_operating_expense'
  | 'depreciation'
  | 'financial_result'
  | 'non_operating_result'
  | 'exceptional_result'
  | 'taxes';

export type Account = {
  id: Identifier;
  code: string;
  name: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  reportSection: ReportSection;
  active: boolean;
};

export type AccountingSettings = {
  enabled: boolean;
  arAccountId: string;
  revenueAccountId: string;
  vatPayableAccountId: string;
  bankAccountId: string;
  expenseAccountId: string;
  vatReceivableAccountId: string;
  wagesExpenseAccountId: string;
  wagesPayableAccountId: string;
  socialExpenseAccountId: string;
  socialPayableAccountId: string;
  supplierPayableAccountId: string;
};

export type AccountingContinuity = {
  enabled: boolean;
  mappingReady: boolean;
  starterAvailable: boolean;
  journalEntryCount: number;
  missingInvoices: number;
  missingPayments: number;
  missingExpenses: number;
  missingSupplierInvoices: number;
  missingSupplierPayments: number;
  missingPayslips: number;
  missingPayslipPayments: number;
  undatedPayslipPayments: number;
  payslipPaymentLinksMissing: number;
  totalMissing: number;
  closedHistoryRequiresOpening: number;
  skippedCancelledInvoices: number;
  cancelledInvoicePayments: number;
  reversedSources: number;
  cancelledActivePostings: number;
  semanticPostingMismatches: number;
  totalAnomalies: number;
};

export type AccountingSynchronization = {
  createdTotal: number;
  createdInvoices: number;
  createdPayments: number;
  createdExpenses: number;
  createdPayslips: number;
  createdPayslipPayments: number;
  skippedClosedHistory: number;
  requiresOpeningBalanceReview: boolean;
  remaining: AccountingContinuity;
};

export type AccountingConfigurationResult = {
  settings: AccountingSettings;
  synchronization: AccountingSynchronization;
};

export type AccountingFallback = {
  contribution: string;
  field: string;
  accountId: Identifier;
  reason: string;
};

export type PostPayslipResult = {
  workspace: Workspace;
  accountingFallbacks: AccountingFallback[];
};

export type PeriodFilter = { dateFrom?: string; dateTo?: string };
export type AccountingPeriod = {
  id: Identifier;
  name: string;
  dateFrom: string;
  dateTo: string;
  status: 'open' | 'closed';
  closedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type JournalEntry = {
  id: Identifier;
  number: string;
  entryDate: string;
  description: string;
  sourceType: string;
  sourceId: string;
  sourceEvent: string;
  status: 'posted';
  reversalOf: Identifier | null;
  hasReversal: boolean;
};

export type JournalLine = {
  id: Identifier;
  journalEntryId: Identifier;
  accountId: Identifier;
  accountCode: string;
  accountName: string;
  entryNumber: string;
  entryDate: string;
  debitCents: number;
  creditCents: number;
  currency: string;
  memo: string;
  projectId: Identifier | null;
  clientId: Identifier | null;
  employeeId: Identifier | null;
};

export type JournalReport = { entries: JournalEntry[]; lines: JournalLine[] };
export type LedgerReport = {
  account: Account;
  lines: JournalLine[];
  debitCents: number;
  creditCents: number;
  netDebitCents: number;
};

export type TrialBalanceRow = Account & {
  debitCents: number;
  creditCents: number;
  debitBalanceCents: number;
  creditBalanceCents: number;
};
export type TrialBalanceReport = {
  rows: TrialBalanceRow[];
  debitCents: number;
  creditCents: number;
  balanced: boolean;
};

export type StatementScope = {
  dateFrom: string;
  dateTo: string;
  previousDateFrom: string;
  previousDateTo: string;
  comparisonLabel: string;
  comparisonSource: 'registered_period' | 'same_dates_previous_year';
  previousHasActivity: boolean;
};
export type ReportCurrency = {
  baseCurrency: string;
  currencies: string[];
  singleCurrency: boolean;
  exchangeRatesApplied: boolean;
};
export type StatementRow = Pick<
  Account,
  'id' | 'code' | 'name' | 'accountType' | 'reportSection'
> & {
  normalBalance?: NormalBalance;
  debitCents: number;
  creditCents: number;
  amountCents: number;
  previousDebitCents: number;
  previousCreditCents: number;
  previousAmountCents: number;
};
export type BalanceSheetReport = {
  asOf: string;
  exerciseFrom: string;
  scope: StatementScope;
  currency: ReportCurrency;
  rows: StatementRow[];
  sections: Partial<Record<ReportSection, number>>;
  previousSections: Partial<Record<ReportSection, number>>;
  assetsCents: number;
  liabilitiesCents: number;
  equityCents: number;
  currentResultCents: number;
  unallocatedPriorResultsCents: number;
  balanced: boolean;
  previousAssetsCents: number;
  previousLiabilitiesCents: number;
  previousEquityCents: number;
  previousCurrentResultCents: number;
  previousUnallocatedPriorResultsCents: number;
  previousBalanced: boolean;
};
export type IncomeStatementReport = {
  scope: StatementScope;
  currency: ReportCurrency;
  rows: StatementRow[];
  sections: Partial<Record<ReportSection, number>>;
  previousSections: Partial<Record<ReportSection, number>>;
  revenueCents: number;
  expenseCents: number;
  profitCents: number;
  previousRevenueCents: number;
  previousExpenseCents: number;
  previousProfitCents: number;
};

export type FiduciaryAttachmentIssue = {
  attachmentId: Identifier;
  originalName: string;
  issue: string;
};

export type FiduciaryClosingReview = {
  schema: 'elyko.fiduciary-pre-closing.v1';
  reviewId: Identifier;
  preparedAt: string;
  period: AccountingPeriod;
  sourceSha256: string;
  packageStatusIfExported: 'DRAFT' | 'FINAL';
  checks: {
    readyForFinal: boolean;
    journalBalanced: boolean;
    balanceSheetBalanced: boolean;
    auditChainValid: boolean;
    attachmentsTotal: number;
    attachmentsVerified: number;
    attachmentIssues: FiduciaryAttachmentIssue[];
    continuity: AccountingContinuity;
  };
  summary: {
    journalEntries: number;
    journalLines: number;
    accountsWithActivity: number;
    debitCents: number;
    creditCents: number;
    profitCents: number;
    assetsCents: number;
    liabilitiesCents: number;
    equityCents: number;
  };
  disclaimer: string;
};

export type FiduciaryPackageExport = {
  schema: 'elyko.fiduciary-package-export.v1';
  exportId: Identifier;
  reviewId: Identifier;
  createdAt: string;
  period: AccountingPeriod;
  packageStatus: 'DRAFT' | 'FINAL';
  sourceSha256: string;
  manifestSha256: string;
  fileName: string;
  path: string;
  fileCount: number;
  disclaimer: string;
};

export type FiduciaryPeriodFinalization = {
  schema: 'elyko.fiduciary-period-finalization.v1';
  reviewId: Identifier;
  sourceSha256: string;
  period: AccountingPeriod;
};

export type VatReportingMethod = 'effective' | 'simple_tax_rate';
export type VatReportingBasis = 'agreed' | 'received';
export type VatReportingPeriodicity =
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual';
export type VatSubmissionType =
  | 'initial'
  | 'correction'
  | 'annual_reconciliation';
export type VatSourceType =
  | 'invoice_item'
  | 'supplier_invoice_item'
  | 'expense';
export type VatSourceTreatment =
  | 'taxable'
  | 'supplies_to_foreign'
  | 'supplies_abroad'
  | 'transfer_notification'
  | 'exempt'
  | 'out_of_scope'
  | 'opted'
  | 'input_materials'
  | 'input_investments'
  | 'non_deductible';
export type VatAdjustmentCategory =
  | 'supplies_to_foreign'
  | 'supplies_abroad'
  | 'transfer_notification'
  | 'supplies_exempt'
  | 'reduction_of_consideration'
  | 'various_deduction'
  | 'opted'
  | 'acquisition_tax'
  | 'input_materials'
  | 'input_investments'
  | 'subsequent_input_tax'
  | 'input_tax_corrections'
  | 'input_tax_reductions'
  | 'subsidies'
  | 'donations';

export type VatProfile = {
  id: Identifier;
  effectiveFrom: string;
  effectiveTo: string | null;
  reportingMethod: VatReportingMethod;
  formOfReporting: VatReportingBasis;
  periodicity: VatReportingPeriodicity;
  grossOrNet: 'net' | 'gross';
  tdfnActivityId: string | null;
  tdfnRateBp: number | null;
  afcAuthorizationConfirmed: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type VatSourceClassification = {
  id: Identifier;
  sourceType: VatSourceType;
  sourceId: Identifier;
  treatment: VatSourceTreatment;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type VatAdjustment = {
  sequence: number;
  id: Identifier;
  adjustmentDate: string;
  category: VatAdjustmentCategory;
  amountCents: number;
  taxRateBp: number | null;
  description: string;
  evidenceReference: string;
  reversesAdjustmentId: Identifier | null;
  createdBy: string;
  createdAt: string;
};

export type VatBlockingIssue = {
  code: string;
  message: string;
  sourceType: VatSourceType | null;
  sourceId: Identifier | null;
};

export type VatUnclassifiedSource = {
  sourceType: VatSourceType;
  sourceId: Identifier;
  parentId: Identifier;
  occurrenceDate: string;
  description: string;
  amountCents: number;
  vatCents: number;
  vatRateBp: number | null;
};

export type VatRateLine = {
  taxRateBp: number;
  turnoverCents: number;
  calculatedTaxCents: number;
  activityId?: string;
};

export type VatReturnPreview = {
  standard: 'eCH-0217';
  standardVersion: '2.0.0';
  currency: 'CHF';
  profile: VatProfile;
  dateFrom: string;
  dateTo: string;
  submissionType: VatSubmissionType;
  exportable: boolean;
  blockingIssues: VatBlockingIssue[];
  warnings: string[];
  unclassifiedSources: VatUnclassifiedSource[];
  sourceSha256: string;
  turnoverComputation: {
    totalConsiderationCents: number;
    suppliesToForeignCountriesCents: number;
    suppliesAbroadCents: number;
    transferNotificationProcedureCents: number;
    suppliesExemptFromTaxCents: number;
    reductionOfConsiderationCents: number;
    variousDeduction: { amountCents: number; description: string } | null;
    taxableTurnoverCents: number;
  };
  effectiveReportingMethod: {
    grossOrNet: 'net' | 'gross';
    grossOrNetCode: number;
    optedCents: number;
    suppliesPerTaxRate: VatRateLine[];
    acquisitionTax: VatRateLine[];
    inputTaxMaterialAndServicesCents: number;
    inputTaxInvestmentsCents: number;
    subsequentInputTaxDeductionCents: number;
    inputTaxCorrectionsCents: number;
    inputTaxReductionsCents: number;
    outputTaxCents: number;
    acquisitionTaxCents: number;
  } | null;
  simpleTaxRateMethod: {
    suppliesPerTaxRate: VatRateLine[];
    acquisitionTax: VatRateLine[];
    inputTaxCorrectionsCents: number;
    outputTaxCents: number;
    acquisitionTaxCents: number;
  } | null;
  payableTaxCents: number;
  payableCode: '500' | '510';
  otherFlowsOfFunds: { subsidiesCents: number; donationsCents: number };
  sourceCount: number;
  adjustmentCount: number;
  transmissionWording: string;
};

export type VatReturnExport = {
  sequence: number;
  id: Identifier;
  profileId: Identifier;
  dateFrom: string;
  dateTo: string;
  submissionType: VatSubmissionType;
  sourceSha256: string;
  payload: VatReturnPreview;
  xmlSha256: string;
  fileName: string;
  filePath: string;
  createdAt: string;
  transmissionStatus: 'not_transmitted';
  transmissionWording: string;
};

export type ReminderSettings = { enabled: boolean; senderName: string };
export type ReminderTemplate = {
  id: Identifier;
  level: number;
  name: string;
  subject: string;
  body: string;
  daysAfterDue: number;
  active: boolean;
};
export type ReminderStatus = 'planned' | 'due' | 'completed' | 'cancelled';
export type Reminder = {
  id: Identifier;
  invoiceId: Identifier;
  templateId: Identifier | null;
  level: number;
  scheduledDate: string;
  status: ReminderStatus;
  subject: string;
  body: string;
  notes: string;
  invoiceNumber?: string;
  invoiceTitle?: string;
  dueDate?: string;
  clientName?: string;
  currency: string;
  invoiceTotalCents: number;
  balanceCents: number;
};
export type ReminderHistory = {
  id: Identifier;
  reminderId: Identifier;
  action: string;
  occurredAt: string;
  note: string;
};

export type ContributionCategory =
  | 'avs_ai_apg'
  | 'ac'
  | 'lpp'
  | 'aanp'
  | 'aap'
  | 'ijm'
  | 'family_allowance'
  | 'source_tax'
  | 'other';
export type PayrollContributionDefinition = {
  id: Identifier;
  code: string;
  label: string;
  category: ContributionCategory;
  side: 'employee' | 'employer';
  calculationKind: 'rate' | 'fixed';
  rateBp: number | null;
  fixedAmountCents: number | null;
  annualCeilingCents: number | null;
  basisKind: 'gross' | 'ahv_salary' | 'coordinated' | 'custom';
  source: string;
  effectiveFrom: string;
  effectiveTo: string;
  active: boolean;
  liabilityAccountId: string;
  expenseAccountId: string;
};
export type PayrollContributionSelection = {
  definitionId: Identifier;
  basisCents?: number;
  yearToDateBasisCents?: number;
};
export type CalculatedPayrollContribution = PayrollContributionDefinition & {
  basisCents: number;
  originalBasisCents: number;
  yearToDateBasisCents: number | null;
  amountCents: number;
  statutoryAnnualCeilingCents: number | null;
  acProrationDays: number | null;
  acEmploymentFrom: string;
  acEmploymentTo: string;
  avsAllowanceAppliedCents: number | null;
  avsAllowanceWaived: boolean | null;
};
export type PayrollCalculation = {
  period: string;
  grossCents: number;
  employeeDeductionsCents: number;
  employerCostsCents: number;
  items: CalculatedPayrollContribution[];
};
export type PayrollRegulatoryProfile = {
  id: string;
  label: string;
  source: string;
  effectiveFrom: string;
  effectiveTo: string;
  definitions: Array<
    Omit<
      PayrollContributionDefinition,
      'id' | 'liabilityAccountId' | 'expenseAccountId'
    >
  >;
  notIncluded: ContributionCategory[];
};
export type PayslipContributionSnapshot = {
  id: Identifier;
  payslipId: Identifier;
  definitionId: Identifier;
  payslipItemId: Identifier;
  label: string;
  category: ContributionCategory;
  side: 'employee' | 'employer';
  calculationKind: 'rate' | 'fixed';
  basisKind: PayrollContributionDefinition['basisKind'];
  basisCents: number;
  yearToDateBasisCents: number | null;
  rateBp: number | null;
  fixedAmountCents: number | null;
  annualCeilingCents: number | null;
  amountCents: number;
  source: string;
  effectiveFrom: string;
  effectiveTo: string;
  liabilityAccountId: string;
  expenseAccountId: string;
  createdAt: string;
};

export type SwissQrParty = {
  name: string;
  street: string;
  buildingNumber: string;
  postalCode: string;
  city: string;
  country: string;
};
export type SwissQrBillInput = {
  iban: string;
  creditor: SwissQrParty;
  amountCents?: number;
  currency: 'CHF' | 'EUR';
  debtor?: SwissQrParty;
  referenceType: 'QRR' | 'SCOR' | 'NON';
  reference: string;
  unstructuredMessage: string;
  billInformation: string;
  alternativeProcedures: string[];
};
export type SwissQrValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  normalized: SwissQrBillInput;
  isQrIban: boolean;
};
export type SwissQrPayload = {
  payload: string;
  lines: string[];
  referenceType: SwissQrBillInput['referenceType'];
  isQrIban: boolean;
  characterCount: number;
  byteCount: number;
};
export type StoredSwissQrBill = SwissQrPayload & {
  invoiceId: Identifier;
  input: SwissQrBillInput;
  frozenAt: string;
  createdAt: string;
  updatedAt: string;
  frozen: boolean;
};

export type SecureUpdaterPolicy = {
  enabled: boolean;
  currentVersion: string;
  channel: 'stable';
  endpointHost: string | null;
  signatureRequired: true;
  transport: 'HTTPS';
  automaticInstall: false;
  reason: string;
};

export type SecureUpdateMetadata = {
  version: string;
  currentVersion: string;
  date: string | null;
  notes: string | null;
};

export type SecureUpdateEvent =
  | { event: 'preparing' }
  | { event: 'started'; data: { contentLength: number | null } }
  | {
      event: 'progress';
      data: {
        downloadedBytes: number;
        contentLength: number | null;
        percent: number | null;
      };
    }
  | { event: 'verifying' }
  | { event: 'installed' };
