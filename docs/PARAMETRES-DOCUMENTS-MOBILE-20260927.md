# Réglages des documents et reprise bexio — 27 septembre 2026

## Changement

Sur téléphone, la personnalisation commence par le document, avec un sélecteur de type, deux vues (« Mon document » / « Mes réglages ») et l’enregistrement accessible. Le titre et l’introduction répétés dans la rubrique Paramètres disparaissent. Le plan des zones du document devient dépliable. Les réglages, l’historique d’annulation, la recherche d’outils et le grand atelier restent disponibles.

L’import bexio laisse les choix Clients, Fournisseurs et Articles et services se répartir selon leur longueur. L’aide à la préparation du fichier est dépliable ; les limites réelles de l’import restent visibles. Si la vérification de l’entreprise échoue, son message reste présent même après un changement de catégorie. Réessayer relance cette vérification ; le fichier reste désactivé tant qu’un périmètre d’entreprise valide n’a pas été reçu. La confirmation et la protection native par entreprise ne sont pas contournées.

Les textes de l’import et les commandes d’entrée de l’atelier utilisent le dictionnaire FR/DE/IT/EN. La traduction exhaustive des outils avancés de composition reste un autre travail : ce lot ne la déclare pas terminée. Les noms importés, en-têtes du fichier et contenus personnalisés ne sont pas traduits.

## Preuves limitées à ce lot

- `desktop/tests/document-settings-mobile.mjs` : 24 configurations Chromium/WebKit, 320/390/1440 px et quatre langues. Aperçu initial visible à taille normale sur téléphone, modification conservée entre les vues, refus puis reprise de la vérification, ajout fictif d’un fournisseur dans le périmètre attendu, absence de débordement horizontal. Captures FR/DE pour chaque moteur et taille.
- Même parcours en texte à 200 % : quatre configurations à 320 px en DE/EN, avec contrôles géométriques des mots et de la séparation des actions. Une page plus haute est attendue ; aucun gain de lisibilité par réduction de la police.
- `document-workbench-journey.mjs` : huit parcours, deux moteurs × 320/390/844/1440 px. Les 25 destinations de recherche ouvrent le bon contrôle ; sélection et annulation du texte, déplacement du logo, erreur d’enregistrement puis reprise, blocage de fermeture pendant l’enregistrement, exports des quatre catégories et réglages après rechargement.
- 30 tests de composition, d’annulation, de navigation, de validation et d’import réussis. TypeScript et Vite vérifiés séparément. Les rapports navigateur sont sous `desktop/.qa/document-settings-mobile/`, `document-settings-large-text/` et `document-workbench-{chromium,webkit}/`.

La revue de finition initiale a demandé de corriger trois points : chevauchement après erreur sous Chromium avec texte agrandi, mots coupés dans les commandes et traductions d’entrée manquantes. Après correction et reprise des 24 + 4 parcours, le verdict indépendant est **ship**, chacun de ces trois points étant jugé résolu. Cette conclusion reste limitée aux corrections évaluées. Les 68 captures comprennent 36 vues normales, 16 vues à texte agrandi et 16 vues du grand atelier. Le détecteur a été exécuté une fois : cinq avertissements et 66 indications concernent essentiellement les styles hérités et les polices des documents personnalisables ; ils ne sont pas présentés comme une analyse vide.

## Portée

Les documents PDF sont des exemples synthétiques issus du rendu natif antérieur et utilisés pour éprouver cette interface. Les appels d’import et de sauvegarde sont simulés dans ces parcours : aucune donnée client, import réel, export système ni installation iPhone n’est validé par ces images. Les tests du parseur et des contrôles de composition sont réels, mais cette modification ne touche pas le moteur PDF ni le stockage natif.

La source corrigée doit encore être incluse dans une nouvelle version. Les installateurs publics 1.90.3 ne contiennent pas ce lot. L’état Supabase, la planification autonome et les autres points de l’audit restent indépendants.
