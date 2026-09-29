# Lecture optimisée du gros historique — 29 septembre 2026

Mesure locale de la source applicative **1.90.8**, `cc92d4cf31d4cbcff61fe4ad285ab6cd4cded0e3`. Le différentiel de `desktop/src-tauri`, du manifeste et du verrou pnpm est vide par rapport à cette source publiée. Le checkout comporte ensuite uniquement des recettes CI et de la documentation.

## Protocole et intégrité

La fixture existante explicitement fictive est copiée avec l'API SQLite de sauvegarde dans `outputs/release1908/volume-release/profile`. Elle contient **5 001 factures, 5 001 devis, 40 001 lignes de chaque type** et trois pièces. Aucun compte, licence ou secret client n'est copié. Le test exige le marqueur fictif et le nom `Atelier Recette 1905`, puis active `query_only`.

Trois passages du test `database::workspace_volume_tests::profile_synthetic_workspace_volume` ont réussi en compilation `--release --locked --lib`. Rust **1.97.1**, hôte **x86_64-pc-windows-gnu** ; le binaire de test porte SHA256 `d323a414146613bdc67b57ca4e544ed235c5272fe7412e87016aa674e6889364`. Ce binaire GNU est distinct de l'installateur MSVC publié.

Chaque passage compare la valeur complète avant/après sérialisation JSON. Le contrôle indépendant avant/après conserve les empreintes des **110 tables métier** et des **trois fichiers**, l'intégrité SQLite, les références et l'équilibre du journal. La seule égalité de taille ne sert pas de preuve d'identité.

| Phase | Passage 1 | Passage 2 | Passage 3 | Médiane |
|---|---:|---:|---:|---:|
| Lecture de l'espace | 1 289,95 ms | 1 374,77 ms | 866,95 ms | 1 289,95 ms |
| Sérialisation JSON | 163,13 ms | 162,17 ms | 161,03 ms | 162,17 ms |
| Volume JSON | 49 718 748 octets | 49 718 748 octets | 49 718 748 octets | 49 718 748 octets |

Les journaux des trois commandes, `before.json`, `after.json` et le relevé complet `report.json` sont conservés sous `outputs/release1908/volume-release/`. Le script `outputs/release1908/volume-release-proof.py` reproduit la copie et les vérifications de conservation sans écraser une fixture existante.

## Portée

Le test lit cinq tables avant la lecture complète : il mesure un historique **après échauffement**. Il exclut l'ouverture de base, l'attente du verrou applicatif, le transfert IPC, la normalisation JavaScript et le rendu React. Il ne démontre ni démarrage à froid, ni capacité du serveur pour 150 entreprises, ni résultat sur appareil mobile ou machine modeste.

Les anciens relevés debug du parcours natif et la mesure de normalisation JavaScript ont des périmètres différents. Aucun pourcentage d'amélioration globale n'est déduit de leur comparaison avec ces durées.

Le volume de presque 50 Mo reste à réduire. Une piste vérifiée dans le code est la lecture des deux tableaux complets du journal comptable alors que l'interface utilise une commande comptable dédiée. Toute projection allégée doit conserver les données des sauvegardes, exports et synchronisations, et être validée séparément avant distribution.

## Projection de l'interface — source supplémentaire validée, non distribuée

Après la publication 1.90.8, une projection dédiée est ajoutée aux deux retours natifs de l'interface : `get_workspace` et `complete_onboarding`, dans ses modes Essential et Complete. Elle évite les deux lectures exhaustives et la sérialisation de `journal_entries` et `journal_lines`. Les jointures utilisées pour les montants, avoirs et remboursements restent actives. Le normaliseur TypeScript ne consomme pas ces deux collections ; Comptabilité les lit déjà par `get_journal` et `get_ledger`.

Le `LocalStore::get_workspace()` interne reste complet pour les exports JSON/CSV. Les sauvegardes et la collaboration conservent leur archive SQLite complète. Il n'y a ni modification du schéma, ni suppression en base, ni cache interentreprise.

**Trois tests Rust optimisés passent** : journal fictif non vide et équilibré, identité de tous les autres champs, lecture comptable dédiée inchangée, deux modes de configuration, export JSON effectif, présence des lignes dans le CSV, extraction des journaux complets depuis les deux archives de sauvegarde et collaboration. Le test de profilage reste ignoré par défaut puis est exécuté explicitement avec succès.

Le comparatif utilise le même binaire optimisé, la même instance et la même connexion. Trois paires après échauffement alternent l'ordre complet/interface. L'égalité structurelle de tous les champs conservés est vérifiée hors chronométrage. La nouvelle vérification indépendante avant/après retrouve les 110 tables et trois pièces identiques.

| Mesure | Lecture complète | Interface allégée |
|---|---:|---:|
| Lecture médiane | 858,79 ms | 778,94 ms |
| Sérialisation médiane | 160,13 ms | 141,15 ms |
| Taille JSON, identique aux trois passages | 49 718 748 octets | 40 778 676 octets |

Réduction de **8 940 072 octets, soit 17,98 % du payload local**. Ce pourcentage ne représente ni un gain global de démarrage, ni une baisse mesurée du trafic serveur. Les durées complètes de ce comparatif ne doivent pas être mélangées avec celles de la première campagne plus haut : ordres et charge de machine diffèrent.

Preuves : `outputs/release1908/volume-release/{interface-tests.log,interface-profile.log,interface-report.json,before.json,after.json}`. `interface-report.json` conserve les empreintes du binaire et des trois sources mesurées. Commandes reproductibles :

```powershell
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --release --lib interface_workspace_ -- --nocapture
$env:ZENTRA_VOLUME_PROFILE = (Join-Path (Get-Location) 'outputs/release1908/volume-release/profile')
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --release --lib database::workspace_volume_tests::profile_synthetic_interface_workspace_volume -- --ignored --exact --nocapture
Remove-Item Env:ZENTRA_VOLUME_PROFILE
```

Lors de cette recette, le second test a été lancé directement depuis le chemin du binaire que Cargo venait de produire, sans nouvelle compilation. La source applicative conserve provisoirement le numéro technique 1.90.8 ; elle **ne remplace pas les paquets publiés**. Une nouvelle version et ses recettes de distribution sont nécessaires pour livrer cette projection.
