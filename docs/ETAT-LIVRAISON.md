# Zentra — état courant des livraisons

Mis à jour le 27 septembre 2026, 17 h 03 (Europe/Zurich). Ce document décrit la livraison courante ; les notes `RELEASE-*` conservent son historique.

## Fichiers proposés au public

La version native publiée est **1.90.4**, source commune **`c07b1d4d3031659da6ba21388a70c464a6f83ec8`**. Les douze fichiers sont présents dans la release GitHub, contrôlée à nouveau aujourd’hui. Le site propose leurs liens immuables. La vérification HTTP des quatre téléchargements principaux date de 13 h 24 ; elle ne constitue pas un nouvel essai d’installation.

| Plateforme | Fichier / canal public | Signature de distribution | Dernier contrôle du paquet | Limite actuelle |
|---|---|---|---|---|
| Windows x64 | [Installateur 1.90.4](https://github.com/leartshbj1/zentra/releases/download/v1.90.4/Zentra_1.90.4_x64-setup.exe), 24 448 565 octets | Pas d’Authenticode ; signature du paquet de mise à jour vérifiée | CircleCI 138 + installation et deux démarrages dans 140 ; également installé et relancé sur le PC en profil séparé le 27 septembre ; schéma 60, intégrité `ok` | Pas de preuve de parcours métier entre deux installations connectées |
| macOS universel | [DMG 1.90.4](https://github.com/leartshbj1/zentra/releases/download/v1.90.4/Zentra_1.90.4_macos-universal.dmg), 54 501 155 octets ; archive `.app.tar.gz` aussi publiée | Signature ad hoc, sans notarisation ; signature de mise à jour vérifiée | CircleCI 137, arm64/x86_64, démarrage et relancement en profil séparé ; schéma 60, intégrité `ok` | Ne pas présenter ce paquet comme une distribution Apple validée |
| iPhone | [IPA 1.90.4](https://github.com/leartshbj1/zentra/releases/download/v1.90.4/Zentra-1.90.4-iPhone-unsigned.ipa), 26 027 955 octets | **Non signé** | Compilation arm64, paquet contrôlé, iOS 15+ ; CircleCI 137 | Installation et usage sur iPhone physique non validés ; pas de publication App Store |
| Android arm64 | [APK 1.90.4](https://github.com/leartshbj1/zentra/releases/download/v1.90.4/Zentra-1.90.4-Android-arm64-test.apk), 122 307 594 octets | Certificat de test persistant, débogable | CircleCI 139, alignement 16 K et ressources contrôlés | Pas de validation appareil/émulateur ni de publication Play Store |

Les signatures de mise à jour ne remplacent ni Authenticode, ni Developer ID/notarisation, ni la signature iPhone. **Les manifestes historiques Supabase n’ont pas été promus vers 1.90.4.** La présence d’un fichier sur la page de téléchargement ne prouve donc pas sa proposition automatique dans toutes les installations existantes.

Preuves locales : `outputs/release1904/SOURCES.json`, `github-published-proof.json`, `public-head-proof.json`, `smoke-windows/windows-smoke.json`, `smoke-macos/macos-smoke.json`, `installed-smoke/verification.json`. La dernière lecture des métadonnées GitHub est dans `outputs/release1904-current-public.json`.

## Site et services

**Site 286**, source `d8d2db14cf91d5195d1c9c5487f6ce3290a1bc77`, déployé le 27 septembre à 15 h 55, configuration 36. Déploiement : `appgdep_6ab9204876d08191a82b69e35724756b`. Il comprend le service d’e-mails partagé de Site 285 et les adresses de repli de l’icône Apple. Les icônes répondent 200 avec le même contenu officiel.

**Connexion non rétablie :** le contrôle synthétique du 27 septembre à 16 h 53 a reçu HTTP 503 en 3,52 s, `Retry-After: 60`, `no-store`. Aucun compte ni e-mail créé. Les essais réels d’abonnement, de collaboration entre appareils et d’envoi partagé ne sont pas validés par les tests isolés. Le blocage fournisseur constaté précédemment doit être résolu ; ce dernier HTTP 503 ne vérifie pas à lui seul sa cause exacte.

## Sources plus récentes, pas encore dans un installateur

| Lot | Sources / preuve | État |
|---|---|---|
| E-mails de l’entreprise | `e862214e`, correction de reprise `9755b446` ; Windows 141 | Tests isolés réussis, serveur publié ; essai réel authentifié et paquet natif restant à faire |
| Catalogue simplifié et traduit | `493c6033`, `dd06158f` | Tests frontend et build réussis, non inclus dans 1.90.4 |
| Boutons tactiles | `9974e409` | 12 captures/parcours ciblés, non inclus dans 1.90.4 |
| Premiers pas Comptabilité, Banque, Relances | `7859c57f` | 64 tests unitaires, 27 contrôles UI et build réussis, non inclus dans 1.90.4 |
| Restauration et contrôle des documents | Natif `a7a503d8`, interface `6b266558` ; Windows 143 | 46 tests natifs distincts réussis, 1 recette HTTPS réelle ignorée ; 163 tests frontend, 16 parcours UI et build réussis. Non inclus dans 1.90.4 ; essai par installateur physique restant |

Pour la prochaine livraison : figer une source commune après validation, conserver les empreintes de chaque paquet, tester l’installation, distinguer publication des fichiers et promotion du canal de mise à jour, puis remplacer ce tableau. Ne jamais modifier la source gelée d’une version déjà publiée.
