# Détails des opérations Automation

Lot postérieur à la source gelée de 1.90.5, non inclus dans cet installateur. Mode Operate, identité existante et activité en premier conservées.

Les dates absentes ou invalides affichent une indisponibilité explicite plutôt que 1970 ou une erreur de rendu. Le pourcentage de confiance est localisé et seulement affiché pour un nombre fini entre zéro et un ; zéro reste une valeur valable. Les libellés de commandes, étapes et extraits sont traduits en français, allemand, italien et anglais. Le texte reçu et les choix définis par l'entreprise restent inchangés.

Pour une décision incertaine, deux choix radio remplacent la liste déroulante : les explications longues restent lisibles sur téléphone et avec le texte agrandi. Aucun choix initial, aucune confirmation activée avant sélection. Identifiants, révisions, droits et charges utiles sont conservés ; le traitement en cours désactive les commandes.

## Vérification et revue finale

- 42 tests réussis dans cinq fichiers, dont 16 sur le détail d'opération ; TypeScript et build Vite réussis. Le gros chunk préexistant reste à traiter séparément.
- 16 scénarios Chromium bureau et WebKit mobile à 320/390 px, quatre langues et deux thèmes. Contrôle du refus de confirmation sans choix, des charges utiles exactes, de la lecture seule, des commandes occupées, de l'absence de débordement horizontal et des cibles de 44 px.
- Deux passes visuelles regroupées. La première a montré une explication coupée dans le sélecteur allemand à 200 % ; les radios corrigent ce défaut. La seconde confirme les choix et commandes lisibles. Le titre très long se coupe encore au milieu de mots à 320 px et 200 % : limite de la grille de résumé existante, non masquée.
- Contrôle final du diff : styles limités à `.automation-centre .ac-run__choice`, palette existante (`--accent`, `--border`), typographie système, aucune animation ou carte décorative ajoutée. Aucun effet sur les secrets, le serveur ou l'exécution des automatismes.

Preuves : `desktop/.qa/automation-run-tests.log`, `automation-run-build.log`, `automation-run-review/proof.json` et ses captures. Les fixtures sont synthétiques ; elles ne prouvent pas un traitement réel de messagerie ni une installation mobile physique. Le journal des rendez-vous et les autres formulaires avancés restent à examiner.
