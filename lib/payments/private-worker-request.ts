import { readJsonObjectWithinLimit } from '@/lib/request-body';

/** pg_net sends {} for a POST. Accept that envelope, never job arguments.
 * Call only after checking the private worker credential. */
export async function isPrivateWorkerRequest(
  request: Request,
): Promise<boolean> {
  if (request.method !== 'POST' || new URL(request.url).search) return false;
  if (request.body === null) {
    const length = request.headers.get('Content-Length');
    return length === null || length === '0';
  }
  try {
    return (
      Object.keys(await readJsonObjectWithinLimit(request, 64)).length === 0
    );
  } catch {
    return false;
  }
}
