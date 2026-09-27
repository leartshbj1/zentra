# Zentra — état courant des livraisons

Mis à jour le 27 septembre 2026, 18 h 03 (Europe/Zurich). Ce document décrit la livraison courante ; les notes `RELEASE-*` conservent son historique.

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

**Site 288**, source `1271b2f7fbcad8776c684d02b6a0e4b4c22bcdf3`, déployé le 27 septembre à 17 h 37, configuration 36. Déploiement : `appgdep_6ab938382c0881919c5865425fe63eb3`. Il conserve les lots précédents et ajoute le canal de mise à jour indépendant des comptes. Les trois manifestes `/updates/` sont vérifiés en production à 17 h 38 : HTTP 200 anonymes, contenu exact, `no-store`. Aucun nouveau paquet proposé ; ils décrivent 1.90.4. [Détail et transition](CANAL-MISE-A-JOUR-20260927.md).

**Planificateur non rétabli :** GitHub `support-mail-sync.yml` reste `disabled_manually` au contrôle de 17 h 20, dernière exécution observée le 20 septembre en échec. Aucun drapeau d’arrière-plan ajouté. La migration serveur 0065 empêche une fin ancienne ou rejouée de masquer un traitement récent bloqué. 84 tests isolés, TypeScript, lint, ressources de marque et compilation réussis. Le client planifié corrigé signale aussi une file non terminée à sa limite de temps ou de lots ; il est conservé dans le dépôt Sites, mais n’a pas été installé dans la branche GitHub exécutée par le planificateur. Ni traitement réel fermé, ni réception d’une alerte, ni capacité de 150 entreprises prouvés. Voir le lot serveur `docs/SCHEDULER-CONCURRENCE-20260927.md`.

**Connexion non rétablie :** le contrôle synthétique du 27 septembre à 16 h 53 a reçu HTTP 503 en 3,52 s, `Retry-After: 60`, `no-store`. Le contrôle direct Supabase à **17 h 26** confirme désormais **HTTP 402**, `exceed_egress_quota` et `exceed_storage_size_quota`. Aucun compte ni e-mail créé. Une capture de l’offre et de l’usage est demandée ; aucun abonnement d’hébergement modifié. Les essais réels de collaboration, d’abonnement et d’envoi partagé restent à faire.

## Sources plus récentes, pas encore dans un installateur

| Lot | Sources / preuve | État |
|---|---|---|
| E-mails de l’entreprise | `e862214e`, correction de reprise `9755b446` ; Windows 141 | Tests isolés réussis, serveur publié ; essai réel authentifié et paquet natif restant à faire |
| Catalogue simplifié et traduit | `493c6033`, `dd06158f` | Tests frontend et build réussis, non inclus dans 1.90.4 |
| Boutons tactiles | `9974e409` | 12 captures/parcours ciblés, non inclus dans 1.90.4 |
| Premiers pas Comptabilité, Banque, Relances | `7859c57f` | 64 tests unitaires, 27 contrôles UI et build réussis, non inclus dans 1.90.4 |
| Restauration et contrôle des documents | Natif `a7a503d8`, interface `6b266558` ; Windows 143 | 46 tests natifs distincts réussis, 1 recette HTTPS réelle ignorée ; 163 tests frontend, 16 parcours UI et build réussis. Non inclus dans 1.90.4 ; essai par installateur physique restant |
| Canal updater indépendant | `8f136cc4`, imports de tests corrigés `0de81490` ; Windows 145 réussi après l’échec de compilation de 144 | Serveur Sites 288 publié et vérifié ; 10 tests natifs Windows et 12 tests frontend/contrats passent. Nouveau client non inclus dans 1.90.4 ; vraie transition entre installateurs restante |
| Listes mobiles clients, projets, devis et factures | `docs/LISTES-MOBILES-20260927.md` | 30 tests unitaires, 20 contrôles UI et build réussis ; services natifs simulés. Non inclus dans 1.90.4 ; densité et grands textes à poursuivre |

Pour la prochaine livraison : figer une source commune après validation, conserver les empreintes de chaque paquet, tester l’installation, distinguer publication des fichiers et promotion du canal de mise à jour, puis remplacer ce tableau. Ne jamais modifier la source gelée d’une version déjà publiée.
