import { erpServerDependencies, usPurchasingSchemaVersion } from './runtime-bindings';
import { usSupplierDocumentsReadiness } from './us-supplier-document-bindings';
import { createSupabaseUsSupplierDocumentStore } from './us-supplier-document-store';
import { findUsSupplierDocumentByHash } from './us-supplier-document-lookup';
import { usSupportMailboxEnabled, usSupportMailboxMember } from './us-support-mailbox-bindings';
import { d1UsMailboxStore } from './us-support-mailbox-d1';
import { d1UsMailboxImportStore } from './us-support-mailbox-import-d1';
import { createUsMailboxImportProvider } from './us-support-mailbox-import-provider';
import { createUsMailboxImportHandler } from './us-support-mailbox-import-server';

export async function usSupportMailImportEnabled(): Promise<boolean> {
  try {
    if (!await usSupportMailboxEnabled() || !await usSupplierDocumentsReadiness()) return false;
    const { env } = await import('cloudflare:workers');
    return (env as unknown as Record<string,string|undefined>).INTERNATIONAL_US_SUPPORT_MAIL_IMPORT_ENABLED === 'true'
      && await usSupportMailboxEnabled() && await usSupplierDocumentsReadiness();
  } catch { return false; }
}
export const usSupportMailImportHandler = createUsMailboxImportHandler({
  enabled:usSupportMailImportEnabled, now:() => Math.floor(Date.now()/1000), member:usSupportMailboxMember,
  configuration:actor => erpServerDependencies.configuration(actor), store:capability => erpServerDependencies.store(capability), freshSupportedSchemaVersion:usPurchasingSchemaVersion,
  async mailboxStore() { return d1UsMailboxStore((await import('../runtime')).database()); },
  async importStore() { return d1UsMailboxImportStore((await import('../runtime')).database()); },
  async documentStore() { return createSupabaseUsSupplierDocumentStore((await import('../supabase-server-runtime')).supabaseServerClient(),{supportedSchemaVersion:await usPurchasingSchemaVersion(4)}); },
  async findDocument(actor,hash) { return findUsSupplierDocumentByHash((await import('../supabase-server-runtime')).supabaseServerClient(),actor,hash); },
  async archive() { return (await import('../runtime')).fileArchive(); },
  async encryptionKey() { return (await import('../runtime')).runtimeValue('SUPPORT_ENCRYPTION_KEY'); },
  attachment:createUsMailboxImportProvider(),
  async rateLimit(request,key) { await (await import('../account')).enforceAccountRateLimit(request,'international-us-support-mail-import',key,30); },
  diagnostic(event) { console.warn('zentra.international.us-support-mail-import',event); },
});
