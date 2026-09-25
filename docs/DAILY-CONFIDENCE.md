# Confort quotidien — suivi de livraison

Objectif utilisateur : traiter les six priorités proposées et personnaliser les quatre raccourcis mobiles ainsi que les actions de l’accueil. Le bouton Menu reste accessible. Préférences propres à chaque appareil, sans modification des choix des collaborateurs.

## Contrat de conception

Mode Operate, extension de desktop/DESIGN.md. Papier clair / graphite, accent vert existant, typographie système, séparateurs fins. Les réglages présentent un aperçu puis quatre lignes réordonnables accessibles au toucher et au clavier. Aucun écran commercial, aucune nouvelle décoration. Les changements du brouillon restent dans l’aperçu jusqu’à Enregistrer ; Annuler rétablit le choix enregistré. Menu est fixe. La réduction des animations supprime les transitions. La barre native iOS conserve Liquid Glass officiel et reçoit les mêmes destinations traduites.

## Conditions de livraison

- [x] Navigation mobile et actions d’accueil personnalisables ; persistance, annulation, ordre, valeurs par défaut et quatre langues vérifiés sur Edge/WebKit, téléphone et ordinateur. Barre UIKit compilée séparément avant publication.
- [ ] Synchronisation : statut discret et exact, brouillons préservés, récupération compréhensible. Ne pas confondre essais simulés et appareils réellement connectés.
- [ ] Automation : activité réelle, accès direct aux documents / rendez-vous / tâches concernés, incertitudes distinctes du travail terminé.
- [ ] Paie : erreurs actionnables, retour au brouillon après correction, vérification des parcours d’assurance.
- [ ] Distribution : builds vérifiés ; signature Windows, notarisation macOS et distribution iPhone dépendent des accès de signature réels. Ne pas présenter une IPA non signée comme installable directement.
- [ ] Pilote de cinq PME : préparer le protocole, obtenir les participants, mesurer des essais réellement effectués. Participants demandés, réponse en attente.
- [x] Revue Impeccable indépendante et documentation après vérification visuelle bornée. Verdict limité à la correction examinée, pas à toutes les plateformes natives.

Les compilations, publications, preuves et limites seront consignées ici au fur et à mesure. Aucun test de cette phase ne modifie les données métier du propriétaire.

## Preuves du 25 septembre 2026 — version candidate 1.88.0

- Interface : 207 fichiers / 1 665 tests passent. Compilation TypeScript et Vite réussie.
- Personnalisation : 8 parcours Edge/WebKit, 320/390/1440px, FR/DE/IT/EN et thèmes clair/sombre ; sauvegarde réelle des préférences locales, annulation, remise par défaut, substitution d’une case occupée, taille tactile, navigation et action Agenda. Le dernier contrôle vérifie aussi le centre du bouton Enregistrer/Annuler par hit-test, hors du dock et de l’assistant.
- Droits et aide : 4 parcours supplémentaires Edge/WebKit à 390/1440px vérifient les six actions de création désactivées en lecture seule, l’agenda accessible et le raccourci Projet qui explique le client manquant puis ouvre le formulaire adéquat. Preuve : `desktop/.qa/personalization/permissions-results.json`.
- Mouvement et clavier : le contrôle sans réduction des animations a trouvé un saut de l’aperçu après ouverture/défilement. La mesure se fait maintenant juste avant le déplacement et relativement à l’aperçu. Quatre cas Edge/WebKit avec/sans mouvement réduit passent : deux éléments animés lors d’un échange, aucun avec mouvement réduit, activation clavier et sauvegarde. Tabulation séquentielle vérifiée sur Edge ; WebKit utilise un focus explicite pour son réglage de navigation clavier. Source : `desktop/tests/personalization-keyboard-motion-journey.mjs`.
- Synchronisation : les scénarios simulés de facture et paiement actualisent le tableau de bord en 2,84–2,90 secondes sur les deux moteurs ; saisie et focus conservés, sans panneau de chargement. Le nouveau statut ne réutilise pas l’état d’une autre entreprise et vérifie la fraîcheur de la connexion. Ceci ne remplace pas la recette sur deux comptes/appareils réels.
- Paie : 12 scénarios accidents (assureur manquant, nouveau contrat, doublons) passent ; 6 scénarios de brouillon/contributions conservés passent ; 3 parcours pension 320/390/1440 passent (référence manquante, correction inline, salaire conservé, parts salarié/employeur, correction comptable et enregistrement). Le test pension historique attendait trois anciens boutons ; il vérifie maintenant les corrections directes et la reprise automatique existantes, sans assouplir les assertions sur les montants enregistrés.
- Impeccable : détecteur exécuté une fois, avertissements indicatifs de tailles/rayons ; revue indépendante puis correction du seul défaut matériel trouvé (footer sous le dock). Verdict final `ship` sur la correction évaluée. Captures et compte rendu : `outputs/daily-confidence/`; preuves fonctionnelles : `desktop/.qa/personalization/`.
- Aucun certificat de signature de code détecté dans le magasin Windows CurrentUser/My. Disponibilité des accès Apple Developer et Windows demandée ; aucune signature commerciale ni notarisation n’est revendiquée.
- Pilote : `docs/PILOTE-CINQ-PME.md` et tableau vide `docs/pilot-results.csv`. Aucun résultat client inventé ; cinq participants restent à identifier.
