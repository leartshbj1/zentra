# Action Engine — lot A3 privé, 11 octobre 2026

## Résultat et portée

Le serveur peut maintenant charger une demande Support persistée sous délégation actuelle et lire une projection clients/catalogue au début d'une archive Gestion publiée. Le desktop **1.90.15** possède les sources d'un export depuis sa copie SQLite figée et d'une transaction dédiée client éventuel + vrai devis brouillon + reçu + audit + outbox.

**Cette fonction n'est pas activée dans l'application.** Aucun endpoint, IPC, déclenchement Support ou bouton n'est ajouté. Les droits distants, la réservation centrale, la source et la publication doivent encore être composés avec le writer. Le sidecar ne constitue pas une preuve de création du devis.

Code serveur : `b517d2d` (branche `codex/international-runtime`). Le commit natif et les SHA-256 des fichiers sont consignés dans `docs/evidence/action-engine-native-projection-20261011.json`. Le dépôt utilisateur d'origine n'a pas été modifié. Aucun déploiement, migration distante, appel JEV réel, e-mail ou modification de données clients n'a été exécuté.

## Fichiers créés

Serveur, dans `international-site` :

- `lib/action-engine/published-resources.ts`, `published-resources.test.ts` : codec ZIP positionnel, JSON fermé, limites, CRC/SHA et révisions exactes.
- `lib/action-engine/published-context.ts`, `published-context.test.ts` : chargeur privé appareil/délégation/source/publication, relectures après attente.
- `lib/action-engine/source-envelope.ts`, `source-ingestion.test.ts` : identité littérale du connecteur et tests d'ingestion/conversations/CAS.
- `lib/action-engine/native-schema.test.ts` : exécution SQLite du SQL natif réel, distincte de la validation Rust.

Natif, dans `app-current-corrections/desktop/src-tauri/src` :

- `action_engine_resources.rs`, `action_engine_resources_tests.rs` : export strict depuis une connexion SQLite fournie, sans réseau ou ouverture de fichier arbitraire.
- `action_engine_quote.rs`, `action_engine_quote_tests.rs` : writer privé et scénarios de droits, calculs, replay, rollback et concurrence locale.
- `action_engine_quote_schema.sql` : migration additive 62, reçu partagé immuable et outbox privée liée.
- `action_engine_archive_tests.rs` : archives de collaboration et sauvegardes manuelles.
- `action_engine_collaboration_tests.rs` : conservation des reçus et restauration de l'outbox locale.

Ce compte rendu et le manifeste de preuves sont enregistrés séparément des sources.

## Fichiers modifiés

Serveur :

- `lib/support/types.ts`, `connectors.ts`, `infomaniak.ts`, `infomaniak-imap.ts` : nom littéral et indicateur d'identité ambiguë, sans déduire un client du texte.
- `lib/support/service.ts` : l'identité, le nom borné, l'état fermé et l'ambiguïté participent à la révision durable de source. Les versions/horodatages fournisseur restent exclus pour éviter une boucle de reclassement après affectation.
- `lib/support/infomaniak.test.ts`, `infomaniak-imap.test.ts` : vérification des enveloppes multiples.
- `lib/action-engine/README.md`, `docs/action-engine/PUBLISHED-CONTEXT-CONTRACT.md`, `NATIVE-ADAPTER-CONTRACT.md` : contrat effectivement codé et limites.

Natif :

- `backup.rs`, `models.rs` : descripteur optionnel et deux entrées ZIP initiales non compressées pour les seules archives de collaboration ; format de transport cloud inchangé.
- `database.rs`, `schema.rs`, `lib.rs` : migration 61→62 et modules privés.
- `company_collaboration.rs` : publication depuis la copie figée, outbox exclue du partage, conservation exacte des reçus locaux avant remplacement/fusion.
- `company_merge.rs` : normalisation additive des références v60/v61 dans des copies temporaires ; retrait du descripteur absent du ZIP intermédiaire et nouvelle projection lors de la republication. Un test couvre les deux versions anciennes.

## Invariants codés

- La projection exporte seulement les faits nécessaires d'une entreprise CH/CHF ; elle garde les archives client et les révisions `updated_at`. Absence de projection valide : Action Engine refuse, mais la synchronisation normale continue.
- Le taux effectif vaut zéro pour un non-assujetti ; le hash conserve le taux brut configuré. Aucun montant fiscal n'est inventé.
- Les bornes sont fermées : 4 MiB, 5 000 clients/articles chacun, entiers, chaînes et délais limités. Aucun export tronqué.
- La source appartient au Support délégué de l'entreprise courante ; connexion/délégant actuels. Le corps, le modèle ou une identité multi-expéditeurs ne peuvent fournir le nom du nouveau client.
- Le lecteur vérifie la taille/SHA du premier chunk, les deux positions ZIP réservées, CRC/SHA, UTF-8/JSON strict, organisation/snapshot/révision de base et les hashes des faits. Il capture ses octets avant les attentes.
- La transaction native IMMEDIATE relit origine, membre, ressources, client et articles, recalcule les montants en cents/millièmes/i128, puis écrit toutes les étapes ensemble. Le numéro reste NULL et la validation humaine obligatoire.
- Le reçu est retrouvé avant le catalogue courant : un replay retourne le fait original, sans modifier ou recréer un devis ensuite édité, émis ou supprimé.
- Reçus append-only, gardes contre INSERT/REPLACE/IGNORE sur toutes leurs identités uniques ; outbox liée au reçu, identité immuable et compteurs monotones.
- Une copie reçue qui perd/modifie un reçu local est refusée et restaurée ; ne pas supprimer une preuve incertaine pour permettre une deuxième création.

