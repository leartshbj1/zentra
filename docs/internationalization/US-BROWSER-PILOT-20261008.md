# Parcours navigateur US — livraison locale et limites

Base : `cc1e268e0945dde1c41dcc05d0297f55ea062c90`. Travail local isolé, sans migration ni déploiement. Les éditions CH et les droits historiques restent inchangés.

Cette tranche relie une interface réelle aux API ERP existantes : lecture d'un espace US admis, initialisation explicite de sa période par le propriétaire, ajout de client, création de devis puis enregistrement interne de son acceptation. Elle ne simule pas un paiement d'abonnement, un fournisseur fiscal ou une émission de facture.

Le transport utilise la session cookie du navigateur et une seule mutation à la fois. Après une réponse ambiguë, il conserve exactement la requête et sa clé en mémoire, propose une reprise explicite, et n'invente jamais une seconde commande. Les conflits imposent une relecture et une décision de l'utilisateur. Il n'y a ni stockage persistant de données financières, ni écriture hors ligne, ni claim de droits envoyé par le navigateur. La perte de cette mémoire au rechargement doit être signalée et compensée par la lecture de l'état serveur avant une nouvelle saisie.

L'interface doit respecter les rôles, protéger les brouillons pendant les lectures, présenter les erreurs simplement et conserver FR/DE/IT/EN, les montants USD exacts et le thème du compte. L'acceptation enregistrée n'est pas une signature électronique ni une preuve de consentement client. La facturation reste indisponible tant que vendeur et fiscalité fiables ne sont pas configurés.

Fichiers prévus : transport et tests dans `lib/international/browser-erp-session.*`, composant et CSS `components/account/us-erp-workbench.*`, catalogue `lib/international/browser-workbench-copy.ts`, tests associés, intégration page US et navigation/copie de compte, rapport et preuve. Réutiliser les endpoints, sans nouveau SQL ou autorité de licence.

Validation prévue : réseau perdu après commit, reprise exacte, conflits, changement de compte, réponse invalide, absence d'écriture répétée ; rôles et entrée fermée ; rendu réel clair/sombre en quatre langues à 320/390/1440 px ; parcours interactif contre le moteur local et tests PGlite/D1 pertinents. Les mocks et bases locales restent distincts d'un essai staging Auth/Stripe/taxe ou multi-appareils réel.

## Modifications terminées

`?reglage=gestion` ouvre le composant réel dans une entreprise US déjà admise, après vérification des flags, du membre, des droits, de l'identité actuelle et de son rôle. La navigation et le catalogue de compte proposent ce parcours dans les quatre langues. Les chemins et abonnements CH restent distincts.

Le transport cookie possède une seule enveloppe immuable en mémoire. Réponse perdue, erreur après commit, JSON invalide ou délai de 30 secondes ne créent jamais une seconde commande. Le bouton de reprise conserve la clé et le corps exacts. Les conflits explicites de révision/idempotence exigent une lecture fraîche puis une confirmation manuelle. Les anciennes lectures sont refusées après mutation, refus d'accès ou arrivée d'une lecture plus récente. Le `commandHash` est vérifié au format SHA256 ; le navigateur ne le recalcule pas.

Le compte attendu, donné par le rendu serveur, est lié à chaque requête par `X-Zentra-Expected-User`. Ce champ restreint une identité Auth déjà vérifiée ; il n'accorde aucun droit. ERP, révision et changements refusent une divergence avant configuration, base et compteurs. Son absence conserve les clients historiques. Les délais, changements de props/compte et événements Auth ne peuvent republier des données arrivées en retard ; les formulaires privés sont purgés lors d'un refus 401/402/403.

Les opérations restent explicites : période choisie par le propriétaire, client avec adresse US validée, devis avec quantités rationnelles et prix USD exacts, puis confirmation d'une acceptation interne. Les données affichées proviennent de l'état enregistré, sans documents optimistes. Une sauvegarde confirmée vide uniquement son formulaire ; lectures manuelles, autres brouillons et conflits sont préservés. Les totaux restent des sous-totaux avec taxe à déterminer. Aucun bouton d'émission ou paiement n'est activé.

## Fichiers livrés

Créés : `components/account/us-erp-workbench.tsx`, `us-erp-workbench.css` ; `lib/international/browser-erp-session.ts`, `browser-erp-session.test.ts`, `browser-workbench-copy.ts`, `browser-workbench.test.ts`, `browser-workbench.browser.test.ts`, `browser-actor-binding.test.ts` ; `scripts/qa-us-browser-regression.mjs` ; ce rapport et `docs/evidence/us-browser-pilot-20261008.json`.

