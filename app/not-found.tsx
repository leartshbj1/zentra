import { ArrowRight, Compass } from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';

export default function NotFound() {
  return (
    <div className="quiet-site apple-status-page">
      <a href="#contenu" className="site-skip-link">
        Aller au contenu
      </a>
      <SiteHeader />
      <main
        id="contenu"
        tabIndex={-1}
        className="quiet-width apple-status-content"
      >
        <Compass size={40} strokeWidth={1.3} aria-hidden="true" />
        <h1>
          Retrouvons
          <br />
          <span>votre chemin.</span>
        </h1>
        <p>Cette page n’existe pas ou son adresse a changé.</p>
        <div className="quiet-actions">
          <a className="quiet-primary" href="/">
            Revenir à l’accueil
            <ArrowRight size={17} aria-hidden="true" />
          </a>
          <a className="quiet-link" href="/commencer">
            Par où commencer ?
          </a>
        </div>
        <p className="apple-status-help">
          Vous cherchiez une information précise ?{' '}
          <a href="mailto:info@zentraapp.ch">Écrivez à Zentra.</a>
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
