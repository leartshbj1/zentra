# Livraison Support US H4 — réception automatique locale

## 1. Résumé des modifications

Base locale `083d02b2bde51181e61c7217332eeca87df3c093`, implémentation `c7f1b89b0851296c529cf7318425f3ed45929010`, branche `codex/international-runtime`. Un propriétaire ou administrateur peut consentir à une réception automatique bornée pour la boîte Infomaniak de son entreprise US. Un principal worker distinct relit les droits actuels, découvre des références durables, partage le quota et les résultats H3a, puis crée les tickets H3b avec une attribution automatique explicite dans l'audit. L'équipe voit les mêmes tickets. Il n'existe aucun port d'envoi, paiement, acquittement, suppression de message ou écriture comptable.

L'interface FR/EN/DE/IT présente l'état, la durée, un accord explicite, l'arrêt et les éléments en attente, incertains ou écartés. Les explications détaillées sont repliées. L'actualisation de cet état est discrète, nominalement toutes les 15 secondes lorsque la page est visible et connectée. Les confirmations perdues reprennent exactement la même commande en mémoire ; une lecture GET ne remplace pas le reçu. Un changement d'identité purge les détails et arrête les requêtes.

La recette demeure locale et fictive : aucun cron hébergé, migration de production, fournisseur réel, compte client, abonnement CHF, région ou distribution native n'est modifié. L'objectif ERP US complet reste actif.

## 2. Fichiers créés

- `app/api/international/workspaces/[organizationId]/support-worker/route.ts`
- `components/account/us-support-worker.css`
- `components/account/us-support-worker.tsx`
- `drizzle/0098_international_us_support_worker.sql`
- `lib/international/browser-us-support-worker-session.test.ts`
- `lib/international/browser-us-support-worker-session.ts`
- `lib/international/us-support-execution-contract.ts`
- `lib/international/us-support-execution-d1.ts`
- `lib/international/us-support-intake-provider.test.ts`
- `lib/international/us-support-intake-provider.ts`
- `lib/international/us-support-triage-service.test.ts`
- `lib/international/us-support-triage-service.ts`
- `lib/international/us-support-worker-bindings.test.ts`
- `lib/international/us-support-worker-bindings.ts`
- `lib/international/us-support-worker-composition.test.ts`
- `lib/international/us-support-worker-contract.test.ts`
- `lib/international/us-support-worker-contract.ts`
- `lib/international/us-support-worker-d1.test.ts`
- `lib/international/us-support-worker-d1.ts`
- `lib/international/us-support-worker-migration.test.ts`
- `lib/international/us-support-worker-server.test.ts`
- `lib/international/us-support-worker-server.ts`
- `lib/international/us-support-worker-test-fixture.ts`
- `lib/international/us-support-worker-ui-test-fixture.ts`
- `lib/international/us-support-worker-ui.test.ts`
- `lib/international/us-support-worker.test.ts`
- `lib/international/us-support-worker.ts`

Documentation créée : `US-SUPPORT-WORKER-PLAN-20261010.md`, `US-SUPPORT-WORKER-RESEARCH-20261010.md`, cette livraison et le manifeste `docs/evidence/us-support-worker-20261010.json` avec ses captures et résultats.

## 3. Fichiers modifiés

- `app/compte/espaces/us/[organizationId]/page.tsx`
- `components/account/us-erp-workbench.tsx`
- `components/account/us-support-mailbox-panel.tsx`
- `components/account/us-support-tickets.tsx`
- `components/account/us-support-workspace-panel.tsx`
- `lib/account-workspace-pages.test.ts`
- `lib/international/us-support-ticket-bindings.test.ts`
- `lib/international/us-support-ticket-bindings.ts`
- `lib/international/us-support-ticket-contract.ts`
- `lib/international/us-support-ticket-d1.ts`
- `lib/international/us-support-triage-contract.ts`
- `lib/international/us-support-triage-d1.ts`
- `lib/international/us-support-triage-policy.ts`
- `lib/international/us-support-triage-server.ts`
- `tests/us-supplier-documents-preview.tsx`
- `worker.ts`

