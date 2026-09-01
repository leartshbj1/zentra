# Mises à jour intégrées Elyko

Le code de l’application contient le flux complet de recherche, téléchargement et installation Tauri 2. Il reste volontairement inactif si une édition n’a pas été construite avec une clé publique et un manifeste HTTPS valides. Cette fermeture par défaut évite qu’un poste client ou le rendu web puisse substituer sa propre source de mise à jour.

Références officielles :

- <https://v2.tauri.app/plugin/updater/>
- <https://v2.tauri.app/distribute/sign/windows/>

## Secrets et valeurs nécessaires

La clé privée ne doit jamais être ajoutée à Git, au site ou à l’application installée.

- `ELYKO_UPDATER_PUBLIC_KEY` : contenu exact en base64 du fichier public produit par `tauri signer generate`. Elyko décode et contrôle le document Minisign public avant d’activer le canal; cette valeur publique est intégrée à l’exécutable.
- `ELYKO_UPDATER_ENDPOINT` : URL HTTPS du manifeste stable, par exemple `https://elyko.alb-leart1.chatgpt.site/downloads/latest.json`. Elle est intégrée à l’exécutable et ne peut pas être changée par le frontend.
- `TAURI_SIGNING_PRIVATE_KEY` : chemin ou contenu de la clé privée, injecté uniquement dans l’environnement du poste ou du runner de publication.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` : mot de passe de cette clé, injecté uniquement comme secret de publication.

La paire Tauri sert à authentifier les archives de mise à jour. Elle ne remplace pas un certificat Authenticode Windows, recommandé séparément pour l’identité de l’éditeur et SmartScreen.

La liaison de licence de cette version utilise un UUID d’installation protégé par DPAPI et une validation HTTPS signée. Elle ne constitue pas une attestation matérielle TPM/CNG et ne garantit donc pas une résistance absolue face à un administrateur local capable de cloner l’identifiant ou de modifier l’exécutable. Une future édition durcie devra enregistrer une clé non exportable TPM/CNG, prouver sa possession par défi serveur et associer sa clé publique à la licence.

Sur le poste de publication du propriétaire, `scripts/build-local-signed-updater.ps1` sait charger la paire située dans `%LOCALAPPDATA%\Elyko\release-signing`. Le mot de passe n’est pas stocké en clair : son blob est protégé par Windows DPAPI et ne peut être déchiffré que par le même compte Windows. Le script efface les quatre variables sensibles de son processus dans un bloc `finally`.

## Création de la paire, une seule fois par le propriétaire

À exécuter dans un emplacement privé et sauvegardé hors du dépôt :

```powershell
pnpm tauri signer generate -- -w C:\chemin-prive\elyko-updater.key
```

Perdre cette clé privée empêcherait de livrer de futures mises à jour aux installations qui connaissent sa clé publique. Ne pas la régénérer entre deux versions déjà distribuées.

## Build de publication signé

Depuis `desktop`, définir les quatre variables dans le processus de build, puis utiliser la configuration dédiée. Le build normal reste possible sans ces secrets mais produit une édition dont le canal intégré est inactif.

```powershell
$env:ELYKO_UPDATER_PUBLIC_KEY = Get-Content -Raw C:\chemin-prive\elyko-updater.key.pub
$env:ELYKO_UPDATER_ENDPOINT = "https://elyko.alb-leart1.chatgpt.site/downloads/latest.json"
$env:TAURI_SIGNING_PRIVATE_KEY = "C:\chemin-prive\elyko-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "mot-de-passe-fourni-par-le-gestionnaire-de-secrets"
pnpm build:updater
```

`src-tauri/tauri.updater.conf.json` active `createUpdaterArtifacts` uniquement pour ce build. La valeur `pubkey` qu’il contient est un marqueur non secret requis par le chargement du plugin; le module Rust la remplace par la clé publique contrôlée et figée à la compilation. Tauri produit l’installateur NSIS et son fichier `.sig`; le build doit échouer si la clé de signature privée requise n’est pas disponible.

`pnpm build:updater` passe obligatoirement par `scripts/build-updater-release.ps1`. Le script supprime uniquement les quatre sorties canoniques de la version courante, lance un nouveau build Tauri, exige que l’EXE, le NSIS et sa signature aient été recréés après le début du build, puis enregistre leurs chemins et SHA-256 dans `target/x86_64-pc-windows-gnu/release/elyko-updater-build-provenance.json`.

## Préparation du lot publiable

Le wrapper local efface les secrets après le build. Avant le staging, rechargez
uniquement la clé **publique** et l’endpoint dans le processus courant, puis
préparez le lot dans les 24 heures suivant ce build frais :

```powershell
$elykoSigningRoot = Join-Path $env:LOCALAPPDATA 'Elyko\release-signing'
$env:ELYKO_UPDATER_PUBLIC_KEY = (Get-Content -Raw (Join-Path $elykoSigningRoot 'elyko-updater.key.pub')).Trim()
$env:ELYKO_UPDATER_ENDPOINT = 'https://elyko.alb-leart1.chatgpt.site/downloads/latest.json'

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stage-updater-release.ps1 `
  -Version 1.11.0 `
  -PreviousVersion 1.10.0
```

Le script n’accepte que ces sorties canoniques :

- `target/x86_64-pc-windows-gnu/release/Elyko.exe` ;
- `target/x86_64-pc-windows-gnu/release/bundle/nsis/Elyko_<version>_x64-setup.exe` ;
- le fichier direct `Elyko_<version>_x64-setup.exe.sig` produit par Tauri 2 ;
- la preuve JSON du même build.

Les anciens paramètres de chemin restent tolérés pour l’automatisation, mais toute valeur différente de ces chemins exacts est refusée. Le staging recalcule chaque SHA-256 et rejette aussi un fichier remplacé après la création de la preuve. L’EXE autonome sert seulement aux contrôles de configuration et d’Authenticode : il ne peut plus servir de témoin pour publier un autre NSIS ancien ou renommé. La vérification Ed25519 porte directement sur le NSIS et son `.exe.sig`, conformément au format d’artefact updater de Tauri 2.

Par défaut, le staging refuse aussi tout binaire sans signature Authenticode valide. Lorsqu’un propriétaire a explicitement autorisé une publication avant l’achat du certificat éditeur, `-AllowUnsignedAuthenticodeForPublication` consigne un avertissement distinct et permet le lot. Cette dérogation ne doit jamais être confondue avec la signature Tauri/Ed25519, qui reste obligatoire et vérifiée. Le site doit alors annoncer clairement que Windows peut afficher « Éditeur inconnu ».

Le test négatif autonome ne nécessite ni certificat ni clé privée :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-updater-release-provenance.ps1
```

Il doit confirmer le refus d’un NSIS renommé hors du chemin canonique et d’un NSIS dont le contenu change après le build attesté.

## Manifeste statique

Publier l’installateur et le manifeste sur HTTPS. La valeur `signature` est le contenu du fichier `.sig`, pas son URL.

```json
{
  "version": "1.11.0",
  "notes": "Résumé contrôlé des changements.",
  "pub_date": "2026-09-01T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "CONTENU_EXACT_DU_FICHIER_SIG",
      "url": "https://elyko.alb-leart1.chatgpt.site/downloads/Elyko_1.11.0_x64-setup.exe"
    }
  }
}
```

Avant publication, tester depuis une vraie installation de la version précédente : recherche, progression, rejet d’une signature altérée, installation en place et conservation de la base locale. La version du manifeste doit être strictement supérieure à celle de l’application installée.
