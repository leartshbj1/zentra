---
version: 1
slug: "desktop-src-workspacepersonalization-tsx"
primary_target: "desktop/src/WorkspacePersonalization.tsx"
related_targets: ["desktop/src/MobileDashboard.tsx","desktop/src/workspace-personalization.css"]
---

# Confort quotidien — suivi de livraison

Objectif utilisateur : traiter les six priorités proposées et personnaliser les quatre raccourcis mobiles ainsi que les actions de l’accueil. Le bouton Menu reste accessible. Préférences propres à chaque appareil, sans modification des choix des collaborateurs.

## Contrat de conception

Mode Operate, extension de desktop/DESIGN.md. Papier clair / graphite, accent vert existant, typographie système, séparateurs fins. Les réglages présentent un aperçu puis quatre lignes réordonnables accessibles au toucher et au clavier. Aucun écran commercial, aucune nouvelle décoration. Les changements du brouillon restent dans l’aperçu jusqu’à Enregistrer ; Annuler rétablit le choix enregistré. Menu est fixe. La réduction des animations supprime les transitions. La barre native iOS conserve Liquid Glass officiel et reçoit les mêmes destinations traduites.

## Conditions de livraison

- [ ] Navigation mobile et actions d’accueil personnalisables ; persistance, droits, langues, thèmes et clavier vérifiés.
- [ ] Synchronisation : statut discret et exact, brouillons préservés, récupération compréhensible. Ne pas confondre essais simulés et appareils réellement connectés.
- [ ] Automation : activité réelle, accès direct aux documents / rendez-vous / tâches concernés, incertitudes distinctes du travail terminé.
- [ ] Paie : erreurs actionnables, retour au brouillon après correction, vérification des parcours d’assurance.
- [ ] Distribution : builds vérifiés ; signature Windows, notarisation macOS et distribution iPhone dépendent des accès de signature réels. Ne pas présenter une IPA non signée comme installable directement.
- [ ] Pilote de cinq PME : préparer le protocole, obtenir les participants, mesurer des essais réellement effectués. Participants demandés, réponse en attente.
- [ ] Revue Impeccable indépendante et documentation après vérification visuelle bornée.

Les compilations, publications, preuves et limites seront consignées ici au fur et à mesure. Aucun test de cette phase ne modifie les données métier du propriétaire.
