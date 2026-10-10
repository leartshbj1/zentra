import { afterEach,describe,expect,it,vi } from 'vitest';
import { usSupportMailImportEnabled } from './us-support-mailbox-import-bindings';

const runtime=vi.hoisted(()=>({env:{} as Record<string,string>}));
vi.mock('cloudflare:workers',()=>({env:runtime.env}));
afterEach(()=>{for(const key of Object.keys(runtime.env))delete runtime.env[key];});
describe('US mail-to-originals readiness, no hosted bindings used',()=>{
  it('defaults closed and requires every independent country/module/protocol gate',async()=>{
    expect(await usSupportMailImportEnabled()).toBe(false);
    const keys=['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_SUPPORT_WORKSPACES_ENABLED','INTERNATIONAL_US_SUPPORT_MAILBOX_ENABLED','INTERNATIONAL_US_SUPPORT_MAIL_IMPORT_ENABLED','INTERNATIONAL_US_SUPPLIER_DOCUMENTS_ENABLED','INTERNATIONAL_US_PURCHASING_V2_ENABLED','INTERNATIONAL_US_PROJECTS_V3_ENABLED','INTERNATIONAL_US_ACCOUNTING_V4_ENABLED'];
    for(const key of keys)runtime.env[key]='true';
    expect(await usSupportMailImportEnabled()).toBe(true);
    for(const key of keys){delete runtime.env[key];expect(await usSupportMailImportEnabled()).toBe(false);runtime.env[key]='true';}
    runtime.env.INTERNATIONAL_US_SUPPORT_MAIL_IMPORT_ENABLED='TRUE';expect(await usSupportMailImportEnabled()).toBe(false);
  });
});
