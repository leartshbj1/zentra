/** Opening or restoring a sign-in page must never sign out another tab. */
export async function loadAuthFormSession(signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  // The initial check gates the entire form. Bound both headers and body reads.
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher('/api/auth/session', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) throw new Error('La session n’a pas pu être vérifiée. Réessayez.');
    return await response.json() as { authenticated?: boolean; user?: { email: string } };
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted)
      throw new Error('La session n’a pas pu être vérifiée. Réessayez.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}
