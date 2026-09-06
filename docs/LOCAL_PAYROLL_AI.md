# Lecture locale des fiches de salaire

Zentra lit le document sur l'appareil. Tesseract reconnaît les images et Qwen repère le destinataire dans le texte. Les valeurs proposées doivent être présentes dans le document ; les dates, identifiants et contacts suivent des contrôles supplémentaires. La création du collaborateur reste une action de l'utilisateur.

- Modèle : [ggml-org/Qwen3-0.6B-GGUF](https://huggingface.co/ggml-org/Qwen3-0.6B-GGUF), révision `b5f37287796e5be0ea3dab2e7430873fb3f73e49`.
- Fichier : `Qwen3-0.6B-Q4_0.gguf`, 428 970 080 octets, Apache-2.0.
- SHA-256 : `da2572f16c06133561ce56accaa822216f2391ef4d37fba427801cd6736417d4`.
- Le premier téléchargement est mis en cache localement. La taille et le SHA-256 sont vérifiés avant chaque chargement. Aucun document n'est transmis à Hugging Face.
- Les fichiers exécutables OCR/WASM et les langues sont embarqués. Voir `desktop/public/ocr/README.md` pour leurs sources.
- WebGPU est utilisé lorsqu'il fonctionne ; le mode WebAssembly compatible reste disponible. Le modèle est chargé après libération de l'OCR. L'annulation termine le worker et les résultats incomplets ne sont pas appliqués.
- La base mensuelle et le taux d'activité d'une image doivent être retrouvés dans deux segmentations OCR. Les totaux brut/net ne deviennent jamais le salaire contractuel.

Le correctif pnpm de wllama 3.6.1 vérifie réellement une instruction Memory64 avant de choisir ce runtime. Il évite une fausse détection dans WebKit. Il protège aussi le traitement des erreurs de worker contre une erreur non textuelle et une pile impossible à décoder. Le chargement importe explicitement l'entrée compilée `esm/index.js`.

Validation : tests de contrôle des champs et du cache, lecture de la même fiche locale dans Edge et WebKit, contrôle manuel du formulaire, tests des PDF natifs et des interfaces à 320, 390 et 1440 pixels. Les tests sur navigateur ne remplacent pas un essai sur un iPhone ou Android physique.

L'ancien banc d'essai SmolVLM est retiré : son runtime Transformers/ONNX ne fait plus partie des dépendances de l'application. La lecture des anciennes preuves d'import est conservée.
