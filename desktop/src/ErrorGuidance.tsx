import { AlertTriangle, Check, Copy } from 'lucide-react';
import { useState, type Ref } from 'react';
import { resolveErrorIncident } from './diagnostics';
import { t, useAppLanguage } from './language';
import { getUserError, safeErrorDetails, userErrorCopy, type UserErrorOperation } from './userErrors';
import './error-guidance.css';

export type ErrorGuidanceProps = {
  error: unknown;
  fallback?: string;
  title?: string;
  operation?: UserErrorOperation;
  onReload?: () => void;
  onReconnect?: () => void;
  onReview?: () => void;
  incidentCode?: string;
  compact?: boolean;
  disabled?: boolean;
  panelRef?: Ref<HTMLDivElement>;
};

/** Shared progressive disclosure, also usable with a business-specific guide. */
export function ErrorDetails({ error, incidentCode }: { error: unknown; incidentCode?: string }) {
  const language = useAppLanguage();
  const labels = userErrorCopy(language);
  const details = safeErrorDetails(error);
  const incident = incidentCode ?? resolveErrorIncident(error).code;
  const [copyResult, setCopyResult] = useState<{ incident: string; state: 'pending' | 'copied' | 'failed' } | null>(null);
  const copyState = copyResult?.incident === incident ? copyResult.state : 'idle';
  async function copyCode() {
    const attempt = { incident, state: 'pending' } as const;
    setCopyResult(attempt);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(incident);
      setCopyResult(current => current === attempt ? { incident, state: 'copied' } : current);
    } catch { setCopyResult(current => current === attempt ? { incident, state: 'failed' } : current); }
  }
  return <div className="error-guidance__support">
    <div className="error-guidance__incident">
      <span>{labels.incident}</span><code>{incident}</code>
      <button type="button" className="button button--ghost button--small" onClick={() => void copyCode()} aria-label={labels.copy}>
        {copyState === 'copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        {copyState === 'copied' ? labels.copied : labels.copy}
      </button>
    </div>
    {copyState === 'failed' && <p className="error-guidance__copy-status" role="status">{labels.copyFailed}</p>}
    {details && <details className="error-guidance__details"><summary>{labels.details}</summary><pre>{details}</pre></details>}
  </div>;
}

export function ErrorGuidance({ error, fallback, title, operation = 'mutation', onReload, onReconnect, onReview, incidentCode, compact = false, disabled = false, panelRef }: ErrorGuidanceProps) {
  const language = useAppLanguage();
  const guidance = getUserError(error, { fallback, operation, language });
  const labels = userErrorCopy(language);
  // Only an explicitly provided read operation may refresh. Reconnect and
  // review callbacks open a corrective path; neither repeats the failed save.
  const action = guidance.kind === 'session' && onReconnect ? { label: labels.reconnect, run: onReconnect }
    : ['validation', 'conflict'].includes(guidance.kind) && onReview ? { label: labels.review, run: onReview }
    : operation === 'read' && onReload && ['network', 'file', 'conflict', 'unknown', 'workspace'].includes(guidance.kind) ? { label: labels.reload, run: onReload } : null;
  return <div ref={panelRef} className={`error-panel error-guidance${compact ? ' error-guidance--compact' : ''}`}>
    <div className="error-guidance__message" role="alert">
      <AlertTriangle size={22} aria-hidden="true" />
      <div><strong>{title ? t(title) : guidance.title}</strong><p>{guidance.message}</p><p className="error-guidance__recovery">{guidance.action}</p></div>
    </div>
    {action && <div className="error-guidance__actions"><button type="button" className="button button--secondary button--small" disabled={disabled} onClick={action.run}>{action.label}</button></div>}
    <ErrorDetails error={error} incidentCode={incidentCode} />
  </div>;
}
