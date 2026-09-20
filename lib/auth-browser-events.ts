export const AUTH_CHANGED_EVENT = 'zentra-auth-changed';
export function notifyAuthChanged() {
  try {
    window.localStorage.setItem(AUTH_CHANGED_EVENT, crypto.randomUUID());
  } catch {
    /* Storage may be disabled. */
  }
}
