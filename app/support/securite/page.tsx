import { ArrowRight, KeyRound, ShieldCheck, UsersRound } from 'lucide-react';
import {
  SupportCallToAction,
  SupportMarketingShell,
  SupportPageIntro,
} from '@/components/support/marketing-shell';
import { supportMetadata } from '@/lib/support/marketing';

export const metadata = supportMetadata(
  'Sécurité et traitement des données',
  'Comprenez le traitement des tickets, les accès aux connexions et les contrôles humains dans Zentra Support.',
  '/support/securite',
);

export default function SupportSecurity() {
  return (
    <SupportMarketingShell>
      <SupportPageIntro
        eyebrow="SÉCURITÉ & DONNÉES"
        title={
          <>
            Savoir ce qui circule.
            <br />
            <em>Choisir ce qui s’applique.</em>
          </>
        }
        description="Un service client contient des informations importantes. Voici comment Zentra Support les utilise et les contrôles dont vous disposez."
      />
      <section className="sp-section sp-wrap sp-section-first">
        <div className="sp-steps">
          <article>
            <div className="sp-step-top">
              <KeyRound size={24} />
              <span>CONNEXIONS</span>
            </div>
            <h3>Accès chiffrés côté serveur</h3>
            <p>
              Les secrets de connexion à vos outils sont conservés chiffrés. Les
              utilisateurs n’ont pas à fournir de clé pour le service d’analyse
              de Zentra.
            </p>
          </article>
          <article>
            <div className="sp-step-top">
              <UsersRound size={24} />
              <span>ÉQUIPE</span>
            </div>
            <h3>Un espace d’entreprise</h3>
            <p>
              Les membres autorisés travaillent dans l’espace de leur
              entreprise. Les administrateurs configurent les connexions et les
              destinations de routage.
            </p>
          </article>
          <article>
            <div className="sp-step-top">
              <ShieldCheck size={24} />
              <span>DÉCISIONS</span>
            </div>
            <h3>Des contrôles avant l’action</h3>
            <p>
              Les décisions incertaines, les demandes humaines et les situations
              protégées restent à vérifier. Vous pouvez aussi choisir la
              validation manuelle.
            </p>
          </article>
        </div>
      </section>
      <section className="sp-section sp-soft">
        <div className="sp-wrap sp-control">
          <div>
            <p className="sp-kicker">LE PARCOURS DES DONNÉES</p>
            <h2>
              Du texte du ticket
              <br />
              <span>à son affectation.</span>
            </h2>
            <p>
              Zentra Support est un service en ligne. Il ne partage pas le
              fonctionnement local du logiciel Zentra Gestion.
            </p>
            <a className="sp-text-link" href="/confidentialite#support-ia">
              Consulter la confidentialité <ArrowRight size={16} />
            </a>
          </div>
          <ol className="sp-data-flow">
            <li>
              <strong>Réception</strong>
              <p>
                L’objet et le texte sont transmis depuis votre outil connecté.
                Les pièces jointes restent dans votre outil sauf activation de la réception fournisseurs vers Gestion. Les justificatifs sont alors conservés dans un espace privé de l’entreprise et leurs extraits utiles servent au préremplissage.
              </p>
            </li>
            <li>
              <strong>Analyse</strong>
              <p>
                Le texte est transmis à un prestataire d’analyse. Les
                fournisseurs et modalités sont détaillés dans la politique de
                confidentialité.
              </p>
            </li>
            <li>
              <strong>Historique et action</strong>
              <p>
                Le ticket, les décisions et les événements sont conservés dans
                votre espace. L’affectation autorisée est appliquée à votre
                outil.
              </p>
            </li>
          </ol>
        </div>
      </section>
      <section className="sp-section sp-wrap sp-faq">
        <div>
          <p className="sp-kicker">VOS CHOIX</p>
          <h2>
            Une relation
            <br />
            <span>transparente.</span>
          </h2>
        </div>
        <div>
          {[
            [
              'Puis-je arrêter l’envoi de nouveaux tickets ?',
              'Oui. Déconnecter l’outil arrête les nouveaux traitements. Son historique reste conservé ; la déconnexion ne constitue pas une suppression des données.',
            ],
            [
              'Comment demander un export ou une suppression ?',
              'Contactez info@zentraapp.ch en précisant l’espace concerné. Transmettez uniquement les données nécessaires et informez les personnes concernées du traitement de leurs tickets.',
            ],
            [
              'Les données restent-elles exclusivement en Suisse ?',
              'Ce service ne garantit pas un hébergement exclusivement suisse. Les prestataires et le traitement des données sont décrits dans les documents de confidentialité et de sous-traitance.',
            ],
            [
              'Une confiance élevée garantit-elle la bonne décision ?',
              'Non. Le score aide à décider quand automatiser, mais une erreur reste possible. Contrôlez vos règles et vos résultats, en particulier au démarrage.',
            ],
          ].map(([title, text]) => (
            <details key={title}>
              <summary>
                {title}
                <span aria-hidden="true">+</span>
              </summary>
              <p>{text}</p>
            </details>
          ))}
          <a className="sp-text-link" href="/sous-traitance">
            Traitement des données <ArrowRight size={16} />
          </a>
        </div>
      </section>
      <SupportCallToAction />
    </SupportMarketingShell>
  );
}
