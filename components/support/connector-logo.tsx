import { Link2 } from 'lucide-react';
import './connector-logo.css';

const logos: Record<string, string> = {
  infomaniak: 'infomaniak.svg',
  zendesk: 'zendesk.svg',
  freshdesk: 'freshdesk.svg',
  gorgias: 'gorgias.svg',
};

/** Decorative: each caller also displays the accessible provider name. */
export function ConnectorLogo({ provider }: { provider: string }) {
  const logo = logos[provider];
  return <span className={`connector-logo connector-logo-${provider}`} aria-hidden="true">
    {logo ? <img src={`/brand/connectors/${logo}`} alt="" width={120} height={32} /> : <Link2 size={24} />}
    {provider === 'zendesk' && <span>Zendesk</span>}
  </span>;
}
