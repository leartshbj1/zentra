import { runMailSync } from '@/lib/support/mail-sync';
import { supportError, supportJson } from '@/lib/support/service';
import { runDueWorkflows } from '@/lib/automation/workflows';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const result=await runMailSync(request); // Authenticates the scheduler before any workflow is read.
    await runDueWorkflows();
    return supportJson(result);
  } catch (error) {
    return supportError(error);
  }
}
