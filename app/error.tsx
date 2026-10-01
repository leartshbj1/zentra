'use client';

import { RotateCcw } from 'lucide-react';

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="quiet-site apple-status-page apple-error-page">
      <div className="apple-status-content quiet-width" role="alert">
        <RotateCcw size={36} strokeWidth={1.4} aria-hidden="true" />
        <h1>
          La page n’a pas
          <br />
          <span>pu se charger.</span>
        </h1>
        <p>
          Réessayez de l’ouvrir. Si le problème persiste, vous pouvez revenir à
          l’accueil ou contacter Zentra.
        </p>
        <div className="quiet-actions">
          <button type="button" className="quiet-primary" onClick={reset}>
            Réessayer
            <RotateCcw size={17} aria-hidden="true" />
          </button>
          <a className="quiet-link" href="/">
            Revenir à l’accueil
          </a>
        </div>
        <p className="apple-status-help">
          <a href="mailto:info@zentraapp.ch">Contacter Zentra</a>
        </p>
      </div>
    </main>
  );
}
