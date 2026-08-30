import { issueOwnerTestLicense } from '@/lib/license-token';
import { runtimeValue } from '@/lib/runtime';
import { jsonError, noStoreHeaders, PublicError } from '@/lib/stripe';

export const dynamic = 'force-dynamic';

async function digest(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function POST(request: Request) {
  try {
    const expected = runtimeValue('OWNER_TEST_LICENSE_SECRET');
    const expectedInstallationId = runtimeValue('OWNER_TEST_INSTALLATION_ID');
    const supplied = request.headers.get('x-elyko-owner-secret')?.trim() ?? '';
    if (
      !expected ||
      !supplied ||
      !constantTimeEqual(await digest(supplied), await digest(expected))
    ) {
      throw new PublicError('Accès refusé.', 403);
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 1_024)
      throw new PublicError('Requête trop volumineuse.');
    const body = JSON.parse(rawBody) as { installationId?: unknown };
    const installationId =
      typeof body.installationId === 'string' ? body.installationId.trim() : '';
    if (
      !expectedInstallationId ||
      !constantTimeEqual(
        await digest(installationId),
        await digest(expectedInstallationId),
      )
    ) {
      throw new PublicError('Accès refusé.', 403);
    }
    const license = await issueOwnerTestLicense(installationId);
    return Response.json(license, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error);
  }
}
