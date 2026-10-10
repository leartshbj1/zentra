# Livraison US Support — H3a, 10 octobre 2026

## 1. Résumé des modifications

Base locale `9c8013e`, implémentation `308b10f2bf952c44d54f0999a202d43505ffa131` (sans push), branche `codex/international-runtime`. Un propriétaire ou administrateur peut choisir un message Infomaniak dans l'espace Support US, consulter le budget, confirmer le traitement de son texte et recevoir une proposition de catégorie, priorité et langue. L'interface FR/EN/DE/IT utilise les styles clair/sombre existants. Elle amène le focus et le bouton principal à l'écran ; une reprise incertaine n'empêche pas le travail financier.

L'autorité H1 reste Gestion + Support sur la **même** preuve US/USD et la même période payée. Le modèle commercial actuellement vérifié est Complet ; des abonnements distincts ne sont pas combinés arbitrairement. Aucun droit Automation, financier, d'envoi ou d'affectation ne découle de ce classement. La gate `INTERNATIONAL_US_SUPPORT_TRIAGE_ENABLED` est fermée par défaut, en plus de Core/ERP/H1/H2a. Aucune disponibilité n'est ajoutée aux parcours CH.

Une source serveur est observée deux fois, avec UID amont et version corroborés. Son empreinte privée et ses faits de complétude sont conservés, sans sujet, corps, e-mail ni secret. Le dispatch durable autorise au plus une émission par source/recette. Une réponse perdue se vérifie avec la même commande. Une demande déjà dispatchée sans résultat confirmé reste consommée, sans deuxième appel automatique ni libération de quota.

## 2. Fichiers créés

| Fichiers | Fonction |
| --- | --- |
| `lib/international/us-support-triage-contract.ts` | Commandes, sources, grants, reçus et décisions strictement validés ; empreintes tenant/acteur/source. |
| `lib/international/us-support-triage-policy.ts` | Configuration explicite catalogue/Price ID, seuil et budget mensuel UTC. |
| `lib/international/us-support-triage-d1.ts` | Réservations, alias, émission unique, résultat et incertitude append-only. |
| `lib/international/us-support-triage-provider.ts` | Lecteur privé Infomaniak borné et adaptateur TypeSafe structuré, sans retry d'inférence. |
| `lib/international/us-support-triage-server.ts` | Admission HTTP fraîche, consentement versionné, source/connexion, budget, replay et réponse publique bornée. |
| `lib/international/us-support-triage-bindings.ts` | Stores et clé serveur réels ; résolveur de clé chargé seulement à l'analyse/readiness, gate et diagnostics expurgés. |
| `lib/international/browser-us-support-triage-session.ts` | Transport strict schéma 4 ; commande exacte en mémoire et purge des droits. |
| `components/account/us-support-triage.tsx` | Confirmation, résultat, vérification humaine, statut incertain et reprise traduits. |
| `app/api/international/workspaces/[organizationId]/support-mailbox/triage/route.ts` | GET de readiness et POST de classement explicite. |
| `lib/international/us-support-triage-{contract,policy,d1,provider,server,bindings,composition,ui}.test.ts`, `us-support-triage-test-fixture.ts` | Tests et vraie chaîne SQLite locale avec autorité TEST fictive. |
| `drizzle/0096_international_us_support_triage.sql`, plan, livraison et `docs/evidence/us-support-triage-20261010*` | Migration proposée, décisions et preuves. |

## 3. Fichiers modifiés

- `app/compte/espaces/us/[organizationId]/page.tsx` : disponibilité côté serveur et raccordement aux vues Support/Gestion US.
- `components/account/us-erp-workbench.tsx` : prop dédiée ; disponibilité seulement après admission schéma 4 dans Gestion.
- `components/account/us-support-{workspace,mailbox}-panel.tsx` : sélection du message, coordination des actions en cours, reprise après changement de connexion et indications selon les capacités.
- `tests/us-supplier-documents-preview.tsx` : scénario fictif `triage=1`, résultat et incertitude, avec le vrai workbench et ses transports.
- `docs/internationalization/STATUS-20261009.md` : état actuel de la phase F et étapes restantes.

Aucun fichier natif, service de traitement CH/legacy, tarif, abonnement existant ou ancienne migration n'est modifié.

## 4. Migration et configuration proposées

La migration **additive D1 0096**, générée avec Wrangler 4.92.0 après consultation de son aide, ajoute cinq tables immuables et leurs gardes : jobs, requêtes d'acteurs, dispatchs, complétions et constats incertains. La chaîne réelle 0000–0096 est testée en SQLite et workerd local. Les deux séparateurs de commentaires initiaux du fichier généré ont été retirés : aucun segment vide n'est soumis à D1. Aucun schéma Supabase, ACL/RLS, région ou donnée hébergée n'est modifié.

Le locator est unique par entreprise/espace/fournisseur/mailbox/folder/UID/recette. Les alias vérifient exactement les faits de source, y compris version et empreinte. Reconnexion, autre acteur ou nouveau mois ne relancent pas une source déjà analysée sous la même recette. Le quota compte tous les jobs réservés par entreprise/environnement/mois UTC, indépendamment du Price ID et de la recette ; les alias ne consomment pas de nouvelle unité. Les gardes corroborent H1, propriétaire/admin, provenance payée, dates fraîches et session native 4. Auth, politique commerciale et preuve fournisseur restent des entrées serveur de confiance ; D1 n'authentifie pas seul un contexte fourni.

