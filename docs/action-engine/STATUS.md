# Action Engine — état de reprise

Objectif actif : un ERP qui prépare le travail administratif, avec contrôle utilisateur. Le développement US est mis de côté, sans suppression de ses sources ou preuves.

## Lot A0 terminé localement

- Audit de l’architecture et des raccords réels.
- Préparateur pur, contrats fermés, preuve source, catalogue, calculs exacts et orchestration sans effets de bord propres.
- 323 tests Action Engine/Automation passés, typage, lint et build réussis.
- Code : `bdc75b6404eb39d58bd5b509a3b53cffc8a29c5f`.
- Livraison : `CORE-VALIDATION-20261011.md` et `docs/evidence/action-engine-core-20261011.json`.

## Prochain lot : propositions durables et premier vrai brouillon

1. Reprendre `AUDIT.md` et les contrats de `lib/action-engine/README.md`.
2. Persister les propositions et réservations centrales par entreprise/source/type, avec versions, empreintes et réconciliation ; ne pas utiliser un nouvel UUID pour permettre un second effet.
3. Raccorder le ticket durable et une projection autorisée du catalogue. L’absence de catalogue fiable impose une revue, pas une invention.
4. Réutiliser admission et délégation Support/Gestion existantes ; `mayPrepareQuote` doit couvrir création client éventuelle + devis brouillon, pas seulement lecture Automation.
5. Commande native unique dans le desktop **1.90.15** de `app-current-corrections`, sous origine entreprise et contexte membre : client éventuel, brouillon/lignes, reçu, audit, synchronisation. Vérifier l’arithmétique entière au commit.
6. Tester les commits perdus, les modifications en cours, deux appareils et le changement de compte avant de déclarer l’exécution autonome fonctionnelle.
7. Réutiliser l’interface Activité / À suivre / Réglages, ouvrir le véritable devis existant et notifier seulement après reçu métier confirmé.

Ne pas publier le desktop 1.46.1 de la copie serveur. Aucun changement de production n’a été effectué. Les ports abstraits ne constituent pas une intégration en ligne. L’objectif global reste en cours.
