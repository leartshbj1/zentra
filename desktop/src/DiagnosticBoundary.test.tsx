import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticBoundary } from './DiagnosticBoundary';
import { recentDiagnosticEvents } from './diagnostics';
import { ErrorGuidance, type ErrorGuidanceProps } from './ErrorGuidance';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function capture(reason: unknown) {
  const start = recentDiagnosticEvents().length;
  const boundary = new DiagnosticBoundary({ children: <p>Workspace remains available.</p> });
  boundary.state = { ...boundary.state, ...DiagnosticBoundary.getDerivedStateFromError(reason) };
  const first = renderToStaticMarkup(boundary.render());
  // Drive the class lifecycle synchronously; the real React recovery is also
  // exercised by the Chromium/WebKit journey, without a replacement boundary.
  vi.spyOn(boundary, 'setState').mockImplementation(update => {
    if (update && typeof update !== 'function') boundary.state = { ...boundary.state, ...update };
  });
  boundary.componentDidCatch(reason);
  const html = renderToStaticMarkup(boundary.render());
  return { boundary, first, html, events: recentDiagnosticEvents().slice(start) };
}

const failures = [
  ['message getter', () => {
    const reason = new Error('');
    Object.defineProperty(reason, 'message', { get() { throw new Error('Synthetic accessor failure'); } });
    return reason;
  }],
  ['prototype trap', () => new Proxy(new Error(''), {
    getPrototypeOf() { throw new Error('Synthetic prototype failure'); },
  })],
  ['normal Error', () => new Error('Synthetic render failure')],
  ['native string', () => 'Synthetic native failure'],
] as const;

describe('DiagnosticBoundary recovery', () => {
  it.each(failures)('keeps a visible fallback and one render incident for a %s', (_kind, makeReason) => {
    let result: ReturnType<typeof capture> | undefined;
    let escaped = false;
    try { result = capture(makeReason()); } catch { escaped = true; }
    expect(escaped).toBe(false);
    expect(result).toBeDefined();
    expect(result!.first).toContain('Cet écran ne peut pas être affiché.');
    expect(result!.html).toContain('role="alert"');
    expect(result!.html).toContain('Actualiser l’affichage');
    expect(result!.events).toHaveLength(1);
    expect(result!.events[0]).toMatchObject({ area: 'error', operation: 'client.react_render', phase: 'failure', errorCode: 'RENDER' });
    const code = `ZT-${result!.events[0].id}`;
    expect(result!.html).toContain(code);
    expect(renderToStaticMarkup(result!.boundary.render())).toContain(code);
    expect(recentDiagnosticEvents().slice(-1)[0].id).toBe(result!.events[0].id);
  });

  it('renders its children without inventing a failure', () => {
    const start = recentDiagnosticEvents().length;
    const boundary = new DiagnosticBoundary({ children: <p>Workspace remains available.</p> });
    expect(renderToStaticMarkup(boundary.render())).toBe('<p>Workspace remains available.</p>');
    expect(recentDiagnosticEvents()).toHaveLength(start);
  });

  it('also recovers from a falsy thrown value', () => {
    const result = capture(null);
    expect(result.html).toContain('role="alert"');
    expect(result.html).toContain(`ZT-${result.events[0].id}`);
  });

  it('offers an explicit read reload and never writes the reason to the journal', () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    const result = capture(new Error('private@example.ch password=synthetic-secret'));
    const main = result.boundary.render();
    expect(isValidElement(main)).toBe(true);
    const guidance = (main as ReactElement<{ children: ReactElement<ErrorGuidanceProps> }>).props.children;
    expect(guidance.type).toBe(ErrorGuidance);
    expect(guidance.props.operation).toBe('read');
    expect(reload).not.toHaveBeenCalled();
    guidance.props.onReload!();
    expect(reload).toHaveBeenCalledExactlyOnceWith();
    expect(JSON.stringify(result.events)).not.toMatch(/private|password|synthetic-secret/);
    expect(result.html).not.toMatch(/private@example.ch|synthetic-secret/);
  });
});
