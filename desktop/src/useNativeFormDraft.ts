import { useLayoutEffect, useState, type RefObject } from 'react';
import type { Workspace } from './types';
import { draftObject } from './formDrafts';
import { useFormDraft, useFormDraftScope } from './useFormDraft';

/** Recovery adapter for existing native, mostly uncontrolled forms. File bytes are never retained. */
export function useNativeFormDraft({ workspace, type, recordId, fingerprint, form, fields, controlled = [], initial = {}, validateValue, extra, onRestore }: {
  workspace?: Workspace; type: string; recordId?: string; fingerprint: string;
  form: RefObject<HTMLFormElement | null>; fields: readonly string[];
  controlled?: readonly string[]; initial?: Record<string, string>;
  validateValue?: (value: Record<string, string>) => boolean;
  extra?: () => Record<string, string>; onRestore?: (values: Record<string, string> | null) => void;
}) {
  const allowed = new Set(fields);
  const validate = (value: unknown): value is Record<string, string> => draftObject(value) && Object.keys(value).length <= fields.length &&
    Object.entries(value).every(([key, row]) => allowed.has(key) && typeof row === 'string' && row.length <= 50_000) &&
    (!validateValue || validateValue(value as Record<string, string>));
  const draft = useFormDraft({ scope: useFormDraftScope(workspace, type, recordId), initial, fingerprint, validate });
  const [recovery, setRecovery] = useState<{ revision: number; values: Record<string, string> | null }>({ revision: 0, values: null });
  useLayoutEffect(() => {
    if (!recovery.revision || !form.current) return;
    for (const node of Array.from(form.current.elements)) {
      if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) || !allowed.has(node.name) || controlled.includes(node.name) || (node instanceof HTMLInputElement && ['password', 'file'].includes(node.type))) continue;
      const value = recovery.values?.[node.name];
      if (node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type)) node.checked = value === undefined ? node.defaultChecked : value === 'true';
      else if (value !== undefined) node.value = value;
      else if (recovery.values === null) node.value = node instanceof HTMLSelectElement ? Array.from(node.options).find(option => option.defaultSelected)?.value ?? node.options[0]?.value ?? '' : node.defaultValue;
    }
  }, [recovery]);
  const capture = (patch: Record<string, string> = {}) => {
    const values: Record<string, string> = { ...extra?.() };
    for (const node of Array.from(form.current?.elements ?? [])) {
      if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) || !allowed.has(node.name) || (node instanceof HTMLInputElement && ['password', 'file'].includes(node.type))) continue;
      values[node.name] = node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type) ? String(node.checked) : node.value;
    }
    return draft.setValue(previous => ({ ...previous, ...values, ...patch }));
  };
  return { ...draft, capture,
    restore: () => { const values = draft.pending?.value; if (!values) return; draft.restore(); onRestore?.(values); setRecovery(previous => ({ revision: previous.revision + 1, values })); },
    discard: () => { if (!draft.discard()) return; onRestore?.(null); setRecovery(previous => ({ revision: previous.revision + 1, values: null })); },
  };
}
