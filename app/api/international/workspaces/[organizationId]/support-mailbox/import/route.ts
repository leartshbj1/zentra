import { usSupportMailImportHandler } from '@/lib/international/us-support-mailbox-import-bindings';

type Context = { params: Promise<{ organizationId: string }> };
export async function POST(request: Request,context: Context) { return usSupportMailImportHandler(request,(await context.params).organizationId); }
