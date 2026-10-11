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

## Suite : composition et premier vrai brouillon confirmé

1. Reprendre `AUDIT.md` et les contrats de `lib/action-engine/README.md`.
2. Valider les sources natives A3 sur un hôte autorisé : compiler, exécuter les 50 tests et les régressions de restauration/fusion, puis vérifier l'interopérabilité d'une vraie archive synthétique. Ne pas retenter/bypasser Windows App Control en boucle.
3. Composer le nouveau prédicat d'autorité avec la délégation Support/Gestion et les versions source/catalogue/client ; `mayPrepareQuote` couvre création client éventuelle + devis brouillon, pas seulement lecture Automation. Les branches commerciales non corroborées restent refusées.
4. Raccorder l'intake durable, puis réconcilier les tickets reçus mais non dispatchés et les analyses incertaines. La course avant modèle est fermée dans le noyau ; le déclenchement depuis Support n'est pas encore intégré.
5. Raccorder le writer privé validé à une commande native unique dans le desktop **1.90.15** de `app-current-corrections`, sous origine entreprise et contexte membre, admission/réservation/source distantes corroborées. Ne pas exposer directement l'input privé à la WebView.
6. Corroborer la confirmation avec une archive Gestion publiée via Supabase (voir `PUBLISHED-CONTEXT-CONTRACT.md`), puis tester les commits perdus, les modifications en cours, deux appareils et le changement de compte avant de déclarer l'exécution autonome fonctionnelle.
7. Réutiliser l’interface Activité / À suivre / Réglages, ouvrir le véritable devis existant et notifier seulement après reçu métier confirmé.

Ne pas publier le desktop 1.46.1 de la copie serveur. Aucun changement de production n’a été effectué. Les ports abstraits ne constituent pas une intégration en ligne. L’objectif global reste en cours.
