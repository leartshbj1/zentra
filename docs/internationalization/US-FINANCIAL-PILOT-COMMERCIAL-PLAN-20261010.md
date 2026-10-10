# Pilote commercial US — plan avant développement

10 octobre 2026. Base contrôlée : `41ef4d8`, arbre propre. Ce plan précède les
modifications de cette tranche. Les vérifications ci-dessous sont des critères,
pas des résultats annoncés.

## Résultat utilisable

Dans le pilote financier privé TEST existant : créer un client, créer et modifier
un devis, puis enregistrer son acceptation interne. Retrouver ces opérations sur
une autre session automatiquement, sur le même livre V5. Conserver les paiements,
rapports et exports existants. Aucun changement de production ou de données CH.

## Audit ciblé et réutilisation

- `us-financial-kernel-runtime.ts` et `us-financial-kernel-erp.ts` admettent déjà
  `save_customer`, `save_estimate`, `accept_estimate` dans le store cumulatif
  invoicing V5. Ces commandes ne produisent pas d'écritures comptables.
- `contacts.ts`, `erp-request.ts`, `invoicing.ts` et le runtime existant restent
  les validateurs métier, la numérotation et les contrôles de révision.
- Les wrappers privés de `20261010104148_international_us_financial_pilot_dto1.sql`
  délèguent ces commandes au même append V5. Aucune migration nouvelle identifiée.
- `UsFinancialPilotEstimateRow` n'a pas les lignes, notes et conditions : ajouter
  un détail public fermé, lié aux révisions du livre et du devis, pour l'édition.
- `browser-us-financial-pilot-session.ts` possède le polling silencieux, les
  admissions, annulations, générations et la reprise exacte des paiements.
  Étendre son verrou et son opération incertaine, sans second moteur concurrent.

## Contrats et découpage

Créer un contrat commercial public distinct sous `consumer:financial-pilot`,
`schemaVersion:1`, avec UUID de requête et révision globale attendue. Trois
intentions : création client, sauvegarde devis (création ou édition), acceptation
interne du devis. IDs nouveaux et organisation imposés par le serveur ; seuls
les IDs de documents existants sont des sélecteurs navigateur. IDs des nouvelles
lignes déterministes ; conserver les IDs des lignes existantes. Devise USD
imposée, quantités et minor units en chaînes canoniques, pas de flottants.

Reçu public fermé lié à la requête capturée : organisation, révision, entité et
action exacte. La reprise conserve la même enveloppe et les mêmes octets dans
l'instance. Aucun numéro, statut, rôle, total, grant, policy, preuve fiscale ou
clé privée transmis par le navigateur. Aucun faux indicateur de succès/rejeu.

Routes proposées : `POST financial-pilot/commercial/operations` et
`GET financial-pilot/estimates/[estimateId]?revision=N`. Réutiliser les ports
d'admission du pilote ; aucun accès member/read_only supplémentaire. Garde
Auth/D1 fraîche, flags fermés par défaut, grant et opt-in privés/versionnés,
US/USD/accrual et revalidation après attentes. Cookies same-origin seulement.

Ownership : contrat/mapper/projection et tests ; serveur/bindings/routes et
recette PostgreSQL ; composant/copy/CSS ; transport navigateur et intégration QA.
Pas de déplacement massif des fichiers ni de nouvelle dépendance.

## UX et exactitude

Étendre l'identité Operate existante, quatre langues FR/DE/IT/EN et thèmes clair/
sombre. Formulaires dans Clients et Devis, aperçu avant taxe, édition en ligne,
46px de cible, lignes empilées sur mobile. Aucun nouveau monde visuel ou image.
Recherche/sélection client complète par pagination, pas limitée aux 25 premiers.

Conserver les brouillons pendant changements d'onglet et polling. Si révision
modifiée, demander une révision explicite du brouillon ; ne pas remplacer ses
champs silencieusement. Pendant résultat incertain, verrouiller les nouvelles
mutations et proposer la reprise exacte. Révocation ou changement d'espace
efface les données et brouillons. Acceptation = confirmation interne enregistrée,
pas signature ni preuve d'accord externe. Total du devis avant sales tax.

## Critères de validation

1. Contrats fermés, limites, getters/prototypes/champs privés refusés ; calculs
   exacts, dates et adresses validées par les règles existantes.
2. HTTP vers PostgreSQL réel dans PGlite : client, devis, édition, acceptation,
   numérotation, mêmes données sur deux sessions et journal inchangé.
3. CAS global et révision devis périmés ; réponse perdue/reprise identique sans
   doublon ; même UUID avec autre contenu refusé. Source commande active PO008 et
   facture émise restent verrouillées ; reprise historique reste possible.
4. Révocation pendant attente, opt-in/grant périmés, isolation et refus natif.
5. Transport partagé : paiement et commercial ne peuvent écrire en parallèle,
   lectures périmées ignorées, brouillon conservé, rafraîchissement silencieux.
6. Inspection groupée desktop/mobile, quatre langues, deux thèmes, clavier ; une
   correction groupée puis confirmation bornée et revue indépendante.
7. Typecheck, lint ciblé, tests précédents conservés, suites nouvelles, build.

PGlite est PostgreSQL WASM sérialisé : cette recette ne prouve pas une charge
multi-connexion, un SLA ou la résistance aux crashes. Aucun succès ne sera
annoncé sans exécution. Rapport final aux huit rubriques et preuves figées.

## Limites et retour arrière

Pas d'émission de facture, de fournisseur fiscal, de paiement marchand, d'envoi
e-mail, de signature, de migration hébergée, de publication native ou de schéma
public ERP5 dans cette tranche. Les routes restent TEST/opt-in. Retour arrière :
désactiver les flags du pilote puis revenir au commit précédent, sans supprimer
les événements existants. Les prochaines tranches doivent garder ces événements
compatibles. L'objectif ERP US complet reste actif.

Documentation consultée avant implémentation : [Database Functions](https://supabase.com/docs/guides/database/functions)
et [Supabase changelog](https://supabase.com/changelog). Réutilisation de fonctions
security invoker, search_path vide, relations qualifiées, EXECUTE restreint et
gardes actuelles ; aucune nouvelle extension ou adaptation SDK requise ici.
