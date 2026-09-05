import type { ReactNode } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import './DevelopmentNotice.css';

export function DevelopmentNotice({ identity, hasNavigation }: { identity: ReactNode; hasNavigation: boolean }) {
  return (
    <details className={`license-banner license-banner--development${hasNavigation ? ' license-banner--with-navigation' : ''}`}>
      <summary>
        <ShieldCheck size={18} aria-hidden="true" />
        <span>Version de test</span>
        <ChevronDown className="development-notice__chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="development-notice__details">
        <p>Version réservée aux essais, sans contrôle de licence de production. Utilisez des données de test.</p>
        {identity}
      </div>
    </details>
  );
}
