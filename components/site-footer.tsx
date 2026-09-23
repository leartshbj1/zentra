import { BrandWordmark } from './brand-mark';

const groups = [
  {
    title: 'Zentra Gestion',
    links: [
      ['/gestion', 'Découvrir Gestion'],
      ['/features', 'Fonctionnalités'],
      ['/pricing', 'Tarifs Gestion'],
      ['/download', 'Télécharger'],
      ['/demo-facture', 'Voir la démo'],
      ['/#questions', 'Questions fréquentes'],
    ],
  },
  {
    title: 'Zentra Support',
    links: [
      ['/support', 'Découvrir Support'],
      ['/support/connexions', 'Connexions'],
      ['/support/tarifs', 'Tarifs Support'],
      ['/support/demo', 'Voir la démo'],
      ['/support/espace', 'Mon espace Support'],
    ],
  },
  {
    title: 'Zentra Automation',
    links: [
      ['/automation', 'Découvrir l’option'],
      ['/automation#parcours', 'Voir Automation en action'],
      ['/automation#fonctions', 'Toutes les fonctions'],
      ['/automation#utilisation', 'Comment l’activer'],
      ['/automation#tarif', 'Tarif Automation'],
      ['/compte/automation', 'Mes réglages'],
      ['/parrainage/conditions', 'Parrainage'],
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="catalog-footer">
      <div className="catalog-footer-inner">
        <div className="catalog-footer-brand">
          <a href="/" aria-label="Zentra, tous les produits">
            <BrandWordmark />
          </a>
          <p>Des outils pour alléger le quotidien de votre entreprise.</p>
          <a href="mailto:info@zentraapp.ch">info@zentraapp.ch</a>
          <p>
            <a href="/produits">Voir tous les produits</a>
          </p>
        </div>
        {groups.map((group) => (
          <section key={group.title}>
            <h2>{group.title}</h2>
            <nav aria-label={group.title + ' — pied de page'}>
              {group.links.map(([href, label]) => (
                <a key={href} href={href}>
                  {label}
                </a>
              ))}
            </nav>
          </section>
        ))}
      </div>
      <div className="catalog-footer-legal" aria-label="Informations légales">
        <a href="/security">Sécurité et données</a>
        <a href="/confidentialite">Confidentialité</a>
        <a href="/conditions">Conditions Gestion</a>
        <a href="/support/conditions">Conditions Support</a>
        <a href="/automation/conditions">Conditions Automation</a>
        <a href="/mentions-legales">Mentions légales</a>
        <a href="/sous-traitance">Traitement des données</a>
        <a href="/cookies">Cookies</a>
      </div>
      <div className="catalog-footer-bottom">
        <span>© 2026 Zentra</span>
        <span>
          Gestion et Support : deux abonnements distincts. Automation : une
          option de Gestion.
        </span>
      </div>
    </footer>
  );
}