`INTERNATIONAL_US_SUPPORT_TRIAGE_POLICY_JSON` exige un objet strict : `schemaVersion:1`, `cadence:"utc_calendar_month"`, `budgetPolicyVersion`, `processingPolicyVersion`, `recipeVersion`, `threshold` et `entries:[{catalogVersion,priceId,limit}]`. La recette actuelle est `us-support-text:support-2026-09-28-solicitation-v6`. Aucun quota, tarif ou Price ID US de production n'est inventé. Le quota de tri est `support_message_classify`, distinct de `supplier_invoice_extract`. La clé de plateforme existante reste chiffrée côté serveur ; elle ne donne aucun droit sur une entreprise.

Retour arrière : fermer la gate et revenir au code précédent en conservant les tables et reçus. Aucun effacement compensatoire, remboursement automatique d'un traitement incertain ou réémission forcée. Les plafonds pilote sont 500 sources et 2 000 alias par entreprise ; leur évolution demandera une stratégie explicite d'archivage/conservation, sans purge de l'audit.

## 5. Tests exécutés et résultats

Les commandes, résultats finaux, sélections et empreintes sont enregistrés dans `docs/evidence/us-support-triage-20261010.json`. Les relances ciblées se recouvrent ; leurs totaux ne s'additionnent pas à la régression finale.

La sélection finale dédupliquée de **107 fichiers passe : 3 450/3 450 tests**, zéro échec, skip, todo ou suite échouée. Elle reprend les 99 fichiers du jalon H2b, y compris les 14 tests PostgreSQL locaux, et ajoute les huit fichiers H3a. Un avertissement de terminaison tardive d'un fork apparaît pour le test D1 d'import existant ; son suivi ciblé **54/54** passe sans cet avertissement, est conservé séparément et n'ajoute pas de tests au total.

Les 255 nouveaux tests couvrent contrats/politique, vrai SQLite, fournisseur simulé, HTTP, gate, composition réelle des adaptateurs et UI. Ils vérifient notamment quota concurrent, doubles demandes, faits modifiés, adoption de commande refusée, source forgée, limite de capacité, isolation de deux entreprises du même propriétaire, révocation d'un administrateur réellement invité et déconnexion pendant l'analyse. Une mutation de droits prime sur une erreur privée simultanée. Aucun port de routage, réponse, facture, fournisseur ou écriture n'est injecté dans ce service.

TypeScript global, lint typé des 23 fichiers TypeScript concernés, contrôle de marque et build production réussissent. Le build conserve les avertissements préexistants de middleware/classification statique des routes. Les 24 contrôles navigateur FR/DE/IT/EN × clair/sombre × 320/390/1440 px montrent zéro débordement mesuré, focus correct et bouton principal visible dès l'ouverture. Quinze captures conservent confirmations, résultat, incertitude et purge. Le résultat avec pièce jointe indique la vérification nécessaire ; la reprise reste disponible sans verrou financier ; les données privées disparaissent à la perte d'accès.

Les premières défaillances sont conservées dans `.qa` : import eager de runtime Cloudflare dans le test de page (corrigé par chargement différé de la clé), deux tests qui tentaient de révoquer le propriétaire protégé (remplacés par la révocation d'un vrai admin invité), séparateurs de migration, et variable PGlite omise (corrigée pour la recette finale). Le premier lancement de build visait un chemin CLI inexistant ; le vrai `dist/cli.js` a ensuite réussi. Aucun de ces essais initiaux n'est présenté comme une validation finale.

## 6. Risques et limites identifiés

- Le corps lu est borné à 16 Kio et le sujet à 1 024 octets. Les pièces jointes ne sont pas analysées ; un aperçu incomplet déclenche une vérification humaine. Une double observation n'est ni un snapshot atomique ni une preuve UIDVALIDITY/ETag forte.
- Le modèle est épinglé à `jev-1.13.0` et sa réponse structurée est strictement contrôlée. Les appels sont simulés : aucune précision, latence hébergée ou compatibilité contractuelle du compte réel n'est démontrée.
- Le dispatch est clôturé **avant** l'appel. Une perte d'accusé peut donc laisser une analyse consommée même si aucun appel n'a finalement été émis. Cette préférence pour éviter les doubles effets est affichée ; aucun mécanisme de retry fournisseur fiable n'a été supposé.
- Les résultats historiques restent lisibles seulement sous H1 frais. Une déconnexion/révocation pendant un nouvel appel supprime sa confirmation à l'interface et conserve le dispatch comme barrière. Aucune révocation distante d'un appel déjà reçu par le fournisseur n'est promise.
- La reprise exacte reste dans la mémoire de l'onglet, sans stockage local. Recharger/fermer l'onglet l'efface ; la déduplication serveur demeure, sans écran d'historique global des analyses à ce stade.
- Aucun appel réel, envoi de mail, client réel, migration hébergée, activation, push, publication ni build natif. La sécurité, la résidence des données et la réglementation US doivent encore être examinées pour le déploiement retenu.

## 7. Fonctionnalités terminées localement

Classement explicite du texte, consentement versionné, budget séparé, modèle structuré, résultat immuable, source et tenant vérifiés, émission unique, statut incertain conservateur, replay exact, contrôle des droits à chaque frontière, interface quatre langues et deux thèmes, intégration aux vrais panneaux Support et Gestion US.

## 8. Fonctionnalités encore expérimentales / suite

H3a reste derrière une gate locale. Il ne réceptionne pas automatiquement les messages, ne route/acquitte/répond/importe pas et ne produit aucun effet comptable. H2b conserve séparément un original ; l'analyse de facture prépare séparément une proposition sous son propre droit Automation.

Prochaine verticale : corrections humaines et affectations durables du tri, puis délégations worker révocables et workflows client/rendez-vous idempotents. La recette Auth/D1/PostgreSQL/Stripe/fournisseurs en staging doit être explicitement approuvée ; le cycle commercial US complet, le pilote natif et l'examen professionnel fiscal/comptable restent ouverts. L'objectif international n'est pas marqué terminé.
