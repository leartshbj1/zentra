'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { AccountWorkspace } from '@/lib/account-workspaces';
import { UsDeviceApprovalModel } from '@/lib/international/browser-us-device-approval';
import type { UsApprovalLanguage } from '@/lib/international/us-device-approval-page';
import { usApprovalCopy, usApprovalError } from '@/lib/international/us-device-approval-copy';
import './us-device-approval.css';

export function UsDeviceApproval({ initialCode, userId, workspaces, language }: { initialCode: string; userId: string; workspaces: readonly AccountWorkspace[]; language: UsApprovalLanguage }) {
  // A new identity/selection creates a new store; old async outcomes cannot
  // update the new render even before effect cleanup aborts the old request.
  const model = useMemo(() => new UsDeviceApprovalModel({ userId, initialCode, organizationIds: workspaces.map(w => w.organizationId) }, undefined, typeof window === 'undefined' ? 'https://zentraapp.ch' : window.location.origin), [userId, initialCode, workspaces]);
  useEffect(() => () => model.invalidate(), [model]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot), c = usApprovalCopy[language];
  if (view.approvedName) return <section className="apple-task-panel us-device us-device-success" aria-live="polite"><CheckCircle2 size={32} aria-hidden="true" /><h2>{c.done}</h2><p className="us-device-name">{view.approvedName}</p><p>{c.return}</p></section>;
  if (!workspaces.length) return <section className="apple-task-panel us-device"><p>{c.empty}</p><a className="zentra-text-link" href="/compte">{c.account}</a></section>;
  return <form className="apple-task-panel us-device" onSubmit={event => { event.preventDefault(); void model.approve(); }} aria-busy={view.busy}>
    <fieldset disabled={view.busy}>
      <label className="us-device-code-label" htmlFor="us-device-code">{c.code}</label>
      <input id="us-device-code" className="us-device-code" name="userCode" value={view.code} onChange={e => model.code(e.target.value)} placeholder="ABCD-EFGH" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} maxLength={32} />
      <fieldset className="us-device-choice-group"><legend className="us-device-choice-title">{c.choose}</legend>
      <div className="us-device-choices">{workspaces.map(w => <label key={w.organizationId} aria-label={w.name}><input type="radio" name="us-workspace" value={w.organizationId} checked={view.organizationId === w.organizationId} onChange={() => model.choose(w.organizationId)} required /><span><strong>{w.name}</strong><small>{c.market}</small></span></label>)}</div></fieldset>
    </fieldset>
    <button className="zentra-button us-device-submit" type="submit" disabled={view.busy || !view.code || !view.organizationId}>{view.busy ? c.busy : c.approve}</button>
    {view.error ? <p role="alert" className="us-device-error">{usApprovalError(language, view.error)}</p> : null}
  </form>;
}