Ces invariants natifs sont **codés, mais pas encore validés par exécution Rust**.

## Contrôles réellement exécutés

Preuves : `docs/evidence/action-engine-native-projection-20261011.json`.

| Contrôle final | Résultat |
| --- | --- |
| Vitest Action Engine + Automation + régressions Support sélectionnées, 4 workers | **809/809**, 29 fichiers, aucun échec/en attente |
| Codec publié A3 | 49 tests |
| Chargeur/contexte/enveloppe A3 | 30 tests ; authentification/publication/codec remplacés par fixtures dans ce groupe |
| Ingestion Support A3, SQLite et transport connecteur fictif | 21 tests |
| SQL natif 62 exécuté par `node:sqlite` | 23 tests ; ceci n'exécute pas LocalStore/Rust |
| TypeScript `--noEmit --incremental false` | Sortie 0 |
| Oxlint Action Engine + déclarations D1 | Sortie 0 |
| Oxlint périmètre Support élargi | 29 diagnostics, identiques à la baseline Git ; lint global non propre |
| Oxfmt, 7 nouveaux fichiers TypeScript | Sortie 0 |
| Assets de marque | Sortie 0 |
| Build production Vinext | Sortie 0 |
| Rustfmt, 6 nouveaux fichiers Rust | Sortie 0 ; syntaxe/format seulement |
| Rustfmt, 7 fichiers Rust existants modifiés, sortie stdout | Sortie 0 ; lecture syntaxique, sans réécriture/typecheck |
| `git diff --check`, deux copies | Sortie 0 |
| Cargo check natif | **Bloqué, sortie 101**, Windows App Control erreur 4551 sur build scripts de dépendances, avant compilation du projet |
| Nouveaux tests natifs | **50 écrits, non exécutés** : ressources 20, writer 22, archives 4, réception 3, fusion 1 |

Le build conserve l'avertissement `middleware` déprécié et la classification statique incomplète de certaines routes Vinext. Il ne prouve pas une recette hébergée.

Les premières passes restent conservées : projection 76/76 ; projection suivante 167/168 avec une assertion d'erreur SQL corrigée pour le trigger réel ; régression 802/802 avant sept tests SQL supplémentaires. La passe suivante a terminé 803/809 avec six dépassements du délai de hook d'initialisation SQLite. La dernière exécution passe 809/809 en limitant les workers à quatre, sans augmenter de délai, assouplir d'assertion ou ignorer de test. Ce n'est pas un benchmark de charge serveur.

Deux revues statiques natives n'ont pas identifié de défaut bloquant supplémentaire ; elles ne remplacent pas la compilation, les tests d'intégration ou des essais sur appareils physiques.

## Migrations et retour arrière

Aucune nouvelle migration D1/Supabase dans A3. Les migrations D1 0099–0101 précédentes restent locales et désactivées.

La migration native 62 ajoute deux tables et leurs triggers puis réinstalle le tracking de collaboration pour le reçu partagé. Aucun DROP ni effacement métier. La compatibilité des données existantes et des fusions 60/61 doit encore être exécutée sur un hôte natif autorisé avant distribution. Les sauvegardes sources ne sont pas réécrites ; la normalisation de fusion vise des copies extraites temporaires.

Retour arrière opérationnel avant publication : garder le raccord désactivé et revenir aux commits précédents. Si une base 62 a été ouverte, ne pas la charger de force avec un binaire 61 ni supprimer ses reçus/outbox. Une restauration vérifiée doit tenir compte des données plus récentes. Aucun downgrade automatique n'est fourni.

## Risques et travaux restants

1. **Validation native indisponible** : les 50 tests et les régressions restauration/fusion doivent être exécutés. Le blocage Windows n'a pas été contourné. Produire ensuite un vrai ZIP synthétique natif et le passer au codec serveur ; les ZIP des fixtures TS ne prouvent pas cette interopérabilité.
2. **Pas de confirmation canonique métier** : un sidecar hashé ne prouve ni son égalité avec SQLite face à un producteur malveillant, ni la présence effective du devis/lignes/audit/reçu. L'acquittement central exige encore une preuve métier publiée vérifiée.
3. **Pas de transaction D1/Supabase commune** : relecture de tête/source/admission ne vaut pas barrière atomique de persistance. La composition et la réconciliation des conflits/commits perdus restent à construire.
4. **Identité source Support modifiée** : la première réingestion des anciens tickets avec l'ancien fingerprint peut déclencher une nouvelle analyse. Les polls suivants stables ne la répètent pas. Prévoir volume/coût et recette avant déploiement.
5. **Périmètre volontairement étroit** : CH/CHF, pack Complet Stripe payé, consentement spécifique désactivé par défaut. US, essais, droits manuels/fondateur, prépayés et transitions ne sont pas activés dans ce chemin.
6. **Supervision et raccord encore absents** : déclenchement Support, réservation distante composée, commande native authentifiée, Activité/À suivre, ouverture du vrai devis et notification après confirmation seulement.

Aucune garantie distribuée « exactly once », conformité fiscale, synchronisation physique multi-appareils ou disponibilité en production n'est revendiquée. L'objectif reste actif ; A3 est un checkpoint de sources et de validation serveur, pas une livraison native terminée.
