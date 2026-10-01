import type { Metadata } from 'next';
import {
  ArrowRight,
  Inbox,
  Layers,
  PanelsTopLeft,
  Workflow,
} from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { ProductHero } from '@/components/quiet-product';

export const metadata: Metadata = {
  title: 'Par où commencer ? — Trouver votre parcours Zentra',
  description:
    'Choisissez votre point de départ : gérer votre entreprise, organiser vos demandes ou réunir les trois produits dans Zentra Complet.',
  alternates: { canonical: '/commencer' },
};

const paths = [
  {
    id: 'gestion',
    icon: PanelsTopLeft,
    name: 'Gestion',
    title: 'Organiser votre entreprise.',
    text: 'Clients, devis, factures, achats, projets et comptabilité se retrouvent dans votre application.',
    detail:
      'Choisissez votre formule, puis installez Gestion sur votre ordinateur.',
    href: '/gestion',
    action: 'Découvrir Gestion',
    nextHref: '/pricing',
    next: 'Voir les formules',
  },
  {
    id: 'support',
    icon: Inbox,
    name: 'Support',
    title: 'Retrouver chaque demande.',
    text: 'Réunissez les messages et demandes de votre équipe dans un espace distinct. Support peut s’utiliser sans Gestion.',
    detail:
      'Vérifiez les connexions compatibles avec votre messagerie avant de choisir une formule.',
    href: '/support',
    action: 'Découvrir Support',
    nextHref: '/support/connexions',
    next: 'Vérifier les connexions',
  },
  {
    id: 'complet',
    icon: Layers,
    name: 'Complet',
    title: 'Faire travailler les outils ensemble.',
    text: 'Gestion, Support et Automation dans un même abonnement. Les échanges et les tâches restent reliés à votre entreprise.',
    detail:
      'L’essai comprend 14 jours, 3 personnes et 250 analyses Support, sans carte ni paiement automatique.',
    href: '/complet',
    action: 'Découvrir Complet',
    nextHref: '/compte',
    next: 'Accéder à l’essai',
  },
] as const;

export default function StartPage() {
  return (
    <div className="quiet-site apple-start">
      <a href="#contenu" className="site-skip-link">
        Aller au contenu
      </a>
      <SiteHeader />
      <main id="contenu" tabIndex={-1}>
        <ProductHero
          title={
            <>
              Un bon départ.
              <br />
              <span>À votre rythme.</span>
            </>
          }
          description="Commencez par ce qui compte le plus dans votre entreprise. Vous pourrez découvrir les autres produits ensuite."
          href="#parcours"
          action="Trouver mon parcours"
        />
        <section
          className="quiet-width apple-start-paths"
          id="parcours"
          aria-labelledby="start-paths-title"
        >
          <h2 id="start-paths-title">Qu’aimeriez-vous simplifier ?</h2>
          {paths.map(({ icon: Icon, ...path }) => (
            <article
              className={`apple-start-path apple-start-path-${path.id}`}
              key={path.id}
            >
              <div className="apple-start-product">
                <Icon size={28} strokeWidth={1.4} aria-hidden="true" />
                <h3>{path.name}</h3>
              </div>
              <div className="apple-start-description">
                <h4>{path.title}</h4>
                <p>{path.text}</p>
                <p className="apple-start-detail">{path.detail}</p>
              </div>
              <div className="apple-start-actions">
                <a className="quiet-primary" href={path.href}>
                  {path.action}
                  <ArrowRight size={17} aria-hidden="true" />
                </a>
                <a className="quiet-link" href={path.nextHref}>
                  {path.next}
                </a>
              </div>
            </article>
          ))}
        </section>
        <section
          className="quiet-width apple-start-automation"
          aria-labelledby="start-automation-title"
        >
          <Workflow size={28} strokeWidth={1.4} aria-hidden="true" />
          <div>
            <h2 id="start-automation-title">
              Et pour les tâches qui se répètent ?
            </h2>
            <p>
              Automation est une option de Gestion, à 15 CHF par mois pour
              l’entreprise. Pour les e-mails, Support doit être relié à la même
              entreprise avec une connexion compatible. Les réponses restent à
              valider.
            </p>
            <a className="quiet-link" href="/automation">
              Comprendre Automation
              <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
        </section>
        <section
          className="quiet-width apple-start-steps"
          aria-labelledby="start-steps-title"
        >
          <h2 id="start-steps-title">Vos premiers pas.</h2>
          <ol>
            <li>
              <h3>Retrouver votre compte.</h3>
              <p>
                Créez votre accès personnel ou reconnectez-vous à votre compte
                existant.
              </p>
              <a className="quiet-link" href="/connexion">
                Créer un compte ou se connecter
              </a>
            </li>
            <li>
              <h3>Ouvrir le bon espace.</h3>
              <p>
                Gestion s’installe sur votre ordinateur. Pour les messages,
                ouvrez votre espace Support dans le navigateur.
              </p>
              <div>
                <a className="quiet-link" href="/download">
                  Télécharger Gestion
                </a>
                <a className="quiet-link" href="/support/espace">
                  Ouvrir Support
                </a>
              </div>
            </li>
            <li>
              <h3>Prendre vos repères.</h3>
              <p>
                Explorez les vrais écrans de Gestion et les réponses aux
                questions fréquentes.
              </p>
              <div>
                <a className="quiet-link" href="/demo-facture">
                  Visiter Gestion
                </a>
                <a className="quiet-link" href="/questions">
                  Voir les réponses
                </a>
              </div>
            </li>
          </ol>
        </section>
        <section className="quiet-offer quiet-width">
          <div>
            <h2>Déjà dans Zentra ?</h2>
            <p>
              Votre entreprise, vos accès et vos abonnements se retrouvent dans
              votre compte.
            </p>
          </div>
          <a className="quiet-primary" href="/compte">
            Ouvrir mon compte
          </a>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
