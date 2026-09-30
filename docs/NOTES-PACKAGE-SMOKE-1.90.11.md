# Recettes de paquets Notes 1.90.11

Recettes préparées le 30 septembre 2026, sans lancement ni résultat de réussite à ce stade.

| Élément | Cible |
| --- | --- |
| Version applicative | `1.90.11` |
| Source native figée | `b03d0851b19ab79bffe9c9bc61cd5003ff52ddab` |
| Branche du vérificateur | `codex/notes-release-1.90.11-smoke-20260930` |
| Paquet Windows | Job CircleCI `199` |
| APK Android | Job CircleCI `201`, même source native |
| SHA-256 de l’APK non signé | `6f3769f84189028e3e3de4fe2304862ed5e7431a7c6ac5a99f7ab3182bdb7ce3` |

Le build Android `201` est réussi à `2026-09-30T20:53:37.327Z`. Ses six artefacts ont été téléchargés avec l’outil `outputs/release1911/download-build.ps1` dans le dossier Android du worktree de release. L’APK non signé pèse `39 816 283` octets ; son empreinte ci-dessus a été calculée sur ces nouveaux octets. `download-proof.json` atteste le job, la source et le téléchargement. Cela ne constitue pas encore une recette réussie.

Le commit du vérificateur et les jobs de recette devront être consignés après exécution. Ils sont distincts de la source des paquets. Le workflow exige la branche ci-dessus avec `release: false`, comme les recettes existantes. Le parent a autorisé le push après validation de l’APK : il lance Android, puis Windows uniquement après une recette Android réussie. Les jobs de la première tentative ne sont pas utilisés.

## Windows

Sur le runner Windows jetable, depuis la racine du dépôt, le bootstrap du vérificateur attend au maximum dix minutes le build `199`, par lecture de l’API publique toutes les 45 secondes. Il vérifie la source à chaque lecture, s’arrête immédiatement sur `failed` ou `canceled`, et n’appelle la recette que sur `success`. Les requêtes et le dernier délai restent bornés par l’échéance.

La configuration appelle `desktop/scripts/bootstrap-notes-windows-smoke.ps1 -Job 199 -Source b03d0851b19ab79bffe9c9bc61cd5003ff52ddab`, qui lance alors :

```powershell
python desktop/scripts/cloud-package-smoke.py windows 199 b03d0851b19ab79bffe9c9bc61cd5003ff52ddab
```

Le script exige un job de build réussi et la révision exacte. Il télécharge la provenance, l’installateur `Zentra_1.90.11_x64-setup.exe` et `Zentra.exe` par HTTPS, contrôle version, identifiant, déclarations de tests natifs et SHA-256, puis installe silencieusement dans un dossier temporaire. Il compare l’exécutable installé au contenu attendu après la transformation documentée du marqueur NSIS.

Il démarre puis relance cet exécutable avec `HELVICHANTIER_DATA_DIR` dirigé vers un profil neuf. Il exige une base créée par l’application, le schéma `61`, une intégrité SQLite `ok`, aucune erreur de clé étrangère et un processus encore actif cinq secondes après l’initialisation. Les requêtes de contrôle utilisent `query_only=ON` et ne créent pas la base manquante.

Preuves attendues : `desktop/artifacts/smoke/windows-smoke.json` et `windows-startup.log` ; en cas d’échec, diagnostic `windows-failure.json` ou `installer-mismatch.json` selon l’étape.

## Android

La configuration épingle le SHA-256 indépendant de l’APK exact du job `201`. Le vérificateur lit désormais `SCHEMA_VERSION` dans `desktop/src-tauri/src/schema.rs` et exige cette valeur dans `profile_state`, soit `61` pour cette source. La version du manifeste est également lue depuis `desktop/package.json`.

Sur le runner Android jetable :

```bash
export ZENTRA_ANDROID_SMOKE_JOB=201
export ZENTRA_ANDROID_SMOKE_SOURCE=b03d0851b19ab79bffe9c9bc61cd5003ff52ddab
export ZENTRA_ANDROID_SMOKE_SHA256=6f3769f84189028e3e3de4fe2304862ed5e7431a7c6ac5a99f7ab3182bdb7ce3
timeout 18m bash desktop/scripts/smoke-android-release-candidate.sh
```

Les trois variables doivent être fournies explicitement ; les valeurs par défaut du script désignent un ancien candidat. Le placeholder d’empreinte n’est pas exécutable.

Le wrapper prépare un émulateur Android 35 neuf, sans fenêtre, avec traduction ARM64. Le vérificateur refuse un appareil physique ou une installation Zentra préexistante. Il exige le succès du job, la source exacte et l’empreinte téléchargée, puis contrôle le manifeste, l’architecture ARM64, l’intégrité ZIP et l’alignement ELF/RELRO pour des pages de 16 Ko. Une clé éphémère permet uniquement l’installation de test ; signature, alignement ZIP et identité du contenu avant/après signature sont vérifiés.

Le parcours coupe le réseau de l’émulateur, ouvre l’accueil et la configuration du compte, vérifie l’en-tête, les barres natives dans les thèmes clair/sombre, la saisie d’un brouillon d’identité avec clavier et le retour. Il arrête et relance l’application, compare le profil SQLite et l’identité protégée, puis recherche un crash Android de Zentra. Aucun compte n’est connecté et aucune entreprise n’est créée.

Preuves attendues dans `desktop/artifacts/android-release-smoke/` : `proof.json`, captures, arbres d’accessibilité, diagnostics de fenêtres/clavier, fournisseur WebView et journaux de l’émulateur et de l’application. Une réussite automatique ne remplace pas l’inspection des captures.

## Portée

Ces recettes attestent les contrôles de paquet et de démarrage ci-dessus dans des profils synthétiques. Elles ne vérifient pas l’édition de Notes, son autosauvegarde, ses appels IPC natifs ou sa synchronisation entre appareils. Elles ne constituent pas une recette sur des appareils physiques, une validation des stores, une signature commerciale ni une publication.
