# Zentra 1.39 — lecture des pièces jointes et formulaires

Version en préparation, non publiée. Le canal stable reste en 1.38.0 tant que les nouveaux paquets ne sont pas vérifiés.

Les PDF des dossiers de projets disposent d'un lecteur commun avec pagination, zoom, ajustement à la largeur et texte extractible. Les commandes restent accessibles en portrait et paysage. Les photos s'adaptent à l'écran ; les erreurs et le nouvel essai sont visibles dans la fenêtre. Le fichier original reste intact pour le téléchargement et le partage. Le lecteur est chargé à la demande et ne dessine qu'une page à la fois.

Les actions de modification respectent la lecture seule dans les listes et les formulaires. Si les droits changent pendant une saisie, son contenu est conservé et l'enregistrement est désactivé avec une explication. La consultation, les dossiers et les exports restent accessibles.

La palette verte et ambrée, la navigation et les animations introduites dans la version précédente sont conservées. Le schéma SQLite reste à 57 ; cette version ne modifie pas les calculs financiers.

Vérifications des sources : 726 tests UI, TypeScript/Vite, parcours Edge/WebKit aux largeurs 320, 390, 844 et 1440 px. Le lecteur PDF a aussi été testé après compilation avec la CSP de production. Détails et limites : [pièces jointes](AUDIT-LECTURE-PIECES-JOINTES.md) et [lecture seule](AUDIT-LECTURE-SEULE-2026-09.md). Les vérifications des paquets de cette version seront ajoutées après leur construction.
