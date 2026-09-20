# Zentra 1.75.0 — publication du 20 septembre 2026

Synchronisation des entreprises par blocs de contenu réutilisables, avec notifications temps réel et reprise des transferts. Le serveur vérifie toujours l’accès à l’entreprise pour chaque requête. Une connexion temps réel active évite les vérifications complètes répétées ; une interruption rétablit les vérifications de secours.

Les archives reconstruites sont contrôlées intégralement avant leur fusion. Les règles existantes sur les encaissements, la numérotation, les modifications concurrentes et la conservation des données locales restent appliquées. Les anciennes versions conservent leur protocole de transfert.

## Construction

Le workflow CircleCI est désactivé par défaut. Après contrôle des crédits gratuits du compte, lancer une seule pipeline avec le paramètre booléen `release=true`. Il compile Windows x64/MSVC et Mac universel avec un IPA ARM64 pour iPhone physique. Les tests natifs de collaboration et de compte doivent réussir avant la compilation des installateurs. Aucun secret de production ni clé privée de signature n’est transmis à ce service.

Les paquets Windows et Mac doivent être signés localement pour les mises à jour Tauri, vérifiés puis retéléchargés après publication avant de modifier les canaux publics. Le Mac conserve une signature ad hoc sans notarisation. L’IPA n’a pas de signature Apple de distribution.

## État

Les fichiers Windows, Mac et iPhone sont publiés dans le stockage public `zentra-releases`. Les deux canaux `latest-windows.json` et `latest-macos.json` annoncent 1.75.0, avec signatures de mise à jour vérifiées et fichiers retéléchargés puis comparés intégralement. Android reste en 1.74.0.

## Validation

- Windows : [compilation 3](https://app.circleci.com/pipelines/github/leartshbj1/zentra/4/workflows/7ecc20fe-e1f9-4311-b237-13ef6d84eff7/jobs/3), source `df95e0099c1e84dbe03d580bf7e0312a13d87b11`. 26 tests de collaboration et 13 tests de compte réussis ; un diagnostic nécessitant des copies fournies explicitement est ignoré. 29 tests d’interface réussis.
- Apple : [compilation 2](https://app.circleci.com/pipelines/github/leartshbj1/zentra/2/workflows/5d2b39ed-ae0f-409e-b30d-b4f9511e3c10/jobs/2), source `5b4afe933b9f6760049818f220fc4701bb698796`. Les mêmes 39 tests natifs et 29 tests d’interface réussissent. Les différences de source entre les deux compilations concernent uniquement la configuration CI.
- [Installation Windows et deux démarrages](https://app.circleci.com/pipelines/github/leartshbj1/zentra/11/workflows/972d15c1-8c3f-4321-8663-b221192dd4bf/jobs/7) et [deux démarrages du paquet Mac](https://app.circleci.com/pipelines/github/leartshbj1/zentra/6/workflows/5c1c0e9e-27bd-4db6-951c-953dd863749b/jobs/4) réussis dans des profils jetables. SQLite : schéma 60, intégrité et clés étrangères valides. Aucun profil client utilisé.
- Le binaire effectivement extrait de l’installateur Windows démarre également sur le PC local dans un profil séparé. La version installée dans le profil utilisateur n’a pas été remplacée pendant ces essais.
- WebKit : gestes, zoom documentaire, zones sûres, invitations et entreprise partagée ; 141 cas d’apparence sans contraste insuffisant détecté. 4 tests natifs Apple des commandes tactiles réussis sur simulateur.
- IPA : archive intacte, version 1.75.0, ARM64, plateforme iPhoneOS, identifiant `ch.zentra.mobile`, iOS 15 minimum. Pas d’essai sur iPhone physique, ni de signature de distribution Apple.
- Mac : deux architectures Intel et Apple Silicon, macOS 12 minimum, signature ad hoc contrôlée par `codesign --verify --deep --strict`. Pas de notarisation Apple.

Sur le scénario d’encaissement avec documents inchangés, le transfert nécessaire est de 205 346 octets sur 12 704 151 octets sous Windows, et de 205 067 sur 12 703 872 sous Mac. L’archive reconstruite et les encaissements sont vérifiés. Il s’agit d’un scénario de test, pas d’une garantie de capacité pour un nombre donné de clients en production.

Le premier contrôle d’installation comparait le binaire brut au binaire empaqueté. [Tauri 2.11.4 remplace un marqueur de type de paquet lors de la création du NSIS](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs). Le contrôle final vérifie intégralement le fichier attendu après cette seule transformation. Les trois octets de ce marqueur sont les seules différences observées ; aucune différence arbitraire n’est tolérée.

## Empreintes SHA-256

| Fichier | SHA-256 |
| --- | --- |
| `Zentra_1.75.0_x64-setup.exe` | `a4758cc0f6c859d80e23754a5f05d82ce191ae986ecee79f2e7995c52a596d2b` |
| `Zentra_1.75.0_macos-universal.dmg` | `c423ade257a91ad3a66bddbf81f63680026ebc886d68fea1cb965012afec0bd3` |
| `Zentra_1.75.0_macos-universal.app.tar.gz` | `30e3f175a20d04fc85afdc99b4384e3f3540e254265a6639c44888e9df7ec5ac` |
| `Zentra-1.75.0-iPhone-unsigned.ipa` | `2617b6a22e4c222f4d9f982abf0e95fe1542dbc79777ba03499099d06d1bfb0d` |

Les signatures Ed25519 des mises à jour Windows et Mac sont générées localement avec la clé historique. Le contrôle rejette aussi un fichier volontairement altéré. L’installateur Windows n’a pas de signature Authenticode ; la signature de mise à jour ne la remplace pas.
