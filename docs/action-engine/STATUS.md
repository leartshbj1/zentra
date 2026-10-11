# Action Engine — état de reprise

Objectif actif : un ERP qui prépare le travail administratif, avec contrôle utilisateur. Le développement US est mis de côté, sans suppression de ses sources ou preuves.

## Lot A0 terminé localement

- Audit de l’architecture et des raccords réels.
- Préparateur pur, contrats fermés, preuve source, catalogue, calculs exacts et orchestration sans effets de bord propres.
- 323 tests Action Engine/Automation passés, typage, lint et build réussis.
- Code : `bdc75b6404eb39d58bd5b509a3b53cffc8a29c5f`.
- Livraison : `CORE-VALIDATION-20261011.md` et `docs/evidence/action-engine-core-20261011.json`.

## Lot A1 terminé localement

- Registre D1 interne : propositions immuables, réservations permanentes, reçus terminaux et journal.
- Barrières SQL atomiques obligatoires, identité unique du devis, protection contre REPLACE et reprise après réponse perdue.
- Reçu adapté au véritable brouillon natif non numéroté (`quoteNumber: null`).
- 408 tests Action Engine/Automation passés, typage, lint, assets et build réussis.
- Code : `31483afb1a76d0c1c6705d47c9a870dddc545999`.
- Livraison : `DURABLE-VALIDATION-20261011.md` et `docs/evidence/action-engine-ledger-20261011.json`.
- Migration additive D1 0099 testée uniquement sur des bases locales. Aucune route ni écriture métier réelle activée.

## Lot A2 terminé localement

- Réservation durable avant analyse, tentative HTTP unique, résultat figé avant sauvegarde de proposition et reprise après accusé perdu sans nouvel appel modèle.
- Admission privée issue du véritable authentificateur appareil, limitée aux packs Complets Stripe actuellement payés ; consentement distinct, désactivé par défaut.
- 545 tests Action Engine/Automation passés, typage, lint, assets et build réussis.
- Code : `c3d92cce06ddff231522a1be2f19ba92b0aa9649`.
- Livraison : `INTAKE-VALIDATION-20261011.md` et `docs/evidence/action-engine-intake-20261011.json`.
- Migrations additives D1 0100/0101 testées localement uniquement. Ce prédicat d'autorité ne remplace pas les versions source/catalogue/client ni la preuve de publication ; aucune route activée.

## Lot A3 codé localement, validation native en attente

- Chargeur privé du ticket Support délégué et des ressources Gestion publiées ; codec ZIP/JSON fermé, empreintes des faits et relectures après attente.
- Identités connecteur enrichies et persistées même quand le texte ne change pas ; conversations multi-expéditeurs signalées. Les versions fournisseur ne déclenchent pas seules une nouvelle analyse.
- Sources natives d'un writer atomique client éventuel + devis brouillon non numéroté + reçu + audit + outbox ; projection depuis la copie SQLite figée, migration additive 62.
- Conservation des reçus avant réception/fusion, outbox locale exclue du partage, compatibilité v60/v61 préparée sur copies temporaires.
- **809/809 tests serveur**, typage, lint du noyau, format, assets et build passés. Le périmètre Support élargi conserve 29 diagnostics lint identiques à sa baseline.
- **50 tests natifs écrits, non exécutés**. Cargo check échoue avant compilation du projet : Windows App Control refuse les build scripts de dépendances, erreur 4551. Les lectures Rustfmt et revues statiques ne constituent pas une compilation.
- Code serveur : `b517d2d05ef843c44915804f8cf272da6a07dda5` ; code natif : `e7ae48848a529a368b238ac57f724f1c8aff10df` (`codex/action-engine-native`).
- Livraison : `NATIVE-PROJECTION-VALIDATION-20261011.md` et `docs/evidence/action-engine-native-projection-20261011.json`.
- Aucun IPC, endpoint Action Engine, déclenchement, notification ou déploiement activé. Une vraie archive produite par Rust n'a pas encore été passée au codec TS.

## Lot A4 codé et testé localement, désactivé

