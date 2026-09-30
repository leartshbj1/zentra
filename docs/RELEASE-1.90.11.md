# Zentra 1.90.11 — Notes

Publication du 30 septembre 2026, source de l’application `b03d0851b19ab79bffe9c9bc61cd5003ff52ddab`. Les quatre fichiers sont disponibles dans la [release 1.90.11](https://github.com/leartshbj1/zentra/releases/tag/v1.90.11) et sur la [page de téléchargement](https://zentraapp.ch/download).

## Livraison vérifiée

- Builds CircleCI Windows **199**, Apple **200**, Android **201** réussis sur la même source. Notes : **58 tests UI et 10 tests Rust réussis sur Windows et Mac**. Suite frontend locale : **1 905 réussis, 1 ignoré** ; SQLite portable : **5 contrôles réussis**.
- Recette Windows **204** (vérificateur `8e4fd612c7b925cf47f4de61642de7251111e630`) et recette Mac intégrée au build **200** : installation/démarrage et redémarrage dans des profils isolés, schéma **61**, intégrité SQLite **ok**. Elles ne couvrent pas un parcours Notes interactif.
- Recette Android **202** (vérificateur `ae7979fc24d35f4e63b1546c2461059cfaef4b52`) : émulateur, redémarrage, identité conservée, thèmes et clavier validés. Émulateur chargé et ralentissements observés ; aucune fluidité sur téléphone physique n’est déduite de ce test.
- Signatures updater Windows/Mac vérifiées ; APK signé avec l’identité persistante existante et alignement 16 Ko. **12 assets publiés**, inventaire/tailles/SHA-256 conformes aux paquets locaux, tag à la source exacte. Téléchargements anonymes des quatre installables : **HTTP 200**, tailles exactes.
- Site **305**, source `f2ae8d88baef51884bd970eeb63deec3f2ab2003`, déploiement `appgdep_6abd7fca336481918dd25fbcad37a6f2` **succeeded**. Téléchargements, manifestes Windows/Mac et annonce Notes mis à jour. **14 tests** de liens/manifestes, TypeScript et build du site réussis. Aucun changement backend ni nouvel examen navigateur du site public.

| Installable | Octets | SHA-256 |
| --- | ---: | --- |
| Windows x64 | 24 532 646 | `b3f74d9378cb0e25a494de44a8eccd5bf2074a7a1bf243879bba0b5bad7f6ec8` |
| Mac universel DMG | 54 852 858 | `7023a5af3017efed2710ca16e99d7176bf40f6ead15bd28fd7f9acf6129e66ee` |
| IPA iPhone | 27 437 572 | `300762272772da47df5fa46455b0dc5eda8f896d7f8e0f9524ee8d1cede69067` |
| APK Android | 39 899 870 | `0fc6dc48083440da1cb4ced8c7e2a937cf372b9ee7d8ce2e9916d841129fbc39` |

Les reçus locaux sont conservés sous `outputs/release1911` : `github-published-proof.json`, `public-head-proof.json`, `site-published-proof.json`, vérifications de paquets et recettes. L’IPA reste non signée, le Mac non notarié et Windows sans Authenticode. Pas de publication App Store/Google Play, de recette sur téléphone physique ni de réception Notes entre appareils réels attestée. Ce compte rendu ne modifie pas la source gelée des paquets.

## Préparation et historique

Cette version inclut le module Notes du commit `17c11b9a` : notes d'entreprise et de projet, recherche, épingles, cases à cocher, enregistrement local et synchronisation d'entreprise. L'éditeur mobile est dédié à la saisie et respecte les marges natives. Le périmètre et les limites sont décrits dans [FEATURE-NOTES.md](FEATURE-NOTES.md).

Les versions package, Cargo, lockfile et Tauri passent à 1.90.11. L'historique embarqué annonce les Notes dans les quatre langues. Les fichiers 1.90.10 construits avant les Notes ne servent pas de preuve pour ce lot.

Validation de préparation : 74 tests frontend ciblés réussis (Notes, bridge, préférences, navigation et historique). Les recettes existantes Notes et SQLite sont conservées. Les builds cloud Windows et Apple exécutent aussi les tests natifs `work_notes` avant empaquetage. Les artefacts seront liés au commit de cette préparation, puis contrôlés avant publication.

La distribution reste celle des canaux existants : installateur Windows, paquet macOS, IPA iPhone et APK Android. La signature updater est distincte d'Authenticode, de la notarisation Apple et d'une publication App Store/Google Play. Aucune de ces validations supplémentaires n'est déduite d'une compilation ou d'un test navigateur.

La première tentative cloud (pipeline 282) a révélé une assertion de restauration des immobilisations restée au schéma 60. Elle compare désormais au schéma courant, 61, sans modifier le comportement produit. Apple a exécuté les dix tests natifs Notes avec succès avant cet arrêt. La suite frontend complète passe localement : 1 905 tests réussis et un saut attendu. Les fichiers de cette tentative ne sont pas publiés ; une nouvelle source sera construite et vérifiée.
