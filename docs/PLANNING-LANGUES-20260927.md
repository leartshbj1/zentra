# Planning — langues et lisibilité

Lot du 27 septembre 2026, postérieur à 1.90.6 et non publié dans cette version.

## Comportement

Les filtres, tâches, étapes, formulaires, confirmations et erreurs reconnues du planning utilisent le français, l’allemand suisse, l’italien ou l’anglais sélectionné. Les noms de projet, titres, notes et dates enregistrées restent des données utilisateur. Le libellé « Personne responsable » évite la confusion avec l’interlocuteur commercial.

Les erreurs natives connues proposent une correction sans afficher le statut interne `todo`. Une erreur inconnue conserve son diagnostic exact. Une saisie refusée garde son titre, ses notes et sa date ; aucune réussite n’est affichée à sa place. Le modèle de données, les permissions, la synchronisation et les commandes natives ne changent pas.

Les boutons longs peuvent occuper plusieurs lignes. Sur téléphone, les indicateurs disposent de toute la largeur de leur case ; « In Bearbeitung » ne sort plus du compteur. L’en-tête redondant des étapes a été retiré et la bordure d’erreur suit le contour de son encadré. L’identité Operate / Précision calme, les couleurs et la navigation existantes sont conservées.

## Vérifications

- Suite d’interface complète : **1 818 tests dans 223 fichiers** avant la dernière correction des notifications et des compteurs. Les **19 tests ciblés finaux**, TypeScript et le build passent après localisation des notifications ; un nouveau build et les parcours visuels contrôlent la dernière CSS.
- **16 parcours** Edge/Chromium et WebKit, FR/DE/IT/EN, 320 et 1440 px : saisie requise, correction de date, erreur puis reprise, notes conservées, création de tâche et d’étape, confirmation traduite, absence de débordement des boutons et indicateurs.
- **Quatre parcours supplémentaires** dans les deux moteurs, DE/EN, 320 px avec texte à 200 %.
- **Huit parcours français complets** passent avant les dernières corrections de texte/CSS : fermeture et réouverture, chronomètre, reprise après lecture échouée, lecture seule et protection contre un double enregistrement.
- Détecteur exécuté une seule fois : six avis sur des couleurs/tailles préexistantes, aucun signal principal. Aucun contournement ni liste d’exclusion ajouté. Revue visuelle locale, sans prétendre à une validation indépendante.

Preuves : `desktop/.qa/planning-{all-tests,final-unit,final-build}.log`, `desktop/.qa/planning-languages/report.json`, `desktop/.qa/planning-languages-large/report.json`, `desktop/.qa/planning-guided/report.json` et captures dans ces dossiers. Les premières tentatives de recette ont corrigé une attente de texte non rogné, le chargement asynchrone de langue et un sélecteur de test du menu Temps ; ces échecs ne prouvaient pas des régressions produit.

Les données et commandes de la recette sont fictives ; les appels externes sont bloqués. Cela vérifie l’interface web partagée, pas une installation Windows, macOS, iOS ou Android, ni la collaboration sur le serveur réel. L’indisponibilité des comptes et la distribution native demeurent des sujets distincts.
