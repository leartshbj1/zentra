# Listes mobiles — clients, projets, devis et factures

Lot du 27 septembre 2026, issu du point 8 de l’audit premier client. Sources plus récentes que le paquet public 1.90.4 ; **aucun nouvel installateur publié dans ce lot**.

## Comportement

- Clients : une liste de noms ouvre directement le dossier. Les coordonnées complètes, le nombre de projets et les actions sont regroupés sous « Coordonnées et actions ». Les actions utilisent les mêmes callbacks et restrictions que le tableau desktop. Les clients archivés restent consultables et réactivables.
- Projets : le nom ouvre le dossier ; les chiffres, dates, tâches et commandes de modification sont sous « Détails et actions » sur téléphone. Le rendu desktop conserve toutes ces informations dépliées.
- Ventes : lignes plus compactes, montant, état, date et aperçu visibles. La référence bancaire reste consultable dans les actions sur mobile. Les montants encaissés et leurs justificatifs comptables ne sont pas masqués. Tri, filtres, pagination, recherche et actions métier conservés.
- Libellés ajoutés en français, allemand, italien et anglais. Les styles utilisent les couleurs du thème, sans toucher aux documents imprimés.

## Validation

- TypeScript et compilation web réussis ; les 50 ressources de marque restent valides.
- 30 tests unitaires réussis : ordre des documents, interface documentaire et traductions.
- 20 contrôles d’écran/parcours, quatre vues dans cinq configurations : WebKit 320 DE/clair, 390 FR/sombre, 320 DE/sombre avec texte 200 % et coordonnées longues ; Edge 768 IT/clair et 1440 EN/sombre.
- Recherche trouvée/vide, fermeture des filtres par Échap et retour du focus, ouverture des métadonnées, dossier client, clients archivés, détail et dossier projet. En lecture seule, les boutons modifier/archiver du client sont désactivés et son dossier reste consultable.
- Aucun débordement horizontal de page ou de commande visible ni erreur JavaScript dans ces parcours. Les commandes d’en-tête mesurées ont au moins 44 × 44 px sur mobile.
- Deux passages visuels au total. Le premier contrôle de largeur des devis à 320 px lisait la table avant son adaptation mobile et incluait des descendants repliés. Le test attend désormais les attributs de table et deux frames, et exclut ces descendants. La confirmation passe sur les cinq configurations.
- Détecteur statique ciblé sur le nouveau CSS et la barre de filtres : aucun signalement. Cela ne constitue pas un audit automatique de tout `WorkspaceApp.tsx`.

Preuves : `desktop/.impeccable/review/mobile-collections/` et `mobile-collections-confirmation/`, dont `results.json`, `detector.json` et les PNG. Parcours reproductible : `desktop/tests/mobile-collections.mjs`. Données et services natifs simulés dans le harness local ; aucune entreprise réelle modifiée.

## Limites observées

Deux clients et deux projets sont entièrement visibles à 390 × 844 px avec la fixture courante. La première facture mesure environ 262 px et le premier devis 232 px ; le second document commence dans la première vue, mais n’y tient pas entièrement. Les preuves d’encaissement, noms longs et texte agrandi augmentent volontairement la hauteur. Ce lot ne garantit donc pas trois documents complets au premier écran.

À 200 %, certains libellés historiques des onglets se coupent encore au milieu des mots ; ils restent accessibles sans débordement. La densité des en-têtes étroits, cette présentation des grands textes et les avertissements de poids du build restent des sujets de l’audit. Le paquet installé, VoiceOver et les appareils physiques n’ont pas été testés dans ce lot.
