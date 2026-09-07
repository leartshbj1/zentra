import { createHash } from 'node:crypto';
import { getZentraUser } from '@/app/zentra-auth';
import {
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  membershipsForUser,
} from '@/lib/account';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { downloadBackupChunk, getBackup } from '@/lib/workspace-backup';

// Recovery depends on a current, non-revoked membership, not a paid seat or
// the lost computer's device session. Keep this policy out of write routes.
export async function recoveryMembership(
  userId: string,
  organizationId: string,
) {
  const memberships = await membershipsForUser(userId);
  const membership = memberships.find(
    (item) =>
      item.organizationId === organizationId &&
      ['owner', 'admin'].includes(item.role),
  );
  if (!membership) {
    throw new AccountPublicError(
      'Cette sauvegarde est inaccessible à votre compte.',
      403,
    );
  }
  return membership;
}

export async function recoverySession(request: Request) {
  const user = await getZentraUser({ refreshSession: true });
  if (!user)
    throw new AccountPublicError(
      'Connectez-vous pour récupérer une sauvegarde.',
      401,
    );
  const organizationId =
    new URL(request.url).searchParams.get('organizationId') ?? '';
  const membership = await recoveryMembership(user.userId, organizationId);
  await enforceAccountRateLimit(
    request,
    'backup-recovery',
    `${user.userId}:${organizationId}`,
    120,
  );
  return membership;
}

export async function recoveryDownload(organizationId: string, id: string) {
  const backup = await getBackup(organizationId, id);
  const { manifest } = backup;
  const hash = createHash('sha256');
  let index = 0;
  let cancelled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  async function verifiedPart(partIndex: number) {
    const { part, object } = await downloadBackupChunk(
      organizationId,
      id,
      partIndex,
    );
    if (object.size !== part.size_bytes) {
      await object.body.cancel();
      throw new AccountPublicError(
        'Un fragment de la sauvegarde est incomplet.',
        503,
      );
    }
    const bytes = new Uint8Array(part.size_bytes);
    let offset = 0;
    reader = object.body.getReader();
    try {
      while (!cancelled) {
        const result = await reader.read();
        if (result.done) break;
        if (offset + result.value.length > bytes.length) {
          await reader.cancel();
          throw new AccountPublicError(
            'Un fragment de la sauvegarde est altéré.',
            503,
          );
        }
        bytes.set(result.value, offset);
        offset += result.value.length;
      }
    } finally {
      reader.releaseLock();
      reader = undefined;
    }
    if (cancelled) return null;
    if (offset !== bytes.length || (await sha256Hex(bytes)) !== part.sha256) {
      throw new AccountPublicError(
        'L’intégrité de la sauvegarde n’a pas pu être confirmée.',
        503,
      );
    }
    hash.update(bytes);
    // Verify the complete digest before exposing the final bytes. A failed
    // transfer must never look like a successfully downloaded complete archive.
    if (
      partIndex === manifest.chunks.length - 1 &&
      hash.digest('hex') !== manifest.sha256
    ) {
      throw new AccountPublicError(
        'L’empreinte globale de la sauvegarde est incohérente.',
        503,
      );
    }
    return bytes;
  }
  // Validate the first part before sending HTTP 200; subsequent failures abort
  // the stream. Memory remains bounded to a small number of 8 MiB parts.
  const first = await verifiedPart(index++);
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (first) controller.enqueue(first);
      },
      async pull(controller) {
        try {
          if (index === manifest.chunks.length) {
            controller.close();
            return;
          }
          const bytes = await verifiedPart(index++);
          if (bytes && !cancelled) controller.enqueue(bytes);
        } catch {
          if (!cancelled)
            controller.error(
              new Error(
                'Le téléchargement de la sauvegarde a été interrompu. Réessayez depuis votre compte.',
              ),
            );
        }
      },
      async cancel() {
        cancelled = true;
        await reader?.cancel();
      },
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers(accountNoStoreHeaders());
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Length', String(manifest.size_bytes));
  headers.set(
    'Content-Disposition',
    `attachment; filename="Zentra-${id}.zentra"`,
  );
  headers.set('X-Zentra-Sha256', manifest.sha256);
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(body, { headers });
}
