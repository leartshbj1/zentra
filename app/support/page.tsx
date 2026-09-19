import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  ArrowRight,
  ArrowUpRight,
  Workflow,
  SlidersHorizontal,
  ShieldCheck,
  Check,
  MousePointer2,
} from 'lucide-react';
import { BrandWordmark } from '@/components/brand-mark';
import {
  RoutingExample,
  TimeEstimator,
} from '@/components/support/presentation';
import './presentation.css';

export const metadata: Metadata = {
  title: 'Zentra Support — Le bon ticket. La bonne équipe.',
  description:
    'Automatisez le tri de vos tickets support : catégorie, priorité et affectation à la bonne équipe. Connectez Zendesk, Freshdesk, Gorgias ou votre outil via API.',
  alternates: { canonical: '/support' },
  openGraph: {
    title: 'Zentra Support — Moins de tri. Plus de temps pour vos clients.',
    description: 'Le tri intelligent qui s’intègre à votre outil de support.',
    url: '/support',
  },
};
export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  const params = await searchParams;
  if (params.workspace)
    redirect(
      `/support/espace?workspace=${encodeURIComponent(params.workspace)}`,
    );
  return (
    <div className="support-presentation">
      <header className="sp-header">
        <a className="sp-brand" href="/">
          <BrandWordmark />
          <span>Support</span>
        </a>
        <nav aria-label="Zentra Support">
          <a href="#fonctionnement">Comment ça marche</a>
          <a href="#connexions">Connexions</a>
          <a className="sp-header-account" href="/support/espace">
            Mon espace <ArrowUpRight size={15} />
          </a>
        </nav>
      </header>
      <main>
        <section className="sp-hero sp-wrap">
          <div className="sp-hero-copy">
            <p className="sp-kicker">
              <span /> ZENTRA SUPPORT
            </p>
            <h1>
              Moins de tri.
              <br />
              <em>Plus de temps</em>
              <br />
              pour vos clients.
            </h1>
            <p className="sp-lead">
              Chaque demande, à la bonne personne. Zentra classe vos tickets,
              repère les urgences et les affecte à votre équipe.
              Automatiquement.
            </p>
            <div className="sp-actions">
              <a className="sp-button sp-button-dark" href="/support/espace">
                Créer mon espace <ArrowRight size={18} />
              </a>
              <a className="sp-text-link" href="/support/demo">
                Explorer la démo <ArrowUpRight size={17} />
              </a>
            </div>
            <p className="sp-hero-note">
              <Check size={16} /> Votre outil habituel. L’intelligence de Zentra
              en plus.
            </p>
          </div>
          <RoutingExample />
        </section>
        <section
          className="sp-compatible sp-wrap"
          aria-label="Connecteurs disponibles"
        >
          <p>PENSÉ POUR VOTRE ÉQUIPE. CONNECTÉ À VOTRE QUOTIDIEN.</p>
          <div>
            <span>Zendesk</span>
            <span>Freshdesk</span>
            <span>Gorgias</span>
            <span className="sp-api">
              Votre outil, via API <ArrowUpRight size={16} />
            </span>
          </div>
        </section>
        <section className="sp-section sp-soft" id="fonctionnement">
          <div className="sp-wrap">
            <div className="sp-section-title">
              <p className="sp-kicker">DU TICKET À LA BONNE ÉQUIPE</p>
              <h2>
                Ça arrive.
                <br />
                <span>C’est déjà orienté.</span>
              </h2>
              <p>
                Votre équipe peut se concentrer sur la réponse. Zentra prend en
                charge les étapes répétitives qui la précèdent.
              </p>
            </div>
            <div className="sp-steps">
              {[
                {
                  n: '01',
                  icon: Workflow,
                  title: 'Zentra lit et comprend.',
                  text: 'Bug, facture, remboursement, livraison… Chaque demande reçoit une catégorie et une priorité selon son contenu.',
                },
                {
                  n: '02',
                  icon: SlidersHorizontal,
                  title: 'Vos règles font le lien.',
                  text: 'Facturation à la compta. Bug à la technique. Choisissez l’équipe, ou la personne, qui reçoit chaque catégorie.',
                },
                {
                  n: '03',
                  icon: ShieldCheck,
                  title: 'Le doute revient à l’humain.',
                  text: 'Une demande ambiguë ou un client qui réclame une intervention humaine ? Le ticket reste à vérifier avant affectation.',
                },
              ].map((item) => (
                <article key={item.n}>
                  <div className="sp-step-top">
                    <item.icon size={25} strokeWidth={1.5} />
                    <span>{item.n}</span>
                  </div>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
        <section className="sp-section sp-wrap sp-control">
          <div>
            <p className="sp-kicker">L’AUTOMATISATION, À VOTRE RYTHME</p>
            <h2>
              Vous décidez.
              <br />
              <span>Zentra s’en occupe.</span>
            </h2>
            <p>
              Le tri automatique est activé pour les nouveaux espaces.
              Choisissez vos destinations et votre seuil de confiance. Vous
              pouvez aussi passer en validation manuelle à tout moment.
            </p>
            <a className="sp-text-link" href="/support/demo">
              Essayer une validation <ArrowRight size={17} />
            </a>
          </div>
          <div className="sp-control-card">
            <div className="sp-control-heading">
              <ShieldCheck size={21} />
              <strong>Votre cadre de décision</strong>
            </div>
            <dl>
              <div>
                <dt>Catégorie</dt>
                <dd>Facturation</dd>
              </div>
              <div>
                <dt>Équipe choisie</dt>
                <dd>Comptabilité</dd>
              </div>
              <div>
                <dt>Seuil de confiance</dt>
                <dd>85 %</dd>
              </div>
            </dl>
            <div className="sp-control-track">
              <span />
            </div>
            <p>
              Au-dessus du seuil, le ticket est affecté.
              <br />
              En cas de doute, votre équipe valide.
            </p>
            <small>
              Exemple de configuration. Le score de confiance n’est pas une
              garantie d’exactitude.
            </small>
          </div>
        </section>
        <section className="sp-section sp-dark">
          <div className="sp-wrap sp-time">
            <div>
              <p className="sp-kicker">DU TEMPS QUI COMPTE</p>
              <h2>
                Moins de clics.
                <br />
                Plus de disponibilité.
              </h2>
              <p>
                Combien de temps passez-vous à ouvrir, lire et réaffecter vos
                demandes ? Estimez ce que le tri automatique pourrait vous
                rendre.
              </p>
              <p className="sp-time-note">
                Dans votre espace, suivez les affectations confirmées, les
                corrections et le temps de tri estimé.
              </p>
            </div>
            <TimeEstimator />
          </div>
        </section>
        <section className="sp-section sp-wrap" id="connexions">
          <div className="sp-section-title">
            <p className="sp-kicker">GARDEZ VOS HABITUDES</p>
            <h2>
              Votre support reste chez vous.
              <br />
              <span>Le tri passe chez Zentra.</span>
            </h2>
            <p>
              Pas de compte IA à créer. Vous connectez votre outil de support,
              vous choisissez vos équipes, et Zentra fournit l’analyse.
            </p>
          </div>
          <div className="sp-integrations">
            {[
              [
                'Z',
                'Zendesk',
                'Équipes, agents et priorités synchronisés depuis votre outil.',
              ],
              [
                'F',
                'Freshdesk',
                'Recevez les tickets et appliquez vos règles d’affectation.',
              ],
              [
                'G',
                'Gorgias',
                'Orientez les demandes de votre boutique vers la bonne équipe.',
              ],
              [
                '↗',
                'Un autre outil ?',
                'Connexion via API ou un scénario Make / n8n. Configuration technique nécessaire.',
              ],
            ].map(([letter, name, description]) => (
              <article key={name}>
                <span className="sp-integration-icon" aria-hidden="true">
                  {letter}
                </span>
                <h3>{name}</h3>
                <p>{description}</p>
                <span className="sp-integration-type">
                  {letter === '↗' ? 'API & webhooks' : 'Connecteur intégré'}
                </span>
              </article>
            ))}
          </div>
          <p className="sp-caption">
            L’accès API et les webhooks doivent être disponibles dans
            l’abonnement de votre outil. L’installation guidée précise les
            autorisations nécessaires.
          </p>
        </section>
        <section className="sp-section sp-soft">
          <div className="sp-wrap sp-faq">
            <div>
              <p className="sp-kicker">TOUT SIMPLEMENT</p>
              <h2>
                Les bonnes
                <br />
                <span>questions.</span>
              </h2>
            </div>
            <div>
              {[
                [
                  'Est-ce que Zentra répond à mes clients ?',
                  'Zentra trie et affecte les demandes. Votre équipe conserve la rédaction des réponses, les remboursements et la résolution des tickets.',
                ],
                [
                  'Dois-je fournir une clé pour l’intelligence artificielle ?',
                  'Non. L’analyse est fournie par Zentra. Seule la connexion à votre outil de support est à configurer.',
                ],
                [
                  'Que se passe-t-il si le ticket est ambigu ?',
                  'Il apparaît dans « À vérifier ». Votre équipe choisit la catégorie, la priorité et la destination, puis valide. Les demandes explicites d’intervention humaine sont également conservées pour vérification.',
                ],
                [
                  'Le tri fonctionne-t-il quand je ferme Zentra ?',
                  'Oui. Lorsque votre outil envoie un nouveau ticket par webhook, le traitement se fait sur le serveur. Les erreurs restent visibles dans votre espace ; les reprises suivent la configuration de votre outil.',
                ],
                [
                  'Quelles informations sont analysées ?',
                  'L’objet et le texte des demandes. Zentra estime aussi la langue et l’insatisfaction exprimée pour aider votre équipe à comprendre le contexte. Les pièces jointes ne sont pas analysées.',
                ],
                [
                  'Le gain de temps est-il garanti ?',
                  'Il dépend du volume, de vos règles et de la clarté des tickets. Le tableau de bord estime le temps de tri évité à partir des affectations automatiques confirmées et de votre durée habituelle de tri. Vous pouvez comparer cette estimation à vos résultats réels.',
                ],
              ].map(([q, a]) => (
                <details key={q}>
                  <summary>
                    {q}
                    <span aria-hidden="true">+</span>
                  </summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
        <section className="sp-finish sp-wrap">
          <MousePointer2 size={30} strokeWidth={1.5} />
          <h2>
            La bonne équipe.
            <br />
            <span>Dès le premier tri.</span>
          </h2>
          <a className="sp-button sp-button-dark" href="/support/espace">
            Ouvrir Zentra Support <ArrowRight size={18} />
          </a>
          <a className="sp-text-link" href="/support/demo">
            Ou découvrir la démo
          </a>
        </section>
      </main>
      <footer className="sp-footer sp-wrap">
        <div>
          <a className="sp-brand" href="/">
            <BrandWordmark />
            <span>Support</span>
          </a>
          <p>Une autre façon de gagner du temps, par Zentra.</p>
        </div>
        <nav aria-label="Informations">
          <a href="mailto:info@zentraapp.ch">Nous contacter</a>
          <a href="/confidentialite#support-ia">Confidentialité</a>
          <a href="/mentions-legales">Mentions légales</a>
          <a href="/">
            Zentra Gestion <ArrowUpRight size={14} />
          </a>
        </nav>
        <small>© 2026 Zentra</small>
      </footer>
    </div>
  );
}