Le fichier de suivi `docs/internationalization/STATUS-20261009.md` est complété. Le site public publié et le checkout natif séparé sont préservés.

## 4. Migration proposée

`drizzle/0098_international_us_support_worker.sql` ajoute délégations/reçus, têtes et baux, découverte/provenance de page, demandes préparées, étapes, reprises différées et fins de traitement. Elle remplace de façon versionnée les gardiens H3a/H3b concernés pour distinguer humain et worker ; elle ne réécrit aucun ancien fichier de migration et ne purge aucune donnée. Le worker peut créer un ticket mais ne peut corriger/affecter/clore un ticket ni gérer ses règles.

Les plafonds pilote sont 500 références, 10 000 runs, 20 000 pages et 2 000 issues par entreprise. À 1 000 versions de délégation, un nouvel accord est refusé ; l'arrêt reste possible, ce n'est donc pas une limite absolue du nombre de lignes. Ces plafonds durables ne se réinitialisent pas. Une autorisation dure au maximum 90 jours, mais à un run par minute les 10 000 runs peuvent épuiser l'autonomie en environ 7 jours, même sans nouveau message. Cette durée de validité n'est pas une promesse de service pendant 90 jours.

Ces plafonds conservent l'historique ; ils ne définissent pas une rétention légale. Les lectures, arrêts et reçus déjà établis restent disponibles. Les références déjà en file peuvent encore être traitées à la limite de découverte. Les résultats terminés sont prioritaires pour retrouver leur ticket, même si l'ancien appel a échoué avant de marquer l'étape.

Retour arrière : fermer la gate, retirer le déclencheur approuvé et revenir au code précédent, en conservant les tables et preuves. Toute application hébergée requiert l'approbation explicite prévue par la mission. Aucun rollback par suppression n'est proposé.

## 5. Tests exécutés et résultats

- Régression finale : **3 978/3 978 tests dans 125 fichiers**, zéro échec, skip, todo ou suite échouée. Elle comprend les 250 tests des 11 nouveaux fichiers H4, les 77 tests de page (12 nouveaux), les 10 tests du binding de completion (un nouveau cas worker fermé), les 14 tests PostgreSQL via PGlite et la chaîne réelle D1/workerd jusqu'à 0098. Auth, paiements, fournisseur et réponses du modèle demeurent fictifs.
- TypeScript global : code de sortie 0. Lint typé de 41 fichiers, avertissements interdits : code de sortie 0. Vérification des assets de marque et build production : code de sortie 0. Les notices existantes de convention middleware, timing des plugins et classement statique de routes vinext ne constituent pas une validation hébergée.
- Navigateur : 24 combinaisons FR/EN/DE/IT × clair/sombre × 320/390/1440 px, sans débordement mesuré ; contrôles d'au moins 44 px. Sept scénarios interactifs couvrent activation, traitement simulé, arrêt, réponse perdue/reprise exacte, membre en lecture seule, purge d'identité et actualisation silencieuse nominale à 15 secondes. Contraste minimal échantillonné : 5,60 en clair et 8,21 en sombre, sur les états FR/mobile examinés. Aucun message console d'erreur ou d'avertissement observé.
- Les captures précèdent l'ajout conditionnel du compteur « Écartés » (quatre tests de rendu) et la correction du passage de la gate à la page Support autonome (tests de page pour Support/Gestion). Les états capturés ont un compteur nul et restent visuellement identiques. Le navigateur utilise les vrais composants/transports avec HTTP/Auth/persistance simulés, pas une session hébergée.

