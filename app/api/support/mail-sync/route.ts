import { runMailSync } from '@/lib/support/mail-sync';
import { supportError, supportJson } from '@/lib/support/service';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    return supportJson(await runMailSync(request));
  } catch (error) {
    return supportError(error);
  }
}
