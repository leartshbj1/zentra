# Zentra 1.68.0 — publication mobile

## Périmètre

Nouvelle interface mobile décrite dans [MOBILE-DESIGN-2026-09-15.md](MOBILE-DESIGN-2026-09-15.md), avec les notes intégrées dans les quatre langues. La livraison porte uniquement sur iPhone et Android. Windows et macOS restent publiés en 1.67.2 ; le manifeste historique partagé reste en 1.46.1.

Les deux paquets viennent de la révision `60d9db653fb5f16a0fe52dbb3e41da1356e0a56f`, également ciblée par le tag `v1.68.0`.

## Paquets vérifiés

| Paquet | Taille | SHA-256 |
| --- | ---: | --- |
| `Zentra-1.68.0-iPhone-unsigned.ipa` | 25 019 426 octets | `A068D7F9ED471C945CD26D39C63A139BB89E00140542977D366BCE75442270E5` |
| `Zentra-1.68.0-Android-arm64-test.apk` | 75 321 871 octets | `455CA6A845264112155D9DDD127BC5EEB23E128F3E2EF1E8A8E4E2A58E3AB47B` |

- iPhone : build Codemagic `6aa881b3db99403bee610ceb` terminé avec toutes ses étapes réussies. IPA ARM64 pour appareil physique, identifiant `ch.zentra.mobile`, iOS 15 minimum ; archive et métadonnées vérifiées à nouveau après téléchargement. Quatre tests natifs des contrôles Apple réussis, zéro échec. IPA non signé, à signer via Sideloadly ou AltStore.
- Android : build Codemagic `6aa881c0fbde8d66cfbb05b7` terminé avec toutes ses étapes réussies. APK ARM64, Android 7 minimum, `versionCode=1068000`. Signature locale avec l’identité de préversion persistante et vérification avec `apksigner`. Alignement 16 Ko validé avant et après signature. La clé temporairement déchiffrée est supprimée après signature.
- Certificat Android : `23fc4c8370a5ec7ac15380825a46c599760607105d2df3d5668d3bdc76b6e670`, identique à celui du téléchargement public 1.46.1 vérifié pour comparaison (`versionCode=1046001`). Cela vérifie la compatibilité de signature et l’ordre des versions, sans constituer un test de migration exécuté sur Android.
- Les essais d’interface sont détaillés dans le document de conception. TypeScript et les quatre tests existants de téléchargement du site réussissent. Le site a été recompilé avec ses nouveaux liens. Aucun de ces deux paquets n’a été lancé sur un téléphone physique pendant cette publication ; aucun essai d’émulateur Android de ce paquet n’a été effectué.

## Distribution

- [IPA public Supabase](https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases/Zentra-1.68.0-iPhone-unsigned.ipa), avec fichier `.sha256.txt` adjacent.
- [APK public GitHub](https://github.com/leartshbj1/zentra/releases/download/v1.68.0/Zentra-1.68.0-Android-arm64-test.apk), avec fichier `.sha256.txt` adjacent.
- [Préversion mobile GitHub](https://github.com/leartshbj1/zentra/releases/tag/v1.68.0) : IPA et APK disponibles, sans remplacer la publication stable des versions ordinateur.
- Les téléchargements publics des deux paquets et leurs fichiers d’empreinte ont été récupérés anonymement et comparés aux originaux, octet pour octet par SHA-256.
- L’APK conserve le mode débogable des préversions Android précédentes. Il dépasse la [limite de 50 Mo des projets Supabase gratuits](https://supabase.com/docs/guides/storage/uploads/file-limits) et utilise donc l’hébergement GitHub déjà employé pour les APK. Aucune souscription payante n’a été activée.
- La publication des fichiers ne constitue pas une distribution App Store ou Google Play. Installation et renouvellement de signature iPhone restent manuels.

Preuves locales : `.qa/mobile168-proof`, `.qa/codemagic-artifacts-6aa881b3db99403bee610ceb`, `.qa/codemagic-artifacts-6aa881c0fbde8d66cfbb05b7`, `desktop/artifacts/iphone` et `desktop/artifacts/android`.

La page de téléchargement est publiée dans Sites 148, depuis la révision du site `cf78b1549580ee1be110d2cc973772c4c8e483f0`. Déploiement `appgdep_6aa8868a157081918c3ad77824fc0e10` confirmé réussi le 14 septembre 2026 à 23:44:05 UTC (15 septembre en Suisse). Sites 147 était une préparation non déployée.