Les comptes définitifs et commandes sont consignés dans le manifeste. Les essais ciblés se recouvrent et ne s'additionnent pas à la régression finale. Une première régression a été interrompue lorsqu'un défaut concret de reconnexion a été identifié ; elle ne constitue pas une preuve de réussite. Une autre a identifié un mock de page incomplet et un ancien fixture humain invalide. La revue a aussi trouvé la gate omise sur la page Support autonome. Ces défauts ont été corrigés avant la régression finale complète ; les résultats antérieurs de typecheck/lint ne remplacent pas les vérifications finales.

La chaîne complète est testée via les statements réels sur SQLite et workerd local. Un essai distinct `wrangler d1 migrations apply --local` dans un stockage isolé a échoué dans la migration 0094 préexistante avec `incomplete input`, avant 0098. Ce chemin CLI n'est pas validé ; aucun ancien fichier n'a été modifié pour contourner l'échec. La méthode d'application et la recette hébergée restent à approuver.

## 6. Risques identifiés

- Les mesures locales ne prouvent ni latence fournisseur, précision de JEV, Auth/D1/PG hébergés ni capacité de 150 entreprises. Le pilote est limité à un bail de 120 secondes et un message par invocation. Le scheduler prévu est global : à une invocation par minute, plusieurs espaces se partagent ce débit. Un fan-out durable ou une autre organisation est requis avant une ouverture à grande échelle.
- Free D1 n'est pas pris en charge : sa limite de 50 requêtes est inférieure au coût d'une simple lecture/reprise mesurée. La limite Paid est 1 000 ; la composition locale impose une borne de 800 par tick testé pour conserver une marge. Le nominal mesure 434 statements, le scénario combiné le plus coûteux 494, la réconciliation d'un ticket 77 et la reprise d'un résultat terminé 43. Le runtime réel et ses lectures de configuration restent à mesurer. Voir le relevé de recherche pour les sources et mesures initiales défectueuses.
- L'API paginée n'offre pas une preuve de livraison exhaustive. La date du message diffère potentiellement de son arrivée. Aucun UIDVALIDITY, curseur atomique ou snapshot fournisseur n'a été inventé. Les références sont persistées avant traitement, avec rafraîchissement de tête et backfill, sans promesse de réception sans pertes.
- Une inférence ambiguë reste bloquée contre le redispatch, même après expiration du bail. Un résultat terminé se réconcilie sans clé modèle ; un ancien message incompatible avec une connexion remplacée est écarté en conservant son historique et son éventuel quota déjà réservé.
- Le retry de configuration du navigateur est en mémoire : recharger/fermer l'onglet l'efface. Cela ne supprime pas les preuves serveur, mais ne remplace pas une file offline persistante.
- Les contrats, transferts, sous-traitants, données sensibles et durées de conservation identifiés dans le relevé du 8 octobre restent à valider avant usage réel. Aucun certificat, résidence garantie, conformité US GAAP ou déductibilité fiscale n'est annoncé.

## 7. Fonctionnalités terminées localement

Consentement borné et révocable, principal worker distinct, contrôle serveur frais des droits/périodes/catalogue/membre/boîte/politique, découverte durable avant traitement, isolation d'entreprise, préparation exacte, déduplication, quota commun, dispatch unique, reprises après panne, rotation des erreurs transitoires, récupération prioritaire des résultats terminés, tickets partagés et attribution worker, configuration multilingue et adaptée au mobile, journaux techniques corrélés sans contenu du mail.

## 8. Fonctionnalités encore expérimentales ou absentes

Recette hébergée et méthode CLI de migration, ordonnanceur réel, fan-out et charge multi-entreprises, validation fournisseur sur messages réels, connecteur à garanties de réception plus fortes, workflows client/rendez-vous persistants, OCR, contenu intégral/rétention et outils externes restent à développer ou valider. Les demandes US précédentes sur fiscalité, paiements clients, avoirs, récurrence, acomptes et pilote professionnel restent ouvertes. Aucun nouvel IPA/APK/DMG/installateur ni publication US n'est livré par H4.
