import { ArrowRight, Plug, Settings2, Send } from 'lucide-react';
import {
  SupportCallToAction,
  SupportMarketingShell,
  SupportPageIntro,
} from '@/components/support/marketing-shell';
import { supportMetadata } from '@/lib/support/marketing';
import { zendeskAvailability } from '@/lib/support/zendesk-oauth';

export const metadata = supportMetadata(
  'Vos outils, connectés',
  'Découvrez les connexions de Zentra Support, leur disponibilité et les étapes pour recevoir et orienter vos tickets.',
  '/support/connexions',
);

export default async function SupportConnections() {
  const zendesk = await zendeskAvailability();
  const connectors = [
    {
      name: 'Infomaniak Mail',
      icon: 'I',
      status: 'Connexion directe',
      ready: true,
      text: 'Reliez votre boîte mail pour récupérer les nouveaux messages et les classer par catégorie et priorité dans Zentra Support.',
      detail:
        'Clé Infomaniak workspace:mail. Réception périodique en arrière-plan ; vos dossiers Infomaniak restent inchangés.',
    },
    {
      name: 'Freshdesk',
      icon: 'F',
      status: 'Installation guidée',
      ready: true,
      text: 'Connectez votre compte avec ses accès API, retrouvez vos équipes et configurez l’envoi des nouveaux tickets.',
      detail: 'Droits administrateur et accès API nécessaires.',
    },
    {
      name: 'Zendesk',
      icon: 'Z',
      status: zendesk.ready ? 'Connexion par autorisation' : 'En préparation',
      ready: zendesk.ready,
      text: zendesk.ready
        ? 'Autorisez Zentra depuis votre compte Zendesk, puis activez la réception des tickets avec le guide de connexion.'
        : 'La connexion est en cours de validation pour l’ouverture aux clients. Elle est actuellement limitée aux essais privés.',
      detail: zendesk.ready
        ? 'Lecture des tickets et équipes ; modification des priorités et affectations.'
        : 'Attendez sa disponibilité avant de souscrire pour Zendesk.',
    },
    {
      name: 'Gorgias',
      icon: 'G',
      status: 'Bientôt disponible',
      ready: false,
      text: 'Une connexion pour les équipes de commerce en ligne est prévue. Elle n’est pas encore ouverte aux clients.',
      detail: 'Aucune date de disponibilité garantie.',
    },
    {
      name: 'Votre outil',
      icon: '↗',
      status: 'API & webhooks',
      ready: true,
      text: 'Votre équipe technique peut envoyer des tickets et recevoir les décisions pour les appliquer dans votre outil, par exemple via Make ou n8n.',
      detail:
        'Intégration technique à configurer ; ce n’est pas une connexion universelle en un clic.',
    },
  ];
  return (
    <SupportMarketingShell>
      <SupportPageIntro
        eyebrow="CONNEXIONS"
        title={
          <>
            Gardez vos habitudes.
            <br />
            <em>Améliorez le parcours.</em>
          </>
        }
        description="Zentra Support se connecte à votre boîte Infomaniak ou à votre logiciel de service client. La disponibilité et les prérequis sont indiqués pour chaque connexion."
      />
      <section className="sp-wrap sp-section sp-section-first">
        <div className="sp-integrations sp-integrations-detailed">
          {connectors.map((item) => (
            <article key={item.name}>
              <div className="sp-integration-icon" aria-hidden="true">
                {item.icon}
              </div>
              <span
                className={`sp-status ${item.ready ? 'sp-status-ready' : ''}`}
              >
                {item.status}
              </span>
              <h2>{item.name}</h2>
              <p>{item.text}</p>
              <small>{item.detail}</small>
              {item.ready ? (
                <a
                  className="sp-text-link"
                  href="/support/espace?section=connections"
                >
                  Préparer la connexion <ArrowRight size={16} />
                </a>
              ) : (
                <a className="sp-text-link" href="mailto:info@zentraapp.ch">
                  Nous contacter <ArrowRight size={16} />
                </a>
              )}
            </article>
          ))}
        </div>
        <p className="sp-caption">
          Vérifiez aussi les options incluses dans votre abonnement au logiciel
          de support. Des fonctions API ou webhook peuvent dépendre de votre
          formule chez cet éditeur.
        </p>
      </section>
      <section className="sp-section sp-soft">
        <div className="sp-wrap">
          <div className="sp-section-title">
            <p className="sp-kicker">UNE CONNEXION, TROIS ÉTAPES</p>
            <h2>Un départ organisé.</h2>
          </div>
          <div className="sp-steps">
            <article>
              <div className="sp-step-top">
                <Plug size={23} />
                <span>01</span>
              </div>
              <h3>Autoriser votre outil</h3>
              <p>
                Choisissez la connexion dans votre espace. Vos accès au logiciel
                source servent uniquement à cette intégration ; aucun compte
                auprès d’un fournisseur d’analyse n’est demandé.
              </p>
            </article>
            <article>
              <div className="sp-step-top">
                <Settings2 size={23} />
                <span>02</span>
              </div>
              <h3>Choisir les destinations</h3>
              <p>
                Associez vos équipes aux catégories, définissez votre seuil et
                contrôlez les propositions sur des tickets d’essai.
              </p>
            </article>
            <article>
              <div className="sp-step-top">
                <Send size={23} />
                <span>03</span>
              </div>
              <h3>Activer la réception</h3>
              <p>
                Suivez le guide pour que les nouveaux tickets soient transmis
                automatiquement, puis vérifiez le premier traitement.
              </p>
            </article>
          </div>
        </div>
      </section>
      <SupportCallToAction />
    </SupportMarketingShell>
  );
}
