/** Opening or restoring a sign-in page must never sign out another tab. */
export async function loadAuthFormSession(signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/auth/session', {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
  });
  if (!response.ok) throw new Error('La session n’a pas pu être vérifiée. Réessayez.');
  return await response.json() as { authenticated?: boolean; user?: { email: string } };
}
