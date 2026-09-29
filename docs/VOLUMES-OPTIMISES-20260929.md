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
