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

## Suite : admission réelle, intake et premier vrai brouillon

1. Reprendre `AUDIT.md` et les contrats de `lib/action-engine/README.md`.
2. Raccorder le ticket durable et une projection autorisée des clients et du catalogue. L’absence de contexte fiable impose une revue, pas une invention.
3. Réutiliser admission et délégation Support/Gestion existantes ; `mayPrepareQuote` doit couvrir création client éventuelle + devis brouillon, pas seulement lecture Automation. Les branches commerciales non corroborées restent refusées.
4. Réserver la préparation avant tout appel JEV concurrent, puis réconcilier les tickets reçus mais non dispatchés. Le registre actuel empêche deux effets, mais pas encore deux appels simultanés au modèle.
5. Commande native unique dans le desktop **1.90.15** de `app-current-corrections`, sous origine entreprise et contexte membre : client éventuel, brouillon/lignes, reçu, audit, synchronisation. Vérifier l’arithmétique entière au commit.
6. Corroborer la confirmation avec une publication business-sync canonique, puis tester les commits perdus, les modifications en cours, deux appareils et le changement de compte avant de déclarer l’exécution autonome fonctionnelle.
7. Réutiliser l’interface Activité / À suivre / Réglages, ouvrir le véritable devis existant et notifier seulement après reçu métier confirmé.

Ne pas publier le desktop 1.46.1 de la copie serveur. Aucun changement de production n’a été effectué. Les ports abstraits ne constituent pas une intégration en ligne. L’objectif global reste en cours.
