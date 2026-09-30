# Recettes de paquets Notes 1.90.11

État au 30 septembre 2026 : recette Android réussie ; recette Windows à relancer après un délai d’attente du build, avant tout essai du paquet Windows.

| Élément | Cible |
| --- | --- |
| Version applicative | `1.90.11` |
| Source native figée | `b03d0851b19ab79bffe9c9bc61cd5003ff52ddab` |
| Branche du vérificateur | `codex/notes-release-1.90.11-smoke-20260930` |
| Paquet Windows | Job CircleCI `199` |
| APK Android | Job CircleCI `201`, même source native |
| SHA-256 de l’APK non signé | `6f3769f84189028e3e3de4fe2304862ed5e7431a7c6ac5a99f7ab3182bdb7ce3` |

Le build Android `201` est réussi à `2026-09-30T20:53:37.327Z`. Ses six artefacts ont été téléchargés avec l’outil `outputs/release1911/download-build.ps1` dans le dossier Android du worktree de release. L’APK non signé pèse `39 816 283` octets ; son empreinte ci-dessus a été calculée sur ces nouveaux octets. `download-proof.json` atteste le job, la source et le téléchargement ; la recette distincte est décrite ci-dessous.

Le workflow `notes-package-1911` exige la branche ci-dessus avec `release: false`. La relance autorisée exécute uniquement Windows, sans dépendance `requires` vers Android, déjà validé. Aucun nouvel identifiant de job n’est connu à ce stade ; le commit du vérificateur et le résultat de cette relance devront être consignés après exécution.

## Windows

La tentative Windows `203` a échoué uniquement parce que le build `199` n’avait pas réussi avant l’échéance de dix minutes. `cloud-package-smoke.py` n’a pas été exécuté : cette tentative ne fournit aucun résultat d’installation ou de démarrage du paquet.

Pour la relance, le bootstrap attend au maximum 45 minutes le build `199`, avec une pause de 45 secondes entre les lectures de l’API publique. Il vérifie la source à chaque lecture, s’arrête immédiatement sur `failed` ou `canceled`, et n’appelle la recette que sur `success`. Les requêtes et le dernier délai restent bornés par l’échéance.

La configuration appelle `desktop/scripts/bootstrap-notes-windows-smoke.ps1 -Job 199 -Source b03d0851b19ab79bffe9c9bc61cd5003ff52ddab`, qui lance alors :

```powershell
python desktop/scripts/cloud-package-smoke.py windows 199 b03d0851b19ab79bffe9c9bc61cd5003ff52ddab
```

Le script exige un job de build réussi et la révision exacte. Il télécharge la provenance, l’installateur `Zentra_1.90.11_x64-setup.exe` et `Zentra.exe` par HTTPS, contrôle version, identifiant, déclarations de tests natifs et SHA-256, puis installe silencieusement dans un dossier temporaire. Il compare l’exécutable installé au contenu attendu après la transformation documentée du marqueur NSIS.

Il démarre puis relance cet exécutable avec `HELVICHANTIER_DATA_DIR` dirigé vers un profil neuf. Il exige une base créée par l’application, le schéma `61`, une intégrité SQLite `ok`, aucune erreur de clé étrangère et un processus encore actif cinq secondes après l’initialisation. Les requêtes de contrôle utilisent `query_only=ON` et ne créent pas la base manquante.

Preuves attendues : `desktop/artifacts/smoke/windows-smoke.json` et `windows-startup.log` ; en cas d’échec, diagnostic `windows-failure.json` ou `installer-mismatch.json` selon l’étape.

## Android

La recette `202` a réussi à `2026-09-30T21:07:36.18Z`, depuis le vérificateur `ae7979fc24d35f4e63b1546c2461059cfaef4b52`, sur l’APK `201` de source applicative `b03d0851b19ab79bffe9c9bc61cd5003ff52ddab`. Les 45 artefacts ont été téléchargés dans `outputs/release1911/smoke-android/` du worktree de release. `proof.json`, `download-proof.json`, les captures représentatives et les journaux d’incidents ont été relus.

La configuration épingle le SHA-256 indépendant de l’APK exact du job `201`. Le vérificateur lit désormais `SCHEMA_VERSION` dans `desktop/src-tauri/src/schema.rs` et exige cette valeur dans `profile_state`, soit `61` pour cette source. La version du manifeste est également lue depuis `desktop/package.json`.

Sur le runner Android jetable :

```bash
export ZENTRA_ANDROID_SMOKE_JOB=201
export ZENTRA_ANDROID_SMOKE_SOURCE=b03d0851b19ab79bffe9c9bc61cd5003ff52ddab
export ZENTRA_ANDROID_SMOKE_SHA256=6f3769f84189028e3e3de4fe2304862ed5e7431a7c6ac5a99f7ab3182bdb7ce3
timeout 18m bash desktop/scripts/smoke-android-release-candidate.sh
```

Les trois variables doivent être fournies explicitement ; les valeurs par défaut du script désignent un ancien candidat.

Le wrapper prépare un émulateur Android 35 neuf, sans fenêtre, avec traduction ARM64. Le vérificateur refuse un appareil physique ou une installation Zentra préexistante. Il exige le succès du job, la source exacte et l’empreinte téléchargée, puis contrôle le manifeste, l’architecture ARM64, l’intégrité ZIP et l’alignement ELF/RELRO pour des pages de 16 Ko. Une clé éphémère permet uniquement l’installation de test ; signature, alignement ZIP et identité du contenu avant/après signature sont vérifiés.

Le parcours coupe le réseau de l’émulateur, ouvre l’accueil et la configuration du compte, vérifie l’en-tête, les barres natives dans les thèmes clair/sombre, la saisie d’un brouillon d’identité avec clavier et le retour. Il arrête et relance l’application, compare le profil SQLite et l’identité protégée, puis recherche un crash Android de Zentra. Aucun compte n’est connecté et aucune entreprise n’est créée.

Les preuves CI sont dans `desktop/artifacts/android-release-smoke/` : `proof.json`, captures, arbres d’accessibilité, diagnostics de fenêtres/clavier, fournisseur WebView et journaux de l’émulateur et de l’application. Le profil reste au schéma `61`, intègre, sans erreur de clé étrangère, avec une identité protégée inchangée au relancement. Le délai observé jusqu’à l’accueil accessible est de `54 734 ms`, incluant capture et introspection ; il ne constitue pas une mesure isolée des performances.

## Portée

La réussite Android atteste les contrôles de paquet et de démarrage ci-dessus dans un profil synthétique ; Windows reste sans résultat de recette. Ces contrôles ne vérifient pas l’édition de Notes, son autosauvegarde, ses appels IPC natifs, sa synchronisation entre appareils ou ses performances. Aucun appareil physique n’a été testé. Ils ne constituent pas une validation des stores, une signature commerciale ni une publication.
