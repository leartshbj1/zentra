// Build-time only: enlarge explicit UI type without zooming layouts or observing
// the DOM. Relative em/% values already follow their parent and must not double.
const scale = 'var(--zentra-ui-text-scale, 1)';
export function scalableFontValue(value: string): string {
  if (value.includes('--zentra-ui-text-scale')) return value;
  // Quoted font names and variable identifiers are not dimensions.
  return value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?<![\w-])(?:\d*\.)?\d+(?:px|rem|pt|vw|vh|vmin|vmax)\b/g, token =>
    token.startsWith('"') || token.startsWith("'") ? token : `calc(${token} * ${scale})`);
}

type Container = { type: string; selector?: string; name?: string; parent?: Container };
type Declaration = { prop: string; value: string; parent?: Container; source?: { input: { file?: string } } };
export function scalableText() {
  return {
    postcssPlugin: 'zentra-scalable-text',
    Declaration(decl: Declaration) {
      if (!['font-size', 'font', 'line-height'].includes(decl.prop)) return;
      const file = decl.source?.input.file?.replaceAll('\\', '/');
      if (!file?.includes('/desktop/src/') || !file.endsWith('.css')) return;
      // Keep the rem reference stable. Root-relative spacing must never zoom.
      const selectors = decl.parent?.selector?.split(',').map(value => value.trim()) ?? [];
      if (selectors.some(value => value === ':root' || value === 'html')) return;
      for (let parent = decl.parent; parent; parent = parent.parent) {
        if (parent.type === 'atrule' && parent.name === 'font-face') return;
      }
      decl.value = scalableFontValue(decl.value);
    },
  };
}
