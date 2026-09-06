# Lecture seule et formulaires — 6 septembre 2026

Les listes de projets, clients, catalogue, devis, factures et temps proposaient encore certaines actions de modification pendant la lecture seule. La protection centrale des écritures existait déjà : le défaut concernait les commandes proposées et les formulaires. Les actions de création, modification, émission, conversion, règlement et archivage concernées sont maintenant désactivées ; filtres, dossiers, historiques, aperçus et exports restent accessibles.

Si les droits changent pendant une saisie, les formulaires partagés désactivent l'enregistrement et expliquent la lecture seule. La saisie reste présente, Annuler fonctionne, et le rétablissement des droits permet d'enregistrer. Cette protection couvre aussi les éditeurs d'agenda, de tâches et de jalons. Le formulaire d'export QR reste accessible.

## Vérifications

- 726 tests UI existants réussis, TypeScript et construction Vite réussis.
- Parcours Edge et WebKit à 320×568, 390×844, 844×390 et 1440×900. Contrôle des commandes, accès aux dossiers et historiques, aperçu des devis et factures, export PDF par la passerelle simulée.
- Révocation des droits dans une fiche client valide : bouton désactivé, tentative de soumission directe rejetée par la protection existante, aucune écriture appelée, saisie conservée, annulation disponible. Rétablissement des droits : un seul appel d'enregistrement et fiche actualisée.
- Même changement de droits dans les formulaires d'agenda, de tâche et de jalon : saisie conservée et enregistrement désactivé. Captures mobile portrait/paysage examinées ; absence de débordement extérieur et d'erreur JavaScript dans les huit parcours.

Les données sont synthétiques et la passerelle est isolée. Ces contrôles vérifient l'interface ; ils ne constituent pas un nouvel audit des autorisations du serveur ni une recette de l'export natif sur téléphone.

## Reproduction

Démarrer le serveur Vite de `desktop`, puis lancer `node desktop/tests/read-only-actions-journey.mjs`. Définir `ZENTRA_QA_ORIGIN` pour son adresse, `ZENTRA_PLAYWRIGHT_MODULE` si Playwright est fourni hors du projet, et `ZENTRA_QA_BROWSER=webkit` pour WebKit. Les rapports et captures sont écrits dans `.qa/read-only-actions-edge/` et `.qa/read-only-actions-webkit/`.
