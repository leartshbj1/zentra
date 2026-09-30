# Zentra 1.90.11 — Notes

Préparation du 30 septembre 2026. La publication n'est pas encore attestée.

Cette version inclut le module Notes du commit `17c11b9a` : notes d'entreprise et de projet, recherche, épingles, cases à cocher, enregistrement local et synchronisation d'entreprise. L'éditeur mobile est dédié à la saisie et respecte les marges natives. Le périmètre et les limites sont décrits dans [FEATURE-NOTES.md](FEATURE-NOTES.md).

Les versions package, Cargo, lockfile et Tauri passent à 1.90.11. L'historique embarqué annonce les Notes dans les quatre langues. Les fichiers 1.90.10 construits avant les Notes ne servent pas de preuve pour ce lot.

Validation de préparation : 74 tests frontend ciblés réussis (Notes, bridge, préférences, navigation et historique). Les recettes existantes Notes et SQLite sont conservées. Les builds cloud Windows et Apple exécutent aussi les tests natifs `work_notes` avant empaquetage. Les artefacts seront liés au commit de cette préparation, puis contrôlés avant publication.

La distribution reste celle des canaux existants : installateur Windows, paquet macOS, IPA iPhone et APK Android. La signature updater est distincte d'Authenticode, de la notarisation Apple et d'une publication App Store/Google Play. Aucune de ces validations supplémentaires n'est déduite d'une compilation ou d'un test navigateur.

La première tentative cloud (pipeline 282) a révélé une assertion de restauration des immobilisations restée au schéma 60. Elle compare désormais au schéma courant, 61, sans modifier le comportement produit. Apple a exécuté les dix tests natifs Notes avec succès avant cet arrêt. La suite frontend complète passe localement : 1 905 tests réussis et un saut attendu. Les fichiers de cette tentative ne sont pas publiés ; une nouvelle source sera construite et vérifiée.
