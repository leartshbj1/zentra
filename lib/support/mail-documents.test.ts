import { beforeEach, expect, it, vi } from 'vitest';
import { prepareMailDocuments, mailAnalysisBody } from './mail-documents';
import { invoiceText } from '@/lib/supplier-inbox/documents';
import type { SourceTicket } from './types';
vi.mock('@/lib/supplier-inbox/documents', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/supplier-inbox/documents')>(),
  invoiceText: vi.fn(),
}));
const pdf = new TextEncoder().encode('%PDF-1.4 synthetic fixture');
const text = 'Fournisseur Acme SA\nFACTURE\nN° INV-12345\nTotal CHF 108.10';
const source = (): SourceTicket => ({
  externalId:'mail_1', subject:'Votre facture', body:'Veuillez trouver la facture jointe.', version:'1', groupId:null, agentId:null, closed:false, incomplete:true,
  mail:{sender:'vendor@example.test',attachments:[{id:'1:0',name:'facture.pdf',size:pdf.length}],attachmentCount:1,bodyIncomplete:false},
});
beforeEach(() => { vi.mocked(invoiceText).mockReset().mockResolvedValue(text); });
it('includes readable PDF content for Jev and reuses the same bytes/text for Gestion', async () => {
  const read=vi.fn().mockResolvedValue(pdf);
  const result=await prepareMailDocuments(source(),read);
  expect(result.source.incomplete).toBe(false);
  expect(result.source.body).toBe(source().body);
  expect(mailAnalysisBody(result.source)).toContain('N° INV-12345');
  expect(result.documents.get('1:0')).toEqual({bytes:pdf,media:'application/pdf',text});
  expect(read).toHaveBeenCalledTimes(1);
});
it('keeps scans, failed reads and unsupported attachments for human review', async () => {
  vi.mocked(invoiceText).mockResolvedValue('');
  expect((await prepareMailDocuments(source(),async()=>pdf)).source.incomplete).toBe(true);
  expect((await prepareMailDocuments(source(),async()=>{throw Error('private');})).source.incompleteReason).not.toContain('private');
  vi.mocked(invoiceText).mockResolvedValue(text);
  const extra=source();extra.mail!.attachmentCount=2;
  expect((await prepareMailDocuments(extra,async()=>pdf)).source.incomplete).toBe(true);
});
it('does not silently truncate documents or large mail bodies and caps attachment reads', async () => {
  const long=source();long.body='x'.repeat(22990);
  const result=await prepareMailDocuments(long,async()=>pdf);
  expect(result.source.incomplete).toBe(true);
  expect(result.source.mail!.analysisText!.length).toBeLessThanOrEqual(10);
  const many=source();many.mail!.attachments=Array.from({length:4},(_,i)=>({id:String(i),name:'invoice.pdf',size:pdf.length}));many.mail!.attachmentCount=4;
  const read=vi.fn().mockResolvedValue(pdf);
  expect((await prepareMailDocuments(many,read)).source.incomplete).toBe(true);
  expect(read).toHaveBeenCalledTimes(3);
});
