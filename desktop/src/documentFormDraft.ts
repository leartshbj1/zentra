import {validDocumentCreationId,validDocumentCreationRequest,type DocumentCreationRequest} from './documentCreationRequest';
import type { AppSettings, DocumentLine, Invoice, Project, Quote } from './types';
import { addDaysIso, todayIso } from './utils';
import { restoreDepositBaseLines } from './deposit';
import { draftObject, draftStrings } from './formDrafts';
import {documentQuickClientFields as quickFields, validQuickClientCreationId} from './documentQuickClientDraft';

const strings = ['selectedClientId', 'selectedProjectId', 'issueDate', 'dueDate', 'invoiceType', 'depositPercentage', 'serviceDateFrom', 'serviceDateTo', 'originalInvoiceId', 'footerText', 'footerTemplateId', 'footerTemplateName', 'documentTitle', 'documentNotes'] as const;
export type DocumentFormDraft = {
  documentCreationId?:string; documentCreationRequest?:DocumentCreationRequest;
  lines: DocumentLine[]; selectedClientId: string; selectedProjectId: string;
  quickClientCreationId?: string; quickClientOpen: boolean; quickClient: Record<typeof quickFields[number], string>;
  issueDate: string; dueDate: string; invoiceType: Invoice['type'] | ''; depositPercentage: string;
  serviceDateFrom: string; serviceDateTo: string; originalInvoiceId: string;
  footerText: string; footerTemplateId: string; footerTemplateName: string;
  step: number; documentTitle: string; documentNotes: string; numberInputs: Record<string, string>;
};
export function initialDocumentFormDraft(entity: 'quotes' | 'invoices', settings: AppSettings, emptyLineId: string, item?: Quote | Invoice, quoteSource?: Quote, initialProject?: Project, initialStep = 0, quickClientCreationId?: string, documentCreationId?:string): DocumentFormDraft {
  const current = item ?? quoteSource, invoice = entity === 'invoices' ? item as Invoice | undefined : undefined;
  const percentage = invoice?.depositPercentageBp, issueDate = item?.issueDate || todayIso();
  const lines = invoice?.type === 'deposit' && percentage
    ? (invoice.depositBasisLines?.length ? invoice.depositBasisLines : restoreDepositBaseLines(invoice.lines, percentage)).map(line => ({ ...line }))
    : current?.lines.map(line => ({ ...line })) ?? [{ id: emptyLineId, catalogItemId: null, description: '', quantity: 0, unit: '', unitPriceCents: 0, discountBp: 0, vatRateBp: settings.organization.vatRegistered ? -1 : 0 }];
  return {
    ...(documentCreationId===undefined?{}:{documentCreationId}),
    lines, selectedClientId: current?.clientId ?? initialProject?.clientId ?? '', selectedProjectId: current?.projectId ?? initialProject?.id ?? '',
    ...(quickClientCreationId === undefined ? {} : {quickClientCreationId}),
    quickClientOpen: false, quickClient: { contactPerson: '', company: '', email: '', phone: '', street: '', buildingNumber: '', postalCode: '', city: '', canton: '', country: 'CH' },
    issueDate, dueDate: entity === 'quotes' ? (item as Quote | undefined)?.validUntil || addDaysIso(issueDate, settings.billing.quoteValidityDays) : invoice?.dueDate || addDaysIso(issueDate, settings.billing.paymentTermsDays),
    invoiceType: invoice?.type ?? '', depositPercentage: percentage ? String(percentage / 100) : invoice?.type === 'deposit' ? '100' : '30',
    serviceDateFrom: invoice?.serviceDateFrom ?? '', serviceDateTo: invoice?.serviceDateTo ?? '', originalInvoiceId: invoice?.originalInvoiceId ?? '',
    footerText: current?.terms ?? settings.billing.defaultFooter, footerTemplateId: '', footerTemplateName: '', step: initialStep,
    documentTitle: current?.title ?? '', documentNotes: current?.notes ?? '', numberInputs: {},
  };
}
export function validDocumentFormDraft(value: unknown): value is DocumentFormDraft {
  if (!draftStrings(value, strings, 50_000) || !draftObject(value) || Object.keys(value).length !== strings.length + 5 + (Object.hasOwn(value, 'quickClientCreationId') ? 1 : 0) + (Object.hasOwn(value,'documentCreationId')?1:0) + (Object.hasOwn(value,'documentCreationRequest')?1:0) ||
    (Object.hasOwn(value,'documentCreationId') && !validDocumentCreationId(value.documentCreationId)) ||
    (Object.hasOwn(value,'documentCreationRequest') && (!validDocumentCreationRequest(value.documentCreationRequest) || value.documentCreationRequest.creationRequestId!==value.documentCreationId)) ||
    (Object.hasOwn(value, 'quickClientCreationId') && !validQuickClientCreationId(value.quickClientCreationId)) ||
    typeof value.quickClientOpen !== 'boolean' || !draftStrings(value.quickClient, quickFields, 10_000) || Object.keys(value.quickClient).length !== quickFields.length ||
    typeof value.step !== 'number' || !Number.isInteger(value.step) || value.step < 0 || value.step > 3 ||
    !['', 'standard', 'deposit', 'progress', 'final', 'credit_note'].includes(String(value.invoiceType)) ||
    !draftObject(value.numberInputs) || Object.entries(value.numberInputs).some(([key, row]) => key.length > 600 || typeof row !== 'string' || row.length > 64) ||
    !Array.isArray(value.lines) || !value.lines.length || value.lines.length > 500) return false;
  const ids = new Set<string>();
  return value.lines.every(line => {
    if (!draftStrings(line, ['id', 'description', 'unit']) || !draftObject(line) || ids.has(line.id) || !line.id || line.id.length > 500 ||
      Object.keys(line).some(key => !['id', 'catalogItemId', 'description', 'quantity', 'unit', 'unitPriceCents', 'discountBp', 'vatRateBp'].includes(key)) ||
      (line.catalogItemId !== undefined && line.catalogItemId !== null && (typeof line.catalogItemId !== 'string' || line.catalogItemId.length > 500))) return false;
    ids.add(line.id);
    return ['quantity', 'unitPriceCents', 'vatRateBp'].every(field => typeof line[field] === 'number' && Number.isFinite(line[field])) &&
      (line.discountBp === undefined || (typeof line.discountBp === 'number' && Number.isFinite(line.discountBp)));
  });
}
