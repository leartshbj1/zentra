# US SaaS lifecycle TEST — livraison locale

10 octobre 2026, Europe/Zurich. Base `05e47ae308488055b48438958f58782cf6917b99`, branche `codex/international-runtime`. Cette étape prolonge l'admission initiale USD TEST. Elle ne constitue ni un lancement commercial américain ni un déploiement hébergé. L'objectif ERP international reste actif.

## 1. Modifications

Le renouvellement ajoute une période intégralement payée au même abonnement, entreprise, client, compte Stripe TEST, offre et nombre de personnes. L'autorité initiale et sa preuve restent immuables. Les consommateurs Gestion, Automation, Team et appareils lisent une projection effective commune. La découverte des entreprises et les replays d'admission conservent leur identité initiale.

Un paiement en attente ou une annulation ne prolonge pas l'accès ; une période déjà prouvée reste utilisable jusqu'à sa fin exclusive. Un remboursement réussi, même partiel, ou une contestation confirmée, y compris d'une ancienne facture de ce même abonnement, restreint terminalement l'abonnement selon une **politique pilote conservatrice**, sans supprimer l'entreprise ni son historique. Un paiement tardif ne réactive pas une autorité révoquée. Une contestation gagnée reste soumise à revue manuelle ; cette politique commerciale devra être approuvée avant production.

