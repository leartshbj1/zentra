import type { Metadata } from 'next';
import { ArrowRight, Download } from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import './comparison.css';

export const metadata: Metadata = {
  title: 'Zentra ou bexio ? Comparatif et reprise de vos données',
  description:
    'Comparez les prix, le travail en équipe, la comptabilité et les automatisations. Préparez la reprise de vos clients, fournisseurs et articles bexio dans Zentra.',
  alternates: { canonical: '/comparatif/bexio' },
};
const features = [
  [
    'Devis et factures QR',
    'Inclus dans toutes les formules Gestion.',
    'Inclus dans tous les forfaits.',
  ],
  [
    'Comptabilité',
    'Écritures, TVA et états comptables dans Gestion.',
    'Comptabilité incluse dans tous les forfaits.',
  ],
  [
    'Achats et catalogue',
    'Fournisseurs, achats et catalogue inclus.',
    'Produits et factures fournisseurs dès Advanced.',
  ],
  [
    'Projets, temps et stock',
    'Inclus dans toutes les formules Gestion.',
    'Disponibles dès Optima.',
  ],
  [
    'Banque',
    'Import de relevés CAMT et rapprochement à vérifier.',
    'Interfaces e-banking et rapprochement dès Advanced.',
  ],
  [
    'Façon de travailler',
    'Application installée, copie locale et partage de l’entreprise avec Internet.',
    'Logiciel dans le navigateur et application mobile bexio Go.',
  ],
  [
    'Automatisation des e-mails',
    'Support reçoit les messages. Automation peut préparer les achats et les rendez-vous dans Gestion, selon les connexions et réglages activés.',
    'Fonctions intégrées de facturation et comptabilité, complétées par des applications du Marketplace.',
  ],
] as const;
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
        <section className="page-intro page-width">
          <h1>
            Zentra ou bexio ?<br />
            <span>À vous de choisir.</span>
          </h1>
          <p>
            Deux façons de gérer une PME suisse.
            <br />
            Comparez ce qui compte pour votre entreprise.
          </p>
          <div className="page-actions">
            <a className="page-primary" href="#comparaison">
              Comparer les fonctions
              <ArrowRight size={17} />
            </a>
            <a className="page-text-link" href="#importer">
              Passer de bexio à Zentra
              <ArrowRight size={17} />
            </a>
          </div>
        </section>
        <section
          className="page-width comparison-intentions"
          aria-label="Les deux approches"
        >
          <article>
            <h2>Zentra</h2>
            <p className="comparison-statement">
              Votre gestion.
              <br />
              Reliée à votre quotidien.
            </p>
            <p>
              Les mêmes fonctions Gestion pour 1, 3 ou 10 personnes. Ajoutez
              Support pour vos messages et Automation pour les traitements que
              vous choisissez.
            </p>
            <a className="page-text-link" href="/complet">
              Découvrir les trois produits
              <ArrowRight size={17} />
            </a>
          </article>
          <article>
            <h2>bexio</h2>
            <p className="comparison-statement">
              La gestion en ligne.
              <br />
              Un écosystème établi.
            </p>
            <p>
              Des forfaits progressifs, des interfaces bancaires selon l’offre
              et un Marketplace d’applications. Votre fiduciaire peut travailler
              dans votre compte.
            </p>
            <a
              className="page-text-link"
              href="https://www.bexio.com/fr-CH/produits"
              target="_blank"
              rel="noreferrer"
            >
              Consulter le site bexio
              <ArrowRight size={17} />
            </a>
          </article>
        </section>
        <section className="page-section page-width" id="comparaison">
          <div className="page-section-heading">
            <h2>
              Le détail.
              <br />
              <span>Sans raccourcis.</span>
            </h2>
            <p>
              Les offres n’ont pas exactement le même périmètre. Voici les
              différences utiles à votre choix.
            </p>
          </div>
          <table className="comparison-table">
            <caption className="sr-only">
              Comparaison des fonctions Zentra Gestion et bexio
            </caption>
            <thead>
              <tr>
                <th scope="col">Votre besoin</th>
                <th scope="col">Zentra Gestion</th>
                <th scope="col">bexio</th>
              </tr>
            </thead>
            <tbody>
              {features.map(([title, zentra, bexio]) => (
                <tr key={title}>
                  <th scope="row">{title}</th>
                  <td>
                    <span
                      className="comparison-mobile-label"
                      aria-hidden="true"
                    >
                      Zentra
                    </span>
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
            Zentra ne revendique pas de certification Swissdec ni de connexion
            e-banking équivalente à celle de bexio. Les fonctions et quotas de
            Support et Automation dépendent de l’abonnement et des connexions
            activées.
          </p>
        </section>
        <section className="page-band" id="tarifs">
          <div className="page-width">
            <div className="page-section-heading">
              <h2>
                Des prix.
                <br />
                <span>Avec leur contexte.</span>
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
                  {[
                    ['Solo', '1 personne', '49'],
                    ['Start', '3 personnes', '59'],
                    ['Pro', '10 personnes', '89'],
                  ].map(([name, seats, price]) => (
                    <div key={name}>
                      <dt>
                        {name}
                        <small>{seats}</small>
                      </dt>
                      <dd>
                        {price}
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
                <p>Abonnement mensuel · prix hors TVA</p>
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
              </article>
            </div>
            <div className="comparison-pack">
              <div>
                <h3>Et si vous réunissiez les trois ?</h3>
                <p>
                  Zentra Complet réunit Gestion, Support et Automation dès 79
                  CHF par mois.
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
