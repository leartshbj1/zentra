const sections = new Set([
  'inbox',
  'automation',
  'routing',
  'connections',
  'insights',
  'team',
  'billing',
  'settings',
]);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

/** Preserve the selected company and message across browser sign-in. The
 * destination is fixed; Support still authorizes workspace and ticket access. */
export function supportLoginReturn(
  search: string,
  section: string,
  workspace: string,
  ticket: string | null,
): string {
  const input = new URLSearchParams(search);
  const output = new URLSearchParams({
    section: sections.has(section) ? section : 'inbox',
  });
  for (const [key, value] of [
    ['organizationId', input.get('organizationId') ?? ''],
    ['workspace', workspace || input.get('workspace') || ''],
    ['ticket', ticket ?? input.get('ticket') ?? ''],
  ]) {
    // Keep no arbitrary return URL, session, credential, filter or provider flag.
    if (input.getAll(key).length > 1) continue;
    if (value && identifier.test(value)) output.set(key, value);
  }
  return '/support/espace?' + output.toString();
}
