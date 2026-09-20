# Zentra 1.73.0 — Automation pour toute l’entreprise

## Fonctionnement

Les collaborateurs partagent l’accès Automation de leur entreprise, sans activation individuelle. Le titulaire reste responsable de l’abonnement ; les titulaires et administrateurs règlent les fonctions de l’équipe. Les droits de gestion existants restent appliqués, notamment pour les comptes en lecture seule.

Les paramètres de l’application permettent de choisir les fonctions, le mode et les seuils. Le tableau de bord des entreprises équipées présente le bilan de la journée suisse : analyses terminées, suggestions, choix confirmés et détail par fonction. Les confirmations de suggestions ne sont pas présentées comme des paiements ou écritures réalisées. Le bilan s’actualise en arrière-plan toutes les 15 secondes quand l’application est visible, ainsi qu’au retour au premier plan et après une confirmation.

Les écrans de gestion proposent des outils contextuels repliables : classement de documents, opérations et messages, examen des échéances et recherche du bon formulaire. Les validations métier existantes restent nécessaires. Les nouveaux écrans sont traduits dans les quatre langues de l’application et adaptés aux modes clair/sombre ainsi qu’aux petits écrans.

## Vérifications

- Serveur : 113 tests réussis, dont accès partagé par rôle, séparation des entreprises, révocation, calcul de la journée suisse et changement d’heure. Construction de production et TypeScript réussis.
- Interface native : 1 563 tests réussis dans 188 fichiers ; construction Vite et TypeScript réussis. Quatre tests Rust Automation réussis sur le code avant le changement de numéro de version.
- Recette des composants actifs : 320, 390 et 1 280 px, quatre langues, clair/sombre, consultation des réglages par un membre, sauvegarde administrateur, analyse et confirmation fictives, masquage sans option. Aucun débordement observé.
- Mac CI : 141 contrôles d’apparence WebKit sans anomalie de contraste détectée, six parcours d’accès à l’entreprise réussis et contrôles des gestes, zones sûres et zoom documentaire à 320, 390 et 844 px.
- Windows : compilation, version, provenance, clé et endpoint embarqués, signature Ed25519 et fichiers publics vérifiés. Le contrôle d’application Windows a bloqué le démarrage du nouvel exécutable ; aucun démarrage réussi, installation NSIS ou essai de migration de cette version n’est revendiqué. Aucune protection Windows modifiée. Le canal automatique reste en 1.72.0.

## Sources et publication

Source des binaires : `434e5f8433a0ac5c5f4a156a7c7565e0d6792e5d`.

Serveur : `76cc958120ebbf8d6f69a4489420a8b082deddea`, déploiement réussi `appgdep_6aafc71a995c81918a55126a2024907e` (version Sites 188). La migration additive `0054_automation_company_activity.sql` crée uniquement deux index ; les changements fondateur concurrents de la migration 0053 sont conservés.

Mac : build `6aafc69a466383c8d7ce7f8d`, réussi. Archive universelle ARM64/x86_64, identifiant `ch.zentra.desktop`, macOS 12 minimum, signature ad hoc vérifiée sur le runner. Archive de mise à jour signée Ed25519, endpoint et clé embarqués vérifiés. Fichiers publics retéléchargés et comparés ; canal Mac vérifié en 1.73.0, cache 60 secondes.

iPhone : build `6aafc75534287724ed0de324`, réussi avec tests des zones tactiles Liquid Glass. IPA ARM64 pour iPhone physique, iOS 15 minimum, identifiant `ch.zentra.mobile`. Version, plateforme Mach-O, somme de contrôle du rapport CI original et révision source vérifiées. L’IPA public Supabase a été retéléchargé intégralement et comparé ; il nécessite une signature personnelle avant installation.

Android : build `6aafc78a51ea1a6d09133869`, réussi. APK de test ARM64, alignement 16 Ko et signature durable vérifiés. Empreinte du certificat : `23fc4c8370a5ec7ac15380825a46c599760607105d2df3d5668d3bdc76b6e670`. Le paquet est une version débogable de test, pas une publication Google Play.

La release GitHub `v1.73.0` est publique ; l’APK a été retéléchargé sans authentification depuis cette release et son SHA-256 correspond au fichier signé. La page de téléchargement conserve Windows 1.72 et propose Mac, iPhone et Android 1.73. Déploiement du site réussi : version 189, source `518cfc1c6f5aac06c8894fa6094e61063fbea23d`, identifiant `appgdep_6aafcec0e2ec8191ba8193e4b0a4ac02`.

| Fichier | Octets | SHA-256 |
|---|---:|---|
| Zentra_1.73.0_x64-setup.exe | 23677075 | 011C57469725920F6B78D829BC5A28501239E5CB7FF7F7706862B5D82775D892 |
| Zentra_1.73.0_macos-universal.dmg | 50541771 | 0C87AD977FADF60FAB04E2D82FC7A202C78E0FB7605479DF800408FF4A780332 |
| Zentra_1.73.0_macos-universal.app.tar.gz | 50517442 | A9159BBC060C49B486859B3B9E26240D1C1B7C91D7EF0F5C33F3DE61EFCCBD48 |
| Zentra-1.73.0-iPhone-unsigned.ipa | 25162526 | B65607E42E2190023BD989FD0AEFE5E0AC842F4AEDC51C1580E8A5E6CE2B7A38 |
| Zentra-1.73.0-Android-arm64-test.apk | 76243471 | 8BC4F2A791E19EEC63191992B9235D8AA70193526EC250C8F493E48CEA2D2AAB |

Preuves : `outputs/release173/validation.json`, `macos173/verification.json`, `public173/`. Windows sans Authenticode et Mac sans notarisation Apple. Les appareils physiques mobiles n’ont pas été testés dans cette recette.
