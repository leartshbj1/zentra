# Organiser les tâches d’un projet

Ouvrez **Projets → Tâches & jalons**. Une tâche décrit une action à faire ; un jalon représente une étape clé qui peut regrouper plusieurs tâches.

## Créer une tâche simplement

1. Cliquez sur **Nouvelle tâche**.
2. Indiquez **Que faut-il faire ?**, puis choisissez le **Projet**.
3. Enregistrez. Le responsable, l’étape et la date sont facultatifs. **Priorité et précisions** permet d’ajouter des consignes si nécessaire.

Si vous n’avez qu’un projet ouvert, il est proposé automatiquement. Aucune date ni personne n’est inventée. Si vous choisissez un autre projet dans le formulaire, le titre et les consignes restent présents ; seule l’étape sélectionnée est retirée, puisqu’elle appartient au projet précédent.

Après l’enregistrement, le planning affiche le projet concerné et retire la recherche ou les filtres qui pourraient masquer votre nouvelle tâche.

## Regrouper les tâches dans une étape

Utilisez **Nouveau jalon**, donnez un nom à l’étape et choisissez son projet. Vous pouvez lui attribuer une date et un responsable. Dans chaque tâche, le champ **Étape du projet** permet ensuite de la rattacher à cette étape.

Une étape peut commencer alors que ses tâches restent à faire. Pour la terminer, terminez ou annulez d’abord les tâches liées. Le bouton **Voir les tâches à terminer** affiche les tâches concernées. Les compteurs suivent cette sélection ; **Toutes les tâches du projet** revient à la vue du projet.

## Corriger un blocage

| Situation | Ce que propose l’application |
| --- | --- |
| Nom ou projet manquant | Le champ à compléter est indiqué et reçoit le focus. |
| Date de tâche après celle de l’étape | La date de l’étape est expliquée et un bouton **Utiliser le…** la propose. Vous pouvez aussi choisir une autre date compatible, retirer l’échéance ou changer d’étape. |
| Date d’étape avant une tâche liée | Le nom et la date de la tâche concernée apparaissent. Le bouton propose la dernière date nécessaire. |
| Une tâche à rouvrir appartient à une étape terminée | **Voir l’étape à rouvrir** affiche cette étape. Rouvrez-la avant de rouvrir la tâche. |
| Un chronomètre tourne sur la tâche | **Ouvrir le chronomètre** ouvre l’écran Temps. Arrêtez le pointage avant de terminer ou d’annuler la tâche. |
| L’enregistrement est refusé | Le formulaire reste ouvert avec les informations saisies et l’explication. Corrigez puis enregistrez à nouveau. |
| L’enregistrement a réussi, mais la relecture échoue | La récupération relit les données. Elle ne renvoie pas la commande de création déjà réussie. |

Sur téléphone, l’explication d’une date et son bouton de correction sont placés au-dessus des actions fixes de la fenêtre. Les actions **Commencer**, **Terminer** et **Rouvrir** sont écrites à côté de leur icône.

## Vérifications de ce lot

- 168 tests d’interface ciblés : préparation des formulaires, planning, focus depuis l’agenda et comportement des mutations.
- 6 tests natifs du planning, dont création/modification, liens et dates, chronomètre, audit des actions, suppression et sauvegarde/restauration.
- 8 parcours guidés dans chaque dossier de travail : Edge et WebKit, 320×568, 390×844, 844×390 et 1440×900. Les recettes vérifient aussi les refus, les doubles clics, la reprise des lectures, la conservation des saisies, les filtres et la lecture seule.
- Compilation TypeScript et Vite réussie dans les deux dossiers ; captures inspectées.

Recette : `desktop/tests/planning-guided-journey.mjs`. Les profils de test sont fictifs. Ce lot ne prouve pas une synchronisation entre deux appareils ni une installation sur un téléphone physique. Aucun installateur ni IPA n’a été publié dans ce lot.