Le gateway relit les objets réels par leurs relations de premier niveau : facture, Invoice Payments, PaymentIntent, Charge et abonnement. Les métadonnées ne fondent aucun droit. Les événements servent à localiser ; leur ordre ne détermine pas l'autorité. Les lectures finales détectent les changements pendant la vérification, avec une limite de 30 secondes pour cette observation. Stripe ne garantit pas l'ordre de livraison des événements. [Webhooks Stripe](https://docs.stripe.com/webhooks), [événements d'abonnement et remboursements](https://docs.stripe.com/billing/subscriptions/webhooks).

Le store écrit observation et période, ou observation et révocation, dans un batch avec clés étrangères différées. Un retry du même fait conserve le premier instant enregistré. Un même événement peut, après nouvelle lecture, établir un fait différent, notamment un remboursement ultérieur. L'état du catalogue, de l'entreprise et de la liaison persistée est revérifié autour des attentes réseau et des écritures.

Un renouvellement conserve une session appareil encore valable sans modifier son expiration ni celle du droit capturé. Après sa propre échéance, une nouvelle association est nécessaire. Les quotas Automation gardent leur clé entreprise/environnement/mois ; un renouvellement ne les remet pas à zéro. Les permissions et capacités de schéma restent contrôlées séparément.

## 2. Fichiers créés

- `lib/international/us-saas-test-lifecycle-contract.ts` : contrat privé, validation, observation marquée et matérialisation canonique.
- `lib/international/us-saas-test-lifecycle-server.ts` et `us-saas-test-lifecycle-bindings.ts` : handlers, configuration sandbox, signature et composition interne.
- `lib/international/us-saas-test-lifecycle-stripe.ts` : gateway Stripe de lecture, distinct de l'admission initiale.
- `lib/international/us-saas-test-lifecycle-d1.ts` : liaison persistée, historique atomique, replay et restriction terminale.
- `lib/international/us-saas-test-lifecycle-{server,stripe,d1}.test.ts`, `us-saas-test-lifecycle-test-fixture.ts`, `us-team-device-lifecycle.test.ts` : tests et fixtures explicitement fictives.
- `app/api/international/billing/test/lifecycle/webhook/route.ts` : endpoint dédié dynamique.
- `drizzle/0092_international_us_saas_test_lifecycle.sql` : extension versionnée D1.
- Ce document, le plan `US-SAAS-LIFECYCLE-TEST-PLAN-20261010.md` et `docs/evidence/us-saas-lifecycle-test-20261010.json` : périmètre, résultats et inventaire reproductible.

## 3. Fichiers modifiés

- `saas-authority-d1.ts` : projection effective par défaut, revalidation complète des périodes et de l'autorité Automation ; mode historique explicite réservé aux anciennes fixtures.
- `us-saas-test-server.ts`, `us-saas-test-bindings.ts` et leurs tests : dispatch lifecycle après signature vérifiée, configuration isolée et maintien de l'admission stricte.
- `us-device-{bindings,d1,server}.ts` et les tests/fixtures associés : projection effective et borne capturée non extensible.
- `us-team-{bindings,store}.ts`, leurs tests et `us-team.workerd.test.ts` : projection effective et compatibilité explicite des fixtures antérieures.
- `saas-authority.test.ts`, `saas-authority.workerd.test.ts`, `lib/account-workspaces.test.ts` : ancienne admission testée explicitement sans fallback runtime.
- `US-STAGING-READINESS-20261010.md` : chaîne D1 0092 et distinction entre résultat local et hébergement.

Le manifeste fournit la liste exhaustive et les empreintes des fichiers. Aucun déplacement massif, modification des offres CHF ou changement du frontend public/natif dans cette phase.

## 4. Migration proposée et rollback

Wrangler a généré localement 0092. Elle ajoute deux relations d'historique, des contraintes/gardes, un index et la vue effective, puis adapte les gardes Team/appareils dans la nouvelle migration. Elle ne réécrit pas 0087–0091 et ne backfill pas une période ou un pays. Les tests SQLite chargent la chaîne réelle 0000–0092 avec clés étrangères activées. Aucun SQL PostgreSQL n'est modifié ni appliqué, aucune région déplacée.

**0092 doit précéder le nouveau runtime.** Les lecteurs effectifs refusent un schéma manquant ; ils ne reviennent pas silencieusement à l'ancienne autorité. Avant tout déploiement approuvé, rapprocher l'historique et les objets D1 réellement hébergés ; le journal Drizzle incomplet n'autorise pas un replay aveugle.

Fermer `INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_ENABLED` arrête l'ingestion ; cela n'efface pas les droits payés déjà enregistrés. Conserver un lecteur compatible avec 0092. Revenir à un lecteur initial seul ferait perdre les renouvellements observés. Une fermeture ERP peut suspendre plus largement l'accès. Ne jamais effacer les reçus, annuler une révocation, supprimer des entreprises ou réécrire une migration pour revenir en arrière. La restauration des wrappers CH PostgreSQL relève de la procédure distincte documentée dans la readiness.

Le secret dédié est `INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET` pour `/api/international/billing/test/lifecycle/webhook`. L'endpoint initial compose aussi le lifecycle **après** vérification de son propre secret SaaS initial ; les deux secrets ne sont pas interchangeables. Core, Creation et SaaS TEST restent des gates prérequises. Leur fermeture arrête aussi les nouvelles restrictions sans retirer les droits déjà enregistrés. La configuration invalide est refusée ; un catalogue vide valide peut laisser passer une restriction, jamais accorder une nouvelle période ou un nouvel achat.

## 5. Tests exécutés et résultats

**1 060/1 060 tests sélectionnés passent sur 33 fichiers**, sans échec, suite en échec, skip/pending ou todo. TypeScript global et lint avec vérification de types passent ; le lint couvre les 28 fichiers TS/TSX créés ou modifiés. Les résultats finaux, commandes, empreintes et codes de sortie figurent dans le manifeste de cette phase. Les sélections ciblées et la sélection commune se chevauchent : elles ne s'additionnent pas.

Parmi ces tests : 205 couvrent les gateways initial/lifecycle, 91 la persistance lifecycle et l'autorité initiale historique, 203 les consommateurs Team/appareils et 70 les boundaries HTTP/configuration ciblées après la correction du catalogue vide. Ces sous-totaux viennent de sélections chevauchantes et ne doivent pas être ajoutés au total. Les régressions sélectionnées incluent création d'entreprise, autorité, Automation, découverte, onboarding et Stripe CH.

Les tests couvrent le renouvellement après expiration initiale, période future/passée, gap, replay, réponse perdue, paiement tardif après révocation, remboursement d'une ancienne facture, événements hors ordre, compte/devise/offre/entreprise étrangers, marque privée copiée, observation périmée, gate fermée, schéma manquant et modification concurrente de configuration. Les tests de consommateurs utilisent les bindings/store/gardes SQL réels jusqu'à 0092 ; Auth et PostgreSQL y restent explicitement simulés.

Les tests gateway utilisent également le SDK Stripe installé **22.6.0**, API **2026-08-26.dahlia**, avec transport fetch simulé. Ils valident notamment son hydratation Decimal bornée et les relations PaymentIntent/Invoice Payments ; aucun appel prestataire n'a été effectué. Les tests SQLite ne prouvent pas les transactions ou la concurrence workerd D1 hébergées. Les fichiers workerd historiques adaptés ne sont pas présentés comme exécutés lorsqu'ils nécessitent leur opt-in.

Le contrôle des assets de marque et la compilation par défaut avec profil **production** passent. Les deux variables de sélection du build ont été retirées dans le shell de compilation ; la nouvelle fonction reste fermée dans ce profil. Les notices existantes de dépréciation middleware et de classement statique des routes restent visibles dans le log. Le contrôle des différences ne signale pas d'erreur.

Aucun écran n'a changé : pas de nouvelle recette visuelle ou de capture dans cette phase. Les régressions CH exécutées sont ciblées sur Stripe ; ni l'ensemble QR/TVA natif ni des appareils physiques ne sont implicitement retestés. Les anciens rapports d'échec restent conservés, distincts des rapports finaux.

Les premiers essais ont notamment signalé un module/options non encore intégrés pendant le travail parallèle, un stub sandbox conservé entre deux tests et quatre diagnostics de lint dans les tests D1 ; ils ont été corrigés. La revue indépendante a ensuite trouvé le refus des révocations avec un catalogue vide dans la vraie configuration, malgré un test serveur injecté passant. Le correctif est maintenant testé avec les signatures SDK et les deux handlers réels, avec ports prestataire/store simulés explicitement ; une première fixture avait un mauvais compte Stripe et a été corrigée sans affaiblir le contrôle de compte. Les rapports antérieurs restent identifiables.

## 6. Risques et limites

- TEST uniquement, même offre et paiement carte intégral capturé. Changements de plan, essais, prorations, remises, crédits, paiement hors Stripe, preuve non carte, paiements ambigus ou multiples sur un même PaymentIntent restent refusés/non pris en charge. Checkout peut afficher d'autres moyens dynamiques : cela ne valide pas leurs preuves.
- La recherche Invoice Payments est bornée à 100 et refuse une liste tronquée ou ambiguë. Une annulation personnalisée avant la fin de période n'est pas une règle supportée. [Annulation Stripe](https://docs.stripe.com/billing/subscriptions/cancel).
- Un webhook perdu ou non enregistré n'est pas détecté par ce milestone. Pas encore de réconciliation indépendante périodique ; une annulation arrivée avant un renouvellement payé non reçu peut laisser ce renouvellement non récupéré. Ne pas promettre une synchronisation Stripe instantanée et permanente.
- Un remboursement pending/requires_action, un graphe ambigu/tronqué ou un statut de contestation non supporté refuse l'observation sans retirer automatiquement les droits existants. Prévoir la reprise et la revue manuelle ; un événement refusé ne signifie pas que l'ensemble de l'accès applicatif a été révoqué.
- La recette locale n'établit ni Auth/Supabase/D1/Stripe hébergés, ni la propagation réelle entre appareils, ni la capacité à servir 150 entreprises. Les objets et permissions du sandbox, les signatures réelles et les formes d'objets doivent être recettés après approbation de staging.
- Le mode fiscal reste `sandbox_no_tax`. Les taxes des abonnements SaaS, obligations/registrations et choix du prestataire fiscal restent à valider avant toute vente US ; activer Stripe Tax sans inscription appropriée ne suffit pas. [Taxes sur abonnements](https://docs.stripe.com/billing/taxes/collect-taxes).
- La clé SaaS TEST dédiée et les secrets webhook doivent rester dans les secrets serveur, jamais dans les apps ou les logs. Le paiement des abonnements Zentra demeure distinct des encaissements des factures de ses entreprises clientes.

## 7. Terminé localement

Le lifecycle TEST à offre constante, sa preuve privée, son historique atomique, les restrictions terminales et la consommation commune des périodes sont implémentés. Les portes de production restent fermées. Aucun compte client, prix Stripe, secret, ressource, migration hébergée, site publié ou artefact natif n'a été modifié. Les autres checkouts public/natif sont conservés.

## 8. Expérimental et prochaine étape

Préparer puis exécuter uniquement après approbation le staging isolé avec historique réconcilié, véritables Auth/D1/PG et sandbox Stripe dédié. Vérifier deux identités, renouvellement, annulation, remboursement/contestation, panne/rejeu, droits et expiration des appareils. Avant lancement commercial, compléter la réconciliation des événements et faire valider la politique de restriction et la fiscalité.

L'ERP US complet exige encore notamment les documents originaux et archives, workflows Support/Automation américains, paiements des clients, fonctions commerciales restantes et validations professionnelles comptables/fiscales/juridiques. Cette livraison ne les déclare pas terminés.
