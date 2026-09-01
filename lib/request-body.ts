export class RequestBodyError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413 | 415,
  ) {
    super(message);
  }
}

function assertDeclaredLength(request: Request, maxBytes: number) {
  const declared = request.headers.get('Content-Length');
  if (!declared) return;
  if (!/^\d+$/.test(declared)) {
    throw new RequestBodyError('Longueur de requête invalide.', 400);
  }
  if (Number(declared) > maxBytes) {
    throw new RequestBodyError('Requête trop volumineuse.', 413);
  }
}

export async function readTextBodyWithinLimit(
  request: Request,
  maxBytes: number,
) {
  assertDeclaredLength(request, maxBytes);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new RequestBodyError('Requête trop volumineuse.', 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBodyError('Encodage de requête invalide.', 400);
  }
}

export async function readJsonObjectWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const contentType =
    request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ??
    '';
  if (contentType !== 'application/json') {
    throw new RequestBodyError('Le corps doit être au format JSON.', 415);
  }
  const rawBody = await readTextBodyWithinLimit(request, maxBytes);
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new RequestBodyError('Requête JSON invalide.', 400);
  }
}
