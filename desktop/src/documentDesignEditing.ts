import { documentAppearance, defaultDocumentStyle, type DocumentDesignKind, type DocumentStyle } from './documentAppearance';
import { normalizeComposition } from './documentComposition';
import type { AppSettings } from './types';

const kinds: DocumentDesignKind[] = ['invoices', 'quotes', 'accounts', 'payslips'];
type Snapshot = { kind: DocumentDesignKind; appearance: DocumentStyle; composition: NonNullable<AppSettings['documentComposition']>[DocumentDesignKind] };
export type DesignChange = { before: Snapshot[]; after: Snapshot[] };
function snapshot(settings: AppSettings, kind: DocumentDesignKind): Snapshot {
  return structuredClone({ kind, appearance: documentAppearance(settings.documentAppearance)[kind], composition: settings.documentComposition?.[kind] });
}
export function designChange(before: AppSettings, after: AppSettings): DesignChange | null {
  const changed = kinds.filter(kind => JSON.stringify(snapshot(before, kind)) !== JSON.stringify(snapshot(after, kind)));
  return changed.length ? { before: changed.map(kind => snapshot(before, kind)), after: changed.map(kind => snapshot(after, kind)) } : null;
}
/** History concerns edited document categories only, never company data or billing settings. */
export function restoreDesignChange(settings: AppSettings, change: DesignChange, redo = false): AppSettings | null {
  const expected = redo ? change.before : change.after, restored = redo ? change.after : change.before;
  if (expected.some(item => JSON.stringify(snapshot(settings, item.kind)) !== JSON.stringify(item))) return null;
  const appearance = documentAppearance(settings.documentAppearance), documentComposition = { ...settings.documentComposition };
  for (const item of restored) {
    appearance[item.kind] = structuredClone(item.appearance);
    if (item.composition) documentComposition[item.kind] = structuredClone(item.composition);
    else delete documentComposition[item.kind];
  }
  return { ...settings, documentAppearance: appearance, documentComposition };
}
export function copyDocumentDesign(settings: AppSettings, from: DocumentDesignKind, to: DocumentDesignKind, includeText = false): AppSettings {
  if (from === to) return settings;
  const appearance = documentAppearance(settings.documentAppearance);
  const source = normalizeComposition(settings.documentComposition?.[from]);
  const target = normalizeComposition(settings.documentComposition?.[to]);
  const composition = includeText ? settings.documentComposition?.[from] : {
    ...source, intro: target.intro, closing: target.closing, footerText: target.footerText,
  };
  return { ...settings,
    documentAppearance: { ...appearance, [to]: { ...appearance[from], footer: includeText ? appearance[from].footer : appearance[to].footer } },
    documentComposition: { ...settings.documentComposition, [to]: composition ? structuredClone(composition) : undefined },
  };
}
export function resetDocumentDesign(settings: AppSettings, kind: DocumentDesignKind, includeText = false): AppSettings {
  const appearance = documentAppearance(settings.documentAppearance);
  const previous = normalizeComposition(settings.documentComposition?.[kind]);
  const composition = { ...settings.documentComposition };
  if (includeText) delete composition[kind];
  else composition[kind] = normalizeComposition({ intro: previous.intro, closing: previous.closing, footerText: previous.footerText });
  return { ...settings,
    documentAppearance: { ...appearance, [kind]: { ...defaultDocumentStyle, footer: includeText ? '' : appearance[kind].footer } },
    documentComposition: composition,
  };
}
