// Shared server transport for Automation and Support. Product adapters retain
// their own strict response schemas, permissions and operational thresholds.
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export async function jevRequest(
  key: string,
  body: string,
  options: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
    retry?: boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const fetcher = options.fetcher ?? fetch,
    sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(JEV_ENDPOINT, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    });
    if (
      !options.retry ||
      attempt > 0 ||
      ![429, 502, 503, 504, 529].includes(response.status)
    )
      return response;
    const header = response.headers.get('retry-after');
    const delay = header
      ? /^\d+$/.test(header)
        ? Number(header) * 1000
        : Date.parse(header) - Date.now()
      : 350;
    if (!Number.isFinite(delay) || delay < 0 || delay > 1500) return response;
    await response.body?.cancel();
    await sleep(Math.max(350, delay));
  }
}
export async function readJevResponse(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('empty_response');
  let text = '',
    bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const piece = await reader.read();
      if (piece.done) break;
      bytes += piece.value.length;
      if (bytes > 64000) {
        await reader.cancel();
        throw Error('oversized_response');
      }
      text += decoder.decode(piece.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
