# Limite locale de profondeur de braces — 8 octobre 2026

Dans le checkout US isolé, `braces@3.0.3` reçoit un patch pnpm pour borner la profondeur des patterns et des parcours récursifs d'AST. Il s'agit d'une mitigation locale testée, pas d'une version corrigée officiellement ni d'une certification de sécurité. Le patch rejoint le lot local projets ; aucun déploiement, fichier de l'application native ou checkout de production n'a été modifié.

## Sources et choix

Le [registre npm primaire](https://registry.npmjs.org/braces) annonce encore `3.0.3` comme version publiée la plus récente. L'[avis GitHub GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), consulté le 8 octobre 2026, concerne les versions jusqu'à `3.0.3` et n'indique aucune version corrigée. L'[issue upstream #70](https://github.com/micromatch/braces/issues/70) décrit l'épuisement de pile via les AST profondément imbriquées. Le code upstream consulté reste sans garde de profondeur.

Le tarball npm `braces-3.0.3.tgz` a été téléchargé sur D: et vérifié contre son SRI publié :

```text
sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==
```

Ses dix fichiers correspondent byte pour byte au paquet upstream intact utilisé pour enregistrer les sorties de référence des tests. La preuve locale se trouve dans `.qa/braces-hardening/upstream-integrity-proof.json`.

## Changement et compatibilité

- `patches/braces@3.0.3.patch` limite à **100 blocs imbriqués**, en comptant ensemble accolades et parenthèses dans le parseur. Le 101e bloc lève une `SyntaxError` à message fixe. Cette limite n'est pas désactivable par une option.
- `compile`, `expand` et `stringify` bornent aussi les parcours d'AST fournies directement. Les feuilles scalaires situées sous le 100e bloc restent admises. Les cycles des enfants effectivement parcourus sont détectés sur le chemin actif ; les liens habituels `parent`/`prev` et le partage d'un sous-arbre entre des chemins terminés ne sont pas rejetés globalement.
- Les accolades/parenthèses contenues dans les quotes, caractères échappés ou classes de caractères conservent leur traitement littéral. Les options de compilation, de quotes/échappements, de filtrage et les gardes existantes de longueur/range restent inchangées dans les cas testés.
- Le patch ne borne pas le nombre de combinaisons d'une expansion et ne constitue pas une validation générale d'AST arbitraires. L'introduction du plafond est une restriction explicite des patterns auparavant admis au-delà de 100 blocs.

La version et les dépendances de `braces` ne changent pas. `pnpm-workspace.yaml` enregistre le patch ; `pnpm-lock.yaml` lie l'instance utilisée par `micromatch@4.0.8` à son identité patchée. Les overrides et patches préexistants sont conservés. La [procédure pnpm officielle](https://pnpm.io/cli/patch) a préparé puis installé la variante patchée dans le `node_modules` indépendant du clone, avec le store `D:/CodexCaches/pnpm-store` et `TEMP`/`TMP` sur D:.

## Vérification réalisée

`scripts/braces-depth.test.mjs` charge le **paquet réellement installé via micromatch**, plutôt qu'une copie de l'implémentation. Les fixtures `scripts/fixtures/braces-3.0.3-compatibility.json` conservent 33 observations upstream sur quatre entrées (`braces`, `compile`, `expand`, `stringify`), soit 132 comparaisons de sorties ou d'erreurs, plus les résultats d'une AST avec sous-arbre partagé.

Le 8 octobre 2026 : **42/42 tests passent**, lint du test sans erreur et build réel `pnpm run build` terminé avec code 0. Les logs se trouvent dans `.qa/braces-hardening/tests.log` et `build.log`.

Deux subprocess utilisent chacun un timeout de 5 secondes, un buffer de sortie de 64 KiB et un heap plafonné à 64 MiB : pile Node par défaut puis pile de 512 KiB. Chacun vérifie 10 appels rejetés sur deux patterns de profondeur 4 000, longs de 8 001 caractères, 10 appels admis à la limite 100, six refus d'AST profondes/cycliques et le fonctionnement d'une compilation ordinaire après ces refus. Les tests couvrent aussi 100/101, profondeur mixte, AST avec liens parent usuels, partage valide et literals profonds.

Commandes reproductibles depuis la racine du clone, avec le runtime Node configuré :

```powershell
$env:TEMP = 'D:/Codex-Zentra-Temporary/2026-10-08/braces-pnpm-temp'
$env:TMP = $env:TEMP
$env:pnpm_config_store_dir = 'D:/CodexCaches/pnpm-store'
$env:npm_config_store_dir = $env:pnpm_config_store_dir
node --test scripts/braces-depth.test.mjs
pnpm run build
pnpm audit --prod --json
pnpm audit --json
```

## Résultat réel de l'audit

L'audit n'est **pas propre**. Les audits avant et après le patch ont les mêmes métadonnées et renvoient le code **1** :

| Audit | Low | Moderate | High | Critical |
|---|---:|---:|---:|---:|
| `pnpm audit --prod --json` | 0 | 0 | 3 | 0 |
| `pnpm audit --json` | 6 | 20 | 14 | 4 |

Le détail filtré du résultat production contient uniquement l'avis `GHSA-vfj7-8cjw-p6xm` pour `braces`, sur un chemin vers `vinext`. Le détail complet filtré contient 42 entrées : 6 low, 20 moderate, 12 high et 4 critical. Les métadonnées ci-dessus restent plus élevées de deux high que ce détail filtré : elles ne doivent pas être interprétées comme trois occurrences de `braces`. Le scanner continue de juger le numéro upstream `3.0.3` et ne certifie pas le contenu du patch local. Le résultat complet contient également d'autres avis hors de ce lot, notamment sur l'outillage et ses dépendances.

Les exceptions **déjà configurées** restent explicitement `GHSA-w3rx-r6r6-pgpr` et `GHSA-5p2g-fcmc-qvqq`. Elles sont appliquées par la configuration d'audit existante ; ce lot n'en ajoute aucune et ne réévalue pas leurs mitigations. Les rapports JSON bruts sont conservés dans `.qa/braces-hardening/audit-before.json`, `audit-after.json`, `audit-prod-before.json` et `audit-prod-after.json`.
