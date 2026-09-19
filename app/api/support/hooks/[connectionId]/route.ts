import { receiveHook, supportError } from '@/lib/support/service';
import { waitUntil } from 'cloudflare:workers';
export const dynamic = 'force-dynamic';
async function handle(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
) {
  try {
    const processing = receiveHook(
      request,
      (await context.params).connectionId,
    );
    waitUntil(
      processing.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await processing;
  } catch (error) {
    return supportError(error);
  }
}
export { handle as GET, handle as POST };
