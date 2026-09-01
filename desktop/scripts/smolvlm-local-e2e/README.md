# SmolVLM local payroll E2E

Manual, fail-closed browser harness for the same local inference stack as the
Zentra payroll worker. It imports the pinned model constants from
`src/payrollAiModel.ts`, Transformers.js from the desktop dependency lock, and
forces `device: "wasm"` with the production dtypes.

This is a base-model check, not evidence of a Zentra fine-tune. A run only
passes when the model emits strict JSON and the employee name, gross cents and
net cents all match the visible fixture values.

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
