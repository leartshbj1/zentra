export const COMPACT_NAVIGATION_QUERY = '(max-width: 860px)';

export function compactSidebarHidden(compact: boolean, open: boolean) {
  return compact && !open;
}
