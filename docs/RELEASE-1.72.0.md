# Zentra 1.72.0 — Automation

## Fonctionnement

Une étape facultative présente Zentra Automation pendant la configuration, avec un accès aux réglages du compte. Les suggestions couvrent les opérations bancaires, le classement des documents, les brouillons de factures fournisseurs, les actions autorisées de l’assistant, les opérations inhabituelles, les échéances, les e-mails déjà importés et le mapping du catalogue CSV/Excel.

Le service central valide des choix fermés et les ressources accessibles à l’entreprise. Le modèle local existant est conservé. Les opérations sensibles conservent leurs validations habituelles. Les pannes et les propositions incertaines permettent de continuer manuellement. Un mode observation compare les propositions aux choix humains sans influencer ces choix.

Le site propose une option Gestion à 15 CHF/mois par entreprise. Le compte fondateur peut configurer la clé chiffrée, vérifier le service et le tarif Stripe, choisir les fonctions disponibles et consulter les métriques. Le rôle fondateur ne remplace pas un abonnement de l’entreprise : le site et chaque appareil partagent le même contrôle d’accès.

Le parrainage Gestion accorde 50 % sur la première mensualité de la nouvelle entreprise, puis 25 % sur une prochaine mensualité du parrain après paiement confirmé. Les remises sont vérifiées côté serveur et ne se cumulent pas sur une même facture. Aucun paiement réel ni récompense fictive n’a été créé pendant les contrôles.

## Contrôles

- Site : 1 102 tests réussis dans 84 fichiers, 63 tests existants ignorés. TypeScript et construction de production réussis. Le lint ciblé des nouveaux modules réussit ; le lint global conserve des erreurs existantes hors de ces changements.
- Application : 1 558 tests frontend réussis dans 187 fichiers ; deux tests des notes de version confirmés après le passage en 1.72.0. TypeScript, construction Vite et contrôle Rust réussis. Quatre nouveaux tests Rust sur SQLite réussis.
- Interface mobile : vérification à 320 px, clair/sombre, quatre langues, choix manuel, correction et aperçu de mapping sans débordement. Le bouton pour continuer sans option fonctionne. Les erreurs de rechargement à chaud de la page de recette ont disparu après rechargement complet ; aucune erreur nouvelle lors du parcours final.
- Windows : démarrage et redémarrage de l’exécutable exact dans un profil vierge ; démarrage et redémarrage sur une copie de données synthétiques vérifiées de 1.71.1. Identité d’installation, documents, pièces jointes et écritures préservés. Le test ancien utilisant l’exécutable 1.61 a été bloqué par le contrôle d’application Windows ; aucune protection système n’a été contournée. Pas de revendication d’installation NSIS interactive.
- Le test réel du fournisseur utilise une opération fictive. Les simulations de paiement ne prouvent pas une transaction client réelle.
- CI Mac : 141 contrôles WebKit d’apparence, sans anomalie de contraste détectée ; six parcours d’accès à l’entreprise en clair/sombre ; gestes, zoom des documents et zones sûres vérifiés en 320, 390 et 844 px, sans erreur relevée.

## Fichiers vérifiés

Source des binaires : `986f9f3bfec881362c7256942fa4cb27edf51fe5`.

| Plateforme | Fichier | Octets | SHA-256 |
|---|---|---:|---|
| Windows | Zentra_1.72.0_x64-setup.exe | 23644037 | D07F620056513553C039CB02C8D94261E2EC690001C9C6D9766BAC89CB78D36B |
| iPhone | Zentra-1.72.0-iPhone-unsigned.ipa | 25150415 | D6A9B584F1C463E182A13D5FA9813411BDDE638E85FDCC277C530C8979749C1D |
| Android | Zentra-1.72.0-Android-arm64-test.apk | 76235279 | 4CA0DBC7ABA562F85E6C7AF5756215B46C053E5C4DBA6DE0043055DEA573AD3A |
| Mac | Zentra_1.72.0_macos-universal.dmg | 50526238 | 1328510E708F1C4D61A547BE9D120FFB446E1D759D061D88768C1EEB6FA044B1 |
| Mise à jour Mac | Zentra_1.72.0_macos-universal.app.tar.gz | 50498094 | 27DF30196A68C4AFA982F229404B7946F8B4BD83416B0AF2A9CEC599B082516B |

Le canal Windows a été relu publiquement en 1.72.0 après propagation du cache de 60 secondes. Sa signature Ed25519 a été vérifiée indépendamment. Le canal partagé historique reste inchangé.

iPhone : compilation Codemagic `6aaf4c746a6e2b5dd905a738`, ARM64 iPhoneOS, identifiant `ch.zentra.mobile`, iOS 15 minimum. Les tests natifs Liquid Glass ont réussi. Android : compilation `6aaf4c74783bb921e32702e0`, APK ARM64, alignement 16 Ko et signature durable vérifiés. Certificat : `23fc4c8370a5ec7ac15380825a46c599760607105d2df3d5668d3bdc76b6e670`.

Les fichiers Windows et iPhone ont été retéléchargés intégralement depuis Supabase, et Android depuis GitHub, avec comparaison SHA-256. Preuves locales : `outputs/release172/release-proof.json` et `outputs/release172/public172/` dans le checkout natif.

Mac : compilation Codemagic `6aaf4c741612b76327cfdb94`, ARM64 et x86_64, macOS 12 minimum, identifiant `ch.zentra.desktop`. La signature ad hoc a été vérifiée sur Mac. La clé et le canal de mise à jour sont présents dans les deux architectures. La signature Ed25519 de l’archive a été vérifiée indépendamment ; le DMG et l’archive ont été retéléchargés intégralement depuis Supabase avec comparaison SHA-256. Le canal Mac signé est publié en 1.72.0, cache de 60 secondes.

Les quatre plateformes sont proposées dans [la version 1.72.0](https://github.com/leartshbj1/zentra/releases/tag/v1.72.0) et sur [la page de téléchargement](https://zentraapp.ch/download). Les anciens fichiers sont conservés.

## Distribution

Windows sans certificat Authenticode ; IPA non signé, à signer via Sideloadly/AltStore ; APK de test avec débogage activé ; Mac sans notarisation Apple. Aucun essai sur appareil physique mobile, ni publication App Store ou Play Store, n’est revendiqué. Aucun accès propriétaire ni clé du fournisseur n’est intégré aux fichiers.

Le [guide de démarrage](AUTOMATION-DEMARRAGE.md), le [dossier technique](ZENTRA-AUTOMATION.md) et la [liste des fichiers](AUTOMATION-FICHIERS.md) détaillent le déploiement et les réglages restant à effectuer par chaque client.
