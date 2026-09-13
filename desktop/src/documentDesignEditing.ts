import { documentAppearance, defaultDocumentStyle, type DocumentDesignKind, type DocumentStyle } from './documentAppearance';
import { normalizeComposition } from './documentComposition';
import type { AppSettings } from './types';

const kinds: DocumentDesignKind[] = ['invoices', 'quotes', 'accounts', 'payslips'];
type Snapshot = { kind: DocumentDesignKind; appearance: DocumentStyle; composition: NonNullable<AppSettings['documentComposition']>[DocumentDesignKind] };
export type DesignChange = { before: Snapshot[]; after: Snapshot[]; templates?: { before: AppSettings['documentDesignTemplates']; after: AppSettings['documentDesignTemplates'] } };
/** One continuous slider movement is one undo; a refresh breaks the group. */
export function joinDesignChanges(previous: DesignChange, next: DesignChange): DesignChange | null {
  if (previous.templates || next.templates) return null;
  return JSON.stringify(previous.after) === JSON.stringify(next.before) ? { before: previous.before, after: next.after } : null;
}
function snapshot(settings: AppSettings, kind: DocumentDesignKind): Snapshot {
  return structuredClone({ kind, appearance: documentAppearance(settings.documentAppearance)[kind], composition: settings.documentComposition?.[kind] });
}
export function designChange(before: AppSettings, after: AppSettings): DesignChange | null {
  const changed = kinds.filter(kind => JSON.stringify(snapshot(before, kind)) !== JSON.stringify(snapshot(after, kind)));
  const templates = JSON.stringify(before.documentDesignTemplates) !== JSON.stringify(after.documentDesignTemplates)
    ? structuredClone({ before: before.documentDesignTemplates, after: after.documentDesignTemplates }) : undefined;
  return changed.length || templates ? { before: changed.map(kind => snapshot(before, kind)), after: changed.map(kind => snapshot(after, kind)), ...(templates ? { templates } : {}) } : null;
}
/** History concerns edited document categories only, never company data or billing settings. */
export function restoreDesignChange(settings: AppSettings, change: DesignChange, redo = false): AppSettings | null {
  const expected = redo ? change.before : change.after, restored = redo ? change.after : change.before;
  if (expected.some(item => JSON.stringify(snapshot(settings, item.kind)) !== JSON.stringify(item))) return null;
  if (change.templates && JSON.stringify(settings.documentDesignTemplates) !== JSON.stringify(redo ? change.templates.before : change.templates.after)) return null;
  const appearance = documentAppearance(settings.documentAppearance), documentComposition = { ...settings.documentComposition };
  for (const item of restored) {
    appearance[item.kind] = structuredClone(item.appearance);
    if (item.composition) documentComposition[item.kind] = structuredClone(item.composition);
    else delete documentComposition[item.kind];
  }
  return { ...settings, ...(restored.length ? { documentAppearance: appearance, documentComposition } : {}),
    ...(change.templates ? { documentDesignTemplates: structuredClone(redo ? change.templates.after : change.templates.before) } : {}),
  };
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
