# Action Engine A5 — sources natives de reprise

Code : `528d7f599327b6890ae87037306a931126182e14`, parent `e7ae48848a529a368b238ac57f724f1c8aff10df`.

Le desktop 1.90.15 retrouve le résultat de son pending avant toute préparation ou fusion. La sonde `recover-publication` utilise uniquement les métadonnées figées de l'envoi existant. Si le serveur indique pending, le client reprend exclusivement `commit` avec le même ID, sans préparation, upload ni nouvelle identité. Un résultat positif ne confirme que le snapshot attendu à base + 1 ; l'archive locale d'origine devient la référence, et les modifications métier plus récentes restent à publier.

Origine entreprise, génération du compte, pending et octets sont revérifiés avant commit/confirmation. Annulation et conflit gardent le pending et relisent la tête ; réponse malformée, panne ou refus arrêtent le parcours. Lecture seule et acceptation explicite de la version distante gardent leur chemin existant. Une simple confirmation ne déclenche pas de rechargement métier inutile (`changed=false`).

Fichiers :

- Modifié `desktop/src-tauri/src/company_collaboration.rs`.
- Créé `desktop/src-tauri/src/company_collaboration_publication_recovery_tests.rs` : 13 tests **écrits, non exécutés**. Archives et préférences locales réelles, transport injecté ; ordre tête/fusion représenté par un facsimilé, sans preuve du parcours Tauri/HTTP complet.

Rustfmt a seulement parsé les deux fichiers via `--emit stdout --config skip_children=true` : codes de sortie 0, aucune modification des sources. Aucun Cargo check/test ni exécutable natif n'a été retenté. Le refus Windows App Control 4551 observé en A3 reste la limite de validation : il n'a pas été contourné. Les 50 tests A3 et les 13 A5, soit **63 tests natifs**, restent à exécuter sur un hôte autorisé.

Serveur correspondant : `db417589dfb0fa753688bef5180f3648c47ad547` dans `D:/Codex-Zentra-Temporary/2026-10-08/international-site`. Ses 1 365 tests locaux et son build passent ; cela ne valide pas le natif. Rapport complet : `docs/action-engine/PUBLICATION-RECOVERY-20261011.md` et manifeste `docs/evidence/action-engine-publication-recovery-20261011.json` dans ce workspace serveur.

Prérequis avant distribution : schémas D1/PG A4 validés/installés, puis serveur A5, puis client natif validé. Table/RPC manquante ou ancien serveur ne sont jamais interprétés comme une absence de reçu. Un garde PG permanent interdit un rollback vers le transport antérieur à A4. Aucune nouvelle migration A5 et aucun déploiement effectué.

Ce lot ne crée aucun nouvel IPC Action Engine, déclencheur Support ou devis. Preuve canonique publiée, confirmation métier et notification restent à raccorder. Il ne résout pas les limites préexistantes d'un premier partage jamais publié, sans référence historique. Aucune donnée client ni compte de production n'a été modifié.