- Registre D1 permanent des publications, garde PostgreSQL permanente opt-in, CAS et fait service-only corroboré avant settlement. Une tentative pending bloque la progression Action Engine ; une clôture prouvée remplace une libération par simple expiration.
- Admission, source Support déléguée et publication composées dans les mutations D1 de préparation ; composition privée de l'intake et du fournisseur, sans route, déclenchement ou IPC.
- Reprises couvertes : accusé PG perdu, même opération, clôture/tombstone, ancienne copie de transport purgée côté commit serveur, retrait du flag et refus legacy même historique. Le `prepare` préalable natif reste à adapter.
- Régression : **1 256/1 256 tests**, 40 fichiers. Après correction finale du wrapper, **72/72** ciblés dont 14 PostgreSQL et cinq compositions PostgreSQL/SQLite ; ces cas recouvrent la régression. **14/14** tests unitaires supplémentaires du préparateur : **1 270 cas distincts** dans 41 fichiers. Typage, lint du noyau, format et assets réussis.
- Migrations additives D1 0102 et Supabase `20261011011348_action_engine_publication_coordination.sql` proposées et testées sur bases éphémères seulement. Allowlist vide ; consentement spécifique désactivé par défaut.
- Livraison : `PUBLICATION-VALIDATION-20261011.md` et `docs/evidence/action-engine-publication-20261011.json`.
- Code serveur : `a5c75c9830e9a291928447ba11deee22e3c9a664`. Build de production réussi, sans déploiement.
- La confirmation métier reste explicitement refusée : un catalogue publié ne prouve pas la présence d'un devis/reçu canonique. Les 50 tests natifs A3 restent non exécutés ; Windows App Control n'a pas été contourné ou retenté.

## Lot A5 codé et testé côté serveur, natif à valider

- Sonde de reprise authentifiée dans le transport collaboration existant, avant préparation/fusion : absence réelle, pending à reprendre avec le même commit, résultat committed historique ou annulation terminale corroborée. Aucune nouvelle tentative ni opération financière créée par la sonde.
- Une réponse perdue après réservation D1 mais avant PG peut progresser sans nouvelle archive ; un commit historique après purge permet de conserver la bonne référence de fusion. Pannes et schémas absents ne deviennent jamais une preuve négative.
- Sources natives : contrôles d'origine/génération/pending et des octets avant commit/confirmation, puis relecture de la tête. Les changements postérieurs au snapshot restent à publier. Lecture seule et acceptation distante gardent leur chemin existant.
- **1 365/1 365 tests serveur**, 43 fichiers, dont 95 nouveaux cas. Les 103 ciblés recouvrent ce total. Typage, lint du périmètre, format, assets et build réussis.
- **13 nouveaux tests natifs écrits, non exécutés : 63 avec A3.** Rustfmt a seulement parsé les deux fichiers A5 ; le blocage App Control 4551 n'a pas été retenté ou contourné.
- Code serveur : `db417589dfb0fa753688bef5180f3648c47ad547` ; code natif : `528d7f599327b6890ae87037306a931126182e14`.
- Livraison : `PUBLICATION-RECOVERY-20261011.md` et `docs/evidence/action-engine-publication-recovery-20261011.json`.
- Aucune nouvelle migration. Les schémas D1/PG A4 et le serveur A5 doivent être validés/installés avant distribution du client. Aucun déploiement, appel fournisseur ou changement de donnée client. La preuve métier du devis et sa confirmation restent à raccorder.

## Lot A6 codé et testé côté serveur, raccord privé restant

- Vérification de la vraie SQLite complète : client, devis, toutes les lignes, reçu et audit de création. Un audit/sidecar seul ne prouve rien ; modification, émission ou suppression avant première preuve impose une revue.
- Liaison provenance/réservation dans le même batch, journal canonique append-only et reprise historique après preuve durable sans dépendance au catalogue/tête/transport anciens.
- **1 524/1 524 tests serveur**, 47 fichiers ; **6/6** smoke des vrais modules sous Workerd. Typage, lint ciblé, format, assets et build réussis. Données synthétiques, aucune exécution Rust.
- **5 nouveaux tests natifs écrits, 2 enrichis : 68 avec A3/A5, non exécutés.** Rustfmt a seulement parsé les deux fichiers ; aucun Cargo/App Control retenté ou contourné.
- Code serveur `0e9330c7efaf143acf0998a96a251477b75a8d0b`, natif `3eee678aa16fc0eeb9f559232aa7a5ac66fb6453`.
- Migration D1 additive 0103 proposée/testée localement ; aucune nouvelle migration PG. Aucun endpoint, IPC, déclencheur, notification ou déploiement.
- Livraison : `CANONICAL-QUOTE-VALIDATION-20261011.md` et `docs/evidence/action-engine-canonical-quote-20261011.json`. Bornes du pilote, dépendance sql.js épinglée et absence de limite CPU stricte documentées.