Modifiés : `app/compte/espaces/us/[organizationId]/page.tsx`, `components/account/account-shell.tsx`, `lib/account-workspace-copy.ts`, `lib/account-workspace-pages.test.ts`, `lib/international/read-admission.ts`, `runtime-server.ts`, `runtime-sync-server.ts`.

## Validation exécutée

- 54 tests propres au transport, 42 à l'interface/commandes, 10 à la liaison d'identité. Dernière confirmation de ces fichiers et de la page de compte : **141 tests passent**. Ces comptages sont inclus dans les résultats sélectionnés ci-dessous.
- Régression sélectionnée de 84 fichiers : premier passage **2 246 tests passent, quatre échouent, 64 ignorés**. Les quatre erreurs sont des connexions/services Miniflare/workerd locales. Les deux fichiers concernés ont été rejoués seuls, en série : **162 passent, aucun échec, 50 ignorés**. Les logs initiaux sont conservés ; aucune cause environnementale définitive ou anomalie de production n'est déduite.
- Après fusion par fichier, titre et occurrence, et ajout du test navigateur exécuté explicitement : **2 251 validations distinctes passent, zéro échec restant, 63 ignorées**. Ce résultat rassemble plusieurs exécutions ; il ne désigne pas un passage global entièrement vert ni tout le dépôt.
- Parcours Playwright réel : initialisation, client, devis à 2,5 × 19,99 USD = 49,98 USD hors taxe, commit suivi d'une réponse HTTP 503 simulée, reprise du même corps sans doublon, acceptation interne, conflit puis lecture/confirmation explicite, réponse retenue après événement Auth simulé, seconde page lisant le même stockage et refus lecture seule côté serveur. Six commits locaux, aucune facture émise.
- 24 vues FR/DE/IT/EN × clair/sombre × 320/390/1440 px et huit contrôles de texte à 200 %. Aucun débordement ni erreur JavaScript, contrôles visibles d'au moins 44 px, huit captures. Relecture visuelle clair/sombre effectuée. Auth et persistance de ce parcours sont synthétiques/en mémoire ; les autres suites utilisent séparément PGlite et le vrai émulateur D1 local.
- Typecheck global, lint des 15 sources ciblées, compilation production et diff check passent. 107 fichiers SQL historiques comparés à la base Git : inchangés. Aucune migration proposée ou exécutée.
- Défauts corrigés pendant la revue : noms accessibles des sélecteurs, retour tardif après événement Auth, brouillons conservés après refus d'accès, bornes des grands montants, répétition involontaire d'une création confirmée et traitement d'une erreur Auth à corps non JSON. Le serveur de fixture traite aussi les fichiers manquants avant d'envoyer ses en-têtes ; aucun rejet non géré n'est ignoré.

Preuves : `.qa/us-browser-pilot/` et le JSON versionné. Pour reproduire : configurer le runtime local PGlite comme dans les preuves, `ZENTRA_V4_RUNTIME_PROOF=1`, exécuter `node scripts/qa-us-browser-regression.mjs` ; activer séparément `ZENTRA_BROWSER_WORKBENCH_QA=1` pour le test navigateur. Playwright/Edge doivent être disponibles ; le chemin Playwright peut être fourni par `ZENTRA_PLAYWRIGHT_MODULE`.

## Risques et suite

Le site commercial publié reste la version 354 et n'est pas remplacé par ce checkout international. Aucun paquet natif, tarif USD, paiement réel, webhook d'admission, migration ou activation US en production n'est livré. Le compte vendeur US et le prestataire fiscal ne sont pas configurés. Les droits locaux ne prouvent pas une souscription Stripe vérifiée.

Une interruption de requête ne prouve pas l'annulation du commit. La clé de reprise n'est conservée que tant que ce panneau reste ouvert ; fermeture/rechargement oblige à relire le serveur avant toute nouvelle création. Les refus tardifs D1 et commits PostgreSQL restent deux opérations distribuées. L'acceptation interne n'est ni signature ni consentement client.

Prochaine tranche : configuration vendeur US durable et contrôlée, contrat fournisseur fiscal vérifié et données produit/juridiction nécessaires, puis admission Stripe en sandbox et essai Auth/D1/PostgreSQL avec deux sessions. Aligner ces sources avec le site publié et la vraie application native avant toute diffusion. Aucune conformité US GAAP, charge réelle, résidence garantie ou recette physique iOS/macOS n'est annoncée.
