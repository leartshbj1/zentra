import { ArrowRight } from 'lucide-react';
import './complete-banner.css';
export function CompleteBanner() {
  return (
    <aside className="complete-banner" aria-label="Le pack Zentra Complet">
      <div>
        <h2>Tout Zentra, dans un seul pack.</h2>
        <p>Gestion, Support et Automation réunis dès 79 CHF par mois.</p>
      </div>
      <a href="/complet">
        Découvrir Zentra Complet <ArrowRight size={18} aria-hidden="true" />
      </a>
    </aside>
  );
}
