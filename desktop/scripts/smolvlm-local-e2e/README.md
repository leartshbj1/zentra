# SmolVLM local payroll E2E

Manual, fail-closed browser harness for the same local inference stack as the
Zentra payroll worker. It imports the pinned model constants from
`src/payrollAiModel.ts`, Transformers.js from the desktop dependency lock, and
forces `device: "wasm"` with the production dtypes.

This is a base-model check, not evidence of a Zentra fine-tune. The direct
`index.html` scan check contains no sample identity or monetary values in its
prompt. It accepts only the short `NAME/GROSS_CHF/NET_CHF/END` protocol, then
passes its normalized result through the production parser. A run only passes
when the employee name, gross cents and net cents match the visible fixture.

1. Render page 1 of the sample PDF to a temporary PNG:

   ```powershell
   New-Item -ItemType Directory -Force ..\tmp\pdfs\smolvlm-e2e | Out-Null
   pdftoppm -f 1 -singlefile -r 150 -png ..\public\downloads\exemple-fiche-salaire-zentra.pdf ..\tmp\pdfs\smolvlm-e2e\page-1
   ```

2. From `desktop`, start Vite with `pnpm exec vite --host 127.0.0.1 --port 4179
   --strictPort`.

3. Open:

   ```text
   http://127.0.0.1:4179/scripts/smolvlm-local-e2e/index.html?image=/@fs/ABSOLUTE/PATH/TO/page-1.png
   ```

Model files are downloaded once and kept in the browser cache. The PDF and PNG
stay local; no Zentra database or user record is opened or changed.

## Worker de production (contrôle recommandé)

`worker.html` traverse le vrai `payrollLocalAi` et le vrai
`payrollAi.worker.ts`. Il vérifie donc aussi le Worker module, la sélection du
runtime, le chargement ONNX local, les délais d'inactivité, la stratégie
WebGPU/CPU et le parseur utilisé par l'assistant d'import. En CPU/WASM, une
seule lecture non vérifiée en phases ciblées est attendue; elle reste une
proposition faible dans l'application.

Après avoir démarré Vite comme à l'étape 2, lancer Chrome avec un profil QA
isolé et le port DevTools (PowerShell Windows) :

```powershell
$qaProfile = Join-Path (Resolve-Path ..) '.qa\chrome-cdp-smolvlm'
Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -WindowStyle Hidden -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9223',
  "--user-data-dir=$qaProfile", 'about:blank'
)
```

Puis, depuis `desktop`, exécuter le probe reproductible :

```powershell
$env:ZENTRA_CDP_ENDPOINT = 'http://127.0.0.1:9223'
$env:ZENTRA_SMOLVLM_TIMEOUT_MS = '900000'
node scripts/smolvlm-local-e2e/probe-cdp.mjs 'http://127.0.0.1:4179/scripts/smolvlm-local-e2e/worker.html?image=/@fs/C:/CHEMIN/ABSOLU/page-1.png'
```

Pour exercer le vrai chemin visuel d'un scan sans couche texte, ajouter
`&text=none` à l'URL. Ce mode ne passe que si le Worker extrait les mêmes
valeurs et rubriques depuis le PNG; à défaut, il doit échouer explicitement et
ne jamais valider un brouillon vide.

Le test est volontairement manuel et fail-closed : il sort avec le code 0
uniquement si le nom, le brut, le net et la stratégie de passages du Worker
sont corrects. Au premier lancement, une connexion est nécessaire pour
télécharger le modèle public figé depuis Hugging Face; ses fichiers sont
ensuite conservés dans le cache du profil QA. Le document testé et les sorties
d'analyse restent dans le navigateur local.
