# Polices des documents Zentra

Inter (sans empattement) et Literata (avec empattements) sont proposées dans
l’atelier pour le document, le titre ou un passage sélectionné. Les fichiers
locaux servent à la fois à l’éditeur et aux exports PDF natifs, sans téléchargement
par l’application. Chaque famille comprend les vrais styles normal, gras,
italique et gras italique.

Les huit fichiers TrueType occupent 254 836 octets au total. Le PDF intègre
uniquement les variantes utilisées. Les documents Helvetica, Times et Courier
conservent leurs ressources et mesures antérieures. La partie de paiement QR
garde ses propres polices Helvetica.

## Sources et licences

Sources du dépôt officiel Google Fonts, figées à ces révisions :

- [Inter](https://github.com/google/fonts/tree/0b58fb370093f9a9f4ff785d94405710b79de67c/ofl/inter), copyright The Inter Project Authors ; [licence locale](inter-OFL.txt).
- [Literata](https://github.com/google/fonts/tree/4e5f06dbb274a27ebe71ed54ea706b3ee40eabd9/ofl/literata), copyright The Literata Project Authors ; [licence locale](literata-OFL.txt).

Les deux familles sont distribuées sous SIL Open Font License 1.1, sans nom
réservé déclaré. Les avis de copyright originaux et la licence complète sont
conservés dans les métadonnées de chaque fichier, y compris les octets intégrés
au PDF. Les URL, empreintes SHA-256, tailles et mesures sont dans `manifest.json`.

## Reconstruction

Dans un environnement Python de développement séparé, installer
`fonttools==4.65.0`, puis, depuis la racine du dépôt :

```sh
python desktop/scripts/build-document-fonts.py
```

Le script vérifie les empreintes des sources contre le manifeste existant,
crée des instances statiques de poids 400/700 avec une taille optique de 14,
puis conserve les caractères imprimables Windows-1252. Il produit les fichiers
TrueType et `desktop/src-tauri/src/document_embedded_font_data.rs` avec leurs
mesures réelles. La reconstruction à version identique est reproductible octet
pour octet ; une modification des sources nécessite une revue du manifeste.

L’étendue des caractères reste celle de l’atelier : les accents français,
allemands et italiens, notamment, sont pris en charge. Cette extension n’ajoute
ni toutes les écritures Unicode, ni l’import de polices personnelles, ni l’import
de documents Word complets. Un nouveau moteur natif est nécessaire ; les
installateurs Windows 1.60.0 antérieurs à cet ajout n’incluent pas ces polices.
