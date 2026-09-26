import type { Metadata } from 'next';
import { ArrowRight, Download } from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { ZENTRA_PLANS } from '@/lib/plans';
import { completePlan } from '@/lib/complete/plans';
import './comparison.css';

export const metadata: Metadata = {
  title: 'Zentra ou bexio ? Les avantages de Zentra pour votre PME',
  description:
    'Projets, stock et fiches de salaire dès Zentra Gestion Solo. Découvrez les différences avec bexio, le pack Gestion + Support + Automation et l’import de vos données.',
  alternates: { canonical: '/comparatif/bexio' },
};
const features = [
  [
    'Projets et suivi du temps',
    'Inclus dès Solo',
    'Documents, temps et suivi de vos projets dans Gestion.',
    'Dès Optima.',
  ],
  [
    'Gestion du stock',
    'Inclus dès Solo',
    'Articles, mouvements et disponibilités dans Gestion.',
    'Dès Optima.',
  ],
  [
    'Achats et catalogue',
    'Inclus dès Solo',
    'Fournisseurs, factures d’achat et articles au même endroit.',
    'Produits et factures fournisseurs dès Advanced.',
  ],
  [
    'Fiches de salaire',
    'Inclus dès Solo',
    'Sans option paie à ajouter. Pas de certification ni de transmission Swissdec ELM.',
    'Indisponible en Basic, en option avec Advanced et Optima, incluse avec Ultimate. Solution certifiée Swissdec.',
  ],
  [
    'Devis, factures et comptabilité',
    'Inclus dès Solo',
    'Factures QR, écritures, TVA, bilan et compte de résultat.',
    'Inclus dans tous les forfaits.',
  ],
  [
    'Gestion et demandes clients',
    'Réunis dans Zentra Complet',
    'Support classe et oriente les messages. Automation relie les factures reçues aux achats et les rendez-vous à l’agenda de Gestion.',
    'Fonctions de gestion complétées par des applications tierces du Marketplace, selon leurs offres et connexions.',
  ],
  [
    'Sur votre ordinateur',
    'Une application avec copie locale',
    'Travaillez sur les données disponibles sur l’appareil. Le partage et les services connectés utilisent Internet.',
    'Solution cloud dans le navigateur, complétée sur mobile par bexio Go.',
  ],
  [
    'Rapprochement bancaire',
    'Import des relevés CAMT',
    'Rapprochement à vérifier dans Gestion ; pas de connexion bancaire directe équivalente.',
    'Interfaces e-banking et rapprochement dès Advanced.',
  ],
] as const;
const solo = ZENTRA_PLANS[0];
const completeSolo = completePlan('solo')!;
const sources = [
  ['Tarifs bexio', 'https://www.bexio.com/fr-CH/packages-et-prix'],
  [
    'Fonctions par forfait',
    'https://cdn.www.bexio.com/assets/content_craft/documents/bexio/compare-packages-fr.pdf',
  ],
  [
    'Exporter les données bexio',
    'https://help.bexio.com/s/article/000001647?language=fr',
  ],
  [
    'Structure des contacts',
    'https://help.bexio.com/s/article/000002422?language=fr',
  ],
  [
    'Structure des produits',
    'https://help.bexio.com/s/article/000001781?language=fr',
  ],
  ['Applications bexio Marketplace', 'https://marketplace.bexio.com/fr-CH/home'],
] as const;
export default function BexioComparison() {
  return (
    <>
      <a href="#contenu" className="site-skip-link">
        Aller au contenu
      </a>
      <SiteHeader />
      <main
        id="contenu"
        tabIndex={-1}
        className="polished-page bexio-comparison"
      >
        <section className="page-width comparison-hero">
          <div>
            <h1>
              Zentra ou bexio ?<br />
              <span>Plus de fonctions.<br />Dès le départ.</span>
            </h1>
            <p className="comparison-lead">
              Projets, stock, achats et fiches de salaire : avec Zentra Gestion,
              tout cela est inclus dès Solo, à {solo.priceChfCents / 100} CHF par mois.
            </p>
            <div className="page-actions">
              <a className="page-primary" href="/pricing">
                Choisir Zentra <ArrowRight size={17} />
              </a>
              <a className="page-text-link" href="#comparaison">
                Voir les différences <ArrowRight size={17} />
              </a>
            </div>
          </div>
          <div className="comparison-proof">
            <h2>Ce que vous gagnez avec Zentra.</h2>
            <dl>
              <div><dt>Vos fonctions Gestion, dès Solo.</dt><dd>Chez bexio, projets et stock commencent avec Optima. Chez Zentra, ils sont déjà inclus dans la première formule.</dd></div>
              <div><dt>Votre équipe choisit la formule.</dt><dd>1, 3 ou 10 personnes : les mêmes fonctions Gestion. Les fiches de salariés ne consomment pas d’accès.</dd></div>
              <div><dt>Vos messages deviennent des actions.</dt><dd>Le pack Complet relie Gestion, Support et Automation dès {completeSolo.priceChfCents / 100} CHF par mois.</dd></div>
            </dl>
            <a className="page-text-link" href="#importer">Déjà sur bexio ? Préparer mon passage <ArrowRight size={17} /></a>
          </div>
        </section>
        <section className="comparison-workflow page-band" aria-labelledby="workflow-title">
          <div className="page-width comparison-workflow-layout">
            <div>
              <h2 id="workflow-title">Le vrai plus ?<br /><span>Tout se rejoint.</span></h2>
              <p>Un message dans Support. Une information utile dans Gestion.
                Automation fait le lien, selon les règles de votre entreprise.</p>
              <a className="page-text-link" href="/complet">Découvrir Zentra Complet <ArrowRight size={17} /></a>
            </div>
            <div className="comparison-workflow-examples">
              <article>
                <h3>Une facture arrive par e-mail.</h3>
                <p>Support la classe. Automation en extrait les informations et retrouve ou propose le fournisseur. L’achat est préparé dans Gestion.</p>
                <p className="comparison-outcome">À vérifier, ou à comptabiliser selon vos règles.</p>
              </article>
              <article>
                <h3>Un rendez-vous est confirmé.</h3>
                <p>La date, l’heure et les informations reçues peuvent rejoindre l’agenda de Gestion. Votre équipe retrouve le rendez-vous dans son espace.</p>
                <p className="comparison-outcome">Le message et votre activité restent reliés.</p>
              </article>
              <p className="comparison-note">Avec les trois produits actifs, une messagerie compatible et la même entreprise reliée. Les cas incertains restent à valider ; les traitements vers Gestion nécessitent l’application ouverte et connectée.</p>
            </div>
          </div>
        </section>
        <section className="page-section page-width" id="comparaison">
          <div className="page-section-heading">
            <h2>
              Là où Zentra
              <br />
              <span>fait la différence.</span>
            </h2>
            <p>
              Les fonctions Gestion sont incluses dans toutes nos formules.
              Le pack Complet ajoute Support et Automation.
            </p>
          </div>
          <table className="comparison-table">
            <caption className="sr-only">
              Comparaison des fonctions Zentra Gestion et bexio
            </caption>
            <thead>
              <tr>
                <th scope="col">Votre besoin</th>
                <th scope="col">Zentra</th>
                <th scope="col">bexio</th>
              </tr>
            </thead>
            <tbody>
              {features.map(([title, benefit, zentra, bexio]) => (
                <tr key={title}>
                  <th scope="row">{title}</th>
                  <td>
                    <span
                      className="comparison-mobile-label"
                      aria-hidden="true"
                    >
                      Zentra
                    </span>
                    <strong className="comparison-benefit">{benefit}</strong>
                    {zentra}
                  </td>
                  <td>
                    <span
                      className="comparison-mobile-label"
                      aria-hidden="true"
                    >
                      bexio
                    </span>
                    {bexio}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="comparison-note">
            Comparaison des fonctions intégrées, selon les{' '}
            <a href={sources[1][1]} target="_blank" rel="noreferrer">forfaits officiels bexio</a>.
            {' '}bexio propose également la numérisation intelligente de factures et des rappels automatiques.
            Les quotas de Support et Automation dépendent de votre offre ; les applications tierces bexio ont leurs propres conditions.
          </p>
        </section>
        <section className="page-band" id="tarifs">
          <div className="page-width">
            <div className="page-section-heading">
              <h2>
                Choisissez votre équipe.
                <br />
                <span>Gardez vos fonctions.</span>
              </h2>
              <p>
                Tarifs vérifiés le 26 septembre 2026. Les utilisateurs ne sont
                pas répartis de la même manière entre les formules.
              </p>
            </div>
            <div className="comparison-pricing">
              <article>
                <h3>Zentra Gestion</h3>
                <p>Abonnement mensuel · titulaire compris</p>
                <dl>
                  {ZENTRA_PLANS.map(({name, seats, priceChfCents}) => (
                    <div key={name}>
                      <dt>
                        {name}
                        <small>{seats} {seats === 1 ? 'personne' : 'personnes'}</small>
                      </dt>
                      <dd>
                        {priceChfCents / 100}
                        <small>CHF / mois</small>
                      </dd>
                    </div>
                  ))}
                </dl>
                <p>
                  Les mêmes fonctions de Gestion. Zentra n’est actuellement pas
                  assujettie à la TVA suisse : aucune TVA n’est ajoutée à ces
                  tarifs.
                </p>
                <a className="page-text-link" href="/pricing">
                  Voir les formules Zentra
                  <ArrowRight size={17} />
                </a>
              </article>
              <article>
                <h3>bexio</h3>
                <p>Tarifs mensuels habituels · hors TVA et promotion</p>
                <dl>
                  {[
                    ['Basic', '1 utilisateur', '45'],
                    ['Advanced', '2 utilisateurs', '52'],
                    ['Optima', '5 utilisateurs', '79'],
                    ['Ultimate', '25 utilisateurs', '129'],
                  ].map(([name, seats, price]) => (
                    <div key={name}>
                      <dt>
                        {name}
                        <small>{seats}</small>
                      </dt>
                      <dd>
                        {price}
                        <small>CHF / mois HT</small>
                      </dd>
                    </div>
                  ))}
                </dl>
                <p>
                  Avec paiement annuel en une fois : 35, 42, 69 ou 119 CHF HT
                  par mois selon le forfait. Les fonctions varient selon l’offre
                  ; options et conditions à vérifier chez bexio.
                </p>
                <a
                  className="page-text-link"
                  href={sources[0][1]}
                  target="_blank"
                  rel="noreferrer"
                >
                  Voir les conditions bexio
                  <ArrowRight size={17} />
                </a>
                <p className="comparison-promotion">
                  <strong>Promotion constatée le 26 septembre 2026 :</strong>{' '}
                  −40 % la première année pour les nouveaux clients jusqu’au 30 septembre 2026,
                  dès Advanced avec le code bx40. Soit 31.20, 47.40 ou 77.40 CHF HT par mois
                  en facturation mensuelle, selon le forfait.
                </p>
              </article>
            </div>
            <div className="comparison-pack">
              <div>
                <h3>Gestion. Support. Automation. Un seul pack.</h3>
                <p>
                  Zentra Complet Solo : {completeSolo.priceChfCents / 100} CHF par mois,
                  {' '}{completeSolo.seats} personne et {completeSolo.analyses.toLocaleString('fr-CH')} analyses mensuelles.
                </p>
              </div>
              <a className="page-text-link" href="/complet">
                Découvrir le pack
                <ArrowRight size={17} />
              </a>
            </div>
          </div>
        </section>
        <section className="page-section page-width" id="importer">
          <div className="page-section-heading">
            <h2>
              Changez d’outil.
              <br />
              <span>Gardez vos repères.</span>
            </h2>
            <p>
              Reprenez vos clients, fournisseurs et articles depuis un export
              bexio. Votre fichier est lu dans l’application.
            </p>
          </div>
          <p className="comparison-note">
            Import disponible dans Zentra Gestion pour Windows, dès la version
            1.90.0. Effectuez la reprise sur votre PC, dans l’entreprise souhaitée.
          </p>
          <ol className="comparison-import-steps">
            <li>
              <div>
                <h3>Exportez depuis bexio.</h3>
                <p>
                  Dans Contacts, filtrez les clients puis les fournisseurs et
                  exportez chaque liste en Excel, avec les adresses principales.
                  Exportez le catalogue séparément depuis Produits.
                </p>
                <a href={sources[2][1]} target="_blank" rel="noreferrer">
                  Ouvrir le guide d’export bexio
                </a>
              </div>
            </li>
            <li>
              <div>
                <h3>Choisissez votre entreprise Zentra.</h3>
                <p>
                  Dans l’application, ouvrez{' '}
                  <strong>Paramètres → Importer depuis bexio</strong>.
                  Choisissez Clients, Fournisseurs ou Articles et services, puis
                  votre fichier .xlsx ou .csv.
                </p>
              </div>
            </li>
            <li>
              <div>
                <h3>Vérifiez. Puis ajoutez.</h3>
                <p>
                  Contrôlez les colonnes et l’aperçu. Les contacts qui portent
                  déjà le même nom sont écartés sans écraser les fiches
                  existantes. Pour les articles, vérifiez les références, les
                  prix en CHF et la TVA.
                </p>
              </div>
            </li>
          </ol>
          <details className="comparison-scope">
            <summary>Ce qui est repris, et ce qui reste à préparer</summary>
            <div>
              <p>
                <strong>Contacts :</strong> nom, entreprise, interlocuteur,
                e-mail, téléphone, adresse principale et notes, selon les
                colonnes choisies. La référence bexio est conservée dans les
                notes. Un contact client et fournisseur s’importe dans chacune
                des deux listes.
              </p>
              <p>
                <strong>Catalogue :</strong> référence, désignation,
                description, unité, prix d’achat et de vente et taux de TVA. Les
                montants sont enregistrés au centime ; les codes TVA bexio
                doivent être convertis en taux vérifiés.
              </p>
              <p>
                <strong>Non repris :</strong> anciennes factures, devis,
                paiements, écritures, soldes, pièces jointes, adresses
                secondaires, liens entre contacts, niveaux de stock et tarifs
                échelonnés. Conservez vos archives bexio. Préparez votre date de
                bascule et vos soldes avec votre fiduciaire avant de tenir la
                comptabilité dans Zentra.
              </p>
              <p>
                Fichiers .xlsx, .csv ou .tsv, jusqu’à 20 Mo et 5 000 lignes par
                import. L’import est disponible dans Zentra 1.90.0 pour Windows
                ; vérifiez la version de l’application avant de commencer.
              </p>
            </div>
          </details>
          <div className="page-actions">
            <a className="page-primary" href="/download">
              <Download size={18} />
              Télécharger Zentra
            </a>
            <a className="page-text-link" href="/pricing">
              Choisir ma formule
              <ArrowRight size={17} />
            </a>
          </div>
        </section>
        <section
          className="page-width comparison-sources"
          aria-labelledby="sources"
        >
          <h2 id="sources">Un comparatif vérifiable.</h2>
          <p>
            Comparatif rédigé par Zentra, sans affiliation ni partenariat avec
            bexio. Informations consultées le 26 septembre 2026 ; les offres
            peuvent évoluer.
          </p>
          <ul>
            {sources.map(([label, href]) => (
              <li key={href}>
                <a href={href} target="_blank" rel="noreferrer">
                  {label}
                </a>
              </li>
            ))}
          </ul>
          <p>
            Pour Zentra : <a href="/features">fonctions Gestion</a>,{' '}
            <a href="/pricing">tarifs</a>, <a href="/automation">Automation</a>{' '}
            et <a href="/security">données et sécurité</a>.
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
