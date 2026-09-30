import { BrandWordmark } from './brand-mark';

const legalLinks = [
  ['/security', 'Sécurité et données'], ['/confidentialite', 'Confidentialité'],
  ['/conditions', 'Conditions Gestion'], ['/support/conditions', 'Conditions Support'],
  ['/automation/conditions', 'Conditions Automation'], ['/complet/conditions', 'Conditions du pack'],
  ['/mentions-legales', 'Mentions légales'], ['/sous-traitance', 'Traitement des données'], ['/cookies', 'Cookies'],
] as const;

export function SiteFooter() {
  return (
    <footer className="catalog-footer quiet-footer">
      <div className="quiet-footer-inner">
        <div className="quiet-footer-top">
          <div className="quiet-footer-brand">
            <a href="/" aria-label="Zentra, accueil"><BrandWordmark /></a>
            <a href="mailto:info@zentraapp.ch">info@zentraapp.ch</a>
          </div>
          <nav aria-label="Accès utiles">
            <a href="/ecosysteme">Comment ça marche</a>
            <a href="/questions">Questions</a>
            <a href="/download">Télécharger</a>
            <a href="/compte">Mon compte</a>
          </nav>
        </div>
        <div className="quiet-footer-bottom">
          <span>© 2026 Zentra</span>
          <details>
            <summary>Informations légales</summary>
            <div className="quiet-legal-links">
              {legalLinks.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
            </div>
          </details>
        </div>
      </div>
    </footer>
  );
}