## Lot A7 codé et testé côté serveur, raccord appareil privé

- Composition authentifiée privée : proposition/réservation/provenance relues, fait PG committed exact, métadonnées et tous les chunks/SHA vérifiés, vraie SQLite canonique puis journal de preuve avant confirmation du reçu.
- Reprise après accusé perdu sans ancien transport ni doublon. La preuve reste obligatoire avant tout rejeu de reçu ; révocation, intention US ou document altéré avant première preuve sont refusés.
- Course legacy fermée dans l'INSERT atomique et par la migration additive D1 0104 : aucune première preuve après un reçu concurrent, avec conservation du rejeu des preuves déjà acquises.
- **1 641/1 641 tests serveur**, 52 fichiers, aucun ignoré ; **117 nouveaux cas** par rapport à A6. Typage, lint ciblé, format, assets et build de production réussis. Le vrai plugin SQLite et son WASM sont également testés dans un contexte Node VM isolé.
- Code serveur : `d0f9a4cd5341882322378c8a7c22a7ff3832808c`. Aucune source native modifiée ; les **68 tests natifs restent non exécutés**, sans nouvelle tentative Cargo/App Control.
- Livraison : `DEVICE-CONFIRMATION-VALIDATION-20261011.md` et `docs/evidence/action-engine-device-confirmation-20261011.json`. Auth/PG/Storage explicitement synthétiques dans la composition locale : aucune preuve hébergée ou Rust revendiquée.
- Aucun endpoint, IPC, déclencheur Support, notification, appel JEV ou déploiement. Migration 0104 testée sur bases locales seulement ; aucun nouveau schéma Supabase.

## Suite : premier vrai brouillon confirmé

1. Reprendre `AUDIT.md` et les contrats de `lib/action-engine/README.md`.
   Le prochain raccord d'exécution et ses cas de reprise sont détaillés dans `EXECUTION-INTEGRATION-PLAN-20261011.md` ; ce plan est une revue statique, pas un lot déjà implémenté.
2. Valider les sources natives A3/A5/A6 sur un hôte autorisé : compiler, exécuter les 68 tests et les régressions de restauration/fusion, puis vérifier l'interopérabilité d'une vraie archive synthétique. Ne pas retenter/bypasser Windows App Control en boucle.
3. Valider le protocole A4 sur un environnement de staging approuvé, notamment avec plusieurs connexions PG et le gateway complet ; la composition locale ne prouve pas une transaction distribuée. Tous les writers d'une entreprise protégée doivent suivre ce protocole, y compris après retrait de son flag.
4. Raccorder le préparateur privé à Support, puis réconcilier les tickets non dispatchés et les analyses incertaines. La course avant modèle et les gardes de persistance sont composées localement ; le déclenchement depuis Support n'est pas encore intégré.
5. Raccorder le writer privé validé à une commande native unique dans le desktop **1.90.15** de `app-current-corrections`, sous origine entreprise et contexte membre, admission/réservation/source distantes corroborées. Ne pas exposer directement l'input privé à la WebView.
6. Le parcours privé de confirmation A7 est testé ; restent la réservation/liaison d'exécution authentifiées et leur raccord natif validé avant toute exposition. Conserver un lien local durable proposition/réservation → snapshot avant upload et nettoyage du pending ; l'outbox actuelle ne le contient pas. Résoudre un ancien pending avant de publier un nouveau brouillon pour éviter de confirmer une archive qui ne le contient pas. La reprise doit relire les faits historiques réservés, pas le ticket courant, après une création locale déjà réussie. Valider les commits perdus, modifications en cours, deux appareils et changements de compte.
7. Réutiliser l’interface Activité / À suivre / Réglages, ouvrir le véritable devis existant et notifier seulement après reçu métier confirmé.

Ne pas publier le desktop 1.46.1 de la copie serveur. Aucun changement de production n’a été effectué. Les ports abstraits ne constituent pas une intégration en ligne. L’objectif global reste en cours.
